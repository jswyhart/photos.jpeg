/* =====================================================================
 * photos.jpeg — CinemaDNG: sequence grouping, DNG/LJ92 decoding, demosaic.
 * Frames decode in parallel workers to 8-bit "rawlog" (scene-linear 0…16 in a
 * log encoding, see Pipeline.INPUT_PROFILES.rawlog) so RAW highlight latitude
 * survives into grading on both the CPU and GPU paths.
 * ===================================================================== */
(function (global) {
  'use strict';
  const API = PJ.API, Dec = PJ.Decode, P = PJ.Pipeline;

  /* ---------------- worker (self-contained source) ---------------- */
  function workerMain() {
    /* global self */
    const T = { NewSubFileType: 254, Width: 256, Height: 257, Bits: 258, Compression: 259, Photometric: 262, StripOffsets: 273, SPP: 277, RowsPerStrip: 278, StripByteCounts: 279, TileWidth: 322, TileLength: 323, TileOffsets: 324, TileByteCounts: 325, SubIFDs: 330, CFADim: 33421, CFAPattern: 33422, LinTable: 50712, BlackRepeat: 50713, Black: 50714, BlackDH: 50715, BlackDV: 50716, White: 50717, CM1: 50721, CM2: 50722, Neutral: 50728, BaselineExp: 50730, Illum1: 50778, Illum2: 50779, ActiveArea: 50829, CropOrigin: 50719, CropSize: 50720, FrameRate: 51044, Orientation: 274 };

    function parseTiff(buf) {
      const v = new DataView(buf);
      const le = v.getUint16(0) === 0x4949;
      const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
      const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
      function readVal(type, off, i) {
        switch (type) {
          case 1: case 7: case 2: return v.getUint8(off + i);
          case 6: return v.getInt8(off + i);
          case 3: return u16(off + i * 2);
          case 8: return v.getInt16(off + i * 2, le);
          case 4: case 13: return u32(off + i * 4);
          case 9: return v.getInt32(off + i * 4, le);
          case 5: { const n = u32(off + i * 8), d = u32(off + i * 8 + 4); return d ? n / d : 0; }
          case 10: { const n = v.getInt32(off + i * 8, le), d = v.getInt32(off + i * 8 + 4, le); return d ? n / d : 0; }
          case 11: return v.getFloat32(off + i * 4, le);
          case 12: return v.getFloat64(off + i * 8, le);
        }
        return 0;
      }
      function ifd(off) {
        const n = u16(off), tags = {};
        for (let i = 0; i < n; i++) {
          const e = off + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
          const size = (SZ[type] || 1) * count;
          const voff = size <= 4 ? e + 8 : u32(e + 8);
          if (voff + size > buf.byteLength) continue;
          const arr = [];
          const lim = Math.min(count, tag === T.LinTable ? 65536 : 4096);
          for (let k = 0; k < lim; k++) arr.push(readVal(type, voff, k));
          tags[tag] = arr;
        }
        return { tags, next: u32(off + 2 + n * 12) };
      }
      const first = ifd(u32(4));
      const all = [first.tags];
      (first.tags[T.SubIFDs] || []).forEach(o => { try { all.push(ifd(o).tags); } catch (_) { } });
      // raw image: NewSubFileType 0 with CFA photometric
      const raw = all.find(t => (t[T.NewSubFileType] || [0])[0] === 0 && (t[T.Photometric] || [0])[0] === 32803) || all.find(t => (t[T.Photometric] || [0])[0] === 32803) || all[0];
      return { le, ifd0: first.tags, raw };
    }

    /* ---- lossless JPEG (ITU T.81 process 14), as used by DNG ---- */
    function lj92(bytes) {
      let p = 2, frame = null, scan = null, dri = 0;
      const huff = [];
      while (p < bytes.length) {
        if (bytes[p] !== 0xFF) { p++; continue; }
        const m = bytes[p + 1];
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
        const len = (bytes[p + 2] << 8) | bytes[p + 3];
        const s = p + 4;
        if (m === 0xC4) {
          let q = s;
          while (q < s + len - 2) {
            const id = bytes[q] & 15; q++;
            const counts = bytes.subarray(q, q + 16); q += 16;
            let total = 0; for (let i = 0; i < 16; i++) total += counts[i];
            const vals = bytes.subarray(q, q + total); q += total;
            // 16-bit lookahead table: (len << 8) | value
            const lut = new Uint16Array(65536);
            let code = 0, k = 0;
            for (let l = 1; l <= 16; l++) {
              for (let i = 0; i < counts[l - 1]; i++, k++) {
                const shift = 16 - l, start = code << shift, end = start + (1 << shift);
                const ent = (l << 8) | vals[k];
                for (let c = start; c < end; c++) lut[c] = ent;
                code++;
              }
              code <<= 1;
            }
            huff[id] = lut;
          }
        } else if (m === 0xC3) {
          const nc = bytes[s + 5];
          frame = { P: bytes[s], Y: (bytes[s + 1] << 8) | bytes[s + 2], X: (bytes[s + 3] << 8) | bytes[s + 4], comps: [] };
          for (let i = 0; i < nc; i++) frame.comps.push({ id: bytes[s + 6 + i * 3] });
        } else if (m === 0xDD) {
          dri = (bytes[s] << 8) | bytes[s + 1];
        } else if (m === 0xDA) {
          const ns = bytes[s];
          const tbl = [];
          for (let i = 0; i < ns; i++) tbl.push(bytes[s + 2 + i * 2] >> 4);
          const q = s + 1 + ns * 2;
          scan = { tbl, pred: bytes[q], pt: bytes[q + 2] & 15, data: s + len - 2 };
          break;
        }
        p += 2 + len;
      }
      if (!frame || !scan) throw new Error('bad LJ92 stream');
      const { X, Y } = frame, nc = frame.comps.length, W = X * nc;
      const out = new Uint16Array(W * Y);
      // entropy-coded segments: unstuff 0xFF00, split at RSTn, stop at any other marker
      const segs = [];
      {
        let cur = new Uint8Array(Math.max(16, bytes.length - scan.data)), n = 0, q = scan.data;
        while (q < bytes.length) {
          const b = bytes[q];
          if (b === 0xFF) {
            const nx = bytes[q + 1];
            if (nx === 0x00) { cur[n++] = 0xFF; q += 2; continue; }
            if (nx === 0xFF) { q++; continue; }
            if (nx >= 0xD0 && nx <= 0xD7) { segs.push(cur.subarray(0, n)); cur = cur.subarray(n); n = 0; q += 2; continue; }
            break;
          }
          cur[n++] = b; q++;
        }
        segs.push(cur.subarray(0, n));
      }
      let seg = 0, data = segs[0], bp = 0, acc = 0, nb = 0;
      const fill = () => { while (nb <= 24) { acc = ((acc << 8) | (bp < data.length ? data[bp] : 0)) >>> 0; bp++; nb += 8; } };
      const decodeDiff = (lut) => {
        if (nb < 16) fill();
        const e = lut[(acc >>> (nb - 16)) & 0xFFFF];
        const ssss = e & 255;
        nb -= e >> 8;
        if (ssss === 0) return 0;
        if (ssss === 16) return -32768;
        if (nb < 16) fill();
        let v = (acc >>> (nb - ssss)) & ((1 << ssss) - 1);
        nb -= ssss;
        if (v < (1 << (ssss - 1))) v += 1 - (1 << ssss);
        return v;
      };
      const luts = scan.tbl.map(t => huff[t] || huff[0]);
      const pred = scan.pred, init = 1 << (frame.P - scan.pt - 1);
      let mcu = 0, firstLine = true, firstSample = true;
      for (let y = 0; y < Y; y++) {
        const row = y * W, prev = row - W;
        for (let x = 0; x < X; x++) {
          if (dri && mcu > 0 && mcu % dri === 0) { seg++; data = segs[seg] || new Uint8Array(0); bp = 0; acc = 0; nb = 0; firstSample = true; firstLine = x === 0 ? true : firstLine; }
          for (let c = 0; c < nc; c++) {
            const i = row + x * nc + c;
            let pr;
            if (firstSample) pr = init;
            else if (firstLine) pr = out[i - nc];
            else if (x === 0) pr = out[prev + c];
            else {
              const a = out[i - nc], b = out[prev + x * nc + c], cc = out[prev + (x - 1) * nc + c];
              switch (pred) {
                case 1: pr = a; break; case 2: pr = b; break; case 3: pr = cc; break;
                case 4: pr = a + b - cc; break; case 5: pr = a + ((b - cc) >> 1); break;
                case 6: pr = b + ((a - cc) >> 1); break; case 7: pr = (a + b) >> 1; break;
                default: pr = a;
              }
            }
            out[i] = (pr + decodeDiff(luts[c])) & 0xFFFF;
          }
          firstSample = false;
          mcu++;
        }
        firstLine = false;
      }
      return { data: out, width: W, height: Y };
    }

    function unpack(bytes, le, bps, w, h, rowBytes) {
      const out = new Uint16Array(w * h);
      if (bps === 16) {
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = v.getUint16(y * rowBytes + x * 2, le);
        return out;
      }
      if (bps === 8) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = bytes[y * rowBytes + x]; return out; }
      for (let y = 0; y < h; y++) {
        let bit = y * rowBytes * 8;
        for (let x = 0; x < w; x++, bit += bps) {
          let val = 0;
          for (let k = 0; k < bps;) {
            const byte = bytes[bit + k >> 3], off = (bit + k) & 7, take = Math.min(8 - off, bps - k);
            val = (val << take) | ((byte >> (8 - off - take)) & ((1 << take) - 1));
            k += take;
          }
          out[y * w + x] = val;
        }
      }
      return out;
    }

    function inv3(m) {
      const [a, b, c, d, e, f, g, h, i] = m;
      const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
      const det = a * A + b * B + c * C || 1e-12;
      return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
    }
    const mul3 = (a, b) => { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; return o; };
    // linear sRGB (D65) → XYZ
    const RGB2XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];

    let logLut = null;
    function rawLogLut() {
      if (logLut) return logLut;
      logLut = new Uint8Array(65536); // linear 0…16 in 1/4096 steps
      const k = Math.log2(16 * 64 + 1);
      for (let i = 0; i < 65536; i++) logLut[i] = Math.round(Math.log2((i / 4096) * 64 + 1) / k * 255);
      return logLut;
    }

    function info(buf) {
      const t = parseTiff(buf), r = t.raw, g = (k, d) => (r[k] || t.ifd0[k] || [d]);
      const ac = g(T.ActiveArea, null);
      let W = g(T.Width, 0)[0], H = g(T.Height, 0)[0];
      if (ac && ac.length === 4 && ac[0] !== null) { W = ac[3] - ac[1]; H = ac[2] - ac[0]; }
      return { width: W, height: H, fps: (t.ifd0[T.FrameRate] || r[T.FrameRate] || [0])[0], bits: g(T.Bits, 16)[0], compression: g(T.Compression, 1)[0], cinema: !!(t.ifd0[T.FrameRate] || r[T.FrameRate]) };
    }

    function decode(buf, half) {
      const bytes = new Uint8Array(buf);
      const t = parseTiff(buf), r = t.raw, i0 = t.ifd0;
      const g = (k, d) => r[k] || i0[k] || d;
      const fullW = g(T.Width, [0])[0], fullH = g(T.Height, [0])[0], bps = g(T.Bits, [16])[0], comp = g(T.Compression, [1])[0];
      if ((g(T.Photometric, [32803])[0]) !== 32803) throw new Error('Only Bayer CinemaDNG is supported');
      const raw = new Uint16Array(fullW * fullH);
      if (r[T.TileOffsets]) {
        const tw = r[T.TileWidth][0], th = r[T.TileLength][0], offs = r[T.TileOffsets], cnts = r[T.TileByteCounts];
        const across = Math.ceil(fullW / tw);
        offs.forEach((o, k) => {
          const tx = (k % across) * tw, ty = Math.floor(k / across) * th;
          let tile, w = tw;
          if (comp === 7) { const d = lj92(bytes.subarray(o, o + cnts[k])); tile = d.data; w = d.width; }
          else tile = unpack(bytes.subarray(o, o + cnts[k]), t.le, bps, tw, th, Math.ceil(tw * bps / 8));
          for (let y = 0; y < th && ty + y < fullH; y++) for (let x = 0; x < tw && tx + x < fullW; x++) raw[(ty + y) * fullW + tx + x] = tile[y * w + x];
        });
      } else {
        const offs = g(T.StripOffsets, [0]), cnts = g(T.StripByteCounts, [0]), rps = g(T.RowsPerStrip, [fullH])[0];
        offs.forEach((o, k) => {
          const y0 = k * rps, rows = Math.min(rps, fullH - y0);
          let d;
          if (comp === 7) {
            const j = lj92(bytes.subarray(o, o + cnts[k]));
            d = j.data;
          } else d = unpack(bytes.subarray(o, o + cnts[k]), t.le, bps, fullW, rows, Math.ceil(fullW * bps / 8));
          raw.set(d.subarray(0, rows * fullW), y0 * fullW);
        });
      }
      // active area & default crop
      let ax = 0, ay = 0, aw = fullW, ah = fullH;
      const aa = g(T.ActiveArea, null);
      if (aa && aa.length === 4) { ay = aa[0]; ax = aa[1]; ah = aa[2] - aa[0]; aw = aa[3] - aa[1]; }
      const co = g(T.CropOrigin, null), cs = g(T.CropSize, null);
      let cx = 0, cy = 0, cw = aw, ch = ah;
      if (co && cs) { cx = Math.round(co[0]); cy = Math.round(co[1]); cw = Math.round(cs[0]); ch = Math.round(cs[1]); }
      // CFA (relative to the active area)
      const dim = g(T.CFADim, [2, 2]), pat = g(T.CFAPattern, [0, 1, 1, 2]);
      const cfa = (x, y) => pat[(y % dim[0]) * dim[1] + (x % dim[1])];
      // linearization
      const white = g(T.White, [(1 << bps) - 1])[0];
      const blacks = g(T.Black, [0]), brep = g(T.BlackRepeat, [1, 1]);
      const lin = g(T.LinTable, null);
      const blackAt = (x, y) => blacks.length > 1 ? blacks[(y % brep[0]) * brep[1] + (x % brep[1])] || 0 : blacks[0] || 0;
      // color: camera → linear sRGB (dcraw method)
      const illum2 = g(T.Illum2, [0])[0];
      let CM = g(illum2 === 21 || illum2 === 23 ? T.CM2 : T.CM1, null) || g(T.CM2, null) || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (CM.length < 9) CM = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const camRgb = mul3(CM.slice(0, 9), RGB2XYZ);
      for (let rr = 0; rr < 3; rr++) { const s = camRgb[rr * 3] + camRgb[rr * 3 + 1] + camRgb[rr * 3 + 2] || 1; for (let c = 0; c < 3; c++) camRgb[rr * 3 + c] /= s; }
      const M = inv3(camRgb);
      const neutral = g(T.Neutral, [1, 1, 1]);
      const wb = [1 / (neutral[0] || 1), 1 / (neutral[1] || 1), 1 / (neutral[2] || 1)];
      const wn = wb[1]; wb[0] /= wn; wb[1] = 1; wb[2] /= wn;
      const be = Math.pow(2, g(T.BaselineExp, [0])[0] || 0);
      // per-raw-value normalization table (black handled separately when it varies)
      const maxV = 1 << Math.min(16, Math.max(bps, 1));
      const norm = new Float32Array(65536);
      const b0 = blacks.length > 1 ? 0 : (blacks[0] || 0);
      for (let v = 0; v < 65536; v++) {
        let x = lin ? lin[Math.min(lin.length - 1, v)] : v;
        norm[v] = Math.max(0, (x - b0) / Math.max(1, white - b0));
      }
      void maxV;
      const at = (x, y) => {
        const X = ax + cx + x, Y = ay + cy + y;
        let vv = norm[raw[Y * fullW + X]];
        if (blacks.length > 1) vv = Math.max(0, vv - blackAt(cx + x, cy + y) / Math.max(1, white));
        return vv;
      };
      const colorAt = (x, y) => cfa(cx + x, cy + y);
      const ow = half ? cw >> 1 : cw, oh = half ? ch >> 1 : ch;
      const out = new Uint8ClampedArray(ow * oh * 4);
      const L = rawLogLut();
      const m0 = M[0] * wb[0] * be, m1 = M[1] * wb[1] * be, m2 = M[2] * wb[2] * be, m3 = M[3] * wb[0] * be, m4 = M[4] * wb[1] * be, m5 = M[5] * wb[2] * be, m6 = M[6] * wb[0] * be, m7 = M[7] * wb[1] * be, m8 = M[8] * wb[2] * be;
      const enc = (v) => { const q = v * 4096; return q <= 0 ? 0 : q >= 65535 ? 255 : L[q | 0]; };
      const rgb = [0, 0, 0], cnt = [0, 0, 0];
      for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
          rgb[0] = rgb[1] = rgb[2] = 0; cnt[0] = cnt[1] = cnt[2] = 0;
          if (half) {
            const sx = x * 2, sy = y * 2;
            for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const c = colorAt(sx + i, sy + j); rgb[c] += at(sx + i, sy + j); cnt[c]++; }
          } else {
            const own = colorAt(x, y);
            rgb[own] = at(x, y); cnt[own] = 1;
            for (let j = -1; j <= 1; j++) {
              const yy = y + j; if (yy < 0 || yy >= ch) continue;
              for (let i = -1; i <= 1; i++) {
                const xx = x + i; if ((!i && !j) || xx < 0 || xx >= cw) continue;
                const c = colorAt(xx, yy); if (c === own) continue;
                rgb[c] += at(xx, yy); cnt[c]++;
              }
            }
          }
          const R = cnt[0] ? rgb[0] / cnt[0] : 0, G = cnt[1] ? rgb[1] / cnt[1] : 0, B = cnt[2] ? rgb[2] / cnt[2] : 0;
          const o = (y * ow + x) * 4;
          out[o] = enc(m0 * R + m1 * G + m2 * B);
          out[o + 1] = enc(m3 * R + m4 * G + m5 * B);
          out[o + 2] = enc(m6 * R + m7 * G + m8 * B);
          out[o + 3] = 255;
        }
      }
      return { data: out, width: ow, height: oh };
    }

    self.onmessage = (e) => {
      const m = e.data;
      try {
        if (m.type === 'info') { self.postMessage({ id: m.id, ok: true, info: info(m.buf) }); return; }
        const r = decode(m.buf, m.half);
        self.postMessage({ id: m.id, ok: true, width: r.width, height: r.height, data: r.data.buffer }, [r.data.buffer]);
      } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
    };
    self.PJ_CDNG_TEST = { decode, info, lj92, parseTiff };
  }

  /* ---------------- worker pool ---------------- */
  let pool = null;
  function getPool() {
    if (pool) return pool;
    const url = URL.createObjectURL(new Blob([`(${workerMain.toString()})();`], { type: 'text/javascript' }));
    const n = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    const ws = [], waiting = new Map(), queue = [];
    let seq = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(url);
      w.busy = false;
      w.onmessage = (e) => { const cb = waiting.get(e.data.id); waiting.delete(e.data.id); w.busy = false; pump(); cb && cb(e.data); };
      ws.push(w);
    }
    function pump() {
      while (queue.length) {
        const w = ws.find(x => !x.busy); if (!w) return;
        const job = queue.shift();
        w.busy = true;
        waiting.set(job.msg.id, job.cb);
        w.postMessage(job.msg, [job.msg.buf]);
      }
    }
    pool = {
      run(msg, front) {
        return new Promise((resolve, reject) => {
          msg.id = ++seq;
          const job = { msg, cb: (r) => r.ok ? resolve(r) : reject(new Error(r.error)) };
          if (front) queue.unshift(job); else queue.push(job);
          pump();
        });
      }
    };
    return pool;
  }

  async function readAll(path) { const b = await API.readFile(path); return b.byteOffset === 0 && b.buffer.byteLength === b.length ? b.buffer : b.slice().buffer; }

  /* ---------------- import grouping ---------------- */
  /** Collapse runs of numbered DNG frames that carry a CinemaDNG FrameRate tag into one clip descriptor. */
  async function groupSequences(descs) {
    const dngs = descs.filter(d => Dec.ext(d.name) === 'dng');
    if (dngs.length < 12) return descs;
    const groups = new Map();
    for (const d of dngs) {
      const m = /^(.*?)(\d{3,})\.dng$/i.exec(d.name);
      if (!m) continue;
      const key = `${API.dirname(d.path)}|${m[1]}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ d, n: parseInt(m[2], 10), prefix: m[1] });
    }
    const consumed = new Set(), clips = [];
    for (const list of groups.values()) {
      if (list.length < 12) continue;
      list.sort((a, b) => a.n - b.n);
      let inf = null;
      try {
        const head = await API.readRange(list[0].d.path, 0, Math.min(list[0].d.size || 262144, 262144));
        inf = await probeBuffer(head.slice().buffer);
      } catch (e) { console.warn('CinemaDNG probe failed', e); }
      if (!inf || !inf.cinema) continue; // ordinary DNG stills — leave them alone
      const first = list[0].d;
      const folderName = String(API.dirname(first.path)).split(/[\\/]/).filter(Boolean).pop() || 'Clip';
      const base = (list[0].prefix.replace(/[_\-. ]+$/, '') || folderName);
      list.forEach(x => consumed.add(x.d));
      clips.push({
        path: first.path, name: `${base}.dng`, folder: first.folder || API.dirname(first.path),
        size: list.reduce((a, x) => a + (x.d.size || 0), 0), mtime: first.mtime,
        cdng: { frames: list.map(x => x.d.path), fps: inf.fps || 24 }
      });
    }
    if (!clips.length) return descs;
    return descs.filter(d => !consumed.has(d)).concat(clips);
  }

  async function probeBuffer(buf) { return (await getPool().run({ type: 'info', buf }, true)).info; }

  async function probe(c) {
    const buf = await readAll(c.frames[0]);
    const inf = await probeBuffer(buf);
    const fps = c.fps || inf.fps || 24;
    return { width: inf.width, height: inf.height, fps, frames: c.frames.length, duration: c.frames.length / fps, bitDepth: inf.bits, audio: null };
  }

  /** An opened CinemaDNG clip: decoded frame cache + read-ahead. */
  async function open(c) {
    const cache = new Map(); // `${f}|${half}` -> Promise<canvas>
    const fps = c.fps || 24;
    const clip = {
      lastCanvas: null,
      frameOf: (t) => Math.max(0, Math.min(c.frames.length - 1, Math.floor(t * fps + 1e-3))),
      decode(f, half) {
        const key = `${f}|${half ? 1 : 0}`;
        if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
        const pr = (async () => {
          const buf = await readAll(c.frames[f]);
          const r = await getPool().run({ type: 'decode', buf, half: !!half });
          const cv = Dec.makeCanvas(r.width, r.height);
          cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
          return cv;
        })();
        cache.set(key, pr);
        pr.catch(() => cache.delete(key));
        while (cache.size > 24) cache.delete(cache.keys().next().value);
        return pr;
      },
      async frameCanvas(f, opts) {
        const half = !!(opts && opts.half);
        const cv = await clip.decode(f, half);
        if (half) for (let k = 1; k <= 6 && f + k < c.frames.length; k++) clip.decode(f + k, true); // read ahead for playback
        clip.lastCanvas = cv;
        return cv;
      },
      close() { cache.clear(); }
    };
    return clip;
  }

  global.PJ.CDNG = { groupSequences, probe, open, workerMain };
})(window);
