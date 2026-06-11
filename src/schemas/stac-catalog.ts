import { z } from './_register.js';
import { Link } from './link.js';

/**
 * STAC Catalog — the entry point. Lists every collection (one per
 * dataset) via `links[rel=child]`.
 *
 * See https://github.com/radiantearth/stac-spec/blob/master/catalog-spec/catalog-spec.md
 * for the canonical definition.
 */
export const StacCatalog = z
  .object({
    type: z.literal('Catalog').describe('Always `"Catalog"`.'),
    stac_version: z.string().describe('STAC spec version, e.g. `"1.0.0"`.'),
    id: z
      .string()
      .describe('Catalog identifier — opaque, but stable across cycles.'),
    title: z.string().optional().describe('Human-readable catalog name.'),
    description: z
      .string()
      .describe('Markdown-formatted overview of the catalog\'s contents.'),
    links: z
      .array(Link)
      .describe(
        'Graph edges — `self`, `root` (self-reference), and one `child` ' +
          'link per published collection. Walk those to discover datasets.',
      ),
  })
  .openapi('StacCatalog', {
    description:
      'STAC Catalog — root of the discovery graph. Crawl ' +
      '`links[rel=child]` to find every available dataset.',
  });

/** Inferred type of the root STAC `Catalog` (links out to each collection). */
export type StacCatalog = z.infer<typeof StacCatalog>;
