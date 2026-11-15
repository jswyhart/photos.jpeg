/* =====================================================================
 * photos.jpeg — imported .cube LUTs.
 * The catalog lists them (Catalog.state.luts); the tables themselves live in the app's binary
 * store next to the thumbnails (or inline in the browser build) so catalog saves stay small.
 * Tables are resampled to at most 33³ and stored as 16-bit RGB.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, API = PJ.API, UI = PJ.UI;
  const MAX_N = 33;
  const cache = new Map();   // id -> { id, n, data: Float32Array RGBA (shared memory when available) }
  const loading = new Map(); // id -> Promise
  const events = UI.emitter();

  const Cat = () => PJ.Catalog;
  function list() { const st = Cat().state; if (!st.luts) st.luts = []; return st.luts; }
  const find = (id) => list().find(l => l.id === id) || null;

  function encode(cube) {
    const n = cube.n, N = n * n * n;
    const out = new Uint8Array(8 + N * 6);
    out.set([80, 74, 76, 85, 84, 49], 0); // "PJLUT1"
    new DataView(out.buffer).setUint16(6, n, true);
    const v = new Uint16Array(out.buffer, 8, N * 3);
    for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) { const x = cube.data[i * 4 + c]; v[i * 3 + c] = Math.round((x <= 0 ? 0 : x >= 1 ? 1 : x) * 65535); }
    return out;
  }
  function decode(id, bytes) {
    if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 6)) !== 'PJLUT1') throw new Error('Damaged LUT data');
    const n = new DataView(bytes.buffer, bytes.byteOffset).getUint16(6, true), N = n * n * n;
    const v = new Uint16Array(bytes.slice(8, 8 + N * 6).buffer);
    const data = P.SHARED ? new Float32Array(new SharedArrayBuffer(N * 16)) : new Float32Array(N * 4);
    for (let i = 0; i < N; i++) { data[i * 4] = v[i * 3] / 65535; data[i * 4 + 1] = v[i * 3 + 1] / 65535; data[i * 4 + 2] = v[i * 3 + 2] / 65535; data[i * 4 + 3] = 1; }
    return { id, n, data };
  }
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function importTexts(files) {
    const added = [], errors = [];
    for (const f of files) {
      try {
        const parsed = P.parseCube(f.text, MAX_N);
        const id = Cat().uid('lut_');
        const cube = { id, n: parsed.n, data: parsed.data };
        const bytes = encode(cube);
        const entry = { id, name: (parsed.title || f.name.replace(/\.cube$/i, '')).slice(0, 80), file: f.name, n: parsed.n, sourceSize: parsed.sourceSize, oneD: parsed.oneD, added: Date.now() };
        if (API.hasThumbStore) await API.saveThumb(id, bytes); else entry.b64 = b64(bytes);
        cache.set(id, decode(id, bytes));
        list().push(entry);
        added.push(entry);
      } catch (e) { errors.push(`${f.name}: ${e.message}`); }
    }
    if (added.length) { Cat().scheduleSave(); events.emit('changed'); }
    return { added, errors };
  }
  async function importFiles() {
    const files = await API.openTextFiles('Import LUTs', ['cube']);
    if (!files || !files.length) return { added: [], errors: [] };
    const r = await importTexts(files);
    if (r.errors.length) UI.toast(r.errors[0], 'triangle-exclamation');
    else if (r.added.length) UI.toast(`Imported ${r.added.length} LUT${r.added.length > 1 ? 's' : ''}`, 'swatchbook');
    return r;
  }

  /** The table for an id (cached), or null when it's gone. */
  function get(id) {
    if (!id) return Promise.resolve(null);
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    if (loading.has(id)) return loading.get(id);
    const entry = find(id);
    if (!entry) return Promise.resolve(null);
    const pr = (async () => {
      try {
        let bytes;
        if (entry.b64) bytes = unb64(entry.b64);
        else {
          const r = await fetch(API.thumbUrl(id, entry.added || 1));
          if (!r.ok) throw new Error('LUT data missing');
          bytes = new Uint8Array(await r.arrayBuffer());
        }
        const cube = decode(id, bytes);
        cache.set(id, cube);
        events.emit('loaded', id);
        return cube;
      } catch (e) { console.warn('LUT', entry.name, e.message); return null; }
      finally { loading.delete(id); }
    })();
    loading.set(id, pr);
    return pr;
  }
  const getSync = (id) => (id && cache.get(id)) || null;

  function remove(id) {
    const st = Cat().state;
    st.luts = list().filter(l => l.id !== id);
    cache.delete(id);
    if (API.hasThumbStore) API.deleteThumb(id).catch(() => { });
    // photos using it fall back to no LUT
    for (const p of st.photos) if (p.settings.lut && p.settings.lut.id === id) { p.settings.lut.id = ''; Cat().commit(p, 'LUT removed'); }
    Cat().scheduleSave(); events.emit('changed');
  }
  function rename(id, name) { const e = find(id); if (e) { e.name = name; Cat().scheduleSave(); events.emit('changed'); } }

  /** Save the current look of a photo as a 33³ .cube file. */
  async function exportLook(photo) {
    const s = P.normalizeSettings(photo.settings);
    const cube = s.lut.id ? await get(s.lut.id) : null;
    const src = PJ.Engine.cachedSource ? PJ.Engine.cachedSource(photo) : null;
    const text = P.lookLUT(s, 33, src && src.input, cube);
    const name = Cat().displayName(photo).replace(/\.[^.]+$/, '') + ' look.cube';
    const out = await API.saveTextFile(name, text, 'cube');
    if (out) UI.toast('Saved the look as a .cube LUT (texture, clarity, dehaze, effects and masks can’t be part of a LUT)', 'file-export');
  }

  global.PJ.LUTs = { list, find, get, getSync, importFiles, importTexts, remove, rename, exportLook, events, MAX_N };
})(window);
