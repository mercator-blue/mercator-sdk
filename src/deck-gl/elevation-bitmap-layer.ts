// BitmapLayer subclass that decodes Mapbox Terrain-RGB (`mapbox_rgb`)
// elevation tiles and applies a built-in hypsometric (topographic) tint.
//
// Decoding:  height_m = -10000 + (R * 65536 + G * 256 + B) * 0.1
//
// The colour ramp is hard-coded — abyssal blue → coastal cyan → green
// shoreline → tan foothills → brown highlands → white snow. Matches the
// MapLibre/Mapbox binding's `raster-elevation.frag` so the deck.gl
// output reads the same way side-by-side. STAC `mercator:encoding.scale`
// and `.offset` are ignored: Mapbox Terrain-RGB is its own fixed
// protocol with the constants baked in.
//
// Deliberately omitted vs the Mapbox shader: neighbour-tile sampling
// for bilinear edge seams. deck.gl's BitmapLayer hands us one tile per
// instance with no access to N/S/W/E siblings, so we accept a faint
// seam at tile boundaries (~1 px) in exchange for the simpler layer.
// Add later if customers complain.

import type { DefaultProps } from '@deck.gl/core';
import { BitmapLayer, type BitmapLayerProps } from '@deck.gl/layers';

const elevationUniforms = {
  name: 'elevationUniforms',
  vs: '',
  fs: `\
layout(std140) uniform elevationUniforms {
  float opacity;
} elevationU;
`,
  uniformTypes: {
    opacity: 'f32',
  },
} as const;

const FS_ELEVATION = `\
#version 300 es
#define SHADER_NAME elevation-bitmap-layer-fragment-shader

precision highp float;

uniform sampler2D bitmapTexture;

in vec2 vTexCoord;
out vec4 fragColor;

float decode(vec4 tex) {
  float R = floor(tex.r * 255.0 + 0.5);
  float G = floor(tex.g * 255.0 + 0.5);
  float B = floor(tex.b * 255.0 + 0.5);
  return -10000.0 + (R * 65536.0 + G * 256.0 + B) * 0.1;
}

vec3 hypsometric(float h) {
  if (h <= 0.0) {
    // Sea: deep abyssal blue → shallow cyan-blue near the coast.
    float t = clamp((h + 8000.0) / 8000.0, 0.0, 1.0);
    return mix(vec3(0.02, 0.05, 0.18), vec3(0.55, 0.78, 0.95), t);
  }
  if (h < 500.0)  return mix(vec3(0.32, 0.55, 0.20), vec3(0.65, 0.78, 0.40), h / 500.0);
  if (h < 1500.0) return mix(vec3(0.65, 0.78, 0.40), vec3(0.85, 0.75, 0.40), (h - 500.0) / 1000.0);
  if (h < 3000.0) return mix(vec3(0.85, 0.75, 0.40), vec3(0.65, 0.50, 0.35), (h - 1500.0) / 1500.0);
  if (h < 5000.0) return mix(vec3(0.65, 0.50, 0.35), vec3(0.85, 0.80, 0.75), (h - 3000.0) / 2000.0);
  return mix(vec3(0.85, 0.80, 0.75), vec3(1.0, 1.0, 1.0),
             clamp((h - 5000.0) / 3000.0, 0.0, 1.0));
}

void main() {
  vec4 tex = texture(bitmapTexture, vTexCoord);
  if (tex.a < 0.5) discard;
  float h = decode(tex);
  float a = elevationU.opacity;
  fragColor = vec4(hypsometric(h) * a, a);
}
`;

export type ElevationBitmapLayerProps = BitmapLayerProps;

export class ElevationBitmapLayer extends BitmapLayer<ElevationBitmapLayerProps> {
  static layerName = 'ElevationBitmapLayer';

  static defaultProps: DefaultProps<ElevationBitmapLayerProps> = {
    ...BitmapLayer.defaultProps,
  };

  getShaders() {
    const base = super.getShaders();
    return {
      ...base,
      fs: FS_ELEVATION,
      modules: [...(base.modules ?? []), elevationUniforms],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(opts: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (this.state as any).model;
    if (model) {
      model.shaderInputs.setProps({
        elevationUniforms: { opacity: this.props.opacity ?? 1 },
      });
    }
    super.draw(opts);
  }
}
