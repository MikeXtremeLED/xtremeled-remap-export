'use strict';
// What the About card and the update notice need from the main process: is this ffmpeg the
// pinned build, is there a newer release, and the text for "Copy diagnostics".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AppInfo = require('../shared/appinfo');
const manifest = require('./ffmpeg-manifest.json');

const UPDATE_TIMEOUT_MS = 8000;

function platformKey(platform, arch) {
  return `${platform}-${arch}`;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// 'verified' only for the pinned file of this platform with the recorded checksum
async function pinStatus(ffPath, options) {
  const opts = options || {};
  const m = opts.manifest || manifest;
  const entry = m.platforms[platformKey(opts.platform || process.platform, opts.arch || process.arch)];
  if (!entry || !ffPath) return { state: 'unknown' };
  if (path.basename(ffPath) !== entry.file) return { state: 'different', expected: entry.version };
  try {
    const hash = await sha256File(ffPath);
    return hash === entry.sha256 ? { state: 'verified', sha256: hash } : { state: 'different', expected: entry.version, sha256: hash };
  } catch (e) {
    return { state: 'unknown' };
  }
}

// Asks GitHub once; offline, rate limited, no releases or anything else odd is simply "no news"
async function checkForUpdate(currentVersion, options) {
  const opts = options || {};
  if (opts.isBusy && opts.isBusy()) return null;
  const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  try {
    const res = await doFetch(AppInfo.RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'XtremeLED-Remap-Export' },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (!res || !res.ok) return null;
    return AppInfo.updateFromRelease(await res.json(), currentVersion);
  } catch (e) {
    return null;
  }
}

function buildDiagnostics(info) {
  const lines = [
    `XtremeLED Remap Export ${info.version}`,
    `Electron ${info.electron}, Chromium ${info.chrome}, Node ${info.node}`,
    `OS: ${info.platform} ${info.arch} ${info.osRelease}`,
    `Packaged: ${info.packaged ? 'yes' : 'no'}`,
    `Tests in this build: ${info.buildInfo && info.buildInfo.testsPassed > 0 ? `${info.buildInfo.testsPassed} passed` : 'not run'}`,
    '',
    'ffmpeg:',
  ];
  if (info.ffmpeg && info.ffmpeg.entries && info.ffmpeg.entries.length) {
    for (const e of info.ffmpeg.entries) {
      lines.push(`  ${e.version} at ${e.path} (DXV ${e.hasDxv ? 'yes' : 'no'}, HAP ${e.hasHap ? 'yes' : 'no'}, x265 ${e.hasX265 ? 'yes' : 'no'})`);
    }
  } else {
    lines.push('  not found');
  }
  lines.push(`Pinned build check: ${info.pin ? info.pin.state : 'unknown'}${info.pin && info.pin.expected ? ` (expected ${info.pin.expected})` : ''}`);
  lines.push('');
  if (info.log) {
    lines.push(`Last export log (${info.log.path}):`, info.log.text);
  } else {
    lines.push('No export log yet.');
  }
  return lines.join('\n');
}

// A crash is met with a reload, unless the page keeps dying: then the person decides
function crashAction(crashTimes, now, windowMs, maxReloads) {
  const recent = crashTimes.filter((t) => now - t < windowMs);
  return { recent: [...recent, now], ask: recent.length >= maxReloads };
}

module.exports = { platformKey, sha256File, pinStatus, checkForUpdate, buildDiagnostics, crashAction, manifest };
