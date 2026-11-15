/* =====================================================================
 * photos.jpeg — content-aware fill, in a thread of its own.
 *
 * Fills a hole in a picture with material from around it, so that what is
 * put there continues the surroundings (grass stays grass, a wall keeps its
 * bricks) instead of being a blur or a copy of one place.
 *
 * Method: PatchMatch (Barnes et al. 2009) inside the coarse-to-fine scheme
 * of Wexler et al. 2007. Every small square (7×7) that touches the hole
 * looks for the most similar square that lies wholly outside it; each hole
 * pixel then becomes the blend of what all the squares covering it found.
 * This is repeated from a small version of the picture up to full size, so
 * large structures are settled first and detail last.
 *
 * Optionally the picture comes with a map of what is where (label: one number per pixel — sky, tree,
 * road … from the scene model). The hole is then divided among the kinds of thing around it, each
 * part going to whichever is nearest, and a part is filled from material of its own kind: trees from
 * trees, sky from sky.
 *
 * in:  { id, w, h, rgb: Uint8Array(w·h·3), mask: Uint8Array(w·h) — 1 inside the hole, label?: Uint8Array(w·h) }
 * out: { id, rgb: Uint8Array(w·h·3) } or { id, error }
 * ===================================================================== */
'use strict';
const HALF = 3;                     // squares are (2·HALF+1)² pixels

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Half-size version: colours averaged over the pixels outside the hole where there are any; a cell is hole if any of its pixels is. */
function half(l) {
  const w = Math.max(1, l.w >> 1), h = Math.max(1, l.h >> 1), img = new Float32Array(w * h * 3), hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0, r2 = 0, g2 = 0, b2 = 0, any = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.min(l.w - 1, x * 2 + dx), sy = Math.min(l.h - 1, y * 2 + dy), i = sy * l.w + sx;
      r2 += l.img[i * 3]; g2 += l.img[i * 3 + 1]; b2 += l.img[i * 3 + 2];
      if (l.hole[i]) any = 1; else { r += l.img[i * 3]; g += l.img[i * 3 + 1]; b += l.img[i * 3 + 2]; n++; }
    }
    const o = (y * w + x) * 3;
    if (n) { img[o] = r / n; img[o + 1] = g / n; img[o + 2] = b / n; } else { img[o] = r2 / 4; img[o + 1] = g2 / 4; img[o + 2] = b2 / 4; }
    hole[y * w + x] = any;
  }
  const out = { w, h, img, hole };
  if (l.lab) { out.lab = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.lab[y * w + x] = l.lab[Math.min(l.h - 1, y * 2) * l.w + Math.min(l.w - 1, x * 2)]; }
  return out;
}

/** What kind of thing each pixel should be: its own kind outside the hole, inside it the kind of the nearest pixel outside. */
function kinds(l) {
  const { w, h, hole, lab } = l, g = Uint8Array.from(lab), seen = new Uint8Array(w * h);
  // A kind of thing with little of it outside the hole cannot fill anything: what is left of the object
  // being removed, a sliver of something at the edge. Such kinds do not spread into the hole (255 = any
  // material will do), or the fill would be tiled from a few pixels.
  const count = new Uint32Array(256); let outside = 0;
  for (let i = 0; i < w * h; i++) if (!hole[i]) { count[lab[i]]++; outside++; }
  const enough = Math.max(40, outside * 0.04);
  let q = [];
  for (let i = 0; i < w * h; i++) {
    if (hole[i]) { g[i] = 255; continue; }
    seen[i] = 1;
    if (count[lab[i]] < enough) { g[i] = 255; continue; }
    const x = i % w, y = (i / w) | 0;
    if ((x > 0 && hole[i - 1]) || (x < w - 1 && hole[i + 1]) || (y > 0 && hole[i - w]) || (y < h - 1 && hole[i + w])) q.push(i);
  }
  while (q.length) {
    const next = [];
    for (const i of q) {
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !seen[j]) { seen[j] = 1; g[j] = g[i]; next.push(j); }
    }
    q = next;
  }
  return g;
}

/** First guess for the hole: colours creep in from its edge, ring by ring. */
function creepIn(l) {
  const { w, h, img } = l, known = new Uint8Array(w * h);
  let left = 0;
  for (let i = 0; i < w * h; i++) { known[i] = l.hole[i] ? 0 : 1; if (!known[i]) left++; }
  if (left === w * h) return;
  while (left > 0) {
    const set = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (known[j]) { r += img[j * 3]; g += img[j * 3 + 1]; b += img[j * 3 + 2]; n++; }
      }
      if (n) set.push(i, r / n, g / n, b / n);
    }
    if (!set.length) break;
    for (let k = 0; k < set.length; k += 4) { const i = set[k]; img[i * 3] = set[k + 1]; img[i * 3 + 1] = set[k + 2]; img[i * 3 + 2] = set[k + 3]; known[i] = 1; left--; }
  }
}

/** Which pixels are the centre of a square touching the hole (targets), and which of a square clear of it and inside the picture (sources). */
function roles(l) {
  const { w, h, hole } = l, near = new Uint8Array(w * h), src = new Uint8Array(w * h);
  // hole grown by HALF: horizontal then vertical pass
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0; for (let d = -HALF; d <= HALF && !v; d++) { const xx = x + d; if (xx >= 0 && xx < w && hole[y * w + xx]) v = 1; }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0; for (let d = -HALF; d <= HALF && !v; d++) { const yy = y + d; if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1; }
    near[y * w + x] = v;
  }
  // how much a pixel can be trusted: fully outside the hole, less and less the deeper inside it lies.
  // Squares are compared mostly on what is known, so the fill grows inward from the edge and keeps
  // its texture instead of settling for the smoothest material in reach.
  const depth = new Float32Array(w * h), conf = new Float32Array(w * h), BIG = 1e9;
  for (let i = 0; i < w * h; i++) depth[i] = hole[i] ? BIG : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!depth[i]) continue;
    let d = depth[i];
    if (x > 0) d = Math.min(d, depth[i - 1] + 1); if (y > 0) d = Math.min(d, depth[i - w] + 1);
    if (x > 0 && y > 0) d = Math.min(d, depth[i - w - 1] + 1.4); if (x < w - 1 && y > 0) d = Math.min(d, depth[i - w + 1] + 1.4);
    depth[i] = d;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!depth[i]) continue;
    let d = depth[i];
    if (x < w - 1) d = Math.min(d, depth[i + 1] + 1); if (y < h - 1) d = Math.min(d, depth[i + w] + 1);
    if (x < w - 1 && y < h - 1) d = Math.min(d, depth[i + w + 1] + 1.4); if (x > 0 && y < h - 1) d = Math.min(d, depth[i + w - 1] + 1.4);
    depth[i] = d;
  }
  for (let i = 0; i < w * h; i++) conf[i] = Math.max(0.03, Math.pow(1.3, -Math.min(60, depth[i])));
  const targets = [], sources = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (near[i]) targets.push(i);
    else if (x >= HALF && y >= HALF && x < w - HALF && y < h - HALF) { src[i] = 1; sources.push(i); }
  }
  // targets nearest the edge first: their matches are the best founded, and spread inward from there
  targets.sort((a, b) => depth[a] - depth[b] || a - b);
  if (l.lab && !l.kind) l.kind = kinds(l);
  return { near, src, conf, depth, targets: Int32Array.from(targets), sources: Int32Array.from(sources) };
}

/** How different the square around target t is from the one around source s (stops early once it is worse than `best`). */
function differ(l, t, s, best, conf) {
  const { w, h, img } = l, tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
  // material is likelier to continue from nearby than from the far side of the piece
  const far = Math.hypot(sx - tx, sy - ty) / (w + h);
  let sum = 0, wsum = 0;
  for (let dy = -HALF; dy <= HALF; dy++) {
    const yy = ty + dy < 0 ? 0 : ty + dy >= h ? h - 1 : ty + dy, row = (sy + dy) * w;
    for (let dx = -HALF; dx <= HALF; dx++) {
      const xx = tx + dx < 0 ? 0 : tx + dx >= w ? w - 1 : tx + dx;
      const a = (yy * w + xx) * 3, b = (row + sx + dx) * 3;
      const d0 = img[a] - img[b], d1 = img[a + 1] - img[b + 1], d2 = img[a + 2] - img[b + 2];
      const c = conf[yy * w + xx];
      sum += c * (d0 * d0 + d1 * d1 + d2 * d2); wsum += c;
    }
    if (sum >= best * 49) return sum / 49 + 1e-3;            // already worse than the best, whatever the rest adds
  }
  // material of another kind than this place calls for is a poor match however alike it looks
  return sum / (wsum + 1e-6) * (1 + 0.6 * far) + (l.kind && l.kind[t] !== 255 && l.lab[s] !== l.kind[t] ? 400 : 0);
}

/** One round of search: good matches spread to neighbours, and each target tries random places near its match. */
function search(l, R, nnf, cost, rand, forward, reach) {
  const { w, h } = l, T = R.targets, n = T.length;
  for (let k = 0; k < n; k++) {
    const t = T[k], tx = t % w;            // nearest the hole's edge first
    let best = nnf[t], bd = differ(l, t, best, Infinity, R.conf);
    // what the four neighbours found, shifted by one, is a good guess here too
    for (let q = 0; q < 4; q++) {
      const dx = q === 0 ? -1 : q === 1 ? 1 : 0, dy = q === 2 ? -1 : q === 3 ? 1 : 0;
      if (tx + dx < 0 || tx + dx >= w) continue;
      const nb = t + dx + dy * w;
      if (nb < 0 || nb >= w * h || !R.near[nb]) continue;
      const c = nnf[nb] - dx - dy * w;
      if (c >= 0 && c < w * h && R.src[c] && c !== best) { const d = differ(l, t, c, bd, R.conf); if (d < bd) { bd = d; best = c; } }
    }
    // random places, in a window that halves each time
    for (let r = reach; r >= 1; r = r >> 1) {
      const bx = best % w, by = (best / w) | 0;
      const cx = bx + Math.round((rand() * 2 - 1) * r), cy = by + Math.round((rand() * 2 - 1) * r);
      if (cx < HALF || cy < HALF || cx >= w - HALF || cy >= h - HALF) continue;
      const c = cy * w + cx;
      if (!R.src[c] || c === best) continue;
      const d = differ(l, t, c, bd, R.conf);
      if (d < bd) { bd = d; best = c; }
    }
    nnf[t] = best; cost[t] = bd;
  }
}

/** Each hole pixel becomes the blend of what the squares covering it found; close matches count for more. */
function blend(l, R, nnf, cost, flat) {
  const { w, h, img, hole } = l, acc = new Float32Array(w * h * 3), wt = new Float32Array(w * h), T = R.targets;
  let mean = 0;
  if (!flat) { for (let k = 0; k < T.length; k++) mean += cost[T[k]]; mean = mean / Math.max(1, T.length); }
  const scale = flat ? 0 : 1 / (0.6 * mean + 1e-3);
  for (let k = 0; k < T.length; k++) {
    const t = T[k], s = nnf[t], tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
    const wgt = (flat ? 1 : Math.exp(-cost[t] * scale) + 1e-4) * R.conf[t];
    for (let dy = -HALF; dy <= HALF; dy++) {
      const yy = ty + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -HALF; dx <= HALF; dx++) {
        const xx = tx + dx; if (xx < 0 || xx >= w) continue;
        const p = yy * w + xx;
        if (!hole[p]) continue;
        const q = ((sy + dy) * w + sx + dx) * 3;
        acc[p * 3] += img[q] * wgt; acc[p * 3 + 1] += img[q + 1] * wgt; acc[p * 3 + 2] += img[q + 2] * wgt; wt[p] += wgt;
      }
    }
  }
  for (let p = 0; p < w * h; p++) if (hole[p] && wt[p] > 0) { img[p * 3] = acc[p * 3] / wt[p]; img[p * 3 + 1] = acc[p * 3 + 1] / wt[p]; img[p * 3 + 2] = acc[p * 3 + 2] / wt[p]; }
}

function inpaint(w, h, rgb, mask, label) {
  const top = { w, h, img: Float32Array.from(rgb), hole: Uint8Array.from(mask, v => v ? 1 : 0) };
  if (label && label.length === w * h) top.lab = label;
  let any = false, all = true;
  for (let i = 0; i < w * h; i++) { if (top.hole[i]) any = true; else all = false; }
  if (!any) return rgb;
  if (all) throw new Error('nothing around the area to fill it from');
  const levels = [top];
  while (levels.length < 7 && Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) > 40) levels.push(half(levels[levels.length - 1]));
  const rand = rng(w * 7919 + h);
  let prev = null, prevNnf = null, prevRoles = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const l = levels[li], R = roles(l);
    if (!R.sources.length) {                     // too small to hold a clean square: the creeping fill has to do at this size
      creepIn(l); prev = l; prevNnf = null; prevRoles = null; continue;
    }
    const nnf = new Int32Array(l.w * l.h), cost = new Float32Array(l.w * l.h);
    const anywhere = () => R.sources[(rand() * R.sources.length) | 0];
    if (prevNnf) {
      // start from the answer found at half size
      for (let k = 0; k < R.targets.length; k++) {
        const t = R.targets[k], x = t % l.w, y = (t / l.w) | 0;
        const cx = Math.min(prev.w - 1, x >> 1), cy = Math.min(prev.h - 1, y >> 1), ct = cy * prev.w + cx;
        let s = -1;
        if (prevRoles.near[ct]) { const ps = prevNnf[ct], sx = (ps % prev.w) * 2 + (x & 1), sy = ((ps / prev.w) | 0) * 2 + (y & 1); if (sx < l.w && sy < l.h && R.src[sy * l.w + sx]) s = sy * l.w + sx; }
        nnf[t] = s >= 0 ? s : anywhere();
      }
      blend(l, R, nnf, cost, true);
    } else {
      // The smallest size sets what goes where. Working inward from the edge, each square takes the
      // best match for the part of it that is already known and lays that match down at once, so the
      // squares further in are matched against real material rather than against a blur of the edge.
      creepIn(l);
      const known = new Float32Array(l.w * l.h);
      for (let i = 0; i < known.length; i++) known[i] = l.hole[i] ? 0 : 1;
      const S = R.sources, stride = Math.max(1, Math.floor(S.length / 4000));
      for (let k = 0; k < R.targets.length; k++) {
        const t = R.targets[k], tx = t % l.w, ty = (t / l.w) | 0;
        let best = S[0], bd = Infinity, some = false;
        for (let dy = -HALF; dy <= HALF && !some; dy++) for (let dx = -HALF; dx <= HALF; dx++) { const xx = tx + dx, yy = ty + dy; if (xx >= 0 && yy >= 0 && xx < l.w && yy < l.h && known[yy * l.w + xx]) { some = true; break; } }
        if (some) for (let q = (k % stride); q < S.length; q += stride) { const d = differ(l, t, S[q], bd, known); if (d < bd) { bd = d; best = S[q]; } }
        else best = anywhere();
        nnf[t] = best;
        const sx = best % l.w, sy = (best / l.w) | 0;
        for (let dy = -HALF; dy <= HALF; dy++) for (let dx = -HALF; dx <= HALF; dx++) {
          const xx = tx + dx, yy = ty + dy; if (xx < 0 || yy < 0 || xx >= l.w || yy >= l.h) continue;
          const p = yy * l.w + xx; if (known[p]) continue;
          const q = ((sy + dy) * l.w + sx + dx) * 3;
          l.img[p * 3] = l.img[q]; l.img[p * 3 + 1] = l.img[q + 1]; l.img[p * 3 + 2] = l.img[q + 2]; known[p] = 0.5;
        }
      }
    }
    const rounds = li === levels.length - 1 ? 10 : li === 0 ? 3 : 5;
    const reach = li === levels.length - 1 || !prevNnf ? Math.max(l.w, l.h) : Math.max(8, Math.max(l.w, l.h) >> 3);
    for (let it = 0; it < rounds; it++) {
      search(l, R, nnf, cost, rand, it % 2 === 0, reach);
      blend(l, R, nnf, cost, false);
    }
    prev = l; prevNnf = nnf; prevRoles = R;
  }
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < out.length; i++) { const v = top.img[i]; out[i] = v < 0 ? 0 : v > 255 ? 255 : v + 0.5; }
  return out;
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (ev) => {
    const m = ev.data;
    try { const rgb = inpaint(m.w, m.h, m.rgb, m.mask, m.label); self.postMessage({ id: m.id, rgb }, [rgb.buffer]); }
    catch (e) { self.postMessage({ id: m.id, error: String(e && e.message || e) }); }
  };
}
if (typeof module !== 'undefined') module.exports = { inpaint };
