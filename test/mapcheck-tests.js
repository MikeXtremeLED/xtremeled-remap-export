'use strict';
// Mapping check: scale labels, out of frame, overlap, footage size, import reports.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../src/shared/mapcheck');
const R = require('../src/shared/resolume');
const Hippo = require('../src/shared/hippo');

const slice = (id, inR, outR, extra) => Object.assign({ id, name: id, screenId: 'a', enabled: true, in: inR, out: outR, flip: 0, mask: null }, extra);
const rect = (x, y, w, h) => ({ x, y, w, h });
const proj = (slices, screens) => ({
  input: { width: 1000, height: 500 },
  screens: screens || [{ id: 'a', name: 'A', width: 1000, height: 1000 }],
  slices,
});

function run(ok) {
  console.log('Mapping check');

  assert.strictEqual(M.scaleInfo(slice('s', rect(0, 0, 3744, 416), rect(0, 0, 3744, 416))).label, '1:1');
  const scaled = M.scaleInfo(slice('s', rect(0, 0, 2912, 416), rect(0, 0, 3000, 416)));
  assert(!scaled.exact && scaled.label === '103% x 100%', scaled.label);
  const hair = M.scaleInfo(slice('s', rect(0, 0, 3744, 416), rect(0, 0, 3745, 416)));
  assert(!hair.exact && hair.label === '100.03% x 100%', 'a 1 px difference must not read 100%: ' + hair.label);
  const turned = slice('s', rect(0, 0, 400, 100), rect(0, 0, 100, 400), { outOrient: 90 });
  assert.strictEqual(M.scaleInfo(turned).label, '1:1', 'a quarter turn compares W with H');
  assert.deepStrictEqual(M.exactOutSize(slice('s', rect(0, 0, 400, 100), rect(5, 6, 7, 8), { outOrient: 270 })), { w: 100, h: 400 });
  ok('scale label: 1:1, per-axis percentage, quarter turns');

  assert.deepStrictEqual(M.rectOutside(rect(10, 10, 20, 20), rect(0, 0, 100, 100)), []);
  assert.strictEqual(M.rectOutside(rect(-10, 90, 120, 20), rect(0, 0, 100, 100)).reduce((a, r) => a + r.w * r.h, 0), 2400 - 1000);
  assert.deepStrictEqual(M.rectOutside(rect(200, 0, 10, 10), rect(0, 0, 100, 100)), [rect(200, 0, 10, 10)]);
  assert.strictEqual(M.unionArea([rect(0, 0, 10, 10), rect(5, 0, 10, 10), rect(0, 0, 10, 10)]), 150);
  ok('geometry helpers: parts outside, union area');

  const example = R.parseScreenSetup(fs.readFileSync(path.join(__dirname, '../examples/50x2m-100m2-P4.81-hanging.xml'), 'utf8'));
  const clean = M.analyze(example);
  assert.strictEqual(clean.usedPct, 52);
  assert.strictEqual(clean.problems, 0, 'masked slices hanging off the screen are fine: ' + JSON.stringify(clean.outside));
  assert.deepStrictEqual(example.warnings, []);
  ok('example mapping: 52% used, no problems, nothing to report');

  const hanging = M.analyze(proj([slice('s', rect(0, 0, 400, 400), rect(0, 800, 400, 400))]));
  assert.strictEqual(hanging.outside.length, 1);
  assert.strictEqual(hanging.outside[0].side, 'output');
  assert.strictEqual(hanging.outside[0].pct, 50);
  assert.deepStrictEqual(hanging.outside[0].rects, [rect(0, 1000, 400, 200)]);
  assert.strictEqual(hanging.usedPct, 8, 'only the part on the screen counts as used');
  ok('slice past the screen edge reported with the part outside');

  const bothOff = M.analyze(proj([slice('s', rect(900, 0, 200, 100), rect(0, 0, 200, 100))]));
  assert.strictEqual(bothOff.outside.length, 1);
  assert.strictEqual(bothOff.outside[0].side, 'input');
  assert.strictEqual(bothOff.outside[0].pct, 50);
  const gone = M.analyze(proj([slice('s', rect(2000, 0, 100, 100), rect(0, 0, 100, 100))]));
  assert(gone.outside[0].dropped && /left out of the export/.test(gone.outside[0].message), JSON.stringify(gone.outside));
  ok('slice past the input canvas reported, also when it drops out of the export');

  const off = M.analyze(proj([slice('s', rect(2000, 0, 100, 100), rect(0, 0, 100, 100), { enabled: false })]));
  assert.strictEqual(off.problems, 0);
  ok('disabled slices are not problems');

  const twice = M.analyze(proj([
    slice('a1', rect(0, 0, 100, 100), rect(0, 0, 100, 100)),
    slice('a2', rect(0, 0, 100, 100), rect(50, 50, 100, 100)),
  ]));
  assert.strictEqual(twice.overlaps.length, 1, 'the same input twice is fine, the overlap on the output is not');
  assert.deepStrictEqual(twice.overlaps[0].rects, [rect(50, 50, 50, 50)]);
  const screens = [{ id: 'a', name: 'A', width: 500, height: 500 }, { id: 'b', name: 'B', width: 500, height: 500 }];
  const perScreen = M.analyze(proj([
    slice('a1', rect(0, 0, 100, 100), rect(0, 0, 100, 100)),
    slice('b1', rect(0, 0, 100, 100), rect(0, 0, 100, 100), { screenId: 'b' }),
  ], screens));
  assert.strictEqual(perScreen.overlaps.length, 0, 'overlap counts per screen');
  ok('overlap counts on the output only, per screen');

  const poly = { enabled: true, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] };
  const masked = M.analyze(proj([
    slice('a1', rect(0, 0, 100, 100), rect(0, 0, 100, 100), { mask: poly }),
    slice('a2', rect(0, 0, 100, 100), rect(0, 0, 100, 100)),
  ]));
  assert.strictEqual(masked.overlaps.length, 0, 'a polygon mask is left out of the overlap count');
  ok('polygon-masked slices do not count as overlap by bounding box');

  const input = { width: 630, height: 64 };
  assert.strictEqual(M.footageStretched({ width: 630, height: 64 }, input, {}), false);
  assert.strictEqual(M.footageStretched({ width: 640, height: 64 }, input, { mode: 'stretch', scale: 100, scaleY: null }), true);
  assert.strictEqual(M.footageStretched({ width: 640, height: 64 }, input, { mode: 'fit', scale: 100 }), false, 'fit is a choice');
  assert.strictEqual(M.footageStretched({ width: 640, height: 64 }, input, { mode: 'stretch', scale: 50 }), false, 'a set scale is a choice');
  assert.strictEqual(M.footageStretched(null, input, {}), false);
  ok('footage of another size only warned about when nobody chose how to fit it');

  const odd = { probe: { width: 640, height: 64 }, transform: {} };
  const canvasSize = { width: 640, height: 64 };
  assert.strictEqual(M.canvasFitsAll([odd, { probe: { width: 640, height: 64 }, transform: {} }], canvasSize), true, 'same size');
  assert.strictEqual(M.canvasFitsAll([odd, { probe: { width: 630, height: 64 }, transform: {} }], canvasSize), false, 'a file that matches the old canvas would now be resized');
  assert.strictEqual(M.canvasFitsAll([odd, { probe: null, transform: {} }], canvasSize), true, 'unknown size');
  assert.strictEqual(M.canvasFitsAll([odd, { probe: { width: 630, height: 64 }, transform: { mode: 'fit', scale: 100 } }], canvasSize), true, 'fit is a choice');
  ok('the canvas is only offered as the fix when no selected file would be resized by it');

  const roundTrip = R.parseScreenSetup(R.exportScreenSetup(example));
  assert.deepStrictEqual(roundTrip.warnings, [], "the exporter's rounded grid is no warp");
  const base = R.exportScreenSetup({ name: 'x', input: { width: 1000, height: 500 }, screens: [{ id: 'a', name: 'A', width: 1000, height: 500 }], slices: [
    slice('Part 1', rect(0, 0, 1000, 500), rect(0, 0, 1000, 500), { mask: { enabled: true, points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }] } }),
  ] });
  const parseOf = (xml) => R.parseScreenSetup(xml).warnings;
  assert.deepStrictEqual(parseOf(base), []);
  const homography = base.replace(/(<dst>\s*<v x="0" y="0"\/>\s*<v x=")1000/, '$1900');
  assert.notStrictEqual(homography, base);
  assert(parseOf(homography).some((w) => /Warp ignored on 1 slice \(Part 1\)/.test(w)), 'homography');
  const bezier = base.replace(/(<vertices>\s*<v x=")0/, '$180');
  assert.notStrictEqual(bezier, base);
  assert(parseOf(bezier).some((w) => /Warp ignored/.test(w)), 'bezier');
  const invert = base.replace('name="Invert" default="1" value="1"', 'name="Invert" default="1" value="0"');
  assert(parseOf(invert).some((w) => /"Invert" differs/.test(w)), 'invert');
  const skewed = base.replace(/(<OutputRect[^>]*>\s*<v x="0" y="0"\/>\s*<v x=")1000/, '$1950');
  assert(parseOf(skewed).some((w) => /Non-rectangular shape on 1 slice/.test(w)), 'skewed rect');
  ok('XML import lists warps, skewed rects and the mask setting, and only those');

  const full = Hippo.parseCsv('0,0,100,100,0,False,False,0,0,100,100,0,255,255,255,0');
  assert.deepStrictEqual(full.warnings, []);
  const dim = Hippo.parseCsv('0,0,100,100,0,False,False,0,0,100,100,0,128,255,255,4');
  assert(dim.warnings.some((w) => /1 tile has a colour level below 255 \(Tile 4: R128 G255 B255\)/.test(w)), JSON.stringify(dim.warnings));
  ok('CSV import lists colour levels under 255');
}

module.exports = { run };
