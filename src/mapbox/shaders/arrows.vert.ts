// GLSL source as a string (bundler-independent; no text loader needed).
export default `// Arrow line vertex shader — expanded triangle geometry.
//
// Each logical line segment (shaft, wingL, wingR) is drawn as a thin
// quad (2 triangles, 6 verts). Per vertex:
//   a_p0    : mercator-world position of segment START
//   a_p1    : mercator-world position of segment END
//   a_t     : 0 if this vertex sits at p0, 1 if at p1
//   a_side  : -1 / +1 — which side of the segment centreline
//   a_speed : carried through to the fragment shader for colouring
//
// Same expanded-line shader pattern as tile-bounds.vert — project both
// endpoints, derive the screen-space perpendicular, offset basePos by
// \`normal × side × half-width\`. The result is constant-pixel-width
// lines regardless of view zoom / pitch / globe curvature.

in vec2 a_p0;
in vec2 a_p1;
in float a_t;
in float a_side;
in float a_speed;

uniform vec2 u_viewport;    // device pixels: (drawingBufferWidth, drawingBufferHeight)
uniform float u_line_width; // device pixels

out float v_speed;

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
  vec2 offsetPx = normal * a_side * (u_line_width * 0.5);
  vec2 offsetClip = offsetPx / (0.5 * u_viewport) * basePos.w;

  gl_Position = vec4(basePos.xy + offsetClip, basePos.z, basePos.w);
  v_speed = a_speed;
}
`;
