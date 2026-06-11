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
//
// The Zod schemas (`Link`, `StacItem`, ...) are re-exported directly.
// Their inferred types are re-exported under a `T`-suffixed name as
// documented aliases (e.g. `LinkT = z.infer<typeof Link>`) so callers
// can import the type without colliding with the same-named schema
// value.

// Side-effect: `_register` extends Zod with `.openapi(...)` before any
// schema module's body runs. We import the re-exported `z` so the
// bundler keeps the side effect (it can't be tree-shaken when the
// imported value is actually used downstream).
export { z } from './_register.js';

import type { Link as _Link } from './link.js';
import type { MercatorEncoding as _MercatorEncoding } from './mercator-encoding.js';
import type {
  ColormapSpec as _ColormapSpec,
  MercatorVisualization as _MercatorVisualization,
} from './mercator-visualization.js';
import type { MercatorLandmask as _MercatorLandmask } from './mercator-landmask.js';
import type { MercatorContour as _MercatorContour } from './mercator-contour.js';
import type { MercatorTile as _MercatorTile } from './mercator-tile.js';
import type { StacAsset as _StacAsset } from './stac-asset.js';
import type {
  StacItem as _StacItem,
  StacItemProperties as _StacItemProperties,
} from './stac-item.js';
import type { StacCollection as _StacCollection } from './stac-collection.js';
import type { StacCatalog as _StacCatalog } from './stac-catalog.js';

export { Link } from './link.js';
/** Inferred TypeScript type of a STAC {@link Link} object (rel + href). */
export type LinkT = _Link;

export { MercatorEncoding } from './mercator-encoding.js';
/** Inferred TypeScript type of the `mercator:encoding` value-encoding spec. */
export type MercatorEncodingT = _MercatorEncoding;

export {
  ColormapSpec,
  MercatorVisualization,
} from './mercator-visualization.js';
/** Inferred TypeScript type of a colormap spec (preset name or inline gradient). */
export type ColormapSpecT = _ColormapSpec;
/** Inferred TypeScript type of the `mercator:visualization` property. */
export type MercatorVisualizationT = _MercatorVisualization;

export { MercatorLandmask } from './mercator-landmask.js';
/** Inferred TypeScript type of the `mercator:landmask` property. */
export type MercatorLandmaskT = _MercatorLandmask;

export { MercatorContour } from './mercator-contour.js';
/** Inferred TypeScript type of the `mercator:contour` property. */
export type MercatorContourT = _MercatorContour;

export { MercatorTile } from './mercator-tile.js';
/** Inferred TypeScript type of the `mercator:tile` property. */
export type MercatorTileT = _MercatorTile;

export { StacAsset } from './stac-asset.js';
/** Inferred TypeScript type of a STAC `Asset` object. */
export type StacAssetT = _StacAsset;

export { StacItem } from './stac-item.js';
/** Inferred TypeScript type of a STAC `Item`. */
export type StacItemT = _StacItem;
/** Inferred TypeScript type of a STAC Item's `properties` object. */
export type StacItemPropertiesT = _StacItemProperties;

export { StacCollection } from './stac-collection.js';
/** Inferred TypeScript type of a STAC `Collection`. */
export type StacCollectionT = _StacCollection;

export { StacCatalog } from './stac-catalog.js';
/** Inferred TypeScript type of the root STAC `Catalog`. */
export type StacCatalogT = _StacCatalog;

// Helper for `scripts/build_openapi.mjs`. Registers every schema with
// a fresh OpenAPIRegistry and returns it ready for component
// generation. Importing this from a build script also imports every
// schema module (and thus the `.openapi(...)` registration calls), so
// the resulting components map is complete.
export { createSchemaRegistry } from './registry.js';
