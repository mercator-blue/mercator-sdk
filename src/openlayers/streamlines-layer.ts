/**
 * OpenLayers binding — animated particle streamlines for vector_rg_ba
 * datasets (wind, currents, …).
 *
 * **Chunk 2 of N — CPU simulation, no trails yet**. Particles now sample
 * u/v bilinearly from the dataset's data tiles, advance each frame by
 * `(u, v) * speedScale`, and recycle on age / off-world. The canvas
 * still clears each frame (trails added in chunk 3), so the visual is
 * white dots that *flow* with the wind / current field rather than the
 * static random scatter from chunk 1.
 *
 * Subsequent chunks layer on:
 *   3. Trail FBO + fade (ping-pong, with the 0.6/255 quantum-floor fade
 *      from CLAUDE.md).
 *   4. Camera-move reset (clear trails + reseed when zoom/center changes).
 *   5. Colour-by-speed + the full runtime setters (count, size, speed,
 *      age, fade, cbs, colormap).
 *
 * Implementation notes:
 *
 * - Particle positions in mercator-world [0, 1]² (one canonical world).
 *   World copies synthesized at render time via integer 2·HALF offsets.
 *   Sampling uses the canonical position only — the data tile is the
 *   same in every world copy.
 *
 * - Continuous animation via `requestAnimationFrame` inside `render`:
 *   each frame schedules the next `layer.changed()`, so as long as the
 *   layer is on a map OL keeps calling `render` at the display refresh
 *   rate.
 *
 * - Sampling: same `ensureTile` + WebGL-pixel-reader pattern as the
 *   arrows layer (u/v stored as parallel Float32Arrays). Particles in
 *   regions whose tile isn't loaded yet hold position (zero velocity)
 *   until the tile arrives.
 *
 * - Recycling: a particle resets to a random `[0, 1]²` position when its
 *   age exceeds `maxAge`, when its mercator-y leaves `[0, 1]` (north /
 *   south of the mercator clip), or when its velocity becomes NaN (over
 *   land in landmask-filtered datasets). The mercator-x wraps mod 1 so
 *   particles can cross the antimeridian without recycling. Chunk 4
 *   will re-seed into the *visible* viewport on camera change so the
 *   particle count remains visually concentrated even at high zoom.
 */

import Layer from 'ol/layer/Layer.js';
import { apply as applyTransform } from 'ol/transform.js';
import type { FrameState } from 'ol/Map.js';

import { loadTilePixels } from '../core/tile-pixel-reader';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, absolutiseUrl, expandTileUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import { resolveColormap } from '../core/colormaps';
import { uploadColormapTexture } from '../core/colormap-texture';
import type { ColormapSpec, MercatorStreamlinesOptions } from '../core/types';
import { createProgram } from '../core/webgl-helpers';

import { HALF_MERCATOR, WORLD_EXT_3857 } from '../core/mercator';

// Default speed scale: mercator-world units per (m/s) per frame. 6e-5 is
// the Mapbox/Leaflet default for typical wind speeds; STAC's
// `mercator:visualization.particle_speed_scale` overrides per-dataset
// (currents use ~3.6e-3 since their values are much smaller).
const DEFAULT_SPEED_SCALE = 6e-5;
// Particle lifetime in frames before forced recycle. At 60 fps, 600
// frames = ~10 s. Long enough for trails (chunk 3) to feel coherent,
// short enough that the field eventually refreshes everywhere.
const DEFAULT_MAX_AGE = 600;

// Per-frame step floor, in device pixels. Slower particles are sped up to
// this (preserving direction) so calm regions still drift visibly instead
// of freezing and popping out; genuine zero stays zero. There is NO max
// counterpart — segment quads make trails continuous at any speed (the old
// `0.7 × dotSize` max cap is gone). Matches the Mapbox/Leaflet bindings.
const MIN_STEP_PIXELS = 0.5;

// OL renders streamlines at 1/3 the requested point size so the shared
// controls.js slider (which defaults to 3 across every binding for
// cross-host consistency) produces visually small dots in OL — the
// other bindings interpret `pointSize` as device pixels directly,
// whereas here we scale down so a trail at the per-frame-step cap
// stays continuous without each dot looking heavyweight.
//
// Per-vertex `a_speed_t` is the particle's speed normalised to
// `[0, 1]` against `speedRef` (clamped). Passed through to the
// fragment shader where it indexes the palette LUT when colour-by-
// speed is enabled.
import {
  POINTS_VS as VERTEX_SHADER,
  POINTS_FS as FRAGMENT_SHADER,
  QUAD_VS,
  FADE_FS,
} from './shaders/index';

/** OpenLayers-specific extras on top of the cross-binding
 *  {@link MercatorStreamlinesOptions}. */
export type MercatorStreamlinesLayerOpts = MercatorStreamlinesOptions & {
  /** Speed (m/s) that maps to the top of the colormap. Defaults to the
   *  dataset's `mercator:visualization.vmax`, falling back to 15. */
  speedRef?: number;
  /** Landmask tile URL template. Defaults to the dataset's
   *  `mercator:landmask.url_template`. */
  landmaskUrlTemplate?: string;
  /** Mask bytes treated as valid. Defaults to STAC's `landmask.accepts`. */
  landmaskAccepts?: number[];
  /** OL layer z-index. Default 650 — above arrows (600), below
   *  value-labels (700) and tile-boundaries (1000). */
  zIndex?: number;
};

type LoadedTile = { status: 'loaded'; u: Float32Array; v: Float32Array; W: number; H: number };
type LoadingTile = { status: 'loading'; promise: Promise<LoadedTile> };
type ErrorTile = { status: 'error' };
type TileCacheEntry = LoadedTile | LoadingTile | ErrorTile;

function buildLayer(opts: MercatorStreamlinesLayerOpts, item: DiscoveredItem): Layer {
  if (item.encoding.kind !== 'vector_rg_ba') {
    throw new Error(
      `@mercator-blue/sdk/openlayers: MercatorStreamlinesLayer requires a ` +
      `vector_rg_ba encoding; got "${item.encoding.kind}".`,
    );
  }

  let particleCount = opts.particleCount ?? 8000;
  let pointSize = opts.pointSize ?? 3;
  let speedScale = opts.speedScale ?? item.visualization?.particle_speed_scale ?? DEFAULT_SPEED_SCALE;
  let maxAge = opts.maxAge ?? DEFAULT_MAX_AGE;
  let fade = opts.fade ?? 0.99;
  let colorBySpeed = opts.colorBySpeed ?? false;
  let speedRef = opts.speedRef ?? item.visualization?.vmax ?? 15;
  let paletteData = resolveColormap(opts.colormap ?? item.visualization?.colormap ?? 'viridis');
  let paletteDirty = true;
  let paletteTexture: WebGLTexture | null = null;

  const maxzoom = item.tile.maxzoom;
  const tileUrlTemplate = withApiKey(`${item.itemBase}/{z}/{x}/{y}.png`, opts.apiKey);
  const lmTemplate = opts.landmaskUrlTemplate ?? item.landmask?.url_template;
  const landmaskUrlTemplate = lmTemplate
    ? withApiKey(absolutiseUrl(lmTemplate, item.itemBase), opts.apiKey)
    : undefined;
  const lmAccepts = opts.landmaskAccepts ?? item.landmask?.accepts;
  const landmaskAccepts = lmAccepts ? new Set(lmAccepts) : null;

  // Particle state. Positions in mercator-world [0, 1]², ages in frames.
  // Positions are Float64 because Float32's ULP at value ~0.5 is ~6e-8
  // — already coarser than one CSS pixel at z=24 (where 1 px = ~6e-8
  // mercator-world). Combined with the per-frame step cap, the advance
  // delta drops below that quantum past ~z=18 and particles freeze at
  // their current positions if positions are Float32. Float64 has
  // ~1.1e-16 ULP at value ~0.5, plenty of headroom for any zoom we
  // realistically support. Ages stay Float32 — they're whole-number-ish.
  let positionsWorld = new Float64Array(2 * particleCount);
  // Previous-frame position (mercator-world). The segment renderer draws
  // prev->cur as one continuous quad, so trails never gap regardless of
  // speed. Kept in lockstep with positionsWorld: seeded equal (zero-length
  // first segment) and shifted by the same ±1 as cur on antimeridian wrap
  // so the drawn segment stays short.
  let prevPositionsWorld = new Float64Array(2 * particleCount);
  let ages = new Float32Array(particleCount);
  // Per-particle current speed in m/s. Initialised to 0 (calm); updated
  // each frame as the particle samples its u/v. Indexes the palette LUT
  // when colour-by-speed is enabled.
  let speeds = new Float32Array(particleCount);

  // Seed region — restricts where new particles get placed. The
  // canonical [0, 1]² is used until the first render fills in the
  // actual viewport. After every frame, render() updates this from
  // `latestSnapshot`, so per-particle recycles AND the bulk
  // reseed-on-settle below both put particles where the user can see
  // them (instead of scattered across the whole canonical world).
  //
  // X handles world-copy wrap: if `wrap` is true the visible canonical
  // range is `[xMin, 1] ∪ [0, xMax]` (the viewport straddles the
  // antimeridian in some world copy). When the full world is visible
  // we set `xMin = 0, xMax = 1, wrap = false`.
  type SeedRegion = { xMin: number; xMax: number; wrap: boolean; yMin: number; yMax: number };
  let seedRegion: SeedRegion = { xMin: 0, xMax: 1, wrap: false, yMin: 0, yMax: 1 };

  function randomSeedPos(): [number, number] {
    let x: number;
    if (!seedRegion.wrap) {
      x = seedRegion.xMin + Math.random() * (seedRegion.xMax - seedRegion.xMin);
    } else {
      // Wrapped: pick proportional to each segment's length.
      const lo = 1 - seedRegion.xMin;
      const hi = seedRegion.xMax;
      const r = Math.random() * (lo + hi);
      x = r < lo ? seedRegion.xMin + r : r - lo;
    }
    const y = seedRegion.yMin + Math.random() * (seedRegion.yMax - seedRegion.yMin);
    return [x, y];
  }

  function seedParticle(i: number): void {
    const [x, y] = randomSeedPos();
    positionsWorld[2 * i] = x;
    positionsWorld[2 * i + 1] = y;
    prevPositionsWorld[2 * i] = x;     // zero-length first segment
    prevPositionsWorld[2 * i + 1] = y;
    // Spread initial ages so particles don't all recycle on the same frame.
    ages[i] = Math.random() * maxAge;
  }
  for (let i = 0; i < particleCount; i++) seedParticle(i);

  /** Update `seedRegion` from the current view so that any subsequent
   *  recycle / reseed places particles where they can actually be seen.
   *  The region is expanded by `SEED_MARGIN` of the viewport size on
   *  each side so newly seeded particles have a buffer of "lead time"
   *  to drift into view — without that, a steady southwesterly wind
   *  would leave visible particle-starved bands along the top + right
   *  edges of the viewport (where new particles are needed but none
   *  have been seeded outside the visible bounds yet). */
  const SEED_MARGIN = 0.2;
  function updateSeedRegionFromView(v: LatestView): void {
    const [W, H] = v.size;
    const halfW = (W / 2) * (1 + 2 * SEED_MARGIN);
    const halfH = (H / 2) * (1 + 2 * SEED_MARGIN);
    const tlX = v.cx - halfW * v.resolution;
    const tlY = v.cy + halfH * v.resolution;
    const brX = v.cx + halfW * v.resolution;
    const brY = v.cy - halfH * v.resolution;

    const xMinRaw = (tlX + HALF_MERCATOR) / WORLD_EXT_3857;
    const xMaxRaw = (brX + HALF_MERCATOR) / WORLD_EXT_3857;
    const yMinRaw = (HALF_MERCATOR - tlY) / WORLD_EXT_3857;
    const yMaxRaw = (HALF_MERCATOR - brY) / WORLD_EXT_3857;

    // Y is clamped to the canonical [0, 1] (pixels above/below the
    // mercator clip aren't on any data tile). If the viewport is
    // entirely outside the clip, fall back to the full canonical Y
    // so seeding still has somewhere to put particles.
    const yMin = Math.max(0, Math.min(1, yMinRaw));
    const yMax = Math.max(0, Math.min(1, yMaxRaw));
    seedRegion.yMin = (yMax > yMin) ? yMin : 0;
    seedRegion.yMax = (yMax > yMin) ? yMax : 1;

    // X handles world-copy wrap. If the raw range spans >= 1 the user
    // can see at least one full world copy, so any X works. Otherwise
    // map to a canonical [0, 1] band, with wrap if the band straddles
    // the antimeridian.
    if (xMaxRaw - xMinRaw >= 1) {
      seedRegion.xMin = 0;
      seedRegion.xMax = 1;
      seedRegion.wrap = false;
    } else {
      const xMinMod = ((xMinRaw % 1) + 1) % 1;
      const xMaxMod = ((xMaxRaw % 1) + 1) % 1;
      seedRegion.xMin = xMinMod;
      seedRegion.xMax = xMaxMod;
      seedRegion.wrap = xMinMod > xMaxMod;
    }
  }

  function clearTrailFbos(w: number, h: number): void {
    for (const fbo of [fboCurr, fboPrev]) {
      if (!fbo) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  const MAX_COPIES = 8;
  // Interleaved (prevX, prevY, curX, curY, speed_t) per INSTANCE — 5
  // floats. Each particle is replicated per visible world copy (up to
  // MAX_COPIES); the static 6-vertex corner buffer expands each instance
  // into a screen-space segment quad.
  const INSTANCE_FLOATS = 5;
  let pixelBuf = new Float32Array(INSTANCE_FLOATS * particleCount * MAX_COPIES);

  const cache = new Map<string, TileCacheEntry>();

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.pointerEvents = 'none';
  const gl0 = canvas.getContext('webgl2', {
    premultipliedAlpha: false,
    antialias: false,
  });
  if (!gl0) {
    throw new Error('@mercator-blue/sdk/openlayers: WebGL2 unavailable');
  }
  const gl: WebGL2RenderingContext = gl0;

  const program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  const aPrev = gl.getAttribLocation(program, 'a_prev');
  const aCur = gl.getAttribLocation(program, 'a_cur');
  const aSpeedT = gl.getAttribLocation(program, 'a_speed_t');
  const aCorner = gl.getAttribLocation(program, 'a_corner');
  const uSize = gl.getUniformLocation(program, 'u_size');
  const uPointSize = gl.getUniformLocation(program, 'u_point_size');
  const uColorBySpeed = gl.getUniformLocation(program, 'u_color_by_speed');
  const uPalette = gl.getUniformLocation(program, 'u_palette');

  const vbo = gl.createBuffer();
  if (!vbo) throw new Error('@mercator-blue/sdk/openlayers: streamlines — gl.createBuffer returned null');

  // Static per-vertex corner buffer: the two triangles of a unit quad,
  // each vertex carrying (end, side) — end 0=prev / 1=cur endpoint, side
  // -1/+1 across the width. The instanced draw expands these against each
  // particle's prev/cur into a screen-space segment quad.
  const cornerVbo = gl.createBuffer();
  if (!cornerVbo) throw new Error('@mercator-blue/sdk/openlayers: streamlines — gl.createBuffer (corner) returned null');
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, -1,   0, 1,   1, -1,
    1, -1,   0, 1,   1, 1,
  ]), gl.STATIC_DRAW);

  // Fade pass: full-screen quad reading the previous trail texture.
  const fadeProgram = createProgram(gl, QUAD_VS, FADE_FS);
  const aQuadPos = gl.getAttribLocation(fadeProgram, 'a_pos');
  const uFadePrev = gl.getUniformLocation(fadeProgram, 'u_prev');
  const uFadeFactor = gl.getUniformLocation(fadeProgram, 'u_fade');
  const quadVbo = gl.createBuffer();
  if (!quadVbo) throw new Error('@mercator-blue/sdk/openlayers: streamlines — gl.createBuffer (quad) returned null');
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  // Ping-pong trail FBOs. `curr` is what we render INTO this frame
  // (fade pass writes faded `prev` into `curr`; particle pass draws on
  // top); `prev` is last frame's output, sampled by the fade pass. We
  // swap at the end of each frame.
  let trailW = 0, trailH = 0;
  let texCurr: WebGLTexture | null = null;
  let texPrev: WebGLTexture | null = null;
  let fboCurr: WebGLFramebuffer | null = null;
  let fboPrev: WebGLFramebuffer | null = null;

  function ensureTrailFbos(w: number, h: number): void {
    if (trailW === w && trailH === h && texCurr && texPrev) return;
    if (texCurr) gl.deleteTexture(texCurr);
    if (texPrev) gl.deleteTexture(texPrev);
    if (fboCurr) gl.deleteFramebuffer(fboCurr);
    if (fboPrev) gl.deleteFramebuffer(fboPrev);
    const makeTex = (): WebGLTexture => {
      const t = gl.createTexture();
      if (!t) throw new Error('@mercator-blue/sdk/openlayers: streamlines — gl.createTexture returned null');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const makeFbo = (tex: WebGLTexture): WebGLFramebuffer => {
      const f = gl.createFramebuffer();
      if (!f) throw new Error('@mercator-blue/sdk/openlayers: streamlines — gl.createFramebuffer returned null');
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return f;
    };
    texCurr = makeTex();
    texPrev = makeTex();
    fboCurr = makeFbo(texCurr);
    fboPrev = makeFbo(texPrev);
    // Clear both to transparent so the first frame's fade pass reads
    // zero instead of uninitialised driver garbage.
    for (const fbo of [fboCurr, fboPrev]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    trailW = w;
    trailH = h;
  }

  let layer: Layer | null = null;
  let rafHandle: number | null = null;

  // Camera-move tracking. We diff (zoom, centerX, centerY) frame-to-frame:
  //   - While moving → clear both trail FBOs every frame so old trails
  //     don't smear across the basemap.
  //   - On the first stable frame after motion → clear once more AND
  //     reseed all particles into the new visible viewport. Without the
  //     reseed, zooming in leaves the global [0,1]² particle scatter
  //     sparsely visible; with it, the user always sees ~particleCount
  //     particles in their actual view.
  // CLAUDE.md describes this same pattern for the Mapbox/Leaflet
  // bindings; the trigger is per-frame state diff, not OL events
  // (events lag the actual camera by hundreds of ms).
  let lastFrameCx = NaN;
  let lastFrameCy = NaN;
  let lastFrameZoom = NaN;
  let wasMoving = false;
  // The latest view captured in render(), used to update `seedRegion`
  // and to drive the camera-move logic above.
  type LatestView = { cx: number; cy: number; zoom: number; resolution: number; size: [number, number] };
  let latestView: LatestView | null = null;

  function ensureTile(z: number, wrappedTx: number, ty: number): LoadedTile | null {
    const key = `${z}/${wrappedTx}/${ty}`;
    const existing = cache.get(key);
    if (existing) {
      if (existing.status === 'loaded') return existing;
      if (existing.status === 'loading') return null;
      // 'error' — fall through and retry below.
    }
    const promise = (async (): Promise<LoadedTile> => {
      const url = expandTileUrl(tileUrlTemplate, z, wrappedTx, ty);
      const maskUrl = landmaskUrlTemplate
        ? expandTileUrl(landmaskUrlTemplate, z, wrappedTx, ty)
        : null;
      const [dataPx, maskPx] = await Promise.all([
        loadTilePixels(url),
        maskUrl ? loadTilePixels(maskUrl).catch(() => null) : Promise.resolve(null),
      ]);
      const { width: W, height: H, pixels: data } = dataPx;
      const u = new Float32Array(W * H);
      const v = new Float32Array(W * H);
      const sc = item.encoding.scale, off = item.encoding.offset;
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
      const loaded: LoadedTile = { status: 'loaded', u, v, W, H };
      cache.set(key, loaded);
      // Don't call layer.changed() here — we're already in a continuous
      // rAF loop, so the next frame picks up the new tile naturally.
      return loaded;
    })();
    cache.set(key, { status: 'loading', promise });
    promise.catch(() => cache.set(key, { status: 'error' }));
    return null;
  }

  /** Bilinear-sample u, v at a mercator-world `(x, y) ∈ [0, 1]²` position
   *  via the current view zoom's data tile. Three return shapes:
   *    - `null`            — tile not loaded yet; caller should HOLD.
   *    - `[NaN, NaN]`      — tile loaded but value is NaN (land / no-data /
   *                          outside mercator clip); caller should RECYCLE.
   *    - `[u, v]` (finite) — valid velocity in m/s; caller should ADVANCE.
   */
  function sampleAt(x: number, y: number, zData: number): [number, number] | null {
    const nData = 2 ** zData;
    const dataPxX = x * nData * 256;
    const dataPxY = y * nData * 256;
    const txData = Math.floor(dataPxX / 256);
    const tyData = Math.floor(dataPxY / 256);
    if (tyData < 0 || tyData >= nData) return [NaN, NaN];
    const wrappedTxData = ((txData % nData) + nData) % nData;
    const tile = ensureTile(zData, wrappedTxData, tyData);
    if (!tile) return null;
    const fx = dataPxX - txData * 256;
    const fy = dataPxY - tyData * 256;
    const x0 = Math.max(0, Math.min(tile.W - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(tile.H - 1, Math.floor(fy)));
    const x1 = Math.min(tile.W - 1, x0 + 1);
    const y1 = Math.min(tile.H - 1, y0 + 1);
    const ax = Math.max(0, Math.min(1, fx - x0));
    const ay = Math.max(0, Math.min(1, fy - y0));
    const w00 = (1 - ax) * (1 - ay);
    const w01 = ax * (1 - ay);
    const w10 = (1 - ax) * ay;
    const w11 = ax * ay;
    const i00 = y0 * tile.W + x0;
    const i01 = y0 * tile.W + x1;
    const i10 = y1 * tile.W + x0;
    const i11 = y1 * tile.W + x1;
    const u00 = tile.u[i00], u01 = tile.u[i01], u10 = tile.u[i10], u11 = tile.u[i11];
    const v00 = tile.v[i00], v01 = tile.v[i01], v10 = tile.v[i10], v11 = tile.v[i11];
    if (!Number.isFinite(u00) || !Number.isFinite(u01)
        || !Number.isFinite(u10) || !Number.isFinite(u11)) return [NaN, NaN];
    const u = u00 * w00 + u01 * w01 + u10 * w10 + u11 * w11;
    const v = v00 * w00 + v01 * w01 + v10 * w10 + v11 * w11;
    return [u, v];
  }

  /** Recycle particle `i` to a fresh random position. Retries up to
   *  `maxAttempts` times to land on a sample with a valid velocity —
   *  prevents seeding particles on land in landmask-filtered datasets
   *  (currents) where they'd otherwise sit motionless until age-out.
   *
   *  Each attempt that hits a `null` sample (tile not loaded yet) is
   *  ACCEPTED — the particle will be re-sampled next frame and recycled
   *  again then if it turns out to be land. This avoids tight loops at
   *  layer-init time before any tiles have arrived.
   *
   *  If all attempts hit land, the last random position is accepted; the
   *  particle just recycles again next frame. */
  function recycleParticle(i: number, zData: number): void {
    const MAX_ATTEMPTS = 8;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const [x, y] = randomSeedPos();
      const sample = sampleAt(x, y, zData);
      if (sample === null || Number.isFinite(sample[0])) {
        positionsWorld[2 * i] = x;
        positionsWorld[2 * i + 1] = y;
        prevPositionsWorld[2 * i] = x;     // zero-length first segment
        prevPositionsWorld[2 * i + 1] = y;
        ages[i] = Math.random() * maxAge;
        return;
      }
    }
    const [x, y] = randomSeedPos();
    positionsWorld[2 * i] = x;
    positionsWorld[2 * i + 1] = y;
    prevPositionsWorld[2 * i] = x;
    prevPositionsWorld[2 * i + 1] = y;
    ages[i] = Math.random() * maxAge;
  }

  function render(frameState: FrameState): HTMLElement {
    const [W, H] = frameState.size;
    const dpr = frameState.pixelRatio;
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    // Capture the latest view so seed/recycle pick positions inside the
    // user's actual viewport; update seedRegion before any sim work that
    // might recycle particles.
    const viewZoom = frameState.viewState.zoom;
    const viewCx = frameState.viewState.center[0];
    const viewCy = frameState.viewState.center[1];
    latestView = {
      cx: viewCx,
      cy: viewCy,
      zoom: viewZoom,
      resolution: frameState.viewState.resolution,
      size: [W, H],
    };
    updateSeedRegionFromView(latestView);

    // ---- Camera-move detection ----
    // Exact equality is fine because OL only mutates view state on user
    // interaction (mouse / wheel / programmatic animate); between
    // interactions our rAF tick reads identical values frame after frame.
    const moving = viewCx !== lastFrameCx || viewCy !== lastFrameCy || viewZoom !== lastFrameZoom;
    const justSettled = !moving && wasMoving;
    lastFrameCx = viewCx;
    lastFrameCy = viewCy;
    lastFrameZoom = viewZoom;
    wasMoving = moving;

    const zData = Math.max(0, Math.min(maxzoom, Math.floor(viewZoom)));

    // Reseed all particles before the per-frame advance so this frame
    // already draws them in their new positions (rather than one frame
    // later). The trail-FBO clear happens just below in step 3.
    if (justSettled) {
      for (let i = 0; i < particleCount; i++) recycleParticle(i, zData);
    }

    // Per-frame advance is scaled by 0.5^zoom so the pixel-speed is
    // CONSTANT across zoom (step_px = speedScale·v·0.5^z · 256·2^z =
    // speedScale·v·256 — the 2^z cancels). This matches the
    // Mapbox/Leaflet/deck.gl bindings. (Earlier this layer leaned on the
    // per-frame max cap to bound speed, which masked the missing zoom
    // factor; with the cap removed the unnormalised step ran ~2× faster
    // per zoom level — visibly far too fast, straight lines, static gyres.)
    const effScale = speedScale * Math.pow(0.5, viewZoom);

    // Per-frame step FLOOR (no max cap — segment quads keep trails
    // continuous at any speed, so the old "polka-dot" max cap is gone).
    // The floor keeps near-calm particles drifting visibly instead of
    // freezing and popping out; genuine zero stays put. Measured in
    // device pixels (uniform px-per-world on flat Mercator), matching the
    // Mapbox/Leaflet bindings.
    const cssPerWorld = 256 * Math.pow(2, viewZoom);
    const devPerWorld = cssPerWorld * dpr;
    const minStepWorld = MIN_STEP_PIXELS / Math.max(1e-9, devPerWorld);

    // ---- Step 1: advance the simulation by one frame ----
    for (let i = 0; i < particleCount; i++) {
      let xWorld = positionsWorld[2 * i];
      let yWorld = positionsWorld[2 * i + 1];
      const age = ages[i];

      if (age >= maxAge) {
        recycleParticle(i, zData);
        continue;
      }

      const sample = sampleAt(xWorld, yWorld, zData);
      if (sample === null) {
        // Tile pending — hold position, age. Once the tile loads the
        // next frame will sample it and either advance or recycle.
        ages[i] = age + 1;
        continue;
      }
      const u = sample[0];
      const v = sample[1];
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        // Land / no-data — recycle to a valid spot immediately rather
        // than holding here for `maxAge` frames as a stuck dot.
        recycleParticle(i, zData);
        continue;
      }

      // Track the particle's TRUE speed for colour-by-speed (from the raw
      // bilinear sample, untouched by the step floor below).
      speeds[i] = Math.sqrt(u * u + v * v);

      // Save the pre-advance position as the segment's prev endpoint.
      prevPositionsWorld[2 * i] = xWorld;
      prevPositionsWorld[2 * i + 1] = yWorld;

      // Advance. u is east (positive +x_world), v is north (positive
      // means -y_world because mercator-world Y increases southward).
      // effScale folds in the 0.5^zoom normalisation. Floor the step
      // (preserving direction) so slow particles still drift; genuine
      // zero stays put.
      let dxWorld = u * effScale;
      let dyWorld = -v * effScale;
      const stepWorld = Math.hypot(dxWorld, dyWorld);
      if (stepWorld > 0 && stepWorld < minStepWorld) {
        const f = minStepWorld / stepWorld;
        dxWorld *= f;
        dyWorld *= f;
      }
      xWorld += dxWorld;
      yWorld += dyWorld;

      if (yWorld < 0 || yWorld > 1) {
        recycleParticle(i, zData);
        continue;
      }
      // Antimeridian wrap: shift prev by the SAME ±1 as cur so the drawn
      // segment stays short instead of stretching across the whole world.
      if (xWorld < 0) { xWorld += 1; prevPositionsWorld[2 * i] += 1; }
      else if (xWorld >= 1) { xWorld -= 1; prevPositionsWorld[2 * i] -= 1; }

      positionsWorld[2 * i] = xWorld;
      positionsWorld[2 * i + 1] = yWorld;
      ages[i] = age + 1;
    }

    // ---- Step 2: project to CSS pixels (replicated across world copies) ----
    const tl3857: [number, number] = [0, 0];
    applyTransform(frameState.pixelToCoordinateTransform, tl3857);
    const br3857: [number, number] = [W, H];
    applyTransform(frameState.pixelToCoordinateTransform, br3857);
    const copyLo = Math.floor((tl3857[0] + HALF_MERCATOR) / WORLD_EXT_3857);
    const copyHi = Math.floor((br3857[0] + HALF_MERCATOR) / WORLD_EXT_3857);
    const requestedCopies = copyHi - copyLo + 1;
    const numCopies = Math.max(1, Math.min(MAX_COPIES, requestedCopies));

    let outIdx = 0;
    const invSpeedRef = 1 / Math.max(1e-6, speedRef);
    for (let c = 0; c < numCopies; c++) {
      const copy = copyLo + c;
      const xOff = copy * WORLD_EXT_3857;
      for (let i = 0; i < particleCount; i++) {
        const curXW = positionsWorld[2 * i];
        const curYW = positionsWorld[2 * i + 1];
        const prevXW = prevPositionsWorld[2 * i];
        const prevYW = prevPositionsWorld[2 * i + 1];
        // Project both endpoints to CSS pixels in this world copy.
        const curPx: [number, number] = [
          curXW * WORLD_EXT_3857 - HALF_MERCATOR + xOff,
          HALF_MERCATOR - curYW * WORLD_EXT_3857,
        ];
        applyTransform(frameState.coordinateToPixelTransform, curPx);
        const prevPx: [number, number] = [
          prevXW * WORLD_EXT_3857 - HALF_MERCATOR + xOff,
          HALF_MERCATOR - prevYW * WORLD_EXT_3857,
        ];
        applyTransform(frameState.coordinateToPixelTransform, prevPx);
        const o = INSTANCE_FLOATS * outIdx;
        pixelBuf[o]     = prevPx[0];
        pixelBuf[o + 1] = prevPx[1];
        pixelBuf[o + 2] = curPx[0];
        pixelBuf[o + 3] = curPx[1];
        // Normalised speed for palette lookup. Clamping happens in the
        // shader (clamp() on the texture coord), so out-of-range is fine.
        pixelBuf[o + 4] = speeds[i] * invSpeedRef;
        outIdx++;
      }
    }

    // ---- Step 3: ping-pong trail FBO render ----
    // Trail buffer sized to backing-store pixels so particles + trails
    // rasterise at native DPR resolution; recreates on canvas resize.
    ensureTrailFbos(bw, bh);

    // Camera-move trail handling: wipe trails while moving AND on the
    // first stable frame so the just-reseeded particles start from a
    // clean slate. (The reseed itself fired before Step 1 above so this
    // frame's draw is already at the new positions.)
    if (moving || justSettled) clearTrailFbos(bw, bh);

    // 3a: fade pass — read texPrev, write faded copy into fboCurr.
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboCurr);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.useProgram(fadeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texPrev);
    gl.uniform1i(uFadePrev, 0);
    gl.uniform1f(uFadeFactor, fade);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.enableVertexAttribArray(aQuadPos);
    gl.vertexAttribPointer(aQuadPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3b: particle pass — draw POINTS into fboCurr, additive blending
    // (matches the Mapbox/Leaflet bindings — overlapping particles
    // brighten toward white, isolated ones replace the fade since their
    // alpha=1 saturates the destination).
    if (paletteDirty || !paletteTexture) {
      paletteTexture = uploadColormapTexture(gl, paletteData, paletteTexture);
      paletteDirty = false;
    }
    gl.useProgram(program);
    gl.uniform2f(uSize, W, H);
    gl.uniform1f(uPointSize, pointSize);
    gl.uniform1f(uColorBySpeed, colorBySpeed ? 1 : 0);
    // Sampler unit 0: palette LUT. (The fade pass uses unit 0 too for
    // its prev-texture sampling, but each pass rebinds before drawing,
    // so there's no cross-program conflict.)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
    gl.uniform1i(uPalette, 0);

    // Per-instance attributes (divisor 1): prev (vec2), cur (vec2), speed_t.
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, pixelBuf.subarray(0, INSTANCE_FLOATS * outIdx), gl.STREAM_DRAW);
    const stride = INSTANCE_FLOATS * 4; // 5 floats × 4 bytes
    gl.enableVertexAttribArray(aPrev);
    gl.vertexAttribPointer(aPrev, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(aPrev, 1);
    gl.enableVertexAttribArray(aCur);
    gl.vertexAttribPointer(aCur, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(aCur, 1);
    gl.enableVertexAttribArray(aSpeedT);
    gl.vertexAttribPointer(aSpeedT, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(aSpeedT, 1);

    // Per-vertex corner (end, side) — divisor 0 (advances per vertex).
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerVbo);
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(aCorner, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, outIdx);
    // Reset per-instance divisors immediately so the next frame's fade
    // pass (plain divisor-0 quad) isn't corrupted on this context's VAO.
    gl.vertexAttribDivisor(aPrev, 0);
    gl.vertexAttribDivisor(aCur, 0);
    gl.vertexAttribDivisor(aSpeedT, 0);

    // 3c: blit fboCurr → canvas. blitFramebuffer copies pixels
    // verbatim (no blending); the canvas's own alpha then composites
    // it over the basemap via the browser's normal canvas compositor.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboCurr);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, bw, bh, 0, 0, bw, bh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // 3d: swap ping-pong so next frame's fade reads what we just wrote.
    const tmpFbo = fboCurr; fboCurr = fboPrev; fboPrev = tmpFbo;
    const tmpTex = texCurr; texCurr = texPrev; texPrev = tmpTex;

    // ---- Step 4: schedule the next animation frame ----
    // layer.changed() dispatches an OL change event which the map listens
    // to → next animation tick OL calls our render() again. The rAF
    // callback checks `getMapInternal()` to self-terminate when the layer
    // has been removed; re-attaching restarts the loop naturally because
    // OL's first render call after the new map binding kicks it off.
    if (rafHandle != null) cancelAnimationFrame(rafHandle);
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      if (layer && layer.getMapInternal()) layer.changed();
    });

    return canvas;
  }

  layer = new Layer({
    zIndex: opts.zIndex ?? 650,
    render,
  });

  // Public runtime setters. setPointSize / setSpeedScale / setMaxAge are
  // uniform-only or scalar-only; setParticleCount preserves existing
  // positions when growing and truncates when shrinking, so adjusting
  // the count slider doesn't discard in-flight particle state.
  const l = layer as Layer & {
    setPointSize: (n: number) => void;
    setParticleCount: (n: number) => void;
    setSpeedScale: (n: number) => void;
    setMaxAge: (n: number) => void;
    setFade: (n: number) => void;
    setColorBySpeed: (b: boolean) => void;
    setColormap: (s: ColormapSpec) => void;
    setSpeedRef: (n: number) => void;
  };
  l.setPointSize = (n: number) => { pointSize = n; };
  l.setSpeedScale = (n: number) => { speedScale = n; };
  l.setMaxAge = (n: number) => { maxAge = n; };
  l.setFade = (n: number) => { fade = n; };
  l.setColorBySpeed = (b: boolean) => { colorBySpeed = b; };
  l.setSpeedRef = (n: number) => { speedRef = n; };
  l.setColormap = (s: ColormapSpec) => {
    paletteData = resolveColormap(s);
    paletteDirty = true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (l as any).applyOptions = (p: any) => {
    if (p.opacity != null) layer.setOpacity(p.opacity);
    if (p.pointSize != null) l.setPointSize(p.pointSize);
    if (p.speedScale != null) l.setSpeedScale(p.speedScale);
    if (p.maxAge != null) l.setMaxAge(p.maxAge);
    if (p.fade != null) l.setFade(p.fade);
    if (p.colorBySpeed != null) l.setColorBySpeed(p.colorBySpeed);
    if (p.colormap != null) l.setColormap(p.colormap);
    if (p.particleCount != null) l.setParticleCount(p.particleCount);
    if (p.speedRef != null) l.setSpeedRef(p.speedRef);
  };
  l.setParticleCount = (n: number) => {
    if (n === particleCount) return;
    const grownPos = new Float64Array(2 * n);
    const grownPrev = new Float64Array(2 * n);
    const grownAge = new Float32Array(n);
    const grownSpeed = new Float32Array(n);
    const copy = Math.min(n, particleCount);
    grownPos.set(positionsWorld.subarray(0, 2 * copy));
    grownPrev.set(prevPositionsWorld.subarray(0, 2 * copy));
    grownAge.set(ages.subarray(0, copy));
    grownSpeed.set(speeds.subarray(0, copy));
    for (let i = particleCount; i < n; i++) {
      const [x, y] = randomSeedPos();
      grownPos[2 * i] = x;
      grownPos[2 * i + 1] = y;
      grownPrev[2 * i] = x;       // zero-length first segment
      grownPrev[2 * i + 1] = y;
      grownAge[i] = Math.random() * maxAge;
      // grownSpeed[i] stays 0; first valid sample will fill it in.
    }
    positionsWorld = grownPos;
    prevPositionsWorld = grownPrev;
    ages = grownAge;
    speeds = grownSpeed;
    particleCount = n;
    pixelBuf = new Float32Array(INSTANCE_FLOATS * n * MAX_COPIES);
  };
  return layer;
}

function fromItem(opts: MercatorStreamlinesLayerOpts, item: DiscoveredItem): Layer {
  return buildLayer(opts, item);
}

async function create(opts: MercatorStreamlinesLayerOpts): Promise<Layer> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorStreamlinesLayer = { create, fromItem };
