// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Tile-quad vertex shader. Loaded as a raw string and concatenated at
// runtime with \`#version 300 es\` + MapLibre's projection prelude.
//
// The GLOBE branch inlines MapLibre's \`interpolateProjection\`: project
// mercator → sphere → clip space and set \`pos.z = (1 - front) * pos.w\`
// so visible quads land in NDC-z ∈ [0, 1] and back-facing parts clip at
// the far plane. Same formula the basemap uses; works at every zoom
// including the extreme regime where \`pos.w\` shrinks to ~0.003.

in vec2 a_pos;
uniform vec4 u_tile;
out vec2 v_uv;

void main() {
  vec2 worldPos = u_tile.xy + a_pos * u_tile.zw;
#ifdef GLOBE
  vec3 spherePos = projectToSphere(worldPos);
  vec4 pos = u_projection_matrix * vec4(spherePos, 1.0);
  float front = dot(spherePos, u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w;
  pos.z = (1.0 - front) * pos.w;
  gl_Position = pos;
#else
  gl_Position = projectTile(worldPos);
#endif
  v_uv = a_pos;
}
`;
