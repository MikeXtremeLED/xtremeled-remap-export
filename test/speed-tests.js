'use strict';
// Export speed: slices placed in one pass, Fast ProRes, graphics card encoders and when an
// export may go back to the processor. Runs on its own (node test/speed-tests.js) and from
// run-tests.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const Codecs = require('../src/shared/codecs');
const render = require('../src/main/render');

function ffmpeg(ff, args) {
  const r = spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: 180000, maxBuffer: 256 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `ffmpeg failed: ${(r.stderr || '').toString().slice(-1500)}`);
  return r;
}

function project(w, h, ow, oh, slices) {
  return {
    name: 't',
    input: { width: w, height: h },
    screens: [{ id: 'a', name: 'A', width: ow, height: oh }],
    slices: slices.map((s, i) => ({ id: 's' + i, name: 's' + i, screenId: 'a', enabled: true, inOrient: 0, outOrient: s.outOrient || 0, flip: s.flip || 0, mask: s.mask || null, in: s.in, out: s.out })),
  };
}

// Each output frame's hash, straight from the end of the real graph
function graphHashes(ff, proj, src, isImage, opts) {
  const probe = render.probeMedia(ff, src);
  const built = render.buildArgs(proj, { src, isImage, outPath: 'unused.mov', screen: proj.screens[0] }, { codec: 'prores_4444', fps: 25, imageDuration: 1, ...opts }, probe);
  const cut = built.args.indexOf('-map');
  const r = ffmpeg(ff, [...built.args.slice(0, cut + 2), '-c:v', 'rawvideo', '-f', 'framemd5', '-']);
  const lines = r.stdout.toString().split('\n').filter((l) => l && !l.startsWith('#'));
  return { composite: built.composite, args: built.args.join(' '), hashes: lines.map((l) => l.split(',').pop().trim()) };
}

function run(ok, ff, tmp) {
  return runAsync(ok, ff, tmp);
}

async function runAsync(ok, ff, tmp) {
  const dir = fs.mkdtempSync(path.join(tmp || os.tmpdir(), 'xre-speed-'));
  const file = (n) => path.join(dir, n);
  try {
    console.log('Speed test 1: when slices can be placed in one pass');
    const place = (x, y, w, h, extra) => ({ crop: { x: 0, y: 0, w, h }, place: { x, y, w, h }, ...extra });
    const plan = Codecs.pixelPlan([place(0, 0, 4, 4)], { pixFmt: 'yuv422p10le' }, {});
    const can = (slices, opts, p) => Codecs.compositePlan(slices, 100, 100, p || plan, opts);
    assert.strictEqual(can([place(0, 0, 10, 10), place(10, 0, 10, 10)]).mode, 'xstack');
    assert.strictEqual(can([place(0, 0, 10, 10)]).reason, 'single slice');
    assert.strictEqual(can([place(0, 0, 10, 10), place(5, 5, 10, 10)]).reason, 'overlapping slices');
    assert.strictEqual(can([place(0, 0, 10, 10), place(95, 0, 10, 10)]).reason, 'slice past the output edge');
    assert.strictEqual(can([place(0, 0, 10, 10), place(-1, 20, 10, 10)]).reason, 'slice past the output edge');
    assert.strictEqual(can([place(0, 0, 10, 10), place(0, 20, 10, 10, { polyMask: true })]).reason, 'polygon mask');
    assert.strictEqual(can([place(0, 0, 10, 10), place(10, 0, 10, 10)], { alpha: true }).reason, 'alpha export');
    const rgba = Codecs.pixelPlan([place(0, 0, 4, 4)], { pixFmt: 'rgba' }, {});
    assert.strictEqual(can([place(0, 0, 10, 10), place(10, 0, 10, 10)], {}, rgba).reason, 'source has alpha');
    const unknown = Codecs.pixelPlan([place(0, 0, 4, 4)], null, {});
    assert.strictEqual(can([place(0, 0, 10, 10), place(10, 0, 10, 10)], {}, unknown).reason, 'source format unknown');
    const p420 = Codecs.pixelPlan([place(0, 0, 4, 4)], { pixFmt: 'yuv420p' }, {});
    assert.strictEqual(can([place(0, 0, 10, 11), place(10, 0, 10, 10)], {}, p420).reason, 'odd canvas edge', 'pad cannot keep the last line of a 4:2:0 canvas');
    assert.strictEqual(can([place(0, 0, 10, 10), place(10, 0, 11, 10)], {}, plan).reason, 'odd canvas edge', 'pad cannot keep the last column of a 4:2:2 canvas');
    assert.strictEqual(Codecs.compositePlan([place(0, 0, 10, 10), place(10, 0, 11, 10)], 21, 10, plan).mode, 'xstack', 'a canvas the slices fill needs no pad');
    assert.strictEqual(can([place(0, 0, 100, 100), place(0, 0, 1, 1)], {}, plan).mode, 'overlay', 'overlap wins');
    ok('one pass only when no slice overlaps, clips, masks or carries alpha');

    console.log('Speed test 2: one pass gives the same pixels as slice by slice');
    const W = 320;
    const H = 64;
    const a = (x, y, w, h) => ({ x, y, w, h });
    const layouts = [
      { name: 'even row with gap and pad', out: [W + 40, H + 10], slices: [{ in: a(0, 0, 100, 40), out: a(0, 0, 100, 40) }, { in: a(100, 0, 100, 40), out: a(120, 4, 100, 40) }] },
      { name: 'odd crop and odd size', out: [W, H], slices: [{ in: a(37, 5, 101, 21), out: a(0, 0, 101, 21) }, { in: a(0, 0, 100, 22), out: a(120, 0, 100, 22) }] },
      { name: 'odd placement', out: [W, H], slices: [{ in: a(0, 0, 100, 40), out: a(31, 3, 100, 40) }, { in: a(100, 0, 100, 40), out: a(151, 3, 100, 40) }] },
      { name: 'rotated, flipped, scaled', out: [W, H * 2], slices: [{ in: a(0, 0, 40, 40), out: a(0, 0, 40, 40), outOrient: 1 }, { in: a(50, 0, 60, 30), out: a(50, 0, 60, 30), flip: 1 }, { in: a(120, 0, 60, 30), out: a(120, 0, 120, 60) }] },
    ];
    const sources = [
      { pix: 'yuv422p10le', name: 'yuv422p10le.mkv', make: (f) => ffmpeg(ff, ['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=25:duration=0.4,format=yuv422p10le`, '-c:v', 'ffv1', f]) },
      { pix: 'yuv420p', name: 'yuv420p.mkv', make: (f) => ffmpeg(ff, ['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=25:duration=0.4,format=yuv420p`, '-c:v', 'ffv1', f]) },
      { pix: 'yuv444p', name: 'yuv444p.mkv', make: (f) => ffmpeg(ff, ['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=25:duration=0.4,format=yuv444p`, '-c:v', 'ffv1', f]) },
      { pix: 'rgb24', name: 'rgb24.mkv', make: (f) => ffmpeg(ff, ['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=25:duration=0.4,format=rgb24`, '-c:v', 'ffv1', f]) },
    ];
    for (const s of sources) {
      const src = file(s.name);
      s.make(src);
      for (const l of layouts) {
        const proj = project(W, H, l.out[0], l.out[1], l.slices);
        const fast = graphHashes(ff, proj, src, false, {});
        const slow = graphHashes(ff, proj, src, false, { compositor: 'overlay' });
        assert.strictEqual(fast.composite.mode, 'xstack', `${s.pix} ${l.name} takes the fast path (${fast.composite.reason})`);
        assert.strictEqual(slow.composite.mode, 'overlay');
        assert(/xstack=inputs=\d+/.test(fast.args) && !/overlay=/.test(fast.args), `${l.name}: graph has no overlay`);
        assert(fast.hashes.length > 0, 'frames came out');
        assert.deepStrictEqual(fast.hashes, slow.hashes, `${s.pix} ${l.name}: one pass and slice by slice differ`);
      }
      ok(`${s.pix}: one pass is frame for frame identical to slice by slice`);
    }

    console.log('Speed test 3: everything else stays on the overlay path');
    {
      const src = file('yuv422p10le.mkv');
      const single = graphHashes(ff, project(W, H, W, H, [{ in: a(0, 0, 100, 40), out: a(0, 0, 100, 40) }]), src, false, {});
      assert.strictEqual(single.composite.reason, 'single slice');
      assert(/overlay=/.test(single.args) && !/xstack/.test(single.args), 'a single slice uses overlay');
      const over = graphHashes(ff, project(W, H, W, H, [{ in: a(0, 0, 100, 40), out: a(0, 0, 100, 40) }, { in: a(100, 0, 100, 40), out: a(50, 0, 100, 40) }]), src, false, {});
      assert.strictEqual(over.composite.reason, 'overlapping slices');
      assert(over.hashes.length > 0, 'overlapping slices still render');
      const past = graphHashes(ff, project(W, H, 150, H, [{ in: a(0, 0, 100, 40), out: a(0, 0, 100, 40) }, { in: a(100, 0, 100, 40), out: a(100, 0, 100, 40) }]), src, false, {});
      assert.strictEqual(past.composite.reason, 'slice past the output edge');
      assert(past.hashes.length > 0, 'clipped slice still renders');
    }
    ok('single, overlapping and clipped slices render on the overlay path');

    console.log('Speed test 4: frame count, stills and image footage');
    {
      const vfr = file('vfr.mkv');
      // 15 frames at 25 fps with every other frame pair missing: a real variable rate
      ffmpeg(ff, ['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=25:duration=1,select='not(eq(n,3)+eq(n,4)+eq(n,10)+eq(n,11))'`, '-fps_mode', 'passthrough', '-c:v', 'ffv1', vfr]);
      const proj = project(W, H, W, H, [{ in: a(0, 0, 100, 40), out: a(0, 0, 100, 40) }, { in: a(100, 0, 100, 40), out: a(100, 0, 100, 40) }]);
      const fast = graphHashes(ff, proj, vfr, false, {});
      const slow = graphHashes(ff, proj, vfr, false, { compositor: 'overlay' });
      assert.strictEqual(fast.composite.mode, 'xstack');
      assert.strictEqual(fast.hashes.length, slow.hashes.length, 'variable-rate source: same frame count');

      const png = file('still.png');
      ffmpeg(ff, ['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=1`, '-frames:v', '1', '-update', '1', png]);
      const still = graphHashes(ff, proj, png, true, { codec: 'png', depth: 8, compositor: undefined });
      const stillSlow = graphHashes(ff, proj, png, true, { codec: 'png', depth: 8, compositor: 'overlay' });
      assert.strictEqual(still.composite.mode, 'xstack');
      assert.deepStrictEqual(still.hashes, stillSlow.hashes, 'PNG still identical');
      const loop = graphHashes(ff, proj, png, true, { imageDuration: 1, fps: 50 });
      const loopSlow = graphHashes(ff, proj, png, true, { imageDuration: 1, fps: 50, compositor: 'overlay' });
      assert.strictEqual(loop.hashes.length, 50, 'image to video: exactly fps x length frames');
      assert(Math.abs(loopSlow.hashes.length - 50) <= 1, 'overlay path is within a frame of that');
      assert.deepStrictEqual([...new Set(loop.hashes)], [loopSlow.hashes[0]], 'image to video: the same picture');
    }
    ok('variable rate, PNG stills and image footage match the overlay path');

    console.log('Speed test 5: full export through the real encoder');
    {
      const src = file('rgb24.mkv');
      const proj = project(W, H, W, H, [{ in: a(0, 0, 100, 40), out: a(0, 0, 100, 40) }, { in: a(100, 0, 100, 40), out: a(100, 0, 100, 40) }]);
      for (const codec of ['h264', 'prores_hq']) {
        const out = file(`full.${codec === 'h264' ? 'mp4' : 'mov'}`);
        const res = await render.startBatch(null, { project: proj, jobs: [{ src, isImage: false, outPath: out, screen: proj.screens[0] }], codec, alpha: 'none', depth: 8, fps: 25, imageDuration: 1, existingPolicy: 'replace' });
        assert(res[0].ok, `${codec} export ok: ${JSON.stringify(res[0])}`);
        assert.deepStrictEqual(res[0].check.warnings, [], `${codec}: nothing differs from what was asked`);
      }
    }
    ok('export with the one-pass graph verifies clean');

    console.log('Speed test 6: Fast ProRes');
    {
      assert.strictEqual(Codecs.fastProresCapable('prores_hq'), true);
      assert.strictEqual(Codecs.fastProresCapable('prores_4444'), false);
      assert.strictEqual(Codecs.fastProresCapable('h264'), false);
      assert(Codecs.encoderArgs('prores_hq', { fastProres: true }).join(' ').includes('prores_aw'));
      assert(!Codecs.encoderArgs('prores_hq', {}).join(' ').includes('prores_aw'), 'off by default');
      assert(!Codecs.encoderArgs('prores_4444', { fastProres: true }).join(' ').includes('prores_aw'), '4444 keeps prores_ks');
      const caps = render.getCapabilities();
      if (caps.fastProres) {
        const src = file('yuv422p10le.mkv');
        const proj = project(W, H, W, H, [{ in: a(0, 0, 100, 40), out: a(0, 0, 100, 40) }, { in: a(100, 0, 100, 40), out: a(100, 0, 100, 40) }]);
        const out = file('fast.mov');
        const res = await render.startBatch(null, { project: proj, jobs: [{ src, isImage: false, outPath: out, screen: proj.screens[0] }], codec: 'prores_hq', alpha: 'none', depth: 10, fps: 25, imageDuration: 1, fastProres: true, existingPolicy: 'replace' });
        assert(res[0].ok, JSON.stringify(res[0]));
        const info = spawnSync(ff, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr;
        assert(/prores \(HQ\)|apch/.test(info), `Fast ProRes output is ProRes HQ: ${info}`);
      }
    }
    ok('Fast ProRes switches the 422 profiles only, and writes ProRes HQ');

    console.log('Speed test 7: graphics card encoders');
    {
      assert.deepStrictEqual(Codecs.gpuFamilies('win32'), ['qsv', 'nvenc', 'amf']);
      assert.deepStrictEqual(Codecs.gpuFamilies('darwin'), ['videotoolbox']);
      assert.deepStrictEqual(Codecs.gpuFamilies('linux'), []);
      assert.strictEqual(Codecs.gpuEncoderName('prores', 'qsv'), null, 'ProRes has no Windows hardware encoder');
      assert.strictEqual(Codecs.gpuEncoderName('hevc', 'nvenc'), 'hevc_nvenc');
      const det = { encoders: { h264: { id: 'h264_qsv', family: 'qsv', label: 'Intel Quick Sync' }, hevc: { id: 'hevc_qsv', family: 'qsv', label: 'Intel Quick Sync', depths: [8, 10] } } };
      assert.strictEqual(Codecs.gpuFor(det, 'h264', 8).id, 'h264_qsv');
      assert.strictEqual(Codecs.gpuFor(det, 'hevc', 10).id, 'hevc_qsv');
      assert.strictEqual(Codecs.gpuFor(det, 'hevc', 12), null, '12-bit stays on the processor');
      assert.strictEqual(Codecs.gpuFor(det, 'prores_hq', 10), null);
      assert.strictEqual(Codecs.gpuFor(null, 'h264', 8), null);

      for (const family of ['qsv', 'nvenc', 'amf']) {
        const base = { gpu: true, gpuFamily: family, gpuEncoder: `h264_${family}`, depth: 8 };
        const q = Codecs.encoderArgs('h264', base).join(' ');
        assert(q.includes(`-c:v h264_${family}`) && q.includes('bt709'), `${family} quality args`);
        assert(Codecs.encoderArgs('h264', { ...base, bitrateMbps: 20 }).join(' ').includes('-b:v 20M'), `${family} bitrate args`);
        const h = Codecs.encoderArgs('hevc', { ...base, gpuEncoder: `hevc_${family}`, depth: 10 }).join(' ');
        assert(h.includes('p010le') && h.includes('main10') && h.includes('hvc1'), `${family} 10-bit HEVC args`);
      }
      assert(Codecs.encoderArgs('h264', { gpu: true }).join(' ').includes('h264_videotoolbox'), 'VideoToolbox stays the macOS path');
      assert(Codecs.encoderArgs('prores_hq', { gpu: true, gpuFamily: 'videotoolbox' }).join(' ').includes('prores_videotoolbox'));

      // A real failure of the encoder, and failures that would just fail again
      const fail = (t) => `ffmpeg error (code 1):\n${t}\nConversion failed!`;
      assert.strictEqual(Codecs.isGpuFailure(fail('[h264_qsv @ 0x1] Error initializing an internal MFX session'), 'h264_qsv'), true);
      assert.strictEqual(Codecs.isGpuFailure(fail('[vost#0:0/hevc_nvenc @ 0x1] Error while opening encoder - maybe incorrect parameters'), 'hevc_nvenc'), true);
      assert.strictEqual(Codecs.isGpuFailure(fail('[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12908'), 'h264_videotoolbox'), true);
      assert.strictEqual(Codecs.isGpuFailure(fail("Unknown encoder 'h264_qsv'"), 'h264_qsv'), true);
      assert.strictEqual(Codecs.isGpuFailure(fail('[h264_amf] Failed to open AMF'), 'h264_amf'), true);
      assert.strictEqual(Codecs.isGpuFailure(fail('av_interleaved_write_frame(): No space left on device'), 'h264_qsv'), false, 'a full disk is not the encoder');
      assert.strictEqual(Codecs.isGpuFailure(fail("Error opening input: No such file or directory\nC:/gone.mov: No such file or directory"), 'hevc_nvenc'), false, 'a missing source is not the encoder');
      assert.strictEqual(Codecs.isGpuFailure(fail('Permission denied'), 'h264_qsv'), false);
      assert.strictEqual(Codecs.isGpuFailure(fail('[h264_qsv @ 0x1] encoder init ok'), 'h264_qsv'), false, 'a friendly line from the encoder is no failure');
      assert.strictEqual(Codecs.isGpuFailure(fail('anything'), null), false, 'no encoder, no retry');
      ok('encoder choice and when a failure counts as the encoder');

      // The real test on this machine: everything it reports really encodes
      render.setGpuDetection(null);
      const found = await render.detectGpu();
      assert(found && found.encoders, 'detection finishes');
      for (const [key, enc] of Object.entries(found.encoders)) {
        console.log(`    found: ${key} on ${enc.label}${enc.depths ? ` (${enc.depths.join('/')}-bit)` : ''}`);
        const opts = { gpu: true, gpuFamily: enc.family, gpuEncoder: enc.id, depth: 8 };
        const codec = key === 'prores' ? 'prores_hq' : key;
        for (const bitrateMbps of key === 'prores' ? [null] : [null, 20]) {
          const out = file(`hw-${key}-${bitrateMbps || 'q'}.${key === 'prores' ? 'mov' : 'mp4'}`);
          ffmpeg(render.ffmpegForCodec(codec), ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=0.4', ...Codecs.encoderArgs(codec, { ...opts, bitrateMbps }), out]);
        }
      }
      if (!Object.keys(found.encoders).length) console.log('    no graphics card encoder on this machine');
      ok('every encoder the detection offers really encodes on this machine');

      // A graphics encoder that breaks on a job: the job ends up on the processor, once, with a note
      const src = file('yuv420p.mkv');
      const proj = project(W, H, W, H, [{ in: a(0, 0, 100, 40), out: a(0, 0, 100, 40) }, { in: a(100, 0, 100, 40), out: a(100, 0, 100, 40) }]);
      const notes = [];
      const win = { isDestroyed: () => false, webContents: { send: (ch, ev) => { if (ev.type === 'job-note') notes.push(ev.note); } } };
      render.setGpuDetection({ encoders: { h264: { id: 'h264_nosuchencoder', family: 'qsv', label: 'Test card' } }, label: 'Test card', family: 'qsv' });
      const out = file('retry.mp4');
      const res = await render.startBatch(win, { project: proj, jobs: [{ src, isImage: false, outPath: out, screen: proj.screens[0] }], codec: 'h264', alpha: 'none', depth: 8, fps: 25, imageDuration: 1, gpu: true, existingPolicy: 'replace' });
      assert(res[0].ok, `falls back: ${JSON.stringify(res[0])}`);
      assert.strictEqual(notes.length, 1, 'one note about the fallback');
      assert(/Test card failed/.test(notes[0]), notes[0]);
      assert(/h264/.test(spawnSync(ff, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr), 'the processor wrote it');

      notes.length = 0;
      const gone = file('not-there.mkv');
      const miss = await render.startBatch(win, { project: proj, jobs: [{ src: gone, isImage: false, outPath: file('x.mp4'), screen: proj.screens[0] }], codec: 'h264', alpha: 'none', depth: 8, fps: 25, imageDuration: 1, gpu: true, existingPolicy: 'replace' });
      assert.strictEqual(miss[0].ok, false);
      assert.strictEqual(notes.length, 0, 'a missing source is not retried on the processor');
      render.setGpuDetection(null);
    }
    ok('a broken encoder goes back to the processor, a broken job does not');
  } finally {
    render.setGpuDetection(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };

if (require.main === module) {
  const caps = render.getCapabilities();
  let n = 0;
  run((name) => {
    n++;
    console.log('  ✓ ' + name);
  }, caps.proresPath).then(() => console.log(`\nSPEED TESTS: ${n} CHECKS PASSED`)).catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
  });
}
