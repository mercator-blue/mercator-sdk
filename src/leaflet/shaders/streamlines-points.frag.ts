// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// Particle fragment shader — expanded-line segments (Leaflet). Colors by
// speed via the colormap LUT (256×1 RGBA) when enabled, else white. v_edge
// is the signed perpendicular coord across the line width; we soft-clip the
// long edges with a ~1px AA band (fwidth) so trails aren't hard-edged. (Cap
// ends are left hard — mid-trail they overlap the next segment, so only the
// head/tail show, and that reads fine.)
precision highp float;
in float v_speed;
in float v_edge;
uniform float u_opacity;
uniform float u_vmin;
uniform float u_vmax;
uniform float u_colorBySpeed;
uniform sampler2D u_colormap;  // 256x1 RGBA LUT (see core/colormap-texture.ts)
out vec4 fragColor;
vec3 colormap(float t) {
  return texture(u_colormap, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
}
void main() {
  // Soft perpendicular edge: full alpha in the core, fading to 0 at
  // |v_edge| = 1 over a ~1px band regardless of line width.
  float aa = max(fwidth(v_edge), 1e-4);
  float a = (1.0 - smoothstep(1.0 - aa, 1.0, abs(v_edge))) * u_opacity;
  if (a <= 0.0) discard;
  vec3 col = vec3(1.0);
  if (u_colorBySpeed > 0.5) {
    float t = (v_speed - u_vmin) / (u_vmax - u_vmin);
    col = colormap(t);
  }
  fragColor = vec4(col * a, a);
}
`;
