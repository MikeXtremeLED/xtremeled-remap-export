'use strict';
// Tests: Resolume XML import (masks/orientation/flip preserved), round-trip export,
// effective slice geometry, and real ffmpeg renders (ProRes / DXV3 / PNG / transform).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = require('../src/shared/resolume');
const G = require('../src/shared/geometry');
const render = require('../src/main/render');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓ ' + name);
}

// ---------- 1) import of the real example file ----------
console.log('Test 1: Resolume XML import');
const xmlPath = path.join(__dirname, '../examples/50x2m-100m2-P4.81-hanging.xml');
const xml = fs.readFileSync(xmlPath, 'utf8');
const p = R.parseScreenSetup(xml);

assert.strictEqual(p.input.width, 10400);
assert.strictEqual(p.input.height, 416);
ok('input canvas 10400x416');
assert.strictEqual(p.output.width, 3840);
assert.strictEqual(p.output.height, 2160);
ok('output canvas 3840x2160');
assert.strictEqual(p.slices.length, 3);
ok('3 slices');

// masks are preserved as first-class data (like Resolume)
assert.deepStrictEqual(p.slices[0].in, { x: 0, y: 0, w: 10400, h: 416 });
assert.deepStrictEqual(p.slices[0].out, { x: 0, y: 0, w: 10400, h: 416 });
assert.deepStrictEqual(p.slices[0].mask, { enabled: true, x: 0, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(p.slices[1].out, { x: -3744, y: 416, w: 10400, h: 416 });
assert.deepStrictEqual(p.slices[1].mask, { enabled: true, x: 3744, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(p.slices[2].mask, { enabled: true, x: 7488, y: 0, w: 2912, h: 416 });
ok('input masks preserved from XML');

// ---------- 2) effective geometry (mask -> crop/place) ----------
console.log('Test 2: effective slice geometry');
const eff = G.effectiveSlices(p);
assert.strictEqual(eff.length, 3);
assert.deepStrictEqual(eff[0].crop, { x: 0, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(eff[0].place, { x: 0, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(eff[1].crop, { x: 3744, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(eff[1].place, { x: 0, y: 416, w: 3744, h: 416 });
assert.deepStrictEqual(eff[2].crop, { x: 7488, y: 0, w: 2912, h: 416 });
assert.deepStrictEqual(eff[2].place, { x: 0, y: 832, w: 2912, h: 416 });
ok('masked slices map to the same rows as Resolume');

// rotation mapping sanity: 90° net rotation swaps axes
const rotProj = {
  input: { width: 100, height: 100 },
  output: { width: 100, height: 100 },
  slices: [{ id: 'r', enabled: true, in: { x: 0, y: 0, w: 100, h: 100 }, out: { x: 0, y: 0, w: 100, h: 100 }, inOrient: 0, outOrient: 90, flip: 0, mask: { enabled: true, x: 0, y: 0, w: 50, h: 100 } }],
};
const rotEff = G.effectiveSlices(rotProj)[0];
assert.strictEqual(rotEff.rot, 90);
// left half of input rotates to top half of output
assert.deepStrictEqual(rotEff.place, { x: 0, y: 0, w: 100, h: 50 });
ok('90° rotation maps mask correctly');

// ---------- 3) round-trip export ----------
console.log('Test 3: XML export round-trip');
p.slices[1].flip = 1;
p.slices[1].outOrient = 180;
const exported = R.exportScreenSetup(p);
const p2 = R.parseScreenSetup(exported);
assert.strictEqual(p2.input.width, p.input.width);
assert.strictEqual(p2.slices.length, p.slices.length);
p.slices.forEach((s, i) => {
  assert.deepStrictEqual(p2.slices[i].in, s.in, `slice ${i} input rect`);
  assert.deepStrictEqual(p2.slices[i].out, s.out, `slice ${i} output rect`);
  assert.deepStrictEqual(p2.slices[i].mask, s.mask, `slice ${i} mask`);
  assert.strictEqual(p2.slices[i].flip, s.flip || 0, `slice ${i} flip`);
  assert.strictEqual(p2.slices[i].outOrient, s.outOrient || 0, `slice ${i} orientation`);
});
p.slices[1].flip = 0;
p.slices[1].outOrient = 0;
ok('export -> import preserves rects, masks, flip and rotation');

// ---------- 4) render test (footage still -> 1s ProRes) ----------
console.log('Test 4: ffmpeg render (ProRes HQ)');
const caps = render.getCapabilities();
assert(caps.proresPath, 'ffmpeg with prores_ks found');
ok(`ffmpeg found (DXV: ${caps.hasDxv ? 'yes' : 'no'})`);

const tmp = os.tmpdir();
const srcPng = path.join(tmp, 'xre-test-src.png');
const outMov = path.join(tmp, 'xre-test-out.mov');
const gen = spawnSync(caps.proresPath, [
  '-y', '-hide_banner',
  '-f', 'lavfi', '-i', 'testsrc2=size=1040x42:rate=1:duration=1',
  '-frames:v', '1', srcPng,
], { encoding: 'utf8', timeout: 60000 });
assert.strictEqual(gen.status, 0, 'generate test source:\n' + gen.stderr);
ok('test source 1040x42 generated');

const job = { src: srcPng, isImage: true, outPath: outMov };
const { args } = render.buildArgs(p, job, { codec: 'prores', fps: 10, imageDuration: 1 }, null);
const run = spawnSync(caps.proresPath, args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(run.status, 0, 'render:\n' + (run.stderr || '').slice(-2000));
const probe = spawnSync(caps.proresPath, ['-hide_banner', '-i', outMov], { encoding: 'utf8', timeout: 30000 });
const info = (probe.stderr || '') + (probe.stdout || '');
assert(/3840x2160/.test(info) && /prores/i.test(info), 'output is 3840x2160 ProRes:\n' + info);
ok('output .mov is 3840x2160 ProRes');

// ---------- 5) DXV3 render ----------
console.log('Test 5: ffmpeg render (DXV3)');
assert(caps.hasDxv, 'ffmpeg with dxv encoder found (bin/ffmpeg-dxv)');
const outDxv = path.join(tmp, 'xre-test-out-dxv.mov');
const dxvBuild = render.buildArgs(p, { src: srcPng, isImage: true, outPath: outDxv }, { codec: 'dxv', fps: 10, imageDuration: 1 }, null);
const runDxv = spawnSync(caps.dxvPath, dxvBuild.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(runDxv.status, 0, 'dxv render:\n' + (runDxv.stderr || '').slice(-2000));
const probeDxv = spawnSync(caps.dxvPath, ['-hide_banner', '-i', outDxv], { encoding: 'utf8', timeout: 30000 });
const infoDxv = (probeDxv.stderr || '') + (probeDxv.stdout || '');
assert(/dxv/i.test(infoDxv) && /3840x2160/.test(infoDxv), 'output is 3840x2160 DXV:\n' + infoDxv);
ok('output .mov is 3840x2160 DXV3');

// ---------- 6) PNG still export ----------
console.log('Test 6: PNG still export');
const outPng = path.join(tmp, 'xre-test-out.png');
const pngBuild = render.buildArgs(p, { src: srcPng, isImage: true, outPath: outPng }, { codec: 'png' }, null);
const runPng = spawnSync(caps.proresPath, pngBuild.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(runPng.status, 0, 'png render:\n' + (runPng.stderr || '').slice(-2000));
const probePng = spawnSync(caps.proresPath, ['-hide_banner', '-i', outPng], { encoding: 'utf8', timeout: 30000 });
const infoPng = (probePng.stderr || '') + (probePng.stdout || '');
assert(/png/i.test(infoPng) && /3840x2160/.test(infoPng), 'output is 3840x2160 PNG:\n' + infoPng);
ok('output .png is 3840x2160');

// ---------- 7) render with clip transform + adjustments ----------
console.log('Test 7: render with clip transform');
const outTr = path.join(tmp, 'xre-test-out-tr.mov');
const trJob = {
  src: srcPng,
  isImage: true,
  outPath: outTr,
  transform: { mode: 'fit', scale: 90, x: 20, y: 5, rotation: 12, brightness: 0.1, contrast: 0.05, saturation: 1.2, hue: 30, blur: 2 },
};
const trProbe = render.probeMedia(caps.proresPath, srcPng);
assert.strictEqual(trProbe.width, 1040);
assert.strictEqual(trProbe.height, 42);
ok('probe reads source resolution');
const trBuild = render.buildArgs(p, trJob, { codec: 'prores', fps: 10, imageDuration: 1 }, trProbe);
assert(/rotate=/.test(trBuild.args.join(' ')) && /eq=/.test(trBuild.args.join(' ')), 'transform filters in graph');
const runTr = spawnSync(caps.proresPath, trBuild.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(runTr.status, 0, 'transform render:\n' + (runTr.stderr || '').slice(-2000));
const probeTr = spawnSync(caps.proresPath, ['-hide_banner', '-i', outTr], { encoding: 'utf8', timeout: 30000 });
assert(/3840x2160/.test((probeTr.stderr || '')), 'transform output is 3840x2160');
ok('render with position/scale/rotation/color adjustments works');

// ---------- 8) frame extraction (render page preview) ----------
console.log('Test 8: preview frame extraction');
const frame = render.extractFrame(srcPng, 0);
assert(frame.startsWith('data:image/png;base64,') && frame.length > 1000, 'frame dataURL');
ok('preview frame extracted as PNG dataURL');

[srcPng, outMov, outDxv, outPng, outTr].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });

console.log(`\nALL ${passed} CHECKS PASSED`);
