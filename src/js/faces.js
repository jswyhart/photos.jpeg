/* =====================================================================
 * photos.jpeg — faces: finding them, and telling whose they are.
 *
 * Two small neural networks, both run on this computer (nothing is
 * uploaded): YuNet finds the faces in a photo and five points on each
 * (eyes, nose, mouth corners); SFace turns a face, turned upright by those
 * points, into 128 numbers that are close together for the same person.
 *
 * A photo keeps its faces as  photo.faces = [{ b, q, v, t, p?, x? }]:
 *   b  the box, as fractions of the photo as it comes from the file [x, y, w, h] — the frame masks and
 *      spots use, so it can be drawn on the photo whatever its crop and rotation
 *   m  true for a face that was marked by hand
 *   q  how sure the detector was (0…1)
 *   v  the 128 numbers, as 8-bit values in base64
 *   t  the key of a small picture of the face in the thumbnail store
 *   p  the id of the person it was named as (Catalog.state.people)
 *   x  true when it was marked "not a person" / not wanted
 * photo.facesV says the photo has been looked at (even if no face was found).
 *
 * Faces that have no name are put into groups of the same person; naming a
 * group names every face in it. Nothing is named without being asked.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, API = PJ.API, Cat = PJ.Catalog;
  const VERSION = 2;              // 2: boxes are in the source photo's own frame (before rotation, crop and geometry)
  const DET = { model: 'facedet', file: 'face_detection_yunet_2023mar.onnx', size: 640 };
  const REC = { model: 'facerec', file: 'face_recognition_sface_2021dec.onnx', size: 112 };
  const MIN_SCORE = 0.7;          // detector confidence below which a face is not kept
  const MIN_FACE = 28;            // a face narrower than this many pixels (of the picture that was looked at) says too little about who it is
  const SAME = 0.42;              // closeness (cosine) at which a face joins a group
  const MERGE = 0.5;              // closeness at which two groups are one person
  const SUGGEST = 0.42;           // closeness to a named person at which that name is offered
  // where the five points sit in the 112×112 picture the recognition network expects
  const REF = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

  /* ---------------- finding faces ---------------- */
  function canvasOf(img) {
    if (img.getContext) return img;
    const c = PJ.Decode.makeCanvas(img.width, img.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return c;
  }
  /** Faces in a picture: [{ x, y, w, h (pixels), score, pts: [[x, y] × 5] }], best first. */
  async function detect(img) {
    const src = canvasOf(img), n = DET.size, k = n / Math.max(src.width, src.height);
    const c = PJ.Decode.makeCanvas(n, n), x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#000'; x.fillRect(0, 0, n, n);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, Math.round(src.width * k), Math.round(src.height * k));
    const d = x.getImageData(0, 0, n, n).data, N = n * n, f = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) { f[i] = d[i * 4 + 2]; f[N + i] = d[i * 4 + 1]; f[2 * N + i] = d[i * 4]; }      // blue, green, red, 0…255
    const r = await PJ.AIMask.runModel({ model: DET.model, file: DET.file, input: f, dims: [1, 3, n, n], all: true });
    const found = [];
    for (const stride of [8, 16, 32]) {
      const cls = r.outs['cls_' + stride], obj = r.outs['obj_' + stride], box = r.outs['bbox_' + stride], kps = r.outs['kps_' + stride];
      if (!cls || !obj || !box || !kps) throw new Error('The face model gave an answer this build does not understand');
      const cols = n / stride, rows = n / stride;
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const score = Math.sqrt(Math.max(0, Math.min(1, cls.data[i])) * Math.max(0, Math.min(1, obj.data[i])));
        if (score < MIN_SCORE) continue;
        const cx = (col + box.data[i * 4]) * stride, cy = (row + box.data[i * 4 + 1]) * stride;
        const w = Math.exp(box.data[i * 4 + 2]) * stride, h = Math.exp(box.data[i * 4 + 3]) * stride;
        const pts = [];
        for (let p = 0; p < 5; p++) pts.push([(kps.data[i * 10 + 2 * p] + col) * stride / k, (kps.data[i * 10 + 2 * p + 1] + row) * stride / k]);
        found.push({ x: (cx - w / 2) / k, y: (cy - h / 2) / k, w: w / k, h: h / k, score, pts });
      }
    }
    found.sort((a, b) => b.score - a.score);
    // the same face is reported by several cells: keep the surest of any that overlap
    const keep = [];
    for (const a of found) {
      let dup = false;
      for (const b of keep) {
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const inter = ix * iy;
        if (inter / (a.w * a.h + b.w * b.h - inter) > 0.3) { dup = true; break; }
      }
      if (!dup) keep.push(a);
    }
    return keep;
  }

  /** The move (scale, turn, shift) that best puts five points onto five others: [a, b, tx, ty] with x' = a·x − b·y + tx, y' = b·x + a·y + ty. */
  function similarity(from, to) {
    let mx = 0, my = 0, ux = 0, uy = 0;
    for (let i = 0; i < from.length; i++) { mx += from[i][0]; my += from[i][1]; ux += to[i][0]; uy += to[i][1]; }
    mx /= from.length; my /= from.length; ux /= from.length; uy /= from.length;
    let sa = 0, sb = 0, ss = 0;
    for (let i = 0; i < from.length; i++) {
      const x = from[i][0] - mx, y = from[i][1] - my, u = to[i][0] - ux, v = to[i][1] - uy;
      sa += x * u + y * v; sb += x * v - y * u; ss += x * x + y * y;
    }
    const a = sa / (ss || 1), b = sb / (ss || 1);
    return [a, b, ux - (a * mx - b * my), uy - (b * mx + a * my)];
  }
  /** The face turned upright and scaled to the 112×112 square the recognition network was trained on. */
  function aligned(src, face) {
    const [a, b, tx, ty] = similarity(face.pts, REF);
    const c = PJ.Decode.makeCanvas(REC.size, REC.size), x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.setTransform(a, b, -b, a, tx, ty);
    x.drawImage(src, 0, 0);
    return c;
  }
  /** 128 numbers for an aligned face, scaled to length 1. */
  async function embed(crop) {
    const n = REC.size, N = n * n, d = crop.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, n, n).data, f = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) { f[i] = d[i * 4]; f[N + i] = d[i * 4 + 1]; f[2 * N + i] = d[i * 4 + 2]; }           // red, green, blue, 0…255
    const r = await PJ.AIMask.runModel({ model: REC.model, file: REC.file, input: f, dims: [1, 3, n, n] });
    return unit(r.data);
  }
  function unit(v) {
    let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    s = Math.sqrt(s) || 1;
    const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
    return o;
  }
  /* the numbers are kept as 8-bit values (only their direction matters) */
  function pack(v) {
    let mx = 0; for (let i = 0; i < v.length; i++) mx = Math.max(mx, Math.abs(v[i]));
    let s = '';
    for (let i = 0; i < v.length; i++) s += String.fromCharCode(Math.round(v[i] / (mx || 1) * 127) + 128);
    return btoa(s);
  }
  const unpacked = new Map();
  function vec(face) {
    let v = unpacked.get(face.v);
    if (!v) {
      const s = atob(face.v); v = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) v[i] = s.charCodeAt(i) - 128;
      v = unit(v);
      if (unpacked.size > 20000) unpacked.clear();
      unpacked.set(face.v, v);
    }
    return v;
  }
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  /* ---------------- looking through photos ---------------- */
  const canScan = (p) => p && p.kind !== 'video' && !p.missing;
  const scanned = (p) => p.facesV === VERSION;
  /* The photo turned by a number of quarter turns clockwise, and points taken there and back.
     Faces are looked for with the photo upright (the networks expect that) but kept in the photo's own frame. */
  function turned(base, a) {
    if (!a) return base;
    const W = base.width, H = base.height, c = PJ.Decode.makeCanvas(a === 2 ? W : H, a === 2 ? H : W), x = c.getContext('2d');
    if (a === 1) x.setTransform(0, 1, -1, 0, H, 0); else if (a === 2) x.setTransform(-1, 0, 0, -1, W, H); else x.setTransform(0, -1, 1, 0, 0, W);
    x.drawImage(base, 0, 0);
    return c;
  }
  const toTurned = (a, x, y, W, H) => a === 1 ? [H - y, x] : a === 2 ? [W - x, H - y] : a === 3 ? [y, W - x] : [x, y];
  const fromTurned = (a, x, y, W, H) => a === 1 ? [y, H - x] : a === 2 ? [W - x, H - y] : a === 3 ? [W - y, x] : [x, y];
  /** The photo as developed, in its own frame, plus the quarter turns to try so that faces stand upright. */
  async function upright(photo) {
    const res = await PJ.Engine.render(photo, P.defaultSettings(), 'proxy', {}, 0, 'any');
    if (!res) throw new Error('The photo could not be rendered');
    const base = PJ.Engine.toCanvas(res), t = (((photo.settings.geo.orient || 0) % 4) + 4) % 4;
    return { base, turns: [...new Set([t, 0, (4 - t) % 4, 2])] };
  }
  async function saveCrop(face, crop) {
    if (!API.hasThumbStore || !API.saveThumb) return;
    try {
      const blob = crop.convertToBlob ? await crop.convertToBlob({ type: 'image/jpeg', quality: 0.82 }) : await new Promise(r => crop.toBlob(r, 'image/jpeg', 0.82));
      face.t = Cat.uid('fc');
      await API.saveThumb(face.t, new Uint8Array(await blob.arrayBuffer()));
    } catch (e) { delete face.t; }
  }
  /** Find and describe the faces of one photo; stores them on the photo. Resolves to the number found. */
  async function scanPhoto(photo) {
    const { base, turns } = await upright(photo), W = base.width, H = base.height;
    let src = base, a = 0, found = [];
    for (const t of turns) { const c = turned(base, t), f = await detect(c); if (f.length) { src = c; a = t; found = f; break; } }
    const faces = [];
    const old = photo.faces || [];
    for (const f of found) {
      if (f.w < MIN_FACE) continue;
      const crop = aligned(src, f), v = await embed(crop);
      const p0 = fromTurned(a, f.x, f.y, W, H), p1 = fromTurned(a, f.x + f.w, f.y + f.h, W, H);
      const face = { b: [Math.min(p0[0], p1[0]) / W, Math.min(p0[1], p1[1]) / H, Math.abs(p1[0] - p0[0]) / W, Math.abs(p1[1] - p0[1]) / H].map(n => +n.toFixed(4)), q: +f.score.toFixed(3), v: pack(v) };
      // a face that was already known here keeps its name
      const was = old.find(o => o.p || o.x ? iou(o.b, face.b) > 0.5 : false);
      if (was) { if (was.p) face.p = was.p; if (was.x) face.x = true; }
      await saveCrop(face, crop);
      faces.push(face);
    }
    // faces marked by hand stay, unless the detector now finds them itself
    for (const o of old) if (o.m && !faces.some(f => iou(f.b, o.b) > 0.4)) faces.push(o);
    photo.faces = faces; photo.facesV = VERSION;
    if (!faces.length) delete photo.faces;
    return faces.length;
  }
  function iou(a, b) {
    const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy;
    return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
  }
  /**
   * Look through photos that have not been looked at yet (all of them with again = true).
   * onProgress(done, total, photo); stop by setting ctl.stop. Resolves to { photos, faces, failed }.
   */
  async function scan(photos, onProgress, ctl, again) {
    const list = photos.filter(p => canScan(p) && (again || !scanned(p)));
    const out = { photos: 0, faces: 0, failed: 0, total: list.length };
    for (let i = 0; i < list.length; i++) {
      if (ctl && ctl.stop) break;
      onProgress && onProgress(i, list.length, list[i]);
      try { out.faces += await scanPhoto(list[i]); out.photos++; }
      catch (e) {
        out.failed++;
        console.warn('faces: ' + list[i].name + ': ' + (e && e.message));
        if (/not part of this build|could not be started/.test(String(e && e.message))) { out.error = e.message; break; }   // no model: every photo would fail the same way
      }
      if (i % 20 === 19) Cat.scheduleSave();
    }
    Cat.scheduleSave();
    Cat.events.emit('people');
    return out;
  }

  /**
   * A face the detector missed, marked by hand: box = [x, y, w, h] as fractions of the photo's own frame.
   * It is described like any other face (eyes, nose and mouth are assumed where they usually sit in a box).
   */
  async function addFace(photo, box) {
    const { base, turns } = await upright(photo), W = base.width, H = base.height, a = turns[0], src = turned(base, a);
    const c0 = toTurned(a, box[0] * W, box[1] * H, W, H), c1 = toTurned(a, (box[0] + box[2]) * W, (box[1] + box[3]) * H, W, H);
    const x = Math.min(c0[0], c1[0]), y = Math.min(c0[1], c1[1]), w = Math.abs(c1[0] - c0[0]), h = Math.abs(c1[1] - c0[1]);
    if (w < 8 || h < 8) throw new Error('That box is too small to be a face');
    const f = { x, y, w, h, pts: [[0.3, 0.42], [0.7, 0.42], [0.5, 0.62], [0.36, 0.8], [0.64, 0.8]].map(p => [x + p[0] * w, y + p[1] * h]) };
    const crop = aligned(src, f), v = await embed(crop);
    const face = { b: box.map(n => +n.toFixed(4)), q: 1, v: pack(v), m: true };
    await saveCrop(face, crop);
    (photo.faces || (photo.faces = [])).push(face);
    changed();
    return face;
  }
  function removeFace(photo, face) {
    photo.faces = (photo.faces || []).filter(f => f !== face);
    if (!photo.faces.length) delete photo.faces;
    changed();
  }
  /** The faces of a photo, looking for them first if that has not been done: [{ face, name }], left to right. */
  async function facesIn(photo) {
    if (!scanned(photo)) { await scanPhoto(photo); Cat.scheduleSave(); }
    return (photo.faces || []).filter(f => !f.x).slice().sort((p, q) => p.b[0] - q.b[0]).map(f => ({ face: f, name: f.p && person(f.p) ? person(f.p).name : '' }));
  }

  /* ---------------- people ---------------- */
  const people = () => (Cat.state.people || (Cat.state.people = []));
  const person = (id) => people().find(x => x.id === id) || null;
  /** Every face of the catalog as { photo, face }. */
  function allFaces() {
    const out = [];
    for (const p of Cat.state.photos) for (const f of p.faces || []) out.push({ photo: p, face: f });
    return out;
  }
  function facesOf(id) { return allFaces().filter(e => e.face.p === id); }
  function photosOf(id) { return Cat.state.photos.filter(p => (p.faces || []).some(f => f.p === id)); }
  const unnamedCount = () => allFaces().filter(e => !e.face.p && !e.face.x).length;
  function centre(entries) {
    const c = new Float32Array(128);
    for (const e of entries) { const v = vec(e.face); for (let i = 0; i < 128; i++) c[i] += v[i]; }
    return unit(c);
  }
  /**
   * The faces without a name, in groups that look like one person each (largest first):
   * [{ faces: [{ photo, face }], suggest: person | null }].
   */
  function groups() {
    const todo = allFaces().filter(e => !e.face.p && !e.face.x && e.face.v).sort((a, b) => b.face.q - a.face.q);
    const cl = [];                       // { sum, c, faces }
    const add = (g, e) => { const v = vec(e.face); for (let i = 0; i < 128; i++) g.sum[i] += v[i]; g.c = unit(g.sum); g.faces.push(e); };
    for (const e of todo) {
      const v = vec(e.face); let best = null, bs = SAME;
      for (const g of cl) { const s = dot(v, g.c); if (s >= bs) { bs = s; best = g; } }
      if (!best) { best = { sum: new Float32Array(128), c: null, faces: [] }; cl.push(best); }
      add(best, e);
    }
    // groups that turned out to be the same person
    for (let again = true; again;) {
      again = false;
      for (let i = 0; i < cl.length && !again; i++) for (let j = i + 1; j < cl.length; j++) {
        if (dot(cl[i].c, cl[j].c) >= MERGE) { for (const e of cl[j].faces) add(cl[i], e); cl.splice(j, 1); again = true; break; }
      }
    }
    const named = people().map(p => ({ p, f: facesOf(p.id) })).filter(x => x.f.length).map(x => ({ p: x.p, c: centre(x.f) }));
    return cl.sort((a, b) => b.faces.length - a.faces.length).map(g => {
      let suggest = null, bs = SUGGEST;
      for (const n of named) { const s = dot(g.c, n.c); if (s >= bs) { bs = s; suggest = n.p; } }
      return { faces: g.faces, suggest };
    });
  }
  /** Name faces: an existing person of that name (whatever the capitals) gets them, otherwise a new one is made. */
  function name(entries, text) {
    const nm = String(text || '').trim();
    if (!nm || !entries.length) return null;
    let who = people().find(x => x.name.toLowerCase() === nm.toLowerCase());
    if (!who) { who = { id: Cat.uid('pe'), name: nm }; people().push(who); }
    for (const e of entries) { e.face.p = who.id; delete e.face.x; }
    changed();
    return who;
  }
  function ignore(entries) { for (const e of entries) { delete e.face.p; e.face.x = true; } changed(); }
  function unname(entries) { for (const e of entries) delete e.face.p; changed(); }
  function rename(id, text) {
    const who = person(id), nm = String(text || '').trim();
    if (!who || !nm) return;
    const other = people().find(x => x !== who && x.name.toLowerCase() === nm.toLowerCase());
    if (other) { for (const e of facesOf(id)) e.face.p = other.id; Cat.state.people = people().filter(x => x !== who); }   // two names for one person: joined
    else who.name = nm;
    changed();
  }
  function remove(id) {
    for (const e of facesOf(id)) delete e.face.p;
    Cat.state.people = people().filter(x => x.id !== id);
    changed();
  }
  /** The names of the people in a photo (for search). */
  function namesIn(photo) {
    const out = [];
    for (const f of photo.faces || []) { const who = f.p && person(f.p); if (who && !out.includes(who.name)) out.push(who.name); }
    return out;
  }
  function changed() { Cat.scheduleSave(); Cat.events.emit('people'); }

  global.PJ.Faces = {
    scan, scanPhoto, scanned, canScan, addFace, removeFace, facesIn, groups, people, person, facesOf, photosOf, unnamedCount, name, ignore, unname, rename, remove, namesIn,
    faceUrl: (face) => face.t && API.thumbUrl ? API.thumbUrl(face.t, 1) : '',
    _test: { detect, aligned, embed, similarity, pack, vec, dot, REC, DET }
  };
})(window);
