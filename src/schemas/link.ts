import { z } from './_register.js';

/**
 * STAC Link — a hyperlink to a related document (parent catalog, child
 * collection, item, asset URL template, etc.). Used in every STAC
 * document to express graph edges.
 *
 * Standard fields are defined by the STAC spec — see
 * https://github.com/radiantearth/stac-spec/blob/master/commons/links.md
 * for the canonical list of `rel` values.
 */
export const Link = z
  .object({
    rel: z.string().describe(
      'The relation of the target document to the current one. Common ' +
        'values: "self", "root", "parent", "child" (catalog→collection), ' +
        '"item" (collection→item), "xyz" (item→tile URL template, from ' +
        'the Web Map Links extension), "data" (asset), "overview" ' +
        '(thumbnail).',
    ),
    href: z.string().describe(
      'URL of the target. Relative to the document containing the link, ' +
        'unless absolute. Resolve against the link\'s own URL (or the ' +
        'document\'s self-link) when crawling.',
    ),
    type: z.string().optional().describe(
      'Media type of the target — e.g. "application/json" for STAC ' +
        'documents, "image/png" for tile templates.',
    ),
    title: z.string().optional().describe(
      'Human-readable label for the link.',
    ),
  })
  .openapi('Link', {
    description:
      'Hyperlink to a related STAC document or asset. See the STAC spec ' +
      'for the canonical `rel` values.',
    example: {
      rel: 'child',
      href: 'tiles/wind10m/collection.json',
      type: 'application/json',
      title: '10m wind',
    },
  });

/** Inferred type of a STAC `Link` object (rel + href, plus optional type/title). */
export type Link = z.infer<typeof Link>;
