'use strict';
// Tests: Resolume XML and Hippotizer VideoMapper CSV import/export,
// slice geometry, codec matrix and real ffmpeg renders.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = require('../src/shared/resolume');
const Hippo = require('../src/shared/hippo');
const G = require('../src/shared/geometry');
const Codecs = require('../src/shared/codecs');
const render = require('../src/main/render');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓ ' + name);
}
function probeInfo(ff, file) {
  const r = spawnSync(ff, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 30000 });
  return (r.stderr || '') + (r.stdout || '');
}
function meanLuma(ff, file) {
  const r = spawnSync(ff, ['-hide_banner', '-i', file, '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000 });
  const m = ((r.stdout || '') + (r.stderr || '')).match(/YAVG=([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

// ---------- 1) import of the real example file ----------
console.log('Test 1: Resolume XML import');
const xmlPath = path.join(__dirname, '../examples/50x2m-100m2-P4.81-hanging.xml');
const xml = fs.readFileSync(xmlPath, 'utf8');
const p = R.parseScreenSetup(xml);

assert.strictEqual(p.input.width, 10400);
assert.strictEqual(p.input.height, 416);
ok('input canvas 10400x416');
assert.strictEqual(p.screens.length, 1);
assert.strictEqual(p.screens[0].width, 3840);
assert.strictEqual(p.screens[0].height, 2160);
ok('screen 3840x2160');
assert.strictEqual(p.slices.length, 3);
assert.deepStrictEqual(p.slices[0].in, { x: 0, y: 0, w: 10400, h: 416 });
assert.deepStrictEqual(p.slices[1].out, { x: -3744, y: 416, w: 10400, h: 416 });
assert.strictEqual(p.slices[0].mask.enabled, true);
assert.deepStrictEqual(G.maskBBox(p.slices[0].mask), { x: 0, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(G.maskBBox(p.slices[1].mask), { x: 3744, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(G.maskBBox(p.slices[2].mask), { x: 7488, y: 0, w: 2912, h: 416 });
ok('polygon masks preserved from XML (as key points)');

// ---------- 2) effective geometry ----------
console.log('Test 2: effective slice geometry');
const eff = G.effectiveSlices(p, p.screens[0].id);
assert.strictEqual(eff.length, 3);
assert.deepStrictEqual(eff[0].crop, { x: 0, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(eff[0].place, { x: 0, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(eff[1].crop, { x: 3744, y: 0, w: 3744, h: 416 });
assert.deepStrictEqual(eff[1].place, { x: 0, y: 416, w: 3744, h: 416 });
assert.deepStrictEqual(eff[2].place, { x: 0, y: 832, w: 2912, h: 416 });
assert.strictEqual(eff[0].polyMask, false, 'rect masks use the fast crop path');
ok('masked slices map to the same rows as Resolume');

const rotProj = {
  input: { width: 100, height: 100 },
  screens: [{ id: 'sA', name: 'A', width: 100, height: 100 }],
  slices: [{ id: 'r', enabled: true, screenId: 'sA', in: { x: 0, y: 0, w: 100, h: 100 }, out: { x: 0, y: 0, w: 100, h: 100 }, inOrient: 0, outOrient: 90, flip: 0, mask: { enabled: true, points: G.rectToPoints({ x: 0, y: 0, w: 50, h: 100 }) } }],
};
const rotEff = G.effectiveSlices(rotProj)[0];
assert.strictEqual(rotEff.rot, 90);
assert.deepStrictEqual(rotEff.place, { x: 0, y: 0, w: 100, h: 50 });
ok('90° rotation maps mask correctly');

// non-rect polygon detected
const triProj = JSON.parse(JSON.stringify(rotProj));
triProj.slices[0].mask = { enabled: true, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }] };
triProj.slices[0].outOrient = 0;
assert.strictEqual(G.effectiveSlices(triProj)[0].polyMask, true);
ok('triangle mask flagged for raster path');

// ---------- 3) round-trip export ----------
console.log('Test 3: XML export round-trip');
p.slices[1].flip = 1;
p.slices[1].outOrient = 180;
p.slices[2].mask.points.push({ x: 9000, y: 200 }); // make it a polygon
const exported = R.exportScreenSetup(p);
const p2 = R.parseScreenSetup(exported);
assert.strictEqual(p2.screens.length, p.screens.length);
assert.strictEqual(p2.slices.length, p.slices.length);
p.slices.forEach((s, i) => {
  assert.deepStrictEqual(p2.slices[i].in, s.in, `slice ${i} input rect`);
  assert.deepStrictEqual(p2.slices[i].out, s.out, `slice ${i} output rect`);
  assert.deepStrictEqual(p2.slices[i].mask.points, s.mask.points, `slice ${i} mask points`);
  assert.strictEqual(p2.slices[i].flip, s.flip || 0, `slice ${i} flip`);
  assert.strictEqual(p2.slices[i].outOrient, s.outOrient || 0, `slice ${i} orientation`);
});
p.slices[1].flip = 0;
p.slices[1].outOrient = 0;
p.slices[2].mask.points.pop();
ok('export -> import preserves rects, polygon masks, flip and rotation');

// multi-screen round trip
const msProj = {
  name: 'multi', input: { width: 1000, height: 500 },
  screens: [
    { id: 'a', name: 'Main LED', width: 1920, height: 1080 },
    { id: 'b', name: 'DJ Booth', width: 800, height: 600 },
  ],
  slices: [
    { id: 's1', name: 'S1', enabled: true, screenId: 'a', in: { x: 0, y: 0, w: 500, h: 500 }, out: { x: 0, y: 0, w: 500, h: 500 }, inOrient: 0, outOrient: 0, flip: 0, mask: null },
    { id: 's2', name: 'S2', enabled: true, screenId: 'b', in: { x: 500, y: 0, w: 500, h: 500 }, out: { x: 0, y: 0, w: 800, h: 600 }, inOrient: 0, outOrient: 0, flip: 0, mask: null },
  ],
};
const ms2 = R.parseScreenSetup(R.exportScreenSetup(msProj));
assert.strictEqual(ms2.screens.length, 2);
assert.strictEqual(ms2.screens[1].name, 'DJ Booth');
assert.strictEqual(ms2.screens[1].width, 800);
assert.strictEqual(ms2.slices.filter((s) => s.screenId === ms2.screens[1].id).length, 1);
ok('multi-screen export/import');

// ---------- 4) Hippotizer VideoMapper CSV import ----------
console.log('Test 4: Hippotizer VideoMapper CSV import');
const csvExamplePath = path.join(__dirname, '../examples/hippotizer-videomapper-example.csv');
const csvExample = fs.readFileSync(csvExamplePath, 'utf8');
const hp = Hippo.parseCsv(csvExample);

assert.strictEqual(hp.slices.length, 4);
ok('4 tiles imported');
assert.deepStrictEqual(hp.slices[0].in, { x: 0, y: 0, w: 100, h: 100 });
assert.deepStrictEqual(hp.slices[0].out, { x: 100, y: 100, w: 100, h: 100 });
ok('input and output rects read from the right columns');

// The example mapping picture shows tile 1 (rotation 90) with its dark corner
// moving top-left -> top-right, i.e. a clockwise quarter turn. netRotation must
// therefore come out as 90, not 270.
assert.strictEqual(G.netRotation(hp.slices[0]), 90);
assert.strictEqual(G.netRotation(hp.slices[1]), 0);
assert.strictEqual(G.netRotation(hp.slices[2]), 180);
assert.strictEqual(G.netRotation(hp.slices[3]), 270);
ok('rotations map to clockwise quarter turns (90/0/180/270)');

const csvTL = G.inputPointToOutput(hp.slices[0], { x: 0, y: 0 });
assert(Math.abs(csvTL.x - 200) < 0.01 && Math.abs(csvTL.y - 100) < 0.01, 'top-left maps to ' + JSON.stringify(csvTL));
ok('rotation 90 sends the input top-left corner to the output top-right');

// flip is documented on the input tile, so a quarter turn swaps the axis
assert.strictEqual(hp.slices[2].flip, 1, 'flip X at 180 stays X');
assert.strictEqual(hp.slices[3].flip, 1, 'flip Y at 270 becomes X after the turn');
ok('flip columns map through the rotation');

// a CSV carries no canvas, so both are derived from the tile extents
assert.deepStrictEqual(hp.input, { width: 300, height: 200 });
assert.strictEqual(hp.screens[0].width, 400);
assert.strictEqual(hp.screens[0].height, 300);
ok('input canvas and output size derived from the tiles');

// ---------- 5) CSV export round-trip + tolerant parsing ----------
console.log('Test 5: Hippotizer CSV export round-trip');
const csvOut = Hippo.exportCsv(hp, hp.screens[0].id);
assert.strictEqual(csvOut, csvExample.replace(/\r?\n/g, '\r\n').replace(/(\r\n)+$/, '\r\n'));
ok('re-export reproduces the example file byte for byte');

const csvBack = Hippo.parseCsv(csvOut);
assert.strictEqual(csvBack.slices.length, hp.slices.length);
csvBack.slices.forEach((s, i) => {
  assert.deepStrictEqual(s.in, hp.slices[i].in);
  assert.deepStrictEqual(s.out, hp.slices[i].out);
  assert.strictEqual(G.netRotation(s), G.netRotation(hp.slices[i]));
  assert.strictEqual(s.flip, hp.slices[i].flip);
  assert.strictEqual(s.blockIndex, hp.slices[i].blockIndex);
});
ok('import -> export -> import is lossless');

// a real-world export: header row, blank trailing rows and a stray value row
const banners = Hippo.parseCsv(
  fs.readFileSync(path.join(__dirname, '../examples/hippotizer-banners.csv'), 'utf8')
);
assert.strictEqual(banners.slices.length, 4, 'header/blank/stray rows skipped');
assert.deepStrictEqual(banners.slices[3].in, { x: 2304, y: 0, w: 192, h: 1536 });
assert.deepStrictEqual(banners.slices[3].out, { x: 576, y: 0, w: 192, h: 1536 });
assert.strictEqual(banners.input.width, 2496);
assert.strictEqual(banners.screens[0].width, 768);
ok('header row, blank rows and a stray row are skipped (banners.csv)');

// non-quarter rotations are snapped, and said so
const oddRot = Hippo.parseCsv('0,0,100,100,45,False,False,0,0,100,100,0,255,255,255,0');
assert.strictEqual(G.netRotation(oddRot.slices[0]), 90);
assert(oddRot.warnings.some((w) => /90/.test(w)), 'snap reported: ' + JSON.stringify(oddRot.warnings));
ok('a 45 degree rotation is snapped to the nearest quarter turn and reported');

assert.throws(() => Hippo.parseCsv('\n\n,,,\n'), /No usable tile rows/);
ok('an empty CSV is rejected with a clear message');

// ---------- 6) aspect-ratio lock while resizing ----------
console.log('Test 6: aspect-ratio lock');
const ar0 = { x: 100, y: 50, w: 400, h: 200 };
let ar;

ar = G.resizeRect(ar0, 'se', 200, 0, true);
assert.deepStrictEqual(ar, { x: 100, y: 50, w: 600, h: 300 }, JSON.stringify(ar));
ok('corner drag keeps 2:1 and grows both axes');

ar = G.resizeRect(ar0, 'e', 200, 0, true);
assert.deepStrictEqual(ar, { x: 100, y: 50, w: 600, h: 300 }, JSON.stringify(ar));
ok('edge drag keeps the ratio too');

ar = G.resizeRect(ar0, 'nw', -200, 0, true);
assert.deepStrictEqual(ar, { x: -100, y: -50, w: 600, h: 300 }, JSON.stringify(ar));
ok('north-west drag anchors the opposite corner');

ar = G.resizeRect(ar0, 'se', 200, -180, true);
assert.strictEqual(ar.w / ar.h, 2, 'ratio held: ' + JSON.stringify(ar));
ok('the axis dragged furthest wins, the other follows');

ar = G.resizeRect(ar0, 'se', -1000, -1000, true);
assert(ar.w >= 1 && ar.h >= 1, 'stays positive: ' + JSON.stringify(ar));
ok('collapsing past zero clamps without inverting');

ar = G.resizeRect(ar0, 'se', 200, 0, false);
assert.deepStrictEqual(ar, { x: 100, y: 50, w: 600, h: 200 }, JSON.stringify(ar));
ok('unlocked resize is unchanged');

// ---------- 7) ProRes render ----------
console.log('Test 7: ffmpeg render (ProRes HQ)');
const caps = render.getCapabilities();
assert(caps.proresPath, 'ffmpeg found');
ok(`ffmpeg found (DXV ${caps.hasDxv ? '✓' : '✗'}, HAP ${caps.hasHap ? '✓' : '✗'}, x265 ${caps.hasX265 ? '✓' : '✗'})`);

const tmp = os.tmpdir();
const srcPng = path.join(tmp, 'xre-test-src.png');
const gen = spawnSync(caps.proresPath, [
  '-y', '-hide_banner',
  '-f', 'lavfi', '-i', 'testsrc2=size=1040x42:rate=1:duration=1',
  '-frames:v', '1', srcPng,
], { encoding: 'utf8', timeout: 60000 });
assert.strictEqual(gen.status, 0, 'generate test source:\n' + gen.stderr);

const outMov = path.join(tmp, 'xre-test-out.mov');
let b = render.buildArgs(p, { src: srcPng, isImage: true, outPath: outMov }, { codec: 'prores_hq', fps: 10, imageDuration: 1 }, null);
let run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(run.status, 0, 'render:\n' + (run.stderr || '').slice(-2000));
let info = probeInfo(caps.proresPath, outMov);
assert(/3840x2160/.test(info) && /prores/i.test(info));
ok('ProRes HQ 3840x2160');

// same-as-source matching on the ProRes output
const probed = render.probeMedia(caps.proresPath, outMov);
assert.strictEqual(probed.videoCodec, 'prores');
const match = Codecs.matchSource(probed);
assert.strictEqual(match.codec, 'prores_hq', 'HQ variant detected: ' + JSON.stringify(probed));
ok('"same as source" detects ProRes HQ');

// ---------- 8) DXV3 ----------
console.log('Test 8: DXV3');
assert(caps.hasDxv);
const outDxv = path.join(tmp, 'xre-test-dxv.mov');
b = render.buildArgs(p, { src: srcPng, isImage: true, outPath: outDxv }, { codec: 'dxv', fps: 10, imageDuration: 1 }, null);
run = spawnSync(caps.dxvPath, b.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
info = probeInfo(caps.dxvPath, outDxv);
assert(/dxv/i.test(info) && /3840x2160/.test(info));
ok('DXV3 3840x2160');

// ---------- 9) HAP Q ----------
console.log('Test 9: HAP Q');
assert(caps.hasHap, 'hap encoder available');
const outHap = path.join(tmp, 'xre-test-hap.mov');
b = render.buildArgs(p, { src: srcPng, isImage: true, outPath: outHap }, { codec: 'hap_q', fps: 10, imageDuration: 1 }, null);
run = spawnSync(caps.hapPath, b.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
info = probeInfo(caps.hapPath, outHap);
assert(/hap/i.test(info) && /3840x2160/.test(info));
ok('HAP Q 3840x2160');

// ---------- 10) HEVC 10-bit ----------
console.log('Test 10: HEVC 10-bit');
assert(caps.hasX265, 'x265 available');
const outHevc = path.join(tmp, 'xre-test-hevc.mp4');
b = render.buildArgs(p, { src: srcPng, isImage: true, outPath: outHevc }, { codec: 'hevc', depth: 10, bitrateMbps: 8, fps: 5, imageDuration: 1 }, null);
run = spawnSync(caps.x265Path, b.args, { encoding: 'utf8', timeout: 300000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
info = probeInfo(caps.x265Path, outHevc);
assert(/hevc/i.test(info) && /yuv420p10le/.test(info));
ok('HEVC main10 with bitrate');

// ---------- 11) PNG still: not black! ----------
console.log('Test 11: PNG still export');
const outPng = path.join(tmp, 'xre-test-out.png');
b = render.buildArgs(p, { src: srcPng, isImage: true, outPath: outPng }, { codec: 'png', depth: 8 }, null);
run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
info = probeInfo(caps.proresPath, outPng);
assert(/png/i.test(info) && /3840x2160/.test(info));
const luma = meanLuma(caps.proresPath, outPng);
assert(luma !== null && luma > 5, `PNG must not be black (YAVG=${luma})`);
ok(`PNG 3840x2160 with content (YAVG=${luma})`);

// 16-bit PNG
const outPng16 = path.join(tmp, 'xre-test-out16.png');
b = render.buildArgs(p, { src: srcPng, isImage: true, outPath: outPng16 }, { codec: 'png', depth: 16 }, null);
run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
assert(/rgb48/.test(probeInfo(caps.proresPath, outPng16)));
ok('16-bit PNG');

// ---------- 12) PNG sequence with trim ----------
console.log('Test 12: PNG sequence + trim');
const srcVid = path.join(tmp, 'xre-test-vid.mp4');
spawnSync(caps.proresPath, ['-y', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=520x21:rate=10:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', srcVid], { encoding: 'utf8', timeout: 120000 });
const seqDir = path.join(tmp, 'xre-test-seq');
fs.rmSync(seqDir, { recursive: true, force: true });
fs.mkdirSync(seqDir, { recursive: true });
const vidProbe = render.probeMedia(caps.proresPath, srcVid);
b = render.buildArgs(p, { src: srcVid, isImage: false, outPath: path.join(seqDir, 'frame_%05d.png'), inSec: 0.5, outSec: 1.5 }, { codec: 'png_seq', depth: 8 }, vidProbe);
run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 180000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
const frames = fs.readdirSync(seqDir).filter((f) => f.endsWith('.png'));
assert(frames.length >= 9 && frames.length <= 11, `~10 frames for 1s @ 10fps trim, got ${frames.length}`);
ok(`PNG sequence: ${frames.length} frames for 1.0s trim @ 10fps`);

// ---------- 13) video trim to ProRes ----------
console.log('Test 13: trim video render');
const outTrim = path.join(tmp, 'xre-test-trim.mov');
b = render.buildArgs(p, { src: srcVid, isImage: false, outPath: outTrim, inSec: 0.5, outSec: 1.5 }, { codec: 'prores_lt' }, vidProbe);
run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 180000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
info = probeInfo(caps.proresPath, outTrim);
const dm = info.match(/Duration: 00:00:0?(\d+(?:\.\d+)?)/);
assert(dm && Math.abs(parseFloat(dm[1]) - 1) < 0.2, 'trimmed duration ~1s: ' + (dm && dm[1]));
ok('in/out trim gives ~1s ProRes LT');

// PNG still from a VIDEO at a seeked time must not be black (pts offset regression)
const outPngVid = path.join(tmp, 'xre-test-pngvid.png');
b = render.buildArgs(p, { src: srcVid, isImage: false, outPath: outPngVid, pngTime: 1.0 }, { codec: 'png', depth: 8 }, vidProbe);
run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 60000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-1500));
const vidLuma = meanLuma(caps.proresPath, outPngVid);
assert(vidLuma !== null && vidLuma > 5, `PNG from seeked video must not be black (YAVG=${vidLuma})`);
fs.unlinkSync(outPngVid);
ok(`PNG still from video @1.0s has content (YAVG=${vidLuma})`);

// ---------- 14) transform + adjustments ----------
console.log('Test 14: clip transform');
const outTr = path.join(tmp, 'xre-test-tr.mov');
const trProbe = render.probeMedia(caps.proresPath, srcPng);
assert.strictEqual(trProbe.width, 1040);
b = render.buildArgs(
  p,
  { src: srcPng, isImage: true, outPath: outTr, transform: { mode: 'fit', scale: 90, x: 20, y: 5, rotation: 12, brightness: 0.1, contrast: 0.05, saturation: 1.2, hue: 30, blur: 2 } },
  { codec: 'prores_hq', fps: 10, imageDuration: 1 },
  trProbe
);
assert(/rotate=/.test(b.args.join(' ')) && /eq=/.test(b.args.join(' ')));
run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
ok('position/scale/rotation/color adjustments render');

// ---------- 15) multi-screen jobs ----------
console.log('Test 15: multi-screen render');
const outA = path.join(tmp, 'xre-test-scrA.mov');
const outB = path.join(tmp, 'xre-test-scrB.mov');
const srcSq = path.join(tmp, 'xre-test-sq.png');
spawnSync(caps.proresPath, ['-y', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=1000x500:rate=1:duration=1', '-frames:v', '1', srcSq], { encoding: 'utf8', timeout: 60000 });
for (const [scr, out] of [[msProj.screens[0], outA], [msProj.screens[1], outB]]) {
  b = render.buildArgs(msProj, { src: srcSq, isImage: true, outPath: out, screen: scr }, { codec: 'prores_proxy', fps: 5, imageDuration: 1 }, null);
  run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
}
assert(/1920x1080/.test(probeInfo(caps.proresPath, outA)));
assert(/800x600/.test(probeInfo(caps.proresPath, outB)));
ok('per-screen outputs 1920x1080 + 800x600');

// ---------- 16) frame extraction ----------
console.log('Test 16: preview frame extraction');
const frame = render.extractFrame(srcPng, 0);
assert(frame.startsWith('data:image/png;base64,') && frame.length > 1000);
ok('preview frame extracted');

// ---------- 17) separate W/H scale ----------
console.log('Test 17: separate W/H scale');
const layLinked = G.clipLayout(1000, 500, { mode: 'native', scale: 100 }, 2000, 1000);
const layUnlinked = G.clipLayout(1000, 500, { mode: 'native', scale: 100, scaleY: 50 }, 2000, 1000);
assert.strictEqual(Math.round(layLinked.bh), 500);
assert.strictEqual(Math.round(layUnlinked.bh), 250);
assert.strictEqual(Math.round(layUnlinked.bw), 1000);
assert(!G.isIdentityTransform({ mode: 'stretch', scale: 100, scaleY: 50 }));
ok('scaleY scales height independently');

// ---------- 18) merged output (screens side by side) ----------
console.log('Test 18: merged multi-screen output');
const mergedProj = {
  name: 'merged', input: msProj.input,
  screens: [{ id: 'merged', name: 'Merged', width: 1920 + 800, height: 1080 }],
  slices: msProj.slices.map((s, i) => {
    const c = JSON.parse(JSON.stringify(s));
    if (s.screenId === 'b') c.out.x += 1920;
    c.screenId = 'merged';
    return c;
  }),
};
const outMerged = path.join(tmp, 'xre-test-merged.mov');
b = render.buildArgs(mergedProj, { src: srcSq, isImage: true, outPath: outMerged, screen: mergedProj.screens[0] }, { codec: 'prores_proxy', fps: 5, imageDuration: 1 }, null);
run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-2000));
assert(/2720x1080/.test(probeInfo(caps.proresPath, outMerged)));
ok('merged canvas 2720x1080 renders');

// ---------- 19b) WAV audio extract + waveform + channels ----------
console.log('Test 19: WAV audio extract & waveform');
const srcAv = path.join(tmp, 'xre-test-av.mp4');
spawnSync(caps.proresPath, ['-y', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', srcAv], { encoding: 'utf8', timeout: 120000 });
const avProbe = render.probeMedia(caps.proresPath, srcAv);
assert.strictEqual(avProbe.hasAudio, true);
assert.strictEqual(avProbe.audioChannels, 2, 'stereo detected: ' + JSON.stringify(avProbe));
ok('audio channels detected (stereo)');

const outWav = path.join(tmp, 'xre-test-audio.wav');
b = render.buildArgs(p, { src: srcAv, isImage: false, outPath: outWav, inSec: 0.5, outSec: 1.5 }, { codec: 'wav', depth: 24 }, avProbe);
run = spawnSync(caps.proresPath, b.args, { encoding: 'utf8', timeout: 60000 });
assert.strictEqual(run.status, 0, (run.stderr || '').slice(-1500));
const wavInfo = probeInfo(caps.proresPath, outWav);
assert(/pcm_s24le/.test(wavInfo), '24-bit PCM: ' + wavInfo.slice(-400));
const wdm = wavInfo.match(/Duration: 00:00:0?(\d+(?:\.\d+)?)/);
assert(wdm && Math.abs(parseFloat(wdm[1]) - 1) < 0.15, 'trimmed WAV ~1s');
ok('WAV extract 24-bit with in/out trim');

const peaks = render.extractWaveform(srcAv);
assert(
  Array.isArray(peaks) && peaks.length > 100 && Math.max(...peaks) > 0.02,
  `waveform peaks: len=${peaks && peaks.length} max=${peaks && Math.max(...peaks)}`
);
ok(`waveform peaks extracted (${peaks.length} buckets, max ${Math.max(...peaks)})`);
fs.unlinkSync(srcAv);
fs.unlinkSync(outWav);

// ---------- 20) GPU (VideoToolbox) with CPU fallback ----------
(async () => {
  console.log('Test 20: GPU encode with automatic CPU fallback');
  const outGpu = path.join(tmp, 'xre-test-gpu.mov');
  const gpuResults = await render.startBatch(null, {
    project: p,
    jobs: [{ src: srcPng, isImage: true, outPath: outGpu }],
    codec: 'prores_hq', alpha: 'none', depth: 10, fps: 5, imageDuration: 1, gpu: true,
  });
  assert(gpuResults[0].ok, 'gpu or fallback render ok: ' + JSON.stringify(gpuResults[0]));
  assert(/prores/i.test(probeInfo(caps.proresPath, outGpu)));
  ok('GPU path renders ProRes (or falls back to CPU cleanly)');

  [srcPng, srcVid, srcSq, outMov, outDxv, outHap, outHevc, outPng, outPng16, outTrim, outTr, outA, outB, outMerged, outGpu].forEach((f) => {
    try { fs.unlinkSync(f); } catch (e) { /* gone */ }
  });
  fs.rmSync(seqDir, { recursive: true, force: true });

  console.log(`\nALL ${passed} CHECKS PASSED`);
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
