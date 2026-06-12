/**
 * Leaflet binding — direction arrows overlay for vector_rg_ba datasets
 * (wind, currents, …). One arrow per (subsampled) source pixel in the
 * viewport, length and colour both scaled by speed magnitude.
 *
 * Rendering: a single absolutely-positioned 2D canvas. Arrow lattice is
 * computed once per moveend / zoomend on the CPU (tile bytes decoded
 * into Float32 u/v arrays, bilinear or single-sample interpolation per
 * lattice point — same two-regime logic as the Mapbox/MapLibre binding).
 * During pan, the canvas rides with `mapPane`'s CSS translate so arrows
 * stay world-anchored. We do NOT listen to `move`: re-projecting and
 * re-stroking all arrows per pan frame would be wasted work — Mapbox's
 * shader version does effectively the same, projecting cached vertices
 * each frame instead of rebuilding them.
 *
 * Zoom anim mirrors the raster layer (`_getNewPixelOrigin`-based scale
 * transform; transition cleared at the top of `_reset` so the post-zoom
 * `setPosition` doesn't trigger a "shrink back" animation).
 *
 * Lattice math + the two MIN_BASE_LEN_DEG / arrowsAcross regimes are
 * copied verbatim from `src/mapbox/arrows-overlay.ts`. See that file for
 * the precision-floor + single-sample-at-overzoom rationale.
 */

import {
  lngToTileX,
  latToTileY,
  tilePixelToLngLat,
} from '../core/mercator';
import { loadTilePixels } from '../core/tile-pixel-reader';
import { resolveColormap, sampleColormapCss } from '../core/colormaps';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, absolutiseUrl, expandTileUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import type { ColormapSpec, MercatorArrowsOptions } from '../core/types';

const TARGET_ARROWS_ACROSS = 30;
const DEFAULT_SPEED_REF_MS = 15;
const MIN_LEN_FRAC = 0.18;
const MIN_BASE_LEN_DEG = 1e-3;
const MIN_SPEED = 0.05;
const DEFAULT_LINE_WIDTH_CSS_PX = 1.5;


/** Leaflet-specific extras on top of the cross-binding
 *  {@link MercatorArrowsOptions}. */
export type MercatorArrowsLayerOpts = MercatorArrowsOptions & {
  /** Minimum speed (m/s) to render an arrow. Default 0.05 — drops the
   *  forest of zero-length stubs in calm regions. */
  minSpeed?: number;
  /** Landmask tile URL template. Defaults to the dataset's
   *  `mercator:landmask.url_template`; pass to override. */
  landmaskUrlTemplate?: string;
  /** Mask category bytes treated as valid. Defaults to the dataset's
   *  `mercator:landmask.accepts`. */
  landmaskAccepts?: number[];
  /** Leaflet pane. Default 'overlayPane'. */
  pane?: string;
};

type LoadedTile = { status: 'loaded'; u: Float32Array; v: Float32Array; W: number; H: number };
type LoadingTile = { status: 'loading'; promise: Promise<LoadedTile> };
type ErrorTile = { status: 'error' };
type TileCacheEntry = LoadedTile | LoadingTile | ErrorTile;
type TileCache = Map<string, TileCacheEntry>;

interface Arrow {
  tailLng: number; tailLat: number;
  tipLng: number; tipLat: number;
  wingLLng: number; wingLLat: number;
  wingRLng: number; wingRLat: number;
  speed: number;
}

function getL(): any {
  const L = (globalThis as any).L;
  if (!L || !L.Layer) {
    throw new Error(
      '@mercator-blue/sdk/leaflet: Leaflet not found on `globalThis.L`. ' +
      'Load Leaflet before importing the SDK.',
    );
  }
  return L;
}

async function loadTile(
  cache: TileCache,
  tileUrlTemplate: string,
  encoding: { scale: number; offset: number },
  z: number, x: number, y: number,
  landmaskUrlTemplate: string | undefined,
  landmaskAccepts: Set<number> | null,
): Promise<LoadedTile> {
  const key = `${z}/${x}/${y}`;
  const existing = cache.get(key);
  if (existing) {
    if (existing.status === 'loading') return existing.promise;
    if (existing.status === 'loaded') return existing;
    // 'error' — fall through and retry.
  }
  const promise = (async (): Promise<LoadedTile> => {
    const url = expandTileUrl(tileUrlTemplate, z, x, y);
    // Co-fetch the landmask tile at the same z/x/y. A 404 (mask pyramid
    // shallower than the data, or no mask configured) resolves to null
    // and the tile decodes mask-free — same as the Mapbox arrows binding.
    const maskUrl = landmaskUrlTemplate
      ? expandTileUrl(landmaskUrlTemplate, z, x, y)
      : null;
    const [dataPx, maskPx] = await Promise.all([
      loadTilePixels(url),
      maskUrl ? loadTilePixels(maskUrl).catch(() => null) : Promise.resolve(null),
    ]);
    const { width: W, height: H, pixels: data } = dataPx;
    const u = new Float32Array(W * H);
    const v = new Float32Array(W * H);
    const sc = encoding.scale, off = encoding.offset;
    const maskBytes = maskPx?.pixels;
    const useMask = !!(maskBytes && maskBytes.length === W * H * 4 && landmaskAccepts);
    for (let i = 0; i < W * H; i++) {
      const r = data[i * 4], g = data[i * 4 + 1];
      const b = data[i * 4 + 2], a = data[i * 4 + 3];
      // (0,0,0,0) is the canonical NaN sentinel for vector_rg_ba.
      if ((r | g | b | a) === 0) { u[i] = NaN; v[i] = NaN; continue; }
      // Land pixel → NaN so no arrow is built here. Mask byte is in R.
      if (useMask && !landmaskAccepts!.has(maskBytes![i * 4])) {
        u[i] = NaN; v[i] = NaN; continue;
      }
      u[i] = (r * 256 + g) * sc + off;
      v[i] = (b * 256 + a) * sc + off;
    }
    const loaded: LoadedTile = { status: 'loaded', u, v, W, H };
    cache.set(key, loaded);
    return loaded;
  })();
  cache.set(key, { status: 'loading', promise });
  promise.catch(() => cache.set(key, { status: 'error' }));
  return promise;
}

/** Sample a `Float32Array` 16-stop colormap at t ∈ [0,1]. Returns an
 *  `rgb(…)` string ready for Canvas2D `strokeStyle`. */
let LayerClass: any = null;

function ensureLayerClass(): any {
  if (LayerClass) return LayerClass;
  const L = getL();

  LayerClass = L.Layer.extend({
    initialize(this: any, opts: any) {
      L.setOptions(this, opts);
      this._item = opts.item as DiscoveredItem;
      this._apiKey = opts.apiKey as string | undefined;
      this._tileUrlTemplate = withApiKey(
        `${this._item.itemBase}/{z}/{x}/{y}.png`,
        this._apiKey,
      );

      if (this._item.encoding.kind !== 'vector_rg_ba') {
        throw new Error(
          `@mercator-blue/sdk/leaflet: MercatorArrowsLayer requires a vector_rg_ba encoding; ` +
          `got "${this._item.encoding.kind}".`,
        );
      }

      this._lockZoom = opts.lockZoom;
      this._maxzoom = this._item.tile.maxzoom;
      this._speedRef = opts.speedRef ?? this._item.visualization?.vmax ?? DEFAULT_SPEED_REF_MS;
      this._lineWidth = opts.lineWidth ?? DEFAULT_LINE_WIDTH_CSS_PX;
      this._minSpeed = opts.minSpeed ?? MIN_SPEED;

      const cmSpec = opts.colormap ?? this._item.visualization?.colormap ?? 'viridis';
      this._palette = resolveColormap(cmSpec);

      // Landmask: prefer an explicit opt, else the dataset's STAC entry.
      // The item template is a relative path → absolutise against the item
      // base, then append the API key (same code path as the data tiles).
      const lmTemplate = opts.landmaskUrlTemplate ?? this._item.landmask?.url_template;
      this._landmaskUrlTemplate = lmTemplate
        ? withApiKey(absolutiseUrl(lmTemplate, this._item.itemBase), this._apiKey)
        : undefined;
      const lmAccepts = opts.landmaskAccepts ?? this._item.landmask?.accepts;
      this._landmaskAccepts = lmAccepts ? new Set(lmAccepts) : null;

      this._cache = new Map() as TileCache;
      this._arrows = [] as Arrow[];
      this._pending = false;
      this._queued = false;
    },

    onAdd(this: any, map: any): any {
      this._map = map;
      const pane = (this.options.pane as string) ?? 'overlayPane';
      const paneEl = map.getPane(pane);

      const canvas = L.DomUtil.create('canvas', 'mercator-arrows-layer') as HTMLCanvasElement;
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      // Between raster (200) and tile-boundaries (300).
      canvas.style.zIndex = '250';
      canvas.style.transformOrigin = '0 0';
      paneEl.appendChild(canvas);
      this._canvas = canvas;
      this._ctx = canvas.getContext('2d');

      // No `move` listener — see file-level comment. Arrows are world-
      // anchored via `mapPane`'s CSS translate during pan; we rebuild on
      // moveend / zoomend, the same cadence the Mapbox/MapLibre binding
      // uses.
      map.on('moveend', this._onMoveEnd, this);
      map.on('zoomanim', this._onZoomAnim, this);
      map.on('zoomend', this._onZoomEnd, this);
      map.on('viewreset', this._onReset, this);
      map.on('resize', this._onReset, this);

      this._reset();
      return this;
    },

    onRemove(this: any, map: any): any {
      map.off('moveend', this._onMoveEnd, this);
      map.off('zoomanim', this._onZoomAnim, this);
      map.off('zoomend', this._onZoomEnd, this);
      map.off('viewreset', this._onReset, this);
      map.off('resize', this._onReset, this);

      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      this._canvas = null;
      this._ctx = null;
      this._map = null;
      this._cache.clear();
      return this;
    },

    _onZoomAnim(this: any, opts: any): void {
      const map = this._map;
      if (!map || !this._canvas) return;
      this._canvas.style.transition = 'transform 250ms cubic-bezier(0,0,0.25,1)';
      const scale = map.getZoomScale(opts.zoom, this._anchorZoom);
      const newOrigin = map._getNewPixelOrigin(opts.center, opts.zoom);
      const newTlLayerX = this._anchorPixelX * scale - newOrigin.x;
      const newTlLayerY = this._anchorPixelY * scale - newOrigin.y;
      L.DomUtil.setTransform(this._canvas, L.point(newTlLayerX, newTlLayerY), scale);
    },
    _onZoomEnd(this: any): void {
      if (this._canvas) this._canvas.style.transition = '';
      this._reset();
    },
    _onMoveEnd(this: any): void { this._reset(); },
    _onReset(this: any): void { this._reset(); },

    /** Re-anchor canvas, render existing arrows (instant), kick async
     *  rebuild for the new viewport. */
    _reset(this: any): void {
      const map = this._map;
      if (!map || !this._canvas) return;

      // Clear in-flight zoom-anim transition before `setPosition` rewrites
      // transform — same reason as the raster + tile-boundaries layers.
      this._canvas.style.transition = '';

      const size = map.getSize();
      const canvas: HTMLCanvasElement = this._canvas;
      const dpr = (globalThis.devicePixelRatio ?? 1);

      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
        canvas.width = Math.round(size.x * dpr);
        canvas.height = Math.round(size.y * dpr);
      }

      const topLeftLayer = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeftLayer);

      const origin = map.getPixelOrigin();
      this._anchorPixelX = topLeftLayer.x + origin.x;
      this._anchorPixelY = topLeftLayer.y + origin.y;
      this._anchorZoom = map.getZoom();

      // Render with whatever arrows we already have (may be stale or
      // empty) so the user sees something immediately; rebuild fills in
      // the actual content for the new viewport.
      this._render();
      void this._recompute();
    },

    /** Async — load any missing tiles for the visible viewport, then
     *  build the arrow lattice. Coalesces concurrent calls. */
    async _recompute(this: any): Promise<void> {
      if (this._pending) { this._queued = true; return; }
      this._pending = true;
      try {
        const map = this._map;
        if (!map) return;
        const item: DiscoveredItem = this._item;

        const z = this._lockZoom != null
          ? Math.max(0, Math.min(this._maxzoom, this._lockZoom))
          : Math.max(0, Math.min(this._maxzoom, Math.floor(map.getZoom())));
        const n = 2 ** z;

        const bounds = map.getBounds();
        const wLng = bounds.getWest(), eLng = bounds.getEast();
        const nLat = bounds.getNorth(), sLat = bounds.getSouth();

        const txMin = Math.floor(lngToTileX(wLng, z));
        const txMax = Math.floor(lngToTileX(eLng, z));
        const tyMin = Math.max(0, Math.floor(latToTileY(nLat, z)));
        const tyMax = Math.min(n - 1, Math.floor(latToTileY(sLat, z)));

        const tilePromises: Promise<LoadedTile | null>[] = [];
        for (let tx = txMin; tx <= txMax; tx++) {
          for (let ty = tyMin; ty <= tyMax; ty++) {
            const wrappedTx = ((tx % n) + n) % n;
            tilePromises.push(
              loadTile(
                this._cache, this._tileUrlTemplate, item.encoding, z, wrappedTx, ty,
                this._landmaskUrlTemplate, this._landmaskAccepts,
              ).catch(() => null),
            );
          }
        }
        await Promise.all(tilePromises);
        // If the map went away during the fetch (layer removed), bail.
        if (!this._map) return;

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
          arrowsAcross = Math.max(0, Math.floor((eLng - wLng) * 0.85 / MIN_BASE_LEN_DEG));
        }

        if (arrowsAcross === 0) {
          this._arrows = [];
          this._render();
          return;
        }

        const pxStep = Math.max(1e-6, dataPxViewportWidth / arrowsAcross);
        const halfStep = pxStep * 0.5;

        // Two sampling regimes; see Mapbox version for the rationale.
        const useSingleSample = dataPxViewportWidth < 1 || dataPxViewportHeight < 1;
        const startX = Math.floor(dataPxLeft / pxStep) * pxStep + halfStep;
        const startY = Math.floor(dataPxTop / pxStep) * pxStep + halfStep;

        let singleU = NaN, singleV = NaN;
        if (useSingleSample) {
          const centerPxX = (dataPxLeft + dataPxRight) * 0.5;
          const centerPxY = (dataPxTop + dataPxBottom) * 0.5;
          const cTx = Math.floor(centerPxX / 256);
          const cTy = Math.floor(centerPxY / 256);
          if (cTy >= 0 && cTy < n) {
            const cWrappedTx = ((cTx % n) + n) % n;
            const cTile = this._cache.get(`${z}/${cWrappedTx}/${cTy}`);
            if (cTile && cTile.status === 'loaded') {
              const cFx = Math.max(0, Math.min(cTile.W - 1, Math.floor(centerPxX - cTx * 256)));
              const cFy = Math.max(0, Math.min(cTile.H - 1, Math.floor(centerPxY - cTy * 256)));
              const cI = cFy * cTile.W + cFx;
              singleU = cTile.u[cI];
              singleV = cTile.v[cI];
            }
          }
        }

        const arrows: Arrow[] = [];
        for (let pixY = startY; pixY < dataPxBottom + halfStep; pixY += pxStep) {
          const ty = Math.floor(pixY / 256);
          if (ty < 0 || ty >= n) continue;
          const fyAbs = pixY - ty * 256;
          for (let pixX = startX; pixX < dataPxRight + halfStep; pixX += pxStep) {
            const tx = Math.floor(pixX / 256);
            const wrappedTx = ((tx % n) + n) % n;
            const tile = this._cache.get(`${z}/${wrappedTx}/${ty}`);
            if (!tile || tile.status !== 'loaded') continue;
            const fxAbs = pixX - tx * 256;

            let u: number, v: number;
            if (useSingleSample) {
              u = singleU;
              v = singleV;
            } else {
              const x0 = Math.max(0, Math.min(tile.W - 1, Math.floor(fxAbs)));
              const y0 = Math.max(0, Math.min(tile.H - 1, Math.floor(fyAbs)));
              const x1 = Math.min(tile.W - 1, x0 + 1);
              const y1 = Math.min(tile.H - 1, y0 + 1);
              const ax = Math.max(0, Math.min(1, fxAbs - x0));
              const ay = Math.max(0, Math.min(1, fyAbs - y0));
              const w00 = (1 - ax) * (1 - ay);
              const w01 = ax * (1 - ay);
              const w10 = (1 - ax) * ay;
              const w11 = ax * ay;
              const i00 = y0 * tile.W + x0;
              const i01 = y0 * tile.W + x1;
              const i10 = y1 * tile.W + x0;
              const i11 = y1 * tile.W + x1;
              u = tile.u[i00] * w00 + tile.u[i01] * w01 + tile.u[i10] * w10 + tile.u[i11] * w11;
              v = tile.v[i00] * w00 + tile.v[i01] * w01 + tile.v[i10] * w10 + tile.v[i11] * w11;
            }
            const speed = Math.sqrt(u * u + v * v);
            if (!Number.isFinite(speed) || speed < this._minSpeed) continue;

            const [lng0, lat0] = tilePixelToLngLat(z, tx, ty, fxAbs, fyAbs);
            const ndu = u / speed;
            const ndv = v / speed;
            const lenFrac = Math.max(MIN_LEN_FRAC, Math.min(1, speed / this._speedRef));
            const shaftLen = baseLenDeg * lenFrac;
            const headLen = shaftLen * 0.35;
            const tipLng = lng0 + ndu * shaftLen;
            const tipLat = lat0 + ndv * shaftLen;
            const angle = Math.atan2(ndv, ndu);
            const aL = angle + Math.PI - 0.45;
            const aR = angle + Math.PI + 0.45;
            arrows.push({
              tailLng: lng0, tailLat: lat0,
              tipLng, tipLat,
              wingLLng: tipLng + Math.cos(aL) * headLen,
              wingLLat: tipLat + Math.sin(aL) * headLen,
              wingRLng: tipLng + Math.cos(aR) * headLen,
              wingRLat: tipLat + Math.sin(aR) * headLen,
              speed,
            });
          }
        }

        this._arrows = arrows;
        this._render();
      } finally {
        this._pending = false;
        if (this._queued) { this._queued = false; void this._recompute(); }
      }
    },

    /** Project each arrow's endpoints via `latLngToContainerPoint` and
     *  stroke its 3 segments. Called from `_reset` (instant repaint at
     *  new anchor) and from `_recompute` after a successful rebuild. */
    _render(this: any): void {
      const map = this._map;
      const canvas: HTMLCanvasElement = this._canvas;
      const ctx: CanvasRenderingContext2D = this._ctx;
      if (!map || !canvas || !ctx) return;

      const dpr = (globalThis.devicePixelRatio ?? 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = this._lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const speedRef = this._speedRef;
      const palette = this._palette as Float32Array;
      const arrows = this._arrows as Arrow[];

      for (const a of arrows) {
        const tail = map.latLngToContainerPoint([a.tailLat, a.tailLng]);
        const tip = map.latLngToContainerPoint([a.tipLat, a.tipLng]);
        const wingL = map.latLngToContainerPoint([a.wingLLat, a.wingLLng]);
        const wingR = map.latLngToContainerPoint([a.wingRLat, a.wingRLng]);

        ctx.strokeStyle = sampleColormapCss(palette, a.speed / speedRef);
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(wingL.x, wingL.y);
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(wingR.x, wingR.y);
        ctx.stroke();
      }
    },

    // ----- Public runtime setters -----
    setColormap(this: any, spec: ColormapSpec): void {
      this._palette = resolveColormap(spec);
      this._render();
    },
    setSpeedRef(this: any, ref: number): void {
      this._speedRef = ref;
      void this._recompute();
    },
    setLineWidth(this: any, w: number): void {
      this._lineWidth = w;
      this._render();
    },

    /** Apply a partial options patch. */
    applyOptions(this: any, p: any): void {
      if (p.colormap != null) this.setColormap(p.colormap);
      if (p.speedRef != null) this.setSpeedRef(p.speedRef);
      if (p.lineWidth != null) this.setLineWidth(p.lineWidth);
    },
  });

  return LayerClass;
}

function fromItem(opts: MercatorArrowsLayerOpts, item: DiscoveredItem): any {
  const Cls = ensureLayerClass();
  return new Cls({ ...opts, item });
}

async function create(opts: MercatorArrowsLayerOpts): Promise<any> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorArrowsLayer = { create, fromItem };
