// Arrow line fragment shader. Outputs a viridis-ramp colour based on
// the incoming speed (m/s), mapped from 0..u_speedRef across the five
// preset stops. u_speedRef matches the host's STAC
// `mercator:visualization.vmax` so wind (~40 m/s) and currents (~2 m/s)
// both use their full colour range — without this, currents bunched
// into the first ramp segment and rendered as a single dark colour.

precision highp float;

in float v_speed;
uniform float u_speedRef;
out vec4 fragColor;

const vec3 STOP_0 = vec3(0.267, 0.005, 0.329);  // #440154 at 0
const vec3 STOP_1 = vec3(0.231, 0.322, 0.546);  // #3b528b at u_speedRef * 0.25
const vec3 STOP_2 = vec3(0.129, 0.569, 0.549);  // #21918c at u_speedRef * 0.50
const vec3 STOP_3 = vec3(0.365, 0.784, 0.388);  // #5dc863 at u_speedRef * 0.75
const vec3 STOP_4 = vec3(0.992, 0.906, 0.145);  // #fde725 at u_speedRef

vec3 speedToColor(float speed) {
  float t = clamp(speed / max(u_speedRef, 1e-6), 0.0, 1.0) * 4.0;
  int idx = int(floor(t));
  float f = t - float(idx);
  if (idx == 0) return mix(STOP_0, STOP_1, f);
  if (idx == 1) return mix(STOP_1, STOP_2, f);
  if (idx == 2) return mix(STOP_2, STOP_3, f);
  return mix(STOP_3, STOP_4, f);
}

void main() {
  fragColor = vec4(speedToColor(v_speed), 0.9);
}
