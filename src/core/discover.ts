// Minimal STAC traversal used by MercatorLayer.create() to discover the
// latest item for a dataset. Walks the public STAC tree over plain HTTP
// — no special caching, no Cloudflare service bindings (those are
// site-only concerns; the SDK runs in customer browsers).

/** A skeletal STAC Item shape — the SDK only reads the fields it needs. */
export interface DiscoveredItem {
  id: string;
  cycle: string;
  fhour: string;
  collectionName: string;
  encoding: {
    kind: string;
    scale: number;
    offset: number;
    components?: string[];
  };
  tile: {
    minzoom: number;
    maxzoom: number;
  };
  visualization?: {
    particle_speed_scale?: number;
    vmin?: number;
    vmax?: number;
    colormap?: string | { stops: Array<[number, string]> };
    scale_type?: 'linear' | 'log';
    transparent_below?: number;
    alpha_by_value?: boolean;
  };
  landmask?: {
    url_template: string;
    accepts: number[];
    maxzoom: number;
  };
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

interface CatalogJson {
  links: Array<{ rel: string; href: string; title?: string }>;
}

interface CollectionJson {
  links: Array<{ rel: string; href: string }>;
}

interface ItemJson {
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

/**
 * Walk the catalog → find the dataset's collection → load the newest
 * item. Returns a normalised {@link DiscoveredItem} for the SDK's
 * layer-builder to consume.
 */
export async function discoverLatestItem(
  catalogUrl: string,
  datasetName: string,
): Promise<DiscoveredItem> {
  const catalog: CatalogJson = await fetchJson(catalogUrl);

  // Find the collection link for this dataset. Hrefs are relative to the
  // catalog URL. The pipeline emits `tiles/<name>/collection.json`, but
  // be tolerant of catalogs without the prefix too.
  const childLink = catalog.links.find((l) => {
    if (l.rel !== 'child') return false;
    return l.href.endsWith(`/${datasetName}/collection.json`)
      || l.href === `${datasetName}/collection.json`
      || l.href === `tiles/${datasetName}/collection.json`;
  });
  if (!childLink) {
    throw new Error(`@mercator-blue/sdk: dataset "${datasetName}" not found in catalog ${catalogUrl}`);
  }

  const collectionUrl = resolveUrl(catalogUrl, childLink.href);
  const collection: CollectionJson = await fetchJson(collectionUrl);

  // Items are listed in lexical order; the newest cycle is last.
  const itemLinks = collection.links.filter((l) => l.rel === 'item');
  if (itemLinks.length === 0) {
    throw new Error(`@mercator-blue/sdk: no items in collection ${collectionUrl}`);
  }
  const latestItemHref = itemLinks[itemLinks.length - 1].href;
  const itemUrl = resolveUrl(collectionUrl, latestItemHref);
  const item: ItemJson = await fetchJson(itemUrl);

  // Extract cycle / fhour from the item href so we can build asset URLs.
  // Format: "<cycle>/<fhour>/item.json" — works for forecast items
  // ("2026051412/f000/...") and static items ("2026/static/...").
  const parts = latestItemHref.split('/');
  const [cycle, fhour] = parts;
  const itemBase = itemUrl.replace(/\/item\.json$/, '');

  return {
    id: item.id,
    cycle,
    fhour,
    collectionName: item.collection,
    encoding: item.properties['mercator:encoding'],
    tile: item.properties['mercator:tile'],
    visualization: item.properties['mercator:visualization'],
    landmask: item.properties['mercator:landmask'],
    contour: item.properties['mercator:contour'],
    itemBase,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`@mercator-blue/sdk: fetch ${url} → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Resolve a relative href against a base URL, mimicking how browsers
 * resolve URLs in HTML. We use the URL constructor - handles absolute
 * URLs, root-relative, dot-segments, etc. for us.
 */
function resolveUrl(base: string, href: string): string {
  return new URL(href, base).toString();
}
