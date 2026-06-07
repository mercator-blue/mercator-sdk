// Mapbox GL JS / MapLibre 5 host-runtime adapter.
//
// The two libraries share an almost-identical CustomLayerInterface, but
// the render() arg shape diverges:
//
//   - MapLibre 5 → render(gl, args)
//       args = { defaultProjectionData, shaderData, ... }
//       args.shaderData.vertexShaderPrelude is the globe-aware GLSL
//       prelude that defines projectTile() / projectToSphere() and
//       the projection uniforms. One shader source, two
//       projections, both handled by the prelude.
//
//   - Mapbox GL JS v3 → render(gl, matrix, projection?,
//                              projectionToMercatorMatrix?,
//                              projectionToMercatorTransition?,
//                              centerInMercator?,
//                              pixelsPerMeterRatio?)
//       Positional args. `matrix` always projects mercator-world
//       coords ([0,1]²) → clip space. Under globe, Mapbox also
//       supplies `projectionToMercatorMatrix` (ECEF → mercator
//       world), `projectionToMercatorTransition` (0=globe, 1=flat),
//       and `centerInMercator` (recentering anchor). Custom layers
//       are expected to:
//          1. Convert mercator → lat/lng → ECEF themselves
//          2. Push the ECEF position through projectionToMercatorMatrix
//             to land in mercator-world coords
//          3. mix() that with the raw mercator position by
//             projectionToMercatorTransition to follow the camera as
//             it pulls back into flat mode
//          4. Multiply by `matrix` to land in clip space.
//       Mapbox doesn't inject any GLSL prelude — we synthesise one.
//
// We dispatch at render time. Detection: Array.isArray (or typed-array
// view) is Mapbox; plain object is MapLibre. Under Mapbox we further
// distinguish globe vs mercator by whether projectionToMercatorMatrix
// was supplied (Mapbox only sets it when projection === 'globe').
//
// Per-host shader-program variants prevent recompiling on every frame
// but rebuild correctly when the host or projection changes:
//   __plain__         MapLibre Mercator (default empty variant name)
//   globe-or-similar  MapLibre globe (whatever MapLibre tags)
//   __mapbox_merc__   Mapbox flat Mercator
//   __mapbox_globe__  Mapbox globe (ECEF transform)

/**
 * Vertex prelude for Mapbox GL JS in flat Mercator. Defines
 * `projectTile()` so the existing shader source compiles without the
 * MapLibre 5 globe prelude. Used when Mapbox's projection is
 * 'mercator' OR when Mapbox is in globe mode at high enough zoom that
 * the globe has flattened (in that case Mapbox still passes the
 * globe-mode args but the visual difference disappears as
 * projectionToMercatorTransition → 1, and the simpler Mercator path
 * is fine).
 */
export const MAPBOX_MERCATOR_PRELUDE = `
precision highp float;
uniform mat4 u_projection_matrix;
vec4 projectTile(vec2 mercatorPos) {
  return u_projection_matrix * vec4(mercatorPos, 0.0, 1.0);
}
`;

/**
 * Vertex prelude for Mapbox GL JS in globe projection. Synthesises
 * the math Mapbox's mapbox-gl-js@v3.7.0 does internally
 * (src/shaders/_prelude.vertex.glsl + globe_raster.vertex.glsl):
 *
 *   1. mercator[0,1]² → lat/lng (inverse Web Mercator)
 *   2. lat/lng → ECEF (sphere in tile-units, GLOBE_RADIUS = 8192/π/2)
 *   3. ECEF → mercator-world via u_mapbox_globe_to_mercator
 *      (Mapbox's projectionToMercatorMatrix arg)
 *   4. mix() with raw mercator position by u_mapbox_transition
 *      (Mapbox's projectionToMercatorTransition; 0=globe, 1=flat)
 *   5. multiply by u_projection_matrix (Mapbox's `matrix` arg —
 *      mercator-world → clip space)
 *
 * Centerpiece is the mix() — Mapbox renders identically to mercator
 * at zooms > 6 even when projection: 'globe' is set, and the
 * mix-in-position-space (not matrix-blend) is what makes that
 * transition look right.
 */
export const MAPBOX_GLOBE_PRELUDE = `
precision highp float;

uniform mat4 u_projection_matrix;
uniform mat4 u_mapbox_globe_to_mercator;
uniform float u_mapbox_globe_transition;
uniform vec2 u_mapbox_center_mercator;

#define MB_EXTENT 8192.0
#define MB_PI 3.1415926535897932
#define MB_GLOBE_RADIUS (MB_EXTENT / MB_PI / 2.0)
#define MB_DEG_TO_RAD (MB_PI / 180.0)

vec2 _mb_mercatorToLatLng(vec2 m) {
  float lng = (m.x - 0.5) * 360.0;
  float lat = 90.0 - 360.0 / MB_PI * atan(exp((m.y - 0.5) * 2.0 * MB_PI));
  return vec2(lat, lng);
}

vec3 _mb_latLngToECEF(vec2 latLngDeg) {
  vec2 r = latLngDeg * MB_DEG_TO_RAD;
  float cl = cos(r.x), sl = sin(r.x);
  return vec3(cl * sin(r.y), -sl, cl * cos(r.y)) * MB_GLOBE_RADIUS;
}

vec4 projectTile(vec2 mercatorPos) {
  vec3 ecef = _mb_latLngToECEF(_mb_mercatorToLatLng(mercatorPos));
  vec3 globe_world = (u_mapbox_globe_to_mercator * vec4(ecef, 1.0)).xyz;
  // Mercator branch — recenter near the camera anchor and wrap to
  // [-0.5, 0.5] so the antimeridian crossing doesn't drag the mesh
  // halfway around the world.
  vec2 m = mercatorPos - u_mapbox_center_mercator;
  m.x = m.x - floor(m.x + 0.5);
  vec3 merc_world = vec3(m + u_mapbox_center_mercator, 0.0);
  vec3 world = mix(globe_world, merc_world, u_mapbox_globe_transition);
  return u_projection_matrix * vec4(world, 1.0);
}
`;

// --- Argument shapes -----------------------------------------------
//
// We declare matrix / vector elements as `Float32Array | number[]`
// because both Mapbox and MapLibre pass typed arrays in production but
// some test paths (and older Mapbox versions) pass plain number arrays.
// All downstream consumers feed these straight into
// `gl.uniformMatrix4fv` / `gl.uniform4fv` etc., which accept either.

/** mat4 row-major 16 numbers. */
export type Mat4Like = Float32Array | readonly number[];
/** vec2 / vec4 — 2 or 4 numbers. */
export type VecLike = Float32Array | readonly number[];

/** Bag of positional render() args Mapbox passes after the matrix.
 *  Under MapLibre and Mapbox-Mercator the meaningful fields are
 *  undefined — Mapbox only populates projectionToMercatorMatrix /
 *  projectionToMercatorTransition / centerInMercator on globe. */
export interface MapboxExtras {
  projection?: string;
  projectionToMercatorMatrix?: Mat4Like;
  projectionToMercatorTransition?: number;
  centerInMercator?: VecLike;
  pixelsPerMeterRatio?: number;
}

/** Shader-data block the SDK feeds into each layer's program build:
 *  the host-supplied (MapLibre) or host-synthesised (Mapbox) vertex
 *  prelude, a per-host `define` directive, and a variant name used to
 *  key the compiled-program cache. */
export interface ShaderData {
  vertexShaderPrelude: string;
  define: string;
  variantName: string;
}

/** MapLibre 5's `args.defaultProjectionData`. Mapbox-side normalisation
 *  leaves this `undefined`. */
export interface DefaultProjectionData {
  mainMatrix: Mat4Like;
  tileMercatorCoords: VecLike;
  clippingPlane: VecLike;
  projectionTransition: number;
  fallbackMatrix: Mat4Like;
}

/** Single normalised shape both Mapbox and MapLibre code paths consume.
 *  Returned by {@link normalizeRenderArgs}. */
export interface NormalisedRenderArgs {
  isMapbox: boolean;
  isMapboxGlobe: boolean;
  matrix: Mat4Like;
  /** Populated only under Mapbox globe; undefined otherwise. */
  mapboxExtras: MapboxExtras | undefined;
  shaderData: ShaderData;
  /** Populated only under MapLibre 5; undefined under Mapbox. */
  defaultProjectionData: DefaultProjectionData | undefined;
}

/** MapLibre 5's per-frame render args object. We only read the two
 *  fields the SDK uses; the rest of MapLibre's shape is preserved by
 *  the `args` indexed type at call sites. */
interface MapLibreArgs {
  defaultProjectionData?: DefaultProjectionData;
  shaderData?: ShaderData;
}

/** Type-narrowing predicate: Mapbox v3 passes the MVP matrix directly
 *  (as Array<number> or, defensively, a typed-array view); MapLibre
 *  passes a plain object. Test what the args IS — safer than asking
 *  what it doesn't have — so the dispatch still works if MapLibre
 *  extends its args object in a future minor. */
function isMapboxArgs(args: unknown): args is Mat4Like {
  return Array.isArray(args) || ArrayBuffer.isView(args);
}

/**
 * Normalise render() args from either host into a single shape both
 * code paths can read.
 *
 * @param args         The first arg the host's `render` callback got
 *                     (MapLibre: a single object; Mapbox: the raw
 *                     matrix).
 * @param mapboxExtras The remaining positional args from Mapbox's
 *                     `render` callback (projection, projectionTo*,
 *                     centerInMercator, …). Pass them through even
 *                     when calling from MapLibre — the function
 *                     ignores them when args is a plain object.
 */
export function normalizeRenderArgs(
  args: unknown,
  mapboxExtras?: MapboxExtras,
): NormalisedRenderArgs {
  if (isMapboxArgs(args)) {
    const isGlobe = !!mapboxExtras?.projectionToMercatorMatrix;
    return {
      isMapbox: true,
      isMapboxGlobe: isGlobe,
      matrix: args,
      mapboxExtras: isGlobe ? mapboxExtras : undefined,
      shaderData: {
        vertexShaderPrelude: isGlobe ? MAPBOX_GLOBE_PRELUDE : MAPBOX_MERCATOR_PRELUDE,
        // The Mapbox-globe define lets shaders that bypass the prelude's
        // projectTile() (e.g. streamlines, which inlines a split-precision
        // multiply for flat Mercator) opt into the prelude's globe path
        // explicitly. Arrows + tile-bounds always go through projectTile()
        // so they don't need it. MapLibre globe is signalled by the
        // basemap's own GLOBE define in its prelude.
        define: isGlobe ? '#define MAPBOX_GLOBE\n' : '',
        variantName: isGlobe ? '__mapbox_globe__' : '__mapbox_merc__',
      },
      defaultProjectionData: undefined,
    };
  }
  // MapLibre 5: args is { defaultProjectionData, shaderData, ... }.
  const m = (args as MapLibreArgs | undefined) ?? {};
  return {
    isMapbox: false,
    isMapboxGlobe: false,
    matrix: m.defaultProjectionData?.mainMatrix ?? new Float32Array(16),
    mapboxExtras: undefined,
    shaderData: m.shaderData ?? {
      vertexShaderPrelude: '',
      define: '',
      variantName: '__plain__',
    },
    defaultProjectionData: m.defaultProjectionData,
  };
}
