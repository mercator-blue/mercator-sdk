/**
 * MapLibre custom layer that animates flow particles over a value-encoded
 * `vector_rg_ba` tile pyramid (wind, currents, …). Particles are advected
 * per-frame by the sampled u/v field, drawn into a ping-pong FBO trail
 * buffer that fades each frame, and composited over the basemap with
 * premultiplied alpha.
 *
 * Ported from viewer/index.html. Designed to sit *on top of* the decoded
 * raster layer for the same dataset — the raster provides the colored
 * backdrop, this provides motion.
 */

import { createProgram } from '../core/webgl-helpers';
import { posMod } from '../core/mercator';
import { loadTilePixels } from '../core/tile-pixel-reader';
import { resolveColormap } from '../core/color/colormaps';
import { uploadColormapTexture } from '../core/color/colormap-texture';
import type { ColormapSpec } from '../core/types';
import { expandTileUrl } from '../core/urls';
import {
  normalizeRenderArgs,
  type NormalisedRenderArgs,
  type VecLike,
  type Mat4Like,
} from './host-adapter';

// GLSL is in standalone .vert/.frag files for syntax highlighting and
// easier editing; the shader barrel inlines each as a string constant
// via the tsup text loader (see ./shaders/index.ts). The points pass
// is GLSL 3.00 ES (needs the MapLibre prelude for the GLOBE branch);
// the quad/fade/composite pair is GLSL 1.00 ES and uses
// `attribute`/`varying`/`gl_FragColor`/`texture2D` without a
// `#version` line.
import {
  POINTS_VS,
  POINTS_FS,
  SIM_VS,
  SIM_FS,
  QUAD_VS,
  FADE_FS,
  COMPOSITE_FS,
} from './shaders/index.js';

function buildPointsProgram(
  gl: WebGL2RenderingContext,
  shaderData: NormalisedRenderArgs['shaderData'],
  gpuSim: boolean,
): WebGLProgram {
  const prelude = shaderData?.vertexShaderPrelude ?? '';
  const define = shaderData?.define ?? '';
  // GPU_SIM swaps the per-instance prev/cur/speed attributes for texelFetch
  // reads of the ping-pong position textures (see streamlines-points.vert).
  const gpuDefine = gpuSim ? '#define GPU_SIM' : '';
  const vsSource = `#version 300 es\n${prelude}\n${define}\n${gpuDefine}\n${POINTS_VS}`;
  const fsSource = `#version 300 es\n${POINTS_FS}`;
  return createProgram(gl, vsSource, fsSource);
}

// Resolution of the per-view velocity texture the GPU sim samples. Assembled
// on the CPU from the loaded tiles on each viewport change (not per frame), so
// this is the cost knob for that rebuild: 512² ≈ a quarter-million sampleWind
// calls, roughly matching the visible data resolution at the datasets' z5
// ceiling. Bump toward 1024 if the flow looks blocky; drop if pan-settle
// hitches.
const VEL_TEX_SIZE = 512;

export interface StreamlinesLayerOpts {
  /** MapLibre/Mapbox layer id. */
  id: string;
  /** PNG tile URL template with `{z}/{x}/{y}` placeholders. */
  tileUrlTemplate: string;
  /** Value-encoding params for the underlying vector_rg_ba pyramid. */
  encoding: { scale: number; offset: number };
  /** Data pyramid maxzoom. Default 5. */
  maxzoom?: number;
  /** Active particle count. Default 8000. */
  particleCount?: number;
  /** Particle dot size in CSS pixels. Default 3. */
  pointSize?: number;
  /** Per-frame advection: mercator-units per (m/s) at z=0. Default 6e-5. */
  speedScale?: number;
  /** Frames before a particle is forcibly recycled. Default 600. */
  maxAge?: number;
  /** Trail-buffer fade per frame (closer to 1 = longer trails). Default 0.99. */
  fade?: number;
  /** Map particle colour to speed via the layer's colormap. Default true. */
  colorBySpeed?: boolean;
  /** Colormap preset name or explicit stops used when `colorBySpeed` is
   *  on. Default `viridis` (or the dataset's STAC colormap when built
   *  through MercatorLayer). */
  colormap?: ColormapSpec;
  /** Speed (m/s) at the palette's lower stop. Default 0. */
  vmin?: number;
  /** Speed (m/s) at the palette's upper stop. Default 40. */
  vmax?: number;
  /** Overall layer opacity (0..1). Default 0.85. */
  opacity?: number;
  /** If set, fetch landmask tiles independently of data tiles (at
   *  landmaskMaxZ resolution) and discard particles whose mask byte
   *  isn't in `landmaskAccepts`. Decoupling data and landmask zoom
   *  lets the coastline stay sharp past the data's own resolution
   *  ceiling — e.g. a z=8 landmask tile gives 2.7 km mask resolution
   *  even when the underlying currents data is z=5 (22 km). */
  landmaskUrlTemplate?: string;
  /** Which landmask category bytes are valid for this dataset (e.g.
   *  `[0]` for ocean-only). */
  landmaskAccepts?: number[];
  /** Highest zoom level the landmask pyramid is built for. Defaults
   *  to `maxzoom` (same as data) — callers without a landmask STAC
   *  entry get the previous shared-zoom behaviour. */
  landmaskMaxZ?: number;
  /** Mapbox GL JS v3 Standard slot. Ignored on Mapbox classic + MapLibre. */
  slot?: string;
  /** Run the particle simulation on the GPU (texture GPGPU) instead of the
   *  CPU loop. Default true. Set false to fall back to the CPU sim (kept for
   *  A/B comparison during bring-up). */
  gpuSim?: boolean;
  /** Render the trail buffer at this fraction of device resolution (0.1..1).
   *  Default 1. The trail fade + composite are full-canvas passes whose cost
   *  scales with pixel count; 0.5 quarters that at the cost of slightly softer
   *  trails. Particle motion and on-screen line width are unaffected. */
  trailResolutionScale?: number;
}

// --- Tile cache shapes -------------------------------------------------
// Entries are REPLACED wholesale (not mutated in place) — see loadTile/
// loadMaskTile below. That makes a discriminated union safe: `status ===
// 'loaded'` narrows the entry to the variant carrying u/v/W/H or mask.

type DataTile =
  | { status: 'loading' }
  | { status: 'loaded'; u: Float32Array; v: Float32Array; W: number; H: number }
  | { status: 'error' };

type MaskTile =
  | { status: 'loading' }
  | { status: 'loaded'; mask: Uint8Array; W: number; H: number }
  | { status: 'error' };

interface Viewport {
  mxMin: number;
  mxMax: number;
  myMin: number;
  myMax: number;
}

interface Particle {
  mx: number;
  my: number;
  /** Previous-frame position. The segment renderer draws prev→cur as one
   *  continuous quad, so trails never gap regardless of speed. Seeded equal
   *  to mx/my (a fresh particle's first segment is a zero-length dot). */
  pmx: number;
  pmy: number;
  age: number;
  /** 0 = live (in-bounds, valid sample). -1 = "dead" sentinel that culls the
   *  whole instance in the vertex shader. > 0 = computed m/s magnitude from
   *  the last sample (drives color-by-speed; NOT affected by the step clamp). */
  speed: number;
}

interface FB {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
}

// Fraction of viewport dimension to extend the particle "alive zone"
// past the visible edges. Particles seed uniformly in this padded
// bbox and recycle only when they drift past it, which keeps the
// leeward edges of a directional flow supplied with upstream
// particles instead of starving (visible as empty bands on the
// downstream side of the viewport — e.g. east + south edges when the
// prevailing flow is northwest).
//
// Trade-off: a fraction of total particles sits outside the visible
// area at any moment, so the visible density drops by ~1/(1+2*SEED_MARGIN)^2.
// The user-facing particleCount control still works to compensate.
const SEED_MARGIN = 0.2;

// Pack (z, x, y) into one integer so the per-particle tile lookups can key a
// Map<number> instead of allocating a `${z}/${x}/${y}` string per sample per
// frame (8000 particles × up to two caches × the z walk-down = a lot of
// short-lived strings + hashing). 2^14 per axis supports x,y < 16384 (z ≤ 13),
// and z·2^28 stays well inside Number.MAX_SAFE_INTEGER. Plain arithmetic, not
// bit-shifts, to avoid JS's 32-bit bitwise truncation.
const TILE_AXIS = 16384;
function tileKey(z: number, x: number, y: number): number {
  return (z * TILE_AXIS + y) * TILE_AXIS + x;
}

/**
 * State the streamlines custom WebGL layer attaches to `this` between
 * onAdd and onRemove. Methods are annotated with `this:` so TS knows
 * about these fields — see tile-boundaries-overlay.ts for the pattern.
 */
interface StreamlinesLayerThis {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map: any;
  gl: WebGL2RenderingContext;

  // Runtime-configurable knobs (mirror the opts; tweakable via set* methods).
  opacity: number;
  pointSize: number;
  N: number;
  speedScale: number;
  maxAge: number;
  fade: number;
  colorBySpeed: boolean;
  colormapData: Float32Array;
  colormapTexture: WebGLTexture | null;
  colormapDirty: boolean;
  vmin: number;
  vmax: number;

  // Tile caches + simulation state.
  tiles: Map<number, DataTile>;
  maskTiles: Map<number, MaskTile>;
  particles: Particle[];
  viewport: Viewport | null;
  targetZ: number;
  maskTargetZ: number;

  // Trail-buffer FBOs (ping-ponged each frame).
  fbA: FB | null;
  fbB: FB | null;
  fbW: number;
  fbH: number;
  trailScale: number;

  // GPU programs + locations.
  pointsProgram: WebGLProgram | null;
  pointsProgramVariant: string | null;
  fadeProgram: WebGLProgram;
  compositeProgram: WebGLProgram;

  pointsAttrPrev: GLint;
  pointsAttrCur: GLint;
  pointsAttrSpeed: GLint;
  pointsAttrCorner: GLint;
  pointsUOrigin: WebGLUniformLocation | null;
  pointsUOriginClip: WebGLUniformLocation | null;
  pointsUOpacity: WebGLUniformLocation | null;
  pointsUViewport: WebGLUniformLocation | null;
  pointsULineWidth: WebGLUniformLocation | null;
  pointsUVmin: WebGLUniformLocation | null;
  pointsUVmax: WebGLUniformLocation | null;
  pointsUColorBySpeed: WebGLUniformLocation | null;
  pointsUColormap: WebGLUniformLocation | null;
  pointsUProjMatrix: WebGLUniformLocation | null;
  pointsUProjTileCoords: WebGLUniformLocation | null;
  pointsUProjClipping: WebGLUniformLocation | null;
  pointsUProjTransition: WebGLUniformLocation | null;
  pointsUProjFallback: WebGLUniformLocation | null;
  pointsUMapboxGlobeToMercator: WebGLUniformLocation | null;
  pointsUMapboxGlobeTransition: WebGLUniformLocation | null;
  pointsUMapboxCenterMercator: WebGLUniformLocation | null;

  fadeAttrPos: GLint;
  fadeUTex: WebGLUniformLocation | null;
  fadeUFade: WebGLUniformLocation | null;

  compositeAttrPos: GLint;
  compositeUTex: WebGLUniformLocation | null;
  compositeUOpacity: WebGLUniformLocation | null;

  // CPU-side per-instance buffer (5 floats/particle: prevDx, prevDy, curDx,
  // curDy, speed) + its GPU mirror, plus the static 6-vertex corner buffer
  // that the instanced draw expands into a quad.
  vertData: Float32Array;
  pointsVbo: WebGLBuffer | null;
  cornerVbo: WebGLBuffer | null;
  quadVbo: WebGLBuffer | null;
  coordOrigin?: [number, number];

  // --- GPU simulation state (gpuSim path) ---------------------------------
  // Particle positions live in a ping-pong pair of RGBA8 textures (one texel
  // per particle, viewport-local 16-bit/axis), advanced by a fragment-shader
  // pass. The velocity field is a separate RGBA8 texture assembled on the CPU
  // from loaded tiles on each viewport change. Reseeding stays on the CPU
  // (round-robin), reusing makeParticle.
  posTexA: WebGLTexture | null;
  posTexB: WebGLTexture | null;
  simFboA: WebGLFramebuffer | null;   // renders into posTexA
  simFboB: WebGLFramebuffer | null;   // renders into posTexB
  velTex: WebGLTexture | null;
  texW: number;
  texH: number;
  _posFrontIsA: boolean;              // which posTex holds the current (prev) state
  _gpuReady: boolean;                 // velTex assembled + particles seeded
  _velDirty: boolean;                 // a tile loaded; re-snapshot velTex when stable
  _seedOx: number;                    // padded seed bbox (mercator) — matches makeParticle
  _seedOy: number;
  _seedSx: number;
  _seedSy: number;
  _seedCursor: number;                // round-robin reseed pointer
  _seedStaging: Uint8Array;           // reusable scratch for reseed row writes

  simProgram: WebGLProgram | null;
  simAttrPos: GLint;
  simUPosIn: WebGLUniformLocation | null;
  simUVelTex: WebGLUniformLocation | null;
  simUVelSize: WebGLUniformLocation | null;
  simUSeedSpan: WebGLUniformLocation | null;
  simUDecScale: WebGLUniformLocation | null;
  simUDecOffset: WebGLUniformLocation | null;
  simUEff: WebGLUniformLocation | null;
  simUMinStep: WebGLUniformLocation | null;

  // GPU_SIM points-program uniform locations (null when gpuSim is off).
  pointsUPosPrev: WebGLUniformLocation | null;
  pointsUPosCur: WebGLUniformLocation | null;
  pointsUVelTexSpeed: WebGLUniformLocation | null;
  pointsUTexW: WebGLUniformLocation | null;
  pointsUSeedOrigin: WebGLUniformLocation | null;
  pointsUSeedSpan: WebGLUniformLocation | null;
  pointsUDecScale: WebGLUniformLocation | null;
  pointsUDecOffset: WebGLUniformLocation | null;

  // Camera-state tracking (replaces 'move' / 'zoomend' events).
  _prevCameraKey: string | null;
  _cameraMoving: boolean;

  // Last-frame projection state, cached so non-render methods (seed/recycle)
  // can read it without re-deriving from the host.
  _lastClippingPlane: VecLike | undefined;
  _lastProjectionTransition: number | undefined;
  _globeBboxMode?: boolean;
  // Globe-vs-mercator, cached once per frame instead of calling
  // map.getProjection() per particle in makeParticle / updateParticles.
  _isGlobe: boolean;

  // Methods.
  loadTile(z: number, x: number, y: number): Promise<void>;
  loadMaskTile(z: number, x: number, y: number): Promise<void>;
  sampleLandmask(mx: number, my: number): 'ocean' | 'land' | 'unknown';
  computeViewport(): void;
  ensureVisibleTilesLoading(): void;
  _ensureTilesAtZoom(z: number, mask: boolean): void;
  initParticles(): void;
  _projectToSphere(mx: number, my: number): [number, number, number];
  _synthesizeMapboxClippingPlane(centerInMercator: VecLike | undefined): VecLike | undefined;
  _isFrontFacing(mx: number, my: number): boolean;
  _sampleVisibleCap(): { mx: number; my: number } | null;
  makeParticle(): Particle;
  sampleWindAtZoom(mx: number, my: number, z: number): { u: number; v: number } | null;
  sampleWind(mx: number, my: number): { u: number; v: number } | null;
  inViewport(mx: number, my: number, margin?: number): boolean;
  updateParticles(): void;
  rebuildVertices(): void;
  _ensurePointsProgram(gl: WebGL2RenderingContext, normalised: NormalisedRenderArgs): void;
  _setProjectionUniforms(gl: WebGL2RenderingContext, normalised: NormalisedRenderArgs): void;
  setupFramebuffers(): void;
  makeFramebuffer(W: number, H: number): FB;
  deleteFramebuffers(): void;
  clearTrailBuffers(): void;

  // GPU-sim methods.
  setupGpuTextures(): void;
  deleteGpuTextures(): void;
  _computeSeedBbox(): void;
  _encodeSeedInto(buf: Uint8Array, off: number): void;
  assembleVelTex(): void;
  fullReseedGpu(): void;
  reseedRoundRobinGpu(): void;
  simStepGpu(gl: WebGL2RenderingContext): void;

  // Runtime setters (declared so this-typed methods can dispatch via
  // `this.setX(...)` from applyOptions).
  setOpacity(o: number): void;
  setPointSize(s: number): void;
  setTrailResolutionScale(s: number): void;
  setSpeedScale(s: number): void;
  setMaxAge(a: number): void;
  setFade(f: number): void;
  setColorBySpeed(b: boolean): void;
  setColormap(spec: ColormapSpec): void;
  setParticleCount(n: number): void;
  setVmin(v: number): void;
  setVmax(v: number): void;
}

/**
 * Build a MapLibre custom layer that animates wind particles from a vector
 * tile pyramid.
 */
// Per-frame step floor, in device pixels. Slower particles are sped up to
// this (preserving direction) so calm regions still drift visibly instead of
// sitting still and popping out; genuine zero stays zero. There is no max
// counterpart — segment quads make trails continuous at any speed.
//
// Must be a meaningful fraction of the line width (~pointSize px), not a
// hair: at 0.1 the per-frame move is ~1/30 of the mark and the trail fade
// leaves only a ~10px streak that shifts imperceptibly, so calm particles
// read as static dots that appear and vanish. ~0.5 gives a ~50px fading
// streak that clearly drifts. Tune up toward ~1 for livelier calm regions,
// down for stiller ones.
const MIN_STEP_PIXELS = 0.5;

export function createStreamlinesLayer(opts: StreamlinesLayerOpts) {
  const MAX_Z = opts.maxzoom ?? 5;
  const LANDMASK_MAX_Z = opts.landmaskMaxZ ?? MAX_Z;
  const GPU_SIM = opts.gpuSim ?? true;
  const landmaskAccepts: Set<number> | null = opts.landmaskAccepts
    ? new Set(opts.landmaskAccepts)
    : null;

  return {
    id: opts.id,
    type: 'custom' as const,
    ...(opts.slot ? { slot: opts.slot } : {}),

    onAdd(this: StreamlinesLayerThis, map: unknown, gl: WebGL2RenderingContext): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.map = map as any;
      this.gl = gl;
      this.opacity = opts.opacity ?? 0.85;
      this.pointSize = opts.pointSize ?? 3;
      this.N = opts.particleCount ?? 8000;
      this.speedScale = opts.speedScale ?? 0.00006;
      this.maxAge = opts.maxAge ?? 600;
      this.fade = opts.fade ?? 0.99;
      this.colorBySpeed = opts.colorBySpeed ?? true;
      this.colormapData = resolveColormap(opts.colormap ?? 'viridis');
      this.colormapTexture = null;
      this.colormapDirty = true;
      this.vmin = opts.vmin ?? 0;
      this.vmax = opts.vmax ?? 40;
      this.tiles = new Map();
      this.maskTiles = new Map();
      this.particles = [];
      this.viewport = null;
      this.targetZ = 0;
      this.maskTargetZ = 0;
      this.fbA = null;
      this.fbB = null;
      this.fbW = 0;
      this.fbH = 0;
      this.trailScale = opts.trailResolutionScale ?? 1;

      // Points program is compiled lazily in render() — we need MapLibre's
      // shaderData (for the projection prelude) which is only on the args.
      this.pointsProgram = null;
      this.pointsProgramVariant = null;

      this.fadeProgram = createProgram(gl, QUAD_VS, FADE_FS);
      this.fadeAttrPos = gl.getAttribLocation(this.fadeProgram, 'a_pos');
      this.fadeUTex = gl.getUniformLocation(this.fadeProgram, 'u_tex');
      this.fadeUFade = gl.getUniformLocation(this.fadeProgram, 'u_fade');

      this.compositeProgram = createProgram(gl, QUAD_VS, COMPOSITE_FS);
      this.compositeAttrPos = gl.getAttribLocation(this.compositeProgram, 'a_pos');
      this.compositeUTex = gl.getUniformLocation(this.compositeProgram, 'u_tex');
      this.compositeUOpacity = gl.getUniformLocation(this.compositeProgram, 'u_opacity');

      this.vertData = new Float32Array(this.N * 5);
      this.pointsVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.vertData.byteLength, gl.DYNAMIC_DRAW);

      // Static per-vertex corner buffer: the two triangles of a unit quad,
      // each vertex carrying (end, side) — end 0=prev / 1=cur endpoint, side
      // -1/+1 across the width. The instanced draw expands these against each
      // particle's prev/cur into a screen-space segment quad.
      this.cornerVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerVbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, -1,   0, 1,   1, -1,
        1, -1,   0, 1,   1, 1,
      ]), gl.STATIC_DRAW);

      this.quadVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

      // Camera-state tracking. Trails live in a screen-space FBO that needs
      // to be cleared whenever the camera moves (otherwise the previous-frame
      // pixels smear against the new view), and particles need to be reseeded
      // into the new visible bbox after zooming (otherwise old-position
      // clusters persist for ~10s of maxAge recycling). We watch
      // zoom/center/pitch/bearing in the render loop rather than hooking
      // 'move'/'zoomend' because those events lag the camera by hundreds of
      // ms — long enough for a ghost box of particles to accumulate in the
      // post-zoom trail buffer before the event-driven reseed fires.
      this._prevCameraKey = null;
      this._cameraMoving = false;
      this._isGlobe = false;

      // GPU-sim resources. Position ping-pong textures + per-view velocity
      // texture are created here; assembly + first seed happen in the
      // bootstrap promise below (they need a loaded tile + a viewport).
      this.posTexA = null;
      this.posTexB = null;
      this.simFboA = null;
      this.simFboB = null;
      this.velTex = null;
      this.texW = 0;
      this.texH = 0;
      this._posFrontIsA = true;
      this._gpuReady = false;
      this._velDirty = false;
      this._seedOx = 0; this._seedOy = 0; this._seedSx = 1; this._seedSy = 1;
      this._seedCursor = 0;
      this._seedStaging = new Uint8Array(0);
      this.simProgram = null;
      if (GPU_SIM) {
        this.simProgram = createProgram(gl, SIM_VS, SIM_FS);
        this.simAttrPos = gl.getAttribLocation(this.simProgram, 'a_pos');
        this.simUPosIn = gl.getUniformLocation(this.simProgram, 'u_posIn');
        this.simUVelTex = gl.getUniformLocation(this.simProgram, 'u_velTex');
        this.simUVelSize = gl.getUniformLocation(this.simProgram, 'u_velSize');
        this.simUSeedSpan = gl.getUniformLocation(this.simProgram, 'u_seedSpan');
        this.simUDecScale = gl.getUniformLocation(this.simProgram, 'u_decScale');
        this.simUDecOffset = gl.getUniformLocation(this.simProgram, 'u_decOffset');
        this.simUEff = gl.getUniformLocation(this.simProgram, 'u_eff');
        this.simUMinStep = gl.getUniformLocation(this.simProgram, 'u_minStepMerc');
        this.setupGpuTextures();
      }

      // Seed the simulation with a fallback z=0 tile so particles can sample
      // wind from frame one, before higher-zoom tiles have finished loading.
      // Also kick off a z=0 mask tile in parallel — without it, particles
      // briefly sample wind over continents until a finer mask tile arrives.
      Promise.all([
        this.loadTile(0, 0, 0),
        opts.landmaskUrlTemplate ? this.loadMaskTile(0, 0, 0) : Promise.resolve(),
      ])
        .then(() => {
          this.computeViewport();
          if (GPU_SIM) {
            this._computeSeedBbox();
            this.assembleVelTex();
            this.fullReseedGpu();
            this._gpuReady = true;
          } else {
            this.initParticles();
          }
          this.map.triggerRepaint();
        })
        .catch((err: unknown) => console.error('streamlines: failed to load fallback tile', err));
    },

    onRemove(this: StreamlinesLayerThis, _map: unknown, gl: WebGL2RenderingContext): void {
      if (this.pointsVbo) gl.deleteBuffer(this.pointsVbo);
      if (this.cornerVbo) gl.deleteBuffer(this.cornerVbo);
      if (this.quadVbo) gl.deleteBuffer(this.quadVbo);
      if (this.pointsProgram) gl.deleteProgram(this.pointsProgram);
      gl.deleteProgram(this.fadeProgram);
      gl.deleteProgram(this.compositeProgram);
      if (this.simProgram) gl.deleteProgram(this.simProgram);
      if (this.colormapTexture) gl.deleteTexture(this.colormapTexture);
      this.colormapTexture = null;
      this.deleteFramebuffers();
      this.deleteGpuTextures();
    },

    deleteFramebuffers(this: StreamlinesLayerThis): void {
      const gl = this.gl;
      if (this.fbA) {
        gl.deleteFramebuffer(this.fbA.fb);
        gl.deleteTexture(this.fbA.tex);
        this.fbA = null;
      }
      if (this.fbB) {
        gl.deleteFramebuffer(this.fbB.fb);
        gl.deleteTexture(this.fbB.tex);
        this.fbB = null;
      }
    },

    /** Zero out both trail buffers without deleting them. Used to reset trails
     *  when the camera moves so old screen-space content doesn't smear. */
    clearTrailBuffers(this: StreamlinesLayerThis): void {
      if (!this.fbA || !this.fbB) return;
      const gl = this.gl;
      const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      for (const fb of [this.fbA, this.fbB]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo);
    },

    /* ---- GPU simulation (gpuSim path) ---- */

    /** Create (or recreate) the position ping-pong textures, their sim FBOs,
     *  and the velocity texture. Sized from N (one texel per particle). */
    setupGpuTextures(this: StreamlinesLayerThis): void {
      const gl = this.gl;
      this.deleteGpuTextures();
      const texW = Math.max(1, Math.ceil(Math.sqrt(this.N)));
      const texH = Math.max(1, Math.ceil(this.N / texW));
      this.texW = texW;
      this.texH = texH;
      const mkTex = (w: number, h: number): WebGLTexture => {
        const t = gl.createTexture();
        if (!t) throw new Error('@mercator-blue/sdk/mapbox: streamlines — gl.createTexture returned null');
        gl.bindTexture(gl.TEXTURE_2D, t);
        // null data is zero-filled per the WebGL spec → all-zero = dead sentinel.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.posTexA = mkTex(texW, texH);
      this.posTexB = mkTex(texW, texH);
      this.velTex = mkTex(VEL_TEX_SIZE, VEL_TEX_SIZE);
      const mkFbo = (tex: WebGLTexture): WebGLFramebuffer => {
        const fb = gl.createFramebuffer();
        if (!fb) throw new Error('@mercator-blue/sdk/mapbox: streamlines — gl.createFramebuffer returned null');
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return fb;
      };
      this.simFboA = mkFbo(this.posTexA);
      this.simFboB = mkFbo(this.posTexB);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._posFrontIsA = true;
      this._seedCursor = 0;
      this._seedStaging = new Uint8Array(texW * texH * 4);
    },

    deleteGpuTextures(this: StreamlinesLayerThis): void {
      const gl = this.gl;
      if (this.posTexA) { gl.deleteTexture(this.posTexA); this.posTexA = null; }
      if (this.posTexB) { gl.deleteTexture(this.posTexB); this.posTexB = null; }
      if (this.velTex) { gl.deleteTexture(this.velTex); this.velTex = null; }
      if (this.simFboA) { gl.deleteFramebuffer(this.simFboA); this.simFboA = null; }
      if (this.simFboB) { gl.deleteFramebuffer(this.simFboB); this.simFboB = null; }
    },

    /** Padded seed bbox (mercator), identical to makeParticle's seed range, so
     *  the velocity texture, the position encoding, and CPU-placed seeds all
     *  share one coordinate frame. Also sets coordOrigin (bbox centre) for the
     *  render VS split-precision projection. Cheap; recomputed each frame. */
    _computeSeedBbox(this: StreamlinesLayerThis): void {
      const v = this.viewport;
      if (!v) return;
      const sx = v.mxMax - v.mxMin;
      const sy = v.myMax - v.myMin;
      this._seedOx = v.mxMin - SEED_MARGIN * sx;
      this._seedOy = v.myMin - SEED_MARGIN * sy;
      this._seedSx = sx * (1 + 2 * SEED_MARGIN);
      this._seedSy = sy * (1 + 2 * SEED_MARGIN);
      this.coordOrigin = [this._seedOx + this._seedSx / 2, this._seedOy + this._seedSy / 2];
    },

    /** Draw one CPU seed (via makeParticle) and write its 4 encoded bytes
     *  (viewport-local 16-bit/axis) at `off`. A dead seed (no ocean found) is
     *  the all-zero sentinel; the render VS culls it. */
    _encodeSeedInto(this: StreamlinesLayerThis, buf: Uint8Array, off: number): void {
      const p = this.makeParticle();
      if (p.speed < 0 || this._seedSx <= 0 || this._seedSy <= 0) {
        buf[off] = 0; buf[off + 1] = 0; buf[off + 2] = 0; buf[off + 3] = 0;
        return;
      }
      const lx = (p.mx - this._seedOx) / this._seedSx;
      const ly = (p.my - this._seedOy) / this._seedSy;
      let qx = Math.max(0, Math.min(65535, Math.round(lx * 65535)));
      const qy = Math.max(0, Math.min(65535, Math.round(ly * 65535)));
      // Avoid colliding with the all-zero dead sentinel for a live particle.
      if (qx === 0 && qy === 0) qx = 1;
      buf[off] = qx >> 8; buf[off + 1] = qx & 255;
      buf[off + 2] = qy >> 8; buf[off + 3] = qy & 255;
    },

    /** Assemble the per-view velocity texture (vector_rg_ba, NEAREST) from the
     *  loaded tiles over the padded seed bbox. Land / no-data texels are the
     *  all-zero sentinel (landmask is folded in via sampleWind). Rebuilt only
     *  on viewport change / tile-in, not per frame. */
    assembleVelTex(this: StreamlinesLayerThis): void {
      const gl = this.gl;
      if (!this.velTex) return;
      const S = VEL_TEX_SIZE;
      const buf = new Uint8Array(S * S * 4); // zero-filled = no-data sentinel
      const sc = opts.encoding.scale;
      const off = opts.encoding.offset;
      const ox = this._seedOx, oy = this._seedOy, sx = this._seedSx, sy = this._seedSy;
      for (let j = 0; j < S; j++) {
        const my = oy + ((j + 0.5) / S) * sy;
        for (let i = 0; i < S; i++) {
          const mx = ox + ((i + 0.5) / S) * sx;
          const w = this.sampleWind(mx, my); // null over land / no-data
          if (!w) continue;
          const uq = Math.max(0, Math.min(65535, Math.round((w.u - off) / sc)));
          const vq = Math.max(0, Math.min(65535, Math.round((w.v - off) / sc)));
          let R = uq >> 8; let G = uq & 255;
          const B = vq >> 8; const A = vq & 255;
          if ((R | G | B | A) === 0) G = 1; // don't alias the sentinel
          const idx = (j * S + i) * 4;
          buf[idx] = R; buf[idx + 1] = G; buf[idx + 2] = B; buf[idx + 3] = A;
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, this.velTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    },

    /** Seed all N particles into the current FRONT position texture (used on
     *  bootstrap and on camera settle). The sim fills BACK from FRONT next. */
    fullReseedGpu(this: StreamlinesLayerThis): void {
      const gl = this.gl;
      const front = this._posFrontIsA ? this.posTexA : this.posTexB;
      if (!front) return;
      const buf = this._seedStaging;
      buf.fill(0);
      for (let i = 0; i < this.N; i++) this._encodeSeedInto(buf, i * 4);
      gl.bindTexture(gl.TEXTURE_2D, front);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.texW, this.texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      this._seedCursor = 0;
    },

    /** Refresh ~N/maxAge particles per frame on a round-robin schedule (the
     *  steady-state recycle rate). Writes only the affected texels of FRONT
     *  via texSubImage2D; the GPU owns every other texel. */
    reseedRoundRobinGpu(this: StreamlinesLayerThis): void {
      const gl = this.gl;
      const front = this._posFrontIsA ? this.posTexA : this.posTexB;
      if (!front) return;
      let count = Math.ceil(this.N / Math.max(1, this.maxAge));
      if (count <= 0) return;
      gl.bindTexture(gl.TEXTURE_2D, front);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      let idx = this._seedCursor;
      while (count > 0) {
        const row = Math.floor(idx / this.texW);
        const col = idx % this.texW;
        const n = Math.min(count, this.texW - col, this.N - idx);
        const seg = new Uint8Array(n * 4);
        for (let k = 0; k < n; k++) this._encodeSeedInto(seg, k * 4);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, col, row, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, seg);
        count -= n;
        idx += n;
        if (idx >= this.N) idx = 0; // wrap
      }
      this._seedCursor = idx;
    },

    /** Advance every particle one step: fragment-shader pass reading FRONT,
     *  writing BACK. Restores the caller's framebuffer + viewport. */
    simStepGpu(this: StreamlinesLayerThis, gl: WebGL2RenderingContext): void {
      if (!this.simProgram || !this.velTex) return;
      const front = this._posFrontIsA ? this.posTexA : this.posTexB;
      const backFbo = this._posFrontIsA ? this.simFboB : this.simFboA;
      if (!front || !backFbo) return;

      const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const savedViewport = gl.getParameter(gl.VIEWPORT);

      gl.bindFramebuffer(gl.FRAMEBUFFER, backFbo);
      gl.viewport(0, 0, this.texW, this.texH);
      gl.disable(gl.BLEND);
      gl.useProgram(this.simProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.enableVertexAttribArray(this.simAttrPos);
      gl.vertexAttribPointer(this.simAttrPos, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, front);
      if (this.simUPosIn) gl.uniform1i(this.simUPosIn, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.velTex);
      if (this.simUVelTex) gl.uniform1i(this.simUVelTex, 1);
      if (this.simUVelSize) gl.uniform2i(this.simUVelSize, VEL_TEX_SIZE, VEL_TEX_SIZE);
      if (this.simUSeedSpan) gl.uniform2f(this.simUSeedSpan, this._seedSx, this._seedSy);
      if (this.simUDecScale) gl.uniform1f(this.simUDecScale, opts.encoding.scale);
      if (this.simUDecOffset) gl.uniform1f(this.simUDecOffset, opts.encoding.offset);

      // eff + min-step floor: identical math to updateParticles, measured from
      // the live projection at the screen centre.
      const zoom = this.map.getZoom();
      const eff = this._isGlobe
        ? this.speedScale * Math.min(0.25, Math.pow(0.5, zoom))
        : this.speedScale * Math.pow(0.5, zoom);
      if (this.simUEff) gl.uniform1f(this.simUEff, eff);
      const canvas = this.map.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
      const ctr = this.map.getCenter();
      const EPS_LNG = 0.1;
      const pa = this.map.project([ctr.lng - EPS_LNG, ctr.lat]);
      const pb = this.map.project([ctr.lng + EPS_LNG, ctr.lat]);
      const screenDevPx = Math.hypot(pb.x - pa.x, pb.y - pa.y) * dpr;
      const mercDelta = (2 * EPS_LNG) / 360;
      const v = this.viewport;
      const pxPerMercator = (screenDevPx > 1e-6 && mercDelta > 1e-12)
        ? screenDevPx / mercDelta
        : canvas.width / Math.max(v ? v.mxMax - v.mxMin : 1, 1e-9);
      if (this.simUMinStep) gl.uniform1f(this.simUMinStep, MIN_STEP_PIXELS / pxPerMercator);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(this.simAttrPos);

      gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo);
      gl.viewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
    },

    /* ---- runtime configuration setters (the SDK surface) ---- */

    setOpacity(this: StreamlinesLayerThis, o: number): void {
      this.opacity = o;
      this.map.triggerRepaint();
    },
    setPointSize(this: StreamlinesLayerThis, s: number): void {
      this.pointSize = s;
      this.map.triggerRepaint();
    },
    setTrailResolutionScale(this: StreamlinesLayerThis, s: number): void {
      this.trailScale = Math.max(0.1, Math.min(1, s));
      this.setupFramebuffers(); // rebuilds at the new size (size differs)
      this.clearTrailBuffers();
      this.map.triggerRepaint();
    },
    setSpeedScale(this: StreamlinesLayerThis, s: number): void {
      this.speedScale = s;
      this.map.triggerRepaint();
    },
    setMaxAge(this: StreamlinesLayerThis, a: number): void {
      this.maxAge = a;
      this.map.triggerRepaint();
    },
    setFade(this: StreamlinesLayerThis, f: number): void {
      this.fade = f;
      this.map.triggerRepaint();
    },
    setColorBySpeed(this: StreamlinesLayerThis, b: boolean): void {
      this.colorBySpeed = !!b;
      // Trail buffer holds the previous color choice baked into pixels;
      // clear so the new mode takes over immediately rather than fading in.
      this.clearTrailBuffers();
      this.map.triggerRepaint();
    },
    setColormap(this: StreamlinesLayerThis, spec: ColormapSpec): void {
      this.colormapData = resolveColormap(spec);
      this.colormapDirty = true;
      // Existing trail pixels carry the old palette; clear so the new
      // colours take over immediately instead of fading in over the old.
      this.clearTrailBuffers();
      this.map.triggerRepaint();
    },
    setParticleCount(this: StreamlinesLayerThis, n: number): void {
      n = Math.max(1, Math.floor(n));
      if (n === this.N) return;
      this.N = n;
      this.vertData = new Float32Array(n * 5);
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.vertData.byteLength, gl.DYNAMIC_DRAW);
      if (GPU_SIM) {
        // Resize the position textures (one texel/particle). setupGpuTextures
        // also recreates velTex empty, so re-snapshot it before reseeding.
        this.setupGpuTextures();
        if (this.viewport && this._gpuReady) {
          this._computeSeedBbox();
          this.assembleVelTex();
          this.fullReseedGpu();
        }
      } else if (this.viewport) {
        this.initParticles();
      }
      this.map.triggerRepaint();
    },
    setVmin(this: StreamlinesLayerThis, v: number): void {
      this.vmin = v;
      this.map.triggerRepaint();
    },
    setVmax(this: StreamlinesLayerThis, v: number): void {
      this.vmax = v;
      this.map.triggerRepaint();
    },

    /** Apply a partial options patch. See MercatorLayer.setOptions for the
     *  customer-facing entry point. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyOptions(this: StreamlinesLayerThis, p: any): void {
      if (p.opacity != null) this.setOpacity(p.opacity);
      if (p.pointSize != null) this.setPointSize(p.pointSize);
      if (p.trailResolutionScale != null) this.setTrailResolutionScale(p.trailResolutionScale);
      if (p.speedScale != null) this.setSpeedScale(p.speedScale);
      if (p.maxAge != null) this.setMaxAge(p.maxAge);
      if (p.fade != null) this.setFade(p.fade);
      if (p.colorBySpeed != null) this.setColorBySpeed(p.colorBySpeed);
      if (p.colormap != null) this.setColormap(p.colormap);
      if (p.particleCount != null) this.setParticleCount(p.particleCount);
      if (p.vmin != null) this.setVmin(p.vmin);
      if (p.vmax != null) this.setVmax(p.vmax);
    },

    setupFramebuffers(this: StreamlinesLayerThis): void {
      const gl = this.gl;
      // Trail buffer can run below device resolution: the fade + composite are
      // full-canvas passes whose GPU cost scales with pixel count, so a 0.5
      // scale quarters them. Composite upscales with LINEAR on the way to the
      // screen, so the only cost is slightly softer trails.
      const W = Math.max(1, Math.round(gl.canvas.width * this.trailScale));
      const H = Math.max(1, Math.round(gl.canvas.height * this.trailScale));
      if (this.fbA && this.fbW === W && this.fbH === H) return;
      this.deleteFramebuffers();
      this.fbA = this.makeFramebuffer(W, H);
      this.fbB = this.makeFramebuffer(W, H);
      this.fbW = W;
      this.fbH = H;
    },

    makeFramebuffer(this: StreamlinesLayerThis, W: number, H: number): FB {
      const gl = this.gl;
      const tex = gl.createTexture();
      if (!tex) throw new Error('@mercator-blue/sdk/mapbox: streamlines — gl.createTexture returned null');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      if (!fb) {
        gl.deleteTexture(tex);
        throw new Error('@mercator-blue/sdk/mapbox: streamlines — gl.createFramebuffer returned null');
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { fb, tex };
    },

    async loadTile(this: StreamlinesLayerThis, z: number, x: number, y: number): Promise<void> {
      const key = tileKey(z, x, y);
      if (this.tiles.has(key)) return;
      this.tiles.set(key, { status: 'loading' });
      try {
        // Route through the WebGL-based reader. createImageBitmap +
        // canvas 2D + getImageData corrupts pixels with low alpha because
        // canvas 2D internally premultiplies, and the round-trip loses
        // precision — see tile-pixel-reader.ts.
        //
        // Note: landmask is NOT applied here. The mask is fetched + sampled
        // independently in sampleLandmask so the renderer can use a finer
        // landmask zoom than the data tile's own maxzoom (HYCOM is z=5,
        // landmask pyramid is built to z=8).
        const url = expandTileUrl(opts.tileUrlTemplate, z, x, y);
        const { width: W, height: H, pixels: data } = await loadTilePixels(url);
        const u = new Float32Array(W * H);
        const v = new Float32Array(W * H);
        const sc = opts.encoding.scale;
        const off = opts.encoding.offset;
        for (let i = 0; i < W * H; i++) {
          const r = data[i * 4], g = data[i * 4 + 1];
          const b = data[i * 4 + 2], a = data[i * 4 + 3];
          // No-data sentinel for vector_rg_ba (see encoding.py): all four
          // bytes zero. Surface ocean datasets carry NaN over land, which
          // encodes here; store NaN so the sampler can detect and skip.
          if ((r | g | b | a) === 0) {
            u[i] = NaN;
            v[i] = NaN;
            continue;
          }
          u[i] = (r * 256 + g) * sc + off;
          v[i] = (b * 256 + a) * sc + off;
        }
        this.tiles.set(key, { status: 'loaded', u, v, W, H });
      } catch (err) {
        this.tiles.set(key, { status: 'error' });
        throw err;
      }
    },

    /** Fetch and decode a landmask tile. Mask tiles are L-mode (single-byte
     *  category per pixel) PNGs; the WebGL upload replicates L → RGBA so
     *  the category byte ends up in the R channel.  */
    async loadMaskTile(this: StreamlinesLayerThis, z: number, x: number, y: number): Promise<void> {
      if (!opts.landmaskUrlTemplate || !landmaskAccepts) return;
      const key = tileKey(z, x, y);
      if (this.maskTiles.has(key)) return;
      this.maskTiles.set(key, { status: 'loading' });
      try {
        const url = expandTileUrl(opts.landmaskUrlTemplate, z, x, y);
        const { width: W, height: H, pixels } = await loadTilePixels(url);
        // Compact to a single byte per pixel — saves 4× memory across the
        // mask cache, and lookup is faster with no stride.
        const mask = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) mask[i] = pixels[i * 4];
        this.maskTiles.set(key, { status: 'loaded', mask, W, H });
      } catch {
        // 404 etc. — treat as "no mask available here". sampleLandmask
        // falls back to a coarser zoom or, if nothing's loaded anywhere,
        // returns 'unknown' so particles aren't pessimistically blocked.
        this.maskTiles.set(key, { status: 'error' });
      }
    },

    /** Returns 'ocean' (or whatever's in landmaskAccepts), 'land', or
     *  'unknown' if no mask tile covering this point is loaded.  Walks
     *  down from maskTargetZ so a higher-z tile that finished loading
     *  preempts the coarser fallback. NEAREST sampling — bilinear on
     *  category bytes is meaningless. */
    sampleLandmask(this: StreamlinesLayerThis, mx: number, my: number): 'ocean' | 'land' | 'unknown' {
      if (!landmaskAccepts) return 'ocean';  // No mask configured = no rejection
      const mxC = posMod(mx, 1);
      const myC = Math.max(0, Math.min(1 - 1e-9, my));
      for (let z = this.maskTargetZ; z >= 0; z--) {
        const n = 2 ** z;
        const tx = Math.floor(mxC * n);
        const ty = Math.floor(myC * n);
        const tile = this.maskTiles.get(tileKey(z, tx, ty));
        if (!tile || tile.status !== 'loaded') continue;
        const localX = mxC * n - tx;
        const localY = myC * n - ty;
        const px = Math.min(tile.W - 1, Math.max(0, Math.floor(localX * tile.W)));
        const py = Math.min(tile.H - 1, Math.max(0, Math.floor(localY * tile.H)));
        const byte = tile.mask[py * tile.W + px];
        return landmaskAccepts.has(byte) ? 'ocean' : 'land';
      }
      return 'unknown';
    },

    computeViewport(this: StreamlinesLayerThis): void {
      const viewZ = Math.floor(this.map.getZoom());
      this.targetZ = Math.max(0, Math.min(MAX_Z, viewZ));
      // Landmask zoom is independent — clamped to its own pyramid's
      // maxzoom, not the data tile's. That's the whole point of decoupling:
      // when viewZ > MAX_Z (data resolution exhausted), the mask keeps
      // sharpening up to LANDMASK_MAX_Z.
      this.maskTargetZ = Math.max(0, Math.min(LANDMASK_MAX_Z, viewZ));

      // Globe-rendering path has two regimes:
      //   (a) Low-zoom — the sphere fits inside the canvas with space around
      //       it. Screen corners are off-disc; `unproject(corner)` snaps to
      //       the horizon, and any bbox we compute from those snapped corners
      //       systematically undercounts the visible disc and biases toward
      //       whichever side the camera is tilted. We sample the visible
      //       spherical cap directly (in makeParticle) and use
      //       full-world for the seeding region here.
      //   (b) High-zoom — the visible disc fills (or nearly fills) the
      //       canvas. Corners are on-disc and `unproject` returns real
      //       lat/lng. Bbox-from-corners is now necessary: at extreme zoom
      //       the *geometric* cap from the clipping plane covers a huge
      //       solid angle of the sphere (camera ~0.003 units off the
      //       surface → cap α ≈ 4.4°) compared to the tiny ~0.05° patch
      //       actually visible through the view frustum, so cap-direct
      //       sampling places ~99% of particles outside the canvas. Use
      //       the corner bbox instead.
      //
      // Detect regime via per-corner round-trip: unproject → project →
      // compare distance. Off-disc corners snap to the horizon and
      // reproject far from the original; on-disc corners round-trip within
      // sub-pixel error.
      const pt = this._lastProjectionTransition;
      // MapLibre exposes the projection on `.type`, Mapbox on `.name`.
      // Accept both so this layer recognises Mapbox globe correctly.
      const proj = this.map.getProjection?.();
      const isGlobeProjection = proj?.type === 'globe' || proj?.name === 'globe';
      this._isGlobe = isGlobeProjection;
      const isGlobeRendering = (pt !== undefined && pt > 0) ||
        (pt === undefined && isGlobeProjection);
      if (isGlobeRendering) {
        const canvas = this.map.getCanvas();
        const W = canvas.clientWidth, H = canvas.clientHeight;
        // Detect the regime from the 4 corners: if any corner snaps to the
        // horizon (the disc doesn't fill the canvas), we're in the low-zoom
        // cap regime. Otherwise we're high enough that the disc fills the
        // canvas and a rectangular bbox is meaningful.
        let allOnDisc = true;
        for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H]]) {
          const ll = this.map.unproject([px, py]);
          if (!Number.isFinite(ll.lng + ll.lat)) { allOnDisc = false; break; }
          const back = this.map.project(ll);
          const dx = back.x - px, dy = back.y - py;
          if (dx * dx + dy * dy > 4) { allOnDisc = false; break; }
        }
        if (!allOnDisc) {
          // Cap regime: cap-sampling in makeParticle handles distribution.
          this.viewport = { mxMin: 0, mxMax: 1, myMin: 0.005, myMax: 0.995 };
          this._globeBboxMode = false;
          return;
        }
        // Bbox regime: compute the bbox from 8 samples (corners + edge mids),
        // not 4 corners. On the globe at high zoom the visible disc still
        // bulges outward — the top-center pixel can sit at a noticeably
        // higher latitude than the top-corner pixels, so a 4-corner bbox
        // misses the high-lat strip that's actually on screen (visibly:
        // empty Arctic at z=4+ in a Northern-Europe view).
        const samples: Array<[number, number]> = [
          [0, 0], [W / 2, 0], [W, 0],
          [0, H / 2], [W, H / 2],
          [0, H], [W / 2, H], [W, H],
        ];
        let mxMin = Infinity, mxMax = -Infinity, myMin = Infinity, myMax = -Infinity;
        for (const [px, py] of samples) {
          const ll = this.map.unproject([px, py]);
          const lat = Math.max(-85.0511, Math.min(85.0511, ll.lat));
          const mx = (ll.lng + 180) / 360;
          const latRad = lat * Math.PI / 180;
          const my = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
          if (mx < mxMin) mxMin = mx;
          if (mx > mxMax) mxMax = mx;
          if (my < myMin) myMin = my;
          if (my > myMax) myMax = my;
        }
        this.viewport = { mxMin, mxMax, myMin, myMax };
        this._globeBboxMode = true;
        return;
      }
      this._globeBboxMode = false;

      const canvas = this.map.getCanvas();
      const W = canvas.clientWidth, H = canvas.clientHeight;
      const samples: Array<[number, number]> = [
        [0, 0], [W / 2, 0], [W, 0],
        [0, H / 2], [W, H / 2],
        [0, H], [W / 2, H], [W, H],
      ];
      let mxMin = Infinity, mxMax = -Infinity, myMin = Infinity, myMax = -Infinity;
      for (const p of samples) {
        const ll = this.map.unproject(p);
        const lat = Math.max(-85.0511, Math.min(85.0511, ll.lat));
        const mx = (ll.lng + 180) / 360;
        const latRad = (lat * Math.PI) / 180;
        const my = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2);
        if (mx < mxMin) mxMin = mx;
        if (mx > mxMax) mxMax = mx;
        if (my < myMin) myMin = my;
        if (my > myMax) myMax = my;
      }
      this.viewport = { mxMin, mxMax, myMin, myMax };
    },

    ensureVisibleTilesLoading(this: StreamlinesLayerThis): void {
      this._ensureTilesAtZoom(this.targetZ, /* mask */ false);
      // Landmask zoom is independent of data zoom — fetch separately at
      // maskTargetZ so finer mask resolution loads when viewZ > data
      // tile maxzoom. Skipped silently when no landmask is configured.
      if (opts.landmaskUrlTemplate) {
        this._ensureTilesAtZoom(this.maskTargetZ, /* mask */ true);
      }
    },

    _ensureTilesAtZoom(this: StreamlinesLayerThis, z: number, mask: boolean): void {
      const n = 2 ** z;
      const v = this.viewport;
      if (!v) return;
      const xLo = Math.floor(v.mxMin * n);
      const xHi = Math.floor(v.mxMax * n);
      const yLo = Math.max(0, Math.floor(v.myMin * n));
      const yHi = Math.min(n - 1, Math.floor(v.myMax * n));

      // Low-zoom globe regime: viewport is full-world, so the naive loop
      // would fetch 4^z tiles globally — at z=5 that's 1024 tiles, each
      // ~512KB once decoded into u/v Float32Arrays. Restrict to tiles
      // whose bounding box intersects the visible cap, tested at 5 sample
      // points against the same clipping plane the shader uses. Margin
      // keeps partial-limb tiles in. Skipped in mercator and globe-bbox
      // regimes — there `this.viewport` already bounds the visible region.
      const plane = this._lastClippingPlane;
      const pt = this._lastProjectionTransition;
      const useCapCull = !!plane && pt !== undefined && pt > 0 && !this._globeBboxMode;

      for (let xi = xLo; xi <= xHi; xi++) {
        for (let yi = yLo; yi <= yHi; yi++) {
          if (useCapCull && plane) {
            const margin = 0.05;
            let anyVisible = false;
            for (const [fx, fy] of [[0,0],[1,0],[0,1],[1,1],[0.5,0.5]]) {
              const cmx = (xi + fx) / n;
              const cmy = (yi + fy) / n;
              if (cmy < 0.005 || cmy > 0.995) continue;
              const s = this._projectToSphere(cmx, cmy);
              const front = s[0]*plane[0] + s[1]*plane[1] + s[2]*plane[2] + plane[3];
              if (front >= -margin) { anyVisible = true; break; }
            }
            if (!anyVisible) continue;
          }
          const tx = posMod(xi, n);
          const key = tileKey(z, tx, yi);
          if (mask) {
            if (!this.maskTiles.has(key)) {
              this.loadMaskTile(z, tx, yi)
                .then(() => { this._velDirty = true; this.map.triggerRepaint(); })
                .catch(() => {});
            }
          } else {
            if (!this.tiles.has(key)) {
              this.loadTile(z, tx, yi)
                .then(() => { this._velDirty = true; this.map.triggerRepaint(); })
                .catch(() => {});
            }
          }
        }
      }
    },

    initParticles(this: StreamlinesLayerThis): void {
      const ps = this.particles;
      if (ps.length === this.N) {
        // Reuse the existing particle objects (mutate in place) so a
        // camera-settle reseed doesn't churn N fresh allocations and leave
        // the old array for GC. Mirrors the in-place recycle in
        // updateParticles. makeParticle's return is a short-lived temp.
        for (let i = 0; i < this.N; i++) {
          const s = this.makeParticle();
          const p = ps[i];
          p.mx = s.mx; p.my = s.my; p.pmx = s.pmx; p.pmy = s.pmy;
          p.age = s.age; p.speed = s.speed;
        }
        return;
      }
      this.particles = [];
      for (let i = 0; i < this.N; i++) this.particles.push(this.makeParticle());
    },

    /** JS mirror of MapLibre's GLSL `projectToSphere(a_pos)`. For custom
     *  layers `u_projection_tile_mercator_coords = (0, 0, 1, 1)` so the
     *  input is the global Mercator coord directly. Returns a unit-sphere
     *  vec3 in MapLibre's axis convention (Y = north pole). */
    _projectToSphere(this: StreamlinesLayerThis, mx: number, my: number): [number, number, number] {
      const sphericalX = mx * Math.PI * 2.0 + Math.PI;
      const sphericalY = 2.0 * Math.atan(Math.exp(Math.PI - my * Math.PI * 2.0)) - Math.PI * 0.5;
      const len = Math.cos(sphericalY);
      return [
        Math.sin(sphericalX) * len,
        Math.sin(sphericalY),
        Math.cos(sphericalX) * len,
      ];
    },

    /** Synthesise a MapLibre-shape clipping plane vec4 from Mapbox-globe
     *  args. Mapbox doesn't expose its own back-cull plane to custom
     *  layers (MapLibre supplies one via `defaultProjectionData.
     *  clippingPlane`); without one, cap-aware seeding falls through to
     *  equal-area-on-sphere — ~half the particles land on the back face
     *  and stay invisible until they drift across the limb via the
     *  `maxAge` recycle, halving the perceived density vs MapLibre.
     *
     *  Geometry: at view zoom Z the world maps to 256·2^Z screen pixels
     *  (slippy-map convention). The sphere drawing it has radius
     *  R = 256·2^Z / (2π) pixels. Camera-to-center distance at
     *  Mapbox's default ~36.87° vertical FOV is d ≈ canvasHeight·1.5
     *  pixels. The visible spherical cap from a camera at distance d
     *  from a sphere of radius R has cos α = R/d.
     *
     *  Bias: clamps cos α to [0, 0.999]. Below the lower bound the cap
     *  covers the entire visible hemisphere; above the upper bound we
     *  have a sub-3° cap and bbox-regime has long since taken over.
     *
     *  Sphere-axis convention: returns the cap axis in MapLibre's
     *  convention (Y = north pole). The CPU cap-membership tests in
     *  `_isFrontFacing` / `_sampleVisibleCap` use MapLibre's
     *  projectToSphere internally; the dot product S_ml · axis_ml gives
     *  the same value as the Mapbox-convention test S_mb · axis_mb (the
     *  two conventions differ only in Y sign, which cancels in the dot
     *  product), so a MapLibre-convention plane correctly classifies
     *  Mapbox-rendered particles. Confirmed via diagnostic 2026-05-25.
     */
    _synthesizeMapboxClippingPlane(this: StreamlinesLayerThis, centerInMercator: VecLike | undefined): VecLike | undefined {
      if (!centerInMercator) return undefined;
      const axis = this._projectToSphere(centerInMercator[0], centerInMercator[1]);
      const canvasH = this.map.getContainer().clientHeight || 800;
      const z = this.map.getZoom();
      // d/R = canvasHeight·1.5·2π / (256·2^Z) = canvasHeight·3π / (256·2^Z)
      const ratio = (canvasH * 3 * Math.PI) / (256 * Math.pow(2, z));
      const cosAlpha = Math.max(0, Math.min(0.999, 1 / ratio));
      return [axis[0], axis[1], axis[2], -cosAlpha];
    },

    /** True if (mx, my) projects to a point inside the visible spherical cap.
     *  This is the same predicate the shader's projection enforces (back-side
     *  points map to NDC-z > 1 and clip at the far plane). Returns true when
     *  the plane isn't known yet — bootstrap before the first render. */
    _isFrontFacing(this: StreamlinesLayerThis, mx: number, my: number): boolean {
      const p = this._lastClippingPlane;
      if (!p) return true;
      const s = this._projectToSphere(mx, my);
      return s[0] * p[0] + s[1] * p[1] + s[2] * p[2] + p[3] >= 0;
    },

    /** Sample a uniform-area random point on the visible spherical cap
     *  defined by MapLibre's clipping plane (`dot(P, plane.xyz) + plane.w
     *  ≥ 0` ⇒ cap of half-angle α with `cos α = -plane.w`, axis = plane.xyz).
     *  Equal-area parametrization: random `cosθ ∈ [cos α, 1]` × random
     *  azimuth, rotated to the cap-axis frame, then inverted through
     *  MapLibre's projectToSphere to get (mx, my). Returns null when the
     *  plane is unset (bootstrap) or the sample lands outside the Mercator
     *  band; caller retries or falls through to the equal-area fallback. */
    _sampleVisibleCap(this: StreamlinesLayerThis): { mx: number; my: number } | null {
      const p = this._lastClippingPlane;
      if (!p) return null;
      const nx = p[0], ny = p[1], nz = p[2];
      const nLen = Math.hypot(nx, ny, nz);
      if (nLen < 1e-9) return null;
      const axX = nx / nLen, axY = ny / nLen, axZ = nz / nLen;

      // cos α = -w; clamp so a slightly degenerate plane mid-transition
      // doesn't blow up. cosAlpha ≤ 0 means the cap is ≥ a hemisphere (camera
      // very far) — that's fine, we still sample correctly.
      const cosAlpha = Math.max(-1, Math.min(1, -p[3]));
      const cosTheta = cosAlpha + Math.random() * (1 - cosAlpha);
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const phi = Math.random() * 2 * Math.PI;
      const lX = sinTheta * Math.cos(phi);
      const lY = sinTheta * Math.sin(phi);
      const lZ = cosTheta;

      // Build any orthonormal basis (u1, u2, axis). Pick a "world up" not
      // parallel to the cap axis.
      const upX = Math.abs(axY) < 0.9 ? 0 : 1;
      const upY = Math.abs(axY) < 0.9 ? 1 : 0;
      const upZ = 0;
      // u1 = normalize(cross(axis, up))
      let u1x = axY * upZ - axZ * upY;
      let u1y = axZ * upX - axX * upZ;
      let u1z = axX * upY - axY * upX;
      const u1Len = Math.hypot(u1x, u1y, u1z);
      u1x /= u1Len; u1y /= u1Len; u1z /= u1Len;
      // u2 = cross(axis, u1)
      const u2x = axY * u1z - axZ * u1y;
      const u2y = axZ * u1x - axX * u1z;
      const u2z = axX * u1y - axY * u1x;

      // World-frame sphere point.
      const sX = lX * u1x + lY * u2x + lZ * axX;
      const sY = lX * u1y + lY * u2y + lZ * axY;
      const sZ = lX * u1z + lY * u2z + lZ * axZ;

      // Inverse of MapLibre's projectToSphere:
      //   sphericalX = atan2(sX, sZ)            (then shifted by π so mx ∈ [0,1))
      //   sphericalY = asin(sY)                 (then Mercator-y)
      const sphericalX = Math.atan2(sX, sZ);
      const sphericalY = Math.asin(Math.max(-1, Math.min(1, sY)));
      // Reject near-pole samples: Mercator-y diverges there and we'd produce
      // out-of-band particles anyway. The caller retries.
      if (Math.abs(sphericalY) > 85.05 * Math.PI / 180) return null;
      let mx = ((sphericalX - Math.PI) / (2 * Math.PI));
      mx = ((mx % 1) + 1) % 1;
      const my = (1 - Math.asinh(Math.tan(sphericalY)) / Math.PI) / 2;
      if (my < 0.005 || my > 0.995) return null;
      return { mx, my };
    },

    makeParticle(this: StreamlinesLayerThis): Particle {
      const v = this.viewport;
      if (!v) {
        // Bootstrap path — viewport not yet computed. Encode "dead" so
        // the vertex shader culls the instance.
        return { mx: 0, my: 0.5, pmx: 0, pmy: 0.5, age: 0, speed: -1 };
      }
      // Extend the seeding bbox by SEED_MARGIN on every side so particles
      // drift INTO the visible viewport from upstream, not just starting
      // somewhere inside it. Bbox regime only — cap-sampling on globe
      // low-zoom uses the visible cap directly (its leeward-band problem
      // is shaped differently and would need a larger cap, deferred).
      const sx = v.mxMax - v.mxMin;
      const sy = v.myMax - v.myMin;
      const seedXMin = v.mxMin - SEED_MARGIN * sx;
      const seedXMax = v.mxMax + SEED_MARGIN * sx;
      const seedYMin = v.myMin - SEED_MARGIN * sy;
      const seedYMax = v.myMax + SEED_MARGIN * sy;
      // Clip the sample range to the intersection of the seed bbox and the
      // Mercator valid-latitude band [0.005, 0.995] before drawing the
      // random (rather than post-sample clamping to those constants, which
      // would collapse all out-of-band samples onto a single line).
      const myLo = Math.max(seedYMin, 0.005);
      const myHi = Math.min(seedYMax, 0.995);
      const span_x = seedXMax - seedXMin;

      // Two seeding strategies, picked by computeViewport's regime detection:
      //   Cap-sampling: low-zoom globe, where `this.viewport` is full-world
      //     but the actual visible region is a spherical cap. Sample uniformly
      //     on that cap; recycle is cap-membership (see inViewport).
      //   Uniform-in-bbox: mercator and high-zoom globe, where `this.viewport`
      //     is an accurate rectangular bbox of the visible region. Standard
      //     uniform sampling.
      // Bootstrap (no clipping plane yet): cap-sampling falls through to the
      // equal-area-on-sphere fallback; once render() populates the plane the
      // recycle pass moves any back-facing leftovers onto the cap.
      const useCapSampling = this._isGlobe && !this._globeBboxMode;
      const drawSeed = (): { mx: number; my: number } => {
        if (useCapSampling) {
          // Cap-sampling has its own internal rejection (near-pole), so
          // give it a few tries before falling back to equal-area.
          for (let i = 0; i < 4; i++) {
            const cap = this._sampleVisibleCap();
            if (cap) return cap;
          }
          const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * myLo)));
          const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * myHi)));
          const sinN = Math.sin(latN);
          const sinS = Math.sin(latS);
          const sinLat = sinS + Math.random() * (sinN - sinS);
          const lat = Math.asin(sinLat);
          return {
            mx: seedXMin + Math.random() * span_x,
            my: (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2,
          };
        }
        return {
          mx: seedXMin + Math.random() * span_x,
          my: myLo + Math.random() * Math.max(0, myHi - myLo),
        };
      };

      // One seed attempt — no retry. Together with rate-limited dead-particle
      // recycling in updateParticles, this gives steady-state live ≈ N × f,
      // where f is the ocean fraction of the viewport: density per unit
      // ocean area stays roughly constant as the user pans between
      // mostly-ocean and mostly-land views. Retrying here would push every
      // particle slot to find ocean and cram all N into a small visible
      // ocean patch, ballooning local density. Flicker on land is a
      // non-issue since failed seeds use the speed=-1 sentinel and the
      // vertex shader clips them out (see makeParticle return below).
      const seed = drawSeed();
      const mx = seed.mx;
      const my = seed.my;
      const found = this.sampleWind(mx, my) !== null;

      // No valid seed — viewport is entirely over no-data (e.g. zoomed into
      // a continental interior past MAX_Z). Encode "dead" with speed = -1.0
      // so the vertex shader collapses the point (gl_PointSize = 0) and the
      // particle takes no fragments this frame. updateParticles will retry
      // each frame, so the particle revives the moment any seed lands on
      // ocean — for example when the user pans toward a coast.
      return {
        mx,
        my,
        pmx: mx,
        pmy: my,
        age: Math.floor(Math.random() * this.maxAge),
        speed: found ? 0 : -1,
      };
    },

    sampleWindAtZoom(this: StreamlinesLayerThis, mx: number, my: number, z: number): { u: number; v: number } | null {
      const n = 2 ** z;
      const mxC = posMod(mx, 1);
      const myC = Math.max(0, Math.min(1 - 1e-9, my));
      const tx = Math.floor(mxC * n);
      const ty = Math.floor(myC * n);
      const tile = this.tiles.get(tileKey(z, tx, ty));
      if (!tile || tile.status !== 'loaded') return null;
      const localX = mxC * n - tx;
      const localY = myC * n - ty;
      const px = localX * tile.W;
      const py = localY * tile.H;
      const x0i = Math.floor(px);
      const x0c = Math.max(0, Math.min(tile.W - 1, x0i));
      const x1c = Math.min(tile.W - 1, x0c + 1);
      const y0c = Math.max(0, Math.min(tile.H - 1, Math.floor(py)));
      const y1c = Math.min(tile.H - 1, y0c + 1);
      const fx = px - x0i;
      const fy = py - Math.floor(py);
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy, w11 = fx * fy;
      const i00 = y0c * tile.W + x0c, i01 = y0c * tile.W + x1c;
      const i10 = y1c * tile.W + x0c, i11 = y1c * tile.W + x1c;
      // NaN-aware bilinear: skip cells where the source value is NaN
      // (no-data sentinel for land in ocean datasets) and renormalize the
      // remaining weights. If less than ~10% of the kernel is valid, treat
      // as off-data so the caller can recycle the particle.
      const u00 = tile.u[i00], u01 = tile.u[i01], u10 = tile.u[i10], u11 = tile.u[i11];
      let wSum = 0, uSum = 0, vSum = 0;
      if (u00 === u00) { wSum += w00; uSum += w00 * u00; vSum += w00 * tile.v[i00]; }
      if (u01 === u01) { wSum += w01; uSum += w01 * u01; vSum += w01 * tile.v[i01]; }
      if (u10 === u10) { wSum += w10; uSum += w10 * u10; vSum += w10 * tile.v[i10]; }
      if (u11 === u11) { wSum += w11; uSum += w11 * u11; vSum += w11 * tile.v[i11]; }
      if (wSum < 0.1) return null;
      return { u: uSum / wSum, v: vSum / wSum };
    },

    /** Returns `{ u, v }` for the (mx, my) sample, or null if the point
     *  is masked land / on no-data. Two-stage:
     *    1. Check the landmask at maskTargetZ. If 'land', return null —
     *       no need to sample data.
     *    2. Sample the data tile at targetZ (with the loaded-tile walk-down
     *       fallback). The data tile's own no-data sentinels still bite
     *       on HYCOM-NaN cells, but ordinary coastal masking comes from
     *       the (potentially finer) landmask above.
     *  'unknown' (no landmask tile loaded at any z) is treated as ocean —
     *  optimistic, so particles don't disappear during the brief window
     *  between first paint and landmask-tile arrival.  */
    sampleWind(this: StreamlinesLayerThis, mx: number, my: number): { u: number; v: number } | null {
      if (this.sampleLandmask(mx, my) === 'land') return null;
      const mxC = posMod(mx, 1);
      const myC = Math.max(0, Math.min(1 - 1e-9, my));
      for (let z = this.targetZ; z >= 0; z--) {
        const n = 2 ** z;
        const tx = Math.floor(mxC * n);
        const ty = Math.floor(myC * n);
        const tile = this.tiles.get(tileKey(z, tx, ty));
        if (!tile || tile.status !== 'loaded') continue;
        return this.sampleWindAtZoom(mx, my, z);
      }
      return null;
    },

    inViewport(this: StreamlinesLayerThis, mx: number, my: number, margin: number = SEED_MARGIN): boolean {
      // Globe low-zoom regime: "viewport" is the visible cap on the sphere,
      // not a rectangular bbox. Use the same plane equation the shader uses
      // for back-cull so particles drifting off-cap recycle immediately.
      // Globe high-zoom regime and mercator both have an accurate
      // rectangular bbox in `this.viewport` — fall through to the bbox test.
      const pt = this._lastProjectionTransition;
      if (pt !== undefined && pt > 0 && !this._globeBboxMode) {
        return this._isFrontFacing(mx, my);
      }
      const v = this.viewport;
      if (!v) return true;
      const sx = v.mxMax - v.mxMin;
      const sy = v.myMax - v.myMin;
      return mx >= v.mxMin - margin * sx && mx <= v.mxMax + margin * sx
          && my >= v.myMin - margin * sy && my <= v.myMax + margin * sy;
    },

    updateParticles(this: StreamlinesLayerThis): void {
      // Mercator: scale speed by 2^(-zoom) so particles move at consistent
      // pixel speed across zoom levels. Globe: getZoom() decreases as the
      // user tilts (MapLibre reinterprets perceived scale), so a naive
      // 0.5^zoom inflates the step when tilting and particles visibly speed
      // up. Cap at 0.25 (= 0.5^2) so that at low zoom (where tilt happens)
      // the factor is constant, and at high zoom (where the globe has
      // flattened to a Mercator strip and pixel-density grows with zoom) we
      // get true Mercator scaling — without which jet-stream winds at zoom
      // 5+ skip multiple pixels per frame and the trail becomes dotted.
      const isGlobe = this._isGlobe;
      const zoom = this.map.getZoom();
      const eff = isGlobe
        ? this.speedScale * Math.min(0.25, Math.pow(0.5, zoom))
        : this.speedScale * Math.pow(0.5, zoom);
      // Per-frame step is FLOORED in screen pixels so the animation stays
      // legible regardless of the field's true dynamic range (visual
      // correctness over accuracy — color-by-speed still encodes true speed
      // via p.speed, which the clamp never touches). The floor keeps
      // near-calm particles drifting visibly instead of sitting still and
      // popping out of existence. There is NO max cap: segments connect
      // prev→cur, so a fast particle draws a long continuous streak rather
      // than skipping pixels into polka-dots — the very problem a cap used to
      // (imperfectly) paper over. Genuine zero (u==v==0) stays put via the
      // `stepMag > 0` guard.
      //
      // Measure device-px-per-mercator from the LIVE projection at the screen
      // centre, NOT the viewport bbox: on the globe the bbox can span most of
      // the world while the zoomed-in centre fills the screen, so a
      // bbox-derived scale is wildly off exactly where the fast equatorial
      // currents are.
      const v = this.viewport;
      if (!v) return;
      const canvas = this.map.getCanvas();
      const dpr = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
      const ctr = this.map.getCenter();
      const EPS_LNG = 0.1;
      const pa = this.map.project([ctr.lng - EPS_LNG, ctr.lat]);
      const pb = this.map.project([ctr.lng + EPS_LNG, ctr.lat]);
      const screenDevPx = Math.hypot(pb.x - pa.x, pb.y - pa.y) * dpr;
      const mercDelta = (2 * EPS_LNG) / 360; // mercator-x span of 2·EPS_LNG° lng
      const pxPerMercator = (screenDevPx > 1e-6 && mercDelta > 1e-12)
        ? screenDevPx / mercDelta
        : canvas.width / Math.max(v.mxMax - v.mxMin, 1e-9); // bbox fallback
      const minStepMercator = MIN_STEP_PIXELS / pxPerMercator;
      // Probability a dead particle attempts to re-seed this frame. Set to
      // ~1/maxAge so dead-recycle rate matches live-recycle rate (dominated
      // by aging) — that's what gives steady-state live count ≈ N × ocean
      // fraction. Retrying every frame would mean dead particles flood
      // back to ocean almost instantly, regenerating the cram-into-ocean
      // density problem this is meant to fix.
      const deadReviveProb = 1 / Math.max(1, this.maxAge);
      for (const p of this.particles) {
        // Dead particles: rate-limited revival attempt. Camera-state-driven
        // initParticles handles viewport changes; this slow drip handles
        // tiles loading in and small viewport drifts.
        if (p.speed < 0) {
          if (Math.random() < deadReviveProb) {
            const seed = this.makeParticle();
            p.mx = seed.mx;
            p.my = seed.my;
            p.pmx = seed.pmx;
            p.pmy = seed.pmy;
            p.age = seed.age;
            p.speed = seed.speed;
          }
          continue;
        }
        const w = this.sampleWind(p.mx, p.my);
        let recycle = w === null;
        if (!recycle && w) {
          p.speed = Math.sqrt(w.u * w.u + w.v * w.v); // TRUE speed (drives color)
          let dx = w.u * eff;
          let dy = -w.v * eff;
          const stepMag = Math.sqrt(dx * dx + dy * dy);
          // Floor the step (preserving direction) so slow particles still
          // drift; genuine zero stays zero.
          if (stepMag > 0 && stepMag < minStepMercator) {
            const s = minStepMercator / stepMag;
            dx *= s;
            dy *= s;
          }
          p.pmx = p.mx;
          p.pmy = p.my;
          p.mx += dx;
          p.my += dy;
          p.age++;
          recycle = (
            p.my < 0.005 || p.my > 0.995 ||
            p.age > this.maxAge ||
            !this.inViewport(p.mx, p.my)
          );
        }
        if (recycle) {
          const seed = this.makeParticle();
          p.mx = seed.mx;
          p.my = seed.my;
          p.pmx = seed.pmx;
          p.pmy = seed.pmy;
          p.age = seed.age;
          p.speed = seed.speed;  // 0 for live seed, -1 for dead seed
        }
      }
    },

    rebuildVertices(this: StreamlinesLayerThis): void {
      // Pack particle positions as deltas from the viewport-centre origin
      // (instead of absolute mercator coords) so float32 quantization
      // doesn't collapse per-frame motion at high zoom. See the comment
      // on `u_origin` in streamlines-points.vert for the precision math.
      const v = this.viewport;
      if (!v) return;
      const originMx = 0.5 * (v.mxMin + v.mxMax);
      const originMy = 0.5 * (v.myMin + v.myMax);
      this.coordOrigin = [originMx, originMy];
      const data = this.vertData;
      let idx = 0;
      for (const p of this.particles) {
        // Per instance: prev delta, cur delta, speed. Both endpoints are
        // deltas from the same origin so the shader's split-precision sum
        // holds for each.
        data[idx++] = p.pmx - originMx;
        data[idx++] = p.pmy - originMy;
        data[idx++] = p.mx - originMx;
        data[idx++] = p.my - originMy;
        data[idx++] = p.speed || 0;
      }
    },

    /** Compile (or recompile) the points program when the projection
     *  variant changes (Mercator ↔ globe under MapLibre, or MapLibre ↔
     *  Mapbox host). `normalised` comes from normalizeRenderArgs(). */
    _ensurePointsProgram(this: StreamlinesLayerThis, gl: WebGL2RenderingContext, normalised: NormalisedRenderArgs): void {
      const variant = normalised.shaderData.variantName;
      if (this.pointsProgram && this.pointsProgramVariant === variant) return;
      if (this.pointsProgram) gl.deleteProgram(this.pointsProgram);
      this.pointsProgram = buildPointsProgram(gl, normalised.shaderData, GPU_SIM);
      this.pointsProgramVariant = variant;
      const p = this.pointsProgram;
      // a_prev/a_cur/a_speed exist only in the CPU-sim variant; -1 in GPU mode.
      this.pointsAttrPrev = gl.getAttribLocation(p, 'a_prev');
      this.pointsAttrCur = gl.getAttribLocation(p, 'a_cur');
      this.pointsAttrSpeed = gl.getAttribLocation(p, 'a_speed');
      this.pointsAttrCorner = gl.getAttribLocation(p, 'a_corner');
      // GPU_SIM position-texture samplers + decode uniforms (null when off).
      this.pointsUPosPrev = gl.getUniformLocation(p, 'u_posPrev');
      this.pointsUPosCur = gl.getUniformLocation(p, 'u_posCur');
      this.pointsUVelTexSpeed = gl.getUniformLocation(p, 'u_velTex');
      this.pointsUTexW = gl.getUniformLocation(p, 'u_texW');
      this.pointsUSeedOrigin = gl.getUniformLocation(p, 'u_seedOrigin');
      this.pointsUSeedSpan = gl.getUniformLocation(p, 'u_seedSpan');
      this.pointsUDecScale = gl.getUniformLocation(p, 'u_decScale');
      this.pointsUDecOffset = gl.getUniformLocation(p, 'u_decOffset');
      this.pointsUOrigin = gl.getUniformLocation(p, 'u_origin');
      this.pointsUOriginClip = gl.getUniformLocation(p, 'u_origin_clip');
      this.pointsUOpacity = gl.getUniformLocation(p, 'u_opacity');
      this.pointsUViewport = gl.getUniformLocation(p, 'u_viewport');
      this.pointsULineWidth = gl.getUniformLocation(p, 'u_lineWidth');
      this.pointsUVmin = gl.getUniformLocation(p, 'u_vmin');
      this.pointsUVmax = gl.getUniformLocation(p, 'u_vmax');
      this.pointsUColorBySpeed = gl.getUniformLocation(p, 'u_colorBySpeed');
      this.pointsUColormap = gl.getUniformLocation(p, 'u_colormap');
      // Projection uniforms declared by the prelude.
      this.pointsUProjMatrix = gl.getUniformLocation(p, 'u_projection_matrix');
      this.pointsUProjTileCoords = gl.getUniformLocation(p, 'u_projection_tile_mercator_coords');
      this.pointsUProjClipping = gl.getUniformLocation(p, 'u_projection_clipping_plane');
      this.pointsUProjTransition = gl.getUniformLocation(p, 'u_projection_transition');
      this.pointsUProjFallback = gl.getUniformLocation(p, 'u_projection_fallback_matrix');
      // Mapbox-globe-only uniforms — null under MapLibre / Mapbox-Mercator.
      this.pointsUMapboxGlobeToMercator = gl.getUniformLocation(p, 'u_mapbox_globe_to_mercator');
      this.pointsUMapboxGlobeTransition = gl.getUniformLocation(p, 'u_mapbox_globe_transition');
      this.pointsUMapboxCenterMercator = gl.getUniformLocation(p, 'u_mapbox_center_mercator');
    },

    _setProjectionUniforms(this: StreamlinesLayerThis, gl: WebGL2RenderingContext, normalised: NormalisedRenderArgs): void {
      if (normalised.isMapbox) {
        if (this.pointsUProjMatrix) gl.uniformMatrix4fv(this.pointsUProjMatrix, false, normalised.matrix);
        if (normalised.isMapboxGlobe && normalised.mapboxExtras) {
          const e = normalised.mapboxExtras;
          // isMapboxGlobe is true ⇒ projectionToMercatorMatrix is set
          // (that's how the flag is derived in normalizeRenderArgs).
          // TS can't follow the discriminator across the boundary so
          // we assert.
          if (this.pointsUMapboxGlobeToMercator) gl.uniformMatrix4fv(this.pointsUMapboxGlobeToMercator, false, e.projectionToMercatorMatrix!);
          if (this.pointsUMapboxGlobeTransition !== null) gl.uniform1f(this.pointsUMapboxGlobeTransition, e.projectionToMercatorTransition ?? 1.0);
          if (this.pointsUMapboxCenterMercator) gl.uniform2fv(this.pointsUMapboxCenterMercator, e.centerInMercator ?? [0, 0]);
        }
        return;
      }
      const pd = normalised.defaultProjectionData;
      if (!pd) return;
      if (this.pointsUProjMatrix) gl.uniformMatrix4fv(this.pointsUProjMatrix, false, pd.mainMatrix);
      if (this.pointsUProjTileCoords) gl.uniform4fv(this.pointsUProjTileCoords, pd.tileMercatorCoords);
      if (this.pointsUProjClipping) gl.uniform4fv(this.pointsUProjClipping, pd.clippingPlane);
      if (this.pointsUProjTransition !== null) gl.uniform1f(this.pointsUProjTransition, pd.projectionTransition);
      if (this.pointsUProjFallback) gl.uniformMatrix4fv(this.pointsUProjFallback, false, pd.fallbackMatrix);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(this: StreamlinesLayerThis, gl: WebGL2RenderingContext, args: unknown, ...rest: any[]): void {
      // `args` is the MapLibre 5 args-object OR the Mapbox bare MVP
      // matrix. Trailing positional args are Mapbox-only and set when
      // projection === 'globe'.
      const [projection, projectionToMercatorMatrix, projectionToMercatorTransition, centerInMercator, pixelsPerMeterRatio] = rest;
      const n: NormalisedRenderArgs = normalizeRenderArgs(args, {
        projection,
        projectionToMercatorMatrix,
        projectionToMercatorTransition,
        centerInMercator,
        pixelsPerMeterRatio,
      });
      this._ensurePointsProgram(gl, n);
      // Cache projection state used by computeViewport, makeParticle,
      // inViewport, ensureVisibleTilesLoading. Under MapLibre we get
      // both fields straight from defaultProjectionData. Under Mapbox
      // globe we synthesise the transition (Mapbox's
      // projectionToMercatorTransition is inverted from MapLibre's:
      // 0=globe, 1=mercator — we want "pt > 0 ⇒ globe", so 1 - that)
      // AND synthesise the clipping plane from camera geometry so
      // cap-aware seeding works on Mapbox too (see
      // _synthesizeMapboxClippingPlane). Without it ~half the particles
      // seed onto the invisible back face.
      if (n.isMapboxGlobe && n.mapboxExtras) {
        this._lastProjectionTransition =
          1 - (n.mapboxExtras.projectionToMercatorTransition ?? 0);
        this._lastClippingPlane = this._synthesizeMapboxClippingPlane(
          n.mapboxExtras.centerInMercator,
        );
      } else {
        this._lastProjectionTransition = n.defaultProjectionData?.projectionTransition;
        this._lastClippingPlane = n.defaultProjectionData?.clippingPlane;
      }

      const proj = this.map.getProjection?.();
      this._isGlobe = proj?.type === 'globe' || proj?.name === 'globe';

      // Per-frame camera-state key drives two things: the move/settle trail
      // handling below, and whether we can SKIP the per-frame viewport +
      // visible-tile recompute. On a static map (the common "parked, watching
      // the flow" case) the camera is unchanged, so computeViewport's ~8
      // unprojects and ensureVisibleTilesLoading's tile-set rescan are pure
      // waste — only the particle sim + GL passes need to run each frame.
      // We watch zoom/center/pitch/bearing per frame rather than hooking
      // 'move'/'zoomend' because those events lag the camera by hundreds of
      // ms — long enough for a ghost box of particles to accumulate in the
      // post-move trail buffer before an event-driven reseed could fire.
      const cam = this.map;
      const c = cam.getCenter();
      const cameraKey = `${cam.getZoom()}|${c.lng}|${c.lat}|${cam.getPitch()}|${cam.getBearing()}`;
      const cameraChanged = this._prevCameraKey !== cameraKey;

      if (cameraChanged || !this.viewport) {
        this.computeViewport();
        this.ensureVisibleTilesLoading();
      }
      const ready = GPU_SIM ? this._gpuReady : this.particles.length > 0;
      if (!ready) {
        this.map.triggerRepaint();
        return;
      }
      this.setupFramebuffers();

      // While the camera is changing, wipe trails each frame so stale
      // screen-space pixels don't smear. The first frame after motion stops
      // is the cue to reseed into the new viewport — the camera has visually
      // settled by now, well before MapLibre's zoomend. The GPU path also
      // rebuilds its per-view velocity texture there (skipped mid-move).
      if (this._prevCameraKey !== null && cameraChanged) {
        this.clearTrailBuffers();
        this._cameraMoving = true;
      } else if (this._cameraMoving) {
        if (GPU_SIM) {
          this._computeSeedBbox();
          this.assembleVelTex();
          this.fullReseedGpu();
        } else {
          this.initParticles();
        }
        this.clearTrailBuffers();
        this._cameraMoving = false;
      }
      this._prevCameraKey = cameraKey;

      if (GPU_SIM) {
        // The seed bbox is NOT recomputed per-frame — it's frozen between
        // settles (see the settle branch). Recomputing it every frame would
        // move the viewport-local coordinate frame with the camera, pinning
        // particles to the screen during a drag (they'd stop tracking the
        // map). Frozen, decoded positions are fixed mercator and the live
        // projection matrix tracks them with the map.
        if (this._velDirty && !this._cameraMoving) {
          this.assembleVelTex();
          this._velDirty = false;
        }
        // Reseeding draws from makeParticle (live viewport) but encodes in the
        // frozen frame, so skip it mid-move; the settle full-reseed covers it.
        if (!this._cameraMoving) this.reseedRoundRobinGpu();
        this.simStepGpu(gl);
      } else {
        this.updateParticles();
        this.rebuildVertices();
      }

      if (!this.fbA || !this.fbB || !this.pointsProgram) return;

      const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const savedViewport = gl.getParameter(gl.VIEWPORT);

      // 1. Render into fbA: faded copy of fbB + new line segments on top.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbA.fb);
      gl.viewport(0, 0, this.fbW, this.fbH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // 1a. Fade-copy fbB → fbA (no blend; direct write of input * FADE).
      gl.disable(gl.BLEND);
      gl.useProgram(this.fadeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.enableVertexAttribArray(this.fadeAttrPos);
      gl.vertexAttribPointer(this.fadeAttrPos, 2, gl.FLOAT, false, 0, 0);
      if (this.fadeUFade) gl.uniform1f(this.fadeUFade, this.fade);
      if (this.fadeUTex) gl.uniform1i(this.fadeUTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fbB.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 1b. Add new segments additively (premultiplied; ONE/ONE). Each
      // particle is ONE instance; the 6-vertex corner buffer expands its
      // prev→cur into a screen-space quad in the vertex shader.
      gl.useProgram(this.pointsProgram);

      if (GPU_SIM) {
        // Positions come from the ping-pong textures (prev = FRONT, cur =
        // BACK after the sim) plus the velocity texture for color-by-speed.
        // Units 0/1 are used by the fade/composite + colormap; bind ours on
        // 2/3/4. No per-instance attributes.
        const front = this._posFrontIsA ? this.posTexA : this.posTexB;
        const back = this._posFrontIsA ? this.posTexB : this.posTexA;
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, front);
        if (this.pointsUPosPrev) gl.uniform1i(this.pointsUPosPrev, 2);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, back);
        if (this.pointsUPosCur) gl.uniform1i(this.pointsUPosCur, 3);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this.velTex);
        if (this.pointsUVelTexSpeed) gl.uniform1i(this.pointsUVelTexSpeed, 4);
        if (this.pointsUTexW) gl.uniform1i(this.pointsUTexW, this.texW);
        if (this.pointsUSeedOrigin) gl.uniform2f(this.pointsUSeedOrigin, this._seedOx, this._seedOy);
        if (this.pointsUSeedSpan) gl.uniform2f(this.pointsUSeedSpan, this._seedSx, this._seedSy);
        if (this.pointsUDecScale) gl.uniform1f(this.pointsUDecScale, opts.encoding.scale);
        if (this.pointsUDecOffset) gl.uniform1f(this.pointsUDecOffset, opts.encoding.offset);
      } else {
        // Per-instance attributes (divisor 1): prev (vec2), cur (vec2), speed.
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsVbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertData);
        const stride = 5 * 4;
        gl.enableVertexAttribArray(this.pointsAttrPrev);
        gl.vertexAttribPointer(this.pointsAttrPrev, 2, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(this.pointsAttrPrev, 1);
        gl.enableVertexAttribArray(this.pointsAttrCur);
        gl.vertexAttribPointer(this.pointsAttrCur, 2, gl.FLOAT, false, stride, 2 * 4);
        gl.vertexAttribDivisor(this.pointsAttrCur, 1);
        gl.enableVertexAttribArray(this.pointsAttrSpeed);
        gl.vertexAttribPointer(this.pointsAttrSpeed, 1, gl.FLOAT, false, stride, 4 * 4);
        gl.vertexAttribDivisor(this.pointsAttrSpeed, 1);
      }

      // Per-vertex corner (end, side) — divisor 0 (advances per vertex).
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerVbo);
      gl.enableVertexAttribArray(this.pointsAttrCorner);
      gl.vertexAttribPointer(this.pointsAttrCorner, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(this.pointsAttrCorner, 0);

      this._setProjectionUniforms(gl, n);
      if (this.coordOrigin) {
        const [ox, oy] = this.coordOrigin;
        if (this.pointsUOrigin) {
          gl.uniform2f(this.pointsUOrigin, ox, oy);
        }
        if (this.pointsUOriginClip) {
          // Compute the origin's clip-space coords on the CPU using JS
          // float64. MapLibre's matrix arrives as Float32Array (each
          // entry has float32 ULP), but the multiply-and-cancellation
          // happens in float64 here, so the result has the precision of
          // the float32 inputs rather than the much-worse precision of
          // float32 arithmetic on values that almost cancel.
          const m: Mat4Like | undefined = n.isMapbox ? n.matrix : n.defaultProjectionData?.mainMatrix;
          if (m) {
            const cx = m[0]*ox + m[4]*oy + m[12];
            const cy = m[1]*ox + m[5]*oy + m[13];
            const cz = m[2]*ox + m[6]*oy + m[14];
            const cw = m[3]*ox + m[7]*oy + m[15];
            gl.uniform4f(this.pointsUOriginClip, cx, cy, cz, cw);
          } else {
            gl.uniform4f(this.pointsUOriginClip, 0, 0, 0, 1);
          }
        }
      }
      if (this.pointsUOpacity) gl.uniform1f(this.pointsUOpacity, 1.0);
      if (this.pointsUViewport) gl.uniform2f(this.pointsUViewport, this.fbW, this.fbH);
      // Line width is in trail-FBO pixels (u_viewport is the FBO size), so
      // scale it with the trail resolution to keep the on-screen width fixed.
      if (this.pointsULineWidth) gl.uniform1f(this.pointsULineWidth, this.pointSize * this.trailScale);
      if (this.pointsUVmin) gl.uniform1f(this.pointsUVmin, this.vmin);
      if (this.pointsUVmax) gl.uniform1f(this.pointsUVmax, this.vmax);
      if (this.pointsUColorBySpeed) gl.uniform1f(this.pointsUColorBySpeed, this.colorBySpeed ? 1.0 : 0.0);
      // Colormap LUT texture on unit 1 (the points pass binds nothing else).
      if (this.pointsUColormap) {
        if (this.colormapDirty || !this.colormapTexture) {
          this.colormapTexture = uploadColormapTexture(gl, this.colormapData, this.colormapTexture);
          this.colormapDirty = false;
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
        gl.uniform1i(this.pointsUColormap, 1);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.N);
      if (!GPU_SIM) {
        // Reset per-instance divisors right away: they live on the shared
        // default VAO, so a leaked divisor=1 would corrupt the composite pass
        // below (and the next layer), which draw with plain divisor-0 arrays.
        gl.vertexAttribDivisor(this.pointsAttrPrev, 0);
        gl.vertexAttribDivisor(this.pointsAttrCur, 0);
        gl.vertexAttribDivisor(this.pointsAttrSpeed, 0);
      }

      // 2. Composite fbA to screen with premultiplied alpha blend.
      gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo);
      gl.viewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);

      gl.useProgram(this.compositeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.enableVertexAttribArray(this.compositeAttrPos);
      gl.vertexAttribPointer(this.compositeAttrPos, 2, gl.FLOAT, false, 0, 0);
      if (this.compositeUOpacity) gl.uniform1f(this.compositeUOpacity, this.opacity);
      if (this.compositeUTex) gl.uniform1i(this.compositeUTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fbA.tex);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Disable every attribute array we touched across the three passes
      // so none leak into the next layer's draw on the shared default
      // VAO. Critical on removal: onRemove deletes pointsVbo/quadVbo, and
      // a still-enabled array pointing at a deleted buffer makes the next
      // layer's drawArrays throw INVALID_OPERATION.
      gl.disableVertexAttribArray(this.fadeAttrPos);
      if (!GPU_SIM) {
        gl.disableVertexAttribArray(this.pointsAttrPrev);
        gl.disableVertexAttribArray(this.pointsAttrCur);
        gl.disableVertexAttribArray(this.pointsAttrSpeed);
      }
      gl.disableVertexAttribArray(this.pointsAttrCorner);
      gl.disableVertexAttribArray(this.compositeAttrPos);

      // 3. Swap framebuffers for next frame.
      const tmp = this.fbA;
      this.fbA = this.fbB;
      this.fbB = tmp;
      // Swap the position ping-pong: this frame's BACK (just-advected) becomes
      // next frame's FRONT (prev).
      if (GPU_SIM) this._posFrontIsA = !this._posFrontIsA;

      this.map.triggerRepaint();
    },
  };
}
