/* =====================================================================
 * photos.jpeg — soft proofing against a printer profile.
 *
 * A printer (with its paper and ink) can show fewer colours than a screen.
 * Its ICC profile says which: either directly (a "gamut" table), or by
 * what comes back when a colour is sent to the printer's values and read
 * again. From a profile this module works out, once, two small cubes over
 * the editor's working colours:
 *   • which colours the printer can hold — a soft-proof render marks the
 *     pixels that fall outside;
 *   • what each colour looks like printed — the paper's white, the ink's
 *     black and the colours pulled into reach — for "Show paper and ink".
 *
 * Read: ICC profiles of printers (and other devices) with table-based
 * transforms — version 2 (lut8 / lut16) and version 4 (lutAtoB / lutBtoA,
 * with their curves, matrix and grid) — whose connection space is Lab or
 * XYZ. Profiles that only hold a matrix and tone curves (screens) say
 * nothing a proof could use and are refused with a message.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, API = PJ.API, Cat = PJ.Catalog;
  const N = 41;                                   // points per side of the "can it be held" cube
  const NP = 25;                                  // … and of the "how it prints" cube
  const D50 = [0.9642, 1, 0.8249];
  const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

  /* ---------------- reading the profile ---------------- */
  function parse(bytes) {
    if (bytes.length < 132) throw new Error('That file is not a colour profile');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), sig = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (sig(36) !== 'acsp') throw new Error('That file is not a colour profile');
    const cls = sig(12), space = sig(16).trim(), pcs = sig(20).trim(), n = dv.getUint32(128), tags = {};
    for (let i = 0; i < n && 132 + i * 12 + 12 <= bytes.length; i++) tags[sig(132 + i * 12)] = [dv.getUint32(136 + i * 12), dv.getUint32(140 + i * 12)];
    let name = '';
    if (tags.desc) {
      const [o] = tags.desc;
      if (sig(o) === 'desc') { const len = dv.getUint32(o + 8); name = String.fromCharCode(...bytes.subarray(o + 12, o + 12 + Math.max(0, len - 1))); }
      else if (sig(o) === 'mluc' && dv.getUint32(o + 8) > 0) {          // version 4: the first language's text, UTF-16
        const len = dv.getUint32(o + 20), at = o + dv.getUint32(o + 24);
        for (let i = 0; i + 1 < len && at + i + 1 < bytes.length; i += 2) name += String.fromCharCode(dv.getUint16(at + i));
      }
      name = name.replace(/[^\x20-\x7e]/g, '').trim();
    }
    if (pcs !== 'Lab' && pcs !== 'XYZ') throw new Error('This profile is built on a colour space the proof cannot read');
    const s15 = (p) => dv.getInt32(p) / 65536;

    /* one tone curve ('curv' or 'para') at p → { f, size } */
    const curveAt = (p) => {
      const t = sig(p); let f, size;
      if (t === 'curv') {
        const cnt = dv.getUint32(p + 8); size = 12 + cnt * 2;
        if (cnt === 0) f = (v) => v;
        else if (cnt === 1) { const g = dv.getUint16(p + 12) / 256; f = (v) => Math.pow(clamp01(v), g); }
        else { const tb = new Float32Array(cnt); for (let i = 0; i < cnt; i++) tb[i] = dv.getUint16(p + 12 + i * 2) / 65535; f = (v) => { const x = clamp01(v) * (cnt - 1), i = Math.min(cnt - 2, x | 0); return tb[i] + (tb[i + 1] - tb[i]) * (x - i); }; }
      } else if (t === 'para') {
        const kind = dv.getUint16(p + 8), cnt = [1, 3, 4, 5, 7][kind];
        if (cnt === undefined) throw new Error('This profile has a tone curve of a kind that is not read');
        const q = []; for (let i = 0; i < cnt; i++) q.push(s15(p + 12 + i * 4));
        size = 12 + cnt * 4;
        const [g, a = 1, b = 0, c = 0, d = 0, e = 0, ff = 0] = q, pw = (x) => Math.pow(Math.max(0, a * x + b), g);
        f = kind === 0 ? (x) => Math.pow(Math.max(0, x), g)
          : kind === 1 ? (x) => x >= -b / a ? pw(x) : 0
            : kind === 2 ? (x) => x >= -b / a ? pw(x) + c : c
              : kind === 3 ? (x) => x >= d ? pw(x) : c * x
                : (x) => x >= d ? pw(x) + e : c * x + ff;
      } else throw new Error('This profile has a tone curve of a kind that is not read');
      return { f, size: (size + 3) & ~3 };
    };
    const curveSet = (p, cnt) => { const fs = []; for (let i = 0; i < cnt; i++) { const c = curveAt(p); fs.push(c.f); p += c.size; } return (v) => v.map((x, i) => fs[i](x)); };
    const matrixStage = (m) => (v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[9], m[3] * v[0] + m[4] * v[1] + m[5] * v[2] + m[10], m[6] * v[0] + m[7] * v[1] + m[8] * v[2] + m[11]];
    /* a grid of colours over inC inputs, read between its points; the first input moves slowest (as ICC stores it) */
    const gridStage = (grid, inC, outC, data) => {
      const stride = new Array(inC); let s = outC;
      for (let c = inC - 1; c >= 0; c--) { stride[c] = s; s *= grid[c]; }
      return (v) => {
        const pos = [], w = [];
        for (let c = 0; c < inC; c++) { const f = clamp01(v[c]) * (grid[c] - 1), i = Math.max(0, Math.min(grid[c] - 2, f | 0)); pos.push(i); w.push(grid[c] < 2 ? 0 : Math.max(0, Math.min(1, f - i))); }
        const out = new Array(outC).fill(0);
        for (let k = 0; k < (1 << inC); k++) {                // every corner of the cell the colour lies in
          let wt = 1, idx = 0;
          for (let c = 0; c < inC; c++) { const hi = (k >> c) & 1; wt *= hi ? w[c] : 1 - w[c]; idx += (pos[c] + hi) * stride[c]; }
          if (wt === 0) continue;
          for (let c = 0; c < outC; c++) out[c] += wt * data[idx + c];
        }
        return out;
      };
    };
    const table = (p, cnt, wide) => { const a = new Float32Array(cnt); for (let i = 0; i < cnt; i++) a[i] = wide ? dv.getUint16(p + i * 2) / 65535 : bytes[p + i] / 255; return a; };
    const tabCurves = (t, cnt, ch) => (v) => v.map((x, c) => { const f = clamp01(x) * (cnt - 1), i = Math.min(cnt - 2, f | 0); return t[c * cnt + i] + (t[c * cnt + i + 1] - t[c * cnt + i]) * (f - i); });

    /* a transform tag → { inC, outC, enc, stages } (enc: how Lab is written on its PCS side) */
    const lut = (tag) => {
      if (!tags[tag]) return null;
      const [o] = tags[tag], type = sig(o), inC = bytes[o + 8], outC = bytes[o + 9];
      if (type === 'mft2' || type === 'mft1') {
        const g = bytes[o + 10], wide = type === 'mft2', step = wide ? 2 : 1;
        let p = o + 48, nIn = 256, nOut = 256;
        if (wide) { nIn = dv.getUint16(p); nOut = dv.getUint16(p + 2); p += 4; }
        const input = table(p, inC * nIn, wide); p += inC * nIn * step;
        const cells = Math.pow(g, inC) * outC, clut = table(p, cells, wide); p += cells * step;
        const output = table(p, outC * nOut, wide);
        const stages = [];
        if (pcs === 'XYZ' && inC === 3) {                    // only used when XYZ goes in
          const m = []; for (let i = 0; i < 9; i++) m.push(s15(o + 12 + i * 4));
          if (m.some((x, i) => Math.abs(x - (i % 4 === 0 ? 1 : 0)) > 1e-4)) stages.push(matrixStage([...m, 0, 0, 0]));
        }
        stages.push(tabCurves(input, nIn, inC), gridStage(new Array(inC).fill(g), inC, outC, clut), tabCurves(output, nOut, outC));
        return { inC, outC, enc: wide ? 'old16' : 'plain', stages };
      }
      if (type === 'mAB ' || type === 'mBA ') {
        const ab = type === 'mAB ', oB = dv.getUint32(o + 12), oMat = dv.getUint32(o + 16), oM = dv.getUint32(o + 20), oC = dv.getUint32(o + 24), oA = dv.getUint32(o + 28);
        const pcsC = ab ? outC : inC, devC = ab ? inC : outC;
        const A = oA ? curveSet(o + oA, devC) : null, B = oB ? curveSet(o + oB, pcsC) : null, M = oM ? curveSet(o + oM, pcsC) : null;
        let mat = null, grid = null;
        if (oMat) { const m = []; for (let i = 0; i < 12; i++) m.push(s15(o + oMat + i * 4)); mat = matrixStage(m); }
        if (oC) {
          const gp = Array.from(bytes.subarray(o + oC, o + oC + inC)), wide = bytes[o + oC + 16] === 2;
          grid = gridStage(gp, inC, outC, table(o + oC + 20, gp.reduce((a, b) => a * b, 1) * outC, wide));
        } else if (inC !== outC) throw new Error('This profile could not be read');
        return { inC, outC, enc: 'plain', stages: (ab ? [A, grid, M, mat, B] : [B, mat, M, grid, A]).filter(Boolean) };
      }
      throw new Error('This profile has a table of a kind that is not read');
    };
    const out = { name: name || 'Printer profile', cls, space, pcs, gamt: lut('gamt'), b2a: lut('B2A1') || lut('B2A0'), a2b: lut('A2B1') || lut('A2B0'), b2aLook: lut('B2A0') || lut('B2A1'), white: D50 };
    if (tags.wtpt && sig(tags.wtpt[0]) === 'XYZ ') { const o = tags.wtpt[0], w = [s15(o + 8), s15(o + 12), s15(o + 16)]; if (w[1] > 0.4 && w[0] <= D50[0] * 1.03 && w[1] <= 1.03 && w[2] <= D50[2] * 1.03) out.white = w; }      // a paper's white; some profiles hold a light source's instead, which is not used
    if (!out.gamt && !(out.b2a && out.a2b)) throw new Error('This profile does not say which colours the device can show (it is probably a screen or camera profile)');
    return out;
  }
  /** A transform applied to `v` (inC numbers 0…1) → outC numbers 0…1. */
  function apply(l, v) { for (const st of l.stages) v = st(v); return v; }

  /* Lab ⇄ the numbers a transform expects on its connection-space side */
  const labF = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116, labFi = (t) => t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787;
  const labToXyz = (L, a, b) => { const fy = (L + 16) / 116; return [D50[0] * labFi(fy + a / 500), labFi(fy), D50[2] * labFi(fy - b / 200)]; };
  const xyzToLab = (X, Y, Z) => { const fx = labF(X / D50[0]), fy = labF(Y), fz = labF(Z / D50[2]); return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]; };
  const XYZ_SCALE = 1 + 32767 / 32768;
  function pcsIn(prof, l, L, a, b) {
    if (prof.pcs === 'XYZ') return labToXyz(L, a, b).map(v => v / XYZ_SCALE);
    return l.enc === 'old16' ? [L / 100 * (65280 / 65535), (a + 128) * 256 / 65535, (b + 128) * 256 / 65535] : [L / 100, (a + 128) / 255, (b + 128) / 255];
  }
  function pcsOut(prof, l, v) {
    if (prof.pcs === 'XYZ') return xyzToLab(v[0] * XYZ_SCALE, v[1] * XYZ_SCALE, v[2] * XYZ_SCALE);
    return l.enc === 'old16' ? [v[0] * 65535 / 65280 * 100, v[1] * 65535 / 256 - 128, v[2] * 65535 / 256 - 128] : [v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128];
  }

  /* ---------------- working colour ⇄ Lab (D50) ---------------- */
  // linear sRGB ⇄ XYZ (D50, Bradford-adapted), and P3 by way of sRGB
  const SRGB_XYZ = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
  const XYZ_SRGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.0334540, 0.0719453, -0.2289914, 1.4052427];
  const m3 = (M, x, y, z) => [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z];
  function toLab(space, r, g, b) {
    let c = [P.toLin(r), P.toLin(g), P.toLin(b)];
    if (space === 'p3') c = m3(P.P3_TO_SRGB, c[0], c[1], c[2]);
    const x = m3(SRGB_XYZ, c[0], c[1], c[2]);
    return xyzToLab(x[0], x[1], x[2]);
  }
  /** How far outside the device's colours a Lab colour lies: 0 inside, towards 1 and beyond outside. */
  function outside(prof, L, a, b, roundTrip) {
    if (prof.gamt && !roundTrip) return apply(prof.gamt, pcsIn(prof, prof.gamt, L, a, b))[0] * 4;         // the profile's own verdict: 0 inside
    const back = printed(prof, prof.b2a, L, a, b);
    // comes back further off than the profile's own accuracy allows: it was not held
    return Math.hypot(back[0] - L, back[1] - a, back[2] - b) / (2 * (prof.tolerance || 3));
  }
  /** The Lab colour that lands on the paper when (L, a, b) is sent through `fwd` to the device. */
  const printed = (prof, fwd, L, a, b) => pcsOut(prof, prof.a2b, apply(prof.a2b, apply(fwd, pcsIn(prof, fwd, L, a, b))));
  /**
   * How exactly a profile returns a colour it can certainly hold (greys), in ΔE. Old or coarse profiles are
   * several ΔE off even there; the round trip only counts as "outside" well beyond that.
   */
  function tolerance(prof) {
    if (!(prof.b2a && prof.a2b)) return 3;
    const d = [];
    for (let L = 20; L <= 90; L += 10) { const back = printed(prof, prof.b2a, L, 0, 0); d.push(Math.hypot(back[0] - L, back[1], back[2])); }
    d.sort((p, q) => p - q);
    return Math.max(3, 2 * d[d.length >> 1] + 1.5);
  }
  /**
   * How the working colours look printed: { n, srgb, p3 }, each Float32Array(n³·3) of working-space values.
   * The colour goes to the printer the way a print is usually made (the profile's perceptual table), what the
   * paper then shows is read back, and the paper's own white is kept — so white is the paper, black is the ink.
   */
  function paperTables(prof) {
    if (!(prof.b2aLook && prof.a2b)) return null;
    const W = prof.white, mk = (space) => {
      const t = new Float32Array(NP * NP * NP * 3); let i = 0;
      for (let b = 0; b < NP; b++) for (let g = 0; g < NP; g++) for (let r = 0; r < NP; r++) {
        const lab = toLab(space, r / (NP - 1), g / (NP - 1), b / (NP - 1)), back = printed(prof, prof.b2aLook, lab[0], lab[1], lab[2]);
        const x = labToXyz(back[0], back[1], back[2]);
        let c = m3(XYZ_SRGB, x[0] * W[0] / D50[0], x[1] * W[1], x[2] * W[2] / D50[2]);
        if (space === 'p3') c = m3(P.SRGB_TO_P3, c[0], c[1], c[2]);
        t[i++] = P.toSrgb(clamp01(c[0])); t[i++] = P.toSrgb(clamp01(c[1])); t[i++] = P.toSrgb(clamp01(c[2]));
      }
      return t;
    };
    return { n: NP, srgb: mk('srgb'), p3: mk('p3') };
  }
  /** The cubes a render uses: { n, srgb: Float32Array(n³), p3: Float32Array(n³), paper }, values ≥ 0.5 = outside. */
  function tables(prof) {
    const mk = (space, rt) => { const t = new Float32Array(N * N * N); let i = 0; for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) { const lab = toLab(space, r / (N - 1), g / (N - 1), b / (N - 1)); t[i++] = Math.min(4, outside(prof, lab[0], lab[1], lab[2], rt)); } return t; };
    prof.tolerance = tolerance(prof);
    let srgb = mk('srgb', false), rt = false;
    // some profiles carry a gamut table that marks nothing at all (a placeholder): then the round trip decides
    if (prof.gamt && prof.b2a && prof.a2b && !srgb.some(v => v >= 0.5)) { rt = true; srgb = mk('srgb', true); }
    return { n: N, srgb, p3: mk('p3', rt), roundTrip: rt || !prof.gamt, paper: paperTables(prof) };
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

  global.PJ.Proof = { parse, tables, add, remove, get, getSync, list, key, _test: { apply, toLab, outside, printed, labToXyz, xyzToLab } };
})(window);
