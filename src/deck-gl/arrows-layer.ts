// Direction-arrow overlay for vector_rg_ba datasets (wind, currents)
// in deck.gl. Mirrors the Mapbox/MapLibre `ArrowsOverlay` from
// `../arrows-overlay.js` — same viewport-driven lattice (~30 arrows
// across), same three sampling regimes (bilinear / single-sample /
// precision-floor), same tile-pixel decode path (the WebGL-based
// reader in `tile-pixel-reader.js`, which avoids canvas-2D's
// premultiply round-trip catastrophe for the alpha-encoded vector_rg_ba
// low bytes).
//
// Differences vs the Mapbox version: rendering goes through a stock
// `LineLayer` instead of a custom-WebGL expanded-triangle pipeline.
// 3 LineLayer entries per arrow (shaft, wingL, wingR). Width is in
// CSS pixels via deck.gl's `widthUnits: 'pixels'`; deck.gl handles
// screen-space tessellation internally.

import { CompositeLayer, type DefaultProps, type Color, type LayersList } from '@deck.gl/core';
import { LineLayer } from '@deck.gl/layers';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, DEFAULT_CATALOG_URL } from '../core/urls';
import { loadTilePixels } from '../core/tile-pixel-reader';
import { resolveColormap, COLORMAP_SIZE } from '../core/color/colormaps';
import {
  lngToTileX,
  latToTileY,
  tileXToLng,
  tileYToLat,
} from '../core/mercator';
import type { ColormapSpec } from '../core/types';

const TARGET_ARROWS_ACROSS = 30;
// Fallback speed reference (m/s) when STAC item.visualization.vmax is
// absent — calibrated for wind. Currents/wind get their own value
// threaded through from STAC. See _buildSegments below.
const DEFAULT_SPEED_REF_MS = 15;
const MIN_LEN_FRAC = 0.18;
// Below this arrow length (degrees of longitude) Float32 ULP precision
// in the vertex stream collapses the wing offsets onto the tip
// ("cuneiform" smudge). Mapbox version sees this in its custom shader's
// vertex buffer; deck.gl LineLayer applies the same Float32 split-
// precision projection, so the same floor applies here.
const MIN_BASE_LEN_DEG = 1e-3;

// Module-level discovery cache — survives deck.gl's instance
// reconciliation (which transfers `state` but not instance-own fields).
// Same shape as `raster-layer.ts`.
const discoveryCache = new Map<string, DiscoveredItem | Promise<DiscoveredItem>>();
const discoveryKey = (catalogUrl: string, dataset: string) => `${catalogUrl}|${dataset}`;

// Module-level tile-pixel cache, keyed by full URL (so two layers with
// different API keys don't collide). Entries are either the decoded
// pixels, the literal string 'loading' while a fetch is in flight, or
// the literal string 'error' for a failed fetch.
type TilePixels = { pixels: Uint8Array; width: number; height: number };
type CacheEntry = TilePixels | 'loading' | 'error';
const tilePixelCache = new Map<string, CacheEntry>();

/**
 * Return cached pixels for `url`, or null if not yet loaded. Kicks off
 * an async fetch on first call; subsequent callers in flight share the
 * same fetch (no duplicate downloads). On completion runs `onLoad` to
 * notify the caller to re-render.
 *
 * Cache contract: `'loading'` and `'error'` are stored under the same
 * URL key as the eventual result, so a busy-wait re-check returns the
 * same in-flight state.
 */
function ensureTilePixels(url: string, onLoad: () => void): TilePixels | null {
  const existing = tilePixelCache.get(url);
  if (existing && typeof existing === 'object') return existing;
  if (existing === 'loading' || existing === 'error') return null;

  tilePixelCache.set(url, 'loading');
  loadTilePixels(url)
    .then((result) => {
      tilePixelCache.set(url, result);
      onLoad();
    })
    .catch(() => {
      tilePixelCache.set(url, 'error');
    });
  return null;
}

export interface MercatorArrowsLayerProps {
  /** Dataset name, e.g. 'wind10m', 'currents'. Must have vector_rg_ba encoding. */
  dataset: string;
  /** mercator.blue API key (`mk_<...>`). */
  apiKey: string;
  /** STAC catalog URL. Defaults to the production tile API. */
  catalogUrl?: string;
  /** Colormap preset name or explicit stops. Arrows colour by speed. */
  colormap?: ColormapSpec;
  /** Arrow line width in CSS pixels. */
  lineWidth?: number;
  /** Layer id. */
  id?: string;
}

interface ArrowSegment {
  start: [number, number];
  end: [number, number];
  color: Color;
}

const defaultProps: DefaultProps<MercatorArrowsLayerProps> = {
  dataset: '',
  apiKey: '',
  catalogUrl: DEFAULT_CATALOG_URL,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  colormap: 'viridis' as any,
  lineWidth: { type: 'number', value: 1.5 },
};

export class MercatorArrowsLayer extends CompositeLayer<MercatorArrowsLayerProps> {
  static layerName = 'MercatorArrowsLayer';
  static defaultProps = defaultProps;

  // Per-instance segment cache + trailing-edge debounce timer. Survives
  // viewport changes (same instance handles every camera tick) but
  // resets on prop changes (palette/dataset toggle reconstructs the
  // layer instance, which is what we want anyway — palette change
  // forces a colour-recompute). Mapbox/MapLibre overlay relies on
  // moveend/zoomend; deck.gl doesn't expose that event so we
  // approximate it by waiting 150 ms after the last viewport change
  // before rebuilding. Without this, the lattice anchor (which scales
  // with viewport-width-in-data-pixels) shifts every frame during a
  // zoom animation and arrows visibly wobble in lat/lng space.
  private _cachedSegments: ArrowSegment[] = [];
  private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  // Microtask-ish timer for coalescing bursts of tile-load callbacks
  // into a single rebuild. Several tiles often resolve within the same
  // JS turn (browser network stack delivers ImageBitmaps in batches);
  // rebuilding 16 times for one settled-zoom is wasted work.
  private _coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastViewportKey: string = '';

  private _getCachedItem(): DiscoveredItem | null {
    const { dataset, catalogUrl } = this.props;
    if (!dataset) return null;
    const cached = discoveryCache.get(discoveryKey(catalogUrl!, dataset));
    return cached && !(cached instanceof Promise) ? cached : null;
  }

  initializeState() {
    if (!this._getCachedItem()) void this._discover();
  }

  updateState({
    props,
    oldProps,
  }: {
    props: MercatorArrowsLayerProps;
    oldProps: MercatorArrowsLayerProps;
  }) {
    if (
      props.dataset !== oldProps.dataset ||
      props.catalogUrl !== oldProps.catalogUrl
    ) {
      if (!this._getCachedItem()) void this._discover();
    }
  }

  // Default `shouldUpdateState` skips viewport changes; we need the
  // lattice recomputed on pan/zoom.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldUpdateState({ changeFlags }: any): boolean {
    return changeFlags.somethingChanged;
  }

  async _discover() {
    const { dataset, catalogUrl } = this.props;
    if (!dataset) return;
    const key = discoveryKey(catalogUrl!, dataset);
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
      if (item.encoding.kind !== 'vector_rg_ba') {
        throw new Error(
          `@mercator-blue/sdk/deck-gl: MercatorArrowsLayer requires a vector_rg_ba ` +
            `encoding (wind, currents); dataset "${dataset}" has "${item.encoding.kind}". ` +
            'For scalar fields use MercatorRasterLayer.',
        );
      }
      discoveryCache.set(key, item);
      this.setNeedsUpdate();
    } catch (err) {
      if (discoveryCache.get(key) === promise) discoveryCache.delete(key);
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[MercatorArrowsLayer]', msg);
    }
  }

  renderLayers(): LayersList {
    const item = this._getCachedItem();
    if (!item) return [];

    const viewport = this.context.viewport;
    if (viewport) {
      // Viewport fingerprint — zoom + camera position + bearing. We
      // rebuild segments on first paint OR when viewport has stopped
      // changing for 150 ms. During an active zoom/pan animation each
      // renderLayers() cancels and reschedules the timer, so no actual
      // rebuild fires until motion settles.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = viewport as any;
      const key =
        `${vp.zoom?.toFixed(4) ?? 0}|` +
        `${vp.latitude?.toFixed(6) ?? 0}|` +
        `${vp.longitude?.toFixed(6) ?? 0}|` +
        `${vp.bearing?.toFixed(2) ?? 0}|` +
        `${vp.pitch?.toFixed(2) ?? 0}`;
      if (key !== this._lastViewportKey) {
        const isFirstPaint = this._lastViewportKey === '';
        this._lastViewportKey = key;
        if (isFirstPaint) {
          // Build immediately so the user doesn't stare at empty
          // arrows for 150 ms after toggling the layer on.
          this._cachedSegments = this._buildSegments(item);
        } else {
          if (this._rebuildTimer != null) clearTimeout(this._rebuildTimer);
          this._rebuildTimer = setTimeout(() => {
            this._rebuildTimer = null;
            this._cachedSegments = this._buildSegments(item);
            this.setNeedsUpdate();
          }, 150);
        }
      }
    }

    const segments = this._cachedSegments;
    const fingerprint = segments.length;

    return [
      new LineLayer<ArrowSegment>(this.getSubLayerProps({ id: 'segments' }), {
        data: segments,
        getSourcePosition: (d) => d.start,
        getTargetPosition: (d) => d.end,
        getColor: (d) => d.color,
        getWidth: this.props.lineWidth ?? 1.5,
        widthUnits: 'pixels',
        updateTriggers: {
          getSourcePosition: [fingerprint],
          getTargetPosition: [fingerprint],
          getColor: [fingerprint],
        },
      }),
    ];
  }

  finalizeState() {
    if (this._rebuildTimer != null) {
      clearTimeout(this._rebuildTimer);
      this._rebuildTimer = null;
    }
    if (this._coalesceTimer != null) {
      clearTimeout(this._coalesceTimer);
      this._coalesceTimer = null;
    }
  }

  // Called from _buildSegments' onLoad closure when a tile pixel-fetch
  // completes. Rebuilds segments with the now-larger cache. Coalesces
  // bursts: multiple onLoad callbacks within the same JS turn collapse
  // to one rebuild. Without this, setNeedsUpdate() alone is not enough
  // because renderLayers() only triggers a rebuild on viewport-key
  // change, and tile-loads-after-debounce share the same viewport.
  private _onTileLoaded = () => {
    if (this._coalesceTimer != null) return;
    this._coalesceTimer = setTimeout(() => {
      this._coalesceTimer = null;
      const item = this._getCachedItem();
      if (!item) return;
      this._cachedSegments = this._buildSegments(item);
      this.setNeedsUpdate();
    }, 0);
  };

  _buildSegments(item: DiscoveredItem): ArrowSegment[] {
    const viewport = this.context.viewport;
    if (!viewport) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bounds = (viewport as any).getBounds?.() as
      | [number, number, number, number]
      | undefined;
    if (!bounds) return [];
    const [wLng, sLat, eLng, nLat] = bounds;

    const maxzoom = item.tile.maxzoom;
    const z = Math.max(0, Math.min(maxzoom, Math.floor(viewport.zoom)));
    const n = Math.pow(2, z);

    const txMin = Math.floor(lngToTileX(wLng, z));
    const txMax = Math.floor(lngToTileX(eLng, z));
    const tyMin = Math.max(0, Math.floor(latToTileY(nLat, z)));
    const tyMax = Math.min(n - 1, Math.floor(latToTileY(sLat, z)));

    const apiKey = this.props.apiKey;
    const onLoad = this._onTileLoaded;

    // Resolve every needed tile up-front. ensureTilePixels kicks off
    // background fetches for any URL we haven't seen, and returns null
    // until the bytes are decoded — render with whatever's cached now.
    const tiles = new Map<string, TilePixels | null>();
    for (let tx = txMin; tx <= txMax; tx++) {
      for (let ty = tyMin; ty <= tyMax; ty++) {
        if (ty < 0 || ty >= n) continue;
        const wrappedTx = ((tx % n) + n) % n;
        const url = withApiKey(
          `${item.itemBase}/${z}/${wrappedTx}/${ty}.png`,
          apiKey,
        );
        tiles.set(`${z}/${wrappedTx}/${ty}`, ensureTilePixels(url, onLoad));
      }
    }

    // Lattice math — mirror the Mapbox version exactly. See
    // ../arrows-overlay.js for the long-form rationale on each step.
    const dataPxLeft = lngToTileX(wLng, z) * 256;
    const dataPxRight = lngToTileX(eLng, z) * 256;
    const dataPxTop = latToTileY(nLat, z) * 256;
    const dataPxBottom = latToTileY(sLat, z) * 256;
    const dataPxViewportWidth = dataPxRight - dataPxLeft;
    const dataPxViewportHeight = dataPxBottom - dataPxTop;

    const naturalBaseLenDeg = ((eLng - wLng) / TARGET_ARROWS_ACROSS) * 0.85;
    let baseLenDeg: number, arrowsAcross: number;
    if (naturalBaseLenDeg >= MIN_BASE_LEN_DEG) {
      baseLenDeg = naturalBaseLenDeg;
      arrowsAcross = TARGET_ARROWS_ACROSS;
    } else {
      baseLenDeg = MIN_BASE_LEN_DEG;
      arrowsAcross = Math.max(
        0,
        Math.floor(((eLng - wLng) * 0.85) / MIN_BASE_LEN_DEG),
      );
    }
    if (arrowsAcross === 0) return [];

    const pxStep = Math.max(1e-6, dataPxViewportWidth / arrowsAcross);
    const halfStep = pxStep * 0.5;
    const useSingleSample =
      dataPxViewportWidth < 1 || dataPxViewportHeight < 1;

    const startX = Math.floor(dataPxLeft / pxStep) * pxStep + halfStep;
    const startY = Math.floor(dataPxTop / pxStep) * pxStep + halfStep;

    const sc = item.encoding.scale;
    const off = item.encoding.offset;

    // Decode one packed (u, v) sample from a tile's pixel buffer.
    // (0,0,0,0) is the no-data sentinel — emitted by the encoder
    // whenever either component is NaN (land for currents, masked
    // pixels in general).
    const decodeUV = (
      tile: TilePixels,
      ix: number,
      iy: number,
    ): [number, number] => {
      const idx = (iy * tile.width + ix) * 4;
      const r = tile.pixels[idx];
      const g = tile.pixels[idx + 1];
      const b = tile.pixels[idx + 2];
      const a = tile.pixels[idx + 3];
      if ((r | g | b | a) === 0) return [NaN, NaN];
      return [(r * 256 + g) * sc + off, (b * 256 + a) * sc + off];
    };

    // Pre-compute the single-sample (u, v) when the viewport is smaller
    // than one data pixel in either dimension. See Mapbox version's
    // long-form comment for why per-arrow nearest sampling produces
    // banding artifacts in that regime.
    let singleU = NaN, singleV = NaN;
    if (useSingleSample) {
      const centerPxX = (dataPxLeft + dataPxRight) * 0.5;
      const centerPxY = (dataPxTop + dataPxBottom) * 0.5;
      const cTx = Math.floor(centerPxX / 256);
      const cTy = Math.floor(centerPxY / 256);
      if (cTy >= 0 && cTy < n) {
        const cWrappedTx = ((cTx % n) + n) % n;
        const cTile = tiles.get(`${z}/${cWrappedTx}/${cTy}`);
        if (cTile) {
          const cFx = Math.max(
            0,
            Math.min(cTile.width - 1, Math.floor(centerPxX - cTx * 256)),
          );
          const cFy = Math.max(
            0,
            Math.min(cTile.height - 1, Math.floor(centerPxY - cTy * 256)),
          );
          [singleU, singleV] = decodeUV(cTile, cFx, cFy);
        }
      }
    }

    const colormapStops = resolveColormap(this.props.colormap);
    // Speed (m/s) at which arrow length saturates AND the colour ramp
    // hits its last stop. Pulled from STAC mercator:visualization.vmax
    // so wind (~40) and currents (~2) each cover their full range.
    // Falls back to wind-tuned 15 if the dataset doesn't publish vmax.
    const speedRef = item.visualization?.vmax ?? DEFAULT_SPEED_REF_MS;

    const speedToColor = (speed: number): Color => {
      const t = Math.max(0, Math.min(1, speed / speedRef));
      // Colormap has COLORMAP_SIZE evenly-spaced stops; nearest-pick.
      const idx = Math.min(
        COLORMAP_SIZE - 1,
        Math.floor(t * COLORMAP_SIZE),
      );
      return [
        Math.round(colormapStops[idx * 3] * 255),
        Math.round(colormapStops[idx * 3 + 1] * 255),
        Math.round(colormapStops[idx * 3 + 2] * 255),
        255,
      ];
    };

    const segments: ArrowSegment[] = [];

    for (let pixY = startY; pixY < dataPxBottom + halfStep; pixY += pxStep) {
      const ty = Math.floor(pixY / 256);
      if (ty < 0 || ty >= n) continue;
      const fyAbs = pixY - ty * 256;
      for (let pixX = startX; pixX < dataPxRight + halfStep; pixX += pxStep) {
        const tx = Math.floor(pixX / 256);
        const wrappedTx = ((tx % n) + n) % n;
        const tile = tiles.get(`${z}/${wrappedTx}/${ty}`);
        if (!tile) continue;
        const fxAbs = pixX - tx * 256;

        let u: number, v: number;
        if (useSingleSample) {
          u = singleU;
          v = singleV;
        } else {
          const W = tile.width, H = tile.height;
          const x0 = Math.max(0, Math.min(W - 1, Math.floor(fxAbs)));
          const y0 = Math.max(0, Math.min(H - 1, Math.floor(fyAbs)));
          const x1 = Math.min(W - 1, x0 + 1);
          const y1 = Math.min(H - 1, y0 + 1);
          const ax = Math.max(0, Math.min(1, fxAbs - x0));
          const ay = Math.max(0, Math.min(1, fyAbs - y0));
          const [u00, v00] = decodeUV(tile, x0, y0);
          const [u01, v01] = decodeUV(tile, x1, y0);
          const [u10, v10] = decodeUV(tile, x0, y1);
          const [u11, v11] = decodeUV(tile, x1, y1);
          const w00 = (1 - ax) * (1 - ay);
          const w01 = ax * (1 - ay);
          const w10 = (1 - ax) * ay;
          const w11 = ax * ay;
          u = u00 * w00 + u01 * w01 + u10 * w10 + u11 * w11;
          v = v00 * w00 + v01 * w01 + v10 * w10 + v11 * w11;
        }

        const speed = Math.sqrt(u * u + v * v);
        if (!Number.isFinite(speed) || speed < 0.05) continue;

        const lng0 = tileXToLng(tx + fxAbs / 256, z);
        const lat0 = tileYToLat(ty + fyAbs / 256, z);

        const ndu = u / speed;
        const ndv = v / speed;
        const lenFrac = Math.max(
          MIN_LEN_FRAC,
          Math.min(1, speed / speedRef),
        );
        const shaftLen = baseLenDeg * lenFrac;
        const headLen = shaftLen * 0.35;
        const tipLng = lng0 + ndu * shaftLen;
        const tipLat = lat0 + ndv * shaftLen;
        const angle = Math.atan2(ndv, ndu);
        const aL = angle + Math.PI - 0.45;
        const aR = angle + Math.PI + 0.45;
        const wingL: [number, number] = [
          tipLng + Math.cos(aL) * headLen,
          tipLat + Math.sin(aL) * headLen,
        ];
        const wingR: [number, number] = [
          tipLng + Math.cos(aR) * headLen,
          tipLat + Math.sin(aR) * headLen,
        ];

        const color = speedToColor(speed);
        segments.push({ start: [lng0, lat0], end: [tipLng, tipLat], color });
        segments.push({ start: [tipLng, tipLat], end: wingL, color });
        segments.push({ start: [tipLng, tipLat], end: wingR, color });
      }
    }

    return segments;
  }
}

