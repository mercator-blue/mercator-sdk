// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// Particle fragment shader — expanded-line segments (OpenLayers). White,
// or a 256×1 RGBA palette LUT sampled at the particle's speed_t when
// colour-by-speed is on. v_edge is the signed perpendicular coord across
// the line width; we soft-clip the long edges with a ~1px AA band (fwidth)
// so trails aren't hard-edged. (Cap ends are left hard — mid-trail they
// overlap the next segment, so only the head/tail show, and that reads fine.)
precision highp float;
in float v_speed_t;
in float v_edge;
uniform float u_color_by_speed;
uniform sampler2D u_palette;
out vec4 fragColor;
void main() {
  float aa = max(fwidth(v_edge), 1e-4);
  float a = 1.0 - smoothstep(1.0 - aa, 1.0, abs(v_edge));
  if (a <= 0.0) discard;
  vec3 rampCol = texture(u_palette, vec2(clamp(v_speed_t, 0.0, 1.0), 0.5)).rgb;
  vec3 col = mix(vec3(1.0), rampCol, u_color_by_speed);
  fragColor = vec4(col * a, a);  // premultiplied — matches the ONE/ONE blend
}
`;
