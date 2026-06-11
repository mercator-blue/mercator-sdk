// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Mapbox Terrain-RGB elevation decoder + hypsometric coloring.
//
// Decoding:  height_m = -10000 + (R * 65536 + G * 256 + B) * 0.1
//
// \`u_smooth\` selects manual bilinear vs nearest, same convention as
// raster-scalar / raster-vector. Hardware LINEAR can't be used here:
// the 24-bit packing means linear filtering across a byte boundary
// (e.g. R=1,G=255,B=255 -> R=2,G=0,B=0 is +0.1 m) would produce a
// catastrophic average. We texelFetch the 4 neighbouring texels,
// decode each height, and bilinearly blend the decoded scalars.
//
// Color ramp: hypsometric tinting that's broadly used in topo maps —
// dark blue for abyssal depths, light blue near coast, green at low
// elevations, yellow/tan in foothills, brown in mountains, white snow.
//
// Tile-edge seam fix: see raster-scalar.frag — \`sampleTile()\` reads
// from N/S/W/E neighbour textures when a bilinear corner index escapes
// [0, sz-1], so the two abutting tiles' bilinears actually meet at the
// shared boundary.

precision highp float;

in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_texN, u_texS, u_texW, u_texE;
uniform vec4 u_has;  // 1.0 = neighbour present; .x=N .y=S .z=W .w=E
uniform float u_opacity, u_smooth;
out vec4 fragColor;

float decode(vec4 tex) {
  float R = floor(tex.r * 255.0 + 0.5);
  float G = floor(tex.g * 255.0 + 0.5);
  float B = floor(tex.b * 255.0 + 0.5);
  return -10000.0 + (R * 65536.0 + G * 256.0 + B) * 0.1;
}

vec3 hypsometric(float h) {
  if (h <= 0.0) {
    // Sea: deep dark blue -> shallow cyan-blue.
    float t = clamp((h + 8000.0) / 8000.0, 0.0, 1.0);
    return mix(vec3(0.02, 0.05, 0.18), vec3(0.55, 0.78, 0.95), t);
  }
  // Land: shoreline green -> highland white.
  if (h < 500.0)  return mix(vec3(0.32, 0.55, 0.20), vec3(0.65, 0.78, 0.40), h / 500.0);
  if (h < 1500.0) return mix(vec3(0.65, 0.78, 0.40), vec3(0.85, 0.75, 0.40), (h - 500.0) / 1000.0);
  if (h < 3000.0) return mix(vec3(0.85, 0.75, 0.40), vec3(0.65, 0.50, 0.35), (h - 1500.0) / 1500.0);
  if (h < 5000.0) return mix(vec3(0.65, 0.50, 0.35), vec3(0.85, 0.80, 0.75), (h - 3000.0) / 2000.0);
  return mix(vec3(0.85, 0.80, 0.75), vec3(1.0, 1.0, 1.0),
             clamp((h - 5000.0) / 3000.0, 0.0, 1.0));
}

vec4 sampleTile(int ix, int iy) {
  int sz = textureSize(u_tex, 0).x;
  if (iy < 0) {
    if (u_has.x > 0.5) {
      ix = clamp(ix, 0, sz - 1);
      return texelFetch(u_texN, ivec2(ix, iy + sz), 0);
    }
    iy = 0;
  } else if (iy >= sz) {
    if (u_has.y > 0.5) {
      ix = clamp(ix, 0, sz - 1);
      return texelFetch(u_texS, ivec2(ix, iy - sz), 0);
    }
    iy = sz - 1;
  }
  if (ix < 0) {
    if (u_has.z > 0.5) return texelFetch(u_texW, ivec2(ix + sz, iy), 0);
    ix = 0;
  } else if (ix >= sz) {
    if (u_has.w > 0.5) return texelFetch(u_texE, ivec2(ix - sz, iy), 0);
    ix = sz - 1;
  }
  return texelFetch(u_tex, ivec2(ix, iy), 0);
}

void main() {
  ivec2 sz = textureSize(u_tex, 0);
  vec2 px = v_uv * vec2(sz) - 0.5;

  vec2 p_floor = (u_smooth > 0.5) ? floor(px) : floor(px + 0.5);
  vec2 frac    = (u_smooth > 0.5) ? (px - p_floor) : vec2(0.0);

  ivec2 i0 = ivec2(p_floor);
  ivec2 i1 = i0 + ivec2(1);

  float h00 = decode(sampleTile(i0.x, i0.y));
  float h10 = decode(sampleTile(i1.x, i0.y));
  float h01 = decode(sampleTile(i0.x, i1.y));
  float h11 = decode(sampleTile(i1.x, i1.y));

  float w00 = (1.0 - frac.x) * (1.0 - frac.y);
  float w10 = frac.x         * (1.0 - frac.y);
  float w01 = (1.0 - frac.x) * frac.y;
  float w11 = frac.x         * frac.y;

  float h = h00 * w00 + h10 * w10 + h01 * w01 + h11 * w11;
  fragColor = vec4(hypsometric(h) * u_opacity, u_opacity);
}
`;
