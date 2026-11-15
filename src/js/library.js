/* =====================================================================
 * photos.jpeg — Library module: catalog sources, filters, grid,
 * ratings/flags/labels, metadata & keywords, quick develop.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, UI = PJ.UI, Cat = PJ.Catalog, E = PJ.Engine;
  const { h, icon } = UI;
  const LABELS = ['red', 'yellow', 'green', 'blue', 'purple'];

  function stars(n) { return n ? '★'.repeat(n) : ''; }

  function create(app) {
    const left = h('div');
    const right = h('div');
    const topbar = h('div', { class: 'row', style: { flex: 1, gap: '8px', padding: '4px 0', minWidth: 0, overflow: 'hidden' } });
    const bottombar = h('div', { class: 'row', style: { flex: 1, gap: '8px' } });
    const grid = document.getElementById('library-view');

    const view = {
      source: Cat.pref('lib.source', 'all'),
      text: '', flag: 'all', minRating: 0, label: '', kind: 'all', edited: 'all',
      sort: Cat.pref('lib.sort', 'capture'), desc: Cat.pref('lib.desc', false),
      cell: Cat.pref('lib.cell', 180),
      mode: Cat.pref('lib.mode', 'grid'),   // 'grid' | 'map'
      geoIds: null                          // "Show in grid" from the map
    };

    const sceneSeen = new Map();             // photo id → what the scene model saw (this session)

    /* ---------------- visible list ---------------- */
    let lastImportIds = new Set(Cat.pref('lib.lastImport', []));
    function sourceList() {
      const all = Cat.state.photos;
      const s = view.source;
      if (s === 'all') return all;
      if (s === 'recent') return all.filter(p => lastImportIds.has(p.id) || lastImportIds.has(p.virtualOf));
      if (s === 'edited') return all.filter(p => p.edited);
      if (s === 'picks') return all.filter(p => p.flag === 1);
      if (s === 'rejected') return all.filter(p => p.flag === -1);
      if (s === 'missing') return all.filter(p => p.missing);
      if (s === 'videos') return all.filter(p => p.kind === 'video');
      if (s.startsWith('folder:')) { const f = s.slice(7); return all.filter(p => (p.folder || '(none)') === f); }
      if (s.startsWith('person:')) { const id = s.slice(7); return all.filter(p => (p.faces || []).some(f => f.p === id)); }
      if (s.startsWith('col:')) {
        const c = Cat.state.collections.find(x => x.id === s.slice(4));
        if (!c) return [];
        if (c.rule) return applyFilters(all, c.rule);
        const set = new Set(c.photoIds);
        return all.filter(p => set.has(p.id));
      }
      return all;
    }
    /** The photos of a list that pass a set of filters: the filter bar's, or a smart collection's rule. */
    function applyFilters(list, view) {
      const t = (view.text || '').trim().toLowerCase();
      if (t) list = list.filter(p => [p.name, p.title, p.caption, (p.keywords || []).join(' '), p.faces && PJ.Faces ? PJ.Faces.namesIn(p).join(' ') : '', p.exif && p.exif.model, p.exif && p.exif.lens, p.folder].join(' ').toLowerCase().includes(t));
      if (view.flag === 'picks') list = list.filter(p => p.flag === 1);
      else if (view.flag === 'unflagged') list = list.filter(p => !p.flag);
      else if (view.flag === 'rejected') list = list.filter(p => p.flag === -1);
      else if (view.flag === 'notrejected') list = list.filter(p => p.flag !== -1);
      if (view.minRating) list = list.filter(p => (p.rating || 0) >= view.minRating);
      if (view.label) list = list.filter(p => view.label === 'none' ? !p.label : p.label === view.label);
      if (view.kind === 'raw') list = list.filter(p => p.isRaw);
      else if (view.kind === 'nonraw') list = list.filter(p => !p.isRaw);
      else if (view.kind === 'vc') list = list.filter(p => p.virtualOf);
      else if (view.kind === 'photos') list = list.filter(p => p.kind !== 'video');
      else if (view.kind === 'videos') list = list.filter(p => p.kind === 'video');
      if (view.edited === 'edited') list = list.filter(p => p.edited);
      else if (view.edited === 'unedited') list = list.filter(p => !p.edited);
      if (view.geoIds) list = list.filter(p => view.geoIds.has(p.id));
      // only smart collections have these
      if (view.keyword) { const k = view.keyword.trim().toLowerCase(); list = list.filter(p => (p.keywords || []).some(x => x.toLowerCase() === k)); }
      if (view.camera) { const k = view.camera.trim().toLowerCase(); list = list.filter(p => p.exif && [p.exif.make, p.exif.model, p.exif.lens].join(' ').toLowerCase().includes(k)); }
      if (view.days > 0) { const since = new Date(Date.now() - view.days * 864e5).toISOString(); list = list.filter(p => (p.captureTime || p.importedAt || '') >= since); }
      if (view.isoMin > 0) list = list.filter(p => p.exif && +p.exif.iso >= view.isoMin);
      return list;
    }
    function visible() {
      let list = applyFilters(sourceList(), view);
      const key = {
        capture: p => p.captureTime || p.importedAt || '',
        import: p => p.importedAt || '',
        name: p => (p.name || '').toLowerCase(),
        rating: p => p.rating || 0,
        edited: p => (p.history[p.historyIndex] || {}).t || 0,
        size: p => (p.width || 0) * (p.height || 0)
      }[view.sort] || (p => 0);
      const idx = new Map(Cat.state.photos.map((p, i) => [p.id, i]));
      list = list.slice().sort((a, b) => {
        const ka = key(a), kb = key(b);
        const r = ka < kb ? -1 : ka > kb ? 1 : idx.get(a.id) - idx.get(b.id);
        return view.desc ? -r : r;
      });
      return collapseStacks(list);
    }

    /* Stacks: photos grouped under one thumbnail (a burst, a RAW + JPEG pair). A collapsed stack
       shows its first photo in the current sort order; the badge on it opens and closes the stack. */
    const openStacks = new Set();
    let stackCounts = new Map();
    function collapseStacks(list) {
      stackCounts = new Map();
      for (const p of list) if (p.stack) stackCounts.set(p.stack, (stackCounts.get(p.stack) || 0) + 1);
      const seen = new Set();
      return list.filter(p => {
        if (!p.stack || stackCounts.get(p.stack) < 2 || openStacks.has(p.stack)) return true;
        if (seen.has(p.stack)) return false;
        seen.add(p.stack);
        return true;
      });
    }
    function toggleStack(id) { if (!id) return; if (openStacks.has(id)) openStacks.delete(id); else openStacks.add(id); app.refresh(); }

    /* ---------------- LEFT ---------------- */
    const catalogList = h('div', { class: 'list' });
    const catPanel = UI.panel({ id: 'l-catalog', title: 'Catalog' });
    catPanel.body.style.padding = '4px 0 8px';
    catPanel.body.appendChild(catalogList);
    const folderList = h('div', { class: 'list' });
    const folderPanel = UI.panel({
      id: 'l-folders', title: 'Folders',
      actions: h('span', { class: 'panel-actions' }, h('button', { title: 'Import folder…', onclick: (e) => { e.stopPropagation(); app.importFolder(); } }, icon('folder-plus')))
    });
    folderPanel.body.style.padding = '4px 0 8px';
    folderPanel.body.appendChild(folderList);
    const colList = h('div', { class: 'list' });
    const colPanel = UI.panel({
      id: 'l-collections', title: 'Collections',
      actions: h('span', { class: 'panel-actions' },
        h('button', { title: 'New smart collection: a saved search that fills itself', onclick: (e) => { e.stopPropagation(); editSmart(null); } }, icon('wand-magic-sparkles')),
        h('button', { title: 'New collection from selection', onclick: (e) => { e.stopPropagation(); newCollection(); } }, icon('plus')))
    });
    colPanel.body.style.padding = '4px 0 8px';
    colPanel.body.appendChild(colList);
    const peopleList = h('div', { class: 'list' });
    const peoplePanel = UI.panel({
      id: 'l-people', title: 'People',
      actions: h('span', { class: 'panel-actions' },
        h('button', { title: 'Find faces in the photos shown (on this computer; nothing is uploaded)', onclick: (e) => { e.stopPropagation(); findFaces(); } }, icon('magnifying-glass')))
    });
    peoplePanel.body.style.padding = '4px 0 8px';
    peoplePanel.body.appendChild(peopleList);
    left.append(catPanel.el, folderPanel.el, colPanel.el, peoplePanel.el);

    /* ---------------- people ---------------- */
    let faceScan = null;
    async function findFaces() {
      const F = PJ.Faces;
      if (!F) return;
      if (faceScan) { faceScan.stop = true; return; }
      const list = (app.visiblePhotos ? app.visiblePhotos() : sourceList()).filter(p => F.canScan(p) && !F.scanned(p));
      if (!list.length) { if (F.unnamedCount()) nameFaces(); else UI.toast('Every photo shown has been looked through already', 'circle-info'); return; }
      faceScan = { stop: false };
      if (Cat.pref('faces.auto', null) === null) Cat.setPref('faces.auto', true);        // from now on, photos are looked through as they are imported (Preferences turns it off)
      let r;
      try { r = await F.scan(list, (i, n, p) => UI.activity(`Looking for faces · ${i + 1} of ${n} · ${p.name} (click the magnifier again to stop)`, i / n), faceScan); }
      finally { faceScan = null; UI.activity('', 0); }
      renderLeft();
      if (r.error) return UI.toast(r.error, 'triangle-exclamation');
      UI.toast(`${r.faces} face${r.faces === 1 ? '' : 's'} found in ${r.photos} photo${r.photos === 1 ? '' : 's'}${r.failed ? ` · ${r.failed} could not be read` : ''}`, 'user');
      if (F.unnamedCount()) nameFaces();
    }
    const faceImg = (e, onClick) => {
      const im = h('img', { class: 'face', src: PJ.Faces.faceUrl(e.face), title: e.photo.name, draggable: false });
      if (onClick) im.addEventListener('click', () => onClick(im));
      return im;
    };
    /** The faces without a name, one row per person the app thinks they are; a name given to a row names all its faces. */
    function nameFaces() {
      const F = PJ.Faces;
      const body = h('div', { class: 'face-groups' });
      const names = h('datalist', { id: 'people-names' });
      const fill = () => {
        names.replaceChildren(...F.people().map(p => h('option', { value: p.name })));
        const gs = F.groups();
        body.replaceChildren(names);
        if (!gs.length) { body.append(h('p', { class: 'muted' }, 'No faces are waiting for a name.')); return; }
        body.append(h('p', { class: 'muted small' }, 'Each row is one person as far as the app can tell. Click a face to leave it out of the row, then type a name. Rows with one face are usually faces seen at an odd angle.'));
        for (const g of gs.slice(0, 60)) {
          const off = new Set();
          const inp = h('input', { type: 'text', placeholder: 'Name', list: 'people-names', value: g.suggest ? g.suggest.name : '' });
          const chosen = () => g.faces.filter(e => !off.has(e));
          const save = () => { if (!inp.value.trim()) return inp.focus(); F.name(chosen(), inp.value); fill(); renderLeft(); };
          inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); ev.stopPropagation(); });
          body.append(h('div', { class: 'face-row' },
            h('div', { class: 'faces' }, ...g.faces.slice(0, 24).map(e => faceImg(e, (im) => { if (off.has(e)) off.delete(e); else off.add(e); im.classList.toggle('off', off.has(e)); })),
              g.faces.length > 24 ? h('span', { class: 'muted small' }, `+${g.faces.length - 24}`) : null),
            h('div', { class: 'face-name' }, inp,
              h('button', { class: 'btn primary', onclick: save }, g.suggest ? 'Yes, ' + g.suggest.name : 'Name'),
              h('button', { class: 'btn', title: 'These are not people you want to keep track of', onclick: () => { F.ignore(chosen()); fill(); renderLeft(); } }, 'Ignore'))));
        }
        if (gs.length > 60) body.append(h('p', { class: 'muted small' }, `${gs.length - 60} more rows appear as these are named.`));
      };
      fill();
      UI.modal({ title: 'Who is this?', icon: 'user', wide: true, body, buttons: [{ label: 'Done', primary: true }] });
    }
    /** The faces filed under a person; a click takes a face out again. */
    function personFaces(who) {
      const F = PJ.Faces, body = h('div', { class: 'face-groups' });
      const fill = () => {
        const fs = F.facesOf(who.id);
        body.replaceChildren(h('p', { class: 'muted small' }, 'Click a face that is not ' + who.name + ' to take it out; it goes back to the faces without a name.'),
          h('div', { class: 'faces' }, ...fs.map(e => faceImg(e, () => { F.unname([e]); fill(); renderLeft(); }))));
      };
      fill();
      UI.modal({ title: who.name, icon: 'user', wide: true, body, buttons: [{ label: 'Done', primary: true }] });
    }
    function renderPeople() {
      const F = PJ.Faces;
      if (!F) { peoplePanel.el.style.display = 'none'; return; }
      const rows = [];
      for (const who of F.people().slice().sort((a, b) => a.name.localeCompare(b.name))) {
        const key = 'person:' + who.id, li = srcItem(key, 'user', who.name, F.photosOf(who.id).length);
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          UI.menu(e.clientX, e.clientY, [
            { label: 'Show faces…', icon: 'user', action: () => personFaces(who) },
            { label: 'Rename…', icon: 'pen', action: async () => { const n = await UI.prompt('Rename person', who.name); if (n) { F.rename(who.id, n); if (!F.person(who.id) && view.source === key) setSource('all'); else renderLeft(); } } },
            { label: 'Remove this person', icon: 'trash-can', action: () => { F.remove(who.id); if (view.source === key) setSource('all'); else renderLeft(); } }
          ]);
        });
        rows.push(li);
      }
      const n = F.unnamedCount();
      if (n) { const li = h('div', { class: 'li', title: 'Faces that have not been given a name' }, icon('circle-question'), h('span', { class: 't' }, 'Faces without a name'), h('span', { class: 'n' }, n)); li.addEventListener('click', nameFaces); rows.push(li); }
      if (!rows.length) rows.push(h('div', { class: 'muted small', style: { padding: '2px 12px' } }, 'Click the magnifier to find the faces in the photos shown.'));
      peopleList.replaceChildren(...rows);
    }
    Cat.events.on('people', () => renderLeft());

    /** Small inline action buttons shown on hover / for the active source. */
    function acts(list) {
      return h('span', { class: 'li-acts' }, list.filter(Boolean).map(([ic, title, fn]) => {
        const b = h('button', { title, 'aria-label': title }, icon(ic));
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
      }));
    }
    function photosIn(key) { const prev = view.source; view.source = key; const l = sourceList(); view.source = prev; return l; }
    function srcItem(key, ic, label, count, extra) {
      const li = h('div', { class: `li${view.source === key ? ' on' : ''}`, title: label }, icon(ic), h('span', { class: 't' }, label), extra || null, h('span', { class: 'n' }, count));
      li.addEventListener('click', () => { setSource(key); });
      return li;
    }
    function renderLeft() {
      renderPeople();
      const all = Cat.state.photos;
      catalogList.replaceChildren(
        srcItem('all', 'images', 'All Photographs', all.length),
        srcItem('recent', 'clock-rotate-left', 'Previous Import', all.filter(p => lastImportIds.has(p.id)).length,
          lastImportIds.size ? acts([['eraser', 'Clear Previous Import', () => { lastImportIds = new Set(); Cat.setPref('lib.lastImport', []); if (view.source === 'recent') setSource('all'); else renderLeft(); UI.toast('Cleared Previous Import'); }]]) : null),
        srcItem('edited', 'sliders', 'Edited', all.filter(p => p.edited).length),
        srcItem('picks', 'flag', 'Picks', all.filter(p => p.flag === 1).length),
        srcItem('rejected', 'ban', 'Rejected', all.filter(p => p.flag === -1).length),
        all.some(p => p.kind === 'video') ? srcItem('videos', 'film', 'Videos', all.filter(p => p.kind === 'video').length) : null,
        all.some(p => p.missing) ? srcItem('missing', 'triangle-exclamation', 'Missing / Offline', all.filter(p => p.missing).length) : null);
      folderList.innerHTML = '';
      const fs = Cat.folders();
      if (!fs.length) folderList.appendChild(h('div', { class: 'empty-note' }, 'No folders yet.'));
      fs.forEach(([f, n]) => {
        const short = f.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || f;
        const li = srcItem('folder:' + f, 'folder', short, n, acts([['arrows-rotate', 'Refresh folder', () => app.refreshPhotos(photosIn('folder:' + f), `“${short}”`)]]));
        li.title = f;
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          UI.menu(e.clientX, e.clientY, [
            { label: 'Show in file manager', icon: 'folder-open', hidden: !PJ.API.isDesktop, action: () => { const p = Cat.state.photos.find(x => x.folder === f); if (p) PJ.API.showInFolder(p.path); } },
            { label: 'Refresh (re-check files, metadata & previews)', icon: 'arrows-rotate', action: () => app.refreshPhotos(photosIn('folder:' + f), `“${short}”`) },
            { label: 'Synchronize folder (import new files)', icon: 'folder-plus', hidden: !PJ.API.isDesktop, action: () => app.syncFolder(f) },
            { label: 'Remove folder from catalog', icon: 'trash-can', action: async () => {
              const ids = Cat.state.photos.filter(p => (p.folder || '(none)') === f).map(p => p.id);
              if (await UI.confirm('Remove folder', `Remove ${ids.length} photo(s) in “${short}” from the catalog? Files on disk are not touched.`, 'Remove', true)) app.removePhotos(ids);
            } }
          ]);
        });
        folderList.appendChild(li);
      });
      colList.innerHTML = '';
      if (!Cat.state.collections.length) colList.appendChild(h('div', { class: 'empty-note' }, 'Select photos and click + to create a collection.'));
      Cat.state.collections.forEach(c => {
        if (c.rule) {
          const li = srcItem('col:' + c.id, 'wand-magic-sparkles', c.name, applyFilters(Cat.state.photos, c.rule).length);
          li.title = c.name + ' — ' + describeRule(c.rule);
          li.addEventListener('dblclick', () => editSmart(c));
          li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            UI.menu(e.clientX, e.clientY, [
              { label: 'Edit rule…', icon: 'sliders', action: () => editSmart(c) },
              { label: 'Rename…', icon: 'pen', action: async () => { const n = await UI.prompt('Rename collection', c.name); if (n) { c.name = n; Cat.scheduleSave(); renderLeft(); } } },
              { label: 'Delete collection', icon: 'trash-can', action: () => { Cat.removeCollection(c.id); if (view.source === 'col:' + c.id) setSource('all'); } }
            ]);
          });
          colList.appendChild(li);
          return;
        }
        const clear = async () => {
          if (!c.photoIds.length) return UI.toast(`“${c.name}” is already empty`, 'circle-info');
          if (!await UI.confirm('Clear collection', `Remove all ${c.photoIds.length} item(s) from “${c.name}”? The collection stays, and the photos stay in your catalog.`, 'Clear', true)) return;
          const n = Cat.clearCollection(c.id);
          if (view.source === 'col:' + c.id) app.refresh();
          UI.toast(`Cleared ${n} item(s) from “${c.name}”`, 'eraser');
        };
        const refreshCol = () => app.refreshPhotos(photosIn('col:' + c.id), `“${c.name}”`);
        const li = srcItem('col:' + c.id, 'layer-group', c.name, c.photoIds.length,
          acts([['arrows-rotate', 'Refresh collection', refreshCol], ['eraser', 'Clear collection', clear]]));
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          UI.menu(e.clientX, e.clientY, [
            { label: 'Add selected photos', icon: 'plus', action: () => { Cat.addToCollection(c.id, app.selectedIds()); UI.toast(`Added to “${c.name}”`); } },
            { label: 'Remove selected photos', icon: 'minus', action: () => Cat.removeFromCollection(c.id, app.selectedIds()) },
            { label: 'Refresh (re-check files, metadata & previews)', icon: 'arrows-rotate', action: refreshCol },
            { label: 'Clear collection…', icon: 'eraser', action: clear },
            { label: 'Rename…', icon: 'pen', action: async () => { const n = await UI.prompt('Rename collection', c.name); if (n) { c.name = n; Cat.scheduleSave(); renderLeft(); } } },
            { label: 'Delete collection', icon: 'trash-can', action: () => { Cat.removeCollection(c.id); if (view.source === 'col:' + c.id) setSource('all'); } }
          ]);
        });
        // accept drops of grid cells
        li.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-pj-ids')) { e.preventDefault(); li.classList.add('on'); } });
        li.addEventListener('dragleave', () => li.classList.toggle('on', view.source === 'col:' + c.id));
        li.addEventListener('drop', (e) => {
          const ids = JSON.parse(e.dataTransfer.getData('application/x-pj-ids') || '[]');
          if (ids.length) { Cat.addToCollection(c.id, ids); UI.toast(`Added ${ids.length} to “${c.name}”`); }
          e.preventDefault(); e.stopPropagation();
        });
        colList.appendChild(li);
      });
    }
    /** A rule in words, for the tooltip. */
    function describeRule(r) {
      const out = [];
      if (r.text) out.push(`contains “${r.text}”`);
      if (r.keyword) out.push(`keyword “${r.keyword}”`);
      if (r.camera) out.push(`camera or lens “${r.camera}”`);
      if (r.minRating) out.push(`${r.minRating} stars or more`);
      if (r.flag && r.flag !== 'all') out.push({ picks: 'picks', unflagged: 'unflagged', rejected: 'rejected', notrejected: 'not rejected' }[r.flag]);
      if (r.label) out.push(r.label === 'none' ? 'no label' : r.label + ' label');
      if (r.kind && r.kind !== 'all') out.push({ raw: 'RAW', nonraw: 'non-RAW', vc: 'virtual copies', photos: 'photos', videos: 'videos' }[r.kind]);
      if (r.edited && r.edited !== 'all') out.push(r.edited);
      if (r.days > 0) out.push(`from the last ${r.days} days`);
      if (r.isoMin > 0) out.push(`ISO ${r.isoMin} or higher`);
      return out.length ? out.join(', ') : 'every photo';
    }
    /** Make or change a smart collection. A new one starts from what the filter bar shows now. */
    function editSmart(c) {
      const r = Object.assign({ text: '', keyword: '', camera: '', minRating: 0, flag: 'all', label: '', kind: 'all', edited: 'all', days: 0, isoMin: 0 },
        c ? c.rule : { text: view.text, minRating: view.minRating, flag: view.flag, label: view.label, kind: view.kind, edited: view.edited });
      const txt = (v, ph) => { const i = h('input', { type: 'text', value: v || '', placeholder: ph || '', style: { width: '100%' } }); i.addEventListener('keydown', e => e.stopPropagation()); return i; };
      const pick = (v, opts) => { const s = h('select', { style: { width: '100%' } }, opts.map(([k, l]) => h('option', { value: k }, l))); s.value = String(v); return s; };
      const name = txt(c ? c.name : '', 'Name'), text = txt(r.text, 'in name, title, caption, keywords, camera, folder'), keyword = txt(r.keyword, 'exactly this keyword'), camera = txt(r.camera, 'e.g. Nikon, 50mm');
      const rating = pick(r.minRating, [0, 1, 2, 3, 4, 5].map(n => [n, n ? `${'★'.repeat(n)} or more` : 'Any']));
      const flag = pick(r.flag, [['all', 'Any'], ['picks', 'Picks'], ['unflagged', 'Unflagged'], ['notrejected', 'Not rejected'], ['rejected', 'Rejected']]);
      const label = pick(r.label, [['', 'Any'], ...LABELS.map(l => [l, l[0].toUpperCase() + l.slice(1)]), ['none', 'No label']]);
      const kind = pick(r.kind, [['all', 'Any'], ['photos', 'Photos'], ['videos', 'Videos'], ['raw', 'RAW'], ['nonraw', 'Non-RAW'], ['vc', 'Virtual copies']]);
      const edited = pick(r.edited, [['all', 'Either'], ['edited', 'Edited'], ['unedited', 'Not edited']]);
      const days = pick(r.days, [[0, 'Any time'], [7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year']]);
      const iso = pick(r.isoMin, [[0, 'Any'], [800, '800 or higher'], [1600, '1600 or higher'], [3200, '3200 or higher'], [6400, '6400 or higher']]);
      const count = h('div', { class: 'muted', style: { marginTop: '8px' } });
      const read = () => ({ text: text.value.trim(), keyword: keyword.value.trim(), camera: camera.value.trim(), minRating: +rating.value, flag: flag.value, label: label.value, kind: kind.value, edited: edited.value, days: +days.value, isoMin: +iso.value });
      const tally = () => { count.textContent = `${applyFilters(Cat.state.photos, read()).length} of ${Cat.state.photos.length} photos match now. The collection keeps itself up to date.`; };
      const f = (l, el) => h('label', { class: 'field' }, h('span', null, l), el);
      const body = h('div', { style: { width: '380px' } }, f('Name', name), f('Text', text), f('Keyword', keyword), f('Camera / lens', camera),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' } }, f('Rating', rating), f('Flag', flag), f('Label', label), f('Kind', kind), f('Edited', edited), f('Captured', days), f('ISO', iso)), count);
      body.addEventListener('input', tally); body.addEventListener('change', tally); tally();
      UI.modal({
        title: c ? 'Smart Collection' : 'New Smart Collection', icon: 'wand-magic-sparkles', body,
        buttons: [{ label: 'Cancel' }, {
          label: c ? 'Save' : 'Create', primary: true, onClick: () => {
            const rule = read(), nm = name.value.trim() || describeRule(rule);
            if (c) { c.rule = rule; c.name = nm; Cat.scheduleSave(); renderLeft(); if (view.source === 'col:' + c.id) app.refresh(); }
            else { const n = Cat.addCollection(nm, [], rule); setSource('col:' + n.id); }
          }
        }]
      });
    }
    async function newCollection() {
      const ids = app.selectedIds();
      const n = await UI.prompt('New Collection', '', { message: ids.length ? `Includes the ${ids.length} selected photo(s).` : 'Creates an empty collection.', icon: 'layer-group' });
      if (!n) return;
      const c = Cat.addCollection(n, ids);
      setSource('col:' + c.id);
    }
    function setSource(key) {
      view.source = key;
      Cat.setPref('lib.source', key);
      renderLeft();
      app.refresh();
    }

    /* ---------------- TOP: filter bar ---------------- */
    const search = h('input', { type: 'search', placeholder: 'Search name, keyword, camera…', style: { width: '190px' } });
    search.addEventListener('input', UI.debounce(() => { view.text = search.value; app.refresh(); }, 150));
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; view.text = ''; app.refresh(); search.blur(); } e.stopPropagation(); });
    const flagSel = h('select', { title: 'Flag filter' },
      [['all', 'All flags'], ['picks', 'Picks'], ['unflagged', 'Unflagged'], ['notrejected', 'Not rejected'], ['rejected', 'Rejected']].map(([v, l]) => h('option', { value: v }, l)));
    flagSel.addEventListener('change', () => { view.flag = flagSel.value; app.refresh(); });
    const ratingSel = h('select', { title: 'Rating filter' }, [0, 1, 2, 3, 4, 5].map(n => h('option', { value: n }, n ? `≥ ${'★'.repeat(n)}` : 'Any rating')));
    ratingSel.addEventListener('change', () => { view.minRating = +ratingSel.value; app.refresh(); });
    const labelBox = h('div', { class: 'label-edit', title: 'Color label filter' });
    function renderLabelFilter() {
      labelBox.innerHTML = '';
      ['', ...LABELS, 'none'].forEach(l => {
        const sp = h('span', { class: `${l && l !== 'none' ? 'lbl-' + l : 'none'}${view.label === l ? ' on' : ''}`, title: l || 'Any label' }, l === '' ? '∗' : l === 'none' ? '∅' : '');
        sp.addEventListener('click', () => { view.label = l; renderLabelFilter(); app.refresh(); });
        labelBox.appendChild(sp);
      });
    }
    renderLabelFilter();
    const kindSel = h('select', { title: 'File type / edit state' }, [['all', 'All media'], ['photos', 'Photos only'], ['videos', 'Videos only'], ['raw', 'RAW only'], ['nonraw', 'Non-RAW'], ['vc', 'Virtual copies'], ['edited', 'Edited'], ['unedited', 'Unedited']].map(([v, l]) => h('option', { value: v }, l)));
    kindSel.addEventListener('change', () => {
      const v = kindSel.value;
      view.kind = ['raw', 'nonraw', 'vc', 'photos', 'videos'].includes(v) ? v : 'all';
      view.edited = ['edited', 'unedited'].includes(v) ? v : 'all';
      app.refresh();
    });
    const sortSel = h('select', { title: 'Sort' }, [['capture', 'Capture time'], ['import', 'Added order'], ['name', 'File name'], ['rating', 'Rating'], ['edited', 'Edit time'], ['size', 'Pixel count']].map(([v, l]) => h('option', { value: v }, l)));
    sortSel.value = view.sort;
    sortSel.addEventListener('change', () => { view.sort = sortSel.value; Cat.setPref('lib.sort', view.sort); app.refresh(); });
    const dirBtn = h('button', { class: 'btn sm icon', title: 'Sort direction' }, icon(view.desc ? 'arrow-down-wide-short' : 'arrow-up-short-wide'));
    dirBtn.addEventListener('click', () => { view.desc = !view.desc; Cat.setPref('lib.desc', view.desc); dirBtn.replaceChildren(icon(view.desc ? 'arrow-down-wide-short' : 'arrow-up-short-wide')); app.refresh(); });
    const resetF = h('button', { class: 'btn sm ghost', title: 'Clear filters' }, icon('filter-circle-xmark'));
    resetF.addEventListener('click', () => {
      Object.assign(view, { text: '', flag: 'all', minRating: 0, label: '', kind: 'all', edited: 'all', geoIds: null });
      geoChip.classList.add('hidden');
      search.value = ''; flagSel.value = 'all'; ratingSel.value = 0; kindSel.value = 'all';
      renderLabelFilter(); app.refresh();
    });
    const geoChip = h('button', { class: 'btn sm chip hidden', title: 'Photos picked on the map — click to clear' });
    geoChip.addEventListener('click', () => setGeoFilter(null));
    function setGeoFilter(ids) {
      view.geoIds = ids && ids.length ? new Set(ids) : null;
      geoChip.classList.toggle('hidden', !view.geoIds);
      geoChip.replaceChildren(icon('location-dot'), ` ${view.geoIds ? view.geoIds.size : 0} from map `, icon('xmark'));
      if (view.geoIds) setMode('grid'); else app.refresh();
    }
    topbar.append(icon('magnifying-glass', 'muted'), search, flagSel, ratingSel, labelBox, kindSel, resetF, geoChip, h('span', { class: 'spacer' }), h('label', { class: 'lbl' }, 'Sort'), sortSel, dirBtn);

    /* ---------------- BOTTOM ---------------- */
    const sizeRange = h('input', { type: 'range', min: 100, max: 360, value: view.cell, style: { width: '140px', accentColor: '#4f8ff7' } });
    sizeRange.addEventListener('input', () => { view.cell = +sizeRange.value; grid.style.setProperty('--cell', view.cell + 'px'); vgrid.relayout(); });

    sizeRange.addEventListener('change', () => Cat.setPref('lib.cell', view.cell));
    grid.style.setProperty('--cell', view.cell + 'px');
    const countEl = h('span', { class: 'muted', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } });
    bottombar.append(
      h('button', { class: 'btn sm primary', onclick: () => app.importFiles() }, icon('file-import'), 'Import…'),
      h('button', { class: 'btn sm', onclick: () => app.importFolder() }, icon('folder-plus'), 'Import Folder…'),
      h('span', { class: 'sep' }),
      h('button', { class: 'btn sm', title: 'Re-check the photos in this view: missing files, changes on disk, metadata and previews (F5)', onclick: () => app.refreshView() }, icon('arrows-rotate'), 'Refresh'),
      h('button', { class: 'btn sm', title: 'Slideshow (Ctrl+Enter)', onclick: () => app.slideshow() }, icon('play'), 'Slideshow'),
      h('button', { class: 'btn sm', title: 'Export selected (Ctrl+Shift+E)', onclick: () => app.exportSelected() }, icon('file-export'), 'Export…'),
      h('button', { class: 'btn sm', title: 'Find duplicate and near-duplicate photos', onclick: () => PJ.Dupes.open(app) }, icon('clone'), 'Duplicates'),
      h('span', { class: 'spacer' }), countEl, h('span', { class: 'sep' }),
      h('label', { class: 'lbl size-lbl' }, 'Thumbnails'), sizeRange);

    /* ---------------- GRID ---------------- */
    function thumbSrc(p) { return p.thumbV || !PJ.API.hasThumbStore ? PJ.API.thumbUrl(p.id, p.thumbV) : ''; }
    function cellFor(p, i) {
      const sel = app.isSelected(p.id), act = app.activeId() === p.id;
      const src = thumbSrc(p);
      const img = src ? h('img', { src, draggable: 'false', loading: 'lazy' }) : h('div', { class: 'ph' }, icon(p.missing ? 'triangle-exclamation' : 'image'));
      if (src) img.onerror = () => { img.replaceWith(h('div', { class: 'ph' }, icon('image'))); E.queueThumb(p); };
      const badges = h('div', { class: 'badges' },
        p.stack && stackCounts.get(p.stack) > 1 ? h('span', {
          class: 'badge stack', title: openStacks.has(p.stack) ? 'Part of an open stack — click to close it' : `Stack of ${stackCounts.get(p.stack)} — click to open`,
          onclick: (e) => { e.stopPropagation(); toggleStack(p.stack); }
        }, icon('layer-group'), ' ', String(stackCounts.get(p.stack))) : null,
        p.virtualOf ? h('span', { class: 'badge vc', title: 'Virtual copy' }, 'VC') : null,
        p.edited ? h('span', { class: 'badge edit', title: 'Edited' }, icon('sliders')) : null,
        p.isRaw ? h('span', { class: 'badge raw' }, p.video && p.video.cdng ? 'CDNG' : p.format) : null,
        p.missing ? h('span', { class: 'badge', title: 'File missing or offline' }, '!') : null);
      const el = h('div', {
        class: `cell${sel ? ' sel' : ''}${act ? ' active' : ''}${p.flag === -1 ? ' rejected' : ''}${p.label ? ' lab-' + p.label : ''}`,
        draggable: 'true', dataset: { id: p.id }
      },
        h('span', { class: 'idx' }, i + 1),
        badges,
        h('div', { class: 'ci' }, img,
          p.kind === 'video' ? h('span', { class: 'vid-badge', title: p.video && p.video.codecName || 'Video' }, icon('play'), PJ.Video.shortDuration(p.video && p.video.duration)) : null),
        h('div', { class: 'cb' },
          p.flag === 1 ? icon('flag', 'flag-pick') : p.flag === -1 ? icon('ban', 'flag-reject') : null,
          h('span', { class: 'name', title: p.path }, Cat.displayName(p)),
          h('span', { class: 'stars' }, stars(p.rating)),
          p.label ? h('span', { class: `lbl-dot lbl-${p.label}` }) : null));
      el.addEventListener('mousedown', (e) => { if (e.button === 0) app.clickSelect(p.id, e); });
      el.addEventListener('dblclick', () => app.openDevelop(p.id));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!app.isSelected(p.id)) app.clickSelect(p.id, {}); app.photoMenu(e.clientX, e.clientY); });
      el.addEventListener('dragstart', (e) => {
        const ids = app.isSelected(p.id) ? app.selectedIds() : [p.id];
        e.dataTransfer.setData('application/x-pj-ids', JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'copy';
      });
      if (!p.thumbV && !p.missing) E.queueThumb(p);
      return el;
    }
    // Only the cells near the viewport exist, so 50k-photo catalogs scroll like small ones
    const vgrid = PJ.Virtual.grid(grid, { pad: 12, gap: 10, cell: () => view.cell, key: (p) => p.id, make: cellFor, indexed: true });
    const map = PJ.MapView.create(app, { setGeoFilter: (ids) => setGeoFilter(ids) });
    grid.parentNode.appendChild(map.el);
    let stageOn = false;
    function setMode(m) {
      view.mode = m === 'map' ? 'map' : 'grid';
      Cat.setPref('lib.mode', view.mode);
      app.setModule('library');
    }
    /** Called by the app when the Library is (or isn't) on screen with photos to show. */
    function showStage(on) {
      stageOn = !!on;
      const isMap = view.mode === 'map';
      grid.classList.toggle('hidden', !stageOn || isMap);
      if (stageOn && isMap) map.show(); else map.hide();
      sizeRange.style.display = isMap ? 'none' : '';
      bottombar.querySelector('.size-lbl').style.display = isMap ? 'none' : '';
    }
    function countText(n) {
      const selN = app.selectedIds().length;
      return `${n.toLocaleString()} of ${Cat.state.photos.length.toLocaleString()} photos${selN ? ` · ${selN.toLocaleString()} selected` : ''}`;
    }
    function render() {
      const list = app.visible();
      showStage(stageOn);
      if (view.mode === 'map') map.refresh(); else vgrid.set(list, true);
      countEl.textContent = countText(list.length);
      renderLeft();
      renderRight();
    }
    function updateCell(p) { vgrid.refresh(p); }
    function updateSelection() {
      vgrid.forEachLive((id, el) => {
        el.classList.toggle('sel', app.isSelected(id));
        el.classList.toggle('active', app.activeId() === id);
      });
      map.redrawMarkers();
      countEl.textContent = countText(app.visible().length);
      renderRight();
    }
    function scrollToActive() { if (view.mode === 'grid') vgrid.scrollToIndex(vgrid.indexOf(app.activeId())); }
    grid.addEventListener('mousedown', (e) => { if (e.target === grid || e.target.classList.contains('v-sizer')) app.clearSelection(); });
    E.thumbEvents.on('thumb', (p) => updateCell(p));

    /* ---------------- RIGHT: quick develop, metadata, keywords ---------------- */
    const qdPanel = UI.panel({ id: 'l-qd', title: 'Quick Develop', icon: 'wand-magic-sparkles' });
    const metaPanel = UI.panel({ id: 'l-meta', title: 'Metadata', icon: 'circle-info' });
    const kwPanel = UI.panel({ id: 'l-kw', title: 'Keywording', icon: 'tags' });
    const histPanel = UI.panel({ id: 'l-hist', title: 'Preview', icon: 'image' });
    right.append(histPanel.el, qdPanel.el, kwPanel.el, metaPanel.el);

    const prevImg = h('img', { style: { width: '100%', maxHeight: '200px', objectFit: 'contain', display: 'block', background: '#0d0e10', borderRadius: '4px' } });
    histPanel.body.appendChild(prevImg);

    // Quick develop: relative adjustments to all selected photos
    const QD = [
      ['exposure', 'Exposure', [-1, -1 / 3, 1 / 3, 1], (v) => v.toFixed(2)],
      ['contrast', 'Contrast', [-20, -5, 5, 20]],
      ['highlights', 'Highlights', [-20, -5, 5, 20]],
      ['shadows', 'Shadows', [-20, -5, 5, 20]],
      ['whites', 'Whites', [-20, -5, 5, 20]],
      ['blacks', 'Blacks', [-20, -5, 5, 20]],
      ['temp', 'Temp', [-20, -5, 5, 20]],
      ['tint', 'Tint', [-20, -5, 5, 20]],
      ['texture', 'Texture', [-20, -5, 5, 20]],
      ['clarity', 'Clarity', [-20, -5, 5, 20]],
      ['vibrance', 'Vibrance', [-20, -5, 5, 20]]
    ];
    const qdGrid = h('div', { class: 'qd' });
    for (const [key, label, steps] of QD) {
      qdGrid.append(h('label', null, label));
      steps.forEach((st, i) => {
        const b = h('button', { title: `${st > 0 ? '+' : ''}${key === 'exposure' ? st.toFixed(2) : st}` }, ['◀◀', '◀', '▶', '▶▶'][i]);
        b.addEventListener('click', () => quickAdjust(key, st, label));
        qdGrid.append(b);
      });
    }
    const presetSel = h('select', { style: { width: '100%' } });
    function fillPresetSel() {
      presetSel.replaceChildren(h('option', { value: '' }, 'Apply preset to selection…'),
        ...Cat.allPresets().map(p => h('option', { value: p.id }, `${p.group} › ${p.name}`)));
    }
    fillPresetSel();
    Cat.events.on('presets', fillPresetSel);
    presetSel.addEventListener('change', () => {
      const p = Cat.allPresets().find(x => x.id === presetSel.value);
      presetSel.value = '';
      if (p) app.applyPresetToSelection(p);
    });
    const wbSel = h('select', { style: { flex: 1 } }, Object.entries(PJ.Develop.WB_PRESETS).filter(([k]) => k !== 'custom').map(([k, v]) => h('option', { value: k }, v.label)));
    wbSel.addEventListener('change', async () => {
      const ps = app.selectedPhotos();
      const pr = PJ.Develop.WB_PRESETS[wbSel.value];
      for (const p of ps) {
        if (wbSel.value === 'auto') { try { Object.assign(p.settings, await E.autoWB(p)); } catch (_) { continue; } }
        else { p.settings.temp = pr.temp; p.settings.tint = pr.tint; }
        p.settings.wbMode = wbSel.value;
        Cat.commit(p, `White Balance: ${pr.label}`);
        E.queueThumb(p);
      }
      UI.toast(`White balance set on ${ps.length} photo(s)`);
    });
    qdPanel.body.append(
      h('div', { class: 'field' }, presetSel),
      h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'muted', style: { width: '84px' } }, 'White Bal.'), wbSel),
      qdGrid,
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn sm grow', onclick: () => app.autoToneSelection() }, icon('wand-magic-sparkles'), 'Auto Tone'),
        h('button', { class: 'btn sm grow', title: 'Auto color grade the selection (Ctrl+Shift+G) — right-click to pick a look', onclick: () => app.autoGradeSelection(), oncontextmenu: (e) => { e.preventDefault(); app.gradeLookMenu(e.clientX, e.clientY); } }, icon('palette'), 'Auto Grade'),
        h('button', { class: 'btn sm grow', onclick: () => app.resetSelection() }, icon('rotate-left'), 'Reset All')));
    function quickAdjust(key, delta, label) {
      const ps = app.selectedPhotos();
      if (!ps.length) return UI.toast('Select photos first', 'circle-info');
      for (const p of ps) {
        const lim = key === 'exposure' ? 5 : 100;
        p.settings[key] = Math.round(P.clamp((p.settings[key] || 0) + delta, -lim, lim) * 100) / 100;
        if (key === 'temp' || key === 'tint') p.settings.wbMode = 'custom';
        Cat.commit(p, `Quick Develop: ${label} ${delta > 0 ? '+' : ''}${key === 'exposure' ? delta.toFixed(2) : delta}`);
        E.queueThumb(p, true);
      }
    }

    function renderRight() {
      const ps = app.selectedPhotos();
      const p = app.activePhoto();
      prevImg.src = p ? thumbSrc(p) : '';
      prevImg.style.display = p && thumbSrc(p) ? 'block' : 'none';
      // Metadata
      metaPanel.body.innerHTML = '';
      kwPanel.body.innerHTML = '';
      if (!p) {
        metaPanel.body.appendChild(h('div', { class: 'muted' }, 'Select a photo to see its metadata.'));
        kwPanel.body.appendChild(h('div', { class: 'muted' }, 'Select photos to add keywords.'));
        return;
      }
      const targets = ps.length ? ps : [p];
      const multi = targets.length > 1;
      const e = p.exif || {};
      const ratingRow = h('div', { class: 'rating-edit', title: 'Rating (0–5)' });
      for (let i = 1; i <= 5; i++) {
        const s = h('i', { class: `fa-solid fa-star${(p.rating || 0) >= i ? ' on' : ''}` });
        s.addEventListener('click', () => app.setRating(p.rating === i && !multi ? 0 : i));
        ratingRow.appendChild(s);
      }
      const labelRow = h('div', { class: 'label-edit' });
      ['none', ...LABELS].forEach(l => {
        const sp = h('span', { class: `${l === 'none' ? 'none' : 'lbl-' + l}${(p.label || 'none') === l ? ' on' : ''}`, title: l }, l === 'none' ? '∅' : '');
        sp.addEventListener('click', () => app.setLabel(l === 'none' ? '' : l));
        labelRow.appendChild(sp);
      });
      const flagRow = UI.seg([{ icon: 'flag', value: 1, title: 'Pick (P)' }, { icon: 'minus', value: 0, title: 'Unflag (U)' }, { icon: 'ban', value: -1, title: 'Reject (X)' }], p.flag || 0, (v) => app.setFlag(v));
      const title = h('input', { type: 'text', value: multi ? '' : (p.title || ''), placeholder: multi ? `(${targets.length} photos)` : 'Title' });
      const caption = h('textarea', { placeholder: multi ? `(${targets.length} photos)` : 'Caption' });
      caption.value = multi ? '' : (p.caption || '');
      const stop = (e2) => e2.stopPropagation();
      [title, caption].forEach(el => el.addEventListener('keydown', stop));
      title.addEventListener('change', () => { Cat.setMeta(targets, { title: title.value }); });
      caption.addEventListener('change', () => { Cat.setMeta(targets, { caption: caption.value }); });
      const dl = h('dl', { class: 'meta' });
      const add = (k, v) => { if (v !== undefined && v !== null && v !== '') dl.append(h('dt', null, k), h('dd', { title: String(v) }, String(v))); };
      add('File', Cat.displayName(p));
      add('Folder', p.folder);
      add('Dimensions', p.width ? `${p.width} × ${p.height}` : '');
      add('Sensor', e.sensorWidth ? `${e.sensorWidth} × ${e.sensorHeight}` : '');
      add('Size', UI.fmtBytes(p.size));
      add('Format', `${p.format}${p.isRaw ? ' (RAW)' : ''}${p.note ? ' — ' + p.note : ''}`);
      if (p.kind === 'video' && p.video) {
        const v = p.video;
        add('Codec', [v.codecName, v.bitDepth > 8 ? `${v.bitDepth}-bit` : '', v.hdr].filter(Boolean).join(' · '));
        add('Duration', v.duration ? `${PJ.Video.timecode(v.duration, v.fps)} (${v.frames || '?'} frames)` : '');
        add('Frame rate', v.fps ? `${+v.fps.toFixed(3)} fps` : '');
        add('Audio', v.audio ? `${v.audio.codecName} · ${v.audio.channels} ch · ${(v.audio.sampleRate / 1000).toFixed(1)} kHz` : (v.probed ? 'None' : ''));
        add('Trim', v.in || v.out != null ? `${PJ.Video.timecode(v.in || 0, v.fps)} → ${PJ.Video.timecode(v.out ?? v.duration, v.fps)}` : '');
        add('Playback', v.proxy ? 'Optimized media' : v.needsProxy ? 'Needs optimized media' : '');
      }
      add('Captured', UI.fmtDate(p.captureTime));
      add('Camera', [e.make, e.model].filter(Boolean).join(' '));
      add('Lens', e.lens);
      add('Exposure', [e.exposureTime ? PJ.Decode.formatShutter(e.exposureTime) : '', e.fNumber ? `ƒ/${e.fNumber}` : ''].filter(Boolean).join(' at '));
      add('ISO', e.iso);
      add('Focal Length', e.focalLength ? `${e.focalLength} mm${e.focalLength35 ? ` (${e.focalLength35} mm eq.)` : ''}` : '');
      add('Exp. Bias', e.exposureBias !== undefined ? `${e.exposureBias > 0 ? '+' : ''}${e.exposureBias} EV` : '');
      add('Flash', e.flash);
      add('Artist', e.artist);
      add('Copyright', e.copyright);
      add('GPS', e.gps ? `${e.gps.lat.toFixed(5)}, ${e.gps.lon.toFixed(5)}` : '');
      add('Imported', UI.fmtDate(p.importedAt));
      metaPanel.body.append(
        h('div', { class: 'field' }, h('span', null, 'Rating'), ratingRow),
        h('div', { class: 'row', style: { gap: '14px', marginBottom: '8px' } }, h('div', { class: 'field', style: { margin: 0 } }, h('span', null, 'Flag'), flagRow.el), h('div', { class: 'field', style: { margin: 0 } }, h('span', null, 'Label'), labelRow)),
        h('label', { class: 'field' }, h('span', null, 'Title'), title),
        h('label', { class: 'field' }, h('span', null, 'Caption'), caption),
        h('div', { class: 'section-title' }, 'EXIF'), dl);

      // Keywords
      const common = targets.map(t => new Set(t.keywords || [])).reduce((a, b) => new Set([...a].filter(x => b.has(x))));
      const chips = h('div', { class: 'kw-chips' }, [...common].map(k => h('span', null, k, h('i', { title: 'Remove', onclick: () => { targets.forEach(t => { t.keywords = (t.keywords || []).filter(x => x !== k); }); Cat.setMeta(targets, {}); renderRight(); } }, '×'))));
      const kwIn = h('input', { type: 'text', placeholder: 'Add keywords (comma separated)', style: { width: '100%' } });
      kwIn.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') {
          const ks = kwIn.value.split(',').map(s => s.trim()).filter(Boolean);
          targets.forEach(t => { t.keywords = [...new Set([...(t.keywords || []), ...ks])]; });
          Cat.setMeta(targets, {});
          renderRight();
        }
      });
      const allKw = new Map();
      Cat.state.photos.forEach(x => (x.keywords || []).forEach(k => allKw.set(k, (allKw.get(k) || 0) + 1)));
      const sugg = h('div', { class: 'kw-chips', style: { marginTop: '8px' } }, [...allKw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).filter(([k]) => !common.has(k)).map(([k]) => {
        const s = h('span', { style: { cursor: 'pointer', paddingRight: '8px' }, title: 'Click to add' }, '+ ' + k);
        s.addEventListener('click', () => { targets.forEach(t => { t.keywords = [...new Set([...(t.keywords || []), k])]; }); Cat.setMeta(targets, {}); renderRight(); });
        return s;
      }));
      // what the scene model sees in the photo(s): offered, never added by itself
      const seen = h('div', { class: 'kw-chips', style: { marginTop: '6px' } });
      const showSeen = () => {
        const tally = new Map();
        for (const t of targets) for (const d of (sceneSeen.get(t.id) || [])) tally.set(d.label, (tally.get(d.label) || 0) + 1);
        const labels = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).filter(k => !common.has(k));
        seen.replaceChildren(...labels.map((k) => {
          const s = h('span', { style: { cursor: 'pointer', paddingRight: '8px' }, title: multi ? `Seen in ${tally.get(k)} of ${targets.length} photos — click to add to those` : 'Click to add' }, '+ ' + k);
          s.addEventListener('click', () => {
            const to = targets.filter(t => (sceneSeen.get(t.id) || []).some(d => d.label === k));
            to.forEach(t => { t.keywords = [...new Set([...(t.keywords || []), k])]; });
            Cat.setMeta(to, {}); renderRight();
          });
          return s;
        }));
        if (!labels.length && targets.every(t => sceneSeen.has(t.id))) seen.appendChild(h('span', { class: 'muted', style: { background: 'none' } }, 'Nothing more to suggest'));
      };
      const canSee = PJ.AIMask && targets.some(t => t.kind !== 'video' && !t.missing);
      const seeBtn = canSee ? h('button', {
        class: 'btn sm', title: 'Look at the photo with the scene model (on this computer) and offer what it shows as keywords',
        onclick: async () => {
          const todo = targets.filter(t => t.kind !== 'video' && !t.missing && !sceneSeen.has(t.id)).slice(0, 200);
          seeBtn.disabled = true;
          let n = 0;
          for (const t of todo) {
            UI.activity(`Looking at ${t.name}…`, ++n / (todo.length + 1));
            try { sceneSeen.set(t.id, await PJ.AIMask.describe(t)); }
            catch (e) { console.warn('keyword suggestions:', t.name, e && e.message); sceneSeen.set(t.id, []); }
          }
          UI.activity('');
          if (seeBtn.isConnected) { seeBtn.disabled = false; showSeen(); }
        }
      }, icon('wand-magic-sparkles'), 'Suggest from the photo') : null;
      if (targets.some(t => sceneSeen.has(t.id))) showSeen();
      kwPanel.body.append(multi ? h('div', { class: 'muted', style: { marginBottom: '6px' } }, `Editing ${targets.length} photos — showing shared keywords`) : null, chips, kwIn,
        seeBtn ? h('div', { class: 'row', style: { marginTop: '8px' } }, seeBtn) : null, seen,
        allKw.size ? h('div', { class: 'section-title' }, 'Used before') : null, sugg);
    }

    function empty() {
      return h('div', { class: 'card' },
        h('div', { class: 'ic' }, icon('images')),
        h('h2', null, 'Welcome to ', h('span', { class: 'mono', style: { color: 'var(--accent)' } }, 'photos.jpeg')),
        h('p', null, 'Import photos or a whole folder to build your catalog. Edits are non-destructive — your originals are never modified.'),
        h('div', { class: 'row', style: { justifyContent: 'center', gap: '8px' } },
          h('button', { class: 'btn primary', onclick: () => app.importFiles() }, icon('file-import'), 'Import Photos…'),
          h('button', { class: 'btn', onclick: () => app.importFolder() }, icon('folder-plus'), 'Import Folder…')),
        h('div', { class: 'fmt-chips' }, ['JPEG', 'PNG', 'WebP', 'AVIF', 'TIFF'].map(f => h('span', null, f)),
          ['NEF', 'CR2', 'CR3', 'ARW', 'DNG', 'RAF', 'ORF', 'RW2', 'PEF', 'GPR'].map(f => h('span', { class: 'raw' }, f))),
        h('p', { class: 'muted', style: { marginTop: '14px', marginBottom: 0, fontSize: '11px' } }, 'Tip: drag & drop files or folders anywhere in the window.'));
    }

    return {
      left, right, topbar, bottombar, toggleStack, stackOpen: (id) => openStacks.has(id), render, updateSelection, updateCell, scrollToActive, visible, renderLeft, renderRight, empty,
      showStage, setMode, setGeoFilter, columns: () => vgrid.columns(), map,
      sourceLabel() {
        const k = view.source;
        if (k.startsWith('col:')) { const c = Cat.state.collections.find(x => x.id === k.slice(4)); return c ? `“${c.name}”` : ''; }
        if (k.startsWith('folder:')) return `“${k.slice(7).split(/[\\/]/).filter(Boolean).pop() || k.slice(7)}”`;
        return { all: 'catalog', recent: 'Previous Import', edited: 'Edited', picks: 'Picks', rejected: 'Rejected', missing: 'Missing', videos: 'Videos' }[k] || '';
      },
      setLastImport(ids) { lastImportIds = new Set(ids); Cat.setPref('lib.lastImport', ids); },
      setSource, view
    };
  }

  global.PJ.Library = { create, LABELS };
})(window);
