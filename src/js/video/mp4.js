/* =====================================================================
 * photos.jpeg — ISO-BMFF (MP4 / MOV) demuxer and streaming muxer.
 * Demuxer reads only the boxes it needs through a random-access reader,
 * so multi-gigabyte camera files never have to be loaded into memory.
 * ===================================================================== */
(function (global) {
  'use strict';

  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const s32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const hex2 = (n) => n.toString(16).padStart(2, '0');

  /** Iterate child boxes of a buffer region. */
  function* boxes(b, start, end) {
    let p = start;
    while (p + 8 <= end) {
      let size = u32(b, p);
      const type = fourcc(b, p + 4);
      let hdr = 8;
      if (size === 1) { size = u64(b, p + 8); hdr = 16; } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      yield { type, start: p, data: p + hdr, end: p + size };
      p += size;
    }
  }
  function child(b, box, type) { for (const c of boxes(b, box.data, box.end)) if (c.type === type) return c; return null; }
  function children(b, box, type) { const out = []; for (const c of boxes(b, box.data, box.end)) if (c.type === type) out.push(c); return out; }
  function path(b, box, ...types) { let cur = box; for (const t of types) { cur = cur && child(b, cur, t); } return cur; }

  /* ---------------- codec strings for WebCodecs ---------------- */
  function avcCodec(c) { return `avc1.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}`; }
  function hevcCodec(c, entry) {
    const profileSpace = c[1] >> 6, tier = (c[1] >> 5) & 1, profile = c[1] & 31;
    let compat = u32(c, 2), rev = 0;
    for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
    const level = c[12];
    const cons = [];
    for (let i = 6; i < 12; i++) cons.push(c[i]);
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    const ps = ['', 'A', 'B', 'C'][profileSpace];
    let s = `${entry === 'hev1' ? 'hev1' : 'hvc1'}.${ps}${profile}.${(rev >>> 0).toString(16)}.${tier ? 'H' : 'L'}${level}`;
    if (cons.length) s += '.' + cons.map(x => x.toString(16)).join('.');
    return s;
  }
  function av1Codec(c) {
    const profile = c[1] >> 5, level = c[1] & 31, tier = c[2] >> 7;
    const highBit = (c[2] >> 6) & 1, twelve = (c[2] >> 5) & 1;
    const bits = profile === 2 && highBit ? (twelve ? 12 : 10) : (highBit ? 10 : 8);
    return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(bits).padStart(2, '0')}`;
  }
  function vp9Codec(c) {
    // vpcC (version 1): profile, level, bitDepth(4)|chroma(3)|range(1)
    const profile = c[4], level = c[5], bitDepth = c[6] >> 4;
    return `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(bitDepth).padStart(2, '0')}`;
  }

  /* ---------------- sample entry parsing ---------------- */
  function parseVideoEntry(b, e) {
    const out = { fourcc: e.type, width: u16(b, e.data + 24), height: u16(b, e.data + 26) };
    let p = e.data + 78;
    for (const c of boxes(b, p, e.end)) {
      const payload = b.slice(c.data, c.end);
      if (c.type === 'avcC') { out.codec = avcCodec(payload); out.description = payload; }
      else if (c.type === 'hvcC') { out.codec = hevcCodec(payload, e.type); out.description = payload; }
      else if (c.type === 'av1C') { out.codec = av1Codec(payload); out.description = payload; }
      else if (c.type === 'vpcC') { out.codec = vp9Codec(payload); out.description = undefined; }
      else if (c.type === 'colr') {
        const kind = fourcc(b, c.data);
        if (kind === 'nclx' || kind === 'nclc') out.color = { primaries: u16(b, c.data + 4), transfer: u16(b, c.data + 6), matrix: u16(b, c.data + 8) };
      }
    }
    const prores = { apch: 'ProRes 422 HQ', apcn: 'ProRes 422', apcs: 'ProRes 422 LT', apco: 'ProRes 422 Proxy', ap4h: 'ProRes 4444', ap4x: 'ProRes 4444 XQ', aprn: 'ProRes RAW', aprh: 'ProRes RAW HQ' };
    out.codecName = out.codec ? ({ avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', av01: 'AV1', vp09: 'VP9' }[e.type] || e.type)
      : (prores[e.type] || { AVdn: 'DNxHD', AVdh: 'DNxHR', 'apv1': 'APV', mjpa: 'Motion JPEG' }[e.type] || e.type);
    if (out.color && out.color.transfer === 18) out.hdr = 'HLG';
    else if (out.color && out.color.transfer === 16) out.hdr = 'HDR10 (PQ)';
    return out;
  }
  function parseAudioEntry(b, e) {
    const version = u16(b, e.data + 8);
    const out = { fourcc: e.type, channels: u16(b, e.data + 16), sampleSize: u16(b, e.data + 18), sampleRate: u32(b, e.data + 24) >>> 16, raw: b.slice(e.start, e.end) };
    if (version === 1 || version === 2) out.qtVersion = version;
    out.codecName = { mp4a: 'AAC', lpcm: 'PCM', sowt: 'PCM', twos: 'PCM', 'in24': 'PCM 24-bit', ac3: 'AC-3', Opus: 'Opus' }[e.type] || e.type;
    return out;
  }

  /* ---------------- track sample tables ---------------- */
  function buildSamples(b, stbl) {
    const get = (t) => child(b, stbl, t);
    const stsz = get('stsz'), stz2 = get('stz2'), stco = get('stco'), co64 = get('co64');
    const stsc = get('stsc'), stts = get('stts'), ctts = get('ctts'), stss = get('stss');
    let sizes;
    if (stsz) {
      const fixed = u32(b, stsz.data + 4), count = u32(b, stsz.data + 8);
      sizes = new Uint32Array(count);
      for (let i = 0; i < count; i++) sizes[i] = fixed || u32(b, stsz.data + 12 + i * 4);
    } else if (stz2) {
      const field = b[stz2.data + 7], count = u32(b, stz2.data + 8);
      sizes = new Uint32Array(count);
      for (let i = 0; i < count; i++) sizes[i] = field === 16 ? u16(b, stz2.data + 12 + i * 2) : field === 8 ? b[stz2.data + 12 + i] : ((b[stz2.data + 12 + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15);
    } else return null;
    const n = sizes.length;
    let chunkOffsets;
    if (co64) { const c = u32(b, co64.data + 4); chunkOffsets = new Float64Array(c); for (let i = 0; i < c; i++) chunkOffsets[i] = u64(b, co64.data + 8 + i * 8); }
    else { const c = u32(b, stco.data + 4); chunkOffsets = new Float64Array(c); for (let i = 0; i < c; i++) chunkOffsets[i] = u32(b, stco.data + 8 + i * 4); }
    const offsets = new Float64Array(n);
    {
      const entries = u32(b, stsc.data + 4);
      const sc = [];
      for (let i = 0; i < entries; i++) sc.push([u32(b, stsc.data + 8 + i * 12), u32(b, stsc.data + 12 + i * 12)]);
      let s = 0;
      for (let e = 0; e < sc.length; e++) {
        const first = sc[e][0] - 1, last = e + 1 < sc.length ? sc[e + 1][0] - 1 : chunkOffsets.length;
        for (let c = first; c < last && s < n; c++) {
          let off = chunkOffsets[c];
          for (let k = 0; k < sc[e][1] && s < n; k++) { offsets[s] = off; off += sizes[s]; s++; }
        }
      }
    }
    const dts = new Float64Array(n), dur = new Uint32Array(n);
    {
      const entries = u32(b, stts.data + 4);
      let s = 0, t = 0;
      for (let i = 0; i < entries; i++) {
        const cnt = u32(b, stts.data + 8 + i * 8), d = u32(b, stts.data + 12 + i * 8);
        for (let k = 0; k < cnt && s < n; k++) { dts[s] = t; dur[s] = d; t += d; s++; }
      }
    }
    const cts = new Float64Array(dts);
    if (ctts) {
      const version = b[ctts.data], entries = u32(b, ctts.data + 4);
      let s = 0;
      for (let i = 0; i < entries; i++) {
        const cnt = u32(b, ctts.data + 8 + i * 8);
        const off = version === 1 ? s32(b, ctts.data + 12 + i * 8) : u32(b, ctts.data + 12 + i * 8);
        for (let k = 0; k < cnt && s < n; k++) { cts[s] = dts[s] + off; s++; }
      }
    }
    const key = new Uint8Array(n);
    if (stss) { const c = u32(b, stss.data + 4); for (let i = 0; i < c; i++) { const k = u32(b, stss.data + 8 + i * 4) - 1; if (k < n) key[k] = 1; } }
    else key.fill(1);
    return { count: n, sizes, offsets, dts, cts, dur, key };
  }

  function rotationFromMatrix(b, tkhd) {
    const version = b[tkhd.data];
    const m = tkhd.data + (version === 1 ? 52 : 40);
    const a = s32(b, m) / 65536, bb = s32(b, m + 4) / 65536;
    const ang = Math.round(Math.atan2(bb, a) * 180 / Math.PI);
    return ((ang % 360) + 360) % 360;
  }

  /**
   * Parse a file. reader: { size, read(offset, length) -> Promise<Uint8Array> }
   * Returns { duration, timescale, video: track|null, audio: track|null, brand }
   */
  async function demux(reader) {
    let pos = 0, moov = null, brand = '', mdatSeen = false;
    while (pos + 8 <= reader.size) {
      const h = await reader.read(pos, 16);
      let size = u32(h, 0);
      const type = fourcc(h, 4);
      if (size === 1) size = u64(h, 8); else if (size === 0) size = reader.size - pos;
      if (size < 8) throw new Error('Corrupt MP4 box');
      if (type === 'ftyp') { const f = await reader.read(pos, Math.min(size, 64)); brand = fourcc(f, 8); }
      if (type === 'moov') { moov = await reader.read(pos, size); break; }
      if (type === 'mdat') mdatSeen = true;
      pos += size;
    }
    if (!moov) throw new Error(mdatSeen ? 'This video file is incomplete (no index found — the recording may have been interrupted)' : 'Not an MP4/MOV video');
    const root = { data: 8, end: moov.length };
    const b = moov;
    const mvhd = child(b, root, 'mvhd');
    const mv = b[mvhd.data] === 1 ? { ts: u32(b, mvhd.data + 20), dur: u64(b, mvhd.data + 24) } : { ts: u32(b, mvhd.data + 12), dur: u32(b, mvhd.data + 16) };
    const out = { brand, timescale: mv.ts, duration: mv.dur / mv.ts, video: null, audio: null, meta: {} };
    for (const trak of children(b, root, 'trak')) {
      const mdia = child(b, trak, 'mdia');
      const hdlr = child(b, mdia, 'hdlr');
      const handler = fourcc(b, hdlr.data + 8);
      const mdhd = child(b, mdia, 'mdhd');
      const ts = b[mdhd.data] === 1 ? u32(b, mdhd.data + 20) : u32(b, mdhd.data + 12);
      const tdur = b[mdhd.data] === 1 ? u64(b, mdhd.data + 24) : u32(b, mdhd.data + 16);
      const stbl = path(b, mdia, 'minf', 'stbl');
      if (!stbl) continue;
      const stsd = child(b, stbl, 'stsd');
      const entry = [...boxes(b, stsd.data + 8, stsd.end)][0];
      if (!entry) continue;
      if (handler === 'vide' && !out.video) {
        const v = parseVideoEntry(b, entry);
        const samples = buildSamples(b, stbl);
        if (!samples || !samples.count) continue;
        v.timescale = ts; v.duration = tdur / ts; v.samples = samples;
        v.rotation = rotationFromMatrix(b, child(b, trak, 'tkhd'));
        const avgDur = (samples.dts[samples.count - 1] - samples.dts[0]) / Math.max(1, samples.count - 1) || samples.dur[0];
        v.fps = avgDur ? Math.round(ts / avgDur * 1000) / 1000 : 30;
        v.frameCount = samples.count;
        // presentation order
        const order = Array.from({ length: samples.count }, (_, i) => i).sort((x, y) => samples.cts[x] - samples.cts[y]);
        v.presentation = Int32Array.from(order);
        v.minCts = samples.cts[order[0]];
        out.video = v;
      } else if (handler === 'soun' && !out.audio) {
        const a = parseAudioEntry(b, entry);
        const samples = buildSamples(b, stbl);
        if (!samples || !samples.count) continue;
        a.timescale = ts; a.duration = tdur / ts; a.samples = samples;
        out.audio = a;
      }
    }
    if (!out.video) throw new Error('No video track found');
    if (!out.duration) out.duration = out.video.duration;
    return out;
  }

  /* =====================================================================
   * Streaming MP4 muxer. sink: { write(bytes) -> Promise, patch(offset, bytes) -> Promise, close() }
   * ===================================================================== */
  class Writer {
    constructor() { this.parts = []; this.len = 0; }
    u8(v) { this.parts.push(Uint8Array.of(v & 255)); this.len += 1; return this; }
    u16(v) { this.parts.push(Uint8Array.of((v >> 8) & 255, v & 255)); this.len += 2; return this; }
    u32(v) { this.parts.push(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)); this.len += 4; return this; }
    i32(v) { return this.u32(v >>> 0); }
    u64(v) { const hi = Math.floor(v / 4294967296), lo = v >>> 0; return this.u32(hi).u32(lo); }
    str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this; }
    bytes(a) { this.parts.push(a instanceof Uint8Array ? a : new Uint8Array(a)); this.len += a.byteLength; return this; }
    zeros(n) { this.parts.push(new Uint8Array(n)); this.len += n; return this; }
    out() { const o = new Uint8Array(this.len); let p = 0; for (const a of this.parts) { o.set(a, p); p += a.length; } return o; }
  }
  function box(type, ...content) {
    const w = new Writer();
    let len = 8;
    const parts = content.flat().filter(Boolean).map(c => c instanceof Uint8Array ? c : c.out());
    for (const c of parts) len += c.length;
    w.u32(len).str(type);
    for (const c of parts) w.bytes(c);
    return w.out();
  }
  function fullbox(type, version, flags, ...content) {
    const h = new Writer().u8(version).u8(flags >> 16).u8(flags >> 8).u8(flags);
    return box(type, h.out(), ...content);
  }
  const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

  class Muxer {
    /** video: {codec ('avc'|'hevc'|'av1'|'vp9'), width, height, timescale}; audio: source audio track (passthrough) or null */
    constructor(sink, video, audio) {
      this.sink = sink; this.video = video; this.audio = audio;
      this.vs = []; this.as = [];
      this.pos = 0; this.mdatStart = 0; this.description = null;
      this.pendingAudio = [];
    }
    async start() {
      const brands = ['isom', 'iso2', 'mp41', this.video.codec === 'avc' ? 'avc1' : 'iso6'];
      const ftyp = box('ftyp', new Writer().str('isom').u32(512).str(brands.join('')));
      await this.sink.write(ftyp); this.pos += ftyp.length;
      this.mdatStart = this.pos;
      const mdat = new Writer().u32(1).str('mdat').u64(0).out();
      await this.sink.write(mdat); this.pos += mdat.length;
    }
    /** chunk: EncodedVideoChunk-like {data: Uint8Array, timestamp (µs), duration (µs), key} */
    async addVideo(data, ptsUs, durUs, key, description) {
      if (description && !this.description) this.description = new Uint8Array(description);
      this.vs.push({ offset: this.pos, size: data.length, pts: ptsUs, dur: durUs, key });
      await this.sink.write(data); this.pos += data.length;
    }
    async addAudio(data, dur) {
      this.as.push({ offset: this.pos, size: data.length, dur });
      await this.sink.write(data); this.pos += data.length;
    }
    async finish() {
      const mdatSize = this.pos - this.mdatStart;
      const ls = new Writer().u64(mdatSize).out();
      await this.sink.patch(this.mdatStart + 8, ls);
      const moov = this.buildMoov();
      await this.sink.write(moov); this.pos += moov.length;
      await this.sink.close();
    }
    buildMoov() {
      const v = this.video, vts = v.timescale;
      const toTs = (us) => Math.round(us * vts / 1e6);
      // Decode timestamps = sorted presentation timestamps (handles reordering)
      const pts = this.vs.map(s => toTs(s.pts));
      const sorted = pts.slice().sort((a, b) => a - b);
      const shift = Math.max(0, ...pts.map((p, i) => sorted[i] - p));
      const dts = sorted.map(t => t - shift);
      const durs = this.vs.map((s, i) => i + 1 < dts.length ? dts[i + 1] - dts[i] : Math.max(1, toTs(s.dur)));
      const vDurTs = dts.length ? dts[dts.length - 1] + durs[durs.length - 1] - dts[0] : 0;
      const movieTs = 1000;
      const vDurMovie = Math.round(vDurTs / vts * movieTs);
      const traks = [this.videoTrak(1, vDurTs, vDurMovie, durs, pts.map((p, i) => p - dts[i]))];
      let aDurMovie = 0;
      if (this.audio && this.as.length) {
        const ats = this.audio.timescale;
        const aDurTs = this.as.reduce((a, s) => a + s.dur, 0);
        aDurMovie = Math.round(aDurTs / ats * movieTs);
        traks.push(this.audioTrak(2, aDurTs, aDurMovie));
      }
      const mvhd = fullbox('mvhd', 0, 0, (() => {
        const w = new Writer().u32(0).u32(0).u32(movieTs).u32(Math.max(vDurMovie, aDurMovie)).u32(0x10000).u16(0x100).zeros(10);
        MATRIX.forEach(m => w.u32(m));
        return w.zeros(24).u32(traks.length + 1);
      })());
      return box('moov', mvhd, ...traks);
    }
    stbl(entry, durs, sizes, offsets, keys, ctts) {
      const stsd = fullbox('stsd', 0, 0, new Writer().u32(1), entry);
      // stts run-length
      const runs = [];
      for (const d of durs) { if (runs.length && runs[runs.length - 1][1] === d) runs[runs.length - 1][0]++; else runs.push([1, d]); }
      const sttsW = new Writer().u32(runs.length); runs.forEach(([c, d]) => sttsW.u32(c).u32(d));
      const parts = [stsd, fullbox('stts', 0, 0, sttsW)];
      if (ctts && ctts.some(x => x !== 0)) {
        const cr = [];
        for (const c of ctts) { if (cr.length && cr[cr.length - 1][1] === c) cr[cr.length - 1][0]++; else cr.push([1, c]); }
        const w = new Writer().u32(cr.length); cr.forEach(([n, c]) => w.u32(n).i32(c));
        parts.push(fullbox('ctts', 1, 0, w));
      }
      if (keys && keys.some(k => !k)) {
        const idx = []; keys.forEach((k, i) => { if (k) idx.push(i + 1); });
        const w = new Writer().u32(idx.length); idx.forEach(i => w.u32(i));
        parts.push(fullbox('stss', 0, 0, w));
      }
      parts.push(fullbox('stsc', 0, 0, new Writer().u32(1).u32(1).u32(1).u32(1)));
      const sz = new Writer().u32(0).u32(sizes.length); sizes.forEach(s => sz.u32(s));
      parts.push(fullbox('stsz', 0, 0, sz));
      const co = new Writer().u32(offsets.length); offsets.forEach(o => co.u64(o));
      parts.push(fullbox('co64', 0, 0, co));
      return box('stbl', ...parts);
    }
    trak(id, handler, ts, durTs, durMovie, w, h, mediaHeader, stbl, volume) {
      const tkhdW = new Writer().u32(0).u32(0).u32(id).u32(0).u32(durMovie).zeros(8).u16(0).u16(0).u16(volume ? 0x100 : 0).u16(0);
      MATRIX.forEach(m => tkhdW.u32(m));
      tkhdW.u32(w * 65536).u32(h * 65536);
      const tkhd = fullbox('tkhd', 0, 3, tkhdW);
      const mdhd = fullbox('mdhd', 0, 0, new Writer().u32(0).u32(0).u32(ts).u32(durTs).u16(0x55c4).u16(0));
      const hdlr = fullbox('hdlr', 0, 0, new Writer().u32(0).str(handler).zeros(12).str(handler === 'vide' ? 'VideoHandler' : 'SoundHandler').u8(0));
      const dref = fullbox('dref', 0, 0, new Writer().u32(1), fullbox('url ', 0, 1));
      const minf = box('minf', mediaHeader, box('dinf', dref), stbl);
      const edts = box('edts', fullbox('elst', 0, 0, new Writer().u32(1).u32(durMovie).u32(0).u16(1).u16(0)));
      return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
    }
    videoTrak(id, durTs, durMovie, durs, ctts) {
      const v = this.video;
      const type = { avc: 'avc1', hevc: 'hvc1', av1: 'av01', vp9: 'vp09' }[v.codec];
      const cfgType = { avc: 'avcC', hevc: 'hvcC', av1: 'av1C', vp9: 'vpcC' }[v.codec];
      const ew = new Writer().zeros(6).u16(1).zeros(16).u16(v.width).u16(v.height).u32(0x480000).u32(0x480000).u32(0).u16(1);
      const name = 'photos.jpeg';
      ew.u8(name.length).str(name).zeros(31 - name.length).u16(0x18).u16(0xffff);
      let cfg = this.description;
      if (v.codec === 'av1' && (!cfg || !cfg.length)) {
        // Minimal av1C from the codec string (av01.P.LLT.DD); the sequence header travels in-band.
        const m = /^av01\.(\d)\.(\d\d)([MH])\.(\d\d)/.exec(v.codecString || 'av01.0.08M.08') || [];
        const prof = +m[1] || 0, lvl = +m[2] || 8, tier = m[3] === 'H' ? 1 : 0, bits = +m[4] || 8;
        cfg = Uint8Array.of(0x81, (prof << 5) | lvl, (tier << 7) | ((bits > 8 ? 1 : 0) << 6) | ((bits === 12 ? 1 : 0) << 5) | (0 << 4) | (1 << 3) | (1 << 2), 0);
      }
      const cfgBox = v.codec === 'vp9'
        ? fullbox('vpcC', 1, 0, new Writer().u8(0).u8(10).u8((8 << 4) | (1 << 1)).u8(1).u8(1).u8(1).u16(0))
        : box(cfgType, cfg || new Uint8Array(0));
      const colr = box('colr', new Writer().str('nclx').u16(1).u16(1).u16(1).u8(0));
      const entry = box(type, ew, cfgBox, colr);
      const stbl = this.stbl(entry, durs, this.vs.map(s => s.size), this.vs.map(s => s.offset), this.vs.map(s => s.key), ctts);
      const vmhd = fullbox('vmhd', 0, 1, new Writer().zeros(8));
      return this.trak(id, 'vide', v.timescale, durTs, durMovie, v.width, v.height, vmhd, stbl, false);
    }
    audioTrak(id, durTs, durMovie) {
      const a = this.audio;
      const stbl = this.stbl(a.raw, this.as.map(s => s.dur), this.as.map(s => s.size), this.as.map(s => s.offset), null, null);
      const smhd = fullbox('smhd', 0, 0, new Writer().u32(0));
      return this.trak(id, 'soun', a.timescale, durTs, durMovie, 0, 0, smhd, stbl, true);
    }
  }

  global.PJ = global.PJ || {};
  global.PJ.MP4 = { demux, Muxer };
})(typeof self !== 'undefined' ? self : this);
