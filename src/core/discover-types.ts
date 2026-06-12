// Type shapes for the STAC discovery walker (./discover.ts): the normalised
// item the SDK consumes, plus the skeletal wire shapes of the catalog /
// collection / item documents it reads.

/**
 * A skeletal STAC Item shape — the SDK only reads the fields it needs.
 */
export interface DiscoveredItem {
  /** STAC item id, e.g. `"gfs/wind10m/2026051200/f000"`. */
  id: string;
  /** Model run cycle, `YYYYMMDDHH` UTC (e.g. `"2026051200"`). */
  cycle: string;
  /** Forecast hour, zero-padded `fNNN` (e.g. `"f000"` = analysis). */
  fhour: string;
  /** Collection (dataset) name this item belongs to, e.g. `"wind10m"`. */
  collectionName: string;
  /** Value-encoding spec: how to decode the tile PNG bytes back to numbers. */
  encoding: {
    /** Encoding kind, e.g. `"rg16_fixed"`, `"vector_rg_ba"`, `"mapbox_rgb"`. */
    kind: string;
    /** Decode multiplier: `value = raw * scale + offset`. */
    scale: number;
    /** Decode offset: `value = raw * scale + offset`. */
    offset: number;
    /** Component names for vector encodings (e.g. `["u", "v"]`). */
    components?: string[];
  };
  /** Tile-pyramid zoom range available for this item. */
  tile: {
    /** Shallowest zoom level published. */
    minzoom: number;
    /** Deepest zoom level published (native-resolution match + 1). */
    maxzoom: number;
  };
  /** Default visualization hints from `mercator:visualization` (colormap, range, ...). */
  visualization?: {
    particle_speed_scale?: number;
    vmin?: number;
    vmax?: number;
    colormap?: string | { stops: Array<[number, string]> };
    scale_type?: 'linear' | 'log';
    transparent_below?: number;
    alpha_by_value?: boolean;
  };
  /** Landmask config for ocean datasets (mask tile URL + accepted pixel codes). */
  landmask?: {
    url_template: string;
    accepts: number[];
    maxzoom: number;
  };
  /** Contour-pyramid config for scalar datasets (MVT URL + interval presets). */
  contour?: {
    url_template: string;
    source_layer: string;
    presets: number[];
    default_interval: number;
    unit: string;
    minzoom: number;
    maxzoom: number;
    user_filter_min_zoom: number;
    coarsest_interval: number;
  };
  /** Base URL for asset / tile paths under this item. */
  itemBase: string;
}

/** Minimal shape of a STAC Catalog document (only the links we walk). */
export interface CatalogJson {
  links: Array<{ rel: string; href: string; title?: string }>;
}

/** Minimal shape of a STAC Collection document (only the links we walk). */
export interface CollectionJson {
  links: Array<{ rel: string; href: string }>;
}

/** Minimal shape of a STAC Item document, with the `mercator:*` extension
 *  properties the SDK reads to build a {@link DiscoveredItem}. */
export interface ItemJson {
  id: string;
  collection: string;
  properties: {
    'mercator:encoding': {
      id: string;
      kind: string;
      scale: number;
      offset: number;
      components?: string[];
    };
    'mercator:tile': {
      minzoom: number;
      maxzoom: number;
    };
    'mercator:visualization'?: {
      particle_speed_scale?: number;
      vmin?: number;
      vmax?: number;
      colormap?: string | { stops: Array<[number, string]> };
      scale_type?: 'linear' | 'log';
      transparent_below?: number;
      alpha_by_value?: boolean;
    };
    'mercator:landmask'?: {
      url_template: string;
      accepts: number[];
      maxzoom: number;
    };
    'mercator:contour'?: {
      url_template: string;
      source_layer: string;
      presets: number[];
      default_interval: number;
      unit: string;
      minzoom: number;
      maxzoom: number;
      user_filter_min_zoom: number;
      coarsest_interval: number;
    };
    [k: string]: unknown;
  };
}
