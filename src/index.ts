// Public API surface for `@mercator-blue/sdk` — the host-agnostic core.
//
// Host bindings live at subpaths:
//   - `@mercator-blue/sdk/mapbox`  — Mapbox GL JS + MapLibre
//   - (future) `@mercator-blue/sdk/deck-gl`, `/leaflet`, `/cesium`, ...
//
// This entry exposes only what's portable across hosts: the value-
// encoded-PNG types, the STAC catalog walker, and the colormap presets.
// Anyone writing a decoder for a new platform — or just reading metadata
// without rendering — imports from here. Tree-shakers won't pull in
// any map-library code as long as you only use these exports.

export type {
  VisualizationKind,
  ColormapSpec,
} from './core/types';

// STAC catalog walker — fetches catalog → collection → latest item.json.
// Pure HTTP; no map/host dependency. The returned `DiscoveredItem` is
// the normalised shape that host bindings (and your own decoders)
// consume.
export type { DiscoveredItem } from './core/discover';
export { discoverLatestItem } from './core/discover';

export { PALETTES, resolveColormap } from './core/colormaps';
