/**
 * Chaikin-style corner-cutting smoothing for contour polylines.
 *
 * gdal_contour emits marching-squares output along the source data
 * grid — vertices land on grid intersections, so the polyline walks
 * a staircase of axis-aligned-and-diagonal segments. Per-zoom DP
 * simplification (mercator_tiles/formats/contours.py) drops vertices
 * that are within a pixel of the line, which reduces vertex count but
 * leaves the angular character intact: a 1.4° straight stretch
 * followed by a 1.4° diagonal stretch is still two segments meeting
 * at a sharp angle, not a smooth curve.
 *
 * Real isotherms / isobars / isobaths are smooth fields; the
 * angularity is a discretisation artifact. Chaikin's algorithm
 * trades each corner for two new vertices at 1/4 and 3/4 along the
 * adjacent segments — after one pass the polyline has roughly 2× the
 * vertices but every original "kink" is a much shallower bend; after
 * two passes the curve reads as visibly smooth.
 *
 * We gate by ANGLE so locally-straight stretches don't get bloated
 * with redundant vertices: if the angular deviation from straight at
 * an interior vertex is below `angleThresholdDeg`, the vertex passes
 * through unchanged. Endpoints are always preserved (don't round the
 * polyline's start or end).
 */

/**
 * Smooth a polyline by Chaikin corner-cutting, applied only at sharp
 * interior vertices.
 *
 * @param polyline Flat coordinate array `[x0, y0, x1, y1, …]`. Coords
 *   can be in any space (mercator-world, EPSG:3857, lat/lng, …); the
 *   algorithm is purely geometric and only depends on the input being
 *   2-D Cartesian-ish (which mercator-world is over a single
 *   polyline's extent at the zooms we serve).
 * @param iterations Number of Chaikin passes. Each pass roughly doubles
 *   vertex count at sharp corners and leaves gentle stretches alone.
 *   0 returns the input unchanged.
 * @param angleThresholdDeg Minimum angular deviation (degrees) from
 *   straight that counts as "sharp". 0 = smooth every interior vertex
 *   (full Chaikin); 30 = smooth only meaningful corners (default);
 *   90 = only right-angle-or-tighter bends.
 * @returns A new Float32Array; the input is not mutated. If
 *   `iterations === 0` the input is returned directly (no copy).
 */
export function chaikinSmoothPolyline(
  polyline: Float32Array,
  iterations: number,
  angleThresholdDeg: number,
): Float32Array {
  if (iterations <= 0) return polyline;
  // Convert the angle threshold to a cosine threshold once, so the
  // per-vertex test is a dot-product comparison rather than acos().
  // cosA = 1 → straight, cosA = 0 → 90° turn, cosA = -1 → hairpin.
  // We cut when cosA < cosThresh, i.e. the angular deviation
  // exceeds angleThresholdDeg.
  const cosThresh = Math.cos((angleThresholdDeg * Math.PI) / 180);

  let pts = polyline;
  for (let iter = 0; iter < iterations; iter++) {
    const nPts = pts.length / 2;
    if (nPts < 3) return pts;

    // First pass: count how many output vertices we'll produce so the
    // output buffer is sized exactly. (Avoids growing a dynamic array
    // on every iteration.)
    let outN = 2; // both endpoints
    for (let i = 1; i < nPts - 1; i++) {
      const dxIn  = pts[i * 2]     - pts[(i - 1) * 2];
      const dyIn  = pts[i * 2 + 1] - pts[(i - 1) * 2 + 1];
      const dxOut = pts[(i + 1) * 2]     - pts[i * 2];
      const dyOut = pts[(i + 1) * 2 + 1] - pts[i * 2 + 1];
      const lenIn  = Math.sqrt(dxIn  * dxIn  + dyIn  * dyIn);
      const lenOut = Math.sqrt(dxOut * dxOut + dyOut * dyOut);
      if (lenIn < 1e-12 || lenOut < 1e-12) {
        // Degenerate (duplicate vertex) — keep through, can't compute
        // an angle. Subsequent iterations may collapse it further.
        outN += 1;
        continue;
      }
      const cosA = (dxIn * dxOut + dyIn * dyOut) / (lenIn * lenOut);
      if (cosA < cosThresh) outN += 2; // sharp → cut corner with 2 new vertices
      else outN += 1;                  // gentle → pass through
    }

    // Second pass: emit.
    const out = new Float32Array(outN * 2);
    let o = 0;
    out[o++] = pts[0];
    out[o++] = pts[1];
    for (let i = 1; i < nPts - 1; i++) {
      const px = pts[i * 2];
      const py = pts[i * 2 + 1];
      const prevX = pts[(i - 1) * 2];
      const prevY = pts[(i - 1) * 2 + 1];
      const nextX = pts[(i + 1) * 2];
      const nextY = pts[(i + 1) * 2 + 1];
      const dxIn  = px - prevX;
      const dyIn  = py - prevY;
      const dxOut = nextX - px;
      const dyOut = nextY - py;
      const lenIn  = Math.sqrt(dxIn  * dxIn  + dyIn  * dyIn);
      const lenOut = Math.sqrt(dxOut * dxOut + dyOut * dyOut);
      if (lenIn < 1e-12 || lenOut < 1e-12) {
        out[o++] = px;
        out[o++] = py;
        continue;
      }
      const cosA = (dxIn * dxOut + dyIn * dyOut) / (lenIn * lenOut);
      if (cosA < cosThresh) {
        // Sharp corner: replace this vertex with two cut-corner
        // vertices. The first sits 3/4 along the incoming segment
        // (closer to this vertex), the second sits 1/4 along the
        // outgoing segment (also closer to this vertex). Equivalent
        // to the classic Chaikin pair around this vertex.
        out[o++] = prevX * 0.25 + px * 0.75;
        out[o++] = prevY * 0.25 + py * 0.75;
        out[o++] = px    * 0.75 + nextX * 0.25;
        out[o++] = py    * 0.75 + nextY * 0.25;
      } else {
        out[o++] = px;
        out[o++] = py;
      }
    }
    out[o++] = pts[(nPts - 1) * 2];
    out[o++] = pts[(nPts - 1) * 2 + 1];
    pts = out;
  }
  return pts;
}

/**
 * Default zoom → Chaikin-iterations ramp for contour line smoothing.
 * Returns 0 at low zoom (where angularity is invisible), 1 at mid
 * zoom (visible but modest), 2 at deep zoom (where the staircase
 * effect is most prominent).
 */
export function defaultSmoothIterations(mapZoom: number): number {
  if (mapZoom < 2) return 0;
  if (mapZoom < 4) return 1;
  return 2;
}
