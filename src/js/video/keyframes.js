/* =====================================================================
 * photos.jpeg — keyframed video adjustments.
 * A clip's settings may carry `keyframes: [{ t, s, ease }]` — full develop settings captured at
 * time t. Between keyframes every numeric value (sliders, curve points, colour wheels, crop,
 * mask positions…) is interpolated; anything that can't be (on/off switches, profiles) holds the
 * earlier keyframe's value. With keyframes present, editing while paused updates (or adds) the
 * keyframe under the playhead, like auto-key in an NLE.
 * ===================================================================== */
(function (global) {
  'use strict';
  const P = PJ.Pipeline;

  const list = (s) => (s && Array.isArray(s.keyframes) ? s.keyframes : []);
  const count = (s) => list(s).length;
  /** Settings without the keyframe list (what a keyframe stores). */
  function strip(s) { const o = Object.assign({}, s); delete o.keyframes; return P.clone(o); }

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  function lerp(a, b, u, key) {
    if (typeof a === 'number' && typeof b === 'number') {
      if (key === 'h') { let d = ((b - a + 540) % 360) - 180; return (a + d * u + 360) % 360; } // hue wheels take the short way round
      return a + (b - a) * u;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return u < 1 ? a : b;
      return a.map((x, i) => lerp(x, b[i], u, null));
    }
    if (isObj(a) && isObj(b)) {
      if (a.id !== undefined && a.id !== b.id) return u < 1 ? a : b; // different masks: don't blend
      const o = {};
      for (const k of Object.keys(a)) o[k] = k in b ? lerp(a[k], b[k], u, k) : a[k];
      for (const k of Object.keys(b)) if (!(k in o)) o[k] = b[k];
      return o;
    }
    return u < 1 ? a : b;
  }

  /** The settings at time t (seconds). Returns `s` itself when it has no keyframes. */
  function at(s, t) {
    const ks = list(s);
    if (!ks.length) return s;
    let i = 0;
    while (i < ks.length && ks[i].t <= t + 1e-6) i++;
    let out;
    if (i === 0) out = P.normalizeSettings(ks[0].s);
    else if (i === ks.length) out = P.normalizeSettings(ks[ks.length - 1].s);
    else {
      const k0 = ks[i - 1], k1 = ks[i];
      let u = (t - k0.t) / Math.max(1e-6, k1.t - k0.t);
      if ((k0.ease || 'smooth') === 'smooth') u = u * u * (3 - 2 * u);
      out = lerp(P.normalizeSettings(k0.s), P.normalizeSettings(k1.s), u, null);
    }
    out.keyframes = ks;
    return out;
  }

  /** Index of the keyframe within half a frame of t, or -1. */
  function find(s, t, fps) {
    const tol = 0.5 / (fps || 30);
    return list(s).findIndex(k => Math.abs(k.t - t) <= tol);
  }

  /** Put the photo's current settings into a keyframe at t (replacing one already there). */
  function capture(photo, t, fps) {
    const s = photo.settings;
    const ks = list(s).slice();
    const kf = { t: Math.max(0, t), s: strip(s), ease: 'smooth' };
    const i = find(s, t, fps);
    if (i >= 0) { kf.ease = ks[i].ease || 'smooth'; kf.t = ks[i].t; ks[i] = kf; } else ks.push(kf);
    ks.sort((a, b) => a.t - b.t);
    s.keyframes = ks;
  }
  function remove(photo, i) {
    const ks = list(photo.settings).slice();
    ks.splice(i, 1);
    photo.settings.keyframes = ks;
  }
  function clear(photo) { photo.settings.keyframes = []; }
  /** Show the values under the playhead (no history step). */
  function applyAt(photo, t) {
    if (!count(photo.settings)) return false;
    const v = at(photo.settings, t);
    photo.settings = P.normalizeSettings(v);
    photo.settings.keyframes = v.keyframes;
    return true;
  }
  const times = (s) => list(s).map(k => k.t);

  global.PJ.Keyframes = { at, find, capture, remove, clear, applyAt, count, times, list };
})(window);
