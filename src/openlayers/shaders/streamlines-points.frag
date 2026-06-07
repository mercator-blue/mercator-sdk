#version 300 es
// When `u_color_by_speed` is 0 we render white; when 1 we sample a 256×1
// RGBA palette LUT at the particle's speed_t. `mix` is the GPU's
// branchless conditional.
precision highp float;
in float v_speed_t;
uniform float u_color_by_speed;
uniform sampler2D u_palette;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;
  vec3 rampCol = texture(u_palette, vec2(clamp(v_speed_t, 0.0, 1.0), 0.5)).rgb;
  vec3 col = mix(vec3(1.0), rampCol, u_color_by_speed);
  fragColor = vec4(col, 1.0);
}
