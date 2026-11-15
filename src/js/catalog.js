/* =====================================================================
 * photos.jpeg — catalog: photos, metadata, edit history, snapshots,
 * virtual copies, collections, presets, persistence.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, UI = PJ.UI;

  /* Setting groups used by Copy/Paste, Sync and Presets */
  const GROUPS = [
    { key: 'wb', label: 'White Balance', fields: ['wbMode', 'temp', 'tint'] },
    { key: 'tone', label: 'Basic Tone', fields: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
    { key: 'presence', label: 'Presence', fields: ['texture', 'clarity', 'dehaze', 'vibrance', 'saturation'] },
    { key: 'curve', label: 'Tone Curve', fields: ['curve'] },
    { key: 'hsl', label: 'HSL / Color', fields: ['hsl'] },
    { key: 'bw', label: 'Black & White', fields: ['bw', 'bwMix'] },
    { key: 'grading', label: 'Color Grading', fields: ['grading'] },
    { key: 'detail', label: 'Detail', fields: ['detail'] },
    { key: 'lens', label: 'Lens Corrections', fields: ['lens'] },
    { key: 'transform', label: 'Transform', fields: ['transform'] },
    { key: 'effects', label: 'Effects', fields: ['effects'] },
    { key: 'calib', label: 'Calibration', fields: ['calib'] },
    { key: 'input', label: 'Video Input Profile', fields: ['input'] },
    { key: 'lut', label: 'LUT', fields: ['lut'] },
    { key: 'stab', label: 'Video Stabilization', fields: ['stab'] },
    { key: 'crop', label: 'Crop & Orientation', fields: ['geo'] },
    { key: 'masks', label: 'Masking', fields: ['masks'] },
    { key: 'spots', label: 'Spot Removal', fields: ['spots'] }
  ];
  const DEFAULT_SYNC = GROUPS.filter(g => !['crop', 'spots', 'masks', 'stab'].includes(g.key)).map(g => g.key);

  function pickGroups(settings, groups) {
    const out = {};
    for (const g of GROUPS) if (groups.includes(g.key)) for (const f of g.fields) out[f] = P.clone(settings[f]);
    return out;
  }
  function applyGroups(target, partial, groups) {
    const s = P.clone(target);
    for (const g of GROUPS) if (!groups || groups.includes(g.key)) for (const f of g.fields) if (partial[f] !== undefined) s[f] = P.clone(partial[f]);
    return P.normalizeSettings(s);
  }
  function groupsInPartial(partial) {
    return GROUPS.filter(g => g.fields.some(f => partial[f] !== undefined)).map(g => g.key);
  }

  /** Is any field of a group changed from defaults? */
  function groupEdited(s, key) {
    const d = P.defaultSettings();
    const g = GROUPS.find(x => x.key === key);
    return g.fields.some(f => JSON.stringify(s[f]) !== JSON.stringify(d[f]));
  }
  function isEdited(s) {
    const d = P.defaultSettings();
    return GROUPS.some(g => g.fields.some(f => JSON.stringify(s[f]) !== JSON.stringify(d[f])));
  }

  /* ---------------- Built-in presets ---------------- */
  const c = (pts) => pts;
  const BUILTIN_PRESETS = [
    { group: 'Color', name: 'Vivid Landscape', settings: { exposure: 0.15, contrast: 22, highlights: -35, shadows: 30, whites: 15, blacks: -12, temp: 6, vibrance: 38, saturation: 8, clarity: 15, dehaze: 8, effects: { vigAmount: -12 } } },
    { group: 'Color', name: 'Golden Hour Glow', settings: { exposure: 0.2, contrast: 12, highlights: -20, shadows: 28, temp: 30, tint: 8, vibrance: 28, grading: { highlights: { h: 40, s: 22, l: 0 }, shadows: { h: 25, s: 10, l: 0 }, midtones: { h: 0, s: 0, l: 0 }, global: { h: 0, s: 0, l: 0 }, blending: 60, balance: 10 }, effects: { vigAmount: -18 } } },
    { group: 'Color', name: 'Nordic Cold Slate', settings: { exposure: 0.05, contrast: 16, highlights: -30, shadows: 12, whites: -10, blacks: -15, temp: -30, tint: -6, vibrance: -18, saturation: -15, hsl: { hue: [0, 0, 0, 0, 0, -10, 0, 0], sat: [0, -20, -30, -30, 0, 0, 0, 0], lum: [0, 0, 0, -10, 0, -10, 0, 0] } } },
    { group: 'Color', name: 'Clean Bright', settings: { exposure: 0.3, contrast: 8, highlights: -25, shadows: 25, whites: 10, blacks: 5, vibrance: 15, texture: 8 } },
    { group: 'Creative', name: 'Cinematic Teal & Orange', settings: { exposure: -0.1, contrast: 25, highlights: -25, shadows: 15, blacks: -18, vibrance: 15, saturation: -8, hsl: { hue: [0, -8, -20, 40, 0, -15, 0, 0], sat: [0, 15, -20, -40, 10, 10, 0, 0], lum: [0, 5, 0, -20, 0, -10, 0, 0] }, grading: { shadows: { h: 195, s: 30, l: 0 }, highlights: { h: 35, s: 28, l: 0 }, midtones: { h: 0, s: 0, l: 0 }, global: { h: 0, s: 0, l: 0 }, blending: 55, balance: -5 }, effects: { vigAmount: -30, grain: 12 } } },
    { group: 'Creative', name: 'Moody Matte', settings: { exposure: -0.2, contrast: -12, highlights: -40, shadows: 20, whites: -18, blacks: 25, vibrance: -25, saturation: -15, curve: { rgb: c([[0, 0.09], [0.25, 0.22], [0.75, 0.78], [1, 0.94]]) }, effects: { vigAmount: -35, grain: 20 } } },
    { group: 'Creative', name: 'Faded Film', settings: { contrast: -10, highlights: -15, shadows: 15, temp: 6, saturation: -18, curve: { rgb: c([[0, 0.12], [0.5, 0.52], [1, 0.92]]), b: c([[0, 0.06], [1, 0.95]]) }, effects: { grain: 28, grainSize: 35, vigAmount: -15 } } },
    { group: 'Creative', name: 'Vintage Kodachrome', settings: { exposure: 0.1, contrast: 25, highlights: -10, shadows: -10, whites: 10, blacks: -15, temp: 18, tint: 6, vibrance: 15, saturation: 12, hsl: { hue: [5, 0, -10, 15, 0, -10, 0, 0], sat: [15, 10, 10, -10, 0, 15, 0, 0], lum: [0, 0, 0, 0, 0, -10, 0, 0] }, effects: { vigAmount: -40, grain: 25 } } },
    { group: 'Creative', name: 'Cross Process', settings: { contrast: 20, curve: { r: c([[0, 0], [0.25, 0.18], [0.75, 0.84], [1, 1]]), g: c([[0, 0.02], [0.5, 0.55], [1, 1]]), b: c([[0, 0.12], [0.5, 0.45], [1, 0.85]]) }, saturation: 10, effects: { vigAmount: -20 } } },
    { group: 'B&W', name: 'Fine Art B&W', settings: { bw: true, exposure: 0.1, contrast: 40, highlights: -15, shadows: -10, whites: 28, blacks: -28, clarity: 20, bwMix: [-10, -15, -5, -20, -30, -20, 0, 0], effects: { vigAmount: -30, grain: 25 } } },
    { group: 'B&W', name: 'High Contrast Noir', settings: { bw: true, contrast: 65, highlights: -30, shadows: -25, whites: 30, blacks: -40, clarity: 35, bwMix: [10, 10, 0, -30, -40, -50, 0, 0], effects: { vigAmount: -45, grain: 30 } } },
    { group: 'B&W', name: 'Soft Silver', settings: { bw: true, contrast: -10, highlights: -30, shadows: 30, whites: 10, texture: -10, grading: { global: { h: 210, s: 8, l: 0 }, shadows: { h: 0, s: 0, l: 0 }, midtones: { h: 0, s: 0, l: 0 }, highlights: { h: 0, s: 0, l: 0 }, blending: 50, balance: 0 } } },
    { group: 'B&W', name: 'Sepia Tone', settings: { bw: true, contrast: 10, grading: { global: { h: 35, s: 30, l: 0 }, shadows: { h: 25, s: 15, l: 0 }, midtones: { h: 0, s: 0, l: 0 }, highlights: { h: 0, s: 0, l: 0 }, blending: 50, balance: 0 }, effects: { vigAmount: -25 } } },
    { group: 'Portrait', name: 'Soft Dreamy Portrait', settings: { exposure: 0.2, contrast: -15, highlights: -25, shadows: 30, whites: 10, temp: 8, tint: 5, texture: -25, clarity: -12, vibrance: 10, saturation: -5, hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, -8, 0, 0, 0, 0, 0, 0], lum: [0, 12, 0, 0, 0, 0, 0, 0] } } },
    { group: 'Portrait', name: 'Natural Skin', settings: { contrast: 5, highlights: -15, shadows: 15, texture: -12, hsl: { hue: [4, 3, 0, 0, 0, 0, 0, 0], sat: [-6, -10, 0, 0, 0, 0, 0, 0], lum: [2, 10, 0, 0, 0, 0, 0, 0] }, detail: { sharpen: 30, radius: 1, detail: 15, masking: 50, nrLuma: 0, nrDetail: 50, nrColor: 25 } } },
    { group: 'Portrait', name: 'High-Key Studio', settings: { exposure: 0.6, contrast: 15, highlights: 20, shadows: 40, whites: 35, blacks: -10, saturation: -12 } },
    { group: 'Detail', name: 'Sharpen — Landscape', settings: { detail: { sharpen: 60, radius: 1.0, detail: 40, masking: 20, nrLuma: 0, nrDetail: 50, nrColor: 25 } } },
    { group: 'Detail', name: 'Sharpen — Portrait', settings: { detail: { sharpen: 35, radius: 1.4, detail: 15, masking: 60, nrLuma: 0, nrDetail: 50, nrColor: 25 } } },
    { group: 'Detail', name: 'Noise — High ISO', settings: { detail: { sharpen: 25, radius: 1.0, detail: 20, masking: 30, nrLuma: 45, nrDetail: 50, nrColor: 50 } } },
    { group: 'Effects', name: 'Vignette — Subtle', settings: { effects: { vigAmount: -20, vigMid: 50, vigRound: 0, vigFeather: 60, vigHighlights: 0, grain: 0, grainSize: 25, grainRough: 50 } } },
    { group: 'Effects', name: 'Grain — Film', settings: { effects: { vigAmount: 0, vigMid: 50, vigRound: 0, vigFeather: 50, vigHighlights: 0, grain: 35, grainSize: 30, grainRough: 60 } } }
  ].map((p, i) => ({ id: 'builtin-' + i, builtin: true, ...p }));

  /** Normalize a preset's partial settings (deep-merge onto defaults only for the groups it touches). */
  function presetPartial(preset) {
    const full = P.normalizeSettings(preset.settings);
    const groups = preset.groups || groupsInPartial(preset.settings);
    return { partial: pickGroups(full, groups), groups };
  }

  /* ---------------- Catalog state ---------------- */
  const events = UI.emitter();
  const state = {
    photos: [],
    byId: new Map(),
    collections: [],
    userPresets: [],
    exportPresets: [],
    luts: [],
    people: [],          // named people (faces.js): [{ id, name }]
    prefs: {},
    loaded: false
  };
  let saveTimer = null;

  function uid(prefix) { return (prefix || 'p') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /*
   * Settings are saved sparse — only what differs from the defaults (normalizeSettings fills the
   * rest back in on load). An unedited photo's settings and history then cost a few bytes instead
   * of ~2 KB each, which keeps 50k-photo catalogs small and quick to save.
   */
  const DEF = P.defaultSettings();
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  function sparse(s, d) {
    const o = {};
    for (const k of Object.keys(s)) {
      const v = s[k], dv = d ? d[k] : undefined;
      if (v === dv) continue;
      if (isObj(v) && isObj(dv)) { const sub = sparse(v, dv); if (Object.keys(sub).length) o[k] = sub; }
      else if (Array.isArray(v) && Array.isArray(dv) && JSON.stringify(v) === JSON.stringify(dv)) continue;
      else o[k] = v;
    }
    return o;
  }
  const sparseCache = new WeakMap(); // history / snapshot entries don't change once written
  function sparseEntry(e) {
    let c = sparseCache.get(e);
    if (!c || c.src !== e.settings) { c = { src: e.settings, out: { ...e, settings: sparse(e.settings, DEF) } }; sparseCache.set(e, c); }
    return c.out;
  }
  function serialize() {
    return {
      app: 'photos.jpeg', version: VERSION, savedAt: new Date().toISOString(),
      photos: state.photos.map(p => {
        const o = { ...p };
        delete o._thumbUrl; delete o._busy; delete o._thumbRetry;
        o.settings = sparse(p.settings, DEF);
        o.history = p.history.map(sparseEntry);
        if (p.snapshots && p.snapshots.length) o.snapshots = p.snapshots.map(sparseEntry);
        return o;
      }),
      collections: state.collections,
      userPresets: state.userPresets,
      exportPresets: state.exportPresets,
      luts: state.luts,
      people: state.people,
      prefs: state.prefs
    };
  }
  /** The catalog format this version reads and writes. A catalog with a higher number comes from a
      newer app and is opened read-only: saving it from here would drop what this version doesn't know. */
  const VERSION = 3;
  function scheduleSave() {
    if (state.newer) return;
    clearTimeout(saveTimer);
    // big catalogs take a few hundred ms to serialize; batch their saves a little more
    saveTimer = setTimeout(save, state.photos.length > 10000 ? 2500 : 900);
  }
  async function save() {
    clearTimeout(saveTimer); saveTimer = null;
    if (state.newer) return;
    try { await PJ.API.saveCatalog(serialize()); } catch (e) { console.error('catalog save failed', e); }
  }
  async function load() {
    const data = await PJ.API.loadCatalog();
    if (data && +data.version > VERSION) state.newer = +data.version;
    if (data && Array.isArray(data.photos)) {
      state.photos = data.photos.map(p => ({ ...p, settings: P.normalizeSettings(p.settings) }));
      state.collections = data.collections || [];
      state.userPresets = data.userPresets || [];
      state.exportPresets = data.exportPresets || [];
      state.luts = data.luts || [];
      state.people = data.people || [];
      state.prefs = data.prefs || {};
      if (!PJ.API.isDesktop) state.photos.forEach(p => { p.missing = true; });
    }
    state.byId = new Map(state.photos.map(p => [p.id, p]));
    state.loaded = true;
    events.emit('loaded');
  }

  function newPhoto(desc) {
    const settings = P.defaultSettings();
    const isVid = !!desc.cdng || PJ.Decode.isVideo(desc.name);
    return {
      id: uid('ph_'), path: desc.path, name: desc.name, folder: desc.folder || PJ.API.dirname(desc.path) || '',
      size: desc.size || 0, mtime: desc.mtime || 0, importedAt: new Date().toISOString(),
      captureTime: null, width: 0, height: 0, isRaw: PJ.Decode.isRaw(desc.name), format: PJ.Decode.ext(desc.name).toUpperCase(),
      exif: {}, rating: 0, flag: 0, label: '', title: '', caption: '', keywords: [],
      settings, history: [{ label: 'Import', settings: P.clone(settings), t: Date.now() }], historyIndex: 0,
      snapshots: [], virtualOf: null, copyName: '', thumbV: 0, edited: false, missing: false,
      ...(!isVid && pref('raw.wide', true) !== false ? { wide: true } : {}),      // matters only when the source holds Display P3 (RAW, phone photos)
      ...(desc.sidecar ? { sidecar: desc.sidecar } : {}),
      ...(isVid ? { kind: 'video', isRaw: !!desc.cdng || PJ.Decode.isRawVideo(desc.name), video: desc.cdng ? { cdng: desc.cdng } : {}, videoTime: null } : { kind: 'photo' })
    };
  }

  /** Add file descriptors; returns the newly created photos (duplicates by path are skipped). */
  function addPhotos(descs) {
    const existing = new Set(state.photos.filter(p => !p.virtualOf).map(p => p.path));
    const added = [];
    for (const d of descs) {
      if (existing.has(d.path)) continue;
      existing.add(d.path);
      const p = newPhoto(d);
      state.photos.push(p);
      state.byId.set(p.id, p);
      added.push(p);
    }
    if (added.length) { scheduleSave(); events.emit('changed', { type: 'add', ids: added.map(p => p.id) }); }
    return added;
  }

  function removePhotos(ids) {
    const set = new Set(ids);
    // Removing a master also removes its virtual copies
    state.photos.forEach(p => { if (p.virtualOf && set.has(p.virtualOf)) set.add(p.id); });
    state.photos = state.photos.filter(p => !set.has(p.id));
    set.forEach(id => { state.byId.delete(id); PJ.API.deleteThumb(id).catch(() => { }); });
    state.collections.forEach(c => { c.photoIds = c.photoIds.filter(id => !set.has(id)); });
    scheduleSave();
    events.emit('changed', { type: 'remove', ids: [...set] });
    return [...set];
  }

  function virtualCopy(photo) {
    const n = state.photos.filter(p => p.virtualOf === (photo.virtualOf || photo.id)).length + 1;
    const v = P.clone(photo);
    v.id = uid('vc_');
    v.virtualOf = photo.virtualOf || photo.id;
    v.copyName = `Copy ${n}`;
    v.history = [{ label: 'Virtual Copy', settings: P.clone(photo.settings), t: Date.now() }];
    v.historyIndex = 0;
    v.snapshots = [];
    v.thumbV = 0;
    if (v.video) v.video = Object.assign({}, photo.video); // trims are per copy
    const idx = state.photos.indexOf(photo);
    state.photos.splice(idx + 1, 0, v);
    state.byId.set(v.id, v);
    scheduleSave();
    events.emit('changed', { type: 'add', ids: [v.id] });
    return v;
  }

  /* ---------------- Editing & history ---------------- */
  /** Commit current settings (already mutated) as a history step. */
  function commit(photo, label) {
    // Animated clips: an edit made at the playhead goes into the keyframe there (auto-key)
    if (photo.kind === 'video' && PJ.Keyframes && PJ.Keyframes.count(photo.settings) && !/^Keyframe/.test(label || '')) {
      const pl = PJ.Video && PJ.Video.player;
      const t = pl && pl.photo === photo ? pl.t : (photo.videoTime || 0);
      PJ.Keyframes.capture(photo, t, (photo.video && photo.video.fps) || (pl && pl.clip && pl.clip.fps) || 30);
    }
    photo.history = photo.history.slice(0, photo.historyIndex + 1);
    const last = photo.history[photo.history.length - 1];
    const snap = P.clone(photo.settings);
    if (last && JSON.stringify(P.normalizeSettings(last.settings)) === JSON.stringify(snap)) return;
    photo.history.push({ label, settings: snap, t: Date.now() });
    if (photo.history.length > 80) photo.history.splice(1, photo.history.length - 80);
    photo.historyIndex = photo.history.length - 1;
    photo.edited = isEdited(photo.settings);
    scheduleSave();
    events.emit('edited', photo, label);
  }
  function setSettings(photo, settings, label) {
    photo.settings = P.normalizeSettings(settings);
    commit(photo, label);
  }
  function gotoHistory(photo, idx) {
    if (idx < 0 || idx >= photo.history.length) return;
    photo.historyIndex = idx;
    photo.settings = P.normalizeSettings(P.clone(photo.history[idx].settings));
    photo.edited = isEdited(photo.settings);
    scheduleSave();
    events.emit('edited', photo, 'history');
  }
  const undo = (p) => { if (p && p.historyIndex > 0) { gotoHistory(p, p.historyIndex - 1); return true; } return false; };
  const redo = (p) => { if (p && p.historyIndex < p.history.length - 1) { gotoHistory(p, p.historyIndex + 1); return true; } return false; };
  function clearHistory(photo) {
    photo.history = [{ label: 'History cleared', settings: P.clone(photo.settings), t: Date.now() }];
    photo.historyIndex = 0;
    scheduleSave();
    events.emit('edited', photo, 'history');
  }

  function setMeta(photos, patch) {
    for (const p of photos) Object.assign(p, patch);
    scheduleSave();
    events.emit('meta', photos, patch);
  }

  /* ---------------- Collections ---------------- */
  /** A collection lists its photos; a smart collection has a rule instead and finds them each time. */
  function addCollection(name, ids, rule) {
    const c = { id: uid('col_'), name, photoIds: [...new Set(ids || [])] };
    if (rule) c.rule = rule;
    state.collections.push(c);
    scheduleSave(); events.emit('collections');
    return c;
  }
  function removeCollection(id) {
    state.collections = state.collections.filter(c => c.id !== id);
    scheduleSave(); events.emit('collections');
  }
  function addToCollection(id, ids) {
    const c = state.collections.find(x => x.id === id);
    if (!c || c.rule) return;
    c.photoIds = [...new Set([...c.photoIds, ...ids])];
    scheduleSave(); events.emit('collections');
  }
  function clearCollection(id) {
    const c = state.collections.find(x => x.id === id);
    if (!c) return 0;
    const n = c.photoIds.length;
    c.photoIds = [];
    scheduleSave(); events.emit('collections');
    return n;
  }
  function removeFromCollection(id, ids) {
    const c = state.collections.find(x => x.id === id);
    if (!c) return;
    const s = new Set(ids);
    c.photoIds = c.photoIds.filter(x => !s.has(x));
    scheduleSave(); events.emit('collections');
  }

  /* ---------------- Presets ---------------- */
  function allPresets() { return BUILTIN_PRESETS.concat(state.userPresets); }
  function addUserPreset(name, group, partial, groups) {
    const p = { id: uid('pre_'), name, group: group || 'User Presets', settings: partial, groups };
    state.userPresets.push(p);
    scheduleSave(); events.emit('presets');
    return p;
  }
  function removeUserPreset(id) {
    state.userPresets = state.userPresets.filter(p => p.id !== id);
    scheduleSave(); events.emit('presets');
  }
  function renameUserPreset(id, name) {
    const p = state.userPresets.find(x => x.id === id);
    if (p) { p.name = name; scheduleSave(); events.emit('presets'); }
  }

  function setPref(k, v) { state.prefs[k] = v; scheduleSave(); }
  function pref(k, def) { return state.prefs[k] === undefined ? def : state.prefs[k]; }

  /* ---------------- Queries ---------------- */
  function displayName(p) { return p.copyName ? `${p.name} (${p.copyName})` : p.name; }
  function folders() {
    const m = new Map();
    for (const p of state.photos) m.set(p.folder || '(none)', (m.get(p.folder || '(none)') || 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  global.PJ.Catalog = {
    state, events, GROUPS, DEFAULT_SYNC, BUILTIN_PRESETS,
    load, save, scheduleSave, addPhotos, removePhotos, virtualCopy,
    commit, setSettings, gotoHistory, undo, redo, clearHistory, setMeta,
    addCollection, removeCollection, addToCollection, removeFromCollection, clearCollection,
    allPresets, addUserPreset, removeUserPreset, renameUserPreset, presetPartial,
    pickGroups, applyGroups, groupsInPartial, groupEdited, isEdited,
    setPref, pref, displayName, folders, uid,
    get: (id) => state.byId.get(id)
  };
})(window);
