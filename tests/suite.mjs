// photos.jpeg — test suite. Started by tests/run.ps1, which launches the app on a scratch
// catalog and passes its debugging port. Each test runs code inside the editor and checks
// what comes back. Exit code 0 = everything passed.
const port = process.env.PJ_TEST_PORT || 9344, media = process.env.PJ_TEST_MEDIA, outDir = process.env.PJ_TEST_OUT;
const filter = (process.env.PJ_TEST_FILTER || '').toLowerCase(), phase = process.argv[2] || 'main';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
let seq = 0; const waits = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++seq; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
/** Run a function inside the editor and return its (JSON) result. */
async function page(fn, ...args) {
  const r = await send('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text);
  return r.result.result.value;
}
const assert = (cond, what) => { if (!cond) throw new Error(what); };
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: expected about ${b}, got ${a}`);

const tests = [];
const test = (name, fn, when = 'main') => tests.push({ name, fn, when });

// the editor reports its own errors here; any that appear during a test fail it
await page(() => { if (!window.__testErrors) { window.__testErrors = []; window.addEventListener('error', e => window.__testErrors.push(e.message)); window.addEventListener('unhandledrejection', e => window.__testErrors.push(String(e.reason && e.reason.message || e.reason))); } });

test('app starts isolated, with workers and GPU', async () => {
  const s = await page(() => ({ platform: PJ.API.platform, iso: crossOriginIsolated, shared: PJ.Pipeline.SHARED, workers: PJ.Engine.pool.workers.length, gpu: PJ.Engine.gpuReady(), version: PJ.API.appVersion }));
  assert(s.platform === 'windows' && s.iso && s.shared, 'not cross-origin isolated: ' + JSON.stringify(s));
  assert(s.workers >= 2, 'no worker pool');
  return `${s.workers} workers, GPU previews ${s.gpu ? 'on' : 'off'}, version ${s.version}`;
});

test('import the test media', async () => {
  const r = await page(async (dir) => {
    const descs = await PJ.API.scanPaths([dir]);
    PJ.Catalog.addPhotos(descs).forEach(p => PJ.Engine.queueThumb(p));
    PJ.App.library.setSource('all'); PJ.App.refresh();
    for (let i = 0; i < 300; i++) { await new Promise(r => setTimeout(r, 100)); if (PJ.Catalog.state.photos.every(p => p.thumbV || p.missing)) break; }
    return PJ.Catalog.state.photos.map(p => ({ name: p.name, kind: p.kind, thumb: p.thumbV, missing: !!p.missing, w: p.width }));
  }, media);
  assert(r.length >= 3, 'nothing imported');
  const bad = r.filter(p => p.missing || !p.thumb);
  assert(!bad.length, 'no thumbnail for: ' + bad.map(p => p.name).join(', '));
  return `${r.length} items, all with thumbnails`;
});

test('every item opens in Develop', async () => {
  const r = await page(async () => {
    const App = PJ.App, V = App.viewer, out = [];
    App.setModule('develop');
    for (const p of PJ.Catalog.state.photos) {
      App.selectIds([p.id]);
      let ok = false;
      for (let i = 0; i < 300; i++) { await new Promise(r => setTimeout(r, 50)); const a = V.st.after; if (V.st.photo === p && a && a.level === 'proxy' && !V.st.busy) { ok = true; break; } }
      out.push({ name: p.name, ok });
    }
    App.setModule('library');
    return out;
  });
  const bad = r.filter(x => !x.ok);
  assert(!bad.length, 'did not render: ' + bad.map(x => x.name).join(', '));
  return `${r.length} rendered`;
});

test('edit, undo, redo', async () => {
  const r = await page(() => {
    const Cat = PJ.Catalog, p = Cat.state.photos.find(x => x.name === 'gradient.jpg'), h0 = p.history.length;
    p.settings.exposure = 0.7; p.settings.contrast = 20; Cat.commit(p, 'Test edit');
    const after = p.settings.exposure; Cat.undo(p); const undone = p.settings.exposure; Cat.redo(p);
    const redone = p.settings.exposure; Cat.undo(p);
    return { added: p.history.length - h0, after, undone, redone };
  });
  assert(r.added === 1 && r.after === 0.7 && r.undone === 0 && r.redone === 0.7, JSON.stringify(r));
});

test('GPU preview matches the CPU render', async () => {
  const r = await page(async () => {
    const E = PJ.Engine, p = PJ.Catalog.state.photos.find(x => x.name === 'gradient.jpg');
    await E.ensureSource(p);
    const s = JSON.parse(JSON.stringify(p.settings)); s.exposure = 0.5; s.contrast = 25; s.vibrance = 30; s.lens.distortion = 15; s.transform.vertical = 12;
    const g = E.renderGPU(p, s, {}); if (!g) return { skipped: true };
    const c = await E.render(p, s, 'proxy', {}, 0);
    const px = (cv) => { const t = document.createElement('canvas'); t.width = cv.width; t.height = cv.height; const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(cv, 0, 0); return x.getImageData(0, 0, cv.width, cv.height).data; };
    const a = px(E.toCanvas(c)), b = px(g.canvas); let sum = 0, n = 0;
    for (let i = 0; i < a.length; i += 44) { sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; }
    return { mean: sum / n, same: c.width === g.width && c.height === g.height };
  });
  if (r.skipped) return 'skipped (no hardware WebGL 2)';
  assert(r.same, 'sizes differ'); assert(r.mean < 1.5, `renders differ by ${r.mean.toFixed(2)} levels on average`);
  return `mean difference ${r.mean.toFixed(2)} of 255`;
});

test('export: JPEG, PNG, WebP, TIFF 8 and 16 bit, colour profiles', async () => {
  const r = await page(async (dir) => {
    const A = PJ.API, X = PJ.Exporter, p = PJ.Catalog.state.photos.find(x => x.name === 'gradient.jpg'), out = {};
    const exp = async (o) => (await X.exportPhotos([p], Object.assign({}, X.DEFAULTS, { dest: 'choose', folder: dir, reveal: false, conflict: 'overwrite' }, o)))[0];
    const has = (b, t) => { const k = Array.from(t, c => c.charCodeAt(0)); outer: for (let i = 0; i < Math.min(b.length, 150000) - k.length; i++) { for (let j = 0; j < k.length; j++) if (b[i + j] !== k[j]) continue outer; return true; } return false; };
    for (const fmt of ['jpeg', 'png', 'webp']) {
      const e = await exp({ format: fmt, template: 'x-' + fmt, resize: 'long', long: 1000 });
      if (!e.ok) { out[fmt] = e.error; continue; }
      const b = await A.readFile(e.path), bm = await createImageBitmap(new Blob([b]));
      out[fmt] = { w: bm.width, h: bm.height, icc: fmt === 'jpeg' ? has(b, 'ICC_PROFILE') : fmt === 'png' ? has(b, 'iCCP') : null };
    }
    const t8 = await exp({ format: 'tiff', tiffBits: 8, template: 'x-t8' }), t16 = await exp({ format: 'tiff', tiffBits: 16, template: 'x-t16' });
    out.t8 = t8.ok ? await A.fileSize(t8.path) : t8.error; out.t16 = t16.ok ? await A.fileSize(t16.path) : t16.error;
    const p3 = await exp({ format: 'jpeg', colorSpace: 'p3', quality: 95, template: 'x-p3', resize: 'long', long: 1000 }), ref = await exp({ format: 'jpeg', quality: 95, template: 'x-ref', resize: 'long', long: 1000 });
    const mean = async (path) => { const bm = await createImageBitmap(new Blob([await A.readFile(path)])); const c = new OffscreenCanvas(32, 32), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bm, 0, 0, 32, 32); const d = x.getImageData(0, 0, 32, 32).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4 * 3); };
    out.p3Shift = Math.abs(await mean(p3.path) - await mean(ref.path));
    return out;
  }, outDir);
  for (const f of ['jpeg', 'png', 'webp']) { assert(typeof r[f] === 'object', `${f}: ${r[f]}`); assert(r[f].w === 1000, `${f} is ${r[f].w} wide, expected 1000`); }
  assert(r.jpeg.icc && r.png.icc, 'colour profile missing');
  near(r.t8, 3000 * 2000 * 3, 5000, '8-bit TIFF size'); near(r.t16, 3000 * 2000 * 6, 5000, '16-bit TIFF size');
  assert(r.p3Shift < 3, `Display P3 export is ${r.p3Shift.toFixed(1)} levels off after colour management`);
});

test('export: EXIF is written for sources without a JPEG header', async () => {
  const r = await page(() => {
    const app1 = PJ.Exporter.buildExifApp1({ exif: { make: 'TestCam', model: 'T-1', lens: 'Test 35mm f/2', iso: 800, exposureTime: 1 / 125, fNumber: 2.8, focalLength: 35, captureTime: '2026-05-04T10:20:30', gps: { lat: 48.5, lon: -122.25 } } });
    const jpeg = new Uint8Array(4 + app1.length); jpeg.set([0xff, 0xd8]); jpeg.set(app1, 2); jpeg.set([0xff, 0xd9], 2 + app1.length);
    return PJ.Decode.parseExif(jpeg);
  });
  assert(r.make === 'TestCam' && r.model === 'T-1' && r.iso === 800 && r.focalLength === 35 && r.captureTime === '2026-05-04T10:20:30', JSON.stringify(r));
  near(r.exposureTime, 1 / 125, 1e-6, 'exposure time'); near(r.gps.lat, 48.5, 1e-3, 'latitude'); near(r.gps.lon, -122.25, 1e-3, 'longitude');
});

test('video: H.264 and HEVC export are valid MP4 files', async () => {
  const r = await page(async (dir) => {
    const A = PJ.API, X = PJ.Exporter, p = PJ.Catalog.state.photos.find(x => x.name === 'clip.mp4'), out = {};
    if (!p) return { skipped: true };
    for (const codec of ['avc', 'hevc']) {
      const e = (await X.exportPhotos([p], Object.assign({}, X.DEFAULTS, { dest: 'choose', folder: dir, reveal: false, conflict: 'overwrite', vcodec: codec, template: 'v-' + codec })))[0];
      if (!e.ok) { out[codec] = { error: e.error }; continue; }
      const m = await PJ.MP4.demux(await PJ.Video.reader(e.path));
      out[codec] = { codec: m.video.codec, frames: m.video.frameCount, audio: !!m.audio, warnings: e.warnings };
    }
    return out;
  }, outDir);
  if (r.skipped) return 'skipped (no ffmpeg to make the test clip)';
  assert(r.avc.codec && r.avc.codec.startsWith('avc1') && r.avc.frames === 90 && r.avc.audio, 'H.264: ' + JSON.stringify(r.avc));
  assert(r.hevc.codec && (r.hevc.codec.startsWith('hvc1') || r.hevc.codec.startsWith('avc1')) && r.hevc.frames === 90, 'HEVC: ' + JSON.stringify(r.hevc));
  return `H.264 ${r.avc.frames} frames with sound; second export ${r.hevc.codec.slice(0, 4)}`;
});

test('video: ProRes and MKV go through optimized media', async () => {
  const r = await page(async () => {
    const caps = await PJ.API.videoTool('capabilities'); if (!caps.ffmpeg) return { skipped: true };
    const out = {};
    for (const name of ['prores.mov', 'clip.mkv']) { const p = PJ.Catalog.state.photos.find(x => x.name === name); if (!p) return { skipped: true }; out[name] = { w: p.width, proxy: !!(p.video && p.video.proxy), missing: !!p.missing }; }
    out.encoder = (await PJ.API.videoTool('capabilities')).encoder;
    return out;
  });
  if (r.skipped) return 'skipped (no ffmpeg)';
  assert(r['prores.mov'].w === 1280 && r['prores.mov'].proxy && !r['prores.mov'].missing, 'ProRes: ' + JSON.stringify(r['prores.mov']));
  assert(r['clip.mkv'].w === 1280 && !r['clip.mkv'].missing, 'MKV: ' + JSON.stringify(r['clip.mkv']));
  return `encoder: ${r.encoder}`;
});

test('lens database: lookup, distortion, vignetting, chromatic aberration', async () => {
  const r = await page(async () => {
    const L = PJ.Lens, T = L._test, db = await L.database();
    const hit = T.findLens(db, { make: 'NIKON CORPORATION', model: 'NIKON 1 J1', lens: '1 NIKKOR VR 10-30mm f/3.5-5.6', focalLength: 10, fNumber: 3.5 });
    const canon = T.findLens(db, { make: 'Canon', model: 'Canon EOS 5D Mark III', lens: 'EF24-70mm f/2.8L USM', focalLength: 24, fNumber: 2.8 });
    return {
      lenses: db.lenses.length, j1: hit && hit.lens.m, d: hit && T.distortionAt(hit.lens, 10, hit.camera[3]), t: hit && T.tcaAt(hit.lens, 10, hit.camera[3]),
      canon: canon && canon.lens.m, v: canon && T.vignettingAt(canon.lens, 24, 2.8, canon.camera[3]), none: !!T.findLens(db, { make: 'X', model: 'Y', lens: 'No Such 12-99mm f/9', focalLength: 20 })
    };
  });
  assert(r.lenses > 1000, 'database not loaded'); assert(r.j1 === '1 Nikkor VR 10-30mm f/3.5-5.6', 'wrong lens: ' + r.j1);
  near(r.d.pr, 0.5547, 0.001, 'distortion unit radius'); assert(r.d.p2 < 0, 'barrel distortion expected at 10 mm'); assert(r.t && r.t.tvr > 1, 'no chromatic aberration data');
  assert(r.canon === 'Canon EF 24-70mm f/2.8L USM' && r.v && r.v.v1 < 0, 'Canon lens or its vignetting not found'); assert(!r.none, 'an unknown lens matched something');
});

test('lens profile: both renderers agree, no empty border', async () => {
  const r = await page(async () => {
    const E = PJ.Engine, P = PJ.Pipeline, p = PJ.Catalog.state.photos.find(x => x.name === 'gradient.jpg');
    await E.ensureSource(p);
    const s = P.defaultSettings(); Object.assign(s.lens, { pr: 0.5547, p1: 0.0099, p2: -0.0271, p3: 0.006, vq: 1, v1: -0.6, v2: 0.1, v3: 0, tr: 0.5547, tvr: 1.003, tvb: 0.998 });
    s.transform.scale = PJ.Lens._test.fillScale(s.lens, 1.5);
    const c = await E.render(p, s, 'proxy', {}, 0), g = E.renderGPU(p, s, {});
    const d = c.data; let bg = 0; for (let x = 0; x < c.width; x += 3) for (const y of [0, c.height - 1]) { const i = (y * c.width + x) * 4; if (Math.abs(d[i] - 28) < 2 && Math.abs(d[i + 1] - 28) < 2 && Math.abs(d[i + 2] - 28) < 2) bg++; }
    if (!g) return { bg, skipped: true };
    const t = document.createElement('canvas'); t.width = g.width; t.height = g.height; const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(g.canvas, 0, 0); const b = x.getImageData(0, 0, g.width, g.height).data;
    let sum = 0, n = 0; for (let i = 0; i < d.length; i += 44) { sum += Math.abs(d[i] - b[i]) + Math.abs(d[i + 1] - b[i + 1]) + Math.abs(d[i + 2] - b[i + 2]); n += 3; }
    return { bg, mean: sum / n };
  });
  assert(r.bg === 0, `${r.bg} background pixels along the edges`);
  if (!r.skipped) assert(r.mean < 1.5, `renderers differ by ${r.mean.toFixed(2)}`);
});

test('auto upright straightens a tilted building', async () => {
  const r = await page(async () => {
    const E = PJ.Engine, P = PJ.Pipeline, U = PJ.Upright, p = PJ.Catalog.state.photos.find(x => x.name === 'building.jpg');
    await E.ensureSource(p);
    const s = P.defaultSettings(); s.transform.vertical = 28; s.transform.rotate = 2; s.transform.scale = 130;
    const tilted = await E.render(p, s, 'draft', {}, 0);
    const before = U._test.fitConvergence(U._test.findVerticals(tilted).lines, tilted.width);
    const straight = await E.render(p, P.defaultSettings(), 'draft', {}, 0);
    const after = U._test.fitConvergence(U._test.findVerticals(straight).lines, straight.width);
    const half = Math.max(tilted.width, tilted.height) / 2;
    return { before: before && before.a * half, lean: before && Math.atan(before.b) * 180 / Math.PI, after: after && after.a * half, lines: before && before.n };
  });
  assert(r.lines >= 8, 'too few lines found'); assert(Math.abs(r.before) > 0.05, 'convergence not detected');
  near(Math.abs(r.lean), 2, 0.4, 'lean of the tilted building, in degrees'); assert(Math.abs(r.after) < 0.01, `the straight building measured as converging (${r.after})`);
});

test('Sky mask: found, stored outside the settings, same on both renderers', async () => {
  const r = await page(async () => {
    const E = PJ.Engine, P = PJ.Pipeline, M = PJ.AIMask, p = PJ.Catalog.state.photos.find(x => x.name === 'building.jpg');
    if (!M) return { skipped: true };
    await E.ensureSource(p);
    let fields;
    try { fields = await M.create(p, 'sky'); } catch (e) { return { error: e.message }; }
    const map = P.getMaskMap(fields.map.id); let sum = 0, top = 0, bottom = 0;
    for (let i = 0; i < map.data.length; i++) { sum += map.data[i]; if (i < map.data.length * 0.1) top += map.data[i]; if (i > map.data.length * 0.9) bottom += map.data[i]; }
    const s = P.defaultSettings();
    s.masks = [Object.assign({ id: 'mk_test', type: 'brush', name: 'Sky', visible: true, invert: false, amount: 100, lumMin: 0, lumMax: 100, lumSmooth: 20, adj: P.defaultLocalAdj(), dabs: [] }, fields)];
    s.masks[0].adj.exposure = -1.5;
    const c = await E.render(p, s, 'proxy', {}, 0), plain = await E.render(p, P.defaultSettings(), 'proxy', {}, 0), g = E.renderGPU(p, s, {});
    let changed = 0, n = 0, diff = 0, gp = null;
    if (g) { const t = document.createElement('canvas'); t.width = g.width; t.height = g.height; const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(g.canvas, 0, 0); gp = x.getImageData(0, 0, g.width, g.height).data; }
    for (let i = 0; i < c.data.length; i += 44) { n++; if (Math.abs(c.data[i] - plain.data[i]) > 8) changed++; if (gp) diff += Math.abs(c.data[i] - gp[i]) + Math.abs(c.data[i + 1] - gp[i + 1]) + Math.abs(c.data[i + 2] - gp[i + 2]); }
    const disk = await fetch(PJ.API.thumbUrl('mm_' + fields.map.id, 1));
    const centre = map.data[(map.h >> 1) * map.w + (map.w >> 1)] / 255;
    return { centre, cover: sum / map.data.length / 255, top: top / (map.data.length * 0.1) / 255, bottom: bottom / (map.data.length * 0.1) / 255, settingsBytes: JSON.stringify(s.masks).length, darkened: changed / n, gpuDiff: gp ? diff / n / 3 : null, onDisk: disk.ok };
  });
  if (r.skipped) return 'skipped';
  assert(!r.error, r.error);
  assert(r.cover > 0.1 && r.cover < 0.7, `sky covers ${(r.cover * 100).toFixed(0)}% of the building picture`);
  // the test picture is a building against a plain sky: sky along the top and down both sides, none on the building
  assert(r.top > 0.8 && r.centre < 0.2, `sky should be along the top and not on the building (top ${r.top.toFixed(2)}, middle ${r.centre.toFixed(2)})`);
  assert(r.settingsBytes < 2000, `the mask adds ${r.settingsBytes} bytes to the settings`);
  assert(r.darkened > 0.08, 'the mask had no effect on the render'); assert(r.onDisk, 'the mask map was not stored');
  if (r.gpuDiff !== null) assert(r.gpuDiff < 1.5, `renderers differ by ${r.gpuDiff.toFixed(2)}`);
  return `sky covers ${(r.cover * 100).toFixed(0)}%`;
});

test('noise reduction removes noise and keeps edges', async () => {
  const r = await page(() => {
    // a flat grey field with a hard edge down the middle, plus noise of a known strength
    const P = PJ.Pipeline, w = 256, h = 256, clean = new Float32Array(w * h), noisy = new Float32Array(w * h);
    let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < w * h; i++) { clean[i] = (i % w) < w / 2 ? 0.3 : 0.6; noisy[i] = clean[i] + (rnd() + rnd() + rnd() - 1.5) * 0.06; }
    const out = P.waveletDenoise(noisy, w, h, 0.5, 0.5, 1);
    const err = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - clean[i]) ** 2; return Math.sqrt(s / a.length); };
    // the edge: the step between the two columns either side of the middle
    let step = 0; for (let y = 0; y < h; y++) step += out[y * w + w / 2 + 1] - out[y * w + w / 2 - 2]; step /= h;
    return { before: err(noisy), after: err(out), step };
  });
  assert(r.after < r.before * 0.5, `noise went from ${r.before.toFixed(4)} to only ${r.after.toFixed(4)}`);
  // at this strength a hard edge keeps at least five sixths of its contrast one pixel either side (a blur of the same strength keeps about half)
  assert(r.step > 0.25, `the edge was softened: a step of 0.30 became ${r.step.toFixed(3)}`);
  return `noise ${r.before.toFixed(3)} → ${r.after.toFixed(3)}, edge step ${r.step.toFixed(2)} of 0.30`;
});

test('masks: colour range and intersect / subtract, same on both renderers', async () => {
  const r = await page(async () => {
    const E = PJ.Engine, P = PJ.Pipeline, Cat = PJ.Catalog, p = Cat.state.photos.find(x => x.name === 'gradient.jpg');
    await E.ensureSource(p);
    const px = (cv) => { const t = document.createElement('canvas'); t.width = cv.width; t.height = cv.height; const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(cv, 0, 0); return x.getImageData(0, 0, cv.width, cv.height).data; };
    const mk = (o) => Object.assign({ id: Cat.uid('mk_'), type: 'radial', name: 'm', visible: true, invert: false, amount: 100, lumMin: 0, lumMax: 100, lumSmooth: 20, cx: 0.5, cy: 0.33, rx: 0.9, ry: 0.9, feather: 10, adj: Object.assign(P.defaultLocalAdj(), { exposure: 1.2 }) }, o);
    const base = P.defaultSettings(), plain = (await E.render(p, base, 'proxy', {}, 0)).data;
    const run = async (masks) => {
      const s = P.normalizeSettings(Object.assign(P.clone(base), { masks })), c = (await E.render(p, s, 'proxy', {}, 0)).data, g = E.renderGPU(p, s, {});
      const gp = g ? px(g.canvas) : null; let changed = 0, n = 0, diff = 0;
      for (let i = 0; i < c.length; i += 4) { n++; if (Math.abs(c[i] - plain[i]) + Math.abs(c[i + 1] - plain[i + 1]) + Math.abs(c[i + 2] - plain[i + 2]) > 9) changed++; if (gp) diff += (Math.abs(c[i] - gp[i]) + Math.abs(c[i + 1] - gp[i + 1]) + Math.abs(c[i + 2] - gp[i + 2])) / 3; }
      return { share: changed / n, gpu: gp ? diff / n : null };
    };
    const small = mk({ rx: 0.2, ry: 0.2, adj: P.defaultLocalAdj() });
    return {
      all: await run([mk({})]), orange: await run([mk({ colOn: true, colHue: 30, colRange: 30 })]),
      inside: await run([mk({ limit: { id: small.id, mode: 'intersect' } }), small]), outside: await run([mk({ limit: { id: small.id, mode: 'subtract' } }), small])
    };
  });
  assert(r.all.share > 0.95, 'the plain mask should cover the photo');
  assert(r.orange.share > 0.03 && r.orange.share < 0.9, `a colour-limited mask changed ${(r.orange.share * 100).toFixed(0)}% of the photo`);
  assert(r.inside.share < 0.35 && r.outside.share > 0.6 && Math.abs(r.inside.share + r.outside.share - r.all.share) < 0.12, `intersect ${r.inside.share.toFixed(2)} + subtract ${r.outside.share.toFixed(2)} should make up the whole ${r.all.share.toFixed(2)}`);
  for (const k of ['all', 'orange', 'inside', 'outside']) if (r[k].gpu !== null) assert(r[k].gpu < 1.5, `${k}: renderers differ by ${r[k].gpu.toFixed(2)}`);
  return `colour range keeps ${(r.orange.share * 100).toFixed(0)}%, intersect ${(r.inside.share * 100).toFixed(0)}%, subtract ${(r.outside.share * 100).toFixed(0)}%`;
});

test('a pasted Sky mask is found again in the other photo', async () => {
  const r = await page(async () => {
    const Cat = PJ.Catalog, M = PJ.AIMask, P = PJ.Pipeline, E = PJ.Engine;
    const a = Cat.state.photos.find(x => x.name === 'building.jpg'), b = Cat.state.photos.find(x => x.name === 'gradient.jpg');
    await E.ensureSource(a); await E.ensureSource(b);
    const f = await M.create(a, 'sky');
    const mask = Object.assign({ id: Cat.uid('mk_'), type: 'brush', dabs: [], visible: true, amount: 100, adj: P.defaultLocalAdj() }, f);
    const keep = P.clone(b.settings);
    b.settings = Cat.applyGroups(b.settings, { masks: [mask] }, ['masks']);
    const res = await M.retarget(b), m = b.settings.masks[0];
    const out = { redone: res.redone, ownMap: m.map.id !== f.map.id && m.map.of === b.id, again: (await M.retarget(b)).redone, seen: (await M.describe(a)).map(d => d.label) };
    b.settings = keep;
    return out;
  });
  assert(r.redone === 1 && r.ownMap && r.again === 0, JSON.stringify(r));
  assert(r.seen.includes('sky') || r.seen.includes('building'), 'the scene model saw: ' + r.seen.join(', '));
  return 'keyword suggestions for the building: ' + r.seen.join(', ');
});

test('smart collections follow the catalog', async () => {
  const r = await page(() => {
    const Cat = PJ.Catalog, App = PJ.App, p = Cat.state.photos.find(x => x.name === 'gradient.jpg');
    const c = Cat.addCollection('Four stars', [], { minRating: 4 });
    App.library.setSource('col:' + c.id);
    const before = App.library.visible().length; p.rating = 5; const after = App.library.visible().map(x => x.name);
    Cat.addToCollection(c.id, [p.id]); const manual = c.photoIds.length;
    p.rating = 0; Cat.removeCollection(c.id); App.library.setSource('all');
    return { before, after, manual };
  });
  assert(r.before === 0 && r.after.length === 1 && r.after[0] === 'gradient.jpg' && r.manual === 0, JSON.stringify(r));
});

test('export queue: two jobs run one after the other; JPEG XL', async () => {
  const r = await page(async (dir) => {
    const X = PJ.Exporter, A = PJ.API, p = PJ.Catalog.state.photos.find(x => x.name === 'gradient.jpg');
    const o = (extra) => Object.assign({}, X.DEFAULTS, { dest: 'choose', folder: dir, reveal: false, conflict: 'overwrite', resize: 'long', long: 800 }, extra);
    const a = X.run([p], o({ format: 'jxl', quality: 80, template: 'q-jxl' }), false), b = X.run([p], o({ format: 'jpeg', template: 'q-jpg' }), false);
    const queued = X.queueLength(), blocked = !!document.querySelector('.modal-back');
    await a; await b;
    const sep = String.fromCharCode(92), jxl = await A.readFile(dir + sep + 'q-jxl.jxl'), jpg = await A.fileSize(dir + sep + 'q-jpg.jpg');
    return { queued, blocked, left: X.queueLength(), sig: [jxl[0], jxl[1]], jxl: jxl.length, jpg, failed: [...document.querySelectorAll('.modal')].map(m => m.textContent).filter(t => /errors/.test(t)) };
  }, outDir);
  assert(r.queued === 2 && !r.blocked && r.left === 0, JSON.stringify(r));
  assert(!r.failed.length, r.failed.join(' '));
  assert(r.sig[0] === 0xff && r.sig[1] === 0x0a && r.jxl > 2000, 'not a JPEG XL file: ' + JSON.stringify(r));
  assert(r.jpg > 2000, 'the second job wrote nothing');
  return `JPEG XL ${(r.jxl / 1024).toFixed(0)} KB against JPEG ${(r.jpg / 1024).toFixed(0)} KB`;
});

test('catalog clean-up counts only what nothing refers to', async () => {
  const r = await page(async () => {
    const A = PJ.API, App = PJ.App;
    if (!A.cleanStore) return { skipped: true };
    const u = await A.cleanStore(App.storeKeys(), false, false), none = await A.cleanStore([], false, false);
    return { orphans: u.orphans, thumbs: u.thumbs, removed: u.removed, withoutKeys: none.orphans };
  });
  if (r.skipped) return 'skipped';
  assert(r.removed === 0 && r.thumbs > 0, JSON.stringify(r));
  return `${r.thumbs} files in the store, ${r.orphans} unreferenced`;
});

test('wide colour: unmarked photos render as before, marked ones keep colours beyond sRGB', async () => {
  const r = await page(() => {
    const P = PJ.Pipeline, w = 16, h = 16, dec = P.inputLUT('rawlog');
    // a developed RAW stand-in: codes in Display P3 primaries, with a strong red-orange that sRGB cannot hold
    const p3 = new Uint8ClampedArray(w * h * 4), srgb = new Uint8ClampedArray(w * h * 4), M = P.P3_TO_SRGB;
    for (let i = 0; i < w * h; i++) {
      const c = i % 2 ? [200, 6, 6] : [90 + (i % 7) * 8, 100, 110 - (i % 5) * 6];
      const l = c.map(v => dec[v]);
      const s = [M[0] * l[0] + M[1] * l[1] + M[2] * l[2], M[3] * l[0] + M[4] * l[1] + M[5] * l[2], M[6] * l[0] + M[7] * l[1] + M[8] * l[2]];
      for (let k = 0; k < 3; k++) { p3[i * 4 + k] = c[k]; srgb[i * 4 + k] = Math.round(P.rawLogEncode(Math.max(0, s[k])) * 255); }
      p3[i * 4 + 3] = srgb[i * 4 + 3] = 255;
    }
    const lut = new Float32Array(256); for (let i = 0; i < 256; i++) lut[i] = Math.min(1, dec[i] / 6);
    const go = (data, input, opts) => P.render({ src: { data, width: w, height: h }, settings: P.defaultSettings(), fullLongEdge: w, seed: 1, opts: Object.assign({ srcInput: input }, opts) });
    const old = go(srgb, { lut, matrix: null }, {}), std = go(p3, { lut, matrix: null, space: 'p3' }, {});
    const wideS = go(p3, { lut, matrix: null, space: 'p3' }, { wide: true }), wideP = go(p3, { lut, matrix: null, space: 'p3' }, { wide: true, outSpace: 'p3' });
    const diff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
    const back = wideP.data.slice(); PJ.ICC.convert(back, 'srgb', 4, 255, 'p3');
    // the red pixel, taken back to linear sRGB: a negative channel means it lies outside sRGB
    const lin = [0, 1, 2].map(k => P.toLin(wideP.data[4 + k] / 255)), g = M[3] * lin[0] + M[4] * lin[1] + M[5] * lin[2];
    return { stdVsOld: diff(std.data, old.data), spaces: [std.space, wideS.space, wideP.space].join('/'), backVsWideS: diff(back, wideS.data), wideVsStd: diff(wideP.data, std.data), greenInSrgb: g };
  });
  assert(r.stdVsOld <= 3, `an unmarked photo no longer renders as it did: off by ${r.stdVsOld}`);
  assert(r.spaces === 'srgb/srgb/p3', r.spaces);
  assert(r.backVsWideS <= 1, `narrowing a P3 render to sRGB gives a different picture: ${r.backVsWideS}`);
  assert(r.greenInSrgb < -0.005, `the test colour is not outside sRGB (${r.greenInSrgb})`);
  return `unmarked matches the old rendering within ${r.stdVsOld}; the P3 render holds a colour outside sRGB`;
});

test('content-aware fill continues a pattern and is laid in through its soft edge', async () => {
  const r = await page(async () => {
    const P = PJ.Pipeline, w = 200, h = 160, truth = new Uint8Array(w * h * 3), rgb = new Uint8Array(w * h * 3), mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.sin((x + y * 0.5) / 6) * 60 + 128, o = (y * w + x) * 3; truth[o] = v; truth[o + 1] = v * 0.8 + 20; truth[o + 2] = 255 - v; }
    rgb.set(truth);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - 100, y - 80) < 22) { mask[y * w + x] = 1; rgb[(y * w + x) * 3] = 255; rgb[(y * w + x) * 3 + 1] = 0; rgb[(y * w + x) * 3 + 2] = 255; }
    const wk = new Worker(new URL('js/fillworker.js', location.href).href);
    const out = await new Promise((res, rej) => { wk.onmessage = (e) => e.data.error ? rej(new Error(e.data.error)) : res(e.data.rgb); wk.onerror = (e) => rej(new Error(e.message)); wk.postMessage({ id: 1, w, h, rgb, mask }); });
    wk.terminate();
    let err = 0, n = 0, outside = 0;
    for (let i = 0; i < w * h; i++) { if (mask[i]) { err += Math.abs(out[i * 3] - truth[i * 3]); n++; } else if (out[i * 3] !== truth[i * 3]) outside++; }
    // the piece in a photo: a red patch with a soft-edged alpha over a grey picture
    const W = 64, H = 64, src = new Uint8ClampedArray(W * H * 4).fill(128), map = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const o = (y * 16 + x) * 4; map[o] = 255; map[o + 1] = 0; map[o + 2] = 0; map[o + 3] = Math.hypot(x - 7.5, y - 7.5) < 5 ? 255 : 0; }
    P.setMaskMap('cf_test', 16, 16, map);
    const res = P.applySpots(src, W, H, [{ mode: 'fill', x: 0.5, y: 0.5, r: 0.05, pts: [[0.5, 0.5]], opacity: 100, patch: { id: 'cf_test', x: 16 / 64, y: 16 / 64, w: 32 / 64, h: 32 / 64 } }]);
    const at = (x, y) => res[(y * W + x) * 4];
    return { err: err / n, outside, centre: at(32, 32), corner: at(17, 17), far: at(4, 4), missing: P.applySpots(src, W, H, [{ mode: 'fill', pts: [[0.5, 0.5]], r: 0.05, patch: { id: 'nope', x: 0, y: 0, w: 1, h: 1 } }])[0] };
  });
  assert(r.err < 12 && r.outside === 0, `fill error ${r.err.toFixed(1)}, ${r.outside} pixels changed outside the hole`);
  assert(r.centre === 255 && r.corner === 128 && r.far === 128 && r.missing === 128, JSON.stringify(r));
  return `stripes continued with a mean error of ${r.err.toFixed(1)} levels`;
});

test('faces are grouped by person, named, and found by search', async () => {
  const r = await page(async () => {
    const F = PJ.Faces, Cat = PJ.Catalog, App = PJ.App, T = F._test, w = (ms) => new Promise(r => setTimeout(r, ms));
    // two made-up people: directions in the 128 numbers, each face a little off its person's
    let s = 5; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
    const base = [0, 1].map(() => Float32Array.from({ length: 128 }, rnd));
    const face = (k) => ({ b: [0.4, 0.3, 0.1, 0.1], q: 0.9, v: T.pack(base[k].map(v => v + rnd() * 0.5)) });
    const ph = Cat.state.photos.filter(p => p.kind !== 'video').slice(0, 3);
    ph[0].faces = [face(0), face(1)]; ph[1].faces = [face(0)]; ph[2].faces = [face(1), face(0)];
    const g = F.groups(), sizes = g.map(x => x.faces.length).sort().join(',');
    const who = F.name(g[0].faces, 'Zed Test');
    const n1 = F.photosOf(who.id).length, left = F.unnamedCount();
    const sug = F.groups().length;
    App.setModule('library'); App.library.setSource('person:' + who.id); await w(200);
    const shown = App.visible().length;
    App.library.setSource('all'); await w(100);
    const sim = T.similarity([[0, 0], [10, 0], [5, 5], [2, 8], [8, 8]], [[20, 10], [20, 30], [10, 20], [4, 14], [4, 26]]);
    const names = F.namesIn(ph[0]).join();
    F.remove(who.id); for (const p of ph) { delete p.faces; delete p.facesV; }
    return { sizes, n1, left, sug, shown, names, sim: sim.map(v => +v.toFixed(3)), people: F.people().length };
  });
  assert(r.sizes === '2,3', `groups of ${r.sizes}`);
  assert(r.n1 === 3 && r.left === 2 && r.sug === 1 && r.shown === 3 && r.names === 'Zed Test' && r.people === 0, JSON.stringify(r));
  assert(Math.abs(r.sim[0]) < 0.01 && Math.abs(r.sim[1] - 2) < 0.01, 'the face alignment is off: ' + r.sim);
  return 'two people told apart; naming one filed 3 photos under them';
});

test('HDR merge keeps both ends of the scene; a panorama joins overlapping photos', async () => {
  const r = await page(async () => {
    let s = 3; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const SW = 700, SH = 300, scene = new Float32Array(SW * SH * 3);
    for (let i = 0; i < 400; i++) { const bx = rnd() * SW, by = rnd() * SH, rr = 4 + rnd() * 16, c = [rnd(), rnd(), rnd()]; for (let y = Math.max(0, by - rr | 0); y < Math.min(SH, by + rr); y++) for (let x = Math.max(0, bx - rr | 0); x < Math.min(SW, bx + rr); x++) if (Math.abs(x - bx) + Math.abs(y - by) < rr) for (let k = 0; k < 3; k++) scene[(y * SW + x) * 3 + k] = 0.15 + 0.7 * c[k]; }
    const shot = (x0, w, h, e, light) => { const rgb = new Uint8Array(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) rgb[(y * w + x) * 3 + k] = Math.max(0, Math.min(255, 255 * Math.pow((scene[((y + 10) * SW + x + x0) * 3 + k] + 0.02) * e * (light ? light(x) : 1), 1 / 2.2))); return { w, h, rgb }; };
    const wk = new Worker(new URL('js/mergeworker.js', location.href).href);
    const run = (op, list, extra) => new Promise((res, rej) => {
      wk.onmessage = (e) => { if (e.data.progress != null) return; e.data.error ? rej(new Error(e.data.error)) : res(e.data); };
      wk.postMessage({ op: 'reset' }); for (const im of list) wk.postMessage({ op: 'image', w: im.w, h: im.h, rgb: im.rgb });
      wk.postMessage(Object.assign({ op, id: 1 }, extra));
    });
    const light = (x) => x > 200 ? 8 : 0.05;
    const ex = [0.15, 1, 7].map(e => shot(20, 400, 260, e, light)), hdr = await run('hdr', ex);
    const clipped = (a, max, n) => { let c = 0; for (let i = 1; i < n * 3; i += 3) if (a[i] <= 0.02 * max || a[i] >= 0.98 * max) c++; return c / n; };
    const pano = await run('pano', [shot(0, 300, 260, 1), shot(170, 300, 260, 1.2), shot(340, 300, 260, 0.9)], { focal: [4000, 4000, 4000], maxPixels: 4e6 });   // a long lens: the crops are sideways shifts, not a turning camera
    let refused = '';
    try { await run('pano', [shot(0, 300, 260, 1), { w: 300, h: 260, rgb: new Uint8Array(300 * 260 * 3).fill(90) }], { focal: [0, 0], maxPixels: 4e6 }); } catch (e) { refused = e.message; }
    wk.terminate();
    return { align: hdr.stats.align, ghost: hdr.stats.ghost, hdrClip: clipped(hdr.rgb16, 65535, 400 * 260), single: ex.map(im => clipped(im.rgb, 255, 400 * 260)), pano: [pano.w, pano.h], stats: pano.stats, refused };
  });
  assert(r.hdrClip < 0.12 && Math.min(...r.single) > r.hdrClip * 2, `merged ${r.hdrClip}, single exposures ${r.single}`);
  assert(r.align.length === 3 && r.align.includes('reference') && r.ghost.every(g => g < 0.05), 'HDR alignment: ' + JSON.stringify(r.align) + JSON.stringify(r.ghost));
  assert(r.pano[0] > 480 && r.pano[0] < 700 && r.stats.matches.every(m => m >= 10) && r.stats.overlapDiff < 6, JSON.stringify(r.pano) + JSON.stringify(r.stats));
  assert(/do not overlap/.test(r.refused), 'photos that do not overlap were joined anyway');
  return `HDR: ${(r.hdrClip * 100).toFixed(1)}% clipped against ${(Math.min(...r.single) * 100).toFixed(0)}% in the best single exposure; panorama ${r.pano[0]} × ${r.pano[1]} from three 300-wide photos`;
});

test('Display P3 pictures: narrowed for an sRGB edit, kept for a wide one; soft proof marks what sRGB cannot hold', async () => {
  const r = await page(() => {
    const P = PJ.Pipeline, w = 8, h = 8, src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { const c = i % 2 ? [250, 20, 20] : [120, 130, 110]; src.set([c[0], c[1], c[2], 255], i * 4); }
    const go = (opts) => P.render({ src: { data: src, width: w, height: h }, settings: P.defaultSettings(), fullLongEdge: w, seed: 1, opts: Object.assign({ srcInput: { space: 'p3' } }, opts) });
    const std = go({}), wide = go({ wide: true, outSpace: 'p3' }), proof = go({ wide: true, gamutWarn: true });
    const ref = src.slice(); PJ.ICC.convert(ref, 'srgb', 4, 255, 'p3');
    const diff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
    const mag = (d, i) => d[i * 4] === 255 && d[i * 4 + 1] === 0 && d[i * 4 + 2] === 255;
    return { std: diff(std.data, ref), wide: diff(wide.data, src), spaces: std.space + '/' + wide.space + '/' + proof.space, redMarked: mag(proof.data, 1), greyMarked: mag(proof.data, 0), counted: proof.clip.out };
  });
  assert(r.std <= 1 && r.wide === 0 && r.spaces === 'srgb/p3/srgb', JSON.stringify(r));
  assert(r.redMarked && !r.greyMarked && r.counted === 32, 'soft proof marking: ' + JSON.stringify(r));
});

test('JPEG XL exports carry EXIF; a JPEG XL picture inside a DNG is found', async () => {
  const r = await page(() => {
    const X = PJ.Exporter, app1 = Uint8Array.from([0xff, 0xe1, 0, 16, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]);
    const out = X.jxlWithExif(Uint8Array.from([0xff, 0x0a, 1, 2, 3]), app1), s = String.fromCharCode(...out);
    const same = X.jxlWithExif(Uint8Array.from([0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20]), app1).length;
    // a minimal DNG-like file: one IFD with a 3-sample, JPEG XL compressed, single-strip image
    const b = new Uint8Array(400), dv = new DataView(b.buffer); b[0] = b[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
    const tags = [[254, 4, 1, 0], [256, 4, 1, 640], [257, 4, 1, 480], [259, 3, 1, 52546], [262, 3, 1, 34892], [273, 4, 1, 300], [277, 3, 1, 3], [279, 4, 1, 100]];
    dv.setUint16(8, tags.length, true);
    tags.forEach(([t, ty, n, v], i) => { const e = 10 + i * 12; dv.setUint16(e, t, true); dv.setUint16(e + 2, ty, true); dv.setUint32(e + 4, n, true); if (ty === 3) dv.setUint16(e + 8, v, true); else dv.setUint32(e + 8, v, true); });
    const found = PJ.Raw.jxlInDng(b); dv.setUint16(10 + 3 * 12 + 8, 7, true);
    return { head: Array.from(out.slice(0, 12)), exifAt: s.indexOf('Exif'), tiffAfter: s.indexOf('II*') - s.indexOf('Exif'), jxlc: s.indexOf('jxlc') > 0, tail: Array.from(out.slice(-5)), same, found, notJxl: PJ.Raw.jxlInDng(b) };
  });
  assert(r.head.join() === '0,0,0,12,74,88,76,32,13,10,135,10' && r.exifAt > 0 && r.tiffAfter === 8 && r.jxlc && r.tail.join() === '255,10,1,2,3' && r.same === 8, JSON.stringify(r));
  assert(r.found && r.found.offset === 300 && r.found.length === 100 && r.found.width === 640 && r.notJxl === null, JSON.stringify(r.found));
});

test('fill takes each part of a hole from material of its own kind', async () => {
  const r = await page(async () => {
    // left half red noise, right half blue noise, a hole across the border; the map says which half is which
    const w = 160, h = 120, rgb = new Uint8Array(w * h * 3), mask = new Uint8Array(w * h), label = new Uint8Array(w * h);
    let s = 9; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x, L = x < 80, n = rnd() * 40; rgb.set(L ? [180 + n, 40, 40] : [40, 40, 180 + n], i * 3); label[i] = L ? 1 : 2; if (Math.abs(x - 80) < 22 && Math.abs(y - 60) < 22) { mask[i] = 1; rgb.set([0, 255, 0], i * 3); } }
    const wk = new Worker(new URL('js/fillworker.js', location.href).href);
    const out = await new Promise((res, rej) => { wk.onmessage = (e) => e.data.error ? rej(new Error(e.data.error)) : res(e.data.rgb); wk.postMessage({ id: 1, w, h, rgb, mask, label }); });
    wk.terminate();
    let wrong = 0, n = 0, green = 0;
    for (let y = 40; y < 80; y++) for (let x = 60; x < 100; x++) { if (Math.abs(x - 80) < 3) continue; const i = (y * w + x) * 3, red = out[i] > out[i + 2]; n++; if (red !== (x < 80)) wrong++; if (out[i + 1] > 150) green++; }
    return { wrong: wrong / n, green };
  });
  assert(r.green === 0 && r.wrong < 0.06, JSON.stringify(r));
  return `${(r.wrong * 100).toFixed(1)}% of the filled area took material from the wrong side`;
});

test('fill carries the border between two kinds straight through where an object hid it', async () => {
  const r = await page(async () => {
    // smooth pale sky above a sloping roofline, rough brown wall below; a sign (a kind found nowhere else) hangs across the line
    const w = 240, h = 180, rgb = new Uint8Array(w * h * 3), mask = new Uint8Array(w * h), label = new Uint8Array(w * h);
    let s = 3; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const wall = (x, y) => y > 30 + x * 0.45;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, n = rnd();
      if (wall(x, y)) { const m = (y % 8 < 1 || (x + ((y / 8) | 0) * 9) % 18 < 1) ? 60 : 0; rgb.set([150 - m + n * 50, 100 - m + n * 40, 70 - m + n * 30], i * 3); label[i] = 1; } else { rgb.set([205 + n * 6, 208 + n * 6, 214 + n * 6], i * 3); label[i] = 2; }
      if (x >= 85 && x < 155 && y >= 45 && y < 125) { rgb.set([250, 240, 60], i * 3); label[i] = 9; }
      if (x >= 75 && x < 165 && y >= 35 && y < 135) mask[i] = 1;
    }
    const wk = new Worker(new URL('js/fillworker.js', location.href).href);
    const out = await new Promise((res, rej) => { wk.onmessage = (e) => e.data.error ? rej(new Error(e.data.error)) : res(e.data.rgb); wk.postMessage({ id: 1, w, h, rgb, mask, label }); });
    wk.terminate();
    let wrong = 0, n = 0, yellow = 0;
    for (let y = 38; y < 132; y++) for (let x = 78; x < 162; x++) {
      const d = (y - 30 - x * 0.45) / Math.hypot(1, 0.45); if (Math.abs(d) < 4) continue;          // a few pixels either side of the line are free
      let a = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const q = ((y + dy) * w + x + dx) * 3; a += out[q + 2] - out[q] ; } a /= 9;      // sky is bluish, wall reddish
      n++; if ((a < -20) !== wall(x, y)) wrong++;
      const i = (y * w + x) * 3; if (out[i] > 230 && out[i + 2] < 120) yellow++;
    }
    return { wrong: wrong / n, yellow };
  });
  assert(r.yellow === 0 && r.wrong < 0.05, 'sky and wall must each keep to their side of the carried line: ' + JSON.stringify(r));
  return `${(r.wrong * 100).toFixed(1)}% of the filled area on the wrong side of the line`;
});

test('fisheye correction: same on both renderers, points map there and back; Adobe RGB soft proof', async () => {
  const r = await page(async () => {
    const P = PJ.Pipeline, E = PJ.Engine, Cat = PJ.Catalog, p = Cat.state.photos.find(x => x.name === 'building.jpg');
    await E.ensureSource(p, 'best');
    const s = P.defaultSettings(); s.lens.fisheye = 70;
    const c = await E.render(p, s, 'proxy', {}, 0), g = E.renderGPU(p, s, {});
    let sum = 0, n = 0;
    if (g && g.width === c.width) { const gd = g.canvas.getContext('2d').getImageData(0, 0, g.width, g.height, { colorSpace: 'srgb' }).data; for (let i = 0; i < gd.length; i += 4) { sum += Math.abs(gd[i] - c.data[i]) + Math.abs(gd[i + 1] - c.data[i + 1]) + Math.abs(gd[i + 2] - c.data[i + 2]); n += 3; } }
    const geo = P.buildGeometry(P.normalizeSettings(s), c.levelWidth, c.levelHeight), q = geo.toOutput(c.levelWidth * 0.2, c.levelHeight * 0.8), back = geo.toSource(q[0], q[1], [0, 0]);
    const plain = P.buildGeometry(P.normalizeSettings(P.defaultSettings()), c.levelWidth, c.levelHeight).toOutput(c.levelWidth * 0.2, c.levelHeight * 0.8);
    // soft proof for Adobe RGB: a moderate green that Adobe RGB holds is left alone, a P3 red it cannot hold is marked
    const src = new Uint8ClampedArray(2 * 4); src.set([90, 170, 110, 255], 0); src.set([255, 20, 20, 255], 4);
    const proof = P.render({ src: { data: src, width: 2, height: 1 }, settings: P.defaultSettings(), fullLongEdge: 2, seed: 1, opts: { srcInput: { space: 'p3' }, wide: true, outSpace: 'p3', gamutWarn: 'adobe' } });
    return { gpu: n ? sum / n : -1, trip: Math.hypot(back[0] - c.levelWidth * 0.2, back[1] - c.levelHeight * 0.8), moved: Math.hypot(q[0] - plain[0], q[1] - plain[1]), green: Array.from(proof.data.slice(0, 3)), red: Array.from(proof.data.slice(4, 7)), space: proof.space };
  });
  assert(r.gpu >= 0 && r.gpu < 1.5, `GPU and CPU differ by ${r.gpu}`);
  assert(r.trip < 0.05 && r.moved > 5, JSON.stringify(r));
  assert(r.space === 'p3' && r.green.join() === '90,170,110' && r.red.join() === '255,0,255', 'Adobe RGB proof: ' + JSON.stringify(r));
});

test('HDR merge can keep the full range: linear data with headroom and a preview', async () => {
  const r = await page(async () => {
    const w = 320, h = 200, shot = (e) => { const rgb = new Uint8Array(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const L = (x < 160 ? 0.04 : 2.5) * (0.6 + 0.4 * (((x >> 3) + (y >> 3)) & 1)); for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, 255 * Math.pow(L * e, 1 / 2.2))); } return { w, h, rgb }; };
    const wk = new Worker(new URL('js/mergeworker.js', location.href).href);
    const out = await new Promise((res, rej) => {
      wk.onmessage = (e) => { if (e.data.progress != null) return; e.data.error ? rej(new Error(e.data.error)) : res(e.data); };
      wk.postMessage({ op: 'reset' }); for (const e of [0.2, 1, 5]) { const im = shot(e); wk.postMessage({ op: 'image', w, h, rgb: im.rgb }); }
      wk.postMessage({ op: 'hdr', id: 1, linear: true });
    });
    wk.terminate();
    const at = (x, y) => out.rgb16[(y * w + x) * 3 + 1], H = out.stats.headroom;
    // the bright half is blown in the middle frame (2.5 > 1) but must come out near 2.5 and 1.5 in the merged light, in units of the middle frame's white
    const light = (x, y) => at(x, y) / 65535 * H;
    return { headroom: H, gains: out.stats.gains, brightA: light(244, 100), brightB: light(252, 100), dark: light(40, 100), preview: out.preview && [out.preview.w, out.preview.h, out.preview.rgb.length] };
  });
  assert(r.headroom > 3 && r.headroom < 8, 'headroom ' + r.headroom);
  const hi = Math.max(r.brightA, r.brightB), lo = Math.min(r.brightA, r.brightB);
  assert(hi > 1.6 && hi < 3.4 && lo > 1 && hi / lo > 1.3, `the blown area did not come back with its detail: ${r.brightA.toFixed(2)}, ${r.brightB.toFixed(2)}`);
  assert(r.dark > 0.01 && r.dark < 0.08 && r.preview && r.preview[2] === r.preview[0] * r.preview[1] * 3, JSON.stringify(r));
  return `highlights at ${hi.toFixed(1)}× and ${lo.toFixed(1)}× the middle frame's white are kept (headroom ${r.headroom.toFixed(1)}×)`;
});

test('files are renamed with the catalog following; catalog backups are made and listed', async () => {
  const r = await page(async () => {
    const A = PJ.API, Cat = PJ.Catalog;
    if (!A.moveFile) return { skipped: true };
    const p = Cat.state.photos.find(x => x.name === 'gradient.jpg'), other = Cat.state.photos.find(x => x.name === 'building.jpg'), from = p.path;
    const m = await A.moveFile(from, '', 'gradient-renamed.jpg');
    const there = await A.stat(m.path), gone = await A.stat(from).catch(() => null);
    let refused = '', badExt = '';
    try { await A.moveFile(m.path, '', other.name); } catch (e) { refused = e.message; }
    try { await A.moveFile(m.path, '', 'gradient.png'); } catch (e) { badExt = e.message; }
    const back = await A.moveFile(m.path, '', 'gradient.jpg');              // as it was, for the tests that follow
    const n0 = (await A.listBackups()).length; await Cat.save(); const b = await A.backupNow(); const list = await A.listBackups();
    return { moved: m.moved, name: m.name, there: !!there, gone: !gone || !(gone.size > 0), refused, badExt, back: back.path === from, n0, n1: list.length, made: b.name, newest: list[0].name };
  });
  if (r.skipped) return 'skipped';
  assert(r.moved && r.name === 'gradient-renamed.jpg' && r.there && r.gone && r.back, JSON.stringify(r));
  assert(/already exists/.test(r.refused) && /extension/.test(r.badExt), 'a rename onto an existing file or to another extension must be refused: ' + r.refused + ' / ' + r.badExt);
  assert(r.n1 === r.n0 + 1 && r.newest === r.made && /^catalog-manual-/.test(r.made), JSON.stringify(r));
});

test('printer soft proof: working colours reach Lab correctly; a file that is not a profile is refused', async () => {
  const r = await page(() => {
    const T = PJ.Proof._test, w = T.toLab('srgb', 1, 1, 1), k = T.toLab('srgb', 0, 0, 0), red = T.toLab('srgb', 1, 0, 0), p3red = T.toLab('p3', 1, 0, 0);
    let refused = '';
    try { PJ.Proof.parse(new Uint8Array(400)); } catch (e) { refused = e.message; }
    // the cube in a render: a made-up printer that cannot hold strong reds
    const n = 5, cube = new Float32Array(n * n * n); for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let rr = 0; rr < n; rr++) cube[(b * n + g) * n + rr] = rr >= 3 && g <= 1 && b <= 1 ? 1 : 0;
    const src = new Uint8ClampedArray(8); src.set([250, 20, 20, 255], 0); src.set([120, 130, 110, 255], 4);
    const res = PJ.Pipeline.render({ src: { data: src, width: 2, height: 1 }, settings: PJ.Pipeline.defaultSettings(), fullLongEdge: 2, seed: 1, opts: { gamutCube: { n, srgb: cube, p3: cube } } });
    return { w: w.map(v => +v.toFixed(1)), k: k.map(v => +v.toFixed(1)), red: red.map(v => Math.round(v)), p3redChroma: Math.round(Math.hypot(p3red[1], p3red[2])), redChroma: Math.round(Math.hypot(red[1], red[2])), refused, px: Array.from(res.data.slice(0, 3)).join() + ' | ' + Array.from(res.data.slice(4, 7)).join(), out: res.clip.out };
  });
  assert(Math.abs(r.w[0] - 100) < 0.2 && Math.abs(r.w[1]) < 0.3 && Math.abs(r.w[2]) < 0.3 && r.k[0] === 0, 'white and black: ' + JSON.stringify(r));
  assert(Math.abs(r.red[0] - 54) <= 1 && Math.abs(r.red[1] - 81) <= 2 && Math.abs(r.red[2] - 70) <= 2 && r.p3redChroma > r.redChroma, 'red: ' + JSON.stringify(r));
  assert(/not a colour profile/.test(r.refused) && r.px === '255,0,255 | 120,130,110' && r.out === 1, JSON.stringify(r));
});

test('printer soft proof: a version 4 profile is read, and paper and ink are shown', async () => {
  const r = await page(() => {
    // a made-up version 4 printer profile: holds the middle 80 % of each Lab axis, on paper that is not quite white
    const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255], s15 = (v) => be32((Math.round(v * 65536)) >>> 0), str = (s) => [...s].map(c => c.charCodeAt(0));
    const para1 = [...str('para'), 0, 0, 0, 0, 0, 0, 0, 0, ...s15(1)], curv0 = [...str('curv'), 0, 0, 0, 0, ...be32(0)];
    const curvG = [...str('curv'), 0, 0, 0, 0, ...be32(1), 1, 0, 0, 0], curvT = [...str('curv'), 0, 0, 0, 0, ...be32(3), 0, 0, 0x80, 0, 0xff, 0xff, 0, 0];
    const mat = (k, o) => [...s15(k), ...s15(0), ...s15(0), ...s15(0), ...s15(k), ...s15(0), ...s15(0), ...s15(0), ...s15(k), ...s15(o), ...s15(o), ...s15(o)];
    const clut = () => { const g = new Array(16).fill(0); g[0] = g[1] = g[2] = 2; const d = []; for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) for (const v of [a, b, c]) d.push(v ? 255 : 0, v ? 255 : 0); return [...g, 2, 0, 0, 0, ...d]; };
    const tag = (type, pieces) => {
      const head = [...str(type), 0, 0, 0, 0, 3, 3, 0, 0], body = [], offs = {}; let at = 32;
      for (const k of ['B', 'mat', 'M', 'clut', 'A']) { if (pieces[k]) { offs[k] = at; body.push(...pieces[k]); at += pieces[k].length; } else offs[k] = 0; }
      return [...head, ...be32(offs.B), ...be32(offs.mat), ...be32(offs.M), ...be32(offs.clut), ...be32(offs.A), ...body];
    };
    const three = (c) => [...c, ...c, ...c];
    const tags = [['B2A1', tag('mBA ', { B: three(para1), mat: mat(1.25, -0.125), M: three(curv0) })], ['A2B1', tag('mAB ', { A: three(curvT), clut: clut(), M: three(curvG), mat: mat(0.8, 0.1), B: three(curv0) })],
      ['wtpt', [...str('XYZ '), 0, 0, 0, 0, ...s15(0.85), ...s15(0.88), ...s15(0.70)]]];
    let at = 132 + tags.length * 12; const dir = [], data = [];
    for (const [name, b] of tags) { dir.push(...str(name), ...be32(at), ...be32(b.length)); data.push(...b); at += b.length; }
    const head = new Array(128).fill(0); head[8] = 4; head.splice(12, 4, ...str('prtr')); head.splice(16, 4, ...str('RGB ')); head.splice(20, 4, ...str('Lab ')); head.splice(36, 4, ...str('acsp'));
    const Pr = PJ.Proof, T = Pr._test, p = Pr.parse(new Uint8Array([...head, ...be32(tags.length), ...dir, ...data])), t = Pr.tables(p);
    const pr = (L, a, b) => T.printed(p, p.b2a, L, a, b).map(v => +v.toFixed(1));
    // a render with paper and ink shown, not marked: white comes out as the paper, a mid grey stays neutral
    const src = new Uint8ClampedArray(8); src.set([255, 255, 255, 255], 0); src.set([128, 128, 128, 255], 4);
    const res = PJ.Pipeline.render({ src: { data: src, width: 2, height: 1 }, settings: PJ.Pipeline.defaultSettings(), fullLongEdge: 2, seed: 1, opts: { gamutCube: { n: t.n, srgb: t.srgb, p3: t.p3, paper: t.paper, noMark: true } } });
    const marked = PJ.Pipeline.render({ src: { data: src, width: 2, height: 1 }, settings: PJ.Pipeline.defaultSettings(), fullLongEdge: 2, seed: 1, opts: { gamutCube: { n: t.n, srgb: t.srgb, p3: t.p3 } } });
    return { mid: pr(50, 10, -10), white: pr(100, 0, 0), outMid: T.outside(p, 50, 10, -10), outWhite: T.outside(p, 100, 0, 0), paper: Array.from(res.data.slice(0, 3)), grey: Array.from(res.data.slice(4, 7)), marked: Array.from(marked.data.slice(0, 3)).join(), threads: PJ.Raw.jxlThreads() };
  });
  assert(r.mid.join() === '50,10,-10' && r.white.join() === '90,0,0', 'the profile\'s tables: ' + JSON.stringify(r));
  assert(r.outMid < 0.5 && r.outWhite >= 0.5 && r.marked === '255,0,255', 'what is out of reach: ' + JSON.stringify(r));
  assert(r.paper[0] < 235 && r.paper[0] > 190 && r.paper[2] < r.paper[0] && Math.abs(r.grey[0] - r.grey[1]) < 8 && r.grey[0] < 140, 'paper and ink: ' + JSON.stringify(r));
  assert(r.threads >= 1 && r.threads <= 4, 'JPEG XL threads: ' + r.threads);
});

test('focus stack: sharp parts of two photos are merged into one', async () => {
  const r = await page(async () => {
    const w = 360, h = 240, N = w * h;
    let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const scene = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) scene[i] = 110;
    for (let k = 0; k < 160; k++) { const bx = (rnd() * w) | 0, by = (rnd() * h) | 0, bw = 6 + rnd() * 30, bh = 6 + rnd() * 30, c = [rnd() * 255, rnd() * 255, rnd() * 255]; for (let y = by; y < Math.min(h, by + bh); y++) for (let x = bx; x < Math.min(w, bx + bw); x++) for (let q = 0; q < 3; q++) scene[(y * w + x) * 3 + q] = c[q]; }
    const soft = Float32Array.from(scene);
    for (let pass = 0; pass < 3; pass++) { const t = Float32Array.from(soft); for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) for (let q = 0; q < 3; q++) { let s = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += t[((y + dy) * w + x + dx) * 3 + q]; soft[(y * w + x) * 3 + q] = s / 25; } }
    const frame = (left) => { const o = new Uint8Array(N * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const src = (x < w / 2) === left ? scene : soft; for (let q = 0; q < 3; q++) o[(y * w + x) * 3 + q] = src[(y * w + x) * 3 + q] + 0.5; } return o; };
    const a = frame(true), b = frame(false);
    const rms = (get) => { let s = 0, n = 0; for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) for (let q = 0; q < 3; q++) { const e = get((y * w + x) * 3 + q) - scene[(y * w + x) * 3 + q]; s += e * e; n++; } return Math.sqrt(s / n); };
    const before = [rms(i => a[i]), rms(i => b[i])];
    const wk = new Worker(new URL('js/mergeworker.js', location.href).href);
    const out = await new Promise((resolve, reject) => {
      wk.onmessage = (ev) => { const m = ev.data; if (m.progress != null) return; if (m.error) reject(new Error(m.error)); else resolve(m); };
      wk.onerror = (ev) => reject(new Error(ev.message || 'worker'));
      wk.postMessage({ op: 'reset' }); wk.postMessage({ op: 'image', w, h, rgb: a }, [a.buffer]); wk.postMessage({ op: 'image', w, h, rgb: b }, [b.buffer]); wk.postMessage({ op: 'stack', id: 1 });
    });
    wk.terminate();
    return { before: before.map(v => +v.toFixed(1)), after: +rms(i => out.rgb16[i] / 257).toFixed(1), size: out.w + 'x' + out.h, share: out.stats.share, command: typeof PJ.App.commands === 'object' ? 'mergeStack' in PJ.App.commands : null };
  });
  assert(r.size === '360x240' && r.after < Math.min(...r.before) * 0.45, 'the stack must be much closer to the sharp scene than either photo: ' + JSON.stringify(r));
  assert(r.share.length === 2 && r.share[0] > 0.3 && r.share[1] > 0.3, 'both photos must contribute: ' + JSON.stringify(r));
  return `error ${r.before.join(' / ')} → ${r.after}`;
});

test('stacks collapse and reopen', async () => {
  const r = await page(async () => {
    const App = PJ.App, Cat = PJ.Catalog, w = (ms) => new Promise(r => setTimeout(r, ms));
    App.setModule('library'); App.library.setSource('all'); for (const p of Cat.state.photos) delete p.stack; App.refresh();
    const n0 = App.visible().length, three = Cat.state.photos.filter(p => p.kind !== 'video').slice(0, 3);
    App.selectIds(three.map(p => p.id)); await w(700); App.runCommand('stack'); await w(300);
    const collapsed = App.visible().length; App.library.toggleStack(three[0].stack); await w(200); const open = App.visible().length;
    App.runCommand('unstack'); await w(700); const after = App.visible().length;
    return { n0, collapsed, open, after, left: Cat.state.photos.filter(p => p.stack).length };
  });
  assert(r.collapsed === r.n0 - 2 && r.open === r.n0 && r.after === r.n0 && r.left === 0, JSON.stringify(r));
});

test('RAW files develop on the GPU and the CPU alike (needs tests/fixtures/raw)', async () => {
  const r = await page(async () => {
    const A = PJ.API, Cat = PJ.Catalog, p = Cat.state.photos.find(x => x.isRaw && x.kind !== 'video' && PJ.Engine.needsDevelop(x));
    if (!p) return { skipped: true };
    const bytes = await A.readFile(p.path), preview = await PJ.Decode.decode(bytes, p.name).catch(() => null);
    Cat.setPref('raw.gpu', true); const g = await PJ.Raw.develop(p, bytes, preview), ge = PJ.Raw.lastEngine;
    Cat.setPref('raw.gpu', false); const c = await PJ.Raw.develop(p, bytes, preview); Cat.setPref('raw.gpu', true);
    const a = g.pixels.data, b = c.pixels.data; let max = 0, sum = 0;
    for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { const d = Math.abs(a[i + k] - b[i + k]); sum += d; if (d > max) max = d; }
    return { name: p.name, engine: ge, max, mean: sum / (a.length * 0.75), size: g.width + 'x' + g.height };
  });
  if (r.skipped) return 'skipped (no RAW fixtures)';
  assert(r.max <= 6 && r.mean < 1, `GPU and CPU differ: max ${r.max}, mean ${r.mean.toFixed(2)}`);
  return `${r.name} ${r.size}, developed on the ${r.engine}, max difference ${r.max}`;
});

test('settings are saved', async () => {
  await page(async () => { const Cat = PJ.Catalog, p = Cat.state.photos.find(x => x.name === 'flat.png'); p.rating = 4; p.settings.exposure = 0.33; Cat.commit(p, 'For the restart test'); await Cat.save(); });
});

test('the catalog survives a restart', async () => {
  const r = await page(() => { const p = PJ.Catalog.state.photos.find(x => x.name === 'flat.png'); return p ? { rating: p.rating, exposure: p.settings.exposure, n: PJ.Catalog.state.photos.length, missing: PJ.Catalog.state.photos.filter(x => x.missing).length } : null; });
  assert(r, 'the photo is gone'); assert(r.rating === 4 && r.exposure === 0.33, JSON.stringify(r)); assert(r.missing === 0, `${r.missing} photos marked missing`);
  return `${r.n} photos`;
}, 'restart');

// ---- run ----
let failed = 0, ran = 0;
for (const t of tests) {
  if (t.when !== phase || (filter && !t.name.toLowerCase().includes(filter))) continue;
  ran++;
  const t0 = Date.now();
  try {
    await page(() => { window.__testErrors.length = 0; });
    const note = await t.fn();
    const errs = await page(() => window.__testErrors.slice());
    if (errs.length) throw new Error('the editor reported: ' + errs.join(' | '));
    console.log(`  PASS  ${t.name}${note ? ` — ${note}` : ''}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) { failed++; console.log(`  FAIL  ${t.name}\n        ${String(e.message || e).split('\n')[0]}`); }
}
console.log(failed ? `\n${failed} of ${ran} failed` : ran ? `\nall ${ran} passed` : '\nno tests matched');
ws.close();
process.exit(failed ? 1 : 0);
