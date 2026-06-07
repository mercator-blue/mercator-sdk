// BitmapLayer subclass that decodes a vector_rg_ba tile (u in R+G,
// v in B+A as 16-bit fixed point), computes the speed magnitude
// √(u²+v²), and applies a colormap to the magnitude. Pairs with the
// arrows / streamlines layers to give a "coloured backdrop" for vector
// fields — same role the Mapbox/MapLibre raster-vector.frag plays in
// the other bindings.
//
// Per-pixel decoding is single-tile (no neighbour sampling, unlike the
// Mapbox version's coverage-aware bilinear seam fix). For first stab
// we accept a faint tile-edge seam where coverage drops at coastlines;
// the price of using deck.gl's BitmapLayer rather than a custom
// multi-tile shader.

import type { DefaultProps } from '@deck.gl/core';
import type { Texture } from '@luma.gl/core';
import { BitmapLayer, type BitmapLayerProps } from '@deck.gl/layers';

const vectorMagUniforms = {
  name: 'vectorMag',
  vs: '',
  fs: `\
layout(std140) uniform vectorMagUniforms {
  float scale;
  float offset;
  float vmin;
  float vmax;
  float opacity;
} vectorMag;
`,
  uniformTypes: {
    scale: 'f32',
    offset: 'f32',
    vmin: 'f32',
    vmax: 'f32',
    opacity: 'f32',
  },
} as const;

const FS_VECTOR_MAG = `\
#version 300 es
#define SHADER_NAME vector-magnitude-bitmap-layer-fragment-shader

precision highp float;

uniform sampler2D bitmapTexture;
uniform sampler2D colormapTexture;

in vec2 vTexCoord;
out vec4 fragColor;

void main() {
  vec4 tex = texture(bitmapTexture, vTexCoord);
  // No-data sentinel for vector_rg_ba: all four channels exactly zero.
  // Differs from rg16_fixed where the no-data check is alpha < 0.5.
  if (tex.r == 0.0 && tex.g == 0.0 && tex.b == 0.0 && tex.a == 0.0) discard;
  float r = floor(tex.r * 255.0 + 0.5);
  float g = floor(tex.g * 255.0 + 0.5);
  float b = floor(tex.b * 255.0 + 0.5);
  float a = floor(tex.a * 255.0 + 0.5);
  float u = (r * 256.0 + g) * vectorMag.scale + vectorMag.offset;
  float v = (b * 256.0 + a) * vectorMag.scale + vectorMag.offset;
  float speed = sqrt(u * u + v * v);
  float span = max(vectorMag.vmax - vectorMag.vmin, 1e-9);
  float t = clamp((speed - vectorMag.vmin) / span, 0.0, 1.0);
  vec3 col = texture(colormapTexture, vec2(t, 0.5)).rgb;
  float alpha = vectorMag.opacity;
  fragColor = vec4(col * alpha, alpha);
}
`;

export interface VectorMagnitudeBitmapLayerProps extends BitmapLayerProps {
  scale: number;
  offset: number;
  vmin: number;
  vmax: number;
  /** Flat Float32Array of 16 RGB stops (48 floats). */
  colormap: Float32Array;
}

export class VectorMagnitudeBitmapLayer extends BitmapLayer<VectorMagnitudeBitmapLayerProps> {
  static layerName = 'VectorMagnitudeBitmapLayer';

  static defaultProps: DefaultProps<VectorMagnitudeBitmapLayerProps> = {
    ...BitmapLayer.defaultProps,
    scale: { type: 'number', value: 1 },
    offset: { type: 'number', value: 0 },
    // MercatorRasterLayer always passes computed vmin/vmax derived
    // from STAC visualization, so these defaults are theoretical —
    // neutral 0..1 just in case the layer is ever instantiated bare.
    vmin: { type: 'number', value: 0 },
    vmax: { type: 'number', value: 1 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    colormap: { type: 'object', value: new Float32Array(256 * 3) } as any,
  };

  private _colormapTexture: Texture | null = null;
  private _lastColormap: Float32Array | null = null;

  getShaders() {
    const base = super.getShaders();
    return {
      ...base,
      fs: FS_VECTOR_MAG,
      modules: [...(base.modules ?? []), vectorMagUniforms],
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
    if (this._colormapTexture) this._colormapTexture.destroy();
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
        vectorMag: { scale, offset, vmin, vmax, opacity: opacity ?? 1 },
      });
      model.setBindings({ colormapTexture: this._colormapTexture });
    }
    super.draw(opts);
  }
}
