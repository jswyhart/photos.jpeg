/* =====================================================================
 * photos.jpeg — video transport bar for the Develop viewer:
 * play/pause, scrub, frame step, in/out trim, loop, mute, capture frame.
 * ===================================================================== */
(function (global) {
  'use strict';
  const UI = PJ.UI, Cat = PJ.Catalog, API = PJ.API, V = PJ.Video, E = PJ.Engine;
  const { h, icon } = UI;

  function create(app, viewer, root) {
    const pl = V.player;
    const btn = (ic, title, fn) => { const b = h('button', { class: 'btn sm icon', title }, icon(ic)); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
    const playBtn = btn('play', 'Play / pause (Space)', () => pl.toggle());
    const backBtn = btn('backward-step', 'Previous frame (,)', () => pl.step(-1));
    const fwdBtn = btn('forward-step', 'Next frame (.)', () => pl.step(1));
    const startBtn = btn('backward-fast', 'Go to in point / start (Home)', () => { pl.pause(true); pl.seek(pl.range()[0]); });
    const inBtn = btn('right-to-bracket', 'Set in point (Shift+I)', () => pl.setIn());
    const outBtn = btn('right-from-bracket', 'Set out point (Shift+O)', () => pl.setOut());
    const clrBtn = btn('xmark', 'Clear in/out', () => pl.clearRange());
    const loopBtn = btn('repeat', 'Loop playback', () => { pl.loop = !pl.loop; sync(); });
    const muteBtn = btn('volume-high', 'Mute', () => pl.setMuted(!pl.muted));
    const grabBtn = h('button', { class: 'btn sm', title: 'Capture the current frame as a photo (Ctrl+Shift+F)' }, icon('camera'), 'Capture Frame');
    grabBtn.addEventListener('click', (e) => { e.stopPropagation(); captureFrame(); });
    // ---- keyframes ----
    const KF = PJ.Keyframes;
    const fpsNow = () => (pl.clip && pl.clip.fps) || 30;
    const kfBtn = h('button', { class: 'btn sm icon kf-btn', title: 'Add / remove a keyframe at the playhead (K) — edits made at a keyframe animate between keyframes' }, h('span', { class: 'kf-dia' }));
    kfBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleKeyframe(); });
    const kfPrev = btn('angles-left', 'Previous keyframe (Shift+,)', () => jumpKey(-1));
    const kfNext = btn('angles-right', 'Next keyframe (Shift+.)', () => jumpKey(1));
    const kfLayer = h('div', { class: 'kf-layer' });
    function commitKf(label) { const p = pl.photo; Cat.commit(p, label); E.invalidate(p); if (pl.viewer) pl.viewer.refreshFrame(); if (app.develop) app.develop.syncAll(); sync(); }
    function toggleKeyframe() {
      const p = pl.photo; if (!p || !pl.clip) return;
      pl.pause(true);
      const i = KF.find(p.settings, pl.t, fpsNow());
      if (i >= 0) { KF.remove(p, i); KF.applyAt(p, pl.t); commitKf('Keyframe removed'); UI.toast('Keyframe removed', 'circle-info'); }
      else { KF.capture(p, pl.t, fpsNow()); commitKf('Keyframe added'); if (KF.count(p.settings) === 1) UI.toast('Keyframe added — move the playhead and change any setting to animate', 'circle-info'); }
    }
    function jumpKey(dir) {
      const p = pl.photo; if (!p) return;
      const ts = KF.times(p.settings), tol = 0.5 / fpsNow();
      const t = dir > 0 ? ts.find(x => x > pl.t + tol) : ts.slice().reverse().find(x => x < pl.t - tol);
      if (t != null) { pl.pause(true); pl.seek(t + 1e-4); }
    }
    function drawKeys() {
      const p = pl.photo, d = pl.clip ? pl.clip.duration : 0;
      const ks = p ? KF.list(p.settings) : [];
      kfLayer.replaceChildren(...(d ? ks.map((k, i) => {
        const el = h('div', { class: `kf${Math.abs(k.t - pl.t) <= 0.5 / fpsNow() ? ' on' : ''}`, title: `Keyframe at ${V.timecode(k.t, fpsNow())}${k.ease === 'linear' ? ' (linear)' : ''}`, style: { left: (k.t / d * 100) + '%' } });
        el.addEventListener('pointerdown', (e) => { e.stopPropagation(); pl.pause(true); pl.seek(k.t + 1e-4); });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          UI.menu(e.clientX, e.clientY, [
            { label: 'Smooth (ease in & out)', icon: (k.ease || 'smooth') === 'smooth' ? 'check' : null, action: () => { k.ease = 'smooth'; p.settings.keyframes = KF.list(p.settings).slice(); commitKf('Keyframe ease'); } },
            { label: 'Linear', icon: k.ease === 'linear' ? 'check' : null, action: () => { k.ease = 'linear'; p.settings.keyframes = KF.list(p.settings).slice(); commitKf('Keyframe ease'); } },
            '-',
            { label: 'Remove keyframe', icon: 'trash-can', action: () => { KF.remove(p, i); KF.applyAt(p, pl.t); commitKf('Keyframe removed'); } },
            { label: 'Remove all keyframes', icon: 'eraser', action: () => { KF.clear(p); commitKf('Keyframes cleared'); } }
          ]);
        });
        return el;
      }) : []));
      const on = p && KF.find(p.settings, pl.t, fpsNow()) >= 0;
      kfBtn.classList.toggle('on', !!on);
      kfBtn.classList.toggle('has', !!(p && ks.length));
      kfPrev.disabled = kfNext.disabled = !ks.length;
    }

    const tcCur = h('span', { class: 'tc' }), tcDur = h('span', { class: 'tc dim' }), status = h('span', { class: 'video-proxy-note' });

    const track = h('div', { class: 'track' }), rangeEl = h('div', { class: 'range' }), head = h('div', { class: 'head' });
    const mIn = h('div', { class: 'mark in' }), mOut = h('div', { class: 'mark out' }), hoverTc = h('div', { class: 'hover-tc hidden' });
    const scrub = h('div', { class: 'scrub' }, track, rangeEl, kfLayer, mIn, mOut, head, hoverTc);
    const bar = h('div', { class: 'transport hidden' },
      scrub,
      h('div', { class: 'row' }, startBtn, backBtn, playBtn, fwdBtn, tcCur, status, h('span', { class: 'sep' }), kfPrev, kfBtn, kfNext, h('span', { class: 'spacer', style: { flex: 1 } }),
        inBtn, outBtn, clrBtn, h('span', { class: 'sep' }), loopBtn, muteBtn, grabBtn, tcDur));
    root.appendChild(bar);
    ['pointerdown', 'wheel', 'dblclick', 'mousedown'].forEach(ev => bar.addEventListener(ev, (e) => e.stopPropagation()));

    const tAt = (x) => { const r = scrub.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * (pl.clip ? pl.clip.duration : 0); };
    let dragging = false, wasPlaying = false;
    scrub.addEventListener('pointerdown', (e) => {
      if (!pl.clip) return;
      dragging = true; wasPlaying = pl.playing;
      pl.pause(true);
      try { scrub.setPointerCapture(e.pointerId); } catch (_) { }
      pl.seek(tAt(e.clientX), false);
    });
    scrub.addEventListener('pointermove', (e) => {
      if (pl.clip) { const t = tAt(e.clientX), r = scrub.getBoundingClientRect(); hoverTc.textContent = V.timecode(t, pl.clip.fps); hoverTc.style.left = (e.clientX - r.left) + 'px'; hoverTc.classList.remove('hidden'); }
      if (dragging) pl.seek(tAt(e.clientX), false);
    });
    scrub.addEventListener('pointerleave', () => hoverTc.classList.add('hidden'));
    const end = async (e) => {
      if (!dragging) return;
      dragging = false;
      await pl.seek(tAt(e.clientX), !wasPlaying);
      if (wasPlaying) pl.play();
      sync();
    };
    scrub.addEventListener('pointerup', end);
    scrub.addEventListener('pointercancel', end);

    function pos() {
      if (!pl.clip) return;
      const d = pl.clip.duration || 1;
      head.style.left = (pl.t / d * 100) + '%';
      tcCur.textContent = V.timecode(pl.t, pl.clip.fps);
      drawKeys();
    }
    function sync() {
      const show = !!pl.photo && pl.viewer === viewer;
      const changed = bar.classList.contains('hidden') === show;
      bar.classList.toggle('hidden', !show);
      root.classList.toggle('has-transport', show);
      if (changed) requestAnimationFrame(() => viewer.draw());
      if (!show) return;
      const v = pl.photo.video, d = pl.clip ? pl.clip.duration : 0;
      playBtn.replaceChildren(icon(pl.playing ? 'pause' : 'play'));
      muteBtn.replaceChildren(icon(pl.muted ? 'volume-xmark' : 'volume-high'));
      loopBtn.classList.toggle('on', pl.loop);
      tcDur.textContent = d ? V.timecode(d, pl.clip.fps) : '';
      const [a, b] = d ? pl.range() : [0, 0];
      const trimmed = d && (a > 0 || b < d - 1e-3);
      rangeEl.style.left = (d ? a / d * 100 : 0) + '%';
      rangeEl.style.width = (d ? (b - a) / d * 100 : 0) + '%';
      mIn.style.display = trimmed ? '' : 'none'; mOut.style.display = trimmed ? '' : 'none';
      mIn.style.left = (d ? a / d * 100 : 0) + '%'; mOut.style.left = (d ? b / d * 100 : 0) + '%';
      clrBtn.disabled = !trimmed;
      status.textContent = v.proxy ? 'optimized media' : '';
      [playBtn, backBtn, fwdBtn, startBtn, inBtn, outBtn, grabBtn, scrub].forEach(x => { x.style.opacity = pl.clip && pl.clip.ready ? '' : '0.4'; });
      pos();
    }
    pl.events.on('state', sync);
    pl.events.on('time', pos);
    pl.events.on('settled', () => { if (pl.photo && KF.count(pl.photo.settings) && app.develop) app.develop.syncAll(); drawKeys(); });
    Cat.events.on('edited', (p, label) => {
      if (p !== pl.photo) return;
      // undo/redo restore the values captured at another time: show the ones under the playhead
      if (label === 'history' && KF.applyAt(p, pl.t)) E.invalidate(p);
      drawKeys();
    });
    pl.events.on('error', (e) => UI.toast(`Video: ${e.message || e}`, 'triangle-exclamation'));

    viewer.events.on('photo', (p) => {
      if (p && p.kind === 'video') pl.attach(p, viewer).then(sync);
      else pl.detach();
      sync();
    });
    viewer.events.on('tool', (t) => { if (t === 'crop') pl.pause(); });

    /* ---------- capture frame ---------- */
    async function captureFrame() {
      const p = pl.photo;
      if (!p) return;
      pl.pause();
      try {
        UI.activity('Capturing frame…');
        const clip = V.clipFor(p);
        const canvas = await clip.frameCanvas(pl.t);
        const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 }) : await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.95));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const base = p.name.replace(/\.[^.]+$/, '');
        const tc = V.timecode(pl.t, clip.fps).replace(/:/g, '-');
        const dir = API.supportsSameFolder ? API.dirname(p.path) : await API.defaultExportDir();
        const path = await API.writeFile(API.joinPath(dir, `${base}_${tc}.jpg`), bytes, 'unique');
        if (!path) throw new Error('could not write the file');
        const name = String(path).split(/[\\/]/).pop();
        const added = Cat.addPhotos([{ path, name: /\.jpe?g$/i.test(name) ? name : `${base}_${tc}.jpg`, folder: API.dirname(path), size: bytes.length }]);
        if (added[0]) {
          added[0].captureTime = p.captureTime;
          Cat.setSettings(added[0], PJ.Pipeline.clone(p.settings), `Captured from ${p.name}`);
          E.queueThumb(added[0]);
        }
        app.refresh();
        UI.toast(API.isDesktop ? `Frame saved as ${name} and added to the catalog` : 'Frame captured');
      } catch (e) {
        console.error(e);
        UI.toast(`Couldn't capture frame: ${e.message || e}`, 'triangle-exclamation');
      } finally { UI.activity(''); }
    }

    /* ---------- keys (Develop only) ---------- */
    function onKey(e) {
      if (!pl.photo || pl.viewer !== viewer || root.classList.contains('hidden') || UI.hasModal()) return false;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
      const k = e.key, kl = k.toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (k === ' ' && !mod) { pl.toggle(); return true; }
      if (k === ',' && !mod && !e.shiftKey) { pl.step(e.altKey ? -10 : -1); return true; }
      if (k === '.' && !mod && !e.shiftKey) { pl.step(e.altKey ? 10 : 1); return true; }
      if (e.shiftKey && !mod && kl === 'i') { pl.setIn(); return true; }
      if (e.shiftKey && !mod && kl === 'o') { pl.setOut(); return true; }
      if (mod && e.shiftKey && kl === 'f') { captureFrame(); return true; }
      if (!mod && !e.shiftKey && kl === 'k') { toggleKeyframe(); return true; }
      if (!mod && e.shiftKey && (k === '<' || k === ',')) { jumpKey(-1); return true; }
      if (!mod && e.shiftKey && (k === '>' || k === '.')) { jumpKey(1); return true; }
      return false;
    }
    window.addEventListener('keydown', (e) => { if (onKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);

    sync();
    return { sync, captureFrame };
  }

  global.PJ.Transport = { create };
})(window);
