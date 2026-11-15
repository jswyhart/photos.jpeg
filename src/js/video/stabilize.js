/* =====================================================================
 * photos.jpeg — video stabilization.
 *
 * Analysis (once per clip): every frame is reduced to a small grey image; textured blocks are
 * matched between consecutive frames (coarse-to-fine SAD search, sub-pixel refinement) and a
 * similarity transform (shift, rotation, zoom) is fitted robustly. The accumulated camera path
 * is stored with the clip (photo.video.stab).
 *
 * Rendering: the path is smoothed (Gaussian, strength = settings.stab.amount) and each frame gets
 * the difference as an extra transform (offset / rotate / scale, plus a fixed zoom that hides
 * the moving borders). It rides on the normal Transform controls, so CPU, GPU, playback and
 * export all stabilize identically.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, V = PJ.Video;
  const AW = 480;            // analysis width (px)

  /* ---------------- motion estimation ---------------- */
  function grey(image, w, h, canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return g;
  }
  function half(g, w, h) {
    const w2 = w >> 1, h2 = h >> 1, o = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const i = (y * 2) * w + x * 2;
      o[y * w2 + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1] + 2) >> 2;
    }
    return o;
  }
  function sad(a, b, w, ax, ay, bx, by, n, best) {
    let s = 0;
    for (let y = 0; y < n; y++) {
      let ia = (ay + y) * w + ax, ib = (by + y) * w + bx;
      for (let x = 0; x < n; x++) { const d = a[ia++] - b[ib++]; s += d < 0 ? -d : d; }
      if (s >= best) return s;
    }
    return s;
  }
  function ssd(a, b, w, ax, ay, bx, by, n) {
    let s = 0;
    for (let y = 0; y < n; y++) {
      let ia = (ay + y) * w + ax, ib = (by + y) * w + bx;
      for (let x = 0; x < n; x++) { const d = a[ia++] - b[ib++]; s += d * d; }
    }
    return s;
  }
  /** Block motion between two grey frames → [{x, y, dx, dy}] in level-0 px (block centres). */
  function blockMotion(prev, cur, w, h, prevH, curH) {
    const w2 = w >> 1, h2 = h >> 1;
    const B = 16, B2 = 8, R2 = 18, R0 = 2;
    const out = [];
    const nx = 12, ny = 8;
    const mx = R2 * 2 + B + 2, my = R2 * 2 + B + 2;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const cx = Math.round(mx + (w - 2 * mx) * (i + 0.5) / nx), cy = Math.round(my + (h - 2 * my) * (j + 0.5) / ny);
      const x0 = cx - B / 2, y0 = cy - B / 2;
      // texture check: skip flat blocks (sky, walls) that would match anywhere
      let sum = 0, sum2 = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const v = prev[(y0 + y) * w + x0 + x]; sum += v; sum2 += v * v; }
      const varc = sum2 / (B * B) - (sum / (B * B)) ** 2;
      if (varc < 30) continue;
      // coarse search at half resolution
      const hx = x0 >> 1, hy = y0 >> 1;
      let best = Infinity, bx = 0, by = 0;
      for (let dy = -R2; dy <= R2; dy++) {
        const yy = hy + dy; if (yy < 0 || yy + B2 > h2) continue;
        for (let dx = -R2; dx <= R2; dx++) {
          const xx = hx + dx; if (xx < 0 || xx + B2 > w2) continue;
          const s = sad(prevH, curH, w2, hx, hy, xx, yy, B2, best);
          if (s < best) { best = s; bx = dx; by = dy; }
        }
      }
      // refine at full resolution
      let best0 = Infinity, fx = bx * 2, fy = by * 2;
      const sads = new Map();
      for (let dy = -R0; dy <= R0; dy++) for (let dx = -R0; dx <= R0; dx++) {
        const X = x0 + bx * 2 + dx, Y = y0 + by * 2 + dy;
        if (X < 0 || Y < 0 || X + B > w || Y + B > h) continue;
        const s = ssd(prev, cur, w, x0, y0, X, Y, B);
        sads.set(dx + ',' + dy, s);
        if (s < best0) { best0 = s; fx = bx * 2 + dx; fy = by * 2 + dy; }
      }
      // sub-pixel: parabola through the neighbours
      const ox = fx - bx * 2, oy = fy - by * 2;
      const sp = (a, c, b) => { const d = a - 2 * c + b; return d > 0 ? Math.max(-0.5, Math.min(0.5, (a - b) / (2 * d))) : 0; };
      const l = sads.get((ox - 1) + ',' + oy), r = sads.get((ox + 1) + ',' + oy), u = sads.get(ox + ',' + (oy - 1)), dn = sads.get(ox + ',' + (oy + 1));
      const sx = l !== undefined && r !== undefined ? sp(l, best0, r) : 0, sy = u !== undefined && dn !== undefined ? sp(u, best0, dn) : 0;
      // reject ambiguous matches (repeating texture): the best must clearly beat the mean
      if (best0 > B * B * 1600) continue;
      out.push({ x: cx - w / 2, y: cy - h / 2, dx: fx + sx, dy: fy + sy });
    }
    return out;
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  /** Robust similarity fit: p' = [a −b; b a]·p + t. Returns {dx, dy, da, ds} or null. */
  function fitSimilarity(v) {
    let pts = v.slice();
    let res = null;
    for (let iter = 0; iter < 3 && pts.length >= 3; iter++) {
      // normal equations for [a, b, tx, ty]
      let Sxx = 0, Sx = 0, Sy = 0, n = 0, Sa = 0, Sb = 0, Stx = 0, Sty = 0;
      for (const p of pts) {
        const X = p.x, Y = p.y, U = p.x + p.dx, W = p.y + p.dy;
        Sxx += X * X + Y * Y; Sx += X; Sy += Y; n++;
        Sa += X * U + Y * W; Sb += X * W - Y * U; Stx += U; Sty += W;
      }
      const det = Sxx * n - Sx * Sx - Sy * Sy;
      if (Math.abs(det) < 1e-9) return null;
      // solve the 4×4 system (structured): see similarity least squares
      const a = (n * Sa - Sx * Stx - Sy * Sty) / det;
      const b = (n * Sb + Sy * Stx - Sx * Sty) / det;
      const tx = (Stx - a * Sx + b * Sy) / n, ty = (Sty - b * Sx - a * Sy) / n;
      res = { a, b, tx, ty };
      const r = pts.map(p => Math.hypot(a * p.x - b * p.y + tx - (p.x + p.dx), b * p.x + a * p.y + ty - (p.y + p.dy)));
      const med = r.slice().sort((x, y) => x - y)[r.length >> 1];
      const lim = Math.max(0.8, med * 2.5);
      const keep = pts.filter((_, i) => r[i] <= lim);
      if (keep.length === pts.length) break;
      pts = keep;
    }
    if (!res) return null;
    // Only trust rotation/zoom when it explains the vectors clearly better than a pure shift
    // (blocks bunched in one band make the angle ill-conditioned and noisy).
    const tx0 = med(pts.map(p => p.dx)), ty0 = med(pts.map(p => p.dy));
    const rmsT = Math.sqrt(pts.reduce((a, p) => a + (p.dx - tx0) ** 2 + (p.dy - ty0) ** 2, 0) / pts.length);
    const rmsS = Math.sqrt(pts.reduce((a, p) => a + (res.a * p.x - res.b * p.y + res.tx - p.x - p.dx) ** 2 + (res.b * p.x + res.a * p.y + res.ty - p.y - p.dy) ** 2, 0) / pts.length);
    let spread = 0; for (const p of pts) spread = Math.max(spread, Math.hypot(p.x, p.y));
    if (pts.length < 6 || spread < 40 || rmsS > rmsT * 0.8) return { dx: tx0, dy: ty0, da: 0, ds: 0 };
    return { dx: res.tx, dy: res.ty, da: Math.atan2(res.b, res.a), ds: Math.log(Math.hypot(res.a, res.b)) };
  }

  /**
   * Analyse the whole clip. Stores photo.video.stab = { aw, fps, n, x[], y[], a[], s[] } — the
   * cumulative camera path per frame (x, y in units of the analysis width; a radians; s log-zoom).
   */
  async function analyze(photo, onProgress, signal) {
    const clip = V.clipFor(photo);
    await clip.open();
    const fps = clip.fps || 30, dur = clip.duration;
    const total = Math.max(1, Math.round(dur * fps));
    const canvas = PJ.Decode.makeCanvas(AW, 2);
    let w = AW, h = 0, prev = null, prevH = null;
    const path = { x: [0], y: [0], a: [0], s: [0] };
    let X = 0, Y = 0, A = 0, S = 0, n = 0, lost = 0;
    for await (const fr of PJ.VExport.frames(photo, clip, 0, dur, signal)) {
      try {
        if (!h) {
          const iw = fr.image.displayWidth || fr.image.videoWidth || fr.image.width, ih = fr.image.displayHeight || fr.image.videoHeight || fr.image.height;
          h = Math.max(32, Math.round(AW * ih / iw)) & ~1; canvas.width = w; canvas.height = h;
        }
        const g = grey(fr.image, w, h, canvas), gH = half(g, w, h);
        if (prev) {
          const m = fitSimilarity(blockMotion(prev, g, w, h, prevH, gH));
          if (m && Math.abs(m.da) < 0.2 && Math.abs(m.ds) < 0.2) { X += m.dx; Y += m.dy; A += m.da; S += m.ds; }
          else lost++; // no reliable motion (cut, blur, flat frame): hold the path
          path.x.push(X / w); path.y.push(Y / w); path.a.push(A); path.s.push(S);
        }
        prev = g; prevH = gH; n++;
      } finally { fr.close(); }
      if (onProgress && n % 5 === 0) onProgress(Math.min(1, n / total), `Analysing motion… ${n} / ${total}`);
      if (signal && signal.cancelled) throw new Error('cancelled');
    }
    if (n < 2) throw new Error('Not enough frames to analyse');
    const r4 = (v) => Math.round(v * 1e5) / 1e5;
    photo.video.stab = { v: 1, aw: w, fps, n, lost, x: path.x.map(r4), y: path.y.map(r4), a: path.a.map(r4), s: path.s.map(r4), at: Date.now() };
    cache.delete(photo.id);
    PJ.Catalog.scheduleSave();
    return photo.video.stab;
  }

  /* ---------------- applying ---------------- */
  const cache = new Map(); // photo.id -> { key, cx[], cy[], ca[], cs[], zoom }
  function gaussSmooth(arr, sigma) {
    if (sigma < 0.5) return arr.slice();
    const r = Math.ceil(sigma * 3), k = [];
    let ks = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); ks += v; }
    const n = arr.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) {
        let q = i + j;
        if (q < 0) q = -q; if (q >= n) q = 2 * n - 2 - q; // reflect at the ends
        q = Math.max(0, Math.min(n - 1, q));
        s += arr[q] * k[j + r];
      }
      out[i] = s / ks;
    }
    return out;
  }
  /** Per-frame corrections for a smoothness 1…100, plus the zoom that keeps borders out of frame. */
  function corrections(photo, amount, aspect) {
    const st = photo.video && photo.video.stab;
    if (!st) return null;
    const key = `${st.at}|${amount}|${aspect.toFixed(3)}`;
    let c = cache.get(photo.id);
    if (c && c.key === key) return c;
    const sigma = (0.15 + Math.pow(amount / 100, 1.5) * 2.5) * st.fps; // up to ~2.6 s of smoothing
    const sm = (a) => gaussSmooth(a, sigma);
    const sx = sm(st.x), sy = sm(st.y), sa = sm(st.a), ss = sm(st.s);
    c = { key, cx: [], cy: [], ca: [], cs: [], zoom: 1 };
    let need = 1;
    const hw = 0.5, hh = 0.5 / aspect; // half-size of the frame in width units
    for (let i = 0; i < st.x.length; i++) {
      const dx = st.x[i] - sx[i], dy = st.y[i] - sy[i], da = st.a[i] - sa[i], ds = st.s[i] - ss[i];
      c.cx.push(dx); c.cy.push(dy); c.ca.push(da); c.cs.push(ds);
      // zoom needed so the shifted/rotated/scaled frame still covers the output
      const cos = Math.abs(Math.cos(da)), sin = Math.abs(Math.sin(da));
      const zx = (hw * cos + hh * sin + Math.abs(dx)) / hw, zy = (hw * sin + hh * cos + Math.abs(dy)) / hh;
      need = Math.max(need, Math.max(zx, zy) * Math.exp(-ds));
    }
    c.zoom = Math.min(1.35, need);
    cache.set(photo.id, c);
    return c;
  }

  const active = (photo, s) => !!(photo && photo.kind === 'video' && photo.video && photo.video.stab && s && s.stab && s.stab.amount > 0);

  /**
   * Settings for the frame at time t with the stabilizing transform added. Returns `s` unchanged
   * when the clip isn't stabilized.
   */
  function apply(photo, s, t) {
    if (!active(photo, s)) return s;
    const st = photo.video.stab;
    const srcW = photo.video.width || 1920, srcH = photo.video.height || 1080;
    const c = corrections(photo, s.stab.amount, srcW / srcH);
    if (!c) return s;
    const f = Math.max(0, Math.min(c.cx.length - 1, Math.round(t * st.fps)));
    // the shift in source pixels, mapped into the oriented frame the Transform controls work in
    let dsx = c.cx[f] * srcW, dsy = c.cy[f] * srcW;
    const g = s.geo || {}, o = g.orient || 0;
    let qx, qy;
    if (o === 90) { qx = -dsy; qy = dsx; } else if (o === 180) { qx = -dsx; qy = -dsy; } else if (o === 270) { qx = dsy; qy = -dsx; } else { qx = dsx; qy = dsy; }
    if (g.flipH) qx = -qx; if (g.flipV) qy = -qy;
    const flipSign = (g.flipH ? -1 : 1) * (g.flipV ? -1 : 1);
    const Wo = o % 180 ? srcH : srcW, Ho = o % 180 ? srcW : srcH;
    const out = Object.assign({}, s, { transform: Object.assign({}, s.transform) });
    const tr = out.transform;
    tr.offX = (tr.offX || 0) - qx / (Wo * 0.5) * 100;
    tr.offY = (tr.offY || 0) - qy / (Ho * 0.5) * 100;
    tr.rotate = (tr.rotate || 0) - flipSign * c.ca[f] * 180 / Math.PI;
    tr.scale = (tr.scale || 100) * c.zoom * Math.exp(-c.cs[f]);
    return out;
  }

  global.PJ.Stabilize = { analyze, apply, active, corrections, _t: { blockMotion, fitSimilarity, half, gaussSmooth } };
})(window);
