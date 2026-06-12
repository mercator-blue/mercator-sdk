/**
 * Quick CSS-color → normalized RGBA parser, sized for the SDK's
 * WebGL uniform plumbing.
 *
 * Returns `[r, g, b, a]` in [0, 1] - ready to feed `gl.uniform4f` for
 * line/label colours.
 *
 * Accepts:
 *   - `#rrggbb` and `#rgb` hex notations
 *   - `rgb(r, g, b)` and `rgba(r, g, b, a)` function notations
 *
 * Anything else returns opaque black. This is a tight, performance-
 * minded parser for the SDK's own use; customers driving the bindings
 * pass simple values (the test pages, defaults from STAC). For style-
 * spec-grade parsing the host map library is authoritative - Mapbox
 * /MapLibre style-spec colours don't flow through here.
 */
export function parseCssColor(css: string): [number, number, number, number] {
  const m = css.trim().match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i,
  );
  if (m) {
    return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] != null ? +m[4] : 1];
  }
  if (/^#[0-9a-f]{6}$/i.test(css)) {
    return [
      parseInt(css.slice(1, 3), 16) / 255,
      parseInt(css.slice(3, 5), 16) / 255,
      parseInt(css.slice(5, 7), 16) / 255,
      1,
    ];
  }
  if (/^#[0-9a-f]{3}$/i.test(css)) {
    return [
      parseInt(css[1], 16) / 15,
      parseInt(css[2], 16) / 15,
      parseInt(css[3], 16) / 15,
      1,
    ];
  }
  return [0, 0, 0, 1];
}
