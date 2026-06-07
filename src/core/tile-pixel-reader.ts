/**
 * Decode a value-encoded PNG tile to raw RGBA bytes, bypassing canvas 2D's
 * alpha-premultiplication round-trip.
 *
 * Why: canvas 2D stores pixels internally as *premultiplied* alpha. Even with
 * `createImageBitmap`'s `premultiplyAlpha: 'none'`, drawing the bitmap onto a
 * canvas and reading back via `getImageData` round-trips through that
 * premultiplied representation. For pixels where the alpha byte is small —
 * common in `vector_rg_ba` because v's low byte lives in alpha — the
 * round-trip rounding corrupts R/G/B catastrophically:
 *
 *   encode (u=15, v=4)
 *     → (R=44, G=232, B=41, A=4)
 *   canvas premul:
 *     R' = round(44 · 4/255) = 2
 *     G' = round(232 · 4/255) = 4
 *     B' = round(41 · 4/255) = 1
 *   canvas un-premul on readback:
 *     R = round(2 · 255/4) ≈ 64
 *     G = round(4 · 255/4) = 255
 *     B = round(1 · 255/4) ≈ 64
 *   decode → (u ≈ 66 m/s, v ≈ 64 m/s)        ← garbage
 *
 * About 1-in-256 pixels lands with alpha ≤ ~5 — exactly the rate of
 * "anomalous-direction high-speed arrows" the user has been observing, and
 * the cause of the original particle-trail kinks (a particle passing
 * through one corrupted pixel gets kicked sideways for one frame).
 *
 * The fix: upload the PNG into a WebGL texture with
 *   UNPACK_PREMULTIPLY_ALPHA_WEBGL = false
 *   UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE
 * attach the texture as a framebuffer's color attachment, and `readPixels`
 * the bytes. WebGL paths preserve byte-for-byte fidelity.
 */

interface PixelReader {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
}

// Cached WebGL1 context — one canvas / one GL context per browsing
// session, regardless of how many tiles get decoded. The reader's GL
// state (UNPACK_PREMULTIPLY_ALPHA_WEBGL, colorspace conversion, sampler
// params) survives between calls.
let _reader: PixelReader | null = null;

function getReader(): PixelReader {
  if (_reader) return _reader;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctxOpts: WebGLContextAttributes = {
    premultipliedAlpha: false,
    alpha: true,
    preserveDrawingBuffer: false,
  };
  // `experimental-webgl` is the WebKit prefix from the WebGL1 rollout
  // era; not in lib.dom's typed overloads but still honoured by some
  // older WebKit builds. Cast lets the fallback typecheck cleanly.
  const gl =
    canvas.getContext('webgl', ctxOpts) ||
    (canvas.getContext('experimental-webgl', ctxOpts) as WebGLRenderingContext | null);
  if (!gl) throw new Error('@mercator-blue/sdk: tile-pixel-reader — WebGL not available');
  _reader = { canvas, gl };
  return _reader;
}

export interface TilePixels {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Fetch a PNG and return its raw RGBA bytes. */
export async function loadTilePixels(url: string): Promise<TilePixels> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`@mercator-blue/sdk: tile-pixel-reader — HTTP ${resp.status} fetching ${url}`);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const W = bitmap.width;
  const H = bitmap.height;

  const { gl } = getReader();
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    if (typeof bitmap.close === 'function') bitmap.close();
    throw new Error(`@mercator-blue/sdk: tile-pixel-reader — framebuffer incomplete (0x${status.toString(16)})`);
  }

  const pixels = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  if (typeof bitmap.close === 'function') bitmap.close();

  return { width: W, height: H, pixels };
}
