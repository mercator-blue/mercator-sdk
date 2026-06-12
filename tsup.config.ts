import { defineConfig } from 'tsup';

// Library build config.
//
// We ship dual ESM/CJS so the SDK works in modern bundlers (Vite, Webpack 5,
// Rollup, esbuild — all happy with ESM) AND in older toolchains or direct
// Node usage (CJS via `require`). Modern consumers tree-shake unused code
// out of the ESM build; `sideEffects: false` in package.json tells them so.
//
// Source layout (mirrors the published subpaths):
//   src/index.ts             — host-agnostic public surface
//   src/core/                — host-agnostic primitives (discover, urls,
//                              tile-pixel-reader, colormaps, types)
//   src/mapbox/index.ts      — Mapbox GL JS + MapLibre binding
//   src/mapbox/              — its implementation files + shaders/
//   src/deck-gl/index.ts     — deck.gl binding
//   src/deck-gl/             — its layer subclasses
//   src/schemas/index.ts     — Zod schemas + inferred types
//
// Shaders are plain .ts modules that export their GLSL as a string constant
// (e.g. src/mapbox/shaders/raster.vert.ts). No .vert/.frag text loader is
// needed, so the source is bundler-independent and publishable to JSR / Deno.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    mapbox: 'src/mapbox/index.ts',
    'deck-gl': 'src/deck-gl/index.ts',
    leaflet: 'src/leaflet/index.ts',
    openlayers: 'src/openlayers/index.ts',
    'schemas/index': 'src/schemas/index.ts',
    colormaps: 'src/core/color/colormaps.ts',
    'react/index': 'src/react/index.ts',
    'react/mapbox': 'src/react/mapbox.tsx',
    'react/maplibre': 'src/react/maplibre.tsx',
  },
  format: ['esm', 'cjs'],
  outExtension({ format }) {
    return { js: format === 'esm' ? '.js' : '.cjs' };
  },
  dts: {
    entry: {
      index: 'src/index.ts',
      mapbox: 'src/mapbox/index.ts',
      'deck-gl': 'src/deck-gl/index.ts',
      leaflet: 'src/leaflet/index.ts',
      openlayers: 'src/openlayers/index.ts',
      'schemas/index': 'src/schemas/index.ts',
      colormaps: 'src/core/color/colormaps.ts',
      'react/index': 'src/react/index.ts',
      'react/mapbox': 'src/react/mapbox.tsx',
      'react/maplibre': 'src/react/maplibre.tsx',
    },
  },
  clean: true,
  sourcemap: false,
  treeshake: true,
  splitting: false,
  // Inline the MVT-decode deps (~15 KB minified total) into the bundle.
  // tsup defaults to leaving every package.json dependency as an
  // external import, which works for bundler-using consumers (Vite,
  // Webpack, etc) but not for the standalone test page that loads
  // `dist/mapbox.js` directly as an ES module — the browser hits bare
  // specifiers like `@mapbox/vector-tile` and rejects them. The two
  // libs have no transitive deps and are too small to be worth a
  // separate `mvt-decode` chunk; bundling them is the simpler trade.
  noExternal: ['@mapbox/vector-tile', 'pbf'],
});
