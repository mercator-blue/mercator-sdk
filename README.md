# @mercator-blue/sdk

<a href="https://mercator.blue"><img src="https://mercator.blue/og-default.png" alt="mercator: gridded earth data as tiles" width="100%" /></a>

[![npm version](https://img.shields.io/npm/v/@mercator-blue/sdk.svg)](https://www.npmjs.com/package/@mercator-blue/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@mercator-blue/sdk.svg)](https://www.npmjs.com/package/@mercator-blue/sdk)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@mercator-blue/sdk.svg)](https://bundlephobia.com/package/@mercator-blue/sdk)
[![types: TypeScript](https://img.shields.io/npm/types/@mercator-blue/sdk.svg)](https://www.typescriptlang.org/)
[![license: Apache-2.0](https://img.shields.io/npm/l/@mercator-blue/sdk.svg)](./LICENSE)

Drop-in WebGL map layers for gridded earth data served by 
[mercator.blue](https://mercator.blue): atmospheric weather, ocean state, 
air quality, and elevation, decoded from value-encoded PNG tiles into 
colormapped rasters, animated streamlines, arrows, contours, and labels.

Five host bindings: MapLibre GL JS, Mapbox GL JS, Leaflet, OpenLayers, deck.gl,
with one API across all of them.

## Install

```sh
npm install @mercator-blue/sdk
```

Plus your host library: `maplibre-gl`, `mapbox-gl`, `leaflet`, `ol`, or the deck.gl packages, as a peer dependency.

Get an API key (10 000 free tiles/month) at [mercator.blue/sign-up](https://mercator.blue/sign-up/).

## Usage

```ts
import maplibregl from 'maplibre-gl';
import { MercatorLayer } from '@mercator-blue/sdk/mapbox';

const map = new maplibregl.Map({ container: 'map', style: '...' });

map.on('load', async () => {
  const layer = await MercatorLayer.create({
    dataset: 'wind10m',
    apiKey: 'mk_...',
    viz: 'streamlines',
  });
  map.addLayer(layer);
});
```

The layer walks the STAC catalog at request time, finds the latest cycle for 
dataset `wind10m`, fetches value-encoded tiles, decodes them in a fragment 
shader and finally animates particle trails over the resulting vector field.

### React (react-map-gl)

Using [react-map-gl](https://visgl.github.io/react-map-gl/)? Drop in the
declarative `<MercatorLayer/>`. It owns the imperative layer's lifecycle
(create / add / update / remove) for you:

```tsx
import { Map } from 'react-map-gl/maplibre';
import { MercatorLayer } from '@mercator-blue/sdk/react/maplibre';

<Map
  initialViewState={{ longitude: 0, latitude: 20, zoom: 2 }}
  mapStyle="https://tiles.openfreemap.org/styles/liberty"
>
  <MercatorLayer apiKey="mk_..." dataset="wind10m" viz="streamlines" />
</Map>;
```

Use `@mercator-blue/sdk/react/mapbox` for react-map-gl's Mapbox entry. One
binding covers both hosts. There's also a host-agnostic `useMercatorLayer(map,
props)` hook (from `@mercator-blue/sdk/react`) for any other React map setup.

Full per-binding examples (including raster, contours, arrows, value labels, 
and tile boundaries) are on the quickstart pages:

- [MapLibre GL JS](https://mercator.blue/quickstart/maplibre/): MapLibre 5+, fully open-source, no tokens, supports the 3D globe projection.
- [Mapbox GL JS](https://mercator.blue/quickstart/mapbox/): Mapbox GL JS v2 and v3, flat Mercator and 3D globe.
- [Leaflet](https://mercator.blue/quickstart/leaflet/): the classic raster-tile mapping library, Mercator-only.
- [OpenLayers](https://mercator.blue/quickstart/openlayers/): OL 9+, Mercator-only, raster decoding uses OL's built-in `WebGLTile` band expressions.
- [deck.gl](https://mercator.blue/quickstart/deck-gl/): deck.gl 9+ via `@deck.gl/mapbox`'s `MapboxOverlay`, flat Mercator only.
- [React (react-map-gl)](https://mercator.blue/quickstart/react/): declarative `<MercatorLayer/>` for react-map-gl, on both MapLibre and Mapbox.

## Host library support

| Host | Subpath | Mercator | Globe | Visualizations |
|------|---------|----------|-------|----------------|
| **MapLibre GL JS** (4+, 5+) | `/mapbox` | ✅ | ✅ | raster, streamlines, arrows, contours, value-labels, tile-boundaries |
| **Mapbox GL JS** (3+) | `/mapbox` | ✅ | ✅ | raster, streamlines, arrows, contours, value-labels, tile-boundaries |
| **Mapbox GL JS** (v2) | `/mapbox` | ✅ | ✗ | raster, streamlines, arrows, contours, value-labels, tile-boundaries |
| **deck.gl** (9+) | `/deck-gl` | ✅ | ✗ | raster, streamlines, arrows, value-labels, tile-boundaries |
| **Leaflet** (1.9+) | `/leaflet` | ✅ | ✗ | raster, streamlines, arrows, contours, value-labels, tile-boundaries |
| **OpenLayers** (10+) | `/openlayers` | ✅ | ✗ | raster, streamlines, arrows, contours, value-labels, tile-boundaries |

The Mapbox/MapLibre binding is the only one with globe support (globe rendering depends on the host's projection system, and only Mapbox v3 and MapLibre 5 expose the projection pipeline to custom layers). The other bindings render flat Mercator regardless of host projection.

For React apps, `@mercator-blue/sdk/react/mapbox` and `@mercator-blue/sdk/react/maplibre` wrap the Mapbox/MapLibre binding as a declarative `<MercatorLayer/>` for [react-map-gl](https://visgl.github.io/react-map-gl/), with the same visualizations and globe support, both hosts. A host-agnostic `useMercatorLayer(map, props)` hook is exported from `@mercator-blue/sdk/react` for other React map setups.

We don't have a binding for all libraries (Google Maps, Cesium, ArcGIS, etc). For these,
or for any custom renderer, implement the [value-encoded PNG protocol](https://mercator.blue/docs#tag/tile-encoding) directly - it is a modest piece of GLSL code.

## Tile contract

The tile API is separate from this SDK. Tiles are slippy-XYZ PNGs with floating-point values packed into channels, served by a Cloudflare-backed CDN. The SDK is one of several possible decoders; the bytes are the contract.

See the [API docs](https://mercator.blue/docs) for the tile URL shape, auth model, and STAC catalog walk. The tile endpoint, the auth gate, the catalog, and the rendering SDK are independently swappable: you keep using the same tiles even if you replace this library.

## License

Apache 2.0. See [LICENSE](./LICENSE).
