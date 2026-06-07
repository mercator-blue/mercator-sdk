/**
 * Leaflet binding — labelled contour isolines via WebGL2 (lines) +
 * Canvas2D (labels). Mirror of the OpenLayers WebGL contours layer
 * (sdk/src/openlayers/contours-layer.ts) ported to Leaflet's
 * L.Layer.extend lifecycle.
 *
 * Architecture:
 *   - Two stacked canvases inside the layer's pane. The WebGL2 canvas
 *     draws expanded-triangle line geometry with mitre joins via
 *     TRIANGLE_STRIP + primitive-restart between polylines. The
 *     Canvas2D canvas draws along-line halo + fill text labels.
 *   - Geometry uploaded on rebuild (moveend / zoomend / interval
 *     change). The world→pixel matrix is computed once per rebuild
 *     from the viewport top-left; per-frame redraw isn't needed
 *     because BOTH canvases ride mapPane's CSS translate during a
 *     pan, the same way the previous Canvas2D version did.
 *   - Shader is lifted verbatim from the OL binding. The only host
 *     differences live in the canvas lifecycle (pane / setPosition /
 *     zoomanim scale-transform) and the matrix derivation (Leaflet
 *     gives us a layerPoint origin; OL gives a coordinateToPixel
 *     transform).
 *
 * Mitre joins fix the "triangular spikes at sharp polyline corners"
 * artifact that simple expanded-triangle line geometry produces. The
 * NaN guard in the shader handles the near-180° hairpin case where
 * the incoming + outgoing unit tangents cancel.
 *
 * MVT fetch/parse + the LRU tile cache come from the host-agnostic
 * core/contour-tiles.ts. Visible-tile walk falls back to the deepest
 * cached ancestor ONLY when nothing at target zoom has loaded yet —
 * otherwise parent + child overlap renders every isovalue twice with
 * slightly different DP paths.
 */

import { lngToTileX, latToTileY, posMod } from '../core/mercator';
import { ContourTileCache } from '../core/contour-tiles';
import { discoverLatestItem, type DiscoveredItem } from '../core/discover';
import { withApiKey, absolutiseUrl, DEFAULT_CATALOG_URL } from '../core/urls';
import { createProgram } from '../core/webgl-helpers';
import type { MercatorContoursOptions } from '../core/types';
import { parseCssColor } from '../core/css-color';


// Label-placement tunables (CSS pixels).
const LABEL_SPACING_PX = 220;
const MIN_LABEL_LEN_PX = 90;
const MIN_LABEL_DIST_PX = 55;
const LABEL_EDGE_MARGIN_PX = 8;

// Per strip vertex: a_pos(2) + a_prev(2) + a_next(2) + a_side(1) + a_bold(1) = 8 floats.
const FLOATS_PER_VERTEX = 8;
// WebGL 2 PRIMITIVE_RESTART_FIXED_INDEX for gl.UNSIGNED_INT is 0xFFFFFFFF.
const RESTART_INDEX = 0xFFFFFFFF;

import {
  CONTOUR_LINES_VS as LINES_VS,
  CONTOUR_LINES_FS as LINES_FS,
} from './shaders/index';

/** Leaflet-specific extras on top of the cross-binding
 *  {@link MercatorContoursOptions}. */
export type MercatorContoursLayerOpts = MercatorContoursOptions & {
  /** Label fill colour. Default `#111827`. */
  textColor?: string;
  /** Label halo colour. Default `rgba(255, 255, 255, 0.9)`. */
  textHaloColor?: string;
  /** Label halo width, CSS px. Default 2.5. */
  textHaloWidth?: number;
  /** Canvas2D font shorthand. Default `11px sans-serif`. */
  font?: string;
  /** Leaflet pane. Default `overlayPane`. */
  pane?: string;
};

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

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : String(+v.toFixed(2));
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

      const c = this._item.contour;
      if (!c) {
        throw new Error(
          `@mercator-blue/sdk/leaflet: MercatorContoursLayer requires a contour ` +
          `pyramid; dataset "${opts.dataset}" has none published.`,
        );
      }

      this._urlTemplate = withApiKey(
        absolutiseUrl(c.url_template, this._item.itemBase),
        this._apiKey,
      );
      this._sourceLayer = c.source_layer ?? 'contours';
      this._minzoom = c.minzoom ?? 0;
      this._maxzoom = c.maxzoom ?? 5;
      this._interval = opts.initialInterval ?? c.default_interval;
      this._unit = c.unit ?? '';
      this._userFilterMinZoom = c.user_filter_min_zoom ?? 0;
      this._coarsestInterval = c.coarsest_interval;

      // Medium-dark slate-gray (Tailwind gray-600). Softer than the
      // previous near-black (#111827, gray-900) which read as heavy
      // ink over coloured raster + light basemaps.
      this._lineColor = opts.lineColor ?? '#4b5563';
      this._lineColorRGBA = parseCssColor(this._lineColor);
      this._lineWidth = opts.lineWidth ?? 1.0;
      this._boldLineWidth = opts.boldLineWidth ?? 1.8;
      this._opacity = opts.opacity ?? 1;
      this._textColor = opts.textColor ?? '#4b5563';
      this._textHaloColor = opts.textHaloColor ?? 'rgba(255, 255, 255, 0.9)';
      this._textHaloWidth = opts.textHaloWidth ?? 2.5;
      this._font = opts.font ?? '11px sans-serif';

      // Labels collected at rebuild time with CSS-pixel anchors valid
      // for the rebuild's viewport top-left. Canvas rides mapPane
      // during pan, so the anchors stay correct as the basemap slides.
      this._labels = [];
      this._features = [];
      this._indexCount = 0;
    },

    onAdd(this: any, map: any): any {
      this._map = map;
      const pane = (this.options.pane as string) ?? 'overlayPane';
      const paneEl = map.getPane(pane);

      // WebGL2 canvas for lines + Canvas2D canvas for labels, stacked.
      // Same transform/anchor so they pan/zoom together.
      const lineCanvas = L.DomUtil.create('canvas', 'mercator-contours-lines') as HTMLCanvasElement;
      lineCanvas.style.position = 'absolute';
      lineCanvas.style.pointerEvents = 'none';
      // Above arrows (250), below tile-boundaries (300).
      lineCanvas.style.zIndex = '260';
      lineCanvas.style.transformOrigin = '0 0';
      paneEl.appendChild(lineCanvas);
      this._lineCanvas = lineCanvas;

      const labelCanvas = L.DomUtil.create('canvas', 'mercator-contours-labels') as HTMLCanvasElement;
      labelCanvas.style.position = 'absolute';
      labelCanvas.style.pointerEvents = 'none';
      // Labels above the lines.
      labelCanvas.style.zIndex = '261';
      labelCanvas.style.transformOrigin = '0 0';
      paneEl.appendChild(labelCanvas);
      this._labelCanvas = labelCanvas;

      const gl0 = lineCanvas.getContext('webgl2', {
        premultipliedAlpha: false,
        antialias: true,
        preserveDrawingBuffer: false,
      });
      if (!gl0) {
        throw new Error('@mercator-blue/sdk/leaflet: WebGL2 unavailable');
      }
      const gl: WebGL2RenderingContext = gl0;
      this._gl = gl;

      const labelCtx0 = labelCanvas.getContext('2d');
      if (!labelCtx0) {
        throw new Error('@mercator-blue/sdk/leaflet: 2D context unavailable for labels');
      }
      this._labelCtx = labelCtx0;

      const program = createProgram(gl, LINES_VS, LINES_FS);
      this._program = program;
      this._locPos    = gl.getAttribLocation(program, 'a_pos');
      this._locPrev   = gl.getAttribLocation(program, 'a_prev');
      this._locNext   = gl.getAttribLocation(program, 'a_next');
      this._locSide   = gl.getAttribLocation(program, 'a_side');
      this._locBold   = gl.getAttribLocation(program, 'a_bold');
      this._locWorldToPixel = gl.getUniformLocation(program, 'u_world_to_pixel');
      this._locViewport     = gl.getUniformLocation(program, 'u_viewport');
      this._locDpr          = gl.getUniformLocation(program, 'u_dpr');
      this._locWorldOffsetX = gl.getUniformLocation(program, 'u_world_offset_x');
      this._locWidthBase    = gl.getUniformLocation(program, 'u_width_base');
      this._locWidthExtra   = gl.getUniformLocation(program, 'u_width_extra');
      this._locColor        = gl.getUniformLocation(program, 'u_color');
      this._locOpacity      = gl.getUniformLocation(program, 'u_opacity');

      const vbo = gl.createBuffer();
      const ibo = gl.createBuffer();
      if (!vbo || !ibo) throw new Error('@mercator-blue/sdk/leaflet: createBuffer returned null');
      this._vbo = vbo;
      this._ibo = ibo;
      this._cpuBuf = new Float32Array(0);
      this._cpuIdx = new Uint32Array(0);
      this._matBuf = new Float32Array(9);

      this._cache = new ContourTileCache({
        urlTemplate: this._urlTemplate,
        sourceLayer: this._sourceLayer,
      });
      this._rebuildBound = this._rebuild.bind(this);
      this._cache.ensure(this._minzoom, 0, 0, this._rebuildBound);

      // No `move` listener — both canvases ride mapPane during pan.
      map.on('moveend', this._onMoveEnd, this);
      map.on('zoomanim', this._onZoomAnim, this);
      map.on('zoomend', this._onZoomEnd, this);
      map.on('viewreset', this._onReset, this);
      map.on('resize', this._onReset, this);

      this._reset();
      return this;
    },

    onRemove(this: any, map: any): any {
      map.off('moveend', this._onMoveEnd, this);
      map.off('zoomanim', this._onZoomAnim, this);
      map.off('zoomend', this._onZoomEnd, this);
      map.off('viewreset', this._onReset, this);
      map.off('resize', this._onReset, this);

      if (this._lineCanvas?.parentNode) {
        this._lineCanvas.parentNode.removeChild(this._lineCanvas);
      }
      if (this._labelCanvas?.parentNode) {
        this._labelCanvas.parentNode.removeChild(this._labelCanvas);
      }
      this._lineCanvas = null;
      this._labelCanvas = null;
      this._gl = null;
      this._labelCtx = null;
      this._program = null;
      this._vbo = null;
      this._ibo = null;
      this._map = null;
      if (this._cache) this._cache.clear();
      return this;
    },

    _onZoomAnim(this: any, opts: any): void {
      const map = this._map;
      if (!map) return;
      const scale = map.getZoomScale(opts.zoom, this._anchorZoom);
      const newOrigin = map._getNewPixelOrigin(opts.center, opts.zoom);
      const newTlLayerX = this._anchorPixelX * scale - newOrigin.x;
      const newTlLayerY = this._anchorPixelY * scale - newOrigin.y;
      const tp = L.point(newTlLayerX, newTlLayerY);
      // Animate both canvases identically so they stay aligned.
      if (this._lineCanvas) {
        this._lineCanvas.style.transition = 'transform 250ms cubic-bezier(0,0,0.25,1)';
        L.DomUtil.setTransform(this._lineCanvas, tp, scale);
      }
      if (this._labelCanvas) {
        this._labelCanvas.style.transition = 'transform 250ms cubic-bezier(0,0,0.25,1)';
        L.DomUtil.setTransform(this._labelCanvas, tp, scale);
      }
    },
    _onZoomEnd(this: any): void {
      if (this._lineCanvas) this._lineCanvas.style.transition = '';
      if (this._labelCanvas) this._labelCanvas.style.transition = '';
      this._reset();
    },
    _onMoveEnd(this: any): void { this._reset(); },
    _onReset(this: any): void { this._reset(); },

    /** Re-anchor both canvases at the new viewport top-left, then
     *  rebuild geometry + labels for the new view. */
    _reset(this: any): void {
      const map = this._map;
      if (!map) return;

      // Clear any in-flight zoom-anim transition before setPosition
      // rewrites the transform — same "shrink back" guard as the
      // other Leaflet canvas layers.
      if (this._lineCanvas) this._lineCanvas.style.transition = '';
      if (this._labelCanvas) this._labelCanvas.style.transition = '';

      const size = map.getSize();
      const dpr = (globalThis.devicePixelRatio ?? 1);
      const bw = Math.round(size.x * dpr);
      const bh = Math.round(size.y * dpr);

      for (const cv of [this._lineCanvas, this._labelCanvas] as Array<HTMLCanvasElement | null>) {
        if (!cv) continue;
        cv.style.width = `${size.x}px`;
        cv.style.height = `${size.y}px`;
        if (cv.width !== bw || cv.height !== bh) {
          cv.width = bw;
          cv.height = bh;
        }
      }

      const topLeftLayer = map.containerPointToLayerPoint([0, 0]);
      if (this._lineCanvas) L.DomUtil.setPosition(this._lineCanvas, topLeftLayer);
      if (this._labelCanvas) L.DomUtil.setPosition(this._labelCanvas, topLeftLayer);

      const origin = map.getPixelOrigin();
      this._anchorPixelX = topLeftLayer.x + origin.x;
      this._anchorPixelY = topLeftLayer.y + origin.y;
      this._anchorZoom = map.getZoom();

      this._rebuild();
    },

    _effectiveInterval(this: any, mapZ: number): number {
      if (this._userFilterMinZoom > 0 && mapZ < this._userFilterMinZoom
          && this._coarsestInterval != null) {
        return this._coarsestInterval;
      }
      return this._interval;
    },

    /** Walk the visible tile set + interval filter, build the line
     *  geometry buffer (triangle strip + mitre attribute data +
     *  primitive-restart between polylines), upload to the VBO/IBO,
     *  collect labels, then trigger the WebGL + Canvas2D render. */
    _rebuild(this: any): void {
      const map = this._map;
      if (!map || !this._lineCanvas) return;

      const mapZ = map.getZoom();
      const targetZ = Math.max(this._minzoom, Math.min(this._maxzoom, Math.floor(mapZ)));
      const n = 2 ** targetZ;
      const bounds = map.getBounds();
      const wantInterval = this._effectiveInterval(mapZ);

      const xLo = Math.floor(lngToTileX(bounds.getWest(), targetZ));
      const xHi = Math.floor(lngToTileX(bounds.getEast(), targetZ));
      const yLo = Math.max(0, Math.floor(latToTileY(bounds.getNorth(), targetZ)));
      const yHi = Math.min(n - 1, Math.floor(latToTileY(bounds.getSouth(), targetZ)));

      // Visible tile set with parent-fallback only on cold load —
      // mixing parent + child renders every isovalue twice (different
      // DP tolerances per zoom band). See sdk/src/openlayers/contours-layer.ts.
      const tilesToRender = new Set<string>();
      const missing: Array<[number, number]> = [];
      let anyTargetLoaded = false;
      for (let xRaw = xLo; xRaw <= xHi; xRaw++) {
        const x = posMod(xRaw, n);
        for (let y = yLo; y <= yHi; y++) {
          const cached = this._cache.get(targetZ, x, y);
          if (cached && cached.length !== undefined) {
            tilesToRender.add(`${targetZ}/${x}/${y}`);
            anyTargetLoaded = true;
            continue;
          }
          if (cached === undefined) {
            this._cache.ensure(targetZ, x, y, this._rebuildBound);
          }
          missing.push([x, y]);
        }
      }
      if (!anyTargetLoaded) {
        for (const [x, y] of missing) {
          for (let pz = targetZ - 1; pz >= this._minzoom; pz--) {
            const dz = targetZ - pz;
            const pCached = this._cache.get(pz, x >> dz, y >> dz);
            if (pCached && pCached.length !== undefined) {
              tilesToRender.add(`${pz}/${x >> dz}/${y >> dz}`);
              break;
            }
          }
        }
      }

      interface Plyne { pl: Float32Array; bold: boolean; value: number }
      const plynes: Plyne[] = [];
      for (const key of tilesToRender) {
        const [zStr, xStr, yStr] = key.split('/');
        const feats = this._cache.get(+zStr, +xStr, +yStr);
        if (!feats) continue;
        for (const f of feats) {
          if (f.interval !== wantInterval) continue;
          const bold = Math.round(f.value) % 10 === 0;
          for (const pl of f.polylines) {
            if (pl.length < 4) continue;
            plynes.push({ pl, bold, value: f.value });
          }
        }
      }

      // Empty build while fetches in flight → hold previous geometry
      // so the user doesn't see a blackout while tiles load.
      if (plynes.length === 0 && this._cache.hasPending() && this._indexCount > 0) {
        return;
      }

      // Size the buffers: 2 strip verts per polyline vertex; per
      // polyline 2*nPts index entries plus one restart sentinel.
      let totalVerts = 0;
      let totalIdx = 0;
      for (const p of plynes) {
        const nPts = p.pl.length / 2;
        totalVerts += 2 * nPts;
        totalIdx += 2 * nPts + 1;
      }

      const needFloats = totalVerts * FLOATS_PER_VERTEX;
      if (this._cpuBuf.length < needFloats) {
        this._cpuBuf = new Float32Array(Math.max(needFloats, this._cpuBuf.length * 2));
      }
      if (this._cpuIdx.length < totalIdx) {
        this._cpuIdx = new Uint32Array(Math.max(totalIdx, this._cpuIdx.length * 2));
      }

      const cpuBuf: Float32Array = this._cpuBuf;
      const cpuIdx: Uint32Array = this._cpuIdx;
      let foff = 0;
      let ioff = 0;
      let vbase = 0;
      for (const { pl, bold } of plynes) {
        const nPts = pl.length / 2;
        const boldF = bold ? 1 : 0;
        for (let i = 0; i < nPts; i++) {
          const x = pl[i * 2];
          const y = pl[i * 2 + 1];
          // Endpoints encode "no neighbour" by setting prev=this or next=this.
          const px = i > 0 ? pl[(i - 1) * 2]     : x;
          const py = i > 0 ? pl[(i - 1) * 2 + 1] : y;
          const nx = i < nPts - 1 ? pl[(i + 1) * 2]     : x;
          const ny = i < nPts - 1 ? pl[(i + 1) * 2 + 1] : y;
          // Left strip vertex (a_side = -1)
          cpuBuf[foff++] = x;  cpuBuf[foff++] = y;
          cpuBuf[foff++] = px; cpuBuf[foff++] = py;
          cpuBuf[foff++] = nx; cpuBuf[foff++] = ny;
          cpuBuf[foff++] = -1; cpuBuf[foff++] = boldF;
          // Right strip vertex (a_side = +1)
          cpuBuf[foff++] = x;  cpuBuf[foff++] = y;
          cpuBuf[foff++] = px; cpuBuf[foff++] = py;
          cpuBuf[foff++] = nx; cpuBuf[foff++] = ny;
          cpuBuf[foff++] = +1; cpuBuf[foff++] = boldF;

          cpuIdx[ioff++] = vbase + 2 * i;
          cpuIdx[ioff++] = vbase + 2 * i + 1;
        }
        cpuIdx[ioff++] = RESTART_INDEX;
        vbase += 2 * nPts;
      }
      this._indexCount = ioff;

      const gl: WebGL2RenderingContext = this._gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
      gl.bufferData(gl.ARRAY_BUFFER, cpuBuf.subarray(0, needFloats), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cpuIdx.subarray(0, this._indexCount), gl.DYNAMIC_DRAW);

      // ---- Collect labels in CSS-pixel coords for the current view ----
      // The labels canvas rides mapPane during pan (same as the lines
      // canvas), so anchors baked at rebuild time stay correct as the
      // basemap slides — no per-frame re-projection needed.
      const size = map.getSize();
      const W = size.x, H = size.y;
      const z = map.getZoom();
      const S = 256 * Math.pow(2, z);
      const tlPx = this._anchorPixelX;
      const tlPy = this._anchorPixelY;
      const offMin = Math.floor(tlPx / S);
      const offMax = Math.floor((tlPx + W) / S);

      const labels: Array<{ x: number; y: number; ang: number; text: string }> = [];
      const placed: Array<{ x: number; y: number }> = [];
      const tooClose = (x: number, y: number): boolean => {
        for (const p of placed) {
          const dx = p.x - x, dy = p.y - y;
          if (dx * dx + dy * dy < MIN_LABEL_DIST_PX * MIN_LABEL_DIST_PX) return true;
        }
        return false;
      };

      // Scratch for projected coords; grows on demand.
      let scratch = new Float64Array(256);
      for (const { pl, value } of plynes) {
        const text = `${formatValue(value)}${this._unit}`;
        const nPts = pl.length / 2;
        if (scratch.length < pl.length) {
          scratch = new Float64Array(Math.max(scratch.length * 2, pl.length));
        }
        for (let off = offMin; off <= offMax; off++) {
          for (let j = 0; j < nPts; j++) {
            scratch[j * 2]     = (pl[j * 2] + off) * S - tlPx;
            scratch[j * 2 + 1] = pl[j * 2 + 1] * S - tlPy;
          }
          this._collectLabels(scratch, nPts, text, W, H, labels, placed, tooClose);
        }
      }
      this._labels = labels;

      this._render();
    },

    /** Draw lines (WebGL) + labels (Canvas2D) for the current
     *  geometry. Called by _rebuild after the buffers are uploaded. */
    _render(this: any): void {
      const map = this._map;
      const lc: HTMLCanvasElement | null = this._lineCanvas;
      const labelCv: HTMLCanvasElement | null = this._labelCanvas;
      const gl: WebGL2RenderingContext = this._gl;
      const labelCtx: CanvasRenderingContext2D = this._labelCtx;
      if (!map || !lc || !labelCv || !gl || !labelCtx) return;

      const dpr = (globalThis.devicePixelRatio ?? 1);

      // ---- WebGL line pass ----
      gl.viewport(0, 0, lc.width, lc.height);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (this._indexCount > 0) {
        gl.useProgram(this._program);

        // World→pixel matrix derivation: mercator-world (mx, my) maps
        // to CSS pixel (S*mx - tlPx, S*my - tlPy). Column-major mat3.
        const z = map.getZoom();
        const S = 256 * Math.pow(2, z);
        const mat: Float32Array = this._matBuf;
        mat[0] = S; mat[1] = 0; mat[2] = 0;
        mat[3] = 0; mat[4] = S; mat[5] = 0;
        mat[6] = -this._anchorPixelX; mat[7] = -this._anchorPixelY; mat[8] = 1;
        gl.uniformMatrix3fv(this._locWorldToPixel, false, mat);
        gl.uniform2f(this._locViewport, lc.width, lc.height);
        gl.uniform1f(this._locDpr, dpr);
        gl.uniform1f(this._locWidthBase, this._lineWidth);
        gl.uniform1f(this._locWidthExtra, this._boldLineWidth - this._lineWidth);
        const cRGBA: [number, number, number, number] = this._lineColorRGBA;
        gl.uniform4f(this._locColor, cRGBA[0], cRGBA[1], cRGBA[2], cRGBA[3]);
        gl.uniform1f(this._locOpacity, this._opacity);

        gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
        const stride = FLOATS_PER_VERTEX * 4;
        gl.enableVertexAttribArray(this._locPos);
        gl.vertexAttribPointer(this._locPos,  2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(this._locPrev);
        gl.vertexAttribPointer(this._locPrev, 2, gl.FLOAT, false, stride, 8);
        gl.enableVertexAttribArray(this._locNext);
        gl.vertexAttribPointer(this._locNext, 2, gl.FLOAT, false, stride, 16);
        gl.enableVertexAttribArray(this._locSide);
        gl.vertexAttribPointer(this._locSide, 1, gl.FLOAT, false, stride, 24);
        gl.enableVertexAttribArray(this._locBold);
        gl.vertexAttribPointer(this._locBold, 1, gl.FLOAT, false, stride, 28);

        // World-copy iteration — same offMin/offMax computation as the
        // label pass. Draw the strip once per visible world copy.
        const size = map.getSize();
        const offMin = Math.floor(this._anchorPixelX / S);
        const offMax = Math.floor((this._anchorPixelX + size.x) / S);
        for (let off = offMin; off <= offMax; off++) {
          gl.uniform1f(this._locWorldOffsetX, off);
          gl.drawElements(gl.TRIANGLE_STRIP, this._indexCount, gl.UNSIGNED_INT, 0);
        }

        gl.disableVertexAttribArray(this._locPos);
        gl.disableVertexAttribArray(this._locPrev);
        gl.disableVertexAttribArray(this._locNext);
        gl.disableVertexAttribArray(this._locSide);
        gl.disableVertexAttribArray(this._locBold);
      }

      // ---- Canvas2D label pass ----
      labelCtx.setTransform(1, 0, 0, 1, 0, 0);
      labelCtx.clearRect(0, 0, labelCv.width, labelCv.height);
      labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this._labels.length > 0) {
        labelCtx.font = this._font;
        labelCtx.textAlign = 'center';
        labelCtx.textBaseline = 'middle';
        labelCtx.lineJoin = 'round';
        for (const lb of this._labels as Array<{ x: number; y: number; ang: number; text: string }>) {
          labelCtx.save();
          labelCtx.translate(lb.x, lb.y);
          labelCtx.rotate(lb.ang);
          labelCtx.strokeStyle = this._textHaloColor;
          labelCtx.lineWidth = this._textHaloWidth;
          labelCtx.strokeText(lb.text, 0, 0);
          labelCtx.fillStyle = this._textColor;
          labelCtx.fillText(lb.text, 0, 0);
          labelCtx.restore();
        }
      }
    },

    /** Walk a projected polyline placing labels at fixed pixel spacing,
     *  oriented along the local segment (flipped to stay upright), with
     *  a nearest-neighbour collision reject. Mutates `labels` + `placed`. */
    _collectLabels(
      this: any,
      pts: Float64Array,
      nPts: number,
      text: string,
      W: number, H: number,
      labels: Array<{ x: number; y: number; ang: number; text: string }>,
      placed: Array<{ x: number; y: number }>,
      tooClose: (x: number, y: number) => boolean,
    ): void {
      let total = 0;
      for (let i = 0; i < nPts - 1; i++) {
        total += Math.hypot(pts[(i + 1) * 2] - pts[i * 2], pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]);
      }
      if (total < MIN_LABEL_LEN_PX) return;

      let nextAt = LABEL_SPACING_PX * 0.5;
      let acc = 0;
      for (let i = 0; i < nPts - 1; i++) {
        const ax = pts[i * 2], ay = pts[i * 2 + 1];
        const bx = pts[(i + 1) * 2], by = pts[(i + 1) * 2 + 1];
        const seg = Math.hypot(bx - ax, by - ay);
        while (nextAt <= acc + seg) {
          const t = seg > 0 ? (nextAt - acc) / seg : 0;
          const x = ax + (bx - ax) * t;
          const y = ay + (by - ay) * t;
          nextAt += LABEL_SPACING_PX;
          if (x < LABEL_EDGE_MARGIN_PX || x > W - LABEL_EDGE_MARGIN_PX
              || y < LABEL_EDGE_MARGIN_PX || y > H - LABEL_EDGE_MARGIN_PX) continue;
          if (tooClose(x, y)) continue;
          let ang = Math.atan2(by - ay, bx - ax);
          if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
          labels.push({ x, y, ang, text });
          placed.push({ x, y });
        }
        acc += seg;
      }
    },

    // ----- Public runtime setters -----
    setInterval(this: any, newInterval: number): void {
      this._interval = newInterval;
      this._rebuild();
    },
    getInterval(this: any): number { return this._interval; },
    setLineColor(this: any, css: string): void {
      this._lineColor = css;
      this._lineColorRGBA = parseCssColor(css);
      this._render();
    },
    setLineOpacity(this: any, v: number): void {
      // Mirrors the Mapbox impl: alpha is applied as the 4th component of
      // the line color RGBA. Stash the requested opacity AND patch the
      // RGBA's alpha so render reads the up-to-date value.
      this._lineOpacity = v;
      this._lineColorRGBA[3] = v;
      this._render();
    },
    setLineWidth(this: any, w: number): void {
      this._lineWidth = w;
      this._render();
    },
    setBoldLineWidth(this: any, w: number): void {
      this._boldLineWidth = w;
      this._render();
    },

    /** Apply a partial options patch. */
    applyOptions(this: any, p: any): void {
      if (p.initialInterval != null) this.setInterval(p.initialInterval);
      if (p.lineColor != null) this.setLineColor(p.lineColor);
      if (p.lineOpacity != null) this.setLineOpacity(p.lineOpacity);
      if (p.lineWidth != null) this.setLineWidth(p.lineWidth);
      if (p.boldLineWidth != null) this.setBoldLineWidth(p.boldLineWidth);
    },
  });

  return LayerClass;
}

function fromItem(opts: MercatorContoursLayerOpts, item: DiscoveredItem): any {
  const Cls = ensureLayerClass();
  return new Cls({ ...opts, item });
}

async function create(opts: MercatorContoursLayerOpts): Promise<any> {
  const catalogUrl = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const item = await discoverLatestItem(catalogUrl, opts.dataset);
  return fromItem(opts, item);
}

export const MercatorContoursLayer = { create, fromItem };
