'use strict';
// One log file per export: what ran, with which ffmpeg, and what ffmpeg said. A log that
// can't be written never stops an export.
const fs = require('fs');
const path = require('path');

const KEEP_LOGS = 30;
const MAX_STDERR_BYTES = 256 * 1024; // per command: a full log of a long encode stays readable
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

function stamp(date) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`;
}

const isLogName = (n) => /^export-.*\.log$/.test(n);

function pruneLogs(dir, keep) {
  try {
    const names = fs.readdirSync(dir).filter(isLogName).sort();
    for (const n of names.slice(0, Math.max(0, names.length - keep))) {
      try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* the next export tries again */ }
    }
  } catch (e) {
    /* no log folder yet */
  }
}

const NOT_LOGGING = { path: null, line() {}, command() {}, stderr() {}, endCommand() {}, finish() {} };

// settings: {dir, app:{version, platform, arch}}. Without settings nothing is written (tests).
function begin(settings, header) {
  if (!settings || !settings.dir) return NOT_LOGGING;
  const file = path.join(settings.dir, `export-${stamp(new Date())}.log`);
  let stderrBytes = 0;
  let truncated = false;
  const write = (text) => {
    try { fs.appendFileSync(file, text); } catch (e) { /* disk full or folder gone: export goes on */ }
  };
  try {
    fs.mkdirSync(settings.dir, { recursive: true });
  } catch (e) {
    return NOT_LOGGING;
  }
  const app = settings.app || {};
  const lines = [
    `XtremeLED Remap Export ${app.version || '?'} (${app.platform || process.platform} ${app.arch || process.arch})`,
    `Started: ${new Date().toISOString()}`,
    ...Object.keys(header || {}).map((k) => `${k}: ${header[k]}`),
    '',
  ];
  write(`${lines.join('\n')}\n`);
  pruneLogs(settings.dir, KEEP_LOGS);
  return {
    path: file,
    line(text) { write(`${text}\n`); },
    command(ffPath, args) {
      stderrBytes = 0;
      truncated = false;
      write(`$ ${ffPath} ${args.join(' ')}\n`);
    },
    stderr(chunk) {
      if (truncated) return;
      const text = chunk.toString();
      if (stderrBytes + text.length > MAX_STDERR_BYTES) {
        truncated = true;
        write(`${text.slice(0, MAX_STDERR_BYTES - stderrBytes)}\n[... the rest of the ffmpeg output is left out]\n`);
        return;
      }
      stderrBytes += text.length;
      write(text);
    },
    endCommand(code) { write(`\n[ffmpeg exit code: ${code === null ? 'killed' : code}]\n\n`); },
    finish(results) {
      const failed = results.filter((r) => !r.ok).length;
      write(`\nFinished: ${new Date().toISOString()} - ${results.length - failed} ok, ${failed} failed\n`);
    },
  };
}

// The newest log, cut from the start if it is long: the end of a log is where the problem is
function latestLog(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter(isLogName).sort();
  } catch (e) {
    return null;
  }
  const last = names[names.length - 1];
  if (!last) return null;
  const file = path.join(dir, last);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
  if (text.length > MAX_DIAGNOSTIC_BYTES) text = `[... start of the log left out]\n${text.slice(-MAX_DIAGNOSTIC_BYTES)}`;
  return { path: file, text };
}

function appendCrash(dir, text) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'crashes.log'), `${new Date().toISOString()} ${text}\n`);
  } catch (e) {
    /* nothing more we can do */
  }
}

module.exports = { begin, latestLog, appendCrash, pruneLogs, KEEP_LOGS };
