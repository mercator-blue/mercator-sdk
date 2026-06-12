/**
 * OpenLayers binding — colormapped raster overlay decoded from value-encoded
 * PNG tiles. Unlike the Mapbox/MapLibre/Leaflet bindings (which run our own
 * GLSL in a custom WebGL layer), this binding leans entirely on OpenLayers'
 * own `WebGLTileLayer` + its declarative style-expression language: the
 * 16-bit value decode and the colour ramp are expressed as a `style.color`
 * expression, so there is NO hand-written GLSL to maintain and the layer
 * participates in OL's normal tile pipeline (loading, caching, reprojection).
 *
 * How the decode maps onto OL expressions:
 *   - Band values from an image (XYZ) source are normalised to [0, 1], so a
 *     raw byte B is `['*', ['band', n], 255]`.
 *   - `rg16_fixed` scalar:  value = (R*256 + G) * scale + offset
 *     → raw16 = band1*65280 + band2*255  (65280 = 255*256), value = raw16*scale+offset.
 *   - `vector_rg_ba` magnitude: u from R+G, v from B+A; magnitude = sqrt(u²+v²).
 *     No-data sentinel is (0,0,0,0) → all four bands ≈ 0 → transparent.
 *   - The colour ramp is a `['palette', index, [256 hex strings]]` over the
 *     resolved 256-entry colormap — compact (one LUT) vs. a 256-stop
 *     `interpolate` chain.
 *
 * NEAREST sampling (mandatory for the 16-bit byte-boundary decode — LINEAR
 * across the R/G rollover decodes to nonsense) comes from `interpolate: false`
 * on the source; OL also never interpolates ACROSS tile boundaries, so the
 * decode is byte-exact within each tile.
 *
 * Supported encodings: `rg16_fixed` (scalar), `vector_rg_ba` (magnitude),
 * and `mapbox_rgb` (elevation, hypsometric tint — the same ramp the other
 * bindings render in GLSL, here expressed as a piecewise `['interpolate', …]`).
 *
 * `scale_type: 'log'` is supported via a pre-curved palette (OL's expression
 * language has no `log` operator, so we bake the curve into the lookup
 * table — see {@link paletteHexArray}). Affects cape / precip3h / snowdepth.
 *
 * Known v1 gaps (documented, deliberate):
 *   - `smooth` (in-value bilinear) and continuous coverage-aware coastal
 *     alpha are not supported; validity is a hard cutoff at band4 < 0.5.
 */

import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import ImageTileSource from 'ol/source/ImageTile.js';
import type { ExpressionValue } from 'ol/expr/expression.js';

import { resolveColormap, COLORMAP_SIZE } from '../core/color/colormaps';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, DEFAULT_CATALOG_URL } from '../core/urls';
import type { ColormapSpec, MercatorRasterOptions } from '../core/types';


/** OpenLayers-specific extras on top of the cross-binding
 *  {@link MercatorRasterOptions}. (Currently none — the OL binding
 *  honours every field of the unified type that the WebGLTileLayer
 *  back-end can express. `smooth` and `alphaByValue` from the unified
 *  type aren't currently runtime-mutable here — they bake into the
 *  WebGLTileLayer's style expression at construction.) */
export type MercatorRasterLayerOpts = MercatorRasterOptions;

/** A built-in OL `WebGLTileLayer` subclass that decodes value-encoded
 *  mercator tiles. Returned by {@link MercatorRasterLayer.create}/`.fromItem`
 *  — add it to the map like any OL layer; the extra setters update the
 *  decode/ramp in place. */
class MercatorRasterTileLayer extends WebGLTileLayer {
  private _item: DiscoveredItem;
  private _colormap: ColormapSpec;
  private _transparentBelow: number | undefined;
  private _vmin: number;
  private _vmax: number;
  private _isLog: boolean;

  constructor(opts: MercatorRasterLayerOpts, item: DiscoveredItem) {
    const kind = item.encoding.kind;
    if (kind !== 'rg16_fixed' && kind !== 'vector_rg_ba' && kind !== 'mapbox_rgb') {
      throw new Error(
        `@mercator-blue/sdk/openlayers: raster encoding "${kind}" is not ` +
        'supported by the OpenLayers binding (rg16_fixed scalars, vector_rg_ba ' +
        'magnitude, and mapbox_rgb elevation).',
      );
    }

    const vmin = opts.vmin ?? item.visualization?.vmin ?? 0;
    const vmax = opts.vmax ?? item.visualization?.vmax ?? 1;
    const colormap = opts.colormap ?? item.visualization?.colormap ?? 'viridis';
    const tbDefault = (item.visualization?.transparent_below);
    const transparentBelow = opts.transparentBelow ?? tbDefault;
    // OL's expression language has no `log` operator. Emulate log scaling by
    // pre-curving the palette: a linear index expression against the curved
    // table produces the same colour the GLSL/Python log path does. Only
    // applies to scalar / vector magnitude — elevation has its own ramp.
    const isLog = (kind !== 'mapbox_rgb')
      && item.visualization?.scale_type === 'log';

    const url = withApiKey(`${item.itemBase}/{z}/{x}/{y}.png`, opts.apiKey);
    // ImageTileSource (OL 10's DataTile-based image source) — the source type
    // WebGLTileLayer's style expressions read bands from. The older XYZ
    // (TileImage) source isn't a DataTileSource and won't type-check here.
    const source = new ImageTileSource({
      url,
      crossOrigin: 'anonymous',
      // NEAREST: never linearly resample value-encoded bytes — LINEAR across
      // the R/G 16-bit byte boundary decodes to garbage.
      interpolate: false,
      maxZoom: item.tile.maxzoom,
      tileSize: 256,
      wrapX: true,
    });

    super({
      source,
      opacity: opts.opacity ?? 0.75,
      style: {
        variables: { vmin, vmax },
        color: buildColorExpression(item, colormap, transparentBelow,
                                    isLog ? vmax - vmin : undefined),
      },
    });

    this._item = item;
    this._colormap = colormap;
    this._transparentBelow = transparentBelow;
    this._vmin = vmin;
    this._vmax = vmax;
    this._isLog = isLog;
  }

  /** Replace the colour ramp. Rebuilds the style (the palette array is baked
   *  into the `color` expression, so this can't go through style variables). */
  setColormap(spec: ColormapSpec): void {
    this._colormap = spec;
    this._rebuildStyle();
  }

  /** Update the display-range minimum.
   *  Linear: cheap style variable. Log: rebuilds style — palette is
   *  pre-curved against `vmax-vmin`, so a range change re-curves it. */
  setVmin(v: number): void {
    this._vmin = v;
    if (this._isLog) this._rebuildStyle();
    else this.updateStyleVariables({ vmin: v });
  }

  /** Update the display-range maximum.
   *  Linear: cheap style variable. Log: rebuilds style (see setVmin). */
  setVmax(v: number): void {
    this._vmax = v;
    if (this._isLog) this._rebuildStyle();
    else this.updateStyleVariables({ vmax: v });
  }

  private _rebuildStyle(): void {
    this.setStyle({
      variables: { vmin: this._vmin, vmax: this._vmax },
      color: buildColorExpression(
        this._item, this._colormap, this._transparentBelow,
        this._isLog ? this._vmax - this._vmin : undefined,
      ),
    });
  }

  /** Apply a partial options patch. Fields not relevant to raster are
   *  silently ignored. See MercatorLayer.setOptions for the
   *  customer-facing entry point. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyOptions(p: any): void {
    if (p.opacity != null) this.setOpacity(p.opacity);
    if (p.colormap != null) this.setColormap(p.colormap);
    if (p.vmin != null) this.setVmin(p.vmin);
    if (p.vmax != null) this.setVmax(p.vmax);
    if (p.scaleType != null) {
      this._isLog = p.scaleType === 'log';
      this._rebuildStyle();
    }
    if ('transparentBelow' in p) {
      this._transparentBelow = p.transparentBelow != null ? p.transparentBelow : -1e30;
      this._rebuildStyle();
    }
    // `smooth` and `alphaByValue` are not currently runtime-mutable on
    // the OL binding — they're baked into the WebGLTileLayer's style
    // expression at construction time.
  }
}

/** Resolve a colormap spec to 256 `#rrggbb` strings for the `['palette', …]`
 *  operator.
 *
 *  `logSpan`, when set, pre-curves the table so that a LINEAR index lookup
 *  produces the same colour the log mapping `t = log1p(v-vmin)/log1p(span)`
 *  would yield against the un-curved palette. This is how the OL binding
 *  emulates `scale_type: 'log'` without a `log` operator in the expression
 *  language — the curve is baked into the palette, OL's runtime expression
 *  stays a cheap linear `(v-vmin)/span` index.
 *
 *  Formula: for linear lookup index i ∈ [0..255], we want the colour at
 *  log-position t_log of the value v_i = vmin + (i/N)*span. By the Python
 *  twin's definition t_log = log1p(v_i-vmin)/log1p(span) = log1p((i/N)*span)/log1p(span).
 *  So palette_log[i] = palette_linear[round(t_log * N)].
 */
function paletteHexArray(spec: ColormapSpec, logSpan?: number): string[] {
  const rgb = resolveColormap(spec); // Float32Array(256*3), 0..1
  const out: string[] = new Array(COLORMAP_SIZE);
  const N = COLORMAP_SIZE - 1;
  const remap = logSpan !== undefined && logSpan > 0;
  const logDenom = remap ? Math.log1p(logSpan!) : 1;
  for (let i = 0; i < COLORMAP_SIZE; i++) {
    let src = i;
    if (remap) {
      const t = Math.log1p((i / N) * logSpan!) / logDenom;
      src = Math.max(0, Math.min(N, Math.round(t * N)));
    }
    const r = Math.round(rgb[src * 3 + 0] * 255);
    const g = Math.round(rgb[src * 3 + 1] * 255);
    const b = Math.round(rgb[src * 3 + 2] * 255);
    out[i] = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  return out;
}

const TRANSPARENT: ExpressionValue = ['color', 0, 0, 0, 0];

/** Hypsometric elevation tint as an OL color expression — the byte-exact
 *  twin of `mercator_tiles/colorize.py:hypsometric_tint` (and the GLSL
 *  raster-elevation shader). Sea half is a linear deep→shoreline ramp;
 *  land half is the piecewise green→brown→snow ramp; the two are split at
 *  height 0 (`np.where(h <= 0, sea, land)`). RGB stop values are the
 *  Python 0..1 triples × 255, rounded. */
function hypsometricColor(height: ExpressionValue): ExpressionValue {
  const sea: ExpressionValue = [
    'interpolate', ['linear'], height,
    -8000, [5, 13, 46],     // deep  [0.02, 0.05, 0.18]
    0,     [140, 199, 242], // shore [0.55, 0.78, 0.95]
  ];
  const land: ExpressionValue = [
    'interpolate', ['linear'], height,
    0,    [82, 140, 51],    // [0.32, 0.55, 0.20]
    500,  [166, 199, 102],  // [0.65, 0.78, 0.40]
    1500, [217, 191, 102],  // [0.85, 0.75, 0.40]
    3000, [166, 128, 89],   // [0.65, 0.50, 0.35]
    5000, [217, 204, 191],  // [0.85, 0.80, 0.75]
    8000, [255, 255, 255],  // [1.00, 1.00, 1.00]
  ];
  return ['case', ['<=', height, 0], sea, land];
}

/** Build the `style.color` expression that decodes the value-encoded bytes
 *  and maps them through the colormap.
 *
 *  `logSpan`, when set, switches the colour ramp from linear to log via a
 *  pre-curved palette (see {@link paletteHexArray}). The OL expression
 *  itself stays a linear `(v-vmin)/span` index regardless. */
function buildColorExpression(
  item: DiscoveredItem,
  colormap: ColormapSpec,
  transparentBelow: number | undefined,
  logSpan?: number,
): ExpressionValue {
  const { scale, offset, kind } = item.encoding;
  const hex = paletteHexArray(colormap, logSpan);

  // Raw byte = band(n) * 255; a 16-bit hi/lo pair → hi*256 + lo in byte space
  // = band(hi)*65280 + band(lo)*255.
  const rg16 = (hiBand: number, loBand: number): ExpressionValue =>
    ['+', ['*', ['band', hiBand], 65280], ['*', ['band', loBand], 255]];

  // Map a decoded value to a palette colour over [vmin, vmax].
  const ramp = (value: ExpressionValue): ExpressionValue => {
    const span: ExpressionValue = ['-', ['var', 'vmax'], ['var', 'vmin']];
    const t: ExpressionValue = ['/', ['-', value, ['var', 'vmin']], span];
    const idx: ExpressionValue = ['clamp', ['*', t, COLORMAP_SIZE - 1], 0, COLORMAP_SIZE - 1];
    return ['palette', idx, hex];
  };

  if (kind === 'mapbox_rgb') {
    // Mapbox Terrain-RGB: height = -10000 + (R*65536 + G*256 + B) * 0.1.
    // R = band1*255, G = band2*255, B = band3*255 → fold the *255 in:
    //   raw = band1*16711680 + band2*65280 + band3*255.
    const raw: ExpressionValue = [
      '+',
      ['+', ['*', ['band', 1], 16711680], ['*', ['band', 2], 65280]],
      ['*', ['band', 3], 255],
    ];
    const height: ExpressionValue = ['+', -10000, ['*', raw, 0.1]];
    return hypsometricColor(height);
  }

  if (kind === 'rg16_fixed') {
    const value: ExpressionValue = ['+', ['*', rg16(1, 2), scale], offset];
    // Build the case chain: invalid (alpha mask) → transparent; optional
    // transparent_below → transparent; otherwise the ramp.
    const cases: ExpressionValue[] = [
      ['<', ['band', 4], 0.5], TRANSPARENT,
    ];
    if (transparentBelow !== undefined && transparentBelow !== null) {
      cases.push(['<', value, transparentBelow], TRANSPARENT);
    }
    return ['case', ...cases, ramp(value)] as ExpressionValue;
  }

  // vector_rg_ba magnitude. No-data sentinel = (0,0,0,0): all four bands ≈ 0.
  const u: ExpressionValue = ['+', ['*', rg16(1, 2), scale], offset];
  const v: ExpressionValue = ['+', ['*', rg16(3, 4), scale], offset];
  const mag: ExpressionValue = ['sqrt', ['+', ['*', u, u], ['*', v, v]]];
  const eps = 0.5 / 255;
  const isNoData: ExpressionValue = [
    'all',
    ['<', ['band', 1], eps],
    ['<', ['band', 2], eps],
    ['<', ['band', 3], eps],
    ['<', ['band', 4], eps],
  ];
  return ['case', isNoData, TRANSPARENT, ramp(mag)] as ExpressionValue;
}

/** Build a raster layer from a pre-discovered STAC item (synchronous). */
function fromItem(opts: MercatorRasterLayerOpts, item: DiscoveredItem): MercatorRasterTileLayer {
  return new MercatorRasterTileLayer(opts, item);
}

/** Discover the latest STAC item for the dataset and build a raster layer. */
async function create(opts: MercatorRasterLayerOpts): Promise<MercatorRasterTileLayer> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorRasterLayer = { create, fromItem };
export type { MercatorRasterTileLayer };
