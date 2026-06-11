// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Vector-encoded tile decoder. Reads \`vector_rg_ba\` u/v components from
// R+G and B+A byte pairs, decodes each via \`(hi*256 + lo) * scale + offset\`,
// then colors by speed using viridis.
//
// \`u_smooth\` selects manual NaN-aware bilinear vs nearest. Same reasoning
// as raster-scalar: hardware LINEAR on byte pairs blends across byte
// rollovers and decodes to garbage. We texelFetch 4 corners, decode each
// (u, v) pair, then bilinearly interpolate the decoded vectors. Speed is
// computed from the interpolated vector — interpolating speed directly
// would underestimate near vortices where direction reverses but |v|
// stays high.
//
// Tile-edge seam fix: see raster-scalar.frag — \`sampleTile()\` here is
// identical and consults neighbour textures when a bilinear corner index
// escapes [0, sz-1].

precision highp float;

in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_texN, u_texS, u_texW, u_texE;
uniform vec4 u_has;
uniform float u_scale, u_offset, u_vmin, u_vmax, u_opacity, u_smooth;
// Colormap LUT as a 256×1 RGBA texture — see raster-scalar.frag.
uniform sampler2D u_colormap;
out vec4 fragColor;

vec3 colormap(float t) {
  return texture(u_colormap, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
}

// Returns vec3(u, v, valid). valid = 1 unless this texel is the
// (0,0,0,0) no-data sentinel, in which case 0 — used to drop the
// corner's weight in the bilinear blend.
vec3 decode(vec4 tex) {
  float r = floor(tex.r * 255.0 + 0.5);
  float g = floor(tex.g * 255.0 + 0.5);
  float b = floor(tex.b * 255.0 + 0.5);
  float a = floor(tex.a * 255.0 + 0.5);
  float valid = step(0.5, r + g + b + a);
  float u = (r * 256.0 + g) * u_scale + u_offset;
  float v = (b * 256.0 + a) * u_scale + u_offset;
  return vec3(u, v, valid);
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

  vec3 d00 = decode(sampleTile(i0.x, i0.y));
  vec3 d10 = decode(sampleTile(i1.x, i0.y));
  vec3 d01 = decode(sampleTile(i0.x, i1.y));
  vec3 d11 = decode(sampleTile(i1.x, i1.y));

  // Bilinear weights × validity. The sum is the fragment's coverage of
  // valid data — full inside the ocean grid, partial at coastlines, zero
  // over pure land. Same coverage-aware-alpha model as raster-scalar.frag.
  float w00 = (1.0 - frac.x) * (1.0 - frac.y) * d00.z;
  float w10 = frac.x         * (1.0 - frac.y) * d10.z;
  float w01 = (1.0 - frac.x) * frac.y         * d01.z;
  float w11 = frac.x         * frac.y         * d11.z;
  float coverage = w00 + w10 + w01 + w11;
  if (coverage < 1e-6) discard;

  float u = (d00.x * w00 + d10.x * w10 + d01.x * w01 + d11.x * w11) / coverage;
  float v = (d00.y * w00 + d10.y * w10 + d01.y * w01 + d11.y * w11) / coverage;
  float speed = sqrt(u * u + v * v);
  float t = (speed - u_vmin) / (u_vmax - u_vmin);
  float alpha = u_opacity * coverage;
  fragColor = vec4(colormap(t) * alpha, alpha);
}
`;
