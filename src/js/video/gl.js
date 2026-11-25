/* =====================================================================
 * photos.jpeg — GPU (WebGL2) develop renderer for video.
 * A shader port of pipeline.js so grading plays back in real time:
 *   pass 1  geometry + input transfer (sRGB or camera log → Rec.709)
 *           + lens vignette + calibration + white balance + exposure
 *           + mask-local exposure/temp/tint            → RGBA16F
 *           (with luminance noise reduction on, pass 1 runs in two halves around the
 *           wavelet passes: up to the input transfer, the wavelet shrinkage — the same
 *           layers and thresholds as pipeline.js — then the rest)
 *   blurs   luma pyramids for highlights/shadows/clarity, texture, dehaze
 *   pass 2  dehaze, contrast, H/S/W/B, clarity, texture (global + masks),
 *           color stage via 3D LUT built by the CPU engine, local saturation,
 *           post-crop vignette, film grain, sharpening, NR, overlays
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline;
  const MAX_MASKS = 8, MAX_BRUSH = 4, LUT_N = 33;


  const VS = `#version 300 es
  in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

  /* ---------------- shared GLSL ---------------- */
  const COMMON = `#version 300 es
  precision highp float; precision highp int; precision highp sampler3D;
  uniform vec2 uOut;        // full output size (px) at this render level
  uniform vec2 uTarget;     // size of the whole picture being drawn (the framebuffer, unless only a window of it is drawn)
  uniform vec2 uOrg;        // where the framebuffer's corner lies in that picture (0, 0 unless a window is drawn)
  uniform vec2 uSrcSize;    // source texture size
  // geometry
  uniform vec2 uX0Y0; uniform float uCa, uSa, uSc, uAsp, uHalf, uKv, uKh, uHalfDiag2, uKd, uPolyR, uFish; uniform vec4 uPoly;
  uniform vec2 uOffP; uniform vec2 uWoHo; uniform int uOrient; uniform bool uFlipH, uFlipV, uNonlin;
  // masks
  uniform int uMaskCount;
  uniform int uMType[${MAX_MASKS}];
  uniform vec4 uMA[${MAX_MASKS}], uMB[${MAX_MASKS}], uMC[${MAX_MASKS}], uMD[${MAX_MASKS}];
  uniform vec4 uAdjA[${MAX_MASKS}], uAdjB[${MAX_MASKS}], uAdjC[${MAX_MASKS}];
  uniform sampler2D uBrush0, uBrush1, uBrush2, uBrush3;
  uniform vec2 uBrushGrid[${MAX_BRUSH}];
  uniform float uL;          // source long edge (px)

  vec2 outCoord(){ vec2 f = (gl_FragCoord.xy + uOrg) / uTarget * uOut; return vec2(f.x, uOut.y - f.y); }

  vec2 toSource(vec2 o){
    vec2 d = uX0Y0 + o;
    vec2 p = vec2(uCa*d.x - uSa*d.y, uSa*d.x + uCa*d.y);
    p = p / uSc - uOffP;
    p.x /= uAsp; p.y *= uAsp;
    if (uNonlin) {
      if (uKv != 0.0 || uKh != 0.0) { vec2 n = p / uHalf; p = vec2(p.x * (1.0 + uKv*n.y), p.y * (1.0 + uKh*n.x)); }
      if (uKd != 0.0) { float f = 1.0 + uKd * dot(p,p) / uHalfDiag2; p *= f; }
      if (uFish != 0.0) { float u = length(p) / uFish; if (u > 1e-6) p *= atan(u) / u; }
      if (uPolyR != 0.0) { float r = length(p) / uPolyR; p *= 1.0 + r * (uPoly.x + r * (uPoly.y + r * (uPoly.z + r * uPoly.w))); }
    }
    vec2 q = p + uWoHo * 0.5;
    if (uFlipH) q.x = uWoHo.x - q.x;
    if (uFlipV) q.y = uWoHo.y - q.y;
    vec2 W = uSrcSize;
    if (uOrient == 90) return vec2(q.y, W.y - q.x);
    if (uOrient == 180) return vec2(W.x - q.x, W.y - q.y);
    if (uOrient == 270) return vec2(W.x - q.y, q.x);
    return q;
  }

  float sstep(float a, float b, float x){ if (a == b) return x < a ? 0.0 : 1.0; float t = clamp((x - a)/(b - a), 0.0, 1.0); return t*t*(3.0 - 2.0*t); }

  float brushAt(int k, vec2 uvL){
    vec2 g = uBrushGrid[k];
    vec2 uv = uvL * 512.0 / g;
    if (k == 0) return texture(uBrush0, uv).r;
    if (k == 1) return texture(uBrush1, uv).r;
    if (k == 2) return texture(uBrush2, uv).r;
    return texture(uBrush3, uv).r;
  }

  // a mask's own shape, with its invert, luminance range and colour range; c0 = the source colour (gamma)
  float maskShape(int i, vec2 s, float y0, vec3 c0){
    vec2 u = s / uL;
    float w = 0.0;
    int t = uMType[i];
    vec4 A = uMA[i], B = uMB[i], C = uMC[i];
    if (t == 0) {            // linear: A = x0,y0,x1,y1
      vec2 d = A.zw - A.xy; float len2 = max(dot(d,d), 1e-9);
      float tt = dot(u - A.xy, d) / len2;
      w = 1.0 - sstep(0.0, 1.0, tt);
    } else if (t == 1) {     // radial: A = cx,cy,rx,ry  B.x = angle(rad) B.y = feather
      float ca = cos(-B.x), sa = sin(-B.x);
      vec2 v = u - A.xy;
      vec2 r = vec2((ca*v.x - sa*v.y)/A.z, (sa*v.x + ca*v.y)/A.w);
      w = 1.0 - sstep(1.0 - B.y, 1.0001, length(r));
    } else {                 // brush: B.z = brush slot
      w = brushAt(int(B.z), u);
    }
    if (B.w > 0.5) w = 1.0 - w;     // invert
    // C = lumMin, lumMax, smooth, amount
    if (C.x > 0.0 || C.y < 1.0) {
      float sm = max(0.02, C.z * 0.3);
      w *= sstep(C.x - sm, C.x + 1e-4, y0) * (1.0 - sstep(C.y - 1e-4, C.y + sm, y0));
    }
    // D = hue, tolerance, colour range on, combine (+n: intersect with mask n−1, −n: subtract it)
    vec4 D = uMD[i];
    if (D.z > 0.5 && w > 0.0) {
      float mx = max(c0.r, max(c0.g, c0.b)), mn = min(c0.r, min(c0.g, c0.b)), ch = mx - mn, hh = 0.0;
      if (ch > 1e-6) {
        if (mx == c0.r) hh = mod((c0.g - c0.b) / ch, 6.0); else if (mx == c0.g) hh = (c0.b - c0.r) / ch + 2.0; else hh = (c0.r - c0.g) / ch + 4.0;
        hh /= 6.0;
      }
      float sat = mx > 1e-4 ? ch / mx : 0.0;
      float d = abs(fract(hh - D.x + 0.5) - 0.5), soft = max(0.02, D.y * 0.5);
      w *= (1.0 - sstep(D.y, D.y + soft, d)) * sstep(0.04, 0.12, sat);
    }
    return w;
  }
  float maskWeight(int i, vec2 s, float y0, vec3 c0){
    float w = maskShape(i, s, y0, c0), lc = uMD[i].w;
    if (lc > 0.5) w *= maskShape(int(lc + 0.5) - 1, s, y0, c0);
    else if (lc < -0.5) w *= 1.0 - maskShape(int(-lc + 0.5) - 1, s, y0, c0);
    return w * uMC[i].w;
  }

  vec3 wbGains(float temp, float tint){
    float a = (temp/100.0)*0.9, c = (tint/100.0)*0.6;
    vec3 g = vec3(exp2(a), exp2(-c), exp2(-a));
    float n = 0.2126*g.r + 0.7152*g.g + 0.0722*g.b;
    return g / n;
  }
  float toLin1(float x){ return x <= 0.04045 ? x/12.92 : pow((x + 0.055)/1.055, 2.4); }
  float toSrgb1(float x){ return x <= 0.0031308 ? x*12.92 : 1.055*pow(x, 1.0/2.4) - 0.055; }
  vec3 toLin(vec3 c){ return vec3(toLin1(max(c.r,0.0)), toLin1(max(c.g,0.0)), toLin1(max(c.b,0.0))); }
  vec3 toSrgb(vec3 c){ return vec3(toSrgb1(max(c.r,0.0)), toSrgb1(max(c.g,0.0)), toSrgb1(max(c.b,0.0))); }
  float luma(vec3 c){ return 0.2126*c.r + 0.7152*c.g + 0.0722*c.b; }
  `;

  /* ---------------- pass 1 ---------------- */
  const PASS1 = COMMON + `
  uniform sampler2D uSrc;
  uniform bool uLog;             // camera-log input: code → linear via LUT, gamut matrix, shoulder
  uniform sampler2D uInLut; uniform mat3 uInMat; uniform float uKnee;
  uniform bool uCubeIn; uniform highp sampler3D uCube; uniform float uCubeAmt, uCubeN;   // imported .cube used as a camera LUT
  uniform bool uSI;              // per-file source transform (developed RAW): display LUT, rawlog decode, matrix
  uniform sampler2D uSiLut, uDecLut; uniform mat3 uSiMat; uniform mat3 uSiPre; uniform bool uSiPreOn; uniform bool uSrcP3;
  float lk(sampler2D t, float v){   // same linear interpolation as the CPU's 256-entry lookups
    float f = clamp(v, 0.0, 1.0) * 255.0; int i = min(int(f), 254);
    return mix(texelFetch(t, ivec2(i, 0), 0).r, texelFetch(t, ivec2(i + 1, 0), 0).r, f - float(i));
  }
  uniform vec3 uGain;            // WB * exposure
  uniform mat3 uCalib; uniform bool uHasCalib;
  uniform float uLensVig, uLensMid; uniform vec4 uProfVig; uniform float uTcaR; uniform vec2 uTcaV, uTcaC, uTcaB;
  uniform bool uLocalLin;
  // 0: the whole pass. 1: only up to the input transfer (rgb, brightness in a) — what noise reduction works on.
  // 2: the rest, starting from stage 1's picture (uPre) with the denoised brightness (uNr: smooth layer + kept detail).
  uniform int uStage; uniform sampler2D uPre, uNr;
  out vec4 frag;

  void main(){
    vec2 o = outCoord();
    vec2 s = toSource(o);
    vec3 raw; vec3 lin;
    if (uStage == 2) {
      ivec2 q = ivec2(gl_FragCoord.xy);
      vec4 pre = texelFetch(uPre, q, 0); vec2 nr = texelFetch(uNr, q, 0).rg;
      raw = pre.rgb + (nr.r + nr.g - pre.a);
      lin = toLin(raw);
    } else {
    bool inside = !(s.x < -0.5 || s.y < -0.5 || s.x > uSrcSize.x + 0.5 || s.y > uSrcSize.y + 0.5);
    raw = inside ? texture(uSrc, s / uSrcSize).rgb : vec3(0.11);
    if (inside && uTcaR != 0.0) {
      // lens profile: red and blue are read where the lens actually put them
      vec2 cen = uSrcSize * 0.5, dd = s - cen; float tr = length(dd) / uTcaR;
      raw.r = texture(uSrc, (cen + dd * (uTcaV.x + tr * (uTcaC.x + tr * uTcaB.x))) / uSrcSize).r;
      raw.b = texture(uSrc, (cen + dd * (uTcaV.y + tr * (uTcaC.y + tr * uTcaB.y))) / uSrcSize).b;
    }
    if (uCubeIn && inside) {
      vec3 cc = clamp(raw, 0.0, 1.0);
      raw = mix(cc, texture(uCube, cc * ((uCubeN - 1.0)/uCubeN) + 0.5/uCubeN).rgb, uCubeAmt);
      lin = toLin(raw);
    } else if (uLog && inside) {
      vec3 cc = clamp(raw, 0.0, 1.0) * (255.0/256.0) + 0.5/256.0;
      lin = vec3(texture(uInLut, vec2(cc.r, 0.5)).r, texture(uInLut, vec2(cc.g, 0.5)).r, texture(uInLut, vec2(cc.b, 0.5)).r);
      lin = max(uInMat * lin, 0.0);
      if (uKnee < 1.0) { float r = 1.0 - uKnee; lin = mix(lin, uKnee + r*(1.0 - exp(-(lin - uKnee)/r)), step(uKnee, lin)); }
      raw = toSrgb(lin);
    } else if (uSI && inside) {
      vec3 cc = clamp(raw, 0.0, 1.0);
      vec3 sd = vec3(lk(uDecLut, cc.r), lk(uDecLut, cc.g), lk(uDecLut, cc.b));
      if (uSiPreOn) { sd = max(uSiPre * sd, 0.0); cc = clamp(log2(sd * 64.0 + 1.0) / 10.0014082, 0.0, 1.0); }
      vec3 l = vec3(lk(uSiLut, cc.r), lk(uSiLut, cc.g), lk(uSiLut, cc.b));
      float smax = max(sd.r, max(sd.g, sd.b)), smin = min(sd.r, min(sd.g, sd.b));
      if (smax > 1e-6) {
        float sat = (smax - smin) / smax;
        if (sat > 0.5) {
          float k = lk(uSiLut, max(cc.r, max(cc.g, cc.b))) / smax;
          float t = clamp((sat - 0.5) / 0.4, 0.0, 1.0);
          l += (sd*k - l) * (t*t*(3.0 - 2.0*t));
        }
      }
      lin = max(uSiMat * l, 0.0);
      raw = toSrgb(lin);
    } else {
      lin = toLin(raw);
      if (uSrcP3 && inside) { lin = max(uSiPre * lin, 0.0); raw = toSrgb(lin); }      // a Display P3 picture edited in sRGB
    }
    if (uStage == 1) { frag = vec4(raw, luma(raw)); return; }
    }
    float y0 = luma(raw);
    if (uLensVig != 0.0) {
      vec2 dc = s - uSrcSize*0.5;
      float rr = dot(dc,dc) / (dot(uSrcSize,uSrcSize)*0.25);
      lin *= 1.0 + uLensVig*1.4*sstep(uLensMid*0.5, 1.0, rr);
    }
    if (uProfVig.x != 0.0) {
      // lens profile: divide by the share of light the lens leaves at this radius
      vec2 dc = s - uSrcSize*0.5;
      float q = dot(dc,dc) / (dot(uSrcSize,uSrcSize)*0.25) * uProfVig.x;
      lin /= max(0.2, 1.0 + q*(uProfVig.y + q*(uProfVig.z + q*uProfVig.w)));
    }
    if (uHasCalib) lin = max(uCalib * lin, 0.0);
    lin *= uGain;
    if (uLocalLin) {
      float ev = 0.0, lt = 0.0, li = 0.0;
      for (int i = 0; i < ${MAX_MASKS}; i++) {
        if (i >= uMaskCount) break;
        float w = maskWeight(i, s, y0, raw);
        if (w <= 0.0) continue;
        ev += uAdjA[i].z * w; lt += uAdjA[i].x * w; li += uAdjA[i].y * w;
      }
      if (ev != 0.0 || lt != 0.0 || li != 0.0) lin *= wbGains(lt, li) * exp2(ev);
    }
    frag = vec4(toSrgb(lin), y0);
  }`;

  /* ---------------- luminance noise reduction: wavelet shrinkage, as waveletDenoise() in pipeline.js ----------------
   * One layer takes two draws. uMode 0: the current layer smoothed along x (B3 spline, taps uGap apart).
   * uMode 1: that smoothed along y gives the next, coarser layer; the difference to the current one is this
   * layer's detail, of which what stands above the layer's noise level is kept and added to what earlier
   * layers kept. Output: r = the next layer, g = the detail kept so far. */
  const WAVE = `#version 300 es
  precision highp float; precision highp int;
  uniform sampler2D uA;      // the current layer: stage 1's picture (brightness in a) for the first layer, else r = layer, g = kept detail
  uniform sampler2D uT;      // uMode 1: the current layer smoothed along x
  uniform int uMode, uGap; uniform bool uFirst; uniform float uT2;
  out vec4 frag;
  float cur(ivec2 p, ivec2 size){ p = clamp(p, ivec2(0), size - 1); return uFirst ? texelFetch(uA, p, 0).a : texelFetch(uA, p, 0).r; }
  float tx(ivec2 p, ivec2 size){ return texelFetch(uT, clamp(p, ivec2(0), size - 1), 0).r; }
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(uA, 0);
    if (uMode == 0) {
      ivec2 g = ivec2(uGap, 0);
      frag = vec4((cur(p - 2 * g, size) + cur(p + 2 * g, size) + 4.0 * (cur(p - g, size) + cur(p + g, size)) + 6.0 * cur(p, size)) * 0.0625, 0.0, 0.0, 1.0);
      return;
    }
    ivec2 g = ivec2(0, uGap);
    float next = (tx(p - 2 * g, size) + tx(p + 2 * g, size) + 4.0 * (tx(p - g, size) + tx(p + g, size)) + 6.0 * tx(p, size)) * 0.0625;
    float d = cur(p, size) - next, d2 = d * d, k = 1.25 - 0.6 * next, t2 = uT2 * k * k;   // shadows and mid-tones carry more visible noise
    float kept = (uFirst ? 0.0 : texelFetch(uA, p, 0).g) + (d2 > t2 ? d * (1.0 - t2 / d2) : 0.0);
    frag = vec4(next, kept, 0.0, 1.0);
  }`;

  /* ---------------- reduce: luma (r) + dark channel (g) ---------------- */
  const REDUCE = `#version 300 es
  precision highp float;
  uniform sampler2D uTex; uniform float uLod; uniform vec2 uTarget;
  out vec4 frag;
  void main(){
    vec3 c = textureLod(uTex, gl_FragCoord.xy / uTarget, uLod).rgb;
    float y = min(1.5, 0.2126*c.r + 0.7152*c.g + 0.0722*c.b);
    frag = vec4(y, min(c.r, min(c.g, c.b)), 0.0, 1.0);
  }`;

  const BLUR = `#version 300 es
  precision highp float;
  uniform sampler2D uTex; uniform vec2 uDir; uniform float uSigma; uniform vec2 uTarget;
  out vec4 frag;
  void main(){
    vec2 uv = gl_FragCoord.xy / uTarget;
    vec2 px = uDir / uTarget;
    float r = ceil(uSigma * 3.0);
    vec4 acc = vec4(0.0); float wsum = 0.0;
    for (float i = -48.0; i <= 48.0; i += 1.0) {
      if (abs(i) > r) continue;
      float w = exp(-0.5 * i*i / (uSigma*uSigma));
      acc += texture(uTex, uv + px*i) * w; wsum += w;
    }
    frag = acc / wsum;
  }`;

  /* ---------------- the exact render (exports): colour noise reduction and sharpening as pipeline.js does them ----------------
   * The live preview folds both into pass 2, from a 5×5 neighbourhood of pass 1. That is close, but not what the
   * CPU does: it blurs the colour differences before white balance and exposure, and sharpens the finished
   * picture. For a render that is kept, these two programs do the same, in the same places. */
  // colour noise reduction on stage 1's picture (with the wavelet result, when luminance noise reduction ran):
  // uMode 0: the colour differences (B−Y, R−Y) blurred along x → rg. uMode 1: that blurred along y, then mixed in.
  const CHROMA = `#version 300 es
  precision highp float; precision highp int;
  uniform sampler2D uPre, uNr, uT; uniform bool uHasNr; uniform int uMode; uniform float uSigma, uAmt;
  out vec4 frag;
  vec4 at(ivec2 p, ivec2 size){            // rgb after luminance noise reduction, its brightness in a
    p = clamp(p, ivec2(0), size - 1);
    vec4 pre = texelFetch(uPre, p, 0);
    if (!uHasNr) return pre;
    vec2 nr = texelFetch(uNr, p, 0).rg; float yd = nr.r + nr.g;
    return vec4(pre.rgb + (yd - pre.a), yd);
  }
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(uPre, 0);
    int r = int(ceil(uSigma * 3.0));
    vec2 acc = vec2(0.0); float wsum = 0.0;
    for (int i = -48; i <= 48; i++) {
      if (i < -r || i > r) continue;
      float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
      if (uMode == 0) { vec4 q = at(p + ivec2(i, 0), size); acc += vec2(q.b - q.a, q.r - q.a) * w; }
      else acc += texelFetch(uT, clamp(p + ivec2(0, i), ivec2(0), size - 1), 0).rg * w;
      wsum += w;
    }
    acc /= wsum;
    if (uMode == 0) { frag = vec4(acc, 0.0, 1.0); return; }
    vec4 c = at(p, size); float y = c.a;
    float cb = mix(c.b - y, acc.x, uAmt), cr = mix(c.r - y, acc.y, uAmt);
    float R = y + cr, B = y + cb;
    frag = vec4(R, (y - 0.2126 * R - 0.0722 * B) / 0.7152, B, 0.0);      // a = 0: stage 2 adds nothing more to it
  }`;
  // one box of the three the CPU engine's blur is made of (blurPlane in pipeline.js): the mean over 2·uR + 1
  // pixels along uDir, the picture's edge pixel standing in for what lies beyond it
  const BOX = `#version 300 es
  precision highp float; precision highp int;
  uniform sampler2D uTex; uniform int uR; uniform ivec2 uDir; uniform bool uLuma;
  out vec4 frag;
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(uTex, 0);
    float acc = 0.0;
    for (int i = -64; i <= 64; i++) {
      if (i < -uR || i > uR) continue;
      vec4 c = texelFetch(uTex, clamp(p + uDir * i, ivec2(0), size - 1), 0);
      acc += uLuma ? dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) : c.r;
    }
    frag = vec4(acc / float(2 * uR + 1));
  }`;
  // sharpening of the finished picture: unsharp mask on its brightness, limited, and masked to edges
  const POST = `#version 300 es
  precision highp float; precision highp int;
  uniform sampler2D uImg, uYb, uYm; uniform float uAmt, uLim, uMask; uniform bool uHasYm;
  out vec4 frag;
  float sstep(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 c = texelFetch(uImg, p, 0).rgb; float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float d = clamp(Y - texelFetch(uYb, p, 0).r, -uLim, uLim), m = 1.0;
    if (uHasYm) m = sstep(uMask * 0.012, uMask * 0.05 + 0.002, abs(Y - texelFetch(uYm, p, 0).r));
    frag = vec4(clamp(c + d * uAmt * m, 0.0, 1.0), 1.0);
  }`;

  /* ---------------- pass 2 ---------------- */
  const PASS2 = COMMON + `
  uniform sampler2D uP1, uYl, uYt, uDC;
  uniform bool uMaskColor; uniform vec3 uUngain;
  uniform sampler3D uLut; uniform float uLutN; uniform bool uLutTetra;
  // the colour table read the way the CPU engine reads its own (tetrahedral, between the four nearest entries):
  // for the exact render, which also uses the CPU's table size
  vec3 lutTetra(vec3 c){
    float m = uLutN - 1.0; vec3 p = clamp(c, 0.0, 1.0) * m;
    ivec3 i = ivec3(min(floor(p), vec3(m - 1.0))); vec3 f = p - vec3(i);
    vec3 c000 = texelFetch(uLut, i, 0).rgb, c111 = texelFetch(uLut, i + ivec3(1), 0).rgb;
    if (f.r >= f.g) {
      if (f.g >= f.b) { vec3 a = texelFetch(uLut, i + ivec3(1, 0, 0), 0).rgb, b = texelFetch(uLut, i + ivec3(1, 1, 0), 0).rgb; return c000 + f.r * (a - c000) + f.g * (b - a) + f.b * (c111 - b); }
      if (f.r >= f.b) { vec3 a = texelFetch(uLut, i + ivec3(1, 0, 0), 0).rgb, b = texelFetch(uLut, i + ivec3(1, 0, 1), 0).rgb; return c000 + f.r * (a - c000) + f.b * (b - a) + f.g * (c111 - b); }
      vec3 a = texelFetch(uLut, i + ivec3(0, 0, 1), 0).rgb, b = texelFetch(uLut, i + ivec3(1, 0, 1), 0).rgb; return c000 + f.b * (a - c000) + f.r * (b - a) + f.g * (c111 - b);
    }
    if (f.b >= f.g) { vec3 a = texelFetch(uLut, i + ivec3(0, 0, 1), 0).rgb, b = texelFetch(uLut, i + ivec3(0, 1, 1), 0).rgb; return c000 + f.b * (a - c000) + f.g * (b - a) + f.r * (c111 - b); }
    if (f.b >= f.r) { vec3 a = texelFetch(uLut, i + ivec3(0, 1, 0), 0).rgb, b = texelFetch(uLut, i + ivec3(0, 1, 1), 0).rgb; return c000 + f.g * (a - c000) + f.b * (b - a) + f.r * (c111 - b); }
    vec3 a = texelFetch(uLut, i + ivec3(0, 1, 0), 0).rgb, b = texelFetch(uLut, i + ivec3(1, 1, 0), 0).rgb; return c000 + f.g * (a - c000) + f.r * (b - a) + f.b * (c111 - b);
  }
  uniform float uContrast, uHigh, uShad, uWhite, uBlack, uTex, uClar, uDeh;
  uniform bool uHasYl, uHasYt, uHasDC, uLocalTone, uLocalSat, uUseLut;
  uniform bool uCubeLook; uniform highp sampler3D uCube; uniform float uCubeAmt, uCubeN;   // imported creative .cube
  uniform float uVigA, uVigInner, uVigOuter, uVigRound, uVigHl;
  uniform float uGrainA, uGrainCell, uGrainRough, uRs; uniform uint uSeed;
  uniform float uSharpAmt, uSharpLim, uSharpRad, uSharpMask;
  uniform float uNrLuma, uNrDetail, uNrColor;
  uniform bool uClipHi, uClipLo; uniform int uOverlayMask; uniform bool uToP3;
  uniform vec2 uP1Size;
  out vec4 frag;

  float hash2(int x, int y, int seed){
    uint h = uint(x) * 374761393u + uint(y) * 668265263u + uint(seed) * 982451653u;
    h = (h ^ (h >> 13u)) * 1274126177u;
    h = h ^ (h >> 16u);
    return float(h) * 2.3283064365386963e-10;
  }
  float vnoise(vec2 p, int seed){
    vec2 i = floor(p), f = p - i;
    vec2 u = f*f*(3.0 - 2.0*f);
    int xi = int(i.x), yi = int(i.y);
    float a = hash2(xi, yi, seed), b = hash2(xi+1, yi, seed), c = hash2(xi, yi+1, seed), d = hash2(xi+1, yi+1, seed);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main(){
    vec2 o = outCoord();
    vec2 uv = (gl_FragCoord.xy + uOrg) / uTarget;
    vec4 p1 = texture(uP1, uv);
    vec3 c = p1.rgb; float y0 = p1.a;
    vec2 s = toSource(o);
    // the source colour, for masks limited to a colour: pass 1's result with the white balance and
    // exposure taken back out (close to what the final render uses; exact unless calibration or a
    // local white balance is also in play)
    vec3 c0 = uMaskColor ? toSrgb(toLin(c) / uUngain) : c;

    // 5×5 neighbourhood of pass 1 for sharpening and noise reduction
    float Yb = 0.0, wb = 0.0; vec3 Cb = vec3(0.0);
    float Y = luma(c);
    if (uSharpAmt > 0.0 || uNrLuma > 0.0 || uNrColor > 0.0) {
      vec2 px = 1.0 / uP1Size;
      float sig = max(0.5, uSharpRad);
      // luminance noise reduction is done by the wavelet passes before this one (uNrLuma is 0 here then);
      // without float textures it falls back to this edge-aware (bilateral) mean over two rings of neighbours
      float nT = 0.085 * uNrLuma * (1.25 - 0.6 * Y) * (1.6 - uNrDetail * 0.6), Yn = 0.0, wn = 0.0;
      for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
        float w = exp(-0.5 * float(i*i + j*j) / (sig*sig));
        vec3 q = texture(uP1, uv + vec2(float(i), float(j)) * px).rgb;
        float yq = luma(q);
        Yb += yq * w; Cb += q * w; wb += w;
        if (uNrLuma > 0.0) {
          float dy = (yq - Y) / max(nT, 1e-5);
          float wq = exp(-0.5 * float(i*i + j*j) / 3.0) * exp(-0.5 * dy * dy);
          Yn += yq * wq; wn += wq;
          // a wider ring for the coarse blotches
          float yf = luma(texture(uP1, uv + vec2(float(i), float(j)) * px * 3.0).rgb), df = (yf - Y) / max(nT * 0.7, 1e-5);
          float wf = 0.5 * exp(-0.5 * float(i*i + j*j) / 3.0) * exp(-0.5 * df * df);
          Yn += yf * wf; wn += wf;
        }
      }
      Yb /= wb; Cb /= wb;
      if (uNrLuma > 0.0) {
        float dd = Yn / wn - Y;
        c += dd; Y += dd;
      }
      if (uNrColor > 0.0) {
        vec3 chromaC = c - Y, chromaB = Cb - luma(Cb);
        c = Y + mix(chromaC, chromaB, uNrColor);
      }
    }

    // ---- per-pixel tone parameters (global + masks)
    float cC = uContrast, cH = uHigh, cS = uShad, cW = uWhite, cB = uBlack, cTex = uTex, cClar = uClar, cDeh = uDeh, cSat = 0.0;
    float mw[${MAX_MASKS}];
    for (int i = 0; i < ${MAX_MASKS}; i++) {
      mw[i] = 0.0;
      if (i >= uMaskCount) break;
      if (!(uLocalTone || uLocalSat) && uOverlayMask != i) continue;
      float w = maskWeight(i, s, y0, c0);
      mw[i] = w;
      if (w <= 0.0) continue;
      cC += uAdjA[i].w * w; cH += uAdjB[i].x * w; cS += uAdjB[i].y * w; cW += uAdjB[i].z * w; cB += uAdjB[i].w * w;
      cTex += uAdjC[i].x * w; cClar += uAdjC[i].y * w; cDeh += uAdjC[i].z * w; cSat += uAdjC[i].w * w;
    }
    float yl = uHasYl ? texture(uYl, uv).r : luma(c);
    float yt = uHasYt ? texture(uYt, uv).r : luma(c);
    float dk = uHasDC ? texture(uDC, uv).g : min(c.r, min(c.g, c.b));

    if (cDeh != 0.0) {
      float amt = clamp(cDeh/100.0, -1.0, 1.0);
      if (amt > 0.0) { float t = amt*0.85*dk; c = (c - t) / max(0.2, 1.0 - t); }
      else { float t = -amt*0.55; c += (vec3(0.82, 0.82, 0.84) - c) * t; }
    }
    if (cC != 0.0) {
      float k = clamp(cC/100.0, -1.0, 1.0) * 0.9;
      vec3 sc = c*c*(3.0 - 2.0*c);
      bvec3 inr = bvec3(c.r > 0.0 && c.r < 1.0, c.g > 0.0 && c.g < 1.0, c.b > 0.0 && c.b < 1.0);
      c = mix(c, c + k*(sc - c), vec3(inr));
    }
    if (cH != 0.0 || cS != 0.0 || cW != 0.0 || cB != 0.0) {
      float Yv = luma(c);
      float m = uHasYl ? 0.45*Yv + 0.55*yl : Yv;
      float dY = 0.0;
      if (cS != 0.0) { float sh = cS/100.0, ws = 1.0 - sstep(0.02, 0.62, m); dY += sh > 0.0 ? sh*0.42*ws*(1.0 - Yv)*(0.35 + Yv*1.3) : sh*0.38*ws*Yv; }
      if (cH != 0.0) { float hl = cH/100.0, wh = sstep(0.35, 1.0, m); dY += hl < 0.0 ? hl*0.42*wh*max(0.0, Yv - 0.15) : hl*0.3*wh*max(0.0, 1.05 - Yv); }
      if (cW != 0.0) dY += (cW/100.0)*0.26*sstep(0.45, 1.05, Yv);
      if (cB != 0.0) dY += (cB/100.0)*0.2*(1.0 - sstep(0.0, 0.5, Yv));
      if (Yv > 1e-4) {
        float kf = clamp((Yv + dY)/Yv, 0.0, 4.0);
        c *= 0.6*kf + 0.4;
        c += (Yv + dY) - luma(c);
      } else c += dY;
    }
    if (cClar != 0.0 || (cTex != 0.0 && uHasYt)) {
      float Yv = luma(c), dY = 0.0;
      if (cClar != 0.0) { float t2 = 2.0*clamp(Yv, 0.0, 1.0) - 1.0; dY += clamp(cClar/100.0, -1.0, 1.0)*1.15*(Yv - yl)*(0.3 + 0.7*(1.0 - t2*t2)); }
      if (cTex != 0.0 && uHasYt) dY += clamp(cTex/100.0, -1.0, 1.0)*1.6*(Yv - yt);
      c += dY;
      if (cClar > 0.0) { float Y2 = Yv + dY; c = Y2 + (c - Y2)*(1.0 + cClar/100.0*0.08); }
    }

    // ---- color stage (3D LUT from the CPU engine)
    c = clamp(c, 0.0, 1.0);
    if (uUseLut) c = uLutTetra ? lutTetra(c) : texture(uLut, c * ((uLutN - 1.0)/uLutN) + 0.5/uLutN).rgb;
    if (cSat != 0.0) { float Yv = luma(c); c = Yv + (c - Yv) * max(0.0, 1.0 + cSat/100.0); }
    if (uCubeLook) { vec3 cc = clamp(c, 0.0, 1.0); c = mix(c, texture(uCube, cc * ((uCubeN - 1.0)/uCubeN) + 0.5/uCubeN).rgb, uCubeAmt); }

    // ---- post-crop vignette
    if (uVigA != 0.0) {
      vec2 dxy = (o / uOut) * 2.0 - 1.0;
      float dEll = length(dxy);
      float minD = min(uOut.x, uOut.y);
      float dCir = length(dxy * uOut / minD) * 0.82;
      float v = sstep(uVigInner, uVigOuter, dEll + (dCir - dEll)*uVigRound);
      if (v > 0.0) {
        if (uVigA < 0.0) {
          float f = 1.0 + uVigA*v;
          if (uVigHl > 0.0) f += (1.0 - f)*uVigHl*sstep(0.55, 1.0, luma(c));
          c *= f;
        } else c += (1.0 - c)*uVigA*v;
      }
    }
    // ---- grain (same hash as the CPU engine; seed changes per frame)
    if (uGrainA > 0.0) {
      vec2 g = o / uRs / uGrainCell;
      float n = vnoise(g, int(uSeed)) - 0.5;
      if (uGrainRough > 0.0) n = n*(1.0 - uGrainRough*0.5) + (vnoise(g*2.3 + vec2(17.0, 31.0), int(uSeed) + 7) - 0.5)*uGrainRough*0.7;
      float Yv = clamp(luma(c), 0.0, 1.0);
      c += n * uGrainA*0.28*(0.35 + 2.6*Yv*(1.0 - Yv));
    }
    // ---- sharpening (unsharp mask on luma)
    if (uSharpAmt > 0.0) {
      float d = clamp(Y - Yb, -uSharpLim, uSharpLim);
      float mk = 1.0;
      if (uSharpMask > 0.0) mk = sstep(uSharpMask*0.012, uSharpMask*0.05 + 0.002, abs(Y - yt));
      c += d * uSharpAmt * mk;
    }
    c = clamp(c, 0.0, 1.0);
    if (uClipHi && (c.r >= 0.999 || c.g >= 0.999 || c.b >= 0.999)) c = vec3(1.0, 0.157, 0.157);
    else if (uClipLo && c.r <= 0.001 && c.g <= 0.001 && c.b <= 0.001) c = vec3(0.157, 0.353, 1.0);
    if (uOverlayMask >= 0 && uOverlayMask < ${MAX_MASKS}) {
      float a = mw[uOverlayMask] * 0.55;
      c = mix(c, vec3(0.9, 0.118, 0.235), a);
    }
    // an sRGB picture on a Display P3 canvas: the same colours, written in P3 numbers
    if (uToP3) c = toSrgb(mat3(0.8224621, 0.0331941, 0.0170827, 0.1775380, 0.9668058, 0.0723974, 0.0, 0.0, 0.9105199) * toLin(c));
    frag = vec4(c, 1.0);
  }`;

  /* ---------------- half floats ---------------- */
  const f32 = new Float32Array(1), u32v = new Uint32Array(f32.buffer);
  function toHalf(v) {
    f32[0] = v;
    const x = u32v[0];
    const sign = (x >> 16) & 0x8000;
    let e = ((x >> 23) & 0xff) - 112, m = x & 0x7fffff;
    if (e <= 0) { if (e < -10) return sign; m = (m | 0x800000) >> (1 - e); return sign | ((m + 0x1000) >> 13); }
    if (e >= 31) return sign | 0x7c00;
    // added, not or-ed: a mantissa that rounds up to the next power of two has to carry into the exponent
    // (or-ed, a value just under 0.5 or 0.125 came out as half of itself)
    return sign + (e << 10) + ((m + 0x1000) >> 13);
  }
  function halfArray(a) { const o = new Uint16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = toHalf(a[i]); return o; }

  /* ---------------- renderer ---------------- */
  class Renderer {
    /** opts.p3: the canvas holds Display P3 values for good (photo previews); otherwise sRGB (video). */
    constructor(opts) {
      this.canvas = document.createElement('canvas');
      const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 is not available — video grading needs a GPU-accelerated browser engine');
      this.gl = gl;
      // Set once, before anything is drawn. Switching a canvas between sRGB and P3 as photos change does
      // not take hold reliably (a frame can come out with the previous meaning), so a P3 canvas stays P3:
      // a wide-colour photo is drawn as it is, anything else is converted to P3 at the end of pass 2.
      this.p3 = !!(opts && opts.p3) && 'drawingBufferColorSpace' in gl;
      if (this.p3) gl.drawingBufferColorSpace = 'display-p3';
      this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('OES_texture_float_linear');
      this.p1 = this.program(PASS1); this.p2 = this.program(PASS2);
      this.pr = this.program(REDUCE); this.pb = this.program(BLUR); this.pw = this.program(WAVE); this.pc = this.program(CHROMA); this.pp = this.program(POST); this.px = this.program(BOX);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.srcTex = this.tex2d();
      this.lutTex = gl.createTexture();
      this.inLutTex = this.tex2d(); this.inLutProfile = null;
      this.cubeTex = gl.createTexture(); this.cubeId = null; this.dummy3d = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.dummy3d); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      this.siLutTex = this.tex2d(); this.decLutTex = this.tex2d(); this.siLut = null; this.decOk = false;
      this.brushTex = [0, 1, 2, 3].map(() => this.tex2d());
      this.dummy = this.tex2d(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
      this.fbos = {};
      this.lutSig = ''; this.brushSig = [];
      this.srcW = 1; this.srcH = 1;
    }
    program(fs) {
      const gl = this.gl;
      const mk = (type, src) => {
        const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
        return sh;
      };
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
      const locs = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); const name = u.name.replace(/\[0\]$/, ''); locs[name] = gl.getUniformLocation(p, u.name); }
      return { p, locs };
    }
    tex2d() {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    /** A texture to draw into, kept by name and remade when the size changes. channels 1 or 2: a half-float texture of that many (needs floatOk). */
    fbo(name, w, h, float, mip, channels) {
      const gl = this.gl;
      let f = this.fbos[name];
      if (f && f.w === w && f.h === h) return f;
      if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
      const tex = this.tex2d();
      const useF = float && this.floatOk;
      if (channels === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, null);
      else if (channels === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, w, h, 0, gl.RG, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, useF ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, useF ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      if (mip) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      f = this.fbos[name] = { tex, fb, w, h };
      return f;
    }
    /** Give back the memory of everything drawn into and of the source picture (a full-size photo holds a great deal). */
    release() {
      const gl = this.gl;
      for (const k of Object.keys(this.fbos)) { gl.deleteTexture(this.fbos[k].tex); gl.deleteFramebuffer(this.fbos[k].fb); }
      this.fbos = {};
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      this.srcW = 1; this.srcH = 1;
    }

    /** Give back named textures at once (the exact render of a large photo frees each as soon as it is done with it). */
    dropFbo(...names) {
      const gl = this.gl;
      for (const k of names) { const o = this.fbos[k]; if (o) { gl.deleteTexture(o.tex); gl.deleteFramebuffer(o.fb); delete this.fbos[k]; } }
    }
    /**
     * Colour noise reduction as stageNoise() in pipeline.js: the colour differences of stage 1's picture (after
     * luminance noise reduction, when nr is given) are blurred and mixed in. Returns the texture stage 2 starts from.
     */
    chromaNR(pre, nr, w, h, amt, rs) {
      const gl = this.gl, L = this.pc.locs, sig = Math.max(0.8, 4 * rs * (0.4 + amt));
      gl.activeTexture(gl.TEXTURE15);
      const T = this.fbo('cT', w, h, true, false, 2), C = this.fbo('preC', w, h, true);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(this.pc.p); gl.viewport(0, 0, w, h);
      gl.uniform1i(L.uPre, 0); gl.uniform1i(L.uNr, 1); gl.uniform1i(L.uT, 2);
      gl.uniform1i(L.uHasNr, nr ? 1 : 0); gl.uniform1f(L.uSigma, sig); gl.uniform1f(L.uAmt, amt);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pre.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, nr || this.dummy);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.dummy);
      gl.uniform1i(L.uMode, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb); this.draw();
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, T.tex);
      gl.uniform1i(L.uMode, 1); gl.bindFramebuffer(gl.FRAMEBUFFER, C.fb); this.draw();
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.dummy);
      return C.tex;
    }
    /**
     * The brightness of a picture, blurred into the named one-channel texture — by the same three boxes as
     * blurPlane() in pipeline.js makes of this sigma, so that sharpening comes out as it does on the CPU.
     */
    blurLuma(tex, w, h, sigma, name) {
      const gl = this.gl, L = this.px.locs, radii = [];
      if (sigma >= 0.35 && w >= 3 && h >= 3) {
        const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
        let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
        const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
        for (let i = 0; i < n; i++) { const r = Math.min(64, ((i < m ? wl : wl + 2) - 1) >> 1, Math.floor((Math.min(w, h) - 1) / 2)); if (r >= 1) radii.push(r); }
      }
      gl.activeTexture(gl.TEXTURE15);
      const A = this.fbo('sa', w, h, true, false, 1), B = this.fbo(name, w, h, true, false, 1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(this.px.p); gl.viewport(0, 0, w, h); gl.uniform1i(L.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      // along x then along y for each box; the last draw lands in the named texture
      const steps = []; for (const r of radii) steps.push([r, 1, 0], [r, 0, 1]);
      if (!steps.length) steps.push([0, 1, 0]);
      let src = tex, dst = steps.length % 2 ? B : A;
      steps.forEach(([r, dx, dy], i) => {
        gl.uniform1i(L.uLuma, i === 0 ? 1 : 0); gl.uniform1i(L.uR, r); gl.uniform2i(L.uDir, dx, dy);
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.bindTexture(gl.TEXTURE_2D, src); this.draw();
        src = dst.tex; dst = dst === A ? B : A;
      });
      return B.tex;
    }

    /**
     * Luminance noise reduction on stage 1's picture (brightness in its alpha): the same layers, smoothing
     * and thresholds as waveletDenoise() in pipeline.js. Returns the texture holding r = the smooth picture
     * that is left, g = the detail kept; their sum is the denoised brightness.
     */
    wavelet(pre, w, h, amount, detail, rs) {
      const gl = this.gl, L = this.pw.locs;
      const levels = Math.max(1, Math.min(4, Math.round(2 + Math.log2(Math.max(0.125, rs) * 4))));
      const strength = [1, 0.35, 0.14, 0.06], base = 0.085 * amount * Math.min(1, 0.45 + 0.55 * rs);
      gl.activeTexture(gl.TEXTURE15);          // a unit no program reads: new textures stay bound where they are made
      const T = this.fbo('nrT', w, h, true, false, 1), A = this.fbo('nrA', w, h, true, false, 2), B = this.fbo('nrB', w, h, true, false, 2);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(this.pw.p); gl.viewport(0, 0, w, h);
      gl.uniform1i(L.uA, 0); gl.uniform1i(L.uT, 1);
      let src = pre.tex, dst = A;
      for (let j = 0; j < levels; j++) {
        const t = base * strength[j] * (j === 0 ? 1.5 - detail : 1);
        gl.uniform1i(L.uFirst, j === 0 ? 1 : 0); gl.uniform1i(L.uGap, 1 << j); gl.uniform1f(L.uT2, t * t);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.dummy);
        gl.uniform1i(L.uMode, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb); this.draw();
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.tex);
        gl.uniform1i(L.uMode, 1); gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); this.draw();
        src = dst.tex; dst = dst === A ? B : A;
      }
      return src;
    }

    /** Upload a frame: VideoFrame | HTMLVideoElement | ImageBitmap | canvas | ImageData. */
    setSource(src) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      {
        const w = src.displayWidth || src.videoWidth || src.width, h = src.displayHeight || src.videoHeight || src.height;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
        // mipmaps keep downscaled previews/exports from aliasing
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        this.srcW = w; this.srcH = h;
      }
    }

    /** Upload plain RGBA pixels (photo proxies); copied when they live in shared memory. */
    setPixels(data, w, h) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const shared = typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer;
      const view = shared ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, w * h * 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, view);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.srcW = w; this.srcH = h;
    }

    updateLut(s, n) {
      n = n || LUT_N;
      const sig = n + JSON.stringify([s.curve, s.vibrance, s.saturation, s.hsl, s.bw, s.bwMix, s.grading, s.calib.shadowTint]);
      if (sig === this.lutSig) return;
      this.lutSig = sig;
      const gl = this.gl;
      const data = halfArray(P.colorLUT(s, n));
      gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.HALF_FLOAT, data);
    }

    /** The settings' imported .cube (opts.cube, or the app's cache), uploaded once per LUT. */
    bindCube(prog, s, opts, unit, stage) {
      const gl = this.gl, L = prog.locs;
      let cube = null;
      if (s.lut && s.lut.id && s.lut.amount > 0 && (s.lut.stage === 'input') === (stage === 'input')) {
        cube = opts.cube && opts.cube.id === s.lut.id ? opts.cube : (global.PJ.LUTs ? global.PJ.LUTs.getSync(s.lut.id) : null);
        if (!cube && global.PJ.LUTs) global.PJ.LUTs.get(s.lut.id);
      }
      gl.activeTexture(gl.TEXTURE0 + unit);
      if (cube && this.cubeId !== cube.id) {
        gl.bindTexture(gl.TEXTURE_3D, this.cubeTex);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, cube.n, cube.n, cube.n, 0, gl.RGBA, gl.HALF_FLOAT, halfArray(cube.data));
        this.cubeId = cube.id;
      }
      gl.bindTexture(gl.TEXTURE_3D, cube ? this.cubeTex : this.dummy3d);
      gl.uniform1i(L.uCube, unit);
      gl.uniform1i(stage === 'input' ? L.uCubeIn : L.uCubeLook, cube ? 1 : 0);
      gl.uniform1f(L.uCubeAmt, cube ? s.lut.amount / 100 : 0);
      gl.uniform1f(L.uCubeN, cube ? cube.n : 2);
    }

    isLutIdentity(s) {
      const d = P.defaultSettings();
      return JSON.stringify([s.curve, s.vibrance, s.saturation, s.hsl, s.bw, s.bwMix, s.grading, s.calib.shadowTint]) ===
        JSON.stringify([d.curve, d.vibrance, d.saturation, d.hsl, d.bw, d.bwMix, d.grading, d.calib.shadowTint]);
    }

    setGeometryUniforms(prog, g, outW, outH, tw, th) {
      const gl = this.gl, L = prog.locs, q = g.params;
      gl.uniform2f(L.uOut, outW, outH);
      gl.uniform2f(L.uTarget, tw, th); gl.uniform2f(L.uOrg, 0, 0);
      gl.uniform2f(L.uSrcSize, this.srcW, this.srcH);
      gl.uniform2f(L.uX0Y0, q.x0, q.y0);
      gl.uniform1f(L.uCa, q.ca); gl.uniform1f(L.uSa, q.sa); gl.uniform1f(L.uSc, q.sc); gl.uniform1f(L.uAsp, q.asp);
      gl.uniform1f(L.uHalf, q.half); gl.uniform1f(L.uKv, q.kv); gl.uniform1f(L.uKh, q.kh);
      gl.uniform1f(L.uHalfDiag2, q.halfDiag2); gl.uniform1f(L.uKd, q.kd);
      gl.uniform1f(L.uFish, q.fishF || 0);
      gl.uniform1f(L.uPolyR, q.polyR || 0); gl.uniform4f(L.uPoly, q.p1 || 0, q.p2 || 0, q.p3 || 0, q.p4 || 0);
      gl.uniform2f(L.uOffP, q.offX, q.offY); gl.uniform2f(L.uWoHo, g.Wo, g.Ho);
      gl.uniform1i(L.uOrient, q.orient); gl.uniform1i(L.uFlipH, q.flipH ? 1 : 0); gl.uniform1i(L.uFlipV, q.flipV ? 1 : 0);
      gl.uniform1i(L.uNonlin, g.nonlinear ? 1 : 0);
      gl.uniform1f(L.uL, Math.max(this.srcW, this.srcH));
    }

    setMaskUniforms(prog, masks, brushSlots) {
      const gl = this.gl, L = prog.locs;
      const n = Math.min(MAX_MASKS, masks.length);
      gl.uniform1i(L.uMaskCount, n);
      const types = new Int32Array(MAX_MASKS), A = new Float32Array(MAX_MASKS * 4), B = new Float32Array(MAX_MASKS * 4), C = new Float32Array(MAX_MASKS * 4), D = new Float32Array(MAX_MASKS * 4);
      const aA = new Float32Array(MAX_MASKS * 4), aB = new Float32Array(MAX_MASKS * 4), aC = new Float32Array(MAX_MASKS * 4);
      for (let i = 0; i < n; i++) {
        const m = masks[i], adj = Object.assign(P.defaultLocalAdj(), m.adj || {});
        if (m.type === 'linear') { types[i] = 0; A.set([m.x0, m.y0, m.x1, m.y1], i * 4); }
        else if (m.type === 'radial') { types[i] = 1; A.set([m.cx, m.cy, m.rx, m.ry], i * 4); B[i * 4] = (m.angle || 0) * Math.PI / 180; B[i * 4 + 1] = (m.feather ?? 50) / 100; }
        else { types[i] = 2; B[i * 4 + 2] = brushSlots[i] ?? 0; }
        B[i * 4 + 3] = m.invert ? 1 : 0;
        C.set([(m.lumMin ?? 0) / 100, (m.lumMax ?? 100) / 100, (m.lumSmooth ?? 20) / 100, (m.amount ?? 100) / 100], i * 4);
        const li = m.limit ? masks.findIndex((o, k) => k < n && o.id === m.limit.id && o !== m) : -1;
        D.set([((m.colHue ?? 0) % 360) / 360, Math.max(0.005, Math.min(0.5, (m.colRange ?? 30) / 360)), m.colOn ? 1 : 0, li < 0 ? 0 : m.limit.mode === 'subtract' ? -(li + 1) : li + 1], i * 4);
        aA.set([adj.temp, adj.tint, adj.exposure, adj.contrast], i * 4);
        aB.set([adj.highlights, adj.shadows, adj.whites, adj.blacks], i * 4);
        aC.set([adj.texture, adj.clarity, adj.dehaze, adj.saturation], i * 4);
      }
      gl.uniform1iv(L.uMType, types);
      gl.uniform4fv(L.uMA, A); gl.uniform4fv(L.uMB, B); gl.uniform4fv(L.uMC, C); if (L.uMD) gl.uniform4fv(L.uMD, D);
      gl.uniform4fv(L.uAdjA, aA); gl.uniform4fv(L.uAdjB, aB); gl.uniform4fv(L.uAdjC, aC);
      // brush textures on units 8..11
      const grids = new Float32Array(MAX_BRUSH * 2).fill(1);
      for (let k = 0; k < MAX_BRUSH; k++) {
        gl.activeTexture(gl.TEXTURE8 + k);
        const info = this.brushInfo && this.brushInfo[k];
        gl.bindTexture(gl.TEXTURE_2D, info ? this.brushTex[k] : this.dummy);
        if (info) { grids[k * 2] = info.gw; grids[k * 2 + 1] = info.gh; }
        gl.uniform1i(L['uBrush' + k], 8 + k);
      }
      gl.uniform2fv(L.uBrushGrid, grids);
    }

    uploadBrushes(masks) {
      const gl = this.gl;
      const slots = [];
      this.brushInfo = [];
      let k = 0;
      masks.forEach((m, i) => {
        if (m.type !== 'brush' || k >= MAX_BRUSH) return;
        const r = P.brushRaster(m, this.srcW, this.srcH);
        const sig = `${m.id}:${(m.dabs || []).length}:${r.gw}x${r.gh}:${m.map && P.hasMaskMap(m.map.id) ? m.map.id : ''}`;
        if (this.brushSig[k] !== sig) {
          gl.bindTexture(gl.TEXTURE_2D, this.brushTex[k]);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, r.gw, r.gh, 0, gl.RED, gl.HALF_FLOAT, halfArray(r.grid));
          this.brushSig[k] = sig;
        }
        this.brushInfo[k] = { gw: r.gw, gh: r.gh };
        slots[i] = k++;
      });
      return slots;
    }

    draw() { this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4); }

    /**
     * Render the current source with settings.
     * opts: { levelScale, fullLong, cropOverride, before, clipping, overlayMask, seed, frameIndex, target: "canvas"|"pixels", maxW,
     *         window: { x, y, w, h } — only that part of the output (in output pixels) is drawn in the last pass,
     *         exact: true — colour noise reduction and sharpening done as the CPU engine does them (for a render that is kept) }
     * Returns { width, height, fullWidth, fullHeight } — result is in this.canvas (or pixels when requested).
     */
    render(settings, opts) {
      const gl = this.gl;
      let s = P.normalizeSettings(settings);
      if (opts.before) s = P.beforeSettings(s);
      // Geometry at a virtual source size scaled to the requested output size
      const scale = opts.levelScale || 1;
      const W = Math.max(1, Math.round(this.srcW * scale)), H = Math.max(1, Math.round(this.srcH * scale));
      const g = P.buildGeometry(s, W, H, opts.cropOverride);
      const outW = g.outW, outH = g.outH;
      // geometry is evaluated in level space; the texture is sampled in normalized coords
      const realW = this.srcW, realH = this.srcH;
      this.srcW = W; this.srcH = H;
      const masks = (s.masks || []).filter(m => m.visible !== false);
      // a hidden mask can still shape a visible one it is combined with: it comes along, adjusting nothing
      for (const m of masks.slice()) {
        const o = m.limit && (s.masks || []).find(x => x.id === m.limit.id);
        if (o && !masks.includes(o) && !masks.some(x => x.id === o.id)) masks.push(Object.assign({}, o, { adj: {} }));
      }
      const brushSlots = this.uploadBrushes(masks);
      const L = Math.max(W, H);
      const rs = Math.min(1, L / (opts.fullLong || L));

      // ---------- pass 1 ----------
      const f1 = this.fbo('p1', outW, outH, true, true);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f1.fb);
      gl.viewport(0, 0, outW, outH);
      let pr = this.p1; gl.useProgram(pr.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.srcTex); gl.uniform1i(pr.locs.uSrc, 0);
      this.setGeometryUniforms(pr, g, outW, outH, outW, outH);
      this.setMaskUniforms(pr, masks, brushSlots);
      const inp = s.input || {}, prof = P.INPUT_PROFILES[inp.profile];
      const useLog = !!(prof && prof.decode);
      gl.uniform1i(pr.locs.uLog, useLog ? 1 : 0);
      if (useLog) {
        if (this.inLutProfile !== inp.profile) {
          gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.inLutTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 256, 1, 0, gl.RED, gl.HALF_FLOAT, halfArray(P.inputLUT(inp.profile)));
          this.inLutProfile = inp.profile;
        }
        const G = prof.gamut || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        gl.uniformMatrix3fv(pr.locs.uInMat, false, [G[0][0], G[1][0], G[2][0], G[0][1], G[1][1], G[2][1], G[0][2], G[1][2], G[2][2]]);
        gl.uniform1f(pr.locs.uKnee, P.inputKnee(inp.rolloff));
      }
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, useLog ? this.inLutTex : this.dummy); gl.uniform1i(pr.locs.uInLut, 5);
      this.bindCube(pr, s, opts, 12, 'input');
      const si = !useLog && opts.srcInput && opts.srcInput.lut ? opts.srcInput : null;
      const plainP3 = !useLog && !si && opts.srcInput && opts.srcInput.space === 'p3';      // a Display P3 picture (phone JPEG, HEIC)
      this.wideNow = !!(((si && si.space === 'p3') || plainP3) && opts.wide);       // this frame's numbers are Display P3 already
      gl.uniform1i(pr.locs.uSrcP3, plainP3 && !opts.wide ? 1 : 0);
      { const q = P.P3_TO_SRGB; gl.uniformMatrix3fv(pr.locs.uSiPre, false, [q[0], q[3], q[6], q[1], q[4], q[7], q[2], q[5], q[8]]); }
      gl.uniform1i(pr.locs.uSI, si ? 1 : 0);
      if (si) {
        const up = (tex, arr) => {
          gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, Float32Array.from(arr));
          // R32F is not filterable everywhere; the shader interpolates texelFetch itself
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        };
        gl.activeTexture(gl.TEXTURE6);
        if (this.siLut !== si.lut) { up(this.siLutTex, si.lut); this.siLut = si.lut; }
        gl.bindTexture(gl.TEXTURE_2D, this.siLutTex); gl.uniform1i(pr.locs.uSiLut, 6);
        gl.activeTexture(gl.TEXTURE7);
        if (!this.decOk) { up(this.decLutTex, P.inputLUT('rawlog')); this.decOk = true; }
        gl.bindTexture(gl.TEXTURE_2D, this.decLutTex); gl.uniform1i(pr.locs.uDecLut, 7);
        // wide colour: the camera's matrix moves into P3; otherwise the P3 source is brought to sRGB first (as pipeline.js does)
        const p3 = si.space === 'p3', wide = p3 && !!opts.wide;
        const m = si.matrix ? (wide ? P.mul3(P.SRGB_TO_P3, P.mul3(si.matrix, P.P3_TO_SRGB)) : si.matrix) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
        gl.uniformMatrix3fv(pr.locs.uSiMat, false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
        const q = P.P3_TO_SRGB;
        gl.uniform1i(pr.locs.uSiPreOn, p3 && !wide ? 1 : 0);
        gl.uniformMatrix3fv(pr.locs.uSiPre, false, [q[0], q[3], q[6], q[1], q[4], q[7], q[2], q[5], q[8]]);
      } else {
        gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, this.dummy); gl.uniform1i(pr.locs.uSiLut, 6);
        gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, this.dummy); gl.uniform1i(pr.locs.uDecLut, 7);
      }
      const [gr, gg, gb] = P.wbGains(s.temp, s.tint), em = Math.pow(2, s.exposure || 0);
      gl.uniform3f(pr.locs.uGain, gr * em, gg * em, gb * em);
      const M = P.calibMatrix(s.calib);
      gl.uniform1i(pr.locs.uHasCalib, M ? 1 : 0);
      // GLSL mat3 is column-major: column j = input channel j
      if (M) gl.uniformMatrix3fv(pr.locs.uCalib, false, [M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]);
      gl.uniform1f(pr.locs.uLensVig, (s.lens.vignette || 0) / 100);
      gl.uniform1f(pr.locs.uLensMid, 0.2 + (s.lens.vigMid / 100) * 0.6);
      gl.uniform1f(pr.locs.uTcaR, s.lens.tr > 0 ? s.lens.tr * 0.5 * Math.hypot(this.srcW, this.srcH) : 0);
      gl.uniform2f(pr.locs.uTcaV, +s.lens.tvr || 1, +s.lens.tvb || 1); gl.uniform2f(pr.locs.uTcaC, +s.lens.tcr || 0, +s.lens.tcb || 0); gl.uniform2f(pr.locs.uTcaB, +s.lens.tbr || 0, +s.lens.tbb || 0);
      const pv = s.lens.vq > 0 && (s.lens.v1 || s.lens.v2 || s.lens.v3);
      gl.uniform4f(pr.locs.uProfVig, pv ? s.lens.vq : 0, +s.lens.v1 || 0, +s.lens.v2 || 0, +s.lens.v3 || 0);
      const localKeys = (k) => masks.some(m => m.adj && m.adj[k]);
      gl.uniform1i(pr.locs.uLocalLin, (localKeys('exposure') || localKeys('temp') || localKeys('tint')) ? 1 : 0);
      // luminance noise reduction belongs before white balance and exposure (as in pipeline.js): the pass
      // stops after the input transfer, the wavelet passes run on that, and the pass is finished from there
      const wave = s.detail.nrLuma > 0 && this.floatOk;
      const exact = !!opts.exact && this.floatOk && !opts.window && !opts.maxW;
      const chroma = exact && s.detail.nrColor > 0, split = wave || chroma;
      // (made before the texture units below are set: making a texture leaves it bound to the unit in use,
      // and a texture that is both drawn into and bound to one of the program's samplers is an error)
      gl.activeTexture(gl.TEXTURE15);          // a unit no program reads
      const pre = split ? this.fbo('pre', outW, outH, true) : null;
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, this.dummy); gl.uniform1i(pr.locs.uPre, 13);
      gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, this.dummy); gl.uniform1i(pr.locs.uNr, 14);
      if (split) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, pre.fb); gl.uniform1i(pr.locs.uStage, 1); this.draw();
        const nr = wave ? this.wavelet(pre, outW, outH, s.detail.nrLuma / 100, s.detail.nrDetail / 100, rs) : null;
        // the exact render also does colour noise reduction here; its result already holds the luminance step
        const from = chroma ? this.chromaNR(pre, nr, outW, outH, s.detail.nrColor / 100, rs) : pre.tex;
        gl.useProgram(pr.p); gl.bindFramebuffer(gl.FRAMEBUFFER, f1.fb); gl.viewport(0, 0, outW, outH);
        gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, from);
        gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, chroma || !nr ? this.dummy : nr);
        gl.uniform1i(pr.locs.uStage, 2); this.draw();
        gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, this.dummy); gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, this.dummy);
        if (exact) this.dropFbo('pre', 'nrT', 'nrA', 'nrB', 'cT', 'preC');
      } else { gl.uniform1i(pr.locs.uStage, 0); this.draw(); }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, f1.tex);
      gl.generateMipmap(gl.TEXTURE_2D);

      // ---------- blurs ----------
      const tone = s.clarity || s.texture || s.dehaze || s.highlights || s.shadows || localKeys('clarity') || localKeys('texture') || localKeys('dehaze') || localKeys('highlights') || localKeys('shadows');
      const needYt = s.texture || localKeys('texture') || s.detail.masking > 0;
      const needDC = s.dehaze || localKeys('dehaze');
      // sigmaPx is the CPU engine's blur radius in output pixels; scaled to the blur level
      const blurred = (name, longEdge, sigmaPx) => {
        const k = Math.min(1, longEdge / Math.max(outW, outH));
        const w = Math.max(1, Math.round(outW * k)), h = Math.max(1, Math.round(outH * k));
        const lod = Math.max(0, Math.log2(1 / k) - 0.5);
        const a = this.fbo(name + 'a', w, h, true), b = this.fbo(name + 'b', w, h, true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb); gl.viewport(0, 0, w, h);
        gl.useProgram(this.pr.p);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, f1.tex);
        gl.uniform1i(this.pr.locs.uTex, 0); gl.uniform1f(this.pr.locs.uLod, lod); gl.uniform2f(this.pr.locs.uTarget, w, h);
        this.draw();
        const sigma = Math.min(16, Math.max(0.35, sigmaPx * k));
        gl.useProgram(this.pb.p);
        gl.uniform1f(this.pb.locs.uSigma, sigma); gl.uniform2f(this.pb.locs.uTarget, w, h); gl.uniform1i(this.pb.locs.uTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb); gl.bindTexture(gl.TEXTURE_2D, a.tex); gl.uniform2f(this.pb.locs.uDir, 1, 0); this.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb); gl.bindTexture(gl.TEXTURE_2D, b.tex); gl.uniform2f(this.pb.locs.uDir, 0, 1); this.draw();
        return a.tex;
      };
      const yl = tone ? blurred('yl', 256, Math.max(2, 0.016 * L)) : null;
      const yt = needYt ? blurred('yt', 1024, Math.max(0.8, 0.0022 * L)) : null;
      const dc = needDC ? blurred('dc', 128, Math.max(3, 0.03 * L)) : null;

      // ---------- pass 2 ----------
      const toPixels = opts.target === 'pixels';
      let tw = opts.maxW ? Math.min(outW, opts.maxW) : outW;
      let th = Math.max(1, Math.round(outH * tw / outW));
      // a window: the framebuffer is only as large as the window, and every position is taken within the whole picture
      let win = null;
      if (opts.window && !opts.maxW) {
        const x = Math.max(0, Math.min(outW - 1, Math.round(opts.window.x))), y = Math.max(0, Math.min(outH - 1, Math.round(opts.window.y)));
        win = { x, y, w: Math.max(1, Math.min(outW - x, Math.round(opts.window.w))), h: Math.max(1, Math.min(outH - y, Math.round(opts.window.h))) };
      }
      const fullW = tw, fullH = th;
      if (win) { tw = win.w; th = win.h; }
      let f2 = null;
      const post = exact && s.detail.sharpen > 0;          // the exact render sharpens the finished picture in a pass of its own
      if (post) { gl.activeTexture(gl.TEXTURE15); f2 = this.fbo('p2', tw, th, true); gl.bindTexture(gl.TEXTURE_2D, null); gl.bindFramebuffer(gl.FRAMEBUFFER, f2.fb); }
      else if (toPixels) { f2 = this.fbo('out', tw, th, false); gl.bindFramebuffer(gl.FRAMEBUFFER, f2.fb); }
      else { if (this.canvas.width !== tw || this.canvas.height !== th) { this.canvas.width = tw; this.canvas.height = th; } gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
      gl.viewport(0, 0, tw, th);
      pr = this.p2; gl.useProgram(pr.p);
      this.setGeometryUniforms(pr, g, outW, outH, fullW, fullH);
      if (win) gl.uniform2f(pr.locs.uOrg, win.x, fullH - win.y - win.h);      // GL counts rows from the bottom
      this.setMaskUniforms(pr, masks, brushSlots);
      const bind = (unit, tex, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex || this.dummy); gl.uniform1i(pr.locs[name], unit); };
      bind(0, f1.tex, 'uP1'); bind(1, yl, 'uYl'); bind(2, yt, 'uYt'); bind(3, dc, 'uDC');
      gl.uniform1i(pr.locs.uMaskColor, P.masksNeedColor(masks) ? 1 : 0);
      gl.uniform1i(pr.locs.uToP3, this.p3 && !toPixels && !this.wideNow ? 1 : 0);
      gl.uniform3f(pr.locs.uUngain, Math.max(1e-4, gr * em), Math.max(1e-4, gg * em), Math.max(1e-4, gb * em));
      gl.uniform2f(pr.locs.uP1Size, outW, outH);
      gl.uniform1i(pr.locs.uHasYl, yl ? 1 : 0); gl.uniform1i(pr.locs.uHasYt, yt ? 1 : 0); gl.uniform1i(pr.locs.uHasDC, dc ? 1 : 0);
      const useLut = !this.isLutIdentity(s);
      const lutN = exact ? 65 : LUT_N;          // the exact render: the table size of the CPU's full-quality renders
      if (useLut) this.updateLut(s, lutN);
      gl.uniform1f(pr.locs.uLutN, lutN); gl.uniform1i(pr.locs.uLutTetra, exact ? 1 : 0);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_3D, this.lutTex); gl.uniform1i(pr.locs.uLut, 4);
      gl.uniform1i(pr.locs.uUseLut, useLut ? 1 : 0);
      this.bindCube(pr, s, opts, 12, 'look');
      gl.uniform1f(pr.locs.uContrast, s.contrast); gl.uniform1f(pr.locs.uHigh, s.highlights); gl.uniform1f(pr.locs.uShad, s.shadows);
      gl.uniform1f(pr.locs.uWhite, s.whites); gl.uniform1f(pr.locs.uBlack, s.blacks);
      gl.uniform1f(pr.locs.uTex, s.texture); gl.uniform1f(pr.locs.uClar, s.clarity); gl.uniform1f(pr.locs.uDeh, s.dehaze);
      gl.uniform1i(pr.locs.uLocalTone, ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'texture', 'clarity', 'dehaze'].some(localKeys) ? 1 : 0);
      gl.uniform1i(pr.locs.uLocalSat, localKeys('saturation') ? 1 : 0);
      const e = s.effects;
      gl.uniform1f(pr.locs.uVigA, e.vigAmount / 100);
      const vi = 0.12 + (e.vigMid / 100) * 0.95;
      gl.uniform1f(pr.locs.uVigInner, vi); gl.uniform1f(pr.locs.uVigOuter, vi + 0.04 + (e.vigFeather / 100) * 1.1);
      gl.uniform1f(pr.locs.uVigRound, (e.vigRound + 100) / 200); gl.uniform1f(pr.locs.uVigHl, e.vigHighlights / 100);
      gl.uniform1f(pr.locs.uGrainA, e.grain / 100); gl.uniform1f(pr.locs.uGrainCell, 0.6 + e.grainSize / 100 * 3.2);
      gl.uniform1f(pr.locs.uGrainRough, e.grainRough / 100); gl.uniform1f(pr.locs.uRs, rs);
      gl.uniform1ui(pr.locs.uSeed, ((opts.seed | 0) + (opts.frameIndex | 0) * 7919) >>> 0);
      const d = s.detail;
      gl.uniform1f(pr.locs.uSharpAmt, post ? 0 : d.sharpen / 100 * 1.4); gl.uniform1f(pr.locs.uSharpLim, 0.03 + (d.detail / 100) * 0.22);
      gl.uniform1f(pr.locs.uSharpRad, d.radius * Math.max(0.5, rs)); gl.uniform1f(pr.locs.uSharpMask, d.masking / 100);
      gl.uniform1f(pr.locs.uNrLuma, wave ? 0 : d.nrLuma / 100); gl.uniform1f(pr.locs.uNrDetail, d.nrDetail / 100); gl.uniform1f(pr.locs.uNrColor, chroma ? 0 : d.nrColor / 100);
      gl.uniform1i(pr.locs.uClipHi, opts.clipping && opts.clipping.hi ? 1 : 0);
      gl.uniform1i(pr.locs.uClipLo, opts.clipping && opts.clipping.lo ? 1 : 0);
      gl.uniform1i(pr.locs.uOverlayMask, opts.overlayMask ?? -1);
      this.draw();
      this.srcW = realW; this.srcH = realH;
      if (post) {
        if (exact) this.dropFbo('p1', 'yla', 'ylb', 'yta', 'ytb', 'dca', 'dcb');
        const yb = this.blurLuma(f2.tex, tw, th, Math.max(0.5, d.radius * Math.max(0.5, rs)), 'sb');
        const ym = d.masking > 0 ? this.blurLuma(f2.tex, tw, th, Math.max(1, 2.5 * rs), 'sc') : null;
        gl.activeTexture(gl.TEXTURE15);
        const dst = toPixels ? this.fbo('out', tw, th, false) : null;
        gl.bindTexture(gl.TEXTURE_2D, null);
        if (!toPixels && (this.canvas.width !== tw || this.canvas.height !== th)) { this.canvas.width = tw; this.canvas.height = th; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null); gl.viewport(0, 0, tw, th);
        const L = this.pp.locs; gl.useProgram(this.pp.p);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, f2.tex); gl.uniform1i(L.uImg, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, yb); gl.uniform1i(L.uYb, 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, ym || this.dummy); gl.uniform1i(L.uYm, 2);
        gl.uniform1f(L.uAmt, d.sharpen / 100 * 1.4); gl.uniform1f(L.uLim, 0.03 + (d.detail / 100) * 0.22); gl.uniform1f(L.uMask, d.masking / 100); gl.uniform1i(L.uHasYm, ym ? 1 : 0);
        this.draw();
        gl.activeTexture(gl.TEXTURE0);
      }
      const out = { width: tw, height: th, fullWidth: outW, fullHeight: outH, window: win };
      if (toPixels) {
        const px = new Uint8Array(tw * th * 4);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, px);
        // flip rows (GL is bottom-up)
        const row = tw * 4, flipped = new Uint8ClampedArray(px.length);
        for (let y = 0; y < th; y++) flipped.set(px.subarray((th - 1 - y) * row, (th - y) * row), y * row);
        out.data = flipped;
      }
      return out;
    }
  }

  let shared = null;
  function renderer() { if (!shared) shared = new Renderer(); return shared; }

  global.PJ = global.PJ || {};
  global.PJ.GL = { Renderer, renderer, toHalf, halfArray };
})(window);
