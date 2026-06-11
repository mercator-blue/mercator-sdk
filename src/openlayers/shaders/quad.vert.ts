// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// Fullscreen-quad vertex shader used by the fade pass. ES 3.00 dialect
// (matches the rest of the OL streamlines pipeline).
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
