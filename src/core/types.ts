// Type definitions for the SDK public surface.

/**
 * The visualisations the SDK can render. Every {@link MercatorLayer.create}
 * call must specify one explicitly; there is no auto-default. The encoding
 * kind constrains which viz values are valid:
 *
 * - `raster` — colormapped raster of decoded values. Works on `rg16_fixed`
 *   (scalars), `vector_rg_ba` (speed magnitude), and `mapbox_rgb` (elevation
 *   with hypsometric tinting).
 * - `streamlines` — animated particles advected by the decoded vector
 *   field. `vector_rg_ba` only.
 * - `arrows` — direction-arrow lattice coloured by speed magnitude.
 *   `vector_rg_ba` only.
 * - `contours` — labelled isolines from a precomputed MVT pyramid.
 *   Requires the dataset to have `mercator:contour` published.
 * - `values` — numeric value labels on a viewport-driven lattice.
 *   Works on `rg16_fixed` (value), `vector_rg_ba` (magnitude), `mapbox_rgb`
 *   (altitude).
 * - `bounds` — slippy-tile-boundary debug overlay. No dataset needed.
 */
export type VisualizationKind =
  | 'raster'
  | 'streamlines'
  | 'arrows'
  | 'contours'
  | 'values'
  | 'bounds';

/**
 * The value-encoded PNG tile encodings the SDK knows how to decode to
 * numeric values. Used by every layer that reads tile bytes — raster,
 * streamlines, arrows, value-labels, contours.
 *
 * - `rg16_fixed`: 16-bit fixed-point scalar (R = high byte, G = low byte,
 *   alpha = validity/coverage). Temperature, pressure, humidity, …
 * - `vector_rg_ba`: two 16-bit fixed-point components (R+G = u, B+A = v).
 *   (0,0,0,0) is the no-data sentinel. Wind, currents.
 * - `mapbox_rgb`: 24-bit signed integer (Mapbox Terrain-RGB style). Every
 *   pixel is a valid value; alpha is unused. Elevation.
 *
 * The pipeline's full encoding-kind vocabulary (see
 * `schemas/mercator-encoding.ts`) is wider — it also includes
 * `image_rgba`, a pre-coloured display-ready encoding that no decoder
 * here handles because there's no numeric value to recover.
 */
export type EncodingKind = 'rg16_fixed' | 'vector_rg_ba' | 'mapbox_rgb';

/** A single colormap anchor: `[position in 0..1, "#rrggbb"]`. */
export type ColormapStop = [number, string];

/** An ordered list of colormap stops — the data form of a palette.
 *  Sampling between stops is linear in sRGB. The bundled `PALETTES`
 *  registry is a `Record<string, Colormap>`. */
export type Colormap = ColormapStop[];

/**
 * Colormap specification. One of:
 * - A preset name from the bundled palette set (e.g. `'viridis'`, `'rdbu'`,
 *   `'magma'`). See the docs site for the full list.
 * - An explicit gradient as ordered `[position 0..1, hex color]` stops.
 */
export type ColormapSpec =
  | string
  | { stops: Colormap };

// ---- Discriminated-union options for `MercatorLayer.create` ----
//
// One variant per visualisation kind. The discriminator is `viz`, which
// is required on every call — there is no auto-dispatch from encoding
// kind. Each binding's `MercatorLayer.create` accepts
// `MercatorLayerOptions & {host extras}`, where the host extras carry
// binding-specific knobs (Mapbox `slot`/`beforeId`, Leaflet `pane`,
// OpenLayers `zIndex`, ...) that aren't portable.

interface MercatorBaseOptions {
  /** Layer id. Must be unique within the host map. Default: derived
   *  from the dataset name + viz. */
  id?: string;
}

interface MercatorDataLayerOptions extends MercatorBaseOptions {
  /**
   * Dataset name as it appears in the mercator.blue STAC catalog.
   * Examples: `'wind10m'`, `'temp2m'`, `'currents'`, `'elevation'`.
   * The full list is at https://mercator.blue/datasets.
   */
  dataset: string;

  /**
   * Your API key (format: `mk_<16 hex>.<64 hex>`). Get one from the
   * dashboard at https://mercator.blue/dashboard. The SDK appends it
   * as `?apiKey=<key>` on tile fetches.
   *
   * Never embed a key with billing access in client-side code: use a
   * scoped key with a tight monthly quota, or proxy through your own
   * backend.
   */
  apiKey: string;

  /**
   * Catalog root URL. Default: the SDK's `DEFAULT_CATALOG_URL`
   * (`https://api.mercator.blue/catalog.json`). Override for self-hosted
   * deployments or staging environments.
   */
  catalogUrl?: string;
}

/** Cross-viz colormap range + opacity. Shared by raster, streamlines, arrows. */
interface MercatorColormapOptions {
  /** Lower bound of the colormap / colour ramp. Default: dataset's
   *  `mercator:visualization.vmin`. */
  vmin?: number;
  /** Upper bound of the colormap / colour ramp. Default: dataset's
   *  `mercator:visualization.vmax`. */
  vmax?: number;
  /** Overall layer opacity, 0..1. Default is viz-dependent. */
  opacity?: number;
  /** Colormap preset name (e.g. `'viridis'`, `'rdbu'`) or explicit
   *  `{stops: [[pos, '#hex'], ...]}`. Default: dataset's
   *  `mercator:visualization.colormap`. */
  colormap?: ColormapSpec;
}

/** `viz: 'raster'` — colormapped raster of the decoded scalar / magnitude / altitude. */
export interface MercatorRasterOptions
  extends MercatorDataLayerOptions, MercatorColormapOptions {
  viz: 'raster';
  /** Bilinear interpolation in decoded-value space. `true` for smooth
   *  shading, `false` for source-pixel-honest blocky display. Default: `true`. */
  smooth?: boolean;
  /** How decoded values map to colormap position. `'linear'` (default)
   *  for normal fields; `'log'` for skewed distributions like
   *  precipitation. */
  scaleType?: 'linear' | 'log';
  /** Pixels with decoded value ≤ this become transparent so the basemap
   *  shows through. Useful for precipitation ("show nothing below 0.1 mm/h").
   *  Default: no threshold. */
  transparentBelow?: number;
  /** When `true`, alpha fades with colormap position so low-magnitude
   *  pixels are nearly transparent and high-magnitude pixels fully
   *  opaque. Useful for cloud-cover overlays. Default: `false`. */
  alphaByValue?: boolean;
}

/** `viz: 'streamlines'` — animated particles advected by the vector field.
 *  Requires `vector_rg_ba` encoding. */
export interface MercatorStreamlinesOptions
  extends MercatorDataLayerOptions, MercatorColormapOptions {
  viz: 'streamlines';
  /** Number of simulated particles. Default: 8000. */
  particleCount?: number;
  /** Particle dot size in pixels. Default: 3. */
  pointSize?: number;
  /** Per-frame advection scale: mercator-units per (m/s) at view zoom 0.
   *  Default: dataset's `mercator:visualization.particle_speed_scale` or 6e-5. */
  speedScale?: number;
  /** Frames before a particle is forcibly recycled. Default: 600 (≈10 s at 60 fps). */
  maxAge?: number;
  /** Trail-buffer fade per frame, 0..1. Closer to 1 = longer trails. Default: 0.99. */
  fade?: number;
  /** Map particle colour to speed via the colormap. When `false`, all
   *  particles paint white. Default: `true`. */
  colorBySpeed?: boolean;
}

/** `viz: 'arrows'` — direction-arrow lattice coloured by speed magnitude.
 *  Requires `vector_rg_ba` encoding. */
export interface MercatorArrowsOptions
  extends MercatorDataLayerOptions, MercatorColormapOptions {
  viz: 'arrows';
  /** Pin sampling tile zoom regardless of map zoom. Useful for pyramid-
   *  consistency tests across zoom levels. */
  lockZoom?: number;
  /** Speed (m/s) at which arrows hit max length AND the colour ramp top
   *  stop. Default: dataset's `mercator:visualization.vmax`. */
  speedRef?: number;
  /** Arrow line width in CSS pixels. Default 1.5. */
  lineWidth?: number;
}

/** `viz: 'contours'` — labelled isolines from a precomputed MVT pyramid.
 *  Requires the dataset to have `mercator:contour` published. */
export interface MercatorContoursOptions extends MercatorDataLayerOptions {
  viz: 'contours';
  /** Initial contour interval in the dataset's encoded unit (e.g. 5 →
   *  every 5 °C). Must match one of the pyramid's preset intervals.
   *  Default: dataset's `mercator:contour.default_interval`. */
  initialInterval?: number;
  /** CSS colour for contour lines. Default `'#4b5563'` (gray-600). */
  lineColor?: string;
  /** Line opacity, 0..1. Default 1. */
  lineOpacity?: number;
  /** Stroke width in CSS pixels for thin (non-bold) lines. Default 0.7. */
  lineWidth?: number;
  /** Stroke width in CSS pixels for bold lines (contour values divisible
   *  by 10). Default 1.4. */
  boldLineWidth?: number;
}

/** `viz: 'values'` — numeric value labels on a viewport-derived lattice.
 *  The "temperatures-on-a-grid" look. For vector datasets, shows the
 *  speed MAGNITUDE; for `mapbox_rgb`, the altitude. */
export interface MercatorValueLabelsOptions extends MercatorDataLayerOptions {
  viz: 'values';
  /** Pin sampling tile zoom regardless of map zoom. */
  lockZoom?: number;
  /** Decimal places for the default formatter. Default: 0 for wide-range
   *  fields, 1 for low-magnitude fields (`vmax < 10`). */
  digits?: number;
  /** Custom value→string formatter. Overrides `digits`. */
  format?: (value: number) => string;
  /** Approximate number of labels across the viewport. Default 18. */
  targetAcross?: number;
}

/** `viz: 'bounds'` — slippy-XYZ tile-boundary debug overlay. No dataset
 *  needed — draws the mercator tile grid at the current map zoom. */
export interface MercatorTileBoundariesOptions extends MercatorBaseOptions {
  viz: 'bounds';
  /** Lower bound on tile z. Default 0. */
  minzoom?: number;
  /** Upper bound on tile z. Default: no cap. */
  maxzoom?: number;
  /** Line width in CSS pixels. Default 1.5. */
  lineWidth?: number;
}

/**
 * Constructor options for {@link MercatorLayer.create}. Discriminated by
 * `viz`. Each binding's `MercatorLayer.create` accepts this union
 * (optionally intersected with that binding's host-specific extras like
 * `slot`/`pane`/`zIndex`).
 *
 * ```ts
 * const layer = await MercatorLayer.create({
 *   dataset: 'wind10m',
 *   apiKey: 'mk_...',
 *   viz: 'streamlines',
 *   particleCount: 6000,
 * });
 * ```
 */
export type MercatorLayerOptions =
  | MercatorRasterOptions
  | MercatorStreamlinesOptions
  | MercatorArrowsOptions
  | MercatorContoursOptions
  | MercatorValueLabelsOptions
  | MercatorTileBoundariesOptions;

/**
 * The MapLibre custom-layer contract. We declare it locally so the SDK
 * has no hard dependency on `maplibre-gl` types - useful because the
 * same shape is accepted by Mapbox GL JS and (via interop) by deck.gl.
 *
 * Consumers don't normally need this type - `MercatorLayer` already
 * implements it. It's exported for advanced cases where someone wants
 * to wrap or extend the layer.
 */
export interface CustomLayerInterface {
  readonly id: string;
  readonly type: 'custom';
  readonly renderingMode?: '2d' | '3d';
  onAdd?(map: unknown, gl: WebGL2RenderingContext): void;
  onRemove?(map: unknown, gl: WebGL2RenderingContext): void;
  prerender?(gl: WebGL2RenderingContext, args: unknown): void;
  render(gl: WebGL2RenderingContext, args: unknown): void;
}
