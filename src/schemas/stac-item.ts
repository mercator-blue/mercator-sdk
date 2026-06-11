import { z } from './_register.js';
import { Link } from './link.js';
import { StacAsset } from './stac-asset.js';
import { MercatorEncoding } from './mercator-encoding.js';
import { MercatorVisualization } from './mercator-visualization.js';
import { MercatorLandmask } from './mercator-landmask.js';
import { MercatorContour } from './mercator-contour.js';
import { MercatorTile } from './mercator-tile.js';

/**
 * The properties block of a STAC Item — base fields from the STAC spec
 * plus the `mercator:*` extensions that carry everything a renderer
 * needs.
 *
 * `additionalProperties` is allowed because STAC permits arbitrary
 * namespaced fields (see the `view`, `eo`, `processing` extensions and
 * many more). Consumers should ignore anything they don't recognise.
 */
const StacItemProperties = z
  .object({
    datetime: z
      .string()
      .nullable()
      .describe(
        'The Item\'s primary time, ISO 8601. For forecasts this is the ' +
          'valid time (NOT the cycle run time — `forecast:reference_datetime` ' +
          'carries that). Null for static datasets like elevation.',
      ),
    'forecast:reference_datetime': z
      .string()
      .optional()
      .describe(
        'Cycle run time (when the model started its integration), ISO 8601. ' +
          'STAC `forecast` extension. Forecast Items only.',
      ),
    'forecast:horizon': z
      .string()
      .optional()
      .describe(
        'Lead time as an ISO 8601 duration, e.g. `PT0S` for analysis, ' +
          '`PT3H` for +3 h. STAC `forecast` extension. Forecast Items only.',
      ),
    'mercator:variable': z
      .string()
      .describe(
        'Short variable name matching the collection id — `temp2m`, ' +
          '`wind10m`, `currents`, etc.',
      ),
    'mercator:long_name': z
      .string()
      .describe('Human-readable variable name for display.'),
    'mercator:encoding': MercatorEncoding.describe(
      'How tile bytes encode physical values — see `MercatorEncoding`.',
    ),
    'mercator:tile': MercatorTile.describe(
      'Tile pyramid bounds — see `MercatorTile`.',
    ),
    'mercator:visualization': MercatorVisualization.optional().describe(
      'Default rendering hints — see `MercatorVisualization`.',
    ),
    'mercator:landmask': MercatorLandmask.optional().describe(
      'Reference to the landmask pyramid for ocean datasets — see ' +
        '`MercatorLandmask`.',
    ),
    'mercator:contour': MercatorContour.optional().describe(
      'Reference to the contour MVT pyramid for scalar datasets — see ' +
        '`MercatorContour`.',
    ),
    'mercator:featured': z
      .boolean()
      .optional()
      .describe(
        'Presentation hint: when true, this dataset is surfaced on the ' +
          'mercator homepage\'s curated showcase. All datasets remain ' +
          'discoverable via the catalog regardless of this flag — featured ' +
          'is a hint to renderers / catalog browsers, not a visibility gate. ' +
          'Optional for backwards-compat with items written before the field ' +
          'existed; absence is treated as false.',
      ),
  })
  .catchall(z.unknown())
  .openapi('StacItemProperties', {
    description:
      'STAC Item properties block — base fields and `mercator:*` ' +
      'extensions. Unrecognised namespaced fields may also be present ' +
      'per STAC convention; consumers should ignore what they don\'t use.',
  });

/**
 * STAC Item — one (cycle, forecast-hour) of one dataset, or one static
 * record for non-forecast datasets. The Item carries everything a
 * renderer needs to decode the tile pyramid: encoding params,
 * visualisation hints, references to landmask / contour pyramids, and
 * the Asset list (COG, global PNG, preview).
 *
 * See https://github.com/radiantearth/stac-spec/blob/master/item-spec/item-spec.md
 * for the canonical STAC Item definition. The fields below override
 * descriptions for mercator-specific behaviour and extensions.
 */
export const StacItem = z
  .object({
    type: z
      .literal('Feature')
      .describe('Always `"Feature"` — Items are GeoJSON Features.'),
    stac_version: z
      .string()
      .describe('STAC spec version this document conforms to (e.g. `"1.0.0"`).'),
    stac_extensions: z
      .array(z.string())
      .optional()
      .describe(
        'URLs of the STAC extensions this Item uses. mercator items list ' +
          'at least the `proj`, `raster`, `forecast`, and `file` ' +
          'extensions; some also list `web-map-links`.',
      ),
    id: z
      .string()
      .describe(
        'Item identifier, unique within its collection. Conventionally ' +
          'cycle + fhour for forecast datasets, e.g. `2026052412/f000`.',
      ),
    collection: z
      .string()
      .describe('Parent collection id — same as the dataset short name.'),
    bbox: z
      .array(z.number())
      .min(4)
      .max(4)
      .describe(
        'Geographic bounding box `[west, south, east, north]` in degrees. ' +
          'For global datasets: `[-180, -85.0511, 180, 85.0511]`.',
      ),
    geometry: z
      .record(z.string(), z.unknown())
      .describe('GeoJSON Polygon covering the Item\'s spatial extent.'),
    properties: StacItemProperties,
    assets: z
      .record(z.string(), StacAsset)
      .describe(
        'Map of short asset key → asset object. Known keys: `data.cog.tif`, ' +
          '`data.mercator.png`, `overview.webp`, `tiles.pmtiles`, ' +
          '`contours.pmtiles`.',
      ),
    links: z
      .array(Link)
      .describe(
        'Graph edges — `self`, `root`, `parent`, `collection`, plus an ' +
          '`xyz` link with the tile-pyramid URL template (`{z}/{x}/{y}.png`).',
      ),
  })
  .openapi('StacItem', {
    description:
      'STAC Item for one (cycle, forecast-hour) — the canonical descriptor ' +
      'a client reads to render a dataset. Carries the encoding params, ' +
      'visualisation hints, landmask / contour references, asset list, and ' +
      'tile-template link.',
  });

/** Inferred type of a STAC Item's `properties` object (incl. the `mercator:*` fields). */
export type StacItemProperties = z.infer<typeof StacItemProperties>;
/** Inferred type of a STAC `Item` (one cycle/forecast-hour of a dataset). */
export type StacItem = z.infer<typeof StacItem>;
