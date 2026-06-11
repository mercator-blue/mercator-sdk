import { z } from './_register.js';

/**
 * Pointer to a static land/ocean tile pyramid for clipping particle and
 * raster rendering at coastlines. Lives on each ocean-only Item as
 * `properties.mercator:landmask`.
 *
 * The landmask is global, byte-per-pixel (category bytes), and shared
 * across every cycle of every dataset. The Worker serves it from a
 * single PMTiles archive at `tiles/landmask/landmask.pmtiles`.
 */
/** Output shape of {@link MercatorLandmask} — declared explicitly so the
 *  exported schema has a fast type for JSR. */
type MercatorLandmaskShape = {
  url_template: string;
  accepts: number[];
  maxzoom: number;
};

export const MercatorLandmask: z.ZodType<MercatorLandmaskShape> = z
  .object({
    url_template: z.string().describe(
      'URL template with `{z}/{x}/{y}` placeholders. Tile bytes are ' +
        'category PNGs — see the `accepts` field for which category ' +
        'values count as "renderable".',
    ),
    accepts: z
      .array(z.number().int())
      .describe(
        'Category bytes a renderer should treat as the data domain — for ' +
          'ocean datasets this is `[0]` (ocean). Pixels with bytes outside ' +
          'this list (land, inland water, ice) are masked.',
      ),
    maxzoom: z.number().int().describe(
      'Maximum zoom level the mask pyramid is built for. Independent of ' +
        'the data tile\'s maxzoom — the static mask can be much sharper ' +
        'than a coarse-grid dataset like HYCOM (1/12°, z=5).',
    ),
  })
  .openapi('MercatorLandmask', {
    description:
      'Reference to the static landmask tile pyramid used for coastline ' +
      'clipping. Optional; present on ocean-only datasets such as ' +
      'currents.',
    example: {
      url_template: '/tiles/landmask/{z}/{x}/{y}.png',
      accepts: [0],
      maxzoom: 8,
    },
  });

/** Inferred type of the `mercator:landmask` property (mask tile URL + accepted codes). */
export type MercatorLandmask = z.infer<typeof MercatorLandmask>;
