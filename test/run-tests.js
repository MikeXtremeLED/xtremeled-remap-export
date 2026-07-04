'use strict';
// Tests: Resolume XML import (incl. mask -> sub-slice), round-trip export, en een echte ffmpeg render.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = require('../src/shared/resolume');
const render = require('../src/main/render');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓ ' + name);
}

// ---------- 1) import van het echte voorbeeldbestand ----------
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
assert.deepStrictEqual(p.slices[0].in, { x: 0, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(p.slices[0].out, { x: 0, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(p.slices[1].in, { x: 3744, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(p.slices[1].out, { x: 0, y: 416, w: 3744, h: 416 });
assert.deepStrictEqual(p.slices[2].in, { x: 7488, y: 0, w: 2912, h: 416 });
assert.deepStrictEqual(p.slices[2].out, { x: 0, y: 832, w: 2912, h: 416 });
ok('masks correct omgerekend naar sub-slices');

// ---------- 2) round-trip export ----------
console.log('Test 2: XML export round-trip');
const exported = R.exportScreenSetup(p);
const p2 = R.parseScreenSetup(exported);
assert.strictEqual(p2.input.width, p.input.width);
assert.strictEqual(p2.output.width, p.output.width);
assert.strictEqual(p2.slices.length, p.slices.length);
p.slices.forEach((s, i) => {
  assert.deepStrictEqual(p2.slices[i].in, s.in, `slice ${i} input rect`);
  assert.deepStrictEqual(p2.slices[i].out, s.out, `slice ${i} output rect`);
  assert.strictEqual(p2.slices[i].name, s.name, `slice ${i} naam`);
});
ok('export -> import geeft identieke mapping');

// ---------- 3) render test (foto -> 1s ProRes) ----------
console.log('Test 3: ffmpeg render (ProRes HQ)');
const caps = render.getCapabilities();
assert(caps.proresPath, 'ffmpeg met prores_ks gevonden');
ok(`ffmpeg gevonden: ${caps.proresPath} (DXV: ${caps.hasDxv ? 'ja' : 'nee'})`);

const tmp = os.tmpdir();
const srcPng = path.join(tmp, 'xre-test-src.png');
const outMov = path.join(tmp, 'xre-test-out.mov');
const gen = spawnSync(caps.proresPath, [
  '-y', '-hide_banner',
  '-f', 'lavfi', '-i', 'testsrc2=size=1040x42:rate=1:duration=1',
  '-frames:v', '1', srcPng,
], { encoding: 'utf8', timeout: 60000 });
assert.strictEqual(gen.status, 0, 'testbron genereren:\n' + gen.stderr);
ok('testbron 1040x42 gegenereerd');

const job = { src: srcPng, isImage: true, outPath: outMov };
const { args } = render.buildArgs(p, job, { codec: 'prores', fps: 10, imageDuration: 1 }, null);
const run = spawnSync(caps.proresPath, args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(run.status, 0, 'render:\n' + (run.stderr || '').slice(-2000));
ok('render voltooid');

const probe = spawnSync(caps.proresPath, ['-hide_banner', '-i', outMov], { encoding: 'utf8', timeout: 30000 });
const info = (probe.stderr || '') + (probe.stdout || '');
assert(/3840x2160/.test(info), 'output is 3840x2160:\n' + info);
assert(/prores/i.test(info), 'output is prores:\n' + info);
ok('output .mov is 3840x2160 ProRes');

fs.unlinkSync(srcPng);
fs.unlinkSync(outMov);

console.log(`\nALLE ${passed} CHECKS GESLAAGD`);
