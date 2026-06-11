// MercatorLayer — the SDK's single public entry point for Leaflet.
//
// One factory dispatching by `viz` to the appropriate concrete L.Layer
// subclass. Returns the layer ready to `.addTo(map)`.
//
//   const layer = await MercatorLayer.create({
//     dataset: 'wind10m',
//     apiKey: 'mk_...',
//     viz: 'streamlines',
//   });
//   layer.addTo(map);

import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import type { MercatorLayerOptions } from '../core/types';
import { MercatorRasterLayer } from './raster-layer';
import { MercatorStreamlinesLayer } from './streamlines-layer';
import { MercatorArrowsLayer } from './arrows-layer';
import { MercatorContoursLayer } from './contours-layer';
import { MercatorValueLabelsLayer } from './value-labels-layer';
import { MercatorTileBoundariesLayer } from './tile-boundaries-layer';

import { DEFAULT_CATALOG_URL } from '../core/urls';

/** Leaflet-specific extras layered on top of {@link MercatorLayerOptions}. */
export interface LeafletHostExtras {
  /** Leaflet pane name. Default `'overlayPane'`. */
  pane?: string;
}

/** Options for the Leaflet binding: the portable {@link MercatorLayerOptions}
 *  union plus Leaflet host extras (`pane`). */
export type LeafletMercatorLayerOptions = MercatorLayerOptions & LeafletHostExtras;

// Concrete L.Layer; not strongly typed because we read L off `globalThis`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LeafletLayer = any;

async function create(opts: LeafletMercatorLayerOptions): Promise<LeafletLayer> {
  requireViz(opts);
  if (opts.viz === 'bounds') {
    return fromItem(opts, null);
  }
  requireDatasetAndKey(opts);
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

function fromItem(
  opts: LeafletMercatorLayerOptions,
  item: DiscoveredItem | null,
): LeafletLayer {
  requireViz(opts);
  switch (opts.viz) {
    case 'raster':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return MercatorRasterLayer.fromItem(opts as any, item!);
    case 'streamlines':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return MercatorStreamlinesLayer.fromItem(opts as any, item!);
    case 'arrows':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return MercatorArrowsLayer.fromItem(opts as any, item!);
    case 'contours':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return MercatorContoursLayer.fromItem(opts as any, item!);
    case 'values':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return MercatorValueLabelsLayer.fromItem(opts as any, item!);
    case 'bounds':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return MercatorTileBoundariesLayer.create(opts as any);
  }
}

function requireViz(opts: LeafletMercatorLayerOptions): void {
  if (!opts || !opts.viz) {
    throw new Error(
      '@mercator-blue/sdk/leaflet: `viz` is required (one of "raster", ' +
      '"streamlines", "arrows", "contours", "values", "bounds").',
    );
  }
}

function requireDatasetAndKey(opts: LeafletMercatorLayerOptions): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = opts as any;
  if (!o.dataset) {
    throw new Error('@mercator-blue/sdk/leaflet: `dataset` is required.');
  }
  if (!o.apiKey) {
    throw new Error(
      '@mercator-blue/sdk/leaflet: `apiKey` is required. Get one at https://mercator.blue/dashboard.',
    );
  }
}

/**
 * Apply a partial options patch to a layer constructed via
 * `MercatorLayer.create`/`.fromItem`. The fields that can be changed at
 * runtime depend on the layer's `viz` — fields not relevant are silently
 * ignored. Construction-time fields throw.
 *
 * ```ts
 * MercatorLayer.setOptions(layer, { opacity: 0.5, colormap: 'magma' });
 * ```
 *
 * Provided as a free function (not a method on the returned L.Layer
 * subclass) because L.Layer has no shared `setOptions` interface across
 * our six viz classes.
 */
function setOptions(
  layer: LeafletLayer,
  partial: Partial<MercatorLayerOptions>,
): void {
  if (!partial) return;
  const reject = ['viz', 'dataset', 'apiKey', 'id', 'catalogUrl'] as const;
  for (const k of reject) {
    if (k in partial) {
      throw new Error(
        `@mercator-blue/sdk/leaflet: MercatorLayer.setOptions — '${k}' is construction-time only. ` +
        'Replace the layer to change it.',
      );
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const l = layer as any;
  if (typeof l.applyOptions === 'function') {
    l.applyOptions(partial);
  }
}

/**
 * The Leaflet binding entry point. A namespace of factory functions for
 * building mercator.blue data layers as Leaflet `L.Layer` subclasses
 * (Mercator-only; no globe).
 *
 * - `create(opts)` — discover the dataset's latest STAC item, then build the
 *   layer. Returns a promise.
 * - `fromItem(opts, item)` — build synchronously from an already-discovered
 *   item (or `null` for `viz: 'bounds'`).
 * - `setOptions(layer, partial)` — apply a live tweak (opacity, colormap, ...)
 *   without rebuilding the layer.
 *
 * @example
 * ```ts
 * const layer = await MercatorLayer.create({
 *   dataset: 'currents', apiKey: 'mk_...', viz: 'streamlines',
 * });
 * layer.addTo(map);
 * ```
 */
export const MercatorLayer = { create, fromItem, setOptions };
