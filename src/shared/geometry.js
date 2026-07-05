'use strict';
// Shared slice geometry: polygon masks (key points), rotation (90° steps), flip mapping,
// multi-screen support and clip layout. Used by the renderer UI and the ffmpeg pipeline.
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

  // ---- polygon masks ----
  function maskBBox(mask) {
    if (!mask || !mask.points || mask.points.length < 3) return null;
    const xs = mask.points.map((p) => p.x);
    const ys = mask.points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  // true when the polygon is exactly its axis-aligned bounding rect (fast crop path)
  function maskIsRect(mask) {
    if (!mask || !mask.points || mask.points.length !== 4) return false;
    const b = maskBBox(mask);
    if (!b) return false;
    const corners = [
      [b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h],
    ];
    return mask.points.every((p) => corners.some(([cx, cy]) => Math.abs(p.x - cx) < 0.5 && Math.abs(p.y - cy) < 0.5));
  }

  function rectToPoints(r) {
    return [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ];
  }

  // Map a fractional sub-range of the input rect through a 90°-step rotation (clockwise).
  function rotFracRange(fx0, fx1, fy0, fy1, rot) {
    switch (((rot % 360) + 360) % 360) {
      case 90: return { x0: 1 - fy1, x1: 1 - fy0, y0: fx0, y1: fx1 };
      case 180: return { x0: 1 - fx1, x1: 1 - fx0, y0: 1 - fy1, y1: 1 - fy0 };
      case 270: return { x0: fy0, x1: fy1, y0: 1 - fx1, y1: 1 - fx0 };
      default: return { x0: fx0, x1: fx1, y0: fy0, y1: fy1 };
    }
  }

  function rotFracPoint(u, v, rot) {
    switch (((rot % 360) + 360) % 360) {
      case 90: return { u: 1 - v, v: u };
      case 180: return { u: 1 - u, v: 1 - v };
      case 270: return { u: v, v: 1 - u };
      default: return { u, v };
    }
  }

  function applyFlipFrac(r, flip) {
    let { x0, x1, y0, y1 } = r;
    if (flip & 1) { const n0 = 1 - x1, n1 = 1 - x0; x0 = n0; x1 = n1; }
    if (flip & 2) { const n0 = 1 - y1, n1 = 1 - y0; y0 = n0; y1 = n1; }
    return { x0, x1, y0, y1 };
  }

  function applyFlipPoint(p, flip) {
    return { u: flip & 1 ? 1 - p.u : p.u, v: flip & 2 ? 1 - p.v : p.v };
  }

  function netRotation(slice) {
    return ((((slice.outOrient || 0) - (slice.inOrient || 0)) % 360) + 360) % 360;
  }

  // Map an input-space point of a slice to output-canvas coordinates (through rot/flip)
  function inputPointToOutput(s, pt) {
    const rot = netRotation(s);
    let f = rotFracPoint((pt.x - s.in.x) / s.in.w, (pt.y - s.in.y) / s.in.h, rot);
    f = applyFlipPoint(f, s.flip || 0);
    return { x: s.out.x + f.u * s.out.w, y: s.out.y + f.v * s.out.h };
  }

  // Mask polygon mapped into place-rect-local coordinates (for rasterizing / clipping)
  function maskPolyInPlace(s, eff) {
    if (!s.mask || !s.mask.points) return null;
    return s.mask.points.map((pt) => {
      const o = inputPointToOutput(s, pt);
      return { x: o.x - eff.place.x, y: o.y - eff.place.y };
    });
  }

  // ---- screens ----
  function screenOf(project, screenId) {
    const screens = project.screens || [];
    return screens.find((sc) => sc.id === screenId) || screens[0] || project.output || null;
  }

  // Per slice: effective crop (input px) and place (output px) + rotation/flip + polygon info.
  // screenId (optional): only slices assigned to that screen.
  function effectiveSlices(project, screenId) {
    const IW = Math.max(1, Math.round(project.input.width));
    const IH = Math.max(1, Math.round(project.input.height));
    const canvasRect = { x: 0, y: 0, w: IW, h: IH };
    const result = [];
    for (const s of project.slices) {
      if (s.enabled === false) continue;
      if (screenId && s.screenId && s.screenId !== screenId) continue;
      if (screenId && !s.screenId && project.screens && project.screens[0] && project.screens[0].id !== screenId) continue;
      if (s.in.w <= 0 || s.in.h <= 0 || s.out.w <= 0 || s.out.h <= 0) continue;
      let eff = intersect(s.in, canvasRect);
      const hasMask = s.mask && s.mask.enabled && s.mask.points && s.mask.points.length >= 3;
      if (eff && hasMask) {
        const mb = maskBBox(s.mask);
        eff = mb ? intersect(eff, mb) : eff;
      }
      if (!eff || eff.w < 1 || eff.h < 1) continue;

      const fx0 = (eff.x - s.in.x) / s.in.w;
      const fx1 = (eff.x + eff.w - s.in.x) / s.in.w;
      const fy0 = (eff.y - s.in.y) / s.in.h;
      const fy1 = (eff.y + eff.h - s.in.y) / s.in.h;
      const rot = netRotation(s);
      const flip = s.flip || 0;
      const fr = applyFlipFrac(rotFracRange(fx0, fx1, fy0, fy1, rot), flip);

      const entry = {
        slice: s,
        rot,
        flip,
        polyMask: hasMask && !maskIsRect(s.mask), // needs raster mask in ffmpeg
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
      };
      result.push(entry);
    }
    return result;
  }

  // Clip layout on the input canvas (export page transform).
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
    const scy = (t.scaleY != null ? t.scaleY : t.scale != null ? t.scale : 100) / 100;
    bw *= sc; bh *= scy;
    const a = ((t.rotation || 0) * Math.PI) / 180;
    const rw = Math.abs(bw * Math.cos(a)) + Math.abs(bh * Math.sin(a));
    const rh = Math.abs(bw * Math.sin(a)) + Math.abs(bh * Math.cos(a));
    const cx = IW / 2 + (t.x || 0);
    const cy = IH / 2 + (t.y || 0);
    return { bw, bh, rw, rh, cx, cy, x: cx - rw / 2, y: cy - rh / 2, angleRad: a };
  }

  function defaultTransform() {
    return {
      mode: 'stretch', scale: 100, scaleY: null, x: 0, y: 0, rotation: 0,
      brightness: 0, contrast: 0, saturation: 1, hue: 0, blur: 0,
    };
  }

  function isIdentityTransform(t) {
    if (!t) return true;
    const d = defaultTransform();
    return (
      (t.mode || 'stretch') === 'stretch' &&
      (t.scale == null || t.scale === d.scale) &&
      (t.scaleY == null || t.scaleY === (t.scale != null ? t.scale : d.scale)) &&
      !t.x && !t.y && !t.rotation &&
      !t.brightness && !t.contrast &&
      (t.saturation == null || t.saturation === 1) &&
      !t.hue && !t.blur
    );
  }

  return {
    intersect,
    maskBBox,
    maskIsRect,
    rectToPoints,
    rotFracRange,
    rotFracPoint,
    applyFlipFrac,
    netRotation,
    inputPointToOutput,
    maskPolyInPlace,
    screenOf,
    effectiveSlices,
    clipLayout,
    defaultTransform,
    isIdentityTransform,
  };
});
