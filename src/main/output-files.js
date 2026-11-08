'use strict';
// File work around an export: the temporary name it renders to, the rename to its final
// name, versions next to an existing file, and which files in a folder are our own output.
const fs = require('fs');
const path = require('path');
const Outputs = require('../shared/outputs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fs.existsSync(p);

// ---------------- own outputs ----------------
const ownOutputs = new Set();
const pathKey = (p) => path.resolve(p).toLowerCase();

function markOwn(p) {
  ownOutputs.add(pathKey(p));
}

function isOwnOutput(p) {
  return ownOutputs.has(pathKey(p));
}

// ---------------- naming ----------------
function partialFor(target, isDir) {
  return path.join(path.dirname(target), Outputs.partialName(path.basename(target), isDir));
}

// First free "_v2", "_v3"… next to target; taken holds names this batch has already claimed
function nextVersion(target, isDir, taken) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  for (let n = 2; ; n++) {
    const candidate = path.join(dir, Outputs.versionedName(base, n, isDir));
    if (!exists(candidate) && !(taken && taken.has(pathKey(candidate)))) return candidate;
  }
}

// The name one job really writes. Two jobs of a batch never share a name, whatever the policy.
function resolveTarget(target, isDir, policy, taken) {
  const clash = taken.has(pathKey(target));
  const useVersion = clash || (policy === 'version' && exists(target));
  const chosen = useVersion ? nextVersion(target, isDir, taken) : target;
  taken.add(pathKey(chosen));
  return chosen;
}

function claimVersion(target, isDir, taken) {
  const chosen = nextVersion(target, isDir, taken);
  taken.add(pathKey(chosen));
  return chosen;
}

function existingOutputs(targets) {
  return targets.filter((t) => exists(t));
}

// ---------------- temporary files ----------------
function discard(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

// A virus scanner or indexer can hold a new file for a moment: try the rename a few times
async function renameRetry(from, to) {
  for (let tries = 0; ; tries++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (tries >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      await wait(300);
    }
  }
}

// A folder can't be renamed onto an existing one: the old folder steps aside first,
// and comes back if the new one can't take its place
async function swapFolder(partial, target) {
  if (!exists(target)) return renameRetry(partial, target);
  const old = path.join(path.dirname(target), Outputs.oldName(path.basename(target)));
  discard(old);
  await renameRetry(target, old);
  try {
    await renameRetry(partial, target);
  } catch (err) {
    fs.renameSync(old, target);
    throw err;
  }
  try {
    discard(old);
  } catch (e) {
    /* a leftover old folder is ignored by the watch folder and cleared on the next export */
  }
  return undefined;
}

// Gives the finished export its final name; the temporary file stays if that isn't possible
async function promote(partial, target, isDir) {
  try {
    if (isDir) await swapFolder(partial, target);
    else await renameRetry(partial, target);
  } catch (err) {
    const name = path.basename(target);
    const e = new Error(`Could not save ${name}: it is in use (for example by Resolume) or read-only. The new export is kept as ${path.basename(partial)}.`);
    e.keepPartial = true;
    e.cause = err;
    throw e;
  }
}

// ---------------- watch folder ----------------
const O_EXLOCK = 0x10000000; // UV_FS_O_EXLOCK: Windows reports the file as busy while anyone writes

// Is another program still writing this file? Windows only; a copy there reports its full
// size from the start, and macOS has no equivalent of this check.
function fileIsBusy(p) {
  if (process.platform !== 'win32') return false;
  let fd = null;
  try {
    fd = fs.openSync(p, fs.constants.O_RDWR | O_EXLOCK);
    return false;
  } catch (err) {
    return err.code === 'EBUSY';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

module.exports = { markOwn, isOwnOutput, partialFor, nextVersion, claimVersion, resolveTarget, existingOutputs, discard, promote, fileIsBusy, O_EXLOCK };
