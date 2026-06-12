// Shared shader barrel — projection-agnostic shaders used by multiple
// host bindings. tsup's text-loader (see ../../../tsup.config.ts)
// inlines the file contents at build time, so consumers get plain
// string constants with no extra bundler config required.
//
// Lives in core/ (rather than under a specific binding) because the
// fragment-shader logic here is purely about decoding tile bytes +
// applying a colormap — no projection or host-frame uniforms. The
// binding-specific shaders (vertex shaders that need projection
// preludes, plus pipeline shaders coupled to per-binding attribute
// layouts) stay under their respective `{binding}/shaders/` directory.

import RASTER_SCALAR_FS from './raster-scalar.frag';
import RASTER_VECTOR_FS from './raster-vector.frag';
import RASTER_ELEVATION_FS from './raster-elevation.frag';
import QUAD_VS from './quad.vert';
import STREAMLINES_FADE_FS from './streamlines-fade.frag';
import STREAMLINES_COMPOSITE_FS from './streamlines-composite.frag';
import STREAMLINES_SIM_VS from './streamlines-sim.vert';
import STREAMLINES_SIM_FS from './streamlines-sim.frag';
import CONTOUR_LINES_VS from './contour-lines.vert';
import CONTOUR_LINES_FS from './contour-lines.frag';

export {
  RASTER_SCALAR_FS,
  RASTER_VECTOR_FS,
  RASTER_ELEVATION_FS,
  // Full-screen quad vertex shader. ES 1.00 (no `#version` line) — pairs
  // with the ES 1.00 fade/composite frags below. WebGL2 compiles it
  // fine; OpenLayers uses an ES 3.00 version for its own pipeline.
  QUAD_VS,
  // ES 1.00. Used by Mapbox + Leaflet streamlines pipelines as the trail
  // FBO fade pass. OL has its own ES 3.00 version with different uniform
  // names — separate work to harmonize.
  STREAMLINES_FADE_FS,
  STREAMLINES_COMPOSITE_FS,
  // ES 3.00. GPU particle-simulation pass (fullscreen-quad VS + advection
  // FS over the ping-pong position texture). Projection-agnostic — every
  // binding's GPU sim shares these; only the points VS that reads the
  // resulting positions is per-binding (projection differs).
  STREAMLINES_SIM_VS,
  STREAMLINES_SIM_FS,
  // ES 3.00. Used by Leaflet + OpenLayers contour line renderers (Mapbox
  // has a different attribute layout — a_p0/a_p1/a_t/a_side/a_bold
  // instead of a_pos/a_prev/a_next — and keeps its own shader).
  CONTOUR_LINES_VS,
  CONTOUR_LINES_FS,
};
