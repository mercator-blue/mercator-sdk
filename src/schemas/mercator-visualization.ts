import { z } from './_register.js';

/**
 * Default rendering hints for the dataset — what colormap to use, what
 * value range looks reasonable, log vs linear scaling, thresholding
 * defaults. Renderers (the SDK, the in-repo viewer, any third-party
 * UI) read this for sensible out-of-the-box appearance; users override
 * via host controls.
 *
 * Lives on each STAC Item as `properties.mercator:visualization`.
 */
/** Output shape of {@link ColormapSpec} — declared explicitly so the exported
 *  schema has a fast type for JSR. */
type ColormapSpecShape = string | { stops: [number, string][] };

export const ColormapSpec: z.ZodType<ColormapSpecShape> = z
  .union([
    z.string().describe('Preset name (e.g. "viridis", "rdbu", "turbo").'),
    z
      .object({
        stops: z
          .array(z.tuple([z.number(), z.string()]))
          .describe(
            'Explicit gradient as `[position 0..1, hex color]` stops, ' +
              'ascending in position.',
          ),
      })
      .describe('Custom gradient defined inline rather than as a preset.'),
  ])
  .openapi('ColormapSpec', {
    description:
      'Colormap — either a preset name from the SDK\'s bundled palette ' +
      'set or an explicit gradient definition. The SDK falls back to ' +
      '"viridis" on unknown preset names (and warns once to the console).',
  });

/**
 * Zod schema for the `mercator:visualization` STAC property: default
 * colormap, value range, scale type, and streamline speed scale that
 * renderers use for out-of-the-box appearance.
 */
/** Output shape of {@link MercatorVisualization} — declared explicitly so the
 *  exported schema has a fast type for JSR. */
type MercatorVisualizationShape = {
  particle_speed_scale?: number;
  vmin: number;
  vmax: number;
  colormap?: ColormapSpecShape;
  scale_type?: 'linear' | 'log';
  transparent_below?: number;
  alpha_by_value?: boolean;
};

export const MercatorVisualization: z.ZodType<MercatorVisualizationShape> = z
  .object({
    particle_speed_scale: z
      .number()
      .optional()
      .describe(
        'Default particle advection scale for streamline renderers — ' +
          'mercator units per (m/s) per frame at z=0. Vector datasets only.',
      ),
    vmin: z.number().describe(
      'Lower bound of the colormap / particle-speed scale. Used as the ' +
        'normalisation floor for `t = (value - vmin) / (vmax - vmin)`.',
    ),
    vmax: z.number().describe(
      'Upper bound of the colormap / particle-speed scale.',
    ),
    colormap: ColormapSpec.optional().describe(
      'Default palette. Renderers should pick this when no user override ' +
        'is set; users can swap to any preset name they like.',
    ),
    scale_type: z
      .enum(['linear', 'log'])
      .optional()
      .describe(
        'How decoded values map to colormap position. `linear` (default) ' +
          'for most fields; `log` for skewed distributions like ' +
          'precipitation or snow accumulation.',
      ),
    transparent_below: z
      .number()
      .optional()
      .describe(
        'Hard discard threshold — pixels with decoded value ≤ this become ' +
          'fully transparent so the basemap shows through. Useful for ' +
          'precipitation ("show nothing below 0.1 mm/h"). Default: none.',
      ),
    alpha_by_value: z
      .boolean()
      .optional()
      .describe(
        'When `true`, output alpha fades with colormap position so low- ' +
          'magnitude pixels are nearly transparent and high-magnitude ' +
          'pixels are fully opaque. Useful for cloud-cover-style overlays.',
      ),
  })
  .openapi('MercatorVisualization', {
    description:
      'Default rendering hints — colormap, value range, scale, alpha ' +
      'behaviour. Lives on each STAC Item as ' +
      '`properties.mercator:visualization`.',
    example: {
      vmin: 0,
      vmax: 40,
      colormap: 'viridis',
      scale_type: 'linear',
      particle_speed_scale: 0.00006,
    },
  });

/** Inferred type of a colormap spec: a preset name or an inline gradient. */
export type ColormapSpec = z.infer<typeof ColormapSpec>;
/** Inferred type of the `mercator:visualization` property. */
export type MercatorVisualization = z.infer<typeof MercatorVisualization>;
