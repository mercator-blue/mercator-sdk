// URL construction helpers shared between MercatorLayer and the overlay
// factories. Both pipelines turn a (DiscoveredItem, apiKey) pair into
// concrete URL templates the underlying renderers/overlays consume.

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
 * Landmask URL templates in STAC are absolute paths like
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
