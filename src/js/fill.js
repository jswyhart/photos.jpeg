/* =====================================================================
 * photos.jpeg — content-aware fill (the "Fill" mode of Spot Removal).
 *
 * Paint over something that should not be in the picture; the painted area
 * is filled with material made from its surroundings (js/fillworker.js).
 *
 * The filled piece is worked out once, at the photo's full resolution (or
 * 1024 pixels across the area, whichever is smaller), and kept next to the
 * thumbnails. The photo's settings only name it:
 *   spot = { mode: 'fill', pts: [[x, y]…], r, x, y, feather,
 *            patch: { id, x, y, w, h, pw, ph, of } }
 * (positions and sizes as fractions of the photo's long edge, like every
 * spot; `of` is the photo the piece was made for). If the piece is ever
 * missing, or the spot arrives on another photo by paste or sync, it is
 * made again there.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, API = PJ.API;
  const MAX = 1024;                         // long edge of the piece that is worked on
  const key = (id) => 'cf_' + id;

  let worker = null, seq = 0;
  const waiting = new Map();
  function run(job) {
    if (!worker) {
      worker = new Worker(new URL('js/fillworker.js', location.href).href);
      worker.onmessage = (ev) => { const w = waiting.get(ev.data.id); if (!w) return; waiting.delete(ev.data.id); if (ev.data.error) w.reject(new Error(ev.data.error)); else w.resolve(ev.data.rgb); };
      worker.onerror = (ev) => { for (const w of waiting.values()) w.reject(new Error('The fill could not be started' + (ev && ev.message ? ': ' + ev.message : ''))); waiting.clear(); try { worker.terminate(); } catch (_) { } worker = null; };
    }
    return new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); worker.postMessage(Object.assign({ id }, job), [job.rgb.buffer, job.mask.buffer]); });
  }

  /** Distance from a point to the painted line (all in the same units). */
  function distToStroke(px, py, pts) {
    let best = Infinity;
    if (pts.length === 1) return Math.hypot(px - pts[0][0], py - pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
      const d = Math.hypot(px - ax - dx * t, py - ay - dy * t);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Work out the filled piece for a fill spot of this photo. `before`: the spots that come before it
   * (their result is what gets filled). Resolves to { id, map: { w, h, data RGBA }, patch }.
   */
  async function compute(photo, spot, before) {
    let lv;
    try { const src = await PJ.Engine.ensureFull(photo); lv = src.full || src.proxy; }
    catch (_) { const src = await PJ.Engine.ensureSource(photo, 'best'); lv = src.proxy; }
    if (!lv) throw new Error('The photo could not be read');
    const W = lv.width, H = lv.height, L = Math.max(W, H);
    const pts = spot.pts.map(p => [p[0] * L, p[1] * L]), R = Math.max(1.5, spot.r * L);
    const feather = Math.max(2, R * 0.35 * Math.max(0.1, (spot.feather ?? 50) / 50));
    // the piece: the painted area with room around it to take material from
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const room = Math.max(R * 3, L * 0.03) + R + feather;
    x0 = Math.max(0, Math.floor(x0 - room)); y0 = Math.max(0, Math.floor(y0 - room)); x1 = Math.min(W, Math.ceil(x1 + room)); y1 = Math.min(H, Math.ceil(y1 + room));
    const bw = x1 - x0, bh = y1 - y0;
    if (bw < 8 || bh < 8) throw new Error('That area is outside the photo');
    const k = Math.min(1, MAX / Math.max(bw, bh)), pw = Math.max(8, Math.round(bw * k)), ph = Math.max(8, Math.round(bh * k));
    // that part of the photo, with the earlier spots applied
    const data = before && before.length ? P.applySpots(lv.data, W, H, before) : lv.data;
    const part = new Uint8ClampedArray(bw * bh * 4);
    for (let y = 0; y < bh; y++) part.set(data.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + bw) * 4), y * bw * 4);
    for (let i = 3; i < part.length; i += 4) part[i] = 255;
    const c = PJ.Decode.makeCanvas(bw, bh); c.getContext('2d').putImageData(new ImageData(part, bw, bh), 0, 0);
    const s = PJ.Decode.makeCanvas(pw, ph), sx = s.getContext('2d', { willReadFrequently: true });
    sx.imageSmoothingQuality = 'high'; sx.drawImage(c, 0, 0, pw, ph);
    const d = sx.getImageData(0, 0, pw, ph).data;
    const rgb = new Uint8Array(pw * ph * 3), mask = new Uint8Array(pw * ph), alpha = new Uint8Array(pw * ph);
    const lp = pts.map(p => [(p[0] - x0) * k, (p[1] - y0) * k]), Rk = R * k, fk = Math.max(1.5, feather * k);
    let hole = 0;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const i = y * pw + x;
      rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
      const dist = distToStroke(x + 0.5, y + 0.5, lp);
      // filled a little past what is blended in, so the blend never shows what was painted over
      if (dist <= Rk + fk + 1) { mask[i] = 1; hole++; }
      const t = Math.max(0, Math.min(1, (Rk + fk - dist) / fk));
      alpha[i] = Math.round(t * t * (3 - 2 * t) * 255);
    }
    if (hole >= pw * ph * 0.7) throw new Error('The painted area is too large to fill from what is left around it');
    // what is where around the hole (sky, trees, road …), when the scene model is there to say
    let label = null;
    try {
      // the model looks at the piece itself, so its map is fine enough to follow edges inside it;
      // for a very small piece the map of the whole photo is used instead
      let lm = PJ.AIMask && PJ.AIMask.labelsOfRegion ? await PJ.AIMask.labelsOfRegion(photo, { x: x0 / W, y: y0 / H, w: bw / W, h: bh / H }) : null;
      if (lm) {
        label = new Uint8Array(pw * ph);
        for (let y = 0; y < ph; y++) { const ly = Math.min(lm.h - 1, Math.floor((y + 0.5) / ph * lm.h)); for (let x = 0; x < pw; x++) label[y * pw + x] = lm.data[ly * lm.w + Math.min(lm.w - 1, Math.floor((x + 0.5) / pw * lm.w))]; }
      } else {
        lm = PJ.AIMask && PJ.AIMask.labels ? await PJ.AIMask.labels(photo) : null;
        if (lm) {
          label = new Uint8Array(pw * ph);
          for (let y = 0; y < ph; y++) { const ly = Math.min(lm.h - 1, Math.floor((y0 + (y + 0.5) / k) / H * lm.h)); for (let x = 0; x < pw; x++) label[y * pw + x] = lm.data[ly * lm.w + Math.min(lm.w - 1, Math.floor((x0 + (x + 0.5) / k) / W * lm.w))]; }
        }
      }
    } catch (e) { console.warn('fill: no scene map, filling by texture alone:', e && e.message); }
    const out = await run(label ? { w: pw, h: ph, rgb, mask, label } : { w: pw, h: ph, rgb, mask });
    const map = new Uint8Array(pw * ph * 4);
    for (let i = 0; i < pw * ph; i++) { map[i * 4] = out[i * 3]; map[i * 4 + 1] = out[i * 3 + 1]; map[i * 4 + 2] = out[i * 3 + 2]; map[i * 4 + 3] = alpha[i]; }
    const id = PJ.Catalog.uid('cf');
    return { id, map: { w: pw, h: ph, data: map }, patch: { id, x: x0 / L, y: y0 / L, w: bw / L, h: bh / L, pw, ph, of: photo.id }, guided: !!label };
  }
  function remember(id, map) { P.setMaskMap(id, map.w, map.h, map.data); }
  async function store(id, map) {
    if (!API.hasThumbStore || !API.saveThumb) return;
    const bytes = new Uint8Array(4 + map.data.length);
    bytes[0] = map.w & 255; bytes[1] = map.w >> 8; bytes[2] = map.h & 255; bytes[3] = map.h >> 8;
    bytes.set(map.data, 4);
    try { await API.saveThumb(key(id), bytes); } catch (e) { console.warn('could not store a fill', e && e.message); }
  }
  async function load(id) {
    if (!API.hasThumbStore) return null;
    try {
      const r = await fetch(API.thumbUrl(key(id), 1));
      if (!r.ok) return null;
      const b = new Uint8Array(await r.arrayBuffer()), w = b[0] | (b[1] << 8), h = b[2] | (b[3] << 8);
      return w > 0 && b.length === 4 + w * h * 4 ? { w, h, data: b.slice(4) } : null;
    } catch (_) { return null; }
  }

  /** Fill the painted area of a new spot: gives the spot its patch. `before`: the photo's spots so far. */
  async function create(photo, spot, before) {
    const r = await compute(photo, spot, before);
    remember(r.id, r.map);
    await store(r.id, r.map);
    spot.patch = r.patch;
    return spot;
  }

  const fills = (settings) => ((settings && settings.spots) || []).filter(sp => sp.mode === 'fill' && sp.patch);
  /** True when every filled piece these settings name is in memory. */
  function ready(settings) { for (const sp of fills(settings)) if (!P.hasMaskMap(sp.patch.id)) return false; return true; }
  const pending = new Map();
  /** Bring the filled pieces these settings name into memory: from disk, or made again if they are gone. */
  async function ensure(photo, settings) {
    const spots = (settings && settings.spots) || [];
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      if (sp.mode !== 'fill' || !sp.patch || P.hasMaskMap(sp.patch.id)) continue;
      const id = sp.patch.id;
      if (!pending.has(id)) {
        pending.set(id, (async () => {
          let map = await load(id);
          if (!map && photo && sp.pts) {
            try {
              const r = await compute(photo, sp, spots.slice(0, i).filter(q => q.mode !== 'fill' || P.hasMaskMap(q.patch && q.patch.id)));
              // same place, same size: the piece can take the old one's name
              if (r.patch.pw === sp.patch.pw && r.patch.ph === sp.patch.ph) { map = r.map; await store(id, map); }
            } catch (e) { console.warn('a fill could not be made again:', e && e.message); }
          }
          remember(id, map || { w: 1, h: 1, data: new Uint8Array(4) });      // nothing to be had: the spot then does nothing
        })().finally(() => pending.delete(id)));
      }
      await pending.get(id);
    }
  }
  /** After settings came from another photo: its fills are made again for this one. Resolves to the number redone. */
  async function retarget(photo) {
    const spots = (photo.settings && photo.settings.spots) || [];
    let n = 0;
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      if (sp.mode !== 'fill' || !sp.pts || (sp.patch && sp.patch.of === photo.id)) continue;
      try { await create(photo, sp, spots.slice(0, i)); n++; }
      catch (e) { console.warn('fill: ' + photo.name + ': ' + (e && e.message)); delete sp.patch; }
    }
    return n;
  }
  const hasFill = (settings) => ((settings && settings.spots) || []).some(sp => sp.mode === 'fill');

  global.PJ.Fill = { create, ready, ensure, retarget, hasFill, key, _test: { compute, distToStroke } };
})(window);
