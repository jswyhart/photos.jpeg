/* =====================================================================
 * photos.jpeg — XMP sidecars (Adobe Lightroom / Camera Raw compatible).
 *
 * Reads crs: (Camera Raw Settings) develop values, rating, colour label, keywords, title and
 * caption from .xmp sidecars or XMP embedded in JPEG/TIFF/DNG files, and writes them back.
 *
 * Lightroom's own sidecar convention is followed: a RAW file IMG_1234.NEF pairs with IMG_1234.xmp.
 * Other formats get IMG_1234.xmp too, unless a RAW file with the same name sits in the same
 * folder — then IMG_1234.jpg.xmp, so the two never overwrite each other.
 *
 * Alongside the crs: values, the exact photos.jpeg settings are kept in a private namespace with a
 * signature of the crs: values written. If another app later edits the file, the signature no
 * longer matches and the crs: values are used; otherwise the round trip is lossless (masks, spots,
 * camera-log input and everything else crs: can't express).
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline;

  const NS = {
    x: 'adobe:ns:meta/',
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
    xmp: 'http://ns.adobe.com/xap/1.0/',
    dc: 'http://purl.org/dc/elements/1.1/',
    tiff: 'http://ns.adobe.com/tiff/1.0/',
    pjx: 'https://photos-jpeg.app/ns/xmp/1.0/'
  };
  const XMLNS = 'http://www.w3.org/2000/xmlns/';
  const PREFIX = Object.fromEntries(Object.entries(NS).map(([k, v]) => [v, k]));

  const BANDS = PJ.Pipeline.HUE_BANDS; // Red Orange Yellow Green Aqua Blue Purple Magenta — same as Lightroom
  /** crs: name → settings path. Ranges match Lightroom's, so values copy straight across. */
  const SIMPLE = [
    ['Exposure2012', 'exposure'], ['Contrast2012', 'contrast'], ['Highlights2012', 'highlights'], ['Shadows2012', 'shadows'],
    ['Whites2012', 'whites'], ['Blacks2012', 'blacks'], ['Texture', 'texture'], ['Clarity2012', 'clarity'], ['Dehaze', 'dehaze'],
    ['Vibrance', 'vibrance'], ['Saturation', 'saturation'],
    ['ParametricShadows', 'curve.shadows'], ['ParametricDarks', 'curve.darks'], ['ParametricLights', 'curve.lights'], ['ParametricHighlights', 'curve.highlights'],
    ['ParametricShadowSplit', 'curve.split1'], ['ParametricMidtoneSplit', 'curve.split2'], ['ParametricHighlightSplit', 'curve.split3'],
    ['Sharpness', 'detail.sharpen'], ['SharpenRadius', 'detail.radius'], ['SharpenDetail', 'detail.detail'], ['SharpenEdgeMasking', 'detail.masking'],
    ['LuminanceSmoothing', 'detail.nrLuma'], ['LuminanceNoiseReductionDetail', 'detail.nrDetail'], ['ColorNoiseReduction', 'detail.nrColor'],
    ['LensManualDistortionAmount', 'lens.distortion'], ['VignetteAmount', 'lens.vignette'], ['VignetteMidpoint', 'lens.vigMid'],
    ['PerspectiveVertical', 'transform.vertical'], ['PerspectiveHorizontal', 'transform.horizontal'], ['PerspectiveRotate', 'transform.rotate'],
    ['PerspectiveAspect', 'transform.aspect'], ['PerspectiveScale', 'transform.scale'], ['PerspectiveX', 'transform.offX'], ['PerspectiveY', 'transform.offY'],
    ['PostCropVignetteAmount', 'effects.vigAmount'], ['PostCropVignetteMidpoint', 'effects.vigMid'], ['PostCropVignetteRoundness', 'effects.vigRound'],
    ['PostCropVignetteFeather', 'effects.vigFeather'], ['PostCropVignetteHighlightContrast', 'effects.vigHighlights'],
    ['GrainAmount', 'effects.grain'], ['GrainSize', 'effects.grainSize'], ['GrainFrequency', 'effects.grainRough'],
    ['ShadowTint', 'calib.shadowTint'], ['RedHue', 'calib.redHue'], ['RedSaturation', 'calib.redSat'], ['GreenHue', 'calib.greenHue'],
    ['GreenSaturation', 'calib.greenSat'], ['BlueHue', 'calib.blueHue'], ['BlueSaturation', 'calib.blueSat'],
    ['ColorGradeShadowHue', 'grading.shadows.h'], ['ColorGradeShadowSat', 'grading.shadows.s'], ['ColorGradeShadowLum', 'grading.shadows.l'],
    ['ColorGradeMidtoneHue', 'grading.midtones.h'], ['ColorGradeMidtoneSat', 'grading.midtones.s'], ['ColorGradeMidtoneLum', 'grading.midtones.l'],
    ['ColorGradeHighlightHue', 'grading.highlights.h'], ['ColorGradeHighlightSat', 'grading.highlights.s'], ['ColorGradeHighlightLum', 'grading.highlights.l'],
    ['ColorGradeGlobalHue', 'grading.global.h'], ['ColorGradeGlobalSat', 'grading.global.s'], ['ColorGradeGlobalLum', 'grading.global.l'],
    ['ColorGradeBlending', 'grading.blending'], ['SplitToningBalance', 'grading.balance']
  ];
  BANDS.forEach((b, i) => {
    SIMPLE.push(['HueAdjustment' + b, `hsl.hue.${i}`], ['SaturationAdjustment' + b, `hsl.sat.${i}`],
      ['LuminanceAdjustment' + b, `hsl.lum.${i}`], ['GrayMixer' + b, `bwMix.${i}`]);
  });
  const LABELS = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' };

  /* ---------------- helpers ---------------- */
  const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, path, v) {
    const ks = path.split('.'); let a = o;
    for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]];
    a[ks[ks.length - 1]] = v;
  }
  const num = (v) => { const n = parseFloat(String(v).replace(/^\+/, '')); return Number.isFinite(n) ? n : null; };
  const isTrue = (v) => /^true$/i.test(String(v || '').trim());
  const fmt = (v, d) => { const r = d ? Number(v).toFixed(d) : String(Math.round(v)); return v > 0 && /^-?[\d.]+$/.test(r) && !/^0(\.0+)?$/.test(r) ? '+' + r : r; };
  const ext = (name) => (String(name).match(/\.([^.\\/]+)$/) || [])[1]?.toLowerCase() || '';
  const base = (name) => String(name).replace(/\.[^.\\/]+$/, '');
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

  // White balance: Lightroom stores Kelvin for RAW files; photos.jpeg's Temp is relative (−100…100).
  // The as-shot Kelvin isn't known here, so map around a daylight 5500 K in mireds.
  const K0 = 5500;
  function kelvinToTemp(K) {
    const d = 1e6 / K0 - 1e6 / Math.max(2000, Math.min(50000, K));
    return Math.round(P.clamp(d >= 0 ? d / 1.5 : d / 3, -100, 100));
  }
  function tempToKelvin(t) { const d = t >= 0 ? t * 1.5 : t * 3; return Math.round(1e6 / (1e6 / K0 - d)); }

  // EXIF orientation ↔ clockwise rotation (mirrored orientations are left alone)
  const ORIENT_ROT = { 1: 0, 6: 90, 3: 180, 8: 270 };
  const ROT_ORIENT = { 0: 1, 90: 6, 180: 3, 270: 8 };

  /* ---------------- parsing ---------------- */
  /** Extract the XMP packet from arbitrary bytes (JPEG APP1, TIFF/DNG tag 700, PNG iTXt …). */
  function findPacket(bytes) {
    const n = Math.min(bytes.length, 16 << 20);
    const dec = new TextDecoder('utf-8');
    // scan for "<x:xmpmeta" without decoding the whole file
    const needle = [60, 120, 58, 120, 109, 112, 109, 101, 116, 97]; // <x:xmpmeta
    for (let i = 0; i < n - 12; i++) {
      if (bytes[i] !== 60 || bytes[i + 1] !== 120) continue;
      let ok = true;
      for (let k = 2; k < needle.length; k++) if (bytes[i + k] !== needle[k]) { ok = false; break; }
      if (!ok) continue;
      const tail = [60, 47, 120, 58, 120, 109, 112, 109, 101, 116, 97, 62]; // </x:xmpmeta>
      for (let j = i; j < Math.min(n, i + (4 << 20)); j++) {
        if (bytes[j] !== 60 || bytes[j + 1] !== 47) continue;
        let m = true;
        for (let k = 2; k < tail.length; k++) if (bytes[j + k] !== tail[k]) { m = false; break; }
        if (m) return dec.decode(bytes.subarray(i, j + tail.length));
      }
      return null;
    }
    return null;
  }

  /** XMP text → flat property map { 'crs:Exposure2012': '+0.50', 'dc:subject': ['a','b'], … }. */
  function properties(text) {
    const props = {};
    if (!text) return props;
    const doc = new DOMParser().parseFromString(text.replace(/^[^<]*/, ''), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Not valid XMP');
    const descs = doc.getElementsByTagNameNS(NS.rdf, 'Description');
    for (const d of descs) {
      for (const a of d.attributes) {
        const pre = PREFIX[a.namespaceURI];
        if (pre && pre !== 'rdf') props[pre + ':' + a.localName] = a.value;
      }
      for (const el of d.children) {
        const pre = PREFIX[el.namespaceURI];
        if (!pre) continue;
        const key = pre + ':' + el.localName;
        const list = el.getElementsByTagNameNS(NS.rdf, 'li');
        const container = el.firstElementChild && el.firstElementChild.namespaceURI === NS.rdf ? el.firstElementChild.localName : '';
        if (container === 'Alt') props[key] = list.length ? list[0].textContent : '';
        else if (container === 'Seq' || container === 'Bag') props[key] = Array.from(list, li => li.textContent);
        else if (!el.children.length) props[key] = el.textContent;
      }
    }
    return props;
  }

  function curvePoints(list) {
    if (!Array.isArray(list) || list.length < 2) return null;
    const pts = list.map(s => s.split(',').map(v => num(v) / 255)).filter(p => p.length === 2 && p.every(Number.isFinite));
    if (pts.length < 2) return null;
    pts.sort((a, b) => a[0] - b[0]);
    return pts.map(([x, y]) => [P.clamp(x, 0, 1), P.clamp(y, 0, 1)]);
  }

  /**
   * Parse an XMP packet. Returns { settings (complete), hasDevelop, meta: {rating, flag, label, keywords, title, caption}, exact }.
   * `photo` provides the current settings to keep what XMP can't express, and RAW-ness for white balance.
   */
  function parse(text, photo, fileOrientation) {
    const pr = properties(text);
    const crsKeys = Object.keys(pr).filter(k => k.startsWith('crs:')).sort();
    const meta = {};
    const rating = num(pr['xmp:Rating']);
    if (rating !== null) {
      if (rating < 0) meta.flag = -1;
      else meta.rating = Math.max(0, Math.min(5, Math.round(rating)));
    }
    if (pr['xmp:Label'] !== undefined) {
      const l = String(pr['xmp:Label']).trim().toLowerCase();
      meta.label = LABELS[l] ? l : '';
    }
    if (pr['pjx:Flag'] !== undefined && num(pr['pjx:Flag']) !== null) meta.flag = num(pr['pjx:Flag']);
    if (Array.isArray(pr['dc:subject'])) meta.keywords = pr['dc:subject'].map(s => s.trim()).filter(Boolean);
    if (typeof pr['dc:title'] === 'string') meta.title = pr['dc:title'];
    if (typeof pr['dc:description'] === 'string') meta.caption = pr['dc:description'];

    const current = P.normalizeSettings(photo && photo.settings);
    // Our own exact settings, when nothing else has touched the crs: values since we wrote them
    if (pr['pjx:Settings'] && pr['pjx:CrsSig'] === crsSig(crsKeys.map(k => k + '=' + pr[k]))) {
      try { return { settings: P.normalizeSettings(JSON.parse(pr['pjx:Settings'])), hasDevelop: true, meta, exact: true }; } catch (_) { /* fall through to crs */ }
    }
    const hasDevelop = crsKeys.some(k => k !== 'crs:Version' && k !== 'crs:RawFileName' && k !== 'crs:HasSettings' && k !== 'crs:AlreadyApplied');
    if (!hasDevelop) return { settings: current, hasDevelop: false, meta, exact: false };

    const s = P.defaultSettings();
    s.input = current.input; // camera-log input is a property of the footage, not the edit
    const c = (k) => pr['crs:' + k];
    for (const [k, path] of SIMPLE) {
      const v = num(c(k));
      if (v !== null) setPath(s, path, v);
    }
    // Process Version 2010 and older
    if (c('Exposure2012') === undefined && num(c('Exposure')) !== null) s.exposure = num(c('Exposure'));
    if (c('Clarity2012') === undefined && num(c('Clarity')) !== null) s.clarity = num(c('Clarity'));
    // Split toning before Color Grading existed
    if (c('ColorGradeShadowHue') === undefined) {
      if (num(c('SplitToningShadowHue')) !== null) s.grading.shadows.h = num(c('SplitToningShadowHue'));
      if (num(c('SplitToningShadowSaturation')) !== null) s.grading.shadows.s = num(c('SplitToningShadowSaturation'));
      if (num(c('SplitToningHighlightHue')) !== null) s.grading.highlights.h = num(c('SplitToningHighlightHue'));
      if (num(c('SplitToningHighlightSaturation')) !== null) s.grading.highlights.s = num(c('SplitToningHighlightSaturation'));
    }
    s.bw = isTrue(c('ConvertToGrayscale'));
    // Tone curves
    const rgb = curvePoints(c('ToneCurvePV2012')), r = curvePoints(c('ToneCurvePV2012Red')), g = curvePoints(c('ToneCurvePV2012Green')), b = curvePoints(c('ToneCurvePV2012Blue'));
    if (rgb) s.curve.rgb = rgb; if (r) s.curve.r = r; if (g) s.curve.g = g; if (b) s.curve.b = b;
    // White balance
    const wb = String(c('WhiteBalance') || '').toLowerCase();
    if (num(c('IncrementalTemperature')) !== null || num(c('IncrementalTint')) !== null) {
      s.temp = P.clamp(Math.round(num(c('IncrementalTemperature')) || 0), -100, 100);
      s.tint = P.clamp(Math.round(num(c('IncrementalTint')) || 0), -100, 100);
      s.wbMode = s.temp || s.tint ? 'custom' : 'asShot';
    } else if (wb && wb !== 'as shot' && num(c('Temperature')) !== null) {
      s.temp = kelvinToTemp(num(c('Temperature')));
      s.tint = P.clamp(Math.round((num(c('Tint')) || 0) / 1.5), -100, 100);
      s.wbMode = wb === 'auto' ? 'auto' : 'custom';
    } else if (wb === 'auto') s.wbMode = 'auto';
    // Crop
    if (isTrue(c('HasCrop'))) {
      const L = num(c('CropLeft')) ?? 0, T = num(c('CropTop')) ?? 0, R = num(c('CropRight')) ?? 1, B = num(c('CropBottom')) ?? 1;
      if (R > L && B > T) s.geo.crop = { x: P.clamp(L, 0, 1), y: P.clamp(T, 0, 1), w: P.clamp(R - L, 0.01, 1), h: P.clamp(B - T, 0.01, 1) };
      s.geo.angle = P.clamp(num(c('CropAngle')) || 0, -45, 45);
      s.geo.aspect = 'free';
    }
    // Orientation set in Lightroom (relative to the file's own)
    const xo = num(pr['tiff:Orientation']);
    if (xo !== null && ORIENT_ROT[xo] !== undefined && ORIENT_ROT[fileOrientation || 1] !== undefined) {
      s.geo.orient = (ORIENT_ROT[xo] - ORIENT_ROT[fileOrientation || 1] + 360) % 360;
    } else s.geo.orient = current.geo.orient;
    return { settings: s, hasDevelop: true, meta, exact: false };
  }

  /* ---------------- writing ---------------- */
  function crsSig(lines) { return hash(lines.join('\n')); }

  /** photos.jpeg settings → { attrs: {crs:Name: value}, seqs: {crs:Name: [..]} } */
  function toCrs(s, isRaw) {
    const a = {}, seqs = {};
    a.Version = '15.4'; a.ProcessVersion = '11.0'; a.HasSettings = 'True';
    for (const [k, path] of SIMPLE) {
      const v = getPath(s, path);
      if (typeof v !== 'number') continue;
      const unsigned = /split|^detail\.|vigMid|vigFeather|vigHighlights|grain|\.[hs]$|blending|scale/.test(path);
      a[k] = path === 'exposure' ? fmt(v, 2) : path === 'detail.radius' ? Number(v).toFixed(1) : path === 'transform.rotate' ? fmt(v, 1) : unsigned ? String(Math.round(v)) : fmt(v);
    }
    // older readers
    a.SplitToningShadowHue = String(Math.round(s.grading.shadows.h)); a.SplitToningShadowSaturation = String(Math.round(s.grading.shadows.s));
    a.SplitToningHighlightHue = String(Math.round(s.grading.highlights.h)); a.SplitToningHighlightSaturation = String(Math.round(s.grading.highlights.s));
    a.ConvertToGrayscale = s.bw ? 'True' : 'False';
    if (isRaw) {
      if (!s.temp && !s.tint && s.wbMode !== 'auto') a.WhiteBalance = 'As Shot';
      else { a.WhiteBalance = s.wbMode === 'auto' ? 'Auto' : 'Custom'; a.Temperature = String(tempToKelvin(s.temp)); a.Tint = fmt(Math.round(s.tint * 1.5)); }
    } else {
      a.WhiteBalance = s.wbMode === 'auto' ? 'Auto' : (s.temp || s.tint) ? 'Custom' : 'As Shot';
      a.IncrementalTemperature = fmt(s.temp); a.IncrementalTint = fmt(s.tint);
    }
    const g = s.geo, cr = g.crop;
    const cropped = cr.x > 1e-4 || cr.y > 1e-4 || cr.w < 0.9999 || cr.h < 0.9999 || Math.abs(g.angle || 0) > 1e-3;
    a.HasCrop = cropped ? 'True' : 'False';
    if (cropped) {
      a.CropLeft = cr.x.toFixed(6); a.CropTop = cr.y.toFixed(6); a.CropRight = (cr.x + cr.w).toFixed(6); a.CropBottom = (cr.y + cr.h).toFixed(6);
      a.CropAngle = Number(g.angle || 0).toFixed(3); a.CropConstrainToWarp = '0';
    }
    const isId = (c) => c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 1 && c[1][1] === 1;
    const pts = (c) => c.map(([x, y]) => `${Math.round(x * 255)}, ${Math.round(y * 255)}`);
    a.ToneCurveName2012 = isId(s.curve.rgb) && isId(s.curve.r) && isId(s.curve.g) && isId(s.curve.b) ? 'Linear' : 'Custom';
    seqs.ToneCurvePV2012 = pts(s.curve.rgb); seqs.ToneCurvePV2012Red = pts(s.curve.r);
    seqs.ToneCurvePV2012Green = pts(s.curve.g); seqs.ToneCurvePV2012Blue = pts(s.curve.b);
    return { a, seqs };
  }

  const TEMPLATE = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="photos.jpeg">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  /**
   * Build (or update) an XMP packet for a photo. `existing` is the current sidecar text, if any:
   * everything in it that photos.jpeg doesn't manage (other apps' namespaces) is kept.
   */
  function serialize(photo, existing, fileOrientation) {
    const s = P.normalizeSettings(photo.settings);
    let doc = null;
    if (existing) {
      try {
        doc = new DOMParser().parseFromString(existing.replace(/^[^<]*/, ''), 'application/xml');
        if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagNameNS(NS.rdf, 'RDF').length) doc = null;
      } catch (_) { doc = null; }
    }
    if (!doc) doc = new DOMParser().parseFromString(TEMPLATE, 'application/xml');
    const rdf = doc.getElementsByTagNameNS(NS.rdf, 'RDF')[0];
    const descs = Array.from(doc.getElementsByTagNameNS(NS.rdf, 'Description'));
    // Remove what we manage from every Description, then write into the first
    const managed = (ns, local) => ns === NS.crs || ns === NS.pjx || (ns === NS.xmp && (local === 'Rating' || local === 'Label')) ||
      (ns === NS.dc && ['subject', 'title', 'description'].includes(local)) || (ns === NS.tiff && local === 'Orientation');
    for (const d of descs) {
      for (const a of Array.from(d.attributes)) if (managed(a.namespaceURI, a.localName)) d.removeAttributeNode(a);
      for (const el of Array.from(d.children)) if (managed(el.namespaceURI, el.localName)) el.remove();
    }
    let d = descs[0];
    if (!d) { d = doc.createElementNS(NS.rdf, 'rdf:Description'); d.setAttributeNS(NS.rdf, 'rdf:about', ''); rdf.appendChild(d); }
    for (const p of ['crs', 'xmp', 'dc', 'tiff', 'pjx']) d.setAttributeNS(XMLNS, 'xmlns:' + p, NS[p]);

    const { a, seqs } = toCrs(s, !!photo.isRaw);
    const attr = (pre, k, v) => d.setAttributeNS(NS[pre], pre + ':' + k, String(v));
    const sigLines = [];
    for (const [k, v] of Object.entries(a)) { attr('crs', k, v); sigLines.push('crs:' + k + '=' + v); }
    if (photo.isRaw) { attr('crs', 'RawFileName', photo.name); sigLines.push('crs:RawFileName=' + photo.name); }
    const pad = (n) => '\n' + ' '.repeat(n);
    const container = (pre, k, kind, items, lang) => {
      const el = doc.createElementNS(NS[pre], pre + ':' + k);
      const c = doc.createElementNS(NS.rdf, 'rdf:' + kind);
      for (const it of items) {
        const li = doc.createElementNS(NS.rdf, 'rdf:li');
        if (lang) li.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', 'x-default');
        li.textContent = it;
        c.appendChild(doc.createTextNode(pad(6))); c.appendChild(li);
      }
      c.appendChild(doc.createTextNode(pad(5)));
      el.appendChild(doc.createTextNode(pad(5))); el.appendChild(c); el.appendChild(doc.createTextNode(pad(4)));
      d.appendChild(doc.createTextNode(pad(4))); d.appendChild(el);
    };
    for (const [k, list] of Object.entries(seqs)) { container('crs', k, 'Seq', list); sigLines.push('crs:' + k + '=' + list.join(',')); }
    // Metadata
    attr('xmp', 'Rating', photo.flag === -1 ? -1 : (photo.rating | 0));
    if (photo.label && LABELS[photo.label]) attr('xmp', 'Label', LABELS[photo.label]);
    if (photo.flag) attr('pjx', 'Flag', photo.flag);
    if (photo.keywords && photo.keywords.length) container('dc', 'subject', 'Bag', photo.keywords);
    if (photo.title) container('dc', 'title', 'Alt', [photo.title], true);
    if (photo.caption) container('dc', 'description', 'Alt', [photo.caption], true);
    if (s.geo.orient && ORIENT_ROT[fileOrientation || 1] !== undefined) attr('tiff', 'Orientation', ROT_ORIENT[(ORIENT_ROT[fileOrientation || 1] + s.geo.orient) % 360]);
    // Exact settings for the round trip (signature over the crs: values in the order a reader sees them)
    sigLines.sort((x, y) => x.split('=')[0] < y.split('=')[0] ? -1 : 1);
    attr('pjx', 'CrsSig', crsSig(sigLines));
    attr('pjx', 'Settings', JSON.stringify(s));
    d.appendChild(doc.createTextNode(pad(2)));

    let out = new XMLSerializer().serializeToString(doc);
    if (!/^<\?xpacket/.test(out)) out = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${out}\n<?xpacket end="w"?>`;
    return out.replace(/\?><x:xmpmeta/, '?>\n<x:xmpmeta');
  }

  /* ---------------- sidecar names & file access ---------------- */
  /** 'base' (IMG_1.xmp) or 'full' (IMG_1.jpg.xmp) for a photo, following Lightroom's pairing rule. */
  function variantFor(photo) {
    if (photo.isRaw && ext(photo.name) !== 'dng') return 'base';
    const dir = PJ.API.dirname(photo.path), b = base(photo.name).toLowerCase();
    const rawSibling = PJ.Catalog.state.photos.some(o => o !== photo && !o.virtualOf && o.isRaw && PJ.API.dirname(o.path) === dir && base(o.name).toLowerCase() === b);
    return rawSibling ? 'full' : 'base';
  }

  /** The file's own EXIF orientation (photo.exif has it normalised to 1 once applied). */
  async function fileOrientation(photo) {
    try {
      const bytes = PJ.API.readRange ? await PJ.API.readRange(photo.path, 0, 512 * 1024) : await PJ.API.readFile(photo.path);
      const ex = PJ.Decode.parseExif(bytes);
      return ex && ex.orientation || 1;
    } catch (_) { return 1; }
  }

  /** Read develop settings and metadata for a photo: its sidecar, then XMP embedded in the file. */
  async function readFor(photo) {
    if (!PJ.API.sidecar) return null;
    let text = null, source = '';
    const v = variantFor(photo);
    for (const variant of v === 'full' ? ['full'] : ['base', 'full']) {
      try { const r = await PJ.API.sidecar('read', photo.path, variant, null, photo.sidecar); if (r) { text = r; source = 'sidecar'; break; } } catch (_) { /* none */ }
    }
    if (!text && !(photo.isRaw && ext(photo.name) !== 'dng') && photo.kind !== 'video') {
      try {
        const bytes = PJ.API.readRange ? await PJ.API.readRange(photo.path, 0, 4 << 20) : await PJ.API.readFile(photo.path);
        text = findPacket(bytes); source = 'embedded';
      } catch (_) { /* unreadable */ }
    }
    if (!text) return null;
    const r = parse(text, photo, await fileOrientation(photo));
    r.source = source;
    return r;
  }

  async function writeFor(photo) {
    if (!PJ.API.sidecar) throw new Error('Sidecars are not supported here');
    const variant = variantFor(photo);
    let existing = null;
    try { existing = await PJ.API.sidecar('read', photo.path, variant, null, photo.sidecar); } catch (_) { /* new file */ }
    const text = serialize(photo, existing, photo.settings.geo.orient ? await fileOrientation(photo) : 1);
    return PJ.API.sidecar('write', photo.path, variant, text, photo.sidecar);
  }

  /** Apply a parsed result to a photo (one history step). Returns true when anything changed. */
  function apply(photo, r, label) {
    if (!r) return false;
    let changed = false;
    const m = {};
    for (const k of ['rating', 'flag', 'label', 'keywords', 'title', 'caption']) {
      if (r.meta[k] !== undefined && JSON.stringify(r.meta[k]) !== JSON.stringify(photo[k])) { m[k] = r.meta[k]; changed = true; }
    }
    if (Object.keys(m).length) PJ.Catalog.setMeta([photo], m);
    if (r.hasDevelop && JSON.stringify(P.normalizeSettings(photo.settings)) !== JSON.stringify(r.settings)) {
      photo.settings = r.settings;
      PJ.Catalog.commit(photo, label || 'Read Metadata (XMP)');
      changed = true;
    }
    return changed;
  }

  global.PJ = global.PJ || {};
  global.PJ.XMP = { parse, serialize, properties, findPacket, readFor, writeFor, apply, variantFor, toCrs, _k: { kelvinToTemp, tempToKelvin } };
})(window);
