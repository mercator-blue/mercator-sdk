#version 300 es
// Compositor: full-screen pass that scales the offscreen RGBA framebuffer
// by the layer's opacity before writing to the canvas. Necessary because
// rendering tiles directly with `u_opacity < 1` and per-tile alpha blending
// stacks alpha where parent + child tiles overlap (e.g. while a finer tile
// loads in and its parent is still in the queue for sibling targets),
// producing a visibly brighter overlap region until the parent is dropped.
precision highp float;
uniform sampler2D u_src;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  // Source is premultiplied. Scaling both RGB and A by u_opacity keeps
  // the alpha-premultiplied invariant.
  fragColor = texture(u_src, v_uv) * u_opacity;
}
