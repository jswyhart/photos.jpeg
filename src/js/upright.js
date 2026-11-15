/* =====================================================================
 * photos.jpeg — Auto upright: straighten converging verticals.
 *
 * Photographing a building with the camera tilted up makes its vertical
 * lines lean towards each other. This finds the near-vertical straight
 * edges in the photo, works out where they would meet, and returns the
 * Transform settings (Vertical, Rotate, Scale) that make them parallel
 * and upright.
 *
 * How: edge pixels whose direction is within ±20° of vertical vote for
 * lines (a Hough transform over position and tilt). For lines that meet
 * in one point, tilt is a linear function of position; fitting that line
 * gives the convergence (→ Vertical) and the common lean (→ Rotate).
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline;
  const KV = 0.4;                 // pipeline: kv = transform.vertical / 100 × 0.4
  const MAX_TILT = 0.36;          // tan(20°)
  const NS = 73;                  // tilt steps

  /** Near-vertical lines in an RGBA image: [{ x0 (at the middle row, from the centre), s (dx/dy), votes }]. */
  function findVerticals(img) {
    const w = img.width, h = img.height, d = img.data;
    const g = new Float32Array(w * h);
    for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    const acc = new Float32Array(w * NS);
    const cy = (h - 1) / 2;
    let strong = 0;
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        const gx = (g[i + 1 - w] + 2 * g[i + 1] + g[i + 1 + w]) - (g[i - 1 - w] + 2 * g[i - 1] + g[i - 1 + w]);
        const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
        const mag = Math.abs(gx) + Math.abs(gy);
        if (mag < 90 || Math.abs(gy) > Math.abs(gx) * 0.45) continue;      // weak, or not a near-vertical edge
        strong++;
        // the edge runs perpendicular to its gradient: its tilt dx/dy is −gy/gx; vote around that tilt only
        const s0 = -gy / gx, k0 = Math.round((s0 + MAX_TILT) / (2 * MAX_TILT) * (NS - 1));
        for (let k = Math.max(0, k0 - 4); k <= Math.min(NS - 1, k0 + 4); k++) {
          const s = -MAX_TILT + k * (2 * MAX_TILT) / (NS - 1);
          const x0 = Math.round(x - s * (y - cy));
          if (x0 >= 0 && x0 < w) acc[k * w + x0] += 1;
        }
      }
    }
    // peaks: lines supported along at least a quarter of the height
    const lines = [], need = h * 0.25;
    const taken = new Uint8Array(w * NS);
    for (let n = 0; n < 40; n++) {
      let best = 0, bi = -1;
      for (let i = 0; i < acc.length; i++) if (!taken[i] && acc[i] > best) { best = acc[i]; bi = i; }
      if (bi < 0 || best < need) break;
      const k = (bi / w) | 0, x0 = bi % w;
      // sub-bin tilt from the neighbours
      const up = k + 1 < NS ? acc[(k + 1) * w + x0] : 0, dn = k > 0 ? acc[(k - 1) * w + x0] : 0;
      const den = dn - 2 * best + up, off = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (dn - up) / den)) : 0;
      lines.push({ x0: x0 - (w - 1) / 2, s: -MAX_TILT + (k + off) * (2 * MAX_TILT) / (NS - 1), votes: best });
      for (let dk = -6; dk <= 6; dk++) for (let dx = -7; dx <= 7; dx++) { const kk = k + dk, xx = x0 + dx; if (kk >= 0 && kk < NS && xx >= 0 && xx < w) taken[kk * w + xx] = 1; }
    }
    return { lines, strong, w, h };
  }

  /** Tilt as a function of position, s = a·x0 + b, fitted robustly. Returns { a, b, n, spread } or null. */
  function fitConvergence(lines, w) {
    let use = lines.slice(), fit = null;
    for (let round = 0; round < 4; round++) {
      if (use.length < 4) return null;
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const l of use) { const q = l.votes; sw += q; sx += q * l.x0; sy += q * l.s; sxx += q * l.x0 * l.x0; sxy += q * l.x0 * l.s; }
      const den = sw * sxx - sx * sx;
      if (Math.abs(den) < 1e-9) return null;
      const a = (sw * sxy - sx * sy) / den, b = (sy - a * sx) / sw;
      const res = use.map(l => Math.abs(l.s - (a * l.x0 + b)));
      const med = res.slice().sort((p, q) => p - q)[res.length >> 1];
      const xs = use.map(l => l.x0);
      fit = { a, b, n: use.length, spread: (Math.max(...xs) - Math.min(...xs)) / w, rms: Math.sqrt(res.reduce((t, r) => t + r * r, 0) / res.length) };
      const kept = use.filter((l, i) => res[i] <= Math.max(0.012, med * 2.5));
      if (kept.length === use.length) break;
      use = kept;
    }
    return fit;
  }

  /** Smallest Transform → Scale (%) at which the transformed photo has no empty corners. */
  function fillScale(settings, W, H) {
    const s = P.clone(settings);
    const inside = (scale) => {
      s.transform.scale = scale;
      const geo = P.buildGeometry(P.normalizeSettings(s), W, H), p = [0, 0];
      for (let i = 0; i <= 20; i++) {
        const u = i / 20;
        for (const [x, y] of [[u * geo.outW, 0.5], [u * geo.outW, geo.outH - 0.5], [0.5, u * geo.outH], [geo.outW - 0.5, u * geo.outH]]) {
          geo.toSource(x, y, p);
          if (p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H) return false;
        }
      }
      return true;
    };
    if (inside(100)) return 100;
    let lo = 100, hi = 150;
    if (!inside(hi)) return hi;
    for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (inside(m)) hi = m; else lo = m; }
    return Math.ceil(hi * 10) / 10;
  }

  /**
   * Measure a photo. Resolves to { vertical, rotate, scale, lines } (Transform slider values to set),
   * or rejects with the reason nothing could be measured.
   */
  async function measure(photo) {
    // the photo as it is before any transform: lens corrections stay, since the transform works on the corrected image
    const s = P.clone(photo.settings), def = P.defaultSettings();
    s.transform = def.transform; s.geo.angle = 0; s.geo.crop = { x: 0, y: 0, w: 1, h: 1 }; s.masks = []; s.spots = [];
    const res = await PJ.Engine.render(photo, s, 'draft', {}, 0);
    if (!res) throw new Error('The photo could not be rendered');
    const found = findVerticals(res);
    const fit = fitConvergence(found.lines, found.w);
    if (!fit || fit.n < 4 || fit.spread < 0.3) throw new Error('Not enough straight vertical lines across the photo to work out the perspective');
    const half = Math.max(found.w, found.h) / 2;
    // tilt grows by a per pixel of position: the lines meet 1/a from the centre. The pipeline's Vertical
    // spreads the picture by (1 + kv·y / half) across, which adds −kv / half to that growth: cancel it.
    let vertical = Math.round(fit.a * half / KV * 100);
    let rotate = Math.round(Math.atan(fit.b) * 180 / Math.PI * 10) / 10;
    if (Math.abs(vertical) > 100 || Math.abs(rotate) > 10) throw new Error('The lines in this photo lean too far to straighten automatically');
    if (Math.abs(vertical) < 2) vertical = 0;
    if (Math.abs(rotate) < 0.2) rotate = 0;
    return { vertical, rotate, lines: fit.n, detail: fit };
  }

  /** Put a measurement into a photo's settings (not committed). */
  function applyTo(photo, m) {
    const t = photo.settings.transform;
    t.vertical = m.vertical; t.rotate = m.rotate; t.scale = 100;
    const src = PJ.Engine.cachedSource(photo);
    const W = src ? src.fullW : photo.width, H = src ? src.fullH : photo.height;
    if (W && H) t.scale = fillScale(photo.settings, W, H);
  }

  global.PJ.Upright = { measure, applyTo, fillScale, _test: { findVerticals, fitConvergence } };
})(window);
