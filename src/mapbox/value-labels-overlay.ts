/**
 * Value-label overlay — plots the decoded data value as a NUMBER at each
 * point of a viewport-derived lattice. The "temperatures-on-a-grid" look
 * familiar from forecast websites; a static, readable alternative to a
 * colormapped raster for scalar fields, and the magnitude counterpart to
 * the arrow overlay for vector fields.
 *
 * Two source encodings:
 *   - `rg16_fixed`   → the scalar value (°C, hPa, %, …).
 *   - `vector_rg_ba` → the vector MAGNITUDE (wind/current speed).
 *
 * Implementation: a plain GeoJSON source + `symbol` layer, NOT a custom
 * WebGL layer. Unlike arrows (which had to be a custom layer so it would
 * render in the same pass as raster/particles on Mapbox v3 globe), text
 * labels WANT to live in the symbol pass on top of everything — and the
 * symbol layer gives us glyph rendering, halos, font handling, and
 * collision-based decluttering for free, on flat Mercator AND globe.
 *
 * The lattice + tile-sampling machinery mirrors arrows-overlay.ts: a
 * global-anchored lattice sized to ~TARGET_LABELS_ACROSS columns so
 * panning doesn't jitter and the density stays roughly constant across
 * zoom. We over-emit slightly and let the symbol layer's collision
 * detection (`text-allow-overlap: false`) thin overlapping labels.
 */

import {
  lngToTileX,
  latToTileY,
  tilePixelToLngLat,
} from '../core/mercator';
import { loadTilePixels } from '../core/tile-pixel-reader';
import type { EncodingKind } from '../core/types';
import { expandTileUrl } from '../core/urls';

const SOURCE_ID = '__mercator_value_labels_src';
const LAYER_ID = '__mercator_value_labels';

// Numbers are much wider than an arrow glyph, so target fewer across the
// viewport than the arrow lattice (30). Collision thins further.
const TARGET_LABELS_ACROSS = 18;

export interface ValueLabelsEncoding {
  kind: EncodingKind;
  scale: number;
  offset: number;
}

export interface ValueLabelsOverlayOpts {
  tileUrlTemplate: string;
  encoding: ValueLabelsEncoding;
  maxzoom?: number;
  /** Pin the sampling tile zoom regardless of map zoom. */
  lockZoom?: number;
  /** Decimal places for the default formatter. Ignored if `format` set. */
  digits?: number;
  /** Custom value→string formatter. Overrides `digits`. */
  format?: (value: number) => string;
  /** Approx. number of labels across the viewport. Default 18. */
  targetAcross?: number;
  /** Skip land pixels (vector ocean datasets). */
  landmaskUrlTemplate?: string;
  landmaskAccepts?: number[];
  /** MapLibre/Mapbox layer id to insert this layer BEFORE. */
  beforeId?: string;
  /** Mapbox GL JS v3 slot. Ignored under MapLibre / older Mapbox. */
  slot?: string;
  /** Glyph fontstack. Default `['Open Sans Regular', 'Arial Unicode MS
   *  Regular']` works on Mapbox classic + Standard glyph endpoints.
   *  OpenFreeMap and other single-font MapLibre endpoints 404 multi-font
   *  stacks — override with `['Noto Sans Regular']` there. Wins over a
   *  `text-font` passed in `labelLayout`. */
  textFont?: string[];
  /** Symbol-layer `layout` overrides, merged on top of the defaults
   *  (`text-size: 13`, collision on, `text-padding: 2`). Mapbox/MapLibre
   *  style-spec keys; the shape stays loose since the valid set is host-
   *  version-specific. `text-field` is always controlled by the overlay
   *  (the formatted value) and can't be overridden here; pass `text-font`
   *  here only if not using the `textFont` convenience opt. */
  labelLayout?: StyleProps;
  /** Symbol-layer `paint` overrides, merged on top of the defaults
   *  (`text-color: '#1a1a1a'`, white halo). */
  labelPaint?: StyleProps;
}

export interface ValueLabelsOverlayHandle {
  remove(): void;
  /** Re-sample and redraw immediately (e.g. after a runtime style tweak). */
  refresh(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyOptions(p: any): void;
}

const DEFAULT_LABEL_FONT = ['Open Sans Regular', 'Arial Unicode MS Regular'];

/** Mapbox/MapLibre style-spec layout/paint property maps. The full union
 *  of valid keys is host-version-specific and large, so we leave this
 *  loose — callers pass whatever their target host accepts. */
type StyleProps = Record<string, unknown>;

const DEFAULT_LABEL_LAYOUT: StyleProps = {
  'text-size': 13,
  // Collision-declutter: drop labels that would overlap an already-placed
  // one. Lets us over-emit the lattice and let the symbol engine thin it.
  'text-allow-overlap': false,
  'text-ignore-placement': false,
  'text-padding': 2,
};
const DEFAULT_LABEL_PAINT: StyleProps = {
  'text-color': '#1a1a1a',
  'text-halo-color': '#ffffff',
  'text-halo-width': 1.4,
  'text-halo-blur': 0.2,
};

// Minimal GeoJSON shapes — avoids depending on the ambient @types/geojson
// global, which isn't pulled into this package's compilation.
interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { label: string; value: number };
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: PointFeature[];
}

type LoadedTileEntry = {
  status: 'loaded';
  val: Float32Array;
  W: number;
  H: number;
};
type LoadingTileEntry = { status: 'loading'; promise: Promise<LoadedTileEntry> };
type ErrorTileEntry = { status: 'error' };
type TileCacheEntry = LoadedTileEntry | LoadingTileEntry | ErrorTileEntry;
type TileCache = Map<string, TileCacheEntry>;

async function loadTile(
  cache: TileCache,
  tileUrlTemplate: string,
  encoding: ValueLabelsEncoding,
  z: number, x: number, y: number,
  landmaskUrlTemplate: string | undefined,
  landmaskAccepts: Set<number> | null,
): Promise<LoadedTileEntry> {
  const key = `${z}/${x}/${y}`;
  const existing = cache.get(key);
  if (existing) {
    if (existing.status === 'loading') return existing.promise;
    if (existing.status === 'loaded') return existing;
    // status === 'error' — fall through and retry.
  }
  const promise = (async (): Promise<LoadedTileEntry> => {
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
      if (useMask && !landmaskAccepts!.has(maskBytes![i * 4])) {
        val[i] = NaN; continue;
      }
      if (kind === 'vector_rg_ba') {
        // No-data sentinel is (0,0,0,0). Decode u/v, take magnitude.
        if ((r | g | b | a) === 0) { val[i] = NaN; continue; }
        const u = (r * 256 + g) * sc + off;
        const v = (b * 256 + a) * sc + off;
        val[i] = Math.sqrt(u * u + v * v);
      } else if (kind === 'mapbox_rgb') {
        // 24-bit signed integer (Mapbox Terrain-RGB style). Every pixel
        // is a valid altitude — no alpha-as-validity convention. Alpha
        // ignored.
        val[i] = (r * 65536 + g * 256 + b) * sc + off;
      } else {
        // rg16_fixed: value in R+G; alpha is validity/coverage (0 = no
        // data). B unused. Decode to float here so the later bilinear
        // sample interpolates floats, sidestepping the 16-bit byte-
        // boundary discontinuity that makes raw-channel filtering wrong.
        if (a === 0) { val[i] = NaN; continue; }
        val[i] = (r * 256 + g) * sc + off;
      }
    }
    const loaded: LoadedTileEntry = { status: 'loaded', val, W, H };
    cache.set(key, loaded);
    return loaded;
  })();
  cache.set(key, { status: 'loading', promise });
  promise.catch(() => cache.set(key, { status: 'error' }));
  return promise;
}

function normalizeLng(lng: number): number {
  return ((lng + 180) % 360 + 360) % 360 - 180;
}

export function addValueLabelsOverlay(
  // maplibregl.Map | mapboxgl.Map — kept loose, cast to any internally.
  mapAny: unknown,
  opts: ValueLabelsOverlayOpts,
): ValueLabelsOverlayHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = mapAny as any;
  const { tileUrlTemplate, encoding } = opts;
  const maxzoom = opts.maxzoom ?? 5;
  let lockZoom = opts.lockZoom;
  let targetAcross = opts.targetAcross ?? TARGET_LABELS_ACROSS;
  let digits = opts.digits ?? 0;
  let fmt = opts.format ?? ((v: number) => v.toFixed(digits));
  const landmaskUrlTemplate = opts.landmaskUrlTemplate;
  const landmaskAccepts = opts.landmaskAccepts
    ? new Set(opts.landmaskAccepts)
    : null;
  const cache: TileCache = new Map();

  let pending = false;
  let queued = false;

  function emptyFC(): FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
  }

  async function rebuild(): Promise<void> {
    if (pending) { queued = true; return; }
    pending = true;
    try {
      const z = lockZoom != null
        ? Math.max(0, Math.min(maxzoom, lockZoom))
        : Math.max(0, Math.min(maxzoom, Math.floor(map.getZoom())));
      const n = 2 ** z;
      const bounds = map.getBounds();
      const wLng = bounds.getWest(), eLng = bounds.getEast();
      const nLat = bounds.getNorth(), sLat = bounds.getSouth();

      // Fetch every data tile covering the viewport (wrap tx for fetch,
      // keep unwrapped tx for lng math — same as arrows).
      const txMin = Math.floor(lngToTileX(wLng, z));
      const txMax = Math.floor(lngToTileX(eLng, z));
      const tyMin = Math.max(0, Math.floor(latToTileY(nLat, z)));
      const tyMax = Math.min(n - 1, Math.floor(latToTileY(sLat, z)));

      const tilePromises: Promise<LoadedTileEntry | null>[] = [];
      for (let tx = txMin; tx <= txMax; tx++) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          const wrappedTx = ((tx % n) + n) % n;
          tilePromises.push(
            loadTile(cache, tileUrlTemplate, encoding, z, wrappedTx, ty, landmaskUrlTemplate, landmaskAccepts).catch(() => null),
          );
        }
      }
      await Promise.all(tilePromises);

      // Lattice in DATA-pixel space, anchored to a global grid so panning
      // doesn't shift labels. Step sized for ~targetAcross columns across
      // the viewport, capped so it never goes below 1 data pixel (no point
      // labelling sub-pixel detail — nearest-sample the parent pixel).
      const dataPxLeft = lngToTileX(wLng, z) * 256;
      const dataPxRight = lngToTileX(eLng, z) * 256;
      const dataPxTop = latToTileY(nLat, z) * 256;
      const dataPxBottom = latToTileY(sLat, z) * 256;
      const dataPxViewportWidth = dataPxRight - dataPxLeft;

      const pxStep = Math.max(1, dataPxViewportWidth / targetAcross);
      const halfStep = pxStep * 0.5;
      const startX = Math.floor(dataPxLeft / pxStep) * pxStep + halfStep;
      const startY = Math.floor(dataPxTop / pxStep) * pxStep + halfStep;

      const features: PointFeature[] = [];
      for (let pixY = startY; pixY < dataPxBottom + halfStep; pixY += pxStep) {
        const ty = Math.floor(pixY / 256);
        if (ty < 0 || ty >= n) continue;
        const fyAbs = pixY - ty * 256;
        for (let pixX = startX; pixX < dataPxRight + halfStep; pixX += pxStep) {
          const tx = Math.floor(pixX / 256);
          const wrappedTx = ((tx % n) + n) % n;
          const tile = cache.get(`${z}/${wrappedTx}/${ty}`);
          if (!tile || tile.status !== 'loaded') continue;
          const fxAbs = pixX - tx * 256;

          // Bilinear sample the decoded float grid. Cross-tile neighbours
          // clamp to the tile edge — sub-pixel inaccuracy invisible at
          // label density.
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
          const v00 = tile.val[i00], v01 = tile.val[i01];
          const v10 = tile.val[i10], v11 = tile.val[i11];
          // If ANY corner is NaN (no-data / land), skip — don't smear a
          // coastline value inland.
          if (!Number.isFinite(v00) || !Number.isFinite(v01) ||
              !Number.isFinite(v10) || !Number.isFinite(v11)) continue;
          const w00 = (1 - ax) * (1 - ay);
          const w01 = ax * (1 - ay);
          const w10 = (1 - ax) * ay;
          const w11 = ax * ay;
          const value = v00 * w00 + v01 * w01 + v10 * w10 + v11 * w11;
          if (!Number.isFinite(value)) continue;

          const [lng, lat] = tilePixelToLngLat(z, tx, ty, fxAbs, fyAbs);
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [normalizeLng(lng), lat] },
            properties: { label: fmt(value), value },
          });
        }
      }

      const src = map.getSource(SOURCE_ID);
      if (src) src.setData({ type: 'FeatureCollection', features });
    } finally {
      pending = false;
      if (queued) { queued = false; rebuild(); }
    }
  }

  // Merge order: defaults → caller `labelLayout` → overlay-controlled
  // fields. `text-font` resolves to the `textFont` convenience opt first,
  // then a `text-font` in `labelLayout`, then the default. `text-field`
  // is always the formatted value — it's what the overlay exists to draw,
  // so it isn't overridable.
  const layout: StyleProps = {
    ...DEFAULT_LABEL_LAYOUT,
    ...opts.labelLayout,
    'text-font': opts.textFont ?? opts.labelLayout?.['text-font'] ?? DEFAULT_LABEL_FONT,
    'text-field': ['get', 'label'],
  };
  const paint: StyleProps = {
    ...DEFAULT_LABEL_PAINT,
    ...opts.labelPaint,
  };

  const layer: Record<string, unknown> = {
    id: LAYER_ID,
    type: 'symbol',
    source: SOURCE_ID,
    ...(opts.slot ? { slot: opts.slot } : {}),
    layout,
    paint,
  };

  map.addSource(SOURCE_ID, { type: 'geojson', data: emptyFC() });
  map.addLayer(layer, opts.beforeId);
  map.on('moveend', rebuild);
  map.on('zoomend', rebuild);
  rebuild();

  return {
    remove(): void {
      map.off('moveend', rebuild);
      map.off('zoomend', rebuild);
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    },
    refresh(): void {
      rebuild();
    },
    /** Apply a partial options patch. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyOptions(p: any): void {
      let needsRebuild = false;
      if (p.lockZoom !== undefined) { lockZoom = p.lockZoom; needsRebuild = true; }
      if (p.targetAcross != null) { targetAcross = p.targetAcross; needsRebuild = true; }
      if (p.digits != null) {
        digits = p.digits;
        // When `format` is the default toFixed(digits), bump it; if the
        // caller supplied a custom formatter via opts.format, leave that
        // in place — only setting `format` should replace it.
        if (!opts.format) fmt = (v: number) => v.toFixed(digits);
        needsRebuild = true;
      }
      if (p.format != null) {
        fmt = p.format;
        needsRebuild = true;
      }
      if (needsRebuild) rebuild();
    },
  };
}
