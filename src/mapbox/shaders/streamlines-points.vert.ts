// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Particle vertex shader — instanced expanded-line segments.
//
// Each particle is ONE instance. The 6 per-vertex \`a_corner\` values (the
// two triangles of a unit quad) expand the particle's prev→cur move into a
// screen-space quad of width u_lineWidth, with half-width square end-caps so
// consecutive frames' segments overlap into a continuous trail and a
// stationary particle still renders as a dot. Drawing the per-frame MOVE as
// a connected quad (rather than a GL_POINT) makes trails continuous at ANY
// speed — fast particles draw long segments instead of skipping pixels — so
// no max-speed cap is needed.
//
// Projection mirrors the old point shader: split-precision on flat Mercator
// (origin_clip + matrix·delta) to preserve per-frame motion at high zoom;
// the MapLibre/Mapbox globe branches reconstruct the absolute position and
// project to the sphere. Both endpoints go through the same projectDelta();
// the quad expansion then happens in pixel space, exactly like
// contour-lines.vert.
//
// a_prev/a_cur are mercator positions stored as DELTAS from u_origin (not
// absolute coords): float32 ULP at an absolute mercator coord near 0.5 is
// ~6e-8 — several pixels at z=15+, which would collapse per-frame motion.
// Small deltas (~3e-5 within the viewport) keep ULP ~3e-12. The Mercator
// branch never reconstructs the absolute coord (worldPos = delta + origin →
// float32 quantization); it applies the matrix to the delta and sums with
// the CPU-computed origin clip coords. See the old streamlines-points.vert
// history for the full precision rationale.

in vec2 a_prev;    // per-instance: previous position, DELTA from u_origin
in vec2 a_cur;     // per-instance: current  position, DELTA from u_origin
in float a_speed;  // per-instance: true speed magnitude; < 0 = dead sentinel
in vec2 a_corner;  // per-vertex: (end, side) — end 0=prev 1=cur, side -1/+1

uniform vec2 u_origin;            // globe branches only
uniform vec4 u_origin_clip;       // flat-Mercator split-precision branch
uniform vec2 u_viewport;          // device px (trail-FBO size)
uniform float u_lineWidth;        // device px (full segment width)

out float v_speed;
out float v_edge;                 // signed cross-line coord (-1..1) for edge AA

vec4 projectDelta(vec2 delta) {
#ifdef GLOBE
  // MapLibre globe: reconstruct absolute pos, project to sphere, clip
  // back-facing via the basemap's own clipping-plane formula.
  vec3 spherePos = projectToSphere(delta + u_origin);
  vec4 p = u_projection_matrix * vec4(spherePos, 1.0);
  float front = dot(spherePos, u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w;
  p.z = (1.0 - front) * p.w;
  return p;
#elif defined(MAPBOX_GLOBE)
  // Mapbox globe: prelude's projectTile() does the full globe pipeline.
  return projectTile(delta + u_origin);
#else
  // Flat Mercator (MapLibre OR Mapbox): split-precision — linear matrix
  // application to the small delta, summed with the origin's clip coords.
  return u_origin_clip + u_projection_matrix * vec4(delta, 0.0, 0.0);
#endif
}

void main() {
  // Dead-particle sentinel: push all 6 vertices outside clip space so the
  // whole instance is culled before rasterization.
  if (a_speed < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_speed = 0.0;
    v_edge = 0.0;
    return;
  }

  vec4 posPrev = projectDelta(a_prev);
  vec4 posCur  = projectDelta(a_cur);

  // Endpoints in pixel space (perspective-divided) to build the screen-space
  // tangent + perpendicular, like contour-lines.vert.
  vec2 pixPrev = (posPrev.xy / posPrev.w) * 0.5 * u_viewport;
  vec2 pixCur  = (posCur.xy  / posCur.w ) * 0.5 * u_viewport;

  vec2 tangent = pixCur - pixPrev;
  float tLen = length(tangent);
  // Degenerate (near-zero step): fixed axes so the caps draw a
  // lineWidth×lineWidth square (a dot) rather than collapsing to NaN.
  vec2 tdir   = tLen > 1e-4 ? tangent / tLen                     : vec2(1.0, 0.0);
  vec2 normal = tLen > 1e-4 ? vec2(-tangent.y, tangent.x) / tLen : vec2(0.0, 1.0);

  float end  = a_corner.x;   // 0 = prev, 1 = cur
  float side = a_corner.y;   // -1 / +1
  float halfW = u_lineWidth * 0.5;
  vec4 basePos = mix(posPrev, posCur, end);

  // Perpendicular offset gives the width; the longitudinal half-width cap
  // (prev extended backward, cur forward) makes consecutive segments overlap
  // into a seamless trail and turns a zero-length step into a centered dot.
  float along = end < 0.5 ? -1.0 : 1.0;
  vec2 offsetPx = normal * side * halfW + tdir * along * halfW;
  vec2 offsetClip = offsetPx / (0.5 * u_viewport) * basePos.w;

  gl_Position = vec4(basePos.xy + offsetClip, basePos.z, basePos.w);
  v_speed = a_speed;
  v_edge = side;
}
`;
