// Particle vertex shader. Loaded as a raw string and concatenated at
// runtime with `#version 300 es` + MapLibre's projection prelude.
//
// The GLOBE branch inlines MapLibre's `interpolateProjection`: project
// mercator → sphere → clip space and set `pos.z = (1 - front) * pos.w`
// so visible points land in NDC-z ∈ [0, 1] and back-facing points get
// NDC-z > 1 and clip at the far plane. Same formula the basemap uses —
// works at every zoom including the regime where `pos.w` shrinks to
// ~0.003 at extreme zoom. We don't call `projectTile()` directly
// because its pole-vertex special case only matters for tile geometry,
// not for particles in [0, 1]² mercator.

// a_pos is a particle's mercator position as a DELTA from u_origin, not
// the absolute mercator coord. Float32 ULP at an absolute mercator coord
// near 0.5 is ~6e-8 — several pixels wide at z=15+, which collapses per-
// frame particle motion onto a coarse grid. Storing small deltas (~3e-5
// within the viewport) gives float32 ULPs of ~3e-12, so per-frame motion
// is preserved through the buffer upload.
//
// CRITICAL: we must NOT reconstruct the absolute coord in the shader
// (worldPos = a_pos + u_origin → float32 quantization, defeats the
// whole exercise). The Mercator path instead:
//   - takes u_origin_clip (the origin's clip-space coords, computed on
//     CPU using JS float64 against the float32 matrix MapLibre provides),
//   - applies u_projection_matrix to (a_pos, 0, 0) so the matrix's huge
//     translation column doesn't multiply against the catastrophic-
//     cancellation pair (mat * 0.5 + mat * -0.5 ≈ 0 with large absolute
//     error). The linear part applied to a small delta has full float32
//     precision.
//   - sums origin_clip + delta_clip in clip space, where the magnitudes
//     are O(1) and the float32 ULP is comfortably below pixel scale.
//
// The Globe path keeps the old worldPos reconstruction for now; the
// non-linear projectToSphere doesn't admit the same split trivially.
// At extreme zoom where precision matters, globe has effectively
// flattened to Mercator anyway — revisit if a globe artifact shows up.
in vec2 a_pos;
in float a_speed;
uniform vec2 u_origin;            // only used by the GLOBE branch
uniform vec4 u_origin_clip;       // origin's clip-space coords (Mercator branch)
uniform float u_pointSize;
out float v_speed;

void main() {
  // a_speed < 0 is the "dead particle" sentinel — makeParticle returns it
  // when every seed candidate lands on no-data (viewport entirely over
  // land past MAX_Z). Send the vertex outside clip space so the clipper
  // culls it before rasterization (PointSize=0 alone is unreliable —
  // some GPUs clamp to 1px and would render an 8000-particle speckle).
  if (a_speed < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    v_speed = 0.0;
    return;
  }
#ifdef GLOBE
  // MapLibre globe path. Sphere projection is non-linear so the
  // origin+delta split doesn't trivially apply — reconstruct the
  // absolute position, project to the sphere, and clip back-facing
  // points via the basemap's own clipping-plane formula.
  vec2 worldPos = a_pos + u_origin;
  vec3 spherePos = projectToSphere(worldPos);
  vec4 pos = u_projection_matrix * vec4(spherePos, 1.0);
  float front = dot(spherePos, u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w;
  pos.z = (1.0 - front) * pos.w;
  gl_Position = pos;
#elif defined(MAPBOX_GLOBE)
  // Mapbox globe path. The prelude's projectTile() does the full
  // mercator → lat/lng → ECEF → mercator-world → matrix pipeline,
  // mixing globe/flat coords by Mapbox's own transition factor — same
  // path the arrows + tile-bounds shaders use via their #else clause.
  // We reconstruct the absolute mercator position because projectTile
  // is non-linear and the split-precision trick doesn't apply to it.
  // Per-frame motion at globe zooms is large enough that float32 ULP
  // on the reconstructed position isn't visible; at the high zooms
  // where it would be, Mapbox has effectively flattened (transition →
  // 1) and our flat-Mercator binding takes over via beforeId stacking
  // before precision shows.
  vec2 worldPos = a_pos + u_origin;
  gl_Position = projectTile(worldPos);
#else
  // Flat Mercator (MapLibre OR Mapbox): split-precision path. Linear
  // matrix application to the delta avoids catastrophic-cancellation
  // precision loss that collapses per-frame particle motion onto a
  // ~6e-8 grid past ~z=15.
  vec4 deltaClip = u_projection_matrix * vec4(a_pos, 0.0, 0.0);
  gl_Position = u_origin_clip + deltaClip;
#endif
  gl_PointSize = u_pointSize;
  v_speed = a_speed;
}
