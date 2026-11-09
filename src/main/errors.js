'use strict';
// Turns export failures into one plain sentence for the log, and keeps the full technical
// text for the "Copy details" link. Also checks an output folder before anything is rendered.
const fs = require('fs');
const path = require('path');

const FOLDER_GONE = (dir) => `The output folder ${dir} does not exist or cannot be reached.`;
const DISK_FULL = (dir) => `The disk of the output folder ${dir} is full.`;
const NOT_WRITABLE = (dir) => `The output folder ${dir} is read-only or you have no permission to write there.`;
const FILE_IN_USE = (name) => `Could not write ${name}: the file is in use (for example by Resolume) or read-only.`;
const SOURCE_GONE = (name) => `The source file ${name} is missing or cannot be reached.`;
const SOURCE_LOCKED = (name) => `Could not read the source file ${name}: it is in use or you have no permission.`;
const SOURCE_BAD = (name) => `The source file ${name} is damaged, incomplete or not a video this app can read.`;

const shortName = (p) => (p ? path.basename(p) : 'the file');

// Lines worth showing from ffmpeg's stderr, without the "[hap @ 0x...]" prefixes
function usefulLines(stderr) {
  return String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim())
    .filter((l) => l && /error|fail|invalid|cannot|could not|not /i.test(l) && !/^Conversion failed/i.test(l));
}

// ctx: {src, out} (out may be a folder for PNG sequences)
function explainError(err, ctx) {
  const raw = String((err && err.message) || err);
  const c = ctx || {};
  const outDir = c.out ? path.dirname(c.out) : '';
  if (raw === 'Cancelled') return { message: 'Cancelled', detail: null };
  const plain = (message) => ({ message, detail: raw });

  // Node errors (mkdir, spawn)
  const code = err && err.code;
  if (code === 'ENOSPC') return plain(DISK_FULL(outDir));
  if (code === 'ENOENT' && /spawn/i.test(raw)) return plain('The bundled ffmpeg could not be started. Reinstall the app.');
  if (code === 'ENOENT') return plain(FOLDER_GONE(outDir));
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return plain(NOT_WRITABLE(outDir));

  if (!/^ffmpeg error/.test(raw)) return plain(raw); // already plain (e.g. "Source has no audio track")

  const t = raw;
  const sizeRefused = t.match(/Video size (\d+x\d+) is not multiple of (\d+)/i);
  if (sizeRefused) return plain(`The codec can't make ${sizeRefused[1].replace('x', '×')}: width and height must be divisible by ${sizeRefused[2]}.`);
  if (/No space left|ENOSPC/i.test(t)) return plain(DISK_FULL(outDir));

  const isInput = /Error opening input/i.test(t) || (c.src && t.includes(`${c.src}:`));
  const notFound = /No such file or directory/i.test(t);
  const denied = /Permission denied|resource busy|sharing violation/i.test(t);
  if (notFound) return plain(isInput ? SOURCE_GONE(shortName(c.src)) : FOLDER_GONE(outDir));
  if (denied) return plain(isInput ? SOURCE_LOCKED(shortName(c.src)) : FILE_IN_USE(shortName(c.out)));
  if (/moov atom not found|Invalid data found when processing input/i.test(t)) return plain(SOURCE_BAD(shortName(c.src)));
  if (/Cannot allocate memory|out of memory/i.test(t)) return plain('Not enough memory for this export. Close other programs or try a smaller size.');
  if (/Unknown encoder|Encoder \S+ not found/i.test(t)) return plain('This codec is not available in the bundled ffmpeg.');

  const lines = usefulLines(t.slice(t.indexOf('\n') + 1));
  const reason = lines.length ? lines[lines.length - 1] : 'ffmpeg stopped without giving a reason.';
  return plain(`Export failed: ${reason}`);
}

// Before anything renders: does the output folder exist and can we really write there?
// Returns null when fine, otherwise {message, detail}.
function checkOutputDir(dir) {
  const shown = path.normalize(dir);
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    return { message: FOLDER_GONE(shown), detail: `${dir}\n${e.message}` };
  }
  if (!st.isDirectory()) return { message: FOLDER_GONE(shown), detail: `${dir} is not a folder` };
  const probe = path.join(dir, `.xre-write-test-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    try { fs.unlinkSync(probe); } catch (e2) { /* never created */ }
    const message = e.code === 'ENOSPC' ? DISK_FULL(shown) : NOT_WRITABLE(shown);
    return { message, detail: `${dir}\n${e.message}` };
  }
}

module.exports = { explainError, checkOutputDir, usefulLines };
