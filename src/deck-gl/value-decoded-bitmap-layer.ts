// BitmapLayer subclass that decodes mercator.blue value-encoded PNG
// tiles (rg16_fixed) on the GPU and applies a colormap.
//
// deck.gl/luma.gl 9 uses uniform-buffer-objects (std140) for custom
// uniforms — `super.draw({ uniforms })` is a no-op on this version of
// BitmapLayer (it sets shaderInputs.setProps({ bitmap: ... }) and
// ignores anything else). Custom data must be passed either via a
// registered shader-module uniform block OR via a texture binding.
//
// We use both:
//   - A `valueDecoded` uniform block carries scale/offset/vmin/vmax/
//     opacity (5 scalars).
//   - The 256-entry colormap is uploaded as a 256×1 RGBA texture and
//     sampled in the fragment shader. Sampler-uniform approach
//     sidesteps std140 array padding rules (a vec3 array would round each
//     element up to vec4) and lets us swap palettes without rebuilding
//     the model.
//
// Other features deliberately deferred for the first stab: neighbour-
// tile sampling for edge seams, smooth-mode toggle, log scale,
// transparent_below, alpha_by_value, coverage-aware partial-NaN alpha.

import type { DefaultProps } from '@deck.gl/core';
import type { Texture } from '@luma.gl/core';
import { BitmapLayer, type BitmapLayerProps } from '@deck.gl/layers';

const valueDecodedUniforms = {
  name: 'valueDecoded',
  vs: '',
  fs: `\
layout(std140) uniform valueDecodedUniforms {
  float scale;
  float offset;
  float vmin;
  float vmax;
  float opacity;
} valueDecoded;
`,
  uniformTypes: {
    scale: 'f32',
    offset: 'f32',
    vmin: 'f32',
    vmax: 'f32',
    opacity: 'f32',
  },
} as const;

const FS_SCALAR = `\
#version 300 es
#define SHADER_NAME value-decoded-bitmap-layer-scalar-fragment-shader

precision highp float;

uniform sampler2D bitmapTexture;
uniform sampler2D colormapTexture;

in vec2 vTexCoord;
out vec4 fragColor;

float decode(vec4 tex) {
  float r_byte = floor(tex.r * 255.0 + 0.5);
  float g_byte = floor(tex.g * 255.0 + 0.5);
  return (r_byte * 256.0 + g_byte) * valueDecoded.scale + valueDecoded.offset;
}

void main() {
  vec4 tex = texture(bitmapTexture, vTexCoord);
  if (tex.a < 0.5) discard;
  float value = decode(tex);
  float span = max(valueDecoded.vmax - valueDecoded.vmin, 1e-9);
  float t = clamp((value - valueDecoded.vmin) / span, 0.0, 1.0);
  // Sample the colormap LUT; texCoord 0..1 across the texels, with
  // half-texel offsets handled by LINEAR filtering on the sampler.
  vec3 col = texture(colormapTexture, vec2(t, 0.5)).rgb;
  float alpha = valueDecoded.opacity;
  fragColor = vec4(col * alpha, alpha);
}
`;

export interface ValueDecodedBitmapLayerProps extends BitmapLayerProps {
  scale: number;
  offset: number;
  vmin: number;
  vmax: number;
  /** Flat Float32Array of RGB stops (PALETTE_SIZE×3 = 768 floats today).
   *  resolveColormap() output. Length-derived, so any resolution works. */
  colormap: Float32Array;
}

export class ValueDecodedBitmapLayer extends BitmapLayer<ValueDecodedBitmapLayerProps> {
  static layerName = 'ValueDecodedBitmapLayer';

  static defaultProps: DefaultProps<ValueDecodedBitmapLayerProps> = {
    ...BitmapLayer.defaultProps,
    scale: { type: 'number', value: 1 },
    offset: { type: 'number', value: 0 },
    vmin: { type: 'number', value: 0 },
    vmax: { type: 'number', value: 1 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    colormap: { type: 'object', value: new Float32Array(256 * 3) } as any,
  };

  // 256×1 RGBA texture for the colormap. Recreated when the colormap
  // prop changes; bound on every draw.
  private _colormapTexture: Texture | null = null;
  private _lastColormap: Float32Array | null = null;

  getShaders() {
    const base = super.getShaders();
    return {
      ...base,
      fs: FS_SCALAR,
      modules: [...(base.modules ?? []), valueDecodedUniforms],
    };
  }

  finalizeState(context: unknown) {
    if (this._colormapTexture) {
      this._colormapTexture.destroy();
      this._colormapTexture = null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super.finalizeState(context as any);
  }

  _ensureColormapTexture() {
    const colormap = this.props.colormap;
    if (this._colormapTexture && this._lastColormap === colormap) return;
    if (this._colormapTexture) {
      this._colormapTexture.destroy();
    }
    // Pack 16 RGB triples → 16 RGBA pixels (alpha=255). luma.gl 9 needs
    // a two-step creation: createTexture with no data, then copyImageData
    // to upload the bytes. The single-call `createTexture({ data })`
    // form on the deprecated Texture API quietly fails to upload —
    // the texture ends up zero-initialised and the colormap renders as
    // a single black stop.
    // Entry count derives from the resolved colormap length (256 stops
    // today; resolveColormap output). Resolution-agnostic so this layer
    // needs no knowledge of COLORMAP_SIZE.
    const n = (colormap.length / 3) | 0;
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      rgba[i * 4 + 0] = Math.round(colormap[i * 3 + 0] * 255);
      rgba[i * 4 + 1] = Math.round(colormap[i * 3 + 1] * 255);
      rgba[i * 4 + 2] = Math.round(colormap[i * 3 + 2] * 255);
      rgba[i * 4 + 3] = 255;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const device = (this.context as any).device;
    this._colormapTexture = device.createTexture({
      width: n,
      height: 1,
      format: 'rgba8unorm',
      data: null,
      sampler: { minFilter: 'linear', magFilter: 'linear' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._colormapTexture as any).copyImageData({ data: rgba });
    this._lastColormap = colormap;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(opts: any) {
    this._ensureColormapTexture();
    const { scale, offset, vmin, vmax, opacity } = this.props;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (this.state as any).model;
    if (model && this._colormapTexture) {
      model.shaderInputs.setProps({
        valueDecoded: { scale, offset, vmin, vmax, opacity: opacity ?? 1 },
      });
      model.setBindings({ colormapTexture: this._colormapTexture });
    }
    super.draw(opts);
  }
}
