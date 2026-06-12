/**
 * MVT fetch + parse helper for contour LineStrings.
 *
 * Contour MVT pyramids are served by the tile API at the URL template
 * carried in `mercator:contour.url_template` on each STAC item (e.g.
 * `tiles/temp2m/2026051412/f000/contours/{z}/{x}/{y}.pbf`). Each tile
 * is a gzipped Mapbox Vector Tile with one layer (`source_layer`,
 * conventionally "contours") of LineString features. Feature properties:
 *   - `value`    - the contour's level in the dataset's native unit
 *   - `interval` - which preset interval bucket the line was generated in
 *
 * The custom WebGL contour-line layer fetches MVTs through this helper
 * (rather than reading from the host's vector source) because:
 *  - the host's vector source isn't exposed cross-host (MapLibre's API
 *    differs from Mapbox's; Leaflet/Cesium/etc don't expose one at all)
 *  - we need the raw LineString coordinates in mercator-world units to
 *    push into our shader's vertex buffer
 *
 * The host still maintains its own vector source for the label SYMBOL
 * layer — duplicating the fetch+parse is the tradeoff for not
 * re-implementing along-line label placement.
 */

import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import { expandTileUrl } from './urls';

// LRU bounded by tile count. ~tile cap matters because each parsed tile
// holds an array of Float64 coords proportional to its feature count;
// contour MVTs are small but a long pan/zoom session can accumulate
// hundreds. 512 tiles is a few MB at most.
const TILE_CACHE_MAX = 512;

// Special sentinel for "tile fetch failed permanently (404 / network)".
// We cache this so we don't refetch a known-missing tile every frame.
const TILE_MISSING: unique symbol = Symbol('tile-missing');
type TileMissing = typeof TILE_MISSING;

export interface ContourFeature {
  value: number;
  interval: number;
  /** Array of polylines (a feature can be a multi-LineString). Each
   *  polyline is a flat Float32Array of [x0,y0, x1,y1, ...] in
   *  mercator-world coords ([0,1]²). */
  polylines: Float32Array[];
}

interface LoadedEntry {
  features: ContourFeature[];
}

type TileEntry = LoadedEntry | Promise<void> | TileMissing;

export interface ContourTileCacheOpts {
  urlTemplate: string;
  sourceLayer?: string;
}

export class ContourTileCache {
  private urlTemplate: string;
  private sourceLayer: string;
  private cache: Map<string, TileEntry>;
  private pending: Set<string>;

  constructor({ urlTemplate, sourceLayer = 'contours' }: ContourTileCacheOpts) {
    this.urlTemplate = urlTemplate;
    this.sourceLayer = sourceLayer;
    this.cache = new Map();
    this.pending = new Set();
  }

  /**
   * Synchronous lookup. Returns the parsed features array if loaded,
   * `null` if known-missing, `undefined` if not in cache (the caller
   * should also call `ensure()` to kick off the fetch).
   */
  get(z: number, x: number, y: number): ContourFeature[] | null | undefined {
    const entry = this.cache.get(keyOf(z, x, y));
    if (entry === undefined) return undefined;
    if (entry === TILE_MISSING) return null;
    if (entry instanceof Promise) return undefined;
    return entry.features;
  }

  /**
   * Kick off a fetch for the tile if it isn't cached or in flight.
   * Returns true if a new fetch was started (caller can use the count
   * to schedule a repaint when fetches resolve).
   */
  ensure(z: number, x: number, y: number, onLoaded?: () => void): boolean {
    const k = keyOf(z, x, y);
    if (this.cache.has(k)) return false;
    if (this.pending.has(k)) return false;

    this.pending.add(k);
    const url = expandTileUrl(this.urlTemplate, z, x, y);

    const promise = fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          // 404 is normal (sparse pyramids); other errors get logged
          // once but cached the same way — we don't want to spam refetch.
          if (res.status !== 404) {
            console.warn(`[contour-tiles] ${url} → ${res.status}`);
          }
          this.cache.set(k, TILE_MISSING);
          return;
        }
        const buf = await res.arrayBuffer();
        const features = parseMvt(buf, this.sourceLayer, z, x, y);
        this._evictIfFull();
        this.cache.set(k, { features });
      })
      .catch((err) => {
        console.warn(`[contour-tiles] ${url} failed`, err);
        this.cache.set(k, TILE_MISSING);
      })
      .finally(() => {
        this.pending.delete(k);
        if (onLoaded) onLoaded();
      });

    this.cache.set(k, promise);
    return true;
  }

  private _evictIfFull(): void {
    if (this.cache.size < TILE_CACHE_MAX) return;
    // Plain Map iteration is insertion order — drop the oldest 1/8 in
    // bulk so we don't churn on the boundary. Pending promises are
    // skipped (they'd resurrect themselves on resolve into a stale slot).
    const toEvict = Math.floor(TILE_CACHE_MAX / 8);
    let evicted = 0;
    for (const k of this.cache.keys()) {
      if (evicted >= toEvict) break;
      const v = this.cache.get(k);
      if (v instanceof Promise) continue;
      this.cache.delete(k);
      evicted++;
    }
  }

  clear(): void {
    this.cache.clear();
    // Pending fetches resolve into an empty cache — harmless, the next
    // ensure() will refetch if needed.
  }

  /** True while at least one tile fetch is in flight. Used by the layer
   *  to distinguish "buffer empty because still loading" (keep stale)
   *  from "buffer empty because nothing matches" (clear). */
  hasPending(): boolean {
    return this.pending.size > 0;
  }
}

function keyOf(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * Parse the MVT, extract LineString features from the named source
 * layer, project tile-local coords to mercator-world ([0,1]²), and
 * return a flat list of segments + properties.
 */
function parseMvt(
  buf: ArrayBuffer,
  sourceLayer: string,
  z: number, x: number, y: number,
): ContourFeature[] {
  const tile = new VectorTile(new Protobuf(buf));
  const layer = tile.layers[sourceLayer];
  if (!layer) return [];

  const n = 2 ** z;
  // World coord scale: tile (x,y) at zoom z covers x/n .. (x+1)/n
  // horizontally. MVT local coords are 0..extent within the tile.
  // So worldX = x/n + local_x / (extent * n).
  // Hoist the inverse to avoid per-vertex divides.
  const extent = layer.extent || 4096;
  const invExtN = 1 / (extent * n);
  const worldOriginX = x / n;
  const worldOriginY = y / n;

  const out: ContourFeature[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    // 2 = LineString. (1 = Point, 3 = Polygon.)
    if (f.type !== 2) continue;

    const value = numericProp(f.properties.value);
    const interval = numericProp(f.properties.interval);
    if (value == null || interval == null) continue;

    // loadGeometry() returns Point[][]: one inner array per line in a
    // multi-LineString. Flatten each to a Float32Array of world coords.
    const rings = f.loadGeometry();
    const polylines: Float32Array[] = [];
    for (const ring of rings) {
      if (ring.length < 2) continue;
      const flat = new Float32Array(ring.length * 2);
      for (let j = 0; j < ring.length; j++) {
        flat[j * 2] = worldOriginX + ring[j].x * invExtN;
        flat[j * 2 + 1] = worldOriginY + ring[j].y * invExtN;
      }
      polylines.push(flat);
    }
    if (polylines.length === 0) continue;

    out.push({ value, interval, polylines });
  }
  return out;
}

function numericProp(v: number | string | boolean | undefined): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
