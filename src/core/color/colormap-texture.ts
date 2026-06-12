/**
 * Upload a resolved colormap as a 256 x 1 RGBA LUT texture for sampler-based
 * lookup in the raster and streamlines shaders. Shared by the Mapbox/MapLibre
 * and Leaflet bindings (both raw WebGL2); deck.gl manages its own LUT
 * texture via luma.gl's device API.
 *
 * @param gl - The WebGL2 rendering context to use for texture creation and upload.
 * @param data Float32Array of normalised RGB values returned by `resolveColormap()`.
 * @param existing Optional existing texture to update. If provided, it is 
 * updated in-place and returned; otherwise a new texture is created and returned.
 * 
 * @returns The WebGLTexture object containing the colormap LUT. If `existing` 
 * is provided, it is updated in-place and returned; otherwise a new texture 
 * is created and returned.
 */
export function uploadColormapTexture(
  gl: WebGL2RenderingContext,
  data: Float32Array,
  existing?: WebGLTexture | null,
): WebGLTexture {
  const n = (data.length / 3) | 0;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4 + 0] = Math.round(data[i * 3 + 0] * 255);
    rgba[i * 4 + 1] = Math.round(data[i * 3 + 1] * 255);
    rgba[i * 4 + 2] = Math.round(data[i * 3 + 2] * 255);
    rgba[i * 4 + 3] = 255;
  }
  // If no texture provided, create one:
  const tex = existing ?? gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Value-encoded-tile hygiene applies here: keep the bytes verbatim.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  // LINEAR filtering interpolates between the entries, so that even a coarse 
  // customer { stops } spec renders smoothly):
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Use CLAMP_TO_EDGE so t=0 / t=1 hit the end stops exactly:
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Return texture to caller.
  return tex;
}
