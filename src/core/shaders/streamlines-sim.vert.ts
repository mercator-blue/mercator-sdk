// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// Fullscreen-quad vertex shader for the GPU particle-simulation pass. The
// position texture is treated as a render target; each fragment is one
// particle. a_pos is the [0,1] quad (shared quadVbo); no varyings are needed
// because the sim fragment shader keys off gl_FragCoord (= the texel/particle).
in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
`;
