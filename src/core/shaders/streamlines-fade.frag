// Trail-buffer fade pass. Reads the previous frame's trail FBO, multiplies
// by `u_fade` (e.g. 0.99 for slow decay), then subtracts ~half a uint8
// quantum before writing.
//
// The trail FBO is RGBA uint8 — channels quantize to 1/255 steps. Once a
// pixel reaches 1/255, multiplying by any fade < 1 still rounds back to
// 1/255 (1/255 × 0.99 = 0.99/255 → quantized to 1/255), so trails would
// get stuck at the lowest non-zero value and permanently lighten the
// basemap. Subtracting just over half a quantum forces values below
// 1/255 to quantize to 0 instead.

precision highp float;

varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_fade;

void main() {
  vec4 c = texture2D(u_tex, v_uv) * u_fade;
  gl_FragColor = max(c - vec4(0.6 / 255.0), vec4(0.0));
}
