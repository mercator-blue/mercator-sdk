/**
 * Slippy-XYZ tile-boundary overlay. Draws a dashed magenta outline plus
 * a "{z}/{x}/{y}" label at the centre of each tile the data layer is
 * sampling at the current zoom. Useful for:
 *  - showing customers exactly where dataset resolution changes
 *  - making the underlying tiling visible in admin/operator UIs
 *  - debugging visual artifacts that line up with tile edges
 *
 * Implementation: hybrid — the LINES are drawn by our own custom WebGL
 * layer using expanded-triangle geometry (each logical sub-segment is
 * a screen-space-offset quad), which gives us:
 *  - controllable line width (gl.LINES caps at the driver's 1px floor)
 *  - same render-pass as the raster/particles so layer-ordering works
 *    on Mapbox globe (standard `line` layers sit BEHIND custom layers
 *    in Mapbox v3's render pipeline)
 *
 * The LABELS stay as a Mapbox/MapLibre `symbol` layer — text rendering
 * already lives in the right pass (symbols always render last in
 * Mapbox v3, drawn on top of everything).
 */

import { createProgram } from '../core/webgl-helpers';
import {
  lngToTileX,
  latToTileY,
  tileXToLng,
  tileYToLat,
  lngToMx,
  latToMy,
} from '../core/mercator';
import { normalizeRenderArgs, type NormalisedRenderArgs } from './host-adapter';
import { TILE_BOUNDS_VS, TILE_BOUNDS_FS } from './shaders/index.js';

const SRC = '__debug_tile_bounds';
const LINES_LAYER = '__debug_tile_bounds_lines';
const LABELS_LAYER = '__debug_tile_bounds_labels';

// Per-vertex layout: a_p0(2) + a_p1(2) + a_t(1) + a_side(1) = 6 floats.
const VERT_STRIDE_FLOATS = 6;
const VERT_STRIDE_BYTES = VERT_STRIDE_FLOATS * 4;

// Per-edge subdivision count for globe curvature. A tile edge at z=0
// spans up to 180° of longitude; drawing it as a single quad cuts a
// chord straight through the sphere interior. Splitting each edge into
// N short segments keeps each sub-chord within a sub-pixel of the
// great-circle path on a 1000px-tall canvas. Same N=32 the raster
// layer uses for its tessellated mesh (see raster-layer.js).
const SUBDIVIDE = 32;

// Default line width in CSS pixels. Scaled by devicePixelRatio at
// render time before being passed to the shader.
const DEFAULT_LINE_WIDTH_CSS_PX = 1.5;

export interface TileBoundariesOverlayOpts {
  /** 
   * Lower bound on tile z. Defaults to 0 (single world-spanning tile).
   * If the map zooms out below this, the overlay clamps to `minzoom`
   * instead of subdividing further down. 
   */
  minzoom?: number;
  /** 
   * Upper bound on tile z. Defaults to no cap so the boundary grid
   * keeps subdividing as the user zooms in; the overlay just tracks
   * the slippy-XYZ grid at floor(map.getZoom()). Pass a finite value
   * to pin it (e.g. to the data layer's maxzoom). 
   */
  maxzoom?: number;
  /** 
   * Mapbox GL JS v3 slot. Tile boundaries are usually wanted on TOP
   * of the data layers — `slot: 'top'` puts them there. Ignored under
   * MapLibre / older Mapbox. 
   */
  slot?: string;
  /** 
   * Line width in CSS pixels. Default 1.5. 
   */
  lineWidth?: number;
  /** 
   * Font(s) for the tile-label symbol layer. See `ContoursOpts.textFont`
   * in overlays.ts for the OpenFreeMap rationale. 
   */
  textFont?: string[];
}

export interface TileBoundariesOverlayHandle {
  remove(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyOptions(p: any): void;
}

function buildProgram(
  gl: WebGL2RenderingContext,
  shaderData: NormalisedRenderArgs['shaderData'],
): WebGLProgram {
  const prelude = shaderData?.vertexShaderPrelude ?? '';
  const define = shaderData?.define ?? '';
  const vsSource = `#version 300 es\n${prelude}\n${define}\n${TILE_BOUNDS_VS}`;
  const fsSource = `#version 300 es\n${TILE_BOUNDS_FS}`;
  return createProgram(gl, vsSource, fsSource);
}


// --- Geometry build ---------------------------------------------------

/**
 * Push one expanded sub-segment quad (2 triangles, 6 vertices). Each
 * vertex carries BOTH endpoints (the shader needs them to compute the
 * screen-space tangent), its endpoint flag (t=0 or 1), and its
 * perpendicular side (-1 or +1).
 *
 * Winding is consistent CCW so optional face culling won't drop a half.
 */
function pushQuad(
  verts: number[],
  p0x: number, p0y: number,
  p1x: number, p1y: number,
): void {
  // Triangle 1: A_-, B_-, A_+
  verts.push(p0x, p0y, p1x, p1y, 0, -1);
  verts.push(p0x, p0y, p1x, p1y, 1, -1);
  verts.push(p0x, p0y, p1x, p1y, 0,  1);
  // Triangle 2: A_+, B_-, B_+
  verts.push(p0x, p0y, p1x, p1y, 0,  1);
  verts.push(p0x, p0y, p1x, p1y, 1, -1);
  verts.push(p0x, p0y, p1x, p1y, 1,  1);
}

/**
 * Build one tile's closed boundary (NW → NE → SE → SW → NW).
 */
function pushTileBoundary(
  verts: number[],
  mxW: number, mxE: number, myN: number, myS: number,
): void {
  const corners: Array<[number, number]> = [
    [mxW, myN], [mxE, myN], [mxE, myS], [mxW, myS], [mxW, myN],
  ];

  for (let e = 0; e < 4; e++) {
    const [x0, y0] = corners[e];
    const [x1, y1] = corners[e + 1];

    for (let i = 0; i < SUBDIVIDE; i++) {
      const t0 = i / SUBDIVIDE;
      const t1 = (i + 1) / SUBDIVIDE;
      const p0x = x0 + (x1 - x0) * t0;
      const p0y = y0 + (y1 - y0) * t0;
      const p1x = x0 + (x1 - x0) * t1;
      const p1y = y0 + (y1 - y0) * t1;
      pushQuad(verts, p0x, p0y, p1x, p1y);
    }
  }
}

/**
 * State the custom WebGL layer attaches to `this` between onAdd and
 * onRemove. Methods that touch these fields annotate `this` to this
 * interface so TS knows about them — the object literal that ships the
 * layer to Mapbox / MapLibre is built bare and the host's
 * custom-layer protocol calls the methods with the layer as `this`.
 */
interface LinesLayerThis {
  gl: WebGL2RenderingContext;
  vbo: WebGLBuffer | null;
  vertexCount: number;
  program: WebGLProgram | null;
  programVariant: string | null;

  attrP0: GLint;
  attrP1: GLint;
  attrT: GLint;
  attrSide: GLint;

  uViewport: WebGLUniformLocation | null;
  uLineWidth: WebGLUniformLocation | null;

  uProjMatrix: WebGLUniformLocation | null;
  uProjTileCoords: WebGLUniformLocation | null;
  uProjClipping: WebGLUniformLocation | null;
  uProjTransition: WebGLUniformLocation | null;
  uProjFallback: WebGLUniformLocation | null;
  uMapboxGlobeToMercator: WebGLUniformLocation | null;
  uMapboxGlobeTransition: WebGLUniformLocation | null;
  uMapboxCenterMercator: WebGLUniformLocation | null;

  // Methods that render() calls on `this`. Declared here so TS lets
  // method-to-method dispatch through `this.X()` typecheck.
  _ensureProgram(gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void;
  _uploadIfDirty(gl: WebGL2RenderingContext): void;
  _setProjectionUniforms(gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void;
}

export function addTileBoundariesOverlay(
  // The map argument is a maplibregl.Map or mapboxgl.Map — we don't
  // hard-depend on either lib's types, so this stays loose. Inside,
  // we cast to `any` to call the standard Map API (getZoom, getBounds,
  // getSource/addSource/addLayer/getLayer/on/off/triggerRepaint).
  mapAny: unknown,
  opts: TileBoundariesOverlayOpts = {},
): TileBoundariesOverlayHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = mapAny as any;
  let minzoom = opts.minzoom ?? 0;
  let maxzoom = opts.maxzoom ?? Infinity;
  let lineWidthCss = opts.lineWidth ?? DEFAULT_LINE_WIDTH_CSS_PX;

  // Source backs the LABELS symbol layer. The line layer is custom and
  // owns its own vertex buffer.
  if (!map.getSource(SRC)) {
    map.addSource(SRC, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }

  // Labels symbol layer — text-only. Mapbox throws on addLayer when the
  // primary font isn't on its glyph endpoint, so wrap in try/catch: if
  // labels can't render (rare basemap), lines still do. The font
  // fallback list covers OpenFreeMap, NASA GIBS, Mapbox classic, Mapbox
  // Standard, MapLibre defaults.
  if (!map.getLayer(LABELS_LAYER)) {
    try {
      // OpenFreeMap (and other single-font MapLibre glyph endpoints)
      // 404 multi-font fontstacks instead of falling back to the first
      // available font. Default to a Mapbox-friendly fallback list;
      // callers using OpenFreeMap can override with ['Noto Sans Regular']
      // (the only font OpenFreeMap actually serves).
      const textFont = opts.textFont ?? [
        'Noto Sans Regular',
        'DIN Pro Regular',
        'Open Sans Regular',
        'Arial Unicode MS Regular',
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const labelSpec: any = {
        id: LABELS_LAYER,
        type: 'symbol',
        source: SRC,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': textFont,
          'text-size': 12,
          'text-anchor': 'center',
          // Force tile labels through the basemap's symbol collision
          // pipeline. Without these, Mapbox/MapLibre suppress our labels
          // wherever they collide with country/city names from the
          // basemap — and since the basemap has no idea our labels are
          // load-bearing for debugging, we lose tiles seemingly at
          // random. `ignore-placement: true` also keeps the basemap's
          // own labels visible (we shouldn't crowd them out either).
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ff00ff',
          'text-halo-color': 'rgba(0, 0, 0, 0.75)',
          'text-halo-width': 1.5,
        },
      };
      if (opts.slot) labelSpec.slot = opts.slot;
      map.addLayer(labelSpec);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[@mercator-blue/sdk] TileBoundariesOverlay: skipping labels — ' +
        'the basemap glyph server has none of [Noto Sans, DIN Pro, ' +
        'Open Sans, Arial Unicode MS]. Line boundaries still render.',
        err,
      );
    }
  }

  // Latest CPU-built vertex data. Mutated by update(); the custom layer's
  // render() uploads it lazily on the next frame.
  let pendingVertices = new Float32Array(0);
  let pendingVerticesDirty = false;

  function update(): void {
    const z = Math.max(minzoom, Math.min(maxzoom, Math.floor(map.getZoom())));
    const n = 2 ** z;
    const bounds = map.getBounds();

    const xLo = Math.floor(lngToTileX(bounds.getWest(), z));
    const xHi = Math.floor(lngToTileX(bounds.getEast(), z));
    const yLo = Math.max(0, Math.floor(latToTileY(bounds.getNorth(), z)));
    const yHi = Math.min(n - 1, Math.floor(latToTileY(bounds.getSouth(), z)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labelFeatures: any[] = [];
    const verts: number[] = [];

    for (let xRaw = xLo; xRaw <= xHi; xRaw++) {
      const x = ((xRaw % n) + n) % n;
      for (let y = yLo; y <= yHi; y++) {
        const wLng = tileXToLng(xRaw, z);
        const eLng = tileXToLng(xRaw + 1, z);
        const nLat = tileYToLat(y, z);
        const sLat = tileYToLat(y + 1, z);
        const label = `(${x}, ${y}) z=${z}`;

        // Label at tile centre, lat/lng for Mapbox's symbol projection.
        labelFeatures.push({
          type: 'Feature',
          properties: { label },
          geometry: { type: 'Point', coordinates: [(wLng + eLng) / 2, (nLat + sLat) / 2] },
        });

        // Expanded-line geometry for the custom WebGL layer.
        const mxW = lngToMx(wLng), mxE = lngToMx(eLng);
        const myN = latToMy(nLat), myS = latToMy(sLat);
        pushTileBoundary(verts, mxW, mxE, myN, myS);
      }
    }

    map.getSource(SRC).setData({ type: 'FeatureCollection', features: labelFeatures });
    pendingVertices = new Float32Array(verts);
    pendingVerticesDirty = true;
    map.triggerRepaint();
  }

  const layer = {
    id: LINES_LAYER,
    type: 'custom' as const,
    ...(opts.slot ? { slot: opts.slot } : {}),

    onAdd(this: LinesLayerThis, _map: unknown, gl: WebGL2RenderingContext): void {
      this.gl = gl;
      this.vbo = gl.createBuffer();
      this.vertexCount = 0;
      this.program = null;
      this.programVariant = null;
    },

    _ensureProgram(this: LinesLayerThis, gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void {
      const variant = n.shaderData.variantName;
      if (this.program && this.programVariant === variant) return;
      if (this.program) gl.deleteProgram(this.program);
      this.program = buildProgram(gl, n.shaderData);
      this.programVariant = variant;

      this.attrP0 = gl.getAttribLocation(this.program, 'a_p0');
      this.attrP1 = gl.getAttribLocation(this.program, 'a_p1');
      this.attrT = gl.getAttribLocation(this.program, 'a_t');
      this.attrSide = gl.getAttribLocation(this.program, 'a_side');

      this.uViewport = gl.getUniformLocation(this.program, 'u_viewport');
      this.uLineWidth = gl.getUniformLocation(this.program, 'u_line_width');

      this.uProjMatrix = gl.getUniformLocation(this.program, 'u_projection_matrix');
      this.uProjTileCoords = gl.getUniformLocation(this.program, 'u_projection_tile_mercator_coords');
      this.uProjClipping = gl.getUniformLocation(this.program, 'u_projection_clipping_plane');
      this.uProjTransition = gl.getUniformLocation(this.program, 'u_projection_transition');
      this.uProjFallback = gl.getUniformLocation(this.program, 'u_projection_fallback_matrix');
      this.uMapboxGlobeToMercator = gl.getUniformLocation(this.program, 'u_mapbox_globe_to_mercator');
      this.uMapboxGlobeTransition = gl.getUniformLocation(this.program, 'u_mapbox_globe_transition');
      this.uMapboxCenterMercator = gl.getUniformLocation(this.program, 'u_mapbox_center_mercator');
    },

    _setProjectionUniforms(this: LinesLayerThis, gl: WebGL2RenderingContext, n: NormalisedRenderArgs): void {
      if (n.isMapbox) {
        if (this.uProjMatrix) gl.uniformMatrix4fv(this.uProjMatrix, false, n.matrix);
        if (n.isMapboxGlobe && n.mapboxExtras) {
          const e = n.mapboxExtras;
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
      const pd = n.defaultProjectionData;
      if (!pd) return;
      if (this.uProjMatrix) gl.uniformMatrix4fv(this.uProjMatrix, false, pd.mainMatrix);
      if (this.uProjTileCoords) gl.uniform4fv(this.uProjTileCoords, pd.tileMercatorCoords);
      if (this.uProjClipping) gl.uniform4fv(this.uProjClipping, pd.clippingPlane);
      if (this.uProjTransition !== null) gl.uniform1f(this.uProjTransition, pd.projectionTransition);
      if (this.uProjFallback) gl.uniformMatrix4fv(this.uProjFallback, false, pd.fallbackMatrix);
    },

    _uploadIfDirty(this: LinesLayerThis, gl: WebGL2RenderingContext): void {
      if (!pendingVerticesDirty) return;
      pendingVerticesDirty = false;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, pendingVertices, gl.DYNAMIC_DRAW);
      this.vertexCount = pendingVertices.length / VERT_STRIDE_FLOATS;
    },

    // Host signature has trailing positional args under Mapbox globe;
    // we forward them to normalizeRenderArgs which makes sense of both
    // Mapbox + MapLibre shapes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(this: LinesLayerThis, gl: WebGL2RenderingContext, args: unknown, ...rest: any[]): void {
      const [projection, projectionToMercatorMatrix, projectionToMercatorTransition, centerInMercator, pixelsPerMeterRatio] = rest;
      const n: NormalisedRenderArgs = normalizeRenderArgs(args, {
        projection,
        projectionToMercatorMatrix,
        projectionToMercatorTransition,
        centerInMercator,
        pixelsPerMeterRatio,
      });
      this._ensureProgram(gl, n);
      this._uploadIfDirty(gl);

      if (this.vertexCount === 0) return;

      if (!this.program) return;
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

      // Attribute layout: a_p0(2) + a_p1(2) + a_t(1) + a_side(1)
      // = 6 floats × 4 bytes per float = 24 bytes stride.
      gl.enableVertexAttribArray(this.attrP0);
      gl.vertexAttribPointer(this.attrP0, 2, gl.FLOAT, false, VERT_STRIDE_BYTES, 0);
      gl.enableVertexAttribArray(this.attrP1);
      gl.vertexAttribPointer(this.attrP1, 2, gl.FLOAT, false, VERT_STRIDE_BYTES, 8);
      gl.enableVertexAttribArray(this.attrT);
      gl.vertexAttribPointer(this.attrT, 1, gl.FLOAT, false, VERT_STRIDE_BYTES, 16);
      gl.enableVertexAttribArray(this.attrSide);
      gl.vertexAttribPointer(this.attrSide, 1, gl.FLOAT, false, VERT_STRIDE_BYTES, 20);

      this._setProjectionUniforms(gl, n);

      // Line-width in DEVICE pixels. gl_Position rasterises against the
      // drawing buffer (device pixels), not CSS pixels — so multiply
      // CSS-pixel inputs by devicePixelRatio. This keeps a "1.5 CSS px"
      // line at 1.5 CSS px on HiDPI screens.
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      gl.uniform2f(this.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(this.uLineWidth, lineWidthCss * dpr);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

      // Disable our attribute arrays so they don't leak into the next
      // layer's draw on the shared default VAO (and so onRemove's
      // deleteBuffer doesn't leave a dangling enabled array → the next
      // drawArrays would throw INVALID_OPERATION).
      gl.disableVertexAttribArray(this.attrP0);
      gl.disableVertexAttribArray(this.attrP1);
      gl.disableVertexAttribArray(this.attrT);
      gl.disableVertexAttribArray(this.attrSide);
    },

    onRemove(this: LinesLayerThis, _map: unknown, gl: WebGL2RenderingContext): void {
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.program) gl.deleteProgram(this.program);
      this.vbo = null;
      this.program = null;
    },
  };

  if (!map.getLayer(LINES_LAYER)) {
    map.addLayer(layer);
  }

  map.on('move', update);
  map.on('moveend', update);
  update();

  return {
    remove(): void {
      map.off('move', update);
      map.off('moveend', update);
      if (map.getLayer(LABELS_LAYER)) map.removeLayer(LABELS_LAYER);
      if (map.getLayer(LINES_LAYER)) map.removeLayer(LINES_LAYER);
      if (map.getSource(SRC)) map.removeSource(SRC);
    },
    /** Apply a partial options patch. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyOptions(p: any): void {
      let needsUpdate = false;
      if (p.minzoom != null) { minzoom = p.minzoom; needsUpdate = true; }
      if (p.maxzoom != null) { maxzoom = p.maxzoom; needsUpdate = true; }
      if (p.lineWidth != null) {
        lineWidthCss = p.lineWidth;
        map.triggerRepaint();
      }
      if (needsUpdate) update();
    },
  };
}
