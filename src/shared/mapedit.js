'use strict';
// Mapping editor maths: cutting a wide input into rows of whole LED panels, keeping rotation,
// flip and mask on the parts, and telling a real mouse wheel from a trackpad.
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.MapEdit = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MAX_PARTS = 2000;

  // The widest part of at most `available` px that holds a whole number of panels.
  // Without a panel width any size is allowed. 0 means not even one panel fits.
  function partWidth(available, panelW) {
    const avail = Math.floor(available);
    if (!(panelW > 0)) return Math.max(0, avail);
    return Math.floor(avail / panelW) * panelW;
  }

  function cutWidths(total, partW) {
    if (!(total > 0) || !(partW > 0)) return [];
    const n = Math.ceil(total / partW);
    const widths = new Array(Math.min(n, MAX_PARTS + 1)).fill(partW);
    if (n <= MAX_PARTS) widths[n - 1] = total - (n - 1) * partW;
    return widths;
  }

  // Where the parts land on the output canvas. A slice turned a quarter shows its input width
  // upright, so its parts stand next to each other as columns.
  function layout(o) {
    const { totalW, rowH, partW, canvas } = o;
    const panelW = o.panelW > 0 ? o.panelW : 0;
    const startX = o.startX || 0;
    const startY = o.startY || 0;
    const gap = o.gap || 0;
    const quarter = !!o.quarter;
    let widths = cutWidths(totalW, partW);
    const tooMany = widths.length > MAX_PARTS;
    if (tooMany) widths = [];
    const rects = widths.map((w, i) => (quarter
      ? { x: startX + i * (rowH + gap), y: startY, w: rowH, h: w }
      : { x: startX, y: startY + i * (rowH + gap), w, h: rowH }));
    const right = rects.reduce((m, r) => Math.max(m, r.x + r.w), 0);
    const bottom = rects.reduce((m, r) => Math.max(m, r.y + r.h), 0);
    const inside = startX >= 0 && startY >= 0 && right <= canvas.w && bottom <= canvas.h;
    return {
      widths,
      rects,
      quarter,
      panelW,
      right,
      bottom,
      tooMany,
      fits: rects.length > 0 && inside,
      panels: panelW ? widths.map((w) => w / panelW) : null,
    };
  }

  const panelCount = (n) => String(Math.round(n * 10) / 10);

  // "3 rows of 36 / 36 / 28 panels, fits on 3840×2160"
  function summary(l, canvas) {
    const noun = l.quarter ? 'column' : 'row';
    const n = l.widths.length;
    const size = `${canvas.w}×${canvas.h}`;
    if (l.tooMany) return `More than ${MAX_PARTS} ${noun}s: use a larger part width`;
    if (!n) return 'Fill in the sizes';
    if (!l.fits) return `Does not fit: needs ${l.right}×${l.bottom} px from ${l.rects[0].x},${l.rects[0].y}, the output is ${size}`;
    const count = `${n} ${noun}${n === 1 ? '' : 's'}`;
    let what;
    if (l.panels) {
      const all = l.panels.map(panelCount);
      const first = all[0];
      if (n <= 4) what = `of ${all.join(' / ')} panels`;
      else if (all[n - 1] === first) what = `of ${first} panels`;
      else what = `of ${first} panels, the last of ${all[n - 1]}`;
      return `${count} ${what}, fits on ${size}`;
    }
    const last = l.widths[n - 1];
    what = n > 1 && last !== l.widths[0] ? `${n - 1} × ${l.widths[0]} + 1 × ${last} px` : `${n} × ${l.widths[0]} px`;
    return `${count}: ${what}, fits on ${size}`;
  }

  // Sutherland-Hodgman against an axis-aligned rect. Crossing points land on whole pixels, the
  // same pixel for the parts on either side of a cut, so neighbouring parts still meet.
  function clipPolygon(points, r) {
    const crossX = (a, b, x) => ({ x, y: Math.round(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y)) });
    const crossY = (a, b, y) => ({ x: Math.round(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x)), y });
    const edges = [
      { in: (p) => p.x >= r.x, cut: (a, b) => crossX(a, b, r.x) },
      { in: (p) => p.x <= r.x + r.w, cut: (a, b) => crossX(a, b, r.x + r.w) },
      { in: (p) => p.y >= r.y, cut: (a, b) => crossY(a, b, r.y) },
      { in: (p) => p.y <= r.y + r.h, cut: (a, b) => crossY(a, b, r.y + r.h) },
    ];
    let out = points.map((p) => ({ x: p.x, y: p.y }));
    for (const e of edges) {
      const src = out;
      out = [];
      for (let i = 0; i < src.length; i++) {
        const cur = src[i];
        const prev = src[(i + src.length - 1) % src.length];
        const curIn = e.in(cur);
        if (curIn !== e.in(prev)) out.push(e.cut(prev, cur));
        if (curIn) out.push(cur);
      }
      if (!out.length) return null;
    }
    out = out.filter((p, i) => {
      const q = out[(i + out.length - 1) % out.length];
      return p.x !== q.x || p.y !== q.y;
    });
    if (out.length < 3) return null;
    let area = 0;
    out.forEach((p, i) => {
      const q = out[(i + 1) % out.length];
      area += p.x * q.y - q.x * p.y;
    });
    return Math.abs(area) > 0 ? out : null;
  }

  // The parts that replace slice `s`. Everything but the rectangles stays as it was.
  // A part completely outside an active mask showed nothing before, so it starts switched off.
  function splitSlice(s, l, makeId) {
    const n = l.widths.length;
    let offset = 0;
    return l.widths.map((w, i) => {
      const part = JSON.parse(JSON.stringify(s));
      part.id = makeId();
      part.name = `${s.name} ${i + 1}/${n}`;
      part.in = { x: s.in.x + offset, y: s.in.y, w, h: s.in.h };
      part.out = { ...l.rects[i] };
      offset += w;
      if (part.mask && part.mask.points) {
        const clipped = clipPolygon(part.mask.points, part.in);
        if (clipped) {
          part.mask.points = clipped;
        } else {
          if (part.mask.enabled) part.enabled = false;
          part.mask = null;
        }
      }
      return part;
    });
  }

  function partsOutsideMask(s, l) {
    if (!s.mask || !s.mask.enabled || !s.mask.points) return 0;
    return splitSlice(s, l, () => '').filter((p) => !p.mask).length;
  }

  // A mouse wheel moves in notches; a trackpad streams small steps and is the pan gesture.
  // On macOS Chromium reports a trackpad with wheelDeltaY exactly -3 × deltaY. A Windows notch is 120.
  // Shift+wheel never zooms: it is the sideways pan.
  // Chromium turns a touchpad pinch into ctrlKey wheel events with wheelDeltaY ±120 and
  // deltaY = -100·ln(scale), so only the small deltaY tells it from a Ctrl+notch (±100, or
  // 100 / display scale). From 20 up a pinch step is about one notch anyway.
  function isMouseWheel(e, isMac) {
    if (e.shiftKey || e.deltaX) return false;
    if (e.deltaMode) return true;
    if (e.ctrlKey && Math.abs(e.deltaY) < 20) return false;
    const w = e.wheelDeltaY;
    if (!w) return false;
    if (isMac) return Math.abs(w + 3 * e.deltaY) >= 3;
    return Math.abs(w) % 120 === 0;
  }

  // Shift+wheel pans sideways, whether or not Chromium already moved the delta to deltaX
  function panDelta(e) {
    return e.shiftKey ? { x: e.deltaX || e.deltaY, y: 0 } : { x: e.deltaX, y: e.deltaY };
  }

  // Zoom for a mouse wheel: one notch is one step of the + and − buttons
  function notchFactor(e) {
    const notches = e.deltaMode ? -Math.sign(e.deltaY) : e.wheelDeltaY / 120;
    return Math.pow(1.25, notches);
  }

  return { MAX_PARTS, partWidth, cutWidths, layout, summary, clipPolygon, splitSlice, partsOutsideMask, isMouseWheel, panDelta, notchFactor };
});
