// STAC traversal used by MercatorLayer.create() to discover the
// latest item for a dataset.

import { fetchJson, resolveUrl } from './urls';
import type {
  DiscoveredItem,
  CatalogJson,
  CollectionJson,
  ItemJson,
} from './discover-types';

// Re-exported so existing `import type { DiscoveredItem } from '../core/discover'`
// imports across the bindings keep working after the type/logic split.
export type { DiscoveredItem };

/**
 * Walk the catalog, find the dataset's collection, load the newest
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

  // Pick the newest cycle's analysis (lowest forecast hour). Item hrefs are
  // "<cycle>/<fhour>/item.json" with `cycle` = YYYYMMDDHH and `fhour` =
  // fNNN - both zero-padded, so lexical compare is chronological. We sort by
  // (cycle desc, fhour asc) rather than trusting list position: the pipeline
  // emits items newest-cycle-FIRST, so a naive "last link is newest" picks
  // the OLDEST cycle — which the retention sweep has usually deleted, giving
  // a 404 on the item fetch. Comparing explicitly also guarantees we land on
  // a cycle the sweep keeps (the newest), independent of how many stale
  // cycles the collection still lists.
  const itemLinks = collection.links.filter((l) => l.rel === 'item');
  if (itemLinks.length === 0) {
    throw new Error(`@mercator-blue/sdk: no items in collection ${collectionUrl}`);
  }
  const latestItemHref = itemLinks
    .map((l) => l.href)
    .sort((a, b) => {
      const [ca, fa] = a.split('/');
      const [cb, fb] = b.split('/');
      if (ca !== cb) return ca < cb ? 1 : -1; // cycle descending
      return fa < fb ? -1 : fa > fb ? 1 : 0;   // fhour ascending (f000 first)
    })[0];
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

