// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Scalar-encoded tile decoder. Reads \`rg16_fixed\` values from R+G bytes
// of a tile texture, decodes via \`(R*256 + G) * scale + offset\`, then
// applies a diverging blue↔red colormap (cool/warm palette).
//
// Alpha channel is the validity mask: tex.a < 0.5 ⇒ no-data, discard.
//
// \`u_smooth\` selects between two sampling modes:
//   1.0 = manual bilinear in decoded-value space. Hardware LINEAR can't be
//         used on rg16_fixed because it would blend R and G bytes naively
//         across byte boundaries — at R=0x80,G=0xFF → R=0x81,G=0x00 (a
//         1-step delta in the encoded value) it would average to
//         R=0x80.5,G=0x7F.5 which decodes to something ~half the range away.
//         We instead texelFetch the 4 neighbouring texels, decode each,
//         and blend the decoded scalars. NaN-aware: invalid (alpha<0.5)
//         corners get weight 0 and the remaining weights are renormalised.
//   0.0 = nearest. Reproduces the original blocky look one texel per fragment.
//
// Tile-edge seam fix: the 4 bilinear corners are read via \`sampleTile()\`,
// which transparently reads from a neighbour tile (u_texN/S/W/E) when the
// corner index lands outside [0, sz-1]. Without this, edge fragments
// collapse to the row/column at the clamp and the two abutting tiles'
// bilinears don't meet — a 1-pixel seam visible at extreme overzoom in
// smooth mode. When the required neighbour isn't loaded (off-viewport
// tile pyramid edge), we fall back to edge-clamp (the previous behaviour).

precision highp float;

in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_texN, u_texS, u_texW, u_texE;
uniform vec4 u_has;  // 1.0 = neighbour present; .x=N .y=S .z=W .w=E
uniform float u_scale, u_offset, u_vmin, u_vmax, u_opacity, u_smooth;
// Scale-axis transform: 0.0 = linear (default), 1.0 = log. Log compresses
// the dynamic range for highly-skewed scalars (precipitation, snow) so a
// few storm cells don't push the rest of the field to a near-zero palette
// position. Formula: t = log(1 + value - vmin) / log(1 + vmax - vmin).
uniform float u_log_scale;
// Discard threshold. Pixels with decoded value at or below this are
// dropped (fragment is \`discard\`ed), so the basemap shows through where
// the dataset has effectively "nothing" (e.g. dry land for precipitation).
// Set to a very negative sentinel when no threshold is configured.
uniform float u_transparent_below;
// Alpha-by-value: when 1.0, output alpha = t * u_opacity (where t is the
// colormap position), so low values fade smoothly into the basemap rather
// than rendering as a flat overlay. Used for cloud cover and similar
// "amount of stuff in this column" fields. Default 0.0 = constant alpha.
uniform float u_alpha_by_value;
// Colormap LUT as a 256×1 RGBA texture. resolveColormap() (core/colormaps.ts)
// produces the canonical 256-entry table — a built-in palette or a
// customer { stops } spec resampled to 256 — which core/colormap-texture.ts
// uploads here with LINEAR filtering, so the shader samples a smoothly-
// interpolated colour with a single texture fetch (no per-fragment array
// search, and none of the banding the old 16-entry uniform array showed on
// large smooth fields).
uniform sampler2D u_colormap;
out vec4 fragColor;

vec3 colormap(float t) {
  return texture(u_colormap, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
}

float decode(vec4 tex) {
  float r_byte = floor(tex.r * 255.0 + 0.5);
  float g_byte = floor(tex.g * 255.0 + 0.5);
  return (r_byte * 256.0 + g_byte) * u_scale + u_offset;
}

// Read a texel that may lie outside [0,sz-1]. Out-of-range y consults
// the N/S neighbour; out-of-range x consults the W/E neighbour. Diagonal
// corner pixels (both axes out of range) fall through to the y-neighbour
// with clamped x — no diagonal neighbour lookup. Missing neighbour →
// edge-clamp on the centre tile.
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

  // p_floor is the lower-left texel index; frac is the per-axis blend in
  // [0,1]. Nearest mode snaps frac to 0 by rounding-to-center, which makes
  // the bilinear collapse to a single texel (w00=1, others=0).
  vec2 p_floor = (u_smooth > 0.5) ? floor(px) : floor(px + 0.5);
  vec2 frac    = (u_smooth > 0.5) ? (px - p_floor) : vec2(0.0);

  // Unclamped — sampleTile() handles indices outside [0, sz-1] by reading
  // from the appropriate neighbour tile.
  ivec2 i0 = ivec2(p_floor);
  ivec2 i1 = i0 + ivec2(1);

  vec4 t00 = sampleTile(i0.x, i0.y);
  vec4 t10 = sampleTile(i1.x, i0.y);
  vec4 t01 = sampleTile(i0.x, i1.y);
  vec4 t11 = sampleTile(i1.x, i1.y);

  // Bilinear weights × per-texel coverage (alpha in [0, 1]). The encoder
  // emits a graduated alpha byte at the source-grid level, so coastal tile
  // pixels carry a partial-coverage value rather than a binary on/off.
  // Multiplying spatial weight by alpha (instead of \`step(0.5, alpha)\`)
  // propagates that gradient through the shader bilinear and yields a
  // continuous edge fade at source-grid resolution.
  float w00 = (1.0 - frac.x) * (1.0 - frac.y) * t00.a;
  float w10 = frac.x         * (1.0 - frac.y) * t10.a;
  float w01 = (1.0 - frac.x) * frac.y         * t01.a;
  float w11 = frac.x         * frac.y         * t11.a;
  float coverage = w00 + w10 + w01 + w11;
  if (coverage < 1e-6) discard;

  // Value uses renormalised weights so the colour isn't biased by missing
  // corners (a single valid corner reads as its own value, not 1/4 of it).
  float value = (decode(t00) * w00 + decode(t10) * w10
               + decode(t01) * w01 + decode(t11) * w11) / coverage;

  // Skewed-scalar transparency: collections like precipitation set
  // u_transparent_below to ~0.1 mm so dry cells show the basemap instead
  // of the palette's pale-yellow low stop.
  if (value <= u_transparent_below) discard;

  // Linear vs log mapping to [0, 1]. The log branch uses log1p so value=0
  // at vmin maps to t=0 cleanly without a log(0) singularity.
  float span = max(u_vmax - u_vmin, 1e-9);
  float t = (u_log_scale > 0.5)
    ? log(1.0 + max(value - u_vmin, 0.0)) / log(1.0 + span)
    : (value - u_vmin) / span;
  float alpha = (u_alpha_by_value > 0.5)
    ? clamp(t, 0.0, 1.0) * u_opacity
    : u_opacity;
  // Coverage modulation: a fragment whose footprint only partially overlaps
  // valid data fades proportionally. For continuous datasets (no NaN cells)
  // coverage = 1 and this is a no-op. For ocean-only datasets like SWH the
  // bilinear gradient at coastlines becomes a smooth alpha fade instead of
  // a sharp staircase at the source-grid pixel boundary.
  alpha *= coverage;
  fragColor = vec4(colormap(t) * alpha, alpha);
}
`;
