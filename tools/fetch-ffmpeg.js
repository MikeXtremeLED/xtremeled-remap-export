'use strict';
// Installs the pinned ffmpeg for this platform into bin/ffmpeg-dxv, from the exact file named
// in src/main/ffmpeg-manifest.json, and refuses anything whose SHA-256 doesn't match.
//   node tools/fetch-ffmpeg.js                     download when missing or different
//   node tools/fetch-ffmpeg.js --check             only verify, exit 1 when wrong
//   node tools/fetch-ffmpeg.js --platform=win32-x64  for a cross-build
// The Mac binaries are kept in git, so for those only the check applies.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin', 'ffmpeg-dxv');
const REQUIRED_ENCODERS = ['dxv', 'hap', 'libx265', 'prores_ks'];

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex')));
  });
}

function missingEncoders(encoderList) {
  return REQUIRED_ENCODERS.filter((name) => !new RegExp(`\\s${name}\\s`).test(encoderList));
}

function checkEncoders(binary) {
  const r = spawnSync(binary, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(binary)} does not run: ${r.error ? r.error.message : `exit ${r.status}`}`);
  const missing = missingEncoders(r.stdout || '');
  if (missing.length) throw new Error(`${path.basename(binary)} lacks required encoders: ${missing.join(', ')}`);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

function extract(archive, entry, destDir) {
  // Windows' own tar reads zip files; a tar from Git for Windows, first on some PATHs, does not
  const r = process.platform === 'win32'
    ? spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', destDir, entry], { encoding: 'utf8' })
    : spawnSync('unzip', ['-o', archive, entry, '-d', destDir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Could not unpack ${entry}: ${r.stderr || r.error}`);
  return path.join(destDir, entry);
}

// The binary only lands in bin/ after the archive, the binary and the encoders have all checked out
async function installFromArchive(entry, target, deps) {
  const io = deps || { download, extract, checkEncoders, sha256File };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xre-ffmpeg-'));
  try {
    const archive = path.join(work, 'archive.zip');
    await io.download(entry.archive.url, archive);
    const got = await io.sha256File(archive);
    if (got !== entry.archive.sha256) throw new Error(`Archive checksum mismatch: got ${got}, expected ${entry.archive.sha256}`);
    const unpacked = io.extract(archive, entry.archive.entry, work);
    const gotBin = await io.sha256File(unpacked);
    if (gotBin !== entry.sha256) throw new Error(`Binary checksum mismatch: got ${gotBin}, expected ${entry.sha256}`);
    if (entry.runsHere !== false) io.checkEncoders(unpacked);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(unpacked, `${target}.part`);
    fs.renameSync(`${target}.part`, target);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function argValue(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

async function main() {
  const manifest = require('../src/main/ffmpeg-manifest.json');
  const hostKey = `${process.platform}-${process.arch}`;
  const key = argValue('platform') || hostKey;
  const entry = manifest.platforms[key];
  if (!entry) throw new Error(`No pinned ffmpeg for ${key}`);
  const target = path.join(BIN_DIR, entry.file);
  const here = key === hostKey;
  const current = fs.existsSync(target) ? await sha256File(target) : null;

  if (current === entry.sha256) {
    if (here) checkEncoders(target);
    console.log(`ffmpeg ${entry.version} for ${key}: checksum matches${here ? ', encoders present' : ''}`);
    return;
  }
  if (process.argv.includes('--check') || !entry.archive) {
    throw new Error(`${entry.file}: ${current ? `checksum ${current}` : 'file missing'}, expected ${entry.sha256}`);
  }
  console.log(`Downloading ffmpeg ${entry.version} for ${key}...`);
  await installFromArchive({ ...entry, runsHere: here }, target);
  console.log(`ffmpeg ${entry.version} installed: ${target}`);
}

module.exports = { missingEncoders, installFromArchive, REQUIRED_ENCODERS };

if (require.main === module) {
  main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  });
}
