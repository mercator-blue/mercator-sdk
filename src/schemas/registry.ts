// Build helper: register every schema with a fresh OpenAPIRegistry so
// the build script can emit a complete `components.schemas` block.
//
// Importing this module also imports each schema file, which means
// every `.openapi(name, ...)` call runs and attaches metadata to the
// Zod schemas via the zod-to-openapi extension.

import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
// Side-effect: importing `_register` first ensures Zod is extended before
// any schema module's `.openapi(...)` chain is evaluated. We import a
// concrete export (z) so the bundler can't tree-shake the module.
import { z as _z } from './_register.js';
void _z;

import { Link } from './link.js';
import { MercatorEncoding } from './mercator-encoding.js';
import {
  ColormapSpec,
  MercatorVisualization,
} from './mercator-visualization.js';
import { MercatorLandmask } from './mercator-landmask.js';
import { MercatorContour } from './mercator-contour.js';
import { MercatorTile } from './mercator-tile.js';
import { StacAsset } from './stac-asset.js';
import { StacItem } from './stac-item.js';
import { StacCollection } from './stac-collection.js';
import { StacCatalog } from './stac-catalog.js';

/**
 * Build an `OpenAPIRegistry` with every mercator STAC + `mercator:*` schema
 * registered under its canonical name. The OpenAPI build script
 * (`scripts/build_openapi.mjs`) calls this to emit the `components.schemas`
 * block of the published spec.
 */
export function createSchemaRegistry(): OpenAPIRegistry {
  const r = new OpenAPIRegistry();

  // Order doesn't affect output, but listed roughly leaf-first for
  // readability.
  r.register('Link', Link);
  r.register('MercatorEncoding', MercatorEncoding);
  r.register('ColormapSpec', ColormapSpec);
  r.register('MercatorVisualization', MercatorVisualization);
  r.register('MercatorLandmask', MercatorLandmask);
  r.register('MercatorContour', MercatorContour);
  r.register('MercatorTile', MercatorTile);
  r.register('StacAsset', StacAsset);
  r.register('StacItem', StacItem);
  r.register('StacCollection', StacCollection);
  r.register('StacCatalog', StacCatalog);

  return r;
}
