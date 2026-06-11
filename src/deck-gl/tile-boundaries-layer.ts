// Slippy-XYZ tile-boundary overlay for deck.gl. Mirrors the Mapbox/
// MapLibre `TileBoundariesOverlay` from `../tile-boundaries-overlay.js`,
// but built from stock deck.gl primitives (PathLayer + TextLayer) rather
// than custom WebGL — the debug overlay isn't a performance-critical
// path, and PathLayer's screen-space line width + TextLayer's SDF
// outlines give us the same visual result for far less code than the
// expanded-triangle / symbol-collision pipeline the Mapbox version uses.
//
// Dataset-independent: no apiKey, no STAC discovery. The Mapbox overlay
// nominally takes those for API symmetry but doesn't use them either.

import { CompositeLayer, type DefaultProps, type Color, type LayersList } from '@deck.gl/core';
import { PathLayer, TextLayer } from '@deck.gl/layers';

import {
  lngToTileX,
  latToTileY,
  tileXToLng,
  tileYToLat,
} from '../core/mercator';

export interface MercatorTileBoundariesLayerProps {
  /** Lower bound on tile zoom. Defaults to 0. */
  minzoom?: number;
  /** Upper bound on tile zoom. Defaults to no cap — the grid keeps
   *  subdividing as the user zooms in (independent of any data layer's
   *  maxzoom; the basemap usually has tiles available indefinitely). */
  maxzoom?: number;
  /** Line width in CSS pixels. */
  lineWidth?: number;
  /** Line colour as [r, g, b, a] each in [0, 255]. */
  lineColor?: Color;
  /** Label colour as [r, g, b, a] each in [0, 255]. */
  textColor?: Color;
  /** Label outline colour. */
  textOutlineColor?: Color;
  /** Label text size in CSS pixels. */
  textSize?: number;
  id?: string;
}

interface TilePath {
  path: [number, number][];
}
interface TileLabel {
  position: [number, number];
  text: string;
}

const defaultProps: DefaultProps<MercatorTileBoundariesLayerProps> = {
  minzoom: { type: 'number', value: 0 },
  // 99 is effectively unbounded — viewport.zoom won't exceed Mapbox/
  // MapLibre's max zoom (24) in practice. We don't use `Infinity` because
  // deck.gl's prop validator rejects non-finite numbers.
  maxzoom: { type: 'number', value: 99 },
  lineWidth: { type: 'number', value: 1.5 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lineColor: { type: 'color', value: [255, 0, 255, 255] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  textColor: { type: 'color', value: [255, 0, 255, 255] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  textOutlineColor: { type: 'color', value: [0, 0, 0, 192] } as any,
  textSize: { type: 'number', value: 12 },
};

export class MercatorTileBoundariesLayer extends CompositeLayer<MercatorTileBoundariesLayerProps> {
  static layerName = 'MercatorTileBoundariesLayer';
  static defaultProps = defaultProps;

  // Default `shouldUpdateState` returns `propsOrDataChanged` only —
  // viewport changes (pan/zoom) wouldn't re-trigger renderLayers().
  // `somethingChanged` is broader and includes viewport, which is what
  // TileLayer uses for the same reason.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldUpdateState({ changeFlags }: any): boolean {
    return changeFlags.somethingChanged;
  }

  renderLayers(): LayersList {
    const viewport = this.context.viewport;
    if (!viewport) return [];

    const {
      minzoom = 0,
      maxzoom = 99,
      lineWidth = 1.5,
      lineColor,
      textColor,
      textOutlineColor,
      textSize = 12,
    } = this.props;

    const z = Math.max(minzoom, Math.min(maxzoom, Math.floor(viewport.zoom)));
    const n = Math.pow(2, z);

    // WebMercatorViewport.getBounds() → [minLng, minLat, maxLng, maxLat].
    // At low zoom with wrapped longitudes the values can extend beyond
    // [-180, 180]; lngToTileX handles that by mapping straight onto the
    // unbounded tile axis. The xRaw -> x wrap below normalises the LABEL
    // text but the PATH coordinates stay on the wrapped axis so the
    // boundary lines visually wrap with the basemap.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bounds = (viewport as any).getBounds?.() as
      | [number, number, number, number]
      | undefined;
    if (!bounds) return [];
    const [west, south, east, north] = bounds;

    const xLo = Math.floor(lngToTileX(west, z));
    const xHi = Math.floor(lngToTileX(east, z));
    const yLo = Math.max(0, Math.floor(latToTileY(north, z)));
    const yHi = Math.min(n - 1, Math.floor(latToTileY(south, z)));

    const paths: TilePath[] = [];
    const labels: TileLabel[] = [];

    for (let xRaw = xLo; xRaw <= xHi; xRaw++) {
      const x = ((xRaw % n) + n) % n;
      for (let y = yLo; y <= yHi; y++) {
        const wLng = tileXToLng(xRaw, z);
        const eLng = tileXToLng(xRaw + 1, z);
        const nLat = tileYToLat(y, z);
        const sLat = tileYToLat(y + 1, z);

        paths.push({
          path: [
            [wLng, nLat],
            [eLng, nLat],
            [eLng, sLat],
            [wLng, sLat],
            [wLng, nLat],
          ],
        });
        labels.push({
          position: [(wLng + eLng) / 2, (nLat + sLat) / 2],
          text: `(${x}, ${y}) z=${z}`,
        });
      }
    }

    // deck.gl reconciles sub-layers across renderLayers() calls by id.
    // The data array reference changes every frame, but the accessor
    // functions are fresh closures too — without an explicit
    // updateTriggers fingerprint, deck.gl can skip re-running accessors
    // when the array length happens to match. The integer tile range is
    // a cheap, exact change-fingerprint.
    const fingerprint = `${z}|${xLo}|${xHi}|${yLo}|${yHi}`;

    return [
      new PathLayer<TilePath>(
        this.getSubLayerProps({ id: 'lines' }),
        {
          data: paths,
          getPath: (d: TilePath) => d.path,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getColor: lineColor as any,
          getWidth: lineWidth,
          widthUnits: 'pixels',
          updateTriggers: { getPath: [fingerprint] },
        },
      ),
      new TextLayer<TileLabel>(
        this.getSubLayerProps({ id: 'labels' }),
        {
          data: labels,
          getPosition: (d: TileLabel) => d.position,
          getText: (d: TileLabel) => d.text,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getColor: textColor as any,
          getSize: textSize,
          sizeUnits: 'pixels',
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          // SDF mode is required for outlined text in deck.gl. Without
          // it `outlineWidth`/`outlineColor` are silently ignored.
          fontSettings: { sdf: true },
          outlineWidth: 2,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          outlineColor: textOutlineColor as any,
          updateTriggers: {
            getPosition: [fingerprint],
            getText: [fingerprint],
          },
        },
      ),
    ];
  }
}

