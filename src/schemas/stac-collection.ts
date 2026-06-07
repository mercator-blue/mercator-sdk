import { z } from './_register.js';
import { Link } from './link.js';

const Extent = z
  .object({
    spatial: z
      .object({
        bbox: z
          .array(z.array(z.number()))
          .describe(
            'Array of bounding boxes (typically one per collection): ' +
              '`[west, south, east, north]` in degrees.',
          ),
      })
      .describe('Spatial extent covered by the collection\'s items.'),
    temporal: z
      .object({
        interval: z
          .array(z.array(z.string().nullable()))
          .describe(
            'Array of time intervals `[start, end]` in ISO 8601, either ' +
              'end nullable for open ranges.',
          ),
      })
      .describe('Time intervals covered by the collection\'s items.'),
  })
  .openapi('Extent', {
    description:
      'Spatial + temporal extent — the bounding region of every Item ' +
      'in the collection.',
  });

/**
 * STAC Collection — one per variable / dataset. Lists the active Items
 * (one per cycle / forecast-hour) and carries shared metadata.
 *
 * See https://github.com/radiantearth/stac-spec/blob/master/collection-spec/collection-spec.md
 * for the canonical definition.
 */
export const StacCollection = z
  .object({
    type: z.literal('Collection').describe('Always `"Collection"`.'),
    stac_version: z.string().describe('STAC spec version, e.g. `"1.0.0"`.'),
    id: z
      .string()
      .describe(
        'Collection identifier — short variable name like `wind10m`, ' +
          '`temp2m`, `currents`.',
      ),
    title: z.string().optional().describe('Human-readable name.'),
    description: z
      .string()
      .describe(
        'Markdown-formatted summary covering the source model, variables, ' +
          'cadence, and any known caveats.',
      ),
    license: z.string().optional().describe('License identifier, e.g. `"CC-BY-4.0"`.'),
    extent: Extent,
    summaries: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Aggregated statistics or property summaries across the ' +
          'collection\'s items (STAC convention).',
      ),
    links: z
      .array(Link)
      .describe(
        'Graph edges — `self`, `root`, `parent`, plus one `item` link per ' +
          'published Item in the collection (newest cycle is listed last).',
      ),
  })
  .openapi('StacCollection', {
    description:
      'STAC Collection — per-variable index. Walk `links[rel=item]` to ' +
      'find available cycles; the newest is at the end of the array.',
  });

export type StacCollection = z.infer<typeof StacCollection>;
