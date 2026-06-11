// Value-label overlay for deck.gl — plots the decoded data value as a
// NUMBER at each point of a viewport-driven lattice (the forecast-site
// temperature-grid look). Scalar datasets (rg16_fixed) show the value;
// vector datasets (vector_rg_ba) show the speed MAGNITUDE.
//
// Mirrors the Mapbox/MapLibre `ValueLabelsOverlay` and the Leaflet
// `MercatorValueLabelsLayer`: same viewport-anchored lattice (~18 labels
// across), same tile-pixel decode path (the WebGL-based reader in
// `tile-pixel-reader.ts`), same default-decimals-from-vmax heuristic.
//
// Rendering goes through a stock `TextLayer` (SDF glyphs + white outline
// for a halo). deck.gl's TextLayer doesn't collision-declutter the way a
// Mapbox symbol layer does, but the lattice is uniform in Mercator pixel
// space so screen spacing is even — at ~18 across, overlap is rare. The
// same instance-reconciliation + viewport-debounce + tile-load-coalesce
// machinery as `arrows-layer.ts` applies (see that file for rationale).

import { CompositeLayer, type DefaultProps, type Color, type LayersList } from '@deck.gl/core';
import { TextLayer } from '@deck.gl/layers';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, DEFAULT_CATALOG_URL } from '../core/urls';
import { loadTilePixels } from '../core/tile-pixel-reader';
import {
  lngToTileX,
  latToTileY,
  tileXToLng,
  tileYToLat,
} from '../core/mercator';

const TARGET_LABELS_ACROSS = 18;

// Module-level discovery cache — survives deck.gl's instance
// reconciliation (which transfers `state` but not instance-own fields).
const discoveryCache = new Map<string, DiscoveredItem | Promise<DiscoveredItem>>();
const discoveryKey = (catalogUrl: string, dataset: string) => `${catalogUrl}|${dataset}`;

// Module-level tile-pixel cache, keyed by full URL.
type TilePixels = { pixels: Uint8Array; width: number; height: number };
type CacheEntry = TilePixels | 'loading' | 'error';
const tilePixelCache = new Map<string, CacheEntry>();

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

export interface MercatorValueLabelsLayerProps {
  /** Dataset name, e.g. 'temp2m', 'wind10m'. rg16_fixed or vector_rg_ba. */
  dataset: string;
  /** mercator.blue API key (`mk_<...>`). */
  apiKey: string;
  /** STAC catalog URL. Defaults to the production tile API. */
  catalogUrl?: string;
  /** Decimal places for the default formatter. Defaults to 1 for low-
   *  magnitude fields (vmax < 10, e.g. currents), 0 otherwise. Ignored
   *  when `format` is given. */
  digits?: number;
  /** Custom value→string formatter. Overrides `digits`. */
  format?: (value: number) => string;
  /** Approx. number of labels across the viewport. Default 18. */
  targetAcross?: number;
  /** Label font size in CSS pixels. Default 13. */
  fontSize?: number;
  /** Label fill colour [r,g,b] or [r,g,b,a]. Default near-black. */
  textColor?: Color;
  /** Background-pill colour behind each label (the legibility backdrop —
   *  deck.gl's text outline can't render a reliable halo). Default
   *  near-opaque white. Set the alpha to 0 to disable the pill. */
  haloColor?: Color;
  /** Layer id. */
  id?: string;
}

interface TextLabel {
  position: [number, number];
  text: string;
}

const defaultProps: DefaultProps<MercatorValueLabelsLayerProps> = {
  dataset: '',
  apiKey: '',
  catalogUrl: DEFAULT_CATALOG_URL,
  targetAcross: { type: 'number', value: TARGET_LABELS_ACROSS },
  fontSize: { type: 'number', value: 13 },
  textColor: { type: 'color', value: [26, 26, 26, 255] },
  haloColor: { type: 'color', value: [255, 255, 255, 128] },
};

export class MercatorValueLabelsLayer extends CompositeLayer<MercatorValueLabelsLayerProps> {
  static layerName = 'MercatorValueLabelsLayer';
  static defaultProps = defaultProps;

  // Per-instance label cache + debounce/coalesce timers — same pattern
  // and rationale as MercatorArrowsLayer.
  private _cachedLabels: TextLabel[] = [];
  private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
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
    props: MercatorValueLabelsLayerProps;
    oldProps: MercatorValueLabelsLayerProps;
  }) {
    if (
      props.dataset !== oldProps.dataset ||
      props.catalogUrl !== oldProps.catalogUrl
    ) {
      if (!this._getCachedItem()) void this._discover();
    }
  }

  // Default shouldUpdateState skips viewport changes; we need the lattice
  // recomputed on pan/zoom.
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
      const kind = item.encoding.kind;
      if (kind !== 'rg16_fixed' && kind !== 'vector_rg_ba' && kind !== 'mapbox_rgb') {
        throw new Error(
          `@mercator-blue/sdk/deck-gl: MercatorValueLabelsLayer supports ` +
            'rg16_fixed (scalar), vector_rg_ba (magnitude), and mapbox_rgb ' +
            `(elevation); dataset "${dataset}" has "${kind}".`,
        );
      }
      discoveryCache.set(key, item);
      this.setNeedsUpdate();
    } catch (err) {
      if (discoveryCache.get(key) === promise) discoveryCache.delete(key);
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[MercatorValueLabelsLayer]', msg);
    }
  }

  renderLayers(): LayersList {
    const item = this._getCachedItem();
    if (!item) return [];

    const viewport = this.context.viewport;
    if (viewport) {
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
          this._cachedLabels = this._buildLabels(item);
        } else {
          if (this._rebuildTimer != null) clearTimeout(this._rebuildTimer);
          this._rebuildTimer = setTimeout(() => {
            this._rebuildTimer = null;
            this._cachedLabels = this._buildLabels(item);
            this.setNeedsUpdate();
          }, 150);
        }
      }
    }

    const labels = this._cachedLabels;
    const fingerprint = labels.length;
    const { fontSize, textColor, haloColor } = this.props;

    return [
      new TextLayer<TextLabel>(this.getSubLayerProps({ id: 'labels' }), {
        data: labels,
        getPosition: (d) => d.position,
        getText: (d) => d.text,
        getSize: fontSize ?? 13,
        sizeUnits: 'pixels',
        getColor: textColor ?? [26, 26, 26, 255],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        fontFamily: 'sans-serif',
        fontWeight: 700,
        // Legibility backdrop. deck.gl's SDF text outline is capped by the
        // glyph-atlas distance-field buffer and won't render a thick halo
        // reliably (the other bindings' Canvas2D strokeText / symbol
        // text-halo have no such limit). A background pill behind each
        // number is the robust deck.gl equivalent — guaranteed readable on
        // any basemap, light or dark.
        background: true,
        getBackgroundColor: haloColor ?? [255, 255, 255, 128],
        backgroundPadding: [5, 3, 5, 3],
        backgroundBorderRadius: 4,
        updateTriggers: {
          getPosition: [fingerprint],
          getText: [fingerprint],
          getColor: [textColor],
          getBackgroundColor: [haloColor],
          getSize: [fontSize],
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

  private _onTileLoaded = () => {
    if (this._coalesceTimer != null) return;
    this._coalesceTimer = setTimeout(() => {
      this._coalesceTimer = null;
      const item = this._getCachedItem();
      if (!item) return;
      this._cachedLabels = this._buildLabels(item);
      this.setNeedsUpdate();
    }, 0);
  };

  _buildLabels(item: DiscoveredItem): TextLabel[] {
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

    const dataPxLeft = lngToTileX(wLng, z) * 256;
    const dataPxRight = lngToTileX(eLng, z) * 256;
    const dataPxTop = latToTileY(nLat, z) * 256;
    const dataPxBottom = latToTileY(sLat, z) * 256;
    const dataPxViewportWidth = dataPxRight - dataPxLeft;

    const targetAcross = this.props.targetAcross ?? TARGET_LABELS_ACROSS;
    const pxStep = Math.max(1, dataPxViewportWidth / targetAcross);
    const halfStep = pxStep * 0.5;
    const startX = Math.floor(dataPxLeft / pxStep) * pxStep + halfStep;
    const startY = Math.floor(dataPxTop / pxStep) * pxStep + halfStep;

    const sc = item.encoding.scale;
    const off = item.encoding.offset;
    const kind = item.encoding.kind;

    // Decode one sample to a scalar value (or magnitude). Returns NaN for
    // no-data: the (0,0,0,0) sentinel for vector, alpha==0 for rg16
    // scalar. mapbox_rgb has no no-data convention — every pixel is a
    // valid altitude.
    const decodeVal = (tile: TilePixels, ix: number, iy: number): number => {
      const idx = (iy * tile.width + ix) * 4;
      const r = tile.pixels[idx];
      const g = tile.pixels[idx + 1];
      const b = tile.pixels[idx + 2];
      const a = tile.pixels[idx + 3];
      if (kind === 'vector_rg_ba') {
        if ((r | g | b | a) === 0) return NaN;
        const u = (r * 256 + g) * sc + off;
        const v = (b * 256 + a) * sc + off;
        return Math.sqrt(u * u + v * v);
      }
      if (kind === 'mapbox_rgb') {
        return (r * 65536 + g * 256 + b) * sc + off;
      }
      if (a === 0) return NaN;
      return (r * 256 + g) * sc + off;
    };

    // Default decimals: 1 for low-magnitude fields (currents), else 0.
    const vmax = item.visualization?.vmax;
    const digits = this.props.digits ?? (vmax != null && vmax < 10 ? 1 : 0);
    const fmt = this.props.format ?? ((v: number) => v.toFixed(digits));

    const labels: TextLabel[] = [];
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

        // Bilinear sample the decoded grid; skip if any corner is NaN so
        // a coastline / no-data value isn't smeared across the boundary.
        const W = tile.width, H = tile.height;
        const x0 = Math.max(0, Math.min(W - 1, Math.floor(fxAbs)));
        const y0 = Math.max(0, Math.min(H - 1, Math.floor(fyAbs)));
        const x1 = Math.min(W - 1, x0 + 1);
        const y1 = Math.min(H - 1, y0 + 1);
        const ax = Math.max(0, Math.min(1, fxAbs - x0));
        const ay = Math.max(0, Math.min(1, fyAbs - y0));
        const c00 = decodeVal(tile, x0, y0);
        const c01 = decodeVal(tile, x1, y0);
        const c10 = decodeVal(tile, x0, y1);
        const c11 = decodeVal(tile, x1, y1);
        if (!Number.isFinite(c00) || !Number.isFinite(c01) ||
            !Number.isFinite(c10) || !Number.isFinite(c11)) continue;
        const w00 = (1 - ax) * (1 - ay);
        const w01 = ax * (1 - ay);
        const w10 = (1 - ax) * ay;
        const w11 = ax * ay;
        const value = c00 * w00 + c01 * w01 + c10 * w10 + c11 * w11;
        if (!Number.isFinite(value)) continue;

        const lng = tileXToLng(tx + fxAbs / 256, z);
        const lat = tileYToLat(ty + fyAbs / 256, z);
        labels.push({ position: [lng, lat], text: fmt(value) });
      }
    }

    return labels;
  }
}
