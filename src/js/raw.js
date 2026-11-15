/* =====================================================================
 * photos.jpeg — RAW development on the UI side: runs the worker decoder
 * (rawdec.js) and matches colour and tone to the camera's embedded JPEG:
 *   • white balance  — as shot (DNG) or solved from neutral areas of the preview
 *   • camera → sRGB  — Adobe matrix for the model, or fitted to the preview
 *   • base tone curve and saturation fitted to the preview, so a RAW opens
 *     looking like the camera's JPEG but keeps the sensor's highlights and bit depth
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, Dec = PJ.Decode;
  const DECODABLE = new Set(['nef', 'nrw', 'cr2', 'arw', 'srf', 'sr2', 'dng']);
  const EXPOSURE = 6; // neutral raw white → 6 on the 0…16 rawlog scale; saturated colours keep ~1.4 stops of headroom

  function canDecode(name) { return DECODABLE.has(Dec.ext(name)); }

  const lin8 = P.SRGB8_TO_LIN;
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const mulv = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1e-12;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  /** Least squares 3×3 with each row summing to 1 (neutrals stay neutral): minimise |M x − y|² */
  function fitMatrixRowsSumOne(X, Y, wts) {
    const M = [];
    for (let r = 0; r < 3; r++) {
      // substitute m2 = 1 − m0 − m1:  y − x2 = m0 (x0 − x2) + m1 (x1 − x2)
      let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
      for (let k = 0; k < X.length; k++) {
        const x = X[k], w = wts ? wts[k] : 1, u = x[0] - x[2], v = x[1] - x[2], t = Y[k][r] - x[2];
        a00 += w * u * u; a01 += w * u * v; a11 += w * v * v; b0 += w * u * t; b1 += w * v * t;
      }
      const det = a00 * a11 - a01 * a01;
      if (Math.abs(det) < 1e-12) { M.push(r === 0 ? 1 : 0, r === 1 ? 1 : 0, r === 2 ? 1 : 0); continue; }
      const m0 = (b0 * a11 - b1 * a01) / det, m1 = (a00 * b1 - a01 * b0) / det;
      M.push(m0, m1, 1 - m0 - m1);
    }
    return M;
  }

  /** Preview → per-cell linear means in the RAW's (unrotated) grid; null cells where detail is busy. */
  function previewCells(image, orientation, gw, gh, rawAspect) {
    const sw = gw * 4, sh = gh * 4;
    const c = Dec.makeCanvas(sw, sh), x = c.getContext('2d', { willReadFrequently: true });
    // undo the orientation so preview pixels line up with the sensor grid
    const pw = image.width, ph = image.height;
    x.save();
    const T = {
      3: [-1, 0, 0, -1, sw, sh], 6: [0, -1, 1, 0, 0, sh], 8: [0, 1, -1, 0, sw, 0],
      2: [-1, 0, 0, 1, sw, 0], 4: [1, 0, 0, -1, 0, sh], 5: [0, 1, 1, 0, 0, 0], 7: [0, -1, -1, 0, sw, sh]
    }[orientation];
    if (T) x.setTransform(...T);
    const rot = orientation >= 5;
    const dw = rot ? sh : sw, dh = rot ? sw : sh;
    // the preview usually covers the RAW's crop minus a few pixels: match aspect by trimming
    const pa = pw / ph, ra = rot ? 1 / rawAspect : rawAspect;
    let sx = 0, sy = 0, sWd = pw, sHt = ph;
    if (pa > ra * 1.01) { sWd = ph * ra; sx = (pw - sWd) / 2; } else if (pa < ra / 1.01) { sHt = pw / ra; sy = (ph - sHt) / 2; }
    x.drawImage(image, sx, sy, sWd, sHt, 0, 0, dw, dh);
    x.restore();
    const d = x.getImageData(0, 0, sw, sh).data;
    const out = new Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const m = [0, 0, 0], q = [0, 0, 0];
      let clip = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const o = ((gy * 4 + j) * sw + gx * 4 + i) * 4;
        for (let k = 0; k < 3; k++) { const v = lin8[d[o + k]]; m[k] += v; q[k] += v * v; if (d[o + k] >= 250) clip++; }
      }
      for (let k = 0; k < 3; k++) m[k] /= 16;
      const varY = [0, 1, 2].reduce((a, k) => a + Math.max(0, q[k] / 16 - m[k] * m[k]), 0);
      out[gy * gw + gx] = { lin: m, busy: varY > 0.004 + 0.05 * luma(m[0], m[1], m[2]) ** 2, clip: clip > 0 };
    }
    return out;
  }

  /** Monotone base curve y = T(x) from (x, y) samples, x in scene units (0…16), y display-linear. */
  function fitCurve(xs, ys) {
    const pts = [];
    if (xs.length >= 24) {
      const lx = xs.map(v => Math.log2(Math.max(1e-5, v)));
      const lo = Math.max(-12, Math.min(...lx)), hi = Math.max(...lx);
      const nb = 24, bins = Array.from({ length: nb }, () => []);
      lx.forEach((v, i) => { const b = Math.min(nb - 1, Math.floor((v - lo) / Math.max(1e-6, hi - lo) * nb)); bins[b].push(i); });
      for (const b of bins) if (b.length >= 3) pts.push([median(b.map(i => xs[i])), median(b.map(i => ys[i]))]);
    }
    if (pts.length < 4) return null;
    // pool-adjacent-violators: make y non-decreasing
    const blocks = pts.map(p => ({ x: p[0], y: p[1], n: 1 }));
    for (let i = 1; i < blocks.length;) {
      if (blocks[i].y < blocks[i - 1].y) {
        const a = blocks[i - 1], b = blocks[i], n = a.n + b.n;
        blocks.splice(i - 1, 2, { x: (a.x * a.n + b.x * b.n) / n, y: (a.y * a.n + b.y * b.n) / n, n });
        if (i > 1) i--;
      } else i++;
    }
    return blocks.map(b => [b.x, b.y]);
  }
  /** Rawlog code (0…255) → display-linear via the fitted curve, with a soft shoulder above the data. */
  function curveLut(pts) {
    const decode = P.INPUT_PROFILES.rawlog.decode;
    const lut = new Float32Array(256);
    const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
    const prev = pts.length > 1 ? pts[pts.length - 2] : [x1 / 2, y1 / 2];
    const slope = Math.max(0.02, (y1 - prev[1]) / Math.max(1e-6, x1 - prev[0]));
    for (let i = 0; i < 256; i++) {
      const x = decode(i / 255);
      let y;
      if (x <= x0) y = y0 * (x / x0);
      else if (x >= x1) { const room = Math.max(0.0, 1.02 - y1); y = y1 + room * (1 - Math.exp(-(x - x1) * slope / Math.max(1e-3, room))); }
      else {
        let k = 1; while (k < pts.length - 1 && pts[k][0] < x) k++;
        const [a, ya] = pts[k - 1], [b, yb] = pts[k];
        const t = (Math.log2(x) - Math.log2(a)) / Math.max(1e-6, Math.log2(b) - Math.log2(a));
        y = ya + (yb - ya) * t;
      }
      lut[i] = Math.max(0, y);
    }
    for (let i = 1; i < 256; i++) if (lut[i] < lut[i - 1]) lut[i] = lut[i - 1];
    return lut;
  }
  /** Fallback base look when the preview is unusable: gentle filmic curve. */
  function defaultLut() {
    const decode = P.INPUT_PROFILES.rawlog.decode;
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = decode(i / 255) / EXPOSURE * 2.2; // camera-white ≈ 2.2 stops above mid-grey anchor
      const t = x / (x + 0.6);
      lut[i] = Math.min(1.02, t * 1.25);
    }
    return lut;
  }

  /**
   * Develop a RAW file. Returns { pixels, input, width, height, note } or throws (caller falls back to the preview).
   * preview: the decoded embedded JPEG (upright) used to match colour.
   */
  async function develop(photo, bytes, preview, opts) {
    const pool = PJ.Engine.pool;
    const key = photo.path + '|' + (opts && opts.half ? 'h' : 'f') + '|' + Date.now();
    const buf = bytes.slice().buffer;
    const a = await pool.task({ op: 'rawA', key, buffer: buf }, [buf], 1);
    const info = a.raw, worker = a.worker;
    const gw = info.gw, gh = info.gh, orientation = info.orientation || 1;
    const cam = [];
    for (let i = 0; i < gw * gh; i++) cam.push([info.cells[i * 4], info.cells[i * 4 + 1], info.cells[i * 4 + 2], info.cells[i * 4 + 3]]);
    const pv = preview && preview.image ? previewCells(preview.image, orientation, gw, gh, info.width / info.height) : null;

    // usable cells: both sides unclipped, not busy, not black
    const use = [];
    for (let i = 0; i < cam.length; i++) {
      const c = cam[i], p = pv && pv[i];
      if (!p || p.busy || p.clip || c[3] > 0.001) continue;
      if (c[1] < 0.002 || luma(p.lin[0], p.lin[1], p.lin[2]) < 0.004) continue;
      use.push(i);
    }
    // 1. white balance (camera space multipliers)
    let wb = info.asShot ? info.asShot.slice() : null, wbSource = wb ? 'as shot' : '';
    let m = info.m;
    if (!wb && pv && use.length > 20) {
      // neutral reference: preview pixels that are grey (after the camera's own WB)
      const toCam = m ? inv3(m) : null;
      const rr = [], bb = [];
      for (const i of use) {
        const p = pv[i].lin, s = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]);
        if (s < 0.01 || (s - mn) / s > 0.25) continue;
        const t = toCam ? mulv(toCam, p) : p;     // what WB'd camera values should be
        const c = cam[i];
        if (c[0] <= 0 || c[2] <= 0 || t[1] <= 0) continue;
        rr.push((t[0] / t[1]) / (c[0] / c[1])); bb.push((t[2] / t[1]) / (c[2] / c[1]));
      }
      if (rr.length > 8) { wb = [median(rr), 1, median(bb)]; wbSource = 'matched to camera'; }
    }
    if (!wb && pv && use.length > 20) {
      // few neutral areas (night, single-colour scenes): match the average colour instead
      const toCam = m ? inv3(m) : null, sc = [0, 0, 0], st = [0, 0, 0];
      for (const i of use) { const t = toCam ? mulv(toCam, pv[i].lin) : pv[i].lin; for (let k = 0; k < 3; k++) { sc[k] += cam[i][k]; st[k] += Math.max(0, t[k]); } }
      if (sc[0] > 0 && sc[2] > 0 && st[1] > 0) { wb = [(st[0] / st[1]) / (sc[0] / sc[1]), 1, (st[2] / st[1]) / (sc[2] / sc[1])]; wbSource = 'matched to camera'; }
    }
    if (!wb) { wb = info.daylight ? info.daylight.slice() : [2, 1, 1.5]; wbSource = 'daylight'; }
    // 2. camera → sRGB: Adobe matrix, or fitted when the model isn't known
    const wbCam = (c) => [c[0] * wb[0], c[1] * wb[1], c[2] * wb[2]];
    if (!m) {
      if (pv && use.length > 30) {
        const X = [], Y = [];
        for (const i of use) { const x = wbCam(cam[i]), s = x[0] + x[1] + x[2], p = pv[i].lin, t = p[0] + p[1] + p[2]; if (s > 0 && t > 0) { X.push(x.map(v => v / s)); Y.push(p.map(v => v / t)); } }
        m = fitMatrixRowsSumOne(X, Y);
      } else m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
    const minWb = Math.min(...wb);
    // scene values exactly as the worker will produce them
    const scene = (c) => mulv(m, wbCam(c).map(v => v / minWb)).map(v => v * EXPOSURE);
    // 3. tone: luma of scene vs luma of the preview
    let lut = null, curvePts = null;
    if (pv && use.length > 30) {
      const xs = [], ys = [];
      for (const i of use) { const s = scene(cam[i]), p = pv[i].lin, xl = luma(s[0], s[1], s[2]); if (xl > 0) { xs.push(xl); ys.push(luma(p[0], p[1], p[2])); } }
      curvePts = fitCurve(xs, ys);
      if (curvePts) lut = curveLut(curvePts);
    }
    if (!lut) lut = defaultLut();
    // Safety net for decoders we couldn't test on every camera: the developed image must look like
    // the camera's own JPEG (same light and dark areas); otherwise use the JPEG instead.
    if (pv && use.length >= 30) {
      const a2 = [], b2 = [];
      for (const i of use) { const sc = scene(cam[i]), p = pv[i].lin; a2.push(Math.log2(1e-4 + luma(sc[0], sc[1], sc[2]))); b2.push(Math.log2(1e-4 + luma(p[0], p[1], p[2]))); }
      const ma = a2.reduce((x, y) => x + y, 0) / a2.length, mb = b2.reduce((x, y) => x + y, 0) / b2.length;
      let sab = 0, saa = 0, sbb = 0;
      for (let k = 0; k < a2.length; k++) { const da = a2[k] - ma, db = b2[k] - mb; sab += da * db; saa += da * da; sbb += db * db; }
      const corr = sab / Math.sqrt(saa * sbb || 1);
      if (corr < 0.8) throw new Error(`decoded RAW doesn't match the camera preview (r=${corr.toFixed(2)})`);
    }
    // 4. colour: saturation/hue matrix after the curve (the camera's picture style), regularised
    let S = null;
    if (pv && lut && use.length > 40) {
      const T = (v) => { const code = Math.max(0, Math.min(255, P.rawLogEncode(v) * 255)), i0 = code | 0, i1 = Math.min(255, i0 + 1); return lut[i0] + (lut[i1] - lut[i0]) * (code - i0); };
      const X = [], Y = [], W = [];
      for (const i of use) {
        const s = scene(cam[i]).map(T), p = pv[i].lin;
        const ls = luma(s[0], s[1], s[2]), lp = luma(p[0], p[1], p[2]);
        if (ls < 0.03 || lp < 0.03 || lp > 0.85) continue;
        X.push(s.map(v => v / ls)); Y.push(p.map(v => v / lp));
        const sat = Math.max(...p) - Math.min(...p);
        W.push(0.3 + sat / Math.max(0.01, lp));
      }
      if (X.length > 60) {
        const F = fitMatrixRowsSumOne(X, Y, W);
        // keep it believable: blend towards identity, small cross-talk only, rows still sum to 1
        const C = F.map((v, k) => { const id = k % 4 === 0 ? 1 : 0; return id + (v - id) * 0.7; });
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) if (r !== c) C[r * 3 + c] = Math.max(-0.15, Math.min(0.15, C[r * 3 + c]));
          C[r * 4] = 1 - (C[r * 3] + C[r * 3 + 1] + C[r * 3 + 2] - C[r * 4]);
        }
        // only keep it when it clearly explains the camera's colour better than no matrix
        const err = (M) => X.reduce((a, x, k) => { const y = M ? mulv(M, x) : x; return a + W[k] * ((y[0] - Y[k][0]) ** 2 + (y[1] - Y[k][1]) ** 2 + (y[2] - Y[k][2]) ** 2); }, 0);
        if (err(C) < err(null) * 0.85) S = C;
      }
    }
    // colour noise cleanup scaled by ISO (the camera's JPEG does the same)
    const iso = preview && preview.exif && +preview.exif.iso || 400;
    const chromaNR = iso >= 1600 ? 0.95 : iso >= 800 ? 0.85 : iso >= 400 ? 0.65 : 0.4;
    // the developed pixels are kept in Display P3 primaries, so colours a camera sees beyond sRGB survive
    // (everything above was fitted against the camera's sRGB preview, and stays in sRGB terms)
    const devOpts = { wb, m: P.mul3(P.SRGB_TO_P3, m), exposure: EXPOSURE, half: !!(opts && opts.half), orientation, chromaNR };
    let b = null;
    // Bayer files are demosaiced in horizontal strips on every worker at once
    if (a.raw.parallel && P.SHARED && !devOpts.half && pool.workers.length > 1) {
      try { b = await developStrips(pool, key, worker, info, devOpts); }
      catch (e) { console.warn('parallel RAW development failed, using one worker:', e && e.message); b = null; }
    }
    if (!b) try { b = await pool.task({ op: 'rawB', key, opts: devOpts }, [], 1, worker); }
    catch (e) {
      if (!/raw-not-cached/.test(String(e.message))) throw e;
      const buf2 = bytes.slice().buffer;
      b = await pool.task({ op: 'rawB', key, opts: devOpts, buffer: buf2 }, [buf2], 1);
    }
    const pixels = { data: new Uint8ClampedArray(b.buffer), width: b.width, height: b.height };
    PJ.Raw.lastFit = { name: photo.name, wb, m, S, curvePts, cells: use.length };
    return {
      pixels, width: b.width, height: b.height,
      input: { lut, matrix: S, space: 'p3' },
      note: `RAW · ${info.model || info.make}${info.matrixSource ? '' : ' (colour fitted)'} · WB ${wbSource}`,
      fit: { wb, curvePts, cells: use.length, matrix: info.matrixSource }
    };
  }

  let gpuOk = true;   // cleared for the session after the first failed attempt
  /** Develop the mosaic held by `worker` in strips across the pool. Resolves like the rawB task: { buffer, width, height }. */
  async function developStrips(pool, key, worker, info, devOpts) {
    const sh = await pool.task({ op: 'rawShare', key }, [], 1, worker);
    const w = info.width, h = info.height;
    const out = new SharedArrayBuffer(w * h * 4);
    const n = Math.max(1, Math.min(pool.workers.length, Math.floor(h / 256)));
    const opts = { wb: devOpts.wb, m: devOpts.m, exposure: devOpts.exposure, chromaNR: devOpts.chromaNR, nrRadius: Math.max(1, Math.round(Math.max(w, h) / 1600)) };
    const shared = { info: sh.info, mosaic: sh.mosaic, out };
    // The graphics card does the whole image in one go (Windows app; "raw.gpu" preference turns it
    // off). If it can't — no usable GPU, an unusual sensor layout — the CPU strips below take over.
    let onGpu = false;
    if (gpuOk && PJ.API.platform === 'windows' && PJ.Catalog.pref('raw.gpu', true) !== false) {
      try { const g = await pool.task({ op: 'rawGpu', shared, opts }, [], 1); onGpu = !!(g && g.ok); if (!onGpu) gpuOk = false; }
      catch (_) { gpuOk = false; }
    }
    PJ.Raw.lastEngine = onGpu ? 'gpu' : 'cpu';
    const jobs = [];
    if (!onGpu)
    for (let i = 0; i < n; i++) {
      const rows = [Math.floor(h * i / n), Math.floor(h * (i + 1) / n)];
      jobs.push(pool.task({ op: 'rawStrip', shared, opts: Object.assign({ rows }, opts) }, [], 1));
    }
    await Promise.all(jobs);
    if (devOpts.orientation && devOpts.orientation !== 1) return pool.task({ op: 'orient', buffer: out, width: w, height: h, orientation: devOpts.orientation }, [], 1);
    return { buffer: out, width: w, height: h };
  }

  /** Scene-linear colour of a source pixel (for WB picker / auto WB on RAW sources). */
  function sourceLinear(input, r8, g8, b8) {
    const lut = input.lut, M = input.matrix;
    let r = lut[r8], g = lut[g8], b = lut[b8];
    if (M) { const v = mulv(M, [r, g, b]); r = v[0]; g = v[1]; b = v[2]; }
    return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
  }

  global.PJ.Raw = { canDecode, develop, sourceLinear, DECODABLE };
})(window);
