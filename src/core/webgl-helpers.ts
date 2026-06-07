/**
 * Generic WebGL2 shader-compile + program-link helpers. Host-agnostic —
 * used by every binding (Mapbox/MapLibre, Leaflet, OpenLayers, deck.gl
 * custom raw-GL paths). Mapbox/MapLibre custom layers compose this with
 * a projection-prelude prepender (`mapbox/*-layer.ts`'s local
 * `buildProgram`), so this layer doesn't know about preludes.
 */

export function compileShader(
  gl: WebGL2RenderingContext,
  /** Shader type (gl.VERTEX_SHADER or gl.FRAGMENT_SHADER) */
  type: GLenum,
  /** Shader source */
  src: string,
): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('@mercator-blue/sdk: gl.createShader returned null');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    const which = type === gl.VERTEX_SHADER ? 'vs' : 'fs';
    throw new Error(`@mercator-blue/sdk: WebGL shader compile error (${which}): ${log}`);
  }
  return s;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  /** vertex shader */
  vs: string,
  /** fragment shader */
  fs: string,
): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('@mercator-blue/sdk: gl.createProgram returned null');
  const vsh = compileShader(gl, gl.VERTEX_SHADER, vs);
  const fsh = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, vsh);
  gl.attachShader(p, fsh);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('@mercator-blue/sdk: WebGL program link error: ' + log);
  }
  // Attached shaders are flagged for deletion when the program is
  // deleted, but freeing the source strings early is cheap and harmless.
  gl.deleteShader(vsh);
  gl.deleteShader(fsh);
  return p;
}
