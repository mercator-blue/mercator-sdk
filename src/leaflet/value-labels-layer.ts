/**
 * Leaflet binding — value-label overlay. Plots the decoded data value as
 * a NUMBER at each point of a viewport-derived lattice (the forecast-site
 * temperature-grid look). Scalar datasets (rg16_fixed) show the value;
 * vector datasets (vector_rg_ba) show the speed MAGNITUDE.
 *
 * Rendering: a single absolutely-positioned 2D canvas. The lattice +
 * tile-sampling machinery is the same as the arrows layer (global-anchored
 * lattice sized to ~TARGET_LABELS_ACROSS columns, bilinear sample of the
 * decoded float grid, NaN/landmask skip); the text drawing + collision
 * reject is the same as the contours layer (halo `strokeText` then
 * `fillText`, nearest-neighbour distance reject). The Mapbox/MapLibre
 * binding gets glyphs + collision for free from a `symbol` layer; Leaflet
 * has no equivalent, so both are hand-rolled here — simpler than Mapbox's
 * symbol engine but adequate for a Mercator-only overlay.
 *
 * Lifecycle mirrors the arrows / contours layers: rebuild on moveend /
 * zoomend (the canvas rides `mapPane`'s CSS translate during a pan), zoom
 * anim scale-transforms via `_getNewPixelOrigin`, transition cleared at
 * the top of `_reset`.
 */

import {
  lngToTileX,
  latToTileY,
  tilePixelToLngLat,
} from '../core/mercator';
import { loadTilePixels } from '../core/tile-pixel-reader';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, absolutiseUrl, expandTileUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import type { MercatorValueLabelsOptions } from '../core/types';


// Numbers are wider than an arrow glyph, so fewer across than the arrow
// lattice (30); the collision reject thins further.
const TARGET_LABELS_ACROSS = 18;
const MIN_LABEL_DIST_PX = 44;   // reject a label this close to a placed one
// How many CSS pixels beyond the canvas edge we still draw labels for.
// Match the OL binding (DRAW_BUFFER_PX = 64): an inward edge cull drops
// labels near the viewport boundary at rebuild time so they vanish well
// before reaching the edge; an outward cull lets them keep rendering
// (Canvas2D clips the part past the canvas naturally) until they're
// fully off-screen, which is the behavior the user expects.
const DRAW_BUFFER_PX = 64;

/** Leaflet-specific extras on top of the cross-binding
 *  {@link MercatorValueLabelsOptions}. */
export type MercatorValueLabelsLayerOpts = MercatorValueLabelsOptions & {
  /** Landmask tile URL template. Defaults to the dataset's
   *  `mercator:landmask.url_template`; pass to override. */
  landmaskUrlTemplate?: string;
  /** Mask category bytes treated as valid. Defaults to the dataset's
   *  `mercator:landmask.accepts`. */
  landmaskAccepts?: number[];
  /** Label fill colour. Default `#1a1a1a`. */
  textColor?: string;
  /** Label halo colour. Default `rgba(255, 255, 255, 0.9)`. */
  textHaloColor?: string;
  /** Label halo width, CSS px. Default 2.5. */
  textHaloWidth?: number;
  /** Canvas2D font shorthand. Default `600 12px sans-serif`. */
  font?: string;
  /** Leaflet pane. Default `overlayPane`. */
  pane?: string;
};

type LoadedTile = { status: 'loaded'; val: Float32Array; W: number; H: number };
type LoadingTile = { status: 'loading'; promise: Promise<LoadedTile> };
type ErrorTile = { status: 'error' };
type TileCacheEntry = LoadedTile | LoadingTile | ErrorTile;
type TileCache = Map<string, TileCacheEntry>;

interface Label { lng: number; lat: number; text: string }

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
  encoding: { kind: string; scale: number; offset: number },
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
    const maskUrl = landmaskUrlTemplate
      ? expandTileUrl(landmaskUrlTemplate, z, x, y)
      : null;
    const [dataPx, maskPx] = await Promise.all([
      loadTilePixels(url),
      maskUrl ? loadTilePixels(maskUrl).catch(() => null) : Promise.resolve(null),
    ]);
    const { width: W, height: H, pixels: data } = dataPx;
    const val = new Float32Array(W * H);
    const sc = encoding.scale, off = encoding.offset;
    const kind = encoding.kind;
    const maskBytes = maskPx?.pixels;
    const useMask = !!(maskBytes && maskBytes.length === W * H * 4 && landmaskAccepts);
    for (let i = 0; i < W * H; i++) {
      const r = data[i * 4], g = data[i * 4 + 1];
      const b = data[i * 4 + 2], a = data[i * 4 + 3];
      if (useMask && !landmaskAccepts!.has(maskBytes![i * 4])) { val[i] = NaN; continue; }
      if (kind === 'vector_rg_ba') {
        // (0,0,0,0) is the canonical NaN sentinel for vector_rg_ba.
        if ((r | g | b | a) === 0) { val[i] = NaN; continue; }
        const u = (r * 256 + g) * sc + off;
        const v = (b * 256 + a) * sc + off;
        val[i] = Math.sqrt(u * u + v * v);
      } else if (kind === 'mapbox_rgb') {
        // 24-bit signed integer (Mapbox Terrain-RGB style). Every pixel
        // is a valid altitude — no alpha-as-validity convention.
        val[i] = (r * 65536 + g * 256 + b) * sc + off;
      } else {
        // rg16_fixed: value in R+G, alpha = validity/coverage (0 = no
        // data). Decode to float here so the later bilinear sample
        // interpolates floats, not raw 16-bit channels.
        if (a === 0) { val[i] = NaN; continue; }
        val[i] = (r * 256 + g) * sc + off;
      }
    }
    const loaded: LoadedTile = { status: 'loaded', val, W, H };
    cache.set(key, loaded);
    return loaded;
  })();
  cache.set(key, { status: 'loading', promise });
  promise.catch(() => cache.set(key, { status: 'error' }));
  return promise;
}

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

      const kind = this._item.encoding.kind;
      if (kind !== 'rg16_fixed' && kind !== 'vector_rg_ba' && kind !== 'mapbox_rgb') {
        throw new Error(
          `@mercator-blue/sdk/leaflet: MercatorValueLabelsLayer supports ` +
          `rg16_fixed (scalar), vector_rg_ba (magnitude), and mapbox_rgb ` +
          `(elevation) encodings; got "${kind}".`,
        );
      }

      this._lockZoom = opts.lockZoom;
      this._maxzoom = this._item.tile.maxzoom;
      this._targetAcross = opts.targetAcross ?? TARGET_LABELS_ACROSS;

      // Default decimals: integers read cleanly for wide-range scalars and
      // fast vectors, but a field topping out in low single digits (ocean
      // currents) collapses to a wall of "0"/"1" at 0 digits — give those
      // one decimal. Driven by STAC vmax.
      const vmax = this._item.visualization?.vmax;
      const digits = opts.digits ?? (vmax != null && vmax < 10 ? 1 : 0);
      this._format = opts.format ?? ((v: number) => v.toFixed(digits));
      this._customFormat = opts.format != null;

      const lmTemplate = opts.landmaskUrlTemplate ?? this._item.landmask?.url_template;
      this._landmaskUrlTemplate = lmTemplate
        ? withApiKey(absolutiseUrl(lmTemplate, this._item.itemBase), this._apiKey)
        : undefined;
      const lmAccepts = opts.landmaskAccepts ?? this._item.landmask?.accepts;
      this._landmaskAccepts = lmAccepts ? new Set(lmAccepts) : null;

      this._textColor = opts.textColor ?? '#1a1a1a';
      this._textHaloColor = opts.textHaloColor ?? 'rgba(255, 255, 255, 0.9)';
      this._textHaloWidth = opts.textHaloWidth ?? 2.5;
      this._font = opts.font ?? '600 12px sans-serif';

      this._cache = new Map() as TileCache;
      this._labels = [] as Label[];
      this._pending = false;
      this._queued = false;
    },

    onAdd(this: any, map: any): any {
      this._map = map;
      const pane = (this.options.pane as string) ?? 'overlayPane';
      const paneEl = map.getPane(pane);

      const canvas = L.DomUtil.create('canvas', 'mercator-value-labels-layer') as HTMLCanvasElement;
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      // Above arrows (250) + contours (260), below tile-boundaries (300).
      // Numbers want to sit on top of the data layers.
      canvas.style.zIndex = '270';
      canvas.style.transformOrigin = '0 0';
      paneEl.appendChild(canvas);
      this._canvas = canvas;
      this._ctx = canvas.getContext('2d');

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

    _reset(this: any): void {
      const map = this._map;
      if (!map || !this._canvas) return;

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

      // Render whatever we already have (instant), then rebuild async.
      this._render();
      void this._recompute();
    },

    /** Async — load missing tiles for the viewport, build the label list. */
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
        if (!this._map) return;

        const dataPxLeft = lngToTileX(wLng, z) * 256;
        const dataPxRight = lngToTileX(eLng, z) * 256;
        const dataPxTop = latToTileY(nLat, z) * 256;
        const dataPxBottom = latToTileY(sLat, z) * 256;
        const dataPxViewportWidth = dataPxRight - dataPxLeft;

        const pxStep = Math.max(1, dataPxViewportWidth / this._targetAcross);
        const halfStep = pxStep * 0.5;
        const startX = Math.floor(dataPxLeft / pxStep) * pxStep + halfStep;
        const startY = Math.floor(dataPxTop / pxStep) * pxStep + halfStep;

        const labels: Label[] = [];
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

            // Bilinear sample the decoded float grid; skip if any corner
            // is NaN (no-data / land) so a coastline value isn't smeared.
            const x0 = Math.max(0, Math.min(tile.W - 1, Math.floor(fxAbs)));
            const y0 = Math.max(0, Math.min(tile.H - 1, Math.floor(fyAbs)));
            const x1 = Math.min(tile.W - 1, x0 + 1);
            const y1 = Math.min(tile.H - 1, y0 + 1);
            const ax = Math.max(0, Math.min(1, fxAbs - x0));
            const ay = Math.max(0, Math.min(1, fyAbs - y0));
            const i00 = y0 * tile.W + x0;
            const i01 = y0 * tile.W + x1;
            const i10 = y1 * tile.W + x0;
            const i11 = y1 * tile.W + x1;
            const c00 = tile.val[i00], c01 = tile.val[i01];
            const c10 = tile.val[i10], c11 = tile.val[i11];
            if (!Number.isFinite(c00) || !Number.isFinite(c01) ||
                !Number.isFinite(c10) || !Number.isFinite(c11)) continue;
            const value = c00 * (1 - ax) * (1 - ay) + c01 * ax * (1 - ay)
                        + c10 * (1 - ax) * ay + c11 * ax * ay;
            if (!Number.isFinite(value)) continue;

            const [lng, lat] = tilePixelToLngLat(z, tx, ty, fxAbs, fyAbs);
            labels.push({ lng, lat, text: this._format(value) });
          }
        }

        this._labels = labels;
        this._render();
      } finally {
        this._pending = false;
        if (this._queued) { this._queued = false; void this._recompute(); }
      }
    },

    /** Project each label to a container point and draw it (halo + fill),
     *  rejecting any that fall too close to an already-placed one. */
    _render(this: any): void {
      const map = this._map;
      const canvas: HTMLCanvasElement = this._canvas;
      const ctx: CanvasRenderingContext2D = this._ctx;
      if (!map || !canvas || !ctx) return;

      const dpr = (globalThis.devicePixelRatio ?? 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const size = map.getSize();
      const W = size.x, H = size.y;

      ctx.font = this._font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      const placed: Array<{ x: number; y: number }> = [];
      const tooClose = (x: number, y: number): boolean => {
        for (const p of placed) {
          const dx = p.x - x, dy = p.y - y;
          if (dx * dx + dy * dy < MIN_LABEL_DIST_PX * MIN_LABEL_DIST_PX) return true;
        }
        return false;
      };

      for (const lb of this._labels as Label[]) {
        const p = map.latLngToContainerPoint([lb.lat, lb.lng]);
        // Skip only labels well outside the canvas; Canvas2D clips text
        // that crosses the edge, so a label whose center is near (or
        // slightly past) the edge still shows the part inside the
        // viewport. The old inward 8 px margin dropped labels the user
        // could clearly still see, which is the reported regression.
        if (p.x < -DRAW_BUFFER_PX || p.x > W + DRAW_BUFFER_PX
            || p.y < -DRAW_BUFFER_PX || p.y > H + DRAW_BUFFER_PX) continue;
        if (tooClose(p.x, p.y)) continue;
        placed.push({ x: p.x, y: p.y });

        ctx.strokeStyle = this._textHaloColor;
        ctx.lineWidth = this._textHaloWidth;
        ctx.strokeText(lb.text, p.x, p.y);
        ctx.fillStyle = this._textColor;
        ctx.fillText(lb.text, p.x, p.y);
      }
    },

    /** Apply a partial options patch. */
    applyOptions(this: any, p: any): void {
      let needsRebuild = false;
      if (p.lockZoom !== undefined) { this._lockZoom = p.lockZoom; needsRebuild = true; }
      if (p.targetAcross != null) { this._targetAcross = p.targetAcross; needsRebuild = true; }
      if (p.digits != null) {
        // Replace the default toFixed-based formatter; if the customer
        // had a custom `format` callback, we don't touch it.
        if (!this._customFormat) {
          this._format = (v: number) => v.toFixed(p.digits);
        }
        needsRebuild = true;
      }
      if (p.format != null) {
        this._format = p.format;
        this._customFormat = true;
        needsRebuild = true;
      }
      if (needsRebuild) void this._recompute();
    },
  });

  return LayerClass;
}

function fromItem(opts: MercatorValueLabelsLayerOpts, item: DiscoveredItem): any {
  const Cls = ensureLayerClass();
  return new Cls({ ...opts, item });
}

async function create(opts: MercatorValueLabelsLayerOpts): Promise<any> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorValueLabelsLayer = { create, fromItem };
