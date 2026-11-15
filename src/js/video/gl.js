/* =====================================================================
 * photos.jpeg — GPU (WebGL2) develop renderer for video.
 * A shader port of pipeline.js so grading plays back in real time:
 *   pass 1  geometry + input transfer (sRGB or camera log → Rec.709)
 *           + lens vignette + calibration + white balance + exposure
 *           + mask-local exposure/temp/tint            → RGBA16F
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
  uniform vec2 uTarget;     // size of the framebuffer being drawn
  uniform vec2 uSrcSize;    // source texture size
  // geometry
  uniform vec2 uX0Y0; uniform float uCa, uSa, uSc, uAsp, uHalf, uKv, uKh, uHalfDiag2, uKd, uPolyR; uniform vec4 uPoly;
  uniform vec2 uOffP; uniform vec2 uWoHo; uniform int uOrient; uniform bool uFlipH, uFlipV, uNonlin;
  // masks
  uniform int uMaskCount;
  uniform int uMType[${MAX_MASKS}];
  uniform vec4 uMA[${MAX_MASKS}], uMB[${MAX_MASKS}], uMC[${MAX_MASKS}];
  uniform vec4 uAdjA[${MAX_MASKS}], uAdjB[${MAX_MASKS}], uAdjC[${MAX_MASKS}];
  uniform sampler2D uBrush0, uBrush1, uBrush2, uBrush3;
  uniform vec2 uBrushGrid[${MAX_BRUSH}];
  uniform float uL;          // source long edge (px)

  vec2 outCoord(){ vec2 f = gl_FragCoord.xy / uTarget * uOut; return vec2(f.x, uOut.y - f.y); }

  vec2 toSource(vec2 o){
    vec2 d = uX0Y0 + o;
    vec2 p = vec2(uCa*d.x - uSa*d.y, uSa*d.x + uCa*d.y);
    p = p / uSc - uOffP;
    p.x /= uAsp; p.y *= uAsp;
    if (uNonlin) {
      if (uKv != 0.0 || uKh != 0.0) { vec2 n = p / uHalf; p = vec2(p.x * (1.0 + uKv*n.y), p.y * (1.0 + uKh*n.x)); }
      if (uKd != 0.0) { float f = 1.0 + uKd * dot(p,p) / uHalfDiag2; p *= f; }
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

  float maskWeight(int i, vec2 s, float y0){
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
    return w * C.w;
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
  uniform sampler2D uSiLut, uDecLut; uniform mat3 uSiMat;
  float lk(sampler2D t, float v){   // same linear interpolation as the CPU's 256-entry lookups
    float f = clamp(v, 0.0, 1.0) * 255.0; int i = min(int(f), 254);
    return mix(texelFetch(t, ivec2(i, 0), 0).r, texelFetch(t, ivec2(i + 1, 0), 0).r, f - float(i));
  }
  uniform vec3 uGain;            // WB * exposure
  uniform mat3 uCalib; uniform bool uHasCalib;
  uniform float uLensVig, uLensMid; uniform vec4 uProfVig; uniform float uTcaR; uniform vec2 uTcaV, uTcaC, uTcaB;
  uniform bool uLocalLin;
  out vec4 frag;

  void main(){
    vec2 o = outCoord();
    vec2 s = toSource(o);
    vec3 c; bool inside = !(s.x < -0.5 || s.y < -0.5 || s.x > uSrcSize.x + 0.5 || s.y > uSrcSize.y + 0.5);
    vec3 raw = inside ? texture(uSrc, s / uSrcSize).rgb : vec3(0.11);
    if (inside && uTcaR != 0.0) {
      // lens profile: red and blue are read where the lens actually put them
      vec2 cen = uSrcSize * 0.5, dd = s - cen; float tr = length(dd) / uTcaR;
      raw.r = texture(uSrc, (cen + dd * (uTcaV.x + tr * (uTcaC.x + tr * uTcaB.x))) / uSrcSize).r;
      raw.b = texture(uSrc, (cen + dd * (uTcaV.y + tr * (uTcaC.y + tr * uTcaB.y))) / uSrcSize).b;
    }
    vec3 lin;
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
      vec3 l = vec3(lk(uSiLut, cc.r), lk(uSiLut, cc.g), lk(uSiLut, cc.b));
      vec3 sd = vec3(lk(uDecLut, cc.r), lk(uDecLut, cc.g), lk(uDecLut, cc.b));
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
    } else lin = toLin(raw);
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
        float w = maskWeight(i, s, y0);
        if (w <= 0.0) continue;
        ev += uAdjA[i].z * w; lt += uAdjA[i].x * w; li += uAdjA[i].y * w;
      }
      if (ev != 0.0 || lt != 0.0 || li != 0.0) lin *= wbGains(lt, li) * exp2(ev);
    }
    frag = vec4(toSrgb(lin), y0);
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

  /* ---------------- pass 2 ---------------- */
  const PASS2 = COMMON + `
  uniform sampler2D uP1, uYl, uYt, uDC;
  uniform sampler3D uLut;
  uniform float uContrast, uHigh, uShad, uWhite, uBlack, uTex, uClar, uDeh;
  uniform bool uHasYl, uHasYt, uHasDC, uLocalTone, uLocalSat, uUseLut;
  uniform bool uCubeLook; uniform highp sampler3D uCube; uniform float uCubeAmt, uCubeN;   // imported creative .cube
  uniform float uVigA, uVigInner, uVigOuter, uVigRound, uVigHl;
  uniform float uGrainA, uGrainCell, uGrainRough, uRs; uniform uint uSeed;
  uniform float uSharpAmt, uSharpLim, uSharpRad, uSharpMask;
  uniform float uNrLuma, uNrDetail, uNrColor;
  uniform bool uClipHi, uClipLo; uniform int uOverlayMask;
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
    vec2 uv = gl_FragCoord.xy / uTarget;
    vec4 p1 = texture(uP1, uv);
    vec3 c = p1.rgb; float y0 = p1.a;
    vec2 s = toSource(o);

    // 5×5 neighbourhood of pass 1 for sharpening and noise reduction
    float Yb = 0.0, wb = 0.0; vec3 Cb = vec3(0.0);
    float Y = luma(c);
    if (uSharpAmt > 0.0 || uNrLuma > 0.0 || uNrColor > 0.0) {
      vec2 px = 1.0 / uP1Size;
      float sig = max(0.5, uSharpRad);
      // noise reduction for the live preview: an edge-aware (bilateral) mean over two rings of
      // neighbours — close to what the wavelet method of the final render does at this size
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
      float w = maskWeight(i, s, y0);
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
    if (uUseLut) c = texture(uLut, c * (${LUT_N - 1}.0/${LUT_N}.0) + 0.5/${LUT_N}.0).rgb;
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
    return sign | (e << 10) | ((m + 0x1000) >> 13);
  }
  function halfArray(a) { const o = new Uint16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = toHalf(a[i]); return o; }

  /* ---------------- renderer ---------------- */
  class Renderer {
    constructor() {
      this.canvas = document.createElement('canvas');
      const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 is not available — video grading needs a GPU-accelerated browser engine');
      this.gl = gl;
      this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('OES_texture_float_linear');
      this.p1 = this.program(PASS1); this.p2 = this.program(PASS2);
      this.pr = this.program(REDUCE); this.pb = this.program(BLUR);
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
    fbo(name, w, h, float, mip) {
      const gl = this.gl;
      let f = this.fbos[name];
      if (f && f.w === w && f.h === h) return f;
      if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
      const tex = this.tex2d();
      const useF = float && this.floatOk;
      gl.texImage2D(gl.TEXTURE_2D, 0, useF ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, useF ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      if (mip) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      f = this.fbos[name] = { tex, fb, w, h };
      return f;
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

    updateLut(s) {
      const sig = JSON.stringify([s.curve, s.vibrance, s.saturation, s.hsl, s.bw, s.bwMix, s.grading, s.calib.shadowTint]);
      if (sig === this.lutSig) return;
      this.lutSig = sig;
      const gl = this.gl;
      const data = halfArray(P.colorLUT(s, LUT_N));
      gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, LUT_N, LUT_N, LUT_N, 0, gl.RGBA, gl.HALF_FLOAT, data);
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
      gl.uniform2f(L.uTarget, tw, th);
      gl.uniform2f(L.uSrcSize, this.srcW, this.srcH);
      gl.uniform2f(L.uX0Y0, q.x0, q.y0);
      gl.uniform1f(L.uCa, q.ca); gl.uniform1f(L.uSa, q.sa); gl.uniform1f(L.uSc, q.sc); gl.uniform1f(L.uAsp, q.asp);
      gl.uniform1f(L.uHalf, q.half); gl.uniform1f(L.uKv, q.kv); gl.uniform1f(L.uKh, q.kh);
      gl.uniform1f(L.uHalfDiag2, q.halfDiag2); gl.uniform1f(L.uKd, q.kd);
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
      const types = new Int32Array(MAX_MASKS), A = new Float32Array(MAX_MASKS * 4), B = new Float32Array(MAX_MASKS * 4), C = new Float32Array(MAX_MASKS * 4);
      const aA = new Float32Array(MAX_MASKS * 4), aB = new Float32Array(MAX_MASKS * 4), aC = new Float32Array(MAX_MASKS * 4);
      for (let i = 0; i < n; i++) {
        const m = masks[i], adj = Object.assign(P.defaultLocalAdj(), m.adj || {});
        if (m.type === 'linear') { types[i] = 0; A.set([m.x0, m.y0, m.x1, m.y1], i * 4); }
        else if (m.type === 'radial') { types[i] = 1; A.set([m.cx, m.cy, m.rx, m.ry], i * 4); B[i * 4] = (m.angle || 0) * Math.PI / 180; B[i * 4 + 1] = (m.feather ?? 50) / 100; }
        else { types[i] = 2; B[i * 4 + 2] = brushSlots[i] ?? 0; }
        B[i * 4 + 3] = m.invert ? 1 : 0;
        C.set([(m.lumMin ?? 0) / 100, (m.lumMax ?? 100) / 100, (m.lumSmooth ?? 20) / 100, (m.amount ?? 100) / 100], i * 4);
        aA.set([adj.temp, adj.tint, adj.exposure, adj.contrast], i * 4);
        aB.set([adj.highlights, adj.shadows, adj.whites, adj.blacks], i * 4);
        aC.set([adj.texture, adj.clarity, adj.dehaze, adj.saturation], i * 4);
      }
      gl.uniform1iv(L.uMType, types);
      gl.uniform4fv(L.uMA, A); gl.uniform4fv(L.uMB, B); gl.uniform4fv(L.uMC, C);
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
     * opts: { levelScale, fullLong, cropOverride, before, clipping, overlayMask, seed, frameIndex, target: "canvas"|"pixels", maxW }
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
        const m = si.matrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
        gl.uniformMatrix3fv(pr.locs.uSiMat, false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
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
      this.draw();
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
      const tw = opts.maxW ? Math.min(outW, opts.maxW) : outW;
      const th = Math.max(1, Math.round(outH * tw / outW));
      let f2 = null;
      if (toPixels) { f2 = this.fbo('out', tw, th, false); gl.bindFramebuffer(gl.FRAMEBUFFER, f2.fb); }
      else { if (this.canvas.width !== tw || this.canvas.height !== th) { this.canvas.width = tw; this.canvas.height = th; } gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
      gl.viewport(0, 0, tw, th);
      pr = this.p2; gl.useProgram(pr.p);
      this.setGeometryUniforms(pr, g, outW, outH, tw, th);
      this.setMaskUniforms(pr, masks, brushSlots);
      const bind = (unit, tex, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex || this.dummy); gl.uniform1i(pr.locs[name], unit); };
      bind(0, f1.tex, 'uP1'); bind(1, yl, 'uYl'); bind(2, yt, 'uYt'); bind(3, dc, 'uDC');
      gl.uniform2f(pr.locs.uP1Size, outW, outH);
      gl.uniform1i(pr.locs.uHasYl, yl ? 1 : 0); gl.uniform1i(pr.locs.uHasYt, yt ? 1 : 0); gl.uniform1i(pr.locs.uHasDC, dc ? 1 : 0);
      const useLut = !this.isLutIdentity(s);
      if (useLut) this.updateLut(s);
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
      gl.uniform1f(pr.locs.uSharpAmt, d.sharpen / 100 * 1.4); gl.uniform1f(pr.locs.uSharpLim, 0.03 + (d.detail / 100) * 0.22);
      gl.uniform1f(pr.locs.uSharpRad, d.radius * Math.max(0.5, rs)); gl.uniform1f(pr.locs.uSharpMask, d.masking / 100);
      gl.uniform1f(pr.locs.uNrLuma, d.nrLuma / 100); gl.uniform1f(pr.locs.uNrDetail, d.nrDetail / 100); gl.uniform1f(pr.locs.uNrColor, d.nrColor / 100);
      gl.uniform1i(pr.locs.uClipHi, opts.clipping && opts.clipping.hi ? 1 : 0);
      gl.uniform1i(pr.locs.uClipLo, opts.clipping && opts.clipping.lo ? 1 : 0);
      gl.uniform1i(pr.locs.uOverlayMask, opts.overlayMask ?? -1);
      this.draw();
      this.srcW = realW; this.srcH = realH;
      const out = { width: tw, height: th, fullWidth: outW, fullHeight: outH };
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
