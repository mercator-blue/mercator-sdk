import { z } from './_register.js';

/**
 * Reference to a vector tile pyramid carrying isolines for the dataset's
 * scalar field. Lives on scalar-dataset Items as
 * `properties.mercator:contour`.
 *
 * Each contour tile is an MVT/PBF with a single layer (named by
 * `source_layer`) of `LineString` features. Feature properties carry
 * the contour value; renderers filter by interval to display the
 * desired density.
 */
export const MercatorContour = z
  .object({
    url_template: z.string().describe(
      'URL template with `{z}/{x}/{y}` placeholders. Tile bytes are ' +
        'gzipped Mapbox Vector Tiles.',
    ),
    source_layer: z.string().describe(
      'MVT layer name to read features from. Single-layer convention; ' +
        'feature geometries are `LineString`.',
    ),
    presets: z
      .array(z.number())
      .describe(
        'Available contour intervals in the dataset\'s native unit. The ' +
          'renderer filters features by `value % interval == 0` (with a ' +
          'small epsilon) to show every Nth line.',
      ),
    default_interval: z.number().describe(
      'Recommended initial interval (one of `presets`). Picked by the SDK ' +
        'when no user override is set.',
    ),
    unit: z.string().describe(
      'Canonical unit of the contour values (matches the data encoding ' +
        'unit). Used for labelling.',
    ),
    minzoom: z.number().int().describe(
      'Lowest tile zoom level where contour features exist.',
    ),
    maxzoom: z.number().int().describe(
      'Highest tile zoom level where contour features exist.',
    ),
    user_filter_min_zoom: z.number().int().describe(
      'Lowest map zoom at which the renderer should respect user-picked ' +
        'intervals. Below this zoom the tile pyramid switches to the ' +
        'coarsest precomputed interval to avoid label clutter.',
    ),
    coarsest_interval: z.number().describe(
      'Interval used at zooms below `user_filter_min_zoom`. Typically ' +
        'the largest entry in `presets`.',
    ),
  })
  .openapi('MercatorContour', {
    description:
      'Reference to the contour MVT pyramid for scalar datasets. ' +
      'Present on Items where contour lines make sense (temperature, ' +
      'pressure, etc.).',
    example: {
      url_template: 'contours/{z}/{x}/{y}.pbf',
      source_layer: 'contours',
      presets: [1, 2, 5, 10],
      default_interval: 5,
      unit: 'celsius',
      minzoom: 0,
      maxzoom: 6,
      user_filter_min_zoom: 3,
      coarsest_interval: 10,
    },
  });

export type MercatorContour = z.infer<typeof MercatorContour>;
