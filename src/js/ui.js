/* =====================================================================
 * photos.jpeg — UI primitives: DOM helper, sliders, panels, modals,
 * toast, context menus.
 * ===================================================================== */
(function (global) {
  'use strict';

  // DOM convenience: let append()/replaceChildren() skip null/false like h() does.
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    for (const name of ['append', 'prepend', 'replaceChildren']) {
      const orig = proto[name];
      proto[name] = function (...a) { return orig.apply(this, a.filter(x => x !== null && x !== undefined && x !== false)); };
    }
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') el.innerHTML = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const icon = (name, cls) => h('i', { class: `fa-solid fa-${name}${cls ? ' ' + cls : ''}` });
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function debounce(fn, ms) {
    let t = null;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
    d.flush = (...a) => { if (t) { clearTimeout(t); t = null; fn(...a); } };
    d.cancel = () => { clearTimeout(t); t = null; };
    return d;
  }
  function emitter() {
    const m = new Map();
    return {
      on(ev, fn) { if (!m.has(ev)) m.set(ev, new Set()); m.get(ev).add(fn); return () => m.get(ev).delete(fn); },
      emit(ev, ...a) { (m.get(ev) || []).forEach(fn => { try { fn(...a); } catch (e) { console.error(e); } }); }
    };
  }

  /* ---------------- Toast ---------------- */
  let toastT = null;
  function toast(msg, iconName) {
    const t = $('#toast');
    if (!t) return;
    $('#toast-msg').textContent = msg;
    t.querySelector('i').className = `fa-solid fa-${iconName || 'circle-check'}`;
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), 2400);
  }

  /* ---------------- Slider ---------------- */
  function fmtSigned(v, dec) {
    const s = Number(v).toFixed(dec);
    return Number(v) > 0 ? '+' + s : s;
  }
  /**
   * opts: {label, min, max, step, value, def, decimals, signed, suffix, rail, onInput(v, phase), title}
   * phase: 'live' while dragging, 'commit' when the gesture ends.
   */
  function slider(opts) {
    const min = opts.min, max = opts.max, step = opts.step || 1;
    const dec = opts.decimals ?? (step < 1 ? (step < 0.1 ? 2 : 1) : 0);
    const def = opts.def ?? 0;
    let value = opts.value ?? def;
    const center = min < 0 && max > 0 ? 0 : null;
    const rail = h('div', { class: `rail${opts.rail ? ' ' + opts.rail : ''}` });
    const fill = h('div', { class: 'fill' });
    const knob = h('div', { class: 'knob' });
    const zero = center !== null ? h('div', { class: 'zero', style: { left: pct(center) + '%' } }) : null;
    const track = h('div', { class: `track${opts.rail ? ' grad' : ''}` }, rail, zero, fill, knob);
    const label = h('label', { title: opts.title || 'Double-click to reset' }, opts.label);
    const input = h('input', { class: 'val', type: 'text', spellcheck: 'false' });
    const el = h('div', { class: 'sl' }, label, track, input);

    function pct(v) { return ((v - min) / (max - min)) * 100; }
    function fmt(v) {
      if (opts.format) return opts.format(v);
      const s = opts.signed !== false && min < 0 ? fmtSigned(v, dec) : Number(v).toFixed(dec);
      return s + (opts.suffix || '');
    }
    function quant(v) {
      v = Math.max(min, Math.min(max, v));
      v = Math.round(v / step) * step;
      return Number(v.toFixed(6));
    }
    function paint() {
      const p = pct(value);
      knob.style.left = p + '%';
      const a = center !== null ? pct(center) : 0;
      fill.style.left = Math.min(a, p) + '%';
      fill.style.width = Math.abs(p - a) + '%';
      if (document.activeElement !== input) input.value = fmt(value);
      el.classList.toggle('changed', value !== def);
    }
    function set(v, phase) {
      const q = quant(v);
      const changed = q !== value;
      value = q;
      paint();
      if (phase && (changed || phase === 'commit')) opts.onInput && opts.onInput(value, phase);
    }

    let drag = null;
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      try { track.setPointerCapture(e.pointerId); } catch (_) { }
      const r = track.getBoundingClientRect();
      const onKnob = e.target === knob;
      if (!onKnob) set(min + ((e.clientX - r.left) / r.width) * (max - min), 'live');
      drag = { x: e.clientX, v: value, w: r.width, moved: !onKnob, start: value };
      track.classList.add('drag');
      e.preventDefault();
    });
    track.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const fine = e.shiftKey ? 0.2 : 1;
      const dv = ((e.clientX - drag.x) / drag.w) * (max - min) * fine;
      if (Math.abs(e.clientX - drag.x) > 0) drag.moved = true;
      set(drag.v + dv, 'live');
    });
    const end = () => {
      if (!drag) return;
      track.classList.remove('drag');
      const moved = drag.moved && value !== drag.start;
      drag = null;
      if (moved) opts.onInput && opts.onInput(value, 'commit');
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    const reset = () => { set(def, 'live'); opts.onInput && opts.onInput(value, 'commit'); };
    track.addEventListener('dblclick', reset);
    label.addEventListener('dblclick', reset);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { input.blur(); }
      else if (e.key === 'Escape') { input.value = fmt(value); input.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const mult = e.shiftKey ? 10 : 1;
        set(value + (e.key === 'ArrowUp' ? step : -step) * mult, 'live');
        opts.onInput && opts.onInput(value, 'commit');
        input.value = fmt(value);
      }
      e.stopPropagation();
    });
    input.addEventListener('focus', () => { input.select(); });
    input.addEventListener('blur', () => {
      const n = parseFloat(String(input.value).replace(/[^\d.+-]/g, ''));
      if (!isNaN(n) && quant(n) !== value) { set(n, 'live'); opts.onInput && opts.onInput(value, 'commit'); }
      input.value = fmt(value);
    });
    paint();
    return {
      el, input,
      get: () => value,
      set: (v) => { value = quant(v); paint(); },
      setDisabled: (d) => el.classList.toggle('disabled', !!d)
    };
  }

  /* ---------------- Panel ---------------- */
  const panelState = (() => { try { return JSON.parse(localStorage.getItem('pj.panels') || '{}'); } catch (_) { return {}; } })();
  function panel(opts) {
    const chev = icon('chevron-down', 'chev');
    const dot = h('span', { class: 'dot' });
    const head = h('div', { class: 'ph' }, opts.icon ? icon(opts.icon) : null, h('span', null, opts.title), dot);
    let toggle = null;
    if (opts.toggle) {
      toggle = h('span', { class: 'toggle', title: 'Toggle this panel on/off' }, icon('power-off'));
      toggle.addEventListener('click', (e) => { e.stopPropagation(); opts.toggle.set(!opts.toggle.get()); refreshToggle(); });
      head.appendChild(toggle);
    }
    if (opts.actions) head.appendChild(opts.actions);
    head.appendChild(chev);
    const body = h('div', { class: 'pb' });
    const el = h('section', { class: 'panel', dataset: { panel: opts.id } }, head, body);
    const collapsed = panelState[opts.id] ?? !!opts.collapsed;
    if (collapsed) el.classList.add('collapsed');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.panel-actions')) return;
      if (e.altKey) {
        // Solo mode: collapse siblings
        el.parentElement && $$('.panel', el.parentElement).forEach(p => { if (p !== el) { p.classList.add('collapsed'); panelState[p.dataset.panel] = true; } });
      }
      el.classList.toggle('collapsed');
      panelState[opts.id] = el.classList.contains('collapsed');
      try { localStorage.setItem('pj.panels', JSON.stringify(panelState)); } catch (_) { }
      opts.onToggle && opts.onToggle(!el.classList.contains('collapsed'));
    });
    function refreshToggle() { if (toggle) toggle.classList.toggle('off', !opts.toggle.get()); }
    refreshToggle();
    return {
      el, body, head,
      setEdited: (b) => el.classList.toggle('edited', !!b),
      refreshToggle,
      expand: () => { el.classList.remove('collapsed'); panelState[opts.id] = false; },
      isOpen: () => !el.classList.contains('collapsed')
    };
  }

  /* ---------------- Modal ---------------- */
  const modalStack = [];
  function modal(opts) {
    const close = () => {
      back.remove();
      const i = modalStack.indexOf(api);
      if (i >= 0) modalStack.splice(i, 1);
      opts.onClose && opts.onClose();
    };
    const footer = h('div', { class: 'mf' });
    if (opts.footerLeft) footer.appendChild(h('div', { class: 'left' }, opts.footerLeft));
    (opts.buttons || [{ label: 'Close' }]).forEach(b => {
      const btn = h('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}` }, b.icon ? icon(b.icon) : null, b.label);
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          const r = await b.onClick(btn);
          if (r === false) return;
        }
        close();
      });
      footer.appendChild(btn);
    });
    const dlg = h('div', { class: `modal${opts.wide ? ' wide' : ''}`, role: 'dialog' },
      h('div', { class: 'mh' }, opts.icon ? icon(opts.icon) : null, h('h3', null, opts.title),
        h('button', { class: 'btn ghost icon sm x', onclick: close, title: 'Close' }, icon('xmark'))),
      h('div', { class: 'mb' }, opts.body),
      footer);
    const back = h('div', { class: 'modal-back' }, dlg);
    back.addEventListener('mousedown', (e) => { if (e.target === back && !opts.sticky) close(); });
    document.body.appendChild(back);
    const api = { close, el: dlg, footer, onKey: opts.onKey };
    modalStack.push(api);
    setTimeout(() => { const f = dlg.querySelector('[autofocus]') || dlg.querySelector('input,select,textarea'); if (f) f.focus(); }, 30);
    return api;
  }
  const hasModal = () => modalStack.length > 0;
  const topModal = () => modalStack[modalStack.length - 1];

  function promptText(title, value, opts = {}) {
    return new Promise((resolve) => {
      let done = false;
      const inp = h('input', { type: 'text', value: value || '', style: { width: '100%' }, autofocus: true, placeholder: opts.placeholder || '' });
      const m = modal({
        title, icon: opts.icon, body: h('div', { class: 'col' }, opts.message ? h('div', { class: 'muted' }, opts.message) : null, inp),
        buttons: [{ label: 'Cancel' }, { label: opts.ok || 'OK', primary: true, onClick: () => { done = true; resolve(inp.value.trim() || null); } }],
        onClose: () => { if (!done) resolve(null); }
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { done = true; resolve(inp.value.trim() || null); m.close(); }
        e.stopPropagation();
      });
    });
  }
  function confirmBox(title, message, ok = 'OK', danger = false) {
    return new Promise((resolve) => {
      let done = false;
      modal({
        title, body: h('div', { style: { lineHeight: 1.55 } }, message),
        buttons: [{ label: 'Cancel' }, { label: ok, primary: !danger, danger, onClick: () => { done = true; resolve(true); } }],
        onClose: () => { if (!done) resolve(false); }
      });
    });
  }

  /* ---------------- Context menu ---------------- */
  let ctxEl = null;
  function closeMenu() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
  function menu(x, y, items) {
    closeMenu();
    ctxEl = h('div', { class: 'ctx' });
    items.forEach(it => {
      if (it === '-') { ctxEl.appendChild(h('div', { class: 'cs' })); return; }
      if (!it || it.hidden) return;
      const row = h('div', { class: 'ci' }, it.icon ? icon(it.icon) : h('i'), h('span', null, it.label), it.key ? h('span', { class: 'k' }, keys(it.key)) : null);
      if (it.disabled) row.style.opacity = .4;
      else row.addEventListener('click', () => { closeMenu(); it.action(); });
      ctxEl.appendChild(row);
    });
    document.body.appendChild(ctxEl);
    const r = ctxEl.getBoundingClientRect();
    ctxEl.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
    ctxEl.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  }
  document.addEventListener('mousedown', (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeMenu(); }, true);
  window.addEventListener('blur', closeMenu);

  /* ---------------- Activity indicator ---------------- */
  function activity(text, frac) {
    const t = $('#activity-text'), bar = $('#activity-bar');
    if (!t) return;
    t.textContent = text || '';
    if (frac === undefined || frac === null) bar.classList.add('hidden');
    else { bar.classList.remove('hidden'); bar.firstElementChild.style.width = Math.round(frac * 100) + '%'; }
  }

  function seg(options, value, onChange) {
    const el = h('div', { class: 'seg' });
    const btns = options.map(o => {
      const b = h('button', { title: o.title || '' }, o.icon ? icon(o.icon) : null, o.label ? ' ' + o.label : null);
      b.addEventListener('click', () => { set(o.value); onChange(o.value); });
      el.appendChild(b);
      return b;
    });
    function set(v) { options.forEach((o, i) => btns[i].classList.toggle('on', o.value === v)); }
    set(value);
    return { el, set };
  }

  function checkbox(label, checked, onChange) {
    const inp = h('input', { type: 'checkbox' });
    inp.checked = !!checked;
    inp.addEventListener('change', () => onChange(inp.checked));
    const el = h('label', { class: 'chk' }, inp, label);
    return { el, input: inp, set: (v) => { inp.checked = !!v; } };
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---------------- platform wording ---------------- */
  // Shortcuts are written the Windows way ("Ctrl+Shift+E") and the key handlers take Ctrl or ⌘ alike.
  // On a Mac they are shown as macOS writes them: modifiers as symbols in the order ⌥⇧⌘, then the key ("⇧⌘E").
  const isMac = (global.PJ.API && global.PJ.API.platform === 'macos') || /Mac/i.test((global.navigator && global.navigator.platform) || '');
  const MAC_MOD = { Alt: '⌥', Shift: '⇧', Ctrl: '⌘' };
  const MAC_KEY = { Enter: '↩', Del: '⌫' };
  function keys(s) {
    if (!isMac || !s) return s;
    return String(s).replace(/(?:(?:Ctrl|Alt|Shift)\+)+[^\s)]+|\bDel\b/g, (m) => {
      const parts = m.split('+'), key = parts.pop();
      return ['Alt', 'Shift', 'Ctrl'].filter(x => parts.includes(x)).map(x => MAC_MOD[x]).join('') + (MAC_KEY[key] || key);
    });
  }
  /** What the settings window is called: Settings on a Mac (the macOS name since Ventura), Preferences elsewhere. */
  const settingsName = isMac ? 'Settings' : 'Preferences';

  global.PJ.UI = {
    h, icon, $, $$, debounce, emitter, toast, slider, panel, modal, hasModal, topModal, prompt: promptText,
    confirm: confirmBox, menu, closeMenu, activity, seg, checkbox, fmtBytes, fmtDate, escapeHtml, fmtSigned,
    isMac, keys, settingsName
  };
})(window);
