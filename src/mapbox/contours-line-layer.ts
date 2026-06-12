/**
 * Custom WebGL layer rendering contour lines + casing from MVT tiles.
 *
 * Replaces the four `line`-type style layers that contours-overlay.ts
 * used to ship (LINES_LOW, LINES_LOW_CASING, LINES_HIGH, LINES_HIGH_CASING).
 * Style line layers and custom WebGL layers don't share a render pass on
 * Mapbox v3 + Standard style, so they can't be reliably z-stacked against
 * one another — the contour lines would render after our custom raster
 * layer regardless of array order. Custom layers compose cleanly with
 * each other in array order, so making contour lines a custom layer fixes
 * the ordering and is also the only path to Leaflet/Cesium/etc support
 * (none of which have a MapLibre-equivalent vector source + line layer).
 *
 * Labels (the text along each isoline) are still a Mapbox/MapLibre symbol
 * layer — see contours-overlay.ts. Symbol layers DO render correctly in
 * the right pass on Mapbox v3, and re-implementing along-line label
 * placement (font atlas, glyph shaping, rotation, collision) is many
 * weeks of work that this PR explicitly doesn't take on.
 */

import { createProgram } from '../core/webgl-helpers';
import { lngToTileX, latToTileY } from '../core/mercator';
import { parseCssColor } from '../core/color/css-color';
import { normalizeRenderArgs, type NormalisedRenderArgs } from './host-adapter';
import { CONTOUR_LINES_VS, CONTOUR_LINES_FS } from './shaders/index.js';
import { ContourTileCache } from '../core/contour-tiles';

const LAYER_ID = '__contours_lines_custom';

// Per-vertex layout: a_p0(2) + a_p1(2) + a_t(1) + a_side(1) + a_bold(1)
// = 7 floats = 28 bytes.
const VERT_STRIDE_FLOATS = 7;
const VERT_STRIDE_BYTES = VERT_STRIDE_FLOATS * 4;

// Subdivision per polyline segment for globe curvature. Same N=32 the
// raster mesh + tile-boundaries use — a 90° span splits to ~3° arcs
// which round-trip to sub-pixel error on a 1000-tall canvas.
const SUBDIVIDE_PER_SEG = 32;
// Don't bother subdividing segments whose endpoints are already close in
// mercator-world units. MVT contour segments are often ~0.1° in latitude
// where adjacent vertices straddle a tile cell — splitting those 32×
// blows the vertex count for no visible gain.
const SUBDIVIDE_MIN_SPAN_WORLD = 0.005; // ≈ 1.8° in lng/lat

// Defaults for the line appearance. Single-pass — the earlier casing
// pass (white halo behind the dark line, like the text-halo on labels)
// was removed because users found the halo distracting on light
// basemaps. The default colour is Tailwind gray-600 (rgb(75, 85, 99)),
// softer than the previous near-black (#111827, gray-900) which read as
// a heavy ink line over coloured raster + light basemaps.
const DEFAULT_LINE_COLOR = '#4b5563';
const DEFAULT_LINE_OPACITY = 1.0;
const DEFAULT_LINE_WIDTH_CSS = 0.7;
const DEFAULT_BOLD_LINE_WIDTH_CSS = 1.4;

function buildProgram(
  gl: WebGL2RenderingContext,
  shaderData: NormalisedRenderArgs['shaderData'],
): WebGLProgram {
  const prelude = shaderData?.vertexShaderPrelude ?? '';
  const define = shaderData?.define ?? '';
  const vsSource = `#version 300 es\n${prelude}\n${define}\n${CONTOUR_LINES_VS}`;
  const fsSource = `#version 300 es\n${CONTOUR_LINES_FS}`;
  return createProgram(gl, vsSource, fsSource);
}

// Push one expanded sub-segment quad (2 tris, 6 vertices).
function pushQuad(
  verts: number[],
  p0x: number, p0y: number,
  p1x: number, p1y: number,
  bold: number,
): void {
  // Triangle 1: A_-, B_-, A_+
  verts.push(p0x, p0y, p1x, p1y, 0, -1, bold);
  verts.push(p0x, p0y, p1x, p1y, 1, -1, bold);
  verts.push(p0x, p0y, p1x, p1y, 0,  1, bold);
  // Triangle 2: A_+, B_-, B_+
  verts.push(p0x, p0y, p1x, p1y, 0,  1, bold);
  verts.push(p0x, p0y, p1x, p1y, 1, -1, bold);
  verts.push(p0x, p0y, p1x, p1y, 1,  1, bold);
}

/**
 * Emit one polyline's expanded geometry into the verts array. Long
 * segments get subdivided into SUBDIVIDE_PER_SEG sub-segments so they
 * follow the great-circle path on the globe instead of cutting through
 * the sphere as a straight 3D chord.
 */
function pushPolyline(verts: number[], polyline: Float32Array, bold: number): void {
  for (let i = 0; i + 3 < polyline.length; i += 2) {
    const x0 = polyline[i];
    const y0 = polyline[i + 1];
    const x1 = polyline[i + 2];
    const y1 = polyline[i + 3];

    const span = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const sub = span < SUBDIVIDE_MIN_SPAN_WORLD ? 1 : SUBDIVIDE_PER_SEG;

    for (let k = 0; k < sub; k++) {
      const t0 = k / sub;
      const t1 = (k + 1) / sub;
      const px0 = x0 + (x1 - x0) * t0;
      const py0 = y0 + (y1 - y0) * t0;
      const px1 = x0 + (x1 - x0) * t1;
      const py1 = y0 + (y1 - y0) * t1;
      pushQuad(verts, px0, py0, px1, py1, bold);
    }
  }
}

export interface ContoursLineLayerOpts {
  /** Contour MVT URL template, with `{z}/{x}/{y}` placeholders.
   *  Customer-side path is `.../contours/{z}/{x}/{y}.pbf`. */
  urlTemplate: string;
  /** MVT source-layer name. Default `'contours'`. */
  sourceLayer?: string;
  /** Pyramid minzoom. Default 0. */
  minzoom?: number;
  /** Pyramid maxzoom. Default 5. */
  maxzoom?: number;
  /** Initial contour interval (encoded unit; e.g. 5 → every 5 °C). */
  initialInterval: number;
  /** Zoom below which the filter is forced to `coarsestInterval`.
   *  0 = the user's preset is always honoured. Default 0. */
  userFilterMinZoom?: number;
  /** Required when `userFilterMinZoom > 0`. */
  coarsestInterval?: number;
  /** MapLibre/Mapbox layer id to insert this layer BEFORE (z-order). */
  beforeId?: string;
  /** Mapbox GL JS v3 slot. Defaults to `'middle'` so the line layer
   *  sits below basemap labels + contour symbol labels (which use
   *  `'top'`). Ignored on MapLibre + Mapbox classic. */
  slot?: string;
  /** CSS colour for contour lines. Default `'#4b5563'` (Tailwind
   *  gray-600). Accepts `#rgb` / `#rrggbb` hex and `rgb()` / `rgba()`. */
  lineColor?: string;
  /** Line opacity, 0..1. Default 1. */
  lineOpacity?: number;
  /** Stroke width in CSS pixels for the thin (non-bold) lines. Default 0.7. */
  lineWidth?: number;
  /** Stroke width in CSS pixels for bold lines (contour values divisible
   *  by 10). Default 1.4. Must be ≥ `lineWidth`; values below clamp to it. */
  boldLineWidth?: number;
}

export interface ContoursLineLayerHandle {
  layerId: string;
  setInterval(newInterval: number): void;
  setLineColor(css: string): void;
  setLineOpacity(v: number): void;
  setLineWidth(v: number): void;
  setBoldLineWidth(v: number): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyOptions(p: any): void;
  remove(): void;
}

/**
 * State the custom WebGL layer attaches to `this` between onAdd and
 * onRemove. See tile-boundaries-overlay.ts for the LayerThis pattern.
 */
interface ContoursLineLayerThis {
  gl: WebGL2RenderingContext;
  vbo: WebGLBuffer | null;
  vertexCount: number;
  program: WebGLProgram | null;
  programVariant: string | null;

  attrP0: GLint;
  attrP1: GLint;
  attrT: GLint;
  attrSide: GLint;
  attrBold: GLint;

  uViewport: WebGLUniformLocation | null;
  uWidthBase: WebGLUniformLocation | null;
  uWidthExtra: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;

  uProjMatrix: WebGLUniformLocation | null;
  uProjTileCoords: WebGLUniformLocation | null;
  uProjClipping: WebGLUniformLocation | null;
  uProjTransition: WebGLUniformLocation | null;
  uProjFallback: WebGLUniformLocation | null;
  uMapboxGlobeToMercator: WebGLUniformLocation | null;
  uMapboxGlobeTransition: WebGLUniformLocation | null;
  uMapboxCenterMercator: WebGLUniformLocation | null;

  _ensureProgram(gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void;
  _uploadIfDirty(gl: WebGL2RenderingContext): void;
  _setProjectionUniforms(gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void;
  _bindAttribs(gl: WebGL2RenderingContext): void;
}

export function addContoursLineLayer(
  mapAny: unknown,
  opts: ContoursLineLayerOpts,
): ContoursLineLayerHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = mapAny as any;
  const minzoom = opts.minzoom ?? 0;
  const maxzoom = opts.maxzoom ?? 5;
  const userFilterMinZoom = opts.userFilterMinZoom ?? 0;
  const coarsestInterval = opts.coarsestInterval;
  const sourceLayer = opts.sourceLayer ?? 'contours';

  let lineColor = parseCssColor(opts.lineColor ?? DEFAULT_LINE_COLOR);
  let lineOpacity = opts.lineOpacity ?? DEFAULT_LINE_OPACITY;
  let widthBaseCss = opts.lineWidth ?? DEFAULT_LINE_WIDTH_CSS;
  let boldLineWidthCss = opts.boldLineWidth ?? DEFAULT_BOLD_LINE_WIDTH_CSS;
  // bold = base + extra in the shader; clamp at 0 so a sub-base
  // boldLineWidth doesn't try to thin the bold lines.
  const widthExtra = () => Math.max(0, boldLineWidthCss - widthBaseCss);

  let interval = opts.initialInterval;

  const tileCache = new ContourTileCache({
    urlTemplate: opts.urlTemplate,
    sourceLayer,
  });

  // Vertex buffer rebuilt from the visible tile set + current interval.
  let pendingVertices = new Float32Array(0);
  let pendingDirty = false;

  /** Effective interval-filter for the current map zoom — the
   *  pyramid is sparse at low zoom so we force coarsestInterval there.
   *  Mirrors the same regime split contours-overlay.ts applies to
   *  symbol layers (low/high pair). */
  function effectiveInterval(mapZ: number): number {
    if (userFilterMinZoom > 0 && mapZ < userFilterMinZoom && coarsestInterval != null) {
      return coarsestInterval;
    }
    return interval;
  }

  function rebuild(): void {
    const mapZ = map.getZoom();
    const targetZ = Math.max(minzoom, Math.min(maxzoom, Math.floor(mapZ)));
    const n = 2 ** targetZ;
    const bounds = map.getBounds();

    const wantInterval = effectiveInterval(mapZ);

    const xLo = Math.floor(lngToTileX(bounds.getWest(), targetZ));
    const xHi = Math.floor(lngToTileX(bounds.getEast(), targetZ));
    const yLo = Math.max(0, Math.floor(latToTileY(bounds.getNorth(), targetZ)));
    const yHi = Math.min(n - 1, Math.floor(latToTileY(bounds.getSouth(), targetZ)));

    // Build a deduplicated set of tiles to render. Two-pass walk:
    //   1. Add every loaded target-zoom tile + remember which target
    //      cells are still missing.
    //   2. Only run the parent-fallback walk if NO target tile is
    //      loaded yet (fresh zoom-in, nothing in cache for this z).
    //
    // The reason for the "no fallback when any target is loaded" gate
    // is that each tile's MVT carries features for its ENTIRE area at
    // THAT zoom's per-zoom DP tolerance — including areas already
    // covered by loaded child tiles at a finer tolerance. If we mix
    // the two, every isovalue gets drawn twice (once at the parent's
    // coarser path, once at the child's finer path). Without Chaikin
    // these two copies stack pixel-perfect at the marching-squares
    // vertices and look like one line; WITH Chaikin smoothing they
    // smooth to different vertex sets and visibly separate. Either
    // way the duplicate render wastes work and double-strokes the
    // isovalue's alpha-blended pixels.
    const tilesToRender = new Set<string>();
    const missing: Array<[number, number]> = [];
    let needRepaint = false;
    let anyTargetLoaded = false;

    for (let xRaw = xLo; xRaw <= xHi; xRaw++) {
      const x = ((xRaw % n) + n) % n;
      for (let y = yLo; y <= yHi; y++) {
        const cached = tileCache.get(targetZ, x, y);
        if (cached && cached.length !== undefined) {
          tilesToRender.add(`${targetZ}/${x}/${y}`);
          anyTargetLoaded = true;
          continue;
        }
        if (cached === undefined) {
          if (tileCache.ensure(targetZ, x, y, rebuild)) needRepaint = true;
        }
        missing.push([x, y]);
      }
    }
    if (!anyTargetLoaded) {
      for (const [x, y] of missing) {
        for (let pz = targetZ - 1; pz >= minzoom; pz--) {
          const dz = targetZ - pz;
          const px = x >> dz;
          const py = y >> dz;
          const pCached = tileCache.get(pz, px, py);
          if (pCached && pCached.length !== undefined) {
            tilesToRender.add(`${pz}/${px}/${py}`);
            break;
          }
        }
      }
    }

    const verts: number[] = [];
    for (const key of tilesToRender) {
      const [zStr, xStr, yStr] = key.split('/');
      const features = tileCache.get(+zStr, +xStr, +yStr);
      if (!features) continue;
      for (const f of features) {
        if (f.interval !== wantInterval) continue;
        const bold = (Math.round(f.value) % 10 === 0) ? 1 : 0;
        for (const polyline of f.polylines) {
          pushPolyline(verts, polyline, bold);
        }
      }
    }

    // If the new build is empty but fetches are still in flight, hold
    // the previous buffer instead of clearing. Avoids the brief blackout
    // when the user zooms past an integer threshold faster than the
    // walk-up can find a cached ancestor (e.g. very first zoom-in after
    // page load — z=1 fetches not done yet, no deeper ancestors). Once
    // any tile resolves, rebuild() runs again and either the target or
    // an ancestor lands in tilesToRender.
    if (verts.length === 0 && tileCache.hasPending() && pendingVertices.length > 0) {
      if (needRepaint) map.triggerRepaint();
      return;
    }

    pendingVertices = new Float32Array(verts);
    pendingDirty = true;
    if (needRepaint) map.triggerRepaint();
  }

  // Default to slot:'middle' on Mapbox v3 Standard so the line layer
  // sits below basemap labels (which Standard renders in their default
  // position) and below contour labels (which we pin to slot:'top').
  // Without a slot, Mapbox v3 renders custom layers AFTER everything
  // including slot:'top' — so contour labels end up under contour lines.
  // MapLibre + Mapbox classic ignore the property.
  const effectiveSlot = opts.slot ?? 'middle';

  const layer = {
    id: LAYER_ID,
    type: 'custom' as const,
    slot: effectiveSlot,

    onAdd(this: ContoursLineLayerThis, _map: unknown, gl: WebGL2RenderingContext): void {
      this.gl = gl;
      this.vbo = gl.createBuffer();
      this.vertexCount = 0;
      this.program = null;
      this.programVariant = null;
    },

    _ensureProgram(this: ContoursLineLayerThis, gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void {
      const variant = n.shaderData.variantName;
      if (this.program && this.programVariant === variant) return;
      if (this.program) gl.deleteProgram(this.program);
      this.program = buildProgram(gl, n.shaderData);
      this.programVariant = variant;

      this.attrP0 = gl.getAttribLocation(this.program, 'a_p0');
      this.attrP1 = gl.getAttribLocation(this.program, 'a_p1');
      this.attrT = gl.getAttribLocation(this.program, 'a_t');
      this.attrSide = gl.getAttribLocation(this.program, 'a_side');
      this.attrBold = gl.getAttribLocation(this.program, 'a_bold');

      this.uViewport = gl.getUniformLocation(this.program, 'u_viewport');
      this.uWidthBase = gl.getUniformLocation(this.program, 'u_width_base');
      this.uWidthExtra = gl.getUniformLocation(this.program, 'u_width_extra');
      this.uColor = gl.getUniformLocation(this.program, 'u_color');
      this.uOpacity = gl.getUniformLocation(this.program, 'u_opacity');

      this.uProjMatrix = gl.getUniformLocation(this.program, 'u_projection_matrix');
      this.uProjTileCoords = gl.getUniformLocation(this.program, 'u_projection_tile_mercator_coords');
      this.uProjClipping = gl.getUniformLocation(this.program, 'u_projection_clipping_plane');
      this.uProjTransition = gl.getUniformLocation(this.program, 'u_projection_transition');
      this.uProjFallback = gl.getUniformLocation(this.program, 'u_projection_fallback_matrix');
      this.uMapboxGlobeToMercator = gl.getUniformLocation(this.program, 'u_mapbox_globe_to_mercator');
      this.uMapboxGlobeTransition = gl.getUniformLocation(this.program, 'u_mapbox_globe_transition');
      this.uMapboxCenterMercator = gl.getUniformLocation(this.program, 'u_mapbox_center_mercator');
    },

    _setProjectionUniforms(this: ContoursLineLayerThis, gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void {
      if (n.isMapbox) {
        if (this.uProjMatrix) gl.uniformMatrix4fv(this.uProjMatrix, false, n.matrix);
        if (n.isMapboxGlobe && n.mapboxExtras) {
          const e = n.mapboxExtras;
          // isMapboxGlobe is true ⇒ projectionToMercatorMatrix is set
          // (that's how the flag is derived in normalizeRenderArgs).
          // TS can't follow the discriminator across the boundary so
          // we assert.
          if (this.uMapboxGlobeToMercator) gl.uniformMatrix4fv(this.uMapboxGlobeToMercator, false, e.projectionToMercatorMatrix!);
          if (this.uMapboxGlobeTransition !== null) gl.uniform1f(this.uMapboxGlobeTransition, e.projectionToMercatorTransition ?? 1.0);
          if (this.uMapboxCenterMercator) gl.uniform2fv(this.uMapboxCenterMercator, e.centerInMercator ?? [0, 0]);
        }
        return;
      }
      const pd = n.defaultProjectionData;
      if (!pd) return;
      if (this.uProjMatrix) gl.uniformMatrix4fv(this.uProjMatrix, false, pd.mainMatrix);
      if (this.uProjTileCoords) gl.uniform4fv(this.uProjTileCoords, pd.tileMercatorCoords);
      if (this.uProjClipping) gl.uniform4fv(this.uProjClipping, pd.clippingPlane);
      if (this.uProjTransition !== null) gl.uniform1f(this.uProjTransition, pd.projectionTransition);
      if (this.uProjFallback) gl.uniformMatrix4fv(this.uProjFallback, false, pd.fallbackMatrix);
    },

    _uploadIfDirty(this: ContoursLineLayerThis, gl: WebGL2RenderingContext): void {
      if (!pendingDirty) return;
      pendingDirty = false;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, pendingVertices, gl.DYNAMIC_DRAW);
      this.vertexCount = pendingVertices.length / VERT_STRIDE_FLOATS;
    },

    _bindAttribs(this: ContoursLineLayerThis, gl: WebGL2RenderingContext): void {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.enableVertexAttribArray(this.attrP0);
      gl.vertexAttribPointer(this.attrP0, 2, gl.FLOAT, false, VERT_STRIDE_BYTES, 0);
      gl.enableVertexAttribArray(this.attrP1);
      gl.vertexAttribPointer(this.attrP1, 2, gl.FLOAT, false, VERT_STRIDE_BYTES, 8);
      gl.enableVertexAttribArray(this.attrT);
      gl.vertexAttribPointer(this.attrT, 1, gl.FLOAT, false, VERT_STRIDE_BYTES, 16);
      gl.enableVertexAttribArray(this.attrSide);
      gl.vertexAttribPointer(this.attrSide, 1, gl.FLOAT, false, VERT_STRIDE_BYTES, 20);
      gl.enableVertexAttribArray(this.attrBold);
      gl.vertexAttribPointer(this.attrBold, 1, gl.FLOAT, false, VERT_STRIDE_BYTES, 24);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(this: ContoursLineLayerThis, gl: WebGL2RenderingContext, args: unknown, ...rest: any[]): void {
      const [projection, projectionToMercatorMatrix, projectionToMercatorTransition, centerInMercator, pixelsPerMeterRatio] = rest;
      const n: NormalisedRenderArgs = normalizeRenderArgs(args, {
        projection,
        projectionToMercatorMatrix,
        projectionToMercatorTransition,
        centerInMercator,
        pixelsPerMeterRatio,
      });
      this._ensureProgram(gl, n);
      this._uploadIfDirty(gl);

      if (this.vertexCount === 0) return;
      if (!this.program) return;

      gl.useProgram(this.program);
      this._bindAttribs(gl);
      this._setProjectionUniforms(gl, n);

      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      gl.uniform2f(this.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.uniform1f(this.uWidthBase, widthBaseCss * dpr);
      gl.uniform1f(this.uWidthExtra, widthExtra() * dpr);
      gl.uniform4fv(this.uColor, lineColor);
      gl.uniform1f(this.uOpacity, lineOpacity);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

      // Disable our attribute arrays so they don't leak into the next
      // layer's draw on the shared default VAO (and so onRemove's
      // deleteBuffer doesn't leave a dangling enabled array → the next
      // drawArrays would throw INVALID_OPERATION).
      gl.disableVertexAttribArray(this.attrP0);
      gl.disableVertexAttribArray(this.attrP1);
      gl.disableVertexAttribArray(this.attrT);
      gl.disableVertexAttribArray(this.attrSide);
      gl.disableVertexAttribArray(this.attrBold);
    },

    onRemove(this: ContoursLineLayerThis, _map: unknown, gl: WebGL2RenderingContext): void {
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.program) gl.deleteProgram(this.program);
      this.vbo = null;
      this.program = null;
    },
  };

  if (!map.getLayer(LAYER_ID)) {
    map.addLayer(layer, opts.beforeId);
  }

  // Eagerly fetch the world-view tile at minzoom (1 HTTP request,
  // typically <10 KB) so the walk-up ALWAYS has a global fallback
  // available — every higher-zoom tile's chain of ancestors ends at
  // (minzoom, 0, 0). Without this, a rapid zoom-in after page load
  // can outrun the intermediate-zoom fetches and leave the layer
  // empty for the brief window before the target tiles arrive.
  tileCache.ensure(minzoom, 0, 0, rebuild);

  map.on('move', rebuild);
  map.on('moveend', rebuild);
  rebuild();

  return {
    layerId: LAYER_ID,
    setInterval(newInterval: number): void {
      interval = newInterval;
      rebuild();
    },
    setLineColor(css: string): void {
      lineColor = parseCssColor(css);
      map.triggerRepaint();
    },
    setLineOpacity(v: number): void {
      lineOpacity = v;
      map.triggerRepaint();
    },
    setLineWidth(v: number): void {
      widthBaseCss = v;
      map.triggerRepaint();
    },
    setBoldLineWidth(v: number): void {
      boldLineWidthCss = v;
      map.triggerRepaint();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyOptions(p: any): void {
      if (p.initialInterval != null) {
        interval = p.initialInterval;
        rebuild();
      }
      if (p.lineColor != null) this.setLineColor(p.lineColor);
      if (p.lineOpacity != null) this.setLineOpacity(p.lineOpacity);
      if (p.lineWidth != null) this.setLineWidth(p.lineWidth);
      if (p.boldLineWidth != null) this.setBoldLineWidth(p.boldLineWidth);
    },
    remove(): void {
      map.off('move', rebuild);
      map.off('moveend', rebuild);
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      tileCache.clear();
    },
  };
}
