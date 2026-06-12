# Changelog

All notable changes to `@mercator-blue/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.6] - 2026-06-12

### Added

- `sampleColormapCss(palette, t)` on `@mercator-blue/sdk/colormaps`: sample a
  resolved colormap to an `rgb(...)` string for Canvas2D. (Previously an
  internal copy in two bindings.)

### Changed

- Internal cleanup, no behavior change: the `{z}/{x}/{y}` tile-URL templating
  that was copy-pasted at 21 sites is now a single `expandTileUrl` helper in
  core; the Canvas2D colormap sampler is shared via `sampleColormapCss`;
  redundant module-comment blocks on the entrypoints were trimmed (the
  `@module` JSDoc is unchanged); and two internal-only mercator helpers are no
  longer exported. Net -180 source lines.

## [0.4.5] - 2026-06-11

### Changed

- The public API is now free of JSR "slow types". Exported Zod schemas carry
  explicit `z.ZodType<Shape>` annotations (TypeScript enforces the annotation
  matches the schema, so there is no drift), and the deck.gl layer methods
  (`shouldUpdateState`, `renderLayers`) have explicit return types. JSR now
  publishes without `--allow-slow-types`, and a future slow-type regression
  fails CI. No public name, type, or runtime change.

## [0.4.4] - 2026-06-11

### Changed

- Re-exported cross-binding symbols (core types, `discoverLatestItem`,
  `PALETTES`, `resolveColormap`, the schema `*T` types) are now documented
  local aliases on each subpath instead of bare `export ... from` re-exports.
  A bare re-export shows up as an undocumented reference in JSR's doc graph,
  which was holding the documentation score down; every exported symbol on
  every entrypoint is now documented (100%). No public name or runtime change.

## [0.4.3] - 2026-06-11

### Changed

- Added JSDoc to every exported symbol across all entrypoints (layer factories,
  option types, schema types, the React components, discovery and colormap
  helpers). Docs-only; no code or runtime change.

## [0.4.2] - 2026-06-11

### Changed

- Added JSDoc module docs to every published entrypoint, with a usage example
  on the main entry. Docs-only; no code or runtime change.

## [0.4.1] - 2026-06-11

### Changed

- Shaders are now plain `.ts` modules that export their GLSL as a string,
  removing the build-time text-loader dependency. The published npm bundle is
  byte-for-byte unchanged; the change makes the source bundler-independent.

### Added

- Published to JSR as `@mercator-blue/sdk` (TypeScript source). Browser
  runtime: the rendering bindings require WebGL2 and a host map library.

## [0.2.0] - 2026-06-08

### Added

- `@mercator-blue/sdk/react/mapbox` and `@mercator-blue/sdk/react/maplibre`: declarative `<MercatorLayer/>` components for [react-map-gl](https://visgl.github.io/react-map-gl/), one per host entry. They read the map from react-map-gl's `<Map>` context and manage the imperative layer's create / add / update / remove lifecycle. Identity props (`viz`, `dataset`, `apiKey`, `id`, `catalogUrl`, `beforeId`) rebuild the layer; every other prop change applies live via `setOptions`. Re-attaches on basemap/style swaps.
- `@mercator-blue/sdk/react`: host-agnostic `useMercatorLayer(map, props)` hook, the primitive the components are built on, usable with any React map setup that can hand you the underlying map instance.
- `react` and `react-map-gl` added as optional peer dependencies.

## [0.1.0] - 2026-06-07

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
