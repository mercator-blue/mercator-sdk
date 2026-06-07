/**
 * OpenLayers binding — slippy-XYZ tile-boundary debug overlay. Magenta
 * dashed outline + `(x, y) z=N` label for every visible tile at the
 * current sampling zoom. No API key needed; pure client-side overlay.
 *
 * Rendering model is OL's `Layer` + custom `render(frameState)`:
 *   - One reusable `<canvas>` owned by the layer, returned from every
 *     `render()` call. OL inserts it into the viewport stack at the
 *     layer's z-index and resizes its container around it.
 *   - `frameState.coordinateToPixelTransform` maps EPSG:3857 coords to
 *     canvas CSS pixels, so we project tile corners via:
 *       lng/lat  →  fromLonLat  →  3857 coord  →  apply(c2p, …)  →  pixel
 *     World-copy wrap is preserved by keeping raw (possibly negative or
 *     > n-1) tile X values when computing corners — the projection wraps
 *     them around the antimeridian correctly via OL's view.
 *   - Backing-store size = frameState.size × frameState.pixelRatio for
 *     crisp rasterisation; Canvas2D transform set to DPR so drawing math
 *     stays in CSS pixels.
 *
 * Mirrors the Leaflet binding's visual + option surface; the only OL-
 * specific knob is `zIndex` (cross-host ordering hook).
 */

import Layer from 'ol/layer/Layer.js';
import { apply as applyTransform } from 'ol/transform.js';
import type { FrameState } from 'ol/Map.js';
import type { MercatorTileBoundariesOptions } from '../core/types';

// Web Mercator half-extent in metres (π·R). We project tile corners
// directly in EPSG:3857 rather than going through `fromLonLat`/`toLonLat`:
// OL's lonlat helpers reduce longitudes toward the canonical [-180, 180]
// range, which collapses tile corners on adjacent world copies back to
// the canonical world's pixel positions — boundaries vanish off-canvas
// when you pan east/west. Working in 3857 directly keeps each world copy
// at its own coordinate band (e.g. 3rd-east copy spans [+2·HALF, +3·HALF]).
import { HALF_MERCATOR, WORLD_EXT_3857 } from '../core/mercator';

/** OpenLayers-specific extras on top of the cross-binding
 *  {@link MercatorTileBoundariesOptions}. */
export type MercatorTileBoundariesLayerOpts = MercatorTileBoundariesOptions & {
  /** Dash pattern (Canvas2D `setLineDash`). Default `[]` (solid). */
  lineDash?: number[];
  /** Line CSS colour. Default `#ff00ff`. */
  lineColor?: string;
  /** Label fill colour. Default `#ff00ff`. */
  textColor?: string;
  /** Label halo (outline) colour. Default `rgba(0, 0, 0, 0.75)`. */
  textHaloColor?: string;
  /** Label halo width in CSS pixels. Default 3. */
  textHaloWidth?: number;
  /** Canvas2D font shorthand. Default `12px sans-serif`. */
  font?: string;
  /** OL layer z-index. Default 1000. */
  zIndex?: number;
};

function create(opts: MercatorTileBoundariesLayerOpts = {}): Layer {
  let minzoom = opts.minzoom ?? 0;
  let maxzoom = opts.maxzoom ?? Infinity;
  let lineWidth = opts.lineWidth ?? 1.5;
  const lineDash = opts.lineDash ?? [];
  const lineColor = opts.lineColor ?? '#ff00ff';
  const textColor = opts.textColor ?? '#ff00ff';
  const textHaloColor = opts.textHaloColor ?? 'rgba(0, 0, 0, 0.75)';
  const textHaloWidth = opts.textHaloWidth ?? 3;
  const font = opts.font ?? '12px sans-serif';

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  // OL handles compositing into the map's viewport; we just provide the
  // canvas. `pointer-events: none` so map interaction passes through.
  canvas.style.pointerEvents = 'none';
  const ctx0 = canvas.getContext('2d');
  if (!ctx0) {
    throw new Error('@mercator-blue/sdk/openlayers: 2D canvas context unavailable');
  }
  // Bind to a non-null const so the closure below carries the narrowed type
  // (TS doesn't track `if (!ctx) throw` across closure captures).
  const ctx: CanvasRenderingContext2D = ctx0;

  function render(frameState: FrameState): HTMLElement {
    const [W, H] = frameState.size;
    const dpr = frameState.pixelRatio;
    const backingW = Math.round(W * dpr);
    const backingH = Math.round(H * dpr);
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, backingW, backingH);
    // Draw math in CSS pixels; rasterise at DPR.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const viewZoom = frameState.viewState.zoom;
    const z = Math.max(minzoom, Math.min(maxzoom, Math.floor(viewZoom)));
    const n = 2 ** z;

    // Viewport bounds in EPSG:3857 metres. `pixelToCoordinateTransform`
    // maps CSS pixel → 3857; on panned-far world copies the X values can
    // be well outside ±HALF_MERCATOR — that's fine, we tile on the raw
    // coord band.
    const tl3857: [number, number] = [0, 0];
    applyTransform(frameState.pixelToCoordinateTransform, tl3857);
    const br3857: [number, number] = [W, H];
    applyTransform(frameState.pixelToCoordinateTransform, br3857);

    // Tile size in 3857 metres at this zoom.
    const tileSize = WORLD_EXT_3857 / n;
    // X tile index from 3857: integer divide by tile size, anchored at
    // -HALF_MERCATOR. May be negative or > n-1 on world copies — keep the
    // raw value so the line is drawn at the correct world copy; wrap to
    // [0, n-1] only for the label text.
    const xLo = Math.floor((tl3857[0] + HALF_MERCATOR) / tileSize);
    const xHi = Math.floor((br3857[0] + HALF_MERCATOR) / tileSize);
    // Y tile index from 3857: 3857 has +y north, slippy has +y south.
    const yLo = Math.max(0, Math.floor((HALF_MERCATOR - tl3857[1]) / tileSize));
    const yHi = Math.min(n - 1, Math.floor((HALF_MERCATOR - br3857[1]) / tileSize));

    // Tile corner → 3857 metre.
    const tileX3857 = (x: number) => -HALF_MERCATOR + x * tileSize;
    const tileY3857 = (y: number) => HALF_MERCATOR - y * tileSize;

    // Project a 3857 coord → CSS pixel via the live transform.
    const project = (x3857: number, y3857: number): [number, number] => {
      const c: [number, number] = [x3857, y3857];
      applyTransform(frameState.coordinateToPixelTransform, c);
      return c;
    };

    type Box = [number, number, number, number, number, number];
    const boxes: Box[] = [];

    // Pass 1: rectangles.
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(lineDash);
    for (let xRaw = xLo; xRaw <= xHi; xRaw++) {
      const xWrap = ((xRaw % n) + n) % n;
      for (let y = yLo; y <= yHi; y++) {
        const [nwX, nwY] = project(tileX3857(xRaw), tileY3857(y));
        const [seX, seY] = project(tileX3857(xRaw + 1), tileY3857(y + 1));
        ctx.strokeRect(nwX, nwY, seX - nwX, seY - nwY);
        boxes.push([xWrap, y, nwX, nwY, seX, seY]);
      }
    }

    // Pass 2: labels (halo then fill).
    ctx.setLineDash([]);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = textHaloColor;
    ctx.lineWidth = textHaloWidth;
    for (const [x, y, nwX, nwY, seX, seY] of boxes) {
      ctx.strokeText(`(${x}, ${y}) z=${z}`, (nwX + seX) / 2, (nwY + seY) / 2);
    }
    ctx.fillStyle = textColor;
    for (const [x, y, nwX, nwY, seX, seY] of boxes) {
      ctx.fillText(`(${x}, ${y}) z=${z}`, (nwX + seX) / 2, (nwY + seY) / 2);
    }
    return canvas;
  }

  const layer = new Layer({
    zIndex: opts.zIndex ?? 1000,
    render,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (layer as any).applyOptions = (p: any) => {
    if (p.minzoom != null) minzoom = p.minzoom;
    if (p.maxzoom != null) maxzoom = p.maxzoom;
    if (p.lineWidth != null) lineWidth = p.lineWidth;
    layer.changed();
  };
  return layer;
}

export const MercatorTileBoundariesLayer = { create };
