/**
 * `@mercator-blue/sdk/leaflet`: the Leaflet 1.x binding.
 *
 * Exports L.Layer subclasses for value-encoded tiles: raster, streamlines,
 * arrows, contours, value labels and tile boundaries (WebGL2 for raster and
 * streamlines, Canvas2D for the rest). Mercator only, no globe.
 *
 * @module
 */
// Public entry for `@mercator-blue/sdk/leaflet`.
//
// Leaflet 1.x binding. Each layer (raster / streamlines / arrows / values /
// contours / tile-bounds) is an L.Layer subclass attached to a Leaflet
// pane. Pans piggyback on Leaflet's own CSS transform (perfect sync with
// the basemap), zooms scale-transform during the 250 ms anim and
// re-render at the new zoom on `zoomend`.
//
// Customers construct layers exclusively through `MercatorLayer.create`
// (async; walks the STAC catalog) or `MercatorLayer.fromItem` (sync; when
// the discovered item is already in hand). The concrete L.Layer subclasses
// behind each `viz` are internal implementation details.

export { MercatorLayer } from './mercator-layer';
export type {
  LeafletMercatorLayerOptions,
  LeafletHostExtras,
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
