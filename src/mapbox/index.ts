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
  CustomLayerInterface as _CustomLayerInterface,
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
/** The host custom-layer contract that {@link MercatorLayer} implements. */
export type CustomLayerInterface = _CustomLayerInterface;
/** Normalised STAC item returned by {@link discoverLatestItem}. */
export type DiscoveredItem = _DiscoveredItem;

/** Walk the STAC catalog and return the newest item for a dataset, so you can
 *  discover once and build several layers with `MercatorLayer.fromItem`. */
export const discoverLatestItem = _discoverLatestItem;
/** The built-in colormap palettes (viridis, turbo, magma, ...), keyed by name. */
export const PALETTES = _PALETTES;
/** Resolve a colormap spec to a 256-entry RGB lookup table. */
export const resolveColormap = _resolveColormap;

export { MercatorLayer } from './mercator-layer.js';
export type {
  MapboxMercatorLayerOptions,
  MapboxHostExtras,
} from './mercator-layer.js';
