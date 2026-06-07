import { z } from './_register.js';

/**
 * Tile-pyramid metadata for the value-encoded raster. Lives on each
 * STAC Item as `properties.mercator:tile`. Renderers read this to size
 * their texture caches and clamp zoom requests to what's actually
 * published.
 */
export const MercatorTile = z
  .object({
    minzoom: z.number().int().describe(
      'Lowest published zoom level for the value-encoded raster pyramid.',
    ),
    maxzoom: z.number().int().describe(
      'Highest published zoom level. Renderers may overzoom past this ' +
        'for display, but tile fetches above maxzoom return 404.',
    ),
    size: z.number().int().describe(
      'Tile edge length in pixels. Always 256 in v1; reserved for higher- ' +
        'resolution tiles later.',
    ),
    projection: z
      .string()
      .describe('Projection identifier. Always `EPSG:3857` (Web Mercator).'),
  })
  .openapi('MercatorTile', {
    description:
      'Tile-pyramid bounds for the value-encoded raster. Use the ' +
      '`xyz`-rel link on the Item to construct tile URLs.',
    example: {
      minzoom: 0,
      maxzoom: 5,
      size: 256,
      projection: 'EPSG:3857',
    },
  });

export type MercatorTile = z.infer<typeof MercatorTile>;
