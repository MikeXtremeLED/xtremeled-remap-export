'use strict';
// Conforming to the show and checking on the wall: image sequences, output frame rate, timecode,
// 24-bit audio, the player test and the frame check. Runs on its own (node test/conform-tests.js)
// and from run-tests.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const G = require('../src/shared/geometry');
const Codecs = require('../src/shared/codecs');
const Outputs = require('../src/shared/outputs');
const C = require('../src/shared/conform');
const render = require('../src/main/render');

function ffmpeg(ff, args) {
  const r = spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `ffmpeg failed: ${(r.stderr || '').toString().slice(-1500)}`);
  return r;
}

function info(ff, file) {
  const r = spawnSync(ff, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 30000 });
  return (r.stderr || '') + (r.stdout || '');
}

function countFrames(ff, file) {
  const r = spawnSync(ff, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-progress', 'pipe:1', '-nostats', '-'], { encoding: 'utf8', timeout: 60000 });
  const all = (r.stdout || '').match(/^frame=\s*(\d+)/gm);
  return all ? parseInt(all[all.length - 1].replace(/\D/g, ''), 10) : null;
}

function rawRgba(ff, file, w, h, seekFrame) {
  const select = seekFrame ? ['-vf', `select=eq(n\\,${seekFrame})`, '-fps_mode', 'passthrough'] : [];
  const out = ffmpeg(ff, ['-i', file, ...select, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']).stdout;
  assert.strictEqual(out.length, w * h * 4, 'raw frame size');
  return out;
}

const sliceOf = (id, inR, outR, extra) => ({ id, name: id, enabled: true, screenId: 'a', in: inR, out: outR, inOrient: 0, outOrient: 0, flip: 0, ...(extra || {}) });

function projectOf(w, h, ow, oh, slices) {
  return { name: 't', input: { width: w, height: h }, screens: [{ id: 'a', name: 'A', width: ow, height: oh }], slices };
}

function unitChecks(ok) {
  // sequences
  const names = (dir, prefix, n, from, pad) => Array.from({ length: n }, (_, i) => `${dir}${prefix}${String(from + i).padStart(pad, '0')}.png`);
  let s = C.detectSequences(names('C:\\r\\', 'render_', 3000, 1, 4));
  assert.strictEqual(s.sequences.length, 1);
  assert.strictEqual(s.rest.length, 0);
  assert.strictEqual(s.sequences[0].label, 'render_####.png');
  assert.strictEqual(s.sequences[0].count, 3000);
  assert.strictEqual(s.sequences[0].start, 1);
  assert.strictEqual(s.sequences[0].pattern, 'C:\\r\\render_%04d.png');
  assert.strictEqual(s.sequences[0].stem, 'render');
  assert.strictEqual(C.frameFile(s.sequences[0], 42), 'C:\\r\\render_0042.png');
  ok('3000 numbered frames become one clip');

  s = C.detectSequences([...names('/a/', 'x', 4, 1, 3), '/a/photo1.png', '/a/photo2.png', '/a/clip.mov']);
  assert.strictEqual(s.sequences.length, 0, 'a handful of numbered files stays separate');
  assert.strictEqual(s.rest.length, 7);
  s = C.detectSequences([...names('/a/', 'x', 6, 1, 3), ...names('/a/', 'x', 6, 20, 3)]);
  assert.strictEqual(s.sequences.length, 2, 'a numbering gap splits the run');
  assert.strictEqual(s.gaps, 1);
  s = C.detectSequences([...names('/a/', 'x', 2998, 1, 4), '/a/x3000.png']);
  assert.strictEqual(s.sequences[0].count, 2998);
  assert.deepStrictEqual(s.rest, ['/a/x3000.png']);
  assert.strictEqual(s.gaps, 1, 'one frame missing near the end is a gap too');
  s = C.detectSequences(names('/a/', 'y', 12, 1, 1));
  assert.strictEqual(s.sequences.length, 1, 'unpadded numbers 1..12');
  assert.strictEqual(s.sequences[0].pattern, '/a/y%01d.png');
  assert.strictEqual(C.frameFile(s.sequences[0], 11), '/a/y11.png');
  s = C.detectSequences(names('/a%b/', 'z', 6, 0, 2));
  assert.strictEqual(s.sequences[0].pattern, '/a%%b/z%02d.png', 'a percent in the path is escaped');
  assert.strictEqual(C.frameFile(s.sequences[0], 3), '/a%b/z03.png');
  const seq = C.detectSequences(names('C:\\old\\', 'f', 8, 1, 3)).sequences[0];
  assert.strictEqual(C.moveSequence(seq, 'D:\\new\\f001.png').pattern, 'D:\\new\\f%03d.png');
  ok('numbering rules: separate files, gaps, padding, % and moved folders');

  const exr = C.detectSequences(names('/a/', 'n', 6, 1, 2).map((p) => p.replace('.png', '.exr')));
  assert.strictEqual(exr.sequences.length, 1, 'EXR frames');
  const dpx = C.detectSequences(names('/a/', 'n', 6, 1, 2).map((p) => p.replace('.png', '.dpx')));
  assert.strictEqual(dpx.sequences.length, 1, 'DPX frames');
  ok('EXR and DPX frames are accepted');

  const atTime = { start: 100, count: 50, fps: 25, pattern: '/a/x%04d.png' };
  assert.strictEqual(C.frameAtTime(atTime, 0), 100);
  assert.strictEqual(C.frameAtTime(atTime, 1), 125);
  assert.strictEqual(C.frameAtTime(atTime, 999), 149, 'never past the last frame');
  ok('a time in the clip maps to one frame number');

  // timecode
  assert.deepStrictEqual(C.parseTimecode('10:00:00:00'), { h: 10, m: 0, s: 0, f: 0, drop: false });
  assert.strictEqual(C.parseTimecode('nope'), null);
  assert.strictEqual(C.outputTimecode('10:00:00:00', 25, 25, 0), '10:00:00:00');
  assert.strictEqual(C.outputTimecode('10:00:00:00', 25, 25, 2), '10:00:02:00', 'moved on by the in-point');
  assert.strictEqual(C.outputTimecode('10:00:00:12', 25, 50, 0), '10:00:00:24', 'frame count follows the output rate');
  assert.strictEqual(C.outputTimecode('23:59:59:24', 25, 25, 0.04), '00:00:00:00', 'wraps at midnight');
  assert.strictEqual(C.outputTimecode('01:00:00;00', 29.97, 29.97, 0), '01:00:00;00', 'drop-frame stays drop-frame');
  assert.strictEqual(C.framesToTimecode(C.timecodeToFrames(C.parseTimecode('00:10:00;00'), 30), 30, true), '00:10:00;00');
  assert.strictEqual(C.framesToTimecode(1800, 30, true), '00:01:00;02', 'the two skipped numbers per minute');
  assert.strictEqual(C.outputTimecode('01:00:00;00', 29.97, 60, 0), '01:00:00:00', 'leaving drop-frame keeps the time of day');
  assert.strictEqual(C.outputTimecode('01:00:00;00', 29.97, 30, 0), '01:00:00:00', 'exact 30 fps has no drop-frame');
  assert.strictEqual(C.outputTimecode('10:00:00;15', 29.97, 60, 0), '10:00:00:30', 'frames follow the output rate');
  assert.strictEqual(C.outputTimecode('01:00:00;00', 29.97, 25, 1001 / 30000 * 30), '01:00:01:00', 'in-point moves the label first');
  assert.strictEqual(C.outputTimecode('01:00:00;00', 29.97, 59.94, 0), '01:00:00;00', 'a drop-frame rate stays drop-frame');
  assert.strictEqual(C.outputTimecode('00:10:00:00', 29.97, 60, 0), '00:10:00:00', 'non-drop is unchanged');
  ok('timecode: in-point, rate change, midnight and drop-frame');

  // output rate
  assert.strictEqual(Codecs.rateRelation(25, 50).kind, 'repeat');
  assert.strictEqual(Codecs.rateRelation(25, 50).factor, 2);
  assert.strictEqual(Codecs.rateRelation(50, 25).kind, 'drop');
  assert.strictEqual(Codecs.rateRelation(25, 25).kind, 'same');
  assert.strictEqual(Codecs.rateRelation(25, 30).kind, 'uneven');
  assert.strictEqual(Codecs.rateRelation(29.97, 30).kind, 'uneven');
  assert(Codecs.rateNote(25, 30), 'a warning for an uneven rate');
  assert.strictEqual(Codecs.rateNote(25, 50), null);
  assert.strictEqual(Codecs.rateNote(59.94, 59.94), null);
  ok('output rate: whole multiples versus uneven');

  // test pattern
  const eff = { crop: { x: 100, y: 10, w: 40, h: 40 }, place: { x: 0, y: 53, w: 40, h: 40 }, rot: 0, flip: 0 };
  const m = C.sliceMarkers(eff, {});
  assert.strictEqual(m.depth, 10);
  m.teeth.forEach((t) => {
    assert(t.w === 1 || t.h === 1, 'a tooth is one pixel wide');
    assert.strictEqual(Number.isInteger(t.x + t.y + t.w + t.h), true);
    assert(t.x >= 100 && t.x + t.w <= 140 && t.y >= 10 && t.y + t.h <= 50, 'inside the slice');
  });
  const col = (rects, x, y) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  assert.strictEqual(col(m.teeth, 100, 10), false, 'top edge skips even output columns');
  assert.strictEqual(col(m.teeth, 101, 10), true, 'top edge uses odd output columns');
  assert.strictEqual(col(m.teeth, 100, 49), true, 'bottom edge uses even output columns');
  assert.strictEqual(col(m.teeth, 101, 49), false);
  const below = { crop: { x: 0, y: 0, w: 40, h: 40 }, place: { x: 0, y: 93, w: 40, h: 40 }, rot: 0, flip: 0 };
  const b = C.sliceMarkers(below, {});
  for (let i = 0; i < 40; i++) {
    const upper = col(m.teeth, 100 + i, 49);
    const lower = col(b.teeth, i, 0);
    assert.notStrictEqual(upper, lower, 'teeth of adjoining slices interlock');
  }
  m.ticks.forEach((t) => {
    assert(t.w === 1 || t.h === 1, 'a tick is one pixel wide');
    assert(t.x >= eff.crop.x + m.depth && t.x + t.w <= eff.crop.x + eff.crop.w - m.depth, 'ticks stay off the teeth');
    assert(t.y >= eff.crop.y + m.depth && t.y + t.h <= eff.crop.y + eff.crop.h - m.depth, 'ticks stay off the teeth');
  });
  ok('edge markers: one pixel wide and interlocking at a seam');
  const lines = C.panelLines({ x: 8, y: 0, w: 300, h: 100 }, 104, 50);
  assert.deepStrictEqual(lines.filter((l) => l.w === 1).map((l) => l.x), [8, 112, 216]);
  assert.deepStrictEqual(lines.filter((l) => l.h === 1).map((l) => l.y), [0, 50]);
  ok('panel grid counts from the slice corner, lines one pixel wide');
  assert.strictEqual(C.coordsLabel({ crop: { x: 3744, y: 0, w: 3744, h: 416 }, place: { x: 0, y: 416, w: 3744, h: 416 } }), 'IN 3744,0 3744×416 / OUT 0,416 3744×416');

  // seams
  const places = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 50, w: 100, h: 50 }, { x: 100, y: 0, w: 60, h: 100 }];
  const sm = C.seams(places, 200, 200);
  assert.deepStrictEqual(sm.map((p) => [p.orient, p.x, p.y]), [['v', 100, 25], ['h', 50, 50], ['v', 100, 75]]);
  ok('seams between slices are found');

  // reading a finished file back
  const expected = { width: 8, height: 8, codec: 'prores', frames: 10, hasAudio: false, timecode: '10:00:00:00' };
  assert.strictEqual(Outputs.compareOutput({ width: 8, height: 8, codec: 'prores', frames: 10, timecode: '10:00:00:00' }, expected).length, 0);
  assert(/timecode/.test(Outputs.compareOutput({ width: 8, height: 8, codec: 'prores', frames: 10 }, expected)[0]));
  ok('a missing timecode shows up in the read-back');
}

async function run(ok, ff, tmp) {
  unitChecks(ok);
  const dir = path.join(tmp, 'conform');
  fs.mkdirSync(dir, { recursive: true });

  // ---- a source with timecode and 24-bit sound ----
  const src = path.join(dir, 'src.mov');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s24le', '-timecode', '10:00:00:00', src]);
  const probe = render.probeMedia(ff, src);
  assert.strictEqual(probe.timecode, '10:00:00:00');
  assert.strictEqual(probe.audioBits, 24);
  ok('probe reads timecode and 24-bit audio');

  const project = projectOf(64, 64, 64, 64, [sliceOf('s', { x: 0, y: 0, w: 64, h: 64 }, { x: 0, y: 0, w: 64, h: 64 })]);
  const job = (outPath, extra) => ({ src, isImage: false, outPath, transform: null, screen: project.screens[0], ...(extra || {}) });

  const hq = path.join(dir, 'hq.mov');
  let built = render.buildArgs(project, job(hq), { codec: 'prores_hq', depth: 10 }, probe);
  ffmpeg(ff, built.args);
  const hqInfo = info(ff, hq);
  assert(/timecode\s*:\s*10:00:00:00/.test(hqInfo), 'timecode stays');
  assert(/pcm_s24le/.test(hqInfo), 'audio stays 24-bit');
  assert.strictEqual(built.notes.length, 0, 'nothing to report');
  ok('ProRes keeps timecode and 24-bit audio');

  const trimmed = path.join(dir, 'trim.mov');
  built = render.buildArgs(project, job(trimmed, { inSec: 1, outSec: 2 }), { codec: 'prores_hq', depth: 10 }, probe);
  ffmpeg(ff, built.args);
  assert(/timecode\s*:\s*10:00:01:00/.test(info(ff, trimmed)), 'moved on by the in-point');
  ok('a trim moves the timecode on to the in-point');

  const hap = path.join(dir, 'hap.mov');
  built = render.buildArgs(project, job(hap), { codec: 'hap', depth: 8 }, probe);
  ffmpeg(ff, built.args);
  assert(/timecode\s*:\s*10:00:00:00/.test(info(ff, hap)), 'HAP keeps timecode');
  ok('HAP keeps timecode');

  const h264 = path.join(dir, 'h.mp4');
  built = render.buildArgs(project, job(h264), { codec: 'h264', depth: 8 }, probe);
  ffmpeg(ff, built.args);
  const mp4Info = info(ff, h264);
  assert(/timecode\s*:\s*10:00:00:00/.test(mp4Info), 'MP4 keeps timecode');
  assert(/aac/.test(mp4Info));
  assert(built.notes.some((n) => /AAC/.test(n)), 'a note when 24-bit becomes AAC');
  ok('MP4 keeps timecode, and reports 24-bit audio turning into AAC');

  const alpha = path.join(dir, 'alpha.mov');
  built = render.buildArgs(project, job(alpha), { codec: 'prores_4444', alpha: 'straight', depth: 10 }, probe);
  ffmpeg(ff, built.args);
  assert(/pcm_s24le/.test(info(ff, alpha)), 'alpha export keeps its sound');
  ok('an alpha export keeps its 24-bit audio');

  const seqOut = path.join(dir, 'seq');
  fs.mkdirSync(seqOut, { recursive: true });
  built = render.buildArgs(project, { ...job(path.join(seqOut, 'f_%05d.png')), outDir: seqOut }, { codec: 'png_seq', depth: 8 }, probe);
  assert(built.notes.some((n) => /Audio is not kept/.test(n)), 'a note when sound is lost');
  assert(built.notes.some((n) => /Timecode 10:00:00:00 is not kept/.test(n)), 'a note when timecode is lost');
  assert.strictEqual(built.expect.hasAudio, false);
  ok('a PNG sequence reports the lost sound and timecode');

  // ---- output frame rate ----
  const rateSrc = path.join(dir, 'rate25.mov');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=2', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', rateSrc]);
  const rateProbe = render.probeMedia(ff, rateSrc);
  const rateJob = (outPath) => ({ src: rateSrc, isImage: false, outPath, transform: null, screen: project.screens[0] });
  const convert = (name, outFps, compositor) => {
    const out = path.join(dir, name);
    const b = render.buildArgs(project, rateJob(out), { codec: 'prores_hq', depth: 10, outFps, compositor }, rateProbe);
    ffmpeg(ff, b.args);
    return { frames: countFrames(ff, out), expect: b.expect.frames, notes: b.notes, info: info(ff, out) };
  };
  let conv = convert('r50.mov', 50);
  assert.strictEqual(conv.frames, 100, '25 fps doubled to 50');
  assert.strictEqual(conv.expect, 100);
  assert(/50 fps/.test(conv.info));
  assert.strictEqual(conv.notes.length, 0, 'a whole multiple is not worth a warning');
  conv = convert('r50-overlay.mov', 50, 'overlay');
  assert.strictEqual(conv.frames, 100, 'also through the overlay path');
  conv = convert('r30.mov', 30);
  assert(conv.notes.some((n) => /not a whole multiple/.test(n)));
  assert(Math.abs(conv.frames - 60) <= 1, '25 to 30 fps gives about 60 frames');
  ok('output frame rate: 25 to 50 is exact, 25 to 30 warns');

  const sameRate = render.buildArgs(project, rateJob(path.join(dir, 'same.mov')), { codec: 'prores_hq', depth: 10, outFps: null }, rateProbe);
  assert(/r=25|fps=25/.test(sameRate.args.join(' ')), 'same as source stays on the source rate');
  ok('same as source leaves the source rate alone');

  // ---- image sequences, EXR and DPX ----
  const frames = path.join(dir, 'frames');
  fs.mkdirSync(frames, { recursive: true });
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=0.4', '-frames:v', '10', path.join(frames, 'r_%04d.png')]);
  const scanned = render.scanFootage([frames], ['png']);
  assert.strictEqual(scanned.sequences.length, 1, 'a folder of frames is one clip');
  assert.strictEqual(scanned.sequences[0].count, 10);
  assert.strictEqual(scanned.sequences[0].start, 1);
  const seqDef = { ...scanned.sequences[0], fps: 25 };
  const seqProbe = render.probeSource(ff, seqDef.first, seqDef);
  assert.strictEqual(seqProbe.durationSec, 0.4);
  assert.strictEqual(seqProbe.width, 64);
  const seqJob = (outPath, extra) => ({ src: seqDef.first, isImage: false, sequence: seqDef, outPath, transform: null, screen: project.screens[0], ...(extra || {}) });
  const seqMov = path.join(dir, 'seq.mov');
  ffmpeg(ff, render.buildArgs(project, seqJob(seqMov), { codec: 'prores_hq', depth: 10 }, seqProbe).args);
  assert.strictEqual(countFrames(ff, seqMov), 10, 'all frames');
  ok('a folder of numbered PNGs exports as one 10-frame clip');

  const note = path.join(dir, 'notes.txt');
  fs.writeFileSync(note, 'not footage');
  const clipFile = path.join(dir, 'rate25.mov');
  assert.deepStrictEqual(render.scanFootage([note, clipFile], ['mov']).rest, [clipFile], 'a dropped text file is no clip');
  assert.deepStrictEqual(render.scanFootage([note], ['mov'], true).rest, [note], 'picked by hand under All files');
  ok('only media files are scanned in, unless picked by hand');

  const seqTrim = path.join(dir, 'seqtrim.mov');
  ffmpeg(ff, render.buildArgs(project, seqJob(seqTrim, { inSec: 0.2, outSec: 0.4 }), { codec: 'prores_hq', depth: 10 }, seqProbe).args);
  assert.strictEqual(countFrames(ff, seqTrim), 5, 'trim is exact on frames');
  const seqStill = path.join(dir, 'seqstill.png');
  ffmpeg(ff, render.buildArgs(project, seqJob(seqStill, { pngTime: 0.2 }), { codec: 'png', depth: 8 }, seqProbe).args);
  ok('a sequence trims exactly on frame numbers and gives a still at a time');

  for (const ext of ['exr', 'dpx']) {
    const seqDir = path.join(dir, `seq-${ext}`);
    fs.mkdirSync(seqDir, { recursive: true });
    const pixFmt = ext === 'exr' ? 'gbrpf32le' : 'gbrp10le';
    ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=0.28', '-frames:v', '7', '-pix_fmt', pixFmt, ...(ext === 'exr' ? ['-compression', '0'] : []), path.join(seqDir, `n.%03d.${ext}`)]);
    const sc = render.scanFootage([seqDir], [ext]);
    assert.strictEqual(sc.sequences.length, 1, `${ext} frames are one clip`);
    const seq2 = { ...sc.sequences[0], fps: 25 };
    const pr = render.probeSource(ff, seq2.first, seq2);
    const outFile = path.join(dir, `from-${ext}.mov`);
    const b = render.buildArgs(project, { src: seq2.first, isImage: false, sequence: seq2, outPath: outFile, transform: null, screen: project.screens[0] }, { codec: 'prores_hq', depth: 10 }, pr);
    ffmpeg(ff, b.args);
    assert.strictEqual(countFrames(ff, outFile), 7, `all ${ext} frames`);
  }
  ok('EXR and DPX frames go through the export');

  // ---- player test ----
  const places = C.counterPlaces([{ crop: { x: 0, y: 0, w: 320, h: 96 } }, { crop: { x: 320, y: 0, w: 320, h: 96 } }]);
  const testFile = path.join(dir, 'pt.mkv');
  ffmpeg(ff, ['-filter_complex', C.playerTestGraph(640, 96, '50', 50, 1, places), '-map', '[out]', '-c:v', 'ffv1', '-level', '3', testFile]);
  assert.strictEqual(countFrames(ff, testFile), 50);
  const step = Math.round(640 / (50 * 4));
  const frameAt = (n) => rawRgba(ff, testFile, 640, 96, n);
  const luma = (buf, x, y) => buf[(y * 640 + x) * 4];
  const barColumns = (buf) => {
    const on = [];
    for (let x = 0; x < 640; x++) if (luma(buf, x, 2) > 100) on.push(x);
    return on;
  };
  const f7 = frameAt(7);
  const f8 = frameAt(8);
  assert.strictEqual(barColumns(f7).length, 1, 'the bar is one pixel wide');
  assert.strictEqual(barColumns(f8)[0] - barColumns(f7)[0], step, 'and moves on every frame');
  // the units digit of frame 7: top segment on, middle segment off (and in frame 8 on)
  const p = places[0];
  const unitsX = p.x + 3 * (p.size.dw + p.size.gap) + Math.floor(p.size.dw / 2);
  const midY = p.y + Math.floor((p.size.h - Math.max(1, Math.round(p.size.h / 9))) / 2);
  assert.strictEqual(luma(f7, unitsX, p.y), 255, 'digit 7 has its top segment');
  assert.strictEqual(luma(f7, unitsX, midY), 0, 'digit 7 has no middle segment');
  assert.strictEqual(luma(f8, unitsX, midY), 255, 'digit 8 has a middle segment');
  ok('player test: a one-pixel bar and a burnt-in frame counter, per frame');

  // ---- frame check ----
  // A checker of noise, so a shift of one pixel can't go unnoticed
  const checkPng = path.join(dir, 'check.png');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=128x64:r=25', '-frames:v', '1', checkPng]);
  const checkProbe = render.probeMedia(ff, checkPng);
  const checkProject = projectOf(128, 64, 200, 200, [
    sliceOf('a', { x: 0, y: 0, w: 64, h: 64 }, { x: 0, y: 0, w: 64, h: 64 }),
    sliceOf('b', { x: 64, y: 0, w: 64, h: 64 }, { x: 0, y: 64, w: 64, h: 64 }),
    sliceOf('c', { x: 37, y: 5, w: 51, h: 41 }, { x: 80, y: 3, w: 51, h: 41 }),
    sliceOf('d', { x: 8, y: 8, w: 40, h: 24 }, { x: 80, y: 60, w: 24, h: 40 }, { outOrient: 90 }),
    sliceOf('e', { x: 8, y: 8, w: 40, h: 24 }, { x: 120, y: 60, w: 40, h: 24 }, { flip: 1 }),
    sliceOf('f', { x: 0, y: 0, w: 40, h: 40 }, { x: 80, y: 140, w: 80, h: 40 }),
  ]);
  const checkInput = (codec, extra) => ({
    project: checkProject,
    job: { src: checkPng, isImage: true, transform: null, screen: checkProject.screens[0], maskFiles: null },
    codec, alpha: 'none', depth: 8, fps: 25, imageDuration: 1, gpu: false,
    ...(extra || {}),
  });
  const r1 = await render.checkFrame(checkInput('png'));
  assert.strictEqual(r1.width, 200);
  assert.strictEqual(r1.height, 200);
  assert(fs.existsSync(r1.image));
  const state = (rows, id) => rows.find((row) => row.id === id);
  ['a', 'b', 'c', 'd', 'e'].forEach((id) => assert.strictEqual(state(r1.rows, id).state, 'identical', `slice ${id}: ${JSON.stringify(state(r1.rows, id))}`));
  assert.strictEqual(state(r1.rows, 'f').state, 'scaled', 'a scaled slice is not reported as a difference');
  assert(r1.seams.some((sm) => sm.orient === 'h' && sm.y === 64), 'the seam between slices a and b');
  ok('frame check: straight, odd, rotated and flipped slices read pixel-identical');

  // Comparing a broken frame: the same slices, but one output moved by a pixel
  const shifted = JSON.parse(JSON.stringify(checkProject));
  shifted.slices[1].in.x += 1;
  shifted.slices[1].in.w -= 1;
  shifted.slices[1].out.w -= 1;
  const out = rawRgba(ff, r1.image, 200, 200);
  const ref = rawRgba(ff, checkPng, 128, 64);
  const moved = G.effectiveSlices(shifted, 'a')[1];
  const verdict = C.compareSlice(out, 200, 200, ref, 128, 64, moved, [], { tolerance: 2 });
  assert(verdict.different > 100, `a one-pixel shift is seen (${verdict.different} pixels)`);
  ok('frame check: a shift of one pixel shows up as differing pixels');

  // Covered by a later slice: the part on top is not held against the slice below
  const overlapped = projectOf(64, 64, 64, 64, [
    sliceOf('under', { x: 0, y: 0, w: 32, h: 32 }, { x: 0, y: 0, w: 32, h: 32 }),
    sliceOf('over', { x: 32, y: 32, w: 16, h: 16 }, { x: 8, y: 8, w: 16, h: 16 }),
  ]);
  const overlapPng = path.join(dir, 'over.png');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25', '-frames:v', '1', overlapPng]);
  const r2 = await render.checkFrame({ project: overlapped, job: { src: overlapPng, isImage: true, transform: null, screen: overlapped.screens[0], maskFiles: null }, codec: 'png', alpha: 'none', depth: 8, fps: 25, imageDuration: 1 });
  assert.strictEqual(state(r2.rows, 'under').state, 'identical', 'overlapped pixels are skipped');
  ok('frame check: slices on top of each other are compared where they are visible');

  const hidden = projectOf(64, 64, 64, 64, [
    sliceOf('under', { x: 0, y: 0, w: 16, h: 16 }, { x: 8, y: 8, w: 16, h: 16 }),
    sliceOf('over', { x: 32, y: 32, w: 32, h: 32 }, { x: 0, y: 0, w: 32, h: 32 }),
  ]);
  const hiddenInput = { project: hidden, job: { src: overlapPng, isImage: true, transform: null, screen: hidden.screens[0], maskFiles: null }, codec: 'png', alpha: 'none', depth: 8, fps: 25, imageDuration: 1 };
  const r2b = await render.checkFrame(hiddenInput);
  assert.strictEqual(state(r2b.rows, 'under').state, 'covered', 'nothing compared is no verdict');
  assert.strictEqual(state(r2b.rows, 'over').state, 'identical');
  ok('frame check: a slice that is fully covered gets no verdict');

  const [olderCheck, newerCheck] = await Promise.all([render.checkFrame(hiddenInput), render.checkFrame(hiddenInput)]);
  assert.deepStrictEqual(olderCheck, { stale: true }, 'the stopped check reports stale, not an error');
  assert.strictEqual(state(newerCheck.rows, 'over').state, 'identical', 'and the newer one finishes');
  ok('frame check: a newer check takes over without an error');

  // A 4:2:2 video with an odd crop: the comparison must not call colour rounding a difference
  const yuvSrc = path.join(dir, 'yuv.mov');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=128x64:r=25:d=0.4', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', yuvSrc]);
  const r3 = await render.checkFrame(checkInput('prores_hq', { job: { src: yuvSrc, isImage: false, transform: null, screen: checkProject.screens[0], maskFiles: null }, atSec: 0.12, depth: 10 }));
  assert(r3.lossy, 'ProRes is shown after its encoder');
  assert.strictEqual(state(r3.rows, 'c').state, 'identical', `odd crop on 4:2:2: ${JSON.stringify(state(r3.rows, 'c'))}`);
  assert.strictEqual(state(r3.rows, 'a').state, 'identical');
  const shown = rawRgba(ff, r3.image, 200, 200);
  assert(shown.some((v) => v > 0), 'the shown frame has a picture');
  ok('frame check: 4:2:2 video through the real ProRes encoder');

  // The playhead dragged to the right edge sits on the clip's duration, past its last frame
  const yuvJob = { src: yuvSrc, isImage: false, transform: null, screen: checkProject.screens[0], maskFiles: null };
  const lastLossless = await render.checkFrame(checkInput('png', { job: yuvJob, atSec: 0.4 }));
  assert.strictEqual(state(lastLossless.rows, 'a').state, 'identical', 'a frame is checked at the end of the clip');
  const endPixels = rawRgba(ff, lastLossless.image, 200, 200); // the next check clears its folder
  const nearLast = await render.checkFrame(checkInput('png', { job: yuvJob, atSec: 0.36 }));
  assert(endPixels.equals(rawRgba(ff, nearLast.image, 200, 200)), 'the end of the clip shows the last frame');
  const lastEncoded = await render.checkFrame(checkInput('prores_hq', { job: yuvJob, atSec: 0.4, depth: 10 }));
  assert(lastEncoded.lossy && !lastEncoded.codecProblem, `the end of the clip goes through the encoder too: ${lastEncoded.codecProblem}`);
  const ntscSrc = path.join(dir, 'ntsc.mov');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=128x64:r=30000/1001:d=0.5', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', ntscSrc]);
  const ntscEnd = render.probeMedia(ff, ntscSrc).durationSec;
  const lastNtsc = await render.checkFrame(checkInput('png', { job: { ...yuvJob, src: ntscSrc }, atSec: ntscEnd }));
  assert.strictEqual(state(lastNtsc.rows, 'a').state, 'identical', 'a fractional rate reaches its last frame as well');
  ok('frame check: a playhead on the end of a video checks the last frame');

  // A cancelled export leaves its flag set until the next batch; the player test is no batch
  render.cancel();
  const afterCancel = await render.makePlayerTest({ isDestroyed: () => false, webContents: { send() {} } }, { name: 'after-cancel', width: 64, height: 32, fps: 5, slices: [] });
  assert(fs.existsSync(afterCancel), 'the player test is built after a cancelled export');
  fs.unlinkSync(afterCancel);
  ok('the player test still works after a cancelled export');
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { run };

if (require.main === module) {
  let passed = 0;
  const ok = (name) => { passed++; console.log('  ✓ ' + name); };
  const caps = render.getCapabilities();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xre-conform-'));
  run(ok, caps.proresPath, tmp).then(() => {
    console.log(`\nALL ${passed} CHECKS PASSED`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }).catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
  });
}
