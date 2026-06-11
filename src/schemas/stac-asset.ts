import { z } from './_register.js';

const RasterBand = z
  .object({
    name: z.string().describe('Band identifier, unique within the asset.'),
    data_type: z
      .string()
      .describe('Numeric dtype as published — `float32`, `uint8`, etc.'),
    unit: z.string().optional().describe('Canonical unit name.'),
    scale: z
      .number()
      .optional()
      .describe('Linear scale for raw → physical units.'),
    offset: z
      .number()
      .optional()
      .describe('Linear offset added after scaling.'),
    statistics: z
      .object({
        minimum: z.number(),
        maximum: z.number(),
      })
      .optional()
      .describe('Min/max observed across the asset.'),
  })
  .openapi('RasterBand', {
    description:
      'Per-band metadata from the STAC `raster` extension. Carried on ' +
      'COG and global-PNG assets so consumers can decode without ' +
      'cross-referencing the value-encoded tile pyramid.',
  });

/**
 * One file attached to a STAC Item. Items expose assets keyed by short
 * identifiers (`data.cog.tif`, `data.mercator.png`, `overview.webp`,
 * `tiles.pmtiles`). The customer-facing slippy tile pyramid is NOT an
 * asset — it's a `rel: "xyz"` link from the STAC Web Map Links
 * extension (many URLs referenced by template, not a single file).
 */
export const StacAsset = z
  .object({
    href: z.string().describe(
      'URL of the asset. Relative to the Item document. ' +
        'Auth-gated — append your API key as `?apiKey=…` or send ' +
        '`Authorization: Bearer …`.',
    ),
    type: z.string().describe('Media type, e.g. `image/png`, `image/tiff; application=geotiff; profile=cloud-optimized`.'),
    title: z.string().optional().describe('Human-readable label for catalog UIs.'),
    roles: z
      .array(z.string())
      .describe(
        'Semantic role(s). Common values: `data` (the primary payload), ' +
          '`overview` (low-res preview), `thumbnail`, `metadata`.',
      ),
    'proj:epsg': z
      .number()
      .int()
      .optional()
      .describe(
        'EPSG code of the asset\'s projection (STAC `proj` extension). ' +
          '`3857` for Web Mercator tiles, `4326` for native-grid COGs.',
      ),
    'raster:bands': z
      .array(RasterBand)
      .optional()
      .describe(
        'Per-band metadata from the STAC `raster` extension — see ' +
          '`RasterBand`. Present on COG and global-PNG assets.',
      ),
    'file:size': z
      .number()
      .int()
      .optional()
      .describe(
        'Asset size in bytes (STAC `file` extension). The UI shows this ' +
          'as a download-size hint next to the asset link.',
      ),
  })
  .openapi('StacAsset', {
    description:
      'A single file attached to a STAC Item — COG, global PNG, ' +
      'preview WebP, PMTiles archive, etc. See ' +
      'https://github.com/radiantearth/stac-spec/blob/master/item-spec/item-spec.md#asset-object ' +
      'for the canonical STAC definition; mercator-specific ' +
      'extensions are documented via the `proj:`, `raster:`, and ' +
      '`file:` prefixed properties.',
  });

/** Inferred type of a STAC `Asset` object (href + roles + media type). */
export type StacAsset = z.infer<typeof StacAsset>;
