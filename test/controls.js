// Shared control-panel builder for the SDK smoke-test pages
// (maplibre / mapbox / deck-gl / leaflet). Each page declares which
// control GROUPS it wants; this module renders their markup into the
// page's #controls container, builds the palette dropdown, and wires
// the slider value-readouts. BEHAVIOR (change/input handlers) stays in
// each page since it calls host-specific layer glue — only the markup +
// generic wiring is shared.
//
// Standard control IDs (use these in page handlers):
//   raster:    show-raster, palette, opacity, smooth (optional)
//   particles: show-particles, count, size, speed, age, fade, cbs
//   arrows:    show-arrows
//   values:    show-values
//   contours:  show-contours, interval
//   bounds:    show-bounds
//
// Capability hints: pass a group's `hint` (and raster `paletteHint`) to
// render a hidden <small id="{id}-hint">; the page toggles its display
// per dataset (deck-gl does this).

function hint(id, text) {
  return text
    ? `<small id="${id}-hint" style="display:none; color:#666;">${text}</small>`
    : '';
}

const GROUPS = {
  raster(opts = {}) {
    return `
      <h2>Raster (colormapped overlay)</h2>
      <div class="row">
        <label class="cb"><input id="show-raster" type="checkbox" /> Show color overlay</label>
        ${hint('raster', opts.hint)}
      </div>
      <div class="row sub">
        <label><small>Palette</small></label>
        <select id="palette"></select>
        ${hint('palette', opts.paletteHint)}
      </div>
      <div class="row sub">
        <label>Opacity <span class="val" id="opacity-val">0.75</span>
          <input id="opacity" type="range" min="0" max="100" step="1" value="75" />
        </label>
      </div>
      ${opts.smooth ? `
      <div class="row sub">
        <label class="cb"><input id="smooth" type="checkbox" checked /> Smooth (bilinear)</label>
      </div>` : ''}`;
  },

  particles(opts = {}) {
    const count = opts.count ?? 8000;
    return `
      <h2>Particles (streamlines)</h2>
      <div class="row">
        <label class="cb"><input id="show-particles" type="checkbox" /> Show particles</label>
        ${hint('particles', opts.hint)}
      </div>
      <div class="row sub">
        <label>Count <span class="val" id="count-val">${count}</span>
          <input id="count" type="range" min="100" max="20000" step="100" value="${count}" />
        </label>
      </div>
      <div class="row sub">
        <label>Point size (px) <span class="val" id="size-val">3</span>
          <input id="size" type="range" min="1" max="10" step="1" value="3" />
        </label>
      </div>
      <div class="row sub">
        <label>Speed ×base <span class="val" id="speed-val">1.00</span>
          <input id="speed" type="range" min="0.25" max="3" step="0.05" value="1" />
        </label>
      </div>
      <div class="row sub">
        <label>Max age (s) <span class="val" id="age-val">10</span>
          <input id="age" type="range" min="1" max="30" step="1" value="10" />
        </label>
      </div>
      <div class="row sub">
        <label>Trail fade <span class="val" id="fade-val">0.99</span>
          <input id="fade" type="range" min="85" max="99" step="1" value="99" />
        </label>
      </div>
      <div class="row sub">
        <label class="cb"><input id="cbs" type="checkbox" /> Color particles by speed</label>
      </div>`;
  },

  arrows(opts = {}) {
    return `
      <h2>Arrows (vector field)</h2>
      <div class="row">
        <label class="cb"><input id="show-arrows" type="checkbox" /> Direction arrows</label>
        ${hint('arrows', opts.hint)}
      </div>`;
  },

  values(opts = {}) {
    return `
      <h2>Value labels (numbers)</h2>
      <div class="row">
        <label class="cb"><input id="show-values" type="checkbox" /> Show value labels</label>
        ${hint('values', opts.hint)}
      </div>`;
  },

  contours(opts = {}) {
    return `
      <h2>Contours (scalar only)</h2>
      <div class="row">
        <label class="cb"><input id="show-contours" type="checkbox" /> Show contours</label>
        ${hint('contours', opts.hint)}
      </div>
      <div class="row sub">
        <label>Interval <span class="val" id="interval-val">—</span>
          <input id="interval" type="range" min="0" max="0" step="1" value="0" disabled />
        </label>
      </div>`;
  },

  bounds() {
    return `
      <h2>Debug</h2>
      <div class="row">
        <label class="cb"><input id="show-bounds" type="checkbox" /> Tile boundaries</label>
      </div>`;
  },
};

// Slider value-readout formatters keyed by control id. The module wires
// these on `input` so the page only needs to attach behavior handlers.
const FORMATS = {
  opacity: (v) => ((+v) / 100).toFixed(2),
  count: (v) => v,
  size: (v) => v,
  speed: (v) => (+v).toFixed(2),
  age: (v) => v,
  fade: (v) => ((+v) / 100).toFixed(2),
};

/**
 * Mount a fixed top-right FPS / frame-time overlay and start a rAF loop that
 * measures the browser's animation cadence. Shows rolling-average fps, the
 * average frame interval in ms, and the worst (max) interval in the window so
 * jank shows up even when the average is pinned at the display refresh rate.
 * Idempotent: a second call is a no-op. Returns the overlay element.
 */
export function mountFps() {
  const EXISTING = document.getElementById('fps-meter');
  if (EXISTING) return EXISTING;

  const el = document.createElement('div');
  el.id = 'fps-meter';
  el.style.cssText = [
    'position:fixed', 'z-index:9999',
    'font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'background:rgba(0,0,0,0.65)', 'color:#fff', 'padding:6px 10px',
    'border-radius:6px', 'pointer-events:none', 'white-space:pre',
  ].join(';');
  el.textContent = '— fps';
  document.body.appendChild(el);

  // Sit beside the page's #zoom-readout (top-right) rather than over it.
  // Tops aligned; the fps meter is parked to the left of the zoom chip with
  // a small gap. `place()` is re-run each paint because the zoom text width
  // shifts a little (e.g. "z 1.50" vs "z 12.34"). Falls back to a plain
  // top-right corner when no zoom readout exists.
  const zoom = document.getElementById('zoom-readout');
  const place = () => {
    if (zoom) {
      const cs = getComputedStyle(zoom);
      const right = parseFloat(cs.right) || 12;
      el.style.top = cs.top || '12px';
      el.style.right = `${right + zoom.offsetWidth + 8}px`;
    } else {
      el.style.top = '12px';
      el.style.right = '12px';
    }
  };
  place();

  const WINDOW = 60;        // samples kept for the rolling stats
  const deltas = [];
  let prev = null;
  let lastPaint = 0;        // throttle DOM writes to ~4 Hz

  const frame = (t) => {
    if (prev !== null) {
      const dt = t - prev;
      deltas.push(dt);
      if (deltas.length > WINDOW) deltas.shift();
      if (t - lastPaint > 250 && deltas.length) {
        lastPaint = t;
        let sum = 0, max = 0;
        for (const d of deltas) { sum += d; if (d > max) max = d; }
        const avg = sum / deltas.length;
        const fps = avg > 0 ? 1000 / avg : 0;
        el.textContent = `${fps.toFixed(0)} fps  ${avg.toFixed(1)} ms (max ${max.toFixed(1)})`;
        place();
      }
    }
    prev = t;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return el;
}

/**
 * Render the requested control groups into `spec.container`, build the
 * palette dropdown from `spec.palettes`, and wire slider value-readouts.
 *
 * @param {{
 *   container: HTMLElement,
 *   groups: Array<'raster'|'particles'|'arrows'|'values'|'contours'|'bounds'>,
 *   palettes?: Record<string, unknown>,
 *   raster?: { smooth?: boolean, hint?: string, paletteHint?: string },
 *   particles?: { count?: number, hint?: string },
 *   arrows?: { hint?: string },
 *   contours?: { hint?: string },
 * }} spec
 */
export function mountControls(spec) {
  const { container, groups, palettes } = spec;
  container.innerHTML = groups
    .map((g) => {
      const fn = GROUPS[g];
      if (!fn) throw new Error(`mountControls: unknown group "${g}"`);
      return fn(spec[g] || {});
    })
    .join('\n');

  // Palette dropdown.
  const sel = container.querySelector('#palette');
  if (sel && palettes) {
    for (const name of Object.keys(palettes)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    sel.value = 'viridis';
  }

  // Auto-wire slider value-readouts for whichever sliders are present.
  for (const [id, fmt] of Object.entries(FORMATS)) {
    const el = container.querySelector(`#${id}`);
    const out = container.querySelector(`#${id}-val`);
    if (el && out) {
      el.addEventListener('input', () => { out.textContent = fmt(el.value); });
    }
  }

  // Shared FPS / frame-time overlay (top-right). Idempotent.
  mountFps();
}
