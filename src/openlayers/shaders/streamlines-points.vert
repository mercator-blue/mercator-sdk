#version 300 es
// Particle vertex shader — instanced expanded-line segments (OpenLayers).
// Each particle (per world copy) is ONE instance; the 6 per-vertex
// `a_corner` values (two triangles of a unit quad) expand the particle's
// prev->cur move into a screen-space quad of width `u_point_size·SCALE`,
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
in vec2 a_prev;       // per-instance: previous position, CSS px
in vec2 a_cur;        // per-instance: current  position, CSS px
in float a_speed_t;   // per-instance: speed normalised to [0,1] vs speedRef
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
