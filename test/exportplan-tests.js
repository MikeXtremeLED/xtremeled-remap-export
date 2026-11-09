'use strict';
// Export page logic: the Start button, playback targets, remembered settings, output folders,
// batch time left and the size estimate, plus one real test encode for that estimate.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../src/shared/exportplan');
const Codecs = require('../src/shared/codecs');
const Outputs = require('../src/shared/outputs');
const render = require('../src/main/render');

const GB = 1024 ** 3;

async function run(ok, ffPath, tmp) {
  console.log('Export page');

  // Start button
  const base = { total: 3, ticked: 3, missing: 0, running: false, destProblem: null };
  assert.deepStrictEqual(P.startState(base), { disabled: false, label: 'Export 3 clips', reason: '' });
  assert.strictEqual(P.startState({ ...base, ticked: 1 }).label, 'Export 1 clip');
  assert.strictEqual(P.startState({ ...base, total: 0, ticked: 0 }).reason, 'Add footage first.');
  assert.strictEqual(P.startState({ ...base, ticked: 0 }).reason, 'Tick at least one clip.');
  assert.strictEqual(P.startState({ ...base, missing: 3 }).reason, 'The selected footage is missing.');
  assert(P.startState({ ...base, destProblem: 'gone' }).disabled, 'a dead output folder holds up Start');
  const running = P.startState({ ...base, running: true });
  assert(running.disabled && running.reason === '' && running.label === 'Export 3 clips');
  ok('Start says what it does and why it is off');

  // Playback targets
  P.TARGETS.forEach((t) => assert(Codecs.byId(t.codec), `${t.codec} is a real codec`));
  assert.strictEqual(P.targetForCodec('hap_q').id, 'resolume_best');
  assert.strictEqual(P.targetForCodec('prores_4444'), null);
  assert.strictEqual(P.defaultCodec(() => true), 'hap_q');
  assert.strictEqual(P.defaultCodec((id) => id !== 'hap_q'), 'prores_hq');
  ok('playback targets map to codecs, best available is the first default');

  // Remembered settings
  assert.deepStrictEqual(P.normalizeSettings(null), {});
  const clean = P.normalizeSettings({ codec: 'dxv', alpha: 'bogus', depth: 8.5, fps: 500, dur: 0, destDir: 123, bitrate: '40' });
  assert.deepStrictEqual(clean, { codec: 'dxv', bitrate: '40' });
  const onlyLast = P.resolveSettings(undefined, { codec: 'dxv', destDir: 'D:\\Out' });
  assert.deepStrictEqual([onlyLast.codec, onlyLast.destDir, onlyLast.folderFromProject], ['dxv', 'D:\\Out', false]);
  const own = P.resolveSettings({ codec: 'h264', destDir: null }, { codec: 'dxv', destDir: 'D:\\Out', fps: 30 });
  assert.deepStrictEqual([own.codec, own.destDir, own.fps, own.folderFromProject], ['h264', null, 30, true]);
  ok('project settings win, last-used fills the gaps, a same-as-footage choice stays');

  // Output folders
  const paths = { temp: 'C:\\Users\\Mike\\AppData\\Local\\Temp', documents: 'C:\\Users\\Mike\\Documents' };
  assert.strictEqual(P.outputFolder('D:\\Show\\a.mov', null, paths), 'D:\\Show');
  assert.strictEqual(P.outputFolder('D:\\clip.mov', null, paths), 'D:\\', 'a drive root keeps its separator');
  assert.strictEqual(P.folderOf('D:/clip.mov'), 'D:/');
  assert.strictEqual(P.outputFolder('D:\\Show\\a.mov', 'E:\\Out', paths), 'E:\\Out');
  assert.strictEqual(P.outputFolder('C:\\Users\\Mike\\AppData\\Local\\Temp\\xre-1-testpattern.png', null, paths), paths.documents, 'never Temp by itself');
  assert.strictEqual(P.outputFolder('C:\\Users\\Mike\\AppData\\Local\\Temp\\sub\\t.png', null, paths), paths.documents);
  assert.strictEqual(P.outputFolder('C:\\Users\\Mike\\AppData\\Local\\Temp\\t.png', 'C:\\Users\\Mike\\AppData\\Local\\Temp', paths), 'C:\\Users\\Mike\\AppData\\Local\\Temp', 'choosing Temp yourself is allowed');
  assert.strictEqual(P.outputFolder('/Volumes/Show/a.mov', null, { temp: '/tmp', documents: '/Users/m/Documents' }), '/Volumes/Show');
  assert(P.isInsideFolder('/a/b/c', '/a/b') && !P.isInsideFolder('/a/bc', '/a/b'));
  assert.strictEqual(P.stemOf('Show.v07.mov'), 'Show.v07');
  assert.strictEqual(P.outputStem('clip', 'hap_q', 'none', 3840, 2160, ''), 'clip_remap_hap_q_3840x2160');
  assert.strictEqual(P.outputStem('clip', 'hap', 'straight', 100, 200, '_A'), 'clip_remap_hap_straight_100x200_A');
  assert.strictEqual(P.volumeLabel('d:\\Show', 'win32'), 'D:');
  assert.strictEqual(P.volumeLabel('\\\\nas\\media\\out', 'win32'), '\\\\nas\\media');
  assert.strictEqual(P.volumeLabel('/Volumes/Backup/x', 'darwin'), 'Backup');
  assert.strictEqual(P.volumeLabel('/Users/m/x', 'darwin'), null);
  ok('output folders: per clip, never Temp by itself, disks named');

  // Footage table
  assert.deepStrictEqual(P.splitMiddle('short.mov'), ['', 'short.mov']);
  const [head, tail] = P.splitMiddle('Festival_Mainstage_v07_FINAL.mov');
  assert.strictEqual(tail, 'v07_FINAL.mov'.padStart(14, '_').slice(-14));
  assert.strictEqual(head + tail, 'Festival_Mainstage_v07_FINAL.mov');
  assert.strictEqual(P.formatClock(150), '02:30');
  assert.strictEqual(P.formatClock(3725), '1:02:05');
  assert.strictEqual(P.trimmedSeconds(100, 10, 40), 30);
  assert.strictEqual(P.trimmedSeconds(100, null, null), 100);
  assert.strictEqual(P.trimmedSeconds(100, 90, 500), 10, 'a trim past the end stops at the end');
  assert(P.isTrimmed(1, null) && P.isTrimmed(null, 5) && !P.isTrimmed(null, null) && !P.isTrimmed(0, null));
  assert.strictEqual(P.clipStatus(['done', 'run']), 'run');
  assert.strictEqual(P.clipStatus(['done', 'fail']), 'fail');
  assert.strictEqual(P.clipStatus(['done', 'wait']), 'wait');
  assert.strictEqual(P.clipStatus(['done', 'warn']), 'warn');
  assert.strictEqual(P.clipStatus(['done', 'done']), 'done');
  assert.deepStrictEqual(P.outputCounts(3, 2), { separate: 6, merged: 3, both: 9 });
  ok('footage table: names, length, trim, status and output counts');

  // Time left, weighted by length
  const def = Codecs.byId('hap_q');
  assert.strictEqual(P.jobWeight({ isImage: true }, Codecs.byId('png'), 10), 1, 'a still counts as one second');
  assert.strictEqual(P.jobWeight({ isImage: true }, def, 10), 10);
  assert.strictEqual(P.jobWeight({ isImage: false, durationSec: 120, inSec: 20, outSec: 80 }, def, 10), 60);
  assert.deepStrictEqual(P.evenOutWeights([10, 0, 20]), [10, 15, 20], 'unknown length counts as average');
  const clock = P.createBatchClock([1800, 10], 0);
  assert.deepStrictEqual(clock.snapshot(0), { fraction: 0, clipLeft: null, batchLeft: null }, 'no pace yet');
  clock.start(0, 0);
  clock.progress(0, 50);
  let snap = clock.snapshot(900000); // half of a 30 minute clip in 15 minutes = real time
  assert.ok(Math.abs(snap.fraction - 900 / 1810) < 1e-6, `bar weighted by length: ${snap.fraction}`);
  assert.ok(Math.abs(snap.clipLeft - 900) < 1e-6 && Math.abs(snap.batchLeft - 910) < 1e-6, JSON.stringify(snap));
  clock.finish(0);
  clock.start(1, 1800000);
  assert.ok(Math.abs(clock.snapshot(1800000).fraction - 1800 / 1810) < 1e-6, 'the next clip barely moves the bar');
  assert.strictEqual(P.progressLabel(1, 3, 3, { clipLeft: 252, batchLeft: 690 }), 'Clip 2 of 3 · 04:12 left · batch 11:30 left');
  assert.strictEqual(P.progressLabel(0, 1, 1, { clipLeft: 5, batchLeft: 5 }), 'Clip 1 of 1 · 00:05 left');
  assert.strictEqual(P.progressLabel(1, 6, 3, { clipLeft: null }), 'File 2 of 6 · estimating…');
  // percent barely moved for the first clip of a batch: no pace yet, no invented numbers
  const early = P.createBatchClock([100], 0);
  early.start(0, 0);
  early.progress(0, 1);
  assert.strictEqual(early.snapshot(500).clipLeft, null);
  // a clip that never reports progress (a still) cannot break the batch
  const stills = P.createBatchClock([1, 1], 0);
  stills.start(0, 0);
  stills.finish(0);
  assert.strictEqual(stills.snapshot(1000).fraction, 0.5);
  ok('time left per clip and batch, bar weighted by clip length, nothing invented early');

  // Size estimate
  const sample = { bytes: 1000000, frames: 10, pixels: 3840 * 2160 };
  const targets = [{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }];
  const est = P.estimateBytes(sample, [{ frames: 100, audioBytes: 500 }], targets);
  assert.ok(Math.abs(est - (100000 * 100 + 100000 * 100 / 4 + 1000)) < 1, `scaled by pixels: ${est}`);
  assert.strictEqual(P.estimateBytes(null, [], targets), null);
  assert.strictEqual(P.audioBytes(Codecs.byId('h264'), { hasAudio: true }, 10), 400000, 'mp4 is AAC');
  assert.strictEqual(P.audioBytes(def, { hasAudio: true, audioChannels: 2 }, 10), 1920000, 'mov is 16-bit PCM');
  assert.strictEqual(P.audioBytes(Codecs.byId('png_seq'), { hasAudio: true }, 10), 0, 'a sequence has no audio');
  assert.strictEqual(P.audioBytes(Codecs.byId('wav'), { hasAudio: true, audioChannels: 2 }, 1, 24), 288000);
  assert.strictEqual(P.spaceLevel(10 * GB, 200 * GB), 'ok');
  assert.strictEqual(P.spaceLevel(100 * GB, 110 * GB), 'tight');
  assert.strictEqual(P.spaceLevel(9 * GB, 10 * GB), 'tight', 'less than 2 GB left is tight');
  assert.strictEqual(P.spaceLevel(11 * GB, 10 * GB), 'full');
  assert.strictEqual(P.tightestVolume([{ volume: 'C:', freeBytes: 500 * GB, bytes: 1 * GB }, { volume: 'D:', freeBytes: 10 * GB, bytes: 9 * GB }]).volume, 'D:');
  const macDirs = new Map([['/Users/m/a', 60 * GB], ['/Users/m/b', 60 * GB], ['/Volumes/Backup/c', 5 * GB]]);
  const macDisks = P.bytesPerVolume([
    { dir: '/Users/m/a', volume: null, freeBytes: null },
    { dir: '/Users/m/b', volume: null, freeBytes: 100 * GB },
    { dir: '/Volumes/Backup/c', volume: 'Backup', freeBytes: 900 * GB },
  ], macDirs);
  assert.strictEqual(macDisks.length, 2, 'the Mac startup disk is one disk, a mounted drive another');
  assert.strictEqual(macDisks[0].bytes, 120 * GB, 'folders on the startup disk add up');
  assert.strictEqual(macDisks[0].freeBytes, 100 * GB, 'free space from the folder that could be read');
  assert.strictEqual(P.tightestVolume(macDisks).level, 'full', '2 x 60 GB does not fit in 100 GB');
  const winDisks = P.bytesPerVolume([
    { dir: 'D:\\a', volume: 'D:', freeBytes: 10 * GB },
    { dir: 'D:\\b', volume: 'D:', freeBytes: 10 * GB },
    { dir: 'relative\\c', volume: null, freeBytes: 10 * GB },
    { dir: 'relative\\d', volume: null, freeBytes: 10 * GB },
  ], new Map([['D:\\a', 1], ['D:\\b', 2], ['relative\\c', 4], ['relative\\d', 8]]));
  assert.deepStrictEqual(winDisks.map((v) => v.bytes), [3, 4, 8], 'one drive adds up; an unlabelled Windows path stays on its own');
  assert.strictEqual(P.spaceLine(9.02e9, { volume: 'D:', freeBytes: 212 * GB }, Outputs.formatSize), 'About 8.4 GB · 212.0 GB free on D:');
  assert.strictEqual(P.spaceLine(1e7, null, Outputs.formatSize), 'About 9.5 MB');
  ok('size estimate: scaled per output, levels, wording');

  // The real sample: small test clip with audio, trust the bytes against a full encode
  const dir = fs.mkdtempSync(path.join(tmp, 'xre-estimate-'));
  const src = path.join(dir, 'clip.mov');
  const made = spawnSync(ffPath, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'prores_ks', '-profile:v', '1', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', '-shortest', src], { timeout: 120000 });
  assert.strictEqual(made.status, 0, String(made.stderr));
  const project = {
    name: 't', input: { width: 640, height: 360 },
    screens: [{ id: 's', name: 'S', width: 640, height: 360 }],
    slices: [{ id: 'a', name: 'a', screenId: 's', enabled: true, in: { x: 0, y: 0, w: 640, h: 360 }, out: { x: 0, y: 0, w: 640, h: 360 }, flip: 0, mask: null }],
  };
  const job = { src, isImage: false, transform: require('../src/shared/geometry').defaultTransform(), screen: project.screens[0] };
  const sampled = await render.sampleOutputSize({ project, job, codec: 'prores_hq', alpha: 'none', depth: 10, fps: 25, imageDuration: 1, atSec: 2 });
  assert(sampled && sampled.bytes > 0 && sampled.frames === 10 && sampled.pixels === 640 * 360, JSON.stringify(sampled));
  const png = await render.sampleOutputSize({ project, job, codec: 'png_seq', alpha: 'none', depth: 8, fps: 25, imageDuration: 1, atSec: 1 });
  assert(png && png.frames === 1 && png.bytes > 1000, 'a sequence is measured from one PNG');
  const near = await render.sampleOutputSize({ project, job, codec: 'hap_q', alpha: 'none', depth: 8, fps: 25, imageDuration: 1, atSec: 3.9 });
  assert(near && near.frames <= 3, `near the end there are few frames left: ${JSON.stringify(near)}`);
  assert.deepStrictEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`xre-estimate-${process.pid}-`)), [], 'the sample leaves nothing behind');
  const total = (b) => (b.bytes / b.frames) * 100;
  const full = path.join(dir, 'full.mov');
  const fullRun = await render.startBatch(null, {
    project, jobs: [{ ...job, outPath: full, outDir: null, label: 'x' }],
    codec: 'prores_hq', alpha: 'none', depth: 10, fps: 25, imageDuration: 1, existingPolicy: 'overwrite',
  });
  assert(fullRun[0].ok, JSON.stringify(fullRun[0]));
  const video = fs.statSync(full).size - P.audioBytes(Codecs.byId('prores_hq'), { hasAudio: true, audioChannels: 1 }, 4) - 40000; // sine is mono; some container bytes
  const ratio = total(sampled) / video;
  assert(ratio > 0.5 && ratio < 1.5, `sample is in the range of the real size: ${ratio.toFixed(2)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  ok('size estimate: real test encode, cleaned up and in range of a full export');
}

module.exports = { run };
