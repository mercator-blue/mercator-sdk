/**
 * Leaflet binding — colormapped raster overlay decoded from value-encoded
 * PNG tiles (rg16_fixed scalars, vector_rg_ba vector magnitude, mapbox_rgb
 * elevation). Reuses the Mapbox/MapLibre fragment shaders verbatim
 * (they're projection-agnostic) with a Leaflet-only vertex shader that
 * maps tile-mercator coords to clip space via a CPU-computed mat4 —
 * Leaflet has no globe so we don't need the prelude machinery the Mapbox
 * binding has.
 *
 * Rendering model:
 *   - Single full-viewport WebGL canvas attached to `map.getPanes().overlayPane`.
 *   - During pan, overlayPane gets a CSS `transform: translate(...)` applied
 *     by Leaflet — the canvas (its child) inherits the transform and rides
 *     pixel-for-pixel with the basemap. Zero JS work per frame; perfectly
 *     synced.
 *   - On `moveend` / `zoomend` / `viewreset` / `resize`: re-anchor the canvas
 *     to the new viewport top-left and rebuild the tile draw queue at the
 *     new zoom.
 *   - During zoom animation, the canvas is hidden (`display: none`) until
 *     `zoomend`. A future revision can implement `_animateZoom` for a
 *     scale-transform during zoom.
 *
 * Leaflet integration uses `L.Layer.extend()` at first-call time so we don't
 * need a static `import L` (Leaflet is loaded via <script> tag by the
 * consumer; we read it off `globalThis`). This keeps the SDK leaflet-version-
 * agnostic and side-steps bundler config issues for the standalone test page.
 */

import {
  RASTER_SCALAR_FS as SCALAR_FS,
  RASTER_VECTOR_FS as VECTOR_FS,
  RASTER_ELEVATION_FS as ELEVATION_FS,
} from '../core/shaders/index';
import { resolveColormap } from '../core/colormaps';
import { uploadColormapTexture } from '../core/colormap-texture';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, expandTileUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import { posMod } from '../core/mercator';
import type { ColormapSpec, EncodingKind, MercatorRasterOptions } from '../core/types';
import { createProgram } from '../core/webgl-helpers';

const ENCODING_TO_FS: Record<EncodingKind, string> = {
  rg16_fixed: SCALAR_FS,
  vector_rg_ba: VECTOR_FS,
  mapbox_rgb: ELEVATION_FS,
};

import {
  RASTER_VS,
  RASTER_COMPOSITE_VS as COMPOSITE_VS,
  RASTER_COMPOSITE_FS as COMPOSITE_FS,
} from './shaders/index';

/** Leaflet-specific extras on top of the cross-binding
 *  {@link MercatorRasterOptions}. */
export type MercatorRasterLayerOpts = MercatorRasterOptions & {
  /** Optional Leaflet pane name. Default `overlayPane`. */
  pane?: string;
};

interface TileEntry {
  status: 'loading' | 'loaded' | 'error';
  texture: WebGLTexture | null;
}

interface TileCoord {
  z: number;
  x: number; // logical x (may be outside [0, n-1] for antimeridian wrap)
  y: number;
}

interface QueueEntry extends TileCoord {
  texture: WebGLTexture;
}

/**
 * Resolve a Leaflet instance from the global scope. Leaflet plugin
 * convention — users load Leaflet via `<script>` or import it themselves,
 * we read `globalThis.L`.
 */
function getL(): any {
  const L = (globalThis as any).L;
  if (!L || !L.Layer) {
    throw new Error(
      '@mercator-blue/sdk/leaflet: Leaflet not found on `globalThis.L`. ' +
      'Load Leaflet (e.g. via <script src=".../leaflet.js">) before importing the SDK.',
    );
  }
  return L;
}

let LayerClass: any = null;

/** Lazily build the L.Layer subclass when Leaflet first becomes available. */
function ensureLayerClass(): any {
  if (LayerClass) return LayerClass;
  const L = getL();

  LayerClass = L.Layer.extend({
    initialize(this: any, opts: any) {
      L.setOptions(this, opts);
      this._item = opts.item as DiscoveredItem;
      this._dataset = opts.dataset as string;
      this._apiKey = opts.apiKey as string | undefined;
      this._tileUrlTemplate = withApiKey(
        `${this._item.itemBase}/{z}/{x}/{y}.png`,
        this._apiKey,
      );

      const fsBody = ENCODING_TO_FS[this._item.encoding.kind as EncodingKind];
      if (!fsBody) {
        throw new Error(
          `@mercator-blue/sdk/leaflet: unsupported encoding "${this._item.encoding.kind}" — ` +
          'only rg16_fixed, vector_rg_ba, and mapbox_rgb are wired up.',
        );
      }
      this._fsSource = `#version 300 es\n${fsBody}`;

      this._opacity = opts.opacity ?? 0.75;
      this._smooth = opts.smooth ?? true;
      this._vmin = opts.vmin ?? this._item.visualization?.vmin ?? 0;
      this._vmax = opts.vmax ?? this._item.visualization?.vmax ?? 1;
      const cmSpec = opts.colormap ?? this._item.visualization?.colormap ?? 'viridis';
      this._colormapData = resolveColormap(cmSpec);
      this._colormapTexture = null;
      this._colormapDirty = true;
      this._logScale = (this._item.visualization?.scale_type === 'log') ? 1 : 0;
      this._transparentBelow = this._item.visualization?.transparent_below ?? -1e30;
      this._alphaByValue = this._item.visualization?.alpha_by_value ? 1 : 0;

      // tile-coord key → entry. Populated lazily in _ensureTile().
      this._tiles = new Map<string, TileEntry>();
      // Current viewport's draw queue (set in _reset, drained in _render).
      this._queue = [] as QueueEntry[];
      this._currentZoom = 0;
    },

    onAdd(this: any, map: any): any {
      this._map = map;
      const pane = (this.options.pane as string) ?? 'overlayPane';
      const paneEl = map.getPane(pane);

      // `transform-origin: 0 0` makes the scale anchor at the canvas's
      // top-left, matching `L.DomUtil.setTransform`'s translate semantic.
      // We DON'T add the `leaflet-zoom-animated` class because it carries
      // a `transition: transform 250ms` CSS rule that would lag every
      // per-frame `setPosition` during pan; instead, `_onZoomAnim` toggles
      // the transition inline only while a zoom animation is in flight.
      const canvas = L.DomUtil.create('canvas', 'mercator-raster-layer') as HTMLCanvasElement;
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = '200';
      canvas.style.transformOrigin = '0 0';
      paneEl.appendChild(canvas);
      this._canvas = canvas;

      const gl = canvas.getContext('webgl2', {
        premultipliedAlpha: false,
        antialias: false,
      });
      if (!gl) throw new Error('@mercator-blue/sdk/leaflet: WebGL2 unavailable');
      this._gl = gl;

      this._program = createProgram(gl, RASTER_VS, this._fsSource);
      gl.useProgram(this._program);

      // Unit-quad mesh (two triangles in [0,1]²). Leaflet is Mercator-only;
      // no globe → no need for the 32×32 tessellation the Mapbox layer uses.
      const verts = new Float32Array([
        0, 0,  1, 0,  0, 1,
        1, 0,  1, 1,  0, 1,
      ]);
      this._vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

      this._attrPos = gl.getAttribLocation(this._program, 'a_pos');
      this._uTile = gl.getUniformLocation(this._program, 'u_tile');
      this._uMatrix = gl.getUniformLocation(this._program, 'u_matrix');
      this._uTex = gl.getUniformLocation(this._program, 'u_tex');
      this._uTexN = gl.getUniformLocation(this._program, 'u_texN');
      this._uTexS = gl.getUniformLocation(this._program, 'u_texS');
      this._uTexW = gl.getUniformLocation(this._program, 'u_texW');
      this._uTexE = gl.getUniformLocation(this._program, 'u_texE');
      this._uHas = gl.getUniformLocation(this._program, 'u_has');
      this._uScale = gl.getUniformLocation(this._program, 'u_scale');
      this._uOffset = gl.getUniformLocation(this._program, 'u_offset');
      this._uVmin = gl.getUniformLocation(this._program, 'u_vmin');
      this._uVmax = gl.getUniformLocation(this._program, 'u_vmax');
      this._uOpacity = gl.getUniformLocation(this._program, 'u_opacity');
      this._uSmooth = gl.getUniformLocation(this._program, 'u_smooth');
      this._uColormap = gl.getUniformLocation(this._program, 'u_colormap');
      this._uLogScale = gl.getUniformLocation(this._program, 'u_log_scale');
      this._uTransparentBelow = gl.getUniformLocation(this._program, 'u_transparent_below');
      this._uAlphaByValue = gl.getUniformLocation(this._program, 'u_alpha_by_value');

      // Sampler-unit assignments are constant for the program's lifetime.
      gl.uniform1i(this._uTex, 0);
      if (this._uTexN !== null) gl.uniform1i(this._uTexN, 1);
      if (this._uTexS !== null) gl.uniform1i(this._uTexS, 2);
      if (this._uTexW !== null) gl.uniform1i(this._uTexW, 3);
      if (this._uTexE !== null) gl.uniform1i(this._uTexE, 4);
      if (this._uColormap !== null) gl.uniform1i(this._uColormap, 5);

      // Compositor program — used in pass 2 to scale the FBO by opacity.
      this._compProgram = createProgram(gl, COMPOSITE_VS, COMPOSITE_FS);
      this._compAttrPos = gl.getAttribLocation(this._compProgram, 'a_pos');
      this._compUSrc = gl.getUniformLocation(this._compProgram, 'u_src');
      this._compUOpacity = gl.getUniformLocation(this._compProgram, 'u_opacity');
      gl.useProgram(this._compProgram);
      gl.uniform1i(this._compUSrc, 0);
      gl.useProgram(this._program);

      // Offscreen FBO — sized lazily in `_ensureFbo()`.
      this._fbo = null;
      this._fboTexture = null;
      this._fboW = 0;
      this._fboH = 0;

      // `move` fires continuously during pan + at the start of animated zoom.
      // Our handler short-circuits during zoom animation (zoomanim already
      // applied the smooth transform) but otherwise re-anchors + redraws on
      // every move event so tiles stream in like the basemap does.
      map.on('move', this._onMove, this);
      map.on('moveend', this._onMoveEnd, this);
      map.on('zoomanim', this._onZoomAnim, this);
      map.on('zoomend', this._onZoomEnd, this);
      map.on('viewreset', this._onReset, this);
      map.on('resize', this._onReset, this);

      this._reset();
      return this;
    },

    onRemove(this: any, map: any): any {
      map.off('move', this._onMove, this);
      map.off('moveend', this._onMoveEnd, this);
      map.off('zoomanim', this._onZoomAnim, this);
      map.off('zoomend', this._onZoomEnd, this);
      map.off('viewreset', this._onReset, this);
      map.off('resize', this._onReset, this);

      const gl = this._gl as WebGL2RenderingContext;
      if (this._vbo) gl.deleteBuffer(this._vbo);
      if (this._program) gl.deleteProgram(this._program);
      if (this._compProgram) gl.deleteProgram(this._compProgram);
      if (this._fboTexture) gl.deleteTexture(this._fboTexture);
      if (this._fbo) gl.deleteFramebuffer(this._fbo);
      if (this._colormapTexture) gl.deleteTexture(this._colormapTexture);
      this._colormapTexture = null;
      for (const t of (this._tiles as Map<string, TileEntry>).values()) {
        if (t.texture) gl.deleteTexture(t.texture);
      }
      (this._tiles as Map<string, TileEntry>).clear();
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      this._canvas = null;
      this._gl = null;
      this._program = null;
      this._map = null;
      return this;
    },

    /** Apply a translate + scale transform to the canvas so its existing
     *  content stays aligned with the basemap during Leaflet's zoom
     *  animation. The canvas inherits `transition: transform 250ms ...`
     *  from the `leaflet-zoom-animated` CSS class, so this one call from
     *  the start of the animation produces a smooth animated transform.
     *
     *  Formula matches L.GridLayer._setZoomTransform: the canvas was
     *  anchored at pixel-CRS top-left `(_anchorPixelX, _anchorPixelY)`
     *  at view zoom `_anchorZoom`; at the target zoom + center, the same
     *  world position lands at pixel-CRS `(anchorPixel * scale)`, and
     *  layer-point = pixel-CRS - newPixelOrigin. Scale matches the
     *  basemap's own zoom scale. */
    _onZoomAnim(this: any, opts: any): void {
      const map = this._map;
      if (!map || !this._canvas) return;
      // Set the transition inline only for the zoom animation window;
      // `_onZoomEnd` clears it before the post-zoom `setPosition` so pan
      // re-anchors are immediate.
      this._canvas.style.transition = 'transform 250ms cubic-bezier(0,0,0.25,1)';
      const scale = map.getZoomScale(opts.zoom, this._anchorZoom);
      // Use Leaflet's own pixel-origin calc — it folds in the current
      // mapPane translate. A naive `newCenterPx - size/2` is correct only
      // when mapPane is at (0,0); after a pan it's off by the pan offset,
      // and `setTransform`'s translate lives in the mapPane frame so the
      // error shows up directly as a misplaced canvas during zoom anim.
      const newOrigin = map._getNewPixelOrigin(opts.center, opts.zoom);
      const newTlLayerX = this._anchorPixelX * scale - newOrigin.x;
      const newTlLayerY = this._anchorPixelY * scale - newOrigin.y;
      L.DomUtil.setTransform(this._canvas, L.point(newTlLayerX, newTlLayerY), scale);
    },
    _onZoomEnd(this: any): void {
      if (this._canvas) this._canvas.style.transition = '';
      this._reset();
    },
    /** Pan-time move handler — re-anchor + redraw to stream tiles in as
     *  the viewport scrolls. Short-circuits during zoom animation; the
     *  `zoomanim` handler is in charge during that window and a JS-driven
     *  re-render would race with the CSS transition. */
    _onMove(this: any): void {
      if (this._map && this._map._animatingZoom) return;
      this._reset();
    },
    _onMoveEnd(this: any): void {
      this._reset();
    },
    _onReset(this: any): void {
      this._reset();
    },

    /** Re-anchor the canvas to the current viewport, compute the projection
     *  matrix, ensure tiles, and render. Idempotent. */
    _reset(this: any): void {
      const map = this._map;
      if (!map || !this._canvas) return;

      // Clear any in-flight zoom-anim transition before `setPosition`
      // rewrites the transform — otherwise the browser re-animates from
      // the scaled zoom-anim state to the new translate-only state over
      // 250ms (Leaflet fires `move` from `_onZoomTransitionEnd` BEFORE
      // `zoomend` clears the transition itself). `_reset` only runs
      // outside the zoom anim (the `_onMove` guard short-circuits during
      // it), so clearing here is safe.
      this._canvas.style.transition = '';

      const size = map.getSize();  // {x: W, y: H} in CSS px
      const canvas: HTMLCanvasElement = this._canvas;
      const dpr = (globalThis.devicePixelRatio ?? 1);

      // CSS size = viewport; backing-store size = viewport × DPR.
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
        canvas.width = Math.round(size.x * dpr);
        canvas.height = Math.round(size.y * dpr);
      }

      // Anchor the canvas to the layer-point of the viewport top-left.
      // overlayPane is a child of mapPane which Leaflet translates during
      // pan; we set the canvas position once and let CSS transforms carry
      // it through pan. On moveend, we re-anchor here.
      //
      // `setPosition` writes `transform: translate3d(...)` — overwriting
      // any scale transform left over from a zoom animation. So zoomanim
      // → zoomend → _reset → setPosition resets us back to a clean
      // translate-only state at the new view zoom.
      const topLeftLayer = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeftLayer);

      // Save the anchor pixel-CRS coord + zoom for `_onZoomAnim`. These
      // are the canvas's frame of reference; zoom animation re-projects
      // them at the target zoom to compute the new translate + scale.
      this._currentZoom = map.getZoom();
      this._renderViewport();
    },

    /** Compute which tiles cover the viewport, ensure they're loaded,
     *  build the draw queue with parent-pyramid fallback, render.
     *
     *  All viewport-to-tile math runs in **pixel-CRS** (Leaflet's
     *  zoomed-pixel coordinate system) via `containerPointToLayerPoint`
     *  + `getPixelOrigin`. Going through `containerPointToLatLng` /
     *  `project` silently wraps longitudes to [-180, 180], which
     *  collapses all visible world copies onto the central one at low
     *  zoom AND produces a wrong matrix anchor (off by world-copy
     *  multiples) — the bug observed in the first cut.
     */
    _renderViewport(this: any): void {
      const map = this._map;
      if (!map || !this._gl) return;

      const item: DiscoveredItem = this._item;
      const viewZoom = map.getZoom();
      const z = Math.max(0, Math.min(item.tile.maxzoom, Math.floor(viewZoom)));
      const n = 2 ** z;
      const size = map.getSize();
      const W = size.x, H = size.y;
      // World width in pixel-CRS at view zoom. Leaflet's default CRS
      // (EPSG3857) uses 256 px per tile so world = 256 * 2^zoom.
      const S = 256 * Math.pow(2, viewZoom);

      // Canvas corners in pixel-CRS (= layer-point + pixel-origin).
      // No wrap, no clamp — can be < 0 or > S when the user is panned
      // off the canonical world copy.
      const tlLayer = map.containerPointToLayerPoint([0, 0]);
      const brLayer = map.containerPointToLayerPoint([W, H]);
      const origin = map.getPixelOrigin();
      const tlPixelX = tlLayer.x + origin.x;
      const tlPixelY = tlLayer.y + origin.y;
      const brPixelX = brLayer.x + origin.x;
      const brPixelY = brLayer.y + origin.y;

      // Save the anchor for `_onZoomAnim`. These are pixel-CRS coords at
      // the current view zoom — the frame of reference the canvas content
      // is drawn in. During zoom animation the same world position re-
      // projects to `anchorPixel * scale` in target-zoom pixel-CRS.
      this._anchorPixelX = tlPixelX;
      this._anchorPixelY = tlPixelY;
      this._anchorZoom = viewZoom;

      // Mercator-world coords of the canvas corners; same units as the
      // shader's `u_tile.xy` (tile origin in [0, 1]² for the canonical
      // world copy, but can extend beyond for adjacent copies).
      const tlMx = tlPixelX / S;
      const tlMy = tlPixelY / S;
      const brMx = brPixelX / S;
      const brMy = brPixelY / S;

      // Tile range at the data tile zoom `z`. xLo / xHi can be negative
      // or beyond n-1 — `_ensureTile()` canonicalises with posMod for
      // caching while `_buildDrawQueue()` preserves the logical x for
      // drawing, so we get tiled world copies for free.
      const xLo = Math.floor(tlMx * n);
      const xHi = Math.floor(brMx * n);
      const yLo = Math.max(0, Math.floor(tlMy * n));
      const yHi = Math.min(n - 1, Math.floor(brMy * n));

      const targets: TileCoord[] = [];
      for (let x = xLo; x <= xHi; x++) {
        for (let y = yLo; y <= yHi; y++) targets.push({ z, x, y });
      }

      for (const t of targets) this._ensureTile(t.z, t.x, t.y);
      this._queue = this._buildDrawQueue(targets);

      // Projection matrix: worldPos ∈ mercator-world [0,1]² → clip space.
      //   P_pixel = worldPos * S
      //   P_container = P_pixel - tlPixel
      //   clip.x = (P_container.x / W) * 2 - 1
      //   clip.y = 1 - (P_container.y / H) * 2
      // Column-major mat4 (stored row-major in the JS array, then GL
      // reads it column-major via uniformMatrix4fv with transpose=false):
      const a = (2 * S) / W;
      const b = (-2 * S) / H;
      const tx = (-2 * tlPixelX) / W - 1;
      const ty = 1 + (2 * tlPixelY) / H;
      this._matrix = new Float32Array([
        a, 0, 0, 0,
        0, b, 0, 0,
        0, 0, 1, 0,
        tx, ty, 0, 1,
      ]);

      this._render();
    },

    _ensureTile(this: any, z: number, xLogical: number, y: number): void {
      const tiles = this._tiles as Map<string, TileEntry>;
      const n = 2 ** z;
      const tx = posMod(xLogical, n);
      if (y < 0 || y >= n) return;
      const key = `${z}/${tx}/${y}`;
      if (tiles.has(key)) return;

      const entry: TileEntry = { status: 'loading', texture: null };
      tiles.set(key, entry);

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const gl = this._gl as WebGL2RenderingContext | null;
        if (!gl) return;  // layer was removed mid-flight
        const tex = gl.createTexture();
        if (!tex) { entry.status = 'error'; return; }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        entry.status = 'loaded';
        entry.texture = tex;
        // Skip the visible re-render during zoom animation. `_renderViewport`
        // calls `_reset` → `setPosition`, which would overwrite the canvas's
        // `transform` with a translate-only value, interrupting the in-flight
        // CSS scale transition started by `_onZoomAnim`. The tile sits in
        // the cache and is picked up by `_onZoomEnd`'s redraw 250ms later.
        if (this._map && this._map._animatingZoom) return;
        // Otherwise rebuild the draw queue + redraw — the just-loaded tile
        // may have replaced a coarser ancestor in the queue.
        this._renderViewport();
      };
      img.onerror = () => { entry.status = 'error'; };
      img.src = expandTileUrl(this._tileUrlTemplate, z, tx, y);
    },

    /** For each target tile, walk up the pyramid until we find a loaded
     *  ancestor — keeps the map filled while children load. */
    _buildDrawQueue(this: any, targets: TileCoord[]): QueueEntry[] {
      const item: DiscoveredItem = this._item;
      const tiles = this._tiles as Map<string, TileEntry>;
      const seen = new Set<string>();
      const queue: QueueEntry[] = [];
      for (const target of targets) {
        let z = target.z, x = target.x, y = target.y;
        while (z >= 0 && z >= (item.tile.minzoom ?? 0)) {
          const n = 2 ** z;
          const tx = posMod(x, n);
          const cacheKey = `${z}/${tx}/${y}`;
          const tile = tiles.get(cacheKey);
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
      // Coarser (parent) tiles first so finer overdraws them.
      queue.sort((a, b) => a.z - b.z);
      return queue;
    },

    /** (Re)create the offscreen RGBA framebuffer if the canvas size changed. */
    _ensureFbo(this: any, w: number, h: number): void {
      const gl = this._gl as WebGL2RenderingContext;
      if (this._fbo && this._fboW === w && this._fboH === h) return;
      if (this._fboTexture) gl.deleteTexture(this._fboTexture);
      if (this._fbo) gl.deleteFramebuffer(this._fbo);
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
      this._fboTexture = tex;
      this._fbo = fb;
      this._fboW = w;
      this._fboH = h;
    },

    /** Two-pass render. Pass 1: draw all tiles into an offscreen FBO at
     *  opacity=1. Pass 2: composite the FBO to the canvas scaled by the
     *  layer's opacity. The FBO isolates the alpha-stacking from
     *  parent + child overlap (transient state while a finer tile loads
     *  in but its parent is still needed by a sibling target). */
    _render(this: any): void {
      const gl = this._gl as WebGL2RenderingContext | null;
      if (!gl || !this._program || !this._matrix) return;
      const canvas: HTMLCanvasElement = this._canvas;
      const tiles = this._tiles as Map<string, TileEntry>;

      this._ensureFbo(canvas.width, canvas.height);

      // ----- Pass 1: tiles → FBO at opacity=1 -----
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this._program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
      gl.enableVertexAttribArray(this._attrPos);
      gl.vertexAttribPointer(this._attrPos, 2, gl.FLOAT, false, 0, 0);

      gl.uniformMatrix4fv(this._uMatrix, false, this._matrix);
      if (this._uScale) gl.uniform1f(this._uScale, this._item.encoding.scale);
      if (this._uOffset) gl.uniform1f(this._uOffset, this._item.encoding.offset);
      if (this._uVmin) gl.uniform1f(this._uVmin, this._vmin);
      if (this._uVmax) gl.uniform1f(this._uVmax, this._vmax);
      if (this._uOpacity) gl.uniform1f(this._uOpacity, 1.0);
      if (this._uSmooth !== null) gl.uniform1f(this._uSmooth, this._smooth ? 1.0 : 0.0);
      // Colormap LUT texture on unit 5 (elevation's hypsometric shader has
      // no u_colormap). Re-upload only when the palette changed.
      if (this._uColormap !== null) {
        if (this._colormapDirty || !this._colormapTexture) {
          this._colormapTexture = uploadColormapTexture(gl, this._colormapData, this._colormapTexture);
          this._colormapDirty = false;
        }
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, this._colormapTexture);
      }
      if (this._uLogScale !== null) gl.uniform1f(this._uLogScale, this._logScale);
      if (this._uTransparentBelow !== null) gl.uniform1f(this._uTransparentBelow, this._transparentBelow);
      if (this._uAlphaByValue !== null) gl.uniform1f(this._uAlphaByValue, this._alphaByValue);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // Bind centre + neighbours per tile. Identical pattern to the
      // Mapbox/MapLibre raster layer — bind centre tile to all 4 neighbour
      // units as a dummy fallback so drivers don't complain about unbound
      // samplers; `u_has` tells the shader which neighbours are real.
      const NEIGHBORS = [
        { dx:  0, dy: -1, unit: 1 },
        { dx:  0, dy:  1, unit: 2 },
        { dx: -1, dy:  0, unit: 3 },
        { dx:  1, dy:  0, unit: 4 },
      ] as const;

      for (const t of this._queue as QueueEntry[]) {
        const tn = 2 ** t.z;
        if (this._uTile) gl.uniform4f(this._uTile, t.x / tn, t.y / tn, 1.0 / tn, 1.0 / tn);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, t.texture);

        let hasN = 0, hasS = 0, hasW = 0, hasE = 0;
        for (const nb of NEIGHBORS) {
          const nx = posMod(t.x + nb.dx, tn);
          const ny = t.y + nb.dy;
          let tex: WebGLTexture = t.texture;
          let present = 0;
          if (ny >= 0 && ny < tn) {
            const e = tiles.get(`${t.z}/${nx}/${ny}`);
            if (e && e.status === 'loaded' && e.texture) { tex = e.texture; present = 1; }
          }
          gl.activeTexture(gl.TEXTURE0 + nb.unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          if (nb.dy === -1) hasN = present;
          else if (nb.dy === 1) hasS = present;
          else if (nb.dx === -1) hasW = present;
          else hasE = present;
        }
        if (this._uHas !== null) gl.uniform4f(this._uHas, hasN, hasS, hasW, hasE);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      // ----- Pass 2: composite FBO → canvas scaled by opacity -----
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this._compProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
      gl.enableVertexAttribArray(this._compAttrPos);
      gl.vertexAttribPointer(this._compAttrPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._fboTexture);
      gl.uniform1f(this._compUOpacity, this._opacity);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    // ----- Public runtime setters -----

    setOpacity(this: any, o: number): void {
      this._opacity = o;
      this._render();
    },
    setSmooth(this: any, s: boolean): void {
      this._smooth = !!s;
      this._render();
    },
    setColormap(this: any, spec: ColormapSpec): void {
      this._colormapData = resolveColormap(spec);
      this._colormapDirty = true;
      this._render();
    },
    setVmin(this: any, v: number): void { this._vmin = v; this._render(); },
    setVmax(this: any, v: number): void { this._vmax = v; this._render(); },
    setScaleType(this: any, t: 'linear' | 'log'): void {
      this._logScale = t === 'log' ? 1 : 0;
      this._render();
    },
    setTransparentBelow(this: any, v: number | undefined): void {
      this._transparentBelow = v != null ? v : -1e30;
      this._render();
    },
    setAlphaByValue(this: any, v: boolean): void {
      this._alphaByValue = v ? 1 : 0;
      this._render();
    },

    /** Apply a partial options patch. Fields not relevant to raster are
     *  silently ignored. See MercatorLayer.setOptions for the
     *  customer-facing entry point. */
    applyOptions(this: any, p: any): void {
      if (p.opacity != null) this.setOpacity(p.opacity);
      if (p.smooth != null) this.setSmooth(p.smooth);
      if (p.colormap != null) this.setColormap(p.colormap);
      if (p.vmin != null) this.setVmin(p.vmin);
      if (p.vmax != null) this.setVmax(p.vmax);
      if (p.scaleType != null) this.setScaleType(p.scaleType);
      if ('transparentBelow' in p) this.setTransparentBelow(p.transparentBelow);
      if (p.alphaByValue != null) this.setAlphaByValue(p.alphaByValue);
    },
  });

  return LayerClass;
}

/**
 * Build a MercatorRasterLayer from a pre-discovered STAC item.
 * Synchronous — the layer is ready to `.addTo(map)` immediately.
 */
function fromItem(opts: MercatorRasterLayerOpts, item: DiscoveredItem): any {
  const Cls = ensureLayerClass();
  return new Cls({ ...opts, item });
}

/**
 * Discover the latest STAC item for the given dataset and build a
 * MercatorRasterLayer ready to `.addTo(map)`.
 */
async function create(opts: MercatorRasterLayerOpts): Promise<any> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorRasterLayer = { create, fromItem };
