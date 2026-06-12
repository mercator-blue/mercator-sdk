// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// Particle vertex shader — instanced expanded-line segments (OpenLayers).
// Each particle (per world copy) is ONE instance; the 6 per-vertex
// \`a_corner\` values (two triangles of a unit quad) expand the particle's
// prev->cur move into a screen-space quad of width \`u_point_size·SCALE\`,
// with half-width square end-caps so consecutive frames' segments overlap
// into a continuous trail and a stationary particle still renders as a dot.
// Drawing the per-frame MOVE as a connected quad (rather than a GL_POINT)
// makes trails continuous at ANY speed — fast particles draw long segments
// instead of skipping pixels — so no max-speed cap is needed.
//
// All geometry is in CSS pixels (the same space the CPU projects endpoints
// into); clip conversion via u_size happens last, so no DPR term is needed
// (the device-resolution framebuffer just rasterises the normalised clip
// coords at native res).

#ifdef GPU_SIM
// GPU-simulation input: prev/cur positions come from ping-pong RGBA8 position
// textures (one texel per particle, indexed by gl_InstanceID), not attributes.
// Positions are viewport-local [0,1] packed 16-bit/axis; decode -> mercator-
// world -> delta from the viewport top-left (u_tl), then through the
// OpenLayers coordinate->pixel transform (linear part only — the translation
// cancels in a delta) to CSS px so the geometry below is unchanged. Working in
// a small delta keeps the big absolute mercator magnitude out of float32.
// Speed (for color) is sampled from the velocity texture at the cur position.
uniform sampler2D u_posPrev;
uniform sampler2D u_posCur;
uniform sampler2D u_velTex;
uniform int u_texW;            // position-texture width (texels)
uniform vec2 u_seedOrigin;     // mercator-world origin of the padded seed bbox
uniform vec2 u_seedSpan;       // mercator-world span of the padded seed bbox
uniform vec2 u_tl;             // viewport top-left mercator-world (proj origin)
uniform float u_world_ext;     // WORLD_EXT_3857 (mercator-world [0,1] -> meters)
uniform vec4 u_ol_lin;         // OL coordinateToPixelTransform linear (a,b,c,d)
uniform float u_dec_scale;     // velocity encoding scale (for speed/color)
uniform float u_dec_offset;    // velocity encoding offset
uniform float u_inv_speed_ref; // 1 / speedRef (normalises speed for palette)

float dec16(float hi, float lo) { return (hi * 255.0 * 256.0 + lo * 255.0) / 65535.0; }
vec2 decodeLocal(vec4 p) { return vec2(dec16(p.r, p.g), dec16(p.b, p.a)); }
float speedAt(vec2 uv) {
  vec4 t = texture(u_velTex, uv);            // NEAREST: no byte-boundary interp
  if (t == vec4(0.0)) return 0.0;            // no-data sentinel
  float u = (t.r * 255.0 * 256.0 + t.g * 255.0) * u_dec_scale + u_dec_offset;
  float v = (t.b * 255.0 * 256.0 + t.a * 255.0) * u_dec_scale + u_dec_offset;
  return length(vec2(u, v));
}
// mercator-world delta-from-tl -> CSS px (relative to viewport top-left (0,0)).
vec2 worldDeltaToPx(vec2 dWorld) {
  vec2 d3857 = vec2(dWorld.x * u_world_ext, -dWorld.y * u_world_ext);
  return vec2(u_ol_lin.x * d3857.x + u_ol_lin.z * d3857.y,
              u_ol_lin.y * d3857.x + u_ol_lin.w * d3857.y);
}
#else
in vec2 a_prev;       // per-instance: previous position, CSS px
in vec2 a_cur;        // per-instance: current  position, CSS px
in float a_speed_t;   // per-instance: speed normalised to [0,1] vs speedRef
#endif

in vec2 a_corner;     // per-vertex: (end, side) — end 0=prev 1=cur, side -1/+1
uniform vec2 u_size;          // CSS px
uniform float u_point_size;
const float POINT_SIZE_SCALE = 1.0 / 3.0;
out float v_speed_t;
out float v_edge;             // signed cross-line coord (-1..1) for edge AA

vec2 toClip(vec2 px) {
  return vec2(px.x / u_size.x * 2.0 - 1.0, 1.0 - px.y / u_size.y * 2.0);
}

void main() {
#ifdef GPU_SIM
  // One texel per particle; gl_InstanceID -> (col, row).
  ivec2 texel = ivec2(gl_InstanceID % u_texW, gl_InstanceID / u_texW);
  vec4 pPrev = texelFetch(u_posPrev, texel, 0);
  vec4 pCur  = texelFetch(u_posCur,  texel, 0);
  bool dead = (pPrev == vec4(0.0)) || (pCur == vec4(0.0));   // all-zero sentinel
  vec2 localCur = decodeLocal(pCur);
  vec2 dPrev = (u_seedOrigin - u_tl) + decodeLocal(pPrev) * u_seedSpan;
  vec2 dCur  = (u_seedOrigin - u_tl) + localCur * u_seedSpan;
  float a_speed_t = speedAt(localCur) * u_inv_speed_ref;
  vec2 a_prev = worldDeltaToPx(dPrev);
  vec2 a_cur  = worldDeltaToPx(dCur);
  // Teleport guard (screen-space): a freshly reseeded/recycled particle can
  // pair a prev and cur from different ping-pong generations, drawing a segment
  // that spans the map. A legitimate per-frame step is at most a few CSS px
  // (the field moves slowly; step px = vel*speedScale*256, zoom-independent),
  // so collapse anything longer than 40 px to a dot. This is screen-space, not
  // the local-fraction test the other GPU bindings use, because at low zoom a
  // small local fraction is still a long line clear across the map. The
  // negated form ALSO collapses NaN/Inf endpoints: NaN < 40.0 is false, so
  // the negation is true and we collapse. A plain dist > 40.0 test is false
  // for NaN and would let a NaN endpoint draw a line to infinity.
  if (!(distance(a_prev, a_cur) < 40.0)) a_prev = a_cur;
  // Dead-particle sentinel: push all 6 vertices off-screen so the whole
  // instance is culled before rasterization.
  if (dead) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_speed_t = 0.0;
    v_edge = 0.0;
    return;
  }
#endif
  vec2 tangent = a_cur - a_prev;   // CSS px
  float tLen = length(tangent);
  // Degenerate (near-zero step): fixed axes so the caps draw a square dot
  // rather than collapsing to NaN.
  vec2 tdir   = tLen > 1e-4 ? tangent / tLen                     : vec2(1.0, 0.0);
  vec2 normal = tLen > 1e-4 ? vec2(-tangent.y, tangent.x) / tLen : vec2(0.0, 1.0);

  float end  = a_corner.x;   // 0 = prev, 1 = cur
  float side = a_corner.y;   // -1 / +1
  float halfW = u_point_size * POINT_SIZE_SCALE * 0.5;  // CSS px
  vec2 basePx = mix(a_prev, a_cur, end);

  // Perpendicular offset gives the width; the longitudinal half-width cap
  // (prev backward, cur forward) makes consecutive segments overlap into a
  // seamless trail and turns a zero-length step into a centered dot.
  float along = end < 0.5 ? -1.0 : 1.0;
  vec2 px = basePx + normal * side * halfW + tdir * along * halfW;

  gl_Position = vec4(toClip(px), 0.0, 1.0);
  v_speed_t = a_speed_t;
  v_edge = side;
}
`;
