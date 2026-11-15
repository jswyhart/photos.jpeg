/* =====================================================================
 * photos.jpeg — virtualized grid & strip. Only the cells in (or near) view exist in the DOM,
 * so catalogs with tens of thousands of photos scroll and refresh as fast as small ones.
 * ===================================================================== */
(function (global) {
  'use strict';

  /**
   * Vertical grid of equal cells. opts:
   *   pad, gap          spacing in px
   *   cell()            minimum cell width = row height (px)
   *   key(item)         stable id
   *   make(item, i)     build the element for an item
   */
  function grid(scroller, opts) {
    const sizer = document.createElement('div');
    sizer.className = 'v-sizer';
    scroller.classList.add('virtual');
    scroller.replaceChildren(sizer);
    let list = [], cols = 1, cw = 0, rh = 0, raf = 0;
    const live = new Map(); // key -> { el, i }
    const pad = opts.pad ?? 12, gap = opts.gap ?? 10;

    function measure() {
      const W = scroller.clientWidth;
      const cell = opts.cell();
      cols = Math.max(1, Math.floor((W - pad * 2 + gap) / (cell + gap)));
      cw = Math.max(40, (W - pad * 2 - gap * (cols - 1)) / cols);
      rh = cell;
      const rows = Math.ceil(list.length / cols);
      sizer.style.height = (rows ? pad * 2 + rows * rh + (rows - 1) * gap : 0) + 'px';
    }
    function place(el, i) {
      const r = Math.floor(i / cols), c = i % cols;
      el.style.transform = `translate(${Math.round(pad + c * (cw + gap))}px, ${Math.round(pad + r * (rh + gap))}px)`;
      el.style.width = Math.round(cw) + 'px'; el.style.height = rh + 'px';
    }
    function paint() {
      raf = 0;
      if (!list.length) { for (const v of live.values()) v.el.remove(); live.clear(); return; }
      const top = scroller.scrollTop, H = scroller.clientHeight || 800;
      const over = H * 0.75;
      const r0 = Math.max(0, Math.floor((top - over - pad) / (rh + gap)));
      const r1 = Math.floor((top + H + over - pad) / (rh + gap));
      const i0 = r0 * cols, i1 = Math.min(list.length - 1, (r1 + 1) * cols - 1);
      const keep = new Set();
      for (let i = i0; i <= i1; i++) {
        const it = list[i], k = opts.key(it);
        keep.add(k);
        let v = live.get(k);
        if (!v || v.i !== i && opts.indexed) { if (v) v.el.remove(); v = { el: opts.make(it, i), i }; live.set(k, v); sizer.appendChild(v.el); }
        v.i = i;
        place(v.el, i);
      }
      for (const [k, v] of live) if (!keep.has(k)) { v.el.remove(); live.delete(k); }
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
    scroller.addEventListener('scroll', schedule, { passive: true });
    new ResizeObserver(() => { measure(); paint(); }).observe(scroller);

    return {
      /** Replace the items (keeps the scroll position). rebuild: drop existing elements. */
      set(items, rebuild) {
        list = items;
        if (rebuild) { for (const v of live.values()) v.el.remove(); live.clear(); }
        measure(); paint();
      },
      relayout() { measure(); paint(); },
      get(key) { const v = live.get(key); return v ? v.el : null; },
      /** Re-create one item's element if it's on screen. */
      refresh(item) {
        const k = opts.key(item), v = live.get(k);
        if (!v) return;
        const el = opts.make(item, v.i);
        v.el.replaceWith(el); v.el = el; place(el, v.i);
      },
      forEachLive(fn) { for (const [k, v] of live) fn(k, v.el); },
      columns: () => cols,
      indexOf: (key) => list.findIndex(it => opts.key(it) === key),
      scrollToIndex(i, block) {
        if (i < 0) return;
        const r = Math.floor(i / cols), y = pad + r * (rh + gap), H = scroller.clientHeight;
        if (block === 'center') scroller.scrollTop = y - (H - rh) / 2;
        else if (y < scroller.scrollTop) scroller.scrollTop = y - pad;
        else if (y + rh > scroller.scrollTop + H) scroller.scrollTop = y + rh + pad - H;
        paint();
      },
      get items() { return list; }
    };
  }

  /** Horizontal strip of fixed-width items (the filmstrip). */
  function strip(scroller, opts) {
    const sizer = document.createElement('div');
    sizer.className = 'v-sizer';
    scroller.classList.add('virtual');
    scroller.replaceChildren(sizer);
    let list = [], iw = 0, raf = 0;
    const live = new Map();
    const pad = opts.pad ?? 10, gap = opts.gap ?? 6;
    function itemWidth() {
      if (iw) return iw;
      if (!list.length) return 96;
      const probe = opts.make(list[0], 0);
      probe.style.visibility = 'hidden';
      sizer.appendChild(probe);
      iw = probe.offsetWidth || 96;
      probe.remove();
      return iw;
    }
    function measure() { const w = itemWidth(); sizer.style.width = (list.length ? pad * 2 + list.length * (w + gap) - gap : 0) + 'px'; }
    function place(el, i) { el.style.transform = `translate(${pad + i * (iw + gap)}px, -50%)`; }
    function paint() {
      raf = 0;
      const left = scroller.scrollLeft, W = scroller.clientWidth || 1200, over = W;
      const i0 = Math.max(0, Math.floor((left - over - pad) / (iw + gap)));
      const i1 = Math.min(list.length - 1, Math.ceil((left + W + over - pad) / (iw + gap)));
      const keep = new Set();
      for (let i = i0; i <= i1; i++) {
        const it = list[i], k = opts.key(it);
        keep.add(k);
        let v = live.get(k);
        if (!v) { v = { el: opts.make(it, i), i }; live.set(k, v); sizer.appendChild(v.el); }
        v.i = i; place(v.el, i);
      }
      for (const [k, v] of live) if (!keep.has(k)) { v.el.remove(); live.delete(k); }
    }
    scroller.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(paint); }, { passive: true });
    new ResizeObserver(() => { iw = 0; measure(); paint(); }).observe(scroller);
    return {
      set(items, rebuild) { list = items; if (rebuild) { for (const v of live.values()) v.el.remove(); live.clear(); } measure(); paint(); },
      get(key) { const v = live.get(key); return v ? v.el : null; },
      refresh(item) { const k = opts.key(item), v = live.get(k); if (!v) return; const el = opts.make(item, v.i); v.el.replaceWith(el); v.el = el; place(el, v.i); },
      forEachLive(fn) { for (const [k, v] of live) fn(k, v.el); },
      scrollToIndex(i) {
        if (i < 0) return;
        const x = pad + i * (iw + gap), W = scroller.clientWidth;
        if (x < scroller.scrollLeft) scroller.scrollLeft = x - pad;
        else if (x + iw > scroller.scrollLeft + W) scroller.scrollLeft = x + iw + pad - W;
        paint();
      },
      indexOf: (key) => list.findIndex(it => opts.key(it) === key)
    };
  }

  global.PJ = global.PJ || {};
  global.PJ.Virtual = { grid, strip };
})(window);
