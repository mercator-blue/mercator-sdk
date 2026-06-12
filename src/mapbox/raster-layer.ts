/**
 * MapLibre custom layer that decodes value-encoded PNG tiles (rg16_fixed for
 * scalars, vector_rg_ba for vector fields) in a fragment shader and applies a
 * sequential or diverging colormap.
 *
 * Shaders use MapLibre 5's `args.shaderData.vertexShaderPrelude` + the
 * `projectTile()` function so the layer renders correctly under both Mercator
 * and globe projections — same source code, projection-data uniforms tell
 * `projectTile()` which math to apply each frame.
 */

import { createProgram } from '../core/webgl-helpers';
import { lngLatToTileXY, posMod } from '../core/mercator';
import { resolveColormap } from '../core/color/colormaps';
import { uploadColormapTexture } from '../core/color/colormap-texture';
import type { ColormapSpec, EncodingKind } from '../core/types';
import { normalizeRenderArgs, type NormalisedRenderArgs } from './host-adapter';
import { expandTileUrl } from '../core/urls';

// GLSL bodies are statically inlined as string constants by the shader
// barrel (see ./shaders/index.ts). All shaders here are GLSL 3.00 ES —
// the JS prepends `#version` + a host-specific projection prelude at
// runtime (MapLibre 5's full globe-aware prelude under MapLibre, or a
// minimal Mercator-only prelude under Mapbox GL JS).
import { RASTER_VS, SCALAR_FS, VECTOR_FS, ELEVATION_FS } from './shaders/index.js';

// Encoding-kind → fragment shader. The only thing this layer needs to
// vary per encoding. vmin / vmax / colormap / etc. all flow in from
// STAC `mercator:visualization` via build-layer.ts — they're
// dataset-author choices, not encoding-class defaults. (The elevation
// shader hypsometric-tints internally and ignores vmin/vmax entirely.)
const ENCODING_TO_FS: Record<EncodingKind, string> = {
  rg16_fixed: SCALAR_FS,
  vector_rg_ba: VECTOR_FS,
  mapbox_rgb: ELEVATION_FS,
};

function buildProgram(
  gl: WebGL2RenderingContext,
  shaderData: NormalisedRenderArgs['shaderData'],
  fsBody: string,
): WebGLProgram {
  const prelude = shaderData?.vertexShaderPrelude ?? '';
  const define = shaderData?.define ?? '';
  const vsSource = `#version 300 es\n${prelude}\n${define}\n${RASTER_VS}`;
  const fsSource = `#version 300 es\n${fsBody}`;
  return createProgram(gl, vsSource, fsSource);
}

export interface RasterLayerOpts {
  /** MapLibre/Mapbox layer id. */
  id: string;
  /** PNG tile URL template with `{z}/{x}/{y}` placeholders. */
  tileUrlTemplate: string;
  /** Encoding kind + decoded-value scale/offset from the STAC item. */
  encoding: {
    type: EncodingKind;
    scale: number;
    offset: number;
  };
  minzoom: number;
  maxzoom: number;
  /** Layer opacity (0..1). Default 0.75. */
  opacity?: number;
  /** Display range min (defaults per encoding via the dataset's
   *  `mercator:visualization.vmin`). */
  vmin?: number;
  /** Display range max. */
  vmax?: number;
  /** Bilinear (smooth) vs nearest (blocky) sampling. Bilinear is done
   *  manually in decoded-value space because hardware LINEAR on
   *  rg16_fixed produces garbage at byte boundaries. Default true. */
  smooth?: boolean;
  /** Colormap axis mapping. Log is for skewed scalar fields
   *  (precipitation, snow accumulation). Default `'linear'`. */
  scaleType?: 'linear' | 'log';
  /** Discard threshold — pixels at or below this decoded value are
   *  dropped so the basemap shows through. */
  transparentBelow?: number;
  /** Mapbox GL JS v3 Standard slot. Ignored on Mapbox classic + MapLibre. */
  slot?: string;
  /** When true, alpha ramps with the colormap position `t`; used for
   *  cloud-cover-style overlays that should fade smoothly into the
   *  basemap instead of hard-clipping. Default false. */
  alphaByValue?: boolean;
  /** Colormap preset name or explicit gradient stops. Default `'viridis'`. */
  colormap?: ColormapSpec;
}

// Single mutable shape — `status` is patched in place between
// `'loading' → 'loaded'` / `'error'`. A discriminated union would force
// `as unknown as` casts at every transition; the flat shape lets the
// `if (tile.status === 'loaded')` callers narrow `texture` via a
// non-null assertion, which is correct by construction (only loaded
// entries have a texture).
interface TileEntry {
  status: 'loading' | 'loaded' | 'error';
  texture: WebGLTexture | null;
}

interface TileCoord {
  z: number;
  x: number;
  y: number;
}
interface QueueEntry extends TileCoord {
  texture: WebGLTexture;
}

/**
 * State the custom WebGL layer attaches to `this` between onAdd and
 * onRemove. See tile-boundaries-overlay.ts for the LayerThis pattern.
 */
interface RasterLayerThis {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map: any;
  gl: WebGL2RenderingContext;
  opacity: number;
  smooth: boolean;
  logScale: boolean;
  transparentBelow: number;
  alphaByValue: boolean;
  colormapData: Float32Array;
  colormapTexture: WebGLTexture | null;
  colormapDirty: boolean;
  tiles: Map<string, TileEntry>;

  program: WebGLProgram | null;
  programVariant: string | null;

  meshVertCount: number;
  vbo: WebGLBuffer | null;

  attrPos: GLint;
  uTile: WebGLUniformLocation | null;
  uTex: WebGLUniformLocation | null;
  uScale: WebGLUniformLocation | null;
  uOffset: WebGLUniformLocation | null;
  uVmin: WebGLUniformLocation | null;
  uVmax: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uSmooth: WebGLUniformLocation | null;
  uColormap: WebGLUniformLocation | null;
  uLogScale: WebGLUniformLocation | null;
  uTransparentBelow: WebGLUniformLocation | null;
  uAlphaByValue: WebGLUniformLocation | null;
  uTexN: WebGLUniformLocation | null;
  uTexS: WebGLUniformLocation | null;
  uTexW: WebGLUniformLocation | null;
  uTexE: WebGLUniformLocation | null;
  uHas: WebGLUniformLocation | null;

  uProjMatrix: WebGLUniformLocation | null;
  uProjTileCoords: WebGLUniformLocation | null;
  uProjClipping: WebGLUniformLocation | null;
  uProjTransition: WebGLUniformLocation | null;
  uProjFallback: WebGLUniformLocation | null;
  uMapboxGlobeToMercator: WebGLUniformLocation | null;
  uMapboxGlobeTransition: WebGLUniformLocation | null;
  uMapboxCenterMercator: WebGLUniformLocation | null;

  _ensureProgram(gl: WebGL2RenderingContext, normalised: NormalisedRenderArgs): void;
  _setProjectionUniforms(gl: WebGL2RenderingContext, normalised: NormalisedRenderArgs): void;
  targetTiles(): TileCoord[];
  _cornersOnDisc(): boolean;

  // Runtime setters (declared so this-typed methods can dispatch via
  // `this.setX(...)` from applyOptions).
  setOpacity(o: number): void;
  setSmooth(s: boolean): void;
  setColormap(spec: ColormapSpec): void;
  setVmin(v: number): void;
  setVmax(v: number): void;
  setScaleType(t: 'linear' | 'log'): void;
  setTransparentBelow(v: number | undefined): void;
  setAlphaByValue(v: boolean): void;
  _tilesByProjection(z: number, n: number): TileCoord[];
  _tilesBySampleBbox(z: number, n: number): TileCoord[];
  ensureTile(z: number, xLogical: number, y: number): void;
  buildDrawQueue(targets: TileCoord[]): QueueEntry[];
}

/**
 * Build a MapLibre custom layer that fetches PNG tiles from `opts.tileUrlTemplate`,
 * decodes them via the encoding-appropriate shader, and renders with the
 * configured colormap.
 */
export function createDecodedRasterLayer(opts: RasterLayerOpts) {
  const fs = ENCODING_TO_FS[opts.encoding.type];
  if (!fs) throw new Error(`@mercator-blue/sdk/mapbox: unsupported encoding type "${opts.encoding.type}".`);
  let vmin = opts.vmin ?? 0;
  let vmax = opts.vmax ?? 1;
  // Initial colormap is resolved once here; the layer also exposes
  // setColormap() so the UI can swap palettes at runtime. Accepts a
  // string preset ("rdbu", "viridis", …) or a {stops: [[pos, hex], …]}
  // object — see colormaps.ts. The elevation shader hypsometric-tints
  // internally and ignores this uniform.
  const initialColormap = resolveColormap(opts.colormap ?? 'viridis');

  return {
    id: opts.id,
    type: 'custom' as const,
    ...(opts.slot ? { slot: opts.slot } : {}),

    onAdd(this: RasterLayerThis, map: unknown, gl: WebGL2RenderingContext): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.map = map as any;
      this.gl = gl;
      this.opacity = opts.opacity ?? 0.75;
      this.smooth = opts.smooth ?? true;
      // Log scale + transparency threshold are scalar-shader features only;
      // the vector and elevation shaders ignore the corresponding uniforms.
      this.logScale = opts.scaleType === 'log';
      // Sentinel: a very negative number means "no threshold" — the shader
      // discards only when decoded value <= u_transparent_below, and any real
      // decoded value will be well above -1e30.
      this.transparentBelow = opts.transparentBelow != null
        ? opts.transparentBelow
        : -1e30;
      this.alphaByValue = !!opts.alphaByValue;
      this.colormapData = initialColormap;
      this.colormapTexture = null;
      this.colormapDirty = true;
      this.tiles = new Map();
      // Program is compiled lazily in render() — we need MapLibre's
      // `shaderData` for the projection prelude, which is only available
      // in args.
      this.program = null;
      this.programVariant = null;
      // Tessellated tile mesh, not a single quad. In globe mode each tile's
      // 4 corners project correctly to the sphere but the GPU rasterises
      // the interior as a flat plane through those corners — at low zoom
      // that plane cuts a chord across the sphere instead of curving with
      // it, so e.g. z=1 tiles appear as octahedral facets. Subdividing into
      // an N×N grid means each sub-quad's chord is small enough to be sub-
      // pixel after projection. N=32 keeps the worst-case chord (z=0,
      // ~360°×85° tile) below ~1px on a 1000px-high canvas. Mercator mode
      // is unaffected — the linear interp between corners is exact there.
      const N = 32;
      const verts: number[] = [];
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const x0 = j / N, x1 = (j + 1) / N;
          const y0 = i / N, y1 = (i + 1) / N;
          verts.push(x0, y0,  x1, y0,  x0, y1);
          verts.push(x1, y0,  x1, y1,  x0, y1);
        }
      }
      this.meshVertCount = verts.length / 2;
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    },

    onRemove(this: RasterLayerThis, _map: unknown, gl: WebGL2RenderingContext): void {
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.program) gl.deleteProgram(this.program);
      if (this.colormapTexture) gl.deleteTexture(this.colormapTexture);
      this.colormapTexture = null;
      for (const t of this.tiles.values()) {
        if (t.texture) gl.deleteTexture(t.texture);
      }
      this.tiles.clear();
    },

    setOpacity(this: RasterLayerThis, o: number): void {
      this.opacity = o;
      this.map.triggerRepaint();
    },

    setSmooth(this: RasterLayerThis, s: boolean): void {
      this.smooth = !!s;
      this.map.triggerRepaint();
    },

    /** Swap the active colormap. Accepts the same shapes as the opts at
     *  construction (preset name string OR {stops:[…]} object). */
    setColormap(this: RasterLayerThis, spec: ColormapSpec): void {
      this.colormapData = resolveColormap(spec);
      this.colormapDirty = true;
      this.map.triggerRepaint();
    },

    setVmin(this: RasterLayerThis, v: number): void {
      vmin = v;
      this.map.triggerRepaint();
    },
    setVmax(this: RasterLayerThis, v: number): void {
      vmax = v;
      this.map.triggerRepaint();
    },
    setScaleType(this: RasterLayerThis, t: 'linear' | 'log'): void {
      this.logScale = t === 'log';
      this.map.triggerRepaint();
    },
    setTransparentBelow(this: RasterLayerThis, v: number | undefined): void {
      this.transparentBelow = v != null ? v : -1e30;
      this.map.triggerRepaint();
    },
    setAlphaByValue(this: RasterLayerThis, v: boolean): void {
      this.alphaByValue = !!v;
      this.map.triggerRepaint();
    },

    /** Apply a partial options patch. Fields not relevant to the raster
     *  viz are silently ignored — see MercatorLayer.setOptions for the
     *  customer-facing entry point. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyOptions(this: RasterLayerThis, p: any): void {
      if (p.opacity != null) this.setOpacity(p.opacity);
      if (p.smooth != null) this.setSmooth(p.smooth);
      if (p.colormap != null) this.setColormap(p.colormap);
      if (p.vmin != null) this.setVmin(p.vmin);
      if (p.vmax != null) this.setVmax(p.vmax);
      if (p.scaleType != null) this.setScaleType(p.scaleType);
      if ('transparentBelow' in p) this.setTransparentBelow(p.transparentBelow);
      if (p.alphaByValue != null) this.setAlphaByValue(p.alphaByValue);
    },

    /** (Re-)compile and look up locations when the projection variant changes
     *  (e.g. Mercator ↔ globe, or MapLibre ↔ Mapbox host). Idempotent
     *  within a variant. `normalised` comes from normalizeRenderArgs(). */
    _ensureProgram(this: RasterLayerThis, gl: WebGL2RenderingContext, normalised: NormalisedRenderArgs): void {
      const variant = normalised.shaderData.variantName;
      if (this.program && this.programVariant === variant) return;
      if (this.program) gl.deleteProgram(this.program);
      this.program = buildProgram(gl, normalised.shaderData, fs);
      this.programVariant = variant;
      gl.useProgram(this.program);
      this.attrPos = gl.getAttribLocation(this.program, 'a_pos');
      this.uTile = gl.getUniformLocation(this.program, 'u_tile');
      this.uTex = gl.getUniformLocation(this.program, 'u_tex');
      this.uScale = gl.getUniformLocation(this.program, 'u_scale');
      this.uOffset = gl.getUniformLocation(this.program, 'u_offset');
      this.uVmin = gl.getUniformLocation(this.program, 'u_vmin');
      this.uVmax = gl.getUniformLocation(this.program, 'u_vmax');
      this.uOpacity = gl.getUniformLocation(this.program, 'u_opacity');
      this.uSmooth = gl.getUniformLocation(this.program, 'u_smooth');
      // Colormap is a 256×1 RGBA LUT texture (sampler2D u_colormap),
      // sampled with one texture() fetch. Bound on texture unit 5.
      this.uColormap = gl.getUniformLocation(this.program, 'u_colormap');
      this.uLogScale = gl.getUniformLocation(this.program, 'u_log_scale');
      this.uTransparentBelow = gl.getUniformLocation(this.program, 'u_transparent_below');
      this.uAlphaByValue = gl.getUniformLocation(this.program, 'u_alpha_by_value');
      // Neighbour samplers + presence vec4 (N, S, W, E). When a neighbour
      // tile isn't loaded we still bind a real texture to its unit (the
      // centre tile, dummy) and rely on the shader's `u_has` check to
      // skip the fetch — keeps drivers from complaining about samplers
      // bound to unit 0 with mixed types.
      this.uTexN = gl.getUniformLocation(this.program, 'u_texN');
      this.uTexS = gl.getUniformLocation(this.program, 'u_texS');
      this.uTexW = gl.getUniformLocation(this.program, 'u_texW');
      this.uTexE = gl.getUniformLocation(this.program, 'u_texE');
      this.uHas = gl.getUniformLocation(this.program, 'u_has');
      // Sampler-to-unit assignments are constant for the program's
      // lifetime — set once here so the per-tile loop only re-binds
      // textures, not sampler uniforms.
      gl.uniform1i(this.uTex, 0);
      if (this.uTexN !== null) gl.uniform1i(this.uTexN, 1);
      if (this.uTexS !== null) gl.uniform1i(this.uTexS, 2);
      if (this.uTexW !== null) gl.uniform1i(this.uTexW, 3);
      if (this.uTexE !== null) gl.uniform1i(this.uTexE, 4);
      if (this.uColormap !== null) gl.uniform1i(this.uColormap, 5);
      // Projection uniforms declared by the prelude. Lookups may return null
      // if the prelude is absent (extremely defensive fallback).
      this.uProjMatrix = gl.getUniformLocation(this.program, 'u_projection_matrix');
      this.uProjTileCoords = gl.getUniformLocation(this.program, 'u_projection_tile_mercator_coords');
      this.uProjClipping = gl.getUniformLocation(this.program, 'u_projection_clipping_plane');
      this.uProjTransition = gl.getUniformLocation(this.program, 'u_projection_transition');
      this.uProjFallback = gl.getUniformLocation(this.program, 'u_projection_fallback_matrix');
      // Mapbox-globe-only uniforms — null under MapLibre and Mapbox-Mercator.
      this.uMapboxGlobeToMercator = gl.getUniformLocation(this.program, 'u_mapbox_globe_to_mercator');
      this.uMapboxGlobeTransition = gl.getUniformLocation(this.program, 'u_mapbox_globe_transition');
      this.uMapboxCenterMercator = gl.getUniformLocation(this.program, 'u_mapbox_center_mercator');
    },

    /** Push projection data into the prelude's uniforms. Three branches:
     *
     *    MapLibre 5    full globe-aware uniform set from defaultProjectionData
     *    Mapbox flat   just u_projection_matrix from the MVP matrix
     *    Mapbox globe  matrix + the three ECEF-blend uniforms (globeToMercator,
     *                  transition, centerMercator)
     */
    _setProjectionUniforms(this: RasterLayerThis, gl: WebGL2RenderingContext, normalised: NormalisedRenderArgs): void {
      if (normalised.isMapbox) {
        if (this.uProjMatrix) gl.uniformMatrix4fv(this.uProjMatrix, false, normalised.matrix);
        if (normalised.isMapboxGlobe && normalised.mapboxExtras) {
          const e = normalised.mapboxExtras;
          // isMapboxGlobe is true ⇒ projectionToMercatorMatrix is set
          // (that's how the flag is derived in normalizeRenderArgs).
          // TS can't follow the discriminator across the boundary so
          // we assert.
          if (this.uMapboxGlobeToMercator) gl.uniformMatrix4fv(this.uMapboxGlobeToMercator, false, e.projectionToMercatorMatrix!);
          if (this.uMapboxGlobeTransition !== null) gl.uniform1f(this.uMapboxGlobeTransition, e.projectionToMercatorTransition ?? 1.0);
          if (this.uMapboxCenterMercator) gl.uniform2fv(this.uMapboxCenterMercator, e.centerInMercator ?? [0, 0]);
        }
        return;
      }
      const pd = normalised.defaultProjectionData;
      if (!pd) return;
      if (this.uProjMatrix) gl.uniformMatrix4fv(this.uProjMatrix, false, pd.mainMatrix);
      if (this.uProjTileCoords) gl.uniform4fv(this.uProjTileCoords, pd.tileMercatorCoords);
      if (this.uProjClipping) gl.uniform4fv(this.uProjClipping, pd.clippingPlane);
      if (this.uProjTransition !== null) gl.uniform1f(this.uProjTransition, pd.projectionTransition);
      if (this.uProjFallback) gl.uniformMatrix4fv(this.uProjFallback, false, pd.fallbackMatrix);
    },

    targetTiles(this: RasterLayerThis): TileCoord[] {
      const tileZ = Math.max(opts.minzoom, Math.min(opts.maxzoom, Math.floor(this.map.getZoom())));
      const n = 2 ** tileZ;
      // Two regimes for "which tiles do we need?":
      //
      // (a) Bbox from screen-corner unproject — O(1). Correct as long
      //     as the canvas corners actually land on the visible map
      //     surface. Always true in flat Mercator; true in globe mode
      //     once the spherical disc has grown bigger than the canvas
      //     (typically view zoom ≥ 4). Fails at low-zoom globe where
      //     the disc fits inside the canvas: corners snap to the
      //     horizon and bbox.lng/lat become meaningless.
      //
      // (b) Per-tile projection iteration — O(n²). Correct in every
      //     projection mode. Cost is bounded only when n is small —
      //     at tileZ=8 the inner loop hits ~1M project() calls per
      //     render and freezes the main thread, so we never run it
      //     past n=32 (tileZ=5) regardless of bbox quality.
      //
      // Detection: per-canvas-corner round-trip. Unproject each corner
      // and project it back; if the result lands within 2 px of where
      // it started, the corner is on-disc and bbox is trustworthy.
      // This is the same regime detection the streamlines layer uses
      // (per CLAUDE.md "globe particle seeding — two regimes").
      if (this.map.getZoom() > opts.maxzoom) return this._tilesBySampleBbox(tileZ, n);
      if (n > 32) return this._tilesBySampleBbox(tileZ, n);
      if (this._cornersOnDisc()) return this._tilesBySampleBbox(tileZ, n);
      return this._tilesByProjection(tileZ, n);
    },

    /** Canvas-corner round-trip: are all four corners on the visible
     *  map surface? In flat Mercator this is always true. In globe
     *  mode it's true once the sphere has grown bigger than the
     *  canvas. When false, screen-corner unproject snaps to the
     *  horizon and `_tilesBySampleBbox` produces a bogus bbox.
     *  Returning true here lets the cheap bbox path win in the common
     *  case; returning false falls us back to projection iteration. */
    _cornersOnDisc(this: RasterLayerThis): boolean {
      const canvas = this.map.getCanvas();
      const W = canvas.clientWidth, H = canvas.clientHeight;
      const corners: Array<[number, number]> = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
      for (const [px, py] of corners) {
        const ll = this.map.unproject([px, py]);
        if (!Number.isFinite(ll.lng) || !Number.isFinite(ll.lat)) return false;
        const back = this.map.project([ll.lng, ll.lat]);
        if (!Number.isFinite(back.x) || !Number.isFinite(back.y)) return false;
        if (Math.abs(back.x - px) > 2 || Math.abs(back.y - py) > 2) return false;
      }
      return true;
    },

    /** Per-tile projection visibility check. For each canonical (x, y) at
     *  this zoom, project five probe points (4 corners + centre) at three
     *  logical x positions (x, x-n, x+n) so antimeridian-spanning views
     *  pick up tiles on the opposite side. Include any tile where at
     *  least one probe lands inside the canvas + margin. Over-includes
     *  back-facing tiles in globe mode (map.project doesn't differentiate
     *  front/back); the vertex shader's clipping-plane check culls them. */
    _tilesByProjection(this: RasterLayerThis, z: number, n: number): TileCoord[] {
      const canvas = this.map.getCanvas();
      const W = canvas.clientWidth, H = canvas.clientHeight;
      const margin = 256;  // one tile's worth — catches tiles whose interior is visible
      const out: TileCoord[] = [];
      for (let y = 0; y < n; y++) {
        const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
        const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
        const latC = (latN + latS) * 0.5;
        for (let x = 0; x < n; x++) {
          for (const xLogical of [x - n, x, x + n]) {
            const lngW = (xLogical / n) * 360 - 180;
            const lngE = ((xLogical + 1) / n) * 360 - 180;
            const lngC = (lngW + lngE) * 0.5;
            const probes: Array<[number, number]> = [
              [lngW, latN], [lngE, latN], [lngW, latS], [lngE, latS],
              [lngC, latC],
            ];
            let visible = false;
            for (const [lng, lat] of probes) {
              const p = this.map.project([lng, lat]);
              if (Number.isFinite(p.x + p.y)
                  && p.x >= -margin && p.x <= W + margin
                  && p.y >= -margin && p.y <= H + margin) {
                visible = true;
                break;
              }
            }
            if (visible) out.push({ z, x: xLogical, y });
          }
        }
      }
      return out;
    },

    /** Screen-sample-bbox visibility (z>=6). Cheap, accurate in Mercator
     *  where the projection is uniform; reliable at this zoom because
     *  globe has flattened and screen corners always unproject to real
     *  lat/lng (no horizon-snap). */
    _tilesBySampleBbox(this: RasterLayerThis, z: number, n: number): TileCoord[] {
      const canvas = this.map.getCanvas();
      const W = canvas.clientWidth, H = canvas.clientHeight;
      const samples: Array<[number, number]> = [
        [0, 0], [W / 2, 0], [W, 0],
        [0, H / 2], [W, H / 2],
        [0, H], [W / 2, H], [W, H],
      ];
      let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
      for (const p of samples) {
        const ll = this.map.unproject(p);
        const [tx, ty] = lngLatToTileXY(ll.lng, ll.lat, z);
        if (tx < xMin) xMin = tx;
        if (tx > xMax) xMax = tx;
        if (ty < yMin) yMin = ty;
        if (ty > yMax) yMax = ty;
      }
      const xLo = Math.floor(xMin), xHi = Math.floor(xMax);
      const yLo = Math.max(0, Math.floor(yMin));
      const yHi = Math.min(n - 1, Math.floor(yMax));
      const out: TileCoord[] = [];
      for (let x = xLo; x <= xHi; x++) {
        for (let y = yLo; y <= yHi; y++) out.push({ z, x, y });
      }
      return out;
    },

    ensureTile(this: RasterLayerThis, z: number, xLogical: number, y: number): void {
      const n = 2 ** z;
      const tx = posMod(xLogical, n);
      if (y < 0 || y >= n) return;
      const key = `${z}/${tx}/${y}`;
      if (this.tiles.has(key)) return;
      const entry: TileEntry = { status: 'loading', texture: null };
      this.tiles.set(key, entry);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const gl = this.gl;
        const tex = gl.createTexture();
        if (!tex) { entry.status = 'error'; return; }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // Transition the mutable entry from loading → loaded. The
        // single object identity is preserved so map.get returns the
        // updated status on the next call without a re-set.
        entry.status = 'loaded';
        entry.texture = tex;
        this.map.triggerRepaint();
      };
      img.onerror = () => { entry.status = 'error'; };
      img.src = expandTileUrl(opts.tileUrlTemplate, z, tx, y);
    },

    buildDrawQueue(this: RasterLayerThis, targets: TileCoord[]): QueueEntry[] {
      const seen = new Set<string>();
      const queue: QueueEntry[] = [];
      for (const target of targets) {
        let z = target.z, x = target.x, y = target.y;
        while (z >= opts.minzoom) {
          const n = 2 ** z;
          const tx = posMod(x, n);
          const cacheKey = `${z}/${tx}/${y}`;
          const tile = this.tiles.get(cacheKey);
          if (tile && tile.status === 'loaded' && tile.texture) {
            const drawKey = `${z}/${x}/${y}`;
            if (!seen.has(drawKey)) {
              seen.add(drawKey);
              queue.push({ z, x, y, texture: tile.texture });
            }
            break;
          }
          z--;
          x = Math.floor(x / 2);
          y = Math.floor(y / 2);
        }
      }
      queue.sort((a, b) => a.z - b.z);
      return queue;
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(this: RasterLayerThis, gl: WebGL2RenderingContext, args: unknown, ...rest: any[]): void {
      // `args` is the MapLibre 5 args-object OR the Mapbox bare MVP
      // matrix. The trailing positional args are Mapbox-only and exist
      // when projection === 'globe'. normalizeRenderArgs picks the
      // right shader prelude + uniform pipeline for the three combos
      // (MapLibre-any / Mapbox-flat / Mapbox-globe).
      const [projection, projectionToMercatorMatrix, projectionToMercatorTransition, centerInMercator, pixelsPerMeterRatio] = rest;
      const n: NormalisedRenderArgs = normalizeRenderArgs(args, {
        projection,
        projectionToMercatorMatrix,
        projectionToMercatorTransition,
        centerInMercator,
        pixelsPerMeterRatio,
      });
      this._ensureProgram(gl, n);

      const targets = this.targetTiles();
      for (const t of targets) this.ensureTile(t.z, t.x, t.y);
      const queue = this.buildDrawQueue(targets);

      if (!this.program) return;
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.enableVertexAttribArray(this.attrPos);
      gl.vertexAttribPointer(this.attrPos, 2, gl.FLOAT, false, 0, 0);

      this._setProjectionUniforms(gl, n);

      if (this.uScale) gl.uniform1f(this.uScale, opts.encoding.scale);
      if (this.uOffset) gl.uniform1f(this.uOffset, opts.encoding.offset);
      if (this.uVmin) gl.uniform1f(this.uVmin, vmin);
      if (this.uVmax) gl.uniform1f(this.uVmax, vmax);
      if (this.uOpacity) gl.uniform1f(this.uOpacity, this.opacity);
      if (this.uSmooth !== null) gl.uniform1f(this.uSmooth, this.smooth ? 1.0 : 0.0);
      // Colormap LUT texture on unit 5 (elevation's hypsometric shader has
      // no u_colormap → uColormap is null and we skip it). Re-upload only
      // when the palette changed.
      if (this.uColormap !== null) {
        if (this.colormapDirty || !this.colormapTexture) {
          this.colormapTexture = uploadColormapTexture(gl, this.colormapData, this.colormapTexture);
          this.colormapDirty = false;
        }
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
      }
      if (this.uLogScale !== null) gl.uniform1f(this.uLogScale, this.logScale ? 1.0 : 0.0);
      if (this.uTransparentBelow !== null) gl.uniform1f(this.uTransparentBelow, this.transparentBelow);
      if (this.uAlphaByValue !== null) gl.uniform1f(this.uAlphaByValue, this.alphaByValue ? 1.0 : 0.0);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // Neighbour offsets: y=0 is north in slippy-tile coordinates, so the
      // North tile is at (x, y-1) and South at (x, y+1). Longitude wraps
      // via posMod; latitude doesn't wrap (no neighbour past the pole).
      // Order matches u_has component layout: N(.x) S(.y) W(.z) E(.w).
      const NEIGHBORS = [
        { dx:  0, dy: -1, unit: 1 },
        { dx:  0, dy:  1, unit: 2 },
        { dx: -1, dy:  0, unit: 3 },
        { dx:  1, dy:  0, unit: 4 },
      ] as const;

      for (const t of queue) {
        const tn = 2 ** t.z;
        if (this.uTile) gl.uniform4f(this.uTile, t.x / tn, t.y / tn, 1.0 / tn, 1.0 / tn);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, t.texture);

        let hasN = 0, hasS = 0, hasW = 0, hasE = 0;
        for (const nb of NEIGHBORS) {
          const nx = posMod(t.x + nb.dx, tn);
          const ny = t.y + nb.dy;
          let tex: WebGLTexture = t.texture;  // dummy fallback — keeps the sampler bound
          let present = 0;
          if (ny >= 0 && ny < tn) {
            const e = this.tiles.get(`${t.z}/${nx}/${ny}`);
            if (e && e.status === 'loaded' && e.texture) { tex = e.texture; present = 1; }
          }
          gl.activeTexture(gl.TEXTURE0 + nb.unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          if (nb.dy === -1) hasN = present;
          else if (nb.dy === 1) hasS = present;
          else if (nb.dx === -1) hasW = present;
          else hasE = present;
        }
        if (this.uHas !== null) gl.uniform4f(this.uHas, hasN, hasS, hasW, hasE);

        gl.drawArrays(gl.TRIANGLES, 0, this.meshVertCount);
      }

      // Disable our attribute array so it doesn't leak into the next
      // layer's draw on the shared default VAO (and so onRemove's
      // deleteBuffer doesn't leave a dangling enabled array → the next
      // drawArrays would throw INVALID_OPERATION).
      gl.disableVertexAttribArray(this.attrPos);
    },
  };
}
