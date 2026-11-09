'use strict';
// Mapping editor: split maths, mask clipping, mouse wheel detection.
const assert = require('assert');
const E = require('../src/shared/mapedit');
const Geometry = require('../src/shared/geometry');

const CANVAS = { w: 3840, h: 2160 };

function run(ok) {
  console.log('Mapping editor');

  assert.strictEqual(E.partWidth(3840, 104), 3744);
  assert.strictEqual(E.partWidth(3840, 0), 3840);
  assert.strictEqual(E.partWidth(100, 104), 0, 'a panel wider than the space gives no part');
  assert.deepStrictEqual(E.cutWidths(10400, 3744), [3744, 3744, 2912]);
  assert.deepStrictEqual(E.cutWidths(7488, 3744), [3744, 3744], 'an exact fit has no extra part');
  ok('split: part width rounds down to whole panels');

  const wall = E.layout({ totalW: 10400, rowH: 416, partW: 3744, panelW: 104, canvas: CANVAS });
  assert(wall.fits);
  assert.deepStrictEqual(wall.panels, [36, 36, 28]);
  assert.deepStrictEqual(wall.rects[2], { x: 0, y: 832, w: 2912, h: 416 });
  assert.strictEqual(E.summary(wall, CANVAS), '3 rows of 36 / 36 / 28 panels, fits on 3840×2160');
  const plain = E.layout({ totalW: 10400, rowH: 416, partW: 3840, canvas: CANVAS });
  assert.strictEqual(E.summary(plain, CANVAS), '3 rows: 2 × 3840 + 1 × 2720 px, fits on 3840×2160');
  ok('split: rows and summary of a 10400 wall');

  const tall = E.layout({ totalW: 10400, rowH: 1000, partW: 3744, canvas: CANVAS });
  assert(!tall.fits && tall.bottom === 3000);
  assert(/^Does not fit/.test(E.summary(tall, CANVAS)));
  assert(!E.layout({ totalW: 10400, rowH: 416, partW: 3744, startY: 1000, canvas: CANVAS }).fits, 'Start Y counts');
  assert(!E.layout({ totalW: 3000, rowH: 416, partW: 3000, startX: -1, canvas: CANVAS }).fits, 'a negative start does not fit');
  assert(!E.layout({ totalW: 5000, rowH: 416, partW: 5000, canvas: CANVAS }).fits, 'too wide does not fit');
  assert(!E.layout({ totalW: 10400, rowH: 416, partW: 0, canvas: CANVAS }).fits, 'no part width');
  const many = E.layout({ totalW: 32768, rowH: 1, partW: 1, canvas: { w: 32768, h: 32768 } });
  assert(many.tooMany && !many.fits && !many.rects.length);
  ok('split: rows that do not fit are refused, Start Y included');

  const quarter = E.layout({ totalW: 3000, rowH: 200, partW: 1500, canvas: { w: 1920, h: 1500 }, quarter: true });
  assert(quarter.fits);
  assert.deepStrictEqual(quarter.rects[1], { x: 200, y: 0, w: 200, h: 1500 });
  assert(/^2 columns/.test(E.summary(quarter, { w: 1920, h: 1500 })));
  ok('split: a quarter turn stands the parts next to each other');

  let n = 0;
  const id = () => 'p' + n++;
  const scaled = { id: 's', name: 'Wall', screenId: 'a', enabled: true, inOrient: 0, outOrient: 180, flip: 3, mask: null, in: { x: 100, y: 50, w: 10400, h: 416 }, out: { x: 7, y: 8, w: 3840, h: 154 } };
  const parts = E.splitSlice(scaled, wall, id);
  assert.strictEqual(parts.length, 3);
  assert.deepStrictEqual(parts.map((p) => p.in.x), [100, 3844, 7588], 'parts follow on in the input');
  assert.strictEqual(parts.reduce((a, p) => a + p.in.w, 0), 10400);
  parts.forEach((p, i) => {
    assert.strictEqual(p.outOrient, 180);
    assert.strictEqual(p.flip, 3);
    assert.strictEqual(p.screenId, 'a');
    assert.deepStrictEqual({ w: p.out.w, h: p.out.h }, { w: p.in.w, h: p.in.h }, 'a scaled slice comes out 1:1');
    assert.strictEqual(p.name, `Wall ${i + 1}/3`);
  });
  assert.deepStrictEqual(new Set(parts.map((p) => p.id)).size, 3);
  ok('split: rotation, flip and screen stay, the input stays continuous');

  const tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.deepStrictEqual(E.clipPolygon(tri, { x: 0, y: 0, w: 100, h: 100 }), tri, 'inside stays the same');
  const half = E.clipPolygon([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }], { x: 0, y: 0, w: 100, h: 100 });
  assert(Geometry.maskIsRect({ points: half }) && Geometry.maskBBox({ points: half }).w === 100);
  assert.strictEqual(E.clipPolygon(tri, { x: 500, y: 500, w: 10, h: 10 }), null);
  const sloped = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 101 }, { x: 0, y: 1 }];
  const left = E.clipPolygon(sloped, { x: 0, y: 0, w: 100, h: 200 });
  const right = E.clipPolygon(sloped, { x: 100, y: 0, w: 200, h: 200 });
  assert(Number.isInteger(left.find((p) => p.x === 100 && p.y > 0).y), 'crossing points are whole pixels');
  assert.strictEqual(left.find((p) => p.x === 100 && p.y > 0).y, right.find((p) => p.x === 100 && p.y > 0).y, 'both sides of a cut meet');
  ok('mask: clipping a polygon to a part');

  const masked = Object.assign({}, scaled, { outOrient: 0, flip: 0, in: { x: 0, y: 0, w: 9000, h: 416 }, out: { x: 0, y: 0, w: 9000, h: 416 },
    mask: { enabled: true, points: [{ x: 10, y: 10 }, { x: 5000, y: 10 }, { x: 5000, y: 400 }, { x: 10, y: 400 }] } });
  const l2 = E.layout({ totalW: 9000, rowH: 416, partW: 3744, canvas: CANVAS });
  const mp = E.splitSlice(masked, l2, id);
  assert.deepStrictEqual(Geometry.maskBBox(mp[0].mask), { x: 10, y: 10, w: 3734, h: 390 });
  assert.deepStrictEqual(Geometry.maskBBox(mp[1].mask), { x: 3744, y: 10, w: 1256, h: 390 });
  assert(mp[2].mask === null && mp[2].enabled === false, 'a part outside the mask stays dark');
  assert.strictEqual(E.partsOutsideMask(masked, l2), 1);
  const switchedOff = E.splitSlice(Object.assign({}, masked, { mask: Object.assign({}, masked.mask, { enabled: false }) }), l2, id);
  assert(switchedOff[0].mask.enabled === false, 'a switched-off mask stays off but keeps its points');
  assert(switchedOff[2].enabled === true, 'a switched-off mask hides nothing');
  ok('split: a mask is cut along, parts outside it start switched off');

  const notch = { deltaX: 0, deltaY: -100, wheelDeltaY: 120, deltaMode: 0 };
  assert(E.isMouseWheel(notch, false), 'Windows notch');
  assert(E.isMouseWheel({ deltaX: 0, deltaY: 3, wheelDeltaY: -120, deltaMode: 1 }, false), 'line mode');
  assert(!E.isMouseWheel({ deltaX: 0, deltaY: 4, wheelDeltaY: -12, deltaMode: 0 }, true), 'Mac trackpad: wheelDeltaY is -3 × deltaY');
  assert(!E.isMouseWheel({ deltaX: 0, deltaY: 33.4, wheelDeltaY: -100, deltaMode: 0 }, true), 'Mac trackpad with a fraction');
  assert(E.isMouseWheel({ deltaX: 0, deltaY: 4.2, wheelDeltaY: -120, deltaMode: 0 }, true), 'Mac mouse');
  assert(!E.isMouseWheel({ deltaX: 0, deltaY: 7, wheelDeltaY: -13, deltaMode: 0 }, false), 'Windows touchpad');
  assert(!E.isMouseWheel({ deltaX: 100, deltaY: 0, wheelDeltaY: 0, deltaMode: 0 }, false), 'Shift+wheel pans sideways');
  const shiftNotch = { shiftKey: true, deltaX: 0, deltaY: 100, wheelDeltaY: -120, deltaMode: 0 };
  assert(!E.isMouseWheel(shiftNotch, false), 'Shift+wheel with the delta still on deltaY does not zoom');
  assert(!E.isMouseWheel(shiftNotch, true), 'Shift+wheel does not zoom on macOS either');
  assert.deepStrictEqual(E.panDelta(shiftNotch), { x: 100, y: 0 }, 'Shift+wheel moves sideways by deltaY');
  assert.deepStrictEqual(E.panDelta({ shiftKey: true, deltaX: 100, deltaY: 0 }), { x: 100, y: 0 }, 'Shift+wheel when Chromium already swapped the axis');
  assert.deepStrictEqual(E.panDelta({ shiftKey: false, deltaX: 3, deltaY: 7 }), { x: 3, y: 7 }, 'a plain pan keeps both axes');
  assert(E.isMouseWheel({ deltaX: 0, deltaY: 40, wheelDeltaY: -120, deltaMode: 0 }, false), 'Windows notch at a high display scale');
  assert(!E.isMouseWheel({ deltaX: 0, deltaY: 40, wheelDeltaY: -120, deltaMode: 0 }, true), 'the same numbers are a trackpad on macOS');
  for (const isMac of [false, true]) {
    const name = isMac ? ' (macOS)' : ' (Windows)';
    assert(!E.isMouseWheel({ ctrlKey: true, deltaX: 0, deltaY: -1.3, wheelDeltaY: 120, deltaMode: 0 }, isMac), 'touchpad pinch out is not a notch' + name);
    assert(!E.isMouseWheel({ ctrlKey: true, deltaX: 0, deltaY: 2.4, wheelDeltaY: -120, deltaMode: 0 }, isMac), 'touchpad pinch in is not a notch' + name);
    assert(E.isMouseWheel({ ctrlKey: true, deltaX: 0, deltaY: -100, wheelDeltaY: 120, deltaMode: 0 }, isMac), 'Ctrl+mouse notch keeps zooming per notch' + name);
    assert(E.isMouseWheel({ ctrlKey: true, deltaX: 0, deltaY: 3, wheelDeltaY: -120, deltaMode: 1 }, isMac), 'Ctrl+wheel in line mode is a notch' + name);
  }
  assert(E.isMouseWheel({ ctrlKey: true, deltaX: 0, deltaY: 40, wheelDeltaY: -120, deltaMode: 0 }, false), 'Ctrl+notch at a high display scale');
  assert(Math.abs(E.notchFactor(notch) - 1.25) < 1e-9);
  assert(Math.abs(E.notchFactor({ deltaY: -100, wheelDeltaY: 120, deltaMode: 0 }) - 1.25) < 1e-9, 'away from you zooms in');
  assert(Math.abs(E.notchFactor({ deltaY: 100, wheelDeltaY: -120, deltaMode: 0 }) - 0.8) < 1e-9, 'towards you zooms out');
  ok('wheel: a real mouse zooms, a trackpad pans');
}

module.exports = { run };
