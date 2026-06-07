// MercatorLayer — the SDK's single public entry point for OpenLayers.
//
// One factory dispatching by `viz` to the appropriate concrete
// ol.layer.Layer subclass. Returns the layer ready to `map.addLayer(layer)`
// (OL idiom — no `.addTo(map)`).
//
//   const layer = await MercatorLayer.create({
//     dataset: 'wind10m',
//     apiKey: 'mk_...',
//     viz: 'streamlines',
//   });
//   map.addLayer(layer);

import Layer from 'ol/layer/Layer.js';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import type { MercatorLayerOptions } from '../core/types';
import { MercatorRasterLayer } from './raster-layer';
import { MercatorStreamlinesLayer } from './streamlines-layer';
import { MercatorArrowsLayer } from './arrows-layer';
import { MercatorContoursLayer } from './contours-layer';
import { MercatorValueLabelsLayer } from './value-labels-layer';
import { MercatorTileBoundariesLayer } from './tile-boundaries-layer';

import { DEFAULT_CATALOG_URL } from '../core/urls';

/** OpenLayers-specific extras layered on top of {@link MercatorLayerOptions}. */
export interface OpenLayersHostExtras {
  /** OL layer z-index. */
  zIndex?: number;
}

export type OpenLayersMercatorLayerOptions = MercatorLayerOptions & OpenLayersHostExtras;

async function create(opts: OpenLayersMercatorLayerOptions): Promise<Layer> {
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
  opts: OpenLayersMercatorLayerOptions,
  item: DiscoveredItem | null,
): Layer {
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

function requireViz(opts: OpenLayersMercatorLayerOptions): void {
  if (!opts || !opts.viz) {
    throw new Error(
      '@mercator-blue/sdk/openlayers: `viz` is required (one of "raster", ' +
      '"streamlines", "arrows", "contours", "values", "bounds").',
    );
  }
}

function requireDatasetAndKey(opts: OpenLayersMercatorLayerOptions): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = opts as any;
  if (!o.dataset) {
    throw new Error('@mercator-blue/sdk/openlayers: `dataset` is required.');
  }
  if (!o.apiKey) {
    throw new Error(
      '@mercator-blue/sdk/openlayers: `apiKey` is required. Get one at https://mercator.blue/dashboard.',
    );
  }
}

/**
 * Apply a partial options patch to a layer constructed via
 * `MercatorLayer.create`/`.fromItem`. The fields that can be changed at
 * runtime depend on the layer's `viz` — fields not relevant are silently
 * ignored. Construction-time fields throw.
 *
 * Provided as a free function (not a method on the returned ol.Layer
 * subclass) because the six viz classes don't share an OL-side base.
 */
function setOptions(
  layer: Layer,
  partial: Partial<MercatorLayerOptions>,
): void {
  if (!partial) return;
  const reject = ['viz', 'dataset', 'apiKey', 'id', 'catalogUrl'] as const;
  for (const k of reject) {
    if (k in partial) {
      throw new Error(
        `@mercator-blue/sdk/openlayers: MercatorLayer.setOptions — '${k}' is construction-time only. ` +
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

export const MercatorLayer = { create, fromItem, setOptions };
