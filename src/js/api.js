/* =====================================================================
 * photos.jpeg — platform bridge.
 * Native apps: Windows (WebView2), macOS (WKWebView) and Android (WebView) hosts.
 * Browser fallback: in-memory files, localStorage catalog, downloads.
 * ===================================================================== */
(function (global) {
  'use strict';
  /* -------- Native shells: Windows (WebView2), macOS (WKWebView) & Android (WebView) -------- */
  const MAC = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.pj;
  const AND = global.PJAndroid;
  const WIN = global.__pjInfo && global.__pjInfo.platform === 'windows' && global.chrome && global.chrome.webview;
  if (MAC || AND || WIN) {
    const platform = WIN ? 'windows' : MAC ? 'macos' : 'android';
    const pending = new Map();
    let seq = 0;
    global.__pjResolve = (id, result, error) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result === undefined || result === null ? null : JSON.parse(result));
    };
    // Windows: { id, method, args } is posted to the host, which posts back { id, result | error };
    // `objects` (dropped File objects) travel alongside so the host can see their real paths.
    function call(method, args, objects) {
      if (MAC) return MAC.postMessage({ method, args: args || {} });
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        if (!WIN) AND.call(id, method, JSON.stringify(args || {}));
        else if (objects) WIN.postMessageWithAdditionalObjects({ id, method, args: args || {} }, objects);
        else WIN.postMessage({ id, method, args: args || {} });
      });
    }
    // Events pushed from native code: window.__pjEvent(type, payload)
    const listeners = new Map();
    const queued = [];
    global.__pjEvent = (type, payload) => {
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { /* plain string */ } }
      const ls = listeners.get(type);
      if (ls && ls.size) ls.forEach(fn => fn(payload)); else queued.push([type, payload]);
    };
    if (WIN) WIN.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.event) return global.__pjEvent(m.event, m.payload);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result === undefined ? null : m.result);
    });
    const on = (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      for (let i = 0; i < queued.length; i++) if (queued[i][0] === type) { fn(queued[i][1]); queued.splice(i--, 1); }
    };
    function b64(bytes) {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }
    const q = (p) => encodeURIComponent(p);
    const info = (AND && AND.info) ? JSON.parse(AND.info()) : (global.__pjInfo || {});
    const SEP = WIN ? '\\' : '/';
    global.PJ.API = {
      isDesktop: true,          // has a real file system & persistent catalog
      isNative: true,
      platform,
      touch: platform === 'android',
      workerMode: MAC ? 'blob' : 'url',
      maxFullPixels: platform === 'android' ? 24e6 : 0,
      supportsSameFolder: platform !== 'android',
      openFiles: () => call('openFiles'),
      openFolder: () => call('openFolder'),
      scanPaths: (paths) => call('scanPaths', { paths }),
      async readFile(p) {
        const r = await fetch(`/__pj/file?path=${q(p)}`);
        if (!r.ok) throw new Error(`Cannot read ${p} (${r.status})`);
        return new Uint8Array(await r.arrayBuffer());
      },
      rawUrl: WIN ? null : (p) => `/__pj/raw?path=${q(p)}`,   // Windows develops RAW files with the built-in engine
      imageUrl: (p) => `/__pj/image?path=${q(p)}`,
      stat: (p) => call('stat', { path: p }),
      loadCatalog: async () => { const t = await call('loadCatalog'); return t ? JSON.parse(t) : null; },
      saveCatalog: (obj) => call('saveCatalog', { json: JSON.stringify(obj) }),
      saveThumb: (id, bytes) => call('saveThumb', { id, data: b64(bytes) }),
      deleteThumb: (id) => call('deleteThumb', { id }),
      thumbUrl: (id, v) => `/__pj/thumb/${q(id)}.jpg?v=${v || 0}`,
      hasThumbStore: true,
      chooseDirectory: (def) => call('chooseDirectory', { path: def || '' }),
      writeFile: (path, bytes, mode) => call('writeFile', { path, data: b64(bytes), mode: mode || 'unique' }),
      joinPath: (...parts) => {
        const s = parts.filter(Boolean).map(String);
        if (!s.length) return '';
        if (WIN) return (/^[\\/]{2}/.test(s[0]) ? SEP : '') + s.join(SEP).replace(/[\\/]+/g, SEP);   // keeps a UNC prefix
        return platform === 'android' ? s.join('/') : s.join('/').replace(/\/+/g, '/');
      },
      dirname: (p) => {
        if (platform === 'android') return '';
        if (!WIN) return String(p).replace(/\/[^/]*$/, '') || '/';
        const s = String(p || ''), i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(SEP));
        return i <= 0 ? s.slice(0, i + 1) : /^[A-Za-z]:$/.test(s.slice(0, i)) ? s.slice(0, i + 1) : s.slice(0, i);
      },
      showInFolder: (p) => call('showInFolder', { path: p }),
      savePresetFile: (name, json) => call('savePresetFile', { name, json }),
      openPresetFiles: () => call('openPresetFiles'),
      onMenu: (cb) => on('menu', cb),
      onNotice: (cb) => on('notice', cb),
      onCard: (cb) => on('card', cb),      // a camera card was put in: { path, label }
      log: WIN ? (level, text) => call('log', { level, text: String(text).slice(0, 4000) }).catch(() => { }) : null,
      checkForUpdates: WIN ? () => call('checkForUpdates') : null,   // same as Help → Check for Updates   // a line of text from the app shell (an update is available …)
      setExportPresets: WIN ? (items) => call('exportPresets', { items }).catch(() => { }) : null,   // File → Export with Preset
      onOpenPaths: (cb) => { on('openPaths', cb); call('ready').catch(() => { }); },
      onFlush: (cb) => on('flush', async () => { try { await cb(); } finally { call('flushed').catch(() => { }); } }),
      onBack: (cb) => on('back', async () => { const handled = await cb(); call('backResult', { handled: !!handled }).catch(() => { }); }),
      getPathForFile: () => '',
      // Files dropped on the window: the host resolves their paths and scans them
      dropFiles: WIN ? (files) => call('dropFiles', {}, files) : null,
      setRepresentedFile: (p) => { if (MAC) call('representedFile', { path: p }).catch(() => { }); },
      defaultExportDir: () => call('defaultExportDir'),
      share: platform === 'android' ? (path) => call('share', { path }) : null,
      appVersion: info.version || '',
      // media / large files
      fileSize: (p) => call('fileSize', { path: p }),
      async readRange(p, offset, length) {
        const r = await fetch(`/__pj/file?path=${q(p)}&start=${offset}&length=${length}`);
        if (!r.ok) throw new Error(`Cannot read ${p} (${r.status})`);
        return new Uint8Array(await r.arrayBuffer());
      },
      mediaUrl: (p) => `/__pj/media?path=${q(p)}`,
      sidecar: (op, p, variant, text, hint) => call('sidecar', { op, path: p, variant, text: text || '', hint: hint || '' }),
      openTextFiles: (title, exts) => call('openTextFiles', { title, exts }),
      saveTextFile: (name, text, ext) => call('saveTextFile', { name, text, ext }),
      openWrite: (p, mode) => call('openWrite', { path: p, mode: mode || 'unique' }),
      writeChunk: (h, bytes) => call('writeChunk', { handle: h, data: b64(bytes) }),
      writeAt: (h, offset, bytes) => call('writeAt', { handle: h, offset, data: b64(bytes) }),
      closeWrite: (h) => call('closeWrite', { handle: h }),
      abortWrite: WIN ? (h) => call('abortWrite', { handle: h }) : null,   // close and delete a failed export
      // re-encode a PNG into a format the web view can't write itself (AVIF, through the bundled ffmpeg)
      encodeImage: WIN ? async (png, format, quality) => {
        const r = await fetch(`/__pj/encode?format=${q(format)}&quality=${Math.round(quality || 80)}`, { method: 'POST', body: png });
        if (!r.ok) throw new Error((await r.text()) || `${format.toUpperCase()} encoding failed`);
        return new Uint8Array(await r.arrayBuffer());
      } : null,
      // developed RAW files at working size, kept on disk by the app shell (binary GET / POST, no base64)
      rawCache: WIN ? {
        get: async (key) => { const r = await fetch('/__pj/rawcache?key=' + q(key)); return r.status === 200 ? new Uint8Array(await r.arrayBuffer()) : null; },
        put: async (key, bytes) => (await fetch('/__pj/rawcache?key=' + q(key), { method: 'POST', body: bytes })).ok
      } : null,
      // Import and Organize: copy or move a file into a folder under a new name; resolves to its new path
      importFile: WIN ? (p, dest, name, move) => call('importFile', { path: p, dest, name, move: !!move }) : null,
      videoTool: (op, args) => call('videoTool', Object.assign({ op }, args || {})),
      onVideoProgress: (cb) => on('videoProgress', cb)
    };
    return;
  }

  /* ------------------------- Browser fallback ------------------------- */
  const files = new Map(); // memPath -> File
  const thumbs = new Map(); // id -> objectURL
  const mediaUrls = new Map(); // path -> objectURL
  const writes = new Map(); // handle -> pending write
  let seq = 0;

  const sidecars = new Map(); // lower-case stem ("img_1" or "img_1.jpg") -> File picked alongside the photos
  function keepSidecars(list) {
    for (const f of list) if (/\.xmp$/i.test(f.name)) sidecars.set(f.name.replace(/\.xmp$/i, '').toLowerCase(), f);
  }
  function register(file) {
    const p = `mem://${++seq}/${file.name}`;
    files.set(p, file);
    return p;
  }
  function describe(file) {
    return { path: register(file), name: file.name, size: file.size, mtime: file.lastModified, folder: 'Browser Imports' };
  }
  function pick(opts) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      if (opts.dir) inp.webkitdirectory = true;
      if (opts.accept) inp.accept = opts.accept;
      inp.onchange = () => resolve(Array.from(inp.files || []));
      inp.click();
    });
  }
  function download(name, bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  global.PJ.API = {
    isDesktop: false,
    platform: 'web',
    async openFiles() {
      const list = await pick({ accept: 'image/*,video/*,.xmp,' + [...PJ.Decode.RAW_EXT, ...PJ.Decode.VIDEO_EXT, ...PJ.Decode.RAW_VIDEO_EXT].map(e => '.' + e).join(',') });
      keepSidecars(list);
      return list.filter(f => PJ.Decode.isSupported(f.name)).map(describe);
    },
    async openFolder() {
      const list = await pick({ dir: true });
      keepSidecars(list);
      const out = list.filter(f => PJ.Decode.isSupported(f.name)).map(f => {
        const d = describe(f);
        const rel = f.webkitRelativePath || f.name;
        d.folder = rel.split('/').slice(0, -1).join('/') || 'Browser Imports';
        return d;
      });
      return { folder: out[0] ? out[0].folder : '', files: out };
    },
    async scanPaths() { return []; },
    async readFile(p) {
      const f = files.get(p);
      if (!f) throw new Error('File not available in this browser session');
      return new Uint8Array(await f.arrayBuffer());
    },
    async fileSize(p) { const f = files.get(p); return f ? f.size : 0; },
    async readRange(p, offset, length) {
      const f = files.get(p);
      if (!f) throw new Error('File not available in this browser session');
      return new Uint8Array(await f.slice(offset, offset + length).arrayBuffer());
    },
    mediaUrl(p) {
      const f = files.get(p);
      if (!f) return '';
      if (!mediaUrls.has(p)) mediaUrls.set(p, URL.createObjectURL(f));
      return mediaUrls.get(p);
    },
    // Writes are assembled in memory and downloaded when closed.
    async openWrite(p) { const h = ++seq; writes.set(h, { path: p, parts: [], patches: [], len: 0 }); return h; },
    async writeChunk(h, bytes) { const w = writes.get(h); w.parts.push(bytes.slice()); w.len += bytes.length; },
    async writeAt(h, offset, bytes) { writes.get(h).patches.push([offset, bytes.slice()]); },
    async closeWrite(h) {
      const w = writes.get(h); writes.delete(h);
      const all = new Uint8Array(w.len); let o = 0;
      for (const part of w.parts) { all.set(part, o); o += part.length; }
      for (const [off, b] of w.patches) all.set(b, off);
      const name = w.path.split(/[\\/]/).pop();
      download(name, all, name.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream');
      return w.path;
    },
    videoTool: async () => { throw new Error('Not available in the browser'); },
    onVideoProgress() { },
    async stat(p) { const f = files.get(p); return f ? { size: f.size, mtime: f.lastModified } : null; },
    async loadCatalog() {
      try { const t = localStorage.getItem('pj.catalog'); return t ? JSON.parse(t) : null; } catch (_) { return null; }
    },
    async saveCatalog(obj) {
      try { localStorage.setItem('pj.catalog', JSON.stringify(obj)); } catch (_) { /* quota */ }
    },
    async saveThumb(id, bytes) {
      if (thumbs.has(id)) URL.revokeObjectURL(thumbs.get(id));
      thumbs.set(id, URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })));
    },
    async deleteThumb(id) { if (thumbs.has(id)) { URL.revokeObjectURL(thumbs.get(id)); thumbs.delete(id); } },
    thumbUrl: (id) => thumbs.get(id) || '',
    hasThumbStore: false,
    async chooseDirectory() { return 'Downloads'; },
    async writeFile(path, bytes) {
      const name = path.split(/[\\/]/).pop();
      const ext = name.split('.').pop().toLowerCase();
      const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', tif: 'image/tiff', json: 'application/json' }[ext];
      download(name, bytes, type);
      return path;
    },
    joinPath: (...parts) => parts.filter(Boolean).join('/'),
    dirname: (p) => p.split('/').slice(0, -1).join('/'),
    async showInFolder() { },
    async savePresetFile(name, json) { download(name, new TextEncoder().encode(json), 'application/json'); return true; },
    async openPresetFiles() {
      const list = await pick({ accept: '.json,.pjpreset' });
      return Promise.all(list.map(f => f.text()));
    },
    onMenu() { },
    onOpenPaths() { },
    onFlush() { },
    getPathForFile: (file) => register(file),
    keepSidecars,
    async openTextFiles(title, exts) {
      const list = await pick({ accept: exts.map(e => '.' + e).join(',') });
      return Promise.all(list.map(async f => ({ name: f.name, text: await f.text() })));
    },
    async saveTextFile(name, text) { download(name, new TextEncoder().encode(text), 'text/plain'); return name; },
    async sidecar(op, p, variant, text) {
      const f = files.get(p);
      if (!f) return null;
      const stem = variant === 'full' ? f.name : f.name.replace(/\.[^.]+$/, '');
      if (op === 'read') { const x = sidecars.get(stem.toLowerCase()); return x ? x.text() : null; }
      download(stem + '.xmp', new TextEncoder().encode(text), 'application/rdf+xml');
      sidecars.set(stem.toLowerCase(), new File([text], stem + '.xmp'));
      return stem + '.xmp';
    },
    describeFile: describe,
    setRepresentedFile() { },
    async defaultExportDir() { return 'Downloads'; },
    appVersion: 'web'
  };
})(typeof self !== 'undefined' ? self : this);
