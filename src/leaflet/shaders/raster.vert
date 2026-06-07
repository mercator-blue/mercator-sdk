#version 300 es
// Mercator-only vertex shader. `u_matrix` maps mercator-world [0,1]² → clip space.
in vec2 a_pos;
uniform vec4 u_tile;   // (tile_x/n, tile_y/n, 1/n, 1/n) — origin + size in mercator-world
uniform mat4 u_matrix; // mercator-world → clip space
out vec2 v_uv;
void main() {
  vec2 worldPos = u_tile.xy + a_pos * u_tile.zw;
  gl_Position = u_matrix * vec4(worldPos, 0.0, 1.0);
  v_uv = a_pos;
}
