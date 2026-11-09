'use strict';
// The release side: golden pixels through rotation, flip and masks, the export job builder,
// update check, ffmpeg pin, install check and the per-export log.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ExportPlan = require('../src/shared/exportplan');
const AppInfo = require('../src/shared/appinfo');
const Codecs = require('../src/shared/codecs');
const Maintenance = require('../src/main/app-info');
const ExportLog = require('../src/main/export-log');
const render = require('../src/main/render');
const Fetch = require('../tools/fetch-ffmpeg');
const Install = require('../tools/check-install');

const W = 64;
const H = 32;

function ffmpeg(ff, args) {
  const r = spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `ffmpeg failed: ${(r.stderr || '').toString().slice(-1000)}`);
  return r;
}

const rawRgb = (ff, file) => ffmpeg(ff, ['-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).stdout;

function slice(s) {
  return { id: s.id || 's', name: s.id || 's', screenId: 'a', enabled: true, in: s.in, out: s.out, inOrient: 0, outOrient: s.rot || 0, flip: s.flip || 0, mask: s.mask || null };
}

function proj(slices, sw, sh) {
  return { name: 'g', input: { width: W, height: H }, screens: [{ id: 'a', name: 'A', width: sw, height: sh }], slices: slices.map(slice) };
}

// Where an output pixel of a 1:1 slice comes from: written out from what rotation and flip
// mean on the wall, independent of the code that builds the filter graph.
function sourceOf(s, ox, oy) {
  const iw = s.in.w;
  const ih = s.in.h;
  const rw = s.rot === 90 || s.rot === 270 ? ih : iw;
  const rh = s.rot === 90 || s.rot === 270 ? iw : ih;
  let x = ox;
  let y = oy;
  if ((s.flip || 0) & 1) x = rw - 1 - x;
  if ((s.flip || 0) & 2) y = rh - 1 - y;
  let sx = x;
  let sy = y;
  if (s.rot === 90) { sx = y; sy = ih - 1 - x; }
  else if (s.rot === 180) { sx = iw - 1 - x; sy = ih - 1 - y; }
  else if (s.rot === 270) { sx = iw - 1 - y; sy = x; }
  return { x: s.in.x + sx, y: s.in.y + sy };
}

function renderPng(ff, project, src, out, maskFiles) {
  const built = render.buildArgs(project, { src, isImage: true, outPath: out, screen: project.screens[0], maskFiles }, { codec: 'png', depth: 8 }, render.probeMedia(ff, src));
  const r = spawnSync(ff, built.args, { timeout: 60000 });
  assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
  return rawRgb(ff, out);
}

async function goldenTests(ok, ff, dir) {
  console.log('Golden pixels: rotation, flip, masks (PNG, exact)');
  const src = path.join(dir, 'src.png');
  // Every pixel unique: red counts X, green counts Y
  ffmpeg(ff, ['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:d=0.04,format=gbrp,geq=r='X*4':g='Y*8':b='100'`, '-frames:v', '1', '-update', '1', src]);
  const srcRaw = rawRgb(ff, src);
  const at = (buf, stride, x, y) => [buf[y * stride * 3 + x * 3], buf[y * stride * 3 + x * 3 + 1], buf[y * stride * 3 + x * 3 + 2]];

  const SW = 80;
  const SH = 64;
  const cases = [
    { name: 'plain', s: { in: { x: 4, y: 2, w: 24, h: 16 }, out: { x: 7, y: 9, w: 24, h: 16 } } },
    { name: 'rotate 90', s: { in: { x: 4, y: 2, w: 24, h: 16 }, out: { x: 30, y: 20, w: 16, h: 24 }, rot: 90 } },
    { name: 'rotate 180', s: { in: { x: 4, y: 2, w: 24, h: 16 }, out: { x: 30, y: 20, w: 24, h: 16 }, rot: 180 } },
    { name: 'rotate 270', s: { in: { x: 4, y: 2, w: 24, h: 16 }, out: { x: 30, y: 20, w: 16, h: 24 }, rot: 270 } },
    { name: 'flip H', s: { in: { x: 11, y: 3, w: 24, h: 16 }, out: { x: 5, y: 5, w: 24, h: 16 }, flip: 1 } },
    { name: 'flip V', s: { in: { x: 11, y: 3, w: 24, h: 16 }, out: { x: 5, y: 5, w: 24, h: 16 }, flip: 2 } },
    { name: 'flip H+V', s: { in: { x: 11, y: 3, w: 24, h: 16 }, out: { x: 5, y: 5, w: 24, h: 16 }, flip: 3 } },
    { name: 'rotate 90 + flip H', s: { in: { x: 4, y: 2, w: 24, h: 16 }, out: { x: 30, y: 20, w: 16, h: 24 }, rot: 90, flip: 1 } },
  ];
  for (const c of cases) {
    const out = path.join(dir, `g-${c.name.replace(/\W/g, '_')}.png`);
    const got = renderPng(ff, proj([c.s], SW, SH), src, out);
    let wrong = 0;
    for (let oy = 0; oy < c.s.out.h; oy++) {
      for (let ox = 0; ox < c.s.out.w; ox++) {
        const from = sourceOf(c.s, ox, oy);
        const want = at(srcRaw, W, from.x, from.y);
        const have = at(got, SW, c.s.out.x + ox, c.s.out.y + oy);
        if (want[0] !== have[0] || want[1] !== have[1] || want[2] !== have[2]) wrong++;
      }
    }
    assert.strictEqual(wrong, 0, `${c.name}: ${wrong} pixels wrong`);
    // Nothing outside the slice
    let outside = 0;
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const inside = x >= c.s.out.x && x < c.s.out.x + c.s.out.w && y >= c.s.out.y && y < c.s.out.y + c.s.out.h;
        if (!inside && at(got, SW, x, y).some((v) => v !== 0)) outside++;
      }
    }
    assert.strictEqual(outside, 0, `${c.name}: ${outside} pixels lit outside the slice`);
  }
  ok('rotated and flipped slices: every output pixel is the right source pixel');

  // A rectangle mask takes the crop path: inside exact, outside black
  const rectMaskSlice = { in: { x: 0, y: 0, w: W, h: H }, out: { x: 0, y: 0, w: W, h: H }, mask: { enabled: true, points: [{ x: 10, y: 4 }, { x: 30, y: 4 }, { x: 30, y: 20 }, { x: 10, y: 20 }] } };
  const rectOut = renderPng(ff, proj([rectMaskSlice], W, H), src, path.join(dir, 'g-rectmask.png'));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= 10 && x < 30 && y >= 4 && y < 20;
      assert.deepStrictEqual(at(rectOut, W, x, y), inside ? at(srcRaw, W, x, y) : [0, 0, 0], `rect mask at ${x},${y}`);
    }
  }
  ok('rectangle mask: exact inside, black outside');

  // A polygon goes through the raster path; a hard-edged mask must not change any pixel it keeps
  const maskPng = path.join(dir, 'g-mask.png');
  ffmpeg(ff, ['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:d=0.04,format=gray,geq=lum='255*lt(X\\,20)'`, '-frames:v', '1', '-update', '1', maskPng]);
  const polySlice = { id: 'p', in: { x: 0, y: 0, w: W, h: H }, out: { x: 0, y: 0, w: W, h: H }, mask: { enabled: true, points: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: 0, y: H }] } };
  const polyOut = renderPng(ff, proj([polySlice], W, H), src, path.join(dir, 'g-poly.png'), { p: maskPng });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      assert.deepStrictEqual(at(polyOut, W, x, y), x < 20 ? at(srcRaw, W, x, y) : [0, 0, 0], `polygon mask at ${x},${y}`);
    }
  }
  ok('polygon mask: exact where kept, black where cut');
}

async function jobTests(ok, ff, dir) {
  console.log('Export job builder');
  const screens = [{ id: 'a', name: 'Left', width: 64, height: 32 }, { id: 'b', name: 'Right', width: 64, height: 32 }];
  const twoScreens = { name: 'j', input: { width: W, height: H }, screens, slices: [] };
  const merged = { name: 'm', input: { width: W, height: H }, screens: [{ id: 'm', name: 'Merged', width: 128, height: 32 }], slices: [] };
  const files = [{ path: path.join(dir, 'clip one.mov'), isImage: false, inSec: 1, outSec: 2, transform: { x: 3 }, frameTime: 1.5 }];
  const io = {
    fitSize: (s) => ({ width: s.width, height: s.height, rule: { strict: false } }),
    maskFilesFor: async (p, id) => ({ owner: `${p.name}:${id}` }),
    pathParse: async (p) => ({ dir: path.dirname(p), base: path.basename(p, path.extname(p)), ext: path.extname(p) }),
    pathJoin: async (...parts) => path.join(...parts),
    folderFor: () => dir,
    stemFor: (f, pp) => pp.base,
    labelFor: (f) => path.basename(f.path),
    sanitizeName: (s) => s.toLowerCase(),
  };
  const base = { project: twoScreens, merged, files, codecId: 'prores_hq', codecDef: Codecs.byId('prores_hq'), alpha: 'none', padAccepted: false };

  const sep = await ExportPlan.buildJobs({ ...base, outMode: 'separate' }, io);
  assert.deepStrictEqual(sep.map((j) => j.screen.id), ['a', 'b']);
  assert(sep[0].outPath.endsWith('.mov') && /_left/.test(path.basename(sep[0].outPath)), `screen suffix in ${sep[0].outPath}`);
  assert.strictEqual(sep[0].label, 'clip one.mov → Left');
  assert.deepStrictEqual(sep[1].maskFiles, { owner: 'j:b' });
  assert.strictEqual(sep[0].project, undefined, 'separate outputs use the main project');
  assert.strictEqual(sep[0].inSec, 1);
  assert.strictEqual(sep[0].pngTime, 0, 'video codecs have no still time');

  const both = await ExportPlan.buildJobs({ ...base, outMode: 'both' }, io);
  assert.strictEqual(both.length, 3);
  assert.strictEqual(both[2].project, merged);
  assert(/_merged/.test(path.basename(both[2].outPath)));
  assert.deepStrictEqual(both[2].maskFiles, { owner: 'm:m' });

  const single = await ExportPlan.buildJobs({ ...base, project: { ...twoScreens, screens: [screens[0]] }, outMode: 'separate' }, io);
  assert.strictEqual(single[0].label, 'clip one.mov', 'one output: no arrow');
  assert(!/_left/.test(path.basename(single[0].outPath)), 'one screen: no suffix');

  const seq = await ExportPlan.buildJobs({ ...base, codecId: 'png_seq', codecDef: Codecs.byId('png_seq'), outMode: 'separate' }, io);
  assert(seq[0].outDir.endsWith('_seq') && seq[0].outPath.endsWith(path.join(path.basename(seq[0].outDir), 'frame_%05d.png')));

  const still = await ExportPlan.buildJobs({ ...base, codecId: 'png', codecDef: Codecs.byId('png'), outMode: 'separate' }, io);
  assert.strictEqual(still[0].pngTime, 1.5, 'a still from a video uses the frame on screen');

  const strict = await ExportPlan.buildJobs({ ...base, outMode: 'separate', padAccepted: true }, { ...io, fitSize: (s) => ({ width: s.width, height: s.height, rule: { strict: true } }) });
  assert.strictEqual(strict[0].allowPad, true);
  ok('jobs: one per clip per output, right names, masks and projects');

  // A real job from the builder through buildArgs and ffmpeg
  const src = path.join(dir, 'job.png');
  ffmpeg(ff, ['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:d=0.04,format=gbrp,geq=r='X*4':g='Y*8':b='100'`, '-frames:v', '1', '-update', '1', src]);
  const screenProj = { name: 'j', input: { width: W, height: H }, screens: [{ id: 'a', name: 'A', width: W, height: H }], slices: [slice({ in: { x: 3, y: 1, w: 20, h: 10 }, out: { x: 40, y: 20, w: 20, h: 10 } })] };
  const [job] = await ExportPlan.buildJobs({ ...base, project: screenProj, outMode: 'separate', files: [{ path: src, isImage: true, transform: null }], codecId: 'png', codecDef: Codecs.byId('png') }, { ...io, maskFilesFor: async () => ({}) });
  const built = render.buildArgs(screenProj, job, { codec: 'png', depth: 8 }, render.probeMedia(ff, src));
  const r = spawnSync(ff, built.args, { timeout: 60000 });
  assert.strictEqual(r.status, 0, (r.stderr || '').toString().slice(-1000));
  const got = rawRgb(ff, job.outPath);
  const srcRaw = rawRgb(ff, src);
  let wrong = 0;
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 20; x++) {
      for (let k = 0; k < 3; k++) if (got[((20 + y) * W + 40 + x) * 3 + k] !== srcRaw[((1 + y) * W + 3 + x) * 3 + k]) wrong++;
    }
  }
  assert.strictEqual(wrong, 0, `${wrong} bytes wrong from a built job`);
  ok('a built job renders the right pixels');
}

async function updateTests(ok) {
  console.log('Version and update notice');
  assert(AppInfo.isNewer('v1.2.1', '1.2.0'));
  assert(AppInfo.isNewer('1.10.0', '1.9.9'), 'numbers, not text');
  assert(!AppInfo.isNewer('v1.2.0', '1.2.0'));
  assert(!AppInfo.isNewer('v1.1.9', '1.2.0'));
  assert(!AppInfo.isNewer('nightly', '1.2.0'));
  assert.strictEqual(AppInfo.updateFromRelease({ tag_name: 'v1.2.1', draft: true }, '1.2.0'), null, 'a draft is not out yet');
  assert.strictEqual(AppInfo.updateFromRelease({ tag_name: 'v1.2.1', prerelease: true }, '1.2.0'), null);
  const url = `${AppInfo.RELEASES_PAGE}/tag/v1.2.1`;
  assert.deepStrictEqual(AppInfo.updateFromRelease({ tag_name: 'v1.2.1', html_url: url }, '1.2.0'), { version: '1.2.1', url });
  assert.strictEqual(AppInfo.updateFromRelease({ tag_name: 'v1.2.1', html_url: 'https://elsewhere.example/x' }, '1.2.0').url, AppInfo.RELEASES_PAGE);
  assert(!AppInfo.isReleaseUrl('https://elsewhere.example/x'), 'the notice opens only the project page');

  assert.strictEqual(await Maintenance.checkForUpdate('1.2.0', { fetch: async () => { throw new Error('offline'); } }), null, 'silent offline');
  assert.strictEqual(await Maintenance.checkForUpdate('1.2.0', { fetch: async () => ({ ok: false }) }), null, 'no releases yet');
  let asked = 0;
  await Maintenance.checkForUpdate('1.2.0', { isBusy: () => true, fetch: async () => { asked++; return { ok: true, json: async () => ({ tag_name: 'v9.0.0' }) }; } });
  assert.strictEqual(asked, 0, 'never during an export');
  assert.deepStrictEqual(await Maintenance.checkForUpdate('1.2.0', { fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.2.1', html_url: url }) }) }), { version: '1.2.1', url });
  assert.deepStrictEqual(AppInfo.testsLine({ testsPassed: 7 }), { text: 'Tests: 7 of 7 passed', ok: true });
  assert.strictEqual(AppInfo.testsLine(null).ok, false, 'no tests, no green check');
  assert.strictEqual(AppInfo.pinLine('8.1.2', { state: 'different', expected: '8.1.2' }).ok, false);
  ok('update notice: only a newer published release, silent offline, never during an export');
}

async function pinTests(ok, dir) {
  console.log('Pinned ffmpeg');
  const m = Maintenance.manifest;
  assert.deepStrictEqual(Object.keys(m.platforms).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
  for (const e of Object.values(m.platforms)) {
    assert(/^[0-9a-f]{64}$/.test(e.sha256), `${e.file} has a checksum`);
    assert.strictEqual(e.version, m.version, `${e.file} is on the shared version`);
  }
  const win = m.platforms['win32-x64'];
  assert(/^[0-9a-f]{64}$/.test(win.archive.sha256));
  assert(win.archive.url.includes(`/${m.version}/`) && !/latest/.test(win.archive.url), 'a fixed release, not "latest"');
  for (const key of ['darwin-x64', 'darwin-arm64']) {
    const e = m.platforms[key];
    assert.strictEqual(await Maintenance.sha256File(path.join(__dirname, '..', 'bin', 'ffmpeg-dxv', e.file)), e.sha256, `${e.file} in git matches its recorded checksum`);
  }
  ok('manifest: one version, fixed URL, Mac binaries match their checksums');

  const fakeManifest = (file, sha) => ({ platforms: { 'testos-x1': { file, version: '8.1.2', sha256: sha } } });
  const opts = (mf) => ({ manifest: mf, platform: 'testos', arch: 'x1' });
  const bin = path.join(dir, 'ff.bin');
  fs.writeFileSync(bin, 'content');
  const sha = crypto.createHash('sha256').update('content').digest('hex');
  assert.strictEqual((await Maintenance.pinStatus(bin, opts(fakeManifest('ff.bin', sha)))).state, 'verified');
  assert.strictEqual((await Maintenance.pinStatus(bin, opts(fakeManifest('ff.bin', 'a'.repeat(64))))).state, 'different');
  assert.strictEqual((await Maintenance.pinStatus(bin, opts(fakeManifest('other.bin', sha)))).state, 'different', 'a system ffmpeg is not the pinned one');
  assert.strictEqual((await Maintenance.pinStatus(path.join(dir, 'gone'), opts(fakeManifest('gone', sha)))).state, 'unknown');
  assert.strictEqual(AppInfo.pinLine('8.1.2', { state: 'verified' }).ok, true);
  ok('pin status: verified only for the exact file');

  // The installer step: no matching checksums, no install
  const target = path.join(dir, 'installed.exe');
  const entry = { sha256: 'b'.repeat(64), archive: { url: 'x', sha256: 'c'.repeat(64), entry: 'bin/ffmpeg.exe' } };
  const deps = (over) => ({
    download: async (u, dest) => fs.writeFileSync(dest, 'zip'),
    extract: (a, en, d) => { const p = path.join(d, 'bin.exe'); fs.writeFileSync(p, 'exe'); return p; },
    checkEncoders: () => {},
    sha256File: async (f) => (f.endsWith('archive.zip') ? 'c'.repeat(64) : 'b'.repeat(64)),
    ...over,
  });
  await assert.rejects(Fetch.installFromArchive(entry, target, deps({ sha256File: async () => 'd'.repeat(64) })), /checksum/);
  assert(!fs.existsSync(target), 'bad archive: nothing installed');
  await assert.rejects(Fetch.installFromArchive(entry, target, deps({ checkEncoders: () => { throw new Error('lacks required encoders: dxv'); } })), /encoders/);
  assert(!fs.existsSync(target), 'no DXV: nothing installed');
  await Fetch.installFromArchive(entry, target, deps());
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'exe');
  assert.deepStrictEqual(Fetch.missingEncoders(' V..... dxv                  DXV\n V..... hap   HAP\n V..... libx265   x265\n V..... prores_ks  ProRes'), []);
  assert.deepStrictEqual(Fetch.missingEncoders(' V..... hap   HAP\n'), ['dxv', 'libx265', 'prores_ks']);
  ok('ffmpeg install: wrong checksum or missing encoders change nothing');
}

function installTests(ok, dir) {
  console.log('Install check');
  assert.strictEqual(Install.nodeProblem('v22.23.4'), null);
  assert(/Node 22/.test(Install.nodeProblem('v26.13.0')));
  const root = path.join(dir, 'inst');
  const el = path.join(root, 'node_modules', 'electron');
  assert(/not installed/.test(Install.electronProblem(root)));
  fs.mkdirSync(path.join(el, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(el, 'package.json'), '{}');
  assert(/without its program/.test(Install.electronProblem(root)), 'no path.txt');
  fs.writeFileSync(path.join(el, 'path.txt'), 'electron.exe');
  assert(/without its program/.test(Install.electronProblem(root)), 'path.txt but no program');
  fs.writeFileSync(path.join(el, 'dist', 'electron.exe'), 'x');
  assert.strictEqual(Install.electronProblem(root), null);
  ok('install check: incomplete Electron is reported, Node version is warned about');
}

async function logTests(ok, ff, dir) {
  console.log('Export log and diagnostics');
  const logDir = path.join(dir, 'logs');
  render.setLogging({ dir: logDir, app: { version: '9.9.9', platform: 'test', arch: 'x' } });
  try {
    const src = path.join(dir, 'log.png');
    ffmpeg(ff, ['-f', 'lavfi', '-i', 'color=c=red:s=32x16:d=0.04', '-frames:v', '1', '-update', '1', src]);
    const p = { name: 'l', input: { width: 32, height: 16 }, screens: [{ id: 'a', name: 'A', width: 32, height: 16 }], slices: [slice({ in: { x: 0, y: 0, w: 32, h: 16 }, out: { x: 0, y: 0, w: 32, h: 16 } })] };
    const out = path.join(dir, 'log-out.png');
    const results = await render.startBatch(null, { project: p, jobs: [{ src, isImage: true, outPath: out, screen: p.screens[0] }], codec: 'png', alpha: 'none', depth: 8, fps: 25, imageDuration: 1, existingPolicy: 'overwrite' });
    assert(results[0].ok, JSON.stringify(results[0]));
    const names = fs.readdirSync(logDir).filter((n) => n.startsWith('export-'));
    assert.strictEqual(names.length, 1);
    const text = fs.readFileSync(path.join(logDir, names[0]), 'utf8');
    assert(/XtremeLED Remap Export 9\.9\.9/.test(text) && /ffmpeg:/.test(text), 'header');
    assert(/^\$ .* -i /m.test(text), 'the full command');
    assert(/ffmpeg exit code: 0/.test(text) && /Done: /.test(text), 'the result');

    const latest = ExportLog.latestLog(logDir);
    assert(latest.text.includes('Done:'));
    const diag = Maintenance.buildDiagnostics({ version: '9.9.9', electron: '1', chrome: '2', node: '3', platform: 'p', arch: 'a', osRelease: 'r', packaged: false, ffmpeg: { entries: [{ version: '8', path: '/ff', hasDxv: true, hasHap: true, hasX265: true }] }, pin: { state: 'verified' }, log: latest });
    assert(/9\.9\.9/.test(diag) && /Done:/.test(diag) && /Pinned build check: verified/.test(diag));
    assert(/No export log yet/.test(Maintenance.buildDiagnostics({ version: '1', ffmpeg: null, pin: null, log: null })));

    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(logDir, `export-2000-01-01_00-00-${String(i).padStart(2, '0')}-000.log`), 'x');
    ExportLog.pruneLogs(logDir, ExportLog.KEEP_LOGS);
    const kept = fs.readdirSync(logDir).filter((n) => n.startsWith('export-')).sort();
    assert.strictEqual(kept.length, ExportLog.KEEP_LOGS);
    assert(!kept.includes('export-2000-01-01_00-00-00-000.log'), 'oldest logs go first');

    const big = path.join(dir, 'biglog');
    fs.mkdirSync(big);
    fs.writeFileSync(path.join(big, 'export-2001-01-01_00-00-00-000.log'), `${'x'.repeat(200000)}END`);
    assert(ExportLog.latestLog(big).text.endsWith('END'), 'the end of a long log is what is kept');

    const silent = ExportLog.begin({ dir: path.join(dir, 'no', 'such', 'place', '\0bad') }, {});
    silent.line('still fine');
    assert.strictEqual(silent.path, null, 'a log that cannot be written is simply off');
  } finally {
    render.setLogging(null);
  }
  ok('every export leaves a log with command and ffmpeg output');

  assert.deepStrictEqual(Maintenance.crashAction([], 100000, 60000, 2).ask, false);
  assert.deepStrictEqual(Maintenance.crashAction([50000, 80000], 100000, 60000, 2).ask, true, 'twice in a minute: ask');
  assert.deepStrictEqual(Maintenance.crashAction([1000, 2000], 100000, 60000, 2).ask, false, 'old crashes do not count');
  ok('crash recovery reloads once and then asks');
}

async function run(ok, ff, tmp) {
  const dir = fs.mkdtempSync(path.join(tmp || os.tmpdir(), 'xre-release-'));
  try {
    await goldenTests(ok, ff, dir);
    await jobTests(ok, ff, dir);
    await updateTests(ok);
    await pinTests(ok, dir);
    installTests(ok, dir);
    await logTests(ok, ff, dir);
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
  }, caps.proresPath).then(() => console.log(`\nRELEASE TESTS: ${n} CHECKS PASSED`)).catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
  });
}
