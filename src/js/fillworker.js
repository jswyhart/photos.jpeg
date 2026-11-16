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
// What material of the wrong kind costs. Where the border between two kinds could be carried through the
// hole, the map of what belongs where is trusted and the cost is beyond any texture's own mismatch —
// otherwise smooth things (sky) fill everything, being a cheap match for anything. Where the map is only
// a guess (each place takes the nearest kind), it is a strong hint and the picture itself decides.
const SURE = 6000, HINT = 400;
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
  if (l.bd) { out.bd = new Float32Array(w * h); out.near = l.near; out.scale = l.scale * 2; out.pen = l.pen; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.bd[y * w + x] = l.bd[Math.min(l.h - 1, y * 2) * l.w + Math.min(l.w - 1, x * 2)]; }
  if (l.kind) { out.kind = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.kind[y * w + x] = l.kind[Math.min(l.h - 1, y * 2) * l.w + Math.min(l.w - 1, x * 2)]; }
  return out;
}

/**
 * What kind of thing each pixel should be: its own kind outside the hole; inside it, what the surroundings
 * say belongs there. Where two kinds meet at the hole's edge in exactly two places (a wall against the sky
 * behind a sign, a horizon behind a person), the border between them is carried on through the hole the way
 * it runs outside — straight on from each side, meeting in a corner if the two directions cross inside the
 * hole, otherwise straight across. In every other case each place takes the kind nearest to it.
 */
function kinds(l) {
  const { w, h, lab } = l, n = w * h, g = Uint8Array.from(lab), seen = new Uint8Array(n), painted = l.hole;
  // A kind of thing with little of it outside the hole cannot fill anything: what is left of the object
  // being removed, a sliver of something at the edge. Such kinds do not spread into the hole (255 = any
  // material will do), or the fill would be tiled from a few pixels.
  const count = new Uint32Array(256); let outside = 0;
  for (let i = 0; i < n; i++) if (!painted[i]) { count[lab[i]]++; outside++; }
  const enough = Math.max(40, outside * 0.04);
  const hole = painted;
  // the ring: pixels outside the hole that touch it
  const ring = [], onRing = new Uint8Array(n), rl = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) {
    if (hole[i]) { g[i] = 255; continue; }
    seen[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if ((x > 0 && hole[i - 1]) || (x < w - 1 && hole[i + 1]) || (y > 0 && hole[i - w]) || (y < h - 1 && hole[i + w])) { ring.push(i); onRing[i] = 1; if (count[lab[i]] >= enough) rl[i] = lab[i]; }
    if (count[lab[i]] < enough) g[i] = 255;
  }
  const around = (i, fn) => { const x = i % w, y = (i / w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) fn(yy * w + xx); } };
  // stretches of the ring whose own kind does not count (the object's remains) take the kind next to them along the ring
  { let q = ring.filter(i => rl[i] !== 255); while (q.length) { const next = []; for (const i of q) around(i, (j) => { if (onRing[j] && rl[j] === 255) { rl[j] = rl[i]; next.push(j); } }); q = next; } }

  // ---- two kinds meeting in two places: carry their border through the hole ----
  const wall = new Uint8Array(n);
  const present = [...new Set(ring.map(i => rl[i]).filter(v => v !== 255))];
  if (present.length === 2) {
    const A = present[0], B = present[1];
    // where the ring changes from one kind to the other, gathered into places
    const changes = ring.filter(i => { if (rl[i] !== A) return false; let hit = false; around(i, (j) => { if (onRing[j] && rl[j] === B) hit = true; }); return hit; });
    const places = [];
    for (const i of changes) { const x = i % w, y = (i / w) | 0; let p = places.find(q => Math.hypot(q.x / q.n - x, q.y / q.n - y) < 10); if (!p) { p = { x: 0, y: 0, n: 0 }; places.push(p); } p.x += x; p.y += y; p.n++; }
    if (places.length === 2) {
      const P = places.map(p => [p.x / p.n, p.y / p.n]);
      // which way the border runs just outside the hole at each place (a line fitted to the border there)
      const reach = Math.max(24, Math.max(w, h) * 0.12);
      const dir = P.map(([px, py]) => {
        let sx = 0, sy = 0, m = 0; const pts = [];
        const x0 = Math.max(1, Math.floor(px - reach)), x1 = Math.min(w - 2, Math.ceil(px + reach)), y0 = Math.max(1, Math.floor(py - reach)), y1 = Math.min(h - 2, Math.ceil(py + reach));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          if (hole[i] || lab[i] !== A || Math.hypot(x - px, y - py) > reach) continue;
          if ((!hole[i - 1] && lab[i - 1] === B) || (!hole[i + 1] && lab[i + 1] === B) || (!hole[i - w] && lab[i - w] === B) || (!hole[i + w] && lab[i + w] === B)) { pts.push(x, y); sx += x; sy += y; m++; }
        }
        if (m < 12) return null;
        const cx = sx / m, cy = sy / m; let a = 0, b = 0, c = 0;
        for (let k = 0; k < pts.length; k += 2) { const dx = pts[k] - cx, dy = pts[k + 1] - cy; a += dx * dx; b += dx * dy; c += dy * dy; }
        const tr = a + c, det = a * c - b * b, s = Math.sqrt(Math.max(0, tr * tr / 4 - det)), l1 = tr / 2 + s, l2 = tr / 2 - s;
        if (l1 < 6 * Math.max(1e-6, l2)) return null;                       // not a line
        let dx = b, dy = l1 - a; if (Math.abs(dx) + Math.abs(dy) < 1e-9) { dx = l1 - c; dy = b; }
        const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
        if ((px - cx) * dx + (py - cy) * dy < 0) { dx = -dx; dy = -dy; }     // pointing from outside into the hole
        return [dx, dy];
      });
      // the border inside the hole: both directions carried on to where they meet, or straight across
      let path = [P[0], P[1]];
      if (dir[0] && dir[1]) {
        const [ax, ay] = P[0], [bx, by] = P[1], [ux, uy] = dir[0], [vx, vy] = dir[1], cross = ux * vy - uy * vx;
        if (Math.abs(cross) > 0.25) {
          const t = ((bx - ax) * vy - (by - ay) * vx) / cross, s = ((bx - ax) * uy - (by - ay) * ux) / cross;
          const cx = ax + ux * t, cy = ay + uy * t, ix = Math.round(cx), iy = Math.round(cy);
          if (t > 2 && s > 2 && ix >= 0 && iy >= 0 && ix < w && iy < h && hole[iy * w + ix]) path = [P[0], [cx, cy], P[1]];
        }
      }
      // drawn three pixels thick and a little past both ends, so nothing slips round where it meets the hole's edge
      for (let k = 1; k < path.length; k++) {
        const [ax, ay] = path[k - 1], [bx, by] = path[k], len = Math.hypot(bx - ax, by - ay) || 1, steps = Math.ceil(len * 2) + 1;
        const q0 = k === 1 ? -Math.ceil(12 / len * steps) : 0, q1 = k === path.length - 1 ? steps + Math.ceil(12 / len * steps) : steps;
        for (let q = q0; q <= q1; q++) {
          const x = Math.round(ax + (bx - ax) * q / steps), y = Math.round(ay + (by - ay) * q / steps);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && hole[yy * w + xx]) wall[yy * w + xx] = 1; }
        }
      }
      l.border = path; l.pen = SURE;
    }
  }
  // every place in the hole takes the kind that reaches it first from the ring (not across a carried border)
  let q = ring.filter(i => rl[i] !== 255);
  const from = new Uint8Array(n).fill(255);
  for (const i of q) from[i] = rl[i];
  while (q.length) {
    const next = [];
    for (const i of q) {
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !seen[j] && !wall[j]) { seen[j] = 1; from[j] = from[i]; g[j] = from[i]; next.push(j); }
    }
    q = next;
  }
  // the border itself, and anything it closed off, takes what lies next to it
  for (let pass = 0; pass < 4; pass++) {
    let left = 0;
    for (let i = 0; i < n; i++) if (hole[i] && !seen[i]) { let v = 255; around(i, (j) => { if (v === 255 && hole[j] && seen[j] && g[j] !== 255) v = g[j]; }); if (v !== 255) { g[i] = v; seen[i] = 2; } else left++; }
    for (let i = 0; i < n; i++) if (seen[i] === 2) seen[i] = 1;
    if (!left) break;
  }
  // The scene map is coarse: close to where two kinds meet, a pixel's kind may be its neighbour's. Such
  // places are fine as material for the hole's own borders, but not for its open stretches — or a
  // white wall cap that the map calls sky ends up in the middle of the sky.
  const near = Math.max(6, Math.round(Math.max(w, h) * 0.02)), d = new Float32Array(n).fill(1e9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if ((x > 0 && g[i - 1] !== g[i]) || (x < w - 1 && g[i + 1] !== g[i]) || (y > 0 && g[i - w] !== g[i]) || (y < h - 1 && g[i + w] !== g[i])) d[i] = 0; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; let v = d[i]; if (x > 0) v = Math.min(v, d[i - 1] + 1); if (y > 0) v = Math.min(v, d[i - w] + 1); d[i] = v; }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const i = y * w + x; let v = d[i]; if (x < w - 1) v = Math.min(v, d[i + 1] + 1); if (y < h - 1) v = Math.min(v, d[i + w] + 1); d[i] = v; }
  if (!l.pen) l.pen = HINT;
  l.bd = d; l.near = near; l.scale = 1;          // distance to the nearest border between kinds, in pixels of this (full) size
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
  return sum / (wsum + 1e-6) * (1 + 0.6 * far) + (l.kind && l.kind[t] !== 255 ? (l.lab[s] !== l.kind[t] ? l.pen : l.pen === SURE && l.bd[s] <= l.near && l.bd[t] > (HALF + 2) * l.scale ? SURE * 0.5 : 0) : 0);
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
  if (top.lab) top.kind = kinds(top);          // what belongs where in the hole, worked out once at full size
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
if (typeof module !== 'undefined') module.exports = { inpaint, kinds };
