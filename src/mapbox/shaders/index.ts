// Shader barrel — re-exports each .vert / .frag file as a string constant.
//
// tsup's esbuild config (see ../../../tsup.config.ts) registers a `text`
// loader for the .vert / .frag extensions, so these imports resolve to the
// raw file contents at build time and end up inlined as string literals in
// the bundled output. Consumers get plain strings; they don't need their
// own bundler config to handle the file types.

import RASTER_VS from './raster.vert';
// Projection-agnostic shaders live in core; re-exported here so the
// rest of the Mapbox binding doesn't need to know about the split.
import {
  RASTER_SCALAR_FS as SCALAR_FS,
  RASTER_VECTOR_FS as VECTOR_FS,
  RASTER_ELEVATION_FS as ELEVATION_FS,
  QUAD_VS,
  STREAMLINES_FADE_FS as FADE_FS,
  STREAMLINES_COMPOSITE_FS as COMPOSITE_FS,
} from '../../core/shaders/index';
import POINTS_VS from './streamlines-points.vert';
import POINTS_FS from './streamlines-points.frag';
import SIM_VS from './streamlines-sim.vert';
import SIM_FS from './streamlines-sim.frag';
import ARROWS_VS from './arrows.vert';
import ARROWS_FS from './arrows.frag';
import TILE_BOUNDS_VS from './tile-bounds.vert';
import TILE_BOUNDS_FS from './tile-bounds.frag';
import CONTOUR_LINES_VS from './contour-lines.vert';
import CONTOUR_LINES_FS from './contour-lines.frag';

export {
  RASTER_VS,
  SCALAR_FS,
  VECTOR_FS,
  ELEVATION_FS,
  QUAD_VS,
  POINTS_VS,
  POINTS_FS,
  SIM_VS,
  SIM_FS,
  FADE_FS,
  COMPOSITE_FS,
  ARROWS_VS,
  ARROWS_FS,
  TILE_BOUNDS_VS,
  TILE_BOUNDS_FS,
  CONTOUR_LINES_VS,
  CONTOUR_LINES_FS,
};
