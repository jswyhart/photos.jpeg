/* =====================================================================
 * photos.jpeg — soft proofing against a printer profile.
 *
 * A printer (with its paper and ink) can show fewer colours than a screen.
 * Its ICC profile says which: either directly (a "gamut" table), or by
 * what comes back when a colour is sent to the printer's values and read
 * again. From a profile this module works out, once, a small cube over the
 * editor's working colours that says for each whether the printer can hold
 * it; a soft-proof render marks the pixels that fall outside.
 *
 * Read: ICC version 2 profiles of printers (and other devices) whose
 * tables are of the lut8 / lut16 kind with a Lab connection space — which
 * is what printer and paper makers ship. Version 4 "mAB" tables and
 * XYZ-based tables are not read; such a profile is refused with a message.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, API = PJ.API, Cat = PJ.Catalog;
  const N = 41;                                   // points per side of the cube

  /* ---------------- reading the profile ---------------- */
  function parse(bytes) {
    if (bytes.length < 132) throw new Error('That file is not a colour profile');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), sig = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (sig(36) !== 'acsp') throw new Error('That file is not a colour profile');
    const cls = sig(12), space = sig(16).trim(), pcs = sig(20).trim(), n = dv.getUint32(128), tags = {};
    for (let i = 0; i < n && 132 + i * 12 + 12 <= bytes.length; i++) tags[sig(132 + i * 12)] = [dv.getUint32(136 + i * 12), dv.getUint32(140 + i * 12)];
    let name = '';
    if (tags.desc) { const [o] = tags.desc; if (sig(o) === 'desc') { const len = dv.getUint32(o + 8); name = String.fromCharCode(...bytes.subarray(o + 12, o + 12 + Math.max(0, len - 1))).replace(/[^\x20-\x7e]/g, '').trim(); } }
    const lut = (tag) => {
      if (!tags[tag]) return null;
      const [o] = tags[tag], type = sig(o);
      if (type !== 'mft2' && type !== 'mft1') throw new Error('This profile uses a newer kind of table (version 4) that is not read yet');
      const inC = bytes[o + 8], outC = bytes[o + 9], g = bytes[o + 10], wide = type === 'mft2';
      let p = o + 48, nIn = 256, nOut = 256;
      if (wide) { nIn = dv.getUint16(p); nOut = dv.getUint16(p + 2); p += 4; }
      const rd = wide ? (q) => dv.getUint16(q) / 65535 : (q) => bytes[q] / 255, step = wide ? 2 : 1;
      const take = (count) => { const a = new Float32Array(count); for (let i = 0; i < count; i++, p += step) a[i] = rd(p); return a; };
      const input = take(inC * nIn), clut = take(Math.pow(g, inC) * outC), output = take(outC * nOut);
      return { inC, outC, g, nIn, nOut, input, clut, output, wide };
    };
    if (pcs !== 'Lab') throw new Error('This profile is not built on Lab colour, which the proof needs');
    const out = { name: name || 'Printer profile', cls, space, gamt: lut('gamt'), b2a: lut('B2A1') || lut('B2A0'), a2b: lut('A2B1') || lut('A2B0') };
    if (!out.gamt && !(out.b2a && out.a2b)) throw new Error('This profile does not say which colours the device can show');
    return out;
  }
  const curve = (t, n, c, v) => { const f = (v < 0 ? 0 : v > 1 ? 1 : v) * (n - 1), i = Math.min(n - 2, f | 0); return t[c * n + i] + (t[c * n + i + 1] - t[c * n + i]) * (f - i); };
  /** A lut8 / lut16 table applied to `v` (inC numbers 0…1) → outC numbers 0…1. */
  function apply(l, v) {
    const { inC, outC, g } = l, pos = [], w = [];
    for (let c = 0; c < inC; c++) { const f = curve(l.input, l.nIn, c, v[c]) * (g - 1), i = Math.min(g - 2, Math.max(0, f | 0)); pos.push(i); w.push(Math.max(0, Math.min(1, f - i))); }
    const out = new Array(outC).fill(0);
    for (let k = 0; k < (1 << inC); k++) {                    // every corner of the cell the colour lies in
      let wt = 1, idx = 0;
      for (let c = 0; c < inC; c++) { const hi = (k >> c) & 1; wt *= hi ? w[c] : 1 - w[c]; idx = idx * g + pos[c] + hi; }
      if (wt === 0) continue;
      for (let c = 0; c < outC; c++) out[c] += wt * l.clut[idx * outC + c];
    }
    for (let c = 0; c < outC; c++) out[c] = curve(l.output, l.nOut, c, out[c]);
    return out;
  }
  /* Lab ⇄ the numbers a version-2 table expects */
  const labIn = (l, L, a, b) => l.wide ? [L / 100 * (65280 / 65535), (a + 128) * 256 / 65535, (b + 128) * 256 / 65535] : [L / 100, (a + 128) / 255, (b + 128) / 255];
  const labOut = (l, v) => l.wide ? [v[0] * 65535 / 65280 * 100, v[1] * 65535 / 256 - 128, v[2] * 65535 / 256 - 128] : [v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128];

  /* ---------------- working colour → Lab (D50) ---------------- */
  // linear sRGB → XYZ (D50, Bradford-adapted), and P3 by way of sRGB
  const SRGB_XYZ = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
  function toLab(space, r, g, b) {
    let lr = P.toLin(r), lg = P.toLin(g), lb = P.toLin(b);
    if (space === 'p3') { const M = P.P3_TO_SRGB, x = M[0] * lr + M[1] * lg + M[2] * lb, y = M[3] * lr + M[4] * lg + M[5] * lb, z = M[6] * lr + M[7] * lg + M[8] * lb; lr = x; lg = y; lb = z; }
    const S = SRGB_XYZ, X = S[0] * lr + S[1] * lg + S[2] * lb, Y = S[3] * lr + S[4] * lg + S[5] * lb, Z = S[6] * lr + S[7] * lg + S[8] * lb;
    const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116, fx = f(X / 0.9642), fy = f(Y), fz = f(Z / 0.8249);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  /** How far outside the device's colours a Lab colour lies: 0 inside, towards 1 and beyond outside. */
  function outside(prof, L, a, b, roundTrip) {
    if (prof.gamt && !roundTrip) return apply(prof.gamt, labIn(prof.gamt, L, a, b))[0] * 4;         // the profile's own verdict: 0 inside
    const dev = apply(prof.b2a, labIn(prof.b2a, L, a, b)), back = labOut(prof.a2b, apply(prof.a2b, dev));
    // comes back further off than the profile's own accuracy allows: it was not held
    return Math.hypot(back[0] - L, back[1] - a, back[2] - b) / (2 * (prof.tolerance || 3));
  }
  /**
   * How exactly a profile returns a colour it can certainly hold (greys), in ΔE. Old or coarse profiles are
   * several ΔE off even there; the round trip only counts as "outside" well beyond that.
   */
  function tolerance(prof) {
    if (!(prof.b2a && prof.a2b)) return 3;
    const d = [];
    for (let L = 20; L <= 90; L += 10) { const dev = apply(prof.b2a, labIn(prof.b2a, L, 0, 0)), back = labOut(prof.a2b, apply(prof.a2b, dev)); d.push(Math.hypot(back[0] - L, back[1], back[2])); }
    d.sort((p, q) => p - q);
    return Math.max(3, 2 * d[d.length >> 1] + 1.5);
  }
  /** The cubes a render uses: { n, srgb: Float32Array(n³), p3: Float32Array(n³) }, values ≥ 0.5 = outside. */
  function tables(prof) {
    const mk = (space, rt) => { const t = new Float32Array(N * N * N); let i = 0; for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) { const lab = toLab(space, r / (N - 1), g / (N - 1), b / (N - 1)); t[i++] = Math.min(4, outside(prof, lab[0], lab[1], lab[2], rt)); } return t; };
    prof.tolerance = tolerance(prof);
    let srgb = mk('srgb', false), rt = false;
    // some profiles carry a gamut table that marks nothing at all (a placeholder): then the round trip decides
    if (prof.gamt && prof.b2a && prof.a2b && !srgb.some(v => v >= 0.5)) { rt = true; srgb = mk('srgb', true); }
    return { n: N, srgb, p3: mk('p3', rt), roundTrip: rt || !prof.gamt };
  }

  /* ---------------- the profiles you have loaded ---------------- */
  const cache = new Map();                          // id → { name, tables }
  const list = () => Cat.pref('proof.profiles', []) || [];
  const key = (id) => 'icc_' + id;
  /** Take in a profile file's bytes: checked, kept beside the thumbnails, added to the list. Resolves to { id, name }. */
  async function add(bytes, fileName) {
    const prof = parse(bytes), id = Cat.uid('pr');
    const name = prof.name !== 'Printer profile' ? prof.name : String(fileName || 'Printer profile').replace(/\.[^.]+$/, '');
    cache.set(id, { name, tables: tables(prof) });
    if (API.hasThumbStore && API.saveThumb) await API.saveThumb(key(id), bytes);
    Cat.setPref('proof.profiles', [...list().filter(p => p.name !== name), { id, name }]);
    return { id, name };
  }
  function remove(id) { cache.delete(id); Cat.setPref('proof.profiles', list().filter(p => p.id !== id)); if (API.deleteThumb) API.deleteThumb(key(id)).catch(() => { }); }
  /** The cubes of a loaded profile (read again from disk after a restart). */
  async function get(id) {
    if (cache.has(id)) return cache.get(id).tables;
    const it = list().find(p => p.id === id);
    if (!it || !API.hasThumbStore) return null;
    const r = await fetch(API.thumbUrl(key(id), 1));
    if (!r.ok) return null;
    const t = tables(parse(new Uint8Array(await r.arrayBuffer())));
    cache.set(id, { name: it.name, tables: t });
    return t;
  }
  const getSync = (id) => cache.has(id) ? cache.get(id).tables : null;

  global.PJ.Proof = { parse, tables, add, remove, get, getSync, list, key, _test: { apply, toLab, outside } };
})(window);
