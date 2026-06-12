/**
 * OpenLayers binding — "values on a grid" overlay. Scalar datasets show
 * the decoded value, vector datasets show the speed magnitude.
 *
 * **Viewport-tied lattice** (mirrors the Leaflet binding). A target ≈ 18
 * labels span the visible viewport at every zoom; the lattice spacing
 * scales with the data sampling zoom so the on-screen density stays
 * roughly constant. (An earlier tile-tied variant is parked in
 * `value-labels-layer-tile-tied.ts` for reference.)
 *
 * **Recompute is debounced, not per-frame.** The lattice's global anchor
 * (`floor(dataPxLeft / pxStep) * pxStep + halfStep`) depends on `pxStep`,
 * which depends on view zoom. Recomputing every frame during a zoom
 * animation would make the labels' stored 3857 positions slide between
 * frames — the labels appear to drift diagonally relative to the basemap
 * even though they're 3857-stored. Instead we compute the lattice ONCE
 * on a debounced viewport change (matching Leaflet's `moveend`/`zoomend`
 * cadence) and re-project the cached stash through the live transform
 * on every frame. Labels move with the basemap during a zoom anim, then
 * density updates once the view settles.
 *
 * Lifecycle:
 *   1. `loadTile()` co-fetches the data PNG + optional landmask PNG at
 *      the same z/x/y, decodes via the WebGL pixel reader, and emits a
 *      Float32 `val` array — scalar value or vector magnitude, with NaN
 *      sentinels for vector_rg_ba's (0,0,0,0), scalar's alpha=0, and
 *      landmask-rejected pixels.
 *   2. `render(frameState)` captures a snapshot of the view (zoom,
 *      center, resolution, size), draws the current `stash` (labels in
 *      3857 world coords) through the live `coordinateToPixelTransform`,
 *      and schedules a debounced recompute if the view differs from
 *      `lastComputedKey` (0 ms on the very first render, 150 ms after).
 *   3. `runRecompute()` walks the lattice at the snapshot's view zoom,
 *      bilinear-samples each lattice point from the data tiles (calling
 *      `ensureTile` which kicks off async loads for cache misses), and
 *      atomically swaps the stash when every visible tile is loaded.
 *      Async tile loads call `layer.changed()`; that re-runs `render`
 *      which re-schedules recompute (still pinned to the same view) so
 *      missing tiles fill in.
 *
 * Overzoom past `maxzoom`: `pxStep` falls below 1 data pixel and the
 * lattice samples the maxzoom data tile at sub-pixel positions, giving
 * a smooth bilinear-interpolated value field at finer screen density.
 */

import Layer from 'ol/layer/Layer.js';
import { apply as applyTransform } from 'ol/transform.js';
import type { FrameState } from 'ol/Map.js';

import { loadTilePixels } from '../core/tile-pixel-reader';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, absolutiseUrl, expandTileUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import type { MercatorValueLabelsOptions } from '../core/types';

import { HALF_MERCATOR, WORLD_EXT_3857 } from '../core/mercator';

const TARGET_LABELS_ACROSS = 18;
const RECOMPUTE_DEBOUNCE_MS = 150;
// How many CSS pixels beyond the canvas edge we still draw labels for.
// Keeping a generous margin lets a label slide off cleanly during a pan
// (its center can go all the way to the edge before we stop drawing,
// then Canvas2D clips the remaining half-glyph); it also bounds the cost
// of drawing labels from other world copies that the stash may contain
// after a long horizontal pan.
const DRAW_BUFFER_PX = 64;

/** OpenLayers-specific extras on top of the cross-binding
 *  {@link MercatorValueLabelsOptions}. */
export type MercatorValueLabelsLayerOpts = MercatorValueLabelsOptions & {
  /** Landmask tile URL template. Defaults to the dataset's
   *  `mercator:landmask.url_template`. */
  landmaskUrlTemplate?: string;
  /** Mask bytes treated as valid. Defaults to STAC's `landmask.accepts`. */
  landmaskAccepts?: number[];
  /** Label fill colour. Default `#1a1a1a`. */
  textColor?: string;
  /** Label halo colour. Default `rgba(255, 255, 255, 0.9)`. */
  textHaloColor?: string;
  /** Label halo width, CSS px. Default 2.5. */
  textHaloWidth?: number;
  /** Canvas2D font shorthand. Default `600 12px sans-serif`. */
  font?: string;
  /** OL layer z-index. Default 700. */
  zIndex?: number;
};

type LoadedTile = { status: 'loaded'; val: Float32Array; W: number; H: number };
type LoadingTile = { status: 'loading'; promise: Promise<LoadedTile> };
type ErrorTile = { status: 'error' };
type TileCacheEntry = LoadedTile | LoadingTile | ErrorTile;

interface StashLabel { x3857: number; y3857: number; text: string }

interface ViewSnapshot {
  zoom: number;
  center: [number, number];
  resolution: number;
  size: [number, number];
}

function snapKey(s: ViewSnapshot): string {
  return `${s.zoom}|${s.center[0]}|${s.center[1]}|${s.size[0]}|${s.size[1]}`;
}

function buildLayer(opts: MercatorValueLabelsLayerOpts, item: DiscoveredItem): Layer {
  const kind = item.encoding.kind;
  if (kind !== 'rg16_fixed' && kind !== 'vector_rg_ba' && kind !== 'mapbox_rgb') {
    throw new Error(
      `@mercator-blue/sdk/openlayers: MercatorValueLabelsLayer supports ` +
      `rg16_fixed (scalar), vector_rg_ba (magnitude), and mapbox_rgb ` +
      `(elevation) encodings; got "${kind}".`,
    );
  }

  const maxzoom = item.tile.maxzoom;
  let targetAcross = opts.targetAcross ?? TARGET_LABELS_ACROSS;
  const tileUrlTemplate = withApiKey(`${item.itemBase}/{z}/{x}/{y}.png`, opts.apiKey);
  const lmTemplate = opts.landmaskUrlTemplate ?? item.landmask?.url_template;
  const landmaskUrlTemplate = lmTemplate
    ? withApiKey(absolutiseUrl(lmTemplate, item.itemBase), opts.apiKey)
    : undefined;
  const lmAccepts = opts.landmaskAccepts ?? item.landmask?.accepts;
  const landmaskAccepts = lmAccepts ? new Set(lmAccepts) : null;

  const vmax = item.visualization?.vmax;
  let digits = opts.digits ?? (vmax != null && vmax < 10 ? 1 : 0);
  let format = opts.format ?? ((v: number) => v.toFixed(digits));
  let customFormat = opts.format != null;

  const textColor = opts.textColor ?? '#1a1a1a';
  const textHaloColor = opts.textHaloColor ?? 'rgba(255, 255, 255, 0.9)';
  const textHaloWidth = opts.textHaloWidth ?? 2.5;
  const font = opts.font ?? '600 12px sans-serif';

  const cache = new Map<string, TileCacheEntry>();

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.pointerEvents = 'none';
  const ctx0 = canvas.getContext('2d');
  if (!ctx0) {
    throw new Error('@mercator-blue/sdk/openlayers: 2D canvas context unavailable');
  }
  const ctx: CanvasRenderingContext2D = ctx0;

  let layer: Layer | null = null;
  let stash: StashLabel[] = [];
  let lastComputedKey: string | null = null;
  let pending = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let latestSnapshot: ViewSnapshot | null = null;

  function ensureTile(z: number, wrappedTx: number, ty: number): LoadedTile | null {
    const key = `${z}/${wrappedTx}/${ty}`;
    const existing = cache.get(key);
    if (existing) {
      if (existing.status === 'loaded') return existing;
      if (existing.status === 'loading') return null;
      // 'error' — fall through and retry below (matches the Leaflet
      // binding; a transient 5xx shouldn't permanently kill a tile).
    }
    const promise = (async (): Promise<LoadedTile> => {
      const url = expandTileUrl(tileUrlTemplate, z, wrappedTx, ty);
      const maskUrl = landmaskUrlTemplate
        ? expandTileUrl(landmaskUrlTemplate, z, wrappedTx, ty)
        : null;
      const [dataPx, maskPx] = await Promise.all([
        loadTilePixels(url),
        maskUrl ? loadTilePixels(maskUrl).catch(() => null) : Promise.resolve(null),
      ]);
      const { width: W, height: H, pixels: data } = dataPx;
      const val = new Float32Array(W * H);
      const sc = item.encoding.scale, off = item.encoding.offset;
      const maskBytes = maskPx?.pixels;
      const useMask = !!(maskBytes && maskBytes.length === W * H * 4 && landmaskAccepts);
      for (let i = 0; i < W * H; i++) {
        const r = data[i * 4], g = data[i * 4 + 1];
        const b = data[i * 4 + 2], a = data[i * 4 + 3];
        if (useMask && !landmaskAccepts!.has(maskBytes![i * 4])) {
          val[i] = NaN; continue;
        }
        if (kind === 'vector_rg_ba') {
          if ((r | g | b | a) === 0) { val[i] = NaN; continue; }
          const u = (r * 256 + g) * sc + off;
          const v = (b * 256 + a) * sc + off;
          val[i] = Math.sqrt(u * u + v * v);
        } else if (kind === 'mapbox_rgb') {
          // 24-bit signed integer (Mapbox Terrain-RGB). Alpha unused;
          // every pixel is a valid altitude.
          val[i] = (r * 65536 + g * 256 + b) * sc + off;
        } else {
          if (a === 0) { val[i] = NaN; continue; }
          val[i] = (r * 256 + g) * sc + off;
        }
      }
      const loaded: LoadedTile = { status: 'loaded', val, W, H };
      cache.set(key, loaded);
      // A tile completed mid-flight: trigger a re-render so we either
      // pick up the new tile in the current debounced recompute window
      // or schedule a fresh one (see render's `vKey !== lastComputedKey`
      // check).
      layer?.changed();
      return loaded;
    })();
    cache.set(key, { status: 'loading', promise });
    promise.catch(() => cache.set(key, { status: 'error' }));
    return null;
  }

  function computeFreshLabels(snap: ViewSnapshot): { labels: StashLabel[]; allLoaded: boolean } {
    const W = snap.size[0], H = snap.size[1];
    const tlX = snap.center[0] - (W / 2) * snap.resolution;
    const tlY = snap.center[1] + (H / 2) * snap.resolution;
    const brX = snap.center[0] + (W / 2) * snap.resolution;
    const brY = snap.center[1] - (H / 2) * snap.resolution;

    const zData = Math.max(0, Math.min(maxzoom, Math.floor(snap.zoom)));
    const nData = 2 ** zData;
    const dataWorldPx = nData * 256;

    const dataPxLeft = (tlX + HALF_MERCATOR) / WORLD_EXT_3857 * dataWorldPx;
    const dataPxRight = (brX + HALF_MERCATOR) / WORLD_EXT_3857 * dataWorldPx;
    const dataPxTop = (HALF_MERCATOR - tlY) / WORLD_EXT_3857 * dataWorldPx;
    const dataPxBottom = (HALF_MERCATOR - brY) / WORLD_EXT_3857 * dataWorldPx;
    const dataPxVpWidth = dataPxRight - dataPxLeft;

    const pxStep = Math.max(1e-6, dataPxVpWidth / targetAcross);
    const halfStep = pxStep * 0.5;
    const startX = Math.floor(dataPxLeft / pxStep) * pxStep + halfStep;
    const startY = Math.floor(dataPxTop / pxStep) * pxStep + halfStep;

    const labels: StashLabel[] = [];
    let allLoaded = true;

    for (let pixY = startY; pixY < dataPxBottom + halfStep; pixY += pxStep) {
      const tyData = Math.floor(pixY / 256);
      if (tyData < 0 || tyData >= nData) continue;
      const fy = pixY - tyData * 256;
      for (let pixX = startX; pixX < dataPxRight + halfStep; pixX += pxStep) {
        const txData = Math.floor(pixX / 256);
        const wrappedTxData = ((txData % nData) + nData) % nData;
        const tile = ensureTile(zData, wrappedTxData, tyData);
        if (!tile) { allLoaded = false; continue; }
        const fx = pixX - txData * 256;

        const x0 = Math.max(0, Math.min(tile.W - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(tile.H - 1, Math.floor(fy)));
        const x1 = Math.min(tile.W - 1, x0 + 1);
        const y1 = Math.min(tile.H - 1, y0 + 1);
        const ax = Math.max(0, Math.min(1, fx - x0));
        const ay = Math.max(0, Math.min(1, fy - y0));
        const c00 = tile.val[y0 * tile.W + x0];
        const c01 = tile.val[y0 * tile.W + x1];
        const c10 = tile.val[y1 * tile.W + x0];
        const c11 = tile.val[y1 * tile.W + x1];
        if (!Number.isFinite(c00) || !Number.isFinite(c01)
            || !Number.isFinite(c10) || !Number.isFinite(c11)) continue;
        const value = c00 * (1 - ax) * (1 - ay) + c01 * ax * (1 - ay)
                    + c10 * (1 - ax) * ay + c11 * ax * ay;
        if (!Number.isFinite(value)) continue;

        const sx3857 = (pixX / dataWorldPx) * WORLD_EXT_3857 - HALF_MERCATOR;
        const sy3857 = HALF_MERCATOR - (pixY / dataWorldPx) * WORLD_EXT_3857;
        labels.push({ x3857: sx3857, y3857: sy3857, text: format(value) });
      }
    }
    return { labels, allLoaded };
  }

  function runRecompute(): void {
    if (!latestSnapshot) return;
    pending = true;
    try {
      const snap = latestSnapshot;
      const vKey = snapKey(snap);
      const { labels, allLoaded } = computeFreshLabels(snap);
      // Only swap the stash when EVERY visible tile is loaded — otherwise
      // we'd render a half-filled lattice and the next tile load would
      // shuffle the visible label set. Tile-load completion calls
      // layer.changed() → render() re-schedules until allLoaded sticks.
      if (allLoaded) {
        stash = labels;
        lastComputedKey = vKey;
        layer?.changed();
      }
    } finally {
      pending = false;
    }
  }

  function render(frameState: FrameState): HTMLElement {
    const [W, H] = frameState.size;
    const dpr = frameState.pixelRatio;
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw; canvas.height = bh;
    }
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    // Snapshot the live view for the next recompute. We deliberately do
    // NOT use frameState's transforms inside recompute — recompute derives
    // its own 3857 viewport from center + resolution + size, which keeps
    // the lattice math independent of any timing race between render and
    // the debounced setTimeout firing.
    latestSnapshot = {
      zoom: frameState.viewState.zoom,
      center: [frameState.viewState.center[0], frameState.viewState.center[1]],
      resolution: frameState.viewState.resolution,
      size: [W, H],
    };

    // Draw the stash via the LIVE coordinateToPixelTransform — labels
    // stored at fixed 3857 positions move with the basemap through any
    // pan / zoom because the transform tracks both. This is what makes
    // the labels stable during a zoom animation (no diagonal drift):
    // we never recompute the lattice mid-animation, only re-project.
    ctx.strokeStyle = textHaloColor;
    ctx.lineWidth = textHaloWidth;
    ctx.fillStyle = textColor;
    for (const lb of stash) {
      const px: [number, number] = [lb.x3857, lb.y3857];
      applyTransform(frameState.coordinateToPixelTransform, px);
      const cx = px[0], cy = px[1];
      // Skip only labels well outside the canvas (other world copies,
      // labels that have fully slid off during a pan). Canvas2D clips
      // anything still drawn so partial labels at the edge are fine.
      if (cx < -DRAW_BUFFER_PX || cx > W + DRAW_BUFFER_PX
          || cy < -DRAW_BUFFER_PX || cy > H + DRAW_BUFFER_PX) continue;
      ctx.strokeText(lb.text, cx, cy);
      ctx.fillText(lb.text, cx, cy);
    }

    // Schedule a recompute when the view differs from the last successful
    // one. First render fires immediately (0 ms) so labels appear ASAP;
    // subsequent changes debounce so a zoom animation produces one
    // recompute at the end, not one per intermediate frame.
    const vKey = snapKey(latestSnapshot);
    if (vKey !== lastComputedKey && !pending) {
      if (debounceTimer != null) clearTimeout(debounceTimer);
      const delay = lastComputedKey === null ? 0 : RECOMPUTE_DEBOUNCE_MS;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        runRecompute();
      }, delay);
    }

    return canvas;
  }

  layer = new Layer({
    zIndex: opts.zIndex ?? 700,
    render,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (layer as any).applyOptions = (p: any) => {
    if (p.targetAcross != null) targetAcross = p.targetAcross;
    if (p.digits != null) {
      digits = p.digits;
      if (!customFormat) format = (v: number) => v.toFixed(digits);
    }
    if (p.format != null) {
      format = p.format;
      customFormat = true;
    }
    if (p.opacity != null) layer!.setOpacity(p.opacity);
    layer!.changed();
  };
  return layer;
}

function fromItem(opts: MercatorValueLabelsLayerOpts, item: DiscoveredItem): Layer {
  return buildLayer(opts, item);
}

async function create(opts: MercatorValueLabelsLayerOpts): Promise<Layer> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorValueLabelsLayer = { create, fromItem };
