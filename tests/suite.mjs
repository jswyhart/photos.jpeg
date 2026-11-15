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
