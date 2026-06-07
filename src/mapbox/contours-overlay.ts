/**
 * Known limitation — Mapbox v3 globe mode + native-maxzoom labels:
 * at view zoom == source.maxzoom (e.g. z=5 for temp2m) in globe
 * projection, Mapbox's symbol-along-line placement drops every label.
 * MapLibre globe at the same zoom renders them fine; Mapbox flat-
 * Mercator at the same zoom renders them fine; overzoom (z=6+ globe)
 * brings them back. Verified 2026-05-25. Cause: Mapbox v3's
 * symbol-placement algorithm rejects a line as "too short for the
 * label" using the sphere-projected screen length, which shrinks
 * tile-edge-clipped fragments just enough to push them under the
 * threshold. Workaround would be pipeline-generated Point features
 * for labels (sketch in CLAUDE.md SDK follow-ups); accepted as-is
 * because it's a single zoom band on a single host in a single mode.
 *
 * Contour overlay: labelled isolines from a precomputed MVT pyramid
 * (see mercator_tiles/formats/contours.py).
 *
 * Each contour feature has:
 *   - `value`    — the contour's level in the dataset's encoded unit
 *                  (e.g. degrees C for temp2m)
 *   - `interval` — which preset interval bucket the line was generated
 *                  in (5, 10 °C, ...)
 *
 * Hybrid renderer:
 *   - LINES (with casing) are drawn by a custom WebGL layer
 *     (`contours-line-layer.js`). This is the only way to position
 *     contour lines below other custom layers (raster) on
 *     Mapbox v3 + Standard style — style `line` layers and custom
 *     WebGL layers don't share a render pass there, so array-order
 *     z-stacking doesn't compose across them. It's also the only path
 *     to support hosts that don't have a Mapbox-style vector source
 *     (Leaflet, OpenLayers, Cesium, Google Maps).
 *   - LABELS stay as Mapbox/MapLibre `symbol` layers fed by a vector
 *     source. Symbol layers DO render correctly on Mapbox v3
 *     (text-along-line gets the right pass), and re-implementing
 *     glyph-atlas + along-line placement + collision detection in
 *     custom WebGL is weeks of work that this PR doesn't take on. The
 *     duplication (vector source feeds labels; custom layer fetches
 *     the same tiles independently for the lines) is cheap — MVT
 *     contour tiles are small (a few KB each).
 *
 * The pipeline trims finer-interval features from world-view tiles to
 * keep them small. So at low zoom only the coarsest interval is
 * actually present in the pyramid. The renderer needs two regimes:
 *
 *   "low"  — filter forced to coarsest interval, hidden at zoom
 *            ≥ userFilterMinZoom.
 *   "high" — filter follows the user's interval pick, hidden at
 *            zoom < userFilterMinZoom.
 *
 * The custom line layer handles BOTH regimes itself by switching the
 * filter value based on map zoom. The symbol layers still come in two
 * pairs (LOW/HIGH) because they're filtered at the style-expression
 * level, not the buffer level.
 */

import { addContoursLineLayer } from './contours-line-layer';

const SRC_ID = '__contours_src';
const LABELS_LOW_ID = '__contours_labels_low';
const LABELS_HIGH_ID = '__contours_labels_high';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StyleExpression = any[];

function intervalFilter(i: number): StyleExpression {
  return ['==', ['get', 'interval'], i];
}

// Default font fallback covers Mapbox classic + Standard glyph
// endpoints. OpenFreeMap and other MapLibre-style endpoints often
// serve a SINGLE font (typically "Noto Sans Regular") and treat the
// whole fontstack as one literal URL segment — i.e. they 404 the
// fallback list rather than picking the first available font. Callers
// hitting one of those basemaps should override via `opts.textFont`.
const DEFAULT_LABEL_FONT = ['Open Sans Regular', 'Arial Unicode MS Regular'];

/** Mapbox/MapLibre style-spec layout/paint property maps. The full
 *  union of valid keys is host-version-specific and large, so we leave
 *  this loose — callers pass whatever their target host accepts. */
type StyleProps = Record<string, unknown>;

const DEFAULT_LABEL_LAYOUT: StyleProps = {
  'symbol-placement': 'line',
  'symbol-spacing': 250,
  'text-size': 10,
};
const DEFAULT_LABEL_PAINT: StyleProps = {
  // Match the line layer's gray-600 (softer than the previous near-black).
  'text-color': '#4b5563',
  'text-halo-color': 'rgba(255, 255, 255, 0.9)',
  'text-halo-width': 1.5,
};

export interface ContoursOverlayOpts {
  /** URL template for the contour MVT pyramid, with `{z}/{x}/{y}` placeholders.
   *  Typically `mercator:contour.url_template` from the STAC item, with the API
   *  key already injected. Fed to both the custom line layer's tile cache and
   *  the vector source backing the symbol labels. */
  urlTemplate: string;
  /** MVT source-layer name to read features from. Matches what the pipeline
   *  writes (see `mercator_tiles/formats/contours.py`); rarely overridden.
   *  Default `'contours'`. */
  sourceLayer?: string;
  /** Lowest zoom at which the overlay renders. Below this the line layer
   *  skips its rebuild and the symbol layers self-hide via their own
   *  minzoom. Default 0. */
  minzoom?: number;
  /** Highest zoom at which the overlay queries native tiles. Past this the
   *  symbol layers stop receiving new tiles (overzoom from the parent);
   *  the custom line layer follows the same cap. Default 5. */
  maxzoom?: number;
  /** Initial contour interval, in the dataset's encoded unit (e.g. 5 → every
   *  5 °C for temp2m). Must match one of the preset intervals the pipeline
   *  generated, otherwise the filter rejects every feature. Update later via
   *  the handle's `setInterval()`. */
  initialInterval: number;
  /** Unit suffix appended to each label (e.g. `'°C'`, `'hPa'`). Concatenated
   *  to the numeric value via a style expression; pass `''` for unitless
   *  fields. Default `''`. */
  unit?: string;
  /** Zoom below which the pyramid is sparse and the filter is forced to
   *  `coarsestInterval`. The user's `initialInterval` only takes effect at
   *  or above this zoom. 0 = the user's preset is always honoured. Default 0. */
  userFilterMinZoom?: number;
  /** Coarsest interval present in the pyramid at world-view zooms.
   *  Required when `userFilterMinZoom > 0`; ignored otherwise. Used as the
   *  forced filter value for the low-zoom regime. */
  coarsestInterval?: number;
  /** MapLibre/Mapbox layer id to insert this overlay's layers BEFORE.
   *  Controls z-order in the array - e.g. pass the streamlines layer id
   *  to put contour lines below particles. The high-zoom symbol layer is
   *  always inserted with the same `beforeId`. */
  beforeId?: string;
  /** Mapbox GL JS v3 slot, forwarded to the custom line layer. Labels are
   *  always pinned to slot `'top'` regardless of this value (the only slot
   *  that composites above the custom-WebGL pass). Ignored on MapLibre +
   *  Mapbox classic. */
  slot?: string;
  /** Font stack for the label symbol layers. Default
   *  `['Open Sans Regular', 'Arial Unicode MS Regular']` works on Mapbox
   *  classic + Standard glyph endpoints. OpenFreeMap and other single-font
   *  MapLibre glyph endpoints 404 multi-font stacks — override with
   *  `['Noto Sans Regular']` (or whatever single font that endpoint serves)
   *  when targeting those. */
  textFont?: string[];
  /** Symbol-layer `layout` overrides for the label layers. Merged on top
   *  of the defaults (`symbol-placement: 'line'`, `symbol-spacing: 250`,
   *  `text-size: 10`). The convenience opts `textFont` and `unit` win
   *  over this — pass `text-font` / `text-field` here to override them
   *  directly. Mapbox/MapLibre style-spec keys; types are host-specific
   *  so the shape stays loose. */
  labelLayout?: StyleProps;
  /** Symbol-layer `paint` overrides for the label layers. Merged on top
   *  of the defaults (`text-color: '#222'`, `text-halo-color: rgba(...)`,
   *  `text-halo-width: 1.5`). */
  labelPaint?: StyleProps;
  /** CSS colour for contour lines. Default `'#4b5563'` (Tailwind gray-600).
   *  Accepts `#rgb` / `#rrggbb` hex and `rgb()` / `rgba()`. */
  lineColor?: string;
  /** Line opacity, 0..1. Default 1. */
  lineOpacity?: number;
  /** Stroke width in CSS pixels for thin (non-bold) lines. Default 0.7. */
  lineWidth?: number;
  /** Stroke width in CSS pixels for bold lines (contour values divisible
   *  by 10). Default 1.4. */
  boldLineWidth?: number;
}

export interface ContoursOverlayHandle {
  setInterval(newInterval: number): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyOptions(p: any): void;
  remove(): void;
}

export function addContoursOverlay(
  mapAny: unknown,
  opts: ContoursOverlayOpts,
): ContoursOverlayHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = mapAny as any;
  const {
    urlTemplate,
    sourceLayer = 'contours',
    minzoom = 0,
    maxzoom = 5,
    initialInterval,
    unit = '',
    userFilterMinZoom = 0,
    coarsestInterval,
    beforeId,
    slot,
    textFont,
    labelLayout: labelLayoutOverrides,
    labelPaint: labelPaintOverrides,
    lineColor,
    lineOpacity,
    lineWidth,
    boldLineWidth,
  } = opts;

  let interval = initialInterval;

  // Custom WebGL layer for the lines + casing. Added FIRST so beforeId
  // chains can target it, and so it sits below the symbol label layers
  // we add after.
  const lineLayer = addContoursLineLayer(map, {
    urlTemplate,
    sourceLayer,
    minzoom,
    maxzoom,
    initialInterval: interval,
    userFilterMinZoom,
    coarsestInterval,
    beforeId,
    slot,
    lineColor,
    lineOpacity,
    lineWidth,
    boldLineWidth,
  });

  // Vector source feeds the label symbol layers. Independent from the
  // custom line layer's tile cache — but cheap, because the host's
  // cache deduplicates HTTP fetches in practice (browser cache + the
  // host's own internal tile cache).
  if (!map.getSource(SRC_ID)) {
    map.addSource(SRC_ID, {
      type: 'vector',
      tiles: [urlTemplate],
      minzoom,
      maxzoom,
    });
  }

  // Merge order: defaults → caller `labelLayout` → convenience opts
  // (`textFont`, `unit`). The convenience opts always win so `textFont:
  // ['Noto Sans']` does the obvious thing even if the caller also
  // passed `labelLayout: { 'text-font': [...] }`. Set `text-font` /
  // `text-field` directly in `labelLayout` only when overriding both
  // convenience opts is awkward — typical case is just tweaking
  // `text-size` / `symbol-spacing`.
  const labelLayout: StyleProps = {
    ...DEFAULT_LABEL_LAYOUT,
    ...labelLayoutOverrides,
    'text-font': textFont ?? labelLayoutOverrides?.['text-font'] ?? DEFAULT_LABEL_FONT,
    'text-field': ['concat', ['to-string', ['get', 'value']], unit] as StyleExpression,
  };
  const labelPaint: StyleProps = {
    ...DEFAULT_LABEL_PAINT,
    ...labelPaintOverrides,
  };

  // Labels always go in Mapbox v3 Standard's `top` slot. This is the
  // only slot that renders strictly above the custom-WebGL pass —
  // without it, raster layers + contour lines + other custom layers
  // composite ON TOP of contour labels on Mapbox v3, hiding them.
  // MapLibre + Mapbox classic ignore `slot` entirely (unknown layer
  // property), so this is a no-op there. The caller's `opts.slot` is
  // forwarded to the line layer but explicitly overridden here for
  // labels — they're conventionally above-everything and shouldn't
  // share the line layer's z-stack.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withLabelSlot = (cfg: any): any => ({ ...cfg, slot: 'top' });

  // Low-zoom label layer (coarsest preset only). Skipped entirely when
  // every preset is present at every zoom (userFilterMinZoom = 0).
  if (userFilterMinZoom > 0 && coarsestInterval != null) {
    map.addLayer(withLabelSlot({
      id: LABELS_LOW_ID,
      type: 'symbol',
      source: SRC_ID,
      'source-layer': sourceLayer,
      maxzoom: userFilterMinZoom,
      filter: intervalFilter(coarsestInterval),
      layout: labelLayout,
      paint: labelPaint,
    }), beforeId);
  }

  // High-zoom label layer follows the user's interval.
  map.addLayer(withLabelSlot({
    id: LABELS_HIGH_ID,
    type: 'symbol',
    source: SRC_ID,
    'source-layer': sourceLayer,
    minzoom: userFilterMinZoom,
    filter: intervalFilter(interval),
    layout: labelLayout,
    paint: labelPaint,
  }), beforeId);

  return {
    setInterval(newInterval: number): void {
      interval = newInterval;
      lineLayer.setInterval(newInterval);
      const f = intervalFilter(interval);
      if (map.getLayer(LABELS_HIGH_ID)) map.setFilter(LABELS_HIGH_ID, f);
    },
    /** Apply a partial options patch. Line styling is forwarded to the
     *  custom-WebGL line layer; the symbol label layers stay at their
     *  construction-time style (changing `textFont`/`labelLayout`/`labelPaint`
     *  at runtime would require host-specific `setLayoutProperty` plumbing —
     *  not yet implemented). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyOptions(p: any): void {
      if (p.initialInterval != null) {
        this.setInterval(p.initialInterval);
      }
      lineLayer.applyOptions(p);
    },
    remove(): void {
      lineLayer.remove();
      for (const id of [LABELS_HIGH_ID, LABELS_LOW_ID]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(SRC_ID)) map.removeSource(SRC_ID);
    },
  };
}
