/* =====================================================================
 * photos.jpeg — Export: batch export with resizing, output sharpening,
 * naming templates, watermarks, metadata and export presets.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, UI = PJ.UI, Cat = PJ.Catalog, E = PJ.Engine, API = PJ.API, Dec = PJ.Decode;
  const { h, icon } = UI;

  const DEFAULTS = {
    dest: 'choose', folder: '', subfolder: '', useSub: false,
    template: '{name}', custom: '', seqStart: 1,
    format: 'jpeg', quality: 90, tiffBits: 8, colorSpace: 'srgb',
    resize: 'none', long: 2048, short: 1080, width: 1920, height: 1080, mp: 12, percent: 50, dontEnlarge: true,
    sharpen: 'none',
    metadata: 'all',
    wm: false, wmText: '© ', wmSize: 3, wmOpacity: 60, wmPos: 'br', wmColor: '#ffffff',
    conflict: 'unique',
    reveal: true,
    // video
    videoMode: 'video', vcodec: 'avc', vsize: 'original', vquality: 'high', vaudio: true, vtrim: true
  };

  /* ---------------- encoders ---------------- */
  /**
   * Uncompressed RGB TIFF. img: { width, height, data (RGBA 8-bit) } or { width, height, data16 (RGB 16-bit) };
   * icc: profile bytes to embed (optional).
   */
  function encodeTiffRich(img, icc) {
    const w = img.width, hgt = img.height, deep = !!img.data16, bps = deep ? 16 : 8;
    const soft = 'photos.jpeg\0';
    const tags = [];   // [tag, type, count, value | bytes]
    const pix = w * hgt * 3 * (deep ? 2 : 1);
    tags.push([256, 4, 1, w], [257, 4, 1, hgt], [258, 3, 3, Uint8Array.from([bps, 0, bps, 0, bps, 0])], [259, 3, 1, 1], [262, 3, 1, 2],
      [273, 4, 1, 0], [277, 3, 1, 3], [278, 4, 1, hgt], [279, 4, 1, pix],
      [282, 5, 1, Uint8Array.from([44, 1, 0, 0, 1, 0, 0, 0])], [283, 5, 1, Uint8Array.from([44, 1, 0, 0, 1, 0, 0, 0])], [284, 3, 1, 1], [296, 3, 1, 2],
      [305, 2, soft.length, Uint8Array.from(soft, ch => ch.charCodeAt(0))]);
    if (icc) tags.push([34675, 7, icc.length, icc]);
    tags.sort((a, b) => a[0] - b[0]);
    let extra = 8 + 2 + tags.length * 12 + 4;
    for (const t of tags) if (t[3] instanceof Uint8Array) { t.push(extra); extra += t[3].length + (t[3].length & 1); }
    const dataOff = extra;
    const buf = new ArrayBuffer(dataOff + pix), v = new DataView(buf), u8 = new Uint8Array(buf);
    v.setUint16(0, 0x4949); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
    v.setUint16(8, tags.length, true);
    tags.forEach((t, i) => {
      const p = 10 + i * 12;
      v.setUint16(p, t[0], true); v.setUint16(p + 2, t[1], true); v.setUint32(p + 4, t[2], true);
      if (t[3] instanceof Uint8Array) { v.setUint32(p + 8, t[4], true); u8.set(t[3], t[4]); }
      else if (t[0] === 273) v.setUint32(p + 8, dataOff, true);
      else if (t[1] === 3) v.setUint16(p + 8, t[3], true); else v.setUint32(p + 8, t[3], true);
    });
    if (deep) new Uint8Array(buf, dataOff, pix).set(new Uint8Array(img.data16.buffer, img.data16.byteOffset, pix));   // little-endian, like the header
    else { const d = img.data; let o = dataOff; for (let i = 0; i < d.length; i += 4) { u8[o++] = d[i]; u8[o++] = d[i + 1]; u8[o++] = d[i + 2]; } }
    return u8;
  }

  function encodeTiff(img) {
    const { width: w, height: hgt, data } = img;
    const nTags = 13;
    const ifdSize = 2 + nTags * 12 + 4;
    const extraOff = 8 + ifdSize;
    const bpsOff = extraOff, xresOff = bpsOff + 6, yresOff = xresOff + 8, softOff = yresOff + 8;
    const soft = 'photos.jpeg\0';
    const dataOff = softOff + soft.length + (soft.length % 2);
    const pix = w * hgt * 3;
    const buf = new ArrayBuffer(dataOff + pix);
    const v = new DataView(buf);
    const u8 = new Uint8Array(buf);
    v.setUint16(0, 0x4949); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
    let p = 8;
    v.setUint16(p, nTags, true); p += 2;
    const tag = (t, type, count, val) => { v.setUint16(p, t, true); v.setUint16(p + 2, type, true); v.setUint32(p + 4, count, true); if (type === 3 && count === 1) v.setUint16(p + 8, val, true); else v.setUint32(p + 8, val, true); p += 12; };
    tag(256, 4, 1, w); tag(257, 4, 1, hgt); tag(258, 3, 3, bpsOff); tag(259, 3, 1, 1); tag(262, 3, 1, 2);
    tag(273, 4, 1, dataOff); tag(277, 3, 1, 3); tag(278, 4, 1, hgt); tag(279, 4, 1, pix);
    tag(282, 5, 1, xresOff); tag(283, 5, 1, yresOff); tag(296, 3, 1, 2); tag(305, 2, soft.length, softOff);
    v.setUint32(p, 0, true);
    v.setUint16(bpsOff, 8, true); v.setUint16(bpsOff + 2, 8, true); v.setUint16(bpsOff + 4, 8, true);
    v.setUint32(xresOff, 300, true); v.setUint32(xresOff + 4, 1, true);
    v.setUint32(yresOff, 300, true); v.setUint32(yresOff + 4, 1, true);
    for (let i = 0; i < soft.length; i++) u8[softOff + i] = soft.charCodeAt(i);
    let o = dataOff;
    for (let i = 0; i < data.length; i += 4) { u8[o++] = data[i]; u8[o++] = data[i + 1]; u8[o++] = data[i + 2]; }
    return u8;
  }

  /** Set EXIF orientation to 1 inside an APP1 segment (since pixels are already upright). */
  function patchOrientation(app1) {
    const a = new Uint8Array(app1);
    const base = 10;
    if (a.length < base + 8) return a;
    const v = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const le = v.getUint16(base) === 0x4949;
    const ifd = v.getUint32(base + 4, le);
    const n = v.getUint16(base + ifd, le);
    for (let i = 0; i < n; i++) {
      const e = base + ifd + 2 + i * 12;
      if (e + 12 > a.length) break;
      if (v.getUint16(e, le) === 0x0112) { v.setUint16(e + 8, 1, le); break; }
    }
    return a;
  }
  /**
   * EXIF APP1 segment built from the catalog's metadata — for sources that have no JPEG header of
   * their own to copy (RAW files, TIFF, PNG): camera, lens, exposure, capture time, author, GPS.
   * Returns null when there is nothing worth writing.
   */
  function buildExifApp1(photo) {
    const e = photo.exif || {};
    const ascii = (s) => { const t = String(s).replace(/[^\x20-\x7e]/g, '?'); const a = new Uint8Array(t.length + 1); for (let i = 0; i < t.length; i++) a[i] = t.charCodeAt(i); return a; };
    const u16 = (...v) => { const a = new Uint8Array(v.length * 2), d = new DataView(a.buffer); v.forEach((x, i) => d.setUint16(i * 2, x, true)); return a; };
    const u32 = (...v) => { const a = new Uint8Array(v.length * 4), d = new DataView(a.buffer); v.forEach((x, i) => d.setUint32(i * 4, x >>> 0, true)); return a; };
    const rat = (...v) => {   // unsigned rationals
      const a = new Uint8Array(v.length * 8), d = new DataView(a.buffer);
      v.forEach((x, i) => { let den = 1; while (den < 1e6 && Math.abs(x * den - Math.round(x * den)) > 1e-7) den *= 10; d.setUint32(i * 8, Math.round(x * den), true); d.setUint32(i * 8 + 4, den, true); });
      return a;
    };
    const srat = (x) => { const a = new Uint8Array(8), d = new DataView(a.buffer); d.setInt32(0, Math.round(x * 100), true); d.setInt32(4, 100, true); return a; };
    // [tag, type, count, bytes]  — types: 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL, 7 UNDEFINED, 10 SRATIONAL
    const T = (tag, type, bytes, count) => [tag, type, count != null ? count : (type === 2 || type === 1 || type === 7 ? bytes.length : bytes.length / (type === 3 ? 2 : type === 4 ? 4 : 8)), bytes];
    const when = e.captureTime || photo.captureTime;
    const dt = when && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(when) ? when.slice(0, 19).replace(/-/g, ':').replace('T', ' ') : null;

    const ifd0 = [], exif = [], gps = [];
    if (e.make) ifd0.push(T(0x010f, 2, ascii(e.make)));
    if (e.model) ifd0.push(T(0x0110, 2, ascii(e.model)));
    ifd0.push(T(0x0112, 3, u16(1)));                       // pixels are already upright
    ifd0.push(T(0x0131, 2, ascii('photos.jpeg')));
    if (dt) ifd0.push(T(0x0132, 2, ascii(dt)));
    if (e.artist) ifd0.push(T(0x013b, 2, ascii(e.artist)));
    if (e.copyright) ifd0.push(T(0x8298, 2, ascii(e.copyright)));
    if (e.exposureTime > 0) {
      // 1/60 stays 1/60 rather than 0.016667
      const a = new Uint8Array(8), d = new DataView(a.buffer);
      if (e.exposureTime < 1) { d.setUint32(0, 1, true); d.setUint32(4, Math.round(1 / e.exposureTime), true); } else { d.setUint32(0, Math.round(e.exposureTime * 10), true); d.setUint32(4, 10, true); }
      exif.push(T(0x829a, 5, a));
    }
    if (e.fNumber > 0) exif.push(T(0x829d, 5, rat(e.fNumber)));
    if (e.iso > 0) exif.push(T(0x8827, 3, u16(Math.min(65535, Math.round(e.iso)))));
    exif.push(T(0x9000, 7, Uint8Array.from([0x30, 0x32, 0x33, 0x32])));
    if (dt) exif.push(T(0x9003, 2, ascii(dt)));
    if (typeof e.exposureBias === 'number') exif.push(T(0x9204, 10, srat(e.exposureBias)));
    if (e.focalLength > 0) exif.push(T(0x920a, 5, rat(e.focalLength)));
    if (e.focalLength35 > 0) exif.push(T(0xa405, 3, u16(Math.round(e.focalLength35))));
    if (e.lens) exif.push(T(0xa434, 2, ascii(e.lens)));
    if (e.gps && isFinite(e.gps.lat) && isFinite(e.gps.lon)) {
      const dms = (v) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 1000) / 1000; return rat(d, m, s); };
      gps.push(T(0, 1, Uint8Array.from([2, 3, 0, 0])));
      gps.push(T(1, 2, ascii(e.gps.lat < 0 ? 'S' : 'N')));
      gps.push(T(2, 5, dms(e.gps.lat)));
      gps.push(T(3, 2, ascii(e.gps.lon < 0 ? 'W' : 'E')));
      gps.push(T(4, 5, dms(e.gps.lon)));
    }
    if (ifd0.length <= 2 && exif.length <= 1 && !gps.length) return null;   // only orientation + software + version: nothing to tell
    ifd0.push(T(0x8769, 4, u32(0)));                       // Exif IFD pointer, filled in below
    if (gps.length) ifd0.push(T(0x8825, 4, u32(0)));
    ifd0.sort((a, b) => a[0] - b[0]);

    // layout: TIFF header (8) | IFD0 | Exif IFD | GPS IFD | value area
    const size = (ifd) => 2 + ifd.length * 12 + 4;
    const offIfd0 = 8, offExif = offIfd0 + size(ifd0), offGps = offExif + size(exif);
    let dataOff = offGps + (gps.length ? size(gps) : 0);
    const chunks = [];
    const place = (bytes) => { const o = dataOff; chunks.push([o, bytes]); dataOff += bytes.length + (bytes.length & 1); return o; };
    const write = (ifd, at, d) => {
      d.setUint16(at, ifd.length, true);
      ifd.forEach(([tag, type, count, bytes], i) => {
        const p = at + 2 + i * 12;
        d.setUint16(p, tag, true); d.setUint16(p + 2, type, true); d.setUint32(p + 4, count, true);
        if (bytes.length <= 4) new Uint8Array(d.buffer, d.byteOffset + p + 8, bytes.length).set(bytes);
        else d.setUint32(p + 8, place(bytes), true);
      });
      d.setUint32(at + 2 + ifd.length * 12, 0, true);
    };
    ifd0.find(t => t[0] === 0x8769)[3] = u32(offExif);
    if (gps.length) ifd0.find(t => t[0] === 0x8825)[3] = u32(offGps);
    // two passes: the first only measures the value area
    const measure = new DataView(new ArrayBuffer(dataOff + 4096));
    const start = dataOff;
    write(ifd0, offIfd0, measure); write(exif, offExif, measure); if (gps.length) write(gps, offGps, measure);
    const total = dataOff;
    dataOff = start; chunks.length = 0;
    const tiff = new Uint8Array(total), d = new DataView(tiff.buffer);
    tiff.set([0x49, 0x49, 0x2a, 0x00]); d.setUint32(4, offIfd0, true);
    write(ifd0, offIfd0, d); write(exif, offExif, d); if (gps.length) write(gps, offGps, d);
    for (const [o, bytes] of chunks) tiff.set(bytes, o);
    const len = 2 + 6 + tiff.length;
    if (len > 0xffff) return null;
    const app1 = new Uint8Array(2 + len);
    app1.set([0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    app1.set(tiff, 10);
    return app1;
  }
  function insertApp1(jpeg, app1) {
    // after SOI and an optional JFIF APP0
    let p = 2;
    if (jpeg[2] === 0xFF && jpeg[3] === 0xE0) p = 4 + ((jpeg[4] << 8) | jpeg[5]);
    const out = new Uint8Array(jpeg.length + app1.length);
    out.set(jpeg.subarray(0, p), 0);
    out.set(app1, p);
    out.set(jpeg.subarray(p), p + app1.length);
    return out;
  }

  /* ---------------- image ops ---------------- */
  function targetSize(w, hgt, o) {
    let s = 1;
    switch (o.resize) {
      case 'long': s = o.long / Math.max(w, hgt); break;
      case 'short': s = o.short / Math.min(w, hgt); break;
      case 'wh': s = Math.min(o.width / w, o.height / hgt); break;
      case 'mp': s = Math.sqrt((o.mp * 1e6) / (w * hgt)); break;
      case 'percent': s = o.percent / 100; break;
      default: s = 1;
    }
    if (o.dontEnlarge) s = Math.min(1, s);
    return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(hgt * s))];
  }
  function resizeCanvas(src, tw, th) {
    if (src.width === tw && src.height === th) return src;
    let cur = src, cw = src.width, ch = src.height;
    while (cw / 2 >= tw && ch / 2 >= th) {
      const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
      const c = Dec.makeCanvas(nw, nh);
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, nw, nh);
      cur = c; cw = nw; ch = nh;
    }
    const out = Dec.makeCanvas(tw, th);
    const ctx = out.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(cur, 0, 0, tw, th);
    return out;
  }
  function outputSharpen(canvas, level) {
    const amt = { low: 0.35, std: 0.6, high: 0.95 }[level];
    if (!amt) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data, n = canvas.width * canvas.height;
    const Y = new Float32Array(n);
    for (let i = 0; i < n; i++) Y[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]);
    const Yb = P.blurPlane(Y, canvas.width, canvas.height, 0.7);
    for (let i = 0; i < n; i++) {
      let diff = (Y[i] - Yb[i]) * amt;
      diff = Math.max(-24, Math.min(24, diff));
      d[i * 4] += diff; d[i * 4 + 1] += diff; d[i * 4 + 2] += diff;
    }
    ctx.putImageData(img, 0, 0);
  }
  function watermark(canvas, o) {
    if (!o.wm || !o.wmText) return;
    const ctx = canvas.getContext('2d');
    const size = Math.max(8, Math.round(Math.min(canvas.width, canvas.height) * o.wmSize / 100));
    const pad = Math.round(size * 0.8);
    ctx.save();
    ctx.globalAlpha = o.wmOpacity / 100;
    ctx.font = `600 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = o.wmColor;
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = size * 0.15;
    const [vy, hx] = o.wmPos.length === 2 ? o.wmPos.split('') : ['c', 'c'];
    ctx.textAlign = hx === 'l' ? 'left' : hx === 'r' ? 'right' : 'center';
    ctx.textBaseline = vy === 't' ? 'top' : vy === 'b' ? 'bottom' : 'middle';
    const x = hx === 'l' ? pad : hx === 'r' ? canvas.width - pad : canvas.width / 2;
    const y = vy === 't' ? pad : vy === 'b' ? canvas.height - pad : canvas.height / 2;
    ctx.fillText(o.wmText, x, y);
    ctx.restore();
  }

  function fileName(p, o, seq) {
    const base = p.name.replace(/\.[^.]+$/, '') + (p.copyName ? '-' + p.copyName.replace(/\s+/g, '') : '');
    const date = (p.captureTime || p.importedAt || '').slice(0, 10);
    const seqStr = String(seq).padStart(3, '0');
    let n = (o.template || '{name}')
      .replace(/\{name\}/g, base).replace(/\{seq\}/g, seqStr).replace(/\{date\}/g, date)
      .replace(/\{title\}/g, p.title || base).replace(/\{rating\}/g, String(p.rating || 0)).replace(/\{custom\}/g, o.custom || '');
    n = n.replace(/[\\/:*?"<>|]+/g, '_').trim() || base;
    const ext = p.kind === 'video' && o.videoMode === 'video' ? 'mp4' : { jpeg: 'jpg', png: 'png', webp: 'webp', tiff: 'tif', avif: 'avif', jxl: 'jxl' }[o.format];
    return `${n}.${ext}`;
  }

  /** The colour profile an export carries: the chosen space's, or none for formats / choices that don't embed one. */
  function exportProfile(o) {
    const space = PJ.ICC && o.colorSpace && o.colorSpace !== 'srgb' ? o.colorSpace : 'srgb';
    if (!PJ.ICC || !['jpeg', 'png', 'tiff'].includes(o.format)) return { space: 'srgb', icc: null };
    // a converted file is wrong without its profile; an sRGB file is tagged unless all metadata is stripped
    return { space, icc: space !== 'srgb' || o.metadata !== 'none' ? PJ.ICC.profile(space) : null };
  }

  /* JPEG XL: libjxl as WebAssembly, in its own thread (vendor/jxl, js/jxlworker.js) */
  let jxlWorker = null, jxlSeq = 0;
  const jxlWaiting = new Map();
  function encodeJxl(img, quality) {
    if (!jxlWorker) {
      jxlWorker = new Worker(new URL('js/jxlworker.js', location.href).href, { type: 'module' });
      jxlWorker.onmessage = (ev) => { const w = jxlWaiting.get(ev.data.id); if (!w) return; jxlWaiting.delete(ev.data.id); if (ev.data.error) w.reject(new Error('JPEG XL encoding failed: ' + ev.data.error)); else w.resolve(ev.data.bytes); };
      jxlWorker.onerror = (ev) => { for (const w of jxlWaiting.values()) w.reject(new Error('The JPEG XL encoder could not be started' + (ev && ev.message ? ': ' + ev.message : ''))); jxlWaiting.clear(); try { jxlWorker.terminate(); } catch (_) { } jxlWorker = null; };
    }
    return new Promise((resolve, reject) => {
      const id = ++jxlSeq;
      jxlWaiting.set(id, { resolve, reject });
      jxlWorker.postMessage({ id, data: img.data, width: img.width, height: img.height, quality }, [img.data.buffer]);
    });
  }

  async function encode(canvas, o, photo, from) {
    const prof = exportProfile(o);
    if (prof.space !== (from || 'srgb')) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      PJ.ICC.convert(img.data, prof.space, 4, 255, from);
      ctx.putImageData(img, 0, 0);
    }
    if (o.format === 'tiff') {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      return encodeTiffRich(ctx.getImageData(0, 0, canvas.width, canvas.height), prof.icc);
    }
    if (o.format === 'jxl') {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      return encodeJxl(ctx.getImageData(0, 0, canvas.width, canvas.height), Math.max(1, Math.min(100, Math.round(o.quality))));
    }
    if (o.format === 'avif') {
      if (!API.encodeImage) throw new Error('AVIF export needs the Windows app with ffmpeg');
      const pngBlob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise(r => canvas.toBlob(r, 'image/png'));
      return API.encodeImage(new Uint8Array(await pngBlob.arrayBuffer()), 'avif', o.quality);
    }
    const type = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[o.format];
    const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type, quality: o.quality / 100 }) : await new Promise(r => canvas.toBlob(r, type, o.quality / 100));
    if (!blob || (blob.type && blob.type !== type)) throw new Error(`${o.format.toUpperCase()} encoding isn't supported on this platform — choose JPEG, PNG or TIFF`);
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (o.format === 'jpeg' && o.metadata === 'all') {
      const src = E.cachedSource(photo);
      if (src && src.jpegHeader) bytes = insertApp1(bytes, patchOrientation(src.jpegHeader));
      else { const app1 = buildExifApp1(photo); if (app1) bytes = insertApp1(bytes, app1); }
    }
    if (prof.icc && o.format === 'jpeg') bytes = PJ.ICC.jpeg(bytes, prof.icc);          // sits between the JFIF header and the EXIF block
    if (prof.icc && o.format === 'png') bytes = await PJ.ICC.png(bytes, prof.icc, PJ.ICC.names[prof.space]);
    return bytes;
  }

  async function exportPhotos(photos, o, onProgress) {
    const results = [];
    let folder = o.folder;
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const step = (f) => onProgress && onProgress((i + f) / photos.length, p);
      try {
        step(0.02);
        if (p.kind === 'video' && o.videoMode === 'video') {
          let dir = o.dest === 'same' && API.supportsSameFolder ? API.dirname(p.path) : folder;
          if (o.useSub && o.subfolder) dir = API.joinPath(dir, o.subfolder.replace(/[\\/:*?"<>|]+/g, '_'));
          const path = API.joinPath(dir, fileName(p, o, (o.seqStart || 1) + i));
          const r = await PJ.VExport.exportClip(p, o, path, (f, text) => { step(0.02 + f * 0.96); if (o.onDetail) o.onDetail(text); }, o.signal);
          results.push(r ? { photo: p, path: r.path, ok: true, warnings: r.warnings } : { photo: p, ok: false, skipped: true });
          step(1);
          continue;
        }
        // 16-bit TIFF comes straight from the render's own precision; resizing, output sharpening and
        // watermarks are done on an 8-bit canvas, so with any of those the file is 8-bit
        const want16 = o.format === 'tiff' && +o.tiffBits === 16;
        const plain = o.resize === 'none' && o.sharpen === 'none' && !(o.wm && o.wmText);
        const warnings = want16 && !plain ? ['16-bit TIFF applies to full-size exports without output sharpening or a watermark — these were written as 8-bit'] : [];
        const settings = (o.settingsOf && o.settingsOf.get(p.id)) || p.settings;
        // a file in a larger space than sRGB gets the wide-colour render itself (when the photo has one)
        const wideOut = exportProfile(o).space !== 'srgb' ? { outSpace: 'p3' } : {};
        const res = await E.renderFull(p, settings, (f) => step(f * 0.7), want16 && plain ? Object.assign({ out16: true }, wideOut) : wideOut);
        let bytes;
        if (want16 && plain && res.data16) {
          const prof = exportProfile(o);
          if (prof.space !== (res.space || 'srgb')) PJ.ICC.convert(res.data16, prof.space, 3, 65535, res.space);
          step(0.85);
          bytes = encodeTiffRich({ width: res.width, height: res.height, data16: res.data16 }, prof.icc);
        } else {
          // the canvas steps (resize, sharpening, watermark) work on the numbers as they are; encode() knows which space they are in
          let canvas = E.toCanvas(Object.assign({}, res, { space: 'srgb' }));
          const [tw, th] = targetSize(canvas.width, canvas.height, o);
          canvas = resizeCanvas(canvas, tw, th);
          if (o.sharpen !== 'none') outputSharpen(canvas, o.sharpen);
          watermark(canvas, o);
          step(0.85);
          bytes = await encode(canvas, o, p, res.space);
        }
        let dir = o.dest === 'same' && API.supportsSameFolder ? API.dirname(p.path) : folder;
        if (o.useSub && o.subfolder) dir = API.joinPath(dir, o.subfolder.replace(/[\\/:*?"<>|]+/g, '_'));
        const path = API.joinPath(dir, fileName(p, o, (o.seqStart || 1) + i));
        const written = await API.writeFile(path, bytes, o.conflict);
        results.push({ photo: p, path: written, ok: !!written, skipped: written === null, warnings });
        E.dropFull();
      } catch (e) {
        console.error('export failed', p.name, e);
        results.push({ photo: p, ok: false, error: String(e.message || e) });
      }
      step(1);
    }
    return results;
  }

  function prettyFolder(f) {
    if (!f) return '—';
    if (f.startsWith('mediastore:')) return f.slice(11);
    if (f.startsWith('content://')) return decodeURIComponent(f.split('/').pop()).replace(/^primary:/, 'Internal storage/');
    return f;
  }

  /* ---------------- dialog ---------------- */
  async function openDialog(photos, quick) {
    if (!photos.length) return UI.toast('Select photos to export', 'circle-info');
    const o = Object.assign({}, DEFAULTS, Cat.pref('export.last', {}));
    if (!o.folder) o.folder = await API.defaultExportDir();
    if (quick) return run(photos, o);

    const field = (label, el) => h('label', { class: 'field' }, h('span', null, label), el);
    const hasVideo = photos.some(p => p.kind === 'video');
    const vidNote = h('div', { class: 'muted full', style: { fontSize: '11px' } });
    const sel = (key, opts, onCh) => {
      const s = h('select', null, opts.map(([v, l]) => h('option', { value: v }, l)));
      s.value = String(o[key]);
      s.addEventListener('change', () => { o[key] = s.value; onCh && onCh(); refresh(); });
      return s;
    };
    const num = (key, min, max, step) => {
      const n = h('input', { type: 'number', min, max, step: step || 1, value: o[key] });
      n.addEventListener('input', () => { o[key] = parseFloat(n.value) || 0; refresh(); });
      n.addEventListener('keydown', e => e.stopPropagation());
      return n;
    };
    const txt = (key, ph) => {
      const t = h('input', { type: 'text', value: o[key], placeholder: ph || '' });
      t.addEventListener('input', () => { o[key] = t.value; refresh(); });
      t.addEventListener('keydown', e => e.stopPropagation());
      return t;
    };
    const chk = (key, label) => UI.checkbox(label, o[key], (v) => { o[key] = v; refresh(); }).el;

    // destination
    const folderLabel = h('span', { class: 'mono', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, color: 'var(--text-2)' } });
    const chooseBtn = h('button', { class: 'btn sm' }, icon('folder-open'), 'Choose…');
    chooseBtn.addEventListener('click', async () => { const d = await API.chooseDirectory(o.folder); if (d) { o.folder = d; refresh(); } });
    const destSel = sel('dest', !API.isDesktop ? [['choose', 'Downloads']]
      : API.supportsSameFolder ? [['choose', 'Specific folder'], ['same', 'Same folder as original']]
        : [['choose', API.platform === 'android' ? 'Pictures/photos.jpeg or a chosen folder' : 'Specific folder']]);
    if (!API.supportsSameFolder && o.dest === 'same') o.dest = 'choose';
    // quality
    const qVal = h('span', { class: 'mono' });
    const q = h('input', { type: 'range', min: 10, max: 100, value: o.quality, style: { flex: 1, accentColor: '#4f8ff7' } });
    q.addEventListener('input', () => { o.quality = +q.value; refresh(); });
    const qualityRow = h('div', { class: 'row' }, q, qVal);
    // resize controls
    const rzBox = h('div', { class: 'row', style: { gap: '6px' } });
    const rzInputs = {
      long: h('div', { class: 'row' }, num('long', 16, 30000), h('span', { class: 'muted' }, 'px long edge')),
      short: h('div', { class: 'row' }, num('short', 16, 30000), h('span', { class: 'muted' }, 'px short edge')),
      wh: h('div', { class: 'row' }, num('width', 16, 30000), h('span', { class: 'muted' }, '×'), num('height', 16, 30000), h('span', { class: 'muted' }, 'px (fit)')),
      mp: h('div', { class: 'row' }, num('mp', 0.1, 400, 0.1), h('span', { class: 'muted' }, 'megapixels')),
      percent: h('div', { class: 'row' }, num('percent', 1, 400), h('span', { class: 'muted' }, '%'))
    };
    Object.values(rzInputs).forEach(el => { el.querySelectorAll('input').forEach(i => { i.style.width = '86px'; }); });
    const preview = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } });
    const posSel = sel('wmPos', [['tl', 'Top left'], ['tc', 'Top center'], ['tr', 'Top right'], ['cc', 'Center'], ['bl', 'Bottom left'], ['bc', 'Bottom center'], ['br', 'Bottom right']]);
    const wmColor = h('input', { type: 'color', value: o.wmColor, style: { width: '44px', height: '26px', padding: 0, border: 0, background: 'none' } });
    wmColor.addEventListener('input', () => { o.wmColor = wmColor.value; });
    const wmBox = h('div', { class: 'form-grid' },
      field('Text', txt('wmText', '© Your Name')), h('div', { class: 'row', style: { alignItems: 'end' } }, field('Position', posSel), field('Color', wmColor)),
      field('Size (% of short edge)', num('wmSize', 0.5, 20, 0.5)), field('Opacity %', num('wmOpacity', 5, 100)));

    // export presets
    const presetSel = h('select', { style: { maxWidth: '180px' } });
    function fillPresets() {
      presetSel.replaceChildren(h('option', { value: '' }, 'Export presets…'), ...Cat.state.exportPresets.map((p, i) => h('option', { value: i }, p.name)),
        h('option', { value: '__save' }, '＋ Save current as preset…'));
    }
    fillPresets();
    presetSel.addEventListener('change', async () => {
      const v = presetSel.value;
      presetSel.value = '';
      if (v === '__save') {
        const n = await UI.prompt('Save Export Preset', '');
        if (n) { Cat.state.exportPresets.push({ name: n, settings: { ...o } }); Cat.scheduleSave(); fillPresets(); publishPresets(); UI.toast(`Export preset “${n}” saved`); }
        return;
      }
      if (v !== '') { Object.assign(o, Cat.state.exportPresets[+v].settings); m.close(); openDialog(photos); }
    });

    const body = h('div', null,
      h('div', { class: 'section-title' }, 'Export location'),
      h('div', { class: 'form-grid' },
        field('Export to', destSel),
        h('div', { class: 'field' }, h('span', null, 'Folder'), h('div', { class: 'row' }, folderLabel, API.isDesktop ? chooseBtn : null)),
        h('div', { class: 'row full' }, chk('useSub', 'Put in subfolder:'), txt('subfolder', 'Edited'))),
      h('div', { class: 'section-title' }, 'File naming'),
      h('div', { class: 'form-grid' },
        field('Template', txt('template', '{name}')),
        field('Custom text ({custom})', txt('custom', '')),
        h('div', { class: 'muted full', style: { fontSize: '11px' } }, 'Tokens: {name} {seq} {date} {title} {rating} {custom} — e.g. {date}_{custom}_{seq}'),
        field('Start number ({seq})', num('seqStart', 0, 999999)),
        field('Existing files', sel('conflict', [['unique', 'Choose a new name'], ['overwrite', 'Overwrite'], ['skip', 'Skip']]))),
      h('div', { class: 'section-title' }, 'File settings'),
      h('div', { class: 'form-grid' },
        field('Format', sel('format', [['jpeg', 'JPEG'], ['png', 'PNG (lossless)'], ['webp', 'WebP'], ['tiff', 'TIFF (uncompressed)'], ['jxl', 'JPEG XL (smaller than JPEG; quality 100 is lossless)'], ...(API.encodeImage ? [['avif', 'AVIF (small files; slow to write)']] : [])])),
        field('TIFF bit depth', sel('tiffBits', [['8', '8 bits per channel'], ['16', '16 bits per channel (full size only)']])),
        field('Colour space', sel('colorSpace', [['srgb', 'sRGB'], ['p3', 'Display P3'], ['adobe', 'Adobe RGB (1998)']])),
        h('div', { class: 'field' }, h('span', null, 'Quality'), qualityRow),
        field('Metadata', sel('metadata', [['all', 'Include camera metadata (EXIF) in JPEG'], ['none', 'Strip all metadata']]))),
      hasVideo ? h('div', { class: 'section-title' }, 'Video') : null,
      hasVideo ? h('div', { class: 'form-grid' },
        field('Export videos as', sel('videoMode', [['video', 'Graded video (MP4)'], ['still', 'Still of the current frame (uses File settings)']])),
        field('Codec', sel('vcodec', [['avc', 'H.264 (most compatible)'], ['hevc', 'HEVC / H.265 (smaller files)']])),
        field('Resolution', sel('vsize', [['original', 'Same as source'], ['2160', '2160p (4K)'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']])),
        field('Quality', sel('vquality', [['high', 'High'], ['medium', 'Medium'], ['low', 'Small file']])),
        h('div', { class: 'full row', style: { gap: '18px' } }, chk('vaudio', 'Include audio'), chk('vtrim', 'Only the in → out range')),
        vidNote) : null,
      h('div', { class: 'section-title' }, 'Image sizing'),
      h('div', { class: 'form-grid' },
        field('Resize to fit', sel('resize', [['none', 'Original size'], ['long', 'Long edge'], ['short', 'Short edge'], ['wh', 'Width & height'], ['mp', 'Megapixels'], ['percent', 'Percentage']])),
        h('div', { class: 'field' }, h('span', null, 'Size'), rzBox),
        h('div', { class: 'full' }, chk('dontEnlarge', "Don't enlarge"), preview)),
      h('div', { class: 'section-title' }, 'Output sharpening'),
      h('div', { class: 'form-grid' }, field('Sharpen for screen', sel('sharpen', [['none', 'None'], ['low', 'Low'], ['std', 'Standard'], ['high', 'High']]))),
      h('div', { class: 'section-title' }, 'Watermark'),
      chk('wm', 'Add a text watermark'), wmBox,
      h('div', { class: 'section-title' }, 'After export'),
      API.isDesktop ? chk('reveal', API.share ? 'Open share sheet / viewer' : 'Show in file manager') : h('div', { class: 'muted' }, 'Files are saved to your browser downloads.'));

    function refresh() {
      folderLabel.textContent = o.dest === 'same' ? '(each photo’s own folder)' : prettyFolder(o.folder);
      folderLabel.title = folderLabel.textContent;
      chooseBtn.disabled = o.dest === 'same';
      qVal.textContent = `${o.quality}`;
      qualityRow.style.opacity = ['jpeg', 'webp', 'jxl', 'avif'].includes(o.format) ? 1 : 0.35;
      rzBox.replaceChildren(rzInputs[o.resize] || h('span', { class: 'muted' }, 'Full resolution'));
      wmBox.style.display = o.wm ? '' : 'none';
      const p = photos[0];
      const [fw, fh] = (() => {
        const W = p.width || 4000, H = p.height || 3000;
        const g = P.buildGeometry(p.settings, W, H);
        return [g.outW, g.outH];
      })();
      const [tw, th] = targetSize(fw, fh, o);
      preview.textContent = `${photos.length} item${photos.length > 1 ? 's' : ''} · first: ${tw} × ${th} px · e.g. “${fileName(p, o, o.seqStart || 1)}”`;
      if (hasVideo) {
        const vids = photos.filter(x => x.kind === 'video');
        const secs = vids.reduce((a, x) => { const v = x.video || {}; const d = v.duration || 0; return a + (o.vtrim ? Math.max(0, (v.out ?? d) - (v.in || 0)) : d); }, 0);
        vidNote.textContent = o.videoMode === 'video'
          ? `${vids.length} clip${vids.length > 1 ? 's' : ''}, ${PJ.Video.shortDuration(secs)} total · graded on the GPU and encoded with the system encoder${PJ.VExport.hasWebCodecs() ? '' : ' — not available in this browser engine'}`
          : 'Each clip exports one still of its current frame.';
      }
    }
    refresh();
    const m = UI.modal({
      title: `Export ${photos.length} ${photos.every(x => x.kind === 'video') ? 'Clip' : photos.some(x => x.kind === 'video') ? 'Item' : 'Photo'}${photos.length > 1 ? 's' : ''}`, icon: 'file-export', wide: true, body,
      footerLeft: presetSel,
      buttons: [{ label: 'Cancel' }, { label: 'Export', primary: true, icon: 'file-export', onClick: () => { run(photos, o); } }]
    });
  }

  /** Presets that are always there; they export to the folder used last. */
  const BUILTIN_PRESETS = [
    { name: 'JPEG — full size', settings: { format: 'jpeg', quality: 92, resize: 'none', sharpen: 'none', wm: false, template: '{name}' } },
    { name: 'JPEG — web, 2048 px', settings: { format: 'jpeg', quality: 85, resize: 'long', long: 2048, dontEnlarge: true, sharpen: 'std', wm: false, template: '{name}' } },
    { name: 'JPEG — 4K, 3840 px', settings: { format: 'jpeg', quality: 90, resize: 'long', long: 3840, dontEnlarge: true, sharpen: 'low', wm: false, template: '{name}' } },
    { name: 'TIFF — full size', settings: { format: 'tiff', resize: 'none', sharpen: 'none', wm: false, template: '{name}' } },
    { name: 'PNG — full size', settings: { format: 'png', resize: 'none', sharpen: 'none', wm: false, template: '{name}' } }
  ];
  /** [{ id, name }] for menus: built-in presets, then the user's saved ones. */
  function presetList() {
    return BUILTIN_PRESETS.map((p, i) => ({ id: 'b' + i, name: p.name }))
      .concat(Cat.state.exportPresets.map((p, i) => ({ id: 'u' + i, name: p.name })));
  }
  /** Tell the native menu (File → Export with Preset) which presets exist. */
  function publishPresets() { if (API.setExportPresets) API.setExportPresets(presetList()); }
  /** Export with a preset, no dialog. Built-in presets keep the destination used last. */
  async function runPreset(id, photos) {
    if (!photos.length) return UI.toast('Select photos to export', 'circle-info');
    const p = id[0] === 'b' ? BUILTIN_PRESETS[+id.slice(1)] : Cat.state.exportPresets[+id.slice(1)];
    if (!p) return UI.toast('That export preset no longer exists', 'triangle-exclamation');
    const last = Cat.pref('export.last', {});
    const o = Object.assign({}, DEFAULTS, { dest: last.dest || DEFAULTS.dest, folder: last.folder || '', useSub: !!last.useSub, subfolder: last.subfolder || '', conflict: last.conflict || 'unique', reveal: last.reveal !== false }, p.settings);
    if (!o.folder) o.folder = await API.defaultExportDir();
    return run(photos, o, false);
  }

  async function run(photos, o, remember) {
    if (remember !== false) Cat.setPref('export.last', o);
    delete o.signal; delete o.onDetail;
    if (o.dest === 'choose' && API.isDesktop && !o.folder) {
      const d = await API.chooseDirectory();
      if (!d) return;
      o.folder = d;
    }
    // Exports run in the background, one job after another: the photos can be worked on meanwhile.
    // Each photo is exported with its settings as they are now, whatever is changed while it waits.
    const job = {
      photos: photos.slice(), o, signal: { cancelled: false }, done: 0, label: '', detail: '', frac: 0,
      settingsOf: new Map(photos.map(p => [p.id, P.clone(p.settings)]))
    };
    job.finished = new Promise((resolve) => { job.resolve = resolve; });
    queue.push(job);
    showQueue();
    if (queue.length > 1) UI.toast(`Export queued behind ${queue.length - 1} other${queue.length > 2 ? 's' : ''}`, 'file-export');
    pump();
    return job.finished;
  }

  const queue = [];
  let pumping = false, queueEl = null;
  /** The small panel at the bottom right that shows what is exporting. */
  function showQueue() {
    if (!queue.length) { if (queueEl) { queueEl.remove(); queueEl = null; } UI.activity(''); return; }
    const job = queue[0], total = queue.reduce((n, j) => n + j.photos.length, 0), doneAll = job.done;
    if (!queueEl) {
      queueEl = h('div', { class: 'export-queue' });
      document.body.appendChild(queueEl);
    }
    const bar = h('div', { class: 'progress' }, h('i', { style: { width: Math.round(job.frac * 100) + '%' } }));
    queueEl.replaceChildren(
      h('div', { class: 'row' }, h('b', null, 'Exporting'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', title: queue.length > 1 ? 'Stop this export and the ones waiting' : 'Stop this export', onclick: () => { for (const j of queue) j.signal.cancelled = true; showQueue(); } }, 'Cancel')),
      h('div', { class: 'muted' }, job.signal.cancelled ? 'Stopping…' : job.label || 'Preparing…'), bar,
      job.detail ? h('div', { class: 'muted small' }, job.detail) : null,
      queue.length > 1 ? h('div', { class: 'muted small' }, `${queue.length - 1} more export${queue.length > 2 ? 's' : ''} waiting (${total - job.photos.length} items)`) : null);
    UI.activity(`Exporting ${Math.min(job.photos.length, doneAll + 1)}/${job.photos.length}${queue.length > 1 ? ` (+${queue.length - 1} queued)` : ''}`, job.frac);
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const job = queue[0];
        try { await runJob(job); }
        catch (e) { console.error('export job failed', e); UI.toast('The export stopped: ' + (e && e.message || e), 'triangle-exclamation'); }
        queue.shift();
        showQueue();
        job.resolve();
      }
    } finally { pumping = false; }
  }
  /** True while exports are running or waiting (the app asks before closing). */
  const busy = () => queue.length > 0;

  async function runJob(job) {
    const o = job.o, list = job.photos, signal = job.signal;
    const all = [];
    let cancelled = false;
    for (let i = 0; i < list.length; i++) {
      if (signal.cancelled) { cancelled = true; break; }
      const r = await exportPhotos([list[i]], { ...o, seqStart: (o.seqStart || 1) + i, signal, settingsOf: job.settingsOf, onDetail: (t) => { job.detail = t || ''; showQueue(); } }, (f, p) => {
        job.frac = (i + f) / list.length; job.done = i;
        job.label = `${i + 1} / ${list.length} — ${Cat.displayName(p)}`;
        showQueue();
      });
      all.push(...r);
    }
    if (signal.cancelled) cancelled = true;
    const ok = all.filter(r => r.ok), failed = all.filter(r => !r.ok && !r.skipped), skipped = all.filter(r => r.skipped);
    if (failed.length) {
      UI.modal({
        title: 'Export finished with errors', icon: 'triangle-exclamation',
        body: h('div', null, h('p', null, `${ok.length} exported, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}.`),
          // one cause for every failure (a blocked or missing folder, a full disk): say it once
          failed.length > 1 && failed.every(f => f.error === failed[0].error)
            ? h('p', { style: { color: 'var(--text-2)' } }, failed[0].error)
            : h('ul', { style: { color: 'var(--text-2)', paddingLeft: '18px' } }, failed.map(f => h('li', null, `${Cat.displayName(f.photo)} — ${f.error}`))))
      });
    } else {
      UI.toast(`Exported ${ok.length} item${ok.length === 1 ? '' : 's'}${skipped.length ? ` (${skipped.length} skipped)` : ''}${cancelled ? ' — cancelled' : ''}`);
      const warns = [...new Set(ok.flatMap(r => r.warnings || []))];
      if (warns.length) setTimeout(() => UI.toast(warns.join(' · '), 'circle-info'), 400);
    }
    if (ok.length && o.reveal && API.isDesktop) {
      if (API.share && ok.length === 1) API.share(ok[0].path);
      else API.showInFolder(ok[ok.length - 1].path);
    }
  }

  global.PJ.Exporter = { openDialog, exportPhotos, run, busy, queueLength: () => queue.length, encodeTiff, encodeTiffRich, DEFAULTS, presetList, publishPresets, runPreset, buildExifApp1 };
})(window);
