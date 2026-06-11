/**
 * `@mercator-blue/sdk/react/maplibre`: a declarative `<MercatorLayer/>` for
 * react-map-gl's MapLibre entry (`react-map-gl/maplibre`).
 *
 * Reads the map from react-map-gl context and manages the imperative layer's
 * lifecycle for you. Same visualizations and globe support as the MapLibre
 * binding.
 *
 * @module
 */
// <MercatorLayer> for react-map-gl's MapLibre entry (`react-map-gl/maplibre`).
//
// Identical to the Mapbox component except it reads the map from
// react-map-gl's MapLibre context (no Mapbox token needed). Renders nothing;
// manages a mercator.blue layer on the nearest <Map>:
//
//   import { Map } from 'react-map-gl/maplibre';
//   import { MercatorLayer } from '@mercator-blue/sdk/react/maplibre';
//
//   <Map initialViewState={...} mapStyle="https://.../style.json">
//     <MercatorLayer apiKey="mk_..." dataset="wind10m" viz="streamlines" />
//   </Map>

import { useMap } from 'react-map-gl/maplibre';
import { useMercatorLayer } from './index';
import type { MercatorLayerProps } from './index';

export type { MercatorLayerProps } from './index';

/** Props for <MercatorLayer>: the layer options plus an optional `mapId` to
 *  target a specific map when several share a react-map-gl <MapProvider>. */
export type MercatorLayerComponentProps = MercatorLayerProps & { mapId?: string };

export function MercatorLayer(props: MercatorLayerComponentProps): null {
  const maps = useMap();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref: any = props.mapId ? (maps as any)[props.mapId] : maps.current;
  useMercatorLayer(ref?.getMap?.() ?? null, props);
  return null;
}
