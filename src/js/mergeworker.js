/* =====================================================================
 * photos.jpeg — merging several photos into one, in a thread of its own.
 *
 * HDR:      photos of one scene at different exposures are lined up
 *           (shifts only) and fused: every part of the picture is taken
 *           mostly from the exposure that shows it best — Mertens, Kautz
 *           and Van Reeth's exposure fusion, blended across scales so no
 *           seams show. The result is an ordinary, natural-looking image
 *           with detail in both the highlights and the shadows.
 * Panorama: overlapping photos are matched by their corners (Harris
 *           corners, patch descriptors, RANSAC), placed on a cylinder
 *           when the focal length is known, evened out in brightness and
 *           feathered together.
 *
 * Focus stack: photos of one scene focused at different distances are
 *           lined up (focusing changes the picture's size a little) and
 *           every detail, at every scale, is taken from the photo that
 *           shows it sharpest — so the result is sharp from front to back.
 *
 * in:  { op: 'reset' } · { op: 'image', w, h, rgb: Uint8Array(w·h·3) }
 *      { op: 'hdr', id } · { op: 'pano', id, focal: [pixels at full size, or 0], maxPixels } · { op: 'stack', id }
 * out: { id, progress, text } while working, then
 *      { id, w, h, rgb16: Uint16Array(w·h·3), stats } or { id, error }
 * ===================================================================== */
'use strict';
let imgs = [];
const tell = (m) => { if (typeof self !== 'undefined' && typeof self.postMessage === 'function') self.postMessage(m); };

/* ---------------- shared helpers ---------------- */
/** Brightness (0…255) of an image shrunk by whole-pixel averaging so its long edge is at most `edge`. */
function small(img, edge) {
  const step = Math.max(1, Math.ceil(Math.max(img.w, img.h) / edge)), w = Math.floor(img.w / step), h = Math.floor(img.h / step), d = new Float32Array(w * h), s = img.rgb;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let dy = 0; dy < step; dy++) { let i = ((y * step + dy) * img.w + x * step) * 3; for (let dx = 0; dx < step; dx++, i += 3) a += s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114; }
    d[y * w + x] = a / (step * step);
  }
  return { w, h, d, step };
}
function blur5(src, w, h) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { const r = y * w; for (let x = 0; x < w; x++) { const a = x > 1 ? x - 2 : 0, b = x > 0 ? x - 1 : 0, c = x < w - 1 ? x + 1 : w - 1, e = x < w - 2 ? x + 2 : w - 1; tmp[r + x] = (src[r + a] + src[r + e] + 4 * (src[r + b] + src[r + c]) + 6 * src[r + x]) / 16; } }
  for (let y = 0; y < h; y++) { const a = (y > 1 ? y - 2 : 0) * w, b = (y > 0 ? y - 1 : 0) * w, c = (y < h - 1 ? y + 1 : h - 1) * w, e = (y < h - 2 ? y + 2 : h - 1) * w, r = y * w; for (let x = 0; x < w; x++) out[r + x] = (tmp[a + x] + tmp[e + x] + 4 * (tmp[b + x] + tmp[c + x]) + 6 * tmp[r + x]) / 16; }
  return out;
}

/* ---------------- HDR: exposure fusion ---------------- */
/** Shift (in pixels of the small images) that lines b up with a: median-threshold bitmaps, coarse to fine (Ward 2003). */
function shiftBetween(a, b) {
  const pyr = (g) => { const out = [g]; while (out.length < 6 && Math.min(out[out.length - 1].w, out[out.length - 1].h) > 24) { const p = out[out.length - 1], w = p.w >> 1, h = p.h >> 1, d = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = (p.d[(y * 2) * p.w + x * 2] + p.d[(y * 2) * p.w + x * 2 + 1] + p.d[(y * 2 + 1) * p.w + x * 2] + p.d[(y * 2 + 1) * p.w + x * 2 + 1]) / 4; out.push({ w, h, d }); } return out; };
  const bits = (g) => { const s = Float32Array.from(g.d).sort(), med = s[s.length >> 1], n = g.w * g.h, bit = new Uint8Array(n), ok = new Uint8Array(n); for (let i = 0; i < n; i++) { bit[i] = g.d[i] > med ? 1 : 0; ok[i] = Math.abs(g.d[i] - med) > 4 ? 1 : 0; } return { bit, ok }; };
  const pa = pyr(a), pb = pyr(b);
  let sx = 0, sy = 0;
  for (let l = Math.min(pa.length, pb.length) - 1; l >= 0; l--) {
    const A = pa[l], B = pb[l], ba = bits(A), bb = bits(B), w = Math.min(A.w, B.w), h = Math.min(A.h, B.h);
    sx *= 2; sy *= 2;
    let best = Infinity, bx = sx, by = sy;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ox = sx + dx, oy = sy + dy; let err = 0, n = 0;
      for (let y = Math.max(0, -oy); y < Math.min(h, h - oy); y++) for (let x = Math.max(0, -ox); x < Math.min(w, w - ox); x++) {
        const i = y * A.w + x, j = (y + oy) * B.w + x + ox;
        if (ba.ok[i] && bb.ok[j]) { n++; if (ba.bit[i] !== bb.bit[j]) err++; }
      }
      const e = n ? err / n + (dx || dy ? 1e-4 : 0) : Infinity;
      if (e < best) { best = e; bx = ox; by = oy; }
    }
    sx = bx; sy = by;
  }
  return [sx, sy];
}
function half(src, w, h) {
  const b = blur5(src, w, h), w2 = (w + 1) >> 1, h2 = (h + 1) >> 1, out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) out[y * w2 + x] = b[Math.min(h - 1, y * 2) * w + Math.min(w - 1, x * 2)];
  return { d: out, w: w2, h: h2 };
}
/** A half-size plane brought back to w×h (linear). */
function grow(src, w2, h2, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / 2, y0 = Math.min(h2 - 1, fy | 0), y1 = Math.min(h2 - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = x / 2, x0 = Math.min(w2 - 1, fx | 0), x1 = Math.min(w2 - 1, x0 + 1), tx = fx - x0;
      out[y * w + x] = (src[y0 * w2 + x0] * (1 - tx) + src[y0 * w2 + x1] * tx) * (1 - ty) + (src[y1 * w2 + x0] * (1 - tx) + src[y1 * w2 + x1] * tx) * ty;
    }
  }
  return out;
}
function hdr(id, linear) {
  const K = imgs.length;
  if (K < 2) throw new Error('Choose at least two exposures of the same scene');
  const w = imgs[0].w, h = imgs[0].h, N = w * h;
  for (const im of imgs) if (im.w !== w || im.h !== h) throw new Error('The photos are not the same size — an HDR merge needs exposures from one camera position');
  const say = (p, text) => tell({ id, progress: p, text });
  // 1. line them up on the middle exposure
  say(0.02, 'Lining up the exposures');
  const sm = imgs.map(im => small(im, 640)), mean = sm.map(s => { let a = 0; for (let i = 0; i < s.d.length; i++) a += s.d[i]; return a / s.d.length; });
  const order = mean.map((m, i) => i).sort((a, b) => mean[a] - mean[b]), ref = order[K >> 1];
  if (mean[order[K - 1]] - mean[order[0]] < 6) throw new Error('These photos are all about equally bright — an HDR merge needs different exposures');
  // Hand-held brackets differ by a small turn as well as a shift. Where enough corners can be matched
  // between an exposure and the middle one, that exposure is redrawn to sit exactly on it; where they
  // cannot (very dark or blown frames), a plain shift is found from brightness patterns instead.
  const align = [], refCorners = corners(sm[ref], 1200);
  let seed = 4321; const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const shift = sm.map((s, i) => {
    if (i === ref) { align.push('reference'); return [0, 0]; }
    const c = corners(s, 1200), m = matchCorners(c, refCorners);
    const r = m.length >= 30 ? ransac(m.map(([a]) => [c[a].x, c[a].y]), m.map(([, b]) => [refCorners[b].x, refCorners[b].y]), rand) : null;
    if (r && r.inliers.length >= 25) {
      const Hi = inv(r.H), st = s.step, im = imgs[i], out = new Uint8Array(w * h * 3), src = im.rgb;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = apply(Hi, (x + 0.5) / st - 0.5, (y + 0.5) / st - 0.5);
        const fx = Math.min(w - 1.001, Math.max(0, (p[0] + 0.5) * st - 0.5)), fy = Math.min(h - 1.001, Math.max(0, (p[1] + 0.5) * st - 0.5));
        const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, q = (iy * w + ix) * 3, q2 = q + w * 3, o = (y * w + x) * 3;
        for (let k = 0; k < 3; k++) out[o + k] = (src[q + k] * (1 - tx) + src[q + 3 + k] * tx) * (1 - ty) + (src[q2 + k] * (1 - tx) + src[q2 + 3 + k] * tx) * ty + 0.5;
      }
      imgs[i] = { w, h, rgb: out }; sm[i] = small(imgs[i], 640);
      align.push('matched on ' + r.inliers.length + ' corners');
      return [0, 0];
    }
    const [x, y] = shiftBetween(sm[ref], s);
    align.push('shift only');
    return [x * s.step, y * s.step];
  });
  // Things that moved between the exposures (people, leaves, cars) would show as ghosts. Where an
  // exposure disagrees with the middle one beyond what the difference in exposure explains, it is left
  // out there and the middle exposure decides.
  const ghost = [], ghostShare = [], gains = new Array(K).fill(1);      // gains: how much more light each frame took in than the middle one
  {
    const R = sm[ref], lin = (v) => Math.pow(v / 255, 2.2), okv = (v) => v > 20 && v < 235;
    for (let k = 0; k < K; k++) {
      if (k === ref) { ghost.push(null); ghostShare.push(0); continue; }
      const S = sm[k], ox = Math.round(shift[k][0] / S.step), oy = Math.round(shift[k][1] / S.step), n = R.w * R.h;
      const at = (x, y) => S.d[Math.min(S.h - 1, Math.max(0, y + oy)) * S.w + Math.min(S.w - 1, Math.max(0, x + ox))];
      const ratios = [];
      for (let y = 0; y < R.h; y += 2) for (let x = 0; x < R.w; x += 2) { const a = R.d[y * R.w + x], b = at(x, y); if (okv(a) && okv(b)) ratios.push(lin(b) / lin(a)); }
      if (ratios.length < 200) { gains[k] = Math.pow(Math.max(1e-3, mean[k]) / Math.max(1e-3, mean[ref]), 2.2); ghost.push(null); ghostShare.push(0); continue; }       // too little in common to judge
      ratios.sort((p, q) => p - q);
      const g = ratios[ratios.length >> 1], raw = new Float32Array(n);
      gains[k] = g;
      // judged colour by colour: something of the same brightness but another colour has moved just as much
      const A = imgs[ref].rgb, B = imgs[k].rgb, st = R.step, fx = shift[k][0], fy = shift[k][1];
      for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
        const a = R.d[y * R.w + x], b = at(x, y);
        if (!okv(a) || !okv(b)) continue;
        // the middle pixel of the cell stands for it
        const cx = Math.min(w - 1, x * st + (st >> 1)), cy = Math.min(h - 1, y * st + (st >> 1));
        const qa = (cy * w + cx) * 3, qb = (Math.min(h - 1, Math.max(0, cy + fy)) * w + Math.min(w - 1, Math.max(0, cx + fx))) * 3;
        let off = false;
        for (let c = 0; c < 3 && !off; c++) { const la = lin(A[qa + c]) * g, lb = lin(B[qb + c]); if (Math.abs(la - lb) > 0.4 * Math.max(la, lb) + 0.02) off = true; }
        const la = lin(a) * g, lb = lin(b);
        if (off || Math.abs(la - lb) > 0.4 * Math.max(la, lb) + 0.012) raw[y * R.w + x] = 1;
      }
      const soft = blur5(blur5(raw, R.w, R.h), R.w, R.h); let cnt = 0;
      for (let i = 0; i < n; i++) { soft[i] = Math.min(1, soft[i] * 4); if (soft[i] > 0.5) cnt++; }
      // a frame that disagrees almost everywhere is not showing movement: it is misaligned or lit differently, and masking it all would only hide that
      if (cnt > n * 0.4) { ghost.push(null); ghostShare.push(0); continue; }
      ghost.push(soft); ghostShare.push(+(cnt / n).toFixed(4));
    }
  }
  if (linear) {
    // The scene's light itself, as far as the frames tell it: each frame is taken back to linear light,
    // divided by how much more (or less) it was exposed than the middle one, and the frames are averaged
    // with most weight where a frame is neither near black nor near white. Highlights that are blown in
    // the middle frame come from the darker ones and end up above 1; the file keeps that room
    // (`headroom`) so the editor's Highlights and Exposure can bring them back.
    const headroom = Math.min(16, Math.max(1, ...gains.map(g => 1 / Math.max(1e-3, g))));
    const lut = new Float32Array(256), hat = new Float32Array(256);
    for (let i = 0; i < 256; i++) { lut[i] = Math.pow(i / 255, 2.2); hat[i] = Math.max(0, 1 - Math.pow(2 * i / 255 - 1, 12)); }
    const out = new Uint16Array(N * 3), order2 = gains.map((g, i) => i).sort((a, b) => gains[a] - gains[b]), darkest = order2[0], brightest = order2[K - 1];
    const scale = 65535 / headroom;
    for (let y = 0; y < h; y++) {
      if ((y & 255) === 0) say(0.3 + 0.65 * y / h, 'Merging the light');
      const gy = Math.min(sm[ref].h - 1, (y / sm[ref].step) | 0) * sm[ref].w;
      for (let x = 0; x < w; x++) {
        const gi = gy + Math.min(sm[ref].w - 1, (x / sm[ref].step) | 0), o = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) {
          let sum = 0, ws = 0, vRef = 0;
          for (let k = 0; k < K; k++) {
            const [sx, sy] = shift[k], v = imgs[k].rgb[(Math.min(h - 1, Math.max(0, y + sy)) * w + Math.min(w - 1, Math.max(0, x + sx))) * 3 + c];
            if (k === ref) vRef = v;
            let wk = hat[v] + (k === ref ? 0.02 : 0);
            if (ghost[k]) wk *= 1 - 0.995 * ghost[k][gi];
            sum += wk * lut[v] / gains[k]; ws += wk;
          }
          let val;
          if (ws > 1e-3) val = sum / ws;
          else {
            // every frame is at an end here: blown → the darkest frame knows most, black → the brightest
            const k = vRef > 128 ? darkest : brightest, [sx, sy] = shift[k];
            val = lut[imgs[k].rgb[(Math.min(h - 1, Math.max(0, y + sy)) * w + Math.min(w - 1, Math.max(0, x + sx))) * 3 + c]] / gains[k];
          }
          const q = val * scale;
          out[o + c] = q < 0 ? 0 : q > 65535 ? 65535 : q + 0.5;
        }
      }
    }
    // a small copy of the middle frame goes into the file as its preview: the editor matches its starting look to it
    const pk = Math.max(1, Math.ceil(Math.max(w, h) / 1600)), pw = Math.floor(w / pk), ph = Math.floor(h / pk), prev = new Uint8Array(pw * ph * 3), A = imgs[ref].rgb;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) for (let c = 0; c < 3; c++) {
      let a = 0; for (let dy = 0; dy < pk; dy++) for (let dx = 0; dx < pk; dx++) a += A[((y * pk + dy) * w + x * pk + dx) * 3 + c];
      prev[(y * pw + x) * 3 + c] = a / (pk * pk) + 0.5;
    }
    return { w, h, rgb16: out, stats: { shifts: shift, reference: ref, align, ghost: ghostShare, gains: gains.map(g => +g.toFixed(3)), headroom: +headroom.toFixed(3) }, preview: { w: pw, h: ph, rgb: prev } };
  }
  // What "well exposed" means depends on the place: a sky should end up light and a shadow dark, only
   // less extremely so than in any single exposure. The aim for each place comes from how bright it is
   // in the middle exposure (seen coarsely): mid-grey for mid-tones, lighter for what is bright there.
  const rs = sm[ref], aim = blur5(blur5(rs.d, rs.w, rs.h), rs.w, rs.h);
  const aimAt = (x, y) => 0.5 + 0.55 * (aim[Math.min(rs.h - 1, (y / rs.step) | 0) * rs.w + Math.min(rs.w - 1, (x / rs.step) | 0)] / 255 - 0.5);
  // 2. how good each exposure is at each pixel: well exposed, colourful, detailed
  const W = [], sum = new Float32Array(N);
  for (let k = 0; k < K; k++) {
    say(0.05 + 0.2 * k / K, 'Weighing exposure ' + (k + 1));
    const s = imgs[k].rgb, [sx, sy] = shift[k], wk = new Float32Array(N), Y = new Float32Array(N), gk = ghost[k];
    for (let y = 0; y < h; y++) { const yy = Math.min(h - 1, Math.max(0, y + sy)); for (let x = 0; x < w; x++) { const i = (yy * w + Math.min(w - 1, Math.max(0, x + sx))) * 3; Y[y * w + x] = (s[i] + s[i + 1] + s[i + 2]) / 765; } }
    for (let y = 0; y < h; y++) {
      const yy = Math.min(h - 1, Math.max(0, y + sy));
      for (let x = 0; x < w; x++) {
        const i = (yy * w + Math.min(w - 1, Math.max(0, x + sx))) * 3, p = y * w + x;
        const r = s[i] / 255, g = s[i + 1] / 255, b = s[i + 2] / 255, m = (r + g + b) / 3;
        const t = aimAt(x, y), well = Math.exp(-((r - t) * (r - t) + (g - t) * (g - t) + (b - t) * (b - t)) / 0.08);
        const sat = Math.sqrt(((r - m) * (r - m) + (g - m) * (g - m) + (b - m) * (b - m)) / 3);
        const lap = Math.abs(4 * Y[p] - Y[x > 0 ? p - 1 : p] - Y[x < w - 1 ? p + 1 : p] - Y[y > 0 ? p - w : p] - Y[y < h - 1 ? p + w : p]);
        wk[p] = (lap + 0.02) * (sat + 0.05) * well + 1e-6;
        if (gk) wk[p] *= 1 - 0.995 * gk[Math.min(rs.h - 1, (y / rs.step) | 0) * rs.w + Math.min(rs.w - 1, (x / rs.step) | 0)];
        sum[p] += wk[p];
      }
    }
    W.push(wk);
  }
  for (let k = 0; k < K; k++) { const wk = W[k]; for (let p = 0; p < N; p++) wk[p] /= sum[p]; }
  // 3. blend each colour channel across scales
  const sizes = [[w, h]];
  while (Math.min(sizes[sizes.length - 1][0], sizes[sizes.length - 1][1]) > 16 && sizes.length < 12) { const [a, b] = sizes[sizes.length - 1]; sizes.push([(a + 1) >> 1, (b + 1) >> 1]); }
  const L = sizes.length, out = new Uint16Array(N * 3);
  const wp = W.map((wk) => { const levels = [wk]; for (let l = 1; l < L; l++) levels.push(half(levels[l - 1], sizes[l - 1][0], sizes[l - 1][1]).d); return levels; });
  for (let c = 0; c < 3; c++) {
    const acc = sizes.map(([a, b]) => new Float32Array(a * b));
    for (let k = 0; k < K; k++) {
      say(0.3 + 0.65 * (c * K + k) / (3 * K), 'Blending');
      const s = imgs[k].rgb, [sx, sy] = shift[k];
      let cur = new Float32Array(N);
      for (let y = 0; y < h; y++) { const yy = Math.min(h - 1, Math.max(0, y + sy)); for (let x = 0; x < w; x++) cur[y * w + x] = s[(yy * w + Math.min(w - 1, Math.max(0, x + sx))) * 3 + c]; }
      for (let l = 0; l < L; l++) {
        const [a, b] = sizes[l], wl = wp[k][l], al = acc[l];
        if (l === L - 1) { for (let p = 0; p < a * b; p++) al[p] += cur[p] * wl[p]; break; }
        const nx = half(cur, a, b), up = grow(nx.d, nx.w, nx.h, a, b);
        for (let p = 0; p < a * b; p++) al[p] += (cur[p] - up[p]) * wl[p];
        cur = nx.d;
      }
    }
    let res = acc[L - 1];
    for (let l = L - 2; l >= 0; l--) { const [a, b] = sizes[l], up = grow(res, sizes[l + 1][0], sizes[l + 1][1], a, b), al = acc[l]; for (let p = 0; p < a * b; p++) al[p] += up[p]; res = al; }
    for (let p = 0; p < N; p++) { const v = res[p] * 257; out[p * 3 + c] = v < 0 ? 0 : v > 65535 ? 65535 : v + 0.5; }
  }
  return { w, h, rgb16: out, stats: { shifts: shift, reference: ref, align, ghost: ghostShare } };
}

/* ---------------- panorama ---------------- */
/** Corners of a small brightness image with a description of the patch around each. */
/* ---------------- focus stack ---------------- */
function stack(id) {
  const K = imgs.length;
  if (K < 2) throw new Error('Choose at least two photos of the same scene, focused at different distances');
  const w = imgs[0].w, h = imgs[0].h, N = w * h;
  for (const im of imgs) if (im.w !== w || im.h !== h) throw new Error('The photos are not the same size — a focus stack needs photos from one camera position');
  const say = (p, text) => tell({ id, progress: p, text });
  // 1. Line them up. Focusing nearer or farther also changes how large things are drawn, so each photo is
  // redrawn to sit on its neighbour (which is already in place), working outwards from the middle one:
  // neighbours are focused alike and share the most sharp corners.
  say(0.02, 'Lining up the photos');
  const mid = K >> 1, align = new Array(K).fill('');
  align[mid] = 'reference';
  let seed = 4321; const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const lineUp = (i, onto) => {
    const A = small(imgs[i], 800), B = small(imgs[onto], 800), ca = corners(A, 1500), cb = corners(B, 1500), m = matchCorners(ca, cb);
    const r = m.length >= 30 ? ransac(m.map(([a]) => [ca[a].x, ca[a].y]), m.map(([, b]) => [cb[b].x, cb[b].y]), rand) : null;
    if (!(r && r.inliers.length >= 25)) { align[i] = 'left as it is'; return; }
    const Hi = inv(r.H), st = A.step, src = imgs[i].rgb;
    // Corners matched between a sharp and a blurred rendering of the same thing can agree on a wrong
    // answer. The redrawing is only used when it makes the two photos (compared blurred, so that focus
    // does not count) more alike than they already are.
    {
      const a = blur5(blur5(A.d, A.w, A.h), A.w, A.h), b = blur5(blur5(B.d, B.w, B.h), B.w, B.h);
      let plain = 0, moved = 0, n = 0;
      for (let y = 4; y < B.h - 4; y += 3) for (let x = 4; x < B.w - 4; x += 3) {
        const p = apply(Hi, x, y), px = Math.round(p[0]), py = Math.round(p[1]);
        if (px < 0 || py < 0 || px >= A.w || py >= A.h) { moved += 40; plain += Math.abs(b[y * B.w + x] - a[y * A.w + x]); n++; continue; }
        plain += Math.abs(b[y * B.w + x] - a[y * A.w + x]); moved += Math.abs(b[y * B.w + x] - a[py * A.w + px]); n++;
      }
      if (!(moved < plain * 0.97)) { align[i] = 'already in place'; return; }
    }
    const out = new Uint8Array(N * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = apply(Hi, (x + 0.5) / st - 0.5, (y + 0.5) / st - 0.5);
      const fx = Math.min(w - 1.001, Math.max(0, (p[0] + 0.5) * st - 0.5)), fy = Math.min(h - 1.001, Math.max(0, (p[1] + 0.5) * st - 0.5));
      const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, q = (iy * w + ix) * 3, q2 = q + w * 3, o = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) out[o + k] = (src[q + k] * (1 - tx) + src[q + 3 + k] * tx) * (1 - ty) + (src[q2 + k] * (1 - tx) + src[q2 + 3 + k] * tx) * ty + 0.5;
    }
    imgs[i] = { w, h, rgb: out };
    align[i] = 'matched on ' + r.inliers.length + ' corners';
  };
  for (let i = mid + 1; i < K; i++) { say(0.02 + 0.13 * (i - mid) / K, 'Lining up the photos'); lineUp(i, i - 1); }
  for (let i = mid - 1; i >= 0; i--) { say(0.02 + 0.13 * (K - i) / K, 'Lining up the photos'); lineUp(i, i + 1); }
  // 2. Each photo is split into its detail at every scale (fine texture, edges, broad shapes). At each
  // scale and place, the detail is kept from the photo where it is strongest — that is where it is in
  // focus. Only the best so far is held, so memory does not grow with the number of photos.
  const sizes = []; { let lw = w, lh = h; while (sizes.length < 7 && Math.min(lw, lh) >= 32) { sizes.push([lw, lh]); lw = (lw + 1) >> 1; lh = (lh + 1) >> 1; } }
  const L = sizes.length;
  let best = null, base = null; const used = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    say(0.15 + 0.75 * k / K, `Finding what is sharp in photo ${k + 1} of ${K}`);
    const src = imgs[k].rgb, planes = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    for (let i = 0, q = 0; i < N; i++, q += 3) { const r = src[q], g = src[q + 1], b = src[q + 2]; planes[0][i] = r * 0.299 + g * 0.587 + b * 0.114; planes[1][i] = r; planes[2][i] = g; planes[3][i] = b; }
    imgs[k] = { w, h, rgb: null };
    const pyr = planes.map((pl) => {
      const out = []; let cur = pl, cw = w, ch = h;
      for (let l = 0; l < L; l++) { const hf = half(cur, cw, ch), up = grow(hf.d, hf.w, hf.h, cw, ch); for (let i = 0; i < cur.length; i++) cur[i] -= up[i]; out.push(cur); cur = hf.d; cw = hf.w; ch = hf.h; }
      out.push(cur);
      return out;
    });
    const energy = pyr[0].slice(0, L).map((d, l) => { const a = new Float32Array(d.length); for (let i = 0; i < d.length; i++) a[i] = d[i] < 0 ? -d[i] : d[i]; return blur5(a, sizes[l][0], sizes[l][1]); });
    if (!best) { best = { e: energy, c: [pyr[1].slice(0, L), pyr[2].slice(0, L), pyr[3].slice(0, L)], from: new Uint8Array(N) }; base = [pyr[1][L], pyr[2][L], pyr[3][L]]; continue; }
    for (let l = 0; l < L; l++) {
      const e = energy[l], be = best.e[l], n = e.length, r0 = pyr[1][l], g0 = pyr[2][l], b0 = pyr[3][l], br = best.c[0][l], bg = best.c[1][l], bb = best.c[2][l];
      for (let i = 0; i < n; i++) if (e[i] > be[i]) { be[i] = e[i]; br[i] = r0[i]; bg[i] = g0[i]; bb[i] = b0[i]; if (l === 0) best.from[i] = k; }
    }
    for (let c = 0; c < 3; c++) { const s = pyr[c + 1][L], d = base[c]; for (let i = 0; i < d.length; i++) d[i] += s[i]; }
  }
  for (let i = 0; i < N; i += 7) used[best.from[i]]++;
  // 3. Put the scales back together
  say(0.92, 'Putting the picture together');
  const out = new Uint16Array(N * 3), lastW = (sizes[L - 1][0] + 1) >> 1, lastH = (sizes[L - 1][1] + 1) >> 1;
  for (let c = 0; c < 3; c++) {
    let cur = base[c], cw = lastW, ch = lastH;
    for (let i = 0; i < cur.length; i++) cur[i] /= K;
    for (let l = L - 1; l >= 0; l--) { const up = grow(cur, cw, ch, sizes[l][0], sizes[l][1]), d = best.c[c][l]; for (let i = 0; i < up.length; i++) up[i] += d[i]; cur = up; cw = sizes[l][0]; ch = sizes[l][1]; best.c[c][l] = null; }
    for (let i = 0; i < N; i++) { const v = cur[i] * 257; out[i * 3 + c] = v <= 0 ? 0 : v >= 65535 ? 65535 : v + 0.5; }
  }
  const total = used.reduce((a, b) => a + b, 0) || 1;
  return { w, h, rgb16: out, stats: { align, share: Array.from(used, v => +(v / total).toFixed(3)) } };
}

function corners(g, max) {
  const { w, h } = g, b = blur5(g.d, w, h), bb = blur5(b, w, h), R = new Float32Array(w * h);
  const ixx = new Float32Array(w * h), iyy = new Float32Array(w * h), ixy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const p = y * w + x, dx = (b[p + 1] - b[p - 1]) / 2, dy = (b[p + w] - b[p - w]) / 2; ixx[p] = dx * dx; iyy[p] = dy * dy; ixy[p] = dx * dy; }
  const sxx = blur5(ixx, w, h), syy = blur5(iyy, w, h), sxy = blur5(ixy, w, h);
  for (let p = 0; p < w * h; p++) { const det = sxx[p] * syy[p] - sxy[p] * sxy[p], tr = sxx[p] + syy[p]; R[p] = det - 0.05 * tr * tr; }
  const pts = [], M = 14;
  for (let y = M; y < h - M; y++) for (let x = M; x < w - M; x++) {
    const p = y * w + x, v = R[p];
    if (v <= 1) continue;
    let top = true;
    for (let dy = -3; dy <= 3 && top; dy++) for (let dx = -3; dx <= 3; dx++) if ((dx || dy) && R[p + dy * w + dx] > v) { top = false; break; }
    if (top) pts.push({ x, y, v });
  }
  pts.sort((a, c) => c.v - a.v);
  const keep = pts.slice(0, max);
  for (const k of keep) {
    const d = new Float32Array(64); let m = 0, n = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const v = bb[(k.y + (j - 3.5) * 3 | 0) * w + (k.x + (i - 3.5) * 3 | 0)]; d[n++] = v; m += v; }
    m /= 64; let sd = 0; for (let i = 0; i < 64; i++) { d[i] -= m; sd += d[i] * d[i]; }
    sd = Math.sqrt(sd) || 1; for (let i = 0; i < 64; i++) d[i] /= sd;
    k.d = d; k.lum = m;
  }
  return keep;
}
/** Pairs of corners that are each other's best match, and clearly better than the runner-up. */
function matchCorners(A, B) {
  const best = (P, Q) => P.map((p) => { let b1 = Infinity, b2 = Infinity, bi = -1; for (let j = 0; j < Q.length; j++) { let s = 0; const q = Q[j].d, d = p.d; for (let i = 0; i < 64; i++) { const e = d[i] - q[i]; s += e * e; if (s >= b2) break; } if (s < b1) { b2 = b1; b1 = s; bi = j; } else if (s < b2) b2 = s; } return b1 < 0.64 * b2 ? bi : -1; });
  const ab = best(A, B), ba = best(B, A), out = [];
  for (let i = 0; i < A.length; i++) if (ab[i] >= 0 && ba[ab[i]] === i) out.push([i, ab[i]]);
  return out;
}
/** Solve an n×n system in place (Gauss–Jordan with pivoting); returns null when it has no single answer. */
function solve(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (Math.abs(A[piv * n + c]) < 1e-10) return null;
    if (piv !== c) { for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t; } const t = b[c]; b[c] = b[piv]; b[piv] = t; }
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = A[r * n + c] / A[c * n + c]; if (!f) continue; for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k]; b[r] -= f * b[c]; }
  }
  const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = b[i] / A[i * n + i];
  return x;
}
/** The projective map (3×3, last entry 1) that takes points `from` to points `to`, by least squares. */
function homography(from, to) {
  const A = new Float64Array(64), b = new Float64Array(8);
  for (let i = 0; i < from.length; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    const r1 = [x, y, 1, 0, 0, 0, -u * x, -u * y], r2 = [0, 0, 0, x, y, 1, -v * x, -v * y];
    for (let p = 0; p < 8; p++) { for (let q = 0; q < 8; q++) A[p * 8 + q] += r1[p] * r1[q] + r2[p] * r2[q]; b[p] += r1[p] * u + r2[p] * v; }
  }
  const hh = solve(A, b, 8);
  return hh ? [hh[0], hh[1], hh[2], hh[3], hh[4], hh[5], hh[6], hh[7], 1] : null;
}
const apply = (H, x, y) => { const z = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z]; };
function mul(a, b) { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; return o; }
function inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
function ransac(from, to, rand) {
  const n = from.length; let bestIn = [];
  if (n < 8) return null;
  for (let it = 0; it < 2000; it++) {
    const idx = []; while (idx.length < 4) { const k = (rand() * n) | 0; if (!idx.includes(k)) idx.push(k); }
    const H = homography(idx.map(k => from[k]), idx.map(k => to[k]));
    if (!H) continue;
    const ins = [];
    for (let k = 0; k < n; k++) { const [u, v] = apply(H, from[k][0], from[k][1]); if ((u - to[k][0]) ** 2 + (v - to[k][1]) ** 2 < 6.25) ins.push(k); }
    if (ins.length > bestIn.length) { bestIn = ins; if (ins.length > n * 0.8) break; }
  }
  if (bestIn.length < 10) return null;
  let H = homography(bestIn.map(k => from[k]), bestIn.map(k => to[k]));
  if (!H) return null;
  // once more with everything the refined map agrees with
  const ins = []; for (let k = 0; k < n; k++) { const [u, v] = apply(H, from[k][0], from[k][1]); if ((u - to[k][0]) ** 2 + (v - to[k][1]) ** 2 < 6.25) ins.push(k); }
  if (ins.length >= bestIn.length) { const H2 = homography(ins.map(k => from[k]), ins.map(k => to[k])); if (H2) { H = H2; bestIn = ins; } }
  return { H, inliers: bestIn };
}
function pano(id, focal, maxPixels) {
  const K = imgs.length;
  if (K < 2) throw new Error('Choose at least two overlapping photos');
  const say = (p, text) => tell({ id, progress: p, text });
  let seed = 12345; const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const sm = imgs.map(im => small(im, 900));
  // The photos are laid on a cylinder around the camera: turning the camera then only slides a photo
  // sideways, so corners look the same in neighbouring photos and a wide sweep keeps its shape.
  // That needs the focal length; without it a normal lens is assumed (a wrong guess still joins).
  const known = !!(focal && focal.length === K && focal.every(f => f > 0)), cyl = true;
  const fs = sm.map((s, i) => known ? focal[i] / s.step : 1.2 * Math.max(s.w, s.h));
  const toCyl = (i, x, y) => { if (!cyl) return [x, y]; const f = fs[i], cx = sm[i].w / 2, cy = sm[i].h / 2, dx = x - cx; return [f * Math.atan(dx / f) + cx, f * (y - cy) / Math.sqrt(dx * dx + f * f) + cy]; };
  const fromCyl = (i, x, y) => { if (!cyl) return [x, y]; const f = fs[i], cx = sm[i].w / 2, cy = sm[i].h / 2, a = (x - cx) / f; if (Math.abs(a) > 1.4) return [-1e9, -1e9]; const dx = f * Math.tan(a); return [dx + cx, (y - cy) * Math.sqrt(dx * dx + f * f) / f + cy]; };
  say(0.03, 'Finding corners');
  const feats = sm.map((s, i) => {
    // the photo as it lies on the cylinder; corners whose surroundings reach past its edge are left out
    const d = new Float32Array(s.w * s.h), ok = new Uint8Array(s.w * s.h);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const p = fromCyl(i, x, y);
      if (!(p[0] >= 0 && p[1] >= 0 && p[0] <= s.w - 1.001 && p[1] <= s.h - 1.001)) continue;
      const ix = p[0] | 0, iy = p[1] | 0, tx = p[0] - ix, ty = p[1] - iy, q = iy * s.w + ix;
      d[y * s.w + x] = (s.d[q] * (1 - tx) + s.d[q + 1] * tx) * (1 - ty) + (s.d[q + s.w] * (1 - tx) + s.d[q + s.w + 1] * tx) * ty; ok[y * s.w + x] = 1;
    }
    return corners({ w: s.w, h: s.h, d }, 1500).filter(k => ok[(k.y - 14) * s.w + k.x - 14] && ok[(k.y - 14) * s.w + k.x + 14] && ok[(k.y + 14) * s.w + k.x - 14] && ok[(k.y + 14) * s.w + k.x + 14]);
  });
  // neighbours in the order given: photo i+1 onto photo i
  const T = [[1, 0, 0, 0, 1, 0, 0, 0, 1]], gain = [1], counts = [];
  for (let i = 1; i < K; i++) {
    say(0.05 + 0.2 * i / K, 'Matching photo ' + (i + 1));
    const m = matchCorners(feats[i], feats[i - 1]);
    const from = m.map(([a]) => [feats[i][a].x, feats[i][a].y]), to = m.map(([, b]) => [feats[i - 1][b].x, feats[i - 1][b].y]);
    const r = ransac(from, to, rand);
    if (!r) throw new Error(`Photos ${i} and ${i + 1} do not overlap enough to be joined (in the order they were taken)`);
    counts.push(r.inliers.length);
    T.push(mul(T[i - 1], r.H));
    let la = 0, lb = 0; for (const k of r.inliers) { la += feats[i][m[k][0]].lum; lb += feats[i - 1][m[k][1]].lum; }
    gain.push(gain[i - 1] * Math.max(0.5, Math.min(2, lb / Math.max(1, la))));
  }
  // everything relative to the middle photo, brightness evened around 1
  const mid = K >> 1, back = inv(T[mid]);
  const Tm = T.map(t => mul(back, t)), Ti = Tm.map(inv);
  const gm = Math.exp(gain.reduce((a, g) => a + Math.log(g), 0) / K), G = gain.map(g => g / gm);
  // the frame that holds them all (in the middle photo's small pixels)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < K; i++) for (let s = 0; s <= 20; s++) for (const [x, y] of [[sm[i].w * s / 20, 0], [sm[i].w * s / 20, sm[i].h], [0, sm[i].h * s / 20], [sm[i].w, sm[i].h * s / 20]]) {
    const c = toCyl(i, x, y), [u, v] = apply(Tm[i], c[0], c[1]);
    x0 = Math.min(x0, u); y0 = Math.min(y0, v); x1 = Math.max(x1, u); y1 = Math.max(y1, v);
  }
  const span = Math.max(sm[mid].w, sm[mid].h);
  if (!(x1 - x0 < span * 12 && y1 - y0 < span * 6 && x1 - x0 > 8 && y1 - y0 > 8)) throw new Error('The photos could not be lined up into one picture');
  // where a point of the frame falls in photo i (small pixels), or null outside it
  const inPhoto = (i, u, v) => { const c = apply(Ti[i], u, v), p = fromCyl(i, c[0], c[1]); return p[0] >= 0 && p[1] >= 0 && p[0] <= sm[i].w - 1 && p[1] <= sm[i].h - 1 ? p : null; };
  // trim to a rectangle that is (almost) completely covered
  const cs = 4, cw = Math.max(2, Math.floor((x1 - x0) / cs)), ch = Math.max(2, Math.floor((y1 - y0) / cs)), cov = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { for (let i = 0; i < K; i++) if (inPhoto(i, x0 + (x + 0.5) * cs, y0 + (y + 0.5) * cs)) { cov[y * cw + x] = 1; break; } }
  let a = 0, b = 0, c = cw - 1, d = ch - 1;          // left, top, right, bottom
  const empty = (xa, ya, xb, yb) => { let e = 0, n = 0; for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { n++; if (!cov[y * cw + x]) e++; } return e / Math.max(1, n); };
  for (let guard = 0; guard < cw + ch && c - a > 4 && d - b > 4; guard++) {
    const e = [empty(a, b, a, d), empty(a, b, c, b), empty(c, b, c, d), empty(a, d, c, d)], worst = Math.max(...e);
    if (worst < 0.01) break;
    const k = e.indexOf(worst); if (k === 0) a++; else if (k === 1) b++; else if (k === 2) c--; else d--;
  }
  const fx0 = x0 + a * cs, fy0 = y0 + b * cs, fw = (c - a + 1) * cs, fh = (d - b + 1) * cs;
  // output size: the middle photo's own resolution, within the limit
  let scale = sm[mid].step;
  if (fw * scale * fh * scale > maxPixels) scale = Math.sqrt(maxPixels / (fw * fh));
  const W = Math.max(8, Math.round(fw * scale)), H = Math.max(8, Math.round(fh * scale));
  const out = new Uint16Array(W * H * 3);
  // Blending in two bands (after Brown & Lowe): the broad light and colour of each photo is mixed over
  // a wide stretch, so differences in exposure fade out gently, while the fine detail is taken almost
  // entirely from whichever photo is strongest at that point, so things that do not line up exactly
  // show once and sharp instead of twice and blurred.
  const low = imgs.map((im, i) => {
    const s = sm[i], st = s.step, planes = [0, 1, 2].map(() => new Float32Array(s.w * s.h));
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      let a = 0, b = 0, c = 0;
      for (let dy = 0; dy < st; dy++) { let q = ((y * st + dy) * im.w + x * st) * 3; for (let dx = 0; dx < st; dx++, q += 3) { a += im.rgb[q]; b += im.rgb[q + 1]; c += im.rgb[q + 2]; } }
      const n = st * st, p = y * s.w + x; planes[0][p] = a / n; planes[1][p] = b / n; planes[2][p] = c / n;
    }
    return planes.map(pl => blur5(blur5(pl, s.w, s.h), s.w, s.h));
  });
  const band = 128, acc = new Float32Array(W * band * 3), wt = new Float32Array(W * band), accH = new Float32Array(W * band * 3), wtH = new Float32Array(W * band);
  let seamSum = 0, seamN = 0;
  for (let by = 0; by < H; by += band) {
    const bh = Math.min(band, H - by);
    acc.fill(0); wt.fill(0); accH.fill(0); wtH.fill(0);
    say(0.3 + 0.68 * by / H, 'Joining');
    for (let i = 0; i < K; i++) {
      const im = imgs[i], s = im.rgb, st = sm[i].step, sw = sm[i].w, sh = sm[i].h, g = G[i], lo = low[i];
      for (let y = 0; y < bh; y++) {
        const v = fy0 + (by + y + 0.5) / scale;
        for (let x = 0; x < W; x++) {
          const p = inPhoto(i, fx0 + (x + 0.5) / scale, v);
          if (!p) continue;
          // feather: strongest in the middle of a photo, nothing at its edge
          const ex = Math.min(p[0], sw - 1 - p[0]) / sw, ey = Math.min(p[1], sh - 1 - p[1]) / sh, e = Math.min(ex, ey) * 2;
          const wgt = e * e + 1e-5;
          const fx = Math.min(im.w - 1.001, Math.max(0, (p[0] + 0.5) * st - 0.5)), fy = Math.min(im.h - 1.001, Math.max(0, (p[1] + 0.5) * st - 0.5));
          const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, q = (iy * im.w + ix) * 3, q2 = q + im.w * 3, o = (y * W + x) * 3;
          const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
          const r = (s[q] * w00 + s[q + 3] * w10 + s[q2] * w01 + s[q2 + 3] * w11) * g, gg = (s[q + 1] * w00 + s[q + 4] * w10 + s[q2 + 1] * w01 + s[q2 + 4] * w11) * g, bl = (s[q + 2] * w00 + s[q + 5] * w10 + s[q2 + 2] * w01 + s[q2 + 5] * w11) * g;
          const before = wt[y * W + x];
          if (before > 1e-4 && wgt > 0.01 && (x & 7) === 0 && (y & 7) === 0) { seamSum += Math.abs(acc[o + 1] / before + accH[o + 1] / wtH[y * W + x] - gg); seamN++; }      // how well overlapping photos agree
          // the broad band of this photo here, from its small blurred copy
          const lx = Math.min(sw - 1.001, Math.max(0, p[0])), ly = Math.min(sh - 1.001, Math.max(0, p[1])), jx = lx | 0, jy = ly | 0, ux = lx - jx, uy = ly - jy, lq = jy * sw + jx;
          const l00 = (1 - ux) * (1 - uy), l10 = ux * (1 - uy), l01 = (1 - ux) * uy, l11 = ux * uy;
          const lr = (lo[0][lq] * l00 + lo[0][lq + 1] * l10 + lo[0][lq + sw] * l01 + lo[0][lq + sw + 1] * l11) * g, lg = (lo[1][lq] * l00 + lo[1][lq + 1] * l10 + lo[1][lq + sw] * l01 + lo[1][lq + sw + 1] * l11) * g, lb = (lo[2][lq] * l00 + lo[2][lq + 1] * l10 + lo[2][lq + sw] * l01 + lo[2][lq + sw + 1] * l11) * g;
          const wh = wgt * wgt * wgt * wgt + 1e-12;
          acc[o] += lr * wgt; acc[o + 1] += lg * wgt; acc[o + 2] += lb * wgt; wt[y * W + x] = before + wgt;
          accH[o] += (r - lr) * wh; accH[o + 1] += (gg - lg) * wh; accH[o + 2] += (bl - lb) * wh; wtH[y * W + x] += wh;
        }
      }
    }
    for (let y = 0; y < bh; y++) for (let x = 0; x < W; x++) {
      const ww = wt[y * W + x]; if (!(ww > 0)) continue;
      const o = (y * W + x) * 3, t = ((by + y) * W + x) * 3;
      const hw = wtH[y * W + x];
      for (let k = 0; k < 3; k++) { const v = (acc[o + k] / ww + accH[o + k] / hw) * 257; out[t + k] = v < 0 ? 0 : v > 65535 ? 65535 : v + 0.5; }
    }
  }
  return { w: W, h: H, rgb16: out, stats: { matches: counts, gains: G.map(g => +g.toFixed(3)), focalKnown: known, overlapDiff: seamN ? +(seamSum / seamN).toFixed(2) : null } };
}

if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (ev) => {
    const m = ev.data;
    try {
      if (m.op === 'reset') { imgs = []; return; }
      if (m.op === 'image') { imgs.push({ w: m.w, h: m.h, rgb: m.rgb }); return; }
      const r = m.op === 'hdr' ? hdr(m.id, !!m.linear) : m.op === 'stack' ? stack(m.id) : pano(m.id, m.focal, m.maxPixels || 40e6);
      imgs = [];
      self.postMessage({ id: m.id, w: r.w, h: r.h, rgb16: r.rgb16, stats: r.stats, preview: r.preview || null }, r.preview ? [r.rgb16.buffer, r.preview.rgb.buffer] : [r.rgb16.buffer]);
    } catch (e) { imgs = []; self.postMessage({ id: m.id, error: String(e && e.message || e) }); }
  };
}
if (typeof module !== 'undefined') module.exports = { hdr, pano, stack, setImages: (list) => { imgs = list; }, _test: { homography, apply, shiftBetween, small } };
