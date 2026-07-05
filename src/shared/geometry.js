'use strict';
// Shared slice geometry: mask intersection, rotation (90° steps) and flip mapping.
// Used by the renderer (canvas preview) and the main process (ffmpeg pipeline).
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Geometry = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function intersect(a, b) {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Map a fractional sub-range of the input rect through a 90°-step rotation.
  // rot is clockwise; point (u,v) -> 90: (1-v, u), 180: (1-u, 1-v), 270: (v, 1-u)
  function rotFracRange(fx0, fx1, fy0, fy1, rot) {
    switch (((rot % 360) + 360) % 360) {
      case 90: return { x0: 1 - fy1, x1: 1 - fy0, y0: fx0, y1: fx1 };
      case 180: return { x0: 1 - fx1, x1: 1 - fx0, y0: 1 - fy1, y1: 1 - fy0 };
      case 270: return { x0: fy0, x1: fy1, y0: 1 - fx1, y1: 1 - fx0 };
      default: return { x0: fx0, x1: fx1, y0: fy0, y1: fy1 };
    }
  }

  // flip bitmask: 1 = horizontal, 2 = vertical (applied after rotation)
  function applyFlipFrac(r, flip) {
    let { x0, x1, y0, y1 } = r;
    if (flip & 1) { const n0 = 1 - x1, n1 = 1 - x0; x0 = n0; x1 = n1; }
    if (flip & 2) { const n0 = 1 - y1, n1 = 1 - y0; y0 = n0; y1 = n1; }
    return { x0, x1, y0, y1 };
  }

  function netRotation(slice) {
    return ((((slice.outOrient || 0) - (slice.inOrient || 0)) % 360) + 360) % 360;
  }

  // Per slice: effective crop (input px, mask + canvas clamped) and place (output px),
  // plus the content rotation/flip to apply to the cropped pixels.
  function effectiveSlices(project) {
    const IW = Math.max(1, Math.round(project.input.width));
    const IH = Math.max(1, Math.round(project.input.height));
    const canvasRect = { x: 0, y: 0, w: IW, h: IH };
    const result = [];
    for (const s of project.slices) {
      if (s.enabled === false) continue;
      if (s.in.w <= 0 || s.in.h <= 0 || s.out.w <= 0 || s.out.h <= 0) continue;
      let eff = intersect(s.in, canvasRect);
      if (eff && s.mask && s.mask.enabled) eff = intersect(eff, s.mask);
      if (!eff || eff.w < 1 || eff.h < 1) continue;

      const fx0 = (eff.x - s.in.x) / s.in.w;
      const fx1 = (eff.x + eff.w - s.in.x) / s.in.w;
      const fy0 = (eff.y - s.in.y) / s.in.h;
      const fy1 = (eff.y + eff.h - s.in.y) / s.in.h;
      const rot = netRotation(s);
      const flip = s.flip || 0;
      const fr = applyFlipFrac(rotFracRange(fx0, fx1, fy0, fy1, rot), flip);

      result.push({
        slice: s,
        rot,
        flip,
        crop: {
          x: Math.round(eff.x),
          y: Math.round(eff.y),
          w: Math.max(1, Math.round(eff.w)),
          h: Math.max(1, Math.round(eff.h)),
        },
        place: {
          x: Math.round(s.out.x + fr.x0 * s.out.w),
          y: Math.round(s.out.y + fr.y0 * s.out.h),
          w: Math.max(1, Math.round((fr.x1 - fr.x0) * s.out.w)),
          h: Math.max(1, Math.round((fr.y1 - fr.y0) * s.out.h)),
        },
      });
    }
    return result;
  }

  // Clip layout on the input canvas (render page transform).
  // transform: {mode, scale, x, y, rotation} — mode: stretch|fit|fill|native
  function clipLayout(srcW, srcH, transform, IW, IH) {
    const t = transform || {};
    const mode = t.mode || 'stretch';
    let bw, bh;
    if (mode === 'fit') {
      const k = Math.min(IW / srcW, IH / srcH);
      bw = srcW * k; bh = srcH * k;
    } else if (mode === 'fill') {
      const k = Math.max(IW / srcW, IH / srcH);
      bw = srcW * k; bh = srcH * k;
    } else if (mode === 'native') {
      bw = srcW; bh = srcH;
    } else {
      bw = IW; bh = IH;
    }
    const sc = (t.scale != null ? t.scale : 100) / 100;
    bw *= sc; bh *= sc;
    const a = ((t.rotation || 0) * Math.PI) / 180;
    const rw = Math.abs(bw * Math.cos(a)) + Math.abs(bh * Math.sin(a));
    const rh = Math.abs(bw * Math.sin(a)) + Math.abs(bh * Math.cos(a));
    const cx = IW / 2 + (t.x || 0);
    const cy = IH / 2 + (t.y || 0);
    return { bw, bh, rw, rh, cx, cy, x: cx - rw / 2, y: cy - rh / 2, angleRad: a };
  }

  function defaultTransform() {
    return {
      mode: 'stretch', scale: 100, x: 0, y: 0, rotation: 0,
      brightness: 0, contrast: 0, saturation: 1, hue: 0, blur: 0,
    };
  }

  function isIdentityTransform(t) {
    if (!t) return true;
    const d = defaultTransform();
    return (
      (t.mode || 'stretch') === 'stretch' &&
      (t.scale == null || t.scale === d.scale) &&
      !t.x && !t.y && !t.rotation &&
      !t.brightness && !t.contrast &&
      (t.saturation == null || t.saturation === 1) &&
      !t.hue && !t.blur
    );
  }

  return {
    intersect,
    rotFracRange,
    applyFlipFrac,
    netRotation,
    effectiveSlices,
    clipLayout,
    defaultTransform,
    isIdentityTransform,
  };
});
