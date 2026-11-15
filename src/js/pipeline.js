/* =====================================================================
 * photos.jpeg — image processing engine
 * Shared by the render workers (importScripts) and the UI thread.
 * All processing is non-destructive: (source pixels + settings) -> output.
 * ===================================================================== */
(function (global) {
  'use strict';

  const HUE_BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
  const HUE_CENTERS = [0, 30, 60, 120, 180, 240, 270, 300];
  const LOCAL_KEYS = ['temp', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
    'texture', 'clarity', 'dehaze', 'saturation'];

  /* ------------------------------------------------------------------ */
  /* Defaults                                                            */
  /* ------------------------------------------------------------------ */
  function idCurve() { return [[0, 0], [1, 1]]; }
  function zeros(n) { return new Array(n).fill(0); }

  function defaultSettings() {
    return {
      v: 2,
      wbMode: 'asShot', temp: 0, tint: 0,
      exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
      texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
      curve: {
        highlights: 0, lights: 0, darks: 0, shadows: 0, split1: 25, split2: 50, split3: 75,
        rgb: idCurve(), r: idCurve(), g: idCurve(), b: idCurve()
      },
      hsl: { hue: zeros(8), sat: zeros(8), lum: zeros(8) },
      bw: false, bwMix: zeros(8),
      grading: {
        shadows: { h: 0, s: 0, l: 0 }, midtones: { h: 0, s: 0, l: 0 },
        highlights: { h: 0, s: 0, l: 0 }, global: { h: 0, s: 0, l: 0 },
        blending: 50, balance: 0
      },
      detail: { sharpen: 0, radius: 1.0, detail: 25, masking: 0, nrLuma: 0, nrDetail: 50, nrColor: 0 },
      // profile…p4: a lens profile's distortion (see lens.js) — source radius = r·(1 + p1·r + p2·r² + p3·r³ + p4·r⁴),
      // r in units of pr × the half-diagonal; pr 0 = no profile. distortion / vignette are the manual sliders.
      // vq…v3: the profile's vignetting — the lens leaves 1 + v1·q + v2·q² + v3·q³ of the light at q = vq × (r / half-diagonal)²,
      // and the correction divides by it; vq 0 = none.
      // tr…tbb: the profile's lateral chromatic aberration — red and blue are read from the sensor at radius × (tv + tc·r + tb·r²),
      // r in units of tr × the half-diagonal; tr 0 = none.
      lens: {
        distortion: 0, vignette: 0, vigMid: 50, profile: '', pr: 0, p1: 0, p2: 0, p3: 0, p4: 0, vq: 0, v1: 0, v2: 0, v3: 0,
        tr: 0, tvr: 1, tvb: 1, tcr: 0, tcb: 0, tbr: 0, tbb: 0
      },
      transform: { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offX: 0, offY: 0 },
      effects: { vigAmount: 0, vigMid: 50, vigRound: 0, vigFeather: 50, vigHighlights: 0, grain: 0, grainSize: 25, grainRough: 50 },
      calib: { shadowTint: 0, redHue: 0, redSat: 0, greenHue: 0, greenSat: 0, blueHue: 0, blueSat: 0 },
      geo: { orient: 0, flipH: false, flipV: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'original' },
      input: { profile: 'none', rolloff: 50 },
      lut: { id: '', amount: 100, stage: 'look' },   // imported .cube LUT: 'look' (creative, after edits) or 'input' (camera LUT)
      masks: [],
      spots: [],
      keyframes: [],   // video: [{ t, s, ease }] — see video/keyframes.js
      stab: { amount: 0 } // video stabilization smoothness 0…100 (needs an analysis of the clip)
    };
  }

  function defaultLocalAdj() {
    const o = {};
    LOCAL_KEYS.forEach(k => { o[k] = 0; });
    return o;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Deep-merge `patch` into a fresh default object so old/partial settings are always complete. */
  function normalizeSettings(s) {
    const d = defaultSettings();
    if (!s) return d;
    (function merge(dst, src) {
      for (const k of Object.keys(src)) {
        const sv = src[k];
        if (sv && typeof sv === 'object' && !Array.isArray(sv) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
          merge(dst[k], sv);
        } else if (sv !== undefined) {
          dst[k] = clone(sv);
        }
      }
    })(d, s);
    return d;
  }

  function beforeSettings(s) {
    const d = defaultSettings();
    d.geo = clone(s.geo);
    if (s.input) d.input = clone(s.input); // "before" still decodes camera log
    if (s.lut && s.lut.id && s.lut.stage === 'input') d.lut = clone(s.lut); // …and still applies a camera LUT
    return d;
  }

  /* ------------------------------------------------------------------ */
  /* Math helpers & LUTs                                                 */
  /* ------------------------------------------------------------------ */
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  function smoothstep(a, b, x) {
    if (a === b) return x < a ? 0 : 1;
    let t = (x - a) / (b - a);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }

  const SRGB8_TO_LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB8_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const LUT_N = 4096;      // entries per unit
  const LIN_MAX = 8;       // linear->sRGB LUT covers [0, 8] (over-range highlights stay recoverable)
  const LIN_TO_SRGB = new Float32Array(LUT_N * LIN_MAX + 2);
  const SRGB_TO_LIN = new Float32Array(LUT_N + 2);
  for (let i = 0; i < LIN_TO_SRGB.length; i++) {
    const x = i / LUT_N;
    LIN_TO_SRGB[i] = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  }
  for (let i = 0; i <= LUT_N + 1; i++) {
    const x = Math.min(1, i / LUT_N);
    SRGB_TO_LIN[i] = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  }
  function toSrgb(x) {
    if (x <= 0) return 0;
    if (x >= LIN_MAX) return 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    const f = x * LUT_N, i = f | 0, t = f - i;
    return LIN_TO_SRGB[i] + (LIN_TO_SRGB[i + 1] - LIN_TO_SRGB[i]) * t;
  }
  function toLin(x) {
    if (x <= 0) return 0;
    if (x >= 1) return x === 1 ? 1 : Math.pow((x + 0.055) / 1.055, 2.4);
    const f = x * LUT_N, i = f | 0, t = f - i;
    return SRGB_TO_LIN[i] + (SRGB_TO_LIN[i + 1] - SRGB_TO_LIN[i]) * t;
  }

  /* ------------------------------------------------------------------ */
  /* Camera input profiles (log video → scene linear Rec.709)            */
  /* ------------------------------------------------------------------ */
  const REC2020_TO_709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
  const INPUT_PROFILES = {
    none: { label: 'Standard (Rec.709 / sRGB)' },
    applelog: {
      label: 'Apple Log (iPhone)', gamut: REC2020_TO_709,
      decode(x) {
        const R0 = -0.05641088, Rt = 0.01, c = 47.28711236, b = 0.00964052, g = 0.08550479, d = 0.69336945;
        const Pt = c * (Rt - R0) * (Rt - R0);
        if (x >= Pt) return Math.pow(2, (x - d) / g) - b;
        return x >= 0 ? Math.sqrt(x / c) + R0 : R0;
      }
    },
    slog3: {
      label: 'Sony S-Log3 / S-Gamut3.Cine', gamut: [[1.6269, -0.5401, -0.0868], [-0.1785, 1.4179, -0.2394], [-0.0444, -0.1959, 1.2404]],
      decode: (x) => x >= 171.2102946929 / 1023 ? Math.pow(10, (x * 1023 - 420) / 261.5) * 0.19 - 0.01 : (x * 1023 - 95) * 0.01125 / (171.2102946929 - 95)
    },
    vlog: {
      label: 'Panasonic V-Log / V-Gamut', gamut: [[1.8066, -0.6957, -0.1109], [-0.1701, 1.3060, -0.1359], [-0.0252, -0.1545, 1.1797]],
      decode: (x) => x < 0.181 ? (x - 0.125) / 5.6 : Math.pow(10, (x - 0.598206) / 0.241514) - 0.00873
    },
    clog3: {
      label: 'Canon Log 3', gamut: REC2020_TO_709,
      decode(x) {
        if (x < 0.097465473) return -(Math.pow(10, (0.12783901 - x) / 0.36726845) - 1) / 14.98325;
        if (x <= 0.15277891) return (x - 0.12512219) / 1.9754798;
        return (Math.pow(10, (x - 0.12240537) / 0.36726845) - 1) / 14.98325;
      }
    },
    flog: {
      label: 'Fujifilm F-Log', gamut: REC2020_TO_709,
      decode: (x) => x >= 0.100537775223865 ? (Math.pow(10, (x - 0.790453) / 0.344676) - 0.009468) / 0.555556 : (x - 0.092864) / 8.735631
    },
    nlog: {
      label: 'Nikon N-Log', gamut: REC2020_TO_709,
      decode(x) { const v = x * 1023; return v < 452 ? Math.pow(v / 650, 3) - 0.0075 : Math.exp((v - 619) / 150); }
    },
    dlog: {
      label: 'DJI D-Log', gamut: REC2020_TO_709,
      decode: (x) => x <= 0.14 ? (x - 0.0929) / 6.025 : (Math.pow(10, 3.89616 * x - 2.27752) - 0.0108) / 0.9892
    },
    rawlog: {
      // Internal encoding used for RAW video (CinemaDNG, converted RAW): linear 0…16 in 8 bits
      label: 'Camera RAW (linear)', internal: true,
      decode: (x) => (Math.pow(2, x * Math.log2(16 * 64 + 1)) - 1) / 64
    }
  };
  /* ---- Wide colour ----
   * A developed RAW file holds its colours in Display P3 primaries, which reach well past sRGB in
   * the reds and greens. A photo marked "wide" is edited in that space from end to end and only
   * narrowed at the very end, for a screen or a file that is sRGB. A photo that is not marked is
   * brought into sRGB first, exactly as before wide colour existed, so earlier edits look the same. */
  const SRGB_TO_P3 = [0.8224621, 0.1775380, 0, 0.0331941, 0.9668058, 0, 0.0170827, 0.0723974, 0.9105199];
  const P3_TO_SRGB = [1.2249401, -0.2249404, 0, -0.0420569, 1.0420571, 0, -0.0196376, -0.0786361, 1.0982735];
  function mul3(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
  }
  /** True when this render works in wide colour: the photo asks for it and its source carries it. */
  function isWide(s, opts) {
    return !!(opts && opts.wide && opts.srcInput && opts.srcInput.space === 'p3' &&
      !(opts.cube && s.lut && s.lut.stage === 'input' && s.lut.amount > 0) && !(s.input && s.input.profile !== 'none'));
  }
  // display-encoded 0…1 ⇄ linear by table (both spaces use the sRGB curve); the encode table is indexed by √linear
  let TLIN = null, TENC = null;
  function gamutTables() {
    if (TLIN) return;
    TLIN = new Float32Array(4098); TENC = new Float32Array(4098);
    for (let i = 0; i < 4098; i++) { const v = Math.min(1, i / 4096); TLIN[i] = toLin(v); TENC[i] = toSrgb(v * v); }
  }
  const fLin = (v) => { if (v <= 0) return 0; if (v >= 1) return 1; const f = v * 4096, q = f | 0; return TLIN[q] + (TLIN[q + 1] - TLIN[q]) * (f - q); };
  const fEnc = (l) => { if (l <= 0) return 0; if (l >= 1) return 1; const f = Math.sqrt(l) * 4096, q = f | 0; return TENC[q] + (TENC[q + 1] - TENC[q]) * (f - q); };
  /** Display-encoded planes from one set of primaries to another (values end inside 0…1). */
  function convertPlanes(R, G, B, N, M) {
    gamutTables();
    for (let i = 0; i < N; i++) {
      const r = fLin(R[i]), g = fLin(G[i]), b = fLin(B[i]);
      R[i] = fEnc(M[0] * r + M[1] * g + M[2] * b); G[i] = fEnc(M[3] * r + M[4] * g + M[5] * b); B[i] = fEnc(M[6] * r + M[7] * g + M[8] * b);
    }
  }

  /** Encode scene-linear into the internal RAW log (inverse of rawlog.decode). */
  function rawLogEncode(lin) { return Math.log2(Math.max(0, lin) * 64 + 1) / Math.log2(16 * 64 + 1); }
  const inputLutCache = {};
  /** 256-entry code → scene-linear table for an input profile (8-bit sources). */
  function inputLUT(profile) {
    if (inputLutCache[profile]) return inputLutCache[profile];
    const pr = INPUT_PROFILES[profile];
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) t[i] = pr && pr.decode ? pr.decode(i / 255) : SRGB8_TO_LIN[i];
    return (inputLutCache[profile] = t);
  }
  /** Highlight shoulder: linear in, compressed toward 1.0 above the knee (rolloff 0 = hard clip). */
  function inputKnee(rolloff) { return 1 - 0.6 * clamp(rolloff ?? 50, 0, 100) / 100; }
  function shoulder(x, k) { if (x <= k || k >= 1) return x; const r = 1 - k; return k + r * (1 - Math.exp(-(x - k) / r)); }
  /**
   * A source's own input transform (RAW files decoded to rawlog): per-code LUT to display-linear
   * (base tone curve fitted to the camera's rendering) then a 3×3 colour matrix.
   */
  function stageSourceInput(R, G, B, N, si, wide) {
    const lut = si.lut, dec = inputLUT('rawlog'), p3 = si.space === 'p3';
    // not wide: the source's P3 values go to sRGB before anything else; wide: the camera's colour matrix moves into P3
    const pre = p3 && !wide ? P3_TO_SRGB : null, K = 1 / Math.log2(16 * 64 + 1);
    const M = p3 && wide && si.matrix ? mul3(SRGB_TO_P3, mul3(si.matrix, P3_TO_SRGB)) : si.matrix;
    const look = (t, v) => { const f = (v <= 0 ? 0 : v >= 1 ? 1 : v) * 255, i = f | 0, j = i < 255 ? i + 1 : 255; return t[i] + (t[j] - t[i]) * (f - i); };
    for (let i = 0; i < N; i++) {
      let cr = R[i], cg = G[i], cb = B[i];
      let sr = look(dec, cr), sg = look(dec, cg), sb = look(dec, cb);
      if (pre) {
        const a = pre[0] * sr + pre[1] * sg + pre[2] * sb, c = pre[3] * sr + pre[4] * sg + pre[5] * sb, d = pre[6] * sr + pre[7] * sg + pre[8] * sb;
        sr = a > 0 ? a : 0; sg = c > 0 ? c : 0; sb = d > 0 ? d : 0;
        cr = Math.log2(sr * 64 + 1) * K; cg = Math.log2(sg * 64 + 1) * K; cb = Math.log2(sb * 64 + 1) * K;
      }
      let r = look(lut, cr), g = look(lut, cg), b = look(lut, cb);
      // Saturated colours (lamps, LEDs, neon) take the curve on their brightest channel and keep
      // their channel ratios, so a red light stays red instead of drifting to pink as it brightens.
      const cmax = cr > cg ? (cr > cb ? cr : cb) : (cg > cb ? cg : cb);
      const smax = sr > sg ? (sr > sb ? sr : sb) : (sg > sb ? sg : sb), smin = sr < sg ? (sr < sb ? sr : sb) : (sg < sb ? sg : sb);
      if (smax > 1e-6) {
        const sat = (smax - smin) / smax;
        if (sat > 0.5) {
          const k = look(lut, cmax) / smax, w = sat >= 0.9 ? 1 : (sat - 0.5) / 0.4 * ((sat - 0.5) / 0.4) * (3 - 2 * (sat - 0.5) / 0.4);
          r += (sr * k - r) * w; g += (sg * k - g) * w; b += (sb * k - b) * w;
        }
      }
      if (M) { const r2 = M[0] * r + M[1] * g + M[2] * b, g2 = M[3] * r + M[4] * g + M[5] * b, b2 = M[6] * r + M[7] * g + M[8] * b; r = r2; g = g2; b = b2; }
      R[i] = toSrgb(r > 0 ? r : 0); G[i] = toSrgb(g > 0 ? g : 0); B[i] = toSrgb(b > 0 ? b : 0);
    }
  }

  /** Convert camera-log code values (sRGB-encoded slots, 0…1) to display-encoded values in place. */
  function stageInput(R, G, B, N, inp) {
    const pr = INPUT_PROFILES[inp.profile];
    if (!pr || !pr.decode) return;
    const lut = inputLUT(inp.profile), M = pr.gamut || null, k = inputKnee(inp.rolloff);
    const look = (v) => { const f = (v <= 0 ? 0 : v >= 1 ? 1 : v) * 255, i = f | 0, j = i < 255 ? i + 1 : 255; return lut[i] + (lut[j] - lut[i]) * (f - i); };
    for (let i = 0; i < N; i++) {
      let r = look(R[i]), g = look(G[i]), b = look(B[i]);
      if (M) {
        const r2 = M[0][0] * r + M[0][1] * g + M[0][2] * b, g2 = M[1][0] * r + M[1][1] * g + M[1][2] * b, b2 = M[2][0] * r + M[2][1] * g + M[2][2] * b;
        r = r2; g = g2; b = b2;
      }
      R[i] = toSrgb(shoulder(r > 0 ? r : 0, k)); G[i] = toSrgb(shoulder(g > 0 ? g : 0, k)); B[i] = toSrgb(shoulder(b > 0 ? b : 0, k));
    }
  }

  /** White-balance gains for temp/tint in [-100, 100]. Luminance-normalized. */
  function wbGains(temp, tint) {
    const a = (temp / 100) * 0.9, c = (tint / 100) * 0.6;
    let gr = Math.pow(2, a), gb = Math.pow(2, -a), gg = Math.pow(2, -c);
    const n = 0.2126 * gr + 0.7152 * gg + 0.0722 * gb;
    return [gr / n, gg / n, gb / n];
  }
  /** Inverse: temp/tint that neutralizes a given linear RGB sample. */
  function neutralizeWB(r, g, b) {
    r = Math.max(r, 1e-5); g = Math.max(g, 1e-5); b = Math.max(b, 1e-5);
    const a = 0.5 * Math.log2(b / r);
    const c = Math.log2(g / Math.sqrt(r * b));
    return { temp: Math.round(clamp(a / 0.9 * 100, -100, 100)), tint: Math.round(clamp(c / 0.6 * 100, -100, 100)) };
  }

  /* Fast gaussian approximation: 3 box blurs (Kutskir). In-place capable via scratch. */
  function boxesForGauss(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    const sizes = [];
    for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
    return sizes;
  }
  function boxBlurH(src, dst, w, h, r) {
    const iarr = 1 / (r + r + 1);
    for (let y = 0; y < h; y++) {
      let ti = y * w, li = ti, ri = ti + r;
      const fv = src[ti], lv = src[ti + w - 1];
      let val = (r + 1) * fv;
      for (let j = 0; j < r; j++) val += src[ti + Math.min(j, w - 1)];
      for (let j = 0; j <= r; j++) { val += src[Math.min(ri++, ti + w - 1 + 0)] - fv; dst[ti++] = val * iarr; }
      for (let j = r + 1; j < w - r; j++) { val += src[ri++] - src[li++]; dst[ti++] = val * iarr; }
      for (let j = Math.max(w - r, r + 1); j < w; j++) { val += lv - src[li++]; dst[ti++] = val * iarr; }
    }
  }
  function boxBlurV(src, dst, w, h, r) {
    const iarr = 1 / (r + r + 1);
    for (let x = 0; x < w; x++) {
      let ti = x, li = ti, ri = ti + r * w;
      const fv = src[ti], lv = src[ti + w * (h - 1)];
      let val = (r + 1) * fv;
      for (let j = 0; j < r; j++) val += src[ti + Math.min(j, h - 1) * w];
      for (let j = 0; j <= r; j++) { val += src[Math.min(ri, x + (h - 1) * w)] - fv; dst[ti] = val * iarr; ri += w; ti += w; }
      for (let j = r + 1; j < h - r; j++) { val += src[ri] - src[li]; dst[ti] = val * iarr; li += w; ri += w; ti += w; }
      for (let j = Math.max(h - r, r + 1); j < h; j++) { val += lv - src[li]; dst[ti] = val * iarr; li += w; ti += w; }
    }
  }
  /** Gaussian-ish blur of a Float32Array plane. Returns a new array. */
  /** Gaussian blur. ox/oy: absolute position of the plane, so decimated blurs line up across render bands. */
  function blurPlane(src, w, h, sigma, ox, oy) {
    // Wide blurs run on a decimated plane: same result to well under 1/255, a fraction of the work.
    if (sigma >= 10 && w >= 64 && h >= 64) return blurDecimated(src, w, h, sigma, ox | 0, oy | 0);
    const out = new Float32Array(src);
    if (sigma < 0.35 || w < 3 || h < 3) return out;
    const tmp = new Float32Array(src.length);
    const boxes = boxesForGauss(sigma, 3);
    for (const b of boxes) {
      let r = (b - 1) >> 1;
      r = Math.min(r, Math.floor((Math.min(w, h) - 1) / 2));
      if (r < 1) continue;
      boxBlurH(out, tmp, w, h, r);
      boxBlurV(tmp, out, w, h, r);
    }
    return out;
  }

  function blurDecimated(src, w, h, sigma, ox, oy) {
    const f = Math.max(2, Math.floor(sigma / 4));
    // cell grid anchored at absolute multiples of f
    const px = ((ox % f) + f) % f, py = ((oy % f) + f) % f;
    const sw = Math.ceil((w + px) / f), sh = Math.ceil((h + py) / f);
    const small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      const y0 = Math.max(0, y * f - py), y1 = Math.min(h, y * f - py + f);
      for (let x = 0; x < sw; x++) {
        const x0 = Math.max(0, x * f - px), x1 = Math.min(w, x * f - px + f);
        let acc = 0;
        for (let yy = y0; yy < y1; yy++) { const row = yy * w; for (let xx = x0; xx < x1; xx++) acc += src[row + xx]; }
        small[y * sw + x] = acc / ((y1 - y0) * (x1 - x0));
      }
    }
    // box-averaging already contributes variance (f²-1)/12 per axis
    const s2 = Math.sqrt(Math.max(0.25, sigma * sigma - (f * f - 1) / 12)) / f;
    const bl = blurPlane(small, sw, sh, s2);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let fy = (y + py + 0.5) / f - 0.5; if (fy < 0) fy = 0;
      let iy = fy | 0; if (iy > sh - 2) iy = Math.max(0, sh - 2);
      const ty = Math.min(1, fy - iy), r0 = iy * sw, r1 = Math.min(sh - 1, iy + 1) * sw;
      for (let x = 0; x < w; x++) {
        let fx = (x + px + 0.5) / f - 0.5; if (fx < 0) fx = 0;
        let ix = fx | 0; if (ix > sw - 2) ix = Math.max(0, sw - 2);
        const tx = Math.min(1, fx - ix), ix1 = Math.min(sw - 1, ix + 1);
        const a = bl[r0 + ix] + (bl[r0 + ix1] - bl[r0 + ix]) * tx;
        const b = bl[r1 + ix] + (bl[r1 + ix1] - bl[r1 + ix]) * tx;
        out[y * w + x] = a + (b - a) * ty;
      }
    }
    return out;
  }

  function hash2(x, y, seed) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 982451653)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) * 2.3283064365386963e-10;
  }
  function valueNoise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  }

  /* RGB <-> HSL (h in degrees) */
  function rgbToHsl(r, g, b, out) {
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const l = (max + min) * 0.5;
    let h = 0, s = 0;
    const d = max - min;
    if (d > 1e-6) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    out[0] = h; out[1] = s; out[2] = l;
  }
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  function hslToRgb(h, s, l, out) {
    if (s <= 1e-6) { out[0] = out[1] = out[2] = l; return; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hk = (((h % 360) + 360) % 360) / 360;
    out[0] = hue2rgb(p, q, hk + 1 / 3);
    out[1] = hue2rgb(p, q, hk);
    out[2] = hue2rgb(p, q, hk - 1 / 3);
  }
  /** Weights of the 8 hue bands for a hue (piecewise linear between neighbors). */
  function hueBandWeights(h, w) {
    for (let k = 0; k < 8; k++) w[k] = 0;
    h = ((h % 360) + 360) % 360;
    for (let k = 0; k < 8; k++) {
      const a = HUE_CENTERS[k], b = k === 7 ? 360 : HUE_CENTERS[k + 1];
      if (h >= a && h < b) {
        const t = (h - a) / (b - a);
        w[k] = 1 - t; w[(k + 1) % 8] = t;
        return;
      }
    }
  }
  function hueVector(hDeg) {
    const o = [0, 0, 0];
    hslToRgb(hDeg, 1, 0.5, o);
    const m = (o[0] + o[1] + o[2]) / 3;
    return [o[0] - m, o[1] - m, o[2] - m];
  }

  /* ------------------------------------------------------------------ */
  /* Curves                                                              */
  /* ------------------------------------------------------------------ */
  /** Monotone cubic (Fritsch–Carlson) spline sampled into a LUT. */
  function splineLUT(points, n) {
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    const lut = new Float32Array(n);
    if (pts.length < 2) { for (let i = 0; i < n; i++) lut[i] = i / (n - 1); return lut; }
    const k = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const d = [], m = new Array(k);
    for (let i = 0; i < k - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
    m[0] = d[0]; m[k - 1] = d[k - 2];
    for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < k - 1; i++) {
      if (Math.abs(d[i]) < 1e-9) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      if (x <= xs[0]) { lut[i] = ys[0]; continue; }
      if (x >= xs[k - 1]) { lut[i] = ys[k - 1]; continue; }
      while (seg < k - 2 && x > xs[seg + 1]) seg++;
      const hh = xs[seg + 1] - xs[seg], t = (x - xs[seg]) / hh;
      const t2 = t * t, t3 = t2 * t;
      lut[i] = clamp((2 * t3 - 3 * t2 + 1) * ys[seg] + (t3 - 2 * t2 + t) * hh * m[seg] +
        (-2 * t3 + 3 * t2) * ys[seg + 1] + (t3 - t2) * hh * m[seg + 1], 0, 1);
    }
    return lut;
  }
  function isIdentityCurve(p) {
    return !p || p.length === 0 || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1);
  }
  /** Parametric region curve (Highlights / Lights / Darks / Shadows with splits). */
  function parametricLUT(c, n) {
    const lut = new Float32Array(n);
    const s1 = c.split1 / 100, s2 = c.split2 / 100, s3 = c.split3 / 100;
    const peaks = [s1 * 0.5, (s1 + s2) / 2, (s2 + s3) / 2, (s3 + 1) / 2];
    const widths = [Math.max(0.12, s1 * 0.9 + 0.08), Math.max(0.1, (s2 - s1) * 0.8 + 0.08), Math.max(0.1, (s3 - s2) * 0.8 + 0.08), Math.max(0.12, (1 - s3) * 0.9 + 0.08)];
    const amts = [c.shadows, c.darks, c.lights, c.highlights].map(v => v / 100 * 0.16);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      let y = x;
      for (let k = 0; k < 4; k++) {
        if (!amts[k]) continue;
        const d = (x - peaks[k]) / widths[k];
        if (d > -1 && d < 1) { const cw = Math.cos(d * Math.PI / 2); y += amts[k] * cw * cw; }
      }
      y = clamp(y, 0, 1);
      if (y < prev) y = prev;
      lut[i] = prev = y;
    }
    lut[0] = Math.min(lut[0], lut[1]);
    return lut;
  }
  /** Combined per-channel curve LUTs, or null if all identity. */
  function buildCurveLUTs(c) {
    const N = 1024;
    const paramActive = c.highlights || c.lights || c.darks || c.shadows;
    const anyPoint = !isIdentityCurve(c.rgb) || !isIdentityCurve(c.r) || !isIdentityCurve(c.g) || !isIdentityCurve(c.b);
    if (!paramActive && !anyPoint) return null;
    const P = paramActive ? parametricLUT(c, N) : null;
    const M = isIdentityCurve(c.rgb) ? null : splineLUT(c.rgb, N);
    const ch = [c.r, c.g, c.b].map(p => isIdentityCurve(p) ? null : splineLUT(p, N));
    const look = (lut, x) => { const f = x * (N - 1), i = f | 0; return i >= N - 1 ? lut[N - 1] : lut[i] + (lut[i + 1] - lut[i]) * (f - i); };
    return ch.map(C => {
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let x = i / (N - 1);
        if (P) x = look(P, x);
        if (M) x = look(M, x);
        if (C) x = look(C, x);
        out[i] = x;
      }
      return out;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Geometry: orientation, straighten, crop, transform, distortion      */
  /* ------------------------------------------------------------------ */
  function orientedSize(W, H, orient) {
    return (orient === 90 || orient === 270) ? [H, W] : [W, H];
  }

  /** Bounding box (in oriented-normalized coords) of the rotated image: what crop mode displays. */
  function rotatedBounds(W, H, geo) {
    const [Wo, Ho] = orientedSize(W, H, geo.orient);
    const a = (geo.angle || 0) * Math.PI / 180;
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const bw = (Wo * c + Ho * s) / Wo, bh = (Wo * s + Ho * c) / Ho;
    return { x: 0.5 - bw / 2, y: 0.5 - bh / 2, w: bw, h: bh };
  }

  /** True if a crop rect (oriented-normalized, display frame) lies inside the rotated image. */
  function cropInside(W, H, geo, crop, eps = 1e-4) {
    const [Wo, Ho] = orientedSize(W, H, geo.orient);
    const a = -(geo.angle || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const pts = [[crop.x, crop.y], [crop.x + crop.w, crop.y], [crop.x, crop.y + crop.h], [crop.x + crop.w, crop.y + crop.h]];
    for (const [px, py] of pts) {
      const dx = (px - 0.5) * Wo, dy = (py - 0.5) * Ho;
      const ox = c * dx - s * dy, oy = s * dx + c * dy;
      if (Math.abs(ox) > Wo / 2 * (1 + eps) || Math.abs(oy) > Ho / 2 * (1 + eps)) return false;
    }
    return true;
  }

  /** Shrink/shift crop so it stays inside the rotated image (keeps aspect ratio). */
  function constrainCrop(W, H, geo, crop) {
    let c = { ...crop };
    if (cropInside(W, H, geo, c)) return c;
    // Try shifting toward center first.
    for (let i = 0; i < 24 && !cropInside(W, H, geo, c); i++) {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      c.x += (0.5 - cx) * 0.25; c.y += (0.5 - cy) * 0.25;
    }
    if (cropInside(W, H, geo, c)) return c;
    // Binary search on scale around the (now near-center) rect center.
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let lo = 0.01, hi = 1;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      const t = { x: cx - c.w * m / 2, y: cy - c.h * m / 2, w: c.w * m, h: c.h * m };
      if (cropInside(W, H, geo, t)) lo = m; else hi = m;
    }
    return { x: cx - c.w * lo / 2, y: cy - c.h * lo / 2, w: c.w * lo, h: c.h * lo };
  }

  /** Largest crop of a given pixel aspect (w/h) centered in the rotated image. */
  function maxCropForAspect(W, H, geo, aspect) {
    const [Wo, Ho] = orientedSize(W, H, geo.orient);
    const a = (geo.angle || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const wpx = Math.min(Wo / (c + s / aspect), Ho / (s + c / aspect));
    const hpx = wpx / aspect;
    return { x: 0.5 - wpx / Wo / 2, y: 0.5 - hpx / Ho / 2, w: wpx / Wo, h: hpx / Ho };
  }

  /**
   * Geometry for a source of W×H pixels.
   * Output pixel (ox, oy) -> source pixel coords via toSource().
   */
  function buildGeometry(s, W, H, cropOverride) {
    const g = s.geo, t = s.transform || {}, lens = s.lens || {};
    const [Wo, Ho] = orientedSize(W, H, g.orient);
    const crop = cropOverride || g.crop;
    const outW = Math.max(1, Math.round(crop.w * Wo)), outH = Math.max(1, Math.round(crop.h * Ho));
    const ang = ((g.angle || 0) + (t.rotate || 0)) * Math.PI / 180;
    const ca = Math.cos(-ang), sa = Math.sin(-ang);
    const sc = (t.scale || 100) / 100;
    const asp = Math.pow(2, (t.aspect || 0) / 100 * 0.35);
    const offX = (t.offX || 0) / 100 * Wo * 0.5, offY = (t.offY || 0) / 100 * Ho * 0.5;
    const half = Math.max(Wo, Ho) / 2;
    const kv = (t.vertical || 0) / 100 * 0.4, kh = (t.horizontal || 0) / 100 * 0.4;
    const halfDiag2 = (Wo * Wo + Ho * Ho) / 4;
    const kd = (lens.distortion || 0) / 100 * 0.3;
    const p1 = +lens.p1 || 0, p2 = +lens.p2 || 0, p3 = +lens.p3 || 0, p4 = +lens.p4 || 0;
    const polyR = (p1 || p2 || p3 || p4) && lens.pr > 0 ? lens.pr * Math.sqrt(halfDiag2) : 0;
    const nonlinear = kv !== 0 || kh !== 0 || kd !== 0 || polyR !== 0;
    const x0 = crop.x * Wo - Wo / 2, y0 = crop.y * Ho - Ho / 2;
    const orient = g.orient, flipH = g.flipH, flipV = g.flipV;

    function toSource(ox, oy, out) {
      // display frame (centered, oriented px)
      const dx = x0 + ox, dy = y0 + oy;
      let px = ca * dx - sa * dy, py = sa * dx + ca * dy;
      px = px / sc - offX; py = py / sc - offY;
      px /= asp; py *= asp;
      if (nonlinear) {
        if (kv || kh) {
          const nx = px / half, ny = py / half;
          const fx = 1 + kv * ny, fy = 1 + kh * nx;
          px *= fx; py *= fy;
        }
        if (kd) {
          const f = 1 + kd * (px * px + py * py) / halfDiag2;
          px *= f; py *= f;
        }
        if (polyR) {
          // the lens itself comes last: this is where the corrected point was drawn on the sensor
          const r = Math.sqrt(px * px + py * py) / polyR;
          const f = 1 + r * (p1 + r * (p2 + r * (p3 + r * p4)));
          px *= f; py *= f;
        }
      }
      // oriented px
      let qx = px + Wo / 2, qy = py + Ho / 2;
      if (flipH) qx = Wo - qx;
      if (flipV) qy = Ho - qy;
      let sx, sy;
      switch (orient) {
        case 90: sx = qy; sy = H - qx; break;
        case 180: sx = W - qx; sy = H - qy; break;
        case 270: sx = W - qy; sy = qx; break;
        default: sx = qx; sy = qy;
      }
      out[0] = sx; out[1] = sy;
      return out;
    }

    /** Source px -> output px (Newton refinement handles nonlinear transforms). */
    function toOutput(sx, sy) {
      const p = [0, 0];
      // Affine estimate around output center
      const cx = outW / 2, cy = outH / 2;
      const a0 = toSource(cx, cy, [0, 0]);
      const ax = toSource(cx + 1, cy, [0, 0]);
      const ay = toSource(cx, cy + 1, [0, 0]);
      let j11 = ax[0] - a0[0], j21 = ax[1] - a0[1], j12 = ay[0] - a0[0], j22 = ay[1] - a0[1];
      let det = j11 * j22 - j12 * j21 || 1e-9;
      let ox = cx + ((sx - a0[0]) * j22 - (sy - a0[1]) * j12) / det;
      let oy = cy + (-(sx - a0[0]) * j21 + (sy - a0[1]) * j11) / det;
      if (nonlinear) {
        for (let it = 0; it < 6; it++) {
          const f = toSource(ox, oy, p);
          const ex = f[0] - sx, ey = f[1] - sy;
          if (Math.abs(ex) + Math.abs(ey) < 1e-3) break;
          const fx = toSource(ox + 1, oy, [0, 0]), fy = toSource(ox, oy + 1, [0, 0]);
          j11 = fx[0] - f[0]; j21 = fx[1] - f[1]; j12 = fy[0] - f[0]; j22 = fy[1] - f[1];
          det = j11 * j22 - j12 * j21 || 1e-9;
          ox -= (ex * j22 - ey * j12) / det;
          oy -= (-ex * j21 + ey * j11) / det;
        }
      }
      return [ox, oy];
    }

    const params = { x0, y0, ca, sa, sc, offX, offY, asp, half, kv, kh, halfDiag2, kd, polyR, p1, p2, p3, p4, orient, flipH: !!flipH, flipV: !!flipV };
    return { W, H, Wo, Ho, outW, outH, nonlinear, toSource, toOutput, crop, params };
  }

  /* ------------------------------------------------------------------ */
  /* Spot removal (heal / clone), applied in source space                */
  /* ------------------------------------------------------------------ */
  function applySpots(data, W, H, spots) {
    const out = new Uint8ClampedArray(data);
    const L = Math.max(W, H);
    for (const sp of spots) {
      const cx = sp.x * L, cy = sp.y * L, R = Math.max(1, sp.r * L);
      const ddx = (sp.sx - sp.x) * L, ddy = (sp.sy - sp.y) * L;
      const feather = clamp((sp.feather ?? 50) / 100, 0, 1), opacity = clamp((sp.opacity ?? 100) / 100, 0, 1);
      const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
      const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
      // Heal: match the mean color of a ring around the destination
      let off = [0, 0, 0];
      if (sp.mode !== 'clone') {
        const sumD = [0, 0, 0], sumS = [0, 0, 0]; let n = 0;
        for (let k = 0; k < 48; k++) {
          const a = k / 48 * Math.PI * 2, rr = R * 1.05;
          const px = Math.round(cx + Math.cos(a) * rr), py = Math.round(cy + Math.sin(a) * rr);
          const qx = Math.round(px + ddx), qy = Math.round(py + ddy);
          if (px < 0 || py < 0 || px >= W || py >= H || qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
          const di = (py * W + px) * 4, si = (qy * W + qx) * 4;
          for (let c = 0; c < 3; c++) { sumD[c] += data[di + c]; sumS[c] += data[si + c]; }
          n++;
        }
        if (n) off = [0, 1, 2].map(c => (sumD[c] - sumS[c]) / n);
      }
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R;
          if (d >= 1) continue;
          let wgt = (1 - smoothstep(1 - feather * 0.9 - 0.05, 1, d)) * opacity;
          if (wgt <= 0) continue;
          const qx = clamp(Math.round(x + ddx), 0, W - 1), qy = clamp(Math.round(y + ddy), 0, H - 1);
          const di = (y * W + x) * 4, si = (qy * W + qx) * 4;
          // heal offset fades toward the center so texture comes from the source
          const ho = sp.mode !== 'clone' ? 1 : 0;
          for (let c = 0; c < 3; c++) {
            const v = data[si + c] + off[c] * ho;
            out[di + c] = data[di + c] + (v - data[di + c]) * wgt;
          }
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Masks                                                               */
  /* ------------------------------------------------------------------ */
  const brushCache = new Map();
  /* Mask maps: the shape of a Subject / Sky / People mask (see aimask.js), an 8-bit greyscale image
     kept outside the settings and registered here by id — on the UI thread and in every worker. */
  const maskMaps = new Map();
  function setMaskMap(id, w, h, data) { maskMaps.set(id, { w, h, data }); }
  function hasMaskMap(id) { return maskMaps.has(id); }
  function getMaskMap(id) { return maskMaps.get(id) || null; }
  function brushRaster(mask, W, H) {
    const L = Math.max(W, H), G = 512;
    const gw = Math.max(1, Math.ceil(G * W / L)), gh = Math.max(1, Math.ceil(G * H / L));
    const dabs = mask.dabs || [];
    const map = mask.map ? maskMaps.get(mask.map.id) : null;
    let sig = 0;
    for (let i = 0; i < dabs.length; i += Math.max(1, dabs.length >> 5)) sig += dabs[i].x * 7 + dabs[i].y * 13 + dabs[i].r;
    const key = `${mask.id}:${gw}x${gh}:${dabs.length}:${sig.toFixed(5)}:${map ? mask.map.id + map.w : ''}`;
    if (brushCache.has(key)) return { grid: brushCache.get(key), gw, gh, G };
    const grid = new Float32Array(gw * gh);
    if (map) {
      // the map is the starting point; brush strokes then add to it or erase from it
      const mw = map.w, mh = map.h, md = map.data;
      for (let y = 0; y < gh; y++) {
        const fy = Math.max(0, Math.min(mh - 1, (y + 0.5) * mh / gh - 0.5)), y0 = Math.floor(fy), y1 = Math.min(mh - 1, y0 + 1), ty = fy - y0;
        for (let x = 0; x < gw; x++) {
          const fx = Math.max(0, Math.min(mw - 1, (x + 0.5) * mw / gw - 0.5)), x0 = Math.floor(fx), x1 = Math.min(mw - 1, x0 + 1), tx = fx - x0;
          grid[y * gw + x] = ((md[y0 * mw + x0] * (1 - tx) + md[y0 * mw + x1] * tx) * (1 - ty) + (md[y1 * mw + x0] * (1 - tx) + md[y1 * mw + x1] * tx) * ty) / 255;
        }
      }
    }
    for (const d of dabs) {
      const cx = d.x * G, cy = d.y * G, R = Math.max(0.5, d.r * G);
      const feather = clamp((d.feather ?? 50) / 100, 0, 1), flow = clamp((d.flow ?? 100) / 100, 0, 1);
      const xa = Math.max(0, Math.floor(cx - R)), xb = Math.min(gw - 1, Math.ceil(cx + R));
      const ya = Math.max(0, Math.floor(cy - R)), yb = Math.min(gh - 1, Math.ceil(cy + R));
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R;
        if (dist >= 1) continue;
        const v = (1 - smoothstep(1 - feather, 1.0001, dist)) * flow;
        const i = y * gw + x;
        grid[i] = d.erase ? grid[i] * (1 - v) : grid[i] + (1 - grid[i]) * v;
      }
    }
    if (brushCache.size > 24) brushCache.delete(brushCache.keys().next().value);
    brushCache.set(key, grid);
    return { grid, gw, gh, G };
  }

  /** Hue (0…1) and saturation (0…1) of a gamma-encoded colour, written to out[0], out[1]. */
  function hueSat(r, g, b, out) {
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b), c = mx - mn;
    let hh = 0;
    if (c > 1e-6) {
      if (mx === r) hh = ((g - b) / c) % 6; else if (mx === g) hh = (b - r) / c + 2; else hh = (r - g) / c + 4;
      hh /= 6; if (hh < 0) hh += 1;
    }
    out[0] = hh; out[1] = mx > 1e-4 ? c / mx : 0;
  }

  /**
   * Weight [0..1] per output pixel: the mask's own shape, narrowed by the mask it is combined with
   * (intersect: only where both are; subtract: not where the other is), times its amount.
   * SX/SY are source px coords; Y0 = gamma luma and C0 = { h, s } hue and saturation, for range limits.
   */
  function maskWeights(mask, SX, SY, Y0, N, W, H, C0, all) {
    const out = maskShape(mask, SX, SY, Y0, N, W, H, C0);
    const lim = mask.limit && all ? all.find(m => m.id === mask.limit.id && m !== mask) : null;
    if (lim) {
      const o = maskShape(lim, SX, SY, Y0, N, W, H, C0);
      if (mask.limit.mode === 'subtract') for (let i = 0; i < N; i++) out[i] *= 1 - o[i];
      else for (let i = 0; i < N; i++) out[i] *= o[i];
    }
    const amt = (mask.amount ?? 100) / 100;
    if (amt !== 1) for (let i = 0; i < N; i++) out[i] *= amt;
    return out;
  }
  /** True when a mask, or the mask it is combined with, is limited to a colour. */
  function masksNeedColor(masks, all) {
    return masks.some(m => m.colOn || (m.limit && (all || masks).some(o => o.id === m.limit.id && o.colOn)));
  }

  /** A mask's shape with its invert, luminance range and colour range — before combining and amount. */
  function maskShape(mask, SX, SY, Y0, N, W, H, C0) {
    const L = Math.max(W, H);
    const out = new Float32Array(N);
    if (mask.type === 'linear') {
      const x0 = mask.x0, y0 = mask.y0, dx = mask.x1 - mask.x0, dy = mask.y1 - mask.y0;
      const len2 = dx * dx + dy * dy || 1e-9;
      for (let i = 0; i < N; i++) {
        const u = SX[i] / L - x0, v = SY[i] / L - y0;
        const t = (u * dx + v * dy) / len2;
        out[i] = 1 - smoothstep(0, 1, t);
      }
    } else if (mask.type === 'radial') {
      const ca = Math.cos(-(mask.angle || 0) * Math.PI / 180), sa = Math.sin(-(mask.angle || 0) * Math.PI / 180);
      const feather = clamp((mask.feather ?? 50) / 100, 0, 1);
      const inner = 1 - feather;
      for (let i = 0; i < N; i++) {
        const u = SX[i] / L - mask.cx, v = SY[i] / L - mask.cy;
        const ru = (ca * u - sa * v) / mask.rx, rv = (sa * u + ca * v) / mask.ry;
        const d = Math.sqrt(ru * ru + rv * rv);
        out[i] = 1 - smoothstep(inner, 1.0001, d);
      }
    } else if (mask.type === 'brush') {
      const { grid, gw, gh, G } = brushRaster(mask, W, H);
      for (let i = 0; i < N; i++) {
        const gx = SX[i] / L * G - 0.5, gy = SY[i] / L * G - 0.5;
        const xi = clamp(Math.floor(gx), 0, gw - 1), yi = clamp(Math.floor(gy), 0, gh - 1);
        const xj = Math.min(gw - 1, xi + 1), yj = Math.min(gh - 1, yi + 1);
        const fx = clamp(gx - xi, 0, 1), fy = clamp(gy - yi, 0, 1);
        const a = grid[yi * gw + xi], b = grid[yi * gw + xj], c = grid[yj * gw + xi], d = grid[yj * gw + xj];
        out[i] = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
      }
    }
    if (mask.invert) for (let i = 0; i < N; i++) out[i] = 1 - out[i];
    // Luminance range refinement
    const lo = (mask.lumMin ?? 0) / 100, hi = (mask.lumMax ?? 100) / 100;
    if ((lo > 0 || hi < 1) && Y0) {
      const sm = Math.max(0.02, (mask.lumSmooth ?? 20) / 100 * 0.3);
      for (let i = 0; i < N; i++) {
        const y = Y0[i];
        out[i] *= smoothstep(lo - sm, lo + 1e-4, y) * (1 - smoothstep(hi - 1e-4, hi + sm, y));
      }
    }
    // Colour range refinement: only pixels whose hue is near the chosen one (greys have no hue: left out)
    if (mask.colOn && C0) {
      const hue = ((mask.colHue ?? 0) % 360) / 360, tol = clamp((mask.colRange ?? 30) / 360, 0.005, 0.5), soft = Math.max(0.02, tol * 0.5);
      const Hh = C0.h, Ss = C0.s;
      for (let i = 0; i < N; i++) {
        if (out[i] <= 0) continue;
        let d = Hh[i] - hue; d -= Math.floor(d + 0.5); if (d < 0) d = -d;
        out[i] *= (1 - smoothstep(tol, tol + soft, d)) * smoothstep(0.04, 0.12, Ss[i]);
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Calibration matrix                                                  */
  /* ------------------------------------------------------------------ */
  function calibMatrix(c) {
    if (!c || !(c.redHue || c.redSat || c.greenHue || c.greenSat || c.blueHue || c.blueSat)) return null;
    // columns = contribution of input primary; rows = output channel
    const M = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const prim = [[c.redHue, c.redSat], [c.greenHue, c.greenSat], [c.blueHue, c.blueSat]];
    for (let p = 0; p < 3; p++) {
      const h = prim[p][0] / 100 * 0.25, s = prim[p][1] / 100 * 0.25;
      const n1 = (p + 1) % 3, n2 = (p + 2) % 3;
      if (h > 0) M[n1][p] += h; else M[n2][p] -= h;
      M[p][p] += s; M[n1][p] -= s / 2; M[n2][p] -= s / 2;
    }
    return M;
  }

  /* ------------------------------------------------------------------ */
  /* Main render (split into stage functions so V8 optimizes each loop)  */
  /* ------------------------------------------------------------------ */

  /**
   * Noise reduction suited to the ISO a photo was taken at: nothing at base ISO, rising by a
   * fixed step per stop. { nrLuma, nrColor } for the Detail panel, or null when the ISO is
   * unknown or low enough to need none.
   */
  function noiseReductionForIso(iso) {
    if (!(iso >= 400)) return null;
    const stops = Math.log2(iso / 200);
    const nrLuma = Math.max(0, Math.min(60, Math.round(stops * 11)));
    return { nrLuma, nrColor: Math.max(0, Math.min(70, Math.round(nrLuma * 0.8 + 8))) };
  }

  /** One channel of an RGBA image at a fractional position (bilinear, edges repeated). */
  function sampleChannel(d, W, H, sx, sy, ch) {
    let fx = sx - 0.5, fy = sy - 0.5;
    if (fx < 0) fx = 0; else if (fx > W - 1) fx = W - 1;
    if (fy < 0) fy = 0; else if (fy > H - 1) fy = H - 1;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const a = d[((y0 * W + x0) << 2) + ch], b = d[((y0 * W + x1) << 2) + ch], c = d[((y1 * W + x0) << 2) + ch], e = d[((y1 * W + x1) << 2) + ch];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  }

  function stageGeometry(d, W, H, geo, reg, w, h, R, G, B, SX, SY, VF, lensVig, vigMid, pv, tc) {
    const vq = pv ? pv[0] : 0, v1 = pv ? pv[1] : 0, v2 = pv ? pv[2] : 0, v3 = pv ? pv[3] : 0;
    // lens profile: colour fringing (red and blue are a slightly different size from green on the sensor)
    const tcaInv = tc ? 1 / (tc[0] * Math.sqrt((W * W + H * H) / 4)) : 0;
    const bg = 0.11, inv = 1 / 255;
    const p = [0, 0];
    const affine = !geo.nonlinear;
    let ax = 0, ay = 0, bx = 0, by = 0, ox0 = 0, oy0 = 0;
    if (affine) {
      const o = geo.toSource(reg.x + 0.5, reg.y + 0.5, [0, 0]);
      const o1 = geo.toSource(reg.x + 1.5, reg.y + 0.5, [0, 0]);
      const o2 = geo.toSource(reg.x + 0.5, reg.y + 1.5, [0, 0]);
      ax = o1[0] - o[0]; ay = o1[1] - o[1]; bx = o2[0] - o[0]; by = o2[1] - o[1];
      ox0 = o[0]; oy0 = o[1];
    }
    // Fast path: pure pixel copy (no crop offset fraction, no rotation/scale)
    const identity = affine && ax === 1 && ay === 0 && bx === 0 && by === 1 &&
      Math.abs(ox0 - 0.5 - Math.round(ox0 - 0.5)) < 1e-6 && Math.abs(oy0 - 0.5 - Math.round(oy0 - 0.5)) < 1e-6 && !SX && !VF && !tc;
    if (identity) {
      const sx0 = Math.round(ox0 - 0.5), sy0 = Math.round(oy0 - 0.5);
      for (let j = 0, i = 0; j < h; j++) {
        const yy = sy0 + j;
        for (let k = 0; k < w; k++, i++) {
          const xx = sx0 + k;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) { R[i] = G[i] = B[i] = bg; continue; }
          const q = (yy * W + xx) << 2;
          R[i] = d[q] * inv; G[i] = d[q + 1] * inv; B[i] = d[q + 2] * inv;
        }
      }
      return;
    }
    const vcx = W / 2, vcy = H / 2, vr2 = (W * W + H * H) / 4, vmid = 0.2 + (vigMid / 100) * 0.6;
    const Wm1 = W - 1, Hm1 = H - 1;
    for (let j = 0, i = 0; j < h; j++) {
      for (let k = 0; k < w; k++, i++) {
        let sx, sy;
        if (affine) { sx = ox0 + ax * k + bx * j; sy = oy0 + ay * k + by * j; }
        else { geo.toSource(reg.x + k + 0.5, reg.y + j + 0.5, p); sx = p[0]; sy = p[1]; }
        if (SX !== null) { SX[i] = sx; SY[i] = sy; }
        const fx = sx - 0.5, fy = sy - 0.5;
        if (fx < -1 || fy < -1 || fx > W || fy > H) { R[i] = G[i] = B[i] = bg; if (VF !== null) VF[i] = 1; continue; }
        let x0 = Math.floor(fx), y0 = Math.floor(fy);
        let tx = fx - x0, ty = fy - y0;
        let x1 = x0 + 1, y1 = y0 + 1;
        if (x0 < 0) { x0 = 0; tx = 0; }
        if (y0 < 0) { y0 = 0; ty = 0; }
        if (x1 > Wm1) { x1 = Wm1; if (x0 > Wm1) x0 = Wm1; }
        if (y1 > Hm1) { y1 = Hm1; if (y0 > Hm1) y0 = Hm1; }
        const i00 = (y0 * W + x0) << 2, i10 = (y0 * W + x1) << 2, i01 = (y1 * W + x0) << 2, i11 = (y1 * W + x1) << 2;
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        R[i] = (d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11) * inv;
        G[i] = (d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11) * inv;
        B[i] = (d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11) * inv;
        if (tcaInv) {
          const dx = sx - W / 2, dy = sy - H / 2, r = Math.sqrt(dx * dx + dy * dy) * tcaInv;
          const fr = tc[1] + r * (tc[3] + r * tc[5]), fb = tc[2] + r * (tc[4] + r * tc[6]);
          R[i] = sampleChannel(d, W, H, W / 2 + dx * fr, H / 2 + dy * fr, 0) * inv;
          B[i] = sampleChannel(d, W, H, W / 2 + dx * fb, H / 2 + dy * fb, 2) * inv;
        }
        if (VF !== null) {
          const rr = ((sx - vcx) * (sx - vcx) + (sy - vcy) * (sy - vcy)) / vr2;
          let vf = lensVig ? 1 + lensVig * 1.4 * smoothstep(vmid * 0.5, 1.0, rr) : 1;
          if (vq) { const q = rr * vq; vf /= Math.max(0.2, 1 + q * (v1 + q * (v2 + q * v3))); }
          VF[i] = vf;
        }
      }
    }
  }

  /** One step of the à-trous wavelet transform: src smoothed by the B3 spline [1 4 6 4 1]/16 with its taps `gap` pixels apart. */
  function atrousSmooth(src, w, h, gap, tmp, out) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const a = x - 2 * gap, b = x - gap, c = x + gap, d = x + 2 * gap;
        tmp[row + x] = (src[row + (a < 0 ? 0 : a)] + src[row + (d >= w ? w - 1 : d)] + 4 * (src[row + (b < 0 ? 0 : b)] + src[row + (c >= w ? w - 1 : c)]) + 6 * src[row + x]) * 0.0625;
      }
    }
    for (let y = 0; y < h; y++) {
      const a = y - 2 * gap, b = y - gap, c = y + gap, d = y + 2 * gap;
      const ra = (a < 0 ? 0 : a) * w, rb = (b < 0 ? 0 : b) * w, rc = (c >= h ? h - 1 : c) * w, rd = (d >= h ? h - 1 : d) * w, row = y * w;
      for (let x = 0; x < w; x++) out[row + x] = (tmp[ra + x] + tmp[rd + x] + 4 * (tmp[rb + x] + tmp[rc + x]) + 6 * tmp[row + x]) * 0.0625;
    }
  }

  /**
   * Luminance noise reduction by wavelet shrinkage. The brightness is split into layers of detail
   * from fine to coarse; in each layer, differences smaller than that layer's noise level are
   * reduced and larger ones — edges, texture — are kept as they are (a "garrote": the bigger the
   * difference, the less it is touched). Unlike blending towards a blur, this removes the coarse
   * blotches of high-ISO noise as well as the fine grain, without softening edges.
   * amount 0…1; detail 0…1 keeps more of the finest layer; rs = this render's scale against full size.
   * Returns the denoised copy of Y. Thresholds depend only on the settings and the local brightness,
   * so the bands a render is split into meet without seams.
   */
  function waveletDenoise(Y, w, h, amount, detail, rs, tune) {
    // noise is finer than a pixel in a reduced preview: fewer, weaker layers there
    const levels = Math.max(1, Math.min(4, Math.round(2 + Math.log2(Math.max(0.125, rs) * 4))));
    // Layer thresholds, fine → coarse. Measured against pictures with known added noise (plain and
    // spatially correlated, three strengths): these gave the highest fidelity to the clean picture,
    // 0.03 to 1.9 dB above the blur-blend method this replaced. `tune` lets a test try others.
    const strength = tune ? tune.strength : [1, 0.35, 0.14, 0.06];
    const base = (tune ? tune.base : 0.085) * amount * Math.min(1, 0.45 + 0.55 * rs);
    const N = w * h, tmp = new Float32Array(N);
    let cur = Y, next = new Float32Array(N);
    const out = new Float32Array(N);                 // the kept detail of every layer, summed
    for (let j = 0; j < levels; j++) {
      atrousSmooth(cur, w, h, 1 << j, tmp, next);
      const T = base * strength[j] * (j === 0 ? 1.5 - detail : 1), T2 = T * T;
      for (let i = 0; i < N; i++) {
        const d = cur[i] - next[i], d2 = d * d;
        // shadows and mid-tones carry more visible noise than highlights
        const t2 = T2 * (1.25 - 0.6 * next[i]) * (1.25 - 0.6 * next[i]);
        if (d2 > t2) out[i] += d * (1 - t2 / d2);
      }
      if (j === 0) cur = new Float32Array(N);
      const swap = cur; cur = next; next = swap;
    }
    for (let i = 0; i < N; i++) out[i] += cur[i];    // plus what is left: the smooth picture
    return out;
  }

  function stageNoise(R, G, B, w, h, N, det, rs) {
    const Y = new Float32Array(N);
    for (let i = 0; i < N; i++) Y[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    if (det.nrLuma > 0) {
      const Yd = waveletDenoise(Y, w, h, det.nrLuma / 100, det.nrDetail / 100, rs);
      for (let i = 0; i < N; i++) { const sh = Yd[i] - Y[i]; R[i] += sh; G[i] += sh; B[i] += sh; Y[i] = Yd[i]; }
    }
    if (det.nrColor > 0) {
      const amt = det.nrColor / 100;
      const Cb = new Float32Array(N), Cr = new Float32Array(N);
      for (let i = 0; i < N; i++) { Cb[i] = B[i] - Y[i]; Cr[i] = R[i] - Y[i]; }
      const sig = Math.max(0.8, 4 * rs * (0.4 + amt));
      const Cb2 = blurPlane(Cb, w, h, sig), Cr2 = blurPlane(Cr, w, h, sig);
      for (let i = 0; i < N; i++) {
        const cb = Cb[i] + (Cb2[i] - Cb[i]) * amt, cr = Cr[i] + (Cr2[i] - Cr[i]) * amt;
        const y = Y[i];
        const r = y + cr, b = y + cb;
        R[i] = r; B[i] = b; G[i] = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
      }
    }
  }

  function stageLinear(R, G, B, N, VF, M, kr, kg, kb, maskW, maskAdj, loc) {
    const nM = maskW.length;
    const localLin = loc.exposure || loc.temp || loc.tint;
    const SL = SRGB_TO_LIN, LS = LIN_TO_SRGB, LN = LUT_N;
    for (let i = 0; i < N; i++) {
      let r, g, b, x, f, q;
      x = R[i]; if (x <= 0) r = 0; else if (x >= 1) r = toLin(x); else { f = x * LN; q = f | 0; r = SL[q] + (SL[q + 1] - SL[q]) * (f - q); }
      x = G[i]; if (x <= 0) g = 0; else if (x >= 1) g = toLin(x); else { f = x * LN; q = f | 0; g = SL[q] + (SL[q + 1] - SL[q]) * (f - q); }
      x = B[i]; if (x <= 0) b = 0; else if (x >= 1) b = toLin(x); else { f = x * LN; q = f | 0; b = SL[q] + (SL[q + 1] - SL[q]) * (f - q); }
      if (VF !== null) { const vf = VF[i]; r *= vf; g *= vf; b *= vf; }
      if (M !== null) {
        const r2 = M[0][0] * r + M[0][1] * g + M[0][2] * b;
        const g2 = M[1][0] * r + M[1][1] * g + M[1][2] * b;
        const b2 = M[2][0] * r + M[2][1] * g + M[2][2] * b;
        r = r2 > 0 ? r2 : 0; g = g2 > 0 ? g2 : 0; b = b2 > 0 ? b2 : 0;
      }
      r *= kr; g *= kg; b *= kb;
      if (localLin) {
        let ev = 0, lt = 0, li = 0;
        for (let m = 0; m < nM; m++) {
          const wm = maskW[m][i];
          if (wm <= 0) continue;
          const a = maskAdj[m];
          ev += a.exposure * wm; lt += a.temp * wm; li += a.tint * wm;
        }
        if (ev || lt || li) {
          const e = Math.pow(2, ev);
          if (lt || li) { const q = wbGains(lt, li); r *= q[0] * e; g *= q[1] * e; b *= q[2] * e; }
          else { r *= e; g *= e; b *= e; }
        }
      }
      if (r <= 0) R[i] = 0; else if (r >= LIN_MAX) R[i] = toSrgb(r); else { f = r * LN; q = f | 0; R[i] = LS[q] + (LS[q + 1] - LS[q]) * (f - q); }
      if (g <= 0) G[i] = 0; else if (g >= LIN_MAX) G[i] = toSrgb(g); else { f = g * LN; q = f | 0; G[i] = LS[q] + (LS[q + 1] - LS[q]) * (f - q); }
      if (b <= 0) B[i] = 0; else if (b >= LIN_MAX) B[i] = toSrgb(b); else { f = b * LN; q = f | 0; B[i] = LS[q] + (LS[q + 1] - LS[q]) * (f - q); }
    }
  }

  /**
   * Rows/columns of context a band needs so neighbourhood operations (local tone blurs, dehaze,
   * texture, sharpening, noise reduction) match a full-frame render. 0 for purely per-pixel edits,
   * which lets the engine split renders across more workers with no overlap.
   */
  function neighborhoodPad(s, L, rs) {
    const masks = (s.masks || []).filter(m => m.visible !== false);
    const loc = (k) => masks.some(m => m.adj && m.adj[k]);
    let r = 0;
    if (s.dehaze || loc('dehaze')) r = Math.max(r, 4 * Math.max(3, 0.03 * L));
    if (s.clarity || s.shadows || s.highlights || s.texture || loc('clarity') || loc('shadows') || loc('highlights') || loc('texture')) r = Math.max(r, 4 * Math.max(2, 0.016 * L));
    if (s.texture || loc('texture')) r = Math.max(r, 4 * Math.max(0.8, 0.0022 * L) + 2);
    const d = s.detail || {};
    if (d.sharpen > 0) r = Math.max(r, 4 * Math.max(d.radius || 1, 2.5) * Math.max(0.5, rs || 1) + 4);
    if (d.nrLuma > 0 || d.nrColor > 0) r = Math.max(r, 4 * 5.6 * Math.max(0.5, rs || 1) + 4);
    if (d.nrLuma > 0) r = Math.max(r, 34);          // the coarsest wavelet layer reaches 2 × (1 + 2 + 4 + 8) pixels
    if (s.lens && (s.lens.distortion || s.lens.pr || s.lens.tr)) r = Math.max(r, 3);
    return Math.min(400, Math.ceil(r));
  }

  /** Basic tone + presence (dehaze, contrast, H/S/W/B, clarity, texture). Per-pixel params include masks. */
  function stageTone(R, G, B, N, s, Yl, Yt, DC, maskW, maskAdj) {
    const nM = maskW.length;
    const gC = s.contrast, gH = s.highlights, gS = s.shadows, gW = s.whites, gB = s.blacks;
    const gTex = s.texture, gClar = s.clarity, gDeh = s.dehaze;
    for (let i = 0; i < N; i++) {
      let r = R[i], g = G[i], b = B[i];
      let cC = gC, cH = gH, cS = gS, cW = gW, cB = gB, cTex = gTex, cClar = gClar, cDeh = gDeh;
      for (let m = 0; m < nM; m++) {
        const wm = maskW[m][i];
        if (wm <= 0) continue;
        const a = maskAdj[m];
        cC += a.contrast * wm; cH += a.highlights * wm; cS += a.shadows * wm; cW += a.whites * wm; cB += a.blacks * wm;
        cTex += a.texture * wm; cClar += a.clarity * wm; cDeh += a.dehaze * wm;
      }

      if (cDeh !== 0) {
        const amt = cDeh > 100 ? 1 : cDeh < -100 ? -1 : cDeh / 100;
        if (amt > 0) {
          const t = amt * 0.85 * DC[i];
          const inv = 1 / Math.max(0.2, 1 - t);
          r = (r - t) * inv; g = (g - t) * inv; b = (b - t) * inv;
        } else {
          const t = -amt * 0.55;
          r += (0.82 - r) * t; g += (0.82 - g) * t; b += (0.84 - b) * t;
        }
      }

      if (cC !== 0) {
        const c = (cC > 100 ? 1 : cC < -100 ? -1 : cC / 100) * 0.9;
        if (r > 0 && r < 1) r += c * (r * r * (3 - 2 * r) - r);
        if (g > 0 && g < 1) g += c * (g * g * (3 - 2 * g) - g);
        if (b > 0 && b < 1) b += c * (b * b * (3 - 2 * b) - b);
      }

      if (cH !== 0 || cS !== 0 || cW !== 0 || cB !== 0) {
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const m = Yl !== null ? 0.45 * Y + 0.55 * Yl[i] : Y;
        let dY = 0;
        if (cS !== 0) {
          const sh = cS / 100, ws = 1 - smoothstep(0.02, 0.62, m);
          dY += sh > 0 ? sh * 0.42 * ws * (1 - Y) * (0.35 + Y * 1.3) : sh * 0.38 * ws * Y;
        }
        if (cH !== 0) {
          const hl = cH / 100, wh = smoothstep(0.35, 1.0, m);
          dY += hl < 0 ? hl * 0.42 * wh * Math.max(0, Y - 0.15) : hl * 0.3 * wh * Math.max(0, 1.05 - Y);
        }
        if (cW !== 0) dY += (cW / 100) * 0.26 * smoothstep(0.45, 1.05, Y);
        if (cB !== 0) dY += (cB / 100) * 0.2 * (1 - smoothstep(0, 0.5, Y));
        if (Y > 1e-4) {
          let kf = (Y + dY) / Y; kf = kf < 0 ? 0 : kf > 4 ? 4 : kf;
          // 60% multiplicative (keeps saturation), remainder additive to hit the target luma exactly
          const mf = 0.6 * kf + 0.4;
          r *= mf; g *= mf; b *= mf;
          const adj = (Y + dY) - (0.2126 * r + 0.7152 * g + 0.0722 * b);
          r += adj; g += adj; b += adj;
        } else { r += dY; g += dY; b += dY; }
      }

      if (cClar !== 0 || (cTex !== 0 && Yt !== null)) {
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let dY = 0;
        if (cClar !== 0) {
          const yc = Y < 0 ? 0 : Y > 1 ? 1 : Y;
          const t2 = 2 * yc - 1;
          const mid = 1 - t2 * t2;
          const cl = cClar > 100 ? 1 : cClar < -100 ? -1 : cClar / 100;
          dY += cl * 1.15 * (Y - Yl[i]) * (0.3 + 0.7 * mid);
        }
        if (cTex !== 0 && Yt !== null) {
          const tx = cTex > 100 ? 1 : cTex < -100 ? -1 : cTex / 100;
          dY += tx * 1.6 * (Y - Yt[i]);
        }
        r += dY; g += dY; b += dY;
        if (cClar > 0) {
          const Y2 = Y + dY, k2 = 1 + cClar / 100 * 0.08;
          r = Y2 + (r - Y2) * k2; g = Y2 + (g - Y2) * k2; b = Y2 + (b - Y2) * k2;
        }
      }
      R[i] = r; G[i] = g; B[i] = b;
    }
  }

  /** Curves, vibrance/saturation, HSL, B&W, grading, calibration tint. */
  function stageColor(R, G, B, N, s, curves, maskW, maskAdj) {
    const nM = maskW.length;
    const CN = 1023;
    const c0 = curves ? curves[0] : null, c1 = curves ? curves[1] : null, c2 = curves ? curves[2] : null;
    const hslActive = !s.bw && (s.hsl.hue.some(v => v) || s.hsl.sat.some(v => v) || s.hsl.lum.some(v => v));
    const bwActive = !!s.bw;
    const gr = s.grading;
    const zones = ['shadows', 'midtones', 'highlights', 'global'].map(z => ({
      v: gr[z], vec: hueVector(gr[z].h), active: gr[z].s > 0 || gr[z].l !== 0
    }));
    const gradingActive = zones.some(z => z.active);
    const blend = gr.blending / 100, bal = gr.balance / 100;
    const vib = s.vibrance / 100, satG = s.saturation / 100;
    const shadowTint = (s.calib.shadowTint || 0) / 100;
    const hslT = [0, 0, 0], bandW = new Float32Array(8), rgbT = [0, 0, 0];
    const hueAdj = s.hsl.hue.map(v => v / 100 * 30), satAdj = s.hsl.sat.map(v => v / 100), lumAdj = s.hsl.lum.map(v => v / 100);
    const bwMix = s.bwMix.map(v => v / 100);
    const localSat = maskAdj.some(a => a.saturation);
    const pivot = 0.5 - bal * 0.3, width = 0.08 + blend * 0.3, mWidth = 0.12 + blend * 0.3;

    for (let i = 0; i < N; i++) {
      let r = R[i], g = G[i], b = B[i];
      r = r < 0 ? 0 : r > 1 ? 1 : r; g = g < 0 ? 0 : g > 1 ? 1 : g; b = b < 0 ? 0 : b > 1 ? 1 : b;
      if (c0 !== null) {
        let f = r * CN, ii = f | 0; r = ii >= CN ? c0[CN] : c0[ii] + (c0[ii + 1] - c0[ii]) * (f - ii);
        f = g * CN; ii = f | 0; g = ii >= CN ? c1[CN] : c1[ii] + (c1[ii + 1] - c1[ii]) * (f - ii);
        f = b * CN; ii = f | 0; b = ii >= CN ? c2[CN] : c2[ii] + (c2[ii + 1] - c2[ii]) * (f - ii);
      }

      let cSat = 0;
      if (localSat) for (let m = 0; m < nM; m++) { const wm = maskW[m][i]; if (wm > 0) cSat += maskAdj[m].saturation * wm; }
      if (vib !== 0 || satG !== 0 || cSat !== 0) {
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        let f = 1 + satG + cSat / 100;
        if (vib !== 0) {
          let vb = vib * (1 - Math.min(1, (mx - mn) * 1.6));
          if (r >= g && g >= b && vib > 0) vb *= 0.55; // skin-tone protection
          f *= 1 + vb;
        }
        if (f < 0) f = 0;
        r = Y + (r - Y) * f; g = Y + (g - Y) * f; b = Y + (b - Y) * f;
      }

      if (hslActive) {
        rgbToHsl(r < 0 ? 0 : r > 1 ? 1 : r, g < 0 ? 0 : g > 1 ? 1 : g, b < 0 ? 0 : b > 1 ? 1 : b, hslT);
        if (hslT[1] > 0.004) {
          hueBandWeights(hslT[0], bandW);
          let dh = 0, ds = 0, dl = 0;
          for (let q = 0; q < 8; q++) { const bw = bandW[q]; if (bw !== 0) { dh += bw * hueAdj[q]; ds += bw * satAdj[q]; dl += bw * lumAdj[q]; } }
          const s0 = hslT[1];
          const ns = clamp(s0 * (1 + ds), 0, 1);
          const nl = clamp(hslT[2] + dl * 0.28 * Math.min(1, s0 * 1.8) * (1 - Math.abs(2 * hslT[2] - 1) * 0.5), 0, 1);
          hslToRgb(hslT[0] + dh, ns, nl, rgbT);
          r = rgbT[0]; g = rgbT[1]; b = rgbT[2];
        }
      }

      if (bwActive) {
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        rgbToHsl(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1), hslT);
        let mix = 0;
        if (hslT[1] > 0.01) {
          hueBandWeights(hslT[0], bandW);
          for (let q = 0; q < 8; q++) if (bandW[q] !== 0) mix += bandW[q] * bwMix[q];
        }
        const gy = clamp(Y + mix * hslT[1] * 0.45, 0, 1);
        r = g = b = gy;
      }

      if (gradingActive) {
        const Y = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
        const hW = 1 / (1 + Math.exp(-(Y - pivot) / width));
        const md = (Y - 0.5) / mWidth;
        const mW = Math.exp(-md * md);
        const sW = (1 - hW) * (1 - mW * 0.5), hiW = hW * (1 - mW * 0.5);
        for (let z = 0; z < 4; z++) {
          const Z = zones[z];
          if (!Z.active) continue;
          const wz = z === 0 ? sW : z === 1 ? mW : z === 2 ? hiW : 1;
          const amt = Z.v.s / 100 * 0.32 * wz;
          const lum = Z.v.l / 100 * 0.18 * wz;
          r += Z.vec[0] * amt + lum; g += Z.vec[1] * amt + lum; b += Z.vec[2] * amt + lum;
        }
      }

      if (shadowTint !== 0) {
        const Y = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1), wt = (1 - Y) * (1 - Y) * 0.06 * shadowTint;
        r += wt * 0.5; g -= wt; b += wt * 0.5;
      }
      R[i] = r; G[i] = g; B[i] = b;
    }
  }

  /** Post-crop vignette and film grain (position dependent). */
  function stageEffects(R, G, B, w, h, reg, outW, outH, eff, rs, seed) {
    const vigA = eff.vigAmount / 100, grainA = eff.grain / 100;
    if (!vigA && !grainA) return;
    const minD = Math.min(outW, outH);
    const vigInner = 0.12 + (eff.vigMid / 100) * 0.95, vigOuter = vigInner + 0.04 + (eff.vigFeather / 100) * 1.1;
    const vigRoundT = (eff.vigRound + 100) / 200;
    const hlProt = eff.vigHighlights / 100;
    const grainCell = (0.6 + eff.grainSize / 100 * 3.2);
    const grainRough = eff.grainRough / 100;
    for (let j = 0, i = 0; j < h; j++) {
      const oy = reg.y + j;
      const dy = ((oy + 0.5) / outH) * 2 - 1;
      for (let k = 0; k < w; k++, i++) {
        let r = R[i], g = G[i], b = B[i];
        const ox = reg.x + k;
        if (vigA !== 0) {
          const dx = ((ox + 0.5) / outW) * 2 - 1;
          const dEll = Math.sqrt(dx * dx + dy * dy);
          const cx = dx * outW / minD, cy = dy * outH / minD;
          const dCir = Math.sqrt(cx * cx + cy * cy) * 0.82;
          const v = smoothstep(vigInner, vigOuter, dEll + (dCir - dEll) * vigRoundT);
          if (v > 0) {
            if (vigA < 0) {
              let f = 1 + vigA * v;
              if (hlProt) {
                const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                f += (1 - f) * hlProt * smoothstep(0.55, 1, Y);
              }
              r *= f; g *= f; b *= f;
            } else {
              const t = vigA * v;
              r += (1 - r) * t; g += (1 - g) * t; b += (1 - b) * t;
            }
          }
        }
        if (grainA !== 0) {
          const gx = ox / rs / grainCell, gy = oy / rs / grainCell;
          let n = valueNoise(gx, gy, seed) - 0.5;
          if (grainRough) n = n * (1 - grainRough * 0.5) + (valueNoise(gx * 2.3 + 17, gy * 2.3 + 31, seed + 7) - 0.5) * grainRough * 0.7;
          const Y = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
          const amp = grainA * 0.28 * (0.35 + 2.6 * Y * (1 - Y));
          r += n * amp; g += n * amp; b += n * amp;
        }
        R[i] = r; G[i] = g; B[i] = b;
      }
    }
  }

  function stageSharpen(R, G, B, w, h, N, det, rs) {
    const Y = new Float32Array(N);
    for (let i = 0; i < N; i++) Y[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    const Yb = blurPlane(Y, w, h, Math.max(0.5, det.radius * Math.max(0.5, rs)));
    const amt = det.sharpen / 100 * 1.4;
    const lim = 0.03 + (det.detail / 100) * 0.22;
    const mk = det.masking / 100;
    const Ym = mk > 0 ? blurPlane(Y, w, h, Math.max(1, 2.5 * rs)) : null;
    const m0 = mk * 0.012, m1 = mk * 0.05 + 0.002;
    for (let i = 0; i < N; i++) {
      let d = Y[i] - Yb[i];
      d = d > lim ? lim : d < -lim ? -lim : d;
      let m = 1;
      if (Ym !== null) { const e = Y[i] - Ym[i]; m = smoothstep(m0, m1, e < 0 ? -e : e); }
      const v = d * amt * m;
      R[i] += v; G[i] += v; B[i] += v;
    }
  }

  function stageOutput(R, G, B, w, reg0, reg, clipHi, clipLo, ovW, want16, conv) {
    if (conv) gamutTables();
    const ox = reg0.x - reg.x, oy = reg0.y - reg.y;
    const outw = Math.max(1, reg0.w), outh = Math.max(1, reg0.h);
    const out = new Uint8ClampedArray(outw * outh * 4);
    // 16 bits per channel (RGB) for exports that ask for it: the edit's own precision, not rounded to 8 bits
    const out16 = want16 ? new Uint16Array(outw * outh * 3) : null;
    const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256), hl = new Uint32Array(256);
    let nHi = 0, nLo = 0;
    for (let j = 0; j < outh; j++) {
      let si = (j + oy) * w + ox;
      let di = (j * outw) << 2;
      for (let k = 0; k < outw; k++, si++, di += 4) {
        let x = R[si], y = G[si], z = B[si];
        if (conv) {
          const lr = fLin(x), lg = fLin(y), lb = fLin(z);
          x = fEnc(conv[0] * lr + conv[1] * lg + conv[2] * lb); y = fEnc(conv[3] * lr + conv[4] * lg + conv[5] * lb); z = fEnc(conv[6] * lr + conv[7] * lg + conv[8] * lb);
        }
        if (out16 !== null) {
          const q = (j * outw + k) * 3;
          out16[q] = x <= 0 ? 0 : x >= 1 ? 65535 : x * 65535 + 0.5; out16[q + 1] = y <= 0 ? 0 : y >= 1 ? 65535 : y * 65535 + 0.5; out16[q + 2] = z <= 0 ? 0 : z >= 1 ? 65535 : z * 65535 + 0.5;
        }
        let r = x * 255 + 0.5, g = y * 255 + 0.5, b = z * 255 + 0.5;
        r = r < 0 ? 0 : r > 255 ? 255 : r | 0; g = g < 0 ? 0 : g > 255 ? 255 : g | 0; b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
        hr[r]++; hg[g]++; hb[b]++;
        hl[(r * 54 + g * 183 + b * 19) >> 8]++;
        if (r >= 255 || g >= 255 || b >= 255) { nHi++; if (clipHi) { r = 255; g = 40; b = 40; } }
        else if (r <= 0 && g <= 0 && b <= 0) { nLo++; if (clipLo) { r = 40; g = 90; b = 255; } }
        if (ovW !== null) {
          const a = ovW[si] * 0.55;
          r = r + (230 - r) * a; g = g + (30 - g) * a; b = b + (60 - b) * a;
        }
        out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = 255;
      }
    }
    return { out, out16, outw, outh, hist: { r: hr, g: hg, b: hb, l: hl }, clip: { hi: nHi, lo: nLo } };
  }

  /**
   * job = {
   *   src: {data: Uint8ClampedArray RGBA, width, height},
   *   settings, fullLongEdge, seed,
   *   opts: { before, region:{x,y,w,h} (output px), cropOverride, clipping:{hi,lo}, overlayMask: index|-1 }
   * }
   */
  function render(job) {
    const opts = job.opts || {};
    let s = normalizeSettings(job.settings);
    if (opts.before) s = beforeSettings(s);
    const src = job.src;
    const W = src.width, H = src.height, L = Math.max(W, H);
    const rs = Math.min(1, L / (job.fullLongEdge || L)); // preview resolution relative to full
    let sdata = src.data;
    if (s.spots && s.spots.length) sdata = applySpots(sdata, W, H, s.spots);

    const geo = buildGeometry(s, W, H, opts.cropOverride);
    // Region (with padding for neighbourhood ops)
    let reg0 = { x: 0, y: 0, w: geo.outW, h: geo.outH };
    if (opts.region) {
      const x = clamp(Math.floor(opts.region.x), 0, geo.outW - 1), y = clamp(Math.floor(opts.region.y), 0, geo.outH - 1);
      reg0 = { x, y, w: Math.max(1, Math.min(geo.outW - x, Math.ceil(opts.region.w))), h: Math.max(1, Math.min(geo.outH - y, Math.ceil(opts.region.h))) };
    }
    const pad = opts.region ? neighborhoodPad(s, L, rs) : 0;
    const reg = { x: Math.max(0, reg0.x - pad), y: Math.max(0, reg0.y - pad), w: 0, h: 0 };
    reg.w = Math.min(geo.outW, reg0.x + reg0.w + pad) - reg.x;
    reg.h = Math.min(geo.outH, reg0.y + reg0.h + pad) - reg.y;
    const w = Math.max(1, reg.w), h = Math.max(1, reg.h), N = w * h;

    const masks = (s.masks || []).filter(m => m.visible !== false);
    const ovIdx = opts.overlayMask ?? -1;
    const needCoords = masks.length > 0 || (ovIdx >= 0 && s.masks[ovIdx]);
    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
    const SX = needCoords ? new Float32Array(N) : null, SY = needCoords ? new Float32Array(N) : null;
    const lensVig = (s.lens.vignette || 0) / 100;
    const profVig = s.lens.vq > 0 && (s.lens.v1 || s.lens.v2 || s.lens.v3) ? [s.lens.vq, +s.lens.v1 || 0, +s.lens.v2 || 0, +s.lens.v3 || 0] : null;
    const VF = lensVig || profVig ? new Float32Array(N) : null;

    // 1. Geometry resample
    const tca = s.lens.tr > 0 ? [s.lens.tr, +s.lens.tvr || 1, +s.lens.tvb || 1, +s.lens.tcr || 0, +s.lens.tcb || 0, +s.lens.tbr || 0, +s.lens.tbb || 0] : null;
    stageGeometry(sdata, W, H, geo, reg, w, h, R, G, B, SX, SY, VF, lensVig, s.lens.vigMid, profVig, tca);
    const cube = opts.cube && s.lut && s.lut.id && s.lut.id === opts.cube.id && s.lut.amount > 0 ? opts.cube : null;
    const wide = isWide(s, opts);
    if (cube && s.lut.stage === 'input') applyCube(R, G, B, N, cube, s.lut.amount / 100);
    else if (s.input && s.input.profile !== 'none') stageInput(R, G, B, N, s.input);
    else if (opts.srcInput) stageSourceInput(R, G, B, N, opts.srcInput, wide);

    // 2. Noise reduction
    const det = s.detail;
    if (det.nrLuma > 0 || det.nrColor > 0) stageNoise(R, G, B, w, h, N, det, rs);

    // 3. Mask weights
    let Y0 = null, C0 = null;
    const maskW = [], maskAdj = [];
    if (needCoords) {
      Y0 = new Float32Array(N);
      for (let i = 0; i < N; i++) Y0[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
      if (masksNeedColor(s.masks, s.masks)) {
        C0 = { h: new Float32Array(N), s: new Float32Array(N) };
        const hs = [0, 0];
        for (let i = 0; i < N; i++) { hueSat(R[i], G[i], B[i], hs); C0.h[i] = hs[0]; C0.s[i] = hs[1]; }
      }
      for (const m of masks) {
        const adj = Object.assign(defaultLocalAdj(), m.adj || {});
        if (!LOCAL_KEYS.some(k => adj[k])) continue;
        maskW.push(maskWeights(m, SX, SY, Y0, N, W, H, C0, s.masks));
        maskAdj.push(adj);
      }
    }
    const loc = {};
    LOCAL_KEYS.forEach(k => { loc[k] = maskAdj.some(a => a[k]); });

    // 4. Linear stage (skipped when it would be an identity round-trip)
    const M = calibMatrix(s.calib);
    const [gr, gg, gb] = wbGains(s.temp, s.tint);
    const em = Math.pow(2, s.exposure || 0);
    if (VF || M || s.temp || s.tint || s.exposure || loc.exposure || loc.temp || loc.tint) {
      stageLinear(R, G, B, N, VF, M, gr * em, gg * em, gb * em, maskW, maskAdj, loc);
    }

    // 5. Neighbourhood luma planes
    let Yl = null, Yt = null, DC = null;
    if (s.clarity || s.texture || s.dehaze || s.highlights || s.shadows ||
      loc.clarity || loc.texture || loc.dehaze || loc.highlights || loc.shadows) {
      const Y = new Float32Array(N);
      for (let i = 0; i < N; i++) { const y = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i]; Y[i] = y > 1.5 ? 1.5 : y; }
      Yl = blurPlane(Y, w, h, Math.max(2, 0.016 * L), reg.x, reg.y);
      if (s.texture || loc.texture) Yt = blurPlane(Y, w, h, Math.max(0.8, 0.0022 * L), reg.x, reg.y);
      if (s.dehaze || loc.dehaze) {
        const D = new Float32Array(N);
        for (let i = 0; i < N; i++) D[i] = Math.min(R[i], G[i], B[i]);
        DC = blurPlane(D, w, h, Math.max(3, 0.03 * L), reg.x, reg.y);
      }
    }

    // 6. Tone & presence, then color
    if (s.contrast || s.highlights || s.shadows || s.whites || s.blacks || s.texture || s.clarity || s.dehaze ||
      loc.contrast || loc.highlights || loc.shadows || loc.whites || loc.blacks || loc.texture || loc.clarity || loc.dehaze) {
      stageTone(R, G, B, N, s, Yl, Yt, DC, maskW, maskAdj);
    }
    // decided per image (not per band) so every band of a render takes the same path
    if (geo.outW * geo.outH >= COLOR_LUT_MIN_PIXELS && !s.bw && !maskAdj.some(a => a.saturation) && colorSig(s) !== DEFAULT_COLOR_SIG) { const n = lutSizeFor(geo.outW * geo.outH); applyColorLUT(R, G, B, N, cachedColorLUT(s, n), n); }
    else stageColor(R, G, B, N, s, buildCurveLUTs(s.curve), maskW, maskAdj);
    if (cube && s.lut.stage !== 'input') {
      // a look is written for sRGB / Rec.709 values: in wide colour it is applied there and brought back
      if (wide) convertPlanes(R, G, B, N, P3_TO_SRGB);
      applyCube(R, G, B, N, cube, s.lut.amount / 100);
      if (wide) convertPlanes(R, G, B, N, SRGB_TO_P3);
    }

    // 7. Effects & sharpening
    stageEffects(R, G, B, w, h, reg, geo.outW, geo.outH, s.effects, rs, job.seed | 0);
    if (det.sharpen > 0) stageSharpen(R, G, B, w, h, N, det, rs);

    // 8. Output
    let ovW = null;
    if (ovIdx >= 0 && s.masks[ovIdx] && SX) ovW = maskWeights(s.masks[ovIdx], SX, SY, Y0, N, W, H, C0, s.masks);
    const o = stageOutput(R, G, B, w, reg0, reg, opts.clipping && opts.clipping.hi, opts.clipping && opts.clipping.lo, ovW, !!opts.out16, wide && opts.outSpace !== 'p3' ? P3_TO_SRGB : null);
    return {
      space: wide && opts.outSpace === 'p3' ? 'p3' : 'srgb',
      data: o.out, data16: o.out16, width: o.outw, height: o.outh,
      fullWidth: geo.outW, fullHeight: geo.outH,
      region: { x: reg0.x, y: reg0.y, w: o.outw, h: o.outh },
      hist: o.hist, clip: o.clip
    };
  }

  /* ------------------------------------------------------------------ */
  /* Analysis helpers (auto tone / auto WB)                              */
  /* ------------------------------------------------------------------ */
  function percentile(hist, total, p) {
    let acc = 0; const target = total * p;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; }
    return 1;
  }
  /** Compute Lightroom-like auto tone values from a neutral render histogram. */
  function autoToneFromHist(hl) {
    let total = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < 256; i++) { total += hl[i]; sum += hl[i] * i / 255; sum2 += hl[i] * (i / 255) * (i / 255); }
    if (!total) return {};
    const med = Math.max(0.02, percentile(hl, total, 0.5));
    const lo = percentile(hl, total, 0.005), hi = percentile(hl, total, 0.995);
    const mean = sum / total, std = Math.sqrt(Math.max(0, sum2 / total - mean * mean));
    let ev = Math.log2(toLin(0.46) / toLin(med)) * 0.75;
    ev = clamp(ev, -2.5, 2.5);
    const scale = Math.pow(2, ev);
    const hi2 = toSrgb(toLin(hi) * scale), lo2 = toSrgb(toLin(lo) * scale);
    let fracHi = 0, fracLo = 0;
    for (let i = 0; i < 256; i++) {
      const v = toSrgb(toLin(i / 255) * scale);
      if (v > 0.88) fracHi += hl[i];
      if (v < 0.18) fracLo += hl[i];
    }
    fracHi /= total; fracLo /= total;
    const r5 = v => Math.round(v) || 0;
    return {
      exposure: Math.round(ev * 100) / 100,
      contrast: r5(clamp((0.22 - std) * 160, -30, 40)),
      highlights: r5(-clamp(fracHi * 260 + (hi2 > 0.98 ? 20 : 0), 0, 80)),
      shadows: r5(clamp(fracLo * 220 + 8, 0, 70)),
      whites: r5(clamp((0.97 - hi2) * 160, -40, 50)),
      blacks: r5(clamp((0.025 - lo2) * 300 - 6, -40, 20)),
      vibrance: 12,
      saturation: 2
    };
  }

  /* ------------------------------------------------------------------ */
  /* Pixel buffers & resizing (shared by the UI thread and workers)      */
  /* ------------------------------------------------------------------ */
  /** With cross-origin isolation, pixel buffers live in shared memory so workers read them without copies. */
  const SHARED = typeof SharedArrayBuffer !== 'undefined' && !!(typeof self !== 'undefined' && self.crossOriginIsolated);
  function allocPixels(n) { return new Uint8ClampedArray(SHARED ? new SharedArrayBuffer(n) : new ArrayBuffer(n)); }
  function copyPixels(src) { const o = allocPixels(src.length); o.set(src); return o; }
  function isShared(a) { return typeof SharedArrayBuffer !== 'undefined' && a && a.buffer instanceof SharedArrayBuffer; }
  function halve(src) {
    const w = src.width, h = src.height, d = src.data;
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const out = allocPixels(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
        const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, e = (y1 * w + x1) * 4;
        const o = (y * nw + x) * 4;
        out[o] = (d[a] + d[b] + d[c] + d[e] + 2) >> 2;
        out[o + 1] = (d[a + 1] + d[b + 1] + d[c + 1] + d[e + 1] + 2) >> 2;
        out[o + 2] = (d[a + 2] + d[b + 2] + d[c + 2] + d[e + 2] + 2) >> 2;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: nw, height: nh };
  }
  /** Bilinear resize to an exact size (used for the final, < 2× step). */
  function bilinear(src, tw, th) {
    const w = src.width, h = src.height, d = src.data;
    const out = allocPixels(tw * th * 4);
    const sx = w / tw, sy = h / th;
    for (let y = 0; y < th; y++) {
      const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.min(h - 1, fy | 0), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < tw; x++) {
        const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.min(w - 1, fx | 0), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
        const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, e = (y1 * w + x1) * 4;
        const o = (y * tw + x) * 4;
        for (let k = 0; k < 3; k++) {
          const top = d[a + k] + (d[b + k] - d[a + k]) * tx, bot = d[c + k] + (d[e + k] - d[c + k]) * tx;
          out[o + k] = top + (bot - top) * ty + 0.5;
        }
        out[o + 3] = 255;
      }
    }
    return { data: out, width: tw, height: th };
  }
  /** Downscale RGBA pixels so the long edge is <= maxEdge. Returns a plain {data,width,height}. */
  function resizePixels(src, maxEdge) {
    const s = Math.min(1, maxEdge / Math.max(src.width, src.height));
    const tw = Math.max(1, Math.round(src.width * s)), th = Math.max(1, Math.round(src.height * s));
    let cur = src;
    while (cur.width >= tw * 2 && cur.height >= th * 2) cur = halve(cur);
    if (cur.width === tw && cur.height === th) return cur === src ? { data: copyPixels(src.data), width: tw, height: th } : cur;
    return bilinear(cur, tw, th);
  }


  /** Apply an EXIF orientation (1–8) to RGBA pixels. */
  function orientPixels(src, o) {
    const { width: w, height: h, data: d } = src;
    if (!o || o === 1) return src;
    const swap = o >= 5;
    const W = swap ? h : w, H = swap ? w : h;
    const out = allocPixels(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let sx, sy;
      switch (o) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        case 8: sx = w - 1 - y; sy = x; break;
        default: sx = x; sy = y;
      }
      const si = (sy * w + sx) * 4, di = (y * W + x) * 4;
      out[di] = d[si]; out[di + 1] = d[si + 1]; out[di + 2] = d[si + 2]; out[di + 3] = d[si + 3];
    }
    return { data: out, width: W, height: H };
  }

  /* ------------------------------------------------------------------ */
  /* Auto color grade                                                    */
  /* ------------------------------------------------------------------ */
  const GRADE_STYLES = {
    auto: { label: 'Auto (match the scene)' },
    balance: { label: 'Balanced — remove color casts' },
    cinematic: { label: 'Cinematic — teal & orange' },
    warm: { label: 'Warm & golden' },
    cool: { label: 'Cool & clean' },
    moody: { label: 'Moody' },
    film: { label: 'Film' },
    pastel: { label: 'Soft pastel' }
  };
  const GRADE_STRENGTH = { subtle: 0.6, normal: 1, strong: 1.5 };

  /**
   * Analyse an 8-bit RGBA render (with grading, vibrance and saturation neutral) and
   * return { grading, vibrance, saturation, analysis } for a look. Chroma is measured in
   * the same opponent plane the grading wheels push in (unit vector = hueVector(h)).
   */
  function analyzeForGrade(data, w, h) {
    const n = w * h, step = Math.max(1, Math.floor(n / 60000));
    const pivot = 0.5, width = 0.23, mWidth = 0.27;  // grading defaults (blending 50, balance 0)
    const SX = [], SY = [], SZ = [[], [], []]; // chroma samples + zone weights for cast estimation
    let rgSum = 0, ybSum = 0, rg2 = 0, yb2 = 0, cnt = 0, skin = 0, warm = 0, wsum = 0, ySum = 0;
    const hueHist = new Float32Array(36);
    const hsl = [0, 0, 0];
    for (let i = 0; i < n; i += step) {
      const o = i * 4, r = data[o] / 255, g = data[o + 1] / 255, b = data[o + 2] / 255;
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      cnt++; ySum += Y;
      const rg = (r - g) * 255, yb = (0.5 * (r + g) - b) * 255;
      rgSum += rg; ybSum += yb; rg2 += rg * rg; yb2 += yb * yb;
      if (Y < 0.03 || Y > 0.97) continue;
      const cx = (2 * r - g - b) / 2, cy = 0.8660254 * (g - b);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx - mn;
      rgbToHsl(r, g, b, hsl);
      if (hsl[0] >= 8 && hsl[0] <= 50 && hsl[1] > 0.12 && hsl[1] < 0.75 && Y > 0.2 && Y < 0.88 && r > g && g > b) skin++;
      if (sat > 0.12) hueHist[Math.floor(hsl[0] / 10) % 36] += sat;
      // warm/cool axis (orange ≈ 35°)
      warm += (cx * 0.819 + cy * 0.574) * (0.3 + sat); wsum += 0.3 + sat;
      if (sat > 0.45) continue; // vivid objects never describe the light
      const hW = 1 / (1 + Math.exp(-(Y - pivot) / width));
      const md = (Y - 0.5) / mWidth, mW = Math.exp(-md * md);
      SX.push(cx); SY.push(cy);
      SZ[0].push((1 - hW) * (1 - mW * 0.5)); SZ[1].push(mW); SZ[2].push(hW * (1 - mW * 0.5));
    }
    // Cast per zone: mean-shift toward the largest cluster of similar chroma near grey —
    // a color cast moves everything that should be neutral by the same amount.
    const castFor = (zw) => {
      let sw = 0, cx = 0, cy = 0;
      for (let i = 0; i < SX.length; i++) { const wgt = zw[i] / (1 + 40 * (SX[i] * SX[i] + SY[i] * SY[i])); cx += wgt * SX[i]; cy += wgt * SY[i]; sw += wgt; }
      if (sw < 1e-6) return { x: 0, y: 0, w: 1, conf: 0 };
      cx /= sw; cy /= sw;
      const s2 = 0.05 * 0.05;
      let mass = 0, total = 0, wz = 0;
      for (let it = 0; it < 6; it++) {
        let nx = 0, ny = 0, ns = 0; mass = 0; total = 0; wz = 0;
        for (let i = 0; i < SX.length; i++) {
          const dx = SX[i] - cx, dy = SY[i] - cy, k = Math.exp(-(dx * dx + dy * dy) / (2 * s2)) * zw[i];
          nx += k * SX[i]; ny += k * SY[i]; ns += k; wz += k * zw[i]; total += zw[i];
        }
        if (ns < 1e-9) break;
        cx = nx / ns; cy = ny / ns; mass = ns;
      }
      const mag = Math.hypot(cx, cy);
      // need a real cluster; very strong "casts" are more likely colored content (sky, foliage)
      const conf = Math.min(1, (mass / Math.max(1e-9, total)) / 0.25) * Math.max(0, Math.min(1, (0.24 - mag) / 0.08));
      return { x: cx, y: cy, w: mass ? wz / mass : 1, conf };
    };
    const casts = SZ.map(castFor);
    const mrg = rgSum / cnt, myb = ybSum / cnt;
    const colorfulness = Math.sqrt(Math.max(0, rg2 / cnt - mrg * mrg) + Math.max(0, yb2 / cnt - myb * myb)) + 0.3 * Math.sqrt(mrg * mrg + myb * myb);
    let domHue = -1, best = 0;
    for (let k = 0; k < 36; k++) { const v = hueHist[k] + 0.5 * (hueHist[(k + 35) % 36] + hueHist[(k + 1) % 36]); if (v > best) { best = v; domHue = k * 10 + 5; } }
    return { casts, colorfulness, skin: skin / cnt, warmth: wsum ? warm / wsum : 0, meanY: ySum / cnt, domHue };
  }

  function autoGrade(data, w, h, style, strength) {
    const A = analyzeForGrade(data, w, h);
    const k = GRADE_STRENGTH[strength] ?? (typeof strength === 'number' ? strength : 1);
    const vec = (hDeg, s) => [Math.cos(hDeg * Math.PI / 180) * s, Math.sin(hDeg * Math.PI / 180) * s];
    // zone vectors in wheel units (|v| = saturation/100)
    const V = { shadows: [0, 0], midtones: [0, 0], highlights: [0, 0], global: [0, 0] };
    const add = (z, hDeg, s) => { const v = vec(hDeg, s / 100); V[z][0] += v[0]; V[z][1] += v[1]; };
    // 1. neutralize casts (every style starts here; "balance" stops here)
    const neutral = style === 'balance' ? 0.9 : 0.7;
    ['shadows', 'midtones', 'highlights'].forEach((z, i) => {
      const c = A.casts[i], mag = Math.hypot(c.x, c.y);
      if (mag < 0.006 || !c.conf) return;
      // soft threshold: tiny casts are often intended (warm light), big ones are corrected most of the way
      const eff = mag - 0.004;
      const s = Math.min(30, eff / (0.32 * Math.max(0.35, c.w)) * 100 * neutral * c.conf);
      V[z][0] -= c.x / mag * s / 100; V[z][1] -= c.y / mag * s / 100;
    });
    // 2. the look, scaled down for already-colorful images and for skin
    const damp = clamp(1.25 - A.colorfulness / 90, 0.45, 1.15) * 1.25 * k;
    const skinGuard = 1 - Math.min(0.5, A.skin * 3);
    let vib = 0, sat = 0, blending = 50, balance = 0;
    switch (style) {
      case 'balance':
        vib = A.colorfulness < 25 ? 10 : 0;
        break;
      case 'cinematic':
        add('shadows', 195, 26 * damp * skinGuard); add('highlights', 36, 20 * damp); add('midtones', 30, 4 * damp);
        vib = 12; sat = -6; blending = 62; balance = -8;
        break;
      case 'warm':
        add('highlights', 42, 20 * damp); add('midtones', 32, 9 * damp); add('shadows', 22, 7 * damp);
        vib = 10; sat = 2; blending = 55;
        break;
      case 'cool':
        add('highlights', 200, 9 * damp); add('shadows', 218, 16 * damp); add('midtones', 205, 4 * damp * skinGuard);
        vib = 6; sat = -6; blending = 55;
        break;
      case 'moody':
        add('shadows', 205, 24 * damp); add('highlights', 40, 11 * damp); add('global', 210, 3 * damp);
        vib = 4; sat = -18; blending = 70; balance = -15;
        break;
      case 'film':
        add('shadows', 168, 17 * damp * skinGuard); add('highlights', 46, 18 * damp); add('midtones', 28, 6 * damp);
        vib = 5; sat = -12; blending = 60; balance = 5;
        break;
      case 'pastel':
        add('highlights', 330, 10 * damp); add('shadows', 190, 10 * damp); add('midtones', 20, 5 * damp);
        vib = -8; sat = -14; blending = 70; balance = 20;
        break;
      default: { // auto: separate warm & cool along the scene's own axis
        const t = clamp(A.warmth * 6, -1, 1); // >0 warm scene, <0 cool scene
        const hiHue = t >= 0 ? 38 : 45, shHue = t >= 0 ? 195 : 212;
        add('highlights', hiHue, (10 + 10 * Math.max(0, t)) * damp);
        add('shadows', shHue, (12 + 10 * Math.max(0, -t) + 6 * Math.max(0, t)) * damp * skinGuard);
        // a dominant non-skin hue in the scene gets a hint of its complement in the shadows for separation
        if (A.domHue >= 0 && (A.domHue < 10 || A.domHue > 55)) add('shadows', (A.domHue + 180) % 360, 4 * damp * skinGuard);
        vib = A.colorfulness < 30 ? 16 : A.colorfulness < 55 ? 9 : 2;
        sat = A.colorfulness > 80 ? -6 : 0;
        blending = 58; balance = A.meanY < 0.35 ? 12 : A.meanY > 0.65 ? -12 : 0;
      }
    }
    const zone = (v) => {
      const s = Math.min(100, Math.round(Math.hypot(v[0], v[1]) * 100));
      let hd = Math.round(Math.atan2(v[1], v[0]) * 180 / Math.PI);
      if (hd < 0) hd += 360;
      return { h: s ? hd : 0, s, l: 0 };
    };
    const grading = { shadows: zone(V.shadows), midtones: zone(V.midtones), highlights: zone(V.highlights), global: zone(V.global), blending, balance };
    if (style === 'moody') grading.shadows.l = -6;
    if (style === 'pastel') grading.shadows.l = 6;
    return { grading, vibrance: Math.round(vib * Math.min(1.3, k)), saturation: Math.round(sat * Math.min(1.3, k)), analysis: A };
  }

  /**
   * 3D LUT (n×n×n, red fastest) of the per-pixel color stage — curves, vibrance/saturation,
   * HSL, B&W mix, color grading, calibration tint — for the GPU renderer. Input is clamped
   * sRGB-encoded [0,1], exactly like stageColor.
   */
  /* Large renders run the colour stage through a 65³ LUT (tetrahedral interpolation), built once per
     colour setting and cached per worker; small interactive drafts use the exact per-pixel path. */
  /* Full-quality renders use 65³; live drafts use 33³ (8× cheaper to rebuild while a colour slider moves). */
  const COLOR_LUT_MIN_PIXELS = 150000;
  const lutSizeFor = (px) => px >= 600000 ? 65 : 33;
  const colorLutCache = new Map(); // `${n}|${sig}` -> lut
  function colorSig(s) { return JSON.stringify([s.curve, s.vibrance, s.saturation, s.hsl, s.grading, s.calib.shadowTint]); }
  const DEFAULT_COLOR_SIG = colorSig(defaultSettings());
  function cachedColorLUT(s, n) {
    const key = n + '|' + colorSig(s);
    let lut = colorLutCache.get(key);
    if (!lut) {
      lut = colorLUT(s, n);
      colorLutCache.set(key, lut);
      while (colorLutCache.size > 4) colorLutCache.delete(colorLutCache.keys().next().value);
    }
    return lut;
  }
  function applyColorLUT(R, G, B, N, lut, n) {
    const m = n - 1, sg = n * 4, sb = n * n * 4;
    for (let i = 0; i < N; i++) {
      let r = R[i], g = G[i], b = B[i];
      r = (r <= 0 ? 0 : r >= 1 ? 1 : r) * m; g = (g <= 0 ? 0 : g >= 1 ? 1 : g) * m; b = (b <= 0 ? 0 : b >= 1 ? 1 : b) * m;
      let ir = r | 0, ig = g | 0, ib = b | 0;
      if (ir >= m) ir = m - 1; if (ig >= m) ig = m - 1; if (ib >= m) ib = m - 1;
      const dr = r - ir, dg = g - ig, db = b - ib;
      const c0 = ((ib * n + ig) * n + ir) * 4, c3 = c0 + 4 + sg + sb;
      let c1, c2, w0, w1, w2, w3;
      if (dr >= dg) {
        if (dg >= db) { c1 = c0 + 4; c2 = c1 + sg; w0 = 1 - dr; w1 = dr - dg; w2 = dg - db; w3 = db; }
        else if (dr >= db) { c1 = c0 + 4; c2 = c1 + sb; w0 = 1 - dr; w1 = dr - db; w2 = db - dg; w3 = dg; }
        else { c1 = c0 + sb; c2 = c1 + 4; w0 = 1 - db; w1 = db - dr; w2 = dr - dg; w3 = dg; }
      } else if (db >= dg) { c1 = c0 + sb; c2 = c1 + sg; w0 = 1 - db; w1 = db - dg; w2 = dg - dr; w3 = dr; }
      else if (db >= dr) { c1 = c0 + sg; c2 = c1 + sb; w0 = 1 - dg; w1 = dg - db; w2 = db - dr; w3 = dr; }
      else { c1 = c0 + sg; c2 = c1 + 4; w0 = 1 - dg; w1 = dg - dr; w2 = dr - db; w3 = db; }
      R[i] = w0 * lut[c0] + w1 * lut[c1] + w2 * lut[c2] + w3 * lut[c3];
      G[i] = w0 * lut[c0 + 1] + w1 * lut[c1 + 1] + w2 * lut[c2 + 1] + w3 * lut[c3 + 1];
      B[i] = w0 * lut[c0 + 2] + w1 * lut[c1 + 2] + w2 * lut[c2 + 2] + w3 * lut[c3 + 2];
    }
  }

  /* ------------------------------------------------------------------ */
  /* Imported .cube LUTs                                                 */
  /* ------------------------------------------------------------------ */
  /**
   * Parse an Adobe/Resolve .cube file into a 3D table on the 0…1 input grid, RGBA floats with red
   * fastest (the layout applyColorLUT and the GPU use). 1D LUTs and other input domains are resampled.
   */
  function parseCube(text, maxN) {
    let title = '', n3 = 0, n1 = 0, dmin = [0, 0, 0], dmax = [1, 1, 1];
    const vals = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const c = line.charCodeAt(0);
      if ((c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43) {
        const p = line.split(/\s+/);
        if (p.length >= 3) vals.push(+p[0], +p[1], +p[2]);
        continue;
      }
      const [kw, ...rest] = line.split(/\s+/);
      const K = kw.toUpperCase();
      if (K === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
      else if (K === 'LUT_3D_SIZE') n3 = parseInt(rest[0], 10);
      else if (K === 'LUT_1D_SIZE') n1 = parseInt(rest[0], 10);
      else if (K === 'DOMAIN_MIN') dmin = rest.slice(0, 3).map(Number);
      else if (K === 'DOMAIN_MAX') dmax = rest.slice(0, 3).map(Number);
      else if (K === 'LUT_3D_INPUT_RANGE' || K === 'LUT_1D_INPUT_RANGE') { dmin = [+rest[0], +rest[0], +rest[0]]; dmax = [+rest[1], +rest[1], +rest[1]]; }
    }
    if (!n3 && !n1) throw new Error('Not a .cube LUT (no LUT_3D_SIZE / LUT_1D_SIZE)');
    if (vals.some(v => !Number.isFinite(v))) throw new Error('The LUT contains invalid numbers');
    const src = n3 || n1, need = n3 ? src * src * src * 3 : src * 3;
    if (src < 2 || src > 256 || vals.length < need) throw new Error(`The LUT is incomplete (${vals.length / 3} of ${need / 3} entries)`);
    // Sample the source table at an arbitrary input (in the file's domain coordinates 0…src-1)
    const lerp1 = (ch, x) => { const f = Math.max(0, Math.min(src - 1, x)), i = Math.min(src - 2, f | 0), t = f - i; return vals[i * 3 + ch] + (vals[(i + 1) * 3 + ch] - vals[i * 3 + ch]) * t; };
    const n = Math.max(2, Math.min(maxN || 33, n3 || 33));
    const out = new Float32Array(n * n * n * 4);
    const identityDomain = dmin.every(v => v === 0) && dmax.every(v => v === 1);
    if (n3 && n === n3 && identityDomain) {
      for (let i = 0, k = 0; i < n * n * n; i++, k += 4) { out[k] = vals[i * 3]; out[k + 1] = vals[i * 3 + 1]; out[k + 2] = vals[i * 3 + 2]; out[k + 3] = 1; }
    } else {
      const tmpR = new Float32Array(n * n * n), tmpG = new Float32Array(n * n * n), tmpB = new Float32Array(n * n * n);
      for (let b = 0, i = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++, i++) {
        // grid input 0…1 → file domain → table index
        const v = [r / (n - 1), g / (n - 1), b / (n - 1)].map((x, ch) => (x - dmin[ch]) / ((dmax[ch] - dmin[ch]) || 1) * (src - 1));
        if (n3) { tmpR[i] = v[0]; tmpG[i] = v[1]; tmpB[i] = v[2]; }
        else { out[i * 4] = lerp1(0, v[0]); out[i * 4 + 1] = lerp1(1, v[1]); out[i * 4 + 2] = lerp1(2, v[2]); out[i * 4 + 3] = 1; }
      }
      if (n3) {
        const tab = new Float32Array(src * src * src * 4);
        for (let i = 0; i < src * src * src; i++) { tab[i * 4] = vals[i * 3]; tab[i * 4 + 1] = vals[i * 3 + 1]; tab[i * 4 + 2] = vals[i * 3 + 2]; tab[i * 4 + 3] = 1; }
        const N = n * n * n;
        for (let i = 0; i < N; i++) { tmpR[i] /= (src - 1); tmpG[i] /= (src - 1); tmpB[i] /= (src - 1); }
        applyColorLUT(tmpR, tmpG, tmpB, N, tab, src);
        for (let i = 0; i < N; i++) { out[i * 4] = tmpR[i]; out[i * 4 + 1] = tmpG[i]; out[i * 4 + 2] = tmpB[i]; out[i * 4 + 3] = 1; }
      }
    }
    return { title, n, data: out, sourceSize: src, oneD: !n3 };
  }

  /** Apply a parsed cube ({n, data}) to display-encoded planes, blended by amount (0…1+). */
  function applyCube(R, G, B, N, cube, amount) {
    if (amount >= 0.999 && amount <= 1.001) { applyColorLUT(R, G, B, N, cube.data, cube.n); return; }
    const r0 = R.slice(0, N), g0 = G.slice(0, N), b0 = B.slice(0, N);
    applyColorLUT(R, G, B, N, cube.data, cube.n);
    for (let i = 0; i < N; i++) { R[i] = r0[i] + (R[i] - r0[i]) * amount; G[i] = g0[i] + (G[i] - g0[i]) * amount; B[i] = b0[i] + (B[i] - b0[i]) * amount; }
  }

  /**
   * The per-pixel part of an edit as a 3D table (for "Export look as .cube"): input transform,
   * white balance, exposure, tone, curves, colour, grading and any LUT. Local-contrast tools
   * (texture, clarity, dehaze), effects, masks and geometry depend on neighbouring pixels or
   * position, so they can't be part of a LUT and are left out.
   */
  function lookLUT(settings, n, srcInput, cube) {
    const s = normalizeSettings(settings);
    s.texture = 0; s.clarity = 0; s.dehaze = 0; s.masks = [];
    const N = n * n * n;
    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
    for (let b = 0, i = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++, i++) { R[i] = r / (n - 1); G[i] = g / (n - 1); B[i] = b / (n - 1); }
    const useCube = cube && s.lut.id === cube.id && s.lut.amount > 0 ? cube : null;
    if (useCube && s.lut.stage === 'input') applyCube(R, G, B, N, useCube, s.lut.amount / 100);
    else if (s.input && s.input.profile !== 'none') stageInput(R, G, B, N, s.input);
    else if (srcInput) stageSourceInput(R, G, B, N, srcInput);
    const M = calibMatrix(s.calib), [gr, gg, gb] = wbGains(s.temp, s.tint), em = Math.pow(2, s.exposure || 0);
    if (M || s.temp || s.tint || s.exposure) stageLinear(R, G, B, N, null, M, gr * em, gg * em, gb * em, [], [], {});
    if (s.contrast || s.highlights || s.shadows || s.whites || s.blacks) stageTone(R, G, B, N, s, null, null, null, [], []);
    stageColor(R, G, B, N, s, buildCurveLUTs(s.curve), [], []);
    if (useCube && s.lut.stage !== 'input') applyCube(R, G, B, N, useCube, s.lut.amount / 100);
    let txt = `TITLE "photos.jpeg look"\n# Exported by photos.jpeg — sRGB in, sRGB out\nLUT_3D_SIZE ${n}\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n`;
    const f = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v).toFixed(6);
    const lines = new Array(N);
    for (let i = 0; i < N; i++) lines[i] = `${f(R[i])} ${f(G[i])} ${f(B[i])}`;
    return txt + lines.join('\n') + '\n';
  }

  function colorLUT(settings, n) {
    const s = normalizeSettings(settings);
    const N = n * n * n;
    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
    for (let b = 0, i = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++, i++) {
      R[i] = r / (n - 1); G[i] = g / (n - 1); B[i] = b / (n - 1);
    }
    stageColor(R, G, B, N, s, buildCurveLUTs(s.curve), [], []);
    const out = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) { out[i * 4] = R[i]; out[i * 4 + 1] = G[i]; out[i * 4 + 2] = B[i]; out[i * 4 + 3] = 1; }
    return out;
  }

  const api = {
    neighborhoodPad, noiseReductionForIso, hueSat, masksNeedColor, waveletDenoise, blurPlane, setMaskMap, hasMaskMap, getMaskMap, resizePixels, orientPixels, stageSourceInput, allocPixels, copyPixels, isShared, SHARED,
    colorLUT, parseCube, applyCube, lookLUT, brushRaster, calibMatrix, autoGrade, analyzeForGrade, GRADE_STYLES, GRADE_STRENGTH, INPUT_PROFILES, inputLUT, inputKnee, rawLogEncode,
    HUE_BANDS, HUE_CENTERS, LOCAL_KEYS,
    defaultSettings, defaultLocalAdj, normalizeSettings, beforeSettings, clone,
    render, applySpots, buildGeometry, orientedSize, rotatedBounds, cropInside, constrainCrop, maxCropForAspect,
    wbGains, neutralizeWB, toLin, toSrgb, SRGB8_TO_LIN, splineLUT, parametricLUT, buildCurveLUTs,
    autoToneFromHist, clamp, smoothstep, hueVector, blurPlane, hslToRgb, rgbToHsl
  };
  global.PJ = global.PJ || {};
  Object.assign(api, { isWide, SRGB_TO_P3, P3_TO_SRGB, mul3, convertPlanes });
  global.PJ.Pipeline = api;
})(typeof self !== 'undefined' ? self : this);
