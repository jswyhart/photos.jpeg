/* =====================================================================
 * photos.jpeg — render engine: source cache + parallel worker pool.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, Dec = PJ.Decode, API = PJ.API, Cat = PJ.Catalog;

  const PROXY_EDGE = 1600, DRAFT_EDGE = 800, THUMB_EDGE = 360;

  /* ---------------- Worker pool ---------------- */
  class Pool {
    constructor(n, urlPromise) {
      this.workers = [];
      this.queue = [];
      this.seq = 0;
      this.pending = new Map();
      this.ready = urlPromise.then((url) => {
        this.url = url;
        for (let i = 0; i < n; i++) this.workers.push(this._spawn(i));
        this._pump();
      });
    }
    _spawn(i) {
      const w = new Worker(this.url);
      const rec = { w, busy: false, keys: new Set(), maps: new Set(), idx: i, current: 0 };
      w.onmessage = (e) => this._onMsg(rec, e.data);
      // A worker that dies (out of memory on a huge file, a crash) must not leave renders waiting
      // forever: fail its job and start a fresh worker in its place.
      w.onerror = (e) => {
        console.error('render worker failed', e.message || e);
        if (e.preventDefault) e.preventDefault();
        const p = this.pending.get(rec.current);
        if (p) { this.pending.delete(rec.current); p.reject(new Error('Render worker stopped: ' + (e.message || 'crashed'))); }
        try { w.terminate(); } catch (_) { }
        const k = this.workers.indexOf(rec);
        if (k >= 0) this.workers[k] = this._spawn(i);
        this._pump();
      };
      return rec;
    }
    _onMsg(rec, msg) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'error') {
        if (msg.error === 'missing-source' && p.q && !p.q.retried) {
          rec.keys.delete(p.job.key);
          p.q.retried = true;
          this.queue.unshift(p.q);
        } else p.reject(new Error(msg.error));
      } else p.resolve(msg);
      if (msg.type !== 'ack') { rec.busy = false; this._pump(); }
    }
    /** Queue a render job. priority: 0 = interactive, 1 = normal, 2 = background */
    run(job, priority = 1) {
      return new Promise((resolve, reject) => {
        this.queue.push({ job, priority, resolve, reject, t: this.seq++ });
        this.queue.sort((a, b) => a.priority - b.priority || a.t - b.t);
        this._pump();
      });
    }
    /** Drop queued (not yet started) jobs matching a predicate. */
    cancel(pred) {
      this.queue = this.queue.filter(q => { if (pred(q.job)) { q.resolve(null); return false; } return true; });
    }
    _pump() {
      let k = 0;
      while (k < this.queue.length) {
        const q = this.queue[k];
        let rec;
        if (q.job.affinity != null) {
          // a task that needs state left in a particular worker (e.g. a decoded RAW mosaic)
          rec = this.workers[q.job.affinity];
          if (!rec || rec.busy) { k++; continue; }
        } else {
          // Prefer an idle worker that already holds the source
          rec = this.workers.find(w => !w.busy && w.keys.has(q.job.key));
          if (!rec) rec = this.workers.find(w => !w.busy);
          if (!rec) return;
        }
        this.queue.splice(k, 1);
        this._start(rec, q);
      }
    }
    /** Run a one-off task (e.g. building preview levels) on any idle worker. */
    task(msg, transfer, priority = 1, affinity = null) {
      return new Promise((resolve, reject) => {
        this.queue.push({ job: { task: msg, transfer: transfer || [], affinity }, priority, resolve, reject, t: this.seq++ });
        this.queue.sort((a, b) => a.priority - b.priority || a.t - b.t);
        this._pump();
      });
    }
    _start(rec, q) {
      rec.busy = true;
      const job = q.job;
      if (job.task) {
        const id = ++this.seq;
        rec.current = id;
        const resolve = (m) => { if (m && typeof m === 'object') m.worker = this.workers.indexOf(rec); q.resolve(m); };
        this.pending.set(id, { resolve, reject: q.reject, job, q });
        rec.w.postMessage(Object.assign({ type: 'task', id }, job.task), job.transfer);
        return;
      }
      // mask maps this render's settings name, which this worker hasn't been given yet
      for (const m of (job.settings && job.settings.masks) || []) {
        if (!m.map || rec.maps.has(m.map.id)) continue;
        const mm = P.getMaskMap(m.map.id);
        if (!mm) continue;
        const buf = mm.data.slice().buffer;
        rec.w.postMessage({ type: 'maskMap', id: m.map.id, w: mm.w, h: mm.h, buffer: buf }, [buf]);
        rec.maps.add(m.map.id);
      }
      const go = () => {
        const id = ++this.seq;
        rec.current = id;
        this.pending.set(id, { resolve: q.resolve, reject: q.reject, job, q });
        rec.w.postMessage({ type: 'render', id, key: job.key, settings: job.settings, fullLongEdge: job.fullLongEdge, seed: job.seed, opts: job.opts });
      };
      if (!rec.keys.has(job.key)) {
        const src = job.getSource();
        if (!src) { rec.busy = false; q.reject(new Error('source unavailable')); this._pump(); return; }
        // Shared memory: every worker reads the same pixels. Otherwise each worker gets its own copy.
        const shared = P.isShared(src.data);
        const buf = shared ? src.data.buffer : src.data.buffer.slice(src.data.byteOffset, src.data.byteOffset + src.data.byteLength);
        const id = ++this.seq;
        this.pending.set(id, { resolve: () => { }, reject: () => { }, job });
        rec.w.postMessage({ type: 'setSource', id, key: job.key, buffer: buf, width: src.width, height: src.height }, shared ? [] : [buf]);
        rec.keys.add(job.key);
        if (rec.keys.size > 6) rec.keys.delete(rec.keys.values().next().value);
      }
      go();
    }
    forget(keyPrefix) {
      for (const rec of this.workers) for (const k of [...rec.keys]) if (k.startsWith(keyPrefix)) { rec.keys.delete(k); rec.w.postMessage({ type: 'dropSource', key: k }); }
    }
  }

  /** Worker script URL. Some embedders (WKWebView custom schemes) can't start workers from
      their own scheme, so the scripts are bundled into a blob instead. */
  function workerUrl() {
    if (API.workerMode !== 'blob') return Promise.resolve('js/worker.js');
    return Promise.all(['js/pipeline.js', 'js/rawmatrices.js', 'js/rawdec.js', 'js/rawgpu.js', 'js/worker.js'].map(u => fetch(u + '?v=' + Date.now(), { cache: 'no-store' }).then(r => r.text())))
      .then(([pipe, mats, raw, gpu, work]) => URL.createObjectURL(new Blob([pipe, '\n', mats, '\n', raw, '\n', gpu, '\n', work.replace(/importScripts\([^)]*\);?/, '')], { type: 'text/javascript' })));
  }
  // Up to six render workers. More was measured (14 on a 16-thread CPU) and is no faster for
  // RAW loading or light edits, and slower for edits with neighbourhood filters: the bands
  // overlap more and the workers compete for memory bandwidth.
  const nWorkers = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  const pool = new Pool(nWorkers, workerUrl());

  /** Long-edge limit that keeps the working resolution under API.maxFullPixels (mobile memory). */
  function capEdge(w, h) {
    const cap = API.maxFullPixels || 0;
    if (!cap || w * h <= cap) return 0;
    return Math.floor(Math.max(w, h) * Math.sqrt(cap / (w * h)));
  }

  /* ---------------- Sources ---------------- */
  const sources = new Map(); // path -> {proxy, draft, full?, fullW, fullH, loading}
  const MAX_SOURCES = 8;
  const loading = new Map();

  function seedFor(photo) {
    let h = 0; const s = photo.virtualOf || photo.id;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return h;
  }

  /** want: 'best' (full RAW development) or 'any' (embedded preview is fine — thumbnails). */
  async function decodePhoto(photo, want) {
    if (photo.kind === 'video') {
      // The source of a video entry is its current frame (photo.videoTime)
      const fr = await PJ.Video.decodeFrame(photo);
      return { dec: { image: fr.image, width: fr.width, height: fr.height, exif: fr.exif, note: fr.note, isVideo: true }, bytes: new Uint8Array(0) };
    }
    const bytes = await API.readFile(photo.path);
    // Native shells can demosaic RAW files properly (Core Image on macOS, DNG on Android)
    if (API.rawUrl && Dec.isRaw(photo.name)) {
      try {
        const r = await fetch(API.rawUrl(photo.path));
        if (r.ok) {
          const rendered = new Uint8Array(await r.arrayBuffer());
          const dec = await Dec.decode(rendered, 'raw-render.jpg');
          dec.isRaw = true;
          dec.format = Dec.ext(photo.name).toUpperCase();
          dec.exif = Object.assign({}, Dec.parseExif(bytes), { orientation: 1 });
          dec.note = API.platform === 'macos' ? 'Core Image RAW' : 'Native RAW decode';
          return { dec, bytes };
        }
      } catch (e) { console.warn('native RAW decode failed, using embedded preview', e); }
    }
    // Full RAW development in JS (desktop, browser, Android for non-DNG); the embedded preview is the fallback
    if (Dec.isRaw(photo.name) && PJ.Raw && PJ.Raw.canDecode(photo.name) && Cat.pref('raw.engine', 'full') !== 'preview' && want !== 'any') {
      let preview = null;
      try { preview = await Dec.decode(bytes, photo.name); } catch (_) { /* no preview: develop without matching */ }
      try {
        const r = await PJ.Raw.develop(photo, bytes, preview && preview.note !== 'No embedded preview' ? preview : null);
        if (preview && preview.image && preview.image.close) try { preview.image.close(); } catch (_) { }
        const exif = Object.assign({}, preview ? preview.exif : Dec.parseExif(bytes), { orientation: 1 });
        return { dec: { pixels: r.pixels, input: r.input, width: r.width, height: r.height, isRaw: true, format: Dec.ext(photo.name).toUpperCase(), exif, note: r.note }, bytes };
      } catch (e) {
        console.warn('RAW development failed, using the embedded preview:', e && e.message);
        if (preview) return { dec: preview, bytes };
      }
    }
    try {
      const dec = await Dec.decode(bytes, photo.name);
      return { dec, bytes };
    } catch (err) {
      // Formats the web engine can't open (HEIC without HEVC, JPEG 2000, PIZ-compressed EXR …):
      // the native shells render them with the system decoder (ImageIO on macOS, ImageDecoder on Android).
      if (!API.imageUrl) throw err;
      const r = await fetch(API.imageUrl(photo.path));
      if (!r.ok) throw err;
      const dec = await Dec.decode(new Uint8Array(await r.arrayBuffer()), 'native-render.jpg');
      dec.format = Dec.ext(photo.name).toUpperCase();
      dec.exif = Object.assign({}, Dec.parseExif(bytes), { orientation: 1 });
      dec.note = 'Decoded by ' + ({ android: 'Android', windows: 'Windows' }[API.platform] || 'macOS');
      return { dec, bytes };
    }
  }

  /** Load (or fetch cached) proxy + draft sources for a photo. Updates photo metadata on first load. */
  /** RAW files developed in JS are slow to decode, so thumbnails use their embedded preview ('any'). */
  const needsDevelop = (photo) => !!(Dec.isRaw(photo.name) && PJ.Raw && PJ.Raw.canDecode(photo.name) && API.platform !== 'macos' && Cat.pref('raw.engine', 'full') !== 'preview');
  /* ---------------- Developed-RAW cache (on disk) ----------------
   * Developing a RAW file takes about half a second; its result at working (proxy) size is kept on
   * disk by the app shell, so the next time the photo is opened it is there in a few hundredths of
   * a second. The full-resolution image is developed again only when it is needed (1:1, export).
   * The key covers the file's identity and the engine version, so a changed file or a newer
   * develop engine never gets a stale image. */
  const RAW_CACHE_VERSION = 'r2';   // r2: developed pixels are in Display P3 primaries
  const rawCacheKey = (photo) => [RAW_CACHE_VERSION, photo.path, photo.size || 0, Math.round(photo.mtime || 0), PROXY_EDGE].join('|');
  async function readRawCache(photo) {
    if (!API.rawCache || !photo.exifLoaded || !photo.width) return null;
    const bytes = await API.rawCache.get(rawCacheKey(photo));
    if (!bytes || bytes.length < 8) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hlen = dv.getUint32(0, true);
    if (hlen > 65536 || 4 + hlen > bytes.length) return null;
    const hd = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hlen)));
    const n = hd.w * hd.h * 4;
    if (hd.v !== 1 || !(n > 0) || bytes.length !== 4 + hlen + n || !Array.isArray(hd.lut) || hd.lut.length !== 256) return null;
    const data = P.allocPixels(n);
    data.set(bytes.subarray(4 + hlen));
    const proxy = { data, width: hd.w, height: hd.h };
    let draft;
    try {
      const shared = P.isShared(data), buffer = shared ? data.buffer : data.slice().buffer;
      const r = await pool.task({ op: 'levels', buffer, width: hd.w, height: hd.h, edges: [DRAFT_EDGE] }, shared ? [] : [buffer], 0);
      draft = { data: new Uint8ClampedArray(r.levels[0].buffer), width: r.levels[0].width, height: r.levels[0].height };
    } catch (_) { draft = Dec.resizePixels(proxy, DRAFT_EDGE); }
    return {
      key: photo.path, proxy, draft, full: null, fullW: hd.fullW, fullH: hd.fullH, exifBytes: null,
      input: { lut: Float32Array.from(hd.lut), matrix: hd.matrix || null, space: hd.space || 'srgb' }, quality: 'best', fromCache: true
    };
  }
  function writeRawCache(photo, src) {
    if (!API.rawCache || !src.input || !src.input.lut || src.quality !== 'best') return;
    try {
      const head = new TextEncoder().encode(JSON.stringify({
        v: 1, w: src.proxy.width, h: src.proxy.height, fullW: src.fullW, fullH: src.fullH,
        lut: Array.from(src.input.lut), matrix: src.input.matrix || null, space: src.input.space || 'srgb'
      }));
      const out = new Uint8Array(4 + head.length + src.proxy.data.length);
      new DataView(out.buffer).setUint32(0, head.length, true);
      out.set(head, 4);
      out.set(src.proxy.data, 4 + head.length);
      API.rawCache.put(rawCacheKey(photo), out).catch(() => { });
    } catch (e) { console.warn('could not cache the developed RAW', e && e.message); }
  }

  /* Pre-develop the photos next to the one on screen, so stepping to them is instant.
   * Runs after a short pause and stops when another photo is shown. */
  let prefetchToken = 0;
  function prefetch(list) {
    const token = ++prefetchToken;
    const todo = (list || []).filter(p => p && !p.missing && p.kind !== 'video' && needsDevelop(p));
    if (!todo.length) return;
    setTimeout(async () => {
      for (const p of todo) {
        if (token !== prefetchToken) return;
        const have = sources.get(p.path);
        if (have && have.quality !== 'preview') continue;
        try { await ensureSource(p, 'best', { prefetch: true }); } catch (_) { /* it will report when opened */ }
      }
    }, 350);
  }

  async function ensureSource(photo, want = 'best', loadOpts) {
    const key = photo.path;
    if (sources.has(key)) {
      const s = sources.get(key);
      if (want === 'any' || s.quality !== 'preview') { sources.delete(key); sources.set(key, s); return s; }
    }
    const lkey = key + (want === 'any' && needsDevelop(photo) ? '|any' : '');
    if (loading.has(key)) return loading.get(key);
    if (loading.has(lkey)) return loading.get(lkey);
    const pr = (async () => {
      const quick = want === 'any' && needsDevelop(photo);
      const prefetching = !!(loadOpts && loadOpts.prefetch);
      // a RAW developed before comes straight from the disk cache
      if (!quick && photo.kind !== 'video' && needsDevelop(photo)) {
        const cached = await readRawCache(photo).catch(() => null);
        if (cached) {
          if (sources.has(key)) pool.forget(key + '|'); // replacing a preview-quality source
          sources.set(key, cached);
          while (sources.size > MAX_SOURCES) { const k = sources.keys().next().value; sources.delete(k); pool.forget(k + '|'); }
          for (const p of Cat.state.photos) if (p.path === photo.path && p.missing) p.missing = false;
          return cached;
        }
      }
      const { dec, bytes } = await decodePhoto(photo, quick ? 'any' : 'best');
      // Read the pixels once at working resolution, then build the smaller levels by
      // resampling in JS. (Browser-side canvas scaling returned empty images in WebKit.)
      const full = workingFrom(dec);
      const { proxy, draft } = await buildLevels(full);
      const fW = full.width, fH = full.height;
      // A quick preview that finishes after the developed image is already in place must not replace it
      if (quick && sources.has(key) && sources.get(key).quality !== 'preview') return sources.get(key);
      const src = { key, proxy, draft, full, fullW: fW, fullH: fH, exifBytes: null, input: dec.input || null, quality: quick ? 'preview' : 'best' };
      if (sources.has(key)) pool.forget(key + '|'); // replacing a preview-quality source
      // Only keep one full-resolution copy in memory at a time — the photo on screen's, so a
      // photo developed ahead of time gives its own up instead of taking it away
      if (prefetching) src.full = null;
      else for (const s of sources.values()) if (s.full) { s.full = null; pool.forget(s.key + '|full'); }
      if (!quick && dec.isRaw && dec.input) writeRawCache(photo, src);
      // Keep the original EXIF APP1 segment of JPEGs to embed in exports
      if (/jpe?g$/i.test(photo.name)) src.jpegHeader = extractApp1(bytes);
      if (dec.image && dec.image.close) try { dec.image.close(); } catch (_) { }
      // Fill metadata into the catalog the first time
      const all = Cat.state.photos.filter(p => p.path === photo.path);
      let changed = false;
      for (const p of all) {
        if (p.width !== fW || p.height !== fH) { p.width = fW; p.height = fH; changed = true; }
        if ((dec.isVideo || !quick) && dec.note && p.note !== dec.note) { p.note = dec.note; changed = true; }
        if (!p.exifLoaded) {
          p.exif = dec.exif || {}; p.exifLoaded = true; changed = true;
          if (dec.exif && dec.exif.captureTime) p.captureTime = dec.exif.captureTime;
          if (dec.note) p.note = dec.note;
          if (!p.size && bytes.length) p.size = bytes.length;
        }
        if (p.missing) { p.missing = false; changed = true; }
      }
      if (changed) { Cat.scheduleSave(); Cat.events.emit('meta', all, {}); }
      sources.set(key, src);
      while (sources.size > MAX_SOURCES) {
        const k = sources.keys().next().value;
        sources.delete(k);
        pool.forget(k + '|');
      }
      return src;
    })();
    loading.set(lkey, pr);
    try { return await pr; } catch (e) {
      Cat.state.photos.filter(p => p.path === photo.path).forEach(p => { p.missing = true; });
      throw e;
    } finally { loading.delete(lkey); }
  }
  /** Decoded image → working pixels (developed RAW pixels are used as they are). */
  function workingFrom(dec) {
    if (dec.pixels) {
      const cap = capEdge(dec.pixels.width, dec.pixels.height);
      const px = cap ? P.resizePixels(dec.pixels, cap) : dec.pixels;
      return { data: P.SHARED && !P.isShared(px.data) ? P.copyPixels(px.data) : px.data, width: px.width, height: px.height };
    }
    return toWorkingPixels(Dec.toImageData(dec.image, capEdge(dec.width, dec.height)));
  }
  /** ImageData → plain pixels, in shared memory when the page is cross-origin isolated. */
  function toWorkingPixels(img) {
    return { data: P.SHARED ? P.copyPixels(img.data) : img.data, width: img.width, height: img.height };
  }
  /** Proxy (1600 px) and draft (800 px) levels, resampled on a worker so the UI never stalls on big files. */
  async function buildLevels(full) {
    try {
      const shared = P.isShared(full.data);
      const buffer = shared ? full.data.buffer : full.data.slice().buffer;
      const r = await pool.task({ op: 'levels', buffer, width: full.width, height: full.height, edges: [PROXY_EDGE, DRAFT_EDGE] }, shared ? [] : [buffer], 0);
      const mk = (l) => ({ data: new Uint8ClampedArray(l.buffer), width: l.width, height: l.height });
      return { proxy: mk(r.levels[0]), draft: mk(r.levels[1]) };
    } catch (e) {
      console.warn('worker resize failed, resizing on the UI thread', e);
      const proxy = Dec.resizePixels(full, PROXY_EDGE);
      return { proxy, draft: Dec.resizePixels(proxy, DRAFT_EDGE) };
    }
  }
  function cachedSource(photo) { return sources.get(photo.path) || null; }

  async function ensureFull(photo) {
    const src = await ensureSource(photo);
    if (src.full) return src;
    const { dec } = await decodePhoto(photo);
    src.full = workingFrom(dec);
    if (dec.input) src.input = dec.input;
    if (dec.image && dec.image.close) try { dec.image.close(); } catch (_) { }
    // Only keep one full-res source at a time
    for (const s of sources.values()) if (s !== src && s.full) { s.full = null; pool.forget(s.key + '|full'); }
    return src;
  }

  function extractApp1(bytes) {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    let p = 2;
    while (p + 4 < bytes.length) {
      if (bytes[p] !== 0xFF) return null;
      const m = bytes[p + 1], len = (bytes[p + 2] << 8) | bytes[p + 3];
      if (m === 0xDA) return null;
      if (m === 0xE1 && bytes[p + 4] === 0x45 && bytes[p + 5] === 0x78) return bytes.slice(p, p + 2 + len);
      p += 2 + len;
    }
    return null;
  }

  /* ---------------- Rendering ---------------- */
  /** Whether this browser can hold Display P3 pixels in a canvas (needed to show wide colour as it is). */
  const P3_CANVAS = (() => {
    try { const x = Dec.makeCanvas(1, 1).getContext('2d', { colorSpace: 'display-p3' }); return !!x && x.getContextAttributes().colorSpace === 'display-p3'; }
    catch (_) { return false; }
  })();
  function getLevel(src, level) { return level === 'draft' ? src.draft : level === 'full' ? src.full : src.proxy; }

  /**
   * Render photo with settings. level: 'draft' | 'proxy' | 'full'.
   * opts: pipeline opts (region in output px *of that level*, clipping, before, overlayMask, cropOverride)
   * Returns {data: Uint8ClampedArray, width, height, fullWidth, fullHeight, region, hist, clip, ms, level, scale}
   */
  async function render(photo, settings, level, opts, priority, want) {
    // Subject / Sky / People masks: their shapes have to be in memory before a worker can use them
    if (PJ.AIMask && settings && settings.masks && !PJ.AIMask.ready(settings)) await PJ.AIMask.ensure(photo, settings);
    const src = level === 'full' ? await ensureFull(photo) : await ensureSource(photo, want || 'best');
    // a stabilized clip's current frame gets its stabilizing transform
    if (photo.kind === 'video' && PJ.Stabilize && settings && settings.stab && settings.stab.amount > 0) settings = PJ.Stabilize.apply(photo, P.normalizeSettings(settings), PJ.Video.defaultTime(photo));
    if (src.input) opts = Object.assign({}, opts, { srcInput: src.input, wide: !!photo.wide }); // RAW: per-file base curve & colour
    const lutId = settings && settings.lut && settings.lut.id;
    if (lutId && PJ.LUTs) { const cube = await PJ.LUTs.get(lutId); if (cube) opts = Object.assign({}, opts, { cube }); }
    const lv = getLevel(src, level);
    const key = `${src.key}|${level}`;
    const fullLong = Math.max(src.fullW, src.fullH);
    const geo = P.buildGeometry(P.normalizeSettings(settings), lv.width, lv.height, opts && opts.cropOverride);
    const region = (opts && opts.region) || { x: 0, y: 0, w: geo.outW, h: geo.outH };
    const pixels = region.w * region.h;
    // Split across workers. Bands overlap by the neighbourhood padding the edit needs, so only split
    // as far as the overlap stays small (per-pixel edits have none and use every worker).
    const nsettings = P.normalizeSettings(settings);
    const pad = P.neighborhoodPad(nsettings, Math.max(lv.width, lv.height), Math.min(1, Math.max(lv.width, lv.height) / fullLong));
    const byPixels = Math.floor(pixels / 90000);
    const byOverlap = pad ? Math.floor(region.h / (1.5 * pad)) : Infinity;
    const nb = Math.max(1, Math.min(pool.workers.length, byPixels, byOverlap));
    // Hold on to this level's pixels: the cache may drop them (another photo's full-res load) before a worker needs them
    const base = { key, settings, fullLongEdge: fullLong, seed: seedFor(photo), getSource: () => lv };
    const t0 = performance.now();
    let parts;
    if (nb <= 1) {
      parts = [await pool.run({ ...base, opts: { ...opts, region: opts && opts.region } }, priority ?? 1)];
    } else {
      const bandH = Math.ceil(region.h / nb);
      const jobs = [];
      for (let b = 0; b < nb; b++) {
        const y = region.y + b * bandH, hh = Math.min(bandH, region.y + region.h - y);
        if (hh <= 0) continue;
        jobs.push(pool.run({ ...base, opts: { ...opts, region: { x: region.x, y, w: region.w, h: hh } } }, priority ?? 1));
      }
      parts = await Promise.all(jobs);
    }
    if (parts.some(p => !p)) return null; // cancelled
    // Merge bands
    const W = parts[0].region.w;
    const H = parts.reduce((a, p) => a + p.region.h, 0);
    let data;
    if (parts.length === 1) data = new Uint8ClampedArray(parts[0].buffer);
    else {
      data = new Uint8ClampedArray(W * H * 4);
      let off = 0;
      for (const p of parts) { const a = new Uint8ClampedArray(p.buffer); data.set(a, off); off += a.length; }
    }
    let data16 = null;
    if (parts[0].buffer16) {
      if (parts.length === 1) data16 = new Uint16Array(parts[0].buffer16);
      else { data16 = new Uint16Array(W * H * 3); let off = 0; for (const p of parts) { const a = new Uint16Array(p.buffer16); data16.set(a, off); off += a.length; } }
    }
    const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
    const clip = { hi: 0, lo: 0 };
    for (const p of parts) {
      for (const c of ['r', 'g', 'b', 'l']) for (let i = 0; i < 256; i++) hist[c][i] += p.hist[c][i];
      clip.hi += p.clip.hi; clip.lo += p.clip.lo;
    }
    return {
      data, data16, width: W, height: H, fullWidth: parts[0].fullWidth, fullHeight: parts[0].fullHeight,
      region: { x: parts[0].region.x, y: parts[0].region.y, w: W, h: H }, hist, clip,
      space: opts && opts.outSpace === 'p3' && P.isWide(nsettings, opts) ? 'p3' : 'srgb',
      ms: performance.now() - t0, level, levelWidth: lv.width, levelHeight: lv.height,
      fullW: src.fullW, fullH: src.fullH
    };
  }

  /* ---------------- GPU previews ----------------
   * Live slider drags render the proxy level on the GPU (WebGL2) in a few milliseconds instead of
   * waiting on the worker pool; the CPU render still settles every edit, so exports and the final
   * on-screen frame are unchanged. Any GL failure turns the GPU path off for the session. */
  let gpu = null, gpuOff = false, gpuSrcSig = '', gpuSlow = 0;
  function gpuReady() {
    if (gpuOff || !PJ.GL || !PJ.Catalog || PJ.Catalog.pref('gpu.preview', true) === false) return false;
    if (!gpu) {
      try {
        gpu = new PJ.GL.Renderer();
        // Software rasterisers render far slower than the worker pool
        const gl = gpu.gl, dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name) && !PJ.Catalog.pref('gpu.force', false)) throw new Error('software renderer (' + name + ')');
      } catch (e) { console.warn('GPU previews unavailable:', e.message); gpu = null; gpuOff = true; return false; }
      gpu.canvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); gpu = null; gpuSrcSig = ''; });
    }
    return true;
  }
  /* Histogram and clip counts for a GPU frame. Reading pixels back stalls the GPU for several
   * milliseconds, so it happens at most ~20 times a second, from every other pixel (exact values,
   * not averaged, so isolated clipped pixels still count); the frames in between reuse the last
   * result. The CPU render that settles each edit supplies the exact histogram.
   * Clip-warning overlay colours count as clipped. */
  let gpuStatsLast = null, gpuStatsAt = 0, gpuStatsKey = '', gpuStatsCanvas = null;
  function gpuStats(r, opts) {
    const cl = opts && opts.clipping || {};
    const key = gpuSrcSig + '|' + r.width + 'x' + r.height + '|' + (cl.hi ? 1 : 0) + (cl.lo ? 1 : 0);
    if (gpuStatsLast && key === gpuStatsKey && performance.now() - gpuStatsAt < 50) return gpuStatsLast;
    const w = Math.ceil(r.width / 2), h = Math.ceil(r.height / 2);
    if (!gpuStatsCanvas) gpuStatsCanvas = Dec.makeCanvas(w, h);
    if (gpuStatsCanvas.width !== w || gpuStatsCanvas.height !== h) { gpuStatsCanvas.width = w; gpuStatsCanvas.height = h; }
    const ctx = gpuStatsCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false; // nearest neighbour: one real pixel out of every four
    ctx.drawImage(gpu.canvas, 0, 0, r.width, r.height, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
    let hi = 0, lo = 0;
    const n = w * h;
    for (let i = 0, end = n * 4; i < end; i += 4) {
      let R = d[i], G = d[i + 1], B = d[i + 2];
      if (cl.hi && R === 255 && G === 40 && B === 40) { hi++; G = B = 255; }
      else if (cl.lo && R === 40 && G === 90 && B === 255) { lo++; R = G = B = 0; }
      else if (R >= 255 || G >= 255 || B >= 255) hi++; else if (R <= 0 && G <= 0 && B <= 0) lo++;
      hist.r[R]++; hist.g[G]++; hist.b[B]++; hist.l[(R * 54 + G * 183 + B * 19) >> 8]++;
    }
    const scale = (r.width * r.height) / Math.max(1, n);
    for (const c of ['r', 'g', 'b', 'l']) for (let i = 0; i < 256; i++) hist[c][i] = Math.round(hist[c][i] * scale);
    gpuStatsLast = { hist, clip: { hi: Math.round(hi * scale), lo: Math.round(lo * scale) } };
    gpuStatsAt = performance.now(); gpuStatsKey = key;
    return gpuStatsLast;
  }

  /** Same result shape as render(), with `canvas` in place of `data`. Synchronous; null when unavailable. */
  function renderGPU(photo, settings, opts) {
    if (!gpuReady()) return null;
    // a mask shape that isn't loaded yet: start loading it and let the CPU render (which waits for it) take this frame
    if (PJ.AIMask && !PJ.AIMask.ready(settings)) { PJ.AIMask.ensure(photo, settings).catch(() => { }); return null; }
    const src = cachedSource(photo);
    if (!src || !src.proxy) return null;
    try {
      const t0 = performance.now();
      const s = P.normalizeSettings(settings), lv = src.proxy;
      const spots = s.spots && s.spots.length ? s.spots : null;
      const sig = src.key + '|' + lv.width + 'x' + lv.height + '|' + (spots ? JSON.stringify(spots) : '');
      if (sig !== gpuSrcSig || gpu.srcLevel !== lv) {
        const data = spots ? P.applySpots(lv.data, lv.width, lv.height, spots) : lv.data;
        gpu.setPixels(data, lv.width, lv.height);
        gpu.srcLevel = lv; gpuSrcSig = sig;
      }
      gpu.srcW = lv.width; gpu.srcH = lv.height;
      const o = Object.assign({}, opts, { levelScale: 1, fullLong: Math.max(src.fullW, src.fullH), seed: seedFor(photo), target: 'canvas' });
      if (src.input) { o.srcInput = src.input; o.wide = !!photo.wide; }
      if (s.lut.id && PJ.LUTs) { o.cube = PJ.LUTs.getSync(s.lut.id); if (!o.cube) { PJ.LUTs.get(s.lut.id); return null; } }
      const wide = P.isWide(s, o);
      if (wide && (!P3_CANVAS || (o.cube && s.lut.amount > 0))) return null;   // a look in wide colour, or no P3 canvas: the CPU render does it
      const r = gpu.render(s, o);
      // The frame stays on the GPU: copying it into a plain canvas needs no readback, so live
      // drags can keep up with the display's refresh rate.
      const canvas = Dec.makeCanvas(r.width, r.height);
      canvas.getContext('2d', wide ? { colorSpace: 'display-p3' } : undefined).drawImage(gpu.canvas, 0, 0);
      const stats = gpuStats(r, opts);
      const ms = performance.now() - t0;
      // A GPU slower than the workers (software GL, an overloaded laptop chip) isn't worth it
      gpuSlow = gpuSlow * 0.7 + (ms > 120 ? 1 : 0) * 0.3;
      if (gpuSlow > 0.6 && !PJ.Catalog.pref('gpu.force', false)) { console.warn('GPU previews are slower than the CPU here; turning them off'); gpuOff = true; }
      return {
        canvas, width: r.width, height: r.height, fullWidth: r.fullWidth, fullHeight: r.fullHeight,
        region: { x: 0, y: 0, w: r.width, h: r.height }, hist: stats.hist, clip: stats.clip,
        ms, level: 'proxy', gpu: true, space: wide ? 'p3' : 'srgb', levelWidth: lv.width, levelHeight: lv.height, fullW: src.fullW, fullH: src.fullH
      };
    } catch (e) {
      console.warn('GPU preview failed; using the CPU from now on', e);
      gpuOff = true;
      return null;
    }
  }

  function toCanvas(res) {
    if (res.canvas) return res.canvas;
    const c = Dec.makeCanvas(res.width, res.height);
    // a wide-colour result goes into a Display P3 canvas; drawn onto an sRGB one, the browser narrows it
    if (res.space === 'p3' && P3_CANVAS) c.getContext('2d', { colorSpace: 'display-p3' }).putImageData(new ImageData(res.data, res.width, res.height, { colorSpace: 'display-p3' }), 0, 0);
    else c.getContext('2d').putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
    return c;
  }

  /* ---------------- Thumbnails ---------------- */
  const thumbQueue = new Map(); // id -> photo
  const thumbEvents = PJ.UI.emitter();

  function queueThumb(photo, front) {
    if (!photo || photo.missing) return;
    if (front) { thumbQueue.delete(photo.id); const rest = [...thumbQueue]; thumbQueue.clear(); thumbQueue.set(photo.id, photo); rest.forEach(([k, v]) => thumbQueue.set(k, v)); }
    else thumbQueue.set(photo.id, photo);
    runThumbs();
  }
  // Several previews in flight at once: while one is decoding (off-thread) or encoding, the
  // workers render another.
  const THUMB_CONCURRENCY = Math.max(2, Math.min(4, Math.ceil(nWorkers / 2)));
  let thumbActive = 0, thumbDone = 0;
  function runThumbs() {
    while (thumbActive < THUMB_CONCURRENCY && thumbQueue.size) {
      const [id, photo] = thumbQueue.entries().next().value;
      thumbQueue.delete(id);
      if (!Cat.get(id)) continue;
      thumbActive++;
      makeThumb(photo).finally(() => {
        thumbActive--; thumbDone++;
        if (thumbQueue.size) runThumbs();
        else if (!thumbActive) { PJ.UI.activity(''); thumbDone = 0; }
      });
    }
  }
  async function makeThumb(photo) {
    try {
      PJ.UI.activity(`Generating previews… (${thumbQueue.size + thumbActive})`);
      const src = await ensureSource(photo, 'any');
      const res = await render(photo, photo.settings, 'draft', {}, 2, 'any');
      if (!res) return;
      // Perceptual hash of the unedited picture, for the duplicate finder
      if (src && src.draft && (!photo.dhash || photo.dhashV !== photo.size)) { photo.dhash = dhash(src.draft); photo.dhashV = photo.size; }
      const small = Dec.resizePixels({ data: res.data, width: res.width, height: res.height }, THUMB_EDGE);
      const t = Dec.makeCanvas(small.width, small.height);
      t.getContext('2d').putImageData(new ImageData(P.isShared(small.data) ? small.data.slice() : small.data, small.width, small.height), 0, 0);
      const blob = t.convertToBlob ? await t.convertToBlob({ type: 'image/jpeg', quality: 0.82 }) : await new Promise(r => t.toBlob(r, 'image/jpeg', 0.82));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await API.saveThumb(photo.id, bytes);
      photo.thumbV = (photo.thumbV || 0) + 1;
      Cat.scheduleSave();
      thumbEvents.emit('thumb', photo);
    } catch (e) {
      // Only call a file missing when it really is gone; other failures (a decoder hiccup, a clip
      // being reopened) are retried once.
      if (!photo._thumbRetry) {
        photo._thumbRetry = true;
        setTimeout(() => queueThumb(photo), 800);
        return;
      }
      console.warn('thumb failed', photo.name, e);
      let gone = false;
      try { gone = API.stat ? !(await API.stat(photo.path)) && !(API.fileSize && await API.fileSize(photo.path).catch(() => 0)) : false; } catch (_) { gone = false; }
      if (gone) photo.missing = true;
      thumbEvents.emit('thumb', photo);
    } finally {
      if (photo.thumbV) delete photo._thumbRetry;
    }
  }

  /**
   * 64-bit difference hash (dHash) of RGBA pixels as 16 hex digits: luma averaged into 9×8
   * cells, one bit per horizontal neighbour comparison. Survives resizing, recompression and
   * small tonal edits; differs for different pictures.
   */
  function dhash(px) {
    const W = px.width, H = px.height, d = px.data, cells = new Float64Array(72), cnt = new Float64Array(72);
    const step = Math.max(1, Math.floor(Math.min(W, H) / 96));
    for (let y = 0; y < H; y += step) {
      const cy = Math.min(7, Math.floor(y * 8 / H));
      for (let x = 0; x < W; x += step) {
        const i = (y * W + x) * 4, c = cy * 9 + Math.min(8, Math.floor(x * 9 / W));
        cells[c] += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; cnt[c]++;
      }
    }
    for (let i = 0; i < 72; i++) cells[i] /= cnt[i] || 1;
    let hex = '';
    for (let y = 0; y < 8; y++) {
      let byte = 0;
      for (let x = 0; x < 8; x++) byte = (byte << 1) | (cells[y * 9 + x] < cells[y * 9 + x + 1] ? 1 : 0);
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  }

  /* ---------------- Analysis ---------------- */
  async function autoTone(photo, settings) {
    const s = P.normalizeSettings(P.clone(settings));
    ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'clarity', 'dehaze', 'texture', 'vibrance', 'saturation'].forEach(k => { s[k] = 0; });
    s.curve = P.defaultSettings().curve; s.masks = []; s.effects.vigAmount = 0; s.effects.grain = 0;
    const res = await render(photo, s, 'draft', {}, 0);
    return P.autoToneFromHist(res.hist.l);
  }

  /** Auto color grade: analyse the photo as currently toned (grading/vibrance/saturation neutral) and build a look. */
  async function autoGrade(photo, settings, style, strength) {
    const s = P.normalizeSettings(P.clone(settings));
    s.grading = P.defaultSettings().grading; s.vibrance = 0; s.saturation = 0;
    s.effects.vigAmount = 0; s.effects.grain = 0;
    const res = await render(photo, s, 'draft', {}, 0);
    if (!res) return null;
    return P.autoGrade(res.data, res.width, res.height, style || 'auto', strength || 'normal');
  }

  /** Gray-world auto white balance on the source (linear). */
  async function autoWB(photo) {
    const src = await ensureSource(photo);
    const d = src.draft.data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) {
      const [R, G, B] = src.input ? PJ.Raw.sourceLinear(src.input, d[i], d[i + 1], d[i + 2]) : [P.SRGB8_TO_LIN[d[i]], P.SRGB8_TO_LIN[d[i + 1]], P.SRGB8_TO_LIN[d[i + 2]]];
      const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      if (y < 0.02 || y > 0.9) continue; // skip extremes
      r += R; g += G; b += B; n++;
    }
    if (!n) return { temp: 0, tint: 0 };
    return P.neutralizeWB(r / n, g / n, b / n);
  }

  /** Average linear source color at an output position (in full-res output px). */
  async function sampleAt(photo, settings, ox, oy, radius) {
    const src = await ensureSource(photo);
    const lv = src.proxy;
    const scale = Math.max(lv.width, lv.height) / Math.max(src.fullW, src.fullH);
    const geo = P.buildGeometry(P.normalizeSettings(settings), lv.width, lv.height);
    const r = Math.max(1, Math.round((radius || 3)));
    let R = 0, G = 0, B = 0, n = 0;
    const p = [0, 0];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      geo.toSource(ox * scale + dx, oy * scale + dy, p);
      const x = Math.floor(p[0]), y = Math.floor(p[1]);
      if (x < 0 || y < 0 || x >= lv.width || y >= lv.height) continue;
      const i = (y * lv.width + x) * 4;
      if (src.input) { const c = PJ.Raw.sourceLinear(src.input, lv.data[i], lv.data[i + 1], lv.data[i + 2]); R += c[0]; G += c[1]; B += c[2]; }
      else { R += P.SRGB8_TO_LIN[lv.data[i]]; G += P.SRGB8_TO_LIN[lv.data[i + 1]]; B += P.SRGB8_TO_LIN[lv.data[i + 2]]; }
      n++;
    }
    if (!n) return null;
    return [R / n, G / n, B / n];
  }

  /** Full-resolution render for export (parallel bands). */
  async function renderFull(photo, settings, onProgress, opts) {
    onProgress && onProgress(0.05);
    const res = await render(photo, settings, 'full', opts || {}, 1);
    onProgress && onProgress(0.9);
    return res;
  }

  /** Forget a photo's decoded pixels (a video's current frame changed). */
  function invalidate(photo) {
    const key = photo.path;
    sources.delete(key);
    pool.forget(key + '|');
  }

  function dropFull() {
    for (const s of sources.values()) if (s.full) { s.full = null; pool.forget(s.key + '|full'); }
  }

  global.PJ.Engine = {
    P3_CANVAS, PROXY_EDGE, DRAFT_EDGE, pool, ensureSource, cachedSource, needsDevelop, prefetch, ensureFull, render, toCanvas,
    queueThumb, thumbStatus: () => ({ active: thumbActive, queued: thumbQueue.size }), thumbEvents, autoTone, autoGrade, autoWB, sampleAt, renderFull, renderGPU, gpuReady, dhash, gpuInfo: () => ({ on: !!gpu && !gpuOff, off: gpuOff }), dropFull, seedFor, invalidate
  };
})(window);
