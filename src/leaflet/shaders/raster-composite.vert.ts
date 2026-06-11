// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// Compositor vertex shader: full-screen quad. Pairs with raster-composite.frag.
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
`;
