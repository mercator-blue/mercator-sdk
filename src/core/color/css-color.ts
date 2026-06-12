/**
 * CSS-color to normalized RGBA parser, sized for the SDK's WebGL uniform
 * plumbing. Accepts `rgb()` / `rgba()` and 3-, 4-, 6-, or 8-digit hex
 * (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`); the 4- and 8-digit forms carry
 * alpha in the last nibble / byte.
 *
 * @param css CSS string, e.g. `#ff00ff`, `#f0f`, `#ff00ff80`, `#f0f8`,
 *            `rgba(255, 0, 255, 0.5)`, `rgb(255, 0, 255)`.
 * @returns Normalised RGBA tuple, e.g. `[1, 0, 1, 0.5]`. On parse error,
 *          returns black with full opacity: `[0, 0, 0, 1]`.
 */
export function parseCssColor(css: string): [number, number, number, number] {
  const s = css.trim();

  // rgb(...) / rgba(...)
  const m = s.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i,
  );
  if (m) {
    return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] != null ? +m[4] : 1];
  }

  // #rgb / #rgba (each nibble expanded: f -> ff). Alpha nibble optional.
  const short = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i);
  if (short) {
    return [
      parseInt(short[1], 16) / 15,
      parseInt(short[2], 16) / 15,
      parseInt(short[3], 16) / 15,
      short[4] != null ? parseInt(short[4], 16) / 15 : 1,
    ];
  }

  // #rrggbb / #rrggbbaa. Alpha byte optional.
  const long = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i);
  if (long) {
    return [
      parseInt(long[1], 16) / 255,
      parseInt(long[2], 16) / 255,
      parseInt(long[3], 16) / 255,
      long[4] != null ? parseInt(long[4], 16) / 255 : 1,
    ];
  }

  // No match
  return [0, 0, 0, 1];
}
