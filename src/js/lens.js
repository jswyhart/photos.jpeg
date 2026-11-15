/* =====================================================================
 * photos.jpeg — lens corrections.
 *
 * 1. Lens profiles from the lensfun database (vendor/lensfun/lensfun.json,
 *    CC BY-SA 3.0): the photo's camera and lens are looked up, and the
 *    calibrated distortion (and vignetting, where the database has it) for the
 *    focal length and aperture used is put into the photo's settings.
 *    Conventions follow lensfun's own code: distortion polynomials are in
 *    Hugin units (r = 1 at half the calibration sensor's short side) and are
 *    rescaled to keep the centre's magnification; vignetting uses r = 1 at
 *    the sensor's corner; both are adapted to the photo's sensor size.
 *    Differences from lensfun: values between calibrated focal lengths are
 *    interpolated linearly (lensfun uses a spline), the focus distance is
 *    taken as far away for vignetting (photos rarely record it), and
 *    chromatic aberration and fisheye lenses are not handled.
 *
 * 2. Matching the camera, for lenses the database doesn't have:
 *
 * A RAW file holds the sensor data as the lens drew it, plus a JPEG preview
 * the camera made — with the camera's own corrections for the lens's
 * distortion where it applies one. Comparing the two tells what the lens
 * needs: small patches of the preview are located in the developed RAW, and
 * their displacement, growing with the cube of the distance from the centre,
 * gives the radial coefficient and the matching scale.
 * The result is stored per lens and focal length (a "lens profile"), so
 * other photos taken with the same lens get it without measuring again,
 * including JPEGs. Nothing is looked up online.
 *
 * Limits: a camera that doesn't correct distortion in its JPEGs (many older
 * bodies, or with the option switched off) gives a profile of "no correction
 * needed" — there is nothing to learn from. Vignetting is not measured: the
 * brightness difference between a camera JPEG and a development depends on
 * the scene (local tone mapping, noise reduction), and tests on real photos
 * gave different answers for the same lens. It stays a manual slider.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline, Dec = PJ.Decode, API = PJ.API;
  const KD = 0.3;          // pipeline: kd = lens.distortion / 100 × 0.3
  const AW = 420;          // analysis width in pixels

  /** "NIKON CORPORATION|NIKON 1 J1|1 NIKKOR VR 10-30mm f/3.5-5.6|10" — or '' when the photo doesn't say what lens it is. */
  function profileKey(photo) {
    const e = photo.exif || {};
    if (!e.model || !(e.focalLength > 0)) return '';
    return [e.make || '', e.model, e.lens || '(built-in lens)', Math.round(e.focalLength)].join('|');
  }
  function lensLabel(photo) {
    const e = photo.exif || {};
    return `${e.lens || e.model || 'this lens'}${e.focalLength ? ` at ${Math.round(e.focalLength)} mm` : ''}`;
  }
  const profiles = () => PJ.Catalog.pref('lens.profiles', {});
  function stored(photo) { const k = profileKey(photo); return k ? profiles()[k] || null : null; }
  function store(photo, prof) {
    const k = profileKey(photo);
    if (!k) return;
    PJ.Catalog.setPref('lens.profiles', Object.assign({}, profiles(), { [k]: prof }));
  }

  /* ---------------- images ---------------- */
  /** Grey values of a canvas image source drawn at w×h (optionally a centre crop of it). */
  function grayOf(image, w, h, crop) {
    const c = Dec.makeCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    if (crop) x.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h); else x.drawImage(image, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    return { g, w, h };
  }

  /* ---------------- distortion ---------------- */
  /**
   * Where each patch of `ref` (the corrected image) sits in `img` (as the lens drew it).
   * Returns matches [{px, py, qx, qy}] in pixels, relative to the image centre.
   */
  function matchPatches(ref, img) {
    const { w, h } = ref, S = 12, half = 12, step = 18, out = [];
    const N = (2 * half + 1) * (2 * half + 1);
    for (let cy = half + S + 1; cy < h - half - S - 1; cy += step) {
      for (let cx = half + S + 1; cx < w - half - S - 1; cx += step) {
        // the patch, mean removed; skip featureless ones
        let m = 0;
        for (let y = -half; y <= half; y++) for (let x = -half; x <= half; x++) m += ref.g[(cy + y) * w + cx + x];
        m /= N;
        let v = 0;
        for (let y = -half; y <= half; y++) for (let x = -half; x <= half; x++) { const t = ref.g[(cy + y) * w + cx + x] - m; v += t * t; }
        if (v / N < 40) continue;
        let best = Infinity, second = Infinity, bx = 0, by = 0;
        const score = new Float32Array((2 * S + 1) * (2 * S + 1));
        for (let dy = -S; dy <= S; dy++) {
          for (let dx = -S; dx <= S; dx++) {
            let m2 = 0;
            for (let y = -half; y <= half; y += 2) for (let x = -half; x <= half; x += 2) m2 += img.g[(cy + dy + y) * w + cx + dx + x];
            m2 /= 169;
            let e = 0;
            for (let y = -half; y <= half; y += 2) {
              const r1 = (cy + y) * w + cx, r2 = (cy + dy + y) * w + cx + dx;
              for (let x = -half; x <= half; x += 2) { const t = (ref.g[r1 + x] - m) - (img.g[r2 + x] - m2); e += t * t; }
            }
            score[(dy + S) * (2 * S + 1) + dx + S] = e;
            if (e < best) { second = best; best = e; bx = dx; by = dy; } else if (e < second) second = e;
          }
        }
        if (Math.abs(bx) === S || Math.abs(by) === S) continue;         // at the edge of the search: unreliable
        if (best > (v / N) * 169 * 0.6) continue;                       // doesn't really match
        // sub-pixel: parabola through the neighbours of the best score
        const at = (dx, dy) => score[(dy + S) * (2 * S + 1) + dx + S];
        const sub = (a, b, c) => { const den = a - 2 * b + c; return den > 1e-6 ? 0.5 * (a - c) / den : 0; };
        const fx = bx + Math.max(-0.5, Math.min(0.5, sub(at(bx - 1, by), best, at(bx + 1, by))));
        const fy = by + Math.max(-0.5, Math.min(0.5, sub(at(bx, by - 1), best, at(bx, by + 1))));
        out.push({ px: cx - w / 2 + 0.5, py: cy - h / 2 + 0.5, qx: cx + fx - w / 2 + 0.5, qy: cy + fy - h / 2 + 0.5 });
      }
    }
    return out;
  }

  /** Solve the 4×4 normal equations A x = b in place (Gaussian elimination with pivoting). */
  function solve4(A, b) {
    const n = 4;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-12) return null;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
    return x;
  }

  /**
   * Fit  q = s·p·(1 + k·r²) + t  (r² = |p|² / half-diagonal²) to the matches, discarding
   * outliers. Returns { k, s, n, rms, reach } or null.
   */
  function fitRadial(matches, w, h) {
    const hd2 = (w * w + h * h) / 4;
    let use = matches, fit = null;
    for (let round = 0; round < 4; round++) {
      if (use.length < 24) return null;
      const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0];
      const add = (row, y) => { for (let i = 0; i < 4; i++) { b[i] += row[i] * y; for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; } };
      for (const m of use) {
        const r2 = (m.px * m.px + m.py * m.py) / hd2;
        add([m.px, m.px * r2, 1, 0], m.qx);     // unknowns: s, s·k, tx, ty
        add([m.py, m.py * r2, 0, 1], m.qy);
      }
      const x = solve4(A, b);
      if (!x || !(x[0] > 0.5)) return null;
      fit = { s: x[0], k: x[1] / x[0], tx: x[2], ty: x[3] };
      const res = (m) => { const r2 = (m.px * m.px + m.py * m.py) / hd2, f = fit.s * (1 + fit.k * r2); return Math.hypot(f * m.px + fit.tx - m.qx, f * m.py + fit.ty - m.qy); };
      const errs = use.map(res), sorted = errs.slice().sort((a, c) => a - c);
      const cut = Math.max(0.6, sorted[Math.floor(sorted.length * 0.5)] * 2.5);
      fit.rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
      fit.n = use.length;
      fit.reach = Math.sqrt(Math.max(...use.map(m => (m.px * m.px + m.py * m.py) / hd2)));
      const kept = use.filter((m, i) => errs[i] <= cut);
      if (kept.length === use.length) break;
      use = kept;
    }
    return fit;
  }

  /* ---------------- measuring a photo ---------------- */
  /**
   * Compare a RAW photo's development with its embedded camera JPEG.
   * Returns { distortion, scale, detail } in Develop-slider units, or throws
   * an Error whose message says why it could not be measured.
   */
  async function measure(photo) {
    if (!PJ.Engine.needsDevelop(photo)) throw new Error('Measuring needs a RAW file that photos.jpeg develops itself (NEF, CR2, ARW, DNG)');
    const bytes = await API.readFile(photo.path);
    let preview;
    try { preview = await Dec.decode(bytes, photo.name); } catch (_) { preview = null; }
    if (!preview || !preview.image || preview.note === 'No embedded preview' || preview.width < 600) throw new Error('This RAW file has no camera preview large enough to compare with');
    // the RAW as developed, with no geometry or lens settings of its own
    const neutral = P.defaultSettings();
    const res = await PJ.Engine.render(photo, neutral, 'draft', {}, 0);
    if (!res) throw new Error('The photo could not be rendered');
    const raw = PJ.Engine.toCanvas(res);
    const w = AW, h = Math.round(AW * raw.height / raw.width);
    // the preview covers the RAW's frame minus a few pixels: trim it to the same shape
    const pa = preview.image.width / preview.image.height, ra = raw.width / raw.height;
    let crop = null;
    if (pa > ra * 1.01) { const cw = preview.image.height * ra; crop = { x: (preview.image.width - cw) / 2, y: 0, w: cw, h: preview.image.height }; }
    else if (pa < ra / 1.01) { const ch = preview.image.width / ra; crop = { x: 0, y: (preview.image.height - ch) / 2, w: preview.image.width, h: ch }; }
    const ref = grayOf(preview.image, w, h, crop), img = grayOf(raw, w, h);
    if (preview.image.close) try { preview.image.close(); } catch (_) { }

    const matches = matchPatches(ref, img);
    const fit = fitRadial(matches, w, h);
    if (!fit || fit.n < 30 || fit.reach < 0.6 || fit.rms > 0.8) throw new Error('This photo doesn\'t have enough fine detail across the frame to measure the lens — try one with texture out to the corners');
    const round1 = (v) => Math.round(v * 10) / 10;
    let distortion = Math.max(-100, Math.min(100, Math.round(fit.k / KD * 100)));
    let scale = Math.max(50, Math.min(150, round1(100 / fit.s)));
    if (Math.abs(distortion) < 3) { distortion = 0; scale = 100; }       // below what the eye or the fit can tell
    return { distortion, scale, detail: { k: fit.k, s: fit.s, patches: fit.n, rms: fit.rms, reach: fit.reach } };
  }

  /** Put a profile's values into a photo's settings (not committed: the caller does that). */
  function applyTo(photo, prof) {
    const s = photo.settings;
    s.lens.distortion = prof.distortion || 0;
    if (prof.distortion && prof.scale) s.transform.scale = prof.scale;
  }
  function describe(prof) {
    return prof.distortion ? `distortion ${prof.distortion > 0 ? '+' : ''}${prof.distortion}` : 'the camera applies no distortion correction';
  }

  /* ================= lensfun database ================= */
  let dbPromise = null;
  /** Loads the database on first use (1.5 MB) and indexes the cameras. */
  function database() {
    if (!dbPromise) {
      dbPromise = fetch('vendor/lensfun/lensfun.json').then(r => { if (!r.ok) throw new Error('The lens database is missing from this build'); return r.json(); }).then((db) => {
        db.byCamera = new Map();
        for (const c of db.cameras) { const k = c[0] + '|' + c[1]; if (!db.byCamera.has(k)) db.byCamera.set(k, c); }
        return db;
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  /** [maker, model, mount, crop] of the camera that took the photo, or null. */
  function findCamera(db, exif) {
    const make = norm(exif.make), model = norm(exif.model);
    if (!model) return null;
    const first = make.split(' ')[0];
    const tries = [model, model.replace(new RegExp('^' + first.replace(/[^a-z0-9]/g, '') + '\\s+'), '')];
    for (const m of tries) { const c = db.byCamera.get(make + '|' + m); if (c) return c; }
    // makers are written differently in places ("NIKON" / "Nikon Corporation"): the model decides
    for (const m of tries) { const c = db.cameras.find(x => x[1] === m && (!first || x[0].split(' ')[0] === first)); if (c) return c; }
    return null;
  }

  const focalSpec = (s) => { const m = /(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*mm/i.exec(s); return m ? [+m[1], +(m[2] || m[1])] : null; };
  const apertureSpec = (s) => { const m = /(?:f\/?|1:)\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/i.exec(s); return m ? [+m[1], +(m[2] || m[1])] : null; };
  const words = (s) => new Set(norm(s).replace(/f\//g, 'f').split(/[^a-z0-9.]+/).filter(Boolean));
  const same = (a, b) => Math.abs(a[0] - b[0]) <= 0.011 * Math.max(a[0], b[0]) + 0.05 && Math.abs(a[1] - b[1]) <= 0.011 * Math.max(a[1], b[1]) + 0.05;
  /** How well a database lens name fits the name the camera wrote (0 = not this lens; 2 = identical). */
  function nameScore(exifLens, lens) {
    const a = norm(exifLens), b = norm(lens.m);
    if (a === b || a === norm(lens.mk + ' ' + lens.m)) return 2;
    const fa = focalSpec(a), fb = focalSpec(b), aa = apertureSpec(a), ab = apertureSpec(b);
    if (!fa || !fb || !same(fa, fb)) return 0;                 // a different focal range is a different lens
    if (aa && ab && !same(aa, ab)) return 0;
    const wa = words(a), wb = words(b);
    for (const w of words(lens.mk)) { wa.delete(w); wb.delete(w); }
    let common = 0;
    for (const w of wa) if (wb.has(w)) common++;
    return common / (wa.size + wb.size - common || 1);
  }

  /** The database lens for a photo: { lens, camera } or null. */
  function findLens(db, exif) {
    const camera = findCamera(db, exif);
    const mountsOk = camera ? new Set([camera[2], ...(db.mounts[camera[2]] || [])]) : null;
    const fits = (l) => !mountsOk || l.mo.some(m => mountsOk.has(m));
    if (exif.lens) {
      let best = null, bestScore = 0;
      for (const l of db.lenses) {
        if (!fits(l)) continue;
        let s = nameScore(exif.lens, l);
        if (s > 0 && camera && l.mo.includes(camera[2])) s += 0.05;       // made for this mount rather than adapted
        if (s > bestScore) { best = l; bestScore = s; }
      }
      if (best && bestScore >= 0.5) return { lens: best, camera };
    }
    // fixed-lens cameras: lensfun gives them a mount of their own, with their lens on it
    if (camera && /^[a-z]/.test(camera[2])) {
      const own = db.lenses.filter(l => l.mo.includes(camera[2]));
      const covers = (l) => { const f = (l.d || l.v).map(e => e[0]); return exif.focalLength >= Math.min(...f) * 0.95 && exif.focalLength <= Math.max(...f) * 1.05; };
      const lens = own.find(covers) || (own.length === 1 ? own[0] : null);
      if (lens) return { lens, camera };
    }
    return null;
  }

  /** Distortion at a focal length: { pr, p1…p4 } in the pipeline's terms, or null. */
  function distortionAt(lens, focal, cropCam) {
    const d = lens.d;
    if (!d || !d.length || !(focal > 0)) return null;
    if (focal < d[0][0] * 0.9 || focal > d[d.length - 1][0] * 1.1) return null;      // outside what was calibrated
    let t;
    if (focal <= d[0][0]) t = d[0].slice(2);
    else if (focal >= d[d.length - 1][0]) t = d[d.length - 1].slice(2);
    else {
      let i = 1; while (d[i][0] < focal) i++;
      const a = d[i - 1], b = d[i], u = (focal - a[0]) / (b[0] - a[0]);
      // as lensfun: the coefficients fall off roughly with 1/focal, so (coefficient × focal) is what gets interpolated
      t = [0, 1, 2].map(k => ((1 - u) * a[2 + k] * a[0] + u * b[2 + k] * b[0]) / focal);
    }
    const model = d[0][1];
    let p1 = 0, p2 = 0, p3 = 0, p4 = 0;
    if (model === 0) { const dd = 1 - t[0] - t[1] - t[2]; if (!(dd > 0.5)) return null; p1 = t[2] / (dd * dd); p2 = t[1] / (dd * dd * dd); p3 = t[0] / (dd * dd * dd * dd); }
    else if (model === 1) { const dd = 1 - t[0]; if (!(dd > 0.5)) return null; p2 = t[0] / (dd * dd * dd); }
    else { p2 = t[0]; p4 = t[1]; }
    // Hugin's unit radius — half the short side of the calibration sensor — as a fraction of this photo's half-diagonal
    const pr = (cropCam / lens.c) / Math.hypot(lens.ar || 1.5, 1);
    if (!(pr > 0.2 && pr < 1.5)) return null;
    const r6 = (v) => +v.toPrecision(6);
    return { pr: r6(pr), p1: r6(p1), p2: r6(p2), p3: r6(p3), p4: r6(p4) };
  }

  /** Vignetting at a focal length and aperture: { vq, v1, v2, v3 } in the pipeline's terms, or null. */
  function vignettingAt(lens, focal, aperture, cropCam) {
    const v = lens.v;
    if (!v || !v.length || !(focal > 0) || !(aperture > 0)) return null;
    const fs = v.map(e => e[0]), minF = Math.min(...fs), span = Math.max(...fs) - minF;
    // lensfun's inverse-distance weighting (power 3.5) over focal length, 1/aperture and 1/distance; distance taken as far away
    const k = [0, 0, 0];
    let total = 0, nearest = Infinity;
    for (const e of v) {
      const f1 = span ? (focal - minF) / span : focal - minF, f2 = span ? (e[0] - minF) / span : e[0] - minF;
      const dist = Math.sqrt((f2 - f1) ** 2 + (4 / e[1] - 4 / aperture) ** 2 + (0.1 / e[2] - 0.1 / 1000) ** 2);
      if (dist < 1e-4) { k[0] = e[3]; k[1] = e[4]; k[2] = e[5]; total = 1; nearest = 0; break; }
      nearest = Math.min(nearest, dist);
      const wgt = 1 / Math.pow(dist, 3.5);
      k[0] += wgt * e[3]; k[1] += wgt * e[4]; k[2] += wgt * e[5]; total += wgt;
    }
    if (!(total > 0) || nearest > 1) return null;
    if (nearest > 0) for (let i = 0; i < 3; i++) k[i] /= total;
    // the lens leaves 1 + k1·q + k2·q² + k3·q³ of the light at q = (r / corner of the calibration sensor)²;
    // vq turns this photo's own (r / half-diagonal)² into that q
    const r6 = (x) => +x.toPrecision(6);
    const out = { vq: r6((lens.c / cropCam) ** 2), v1: r6(k[0]), v2: r6(k[1]), v3: r6(k[2]) };
    const corner = 1 + out.vq * (out.v1 + out.vq * (out.v2 + out.vq * out.v3));
    return Math.abs(corner - 1) < 0.01 ? null : out;      // under 1 % in the corners: nothing to correct
  }

  /** Smallest zoom that leaves no empty border after the distortion correction (as a Transform → Scale value). */
  function fillScale(dist, aspect) {
    const f = (r) => 1 + r * (dist.p1 + r * (dist.p2 + r * (dist.p3 + r * dist.p4)));
    const hd = Math.hypot(aspect, 1);
    let sc = 1;
    for (let it = 0; it < 6; it++) {
      let m = 0;
      for (let i = 0; i <= 24; i++) {
        const u = i / 24;
        // points along the top edge and the right edge (the other two mirror them), in half-diagonals
        for (const rho of [Math.hypot(u * aspect, 1) / hd, Math.hypot(aspect, u) / hd]) m = Math.max(m, f(rho / sc / dist.pr));
      }
      sc = m;
    }
    return Math.max(50, Math.min(150, Math.round(sc * 1000) / 10));
  }

  /**
   * Look the photo's lens up and put its profile into the photo's settings (not committed).
   * Resolves to a short description of what was applied; rejects with the reason when nothing fits.
   */
  async function applyDatabaseProfile(photo) {
    const e = photo.exif || {};
    if (!e.model) throw new Error('This photo doesn\'t record which camera took it');
    const db = await database();
    const hit = findLens(db, e);
    if (!hit) throw new Error(e.lens ? `${e.lens} isn't in the lens database` : 'This photo doesn\'t record its lens, and its camera isn\'t a fixed-lens model in the database');
    const { lens, camera } = hit;
    const cropCam = camera ? camera[3] : lens.c;
    const dist = distortionAt(lens, e.focalLength, cropCam), vig = vignettingAt(lens, e.focalLength, e.fNumber, cropCam);
    const name = norm(lens.m).startsWith(norm(lens.mk)) ? lens.m : `${lens.mk} ${lens.m}`;
    if (!dist && !vig) throw new Error(`${name} is in the lens database, but not calibrated for ${e.focalLength ? Math.round(e.focalLength) + ' mm' : 'this focal length'}`);
    const s = photo.settings, hadProfile = !!s.lens.pr;
    s.lens.profile = name;
    s.lens.distortion = 0;                      // the profile replaces a measured or hand-set correction
    if (dist) {
      Object.assign(s.lens, dist);
      const w = photo.width || 3, h = photo.height || 2;
      if (hadProfile || Math.abs((s.transform.scale || 100) - 100) < 0.05) s.transform.scale = fillScale(dist, Math.max(w, h) / Math.min(w, h));
    } else Object.assign(s.lens, { pr: 0, p1: 0, p2: 0, p3: 0, p4: 0 });
    Object.assign(s.lens, vig || { vq: 0, v1: 0, v2: 0, v3: 0 });
    return `${name}: ${[dist ? 'distortion' : '', vig ? 'vignetting' : ''].filter(Boolean).join(' and ')} corrected${e.focalLength ? ` for ${Math.round(e.focalLength * 10) / 10} mm` : ''}${dist && !vig ? ' (no vignetting data for this lens)' : ''}`;
  }
  /** Take a database profile off again. */
  function removeProfile(photo) {
    const s = photo.settings;
    if (s.lens.pr) s.transform.scale = 100;
    Object.assign(s.lens, { profile: '', pr: 0, p1: 0, p2: 0, p3: 0, p4: 0, vq: 0, v1: 0, v2: 0, v3: 0 });
  }

  global.PJ.Lens = {
    profileKey, lensLabel, stored, store, measure, applyTo, describe, applyDatabaseProfile, removeProfile, database,
    _test: { grayOf, matchPatches, fitRadial, findLens, findCamera, distortionAt, vignettingAt, fillScale, nameScore }
  };
})(window);
