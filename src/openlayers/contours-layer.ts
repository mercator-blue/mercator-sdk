/**
 * OpenLayers binding — labelled contour isolines for scalar datasets
 * (temperature, pressure, …) from a precomputed MVT pyramid declared
 * on the dataset's STAC `mercator:contour.url_template`.
 *
 * Architecture (2026-05-28): custom WebGL2 line renderer for the
 * isolines, Canvas2D for labels. Two canvases stacked inside one OL
 * Layer's render-host `<div>`. Each polyline segment becomes an
 * expanded-triangle quad (mirror of `sdk/src/mapbox/contours-line-layer.ts`)
 * so the line width is controlled in device pixels regardless of zoom
 * and so the GPU handles both projection and rasterisation. Geometry
 * is built once per visible-tile-set change and uploaded to a single
 * VBO; per frame we set a world→pixel matrix uniform and issue ONE
 * draw call per visible world copy. The CPU per-frame cost is the
 * matrix derivation (six multiplies and adds) — independent of vertex
 * count. The previous Canvas2D path projected every vertex on the CPU
 * each rebuild, which dominated the frame budget at z=2 on heavy
 * fields (humidity2m, visibility) even after the per-zoom DP +
 * bbox-span filter on the pipeline side.
 *
 * Labels stay Canvas2D because:
 *   - the label count after collision filtering is small (~100–300),
 *   - the rotated-text path needs the OL `coordinateToPixelTransform`
 *     applied each rebuild anyway,
 *   - WebGL text would require a glyph atlas + SDF shader, much more
 *     code for no measurable win at these counts.
 *
 * MVT fetch/parse + LRU tile cache come from the host-agnostic
 * `core/contour-tiles.ts`. The visible-tile walk with parent-tile
 * fallback keeps showing the deepest cached ancestor while finer tiles
 * load (so crossing an integer zoom doesn't flash empty). Identical
 * to the Leaflet binding's flow.
 */

import Layer from 'ol/layer/Layer.js';
import { apply as applyTransform } from 'ol/transform.js';
import type { FrameState } from 'ol/Map.js';

import { ContourTileCache } from '../core/contour-tiles';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, absolutiseUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import { createProgram } from '../core/webgl-helpers';
import { parseCssColor } from '../core/color/css-color';
import type { MercatorContoursOptions } from '../core/types';

import { HALF_MERCATOR, WORLD_EXT_3857 } from '../core/mercator';

// Label-placement tunables (CSS pixels).
const LABEL_SPACING_PX = 220;   // distance between repeated labels on a line
const MIN_LABEL_LEN_PX = 90;    // skip lines shorter than this entirely
const MIN_LABEL_DIST_PX = 55;   // reject a label this close to a placed one
const LABEL_EDGE_MARGIN_PX = 8; // don't place labels hanging off the canvas

const REBUILD_DEBOUNCE_MS = 150;

// Per-vertex stride in the line VBO. The geometry is a TRIANGLE_STRIP
// per polyline (with primitive-restart between polylines), so each
// polyline vertex emits TWO strip vertices — one on each side of the
// line. Adjacent segments share endpoint vertices by construction,
// which is what makes mitre joins work: the bisector normal at each
// vertex is computed from the prev + next polyline neighbours and
// applied to BOTH the inbound segment's end-vertex AND the outbound
// segment's start-vertex (since they're the same vertex).
//
// Per strip vertex:
//   a_pos      vec2  (mercator-world coords of this vertex)
//   a_prev     vec2  (the polyline vertex BEFORE this one; equals
//                     a_pos for the first vertex of a polyline)
//   a_next     vec2  (the polyline vertex AFTER this one; equals
//                     a_pos for the last vertex of a polyline)
//   a_side     float (-1 or +1: which side of the line this vertex sits)
//   a_bold     float (0 = thin, 1 = bold; selects width on the GPU)
// 8 floats × 2 strip vertices per polyline-vertex.
const FLOATS_PER_VERTEX = 8;
// Sentinel index for TRIANGLE_STRIP primitive restart. WebGL 2 makes
// PRIMITIVE_RESTART_FIXED_INDEX always-on; the restart value for
// gl.UNSIGNED_INT is 0xFFFFFFFF.
const RESTART_INDEX = 0xFFFFFFFF;

// World-copy cap: hardcoded ceiling so an extremely wide viewport at
// very low zoom doesn't try to issue thousands of draw calls. 7 covers
// any practical case (the projection clips before we hit this).
const MAX_COPIES = 7;

// Vertex shader: TRIANGLE_STRIP per polyline with mitre joins. Each
// polyline vertex emits two strip vertices (left, right); adjacent
// segments share endpoint vertices so the offset direction at a
// corner is uniquely determined — no gap or "spike" between segments.
//
// Mitre direction = bisector of the two tangent perpendiculars
// (incoming + outgoing). Mitre length = halfWidth / cos(half-angle)
// so the offset stays orthogonal to each segment after projection.
// Clamped at MITRE_LIMIT (4 × halfWidth) so a hairpin doesn't produce
// an infinite spike; the visual result past the limit is a small
// stub rather than a smooth join, which is fine for contour lines
// where hairpins are rare and small anyway.
//
// Endpoint vertices (no prev or no next) use the segment's own
// perpendicular as the mitre direction with no scaling. Detected by
// `a_prev == a_pos` (start) or `a_next == a_pos` (end), which is
// the CPU-side encoding.
import {
  CONTOUR_LINES_VS as LINES_VS,
  CONTOUR_LINES_FS as LINES_FS,
} from './shaders/index';

/** OpenLayers-specific extras on top of the cross-binding
 *  {@link MercatorContoursOptions}. */
export type MercatorContoursLayerOpts = MercatorContoursOptions & {
  /** Label fill colour. Default `#111827`. */
  textColor?: string;
  /** Label halo colour. Default `rgba(255, 255, 255, 0.9)`. */
  textHaloColor?: string;
  /** Label halo width, CSS px. Default 2.5. */
  textHaloWidth?: number;
  /** Canvas2D font shorthand. Default `11px sans-serif`. */
  font?: string;
  /** OL layer z-index. Default 660. */
  zIndex?: number;
};

// Label candidates carry mercator-world coords (with any visible
// world-copy offset already added to `wx` / `wbx`) so the per-frame
// label pass can re-project to live pixels via the current
// `frameState.coordinateToPixelTransform`. `(wx, wy)` is the anchor
// (where the text sits), `(wbx, wby)` is the segment's b endpoint —
// projecting both and taking the atan2 of the pixel delta yields the
// rotation angle, which is what we actually want (rotation angle
// changes with zoom on rotated viewports + we don't have to recompute
// it at rebuild time).
interface LabelCand { wx: number; wy: number; wbx: number; wby: number; text: string }

// Compose OL's `coordinateToPixelTransform` (3857 → CSS pixels) with
// the fixed `mercator-world → 3857` transform to get a single 2×3
// affine `mercator-world → CSS pixels`. Packed as a column-major
// mat3 for GLSL (third column is [0, 0, 1]).
function composeWorldToPixel(coordToPx: number[] | Float32Array, out: Float32Array): void {
  // OL transform layout (from ol/transform.js apply()):
  //   px = T[0]*x + T[2]*y + T[4]
  //   py = T[1]*x + T[3]*y + T[5]
  // i.e. matrix = [ T0 T2 T4 ; T1 T3 T5 ; 0 0 1 ].
  const P11 = coordToPx[0], P12 = coordToPx[2], P13 = coordToPx[4];
  const P21 = coordToPx[1], P22 = coordToPx[3], P23 = coordToPx[5];
  // Q (mercator-world → 3857) = [ W_EXT 0 -HALF ; 0 -W_EXT HALF ; 0 0 1 ].
  const Q11 = WORLD_EXT_3857, Q13 = -HALF_MERCATOR;
  const Q22 = -WORLD_EXT_3857, Q23 = HALF_MERCATOR;
  // R = P * Q (2×3). Q12 = Q21 = 0 so the cross terms drop out.
  const R11 = P11 * Q11;
  const R12 = P12 * Q22;
  const R13 = P11 * Q13 + P12 * Q23 + P13;
  const R21 = P21 * Q11;
  const R22 = P22 * Q22;
  const R23 = P21 * Q13 + P22 * Q23 + P23;
  // Column-major mat3 layout for GLSL.
  out[0] = R11; out[1] = R21; out[2] = 0;
  out[3] = R12; out[4] = R22; out[5] = 0;
  out[6] = R13; out[7] = R23; out[8] = 1;
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : String(+v.toFixed(2));
}

function buildLayer(opts: MercatorContoursLayerOpts, item: DiscoveredItem): Layer {
  const c = item.contour;
  if (!c) {
    throw new Error(
      `@mercator-blue/sdk/openlayers: MercatorContoursLayer requires a contour ` +
      `pyramid; dataset "${opts.dataset}" has none published.`,
    );
  }

  const urlTemplate = withApiKey(absolutiseUrl(c.url_template, item.itemBase), opts.apiKey);
  const sourceLayer = c.source_layer ?? 'contours';
  const minzoom = c.minzoom ?? 0;
  const maxzoom = c.maxzoom ?? 5;
  const userFilterMinZoom = c.user_filter_min_zoom ?? 0;
  const coarsestInterval = c.coarsest_interval;
  const unit = c.unit ?? '';

  let interval = opts.initialInterval ?? c.default_interval;
  // Medium-dark slate-gray (Tailwind gray-600). Softer than the
  // previous near-black (#111827, gray-900) which read as heavy ink
  // over coloured raster + light basemaps.
  let lineColorRGBA = parseCssColor(opts.lineColor ?? '#4b5563');
  let lineWidth = opts.lineWidth ?? 1.0;
  let boldLineWidth = opts.boldLineWidth ?? 1.8;
  let lineOpacity = opts.lineOpacity ?? 1;
  const textColor = opts.textColor ?? '#4b5563';
  const textHaloColor = opts.textHaloColor ?? 'rgba(255, 255, 255, 0.9)';
  const textHaloWidth = opts.textHaloWidth ?? 2.5;
  const font = opts.font ?? '11px sans-serif';

  const cache = new ContourTileCache({ urlTemplate, sourceLayer });

  // Render host: a wrapper div with the WebGL canvas (lines) stacked
  // under the Canvas2D canvas (labels). OL's Layer.render() returns
  // ONE HTMLElement, hence the wrapper.
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.inset = '0';
  host.style.pointerEvents = 'none';

  const lineCanvas = document.createElement('canvas');
  lineCanvas.style.position = 'absolute';
  lineCanvas.style.inset = '0';
  lineCanvas.style.width = '100%';
  lineCanvas.style.height = '100%';
  host.appendChild(lineCanvas);

  const labelCanvas = document.createElement('canvas');
  labelCanvas.style.position = 'absolute';
  labelCanvas.style.inset = '0';
  labelCanvas.style.width = '100%';
  labelCanvas.style.height = '100%';
  host.appendChild(labelCanvas);

  const gl0 = lineCanvas.getContext('webgl2', {
    premultipliedAlpha: false,
    antialias: true,
    preserveDrawingBuffer: false,
  });
  if (!gl0) {
    throw new Error('@mercator-blue/sdk/openlayers: WebGL2 unavailable');
  }
  const gl: WebGL2RenderingContext = gl0;

  const labelCtx0 = labelCanvas.getContext('2d');
  if (!labelCtx0) {
    throw new Error('@mercator-blue/sdk/openlayers: 2D context unavailable for labels');
  }
  const labelCtx: CanvasRenderingContext2D = labelCtx0;

  const program = createProgram(gl, LINES_VS, LINES_FS);
  const locPos    = gl.getAttribLocation(program, 'a_pos');
  const locPrev   = gl.getAttribLocation(program, 'a_prev');
  const locNext   = gl.getAttribLocation(program, 'a_next');
  const locSide   = gl.getAttribLocation(program, 'a_side');
  const locBold   = gl.getAttribLocation(program, 'a_bold');
  const locWorldToPixel = gl.getUniformLocation(program, 'u_world_to_pixel');
  const locViewport     = gl.getUniformLocation(program, 'u_viewport');
  const locDpr          = gl.getUniformLocation(program, 'u_dpr');
  const locWorldOffsetX = gl.getUniformLocation(program, 'u_world_offset_x');
  const locWidthBase    = gl.getUniformLocation(program, 'u_width_base');
  const locWidthExtra   = gl.getUniformLocation(program, 'u_width_extra');
  const locColor        = gl.getUniformLocation(program, 'u_color');
  const locOpacity      = gl.getUniformLocation(program, 'u_opacity');

  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  if (!vbo || !ibo) throw new Error('@mercator-blue/sdk/openlayers: createBuffer returned null');

  // CPU-side staging buffers. Grow on demand; never shrink.
  let cpuBuf = new Float32Array(0);
  let cpuIdx = new Uint32Array(0);
  let indexCount = 0;  // elements in ibo, including restart sentinels

  // Labels — rebuilt alongside the line geometry. Each label carries
  // its CSS-pixel anchor + rotation + text, ready for the per-frame
  // Canvas2D pass.
  let labels: LabelCand[] = [];
  let labelsGen = 0; // bumps every rebuild for the draw-skip key

  let layer: Layer | null = null;
  let lastBuildKey: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Last frame's label-draw key. The line canvas redraws every frame
  // (it's cheap on the GPU). The label canvas is more expensive
  // (Canvas2D drawText × ~100 labels), so we draw-skip there.
  let lastLabelKey: string | null = null;

  // Eagerly fetch the minzoom world tile so the parent-fallback walk
  // always terminates at (minzoom, 0, 0).
  const onTileLoaded = () => {
    lastBuildKey = null;
    layer?.changed();
  };
  cache.ensure(minzoom, 0, 0, onTileLoaded);

  function effectiveInterval(mapZoom: number): number {
    if (userFilterMinZoom > 0 && mapZoom < userFilterMinZoom && coarsestInterval != null) {
      return coarsestInterval;
    }
    return interval;
  }

  // ---- Build geometry from the cache + collect label candidates ----
  function rebuildGeometry(frameState: FrameState): void {
    const [W, H] = frameState.size;
    const tl3857: [number, number] = [0, 0];
    applyTransform(frameState.pixelToCoordinateTransform, tl3857);
    const br3857: [number, number] = [W, H];
    applyTransform(frameState.pixelToCoordinateTransform, br3857);

    const mapZ = frameState.viewState.zoom;
    const targetZ = Math.max(minzoom, Math.min(maxzoom, Math.floor(mapZ)));
    const n = 2 ** targetZ;
    const tileSize = WORLD_EXT_3857 / n;
    const wantInterval = effectiveInterval(mapZ);

    const xLo = Math.floor((tl3857[0] + HALF_MERCATOR) / tileSize);
    const xHi = Math.floor((br3857[0] + HALF_MERCATOR) / tileSize);
    const yLo = Math.max(0, Math.floor((HALF_MERCATOR - tl3857[1]) / tileSize));
    const yHi = Math.min(n - 1, Math.floor((HALF_MERCATOR - br3857[1]) / tileSize));

    // Walk visible tiles in two passes:
    //   1. Add every loaded target-zoom tile to the render set, AND
    //      remember which target cells are still missing.
    //   2. If at least one target tile was loaded, leave the missing
    //      cells blank. Otherwise (fresh zoom-in, nothing loaded
    //      yet), fall back to the deepest cached ancestor for each
    //      missing cell so the user sees a coarser version while
    //      tiles fetch.
    //
    // The reason for the "no fallback when any target is loaded" rule
    // is that each tile's MVT contains a feature set covering its
    // ENTIRE area at THAT zoom's simplification tolerance — including
    // areas already covered by loaded child tiles at a finer
    // tolerance. If we mix the two, every isovalue gets drawn twice
    // (once at the parent's coarser path, once at the child's finer
    // path), visible as two parallel "25°C" lines tracking the same
    // contour but with slightly different vertex sets.
    const tilesToRender = new Set<string>();
    const missing: Array<[number, number]> = [];
    let anyTargetLoaded = false;
    for (let xRaw = xLo; xRaw <= xHi; xRaw++) {
      const x = ((xRaw % n) + n) % n;
      for (let y = yLo; y <= yHi; y++) {
        const cached = cache.get(targetZ, x, y);
        if (cached) {
          tilesToRender.add(`${targetZ}/${x}/${y}`);
          anyTargetLoaded = true;
          continue;
        }
        if (cached === undefined) {
          cache.ensure(targetZ, x, y, onTileLoaded);
        }
        missing.push([x, y]);
      }
    }
    if (!anyTargetLoaded) {
      for (const [x, y] of missing) {
        for (let pz = targetZ - 1; pz >= minzoom; pz--) {
          const dz = targetZ - pz;
          const pCached = cache.get(pz, x >> dz, y >> dz);
          if (pCached) {
            tilesToRender.add(`${pz}/${x >> dz}/${y >> dz}`);
            break;
          }
        }
      }
    }

    // Collect all matching polylines (interval + bold flag) so we can
    // size the CPU buffer before allocation.
    interface Plyne { pl: Float32Array; bold: boolean; value: number }
    const plynes: Plyne[] = [];
    for (const key of tilesToRender) {
      const [zStr, xStr, yStr] = key.split('/');
      const feats = cache.get(+zStr, +xStr, +yStr);
      if (!feats) continue;
      for (const f of feats) {
        if (f.interval !== wantInterval) continue;
        const bold = Math.round(f.value) % 10 === 0;
        for (const pl of f.polylines) {
          if (pl.length < 4) continue; // < 2 points
          plynes.push({ pl, bold, value: f.value });
        }
      }
    }

    // Empty build while fetches are in flight — hold the previous
    // geometry so the user doesn't see a blackout while tiles load.
    if (plynes.length === 0 && cache.hasPending() && indexCount > 0) {
      return;
    }

    // Size the buffers: 2 strip vertices per polyline vertex; per
    // polyline we emit 2*nPts index entries plus one restart sentinel.
    let totalVerts = 0;
    let totalIdx = 0;
    for (const p of plynes) {
      const nPts = p.pl.length / 2;
      totalVerts += 2 * nPts;
      totalIdx += 2 * nPts + 1;  // +1 restart between polylines
    }
    // Last polyline doesn't need a trailing restart, but having it is
    // harmless (drawElements stops at the requested count anyway).

    const needFloats = totalVerts * FLOATS_PER_VERTEX;
    if (cpuBuf.length < needFloats) {
      cpuBuf = new Float32Array(Math.max(needFloats, cpuBuf.length * 2));
    }
    if (cpuIdx.length < totalIdx) {
      cpuIdx = new Uint32Array(Math.max(totalIdx, cpuIdx.length * 2));
    }

    let foff = 0;
    let ioff = 0;
    let vbase = 0;
    for (const { pl, bold } of plynes) {
      const nPts = pl.length / 2;
      const boldF = bold ? 1 : 0;
      for (let i = 0; i < nPts; i++) {
        const x = pl[i * 2];
        const y = pl[i * 2 + 1];
        // Encode endpoints by setting prev=this (start) or next=this (end).
        // The shader detects `dot(t_in,t_in) < eps` / `dot(t_out,t_out) < eps`
        // and degrades to the segment's own perpendicular without mitre.
        const px = i > 0 ? pl[(i - 1) * 2]     : x;
        const py = i > 0 ? pl[(i - 1) * 2 + 1] : y;
        const nx = i < nPts - 1 ? pl[(i + 1) * 2]     : x;
        const ny = i < nPts - 1 ? pl[(i + 1) * 2 + 1] : y;
        // Left strip vertex (a_side = -1)
        cpuBuf[foff++] = x;  cpuBuf[foff++] = y;
        cpuBuf[foff++] = px; cpuBuf[foff++] = py;
        cpuBuf[foff++] = nx; cpuBuf[foff++] = ny;
        cpuBuf[foff++] = -1; cpuBuf[foff++] = boldF;
        // Right strip vertex (a_side = +1)
        cpuBuf[foff++] = x;  cpuBuf[foff++] = y;
        cpuBuf[foff++] = px; cpuBuf[foff++] = py;
        cpuBuf[foff++] = nx; cpuBuf[foff++] = ny;
        cpuBuf[foff++] = +1; cpuBuf[foff++] = boldF;

        cpuIdx[ioff++] = vbase + 2 * i;       // left
        cpuIdx[ioff++] = vbase + 2 * i + 1;   // right
      }
      // Primitive restart between polylines so the strip doesn't span
      // adjacent polylines (which would produce stray triangles linking
      // them).
      cpuIdx[ioff++] = RESTART_INDEX;
      vbase += 2 * nPts;
    }
    indexCount = ioff;

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, cpuBuf.subarray(0, needFloats), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cpuIdx.subarray(0, indexCount), gl.DYNAMIC_DRAW);

    // ---- Label collection ----
    // Labels are placed at the time of geometry build so they sit at
    // the line's actual pixel positions. We use the same coordToPx
    // transform the render() loop will use, so anchors are correct
    // for the frame that triggered the build. Labels stay valid until
    // the next rebuild (the per-frame label draw-skip below honours
    // the same lifecycle).
    const out: LabelCand[] = [];
    const placed: Array<[number, number]> = [];
    const tooClose = (x: number, y: number): boolean => {
      for (const [px, py] of placed) {
        const dx = px - x, dy = py - y;
        if (dx * dx + dy * dy < MIN_LABEL_DIST_PX * MIN_LABEL_DIST_PX) return true;
      }
      return false;
    };

    const copyLo = Math.floor((tl3857[0] + HALF_MERCATOR) / WORLD_EXT_3857);
    const copyHi = Math.floor((br3857[0] + HALF_MERCATOR) / WORLD_EXT_3857);

    let scratch = new Float64Array(256);
    for (const { pl, value } of plynes) {
      const text = `${formatValue(value)}${unit}`;
      for (let copy = copyLo; copy <= copyHi; copy++) {
        const xOff = copy * WORLD_EXT_3857;
        const nPts = pl.length / 2;
        if (scratch.length < pl.length) {
          scratch = new Float64Array(Math.max(scratch.length * 2, pl.length));
        }
        for (let j = 0; j < nPts; j++) {
          const x3857 = pl[j * 2] * WORLD_EXT_3857 - HALF_MERCATOR + xOff;
          const y3857 = HALF_MERCATOR - pl[j * 2 + 1] * WORLD_EXT_3857;
          const sp: [number, number] = [x3857, y3857];
          applyTransform(frameState.coordinateToPixelTransform, sp);
          scratch[j * 2] = sp[0];
          scratch[j * 2 + 1] = sp[1];
        }
        // Pass the original mercator-world polyline + the rebuild's
        // copy offset so each placed label can record world coords
        // (anchor + segment-b neighbor) for per-frame re-projection.
        collectLabels(pl, scratch, nPts, copy, text, W, H, out, placed, tooClose);
      }
    }
    labels = out;
    labelsGen++;
  }

  function scheduleRebuild(frameState: FrameState, vKey: string): void {
    if (debounceTimer != null) clearTimeout(debounceTimer);
    const delay = lastBuildKey === null ? 0 : REBUILD_DEBOUNCE_MS;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      rebuildGeometry(frameState);
      lastBuildKey = vKey;
      layer?.changed();
    }, delay);
  }

  // Scratch typed array for the mat3 uniform upload.
  const matBuf = new Float32Array(9);

  function render(frameState: FrameState): HTMLElement {
    const [W, H] = frameState.size;
    const dpr = frameState.pixelRatio;
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (lineCanvas.width !== bw || lineCanvas.height !== bh) {
      lineCanvas.width = bw;
      lineCanvas.height = bh;
    }
    if (labelCanvas.width !== bw || labelCanvas.height !== bh) {
      labelCanvas.width = bw;
      labelCanvas.height = bh;
      lastLabelKey = null; // backing store wiped → force redraw
    }

    // Rebuild trigger: tile-zoom + viewport corner + interval. Re-builds
    // when the visible tile set or interval changes — not every frame.
    const targetZ = Math.max(minzoom, Math.min(maxzoom, Math.floor(frameState.viewState.zoom)));
    const cx = frameState.viewState.center[0];
    const cy = frameState.viewState.center[1];
    const effInt = effectiveInterval(frameState.viewState.zoom);
    const vKey = `${targetZ}|${cx}|${cy}|${W}|${H}|${effInt}`;
    if (vKey !== lastBuildKey) {
      scheduleRebuild(frameState, vKey);
    }

    // ---- WebGL line pass ----
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (indexCount > 0) {
      gl.useProgram(program);

      composeWorldToPixel(frameState.coordinateToPixelTransform, matBuf);
      gl.uniformMatrix3fv(locWorldToPixel, false, matBuf);
      gl.uniform2f(locViewport, bw, bh);
      gl.uniform1f(locDpr, dpr);
      gl.uniform1f(locWidthBase, lineWidth);
      gl.uniform1f(locWidthExtra, boldLineWidth - lineWidth);
      gl.uniform4f(locColor, lineColorRGBA[0], lineColorRGBA[1], lineColorRGBA[2], lineColorRGBA[3]);
      gl.uniform1f(locOpacity, lineOpacity);

      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      const stride = FLOATS_PER_VERTEX * 4;
      gl.enableVertexAttribArray(locPos);
      gl.vertexAttribPointer(locPos,  2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(locPrev);
      gl.vertexAttribPointer(locPrev, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(locNext);
      gl.vertexAttribPointer(locNext, 2, gl.FLOAT, false, stride, 16);
      gl.enableVertexAttribArray(locSide);
      gl.vertexAttribPointer(locSide, 1, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(locBold);
      gl.vertexAttribPointer(locBold, 1, gl.FLOAT, false, stride, 28);

      // Visible world copies: same heuristic as the other OL overlays.
      const tl3857: [number, number] = [0, 0];
      applyTransform(frameState.pixelToCoordinateTransform, tl3857);
      const br3857: [number, number] = [W, H];
      applyTransform(frameState.pixelToCoordinateTransform, br3857);
      const copyLo = Math.floor((tl3857[0] + HALF_MERCATOR) / WORLD_EXT_3857);
      const copyHi = Math.floor((br3857[0] + HALF_MERCATOR) / WORLD_EXT_3857);
      const requestedCopies = copyHi - copyLo + 1;
      const numCopies = Math.max(1, Math.min(MAX_COPIES, requestedCopies));

      for (let c = 0; c < numCopies; c++) {
        gl.uniform1f(locWorldOffsetX, copyLo + c);
        // Indexed draw with TRIANGLE_STRIP + primitive-restart (the
        // RESTART_INDEX sentinels in the IBO break the strip between
        // polylines so we don't draw spurious triangles linking them).
        gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_INT, 0);
      }

      gl.disableVertexAttribArray(locPos);
      gl.disableVertexAttribArray(locPrev);
      gl.disableVertexAttribArray(locNext);
      gl.disableVertexAttribArray(locSide);
      gl.disableVertexAttribArray(locBold);
    }

    // ---- Canvas2D label pass (re-project each label per frame) ----
    // Labels carry mercator-world coords from the rebuild; per frame
    // we project to CSS pixels using the live `coordinateToPixelTransform`
    // so they track the map during pan/zoom instead of staying at
    // their rebuild-time positions. The draw-skip key includes view
    // state + labelsGen, so when nothing changed since last frame
    // (e.g. an idle frame in a streamlines animation) we reuse the
    // cached canvas pixels and pay no Canvas2D cost.
    const resolution = frameState.viewState.resolution;
    const labelKey = `${cx}|${cy}|${resolution}|${W}|${H}|${dpr}|${labelsGen}`;
    if (labelKey !== lastLabelKey) {
      labelCtx.setTransform(1, 0, 0, 1, 0, 0);
      labelCtx.clearRect(0, 0, bw, bh);
      labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (labels.length > 0) {
        labelCtx.font = font;
        labelCtx.textAlign = 'center';
        labelCtx.textBaseline = 'middle';
        labelCtx.lineJoin = 'round';
        const tmpA: [number, number] = [0, 0];
        const tmpB: [number, number] = [0, 0];
        for (const lb of labels) {
          // Project anchor + segment-b neighbor with the live transform.
          tmpA[0] = lb.wx * WORLD_EXT_3857 - HALF_MERCATOR;
          tmpA[1] = HALF_MERCATOR - lb.wy * WORLD_EXT_3857;
          applyTransform(frameState.coordinateToPixelTransform, tmpA);
          tmpB[0] = lb.wbx * WORLD_EXT_3857 - HALF_MERCATOR;
          tmpB[1] = HALF_MERCATOR - lb.wby * WORLD_EXT_3857;
          applyTransform(frameState.coordinateToPixelTransform, tmpB);
          // Skip labels that have left the visible canvas after pan/zoom
          // — the rebuild-time edge filter no longer applies once the
          // view has moved. (Slight cost: a label that pans off then
          // back on is missing until the next rebuild — acceptable.)
          if (tmpA[0] < LABEL_EDGE_MARGIN_PX || tmpA[0] > W - LABEL_EDGE_MARGIN_PX
              || tmpA[1] < LABEL_EDGE_MARGIN_PX || tmpA[1] > H - LABEL_EDGE_MARGIN_PX) continue;
          let ang = Math.atan2(tmpB[1] - tmpA[1], tmpB[0] - tmpA[0]);
          if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
          labelCtx.save();
          labelCtx.translate(tmpA[0], tmpA[1]);
          labelCtx.rotate(ang);
          labelCtx.strokeStyle = textHaloColor;
          labelCtx.lineWidth = textHaloWidth;
          labelCtx.strokeText(lb.text, 0, 0);
          labelCtx.fillStyle = textColor;
          labelCtx.fillText(lb.text, 0, 0);
          labelCtx.restore();
        }
      }
      lastLabelKey = labelKey;
    }

    return host;
  }

  function collectLabels(
    pl: Float32Array,                  // mercator-world coords [0, 1]
    pixels: Float64Array,              // same vertices pre-projected to CSS pixels
    nPts: number,
    copyOffset: number,                // mercator-world units to add to x
    text: string,
    W: number, H: number,
    out: LabelCand[],
    placed: Array<[number, number]>,
    tooClose: (x: number, y: number) => boolean,
  ): void {
    let total = 0;
    for (let i = 0; i < nPts - 1; i++) {
      total += Math.hypot(
        pixels[(i + 1) * 2] - pixels[i * 2],
        pixels[(i + 1) * 2 + 1] - pixels[i * 2 + 1],
      );
    }
    if (total < MIN_LABEL_LEN_PX) return;

    let nextAt = LABEL_SPACING_PX * 0.5;
    let acc = 0;
    for (let i = 0; i < nPts - 1; i++) {
      const ax = pixels[i * 2], ay = pixels[i * 2 + 1];
      const bx = pixels[(i + 1) * 2], by = pixels[(i + 1) * 2 + 1];
      const seg = Math.hypot(bx - ax, by - ay);
      while (nextAt <= acc + seg) {
        const t = seg > 0 ? (nextAt - acc) / seg : 0;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        nextAt += LABEL_SPACING_PX;
        if (x < LABEL_EDGE_MARGIN_PX || x > W - LABEL_EDGE_MARGIN_PX
            || y < LABEL_EDGE_MARGIN_PX || y > H - LABEL_EDGE_MARGIN_PX) continue;
        if (tooClose(x, y)) continue;
        // Recover the mercator-world coords for this placement. The
        // anchor is the same linear interpolation in world space (mx
        // and px are both affine in t between i and i+1). `(wbx, wby)`
        // is the segment-b endpoint — projecting both per frame gives
        // us anchor + tangent direction at the live view.
        const wax = pl[i * 2] + copyOffset;
        const way = pl[i * 2 + 1];
        const wbx = pl[(i + 1) * 2] + copyOffset;
        const wby = pl[(i + 1) * 2 + 1];
        const wx = wax + (wbx - wax) * t;
        const wy = way + (wby - way) * t;
        out.push({ wx, wy, wbx, wby, text });
        placed.push([x, y]);
      }
      acc += seg;
    }
  }

  layer = new Layer({
    zIndex: opts.zIndex ?? 660,
    render,
  });

  const l = layer as Layer & {
    setInterval: (n: number) => void;
    getInterval: () => number;
  };
  l.setInterval = (n: number) => {
    interval = n;
    lastBuildKey = null;
    layer!.changed();
  };
  l.getInterval = () => interval;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (l as any).applyOptions = (p: any) => {
    if (p.initialInterval != null) l.setInterval(p.initialInterval);
    if (p.lineColor != null) {
      const next = parseCssColor(p.lineColor);
      // Preserve any custom lineOpacity by overriding alpha channel.
      next[3] = lineOpacity;
      lineColorRGBA = next;
      layer!.changed();
    }
    if (p.lineOpacity != null) {
      lineOpacity = p.lineOpacity;
      lineColorRGBA[3] = lineOpacity;
      layer!.changed();
    }
    if (p.lineWidth != null) { lineWidth = p.lineWidth; layer!.changed(); }
    if (p.boldLineWidth != null) { boldLineWidth = p.boldLineWidth; layer!.changed(); }
  };
  return layer;
}

function fromItem(opts: MercatorContoursLayerOpts, item: DiscoveredItem): Layer {
  return buildLayer(opts, item);
}

async function create(opts: MercatorContoursLayerOpts): Promise<Layer> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorContoursLayer = { create, fromItem };
