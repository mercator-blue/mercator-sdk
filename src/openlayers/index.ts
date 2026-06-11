/**
 * `@mercator-blue/sdk/openlayers`: the OpenLayers 8+ binding.
 *
 * Exports ol/layer subclasses for value-encoded tiles: raster, streamlines,
 * arrows, contours, value labels and tile boundaries. The raster layer uses
 * OpenLayers' built-in WebGLTile style expressions (no hand-written GLSL).
 * Mercator only.
 *
 * @module
 */
// Public entry for `@mercator-blue/sdk/openlayers`.
//
// OpenLayers 8+ binding. The raster layer is an `ol/layer/WebGLTile`
// subclass that decodes value-encoded tiles via OL's declarative
// style-expression language (no hand-written GLSL). The overlays
// (arrows / value-labels / tile-boundaries / contours) are
// `ol/layer/Layer` instances with a custom `render(frameState)` that
// draws to a Canvas2D element OL positions for us.
//
// OpenLayers is ESM-only with no UMD global, so unlike the Leaflet
// binding (which reads `globalThis.L`) this binding imports `ol/*`
// modules directly — they stay external in the build and resolve via
// the consumer's bundler (or an import map for the standalone test page).
//
// Customers construct layers exclusively through `MercatorLayer.create`
// or `MercatorLayer.fromItem`. The concrete ol.Layer subclasses behind
// each `viz` are internal implementation details.

export { MercatorLayer } from './mercator-layer';
export type {
  OpenLayersMercatorLayerOptions,
  OpenLayersHostExtras,
} from './mercator-layer';

// Cross-binding types
export type {
  MercatorLayerOptions,
  MercatorRasterOptions,
  MercatorStreamlinesOptions,
  MercatorArrowsOptions,
  MercatorContoursOptions,
  MercatorValueLabelsOptions,
  MercatorTileBoundariesOptions,
  VisualizationKind,
  EncodingKind,
  ColormapSpec,
} from '../core/types';

// Re-export the STAC discovery primitive so consumers can discover once
// and build several layers with `fromItem` (avoiding duplicate catalog
// walks, and exposing STAC-derived defaults).
export { discoverLatestItem } from '../core/discover';
export type { DiscoveredItem } from '../core/discover';
