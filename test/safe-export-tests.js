'use strict';
// Exports never leave a broken file under a real name and never destroy a good one.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const Outputs = require('../src/shared/outputs');
const Files = require('../src/main/output-files');
const Codecs = require('../src/shared/codecs');
const render = require('../src/main/render');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ffmpeg(ff, args) {
  const r = spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stderr);
}

function proj(w, h) {
  return {
    name: 't',
    input: { width: w, height: h },
    screens: [{ id: 's', name: 'S', width: w, height: h }],
    slices: [{ id: 'a', name: 'a', enabled: true, screenId: 's', in: { x: 0, y: 0, w, h }, out: { x: 0, y: 0, w, h }, inOrient: 0, outOrient: 0, flip: 0, mask: null }],
  };
}

function job(src, outPath, p, extra) {
  return { src, isImage: false, outPath, screen: p.screens[0], label: path.basename(src), ...extra };
}

const pending = (dir) => fs.readdirSync(dir).filter((n) => Outputs.isTempName(n));

async function run(ok, ff, tmp) {
  console.log('Test: naming and judging outputs');
  assert.strictEqual(Outputs.partialName('a_remap.mov', false), 'a_remap.xre-partial.mov');
  assert.strictEqual(Outputs.partialName('a_seq', true), 'a_seq.xre-partial');
  assert(Outputs.partialName(`${'x'.repeat(250)}.mov`, false).length <= 255, 'room for the marker on a long name');
  assert.strictEqual(Outputs.versionedName('a.mp4', 2, false), 'a_v2.mp4');
  assert.strictEqual(Outputs.versionedName('a_seq', 3, true), 'a_seq_v3');
  assert(Outputs.isTempName('a.xre-partial.mov') && Outputs.isTempName('a_seq.xre-partial') && Outputs.isTempName('a_seq.xre-old'));
  assert(!Outputs.isTempName('a_remap.mov') && !Outputs.isTempName('partial.mov'));
  assert(Outputs.samePath('D:\\Show\\Export\\', 'd:/show/export'));
  assert(!Outputs.samePath('D:/Show', 'D:/Show2') && !Outputs.samePath('', 'D:/Show'));
  ok('temporary names, versions and folder comparison');

  const base = { width: 3840, height: 2160, codec: 'h264', frames: 250, hasAudio: false };
  assert.deepStrictEqual(Outputs.compareOutput({ width: 3840, height: 2160, codec: 'h264', frames: 250 }, base), []);
  assert.deepStrictEqual(Outputs.compareOutput({ width: 3840, height: 2160, codec: 'h264', frames: 248 }, base), [], 'container rounding is tolerated');
  assert.deepStrictEqual(Outputs.compareOutput({ width: 3840, height: 2160, codec: 'h264', frames: 99 }, base), ['99 frames, expected 250']);
  assert.deepStrictEqual(Outputs.compareOutput({ width: 3840, height: 2160, codec: 'h264', frames: 240 }, { ...base, hasAudio: true }), [], 'an audio track can run past the picture');
  assert(/size is 1920×1080/.test(Outputs.compareOutput({ width: 1920, height: 1080, codec: 'h264', frames: 250 }, base)[0]));
  assert(/codec is hevc/.test(Outputs.compareOutput({ width: 3840, height: 2160, codec: 'hevc', frames: 250 }, base)[0]));
  assert.deepStrictEqual(Outputs.compareOutput({ width: 3840, height: 2160, codec: 'h264', frames: null }, base), ['frame count could not be read']);
  assert.strictEqual(Outputs.probedCodec('dxv_hq'), 'hap');
  assert.strictEqual(Outputs.probedCodec('prores_4444'), 'prores');
  assert.deepStrictEqual(
    Outputs.summaryLines({ kind: 'video', width: 3840, height: 2160, frames: 250, sizeBytes: 70.8 * 1024 * 1024, warnings: [] }),
    ['3840×2160 · 250 frames', '70.8 MB · verified']
  );
  assert.deepStrictEqual(Codecs.batchOutcome(2, 2, false, 1), { state: 'partial', text: 'All 2 exported, 1 with a warning' });
  ok('frame, size and codec comparison, row text and batch outcome');

  const dir = path.join(tmp, `xre-safe-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const p = proj(320, 180);
  const opts = { project: p, codec: 'prores_proxy', alpha: 'none', depth: 10, fps: 25, imageDuration: 1 };
  const src = path.join(dir, 'src.mkv');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-frames:v', '50', '-c:v', 'ffv1', src]);

  console.log('Test: temporary name until finished');
  const out = path.join(dir, 'out.mov');
  const events = [];
  const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, ev) => events.push(ev) } };
  const first = await render.startBatch(fakeWin, { ...opts, jobs: [job(src, out, p)] });
  assert(first[0].ok, JSON.stringify(first[0]));
  assert(fs.existsSync(out));
  assert.deepStrictEqual(pending(dir), []);
  assert.strictEqual(first[0].check.frames, 50);
  assert.strictEqual(first[0].check.width, 320);
  assert.deepStrictEqual(first[0].check.warnings, []);
  const doneEv = events.find((e) => e.type === 'job-done');
  assert.strictEqual(doneEv.check.frames, 50);
  assert(events.some((e) => e.type === 'job-verify'), 'the check is announced');
  assert(render.isOwnOutput(out), 'own output is remembered for the watch folder');
  assert(!render.isOwnOutput(src), 'the source is not');
  ok('finished file has its final name, checked: 320×180, 50 frames');

  console.log('Test: existing files');
  const goodBytes = fs.readFileSync(out);
  const overwritten = await render.startBatch(null, { ...opts, existingPolicy: 'overwrite', jobs: [job(src, out, p, { inSec: 0, outSec: 1 })] });
  assert(overwritten[0].ok && overwritten[0].check.frames === 25, JSON.stringify(overwritten[0]));
  assert(!fs.readFileSync(out).equals(goodBytes), 'overwrite really replaced the file');

  const v2 = await render.startBatch(null, { ...opts, existingPolicy: 'version', jobs: [job(src, out, p)] });
  assert.strictEqual(v2[0].out, path.join(dir, 'out_v2.mov'));
  assert.strictEqual(v2[0].savedAs, 'out_v2.mov');
  const v3 = await render.startBatch(null, { ...opts, existingPolicy: 'version', jobs: [job(src, out, p)] });
  assert.strictEqual(v3[0].out, path.join(dir, 'out_v3.mov'));
  assert(render.isOwnOutput(v3[0].out), 'versions are recorded as own output too');
  ok('overwrite replaces, new version finds the next free _vN');

  const clash = path.join(dir, 'same.mov');
  const both = await render.startBatch(null, { ...opts, jobs: [job(src, clash, p), job(src, clash, p)] });
  assert.strictEqual(both[0].out, clash);
  assert.strictEqual(both[1].out, path.join(dir, 'same_v2.mov'));
  ok('two jobs in a batch never share a name');

  console.log('Test: cancel');
  const big = path.join(dir, 'big.mkv');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=25', '-frames:v', '500', '-c:v', 'ffv1', big]);
  const bigP = proj(1920, 1080);
  const bigOpts = { project: bigP, codec: 'prores_hq', alpha: 'none', depth: 10, fps: 25, imageDuration: 1 };
  const keep = path.join(dir, 'keep.mov');
  fs.writeFileSync(keep, 'previous good export');
  const running = render.startBatch(null, { ...bigOpts, existingPolicy: 'overwrite', jobs: [job(big, keep, bigP)] });
  await wait(1200);
  assert.strictEqual(render.isBusy(), true);
  await assert.rejects(() => render.startBatch(null, { ...bigOpts, jobs: [job(big, path.join(dir, 'second.mov'), bigP)] }), /already running/);
  assert(!fs.existsSync(path.join(dir, 'second.mov')), 'second batch wrote nothing');
  const idle = render.whenIdle();
  render.cancel();
  const stopped = await running;
  await idle;
  assert.strictEqual(render.isBusy(), false);
  assert.strictEqual(stopped[0].ok, false);
  assert.strictEqual(fs.readFileSync(keep, 'utf8'), 'previous good export', 'the previous export is untouched');
  assert.deepStrictEqual(pending(dir), [], 'the partial is gone after cancel');
  ok('cancel: previous file kept, partial removed, second batch refused');

  console.log('Test: truncated source');
  const whole = path.join(dir, 'whole.mkv');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-frames:v', '250', '-c:v', 'ffv1', '-g', '1', whole]);
  const cut = path.join(dir, 'cut.mkv');
  const wholeBytes = fs.readFileSync(whole);
  fs.writeFileSync(cut, wholeBytes.subarray(0, Math.floor(wholeBytes.length * 0.4)));
  const cutOut = path.join(dir, 'cut_out.mov');
  fs.writeFileSync(cutOut, 'previous good export');
  const cutRes = await render.startBatch(null, { ...opts, existingPolicy: 'overwrite', jobs: [job(cut, cutOut, p)] });
  assert(cutRes[0].ok, JSON.stringify(cutRes[0]));
  assert(cutRes[0].check.warnings.length === 1 && /frames, expected/.test(cutRes[0].check.warnings[0]), JSON.stringify(cutRes[0].check));
  assert.strictEqual(fs.readFileSync(cutOut, 'utf8'), 'previous good export', 'a file with a warning does not replace a good one');
  assert.strictEqual(cutRes[0].savedAs, 'cut_out_v2.mov');
  ok(`truncated source flagged (${cutRes[0].check.warnings[0]}), previous file kept`);

  console.log('Test: PNG sequence is replaced as a whole');
  const seqP = proj(64, 36);
  const seqSrc = path.join(dir, 'seqsrc.mkv');
  ffmpeg(ff, ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25', '-frames:v', '20', '-c:v', 'ffv1', seqSrc]);
  const seqOpts = { project: seqP, codec: 'png_seq', alpha: 'none', depth: 8, fps: 25, imageDuration: 1 };
  const seqDir = path.join(dir, 'clip_seq');
  const seqJob = (extra) => job(seqSrc, path.join(seqDir, 'frame_%05d.png'), seqP, { outDir: seqDir, ...extra });
  const seq1 = await render.startBatch(null, { ...seqOpts, jobs: [seqJob()] });
  assert(seq1[0].ok, JSON.stringify(seq1[0]));
  assert.strictEqual(seq1[0].check.frames, 20);
  assert.strictEqual(fs.readdirSync(seqDir).length, 20);
  const seq2 = await render.startBatch(null, { ...seqOpts, existingPolicy: 'overwrite', jobs: [seqJob({ inSec: 0, outSec: 0.4 })] });
  assert(seq2[0].ok, JSON.stringify(seq2[0]));
  assert.strictEqual(fs.readdirSync(seqDir).length, 10, 'no stale frames from the longer export');
  assert.deepStrictEqual(pending(dir), []);
  const seq3 = await render.startBatch(null, { ...seqOpts, existingPolicy: 'version', jobs: [seqJob()] });
  assert.strictEqual(seq3[0].out, `${seqDir}_v2`);
  assert.strictEqual(fs.readdirSync(`${seqDir}_v2`).length, 20);
  assert.strictEqual(fs.readdirSync(seqDir).length, 10, 'the existing folder stays as it was');
  ok('sequence swapped as one folder: 10 frames left of 20, version beside it');

  if (process.platform === 'win32') {
    console.log('Test: file in use');
    const lockedOut = path.join(dir, 'locked.mov');
    fs.writeFileSync(lockedOut, 'open in a player');
    const lock = fs.openSync(lockedOut, fs.constants.O_RDWR | Files.O_EXLOCK);
    assert.strictEqual(Files.fileIsBusy(lockedOut), true, 'a file held open counts as busy');
    const lockedRes = await render.startBatch(null, { ...opts, existingPolicy: 'overwrite', jobs: [job(src, lockedOut, p)] });
    fs.closeSync(lock);
    assert.strictEqual(lockedRes[0].ok, false);
    assert(/in use/.test(lockedRes[0].error) && /locked\.xre-partial\.mov/.test(lockedRes[0].error), lockedRes[0].error);
    assert.strictEqual(fs.readFileSync(lockedOut, 'utf8'), 'open in a player', 'the open file is untouched');
    assert(fs.existsSync(path.join(dir, 'locked.xre-partial.mov')), 'the finished export is kept');
    fs.unlinkSync(path.join(dir, 'locked.xre-partial.mov'));
    assert.strictEqual(Files.fileIsBusy(lockedOut), false, 'free again after closing');
    ok('target in use: nothing lost, export kept under its temporary name');
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { run };
