'use strict';
// ffmpeg render-pipeline: stageview bron -> crop/scale/overlay per slice -> output canvas.
// ProRes 422 HQ via prores_ks; DXV3 via de ffmpeg 'dxv' encoder (ffmpeg 7.1+, bv. Homebrew).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// Duur / fps / audio van een bronbestand bepalen via ffmpeg -i (geen ffprobe nodig).
function probeMedia(ffPath, file) {
  const r = spawnSync(ffPath, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 20000 });
  const err = (r.stderr || '') + (r.stdout || '');
  const out = { durationSec: null, fps: null, hasAudio: /Stream #[^\n]*Audio/.test(err) };
  const dm = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dm) out.durationSec = parseInt(dm[1], 10) * 3600 + parseInt(dm[2], 10) * 60 + parseFloat(dm[3]);
  const fm = err.match(/(\d+(?:\.\d+)?)\s*fps/) || err.match(/(\d+(?:\.\d+)?)\s*tbr/);
  if (fm) out.fps = parseFloat(fm[1]);
  return out;
}

// Slices klemmen op de input canvas; output rect schaalt proportioneel mee.
function effectiveSlices(project) {
  const IW = Math.max(1, Math.round(project.input.width));
  const IH = Math.max(1, Math.round(project.input.height));
  const result = [];
  for (const s of project.slices) {
    if (s.enabled === false) continue;
    const iw = s.in.w;
    const ih = s.in.h;
    if (iw <= 0 || ih <= 0 || s.out.w <= 0 || s.out.h <= 0) continue;
    const x0 = Math.max(0, Math.min(IW, s.in.x));
    const x1 = Math.max(0, Math.min(IW, s.in.x + iw));
    const y0 = Math.max(0, Math.min(IH, s.in.y));
    const y1 = Math.max(0, Math.min(IH, s.in.y + ih));
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    const fx0 = (x0 - s.in.x) / iw;
    const fx1 = (x1 - s.in.x) / iw;
    const fy0 = (y0 - s.in.y) / ih;
    const fy1 = (y1 - s.in.y) / ih;
    result.push({
      crop: {
        x: Math.round(x0),
        y: Math.round(y0),
        w: Math.max(1, Math.round(x1 - x0)),
        h: Math.max(1, Math.round(y1 - y0)),
      },
      place: {
        x: Math.round(s.out.x + fx0 * s.out.w),
        y: Math.round(s.out.y + fy0 * s.out.h),
        w: Math.max(1, Math.round((fx1 - fx0) * s.out.w)),
        h: Math.max(1, Math.round((fy1 - fy0) * s.out.h)),
      },
    });
  }
  return result;
}

function buildArgs(project, job, opts, probe) {
  const IW = Math.max(1, Math.round(project.input.width));
  const IH = Math.max(1, Math.round(project.input.height));
  let OW = Math.max(2, Math.round(project.output.width));
  let OH = Math.max(2, Math.round(project.output.height));
  if (OW % 2) OW += 1; // ProRes 4:2:2 vereist even breedte
  if (OH % 2) OH += 1;

  const sl = effectiveSlices(project);
  if (!sl.length) throw new Error('Geen actieve slices binnen de input canvas');

  const isPng = opts.codec === 'png';
  const fps = job.isImage || isPng ? opts.fps || 50 : (probe && probe.fps) || 25;
  const dur = job.isImage && !isPng ? opts.imageDuration || 1 : null;

  const parts = [];
  parts.push(`[0:v]scale=${IW}:${IH}:flags=bicubic,setsar=1[src]`);
  if (sl.length > 1) {
    parts.push(`[src]split=${sl.length}${sl.map((_, i) => `[s${i}]`).join('')}`);
  } else {
    parts.push('[src]null[s0]');
  }
  sl.forEach((s, i) => {
    parts.push(
      `[s${i}]crop=${s.crop.w}:${s.crop.h}:${s.crop.x}:${s.crop.y},scale=${s.place.w}:${s.place.h}:flags=bicubic[c${i}]`
    );
  });
  parts.push(`color=c=black:s=${OW}x${OH}:r=${fps}[base]`);
  let prev = 'base';
  sl.forEach((s, i) => {
    const outLabel = i === sl.length - 1 ? 'out' : `o${i}`;
    const shortest = i === 0 ? ':shortest=1' : '';
    parts.push(`[${prev}][c${i}]overlay=${s.place.x}:${s.place.y}${shortest}[${outLabel}]`);
    prev = outLabel;
  });

  const inputArgs =
    job.isImage && !isPng ? ['-loop', '1', '-t', String(dur), '-i', job.src] : ['-i', job.src];
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
      if (cancelled) return reject(new Error('Geannuleerd'));
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg fout (code ${code}):\n${stderrTail}`));
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
        ? 'Geen ffmpeg met DXV-encoder gevonden. Installeer ffmpeg 7.1+ (brew install ffmpeg).'
        : 'ffmpeg niet gevonden'
    );
  }

  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    if (cancelled) break;
    const job = jobs[i];
    send(win, { type: 'job-start', index: i, total: jobs.length, file: job.src });
    try {
      const probe = job.isImage ? null : probeMedia(ffPath, job.src);
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

module.exports = { getCapabilities, probeMedia, effectiveSlices, buildArgs, runFfmpeg, startBatch, cancel };
