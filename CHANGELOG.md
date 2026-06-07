# Changelog

All notable changes to `@mercator-blue/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-07

Initial public release.

### Bindings

- `@mercator-blue/sdk/mapbox`: MapLibre GL JS (4+, 5+) and Mapbox GL JS (v2, v3). Custom-WebGL layers; globe support on MapLibre 5 and Mapbox v3.
- `@mercator-blue/sdk/leaflet`: Leaflet 1.9+. WebGL2 (raster, streamlines) and Canvas2D (arrows, contours, value-labels, tile-boundaries) layer subclasses. Mercator-only.
- `@mercator-blue/sdk/openlayers`: OpenLayers 10+. WebGL2 + Canvas2D; raster uses OL's built-in `WebGLTile` band expressions. Mercator-only.
- `@mercator-blue/sdk/deck-gl`: deck.gl 9+. Layer subclasses (raster, streamlines, arrows, value-labels, tile-boundaries) via `@deck.gl/mapbox`'s `MapboxOverlay`. Mercator-only.
- `@mercator-blue/sdk/schemas`: Zod schemas for the STAC catalog + the `mercator:*` extension namespace.
- `@mercator-blue/sdk/colormaps`: 14 built-in palettes (viridis, inferno, turbo, magma, plasma, cividis, spectral, rdbu, rdbu_r, rdylbu, rdylbu_r, ylgnbu, ylgnbu_r, greys) plus user-defined stop-based colormaps.

### Visualizations

- Raster: colormapped scalar fields (temperature, pressure, etc) or vector-magnitude rendering (wind speed, current speed). Supports `rg16_fixed` and `mapbox_rgb` encodings.
- Streamlines: animated particle trails over vector fields, with optional landmask integration.
- Arrows: direction-arrow lattice over vector fields, scaled and colored by speed.
- Contours: labelled isolines from a pre-built MVT pyramid.
- Value labels: numbers-on-a-grid for scalar fields (or vector magnitudes).
- Tile boundaries: debug overlay showing the slippy-tile grid.
