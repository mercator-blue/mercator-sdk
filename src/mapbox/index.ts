/**
 * `@mercator-blue/sdk/mapbox`: the Mapbox GL JS and MapLibre binding.
 *
 * Exports {@link MercatorLayer}, a custom-WebGL layer that decodes
 * value-encoded tiles on the GPU, plus the per-visualization option types.
 * One binding serves both hosts (it detects the host at runtime).
 * Visualizations: raster, streamlines, arrows, contours, value labels and
 * tile boundaries, with 3D globe support on MapLibre 5 and Mapbox v3.
 *
 * @module
 */
// Public API surface for `@mercator-blue/sdk/mapbox` — custom-WebGL
// layers and overlays for Mapbox GL JS and MapLibre.
//
// One binding handles both hosts. They share an ancestor (MapLibre
// forked from Mapbox GL JS v1) and the custom-layer contract is
// essentially identical; `./host-adapter` normalises the small
// differences in render-call args and the globe projection prelude at
// runtime, per frame. Customers don't need to declare which host they
// use — pass either kind of map and the binding adapts.
//
// Supported versions: MapLibre 4+ (5+ for globe), Mapbox GL JS 2+
// (3+ for globe). v2 Mapbox supports only the flat-Mercator code
// path; the v3 globe vertex prelude is synthesised in
// `./host-adapter`.
//
// Host-agnostic primitives (types, STAC walker, colormap presets)
// are re-exported here too, so a Mapbox/MapLibre consumer can pull
// everything they need from this one subpath.

export type {
  VisualizationKind,
  EncodingKind,
  ColormapSpec,
  MercatorLayerOptions,
  MercatorRasterOptions,
  MercatorStreamlinesOptions,
  MercatorArrowsOptions,
  MercatorContoursOptions,
  MercatorValueLabelsOptions,
  MercatorTileBoundariesOptions,
  CustomLayerInterface,
} from '../core/types';

export type { DiscoveredItem } from '../core/discover';
export { discoverLatestItem } from '../core/discover';

export { PALETTES, resolveColormap } from '../core/colormaps';

export { MercatorLayer } from './mercator-layer.js';
export type {
  MapboxMercatorLayerOptions,
  MapboxHostExtras,
} from './mercator-layer.js';
