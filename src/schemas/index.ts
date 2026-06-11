/**
 * `@mercator-blue/sdk/schemas`: Zod schemas for the STAC catalog and the
 * `mercator:*` STAC extension namespace.
 *
 * The single source of truth for every wire shape: each schema yields a
 * runtime validator, an inferred TypeScript type, and an OpenAPI component.
 * Pure data with no DOM or WebGL, so it runs in any JavaScript runtime.
 *
 * @module
 */
// Public surface for `@mercator-blue/sdk/schemas`.
//
// Zod schemas + their inferred TypeScript types for every wire shape
// the tile API serves: STAC documents (catalog, collection, item,
// asset), and the mercator-specific `mercator:*` extensions.
//
// Each schema is the single source of truth for three artifacts:
//   1. The TS type, via `z.infer<typeof SchemaName>` (consumed by SDK,
//      site, worker, and any TS consumer).
//   2. Runtime validation, via `SchemaName.parse(input)` (used at API
//      boundaries — SSR responses, worker request bodies).
//   3. The OpenAPI component definition, via `@asteasolutions/zod-to-
//      openapi` (generated into `site/public/openapi.yaml` by
//      `scripts/build_openapi.mjs`).
//
// Field-level descriptions (`.describe(...)` calls) propagate through
// all three: TSDoc on the inferred type, error messages on parse
// failure, and `description` fields in the OpenAPI component. Edit
// one, all three update.

// Side-effect: `_register` extends Zod with `.openapi(...)` before any
// schema module's body runs. We import the re-exported `z` so the
// bundler keeps the side effect (it can't be tree-shaken when the
// imported value is actually used downstream).
export { z } from './_register.js';

export { Link } from './link.js';
export type { Link as LinkT } from './link.js';

export { MercatorEncoding } from './mercator-encoding.js';
export type { MercatorEncoding as MercatorEncodingT } from './mercator-encoding.js';

export {
  ColormapSpec,
  MercatorVisualization,
} from './mercator-visualization.js';
export type {
  ColormapSpec as ColormapSpecT,
  MercatorVisualization as MercatorVisualizationT,
} from './mercator-visualization.js';

export { MercatorLandmask } from './mercator-landmask.js';
export type { MercatorLandmask as MercatorLandmaskT } from './mercator-landmask.js';

export { MercatorContour } from './mercator-contour.js';
export type { MercatorContour as MercatorContourT } from './mercator-contour.js';

export { MercatorTile } from './mercator-tile.js';
export type { MercatorTile as MercatorTileT } from './mercator-tile.js';

export { StacAsset } from './stac-asset.js';
export type { StacAsset as StacAssetT } from './stac-asset.js';

export { StacItem } from './stac-item.js';
export type {
  StacItem as StacItemT,
  StacItemProperties as StacItemPropertiesT,
} from './stac-item.js';

export { StacCollection } from './stac-collection.js';
export type { StacCollection as StacCollectionT } from './stac-collection.js';

export { StacCatalog } from './stac-catalog.js';
export type { StacCatalog as StacCatalogT } from './stac-catalog.js';

// Helper for `scripts/build_openapi.mjs`. Registers every schema with
// a fresh OpenAPIRegistry and returns it ready for component
// generation. Importing this from a build script also imports every
// schema module (and thus the `.openapi(...)` registration calls), so
// the resulting components map is complete.
export { createSchemaRegistry } from './registry.js';
