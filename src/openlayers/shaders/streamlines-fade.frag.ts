// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// Fade pass: reads the previous frame's trail texture, multiplies by
// \`u_fade\`, subtracts a quantum floor (~0.6/255) so faint pixels actually
// reach 0 instead of getting stuck at the uint8 1/255 quantum — the
// documented "permanent veil" hazard from CLAUDE.md.
precision highp float;
in vec2 v_uv;
uniform sampler2D u_prev;
uniform float u_fade;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_prev, v_uv) * u_fade;
  c = max(vec4(0.0), c - vec4(0.6 / 255.0));
  fragColor = c;
}
`;
