// <MercatorLayer> for react-map-gl's Mapbox entry (`react-map-gl/mapbox`).
//
// Renders nothing; it manages a mercator.blue layer on the nearest <Map>
// (or the map named by `mapId` when several share a <MapProvider>). Drop it
// inside a react-map-gl <Map>:
//
//   import { Map } from 'react-map-gl/mapbox';
//   import { MercatorLayer } from '@mercator-blue/sdk/react/mapbox';
//
//   <Map mapboxAccessToken={token} initialViewState={...} mapStyle="...">
//     <MercatorLayer apiKey="mk_..." dataset="wind10m" viz="streamlines" />
//   </Map>

import { useMap } from 'react-map-gl/mapbox';
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
  // `mapId` is harmless if it reaches the hook (not an identity key; the
  // inner layer ignores unknown options), so no need to strip it.
  useMercatorLayer(ref?.getMap?.() ?? null, props);
  return null;
}
