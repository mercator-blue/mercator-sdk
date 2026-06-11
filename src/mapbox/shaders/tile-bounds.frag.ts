// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Tile-boundary line fragment shader. Solid magenta.

precision highp float;

out vec4 fragColor;

void main() {
  fragColor = vec4(1.0, 0.0, 1.0, 0.85);
}
`;
