/**
 * Leaflet binding — slippy-XYZ tile-boundary debug overlay. Magenta
 * dashed outline + "(x, y) z=N" label for every visible tile at the
 * current sampling zoom. Sits above the raster layer (z-index 300 vs
 * raster's 200) so the grid is always readable.
 *
 * Rendering: a single absolutely-positioned 2D canvas. Lines drawn via
 * `strokeRect`, labels via `strokeText` (halo) + `fillText` (fill).
 * Leaflet is Mercator-only and this is a debug overlay, so the
 * expanded-triangle WebGL pipeline the Mapbox/MapLibre binding has
 * would be overkill — Canvas2D matches the visual at a fraction of the
 * code.
 *
 * Lifecycle mirrors `MercatorRasterLayer`:
 *   - `setPosition(canvas, containerPointToLayerPoint([0,0]))` on every
 *     `move` so the canvas rides along with the basemap during pan.
 *   - During `zoomanim`: scale-transform via
 *     `map._getNewPixelOrigin(opts.center, opts.zoom)`. The `_get…`
 *     form is load-bearing post-pan — see the raster layer for the
 *     derivation. Text antialiasing briefly blurs during the 250ms
 *     scale, snaps back on `zoomend`. Acceptable for a debug overlay.
 */

import {
  lngToTileX,
  latToTileY,
  tileXToLng,
  tileYToLat,
} from '../core/mercator';
import type { MercatorTileBoundariesOptions } from '../core/types';

/** Leaflet-specific extras on top of the cross-binding
 *  {@link MercatorTileBoundariesOptions}. */
export type MercatorTileBoundariesLayerOpts = MercatorTileBoundariesOptions & {
  /** Dash pattern (Canvas2D `setLineDash`). Default `[4, 4]`; pass `[]` for solid. */
  lineDash?: number[];
  /** Line CSS colour. Default `#ff00ff`. */
  lineColor?: string;
  /** Label fill colour. Default `#ff00ff`. */
  textColor?: string;
  /** Label halo (outline) colour. Default `rgba(0, 0, 0, 0.75)`. */
  textHaloColor?: string;
  /** Label halo width in CSS pixels. Default 3. */
  textHaloWidth?: number;
  /** Canvas2D font shorthand for the label. Default `12px sans-serif`. */
  font?: string;
  /** Leaflet pane name. Default `overlayPane`. */
  pane?: string;
};

function getL(): any {
  const L = (globalThis as any).L;
  if (!L || !L.Layer) {
    throw new Error(
      '@mercator-blue/sdk/leaflet: Leaflet not found on `globalThis.L`. ' +
      'Load Leaflet (e.g. via <script src=".../leaflet.js">) before importing the SDK.',
    );
  }
  return L;
}

let LayerClass: any = null;

function ensureLayerClass(): any {
  if (LayerClass) return LayerClass;
  const L = getL();

  LayerClass = L.Layer.extend({
    initialize(this: any, opts: any) {
      L.setOptions(this, opts);
      this._minzoom = opts.minzoom ?? 0;
      this._maxzoom = opts.maxzoom ?? Infinity;
      this._lineWidth = opts.lineWidth ?? 1.5;
      this._lineDash = opts.lineDash ?? [4, 4];
      this._lineColor = opts.lineColor ?? '#ff00ff';
      this._textColor = opts.textColor ?? '#ff00ff';
      this._textHaloColor = opts.textHaloColor ?? 'rgba(0, 0, 0, 0.75)';
      this._textHaloWidth = opts.textHaloWidth ?? 3;
      this._font = opts.font ?? '12px sans-serif';
    },

    onAdd(this: any, map: any): any {
      this._map = map;
      const pane = (this.options.pane as string) ?? 'overlayPane';
      const paneEl = map.getPane(pane);

      const canvas = L.DomUtil.create('canvas', 'mercator-tile-boundaries') as HTMLCanvasElement;
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      // Above the raster layer (z 200) inside the same pane.
      canvas.style.zIndex = '300';
      canvas.style.transformOrigin = '0 0';
      paneEl.appendChild(canvas);
      this._canvas = canvas;
      this._ctx = canvas.getContext('2d');

      map.on('move', this._onMove, this);
      map.on('moveend', this._onMoveEnd, this);
      map.on('zoomanim', this._onZoomAnim, this);
      map.on('zoomend', this._onZoomEnd, this);
      map.on('viewreset', this._onReset, this);
      map.on('resize', this._onReset, this);

      this._reset();
      return this;
    },

    onRemove(this: any, map: any): any {
      map.off('move', this._onMove, this);
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
      return this;
    },

    _onZoomAnim(this: any, opts: any): void {
      const map = this._map;
      if (!map || !this._canvas) return;
      this._canvas.style.transition = 'transform 250ms cubic-bezier(0,0,0.25,1)';
      const scale = map.getZoomScale(opts.zoom, this._anchorZoom);
      // `_getNewPixelOrigin` folds in `_getMapPanePos()` — same call
      // L.GridLayer uses. A naive `newCenterPx - size/2` is off by the
      // pan offset whenever mapPane isn't at translate(0,0); see the
      // raster layer's `_onZoomAnim` for the derivation.
      const newOrigin = map._getNewPixelOrigin(opts.center, opts.zoom);
      const newTlLayerX = this._anchorPixelX * scale - newOrigin.x;
      const newTlLayerY = this._anchorPixelY * scale - newOrigin.y;
      L.DomUtil.setTransform(this._canvas, L.point(newTlLayerX, newTlLayerY), scale);
    },
    _onZoomEnd(this: any): void {
      if (this._canvas) this._canvas.style.transition = '';
      this._reset();
    },
    _onMove(this: any): void {
      if (this._map && this._map._animatingZoom) return;
      this._reset();
    },
    _onMoveEnd(this: any): void { this._reset(); },
    _onReset(this: any): void { this._reset(); },

    _reset(this: any): void {
      const map = this._map;
      if (!map || !this._canvas) return;

      // Clear any in-flight zoom-anim transition before `setPosition`
      // rewrites the transform — otherwise the browser animates the
      // canvas back from its scaled zoom-anim state to the new
      // translate-only state over 250ms, producing a visible "shrink
      // back" after every zoom. `_reset` only runs OUTSIDE the zoom
      // anim (the `_onMove` guard short-circuits during it), so
      // clearing here is safe.
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

      this._render();
    },

    _render(this: any): void {
      const map = this._map;
      const canvas: HTMLCanvasElement = this._canvas;
      const ctx: CanvasRenderingContext2D = this._ctx;
      if (!map || !canvas || !ctx) return;

      const dpr = (globalThis.devicePixelRatio ?? 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Draw in CSS pixels; DPR scaling applied to the Canvas2D transform
      // so the backing-store rasterises at native resolution.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const viewZoom = map.getZoom();
      const z = Math.max(this._minzoom, Math.min(this._maxzoom, Math.floor(viewZoom)));
      const n = 2 ** z;
      const bounds = map.getBounds();

      // xLo/xHi can be negative or > n-1 — those are world copies west or
      // east of the canonical [0, n-1] range. Keep the raw value for the
      // projection (so the boundary visually wraps with the basemap), and
      // separately wrap to [0, n-1] for the label text.
      const xLo = Math.floor(lngToTileX(bounds.getWest(), z));
      const xHi = Math.floor(lngToTileX(bounds.getEast(), z));
      const yLo = Math.max(0, Math.floor(latToTileY(bounds.getNorth(), z)));
      const yHi = Math.min(n - 1, Math.floor(latToTileY(bounds.getSouth(), z)));

      // Cache corner pixel coords so the line + label passes share them.
      const boxes: Array<[number, number, number, number, number, number]> = [];
      // ---- Pass 1: dashed rectangle outlines ----
      ctx.strokeStyle = this._lineColor;
      ctx.lineWidth = this._lineWidth;
      ctx.setLineDash(this._lineDash);
      for (let xRaw = xLo; xRaw <= xHi; xRaw++) {
        const xWrap = ((xRaw % n) + n) % n;
        for (let y = yLo; y <= yHi; y++) {
          const wLng = tileXToLng(xRaw, z);
          const eLng = tileXToLng(xRaw + 1, z);
          const nLat = tileYToLat(y, z);
          const sLat = tileYToLat(y + 1, z);
          const nw = map.latLngToContainerPoint([nLat, wLng]);
          const se = map.latLngToContainerPoint([sLat, eLng]);
          ctx.strokeRect(nw.x, nw.y, se.x - nw.x, se.y - nw.y);
          boxes.push([xWrap, y, nw.x, nw.y, se.x, se.y]);
        }
      }

      // ---- Pass 2: labels (halo stroke, then fill) ----
      ctx.setLineDash([]);
      ctx.font = this._font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = this._textHaloColor;
      ctx.lineWidth = this._textHaloWidth;
      for (const [x, y, nwX, nwY, seX, seY] of boxes) {
        const label = `(${x}, ${y}) z=${z}`;
        ctx.strokeText(label, (nwX + seX) / 2, (nwY + seY) / 2);
      }
      ctx.fillStyle = this._textColor;
      for (const [x, y, nwX, nwY, seX, seY] of boxes) {
        const label = `(${x}, ${y}) z=${z}`;
        ctx.fillText(label, (nwX + seX) / 2, (nwY + seY) / 2);
      }
    },

    /** Apply a partial options patch. */
    applyOptions(this: any, p: any): void {
      if (p.minzoom != null) this._minzoom = p.minzoom;
      if (p.maxzoom != null) this._maxzoom = p.maxzoom;
      if (p.lineWidth != null) this._lineWidth = p.lineWidth;
      this._render?.();
    },
  });

  return LayerClass;
}

function create(opts: MercatorTileBoundariesLayerOpts = { viz: 'bounds' }): any {
  const Cls = ensureLayerClass();
  return new Cls(opts);
}

export const MercatorTileBoundariesLayer = { create };
