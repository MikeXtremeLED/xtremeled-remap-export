'use strict';
// Saving and finding the user's files: a write that can never leave a half file behind,
// where footage has gone, and the store that keeps each reference image once on disk.
const fs = require('fs');
const path = require('path');
const { renameRetry, discard } = require('./output-files');

// One sentence for a dialog; the file name, never a Node error code
function explainWriteError(err, target) {
  const name = path.basename(target);
  switch (err && err.code) {
    case 'EPERM':
    case 'EACCES':
    case 'EROFS':
      return `Could not save ${name}: the file or its folder is read-only, or you have no permission to write there.`;
    case 'EBUSY':
      return `Could not save ${name}: it is in use by another program.`;
    case 'ENOSPC':
      return `Could not save ${name}: the disk is full.`;
    case 'ENOENT':
      return `Could not save ${name}: the folder no longer exists or the drive is not connected.`;
    case 'EISDIR':
      return `Could not save ${name}: a folder has that name.`;
    default:
      return `Could not save ${name}: ${(err && err.message) || err}`;
  }
}

// Written beside the target and renamed over it, so the old file stays whole until the new
// one is safely on disk. Throws an Error with a plain-language message.
async function writeTextSafely(target, text) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${Date.now()}.xre-save.tmp`);
  try {
    let mode = null;
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) throw Object.assign(new Error('is a folder'), { code: 'EISDIR' });
      fs.accessSync(target, fs.constants.W_OK); // a rename would replace a read-only file anyway
      mode = st.mode;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd); // really on the disk (or the USB stick) before the old file goes
    } finally {
      fs.closeSync(fd);
    }
    if (mode !== null) fs.chmodSync(tmp, mode);
    await renameRetry(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {
      /* nothing written */
    }
    throw new Error(explainWriteError(err, target));
  }
}

// [paths] -> [true/false]: is there a file at each path right now?
async function filesExist(paths) {
  return Promise.all(
    paths.map(async (p) => {
      try {
        return (await fs.promises.stat(p)).isFile();
      } catch (e) {
        return false;
      }
    })
  );
}

// Which of these file names are in this folder? {name as asked: fullPath}. Case does not matter,
// nor how an accent is encoded (a project made on a Mac often holds the decomposed form).
async function findByName(dir, names) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch (e) {
    return {};
  }
  const sameName = (n) => String(n).normalize('NFC').toLowerCase();
  const byName = new Map(entries.map((e) => [sameName(e), e]));
  const found = {};
  for (const name of names) {
    const hit = byName.get(sameName(name));
    if (!hit) continue;
    const full = path.join(dir, hit);
    if ((await filesExist([full]))[0]) found[name] = full;
  }
  return found;
}

// ---------------- reference image store ----------------
const KEY_OK = /^[a-z0-9-]+$/;
const refPath = (dir, key) => {
  if (!KEY_OK.test(String(key))) throw new Error('Invalid reference key');
  return path.join(dir, `${key}.txt`);
};

async function refPut(dir, key, dataUrl) {
  const file = refPath(dir, key);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) await writeTextSafely(file, String(dataUrl));
}

function refGet(dir, key) {
  try {
    return fs.readFileSync(refPath(dir, key), 'utf8');
  } catch (e) {
    return null;
  }
}

// Removes images no project state refers to any more
function refPrune(dir, keepKeys) {
  const keep = new Set(keepKeys.map((k) => `${k}.txt`));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return;
  }
  for (const name of names) {
    if (!keep.has(name) && !name.endsWith('.tmp')) { // a .tmp may be a write still in progress
      try {
        discard(path.join(dir, name));
      } catch (e) {
        /* tried again on the next start */
      }
    }
  }
}

module.exports = { writeTextSafely, explainWriteError, filesExist, findByName, refPut, refGet, refPrune };
