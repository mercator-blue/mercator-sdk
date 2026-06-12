/**
 * OpenLayers binding — direction arrows for `vector_rg_ba` datasets
 * (wind, currents, …). One arrow per (subsampled) source pixel in the
 * viewport, length and colour both scaled by speed magnitude.
 *
 * Architecture mirrors `value-labels-layer.ts`:
 *
 *   1. `loadTile()` co-fetches the data PNG + optional landmask PNG at
 *      the same z/x/y, decodes via the WebGL pixel reader, and emits
 *      parallel Float32 u/v arrays (separate from the value-labels
 *      layer, which collapses to a scalar magnitude — arrows need the
 *      direction). NaN sentinels: `(0,0,0,0)` and landmask-rejected
 *      pixels.
 *   2. `runRecompute()` walks a viewport-tied lattice at `z_data =
 *      min(floor(viewZoom), maxzoom)`, bilinear-samples u/v at each
 *      lattice point, computes the speed magnitude, and stores
 *      `{ x3857, y3857, u, v, speed }` per arrow. Only the TAIL is
 *      stored — the shaft + wings are computed in screen space at
 *      render time, so the arrow stays a uniform-length glyph
 *      regardless of mercator distortion (Leaflet's binding does the
 *      geometry in lng/lat which bends arrows visibly at high latitude).
 *   3. **Debounced recompute** + **3857-stored stash** + **live-c2p
 *      reprojection each frame** — same rationale as the value-labels
 *      layer: a per-frame recompute would slide the lattice anchor
 *      between frames during a zoom animation and the arrows would
 *      drift relative to the basemap; the debounce pins the lattice
 *      until the view settles.
 *
 * Overzoom past `maxzoom`: `pxStep` falls below 1 data pixel and the
 * lattice samples the maxzoom tile at sub-pixel positions, giving a
 * smooth bilinear-interpolated field at finer screen density.
 */

import Layer from 'ol/layer/Layer.js';
import { apply as applyTransform } from 'ol/transform.js';
import type { FrameState } from 'ol/Map.js';

import { loadTilePixels } from '../core/tile-pixel-reader';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, absolutiseUrl, expandTileUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import { resolveColormap, sampleColormapCss } from '../core/color/colormaps';
import type { ColormapSpec, MercatorArrowsOptions } from '../core/types';

import { HALF_MERCATOR, WORLD_EXT_3857 } from '../core/mercator';

const TARGET_ARROWS_ACROSS = 30;
const RECOMPUTE_DEBOUNCE_MS = 150;
// Arrows extend ~`shaftLenPx + headLenPx` from the tail; the draw buffer
// must comfortably exceed that so an arrow whose tail is at the canvas
// edge still gets its tip drawn.
const DRAW_BUFFER_PX = 96;
const DEFAULT_SPEED_REF_MS = 15;
const MIN_LEN_FRAC = 0.18;
const MIN_SPEED = 0.05;
const DEFAULT_LINE_WIDTH_CSS_PX = 1.5;
// Shaft length as a fraction of the lattice cell width (so adjacent
// arrows don't overlap at maximum speed). Head length as a fraction of
// the shaft.
const SHAFT_FRAC = 0.85;
const HEAD_FRAC = 0.35;
const WING_HALF_ANGLE = 0.45; // radians

/** OpenLayers-specific extras on top of the cross-binding
 *  {@link MercatorArrowsOptions}. */
export type MercatorArrowsLayerOpts = MercatorArrowsOptions & {
  /** Approx. number of arrows across the viewport. Default 30. */
  targetAcross?: number;
  /** Minimum speed (m/s) to render an arrow. Default 0.05. */
  minSpeed?: number;
  /** Landmask tile URL template. Defaults to the dataset's
   *  `mercator:landmask.url_template`. */
  landmaskUrlTemplate?: string;
  /** Mask bytes treated as valid. Defaults to STAC's `landmask.accepts`. */
  landmaskAccepts?: number[];
  /** OL layer z-index. Default 600. */
  zIndex?: number;
};

type LoadedTile = { status: 'loaded'; u: Float32Array; v: Float32Array; W: number; H: number };
type LoadingTile = { status: 'loading'; promise: Promise<LoadedTile> };
type ErrorTile = { status: 'error' };
type TileCacheEntry = LoadedTile | LoadingTile | ErrorTile;

interface StashArrow {
  x3857: number; y3857: number;
  u: number; v: number;
  speed: number;
}

interface ViewSnapshot {
  zoom: number;
  center: [number, number];
  resolution: number;
  size: [number, number];
}

function snapKey(s: ViewSnapshot): string {
  return `${s.zoom}|${s.center[0]}|${s.center[1]}|${s.size[0]}|${s.size[1]}`;
}

function buildLayer(opts: MercatorArrowsLayerOpts, item: DiscoveredItem): Layer {
  if (item.encoding.kind !== 'vector_rg_ba') {
    throw new Error(
      `@mercator-blue/sdk/openlayers: MercatorArrowsLayer requires a ` +
      `vector_rg_ba encoding; got "${item.encoding.kind}".`,
    );
  }

  const maxzoom = item.tile.maxzoom;
  const targetAcross = opts.targetAcross ?? TARGET_ARROWS_ACROSS;
  let speedRef = opts.speedRef ?? item.visualization?.vmax ?? DEFAULT_SPEED_REF_MS;
  let lineWidth = opts.lineWidth ?? DEFAULT_LINE_WIDTH_CSS_PX;
  const minSpeed = opts.minSpeed ?? MIN_SPEED;
  let palette = resolveColormap(opts.colormap ?? item.visualization?.colormap ?? 'viridis');

  const tileUrlTemplate = withApiKey(`${item.itemBase}/{z}/{x}/{y}.png`, opts.apiKey);
  const lmTemplate = opts.landmaskUrlTemplate ?? item.landmask?.url_template;
  const landmaskUrlTemplate = lmTemplate
    ? withApiKey(absolutiseUrl(lmTemplate, item.itemBase), opts.apiKey)
    : undefined;
  const lmAccepts = opts.landmaskAccepts ?? item.landmask?.accepts;
  const landmaskAccepts = lmAccepts ? new Set(lmAccepts) : null;

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
  let stash: StashArrow[] = [];
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
      // 'error' — fall through and retry below.
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
      const u = new Float32Array(W * H);
      const v = new Float32Array(W * H);
      const sc = item.encoding.scale, off = item.encoding.offset;
      const maskBytes = maskPx?.pixels;
      const useMask = !!(maskBytes && maskBytes.length === W * H * 4 && landmaskAccepts);
      for (let i = 0; i < W * H; i++) {
        const r = data[i * 4], g = data[i * 4 + 1];
        const b = data[i * 4 + 2], a = data[i * 4 + 3];
        if ((r | g | b | a) === 0) { u[i] = NaN; v[i] = NaN; continue; }
        if (useMask && !landmaskAccepts!.has(maskBytes![i * 4])) {
          u[i] = NaN; v[i] = NaN; continue;
        }
        u[i] = (r * 256 + g) * sc + off;
        v[i] = (b * 256 + a) * sc + off;
      }
      const loaded: LoadedTile = { status: 'loaded', u, v, W, H };
      cache.set(key, loaded);
      layer?.changed();
      return loaded;
    })();
    cache.set(key, { status: 'loading', promise });
    promise.catch(() => cache.set(key, { status: 'error' }));
    return null;
  }

  function computeFreshArrows(snap: ViewSnapshot): { arrows: StashArrow[]; allLoaded: boolean } {
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

    const arrows: StashArrow[] = [];
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
        const w00 = (1 - ax) * (1 - ay);
        const w01 = ax * (1 - ay);
        const w10 = (1 - ax) * ay;
        const w11 = ax * ay;
        const i00 = y0 * tile.W + x0;
        const i01 = y0 * tile.W + x1;
        const i10 = y1 * tile.W + x0;
        const i11 = y1 * tile.W + x1;
        const u00 = tile.u[i00], u01 = tile.u[i01], u10 = tile.u[i10], u11 = tile.u[i11];
        const v00 = tile.v[i00], v01 = tile.v[i01], v10 = tile.v[i10], v11 = tile.v[i11];
        if (!Number.isFinite(u00) || !Number.isFinite(u01)
            || !Number.isFinite(u10) || !Number.isFinite(u11)) continue;
        const u = u00 * w00 + u01 * w01 + u10 * w10 + u11 * w11;
        const v = v00 * w00 + v01 * w01 + v10 * w10 + v11 * w11;
        const speed = Math.sqrt(u * u + v * v);
        if (!Number.isFinite(speed) || speed < minSpeed) continue;

        const sx3857 = (pixX / dataWorldPx) * WORLD_EXT_3857 - HALF_MERCATOR;
        const sy3857 = HALF_MERCATOR - (pixY / dataWorldPx) * WORLD_EXT_3857;
        arrows.push({ x3857: sx3857, y3857: sy3857, u, v, speed });
      }
    }
    return { arrows, allLoaded };
  }

  function runRecompute(): void {
    if (!latestSnapshot) return;
    pending = true;
    try {
      const snap = latestSnapshot;
      const vKey = snapKey(snap);
      const { arrows, allLoaded } = computeFreshArrows(snap);
      if (allLoaded) {
        stash = arrows;
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

    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    latestSnapshot = {
      zoom: frameState.viewState.zoom,
      center: [frameState.viewState.center[0], frameState.viewState.center[1]],
      resolution: frameState.viewState.resolution,
      size: [W, H],
    };

    // Arrow shaft length scales with viewport (constant fraction of cell
    // width) so the on-screen size stays stable across zoom levels. The
    // lattice is rebuilt on viewport change, so the cell width tracks
    // the canvas width / targetAcross, which is in CSS pixels and
    // therefore zoom-invariant in screen-space.
    const shaftLenPxMax = (W / targetAcross) * SHAFT_FRAC;
    const headLenPxMax = shaftLenPxMax * HEAD_FRAC;

    // Project + draw stash via the live transform. World-anchored tails
    // move with the basemap during pan/zoom; the screen-space shaft +
    // wings are recomputed each frame from the projected tail.
    for (const a of stash) {
      const tail: [number, number] = [a.x3857, a.y3857];
      applyTransform(frameState.coordinateToPixelTransform, tail);
      const cx = tail[0], cy = tail[1];
      if (cx < -DRAW_BUFFER_PX || cx > W + DRAW_BUFFER_PX
          || cy < -DRAW_BUFFER_PX || cy > H + DRAW_BUFFER_PX) continue;

      // u east, v north → screen direction (u, -v) because canvas y is
      // down. Length scales with speed/speedRef, floored at MIN_LEN_FRAC.
      const ndu = a.u / a.speed;
      const ndv = a.v / a.speed;
      const lenFrac = Math.max(MIN_LEN_FRAC, Math.min(1, a.speed / speedRef));
      const shaftLen = shaftLenPxMax * lenFrac;
      const headLen = headLenPxMax * lenFrac;
      const tipX = cx + ndu * shaftLen;
      const tipY = cy - ndv * shaftLen;
      // angle of the shaft in screen space; wings point BACK from the
      // tip at ±WING_HALF_ANGLE off the reverse direction.
      const angle = Math.atan2(-ndv, ndu);
      const aL = angle + Math.PI - WING_HALF_ANGLE;
      const aR = angle + Math.PI + WING_HALF_ANGLE;
      const wingLX = tipX + Math.cos(aL) * headLen;
      const wingLY = tipY + Math.sin(aL) * headLen;
      const wingRX = tipX + Math.cos(aR) * headLen;
      const wingRY = tipY + Math.sin(aR) * headLen;

      ctx.strokeStyle = sampleColormapCss(palette, a.speed / speedRef);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tipX, tipY);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(wingLX, wingLY);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(wingRX, wingRY);
      ctx.stroke();
    }

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
    zIndex: opts.zIndex ?? 600,
    render,
  });

  // Public runtime setters. setColormap/setSpeedRef just trigger a redraw
  // (the speed values stored in the stash are still valid; the colour
  // ramp + length-saturation point are read at render time). setLineWidth
  // is a single Canvas2D state change per frame.
  const l = layer as Layer & {
    setColormap: (s: ColormapSpec) => void;
    setSpeedRef: (n: number) => void;
    setLineWidth: (n: number) => void;
  };
  l.setColormap = (spec: ColormapSpec) => {
    palette = resolveColormap(spec);
    layer?.changed();
  };
  l.setSpeedRef = (n: number) => {
    speedRef = n;
    layer?.changed();
  };
  l.setLineWidth = (n: number) => {
    lineWidth = n;
    layer?.changed();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (l as any).applyOptions = (p: any) => {
    if (p.opacity != null) layer.setOpacity(p.opacity);
    if (p.colormap != null) l.setColormap(p.colormap);
    if (p.speedRef != null) l.setSpeedRef(p.speedRef);
    if (p.lineWidth != null) l.setLineWidth(p.lineWidth);
  };
  return layer;
}

function fromItem(opts: MercatorArrowsLayerOpts, item: DiscoveredItem): Layer {
  return buildLayer(opts, item);
}

async function create(opts: MercatorArrowsLayerOpts): Promise<Layer> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorArrowsLayer = { create, fromItem };
