// Contour-line fragment shader.
//
// Single uniform color + opacity. The casing pass uses a white/light
// color at partial opacity; the main pass uses a dark color at full
// opacity. Two host-side draws against the same VBO with different
// uniforms achieve the casing-under-main look without per-vertex
// branching.

precision highp float;

out vec4 fragColor;

uniform vec4 u_color;   // RGBA premultiplied? no — straight alpha; blend func handles it
uniform float u_opacity;

void main() {
  fragColor = vec4(u_color.rgb, u_color.a * u_opacity);
}
