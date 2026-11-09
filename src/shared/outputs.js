'use strict';
// How exports are named while they are written, and how a finished file is judged.
// No file access here, so the renderer and the render pipeline share the same rules.
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Outputs = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const PARTIAL = '.xre-partial';
  const OLD = '.xre-old';
  // Room for the marker: the final name may be close to the 255-character limit
  const MAX_STEM = 200;

  function splitExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
  }

  // The media extension stays last: ffmpeg picks the container from it
  function partialName(base, isDir) {
    if (isDir) return base.slice(0, MAX_STEM) + PARTIAL;
    const [stem, ext] = splitExt(base);
    return stem.slice(0, MAX_STEM) + PARTIAL + ext;
  }

  const oldName = (base) => base.slice(0, MAX_STEM) + OLD;

  function isTempName(name) {
    return /\.xre-(partial|old)(\.[^.]+)?$/i.test(String(name));
  }

  function versionedName(base, n, isDir) {
    if (isDir) return `${base}_v${n}`;
    const [stem, ext] = splitExt(base);
    return `${stem}_v${n}${ext}`;
  }

  // Windows and the default macOS volume ignore case in file names
  function samePath(a, b) {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return !!a && !!b && norm(a) === norm(b);
  }

  // Name ffmpeg reports for each export codec when it reads the file back
  function probedCodec(id) {
    if (/^prores/.test(id)) return 'prores';
    if (id === 'dxv') return 'dxv';
    if (id === 'dxv_hq' || id === 'hap' || id === 'hap_q') return 'hap';
    if (id === 'png' || id === 'png_seq') return 'png';
    if (id === 'hevc' || id === 'h264') return id;
    return null;
  }

  // A container's duration runs a little past its video, and further with an audio track
  function frameTolerance(expected, hasAudio) {
    return Math.max(2, Math.ceil(expected * (hasAudio ? 0.05 : 0.01)));
  }

  // actual: {width, height, codec, frames, durationSec}; expect: the same fields, null = don't check
  function compareOutput(actual, expect) {
    const warnings = [];
    if (expect.audio) {
      if (expect.durationSec != null && actual.durationSec != null && Math.abs(actual.durationSec - expect.durationSec) > Math.max(0.2, expect.durationSec * 0.02)) {
        warnings.push(`${actual.durationSec.toFixed(2)} s, expected ${expect.durationSec.toFixed(2)} s`);
      }
      return warnings;
    }
    if (actual.width && actual.height && expect.width && (actual.width !== expect.width || actual.height !== expect.height)) {
      warnings.push(`size is ${actual.width}×${actual.height}, expected ${expect.width}×${expect.height}`);
    }
    if (actual.codec && expect.codec && actual.codec !== expect.codec) {
      warnings.push(`codec is ${actual.codec}, expected ${expect.codec}`);
    }
    if (expect.frames != null) {
      if (actual.frames == null) warnings.push('frame count could not be read');
      else if (Math.abs(actual.frames - expect.frames) > frameTolerance(expect.frames, expect.hasAudio)) {
        warnings.push(`${actual.frames} frames, expected ${expect.frames}`);
      }
    }
    if (expect.timecode && (actual.timecode || '').replace(/\D/g, '') !== expect.timecode.replace(/\D/g, '')) {
      warnings.push(actual.timecode ? `timecode is ${actual.timecode}, expected ${expect.timecode}` : `timecode ${expect.timecode} was not written`);
    }
    return warnings;
  }

  function formatSize(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
  }

  // The two lines of a finished row: "3840×2160 · 250 frames" and "70.8 MB · verified"
  function summaryLines(check) {
    let first;
    if (check.kind === 'audio') first = `WAV · ${check.durationSec != null ? check.durationSec.toFixed(2) + ' s' : 'length unknown'}`;
    else {
      const size = check.width ? `${check.width}×${check.height}` : 'size unknown';
      if (check.kind === 'still') first = size;
      else if (check.kind === 'sequence') first = `${size} · ${check.frames} PNG files`;
      else first = `${size} · ${check.frames != null ? check.frames : '?'} frames`;
    }
    const verdict = check.warnings.length ? check.warnings.join(', ') : 'verified';
    return [first, `${formatSize(check.sizeBytes)} · ${verdict}`];
  }

  return { partialName, oldName, isTempName, versionedName, samePath, probedCodec, frameTolerance, compareOutput, formatSize, summaryLines };
});
