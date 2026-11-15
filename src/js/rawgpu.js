/* =====================================================================
 * photos.jpeg — RAW development on the graphics card (runs in a worker).
 *
 * The same steps as RawDec.develop + chromaNR, as WebGL 2 shaders on an
 * OffscreenCanvas: white balance, Malvar-He-Cutler demosaic, highlight
 * handling, camera → sRGB matrix, rawlog encoding with dither, then the
 * colour-noise blur. One draw per step for the whole image; the result is
 * read back into the shared output buffer.
 *
 * Only plain 2×2 Bayer mosaics are handled. Anything else — and any
 * failure — returns false and the caller develops on the CPU workers.
 * ===================================================================== */
(function (global) {
  'use strict';

  const VS = `#version 300 es
  void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

  // Step 1: mosaic → developed, rawlog-encoded RGB (what RawDec.develop writes)
  const FS_DEVELOP = `#version 300 es
  precision highp float; precision highp int; precision highp usampler2D;
  uniform usampler2D uMosaic;
  uniform ivec2 uCrop, uSensor, uOrigin;      // crop origin, sensor size, CFA origin
  uniform ivec4 uPat;                         // colour (0 R, 1 G, 2 B) at CFA cells (0,0) (1,0) (0,1) (1,1)
  uniform vec3 uGain, uCBlack, uClipAt;
  uniform float uBlack, uSat, uK;
  uniform mat3 uM;
  out vec4 o;
  int colorAt(ivec2 s) { ivec2 c = ((s - uOrigin) % 2 + 2) % 2; return uPat[c.y * 2 + c.x]; }
  // x: white-balanced value, y: 1 when the photosite is saturated
  // beyond the sensor's edge the mosaic is mirrored, which keeps the colour pattern going
  ivec2 mirror(ivec2 s) { s = abs(s); s = min(s, 2 * (uSensor - 1) - s); return clamp(s, ivec2(0), uSensor - 1); }
  vec2 site(ivec2 s) {
    s = mirror(s);
    float raw = float(texelFetch(uMosaic, s, 0).r);
    int c = colorAt(s);
    return vec2(max(0.0, raw - uBlack - uCBlack[c]) * uGain[c], raw - uBlack >= uSat ? 1.0 : 0.0);
  }
  float hash(vec2 p, float n) { return fract(sin(dot(p + n * 17.31, vec2(12.9898, 78.233))) * 43758.5453); }
  float enc(float v, float d) {
    float f = clamp(v / 16.0, 0.0, 1.0);
    return clamp(log2(f * 1024.0 + 1.0) / 10.001408194392809 * 255.0 + d - 0.5, 0.0, 255.0);
  }
  void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    ivec2 s = uCrop + px;
    vec2 c0 = site(s);
    vec2 N = site(s + ivec2(0, -1)), S = site(s + ivec2(0, 1)), E = site(s + ivec2(1, 0)), W = site(s + ivec2(-1, 0));
    float NN = site(s + ivec2(0, -2)).x, SS = site(s + ivec2(0, 2)).x, EE = site(s + ivec2(2, 0)).x, WW = site(s + ivec2(-2, 0)).x;
    vec2 NE = site(s + ivec2(1, -1)), NW = site(s + ivec2(-1, -1)), SE = site(s + ivec2(1, 1)), SW = site(s + ivec2(-1, 1));
    float v = c0.x;
    int c = colorAt(mirror(s));
    vec3 rgb = vec3(0.0);
    if (c == 1) {
      int hc = colorAt(mirror(s + ivec2(1, 0))), vc = colorAt(mirror(s + ivec2(0, 1)));
      float along = (5.0 * v + 0.5 * (NN + SS) - (WW + EE + NE.x + NW.x + SE.x + SW.x) + 4.0 * (E.x + W.x)) / 8.0;
      float across = (5.0 * v + 0.5 * (WW + EE) - (NN + SS + NE.x + NW.x + SE.x + SW.x) + 4.0 * (N.x + S.x)) / 8.0;
      rgb.g = v;
      if (hc == 0) rgb.r = along; else if (hc == 1) rgb.g = along; else rgb.b = along;
      if (vc == 0) rgb.r = across; else if (vc == 1) rgb.g = across; else rgb.b = across;
    } else {
      float gv = (4.0 * v + 2.0 * (N.x + S.x + E.x + W.x) - (NN + SS + EE + WW)) / 8.0;
      float ov = (6.0 * v + 2.0 * (NE.x + NW.x + SE.x + SW.x) - 1.5 * (NN + SS + EE + WW)) / 8.0;
      rgb.g = gv;
      if (c == 0) { rgb.r = v; rgb.b = ov; } else { rgb.b = v; rgb.r = ov; }
    }
    float clipped = c0.y + N.y + S.y + E.y + W.y + NE.y + NW.y + SE.y + SW.y;
    rgb = min(max(rgb, 0.0), uClipAt);
    if (clipped > 0.5) rgb = vec3(max(min(rgb.r, min(rgb.g, rgb.b)), 1.0));
    vec3 lin = (uM * rgb) * uK;
    float mn = min(lin.r, min(lin.g, lin.b));
    if (mn < 0.0) {
      float Y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
      lin = Y > 0.0 ? Y + (lin - Y) * (Y / (Y - mn)) : vec3(0.0);
    }
    vec2 fp = vec2(s);
    o = vec4(enc(lin.r, hash(fp, 1.0)), enc(lin.g, hash(fp, 2.0)), enc(lin.b, hash(fp, 3.0)), 255.0) / 255.0;
  }`;

  // Colour noise: chroma (R−G, B−G) of the 8-bit image, box-blurred along one axis
  const FS_CHROMA = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc; uniform ivec2 uSize, uDir; uniform int uRadius; uniform bool uFirst;
  out vec4 o;
  vec2 chroma(ivec2 p) {
    p = clamp(p, ivec2(0), uSize - 1);
    vec4 t = texelFetch(uSrc, p, 0);
    if (!uFirst) return t.rg;
    vec3 c = floor(t.rgb * 255.0 + 0.5);
    return vec2(c.r - c.g, c.b - c.g);
  }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec2 acc = vec2(0.0);
    for (int i = -uRadius; i <= uRadius; i++) acc += chroma(p + uDir * i);
    o = vec4(floor(acc / float(2 * uRadius + 1) + 0.5), 0.0, 1.0);
  }`;
  // …first pass along x reads the image, the other three read the previous blur

  // Final: blend the blurred chroma back (RawDec.chromaNR's last loop)
  const FS_BLEND = `#version 300 es
  precision highp float;
  uniform sampler2D uImage, uChroma; uniform float uAmount;
  out vec4 o;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 c = floor(texelFetch(uImage, p, 0).rgb * 255.0 + 0.5);
    vec2 blur = texelFetch(uChroma, p, 0).rg;
    float g = c.g, r0 = c.r - g, b0 = c.b - g;
    float dr = blur.r - r0, db = blur.g - b0;
    float k = uAmount / (1.0 + (dr * dr + db * db) / 900.0);
    float r = r0 + dr * k, b = b0 + db * k;
    float g2 = g - (0.2126 * (r - r0) + 0.0722 * (b - b0)) / (0.2126 + 0.7152 + 0.0722);
    o = vec4(clamp(vec3(g2 + r, g2, g2 + b), 0.0, 255.0) / 255.0, 1.0);
  }`;

  let ctx = null, failed = false;

  function program(gl, fs) {
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function context() {
    if (ctx || failed) return ctx;
    try {
      if (typeof OffscreenCanvas === 'undefined') throw new Error('no OffscreenCanvas');
      const canvas = new OffscreenCanvas(16, 16);
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance', premultipliedAlpha: false });
      if (!gl) throw new Error('no WebGL 2');
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('no float render targets');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) throw new Error('software renderer');
      ctx = { gl, develop: program(gl, FS_DEVELOP), chroma: program(gl, FS_CHROMA), blend: program(gl, FS_BLEND), fbo: gl.createFramebuffer(), maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
      canvas.addEventListener('webglcontextlost', () => { ctx = null; });
    } catch (e) { failed = true; ctx = null; }
    return ctx;
  }

  function texture(gl, internal, w, h, format, type, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data || null);
    return t;
  }

  /**
   * Develop the whole image into shared.out (RGBA). opts as RawDec.strip, without rows.
   * Returns { width, height } or false when the graphics card can't be used for this file.
   */
  function develop(shared, opts) {
    const info = shared.info, cfa = info.cfa, crop = info.crop;
    if (!cfa || !cfa.dim || cfa.dim[0] !== 2 || cfa.dim[1] !== 2 || info.linearRaw) return false;
    const c = context();
    if (!c) return false;
    const gl = c.gl, W = info.W, H = info.H, w = crop.w, h = crop.h;
    if (Math.max(W, H) > c.maxTex) return false;
    const made = [];
    try {
      const wb = opts.wb, minWb = Math.min(wb[0], wb[1], wb[2]);
      const scale = 1 / Math.max(1, info.white - info.black);
      const pat = Array.from(cfa.pat).slice(0, 4).map(x => x === 3 ? 1 : x);
      const mosaic = texture(gl, gl.R16UI, W, H, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(shared.mosaic)); made.push(mosaic);
      const image = texture(gl, gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE); made.push(image);
      const target = (tex) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer');
        gl.viewport(0, 0, w, h);
      };
      const U = (p, n) => gl.getUniformLocation(p, n);

      // 1. develop
      gl.useProgram(c.develop);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mosaic); gl.uniform1i(U(c.develop, 'uMosaic'), 0);
      gl.uniform2i(U(c.develop, 'uCrop'), crop.x, crop.y);
      gl.uniform2i(U(c.develop, 'uSensor'), W, H);
      gl.uniform2i(U(c.develop, 'uOrigin'), cfa.origin ? cfa.origin[0] : 0, cfa.origin ? cfa.origin[1] : 0);
      gl.uniform4i(U(c.develop, 'uPat'), pat[0], pat[1], pat[2], pat[3]);
      gl.uniform3f(U(c.develop, 'uGain'), wb[0] / minWb * scale, wb[1] / minWb * scale, wb[2] / minWb * scale);
      gl.uniform3f(U(c.develop, 'uCBlack'), info.cblack[0] || 0, info.cblack[1] || 0, info.cblack[2] || 0);
      gl.uniform3f(U(c.develop, 'uClipAt'), wb[0] / minWb, wb[1] / minWb, wb[2] / minWb);
      gl.uniform1f(U(c.develop, 'uBlack'), info.black);
      gl.uniform1f(U(c.develop, 'uSat'), (info.white - info.black) * 0.995);
      gl.uniform1f(U(c.develop, 'uK'), opts.exposure || 1);
      gl.uniformMatrix3fv(U(c.develop, 'uM'), true, new Float32Array(opts.m));
      target(image);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      let final = image;
      if (opts.chromaNR > 0) {
        // 2. chroma blur: x, y, x, y
        const a = texture(gl, gl.RG16F, w, h, gl.RG, gl.HALF_FLOAT), b = texture(gl, gl.RG16F, w, h, gl.RG, gl.HALF_FLOAT);
        made.push(a, b);
        gl.useProgram(c.chroma);
        gl.uniform1i(U(c.chroma, 'uSrc'), 0);
        gl.uniform2i(U(c.chroma, 'uSize'), w, h);
        gl.uniform1i(U(c.chroma, 'uRadius'), opts.nrRadius || 1);
        const pass = (src, dst, dx, dy, first) => {
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
          gl.uniform2i(U(c.chroma, 'uDir'), dx, dy); gl.uniform1i(U(c.chroma, 'uFirst'), first ? 1 : 0);
          target(dst); gl.drawArrays(gl.TRIANGLES, 0, 3);
        };
        pass(image, a, 1, 0, true); pass(a, b, 0, 1, false); pass(b, a, 1, 0, false); pass(a, b, 0, 1, false);
        // 3. blend
        final = texture(gl, gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE); made.push(final);
        gl.useProgram(c.blend);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, image); gl.uniform1i(U(c.blend, 'uImage'), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b); gl.uniform1i(U(c.blend, 'uChroma'), 1);
        gl.uniform1f(U(c.blend, 'uAmount'), opts.chromaNR);
        target(final); gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.activeTexture(gl.TEXTURE0);
      }
      // rows come out in image order: fragment y is the image row (nothing is drawn to a screen)
      target(final);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(shared.out));
      if (gl.getError() !== gl.NO_ERROR) throw new Error('GL error');
      return { width: w, height: h };
    } catch (e) {
      failed = true;        // one failure: use the CPU from now on in this worker
      return false;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const t of made) gl.deleteTexture(t);
    }
  }

  global.PJ = global.PJ || {};
  global.PJ.RawGpu = { develop };
})(typeof self !== 'undefined' ? self : this);
