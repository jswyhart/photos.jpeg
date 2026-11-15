/* =====================================================================
 * photos.jpeg — custom widgets: histogram, tone curve editor, color wheel.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, UI = PJ.UI;

  function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return { w, h, dpr };
  }

  /* ---------------- Histogram ---------------- */
  function drawHistogram(cv, hist) {
    const { w, h } = fitCanvas(cv);
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) { const x = Math.round(w * i / 5) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    if (!hist) return;
    let max = 1;
    for (const c of ['r', 'g', 'b']) for (let i = 3; i < 253; i++) max = Math.max(max, hist[c][i]);
    // smooth a little and use sqrt-ish scaling like LR
    const pts = (arr) => {
      const out = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const a = arr[Math.max(0, i - 1)], b = arr[i], c = arr[Math.min(255, i + 1)];
        out[i] = Math.min(1, Math.pow(((a + 2 * b + c) / 4) / max, 0.75));
      }
      return out;
    };
    ctx.globalCompositeOperation = 'lighter';
    const chans = [['r', 'rgba(220,60,60,0.75)'], ['g', 'rgba(60,190,90,0.7)'], ['b', 'rgba(70,120,240,0.75)']];
    for (const [c, col] of chans) {
      const p = pts(hist[c]);
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < 256; i++) ctx.lineTo(i / 255 * w, h - p[i] * (h - 4));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---------------- Tone curve editor ---------------- */
  /**
   * opts: { getPoints(channel), setPoints(channel, pts, phase), getParam() -> curve settings, getHist() }
   */
  function curveEditor(opts) {
    const cv = UI.h('canvas');
    const el = UI.h('div', { class: 'curve-wrap' }, cv);
    let channel = 'rgb';
    let mode = 'point'; // 'param' | 'point'
    let drag = null;
    let hover = -1;
    const COL = { rgb: '#e8e8e8', r: '#ff6b6b', g: '#5ed38a', b: '#6c9cff' };

    function pts() { return (opts.getPoints(channel) || [[0, 0], [1, 1]]).map(p => p.slice()); }
    function toXY(p, w, h) { return [p[0] * (w - 16) + 8, (1 - p[1]) * (h - 16) + 8]; }
    function fromXY(x, y, w, h) { return [P.clamp((x - 8) / (w - 16), 0, 1), P.clamp(1 - (y - 8) / (h - 16), 0, 1)]; }

    function draw() {
      const { w, h, dpr } = fitCanvas(cv);
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      // histogram backdrop
      const hist = opts.getHist && opts.getHist();
      if (hist) {
        let max = 1; for (let i = 3; i < 253; i++) max = Math.max(max, hist.l[i]);
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.beginPath(); ctx.moveTo(8, h - 8);
        for (let i = 0; i < 256; i++) ctx.lineTo(8 + i / 255 * (w - 16), h - 8 - Math.min(1, Math.pow(hist.l[i] / max, 0.7)) * (h - 16));
        ctx.lineTo(w - 8, h - 8); ctx.closePath(); ctx.fill();
      }
      // grid
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const x = Math.round(8 + (w - 16) * i / 4) + 0.5, y = Math.round(8 + (h - 16) * i / 4) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, h - 8); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(w - 8, y); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.moveTo(8, h - 8); ctx.lineTo(w - 8, 8); ctx.stroke();

      if (mode === 'param') {
        const c = opts.getParam();
        const lut = P.parametricLUT(c, 256);
        // split markers
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.setLineDash([3 * dpr, 3 * dpr]);
        [c.split1, c.split2, c.split3].forEach(s => { const x = 8 + s / 100 * (w - 16); ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, h - 8); ctx.stroke(); });
        ctx.setLineDash([]);
        ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = 1.6 * dpr;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) { const x = 8 + i / 255 * (w - 16), y = h - 8 - lut[i] * (h - 16); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
      } else {
        // other channels faintly
        for (const ch of ['rgb', 'r', 'g', 'b']) {
          if (ch === channel) continue;
          const p = opts.getPoints(ch);
          if (!p || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1)) continue;
          const lut = P.splineLUT(p, 128);
          ctx.strokeStyle = COL[ch] + '55'; ctx.lineWidth = 1 * dpr;
          ctx.beginPath();
          for (let i = 0; i < 128; i++) { const x = 8 + i / 127 * (w - 16), y = h - 8 - lut[i] * (h - 16); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
          ctx.stroke();
        }
        const p = pts();
        const lut = P.splineLUT(p, 256);
        ctx.strokeStyle = COL[channel]; ctx.lineWidth = 1.6 * dpr;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) { const x = 8 + i / 255 * (w - 16), y = h - 8 - lut[i] * (h - 16); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
        p.forEach((q, i) => {
          const [x, y] = toXY(q, w, h);
          ctx.beginPath(); ctx.arc(x, y, (i === hover || (drag && drag.i === i) ? 5 : 4) * dpr, 0, Math.PI * 2);
          ctx.fillStyle = i === hover || (drag && drag.i === i) ? COL[channel] : '#1b1c1f';
          ctx.fill(); ctx.strokeStyle = COL[channel]; ctx.lineWidth = 1.4 * dpr; ctx.stroke();
        });
        if (drag) {
          const q = p[drag.i];
          if (q) {
            ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(8, 8, 92 * dpr, 18 * dpr);
            ctx.fillStyle = '#ddd'; ctx.font = `${10 * dpr}px ui-monospace, monospace`;
            ctx.fillText(`${Math.round(q[0] * 255)} → ${Math.round(q[1] * 255)}`, 14, 8 + 12.5 * dpr);
          }
        }
      }
      ctx.restore();
    }

    function hit(x, y) {
      const { w, h } = { w: cv.width, h: cv.height };
      const p = pts();
      for (let i = 0; i < p.length; i++) {
        const [px, py] = toXY(p[i], w, h);
        if (Math.hypot(px - x, py - y) < 9 * (window.devicePixelRatio || 1)) return i;
      }
      return -1;
    }
    function evXY(e) { const r = cv.getBoundingClientRect(), dpr = cv.width / r.width; return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; }

    cv.addEventListener('pointerdown', (e) => {
      if (mode !== 'point' || e.button !== 0) return;
      const [x, y] = evXY(e);
      let i = hit(x, y);
      let p = pts();
      if (i < 0) {
        const q = fromXY(x, y, cv.width, cv.height);
        // snap new point onto the current curve's y for a gentle start
        const lut = P.splineLUT(p, 1024);
        const cy = lut[Math.round(q[0] * 1023)];
        const np = Math.abs(cy - q[1]) < 0.08 ? [q[0], cy] : q;
        p.push(np);
        p.sort((a, b) => a[0] - b[0]);
        i = p.indexOf(np);
        opts.setPoints(channel, p, 'live');
      }
      drag = { i, moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch (_) { }
      draw();
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = evXY(e);
      if (!drag) { const hv = mode === 'point' ? hit(x, y) : -1; if (hv !== hover) { hover = hv; draw(); } return; }
      const p = pts();
      const i = drag.i;
      let [nx, ny] = fromXY(x, y, cv.width, cv.height);
      const outside = y < -20 || y > cv.height + 20 || x < -20 || x > cv.width + 20;
      const isEnd = i === 0 || i === p.length - 1;
      if (outside && !isEnd && p.length > 2) {
        p.splice(i, 1); drag = null; opts.setPoints(channel, p, 'commit'); draw(); return;
      }
      const lo = i > 0 ? p[i - 1][0] + 0.01 : 0, hi = i < p.length - 1 ? p[i + 1][0] - 0.01 : 1;
      if (i === 0) nx = Math.min(nx, hi); else if (i === p.length - 1) nx = Math.max(nx, lo); else nx = P.clamp(nx, lo, hi);
      p[i] = [nx, ny];
      drag.moved = true;
      opts.setPoints(channel, p, 'live');
      draw();
    });
    const up = () => { if (drag) { drag = null; opts.setPoints(channel, pts(), 'commit'); draw(); } };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('dblclick', (e) => {
      if (mode !== 'point') return;
      const [x, y] = evXY(e);
      const i = hit(x, y);
      const p = pts();
      if (i > 0 && i < p.length - 1) { p.splice(i, 1); opts.setPoints(channel, p, 'commit'); draw(); }
    });
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      UI.menu(e.clientX, e.clientY, [
        { label: 'Linear (reset channel)', icon: 'slash', action: () => { opts.setPoints(channel, [[0, 0], [1, 1]], 'commit'); draw(); } },
        { label: 'Medium contrast', icon: 'wave-square', action: () => { opts.setPoints(channel, [[0, 0], [0.25, 0.21], [0.75, 0.79], [1, 1]], 'commit'); draw(); } },
        { label: 'Strong contrast', icon: 'wave-square', action: () => { opts.setPoints(channel, [[0, 0], [0.25, 0.17], [0.75, 0.84], [1, 1]], 'commit'); draw(); } },
        { label: 'Matte (lift blacks)', icon: 'cloud', action: () => { opts.setPoints(channel, [[0, 0.1], [0.3, 0.3], [1, 1]], 'commit'); draw(); } }
      ]);
    });
    const ro = new ResizeObserver(() => draw());
    ro.observe(cv);
    return {
      el, draw,
      setChannel: (c) => { channel = c; draw(); },
      setMode: (m) => { mode = m; draw(); },
      get channel() { return channel; }
    };
  }

  /* ---------------- Color wheel ---------------- */
  const wheelCache = new Map();
  function wheelImage(size) {
    if (wheelCache.has(size)) return wheelCache.get(size);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const r0 = size / 2 - 1, rgb = [0, 0, 0];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = x - size / 2 + 0.5, dy = y - size / 2 + 0.5;
      const d = Math.hypot(dx, dy);
      const i = (y * size + x) * 4;
      if (d > r0 + 0.5) { img.data[i + 3] = 0; continue; }
      const hue = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;
      const sat = Math.min(1, d / r0);
      P.hslToRgb(hue, sat * 0.85, 0.5 - 0.06 * (1 - sat), rgb);
      img.data[i] = rgb[0] * 255; img.data[i + 1] = rgb[1] * 255; img.data[i + 2] = rgb[2] * 255;
      img.data[i + 3] = d > r0 - 0.5 ? Math.round((r0 + 0.5 - d) * 255) : 255;
    }
    ctx.putImageData(img, 0, 0);
    wheelCache.set(size, c);
    return c;
  }

  /** opts: {label, get() -> {h,s}, set({h,s}, phase)} */
  function colorWheel(opts) {
    const cv = UI.h('canvas');
    const val = UI.h('div', { class: 'wv' });
    const el = UI.h('div', { class: 'wheel' }, UI.h('div', { class: 'wl' }, opts.label), cv, val);
    let drag = null;
    function draw() {
      const { w, dpr } = fitCanvas(cv);
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, w);
      ctx.globalAlpha = 0.92;
      ctx.drawImage(wheelImage(Math.max(32, Math.min(512, w))), 0, 0, w, w);
      ctx.globalAlpha = 1;
      const v = opts.get();
      const r = w / 2 - 1;
      const ang = v.h * Math.PI / 180, rr = (v.s / 100) * r;
      const x = w / 2 + Math.cos(ang) * rr, y = w / 2 - Math.sin(ang) * rr;
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(w / 2 - 4 * dpr, w / 2); ctx.lineTo(w / 2 + 4 * dpr, w / 2); ctx.moveTo(w / 2, w / 2 - 4 * dpr); ctx.lineTo(w / 2, w / 2 + 4 * dpr); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = v.s > 0 ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.3)';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6 * dpr; ctx.stroke();
      val.textContent = v.s > 0 ? `H ${Math.round(v.h)}°  S ${Math.round(v.s)}` : 'H —  S 0';
    }
    function setFrom(e, phase) {
      const r = cv.getBoundingClientRect();
      const fine = e.shiftKey && drag ? 0.25 : 1;
      let dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
      if (drag && fine !== 1) { dx = drag.dx + (dx - drag.dx) * fine; dy = drag.dy + (dy - drag.dy) * fine; }
      const R = r.width / 2;
      const s = Math.min(100, Math.hypot(dx, dy) / R * 100);
      const hh = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;
      opts.set({ h: Math.round(hh), s: Math.round(s) }, phase);
      draw();
    }
    cv.addEventListener('pointerdown', (e) => {
      const r = cv.getBoundingClientRect();
      drag = { dx: e.clientX - r.left - r.width / 2, dy: e.clientY - r.top - r.height / 2 };
      try { cv.setPointerCapture(e.pointerId); } catch (_) { } setFrom(e, 'live');
    });
    cv.addEventListener('pointermove', (e) => { if (drag) setFrom(e, 'live'); });
    const up = () => { if (drag) { drag = null; opts.set(opts.get(), 'commit'); } };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('dblclick', () => { opts.set({ h: 0, s: 0 }, 'commit'); draw(); });
    new ResizeObserver(() => draw()).observe(cv);
    return { el, draw };
  }

  global.PJ.Widgets = { drawHistogram, curveEditor, colorWheel, fitCanvas };
})(window);
