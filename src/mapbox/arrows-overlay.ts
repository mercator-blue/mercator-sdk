/**
 * Direction-arrow overlay for vector fields. Draws one arrow per
 * (subsampled) grid pixel in the visible viewport for any
 * `vector_rg_ba` dataset (wind, currents, …), colored by speed
 * magnitude. A static, non-animated alternative to streamlines —
 * cleaner for print/screenshot, easier to read at low zoom, and
 * preferred by some forecast / navigation use cases.
 *
 * Implementation: a Mapbox/MapLibre CUSTOM WebGL layer (type='custom').
 * Earlier versions used a GeoJSON source + standard `line` layer, but
 * Mapbox v3's globe rendering pipeline batches custom layers and
 * standard non-symbol layers into separate passes — standard lines
 * draw FIRST, then custom layers cover them, then symbols on top.
 * With arrows as a standard line layer, they'd disappear behind the
 * raster/particles custom layers on Mapbox globe. As a custom layer,
 * arrows render in the same pass as raster + particles and `beforeId`
 * controls their relative order.
 *
 * Each arrow is 3 line segments (tail→tip, tip→wingL, tip→wingR),
 * each rendered as a thin SCREEN-SPACE QUAD (2 triangles, 6 verts)
 * so we get a controllable line width. Per-vertex layout:
 *   a_p0(2) + a_p1(2) + a_t(1) + a_side(1) + a_speed(1) = 7 floats.
 * Same expanded-line geometry pattern as tile-boundaries-overlay; see
 * arrows.vert for the shader-side projection + screen-space offset.
 */

import { createProgram } from '../core/webgl-helpers';
import {
  lngToTileX,
  latToTileY,
  tilePixelToLngLat,
  lngLatToMercator,
} from '../core/mercator';
import { loadTilePixels } from '../core/tile-pixel-reader';
import { normalizeRenderArgs, type NormalisedRenderArgs } from './host-adapter';
import { ARROWS_VS, ARROWS_FS } from './shaders/index.js';

// Layer id kept stable across the GeoJSON→custom-layer rewrite so
// host pages that reference the id via beforeId (the test page does
// this for canonical z-stack enforcement) keep working.
const LAYER_ID = '__debug_arrows_lines';

const TARGET_ARROWS_ACROSS = 30;

// Per-vertex layout: a_p0(2) + a_p1(2) + a_t(1) + a_side(1) + a_speed(1) = 7 floats.
const VERT_STRIDE_FLOATS = 7;
const VERT_STRIDE_BYTES = VERT_STRIDE_FLOATS * 4;

// Default arrow line width in CSS pixels. Matches the tile-boundaries
// default for visual consistency; override via opts.lineWidth.
const DEFAULT_LINE_WIDTH_CSS_PX = 1.5;

// Default speed (m/s) at which arrow length saturates AND the colour
// ramp hits its top stop. Matches the legacy wind-tuned behaviour;
// pass speedRef explicitly (from STAC `mercator:visualization.vmax`)
// for any non-wind dataset.
const DEFAULT_SPEED_REF_MS = 15;

export interface ArrowsEncoding {
  scale: number;
  offset: number;
}

export interface ArrowsOverlayOpts {
  tileUrlTemplate: string;
  encoding: ArrowsEncoding;
  maxzoom?: number;
  lockZoom?: number;
  /**
   * Speed (m/s) at which arrow length saturates and the colour ramp
   * hits its top stop. Pull from STAC `mercator:visualization.vmax`
   * so each dataset gets its natural range.
   */
  speedRef?: number;
  landmaskUrlTemplate?: string;
  landmaskAccepts?: number[];
  beforeId?: string;
  /** Mapbox GL JS v3 slot. */
  slot?: string;
  /** Arrow line width in CSS pixels. Default 1.5. */
  lineWidth?: number;
}

export interface ArrowsInspectResult {
  z: number;
  tx: number;
  ty: number;
  px: number;
  py: number;
  u: number;
  v: number;
  speed: number;
}

export interface ArrowsOverlayHandle {
  remove(): void;
  /** Apply a partial options patch. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyOptions(p: any): void;
  /** For click-to-inspect debug UIs. Returns the source pixel under
   *  the cursor, or null if no tile is loaded there yet. */
  inspectAt(lng: number, lat: number): ArrowsInspectResult | null;
}

type LoadedTileEntry = {
  status: 'loaded';
  u: Float32Array;
  v: Float32Array;
  W: number;
  H: number;
};
type LoadingTileEntry = { status: 'loading'; promise: Promise<LoadedTileEntry> };
type ErrorTileEntry = { status: 'error' };
type TileCacheEntry = LoadedTileEntry | LoadingTileEntry | ErrorTileEntry;
type TileCache = Map<string, TileCacheEntry>;

/**
 * Push one expanded sub-segment quad (2 triangles, 6 vertices). Each
 * vertex carries BOTH endpoints (the shader needs them to compute the
 * screen-space tangent), its endpoint flag (t=0 or 1), perpendicular
 * side (-1 or +1), and the per-arrow speed for fragment colouring.
 * Winding is CCW so optional face culling won't drop a half.
 */
function pushQuad(
  verts: number[],
  p0x: number, p0y: number,
  p1x: number, p1y: number,
  speed: number,
): void {
  // Triangle 1: A_-, B_-, A_+
  verts.push(p0x, p0y, p1x, p1y, 0, -1, speed);
  verts.push(p0x, p0y, p1x, p1y, 1, -1, speed);
  verts.push(p0x, p0y, p1x, p1y, 0,  1, speed);
  // Triangle 2: A_+, B_-, B_+
  verts.push(p0x, p0y, p1x, p1y, 0,  1, speed);
  verts.push(p0x, p0y, p1x, p1y, 1, -1, speed);
  verts.push(p0x, p0y, p1x, p1y, 1,  1, speed);
}


async function loadTile(
  cache: TileCache,
  tileUrlTemplate: string,
  encoding: ArrowsEncoding,
  z: number, x: number, y: number,
  landmaskUrlTemplate: string | undefined,
  landmaskAccepts: Set<number> | null,
): Promise<LoadedTileEntry> {
  const key = `${z}/${x}/${y}`;
  const existing = cache.get(key);
  if (existing) {
    if (existing.status === 'loading') return existing.promise;
    if (existing.status === 'loaded') return existing;
    // status === 'error' — fall through and retry.
  }
  const promise = (async (): Promise<LoadedTileEntry> => {
    const url = tileUrlTemplate
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const maskUrl = landmaskUrlTemplate
      ? landmaskUrlTemplate
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(y))
      : null;
    const [dataPx, maskPx] = await Promise.all([
      loadTilePixels(url),
      maskUrl ? loadTilePixels(maskUrl).catch(() => null) : Promise.resolve(null),
    ]);
    const { width: W, height: H, pixels: data } = dataPx;
    const u = new Float32Array(W * H);
    const v = new Float32Array(W * H);
    const sc = encoding.scale, off = encoding.offset;
    const maskBytes = maskPx?.pixels;
    const useMask = !!(maskBytes && maskBytes.length === W * H * 4 && landmaskAccepts);
    for (let i = 0; i < W * H; i++) {
      const r = data[i * 4], g = data[i * 4 + 1];
      const b = data[i * 4 + 2], a = data[i * 4 + 3];
      if ((r | g | b | a) === 0) { u[i] = NaN; v[i] = NaN; continue; }
      if (useMask && !landmaskAccepts!.has(maskBytes![i * 4])) {
        u[i] = NaN; v[i] = NaN; continue;
      }
      u[i] = (r * 256 + g) * sc + off;
      v[i] = (b * 256 + a) * sc + off;
    }
    const loaded: LoadedTileEntry = { status: 'loaded', u, v, W, H };
    cache.set(key, loaded);
    return loaded;
  })();
  cache.set(key, { status: 'loading', promise });
  promise.catch(() => cache.set(key, { status: 'error' }));
  return promise;
}

function buildProgram(
  gl: WebGL2RenderingContext,
  shaderData: NormalisedRenderArgs['shaderData'],
): WebGLProgram {
  const prelude = shaderData?.vertexShaderPrelude ?? '';
  const define = shaderData?.define ?? '';
  const vsSource = `#version 300 es\n${prelude}\n${define}\n${ARROWS_VS}`;
  const fsSource = `#version 300 es\n${ARROWS_FS}`;
  return createProgram(gl, vsSource, fsSource);
}

/**
 * State the custom WebGL layer attaches to `this` between onAdd and
 * onRemove. Methods that touch these fields annotate `this` to this
 * interface so TS knows about them — the object literal that ships the
 * layer to Mapbox / MapLibre is built bare and the host's custom-layer
 * protocol calls the methods with the layer as `this`.
 */
interface ArrowsLayerThis {
  gl: WebGL2RenderingContext;
  vbo: WebGLBuffer | null;
  vertexCount: number;
  program: WebGLProgram | null;
  programVariant: string | null;

  attrP0: GLint;
  attrP1: GLint;
  attrT: GLint;
  attrSide: GLint;
  attrSpeed: GLint;

  uViewport: WebGLUniformLocation | null;
  uLineWidth: WebGLUniformLocation | null;
  uSpeedRef: WebGLUniformLocation | null;

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
}

export function addArrowsOverlay(
  // The map argument is a maplibregl.Map or mapboxgl.Map — we don't
  // hard-depend on either lib's types, so this stays loose. Inside,
  // we cast to `any` to call the standard Map API.
  mapAny: unknown,
  opts: ArrowsOverlayOpts,
): ArrowsOverlayHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = mapAny as any;
  const { tileUrlTemplate, encoding } = opts;
  const maxzoom = opts.maxzoom ?? 5;
  let lockZoom = opts.lockZoom;
  let lineWidthCss = opts.lineWidth ?? DEFAULT_LINE_WIDTH_CSS_PX;
  // Speed (m/s) at which arrow length saturates AND the colour ramp
  // hits its top stop. Threaded from STAC `mercator:visualization.vmax`
  // — wind is ~40, currents is ~2. Without this, both length and colour
  // were hardcoded around wind's range (15 / 40), so currents (whose
  // max ~3 m/s falls entirely below both thresholds) rendered as a
  // field of identical-length, identical-colour stubs. Fallback 15
  // preserves the legacy wind-tuned behaviour for callers (legacy
  // tests, third parties) that don't pass a speedRef.
  let speedRef = opts.speedRef ?? DEFAULT_SPEED_REF_MS;
  const landmaskUrlTemplate = opts.landmaskUrlTemplate;
  const landmaskAccepts = opts.landmaskAccepts
    ? new Set(opts.landmaskAccepts)
    : null;
  const cache: TileCache = new Map();

  // Latest CPU-sampled vertex data. Mutated by rebuildVertices(); the
  // layer's render() uploads it to the GPU lazily (only when the
  // contents differ from what we last uploaded).
  let pendingVertices = new Float32Array(0);
  let pendingVerticesDirty = false;

  let pending = false;
  let queued = false;

  async function rebuildVertices(): Promise<void> {
    if (pending) {
      queued = true;
      return;
    }
    pending = true;
    try {
      const z = lockZoom != null
        ? Math.max(0, Math.min(maxzoom, lockZoom))
        : Math.max(0, Math.min(maxzoom, Math.floor(map.getZoom())));
      const n = 2 ** z;
      const bounds = map.getBounds();
      const wLng = bounds.getWest(), eLng = bounds.getEast();
      const nLat = bounds.getNorth(), sLat = bounds.getSouth();

      const txMin = Math.floor(lngToTileX(wLng, z));
      const txMax = Math.floor(lngToTileX(eLng, z));
      const tyMin = Math.max(0, Math.floor(latToTileY(nLat, z)));
      const tyMax = Math.min(n - 1, Math.floor(latToTileY(sLat, z)));

      const tilePromises: Promise<LoadedTileEntry | null>[] = [];
      for (let tx = txMin; tx <= txMax; tx++) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          const wrappedTx = ((tx % n) + n) % n;
          tilePromises.push(
            loadTile(cache, tileUrlTemplate, encoding, z, wrappedTx, ty, landmaskUrlTemplate, landmaskAccepts).catch(() => null),
          );
        }
      }
      await Promise.all(tilePromises);

      // Lattice in DATA pixel space. Data is at zoom z (clamped to the
      // data layer's maxzoom), but the lattice STEP is sized to give
      // ~TARGET_ARROWS_ACROSS arrows across the viewport regardless of
      // view zoom — including when the view zooms in past data maxzoom
      // (which is exactly when the old integer-stride algorithm bottomed
      // out and produced 1 or 0 arrows). At that regime pxStep can be
      // fractional (< 1 data-pixel), so multiple lattice points fall
      // inside a single data pixel; each one bilinearly samples u/v
      // from the tile's discrete grid, so neighbours produce smoothly-
      // varying arrows instead of a single solid block.
      //
      // The lattice is anchored to a GLOBAL data-pixel grid (start at a
      // multiple of pxStep) so panning doesn't visibly shift arrows.
      const dataPxLeft = lngToTileX(wLng, z) * 256;
      const dataPxRight = lngToTileX(eLng, z) * 256;
      const dataPxTop = latToTileY(nLat, z) * 256;
      const dataPxBottom = latToTileY(sLat, z) * 256;
      const dataPxViewportWidth = dataPxRight - dataPxLeft;
      const dataPxViewportHeight = dataPxBottom - dataPxTop;

      const SPEED_REF_MS = speedRef;
      const MIN_LEN_FRAC = 0.18;

      // Float32-precision floor on arrow length, in degrees of longitude.
      // The vertex buffer is Float32Array; near mercator coord 0.5 each
      // ULP is ~6e-8 world units, and at coord 1.0 it's ~1.2e-7. Arrow
      // wing offsets need to stay several ULPs above the tip's float32
      // value or they collapse onto it — visually, wings disappear and
      // arrows degenerate into "cuneiform" smudges at z~18+.
      //
      // At MIN_BASE_LEN_DEG = 1e-3°, even a min-speed wing
      // (= baseLenDeg * MIN_LEN_FRAC * 0.35 * (1/360) world units)
      // works out to ~3 ULPs above the tip — enough for crisp geometry.
      // When the natural baseLenDeg (viewport/30 * 0.85) drops below
      // this, we hold baseLenDeg at the floor and instead reduce the
      // arrow COUNT to keep them from overlapping in the viewport.
      // Past the point where even one precision-safe arrow won't fit
      // (~z=20+), arrowsAcross goes to zero and nothing renders.
      const MIN_BASE_LEN_DEG = 1e-3;
      const naturalBaseLenDeg = ((eLng - wLng) / TARGET_ARROWS_ACROSS) * 0.85;
      let baseLenDeg: number, arrowsAcross: number;
      if (naturalBaseLenDeg >= MIN_BASE_LEN_DEG) {
        baseLenDeg = naturalBaseLenDeg;
        arrowsAcross = TARGET_ARROWS_ACROSS;
      } else {
        baseLenDeg = MIN_BASE_LEN_DEG;
        arrowsAcross = Math.max(0, Math.floor((eLng - wLng) * 0.85 / MIN_BASE_LEN_DEG));
      }

      if (arrowsAcross === 0) {
        // Viewport can't fit even one precision-safe arrow — render none.
        pendingVertices = new Float32Array(0);
        pendingVerticesDirty = true;
        map.triggerRepaint();
        return;
      }

      const pxStep = Math.max(1e-6, dataPxViewportWidth / arrowsAcross);
      const halfStep = pxStep * 0.5;

      // Two sampling regimes:
      //   - "single-sample": viewport is smaller than 1 data pixel in
      //     either dimension. There is no real data variation to show —
      //     the user is zoomed in below the data's native resolution.
      //     Sample u/v ONCE from the data pixel containing the viewport
      //     centre and reuse it for every arrow. This avoids the
      //     banding artifact you get with per-arrow nearest sampling
      //     when the lattice straddles a data-pixel boundary (rows
      //     snap to pixel A, others to pixel B, producing two
      //     directions in alternating horizontal bands).
      //   - "bilinear" (otherwise): smooth interpolation across real
      //     data values. Works at any lattice spacing as long as the
      //     viewport itself spans ≥ 1 data pixel in both dimensions.
      const useSingleSample = dataPxViewportWidth < 1 || dataPxViewportHeight < 1;

      const startX = Math.floor(dataPxLeft / pxStep) * pxStep + halfStep;
      const startY = Math.floor(dataPxTop / pxStep) * pxStep + halfStep;

      // Pre-compute the single-sample u/v if we're in that regime.
      let singleU = NaN, singleV = NaN;
      if (useSingleSample) {
        const centerPxX = (dataPxLeft + dataPxRight) * 0.5;
        const centerPxY = (dataPxTop + dataPxBottom) * 0.5;
        const cTx = Math.floor(centerPxX / 256);
        const cTy = Math.floor(centerPxY / 256);
        if (cTy >= 0 && cTy < n) {
          const cWrappedTx = ((cTx % n) + n) % n;
          const cTile = cache.get(`${z}/${cWrappedTx}/${cTy}`);
          if (cTile && cTile.status === 'loaded') {
            const cFx = Math.max(0, Math.min(cTile.W - 1, Math.floor(centerPxX - cTx * 256)));
            const cFy = Math.max(0, Math.min(cTile.H - 1, Math.floor(centerPxY - cTy * 256)));
            const cI = cFy * cTile.W + cFx;
            singleU = cTile.u[cI];
            singleV = cTile.v[cI];
          }
        }
      }

      // Collect vertices in a plain JS array (push is faster than
      // tracking length on a typed array of unknown size).
      const tmp: number[] = [];
      for (let pixY = startY; pixY < dataPxBottom + halfStep; pixY += pxStep) {
        const ty = Math.floor(pixY / 256);
        if (ty < 0 || ty >= n) continue;
        const fyAbs = pixY - ty * 256;
        for (let pixX = startX; pixX < dataPxRight + halfStep; pixX += pxStep) {
          const tx = Math.floor(pixX / 256);
          const wrappedTx = ((tx % n) + n) % n;
          const tile = cache.get(`${z}/${wrappedTx}/${ty}`);
          if (!tile || tile.status !== 'loaded') continue;
          const fxAbs = pixX - tx * 256;

          // Sample u/v at this lattice point. Single-sample reuses the
          // pre-computed centre value (see useSingleSample note above);
          // otherwise bilinear-interpolate from the data tile's 2×2
          // neighbours at (fxAbs, fyAbs). Cross-tile neighbours are
          // clamped to the tile's last column/row — minor inaccuracy
          // on the right/bottom edge of each tile, not visible to the
          // eye.
          let u: number, v: number;
          if (useSingleSample) {
            u = singleU;
            v = singleV;
          } else {
            const x0 = Math.max(0, Math.min(tile.W - 1, Math.floor(fxAbs)));
            const y0 = Math.max(0, Math.min(tile.H - 1, Math.floor(fyAbs)));
            const x1 = Math.min(tile.W - 1, x0 + 1);
            const y1 = Math.min(tile.H - 1, y0 + 1);
            const ax = Math.max(0, Math.min(1, fxAbs - x0));
            const ay = Math.max(0, Math.min(1, fyAbs - y0));
            const w00 = (1 - ax) * (1 - ay);
            const w01 = ax * (1 - ay);
            const w10 = (1 - ax) * ay;
            const w11 = ax * ay;
            const i00 = y0 * tile.W + x0;
            const i01 = y0 * tile.W + x1;
            const i10 = y1 * tile.W + x0;
            const i11 = y1 * tile.W + x1;
            u = tile.u[i00] * w00 + tile.u[i01] * w01 + tile.u[i10] * w10 + tile.u[i11] * w11;
            v = tile.v[i00] * w00 + tile.v[i01] * w01 + tile.v[i10] * w10 + tile.v[i11] * w11;
          }
          const speed = Math.sqrt(u * u + v * v);
          if (!Number.isFinite(speed) || speed < 0.05) continue;

          const [lng0, lat0] = tilePixelToLngLat(z, tx, ty, fxAbs, fyAbs);

          const ndu = u / speed;
          const ndv = v / speed;
          const lenFrac = Math.max(MIN_LEN_FRAC, Math.min(1, speed / SPEED_REF_MS));
          const shaftLen = baseLenDeg * lenFrac;
          const headLen = shaftLen * 0.35;
          const tipLng = lng0 + ndu * shaftLen;
          const tipLat = lat0 + ndv * shaftLen;
          const angle = Math.atan2(ndv, ndu);
          const aL = angle + Math.PI - 0.45;
          const aR = angle + Math.PI + 0.45;
          const wingL_lng = tipLng + Math.cos(aL) * headLen;
          const wingL_lat = tipLat + Math.sin(aL) * headLen;
          const wingR_lng = tipLng + Math.cos(aR) * headLen;
          const wingR_lat = tipLat + Math.sin(aR) * headLen;

          // Convert each of (tail, tip, wingL, wingR) to mercator
          // world coords [0,1]². The host-adapter's projectTile()
          // takes it from there for both flat Mercator and globe.
          const [mxT, myT] = lngLatToMercator(lng0, lat0);
          const [mxTip, myTip] = lngLatToMercator(tipLng, tipLat);
          const [mxWL, myWL] = lngLatToMercator(wingL_lng, wingL_lat);
          const [mxWR, myWR] = lngLatToMercator(wingR_lng, wingR_lat);

          // 3 segments, each as an expanded quad (2 triangles, 6 verts).
          pushQuad(tmp, mxT,   myT,   mxTip, myTip, speed);
          pushQuad(tmp, mxTip, myTip, mxWL,  myWL,  speed);
          pushQuad(tmp, mxTip, myTip, mxWR,  myWR,  speed);
        }
      }
      pendingVertices = new Float32Array(tmp);
      pendingVerticesDirty = true;
      // Custom layers don't auto-repaint on data changes the way
      // GeoJSON-source line layers do — kick the map so render() runs.
      map.triggerRepaint();
    } finally {
      pending = false;
      if (queued) {
        queued = false;
        rebuildVertices();
      }
    }
  }

  // The custom layer — implements Mapbox/MapLibre's CustomLayerInterface.
  // Render is called per-frame; CPU sampling is event-driven (moveend /
  // zoomend), so render() just draws the latest vertex buffer.
  const layer = {
    id: LAYER_ID,
    type: 'custom' as const,
    // Mapbox v3 slot; ignored by MapLibre + older Mapbox.
    ...(opts.slot ? { slot: opts.slot } : {}),

    onAdd(this: ArrowsLayerThis, _map: unknown, gl: WebGL2RenderingContext): void {
      this.gl = gl;
      this.vbo = gl.createBuffer();
      this.vertexCount = 0;
      this.program = null;
      this.programVariant = null;
    },

    _ensureProgram(this: ArrowsLayerThis, gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void {
      const variant = n.shaderData.variantName;
      if (this.program && this.programVariant === variant) return;
      if (this.program) gl.deleteProgram(this.program);
      this.program = buildProgram(gl, n.shaderData);
      this.programVariant = variant;
      this.attrP0 = gl.getAttribLocation(this.program, 'a_p0');
      this.attrP1 = gl.getAttribLocation(this.program, 'a_p1');
      this.attrT = gl.getAttribLocation(this.program, 'a_t');
      this.attrSide = gl.getAttribLocation(this.program, 'a_side');
      this.attrSpeed = gl.getAttribLocation(this.program, 'a_speed');
      this.uViewport = gl.getUniformLocation(this.program, 'u_viewport');
      this.uLineWidth = gl.getUniformLocation(this.program, 'u_line_width');
      this.uSpeedRef = gl.getUniformLocation(this.program, 'u_speedRef');
      this.uProjMatrix = gl.getUniformLocation(this.program, 'u_projection_matrix');
      this.uProjTileCoords = gl.getUniformLocation(this.program, 'u_projection_tile_mercator_coords');
      this.uProjClipping = gl.getUniformLocation(this.program, 'u_projection_clipping_plane');
      this.uProjTransition = gl.getUniformLocation(this.program, 'u_projection_transition');
      this.uProjFallback = gl.getUniformLocation(this.program, 'u_projection_fallback_matrix');
      // Mapbox-globe-only.
      this.uMapboxGlobeToMercator = gl.getUniformLocation(this.program, 'u_mapbox_globe_to_mercator');
      this.uMapboxGlobeTransition = gl.getUniformLocation(this.program, 'u_mapbox_globe_transition');
      this.uMapboxCenterMercator = gl.getUniformLocation(this.program, 'u_mapbox_center_mercator');
    },

    _setProjectionUniforms(this: ArrowsLayerThis, gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void {
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

    _uploadIfDirty(this: ArrowsLayerThis, gl: WebGL2RenderingContext): void {
      if (!pendingVerticesDirty) return;
      pendingVerticesDirty = false;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, pendingVertices, gl.DYNAMIC_DRAW);
      this.vertexCount = pendingVertices.length / VERT_STRIDE_FLOATS;
    },

    // Host signature has trailing positional args under Mapbox globe;
    // we forward them to normalizeRenderArgs which makes sense of both
    // Mapbox + MapLibre shapes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(this: ArrowsLayerThis, gl: WebGL2RenderingContext, args: unknown, ...rest: any[]): void {
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
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

      // Attribute layout: a_p0(2) + a_p1(2) + a_t(1) + a_side(1) + a_speed(1)
      // = 7 floats × 4 bytes = 28 bytes stride.
      gl.enableVertexAttribArray(this.attrP0);
      gl.vertexAttribPointer(this.attrP0, 2, gl.FLOAT, false, VERT_STRIDE_BYTES, 0);
      gl.enableVertexAttribArray(this.attrP1);
      gl.vertexAttribPointer(this.attrP1, 2, gl.FLOAT, false, VERT_STRIDE_BYTES, 8);
      gl.enableVertexAttribArray(this.attrT);
      gl.vertexAttribPointer(this.attrT, 1, gl.FLOAT, false, VERT_STRIDE_BYTES, 16);
      gl.enableVertexAttribArray(this.attrSide);
      gl.vertexAttribPointer(this.attrSide, 1, gl.FLOAT, false, VERT_STRIDE_BYTES, 20);
      gl.enableVertexAttribArray(this.attrSpeed);
      gl.vertexAttribPointer(this.attrSpeed, 1, gl.FLOAT, false, VERT_STRIDE_BYTES, 24);

      this._setProjectionUniforms(gl, n);

      // Line-width + viewport in DEVICE pixels (× DPR so a "1.5 CSS px"
      // line stays 1.5 CSS px on HiDPI screens).
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      gl.uniform2f(this.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(this.uLineWidth, lineWidthCss * dpr);
      if (this.uSpeedRef !== null) gl.uniform1f(this.uSpeedRef, speedRef);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

      // Disable our attribute arrays so they don't leak into the next
      // layer's draw on the shared default VAO. Critical on removal:
      // onRemove deletes `vbo`, and a still-enabled array pointing at a
      // deleted buffer makes the NEXT layer's drawArrays throw
      // INVALID_OPERATION ("no buffer is bound to enabled attribute").
      gl.disableVertexAttribArray(this.attrP0);
      gl.disableVertexAttribArray(this.attrP1);
      gl.disableVertexAttribArray(this.attrT);
      gl.disableVertexAttribArray(this.attrSide);
      gl.disableVertexAttribArray(this.attrSpeed);
    },

    onRemove(this: ArrowsLayerThis, _map: unknown, gl: WebGL2RenderingContext): void {
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.program) gl.deleteProgram(this.program);
      this.vbo = null;
      this.program = null;
    },
  };

  map.addLayer(layer, opts.beforeId);
  map.on('moveend', rebuildVertices);
  map.on('zoomend', rebuildVertices);
  // Initial paint.
  rebuildVertices();

  return {
    remove(): void {
      map.off('moveend', rebuildVertices);
      map.off('zoomend', rebuildVertices);
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    },
    /** Apply a partial options patch. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyOptions(p: any): void {
      let needsRebuild = false;
      if (p.lockZoom !== undefined) {
        lockZoom = p.lockZoom;
        needsRebuild = true;
      }
      if (p.lineWidth != null) {
        lineWidthCss = p.lineWidth;
        map.triggerRepaint();
      }
      if (p.speedRef != null) {
        speedRef = p.speedRef;
        map.triggerRepaint();
      }
      if (needsRebuild) rebuildVertices();
    },
    inspectAt(lng: number, lat: number): ArrowsInspectResult | null {
      const z = lockZoom != null
        ? Math.max(0, Math.min(maxzoom, lockZoom))
        : Math.max(0, Math.min(maxzoom, Math.floor(map.getZoom())));
      const n = 2 ** z;
      const tx = Math.floor(lngToTileX(lng, z));
      const ty = Math.floor(latToTileY(lat, z));
      const wrappedTx = ((tx % n) + n) % n;
      const tile = cache.get(`${z}/${wrappedTx}/${ty}`);
      if (!tile || tile.status !== 'loaded') return null;
      const wx = lngToTileX(lng, z);
      const wy = latToTileY(lat, z);
      const px = Math.floor((wx - tx) * tile.W);
      const py = Math.floor((wy - ty) * tile.H);
      if (px < 0 || px >= tile.W || py < 0 || py >= tile.H) return null;
      const i = py * tile.W + px;
      const u = tile.u[i], v = tile.v[i];
      const speed = Math.sqrt(u * u + v * v);
      return { z, tx: wrappedTx, ty, px, py, u, v, speed };
    },
  };
}
