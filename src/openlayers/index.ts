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
// OpenLayers is ESM-only with no UMD global, so (unlike the Leaflet binding,
// which reads `globalThis.L`) this binding imports `ol/*` modules directly;
// they stay external in the build and resolve via the consumer's bundler.
// Construct via `MercatorLayer.create` / `.fromItem`; subclasses are internal.

export { MercatorLayer } from './mercator-layer';
export type {
  OpenLayersMercatorLayerOptions,
  OpenLayersHostExtras,
} from './mercator-layer';

// Cross-binding types + the STAC discovery primitive, re-exported as
// documented aliases so this subpath is self-contained (and so JSR's doc
// scorecard counts them — a bare `export ... from` becomes an undocumented
// reference). The canonical definitions live in core/types + core/discover.
import type {
  VisualizationKind as _VisualizationKind,
  EncodingKind as _EncodingKind,
  ColormapSpec as _ColormapSpec,
  MercatorLayerOptions as _MercatorLayerOptions,
  MercatorRasterOptions as _MercatorRasterOptions,
  MercatorStreamlinesOptions as _MercatorStreamlinesOptions,
  MercatorArrowsOptions as _MercatorArrowsOptions,
  MercatorContoursOptions as _MercatorContoursOptions,
  MercatorValueLabelsOptions as _MercatorValueLabelsOptions,
  MercatorTileBoundariesOptions as _MercatorTileBoundariesOptions,
} from '../core/types';
import type { DiscoveredItem as _DiscoveredItem } from '../core/discover';
import { discoverLatestItem as _discoverLatestItem } from '../core/discover';

/** Visualization kinds the layer can render. See {@link MercatorLayerOptions}. */
export type VisualizationKind = _VisualizationKind;
/** Value-encoded tile encodings the SDK decodes (`rg16_fixed`, `vector_rg_ba`, `mapbox_rgb`). */
export type EncodingKind = _EncodingKind;
/** A colormap: a built-in palette name or an explicit `{stops}` gradient. */
export type ColormapSpec = _ColormapSpec;
/** Discriminated union of per-visualization layer options, keyed by `viz`. */
export type MercatorLayerOptions = _MercatorLayerOptions;
/** Options for `viz: 'raster'` (colormapped scalar / magnitude / elevation). */
export type MercatorRasterOptions = _MercatorRasterOptions;
/** Options for `viz: 'streamlines'` (animated particle field). */
export type MercatorStreamlinesOptions = _MercatorStreamlinesOptions;
/** Options for `viz: 'arrows'` (direction-arrow lattice). */
export type MercatorArrowsOptions = _MercatorArrowsOptions;
/** Options for `viz: 'contours'` (labelled isolines). */
export type MercatorContoursOptions = _MercatorContoursOptions;
/** Options for `viz: 'values'` (numeric value labels). */
export type MercatorValueLabelsOptions = _MercatorValueLabelsOptions;
/** Options for `viz: 'bounds'` (tile-boundary debug overlay). */
export type MercatorTileBoundariesOptions = _MercatorTileBoundariesOptions;
/** Normalised STAC item returned by {@link discoverLatestItem}. */
export type DiscoveredItem = _DiscoveredItem;

/** Walk the STAC catalog and return the newest item for a dataset, so you can
 *  discover once and build several layers with `MercatorLayer.fromItem`. */
export const discoverLatestItem = _discoverLatestItem;
