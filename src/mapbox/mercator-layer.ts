// MercatorLayer — the SDK's single public entry point.
//
// One factory for every visualisation: raster, streamlines, arrows,
// contours, value labels, tile boundaries. Build the layer first
// (async if the viz needs catalog discovery, sync via `.fromItem`),
// then `.addTo(map)` when the host map is ready. `.remove()` detaches.
//
//   const layer = await MercatorLayer.create({
//     dataset: 'wind10m',
//     apiKey: 'mk_...',
//     viz: 'streamlines',
//   });
//   layer.addTo(map);

import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, absolutiseUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import type {
  EncodingKind,
  MercatorLayerOptions,
} from '../core/types';

import { createDecodedRasterLayer } from './raster-layer';
import { createStreamlinesLayer } from './streamlines-layer';
import { addArrowsOverlay, type ArrowsInspectResult } from './arrows-overlay';
import { addContoursOverlay } from './contours-overlay';
import { addValueLabelsOverlay } from './value-labels-overlay';
import { addTileBoundariesOverlay } from './tile-boundaries-overlay';

/** Mapbox/MapLibre-specific extras layered on top of {@link MercatorLayerOptions}.
 *  Cross-binding portable code can ignore these; binding-specific code
 *  uses them for z-ordering and style-spec overrides. */
export interface MapboxHostExtras {
  /** Mapbox GL JS v3 Standard "slot". Ignored on classic styles + MapLibre. */
  slot?: string;
  /** MapLibre/Mapbox layer id to insert this layer BEFORE — controls z-order. */
  beforeId?: string;
  /** Fontstack for label-bearing viz (contours, values). Default is
   *  Mapbox classic/Standard-friendly (Open Sans + Arial Unicode fallback);
   *  OpenFreeMap and other single-font endpoints want `['Noto Sans Regular']`. */
  textFont?: string[];
  /** Symbol-layer `layout` overrides for label-bearing viz. Merged on top
   *  of the defaults; the convenience opts (`textFont`, `unit`) win. */
  labelLayout?: Record<string, unknown>;
  /** Symbol-layer `paint` overrides for label-bearing viz. Merged on top
   *  of the defaults. */
  labelPaint?: Record<string, unknown>;
}

/** Public Mapbox/MapLibre options — the cross-binding discriminated union
 *  intersected with the host-specific extras. */
export type MapboxMercatorLayerOptions = MercatorLayerOptions & MapboxHostExtras;

// Internal handle shape: every viz produces either a CustomLayerInterface-
// like object (raster/streamlines — needs `map.addLayer`) or an overlay
// handle (arrows/contours/values/bounds — already attached, just needs
// `.remove()`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AttachedInner = any;

/**
 * The mercator.blue layer for Mapbox GL JS + MapLibre. A deferred-attach
 * wrapper: build with {@link MercatorLayer.create} (async, walks STAC) or
 * {@link MercatorLayer.fromItem} (sync, when the item is already in hand),
 * then call {@link MercatorLayer.addTo} when the host map is ready.
 *
 * ```ts
 * import maplibregl from 'maplibre-gl';
 * import { MercatorLayer } from '@mercator-blue/sdk/mapbox';
 *
 * const map = new maplibregl.Map({ container: 'map', style: '...' });
 * map.on('load', async () => {
 *   const layer = await MercatorLayer.create({
 *     dataset: 'wind10m',
 *     apiKey: 'mk_...',
 *     viz: 'streamlines',
 *   });
 *   layer.addTo(map);
 * });
 * ```
 */
export class MercatorLayer {
  private readonly opts: MapboxMercatorLayerOptions;
  private readonly item: DiscoveredItem | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private map: any = null;
  private inner: AttachedInner = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private innerCustomLayer: any = null;

  private constructor(opts: MapboxMercatorLayerOptions, item: DiscoveredItem | null) {
    this.opts = opts;
    this.item = item;
  }

  /** The Mapbox style-layer id this layer adds to the map. Useful for
   *  z-ordering via `beforeId` on a subsequent layer add. Only meaningful
   *  for raster / streamlines (single-layer viz). Returns undefined for
   *  overlay viz that adds multiple internal layers (arrows / contours /
   *  values / bounds). */
  get id(): string | undefined {
    return this.innerCustomLayer?.id;
  }

  /**
   * Asynchronously discover the dataset's latest STAC item and build the
   * layer. For `viz: 'bounds'` the discovery is skipped (no dataset needed).
   */
  static async create(opts: MapboxMercatorLayerOptions): Promise<MercatorLayer> {
    requireViz(opts);
    if (opts.viz === 'bounds') {
      return new MercatorLayer(opts, null);
    }
    requireDatasetAndKey(opts);
    const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
    const item = await discoverLatestItem(catalogUrl, opts.dataset);
    return new MercatorLayer(opts, item);
  }

  /**
   * Build from a pre-fetched STAC item. Useful when the host page already
   * holds the item (e.g. server-side discovery) and wants to skip the
   * extra round-trip. `viz: 'bounds'` ignores the item; pass `null` for
   * that case.
   */
  static fromItem(
    opts: MapboxMercatorLayerOptions,
    item: DiscoveredItem | null,
  ): MercatorLayer {
    requireViz(opts);
    if (opts.viz !== 'bounds') requireDatasetAndKey(opts);
    return new MercatorLayer(opts, item);
  }

  /** Attach to a Mapbox/MapLibre map. Returns `this` for chaining. */
  addTo(mapAny: unknown): this {
    if (this.map) throw new Error('@mercator-blue/sdk/mapbox: MercatorLayer is already attached to a map.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = mapAny as any;
    this.map = map;
    const opts = this.opts;
    switch (opts.viz) {
      case 'raster':
        this.innerCustomLayer = this._buildRaster();
        map.addLayer(this.innerCustomLayer, opts.beforeId);
        break;
      case 'streamlines':
        this.innerCustomLayer = this._buildStreamlines();
        map.addLayer(this.innerCustomLayer, opts.beforeId);
        break;
      case 'arrows':
        this.inner = addArrowsOverlay(map, this._arrowsOpts());
        break;
      case 'contours':
        this.inner = addContoursOverlay(map, this._contoursOpts());
        break;
      case 'values':
        this.inner = addValueLabelsOverlay(map, this._valueLabelsOpts());
        break;
      case 'bounds':
        this.inner = addTileBoundariesOverlay(map, this._boundsOpts());
        break;
    }
    return this;
  }

  /** Detach from the map. No-op if not attached. */
  remove(): void {
    if (this.innerCustomLayer) {
      // raster / streamlines — added via map.addLayer
      if (this.map && this.map.getLayer && this.map.getLayer(this.innerCustomLayer.id)) {
        this.map.removeLayer(this.innerCustomLayer.id);
      }
      this.innerCustomLayer = null;
    }
    if (this.inner && typeof this.inner.remove === 'function') {
      // overlays — own handle
      this.inner.remove();
      this.inner = null;
    }
    this.map = null;
  }

  // ---- Runtime configuration -------------------------------------------

  /**
   * Apply a partial options patch at runtime. Any field that's valid for
   * the current `viz` is mutable; fields that aren't relevant to the
   * current viz are silently ignored.
   *
   * The following fields are construction-time only and throw if passed:
   * `viz`, `dataset`, `apiKey`, `id`, `catalogUrl`. Build a new layer
   * (and replace this one) to change any of them.
   *
   * ```ts
   * layer.setOptions({ opacity: 0.5, colormap: 'magma' });
   * ```
   */
  setOptions(partial: Partial<MercatorLayerOptions>): void {
    if (!partial) return;
    const reject = ['viz', 'dataset', 'apiKey', 'id', 'catalogUrl'] as const;
    for (const k of reject) {
      if (k in partial) {
        throw new Error(
          `@mercator-blue/sdk/mapbox: MercatorLayer.setOptions — '${k}' is construction-time only. ` +
          'Replace the layer to change it.',
        );
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = this._innerWithSetters() as any;
    if (typeof inner.applyOptions === 'function') {
      inner.applyOptions(partial);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _innerWithSetters(): any {
    return this.innerCustomLayer ?? this.inner ?? {};
  }

  /**
   * For arrows-viz layers: return the source pixel under the given
   * `lng`/`lat`, or `null` if no tile is loaded there yet. Used by
   * click-to-inspect debug UIs.
   *
   * Returns `null` for any viz other than `'arrows'`, or before the
   * layer has been attached to a map.
   */
  inspectAt(lng: number, lat: number): ArrowsInspectResult | null {
    if (this.opts.viz !== 'arrows') return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = this.inner as any;
    if (!inner || typeof inner.inspectAt !== 'function') return null;
    return inner.inspectAt(lng, lat) as ArrowsInspectResult | null;
  }

  // ---- Internal dispatch helpers ---------------------------------------

  private _buildRaster(): unknown {
    if (this.opts.viz !== 'raster') throw new Error('@mercator-blue/sdk/mapbox: unreachable');
    const opts = this.opts;
    const item = this._requireItem();
    const enc = item.encoding;
    // Default id includes the viz so composing multiple viz on the
    // same dataset (raster + streamlines, the canonical wind view)
    // doesn't collide with Mapbox/MapLibre's "layer id already
    // exists" guard. Callers that need cross-page setOptions
    // targeting by id can still pass an explicit `id`.
    const id = opts.id ?? `mercator-${opts.dataset}-${opts.viz}`;
    return createDecodedRasterLayer({
      id,
      tileUrlTemplate: withApiKey(`${item.itemBase}/{z}/{x}/{y}.png`, opts.apiKey),
      encoding: { type: enc.kind as EncodingKind, scale: enc.scale, offset: enc.offset },
      minzoom: 0,
      maxzoom: item.tile.maxzoom,
      vmin: opts.vmin ?? item.visualization?.vmin ?? 0,
      vmax: opts.vmax ?? item.visualization?.vmax ?? 1,
      opacity: opts.opacity ?? 0.75,
      smooth: opts.smooth,
      colormap: opts.colormap ?? item.visualization?.colormap ?? 'viridis',
      scaleType: opts.scaleType ?? item.visualization?.scale_type,
      transparentBelow: opts.transparentBelow ?? item.visualization?.transparent_below,
      alphaByValue: opts.alphaByValue ?? item.visualization?.alpha_by_value,
      slot: opts.slot,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  private _buildStreamlines(): unknown {
    if (this.opts.viz !== 'streamlines') throw new Error('@mercator-blue/sdk/mapbox: unreachable');
    const opts = this.opts;
    const item = this._requireItem();
    const enc = item.encoding;
    // Default id includes the viz so composing multiple viz on the
    // same dataset (raster + streamlines, the canonical wind view)
    // doesn't collide with Mapbox/MapLibre's "layer id already
    // exists" guard. Callers that need cross-page setOptions
    // targeting by id can still pass an explicit `id`.
    const id = opts.id ?? `mercator-${opts.dataset}-${opts.viz}`;
    const landmaskTemplate = item.landmask?.url_template;
    return createStreamlinesLayer({
      id,
      tileUrlTemplate: withApiKey(`${item.itemBase}/{z}/{x}/{y}.png`, opts.apiKey),
      encoding: { scale: enc.scale, offset: enc.offset },
      maxzoom: item.tile.maxzoom,
      particleCount: opts.particleCount,
      pointSize: opts.pointSize,
      speedScale: opts.speedScale ?? item.visualization?.particle_speed_scale,
      maxAge: opts.maxAge,
      fade: opts.fade,
      colorBySpeed: opts.colorBySpeed ?? true,
      colormap: opts.colormap ?? item.visualization?.colormap ?? 'viridis',
      vmin: opts.vmin ?? item.visualization?.vmin ?? 0,
      vmax: opts.vmax ?? item.visualization?.vmax ?? 1,
      opacity: opts.opacity,
      landmaskUrlTemplate: landmaskTemplate
        ? withApiKey(absolutiseUrl(landmaskTemplate, item.itemBase), opts.apiKey)
        : undefined,
      landmaskAccepts: item.landmask?.accepts,
      landmaskMaxZ: item.landmask?.maxzoom,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _arrowsOpts(): any {
    if (this.opts.viz !== 'arrows') throw new Error('@mercator-blue/sdk/mapbox: unreachable');
    const opts = this.opts;
    const item = this._requireItem();
    if (item.encoding.kind !== 'vector_rg_ba') {
      throw new Error(
        `@mercator-blue/sdk/mapbox: viz "arrows" requires a vector_rg_ba encoding; ` +
        `dataset "${opts.dataset}" has "${item.encoding.kind}".`,
      );
    }
    return {
      tileUrlTemplate: withApiKey(`${item.itemBase}/{z}/{x}/{y}.png`, opts.apiKey),
      encoding: { scale: item.encoding.scale, offset: item.encoding.offset },
      maxzoom: item.tile.maxzoom,
      lockZoom: opts.lockZoom,
      speedRef: opts.speedRef ?? item.visualization?.vmax,
      landmaskUrlTemplate: item.landmask
        ? withApiKey(absolutiseUrl(item.landmask.url_template, item.itemBase), opts.apiKey)
        : undefined,
      landmaskAccepts: item.landmask?.accepts,
      beforeId: opts.beforeId,
      slot: opts.slot,
      lineWidth: opts.lineWidth,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _contoursOpts(): any {
    if (this.opts.viz !== 'contours') throw new Error('@mercator-blue/sdk/mapbox: unreachable');
    const opts = this.opts;
    const item = this._requireItem();
    if (!item.contour) {
      throw new Error(
        `@mercator-blue/sdk/mapbox: viz "contours" requires a contour pyramid; ` +
        `dataset "${opts.dataset}" has none published.`,
      );
    }
    const c = item.contour;
    return {
      urlTemplate: withApiKey(absolutiseUrl(c.url_template, item.itemBase), opts.apiKey),
      sourceLayer: c.source_layer,
      minzoom: c.minzoom,
      maxzoom: c.maxzoom,
      initialInterval: opts.initialInterval ?? c.default_interval,
      unit: c.unit,
      userFilterMinZoom: c.user_filter_min_zoom,
      coarsestInterval: c.coarsest_interval,
      beforeId: opts.beforeId,
      slot: opts.slot,
      textFont: opts.textFont,
      labelLayout: opts.labelLayout,
      labelPaint: opts.labelPaint,
      lineColor: opts.lineColor,
      lineOpacity: opts.lineOpacity,
      lineWidth: opts.lineWidth,
      boldLineWidth: opts.boldLineWidth,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _valueLabelsOpts(): any {
    if (this.opts.viz !== 'values') throw new Error('@mercator-blue/sdk/mapbox: unreachable');
    const opts = this.opts;
    const item = this._requireItem();
    const kind = item.encoding.kind;
    if (kind !== 'rg16_fixed' && kind !== 'vector_rg_ba' && kind !== 'mapbox_rgb') {
      throw new Error(
        `@mercator-blue/sdk/mapbox: viz "values" requires rg16_fixed, vector_rg_ba, ` +
        `or mapbox_rgb; dataset "${opts.dataset}" has "${kind}".`,
      );
    }
    const vmax = item.visualization?.vmax;
    const defaultDigits = vmax != null && vmax < 10 ? 1 : 0;
    return {
      tileUrlTemplate: withApiKey(`${item.itemBase}/{z}/{x}/{y}.png`, opts.apiKey),
      encoding: {
        kind: kind as EncodingKind,
        scale: item.encoding.scale,
        offset: item.encoding.offset,
      },
      maxzoom: item.tile.maxzoom,
      lockZoom: opts.lockZoom,
      digits: opts.digits ?? defaultDigits,
      format: opts.format,
      targetAcross: opts.targetAcross,
      landmaskUrlTemplate: item.landmask
        ? withApiKey(absolutiseUrl(item.landmask.url_template, item.itemBase), opts.apiKey)
        : undefined,
      landmaskAccepts: item.landmask?.accepts,
      beforeId: opts.beforeId,
      slot: opts.slot,
      textFont: opts.textFont,
      labelLayout: opts.labelLayout,
      labelPaint: opts.labelPaint,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _boundsOpts(): any {
    if (this.opts.viz !== 'bounds') throw new Error('@mercator-blue/sdk/mapbox: unreachable');
    const opts = this.opts;
    return {
      ...(opts.minzoom != null ? { minzoom: opts.minzoom } : {}),
      ...(opts.maxzoom != null ? { maxzoom: opts.maxzoom } : {}),
      slot: opts.slot,
      textFont: opts.textFont,
      lineWidth: opts.lineWidth,
    };
  }

  private _requireItem(): DiscoveredItem {
    if (!this.item) {
      throw new Error(
        '@mercator-blue/sdk/mapbox: STAC item is null; only viz "bounds" supports a null item.',
      );
    }
    return this.item;
  }
}

function requireViz(opts: MapboxMercatorLayerOptions): void {
  if (!opts || !opts.viz) {
    throw new Error(
      '@mercator-blue/sdk/mapbox: `viz` is required (one of "raster", "streamlines", ' +
      '"arrows", "contours", "values", "bounds").',
    );
  }
}

function requireDatasetAndKey(opts: MapboxMercatorLayerOptions): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = opts as any;
  if (!o.dataset) throw new Error('@mercator-blue/sdk/mapbox: `dataset` is required.');
  if (!o.apiKey) {
    throw new Error(
      '@mercator-blue/sdk/mapbox: `apiKey` is required. Get one at https://mercator.blue/dashboard.',
    );
  }
}
