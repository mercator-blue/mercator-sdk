/**
 * `@mercator-blue/sdk/react/mapbox`: a declarative `<MercatorLayer/>` for
 * react-map-gl's Mapbox entry (`react-map-gl/mapbox`).
 *
 * Reads the map from react-map-gl context and manages the imperative layer's
 * lifecycle for you. Same visualizations and globe support as the Mapbox
 * binding.
 *
 * @module
 */
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
import type { MercatorLayerProps as _MercatorLayerProps } from './index';

/** Props for the layer, identical to the imperative Mapbox/MapLibre options
 *  (`viz`, `dataset`, `apiKey`, plus host extras like `beforeId`). */
export type MercatorLayerProps = _MercatorLayerProps;

/** Props for <MercatorLayer>: the layer options plus an optional `mapId` to
 *  target a specific map when several share a react-map-gl <MapProvider>. */
export type MercatorLayerComponentProps = _MercatorLayerProps & { mapId?: string };

/**
 * Declarative mercator data layer for react-map-gl's Mapbox entry. Renders
 * nothing; drop it inside a `<Map>` and it manages the underlying layer's
 * create / add / update / remove lifecycle. Identity props (`viz`, `dataset`,
 * `apiKey`, `id`, `catalogUrl`, `beforeId`) rebuild the layer; other prop
 * changes apply live.
 */
export function MercatorLayer(props: MercatorLayerComponentProps): null {
  const maps = useMap();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref: any = props.mapId ? (maps as any)[props.mapId] : maps.current;
  // `mapId` is harmless if it reaches the hook (not an identity key; the
  // inner layer ignores unknown options), so no need to strip it.
  useMercatorLayer(ref?.getMap?.() ?? null, props);
  return null;
}
