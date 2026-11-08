'use strict';
// ffmpeg render pipeline: stageview source -> clip transform -> crop/rotate/flip/scale/overlay
// per slice -> output canvas. Full codec matrix (ProRes/DXV/HAP/HEVC/H.264/PNG) with alpha
// and bit-depth options, in/out trim, PNG sequences, polygon masks and multi-screen output.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Geometry = require('../shared/geometry');
const Codecs = require('../shared/codecs');
const { explainError, checkOutputDir } = require('./errors');
const Outputs = require('../shared/outputs');
const Files = require('./output-files');

// Bundled ffmpeg 8.x with DXV/HAP/x265 encoders (bin/ffmpeg-dxv/ffmpeg-<arch>).
// Native binary per architecture: Intel (x64), Apple Silicon (arm64), Windows (win64).
// Shipped as extraResources (Contents/Resources/bin) — NOT inside the asar, so the
// per-platform stripping in afterPack can't break asar integrity.
const bundledDirs = [];
if (process.resourcesPath) {
  bundledDirs.push(path.join(process.resourcesPath, 'bin', 'ffmpeg-dxv'));
}
// dev / fallback: project bin, and legacy asar-unpacked location
bundledDirs.push(path.join(__dirname, '..', '..', 'bin', 'ffmpeg-dxv'));
bundledDirs.push(
  path.join(__dirname, '..', '..', 'bin', 'ffmpeg-dxv').replace('app.asar', 'app.asar.unpacked')
);

let ffmpegStatic = null;
try {
  ffmpegStatic = require('ffmpeg-static');
} catch (e) {
  /* optional */
}

const activeProcs = new Set();
let cancelled = false;
let batchActive = false;
let idleWaiters = [];
let capsCache = null;

function candidateFfmpegs() {
  const list = [];
  if (process.env.XRE_FFMPEG) list.push(process.env.XRE_FFMPEG);
  const native =
    process.platform === 'win32'
      ? 'ffmpeg-win64.exe'
      : process.arch === 'arm64'
        ? 'ffmpeg-arm64'
        : 'ffmpeg-x64';
  for (const dir of bundledDirs) {
    list.push(path.join(dir, native));
    list.push(path.join(dir, 'ffmpeg')); // legacy single-binary name
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      list.push(path.join(dir, 'ffmpeg-x64')); // Rosetta fallback
    }
  }
  if (ffmpegStatic) list.push(ffmpegStatic);
  if (process.platform !== 'win32') {
    list.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  }
  return [...new Set(list)].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch (e) {
      return false;
    }
  });
}

function getCapabilities(force) {
  if (capsCache && !force) return capsCache;
  const entries = [];
  for (const p of candidateFfmpegs()) {
    try {
      const v = spawnSync(p, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15000 });
      if (v.status !== 0) continue;
      const version = ((v.stdout || '').match(/ffmpeg version (\S+)/) || [])[1] || '?';
      const enc = spawnSync(p, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15000 });
      const encs = enc.stdout || '';
      entries.push({
        path: p,
        version,
        hasDxv: /\sdxv\s/.test(encs),
        hasHap: /\shap\s/.test(encs),
        hasX265: /libx265/.test(encs),
        hasProres: /prores_ks/.test(encs),
        hasProresAw: /prores_aw/.test(encs),
      });
    } catch (e) {
      /* skip */
    }
  }
  const prores = entries.find((x) => x.hasProres) || null;
  const dxv = entries.find((x) => x.hasDxv) || null;
  const hap = entries.find((x) => x.hasHap) || null;
  const x265 = entries.find((x) => x.hasX265) || null;
  capsCache = {
    entries,
    proresPath: prores ? prores.path : null,
    dxvPath: dxv ? dxv.path : null,
    hapPath: hap ? hap.path : null,
    x265Path: x265 ? x265.path : null,
    hasDxv: !!dxv,
    hasHap: !!hap,
    hasX265: !!x265,
    fastProres: !!(prores && prores.hasProresAw),
  };
  return capsCache;
}

function ffmpegForCodec(codecId) {
  const caps = getCapabilities();
  if (codecId === 'dxv') return caps.dxvPath;
  if (codecId === 'hap' || codecId === 'hap_q' || codecId === 'dxv_hq') return caps.hapPath;
  if (codecId === 'hevc') return caps.x265Path;
  return caps.proresPath;
}

// A hardware encoder counts only after a short real encode on this machine. Being listed by
// ffmpeg proves nothing: the encoders for NVIDIA and AMD are listed on every Windows PC.
function probeEncoder(ffPath, codecId, opts) {
  return new Promise((resolve) => {
    let proc;
    let done = false;
    const finish = (passed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(passed);
    };
    const timer = setTimeout(() => {
      try { proc && proc.kill('SIGKILL'); } catch (e) { /* already stopped */ }
      finish(false);
    }, 20000);
    try {
      proc = spawn(ffPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25',
        '-frames:v', '8', '-an',
        ...Codecs.encoderArgs(codecId, { ...opts, gpu: true }),
        '-f', 'null', '-',
      ], { stdio: 'ignore' });
    } catch (e) {
      finish(false);
      return;
    }
    proc.on('error', () => finish(false));
    proc.on('close', (code) => finish(code === 0));
  });
}

let gpuDetection = null;

// Tests the graphics card encoders once per run of the app; ffmpeg runs in the background.
// Stops at the first family that works, because each test takes a few seconds on a slow PC.
function detectGpu(force) {
  if (gpuDetection && !force) return gpuDetection;
  gpuDetection = (async () => {
    const encoders = {};
    const families = Codecs.gpuFamilies(process.platform);
    const tryKey = async (key, probeCodec) => {
      const ffPath = ffmpegForCodec(probeCodec);
      if (!ffPath) return null;
      for (const family of families) {
        const id = Codecs.gpuEncoderName(key, family);
        if (!id) continue;
        if (await probeEncoder(ffPath, probeCodec, { gpuFamily: family, gpuEncoder: id, depth: 8 })) {
          const entry = { id, family, label: Codecs.GPU_FAMILIES[family].label };
          if (key === 'hevc') {
            entry.depths = [8];
            if (await probeEncoder(ffPath, probeCodec, { gpuFamily: family, gpuEncoder: id, depth: 10 })) entry.depths.push(10);
          }
          return entry;
        }
      }
      return null;
    };
    for (const [key, probeCodec] of [['h264', 'h264'], ['hevc', 'hevc'], ['prores', 'prores_hq']]) {
      const found = await tryKey(key, probeCodec);
      if (found) encoders[key] = found;
    }
    const first = encoders.h264 || encoders.hevc || encoders.prores || null;
    return { encoders, label: first ? first.label : null, family: first ? first.family : null };
  })();
  return gpuDetection;
}

// Tests only: pretend a detection result, or null to run the real test again
function setGpuDetection(result) {
  gpuDetection = result ? Promise.resolve(result) : null;
}

// Same test ffmpeg uses to read a path as a frame pattern ("clip%d.png" is, "100%.png" isn't).
function isFramePattern(p) {
  let found = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== '%') continue;
    i++;
    while (p[i] >= '0' && p[i] <= '9') i++;
    if (p[i] === '%') continue;
    if (p[i] !== 'd' || found++) return false;
  }
  return found === 1;
}

// Input option that makes ffmpeg read a file named like a frame pattern as that one file.
// Only for the formats ffmpeg opens through image2 (gif has its own reader, without this option).
function literalInputArgs(file) {
  return /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(file) && isFramePattern(file) ? ['-pattern_type', 'none'] : [];
}

// The colour matrix out of ffmpeg's "(tv, bt709/unknown/unknown, progressive)" text, or null.
// ffmpeg prints one name when matrix, primaries and transfer are equal, else matrix/primaries/transfer.
function probeColorspace(details) {
  if (!details) return null;
  const known = /^(bt709|bt470bg|smpte170m|smpte240m|bt2020nc|bt2020c|fcc|ycgco|ictcp|gbr)$/;
  for (const raw of details.split(',')) {
    const token = raw.trim().split('/')[0];
    if (known.test(token)) return token;
  }
  return null;
}

// Probe duration / fps / resolution / codec / audio of a source file via ffmpeg -i.
function probeMedia(ffPath, file) {
  const r = spawnSync(ffPath, ['-hide_banner', ...literalInputArgs(file), '-i', file], { encoding: 'utf8', timeout: 20000 });
  const err = (r.stderr || '') + (r.stdout || '');
  const out = {
    durationSec: null,
    fps: null,
    width: null,
    height: null,
    videoCodec: null,
    proresVariant: null,
    pixFmt: null,
    bitrateKbps: null,
    hasAudio: /Stream #[^\n]*Audio/.test(err),
  };
  const dm = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dm) out.durationSec = parseInt(dm[1], 10) * 3600 + parseInt(dm[2], 10) * 60 + parseFloat(dm[3]);
  const fm = err.match(/(\d+(?:\.\d+)?)\s*fps/) || err.match(/(\d+(?:\.\d+)?)\s*tbr/);
  if (fm) out.fps = parseFloat(fm[1]);
  const vline = (err.match(/Stream #[^\n]*Video:[^\n]*/) || [''])[0];
  const rm = vline.match(/(\d{2,5})x(\d{2,5})/);
  if (rm) {
    out.width = parseInt(rm[1], 10);
    out.height = parseInt(rm[2], 10);
  }
  const cm = vline.match(/Video:\s*(\w+)/);
  if (cm) out.videoCodec = cm[1];
  const pv = vline.match(/\((ap\w\w|ap4x)\s*\//);
  if (pv) out.proresVariant = pv[1];
  // "Video: <codec details>, <pix_fmt>(tv, bt709/unknown/unknown, progressive), ..."
  const pf = vline.match(/Video:[^,]*,\s*([0-9a-z_]+)(?:\(([^)]*)\))?/);
  if (pf && pf[1] !== 'none') {
    out.pixFmt = pf[1];
    out.colorspace = probeColorspace(pf[2]);
  }
  const br = err.match(/bitrate:\s*(\d+)\s*kb\/s/);
  if (br) out.bitrateKbps = parseInt(br[1], 10);
  const aline = (err.match(/Stream #[^\n]*Audio:[^\n]*/) || [''])[0];
  if (aline) {
    const am = aline.match(/(mono|stereo|quad|5\.1|7\.1|(\d+)\s*channels)/i);
    if (am) {
      out.audioChannels = am[2]
        ? parseInt(am[2], 10)
        : { mono: 1, stereo: 2, quad: 4, '5.1': 6, '7.1': 8 }[am[1].toLowerCase()] || null;
      out.audioLayout = am[1];
    }
  }
  return out;
}

// Mono peak waveform for the trim timeline (max-abs per bucket, 0..1)
function extractWaveform(src, buckets) {
  buckets = buckets || 600;
  const caps = getCapabilities();
  const ffPath = caps.proresPath;
  if (!ffPath) return null;
  const r = spawnSync(
    ffPath,
    ['-hide_banner', '-loglevel', 'error', '-i', src, '-map', '0:a:0', '-ac', '1', '-ar', '4000', '-f', 's16le', 'pipe:1'],
    { timeout: 120000, maxBuffer: 512 * 1024 * 1024 }
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 4) return null;
  const buf = r.stdout;
  const n = Math.floor(buf.length / 2);
  const per = Math.max(1, Math.floor(n / buckets));
  const peaks = [];
  for (let b = 0; b < buckets && b * per < n; b++) {
    let m = 0;
    const end = Math.min(n, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      const v = Math.abs(buf.readInt16LE(i * 2));
      if (v > m) m = v;
    }
    peaks.push(Math.round((m / 32768) * 1000) / 1000);
  }
  return peaks;
}

// Extract a single frame as PNG buffer (for the export page live preview).
function extractFrame(src, timeSec) {
  const caps = getCapabilities();
  const ffPath = caps.proresPath;
  if (!ffPath) throw new Error('ffmpeg not found');
  const seek = timeSec > 0 ? ['-ss', String(timeSec)] : [];
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...seek,
    ...literalInputArgs(src),
    '-i', src,
    '-frames:v', '1',
    '-vf', "scale='min(1600,iw)':-2",
    '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
  ];
  const r = spawnSync(ffPath, args, { timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) {
    throw new Error('Frame extraction failed: ' + (r.stderr ? r.stderr.toString().slice(-500) : '?'));
  }
  return 'data:image/png;base64,' + r.stdout.toString('base64');
}

const effectiveSlices = (project, screenId) => Geometry.effectiveSlices(project, screenId);

// ffmpeg's PNG encoder doesn't write text chunks, so inject a tEXt chunk ourselves
// (keyword "Comment") — this shows up in image metadata / details.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function stampPng(file, text) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) return; // not a PNG
    if (buf.includes(Buffer.from(text))) return; // already stamped
    const data = Buffer.concat([Buffer.from('Comment'), Buffer.from([0]), Buffer.from(text)]);
    const type = Buffer.from('tEXt');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
    const chunk = Buffer.concat([len, type, data, crc]);
    // insert right before the trailing IEND chunk (last 12 bytes)
    const iendPos = buf.length - 12;
    const out = Buffer.concat([buf.slice(0, iendPos), chunk, buf.slice(iendPos)]);
    fs.writeFileSync(file, out);
  } catch (e) {
    /* stamping is best-effort */
  }
}

// ffmpeg filter ops for slice content rotation (clockwise) + flip
function contentOps(rot, flip) {
  const ops = [];
  if (rot === 90) ops.push('transpose=1');
  else if (rot === 180) ops.push('hflip', 'vflip');
  else if (rot === 270) ops.push('transpose=2');
  if (flip & 1) ops.push('hflip');
  if (flip & 2) ops.push('vflip');
  return ops;
}

// Color/blur adjustment filters from a clip transform
function adjustOps(t) {
  const ops = [];
  if (!t) return ops;
  const b = t.brightness || 0;
  const c = t.contrast || 0;
  const s = t.saturation != null ? t.saturation : 1;
  if (b !== 0 || c !== 0 || s !== 1) {
    ops.push(`eq=brightness=${b.toFixed(4)}:contrast=${(1 + c).toFixed(4)}:saturation=${Math.max(0, s).toFixed(4)}`);
  }
  if (t.hue) ops.push(`hue=h=${t.hue.toFixed(2)}`);
  if (t.blur > 0) ops.push(`gblur=sigma=${t.blur.toFixed(2)}`);
  return ops;
}

// Build ffmpeg args for one job.
// job: {src, isImage, outPath, transform, inSec, outSec, pngTime, screen:{width,height,id},
//       maskFiles: {sliceId: pngPath}}
// opts: {codec, alpha, depth, bitrateMbps, fps, imageDuration}
// container/file metadata written into every export
const OUT_META = [
  '-metadata', 'comment=Exported by XtremeLED',
  '-metadata', 'author=XtremeLED',
  '-metadata', 'copyright=XtremeLED',
];

function buildArgs(project, job, opts, probe) {
  const codecDef = Codecs.byId(opts.codec);
  if (!codecDef) throw new Error(`Unknown codec "${opts.codec}"`);
  if (codecDef.unsupported) throw new Error(codecDef.unsupported);

  // audio-only export (WAV extract): no video pipeline at all
  if (codecDef.audioOnly) {
    if (job.isImage) throw new Error('Image footage has no audio');
    if (probe && probe.hasAudio === false) throw new Error('Source has no audio track');
    const aIn = job.inSec > 0 ? job.inSec : 0;
    const aOut = job.outSec > aIn ? job.outSec : null;
    const args = [
      '-y', '-hide_banner',
      ...(aIn > 0 ? ['-ss', String(aIn)] : []),
      '-i', job.src,
      '-vn', '-map', '0:a:0',
      ...Codecs.encoderArgs(opts.codec, opts),
      ...(aOut ? ['-t', String(aOut - aIn)] : []),
      ...OUT_META,
      '-progress', 'pipe:1', '-nostats',
      job.outPath,
    ];
    const aDur = aOut ? aOut - aIn : probe && probe.durationSec ? probe.durationSec - aIn : null;
    return { args, durationSec: aDur, expect: { kind: 'audio', audio: true, durationSec: aDur } };
  }

  const IW = Math.max(1, Math.round(project.input.width));
  const IH = Math.max(1, Math.round(project.input.height));
  const screen = job.screen || Geometry.screenOf(project) || { width: 1920, height: 1080 };
  // keepGpuSize: a CPU retry after a failed GPU encode must keep the size the file is named after
  const sizeOpt = { gpu: opts.gpu || opts.keepGpuSize };
  const refused = Codecs.sizeProblem(opts.codec, screen.width, screen.height, sizeOpt);
  if (refused && !job.allowPad) throw new Error(`${refused.message}.`);
  const fit = Codecs.fitOutputSize(opts.codec, screen.width, screen.height, sizeOpt);
  const OW = fit.width;
  const OH = fit.height;

  const sl = effectiveSlices(project, job.screen ? job.screen.id : undefined);
  if (!sl.length) throw new Error('No enabled slices inside the input canvas' + (job.screen ? ` for screen "${job.screen.name}"` : ''));

  const isStill = !!codecDef.still;
  const isSeq = !!codecDef.sequence;
  const alpha = opts.alpha && codecDef.alpha.includes(opts.alpha) ? opts.alpha : 'none';
  const useAlphaPipeline = alpha !== 'none';
  const fps = job.isImage || isStill ? opts.fps || 50 : (probe && probe.fps) || 25;
  const dur = job.isImage && !isStill ? opts.imageDuration || 1 : null;

  // trim (videos only)
  const inSec = !job.isImage && job.inSec > 0 ? job.inSec : 0;
  const outSec = !job.isImage && job.outSec > inSec ? job.outSec : null;

  const tr = job.transform;
  // The whole graph stays in the source's format; see Codecs.pixelPlan
  const plan = Codecs.pixelPlan(sl, probe, { alpha: useAlphaPipeline, transform: tr });
  const baseColor = useAlphaPipeline ? 'black@0.0' : 'black';
  const fpsRate = Codecs.exactRate(fps);
  const baseFmt = `,format=${plan.basePix}`;
  const overlayFmt = `:format=${plan.overlay}`;
  const composite = opts.compositor === 'overlay'
    ? { mode: 'overlay', reason: 'requested' }
    : Codecs.compositePlan(sl, OW, OH, plan, { alpha: useAlphaPipeline });
  const stacked = composite.mode === 'xstack';
  const parts = [];

  // Stills grab frame #1, and a trim starts at the frame after the in-point: after an input
  // seek (-ss) the first video frame starts slightly after t=0 while the color base starts
  // at 0 — reset pts so they line up, otherwise the first frame is the bare black base.
  const ptsReset = (isStill && !isSeq) || inSec > 0 ? ['setpts=PTS-STARTPTS'] : [];

  // An untagged YUV source is taken as BT.709. Without this the BT.709 encoder tags make
  // ffmpeg convert it as if it were BT.601, which shifts every colour.
  const srcFmt = plan.source;
  const tagSource = srcFmt && srcFmt.family === 'yuv' && !(probe && probe.colorspace)
    ? ['setparams=colorspace=bt709']
    : [];

  if (!Geometry.isIdentityTransform(tr) && probe && probe.width && probe.height) {
    const lay = Geometry.clipLayout(probe.width, probe.height, tr, IW, IH);
    const bw = Math.max(2, Math.round(lay.bw));
    const bh = Math.max(2, Math.round(lay.bh));
    const chain = [...tagSource, ...ptsReset, `scale=${bw}:${bh}:flags=bicubic`, 'setsar=1'];
    if (useAlphaPipeline) chain.push(`format=${plan.srcPix}`);
    if (tr.rotation) {
      chain.push(
        `rotate=${lay.angleRad.toFixed(6)}:ow=${Math.max(2, Math.ceil(lay.rw))}:oh=${Math.max(2, Math.ceil(lay.rh))}:c=black${useAlphaPipeline ? '@0.0' : ''}`
      );
    }
    chain.push(...adjustOps(tr));
    parts.push(`[0:v]${chain.join(',')}[clip]`);
    parts.push(`color=c=${baseColor}:s=${IW}x${IH}:r=${fpsRate}${baseFmt}[ibase]`);
    parts.push(`[ibase][clip]overlay=${Math.round(lay.x)}:${Math.round(lay.y)}:shortest=1${overlayFmt}[src]`);
  } else {
    // format= fixes the shared part of the graph: without it, the 4:4:4 step of one odd
    // slice would be negotiated upstream and change every even slice too
    const chain = [...tagSource, ...ptsReset, `scale=${IW}:${IH}:flags=bicubic`, 'setsar=1', ...adjustOps(tr), `format=${plan.srcPix}`];
    parts.push(`[0:v]${chain.join(',')}[src]`);
  }

  if (sl.length > 1) {
    parts.push(`[src]split=${sl.length}${sl.map((_, i) => `[s${i}]`).join('')}`);
  } else {
    parts.push('[src]null[s0]');
  }

  // polygon mask inputs (rasterized PNGs supplied by the renderer)
  const maskInputs = [];
  sl.forEach((s, i) => {
    const maskFile = s.polyMask && job.maskFiles ? job.maskFiles[s.slice.id] : null;
    const turned = s.rot === 90 || s.rot === 270;
    const sameSize = (turned ? s.crop.h : s.crop.w) === s.place.w && (turned ? s.crop.w : s.crop.h) === s.place.h;
    const ops = [
      // A crop can only start on a chroma sample; on odd pixels 10-bit chroma comes out as garbage
      ...(plan.needs444(s) ? [`format=${plan.crop444}`] : []),
      `crop=${s.crop.w}:${s.crop.h}:${s.crop.x}:${s.crop.y}:exact=1`,
      ...contentOps(s.rot, s.flip),
      ...(sameSize ? [] : [`scale=${s.place.w}:${s.place.h}:flags=bicubic`]),
      // xstack needs every input in one format and SAR, or ffmpeg picks a compromise itself
      ...(stacked ? [`format=${plan.work.pix}`, 'setsar=1'] : []),
    ];
    if (maskFile) {
      const mIdx = 1 + maskInputs.length;
      maskInputs.push(maskFile);
      parts.push(`[s${i}]${ops.join(',')},format=${plan.maskPix}[cc${i}]`);
      parts.push(`[${mIdx}:v]scale=${s.place.w}:${s.place.h},format=gray[mm${i}]`);
      parts.push(`[cc${i}][mm${i}]alphamerge[c${i}]`);
    } else {
      parts.push(`[s${i}]${ops.join(',')}[c${i}]`);
    }
  });

  if (stacked) {
    // All slices in one pass, so the cost no longer grows with every slice. xstack only makes
    // a canvas as big as the slices reach, pad fills the rest; fps gives what the color base
    // of the overlay path gives: a steady frame rate, also from a variable-rate source.
    const reachW = Math.max(...sl.map((s) => s.place.x + s.place.w));
    const reachH = Math.max(...sl.map((s) => s.place.y + s.place.h));
    const chain = [`xstack=inputs=${sl.length}:layout=${sl.map((s) => `${s.place.x}_${s.place.y}`).join('|')}:fill=black:shortest=1`];
    if (reachW !== OW || reachH !== OH) chain.push(`pad=${OW}:${OH}:0:0:black`);
    if (!isStill || isSeq) chain.push(`fps=${fpsRate}`);
    parts.push(`${sl.map((_, i) => `[c${i}]`).join('')}${chain.join(',')}[out]`);
  } else {
    parts.push(`color=c=${baseColor}:s=${OW}x${OH}:r=${fpsRate}${baseFmt}[base]`);
    let prev = 'base';
    sl.forEach((s, i) => {
      const last = i === sl.length - 1;
      const outLabel = last ? (alpha === 'only' ? 'pre' : 'out') : `o${i}`;
      const shortest = i === 0 ? ':shortest=1' : '';
      parts.push(`[${prev}][c${i}]overlay=${s.place.x}:${s.place.y}${shortest}${overlayFmt}[${outLabel}]`);
      prev = outLabel;
    });
    if (alpha === 'only') parts.push('[pre]alphaextract[out]');
  }

  // input args
  let inputArgs;
  if (job.isImage && !isStill) {
    inputArgs = ['-loop', '1', '-t', String(dur), ...literalInputArgs(job.src), '-i', job.src];
  } else if (isStill && !isSeq && !job.isImage && job.pngTime > 0) {
    inputArgs = ['-ss', String(job.pngTime), '-i', job.src];
  } else if (!job.isImage && inSec > 0) {
    inputArgs = ['-ss', String(inSec), '-i', job.src];
  } else {
    inputArgs = [...literalInputArgs(job.src), '-i', job.src];
  }
  for (const m of maskInputs) inputArgs.push(...literalInputArgs(m), '-i', m);

  // GPU (VideoToolbox) applies to moving video; alpha pipeline only via ProRes 4444
  const gpuOk = !!opts.gpu && (!useAlphaPipeline || opts.codec === 'prores_4444');
  const encOpts = { ...opts, gpu: gpuOk };
  const codecArgs = isStill && !isSeq
    ? ['-frames:v', '1', '-update', '1', ...Codecs.encoderArgs(opts.codec, { ...opts, gpu: false })] // -update: exact file name, % is not a pattern
    : Codecs.encoderArgs(opts.codec, encOpts);

  // never on a PNG sequence: the image muxer would write the audio packets as fake .png files
  const wantAudio =
    !isStill && !isSeq && !job.isImage && probe && probe.hasAudio && !useAlphaPipeline;
  const audioArgs = wantAudio
    ? codecDef.ext === 'mp4'
      ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '320k']
      : ['-map', '0:a:0', '-c:a', 'pcm_s16le']
    : [];

  const trimOut = [];
  if (!job.isImage && !isStill && outSec) trimOut.push('-t', String(outSec - inSec));

  // A sequence path is a frame pattern: a literal % in the folder has to be escaped as %%
  const outTarget = isSeq
    ? path.join(path.dirname(job.outPath).replace(/%/g, '%%'), path.basename(job.outPath))
    : job.outPath;

  const args = [
    '-y',
    '-hide_banner',
    ...inputArgs,
    '-filter_complex', parts.join(';'),
    '-map', '[out]',
    ...audioArgs,
    ...codecArgs,
    ...(job.isImage && !isStill ? ['-r', String(fps)] : []),
    ...(isSeq && !job.isImage ? ['-fps_mode', 'passthrough'] : []),
    ...trimOut,
    ...OUT_META,
    '-progress', 'pipe:1',
    '-nostats',
    outTarget,
  ];
  const totalDur = isStill && !isSeq
    ? null
    : job.isImage
      ? dur
      : outSec
        ? outSec - inSec
        : probe && probe.durationSec
          ? probe.durationSec - inSec
          : null;
  // A trim that runs past the end of the clip stops at the end of the clip
  const remaining = !job.isImage && probe && probe.durationSec ? probe.durationSec - inSec : null;
  const expectSec = totalDur != null && remaining != null ? Math.min(totalDur, remaining) : totalDur;
  const fpsKnown = job.isImage || (probe && probe.fps);
  const expect = {
    kind: isSeq ? 'sequence' : isStill ? 'still' : 'video',
    width: OW,
    height: OH,
    codec: Outputs.probedCodec(opts.codec),
    frames: expectSec != null && fpsKnown ? Math.round(expectSec * fps) : null,
    hasAudio: !!(probe && probe.hasAudio),
  };
  return { args, durationSec: totalDur, paddedTo: fit.padded ? `${OW}×${OH}` : null, expect, composite };
}

function runFfmpeg(ffPath, args, durationSec, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffPath, args);
    activeProcs.add(proc);
    let stderrTail = '';
    let stdoutBuf = '';

    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const m = line.match(/^out_time_us=(\d+)/) || line.match(/^out_time_ms=(\d+)/);
        if (m && durationSec) {
          const sec = parseInt(m[1], 10) / 1e6;
          onProgress(Math.min(99, (sec / durationSec) * 100));
        }
      }
    });
    proc.on('error', (err) => {
      activeProcs.delete(proc);
      reject(err);
    });
    proc.on('close', (code) => {
      activeProcs.delete(proc);
      if (cancelled) return reject(new Error('Cancelled'));
      if (code === 0) return resolve();
      const err = new Error(`ffmpeg error (code ${code}):\n${stderrTail}`);
      err.ffmpegArgs = args;
      reject(err);
    });
  });
}

function send(win, data) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('render:event', data);
  } catch (e) {
    /* window gone */
  }
}

// Counts the video packets without decoding: about a second for a 70 MB 4K file.
// null when ffmpeg can't tell; a cancel rejects.
function countFrames(ffPath, file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffPath, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-progress', 'pipe:1', '-nostats', '-']);
    activeProcs.add(proc);
    let out = '';
    proc.stdout.on('data', (d) => { out = (out + d.toString()).slice(-2000); });
    proc.stderr.on('data', () => {});
    proc.on('error', () => {
      activeProcs.delete(proc);
      resolve(null);
    });
    proc.on('close', (code) => {
      activeProcs.delete(proc);
      if (cancelled) return reject(new Error('Cancelled'));
      const all = out.match(/^frame=\s*(\d+)/gm);
      resolve(code === 0 && all ? parseInt(all[all.length - 1].replace(/\D/g, ''), 10) : null);
    });
  });
}

function folderBytes(dir, names) {
  return names.reduce((sum, n) => sum + fs.statSync(path.join(dir, n)).size, 0);
}

// Reads the finished file back. {problem} when it can't be used at all; otherwise the row
// for the log, with warnings when it differs from what was asked.
async function verifyOutput(ffPath, file, expect) {
  let probe, frames = null, sizeBytes;
  if (expect.kind === 'sequence') {
    const names = fs.readdirSync(file).filter((n) => n.toLowerCase().endsWith('.png')).sort();
    if (!names.length) return { problem: 'The export wrote no frames.' };
    probe = probeMedia(ffPath, path.join(file, names[0]));
    frames = names.length;
    sizeBytes = folderBytes(file, names);
  } else {
    sizeBytes = fs.statSync(file).size;
    probe = probeMedia(ffPath, file);
    if (expect.kind === 'video') frames = await countFrames(ffPath, file);
  }
  if (expect.kind === 'audio') {
    if (!probe.hasAudio) return { problem: 'The exported file cannot be read back.' };
  } else {
    if (!probe.videoCodec) return { problem: 'The exported file cannot be read back.' };
    if (frames === 0) return { problem: 'The export wrote no frames.' };
  }
  const actual = { width: probe.width, height: probe.height, codec: probe.videoCodec, frames, durationSec: probe.durationSec };
  return {
    kind: expect.kind,
    width: probe.width,
    height: probe.height,
    frames,
    durationSec: probe.durationSec,
    sizeBytes,
    warnings: Outputs.compareOutput(actual, expect),
  };
}

// One batch at a time: a second request is refused rather than run next to the first
async function startBatch(win, payload) {
  if (batchActive) throw new Error('An export is already running.');
  batchActive = true;
  try {
    return await runBatch(win, payload);
  } finally {
    batchActive = false;
    idleWaiters.splice(0).forEach((done) => done());
  }
}

const isBusy = () => batchActive;
const whenIdle = () => (batchActive ? new Promise((done) => idleWaiters.push(done)) : Promise.resolve());

async function runBatch(win, payload) {
  cancelled = false;
  const { jobs, codec, alpha, depth, bitrateMbps, fps, imageDuration, gpu } = payload;
  const ffPath = ffmpegForCodec(codec);
  if (!ffPath) throw new Error('No ffmpeg found for this codec');

  // Only an encoder that passed its test on this machine; otherwise the processor does it.
  const gpuChoice = gpu ? Codecs.gpuFor(await detectGpu(), codec, depth) : null;
  const fastProres = !!payload.fastProres && !gpuChoice && Codecs.fastProresCapable(codec) && getCapabilities().fastProres;

  // Check every output folder before the first clip, so a missing drive fails at once
  const destOf = (job) => path.dirname(job.outDir || job.outPath);
  const folderProblems = new Map();
  for (const job of jobs) {
    const dir = destOf(job);
    if (!folderProblems.has(dir)) folderProblems.set(dir, checkOutputDir(dir));
  }

  const results = [];
  const taken = new Set();
  for (let i = 0; i < jobs.length; i++) {
    if (cancelled) break;
    const job = jobs[i];
    const project = job.project || payload.project;
    send(win, { type: 'job-start', index: i, total: jobs.length, file: job.src, label: job.label });
    const folderProblem = folderProblems.get(destOf(job));
    if (folderProblem) {
      results.push({ src: job.src, ok: false, error: folderProblem.message, detail: folderProblem.detail });
      send(win, { type: 'job-error', index: i, total: jobs.length, error: folderProblem.message, detail: folderProblem.detail, label: job.label });
      continue;
    }
    let paddedTo = null;
    const isDir = !!job.outDir;
    let partial = null;
    try {
      const requested = job.outDir || job.outPath;
      let target = Files.resolveTarget(requested, isDir, payload.existingPolicy, taken);
      Files.markOwn(target);
      partial = Files.partialFor(target, isDir);
      // Everything renders under a temporary name; the previous export stays until this one is proven good
      if (isDir) {
        Files.discard(partial); // frames of an earlier interrupted run
        fs.mkdirSync(partial, { recursive: true });
      }
      const workJob = isDir
        ? { ...job, outDir: partial, outPath: path.join(partial, path.basename(job.outPath)) }
        : { ...job, outPath: partial };
      const probe = probeMedia(ffPath, job.src);
      const opts = {
        codec, alpha, depth, bitrateMbps, fps, imageDuration, fastProres,
        gpu: !!gpuChoice,
        gpuFamily: gpuChoice ? gpuChoice.family : null,
        gpuEncoder: gpuChoice ? gpuChoice.id : null,
      };
      const onPct = (pct) => send(win, { type: 'progress', index: i, total: jobs.length, percent: pct });
      let expect;
      try {
        const built = buildArgs(project, workJob, opts, probe);
        paddedTo = built.paddedTo;
        expect = built.expect;
        await runFfmpeg(ffPath, built.args, built.durationSec, onPct);
      } catch (gpuErr) {
        // Back to the processor only when the graphics card encoder itself failed
        if (!gpuChoice || cancelled || !Codecs.isGpuFailure(gpuErr && gpuErr.message, gpuChoice.id)) throw gpuErr;
        send(win, { type: 'job-note', index: i, total: jobs.length, note: `${gpuChoice.label} failed on this clip, finishing on the processor.`, label: job.label });
        const built = buildArgs(project, workJob, { ...opts, gpu: false, gpuFamily: null, gpuEncoder: null, keepGpuSize: true }, probe);
        paddedTo = built.paddedTo;
        expect = built.expect;
        await runFfmpeg(ffPath, built.args, built.durationSec, onPct);
      }
      // PNG has no container metadata — stamp the tEXt chunk into the file(s)
      if (codec === 'png') {
        stampPng(partial, 'Exported by XtremeLED');
      } else if (codec === 'png_seq' && isDir) {
        try {
          for (const fn of fs.readdirSync(partial)) {
            if (fn.toLowerCase().endsWith('.png')) stampPng(path.join(partial, fn), 'Exported by XtremeLED');
          }
        } catch (e) { /* best-effort */ }
      }
      send(win, { type: 'job-verify', index: i, total: jobs.length, label: job.label, file: job.src });
      const check = await verifyOutput(ffPath, partial, expect);
      if (check.problem) throw new Error(check.problem);
      if (cancelled) throw new Error('Cancelled');
      // A file with a warning never takes the place of an earlier export; with versions on,
      // neither does a name that appeared while this one was rendering
      const mayReplace = payload.existingPolicy !== 'version' && !check.warnings.length;
      if (!mayReplace && fs.existsSync(target)) target = Files.claimVersion(target, isDir, taken);
      Files.markOwn(target);
      await Files.promote(partial, target, isDir);
      partial = null;
      const savedAs = target === requested ? null : path.basename(target);
      results.push({ src: job.src, out: target, ok: true, paddedTo, check, savedAs });
      send(win, { type: 'job-done', index: i, total: jobs.length, out: target, label: job.label, paddedTo, check, savedAs });
    } catch (err) {
      if (partial && !(err && err.keepPartial)) {
        try { Files.discard(partial); } catch (e) { /* locked: it keeps its temporary name */ }
      }
      const info = explainError(err, { src: job.src, out: job.outDir || job.outPath });
      const detail = info.detail == null ? null : [
        `Source: ${job.src}`,
        `Output: ${job.outDir || job.outPath}`,
        '',
        info.detail,
        ...(err && err.ffmpegArgs ? ['', `Command: ffmpeg ${err.ffmpegArgs.join(' ')}`] : []),
      ].join('\n');
      results.push({ src: job.src, ok: false, error: info.message, detail });
      send(win, { type: 'job-error', index: i, total: jobs.length, error: info.message, detail, label: job.label });
      if (cancelled) break;
    }
  }
  send(win, { type: 'batch-done', cancelled, results, total: jobs.length });
  return results;
}

function cancel() {
  cancelled = true;
  for (const proc of activeProcs) {
    try {
      proc.kill('SIGKILL');
    } catch (e) {
      /* already stopped */
    }
  }
}

module.exports = {
  getCapabilities,
  detectGpu,
  setGpuDetection,
  ffmpegForCodec,
  probeMedia,
  extractFrame,
  extractWaveform,
  effectiveSlices,
  buildArgs,
  isFramePattern,
  runFfmpeg,
  startBatch,
  cancel,
  isBusy,
  whenIdle,
  isOwnOutput: Files.isOwnOutput,
  existingOutputs: Files.existingOutputs,
};
