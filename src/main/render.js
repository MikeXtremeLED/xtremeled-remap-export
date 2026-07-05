'use strict';
// ffmpeg render pipeline: stageview source -> clip transform -> crop/rotate/flip/scale/overlay
// per slice -> output canvas. ProRes 422 HQ via prores_ks; DXV3 via the bundled ffmpeg 8.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Geometry = require('../shared/geometry');

let ffmpegStatic = null;
try {
  ffmpegStatic = require('ffmpeg-static');
} catch (e) {
  /* optioneel */
}

// Meegeleverde ffmpeg 8.x met DXV-encoder (bin/ffmpeg-dxv/ffmpeg)
const bundledDxvFfmpeg = path.join(__dirname, '..', '..', 'bin', 'ffmpeg-dxv', 'ffmpeg');

let currentProc = null;
let cancelled = false;
let capsCache = null;

function candidateFfmpegs() {
  const list = [];
  if (process.env.XRE_FFMPEG) list.push(process.env.XRE_FFMPEG);
  list.push(bundledDxvFfmpeg.replace('app.asar', 'app.asar.unpacked'));
  if (ffmpegStatic) list.push(ffmpegStatic);
  list.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
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
        hasProres: /prores_ks/.test(encs),
      });
    } catch (e) {
      /* skip */
    }
  }
  const prores = entries.find((x) => x.hasProres) || null;
  const dxv = entries.find((x) => x.hasDxv) || null;
  capsCache = {
    entries,
    proresPath: prores ? prores.path : null,
    dxvPath: dxv ? dxv.path : null,
    hasDxv: !!dxv,
  };
  return capsCache;
}

// Probe duration / fps / resolution / audio of a source file via ffmpeg -i.
function probeMedia(ffPath, file) {
  const r = spawnSync(ffPath, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 20000 });
  const err = (r.stderr || '') + (r.stdout || '');
  const out = {
    durationSec: null,
    fps: null,
    width: null,
    height: null,
    hasAudio: /Stream #[^\n]*Audio/.test(err),
  };
  const dm = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dm) out.durationSec = parseInt(dm[1], 10) * 3600 + parseInt(dm[2], 10) * 60 + parseFloat(dm[3]);
  const fm = err.match(/(\d+(?:\.\d+)?)\s*fps/) || err.match(/(\d+(?:\.\d+)?)\s*tbr/);
  if (fm) out.fps = parseFloat(fm[1]);
  const rm = err.match(/Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
  if (rm) {
    out.width = parseInt(rm[1], 10);
    out.height = parseInt(rm[2], 10);
  }
  return out;
}

// Extract a single frame as PNG buffer (for the render page live preview).
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

const effectiveSlices = (project) => Geometry.effectiveSlices(project);

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

function buildArgs(project, job, opts, probe) {
  const IW = Math.max(1, Math.round(project.input.width));
  const IH = Math.max(1, Math.round(project.input.height));
  let OW = Math.max(2, Math.round(project.output.width));
  let OH = Math.max(2, Math.round(project.output.height));
  if (OW % 2) OW += 1; // ProRes 4:2:2 requires even width
  if (OH % 2) OH += 1;

  const sl = effectiveSlices(project);
  if (!sl.length) throw new Error('No enabled slices inside the input canvas');

  const isPng = opts.codec === 'png';
  const fps = job.isImage || isPng ? opts.fps || 50 : (probe && probe.fps) || 25;
  const dur = job.isImage && !isPng ? opts.imageDuration || 1 : null;

  const parts = [];
  const tr = job.transform;
  if (!Geometry.isIdentityTransform(tr) && probe && probe.width && probe.height) {
    // Clip transform: position / scale / rotate the source on the input canvas
    const lay = Geometry.clipLayout(probe.width, probe.height, tr, IW, IH);
    const bw = Math.max(2, Math.round(lay.bw));
    const bh = Math.max(2, Math.round(lay.bh));
    const chain = [`scale=${bw}:${bh}:flags=bicubic`, 'setsar=1'];
    if (tr.rotation) {
      chain.push(
        `rotate=${lay.angleRad.toFixed(6)}:ow=${Math.max(2, Math.ceil(lay.rw))}:oh=${Math.max(2, Math.ceil(lay.rh))}:c=black`
      );
    }
    chain.push(...adjustOps(tr));
    parts.push(`[0:v]${chain.join(',')}[clip]`);
    parts.push(`color=c=black:s=${IW}x${IH}:r=${fps}[ibase]`);
    parts.push(`[ibase][clip]overlay=${Math.round(lay.x)}:${Math.round(lay.y)}:shortest=1[src]`);
  } else {
    const chain = [`scale=${IW}:${IH}:flags=bicubic`, 'setsar=1', ...adjustOps(tr)];
    parts.push(`[0:v]${chain.join(',')}[src]`);
  }

  if (sl.length > 1) {
    parts.push(`[src]split=${sl.length}${sl.map((_, i) => `[s${i}]`).join('')}`);
  } else {
    parts.push('[src]null[s0]');
  }
  sl.forEach((s, i) => {
    const ops = [
      `crop=${s.crop.w}:${s.crop.h}:${s.crop.x}:${s.crop.y}`,
      ...contentOps(s.rot, s.flip),
      `scale=${s.place.w}:${s.place.h}:flags=bicubic`,
    ];
    parts.push(`[s${i}]${ops.join(',')}[c${i}]`);
  });
  parts.push(`color=c=black:s=${OW}x${OH}:r=${fps}[base]`);
  let prev = 'base';
  sl.forEach((s, i) => {
    const outLabel = i === sl.length - 1 ? 'out' : `o${i}`;
    const shortest = i === 0 ? ':shortest=1' : '';
    parts.push(`[${prev}][c${i}]overlay=${s.place.x}:${s.place.y}${shortest}[${outLabel}]`);
    prev = outLabel;
  });

  let inputArgs;
  if (job.isImage && !isPng) {
    inputArgs = ['-loop', '1', '-t', String(dur), '-i', job.src];
  } else if (isPng && !job.isImage && job.pngTime > 0) {
    inputArgs = ['-ss', String(job.pngTime), '-i', job.src]; // still from the chosen preview time
  } else {
    inputArgs = ['-i', job.src];
  }
  let codecArgs;
  if (isPng) {
    codecArgs = ['-frames:v', '1']; // png encoder volgt uit .png extensie
  } else if (opts.codec === 'dxv') {
    codecArgs = ['-c:v', 'dxv', '-pix_fmt', 'rgba'];
  } else {
    codecArgs = [
      '-c:v', 'prores_ks',
      '-profile:v', '3',
      '-vendor', 'apl0',
      '-pix_fmt', 'yuv422p10le',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-colorspace', 'bt709',
    ];
  }
  const audioArgs =
    !isPng && !job.isImage && probe && probe.hasAudio ? ['-map', '0:a:0', '-c:a', 'pcm_s16le'] : [];

  const args = [
    '-y',
    '-hide_banner',
    ...inputArgs,
    '-filter_complex', parts.join(';'),
    '-map', '[out]',
    ...audioArgs,
    ...codecArgs,
    ...(job.isImage && !isPng ? ['-r', String(fps)] : []),
    '-progress', 'pipe:1',
    '-nostats',
    job.outPath,
  ];
  return { args, durationSec: isPng ? null : job.isImage ? dur : probe && probe.durationSec };
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
    /* window weg */
  }
}

async function startBatch(win, payload) {
  cancelled = false;
  const { project, jobs, codec, fps, imageDuration } = payload;
  const caps = getCapabilities();
  const ffPath = codec === 'dxv' ? caps.dxvPath : caps.proresPath;
  if (!ffPath) {
    throw new Error(
      codec === 'dxv'
        ? 'No ffmpeg with DXV encoder found (bin/ffmpeg-dxv missing?).'
        : 'ffmpeg not found'
    );
  }

  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    if (cancelled) break;
    const job = jobs[i];
    send(win, { type: 'job-start', index: i, total: jobs.length, file: job.src });
    try {
      const probe = probeMedia(ffPath, job.src);
      const { args, durationSec } = buildArgs(project, job, { codec, fps, imageDuration }, probe);
      await runFfmpeg(ffPath, args, durationSec, (pct) =>
        send(win, { type: 'progress', index: i, total: jobs.length, percent: pct })
      );
      results.push({ src: job.src, out: job.outPath, ok: true });
      send(win, { type: 'job-done', index: i, total: jobs.length, out: job.outPath });
    } catch (err) {
      const msg = String((err && err.message) || err);
      results.push({ src: job.src, ok: false, error: msg });
      send(win, { type: 'job-error', index: i, total: jobs.length, error: msg });
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
      /* al gestopt */
    }
  }
}

module.exports = {
  getCapabilities,
  probeMedia,
  extractFrame,
  effectiveSlices,
  buildArgs,
  runFfmpeg,
  startBatch,
  cancel,
};
