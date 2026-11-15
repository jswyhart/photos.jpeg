/* =====================================================================
 * photos.jpeg — the mask models' own thread.
 *
 * Loads ONNX Runtime Web and the models, and runs them away from the
 * interface: a first run has to fetch and compile a model (up to a second),
 * and that must not freeze the window.
 *
 * in:  { id, model, file, size, input: Float32Array(3·size·size), dims?, all? }
 * out: { id, data: Float32Array, dims } — the model's first output — or, with all = true,
 *      { id, outs: { name: { data, dims } } } for every output; { id, error } when it fails
 * ===================================================================== */
const base = new URL('../vendor/ml/', import.meta.url).href;
let ortPromise = null;
const sessions = {};

function runtime() {
  if (!ortPromise) {
    ortPromise = import(base + 'ort.wasm.min.mjs').then((ort) => {
      ort.env.wasm.wasmPaths = base;
      // The runtime's helper threads cannot be started from inside a worker in this app (their script
      // request is not served there), so a model runs on this one thread: about half a second
      // instead of a fifth, but the window stays live throughout.
      ort.env.wasm.numThreads = 1;
      return ort;
    });
  }
  return ortPromise;
}

async function session(model, file) {
  if (!sessions[model]) {
    const ort = await runtime();
    sessions[model] = ort.InferenceSession.create(base + file, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
      .catch((e) => { delete sessions[model]; throw e; });
  }
  return sessions[model];
}

let chain = Promise.resolve();          // one run at a time: the runtime's threads are shared
self.onmessage = (ev) => {
  const m = ev.data;
  chain = chain.then(async () => {
    try {
      const ort = await runtime(), s = await session(m.model, m.file);
      const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', m.input, m.dims || [1, 3, m.size, m.size]) });
      if (m.all) {
        const outs = {}, hand = [];
        for (const name of s.outputNames) { const d = new Float32Array(out[name].data); outs[name] = { data: d, dims: Array.from(out[name].dims) }; hand.push(d.buffer); }
        self.postMessage({ id: m.id, outs }, hand);
        return;
      }
      const t = out[s.outputNames[0]];
      const data = new Float32Array(t.data);       // a copy that can be handed over
      self.postMessage({ id: m.id, data, dims: Array.from(t.dims) }, [data.buffer]);
    } catch (e) {
      self.postMessage({ id: m.id, error: String(e && e.message || e) });
    }
  });
};
