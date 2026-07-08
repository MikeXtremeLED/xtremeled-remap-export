'use strict';
// ffmpeg render pipeline: stageview source -> clip transform -> crop/rotate/flip/scale/overlay
// per slice -> output canvas. Full codec matrix (ProRes/DXV/HAP/HEVC/H.264/PNG) with alpha
// and bit-depth options, in/out trim, PNG sequences, polygon masks and multi-screen output.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Geometry = require('../shared/geometry');
const Codecs = require('../shared/codecs');

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

let currentProc = null;
let cancelled = false;
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

// Probe duration / fps / resolution / codec / audio of a source file via ffmpeg -i.
function probeMedia(ffPath, file) {
  const r = spawnSync(ffPath, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 20000 });
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
  const pf = vline.match(/,\s*(yuva?\d+p?\d*[a-z]*|rgba?|gray\d*[a-z]*|rgb\d+[a-z]*)/);
  if (pf) out.pixFmt = pf[1];
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
      '-progress', 'pipe:1', '-nostats',
      job.outPath,
    ];
    const aDur = aOut ? aOut - aIn : probe && probe.durationSec ? probe.durationSec - aIn : null;
    return { args, durationSec: aDur };
  }

  const IW = Math.max(1, Math.round(project.input.width));
  const IH = Math.max(1, Math.round(project.input.height));
  const screen = job.screen || Geometry.screenOf(project) || { width: 1920, height: 1080 };
  let OW = Math.max(2, Math.round(screen.width));
  let OH = Math.max(2, Math.round(screen.height));
  if (OW % 2) OW += 1; // even dimensions for 4:2:x codecs
  if (OH % 2) OH += 1;

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

  const baseColor = useAlphaPipeline ? 'black@0.0' : 'black';
  const fmtRGBA = useAlphaPipeline ? ',format=rgba' : '';
  const parts = [];
  const tr = job.transform;

  // Stills grab frame #1: after an input seek (-ss) the first video frame can start
  // slightly after t=0 while the color base starts at 0 — reset pts so they line up,
  // otherwise the exported still is the bare black base.
  const ptsReset = isStill && !isSeq ? ['setpts=PTS-STARTPTS'] : [];

  if (!Geometry.isIdentityTransform(tr) && probe && probe.width && probe.height) {
    const lay = Geometry.clipLayout(probe.width, probe.height, tr, IW, IH);
    const bw = Math.max(2, Math.round(lay.bw));
    const bh = Math.max(2, Math.round(lay.bh));
    const chain = [...ptsReset, `scale=${bw}:${bh}:flags=bicubic`, 'setsar=1'];
    if (useAlphaPipeline) chain.push('format=rgba');
    if (tr.rotation) {
      chain.push(
        `rotate=${lay.angleRad.toFixed(6)}:ow=${Math.max(2, Math.ceil(lay.rw))}:oh=${Math.max(2, Math.ceil(lay.rh))}:c=black${useAlphaPipeline ? '@0.0' : ''}`
      );
    }
    chain.push(...adjustOps(tr));
    parts.push(`[0:v]${chain.join(',')}[clip]`);
    parts.push(`color=c=${baseColor}:s=${IW}x${IH}:r=${fps}${fmtRGBA}[ibase]`);
    parts.push(`[ibase][clip]overlay=${Math.round(lay.x)}:${Math.round(lay.y)}:shortest=1[src]`);
  } else {
    const chain = [...ptsReset, `scale=${IW}:${IH}:flags=bicubic`, 'setsar=1', ...adjustOps(tr)];
    if (useAlphaPipeline) chain.push('format=rgba');
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
    const ops = [
      `crop=${s.crop.w}:${s.crop.h}:${s.crop.x}:${s.crop.y}`,
      ...contentOps(s.rot, s.flip),
      `scale=${s.place.w}:${s.place.h}:flags=bicubic`,
    ];
    if (maskFile) {
      const mIdx = 1 + maskInputs.length;
      maskInputs.push(maskFile);
      parts.push(`[s${i}]${ops.join(',')},format=rgba[cc${i}]`);
      parts.push(`[${mIdx}:v]scale=${s.place.w}:${s.place.h},format=gray[mm${i}]`);
      parts.push(`[cc${i}][mm${i}]alphamerge[c${i}]`);
    } else {
      parts.push(`[s${i}]${ops.join(',')}[c${i}]`);
    }
  });

  parts.push(`color=c=${baseColor}:s=${OW}x${OH}:r=${fps}${fmtRGBA}[base]`);
  let prev = 'base';
  sl.forEach((s, i) => {
    const last = i === sl.length - 1;
    const outLabel = last ? (alpha === 'only' ? 'pre' : 'out') : `o${i}`;
    const shortest = i === 0 ? ':shortest=1' : '';
    parts.push(`[${prev}][c${i}]overlay=${s.place.x}:${s.place.y}${shortest}[${outLabel}]`);
    prev = outLabel;
  });
  if (alpha === 'only') parts.push('[pre]alphaextract[out]');

  // input args
  let inputArgs;
  if (job.isImage && !isStill) {
    inputArgs = ['-loop', '1', '-t', String(dur), '-i', job.src];
  } else if (isStill && !isSeq && !job.isImage && job.pngTime > 0) {
    inputArgs = ['-ss', String(job.pngTime), '-i', job.src];
  } else if (!job.isImage && inSec > 0) {
    inputArgs = ['-ss', String(inSec), '-i', job.src];
  } else {
    inputArgs = ['-i', job.src];
  }
  for (const m of maskInputs) inputArgs.push('-i', m);

  // GPU (VideoToolbox) applies to moving video; alpha pipeline only via ProRes 4444
  const gpuOk = !!opts.gpu && (!useAlphaPipeline || opts.codec === 'prores_4444');
  const encOpts = { ...opts, gpu: gpuOk };
  const codecArgs = isStill && !isSeq
    ? ['-frames:v', '1', ...Codecs.encoderArgs(opts.codec, { ...opts, gpu: false })]
    : Codecs.encoderArgs(opts.codec, encOpts);

  const wantAudio =
    !isStill && !job.isImage && probe && probe.hasAudio && !useAlphaPipeline;
  const audioArgs = wantAudio
    ? codecDef.ext === 'mp4'
      ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '320k']
      : ['-map', '0:a:0', '-c:a', 'pcm_s16le']
    : [];

  const trimOut = [];
  if (!job.isImage && !isStill && outSec) trimOut.push('-t', String(outSec - inSec));

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
    '-progress', 'pipe:1',
    '-nostats',
    job.outPath,
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
  return { args, durationSec: totalDur };
}

function runFfmpeg(ffPath, args, durationSec, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffPath, args);
    currentProc = proc;
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
      currentProc = null;
      reject(err);
    });
    proc.on('close', (code) => {
      currentProc = null;
      if (cancelled) return reject(new Error('Cancelled'));
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg error (code ${code}):\n${stderrTail}`));
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

async function startBatch(win, payload) {
  cancelled = false;
  const { jobs, codec, alpha, depth, bitrateMbps, fps, imageDuration, gpu } = payload;
  const ffPath = ffmpegForCodec(codec);
  if (!ffPath) throw new Error('No ffmpeg found for this codec');

  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    if (cancelled) break;
    const job = jobs[i];
    const project = job.project || payload.project;
    send(win, { type: 'job-start', index: i, total: jobs.length, file: job.src, label: job.label });
    try {
      // PNG sequence: ensure the output folder exists
      if (job.outDir) fs.mkdirSync(job.outDir, { recursive: true });
      const probe = probeMedia(ffPath, job.src);
      const opts = { codec, alpha, depth, bitrateMbps, fps, imageDuration, gpu };
      const onPct = (pct) => send(win, { type: 'progress', index: i, total: jobs.length, percent: pct });
      try {
        const { args, durationSec } = buildArgs(project, job, opts, probe);
        await runFfmpeg(ffPath, args, durationSec, onPct);
      } catch (gpuErr) {
        // GPU (VideoToolbox) not available on this machine/codec -> retry on CPU
        if (!gpu || cancelled || !Codecs.gpuCapable(codec)) throw gpuErr;
        send(win, { type: 'job-note', index: i, total: jobs.length, note: 'GPU encoder unavailable — falling back to CPU', label: job.label });
        const { args, durationSec } = buildArgs(project, job, { ...opts, gpu: false }, probe);
        await runFfmpeg(ffPath, args, durationSec, onPct);
      }
      const shown = job.outDir || job.outPath;
      results.push({ src: job.src, out: shown, ok: true });
      send(win, { type: 'job-done', index: i, total: jobs.length, out: shown, label: job.label });
    } catch (err) {
      const msg = String((err && err.message) || err);
      results.push({ src: job.src, ok: false, error: msg });
      send(win, { type: 'job-error', index: i, total: jobs.length, error: msg, label: job.label });
      if (cancelled) break;
    }
  }
  send(win, { type: 'batch-done', cancelled, results });
  return results;
}

function cancel() {
  cancelled = true;
  if (currentProc) {
    try {
      currentProc.kill('SIGKILL');
    } catch (e) {
      /* already stopped */
    }
  }
}

module.exports = {
  getCapabilities,
  ffmpegForCodec,
  probeMedia,
  extractFrame,
  extractWaveform,
  effectiveSlices,
  buildArgs,
  runFfmpeg,
  startBatch,
  cancel,
};
