/**
 * Mercator + slippy-XYZ tile-coordinate helpers shared across every
 * SDK binding (Mapbox/MapLibre custom layers, deck.gl Layer subclasses,
 * and future Leaflet / Cesium ports).
 *
 * Two coordinate systems are exposed:
 *
 *   - **Mercator world**: a [0, 1]² square. `mx = 0` at lng = −180°,
 *     `mx = 1` at +180°. `my = 0` at the Mercator north clip
 *     (~+85.05°), `my = 1` at the south clip (~−85.05°). This is the
 *     natural shape for resolution-independent tile math — it composes
 *     with zoom by simple multiplication.
 *
 *   - **Slippy XYZ**: the canonical `{z}/{x}/{y}` integer-tile
 *     addressing. `tile_x = mx · 2^z`, `tile_y = my · 2^z`. Functions
 *     here return floats (mercator-world fractional position); caller
 *     applies `Math.floor()` for the integer tile index OR keeps the
 *     fractional part as a within-tile pixel offset.
 *
 * Latitudes outside the ±85.0511° band can't be represented in
 * Mercator (the projection diverges at the poles). All `lat → ...`
 * functions clip to that band silently.
 */

/** Latitude clip imposed by the Mercator projection. Values further
 *  from the equator than this are clamped to ±this before projection. */
export const MERCATOR_LAT_CLIP = 85.0511;

/** EPSG:3857 Web-Mercator half-world width in metres — the distance from
 *  the prime meridian to ±180° at the equator. Used to convert between
 *  EPSG:3857 (metres) and mercator-world units (0..1). */
export const HALF_MERCATOR = 20037508.342789244;

/** EPSG:3857 full world extent in metres (2 × {@link HALF_MERCATOR}). */
export const WORLD_EXT_3857 = 2 * HALF_MERCATOR;

// --- lng/lat ↔ mercator world [0, 1]² ------------------------------

/** Longitude (degrees) → mercator-world x in [0, 1]. */
export function lngToMx(lng: number): number {
  return (lng + 180) / 360;
}

/** Latitude (degrees) → mercator-world y in [0, 1]. Clipped to ±85.05°. */
export function latToMy(lat: number): number {
  const c = Math.max(-MERCATOR_LAT_CLIP, Math.min(MERCATOR_LAT_CLIP, lat));
  const r = (c * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

/** Combined lng/lat (degrees) → mercator-world `[mx, my]` in [0, 1]². */
export function lngLatToMercator(lng: number, lat: number): [number, number] {
  return [lngToMx(lng), latToMy(lat)];
}

/** Mercator-world x → longitude (degrees). */
export function mxToLng(mx: number): number {
  return mx * 360 - 180;
}

/** Mercator-world y → latitude (degrees). */
export function myToLat(my: number): number {
  const m = Math.PI - 2 * Math.PI * my;
  return (Math.atan(0.5 * (Math.exp(m) - Math.exp(-m))) * 180) / Math.PI;
}

// --- lng/lat ↔ slippy tile XYZ (fractional) ------------------------

/** Longitude (degrees) → fractional slippy tile x at zoom z. */
export function lngToTileX(lng: number, z: number): number {
  return lngToMx(lng) * Math.pow(2, z);
}

/** Latitude (degrees) → fractional slippy tile y at zoom z. Clipped to ±85.05°. */
export function latToTileY(lat: number, z: number): number {
  return latToMy(lat) * Math.pow(2, z);
}

/** Combined lng/lat → fractional slippy tile `[x, y]` at zoom z. */
export function lngLatToTileXY(
  lng: number,
  lat: number,
  z: number,
): [number, number] {
  const n = Math.pow(2, z);
  return [lngToMx(lng) * n, latToMy(lat) * n];
}

/** Slippy tile x at zoom z → longitude (degrees). */
export function tileXToLng(x: number, z: number): number {
  return mxToLng(x / Math.pow(2, z));
}

/** Slippy tile y at zoom z → latitude (degrees). */
export function tileYToLat(y: number, z: number): number {
  return myToLat(y / Math.pow(2, z));
}

/** Tile-pixel position (integer tile indices `tx, ty` plus 0..256
 *  in-tile pixel offset `px, py`) at zoom z → lng/lat (degrees). */
export function tilePixelToLngLat(
  z: number,
  tx: number,
  ty: number,
  px: number,
  py: number,
): [number, number] {
  const n = Math.pow(2, z);
  return [mxToLng((tx + px / 256) / n), myToLat((ty + py / 256) / n)];
}

// --- Util ----------------------------------------------------------

/** Positive-result modulo: `posMod(-1, 4) === 3` (vs `-1 % 4 === -1`
 *  in JS). Useful for wrapping mercator-x / tile-x across the
 *  antimeridian and for modular indexing in general. */
export function posMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}
