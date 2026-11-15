/* =====================================================================
 * photos.jpeg — camera RAW decoding (runs in render workers).
 *
 * Supported: Nikon NEF (lossless/lossy compressed, uncompressed), Canon CR2,
 * Sony ARW (ARW2 compressed, uncompressed, lossless), Bayer DNG (any maker, incl.
 * phones), LinearRaw DNG. Anything else falls back to the embedded preview.
 *
 * Two phases so colour can be matched to the camera's own rendering:
 *   A  decode the mosaic (kept in the worker), return metadata + coarse cell means
 *   B  white balance, demosaic (Malvar-He-Cutler), camera→sRGB matrix, highlight
 *      clipping, then scene-linear → 8-bit "rawlog" (with dither) for the editor
 * The UI thread fits white balance and a base tone curve/saturation to the
 * embedded JPEG between the two (see raw.js).
 * Colour matrices: Adobe DNG Converter values as collected by LibRaw (rawmatrices.js).
 * ===================================================================== */
(function (global) {
  'use strict';

  /* ---------------- TIFF reader ---------------- */
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8 };
  function reader(bytes, base, le) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const r = {
      bytes, v, base, le,
      u8: (o) => bytes[o], u16: (o) => v.getUint16(o, le), u32: (o) => v.getUint32(o, le),
      i16: (o) => v.getInt16(o, le), i32: (o) => v.getInt32(o, le),
      val(type, off, i) {
        switch (type) {
          case 3: return r.u16(off + i * 2); case 4: case 13: return r.u32(off + i * 4);
          case 8: return r.i16(off + i * 2); case 9: return r.i32(off + i * 4);
          case 5: { const d = r.u32(off + i * 8 + 4); return d ? r.u32(off + i * 8) / d : 0; }
          case 10: { const d = r.i32(off + i * 8 + 4); return d ? r.i32(off + i * 8) / d : 0; }
          case 11: return v.getFloat32(off + i * 4, le); case 12: return v.getFloat64(off + i * 8, le);
          default: return bytes[off + i];
        }
      },
      ifd(off) {
        if (off <= 0 || off + 2 > bytes.length) return null;
        const n = r.u16(off);
        if (n > 1000) return null;
        const tags = {};
        for (let i = 0; i < n; i++) {
          const e = off + 2 + i * 12;
          if (e + 12 > bytes.length) break;
          const tag = r.u16(e), type = r.u16(e + 2), count = r.u32(e + 4);
          const size = (SZ[type] || 1) * count;
          const voff = size <= 4 ? e + 8 : base + r.u32(e + 8);
          tags[tag] = { type, count, off: voff };
        }
        const nx = off + 2 + n * 12 + 4 <= bytes.length ? r.u32(off + 2 + n * 12) : 0;
        return { tags, next: nx ? base + nx : 0, r };
      },
      get(ifd, tag, max) {
        const t = ifd && ifd.tags[tag];
        if (!t || t.off + 1 > bytes.length) return null;
        const n = Math.min(t.count, max || 1 << 20);
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = r.val(t.type, t.off, i);
        return out;
      },
      one(ifd, tag, def) { const a = r.get(ifd, tag, 1); return a && a.length ? a[0] : def; },
      str(ifd, tag) {
        const t = ifd && ifd.tags[tag];
        if (!t) return '';
        let s = '';
        for (let i = 0; i < t.count && t.off + i < bytes.length; i++) { const c = bytes[t.off + i]; if (!c) break; s += String.fromCharCode(c); }
        return s.trim();
      }
    };
    return r;
  }

  /* ---------------- bit reader (MSB first) ---------------- */
  class Bits {
    constructor(bytes, pos, zeroAfterFF) { this.b = bytes; this.p = pos; this.buf = 0; this.n = 0; this.ff = !!zeroAfterFF; }
    fill(need) {
      while (this.n < need) {
        let c = this.p < this.b.length ? this.b[this.p++] : 0;
        if (this.ff && c === 0xFF) { if (this.b[this.p] === 0) this.p++; }
        this.buf = ((this.buf << 8) | c) >>> 0; this.n += 8;
      }
    }
    peek(k) { this.fill(k); return (this.buf >>> (this.n - k)) & ((1 << k) - 1); }
    get(k) { if (k <= 0) return 0; const v = this.peek(k); this.n -= k; this.buf &= this.n ? (1 << this.n) - 1 : 0; return v; }
  }
  /** dcraw-style Huffman table: counts[16] then values → lookup of (len<<8|val) on `max` bits */
  function makeDecoder(src) {
    let max = 16;
    while (max && !src[max - 1]) max--;
    const huff = new Uint16Array(1 + (1 << max));
    huff[0] = max;
    let h = 1, k = 16;
    for (let len = 1; len <= max; len++) {
      for (let i = 0; i < src[len - 1]; i++, k++) {
        for (let j = 0; j < 1 << (max - len); j++) if (h <= 1 << max) huff[h++] = (len << 8) | src[k];
      }
    }
    return huff;
  }
  function getHuff(bits, huff) {
    const max = huff[0];
    const c = bits.peek(max);
    const e = huff[c + 1];
    bits.get(e >> 8);
    return e & 0xff;
  }

  /* ---------------- lossless JPEG (CR2, DNG, Sony lossless) ---------------- */
  function lj92(bytes, start, end) {
    let p = start + 2, frame = null, scan = null;
    const huff = [];
    while (p < end) {
      if (bytes[p] !== 0xFF) { p++; continue; }
      const m = bytes[p + 1];
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7) || m === 0xFF) { p += m === 0xFF ? 1 : 2; continue; }
      const len = (bytes[p + 2] << 8) | bytes[p + 3], s = p + 4;
      if (m === 0xC4) {
        let q = s;
        while (q < s + len - 2) {
          const id = bytes[q] & 15; q++;
          const counts = bytes.subarray(q, q + 16); q += 16;
          let total = 0; for (let i = 0; i < 16; i++) total += counts[i];
          const lut = new Uint16Array(65536);
          let code = 0, k = 0;
          for (let l = 1; l <= 16; l++) {
            for (let i = 0; i < counts[l - 1]; i++, k++) {
              const shift = 16 - l, a = code << shift, b = a + (1 << shift), ent = (l << 8) | bytes[q + k];
              for (let c2 = a; c2 < b && c2 < 65536; c2++) lut[c2] = ent;
              code++;
            }
            code <<= 1;
          }
          q += total;
          huff[id] = lut;
        }
      } else if (m === 0xC3) {
        const nc = bytes[s + 5];
        frame = { P: bytes[s], Y: (bytes[s + 1] << 8) | bytes[s + 2], X: (bytes[s + 3] << 8) | bytes[s + 4], nc };
      } else if (m === 0xDA) {
        const ns = bytes[s], tbl = [];
        for (let i = 0; i < ns; i++) tbl.push(bytes[s + 2 + i * 2] >> 4);
        const q = s + 1 + ns * 2;
        scan = { tbl, pred: bytes[q], pt: bytes[q + 2] & 15, data: s + len - 2 };
        break;
      }
      p += 2 + len;
    }
    if (!frame || !scan) throw new Error('bad lossless JPEG');
    const { X, Y, nc } = frame, W = X * nc;
    const out = new Uint16Array(W * Y);
    const bits = new Bits(bytes, scan.data, true);
    const luts = scan.tbl.map(t => huff[t] || huff[0]);
    const init = 1 << (frame.P - scan.pt - 1), pred = scan.pred;
    for (let y = 0; y < Y; y++) {
      const row = y * W, prev = row - W;
      for (let x = 0; x < X; x++) {
        for (let c = 0; c < nc; c++) {
          const lut = luts[c];
          const e = lut[bits.peek(16)];
          bits.get(e >> 8);
          const ssss = e & 255;
          let diff = 0;
          if (ssss === 16) diff = -32768;
          else if (ssss) { diff = bits.get(ssss); if (diff < 1 << (ssss - 1)) diff += 1 - (1 << ssss); }
          const i = row + x * nc + c;
          let pr;
          if (y === 0 && x === 0) pr = init;
          else if (y === 0) pr = out[i - nc];
          else if (x === 0) pr = out[prev + c];
          else {
            const a = out[i - nc], b = out[prev + x * nc + c], cc = out[prev + (x - 1) * nc + c];
            pr = pred === 1 ? a : pred === 2 ? b : pred === 3 ? cc : pred === 4 ? a + b - cc : pred === 5 ? a + ((b - cc) >> 1) : pred === 6 ? b + ((a - cc) >> 1) : pred === 7 ? (a + b) >> 1 : a;
          }
          out[i] = (pr + diff) & 0xFFFF;
        }
      }
    }
    return { data: out, width: W, height: Y, cols: X, comps: nc };
  }

  /* ---------------- Nikon NEF compressed ---------------- */
  const NIKON_TREE = [
    [0, 1, 5, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 5, 4, 3, 6, 2, 7, 1, 0, 8, 9, 11, 10, 12],
    [0, 1, 5, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 0x39, 0x5a, 0x38, 0x27, 0x16, 5, 4, 3, 2, 1, 0, 11, 12, 12],
    [0, 1, 4, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10, 11, 12],
    [0, 1, 4, 3, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 5, 6, 4, 7, 8, 3, 9, 2, 1, 0, 10, 11, 12, 13, 14],
    [0, 1, 5, 1, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 8, 0x5c, 0x4b, 0x3a, 0x29, 7, 6, 5, 4, 3, 2, 1, 0, 13, 14],
    [0, 1, 4, 2, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 7, 6, 8, 5, 9, 4, 10, 3, 11, 12, 2, 0, 1, 13, 14]
  ];
  function nikonDecode(bytes, dataOff, W, H, bps, mr, metaOff) {
    // linearization data in the maker note (byte order of the maker note)
    let p = metaOff;
    const ver0 = bytes[p], ver1 = bytes[p + 1];
    p += 2;
    if (ver0 === 0x49 || ver1 === 0x58) p += 2110;
    const vpred = [[mr.u16(p), mr.u16(p + 2)], [mr.u16(p + 4), mr.u16(p + 6)]]; p += 8;
    let tree = ver0 === 0x46 ? 2 : 0;
    if (bps === 14) tree += 3;
    let max = (1 << bps) & 0x7fff;
    const curve = new Uint16Array(0x10000);
    for (let i = 0; i < curve.length; i++) curve[i] = i;
    const csize = mr.u16(p); p += 2;
    let step = max;
    if (csize > 1) step = Math.floor(max / (csize - 1));
    if (ver0 === 0x44 && (ver1 === 0x20 || (ver1 === 0x40 && step > 3)) && step > 0) {
      let mx = max, st = step;
      if (ver1 === 0x40) { st = Math.floor(st / 4); mx = Math.floor(mx / 4); }
      for (let i = 0; i < csize; i++) curve[i * st] = mr.u16(p + i * 2);
      for (let i = 0; i < mx; i++) curve[i] = Math.floor((curve[i - i % st] * (st - i % st) + curve[i - i % st + st] * (i % st)) / st);
    } else if (ver0 !== 0x46 && csize <= 0x4001) {
      for (let i = 0; i < csize; i++) curve[i] = mr.u16(p + i * 2);
      max = csize;
    }
    let split = 0;
    if (ver0 === 0x44 && (ver1 === 0x20 || ver1 === 0x40)) {
      if (ver1 === 0x40) max = Math.floor(max / 4);
      split = mr.u16(metaOff + 562);
    }
    while (max > 2 && curve[max - 2] === curve[max - 1]) max--;
    let huff = makeDecoder(NIKON_TREE[tree]);
    const bits = new Bits(bytes, dataOff, false);
    const out = new Uint16Array(W * H);
    const hpred = [0, 0];
    let min = 0;
    for (let row = 0; row < H; row++) {
      if (split && row === split) { huff = makeDecoder(NIKON_TREE[tree + 1]); max += (min = 16) << 1; }
      for (let col = 0; col < W; col++) {
        const i = getHuff(bits, huff);
        const len = i & 15, shl = i >> 4;
        let diff = ((bits.get(len - shl) << 1) + 1) << shl >> 1;
        if (len > 0 && (diff & (1 << (len - 1))) === 0) diff -= (1 << len) - (shl ? 0 : 1);
        let v;
        if (col < 2) { vpred[row & 1][col] = (vpred[row & 1][col] + diff) & 0xFFFF; hpred[col] = vpred[row & 1][col]; v = hpred[col]; }
        else { hpred[col & 1] = (hpred[col & 1] + diff) & 0xFFFF; v = hpred[col & 1]; }
        v = (v << 16) >> 16; // as short
        out[row * W + col] = curve[v < 0 ? 0 : v > 0x3fff ? 0x3fff : v];
      }
    }
    return { data: out, max: curve[max - 1] || (1 << bps) - 1 };
  }

  /* ---------------- Sony ARW2 ---------------- */
  function sonyArw2(bytes, off, W, H, curveTag) {
    const curve = new Uint16Array(0x4001);
    for (let i = 0; i < curve.length; i++) curve[i] = i;
    if (curveTag) {
      const sc = [0, 0, 0, 0, 0, 4095];
      for (let c = 0; c < 4; c++) sc[c + 1] = (curveTag[c] >> 2) & 0xfff;
      for (let i = 0; i < 5; i++) for (let j = sc[i] + 1; j <= sc[i + 1]; j++) curve[j] = curve[j - 1] + (1 << i);
    }
    const out = new Uint16Array(W * H), pix = new Uint16Array(16);
    for (let row = 0; row < H; row++) {
      const base = off + row * W;
      for (let col = 0, dp = base; col < W - 30; dp += 16) {
        const val = (bytes[dp] | (bytes[dp + 1] << 8) | (bytes[dp + 2] << 16) | (bytes[dp + 3] << 24)) >>> 0;
        const max = 0x7ff & val, min = 0x7ff & (val >>> 11), imax = 0x0f & (val >>> 22), imin = 0x0f & (val >>> 26);
        let sh = 0;
        while (sh < 4 && (0x80 << sh) <= max - min) sh++;
        for (let bit = 30, i = 0; i < 16; i++) {
          if (i === imax) pix[i] = max;
          else if (i === imin) pix[i] = min;
          else {
            const q = dp + (bit >> 3);
            let v = ((((bytes[q] | (bytes[q + 1] << 8)) >> (bit & 7)) & 0x7f) << sh) + min;
            pix[i] = v > 0x7ff ? 0x7ff : v;
            bit += 7;
          }
        }
        for (let i = 0; i < 16; i++, col += 2) out[row * W + col] = curve[pix[i] << 1] >> 2;
        col -= col & 1 ? 1 : 31;
      }
    }
    return out;
  }

  /* ---------------- uncompressed / packed ---------------- */
  function unpacked(bytes, off, W, H, bps, le, rowBytes) {
    const out = new Uint16Array(W * H);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bps === 16 || (rowBytes && rowBytes >= W * 2)) {
      const rb = rowBytes || W * 2;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = v.getUint16(off + y * rb + x * 2, le);
      return out;
    }
    const rb = rowBytes || Math.ceil(W * bps / 8);
    if (bps === 12 && !le) {
      for (let y = 0; y < H; y++) {
        let q = off + y * rb;
        for (let x = 0; x < W; x += 2, q += 3) {
          out[y * W + x] = (bytes[q] << 4) | (bytes[q + 1] >> 4);
          if (x + 1 < W) out[y * W + x + 1] = ((bytes[q + 1] & 15) << 8) | bytes[q + 2];
        }
      }
      return out;
    }
    for (let y = 0; y < H; y++) {
      let bit = (off + y * rb) * 8;
      for (let x = 0; x < W; x++, bit += bps) {
        let val = 0;
        for (let k = 0; k < bps;) {
          const byte = bytes[(bit + k) >> 3], o = (bit + k) & 7, take = Math.min(8 - o, bps - k);
          val = (val << take) | ((byte >> (8 - o - take)) & ((1 << take) - 1));
          k += take;
        }
        out[y * W + x] = val;
      }
    }
    return out;
  }

  /* ---------------- identify + decode (phase A) ---------------- */
  function collectIfds(r, first) {
    const list = [], seen = new Set();
    const walk = (off, depth) => {
      while (off && !seen.has(off) && depth < 6 && list.length < 40) {
        seen.add(off);
        const d = r.ifd(off);
        if (!d) return;
        list.push(d);
        const subs = r.get(d, 330, 16);
        if (subs) subs.forEach(s => walk(r.base + s, depth + 1));
        off = d.next;
      }
    };
    walk(first, 0);
    return list;
  }

  function decodeMosaic(bytes) {
    const le = bytes[0] === 0x49;
    if (!((le && bytes[1] === 0x49) || (!le && bytes[0] === 0x4D && bytes[1] === 0x4D))) throw new Error('not a TIFF-based RAW');
    const r = reader(bytes, 0, le);
    const magic = r.u16(2);
    if (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352) throw new Error('unsupported RAW container');
    const ifds = collectIfds(r, r.u32(4));
    const ifd0 = ifds[0];
    let make = r.str(ifd0, 271), model = r.str(ifd0, 272);
    const dng = r.get(ifd0, 50706, 4);
    const exifOff = r.one(ifd0, 34665, 0);
    const exif = exifOff ? r.ifd(exifOff) : null;
    if (!make && exif) make = r.str(exif, 271);
    const orientation = r.one(ifd0, 274, 1);
    let mosaic = null, W = 0, H = 0, bps = 16, black = 0, cblack = [0, 0, 0, 0], white = 0, cfa = null, crop = null;
    let linearRaw = null, matrix = null, asShot = null, baselineExp = 0, linTable = null;

    const pickRaw = () => {
      let best = null, area = 0;
      for (const d of ifds) {
        const ph = r.one(d, 262, 0), comp = r.one(d, 259, 1), spp = r.one(d, 277, 1);
        const w = r.one(d, 256, 0), h = r.one(d, 257, 0);
        const isRaw = ph === 32803 || ph === 34892 || comp === 34713 || comp === 32767 || (spp === 1 && w * h > 1e6 && comp !== 6 && comp !== 7 && comp !== 1 ? false : false);
        if (isRaw && w * h > area && (r.one(d, 254, 0) & 1) === 0) { best = d; area = w * h; }
      }
      return best;
    };

    if (dng) {
      const d = pickRaw();
      if (!d) throw new Error('DNG without raw image');
      W = r.one(d, 256, 0); H = r.one(d, 257, 0); bps = r.one(d, 258, 16);
      const comp = r.one(d, 259, 1), ph = r.one(d, 262, 32803), spp = r.one(d, 277, 1);
      const jxl = comp === 52546 && preDecoded && preDecoded.width === W && preDecoded.height === H && spp === 3 && preDecoded.data.length === W * H * 3;
      if (comp !== 1 && comp !== 7 && !jxl) throw new Error(`DNG compression ${comp} not supported here`);
      const data = jxl ? preDecoded.data : new Uint16Array(W * H * spp);
      const tileW = r.one(d, 322, 0);
      if (jxl) {
        // decoded to the full 16-bit range: back to the file's own scale (its white level)
        const wl = (r.get(d, 50717, 1) || [(1 << bps) - 1])[0], k = wl / 65535;
        for (let i = 0; i < data.length; i++) data[i] = data[i] * k + 0.5;
      } else if (tileW) {
        const tw = tileW, th = r.one(d, 323, H), offs = r.get(d, 324), cnts = r.get(d, 325);
        const across = Math.ceil(W / tw);
        offs.forEach((o, k) => {
          const tx = (k % across) * tw, ty = Math.floor(k / across) * th;
          let tile, tileStride = tw * spp;
          if (comp === 7) { const j = lj92(bytes, o, o + cnts[k]); tile = j.data; tileStride = j.width; }
          else tile = unpacked(bytes, o, tw * spp, th, bps, le);
          for (let y = 0; y < th && ty + y < H; y++) for (let x = 0; x < tw * spp && tx * spp + x < W * spp; x++) data[(ty + y) * W * spp + tx * spp + x] = tile[y * tileStride + x];
        });
      } else {
        const offs = r.get(d, 273), cnts = r.get(d, 279), rps = r.one(d, 278, H);
        offs.forEach((o, k) => {
          const y0 = k * rps, rows = Math.min(rps, H - y0);
          let s;
          if (comp === 7) s = lj92(bytes, o, o + cnts[k]).data;
          else s = unpacked(bytes, o, W * spp, rows, bps, le);
          data.set(s.subarray(0, rows * W * spp), y0 * W * spp);
        });
      }
      const bl = r.get(d, 50714, 16) || [0], brep = r.get(d, 50713, 2) || [1, 1];
      if (bl.length >= 4 && brep[0] === 2 && brep[1] === 2) { const m = Math.min(...bl.slice(0, 4)); black = m; cblack = bl.slice(0, 4).map(x => x - m); }
      else black = bl[0] || 0;
      white = (r.get(d, 50717, 1) || [(1 << bps) - 1])[0];
      linTable = r.get(d, 50712, 65536);
      const aa = r.get(d, 50829, 4);
      const co = r.get(d, 50719, 2), cs = r.get(d, 50720, 2);
      crop = { x: 0, y: 0, w: W, h: H };
      if (aa) crop = { x: aa[1], y: aa[0], w: aa[3] - aa[1], h: aa[2] - aa[0] };
      if (co && cs) crop = { x: crop.x + Math.round(co[0]), y: crop.y + Math.round(co[1]), w: Math.round(cs[0]), h: Math.round(cs[1]) };
      const ill2 = r.one(ifd0, 50779, 0);
      matrix = (ill2 === 21 || ill2 === 23 ? r.get(ifd0, 50722, 9) : null) || r.get(ifd0, 50721, 9) || r.get(ifd0, 50722, 9);
      const neutral = r.get(ifd0, 50728, 3);
      if (neutral) asShot = neutral.map(x => 1 / (x || 1));
      baselineExp = r.one(ifd0, 50730, 0);
      if (ph === 34892) { linearRaw = { data, spp }; }
      else {
        mosaic = data;
        const dim = r.get(d, 33421, 2) || [2, 2], pat = r.get(d, 33422, 4) || [0, 1, 1, 2];
        cfa = { dim, pat };
      }
    } else if (/nikon/i.test(make)) {
      const d = pickRaw();
      if (!d) throw new Error('NEF raw image not found');
      W = r.one(d, 256, 0); H = r.one(d, 257, 0); bps = r.one(d, 258, 12);
      const comp = r.one(d, 259, 1), off = r.one(d, 273, 0), cnt = r.one(d, 279, 0);
      const pat = r.get(d, 33422, 4) || r.get(d, 0x828e, 4) || [0, 1, 1, 2];
      cfa = { dim: [2, 2], pat };
      // maker note: "Nikon\0" + version + TIFF header
      const mn = exif && exif.tags[37500];
      let mr = null, mnIfd = null;
      if (mn && bytes[mn.off] === 0x4E && bytes[mn.off + 1] === 0x69) {
        const hb = mn.off + 10;
        mr = reader(bytes, hb, bytes[hb] === 0x49);
        mnIfd = mr.ifd(hb + mr.u32(hb + 4));
      }
      if (comp === 34713) {
        const metaT = mnIfd && (mnIfd.tags[0x96] || mnIfd.tags[0x8c]);
        if (!metaT) throw new Error('NEF decompression data missing');
        // NEFs where the "compressed" flag hides plain 16-bit data
        if (cnt && cnt >= W * H * 2) mosaic = unpacked(bytes, off, W, H, 16, le);
        else { const n = nikonDecode(bytes, off, W, H, bps, mr, metaT.off); mosaic = n.data; white = n.max; }
      } else {
        const rb = cnt ? Math.floor(cnt / H) : 0;
        mosaic = unpacked(bytes, off, W, H, rb >= W * 2 ? 16 : bps, rb >= W * 2 ? le : false, rb || 0);
      }
      if (!white) white = (1 << bps) - 1;
      // as-shot white balance (R and B multipliers)
      const wbl = mnIfd && mr.get(mnIfd, 0x0c, 4);
      if (wbl && wbl.length >= 2 && wbl[0] > 0.2 && wbl[0] < 10 && wbl[1] > 0.2 && wbl[1] < 10) asShot = [wbl[0], 1, wbl[1]];
      if (mnIfd && mnIfd.tags[0x3d]) {
        const b = mr.get(mnIfd, 0x3d, 4);
        if (b && b.length === 4) { const m = Math.min(...b); black = m; cblack = b.map(x => x - m); }
      }
      crop = { x: 0, y: 0, w: W, h: H };
    } else if (/canon/i.test(make)) {
      // CR2: raw is the last IFD, lossless JPEG with "slices"
      const d = ifds.find(x => x.tags[50752]) || ifds[3];
      if (!d) throw new Error('CR2 raw image not found');
      const off = r.one(d, 273, 0), cnt = r.one(d, 279, 0);
      const slices = r.get(d, 50752, 3) || [0, 0, 0];
      const j = lj92(bytes, off, off + cnt);
      bps = 14;
      let jw = j.width, jh = j.height;
      if (slices[0] || slices[1]) {
        W = slices[0] * slices[1] + slices[2]; H = Math.round(jw * jh / W);
      } else { W = jw; H = jh; }
      mosaic = new Uint16Array(W * H);
      if (slices[1]) {
        const sw = slices[1], sh = H;
        for (let idx = 0; idx < jw * jh; idx++) {
          let i = Math.floor(idx / (sw * sh)), last = i >= slices[0];
          if (last) i = slices[0];
          const width = last ? slices[2] : sw, jidx = idx - i * sw * sh;
          const row = Math.floor(jidx / width), col = jidx % width + i * sw;
          if (row < H && col < W) mosaic[row * W + col] = j.data[idx];
        }
      } else mosaic.set(j.data.subarray(0, W * H));
      // Canon maker note: sensor info (0xe0) gives the active area; the masked border gives black
      const mn = exif && exif.tags[37500];
      crop = { x: 0, y: 0, w: W, h: H };
      if (mn) {
        const mnIfd = r.ifd(mn.off);
        const si = mnIfd && r.get(mnIfd, 0xe0, 17);
        if (si && si.length > 8 && si[7] > si[5]) crop = { x: si[5], y: si[6], w: si[7] - si[5] + 1, h: si[8] - si[6] + 1 };
      }
      if (crop.x > 4) {
        const vals = [];
        for (let y = crop.y + 8; y < crop.y + crop.h - 8; y += 7) for (let x = 2; x < crop.x - 2; x++) vals.push(mosaic[y * W + x]);
        vals.sort((a, b) => a - b);
        black = vals.length ? vals[vals.length >> 1] : 0;
      } else black = 2048;
      white = 0; // detected below
      const pat = [0, 1, 1, 2];
      cfa = { dim: [2, 2], pat, origin: [crop.x & 1, crop.y & 1] };
    } else if (/sony/i.test(make)) {
      const d = pickRaw();
      if (!d) throw new Error('ARW raw image not found');
      W = r.one(d, 256, 0); H = r.one(d, 257, 0); bps = r.one(d, 258, 12);
      const comp = r.one(d, 259, 1), off = r.one(d, 273, 0), cnt = r.one(d, 279, 0);
      if (comp === 32767 && cnt === W * H) { mosaic = sonyArw2(bytes, off, W, H, r.get(d, 0x7010, 4)); bps = 14; }
      else if (comp === 32767 && cnt === W * H * 2) { mosaic = unpacked(bytes, off, W, H, 16, le); bps = 14; }
      else if (comp === 1) mosaic = unpacked(bytes, off, W, H, bps, le);
      else if (comp === 7 && d.tags[322]) {
        mosaic = new Uint16Array(W * H);
        const tw = r.one(d, 322, 0), th = r.one(d, 323, 0), offs = r.get(d, 324), cnts = r.get(d, 325), across = Math.ceil(W / tw);
        offs.forEach((o, k) => {
          const j = lj92(bytes, o, o + cnts[k]);
          const tx = (k % across) * tw, ty = Math.floor(k / across) * th;
          for (let y = 0; y < th && ty + y < H; y++) for (let x = 0; x < tw && tx + x < W; x++) mosaic[(ty + y) * W + tx + x] = j.data[y * j.width + x];
        });
      } else throw new Error(`ARW compression ${comp} not supported here`);
      const pat = r.get(d, 33422, 4) || [0, 1, 1, 2];
      cfa = { dim: [2, 2], pat };
      const bl = r.get(d, 0xc61a, 4) || r.get(d, 0x7310, 4);
      black = bl ? Math.min(...bl) : 512;
      white = (r.get(d, 0xc61d, 1) || r.get(d, 0x787f, 1) || [16383])[0];
      if (bps === 12 && white > 4095) { black >>= 2; white >>= 2; }
      crop = { x: 0, y: 0, w: W, h: H };
    } else throw new Error(`${make || 'This'} RAW format isn't decoded here`);

    if (linTable && mosaic) for (let i = 0; i < mosaic.length; i++) mosaic[i] = linTable[Math.min(linTable.length - 1, mosaic[i])];
    // White point: the nominal maximum, lowered to where the sensor actually saturates
    if (mosaic) {
      const hist = new Uint32Array(65536);
      for (let i = 0; i < mosaic.length; i += 7) hist[mosaic[i]]++;
      let vmax = 65535; while (vmax > 0 && !hist[vmax]) vmax--;
      let nearTop = 0; for (let v = Math.max(0, vmax - Math.max(4, vmax >> 7)); v <= vmax; v++) nearTop += hist[v];
      if (!white || white > 65535) white = (1 << bps) - 1;
      // even a few saturated highlights (lamps, tail lights) reveal where the sensor clips
      if (nearTop >= Math.max(12, mosaic.length / 7 * 0.00002) && vmax < white && vmax > black + (white - black) * 0.5) white = vmax - Math.max(2, vmax >> 8);
    }
    return { make, model: model.replace(new RegExp('^' + (make.split(' ')[0] || 'x') + '\\s*', 'i'), ''), fullModel: model, W, H, bps, black, cblack, white, cfa, crop, mosaic, linearRaw, matrix, asShot, baselineExp, orientation, dng: !!dng };
  }

  /* ---------------- colour ---------------- */
  const RGB2XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
  function mul3(a, b) { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; return o; }
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1e-12;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  /** XYZ→camera matrix: the file's own (DNG) or the Adobe table entry for this model. */
  function cameraMatrix(info) {
    if (info.matrix && info.matrix.length >= 9) return { xyzCam: info.matrix.slice(0, 9), source: 'file' };
    const tbl = global.PJ && PJ.RawMatrices;
    if (tbl) {
      const mk = (info.make || '').toLowerCase(), model = info.model || '';
      let best = null;
      for (const e of tbl) {
        if (!mk.startsWith(e[0].toLowerCase()) && !(mk.includes('olympus') && e[0] === 'Olympus') && !(mk.includes('panasonic') && e[0] === 'Panasonic')) continue;
        if (model.toLowerCase().startsWith(e[1].toLowerCase()) && (!best || e[1].length > best[1].length)) best = e;
      }
      if (best) return { xyzCam: best[4].slice(0, 9).map(x => x / 10000), source: 'table', tblBlack: best[2], tblMax: best[3] };
    }
    return null;
  }
  /** camera RGB (white balanced so neutral = 1,1,1) → linear sRGB, dcraw method */
  function camToSrgb(xyzCam) {
    const camRgb = mul3(xyzCam, RGB2XYZ);
    const pre = [0, 0, 0];
    for (let r = 0; r < 3; r++) { const s = camRgb[r * 3] + camRgb[r * 3 + 1] + camRgb[r * 3 + 2] || 1; pre[r] = 1 / s; for (let c = 0; c < 3; c++) camRgb[r * 3 + c] /= s; }
    return { m: inv3(camRgb), daylight: pre };
  }

  /* ---------------- phase A: coarse cells for colour fitting ---------------- */
  function cellStats(info, gw, gh) {
    const { W, crop, mosaic, cfa } = info;
    const out = new Float32Array(gw * gh * 4); // r, g, b, clipped fraction
    const cw = crop.w / gw, ch = crop.h / gh;
    const scale = 1 / Math.max(1, info.white - info.black);
    const ox = cfa && cfa.origin ? cfa.origin[0] : 0, oy = cfa && cfa.origin ? cfa.origin[1] : 0;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const x0 = crop.x + Math.floor(gx * cw) & ~1, y0 = crop.y + Math.floor(gy * ch) & ~1;
      const x1 = crop.x + Math.floor((gx + 1) * cw), y1 = crop.y + Math.floor((gy + 1) * ch);
      const sum = [0, 0, 0], n = [0, 0, 0];
      let clip = 0, tot = 0;
      const stepY = Math.max(2, ((y1 - y0) / 24 | 0) & ~1), stepX = Math.max(2, ((x1 - x0) / 24 | 0) & ~1);
      for (let y = y0; y + 1 < y1; y += stepY) for (let x = x0; x + 1 < x1; x += stepX) {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          let c;
          if (info.linearRaw) { continue; }
          c = cfa.pat[((y + dy - oy) % 2 + 2) % 2 * 2 + ((x + dx - ox) % 2 + 2) % 2];
          if (c === 3) c = 1;
          const rawv = mosaic[(y + dy) * W + x + dx];
          if (rawv >= info.white) clip++;
          tot++;
          sum[c] += Math.max(0, rawv - info.black - info.cblack[c]) * scale; n[c]++;
        }
      }
      const o = (gy * gw + gx) * 4;
      out[o] = n[0] ? sum[0] / n[0] : 0; out[o + 1] = n[1] ? sum[1] / n[1] : 0; out[o + 2] = n[2] ? sum[2] / n[2] : 0; out[o + 3] = tot ? clip / tot : 0;
    }
    return out;
  }
  function linearRawCells(info, gw, gh) {
    const { W, crop, linearRaw } = info, spp = linearRaw.spp;
    // (a file that stores its picture dark and says by how much — BaselineExposure — is lifted by that, as in develop())
    const out = new Float32Array(gw * gh * 4), scale = Math.pow(2, Math.max(0, Math.min(4, info.baselineExp || 0))) / Math.max(1, info.white - info.black);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const s = [0, 0, 0]; let n = 0, clip = 0;
      for (let k = 0; k < 16; k++) {
        const x = crop.x + Math.floor((gx + (k % 4 + 0.5) / 4) * crop.w / gw), y = crop.y + Math.floor((gy + ((k >> 2) + 0.5) / 4) * crop.h / gh);
        const i = (y * W + x) * spp;
        for (let c = 0; c < 3; c++) { const v = linearRaw.data[i + c]; if (v >= info.white) clip++; s[c] += Math.max(0, v - info.black) * scale; }
        n++;
      }
      const o = (gy * gw + gx) * 4;
      out[o] = s[0] / n; out[o + 1] = s[1] / n; out[o + 2] = s[2] / n; out[o + 3] = clip / (n * 3);
    }
    return out;
  }

  /* ---------------- phase B: develop to rawlog ---------------- */
  /**
   * opts: { wb: [r,g,b] multipliers (camera space), m: 3×3 camera→sRGB, half: bool, exposure: linear scale }
   * Output: RGBA 8-bit, linear sRGB × exposure encoded with Pipeline's rawlog curve (0…16).
   */
  function develop(info, opts) {
    const { W, crop, cfa } = info;
    const half = !!opts.half;
    const ow = half ? crop.w >> 1 : crop.w, oh = half ? crop.h >> 1 : crop.h;
    const wb = opts.wb, m = opts.m, K = opts.exposure || 1;
    const scale = 1 / Math.max(1, info.white - info.black);
    // channel gains normalised so the weakest is 1: every channel then saturates at ≥ 1 → clip at 1 keeps highlights neutral
    const minWb = Math.min(wb[0], wb[1], wb[2]);
    const g = [wb[0] / minWb * scale, wb[1] / minWb * scale, wb[2] / minWb * scale];
    const clipAt = [wb[0] / minWb, wb[1] / minWb, wb[2] / minWb];
    const satRaw = info.white - info.black;
    const ox = cfa && cfa.origin ? cfa.origin[0] : 0, oy = cfa && cfa.origin ? cfa.origin[1] : 0;
    const colorAt = (x, y) => { const c = cfa.pat[((y - oy) % cfa.dim[0] + cfa.dim[0]) % cfa.dim[0] * cfa.dim[1] + ((x - ox) % cfa.dim[1] + cfa.dim[1]) % cfa.dim[1]]; return c === 3 ? 1 : c; };
    const out = new Uint8ClampedArray(ow * oh * 4);
    const k = Math.log2(16 * 64 + 1);
    const LUTN = 16384, enc = new Float32Array(LUTN + 1);
    for (let i = 0; i <= LUTN; i++) enc[i] = Math.log2((i / LUTN) * 16 * 64 + 1) / k * 255;
    let seed = opts.seed || 12345;
    const encode = (v) => {
      // scene-linear 0…16 → 8-bit rawlog with a little dither against banding
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // (read between the table's entries: in deep shadows one entry spans several per cent of brightness,
      //  and stepping from entry to entry drew contour lines across smooth skies)
      const f = v <= 0 ? 0 : v >= 16 ? LUTN : v / 16 * LUTN, fi = f | 0;
      const q = (fi >= LUTN ? enc[LUTN] : enc[fi] + (enc[fi + 1] - enc[fi]) * (f - fi)) + (seed / 0x7fffffff - 0.5);
      return q < 0 ? 0 : q > 255 ? 255 : q + 0.5;
    };
    const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
    const emit = (o, r, gg, b, clipped) => {
      if (clipped) { const t = Math.min(r, gg, b); r = gg = b = Math.max(t, 1); }
      let R = (m0 * r + m1 * gg + m2 * b) * K, G = (m3 * r + m4 * gg + m5 * b) * K, B = (m6 * r + m7 * gg + m8 * b) * K;
      // out-of-gamut colours (red/blue LEDs, neon): desaturate towards their luminance instead of clipping a channel
      const mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
      if (mn < 0) {
        const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        if (Y > 0) { const t = Y / (Y - mn); R = Y + (R - Y) * t; G = Y + (G - Y) * t; B = Y + (B - Y) * t; } else R = G = B = 0;
      }
      out[o] = encode(R); out[o + 1] = encode(G); out[o + 2] = encode(B); out[o + 3] = 255;
    };

    if (info.linearRaw) {
      const { data, spp } = info.linearRaw;
      // phones store these pictures dark, with room above for highlights, and say by how much (BaselineExposure)
      const lift = Math.pow(2, Math.max(0, Math.min(4, info.baselineExp || 0))), g0 = g[0] * lift, g1 = g[1] * lift, g2 = g[2] * lift;
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const sx = crop.x + (half ? x * 2 : x), sy = crop.y + (half ? y * 2 : y), i = (sy * W + sx) * spp;
        const r = Math.max(0, data[i] - info.black) * g0, gg = Math.max(0, data[i + 1] - info.black) * g1, b = Math.max(0, data[i + 2] - info.black) * g2;
        const clipped = data[i] >= info.white || data[i + 1] >= info.white || data[i + 2] >= info.white;
        emit((y * ow + x) * 4, Math.min(r, clipAt[0]), Math.min(gg, clipAt[1]), Math.min(b, clipAt[2]), clipped);
      }
      return { data: out, width: ow, height: oh };
    }

    const mos = info.mosaic, cb = info.cblack, bl = info.black;
    const H = info.H;
    // normalised, white-balanced float plane of the crop (+2 px border for the 5×5 kernels)
    const pw = crop.w + 4, ph = crop.h + 4;
    const P = new Float32Array(pw * ph), C = new Uint8Array(pw * ph), S = new Uint8Array(pw * ph);
    // (source column and CFA column of every plane column are worked out once, not per pixel)
    const d0 = cfa.dim[0], d1 = cfa.dim[1], pat = cfa.pat, satAt = satRaw * 0.995;
    const srcX = new Int32Array(pw), patX = new Int32Array(pw);
    // Beyond the sensor's edge the mosaic is mirrored (… 2 1 | 0 1 2 …): the reflected photosite has
    // the colour the pattern expects there, which a repeated edge pixel would not.
    const mirror = (v, n) => { if (v < 0) v = -v; if (v > n - 1) v = 2 * (n - 1) - v; return Math.min(n - 1, Math.max(0, v)); };
    for (let x = 0; x < pw; x++) { const sx = mirror(crop.x + x - 2, W); srcX[x] = sx; patX[x] = ((sx - ox) % d1 + d1) % d1; }
    const g0 = g[0], g1 = g[1], g2 = g[2], cb0 = cb[0], cb1 = cb[1], cb2 = cb[2];
    for (let y = 0; y < ph; y++) {
      const sy = mirror(crop.y + y - 2, H);
      const prow = ((sy - oy) % d0 + d0) % d0 * d1, srow = sy * W, drow = y * pw;
      for (let x = 0; x < pw; x++) {
        let c = pat[prow + patX[x]]; if (c === 3) c = 1;
        const raw = mos[srow + srcX[x]], i = drow + x;
        C[i] = c; S[i] = raw - bl >= satAt ? 1 : 0;
        P[i] = c === 0 ? Math.max(0, raw - bl - cb0) * g0 : c === 1 ? Math.max(0, raw - bl - cb1) * g1 : Math.max(0, raw - bl - cb2) * g2;
      }
    }
    if (half) {
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const s = [0, 0, 0], n = [0, 0, 0]; let clipped = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const i = (y * 2 + dy + 2) * pw + x * 2 + dx + 2; s[C[i]] += P[i]; n[C[i]]++; clipped |= S[i]; }
        emit((y * ow + x) * 4, Math.min(s[0] / (n[0] || 1), clipAt[0]), Math.min(s[1] / (n[1] || 1), clipAt[1]), Math.min(s[2] / (n[2] || 1), clipAt[2]), clipped);
      }
      return { data: out, width: ow, height: oh };
    }
    // Malvar-He-Cutler gradient-corrected bilinear demosaic (2×2 Bayer)
    // This loop runs once per pixel of the photo, so the colour conversion and encoding (emit / encode
    // above) are written out in place and the three channels live in plain variables.
    let cr = 0, cg = 0, cbl = 0;
    const clip0 = clipAt[0], clip1 = clipAt[1], clip2 = clipAt[2];
    for (let y = 0; y < oh; y++) {
      let i = (y + 2) * pw + 2, o = y * ow * 4;
      for (let x = 0; x < ow; x++, i++, o += 4) {
        const c = C[i], v = P[i];
        const N = P[i - pw], Sx = P[i + pw], E = P[i + 1], Wv = P[i - 1];
        const NN = P[i - 2 * pw], SS = P[i + 2 * pw], EE = P[i + 2], WW = P[i - 2];
        const NE = P[i - pw + 1], NW = P[i - pw - 1], SE = P[i + pw + 1], SWv = P[i + pw - 1];
        if (c === 1) {
          // green site: the colour of horizontal neighbours vs vertical neighbours
          const hc = C[i + 1], vc = C[i + pw];
          const along = (5 * v + 0.5 * (NN + SS) - (WW + EE + NE + NW + SE + SWv) + 4 * (E + Wv)) / 8;   // horizontal neighbour colour
          const across = (5 * v + 0.5 * (WW + EE) - (NN + SS + NE + NW + SE + SWv) + 4 * (N + Sx)) / 8;  // vertical neighbour colour
          cg = v;
          if (hc === 0) cr = along; else if (hc === 1) cg = along; else cbl = along;
          if (vc === 0) cr = across; else if (vc === 1) cg = across; else cbl = across;
        } else {
          const gv = (4 * v + 2 * (N + Sx + E + Wv) - (NN + SS + EE + WW)) / 8;
          const ov = (6 * v + 2 * (NE + NW + SE + SWv) - 1.5 * (NN + SS + EE + WW)) / 8;
          cg = gv;
          if (c === 0) { cr = v; cbl = ov; } else { cbl = v; cr = ov; }
        }
        const clipped = S[i] | S[i - 1] | S[i + 1] | S[i - pw] | S[i + pw] | S[i - pw - 1] | S[i - pw + 1] | S[i + pw - 1] | S[i + pw + 1];
        let r = Math.min(Math.max(0, cr), clip0), gg = Math.min(Math.max(0, cg), clip1), b = Math.min(Math.max(0, cbl), clip2);
        if (clipped) { const t = Math.min(r, gg, b); r = gg = b = Math.max(t, 1); }
        let R = (m0 * r + m1 * gg + m2 * b) * K, G = (m3 * r + m4 * gg + m5 * b) * K, B = (m6 * r + m7 * gg + m8 * b) * K;
        const mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
        if (mn < 0) {
          const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
          if (Y > 0) { const t = Y / (Y - mn); R = Y + (R - Y) * t; G = Y + (G - Y) * t; B = Y + (B - Y) * t; } else R = G = B = 0;
        }
        let f, q;
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        f = R <= 0 ? 0 : R >= 16 ? LUTN : R / 16 * LUTN; q = enc[f | 0] + (seed / 0x7fffffff - 0.5);
        out[o] = q < 0 ? 0 : q > 255 ? 255 : q + 0.5;
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        f = G <= 0 ? 0 : G >= 16 ? LUTN : G / 16 * LUTN; q = enc[f | 0] + (seed / 0x7fffffff - 0.5);
        out[o + 1] = q < 0 ? 0 : q > 255 ? 255 : q + 0.5;
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        f = B <= 0 ? 0 : B >= 16 ? LUTN : B / 16 * LUTN; q = enc[f | 0] + (seed / 0x7fffffff - 0.5);
        out[o + 2] = q < 0 ? 0 : q > 255 ? 255 : q + 0.5;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: ow, height: oh };
  }

  /**
   * Colour-noise reduction on the developed 8-bit image: chroma (R−G, B−G) is box-blurred twice
   * (≈ Gaussian) and blended back; luminance detail is untouched. amount 0…1.
   */
  function chromaNR(px, w, h, amount, radius) {
    if (!(amount > 0)) return;
    const n = w * h, cr = new Int16Array(n), cb = new Int16Array(n), tmp = new Int16Array(n);
    for (let i = 0; i < n; i++) { const o = i * 4; cr[i] = px[o] - px[o + 1]; cb[i] = px[o + 2] - px[o + 1]; }
    // Running box sums with clamped edges. The window is 2·radius+1 wide — odd, so sum/size is
    // never exactly …·5 and floor(x + 0.5) rounds the same way as Math.round(sum / size).
    const size = 2 * radius + 1, inv = 1 / size;
    const boxH = (src, dst) => {
      const last = w - 1;
      for (let y = 0; y < h; y++) {
        const row = y * w; let acc = 0;
        for (let x = -radius; x <= radius; x++) acc += src[row + (x < 0 ? 0 : x > last ? last : x)];
        for (let x = 0; x < w; x++) {
          dst[row + x] = Math.floor(acc * inv + 0.5);
          const a = x + radius + 1, b = x - radius;
          acc += src[row + (a > last ? last : a)] - src[row + (b < 0 ? 0 : b)];
        }
      }
    };
    // Vertical pass, walking the image row by row (one running sum per column) so memory is read in order
    const colAcc = new Int32Array(w);
    const boxV = (src, dst) => {
      const last = h - 1;
      colAcc.fill(0);
      for (let y = -radius; y <= radius; y++) {
        const row = (y < 0 ? 0 : y > last ? last : y) * w;
        for (let x = 0; x < w; x++) colAcc[x] += src[row + x];
      }
      for (let y = 0; y < h; y++) {
        const row = y * w, a = y + radius + 1, b = y - radius;
        const add = (a > last ? last : a) * w, sub = (b < 0 ? 0 : b) * w;
        for (let x = 0; x < w; x++) {
          const acc = colAcc[x];
          dst[row + x] = Math.floor(acc * inv + 0.5);
          colAcc[x] = acc + src[add + x] - src[sub + x];
        }
      }
    };
    for (const plane of [cr, cb]) for (let pass = 0; pass < 2; pass++) { boxH(plane, tmp); boxV(tmp, plane); }
    for (let i = 0; i < n; i++) {
      const o = i * 4, g = px[o + 1];
      const r0 = px[o] - g, b0 = px[o + 2] - g;
      // keep strong, real colour edges: blend less where the blurred chroma differs a lot
      const dr = cr[i] - r0, db = cb[i] - b0;
      const k = amount / (1 + (dr * dr + db * db) / 900);
      const r = r0 + dr * k, b = b0 + db * k;
      // re-balance green so luminance stays put
      const dY = 0.2126 * (r - r0) + 0.0722 * (b - b0);
      const g2 = g - dY / (0.2126 + 0.7152 + 0.0722);
      px[o] = g2 + r; px[o + 1] = g2; px[o + 2] = g2 + b;
    }
  }

  /* ---------------- worker entry points ---------------- */
  let cached = null; // { key, info }
  /** pre: picture data that was decoded beforehand ({ data: Uint16Array 0…65535, width, height }) — JPEG XL inside a DNG. */
  let preDecoded = null;
  function phaseA(key, bytes, pre) {
    preDecoded = pre || null;
    let info;
    try { info = decodeMosaic(bytes); } finally { preDecoded = null; }
    const cm = cameraMatrix(info);
    if (cm && cm.tblBlack > 0 && !info.dng && !info.black) info.black = cm.tblBlack;
    if (cm && cm.tblMax > 0 && !info.dng && cm.tblMax < info.white) info.white = cm.tblMax;
    const gw = 48, gh = Math.max(8, Math.round(48 * info.crop.h / info.crop.w));
    const cells = info.linearRaw ? linearRawCells(info, gw, gh) : cellStats(info, gw, gh);
    cached = { key, info };
    let m = null, daylight = null;
    if (cm) { const t = camToSrgb(cm.xyzCam); m = t.m; daylight = t.daylight; }
    return {
      key, make: info.make, model: info.model, width: info.crop.w, height: info.crop.h, orientation: info.orientation,
      cells, gw, gh, m, daylight, asShot: info.asShot, matrixSource: cm ? cm.source : null, baselineExp: info.baselineExp,
      bps: info.bps, black: info.black, white: info.white,
      // a Bayer mosaic can be handed to several workers and developed in horizontal strips
      parallel: !info.linearRaw && info.mosaic instanceof Uint16Array && typeof SharedArrayBuffer !== 'undefined'
    };
  }
  /**
   * Hand the decoded mosaic over for strip development: the mosaic moves into shared memory
   * (every worker reads the same copy) and this worker lets go of it.
   */
  function share(key) {
    if (!cached || cached.key !== key) throw new Error('raw-not-cached');
    const info = cached.info, src = info.mosaic;
    cached = null;
    const mosaic = new SharedArrayBuffer(src.byteLength);
    new Uint16Array(mosaic).set(src);
    return { info: Object.assign({}, info, { mosaic: null }), mosaic };
  }
  /**
   * Develop rows [y0, y1) of the image into shared.out (RGBA for the whole image). The strip is
   * developed with a few extra rows above and below, so the colour-noise blur sees the same
   * neighbours it would in the whole image and strips join without a seam.
   * opts: develop() options + rows: [y0, y1], nrRadius.
   */
  function strip(shared, opts) {
    const info = Object.assign({}, shared.info, { mosaic: new Uint16Array(shared.mosaic) });
    const full = info.crop, y0 = opts.rows[0], y1 = opts.rows[1], radius = opts.nrRadius || 1;
    const margin = opts.chromaNR ? 2 * radius + 2 : 0;
    const ya = Math.max(0, y0 - margin), yb = Math.min(full.h, y1 + margin);
    info.crop = { x: full.x, y: full.y + ya, w: full.w, h: yb - ya };
    // each strip gets its own dither sequence
    const r = develop(info, Object.assign({}, opts, { half: false, seed: ((12345 + ya * 2654435) & 0x7fffffff) || 12345 }));
    if (opts.chromaNR) chromaNR(r.data, r.width, r.height, opts.chromaNR, radius);
    const rowBytes = r.width * 4;
    new Uint8ClampedArray(shared.out).set(r.data.subarray((y0 - ya) * rowBytes, (y1 - ya) * rowBytes), y0 * rowBytes);
    return { width: full.w, height: full.h };
  }
  function phaseB(key, opts, bytes) {
    if (!cached || cached.key !== key) { if (!bytes) throw new Error('raw-not-cached'); phaseA(key, bytes); }
    const r = develop(cached.info, opts);
    if (opts.chromaNR) chromaNR(r.data, r.width, r.height, opts.chromaNR, Math.max(1, Math.round(Math.max(r.width, r.height) / 1600)));
    if (!opts.keep) cached = null;
    return r;
  }

  global.PJ = global.PJ || {};
  global.PJ.RawDec = { phaseA, phaseB, share, strip, decodeMosaic, cameraMatrix, camToSrgb, lj92, _test: { makeDecoder, Bits } };
})(typeof self !== 'undefined' ? self : this);
