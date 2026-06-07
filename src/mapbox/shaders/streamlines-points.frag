// Particle fragment shader. Renders each gl_POINT as a soft disc;
// optionally colors by speed using the layer's colormap, a 256×1 RGBA LUT
// texture (same as the raster shaders — see resolveColormap() +
// core/colormap-texture.ts).

precision highp float;

in float v_speed;
uniform float u_opacity;
uniform float u_vmin;
uniform float u_vmax;
uniform float u_colorBySpeed;
uniform sampler2D u_colormap;
out vec4 fragColor;

vec3 colormap(float t) {
  return texture(u_colormap, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
}

void main() {
  float dist = length(gl_PointCoord - vec2(0.5));
  float a = (1.0 - smoothstep(0.4, 0.5, dist)) * u_opacity;
  if (a <= 0.0) discard;
  vec3 col = vec3(1.0);
  if (u_colorBySpeed > 0.5) {
    float t = (v_speed - u_vmin) / (u_vmax - u_vmin);
    col = colormap(t);
  }
  fragColor = vec4(col * a, a);
}
