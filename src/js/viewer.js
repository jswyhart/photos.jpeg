/* =====================================================================
 * photos.jpeg — Develop viewer: zoom/pan, before/after, 1:1 tiles,
 * crop & straighten, spot removal, masks, white-balance picker.
 * Coordinates: "fo" = full-resolution output pixels (after crop).
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, UI = PJ.UI, E = PJ.Engine, Cat = PJ.Catalog;
  const { h } = UI;

  const ASPECTS = [
    { key: 'original', label: 'Original' }, { key: 'free', label: 'Free' }, { key: '1:1', label: '1 × 1' },
    { key: '4:5', label: '4 × 5 / 8 × 10' }, { key: '5:7', label: '5 × 7' }, { key: '2:3', label: '2 × 3 / 4 × 6' },
    { key: '3:4', label: '3 × 4' }, { key: '8.5:11', label: '8.5 × 11' }, { key: '9:16', label: '9 × 16' }, { key: '10:16', label: '16 × 10' }
  ];

  function create(root) {
    const events = UI.emitter();
    const cv = h('canvas');
    const ov = h('canvas');
    const info = h('div', { class: 'loupe-info hidden' });
    const zoomInd = h('div', { class: 'zoom-ind' });
    const rendering = h('div', { class: 'rendering' }, 'Rendering…');
    const labA = h('div', { class: 'ba-label hidden' }, 'Before');
    const labB = h('div', { class: 'ba-label after hidden' }, 'After');
    root.append(cv, ov, info, zoomInd, rendering, labA, labB);

    const st = {
      photo: null,
      version: 0,
      after: null,        // {canvas, w, h (fo dims), version, level, crop}
      before: null,       // {canvas, w, h, sig}
      tile: null,         // {canvas, rect:{x,y,w,h} fo, version}
      zoom: 'fit',        // 'fit' | 'fill' | number (screen px per fo px, relative to 1:1)
      center: null,       // [x,y] in fo
      compare: 'single',  // 'single' | 'split' | 'side' | 'topbottom'
      split: 0.5,
      holdBefore: false,
      clipping: { hi: false, lo: false },
      tool: 'none',
      showInfo: 0,
      bg: 'dark',
      // crop
      crop: null,         // {rect, aspect, lock, start:{geo}}
      // spots
      proof: false, proofPaper: false, showFaces: false, faceBox: null,
      spotSel: -1, spotSize: 0.02, spotMode: 'heal', spotFeather: 50, spotOpacity: 100, spotsVisible: true,
      // masks
      maskIdx: -1, maskCreate: null, maskOverlay: false, brush: { size: 80, feather: 50, flow: 70, erase: false },
      hover: null,
      live: null,         // {canvas, w, h} GPU-graded video frame shown while playing/scrubbing
      liveClear: false,
      busy: false, pending: 0, lastLive: 0
    };

    /* ---------------- geometry helpers ---------------- */
    function srcInfo() { return st.photo ? E.cachedSource(st.photo) : null; }
    function fullDims() { const s = srcInfo(); return s ? [s.fullW, s.fullH] : [st.photo?.width || 1, st.photo?.height || 1]; }
    function cropOverride() {
      if (st.tool !== 'crop' || !st.photo) return null;
      const [W, H] = fullDims();
      return P.rotatedBounds(W, H, st.photo.settings.geo);
    }
    function geoFull() {
      const [W, H] = fullDims();
      return P.buildGeometry(st.photo.settings, W, H, cropOverride());
    }
    function foDims() { const g = geoFull(); return [g.outW, g.outH]; }
    function longEdge() { const [W, H] = fullDims(); return Math.max(W, H); }
    /** source-normalized (u,v) -> fo px */
    function srcToFo(u, v) { const L = longEdge(); return geoFull().toOutput(u * L, v * L); }
    /** fo px -> source-normalized */
    function foToSrc(x, y) { const L = longEdge(); const p = geoFull().toSource(x, y, [0, 0]); return [p[0] / L, p[1] / L]; }

    /* ---------------- view transform ---------------- */
    function vpSize() { const r = root.getBoundingClientRect(); return [r.width, r.height]; }
    function fitScale(fw, fh, vw, vh) { const pad = 24; return Math.min((vw - pad * 2) / fw, (vh - pad * 2) / fh); }
    /** Returns the list of panes [{x,y,w,h (screen), scale, ox, oy, which:'after'|'before'}] */
    function panes() {
      const [vw, vh0] = vpSize();
      // keep the picture clear of the video transport bar
      const tb = root.querySelector('.transport:not(.hidden)');
      const vh = Math.max(80, vh0 - (tb ? tb.offsetHeight + 12 : 0));
      const [fw, fh] = foDims();
      const side = (st.compare === 'side' || st.compare === 'topbottom') && st.tool !== 'crop';
      const list = side ? (st.compare === 'side'
        ? [{ x: 0, y: 0, w: vw / 2, h: vh, which: 'before' }, { x: vw / 2, y: 0, w: vw / 2, h: vh, which: 'after' }]
        : [{ x: 0, y: 0, w: vw, h: vh / 2, which: 'before' }, { x: 0, y: vh / 2, w: vw, h: vh / 2, which: 'after' }])
        : [{ x: 0, y: 0, w: vw, h: vh, which: 'after' }];
      for (const p of list) {
        let scale;
        const fs = fitScale(fw, fh, p.w, p.h);
        if (st.zoom === 'fit') scale = fs;
        else if (st.zoom === 'fill') scale = Math.max(p.w / fw, p.h / fh);
        else scale = st.zoom / (window.devicePixelRatio || 1); // zoom 1 = 100%: one image pixel per device pixel
        p.scale = scale;
        const c = st.center || [fw / 2, fh / 2];
        let ox = p.x + p.w / 2 - c[0] * scale, oy = p.y + p.h / 2 - c[1] * scale;
        // clamp: center small images, keep large images covering the pane
        if (fw * scale <= p.w) ox = p.x + (p.w - fw * scale) / 2; else ox = Math.min(p.x, Math.max(p.x + p.w - fw * scale, ox));
        if (fh * scale <= p.h) oy = p.y + (p.h - fh * scale) / 2; else oy = Math.min(p.y, Math.max(p.y + p.h - fh * scale, oy));
        p.ox = ox; p.oy = oy;
      }
      return list;
    }
    function mainPane() { const ps = panes(); return ps[ps.length - 1]; }
    function toScreen(x, y, pane) { pane = pane || mainPane(); return [pane.ox + x * pane.scale, pane.oy + y * pane.scale]; }
    function toFo(sx, sy, pane) { pane = pane || mainPane(); return [(sx - pane.ox) / pane.scale, (sy - pane.oy) / pane.scale]; }
    function zoomPercent() { return Math.round(mainPane().scale * (window.devicePixelRatio || 1) * 100); }

    /* ---------------- rendering ---------------- */
    function geoSig(s) { return JSON.stringify([s.geo, s.transform, s.lens.distortion, s.lens.fisheye, s.lens.pr, s.lens.p1, s.lens.p2, s.lens.p3, s.lens.p4, st.tool === 'crop']); }
    function renderOpts(extra) {
      // soft proof: the picture as an sRGB file or screen will show it, with what sRGB cannot hold marked
      const o = { clipping: st.clipping, cropOverride: null, outSpace: E.P3_CANVAS && st.proof !== 'srgb' ? 'p3' : 'srgb' };
      if (st.proof === 'srgb' || st.proof === 'adobe') o.gamutWarn = st.proof;
      else if (st.proof && PJ.Proof) { const t = PJ.Proof.getSync(st.proof); if (t) o.gamutCube = st.proofPaper && t.paper ? { n: t.n, srgb: t.srgb, p3: t.p3, paper: t.paper, noMark: st.proofPaper === 'only' } : { n: t.n, srgb: t.srgb, p3: t.p3 }; }      // a printer profile's id
      if (st.tool === 'crop') {
        const s = srcInfo();
        // crop override must be expressed for the level being rendered; normalized so identical
        if (s) o.cropOverride = P.rotatedBounds(s.proxy.width, s.proxy.height, st.photo.settings.geo);
      }
      if (st.tool === 'mask' && (st.maskOverlay || st.maskPainting) && st.maskIdx >= 0) o.overlayMask = st.maskIdx;
      return Object.assign(o, extra || {});
    }
    function levelCropOverride(level, src) {
      if (st.tool !== 'crop') return null;
      const s = src || srcInfo();
      if (!s) return null;
      const lv = level === 'draft' ? s.draft : s.proxy;
      return P.rotatedBounds(lv.width, lv.height, st.photo.settings.geo);
    }

    async function doRender(quality) {
      if (!st.photo) return;
      if (st.busy) { st.pending = Math.max(st.pending, quality === 'proxy' ? 2 : 1); return; }
      st.busy = true;
      const photo = st.photo, ver = st.version;
      const settings = P.clone(photo.settings);
      rendering.classList.add('on');
      try {
        // the source may have been evicted from the cache (many photos open, a refresh, a new video frame)
        const src = await E.ensureSource(photo);
        // Live drags go to the GPU at proxy resolution when it can; the CPU settles the result
        let res = quality === 'draft' && photo.kind !== 'video' && E.gpuReady()
          ? E.renderGPU(photo, settings, renderOpts({ cropOverride: levelCropOverride('proxy', src) })) : null;
        if (!res) res = await E.render(photo, settings, quality, renderOpts({ cropOverride: levelCropOverride(quality, src) }), 0);
        if (res && photo === st.photo) {
          const [fw, fh] = foDims();
          st.after = { canvas: E.toCanvas(res), w: fw, h: fh, version: ver, level: quality };
          if (st.liveClear && !playingHere()) { st.live = null; st.liveClear = false; }
          events.emit('rendered', res, quality);
          if (quality === 'proxy') scheduleTile();
          draw();
        }
      } catch (e) {
        console.error(e);
        events.emit('error', e);
      } finally {
        st.busy = false;
        rendering.classList.remove('on');
      }
      if (st.pending) {
        const q = st.pending === 2 ? 'proxy' : 'draft';
        st.pending = 0;
        doRender(q);
      }
    }
    const commitRender = UI.debounce(() => doRender('proxy'), 60);

    /** Called whenever the photo's settings change. phase 'live' | 'commit' */
    function playingHere() { const pl = PJ.Video && PJ.Video.player; return !!(pl && pl.playing && pl.photo === st.photo); }
    function update(phase) {
      if (!st.photo) return;
      st.version++;
      st.tile = null;
      if (playingHere()) { draw(); return; } // the playback loop grades every frame on the GPU
      if (phase === 'live') {
        commitRender.cancel();
        doRender('draft');
        commitRender(); // settle with a full-quality proxy shortly after the last live change
      } else {
        commitRender.cancel();
        if (E.gpuReady() && st.photo.kind !== 'video') doRender('draft'); // instant GPU frame, then the exact one
        doRender('proxy');
      }
      if (needsBefore()) renderBefore();
      draw();
    }

    function needsBefore() { return st.photo && st.tool !== 'crop' && (st.compare !== 'single' || st.holdBefore); }
    async function renderBefore() {
      const photo = st.photo;
      const sig = geoSig(photo.settings) + photo.id;
      if (st.before && st.before.sig === sig) return;
      try {
        const res = await E.render(photo, P.clone(photo.settings), 'proxy', { before: true, outSpace: E.P3_CANVAS ? 'p3' : 'srgb' }, 0);
        if (res && photo === st.photo) {
          const [fw, fh] = foDims();
          st.before = { canvas: E.toCanvas(res), w: fw, h: fh, sig };
          draw();
        }
      } catch (e) { console.error(e); }
    }

    /* 1:1 tiles from the full-resolution source */
    const scheduleTile = UI.debounce(async () => {
      if (!st.photo || st.tool === 'crop' || st.live) return;
      const s = srcInfo();
      if (!s) return;
      const pane = mainPane();
      const proxyScale = Math.max(s.proxy.width, s.proxy.height) / Math.max(s.fullW, s.fullH);
      const dpr = window.devicePixelRatio || 1;
      if (pane.scale * dpr <= proxyScale * 1.2) return; // proxy is sharp enough
      const [vw, vh] = vpSize();
      const [fw, fh] = foDims();
      const a = toFo(pane.x, pane.y, pane), b = toFo(pane.x + pane.w, pane.y + pane.h, pane);
      const rect = {
        x: Math.max(0, Math.floor(Math.min(a[0], b[0]))), y: Math.max(0, Math.floor(Math.min(a[1], b[1]))),
        w: 0, h: 0
      };
      rect.w = Math.min(fw, Math.ceil(Math.max(a[0], b[0]))) - rect.x;
      rect.h = Math.min(fh, Math.ceil(Math.max(a[1], b[1]))) - rect.y;
      if (rect.w <= 0 || rect.h <= 0 || rect.w * rect.h > 16e6) return;
      const ver = st.version, photo = st.photo;
      rendering.textContent = 'Loading 1:1…';
      rendering.classList.add('on');
      try {
        const res = await E.render(photo, P.clone(photo.settings), 'full', renderOpts({ region: rect }), 0);
        if (res && photo === st.photo && ver === st.version) {
          st.tile = { canvas: E.toCanvas(res), rect: res.region, version: ver };
          draw();
        }
      } catch (e) { console.warn('tile failed', e); }
      rendering.textContent = 'Rendering…';
      rendering.classList.remove('on');
      void vw; void vh;
    }, 220);

    /* ---------------- drawing ---------------- */
    function sizeCanvases() {
      const dpr = window.devicePixelRatio || 1;
      const [vw, vh] = vpSize();
      for (const c of [cv, ov]) {
        const w = Math.round(vw * dpr), hh = Math.round(vh * dpr);
        if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; c.style.width = vw + 'px'; c.style.height = vh + 'px'; }
      }
      return dpr;
    }
    function drawLayer(ctx, layer, pane, fw, fh) {
      if (!layer) return;
      ctx.drawImage(layer.canvas, pane.ox, pane.oy, fw * pane.scale, fh * pane.scale);
    }
    function draw() {
      const dpr = sizeCanvases();
      const ctx = cv.getContext('2d', E.P3_CANVAS ? { colorSpace: 'display-p3' } : undefined);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      labA.classList.add('hidden'); labB.classList.add('hidden');
      const after = st.live || st.after;
      if (!st.photo || !after) { drawOverlay(); updateInfo(); return; }
      const [fw, fh] = foDims();
      const ps = panes();
      const showBefore = st.holdBefore && st.tool !== 'crop';
      for (const pane of ps) {
        ctx.save();
        ctx.beginPath(); ctx.rect(pane.x, pane.y, pane.w, pane.h); ctx.clip();
        // shadow
        ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 18;
        ctx.fillStyle = '#000';
        ctx.fillRect(pane.ox, pane.oy, fw * pane.scale, fh * pane.scale);
        ctx.shadowBlur = 0;
        if (pane.which === 'before' || showBefore) {
          drawLayer(ctx, st.live ? after : (st.before || after), pane, fw, fh);
        } else {
          drawLayer(ctx, after, pane, fw, fh);
          if (!st.live && st.tile && st.tile.version === st.version && st.after.version === st.version) {
            const r = st.tile.rect;
            ctx.drawImage(st.tile.canvas, pane.ox + r.x * pane.scale, pane.oy + r.y * pane.scale, r.w * pane.scale, r.h * pane.scale);
          }
          if (st.compare === 'split' && st.tool !== 'crop' && st.before && !st.live) {
            const sx = pane.x + pane.w * st.split;
            ctx.save();
            ctx.beginPath(); ctx.rect(pane.x, pane.y, sx - pane.x, pane.h); ctx.clip();
            drawLayer(ctx, st.before, pane, fw, fh);
            ctx.restore();
            ctx.fillStyle = '#fff'; ctx.fillRect(sx - 1, pane.y, 2, pane.h);
            ctx.beginPath(); ctx.arc(sx, pane.y + pane.h / 2, 13, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(25,25,28,.9)'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
            ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('◂ ▸', sx, pane.y + pane.h / 2 + 0.5);
            labA.classList.remove('hidden'); labB.classList.remove('hidden');
            labA.style.left = (pane.x + 10) + 'px'; labA.style.right = 'auto';
            labB.style.left = 'auto'; labB.style.right = '10px';
          }
        }
        ctx.restore();
        if (ps.length > 1) {
          const lab = pane.which === 'before' ? labA : labB;
          lab.classList.remove('hidden');
          lab.style.left = (pane.x + 10) + 'px'; lab.style.right = 'auto';
          lab.style.top = (pane.y + 10) + 'px';
        } else { labA.style.top = labB.style.top = '10px'; }
      }
      if (ps.length > 1) {
        ctx.fillStyle = '#26282d';
        if (st.compare === 'side') ctx.fillRect(ps[1].x - 1, 0, 2, ps[0].h); else ctx.fillRect(0, ps[1].y - 1, ps[0].w, 2);
      }
      if (showBefore) { labA.classList.remove('hidden'); labA.style.left = '10px'; labA.style.top = '10px'; }
      drawOverlay();
      updateInfo();
      events.emit('view');
    }

    function updateInfo() {
      zoomInd.textContent = st.photo ? (st.zoom === 'fit' ? `Fit · ${zoomPercent()}%` : st.zoom === 'fill' ? `Fill · ${zoomPercent()}%` : `${zoomPercent()}%`) : '';
      const p = st.photo;
      if (!p || !st.showInfo) { info.classList.add('hidden'); return; }
      info.classList.remove('hidden');
      const e = p.exif || {};
      const [fw, fh] = st.photo ? foDims() : [0, 0];
      const lines = st.showInfo === 1
        ? [`<b>${UI.escapeHtml(Cat.displayName(p))}</b>`, `${fw} × ${fh} px · ${p.format}${p.isRaw ? ' RAW' : ''}`, UI.fmtDate(p.captureTime)]
        : [`<b>${UI.escapeHtml(Cat.displayName(p))}</b>`, [e.make, e.model].filter(Boolean).join(' ') || '—', e.lens || '',
        [e.exposureTime ? PJ.Decode.formatShutter(e.exposureTime) : '', e.fNumber ? `ƒ/${e.fNumber}` : '', e.iso ? `ISO ${e.iso}` : '', e.focalLength ? `${e.focalLength} mm` : ''].filter(Boolean).join(' · ')];
      info.innerHTML = lines.filter(Boolean).join('<br>');
    }

    /* ---------------- overlay (tools) ---------------- */
    function drawOverlay() {
      const dpr = window.devicePixelRatio || 1;
      const ctx = ov.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ov.width, ov.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!st.photo || !st.after) return;
      if (st.tool === 'crop' && st.crop) drawCrop(ctx);
      else if (st.tool === 'spot' && st.spotsVisible) drawSpots(ctx);
      else if (st.tool === 'mask') drawMasks(ctx);
      if (st.showFaces && st.tool === 'none') drawFaces(ctx);
      if (st.hover && st.hover.brush) {
        const [x, y] = st.hover.brush;
        const r = st.brush.size / 2;
        ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(x, y, r * (1 - st.brush.feather / 100 * 0.9), 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = st.brush.erase || st.hover.alt ? '#ff8080' : '#fff';
        ctx.font = '600 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(st.brush.erase || st.hover.alt ? '−' : '+', x, y);
      }
    }

    /* ---- Crop ---- */
    function cropScreenRect() {
      const [W, H] = fullDims();
      const [Wo, Ho] = P.orientedSize(W, H, st.photo.settings.geo.orient);
      const bb = P.rotatedBounds(W, H, st.photo.settings.geo);
      const c = st.crop.rect;
      const [x0, y0] = toScreen((c.x - bb.x) * Wo, (c.y - bb.y) * Ho);
      const [x1, y1] = toScreen((c.x + c.w - bb.x) * Wo, (c.y + c.h - bb.y) * Ho);
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, Wo, Ho, bb };
    }
    function drawCrop(ctx) {
      const r = cropScreenRect();
      const [vw, vh] = vpSize();
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.rect(0, 0, vw, vh); ctx.rect(r.x, r.y, r.w, r.h); ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
      // guides
      const g = st.crop.rotating ? 12 : 3;
      ctx.strokeStyle = st.crop.rotating ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.4)';
      ctx.beginPath();
      for (let i = 1; i < g; i++) {
        const x = r.x + r.w * i / g, y = r.y + r.h * i / g;
        ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y);
      }
      ctx.stroke();
      // handles
      ctx.fillStyle = '#fff';
      const hs = 7;
      handlesOf(r).forEach(([x, y]) => { ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs); });
      ctx.fillStyle = 'rgba(0,0,0,.7)';
      ctx.fillRect(r.x + 6, r.y + r.h - 24, 140, 18);
      ctx.fillStyle = '#ddd'; ctx.font = '11px ui-monospace, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      const [W, H] = fullDims(); void W; void H;
      ctx.fillText(`${Math.round(st.crop.rect.w * r.Wo)} × ${Math.round(st.crop.rect.h * r.Ho)}  ${st.photo.settings.geo.angle.toFixed(1)}°`, r.x + 11, r.y + r.h - 15);
    }
    function handlesOf(r) {
      return [[r.x, r.y], [r.x + r.w / 2, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h / 2], [r.x + r.w, r.y + r.h], [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y + r.h / 2]];
    }
    const HANDLE_NAMES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

    function aspectValue(key) {
      const [W, H] = fullDims();
      const [Wo, Ho] = P.orientedSize(W, H, st.photo.settings.geo.orient);
      if (key === 'free') return null;
      if (key === 'original') return Wo / Ho;
      let [a, b] = key.split(':').map(Number);
      // keep orientation matching current crop
      const cur = st.crop ? (st.crop.rect.w * Wo) / (st.crop.rect.h * Ho) : Wo / Ho;
      let ar = a / b;
      if ((cur >= 1) !== (ar >= 1) && ar !== 1) ar = 1 / ar;
      return ar;
    }

    function enterCrop() {
      const g = st.photo.settings.geo;
      st.crop = { rect: { ...g.crop }, aspect: g.aspect || 'original', lock: g.aspect !== 'free', start: P.clone(g), rotating: false };
    }
    function applyCropAspect(key) {
      if (!st.crop) return;
      const [W, H] = fullDims();
      st.crop.aspect = key;
      st.crop.lock = key !== 'free';
      const ar = aspectValue(key);
      if (!ar) { draw(); return; }
      const [Wo, Ho] = P.orientedSize(W, H, st.photo.settings.geo.orient);
      const c = st.crop.rect;
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      // largest rect of aspect within current crop area's size
      let wpx = c.w * Wo, hpx = wpx / ar;
      if (hpx > c.h * Ho) { hpx = c.h * Ho; wpx = hpx * ar; }
      let nr = { x: cx - wpx / Wo / 2, y: cy - hpx / Ho / 2, w: wpx / Wo, h: hpx / Ho };
      if (!P.cropInside(W, H, st.photo.settings.geo, nr)) nr = P.constrainCrop(W, H, st.photo.settings.geo, nr);
      // if crop was full image, expand to max for aspect
      if (Math.abs(c.w - 1) < 1e-3 && Math.abs(c.h - 1) < 1e-3) nr = P.maxCropForAspect(W, H, st.photo.settings.geo, ar);
      st.crop.rect = nr;
      draw();
    }
    function swapCropOrientation() {
      if (!st.crop) return;
      const [W, H] = fullDims();
      const [Wo, Ho] = P.orientedSize(W, H, st.photo.settings.geo.orient);
      const c = st.crop.rect;
      const ar = (c.h * Ho) / (c.w * Wo);
      st.crop.rect = P.maxCropForAspect(W, H, st.photo.settings.geo, ar);
      if (st.crop.aspect === 'original') st.crop.aspect = 'custom';
      draw();
    }
    function setStraighten(angle, phase) {
      const g = st.photo.settings.geo;
      const [W, H] = fullDims();
      g.angle = P.clamp(Math.round(angle * 100) / 100, -45, 45);
      if (st.crop) {
        const prev = st.crop.rect;
        const ar = (prev.w * P.orientedSize(W, H, g.orient)[0]) / (prev.h * P.orientedSize(W, H, g.orient)[1]);
        // LR behaviour: crop auto-shrinks to stay inside the rotated image
        if (st.crop.fullBeforeRotate || (!P.cropInside(W, H, g, prev))) {
          const mx = P.maxCropForAspect(W, H, g, ar);
          st.crop.rect = st.crop.fullBeforeRotate ? mx : P.constrainCrop(W, H, g, prev);
        }
      } else {
        const [Wo, Ho] = P.orientedSize(W, H, g.orient);
        const ar = (g.crop.w * Wo) / (g.crop.h * Ho);
        g.crop = P.cropInside(W, H, g, g.crop) ? g.crop : P.maxCropForAspect(W, H, g, ar);
      }
      update(phase);
      events.emit('geo');
    }
    function commitCrop() {
      if (!st.crop) return;
      const g = st.photo.settings.geo;
      g.crop = { ...st.crop.rect };
      g.aspect = st.crop.aspect;
      Cat.commit(st.photo, 'Crop');
    }

    /* ---- Faces ---- */
    // a face's box is in fractions of the photo's own frame; its four corners go through the photo's geometry to the screen
    function faceCorners(b) {
      const [W, H] = fullDims(), L = Math.max(W, H);
      return [[b[0], b[1]], [b[0] + b[2], b[1]], [b[0] + b[2], b[1] + b[3]], [b[0], b[1] + b[3]]].map(([fx, fy]) => toScreen(...srcToFo(fx * W / L, fy * H / L)));
    }
    function drawFaces(ctx) {
      const F = PJ.Faces;
      ctx.save(); ctx.lineJoin = 'round'; ctx.font = '12px system-ui, sans-serif'; ctx.textBaseline = 'top';
      for (const f of (st.photo.faces || [])) {
        if (f.x) continue;
        const c = faceCorners(f.b), who = f.p && F ? F.person(f.p) : null;
        ctx.strokeStyle = who ? 'rgba(120,200,255,.95)' : 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5; ctx.setLineDash(who ? [] : [5, 4]);
        ctx.beginPath(); c.forEach((p, k) => k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
        const label = who ? who.name : 'Who is this?', lx = Math.min(...c.map(p => p[0])), ly = Math.max(...c.map(p => p[1])) + 4, tw = ctx.measureText(label).width;
        ctx.setLineDash([]); ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(lx - 1, ly - 1, tw + 10, 18);
        ctx.fillStyle = '#fff'; ctx.fillText(label, lx + 4, ly + 2);
      }
      if (st.faceBox) { const b = st.faceBox; ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0)); }
      ctx.restore();
    }
    function hitFace(sx, sy) {
      for (const f of (st.photo.faces || [])) {
        if (f.x) continue;
        const c = faceCorners(f.b), xs = c.map(p => p[0]), ys = c.map(p => p[1]);
        if (sx >= Math.min(...xs) && sx <= Math.max(...xs) && sy >= Math.min(...ys) && sy <= Math.max(...ys) + 22) return f;
      }
      return null;
    }

    /* ---- Spots ---- */
    function drawSpots(ctx) {
      const spots = st.photo.settings.spots || [];
      const L = longEdge();
      const strokePath = (pts) => { ctx.beginPath(); pts.forEach((p, k) => { const [x, y] = toScreen(...srcToFo(p[0], p[1])); if (k) ctx.lineTo(x, y); else { ctx.moveTo(x, y); ctx.lineTo(x + 0.01, y); } }); };
      if (st.fillStroke) {
        // the area being painted for a fill
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(255,70,90,.45)'; ctx.lineWidth = Math.max(2, st.fillStroke.r * 2 * L * mainPane().scale);
        strokePath(st.fillStroke.pts); ctx.stroke(); ctx.restore();
      }
      spots.forEach((sp, i) => {
        if (sp.mode === 'fill') {
          const sel = i === st.spotSel;
          ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
          if (sel) { ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = Math.max(2, sp.r * 2 * L * mainPane().scale); strokePath(sp.pts); ctx.stroke(); }
          ctx.strokeStyle = sel ? '#fff' : 'rgba(255,255,255,.7)'; ctx.lineWidth = sel ? 1.6 : 1;
          strokePath(sp.pts); ctx.stroke(); ctx.restore();
          return;
        }
        const [dx, dy] = toScreen(...srcToFo(sp.x, sp.y));
        const [sx, sy] = toScreen(...srcToFo(sp.sx, sp.sy));
        const rr = sp.r * L * mainPane().scale;
        const sel = i === st.spotSel;
        ctx.lineWidth = sel ? 1.6 : 1;
        ctx.strokeStyle = sel ? '#fff' : 'rgba(255,255,255,.7)';
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(dx, dy, rr, 0, Math.PI * 2); ctx.stroke();
        if (sel) {
          ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          const ang = Math.atan2(dy - sy, dx - sx);
          ctx.beginPath();
          ctx.moveTo(sx + Math.cos(ang) * rr, sy + Math.sin(ang) * rr);
          ctx.lineTo(dx - Math.cos(ang) * rr, dy - Math.sin(ang) * rr);
          ctx.stroke();
          // arrow head
          const ax = dx - Math.cos(ang) * rr, ay = dy - Math.sin(ang) * rr;
          ctx.beginPath(); ctx.moveTo(ax, ay);
          ctx.lineTo(ax - Math.cos(ang - 0.4) * 8, ay - Math.sin(ang - 0.4) * 8);
          ctx.lineTo(ax - Math.cos(ang + 0.4) * 8, ay - Math.sin(ang + 0.4) * 8);
          ctx.closePath(); ctx.fillStyle = '#fff'; ctx.fill();
        }
        ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,.7)';
        ctx.beginPath(); ctx.arc(dx, dy, 2, 0, Math.PI * 2); ctx.fill();
      });
      if (st.hover && st.hover.spot) {
        const [x, y] = st.hover.spot;
        ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, st.spotSize * L * mainPane().scale, 0, Math.PI * 2); ctx.stroke();
      }
    }
    function hitSpot(sx, sy) {
      const spots = st.photo.settings.spots || [];
      const L = longEdge(), sc = mainPane().scale;
      for (let i = spots.length - 1; i >= 0; i--) {
        const sp = spots[i];
        if (sp.mode === 'fill') {
          const rf = Math.max(6, sp.r * L * sc);
          if (sp.pts.some(p => { const [qx, qy] = toScreen(...srcToFo(p[0], p[1])); return Math.hypot(sx - qx, sy - qy) <= rf; })) return { i, part: 'fill' };
          continue;
        }
        const [dx, dy] = toScreen(...srcToFo(sp.x, sp.y));
        const rr = Math.max(6, sp.r * L * sc);
        if (Math.hypot(sx - dx, sy - dy) <= rr) return { i, part: 'dest' };
        if (i === st.spotSel) {
          const [qx, qy] = toScreen(...srcToFo(sp.sx, sp.sy));
          if (Math.hypot(sx - qx, sy - qy) <= rr) return { i, part: 'src' };
        }
      }
      return null;
    }
    /** Choose a source offset with similar surroundings (search ring around the spot). */
    function autoSource(u, v, r) {
      const s = srcInfo();
      if (!s) return [u + r * 2.5, v];
      const lv = s.proxy, L = Math.max(lv.width, lv.height), d = lv.data;
      const sample = (x, y) => {
        const px = Math.round(x * L), py = Math.round(y * L);
        if (px < 0 || py < 0 || px >= lv.width || py >= lv.height) return null;
        const i = (py * lv.width + px) * 4;
        return [d[i], d[i + 1], d[i + 2]];
      };
      const ring = (cx, cy, rad) => {
        const out = [];
        for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; out.push(sample(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad)); }
        return out;
      };
      const target = ring(u, v, r * 1.25);
      let best = null, bestScore = Infinity;
      for (let k = 0; k < 16; k++) {
        const a = k / 16 * Math.PI * 2;
        for (const dist of [2.4, 3.2, 4.2]) {
          const cx = u + Math.cos(a) * r * dist, cy = v + Math.sin(a) * r * dist;
          if (cx - r < 0 || cy - r < 0 || (cx + r) * L > lv.width || (cy + r) * L > lv.height) continue;
          const rr = ring(cx, cy, r * 1.25);
          const inner = [sample(cx, cy), ...ring(cx, cy, r * 0.6)];
          let score = 0, ok = true;
          for (let j = 0; j < 16; j++) {
            if (!rr[j] || !target[j]) { ok = false; break; }
            score += Math.abs(rr[j][0] - target[j][0]) + Math.abs(rr[j][1] - target[j][1]) + Math.abs(rr[j][2] - target[j][2]);
          }
          if (!ok) continue;
          // prefer smooth texture inside the candidate
          const m = inner.filter(Boolean);
          const mean = [0, 1, 2].map(c => m.reduce((a2, q) => a2 + q[c], 0) / m.length);
          score += m.reduce((a2, q) => a2 + Math.abs(q[0] - mean[0]) + Math.abs(q[1] - mean[1]) + Math.abs(q[2] - mean[2]), 0) * 0.5;
          score += dist * 6;
          if (score < bestScore) { bestScore = score; best = [cx, cy]; }
        }
      }
      return best || [u + r * 2.5, v];
    }

    /* ---- Masks ---- */
    function activeMask() { const m = st.photo && st.photo.settings.masks; return m && st.maskIdx >= 0 ? m[st.maskIdx] : null; }
    function drawMasks(ctx) {
      const masks = st.photo.settings.masks || [];
      masks.forEach((m, i) => {
        const sel = i === st.maskIdx;
        if (m.type === 'radial') {
          const pts = ellipsePoints(m, 1);
          ctx.strokeStyle = sel ? '#fff' : 'rgba(255,255,255,.35)'; ctx.lineWidth = sel ? 1.4 : 1;
          ctx.beginPath(); pts.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.stroke();
          if (sel) {
            const inner = ellipsePoints(m, 1 - (m.feather ?? 50) / 100);
            ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(255,255,255,.55)';
            ctx.beginPath(); inner.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.stroke();
            ctx.setLineDash([]);
            radialHandles(m).forEach(hd => dotHandle(ctx, hd.x, hd.y, hd.kind === 'c'));
          } else pin(ctx, ...toScreen(...srcToFo(m.cx, m.cy)));
        } else if (m.type === 'linear') {
          const a = toScreen(...srcToFo(m.x0, m.y0)), b = toScreen(...srcToFo(m.x1, m.y1));
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len, L2 = 3000;
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          ctx.strokeStyle = sel ? '#fff' : 'rgba(255,255,255,.35)'; ctx.lineWidth = sel ? 1.4 : 1;
          [a, mid, b].forEach((p, k) => {
            ctx.setLineDash(k === 1 ? [6, 4] : []);
            ctx.beginPath(); ctx.moveTo(p[0] - nx * L2, p[1] - ny * L2); ctx.lineTo(p[0] + nx * L2, p[1] + ny * L2); ctx.stroke();
          });
          ctx.setLineDash([]);
          if (sel) { dotHandle(ctx, a[0], a[1]); dotHandle(ctx, b[0], b[1]); dotHandle(ctx, mid[0], mid[1], true); }
          else pin(ctx, mid[0], mid[1]);
        } else if (m.type === 'brush') {
          const d = (m.dabs || [])[0];
          if (d) pin(ctx, ...toScreen(...srcToFo(d.x, d.y)), sel);
        }
      });
    }
    function pin(ctx, x, y, sel) {
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = sel ? '#4f8ff7' : 'rgba(30,30,30,.8)'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    function dotHandle(ctx, x, y, big) {
      ctx.beginPath(); ctx.arc(x, y, big ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = big ? '#4f8ff7' : '#fff'; ctx.fill();
      ctx.strokeStyle = big ? '#fff' : '#222'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    function ellipsePoints(m, k) {
      const a = (m.angle || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      const out = [];
      for (let i = 0; i < 64; i++) {
        const t = i / 64 * Math.PI * 2;
        const ex = Math.cos(t) * m.rx * k, ey = Math.sin(t) * m.ry * k;
        out.push(toScreen(...srcToFo(m.cx + ca * ex - sa * ey, m.cy + sa * ex + ca * ey)));
      }
      return out;
    }
    function radialHandles(m) {
      const a = (m.angle || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      const P2 = (ex, ey) => toScreen(...srcToFo(m.cx + ca * ex - sa * ey, m.cy + sa * ex + ca * ey));
      const c = toScreen(...srcToFo(m.cx, m.cy));
      return [
        { kind: 'c', x: c[0], y: c[1] },
        { kind: 'rx+', ...xy(P2(m.rx, 0)) }, { kind: 'rx-', ...xy(P2(-m.rx, 0)) },
        { kind: 'ry+', ...xy(P2(0, m.ry)) }, { kind: 'ry-', ...xy(P2(0, -m.ry)) }
      ];
    }
    const xy = (p) => ({ x: p[0], y: p[1] });
    function hitMask(sx, sy) {
      const masks = st.photo.settings.masks || [];
      const m = activeMask();
      if (m) {
        if (m.type === 'radial') {
          for (const hd of radialHandles(m)) if (Math.hypot(hd.x - sx, hd.y - sy) < 9) return { idx: st.maskIdx, part: hd.kind };
        } else if (m.type === 'linear') {
          const a = toScreen(...srcToFo(m.x0, m.y0)), b = toScreen(...srcToFo(m.x1, m.y1));
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (Math.hypot(mid[0] - sx, mid[1] - sy) < 9) return { idx: st.maskIdx, part: 'mid' };
          if (Math.hypot(a[0] - sx, a[1] - sy) < 9) return { idx: st.maskIdx, part: 'p0' };
          if (Math.hypot(b[0] - sx, b[1] - sy) < 9) return { idx: st.maskIdx, part: 'p1' };
        }
      }
      // pins of other masks
      for (let i = masks.length - 1; i >= 0; i--) {
        if (i === st.maskIdx) continue;
        const mm = masks[i];
        let p = null;
        if (mm.type === 'radial') p = toScreen(...srcToFo(mm.cx, mm.cy));
        else if (mm.type === 'linear') { const a = toScreen(...srcToFo(mm.x0, mm.y0)), b = toScreen(...srcToFo(mm.x1, mm.y1)); p = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
        else if (mm.dabs && mm.dabs[0]) p = toScreen(...srcToFo(mm.dabs[0].x, mm.dabs[0].y));
        if (p && Math.hypot(p[0] - sx, p[1] - sy) < 9) return { idx: i, part: 'select' };
      }
      return null;
    }

    /* ---------------- pointer interaction ---------------- */
    let drag = null;
    let spaceDown = false;
    function localXY(e) { const r = root.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    function setCursor() {
      root.classList.remove('cur-crosshair', 'cur-grab', 'cur-grabbing', 'cur-zoom', 'cur-none', 'cur-picker');
      if (drag && drag.kind === 'pan') root.classList.add('cur-grabbing');
      else if (spaceDown) root.classList.add('cur-grab');
      else if (st.tool === 'wb') root.classList.add('cur-picker');
      else if (st.tool === 'spot' || (st.tool === 'mask' && st.maskCreate)) root.classList.add('cur-crosshair');
      else if (st.tool === 'mask' && activeMask() && activeMask().type === 'brush') root.classList.add('cur-none');
      else if (st.tool === 'none' && st.zoom !== 'fit') root.classList.add('cur-grab');
      else if (st.tool === 'none') root.classList.add('cur-zoom');
    }

    /* ---- two-finger pinch zoom / pan (touch) ---- */
    const touches = new Map();
    let pinch = null;
    let lastTap = 0;
    function pinchGeom() {
      const pts = [...touches.values()];
      return { mid: [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], d: Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1 };
    }
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, localXY(e));
      if (touches.size === 2 && st.photo && st.after) {
        drag = null; st.maskPainting = false;
        const g = pinchGeom();
        pinch = { d0: g.d, z0: mainPane().scale * (window.devicePixelRatio || 1), fo: toFo(g.mid[0], g.mid[1]) };
      }
    });
    root.addEventListener('pointermove', (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, localXY(e));
      if (!pinch || touches.size < 2) return;
      const g = pinchGeom();
      const dpr = window.devicePixelRatio || 1;
      const zoom = P.clamp(pinch.z0 * g.d / pinch.d0, 0.02, 16);
      st.zoom = zoom;
      const sc = zoom / dpr, pane = mainPane();
      st.center = [pinch.fo[0] - (g.mid[0] - (pane.x + pane.w / 2)) / sc, pinch.fo[1] - (g.mid[1] - (pane.y + pane.h / 2)) / sc];
      st.tile = null;
      draw();
    });
    const touchEnd = (e) => {
      touches.delete(e.pointerId);
      if (pinch && touches.size < 2) { pinch = null; drag = null; scheduleTile(); setCursor(); events.emit('zoom'); }
    };
    root.addEventListener('pointerup', touchEnd);
    root.addEventListener('pointercancel', touchEnd);

    root.addEventListener('pointerdown', async (e) => {
      if (!st.photo || !st.after || e.button === 2 || pinch) return;
      const [x, y] = localXY(e);
      try { root.setPointerCapture(e.pointerId); } catch (_) { }
      const pane = mainPane();
      const fo = toFo(x, y, pane);
      const panAllowed = spaceDown || e.button === 1;
      if (panAllowed) { drag = { kind: 'pan', x, y, c: currentCenter() }; setCursor(); return; }

      // split divider
      if (st.compare === 'split' && st.tool !== 'crop' && Math.abs(x - (pane.x + pane.w * st.split)) < 14) { drag = { kind: 'split' }; return; }

      // faces: a click on one asks who it is; Alt-drag marks one the detector missed
      if (st.showFaces && st.tool === 'none') {
        const f = hitFace(x, y);
        if (f && !e.altKey) { events.emit('faceClick', { face: f, x: e.clientX, y: e.clientY }); return; }
        if (e.altKey) { st.faceBox = { x0: x, y0: y, x1: x, y1: y }; drag = { kind: 'faceBox' }; return; }
      }

      if (st.tool === 'crop' && st.crop) {
        const r = cropScreenRect();
        const hs = handlesOf(r);
        for (let i = 0; i < hs.length; i++) if (Math.hypot(hs[i][0] - x, hs[i][1] - y) < 10) {
          drag = { kind: 'cropHandle', h: HANDLE_NAMES[i], start: { ...st.crop.rect }, x, y, r }; return;
        }
        if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) { drag = { kind: 'cropMove', start: { ...st.crop.rect }, x, y, r }; return; }
        // outside: rotate
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const [W, H] = fullDims();
        const g = st.photo.settings.geo;
        const full = Math.abs(st.crop.rect.w - P.maxCropForAspect(W, H, g, (st.crop.rect.w * r.Wo) / (st.crop.rect.h * r.Ho)).w) < 0.002;
        st.crop.fullBeforeRotate = full;
        drag = { kind: 'cropRotate', a0: Math.atan2(y - cy, x - cx), ang0: g.angle, cx, cy };
        st.crop.rotating = true;
        return;
      }
      if (st.colorPick) {
        // one click to take a colour from the photo (a mask's colour range)
        const cb = st.colorPick; st.colorPick = null; root.classList.remove('cur-picker');
        const c = await E.sampleAt(st.photo, st.photo.settings, fo[0], fo[1], 4);
        if (c) {
          const g = (v) => { v = Math.max(0, Math.min(1, v)); return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };
          const hs = [0, 0]; P.hueSat(g(c[0]), g(c[1]), g(c[2]), hs);
          if (hs[1] < 0.06) PJ.UI.toast('That spot is close to grey: pick somewhere with more colour', 'circle-info');
          else cb(Math.round(hs[0] * 360));
        }
        return;
      }
      if (st.tool === 'wb') {
        const s = await E.sampleAt(st.photo, st.photo.settings, fo[0], fo[1], 3);
        if (s) {
          const wb = P.neutralizeWB(s[0], s[1], s[2]);
          st.photo.settings.temp = wb.temp; st.photo.settings.tint = wb.tint; st.photo.settings.wbMode = 'custom';
          Cat.commit(st.photo, 'White Balance: picker');
          update('commit');
          events.emit('settings');
        }
        events.emit('toolDone', 'wb');
        return;
      }
      if (st.tool === 'spot') {
        const hit = hitSpot(x, y);
        if (hit) {
          st.spotSel = hit.i; events.emit('spotSel');
          const spots = st.photo.settings.spots, one = spots[hit.i];
          if (hit.part === 'fill') { draw(); return; }           // a fill belongs to where it was painted: it is selected, not moved
          // a stroke moves as one piece
          const starts = new Map((one.g ? spots.filter(q => q.g === one.g) : [one]).map(q => [q, P.clone(q)]));
          drag = { kind: 'spot', i: hit.i, part: hit.part, x, y, start: P.clone(one), starts };
          draw(); return;
        }
        const [u, v] = foToSrc(fo[0], fo[1]);
        if (u < 0 || v < 0) return;
        const r = st.spotSize;
        if (st.spotMode === 'fill') {
          // paint over what should go; the fill is made when the button is let go
          st.spotSel = -1;
          st.fillStroke = { pts: [[u, v]], r };
          drag = { kind: 'fillStroke', last: [u, v], r };
          draw(); return;
        }
        const [su, sv] = autoSource(u, v, r);
        st.photo.settings.spots.push({ id: Cat.uid('sp_'), x: u, y: v, r, sx: su, sy: sv, mode: st.spotMode, feather: st.spotFeather, opacity: st.spotOpacity });
        st.spotSel = st.photo.settings.spots.length - 1;
        // Dragging on paints a stroke: more spots along the path, all taking their pixels from the same
        // distance and direction, so wires, scratches and dust trails can be removed in one go.
        drag = { kind: 'spotStroke', off: [su - u, sv - v], last: [u, v], r, g: null, n: 1 };
        update('live');
        events.emit('spotSel');
        return;
      }
      if (st.tool === 'mask') {
        if (st.maskCreate) {
          const [u, v] = foToSrc(fo[0], fo[1]);
          const type = st.maskCreate;
          let m;
          if (type === 'brush') {
            m = newMask('brush'); m.dabs = [];
            st.photo.settings.masks.push(m); st.maskIdx = st.photo.settings.masks.length - 1;
            st.maskCreate = null;
            events.emit('masks');
            // fall through into painting below
          } else {
            m = newMask(type);
            if (type === 'linear') Object.assign(m, { x0: u, y0: v, x1: u, y1: v + 0.001 });
            else Object.assign(m, { cx: u, cy: v, rx: 0.01, ry: 0.01, angle: 0, feather: 50 });
            st.photo.settings.masks.push(m); st.maskIdx = st.photo.settings.masks.length - 1;
            st.maskCreate = null;
            drag = { kind: 'maskCreate', type, u, v, x, y };
            events.emit('masks');
            setCursor();
            return;
          }
        }
        const m = activeMask();
        const hit = hitMask(x, y);
        if (hit && hit.part === 'select') { st.maskIdx = hit.idx; events.emit('masks'); update('commit'); return; }
        if (hit) { drag = { kind: 'maskEdit', part: hit.part, start: P.clone(m), x, y, uv: foToSrc(fo[0], fo[1]) }; return; }
        if (m && m.type === 'brush') {
          st.maskPainting = true;
          drag = { kind: 'paint', last: null, erase: st.brush.erase || e.altKey };
          paintAt(x, y, drag);
          return;
        }
      }
      // default: zoom toggle / pan
      if (st.tool === 'none' || st.tool === 'mask' || st.tool === 'spot') {
        if (st.zoom === 'fit') {
          drag = { kind: 'clickZoom', x, y, fo };
        } else {
          drag = { kind: 'pan', x, y, c: currentCenter(), clickZoom: true, moved: false };
        }
        setCursor();
      }
    });

    root.addEventListener('pointermove', (e) => {
      const [x, y] = localXY(e);
      if (!st.photo || pinch) return;
      if (!drag) {
        // hover affordances
        if (st.tool === 'mask' && activeMask() && activeMask().type === 'brush' && !st.maskCreate) { st.hover = { brush: [x, y], alt: e.altKey }; drawOverlay(); }
        else if (st.tool === 'spot') { st.hover = { spot: [x, y] }; drawOverlay(); }
        else if (st.hover) { st.hover = null; drawOverlay(); }
        events.emit('hover', toFo(x, y));
        return;
      }
      const pane = mainPane();
      if (drag.kind === 'pan') {
        const dx = x - drag.x, dy = y - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        st.center = [drag.c[0] - dx / pane.scale, drag.c[1] - dy / pane.scale];
        st.tile = null;
        draw();
        return;
      }
      if (drag.kind === 'clickZoom') { if (Math.abs(x - drag.x) + Math.abs(y - drag.y) > 4) drag.moved = true; return; }
      if (drag.kind === 'split') { st.split = P.clamp((x - pane.x) / pane.w, 0.02, 0.98); draw(); return; }
      if (drag.kind === 'cropMove' || drag.kind === 'cropHandle') { cropDrag(drag, x, y, e.shiftKey); return; }
      if (drag.kind === 'cropRotate') {
        const a = Math.atan2(y - drag.cy, x - drag.cx);
        let ang = drag.ang0 + (a - drag.a0) * 180 / Math.PI;
        setStraighten(ang, 'live');
        events.emit('geo');
        return;
      }
      if (drag.kind === 'faceBox') { st.faceBox.x1 = x; st.faceBox.y1 = y; drawOverlay(); return; }
      if (drag.kind === 'fillStroke') {
        const [u, v] = foToSrc(...toFo(x, y, pane));
        if (u < 0 || v < 0 || st.fillStroke.pts.length >= 300) return;
        if (Math.hypot(u - drag.last[0], v - drag.last[1]) >= drag.r * 0.35) { st.fillStroke.pts.push([u, v]); drag.last = [u, v]; draw(); }
        return;
      }
      if (drag.kind === 'spotStroke') {
        const [u, v] = foToSrc(...toFo(x, y, pane));
        if (u < 0 || v < 0 || drag.n >= 400) return;
        const spots = st.photo.settings.spots;
        // lay spots down about every half radius, so they overlap into a continuous line
        let d = Math.hypot(u - drag.last[0], v - drag.last[1]);
        const stepLen = drag.r * 0.6;
        while (d >= stepLen && drag.n < 400) {
          const t = stepLen / d, nu = drag.last[0] + (u - drag.last[0]) * t, nv = drag.last[1] + (v - drag.last[1]) * t;
          if (!drag.g) { drag.g = Cat.uid('st_'); spots[spots.length - 1].g = drag.g; }
          spots.push({ id: Cat.uid('sp_'), x: nu, y: nv, r: drag.r, sx: nu + drag.off[0], sy: nv + drag.off[1], mode: st.spotMode, feather: st.spotFeather, opacity: st.spotOpacity, g: drag.g });
          drag.last = [nu, nv]; drag.n++;
          d = Math.hypot(u - nu, v - nv);
        }
        st.spotSel = spots.length - 1;
        update('live');
        return;
      }
      if (drag.kind === 'spot') {
        const [u0, v0] = foToSrc(...toFo(drag.x, drag.y, pane));
        const [u1, v1] = foToSrc(...toFo(x, y, pane));
        const du = u1 - u0, dv = v1 - v0;
        for (const [sp, start] of drag.starts) {
          if (drag.part === 'dest') { sp.x = start.x + du; sp.y = start.y + dv; if (!e.altKey) { sp.sx = start.sx + du; sp.sy = start.sy + dv; } }
          else { sp.sx = start.sx + du; sp.sy = start.sy + dv; }
        }
        drag.moved = true;
        update('live');
        return;
      }
      if (drag.kind === 'maskCreate') {
        const m = activeMask();
        const [u, v] = foToSrc(...toFo(x, y, pane));
        if (drag.type === 'linear') { m.x1 = u; m.y1 = v; }
        else {
          const du = u - drag.u, dv = v - drag.v;
          if (e.shiftKey) { const r = Math.hypot(du, dv); m.rx = m.ry = Math.max(0.005, r); }
          else { m.rx = Math.max(0.005, Math.abs(du)); m.ry = Math.max(0.005, Math.abs(dv)); }
        }
        update('live');
        return;
      }
      if (drag.kind === 'maskEdit') {
        const m = activeMask();
        const [u, v] = foToSrc(...toFo(x, y, pane));
        const du = u - drag.uv[0], dv = v - drag.uv[1];
        const s0 = drag.start;
        if (m.type === 'linear') {
          if (drag.part === 'mid') { m.x0 = s0.x0 + du; m.y0 = s0.y0 + dv; m.x1 = s0.x1 + du; m.y1 = s0.y1 + dv; }
          else if (drag.part === 'p0') { m.x0 = s0.x0 + du; m.y0 = s0.y0 + dv; }
          else { m.x1 = s0.x1 + du; m.y1 = s0.y1 + dv; }
        } else if (m.type === 'radial') {
          if (drag.part === 'c') { m.cx = s0.cx + du; m.cy = s0.cy + dv; }
          else {
            const a = (m.angle || 0) * Math.PI / 180;
            const lx = Math.cos(a) * (u - m.cx) + Math.sin(a) * (v - m.cy);
            const ly = -Math.sin(a) * (u - m.cx) + Math.cos(a) * (v - m.cy);
            if (drag.part.startsWith('rx')) m.rx = Math.max(0.004, Math.abs(lx)); else m.ry = Math.max(0.004, Math.abs(ly));
            if (e.shiftKey) { if (drag.part.startsWith('rx')) m.ry = m.rx; else m.rx = m.ry; }
          }
        }
        update('live');
        return;
      }
      if (drag.kind === 'paint') {
        paintAt(x, y, drag);
        st.hover = { brush: [x, y], alt: drag.erase };
        return;
      }
    });

    function endDrag(e) {
      if (!drag) return;
      const d = drag; drag = null;
      const [x, y] = e ? localXY(e) : [0, 0];
      if (d.kind === 'clickZoom' && !d.moved) {
        // Touch: double-tap to zoom (single taps are too easy to trigger)
        if (e && e.pointerType === 'touch') {
          const now = performance.now();
          if (now - lastTap > 350) { lastTap = now; setCursor(); return; }
          lastTap = 0;
        }
        zoomAt(x, y, 1);
      } else if (d.kind === 'pan') {
        if (d.clickZoom && !d.moved) {
          if (e && e.pointerType === 'touch') {
            const now = performance.now();
            if (now - lastTap > 350) { lastTap = now; setCursor(); return; }
            lastTap = 0;
          }
          setZoom('fit');
        }
        else scheduleTile();
      } else if (d.kind === 'cropRotate') {
        st.crop.rotating = false; st.crop.fullBeforeRotate = false;
        update('commit'); events.emit('geo');
      } else if (d.kind === 'cropMove' || d.kind === 'cropHandle') {
        events.emit('geo');
      } else if (d.kind === 'faceBox') {
        const b = st.faceBox; st.faceBox = null; drawOverlay();
        if (b && Math.abs(b.x1 - b.x0) > 12 && Math.abs(b.y1 - b.y0) > 12) {
          // the drawn rectangle, taken back to the photo's own frame
          const [W, H] = fullDims(), L = Math.max(W, H), pane = mainPane();
          const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([sx, sy]) => { const [u, v] = foToSrc(...toFo(sx, sy, pane)); return [u * L / W, v * L / H]; });
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), x0 = Math.max(0, Math.min(...xs)), y0 = Math.max(0, Math.min(...ys)), x1 = Math.min(1, Math.max(...xs)), y1 = Math.min(1, Math.max(...ys));
          if (x1 > x0 && y1 > y0) events.emit('faceBox', { box: [x0, y0, x1 - x0, y1 - y0] });
        }
      } else if (d.kind === 'fillStroke') {
        const stroke = st.fillStroke, photo = st.photo;
        const sp = { id: Cat.uid('sp_'), mode: 'fill', x: stroke.pts[0][0], y: stroke.pts[0][1], sx: stroke.pts[0][0], sy: stroke.pts[0][1], r: stroke.r, pts: stroke.pts, feather: st.spotFeather, opacity: st.spotOpacity };
        PJ.UI.activity('Filling from the surroundings…', 0.5);
        PJ.Fill.create(photo, sp, photo.settings.spots.slice()).then(() => {
          photo.settings.spots.push(sp);
          Cat.commit(photo, 'Fill');
          if (st.photo === photo) { st.spotSel = photo.settings.spots.length - 1; update('commit'); events.emit('spotSel'); }
        }).catch((e) => PJ.UI.toast(String(e && e.message || e), 'triangle-exclamation'))
          .finally(() => { PJ.UI.activity('', 0); if (st.fillStroke === stroke) st.fillStroke = null; draw(); });
      } else if (d.kind === 'spotStroke') {
        const what = st.spotMode === 'clone' ? 'Clone' : 'Heal';
        Cat.commit(st.photo, d.n > 1 ? `${what} stroke` : `${what} spot`);
        update('commit');
        events.emit('spotSel');
      } else if (d.kind === 'spot') {
        if (d.moved) { Cat.commit(st.photo, d.starts.size > 1 ? 'Move stroke' : 'Move spot'); update('commit'); }
      } else if (d.kind === 'maskCreate') {
        const m = activeMask();
        if (m && m.type === 'radial' && m.rx < 0.012 && m.ry < 0.012) { m.rx = 0.12; m.ry = 0.09; }
        if (m && m.type === 'linear' && Math.hypot(m.x1 - m.x0, m.y1 - m.y0) < 0.01) { m.y1 = m.y0 + 0.15; }
        Cat.commit(st.photo, `New ${m.type} mask`);
        update('commit');
        events.emit('masks');
      } else if (d.kind === 'maskEdit') {
        Cat.commit(st.photo, 'Edit mask');
        update('commit');
      } else if (d.kind === 'paint') {
        st.maskPainting = false;
        Cat.commit(st.photo, d.erase ? 'Brush erase' : 'Brush stroke');
        update('commit');
        events.emit('masks');
      }
      setCursor();
      draw();
    }
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', endDrag);
    root.addEventListener('pointerleave', () => { if (st.hover) { st.hover = null; drawOverlay(); } events.emit('hover', null); });

    root.addEventListener('wheel', (e) => {
      if (!st.photo || !st.after) return;
      e.preventDefault();
      const [x, y] = localXY(e);
      if (st.tool === 'mask' && activeMask() && activeMask().type === 'brush' && !e.ctrlKey && !e.metaKey) {
        st.brush.size = P.clamp(st.brush.size * (e.deltaY < 0 ? 1.1 : 0.9), 4, 800);
        events.emit('brush');
        st.hover = { brush: [x, y] }; drawOverlay();
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const lines = e.deltaMode === 1 ? 30 : 1;
      // Pinch (ctrl+wheel on trackpads) or ⌘/Ctrl+scroll zooms; plain scroll pans when zoomed in.
      if (!(e.ctrlKey || e.metaKey) && st.zoom !== 'fit') {
        const pane = mainPane();
        const c = currentCenter();
        st.center = [c[0] + e.deltaX * lines / pane.scale, c[1] + e.deltaY * lines / pane.scale];
        st.tile = null;
        draw();
        scheduleTile();
        return;
      }
      const cur = mainPane().scale * dpr;
      const factor = Math.pow(1.0018, -e.deltaY * lines * (e.ctrlKey && !e.metaKey ? 4 : 1));
      zoomAt(x, y, P.clamp(cur * factor, 0.02, 16));
    }, { passive: false });

    function currentCenter() {
      if (!st.photo) return [0, 0];
      const pane = mainPane();
      return toFo(pane.x + pane.w / 2, pane.y + pane.h / 2, pane);
    }
    function zoomAt(x, y, zoom) {
      if (!st.photo) { st.zoom = zoom; return; }
      const pane = mainPane();
      const fo = toFo(x, y, pane);
      const dpr = window.devicePixelRatio || 1;
      st.zoom = zoom;
      const sc = zoom / dpr;
      // keep fo point under the cursor
      st.center = [fo[0] - (x - (pane.x + pane.w / 2)) / sc, fo[1] - (y - (pane.y + pane.h / 2)) / sc];
      st.tile = null;
      draw(); setCursor(); scheduleTile();
      events.emit('zoom');
    }
    function setZoom(z) {
      if (!st.photo) { st.zoom = z; st.center = null; return; }
      if (typeof z === 'number') { const pane = mainPane(); zoomAt(pane.x + pane.w / 2, pane.y + pane.h / 2, z); return; }
      st.zoom = z; st.center = null; st.tile = null;
      draw(); setCursor(); events.emit('zoom');
    }

    function cropDrag(d, x, y, shift) {
      const [W, H] = fullDims();
      const g = st.photo.settings.geo;
      const r = d.r;
      const sc = mainPane().scale;
      const dx = (x - d.x) / sc / r.Wo, dy = (y - d.y) / sc / r.Ho; // normalized deltas
      const s = d.start;
      let n;
      if (d.kind === 'cropMove') {
        n = { ...s, x: s.x + dx, y: s.y + dy };
        if (!P.cropInside(W, H, g, n)) {
          const nx = { ...s, x: s.x + dx }, ny = { ...s, y: s.y + dy };
          // binary search the largest valid move in each axis
          const fit = (axis) => {
            let lo = 0, hi = 1;
            for (let i = 0; i < 16; i++) { const m = (lo + hi) / 2; const t = { ...s, [axis]: s[axis] + (axis === 'x' ? dx : dy) * m }; if (P.cropInside(W, H, g, t)) lo = m; else hi = m; }
            return s[axis] + (axis === 'x' ? dx : dy) * lo;
          };
          n = { ...s, x: P.cropInside(W, H, g, nx) ? nx.x : fit('x'), y: P.cropInside(W, H, g, ny) ? ny.y : fit('y') };
          if (!P.cropInside(W, H, g, n)) n = { ...s, x: n.x, y: s.y };
        }
      } else {
        const hd = d.h;
        let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
        if (hd.includes('w')) x0 += dx; if (hd.includes('e')) x1 += dx;
        if (hd.includes('n')) y0 += dy; if (hd.includes('s')) y1 += dy;
        const minW = 32 / r.Wo, minH = 32 / r.Ho;
        if (x1 - x0 < minW) { if (hd.includes('w')) x0 = x1 - minW; else x1 = x0 + minW; }
        if (y1 - y0 < minH) { if (hd.includes('n')) y0 = y1 - minH; else y1 = y0 + minH; }
        const lock = st.crop.lock !== false && st.crop.aspect !== 'free' && !shift || (st.crop.aspect === 'free' && shift);
        if (lock) {
          const ar = (s.w * r.Wo) / (s.h * r.Ho);
          let wpx = (x1 - x0) * r.Wo, hpx = (y1 - y0) * r.Ho;
          const corner = hd.length === 2;
          if (corner) { if (wpx / hpx > ar) hpx = wpx / ar; else wpx = hpx * ar; }
          else if (hd === 'e' || hd === 'w') hpx = wpx / ar; else wpx = hpx * ar;
          const nw = wpx / r.Wo, nh = hpx / r.Ho;
          if (corner) {
            if (hd.includes('w')) x0 = x1 - nw; else x1 = x0 + nw;
            if (hd.includes('n')) y0 = y1 - nh; else y1 = y0 + nh;
          } else if (hd === 'e' || hd === 'w') { const cy = (s.y + s.y + s.h) / 2; y0 = cy - nh / 2; y1 = cy + nh / 2; }
          else { const cx = (s.x + s.x + s.w) / 2; x0 = cx - nw / 2; x1 = cx + nw / 2; }
        }
        n = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        if (!P.cropInside(W, H, g, n)) {
          // shrink the change until it fits
          let lo = 0, hi = 1;
          for (let i = 0; i < 18; i++) {
            const m = (lo + hi) / 2;
            const t = { x: s.x + (n.x - s.x) * m, y: s.y + (n.y - s.y) * m, w: s.w + (n.w - s.w) * m, h: s.h + (n.h - s.h) * m };
            if (P.cropInside(W, H, g, t)) lo = m; else hi = m;
          }
          n = { x: s.x + (n.x - s.x) * lo, y: s.y + (n.y - s.y) * lo, w: s.w + (n.w - s.w) * lo, h: s.h + (n.h - s.h) * lo };
        }
        if (!lock && st.crop.aspect !== 'free') st.crop.aspect = 'free';
      }
      st.crop.rect = n;
      drawOverlay();
      events.emit('cropRect');
    }

    function newMask(type) {
      const names = { linear: 'Linear Gradient', radial: 'Radial Gradient', brush: 'Brush' };
      const n = (st.photo.settings.masks || []).filter(m => m.type === type).length + 1;
      return { id: Cat.uid('mk_'), type, name: `${names[type]} ${n}`, visible: true, invert: false, amount: 100, lumMin: 0, lumMax: 100, lumSmooth: 20, adj: P.defaultLocalAdj() };
    }

    function paintAt(x, y, d) {
      const m = activeMask();
      if (!m) return;
      const pane = mainPane();
      const [u, v] = foToSrc(...toFo(x, y, pane));
      const L = longEdge();
      const r = (st.brush.size / 2) / pane.scale / L;
      if (d.last) {
        const dist = Math.hypot(u - d.last[0], v - d.last[1]);
        const stepLen = Math.max(r * 0.25, 1e-5);
        const n = Math.floor(dist / stepLen);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          m.dabs.push({ x: d.last[0] + (u - d.last[0]) * t, y: d.last[1] + (v - d.last[1]) * t, r, feather: st.brush.feather, flow: st.brush.flow, erase: d.erase || undefined });
        }
        if (n === 0) return;
      } else {
        m.dabs.push({ x: u, y: v, r, feather: st.brush.feather, flow: st.brush.flow, erase: d.erase || undefined });
      }
      d.last = [u, v];
      update('live');
    }

    /* ---------------- keyboard state ---------------- */
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !isTyping(e)) { spaceDown = true; setCursor(); }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; setCursor(); } });
    function isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }

    new ResizeObserver(() => { if (st.photo) { draw(); scheduleTile(); } }).observe(root);

    /* ---------------- public API ---------------- */
    const api = {
      events, st, ASPECTS,
      async setPhoto(photo) {
        if (st.tool === 'crop') { st.tool = 'none'; st.crop = null; }
        st.photo = photo; st.after = null; st.before = null; st.tile = null; st.center = null; st.live = null; st.liveClear = false;
        st.spotSel = -1; st.maskIdx = photo && photo.settings.masks.length ? 0 : -1;
        st.version++;
        draw();
        events.emit('photo', photo);
        if (!photo) return;
        try {
          // A RAW file takes a moment to develop. Show the camera's embedded preview (with the
          // photo's edits) straight away, then swap in the developed image when it is ready.
          const cached = E.cachedSource(photo);
          let developing = null;
          if (E.needsDevelop(photo) && !(cached && cached.quality !== 'preview')) {
            // (the preview request has to be issued first: a request made while the full
            // development is loading would wait for that instead)
            const quick = E.render(photo, P.clone(photo.settings), 'proxy', renderOpts(), 0, 'any');
            developing = E.ensureSource(photo);
            developing.catch(() => { }); // reported below, where it is awaited
            try {
              const res = await quick;
              if (st.photo !== photo) return;
              if (res && !st.after) {
                const [fw, fh] = foDims();
                st.after = { canvas: E.toCanvas(res), w: fw, h: fh, version: st.version, level: 'draft' };
                events.emit('rendered', res, 'draft');
                draw();
              }
            } catch (e) { if (st.photo !== photo) return; /* no usable preview: wait for the developed image */ }
            rendering.classList.add('on');
          }
          try { await (developing || E.ensureSource(photo)); } finally { rendering.classList.remove('on'); }
          if (st.photo !== photo) return;
          // Render a draft immediately, then proxy
          await doRender('draft');
          doRender('proxy');
          events.emit('shown', photo);
          if (needsBefore()) renderBefore();
        } catch (e) {
          console.error(e);
          events.emit('error', e);
          draw();
        }
      },
      update, draw,
      /** Show a GPU-graded frame (or null to go back to the engine render). */
      setLive(layer) { st.live = layer; if (layer) st.liveClear = false; draw(); },
      /** The video's current frame changed: re-render it through the engine, keeping the live frame until then. */
      refreshFrame() {
        if (!st.photo) return;
        st.version++; st.tile = null; st.before = null;
        if (st.live) st.liveClear = true;
        doRender('draft').then(() => doRender('proxy'));
        if (needsBefore()) renderBefore();
      },
      setTool(tool) {
        if (tool === 'spot' && st.photo && st.photo.kind === 'video') { UI.toast('Spot removal is for photos only', 'circle-info'); return; }
        if (st.tool === tool) tool = 'none';
        const prev = st.tool;
        if (prev === 'crop' && st.crop) commitCrop();
        st.crop = null;
        st.tool = tool;
        st.maskCreate = null;
        st.hover = null;
        if (tool === 'crop') { enterCrop(); st.zoom = 'fit'; st.center = null; }
        if (tool === 'mask' && st.maskIdx < 0 && st.photo && st.photo.settings.masks.length) st.maskIdx = 0;
        setCursor();
        if (prev === 'crop' || tool === 'crop') { st.after = null; update('commit'); }
        else if (prev === 'mask' || tool === 'mask') update('commit');
        else draw();
        events.emit('tool', tool);
      },
      cancelCrop() {
        if (st.tool !== 'crop' || !st.crop) return;
        st.photo.settings.geo = st.crop.start;
        st.crop = null; st.tool = 'none';
        st.after = null; update('commit'); setCursor();
        events.emit('tool', 'none'); events.emit('geo');
      },
      resetCrop() {
        const [W, H] = fullDims();
        const g = st.photo.settings.geo;
        g.angle = 0;
        if (st.crop) { st.crop.rect = { x: 0, y: 0, w: 1, h: 1 }; st.crop.aspect = 'original'; }
        else { g.crop = { x: 0, y: 0, w: 1, h: 1 }; g.aspect = 'original'; Cat.commit(st.photo, 'Reset crop'); }
        void W; void H;
        update('commit'); events.emit('geo');
      },
      setCropAspect: applyCropAspect, swapCropOrientation, setStraighten,
      setCropLock(b) { if (st.crop) st.crop.lock = b; },
      autoStraighten() { setStraighten(0, 'commit'); },
      setCompare(mode) { st.compare = mode; if (needsBefore()) renderBefore(); draw(); scheduleTile(); events.emit('compare'); },
      holdBefore(b) { st.holdBefore = b; if (b) renderBefore(); draw(); },
      setClipping(c) { st.clipping = c; update('commit'); },
      setZoom, zoomAt, currentCenter,
      zoomPercent,
      cycleInfo() { st.showInfo = (st.showInfo + 1) % 3; updateInfo(); },
      setBg(bg) { root.classList.remove('bg-grey', 'bg-black', 'bg-white'); if (bg !== 'dark') root.classList.add('bg-' + bg); st.bg = bg; },
      // spots
      deleteSelectedSpot() {
        if (st.tool !== 'spot' || st.spotSel < 0) return false;
        const spots = st.photo.settings.spots, g = spots[st.spotSel] && spots[st.spotSel].g;
        // a stroke is removed whole
        if (g) st.photo.settings.spots = spots.filter(q => q.g !== g); else spots.splice(st.spotSel, 1);
        st.spotSel = -1;
        Cat.commit(st.photo, g ? 'Delete stroke' : 'Delete spot'); update('commit'); events.emit('spotSel');
        return true;
      },
      // masks
      /** Add a ready-made mask (a Subject / Sky / People mask) and select it. */
      addMask(fields) {
        if (!st.photo) return null;
        const m = Object.assign(newMask('brush'), { dabs: [] }, fields);
        const same = st.photo.settings.masks.filter(q => q.ai === m.ai).length;
        if (same) m.name = `${m.name} ${same + 1}`;
        st.photo.settings.masks.push(m); st.maskIdx = st.photo.settings.masks.length - 1;
        st.maskCreate = null;
        if (st.tool !== 'mask') api.setTool('mask');
        Cat.commit(st.photo, `${fields.name || 'New'} mask`);
        update('commit');
        events.emit('masks');
        return m;
      },
      startMask(type) { st.maskCreate = type; if (st.tool !== 'mask') api.setTool('mask'); setCursor(); events.emit('masks'); },
      selectMask(i) { st.maskIdx = i; update('commit'); events.emit('masks'); },
      setMaskOverlay(b) { st.maskOverlay = b; update('commit'); events.emit('masks'); },   // the pane's checkbox follows the O key
      /** The next click on the photo hands its hue (0…360) to cb. */
      pickColor(cb) { st.colorPick = cb; root.classList.add('cur-picker'); PJ.UI.toast('Click the colour in the photo', 'eye-dropper'); },
      activeMask,
      foDims, fullDims, panes, mainPane, toFo, toScreen,
      setCenter(c) { st.center = c; st.tile = null; draw(); scheduleTile(); },
      setCursor
    };
    return api;
  }

  global.PJ.Viewer = { create, ASPECTS };
})(window);
