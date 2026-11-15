/* =====================================================================
 * photos.jpeg — Subject, Sky and People masks.
 *
 * A small neural network looks at the photo and marks what belongs to the
 * subject (U²-Net), or to the sky / to people (SegFormer trained on ADE20K
 * scenes). The result becomes an ordinary brush mask: it takes the same
 * adjustments, can be inverted, limited by luminance, and touched up with
 * the brush (paint to add, Alt-paint to erase).
 *
 * Everything runs on this computer with ONNX Runtime Web (WebAssembly,
 * multi-threaded); the models are in vendor/ml. Nothing is uploaded.
 *
 * The mask's shape is stored once, as a small greyscale map, next to the
 * thumbnails — not in the photo's settings, which would copy it into every
 * history step. A photo's settings only name the map. If the map is ever
 * missing (a catalog moved without its thumbnails) it is worked out again.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, API = PJ.API;
  const G = 512;                               // long edge of a mask map, the same grid brush masks use
  const MODELS = {
    subject: { file: 'u2netp.onnx', size: 320 },
    scene: { file: 'segformer-b0-ade.onnx', size: 512 }
  };
  const KINDS = {
    subject: { model: 'subject', name: 'Subject', busy: 'Finding the subject…' },
    sky: { model: 'scene', classes: [2], name: 'Sky', busy: 'Finding the sky…' },
    people: { model: 'scene', classes: [12], name: 'People', busy: 'Finding people…' }
  };

  /* ---------------- the runtime: in a thread of its own (aiworker.js) ---------------- */
  let worker = null, seq = 0;
  const waiting = new Map();
  function modelWorker() {
    if (!worker) {
      worker = new Worker(new URL('js/aiworker.js', location.href).href, { type: 'module' });
      worker.onmessage = (ev) => {
        const m = ev.data, w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id);
        if (m.error) w.reject(new Error(m.error)); else w.resolve(m);
      };
      worker.onerror = (ev) => {
        const err = new Error('The mask model could not be started: ' + (ev && ev.message || 'its thread failed to load'));
        for (const w of waiting.values()) w.reject(err);
        waiting.clear();
        try { worker.terminate(); } catch (_) { }
        worker = null;
      };
    }
    return worker;
  }
  /** Run a model on a prepared input; resolves to { data, dims }. */
  function infer(model, input) {
    const M = MODELS[model];
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      modelWorker().postMessage({ id, model, file: M.file, size: M.size, input }, [input.buffer]);
    }).catch((e) => {
      const msg = String(e && e.message || e);
      throw new Error(/404|Failed to fetch|no such file|failed to load model/i.test(msg) ? `The model for this mask (${M.file}) is not part of this build` : /could not be started/.test(msg) ? msg : 'The mask model could not be started: ' + msg);
    });
  }

  /* ---------------- image → network → probability ---------------- */
  /** RGBA pixels → a 1×3×n×n float tensor, stretched to the square the networks expect, ImageNet-normalised. */
  function toTensor(img, n) {
    const c = PJ.Decode.makeCanvas(img.width, img.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const s = PJ.Decode.makeCanvas(n, n), x = s.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, 0, 0, n, n);
    const d = x.getImageData(0, 0, n, n).data, f = new Float32Array(3 * n * n), N = n * n;
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) f[k * N + i] = (d[i * 4 + k] / 255 - mean[k]) / std[k];
    return f;
  }

  /* The scene model's answer for a photo is the same whatever is asked of it (sky, people, what is
     in the picture), so the last few are kept: Sky after People costs nothing. */
  const sceneCache = new Map();
  function sceneKey(img) {
    const d = img.data; let hsh = img.width * 31 + img.height;
    for (let i = 0; i < d.length; i += 997) hsh = (hsh * 33 + d[i]) | 0;
    return img.width + 'x' + img.height + ':' + hsh;
  }
  async function sceneScores(img) {
    const key = sceneKey(img);
    if (!sceneCache.has(key)) {
      const pr = infer('scene', toTensor(img, MODELS.scene.size));
      sceneCache.set(key, pr);
      pr.catch(() => sceneCache.delete(key));
      if (sceneCache.size > 4) sceneCache.delete(sceneCache.keys().next().value);
    }
    return sceneCache.get(key);
  }

  /** Probability (0…1) per cell of the network's output grid: { data, w, h }. */
  async function probability(kind, img) {
    const K = KINDS[kind], M = MODELS[K.model];
    const t = K.model === 'scene' ? await sceneScores(img) : await infer(K.model, toTensor(img, M.size)), d = t.data;
    if (K.model === 'subject') {
      // U²-Net: one saliency map, stretched to its own range
      const h = t.dims[2], w = t.dims[3], p = new Float32Array(w * h);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < p.length; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
      const span = hi - lo || 1;
      for (let i = 0; i < p.length; i++) p[i] = (d[i] - lo) / span;
      return { data: p, w, h, found: hi - lo > 0.2 };
    }
    // SegFormer: scores for 150 kinds of thing per cell → the share that belongs to the wanted ones
    const C = t.dims[1], h = t.dims[2], w = t.dims[3], N = w * h, p = new Float32Array(N);
    let strong = 0;
    for (let i = 0; i < N; i++) {
      let mx = -Infinity;
      for (let c = 0; c < C; c++) { const v = d[c * N + i]; if (v > mx) mx = v; }
      let sum = 0, want = 0;
      for (let c = 0; c < C; c++) { const e = Math.exp(d[c * N + i] - mx); sum += e; if (K.classes.includes(c)) want += e; }
      p[i] = want / sum;
      if (p[i] > 0.5) strong++;
    }
    return { data: p, w, h, found: strong > N * 0.002 };
  }

  /* ---------------- probability → mask map ---------------- */
  function resample(src, sw, sh, dw, dh) {
    const out = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const fy = Math.max(0, Math.min(sh - 1, (y + 0.5) * sh / dh - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < dw; x++) {
        const fx = Math.max(0, Math.min(sw - 1, (x + 0.5) * sw / dw - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        out[y * dw + x] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
      }
    }
    return out;
  }
  /** Mean over a (2r+1)² window, edges repeated. */
  function box(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { tmp[row + x] = acc / n; acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]; }
    }
    const col = new Float32Array(w);
    for (let y = -r; y <= r; y++) { const row = Math.min(h - 1, Math.max(0, y)) * w; for (let x = 0; x < w; x++) col[x] += tmp[row + x]; }
    for (let y = 0; y < h; y++) {
      const add = Math.min(h - 1, y + r + 1) * w, sub = Math.max(0, y - r) * w;
      for (let x = 0; x < w; x++) { out[y * w + x] = col[x] / n; col[x] += tmp[add + x] - tmp[sub + x]; }
    }
    return out;
  }
  /**
   * Guided filter: the coarse probability takes on the photo's own edges, so the mask ends where
   * the hair, the roofline or the horizon does rather than where the network's coarse grid put it.
   */
  function refine(p, guide, w, h, r, eps) {
    const N = w * h, Ip = new Float32Array(N), II = new Float32Array(N);
    for (let i = 0; i < N; i++) { Ip[i] = guide[i] * p[i]; II[i] = guide[i] * guide[i]; }
    const mI = box(guide, w, h, r), mP = box(p, w, h, r), mIp = box(Ip, w, h, r), mII = box(II, w, h, r);
    const a = new Float32Array(N), b = new Float32Array(N);
    for (let i = 0; i < N; i++) { a[i] = (mIp[i] - mI[i] * mP[i]) / (mII[i] - mI[i] * mI[i] + eps); b[i] = mP[i] - a[i] * mI[i]; }
    const mA = box(a, w, h, r), mB = box(b, w, h, r), out = new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = mA[i] * guide[i] + mB[i]; out[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
    return out;
  }

  /** Work the mask out for a photo: { w, h, data (Uint8Array), found }. */
  async function compute(photo, kind) {
    // the photo as developed, before any edits or geometry: masks live in the source image's own frame
    const img = await PJ.Engine.render(photo, P.defaultSettings(), 'draft', {}, 0);
    if (!img) throw new Error('The photo could not be rendered');
    const prob = await probability(kind, img);
    const L = Math.max(img.width, img.height), gw = Math.max(1, Math.ceil(G * img.width / L)), gh = Math.max(1, Math.ceil(G * img.height / L));
    const up = resample(prob.data, prob.w, prob.h, gw, gh);
    if (kind === 'subject') {
      // The saliency network goes for what stands out — in a dim portrait that can be the face alone.
      // When the people it found overlap what stands out, the whole person is the subject.
      try {
        const people = await probability('people', img);
        if (people.found) {
          const pp = resample(people.data, people.w, people.h, gw, gh);
          let both = 0, salient = 0;
          for (let i = 0; i < up.length; i++) { salient += up[i]; both += Math.min(up[i], pp[i]); }
          if (salient > 0 && both / salient > 0.3) { for (let i = 0; i < up.length; i++) if (pp[i] > up[i]) up[i] = pp[i]; prob.found = true; }
        }
      } catch (e) { console.warn('subject mask: the scene model was not available, using saliency alone:', e && e.message); }
    }
    // guide: the photo's luminance on the same grid
    const c = PJ.Decode.makeCanvas(img.width, img.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const s = PJ.Decode.makeCanvas(gw, gh), x = s.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, gw, gh);
    const d = x.getImageData(0, 0, gw, gh).data, guide = new Float32Array(gw * gh);
    for (let i = 0; i < guide.length; i++) guide[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    const fine = refine(up, guide, gw, gh, 6, 2e-3);
    const data = new Uint8Array(gw * gh);
    for (let i = 0; i < data.length; i++) { const t = Math.max(0, Math.min(1, (fine[i] - 0.15) / 0.7)); data[i] = Math.round(t * t * (3 - 2 * t) * 255); }
    return { w: gw, h: gh, data, found: prob.found };
  }

  /* ---------------- where maps are kept ---------------- */
  const pending = new Map();
  const storeKey = (id) => 'mm_' + id;
  function remember(id, map) { P.setMaskMap(id, map.w, map.h, map.data); }
  async function store(id, map) {
    if (!API.hasThumbStore || !API.saveThumb) return;
    const bytes = new Uint8Array(4 + map.data.length);
    bytes[0] = map.w & 255; bytes[1] = map.w >> 8; bytes[2] = map.h & 255; bytes[3] = map.h >> 8;
    bytes.set(map.data, 4);
    try { await API.saveThumb(storeKey(id), bytes); } catch (e) { console.warn('could not store a mask', e && e.message); }
  }
  async function load(id) {
    if (!API.hasThumbStore) return null;
    try {
      const r = await fetch(API.thumbUrl(storeKey(id), 1));
      if (!r.ok) return null;
      const b = new Uint8Array(await r.arrayBuffer());
      const w = b[0] | (b[1] << 8), h = b[2] | (b[3] << 8);
      return b.length === 4 + w * h && w > 0 ? { w, h, data: b.slice(4) } : null;
    } catch (_) { return null; }
  }

  /** True when every mask map these settings name is in memory (so a render can go ahead at once). */
  function ready(settings) {
    const ms = settings && settings.masks;
    if (!ms) return true;
    for (const m of ms) if (m.map && !P.hasMaskMap(m.map.id)) return false;
    return true;
  }
  /** Bring the mask maps these settings name into memory: from disk, or worked out again if they are gone. */
  async function ensure(photo, settings) {
    const ms = settings && settings.masks;
    if (!ms) return;
    for (const m of ms) {
      if (!m.map || P.hasMaskMap(m.map.id)) continue;
      const id = m.map.id;
      if (!pending.has(id)) {
        pending.set(id, (async () => {
          let map = await load(id);
          if (!map && m.ai && KINDS[m.ai] && photo) {
            try { map = await compute(photo, m.ai); await store(id, map); }
            catch (e) { console.warn(`the ${m.ai} mask could not be rebuilt:`, e && e.message); }
          }
          // nothing to be had: an empty map, so the photo still renders (the mask then does nothing)
          remember(id, map || { w: 1, h: 1, data: new Uint8Array(1) });
        })().finally(() => pending.delete(id)));
      }
      await pending.get(id);
    }
  }

  /**
   * Make a Subject / Sky / People mask for a photo. Resolves to the fields a brush mask needs
   * ({ ai, map: { id, w, h }, name }); rejects when the photo has nothing of that kind.
   */
  async function create(photo, kind) {
    if (!KINDS[kind]) throw new Error('Unknown mask ' + kind);
    if (photo.kind === 'video') throw new Error('These masks are for photos; on a clip the subject moves');
    const map = await compute(photo, kind);
    if (!map.found) throw new Error({ subject: 'No clear subject was found in this photo', sky: 'No sky was found in this photo', people: 'No people were found in this photo' }[kind]);
    const id = PJ.Catalog.uid('mm');
    remember(id, map);
    await store(id, map);
    return { ai: kind, map: { id, w: map.w, h: map.h, of: photo.id }, name: KINDS[kind].name };
  }

  /**
   * After settings came from another photo (paste, sync, a preset): its Subject / Sky / People masks
   * are found again in this photo, since the shape belongs to the photo it was made on.
   * Changes photo.settings.masks in place; resolves to { redone, empty: [names with nothing to find] }.
   */
  async function retarget(photo) {
    const res = { redone: 0, empty: [] };
    const ms = photo.settings && photo.settings.masks;
    if (!ms || photo.kind === 'video') return res;
    for (const m of ms) {
      if (!m.ai || !KINDS[m.ai] || !m.map || m.map.of === photo.id) continue;
      let map = null;
      try { map = await compute(photo, m.ai); }
      catch (e) { console.warn(`the ${m.ai} mask could not be made for ${photo.name}:`, e && e.message); }
      const id = PJ.Catalog.uid('mm');
      if (!map || !map.found) { map = { w: 1, h: 1, data: new Uint8Array(1) }; res.empty.push(m.name); }
      remember(id, map);
      await store(id, map);
      m.map = { id, w: map.w, h: map.h, of: photo.id };
      m.dabs = [];                      // touch-ups painted on the other photo do not belong here
      res.redone++;
    }
    return res;
  }
  const hasAi = (settings) => !!(settings && settings.masks && settings.masks.some(m => m.ai && m.map));

  /**
   * What the scene model sees in a photo: [{ label, share }] for the kinds of thing that cover a
   * worthwhile part of the picture, largest first. Used to suggest keywords.
   */
  async function describe(photo) {
    const img = await PJ.Engine.render(photo, P.defaultSettings(), 'draft', {}, 0);
    if (!img) throw new Error('The photo could not be rendered');
    const t = await sceneScores(img), d = t.data, C = t.dims[1], N = t.dims[2] * t.dims[3];
    const count = new Float32Array(C);
    for (let i = 0; i < N; i++) {
      let mx = -Infinity, arg = 0, second = -Infinity;
      for (let c = 0; c < C; c++) { const v = d[c * N + i]; if (v > mx) { second = mx; mx = v; arg = c; } else if (v > second) second = v; }
      if (mx - second > 1) count[arg]++;          // only cells the model is fairly sure of
    }
    const out = [];
    for (let c = 0; c < C; c++) {
      const label = SCENE_LABELS[c], share = count[c] / N;
      if (label && share >= (SMALL_THINGS.has(c) ? 0.008 : 0.04)) out.push({ label, share });
    }
    return out.sort((p, q) => q.share - p.share);
  }
  /* ADE20K classes worth offering as a keyword, by class number. Left out: parts of rooms and
     things too generic to search for (wall, floor, ceiling, …). */
  const SCENE_LABELS = { 1: 'building', 2: 'sky', 4: 'tree', 6: 'road', 7: 'bed', 9: 'grass', 12: 'people', 13: 'earth', 16: 'mountain', 17: 'plant', 19: 'chair', 20: 'car', 21: 'water', 23: 'sofa', 25: 'house', 26: 'sea', 29: 'field', 32: 'fence', 34: 'rock', 46: 'sand', 48: 'skyscraper', 52: 'path', 53: 'stairs', 60: 'river', 61: 'bridge', 66: 'flower', 67: 'book', 68: 'hill', 72: 'palm tree', 76: 'boat', 80: 'bus', 83: 'truck', 84: 'tower', 90: 'airplane', 91: 'dirt track', 94: 'pole', 102: 'van', 103: 'ship', 104: 'fountain', 109: 'swimming pool', 113: 'waterfall', 114: 'tent', 116: 'motorbike', 126: 'animal', 127: 'bicycle', 128: 'lake', 136: 'traffic light', 149: 'flag' };
  const SMALL_THINGS = new Set([12, 20, 66, 76, 80, 83, 90, 102, 103, 116, 126, 127, 136, 149]);

  global.PJ.AIMask = { KINDS, create, ensure, ready, describe, retarget, hasAi, _test: { compute, probability, refine } };
})(window);
