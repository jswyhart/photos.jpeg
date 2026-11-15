/* =====================================================================
 * photos.jpeg — decoding: standard images, camera RAW embedded previews,
 * EXIF metadata and proxy generation.
 * ===================================================================== */
(function (global) {
  'use strict';

  const RAW_EXT = new Set(['nef', 'nrw', 'gpr', 'crw', 'cr2', 'cr3', 'arw', 'srf', 'sr2', 'dng', 'orf', 'rw2', 'raf',
    'pef', 'srw', 'raw', 'rwl', 'erf', '3fr', 'kdc', 'dcr', 'mrw', 'mef', 'mos', 'iiq', 'x3f']);
  const STD_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'avif', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'hif', 'jxl', 'jp2', 'j2k', 'jpf', 'jpx', 'ico', 'cur', 'dib', 'apng', 'psd', 'psb', 'exr', 'hdr', 'pic', 'pfm', 'pbm', 'pgm', 'ppm', 'pnm', 'pam', 'tga', 'icb', 'vda', 'qoi']);

  // Video: standard containers decoded by the platform, plus camera RAW video formats
  const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'mts', 'm2ts', 'mxf', 'avi', 'lrv', '360', 'insv', 'mpg', 'mpeg', 'm2v', 'vob', 'wmv', 'flv', '3gp', '3g2', 'mod', 'tod', 'dv', 'ogv']);
  const RAW_VIDEO_EXT = new Set(['braw', 'r3d', 'ari', 'arx', 'crm', 'nev', 'mxf']);
  const ext = (name) => { const p = (name || '').toLowerCase().split('.'); return p.length > 1 ? p.pop() : ''; };
  const isRaw = (name) => RAW_EXT.has(ext(name));
  const isVideo = (name) => VIDEO_EXT.has(ext(name)) || RAW_VIDEO_EXT.has(ext(name));
  const isRawVideo = (name) => RAW_VIDEO_EXT.has(ext(name)) && ext(name) !== 'mxf';
  const isSupported = (name) => RAW_EXT.has(ext(name)) || STD_EXT.has(ext(name)) || isVideo(name);

  /* ---------------------------------------------------------------- */
  /* EXIF / TIFF parsing                                               */
  /* ---------------------------------------------------------------- */
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  const TAGS = {
    0x010F: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x0131: 'software', 0x0132: 'modifyDate',
    0x013B: 'artist', 0x8298: 'copyright', 0x8769: '_exif', 0x8825: '_gps',
    0x829A: 'exposureTime', 0x829D: 'fNumber', 0x8827: 'iso', 0x8822: 'exposureProgram',
    0x9003: 'dateTimeOriginal', 0x9004: 'createDate', 0x9204: 'exposureBias', 0x9207: 'meteringMode',
    0x9209: 'flash', 0x920A: 'focalLength', 0xA405: 'focalLength35', 0xA434: 'lensModel', 0xA433: 'lensMake',
    0xA002: 'pixelWidth', 0xA003: 'pixelHeight', 0x0100: 'imageWidth', 0x0101: 'imageHeight',
    0xA431: 'serial', 0x9010: 'offsetTime'
  };
  const GPS_TAGS = { 1: 'latRef', 2: 'lat', 3: 'lonRef', 4: 'lon', 6: 'alt' };

  function readTiff(view, base, out, maxLen) {
    if (base + 8 > view.byteLength) return false;
    const bo = view.getUint16(base);
    let le;
    if (bo === 0x4949) le = true; else if (bo === 0x4D4D) le = false; else return false;
    const magic = view.getUint16(base + 2, le);
    if (magic !== 42 && magic !== 0x4F52 && magic !== 0x5352 && magic !== 0x55) return false; // TIFF, ORF variants, RW2
    const u16 = (o) => view.getUint16(o, le), u32 = (o) => view.getUint32(o, le), s32 = (o) => view.getInt32(o, le);
    const limit = Math.min(view.byteLength, base + (maxLen || view.byteLength));

    function readValue(type, count, valOff) {
      const size = (TYPE_SIZE[type] || 1) * count;
      const off = size <= 4 ? valOff : base + u32(valOff);
      if (off < 0 || off + size > limit) return undefined;
      switch (type) {
        case 2: {
          let s = '';
          for (let i = 0; i < count; i++) { const c = view.getUint8(off + i); if (!c) break; s += String.fromCharCode(c); }
          return s.trim();
        }
        case 3: return count === 1 ? u16(off) : Array.from({ length: Math.min(count, 16) }, (_, i) => u16(off + i * 2));
        case 4: return count === 1 ? u32(off) : Array.from({ length: Math.min(count, 16) }, (_, i) => u32(off + i * 4));
        case 9: return s32(off);
        case 5: case 10: {
          const rd = (o) => { const n = type === 5 ? u32(o) : s32(o), d = type === 5 ? u32(o + 4) : s32(o + 4); return d ? n / d : 0; };
          return count === 1 ? rd(off) : Array.from({ length: Math.min(count, 8) }, (_, i) => rd(off + i * 8));
        }
        case 1: case 7: return count === 1 ? view.getUint8(off) : null;
        default: return undefined;
      }
    }
    function readIfd(off, map, target, depth) {
      if (depth > 4 || off <= 0 || base + off + 2 > limit) return 0;
      const p = base + off, n = u16(p);
      if (n > 1000) return 0;
      for (let i = 0; i < n; i++) {
        const e = p + 2 + i * 12;
        if (e + 12 > limit) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const name = map[tag];
        if (!name) continue;
        const v = readValue(type, count, e + 8);
        if (v === undefined || v === null || v === '') continue;
        if (name === '_exif') readIfd(v, TAGS, target, depth + 1);
        else if (name === '_gps') { target.gps = target.gps || {}; readIfd(v, GPS_TAGS, target.gps, depth + 1); }
        else if (target[name] === undefined) target[name] = v;
      }
      if (p + 2 + n * 12 + 4 <= limit) return u32(p + 2 + n * 12);
      return 0;
    }
    const ifd0 = u32(base + 4);
    readIfd(ifd0, TAGS, out, 0);
    return true;
  }

  function findJpegExif(bytes) {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return -1;
    let p = 2;
    while (p + 4 < bytes.length) {
      if (bytes[p] !== 0xFF) return -1;
      const m = bytes[p + 1];
      if (m === 0xDA || m === 0xD9) return -1;
      const len = (bytes[p + 2] << 8) | bytes[p + 3];
      if (m === 0xE1 && bytes[p + 4] === 0x45 && bytes[p + 5] === 0x78 && bytes[p + 6] === 0x69 && bytes[p + 7] === 0x66) return p + 10;
      p += 2 + len;
    }
    return -1;
  }

  /** Parse EXIF from JPEG, TIFF-based RAW, or any container holding TIFF blocks (CR3, RAF). */
  function parseExif(bytes) {
    const out = {};
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const j = findJpegExif(bytes);
      if (j > 0) readTiff(view, j, out);
      else if (!readTiff(view, 0, out)) {
        // Scan the head of the file for embedded TIFF blocks (CR3 CMT boxes, RAF headers, etc.)
        const lim = Math.min(bytes.length - 8, 1 << 20);
        let found = 0;
        for (let i = 0; i < lim && found < 4; i++) {
          if ((bytes[i] === 0x49 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x2A && bytes[i + 3] === 0x00) ||
            (bytes[i] === 0x4D && bytes[i + 1] === 0x4D && bytes[i + 2] === 0x00 && bytes[i + 3] === 0x2A)) {
            if (readTiff(view, i, out, 1 << 20)) found++;
          }
          // RAF / others: embedded JPEG with its own EXIF
          if (!found && bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF && bytes[i + 3] === 0xE1) {
            const sub = bytes.subarray(i, Math.min(bytes.length, i + 131072));
            const k = findJpegExif(sub);
            if (k > 0 && readTiff(view, i + k, out)) found++;
          }
        }
      }
    } catch (_) { /* ignore malformed metadata */ }
    return tidyExif(out);
  }

  function tidyExif(e) {
    const o = {};
    if (e.make) o.make = e.make;
    if (e.model) o.model = e.model.startsWith(e.make || '###') ? e.model : e.model;
    if (e.lensModel) o.lens = e.lensModel;
    if (e.iso) o.iso = Array.isArray(e.iso) ? e.iso[0] : e.iso;
    if (e.exposureTime) o.exposureTime = e.exposureTime;
    if (e.fNumber) o.fNumber = Math.round(e.fNumber * 10) / 10;
    if (e.focalLength) o.focalLength = Math.round(e.focalLength * 10) / 10;
    if (e.focalLength35) o.focalLength35 = e.focalLength35;
    if (e.exposureBias !== undefined) o.exposureBias = Math.round(e.exposureBias * 100) / 100;
    if (e.flash !== undefined) o.flash = (e.flash & 1) ? 'Fired' : 'Did not fire';
    if (e.orientation) o.orientation = Array.isArray(e.orientation) ? e.orientation[0] : e.orientation;
    const dt = e.dateTimeOriginal || e.createDate || e.modifyDate;
    if (dt) {
      const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dt);
      if (m) o.captureTime = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    }
    if (e.artist) o.artist = e.artist;
    if (e.copyright) o.copyright = e.copyright;
    if (e.software) o.software = e.software;
    if (e.pixelWidth && e.pixelHeight) { o.sensorWidth = e.pixelWidth; o.sensorHeight = e.pixelHeight; }
    if (e.gps && e.gps.lat && e.gps.lon && Array.isArray(e.gps.lat)) {
      const dms = (a) => a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600;
      o.gps = { lat: dms(e.gps.lat) * (e.gps.latRef === 'S' ? -1 : 1), lon: dms(e.gps.lon) * (e.gps.lonRef === 'W' ? -1 : 1) };
    }
    return o;
  }

  function formatShutter(t) {
    if (!t) return '';
    if (t >= 1) return `${Math.round(t * 10) / 10}s`;
    return `1/${Math.round(1 / t)}s`;
  }

  /* ---------------------------------------------------------------- */
  /* Embedded JPEG extraction from RAW containers                      */
  /* ---------------------------------------------------------------- */
  function findEmbeddedJpegs(bytes) {
    const len = bytes.length, out = [];
    for (let i = 0; i < len - 16; i++) {
      if (bytes[i] !== 0xFF || bytes[i + 1] !== 0xD8 || bytes[i + 2] !== 0xFF) continue;
      const mk = bytes[i + 3];
      if (!((mk >= 0xE0 && mk <= 0xEF) || mk === 0xDB || mk === 0xC0 || mk === 0xC2 || mk === 0xC4 || mk === 0xFE)) continue;
      // Walk segment headers to the start of scan, reading SOF dimensions on the way.
      let p = i + 2, sos = false, w = 0, h = 0;
      while (p < len - 4) {
        if (bytes[p] !== 0xFF) break;
        while (p < len && bytes[p] === 0xFF) p++;
        const m = bytes[p]; p++;
        if (m === 0xDA) { sos = true; break; }
        if (m === 0xD9 || m === 0xD8) break;
        const segLen = (bytes[p] << 8) | bytes[p + 1];
        if (segLen < 2) break;
        if ((m === 0xC0 || m === 0xC1 || m === 0xC2) && p + 7 < len) {
          h = (bytes[p + 3] << 8) | bytes[p + 4];
          w = (bytes[p + 5] << 8) | bytes[p + 6];
        }
        // Lossless JPEG (SOF3) is the RAW data itself in some formats — skip it.
        if (m === 0xC3) { sos = false; break; }
        p += segLen;
      }
      if (!sos || !w || !h) continue;
      let end = -1;
      for (let j = p; j < len - 1; j++) {
        if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) { end = j + 2; break; }
      }
      if (end > i + 1024) { out.push({ start: i, end, w, h }); i = end - 1; }
    }
    return out.sort((a, b) => b.w * b.h - a.w * a.h);
  }

  async function bitmapFromBytes(bytes, type) {
    const blob = new Blob([bytes], { type: type || 'image/jpeg' });
    if (global.createImageBitmap) {
      try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (_) { /* fall through */ }
    }
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  /** Regular canvases on the UI thread: WebKit (the macOS app) can return blank pixels when
      OffscreenCanvases are chained, and toDataURL() only exists on DOM canvases. */
  function makeCanvas(w, h) {
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
    }
    return new OffscreenCanvas(w, h);
  }

  /** True if a sample grid of pixels is entirely transparent (a failed draw). */
  function looksBlank(img) {
    const d = img.data, n = img.width * img.height;
    const step = Math.max(1, Math.floor(n / 4096));
    for (let i = 0; i < n; i += step) if (d[i * 4 + 3] !== 0) return false;
    return true;
  }

  /** Draw an image into a canvas, applying an EXIF orientation (1..8). */
  function orientToCanvas(img, orientation) {
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    const swap = orientation >= 5 && orientation <= 8;
    const c = makeCanvas(swap ? h : w, swap ? w : h);
    const ctx = c.getContext('2d');
    switch (orientation) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, h, w); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
      default: break;
    }
    ctx.drawImage(img, 0, 0);
    return c;
  }

  function fallbackRawCanvas(name, size) {
    const c = makeCanvas(1600, 1067);
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 1600, 1067);
    grad.addColorStop(0, '#0f172a'); grad.addColorStop(0.35, '#1e3a8a'); grad.addColorStop(0.7, '#9a3412'); grad.addColorStop(1, '#fef08a');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 1600, 1067);
    const patches = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899', '#f8fafc', '#94a3b8', '#475569', '#090d16'];
    patches.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect(200 + i * 102, 720, 100, 100); });
    const rad = ctx.createRadialGradient(800, 400, 20, 800, 400, 320);
    rad.addColorStop(0, '#ffffff'); rad.addColorStop(0.4, 'rgba(56,189,248,0.75)'); rad.addColorStop(1, 'rgba(15,23,42,0)');
    ctx.fillStyle = rad; ctx.beginPath(); ctx.arc(800, 400, 320, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '600 28px ui-monospace, monospace';
    ctx.fillText(`${ext(name).toUpperCase()} — no embedded preview found`, 200, 660);
    ctx.font = '400 18px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(`${name} • ${Math.round(size / 1024)} KB • test pattern`, 200, 692);
    return c;
  }

  /**
   * Decode a file's bytes to a drawable (canvas/bitmap) at full resolution.
   * Returns { image, width, height, isRaw, format, exif, note }.
   */
  async function decode(bytes, name) {
    const e = ext(name);
    const raw = RAW_EXT.has(e);
    const exif = parseExif(bytes);
    if (raw) {
      const cands = findEmbeddedJpegs(bytes);
      for (const c of cands.slice(0, 4)) {
        try {
          const jbytes = bytes.subarray(c.start, c.end);
          const jexif = parseExif(jbytes);
          let img = await bitmapFromBytes(jbytes, 'image/jpeg');
          // Apply the RAW container's orientation if the preview carries none of its own
          if ((!jexif.orientation || jexif.orientation === 1) && exif.orientation && exif.orientation !== 1) {
            img = orientToCanvas(img, exif.orientation);
          }
          return { image: img, width: img.width, height: img.height, isRaw: true, format: `${e.toUpperCase()}`, exif: Object.assign({}, jexif, exif), note: 'Embedded preview' };
        } catch (_) { /* try next candidate */ }
      }
      // Some RAW-like files are decodable natively (e.g. TIFF-based DNG previews in some browsers)
      try {
        const img = await bitmapFromBytes(bytes, '');
        return { image: img, width: img.width, height: img.height, isRaw: true, format: e.toUpperCase(), exif };
      } catch (_) { /* fallback */ }
      const c = fallbackRawCanvas(name, bytes.length);
      return { image: c, width: c.width, height: c.height, isRaw: true, format: e.toUpperCase(), exif, note: 'No embedded preview' };
    }
    const mime = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg', jfi: 'image/jpeg', png: 'image/png', apng: 'image/apng',
      webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp', dib: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
      heic: 'image/heic', heif: 'image/heif', hif: 'image/heif', jxl: 'image/jxl', jp2: 'image/jp2', j2k: 'image/jp2', jpf: 'image/jpx', jpx: 'image/jpx',
      ico: 'image/x-icon', cur: 'image/x-icon', tga: 'image/x-tga', psd: 'image/vnd.adobe.photoshop'
    }[e] || '';
    const F = global.PJ && PJ.Formats;
    const jsKind = F ? F.kindFor(e) : null;
    // HEIC/JPEG XL/JPEG 2000: the system decoder first (Safari/WKWebView, Android); TIFF etc.: our decoder first
    const browserFirst = ['heif'].includes(jsKind) || !jsKind;
    const viaBrowser = async () => {
      const img = await bitmapFromBytes(bytes, mime);
      return { image: img, width: img.width, height: img.height, isRaw: false, format: e.toUpperCase() || 'IMG', exif };
    };
    const viaJs = async () => {
      const r = await F.decode(bytes, e);
      let image = r.canvas;
      if (!image) {
        image = makeCanvas(r.width, r.height);
        image.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
      }
      const ex = r.exifBytes ? Object.assign({}, exif, parseExif(r.exifBytes)) : exif;
      if (r.exifBytes && ex.orientation) ex.orientation = 1; // HEIF applies rotation through irot
      return { image, width: image.width, height: image.height, isRaw: false, format: e.toUpperCase(), exif: ex, note: r.note };
    };
    const attempts = browserFirst ? [viaBrowser, jsKind && viaJs] : [viaJs, viaBrowser];
    let lastErr = null;
    for (const a of attempts.filter(Boolean)) {
      try { return await a(); } catch (err) { lastErr = err; }
    }
    // Not decodable here: maybe a container with an embedded JPEG preview
    const cands = findEmbeddedJpegs(bytes);
    if (cands.length && !['psd', 'exr', 'rgbe'].includes(jsKind)) {
      try {
        const img = await bitmapFromBytes(bytes.subarray(cands[0].start, cands[0].end), 'image/jpeg');
        return { image: img, width: img.width, height: img.height, isRaw: false, format: e.toUpperCase(), exif, note: 'Embedded preview' };
      } catch (_) { /* fall through */ }
    }
    const why = lastErr && lastErr.message && !/^(The source image|InvalidStateError|EncodingError)/.test(lastErr.message) && lastErr.message !== '[object Event]' ? ` (${lastErr.message})` : '';
    throw new Error(`Cannot decode ${name}${why}`);
  }

  /** High-quality downscale of a drawable to ImageData with the longest edge <= maxEdge. */
  function toImageData(image, maxEdge) {
    let w = image.width, h = image.height;
    const scale = maxEdge ? Math.min(1, maxEdge / Math.max(w, h)) : 1;
    const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    let cur = image, cw = w, ch = h;
    // Step down by halves for quality
    while (cw / 2 >= tw * 1.0001 && ch / 2 >= th) {
      const nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
      const c = makeCanvas(nw, nh);
      const cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(cur, 0, 0, nw, nh);
      cur = c; cw = nw; ch = nh;
    }
    const out = makeCanvas(tw, th);
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, tw, th);
    let data = ctx.getImageData(0, 0, tw, th);
    if (cur !== image && looksBlank(data)) {
      // Multi-step downscale came back empty: draw straight from the source instead.
      ctx.clearRect(0, 0, tw, th);
      ctx.drawImage(image, 0, 0, tw, th);
      data = ctx.getImageData(0, 0, tw, th);
    }
    if (looksBlank(data)) console.warn('Decoded image is blank', w, h, tw, th);
    return data;
  }

  /* ---------------- Pure-JS resampling (no canvas scaling) ---------------- */
  /** Halve an RGBA image with a 2×2 box filter. */
  /** Downscale RGBA pixels so the long edge is <= maxEdge (implemented in pipeline.js so workers can run it). */
  function resizePixels(src, maxEdge) { return PJ.Pipeline.resizePixels(src, maxEdge); }

  global.PJ = global.PJ || {};
  global.PJ.Decode = { resizePixels, RAW_EXT, STD_EXT, VIDEO_EXT, RAW_VIDEO_EXT, ext, isRaw, isVideo, isRawVideo, isSupported, parseExif, decode, toImageData, makeCanvas, formatShutter };
})(typeof self !== 'undefined' ? self : this);
