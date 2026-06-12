// URL + fetch helpers shared across the SDK: turning a (DiscoveredItem,
// apiKey) pair into concrete URL templates the renderers/overlays consume,
// plus the small relative-URL resolve and JSON-fetch primitives the STAC
// walker needs.

/**
 * Default STAC catalog URL. Used by every `MercatorLayer.create` call
 * when the caller doesn't override `catalogUrl`. Keep in one place so
 * the SDK only needs editing here when the live endpoint moves.
 *
 * The previous endpoint `tile-api.mercator.workers.dev` still resolves
 * (Cloudflare keeps the workers.dev subdomain alongside the custom
 * domain), so older SDK builds keep working.
 */
export const DEFAULT_CATALOG_URL = 'https://api.mercator.blue/catalog.json';

/**
 * Append `?apiKey=<key>` (or `&apiKey=<key>` if the template already
 * has a query string) to a URL template. Returns the template
 * unchanged when no key is provided.
 *
 * Used because both the tile API and the underlying overlay factories
 * accept plain URL templates without a way to inject Authorization
 * headers; the Worker accepts the key on either header or query
 * string.
 */
export function withApiKey(template: string, apiKey: string | undefined): string {
  if (!apiKey) return template;
  const sep = template.includes('?') ? '&' : '?';
  return `${template}${sep}apiKey=${encodeURIComponent(apiKey)}`;
}

/**
 * Landmask / contour URL templates in STAC are site-absolute paths like
 * `/tiles/landmask/2026/static/{z}/{x}/{y}.png`. Prepend the origin
 * derived from the item base URL so the consumer gets a fully-resolved
 * URL it can fetch directly.
 */
export function absolutiseUrl(template: string, itemBase: string): string {
  if (template.startsWith('http://') || template.startsWith('https://')) {
    return template;
  }
  const origin = new URL(itemBase).origin;
  const path = template.startsWith('/') ? template : `/${template}`;
  return `${origin}${path}`;
}

/** 
 * Expand a `{z}/{x}/{y}` slippy-tile URL template into a concrete URL. 
 */
export function expandTileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/** 
 * Resolve a relative href against a base URL via the URL constructor
 * (which has built-in support for absolute, root-relative, and dot-segment 
 * hrefs). 
 * 
 * @param base The base URL to resolve against (e.g. the catalog or item URL).
 * @param href The relative or absolute URL to resolve.
 * @returns The fully resolved absolute URL.
 */
export function resolveUrl(base: string, href: string): string {
  return new URL(href, base).toString();
}

/**
 * Fetch a URL and parse the response body as JSON.
 *
 * A thin wrapper over `fetch` used by the STAC walker for catalog,
 * collection, and item documents. The caller declares the expected shape via
 * the type parameter; the parsed body is cast to it, not validated at runtime.
 *
 * @typeParam T The expected JSON shape (returned as-is, unchecked).
 * @param url Absolute URL to fetch.
 * @returns The parsed JSON body, typed as `T`.
 * @throws Error if the response status is not 2xx (the body is not read).
 */
export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`@mercator-blue/sdk: fetch ${url} → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
