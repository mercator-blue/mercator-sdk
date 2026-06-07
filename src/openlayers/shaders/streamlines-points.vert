#version 300 es
// Per-vertex `a_speed_t` is the particle's speed normalised to `[0, 1]`
// against `speedRef` (clamped). Passed through to the fragment shader
// where it indexes the palette LUT when colour-by-speed is enabled.
in vec2 a_pos;
in float a_speed_t;
uniform vec2 u_size;
uniform float u_dpr;
uniform float u_point_size;
const float POINT_SIZE_SCALE = 1.0 / 3.0;
out float v_speed_t;
void main() {
  vec2 clip = vec2(
    a_pos.x / u_size.x * 2.0 - 1.0,
    1.0 - a_pos.y / u_size.y * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = u_point_size * u_dpr * POINT_SIZE_SCALE;
  v_speed_t = a_speed_t;
}
