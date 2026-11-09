'use strict';
// Mapping check: does the mapping put every slice where it should be, 1:1 and on screen?
// Pure logic, used by the editor's check bar, the labels and the check at Start.
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./geometry'));
  else global.MapCheck = factory(global.Geometry);
})(typeof window !== 'undefined' ? window : globalThis, function (G) {
  // A percentage that never reads 100 for something that is not exactly 100
  function fmtPct(p) {
    if (Math.abs(p - 100) < 1e-9) return '100';
    const whole = Math.round(p);
    if (whole !== 100) return String(whole);
    for (let d = 1; d <= 4; d++) {
      const s = p.toFixed(d);
      if (parseFloat(s) !== 100) return s.replace(/0+$/, '');
    }
    return p > 100 ? '>100' : '<100';
  }

  // The output size that shows this slice pixel for pixel (a quarter turn swaps W and H)
  function exactOutSize(s) {
    const swap = G.netRotation(s) === 90 || G.netRotation(s) === 270;
    return { w: Math.round(swap ? s.in.h : s.in.w), h: Math.round(swap ? s.in.w : s.in.h) };
  }

  function scaleInfo(s) {
    const t = exactOutSize(s);
    const ow = Math.round(s.out.w), oh = Math.round(s.out.h);
    if (t.w <= 0 || t.h <= 0 || ow <= 0 || oh <= 0) return { exact: false, label: 'no size', wPct: 0, hPct: 0 };
    const exact = ow === t.w && oh === t.h;
    const wPct = (ow / t.w) * 100, hPct = (oh / t.h) * 100;
    return { exact, wPct, hPct, label: exact ? '1:1' : `${fmtPct(wPct)}% x ${fmtPct(hPct)}%` };
  }

  // The parts of r that lie outside bounds, as up to four rects that do not overlap
  function rectOutside(r, b) {
    if (r.w <= 0 || r.h <= 0) return [];
    if (!G.intersect(r, b)) return [{ x: r.x, y: r.y, w: r.w, h: r.h }];
    const out = [];
    const x1 = r.x + r.w, y1 = r.y + r.h, bx1 = b.x + b.w, by1 = b.y + b.h;
    if (r.x < b.x) out.push({ x: r.x, y: r.y, w: b.x - r.x, h: r.h });
    if (x1 > bx1) out.push({ x: bx1, y: r.y, w: x1 - bx1, h: r.h });
    const mx = Math.max(r.x, b.x), mw = Math.min(x1, bx1) - mx;
    if (r.y < b.y) out.push({ x: mx, y: r.y, w: mw, h: b.y - r.y });
    if (y1 > by1) out.push({ x: mx, y: by1, w: mw, h: y1 - by1 });
    return out;
  }

  const areaOf = (rects) => rects.reduce((sum, r) => sum + r.w * r.h, 0);

  // Area covered by a set of rects, counting shared area once
  function unionArea(rects) {
    const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.w]))].sort((a, b) => a - b);
    let total = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      const x0 = xs[i], x1 = xs[i + 1];
      const spans = rects
        .filter((r) => r.x <= x0 && r.x + r.w >= x1)
        .map((r) => [r.y, r.y + r.h])
        .sort((a, b) => a[0] - b[0]);
      let covered = 0, end = -Infinity;
      for (const [y0, y1] of spans) {
        if (y1 <= end) continue;
        covered += y1 - Math.max(y0, end);
        end = y1;
      }
      total += covered * (x1 - x0);
    }
    return total;
  }

  // Never 0% for something that is there, never 100% for something that is partly gone
  function sharePct(part, whole) {
    if (!whole || part <= 0) return 0;
    if (part >= whole) return 100;
    return Math.max(1, Math.min(99, Math.round((part / whole) * 100)));
  }

  function analyze(project) {
    const screens = project.screens || [];
    const firstId = screens[0] ? screens[0].id : null;
    const IW = Math.max(1, Math.round(project.input.width));
    const IH = Math.max(1, Math.round(project.input.height));
    const canvas = { x: 0, y: 0, w: IW, h: IH };
    const screenStats = [];
    const outside = [];
    const overlaps = [];
    const placed = new Set();
    let usedPx = 0, totalPx = 0;

    for (const sc of screens) {
      const bounds = { x: 0, y: 0, w: Math.round(sc.width), h: Math.round(sc.height) };
      const effs = G.effectiveSlices(project, sc.id);
      for (const e of effs) {
        placed.add(e.slice.id);
        const rects = rectOutside(e.place, bounds);
        if (!rects.length) continue;
        const pct = sharePct(areaOf(rects), e.place.w * e.place.h);
        outside.push({
          side: 'output', view: 'output', sliceId: e.slice.id, screenId: sc.id, rects, pct,
          message: pct === 100
            ? `"${e.slice.name}" lies completely outside ${sc.name}`
            : `"${e.slice.name}" is ${pct}% outside ${sc.name}`,
        });
      }

      // Overlap counts on the output only: showing the same input twice is normal.
      // A polygon mask's bounding box says nothing about where it really overlaps.
      const rectEffs = effs.filter((e) => !e.polyMask);
      for (let i = 0; i < rectEffs.length; i++) {
        for (let j = i + 1; j < rectEffs.length; j++) {
          const hit = G.intersect(rectEffs[i].place, rectEffs[j].place);
          const rect = hit && G.intersect(hit, bounds);
          if (!rect) continue;
          overlaps.push({
            view: 'output', sliceId: rectEffs[i].slice.id, otherId: rectEffs[j].slice.id, screenId: sc.id, rects: [rect],
            message: `"${rectEffs[i].slice.name}" and "${rectEffs[j].slice.name}" overlap by ${rect.w}×${rect.h} px on ${sc.name}`,
          });
        }
      }

      const used = unionArea(effs.map((e) => G.intersect(e.place, bounds)).filter(Boolean));
      const total = bounds.w * bounds.h;
      usedPx += used;
      totalPx += total;
      screenStats.push({ screenId: sc.id, name: sc.name, usedPct: sharePct(used, total) });
    }

    for (const s of project.slices) {
      if (s.enabled === false) continue;
      const screenId = s.screenId || firstId;
      const hasMask = s.mask && s.mask.enabled && s.mask.points && s.mask.points.length >= 3;
      const bbox = hasMask ? G.maskBBox(s.mask) : null;
      const wanted = bbox ? G.intersect(s.in, bbox) : s.in;
      const rects = wanted ? rectOutside(wanted, canvas) : [];
      if (!placed.has(s.id)) {
        const noSize = s.in.w <= 0 || s.in.h <= 0 || s.out.w <= 0 || s.out.h <= 0;
        outside.push({
          side: 'input', view: 'input', sliceId: s.id, screenId, rects, outRects: s.out.w > 0 && s.out.h > 0 ? [s.out] : [], pct: 100, dropped: true,
          message: noSize
            ? `"${s.name}" has no size, so it is left out of the export`
            : `"${s.name}" has nothing inside the input canvas, so it is left out of the export`,
        });
      } else if (rects.length) {
        const pct = sharePct(areaOf(rects), wanted.w * wanted.h);
        outside.push({
          side: 'input', view: 'input', sliceId: s.id, screenId, rects, outRects: [], pct,
          message: `"${s.name}" is ${pct}% outside the input canvas`,
        });
      }
    }

    return {
      usedPct: sharePct(usedPx, totalPx),
      screens: screenStats,
      outside,
      overlaps,
      problems: outside.length + overlaps.length,
    };
  }

  // Footage that would be resized to the canvas without anyone having asked for it.
  // Fit, fill, native or a changed scale are a choice, so they do not count.
  function footageStretched(probe, input, transform) {
    if (!probe || !probe.width || !probe.height) return false;
    if (probe.width === Math.round(input.width) && probe.height === Math.round(input.height)) return false;
    const t = transform || {};
    if ((t.mode || 'stretch') !== 'stretch') return false;
    const sc = t.scale != null ? t.scale : 100;
    const scy = t.scaleY != null ? t.scaleY : sc;
    return sc === 100 && scy === 100;
  }

  // Would a canvas of this size leave every one of these files unresized? Files of
  // unknown size cannot be judged, so they do not hold the answer back.
  function canvasFitsAll(files, size) {
    return files.every((f) => !footageStretched(f.probe, size, f.transform));
  }

  return { scaleInfo, exactOutSize, rectOutside, unionArea, analyze, footageStretched, canvasFitsAll };
});
