// OpenLayers-binding shader barrel — extracted from inline template
// strings. tsup's text-loader inlines the file contents at build time,
// same as the Mapbox + core shader barrels.

import POINTS_VS from './streamlines-points.vert';
import POINTS_FS from './streamlines-points.frag';
import QUAD_VS from './quad.vert';
import FADE_FS from './streamlines-fade.frag';
// Contour line shaders are shared with Leaflet via core (byte-identical).
import {
  CONTOUR_LINES_VS,
  CONTOUR_LINES_FS,
} from '../../core/shaders/index';

export {
  POINTS_VS,
  POINTS_FS,
  QUAD_VS,
  FADE_FS,
  CONTOUR_LINES_VS,
  CONTOUR_LINES_FS,
};
