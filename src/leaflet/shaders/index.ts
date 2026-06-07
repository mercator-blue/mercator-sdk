// Leaflet-binding shader barrel — extracted from inline template strings.
// tsup's text-loader inlines the file contents at build time, same as the
// Mapbox + core shader barrels.

import RASTER_VS from './raster.vert';
import RASTER_COMPOSITE_VS from './raster-composite.vert';
import RASTER_COMPOSITE_FS from './raster-composite.frag';
import POINTS_VS from './streamlines-points.vert';
import POINTS_FS from './streamlines-points.frag';
// Projection-agnostic shaders shared with Mapbox live in core.
import {
  QUAD_VS,
  STREAMLINES_FADE_FS as FADE_FS,
  STREAMLINES_COMPOSITE_FS,
  CONTOUR_LINES_VS,
  CONTOUR_LINES_FS,
} from '../../core/shaders/index';

export {
  RASTER_VS,
  RASTER_COMPOSITE_VS,
  RASTER_COMPOSITE_FS,
  POINTS_VS,
  POINTS_FS,
  QUAD_VS,
  FADE_FS,
  STREAMLINES_COMPOSITE_FS,
  CONTOUR_LINES_VS,
  CONTOUR_LINES_FS,
};
