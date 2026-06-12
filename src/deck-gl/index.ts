/**
 * `@mercator-blue/sdk/deck-gl`: the deck.gl 9+ binding.
 *
 * Exports deck.gl Layer subclasses for value-encoded tiles
 * (MercatorRasterLayer, MercatorStreamlinesLayer, MercatorArrowsLayer,
 * MercatorValueLabelsLayer, MercatorTileBoundariesLayer), typically used via
 * `@deck.gl/mapbox`'s MapboxOverlay. Flat Mercator only.
 *
 * @module
 */
// Each layer is a deck.gl Layer subclass; pass it into deck.gl's `layers`
// array, typically via `MapboxOverlay({ layers: [...] })`. Construct via
// `MercatorLayer.create` / `.fromItem`; subclasses are internal.

export { MercatorLayer } from './mercator-layer.js';

// Cross-binding types, the STAC discovery primitive, and the colormap
// helpers, re-exported as documented aliases so this subpath is
// self-contained (and so JSR's doc scorecard counts them — a bare
// `export ... from` becomes an undocumented reference). The canonical
// definitions live in core/types, core/discover, and core/colormaps.
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
import { PALETTES as _PALETTES, resolveColormap as _resolveColormap } from '../core/colormaps';

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
/** The built-in colormap palettes (viridis, turbo, magma, ...), keyed by name. */
export const PALETTES = _PALETTES;
/** Resolve a colormap spec to a 256-entry RGB lookup table. */
export const resolveColormap = _resolveColormap;
