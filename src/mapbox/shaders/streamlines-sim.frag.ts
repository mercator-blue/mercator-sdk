// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// GPU particle-simulation pass. One fragment = one particle (indexed by
// gl_FragCoord against the position texture). Reads the particle's
// viewport-local position from u_posIn, samples the assembled velocity
// texture, advects one step, and writes the new viewport-local position back
// (RGBA8, 16-bit per axis). No float textures: positions are byte-packed.
//
// Coordinate frame: viewport-local [0,1] over the padded seed bbox. The same
// frame is the velocity-texture UV (velTex is assembled over that bbox), so a
// particle's local position IS its velTex UV. mercator = seedOrigin +
// local * seedSpan; we integrate in mercator (isotropic min-step floor) then
// convert back. Dead/recycled particles are the all-zero sentinel; the CPU
// round-robin reseed overwrites those texels.

precision highp float;

uniform sampler2D u_posIn;     // current viewport-local positions (RGBA8)
uniform sampler2D u_velTex;    // assembled vector_rg_ba velocity (RGBA8, NEAREST)
uniform ivec2 u_velSize;       // velTex dimensions, for texelFetch bilinear
uniform vec2 u_seedSpan;       // mercator span (x, y) of the padded seed bbox
uniform float u_decScale;      // encoding scale  (value = (hi*256+lo)*scale+offset)
uniform float u_decOffset;     // encoding offset
uniform float u_eff;           // speedScale * 0.5^zoom (globe-capped); m/s -> mercator
uniform float u_minStepMerc;   // per-frame step floor, mercator units

out vec4 fragColor;

float dec16(float hi, float lo) { return (hi * 255.0 * 256.0 + lo * 255.0) / 65535.0; }
float decVal(float hi, float lo) { return (hi * 255.0 * 256.0 + lo * 255.0) * u_decScale + u_decOffset; }

// Sentinel-aware bilinear sample of the velocity texture at local/UV coord.
// Mirrors the CPU sampleWindAtZoom: skip all-zero (no-data) texels and
// renormalize; bail when less than ~10% of the kernel is valid.
bool sampleVel(vec2 uv, out vec2 vel) {
  vec2 tc = uv * vec2(u_velSize) - 0.5;
  ivec2 i0 = ivec2(floor(tc));
  vec2 f = tc - vec2(i0);
  ivec2 lo = ivec2(0);
  ivec2 hi = u_velSize - 1;
  ivec2 i00 = clamp(i0, lo, hi);
  ivec2 i11 = clamp(i0 + 1, lo, hi);
  ivec2 i01 = ivec2(i11.x, i00.y);
  ivec2 i10 = ivec2(i00.x, i11.y);
  vec4 t00 = texelFetch(u_velTex, i00, 0);
  vec4 t01 = texelFetch(u_velTex, i01, 0);
  vec4 t10 = texelFetch(u_velTex, i10, 0);
  vec4 t11 = texelFetch(u_velTex, i11, 0);
  float w00 = (1.0 - f.x) * (1.0 - f.y);
  float w01 = f.x * (1.0 - f.y);
  float w10 = (1.0 - f.x) * f.y;
  float w11 = f.x * f.y;
  float ws = 0.0;
  vec2 acc = vec2(0.0);
  if (any(greaterThan(t00, vec4(0.0)))) { ws += w00; acc += w00 * vec2(decVal(t00.r, t00.g), decVal(t00.b, t00.a)); }
  if (any(greaterThan(t01, vec4(0.0)))) { ws += w01; acc += w01 * vec2(decVal(t01.r, t01.g), decVal(t01.b, t01.a)); }
  if (any(greaterThan(t10, vec4(0.0)))) { ws += w10; acc += w10 * vec2(decVal(t10.r, t10.g), decVal(t10.b, t10.a)); }
  if (any(greaterThan(t11, vec4(0.0)))) { ws += w11; acc += w11 * vec2(decVal(t11.r, t11.g), decVal(t11.b, t11.a)); }
  if (ws < 0.1) return false;
  vel = acc / ws;
  return true;
}

void main() {
  vec4 pin = texelFetch(u_posIn, ivec2(gl_FragCoord.xy), 0);
  // Dead/empty sentinel: stays dead until the CPU reseed overwrites it.
  if (pin == vec4(0.0)) { fragColor = vec4(0.0); return; }

  vec2 local = vec2(dec16(pin.r, pin.g), dec16(pin.b, pin.a));
  vec2 vel;
  if (!sampleVel(local, vel)) { fragColor = vec4(0.0); return; }  // on land / no-data

  // Integrate in mercator. v points north-positive; mercator-y grows
  // southward, hence -vel.y. Floor the step (preserving direction) so
  // near-calm particles still drift; genuine zero stays put.
  vec2 stepMerc = vec2(vel.x, -vel.y) * u_eff;
  float mag = length(stepMerc);
  if (mag > 0.0 && mag < u_minStepMerc) stepMerc *= (u_minStepMerc / mag);

  vec2 newLocal = local + stepMerc / u_seedSpan;
  // Left the padded seed bbox -> recycle (CPU reseeds this slot).
  if (any(lessThan(newLocal, vec2(0.0))) || any(greaterThan(newLocal, vec2(1.0)))) {
    fragColor = vec4(0.0);
    return;
  }

  // Encode viewport-local [0,1] -> 16-bit per axis (x -> R,G ; y -> B,A).
  vec2 q = floor(newLocal * 65535.0 + 0.5);
  float xr = floor(q.x / 256.0);
  float yr = floor(q.y / 256.0);
  fragColor = vec4(xr / 255.0, (q.x - xr * 256.0) / 255.0, yr / 255.0, (q.y - yr * 256.0) / 255.0);
}
`;
