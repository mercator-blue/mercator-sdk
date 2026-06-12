// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// Particle vertex shader — instanced expanded-line segments (Leaflet,
// Mercator-only). Each particle is ONE instance; the 6 per-vertex
// \`a_corner\` values (two triangles of a unit quad) expand the particle's
// prev->cur move into a screen-space quad of width u_lineWidth, with
// half-width square end-caps so consecutive frames' segments overlap into
// a continuous trail and a stationary particle still renders as a dot.
// Drawing the per-frame MOVE as a connected quad (rather than a GL_POINT)
// makes trails continuous at ANY speed — fast particles draw long segments
// instead of skipping pixels — so no max-speed cap is needed.
//
// Projection is the binding's split-precision Mercator: clip = (-1, 1) +
// delta * u_proj_scale, where delta = position − viewport-top-left and
// w = 1. Both endpoints go through it; the quad expansion then happens in
// pixel space, like the Mapbox binding's streamlines-points.vert.

#ifdef GPU_SIM
// GPU-simulation input: prev/cur positions come from ping-pong RGBA8 position
// textures (one texel per particle, indexed by gl_InstanceID), not attributes.
// Positions are viewport-local [0,1] packed 16-bit/axis; decode -> mercator ->
// delta from the viewport top-left (u_tl) so projectClip below is unchanged.
// Speed (for color) is sampled from the velocity texture at the cur position.
uniform sampler2D u_posPrev;
uniform sampler2D u_posCur;
uniform sampler2D u_velTex;
uniform int u_texW;          // position-texture width (texels)
uniform vec2 u_seedOrigin;   // mercator origin of the padded seed bbox
uniform vec2 u_seedSpan;     // mercator span of the padded seed bbox
uniform vec2 u_tl;           // viewport top-left mercator (projection origin)
uniform float u_decScale;    // velocity encoding scale  (for speed/color)
uniform float u_decOffset;   // velocity encoding offset

float dec16(float hi, float lo) { return (hi * 255.0 * 256.0 + lo * 255.0) / 65535.0; }
vec2 decodeLocal(vec4 p) { return vec2(dec16(p.r, p.g), dec16(p.b, p.a)); }
float speedAt(vec2 uv) {
  vec4 t = texture(u_velTex, uv);
  if (t == vec4(0.0)) return 0.0;
  float u = (t.r * 255.0 * 256.0 + t.g * 255.0) * u_decScale + u_decOffset;
  float v = (t.b * 255.0 * 256.0 + t.a * 255.0) * u_decScale + u_decOffset;
  return length(vec2(u, v));
}
#else
in vec2 a_prev;    // per-instance: previous position, DELTA from tl (w=1)
in vec2 a_cur;     // per-instance: current  position, DELTA from tl (w=1)
in float a_speed;  // per-instance: true speed magnitude; < 0 = dead sentinel
#endif

in vec2 a_corner;  // per-vertex: (end, side) — end 0=prev 1=cur, side -1/+1

uniform vec2 u_proj_scale;   // (2S/W, -2S/H)
uniform vec2 u_viewport;     // device px (trail-FBO size)
uniform float u_lineWidth;   // device px (full segment width)

out float v_speed;
out float v_edge;            // signed cross-line coord (-1..1) for edge AA

vec2 projectClip(vec2 delta) {
  return vec2(-1.0, 1.0) + delta * u_proj_scale;  // w = 1
}

void main() {
#ifdef GPU_SIM
  ivec2 texel = ivec2(gl_InstanceID % u_texW, gl_InstanceID / u_texW);
  vec4 pPrev = texelFetch(u_posPrev, texel, 0);
  vec4 pCur  = texelFetch(u_posCur,  texel, 0);
  bool dead = (pPrev == vec4(0.0)) || (pCur == vec4(0.0));
  vec2 localCur = decodeLocal(pCur);
  vec2 a_prev = u_seedOrigin + decodeLocal(pPrev) * u_seedSpan - u_tl;
  vec2 a_cur  = u_seedOrigin + localCur * u_seedSpan - u_tl;
  float a_speed = dead ? -1.0 : speedAt(localCur);
#endif
  // Dead-particle sentinel: push all 6 vertices outside clip space so the
  // whole instance is culled before rasterization.
  if (a_speed < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_speed = 0.0;
    v_edge = 0.0;
    return;
  }

  vec2 clipPrev = projectClip(a_prev);
  vec2 clipCur  = projectClip(a_cur);

  // Endpoints in pixel space (w = 1, so no perspective divide) to build the
  // screen-space tangent + perpendicular.
  vec2 pixPrev = clipPrev * 0.5 * u_viewport;
  vec2 pixCur  = clipCur  * 0.5 * u_viewport;

  vec2 tangent = pixCur - pixPrev;
  float tLen = length(tangent);
  // Degenerate (near-zero step): fixed axes so the caps draw a
  // lineWidth×lineWidth square (a dot) rather than collapsing to NaN.
  vec2 tdir   = tLen > 1e-4 ? tangent / tLen                     : vec2(1.0, 0.0);
  vec2 normal = tLen > 1e-4 ? vec2(-tangent.y, tangent.x) / tLen : vec2(0.0, 1.0);

  float end  = a_corner.x;   // 0 = prev, 1 = cur
  float side = a_corner.y;   // -1 / +1
  float halfW = u_lineWidth * 0.5;
  vec2 baseClip = mix(clipPrev, clipCur, end);

  // Perpendicular offset gives the width; the longitudinal half-width cap
  // (prev extended backward, cur forward) makes consecutive segments overlap
  // into a seamless trail and turns a zero-length step into a centered dot.
  float along = end < 0.5 ? -1.0 : 1.0;
  vec2 offsetPx = normal * side * halfW + tdir * along * halfW;
  vec2 offsetClip = offsetPx / (0.5 * u_viewport);

  gl_Position = vec4(baseClip + offsetClip, 0.0, 1.0);
  v_speed = a_speed;
  v_edge = side;
}
`;
