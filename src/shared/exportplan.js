'use strict';
// The export page's sums: what a choice means, where files land, how big they get and how
// long is left. No file access or DOM here, so the rules can be tested on their own.
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ExportPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // ---------------- what it plays back on ----------------
  const TARGETS = [
    { id: 'resolume_best', title: 'Resolume, best quality', chip: 'HAP Q', codec: 'hap_q', hint: 'Sharp, fast, large' },
    { id: 'resolume_small', title: 'Resolume, small file', chip: 'DXV', codec: 'dxv', hint: 'Softer, fast, small' },
    { id: 'server', title: 'Media server / QuickTime', chip: 'ProRes HQ', codec: 'prores_hq', hint: 'Top quality, slow, large' },
    { id: 'player', title: 'Media player', chip: 'H.264', codec: 'h264', hint: 'Any player, slow, small' },
  ];

  const targetForCodec = (codecId) => TARGETS.find((t) => t.codec === codecId) || null;

  // First run: HAP Q when this machine has it, otherwise ProRes HQ, which ffmpeg always has
  function defaultCodec(isAvailable) {
    return isAvailable('hap_q') ? 'hap_q' : 'prores_hq';
  }

  // ---------------- remembered settings ----------------
  const ALPHAS = ['none', 'straight', 'only'];

  // Only fields that are really there and usable. destDir: null is a choice ("same as footage"),
  // a missing destDir means nothing was decided.
  function normalizeSettings(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    if (typeof raw.codec === 'string' && raw.codec) out.codec = raw.codec;
    if (ALPHAS.includes(raw.alpha)) out.alpha = raw.alpha;
    if (Number.isInteger(raw.depth) && raw.depth > 0) out.depth = raw.depth;
    if (typeof raw.bitrate === 'string') out.bitrate = raw.bitrate;
    if (Number.isFinite(raw.fps) && raw.fps >= 1 && raw.fps <= 240) out.fps = raw.fps;
    if (Number.isFinite(raw.dur) && raw.dur >= 1 && raw.dur <= 3600) out.dur = raw.dur;
    if (raw.destDir === null || (typeof raw.destDir === 'string' && raw.destDir)) out.destDir = raw.destDir;
    if (['source', '25', '30', '50', '60'].includes(raw.rate)) out.rate = raw.rate;
    const grid = raw.panelGrid;
    if (grid && typeof grid === 'object' && Number.isInteger(grid.w) && Number.isInteger(grid.h) && grid.w > 1 && grid.h > 1) {
      out.panelGrid = { on: !!grid.on, w: grid.w, h: grid.h };
    }
    return out;
  }

  // What the project says, and for what it does not say the last-used values.
  // fromProject tells whether the folder is the project's own, which decides how a dead folder is reported.
  function resolveSettings(projectSettings, lastUsed) {
    const own = normalizeSettings(projectSettings);
    const merged = Object.assign({}, normalizeSettings(lastUsed), own);
    merged.folderFromProject = Object.prototype.hasOwnProperty.call(own, 'destDir');
    return merged;
  }

  // ---------------- where files land ----------------
  const slashes = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

  function isInsideFolder(p, folder) {
    const a = slashes(p).toLowerCase();
    const b = slashes(folder).toLowerCase();
    return !!a && !!b && a.startsWith(`${b}/`);
  }

  function folderOf(p) {
    const s = String(p);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (i <= 0) return s;
    const dir = s.slice(0, i);
    return /^[a-zA-Z]:$/.test(dir) ? s.slice(0, i + 1) : dir; // "D:" alone means the drive's current folder
  }

  // The folder a clip's export goes to. The system Temp folder is never a destination by
  // itself: a clip that lives there (a test pattern) goes to Documents instead.
  function outputFolder(src, destDir, paths) {
    if (destDir) return destDir;
    const dir = folderOf(src);
    if (paths && paths.temp && paths.documents && (isInsideFolder(dir, paths.temp) || slashes(dir).toLowerCase() === slashes(paths.temp).toLowerCase())) {
      return paths.documents;
    }
    return dir;
  }

  function stemOf(fileName) {
    const i = fileName.lastIndexOf('.');
    return i > 0 ? fileName.slice(0, i) : fileName;
  }

  function outputStem(base, codecId, alpha, width, height, suffix) {
    return `${base}_remap_${codecId}${alpha && alpha !== 'none' ? '_' + alpha : ''}_${width}x${height}${suffix || ''}`;
  }

  // The name of a disk as people say it: "D:", "Backup", or null for the Mac's startup disk
  function volumeLabel(dir, platform) {
    const s = String(dir);
    if (platform === 'win32') {
      const drive = s.match(/^[a-zA-Z]:/);
      if (drive) return drive[0].toUpperCase();
      const unc = s.match(/^\\\\[^\\]+\\[^\\]+/);
      return unc ? unc[0] : null;
    }
    const mounted = s.match(/^\/Volumes\/([^/]+)/);
    return mounted ? mounted[1] : null;
  }

  // ---------------- the footage table ----------------
  // Head and tail of a name: the head gets the ellipsis, so the end of the name stays readable
  function splitMiddle(name, tailLength) {
    const n = tailLength || 14;
    if (name.length <= n) return ['', name];
    return [name.slice(0, name.length - n), name.slice(name.length - n)];
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (v) => String(v).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
  }

  // Length of a clip inside its trim; 0 when the length is not known
  function trimmedSeconds(durationSec, inSec, outSec) {
    const start = inSec > 0 ? inSec : 0;
    const end = outSec > start ? Math.min(outSec, durationSec || outSec) : durationSec || 0;
    return Math.max(0, end - start);
  }

  const isTrimmed = (inSec, outSec) => (inSec > 0) || (outSec != null && outSec > 0);

  // One status for a clip, whichever of its outputs (screens) is furthest along
  function clipStatus(states) {
    if (!states.length) return '';
    if (states.includes('run')) return 'run';
    if (states.includes('fail')) return 'fail';
    if (states.includes('wait')) return 'wait';
    return states.includes('warn') ? 'warn' : 'done';
  }

  // How many outputs each answer to the "Multiple outputs" question gives
  function outputCounts(clipCount, screenCount) {
    return { separate: clipCount * screenCount, merged: clipCount, both: clipCount * (screenCount + 1) };
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ---------------- the Start button ----------------
  // input: {total, ticked, missing, running, destProblem}; reason is shown when disabled
  function startState(input) {
    const ready = input.ticked - input.missing;
    const label = ready > 0 ? `Export ${plural(ready, 'clip')}` : 'Export';
    if (input.running) return { disabled: true, label, reason: '' };
    if (!input.total) return { disabled: true, label, reason: 'Add footage first.' };
    if (!input.ticked) return { disabled: true, label, reason: 'Tick at least one clip.' };
    if (ready <= 0) return { disabled: true, label, reason: 'The selected footage is missing.' };
    if (input.destProblem) return { disabled: true, label, reason: 'The output folder is not available.' };
    return { disabled: false, label, reason: '' };
  }

  // ---------------- batch progress ----------------
  // How much of the batch this job is, in seconds of material. A still counts as one second.
  function jobWeight(job, def, imageDuration) {
    if (def.still && !def.sequence) return 1;
    if (job.isImage) return imageDuration > 0 ? imageDuration : 1;
    return trimmedSeconds(job.durationSec, job.inSec, job.outSec);
  }

  // Clips of unknown length count as the average of the ones that are known
  function evenOutWeights(weights) {
    const known = weights.filter((w) => w > 0);
    const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    return weights.map((w) => (w > 0 ? w : fallback));
  }

  // Tracks the batch by material done against wall-clock time; now is passed in so a test can drive it.
  // A clip's own pace is used for its time left, the overall pace for the clips still to come.
  function createBatchClock(weights, startedAt) {
    const w = evenOutWeights(weights);
    const total = w.reduce((a, b) => a + b, 0) || 1;
    const part = w.map(() => 0); // 0..1 per job
    let current = 0;
    let clipStart = startedAt;

    function start(index, now) {
      current = index;
      clipStart = now;
    }
    function progress(index, percent) {
      part[index] = Math.max(part[index], Math.min(1, percent / 100));
    }
    function finish(index) {
      part[index] = 1;
    }
    function snapshot(now) {
      const done = part.reduce((sum, p, i) => sum + p * w[i], 0);
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      const clipElapsed = Math.max(0.001, (now - clipStart) / 1000);
      const clipDone = part[current] * w[current];
      const fraction = Math.min(1, done / total);
      // Too early to say something honest: no pace yet (speed is N/A at the start of a clip)
      const clipReady = clipElapsed >= 2 && part[current] >= 0.02 && clipDone > 0;
      if (!clipReady && done <= 0) return { fraction, clipLeft: null, batchLeft: null };
      const pace = done / elapsed;
      const clipPace = clipReady ? clipDone / clipElapsed : pace;
      if (!(clipPace > 0) || !(pace > 0)) return { fraction, clipLeft: null, batchLeft: null };
      const clipLeft = clipReady ? (w[current] - clipDone) / clipPace : null;
      const after = w.slice(current + 1).reduce((a, b) => a + b, 0);
      const batchLeft = clipLeft == null ? null : clipLeft + after / pace;
      return { fraction, clipLeft, batchLeft };
    }
    return { start, progress, finish, snapshot };
  }

  // "Clip 2 of 3 · 04:12 left · batch 11:30 left"; "File" when one clip gives several outputs
  function progressLabel(index, jobCount, clipCount, snap) {
    const unit = jobCount !== clipCount ? 'File' : 'Clip';
    const head = `${unit} ${index + 1} of ${jobCount}`;
    if (!snap || snap.clipLeft == null) return `${head} · estimating…`;
    const clip = `${formatClock(snap.clipLeft)} left`;
    if (jobCount === 1) return `${head} · ${clip}`;
    return `${head} · ${clip} · batch ${formatClock(snap.batchLeft)} left`;
  }

  // ---------------- size before you start ----------------
  // sample: {bytes, frames, pixels} from a short real encode. clips: [{frames, audioBytes}];
  // targets: [{width, height}] are the canvases one clip is written to.
  function estimateBytes(sample, clips, targets) {
    if (!sample || !sample.frames || !sample.pixels || !sample.bytes) return null;
    const perPixelFrame = sample.bytes / (sample.frames * sample.pixels);
    const pixels = targets.reduce((sum, t) => sum + t.width * t.height, 0);
    return clips.reduce((sum, c) => sum + c.frames * pixels * perPixelFrame + (c.audioBytes || 0) * targets.length, 0);
  }

  // Audio bytes of one output. mp4 carries 320 kbit/s AAC; mov and WAV carry PCM.
  function audioBytes(def, probe, seconds, depth) {
    if (def.still || def.sequence) return 0;
    if (!probe || !probe.hasAudio || !(seconds > 0)) return 0;
    if (def.ext === 'mp4') return seconds * 40000;
    const channels = probe.audioChannels || 2;
    const bytesPerSample = def.audioOnly ? (depth || 16) / 8 : 2;
    return seconds * 48000 * channels * bytesPerSample;
  }

  // 'ok', 'tight' (amber) or 'full' (red): an estimate is never exact, so "tight" starts early
  function spaceLevel(bytes, freeBytes) {
    if (freeBytes == null || bytes == null) return 'ok';
    if (bytes >= freeBytes) return 'full';
    const left = freeBytes - bytes;
    return left < 2 * 1024 ** 3 || bytes > freeBytes * 0.85 ? 'tight' : 'ok';
  }

  // Adds up the destination folders per disk, so several folders on one disk are weighed together.
  // folders: [{dir, volume, freeBytes}]; bytesPerDir: Map of dir -> bytes.
  // A Unix path without a label is on the Mac's startup disk; anything else unlabelled stays on its own.
  function bytesPerVolume(folders, bytesPerDir) {
    const perVolume = new Map();
    folders.forEach((info) => {
      const key = info.volume || (String(info.dir).startsWith('/') ? '/' : info.dir);
      const v = perVolume.get(key) || { volume: info.volume, freeBytes: null, bytes: 0 };
      if (v.freeBytes == null) v.freeBytes = info.freeBytes;
      v.bytes += bytesPerDir.get(info.dir) || 0;
      perVolume.set(key, v);
    });
    return [...perVolume.values()];
  }

  // The destination with the least room to spare is the one worth talking about
  function tightestVolume(volumes) {
    const rank = { full: 2, tight: 1, ok: 0 };
    const levelled = volumes.map((v) => Object.assign({}, v, { level: spaceLevel(v.bytes, v.freeBytes) }));
    return levelled.sort((a, b) => rank[b.level] - rank[a.level] || (a.freeBytes - a.bytes) - (b.freeBytes - b.bytes))[0] || null;
  }

  // "About 8.4 GB · 212 GB free on D:"
  function spaceLine(totalBytes, volume, formatSize) {
    const size = `About ${formatSize(totalBytes)}`;
    if (!volume || volume.freeBytes == null) return size;
    return `${size} · ${formatSize(volume.freeBytes)} free${volume.volume ? ` on ${volume.volume}` : ''}`;
  }

  // ---------------- the export jobs ----------------
  // One job per clip per output. What touches files or the page is passed in as io, so the
  // same code runs in the app and in the tests.
  async function buildJobs(input, io) {
    const { project, merged, outMode, files, codecId, codecDef, alpha, padAccepted } = input;
    const multiScreen = project.screens.length > 1;
    const targets = [];
    if (outMode === 'separate' || outMode === 'both') {
      for (const screen of project.screens) {
        targets.push({ proj: null, screen, suffix: multiScreen ? `_${io.sanitizeName(screen.name)}` : '' });
      }
    }
    if (outMode === 'merged' || outMode === 'both') {
      targets.push({ proj: merged, screen: merged.screens[0], suffix: '_merged' });
    }

    const jobs = [];
    for (const tgt of targets) {
      const maskFiles = await io.maskFilesFor(tgt.proj || project, tgt.screen.id);
      const fit = io.fitSize(tgt.screen);
      for (const f of files) {
        const pp = await io.pathParse(f.path);
        const dest = io.folderFor(f);
        const stem = outputStem(io.stemFor(f, pp), codecId, alpha, fit.width, fit.height, tgt.suffix);
        let outPath;
        let outDir = null;
        if (codecDef.sequence) {
          outDir = await io.pathJoin(dest, `${stem}_seq`);
          outPath = await io.pathJoin(outDir, 'frame_%05d.png');
        } else {
          outPath = await io.pathJoin(dest, `${stem}.${codecDef.ext}`);
        }
        jobs.push({
          src: f.path,
          isImage: f.isImage,
          outPath,
          outDir,
          transform: f.transform,
          inSec: f.inSec,
          outSec: f.outSec,
          sequence: f.sequence || null,
          pngTime: codecDef.still && !codecDef.sequence && !f.isImage ? f.frameTime || f.inSec || 0 : 0,
          screen: { id: tgt.screen.id, name: tgt.screen.name, width: tgt.screen.width, height: tgt.screen.height },
          allowPad: !!(fit.rule && fit.rule.strict) && !!padAccepted,
          maskFiles,
          project: tgt.proj || undefined,
          label: targets.length > 1 || multiScreen ? `${io.labelFor(f)} → ${tgt.screen.name}` : io.labelFor(f),
        });
      }
    }
    return jobs;
  }

  return {
    buildJobs,
    TARGETS, targetForCodec, defaultCodec, normalizeSettings, resolveSettings,
    isInsideFolder, folderOf, outputFolder, stemOf, outputStem, volumeLabel,
    splitMiddle, formatClock, trimmedSeconds, isTrimmed, clipStatus, outputCounts, plural,
    startState, jobWeight, evenOutWeights, createBatchClock, progressLabel,
    estimateBytes, audioBytes, spaceLevel, bytesPerVolume, tightestVolume, spaceLine,
  };
});
