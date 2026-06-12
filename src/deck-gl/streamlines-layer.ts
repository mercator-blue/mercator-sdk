// Animated flow-particle layer for vector_rg_ba datasets (wind,
// currents) in deck.gl. Port of `streamlines-layer.js`: same CPU
// particle simulation (advection by sampled u/v from the tile cache,
// age-based recycling, viewport-aware reseeding). Rendering uses raw
// WebGL via `device.gl` rather than luma.gl 9's Model — luma.gl 9
// requires std140 uniform blocks with strict padding rules and a
// different draw-call shape, which made the port noticeably more
// surface area than the equivalent Mapbox/MapLibre custom layer. The
// raw-WebGL path keeps the shader code identical to the Mapbox
// binding's POINTS_VS/FS and lets us drop the offscreen FBO trail
// pipeline in a follow-up without restructuring the layer.
//
// First pass: moving points (no trail buffer yet). The FBO ping-pong
// + fade + composite lands in a follow-up commit — trails matter
// visually but aren't needed to prove the sim + projection + lifecycle
// plumbing work.
//
// Vector-only. Throws on scalar encodings. Globe projection isn't
// supported on the deck.gl binding (see CLAUDE.md host-support table).

import { Layer, type DefaultProps, type LayerContext } from '@deck.gl/core';

import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, DEFAULT_CATALOG_URL } from '../core/urls';
import { loadTilePixels } from '../core/tile-pixel-reader';
import { resolveColormap, COLORMAP_SIZE } from '../core/color/colormaps';
import { lngLatToMercator, posMod } from '../core/mercator';
import type { ColormapSpec } from '../core/types';
import { createProgram } from '../core/webgl-helpers';
import {
  STREAMLINES_SIM_VS as SIM_VS,
  STREAMLINES_SIM_FS as SIM_FS,
} from '../core/shaders/index';


const SEED_MARGIN = 0.2;

// Resolution of the per-view velocity texture the GPU sim samples (assembled
// on the CPU on viewport change). Matches the other bindings.
const VEL_TEX_SIZE = 512;

// Splice a `#define` in right after the `#version` directive (the literal first
// line), to compile the points program with GPU_SIM.
function injectDefine(src: string, define: string): string {
  if (!define) return src;
  const nl = src.indexOf('\n');
  return src.slice(0, nl + 1) + define + '\n' + src.slice(nl + 1);
}
const DEFAULT_PARTICLE_COUNT = 4000;
const DEFAULT_POINT_SIZE = 3;
const DEFAULT_MAX_AGE_FRAMES = 600;
const DEFAULT_OPACITY = 0.85;
const DEFAULT_SPEED_SCALE = 6e-5;
const DEFAULT_FADE = 0.99;

// Per-frame step floor, in device pixels. Slower particles are sped up to
// this (preserving direction) so calm regions still drift visibly instead
// of freezing and popping out; genuine zero stays zero. There is NO max
// counterpart — segment quads make trails continuous at any speed (the old
// `0.7 × pointSize` max cap is gone). Matches the other bindings.
const MIN_STEP_PIXELS = 0.5;

// --- Module-level caches ---------------------------------------------

const discoveryCache = new Map<string, DiscoveredItem | Promise<DiscoveredItem>>();
const discoveryKey = (catalogUrl: string, dataset: string) =>
  `${catalogUrl}|${dataset}`;

interface TilePixels {
  width: number;
  height: number;
  u: Float32Array;
  v: Float32Array;
}
type CacheEntry = TilePixels | 'loading' | 'error';

const tilePixelCache = new Map<string, CacheEntry>();

function ensureTilePixels(
  url: string,
  scale: number,
  offset: number,
  onLoad: () => void,
): TilePixels | null {
  const existing = tilePixelCache.get(url);
  if (existing && typeof existing === 'object') return existing;
  if (existing === 'loading' || existing === 'error') return null;

  tilePixelCache.set(url, 'loading');
  loadTilePixels(url)
    .then(({ width: W, height: H, pixels }) => {
      const u = new Float32Array(W * H);
      const v = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) {
        const r = pixels[i * 4];
        const g = pixels[i * 4 + 1];
        const b = pixels[i * 4 + 2];
        const a = pixels[i * 4 + 3];
        if ((r | g | b | a) === 0) {
          u[i] = NaN;
          v[i] = NaN;
        } else {
          u[i] = (r * 256 + g) * scale + offset;
          v[i] = (b * 256 + a) * scale + offset;
        }
      }
      tilePixelCache.set(url, { width: W, height: H, u, v });
      onLoad();
    })
    .catch(() => {
      tilePixelCache.set(url, 'error');
    });
  return null;
}

// --- Shaders (GLSL 3.00 ES, raw WebGL2) -----------------------------

// Particles are projected on CPU (see _packVertexData) and arrive in clip
// space directly (perspective-divided, so w = 1). Trade: a manual
// pixelProjectionMatrix multiply per particle per frame (negligible at our
// counts), in exchange for sidestepping deck.gl's COMMON-coord /
// split-precision matrix pipeline.
//
// Each particle is ONE instance; the 6 per-vertex `a_corner` values (two
// triangles of a unit quad) expand the particle's prev->cur move into a
// screen-space quad of width u_lineWidth, with half-width square end-caps
// so consecutive frames' segments overlap into a continuous trail and a
// stationary particle still renders as a dot. Drawing the per-frame MOVE
// as a connected quad (rather than a GL_POINT) makes trails continuous at
// ANY speed — fast particles draw long segments instead of skipping pixels
// — so no max-speed cap is needed.
const POINTS_VS = `#version 300 es
#ifdef GPU_SIM
// GPU-simulation input: prev/cur positions come from ping-pong RGBA8 position
// textures (one texel per particle, indexed by gl_InstanceID), not attributes.
// Positions are viewport-local 16-bit/axis; decode -> slippy mercator, then
// project to clip IN the VS (the CPU _packVertexData path is skipped). Speed
// for colour is sampled from the velocity texture at the cur position.
uniform sampler2D u_posPrev;
uniform sampler2D u_posCur;
uniform sampler2D u_velTex;
uniform int u_texW;            // position-texture width (texels)
uniform vec2 u_seedOrigin;     // slippy-mercator origin of the padded seed bbox
uniform vec2 u_seedSpan;       // slippy-mercator span of the padded seed bbox
uniform float u_decScale;      // velocity encoding scale (for speed/colour)
uniform float u_decOffset;     // velocity encoding offset
uniform mat4 u_pixProj;        // viewport.pixelProjectionMatrix (COMMON -> pixel)
uniform vec2 u_viewportPx;     // viewport.width/height (CSS px) for the NDC divide

float dec16(float hi, float lo) { return (hi * 255.0 * 256.0 + lo * 255.0) / 65535.0; }
vec2 decodeLocal(vec4 p) { return vec2(dec16(p.r, p.g), dec16(p.b, p.a)); }
float speedAt(vec2 uv) {
  vec4 t = texture(u_velTex, uv);            // NEAREST: no byte-boundary interp
  if (t == vec4(0.0)) return 0.0;            // no-data sentinel
  float u = (t.r * 255.0 * 256.0 + t.g * 255.0) * u_decScale + u_decOffset;
  float v = (t.b * 255.0 * 256.0 + t.a * 255.0) * u_decScale + u_decOffset;
  return length(vec2(u, v));
}
// Slippy (mx, my) -> clip NDC. Returns false when behind the camera (w<=0).
// deck COMMON y INCREASES north, our my is slippy (0 north, 1 south), so flip:
// cy = (1 - my) * 512. COMMON magnitude is small (<=512), so absolute float32
// projection is precise enough at our zooms — no delta-from-origin trick.
bool projectClip(vec2 merc, out vec2 clip) {
  float cx = merc.x * 512.0;
  float cy = (1.0 - merc.y) * 512.0;
  vec4 p = u_pixProj * vec4(cx, cy, 0.0, 1.0);
  if (!(p.w > 0.0)) return false;
  vec2 px = p.xy / p.w;
  clip = vec2(px.x / u_viewportPx.x * 2.0 - 1.0, 1.0 - px.y / u_viewportPx.y * 2.0);
  return true;
}
#else
in vec2 a_prevClip;   // per-instance: previous position, clip space (w=1)
in vec2 a_curClip;    // per-instance: current  position, clip space (w=1)
in float a_speed;     // per-instance: true speed; < 0 = dead sentinel
#endif
in vec2 a_corner;     // per-vertex: (end, side) — end 0=prev 1=cur, side -1/+1

uniform vec2 u_viewport;    // device px (trail-FBO size)
uniform float u_lineWidth;  // device px (full segment width)

out float v_speed;
out float v_edge;           // signed cross-line coord (-1..1) for edge AA

void main() {
#ifdef GPU_SIM
  ivec2 texel = ivec2(gl_InstanceID % u_texW, gl_InstanceID / u_texW);
  vec4 pPrev = texelFetch(u_posPrev, texel, 0);
  vec4 pCur  = texelFetch(u_posCur,  texel, 0);
  bool dead = (pPrev == vec4(0.0)) || (pCur == vec4(0.0));   // all-zero sentinel
  vec2 localCur = decodeLocal(pCur);
  vec2 a_prevClip, a_curClip;
  bool okP = projectClip(u_seedOrigin + decodeLocal(pPrev) * u_seedSpan, a_prevClip);
  bool okC = projectClip(u_seedOrigin + localCur * u_seedSpan, a_curClip);
  float a_speed = (dead || !okP || !okC) ? -1.0 : speedAt(localCur);
  // Teleport guard (screen-space, NDC): a freshly reseeded/recycled particle
  // can pair prev/cur from different ping-pong generations; collapse a segment
  // longer than ~half the screen (clip span ~1.0) to a dot. A legit per-frame
  // step is a few px (~0.006 clip), so this never touches real motion. NaN/Inf
  // also collapse via the negated comparison. Backstop for the sim barrier.
  if (a_speed >= 0.0 && !(distance(a_prevClip, a_curClip) < 1.0)) a_prevClip = a_curClip;
#endif
  if (a_speed < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_speed = -1.0;
    v_edge = 0.0;
    return;
  }

  // Endpoints already in clip space (w = 1); convert to pixel space to
  // build the screen-space tangent + perpendicular.
  vec2 pixPrev = a_prevClip * 0.5 * u_viewport;
  vec2 pixCur  = a_curClip  * 0.5 * u_viewport;

  vec2 tangent = pixCur - pixPrev;
  float tLen = length(tangent);
  // Degenerate (near-zero step): fixed axes so the caps draw a square dot
  // rather than collapsing to NaN.
  vec2 tdir   = tLen > 1e-4 ? tangent / tLen                     : vec2(1.0, 0.0);
  vec2 normal = tLen > 1e-4 ? vec2(-tangent.y, tangent.x) / tLen : vec2(0.0, 1.0);

  float end  = a_corner.x;   // 0 = prev, 1 = cur
  float side = a_corner.y;   // -1 / +1
  float halfW = u_lineWidth * 0.5;
  vec2 baseClip = mix(a_prevClip, a_curClip, end);

  // Perpendicular offset gives width; the longitudinal half-width cap
  // (prev backward, cur forward) makes consecutive segments overlap into a
  // seamless trail and turns a zero-length step into a centered dot.
  float along = end < 0.5 ? -1.0 : 1.0;
  vec2 offsetPx = normal * side * halfW + tdir * along * halfW;
  vec2 offsetClip = offsetPx / (0.5 * u_viewport);

  gl_Position = vec4(baseClip + offsetClip, 0.0, 1.0);
  v_speed = a_speed;
  v_edge = side;
}
`;

// Fullscreen quad: positions in [0, 1]², varying carries UV.
const QUAD_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  v_uv = a_pos;
}
`;

// Trail-buffer fade pass. Reads the previous-frame trail FBO, multiplies
// by u_fade, subtracts the 1/255 quantization floor so faint pixels
// actually decay to zero (otherwise an RGBA8 FBO holds a permanent veil
// because round(0.5 * 1/255) = round(0.5/255) snaps to 1/255 on write).
const FADE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_fade;
out vec4 fragColor;
void main() {
  vec4 v = texture(u_tex, v_uv) * u_fade;
  fragColor = max(v - vec4(0.6 / 255.0), vec4(0.0));
}
`;

// Composite the trail FBO over the main framebuffer with premultiplied
// alpha. u_opacity scales the entire layer's contribution.
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  fragColor = texture(u_tex, v_uv) * u_opacity;
}
`;

const POINTS_FS = `#version 300 es
precision highp float;

uniform sampler2D u_colormap;
uniform float u_vmin;
uniform float u_vmax;
uniform float u_colorBySpeed;
uniform float u_opacity;

in float v_speed;
in float v_edge;
out vec4 fragColor;

void main() {
  if (v_speed < 0.0) discard;
  // Soft perpendicular edge: full alpha in the core, fading to 0 at
  // |v_edge| = 1 over a ~1px band regardless of line width.
  float aa = max(fwidth(v_edge), 1e-4);
  float a = (1.0 - smoothstep(1.0 - aa, 1.0, abs(v_edge))) * u_opacity;
  if (a <= 0.0) discard;
  vec3 col;
  if (u_colorBySpeed > 0.5) {
    float span = max(u_vmax - u_vmin, 1e-6);
    float t = clamp((v_speed - u_vmin) / span, 0.0, 1.0);
    col = texture(u_colormap, vec2(t, 0.5)).rgb;
  } else {
    col = vec3(1.0);
  }
  fragColor = vec4(col * a, a);
}
`;

function makeFramebuffer(
  gl: WebGL2RenderingContext,
  W: number,
  H: number,
): { fb: WebGLFramebuffer; tex: WebGLTexture } {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex };
}

// --- Particle ------------------------------------------------------

interface Particle {
  mx: number;
  my: number;
  /** Previous-frame position. The segment renderer draws prev->cur as one
   *  continuous quad, so trails never gap regardless of speed. Seeded
   *  equal to mx/my (a fresh particle's first segment is a zero-length dot). */
  pmx: number;
  pmy: number;
  age: number;
  /** m/s. -1 marks a "dead" particle (no valid seed yet). */
  speed: number;
}

// --- Props --------------------------------------------------------

export interface MercatorStreamlinesLayerProps {
  dataset: string;
  apiKey: string;
  catalogUrl?: string;
  particleCount?: number;
  pointSize?: number;
  speedScale?: number;
  maxAge?: number;
  /** Trail-buffer fade per frame in [0, 1]. Closer to 1 = longer trails. */
  fade?: number;
  opacity?: number;
  colormap?: ColormapSpec;
  vmin?: number;
  vmax?: number;
  colorBySpeed?: boolean;
  /** Run the particle simulation on the GPU (texture GPGPU) instead of the CPU
   *  loop. Default true. Construction-time: changing it needs a fresh layer
   *  (different id) to take effect. Set false for the CPU sim. */
  gpuSim?: boolean;
  /** Render the trail buffer at this fraction of device resolution (0.1..1).
   *  Default 1. The trail fade + composite are full-canvas passes whose cost
   *  scales with pixel count; 0.5 quarters them for slightly softer trails. */
  trailResolutionScale?: number;
  id?: string;
}

const defaultProps: DefaultProps<MercatorStreamlinesLayerProps> = {
  dataset: '',
  apiKey: '',
  catalogUrl: DEFAULT_CATALOG_URL,
  particleCount: { type: 'number', value: DEFAULT_PARTICLE_COUNT },
  pointSize: { type: 'number', value: DEFAULT_POINT_SIZE },
  maxAge: { type: 'number', value: DEFAULT_MAX_AGE_FRAMES },
  fade: { type: 'number', min: 0, max: 1, value: DEFAULT_FADE },
  opacity: { type: 'number', min: 0, max: 1, value: DEFAULT_OPACITY },
  gpuSim: true,
  trailResolutionScale: { type: 'number', min: 0.1, max: 1, value: 1 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  colormap: 'viridis' as any,
  // vmin / vmax intentionally NOT defaulted in defaultProps. The
  // resolution chain in draw() is `this.props.vmax ?? item.visualization?.vmax ?? 1`,
  // and defaultProps would shadow the STAC fallback if it provided
  // any value — the user's "didn't pass anything" case would resolve
  // to the defaultProps value instead of the dataset author's.
  colorBySpeed: true,
};

// --- Layer --------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyState = Record<string, any>;

export class MercatorStreamlinesLayer extends Layer<MercatorStreamlinesLayerProps> {
  static layerName = 'MercatorStreamlinesLayer';
  static defaultProps = defaultProps;

  declare state: AnyState;

  private _getCachedItem(): DiscoveredItem | null {
    const { dataset, catalogUrl } = this.props;
    if (!dataset) return null;
    const cached = discoveryCache.get(discoveryKey(catalogUrl!, dataset));
    return cached && !(cached instanceof Promise) ? cached : null;
  }

  initializeState(context: LayerContext) {
    // Raw WebGL2 context — `device.gl` is luma.gl's escape hatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gl = (context.device as any).gl as WebGL2RenderingContext;
    if (!gl) throw new Error('@mercator-blue/sdk/deck-gl: MercatorStreamlinesLayer — WebGL2 context not available');

    // gpuSim is construction-time (read once here; see the prop doc).
    const gpuSim = this.props.gpuSim !== false;

    // Points program — animated segments. GPU_SIM variant reads positions from
    // the ping-pong textures + projects in the VS; CPU variant reads
    // per-instance clip attributes packed by _packVertexData.
    const program = createProgram(
      gl,
      injectDefine(POINTS_VS, gpuSim ? '#define GPU_SIM' : ''),
      POINTS_FS,
    );
    const attrPrev = gl.getAttribLocation(program, 'a_prevClip');
    const attrCur = gl.getAttribLocation(program, 'a_curClip');
    const attrSpeed = gl.getAttribLocation(program, 'a_speed');
    const attrCorner = gl.getAttribLocation(program, 'a_corner');
    const uViewport = gl.getUniformLocation(program, 'u_viewport');
    const uLineWidth = gl.getUniformLocation(program, 'u_lineWidth');
    const uColormap = gl.getUniformLocation(program, 'u_colormap');
    const uVmin = gl.getUniformLocation(program, 'u_vmin');
    const uVmax = gl.getUniformLocation(program, 'u_vmax');
    const uColorBySpeed = gl.getUniformLocation(program, 'u_colorBySpeed');
    const uOpacity = gl.getUniformLocation(program, 'u_opacity');
    // GPU_SIM points uniforms (null when gpuSim off).
    const uPosPrev = gl.getUniformLocation(program, 'u_posPrev');
    const uPosCur = gl.getUniformLocation(program, 'u_posCur');
    const uVelTexSpeed = gl.getUniformLocation(program, 'u_velTex');
    const uTexW = gl.getUniformLocation(program, 'u_texW');
    const uSeedOrigin = gl.getUniformLocation(program, 'u_seedOrigin');
    const uSeedSpan = gl.getUniformLocation(program, 'u_seedSpan');
    const uDecScale = gl.getUniformLocation(program, 'u_decScale');
    const uDecOffset = gl.getUniformLocation(program, 'u_decOffset');
    const uPixProj = gl.getUniformLocation(program, 'u_pixProj');
    const uViewportPx = gl.getUniformLocation(program, 'u_viewportPx');

    // Fade program — multiply previous trail FBO by u_fade.
    const fadeProgram = createProgram(gl, QUAD_VS, FADE_FS);
    const fadeAttrPos = gl.getAttribLocation(fadeProgram, 'a_pos');
    const fadeUFade = gl.getUniformLocation(fadeProgram, 'u_fade');
    const fadeUTex = gl.getUniformLocation(fadeProgram, 'u_tex');

    // Composite program — copy trail FBO to main framebuffer with
    // premultiplied-alpha blending.
    const compositeProgram = createProgram(gl, QUAD_VS, COMPOSITE_FS);
    const compositeAttrPos = gl.getAttribLocation(compositeProgram, 'a_pos');
    const compositeUTex = gl.getUniformLocation(compositeProgram, 'u_tex');
    const compositeUOpacity = gl.getUniformLocation(compositeProgram, 'u_opacity');

    // Sim program (GPU path only) — fragment-shader advection over the ping-pong
    // position texture. Projection-agnostic, shared with the other bindings.
    let simProgram: WebGLProgram | null = null;
    let simAttrPos = -1;
    let simUPosIn: WebGLUniformLocation | null = null;
    let simUVelTex: WebGLUniformLocation | null = null;
    let simUVelSize: WebGLUniformLocation | null = null;
    let simUSeedSpan: WebGLUniformLocation | null = null;
    let simUDecScale: WebGLUniformLocation | null = null;
    let simUDecOffset: WebGLUniformLocation | null = null;
    let simUEff: WebGLUniformLocation | null = null;
    let simUMinStep: WebGLUniformLocation | null = null;
    if (gpuSim) {
      simProgram = createProgram(gl, SIM_VS, SIM_FS);
      simAttrPos = gl.getAttribLocation(simProgram, 'a_pos');
      simUPosIn = gl.getUniformLocation(simProgram, 'u_posIn');
      simUVelTex = gl.getUniformLocation(simProgram, 'u_velTex');
      simUVelSize = gl.getUniformLocation(simProgram, 'u_velSize');
      simUSeedSpan = gl.getUniformLocation(simProgram, 'u_seedSpan');
      simUDecScale = gl.getUniformLocation(simProgram, 'u_decScale');
      simUDecOffset = gl.getUniformLocation(simProgram, 'u_decOffset');
      simUEff = gl.getUniformLocation(simProgram, 'u_eff');
      simUMinStep = gl.getUniformLocation(simProgram, 'u_minStepMerc');
    }

    const pointsBuffer = gl.createBuffer()!;
    const colormapTexture = gl.createTexture()!;

    // Static per-vertex corner buffer: the two triangles of a unit quad,
    // each vertex carrying (end, side) — end 0=prev / 1=cur endpoint, side
    // -1/+1 across the width. The instanced draw expands these against each
    // particle's prev/cur into a screen-space segment quad.
    const cornerBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, -1,   0, 1,   1, -1,
      1, -1,   0, 1,   1, 1,
    ]), gl.STATIC_DRAW);

    // Points VAO. CPU path: per-instance (a_prevClip, a_curClip, a_speed) on
    // pointsBuffer at divisor 1 (5 floats/instance) + the per-vertex a_corner on
    // cornerBuffer at divisor 0. GPU path: ONLY a_corner — the per-instance
    // attributes don't exist in the GPU_SIM program (locations -1), the VS reads
    // positions from textures by gl_InstanceID. Divisors are VAO state and this
    // VAO is used only by the instanced points draw, so they're set once here.
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    if (!gpuSim) {
      gl.bindBuffer(gl.ARRAY_BUFFER, pointsBuffer);
      const stride = 5 * 4;
      gl.enableVertexAttribArray(attrPrev);
      gl.vertexAttribPointer(attrPrev, 2, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(attrPrev, 1);
      gl.enableVertexAttribArray(attrCur);
      gl.vertexAttribPointer(attrCur, 2, gl.FLOAT, false, stride, 8);
      gl.vertexAttribDivisor(attrCur, 1);
      gl.enableVertexAttribArray(attrSpeed);
      gl.vertexAttribPointer(attrSpeed, 1, gl.FLOAT, false, stride, 16);
      gl.vertexAttribDivisor(attrSpeed, 1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.enableVertexAttribArray(attrCorner);
    gl.vertexAttribPointer(attrCorner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(attrCorner, 0);
    gl.bindVertexArray(null);

    // Quad VBO + VAO, shared between the fade and composite programs.
    // Both their VS programs name the input attribute `a_pos`; since
    // VAOs store per-location state and we wire up the attribute by
    // each program's reported location, the VAO works for either.
    // (Locations may or may not match — we set both. WebGL doesn't
    // complain about extra enabled attributes that the program doesn't
    // declare.)
    const quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    // quadVao is shared by the fade, composite, AND sim programs (all declare
    // `in vec2 a_pos` and map it via a_pos*2-1). Enable a_pos at each program's
    // reported location (usually all 0, but set defensively).
    const quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    const enabledQuadLocs = new Set<number>();
    for (const loc of [fadeAttrPos, compositeAttrPos, simAttrPos]) {
      if (loc >= 0 && !enabledQuadLocs.has(loc)) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        enabledQuadLocs.add(loc);
      }
    }
    gl.bindVertexArray(null);

    // GPU-sim resources: position ping-pong textures + sim FBOs + velocity
    // texture, created once we know the particle count (lazily in draw via
    // _setupGpuTextures, which also runs on count change).
    const syncScratch = new Uint8Array(4);

    this.setState({
      gl,
      gpuSim,
      program,
      vao,
      pointsBuffer,
      cornerBuffer,
      colormapTexture,
      colormapBytes: null as Uint8Array | null,
      uViewport,
      uLineWidth,
      uColormap,
      uVmin,
      uVmax,
      uColorBySpeed,
      uOpacity,
      // GPU_SIM points uniforms.
      uPosPrev,
      uPosCur,
      uVelTexSpeed,
      uTexW,
      uSeedOrigin,
      uSeedSpan,
      uDecScale,
      uDecOffset,
      uPixProj,
      uViewportPx,
      // Sim program + uniforms.
      simProgram,
      simUPosIn,
      simUVelTex,
      simUVelSize,
      simUSeedSpan,
      simUDecScale,
      simUDecOffset,
      simUEff,
      simUMinStep,
      syncScratch,
      // GPU-sim textures (created in _setupGpuTextures).
      posTexA: null as WebGLTexture | null,
      posTexB: null as WebGLTexture | null,
      simFboA: null as WebGLFramebuffer | null,
      simFboB: null as WebGLFramebuffer | null,
      velTex: null as WebGLTexture | null,
      texW: 0,
      texH: 0,
      posFrontIsA: true,
      gpuReady: false,
      velDirty: false,
      seedOx: 0,
      seedOy: 0,
      seedSx: 1,
      seedSy: 1,
      seedCursor: 0,
      seedStaging: new Uint8Array(0),
      // Trail-buffer programs + resources.
      fadeProgram,
      fadeUFade,
      fadeUTex,
      compositeProgram,
      compositeUTex,
      compositeUOpacity,
      quadBuffer,
      quadVao,
      // Trail FBOs created lazily once we know canvas dimensions.
      fbA: null as null | { fb: WebGLFramebuffer; tex: WebGLTexture },
      fbB: null as null | { fb: WebGLFramebuffer; tex: WebGLTexture },
      fbW: 0,
      fbH: 0,
      particles: [] as Particle[],
      particleCount: 0,
      particleData: new Float32Array(0),
      lastColormapRef: null as Float32Array | null,
      animateRequested: false,
      // Camera-state tracking — per-frame check on viewport state.
      // Particles are anchored to mercator-world coords; on zoom out
      // the previous viewport's dense cluster of particles ends up
      // packed into a small region of the new view (visibly: a
      // dense rectangle that dies out only via maxAge recycling).
      // Reseed on the first stable frame after motion stops, which
      // matches the Mapbox/MapLibre streamlines layer's behaviour.
      prevCameraKey: null as string | null,
      cameraMoving: false,
    });

    this._uploadColormap();
    if (!this._getCachedItem()) void this._discover();
  }

  shouldUpdateState({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changeFlags,
  }: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changeFlags: any;
  }): boolean {
    return changeFlags.somethingChanged;
  }

  updateState({
    props,
    oldProps,
  }: {
    props: MercatorStreamlinesLayerProps;
    oldProps: MercatorStreamlinesLayerProps;
  }) {
    if (
      props.dataset !== oldProps.dataset ||
      props.catalogUrl !== oldProps.catalogUrl
    ) {
      this.setState({ particles: [], particleCount: 0 });
      if (!this._getCachedItem()) void this._discover();
    }
    if (props.colormap !== oldProps.colormap) this._uploadColormap();
  }

  async _discover() {
    const { dataset, catalogUrl } = this.props;
    if (!dataset) return;
    const key = discoveryKey(catalogUrl!, dataset);
    const pending = discoveryCache.get(key);
    let promise: Promise<DiscoveredItem>;
    if (pending instanceof Promise) promise = pending;
    else {
      promise = discoverLatestItem(catalogUrl!, dataset);
      discoveryCache.set(key, promise);
    }
    try {
      const item = await promise;
      if (item.encoding.kind !== 'vector_rg_ba') {
        throw new Error(
          `@mercator-blue/sdk/deck-gl: MercatorStreamlinesLayer requires a ` +
            `vector_rg_ba encoding; dataset "${dataset}" has "${item.encoding.kind}". ` +
            'Use MercatorRasterLayer for scalar fields.',
        );
      }
      discoveryCache.set(key, item);
      this.setNeedsUpdate();
    } catch (err) {
      if (discoveryCache.get(key) === promise) discoveryCache.delete(key);
      // eslint-disable-next-line no-console
      console.error('[MercatorStreamlinesLayer]', err);
    }
  }

  finalizeState() {
    const s = this.state;
    const gl = s.gl as WebGL2RenderingContext;
    if (gl) {
      if (s.program) gl.deleteProgram(s.program);
      if (s.fadeProgram) gl.deleteProgram(s.fadeProgram);
      if (s.compositeProgram) gl.deleteProgram(s.compositeProgram);
      if (s.simProgram) gl.deleteProgram(s.simProgram);
      this._deleteGpuTextures();
      if (s.pointsBuffer) gl.deleteBuffer(s.pointsBuffer);
      if (s.cornerBuffer) gl.deleteBuffer(s.cornerBuffer);
      if (s.quadBuffer) gl.deleteBuffer(s.quadBuffer);
      if (s.vao) gl.deleteVertexArray(s.vao);
      if (s.quadVao) gl.deleteVertexArray(s.quadVao);
      if (s.colormapTexture) gl.deleteTexture(s.colormapTexture);
      if (s.fbA) {
        gl.deleteFramebuffer(s.fbA.fb);
        gl.deleteTexture(s.fbA.tex);
      }
      if (s.fbB) {
        gl.deleteFramebuffer(s.fbB.fb);
        gl.deleteTexture(s.fbB.tex);
      }
    }
    if (s.animateRequested) {
      try {
        this.context.deck?.setProps({ _animate: false });
      } catch {
        /* deck already torn down */
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(_opts: any) {
    const item = this._getCachedItem();
    if (!item) return;
    const viewport = this.context.viewport;
    if (!viewport) return;
    const s = this.state;
    const gl = s.gl as WebGL2RenderingContext;
    const gpuSim = s.gpuSim as boolean;
    const trailScale = Math.max(0.1, Math.min(1, this.props.trailResolutionScale ?? 1));

    this._ensureParticleCount();
    if (!gpuSim && this.state.particles.length === 0) this._seedParticles();

    // Request continuous re-render so the sim ticks each frame.
    if (!this.state.animateRequested) {
      try {
        this.context.deck?.setProps({ _animate: true });
        this.setState({ animateRequested: true });
      } catch {
        /* will retry next frame */
      }
    }

    this._ensureFramebuffers(trailScale);

    const targetZ = Math.max(0, Math.min(item.tile.maxzoom, Math.floor(viewport.zoom)));

    // Camera-state tracking: while the camera is changing, wipe the trail
    // buffers each frame so stale screen-space pixels don't smear into the new
    // view. On the first stable frame after motion stops, reseed into the new
    // view + wipe once more. The GPU path (re)computes its FROZEN seed bbox +
    // velocity texture here; the bbox is frozen between settles so decoded
    // positions are fixed mercator and the live projection tracks them with the
    // map during a drag (recomputing per-frame would pin them to the screen).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = viewport as any;
    const camKey =
      `${vp.zoom?.toFixed(5) ?? 0}|` +
      `${vp.longitude?.toFixed(6) ?? 0}|` +
      `${vp.latitude?.toFixed(6) ?? 0}|` +
      `${vp.bearing?.toFixed(2) ?? 0}|` +
      `${vp.pitch?.toFixed(2) ?? 0}`;
    const prevKey = this.state.prevCameraKey;
    if (prevKey !== null && prevKey !== camKey) {
      this._clearTrailBuffers();
      this.state.cameraMoving = true;
    } else if (this.state.cameraMoving) {
      if (gpuSim) {
        this._computeSeedBbox();
        this._assembleVelTex(item, targetZ);
        this._fullReseedGpu(item, targetZ);
        this.state.velDirty = false;
        this.state.gpuReady = true;
      } else {
        this._seedParticles();
      }
      this._clearTrailBuffers();
      this.state.cameraMoving = false;
    }
    this.state.prevCameraKey = camKey;

    this._ensureVisibleTiles(item);

    // Save deck.gl's framebuffer + viewport BEFORE any offscreen work (the GPU
    // sim renders into FBOs too); restore for the composite pass.
    const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    if (gpuSim) {
      // Bootstrap (first frame, or after a particle-count change).
      if (!this.state.gpuReady) {
        this._computeSeedBbox();
        this._assembleVelTex(item, targetZ);
        this._fullReseedGpu(item, targetZ);
        this.state.velDirty = false;
        this.state.gpuReady = true;
      } else {
        // A tile loaded while parked -> re-snapshot the velocity texture.
        if (this.state.velDirty && !this.state.cameraMoving) {
          this._assembleVelTex(item, targetZ);
          this.state.velDirty = false;
        }
        // Reseed a round-robin slice; skip mid-move (settle reseed covers it).
        if (!this.state.cameraMoving) this._reseedRoundRobinGpu(item, targetZ);
      }
      this._simStepGpu(item);
      // RACE FIX (same as the OpenLayers binding): force simStep's
      // render-into-BACK to complete before the points pass SAMPLES BACK as
      // `cur`. Raw-GL FBO ping-pong on this driver doesn't serialize
      // render-to-texture -> sample, so without it a few particles draw as
      // map-spanning segments. A 1-pixel readback of both position FBOs is a
      // hard pipeline sync at negligible transfer cost.
      if (s.simFboA && s.simFboB) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.simFboA);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, s.syncScratch);
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.simFboB);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, s.syncScratch);
      }
    } else {
      this._updateParticles(item);
      this._packVertexData(viewport);
      // Upload vertex data (clip-space x, y, speed per particle).
      gl.bindBuffer(gl.ARRAY_BUFFER, s.pointsBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, s.particleData as Float32Array, gl.DYNAMIC_DRAW);
    }

    // 1. Render into fbA: fade-copy of fbB, then new points additively.
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbA.fb);
    gl.viewport(0, 0, s.fbW, s.fbH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 1a. Fade fbB onto fbA (no blend; direct write of input × fade).
    gl.disable(gl.BLEND);
    gl.useProgram(s.fadeProgram);
    gl.bindVertexArray(s.quadVao);
    gl.uniform1f(s.fadeUFade, this.props.fade ?? DEFAULT_FADE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.fbB.tex);
    gl.uniform1i(s.fadeUTex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 1b. New segments additively (premultiplied; ONE + ONE so colours
    //     accumulate where particles overlap). Each particle is ONE
    //     instance; the static corner buffer (bound in the VAO) expands
    //     its prev->cur into a screen-space quad.
    gl.useProgram(s.program);
    gl.bindVertexArray(s.vao);
    gl.uniform2f(s.uViewport, s.fbW, s.fbH);
    // The VS expands the quad in trail-FBO pixels (u_viewport), so scale the
    // line width with the trail resolution to keep the on-screen width fixed.
    gl.uniform1f(s.uLineWidth, (this.props.pointSize ?? DEFAULT_POINT_SIZE) * trailScale);
    gl.uniform1f(s.uVmin, this.props.vmin ?? 0);
    gl.uniform1f(
      s.uVmax,
      this.props.vmax ?? item.visualization?.vmax ?? 1,
    );
    gl.uniform1f(s.uColorBySpeed, this.props.colorBySpeed === false ? 0 : 1);
    // Inside the trail FBO, write at full opacity; the composite
    // pass below scales by the user-facing opacity prop.
    gl.uniform1f(s.uOpacity, 1.0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.colormapTexture);
    gl.uniform1i(s.uColormap, 0);
    if (gpuSim) {
      // Positions from the ping-pong textures (prev = FRONT, cur = BACK) + the
      // velocity texture for colour. Palette stays on unit 0; bind ours on
      // 1/2/3. The VS projects via the live pixelProjectionMatrix.
      const front = s.posFrontIsA ? s.posTexA : s.posTexB;
      const back = s.posFrontIsA ? s.posTexB : s.posTexA;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, front);
      gl.uniform1i(s.uPosPrev, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, back);
      gl.uniform1i(s.uPosCur, 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, s.velTex);
      gl.uniform1i(s.uVelTexSpeed, 3);
      gl.uniform1i(s.uTexW, s.texW);
      gl.uniform2f(s.uSeedOrigin, s.seedOx, s.seedOy);
      gl.uniform2f(s.uSeedSpan, s.seedSx, s.seedSy);
      gl.uniform1f(s.uDecScale, item.encoding.scale);
      gl.uniform1f(s.uDecOffset, item.encoding.offset);
      gl.uniformMatrix4fv(s.uPixProj, false, vp.pixelProjectionMatrix);
      gl.uniform2f(s.uViewportPx, viewport.width || 1, viewport.height || 1);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, s.particleCount);
    if (gpuSim) {
      // Unbind the position/velocity textures from their sampler units so the
      // next frame's sim pass isn't rendering into a texture that's still
      // sampler-bound (WebGL feedback-loop hygiene).
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }

    // 2. Composite fbA onto the main framebuffer with premultiplied
    //    alpha so the trail blends naturally over the basemap. fbA is sampled
    //    LINEAR, so a sub-resolution trail FBO (trailScale < 1) upscales here.
    gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo);
    gl.viewport(
      savedViewport[0], savedViewport[1],
      savedViewport[2], savedViewport[3],
    );
    gl.useProgram(s.compositeProgram);
    gl.bindVertexArray(s.quadVao);
    gl.uniform1f(s.compositeUOpacity, this.props.opacity ?? DEFAULT_OPACITY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.fbA.tex);
    gl.uniform1i(s.compositeUTex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindVertexArray(null);

    // 3. Swap so next frame reads the latest trail state and writes the new
    //    one into the other buffer. Swap the position ping-pong too.
    const tmp = s.fbA;
    s.fbA = s.fbB;
    s.fbB = tmp;
    if (gpuSim) s.posFrontIsA = !s.posFrontIsA;
  }

  // --- GPU simulation -------------------------------------------------

  _setupGpuTextures() {
    const s = this.state;
    const gl = s.gl as WebGL2RenderingContext;
    this._deleteGpuTextures();
    const n = Math.max(1, s.particleCount as number);
    const texW = Math.max(1, Math.ceil(Math.sqrt(n)));
    const texH = Math.max(1, Math.ceil(n / texW));
    s.texW = texW;
    s.texH = texH;
    const mkTex = (w: number, h: number): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    s.posTexA = mkTex(texW, texH);
    s.posTexB = mkTex(texW, texH);
    s.velTex = mkTex(VEL_TEX_SIZE, VEL_TEX_SIZE);
    const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const mkFbo = (tex: WebGLTexture): WebGLFramebuffer => {
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return fb;
    };
    s.simFboA = mkFbo(s.posTexA);
    s.simFboB = mkFbo(s.posTexB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo);
    s.posFrontIsA = true;
    s.seedCursor = 0;
    s.seedStaging = new Uint8Array(texW * texH * 4);
  }

  _deleteGpuTextures() {
    const s = this.state;
    const gl = s.gl as WebGL2RenderingContext | undefined;
    if (!gl) return;
    if (s.posTexA) { gl.deleteTexture(s.posTexA); s.posTexA = null; }
    if (s.posTexB) { gl.deleteTexture(s.posTexB); s.posTexB = null; }
    if (s.velTex) { gl.deleteTexture(s.velTex); s.velTex = null; }
    if (s.simFboA) { gl.deleteFramebuffer(s.simFboA); s.simFboA = null; }
    if (s.simFboB) { gl.deleteFramebuffer(s.simFboB); s.simFboB = null; }
  }

  /** Padded seed bbox in slippy mercator from the current viewport bounds.
   *  Frozen between camera settles (see draw). */
  _computeSeedBbox() {
    const viewport = this.context.viewport;
    if (!viewport) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bounds = (viewport as any).getBounds?.() as
      | [number, number, number, number]
      | undefined;
    if (!bounds) return;
    const [wLng, sLat, eLng, nLat] = bounds;
    const [mxMin, myMax] = lngLatToMercator(wLng, sLat);
    const [mxMax, myMin] = lngLatToMercator(eLng, nLat);
    const sx = mxMax - mxMin;
    const sy = myMax - myMin;
    const seedYMin = Math.max(0.005, myMin - SEED_MARGIN * sy);
    const seedYMax = Math.min(0.995, myMax + SEED_MARGIN * sy);
    const s = this.state;
    s.seedOx = mxMin - SEED_MARGIN * sx;
    s.seedOy = seedYMin;
    s.seedSx = sx * (1 + 2 * SEED_MARGIN);
    s.seedSy = Math.max(1e-9, seedYMax - seedYMin);
  }

  /** Assemble the per-view velocity texture (vector_rg_ba, NEAREST) from the
   *  loaded tiles over the padded seed bbox. Land / no-data / not-loaded ->
   *  all-zero sentinel. */
  _assembleVelTex(item: DiscoveredItem, targetZ: number) {
    const s = this.state;
    const gl = s.gl as WebGL2RenderingContext;
    if (!s.velTex) return;
    const S = VEL_TEX_SIZE;
    const buf = new Uint8Array(S * S * 4);
    const sc = item.encoding.scale, off = item.encoding.offset;
    const ox = s.seedOx, oy = s.seedOy, sxx = s.seedSx, syy = s.seedSy;
    for (let j = 0; j < S; j++) {
      const my = oy + ((j + 0.5) / S) * syy;
      for (let i = 0; i < S; i++) {
        const mx = ox + ((i + 0.5) / S) * sxx;
        const w = this._sampleWind(item, mx, my, targetZ); // null over land/no-data/pending
        if (!w) continue;
        const uq = Math.max(0, Math.min(65535, Math.round((w.u - off) / sc)));
        const vq = Math.max(0, Math.min(65535, Math.round((w.v - off) / sc)));
        let R = uq >> 8; let G = uq & 255;
        const B = vq >> 8; const A = vq & 255;
        if ((R | G | B | A) === 0) G = 1;
        const idx = (j * S + i) * 4;
        buf[idx] = R; buf[idx + 1] = G; buf[idx + 2] = B; buf[idx + 3] = A;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, s.velTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  }

  /** Encode one CPU seed into 4 bytes (viewport-local 16-bit/axis), or the
   *  all-zero dead sentinel if the seed lands on no-data/pending. */
  _encodeSeedInto(b: Uint8Array, off: number, item: DiscoveredItem, targetZ: number) {
    const s = this.state;
    const mx = s.seedOx + Math.random() * s.seedSx;
    const my = s.seedOy + Math.random() * s.seedSy;
    const w = this._sampleWind(item, mx, my, targetZ);
    if (!w) { b[off] = 0; b[off + 1] = 0; b[off + 2] = 0; b[off + 3] = 0; return; }
    let qx = Math.max(0, Math.min(65535, Math.round(((mx - s.seedOx) / s.seedSx) * 65535)));
    const qy = Math.max(0, Math.min(65535, Math.round(((my - s.seedOy) / s.seedSy) * 65535)));
    if (qx === 0 && qy === 0) qx = 1;
    b[off] = qx >> 8; b[off + 1] = qx & 255;
    b[off + 2] = qy >> 8; b[off + 3] = qy & 255;
  }

  /** Seed all particles into the current FRONT position texture. */
  _fullReseedGpu(item: DiscoveredItem, targetZ: number) {
    const s = this.state;
    const gl = s.gl as WebGL2RenderingContext;
    const front = s.posFrontIsA ? s.posTexA : s.posTexB;
    if (!front) return;
    const buf = s.seedStaging as Uint8Array;
    buf.fill(0);
    for (let i = 0; i < s.particleCount; i++) this._encodeSeedInto(buf, i * 4, item, targetZ);
    gl.bindTexture(gl.TEXTURE_2D, front);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, s.texW, s.texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    s.seedCursor = 0;
  }

  /** Refresh ~N/maxAge particles per frame, round-robin, into FRONT. */
  _reseedRoundRobinGpu(item: DiscoveredItem, targetZ: number) {
    const s = this.state;
    const gl = s.gl as WebGL2RenderingContext;
    const front = s.posFrontIsA ? s.posTexA : s.posTexB;
    if (!front) return;
    const maxAge = this.props.maxAge ?? DEFAULT_MAX_AGE_FRAMES;
    let count = Math.ceil(s.particleCount / Math.max(1, maxAge));
    if (count <= 0) return;
    gl.bindTexture(gl.TEXTURE_2D, front);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    let idx = s.seedCursor;
    while (count > 0) {
      const row = Math.floor(idx / s.texW);
      const col = idx % s.texW;
      const n = Math.min(count, s.texW - col, s.particleCount - idx);
      const seg = new Uint8Array(n * 4);
      for (let k = 0; k < n; k++) this._encodeSeedInto(seg, k * 4, item, targetZ);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, col, row, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, seg);
      count -= n;
      idx += n;
      if (idx >= s.particleCount) idx = 0;
    }
    s.seedCursor = idx;
  }

  /** Advance every particle one step: FRONT -> BACK fragment-shader pass. */
  _simStepGpu(item: DiscoveredItem) {
    const s = this.state;
    const gl = s.gl as WebGL2RenderingContext;
    const viewport = this.context.viewport;
    if (!s.simProgram || !s.velTex || !viewport) return;
    const front = s.posFrontIsA ? s.posTexA : s.posTexB;
    const backFbo = s.posFrontIsA ? s.simFboB : s.simFboA;
    if (!front || !backFbo) return;
    const zoom = viewport.zoom;
    const propScale =
      this.props.speedScale ??
      item.visualization?.particle_speed_scale ??
      DEFAULT_SPEED_SCALE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, backFbo);
    gl.viewport(0, 0, s.texW, s.texH);
    gl.disable(gl.BLEND);
    gl.useProgram(s.simProgram);
    gl.bindVertexArray(s.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, front);
    gl.uniform1i(s.simUPosIn, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, s.velTex);
    gl.uniform1i(s.simUVelTex, 1);
    gl.uniform2i(s.simUVelSize, VEL_TEX_SIZE, VEL_TEX_SIZE);
    gl.uniform2f(s.simUSeedSpan, s.seedSx, s.seedSy);
    gl.uniform1f(s.simUDecScale, item.encoding.scale);
    gl.uniform1f(s.simUDecOffset, item.encoding.offset);
    gl.uniform1f(s.simUEff, propScale * Math.pow(0.5, zoom));
    // Min-step floor in slippy-mercator units: 0.5 device px. The visible
    // mercator span (seedSx without the SEED_MARGIN padding) maps to fbW device
    // px, so mercator-per-device-px = visSpanX / fbW.
    const visSpanX = s.seedSx / (1 + 2 * SEED_MARGIN);
    const devW = Math.max(1, (s.fbW as number) || viewport.width || 1);
    gl.uniform1f(s.simUMinStep, (MIN_STEP_PIXELS * visSpanX) / devW);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // --- FBO ping-pong --------------------------------------------------

  _ensureFramebuffers(trailScale = 1) {
    const s = this.state;
    const gl = s.gl as WebGL2RenderingContext;
    // Trail FBO at drawing-buffer resolution × trailScale; the composite
    // upscales (LINEAR) on the way to the screen.
    const W = Math.max(1, Math.round(gl.drawingBufferWidth * trailScale));
    const H = Math.max(1, Math.round(gl.drawingBufferHeight * trailScale));
    if (s.fbA && s.fbW === W && s.fbH === H) return;
    if (s.fbA) {
      gl.deleteFramebuffer(s.fbA.fb);
      gl.deleteTexture(s.fbA.tex);
    }
    if (s.fbB) {
      gl.deleteFramebuffer(s.fbB.fb);
      gl.deleteTexture(s.fbB.tex);
    }
    s.fbA = makeFramebuffer(gl, W, H);
    s.fbB = makeFramebuffer(gl, W, H);
    s.fbW = W;
    s.fbH = H;
    // Clear both buffers explicitly. texImage2D with data=null is
    // specified to zero-fill, but real drivers don't always honor it —
    // visible as a "ghost particles" cloud the first time the layer
    // is enabled: the first frame's fade pass reads garbage out of
    // fbB, mixes it into fbA, composites to screen, and the trail
    // pipeline then takes ~100 frames to fade it out.
    this._clearTrailBuffers();
  }

  _clearTrailBuffers() {
    const s = this.state;
    if (!s.fbA || !s.fbB) return;
    const gl = s.gl as WebGL2RenderingContext;
    const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    for (const fb of [s.fbA, s.fbB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fb);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo);
  }

  _uploadColormap() {
    const s = this.state;
    if (!s.gl) return;
    const gl = s.gl as WebGL2RenderingContext;
    const stops = resolveColormap(this.props.colormap);
    const rgba = new Uint8Array(COLORMAP_SIZE * 4);
    for (let i = 0; i < COLORMAP_SIZE; i++) {
      rgba[i * 4 + 0] = Math.round(stops[i * 3 + 0] * 255);
      rgba[i * 4 + 1] = Math.round(stops[i * 3 + 1] * 255);
      rgba[i * 4 + 2] = Math.round(stops[i * 3 + 2] * 255);
      rgba[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, s.colormapTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, COLORMAP_SIZE, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, rgba,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.setState({ lastColormapRef: stops });
  }

  _ensureParticleCount() {
    const wanted = this.props.particleCount ?? DEFAULT_PARTICLE_COUNT;
    if (this.state.particleCount === wanted) return;
    this.setState({
      particleCount: wanted,
      particles: [],
      particleData: new Float32Array(wanted * 5),
    });
    // GPU path: resize the position textures (one texel/particle) and force a
    // full reseed on the next frame (gpuReady=false -> the bootstrap branch).
    if (this.state.gpuSim && this.state.gl) {
      this.state.gpuReady = false;
      this._setupGpuTextures();
    }
    // Wipe trails so the previous-count particles don't linger in the
    // FBO as a ghost cloud while they fade out over ~100 frames.
    if (this.state.fbA) this._clearTrailBuffers();
  }

  _ensureVisibleTiles(item: DiscoveredItem) {
    const viewport = this.context.viewport;
    if (!viewport) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bounds = (viewport as any).getBounds?.() as
      | [number, number, number, number]
      | undefined;
    if (!bounds) return;
    const [wLng, sLat, eLng, nLat] = bounds;
    const maxzoom = item.tile.maxzoom;
    const z = Math.max(0, Math.min(maxzoom, Math.floor(viewport.zoom)));
    const n = Math.pow(2, z);
    const lngToTileX = (lng: number) => ((lng + 180) / 360) * n;
    const latToTileY = (lat: number) => {
      const c = Math.max(-85.0511, Math.min(85.0511, lat));
      const r = (c * Math.PI) / 180;
      return (
        ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
      );
    };
    const xLo = Math.floor(lngToTileX(wLng));
    const xHi = Math.floor(lngToTileX(eLng));
    const yLo = Math.max(0, Math.floor(latToTileY(nLat)));
    const yHi = Math.min(n - 1, Math.floor(latToTileY(sLat)));
    const apiKey = this.props.apiKey;
    const scale = item.encoding.scale;
    const offset = item.encoding.offset;
    // On tile load: request a redraw, and (GPU path) mark the velocity texture
    // dirty so it re-snapshots once the camera is stable.
    const onLoad = () => { this.state.velDirty = true; this.setNeedsUpdate(); };
    for (let tx = xLo; tx <= xHi; tx++) {
      for (let ty = yLo; ty <= yHi; ty++) {
        const wrappedTx = ((tx % n) + n) % n;
        const url = withApiKey(
          `${item.itemBase}/${z}/${wrappedTx}/${ty}.png`,
          apiKey,
        );
        ensureTilePixels(url, scale, offset, onLoad);
      }
    }
    // Low-zoom fallback so freshly-spawned particles can sample
    // before higher-z tiles finish loading.
    const fallback = withApiKey(`${item.itemBase}/0/0/0.png`, apiKey);
    ensureTilePixels(fallback, scale, offset, onLoad);
  }

  _seedParticles() {
    const count = this.state.particleCount;
    const viewport = this.context.viewport;
    if (!viewport || count === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bounds = (viewport as any).getBounds?.() as
      | [number, number, number, number]
      | undefined;
    if (!bounds) return;
    const [wLng, sLat, eLng, nLat] = bounds;
    const [mxMin, myMax] = lngLatToMercator(wLng, sLat);
    const [mxMax, myMin] = lngLatToMercator(eLng, nLat);
    const sx = mxMax - mxMin;
    const sy = myMax - myMin;
    const seedXMin = mxMin - SEED_MARGIN * sx;
    const seedYMin = Math.max(0.005, myMin - SEED_MARGIN * sy);
    const seedYMax = Math.min(0.995, myMax + SEED_MARGIN * sy);
    const spanX = sx * (1 + 2 * SEED_MARGIN);
    const spanY = Math.max(0, seedYMax - seedYMin);
    const maxAge = this.props.maxAge ?? DEFAULT_MAX_AGE_FRAMES;
    const particles: Particle[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const mx = seedXMin + Math.random() * spanX;
      const my = seedYMin + Math.random() * spanY;
      particles[i] = {
        mx,
        my,
        pmx: mx,   // zero-length first segment
        pmy: my,
        age: Math.floor(Math.random() * maxAge),
        speed: 0,
      };
    }
    this.setState({ particles });
  }

  _updateParticles(item: DiscoveredItem) {
    const particles: Particle[] = this.state.particles;
    if (particles.length === 0) return;
    const viewport = this.context.viewport;
    if (!viewport) return;
    const zoom = viewport.zoom;
    const propScale =
      this.props.speedScale ??
      item.visualization?.particle_speed_scale ??
      DEFAULT_SPEED_SCALE;
    const eff = propScale * Math.pow(0.5, zoom);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bounds = (viewport as any).getBounds?.() as
      | [number, number, number, number]
      | undefined;
    let mxMin = 0, mxMax = 1, myMin = 0, myMax = 1;
    if (bounds) {
      const [wLng, sLat, eLng, nLat] = bounds;
      [mxMin, myMax] = lngLatToMercator(wLng, sLat);
      [mxMax, myMin] = lngLatToMercator(eLng, nLat);
    }
    const sx = mxMax - mxMin;
    const sy = myMax - myMin;
    const inVp = (mx: number, my: number) =>
      mx >= mxMin - SEED_MARGIN * sx &&
      mx <= mxMax + SEED_MARGIN * sx &&
      my >= myMin - SEED_MARGIN * sy &&
      my <= myMax + SEED_MARGIN * sy;

    // Per-frame step FLOOR (no max cap — segment quads keep trails
    // continuous at any speed). Measured in DEVICE px (the trail FBO is
    // sized to the drawing buffer): the visible mercator span sx maps to
    // fbW device px, so mercator-per-device-px = sx / fbW.
    const devW = Math.max(1, this.state.fbW || viewport.width);
    const minStep = (MIN_STEP_PIXELS * sx) / devW;

    const maxAge = this.props.maxAge ?? DEFAULT_MAX_AGE_FRAMES;
    const deadReviveProb = 1 / Math.max(1, maxAge);
    const targetZ = Math.max(0, Math.min(item.tile.maxzoom, Math.floor(zoom)));

    for (const p of particles) {
      if (p.speed < 0) {
        if (Math.random() < deadReviveProb)
          this._respawn(p, mxMin, mxMax, myMin, myMax);
        continue;
      }
      const sample = this._sampleWind(item, p.mx, p.my, targetZ);
      if (sample === null) {
        this._respawn(p, mxMin, mxMax, myMin, myMax);
        continue;
      }
      const speed = Math.sqrt(sample.u * sample.u + sample.v * sample.v);
      let dx = sample.u * eff;
      let dy = -sample.v * eff;
      const stepMag = Math.sqrt(dx * dx + dy * dy);
      // Floor the step (preserving direction) so slow particles still
      // drift; genuine zero stays put.
      if (stepMag > 0 && stepMag < minStep) {
        const k = minStep / stepMag;
        dx *= k;
        dy *= k;
      }
      p.pmx = p.mx;
      p.pmy = p.my;
      p.mx += dx;
      p.my += dy;
      p.age++;
      p.speed = speed;
      if (
        p.my < 0.005 ||
        p.my > 0.995 ||
        p.age > maxAge ||
        !inVp(p.mx, p.my)
      ) {
        this._respawn(p, mxMin, mxMax, myMin, myMax);
      }
    }
  }

  _respawn(
    p: Particle,
    mxMin: number,
    mxMax: number,
    myMin: number,
    myMax: number,
  ) {
    const maxAge = this.props.maxAge ?? DEFAULT_MAX_AGE_FRAMES;
    const sx = mxMax - mxMin;
    const sy = myMax - myMin;
    const seedXMin = mxMin - SEED_MARGIN * sx;
    const seedYMin = Math.max(0.005, myMin - SEED_MARGIN * sy);
    const seedYMax = Math.min(0.995, myMax + SEED_MARGIN * sy);
    const spanX = sx * (1 + 2 * SEED_MARGIN);
    const spanY = Math.max(0, seedYMax - seedYMin);
    p.mx = seedXMin + Math.random() * spanX;
    p.my = seedYMin + Math.random() * spanY;
    p.pmx = p.mx;   // zero-length first segment
    p.pmy = p.my;
    p.age = Math.floor(Math.random() * maxAge);
    p.speed = 0;
  }

  _sampleWind(
    item: DiscoveredItem,
    mx: number,
    my: number,
    targetZ: number,
  ): { u: number; v: number } | null {
    const mxC = posMod(mx, 1);
    const myC = Math.max(0, Math.min(1 - 1e-9, my));
    const apiKey = this.props.apiKey;
    for (let z = targetZ; z >= 0; z--) {
      const n = Math.pow(2, z);
      const tx = Math.floor(mxC * n);
      const ty = Math.floor(myC * n);
      const url = withApiKey(
        `${item.itemBase}/${z}/${tx}/${ty}.png`,
        apiKey,
      );
      const tile = tilePixelCache.get(url);
      if (!tile || typeof tile !== 'object') continue;
      const localX = mxC * n - tx;
      const localY = myC * n - ty;
      const px = localX * tile.width;
      const py = localY * tile.height;
      const x0 = Math.max(0, Math.min(tile.width - 1, Math.floor(px)));
      const x1 = Math.min(tile.width - 1, x0 + 1);
      const y0 = Math.max(0, Math.min(tile.height - 1, Math.floor(py)));
      const y1 = Math.min(tile.height - 1, y0 + 1);
      const fx = px - Math.floor(px);
      const fy = py - Math.floor(py);
      const w00 = (1 - fx) * (1 - fy);
      const w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = y0 * tile.width + x0;
      const i01 = y0 * tile.width + x1;
      const i10 = y1 * tile.width + x0;
      const i11 = y1 * tile.width + x1;
      const u00 = tile.u[i00],
        u01 = tile.u[i01],
        u10 = tile.u[i10],
        u11 = tile.u[i11];
      let wSum = 0, uSum = 0, vSum = 0;
      if (u00 === u00) { wSum += w00; uSum += w00 * u00; vSum += w00 * tile.v[i00]; }
      if (u01 === u01) { wSum += w01; uSum += w01 * u01; vSum += w01 * tile.v[i01]; }
      if (u10 === u10) { wSum += w10; uSum += w10 * u10; vSum += w10 * tile.v[i10]; }
      if (u11 === u11) { wSum += w11; uSum += w11 * u11; vSum += w11 * tile.v[i11]; }
      if (wSum < 0.1) return null;
      return { u: uSum / wSum, v: vSum / wSum };
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _packVertexData(viewport: any) {
    const particles: Particle[] = this.state.particles;
    const data: Float32Array = this.state.particleData;
    const W = viewport.width || 1;
    const H = viewport.height || 1;
    // Batch projection: inline what viewport.project() does internally.
    // deck.gl's project() is project(lngLat) = worldToPixels(
    //   projectFlat(lngLat), pixelProjectionMatrix). projectFlat for
    // WebMercatorViewport returns [mx*512, my*512] — i.e. mercator-world
    // × WORLD_SCALE. We already hold (mx, my) directly, so we skip
    // projectFlat and apply pixelProjectionMatrix manually here. That
    // removes the per-particle function-call + lngLat→COMMON conversion
    // overhead — at N=8000 particles × 60 fps this was the dominant
    // CPU cost (~3× slower than the Mapbox/MapLibre implementation
    // which projects in the GPU).
    const WORLD_SCALE = 512;
    const pm = viewport.pixelProjectionMatrix as Float32Array | number[];
    // Column-major mat4: pm[i + 4*col] is row i of col c.
    // For input (cx, cy, 0, 1):
    //   px = pm[0]·cx + pm[4]·cy + pm[12]
    //   py = pm[1]·cx + pm[5]·cy + pm[13]
    //   pw = pm[3]·cx + pm[7]·cy + pm[15]
    // (z=0 column is pm[8..11], dropped since cz=0.)
    const m0 = pm[0], m1 = pm[1], m3 = pm[3];
    const m4 = pm[4], m5 = pm[5], m7 = pm[7];
    const m12 = pm[12], m13 = pm[13], m15 = pm[15];
    // Project a slippy-convention (mx, my) to NDC, or null if behind the
    // camera. deck.gl's COMMON-y INCREASES going north (lngLatToWorld in
    // @math.gl/web-mercator: y = TILE_SIZE * (1 - my_slippy)); our
    // particles carry slippy my (0 north, 1 south), so flip here — without
    // it every off-equator particle projects to the wrong hemisphere.
    const project = (mx: number, my: number): [number, number] | null => {
      const cx = mx * WORLD_SCALE;
      const cy = (1 - my) * WORLD_SCALE;
      const pw = m3 * cx + m7 * cy + m15;
      if (!(pw > 0)) return null;
      const px = (m0 * cx + m4 * cy + m12) / pw;
      const py = (m1 * cx + m5 * cy + m13) / pw;
      return [(px / W) * 2 - 1, 1 - (py / H) * 2];
    };
    let idx = 0;
    for (const p of particles) {
      if (p.speed < 0) {
        data[idx++] = 0; data[idx++] = 0;
        data[idx++] = 0; data[idx++] = 0;
        data[idx++] = -1;
        continue;
      }
      const cur = project(p.mx, p.my);
      const prev = project(p.pmx, p.pmy);
      if (!cur || !prev) {
        // Either endpoint behind the camera — cull this frame via the
        // speed sentinel (positions are irrelevant once a_speed < 0).
        data[idx++] = 0; data[idx++] = 0;
        data[idx++] = 0; data[idx++] = 0;
        data[idx++] = -1;
        continue;
      }
      data[idx++] = prev[0];
      data[idx++] = prev[1];
      data[idx++] = cur[0];
      data[idx++] = cur[1];
      data[idx++] = p.speed;
    }
  }
}
