'use strict';
// Green Hippo Hippotizer VideoMapper CSV import & export.
// Spec: https://www.manula.com/manuals/green-hippo/hippotizer-v4/4.9.4/en/topic/csv-import
//
// One tile per line, 16 comma-separated columns, no header row:
//    1  Input X              px, from top-left
//    2  Input Y              px
//    3  Input X Size         px
//    4  Input Y Size         px
//    5  Input Rotation       degrees (0-360)
//    6  Input Tile Flipped X True / False
//    7  Input Tile Flipped Y True / False
//    8  Output X             px, from top-left
//    9  Output Y             px
//   10  Output X Size        px
//   11  Output Y Size        px
//   12  Output Rotation      degrees (0-360)
//   13  Red Level            0-255 (255 = default)
//   14  Green Level          0-255
//   15  Blue Level           0-255
//   16  Colour Block Index   0+
//
// The importer is deliberately tolerant: Hippotizer's own exports (and anything
// that has been through a spreadsheet) often carry a header row, trailing blank
// rows and stray single-value rows. Those are skipped rather than rejected.
//
// A CSV has no notion of an input canvas or output resolution, so both are
// derived from the tile extents. It also has no screens, so one CSV is exactly
// one output — a multi-screen project exports one file per screen.
//
// Rotation: verified against the VideoMapper example mapping that ships with the
// docs (tiles at 90/180/270 tracked corner-for-corner from the input picture to
// the output picture) — a Hippotizer rotation turns the tile CLOCKWISE, the same
// direction as Geometry.netRotation here. Input and output rotation add up, so
// the pair is folded into one net quarter turn on the Output rect and the
// original split is kept alongside so an untouched tile round-trips byte-exact.
//
// Flip: the two flip columns sit with the input columns and are documented as
// "Input Tile Flipped", i.e. mirroring happens before the rotation, while this
// app mirrors after it. That only differs for quarter turns, where mirroring
// before a 90°/270° turn swaps the two axes — so the bits are swapped there
// (and swapped back on export). The example picture shows no mirrored tiles, so
// it could not confirm this; for 0° and 180° the two readings are identical.
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Hippo = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const COLUMNS = [
    'Input X', 'Input Y', 'Input X Size', 'Input Y Size', 'Input Rotation',
    'Input Tile Flipped X', 'Input Tile Flipped Y',
    'Output X', 'Output Y', 'Output X Size', 'Output Y Size', 'Output Rotation of Tile',
    'Red Level', 'Green Level', 'Blue Level', 'Colour Block Index',
  ];

  // Minimal RFC4180-ish splitter: handles quoted fields and doubled quotes.
  function splitLine(line) {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else q = false;
        } else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === ';' || c === '\t') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function num(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return NaN;
    return parseFloat(s.replace(',', '.'));
  }

  function bool(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }

  // Snap to a 90° step; the renderer only supports quarter turns.
  function snap90(deg) {
    const d = num(deg);
    if (!isFinite(d)) return { value: 0, snapped: false };
    const norm = ((d % 360) + 360) % 360;
    const value = (Math.round(norm / 90) * 90) % 360;
    return { value, snapped: Math.abs(norm - value) > 0.5 && Math.abs(norm - value) < 359.5 };
  }

  // Mirroring before a quarter turn is mirroring on the other axis after it.
  function swapFlipForQuarterTurn(flip, netRot) {
    if (netRot !== 90 && netRot !== 270) return flip;
    return ((flip & 1) ? 2 : 0) | ((flip & 2) ? 1 : 0);
  }

  function netRotationOf(s) {
    return ((((snap90(s.outOrient || 0).value - snap90(s.inOrient || 0).value) % 360) + 360) % 360);
  }

  function parseCsv(text, opts) {
    const o = opts || {};
    const warnings = [];
    const lines = String(text).split(/\r\n|\r|\n/);
    const slices = [];
    let skipped = 0;
    let rotSnapped = 0;

    lines.forEach((line, li) => {
      if (!line.trim()) return;
      const c = splitLine(line);
      // A usable row needs at least through Output Rotation (12 columns).
      const nums = [0, 1, 2, 3, 7, 8, 9, 10].map((i) => num(c[i]));
      if (c.length < 12 || nums.some((n) => !isFinite(n))) {
        // A header row is expected and silent; anything else is reported.
        const isHeader = li === 0 && /input/i.test(c[0] || '');
        if (!isHeader) skipped++;
        return;
      }
      const inR = { x: Math.round(nums[0]), y: Math.round(nums[1]), w: Math.round(nums[2]), h: Math.round(nums[3]) };
      const outR = { x: Math.round(nums[4]), y: Math.round(nums[5]), w: Math.round(nums[6]), h: Math.round(nums[7]) };
      if (inR.w <= 0 || inR.h <= 0 || outR.w <= 0 || outR.h <= 0) { skipped++; return; }

      const inRot = snap90(c[4]);
      const outRot = snap90(c[11]);
      if (inRot.snapped || outRot.snapped) rotSnapped++;
      // both rotate the tile clockwise, so they simply add up
      const net = (inRot.value + outRot.value) % 360;

      const flipIn = (bool(c[5]) ? 1 : 0) | (bool(c[6]) ? 2 : 0);
      const flip = swapFlipForQuarterTurn(flipIn, net);
      const rgb = {
        r: isFinite(num(c[12])) ? Math.max(0, Math.min(255, Math.round(num(c[12])))) : 255,
        g: isFinite(num(c[13])) ? Math.max(0, Math.min(255, Math.round(num(c[13])))) : 255,
        b: isFinite(num(c[14])) ? Math.max(0, Math.min(255, Math.round(num(c[14])))) : 255,
      };
      const blockRaw = num(c[15]);
      const block = isFinite(blockRaw) ? Math.round(blockRaw) : slices.length;

      slices.push({
        id: 'csv' + (slices.length + 1),
        name: 'Tile ' + block,
        enabled: true,
        screenId: 'scr1',
        in: inR,
        out: outR,
        inOrient: 0,
        outOrient: net,
        flip,
        mask: null,
        rgb,
        blockIndex: block,
        hippoRot: { in: inRot.value, out: outRot.value },
      });
    });

    if (!slices.length) throw new Error('No usable tile rows found in this CSV');
    if (skipped) warnings.push(`${skipped} row${skipped === 1 ? '' : 's'} skipped (blank or incomplete)`);
    if (rotSnapped) {
      warnings.push(
        `${rotSnapped} tile${rotSnapped === 1 ? '' : 's'} had a rotation that is not a multiple of 90° — snapped to the nearest quarter turn`
      );
    }

    const input = {
      width: Math.max(1, ...slices.map((s) => s.in.x + s.in.w)),
      height: Math.max(1, ...slices.map((s) => s.in.y + s.in.h)),
    };
    const screen = {
      id: 'scr1',
      name: o.screenName || 'Output #1',
      width: Math.max(1, ...slices.map((s) => s.out.x + s.out.w)),
      height: Math.max(1, ...slices.map((s) => s.out.y + s.out.h)),
    };

    return {
      name: o.name || 'Hippotizer CSV import',
      input,
      screens: [screen],
      slices,
      warnings,
    };
  }

  function slicesOfScreen(project, screenId) {
    const first = (project.screens && project.screens[0] && project.screens[0].id) || null;
    return (project.slices || []).filter((s) => (s.screenId || first) === screenId);
  }

  // One CSV = one output. `screenId` picks the screen; defaults to the first.
  function exportCsv(project, screenId, opts) {
    const o = opts || {};
    const screens = project.screens && project.screens.length ? project.screens : [{ id: 'scr1' }];
    const sid = screenId || screens[0].id;
    const rows = slicesOfScreen(project, sid);

    const L = [];
    if (o.header) L.push(COLUMNS.join(','));
    rows.forEach((s, i) => {
      const net = netRotationOf(s);
      // keep the original input/output rotation split when it still adds up to
      // the current net turn, so an imported tile comes back out unchanged
      const hr = s.hippoRot;
      const split = hr && ((hr.in + hr.out) % 360) === net ? hr : { in: 0, out: net };
      const flip = swapFlipForQuarterTurn(s.flip || 0, net);
      const rgb = s.rgb || {};
      L.push([
        Math.round(s.in.x), Math.round(s.in.y), Math.round(s.in.w), Math.round(s.in.h),
        split.in,
        flip & 1 ? 'True' : 'False',
        flip & 2 ? 'True' : 'False',
        Math.round(s.out.x), Math.round(s.out.y), Math.round(s.out.w), Math.round(s.out.h),
        split.out,
        rgb.r != null ? rgb.r : 255,
        rgb.g != null ? rgb.g : 255,
        rgb.b != null ? rgb.b : 255,
        s.blockIndex != null ? s.blockIndex : i,
      ].join(','));
    });
    // Hippotizer reads CRLF-terminated lines.
    return L.join('\r\n') + '\r\n';
  }

  // Which slices would be lost or degraded by a CSV round-trip.
  function exportNotes(project, screenId) {
    const notes = [];
    const rows = slicesOfScreen(project, screenId || ((project.screens || [{}])[0] || {}).id);
    const masked = rows.filter((s) => s.mask && s.mask.points && s.mask.points.length >= 3).length;
    if (masked) {
      notes.push(`${masked} slice${masked === 1 ? '' : 's'} with an input mask — CSV has no mask support, the masks are not written`);
    }
    const disabled = rows.filter((s) => s.enabled === false).length;
    if (disabled) notes.push(`${disabled} disabled slice${disabled === 1 ? '' : 's'} written as normal tiles (CSV has no enable flag)`);
    return notes;
  }

  return { COLUMNS, parseCsv, exportCsv, exportNotes, splitLine, netRotationOf };
});
