// GLSL source as a string (bundler-independent; no text loader needed).
export default `#version 300 es
// Mitre-joined polyline vertex shader for contour rendering.
//
// The hairpin case (polyline doubles back) is critical to guard:
// when t_in_n and t_out_n are nearly opposite, their sum approaches
// zero and normalize(sum) returns NaN. NaN propagates into gl_Position
// via the mitre offset and renders as a wild triangular spike at that
// vertex. Detect via sum length and degrade to "use t_in_n tangent, no
// mitre" in that case.
in vec2 a_pos;
in vec2 a_prev;
in vec2 a_next;
in float a_side;
in float a_bold;
uniform mat3 u_world_to_pixel;  // mercator-world → CSS pixels
uniform vec2 u_viewport;        // device pixels
uniform float u_dpr;
uniform float u_world_offset_x; // mercator-world units; one full world = 1.0
uniform float u_width_base;     // CSS pixels — width for thin lines
uniform float u_width_extra;    // CSS pixels — added on top for bold lines

const float MITRE_LIMIT = 4.0;

vec2 worldToPx(vec2 worldPos) {
  return (u_world_to_pixel * vec3(worldPos, 1.0)).xy * u_dpr;
}

void main() {
  vec2 worldPos  = a_pos  + vec2(u_world_offset_x, 0.0);
  vec2 worldPrev = a_prev + vec2(u_world_offset_x, 0.0);
  vec2 worldNext = a_next + vec2(u_world_offset_x, 0.0);

  vec2 pos_px  = worldToPx(worldPos);
  vec2 prev_px = worldToPx(worldPrev);
  vec2 next_px = worldToPx(worldNext);

  vec2 t_in  = pos_px - prev_px;   // direction into the vertex
  vec2 t_out = next_px - pos_px;   // direction out of the vertex
  bool hasIn  = dot(t_in, t_in)   > 1e-8;
  bool hasOut = dot(t_out, t_out) > 1e-8;
  vec2 t_in_n  = hasIn  ? normalize(t_in)  : vec2(0.0);
  vec2 t_out_n = hasOut ? normalize(t_out) : vec2(0.0);

  vec2 mid_tan;
  float mitre;
  if (hasIn && hasOut) {
    // Interior vertex: average the two unit tangents.
    vec2 sum_tan = t_in_n + t_out_n;
    float sum_len = length(sum_tan);
    if (sum_len > 1e-3) {
      mid_tan = sum_tan / sum_len;
      vec2 perp_out = vec2(-t_out_n.y, t_out_n.x);
      vec2 mid_normal = vec2(-mid_tan.y, mid_tan.x);
      float denom = abs(dot(mid_normal, perp_out));
      mitre = min(1.0 / max(denom, 1e-3), MITRE_LIMIT);
    } else {
      mid_tan = t_in_n;
      mitre = 1.0;
    }
  } else if (hasIn) {
    mid_tan = t_in_n;
    mitre = 1.0;
  } else if (hasOut) {
    mid_tan = t_out_n;
    mitre = 1.0;
  } else {
    // Degenerate (zero-length polyline) — collapse the vertex.
    mid_tan = vec2(1.0, 0.0);
    mitre = 0.0;
  }
  vec2 mid_normal = vec2(-mid_tan.y, mid_tan.x);

  float lineWidth = (u_width_base + a_bold * u_width_extra) * u_dpr;
  vec2 offset_px = mid_normal * a_side * (lineWidth * 0.5) * mitre;

  vec2 final_px = pos_px + offset_px;
  vec2 clip = vec2(
    final_px.x / u_viewport.x * 2.0 - 1.0,
    1.0 - final_px.y / u_viewport.y * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;
