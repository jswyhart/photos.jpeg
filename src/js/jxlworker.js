/* =====================================================================
 * photos.jpeg — JPEG XL encoding, in a thread of its own.
 *
 * in:  { id, data: Uint8ClampedArray (RGBA), width, height, quality (1…100), lossless }
 * out: { id, bytes: Uint8Array } or { id, error }
 * ===================================================================== */
import factory from '../vendor/jxl/jxl_enc.js';
const base = new URL('../vendor/jxl/', import.meta.url).href;
let modulePromise = null;
const encoder = () => modulePromise || (modulePromise = factory({ locateFile: (f) => base + f }));

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    const mod = await encoder();
    const lossless = !!m.lossless || m.quality >= 100;
    const out = mod.encode(m.data, m.width, m.height, {
      effort: 5, quality: lossless ? 100 : m.quality, progressive: false, epf: -1, lossyPalette: false,
      decodingSpeedTier: 0, photonNoiseIso: 0, lossyModular: false, lossless
    });
    if (!out) throw new Error('the encoder returned nothing');
    const bytes = new Uint8Array(out);            // a copy outside the encoder's memory
    self.postMessage({ id: m.id, bytes }, [bytes.buffer]);
  } catch (e) {
    self.postMessage({ id: m.id, error: String(e && e.message || e) });
  }
};
