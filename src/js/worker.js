/* Render worker: holds decoded sources and runs the pipeline off the UI thread. */
/* global PJ */
importScripts('pipeline.js', 'rawmatrices.js', 'rawdec.js', 'rawgpu.js');

const sources = new Map(); // key -> {data, width, height}
const MAX_SOURCES = 6;

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'setSource') {
      // msg.buffer is a SharedArrayBuffer (no copy, shared with the UI thread) or a transferred ArrayBuffer
      sources.delete(msg.key);
      sources.set(msg.key, { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height });
      while (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value);
      self.postMessage({ type: 'ack', id: msg.id });
      return;
    }
    if (msg.type === 'hasSource') {
      self.postMessage({ type: 'hasSource', id: msg.id, has: sources.has(msg.key) });
      return;
    }
    if (msg.type === 'dropSource') {
      sources.delete(msg.key);
      return;
    }
    if (msg.type === 'task') {
      if (msg.op === 'levels') {
        // Build the smaller working levels (proxy, draft …) from a full-resolution image
        let cur = { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height };
        const out = [];
        for (const edge of msg.edges) { cur = PJ.Pipeline.resizePixels(cur, edge); out.push({ width: cur.width, height: cur.height, buffer: cur.data.buffer }); }
        const transfer = out.map(o => o.buffer).filter(b => !(typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer));
        self.postMessage({ type: 'result', id: msg.id, levels: out }, transfer);
        return;
      }
      if (msg.op === 'rawA') {
        const r = PJ.RawDec.phaseA(msg.key, new Uint8Array(msg.buffer));
        self.postMessage({ type: 'result', id: msg.id, raw: r }, [r.cells.buffer]);
        return;
      }
      if (msg.op === 'rawB') {
        const r = PJ.RawDec.phaseB(msg.key, msg.opts, msg.buffer ? new Uint8Array(msg.buffer) : null);
        let px = r.data, w = r.width, h = r.height;
        if (msg.opts.orientation && msg.opts.orientation !== 1) { const o = PJ.Pipeline.orientPixels({ data: px, width: w, height: h }, msg.opts.orientation); px = o.data; w = o.width; h = o.height; }
        const out = PJ.Pipeline.SHARED ? PJ.Pipeline.copyPixels(px) : px;
        self.postMessage({ type: 'result', id: msg.id, width: w, height: h, buffer: out.buffer }, PJ.Pipeline.isShared(out) ? [] : [out.buffer]);
        return;
      }
      if (msg.op === 'rawShare') {
        const s = PJ.RawDec.share(msg.key);
        self.postMessage({ type: 'result', id: msg.id, info: s.info, mosaic: s.mosaic });
        return;
      }
      if (msg.op === 'rawGpu') {
        // the whole image on the graphics card; ok:false sends the caller back to the CPU strips
        const r = PJ.RawGpu ? PJ.RawGpu.develop(msg.shared, msg.opts) : false;
        self.postMessage(r ? { type: 'result', id: msg.id, ok: true, width: r.width, height: r.height } : { type: 'result', id: msg.id, ok: false });
        return;
      }
      if (msg.op === 'rawStrip') {
        const r = PJ.RawDec.strip(msg.shared, msg.opts);
        self.postMessage({ type: 'result', id: msg.id, width: r.width, height: r.height });
        return;
      }
      if (msg.op === 'orient') {
        const o = PJ.Pipeline.orientPixels({ data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height }, msg.orientation);
        const out = PJ.Pipeline.SHARED && !PJ.Pipeline.isShared(o.data) ? PJ.Pipeline.copyPixels(o.data) : o.data;
        self.postMessage({ type: 'result', id: msg.id, width: o.width, height: o.height, buffer: out.buffer }, PJ.Pipeline.isShared(out) ? [] : [out.buffer]);
        return;
      }
      throw new Error('unknown task ' + msg.op);
    }
    if (msg.type === 'render') {
      const src = msg.buffer ? { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height } : sources.get(msg.key);
      if (!src) { self.postMessage({ type: 'error', id: msg.id, error: 'missing-source' }); return; }
      const t0 = performance.now();
      const res = PJ.Pipeline.render({
        src, settings: msg.settings, fullLongEdge: msg.fullLongEdge, seed: msg.seed, opts: msg.opts
      });
      const ms = performance.now() - t0;
      self.postMessage({
        type: 'result', id: msg.id, ms,
        width: res.width, height: res.height, fullWidth: res.fullWidth, fullHeight: res.fullHeight,
        region: res.region, hist: res.hist, clip: res.clip, buffer: res.data.buffer, buffer16: res.data16 ? res.data16.buffer : null
      }, res.data16 ? [res.data.buffer, res.data16.buffer] : [res.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, error: String(err && err.stack || err) });
  }
};
