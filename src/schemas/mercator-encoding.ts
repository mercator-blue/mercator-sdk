import { z } from './_register.js';

/**
 * Value-encoding parameters carried on every STAC Item as
 * `properties.mercator:encoding`. A decoder needs these to convert the
 * raw bytes in a tile PNG back into physical units.
 *
 * See the "Tile encoding" guide in the API docs for the full byte-
 * layout spec, including the no-data sentinel for vector kinds and
 * the integration gotchas (NEAREST sampling, premultiplied alpha,
 * canvas-2D round-trip pitfalls).
 */
/** Output shape of {@link MercatorEncoding} — declared explicitly so the
 *  exported schema has a fast type for JSR. */
type MercatorEncodingShape = {
  id: string;
  kind: 'rg16_fixed' | 'vector_rg_ba' | 'image_rgba' | 'mapbox_rgb';
  scale: number;
  offset: number;
  unit: string;
  components?: string[];
  observed_range?: Record<string, [number, number]>;
};

export const MercatorEncoding: z.ZodType<MercatorEncodingShape> = z
  .object({
    id: z.string().describe(
      'Stable identifier for this encoding, unique within the item. ' +
        'Useful when an item carries multiple encodings (e.g. a precise ' +
        '`rg16` for paying customers + a pre-coloured `image_rgba` for ' +
        'the free tier).',
    ),
    kind: z
      .enum(['rg16_fixed', 'vector_rg_ba', 'image_rgba', 'mapbox_rgb'])
      .describe(
        'How the value bytes are packed into PNG channels. See the ' +
          '"Tile encoding" guide for the per-kind byte layout.',
      ),
    scale: z.number().describe(
      'Multiplier applied to the raw integer extracted from the PNG ' +
        'channels: `value = raw * scale + offset`.',
    ),
    offset: z.number().describe(
      'Bias added after multiplication: `value = raw * scale + offset`.',
    ),
    unit: z.string().describe(
      'Canonical lowercase unit name. Examples: `kelvin`, `celsius`, ' +
        '`pascal`, `meters_per_second`, `percent`, `kilograms_per_kilogram`.',
    ),
    components: z
      .array(z.string())
      .optional()
      .describe(
        'For vector kinds, the physical quantities the per-channel pairs ' +
          'represent. Typically `["u", "v"]` (eastward, northward in m/s). ' +
          'Omitted for scalar kinds.',
      ),
    observed_range: z
      .record(z.string(), z.tuple([z.number(), z.number()]))
      .optional()
      .describe(
        'Per-component observed `[min, max]` in this item — a hint for ' +
          'palette ranges. The decodable range is wider; this is what ' +
          'the source actually held at encode time.',
      ),
  })
  .openapi('MercatorEncoding', {
    description:
      'Value-encoding parameters needed to decode tile PNGs back to ' +
      'physical units. Lives on each STAC Item as ' +
      '`properties.mercator:encoding`.',
    example: {
      id: 'rg16_meters_per_second',
      kind: 'vector_rg_ba',
      scale: 0.01,
      offset: -100.0,
      unit: 'meters_per_second',
      components: ['u', 'v'],
    },
  });

/** Inferred type of the `mercator:encoding` value-encoding spec. */
export type MercatorEncoding = z.infer<typeof MercatorEncoding>;
