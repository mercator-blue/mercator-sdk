/**
 * Generic WebGL2 shader-compile + program-link helpers. Used by every 
 * binding (Mapbox/MapLibre, Leaflet, OpenLayers, deck.gl custom raw-GL paths). 
 * Mapbox/MapLibre custom layers compose this with
 * a projection-prelude prepender (`mapbox/*-layer.ts`'s local
 * `buildProgram`), so this layer doesn't know about preludes.
 */

/**
 * @param gl WebGL2 rendering context to compile the shader in.
 * @param type Shader type (gl.VERTEX_SHADER or gl.FRAGMENT_SHADER)
 * @param src Shader source
 * @returns Compiled WebGLShader object.
 * @error Throws an error if shader compilation fails, with the shader info log included in the message.
 */
export function compileShader(gl: WebGL2RenderingContext, type: GLenum, src: string): WebGLShader {
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

/**
 * Creates a WebGL program by compiling and linking vertex and fragment shaders.
 * @param gl WebGL2 rendering context.
 * @param vs Vertex shader source.
 * @param fs Fragment shader source.
 * @error Throws an error if shader compilation or program linking fails, with the info log included in the message.
 * @returns Compiled WebGLProgram object.
 */
export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
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
  gl.deleteShader(vsh);
  gl.deleteShader(fsh);
  return p;
}
