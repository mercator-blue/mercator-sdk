// Public entry for `@mercator-blue/sdk/deck-gl`.
//
// deck.gl 9+ binding. Each layer (raster / streamlines / arrows / values /
// tile-bounds) is a deck.gl Layer subclass that decodes value-encoded
// tiles client-side. The customer passes the layer into deck.gl's
// `layers: [...]` array — typically via `MapboxOverlay({ layers: [...] })`
// on a Mapbox/MapLibre host map.
//
// Customers construct layers exclusively through `MercatorLayer.create`
// or `MercatorLayer.fromItem`. The concrete deck.gl Layer subclasses
// behind each `viz` are internal implementation details.

export { MercatorLayer } from './mercator-layer.js';

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
// and build several layers with `fromItem`.
export type { DiscoveredItem } from '../core/discover';
export { discoverLatestItem } from '../core/discover';

export { PALETTES, resolveColormap } from '../core/colormaps';
