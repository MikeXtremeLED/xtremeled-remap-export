'use strict';
// Fitting a job to the show and checking it on the wall: image sequences as clips, timecode,
// the geometry of the test patterns and the frame check. No file access here, so the renderer
// and the render pipeline share the same rules.
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Conform = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // ---------------- image sequences ----------------
  const SEQUENCE_EXTS = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'exr', 'dpx'];
  // Two or three numbered files are more often separate stills than a render
  const MIN_SEQUENCE_FRAMES = 5;

  function splitPath(p) {
    const s = String(p);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return { dir: s.slice(0, i + 1), name: s.slice(i + 1) };
  }

  const escapePercent = (s) => s.replace(/%/g, '%%');

  // {prefix, digits, number, suffix, ext} for a frame file with a number in its name, else null
  function parseNumbered(name) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    const ext = name.slice(dot + 1);
    if (!SEQUENCE_EXTS.includes(ext.toLowerCase())) return null;
    const m = name.slice(0, dot).match(/^(.*?)(\d+)([^\d]*)$/);
    if (!m || m[2].length > 15) return null;
    return { prefix: m[1], digits: m[2], number: parseInt(m[2], 10), suffix: m[3], ext };
  }

  function folderName(dir) {
    return dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'sequence';
  }

  function makeSequence(dir, run, pad) {
    const { prefix, suffix, ext } = run[0];
    return {
      first: dir + run[0].name,
      pattern: `${escapePercent(dir + prefix)}%0${pad}d${escapePercent(suffix)}.${ext}`,
      start: run[0].number,
      count: run.length,
      fps: 25,
      label: `${prefix}${'#'.repeat(pad)}${suffix}.${ext}`,
      stem: prefix.replace(/[._\- ]+$/, '') || folderName(dir),
    };
  }

  // Sorts paths into numbered runs and everything else. A gap in the numbering splits the run:
  // ffmpeg stops reading at the first number it can't find.
  function detectSequences(paths) {
    const groups = new Map();
    const rest = [];
    for (const p of paths) {
      const { dir, name } = splitPath(p);
      const n = parseNumbered(name);
      if (!n) {
        rest.push(p);
        continue;
      }
      const key = `${dir}\0${n.prefix.toLowerCase()}\0${n.suffix.toLowerCase()}\0${n.ext.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { dir, items: [] });
      groups.get(key).items.push({ ...n, name, path: p });
    }
    const sequences = [];
    let gaps = 0;
    for (const { dir, items } of groups.values()) {
      items.sort((a, b) => a.number - b.number);
      const runs = [];
      for (const it of items) {
        const last = runs.length ? runs[runs.length - 1] : null;
        if (last && it.number === last[last.length - 1].number + 1) last.push(it);
        else runs.push([it]);
      }
      // Anything broken off a real run is a gap, also a single frame left at the end
      if (runs.some((r) => r.length >= MIN_SEQUENCE_FRAMES)) gaps += runs.length - 1;
      for (const run of runs) {
        const pad = Math.min(...run.map((r) => r.digits.length));
        const regular = run.every((r) => r.digits === String(r.number).padStart(pad, '0'));
        if (run.length >= MIN_SEQUENCE_FRAMES && regular) sequences.push(makeSequence(dir, run, pad));
        else run.forEach((r) => rest.push(r.path));
      }
    }
    return { sequences, rest, gaps };
  }

  function frameFile(seq, number) {
    return seq.pattern.replace(/%%|%0(\d+)d/g, (m, pad) => (m === '%%' ? '%' : String(number).padStart(parseInt(pad, 10), '0')));
  }

  // The frame number shown at a time in the clip; never past the last frame
  function frameAtTime(seq, sec) {
    const offset = Math.max(0, Math.min(seq.count - 1, Math.round((sec || 0) * seq.fps)));
    return seq.start + offset;
  }

  // The same frames after the folder has moved
  function moveSequence(seq, newFirstPath) {
    const { dir } = splitPath(newFirstPath);
    const old = seq.pattern;
    const i = Math.max(old.lastIndexOf('/'), old.lastIndexOf('\\'));
    return { ...seq, pattern: escapePercent(dir) + old.slice(i + 1) };
  }

  // ---------------- timecode ----------------
  function parseTimecode(text) {
    const m = String(text || '').match(/^(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2})$/);
    if (!m) return null;
    return { h: +m[1], m: +m[2], s: +m[3], f: +m[5], drop: m[4] !== ':' };
  }

  // Dropped frame numbers per minute; only 29.97 and 59.94 have drop-frame timecode
  const dropPerMinute = (nominal) => (nominal === 30 ? 2 : nominal === 60 ? 4 : 0);

  function timecodeToFrames(tc, nominal) {
    let total = (tc.h * 3600 + tc.m * 60 + tc.s) * nominal + tc.f;
    const d = tc.drop ? dropPerMinute(nominal) : 0;
    if (d) {
      const minutes = tc.h * 60 + tc.m;
      total -= d * (minutes - Math.floor(minutes / 10));
    }
    return total;
  }

  function framesToTimecode(total, nominal, drop) {
    const d = drop ? dropPerMinute(nominal) : 0;
    const day = (nominal * 86400) - (d ? d * (1440 - 144) : 0);
    let n = ((total % day) + day) % day;
    if (d) {
      const per10 = nominal * 600 - d * 9;
      const perMin = nominal * 60 - d;
      const tens = Math.floor(n / per10);
      const m = n % per10;
      n += d * 9 * tens + (m > d ? d * Math.floor((m - d) / perMin) : 0);
    }
    const two = (v) => String(v).padStart(2, '0');
    const f = n % nominal;
    const secs = Math.floor(n / nominal);
    return `${two(Math.floor(secs / 3600))}:${two(Math.floor(secs / 60) % 60)}:${two(secs % 60)}${d ? ';' : ':'}${two(f)}`;
  }

  // The start timecode of the output: the source's, moved on by the in-point and re-counted
  // when the frame rate changes. null when the source timecode can't be read.
  function outputTimecode(text, sourceFps, outFps, inSec) {
    const tc = parseTimecode(text);
    if (!tc || !(sourceFps > 0) || !(outFps > 0)) return null;
    const sourceNominal = Math.round(sourceFps);
    const outNominal = Math.round(outFps);
    const start = timecodeToFrames(tc, sourceNominal) + Math.round((inSec || 0) * sourceFps);
    if (tc.drop && dropPerMinute(sourceNominal)) {
      // A drop-frame label follows the clock, its frame count doesn't: 01:00:00;00 is 107892
      // frames, which reads 00:59:56 when counted without dropping. So the label is carried over.
      const moved = parseTimecode(framesToTimecode(start, sourceNominal, true));
      const outDrop = !!dropPerMinute(outNominal) && Math.abs(outFps - outNominal) > 0.01;
      const label = { ...moved, f: Math.floor((moved.f * outNominal) / sourceNominal), drop: outDrop };
      return framesToTimecode(timecodeToFrames(label, outNominal), outNominal, outDrop);
    }
    const frames = outNominal === sourceNominal ? start : Math.floor((start * outNominal) / sourceNominal);
    return framesToTimecode(frames, outNominal, false);
  }

  // ---------------- test pattern ----------------
  // Everything is whole-pixel rectangles {x, y, w, h}, so a line is exactly one pixel wide.
  const EDGE_DEPTH = 12;
  const TICK_LONG = 22;
  const TICK_SHORT = 8;

  const odd = (n) => (((n % 2) + 2) % 2) === 1;

  // The alternating teeth along the four edges of a slice, in input-canvas pixels. Top and left
  // edges use odd output positions, bottom and right edges even ones, so at a seam the teeth
  // of the two slices interlock; a shift of one pixel makes them line up instead.
  function sliceMarkers(eff, options) {
    const o = options || {};
    const { crop, place, rot, flip } = eff;
    const depth = Math.max(1, Math.min(EDGE_DEPTH, Math.floor(Math.min(crop.w, crop.h) / 4)));
    const straight = !rot && !flip && crop.w === place.w && crop.h === place.h;
    const dx = straight ? place.x - crop.x : 0;
    const dy = straight ? place.y - crop.y : 0;
    const panelW = o.panelW > 0 ? o.panelW : 0;
    const panelH = o.panelH > 0 ? o.panelH : 0;
    const bands = [
      { x: crop.x, y: crop.y, w: crop.w, h: depth },
      { x: crop.x, y: crop.y + crop.h - depth, w: crop.w, h: depth },
      { x: crop.x, y: crop.y, w: depth, h: crop.h },
      { x: crop.x + crop.w - depth, y: crop.y, w: depth, h: crop.h },
    ];
    const teeth = [];
    for (let x = crop.x; x < crop.x + crop.w; x++) {
      if (odd(x + dx)) teeth.push({ x, y: crop.y, w: 1, h: depth });
      else teeth.push({ x, y: crop.y + crop.h - depth, w: 1, h: depth });
    }
    for (let y = crop.y + depth; y < crop.y + crop.h - depth; y++) {
      if (odd(y + dy)) teeth.push({ x: crop.x, y, w: depth, h: 1 });
      else teeth.push({ x: crop.x + crop.w - depth, y, w: depth, h: 1 });
    }
    const ticks = [];
    const room = Math.floor(Math.min(crop.w, crop.h) / 2) - depth;
    const lengthAt = (local, panel) => {
      const len = panel && local % panel === 0 ? TICK_LONG : local % 10 === 0 ? TICK_SHORT : 0;
      return Math.max(0, Math.min(len, room));
    };
    for (let i = depth; i < crop.w - depth; i++) { // clear of the teeth on the other two edges
      const len = lengthAt(i, panelW);
      if (!len) continue;
      ticks.push({ x: crop.x + i, y: crop.y + depth, w: 1, h: len });
      ticks.push({ x: crop.x + i, y: crop.y + crop.h - depth - len, w: 1, h: len });
    }
    for (let i = depth; i < crop.h - depth; i++) {
      const len = lengthAt(i, panelH);
      if (!len) continue;
      ticks.push({ x: crop.x + depth, y: crop.y + i, w: len, h: 1 });
      ticks.push({ x: crop.x + crop.w - depth - len, y: crop.y + i, w: len, h: 1 });
    }
    return { depth, bands, teeth, ticks };
  }

  // One-pixel lines of the LED panel grid, counted from the corner of the slice
  function panelLines(crop, panelW, panelH) {
    const lines = [];
    if (panelW > 0) for (let x = crop.x; x < crop.x + crop.w; x += panelW) lines.push({ x, y: crop.y, w: 1, h: crop.h });
    if (panelH > 0) for (let y = crop.y; y < crop.y + crop.h; y += panelH) lines.push({ x: crop.x, y, w: crop.w, h: 1 });
    return lines;
  }

  function coordsLabel(eff) {
    const r = (a) => `${a.x},${a.y} ${a.w}×${a.h}`;
    return `IN ${r(eff.crop)} / OUT ${r(eff.place)}`;
  }

  // ---------------- player test ----------------
  const SEGMENTS = {
    a: 0b1111101101, // digits 0,2,3,5,6,7,8,9
    b: 0b1110011111,
    c: 0b1111111011,
    d: 0b1101101101,
    e: 0b0101000101,
    f: 0b1101110001,
    g: 0b1101111100,
  };
  const COUNTER_DIGITS = 4;
  const MAX_COUNTERS = 24;

  function counterSize(sliceW, sliceH) {
    const hMax = Math.max(16, Math.min(240, Math.floor(sliceH * 0.5)));
    const widthFor = (h) => {
      const dw = Math.round(h * 0.56);
      const gap = Math.max(2, Math.round(dw * 0.22));
      return COUNTER_DIGITS * dw + (COUNTER_DIGITS - 1) * gap;
    };
    const limit = Math.floor(sliceW * 0.8);
    let h = hMax;
    while (h > 12 && widthFor(h) > limit) h -= 2;
    const dw = Math.round(h * 0.56);
    return { h, dw, gap: Math.max(2, Math.round(dw * 0.22)), w: widthFor(h) };
  }

  // Where the frame counters go: one in the middle of each slice, biggest slices first
  function counterPlaces(slices) {
    const list = slices
      .map((s) => s.crop)
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, MAX_COUNTERS);
    if (!list.length) return [];
    // one digit size, the one that fits the smallest of these slices
    const size = list.map((c) => counterSize(c.w, c.h)).reduce((a, b) => (b.h < a.h ? b : a));
    return list.map((c) => ({ x: Math.round(c.x + c.w / 2 - size.w / 2), y: Math.round(c.y + c.h / 2 - size.h / 2), size }));
  }

  // Seven-segment digits from drawbox with enable expressions: no font is needed, so it renders
  // the same on Windows and macOS.
  function counterFilters(size) {
    const { h, dw, gap } = size;
    const t = Math.max(1, Math.round(h / 9));
    const filters = [];
    for (let i = 0; i < COUNTER_DIGITS; i++) {
      const x = i * (dw + gap);
      const div = 10 ** (COUNTER_DIGITS - 1 - i);
      const digit = `mod(floor(n/${div})\\,10)`;
      const mid = Math.floor((h - t) / 2);
      const boxes = {
        a: [x, 0, dw, t],
        b: [x + dw - t, 0, t, mid + t],
        c: [x + dw - t, mid, t, h - mid],
        d: [x, h - t, dw, t],
        e: [x, mid, t, h - mid],
        f: [x, 0, t, mid + t],
        g: [x, mid, dw, t],
      };
      for (const [name, [bx, by, bw, bh]] of Object.entries(boxes)) {
        filters.push(`drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=white:t=fill:enable='gt(bitand(${SEGMENTS[name]}\\,pow(2\\,${digit}))\\,0)'`);
      }
    }
    return filters;
  }

  const PLAYER_TEST_SECONDS = 30;

  // ffmpeg filter graph for the player test: black, a white one-pixel bar crossing the canvas
  // about once every 4 s, and a burnt-in frame counter in every slice. Ends in [out].
  function playerTestGraph(width, height, rate, fps, seconds, places) {
    const step = Math.max(1, Math.round(width / (Math.max(1, fps) * 4)));
    const parts = [
      `color=c=black:s=${width}x${height}:r=${rate}:d=${seconds},format=yuv444p[bg]`,
      `color=c=white:s=1x${height}:r=${rate}:d=${seconds},format=yuv444p[bar]`,
      `[bg][bar]overlay=x='mod(n*${step}\\,main_w)':y=0:format=yuv444[p0]`,
    ];
    let last = 'p0';
    if (places.length) {
      const { size } = places[0];
      const splits = places.map((_, i) => `[d${i}]`).join('');
      parts.push(`color=c=black:s=${size.w}x${size.h}:r=${rate}:d=${seconds},format=yuv444p,${counterFilters(size).join(',')},split=${places.length}${splits}`);
      places.forEach((p, i) => {
        parts.push(`[${last}][d${i}]overlay=${p.x}:${p.y}:format=yuv444[p${i + 1}]`);
        last = `p${i + 1}`;
      });
    }
    parts.push(`[${last}]null[out]`);
    return parts.join(';');
  }

  // ---------------- frame check ----------------
  // Output pixel (local to the place rect) -> source pixel (local to the crop): the inverse of
  // the crop, transpose and flip steps in the export graph.
  function mapToCrop(eff, px, py) {
    const { crop, place, rot, flip } = eff;
    const u = flip & 1 ? place.w - 1 - px : px;
    const v = flip & 2 ? place.h - 1 - py : py;
    if (rot === 90) return { x: v, y: crop.h - 1 - u };
    if (rot === 180) return { x: crop.w - 1 - u, y: crop.h - 1 - v };
    if (rot === 270) return { x: crop.w - 1 - v, y: u };
    return { x: u, y: v };
  }

  function isScaled(eff) {
    const turned = eff.rot === 90 || eff.rot === 270;
    return (turned ? eff.crop.h : eff.crop.w) !== eff.place.w || (turned ? eff.crop.w : eff.crop.h) !== eff.place.h;
  }

  // Counts pixels of one slice that differ from the input canvas. Both buffers are RGBA; covers
  // are the place rects of slices drawn over this one, which can't be compared. lumaOnly is for
  // chroma-subsampled sources: their colour is shared between neighbouring pixels, so only
  // brightness can be held to a single pixel.
  function compareSlice(out, outW, outH, ref, refW, refH, eff, covers, options) {
    const { crop, place } = eff;
    const tol = (options && options.tolerance) || 0;
    const lumaOnly = !!(options && options.lumaOnly);
    const lumaOf = (buf, i) => 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    const coverList = (covers || []).filter((c) => c.x < place.x + place.w && c.x + c.w > place.x && c.y < place.y + place.h && c.y + c.h > place.y);
    let different = 0;
    let compared = 0;
    let worst = 0;
    for (let y = 0; y < place.h; y++) {
      const oy = place.y + y;
      if (oy < 0 || oy >= outH) continue;
      for (let x = 0; x < place.w; x++) {
        const ox = place.x + x;
        if (ox < 0 || ox >= outW) continue;
        let covered = false;
        for (const c of coverList) {
          if (ox >= c.x && ox < c.x + c.w && oy >= c.y && oy < c.y + c.h) { covered = true; break; }
        }
        if (covered) continue;
        const m = mapToCrop(eff, x, y);
        const sx = crop.x + m.x;
        const sy = crop.y + m.y;
        if (sx < 0 || sy < 0 || sx >= refW || sy >= refH) continue;
        compared++;
        const a = (oy * outW + ox) * 4;
        const b = (sy * refW + sx) * 4;
        let delta = 0;
        if (lumaOnly) {
          delta = Math.abs(lumaOf(out, a) - lumaOf(ref, b));
        } else {
          for (let c = 0; c < 4; c++) {
            const d = Math.abs(out[a + c] - ref[b + c]);
            if (d > delta) delta = d;
          }
        }
        if (delta > worst) worst = delta;
        if (delta > tol) different++;
      }
    }
    return { different, compared, worst };
  }

  // The places where two slices touch on the output, top to bottom: {x, y, orient, a, b}.
  // x,y is the middle of the shared edge, clipped to the output.
  function seams(places, width, height) {
    const found = [];
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    places.forEach((a, i) => {
      for (let j = i + 1; j < places.length; j++) {
        const b = places[j];
        const x0 = clamp(Math.max(a.x, b.x), 0, width);
        const x1 = clamp(Math.min(a.x + a.w, b.x + b.w), 0, width);
        const y0 = clamp(Math.max(a.y, b.y), 0, height);
        const y1 = clamp(Math.min(a.y + a.h, b.y + b.h), 0, height);
        if ((a.y + a.h === b.y || b.y + b.h === a.y) && x1 > x0) {
          const y = a.y + a.h === b.y ? b.y : a.y;
          if (y > 0 && y < height) found.push({ x: Math.round((x0 + x1) / 2), y, orient: 'h', a: i, b: j });
        }
        if ((a.x + a.w === b.x || b.x + b.w === a.x) && y1 > y0) {
          const x = a.x + a.w === b.x ? b.x : a.x;
          if (x > 0 && x < width) found.push({ x, y: Math.round((y0 + y1) / 2), orient: 'v', a: i, b: j });
        }
      }
    });
    return found.sort((p, q) => p.y - q.y || p.x - q.x);
  }

  return {
    SEQUENCE_EXTS, MIN_SEQUENCE_FRAMES, PLAYER_TEST_SECONDS,
    detectSequences, frameFile, frameAtTime, moveSequence,
    parseTimecode, timecodeToFrames, framesToTimecode, outputTimecode,
    sliceMarkers, panelLines, coordsLabel,
    counterPlaces, playerTestGraph,
    mapToCrop, isScaled, compareSlice, seams,
  };
});
