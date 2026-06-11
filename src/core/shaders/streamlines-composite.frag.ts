// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Final composite: sample the trail FBO and scale by user-visible opacity
// before blending over the basemap. The texture is premultiplied alpha,
// so the caller pairs this with \`gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA)\`.

precision highp float;

varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;

void main() {
  gl_FragColor = texture2D(u_tex, v_uv) * u_opacity;
}
`;
