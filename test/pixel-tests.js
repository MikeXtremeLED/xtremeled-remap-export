'use strict';
// Real pixel checks: every case runs a filter graph built by the real buildArgs on a real
// source and compares the resulting samples. Runs on its own (node test/pixel-tests.js) and
// from run-tests.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const G = require('../src/shared/geometry');
const R = require('../src/shared/resolume');
const Codecs = require('../src/shared/codecs');
const render = require('../src/main/render');

const W = 320;
const H = 64;

function ffmpeg(ff, args) {
  const r = spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `ffmpeg failed: ${(r.stderr || '').toString().slice(-1500)}`);
  return r;
}

// Decode the first frame into raw samples. Reads the pixels, not the file's own idea of them.
function rawFrame(ff, file, pix, extra) {
  return ffmpeg(ff, ['-i', file, ...(extra || []), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', pix, 'pipe:1']).stdout;
}

// Planes of a raw yuv frame, addressed by luma coordinates
function yuvPlanes(buf, pix, w, h) {
  const f = Codecs.parsePixFmt(pix);
  const bytes = f.depth > 8 ? 2 : 1;
  const cw = f.hsub ? Math.ceil(w / 2) : w;
  const ch = f.vsub ? Math.ceil(h / 2) : h;
  const uOff = w * h * bytes;
  const vOff = uOff + cw * ch * bytes;
  const rd = (off, i) => (bytes === 2 ? buf.readUInt16LE(off + i * 2) : buf[off + i]);
  const at = (off, stride) => (x, y) => rd(off, y * stride + x);
  return {
    f, w, h, cw, ch,
    y: at(0, w),
    u: (x, y) => rd(uOff, (f.vsub ? y >> 1 : y) * cw + (f.hsub ? x >> 1 : x)),
    v: (x, y) => rd(vOff, (f.vsub ? y >> 1 : y) * cw + (f.hsub ? x >> 1 : x)),
  };
}

// Source with a known value in every sample: luma by position, cb ramps with X, cr with Y.
// noisy: chroma that jumps per sample, so any chroma resampling shows up.
function makeYuvSource(ff, file, pix, noisy) {
  const f = Codecs.parsePixFmt(pix);
  const lum = f.depth > 8 ? '64+X*2+Y' : '16+mod(X*3\\,150)+Y';
  const cb = noisy ? '200+mod(X*37\\,600)' : f.depth > 8 ? '200+X*4' : '32+X/2';
  const cr = noisy ? '200+mod(Y*53\\,600)' : f.depth > 8 ? '200+Y*8' : '32+Y*2';
  ffmpeg(ff, [
    '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=25:d=0.12,format=${pix},geq=lum='${lum}':cb='${cb}':cr='${cr}'`,
    '-c:v', 'ffv1', '-pix_fmt', pix, file,
  ]);
}

function project(slices) {
  return {
    name: 't',
    input: { width: W, height: H },
    screens: [{ id: 'a', name: 'A', width: W, height: H }],
    slices: slices.map((s, i) => ({ id: 's' + i, name: 's' + i, screenId: 'a', enabled: true, in: s.in, out: s.out || { ...s.in }, inOrient: 0, outOrient: 0, flip: 0, mask: null })),
  };
}

// The real graph from buildArgs, written losslessly so nothing but the graph is measured
function runGraph(ff, proj, src, outFile, pix) {
  const probe = render.probeMedia(ff, src);
  const built = render.buildArgs(proj, { src, isImage: false, outPath: outFile, screen: proj.screens[0] }, { codec: 'prores_4444' }, probe);
  const cut = built.args.indexOf('-map');
  const args = [...built.args.slice(0, cut + 2), '-frames:v', '1', '-c:v', 'ffv1', '-pix_fmt', pix, outFile];
  const r = spawnSync(ff, ['-loglevel', 'error', ...args], { timeout: 120000 });
  assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1500));
  return built;
}

// Compare one 1:1 slice sample by sample. Luma must be exact. Chroma is exact when
// chromaTol is 0, else it may differ by that much (a resampled chroma step, not a shift).
function compareSlice(name, src, out, slice, chromaTol) {
  const { x: cx, y: cy, w, h } = slice.in;
  const { x: px, y: py } = slice.out || slice.in;
  let badY = 0;
  let maxU = 0;
  let maxV = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (out.y(px + c, py + r) !== src.y(cx + c, cy + r)) badY++;
      // Compare the chroma against the source at the same picture position. Skip the outer
      // pixels when chroma is resampled: the filter reads what lies outside the slice there.
      const margin = chromaTol ? 3 : 0;
      if (c < margin || c >= w - margin || r < margin || r >= h - margin) continue;
      maxU = Math.max(maxU, Math.abs(out.u(px + c, py + r) - src.u(cx + c, cy + r)));
      maxV = Math.max(maxV, Math.abs(out.v(px + c, py + r) - src.v(cx + c, cy + r)));
    }
  }
  assert.strictEqual(badY, 0, `${name}: ${badY} of ${w * h} luma samples wrong`);
  assert(maxU <= chromaTol, `${name}: Cb off by ${maxU}, allowed ${chromaTol}`);
  assert(maxV <= chromaTol, `${name}: Cr off by ${maxV}, allowed ${chromaTol}`);
}

async function run(ok, ff, tmp) {
  const dir = fs.mkdtempSync(path.join(tmp || os.tmpdir(), 'xre-pixel-'));
  const pixFile = (s) => path.join(dir, s);
  try {
    console.log('Pixel test 1: format parsing and the pipeline plan');
    assert.deepStrictEqual(
      ['depth', 'chroma', 'hsub', 'vsub', 'alpha'].map((k) => Codecs.parsePixFmt('yuv422p10le')[k]),
      [10, '422', 1, 0, false]
    );
    assert.strictEqual(Codecs.parsePixFmt('yuvj420p').chroma, '420');
    assert.strictEqual(Codecs.parsePixFmt('rgb48be').depth, 16);
    assert.strictEqual(Codecs.parsePixFmt('rgba').alpha, true);
    assert.strictEqual(Codecs.parsePixFmt('rgb0').alpha, false);
    assert.strictEqual(Codecs.parsePixFmt('gbrap12le').depth, 12);
    assert.strictEqual(Codecs.parsePixFmt('p010le').depth, 10);
    assert.strictEqual(Codecs.parsePixFmt('nonsense'), null);
    const planOf = (pix, extra) => Codecs.pixelPlan([{ crop: { x: 0, y: 0, w: 4, h: 4 }, place: { x: 0, y: 0, w: 4, h: 4 } }], { pixFmt: pix }, extra);
    assert.strictEqual(planOf('yuv422p10le').pix || planOf('yuv422p10le').work.pix, 'yuv422p10le');
    assert.strictEqual(planOf('rgb24').overlay, 'gbrp');
    assert.strictEqual(planOf('yuv444p').overlay, 'yuv444');
    assert.strictEqual(planOf('yuv420p12le').overlay, 'yuv420p10');
    assert.strictEqual(planOf('yuv420p12le').limited, true);
    assert.strictEqual(planOf('rgb24', { alpha: true }).basePix, 'gbrap');
    assert.strictEqual(planOf('rgba').srcPix, 'gbrap');
    assert.strictEqual(Codecs.pixelPlan([], null).limited, true);
    ok('pixel formats and pipeline plan');

    console.log('Pixel test 2: exact frame rates');
    assert.strictEqual(Codecs.exactRate(23.98), '24000/1001');
    assert.strictEqual(Codecs.exactRate(29.97), '30000/1001');
    assert.strictEqual(Codecs.exactRate(59.94), '60000/1001');
    assert.strictEqual(Codecs.exactRate(47.95), '48000/1001');
    assert.strictEqual(Codecs.exactRate(119.88), '120000/1001');
    assert.strictEqual(Codecs.exactRate(25), '25');
    assert.strictEqual(Codecs.exactRate(12.5), '12.5');
    ok('NTSC rates map to 1000/1001, others stay');
    for (const [rate, length] of [['30000/1001', 5], ['60000/1001', 3]]) {
      const src = pixFile('ntsc.mov'); // MOV keeps exact timestamps; MKV stores them in whole milliseconds
      ffmpeg(ff, ['-f', 'lavfi', '-i', `testsrc2=size=64x16:rate=${rate}:duration=${length}`, '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', src]);
      const frames = ffmpeg(ff, ['-i', src, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']).stdout.length / (64 * 16);
      assert(frames >= length * 29, `source has frames (${frames})`);
      const probe = render.probeMedia(ff, src);
      const proj = { name: 'r', input: { width: 64, height: 16 }, screens: [{ id: 'a', name: 'A', width: 64, height: 16 }], slices: [{ id: 's', name: 's', screenId: 'a', enabled: true, in: { x: 0, y: 0, w: 64, h: 16 }, out: { x: 0, y: 0, w: 64, h: 16 }, inOrient: 0, outOrient: 0, flip: 0, mask: null }] };
      const out = pixFile('ntsc-out.mkv');
      const built = render.buildArgs(proj, { src, isImage: false, outPath: out, screen: proj.screens[0] }, { codec: 'prores_4444' }, probe);
      assert(built.args.join(' ').includes(`r=${rate}`), `graph uses ${rate}`);
      const cut = built.args.indexOf('-map');
      const r = spawnSync(ff, ['-loglevel', 'error', ...built.args.slice(0, cut + 2), '-c:v', 'ffv1', out], { timeout: 180000 });
      assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
      const count = ffmpeg(ff, ['-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']).stdout.length / (64 * 16);
      assert.strictEqual(count, frames, `${rate}: ${count} frames out of ${frames}`);
    }
    ok('29.97 and 59.94: every source frame comes out');

    console.log('Pixel test 3: real pixels through buildArgs');
    const cases = [
      { name: 'even', slices: [{ in: { x: 100, y: 2, w: 100, h: 40 }, out: { x: 0, y: 0, w: 100, h: 40 } }], exact: true },
      { name: 'odd X', slices: [{ in: { x: 101, y: 2, w: 100, h: 40 }, out: { x: 0, y: 0, w: 100, h: 40 } }] },
      { name: 'odd Y', slices: [{ in: { x: 100, y: 5, w: 100, h: 40 }, out: { x: 0, y: 0, w: 100, h: 40 } }] },
      { name: 'odd W', slices: [{ in: { x: 100, y: 2, w: 101, h: 40 }, out: { x: 0, y: 0, w: 101, h: 40 } }] },
      { name: 'odd H', slices: [{ in: { x: 100, y: 2, w: 100, h: 41 }, out: { x: 0, y: 0, w: 100, h: 41 } }] },
      { name: 'odd placement', slices: [{ in: { x: 100, y: 2, w: 100, h: 40 }, out: { x: 37, y: 5, w: 100, h: 40 } }] },
      { name: 'all odd', slices: [{ in: { x: 37, y: 5, w: 101, h: 51 }, out: { x: 11, y: 3, w: 101, h: 51 } }] },
    ];
    // Chroma tolerance per source: odd slices go through a resampled chroma step.
    const formats = [
      { pix: 'yuv422p10le', tol: 8 },
      { pix: 'yuv420p10le', tol: 8 },
      { pix: 'yuv420p', tol: 3 },
      { pix: 'yuv422p', tol: 3 },
      { pix: 'yuv444p10le', tol: 8 },
    ];
    for (const { pix, tol } of formats) {
      const src = pixFile(`src-${pix}.mkv`);
      makeYuvSource(ff, src, pix);
      const srcPlanes = yuvPlanes(rawFrame(ff, src, pix), pix, W, H);
      for (const c of cases) {
        const out = pixFile(`out-${pix}-${c.name.replace(/ /g, '_')}.mkv`);
        runGraph(ff, project(c.slices), src, out, pix);
        const outPlanes = yuvPlanes(rawFrame(ff, out, pix), pix, W, H);
        const allow = c.exact || Codecs.parsePixFmt(pix).chroma === '444' ? 0 : tol;
        compareSlice(`${pix} ${c.name}`, srcPlanes, outPlanes, c.slices[0], allow);
      }
      ok(`${pix}: luma exact, chroma correct on even and odd slices`);
    }

    // The odd slice's 4:4:4 step must not reach the slice next to it
    {
      const pix = 'yuv422p10le';
      const src = pixFile('src-noisy.mkv');
      makeYuvSource(ff, src, pix, true);
      const srcPlanes = yuvPlanes(rawFrame(ff, src, pix), pix, W, H);
      const even = { in: { x: 0, y: 0, w: 100, h: 30 }, out: { x: 0, y: 0, w: 100, h: 30 } };
      const odd = { in: { x: 201, y: 0, w: 60, h: 30 }, out: { x: 120, y: 0, w: 60, h: 30 } };
      const out = pixFile('mixed.mkv');
      runGraph(ff, project([even, odd]), src, out, pix);
      const outPlanes = yuvPlanes(rawFrame(ff, out, pix), pix, W, H);
      compareSlice('even slice next to an odd one', srcPlanes, outPlanes, even, 0);
      ok('an odd slice leaves its even neighbour bit-exact, also on noisy chroma');
    }

    {
      // RGB to PNG: the real export, compared byte for byte
      const src = pixFile('rgb.png');
      ffmpeg(ff, ['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:d=0.04,format=gbrp,geq=r='mod(X*7+Y*3\\,256)':g='mod(X*13+Y\\,256)':b='mod(Y*11+X*5\\,256)'`, '-frames:v', '1', '-update', '1', src]);
      const whole = rawFrame(ff, src, 'rgb24');
      for (const c of cases) {
        const out = pixFile(`rgb-${c.name.replace(/ /g, '_')}.png`);
        const proj = project(c.slices);
        const built = render.buildArgs(proj, { src, isImage: true, outPath: out, screen: proj.screens[0] }, { codec: 'png', depth: 8 }, render.probeMedia(ff, src));
        const r = spawnSync(ff, built.args, { timeout: 60000 });
        assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
        const got = rawFrame(ff, out, 'rgb24');
        const { in: i, out: o } = c.slices[0];
        let diff = 0;
        for (let row = 0; row < i.h; row++) {
          const a = whole.subarray((i.y + row) * W * 3 + i.x * 3, (i.y + row) * W * 3 + (i.x + i.w) * 3);
          const b = got.subarray((o.y + row) * W * 3 + o.x * 3, (o.y + row) * W * 3 + (o.x + i.w) * 3);
          for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) diff++;
        }
        assert.strictEqual(diff, 0, `RGB ${c.name}: ${diff} bytes differ`);
      }
      ok('RGB to PNG: 0 bytes differ, on even and odd slices');

      // 1-pixel red/green columns: the detail 4:2:0 used to smear
      const colSrc = pixFile('cols.png');
      ffmpeg(ff, ['-f', 'lavfi', '-i', `nullsrc=s=64x16:d=0.04,format=gbrp,geq=r='255*mod(X\\,2)':g='255*(1-mod(X\\,2))':b='0'`, '-frames:v', '1', '-update', '1', colSrc]);
      const colOut = pixFile('cols-out.png');
      const colProj = { name: 'c', input: { width: 64, height: 16 }, screens: [{ id: 'a', name: 'A', width: 64, height: 16 }], slices: [{ id: 's', name: 's', screenId: 'a', enabled: true, in: { x: 1, y: 0, w: 60, h: 16 }, out: { x: 3, y: 0, w: 60, h: 16 }, inOrient: 0, outOrient: 0, flip: 0, mask: null }] };
      const b2 = render.buildArgs(colProj, { src: colSrc, isImage: true, outPath: colOut, screen: colProj.screens[0] }, { codec: 'png', depth: 8 }, render.probeMedia(ff, colSrc));
      const r2 = spawnSync(ff, b2.args, { timeout: 60000 });
      assert.strictEqual(r2.status, 0);
      const inC = rawFrame(ff, colSrc, 'rgb24');
      const outC = rawFrame(ff, colOut, 'rgb24');
      let colDiff = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 60 * 3; x++) {
        if (inC[y * 64 * 3 + 3 + x] !== outC[y * 64 * 3 + 9 + x]) colDiff++;
      }
      assert.strictEqual(colDiff, 0, `1-pixel columns: ${colDiff} bytes differ`);
      ok('1-pixel red/green columns: 0 bytes differ');
    }

    console.log('Pixel test 4: color tags');
    {
      const red = pixFile('red.png');
      ffmpeg(ff, ['-f', 'lavfi', '-i', 'color=c=0xFF0000:s=64x32:d=0.04,format=rgb24', '-frames:v', '1', '-update', '1', red]);
      const proj = { name: 'c', input: { width: 64, height: 32 }, screens: [{ id: 'a', name: 'A', width: 64, height: 32 }], slices: [{ id: 's', name: 's', screenId: 'a', enabled: true, in: { x: 0, y: 0, w: 64, h: 32 }, out: { x: 0, y: 0, w: 64, h: 32 }, inOrient: 0, outOrient: 0, flip: 0, mask: null }] };
      for (const codec of ['h264', 'hevc', 'prores_4444']) {
        const out = pixFile(`red-${codec}.${codec === 'prores_4444' ? 'mov' : 'mp4'}`);
        const opts = { codec, fps: 5, imageDuration: 1, depth: 8 };
        const built = render.buildArgs(proj, { src: red, isImage: true, outPath: out, screen: proj.screens[0] }, opts, render.probeMedia(ff, red));
        assert(built.args.includes('-colorspace'), `${codec} is tagged`);
        const r = spawnSync(render.ffmpegForCodec(codec) || ff, built.args, { timeout: 120000 });
        assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
        const px = rawFrame(ff, out, 'rgb24');
        assert(px[0] >= 250 && px[1] <= 8 && px[2] <= 8, `${codec}: red decodes as ${px[0]},${px[1]},${px[2]}`);
        const info = spawnSync(ff, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr;
        const video = (info.match(/Video:.*/) || [''])[0];
        assert(/bt709, progressive|\bbt709\b(?!\/unknown)/.test(video) && !/unknown/.test(video), `${codec}: output carries full BT.709 tags: ${video}`);
      }
      ok('RGB source: H.264, HEVC and ProRes 4444 decode to pure red and carry BT.709');

      const vt = (codec, depth) => Codecs.encoderArgs(codec, { gpu: true, gpuFamily: 'videotoolbox', depth });
      const pixOf = (args) => args[args.indexOf('-pix_fmt') + 1];
      assert.strictEqual(pixOf(vt('hevc', 8)), 'yuv420p', 'HEVC VideoToolbox at 8-bit stays 8-bit');
      assert.strictEqual(pixOf(vt('hevc', 10)), 'p010le', 'HEVC VideoToolbox at 10-bit');
      assert.strictEqual(pixOf(vt('h264', 8)), 'yuv420p', 'H.264 VideoToolbox stays 8-bit');
      const odd12 = Codecs.pixelPlan([{ crop: { x: 0, y: 0, w: 64, h: 16 }, place: { x: 1, y: 0, w: 64, h: 16 } }], { pixFmt: 'yuv422p12le' }, {});
      assert(odd12.limited && /12-bit/.test(odd12.reason), `a depth limit stays in the card text: ${odd12.reason}`);
      ok('VideoToolbox keeps the chosen depth; the card names the real limit');

      // An untagged YUV source must keep its values; only the tag is added
      const yuv = pixFile('untagged.mkv');
      ffmpeg(ff, ['-f', 'lavfi', '-i', 'color=c=0x3080C0:s=64x32:d=0.2:r=25,format=yuv420p', '-c:v', 'ffv1', yuv]);
      const yuvProj = JSON.parse(JSON.stringify(proj));
      const before = yuvPlanes(rawFrame(ff, yuv, 'yuv420p'), 'yuv420p', 64, 32);
      const out = pixFile('untagged-out.mp4');
      const built = render.buildArgs(yuvProj, { src: yuv, isImage: false, outPath: out, screen: yuvProj.screens[0] }, { codec: 'h264' }, render.probeMedia(ff, yuv));
      const r = spawnSync(ff, built.args, { timeout: 120000 });
      assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
      const after = yuvPlanes(rawFrame(ff, out, 'yuv420p'), 'yuv420p', 64, 32);
      const deltas = [before.y(30, 15) - after.y(30, 15), before.u(30, 15) - after.u(30, 15), before.v(30, 15) - after.v(30, 15)];
      assert(deltas.every((d) => Math.abs(d) <= 2), `untagged YUV changed by ${deltas}`);
      ok('untagged YUV source keeps its values through a tagged encoder');
    }

    console.log('Pixel test 5: trim never starts black');
    {
      const grey = pixFile('grey.mkv');
      ffmpeg(ff, ['-f', 'lavfi', '-i', 'color=c=0x808080:s=64x16:r=25:d=3', '-c:v', 'ffv1', grey]);
      const proj = { name: 't', input: { width: 64, height: 16 }, screens: [{ id: 'a', name: 'A', width: 64, height: 16 }], slices: [{ id: 's', name: 's', screenId: 'a', enabled: true, in: { x: 0, y: 0, w: 64, h: 16 }, out: { x: 0, y: 0, w: 64, h: 16 }, inOrient: 0, outOrient: 0, flip: 0, mask: null }] };
      const probe = render.probeMedia(ff, grey);
      const out = pixFile('trim.mov');
      let built = render.buildArgs(proj, { src: grey, isImage: false, outPath: out, screen: proj.screens[0], inSec: 1.013, outSec: 2.013 }, { codec: 'prores_lt' }, probe);
      let r = spawnSync(ff, built.args, { timeout: 120000 });
      assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
      assert(rawFrame(ff, out, 'gray')[0] > 80, 'first frame of a trim is picture, not black');
      const seqDir = pixFile('seq');
      fs.mkdirSync(seqDir);
      built = render.buildArgs(proj, { src: grey, isImage: false, outPath: path.join(seqDir, 'f_%05d.png'), screen: proj.screens[0], inSec: 1.013, outSec: 1.3 }, { codec: 'png_seq', depth: 8 }, probe);
      r = spawnSync(ff, built.args, { timeout: 120000 });
      assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
      const first = fs.readdirSync(seqDir).sort()[0];
      assert(rawFrame(ff, path.join(seqDir, first), 'gray')[0] > 80, 'first PNG of a trim is picture, not black');
      ok('trim on a non-frame in-point starts with picture (video and PNG sequence)');
    }

    console.log('Pixel test 6: alpha sources and the alpha pipeline');
    {
      const rgba = pixFile('alpha.png');
      // Left half opaque red, right half fully transparent with hidden blue
      ffmpeg(ff, ['-f', 'lavfi', '-i', `nullsrc=s=64x16:d=0.04,format=gbrap,geq=r='255*lt(X\\,32)':g='0':b='255*gte(X\\,32)':a='255*lt(X\\,32)'`, '-frames:v', '1', '-update', '1', rgba]);
      const proj = { name: 'a', input: { width: 64, height: 16 }, screens: [{ id: 'a', name: 'A', width: 64, height: 16 }], slices: [{ id: 's', name: 's', screenId: 'a', enabled: true, in: { x: 0, y: 0, w: 64, h: 16 }, out: { x: 0, y: 0, w: 64, h: 16 }, inOrient: 0, outOrient: 0, flip: 0, mask: null }] };
      const probe = render.probeMedia(ff, rgba);
      const out = pixFile('alpha-flat.png');
      let built = render.buildArgs(proj, { src: rgba, isImage: true, outPath: out, screen: proj.screens[0] }, { codec: 'png', depth: 8 }, probe);
      let r = spawnSync(ff, built.args, { timeout: 60000 });
      assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
      let px = rawFrame(ff, out, 'rgb24');
      assert.deepStrictEqual([px[0], px[1], px[2]], [255, 0, 0], 'opaque part stays red');
      const hidden = 3 * 16 * 8 + 3 * 48;
      assert.deepStrictEqual([px[hidden], px[hidden + 1], px[hidden + 2]], [0, 0, 0], 'transparent part is black, hidden color stays hidden');
      ok('source with alpha: composited over black, no hidden color leak');

      const straight = pixFile('alpha-straight.png');
      built = render.buildArgs(proj, { src: rgba, isImage: true, outPath: straight, screen: proj.screens[0] }, { codec: 'png', alpha: 'straight', depth: 8 }, probe);
      r = spawnSync(ff, built.args, { timeout: 60000 });
      assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
      px = rawFrame(ff, straight, 'rgba');
      assert.deepStrictEqual([px[0], px[1], px[2], px[3]], [255, 0, 0, 255], 'alpha pipeline keeps color and alpha');
      const hiddenA = 4 * 16 * 8 + 4 * 48;
      assert.strictEqual(px[hiddenA + 3], 0, 'transparent stays transparent');
      const only = pixFile('alpha-only.png');
      built = render.buildArgs(proj, { src: rgba, isImage: true, outPath: only, screen: proj.screens[0] }, { codec: 'png', alpha: 'only', depth: 8 }, probe);
      r = spawnSync(ff, built.args, { timeout: 60000 });
      assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
      const gray = rawFrame(ff, only, 'gray');
      assert.deepStrictEqual([gray[0], gray[16 * 8 + 48]], [255, 0], 'alpha-only is white where opaque, black where transparent');
      ok('alpha pipeline: straight and alpha-only stay exact');

      const yuva = pixFile('yuva.mov');
      ffmpeg(ff, ['-f', 'lavfi', '-i', 'color=c=0x3080C0:s=64x16:r=25:d=0.2,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4', yuva]);
      const prOut = pixFile('yuva-out.mov');
      built = render.buildArgs(proj, { src: yuva, isImage: false, outPath: prOut, screen: proj.screens[0] }, { codec: 'prores_4444', alpha: 'straight' }, render.probeMedia(ff, yuva));
      const yuvaGraph = built.args.join(' ');
      assert(/format=gbrap/.test(yuvaGraph) && /format=gbrp/.test(yuvaGraph), 'alpha pipeline composites in 8-bit RGBA');
      assert(!/yuv444p10|yuva444p10/.test(yuvaGraph.split('-map')[0]), 'no 10-bit overlay with an alpha main');
      r = spawnSync(ff, built.args, { timeout: 120000 });
      assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
      ok('10-bit source through the alpha pipeline');

      // Colour must survive at partial alpha. Solid alpha never shows this: ffmpeg's 10-bit
      // overlay only miscalculates pixels with 0 < alpha < max.
      const raw444a = (file) => {
        const b = rawFrame(ff, file, 'yuva444p10le');
        const at = (plane, x, y) => b.readUInt16LE(2 * (plane * 64 * 16 + y * 64 + x));
        return { y: (x, y) => at(0, x, y), u: (x, y) => at(1, x, y), v: (x, y) => at(2, x, y), a: (x, y) => at(3, x, y) };
      };
      const near = (got, want, tol, what) => assert(Math.abs(got - want) <= tol, `${what}: ${got}, expected ${want} +-${tol}`);
      const softFfv1 = pixFile('soft-10.mkv');
      ffmpeg(ff, ['-f', 'lavfi', '-i', `nullsrc=s=64x16:r=25:d=0.12,format=yuva444p10le,geq=lum='700':cb='300':cr='600':a='X*16'`, '-c:v', 'ffv1', '-pix_fmt', 'yuva444p10le', softFfv1]);
      const softProres = pixFile('soft-12.mov');
      ffmpeg(ff, ['-i', softFfv1, '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', softProres]);
      for (const [label, src] of [['10-bit FFV1', softFfv1], ['ProRes 4444', softProres]]) {
        const probeSoft = render.probeMedia(ff, src);
        const planSoft = Codecs.pixelPlan(G.effectiveSlices(proj), probeSoft, { alpha: true });
        assert.strictEqual(planSoft.limited, true, `${label}: the card must not promise the source depth`);
        const inPx = raw444a(src);
        const out2 = pixFile(`soft-out-${label.replace(/\W/g, '')}.mov`);
        built = render.buildArgs(proj, { src, isImage: false, outPath: out2, screen: proj.screens[0] }, { codec: 'prores_4444', alpha: 'straight', depth: 10 }, probeSoft);
        r = spawnSync(ff, built.args, { timeout: 120000 });
        assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
        const outPx = raw444a(out2);
        for (const x of [4, 16, 32, 48, 60]) {
          near(outPx.y(x, 8), inPx.y(x, 8), 10, `${label} X${x} luma`);
          near(outPx.u(x, 8), inPx.u(x, 8), 10, `${label} X${x} Cb`);
          near(outPx.v(x, 8), inPx.v(x, 8), 10, `${label} X${x} Cr`);
          near(outPx.a(x, 8), inPx.a(x, 8), 10, `${label} X${x} alpha`);
        }

        // Without the alpha pipeline the same pixels are composited over black
        const flat = pixFile(`soft-flat-${label.replace(/\W/g, '')}.mov`);
        built = render.buildArgs(proj, { src, isImage: false, outPath: flat, screen: proj.screens[0] }, { codec: 'prores_4444', alpha: 'none', depth: 10 }, probeSoft);
        r = spawnSync(ff, built.args, { timeout: 120000 });
        assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
        const flatPx = raw444a(flat);
        for (const x of [16, 32, 48]) {
          const k = inPx.a(x, 8) / 1023;
          near(flatPx.y(x, 8), 64 + (inPx.y(x, 8) - 64) * k, 10, `${label} over black X${x} luma`);
          near(flatPx.u(x, 8), 512 + (inPx.u(x, 8) - 512) * k, 10, `${label} over black X${x} Cb`);
        }
      }
      ok('10-bit semi-transparent source: colour and alpha stay correct at partial alpha');

      // The soft edge of a polygon mask goes through the same overlay
      const opaque = pixFile('opaque-10.mkv');
      ffmpeg(ff, ['-f', 'lavfi', '-i', `nullsrc=s=64x16:r=25:d=0.12,format=yuv444p10le,geq=lum='700':cb='300':cr='600'`, '-c:v', 'ffv1', '-pix_fmt', 'yuv444p10le', opaque]);
      const maskPng = pixFile('mask.png');
      ffmpeg(ff, ['-f', 'lavfi', '-i', `nullsrc=s=64x16:d=0.04,format=gray,geq=lum='X*4'`, '-frames:v', '1', '-update', '1', maskPng]);
      const masked = JSON.parse(JSON.stringify(proj));
      masked.slices[0].mask = { enabled: true, points: [{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: 0, y: 16 }] };
      const maskOut = pixFile('mask-out.mov');
      const inMask = raw444a(opaque);
      built = render.buildArgs(masked, { src: opaque, isImage: false, outPath: maskOut, screen: masked.screens[0], maskFiles: { s: maskPng } }, { codec: 'prores_4444', alpha: 'straight', depth: 10 }, render.probeMedia(ff, opaque));
      r = spawnSync(ff, built.args, { timeout: 120000 });
      assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
      const outMask = raw444a(maskOut);
      for (const x of [8, 24, 40, 56]) {
        near(outMask.y(x, 8), inMask.y(x, 8), 10, `mask X${x} luma`);
        near(outMask.u(x, 8), inMask.u(x, 8), 10, `mask X${x} Cb`);
        near(outMask.a(x, 8), Math.round(((x * 4) / 255) * 1023), 12, `mask X${x} alpha`);
      }
      ok('polygon mask on a 10-bit source: colour and alpha stay correct on the soft edge');
    }

    console.log('Pixel test 7: half-pixel coordinates from Resolume');
    {
      const rect = (x, y, w, h) => `<v x="${x}" y="${y}"/><v x="${x + w}" y="${y}"/><v x="${x + w}" y="${y + h}"/><v x="${x}" y="${y + h}"/>`;
      const sl = (id, x, w) => `<Slice uniqueId="${id}"><Params name="Common"><Param name="Name" value="S${id}"/></Params><InputRect orientation="0">${rect(x, 0, w, 50)}</InputRect><OutputRect orientation="0">${rect(x, 0, w, 50)}</OutputRect></Slice>`;
      const xml = `<XmlState name="x"><ScreenSetup name="s"><sizing><inputs><InputSize name="0:1" width="1000" height="100"/></inputs></sizing><screens><Screen name="S"><layers>${sl(1, 100.5, 200.5)}${sl(2, 301, 99)}</layers><OutputDevice><OutputDeviceVirtual width="1000" height="100"/></OutputDevice></Screen></screens></ScreenSetup></XmlState>`;
      const p = R.parseScreenSetup(xml);
      const [a, b] = p.slices;
      assert.strictEqual(a.in.x + a.in.w, b.in.x, 'neighbouring input edges meet');
      assert.strictEqual(a.out.x + a.out.w, b.out.x, 'neighbouring output edges meet');
      const eff = G.effectiveSlices({ ...p, slices: [{ ...a, out: { x: 100.5, y: 0, w: 200.5, h: 50 } }, { ...b, out: { x: 301, y: 0, w: 99, h: 50 } }] });
      assert.strictEqual(eff[0].place.x + eff[0].place.w, eff[1].place.x, 'placed edges meet');
      ok('half-pixel slices: adjoining edges meet, no overlap');
    }

    console.log('Pixel test 8: Pixel check card');
    {
      const slices = [{ crop: { x: 1, y: 0, w: 3, h: 2 }, place: { x: 0, y: 0, w: 3, h: 2 } }];
      const plan = Codecs.pixelPlan(slices, { pixFmt: 'yuv422p10le' }, {});
      const rows = Codecs.pixelCheckRows(plan, 'prores_hq', 23.98, false);
      assert.strictEqual(rows.find((r) => r.key === 'Processing').value, '10-bit 4:2:2 (matches source)');
      assert.strictEqual(rows.find((r) => r.key === 'Odd slices').value, '1 cropped exactly');
      assert.strictEqual(rows.find((r) => r.key === 'Frame rate').value, '24000/1001 (exact)');
      assert.strictEqual(rows.find((r) => r.key === 'Color tags').value, 'BT.709');
      assert.strictEqual(Codecs.pixelCheckRows(plan, 'hap', 25, false).find((r) => r.key === 'Color tags').value, 'not used (RGB output)');
      const twelve = Codecs.pixelCheckRows(Codecs.pixelPlan(slices, { pixFmt: 'yuv420p12le' }, {}), 'prores_hq', 25, false)[0];
      assert.strictEqual(twelve.ok, false, 'a limited pipeline gets no green check');
      assert.strictEqual(twelve.value, '10-bit 4:2:0 (source is 12-bit)');
      const adj = Codecs.pixelPlan(slices, { pixFmt: 'yuv422p10le' }, { transform: { brightness: 0.1 } });
      assert.strictEqual(Codecs.pixelCheckRows(adj, 'prores_hq', 25, false)[0].ok, false, 'a color adjust is flagged');
      const alphaRow = (pix) => {
        const p = Codecs.pixelPlan(slices, { pixFmt: pix }, { alpha: true });
        return { plan: p, row: Codecs.pixelCheckRows(p, 'prores_4444', 25, false)[0] };
      };
      for (const [pix, value] of [
        ['yuva444p12le', '8-bit RGB (alpha export, source is 12-bit)'],
        ['yuva444p10le', '8-bit RGB (alpha export, source is 10-bit)'],
        ['rgba64be', '8-bit RGB (alpha export, source is 16-bit)'],
        ['gbrap12le', '8-bit RGB (alpha export, source is 12-bit)'],
        ['gray16be', '8-bit RGB (alpha export, source is 16-bit)'],
        ['gbrap10le', '8-bit RGB (alpha export, source is 10-bit)'],
      ]) {
        const { plan: p, row } = alphaRow(pix);
        assert.strictEqual(row.ok, false, `alpha export from ${pix} gets no green check`);
        assert.strictEqual(row.value, value);
        assert.strictEqual(p.limited, true, pix);
        assert.strictEqual(p.matchesSource, false, pix);
      }
      assert.strictEqual(alphaRow('rgba').row.value, '8-bit RGB (matches source)');
      assert.strictEqual(alphaRow('yuva444p').row.value, '8-bit RGB (alpha export)');
      assert.strictEqual(alphaRow('yuva444p').row.ok, true, '8-bit YUV alpha loses no depth');
      assert.strictEqual(Codecs.pixelPlan(slices, null, { alpha: true }).overlay, 'gbrp', 'unknown source with alpha stays out of the 10-bit overlay');
      assert.strictEqual(Codecs.pixelPlan(slices, null, { alpha: true }).limited, true);
      ok('Pixel check card tells what the export really does');
    }
  } finally {
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
  }, caps.proresPath).then(() => console.log(`\nPIXEL TESTS: ${n} CHECKS PASSED`)).catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
  });
}
