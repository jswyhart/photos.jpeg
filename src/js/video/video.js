/* =====================================================================
 * photos.jpeg — video clips: probing, playable media, frame access, playback.
 *
 * A catalog entry with kind 'video' is graded exactly like a photo. The engine asks
 * this module for "the current frame" (photo.videoTime) as its source image, so every
 * Develop tool — histogram, masks, WB picker, 1:1, before/after — works on a paused
 * frame through the CPU engine. While playing or scrubbing, frames are graded on the
 * GPU (video/gl.js) and handed to the viewer as a live layer.
 *
 * Media paths, in order of preference:
 *   1. the file itself in a <video> element (H.264/HEVC/AV1/VP9 MP4/MOV — GoPro, Pixel,
 *      Samsung, iPhone; ProRes on the Mac)
 *   2. CinemaDNG sequences, decoded in JS (video/cdng.js)
 *   3. optimized media made by the native shell (ffmpeg / AVFoundation / vendor SDKs)
 * ===================================================================== */
(function (global) {
  'use strict';
  const API = PJ.API, Dec = PJ.Decode, UI = PJ.UI;
  const MP4_LIKE = new Set(['mp4', 'mov', 'm4v', 'lrv', '360', 'insv', '3gp']);

  /* ---------------- range reader over the platform API ---------------- */
  async function reader(path) {
    const size = await API.fileSize(path);
    const cache = new Map();
    const BLOCK = 1 << 20;
    return {
      size,
      async read(off, len) {
        // big reads go straight through; small header reads are served from 1 MB blocks
        if (len > BLOCK) return API.readRange(path, off, len);
        const out = new Uint8Array(Math.max(0, Math.min(len, size - off)));
        let p = 0;
        while (p < out.length) {
          const b = Math.floor((off + p) / BLOCK);
          let blk = cache.get(b);
          if (!blk) {
            blk = await API.readRange(path, b * BLOCK, Math.min(BLOCK, size - b * BLOCK));
            cache.set(b, blk);
            if (cache.size > 24) cache.delete(cache.keys().next().value);
          }
          const s = off + p - b * BLOCK, n = Math.min(blk.length - s, out.length - p);
          out.set(blk.subarray(s, s + n), p); p += n;
        }
        return out;
      }
    };
  }

  /* ---------------- probing ---------------- */
  function isVideoPhoto(p) { return p && p.kind === 'video'; }

  /** Fill photo.video with container metadata (cheap — reads only the index). */
  async function probe(photo) {
    const v = photo.video || (photo.video = {});
    if (v.probed) return v;
    if (v.cdng) {
      const info = await PJ.CDNG.probe(v.cdng);
      Object.assign(v, info, { probed: true, codecName: 'CinemaDNG', container: 'DNG sequence' });
      return v;
    }
    const ext = Dec.ext(photo.name);
    if (MP4_LIKE.has(ext)) {
      try {
        const m = await PJ.MP4.demux(await reader(photo.path));
        const t = m.video;
        Object.assign(v, {
          container: m.brand === 'qt  ' ? 'QuickTime' : 'MPEG-4', codec: t.codec || '', codecName: t.codecName,
          fourcc: t.fourcc, width: t.width, height: t.height, fps: t.fps, frames: t.frameCount,
          duration: m.duration || t.duration, rotation: t.rotation || 0, hdr: t.hdr || '', color: t.color || null,
          bitDepth: t.bitDepth || 8,
          audio: m.audio ? { codecName: m.audio.codecName, channels: m.audio.channels, sampleRate: m.audio.sampleRate } : null
        });
        if (t.rotation === 90 || t.rotation === 270) { v.width = t.height; v.height = t.width; }
      } catch (e) { v.probeError = String(e.message || e); }
    }
    if (Dec.isRawVideo(photo.name)) { v.needsProxy = true; v.codecName = v.codecName || rawName(ext); }
    v.probed = true;
    return v;
  }
  function rawName(ext) {
    return { braw: 'Blackmagic RAW', r3d: 'REDCODE RAW', ari: 'ARRIRAW', arx: 'ARRIRAW HDE', crm: 'Canon Cinema RAW Light', nev: 'Nikon N-RAW' }[ext] || ext.toUpperCase();
  }

  /* ---------------- optimized media (native) ---------------- */
  let jobSeq = 0;
  const proxyJobs = new Map();
  if (API.onVideoProgress) API.onVideoProgress((e) => { const j = [...proxyJobs.values()].find(x => x.id === e.jobId); if (j) j.onProgress(e); });

  async function ensureProxy(photo, why) {
    const v = photo.video;
    if (v.proxy && await API.fileSize(v.proxy).catch(() => 0)) return v.proxy;
    if (!API.isDesktop || !API.videoTool) throw new Error(`${v.codecName || 'This format'} can't be decoded here${why ? ` (${why})` : ''}. Open it in the desktop or Mac app.`);
    if (proxyJobs.has(photo.path)) return proxyJobs.get(photo.path).promise;
    const id = 'vj' + (++jobSeq);
    const job = { id, onProgress: (e) => UI.activity(`${e.text || 'Creating optimized media'} — ${photo.name}`, e.frac) };
    job.promise = (async () => {
      try {
        UI.activity(`Creating optimized media — ${photo.name}`, 0);
        const r = await API.videoTool('proxy', { path: photo.path, jobId: id });
        v.proxy = r.path;
        PJ.Catalog.scheduleSave();
        return r.path;
      } finally { UI.activity(''); proxyJobs.delete(photo.path); }
    })();
    proxyJobs.set(photo.path, job);
    return job.promise;
  }

  /* ---------------- clips ---------------- */
  function waitEvent(el, ok, bad, ms) {
    return new Promise((resolve, reject) => {
      let t = 0;
      const done = (f, x) => { clearTimeout(t); el.removeEventListener(ok, onOk); if (bad) el.removeEventListener(bad, onBad); f(x); };
      const onOk = () => done(resolve);
      const onBad = () => done(reject, new Error((el.error && el.error.message) || 'media error'));
      el.addEventListener(ok, onOk); if (bad) el.addEventListener(bad, onBad);
      if (ms) t = setTimeout(() => done(reject, new Error('timed out')), ms);
    });
  }

  class Clip {
    constructor(photo) { this.photo = photo; this.path = photo.path; this.el = null; this.cdng = null; this.queue = Promise.resolve(); this.ready = null; }
    get v() { return this.photo.video; }
    open() { if (!this.ready) this.ready = this._open().catch(e => { this.ready = null; throw e; }); return this.ready; }
    async _open() {
      const v = await probe(this.photo);
      if (v.cdng) { this.cdng = await PJ.CDNG.open(v.cdng); return this; }
      let src = v.proxy || (v.needsProxy ? await ensureProxy(this.photo) : this.photo.path);
      try { await this._load(src); }
      catch (e) {
        if (src !== this.photo.path) throw e;
        console.warn('direct playback failed, using optimized media', e);
        src = await ensureProxy(this.photo, `${v.codecName || 'codec'} isn't supported by the system video decoder`);
        await this._load(src);
      }
      if (!v.duration || !isFinite(v.duration)) v.duration = this.el.duration;
      if (!v.width) { v.width = this.el.videoWidth; v.height = this.el.videoHeight; }
      if (!v.fps) v.fps = 30;
      if (!v.frames) v.frames = Math.round(v.duration * v.fps);
      return this;
    }
    async _load(src) {
      if (this.el) this.destroyEl();
      const el = document.createElement('video');
      el.preload = 'auto'; el.playsInline = true; el.crossOrigin = 'anonymous'; el.muted = false;
      el.setAttribute('playsinline', '');
      el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
      document.body.appendChild(el);
      this.el = el;
      el.src = API.mediaUrl(src);
      await waitEvent(el, 'loadeddata', 'error', 30000);
      if (!el.videoWidth) throw new Error('no video frames');
      this.mediaPath = src;
    }
    destroyEl() { if (!this.el) return; try { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); this.el.remove(); } catch (_) { } this.el = null; }
    destroy() { this.destroyEl(); if (this.cdng) this.cdng.close(); this.cdng = null; this.ready = null; }
    get fps() { return this.v.fps || 30; }
    get duration() { return this.v.duration || 0; }
    frameOf(t) { return Math.max(0, Math.min((this.v.frames || 1) - 1, Math.floor(t * this.fps + 1e-3))); }
    timeOf(f) { return f / this.fps; }
    /** Serialize element access (seeks from thumbnails and the player must not interleave). */
    exclusive(fn) { const r = this.queue.then(fn, fn); this.queue = r.catch(() => { }); return r; }
    async seek(t) {
      await this.open();
      if (this.cdng) { this.cdngTime = t; return; }
      const el = this.el;
      // aim inside the frame so rounding never lands on the previous one
      const target = Math.max(0, Math.min(this.duration - 0.5 / this.fps, this.timeOf(this.frameOf(t)) + 0.3 / this.fps));
      if (Math.abs(el.currentTime - target) < 0.2 / this.fps && el.readyState >= 2) return;
      el.currentTime = target;
      await waitEvent(el, 'seeked', 'error', 15000);
      if (el.requestVideoFrameCallback) await new Promise(r => { let d = false; el.requestVideoFrameCallback(() => { d = true; r(); }); setTimeout(() => { if (!d) r(); }, 250); });
    }
    /** Draw the current frame into a canvas (full resolution, upright). */
    async frameCanvas(t) {
      return this.exclusive(async () => {
        // the clip may be closed (cache eviction, a refresh) while this request waits: reopen and retry
        for (let attempt = 0; ; attempt++) {
          if (!this.el && !this.cdng) { this.ready = null; await this.open(); }
          await this.seek(t);
          if (this.el || this.cdng) break;
          if (attempt) throw new Error('clip closed');
        }
        if (this.cdng) return this.cdng.frameCanvas(this.cdng.frameOf(t));
        const el = this.el, w = el.videoWidth, h = el.videoHeight;
        const c = Dec.makeCanvas(w, h);
        c.getContext('2d').drawImage(el, 0, 0, w, h);
        return c;
      });
    }
  }

  const clips = new Map();
  function clipFor(photo) {
    let c = clips.get(photo.path);
    if (c) { clips.delete(photo.path); clips.set(photo.path, c); c.photo = photo; return c; }
    c = new Clip(photo);
    clips.set(photo.path, c);
    while (clips.size > 4) {
      const [k, old] = clips.entries().next().value;
      if (player.clip === old) { clips.delete(k); clips.set(k, old); if (clips.size <= 5) break; continue; }
      old.destroy(); clips.delete(k);
    }
    return c;
  }

  function defaultTime(photo) {
    const v = photo.video || {};
    if (photo.videoTime != null) return photo.videoTime;
    return Math.min(1, (v.duration || 0) * 0.1);
  }

  /** Engine hook: decoded "image" for the clip's current frame. */
  async function decodeFrame(photo) {
    const clip = clipFor(photo);
    await clip.open();
    const t = defaultTime(photo);
    let canvas;
    if (player.clip === clip && player.playing && clip.el) {
      // never seek under the running player: use whatever frame is on screen
      canvas = Dec.makeCanvas(clip.el.videoWidth, clip.el.videoHeight);
      canvas.getContext('2d').drawImage(clip.el, 0, 0);
    } else canvas = await clip.frameCanvas(t);
    const v = photo.video;
    return {
      image: canvas, width: canvas.width, height: canvas.height,
      exif: { make: v.make || '', model: v.model || '', captureTime: photo.captureTime || null },
      note: `${v.codecName || 'Video'} · frame ${clip.frameOf(t) + 1} of ${v.frames || '?'}`
    };
  }

  /* ---------------- timecode ---------------- */
  function timecode(t, fps) {
    fps = fps || 30;
    const f = Math.floor(t * fps + 1e-3), r = Math.round(fps);
    const ff = f % r, s = Math.floor(f / r), ss = s % 60, mm = Math.floor(s / 60) % 60, hh = Math.floor(s / 3600);
    const p = (n) => String(n).padStart(2, '0');
    return `${hh ? p(hh) + ':' : ''}${p(mm)}:${p(ss)}:${p(ff)}`;
  }
  function shortDuration(t) {
    if (!t || !isFinite(t)) return '';
    const s = Math.round(t), m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  /* ---------------- player (one at a time, drives the Develop viewer) ---------------- */
  const player = {
    clip: null, photo: null, viewer: null, playing: false, events: UI.emitter(), loop: true, rate: 1,
    t: 0, raf: 0, scrubbing: false,

    async attach(photo, viewer) {
      if (this.photo === photo && this.viewer === viewer) return;
      this.detach();
      if (!isVideoPhoto(photo)) return;
      this.photo = photo; this.viewer = viewer;
      this.clip = clipFor(photo);
      this.t = defaultTime(photo);
      try { await this.clip.open(); } catch (e) { this.events.emit('error', e); return; }
      if (this.photo !== photo) return;
      this.events.emit('state');
    },
    detach() {
      this.pause(true);
      if (this.viewer) this.viewer.setLive(null);
      this.clip = null; this.photo = null; this.viewer = null;
      this.events.emit('state');
    },
    range() {
      const v = this.photo.video, d = this.clip.duration;
      const a = Math.max(0, v.in || 0), b = Math.min(d, v.out == null ? d : v.out);
      return [a, b > a ? b : d];
    },
    /** GPU-grade the element's current frame into the viewer. */
    drawLive() {
      if (!this.clip || !this.viewer) return;
      const src = this.clip.cdng ? this.clip.cdng.lastCanvas : this.clip.el;
      if (!src) return;
      const R = PJ.GL.renderer();
      R.setSource(src);
      const vw = this.viewer, pane = vw.mainPane(), dpr = window.devicePixelRatio || 1;
      const fullLong = Math.max(R.srcW, R.srcH);
      const levelScale = Math.min(1, Math.max(0.05, pane.scale * dpr * 1.05));
      // keyframed values and stabilization for this exact frame
      const s = PJ.Stabilize.apply(this.photo, PJ.Keyframes.at(this.photo.settings, this.t), this.t);
      R.render(s, { levelScale, fullLong, seed: PJ.Engine.seedFor(this.photo), frameIndex: this.clip.frameOf(this.t), clipping: vw.st.clipping });
      const [fw, fh] = vw.foDims();
      vw.setLive({ canvas: R.canvas, w: fw, h: fh });
    },
    async play() {
      if (!this.clip || this.playing) return;
      await this.clip.open();
      if (this.photo.settings.lut && this.photo.settings.lut.id && PJ.LUTs) await PJ.LUTs.get(this.photo.settings.lut.id);
      const [a, b] = this.range();
      if (this.t >= b - 1 / this.clip.fps || this.t < a) await this.seek(a, false);
      this.playing = true;
      this.events.emit('state');
      if (this.clip.cdng) return this.playCdng();
      const el = this.clip.el;
      el.playbackRate = this.rate;
      try { await el.play(); } catch (e) { el.muted = true; try { await el.play(); } catch (e2) { this.playing = false; this.events.emit('state'); return; } }
      const tick = () => {
        if (!this.playing) return;
        this.t = el.currentTime;
        const [, end] = this.range();
        if (this.t >= end - 0.5 / this.clip.fps || el.ended) {
          if (this.loop) { el.currentTime = this.range()[0]; if (el.paused) el.play().catch(() => { }); } else { this.pause(); return; }
        }
        try { this.drawLive(); } catch (e) { console.error(e); this.pause(); this.events.emit('error', e); return; }
        this.events.emit('time', this.t);
        this.raf = el.requestVideoFrameCallback ? el.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
      };
      // the frame callback stops when the element ends; restart from here
      el.onended = () => {
        if (!this.playing || this.clip.el !== el) return;
        if (this.loop) { el.currentTime = this.range()[0]; el.play().then(() => { this.raf = el.requestVideoFrameCallback ? el.requestVideoFrameCallback(tick) : requestAnimationFrame(tick); }).catch(() => { }); }
        else { this.t = this.clip.duration; this.pause(); }
      };
      tick();
    },
    async playCdng() {
      const c = this.clip.cdng, fps = this.clip.fps;
      let last = performance.now();
      const step = async () => {
        if (!this.playing) return;
        const now = performance.now();
        const adv = Math.max(1, Math.round((now - last) / 1000 * fps));
        last = now;
        let f = this.clip.frameOf(this.t) + adv;
        const [a, b] = this.range();
        if (f >= Math.floor(b * fps)) { if (!this.loop) return this.pause(); f = Math.floor(a * fps); }
        this.t = f / fps;
        await c.frameCanvas(f, { half: true });
        if (!this.playing) return;
        this.drawLive();
        this.events.emit('time', this.t);
        this.raf = requestAnimationFrame(step);
      };
      step();
    },
    pause(silent) {
      if (!this.playing) return;
      this.playing = false;
      if (this.clip && this.clip.el) {
        const el = this.clip.el;
        el.pause(); el.onended = null;
        if (el.cancelVideoFrameCallback) try { el.cancelVideoFrameCallback(this.raf); } catch (_) { }
        this.t = Math.min(el.currentTime, this.clip.duration - 0.5 / this.clip.fps);
      }
      cancelAnimationFrame(this.raf);
      if (!silent) { this.settle(); this.events.emit('state'); }
    },
    toggle() { this.playing ? this.pause() : this.play(); },
    /** Move the playhead. live=true while dragging (GPU only); the engine re-renders on settle. */
    async seek(t, settle = true) {
      if (!this.clip) return;
      const d = this.clip.duration;
      t = Math.max(0, Math.min(d - 0.5 / this.clip.fps, t));
      this.t = t;
      this.events.emit('time', t);
      const my = (this.seekSeq = (this.seekSeq || 0) + 1);
      await this.clip.exclusive(async () => {
        if (my !== this.seekSeq) return;
        await this.clip.seek(t);
        if (this.clip.cdng) await this.clip.cdng.frameCanvas(this.clip.cdng.frameOf(t), { half: true });
      });
      if (my !== this.seekSeq || !this.clip) return;
      try { this.drawLive(); } catch (e) { console.error(e); }
      if (settle) this.settle();
    },
    step(n) { if (!this.clip) return; this.pause(true); this.seek(this.clip.timeOf(this.clip.frameOf(this.t) + n) + 1e-4); this.events.emit('state'); },
    /** Commit the playhead as the clip's current frame and hand it to the CPU engine. */
    settle() {
      if (!this.photo) return;
      const p = this.photo;
      if (p.videoTime !== this.t) { p.videoTime = this.t; PJ.Catalog.scheduleSave(); }
      PJ.Keyframes.applyAt(p, this.t); // sliders show the values under the playhead
      PJ.Engine.invalidate(p);
      if (this.viewer) this.viewer.refreshFrame();
      this.events.emit('settled', this.t);
    },
    setIn() { if (!this.photo) return; const v = this.photo.video; v.in = this.t; if (v.out != null && v.out <= v.in) v.out = null; PJ.Catalog.scheduleSave(); this.events.emit('state'); },
    setOut() { if (!this.photo) return; const v = this.photo.video; v.out = this.t + 1 / this.clip.fps; if (v.in && v.in >= v.out) v.in = 0; PJ.Catalog.scheduleSave(); this.events.emit('state'); },
    clearRange() { if (!this.photo) return; const v = this.photo.video; v.in = 0; v.out = null; PJ.Catalog.scheduleSave(); this.events.emit('state'); },
    setMuted(b) { if (this.clip && this.clip.el) this.clip.el.muted = b; this.events.emit('state'); },
    get muted() { return !!(this.clip && this.clip.el && this.clip.el.muted); }
  };

  /** Drop cached decoders for a file (it changed on disk). */
  function forget(path) {
    const c = clips.get(path);
    if (c && player.clip !== c) { c.destroy(); clips.delete(path); }
  }

  global.PJ.Video = { forget, reader, probe, isVideoPhoto, clipFor, decodeFrame, ensureProxy, player, timecode, shortDuration, defaultTime, rawName, MP4_LIKE };
})(window);
