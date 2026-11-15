/* =====================================================================
 * photos.jpeg — Develop module: panels, tools, presets, snapshots, history.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, UI = PJ.UI, Cat = PJ.Catalog, E = PJ.Engine, W = PJ.Widgets, API = PJ.API;
  const { h, icon } = UI;

  const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, path, v) {
    const ks = path.split('.');
    let t = o;
    for (let i = 0; i < ks.length - 1; i++) t = t[ks[i]];
    t[ks[ks.length - 1]] = v;
  }

  const WB_PRESETS = {
    asShot: { label: 'As Shot', temp: 0, tint: 0 }, auto: { label: 'Auto' },
    daylight: { label: 'Daylight', temp: 4, tint: 2 }, cloudy: { label: 'Cloudy', temp: 14, tint: 4 },
    shade: { label: 'Shade', temp: 24, tint: 6 }, tungsten: { label: 'Tungsten', temp: -48, tint: 4 },
    fluorescent: { label: 'Fluorescent', temp: -28, tint: 22 }, flash: { label: 'Flash', temp: 9, tint: 3 },
    custom: { label: 'Custom' }
  };
  const BAND_COLORS = ['#e5534b', '#ee8f3a', '#e8c547', '#4cc38a', '#3fc6c6', '#4f8ff7', '#8a63e8', '#d65cc0'];

  function create(viewer) {
    const left = h('div');
    const right = h('div');
    const topbar = h('div', { class: 'row', style: { flex: 1, gap: '10px' } });
    const bottombar = h('div', { class: 'row', style: { flex: 1, gap: '8px', flexWrap: 'wrap' } });
    const controls = []; // {sync()}
    let photo = null;
    let lastHist = null;
    let prevPhotoId = null;

    const S = () => photo && photo.settings;
    function live(label) {
      return (v, phase) => {
        if (!photo) return;
        if (phase === 'commit') Cat.commit(photo, label());
        viewer.update(phase);
        refreshEdited();
      };
    }
    /** Slider bound to a settings path */
    function bslider(path, label, min, max, opts = {}) {
      const sl = UI.slider({
        label, min, max, step: opts.step || 1, def: opts.def ?? getPath(P.defaultSettings(), path) ?? 0,
        rail: opts.rail, decimals: opts.decimals, suffix: opts.suffix, signed: opts.signed,
        onInput: (v, phase) => {
          if (!photo) return;
          setPath(photo.settings, path, v);
          if (opts.after) opts.after(v);
          if (phase === 'commit') Cat.commit(photo, `${label}: ${UI.fmtSigned(v, opts.decimals ?? (opts.step < 1 ? 2 : 0))}`);
          viewer.update(phase);
          refreshEdited();
        }
      });
      controls.push({ sync: () => { const v = photo ? getPath(photo.settings, path) : sl.get(); sl.set(v ?? 0); sl.setDisabled(!photo); } });
      return sl.el;
    }

    /* ================= LEFT: navigator, presets, snapshots, history ================= */
    const navCanvas = h('canvas');
    const navRect = h('div', { class: 'nav-rect hidden' });
    const navLabel = h('div', { class: 'nav-label' });
    const navBox = h('div', { class: 'nav-canvas' }, navCanvas, navRect, navLabel);
    const navPanel = UI.panel({ id: 'd-nav', title: 'Navigator' });
    navPanel.body.className = 'navigator';
    navPanel.body.appendChild(navBox);
    let navPreview = null; // preset hover
    function drawNavigator() {
      const after = viewer.st.after;
      const src = navPreview || (after ? after.canvas : null);
      const box = navBox.getBoundingClientRect();
      if (!src || !box.width) { navCanvas.width = navCanvas.height = 1; navRect.classList.add('hidden'); return; }
      const s = Math.min(box.width / src.width, box.height / src.height);
      const w = Math.max(1, Math.round(src.width * s)), hh = Math.max(1, Math.round(src.height * s));
      const dpr = window.devicePixelRatio || 1;
      navCanvas.width = w * dpr; navCanvas.height = hh * dpr;
      navCanvas.style.width = w + 'px'; navCanvas.style.height = hh + 'px';
      const ctx = navCanvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, navCanvas.width, navCanvas.height);
      navLabel.textContent = navPreview ? navPreview.label : '';
      // visible rect
      if (!navPreview && viewer.st.zoom !== 'fit' && after) {
        const pane = viewer.mainPane();
        const [fw, fh] = viewer.foDims();
        const a = viewer.toFo(pane.x, pane.y, pane), b = viewer.toFo(pane.x + pane.w, pane.y + pane.h, pane);
        const ox = (box.width - w) / 2, oy = (box.height - hh) / 2;
        const x0 = P.clamp(a[0] / fw, 0, 1), y0 = P.clamp(a[1] / fh, 0, 1), x1 = P.clamp(b[0] / fw, 0, 1), y1 = P.clamp(b[1] / fh, 0, 1);
        Object.assign(navRect.style, { left: ox + x0 * w + 'px', top: oy + y0 * hh + 'px', width: (x1 - x0) * w + 'px', height: (y1 - y0) * hh + 'px' });
        navRect.classList.remove('hidden');
      } else navRect.classList.add('hidden');
    }
    navBox.addEventListener('pointerdown', (e) => {
      if (!viewer.st.after) return;
      const move = (ev) => {
        const r = navCanvas.getBoundingClientRect();
        const [fw, fh] = viewer.foDims();
        const u = P.clamp((ev.clientX - r.left) / r.width, 0, 1), v = P.clamp((ev.clientY - r.top) / r.height, 0, 1);
        if (viewer.st.zoom === 'fit') viewer.setZoom(1);
        viewer.setCenter([u * fw, v * fh]);
      };
      move(e);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // Presets
    const presetsList = h('div', { class: 'list' });
    const presetActions = h('span', { class: 'panel-actions' },
      h('button', { title: 'Create preset from current settings', onclick: (e) => { e.stopPropagation(); createPresetDialog(); } }, icon('plus')),
      h('button', { title: 'Import presets…', onclick: async (e) => { e.stopPropagation(); importPresets(); } }, icon('file-import')));
    const presetsPanel = UI.panel({ id: 'd-presets', title: 'Presets', actions: presetActions });
    presetsPanel.body.style.padding = '4px 0 8px';
    presetsPanel.body.appendChild(presetsList);
    const presetGroupState = (() => { try { return JSON.parse(localStorage.getItem('pj.presetGroups') || '{}'); } catch (_) { return {}; } })();
    let hoverToken = 0;
    function renderPresets() {
      presetsList.innerHTML = '';
      const groups = new Map();
      for (const p of Cat.allPresets()) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
      for (const [g, list] of groups) {
        const open = presetGroupState[g] !== false;
        const gh = h('div', { class: 'group' }, icon(open ? 'folder-open' : 'folder'), h('span', { style: { marginLeft: '6px' } }, g), icon('chevron-down', 'chev'));
        gh.addEventListener('click', () => { presetGroupState[g] = !open; localStorage.setItem('pj.presetGroups', JSON.stringify(presetGroupState)); renderPresets(); });
        presetsList.appendChild(gh);
        if (!open) continue;
        for (const p of list) {
          const li = h('div', { class: 'li preset', title: p.builtin ? 'Click to apply · hover to preview' : 'Click to apply · right-click for options' },
            h('span', { class: 't' }, p.name));
          li.addEventListener('click', () => applyPreset(p));
          li.addEventListener('mouseenter', () => previewPreset(p));
          li.addEventListener('mouseleave', () => { hoverToken++; navPreview = null; drawNavigator(); });
          li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            UI.menu(e.clientX, e.clientY, [
              { label: 'Apply', icon: 'check', action: () => applyPreset(p) },
              { label: 'Apply to selected photos', icon: 'images', action: () => PJ.App.applyPresetToSelection(p) },
              '-',
              { label: 'Export preset…', icon: 'file-export', action: () => exportPreset(p) },
              { label: 'Rename…', icon: 'pen', hidden: p.builtin, action: async () => { const n = await UI.prompt('Rename preset', p.name); if (n) Cat.renameUserPreset(p.id, n); } },
              { label: 'Update with current settings', icon: 'rotate', hidden: p.builtin || !photo, action: () => { p.settings = Cat.pickGroups(photo.settings, p.groups || Cat.DEFAULT_SYNC); Cat.scheduleSave(); UI.toast(`Updated "${p.name}"`); } },
              { label: 'Delete', icon: 'trash-can', hidden: p.builtin, action: () => Cat.removeUserPreset(p.id) }
            ]);
          });
          presetsList.appendChild(li);
        }
      }
    }
    async function previewPreset(p) {
      if (!photo) return;
      const tok = ++hoverToken;
      await new Promise(r => setTimeout(r, 90));
      if (tok !== hoverToken) return;
      const { partial, groups } = Cat.presetPartial(p);
      const s = Cat.applyGroups(photo.settings, partial, groups);
      try {
        const res = await E.render(photo, s, 'draft', {}, 0);
        if (tok !== hoverToken || !res) return;
        navPreview = E.toCanvas(res);
        navPreview.label = p.name;
        drawNavigator();
      } catch (_) { }
    }
    function applyPreset(p) {
      if (!photo) return UI.toast('Select a photo first', 'circle-info');
      const { partial, groups } = Cat.presetPartial(p);
      photo.settings = Cat.applyGroups(photo.settings, partial, groups);
      Cat.commit(photo, `Preset: ${p.name}`);
      afterExternalChange();
      UI.toast(`Applied "${p.name}"`);
    }
    function createPresetDialog() {
      if (!photo) return UI.toast('Select a photo first', 'circle-info');
      const name = h('input', { type: 'text', placeholder: 'Preset name', autofocus: true, style: { width: '100%' } });
      const group = h('input', { type: 'text', value: 'User Presets', style: { width: '100%' } });
      const edited = Cat.DEFAULT_SYNC.filter(k => Cat.groupEdited(photo.settings, k));
      const checks = groupChecks(edited.length ? edited : Cat.DEFAULT_SYNC);
      UI.modal({
        title: 'New Develop Preset', icon: 'wand-magic-sparkles',
        body: h('div', null,
          h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Name'), name), h('label', { class: 'field' }, h('span', null, 'Group'), group)),
          h('div', { class: 'section-title' }, 'Settings to include'), checks.el),
        buttons: [{ label: 'Cancel' }, {
          label: 'Create', primary: true, onClick: () => {
            const n = name.value.trim();
            if (!n) { name.focus(); return false; }
            const gs = checks.get();
            if (!gs.length) { UI.toast('Choose at least one group of settings', 'circle-info'); return false; }
            Cat.addUserPreset(n, group.value.trim() || 'User Presets', Cat.pickGroups(photo.settings, gs), gs);
            UI.toast(`Preset "${n}" created`);
          }
        }]
      });
    }
    async function exportPreset(p) {
      const json = JSON.stringify({ app: 'photos.jpeg', type: 'preset', name: p.name, group: p.group, groups: p.groups || Cat.groupsInPartial(p.settings), settings: p.settings }, null, 2);
      await PJ.API.savePresetFile(`${p.name.replace(/[^\w\- ]+/g, '_')}.pjpreset.json`, json);
    }
    async function importPresets() {
      const texts = await PJ.API.openPresetFiles();
      let n = 0;
      for (const t of texts || []) {
        try {
          const o = JSON.parse(t);
          const list = Array.isArray(o) ? o : (o.presets || [o]);
          for (const p of list) {
            if (!p.settings) continue;
            Cat.addUserPreset(p.name || 'Imported', p.group || 'Imported', p.settings, p.groups || Cat.groupsInPartial(p.settings));
            n++;
          }
        } catch (_) { }
      }
      UI.toast(n ? `Imported ${n} preset${n > 1 ? 's' : ''}` : 'No presets found', n ? 'circle-check' : 'triangle-exclamation');
    }

    // Snapshots
    const snapList = h('div', { class: 'list' });
    const snapPanel = UI.panel({
      id: 'd-snaps', title: 'Snapshots',
      actions: h('span', { class: 'panel-actions' }, h('button', { title: 'Create snapshot', onclick: (e) => { e.stopPropagation(); createSnapshot(); } }, icon('plus')))
    });
    snapPanel.body.style.padding = '4px 0 8px';
    snapPanel.body.appendChild(snapList);
    async function createSnapshot() {
      if (!photo) return;
      const def = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const n = await UI.prompt('New Snapshot', def, { icon: 'camera' });
      if (!n) return;
      photo.snapshots.push({ name: n, settings: P.clone(photo.settings), t: Date.now() });
      Cat.scheduleSave();
      renderSnapshots();
    }
    function renderSnapshots() {
      snapList.innerHTML = '';
      if (!photo || !photo.snapshots.length) { snapList.appendChild(h('div', { class: 'empty-note' }, 'No snapshots. Click + to save the current state.')); return; }
      photo.snapshots.forEach((sn, i) => {
        const li = h('div', { class: 'li' }, icon('camera'), h('span', { class: 't' }, sn.name),
          h('span', { class: 'x', title: 'Delete', onclick: (e) => { e.stopPropagation(); photo.snapshots.splice(i, 1); Cat.scheduleSave(); renderSnapshots(); } }, icon('xmark')));
        li.addEventListener('click', () => { photo.settings = P.normalizeSettings(P.clone(sn.settings)); Cat.commit(photo, `Snapshot: ${sn.name}`); afterExternalChange(); });
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          UI.menu(e.clientX, e.clientY, [
            { label: 'Update with current settings', icon: 'rotate', action: () => { sn.settings = P.clone(photo.settings); Cat.scheduleSave(); UI.toast('Snapshot updated'); } },
            { label: 'Rename…', icon: 'pen', action: async () => { const n = await UI.prompt('Rename snapshot', sn.name); if (n) { sn.name = n; Cat.scheduleSave(); renderSnapshots(); } } },
            { label: 'Delete', icon: 'trash-can', action: () => { photo.snapshots.splice(i, 1); Cat.scheduleSave(); renderSnapshots(); } }
          ]);
        });
        snapList.appendChild(li);
      });
    }

    // History
    const histList = h('div', { class: 'list history' });
    const histPanel = UI.panel({
      id: 'd-history', title: 'History',
      actions: h('span', { class: 'panel-actions' }, h('button', { title: 'Clear history', onclick: (e) => { e.stopPropagation(); if (photo) Cat.clearHistory(photo); } }, icon('eraser')))
    });
    histPanel.body.style.padding = '4px 0 8px';
    histPanel.body.appendChild(histList);
    function renderHistory() {
      histList.innerHTML = '';
      if (!photo) return;
      const items = photo.history.map((it, i) => ({ it, i })).reverse();
      for (const { it, i } of items) {
        const li = h('div', { class: `li${i === photo.historyIndex ? ' on' : ''}${i > photo.historyIndex ? ' future' : ''}` }, h('span', { class: 't' }, it.label));
        li.addEventListener('click', () => { Cat.gotoHistory(photo, i); });
        li.addEventListener('mouseenter', () => { previewHistory(it); });
        li.addEventListener('mouseleave', () => { hoverToken++; navPreview = null; drawNavigator(); });
        histList.appendChild(li);
      }
    }
    async function previewHistory(it) {
      const tok = ++hoverToken;
      await new Promise(r => setTimeout(r, 120));
      if (tok !== hoverToken || !photo) return;
      const res = await E.render(photo, it.settings, 'draft', {}, 0).catch(() => null);
      if (tok !== hoverToken || !res) return;
      navPreview = E.toCanvas(res); navPreview.label = it.label; drawNavigator();
    }

    left.append(navPanel.el, presetsPanel.el, snapPanel.el, histPanel.el);

    /* ================= RIGHT: histogram, tools, panels ================= */
    const histCanvas = h('canvas');
    const clipLo = h('div', { class: 'clipbtn lo', title: 'Show shadow clipping (J)' });
    const clipHi = h('div', { class: 'clipbtn hi', title: 'Show highlight clipping (J)' });
    const readout = h('div', { class: 'histo-readout' });
    const histBox = h('div', { class: 'histo' }, histCanvas, clipLo, clipHi, readout);
    const exifRow = h('div', { class: 'histo-info' });
    const histWrap = h('div', { style: { padding: '10px 12px', borderBottom: '1px solid var(--border)', background: 'var(--panel)' } }, histBox, exifRow);
    clipLo.addEventListener('click', () => toggleClip('lo'));
    clipHi.addEventListener('click', () => toggleClip('hi'));
    function toggleClip(which) {
      const c = { ...viewer.st.clipping };
      if (which === 'both') { const on = !(c.hi && c.lo); c.hi = c.lo = on; } else c[which] = !c[which];
      viewer.setClipping(c);
      clipLo.classList.toggle('on', c.lo); clipHi.classList.toggle('on', c.hi);
    }
    function updateExifRow() {
      exifRow.innerHTML = '';
      if (!photo) return;
      const e = photo.exif || {};
      exifRow.append(
        h('span', null, e.iso ? `ISO ${e.iso}` : ''),
        h('span', null, e.focalLength ? `${e.focalLength} mm` : ''),
        h('span', null, e.fNumber ? `ƒ/${e.fNumber}` : ''),
        h('span', null, e.exposureTime ? PJ.Decode.formatShutter(e.exposureTime) : ''));
      if (!e.iso && !e.focalLength && !e.fNumber) exifRow.replaceChildren(h('span', null, `${photo.width || '—'} × ${photo.height || '—'}`), h('span', null, photo.format + (photo.isRaw ? ' RAW' : '')));
    }

    // Tool strip
    const tools = [
      { id: 'crop', icon: 'crop-simple', title: 'Crop & Straighten (R)' },
      { id: 'spot', icon: 'bandage', title: 'Spot Removal — heal / clone (Q)' },
      { id: 'mask', icon: 'circle-half-stroke', title: 'Masking — linear, radial, brush (M)' },
      { id: 'wb', icon: 'eye-dropper', title: 'White Balance Selector (W)' }
    ];
    const toolBtns = {};
    const toolstrip = h('div', { class: 'toolstrip' }, tools.map(t => {
      const b = h('button', { title: t.title }, icon(t.icon));
      b.addEventListener('click', () => { if (photo) viewer.setTool(t.id); });
      toolBtns[t.id] = b;
      return b;
    }));
    const toolPane = h('div', { class: 'toolpane hidden' });

    // ---- Basic panel ----
    const basic = UI.panel({ id: 'd-basic', title: 'Basic', icon: 'sun' });
    const treat = UI.seg([{ label: 'Color', value: false }, { label: 'Black & White', value: true }], false, (v) => {
      if (!photo) return; photo.settings.bw = v; Cat.commit(photo, v ? 'Treatment: B&W' : 'Treatment: Color'); viewer.update('commit'); syncAll();
    });
    controls.push({ sync: () => treat.set(!!(photo && photo.settings.bw)) });
    const wbSel = h('select', null, Object.entries(WB_PRESETS).map(([k, v]) => h('option', { value: k }, v.label)));
    wbSel.addEventListener('change', async () => {
      if (!photo) return;
      const k = wbSel.value;
      if (k === 'auto') { const wb = await E.autoWB(photo); photo.settings.temp = wb.temp; photo.settings.tint = wb.tint; }
      else if (WB_PRESETS[k].temp !== undefined) { photo.settings.temp = WB_PRESETS[k].temp; photo.settings.tint = WB_PRESETS[k].tint; }
      photo.settings.wbMode = k;
      Cat.commit(photo, `White Balance: ${WB_PRESETS[k].label}`);
      viewer.update('commit'); syncAll();
    });
    controls.push({ sync: () => { wbSel.value = photo ? photo.settings.wbMode || 'asShot' : 'asShot'; } });
    const pickBtn = h('button', { class: 'btn icon sm', title: 'White balance selector (W)', onclick: () => photo && viewer.setTool('wb') }, icon('eye-dropper'));
    const markCustom = () => { if (photo) photo.settings.wbMode = 'custom'; wbSel.value = 'custom'; };
    basic.body.append(
      h('div', { class: 'row', style: { marginBottom: '10px', justifyContent: 'space-between' } }, h('span', { class: 'muted' }, 'Treatment'), treat.el),
      h('div', { class: 'wbrow' }, h('span', { class: 'muted', style: { width: '28px' } }, 'WB'), wbSel, pickBtn),
      bslider('temp', 'Temp', -100, 100, { rail: 'temp', after: markCustom }),
      bslider('tint', 'Tint', -100, 100, { rail: 'tint', after: markCustom }),
      h('div', { class: 'sub' }, 'Tone', h('button', { class: 'btn sm', style: { marginLeft: 'auto', order: 2 }, onclick: () => autoTone() }, 'Auto')),
      bslider('exposure', 'Exposure', -5, 5, { step: 0.01, decimals: 2 }),
      bslider('contrast', 'Contrast', -100, 100),
      bslider('highlights', 'Highlights', -100, 100),
      bslider('shadows', 'Shadows', -100, 100),
      bslider('whites', 'Whites', -100, 100),
      bslider('blacks', 'Blacks', -100, 100),
      h('div', { class: 'sub' }, 'Presence'),
      bslider('texture', 'Texture', -100, 100),
      bslider('clarity', 'Clarity', -100, 100),
      bslider('dehaze', 'Dehaze', -100, 100),
      bslider('vibrance', 'Vibrance', -100, 100, { rail: 'sat' }),
      bslider('saturation', 'Saturation', -100, 100, { rail: 'sat' })
    );

    // ---- Tone curve ----
    const curvePanel = UI.panel({ id: 'd-curve', title: 'Tone Curve', icon: 'chart-line' });
    let curveMode = 'param';
    const ce = W.curveEditor({
      getPoints: (ch) => photo ? photo.settings.curve[ch] : [[0, 0], [1, 1]],
      setPoints: (ch, pts, phase) => {
        if (!photo) return;
        photo.settings.curve[ch] = pts.map(p => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);
        if (phase === 'commit') Cat.commit(photo, `Point Curve (${ch.toUpperCase()})`);
        viewer.update(phase); refreshEdited();
      },
      getParam: () => photo ? photo.settings.curve : P.defaultSettings().curve,
      getHist: () => lastHist
    });
    const paramSliders = h('div', null,
      bslider('curve.highlights', 'Highlights', -100, 100, { after: () => ce.draw() }),
      bslider('curve.lights', 'Lights', -100, 100, { after: () => ce.draw() }),
      bslider('curve.darks', 'Darks', -100, 100, { after: () => ce.draw() }),
      bslider('curve.shadows', 'Shadows', -100, 100, { after: () => ce.draw() }),
      h('div', { class: 'sub' }, 'Region splits'),
      bslider('curve.split1', 'Split 1', 10, 45, { def: 25, signed: false, after: () => ce.draw() }),
      bslider('curve.split2', 'Split 2', 30, 70, { def: 50, signed: false, after: () => ce.draw() }),
      bslider('curve.split3', 'Split 3', 55, 90, { def: 75, signed: false, after: () => ce.draw() }));
    const curveHint = h('div', { class: 'curve-hint' });
    const curveTabs = h('div', { class: 'tabs-mini' });
    const ctabs = [['param', 'Parametric'], ['rgb', 'Point · RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']];
    ctabs.forEach(([k, l]) => {
      const b = h('button', null, l);
      b.addEventListener('click', () => { curveMode = k; syncCurveMode(); });
      curveTabs.appendChild(b);
    });
    function syncCurveMode() {
      [...curveTabs.children].forEach((b, i) => b.classList.toggle('on', ctabs[i][0] === curveMode));
      paramSliders.classList.toggle('hidden', curveMode !== 'param');
      ce.setMode(curveMode === 'param' ? 'param' : 'point');
      if (curveMode !== 'param') ce.setChannel(curveMode);
      curveHint.textContent = curveMode === 'param' ? 'Drag the region sliders to shape the curve.' : 'Click to add · drag to move · double-click or drag out to remove · right-click for presets';
    }
    syncCurveMode();
    curvePanel.body.append(curveTabs, ce.el, curveHint, paramSliders,
      h('div', { class: 'btnrow' }, h('button', { class: 'btn sm', onclick: () => { if (!photo) return; photo.settings.curve = P.defaultSettings().curve; Cat.commit(photo, 'Reset Tone Curve'); viewer.update('commit'); syncAll(); } }, 'Reset curve')));
    controls.push({ sync: () => ce.draw() });

    // ---- Color mixer (HSL / B&W) ----
    const hslPanel = UI.panel({ id: 'd-hsl', title: 'Color Mixer', icon: 'palette' });
    let hslTab = 'hue';
    const hslTabs = h('div', { class: 'tabs-mini' });
    const hslBody = h('div');
    const HSL_T = [['hue', 'Hue'], ['sat', 'Saturation'], ['lum', 'Luminance'], ['all', 'All']];
    HSL_T.forEach(([k, l]) => { const b = h('button', null, l); b.addEventListener('click', () => { hslTab = k; buildHsl(); }); hslTabs.appendChild(b); });
    const hslControls = [];
    function hslSlider(kind, i) {
      const name = P.HUE_BANDS[i];
      const rail = kind === 'sat' ? null : kind === 'lum' ? 'lum' : null;
      const sl = UI.slider({
        label: name, min: -100, max: 100, def: 0, rail: rail || 'hsl-' + i,
        onInput: (v, phase) => {
          if (!photo) return;
          photo.settings.hsl[kind][i] = v;
          if (phase === 'commit') Cat.commit(photo, `${name} ${kind === 'hue' ? 'Hue' : kind === 'sat' ? 'Saturation' : 'Luminance'}: ${UI.fmtSigned(v, 0)}`);
          viewer.update(phase); refreshEdited();
        }
      });
      // band-colored rail
      const railEl = sl.el.querySelector('.rail');
      const c0 = BAND_COLORS[(i + 7) % 8], c1 = BAND_COLORS[i], c2 = BAND_COLORS[(i + 1) % 8];
      if (kind === 'hue') railEl.style.background = `linear-gradient(90deg, ${c0}, ${c1}, ${c2})`;
      else if (kind === 'sat') railEl.style.background = `linear-gradient(90deg, #777, ${c1})`;
      else railEl.style.background = `linear-gradient(90deg, #111, ${c1}, #fff)`;
      const c = { sync: () => { sl.set(photo ? photo.settings.hsl[kind][i] : 0); sl.setDisabled(!photo); } };
      hslControls.push(c);
      c.sync();
      return sl.el;
    }
    function bwSlider(i) {
      const name = P.HUE_BANDS[i];
      const sl = UI.slider({
        label: name, min: -100, max: 100, def: 0, rail: 'bw',
        onInput: (v, phase) => {
          if (!photo) return;
          photo.settings.bwMix[i] = v;
          if (phase === 'commit') Cat.commit(photo, `B&W ${name}: ${UI.fmtSigned(v, 0)}`);
          viewer.update(phase); refreshEdited();
        }
      });
      sl.el.querySelector('.rail').style.background = `linear-gradient(90deg, #111, ${BAND_COLORS[i]}, #eee)`;
      const c = { sync: () => { sl.set(photo ? photo.settings.bwMix[i] : 0); sl.setDisabled(!photo); } };
      hslControls.push(c); c.sync();
      return sl.el;
    }
    function buildHsl() {
      hslControls.length = 0;
      hslBody.innerHTML = '';
      const bw = photo && photo.settings.bw;
      hslTabs.classList.toggle('hidden', !!bw);
      [...hslTabs.children].forEach((b, i) => b.classList.toggle('on', HSL_T[i][0] === hslTab));
      if (bw) {
        hslBody.append(h('div', { class: 'sub' }, 'Black & White Mix'),
          ...P.HUE_BANDS.map((_, i) => bwSlider(i)),
          h('div', { class: 'btnrow' },
            h('button', { class: 'btn sm', onclick: () => { if (!photo) return; photo.settings.bwMix = [-8, -16, -10, -20, -20, -12, 6, 4]; Cat.commit(photo, 'B&W Mix: Auto'); viewer.update('commit'); buildHsl(); } }, 'Auto'),
            h('button', { class: 'btn sm', onclick: () => { if (!photo) return; photo.settings.bwMix = new Array(8).fill(0); Cat.commit(photo, 'B&W Mix: Reset'); viewer.update('commit'); buildHsl(); } }, 'Reset')));
        return;
      }
      const kinds = hslTab === 'all' ? ['hue', 'sat', 'lum'] : [hslTab];
      for (const k of kinds) {
        if (kinds.length > 1) hslBody.appendChild(h('div', { class: 'sub' }, k === 'hue' ? 'Hue' : k === 'sat' ? 'Saturation' : 'Luminance'));
        P.HUE_BANDS.forEach((_, i) => hslBody.appendChild(hslSlider(k, i)));
      }
      hslBody.appendChild(h('div', { class: 'btnrow' }, h('button', {
        class: 'btn sm', onclick: () => {
          if (!photo) return;
          const ks = hslTab === 'all' ? ['hue', 'sat', 'lum'] : [hslTab];
          ks.forEach(k => { photo.settings.hsl[k] = new Array(8).fill(0); });
          Cat.commit(photo, 'Reset HSL'); viewer.update('commit'); buildHsl();
        }
      }, 'Reset')));
    }
    hslPanel.body.append(hslTabs, hslBody);
    controls.push({ sync: () => buildHsl() });

    // ---- Color grading ----
    const gradePanel = UI.panel({ id: 'd-grading', title: 'Color Grading', icon: 'circle-half-stroke' });
    let gradeView = 'three';
    const gradeTabs = h('div', { class: 'tabs-mini' });
    const gradeBody = h('div');
    const GT = [['three', '3-Way'], ['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights'], ['global', 'Global']];
    GT.forEach(([k, l]) => { const b = h('button', null, l); b.addEventListener('click', () => { gradeView = k; buildGrading(); }); gradeTabs.appendChild(b); });
    const gradeControls = [];
    function wheelFor(zone, label) {
      const wh = W.colorWheel({
        label,
        get: () => photo ? photo.settings.grading[zone] : { h: 0, s: 0 },
        set: (v, phase) => {
          if (!photo) return;
          Object.assign(photo.settings.grading[zone], { h: v.h, s: v.s });
          if (phase === 'commit') Cat.commit(photo, `Color Grading: ${label}`);
          viewer.update(phase); refreshEdited();
        }
      });
      gradeControls.push({ sync: () => wh.draw() });
      return wh.el;
    }
    function gradeLum(zone, label) {
      const sl = UI.slider({
        label, min: -100, max: 100, def: 0, rail: 'lum',
        onInput: (v, phase) => {
          if (!photo) return;
          photo.settings.grading[zone].l = v;
          if (phase === 'commit') Cat.commit(photo, `Color Grading ${label}: ${UI.fmtSigned(v, 0)}`);
          viewer.update(phase); refreshEdited();
        }
      });
      const c = { sync: () => { sl.set(photo ? photo.settings.grading[zone].l : 0); sl.setDisabled(!photo); } };
      gradeControls.push(c); c.sync();
      return sl.el;
    }
    function gradeSat(zone) {
      const sl = UI.slider({
        label: 'Saturation', min: 0, max: 100, def: 0, rail: 'sat',
        onInput: (v, phase) => {
          if (!photo) return;
          photo.settings.grading[zone].s = v;
          if (phase === 'commit') Cat.commit(photo, `Color Grading saturation: ${v}`);
          viewer.update(phase); refreshEdited(); gradeControls.forEach(c => c.sync());
        }
      });
      const c = { sync: () => { sl.set(photo ? photo.settings.grading[zone].s : 0); sl.setDisabled(!photo); } };
      gradeControls.push(c); c.sync();
      return sl.el;
    }
    function gradeHue(zone) {
      const sl = UI.slider({
        label: 'Hue', min: 0, max: 359, def: 0, rail: 'hue',
        onInput: (v, phase) => {
          if (!photo) return;
          photo.settings.grading[zone].h = v;
          if (phase === 'commit') Cat.commit(photo, `Color Grading hue: ${v}`);
          viewer.update(phase); refreshEdited(); gradeControls.forEach(c => c.sync());
        }
      });
      const c = { sync: () => { sl.set(photo ? photo.settings.grading[zone].h : 0); sl.setDisabled(!photo); } };
      gradeControls.push(c); c.sync();
      return sl.el;
    }
    function buildGrading() {
      gradeControls.length = 0;
      gradeBody.innerHTML = '';
      [...gradeTabs.children].forEach((b, i) => b.classList.toggle('on', GT[i][0] === gradeView));
      if (gradeView === 'three') {
        gradeBody.append(
          h('div', { class: 'wheels' }, wheelFor('shadows', 'Shadows'), wheelFor('midtones', 'Midtones'), wheelFor('highlights', 'Highlights')),
          h('div', { style: { height: '6px' } }),
          gradeLum('shadows', 'Shadows Lum'), gradeLum('midtones', 'Midtones Lum'), gradeLum('highlights', 'Highlights Lum'));
      } else {
        const label = GT.find(g => g[0] === gradeView)[1];
        gradeBody.append(h('div', { class: 'wheels single' }, wheelFor(gradeView, label)), gradeHue(gradeView), gradeSat(gradeView), gradeLum(gradeView, 'Luminance'));
      }
      gradeBody.append(h('div', { class: 'sub' }, 'Mix'));
      ['blending', 'balance'].forEach(k => {
        const sl = UI.slider({
          label: k === 'blending' ? 'Blending' : 'Balance', min: k === 'blending' ? 0 : -100, max: 100, def: k === 'blending' ? 50 : 0,
          onInput: (v, phase) => {
            if (!photo) return;
            photo.settings.grading[k] = v;
            if (phase === 'commit') Cat.commit(photo, `Color Grading ${k}: ${v}`);
            viewer.update(phase); refreshEdited();
          }
        });
        const c = { sync: () => { sl.set(photo ? photo.settings.grading[k] : (k === 'blending' ? 50 : 0)); sl.setDisabled(!photo); } };
        gradeControls.push(c); c.sync();
        gradeBody.append(sl.el);
      });
      gradeBody.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn sm', onclick: () => { if (!photo) return; photo.settings.grading = P.defaultSettings().grading; Cat.commit(photo, 'Reset Color Grading'); viewer.update('commit'); buildGrading(); } }, 'Reset')));
    }
    // Auto color grade: a look picked from the scene's own colors
    const styleSel = h('select', { style: { flex: 1, minWidth: 0 }, title: 'Look' }, Object.entries(P.GRADE_STYLES).map(([k, v]) => h('option', { value: k }, v.label)));
    styleSel.value = Cat.pref('grade.style', 'auto');
    styleSel.addEventListener('change', () => Cat.setPref('grade.style', styleSel.value));
    const strengthSeg = UI.seg([{ label: 'Subtle', value: 'subtle' }, { label: 'Normal', value: 'normal' }, { label: 'Strong', value: 'strong' }],
      Cat.pref('grade.strength', 'normal'), (v) => Cat.setPref('grade.strength', v));
    const autoGradeBtn = h('button', { class: 'btn sm primary', title: 'Analyse this photo and set the color grading wheels, vibrance and saturation (Ctrl+Shift+G)' }, icon('wand-magic-sparkles'), 'Auto');
    autoGradeBtn.addEventListener('click', () => { if (photo) PJ.App.autoGradeSelection(styleSel.value, Cat.pref('grade.strength', 'normal')); });
    gradePanel.body.append(
      h('div', { class: 'auto-grade' }, h('div', { class: 'row', style: { gap: '6px' } }, styleSel, autoGradeBtn), h('div', { class: 'row', style: { marginTop: '6px', justifyContent: 'space-between' } }, h('span', { class: 'muted' }, 'Strength'), strengthSeg.el)),
      gradeTabs, gradeBody);
    controls.push({ sync: () => { styleSel.value = Cat.pref('grade.style', 'auto'); } });
    controls.push({ sync: () => { buildGrading(); } });

    // ---- Detail ----
    const detailPanel = UI.panel({ id: 'd-detail', title: 'Detail', icon: 'magnifying-glass-plus', collapsed: true });
    detailPanel.body.append(
      h('div', { class: 'sub' }, 'Sharpening'),
      bslider('detail.sharpen', 'Amount', 0, 150),
      bslider('detail.radius', 'Radius', 0.5, 3, { step: 0.1, decimals: 1, def: 1 }),
      bslider('detail.detail', 'Detail', 0, 100, { def: 25 }),
      bslider('detail.masking', 'Masking', 0, 100),
      h('div', { class: 'sub' }, 'Noise Reduction'),
      h('div', { class: 'btnrow', style: { marginTop: 0, marginBottom: '6px' } },
        h('button', {
          class: 'btn sm', title: 'Set luminance and colour noise reduction for the ISO this photo was taken at',
          onclick: () => {
            if (!photo) return;
            const iso = photo.exif && +photo.exif.iso, nr = P.noiseReductionForIso(iso);
            if (!nr) return UI.toast(iso ? `ISO ${iso} needs no noise reduction` : 'This photo does not record its ISO', 'circle-info');
            Object.assign(photo.settings.detail, nr);
            Cat.commit(photo, `Noise reduction for ISO ${iso}`); viewer.update('commit'); syncAll();
          }
        }, icon('wand-magic-sparkles'), 'Auto for ISO')),
      bslider('detail.nrLuma', 'Luminance', 0, 100),
      bslider('detail.nrDetail', 'Detail', 0, 100, { def: 50 }),
      bslider('detail.nrColor', 'Color', 0, 100),
      h('div', { class: 'curve-hint' }, icon('circle-info'), ' Zoom to 100% (Z) to judge sharpening and noise at full resolution.'));

    // ---- Lens ----
    const lensPanel = UI.panel({ id: 'd-lens', title: 'Lens Corrections', icon: 'camera', collapsed: true });
    // Lens profile: measured from the camera's own corrected preview, remembered per lens
    const lensInfo = h('div', { class: 'muted', style: { fontSize: '11px', margin: '2px 0 8px', lineHeight: 1.4 } });
    const lensDb = h('button', { class: 'btn sm', title: 'Correct this lens\'s distortion and vignetting from the lens database (lensfun), for the focal length and aperture used' }, icon('wand-magic-sparkles'), 'Lens profile');
    const lensOff = h('button', { class: 'btn sm', title: 'Remove the lens profile from this photo' }, icon('xmark'), 'Off');
    const lensAuto = h('button', { class: 'btn sm', title: 'For lenses the database doesn\'t have: measure the distortion from this RAW file\'s own camera preview (remembered per lens)' }, icon('ruler-combined'), 'Match camera');
    const lensAgain = h('button', { class: 'btn sm', title: 'Measure this photo again and replace the stored measurement for its lens' }, icon('rotate'), 'Re-measure');
    function lensStatus() {
      if (!photo) { lensInfo.textContent = ''; return; }
      const applied = photo.settings.lens.profile, prof = PJ.Lens.stored(photo);
      lensInfo.textContent = applied ? `Profile: ${applied}`
        : prof ? `Measured for ${PJ.Lens.lensLabel(photo)}: ${PJ.Lens.describe(prof)}`
          : PJ.Lens.profileKey(photo) ? `${PJ.Lens.lensLabel(photo)} — no profile applied` : 'This photo doesn\'t record its lens';
      lensOff.disabled = !applied;
      lensAgain.disabled = !PJ.Engine.needsDevelop(photo);
      lensAuto.disabled = !prof && !PJ.Engine.needsDevelop(photo);
    }
    async function lensDatabase() {
      const p = photo;
      if (!p) return;
      const before = P.clone(p.settings);
      let text;
      try { text = await PJ.Lens.applyDatabaseProfile(p); }
      catch (e) { p.settings = before; UI.toast(String(e.message || e), 'triangle-exclamation'); return; }
      Cat.commit(p, 'Lens profile');
      if (p === photo) { viewer.update('commit'); syncAll(); }
      UI.toast(text);
    }
    lensDb.addEventListener('click', lensDatabase);
    lensOff.addEventListener('click', () => {
      if (!photo) return;
      PJ.Lens.removeProfile(photo);
      Cat.commit(photo, 'Lens profile off');
      viewer.update('commit'); syncAll();
    });
    async function lensProfile(remeasure) {
      const p = photo;
      if (!p) return;
      let prof = remeasure ? null : PJ.Lens.stored(p);
      if (!prof) {
        lensAuto.disabled = lensAgain.disabled = true;
        lensInfo.textContent = 'Measuring the lens…';
        try { prof = await PJ.Lens.measure(p); }
        catch (e) { UI.toast(String(e.message || e), 'triangle-exclamation'); lensStatus(); return; }
        PJ.Lens.store(p, { distortion: prof.distortion, scale: prof.scale });
      }
      if (p !== photo) return;
      PJ.Lens.applyTo(p, prof);
      Cat.commit(p, `Lens profile: ${PJ.Lens.describe(prof)}`);
      viewer.update('commit');
      syncAll();
      UI.toast(`${PJ.Lens.lensLabel(p)}: ${PJ.Lens.describe(prof)}`);
    }
    lensAuto.addEventListener('click', () => lensProfile(false));
    lensAgain.addEventListener('click', () => lensProfile(true));
    lensPanel.body.append(
      h('div', { class: 'btnrow', style: { marginTop: 0, marginBottom: '4px' } }, lensDb, lensOff),
      h('div', { class: 'btnrow', style: { marginTop: 0, marginBottom: '4px' } }, lensAuto, lensAgain),
      lensInfo,
      h('div', { class: 'sub' }, 'Distortion'),
      bslider('lens.distortion', 'Distortion', -100, 100),
      h('div', { class: 'sub' }, 'Vignetting'),
      bslider('lens.vignette', 'Amount', -100, 100),
      bslider('lens.vigMid', 'Midpoint', 0, 100, { def: 50, signed: false }));

    // ---- Transform ----
    const transPanel = UI.panel({ id: 'd-transform', title: 'Transform', icon: 'vector-square', collapsed: true });
    const orientRow = h('div', { class: 'btnrow', style: { marginTop: 0, marginBottom: '10px' } },
      h('button', { class: 'btn sm', title: 'Rotate left ([)', onclick: () => PJ.App.rotate(-90) }, icon('rotate-left'), 'Left'),
      h('button', { class: 'btn sm', title: 'Rotate right (])', onclick: () => PJ.App.rotate(90) }, icon('rotate-right'), 'Right'),
      h('button', { class: 'btn sm', title: 'Flip horizontal', onclick: () => PJ.App.flip('h') }, icon('left-right'), 'Flip H'),
      h('button', { class: 'btn sm', title: 'Flip vertical', onclick: () => PJ.App.flip('v') }, icon('up-down'), 'Flip V'));
    const uprightBtn = h('button', {
      class: 'btn sm', title: 'Find the vertical lines in the photo (buildings, door frames) and set Vertical, Rotate and Scale so they stand straight',
      onclick: async () => {
        const p = photo;
        if (!p) return;
        uprightBtn.disabled = true;
        try {
          const m = await PJ.Upright.measure(p);
          if (!m.vertical && !m.rotate) { UI.toast('The vertical lines in this photo are already straight', 'circle-info'); return; }
          PJ.Upright.applyTo(p, m);
          Cat.commit(p, 'Auto upright');
          if (p === photo) { viewer.update('commit'); syncAll(); }
          UI.toast(`Straightened using ${m.lines} vertical lines`);
        } catch (e) { UI.toast(String(e.message || e), 'triangle-exclamation'); }
        finally { uprightBtn.disabled = false; }
      }
    }, icon('building'), 'Auto upright');
    transPanel.body.append(orientRow, h('div', { class: 'btnrow', style: { marginTop: 0, marginBottom: '10px' } }, uprightBtn),
      bslider('transform.vertical', 'Vertical', -100, 100),
      bslider('transform.horizontal', 'Horizontal', -100, 100),
      bslider('transform.rotate', 'Rotate', -10, 10, { step: 0.1, decimals: 1 }),
      bslider('transform.aspect', 'Aspect', -100, 100),
      bslider('transform.scale', 'Scale', 50, 150, { def: 100, signed: false }),
      bslider('transform.offX', 'Offset X', -100, 100, { step: 0.5, decimals: 1 }),
      bslider('transform.offY', 'Offset Y', -100, 100, { step: 0.5, decimals: 1 }));

    // ---- Effects ----
    const fxPanel = UI.panel({ id: 'd-effects', title: 'Effects', icon: 'film', collapsed: true });
    fxPanel.body.append(
      h('div', { class: 'sub' }, 'Post-Crop Vignetting'),
      bslider('effects.vigAmount', 'Amount', -100, 100),
      bslider('effects.vigMid', 'Midpoint', 0, 100, { def: 50, signed: false }),
      bslider('effects.vigRound', 'Roundness', -100, 100),
      bslider('effects.vigFeather', 'Feather', 0, 100, { def: 50, signed: false }),
      bslider('effects.vigHighlights', 'Highlights', 0, 100, { signed: false }),
      h('div', { class: 'sub' }, 'Grain'),
      bslider('effects.grain', 'Amount', 0, 100),
      bslider('effects.grainSize', 'Size', 0, 100, { def: 25, signed: false }),
      bslider('effects.grainRough', 'Roughness', 0, 100, { def: 50, signed: false }));

    // ---- Calibration ----
    const calPanel = UI.panel({ id: 'd-calib', title: 'Calibration', icon: 'sliders', collapsed: true });
    calPanel.body.append(
      h('div', { class: 'sub' }, 'Shadows'),
      bslider('calib.shadowTint', 'Tint', -100, 100, { rail: 'tint' }),
      h('div', { class: 'sub' }, 'Red Primary'),
      bslider('calib.redHue', 'Hue', -100, 100), bslider('calib.redSat', 'Saturation', -100, 100),
      h('div', { class: 'sub' }, 'Green Primary'),
      bslider('calib.greenHue', 'Hue', -100, 100), bslider('calib.greenSat', 'Saturation', -100, 100),
      h('div', { class: 'sub' }, 'Blue Primary'),
      bslider('calib.blueHue', 'Hue', -100, 100), bslider('calib.blueSat', 'Saturation', -100, 100));

    // ---- Video (input profile, clip info, optimized media) ----
    const vidPanel = UI.panel({ id: 'd-video', title: 'Video', icon: 'film' });
    const profSel = h('select', { style: { flex: 1 } }, Object.entries(P.INPUT_PROFILES).filter(([, v]) => !v.internal).map(([k, v]) => h('option', { value: k }, v.label)));
    profSel.addEventListener('change', () => {
      if (!photo) return;
      photo.settings.input.profile = profSel.value;
      Cat.commit(photo, `Input: ${P.INPUT_PROFILES[profSel.value].label}`);
      viewer.update('commit'); syncAll();
    });
    const vidInfo = h('div', { class: 'muted', style: { fontSize: '11px', lineHeight: '1.6', margin: '8px 0 4px' } });
    const proxyBtn = h('button', { class: 'btn sm' }, icon('gears'), 'Create optimized media');
    proxyBtn.addEventListener('click', async () => {
      if (!photo) return;
      try { await PJ.Video.ensureProxy(photo); UI.toast('Optimized media ready'); viewer.setPhoto(photo); } catch (e) { UI.toast(String(e.message || e), 'triangle-exclamation'); }
    });
    const rolloffSl = bslider('input.rolloff', 'Highlight Rolloff', 0, 100, { def: 50, signed: false });
    // Stabilization
    const stabSl = bslider('stab.amount', 'Stabilize', 0, 100, { def: 0, signed: false });
    const stabInfo = h('div', { class: 'muted small' });
    const stabBtn = h('button', { class: 'btn sm' }, icon('crosshairs'), 'Analyse motion');
    let stabJob = null;
    stabBtn.addEventListener('click', async () => {
      if (!photo || photo.kind !== 'video') return;
      if (stabJob) { stabJob.cancelled = true; return; }
      const p = photo, job = stabJob = { cancelled: false };
      stabBtn.replaceChildren(icon('stop'), 'Cancel');
      try {
        await PJ.Stabilize.analyze(p, (f, msg) => { UI.activity(msg, f); stabInfo.textContent = msg; }, job);
        if (!p.settings.stab || !p.settings.stab.amount) { p.settings.stab = { amount: 50 }; Cat.commit(p, 'Stabilize: 50'); }
        PJ.Engine.invalidate(p);
        viewer.refreshFrame();
        UI.toast('Motion analysed — adjust Stabilize to taste', 'crosshairs');
      } catch (e) { if (!job.cancelled) UI.toast(`Stabilization: ${e.message || e}`, 'triangle-exclamation'); }
      finally { stabJob = null; UI.activity(''); syncAll(); }
    });
    vidPanel.body.append(
      h('div', { class: 'wbrow' }, h('span', { class: 'muted', style: { width: '52px' } }, 'Profile'), profSel),
      rolloffSl,
      h('div', { class: 'curve-hint' }, 'Choose the log curve the clip was shot in (Apple Log, S-Log3, V-Log, Canon Log 3, F-Log, N-Log, D-Log). Footage is converted to Rec.709 before grading; Highlight Rolloff softens clipping.'),
      h('div', { class: 'section-title' }, 'Stabilization'),
      stabSl, h('div', { class: 'btnrow' }, stabBtn), stabInfo,
      h('div', { class: 'section-title' }, 'Animation'),
      h('div', { class: 'curve-hint' }, 'Press K (or ◆ on the timeline) to add a keyframe. With keyframes, every edit is stored at the playhead and the clip animates smoothly between them — exposure ramps, white balance shifts, moving masks, push-ins with Crop.'),
      vidInfo,
      h('div', { class: 'btnrow' }, proxyBtn));
    controls.push({
      sync: () => {
        const isVid = !!(photo && photo.kind === 'video');
        vidPanel.el.style.display = isVid ? '' : 'none';
        if (toolBtns.spot) toolBtns.spot.style.display = isVid ? 'none' : '';
        if (!isVid) return;
        const inp = photo.settings.input || { profile: 'none' };
        profSel.value = P.INPUT_PROFILES[inp.profile] && !P.INPUT_PROFILES[inp.profile].internal ? inp.profile : 'none';
        profSel.disabled = !!(photo.video && photo.video.cdng);
        rolloffSl.style.display = inp.profile === 'none' ? 'none' : '';
        const st = photo.video && photo.video.stab;
        if (!stabJob) {
          stabBtn.replaceChildren(icon('crosshairs'), st ? 'Re-analyse motion' : 'Analyse motion');
          stabInfo.textContent = st ? `Motion analysed (${st.n} frames${st.lost ? `, ${st.lost} without a reliable match` : ''}).${photo.settings.stab && photo.settings.stab.amount ? ` Zoom ${Math.round((PJ.Stabilize.corrections(photo, photo.settings.stab.amount, (photo.video.width || 16) / (photo.video.height || 9)).zoom - 1) * 100)}% to hide edges.` : ''}` : 'Analyse the clip once, then set how smooth the camera should be.';
        }
        stabSl.style.opacity = st ? '' : '0.45';
        const v = photo.video || {};
        vidInfo.replaceChildren(...[
          [v.codecName, v.bitDepth > 8 ? `${v.bitDepth}-bit` : '', v.hdr].filter(Boolean).join(' · '),
          [v.width && `${v.width} × ${v.height}`, v.fps && `${+v.fps.toFixed(3)} fps`, v.duration && PJ.Video.timecode(v.duration, v.fps)].filter(Boolean).join(' · '),
          v.audio ? `Audio: ${v.audio.codecName}, ${v.audio.channels} ch` : '',
          v.cdng ? 'CinemaDNG — decoded as RAW (linear, camera white balance)' : '',
          v.proxy ? 'Playing from optimized media' : ''
        ].filter(Boolean).map(t => h('div', null, t)));
        proxyBtn.style.display = API.isDesktop && API.videoTool && !v.cdng && !v.proxy ? '' : 'none';
      }
    });

    // ---- LUT (imported .cube files) ----
    const lutPanel = UI.panel({ id: 'd-lut', title: 'LUT', icon: 'swatchbook' });
    const lutSel = h('select', { style: { flex: 1, minWidth: 0 } });
    const lutStage = UI.seg([{ label: 'Look', value: 'look', title: 'Creative LUT applied after your edits (sRGB in, sRGB out)' },
      { label: 'Camera', value: 'input', title: 'Technical LUT applied to the camera’s values first (e.g. log → Rec.709)' }], 'look', (v) => {
      if (!photo) return; photo.settings.lut.stage = v; Cat.commit(photo, `LUT: ${v === 'input' ? 'camera' : 'look'}`); viewer.update('commit'); syncAll();
    });
    const lutAmt = bslider('lut.amount', 'Amount', 0, 100, { def: 100, signed: false });
    function fillLuts() {
      const cur = photo && photo.settings.lut ? photo.settings.lut.id : '';
      lutSel.replaceChildren(h('option', { value: '' }, 'None'),
        ...PJ.LUTs.list().slice().sort((a, b) => a.name.localeCompare(b.name)).map(l => h('option', { value: l.id }, l.name)),
        h('option', { disabled: true }, '──────────'), h('option', { value: '__import' }, 'Import .cube files…'));
      lutSel.value = PJ.LUTs.find(cur) ? cur : '';
    }
    lutSel.addEventListener('change', async () => {
      if (!photo) return;
      let id = lutSel.value;
      if (id === '__import') {
        const r = await PJ.LUTs.importFiles();
        fillLuts();
        if (!r.added.length) { syncAll(); return; }
        id = r.added[r.added.length - 1].id;
      }
      photo.settings.lut.id = id;
      if (id) await PJ.LUTs.get(id);
      Cat.commit(photo, id ? `LUT: ${PJ.LUTs.find(id).name}` : 'LUT: none');
      viewer.update('commit'); syncAll();
    });
    const lutMore = h('button', { class: 'btn icon sm', title: 'LUT options' }, icon('ellipsis'));
    lutMore.addEventListener('click', (e) => {
      const cur = photo && photo.settings.lut.id && PJ.LUTs.find(photo.settings.lut.id);
      const r = lutMore.getBoundingClientRect();
      UI.menu(r.left, r.bottom + 4, [
        { label: 'Import .cube files…', icon: 'file-import', action: async () => { await PJ.LUTs.importFiles(); fillLuts(); } },
        { label: 'Export this look as .cube…', icon: 'file-export', disabled: !photo, action: () => photo && PJ.LUTs.exportLook(photo) },
        '-',
        { label: cur ? `Rename “${cur.name}”…` : 'Rename LUT…', icon: 'pen', disabled: !cur, action: async () => { const n = await UI.prompt('Rename LUT', cur.name); if (n) { PJ.LUTs.rename(cur.id, n); fillLuts(); } } },
        { label: cur ? `Remove “${cur.name}”` : 'Remove LUT', icon: 'trash-can', disabled: !cur, action: () => { PJ.LUTs.remove(cur.id); fillLuts(); viewer.update('commit'); syncAll(); } }
      ]);
    });
    lutPanel.body.append(
      h('div', { class: 'wbrow' }, h('span', { class: 'muted', style: { width: '52px' } }, 'LUT'), lutSel, lutMore),
      h('div', { class: 'wbrow' }, h('span', { class: 'muted', style: { width: '52px' } }, 'Apply'), lutStage.el),
      lutAmt,
      h('div', { class: 'curve-hint' }, 'Import 3D or 1D .cube LUTs from Resolve, Premiere, camera makers or LUT packs. “Camera” LUTs convert log footage before grading; “Look” LUTs go on top of your edits.'));
    PJ.LUTs.events.on('changed', fillLuts);
    controls.push({ sync: () => { fillLuts(); lutStage.set(photo ? photo.settings.lut.stage || 'look' : 'look'); lutSel.disabled = !photo; lutPanel.setEdited(!!(photo && photo.settings.lut.id)); } });

    const panelMap = { tone: basic, wb: basic, presence: basic, curve: curvePanel, hsl: hslPanel, bw: hslPanel, grading: gradePanel, detail: detailPanel, lens: lensPanel, transform: transPanel, effects: fxPanel, calib: calPanel };
    function refreshEdited() {
      if (!photo) { Object.values(panelMap).forEach(p => p.setEdited(false)); return; }
      const ed = {};
      for (const g of Cat.GROUPS) if (panelMap[g.key]) ed[g.key] = Cat.groupEdited(photo.settings, g.key);
      basic.setEdited(ed.tone || ed.wb || ed.presence);
      curvePanel.setEdited(ed.curve); hslPanel.setEdited(ed.hsl || ed.bw); gradePanel.setEdited(ed.grading);
      detailPanel.setEdited(ed.detail); lensPanel.setEdited(ed.lens); transPanel.setEdited(ed.transform);
      fxPanel.setEdited(ed.effects); calPanel.setEdited(ed.calib);
    }

    const footer = h('div', { style: { display: 'flex', gap: '6px', padding: '10px 12px', position: 'sticky', bottom: 0, background: 'var(--panel)', borderTop: '1px solid var(--border)' } },
      h('button', { class: 'btn grow', title: 'Apply the settings of the previously selected photo', onclick: () => previous() }, 'Previous'),
      h('button', { class: 'btn grow', title: 'Reset all develop settings (Ctrl+Shift+R)', onclick: () => resetAll() }, 'Reset'));

    right.append(histWrap, toolstrip, toolPane, vidPanel.el, basic.el, lutPanel.el, curvePanel.el, hslPanel.el, gradePanel.el, detailPanel.el, lensPanel.el, transPanel.el, fxPanel.el, calPanel.el, footer);

    /* ================= Tool panes ================= */
    function buildToolPane() {
      const t = viewer.st.tool;
      Object.entries(toolBtns).forEach(([k, b]) => b.classList.toggle('on', k === t));
      toolPane.innerHTML = '';
      toolPane.classList.toggle('hidden', !['crop', 'spot', 'mask', 'wb'].includes(t));
      if (t === 'crop') buildCropPane();
      else if (t === 'spot') buildSpotPane();
      else if (t === 'mask') buildMaskPane();
      else if (t === 'wb') toolPane.append(h('h4', null, icon('eye-dropper'), 'White Balance Selector'), h('div', { class: 'muted' }, 'Click a neutral (grey or white) area in the photo. Press W or Esc to cancel.'));
    }
    let cropAngleSl = null;
    let brushSizeSl = null;
    viewer.events.on('brush', () => { if (brushSizeSl) brushSizeSl.set(viewer.st.brush.size); });
    function buildCropPane() {
      const st = viewer.st;
      const asp = h('select', { style: { flex: 1 } }, viewer.ASPECTS.map(a => h('option', { value: a.key }, a.label)), h('option', { value: 'custom', hidden: true }, 'Custom'));
      asp.value = st.crop ? st.crop.aspect : 'original';
      asp.addEventListener('change', () => viewer.setCropAspect(asp.value));
      const lock = UI.checkbox('Lock', st.crop ? st.crop.aspect !== 'free' : true, (b) => { viewer.setCropLock(b); if (!b) { asp.value = 'free'; viewer.setCropAspect('free'); } });
      cropAngleSl = UI.slider({
        label: 'Angle', min: -45, max: 45, step: 0.05, decimals: 2, def: 0, suffix: '°',
        value: photo ? photo.settings.geo.angle : 0,
        onInput: (v, phase) => viewer.setStraighten(v, phase)
      });
      toolPane.append(
        h('h4', null, icon('crop-simple'), 'Crop & Straighten', h('span', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => viewer.resetCrop() }, 'Reset')),
        h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted', style: { width: '44px' } }, 'Aspect'), asp, lock.el,
          h('button', { class: 'btn sm icon', title: 'Swap orientation (X)', onclick: () => viewer.swapCropOrientation() }, icon('arrows-rotate'))),
        cropAngleSl.el,
        h('div', { class: 'btnrow' },
          h('button', { class: 'btn sm', title: 'Rotate left', onclick: () => PJ.App.rotate(-90) }, icon('rotate-left')),
          h('button', { class: 'btn sm', title: 'Rotate right', onclick: () => PJ.App.rotate(90) }, icon('rotate-right')),
          h('button', { class: 'btn sm', title: 'Flip horizontal', onclick: () => PJ.App.flip('h') }, icon('left-right')),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm', onclick: () => viewer.cancelCrop() }, 'Cancel'),
          h('button', { class: 'btn sm primary', onclick: () => viewer.setTool('crop') }, 'Done')),
        h('div', { class: 'curve-hint' }, 'Drag corners to resize · drag inside to move · drag outside to rotate · Shift toggles aspect lock · Enter to apply, Esc to cancel'));
    }
    function buildSpotPane() {
      const st = viewer.st;
      const mode = UI.seg([{ label: 'Heal', value: 'heal' }, { label: 'Clone', value: 'clone' }], st.spotMode, (v) => {
        st.spotMode = v;
        const sp = photo && photo.settings.spots[st.spotSel];
        if (sp) { sp.mode = v; Cat.commit(photo, 'Spot mode'); viewer.update('commit'); }
      });
      const spotSl = (label, key, min, max, step, toSpot, fromSpot) => UI.slider({
        label, min, max, step, decimals: step < 1 ? 1 : 0,
        value: st[key] * (key === 'spotSize' ? 100 : 1), def: key === 'spotSize' ? 2 : key === 'spotFeather' ? 50 : 100,
        onInput: (v, phase) => {
          st[key] = key === 'spotSize' ? v / 100 : v;
          const sp = photo && photo.settings.spots[st.spotSel];
          if (sp) { toSpot(sp, v); if (phase === 'commit') Cat.commit(photo, `Spot ${label}`); viewer.update(phase); }
          else viewer.draw();
        }
      });
      const size = spotSl('Size', 'spotSize', 0.3, 12, 0.1, (sp, v) => { sp.r = v / 100; });
      const feather = spotSl('Feather', 'spotFeather', 0, 100, 1, (sp, v) => { sp.feather = v; });
      const opacity = spotSl('Opacity', 'spotOpacity', 0, 100, 1, (sp, v) => { sp.opacity = v; });
      const sp = photo && photo.settings.spots[st.spotSel];
      if (sp) { size.set(sp.r * 100); feather.set(sp.feather ?? 50); opacity.set(sp.opacity ?? 100); }
      toolPane.append(
        h('h4', null, icon('bandage'), 'Spot Removal', h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${photo ? photo.settings.spots.length : 0} spots`)),
        h('div', { class: 'row', style: { marginBottom: '8px' } }, mode.el, h('span', { class: 'spacer' }),
          UI.checkbox('Show', st.spotsVisible, (b) => { st.spotsVisible = b; viewer.draw(); }).el),
        size.el, feather.el, opacity.el,
        h('div', { class: 'btnrow' },
          h('button', { class: 'btn sm', disabled: st.spotSel < 0, onclick: () => viewer.deleteSelectedSpot() }, icon('trash-can'), 'Delete'),
          h('button', { class: 'btn sm', onclick: () => { if (!photo || !photo.settings.spots.length) return; photo.settings.spots = []; st.spotSel = -1; Cat.commit(photo, 'Clear spots'); viewer.update('commit'); buildToolPane(); } }, 'Clear all'),
          h('span', { class: 'spacer' }), h('button', { class: 'btn sm primary', onclick: () => viewer.setTool('spot') }, 'Done')),
        h('div', { class: 'curve-hint' }, 'Click a blemish to heal it — a matching source is picked automatically. Drag circles to adjust · Alt-drag moves only the target · Delete removes the selected spot.'));
    }
    let aiBusy = false;
    function buildMaskPane() {
      const st = viewer.st;
      const masks = photo ? photo.settings.masks : [];
      const add = (type, ic, label) => h('button', { class: `btn sm${st.maskCreate === type ? ' active' : ''}`, onclick: () => viewer.startMask(type), title: `New ${label}` }, icon(ic), label);
      // Subject / Sky / People: found by a small neural network on this computer, then an ordinary brush mask
      const addAi = (kind, ic, label) => {
        const b = h('button', {
          class: 'btn sm', title: `Mask the ${label.toLowerCase()} automatically — then adjust it like any mask, or touch it up with the brush`,
          onclick: async () => {
            const p = photo;
            if (!p || aiBusy) return;
            aiBusy = true; b.disabled = true;
            UI.activity(PJ.AIMask.KINDS[kind].busy, null);
            try {
              const fields = await PJ.AIMask.create(p, kind);
              if (p === photo) viewer.addMask(fields);
            } catch (e) { UI.toast(String(e.message || e), 'triangle-exclamation'); }
            finally { aiBusy = false; UI.activity(''); if (b.isConnected) b.disabled = false; }
          }
        }, icon(ic), label);
        b.disabled = aiBusy || !photo || photo.kind === 'video';
        return b;
      };
      const list = h('div', { class: 'mask-list' });
      masks.forEach((m, i) => {
        const ic = m.ai === 'subject' ? 'user-large' : m.ai === 'sky' ? 'cloud-sun' : m.ai === 'people' ? 'people-group' : m.type === 'linear' ? 'grip-lines' : m.type === 'radial' ? 'circle' : 'paintbrush';
        const item = h('div', { class: `mask-item${i === st.maskIdx ? ' on' : ''}` },
          h('span', { class: 'mi-ic' }, icon(ic)),
          h('span', { class: 'mi-n' }, m.name + (m.invert ? ' (inv)' : '')),
          h('button', { title: m.visible === false ? 'Show' : 'Hide', onclick: (e) => { e.stopPropagation(); m.visible = m.visible === false; Cat.commit(photo, 'Toggle mask'); viewer.update('commit'); buildToolPane(); } }, icon(m.visible === false ? 'eye-slash' : 'eye')),
          h('button', { title: 'Delete mask', onclick: (e) => { e.stopPropagation(); masks.splice(i, 1); if (st.maskIdx >= masks.length) st.maskIdx = masks.length - 1; Cat.commit(photo, 'Delete mask'); viewer.update('commit'); buildToolPane(); } }, icon('trash-can')));
        item.addEventListener('click', () => { viewer.selectMask(i); });
        item.addEventListener('dblclick', async () => { const n = await UI.prompt('Rename mask', m.name); if (n) { m.name = n; Cat.commit(photo, 'Rename mask'); buildToolPane(); } });
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          UI.menu(e.clientX, e.clientY, [
            { label: 'Duplicate', icon: 'clone', action: () => { const c = P.clone(m); c.id = Cat.uid('mk_'); c.name += ' copy'; masks.splice(i + 1, 0, c); st.maskIdx = i + 1; Cat.commit(photo, 'Duplicate mask'); viewer.update('commit'); buildToolPane(); } },
            { label: m.invert ? 'Un-invert' : 'Invert', icon: 'circle-half-stroke', action: () => { m.invert = !m.invert; Cat.commit(photo, 'Invert mask'); viewer.update('commit'); buildToolPane(); } },
            { label: 'Rename…', icon: 'pen', action: async () => { const n = await UI.prompt('Rename mask', m.name); if (n) { m.name = n; Cat.commit(photo, 'Rename mask'); buildToolPane(); } } },
            { label: 'Delete', icon: 'trash-can', action: () => { masks.splice(i, 1); st.maskIdx = Math.min(st.maskIdx, masks.length - 1); Cat.commit(photo, 'Delete mask'); viewer.update('commit'); buildToolPane(); } }
          ]);
        });
        list.appendChild(item);
      });
      if (!masks.length) list.appendChild(h('div', { class: 'muted', style: { padding: '4px 2px 6px' } }, 'No masks yet. Pick a type above, then drag (or paint) on the photo.'));
      const overlay = UI.checkbox('Show overlay (O)', st.maskOverlay, (b) => viewer.setMaskOverlay(b));
      toolPane.append(
        h('h4', null, icon('circle-half-stroke'), 'Masking', h('span', { class: 'spacer' }), overlay.el),
        h('div', { class: 'add-row' }, add('linear', 'grip-lines', 'Linear'), add('radial', 'circle', 'Radial'), add('brush', 'paintbrush', 'Brush')),
        PJ.AIMask ? h('div', { class: 'add-row' }, addAi('subject', 'user-large', 'Subject'), addAi('sky', 'cloud-sun', 'Sky'), addAi('people', 'people-group', 'People')) : null,
        list);
      const m = viewer.activeMask();
      if (!m) {
        toolPane.append(h('div', { class: 'btnrow' }, h('span', { class: 'spacer' }), h('button', { class: 'btn sm primary', onclick: () => viewer.setTool('mask') }, 'Done')));
        return;
      }
      const mslider = (label, get, set, min, max, def, rail, step) => {
        const sl = UI.slider({
          label, min, max, step: step || 1, def: def ?? 0, value: get(), rail, decimals: step && step < 1 ? 2 : 0,
          onInput: (v, phase) => { set(v); if (phase === 'commit') Cat.commit(photo, `${m.name}: ${label}`); viewer.update(phase); }
        });
        return sl.el;
      };
      const shape = h('div', { class: 'tool-opts' });
      if (m.type === 'radial') {
        shape.append(mslider('Feather', () => m.feather ?? 50, v => { m.feather = v; }, 0, 100, 50),
          mslider('Angle', () => m.angle || 0, v => { m.angle = v; }, -90, 90, 0));
      } else if (m.type === 'brush') {
        const b = st.brush;
        const erase = UI.seg([{ label: 'Paint', value: false }, { label: 'Erase', value: true }], b.erase, (v) => { b.erase = v; });
        const sz = UI.slider({ label: 'Size', min: 4, max: 800, def: 80, value: b.size, suffix: ' px', signed: false, onInput: (v) => { b.size = v; } });
        brushSizeSl = sz;
        shape.append(h('div', { class: 'row', style: { marginBottom: '4px' } }, erase.el, h('span', { class: 'muted', style: { marginLeft: 'auto' } }, 'Alt = erase · wheel = size')),
          sz.el,
          UI.slider({ label: 'Feather', min: 0, max: 100, def: 50, value: b.feather, signed: false, onInput: (v) => { b.feather = v; } }).el,
          UI.slider({ label: 'Flow', min: 1, max: 100, def: 70, value: b.flow, signed: false, onInput: (v) => { b.flow = v; } }).el);
      }
      shape.append(
        UI.checkbox('Invert mask', !!m.invert, (v) => { m.invert = v; Cat.commit(photo, 'Invert mask'); viewer.update('commit'); }).el,
        mslider('Amount', () => m.amount ?? 100, v => { m.amount = v; }, 0, 200, 100),
        h('div', { class: 'sub' }, 'Luminance range'),
        mslider('Min', () => m.lumMin ?? 0, v => { m.lumMin = Math.min(v, (m.lumMax ?? 100) - 1); }, 0, 100, 0),
        mslider('Max', () => m.lumMax ?? 100, v => { m.lumMax = Math.max(v, (m.lumMin ?? 0) + 1); }, 0, 100, 100),
        mslider('Smooth', () => m.lumSmooth ?? 20, v => { m.lumSmooth = v; }, 0, 100, 20));
      // Colour range: keep only the part of the mask near one colour (a blue sky, a red coat)
      const swatch = h('span', { class: 'hue-swatch', style: { background: `hsl(${m.colHue ?? 0} 85% 50%)` } });
      shape.append(
        h('div', { class: 'sub' }, 'Colour range'),
        h('div', { class: 'row', style: { marginBottom: '4px' } },
          UI.checkbox('Limit to a colour', !!m.colOn, (v) => { m.colOn = v; if (m.colHue == null) m.colHue = 210; if (m.colRange == null) m.colRange = 30; Cat.commit(photo, v ? 'Mask: limit to a colour' : 'Mask: any colour'); viewer.update('commit'); buildToolPane(); }).el,
          h('span', { class: 'spacer' }), swatch,
          h('button', {
            class: 'btn icon sm', title: 'Pick the colour from the photo',
            onclick: () => viewer.pickColor((hue) => { m.colOn = true; m.colHue = hue; if (m.colRange == null) m.colRange = 30; Cat.commit(photo, 'Mask: colour picked'); viewer.update('commit'); buildToolPane(); })
          }, icon('eye-dropper'))));
      if (m.colOn) shape.append(
        mslider('Hue', () => m.colHue ?? 0, v => { m.colHue = v; swatch.style.background = `hsl(${v} 85% 50%)`; }, 0, 360, 210),
        mslider('Range', () => m.colRange ?? 30, v => { m.colRange = v; }, 5, 180, 30));
      // Combine: narrow this mask by another one of the photo
      const others = masks.filter(o => o !== m);
      if (others.length) {
        const sel = h('select', {
          style: { flex: '1', minWidth: '0' }, onchange: () => {
            const [mode, id] = sel.value.split(':');
            if (mode === 'none') delete m.limit; else m.limit = { id, mode };
            Cat.commit(photo, 'Mask: combine'); viewer.update('commit');
          }
        }, h('option', { value: 'none:' }, 'On its own'),
          ...others.map(o => h('option', { value: 'intersect:' + o.id }, 'Only inside “' + o.name + '”')),
          ...others.map(o => h('option', { value: 'subtract:' + o.id }, 'Not inside “' + o.name + '”')));
        sel.value = m.limit && others.some(o => o.id === m.limit.id) ? m.limit.mode + ':' + m.limit.id : 'none:';
        shape.append(h('div', { class: 'sub' }, 'Combine'), h('div', { class: 'row', style: { marginBottom: '6px' } }, sel));
      }
      const adj = m.adj;
      const A = (key, label, min, max, rail, step) => mslider(label, () => adj[key] || 0, v => { adj[key] = v; }, min, max, 0, rail, step);
      toolPane.append(shape,
        h('div', { class: 'sub' }, 'Adjustments', h('button', { class: 'btn sm', style: { order: 2, marginLeft: 'auto' }, onclick: () => { m.adj = P.defaultLocalAdj(); Cat.commit(photo, 'Reset mask adjustments'); viewer.update('commit'); buildToolPane(); } }, 'Reset')),
        A('temp', 'Temp', -100, 100, 'temp'), A('tint', 'Tint', -100, 100, 'tint'),
        A('exposure', 'Exposure', -4, 4, null, 0.01), A('contrast', 'Contrast', -100, 100),
        A('highlights', 'Highlights', -100, 100), A('shadows', 'Shadows', -100, 100),
        A('whites', 'Whites', -100, 100), A('blacks', 'Blacks', -100, 100),
        A('texture', 'Texture', -100, 100), A('clarity', 'Clarity', -100, 100),
        A('dehaze', 'Dehaze', -100, 100), A('saturation', 'Saturation', -100, 100, 'sat'),
        h('div', { class: 'btnrow' }, h('span', { class: 'spacer' }), h('button', { class: 'btn sm primary', onclick: () => viewer.setTool('mask') }, 'Done')));
    }

    /* ================= Toolbars ================= */
    const nameEl = h('span', { style: { fontWeight: 600 } });
    const subEl = h('span', { class: 'muted' });
    topbar.append(nameEl, subEl);

    const cmp = UI.seg([
      { icon: 'square', value: 'single', title: 'Loupe (single view)' },
      { icon: 'table-columns', value: 'side', title: 'Before / After — left / right (Y)' },
      { icon: 'grip-lines', value: 'topbottom', title: 'Before / After — top / bottom (Alt+Y)' },
      { icon: 'arrows-left-right-to-line', value: 'split', title: 'Before / After — split (Shift+Y)' }
    ], 'single', (v) => viewer.setCompare(v));
    const zoomSeg = UI.seg([{ label: 'Fit', value: 'fit' }, { label: 'Fill', value: 'fill' }, { label: '1:1', value: 1 }, { label: '2:1', value: 2 }], 'fit', (v) => viewer.setZoom(v));
    const beforeBtn = h('button', { class: 'btn sm', title: 'Hold to see the original (\\)' }, icon('eye'), 'Before');
    beforeBtn.addEventListener('pointerdown', () => viewer.holdBefore(true));
    ['pointerup', 'pointerleave'].forEach(ev => beforeBtn.addEventListener(ev, () => viewer.st.holdBefore && viewer.holdBefore(false)));
    const bgSel = h('select', { title: 'Background' }, ['dark', 'grey', 'black', 'white'].map(b => h('option', { value: b }, b[0].toUpperCase() + b.slice(1))));
    bgSel.addEventListener('change', () => viewer.setBg(bgSel.value));
    bottombar.append(
      h('label', { class: 'lbl' }, 'View'), cmp.el, beforeBtn,
      h('span', { class: 'sep' }),
      h('label', { class: 'lbl' }, 'Zoom'), zoomSeg.el,
      h('span', { class: 'sep' }),
      h('button', { class: 'btn sm', title: 'Cycle info overlay (I)', onclick: () => viewer.cycleInfo() }, icon('circle-info')),
      h('label', { class: 'lbl' }, 'Bg'), bgSel,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', title: 'Copy settings (Ctrl+Shift+C)', onclick: () => PJ.App.copySettings() }, icon('copy'), 'Copy…'),
      h('button', { class: 'btn sm', title: 'Paste settings (Ctrl+Shift+V)', onclick: () => PJ.App.pasteSettings() }, icon('paste'), 'Paste'),
      h('button', { class: 'btn sm', title: 'Sync settings to selected photos', onclick: () => PJ.App.syncSettings() }, icon('arrows-rotate'), 'Sync…'));
    viewer.events.on('zoom', () => { const z = viewer.st.zoom; zoomSeg.set(typeof z === 'number' && z !== 1 && z !== 2 ? null : z); drawNavigator(); });
    viewer.events.on('compare', () => cmp.set(viewer.st.compare));

    /* ================= Events from viewer ================= */
    viewer.events.on('rendered', (res) => {
      lastHist = res.hist;
      W.drawHistogram(histCanvas, res.hist);
      const tot = res.width * res.height || 1;
      clipHi.classList.toggle('warn', res.clip.hi / tot > 0.002);
      clipLo.classList.toggle('warn', res.clip.lo / tot > 0.002);
      if (!navPreview) drawNavigator();
      if (curveMode !== 'param' || true) ce.draw();
    });
    viewer.events.on('view', () => { if (!navPreview) drawNavigator(); });
    viewer.events.on('tool', () => { buildToolPane(); });
    viewer.events.on('masks', () => { if (viewer.st.tool === 'mask') buildToolPane(); });
    viewer.events.on('spotSel', () => { if (viewer.st.tool === 'spot') buildToolPane(); });
    viewer.events.on('geo', () => { if (cropAngleSl && photo) cropAngleSl.set(photo.settings.geo.angle); });
    viewer.events.on('toolDone', () => { viewer.setTool('none'); syncAll(); });
    viewer.events.on('settings', () => syncAll());
    viewer.events.on('error', (e) => { UI.toast(`Couldn't open photo: ${e.message || e}`, 'triangle-exclamation'); });
    viewer.events.on('hover', (fo) => {
      const a = viewer.st.after;
      if (!fo || !a) { readout.textContent = ''; return; }
      const [fw, fh] = viewer.foDims();
      if (fo[0] < 0 || fo[1] < 0 || fo[0] >= fw || fo[1] >= fh) { readout.textContent = ''; return; }
      const x = Math.floor(fo[0] / fw * a.canvas.width), y = Math.floor(fo[1] / fh * a.canvas.height);
      try {
        const d = a.canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
        readout.textContent = `R ${(d[0] / 2.55).toFixed(1)}  G ${(d[1] / 2.55).toFixed(1)}  B ${(d[2] / 2.55).toFixed(1)} %`;
      } catch (_) { readout.textContent = ''; }
    });

    Cat.events.on('edited', (p) => { if (p === photo) { renderHistory(); if (!isDragging()) syncAll(); } });
    Cat.events.on('presets', renderPresets);
    function isDragging() { return !!document.querySelector('.track.drag'); }

    /* ================= actions ================= */
    async function autoTone() {
      if (!photo) return;
      const vals = await E.autoTone(photo, photo.settings);
      Object.assign(photo.settings, vals);
      Cat.commit(photo, 'Auto Tone');
      viewer.update('commit'); syncAll();
      UI.toast('Auto Tone applied');
    }
    function resetAll() {
      if (!photo) return;
      const keepGeo = P.clone(photo.settings.geo);
      photo.settings = P.defaultSettings();
      photo.settings.geo.orient = keepGeo.orient; // keep orientation like LR keeps rotation
      Cat.commit(photo, 'Reset');
      afterExternalChange();
      UI.toast('Develop settings reset');
    }
    function previous() {
      if (!photo || !prevPhotoId) return UI.toast('No previous photo', 'circle-info');
      const prev = Cat.get(prevPhotoId);
      if (!prev) return;
      photo.settings = Cat.applyGroups(photo.settings, Cat.pickGroups(prev.settings, Cat.DEFAULT_SYNC), Cat.DEFAULT_SYNC);
      Cat.commit(photo, 'Previous settings');
      afterExternalChange();
    }
    function afterExternalChange() { viewer.update('commit'); syncAll(); }

    function syncAll() {
      controls.forEach(c => c.sync());
      lensStatus();
      refreshEdited();
      renderHistory();
      if (viewer.st.tool !== 'none') buildToolPane();
    }

    function setPhoto(p) {
      if (photo && p !== photo) prevPhotoId = photo.id;
      photo = p;
      nameEl.textContent = p ? Cat.displayName(p) : 'No photo selected';
      lensStatus();
      subEl.textContent = p ? `${p.width || '?'} × ${p.height || '?'} · ${p.format}${p.isRaw ? ' RAW' : ''}${p.note ? ' · ' + p.note : ''}` : '';
      updateExifRow();
      renderSnapshots();
      syncAll();
      if (!p) { W.drawHistogram(histCanvas, null); }
    }
    Cat.events.on('meta', (list) => { if (photo && list.includes(photo)) { updateExifRow(); lensStatus(); subEl.textContent = `${photo.width || '?'} × ${photo.height || '?'} · ${photo.format}${photo.isRaw ? ' RAW' : ''}${photo.note ? ' · ' + photo.note : ''}`; } });

    renderPresets();
    syncAll();
    PJ.Video.player.events.on('state', () => { if (photo && photo.kind === 'video') syncAll(); });

    return {
      left, right, topbar, bottombar, setPhoto, syncAll, autoTone, resetAll, toggleClip, createSnapshot,
      createPresetDialog, applyPreset, buildToolPane, drawNavigator,
      get photo() { return photo; }
    };
  }

  /** Reusable group checkbox grid (for presets / copy / sync dialogs). */
  function groupChecks(selected) {
    const sel = new Set(selected);
    const boxes = Cat.GROUPS.map(g => {
      const c = UI.checkbox(g.label, sel.has(g.key), (v) => { if (v) sel.add(g.key); else sel.delete(g.key); });
      return { g, c };
    });
    const all = h('div', { class: 'row', style: { marginBottom: '8px', gap: '6px' } },
      h('button', { class: 'btn sm', onclick: () => { boxes.forEach(b => { b.c.set(true); sel.add(b.g.key); }); } }, 'Check All'),
      h('button', { class: 'btn sm', onclick: () => { boxes.forEach(b => { b.c.set(false); sel.delete(b.g.key); }); } }, 'Check None'));
    const el = h('div', null, all, h('div', { class: 'group-checks' }, boxes.map(b => b.c.el)));
    return { el, get: () => Cat.GROUPS.map(g => g.key).filter(k => sel.has(k)) };
  }

  global.PJ.Develop = { create, groupChecks, WB_PRESETS };
})(window);
