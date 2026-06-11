// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Contour-line vertex shader — expanded triangle geometry.
//
// Mirrors tile-bounds.vert: each logical line segment is a thin
// screen-space quad whose two endpoints share BOTH endpoint positions
// in the vertex stream so the shader can compute the screen-space
// tangent + perpendicular and offset by half-width × side.
//
// Per-vertex a_bold (0 or 1) selects between "thin" and "bold" width
// — used to make round-number isolines (multiples of 10) heavier than
// their finer-interval neighbours. The width itself is two host-side
// uniforms (base + bold-extra) so the casing pass + main pass can each
// pick their own widths without rebuilding the buffer.
//
// One shader serves both the casing pass and the main-line pass —
// they differ only in uniforms (widths + color + opacity).

in vec2 a_p0;
in vec2 a_p1;
in float a_t;
in float a_side;
in float a_bold;

uniform vec2 u_viewport;    // device pixels: (drawingBufferWidth, drawingBufferHeight)
uniform float u_width_base; // device pixels — width for thin lines
uniform float u_width_extra;// device pixels — added on top of base for bold lines

vec4 projectPos(vec2 pos) {
#ifdef GLOBE
  vec3 spherePos = projectToSphere(pos);
  vec4 p = u_projection_matrix * vec4(spherePos, 1.0);
  float front = dot(spherePos, u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w;
  p.z = (1.0 - front) * p.w;
  return p;
#else
  return projectTile(pos);
#endif
}

void main() {
  vec4 posStart = projectPos(a_p0);
  vec4 posEnd   = projectPos(a_p1);

  vec2 pixStart = (posStart.xy / posStart.w) * 0.5 * u_viewport;
  vec2 pixEnd   = (posEnd.xy   / posEnd.w  ) * 0.5 * u_viewport;

  vec2 tangent = pixEnd - pixStart;
  float tLen = max(length(tangent), 1e-4);
  vec2 normal = vec2(-tangent.y, tangent.x) / tLen;

  vec4 basePos = mix(posStart, posEnd, a_t);

  float lineWidth = u_width_base + a_bold * u_width_extra;
  vec2 offsetPx = normal * a_side * (lineWidth * 0.5);
  vec2 offsetClip = offsetPx / (0.5 * u_viewport) * basePos.w;

  gl_Position = vec4(basePos.xy + offsetClip, basePos.z, basePos.w);
}
`;
