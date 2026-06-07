/**
 * Leaflet binding — animated particle / streamline layer for vector_rg_ba
 * datasets (wind, currents, …). Particles are advected per-frame by the
 * sampled u/v field, drawn into a ping-pong FBO trail buffer that fades
 * each frame, and composited over the basemap with premultiplied alpha.
 *
 * Architecture is the Mapbox streamlines-layer's, stripped of every
 * globe/host-adapter concern: Leaflet is Mercator-only so we project
 * with a single split-precision uniform pair (origin in clip space at
 * (-1, 1), particle delta from `tlMx/tlMy` as the attribute) and skip
 * the prelude machinery the Mapbox layer carries.
 *
 * Trail handling: per-frame in the rAF loop, hash `(zoom, center)` into
 * a camera signature. If it changed, re-anchor the canvas and clear the
 * trail FBOs — same "clear-on-camera-change" pattern called out in the
 * Mapbox `streamlines-layer.ts` CLAUDE.md notes, just without the
 * pitch/bearing terms (Leaflet doesn't have them). The 1/255 trail
 * quantum-stick bug is sidestepped by the fade fragment shader
 * subtracting 0.6/255 after each multiply, identical to Mapbox.
 *
 * Zoom animation: CSS scale-transform during the 250ms anim, same
 * `_getNewPixelOrigin` formula as the raster layer. The per-frame
 * re-anchor inside `_step` is GUARDED on `map._animatingZoom` so it
 * doesn't overwrite the scale transform mid-animation.
 *
 * Landmask: an INDEPENDENT mask-tile cache fetched at its own zoom
 * (`landmaskMaxZ`, decoupled from the data tile's maxzoom so the
 * coastline stays sharp past the data's resolution ceiling). Particles
 * whose current position samples to a non-accepted mask byte are
 * recycled — same strategy as the Mapbox streamlines binding. Without a
 * landmask configured, only the `(0,0,0,0)` NaN sentinel applies.
 */

import { lngToTileX, latToTileY, posMod } from '../core/mercator';
import { loadTilePixels } from '../core/tile-pixel-reader';
import { resolveColormap } from '../core/colormaps';
import { uploadColormapTexture } from '../core/colormap-texture';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, absolutiseUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import type { ColormapSpec, MercatorStreamlinesOptions } from '../core/types';
import { createProgram } from '../core/webgl-helpers';

// Fraction of viewport dimension to extend the seeding bbox past the
// visible edges so directional flows don't starve the downstream rim.
const SEED_MARGIN = 0.2;

/** Leaflet-specific extras on top of the cross-binding
 *  {@link MercatorStreamlinesOptions}. */
export type MercatorStreamlinesLayerOpts = MercatorStreamlinesOptions & {
  /** Landmask tile URL template. Defaults to the dataset's
   *  `mercator:landmask.url_template`; pass to override. */
  landmaskUrlTemplate?: string;
  /** Mask category bytes treated as ocean (e.g. `[0]`). Defaults to the
   *  dataset's `mercator:landmask.accepts`. */
  landmaskAccepts?: number[];
  /** Highest zoom the landmask pyramid is built for. Defaults to the
   *  dataset's `mercator:landmask.maxzoom`. */
  landmaskMaxZ?: number;
  /** Leaflet pane. Default `overlayPane`. */
  pane?: string;
};

// -- Tile cache --------------------------------------------------------

type DataTile =
  | { status: 'loading' }
  | { status: 'loaded'; u: Float32Array; v: Float32Array; W: number; H: number }
  | { status: 'error' };

// Landmask tiles are single-byte (L-mode) category PNGs; the WebGL
// pixel reader replicates L → RGBA, so the byte lands in the R channel.
// Compacted to one byte/px (4× less memory, no stride on lookup).
type MaskTile =
  | { status: 'loading' }
  | { status: 'loaded'; mask: Uint8Array; W: number; H: number }
  | { status: 'error' };

function getL(): any {
  const L = (globalThis as any).L;
  if (!L || !L.Layer) {
    throw new Error(
      '@mercator-blue/sdk/leaflet: Leaflet not found on `globalThis.L`. ' +
      'Load Leaflet before importing the SDK.',
    );
  }
  return L;
}

async function loadTile(
  cache: Map<string, DataTile>,
  tileUrlTemplate: string,
  encoding: { scale: number; offset: number },
  z: number, x: number, y: number,
): Promise<void> {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) return;
  cache.set(key, { status: 'loading' });
  try {
    const url = tileUrlTemplate
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const { width: W, height: H, pixels } = await loadTilePixels(url);
    const u = new Float32Array(W * H);
    const v = new Float32Array(W * H);
    const sc = encoding.scale, off = encoding.offset;
    for (let i = 0; i < W * H; i++) {
      const r = pixels[i * 4], g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2], a = pixels[i * 4 + 3];
      if ((r | g | b | a) === 0) { u[i] = NaN; v[i] = NaN; continue; }
      u[i] = (r * 256 + g) * sc + off;
      v[i] = (b * 256 + a) * sc + off;
    }
    cache.set(key, { status: 'loaded', u, v, W, H });
  } catch {
    cache.set(key, { status: 'error' });
  }
}

async function loadMaskTile(
  cache: Map<string, MaskTile>,
  urlTemplate: string,
  z: number, x: number, y: number,
): Promise<void> {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) return;
  cache.set(key, { status: 'loading' });
  try {
    const url = urlTemplate
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const { width: W, height: H, pixels } = await loadTilePixels(url);
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = pixels[i * 4];
    cache.set(key, { status: 'loaded', mask, W, H });
  } catch {
    // 404 etc. → "no mask here"; sampleLandmask falls back to a coarser
    // zoom, or returns 'unknown' (treated as ocean) if nothing's loaded.
    cache.set(key, { status: 'error' });
  }
}

// -- Shaders -----------------------------------------------------------
// The POINTS program is GLSL 3.00 ES (`#version 300 es` must be the very
// first line) because the colormap sampler needs `min(int,int)` and
// dynamic array indexing — both disallowed in GLSL 1.00 ES fragment
// shaders. The QUAD/FADE/COMPOSITE program stays 1.00 ES (it does no
// array indexing); WebGL2 happily runs both versions in one context.

import {
  POINTS_VS,
  POINTS_FS,
  QUAD_VS,
  FADE_FS,
  STREAMLINES_COMPOSITE_FS as COMPOSITE_FS,
} from './shaders/index';

interface FB { fb: WebGLFramebuffer; tex: WebGLTexture; }

function createFB(gl: WebGL2RenderingContext, w: number, h: number): FB {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex };
}

let LayerClass: any = null;

function ensureLayerClass(): any {
  if (LayerClass) return LayerClass;
  const L = getL();

  LayerClass = L.Layer.extend({
    initialize(this: any, opts: any) {
      L.setOptions(this, opts);
      this._item = opts.item as DiscoveredItem;
      this._apiKey = opts.apiKey as string | undefined;
      this._tileUrlTemplate = withApiKey(
        `${this._item.itemBase}/{z}/{x}/{y}.png`,
        this._apiKey,
      );
      if (this._item.encoding.kind !== 'vector_rg_ba') {
        throw new Error(
          `@mercator-blue/sdk/leaflet: MercatorStreamlinesLayer requires a vector_rg_ba ` +
          `encoding; got "${this._item.encoding.kind}".`,
        );
      }

      this._N = opts.particleCount ?? 8000;
      this._pointSize = opts.pointSize ?? 3;
      // STAC publishes a per-dataset `particle_speed_scale` (mercator
      // units per (m/s) per frame at z=0) tuned so 1× gives sensible
      // visible motion. Wind10m's is ~6e-5; currents is ~3.6e-3 (about
      // 60× slower in m/s but the slider expects the same 0.25–3 range).
      this._speedScale = opts.speedScale ?? this._item.visualization?.particle_speed_scale ?? 6e-5;
      this._maxAge = opts.maxAge ?? 600;
      this._fade = opts.fade ?? 0.99;
      this._colorBySpeed = opts.colorBySpeed ?? true;
      this._colormapData = resolveColormap(
        opts.colormap ?? this._item.visualization?.colormap ?? 'viridis',
      );
      this._colormapTexture = null;
      this._colormapDirty = true;
      this._vmin = opts.vmin ?? 0;
      this._vmax = opts.vmax ?? this._item.visualization?.vmax ?? 40;
      this._opacity = opts.opacity ?? 0.9;
      this._maxzoom = this._item.tile.maxzoom;

      // Landmask: prefer an explicit opt, else the dataset's STAC entry.
      // The item template is relative → absolutise + key (same path as
      // data tiles). Mask zoom is decoupled from data zoom (its own
      // pyramid maxzoom) so the coastline can stay sharp past the data's
      // resolution ceiling — e.g. currents data is z=5, mask is z=8.
      const lmTemplate = opts.landmaskUrlTemplate ?? this._item.landmask?.url_template;
      this._landmaskUrlTemplate = lmTemplate
        ? withApiKey(absolutiseUrl(lmTemplate, this._item.itemBase), this._apiKey)
        : undefined;
      const lmAccepts = opts.landmaskAccepts ?? this._item.landmask?.accepts;
      this._landmaskAccepts = lmAccepts ? new Set(lmAccepts) : null;
      this._landmaskMaxZ = opts.landmaskMaxZ ?? this._item.landmask?.maxzoom ?? this._maxzoom;
      this._maskTargetZ = 0;

      this._cache = new Map<string, DataTile>();
      this._maskCache = new Map<string, MaskTile>();
      // Particle state stored as parallel arrays so we can pack into a
      // typed array at upload time without per-particle allocs.
      this._mx = new Float64Array(this._N);
      this._my = new Float64Array(this._N);
      this._age = new Uint32Array(this._N);
      this._speed = new Float32Array(this._N);
      this._buf = new Float32Array(this._N * 3);
      for (let i = 0; i < this._N; i++) this._speed[i] = -1; // dead until first reseed
      this._lastCameraSig = '';
      this._cameraMoving = false;
      this._rAF = 0;
    },

    onAdd(this: any, map: any): any {
      this._map = map;
      const pane = (this.options.pane as string) ?? 'overlayPane';
      const paneEl = map.getPane(pane);

      const canvas = L.DomUtil.create('canvas', 'mercator-streamlines-layer') as HTMLCanvasElement;
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      // Between raster (200) and arrows (250). Streamlines look best
      // OVER raster (gives them a coloured backdrop) but under arrows.
      canvas.style.zIndex = '220';
      canvas.style.transformOrigin = '0 0';
      paneEl.appendChild(canvas);
      this._canvas = canvas;

      const gl = canvas.getContext('webgl2', {
        premultipliedAlpha: false,
        antialias: false,
      });
      if (!gl) throw new Error('@mercator-blue/sdk/leaflet: WebGL2 unavailable');
      this._gl = gl;

      this._initGL();

      // Kick a z=0 tile load so the walk-down sampler in `_sample` has a
      // guaranteed coarse fallback from frame zero. Without it, the
      // first second or so after `addTo` shows no particles at all
      // because every sample at dataZ fails until the first higher-zoom
      // tile lands.
      void loadTile(this._cache, this._tileUrlTemplate, this._item.encoding, 0, 0, 0);
      // Same coarse-fallback preload for the mask, so the walk-down in
      // `_sampleLandmask` has a z=0 tile to fall back on from frame zero.
      if (this._landmaskUrlTemplate && this._landmaskAccepts) {
        void loadMaskTile(this._maskCache, this._landmaskUrlTemplate, 0, 0, 0);
      }

      map.on('zoomanim', this._onZoomAnim, this);
      map.on('zoomend', this._onZoomEnd, this);

      // rAF drives the simulation. Detection of camera change is done
      // inside `_step` (via signature comparison) — no `move` listener
      // needed; the simulation polls every frame anyway.
      this._step = this._step.bind(this);
      this._rAF = requestAnimationFrame(this._step);
      return this;
    },

    onRemove(this: any, map: any): any {
      if (this._rAF) cancelAnimationFrame(this._rAF);
      this._rAF = 0;
      map.off('zoomanim', this._onZoomAnim, this);
      map.off('zoomend', this._onZoomEnd, this);

      const gl = this._gl as WebGL2RenderingContext;
      if (this._pointsProgram) gl.deleteProgram(this._pointsProgram);
      if (this._fadeProgram) gl.deleteProgram(this._fadeProgram);
      if (this._compProgram) gl.deleteProgram(this._compProgram);
      if (this._particleVbo) gl.deleteBuffer(this._particleVbo);
      if (this._quadVbo) gl.deleteBuffer(this._quadVbo);
      if (this._fbA) { gl.deleteFramebuffer(this._fbA.fb); gl.deleteTexture(this._fbA.tex); }
      if (this._fbB) { gl.deleteFramebuffer(this._fbB.fb); gl.deleteTexture(this._fbB.tex); }
      if (this._colormapTexture) gl.deleteTexture(this._colormapTexture);
      this._colormapTexture = null;

      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      this._canvas = null;
      this._gl = null;
      this._map = null;
      this._cache.clear();
      this._maskCache.clear();
      return this;
    },

    _initGL(this: any): void {
      const gl = this._gl as WebGL2RenderingContext;

      this._pointsProgram = createProgram(gl, POINTS_VS, POINTS_FS);
      this._pointsAttrPos = gl.getAttribLocation(this._pointsProgram, 'a_pos');
      this._pointsAttrSpeed = gl.getAttribLocation(this._pointsProgram, 'a_speed');
      this._pointsUProjScale = gl.getUniformLocation(this._pointsProgram, 'u_proj_scale');
      this._pointsUSize = gl.getUniformLocation(this._pointsProgram, 'u_size');
      this._pointsUOpacity = gl.getUniformLocation(this._pointsProgram, 'u_opacity');
      this._pointsUVmin = gl.getUniformLocation(this._pointsProgram, 'u_vmin');
      this._pointsUVmax = gl.getUniformLocation(this._pointsProgram, 'u_vmax');
      this._pointsUColorBySpeed = gl.getUniformLocation(this._pointsProgram, 'u_colorBySpeed');
      this._pointsUColormap = gl.getUniformLocation(this._pointsProgram, 'u_colormap');

      this._fadeProgram = createProgram(gl, QUAD_VS, FADE_FS);
      this._fadeAttrPos = gl.getAttribLocation(this._fadeProgram, 'a_pos');
      this._fadeUTex = gl.getUniformLocation(this._fadeProgram, 'u_tex');
      this._fadeUFade = gl.getUniformLocation(this._fadeProgram, 'u_fade');
      gl.useProgram(this._fadeProgram);
      gl.uniform1i(this._fadeUTex, 0);

      this._compProgram = createProgram(gl, QUAD_VS, COMPOSITE_FS);
      this._compAttrPos = gl.getAttribLocation(this._compProgram, 'a_pos');
      this._compUTex = gl.getUniformLocation(this._compProgram, 'u_tex');
      this._compUOpacity = gl.getUniformLocation(this._compProgram, 'u_opacity');
      gl.useProgram(this._compProgram);
      gl.uniform1i(this._compUTex, 0);

      this._particleVbo = gl.createBuffer();
      // Pre-allocate the particle VBO at the current particle count so
      // each frame can update in-place via bufferSubData instead of
      // re-allocating with bufferData (the latter orphans the buffer,
      // forcing the driver to re-allocate the VRAM range every frame —
      // visible jitter on lower-end GPUs at 8k particles).
      gl.bindBuffer(gl.ARRAY_BUFFER, this._particleVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this._buf.byteLength, gl.DYNAMIC_DRAW);

      const quad = new Float32Array([
        0, 0,  1, 0,  0, 1,
        1, 0,  1, 1,  0, 1,
      ]);
      this._quadVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVbo);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

      this._fbW = 0;
      this._fbH = 0;
      this._fbA = null;
      this._fbB = null;
    },

    _ensureFbos(this: any, w: number, h: number): void {
      const gl = this._gl as WebGL2RenderingContext;
      if (this._fbA && this._fbW === w && this._fbH === h) return;
      if (this._fbA) { gl.deleteFramebuffer(this._fbA.fb); gl.deleteTexture(this._fbA.tex); }
      if (this._fbB) { gl.deleteFramebuffer(this._fbB.fb); gl.deleteTexture(this._fbB.tex); }
      this._fbA = createFB(gl, w, h);
      this._fbB = createFB(gl, w, h);
      this._fbW = w;
      this._fbH = h;
    },

    _clearTrails(this: any): void {
      const gl = this._gl as WebGL2RenderingContext;
      if (!this._fbA || !this._fbB) return;
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbA.fb);
      gl.viewport(0, 0, this._fbW, this._fbH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbB.fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    /** Reseed every particle uniformly into the current viewport's
     *  padded bbox. Called on the first stable frame after a camera
     *  change, so panning/zooming into new territory immediately fills
     *  it with particles instead of waiting on the natural age-out
     *  recycle (which on a fresh zoom-out leaves a rectangle of dying
     *  particles in the middle of the new viewport). */
    _reseedAll(this: any, tlMx: number, tlMy: number, brMx: number, brMy: number, dataZ: number): void {
      const sx = brMx - tlMx;
      const sy = brMy - tlMy;
      const seedXMin = tlMx - SEED_MARGIN * sx;
      const seedXMax = brMx + SEED_MARGIN * sx;
      const seedYMin = Math.max(0.005, tlMy - SEED_MARGIN * sy);
      const seedYMax = Math.min(0.995, brMy + SEED_MARGIN * sy);
      const spanX = seedXMax - seedXMin;
      const spanY = Math.max(0, seedYMax - seedYMin);
      const maxAge = this._maxAge as number;
      const mx = this._mx as Float64Array;
      const my = this._my as Float64Array;
      const age = this._age as Uint32Array;
      const speed = this._speed as Float32Array;
      for (let i = 0; i < this._N; i++) {
        mx[i] = seedXMin + Math.random() * spanX;
        my[i] = seedYMin + Math.random() * spanY;
        // Stagger ages so particles don't all recycle on the same frame.
        age[i] = (Math.random() * maxAge) | 0;
        const s = this._sample(mx[i], my[i], dataZ);
        speed[i] = s ? Math.sqrt(s.u * s.u + s.v * s.v) : -1;
      }
    },

    _anchorCanvas(this: any): void {
      const map = this._map;
      if (!map || !this._canvas) return;
      const size = map.getSize();
      const dpr = (globalThis.devicePixelRatio ?? 1);
      const canvas: HTMLCanvasElement = this._canvas;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      const newW = Math.round(size.x * dpr);
      const newH = Math.round(size.y * dpr);
      if (canvas.width !== newW || canvas.height !== newH) {
        canvas.width = newW;
        canvas.height = newH;
        this._ensureFbos(newW, newH);
      } else if (!this._fbA) {
        this._ensureFbos(newW, newH);
      }
      const tlLayer = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, tlLayer);

      // Save anchor for `_onZoomAnim`.
      const origin = map.getPixelOrigin();
      this._anchorPixelX = tlLayer.x + origin.x;
      this._anchorPixelY = tlLayer.y + origin.y;
      this._anchorZoom = map.getZoom();
    },

    _onZoomAnim(this: any, opts: any): void {
      const map = this._map;
      if (!map || !this._canvas) return;
      this._canvas.style.transition = 'transform 250ms cubic-bezier(0,0,0.25,1)';
      const scale = map.getZoomScale(opts.zoom, this._anchorZoom);
      const newOrigin = map._getNewPixelOrigin(opts.center, opts.zoom);
      const newTlLayerX = this._anchorPixelX * scale - newOrigin.x;
      const newTlLayerY = this._anchorPixelY * scale - newOrigin.y;
      L.DomUtil.setTransform(this._canvas, L.point(newTlLayerX, newTlLayerY), scale);
    },
    _onZoomEnd(this: any): void {
      if (this._canvas) this._canvas.style.transition = '';
      // The next `_step` frame will detect the zoom change and re-anchor +
      // clear trails — no work needed here.
    },

    _ensureTilesAtZoom(this: any, z: number, tlMx: number, tlMy: number, brMx: number, brMy: number): void {
      const n = 2 ** z;
      const xLo = Math.floor(tlMx * n);
      const xHi = Math.floor(brMx * n);
      const yLo = Math.max(0, Math.floor(tlMy * n));
      const yHi = Math.min(n - 1, Math.floor(brMy * n));
      for (let xi = xLo; xi <= xHi; xi++) {
        const tx = posMod(xi, n);
        for (let yi = yLo; yi <= yHi; yi++) {
          const key = `${z}/${tx}/${yi}`;
          if (this._cache.has(key)) continue;
          // Fire and forget — `_sample` returns null for not-yet-loaded
          // tiles and the affected particles recycle until the data lands.
          void loadTile(this._cache, this._tileUrlTemplate, this._item.encoding, z, tx, yi);
        }
      }
    },

    /** Like `_ensureTilesAtZoom` but for the independent landmask pyramid.
     *  Zoom is `maskZ` (clamped to landmaskMaxZ, independent of dataZ). */
    _ensureMaskTilesAtZoom(this: any, maskZ: number, tlMx: number, tlMy: number, brMx: number, brMy: number): void {
      if (!this._landmaskUrlTemplate || !this._landmaskAccepts) return;
      const n = 2 ** maskZ;
      const xLo = Math.floor(tlMx * n);
      const xHi = Math.floor(brMx * n);
      const yLo = Math.max(0, Math.floor(tlMy * n));
      const yHi = Math.min(n - 1, Math.floor(brMy * n));
      for (let xi = xLo; xi <= xHi; xi++) {
        const tx = posMod(xi, n);
        for (let yi = yLo; yi <= yHi; yi++) {
          const key = `${maskZ}/${tx}/${yi}`;
          if (this._maskCache.has(key)) continue;
          void loadMaskTile(this._maskCache, this._landmaskUrlTemplate, maskZ, tx, yi);
        }
      }
    },

    /** Returns 'ocean' (= any byte in landmaskAccepts), 'land', or
     *  'unknown' (no mask tile covering this point loaded at any zoom).
     *  Walks DOWN from maskTargetZ so a finer tile that finished loading
     *  preempts a coarser fallback. NEAREST sampling — bilinear on
     *  category bytes is meaningless. No mask configured → always 'ocean'
     *  (no rejection). */
    _sampleLandmask(this: any, mx: number, my: number): 'ocean' | 'land' | 'unknown' {
      const accepts: Set<number> | null = this._landmaskAccepts;
      if (!accepts) return 'ocean';
      const mxC = posMod(mx, 1);
      const myC = Math.max(0, Math.min(1 - 1e-9, my));
      for (let z = this._maskTargetZ; z >= 0; z--) {
        const n = 2 ** z;
        const tx = Math.floor(mxC * n);
        const ty = Math.floor(myC * n);
        const tile = this._maskCache.get(`${z}/${tx}/${ty}`);
        if (!tile || tile.status !== 'loaded') continue;
        const px = Math.min(tile.W - 1, Math.max(0, Math.floor((mxC * n - tx) * tile.W)));
        const py = Math.min(tile.H - 1, Math.max(0, Math.floor((myC * n - ty) * tile.H)));
        return accepts.has(tile.mask[py * tile.W + px]) ? 'ocean' : 'land';
      }
      return 'unknown';
    },

    /** Bilinear u/v sample at mercator (mx, my). Walks DOWN the zoom
     *  pyramid from `maxZ` to z=0 looking for a loaded tile — so when
     *  finer tiles haven't arrived yet (e.g. immediately after a
     *  zoom-in), particles fall back to the still-cached parent tile.
     *  Without this, every particle whose target-zoom tile is in flight
     *  dies and doesn't render — visible as particles only existing in
     *  the few tiles that happen to have loaded so far. Returns null
     *  only if NO zoom level has a loaded tile here, or if the loaded
     *  tile resolves to NaN at (mx, my). */
    _sample(this: any, mx: number, my: number, maxZ: number): { u: number; v: number } | null {
      if (my < 0 || my > 1) return null;
      // Landmask first: a 'land' hit kills the particle (returns null →
      // recycled) before any data sampling. 'unknown' (no mask loaded
      // yet) is treated as ocean so particles don't blink out during the
      // brief window between first paint and mask-tile arrival.
      if (this._sampleLandmask(mx, my) === 'land') return null;
      const mxC = posMod(mx, 1);
      const myC = Math.max(0, Math.min(1 - 1e-9, my));
      for (let z = maxZ; z >= 0; z--) {
        const n = 2 ** z;
        const fx = mxC * n;
        const fy = myC * n;
        const tx = Math.min(n - 1, Math.floor(fx));
        const ty = Math.min(n - 1, Math.floor(fy));
        const tile = this._cache.get(`${z}/${tx}/${ty}`);
        if (!tile || tile.status !== 'loaded') continue;
        const fxAbs = (fx - tx) * tile.W;
        const fyAbs = (fy - ty) * tile.H;
        const x0 = Math.max(0, Math.min(tile.W - 1, Math.floor(fxAbs)));
        const y0 = Math.max(0, Math.min(tile.H - 1, Math.floor(fyAbs)));
        const x1 = Math.min(tile.W - 1, x0 + 1);
        const y1 = Math.min(tile.H - 1, y0 + 1);
        const ax = Math.max(0, Math.min(1, fxAbs - x0));
        const ay = Math.max(0, Math.min(1, fyAbs - y0));
        const w00 = (1 - ax) * (1 - ay);
        const w01 = ax * (1 - ay);
        const w10 = (1 - ax) * ay;
        const w11 = ax * ay;
        const i00 = y0 * tile.W + x0;
        const i01 = y0 * tile.W + x1;
        const i10 = y1 * tile.W + x0;
        const i11 = y1 * tile.W + x1;
        const u = tile.u[i00] * w00 + tile.u[i01] * w01 + tile.u[i10] * w10 + tile.u[i11] * w11;
        const v = tile.v[i00] * w00 + tile.v[i01] * w01 + tile.v[i10] * w10 + tile.v[i11] * w11;
        if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
        return { u, v };
      }
      return null;
    },

    /** Advect every particle one frame; recycle dead/out-of-bounds ones;
     *  pack into the upload buffer as `(mx - tlMx, my - tlMy, speed)`. */
    _step_simulation(this: any, dataZ: number, tlMx: number, tlMy: number, brMx: number, brMy: number, viewZoom: number): void {
      const mx = this._mx as Float64Array;
      const my = this._my as Float64Array;
      const age = this._age as Uint32Array;
      const speed = this._speed as Float32Array;
      const buf = this._buf as Float32Array;
      const N = this._N as number;
      const maxAge = this._maxAge as number;
      const effScale = this._speedScale * Math.pow(0.5, viewZoom);

      const sx = brMx - tlMx;
      const sy = brMy - tlMy;
      const seedXMin = tlMx - SEED_MARGIN * sx;
      const seedXMax = brMx + SEED_MARGIN * sx;
      const seedYMin = Math.max(0.005, tlMy - SEED_MARGIN * sy);
      const seedYMax = Math.min(0.995, brMy + SEED_MARGIN * sy);
      const spanX = seedXMax - seedXMin;
      const spanY = Math.max(0, seedYMax - seedYMin);

      for (let i = 0; i < N; i++) {
        let alive = speed[i] >= 0;
        if (alive) {
          const s = this._sample(mx[i], my[i], dataZ);
          if (s) {
            mx[i] += s.u * effScale;
            my[i] -= s.v * effScale; // +v = north = -my
            speed[i] = Math.sqrt(s.u * s.u + s.v * s.v);
            age[i]++;
          } else {
            alive = false;
          }
        }

        // Recycle conditions: aged out, drifted past seed bbox, or
        // sample returned NaN/no-tile (alive flipped above).
        if (!alive
            || age[i] >= maxAge
            || mx[i] < seedXMin || mx[i] > seedXMax
            || my[i] < seedYMin || my[i] > seedYMax) {
          mx[i] = seedXMin + Math.random() * spanX;
          my[i] = seedYMin + Math.random() * spanY;
          age[i] = (Math.random() * maxAge) | 0;
          const s2 = this._sample(mx[i], my[i], dataZ);
          speed[i] = s2 ? Math.sqrt(s2.u * s2.u + s2.v * s2.v) : -1;
        }

        buf[i * 3]     = mx[i] - tlMx; // Float64 subtract → Float32 store
        buf[i * 3 + 1] = my[i] - tlMy;
        buf[i * 3 + 2] = speed[i];
      }
    },

    _step(this: any): void {
      this._rAF = requestAnimationFrame(this._step);
      const map = this._map;
      const gl = this._gl as WebGL2RenderingContext | null;
      if (!map || !gl || !this._canvas) return;

      // During the 250ms zoom anim we don't re-anchor or clear (would
      // overwrite the CSS scale transform set by _onZoomAnim). The
      // simulation still ticks, so particles continue advecting in
      // mercator-world while the existing trail texture gets CSS-scaled
      // with the basemap. After zoomend the next frame detects the new
      // camera signature and resets cleanly.
      const animatingZoom = !!map._animatingZoom;

      const z = map.getZoom();
      const c = map.getCenter();
      const sig = `${z}|${c.lat.toFixed(7)}|${c.lng.toFixed(7)}`;
      const cameraChanged = sig !== this._lastCameraSig;
      const firstFrame = this._lastCameraSig === '';

      // Camera state machine (mirrors Mapbox's `_cameraMoving`):
      //   - cameraChanged → wipe trails (stale pixels would smear).
      //     Mark `cameraMoving` so the next stable frame reseeds.
      //   - cameraMoving && !cameraChanged → first stable frame after
      //     motion; reseed all particles into the new viewport and wipe
      //     trails one more time. Without this, panning/zooming-out
      //     leaves a rectangle of old-viewport particles in the middle
      //     of the new viewport until they age out.
      if ((cameraChanged && !animatingZoom) || firstFrame) {
        this._anchorCanvas();
        this._clearTrails();
        this._lastCameraSig = sig;
        this._cameraMoving = true;
      }

      if (!this._fbA || !this._fbB) return;

      // Viewport math — uses the LIVE map state (so even during a pan,
      // particles project to the right container pixels each frame).
      const size = map.getSize();
      const W_css = size.x, H_css = size.y;
      const tlLayer = map.containerPointToLayerPoint([0, 0]);
      const origin = map.getPixelOrigin();
      const tlPx = tlLayer.x + origin.x;
      const tlPy = tlLayer.y + origin.y;
      const S = 256 * Math.pow(2, z);
      const tlMx = tlPx / S;
      const tlMy = tlPy / S;
      const brMx = (tlPx + W_css) / S;
      const brMy = (tlPy + H_css) / S;

      const dataZ = Math.max(0, Math.min(this._maxzoom, Math.floor(z)));
      // Mask zoom is independent of data zoom — clamped to the mask
      // pyramid's own maxzoom so it keeps sharpening when viewZ exceeds
      // the data's resolution ceiling. Read by `_sampleLandmask`.
      this._maskTargetZ = Math.max(0, Math.min(this._landmaskMaxZ, Math.floor(z)));

      // Kick missing-tile loads (no-op for already-cached / in-flight tiles).
      this._ensureTilesAtZoom(dataZ, tlMx, tlMy, brMx, brMy);
      this._ensureMaskTilesAtZoom(this._maskTargetZ, tlMx, tlMy, brMx, brMy);

      // First stable frame after motion: reseed across new viewport.
      // Order matters — must come AFTER tile loads kick off so the sample
      // call below has something to draw from (or sets speed=-1 for now).
      if (!cameraChanged && !animatingZoom && this._cameraMoving) {
        this._reseedAll(tlMx, tlMy, brMx, brMy, dataZ);
        this._clearTrails();
        this._cameraMoving = false;
      }

      // CPU sim.
      this._step_simulation(dataZ, tlMx, tlMy, brMx, brMy, z);

      // Upload particle buffer. Pre-allocated in `_initGL`; bufferSubData
      // updates in-place without orphaning.
      gl.bindBuffer(gl.ARRAY_BUFFER, this._particleVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._buf);

      const fbA = this._fbA as FB;
      const fbB = this._fbB as FB;

      // ----- Pass 1: fade fbA into fbB (= fbA × fade − 0.6/255) -----
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbB.fb);
      gl.viewport(0, 0, this._fbW, this._fbH);
      gl.disable(gl.BLEND);
      gl.useProgram(this._fadeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVbo);
      gl.enableVertexAttribArray(this._fadeAttrPos);
      gl.vertexAttribPointer(this._fadeAttrPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbA.tex);
      gl.uniform1f(this._fadeUFade, this._fade);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // ----- Pass 2: render particles on top of fbB -----
      gl.useProgram(this._pointsProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._particleVbo);
      gl.enableVertexAttribArray(this._pointsAttrPos);
      gl.vertexAttribPointer(this._pointsAttrPos, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(this._pointsAttrSpeed);
      gl.vertexAttribPointer(this._pointsAttrSpeed, 1, gl.FLOAT, false, 12, 8);

      // Split-precision projection: origin clip = (-1, 1) (canvas top-
      // left), scale = (2S/W, -2S/H). Particle attributes are
      // (mx - tlMx, my - tlMy, speed) — the Float64 subtract on CPU
      // sidesteps Float32 precision loss at view zooms ≥ 15.
      gl.uniform2f(this._pointsUProjScale, (2 * S) / W_css, -(2 * S) / H_css);
      // `gl_PointSize` is in device pixels (drawing-buffer pixels) — pass
      // the raw value to match the Mapbox binding's convention. On a
      // DPR=2 screen a `pointSize: 3` dot renders as 1.5 CSS px.
      gl.uniform1f(this._pointsUSize, this._pointSize);
      gl.uniform1f(this._pointsUOpacity, 1.0);
      gl.uniform1f(this._pointsUVmin, this._vmin);
      gl.uniform1f(this._pointsUVmax, this._vmax);
      gl.uniform1f(this._pointsUColorBySpeed, this._colorBySpeed ? 1.0 : 0.0);
      // Colormap LUT texture on unit 1 (the points pass binds no other
      // texture; unit 0 still holds the fade pass's trail texture).
      if (this._pointsUColormap) {
        if (this._colormapDirty || !this._colormapTexture) {
          this._colormapTexture = uploadColormapTexture(gl, this._colormapData, this._colormapTexture);
          this._colormapDirty = false;
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._colormapTexture);
        gl.uniform1i(this._pointsUColormap, 1);
        gl.activeTexture(gl.TEXTURE0);
      }
      // Additive (ONE/ONE) for points — matches the Mapbox binding. With
      // alpha-blend (ONE/ONE_MINUS_SRC_ALPHA) each new dot REPLACES the
      // existing trail pixel, so soft-edge feathering stays soft → the
      // visible dot looks bigger than its `gl_PointSize` core. Additive
      // lets feathered edges accumulate across frames into saturation,
      // which both thins the apparent dot and brightens trails so motion
      // reads as faster — the two complaints in one fix.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, this._N);

      // ----- Pass 3: composite fbB to canvas at user opacity -----
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this._canvas.width, this._canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this._compProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVbo);
      gl.enableVertexAttribArray(this._compAttrPos);
      gl.vertexAttribPointer(this._compAttrPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbB.tex);
      gl.uniform1f(this._compUOpacity, this._opacity);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Swap FBOs for the next frame.
      this._fbA = fbB;
      this._fbB = fbA;
    },

    // ----- Public runtime setters -----
    setOpacity(this: any, o: number): void { this._opacity = o; },
    setFade(this: any, f: number): void { this._fade = f; },
    setParticleCount(this: any, n: number): void {
      if (n === this._N) return;
      this._N = n;
      this._mx = new Float64Array(n);
      this._my = new Float64Array(n);
      this._age = new Uint32Array(n);
      this._speed = new Float32Array(n);
      this._buf = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) this._speed[i] = -1;
      // VBO size changed — re-allocate at the new byteLength.
      const gl = this._gl as WebGL2RenderingContext | null;
      if (gl && this._particleVbo) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this._particleVbo);
        gl.bufferData(gl.ARRAY_BUFFER, this._buf.byteLength, gl.DYNAMIC_DRAW);
      }
      // Will reseed across the current viewport on the next stable frame.
      this._cameraMoving = true;
    },
    setPointSize(this: any, s: number): void { this._pointSize = s; },
    setSpeedScale(this: any, s: number): void { this._speedScale = s; },
    setMaxAge(this: any, a: number): void { this._maxAge = a; },
    setColorBySpeed(this: any, c: boolean): void { this._colorBySpeed = !!c; },
    setColormap(this: any, spec: ColormapSpec): void {
      this._colormapData = resolveColormap(spec);
      this._colormapDirty = true;
      // Existing trail pixels carry the old palette; clear so the new
      // colours take over immediately rather than fading in over the old.
      if (this._fbA && this._fbB) this._clearTrails();
    },
    setVmin(this: any, v: number): void { this._vmin = v; },
    setVmax(this: any, v: number): void { this._vmax = v; },

    /** Apply a partial options patch. */
    applyOptions(this: any, p: any): void {
      if (p.opacity != null) this.setOpacity(p.opacity);
      if (p.fade != null) this.setFade(p.fade);
      if (p.particleCount != null) this.setParticleCount(p.particleCount);
      if (p.pointSize != null) this.setPointSize(p.pointSize);
      if (p.speedScale != null) this.setSpeedScale(p.speedScale);
      if (p.maxAge != null) this.setMaxAge(p.maxAge);
      if (p.colorBySpeed != null) this.setColorBySpeed(p.colorBySpeed);
      if (p.colormap != null) this.setColormap(p.colormap);
      if (p.vmin != null) this.setVmin(p.vmin);
      if (p.vmax != null) this.setVmax(p.vmax);
    },
  });

  return LayerClass;
}

function fromItem(opts: MercatorStreamlinesLayerOpts, item: DiscoveredItem): any {
  const Cls = ensureLayerClass();
  return new Cls({ ...opts, item });
}

async function create(opts: MercatorStreamlinesLayerOpts): Promise<any> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorStreamlinesLayer = { create, fromItem };
