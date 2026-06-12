/**
 * Host-agnostic core of `@mercator-blue/sdk`: render mercator's value-encoded
 * earth-data tiles (weather, ocean, air quality, elevation) on a web map.
 *
 * This entry exports the framework-independent pieces: STAC catalog discovery,
 * colormaps, the value-encoded tile pixel reader, and shared types. For the
 * actual map layers, import a host binding instead: `@mercator-blue/sdk/mapbox`,
 * `/leaflet`, `/openlayers`, `/deck-gl` or `/react`.
 *
 * @example
 * ```ts
 * import maplibregl from 'maplibre-gl';
 * import { MercatorLayer } from '@mercator-blue/sdk/mapbox';
 *
 * const map = new maplibregl.Map({ container: 'map', style: '...' });
 * map.on('load', async () => {
 *   const layer = await MercatorLayer.create({
 *     dataset: 'wind10m', apiKey: 'mk_...', viz: 'streamlines',
 *   });
 *   layer.addTo(map);
 * });
 * ```
 *
 * @module
 */

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

import { PALETTES as _PALETTES, resolveColormap as _resolveColormap } from './core/color/colormaps';
/** The built-in colormap palettes (viridis, turbo, magma, ...), keyed by name. */
export const PALETTES = _PALETTES;
/** Resolve a colormap spec to a 256-entry RGB lookup table. */
export const resolveColormap = _resolveColormap;
