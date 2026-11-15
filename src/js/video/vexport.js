/* =====================================================================
 * photos.jpeg — graded video export.
 *   decode   WebCodecs VideoDecoder over the demuxed samples (frame-exact), or
 *            seek-per-frame through the <video> element, or CinemaDNG workers
 *   grade    GPU renderer (video/gl.js) with the clip's develop settings
 *   encode   WebCodecs VideoEncoder (H.264 / HEVC, AV1 / VP9 as fallbacks)
 *   mux      streaming MP4 writer; AAC/Opus audio is copied, PCM is re-encoded to AAC
 * ===================================================================== */
(function (global) {
  'use strict';
  const API = PJ.API, V = PJ.Video, MP4 = PJ.MP4, Dec = PJ.Decode, P = PJ.Pipeline;

  const SIZES = { original: 0, 2160: 2160, 1440: 1440, 1080: 1080, 720: 720, 480: 480 };
  const BPP = { high: 0.16, medium: 0.085, low: 0.045 };

  function hasWebCodecs() { return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'; }

  function codecCandidates(kind, w, h) {
    const px = w * h;
    const avcLevel = px > 2228224 ? (px > 8912896 ? '640034' : '640033') : px > 921600 ? '640028' : '64001f';
    const hevcLevel = px > 2228224 ? (px > 8912896 ? 'L183' : 'L153') : 'L123';
    const list = {
      avc: [['avc', `avc1.${avcLevel}`], ['avc', 'avc1.640033'], ['avc', 'avc1.4d0033']],
      hevc: [['hevc', `hvc1.1.6.${hevcLevel}.B0`], ['hevc', 'hev1.1.6.L153.B0'], ['hevc', 'hvc1.1.6.L186.B0']],
      av1: [['av1', 'av01.0.08M.08'], ['av1', 'av01.0.12M.08']],
      vp9: [['vp9', 'vp09.00.40.08'], ['vp9', 'vp09.00.50.08']]
    };
    const order = kind === 'hevc' ? ['hevc', 'avc', 'av1', 'vp9'] : ['avc', 'hevc', 'av1', 'vp9'];
    return order.flatMap(k => list[k]);
  }

  async function pickEncoder(kind, w, h, fps, bitrate) {
    for (const [codec, str] of codecCandidates(kind, w, h)) {
      const cfg = { codec: str, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable' };
      if (codec === 'avc') cfg.avc = { format: 'avc' };
      if (codec === 'hevc') cfg.hevc = { format: 'hevc' };
      for (const hw of ['prefer-hardware', 'no-preference']) {
        try {
          const r = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: hw });
          if (r.supported) return { codec, config: { ...r.config, hardwareAcceleration: hw } };
        } catch (_) { }
      }
    }
    return null;
  }

  /* ---------------- frame sources ---------------- */
  /** Yields {image (CanvasImageSource), tUs (relative to the range start), index, close()} for each frame in [t0, t1). */
  async function* webcodecFrames(photo, clip, t0, t1, rotation, signal) {
    const path = clip.mediaPath || photo.path;
    let rd, m;
    // containers the demuxer doesn't read (MKV, AVI, WebM …) are exported by seeking the <video> element
    try { rd = await V.reader(path); m = await MP4.demux(rd); }
    catch (e) { throw Object.assign(new Error(e && e.message || 'not an MP4/MOV file'), { fallback: true }); }
    const tr = m.video;
    if (!tr.codec || typeof VideoDecoder === 'undefined') throw Object.assign(new Error('no decoder'), { fallback: true });
    const dcfg = { codec: tr.codec, codedWidth: tr.width, codedHeight: tr.height };
    if (tr.description) dcfg.description = tr.description;
    const ok = await VideoDecoder.isConfigSupported(dcfg).then(r => r.supported).catch(() => false);
    if (!ok) throw Object.assign(new Error('decoder unsupported'), { fallback: true });
    const S = tr.samples, ts = tr.timescale;
    const ptsSec = (i) => (S.cts[i] - tr.minCts) / ts;
    // first sample to feed: the keyframe at or before t0 (in decode order)
    let start = 0;
    for (let i = 0; i < S.count; i++) { if (S.key[i] && ptsSec(i) <= t0 + 1e-6) start = i; if (S.dts[i] / ts > t0 + 2) break; }
    // last sample to feed: everything decoding before the first frame presented at/after t1 (+ reorder slack)
    let end = S.count;
    for (let i = start; i < S.count; i++) if (ptsSec(i) >= t1 + 0.5) { end = Math.min(S.count, i + 8); break; }
    const out = [];
    let error = null, wake = null;
    const dec = new VideoDecoder({
      output: (f) => { out.push(f); if (wake) { wake(); wake = null; } },
      error: (e) => { error = e; if (wake) { wake(); wake = null; } }
    });
    dec.configure(dcfg);
    const frameDur = 1 / (tr.fps || 30);
    let fed = start, flushed = false, idx = 0;
    const feed = async () => {
      while (fed < end && dec.decodeQueueSize < 6 && out.length < 8) {
        const data = await rd.read(S.offsets[fed], S.sizes[fed]);
        dec.decode(new EncodedVideoChunk({ type: S.key[fed] ? 'key' : 'delta', timestamp: Math.round(ptsSec(fed) * 1e6), duration: Math.round(S.dur[fed] / ts * 1e6), data }));
        fed++;
      }
      if (fed >= end && !flushed) { flushed = true; dec.flush().then(() => { if (wake) { wake(); wake = null; } }).catch(() => { }); }
    };
    try {
      while (true) {
        if (signal && signal.cancelled) break;
        if (error) throw error;
        await feed();
        if (!out.length) {
          if (flushed && dec.decodeQueueSize === 0) { await new Promise(r => setTimeout(r, 30)); if (!out.length) break; continue; }
          await new Promise(r => { wake = r; setTimeout(r, 200); });
          continue;
        }
        out.sort((a, b) => a.timestamp - b.timestamp);
        const f = out.shift();
        const t = f.timestamp / 1e6;
        if (t + frameDur * 0.5 < t0) { f.close(); continue; }
        if (t >= t1 - frameDur * 0.25) { f.close(); break; }
        const image = rotation ? rotate(f, rotation) : f;
        yield { image, tUs: Math.round((t - t0) * 1e6), index: idx++, close: () => { f.close(); } };
      }
    } finally {
      out.forEach(f => f.close());
      try { dec.close(); } catch (_) { }
    }
  }

  let rotCanvas = null;
  function rotate(frame, deg) {
    const w = frame.displayWidth, h = frame.displayHeight, sw = deg % 180 ? h : w, sh = deg % 180 ? w : h;
    if (!rotCanvas) rotCanvas = Dec.makeCanvas(sw, sh);
    if (rotCanvas.width !== sw || rotCanvas.height !== sh) { rotCanvas.width = sw; rotCanvas.height = sh; }
    const x = rotCanvas.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.translate(sw / 2, sh / 2); x.rotate(deg * Math.PI / 180);
    x.drawImage(frame, -w / 2, -h / 2);
    return rotCanvas;
  }

  async function* elementFrames(photo, clip, t0, t1, signal) {
    const fps = clip.fps;
    const f0 = Math.round(t0 * fps), f1 = Math.max(f0 + 1, Math.round(t1 * fps));
    for (let f = f0, i = 0; f < f1; f++, i++) {
      if (signal && signal.cancelled) return;
      const image = await clip.exclusive(async () => { await clip.seek(f / fps); return clip.el; });
      yield { image, tUs: Math.round((f - f0) / fps * 1e6), index: i, close() { } };
    }
  }

  async function* cdngFrames(clip, t0, t1, signal) {
    const c = clip.cdng, fps = clip.fps;
    const f0 = Math.round(t0 * fps), f1 = Math.max(f0 + 1, Math.round(t1 * fps));
    for (let f = f0, i = 0; f < f1; f++, i++) {
      if (signal && signal.cancelled) return;
      for (let k = 1; k <= 4 && f + k < f1; k++) c.decode(f + k, false); // decode ahead in parallel
      const image = await c.decode(f, false);
      yield { image, tUs: Math.round((f - f0) / fps * 1e6), index: i, close() { } };
    }
  }

  /* ---------------- audio ---------------- */
  /** Prepare the audio for [t0, t1): returns {track, samples: async iterator of {data, dur, tUs}} or null. */
  async function audioPlan(photo, clip, t0, t1, warn) {
    if (clip.cdng) return null;
    const path = clip.mediaPath || photo.path;
    let m;
    try { m = await MP4.demux(await V.reader(path)); }
    catch (_) { warn('The sound of this file type can\'t be read here — exported without sound'); return null; }
    const a = m.audio;
    if (!a) return null;
    const rd = await V.reader(path);
    const S = a.samples, ts = a.timescale;
    const pick = [];
    let tacc = 0;
    for (let i = 0; i < S.count; i++) {
      const ts0 = (S.dts ? S.dts[i] : tacc) / ts;
      tacc += S.dur[i];
      if (ts0 + S.dur[i] / ts <= t0) continue;
      if (ts0 >= t1) break;
      pick.push({ i, t: ts0 - t0 });
    }
    if (!pick.length) return null;
    if (['mp4a', 'Opus', 'ac-3', 'ac3'].includes(a.fourcc) && !a.qtVersion) {
      return {
        track: { raw: a.raw, timescale: ts },
        async *samples() { for (const p of pick) yield { data: await rd.read(S.offsets[p.i], S.sizes[p.i]), dur: S.dur[p.i], tUs: Math.max(0, p.t * 1e6) }; }
      };
    }
    if (['sowt', 'twos', 'lpcm', 'in24'].includes(a.fourcc) && typeof AudioEncoder !== 'undefined') {
      return pcmToAac(a, rd, pick, warn);
    }
    warn(`Audio (${a.codecName}) couldn't be included in MP4 — exported without sound`);
    return null;
  }

  async function pcmToAac(a, rd, pick, warn) {
    const ch = a.channels || 2, sr = a.sampleRate || 48000;
    const bits = a.fourcc === 'in24' ? 24 : (a.sampleSize || 16);
    const le = a.fourcc === 'sowt' || (a.fourcc === 'lpcm');
    const cfg = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: Math.min(2, ch), bitrate: 256000 };
    const sup = await AudioEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (!sup.supported) { warn('PCM audio needs an AAC encoder this system lacks — exported without sound'); return null; }
    const chunks = [];
    let asc = null, error = null;
    const enc = new AudioEncoder({ output: (c, meta) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push({ data: d, dur: Math.round((c.duration || 1024 / sr * 1e6) * sr / 1e6) }); if (meta && meta.decoderConfig && meta.decoderConfig.description) asc = new Uint8Array(meta.decoderConfig.description); }, error: (e) => { error = e; } });
    enc.configure(cfg);
    const outCh = cfg.numberOfChannels, bps = bits / 8;
    let tUs = 0;
    for (const p of pick) {
      const raw = await rd.read(a.samples.offsets[p.i], a.samples.sizes[p.i]);
      const frames = Math.floor(raw.length / (bps * ch));
      if (!frames) continue;
      const planar = new Float32Array(frames * outCh);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let f = 0; f < frames; f++) for (let c = 0; c < outCh; c++) {
        const o = (f * ch + c) * bps;
        let v;
        if (bits === 16) v = dv.getInt16(o, le) / 32768;
        else if (bits === 24) { const b0 = raw[o], b1 = raw[o + 1], b2 = raw[o + 2]; let x = le ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2; if (x & 0x800000) x -= 0x1000000; v = x / 8388608; }
        else if (bits === 32) v = dv.getInt32(o, le) / 2147483648;
        else v = 0;
        planar[c * frames + f] = v;
      }
      enc.encode(new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: frames, numberOfChannels: outCh, timestamp: tUs, data: planar }));
      tUs += frames / sr * 1e6;
      if (error) break;
    }
    await enc.flush().catch(e => { error = e; });
    enc.close();
    if (error || !chunks.length) { warn('Audio re-encode failed — exported without sound'); return null; }
    return {
      track: { raw: mp4aEntry(outCh, sr, asc || defaultAsc(sr, outCh)), timescale: sr },
      async *samples() { let t = 0; for (const c of chunks) { yield { data: c.data, dur: c.dur, tUs: t / sr * 1e6 }; t += c.dur; } }
    };
  }
  function defaultAsc(sr, ch) {
    const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(sr);
    const f = idx < 0 ? 3 : idx;
    return Uint8Array.of((2 << 3) | (f >> 1), ((f & 1) << 7) | (ch << 3));
  }
  function mp4aEntry(ch, sr, asc) {
    const be = (n, v) => { const a = []; for (let i = n - 1; i >= 0; i--) a.push((v / Math.pow(256, i)) & 255); return a; };
    const desc = (tag, body) => [tag, 0x80, 0x80, 0x80, body.length, ...body];
    const dsi = desc(0x05, [...asc]);
    const dcd = desc(0x04, [0x40, 0x15, 0, 0, 0, ...be(4, 256000), ...be(4, 256000), ...dsi]);
    const es = desc(0x03, [0, 1, 0, ...dcd, ...desc(0x06, [2])]);
    const esdsBody = [0, 0, 0, 0, ...es];
    const esds = [...be(4, esdsBody.length + 8), 0x65, 0x73, 0x64, 0x73, ...esdsBody];
    const body = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, ...be(2, ch), 0, 16, 0, 0, 0, 0, ...be(4, sr * 65536), ...esds];
    return Uint8Array.from([...be(4, body.length + 8), 0x6d, 0x70, 0x34, 0x61, ...body]);
  }

  /* ---------------- Annex B → MP4 ----------------
   * Some hardware encoders (HEVC through Media Foundation: NVENC, Quick Sync, AMF) hand back an
   * Annex B stream — NAL units separated by start codes, parameter sets in-band, no decoder
   * configuration — whatever format was asked for. MP4 needs length-prefixed NAL units and the
   * parameter sets in an avcC / hvcC record, so both are rebuilt here. */
  function isAnnexB(d) { return d.length > 4 && d[0] === 0 && d[1] === 0 && (d[2] === 1 || (d[2] === 0 && d[3] === 1)); }
  function splitAnnexB(d) {
    const nals = [];
    let i = 0, start = -1;
    const n = d.length;
    while (i + 2 < n) {
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
        if (start >= 0) { let end = i; while (end > start && d[end - 1] === 0) end--; nals.push(d.subarray(start, end)); }
        start = i + 3; i += 3;
      } else i++;
    }
    if (start >= 0 && start < n) nals.push(d.subarray(start, n));
    return nals;
  }
  function lengthPrefixed(nals) {
    let total = 0;
    for (const x of nals) total += 4 + x.length;
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    let o = 0;
    for (const x of nals) { dv.setUint32(o, x.length); out.set(x, o + 4); o += 4 + x.length; }
    return out;
  }
  /** NAL payload without emulation-prevention bytes (00 00 03 → 00 00). */
  function rbsp(nal, header) {
    const out = [];
    for (let i = header, z = 0; i < nal.length; i++) {
      if (z >= 2 && nal[i] === 3) { z = 0; continue; }
      out.push(nal[i]); z = nal[i] === 0 ? z + 1 : 0;
    }
    return out;
  }
  function bitReader(bytes) {
    let p = 0;
    const u = (n) => { let v = 0; for (let i = 0; i < n; i++, p++) v = v * 2 + (((bytes[p >> 3] || 0) >> (7 - (p & 7))) & 1); return v; };
    const ue = () => { let z = 0; while (z < 32 && u(1) === 0) z++; return z ? (Math.pow(2, z) - 1 + u(z)) : 0; };
    return { u, ue };
  }
  function avcCFromNals(nals) {
    const sps = nals.filter(x => (x[0] & 31) === 7), pps = nals.filter(x => (x[0] & 31) === 8);
    if (!sps.length || !pps.length) return null;
    const out = [1, sps[0][1], sps[0][2], sps[0][3], 0xff, 0xe0 | sps.length];
    for (const x of sps) out.push(x.length >> 8, x.length & 255, ...x);
    out.push(pps.length);
    for (const x of pps) out.push(x.length >> 8, x.length & 255, ...x);
    return Uint8Array.from(out);
  }
  function hvcCFromNals(nals) {
    const type = (x) => (x[0] >> 1) & 63;
    const sets = [32, 33, 34].map(t => nals.filter(x => type(x) === t)); // VPS, SPS, PPS
    if (!sets[1].length || !sets[2].length) return null;
    const r = rbsp(sets[1][0], 2), br = bitReader(r);
    br.u(4); const maxSub = br.u(3), nested = br.u(1);
    br.u(96);                                    // general profile, tier, level: copied below as bytes 1…12
    const subProfile = [], subLevel = [];
    for (let i = 0; i < maxSub; i++) { subProfile.push(br.u(1)); subLevel.push(br.u(1)); }
    if (maxSub > 0) for (let i = maxSub; i < 8; i++) br.u(2);
    for (let i = 0; i < maxSub; i++) { if (subProfile[i]) br.u(88); if (subLevel[i]) br.u(8); }
    br.ue();                                     // sps_seq_parameter_set_id
    const chroma = br.ue();
    if (chroma === 3) br.u(1);
    br.ue(); br.ue();                            // width, height
    if (br.u(1)) { br.ue(); br.ue(); br.ue(); br.ue(); } // conformance window
    const depthLuma = br.ue(), depthChroma = br.ue();
    const out = [1, ...r.slice(1, 13), 0xf0, 0x00, 0xfc, 0xfc | (chroma & 3), 0xf8 | (depthLuma & 7), 0xf8 | (depthChroma & 7), 0, 0,
      ((maxSub + 1) & 7) << 3 | (nested & 1) << 2 | 3, sets.filter(a => a.length).length];
    [32, 33, 34].forEach((t, k) => {
      if (!sets[k].length) return;
      out.push(0x80 | t, sets[k].length >> 8, sets[k].length & 255);
      for (const x of sets[k]) out.push(x.length >> 8, x.length & 255, ...x);
    });
    return Uint8Array.from(out);
  }

  /* ---------------- export one clip ---------------- */
  /**
   * o: { vcodec: 'avc'|'hevc', vsize: key of SIZES, vquality: key of BPP, vaudio: bool, vtrim: bool, conflict }
   * Returns the written path.
   */
  async function exportClip(photo, o, path, onProgress, signal) {
    if (!hasWebCodecs()) throw new Error('Video export needs WebCodecs (Chrome/Edge 94+, Safari 16.4+, macOS 13.3+)');
    const clip = V.clipFor(photo);
    await clip.open();
    // A container the demuxer can't read (MKV, AVI, WebM …) could only be exported by seeking the
    // <video> element frame by frame — many times slower, and without its sound. When ffmpeg is
    // set up, the frames and sound come from optimized media instead.
    let media = clip;
    const srcExt = String(clip.mediaPath || photo.path).split('.').pop().toLowerCase();
    if (!clip.cdng && !V.MP4_LIKE.has(srcExt) && API.videoTool) {
      try {
        const caps = await API.videoTool('capabilities');
        if (caps && caps.ffmpeg) { const px = await V.ensureProxy(photo, 'export'); media = Object.create(clip); media.mediaPath = px; }
      } catch (e) { console.warn('optimized media for export failed; reading frames from the player', e && e.message); }
    }
    if (photo.settings.lut && photo.settings.lut.id && PJ.LUTs) await PJ.LUTs.get(photo.settings.lut.id);
    if (PJ.AIMask) await PJ.AIMask.ensure(photo, photo.settings);
    const v = photo.video;
    const dur = clip.duration;
    let t0 = 0, t1 = dur;
    if (o.vtrim !== false) { t0 = Math.max(0, v.in || 0); t1 = Math.min(dur, v.out == null ? dur : v.out); if (t1 <= t0) { t0 = 0; t1 = dur; } }
    const fps = clip.fps;
    const total = Math.max(1, Math.round((t1 - t0) * fps));
    const warnings = [];
    const warn = (w) => warnings.push(w);

    // output geometry from the first frame's size
    const s = P.normalizeSettings(photo.settings);
    const srcW = v.width || clip.el.videoWidth, srcH = v.height || clip.el.videoHeight;
    const g = P.buildGeometry(s, srcW, srcH);
    const target = SIZES[o.vsize] || 0;
    const scale = target ? Math.min(1, target / Math.min(g.outW, g.outH)) : 1;
    let outW = Math.max(2, Math.round(g.outW * scale)), outH = Math.max(2, Math.round(g.outH * scale));
    outW -= outW % 2; outH -= outH % 2;
    const bitrate = Math.round(outW * outH * Math.min(fps, 60) * (BPP[o.vquality] || BPP.high));
    const enc = await pickEncoder(o.vcodec || 'avc', outW, outH, fps, bitrate);
    if (!enc) throw new Error(`No video encoder available for ${outW}×${outH} on this system`);
    if (enc.codec !== (o.vcodec || 'avc')) warn(`${o.vcodec === 'hevc' ? 'HEVC' : 'H.264'} encoding isn't available here — used ${enc.codec.toUpperCase()} instead`);

    const audio = o.vaudio === false ? null : await audioPlan(photo, media, t0, t1, warn);
    const handle = await API.openWrite(path, o.conflict || 'unique');
    if (handle === null) return null; // skipped (exists)
    const sink = {
      write: (b) => API.writeChunk(handle, b),
      patch: (off, b) => API.writeAt(handle, off, b),
      close: () => Promise.resolve()
    };
    const timescale = 90000;
    const mux = new MP4.Muxer(sink, { codec: enc.codec, width: outW, height: outH, timescale, codecString: enc.config.codec }, audio ? audio.track : null);
    await mux.start();
    const audioIt = audio ? audio.samples() : null;
    let nextAudio = audioIt ? await audioIt.next() : { done: true };
    const pumpAudio = async (untilUs) => {
      while (!nextAudio.done && nextAudio.value.tUs <= untilUs) { await mux.addAudio(nextAudio.value.data, nextAudio.value.dur); nextAudio = await audioIt.next(); }
    };

    // encoder → muxer (serialized)
    let encError = null, writeChain = Promise.resolve();
    let annexB = null, annexDesc = null, annexDescSent = false;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        let data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        let desc = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (annexB === null) annexB = !desc && (enc.codec === 'avc' || enc.codec === 'hevc') && isAnnexB(data);
        if (annexB) {
          let nals = splitAnnexB(data);
          if (!annexDesc) annexDesc = enc.codec === 'hevc' ? hvcCFromNals(nals) : avcCFromNals(nals);
          if (!annexDescSent && annexDesc) { desc = annexDesc; annexDescSent = true; }
          // parameter sets live in the configuration record, not in the samples
          nals = nals.filter(x => enc.codec === 'hevc' ? ![32, 33, 34].includes((x[0] >> 1) & 63) : ![7, 8].includes(x[0] & 31));
          data = lengthPrefixed(nals);
        }
        const pts = chunk.timestamp, d = chunk.duration || Math.round(1e6 / fps), key = chunk.type === 'key';
        writeChain = writeChain.then(async () => { await pumpAudio(pts); await mux.addVideo(data, pts, d, key, desc); });
      },
      error: (e) => { encError = e; }
    });
    encoder.configure(enc.config);

    const R = new PJ.GL.Renderer();
    const animated = !!(PJ.Keyframes && PJ.Stabilize && (PJ.Keyframes.count(s) || PJ.Stabilize.active(photo, s)));
    const final = Dec.makeCanvas(outW, outH);
    const fctx = final.getContext('2d');
    const seed = PJ.Engine.seedFor(photo);
    let frames;
    if (clip.cdng) frames = cdngFrames(clip, t0, t1, signal);
    else {
      const rotation = await sourceRotation(media, photo);
      frames = webcodecFrames(photo, media, t0, t1, rotation, signal);
    }
    let n = 0, usedFallback = false;
    const keyEvery = Math.max(1, Math.round(fps * 2));
    try {
      let it = frames[Symbol.asyncIterator]();
      while (true) {
        let r;
        try { r = await it.next(); }
        catch (e) {
          if (e && e.fallback && n === 0 && !usedFallback) { usedFallback = true; it = elementFrames(photo, clip, t0, t1, signal)[Symbol.asyncIterator](); continue; }
          throw e;
        }
        if (r.done) break;
        if (signal && signal.cancelled) { r.value.close(); break; }
        if (encError) throw encError;
        const fr = r.value;
        R.setSource(fr.image);
        const lvl = Math.min(1, (outW / g.outW) * (srcW / Math.max(1, R.srcW)));
        // keyframed edits and stabilization vary per frame
        const ft = t0 + fr.tUs / 1e6;
        const sf = animated ? PJ.Stabilize.apply(photo, PJ.Keyframes.at(s, ft), ft) : s;
        const res = R.render(sf, { levelScale: lvl, fullLong: Math.max(R.srcW, R.srcH), seed, frameIndex: fr.index });
        fr.close();
        let src = R.canvas;
        if (res.width !== outW || res.height !== outH) { fctx.drawImage(R.canvas, 0, 0, outW, outH); src = final; }
        const vf = new VideoFrame(src, { timestamp: fr.tUs, duration: Math.round(1e6 / fps) });
        while (encoder.encodeQueueSize > 4) await new Promise(r2 => setTimeout(r2, 4));
        encoder.encode(vf, { keyFrame: n % keyEvery === 0 });
        vf.close();
        n++;
        if (onProgress && (n % 3 === 0 || n === total)) onProgress(Math.min(1, n / total), `Frame ${n} / ${total}`);
      }
      await encoder.flush();
      await writeChain;
      if (encError) throw encError;
      await pumpAudio(Infinity);
      await mux.finish();
      const written = await API.closeWrite(handle);
      if (!n) throw new Error('No frames were decoded');
      return { path: written || path, frames: n, warnings, codec: enc.codec };
    } catch (e) {
      // a failed export must not leave a half-written file behind
      try { if (API.abortWrite) await API.abortWrite(handle); else await API.closeWrite(handle); } catch (_) { }
      throw e;
    } finally {
      try { encoder.close(); } catch (_) { }
      const lose = R.gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
    }
  }

  /** Every frame of [t0, t1) from the best available decoder (WebCodecs, CinemaDNG, or seeking the element). */
  async function* frames(photo, clip, t0, t1, signal) {
    if (clip.cdng) { yield* cdngFrames(clip, t0, t1, signal); return; }
    let it, n = 0;
    try {
      if (typeof VideoDecoder === 'undefined') throw Object.assign(new Error('no WebCodecs'), { fallback: true });
      it = webcodecFrames(photo, clip, t0, t1, await sourceRotation(clip, photo), signal);
      for await (const f of it) { n++; yield f; }
    } catch (e) {
      if (!(e && e.fallback) || n) throw e;
      yield* elementFrames(photo, clip, t0, t1, signal);
    }
  }

  /** Rotation the decoder output needs to match what <video> shows (phones record sideways + a matrix). */
  async function sourceRotation(clip, photo) {
    try {
      const m = await MP4.demux(await V.reader(clip.mediaPath || photo.path));
      return m.video.rotation || 0;
    } catch (_) { return 0; }
  }

  global.PJ.VExport = { exportClip, hasWebCodecs, SIZES, pickEncoder, frames };
})(window);
