/* =====================================================================
 * photos.jpeg — application shell: modules, selection, filmstrip,
 * import, keyboard shortcuts, menus, copy/paste/sync, slideshow.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, UI = PJ.UI, Cat = PJ.Catalog, E = PJ.Engine, API = PJ.API;
  const { h, icon, $ } = UI;

  const app = {};
  global.PJ.App = app;

  let module = 'library';
  let sel = new Set();
  let active = null;
  let anchor = null;
  let visibleList = [];
  let clipboard = null;

  const els = {
    left: $('#left'), right: $('#right'), main: $('#main'), appEl: $('#app'),
    top: $('#toolbar-top'), bottom: $('#toolbar-bottom'),
    grid: $('#library-view'), viewerEl: $('#viewer'), empty: $('#empty'),
    filmHead: $('#film-head'), film: $('#film-strip')
  };
  if (API.touch || (window.matchMedia && matchMedia('(pointer: coarse)').matches)) document.body.classList.add('touch');

  /* ---------------- drawers (small screens) ---------------- */
  function toggleDrawer(side, force) {
    const cls = side === 'left' ? 'open-left' : 'open-right';
    const other = side === 'left' ? 'open-right' : 'open-left';
    const on = force === undefined ? !els.main.classList.contains(cls) : force;
    els.main.classList.remove(other);
    els.main.classList.toggle(cls, on);
    if (on && module === 'develop') setTimeout(() => develop.drawNavigator(), 250);
  }
  function closeDrawers() { els.main.classList.remove('open-left', 'open-right'); }
  (function addDrawerButtons() {
    const topbar = $('#topbar');
    const l = h('button', { class: 'btn ghost icon drawer-btn', title: 'Panels' }, icon('bars'));
    const r = h('button', { class: 'btn ghost icon drawer-btn', title: 'Adjustments' }, icon('sliders'));
    l.addEventListener('click', () => toggleDrawer('left'));
    r.addEventListener('click', () => toggleDrawer('right'));
    topbar.insertBefore(l, topbar.firstChild);
    topbar.appendChild(r);
    $('#stage').addEventListener('pointerdown', () => closeDrawers(), true);
  })();

  /** Android back button / Escape-like navigation. Returns true when something was closed. */
  function back() {
    if (UI.hasModal()) { UI.topModal().close(); return true; }
    const ss = document.getElementById('slideshow');
    if (ss) { ss.click(); return true; }
    if (els.main.classList.contains('open-left') || els.main.classList.contains('open-right')) { closeDrawers(); return true; }
    if (module === 'develop') {
      if (viewer.st.tool === 'crop') { viewer.cancelCrop(); return true; }
      if (viewer.st.tool !== 'none') { viewer.setTool('none'); return true; }
      if (viewer.st.zoom !== 'fit') { viewer.setZoom('fit'); return true; }
      setModule('library');
      return true;
    }
    return false;
  }

  /* ---------------- modules ---------------- */
  let library, develop, viewer;

  function setModule(m) {
    if (m === 'map') { library.view.mode = 'map'; Cat.setPref('lib.mode', 'map'); m = 'library'; }
    if (m === 'develop' && !activePhoto()) {
      const first = visibleList[0];
      if (!first) { UI.toast('Import photos first', 'circle-info'); return; }
      setActive(first.id, true);
    }
    if (module === 'develop' && m !== 'develop' && viewer.st.tool === 'crop') viewer.setTool('none');
    module = m;
    closeDrawers();
    const isMap = m === 'library' && library.view.mode === 'map';
    document.querySelectorAll('.modules button').forEach(b => b.classList.toggle('on', b.dataset.module === (isMap ? 'map' : m)));
    const lib = m === 'library';
    els.left.replaceChildren(lib ? library.left : develop.left);
    els.right.replaceChildren(lib ? library.right : develop.right);
    els.top.replaceChildren(lib ? library.topbar : develop.topbar);
    els.bottom.replaceChildren(lib ? library.bottombar : develop.bottombar);
    library.showStage(lib && Cat.state.photos.length);
    els.empty.classList.toggle('hidden', !!Cat.state.photos.length || !lib);
    els.viewerEl.classList.toggle('hidden', lib);
    if (lib && PJ.Video.player.playing) PJ.Video.player.pause();
    if (!lib) {
      const p = activePhoto();
      if (viewer.st.photo !== p) { viewer.setPhoto(p); develop.setPhoto(p); }
      else { viewer.draw(); develop.syncAll(); }
      setTimeout(() => develop.drawNavigator(), 30);
    } else {
      library.render();
      setTimeout(() => library.scrollToActive(), 0);
    }
    renderFilmstrip();
    updateTitle();
  }

  /* ---------------- selection ---------------- */
  function activePhoto() { return active ? Cat.get(active) : null; }
  function selectedPhotos() { return [...sel].map(id => Cat.get(id)).filter(Boolean); }
  function targets() { const s = selectedPhotos(); if (s.length) return s; const a = activePhoto(); return a ? [a] : []; }
  function setActive(id, keepSel) {
    active = id;
    if (!keepSel || !sel.has(id)) { sel = new Set(id ? [id] : []); }
    anchor = id;
    onSelectionChanged();
  }
  function onSelectionChanged() {
    if (module === 'develop') {
      const p = activePhoto();
      if (p && viewer.st.photo !== p) { viewer.setPhoto(p); develop.setPhoto(p); }
    } else library.updateSelection();
    renderFilmstripSelection();
    updateTitle();
  }
  function clickSelect(id, e) {
    if (e.shiftKey && anchor) {
      const ids = visibleList.map(p => p.id);
      const a = ids.indexOf(anchor), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [s, t] = a < b ? [a, b] : [b, a];
        if (!(e.ctrlKey || e.metaKey)) sel = new Set();
        ids.slice(s, t + 1).forEach(x => sel.add(x));
        active = id;
        onSelectionChanged();
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      if (sel.has(id)) { sel.delete(id); if (active === id) active = [...sel][0] || null; }
      else { sel.add(id); active = id; }
      anchor = id;
      onSelectionChanged();
      return;
    }
    if (sel.has(id) && sel.size > 1 && module === 'develop') { active = id; onSelectionChanged(); return; }
    setActive(id);
  }
  function step(delta) {
    if (!visibleList.length) return;
    let i = visibleList.findIndex(p => p.id === active);
    i = i < 0 ? 0 : Math.max(0, Math.min(visibleList.length - 1, i + delta));
    setActive(visibleList[i].id);
    if (module === 'library') library.scrollToActive();
    scrollFilmToActive();
  }
  function gridColumns() { return library.columns(); }
  /** Select a set of photos (e.g. a map cluster); the first becomes active. */
  function selectIds(ids) {
    const ok = ids.filter(id => Cat.get(id));
    if (!ok.length) return;
    sel = new Set(ok);
    if (!sel.has(active)) active = ok[0];
    anchor = active;
    onSelectionChanged();
  }

  /* ---------------- refresh ---------------- */
  function refresh() {
    visibleList = library.visible();
    if (active && !Cat.get(active)) active = null;
    sel = new Set([...sel].filter(id => Cat.get(id)));
    if (module === 'library') {
      library.showStage(Cat.state.photos.length);
      els.empty.classList.toggle('hidden', !!Cat.state.photos.length);
      library.render();
    }
    renderFilmstrip();
    updateTitle();
  }
  function updateTitle() {
    const p = activePhoto();
    document.title = p ? `${Cat.displayName(p)} — photos.jpeg` : 'photos.jpeg';
    if (p) API.setRepresentedFile(p.path);
  }

  /* ---------------- filmstrip ---------------- */
  let vfilm = null;
  function renderFilmstrip() {
    if (!vfilm) vfilm = PJ.Virtual.strip(els.film, { pad: 10, gap: 6, key: (p) => p.id, make: thumbEl });
    vfilm.set(visibleList, true);
    renderFilmstripSelection();
  }
  function thumbEl(p) {
    const url = p.thumbV || !API.hasThumbStore ? API.thumbUrl(p.id, p.thumbV) : '';
    const t = h('div', { class: `thumb${p.flag === -1 ? ' rejected' : ''}${sel.has(p.id) ? ' sel' : ''}${p.id === active ? ' active' : ''}`, title: Cat.displayName(p), dataset: { id: p.id } },
      url ? h('img', { src: url, draggable: 'false' }) : icon(p.missing ? 'triangle-exclamation' : 'image', 'muted'),
      p.rating ? h('span', { class: 'tb' }, '★'.repeat(p.rating)) : null,
      p.flag === 1 ? h('span', { class: 'tf' }, icon('flag')) : p.flag === -1 ? h('span', { class: 'tf', style: { color: 'var(--red)' } }, icon('ban')) : null,
      p.label ? h('span', { class: `tl lbl-${p.label}` }) : null);
    t.addEventListener('mousedown', (e) => { if (e.button === 0) clickSelect(p.id, e); });
    t.addEventListener('dblclick', () => openDevelop(p.id));
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!sel.has(p.id)) clickSelect(p.id, {}); photoMenu(e.clientX, e.clientY); });
    return t;
  }
  function renderFilmHead() {
    const src = library.view.source;
    const srcName = src === 'all' ? 'All Photographs' : src === 'recent' ? 'Previous Import' : src === 'edited' ? 'Edited' : src === 'picks' ? 'Picks' : src === 'rejected' ? 'Rejected' : src === 'missing' ? 'Missing' :
      src.startsWith('folder:') ? src.slice(7).split(/[\\/]/).pop() : src.startsWith('col:') ? ((Cat.state.collections.find(c => 'col:' + c.id === src) || {}).name || 'Collection') : src;
    els.filmHead.replaceChildren(
      h('b', null, srcName), h('span', null, `${visibleList.length} photos`),
      sel.size > 1 ? h('span', null, `${sel.size} selected`) : null,
      activePhoto() ? h('span', { class: 'mono' }, Cat.displayName(activePhoto())) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, API.touch ? 'Tap to select · double-tap to open' : 'G Library · D Develop · ←/→ navigate · ? shortcuts'));
  }
  function renderFilmstripSelection() {
    renderFilmHead();
    if (vfilm) vfilm.forEachLive((id, t) => { t.classList.toggle('sel', sel.has(id)); t.classList.toggle('active', id === active); });
    scrollFilmToActive();
  }
  function scrollFilmToActive() { if (vfilm && active) vfilm.scrollToIndex(visibleList.findIndex(p => p.id === active)); }
  function updateFilmThumb(p) { if (vfilm) vfilm.refresh(p); }
  els.film.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { els.film.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

  /* ---------------- import ---------------- */
  async function importDescs(descs) {
    let supported = descs.filter(d => PJ.Decode.isSupported(d.name));
    if (PJ.CDNG) supported = await PJ.CDNG.groupSequences(supported);
    if (!supported.length) { UI.toast('No supported images found', 'triangle-exclamation'); return []; }
    const added = Cat.addPhotos(supported);
    const dup = supported.length - added.length;
    if (!added.length) { UI.toast(`All ${dup} photo(s) are already in the catalog`, 'circle-info'); return []; }
    if (Cat.pref('lens.autoProfile', false)) added.forEach(p => { if (p.kind !== 'video') p.autoLens = true; });
    if (Cat.pref('nr.autoIso', false)) added.forEach(p => { if (p.kind !== 'video') p.autoNr = true; });
    library.setLastImport(added.map(p => p.id));
    // once faces are in use, new photos are looked through as they arrive (in the background)
    if (PJ.Faces && Cat.pref('faces.auto', false)) PJ.Faces.scan(added).catch(() => { });
    library.setSource('recent');
    refresh();
    setActive(added[0].id);
    added.forEach(p => E.queueThumb(p));
    UI.toast(`Imported ${added.length} photo${added.length > 1 ? 's' : ''}${dup ? ` (${dup} duplicate${dup > 1 ? 's' : ''} skipped)` : ''}`);
    if (Cat.pref('xmp.readOnImport', true)) xmpRead(added, true);
    return added;
  }
  /* ---------------- Import and Organize ----------------
   * Copies (or moves) new photos into a folder of your choice — in dated subfolders, renamed
   * from a pattern — and adds the copies to the catalog, the way a card import works. */
  const ORG_FOLDERS = [['none', 'No subfolders'], ['y', '2026'], ['ym', '2026 / 2026-10'], ['ymd', '2026 / 2026-10-31'], ['ymd-flat', '2026-10-31']];
  const ORG_NAMES = [['keep', 'Keep the file names'], ['date-seq', 'Date + number  (20261031-0001)'], ['date-name', 'Date + original name  (2026-10-31_DSC2175)'], ['custom', 'Custom text + number  (Trip-0001)']];
  /** Capture date of a file about to be imported: EXIF when the header has it, else the file date. */
  async function captureDateOf(desc) {
    try {
      if (!PJ.Decode.isVideo(desc.name) && API.readRange) {
        const head = await API.readRange(desc.path, 0, 1 << 19);
        const ex = PJ.Decode.parseExif(head);
        if (ex && ex.captureTime) { const d = new Date(ex.captureTime); if (!isNaN(d)) return d; }
      }
    } catch (_) { /* no readable EXIF: use the file date */ }
    return new Date(desc.mtime || Date.now());
  }
  function organizedPlace(desc, date, seq, o) {
    const p2 = (n) => String(n).padStart(2, '0');
    const y = String(date.getFullYear()), m = p2(date.getMonth() + 1), d = p2(date.getDate());
    const sub = { none: [], y: [y], ym: [y, `${y}-${m}`], ymd: [y, `${y}-${m}-${d}`], 'ymd-flat': [`${y}-${m}-${d}`] }[o.folders] || [];
    const stem = desc.name.replace(/\.[^.]+$/, ''), num = String(seq).padStart(4, '0');
    const custom = (o.custom || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Photo';
    const name = { keep: stem, 'date-seq': `${y}${m}${d}-${num}`, 'date-name': `${y}-${m}-${d}_${stem}`, custom: `${custom}-${num}` }[o.names] || stem;
    return { dir: API.joinPath(o.dest, ...sub), name, shown: [...sub, name + desc.name.slice(stem.length)].join(' / ') };
  }
  async function importOrganize(fromFolder) {
    if (!API.importFile) return UI.toast('Import and Organize is available in the Windows app', 'circle-info');
    const o = Object.assign({ dest: '', folders: 'ymd', names: 'keep', custom: '', move: false }, Cat.pref('import.organize', {}));
    let descs = [];
    const count = h('span', { class: 'muted' }, 'Nothing chosen yet');
    const destLabel = h('span', { class: 'muted', style: { wordBreak: 'break-all' } }, o.dest || 'Choose where the photos should go');
    const example = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '8px' } });
    const customIn = h('input', { type: 'text', value: o.custom, placeholder: 'Trip', style: { width: '100%' } });
    const refresh = () => {
      count.textContent = descs.length ? `${descs.length} file${descs.length === 1 ? '' : 's'} chosen` : 'Nothing chosen yet';
      destLabel.textContent = o.dest || 'Choose where the photos should go';
      customRow.style.display = o.names === 'custom' ? '' : 'none';
      const sample = descs[0] || { name: '_DSC2175.NEF' };
      example.textContent = o.dest ? 'Example: ' + organizedPlace(sample, new Date(sample.mtime || Date.now()), 1, o).shown : '';
      goBtn.disabled = !(descs.length && o.dest);
    };
    const pick = (opts, key) => { const s = h('select', null, opts.map(([v, l]) => h('option', { value: v }, l))); s.value = o[key]; s.addEventListener('change', () => { o[key] = s.value; refresh(); }); return s; };
    const field = (label, el) => h('label', { class: 'field' }, h('span', null, label), el);
    const customRow = field('Text', customIn);
    customIn.addEventListener('input', () => { o.custom = customIn.value; refresh(); });
    const supported = async (list) => { let s = (list || []).filter(d => PJ.Decode.isSupported(d.name)); if (PJ.CDNG) s = await PJ.CDNG.groupSequences(s); return s; };
    const body = h('div', null,
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '10px' } },
        h('button', { class: 'btn', onclick: async () => { descs = await supported(await API.openFiles()); refresh(); } }, icon('file-image'), 'Choose files…'),
        h('button', { class: 'btn', onclick: async () => { const r = await API.openFolder(); descs = await supported(r && r.files); refresh(); } }, icon('folder-open'), 'Choose folder…'),
        count),
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '10px' } },
        h('button', { class: 'btn', onclick: async () => { const d = await API.chooseDirectory(o.dest); if (d) { o.dest = d; refresh(); } } }, icon('folder'), 'Destination…'),
        destLabel),
      field('Subfolders by capture date', pick(ORG_FOLDERS, 'folders')),
      field('File names', pick(ORG_NAMES, 'names')),
      customRow,
      field('Originals', pick([['false', 'Copy — leave the originals where they are'], ['true', 'Move — the originals are removed from where they were']], 'move')),
      example);
    const m = UI.modal({
      title: 'Import and Organize', icon: 'folder-tree', body,
      buttons: [{ label: 'Cancel' }, { label: 'Import', primary: true, onClick: () => { run(); } }]
    });
    const goBtn = m.footer.querySelector('.btn.primary');
    o.move = String(o.move);
    refresh();
    // opened for a camera card: its photos are already chosen
    if (typeof fromFolder === 'string' && fromFolder) { count.textContent = 'Looking at the card…'; descs = await supported(await API.scanPaths([fromFolder])); refresh(); }

    async function run() {
      const opts = { ...o, move: o.move === 'true' || o.move === true };
      Cat.setPref('import.organize', { dest: opts.dest, folders: opts.folders, names: opts.names, custom: opts.custom, move: opts.move });
      // CinemaDNG sequences are folders of numbered frames: they are imported where they are
      const inPlace = descs.filter(d => d.cdng), files = descs.filter(d => !d.cdng);
      const bar = h('div', { class: 'progress' }, h('i'));
      const label = h('div', { class: 'muted', style: { marginBottom: '8px' } }, 'Reading capture dates…');
      let cancelled = false;
      const pm = UI.modal({ title: opts.move ? 'Moving photos' : 'Copying photos', icon: 'folder-tree', body: h('div', null, label, bar), sticky: true, buttons: [{ label: 'Cancel', onClick: () => { cancelled = true; } }] });
      const dated = [];
      for (const d of files) { if (cancelled) break; dated.push({ d, date: await captureDateOf(d) }); }
      dated.sort((a, b) => a.date - b.date || a.d.name.localeCompare(b.d.name, undefined, { numeric: true }));
      const placed = [], failed = [];
      for (let i = 0; i < dated.length && !cancelled; i++) {
        const { d, date } = dated[i];
        const where = organizedPlace(d, date, i + 1, opts);
        label.textContent = `${i + 1} / ${dated.length} — ${d.name}`;
        bar.firstChild.style.width = Math.round((i + 1) / dated.length * 100) + '%';
        try { placed.push(await API.importFile(d.path, where.dir, where.name, opts.move)); }
        catch (e) { failed.push({ name: d.name, error: String(e.message || e) }); if (failed.length === 1 && /Windows blocked/.test(failed[0].error)) break; }
      }
      pm.close();
      const newDescs = placed.length ? await API.scanPaths(placed) : [];
      if (newDescs.length || inPlace.length) await importDescs(newDescs.concat(inPlace));
      if (failed.length) {
        UI.modal({
          title: 'Some files were not imported', icon: 'triangle-exclamation',
          body: h('div', null, h('p', null, `${placed.length} imported, ${failed.length} failed${cancelled ? ' (cancelled)' : ''}.`),
            failed.every(f => f.error === failed[0].error)
              ? h('p', { style: { color: 'var(--text-2)' } }, failed[0].error)
              : h('ul', { style: { color: 'var(--text-2)', paddingLeft: '18px' } }, failed.slice(0, 30).map(f => h('li', null, `${f.name} — ${f.error}`))))
        });
      }
    }
  }
  app.importOrganize = importOrganize;

  app.importFiles = async () => { const d = await API.openFiles(); if (d && d.length) importDescs(d); };
  app.importFolder = async () => { const r = await API.openFolder(); if (r && r.files && r.files.length) importDescs(r.files); else if (r && r.folder) UI.toast('No supported images in that folder', 'circle-info'); };
  app.syncFolder = async (folder) => {
    const descs = await API.scanPaths([folder]);
    let found = descs.filter(d => PJ.Decode.isSupported(d.name));
    if (PJ.CDNG) found = await PJ.CDNG.groupSequences(found);
    const added = Cat.addPhotos(found);
    added.forEach(p => E.queueThumb(p));
    refresh();
    UI.toast(added.length ? `Found ${added.length} new photo(s)` : 'Folder is up to date');
  };

  // Drag & drop
  let dragDepth = 0;
  const dropEl = $('#drop');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; dropEl.classList.remove('hidden'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; dropEl.classList.add('hidden');
    const files = Array.from(e.dataTransfer.files || []);
    if (API.isDesktop) {
      const paths = files.map(f => API.getPathForFile(f)).filter(Boolean);
      const descs = API.dropFiles ? await API.dropFiles(files) : await API.scanPaths(paths);
      importDescs(descs);
    } else {
      if (API.keepSidecars) API.keepSidecars(files);
      importDescs(files.filter(f => PJ.Decode.isSupported(f.name)).map(f => API.describeFile(f)));
    }
  });
  function hasFiles(e) { return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'); }

  /* ---------------- photo actions ---------------- */
  function setRating(n) {
    const ts = targets(); if (!ts.length) return;
    Cat.setMeta(ts, { rating: n });
    UI.toast(n ? `Rated ${'★'.repeat(n)}` : 'Rating removed', 'star');
  }
  function setFlag(f) {
    const ts = targets(); if (!ts.length) return;
    Cat.setMeta(ts, { flag: f });
    UI.toast(f === 1 ? 'Flagged as Pick' : f === -1 ? 'Rejected' : 'Unflagged', f === -1 ? 'ban' : 'flag');
  }
  function setLabel(l) {
    const ts = targets(); if (!ts.length) return;
    const same = ts.every(p => p.label === l);
    Cat.setMeta(ts, { label: same ? '' : l });
  }
  function rotate(deg) {
    for (const p of targets()) {
      const g = p.settings.geo;
      const c = g.crop;
      if (deg > 0) g.crop = { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w };
      else g.crop = { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
      if (g.flipH !== g.flipV) { const t = g.flipH; g.flipH = g.flipV; g.flipV = t; }
      g.orient = (((g.orient + deg) % 360) + 360) % 360;
      Cat.commit(p, deg > 0 ? 'Rotate right' : 'Rotate left');
      afterSettings(p);
    }
  }
  function flip(axis) {
    for (const p of targets()) {
      const g = p.settings.geo, c = g.crop;
      if (axis === 'h') { g.flipH = !g.flipH; g.crop = { ...c, x: 1 - c.x - c.w }; }
      else { g.flipV = !g.flipV; g.crop = { ...c, y: 1 - c.y - c.h }; }
      g.angle = -g.angle;
      Cat.commit(p, axis === 'h' ? 'Flip horizontal' : 'Flip vertical');
      afterSettings(p);
    }
  }
  function afterSettings(p) {
    if (module === 'develop' && p === activePhoto()) { if (viewer.st.tool === 'crop') { viewer.setTool('none'); viewer.setTool('crop'); } else viewer.update('commit'); develop.syncAll(); }
    E.queueThumb(p, p === activePhoto());
  }
  /**
   * Re-check photos against the disk: missing/back-online, size & date changes, metadata,
   * previews. Used by "Refresh" on collections, folders and the current view.
   */
  async function refreshPhotos(list, label) {
    const seen = new Map();
    for (const p of list) { const k = p.path; if (!seen.has(k)) seen.set(k, []); seen.get(k).push(p); }
    let i = 0, missing = 0, back = 0, changed = 0;
    for (const [path, group] of seen) {
      i++;
      UI.activity(`Refreshing ${label || ''}… ${i}/${seen.size}`, i / seen.size);
      const probe = group[0].video && group[0].video.cdng ? group[0].video.cdng.frames[0] : path;
      let st = null;
      try { st = API.stat ? await API.stat(probe) : null; } catch (_) { st = null; }
      if (!st && API.fileSize) { try { const n = await API.fileSize(probe); if (n > 0) st = { size: n }; } catch (_) { /* missing */ } }
      if (!st) {
        group.forEach(p => { if (!p.missing) { p.missing = true; missing++; } });
        continue;
      }
      const diskChanged = (st.mtime && group[0].mtime && Math.abs(st.mtime - group[0].mtime) > 1000) || (st.size && group[0].size && !group[0].video && st.size !== group[0].size);
      for (const p of group) {
        if (p.missing) { p.missing = false; back++; }
        if (diskChanged) { if (st.size) p.size = st.size; if (st.mtime) p.mtime = st.mtime; }
        // re-read metadata and rebuild previews
        p.exifLoaded = false;
        if (p.video) { p.video.probed = false; if (diskChanged) p.video.proxy = null; }
      }
      if (diskChanged) changed++;
      E.invalidate(group[0]);
      if (PJ.Video) PJ.Video.forget(path);
      group.forEach(p => E.queueThumb(p));
    }
    UI.activity('');
    Cat.scheduleSave();
    Cat.events.emit('meta', list, {});
    refresh();
    if (module === 'develop' && activePhoto() && list.includes(activePhoto())) { viewer.setPhoto(activePhoto()); develop.setPhoto(activePhoto()); }
    const parts = [`${list.length} item${list.length === 1 ? '' : 's'} checked`];
    if (changed) parts.push(`${changed} changed on disk`);
    if (back) parts.push(`${back} back online`);
    if (missing) parts.push(`${missing} missing`);
    UI.toast(`Refreshed${label ? ' ' + label : ''}: ${parts.join(' · ')}`, missing ? 'triangle-exclamation' : 'arrows-rotate');
  }
  async function refreshView() { await refreshPhotos(visibleList.slice(), library.sourceLabel ? library.sourceLabel() : ''); }

  async function removePhotos(ids) {
    if (!ids.length) return;
    const list = visibleList.map(p => p.id);
    const idx = list.indexOf(active);
    const removed = Cat.removePhotos(ids);
    const rs = new Set(removed);
    sel = new Set([...sel].filter(id => !rs.has(id)));
    refresh();
    const next = visibleList[Math.min(Math.max(0, idx), visibleList.length - 1)];
    setActive(next ? next.id : null);
    if (!next && module === 'develop') setModule('library');
    UI.toast(`Removed ${removed.length} photo(s) from the catalog`, 'trash-can');
  }
  async function confirmRemove() {
    const ts = targets();
    if (!ts.length) return;
    const ok = await UI.confirm('Remove from catalog', `Remove ${ts.length} photo${ts.length > 1 ? 's' : ''} from the catalog? Your original files on disk are not deleted.`, 'Remove', true);
    if (ok) removePhotos(ts.map(p => p.id));
  }
  function createVirtualCopy() {
    const p = activePhoto(); if (!p) return;
    const v = Cat.virtualCopy(p);
    refresh();
    setActive(v.id);
    E.queueThumb(v);
    UI.toast('Virtual copy created', 'clone');
  }

  /* ---------------- copy / paste / sync ---------------- */
  function copySettings(all) {
    const p = activePhoto(); if (!p) return;
    if (all) { clipboard = { partial: Cat.pickGroups(p.settings, Cat.GROUPS.map(g => g.key)), groups: Cat.GROUPS.map(g => g.key) }; UI.toast('Copied all settings', 'copy'); return; }
    const checks = PJ.Develop.groupChecks(Cat.pref('copy.groups', Cat.DEFAULT_SYNC));
    UI.modal({
      title: 'Copy Settings', icon: 'copy', body: checks.el,
      buttons: [{ label: 'Cancel' }, {
        label: 'Copy', primary: true, onClick: () => {
          const gs = checks.get();
          Cat.setPref('copy.groups', gs);
          clipboard = { partial: Cat.pickGroups(p.settings, gs), groups: gs };
          UI.toast(`Copied ${gs.length} setting group(s)`, 'copy');
        }
      }]
    });
  }
  /** Settings that came from another photo: its Subject / Sky / People masks are found again in each target. */
  async function refindMasks(photos, partial) {
    const out = { redone: 0, empty: 0 };
    // content-aware fills that came along are made again from each photo's own surroundings
    if (PJ.Fill && PJ.Fill.hasFill(partial)) {
      let k = 0;
      for (const p of photos) { UI.activity(`Filling in ${p.name}…`, ++k / (photos.length + 1)); try { await PJ.Fill.retarget(p); } catch (e) { console.warn('fill', p.name, e && e.message); } }
      UI.activity('');
    }
    if (!PJ.AIMask || !PJ.AIMask.hasAi(partial)) return out;
    let n = 0;
    for (const p of photos) {
      UI.activity(`Finding the masks in ${p.name}…`, ++n / (photos.length + 1));
      try { const r = await PJ.AIMask.retarget(p); out.redone += r.redone; if (r.empty.length) out.empty++; }
      catch (e) { console.warn('masks could not be found again for', p.name, e && e.message); }
    }
    UI.activity('');
    return out;
  }
  const maskNote = (r) => r.redone ? ` · masks found again${r.empty ? ` (nothing to find in ${r.empty} photo(s))` : ''}` : '';
  async function pasteSettings() {
    if (!clipboard) return UI.toast('Nothing copied yet — use Copy first', 'circle-info');
    const ts = targets();
    for (const p of ts) p.settings = Cat.applyGroups(p.settings, clipboard.partial, clipboard.groups);
    const r = await refindMasks(ts, clipboard.partial);
    for (const p of ts) { Cat.commit(p, 'Paste Settings'); afterSettings(p); }
    UI.toast(`Pasted settings to ${ts.length} photo(s)${maskNote(r)}`, 'paste');
  }
  function syncSettings() {
    const p = activePhoto();
    const others = selectedPhotos().filter(x => x !== p);
    if (!p || !others.length) return UI.toast('Select the photos to sync with (Ctrl/Shift-click in the filmstrip)', 'circle-info');
    const checks = PJ.Develop.groupChecks(Cat.pref('sync.groups', Cat.DEFAULT_SYNC));
    UI.modal({
      title: `Synchronize Settings to ${others.length} photo(s)`, icon: 'arrows-rotate', body: checks.el,
      buttons: [{ label: 'Cancel' }, {
        label: 'Synchronize', primary: true, onClick: async () => {
          const gs = checks.get();
          Cat.setPref('sync.groups', gs);
          const partial = Cat.pickGroups(p.settings, gs);
          for (const o of others) o.settings = Cat.applyGroups(o.settings, partial, gs);
          const r = await refindMasks(others, partial);
          for (const o of others) { Cat.commit(o, 'Sync Settings'); E.queueThumb(o); }
          UI.toast(`Synchronized ${others.length} photo(s)${maskNote(r)}`, 'arrows-rotate');
        }
      }]
    });
  }
  function applyPresetToSelection(preset) {
    const ts = targets();
    const { partial, groups } = Cat.presetPartial(preset);
    for (const p of ts) { p.settings = Cat.applyGroups(p.settings, partial, groups); Cat.commit(p, `Preset: ${preset.name}`); afterSettings(p); }
    UI.toast(`Applied “${preset.name}” to ${ts.length} photo(s)`);
  }
  /* ---------------- compare ---------------- */
  /** Two to six selected photos side by side, to pick the best: rate, flag and reject without leaving the view. */
  function compareView() {
    const list = (sel.size > 1 ? visibleList.filter(p => sel.has(p.id)) : []).filter(p => !p.missing).slice(0, 6);
    if (list.length < 2) return UI.toast('Select 2 to 6 photos to compare', 'circle-info');
    let focus = Math.max(0, list.findIndex(p => p.id === active));
    const cols = list.length <= 3 ? list.length : list.length === 4 ? 2 : 3;
    const grid = h('div', { class: 'grid', style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${Math.ceil(list.length / cols)}, 1fr)` } });
    const panes = list.map((p, i) => {
      const cv = h('canvas'), cap = h('div', { class: 'cap' }), box = h('div', { class: 'img' }, cv);
      const pane = h('div', { class: 'pane', onclick: () => { if (!moved) { focus = i; paint(); } } }, box, cap);
      grid.appendChild(pane);
      return { p, cv, cap, pane, box, sharp: null, detail: false };
    });
    /* Zoom and pan, the same in every pane: the point of comparing is the same spot side by side.
       z = 1 fits the photo; (cx, cy) is the middle of the view, as a share of the photo. */
    const zs = { z: 1, cx: 0.5, cy: 0.5 };
    let moved = false, detailTimer = 0;
    const fitOf = (q) => { const r = q.box.getBoundingClientRect(); return Math.min(r.width / q.cv.width, r.height / q.cv.height) || 1; };
    const place = () => {
      zs.z = Math.max(1, Math.min(32, zs.z));
      const half = 0.5 / zs.z;
      zs.cx = Math.max(half, Math.min(1 - half, zs.cx)); zs.cy = Math.max(half, Math.min(1 - half, zs.cy));
      for (const q of panes) {
        const r = q.box.getBoundingClientRect(), f = fitOf(q), w = q.cv.width * f, hh = q.cv.height * f;
        // the canvas is drawn fitted and centred; then scaled about the box's middle and shifted
        q.cv.style.transform = `translate(${(0.5 - zs.cx) * w * zs.z}px, ${(0.5 - zs.cy) * hh * zs.z}px) scale(${zs.z})`;
        q.cv.style.imageRendering = zs.z * f * (q.detail ? q.detailScale : 1) > 2.5 ? 'pixelated' : '';
        void r;
      }
      zoomNote.textContent = zs.z > 1.001 ? `${zs.z.toFixed(1)}× · double-click to fit` : 'wheel to zoom · drag to pan';
      if (zs.z > 1.5) { clearTimeout(detailTimer); detailTimer = setTimeout(moreDetail, 250); }
    };
    /** Zoomed in: swap the fitted previews for full-size renders, one pane at a time. */
    const moreDetail = async () => {
      for (const q of panes) {
        if (q.detail || q.p.kind === 'video' || !root.isConnected) continue;
        q.detail = true;
        try {
          const res = await E.renderFull(q.p, P.clone(q.p.settings));
          if (!res || !root.isConnected) return;
          const img = E.toCanvas(res), cap = panes.length <= 2 ? 6000 : 4096, k = Math.min(1, cap / Math.max(img.width, img.height));
          q.detailScale = q.cv.width / (img.width * k);
          q.cv.width = Math.round(img.width * k); q.cv.height = Math.round(img.height * k);
          const cx = q.cv.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, q.cv.width, q.cv.height);
          place();
        } catch (e) { q.detail = false; console.warn('compare: full-size render failed for', q.p.name, e && e.message); return; }
      }
    };
    grid.addEventListener('wheel', (e) => {
      e.preventDefault();
      const q = panes.find(x => x.pane.contains(e.target)) || panes[focus];
      const r = q.box.getBoundingClientRect(), f = fitOf(q), w = q.cv.width * f, hh = q.cv.height * f;
      // the photo point under the pointer stays under the pointer
      const px = zs.cx + (e.clientX - (r.left + r.width / 2)) / (w * zs.z), py = zs.cy + (e.clientY - (r.top + r.height / 2)) / (hh * zs.z);
      const z = Math.max(1, Math.min(32, zs.z * Math.exp(-e.deltaY * 0.0016)));
      zs.cx = px - (e.clientX - (r.left + r.width / 2)) / (w * z); zs.cy = py - (e.clientY - (r.top + r.height / 2)) / (hh * z); zs.z = z;
      place();
    }, { passive: false });
    grid.addEventListener('pointerdown', (e) => {
      const q = panes.find(x => x.box.contains(e.target));
      moved = false;
      if (!q || e.button !== 0 || zs.z <= 1.001) return;
      const f = fitOf(q), w = q.cv.width * f, hh = q.cv.height * f, x0 = e.clientX, y0 = e.clientY, c0 = [zs.cx, zs.cy];
      const move = (ev) => {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 3) moved = true;
        zs.cx = c0[0] - (ev.clientX - x0) / (w * zs.z); zs.cy = c0[1] - (ev.clientY - y0) / (hh * zs.z); place();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    grid.addEventListener('dblclick', (e) => {
      const q = panes.find(x => x.box.contains(e.target));
      if (!q) return;
      if (zs.z > 1.001) { zs.z = 1; zs.cx = zs.cy = 0.5; }
      else {
        const r = q.box.getBoundingClientRect(), f = fitOf(q), w = q.cv.width * f, hh = q.cv.height * f;
        zs.cx = 0.5 + (e.clientX - (r.left + r.width / 2)) / w; zs.cy = 0.5 + (e.clientY - (r.top + r.height / 2)) / hh;
        zs.z = Math.max(2, (q.p.width || q.cv.width) / w / (window.devicePixelRatio || 1));     // one photo pixel per screen pixel
      }
      place();
    });
    const zoomNote = h('span', { class: 'muted' });
    /** How sharp the sharpest part of a picture is: detail energy in its crispest tenth (blurred backgrounds do not count against it). */
    const sharpness = (res) => {
      const w = res.width, hh = res.height, d = res.data, bw = Math.max(8, Math.floor(w / 16)), bh = Math.max(8, Math.floor(hh / 16));
      const cols = Math.floor(w / bw), rows = Math.floor(hh / bh), blocks = new Float64Array(cols * rows);
      const L = (x, y) => { const i = (y * w + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
      for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
        let sum = 0, n = 0;
        for (let y = Math.max(1, by * bh); y < Math.min(hh - 1, (by + 1) * bh); y += 2) for (let x = Math.max(1, bx * bw); x < Math.min(w - 1, (bx + 1) * bw); x += 2) {
          const v = 4 * L(x, y) - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1); sum += v * v; n++;
        }
        blocks[by * cols + bx] = n ? sum / n : 0;
      }
      const top = Array.from(blocks).sort((a, b) => b - a).slice(0, Math.max(1, Math.round(blocks.length * 0.1)));
      return Math.sqrt(top.reduce((a, b) => a + b, 0) / top.length);
    };
    const best = () => Math.max(1e-9, ...panes.map(q => q.sharp || 0));
    const paint = () => panes.forEach((q, i) => {
      q.pane.className = `pane${i === focus ? ' on' : ''}${q.p.flag === -1 ? ' rejected' : ''}`;
      q.cap.replaceChildren(h('span', { class: 'name' }, `${i + 1}  ${Cat.displayName(q.p)}`),
        q.sharp != null ? h('span', { class: `sharp${q.sharp === best() ? ' best' : ''}`, title: 'How sharp the crispest part of this photo is, against the sharpest of the ones compared (100)' }, `sharpness ${Math.round(q.sharp / best() * 100)}`) : null,
        q.p.flag === 1 ? icon('flag', 'flag-pick') : q.p.flag === -1 ? icon('ban', 'flag-reject') : null,
        h('span', { class: 'stars' }, '★'.repeat(q.p.rating || 0) + '☆'.repeat(5 - (q.p.rating || 0))));
    });
    const draw = async (q) => {
      // the camera preview first (instant), then the developed image
      for (const want of ['any', 'best']) {
        try {
          const res = await E.render(q.p, P.clone(q.p.settings), 'proxy', {}, want === 'any' ? 0 : 1, want);
          if (!res || !root.isConnected) return;
          if (q.detail) return;                          // already replaced by the full-size render
          const img = E.toCanvas(res);
          q.cv.width = img.width; q.cv.height = img.height;
          q.cv.getContext('2d').drawImage(img, 0, 0);
          if (want === 'best' || !E.needsDevelop(q.p)) { q.sharp = sharpness(res); paint(); }
          place();
        } catch (e) { console.warn('compare: could not render', q.p.name, e && e.message); }
        if (!E.needsDevelop(q.p)) break;
      }
    };
    const close = () => { window.removeEventListener('keydown', onKey, true); root.remove(); refresh(); };
    const set = (fn) => { fn(panes[focus].p); Cat.scheduleSave(); paint(); };
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      e.stopPropagation();
      if (k === 'escape' || k === 'c') { e.preventDefault(); return close(); }
      if (k === 'arrowright' || k === 'arrowdown') { e.preventDefault(); focus = (focus + 1) % panes.length; return paint(); }
      if (k === 'arrowleft' || k === 'arrowup') { e.preventDefault(); focus = (focus + panes.length - 1) % panes.length; return paint(); }
      if (/^[0-5]$/.test(k)) { e.preventDefault(); return set(p => { p.rating = +k; }); }
      if (k === 'p') { e.preventDefault(); return set(p => { p.flag = 1; }); }
      if (k === 'x') { e.preventDefault(); return set(p => { p.flag = -1; }); }
      if (k === 'u') { e.preventDefault(); return set(p => { p.flag = 0; }); }
      if (k === 'enter') { e.preventDefault(); const p = panes[focus].p; close(); return openDevelop(p.id); }
      e.preventDefault();
    };
    const root = h('div', { class: 'compare' },
      h('div', { class: 'bar' }, h('b', null, `Compare ${list.length} photos`),
        h('span', { class: 'muted' }, '←/→ choose · 0–5 rate · P pick · X reject · U unflag · Enter open in Develop · Esc close'),
        h('span', { style: { flex: 1 } }), zoomNote, h('button', { class: 'btn sm', onclick: close }, icon('xmark'), 'Close')),
      grid);
    document.body.appendChild(root);
    window.addEventListener('keydown', onKey, true);
    paint(); place();
    panes.forEach(draw);
    return { close, panes, zoom: zs, place };
  }

  /* ---------------- merging photos: HDR and panorama ---------------- */
  let mergeWorker = null, mergeBusy = false;
  /**
   * Merge the selected photos into one new picture (js/mergeworker.js): 'hdr' fuses different exposures
   * of one scene, 'pano' joins overlapping photos. Each photo goes in as it is developed now; the result
   * is written as a 16-bit TIFF next to the first photo and added to the catalog. opts.dir overrides the folder.
   */
  async function mergePhotos(kind, list, opts) {
    const what = kind === 'hdr' ? 'HDR' : 'Panorama';
    const photos = (list || selectedPhotos()).filter(p => p.kind !== 'video' && !p.missing)
      .sort((a, b) => String(a.captureTime || '').localeCompare(String(b.captureTime || '')) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (photos.length < 2) { UI.toast(kind === 'hdr' ? 'Select two or more exposures of the same scene first' : 'Select two or more overlapping photos first', 'circle-info'); return null; }
    if (photos.length > 12) { UI.toast('That is more than 12 photos — merge them in smaller groups', 'circle-info'); return null; }
    if (mergeBusy) { UI.toast('A merge is already running', 'circle-info'); return null; }
    mergeBusy = true;
    try {
      if (!mergeWorker) mergeWorker = new Worker(new URL('js/mergeworker.js', location.href).href);
      const wk = mergeWorker;
      wk.postMessage({ op: 'reset' });
      const focal = [];
      // a panorama of many large photos would not fit in memory at full size: they go in smaller
      const edge = kind === 'pano' ? Math.max(1600, Math.round(Math.sqrt(120e6 / photos.length) * 1.2)) : Infinity;
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        UI.activity(`${what}: developing ${p.name} (${i + 1} of ${photos.length})`, 0.4 * i / photos.length);
        let res = await E.renderFull(p, P.clone(p.settings));
        if (!res) throw new Error(p.name + ' could not be developed');
        let w = res.width, h = res.height, d = res.data;
        if (Math.max(w, h) > edge) { const sm = PJ.Decode.resizePixels({ data: d, width: w, height: h }, edge); w = sm.width; h = sm.height; d = sm.data; }
        const rgb = new Uint8Array(w * h * 3);
        for (let q = 0, o = 0; q < w * h * 4; q += 4, o += 3) { rgb[o] = d[q]; rgb[o + 1] = d[q + 1]; rgb[o + 2] = d[q + 2]; }
        res = null; d = null;
        // focal length in pixels, from the 35 mm equivalent (a full-frame sensor is 36 mm on its long side)
        const f35 = +(p.exif && p.exif.focalLength35) || 0;
        focal.push(f35 > 0 ? f35 / 36 * Math.max(w, h) : 0);
        wk.postMessage({ op: 'image', w, h, rgb }, [rgb.buffer]);
        if (E.dropFull) E.dropFull();
      }
      const out = await new Promise((resolve, reject) => {
        wk.onmessage = (ev) => { const m = ev.data; if (m.progress != null) UI.activity(`${what}: ${m.text}`, 0.4 + 0.5 * m.progress); else if (m.error) reject(new Error(m.error)); else resolve(m); };
        wk.onerror = (ev) => { mergeWorker = null; reject(new Error('The merge stopped: ' + (ev && ev.message || 'not enough memory?'))); };
        wk.postMessage({ op: kind, id: 1, focal, maxPixels: 40e6 });
      });
      UI.activity(`${what}: writing the file`, 0.93);
      const bytes = PJ.Exporter.encodeTiffRich({ width: out.w, height: out.h, data16: out.rgb16 }, PJ.ICC ? PJ.ICC.profile('srgb') : null);
      const first = photos[0], base = first.name.replace(/\.[^.]+$/, '');
      const dir = (opts && opts.dir) || API.dirname(first.path);
      const written = await API.writeFile(API.joinPath(dir, `${base}-${kind === 'hdr' ? 'HDR' : 'Pano'}.tif`), bytes, 'unique');
      const path = (written && written.path) || written;
      UI.activity('');
      let added = [];
      if (typeof path === 'string') {
        const r = await API.scanPaths([path]);
        added = await importDescs(Array.isArray(r) ? r : (r && r.files) || []);
      }
      UI.toast(`${what} of ${photos.length} photos: ${out.w} × ${out.h}`, 'layer-group');
      return { path, width: out.w, height: out.h, stats: out.stats, photo: added[0] || null };
    } catch (e) {
      UI.toast(`${what}: ${e && e.message || e}`, 'triangle-exclamation');
      return { error: String(e && e.message || e) };
    } finally { mergeBusy = false; UI.activity(''); }
  }

  /* ---------------- catalog clean-up ---------------- */
  /** Everything in the thumbnail store that the catalog still refers to: previews, LUTs, mask shapes (also those only an undo step or a snapshot names). */
  function storeKeys() {
    const keep = new Set();
    const masksOf = (s) => {
      if (s && s.masks) for (const m of s.masks) if (m.map && m.map.id) keep.add('mm_' + m.map.id);
      if (s && s.spots) for (const sp of s.spots) if (sp.patch && sp.patch.id) keep.add('cf_' + sp.patch.id);
    };
    for (const p of Cat.state.photos) {
      keep.add(p.id);
      for (const f of p.faces || []) if (f.t) keep.add(f.t);
      masksOf(p.settings);
      for (const e of p.history || []) masksOf(e.settings);
      for (const e of p.snapshots || []) masksOf(e.settings);
    }
    for (const l of Cat.state.luts || []) keep.add(l.id);
    for (const pr of Cat.state.presets || []) masksOf(pr.settings);
    if (clipboard) masksOf(clipboard.partial);
    return [...keep];
  }
  async function cleanCatalog() {
    if (!API.cleanStore) return UI.toast('Catalog clean-up is part of the Windows app', 'circle-info');
    const mb = (b) => b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + ' GB' : (b / (1 << 20)).toFixed(1) + ' MB';
    let u;
    try { await Cat.save(); u = await API.cleanStore(storeKeys(), false, false); }
    catch (e) { return UI.toast('The catalog folder could not be read: ' + (e.message || e), 'triangle-exclamation'); }
    const go = async (raw) => {
      try {
        const r = await API.cleanStore(storeKeys(), true, raw);
        UI.toast(`Removed ${r.removed} leftover file${r.removed === 1 ? '' : 's'}${raw ? ` and ${r.rawRemoved} cached RAW development${r.rawRemoved === 1 ? '' : 's'}` : ''}`, 'broom');
      } catch (e) { UI.toast('Clean-up failed: ' + (e.message || e), 'triangle-exclamation'); }
    };
    UI.modal({
      title: 'Clean Up Catalog', icon: 'broom',
      body: h('div', { style: { width: '420px', lineHeight: 1.5 } },
        h('p', null, h('b', null, `${u.orphans} leftover file${u.orphans === 1 ? '' : 's'} (${mb(u.orphanBytes)})`), ' — previews and mask shapes of photos that were removed from the catalog, or of masks that were deleted and can no longer be brought back by undo. Nothing in the catalog uses them.'),
        h('p', null, h('b', null, `RAW cache: ${u.rawFiles} file${u.rawFiles === 1 ? '' : 's'} (${mb(u.rawBytes)})`), ' — developed RAW files kept so they open quickly. Safe to clear; each photo is developed again the next time it is opened.'),
        h('p', { class: 'muted' }, `The store holds ${u.thumbs} files (${mb(u.thumbBytes)}) in all. Your photos, edits and the catalog itself are not touched.`)),
      buttons: [{ label: 'Close' },
        { label: 'Clear RAW cache too', onClick: () => go(true) },
        { label: u.orphans ? 'Remove leftovers' : 'Nothing to remove', primary: true, onClick: () => { if (u.orphans) go(false); } }]
    });
  }

  /* ---------------- stacks ---------------- */
  function stackSelection() {
    const ts = selectedPhotos();
    if (ts.length < 2) return UI.toast('Select two or more photos to stack', 'circle-info');
    const id = ts.find(p => p.stack) ? ts.find(p => p.stack).stack : Cat.uid('stack_');
    const merged = new Set(ts.map(p => p.stack).filter(Boolean));
    for (const p of Cat.state.photos) if (merged.has(p.stack)) p.stack = id;       // stacks that were touched join the new one
    ts.forEach(p => { p.stack = id; });
    Cat.scheduleSave(); refresh();
    UI.toast(`Stacked ${Cat.state.photos.filter(p => p.stack === id).length} photos`);
  }
  function unstackSelection() {
    const ids = new Set(selectedPhotos().map(p => p.stack).filter(Boolean));
    if (!ids.size) return UI.toast('The selection isn\'t part of a stack', 'circle-info');
    let n = 0;
    for (const p of Cat.state.photos) if (ids.has(p.stack)) { delete p.stack; n++; }
    Cat.scheduleSave(); refresh();
    UI.toast(`Unstacked ${n} photos`);
  }
  /** Bursts (shots within two seconds of each other) and RAW + JPEG pairs of the same name become stacks. */
  function autoStack() {
    const list = (sel.size > 1 ? selectedPhotos() : visibleList).filter(p => !p.stack && !p.virtualOf && p.kind !== 'video');
    const byTime = list.filter(p => p.captureTime).sort((a, b) => a.captureTime < b.captureTime ? -1 : a.captureTime > b.captureTime ? 1 : 0);
    let made = 0, cur = null, last = 0;
    const start = (a, b) => { const id = Cat.uid('stack_'); a.stack = b.stack = id; made++; return id; };
    for (let i = 1; i < byTime.length; i++) {
      const a = byTime[i - 1], b = byTime[i];
      const gap = (new Date(b.captureTime) - new Date(a.captureTime)) / 1000;
      if (gap >= 0 && gap <= 2 && a.folder === b.folder) { if (cur && last === i - 1) b.stack = cur; else cur = start(a, b); last = i; }
    }
    const byName = new Map();
    for (const p of list) { const k = (p.folder + '/' + p.name.replace(/\.[^.]+$/, '')).toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); }
    for (const g of byName.values()) if (g.length > 1 && g.some(p => p.isRaw) && g.some(p => !p.isRaw)) {
      const id = g.find(p => p.stack) ? g.find(p => p.stack).stack : (made++, Cat.uid('stack_'));
      g.forEach(p => { p.stack = id; });
    }
    Cat.scheduleSave(); refresh();
    UI.toast(made ? `Made ${made} stack${made === 1 ? '' : 's'}` : 'No bursts or RAW + JPEG pairs found', made ? undefined : 'circle-info');
  }

  /* ---------------- printing ---------------- */
  /** File → Print: a contact sheet of the selection (or one photo per page), through the system print dialog. */
  function printDialog() {
    const ts = targets().filter(p => !p.missing);
    if (!ts.length) return UI.toast('Select photos to print', 'circle-info');
    const o = Object.assign({ cols: ts.length === 1 ? 1 : 5, names: true, dates: false, title: '' }, Cat.pref('print.last', {}));
    if (ts.length === 1) o.cols = 1;
    const cols = h('select', null, [[1, 'One photo per page'], [2, '2 across'], [3, '3 across'], [4, '4 across'], [5, '5 across'], [6, '6 across'], [8, '8 across']].map(([v, l]) => h('option', { value: v }, l)));
    cols.value = String(o.cols);
    const title = h('input', { type: 'text', value: o.title, placeholder: 'Optional heading', style: { width: '100%' } });
    const names = UI.checkbox('File names', o.names, (v) => { o.names = v; }), dates = UI.checkbox('Capture dates', o.dates, (v) => { o.dates = v; });
    UI.modal({
      title: `Print ${ts.length} photo${ts.length === 1 ? '' : 's'}`, icon: 'print',
      body: h('div', null,
        h('label', { class: 'field' }, h('span', null, 'Layout'), cols),
        h('label', { class: 'field' }, h('span', null, 'Heading'), title),
        h('div', { class: 'row', style: { gap: '14px' } }, names.el, dates.el),
        h('p', { class: 'muted', style: { fontSize: '11px', marginTop: '10px' } }, 'Paper size, margins and the printer (or “Save as PDF”) are chosen in the print dialog that opens next.')),
      buttons: [{ label: 'Cancel' }, { label: 'Print…', primary: true, onClick: () => { o.cols = +cols.value; o.title = title.value.trim(); Cat.setPref('print.last', o); printSheet(ts, o); } }]
    });
  }
  async function printSheet(ts, o) {
    UI.activity('Preparing the print…', 0);
    const old = document.getElementById('print-root'); if (old) old.remove();
    const sheet = h('div', { class: 'sheet', style: { gridTemplateColumns: `repeat(${o.cols}, 1fr)` } });
    const root = h('div', { id: 'print-root' }, o.title ? h('h1', null, o.title) : null, sheet);
    // small cells print from the thumbnails; larger ones from a rendered preview so they stay sharp on paper
    const level = o.cols <= 2 ? 'proxy' : o.cols <= 4 ? 'draft' : null;
    const loads = [];
    for (let i = 0; i < ts.length; i++) {
      const p = ts[i];
      let src = p.thumbV ? API.thumbUrl(p.id, p.thumbV) : '';
      if (level || !src) {
        try { const res = await E.render(p, P.clone(p.settings), level || 'draft', {}, 1, level === 'proxy' ? 'best' : 'any'); if (res) src = E.toCanvas(res).toDataURL('image/jpeg', 0.9); }
        catch (e) { console.warn('print: could not render', p.name, e && e.message); }
      }
      if (!src) continue;
      const img = h('img', { src });
      loads.push(new Promise(r => { img.onload = img.onerror = r; }));
      const cap = [o.names ? Cat.displayName(p) : '', o.dates && p.captureTime ? p.captureTime.slice(0, 10) : ''].filter(Boolean).join(' · ');
      sheet.appendChild(h('figure', o.cols === 1 ? { style: { breakAfter: 'page' } } : null, img, cap ? h('figcaption', null, cap) : null));
      UI.activity('Preparing the print…', (i + 1) / ts.length);
    }
    document.body.appendChild(root);
    await Promise.all(loads);
    UI.activity('');
    const done = () => { window.removeEventListener('afterprint', done); root.remove(); };
    window.addEventListener('afterprint', done);
    window.print();
    return root;
  }

  /** Photo → Apply Lens Profile: each selected photo gets the database profile of its own lens, focal length and aperture. */
  async function lensProfileSelection() {
    const ts = targets();
    if (!ts.length) return UI.toast('Select photos first', 'circle-info');
    let done = 0;
    const misses = new Map();
    for (const p of ts) {
      const before = P.clone(p.settings);
      try { await PJ.Lens.applyDatabaseProfile(p); Cat.commit(p, 'Lens profile'); afterSettings(p); done++; }
      catch (e) { p.settings = before; const m = String(e.message || e); misses.set(m, (misses.get(m) || 0) + 1); }
    }
    if (module === 'develop') develop.syncAll();
    const why = [...misses.entries()].sort((a, b) => b[1] - a[1])[0];
    UI.toast(done ? `Lens profile applied to ${done} photo${done === 1 ? '' : 's'}${misses.size ? ` — ${ts.length - done} skipped (${why[0]})` : ''}` : why[0], done ? undefined : 'triangle-exclamation');
  }
  async function autoToneSelection() {
    const ts = targets();
    for (const p of ts) {
      try { Object.assign(p.settings, await E.autoTone(p, p.settings)); Cat.commit(p, 'Auto Tone'); afterSettings(p); } catch (e) { console.warn(e); }
    }
    UI.toast(`Auto Tone applied to ${ts.length} photo(s)`);
  }
  /** Auto color grade the selection (Library) or the active photo (Develop). */
  async function autoGradeSelection(style, strength) {
    style = style || Cat.pref('grade.style', 'auto'); strength = strength || Cat.pref('grade.strength', 'normal');
    const ts = module === 'develop' ? [activePhoto()].filter(Boolean) : targets();
    if (!ts.length) return UI.toast('Select photos first', 'circle-info');
    let done = 0;
    for (const p of ts) {
      try {
        UI.activity(`Auto color grade ${done + 1}/${ts.length}`, done / ts.length);
        const r = await E.autoGrade(p, p.settings, style, strength);
        if (!r) continue;
        p.settings.grading = r.grading; p.settings.vibrance = r.vibrance; p.settings.saturation = r.saturation;
        Cat.commit(p, `Auto Grade: ${P.GRADE_STYLES[style].label.split(' —')[0].split(' (')[0]}`);
        afterSettings(p); done++;
      } catch (e) { console.warn('auto grade failed', p.name, e); }
    }
    UI.activity('');
    if (module === 'develop') develop.syncAll();
    UI.toast(`Auto color grade (${P.GRADE_STYLES[style].label.split(' —')[0].split(' (')[0]}) applied${ts.length > 1 ? ` to ${done} photos` : ''}`, 'palette');
  }
  function resetSelection() {
    const ts = targets();
    for (const p of ts) { const o = p.settings.geo.orient; p.settings = P.defaultSettings(); p.settings.geo.orient = o; Cat.commit(p, 'Reset'); afterSettings(p); }
    UI.toast(`Reset ${ts.length} photo(s)`);
  }

  function gradeLookMenu(x, y) {
    const cur = Cat.pref('grade.style', 'auto');
    UI.menu(x, y, Object.entries(P.GRADE_STYLES).map(([k, v]) => ({
      label: v.label, icon: k === cur ? 'check' : null,
      action: () => { Cat.setPref('grade.style', k); autoGradeSelection(k); }
    })));
  }
  /* ---------------- context menu ---------------- */
  function photoMenu(x, y) {
    const ts = targets();
    const p = activePhoto();
    const n = ts.length;
    UI.menu(x, y, [
      { label: 'Open in Develop', icon: 'sliders', key: 'D', action: () => openDevelop(p.id) },
      { label: 'Show in file manager', icon: 'folder-open', hidden: !API.isDesktop, action: () => API.showInFolder(p.path) },
      '-',
      { label: `Export ${n > 1 ? n + ' photos' : ''}…`, icon: 'file-export', key: 'Ctrl+Shift+E', action: () => PJ.Exporter.openDialog(ts) },
      { label: 'Export with previous settings', icon: 'bolt', action: () => PJ.Exporter.openDialog(ts, true) },
      '-',
      { label: 'Copy settings…', icon: 'copy', key: 'Ctrl+Shift+C', action: () => copySettings() },
      { label: 'Paste settings', icon: 'paste', key: 'Ctrl+Shift+V', disabled: !clipboard, action: () => pasteSettings() },
      { label: 'Sync settings…', icon: 'arrows-rotate', disabled: n < 2, action: () => syncSettings() },
      { label: 'Auto Tone', icon: 'wand-magic-sparkles', key: 'Ctrl+Shift+U', action: () => autoToneSelection() },
      { label: 'Auto Color Grade', icon: 'palette', key: 'Ctrl+Shift+G', action: () => autoGradeSelection() },
      { label: 'Auto Color Grade with look…', icon: 'swatchbook', action: () => gradeLookMenu(x, y) },
      { label: 'Reset settings', icon: 'rotate-left', action: () => resetSelection() },
      '-',
      { label: 'Read metadata from file (XMP)', icon: 'file-import', hidden: !API.sidecar, action: () => xmpRead(ts) },
      { label: 'Save metadata to file (XMP)', icon: 'file-export', key: 'Ctrl+S', hidden: !API.sidecar, action: () => xmpWrite(ts) },
      '-',
      { label: 'Create virtual copy', icon: 'clone', key: "Ctrl+'", action: () => createVirtualCopy() },
      { label: 'Rotate left', icon: 'rotate-left', key: 'Ctrl+[', action: () => rotate(-90) },
      { label: 'Rotate right', icon: 'rotate-right', key: 'Ctrl+]', action: () => rotate(90) },
      '-',
      { label: 'Add to collection…', icon: 'layer-group', action: () => addToCollectionMenu(x, y) },
      { label: 'Remove from catalog', icon: 'trash-can', key: 'Del', action: () => confirmRemove() }
    ]);
  }
  function addToCollectionMenu(x, y) {
    const items = Cat.state.collections.map(c => ({ label: c.name, icon: 'layer-group', action: () => { Cat.addToCollection(c.id, targets().map(p => p.id)); UI.toast(`Added to “${c.name}”`); } }));
    items.push('-', { label: 'New collection…', icon: 'plus', action: async () => { const n = await UI.prompt('New Collection', ''); if (n) Cat.addCollection(n, targets().map(p => p.id)); } });
    setTimeout(() => UI.menu(x, y, items), 0);
  }
  function openDevelop(id) { if (id) setActive(id, true); setModule('develop'); }

  /* ---------------- slideshow ---------------- */
  async function slideshow() {
    const list = (sel.size > 1 ? visibleList.filter(p => sel.has(p.id)) : visibleList).filter(p => !p.missing);
    if (!list.length) return;
    let i = Math.max(0, list.findIndex(p => p.id === active));
    const img = h('img');
    const cap = h('div', { class: 'cap' });
    const el = h('div', { id: 'slideshow' }, img, cap);
    document.body.appendChild(el);
    try { if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); } catch (_) { }
    let timer = null, alive = true;
    async function show() {
      const p = list[i];
      try {
        const res = await E.render(p, p.settings, 'proxy', {}, 0);
        if (!alive) return;
        const c = E.toCanvas(res);
        img.style.opacity = 0;
        await new Promise(r => setTimeout(r, 180));
        img.src = c.toDataURL('image/jpeg', 0.92);
        img.style.opacity = 1;
        cap.textContent = `${Cat.displayName(p)}  ·  ${i + 1} / ${list.length}  ·  ← → to navigate, Esc to exit`;
      } catch (_) { }
      clearTimeout(timer);
      timer = setTimeout(() => { i = (i + 1) % list.length; show(); }, 4500);
    }
    function close() {
      alive = false; clearTimeout(timer); el.remove();
      window.removeEventListener('keydown', key, true);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    }
    function key(e) {
      e.stopPropagation(); e.preventDefault();
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' || e.key === ' ') { i = (i + 1) % list.length; show(); }
      else if (e.key === 'ArrowLeft') { i = (i - 1 + list.length) % list.length; show(); }
    }
    el.addEventListener('click', close);
    window.addEventListener('keydown', key, true);
    show();
  }

  /* ---------------- dialogs ---------------- */
  function shortcuts() {
    const rows = [
      ['G', 'Library grid'], ['D / E', 'Develop'], ['← →', 'Previous / next photo'], ['↑ ↓', 'Move in grid'],
      ['0 – 5', 'Set rating'], ['6 – 9', 'Red / yellow / green / blue label'], ['P / X / U', 'Pick / reject / unflag'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+A / Ctrl+D', 'Select all / none'],
      ['R', 'Crop & straighten'], ['Q', 'Spot removal'], ['M', 'Masking'], ['W', 'White balance picker'],
      ['O', 'Mask overlay (in masking)'], ['X', 'Swap crop orientation (in crop)'], ['Enter / Esc', 'Apply / cancel tool'],
      ['\\', 'Hold for before'], ['Y', 'Before/after side by side'], ['Shift+Y', 'Before/after split'], ['Alt+Y', 'Before/after top/bottom'],
      ['J', 'Clipping warnings'], ['Z', 'Toggle Fit / 100%'], ['Space + drag', 'Pan'], ['I', 'Cycle info overlay'],
      ['Ctrl+Shift+C / V', 'Copy / paste settings'], ['Ctrl+Shift+S', 'Sync settings'], ['Ctrl+S', 'Save metadata to .xmp'], ['Ctrl+,', 'Preferences'], ["Ctrl+'", 'Virtual copy'],
      ['Ctrl+[ / ]', 'Rotate left / right'], ['Ctrl+Shift+U', 'Auto tone'], ['Ctrl+Shift+R', 'Reset settings'],
      ['Ctrl+Shift+G', 'Auto color grade'], ['Ctrl+N', 'New snapshot'], ['Ctrl+Shift+N', 'New preset'], ['Ctrl+Shift+I', 'Import'], ['Ctrl+Shift+E', 'Export'],
      ['M (Library)', 'Map of geotagged photos'],
      ['Tab / Shift+Tab', 'Hide side panels / all panels'], ['Ctrl+Enter', 'Slideshow'], ['Del', 'Remove from catalog'], ['?', 'This help'],
      ['Space', 'Video: play / pause'], [', / .', 'Video: previous / next frame (Shift = 10)'], ['Shift+I / Shift+O', 'Video: set in / out point'], ['Ctrl+Shift+F', 'Video: capture frame'] 
    ];
    const grid = h('div', { class: 'kbd-table' });
    rows.forEach(([k, d]) => grid.append(h('span', null, ...k.split(' / ').flatMap((x, i) => i ? [' / ', h('kbd', null, x)] : [h('kbd', null, x)])), h('span', { class: 'muted' }, d)));
    UI.modal({ title: 'Keyboard Shortcuts', icon: 'keyboard', wide: true, body: grid });
  }
  function about() {
    UI.modal({
      title: 'About photos.jpeg', icon: 'camera-retro',
      body: h('div', { style: { lineHeight: 1.6 } },
        h('p', null, h('b', null, 'photos.jpeg'), ` ${API.appVersion || ''} — a non-destructive RAW photo & video editor.`),
        h('p', { class: 'muted' }, 'Catalog, library filters, collections, ratings & keywords · Develop with white balance, tone, presence, tone curves, color mixer, B&W, color grading, detail, lens corrections, transform, effects, calibration · masks (linear, radial, brush) · spot heal/clone · crop & straighten · snapshots, history, presets · batch export with resizing, sharpening and watermarks.'),
        h('p', { class: 'muted' }, 'RAW files (NEF, CR2, ARW, DNG) are developed from the sensor data; other RAW formats open through the preview embedded by the camera. Edits can be shared with Lightroom through .xmp sidecars. Processing runs locally on your computer.'))
    });
  }

  /* ---------------- XMP sidecars ---------------- */
  async function xmpRead(list, quiet) {
    if (!PJ.XMP || !API.sidecar) { if (!quiet) UI.toast('Sidecars are not available here', 'circle-info'); return 0; }
    let n = 0, found = 0;
    for (const p of list) {
      if (p.kind === 'video' || p.virtualOf) continue;
      try {
        const r = await PJ.XMP.readFor(p);
        if (!r) continue;
        found++;
        if (PJ.XMP.apply(p, r, 'Read Metadata (XMP)')) { n++; afterSettings(p); }
      } catch (e) { console.warn('XMP read failed for', p.name, e); }
    }
    if (!quiet) UI.toast(found ? `Read metadata for ${found} photo(s)${n < found ? ` · ${found - n} unchanged` : ''}` : 'No XMP metadata found', 'file-import');
    else if (n) UI.toast(`Applied Lightroom/XMP settings to ${n} photo(s)`, 'file-import');
    return n;
  }
  const xmpWriting = new Set();
  async function xmpWrite(list, quiet) {
    if (!PJ.XMP || !API.sidecar) { if (!quiet) UI.toast('Sidecars are not available here', 'circle-info'); return; }
    let ok = 0, failed = 0;
    for (const p of list) {
      if (p.kind === 'video' || p.virtualOf || p.missing) continue;
      if (xmpWriting.has(p.id)) continue;
      xmpWriting.add(p.id);
      try { await PJ.XMP.writeFor(p); ok++; }
      catch (e) { failed++; console.warn('XMP write failed for', p.name, e); }
      finally { xmpWriting.delete(p.id); }
    }
    if (!quiet) UI.toast(failed ? `Saved ${ok} sidecar(s), ${failed} failed (no write access?)` : `Saved metadata to ${ok} .xmp sidecar(s)`, failed ? 'triangle-exclamation' : 'file-export');
  }
  // Optional: keep sidecars current as you edit (Preferences)
  const xmpTimers = new Map();
  function xmpAuto(p) {
    if (!Cat.pref('xmp.autoWrite', false) || !p || p.kind === 'video' || p.virtualOf) return;
    clearTimeout(xmpTimers.get(p.id));
    xmpTimers.set(p.id, setTimeout(() => { xmpTimers.delete(p.id); xmpWrite([p], true); }, 2500));
  }

  function preferences() {
    const row = (title, sub, ctl) => h('div', { class: 'pref-row' }, h('div', null, h('div', null, title), sub ? h('div', { class: 'muted small' }, sub) : null), ctl);
    const chk = (key, def, after) => UI.checkbox('', Cat.pref(key, def), (v) => { Cat.setPref(key, v); after && after(v); }).el;
    const gpu = E.gpuInfo ? E.gpuInfo() : {};
    const rawSel = h('select', null, h('option', { value: 'full' }, 'Develop sensor data'), h('option', { value: 'preview' }, 'Embedded preview (fast)'));
    rawSel.value = Cat.pref('raw.engine', 'full');
    rawSel.addEventListener('change', () => { Cat.setPref('raw.engine', rawSel.value); UI.toast('Applies to RAW files opened from now on', 'circle-info'); });
    UI.modal({
      title: 'Preferences', icon: 'gear', wide: true,
      body: h('div', { class: 'prefs' },
        h('h4', null, 'Performance'),
        row('GPU previews', gpu.off ? 'Not available on this computer (no hardware WebGL2)' : 'Sliders render on the graphics card while you drag; the final image is always rendered exactly.', chk('gpu.preview', true)),
        row('RAW files', API.platform === 'macos' ? 'macOS develops RAW files with Core Image.' : 'NEF, CR2, ARW and DNG files are developed from the sensor data.', API.platform === 'macos' ? h('span') : rawSel),
        row('Wide colour for new photos', 'RAW photos and photos saved in Display P3 (most phones) that are added from now on are edited in Display P3. Each photo can be switched in Develop → Calibration.', chk('raw.wide', true)),
        row('Look for faces in new photos', 'Photos are looked through for faces as they are imported, on this computer. Turns itself on the first time you use People → Find faces.', chk('faces.auto', false)),
        h('h4', null, 'Import'),
        row('Apply lens profiles on import', 'New photos get the distortion and vignetting correction for their lens from the lens database.', chk('lens.autoProfile', false)),
        row('Apply noise reduction by ISO on import', 'New photos taken at ISO 400 and above start with luminance and colour noise reduction to match.', chk('nr.autoIso', false)),
        row('Offer to import camera cards', 'Asks when a card or camera with photos is connected (Windows app).', chk('import.detectCards', true)),
        h('h4', null, 'Lightroom compatibility'),
        row('Read .xmp sidecars on import', 'Picks up Lightroom / Camera Raw edits, ratings, labels and keywords.', chk('xmp.readOnImport', true)),
        row('Automatically write .xmp sidecars', 'Keeps a sidecar next to each original up to date as you edit.', chk('xmp.autoWrite', false)),
        h('h4', null, 'Map'),
        row('Load map tiles', 'The Map view downloads tiles from OpenStreetMap.', chk('map.tiles', true)))
    });
  }

  /* ---------------- keyboard ---------------- */
  function isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
  window.addEventListener('keydown', (e) => {
    if (UI.hasModal()) {
      if (e.key === 'Escape') UI.topModal().close();
      return;
    }
    if (isTyping(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const dev = module === 'develop';
    const tool = viewer.st.tool;

    if (mod) {
      const kl = k.toLowerCase();
      const name = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', a: 'selectAll', d: 'deselect', c: 'copySettings', v: 'pasteSettings', s: e.shiftKey ? 'syncSettings' : 'xmpWrite', ',': 'preferences', e: 'export', i: 'import', u: 'autoTone', r: 'reset', n: e.shiftKey ? 'newPreset' : 'newSnapshot', "'": 'virtualCopy', '[': 'rotateLeft', ']': 'rotateRight', enter: 'slideshow', '/': 'shortcuts' }[kl];
      if (name && !once(name)) { e.preventDefault(); return; }
      if (kl === 'z' && !e.shiftKey) { e.preventDefault(); return undo(); }
      if ((kl === 'z' && e.shiftKey) || kl === 'y') { e.preventDefault(); return redo(); }
      if (kl === 'a' && !e.shiftKey) { e.preventDefault(); sel = new Set(visibleList.map(p => p.id)); if (!active && visibleList[0]) active = visibleList[0].id; return onSelectionChanged(); }
      if (kl === 'd' && !e.shiftKey) { e.preventDefault(); return app.clearSelection(); }
      if (kl === 'c' && e.shiftKey) { e.preventDefault(); return copySettings(e.altKey); }
      if (kl === 'v' && e.shiftKey) { e.preventDefault(); return pasteSettings(); }
      if (kl === 's' && e.shiftKey) { e.preventDefault(); return syncSettings(); }
      if (kl === 's' && !e.shiftKey && !e.altKey) { e.preventDefault(); return xmpWrite(targets()); }
      if (k === ',') { e.preventDefault(); return preferences(); }
      if (kl === 'p' && !e.shiftKey) { e.preventDefault(); return printDialog(); }
      if (kl === 'e' && e.shiftKey) { e.preventDefault(); return PJ.Exporter.openDialog(targets(), e.altKey); }
      if (kl === 'i' && e.shiftKey) { e.preventDefault(); return app.importFiles(); }
      if (kl === 'u' && e.shiftKey) { e.preventDefault(); return dev ? develop.autoTone() : autoToneSelection(); }
      if (kl === 'g' && e.shiftKey) { e.preventDefault(); return autoGradeSelection(); }
      if (kl === 'r' && e.shiftKey) { e.preventDefault(); return dev ? develop.resetAll() : resetSelection(); }
      if (kl === 'n' && e.shiftKey) { e.preventDefault(); return develop.createPresetDialog(); }
      if (kl === 'n' && !e.shiftKey) { e.preventDefault(); if (dev) develop.createSnapshot(); return; }
      if (k === "'") { e.preventDefault(); return createVirtualCopy(); }
      if (k === '[') { e.preventDefault(); return rotate(-90); }
      if (k === ']') { e.preventDefault(); return rotate(90); }
      if (k === 'Enter') { e.preventDefault(); return slideshow(); }
      if (k === '/') { e.preventDefault(); return shortcuts(); }
      return;
    }

    // Tool-specific keys first
    if (dev && tool === 'crop') {
      if (k === 'Enter') { e.preventDefault(); return viewer.setTool('none'); }
      if (k === 'Escape') { e.preventDefault(); return viewer.cancelCrop(); }
      if (k.toLowerCase() === 'x') { e.preventDefault(); return viewer.swapCropOrientation(); }
    }
    if (dev && tool !== 'none' && k === 'Escape') { e.preventDefault(); if (tool === 'mask' && viewer.st.maskCreate) { viewer.st.maskCreate = null; viewer.setCursor(); develop.buildToolPane(); return; } return viewer.setTool('none'); }
    if (dev && tool === 'spot' && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); if (viewer.deleteSelectedSpot()) return; return; }
    if (dev && tool === 'mask' && (k === 'Delete' || k === 'Backspace')) {
      e.preventDefault();
      const p = activePhoto();
      if (p && viewer.st.maskIdx >= 0) { p.settings.masks.splice(viewer.st.maskIdx, 1); viewer.st.maskIdx = Math.min(viewer.st.maskIdx, p.settings.masks.length - 1); Cat.commit(p, 'Delete mask'); viewer.update('commit'); develop.buildToolPane(); }
      return;
    }
    if (dev && tool === 'mask' && k.toLowerCase() === 'o') { e.preventDefault(); return viewer.setMaskOverlay(!viewer.st.maskOverlay); }
    if (dev && tool === 'mask' && k.toLowerCase() === 'e') { e.preventDefault(); viewer.st.brush.erase = !viewer.st.brush.erase; develop.buildToolPane(); return; }

    switch (k) {
      case 'ArrowRight': e.preventDefault(); return step(1);
      case 'ArrowLeft': e.preventDefault(); return step(-1);
      case 'ArrowDown': if (!dev) { e.preventDefault(); return step(gridColumns()); } return;
      case 'ArrowUp': if (!dev) { e.preventDefault(); return step(-gridColumns()); } return;
      case 'Home': e.preventDefault(); if (visibleList[0]) setActive(visibleList[0].id); return;
      case 'End': e.preventDefault(); if (visibleList.length) setActive(visibleList[visibleList.length - 1].id); return;
      case 'Enter': if (!dev && active) { e.preventDefault(); return openDevelop(active); } return;
      case 'Delete': case 'Backspace': e.preventDefault(); return confirmRemove();
      case '\\': if (dev && !e.repeat) viewer.holdBefore(true); return;
      case 'Tab': e.preventDefault(); return togglePanels(e.shiftKey);
      case 'F5': if (!dev) { e.preventDefault(); return refreshView(); } return;
      case '?': return shortcuts();
    }
    if (/^[0-5]$/.test(k)) return setRating(+k);
    if (/^[6-9]$/.test(k)) return setLabel(['red', 'yellow', 'green', 'blue'][+k - 6]);
    const kl = k.toLowerCase();
    if (kl === 'p') return setFlag(1);
    if (kl === 'x') return setFlag(-1);
    if (kl === 'u') return setFlag(0);
    if (kl === 'g') return commands.library();
    if (kl === 'd' || kl === 'e') return setModule('develop');
    if (!dev && kl === 'm') return setModule('map');
    if (!dev) return;
    if (kl === 'r') return viewer.setTool('crop');
    if (kl === 'q') return viewer.setTool('spot');
    if (kl === 'm') return viewer.setTool('mask');
    if (kl === 'w') return viewer.setTool('wb');
    if (kl === 'j') return develop.toggleClip('both');
    if (kl === 'i') return viewer.cycleInfo();
    if (kl === 'z') return viewer.setZoom(viewer.st.zoom === 'fit' ? 1 : 'fit');
    if (kl === 'y') {
      const mode = e.shiftKey ? 'split' : e.altKey ? 'topbottom' : 'side';
      return viewer.setCompare(viewer.st.compare === mode ? 'single' : mode);
    }
  });
  window.addEventListener('keyup', (e) => { if (e.key === '\\' && module === 'develop') viewer.holdBefore(false); });

  function undo() {
    const p = activePhoto();
    if (p && Cat.undo(p)) { afterSettings(p); UI.toast(`Undo: ${p.history[p.historyIndex + 1].label}`, 'rotate-left'); }
  }
  function redo() {
    const p = activePhoto();
    if (p && Cat.redo(p)) { afterSettings(p); UI.toast(`Redo: ${p.history[p.historyIndex].label}`, 'rotate-right'); }
  }
  function togglePanels(all) {
    if (all) {
      const hide = !(els.main.classList.contains('hide-left') && els.appEl.classList.contains('no-film'));
      els.main.classList.toggle('hide-left', hide); els.main.classList.toggle('hide-right', hide); els.appEl.classList.toggle('no-film', hide);
    } else {
      const hide = !els.main.classList.contains('hide-left');
      els.main.classList.toggle('hide-left', hide); els.main.classList.toggle('hide-right', hide);
    }
  }

  /* Menu accelerators and renderer key handling can both see a shortcut on some
     platforms; run each command at most once per keystroke. */
  const lastRun = new Map();
  function once(name) {
    const t = performance.now(), prev = lastRun.get(name) || -1e9;
    lastRun.set(name, t);
    return t - prev > 100;
  }

  /* ---------------- menu commands (desktop) ---------------- */
  const commands = {
    import: () => app.importFiles(), importFolder: () => app.importFolder(), importOrganize: () => app.importOrganize(),
    export: () => PJ.Exporter.openDialog(targets()), exportPrevious: () => PJ.Exporter.openDialog(targets(), true),
    undo, redo,
    selectAll: () => { sel = new Set(visibleList.map(p => p.id)); onSelectionChanged(); }, deselect: () => app.clearSelection(),
    copySettings: () => copySettings(), pasteSettings, syncSettings, virtualCopy: createVirtualCopy,
    rotateLeft: () => rotate(-90), rotateRight: () => rotate(90), flipH: () => flip('h'), flipV: () => flip('v'),
    autoTone: () => module === 'develop' ? develop.autoTone() : autoToneSelection(),
    lensProfile: lensProfileSelection,
    compare: compareView, stack: stackSelection, unstack: unstackSelection, autoStack, cleanCatalog,
    mergeHdr: () => mergePhotos('hdr'), mergePano: () => mergePhotos('pano'),
    toggleFaces: async () => {
      if (!PJ.Faces) return;
      const on = viewer.st.showFaces = !viewer.st.showFaces, p = activePhoto();
      if (on && p && PJ.Faces.canScan(p) && !PJ.Faces.scanned(p)) { UI.activity('Looking for faces…', null); try { await PJ.Faces.scanPhoto(p); Cat.scheduleSave(); } catch (e) { UI.toast(String(e.message || e), 'triangle-exclamation'); } UI.activity(''); }
      viewer.draw();
      UI.toast(on ? `Faces shown${p && p.faces ? '' : ' — none found in this photo'} · click one to name it · Alt-drag marks one that was missed` : 'Faces hidden', 'user');
    },
    toggleStack: () => { const p = activePhoto(); if (p && p.stack) library.toggleStack(p.stack); else UI.toast('This photo isn\'t in a stack', 'circle-info'); },
    print: printDialog,
    reset: () => module === 'develop' ? develop.resetAll() : resetSelection(),
    library: () => { if (library.view.mode === 'map') { library.view.mode = 'grid'; Cat.setPref('lib.mode', 'grid'); } setModule('library'); },
    develop: () => setModule('develop'), map: () => setModule('map'), duplicates: () => PJ.Dupes.open(app),
    beforeAfter: () => { setModule('develop'); viewer.setCompare(viewer.st.compare === 'side' ? 'single' : 'side'); },
    clipping: () => develop.toggleClip('both'),
    zoomFit: () => viewer.setZoom('fit'), zoom100: () => viewer.setZoom(1),
    togglePanels: () => togglePanels(false), toggleAllPanels: () => togglePanels(true),
    shortcuts, about, slideshow,
    showInFolder: () => { const p = activePhoto(); if (p) API.showInFolder(p.path); },
    remove: confirmRemove, newSnapshot: () => develop.createSnapshot(), newPreset: () => develop.createPresetDialog(),
    xmpRead: () => xmpRead(targets()), xmpWrite: () => xmpWrite(targets()), preferences,
    crop: () => { setModule('develop'); viewer.setTool('crop'); }, spot: () => { setModule('develop'); viewer.setTool('spot'); },
    mask: () => { setModule('develop'); viewer.setTool('mask'); }
  };
    function runCommand(cmd) {
    // Text editing keeps its native undo/select-all when a field has focus
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && ['undo', 'redo', 'selectAll'].includes(cmd)) {
      document.execCommand(cmd === 'selectAll' ? 'selectAll' : cmd);
      return;
    }
    if (!once(cmd)) return;
    if (cmd.startsWith('rating:')) return setRating(+cmd.slice(7));
    if (cmd.startsWith('flag:')) return setFlag(+cmd.slice(5));
    if (cmd.startsWith('label:')) return setLabel(cmd.slice(6));
    if (cmd.startsWith('exportPreset:')) return PJ.Exporter.runPreset(cmd.slice(13), targets());
    const f = commands[cmd];
    if (f) f(); else console.warn('Unknown command', cmd);
  }

  /* ---------------- boot ---------------- */
  Object.assign(app, {
    refresh, visible: () => visibleList, isSelected: (id) => sel.has(id), activeId: () => active, activePhoto, selectedPhotos,
    selectedIds: () => [...sel], clickSelect, clearSelection: () => { sel = new Set(active ? [active] : []); onSelectionChanged(); },
    openDevelop, photoMenu, selectIds, setRating, setFlag, setLabel, rotate, flip, removePhotos, copySettings, pasteSettings, syncSettings,
    refreshPhotos, refreshView, autoGradeSelection, gradeLookMenu, xmpRead, xmpWrite, preferences,
    applyPresetToSelection, autoToneSelection, resetSelection, slideshow, setModule, runCommand, back, toggleDrawer,
    compareView, printSheet, storeKeys, cleanCatalog, mergePhotos, exportSelected: () => PJ.Exporter.openDialog(targets())
  });

  async function boot() {
    viewer = PJ.Viewer.create(els.viewerEl);
    develop = PJ.Develop.create(viewer);
    app.transport = PJ.Transport.create(app, viewer, els.viewerEl);
    library = PJ.Library.create(app);
    els.empty.appendChild(library.empty());
    app.viewer = viewer; app.develop = develop; app.library = library;

    document.querySelectorAll('.modules button').forEach(b => b.addEventListener('click', () => {
      // "Library" from the map goes back to the grid
      if (b.dataset.module === 'library' && library.view.mode === 'map') { library.view.mode = 'grid'; Cat.setPref('lib.mode', 'grid'); }
      setModule(b.dataset.module);
    }));

    await Cat.load();
    if (Cat.state.newer) {
      UI.modal({
        title: 'This catalog needs a newer photos.jpeg', icon: 'triangle-exclamation',
        body: h('div', { style: { lineHeight: 1.6 } },
          h('p', null, `Your catalog was last saved by a newer version of photos.jpeg (catalog format ${Cat.state.newer}; this version uses ${Cat.state.photos.length ? 'an older one' : 'an older format'}).`),
          h('p', null, 'You can look around, but nothing you change here will be saved, so the newer version\'s work is not lost. Install the current version to keep editing.'))
      });
    }
    visibleList = library.visible();
    if (visibleList.length) { active = Cat.pref('activeId', visibleList[0].id); if (!Cat.get(active)) active = visibleList[0].id; sel = new Set([active]); }
    setModule('library');
    refresh();

    Cat.events.on('meta', (list) => {
      for (const p of list) { library.updateCell(p); updateFilmThumb(p); }
      if (module === 'library') library.renderRight();
      library.renderLeft();
    });
    Cat.events.on('edited', (p) => { E.queueThumb(p, p === activePhoto()); xmpAuto(p); });
    Cat.events.on('meta', (list) => { for (const p of list) xmpAuto(p); });
    Cat.events.on('collections', () => { library.renderLeft(); if (library.view.source.startsWith('col:')) refresh(); });
    E.thumbEvents.on('thumb', (p) => { updateFilmThumb(p); if (module === 'library' && p === activePhoto()) library.renderRight(); });
    // Thumbnails with edits made in Develop refresh lazily
    const thumbDebounce = new Map();
    Cat.events.on('edited', (p) => {
      clearTimeout(thumbDebounce.get(p.id));
      thumbDebounce.set(p.id, setTimeout(() => E.queueThumb(p), 600));
    });

    // remember the active photo
    setInterval(() => { if (active && Cat.pref('activeId') !== active) Cat.setPref('activeId', active); }, 5000);

    API.onMenu((cmd) => runCommand(cmd));
    PJ.Exporter.publishPresets();
    // while a photo is on screen in Develop, get the next and previous ones ready
    // faces on the photo (View → Show Faces): click one to say who it is, Alt-drag to mark one that was missed
    const askName = async (p, face) => {
      const F = PJ.Faces, cur = face.p && F.person(face.p) ? F.person(face.p).name : '';
      const n = await UI.prompt('Who is this?', cur, { placeholder: 'Name' });
      if (n && n.trim()) { F.name([{ photo: p, face }], n); viewer.draw(); }
    };
    viewer.events.on('faceClick', ({ face, x, y }) => {
      const p = activePhoto(), F = PJ.Faces; if (!p || !F) return;
      UI.menu(x, y, [
        { label: face.p && F.person(face.p) ? 'Rename… (' + F.person(face.p).name + ')' : 'Name…', icon: 'user', action: () => askName(p, face) },
        ...(face.p ? [{ label: 'Not this person', icon: 'user-slash', action: () => { F.unname([{ photo: p, face }]); viewer.draw(); } }] : []),
        { label: 'Not a face', icon: 'trash-can', action: () => { if (face.m) F.removeFace(p, face); else F.ignore([{ photo: p, face }]); viewer.draw(); } }
      ]);
    });
    viewer.events.on('faceBox', async ({ box }) => {
      const p = activePhoto(); if (!p || !PJ.Faces) return;
      try { const face = await PJ.Faces.addFace(p, box); viewer.draw(); await askName(p, face); }
      catch (e) { UI.toast(String(e.message || e), 'triangle-exclamation'); }
    });
    viewer.events.on('shown', (p) => {
      if (viewer.st.showFaces && p && PJ.Faces && PJ.Faces.canScan(p) && !PJ.Faces.scanned(p)) PJ.Faces.scanPhoto(p).then(() => { Cat.scheduleSave(); if (activePhoto() === p) viewer.draw(); }).catch(() => { });
      if (module !== 'develop') return;
      const i = visibleList.indexOf(p);
      if (i >= 0) E.prefetch([visibleList[i + 1], visibleList[i - 1]]);
    });
    if (API.onNotice) API.onNotice((text) => UI.toast(String(text), 'circle-info'));
    // "Apply lens profiles on import": a new photo gets its profile as soon as its camera data has been read
    Cat.events.on('meta', async (list) => {
      for (const p of list || []) {
        if (!p.exifLoaded || !(p.autoLens || p.autoNr)) continue;
        const lens = p.autoLens, nr = p.autoNr;
        delete p.autoLens; delete p.autoNr;
        if (p.history.length > 1) continue;                                 // already being edited: leave it alone
        if (nr) {
          const v = P.noiseReductionForIso(p.exif && +p.exif.iso);
          if (v && !p.settings.detail.nrLuma && !p.settings.detail.nrColor) { Object.assign(p.settings.detail, v); Cat.commit(p, `Noise reduction for ISO ${p.exif.iso}`); afterSettings(p); }
        }
        if (lens && !p.settings.lens.profile) {
          const before = P.clone(p.settings);
          try { await PJ.Lens.applyDatabaseProfile(p); Cat.commit(p, 'Lens profile'); afterSettings(p); }
          catch (_) { p.settings = before; }                                // not in the database: leave the photo as it is
        }
      }
    });
    // a camera card was put in (or was in at start-up)
    if (API.onCard) API.onCard((card) => {
      if (!card || !card.path || Cat.pref('import.detectCards', true) === false || UI.hasModal()) return;
      UI.modal({
        title: 'Camera card found', icon: 'sd-card',
        body: h('div', { style: { lineHeight: 1.6 } }, h('p', null, `${card.label || 'A camera card'} has photos on it. Copy them to your computer and add them to the catalog?`),
          h('p', { class: 'muted' }, 'You choose the destination, folders and file names in the next step. Preferences turns this prompt off.')),
        buttons: [{ label: 'Not now' }, { label: 'Import…', primary: true, onClick: () => { setTimeout(() => importOrganize(card.path), 0); } }]
      });
    });
    // errors the editor runs into go to the app's log (Help → Show Log)
    if (API.log) {
      let sent = 0;
      const report = (level, text) => { if (sent++ < 200) API.log(level, text); };
      window.addEventListener('error', (e) => report('error', `${e.message} at ${(e.filename || '').split('/').pop()}:${e.lineno}`));
      window.addEventListener('unhandledrejection', (e) => report('error', 'Unhandled rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
      const ce = console.error;
      console.error = function (...a) { report('error', a.map(x => x && (x.stack || x.message) || String(x)).join(' ')); return ce.apply(console, a); };
    }
    API.onOpenPaths(async (paths) => {
      const descs = await API.scanPaths(paths);
      // "Open with photos.jpeg" on a file that is already in the catalog opens that photo
      if (descs.length === 1) {
        const norm = (s) => API.platform === 'windows' ? String(s).toLowerCase() : String(s);
        const have = Cat.state.photos.find(p => !p.virtualOf && norm(p.path) === norm(descs[0].path));
        if (have) {
          if (!visibleList.some(p => p.id === have.id)) { library.setSource('all'); refresh(); }
          openDevelop(have.id);
          return;
        }
      }
      const added = await importDescs(descs);
      if (added.length === 1) openDevelop(added[0].id);
    });
    API.onFlush(async () => {
      // exports still running: closing would cut them off, so ask first
      const n = PJ.Exporter && PJ.Exporter.queueLength ? PJ.Exporter.queueLength() : 0;
      if (n > 0 && API.closeHold) {
        await API.closeHold();
        const go = await UI.confirm('An export is still running', `${n} export job${n === 1 ? ' has' : 's have'} not finished. Closing now stops ${n === 1 ? 'it' : 'them'}; files already written stay where they are.`, 'Close anyway', true);
        if (!go) return false;
        await Cat.save();
        API.closeNow();
        return false;
      }
      await Cat.save();
    });
    if (API.onBack) API.onBack(() => back());
    window.addEventListener('beforeunload', () => { Cat.save(); });

    // Missing-file thumbs: generate for any photo lacking one
    Cat.state.photos.forEach(p => { if (!p.thumbV && !p.missing) E.queueThumb(p); });
    if (!API.isDesktop && Cat.state.photos.some(p => p.missing)) UI.toast('Browser mode: re-import files to edit them again', 'circle-info');
  }
  boot().catch(e => { console.error(e); UI.toast('Startup error: ' + e.message, 'triangle-exclamation'); });
})(window);
