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

  /* ---------------- the runtime ---------------- */
  let ortPromise = null;
  const sessions = {};
  function runtime() {
    if (!ortPromise) {
      const base = new URL('vendor/ml/', location.href).href;
      ortPromise = import(base + 'ort.wasm.min.mjs').then((ort) => {
        ort.env.wasm.wasmPaths = base;
        ort.env.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2));
        // (the runtime's own "proxy" worker does not start under this app's isolation settings; a run takes
        // a fifth of a second on its threads, once per mask, so it is called directly)
        return ort;
      });
      ortPromise.catch(() => { ortPromise = null; });
    }
    return ortPromise;
  }
  async function session(model) {
    if (!sessions[model]) {
      const ort = await runtime();
      const url = new URL('vendor/ml/' + MODELS[model].file, location.href).href;
      sessions[model] = ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
        .catch((e) => { delete sessions[model]; throw new Error(/404|Failed to fetch|no such file/i.test(String(e && e.message)) ? `The model for this mask (${MODELS[model].file}) isn't part of this build` : 'The mask model could not be started: ' + (e && e.message || e)); });
    }
    return sessions[model];
  }

  /* ---------------- image → network → probability ---------------- */
  /** RGBA pixels → a 1×3×n×n float tensor, stretched to the square the networks expect, ImageNet-normalised. */
  function toTensor(ort, img, n) {
    const c = PJ.Decode.makeCanvas(img.width, img.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const s = PJ.Decode.makeCanvas(n, n), x = s.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, 0, 0, n, n);
    const d = x.getImageData(0, 0, n, n).data, f = new Float32Array(3 * n * n), N = n * n;
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) f[k * N + i] = (d[i * 4 + k] / 255 - mean[k]) / std[k];
    return new ort.Tensor('float32', f, [1, 3, n, n]);
  }

  /** Probability (0…1) per cell of the network's output grid: { data, w, h }. */
  async function probability(kind, img) {
    const K = KINDS[kind], M = MODELS[K.model];
    const ort = await runtime(), s = await session(K.model);
    const out = await s.run({ [s.inputNames[0]]: toTensor(ort, img, M.size) });
    const t = out[s.outputNames[0]], d = t.data;
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
    return { ai: kind, map: { id, w: map.w, h: map.h }, name: KINDS[kind].name };
  }

  global.PJ.AIMask = { KINDS, create, ensure, ready, _test: { compute, probability, refine } };
})(window);
