#version 300 es
in vec2 a_pos;
in float a_speed;
uniform vec2 u_proj_scale;
uniform float u_size;
out float v_speed;
void main() {
  if (a_speed < 0.0) {
    // Dead particle: clip away.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec2 clip = vec2(-1.0, 1.0) + a_pos * u_proj_scale;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = u_size;
  v_speed = a_speed;
}
