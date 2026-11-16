/* =====================================================================
 * photos.jpeg — JPEG XL image data inside a DNG, in a thread of its own.
 *
 * Newer phones (Samsung Galaxy S23 and later, DNG 1.7) store the raw
 * picture as one JPEG XL image. jxl-oxide (vendor/jxl, MIT / Apache 2.0)
 * decodes it at its full bit depth; the picture is read out in bands, each
 * handed over as a 16-bit PNG, which is unpacked here.
 *
 * Several of these threads can share one picture, each reading its own
 * strip of rows (top, rows), which is what makes a 50-megapixel file
 * bearable: the decoder itself works on one processor only.
 *
 * in:  { id, data: Uint8Array — the JPEG XL image, width, height, top?, rows? }
 * out: { id, progress } while working, then { id, rgb16: Uint16Array(w·rows·3) — 0…65535, top, rows } or { id, error }
 * ===================================================================== */
import init, { JxlImage } from '../vendor/jxl/jxl_oxide_wasm.js';
let ready = null;

/** The pixels of a 16-bit RGB PNG written by the decoder: unpacked into out at row `top`. */
async function pngRows(png, out, W, top) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength), w = dv.getUint32(16), h = dv.getUint32(20), depth = png[24], type = png[25];
  if (depth !== 16 || (type !== 2 && type !== 6)) throw new Error(`unexpected picture format (${depth} bit, type ${type})`);
  const ch = type === 6 ? 4 : 3, bpp = ch * 2, stride = w * bpp;
  const parts = [];
  for (let p = 8; p + 12 <= png.length;) { const len = dv.getUint32(p), t = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]); if (t === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + len)); p += 12 + len; }
  const raw = new Uint8Array(await new Response(new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  if (raw.length < (stride + 1) * h) throw new Error('the picture data is incomplete');
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v;
    }
    let o = ((top + y) * W) * 3;
    for (let x = 0; x < w; x++) { const q = x * bpp; out[o++] = (cur[q] << 8) | cur[q + 1]; out[o++] = (cur[q + 2] << 8) | cur[q + 3]; out[o++] = (cur[q + 4] << 8) | cur[q + 5]; }
    const t = prev; prev = cur; cur = t;
  }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    await (ready || (ready = init()));
    const img = new JxlImage();
    img.forceSrgb = false;                          // the numbers as they were stored, not converted for a screen
    for (let o = 0; o < m.data.length; o += 8 << 20) img.feedBytes(m.data.subarray(o, Math.min(m.data.length, o + (8 << 20))));
    if (!img.tryInit()) throw new Error('the JPEG XL data is incomplete');
    const W = img.width, H = img.height;
    if (m.width && (W !== m.width || H !== m.height)) throw new Error(`the JPEG XL picture is ${W}×${H}, the file says ${m.width}×${m.height}`);
    const top = Math.max(0, m.top | 0), rows = Math.min(H - top, m.rows > 0 ? m.rows : H);
    const out = new Uint16Array(W * rows * 3), band = 384;
    for (let y = 0; y < rows; y += band) {
      const hh = Math.min(band, rows - y);
      img.renderingRegion = { left: 0, top: top + y, width: W, height: hh };
      const png = img.render().encodeToPng();          // handing the band over as a PNG also releases it
      await pngRows(png, out, W, y);
      self.postMessage({ id: m.id, progress: (y + hh) / rows });
    }
    try { img.free(); } catch (_) { }
    self.postMessage({ id: m.id, rgb16: out, width: W, height: H, top, rows }, [out.buffer]);
  } catch (e) {
    self.postMessage({ id: m.id, error: String(e && e.message || e) });
  }
};
