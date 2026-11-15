/* =====================================================================
 * photos.jpeg — duplicate finder.
 * Every thumbnail run stores a 64-bit difference hash of the unedited picture (photo.dhash).
 * Photos are grouped when their hashes differ in at most a few bits; candidate pairs come from
 * hash-chunk buckets (pigeonhole), so 50k photos group in well under a second.
 * Nothing is deleted from disk: duplicates can be selected, rejected, collected or removed
 * from the catalog.
 * ===================================================================== */
(function (global) {
  'use strict';
  const UI = PJ.UI, Cat = PJ.Catalog, API = PJ.API, E = PJ.Engine;
  const { h, icon } = UI;

  const LEVELS = {
    exact: { label: 'Identical pictures', bits: 0 },
    near: { label: 'Near-duplicates (resized, recompressed, lightly edited)', bits: 3 },
    similar: { label: 'Similar (bursts, small changes)', bits: 7 }
  };

  const pop32 = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
  const words = (hex) => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];
  const base = (n) => String(n).replace(/\.[^.]+$/, '').toLowerCase();

  /** Hash photos that don't have one yet, from their thumbnails (refined at their next preview build). */
  async function ensureHashes(list, onProgress) {
    const todo = list.filter(p => !p.dhash && (p.thumbV || !API.hasThumbStore));
    let done = 0;
    const c = document.createElement('canvas'); c.width = 72; c.height = 64;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const one = (p) => new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        try {
          ctx.drawImage(im, 0, 0, 72, 64);
          p.dhash = E.dhash(ctx.getImageData(0, 0, 72, 64)); p.dhashV = 'thumb';
        } catch (_) { /* unreadable thumbnail */ }
        resolve();
      };
      im.onerror = () => resolve();
      im.src = API.thumbUrl(p.id, p.thumbV);
    });
    for (let i = 0; i < todo.length; i += 8) {
      await Promise.all(todo.slice(i, i + 8).map(one));
      done = Math.min(todo.length, i + 8);
      onProgress && onProgress(done, todo.length);
    }
    if (todo.length) Cat.scheduleSave();
    return todo.length;
  }

  /** Group photos whose hashes are within `bits`. Returns arrays of photos (2+ per group). */
  function group(list, bits, opts = {}) {
    const items = [];
    for (const p of list) {
      if (!p.dhash || p.virtualOf || p.missing) continue;
      const [a, b] = words(p.dhash);
      if (pop32(a) + pop32(b) < 4 || pop32(~a) + pop32(~b) < 4) continue; // flat frames (black, white, blank) would all match
      items.push({ p, a, b, video: p.kind === 'video' });
    }
    const parent = items.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const join = (i, j) => { i = find(i); j = find(j); if (i !== j) parent[Math.max(i, j)] = Math.min(i, j); };
    // Pigeonhole: hashes within `bits` share at least one of (bits+1) equal chunks
    const nChunks = bits <= 0 ? 1 : bits <= 3 ? 4 : 8, chunkBits = 64 / nChunks;
    const chunk = (it, k) => {
      if (nChunks === 1) return it.a + ':' + it.b;
      const off = k * chunkBits, word = off < 32 ? it.a : it.b, sh = 32 - chunkBits - (off % 32);
      return k + ':' + ((word >>> sh) & ((1 << chunkBits) - 1 || 0xFFFFFFFF));
    };
    let compared = 0;
    for (let k = 0; k < nChunks; k++) {
      const buckets = new Map();
      items.forEach((it, i) => { const key = chunk(it, k); const b = buckets.get(key); if (b) b.push(i); else buckets.set(key, [i]); });
      for (const b of buckets.values()) {
        if (b.length < 2 || b.length > 4000) continue; // a giant bucket is a featureless chunk; other chunks will catch real pairs
        for (let x = 0; x < b.length; x++) for (let y = x + 1; y < b.length; y++) {
          const i = b[x], j = b[y], A = items[i], B = items[j];
          if (A.video !== B.video) continue;
          compared++;
          if (pop32(A.a ^ B.a) + pop32(A.b ^ B.b) <= bits) join(i, j);
        }
      }
    }
    const groups = new Map();
    items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it.p); });
    let out = [...groups.values()].filter(g => g.length > 1);
    // RAW + JPEG shot together (same name, same folder) are a pair, not duplicates
    if (!opts.includePairs) {
      out = out.filter(g => {
        const names = new Set(g.map(p => (p.folder || '') + '/' + base(p.name)));
        const exts = new Set(g.map(p => p.isRaw ? 'raw' : 'rgb'));
        return !(names.size === 1 && exts.size === 2 && g.length === 2);
      });
    }
    out.forEach(g => g.sort((x, y) => score(y) - score(x)));
    out.sort((x, y) => y.length - x.length || (x[0].captureTime || '').localeCompare(y[0].captureTime || ''));
    return { groups: out, compared, hashed: items.length };
  }
  /** Which copy to keep: edited, rated, picked, then the biggest file. */
  function score(p) {
    return (p.edited ? 1e15 : 0) + (p.flag === 1 ? 5e14 : p.flag === -1 ? -5e14 : 0) + (p.rating || 0) * 1e14 +
      (p.isRaw ? 5e13 : 0) + (p.width || 0) * (p.height || 0) * 10 + (p.size || 0) / 1e3;
  }

  async function open(app) {
    const scopeSel = h('select', null, h('option', { value: 'view' }, 'Photos in the current view'), h('option', { value: 'all' }, 'Whole catalog'));
    const levelSel = h('select', null, Object.entries(LEVELS).map(([k, v]) => h('option', { value: k }, v.label)));
    levelSel.value = Cat.pref('dupes.level', 'near');
    const pairs = UI.checkbox('Include RAW + JPEG pairs', false, () => run());
    const status = h('div', { class: 'muted small' });
    const body = h('div', { class: 'dupes-list' });
    const checked = new Set();
    let result = { groups: [] };

    function fmtSize(n) { return UI.fmtBytes ? UI.fmtBytes(n) : Math.round(n / 1024) + ' KB'; }
    function renderGroups() {
      const MAX = 400;
      body.replaceChildren(...result.groups.slice(0, MAX).map((g, gi) => h('div', { class: 'dg' },
        h('div', { class: 'dg-h' }, h('b', null, `Group ${gi + 1}`), h('span', { class: 'muted' }, `${g.length} photos`)),
        h('div', { class: 'dg-row' }, g.map((p, i) => {
          const src = p.thumbV || !API.hasThumbStore ? API.thumbUrl(p.id, p.thumbV) : '';
          const cb = h('input', { type: 'checkbox' });
          cb.checked = checked.has(p.id);
          cb.addEventListener('change', () => { if (cb.checked) checked.add(p.id); else checked.delete(p.id); updateCount(); });
          const card = h('div', { class: `dc${i === 0 ? ' keep' : ''}`, title: p.path },
            h('div', { class: 'dc-i' }, src ? h('img', { src, loading: 'lazy', draggable: 'false' }) : icon('image')),
            h('div', { class: 'dc-t' }, h('label', { class: 'chk' }, cb, h('span', { class: 'nm' }, Cat.displayName(p)))),
            h('div', { class: 'dc-m muted' }, [p.width && `${p.width}×${p.height}`, p.size && fmtSize(p.size), p.format].filter(Boolean).join(' · ')),
            h('div', { class: 'dc-m muted' }, (p.folder || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/') || '—'),
            i === 0 ? h('span', { class: 'dc-keep' }, icon('star'), 'Keep') : null);
          card.querySelector('.dc-i').addEventListener('dblclick', () => { m.close(); app.openDevelop(p.id); });
          return card;
        })))),
        result.groups.length > MAX ? h('div', { class: 'muted' }, `…and ${result.groups.length - MAX} more groups`) : null);
      updateCount();
    }
    function updateCount() {
      const dupN = result.groups.reduce((a, g) => a + g.length - 1, 0);
      status.textContent = result.groups.length
        ? `${result.groups.length} group${result.groups.length > 1 ? 's' : ''} · ${dupN} extra cop${dupN === 1 ? 'y' : 'ies'} · ${checked.size} checked (the best copy of each group is marked Keep)`
        : 'No duplicates found.';
    }
    async function run() {
      Cat.setPref('dupes.level', levelSel.value);
      const list = scopeSel.value === 'all' ? Cat.state.photos : app.visible();
      const missing = list.filter(p => !p.dhash && !p.virtualOf && !p.missing).length;
      if (missing) {
        status.textContent = `Analysing ${missing} photo(s)…`;
        await ensureHashes(list, (d, n) => { status.textContent = `Analysing photos… ${d} / ${n}`; });
      }
      const t0 = performance.now();
      result = group(list, LEVELS[levelSel.value].bits, { includePairs: pairs.input.checked });
      checked.clear();
      result.groups.forEach(g => g.slice(1).forEach(p => checked.add(p.id)));
      renderGroups();
      const noHash = list.filter(p => !p.dhash && !p.virtualOf && !p.missing).length;
      if (noHash) status.textContent += ` · ${noHash} photo(s) without previews yet were skipped`;
      console.debug(`duplicates: ${result.hashed} hashed, ${result.compared} pairs compared in ${Math.round(performance.now() - t0)} ms`);
    }
    scopeSel.addEventListener('change', run);
    levelSel.addEventListener('change', run);

    const targets = () => [...checked].map(id => Cat.get(id)).filter(Boolean);
    const m = UI.modal({
      title: 'Find Duplicates', icon: 'clone', wide: true,
      body: h('div', { class: 'dupes' },
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, scopeSel, levelSel, pairs.el),
        status, body,
        h('div', { class: 'muted small' }, 'Files on disk are never deleted. Remove from Catalog only forgets the checked copies.')),
      footerLeft: h('div', { class: 'row', style: { gap: '6px' } },
        h('button', { class: 'btn sm', onclick: () => { const ids = [...checked]; if (ids.length) { app.selectIds(ids); UI.toast(`Selected ${ids.length} photo(s)`); } } }, icon('check-double'), 'Select checked'),
        h('button', { class: 'btn sm', onclick: () => { const t = targets(); if (!t.length) return; Cat.setMeta(t, { flag: -1 }); UI.toast(`Rejected ${t.length} photo(s)`, 'ban'); } }, icon('ban'), 'Reject'),
        h('button', { class: 'btn sm', onclick: () => { const t = targets(); if (!t.length) return; let c = Cat.state.collections.find(x => x.name === 'Duplicates'); if (!c) Cat.addCollection('Duplicates', t.map(p => p.id)); else Cat.addToCollection(c.id, t.map(p => p.id)); UI.toast(`Added ${t.length} photo(s) to “Duplicates”`, 'layer-group'); } }, icon('layer-group'), 'Collect')),
      buttons: [{ label: 'Close' }, {
        label: 'Remove from Catalog…', danger: true, onClick: async () => {
          const t = targets();
          if (!t.length) return false;
          const ok = await UI.confirm('Remove from catalog', `Remove ${t.length} checked photo(s) from the catalog? The files stay on disk.`, 'Remove', true);
          if (!ok) return false;
          app.removePhotos(t.map(p => p.id));
          await run();
          return false;
        }
      }]
    });
    run();
  }

  global.PJ.Dupes = { open, group, ensureHashes, LEVELS };
})(window);
