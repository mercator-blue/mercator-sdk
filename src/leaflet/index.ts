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

// Cross-binding types — re-exported so consumers can pull them from this
// single subpath instead of two.
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

// Re-export the STAC discovery primitive so test pages / consumers can
// discover once and build several layers with `fromItem`, avoiding
// duplicate catalog walks (and giving access to STAC-derived defaults
// like `mercator:visualization.particle_speed_scale`).
export { discoverLatestItem } from '../core/discover';
export type { DiscoveredItem } from '../core/discover';
