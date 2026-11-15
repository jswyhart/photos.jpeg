/* =====================================================================
 * photos.jpeg — colour profiles for exports.
 *
 * The editor works in sRGB. An export can be tagged with an sRGB profile, or
 * converted to Display P3 or Adobe RGB (1998) and tagged with that profile,
 * so colour-managed viewers and printers show the same colours.
 *
 * Converting does not add colours: everything the editor produces lies inside
 * sRGB, so a P3 or Adobe RGB file holds the same picture in a larger
 * container (useful when a lab or a workflow asks for that space).
 *
 * The profiles are small matrix/curve ICC v2 profiles built here from the
 * published primaries (adapted to D50, as ICC requires).
 * ===================================================================== */
(function (global) {
  'use strict';
  const SPACES = {
    srgb: {
      name: 'sRGB IEC61966-2.1', gamma: 0,
      xyz: [[0.4360747, 0.2225045, 0.0139322], [0.3850649, 0.7168786, 0.0971045], [0.1430804, 0.0606169, 0.7141733]],
      from: null
    },
    p3: {
      name: 'Display P3', gamma: 0,
      xyz: [[0.5151187, 0.2411892, -0.0010505], [0.2919778, 0.6922441, 0.0418832], [0.1571035, 0.0665668, 0.7840713]],
      from: [0.8224621, 0.1775380, 0, 0.0331941, 0.9668058, 0, 0.0170827, 0.0723974, 0.9105199]
    },
    adobe: {
      name: 'Adobe RGB (1998) compatible', gamma: 2.19921875,
      xyz: [[0.6097559, 0.3111242, 0.0194811], [0.2052401, 0.6256560, 0.0608902], [0.1492240, 0.0632197, 0.7448387]],
      from: [0.7151627, 0.2848373, 0, 0, 1, 0, 0, 0.0411619, 0.9588381]
    }
  };
  const srgbToLin = (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const linToSrgb = (c) => c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

  const cache = {};
  /** ICC profile bytes for 'srgb' | 'p3' | 'adobe'. */
  function profile(space) {
    if (cache[space]) return cache[space];
    const sp = SPACES[space];
    if (!sp) return null;
    const ascii = (s) => Array.from(s, ch => ch.charCodeAt(0) & 0x7f);
    const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const u16 = (v) => [(v >> 8) & 255, v & 255];
    const s15 = (v) => u32(Math.round(v * 65536) >>> 0);
    const pad = (a) => { while (a.length % 4) a.push(0); return a; };
    const xyzTag = (v) => [...ascii('XYZ '), 0, 0, 0, 0, ...s15(v[0]), ...s15(v[1]), ...s15(v[2])];
    const desc = pad([...ascii('desc'), 0, 0, 0, 0, ...u32(sp.name.length + 1), ...ascii(sp.name), 0, ...u32(0), ...u32(0), 0, 0, 0, ...new Array(67).fill(0)]);
    const cprt = pad([...ascii('text'), 0, 0, 0, 0, ...ascii('No copyright, use freely'), 0]);
    let curve;
    if (sp.gamma) curve = pad([...ascii('curv'), 0, 0, 0, 0, ...u32(1), ...u16(Math.round(sp.gamma * 256))]);
    else {
      const n = 1024, t = [];
      for (let i = 0; i < n; i++) t.push(...u16(Math.round(srgbToLin(i / (n - 1)) * 65535)));
      curve = pad([...ascii('curv'), 0, 0, 0, 0, ...u32(n), ...t]);
    }
    const blocks = [['desc', desc], ['cprt', cprt], ['wtpt', xyzTag([0.9642, 1, 0.8249])], ['rXYZ', xyzTag(sp.xyz[0])], ['gXYZ', xyzTag(sp.xyz[1])], ['bXYZ', xyzTag(sp.xyz[2])], ['rTRC', curve]];
    const tags = [...blocks.map(b => b[0]), 'gTRC', 'bTRC'];
    let off = 128 + 4 + tags.length * 12;
    const table = [], data = [], where = {};
    for (const [sig, bytes] of blocks) { where[sig] = [off, bytes.length]; data.push(...bytes); off += bytes.length; }
    where.gTRC = where.bTRC = where.rTRC;                    // the three channels share one curve
    for (const sig of tags) table.push(...ascii(sig), ...u32(where[sig][0]), ...u32(where[sig][1]));
    const head = [
      ...u32(off), ...u32(0), ...u32(0x02400000), ...ascii('mntr'), ...ascii('RGB '), ...ascii('XYZ '),
      ...u16(2026), ...u16(1), ...u16(1), ...u16(0), ...u16(0), ...u16(0),
      ...ascii('acsp'), ...ascii('MSFT'), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
      ...s15(0.9642), ...s15(1), ...s15(0.8249), ...u32(0), ...new Array(16).fill(0), ...new Array(28).fill(0)
    ];
    return (cache[space] = Uint8Array.from([...head, ...u32(tags.length), ...table, ...data]));
  }

  /**
   * Convert sRGB pixel values in place to another space's encoding.
   * data: RGBA 8-bit (step 4) or RGB 16-bit (step 3); values stay inside 0…max because sRGB lies inside both spaces.
   */
  function convert(data, space, step, max) {
    const sp = SPACES[space];
    if (!sp || !sp.from) return;
    const m = sp.from, n = max + 1;
    const dec = new Float32Array(n), encN = 4096, enc = new Float32Array(encN + 1);
    for (let i = 0; i < n; i++) dec[i] = srgbToLin(i / max);
    for (let i = 0; i <= encN; i++) { const v = i / encN; enc[i] = (sp.gamma ? Math.pow(v, 1 / sp.gamma) : linToSrgb(v)) * max; }
    const out = (v) => { const f = v <= 0 ? 0 : v >= 1 ? encN : v * encN, q = f | 0; return q >= encN ? enc[encN] : enc[q] + (enc[q + 1] - enc[q]) * (f - q); };
    for (let i = 0; i < data.length; i += step) {
      const r = dec[data[i]], g = dec[data[i + 1]], b = dec[data[i + 2]];
      data[i] = out(m[0] * r + m[1] * g + m[2] * b) + 0.5;
      data[i + 1] = out(m[3] * r + m[4] * g + m[5] * b) + 0.5;
      data[i + 2] = out(m[6] * r + m[7] * g + m[8] * b) + 0.5;
    }
  }

  /** JPEG with the profile in an APP2 "ICC_PROFILE" segment (after the JFIF header). */
  function jpeg(bytes, icc) {
    // the browser's own encoder may already have tagged the file (as sRGB): a file carries one profile
    const keep = [];
    let q = 2, from = 0;
    while (q + 4 <= bytes.length && bytes[q] === 0xff && bytes[q + 1] !== 0xda) {
      const len = (bytes[q + 2] << 8) | bytes[q + 3];
      if (bytes[q + 1] === 0xe2 && bytes[q + 4] === 0x49 && bytes[q + 5] === 0x43 && bytes[q + 6] === 0x43 && bytes[q + 7] === 0x5f) { keep.push(bytes.subarray(from, q)); from = q + 2 + len; }
      q += 2 + len;
    }
    if (keep.length) {
      keep.push(bytes.subarray(from));
      const joined = new Uint8Array(keep.reduce((n, a) => n + a.length, 0));
      let o = 0; for (const a of keep) { joined.set(a, o); o += a.length; }
      bytes = joined;
    }
    let p = 2;
    if (bytes[2] === 0xff && bytes[3] === 0xe0) p = 4 + ((bytes[4] << 8) | bytes[5]);
    const len = 2 + 12 + 2 + icc.length;
    if (len > 0xffff) return bytes;
    const seg = new Uint8Array(2 + len);
    seg.set([0xff, 0xe2, len >> 8, len & 255, 0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0, 1, 1]);
    seg.set(icc, 18);
    const out = new Uint8Array(bytes.length + seg.length);
    out.set(bytes.subarray(0, p)); out.set(seg, p); out.set(bytes.subarray(p), p + seg.length);
    return out;
  }

  let crcTable = null;
  function crc32(a) {
    if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (let i = 0; i < a.length; i++) c = crcTable[(c ^ a[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  /** PNG with the profile in an iCCP chunk right after IHDR. Resolves to the bytes unchanged if the browser can't deflate. */
  async function png(bytes, icc, name) {
    if (typeof CompressionStream === 'undefined' || bytes[12] !== 0x49) return bytes;
    const z = new Uint8Array(await new Response(new Blob([icc]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const label = Array.from((name || 'ICC profile').slice(0, 79), ch => ch.charCodeAt(0) & 0x7f);
    const body = Uint8Array.from([0x69, 0x43, 0x43, 0x50, ...label, 0, 0, ...z]);     // "iCCP" + name + 0 + method 0 + data
    const chunk = new Uint8Array(4 + body.length + 4), dv = new DataView(chunk.buffer);
    dv.setUint32(0, body.length - 4); chunk.set(body, 4); dv.setUint32(4 + body.length, crc32(body));
    const at = 8 + 4 + 4 + 13 + 4;                        // signature + the IHDR chunk
    // colour chunks the encoder wrote itself (sRGB, gAMA, cHRM, another iCCP) would contradict the profile
    const parts = [bytes.subarray(0, at), chunk];
    let p = at;
    while (p + 12 <= bytes.length) {
      const len = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
      const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      const end = p + 12 + len;
      if (type === 'IDAT') { parts.push(bytes.subarray(p)); break; }
      if (!['iCCP', 'sRGB', 'gAMA', 'cHRM'].includes(type)) parts.push(bytes.subarray(p, end));
      p = end;
    }
    const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
    let o = 0; for (const a of parts) { out.set(a, o); o += a.length; }
    return out;
  }

  global.PJ.ICC = { profile, convert, jpeg, png, names: { srgb: 'sRGB', p3: 'Display P3', adobe: 'Adobe RGB (1998)' } };
})(window);
