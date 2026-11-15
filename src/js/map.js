/* =====================================================================
 * photos.jpeg — Map view: geotagged photos on an OpenStreetMap slippy map.
 * Photos are clustered on screen; clicking a cluster shows its photos and can select them or
 * narrow the Library to them. Tiles can be turned off in Preferences (markers still work).
 * ===================================================================== */
(function (global) {
  'use strict';
  const UI = PJ.UI, Cat = PJ.Catalog, API = PJ.API;
  const { h, icon } = UI;
  const TILE = 256, MAX_Z = 19, MIN_Z = 1;
  const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

  // Web Mercator: lon/lat ↔ world pixels at zoom 0 (0…256)
  const lon2x = (lon) => (lon + 180) / 360 * TILE;
  const lat2y = (lat) => { const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE; };
  const x2lon = (x) => x / TILE * 360 - 180;
  const y2lat = (y) => { const n = Math.PI - 2 * Math.PI * y / TILE; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

  function gpsOf(p) {
    const g = p.exif && p.exif.gps;
    return g && Number.isFinite(g.lat) && Number.isFinite(g.lon) && (g.lat || g.lon) ? g : null;
  }

  function create(app, library) {
    const tiles = h('div', { class: 'map-tiles' });
    const canvas = h('canvas', { class: 'map-markers' });
    const popup = h('div', { class: 'map-popup hidden' });
    const info = h('div', { class: 'map-info' });
    const zin = h('button', { class: 'btn icon sm', title: 'Zoom in' }, icon('plus'));
    const zout = h('button', { class: 'btn icon sm', title: 'Zoom out' }, icon('minus'));
    const fitb = h('button', { class: 'btn icon sm', title: 'Show all photos' }, icon('expand'));
    const attrib = h('div', { class: 'map-attrib' }, '© OpenStreetMap contributors');
    const el = h('div', { class: 'map-view hidden', tabindex: '0' }, tiles, canvas, h('div', { class: 'map-tools' }, zin, zout, fitb), info, attrib, popup);

    let z = 2, cx = TILE / 2, cy = TILE / 2; // centre in zoom-0 world pixels
    let points = [], clusters = [], noGps = 0, shown = false, fitted = false;
    const tileEls = new Map();
    const thumbs = new Map(); // id -> Image
    const size = () => [el.clientWidth || 1, el.clientHeight || 1];
    const scale = () => Math.pow(2, z);
    const toScreen = (wx, wy) => { const [w, hgt] = size(), k = scale(); return [(wx - cx) * k + w / 2, (wy - cy) * k + hgt / 2]; };
    const toWorld = (sx, sy) => { const [w, hgt] = size(), k = scale(); return [(sx - w / 2) / k + cx, (sy - hgt / 2) / k + cy]; };

    function setData() {
      const list = app.visible();
      points = []; noGps = 0;
      for (const p of list) {
        const g = gpsOf(p);
        if (g) points.push({ p, wx: lon2x(g.lon), wy: lat2y(g.lat) }); else noGps++;
      }
      if (!fitted && points.length) { fit(); fitted = true; }
      info.replaceChildren(icon('location-dot'), ` ${points.length} on the map`, noGps ? h('span', { class: 'muted' }, ` · ${noGps} without location`) : null);
      draw();
    }
    function fit() {
      if (!points.length) { z = 2; cx = cy = TILE / 2; return draw(); }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of points) { x0 = Math.min(x0, q.wx); x1 = Math.max(x1, q.wx); y0 = Math.min(y0, q.wy); y1 = Math.max(y1, q.wy); }
      const [w, hgt] = size();
      cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
      const span = Math.max((x1 - x0) / Math.max(1, w - 120), (y1 - y0) / Math.max(1, hgt - 120), 1e-9);
      z = Math.max(MIN_Z, Math.min(15, Math.log2(1 / span)));
      draw();
    }

    /* ---- tiles ---- */
    function drawTiles() {
      const useTiles = Cat.pref('map.tiles', true);
      tiles.classList.toggle('off', !useTiles);
      if (!useTiles) { tileEls.forEach(t => t.remove()); tileEls.clear(); return; }
      const [w, hgt] = size();
      const tz = Math.max(0, Math.min(MAX_Z, Math.round(z)));
      const n = 1 << tz, k = scale() / n; // screen px per tile px
      const ts = TILE * k;
      const [wx0, wy0] = toWorld(0, 0), [wx1, wy1] = toWorld(w, hgt);
      const tx0 = Math.floor(wx0 / TILE * n), tx1 = Math.floor(wx1 / TILE * n), ty0 = Math.max(0, Math.floor(wy0 / TILE * n)), ty1 = Math.min(n - 1, Math.floor(wy1 / TILE * n));
      const want = new Set();
      if (tx1 - tx0 > 40 || ty1 - ty0 > 40) return;
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        const wxT = ((tx % n) + n) % n; // wrap around the antimeridian
        const key = `${tz}/${tx}/${ty}`;
        want.add(key);
        let img = tileEls.get(key);
        if (!img) {
          img = new Image();
          img.crossOrigin = 'anonymous'; img.decoding = 'async'; img.draggable = false;
          img.className = 'tile';
          img.onload = () => img.classList.add('on');
          img.onerror = () => img.classList.add('err');
          img.src = TILE_URL(tz, wxT, ty);
          tileEls.set(key, img);
          tiles.appendChild(img);
        }
        const [sx, sy] = toScreen(tx * TILE / n, ty * TILE / n);
        img.style.transform = `translate(${sx}px, ${sy}px)`;
        img.style.width = img.style.height = (ts + 0.5) + 'px';
      }
      // Drop tiles that left the view; keep other zoom levels only until the new ones load
      for (const [key, img] of tileEls) {
        if (want.has(key)) continue;
        const [kz] = key.split('/');
        if (+kz !== tz && tileEls.size < 300) {
          // reposition the old level so it underlays while new tiles stream in
          const [, kx, ky] = key.split('/').map(Number), m = 1 << +kz;
          const [sx, sy] = toScreen(kx * TILE / m, ky * TILE / m);
          img.style.transform = `translate(${sx}px, ${sy}px)`; img.style.width = img.style.height = (TILE * scale() / m + 0.5) + 'px';
          img.style.zIndex = '0';
          continue;
        }
        img.remove(); tileEls.delete(key);
      }
      for (const key of want) tileEls.get(key).style.zIndex = '1';
      clearTimeout(drawTiles.gc);
      drawTiles.gc = setTimeout(() => { const cur = String(Math.round(z)); for (const [key, img] of tileEls) if (key.split('/')[0] !== cur) { img.remove(); tileEls.delete(key); } }, 1500);
    }

    /* ---- markers ---- */
    function thumbFor(p) {
      let im = thumbs.get(p.id);
      if (!im && (p.thumbV || !API.hasThumbStore)) {
        im = new Image(); im.decoding = 'async';
        im.onload = () => drawMarkers();
        im.src = API.thumbUrl(p.id, p.thumbV);
        thumbs.set(p.id, im);
      }
      return im && im.complete && im.naturalWidth ? im : null;
    }
    function drawMarkers() {
      const [w, hgt] = size(), dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hgt);
      // Cluster in screen space on a 76 px grid
      const cell = 76, buckets = new Map();
      const k = scale();
      for (const q of points) {
        let sx = (q.wx - cx) * k + w / 2;
        const worldW = TILE * k; // wrap markers to the copy of the world nearest the view
        sx -= Math.round((sx - w / 2) / worldW) * worldW;
        const sy = (q.wy - cy) * k + hgt / 2;
        if (sx < -cell || sy < -cell || sx > w + cell || sy > hgt + cell) continue;
        const key = Math.floor(sx / cell) + ',' + Math.floor(sy / cell);
        let b = buckets.get(key);
        if (!b) buckets.set(key, b = { sx: 0, sy: 0, items: [] });
        b.sx += sx; b.sy += sy; b.items.push(q.p);
      }
      clusters = [...buckets.values()].map(b => ({ x: b.sx / b.items.length, y: b.sy / b.items.length, items: b.items }));
      const selIds = new Set(app.selectedIds());
      for (const c of clusters) {
        const n = c.items.length, S = n > 1 ? 46 : 40;
        const lead = c.items.find(p => selIds.has(p.id)) || c.items[0];
        const im = thumbFor(lead);
        const x = Math.round(c.x - S / 2), y = Math.round(c.y - S - 8);
        const sel = c.items.some(p => selIds.has(p.id));
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
        ctx.fillStyle = sel ? '#4f8ff7' : '#f2f2f2';
        ctx.beginPath(); ctx.roundRect(x - 3, y - 3, S + 6, S + 6, 6); ctx.fill();
        ctx.beginPath(); ctx.moveTo(c.x - 6, y + S + 3); ctx.lineTo(c.x + 6, y + S + 3); ctx.lineTo(c.x, y + S + 10); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.beginPath(); ctx.roundRect(x, y, S, S, 4); ctx.clip();
        if (im) {
          const r = Math.max(S / im.naturalWidth, S / im.naturalHeight);
          ctx.drawImage(im, x + (S - im.naturalWidth * r) / 2, y + (S - im.naturalHeight * r) / 2, im.naturalWidth * r, im.naturalHeight * r);
        } else { ctx.fillStyle = '#2a2d33'; ctx.fillRect(x, y, S, S); }
        ctx.restore();
        if (n > 1) {
          const t = n > 999 ? Math.round(n / 1000) + 'k' : String(n);
          ctx.font = '600 11px system-ui, sans-serif';
          const tw = Math.max(18, ctx.measureText(t).width + 10);
          ctx.fillStyle = '#e5534b'; ctx.beginPath(); ctx.roundRect(x + S - tw + 8, y - 10, tw, 18, 9); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x + S - tw / 2 + 8, y - 1);
        }
        c.box = [x - 3, y - 12, S + 14, S + 22];
      }
    }
    function draw() { if (!shown) return; drawTiles(); drawMarkers(); }

    /* ---- popup ---- */
    function hidePopup() { popup.classList.add('hidden'); }
    function showPopup(c) {
      const items = c.items, n = items.length;
      const strip = h('div', { class: 'mp-strip' }, items.slice(0, 24).map(p => {
        const src = p.thumbV || !API.hasThumbStore ? API.thumbUrl(p.id, p.thumbV) : '';
        const t = h('div', { class: 'mp-t', title: Cat.displayName(p) }, src ? h('img', { src, draggable: 'false' }) : icon('image'));
        t.addEventListener('click', (e) => app.clickSelect(p.id, e));
        t.addEventListener('dblclick', () => app.openDevelop(p.id));
        return t;
      }), n > 24 ? h('div', { class: 'mp-more' }, `+${n - 24}`) : null);
      const g = gpsOf(items[0]);
      popup.replaceChildren(
        h('div', { class: 'mp-h' }, h('b', null, n === 1 ? Cat.displayName(items[0]) : `${n} photos`),
          g ? h('span', { class: 'muted mono' }, `${g.lat.toFixed(4)}, ${g.lon.toFixed(4)}`) : null,
          h('button', { class: 'btn ghost icon sm', onclick: hidePopup }, icon('xmark'))),
        strip,
        h('div', { class: 'btnrow' },
          h('button', { class: 'btn sm', onclick: () => { app.selectIds(items.map(p => p.id)); drawMarkers(); } }, icon('check-double'), n === 1 ? 'Select' : `Select ${n}`),
          h('button', { class: 'btn sm', onclick: () => { hidePopup(); library.setGeoFilter(items.map(p => p.id)); } }, icon('table-cells'), 'Show in grid'),
          n === 1 ? h('button', { class: 'btn sm primary', onclick: () => app.openDevelop(items[0].id) }, icon('sliders'), 'Develop') : null));
      popup.classList.remove('hidden');
      const [w, hgt] = size();
      const pw = Math.min(380, w - 20);
      popup.style.width = pw + 'px';
      popup.style.left = Math.max(10, Math.min(w - pw - 10, c.x - pw / 2)) + 'px';
      const above = c.y - 70 > hgt / 2;
      popup.style.top = above ? 'auto' : Math.min(hgt - 40, c.y + 14) + 'px';
      popup.style.bottom = above ? Math.max(10, hgt - c.y + 60) + 'px' : 'auto';
    }
    function hit(sx, sy) {
      for (let i = clusters.length - 1; i >= 0; i--) {
        const b = clusters[i].box;
        if (b && sx >= b[0] && sy >= b[1] && sx <= b[0] + b[2] && sy <= b[1] + b[3]) return clusters[i];
      }
      return null;
    }

    /* ---- interaction ---- */
    function zoomAt(nz, sx, sy) {
      nz = Math.max(MIN_Z, Math.min(MAX_Z, nz));
      const [wx, wy] = toWorld(sx, sy);
      z = nz;
      const [w, hgt] = size(), k = scale();
      cx = wx - (sx - w / 2) / k; cy = wy - (sy - hgt / 2) / k;
      clampView();
      hidePopup(); draw();
    }
    function clampView() { cy = Math.max(0, Math.min(TILE, cy)); cx = ((cx % TILE) + TILE) % TILE; }
    const pointers = new Map();
    let drag = null, moved = false, pinch = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.map-popup, .map-tools')) return;
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (pointers.size === 1) { drag = { x: e.clientX, y: e.clientY, cx, cy }; moved = false; }
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
        drag = null;
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) {
        const c = hit(e.offsetX, e.offsetY);
        el.style.cursor = c ? 'pointer' : 'grab';
        return;
      }
      pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        zoomAt(pinch.z + Math.log2(d / Math.max(1, pinch.d)), pinch.mx, pinch.my);
        moved = true;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      const k = scale();
      cx = drag.cx - dx / k; cy = drag.cy - dy / k;
      clampView(); hidePopup(); el.style.cursor = 'grabbing';
      draw();
    });
    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        el.style.cursor = 'grab';
        if (!moved && drag) {
          const c = hit(e.offsetX, e.offsetY);
          if (c) {
            if (c.items.length === 1) app.clickSelect(c.items[0].id, e);
            showPopup(c);
            drawMarkers();
          } else hidePopup();
        }
        drag = null;
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.map-popup, .map-tools')) return;
      const c = hit(e.offsetX, e.offsetY);
      if (c && c.items.length === 1) return app.openDevelop(c.items[0].id);
      zoomAt(Math.round(z) + 1, e.offsetX, e.offsetY);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dz = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * (e.ctrlKey ? 2 : 1);
      zoomAt(z + Math.max(-1, Math.min(1, dz)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const step = 80 / scale();
      if (e.key === '+' || e.key === '=') { zoomAt(Math.round(z) + 1, ...size().map(v => v / 2)); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === '-') { zoomAt(Math.round(z) - 1, ...size().map(v => v / 2)); e.preventDefault(); e.stopPropagation(); }
      else if (e.key.startsWith('Arrow')) {
        if (e.key === 'ArrowLeft') cx -= step; if (e.key === 'ArrowRight') cx += step; if (e.key === 'ArrowUp') cy -= step; if (e.key === 'ArrowDown') cy += step;
        clampView(); draw(); e.preventDefault(); e.stopPropagation();
      } else if (e.key === 'Escape') hidePopup();
    });
    zin.addEventListener('click', () => zoomAt(Math.round(z) + 1, ...size().map(v => v / 2)));
    zout.addEventListener('click', () => zoomAt(Math.round(z) - 1, ...size().map(v => v / 2)));
    fitb.addEventListener('click', () => { hidePopup(); fit(); });
    new ResizeObserver(() => draw()).observe(el);
    PJ.Engine.thumbEvents.on('thumb', (p) => { thumbs.delete(p.id); if (shown && gpsOf(p)) { if (!points.some(q => q.p === p)) setData(); else drawMarkers(); } });

    return {
      el,
      show() { shown = true; el.classList.remove('hidden'); setData(); },
      hide() { shown = false; el.classList.add('hidden'); hidePopup(); },
      refresh() { if (shown) setData(); },
      redrawMarkers() { if (shown) drawMarkers(); },
      fit, get shown() { return shown; }
    };
  }

  global.PJ.MapView = { create, gpsOf };
})(window);
