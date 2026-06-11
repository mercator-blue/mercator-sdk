// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Fullscreen-quad vertex shader (GLSL 1.00 ES — no \`#version\` line so it
// pairs with the simple GLSL-1.00 fragment shaders for fade + composite).
// \`a_pos\` is in [0, 1]²; passes straight through to NDC and uv.

attribute vec2 a_pos;
varying vec2 v_uv;

void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  v_uv = a_pos;
}
`;
