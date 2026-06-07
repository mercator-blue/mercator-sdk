// MercatorLayer — the SDK's single public entry point for deck.gl.
//
// One factory dispatching by `viz` to the appropriate concrete deck.gl
// Layer subclass. Returns the layer ready to drop into the host's
// `layers: [...]` array (e.g. `MapboxOverlay({ layers: [layer] })`).
//
//   const layer = await MercatorLayer.create({
//     dataset: 'wind10m',
//     apiKey: 'mk_...',
//     viz: 'streamlines',
//   });
//   overlay.setProps({ layers: [layer] });

import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import type { MercatorLayerOptions } from '../core/types';
import { MercatorRasterLayer } from './raster-layer';
import { MercatorStreamlinesLayer } from './streamlines-layer';
import { MercatorArrowsLayer } from './arrows-layer';
import { MercatorValueLabelsLayer } from './value-labels-layer';
import { MercatorTileBoundariesLayer } from './tile-boundaries-layer';

import { DEFAULT_CATALOG_URL } from '../core/urls';

// deck.gl Layer is the broad host type; the concrete-class returns are
// each a tighter subclass. We type the dispatcher's return as the
// union of every concrete class so callers get useful narrowing.
type Dispatched =
  | MercatorRasterLayer
  | MercatorStreamlinesLayer
  | MercatorArrowsLayer
  | MercatorValueLabelsLayer
  | MercatorTileBoundariesLayer;

async function create(opts: MercatorLayerOptions): Promise<Dispatched> {
  requireViz(opts);
  if (opts.viz === 'bounds') {
    return fromItem(opts, null);
  }
  // No contours binding on deck.gl yet — fail clearly rather than NPE later.
  if (opts.viz === 'contours') {
    throw new Error(
      '@mercator-blue/sdk/deck-gl: viz "contours" is not implemented on ' +
      'the deck.gl binding. Use the Mapbox, MapLibre, Leaflet, or ' +
      'OpenLayers binding for contour layers.',
    );
  }
  requireDatasetAndKey(opts);
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

function fromItem(opts: MercatorLayerOptions, item: DiscoveredItem | null): Dispatched {
  requireViz(opts);
  // The concrete deck.gl classes accept a superset of their viz's
  // options; unknown fields (like `viz` itself) are ignored by deck.gl's
  // props validation.
  //
  // Default id includes both dataset and viz so customers composing
  // multiple viz on the same dataset (raster + streamlines, the
  // canonical wind view) get stable ids that deck.gl reconciles
  // across re-renders. Without a stable id deck.gl's Layer base
  // class assigns a fresh counter-based id every construction, which
  // forces a rebuild of every layer on each setProps. `bounds`
  // doesn't carry a dataset; fall back to the viz alone there.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = opts as any;
  const datasetPart = o.dataset ? `${o.dataset}-` : '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = {
    ...opts,
    id: o.id ?? `mercator-${datasetPart}${opts.viz}`,
  } as any;
  switch (opts.viz) {
    case 'raster':
      return new MercatorRasterLayer(props);
    case 'streamlines':
      return new MercatorStreamlinesLayer(props);
    case 'arrows':
      return new MercatorArrowsLayer(props);
    case 'values':
      return new MercatorValueLabelsLayer(props);
    case 'bounds':
      return new MercatorTileBoundariesLayer(props);
    case 'contours':
      throw new Error(
        '@mercator-blue/sdk/deck-gl: viz "contours" is not implemented.',
      );
  }
  // Silence the `void item` warning — discovery is cached at module level
  // so the inner class picks the item up from there.
  void item;
}

function requireViz(opts: MercatorLayerOptions): void {
  if (!opts || !opts.viz) {
    throw new Error(
      '@mercator-blue/sdk/deck-gl: `viz` is required (one of "raster", ' +
      '"streamlines", "arrows", "values", "bounds"; "contours" pending).',
    );
  }
}

function requireDatasetAndKey(opts: MercatorLayerOptions): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = opts as any;
  if (!o.dataset) {
    throw new Error('@mercator-blue/sdk/deck-gl: `dataset` is required.');
  }
  if (!o.apiKey) {
    throw new Error(
      '@mercator-blue/sdk/deck-gl: `apiKey` is required. Get one at https://mercator.blue/dashboard.',
    );
  }
}

/**
 * Not supported on the deck.gl binding. deck.gl reconciles layers via
 * prop changes on the `layers: [...]` array — to change options at
 * runtime, construct a new layer via `MercatorLayer.fromItem(opts, item)`
 * with the same `id` and include it in the array. deck.gl diffs the new
 * props against the previous layer and applies them without recreating
 * GPU resources.
 */
function setOptions(): never {
  throw new Error(
    '@mercator-blue/sdk/deck-gl: setOptions is not supported. deck.gl ' +
    'reconciles layers via the layers array — construct a new layer with ' +
    'MercatorLayer.fromItem (same `id`) and replace it in your array; ' +
    'deck.gl diffs the props for you.',
  );
}

export const MercatorLayer = { create, fromItem, setOptions };
