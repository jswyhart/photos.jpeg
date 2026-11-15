#!/usr/bin/env node
/* Builds src/vendor/lensfun/lensfun.json from a checkout of the lensfun project
 * (https://github.com/lensfun/lensfun), whose data/db/*.xml holds lens calibrations
 * contributed by its community (licence: CC BY-SA 3.0).
 *
 *   node tools/lensfun/build-db.js <path to lensfun checkout>
 *
 * Kept from the database: rectilinear lenses that have distortion and/or vignetting
 * calibration, the cameras (for their mount and crop factor) and mount compatibility.
 * Fisheye lenses and the perspective data are left out — the
 * editor doesn't use them.
 *
 * Output (arrays keep the file small):
 *   cameras: [[maker, model, mount, crop], …]              lower-case maker / model
 *   mounts:  { mount: [compatible mounts] }
 *   lenses:  [{ mk, m, mo:[mounts], c: crop, ar: aspect ratio,
 *               d: [[focal, model (0 ptlens, 1 poly3, 2 poly5), t0, t1, t2], …],
 *               v: [[focal, aperture, distance, k1, k2, k3], …],
 *               t: [[focal, vr, vb, cr, cb, br, bb], …] }, …]        chromatic aberration (poly3; "linear" has only vr, vb)
 */
const fs = require('fs'), path = require('path');
const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, 'data', 'db'))) { console.error('usage: node build-db.js <lensfun checkout>'); process.exit(1); }
const dbDir = path.join(src, 'data', 'db');
const outDir = path.join(__dirname, '..', '..', 'src', 'vendor', 'lensfun');

const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
const blocks = (xml, tag) => { const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'); const out = []; let m; while ((m = re.exec(xml))) out.push({ attrs: m[1] || '', body: m[2] }); return out; };
/** Text of <tag> elements: the one without lang= first (that is what cameras write into EXIF), then lang="en". */
const texts = (xml, tag) => { const all = blocks(xml, tag); const plain = all.filter(b => !/lang=/.test(b.attrs)).map(b => unesc(b.body)); const en = all.filter(b => /lang="en"/.test(b.attrs)).map(b => unesc(b.body)); return [...plain, ...en]; };
const attrs = (s) => { const o = {}; const re = /([\w-]+)="([^"]*)"/g; let m; while ((m = re.exec(s))) o[m[1]] = m[2]; return o; };
const num = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
const r5 = (n) => +n.toPrecision(6);
const aspect = (s) => { if (!s) return 1.5; const m = /^\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(s); const a = m ? +m[1] / +m[2] : parseFloat(s); return isFinite(a) && a > 0 ? Math.max(a, 1 / a) : 1.5; };

const cameras = [], mounts = {}, lenses = [];
let skipped = 0;
for (const file of fs.readdirSync(dbDir).filter(f => f.endsWith('.xml')).sort()) {
  const xml = fs.readFileSync(path.join(dbDir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of blocks(xml, 'mount')) {
    const name = texts(m.body, 'name')[0];
    if (!name) continue;                       // a <mount> inside a lens or camera has no <name>
    mounts[name] = [...new Set([...(mounts[name] || []), ...texts(m.body, 'compat')])];
  }
  for (const c of blocks(xml, 'camera')) {
    const makers = texts(c.body, 'maker'), models = texts(c.body, 'model'), mount = texts(c.body, 'mount')[0], crop = num(texts(c.body, 'cropfactor')[0]);
    if (!makers.length || !models.length || !mount || !crop) continue;
    for (const model of new Set(models)) cameras.push([makers[0].toLowerCase(), model.toLowerCase(), mount, r5(crop)]);
  }
  for (const l of blocks(xml, 'lens')) {
    const makers = texts(l.body, 'maker'), models = texts(l.body, 'model'), mo = texts(l.body, 'mount');
    const type = (texts(l.body, 'type')[0] || 'rectilinear').toLowerCase();
    if (!makers.length || !models.length || !mo.length || type !== 'rectilinear') { skipped++; continue; }
    let crop = num(texts(l.body, 'cropfactor')[0], 1), ar = aspect(texts(l.body, 'aspect-ratio')[0]);
    // first calibration set that has distortion (else the first one): the editor uses one set per lens
    const sets = blocks(l.body, 'calibration');
    const set = sets.find(s => /<distortion/.test(s.body)) || sets[0];
    if (!set) { skipped++; continue; }
    const sa = attrs(set.attrs);
    if (sa.cropfactor) crop = num(sa.cropfactor, crop);
    if (sa['aspect-ratio']) ar = aspect(sa['aspect-ratio']);
    const d = [], v = [];
    let model = null;
    for (const m of set.body.matchAll(/<distortion\s([^>]*?)\/?>/g)) {
      const a = attrs(m[1]);
      if (!['ptlens', 'poly3', 'poly5'].includes(a.model)) continue;
      if (model === null) model = a.model; else if (model !== a.model) continue;       // lensfun: only the first model found counts
      const focal = num(a.focal);
      if (!(focal > 0)) continue;
      d.push(a.model === 'ptlens' ? [r5(focal), 0, r5(num(a.a)), r5(num(a.b)), r5(num(a.c))]
        : a.model === 'poly3' ? [r5(focal), 1, r5(num(a.k1)), 0, 0] : [r5(focal), 2, r5(num(a.k1)), r5(num(a.k2)), 0]);
    }
    for (const m of set.body.matchAll(/<vignetting\s([^>]*?)\/?>/g)) {
      const a = attrs(m[1]);
      if (a.model !== 'pa') continue;
      const focal = num(a.focal), ap = num(a.aperture), dist = num(a.distance, 1000);
      if (focal > 0 && ap > 0) v.push([r5(focal), r5(ap), r5(dist), r5(num(a.k1)), r5(num(a.k2)), r5(num(a.k3))]);
    }
    const t = [];
    for (const m of set.body.matchAll(/<tca\s([^>]*?)\/?>/g)) {
      const a = attrs(m[1]);
      const focal = num(a.focal);
      if (!(focal > 0)) continue;
      if (a.model === 'poly3') t.push([r5(focal), +num(a.vr, 1).toPrecision(8), +num(a.vb, 1).toPrecision(8), r5(num(a.cr)), r5(num(a.cb)), r5(num(a.br)), r5(num(a.bb))]);
      else if (a.model === 'linear') t.push([r5(focal), +num(a.kr, 1).toPrecision(8), +num(a.kb, 1).toPrecision(8), 0, 0, 0, 0]);
    }
    t.sort((x, y) => x[0] - y[0]);
    if (!d.length && !v.length && !t.length) { skipped++; continue; }
    d.sort((x, y) => x[0] - y[0]);
    const entry = { mk: makers[makers.length - 1], m: models[0], mo, c: r5(crop) };
    if (Math.abs(ar - 1.5) > 0.001) entry.ar = r5(ar);
    if (d.length) entry.d = d;
    if (v.length) entry.v = v;
    if (t.length) entry.t = t;
    lenses.push(entry);
  }
}
let version = '';
try { version = /set\s*\(\s*VERSION_MAJOR\s+(\d+)[\s\S]*?VERSION_MINOR\s+(\d+)[\s\S]*?VERSION_MICRO\s+(\d+)/i.exec(fs.readFileSync(path.join(src, 'CMakeLists.txt'), 'utf8')).slice(1).join('.'); } catch (_) { }
const out = {
  about: 'Lens calibration data from the lensfun project (https://lensfun.github.io), licensed CC BY-SA 3.0. Converted by tools/lensfun/build-db.js.',
  lensfun: version, built: new Date().toISOString().slice(0, 10),
  cameras, mounts, lenses
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'lensfun.json'), JSON.stringify(out));
fs.writeFileSync(path.join(outDir, 'LICENSE.txt'),
`lensfun.json in this folder is derived from the lens database of the lensfun project
(https://lensfun.github.io, https://github.com/lensfun/lensfun, data/db/*.xml), converted to
JSON by tools/lensfun/build-db.js. Only the distortion, vignetting and chromatic-aberration calibrations of
rectilinear lenses, the camera list and the mount table were kept.

The lensfun database is the work of the lensfun contributors and is licensed under the
Creative Commons Attribution-ShareAlike 3.0 Unported licence (CC BY-SA 3.0):
https://creativecommons.org/licenses/by-sa/3.0/

This converted file is distributed under the same licence.
`);
console.log(`lensfun ${version}: ${lenses.length} lenses (${lenses.filter(l => l.d).length} with distortion, ${lenses.filter(l => l.v).length} with vignetting, ${lenses.filter(l => l.t).length} with chromatic aberration), ${cameras.length} cameras, ${Object.keys(mounts).length} mounts; ${skipped} lenses left out; ${(fs.statSync(path.join(outDir, 'lensfun.json')).size / 1e6).toFixed(2)} MB`);
