/* =====================================================================
 * photos.jpeg — decoders for image formats browsers don't open themselves.
 *   TIFF   8/16/32-bit int & float, RGB/gray/palette/CMYK, strips & tiles,
 *          none/LZW/Deflate/PackBits, horizontal & float predictors
 *   PSD/PSB  flattened composite, 8/16/32-bit, RGB/gray/CMYK, raw & RLE
 *   OpenEXR  scanline, NONE/RLE/ZIPS/ZIP, half & float  (HDR → tone-mapped)
 *   Radiance HDR (.hdr/.pic), PFM, PNM/PAM (.pbm .pgm .ppm .pnm .pam),
 *   TGA, QOI, HEIC/HEIF (HEVC tiles via WebCodecs)
 * Each returns { width, height, data: Uint8ClampedArray RGBA, note, exif? }.
 * ===================================================================== */
(function (global) {
  'use strict';

  const FORMATS = {
    tif: 'tiff', tiff: 'tiff', psd: 'psd', psb: 'psd', exr: 'exr', hdr: 'rgbe', pic: 'rgbe', pfm: 'pfm',
    pbm: 'pnm', pgm: 'pnm', ppm: 'pnm', pnm: 'pnm', pam: 'pnm', tga: 'tga', icb: 'tga', vda: 'tga', qoi: 'qoi',
    heic: 'heif', heif: 'heif', hif: 'heif'
  };

  /* ---------------- helpers ---------------- */
  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Deflate decompression is not available in this engine');
    for (const fmt of ['deflate', 'deflate-raw']) {
      try {
        const ds = new DecompressionStream(fmt);
        const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
        return new Uint8Array(await out.arrayBuffer());
      } catch (_) { /* try raw */ }
    }
    throw new Error('Corrupt deflate data');
  }
  function packBits(src, expected) {
    const out = new Uint8Array(expected);
    let i = 0, o = 0;
    while (i < src.length && o < expected) {
      let n = src[i++];
      if (n > 127) n -= 256;
      if (n >= 0) { for (let k = 0; k <= n && o < expected; k++) out[o++] = src[i++]; }
      else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = v; }
    }
    return out;
  }
  function lzw(src, expected) {
    const out = new Uint8Array(expected);
    const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Int32Array(4096);
    for (let k = 0; k < 256; k++) { prefix[k] = -1; suffix[k] = k; first[k] = k; len[k] = 1; }
    const stack = new Uint8Array(4096);
    let bitPos = 0, codeLen = 9, next = 258, old = -1, o = 0;
    const total = src.length * 8;
    const read = () => {
      if (bitPos + codeLen > total) return 257;
      let v = 0;
      for (let k = 0; k < codeLen; k++) { const p = bitPos + k; v = (v << 1) | ((src[p >> 3] >> (7 - (p & 7))) & 1); }
      bitPos += codeLen;
      return v;
    };
    const emit = (code) => {
      let n = 0, c = code;
      while (c >= 0 && n < 4096) { stack[n++] = suffix[c]; c = prefix[c]; }
      for (let k = n - 1; k >= 0 && o < expected; k--) out[o++] = stack[k];
    };
    while (o < expected) {
      const code = read();
      if (code === 257) break;
      if (code === 256) { codeLen = 9; next = 258; old = -1; continue; }
      if (old === -1) { emit(code); old = code; continue; }
      if (code < next) {
        emit(code);
        if (next < 4096) { prefix[next] = old; suffix[next] = first[code]; first[next] = first[old]; len[next] = len[old] + 1; next++; }
      } else {
        if (next < 4096) { prefix[next] = old; suffix[next] = first[old]; first[next] = first[old]; len[next] = len[old] + 1; next++; }
        emit(next - 1);
      }
      old = code;
      if (next + 1 >= (1 << codeLen) && codeLen < 12) codeLen++; // TIFF "early change"
    }
    return out;
  }
  function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    if (e === 0) return s * f * 5.960464477539063e-8;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  const LIN2SRGB = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) { const x = i / 4096; LIN2SRGB[i] = Math.round(255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)); }
  /** Scene-linear float RGB(A) → 8-bit sRGB, auto-exposed so the median sits near mid-grey, with a soft highlight shoulder. */
  function toneMapFloat(F, w, h, ch) {
    const n = w * h;
    const lum = [];
    const step = Math.max(1, Math.floor(n / 20000));
    for (let i = 0; i < n; i += step) { const o = i * ch; const y = 0.2126 * F[o] + 0.7152 * F[o + 1 < F.length ? o + 1 : o] + 0.0722 * F[o + 2 < F.length ? o + 2 : o]; if (isFinite(y) && y > 0) lum.push(y); }
    lum.sort((a, b) => a - b);
    const med = lum.length ? lum[lum.length >> 1] : 0.18;
    const k = Math.min(64, Math.max(1 / 64, 0.18 / Math.max(1e-6, med)));
    const exposure = Math.abs(Math.log2(k)) < 0.5 ? 1 : k; // leave already-normalized images alone
    const knee = 0.7, r = 1 - knee;
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const o = i * ch;
      for (let c = 0; c < 3; c++) {
        let v = F[o + (ch >= 3 ? c : 0)] * exposure;
        if (!(v > 0)) v = 0;
        if (v > knee) v = knee + r * (1 - Math.exp(-(v - knee) / r));
        out[i * 4 + c] = LIN2SRGB[(v * 4096) | 0];
      }
      out[i * 4 + 3] = ch === 4 || ch === 2 ? Math.max(0, Math.min(255, Math.round(F[o + ch - 1] * 255))) : 255;
    }
    return { data: out, note: exposure === 1 ? 'HDR, tone-mapped' : `HDR, tone-mapped (${exposure > 1 ? '+' : ''}${Math.log2(exposure).toFixed(1)} EV)` };
  }

  /* ---------------- TIFF ---------------- */
  async function tiff(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = v.getUint16(0) === 0x4949;
    const big = v.getUint16(2, le) === 43;
    const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
    const u64 = (o) => u32(o + (le ? 4 : 0)) * 4294967296 + u32(o + (le ? 0 : 4));
    const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
    const val = (type, off, i) => {
      switch (type) {
        case 3: return u16(off + i * 2); case 4: return u32(off + i * 4); case 16: case 18: return u64(off + i * 8);
        case 5: return u32(off + i * 8) / (u32(off + i * 8 + 4) || 1); case 11: return v.getFloat32(off + i * 4, le);
        case 12: return v.getFloat64(off + i * 8, le); case 8: return v.getInt16(off + i * 2, le); case 9: return v.getInt32(off + i * 4, le);
        default: return bytes[off + i];
      }
    };
    function readIfd(off) {
      const n = big ? u64(off) : u16(off), es = big ? 20 : 12, base = off + (big ? 8 : 2), t = {};
      for (let i = 0; i < n; i++) {
        const e = base + i * es, tag = u16(e), type = u16(e + 2), count = big ? u64(e + 4) : u32(e + 4);
        const size = (SZ[type] || 1) * count, inl = big ? 8 : 4;
        const voff = size <= inl ? e + (big ? 12 : 8) : (big ? u64(e + 12) : u32(e + 8));
        if (voff + size > bytes.length) continue;
        const lim = Math.min(count, 1 << 20), arr = new Array(lim);
        for (let k = 0; k < lim; k++) arr[k] = val(type, voff, k);
        t[tag] = arr;
      }
      return { t, next: big ? u64(base + n * es) : u32(base + n * es) };
    }
    // choose the largest full-resolution page
    let off = big ? u64(8) : u32(4), best = null, guard = 0;
    while (off && off < bytes.length && guard++ < 64) {
      const { t, next } = readIfd(off);
      const sub = (t[254] || [0])[0];
      const area = (t[256] || [0])[0] * (t[257] || [0])[0];
      if (!(sub & 1) && (!best || area > best.area)) best = { t, area };
      off = next;
    }
    if (!best) throw new Error('No image in this TIFF');
    const t = best.t, g = (k, d) => (t[k] ? t[k] : [d]);
    const W = g(256, 0)[0], H = g(257, 0)[0], spp = g(277, 1)[0], bps = g(258, 8)[0], comp = g(259, 1)[0];
    const photo = g(262, spp >= 3 ? 2 : 1)[0], planar = g(284, 1)[0], pred = g(317, 1)[0], fmt = g(339, 1)[0];
    if (![1, 5, 8, 32946, 32773].includes(comp)) throw new Error(`TIFF compression ${comp} isn't supported here`);
    if (photo === 6 || photo === 32803 || photo === 34892) throw new Error('This TIFF needs the native decoder');
    const tiled = !!t[322];
    const tw = tiled ? g(322, W)[0] : W, th = tiled ? g(323, H)[0] : g(278, H)[0];
    const offs = tiled ? t[324] : t[273], cnts = tiled ? t[325] : t[279];
    if (!offs) throw new Error('Corrupt TIFF');
    const planes = planar === 2 ? spp : 1, perPix = planar === 2 ? 1 : spp;
    const bytesPer = bps / 8;
    const across = tiled ? Math.ceil(W / tw) : 1, down = Math.ceil(H / th);
    const blocksPerPlane = across * down;
    // decode into a float plane buffer (values 0…1 for ints, raw for floats)
    const F = new Float32Array(W * H * spp);
    const maxv = fmt === 3 ? 1 : Math.pow(2, bps) - 1;
    for (let b = 0; b < offs.length; b++) {
      const plane = Math.floor(b / blocksPerPlane), k = b % blocksPerPlane;
      const bx = (k % across) * tw, by = Math.floor(k / across) * th;
      const rows = Math.min(th, H - by), cols = tiled ? tw : W;
      const rowBytes = Math.ceil(cols * perPix * bps / 8);
      const expected = rowBytes * (tiled ? th : rows);
      let raw = bytes.subarray(offs[b], offs[b] + cnts[b]);
      if (comp === 5) raw = lzw(raw, expected);
      else if (comp === 8 || comp === 32946) raw = await inflate(raw);
      else if (comp === 32773) raw = packBits(raw, expected);
      raw = raw.slice ? raw.slice(0, Math.max(expected, 0)) : raw;
      if (raw.length < expected) { const r2 = new Uint8Array(expected); r2.set(raw); raw = r2; }
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      // predictors
      if (pred === 2) {
        for (let y = 0; y < (tiled ? th : rows); y++) {
          if (bps === 8) { const o = y * rowBytes; for (let x = perPix; x < cols * perPix; x++) raw[o + x] = (raw[o + x] + raw[o + x - perPix]) & 255; }
          else if (bps === 16) { const o = y * rowBytes; for (let x = perPix; x < cols * perPix; x++) dv.setUint16(o + x * 2, (dv.getUint16(o + x * 2, le) + dv.getUint16(o + (x - perPix) * 2, le)) & 65535, le); }
        }
      } else if (pred === 3 && fmt === 3) {
        // floating-point predictor: byte-wise delta then de-interleave the byte planes
        const bpS = bytesPer, rowN = cols * perPix;
        for (let y = 0; y < (tiled ? th : rows); y++) {
          const o = y * rowBytes;
          for (let x = 1; x < rowN * bpS; x++) raw[o + x] = (raw[o + x] + raw[o + x - 1]) & 255;
          const tmp = raw.slice(o, o + rowN * bpS);
          for (let x = 0; x < rowN; x++) for (let q = 0; q < bpS; q++) raw[o + x * bpS + (le ? bpS - 1 - q : q)] = tmp[q * rowN + x];
        }
      }
      for (let y = 0; y < rows; y++) {
        const yy = by + y;
        for (let x = 0; x < cols; x++) {
          const xx = bx + x;
          if (xx >= W) break;
          for (let c = 0; c < perPix; c++) {
            const si = x * perPix + c, ch = planar === 2 ? plane : c;
            let value;
            if (bps === 8) value = raw[y * rowBytes + si];
            else if (bps === 16) value = fmt === 3 ? halfToFloat(dv.getUint16(y * rowBytes + si * 2, le)) : dv.getUint16(y * rowBytes + si * 2, le);
            else if (bps === 32) value = fmt === 3 ? dv.getFloat32(y * rowBytes + si * 4, le) : dv.getUint32(y * rowBytes + si * 4, le);
            else if (bps === 64 && fmt === 3) value = dv.getFloat64(y * rowBytes + si * 8, le);
            else { // 1, 2, 4 … bit
              const bit = y * rowBytes * 8 + si * bps;
              value = (raw[bit >> 3] >> (8 - bps - (bit & 7))) & ((1 << bps) - 1);
            }
            F[(yy * W + xx) * spp + ch] = fmt === 3 ? value : value / maxv;
          }
        }
      }
    }
    const isFloat = fmt === 3;
    const N = W * H;
    // colour conversion to RGBA
    let rgba;
    let note = `${bps}-bit TIFF`;
    if (isFloat) {
      const ch = photo === 1 || photo === 0 ? 1 : Math.min(spp, 4);
      const tmp = new Float32Array(N * Math.max(ch, 3));
      const och = Math.max(ch, 3);
      for (let i = 0; i < N; i++) for (let c = 0; c < och; c++) tmp[i * och + c] = F[i * spp + (ch === 1 ? 0 : Math.min(c, spp - 1))];
      const r = toneMapFloat(tmp, W, H, och);
      return { width: W, height: H, data: r.data, note: `Float TIFF · ${r.note}` };
    }
    rgba = new Uint8ClampedArray(N * 4);
    const cmap = t[320];
    for (let i = 0; i < N; i++) {
      const s = i * spp, o = i * 4;
      if (photo === 2) { rgba[o] = F[s] * 255; rgba[o + 1] = F[s + 1] * 255; rgba[o + 2] = F[s + 2] * 255; rgba[o + 3] = spp > 3 && t[338] ? F[s + 3] * 255 : 255; }
      else if (photo === 0 || photo === 1) { const gv = photo === 0 ? 1 - F[s] : F[s]; rgba[o] = rgba[o + 1] = rgba[o + 2] = gv * 255; rgba[o + 3] = spp > 1 && t[338] ? F[s + 1] * 255 : 255; }
      else if (photo === 3 && cmap) { const n = 1 << bps, idx = Math.round(F[s] * (n - 1)); rgba[o] = cmap[idx] / 257; rgba[o + 1] = cmap[n + idx] / 257; rgba[o + 2] = cmap[2 * n + idx] / 257; rgba[o + 3] = 255; }
      else if (photo === 5) { const k = F[s + 3] || 0; rgba[o] = (1 - F[s]) * (1 - k) * 255; rgba[o + 1] = (1 - F[s + 1]) * (1 - k) * 255; rgba[o + 2] = (1 - F[s + 2]) * (1 - k) * 255; rgba[o + 3] = 255; note = 'CMYK TIFF (converted)'; }
      else { rgba[o] = rgba[o + 1] = rgba[o + 2] = F[s] * 255; rgba[o + 3] = 255; }
    }
    if (bps > 8) note += ' (edited at 8 bits)';
    return { width: W, height: H, data: rgba, note };
  }

  /* ---------------- PSD / PSB ---------------- */
  async function psd(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0) !== 0x38425053) throw new Error('Not a Photoshop file');
    const version = v.getUint16(4), psb = version === 2;
    const nch = v.getUint16(12), H = v.getUint32(14), W = v.getUint32(18), depth = v.getUint16(22), mode = v.getUint16(24);
    let p = 26;
    p += 4 + v.getUint32(p);                     // color mode data
    p += 4 + v.getUint32(p);                     // image resources
    p += psb ? 8 + (v.getUint32(p) * 4294967296 + v.getUint32(p + 4)) : 4 + v.getUint32(p); // layers & masks
    const comp = v.getUint16(p); p += 2;
    const bpc = depth / 8, rowBytes = Math.ceil(W * depth / 8), planeBytes = rowBytes * H;
    const useCh = Math.min(nch, mode === 4 ? 5 : mode === 3 ? 4 : 2);
    const planes = [];
    if (comp === 0) {
      for (let c = 0; c < useCh; c++) planes.push(bytes.subarray(p + c * planeBytes, p + (c + 1) * planeBytes));
    } else if (comp === 1) {
      const cntSize = psb ? 4 : 2, counts = [];
      for (let i = 0; i < nch * H; i++) counts.push(psb ? v.getUint32(p + i * 4) : v.getUint16(p + i * 2));
      let q = p + nch * H * cntSize;
      for (let c = 0; c < nch; c++) {
        const plane = new Uint8Array(planeBytes);
        for (let y = 0; y < H; y++) {
          const n = counts[c * H + y];
          plane.set(packBits(bytes.subarray(q, q + n), rowBytes), y * rowBytes);
          q += n;
        }
        if (c < useCh) planes.push(plane);
      }
    } else throw new Error('This PSD compression needs the native decoder');
    const N = W * H, F = (c, i) => {
      const pl = planes[c];
      if (depth === 8) return pl[i] / 255;
      if (depth === 16) return ((pl[i * 2] << 8) | pl[i * 2 + 1]) / 65535;
      if (depth === 32) { const dv = new DataView(pl.buffer, pl.byteOffset + i * 4, 4); return dv.getFloat32(0); }
      return ((pl[i >> 3] >> (7 - (i & 7))) & 1) ? 0 : 1; // bitmap: 1 = black
    };
    const rgba = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (mode === 3) {
        const enc = (x) => depth === 32 ? LIN2SRGB[Math.max(0, Math.min(4096, (x * 4096) | 0))] : x * 255;
        rgba[o] = enc(F(0, i)); rgba[o + 1] = enc(F(1, i)); rgba[o + 2] = enc(F(2, i)); rgba[o + 3] = 255;
      } else if (mode === 4) {
        // Photoshop stores CMYK inverted (0 = full ink)
        const c = F(0, i), m = F(1, i), y = F(2, i), k = F(3, i);
        rgba[o] = c * k * 255; rgba[o + 1] = m * k * 255; rgba[o + 2] = y * k * 255; rgba[o + 3] = 255;
      } else { const gv = F(0, i) * 255; rgba[o] = rgba[o + 1] = rgba[o + 2] = gv; rgba[o + 3] = 255; }
    }
    return { width: W, height: H, data: rgba, note: `Photoshop ${psb ? 'PSB' : 'PSD'} · flattened composite · ${depth}-bit ${['Bitmap', 'Grayscale', 'Indexed', 'RGB', 'CMYK'][mode] || ''}` };
  }

  /* ---------------- OpenEXR ---------------- */
  async function exr(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0, true) !== 20000630) throw new Error('Not an OpenEXR file');
    const flags = v.getUint32(4, true);
    if (flags & 0x200) throw new Error('Tiled EXR needs the native decoder');
    if (flags & 0x1000) throw new Error('Multi-part EXR needs the native decoder');
    let p = 8;
    const cstr = () => { let s = ''; while (bytes[p]) s += String.fromCharCode(bytes[p++]); p++; return s; };
    const hdr = {};
    while (bytes[p]) {
      const name = cstr(), type = cstr(), size = v.getUint32(p, true); p += 4;
      const s = p;
      if (type === 'chlist') {
        const chs = [];
        while (bytes[p]) { const n = cstr(); chs.push({ name: n, type: v.getUint32(p, true), xs: v.getInt32(p + 8, true), ys: v.getInt32(p + 12, true) }); p += 16; }
        hdr[name] = chs;
      } else if (type === 'box2i') hdr[name] = [v.getInt32(p, true), v.getInt32(p + 4, true), v.getInt32(p + 8, true), v.getInt32(p + 12, true)];
      else if (type === 'compression') hdr[name] = bytes[p];
      p = s + size;
    }
    p++;
    const [x0, y0, x1, y1] = hdr.dataWindow, W = x1 - x0 + 1, H = y1 - y0 + 1;
    const comp = hdr.compression, chans = hdr.channels.slice().sort((a, b) => a.name < b.name ? -1 : 1);
    const LPB = { 0: 1, 1: 1, 2: 1, 3: 16 }[comp];
    if (!LPB) throw new Error(`EXR compression ${['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB'][comp] || comp} needs the native decoder`);
    const nBlocks = Math.ceil(H / LPB);
    const tbl = []; for (let i = 0; i < nBlocks; i++) { tbl.push(v.getUint32(p, true) + v.getUint32(p + 4, true) * 4294967296); p += 8; }
    const bpp = (t) => t === 1 ? 2 : 4;
    const rowBytes = chans.reduce((a, c) => a + bpp(c.type) * W, 0);
    const pick = (n) => chans.findIndex(c => c.name === n || c.name.endsWith('.' + n));
    const idx = { R: pick('R'), G: pick('G'), B: pick('B'), A: pick('A'), Y: pick('Y') };
    const F = new Float32Array(W * H * 4);
    for (let b = 0; b < nBlocks; b++) {
      const o = tbl[b];
      const lines = Math.min(LPB, H - b * LPB), size = v.getUint32(o + 4, true);
      let data = bytes.subarray(o + 8, o + 8 + size);
      const expected = rowBytes * lines;
      if (size < expected) {
        let raw;
        if (comp === 1) {
          raw = new Uint8Array(expected); let i = 0, q = 0;
          while (i < data.length && q < expected) { let n = data[i++]; if (n > 127) n -= 256; if (n < 0) { for (let k = 0; k < -n; k++) raw[q++] = data[i++]; } else { const val = data[i++]; for (let k = 0; k <= n; k++) raw[q++] = val; } }
        } else raw = await inflate(data);
        // undo predictor + byte interleave (RLE and ZIP)
        for (let i = 1; i < raw.length; i++) raw[i] = (raw[i - 1] + raw[i] - 128) & 255;
        const half = Math.ceil(raw.length / 2), out = new Uint8Array(raw.length);
        for (let i = 0, a = 0, c = half; i < raw.length; ) { out[i++] = raw[a++]; if (i < raw.length) out[i++] = raw[c++]; }
        data = out;
      }
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let q = 0;
      for (let l = 0; l < lines; l++) {
        const y = b * LPB + l;
        for (let c = 0; c < chans.length; c++) {
          const ty = chans[c].type;
          for (let x = 0; x < W; x++) {
            const val = ty === 1 ? halfToFloat(dv.getUint16(q, true)) : ty === 2 ? dv.getFloat32(q, true) : dv.getUint32(q, true);
            q += bpp(ty);
            const dst = (y * W + x) * 4;
            if (c === idx.R) F[dst] = val; else if (c === idx.G) F[dst + 1] = val; else if (c === idx.B) F[dst + 2] = val; else if (c === idx.A) F[dst + 3] = val;
            else if (c === idx.Y && idx.R < 0) F[dst] = F[dst + 1] = F[dst + 2] = val;
          }
        }
      }
    }
    if (idx.A < 0) for (let i = 3; i < F.length; i += 4) F[i] = 1;
    const r = toneMapFloat(F, W, H, 4);
    return { width: W, height: H, data: r.data, note: `OpenEXR · ${r.note}` };
  }

  /* ---------------- Radiance RGBE (.hdr) ---------------- */
  function rgbe(bytes) {
    let p = 0, line = '';
    const readLine = () => { line = ''; while (p < bytes.length && bytes[p] !== 10) line += String.fromCharCode(bytes[p++]); p++; return line; };
    if (!/^#\?/.test(readLine())) throw new Error('Not a Radiance HDR file');
    while (readLine() !== '') { if (p >= bytes.length) throw new Error('Corrupt HDR header'); }
    const m = /([-+])Y\s+(\d+)\s+([-+])X\s+(\d+)/.exec(readLine());
    if (!m) throw new Error('Unsupported HDR orientation');
    const H = +m[2], W = +m[4], flipY = m[1] === '+', flipX = m[3] === '-';
    const F = new Float32Array(W * H * 3), scan = new Uint8Array(W * 4);
    for (let y = 0; y < H; y++) {
      if (W >= 8 && W < 32768 && bytes[p] === 2 && bytes[p + 1] === 2 && !(bytes[p + 2] & 128)) {
        p += 4;
        for (let c = 0; c < 4; c++) {
          let x = 0;
          while (x < W) {
            let n = bytes[p++];
            if (n > 128) { n -= 128; const val = bytes[p++]; while (n--) scan[(x++) * 4 + c] = val; }
            else while (n--) scan[(x++) * 4 + c] = bytes[p++];
          }
        }
      } else { scan.set(bytes.subarray(p, p + W * 4)); p += W * 4; }
      const yy = flipY ? H - 1 - y : y;
      for (let x = 0; x < W; x++) {
        const e = scan[x * 4 + 3], f = e ? Math.pow(2, e - 136) : 0, xx = flipX ? W - 1 - x : x, o = (yy * W + xx) * 3;
        F[o] = scan[x * 4] * f; F[o + 1] = scan[x * 4 + 1] * f; F[o + 2] = scan[x * 4 + 2] * f;
      }
    }
    const r = toneMapFloat(F, W, H, 3);
    return { width: W, height: H, data: r.data, note: `Radiance HDR · ${r.note}` };
  }

  /* ---------------- PNM / PAM / PFM ---------------- */
  function pnm(bytes) {
    let p = 2;
    const magic = String.fromCharCode(bytes[0], bytes[1]);
    const token = () => {
      while (p < bytes.length) {
        const c = bytes[p];
        if (c === 35) { while (p < bytes.length && bytes[p] !== 10) p++; }
        else if (c <= 32) p++;
        else break;
      }
      let s = ''; while (p < bytes.length && bytes[p] > 32) s += String.fromCharCode(bytes[p++]);
      return s;
    };
    let W, H, maxv = 1, ch = 1;
    if (magic === 'P7') {
      let k;
      while ((k = token()) !== 'ENDHDR') {
        const val = token();
        if (k === 'WIDTH') W = +val; else if (k === 'HEIGHT') H = +val; else if (k === 'DEPTH') ch = +val; else if (k === 'MAXVAL') maxv = +val; else if (k === 'TUPLTYPE') { /* informational */ }
        if (p >= bytes.length) throw new Error('Corrupt PAM');
      }
      p++;
    } else if (magic === 'Pf' || magic === 'PF') {
      W = +token(); H = +token(); const scale = parseFloat(token()); p++;
      ch = magic === 'PF' ? 3 : 1;
      const le = scale < 0, dv = new DataView(bytes.buffer, bytes.byteOffset + p);
      const F = new Float32Array(W * H * 3);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
        const src = ((H - 1 - y) * W + x) * ch + (ch === 1 ? 0 : c); // PFM rows are bottom-up
        F[(y * W + x) * 3 + c] = dv.getFloat32(src * 4, le) * Math.abs(scale);
      }
      const r = toneMapFloat(F, W, H, 3);
      return { width: W, height: H, data: r.data, note: `PFM · ${r.note}` };
    } else {
      W = +token(); H = +token();
      if (magic !== 'P1' && magic !== 'P4') maxv = +token();
      ch = magic === 'P3' || magic === 'P6' ? 3 : 1;
      p++;
    }
    const N = W * H, rgba = new Uint8ClampedArray(N * 4);
    const ascii = magic === 'P1' || magic === 'P2' || magic === 'P3';
    const wide = maxv > 255;
    let bitRow = Math.ceil(W / 8);
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const sample = (c) => {
        if (ascii) return +token();
        if (magic === 'P4') { const y = (i / W) | 0, x = i % W; return (bytes[p + y * bitRow + (x >> 3)] >> (7 - (x & 7))) & 1; }
        const k = i * ch + c;
        return wide ? (bytes[p + k * 2] << 8) | bytes[p + k * 2 + 1] : bytes[p + k];
      };
      if (magic === 'P1' || magic === 'P4') { const b = sample(0) ? 0 : 255; rgba[o] = rgba[o + 1] = rgba[o + 2] = b; rgba[o + 3] = 255; continue; }
      const vals = []; for (let c = 0; c < ch; c++) vals.push(sample(c) / maxv * 255);
      if (ch >= 3) { rgba[o] = vals[0]; rgba[o + 1] = vals[1]; rgba[o + 2] = vals[2]; rgba[o + 3] = ch === 4 ? vals[3] : 255; }
      else { rgba[o] = rgba[o + 1] = rgba[o + 2] = vals[0]; rgba[o + 3] = ch === 2 ? vals[1] : 255; }
    }
    return { width: W, height: H, data: rgba, note: `Netpbm ${magic}${wide ? ' 16-bit' : ''}` };
  }

  /* ---------------- TGA ---------------- */
  function tga(bytes) {
    const idLen = bytes[0], cmType = bytes[1], type = bytes[2];
    const cmFirst = bytes[3] | (bytes[4] << 8), cmLen = bytes[5] | (bytes[6] << 8), cmBits = bytes[7];
    const W = bytes[12] | (bytes[13] << 8), H = bytes[14] | (bytes[15] << 8), bpp = bytes[16], desc = bytes[17];
    if (![1, 2, 3, 9, 10, 11].includes(type) || !W || !H) throw new Error('Not a TGA image');
    let p = 18 + idLen;
    const cmBytes = Math.ceil(cmBits / 8), cmap = cmType ? bytes.subarray(p, p + cmLen * cmBytes) : null;
    p += cmType ? cmLen * cmBytes : 0;
    const pxBytes = Math.ceil(bpp / 8), N = W * H;
    const px = new Uint8Array(N * pxBytes);
    if (type >= 9) {
      let o = 0;
      while (o < px.length && p < bytes.length) {
        const h = bytes[p++], n = (h & 127) + 1;
        if (h & 128) { const v = bytes.subarray(p, p + pxBytes); p += pxBytes; for (let k = 0; k < n; k++) { px.set(v, o); o += pxBytes; } }
        else { px.set(bytes.subarray(p, p + n * pxBytes), o); p += n * pxBytes; o += n * pxBytes; }
      }
    } else px.set(bytes.subarray(p, p + px.length));
    const toRGBA = (src, bits, out, o) => {
      if (bits === 8) { out[o] = out[o + 1] = out[o + 2] = src[0]; out[o + 3] = 255; }
      else if (bits === 15 || bits === 16) { const v = src[0] | (src[1] << 8); out[o] = ((v >> 10) & 31) * 255 / 31; out[o + 1] = ((v >> 5) & 31) * 255 / 31; out[o + 2] = (v & 31) * 255 / 31; out[o + 3] = 255; }
      else { out[o] = src[2]; out[o + 1] = src[1]; out[o + 2] = src[0]; out[o + 3] = bits === 32 ? src[3] : 255; }
    };
    const rgba = new Uint8ClampedArray(N * 4), top = !!(desc & 32), right = !!(desc & 16);
    const alphaBits = desc & 15;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const si = (y * W + x) * pxBytes, dy = top ? y : H - 1 - y, dx = right ? W - 1 - x : x, o = (dy * W + dx) * 4;
      if (type === 1 || type === 9) { const idx = (px[si] | (pxBytes > 1 ? px[si + 1] << 8 : 0)) - cmFirst; toRGBA(cmap.subarray(idx * cmBytes, idx * cmBytes + cmBytes), cmBits, rgba, o); }
      else toRGBA(px.subarray(si, si + pxBytes), (type === 3 || type === 11) ? 8 : bpp, rgba, o);
      if (bpp === 32 && !alphaBits) rgba[o + 3] = 255;
    }
    return { width: W, height: H, data: rgba, note: 'Targa' };
  }

  /* ---------------- QOI ---------------- */
  function qoi(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0) !== 0x716f6966) throw new Error('Not a QOI image');
    const W = v.getUint32(4), H = v.getUint32(8), N = W * H;
    const out = new Uint8ClampedArray(N * 4), idx = new Uint8Array(256);
    let r = 0, g = 0, b = 0, a = 255, p = 14, run = 0;
    for (let i = 0; i < N; i++) {
      if (run > 0) run--;
      else {
        const b1 = bytes[p++];
        if (b1 === 0xFE) { r = bytes[p++]; g = bytes[p++]; b = bytes[p++]; }
        else if (b1 === 0xFF) { r = bytes[p++]; g = bytes[p++]; b = bytes[p++]; a = bytes[p++]; }
        else if ((b1 & 0xC0) === 0x00) { const k = b1 * 4; r = idx[k]; g = idx[k + 1]; b = idx[k + 2]; a = idx[k + 3]; }
        else if ((b1 & 0xC0) === 0x40) { r = (r + ((b1 >> 4) & 3) - 2) & 255; g = (g + ((b1 >> 2) & 3) - 2) & 255; b = (b + (b1 & 3) - 2) & 255; }
        else if ((b1 & 0xC0) === 0x80) { const b2 = bytes[p++], vg = (b1 & 63) - 32; r = (r + vg - 8 + ((b2 >> 4) & 15)) & 255; g = (g + vg) & 255; b = (b + vg - 8 + (b2 & 15)) & 255; }
        else run = b1 & 63;
        const k = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
        idx[k] = r; idx[k + 1] = g; idx[k + 2] = b; idx[k + 3] = a;
      }
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
    }
    return { width: W, height: H, data: out, note: 'QOI' };
  }

  /* ---------------- HEIF / HEIC ---------------- */
  function heifParse(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (o) => v.getUint32(o), u16 = (o) => v.getUint16(o);
    const fourcc = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    function* boxes(s, e) {
      while (s + 8 <= e) {
        let size = u32(s); const type = fourcc(s + 4); let h = 8;
        if (size === 1) { size = u32(s + 8) * 4294967296 + u32(s + 12); h = 16; } else if (size === 0) size = e - s;
        if (size < 8) return;
        yield { type, start: s, data: s + h, end: s + size };
        s += size;
      }
    }
    const top = [...boxes(0, bytes.length)];
    const meta = top.find(b => b.type === 'meta');
    if (!meta) throw new Error('Not a HEIF image');
    const mb = [...boxes(meta.data + 4, meta.end)];
    const get = (t) => mb.find(b => b.type === t);
    const pitm = get('pitm'); const primary = bytes[pitm.data] ? u32(pitm.data + 4) : u16(pitm.data + 4);
    const items = new Map();
    const iinf = get('iinf');
    const iv = bytes[iinf.data];
    for (const infe of boxes(iinf.data + (iv ? 8 : 6), iinf.end)) {
      const ver = bytes[infe.data];
      let q = infe.data + 4;
      const id = ver >= 3 ? u32(q) : u16(q); q += ver >= 3 ? 4 : 2;
      q += 2; // protection index
      const type = ver >= 2 ? fourcc(q) : '';
      items.set(id, { id, type, props: [], refs: {} });
    }
    const iloc = get('iloc'), lv = bytes[iloc.data];
    let q = iloc.data + 4;
    const os = bytes[q] >> 4, ls = bytes[q] & 15, bs = bytes[q + 1] >> 4, is = lv >= 1 ? bytes[q + 1] & 15 : 0; q += 2;
    const rd = (n) => { let x = 0; for (let k = 0; k < n; k++) x = x * 256 + bytes[q++]; return x; };
    const count = lv < 2 ? rd(2) : rd(4);
    const idat = get('idat');
    for (let i = 0; i < count; i++) {
      const id = lv < 2 ? rd(2) : rd(4);
      const cm = lv >= 1 ? rd(2) & 15 : 0;
      rd(2); const base = rd(bs), ne = rd(2), ext = [];
      for (let k = 0; k < ne; k++) { if (is) rd(is); const off = rd(os), len = rd(ls); ext.push([(cm === 1 && idat ? idat.data : 0) + base + off, len]); }
      if (items.has(id)) items.get(id).extents = ext;
    }
    const iref = get('iref');
    if (iref) {
      const rv = bytes[iref.data];
      for (const r of boxes(iref.data + 4, iref.end)) {
        let p2 = r.data; const w = rv ? 4 : 2, rdv = () => { const x = w === 4 ? u32(p2) : u16(p2); p2 += w; return x; };
        const from = rdv(), n = u16(p2); p2 += 2; const to = []; for (let k = 0; k < n; k++) to.push(rdv());
        if (items.has(from)) items.get(from).refs[r.type] = to;
      }
    }
    const iprp = get('iprp'); const ip = [...boxes(iprp.data, iprp.end)];
    const ipco = ip.find(b => b.type === 'ipco'); const props = [...boxes(ipco.data, ipco.end)];
    for (const ipma of ip.filter(b => b.type === 'ipma')) {
      const ver = bytes[ipma.data], fl = bytes[ipma.data + 3]; let p3 = ipma.data + 4;
      const n = u32(p3); p3 += 4;
      for (let i = 0; i < n; i++) {
        const id = ver < 1 ? u16(p3) : u32(p3); p3 += ver < 1 ? 2 : 4;
        const na = bytes[p3++];
        for (let k = 0; k < na; k++) {
          let x; if (fl & 1) { x = u16(p3) & 0x7fff; p3 += 2; } else { x = bytes[p3++] & 0x7f; }
          if (x && items.has(id)) items.get(id).props.push(props[x - 1]);
        }
      }
    }
    const data = (it) => { const parts = it.extents.map(([o, l]) => bytes.subarray(o, o + l)); if (parts.length === 1) return parts[0]; const tot = parts.reduce((a, b) => a + b.length, 0), out = new Uint8Array(tot); let o = 0; parts.forEach(p4 => { out.set(p4, o); o += p4.length; }); return out; };
    return { bytes, items, primary, data, prop: (it, t) => it.props.find(pp => pp.type === t), fourcc };
  }
  function hvcCodec(b) {
    const ps = b[1] >> 6, tier = (b[1] >> 5) & 1, pidc = b[1] & 31;
    let compat = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0, rev = 0;
    for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
    const cons = [b[6], b[7], b[8], b[9], b[10], b[11]];
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    return `hvc1.${['', 'A', 'B', 'C'][ps]}${pidc}.${(rev >>> 0).toString(16)}.${tier ? 'H' : 'L'}${b[12]}${cons.map(c => '.' + c.toString(16)).join('')}`;
  }
  async function heif(bytes) {
    const H = heifParse(bytes);
    const prim = H.items.get(H.primary);
    if (!prim) throw new Error('HEIF has no primary image');
    const tiles = prim.type === 'grid' ? (prim.refs.dimg || []).map(id => H.items.get(id)) : [prim];
    if (!tiles.length || tiles[0].type !== 'hvc1') throw new Error(`HEIF ${tiles[0] ? tiles[0].type : ''} images need the native decoder`);
    const hvcC = H.prop(tiles[0], 'hvcC'), ispe = H.prop(tiles[0], 'ispe');
    if (!hvcC || typeof VideoDecoder === 'undefined') throw new Error('HEIC needs HEVC decoding, which this engine lacks');
    const desc = bytes.slice(hvcC.data, hvcC.end);
    const tw = new DataView(bytes.buffer, bytes.byteOffset + ispe.data + 4, 8).getUint32(0), th = new DataView(bytes.buffer, bytes.byteOffset + ispe.data + 4, 8).getUint32(4);
    let cols = 1, rows = 1, W = tw, Ht = th;
    if (prim.type === 'grid') {
      const g = H.data(prim), wide = g[1] & 1;
      rows = g[2] + 1; cols = g[3] + 1;
      const dv = new DataView(g.buffer, g.byteOffset);
      W = wide ? dv.getUint32(4) : dv.getUint16(4); Ht = wide ? dv.getUint32(8) : dv.getUint16(6);
    }
    const config = { codec: hvcCodec(desc), description: desc, codedWidth: tw, codedHeight: th };
    const sup = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!sup.supported) throw new Error('HEIC needs an HEVC decoder (macOS, Windows with HEVC extensions, Android)');
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = Ht;
    const ctx = canvas.getContext('2d');
    let err = null, idx = 0;
    const frames = [];
    const dec = new VideoDecoder({ output: (f) => frames.push(f), error: (e) => { err = e; } });
    dec.configure(config);
    tiles.forEach((t, i) => dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data: H.data(t) })));
    await dec.flush();
    dec.close();
    if (err) throw err;
    frames.sort((a, b) => a.timestamp - b.timestamp);
    for (const f of frames) {
      const i = f.timestamp, x = (i % cols) * tw, y = Math.floor(i / cols) * th;
      ctx.drawImage(f, x, y, tw, th);
      f.close(); idx++;
    }
    if (idx !== tiles.length) throw new Error('Some HEIC tiles failed to decode');
    // rotation / mirror properties of the primary item
    let out = canvas;
    const irot = H.prop(prim, 'irot'), imir = H.prop(prim, 'imir');
    const rot = irot ? (bytes[irot.data] & 3) * 90 : 0;
    if (rot || imir) {
      const c2 = document.createElement('canvas'); const sw = rot % 180 ? Ht : W, sh = rot % 180 ? W : Ht;
      c2.width = sw; c2.height = sh; const x2 = c2.getContext('2d');
      x2.translate(sw / 2, sh / 2); x2.rotate(-rot * Math.PI / 180);
      if (imir) { const axis = bytes[imir.data] & 1; if (axis) x2.scale(-1, 1); else x2.scale(1, -1); }
      x2.drawImage(canvas, -W / 2, -Ht / 2); out = c2;
    }
    // Exif item
    let exif = null;
    for (const it of H.items.values()) if (it.type === 'Exif' && it.extents) { const d = H.data(it); const off = new DataView(d.buffer, d.byteOffset).getUint32(0); exif = d.subarray(4 + off); break; }
    return { canvas: out, width: out.width, height: out.height, note: `HEIC${prim.type === 'grid' ? ` · ${cols}×${rows} tiles` : ''}`, exifBytes: exif };
  }

  /* ---------------- entry ---------------- */
  const DECODERS = { tiff, psd, exr, rgbe, pfm: pnm, pnm, tga, qoi, heif };
  function kindFor(ext) { return FORMATS[ext] || null; }
  /** Decode with the JS decoder for this extension; throws if it can't. */
  async function decode(bytes, ext) {
    const k = kindFor(ext);
    if (!k) throw new Error('No decoder');
    return DECODERS[k](bytes);
  }
  global.PJ = global.PJ || {};
  global.PJ.Formats = { decode, kindFor, FORMATS, _test: { lzw, packBits, halfToFloat, toneMapFloat, hvcCodec } };
})(window);
