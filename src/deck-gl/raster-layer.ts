// Public deck.gl Layer for mercator.blue value-encoded raster tiles —
// applies a colormap to scalar (rg16_fixed) and vector-magnitude
// (vector_rg_ba, coloured by √(u²+v²)) datasets; hypsometric tinting
// to elevation (mapbox_rgb). Equivalent to the Mapbox binding's
// internal `createDecodedRasterLayer`.
//
// "Raster" here means "image-tile-based rendering" in the Mapbox/
// MapLibre style-spec sense, not "heatmap" (which has a specific
// density-aggregation meaning that this layer doesn't do).
//
// Synchronous constructor — pass `{ dataset, apiKey, catalogUrl }` and
// the layer walks the STAC catalog on first updateState() to discover
// the latest item. Sub-layer (TileLayer) is materialised once we have
// the discovered item; until then nothing renders. This matches deck.gl
// idiomatic data flow (Layer constructor is sync; data load is
// internal) better than a `.create()` factory.

import { CompositeLayer, type DefaultProps, type LayersList } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, DEFAULT_CATALOG_URL } from '../core/urls';
import { resolveColormap } from '../core/colormaps';
import type { ColormapSpec } from '../core/types';
import { ValueDecodedBitmapLayer } from './value-decoded-bitmap-layer.js';
import { ElevationBitmapLayer } from './elevation-bitmap-layer.js';
import { VectorMagnitudeBitmapLayer } from './vector-magnitude-bitmap-layer.js';


// Module-level cache for STAC discovery results. deck.gl constructs a
// fresh Layer instance every time any prop changes (palette swap, etc.),
// and instance fields don't transfer — so without a cache, every prop
// change would re-run the catalog walk and blank the layer for a few
// hundred ms while it completes. The cache holds either a resolved
// DiscoveredItem (sync lookup) or an in-flight Promise (other concurrent
// callers join the existing fetch).
const discoveryCache = new Map<string, DiscoveredItem | Promise<DiscoveredItem>>();
const cacheKey = (catalogUrl: string, dataset: string) =>
  `${catalogUrl}|${dataset}`;

export interface MercatorRasterLayerProps {
  /** Dataset name, e.g. 'temp2m'. */
  dataset: string;
  /** mercator.blue API key (`mk_<...>`). */
  apiKey: string;
  /** STAC catalog URL. Defaults to the production tile API. */
  catalogUrl?: string;
  /** Colormap preset name, custom stops, or 16-RGB array. */
  colormap?: ColormapSpec;
  /** Layer opacity in [0, 1]. */
  opacity?: number;
  /** Layer id. */
  id?: string;
}

const defaultProps: DefaultProps<MercatorRasterLayerProps> = {
  dataset: '',
  apiKey: '',
  catalogUrl: DEFAULT_CATALOG_URL,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  colormap: 'viridis' as any,
  opacity: { type: 'number', min: 0, max: 1, value: 0.75 },
};

export class MercatorRasterLayer extends CompositeLayer<MercatorRasterLayerProps> {
  static layerName = 'MercatorRasterLayer';
  static defaultProps = defaultProps;

  // Always read the discovered item from the module-level cache rather
  // than caching on `this`. deck.gl reconciles same-id layer instances
  // by transferring `state` from old to new, but instance-own fields
  // (like a private `_item`) are NOT transferred — they reset to their
  // field default. So on a prop change (palette swap), the new instance
  // had `_item = null` and renderLayers returned [] until the next
  // discover roundtrip. The cache + lookup-on-every-render closes that
  // gap because the cache survives across instance swaps.
  private _getCachedItem(): DiscoveredItem | null {
    const { dataset, catalogUrl } = this.props;
    if (!dataset) return null;
    const cached = discoveryCache.get(cacheKey(catalogUrl!, dataset));
    return cached && !(cached instanceof Promise) ? cached : null;
  }

  initializeState() {
    if (!this._getCachedItem()) void this._discover();
  }

  updateState({
    props,
    oldProps,
  }: {
    props: MercatorRasterLayerProps;
    oldProps: MercatorRasterLayerProps;
  }) {
    if (
      props.dataset !== oldProps.dataset ||
      props.catalogUrl !== oldProps.catalogUrl
    ) {
      if (!this._getCachedItem()) void this._discover();
    }
  }

  async _discover() {
    const { dataset, catalogUrl } = this.props;
    if (!dataset) return;
    const key = cacheKey(catalogUrl!, dataset);
    // Join an existing in-flight fetch if there is one — avoids
    // duplicate HTTP requests when multiple instances spawn before any
    // resolves.
    const pending = discoveryCache.get(key);
    let promise: Promise<DiscoveredItem>;
    if (pending instanceof Promise) {
      promise = pending;
    } else {
      promise = discoverLatestItem(catalogUrl!, dataset);
      discoveryCache.set(key, promise);
    }
    try {
      const item = await promise;
      if (
        item.encoding.kind !== 'rg16_fixed' &&
        item.encoding.kind !== 'mapbox_rgb' &&
        item.encoding.kind !== 'vector_rg_ba'
      ) {
        throw new Error(
          `@mercator-blue/sdk/deck-gl: MercatorRasterLayer supports rg16_fixed ` +
            '(scalar), mapbox_rgb (elevation), and vector_rg_ba (vector — coloured ' +
            `by magnitude); dataset "${dataset}" has "${item.encoding.kind}".`,
        );
      }
      discoveryCache.set(key, item); // promote Promise → resolved value
      this.setNeedsUpdate();
    } catch (err) {
      // Drop the failed promise so a later retry isn't blocked.
      if (discoveryCache.get(key) === promise) discoveryCache.delete(key);
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[MercatorRasterLayer]', msg);
    }
  }

  renderLayers(): LayersList {
    const item = this._getCachedItem();
    if (!item) return [];

    const { apiKey, colormap, opacity } = this.props;
    const kind = item.encoding.kind;
    const isElevation = kind === 'mapbox_rgb';
    const isVector = kind === 'vector_rg_ba';

    // Colormap matters for scalar and vector-magnitude; elevation
    // bakes its hypsometric ramp into the shader.
    const colormapStops = isElevation ? null : resolveColormap(colormap);

    const urlTemplate = withApiKey(
      `${item.itemBase}/{z}/{x}/{y}.png`,
      apiKey,
    );

    const enc = item.encoding;
    // STAC `mercator:visualization.vmin/vmax` is the dataset author's
    // chosen palette range. Neutral 0/1 fallback only fires for
    // catalogs that don't publish a visualization block — at which
    // point the colormap will render any non-negative value as a
    // percentage of 1, surfacing the missing config rather than
    // silently using a wind-specific range.
    const viz = item.visualization;
    const vmin = viz?.vmin ?? 0;
    const vmax = viz?.vmax ?? 1;

    return [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (TileLayer as any)(this.getSubLayerProps({ id: 'tiles' }), {
        data: urlTemplate,
        minZoom: item.tile.minzoom,
        maxZoom: item.tile.maxzoom,
        tileSize: 256,
        // updateTriggers tells deck.gl's prop-diff that whenever the
        // listed value changes, the named prop should be treated as
        // changed too. Without this hint, swapping the colormap leaves
        // TileLayer thinking nothing relevant changed (function-typed
        // props default to ref-compare but TileLayer's tile-layer
        // cache only invalidates on detected prop change). The result
        // was that the closure-captured colormapStops never reached
        // the sub-layers on palette change — tiles kept rendering with
        // the colormap from when they were first cached.
        updateTriggers: {
          renderSubLayers: [this.props.colormap, kind],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderSubLayers: (props: any) => {
          const tile = props.tile;
          const { west, south, east, north } = tile.bbox;
          if (isElevation) {
            return new ElevationBitmapLayer(props, {
              data: undefined,
              image: props.data,
              bounds: [west, south, east, north],
              opacity: opacity ?? 0.75,
            });
          }
          if (isVector) {
            return new VectorMagnitudeBitmapLayer(props, {
              data: undefined,
              image: props.data,
              bounds: [west, south, east, north],
              scale: enc.scale,
              offset: enc.offset,
              vmin,
              vmax,
              colormap: colormapStops!,
              opacity: opacity ?? 0.75,
            });
          }
          return new ValueDecodedBitmapLayer(props, {
            data: undefined,
            image: props.data,
            bounds: [west, south, east, north],
            scale: enc.scale,
            offset: enc.offset,
            vmin,
            vmax,
            colormap: colormapStops!,
            opacity: opacity ?? 0.75,
          });
        },
      }),
    ];
  }
}
