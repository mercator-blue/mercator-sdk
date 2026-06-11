// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  fragColor = vec4(u_color.rgb, u_color.a * u_opacity);
}
`;
