'use strict';
// Project safety: what counts as a real change, undo without footage loss, the mapping
// update review, reference images stored once, and saving that never leaves a broken file.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Doc = require('../src/shared/projectdoc');
const Store = require('../src/main/file-store');

const rect = (x, y, w, h) => ({ x, y, w, h });
const project = () => ({
  name: 'Show',
  input: { width: 1000, height: 500 },
  screens: [{ id: 'a', name: 'Output #1', width: 1920, height: 1080 }],
  refs: { input: null, output: null },
  exportList: [{ path: 'C:/a.mov', transform: { x: 5 }, inSec: 1, outSec: 2, selected: true, stretchOk: null }],
  slices: [
    { id: 's1', name: 'One', screenId: 'a', enabled: true, in: rect(0, 0, 100, 100), out: rect(0, 0, 100, 100), inOrient: 0, outOrient: 0, flip: 0, mask: null },
    { id: 's2', name: 'Two', screenId: 'a', enabled: true, in: rect(100, 0, 100, 100), out: rect(100, 0, 100, 100), inOrient: 0, outOrient: 0, flip: 0, mask: null },
  ],
});

async function run(ok, tmp) {
  console.log('Project safety');

  const p = project();
  const reordered = Object.assign({}, { slices: p.slices, exportList: p.exportList, name: p.name, refs: p.refs, screens: p.screens, input: p.input });
  assert.strictEqual(Doc.fingerprint(p), Doc.fingerprint(reordered), 'key order is not a change');
  const edited = project();
  edited.slices[0].out.x = 1;
  assert.notStrictEqual(Doc.fingerprint(p), Doc.fingerprint(edited));
  edited.slices[0].out.x = 0;
  assert.strictEqual(Doc.fingerprint(p), Doc.fingerprint(edited), 'undoing back to the same state is no change');
  const trimmed = project();
  trimmed.exportList[0].inSec = 9;
  assert.notStrictEqual(Doc.fingerprint(p), Doc.fingerprint(trimmed), 'a trim is a real change');
  ok('fingerprint: order-free, sees real edits, undo returns to the same state');

  const undoStep = JSON.parse(JSON.stringify(Doc.withoutFootage(p)));
  assert.strictEqual(undoStep.exportList, undefined);
  assert.strictEqual(p.exportList.length, 1, 'the project itself keeps its footage');
  ok('undo step of a mapping edit does not carry the footage list');

  const dataUrl = 'data:image/png;base64,AAAA';
  const withRef = project();
  withRef.refs.input = { dataUrl, name: 'wall.png', opacity: 0.5 };
  const seen = new Map();
  Doc.internRefs(withRef, (k, v) => seen.set(k, v));
  const key = withRef.refs.input.key;
  assert(key && seen.get(key) === dataUrl, 'image kept once under its key');
  assert.strictEqual(withRef.refs.input.dataUrl, undefined);
  assert(!JSON.stringify(withRef).includes(dataUrl), 'no image inside a snapshot or autosave');
  assert.deepStrictEqual(Doc.refKeys(withRef), [key]);
  const onDisk = Doc.embedRefs(withRef, (k) => seen.get(k));
  assert.strictEqual(onDisk.refs.input.dataUrl, dataUrl, 'project file still embeds the image');
  assert.strictEqual(onDisk.refs.input.key, undefined);
  assert.strictEqual(withRef.refs.input.key, key, 'writing the file leaves the live project alone');
  const reopened = JSON.parse(JSON.stringify(onDisk));
  Doc.internRefs(reopened, (k, v) => seen.set(k, v));
  assert.strictEqual(reopened.refs.input.key, key, 'same image, same key');
  assert.strictEqual(Doc.embedRefs(withRef, () => null).refs.input, null, 'a lost image becomes no reference');
  ok('reference images: stored once under a key, embedded only in a project file');

  const same = Doc.diffMapping(project(), project());
  assert(same.identical && same.slicesUnchanged === 2);
  const revised = project();
  revised.input = { width: 1200, height: 500 };
  revised.screens[0].height = 2160;
  revised.slices[0].in.x = 10;
  revised.slices[1].flip = 1;
  revised.slices.push({ id: 's3', name: 'Three', screenId: 'a', in: rect(0, 0, 1, 1), out: rect(0, 0, 1, 1) });
  revised.slices = revised.slices.filter((s) => s.name !== 'Two').concat([{ id: 's9', name: 'Four', screenId: 'a', in: rect(0, 0, 1, 1), out: rect(0, 0, 1, 1) }]);
  const d = Doc.diffMapping(project(), revised);
  assert.deepStrictEqual(d.canvas, { from: '1000×500', to: '1200×500' });
  assert.deepStrictEqual(d.screensResized, [{ name: 'Output #1', from: '1920×1080', to: '1920×2160' }]);
  assert.deepStrictEqual(d.slicesAdded.sort(), ['Four', 'Three']);
  assert.deepStrictEqual(d.slicesRemoved, ['Two']);
  assert.deepStrictEqual(d.slicesMoved, [{ name: 'One', changes: ['input x 0 → 10'] }]);
  assert(!d.identical);
  const flipped = Doc.diffMapping(project(), Object.assign(project(), { slices: project().slices.map((s) => Object.assign({}, s, { flip: 2 })) }));
  assert(flipped.slicesMoved.every((m) => m.changes.includes('flip changed')));
  ok('mapping review: canvas, outputs, slices added, removed and moved');

  const dupOld = project();
  dupOld.slices.forEach((s) => (s.name = 'Tile'));
  const dupNew = project();
  dupNew.slices.forEach((s) => (s.name = 'Tile'));
  dupNew.slices[1].out.y = 50;
  const dd = Doc.diffMapping(dupOld, dupNew);
  assert.strictEqual(dd.slicesMoved.length, 1, 'identically named slices pair up in order');
  assert.strictEqual(dd.slicesUnchanged, 1);
  ok('mapping review: slices sharing a name pair up in order');

  const cur = project();
  const imported = { input: { width: 800, height: 400 }, screens: [{ id: 'b', name: 'Output #1', width: 500, height: 500 }], slices: [] };
  const kept = Doc.keepDerivedSizes(cur, imported);
  assert.deepStrictEqual(kept.input, cur.input, 'tiles fit: real canvas stays');
  assert.strictEqual(kept.screens[0].width, 1920);
  assert.strictEqual(imported.input.width, 800, 'the import itself is left as it was');
  const bigger = Doc.keepDerivedSizes(cur, { input: { width: 2000, height: 400 }, screens: [{ id: 'b', name: 'x', width: 3000, height: 500 }], slices: [] });
  assert.strictEqual(bigger.input.width, 2000, 'tiles beyond the canvas: the derived size wins');
  assert.strictEqual(bigger.screens[0].width, 3000);
  ok('CSV update keeps the real canvas and output when the tiles fit');

  const adopted = Doc.adoptMapping(project(), Object.assign(project(), { name: 'Other', input: { width: 1, height: 1 }, exportList: [] }));
  assert.strictEqual(adopted.name, 'Show', 'project name stays');
  assert.strictEqual(adopted.exportList.length, 1, 'footage stays');
  assert.deepStrictEqual(adopted.input, { width: 1, height: 1 });
  ok('replacing the mapping keeps name and footage');

  // --- writing files for real ---
  const dir = path.join(tmp, 'savefile');
  fs.mkdirSync(dir, { recursive: true });
  const leftovers = () => fs.readdirSync(dir).filter((n) => n.includes('xre-save'));
  const target = path.join(dir, 'show.xreproj');
  await Store.writeTextSafely(target, 'one');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'one');
  await Store.writeTextSafely(target, 'two');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'two');
  assert.deepStrictEqual(leftovers(), []);
  ok('save writes and replaces, leaving no temporary file');

  const locked = path.join(dir, 'locked.xreproj');
  fs.writeFileSync(locked, 'precious');
  fs.chmodSync(locked, 0o444);
  await assert.rejects(Store.writeTextSafely(locked, 'new'), /locked\.xreproj.*read-only/);
  assert.strictEqual(fs.readFileSync(locked, 'utf8'), 'precious', 'a read-only file is untouched');
  assert.deepStrictEqual(leftovers(), []);
  fs.chmodSync(locked, 0o644);
  ok('read-only target: a plain error and the file untouched');

  await assert.rejects(Store.writeTextSafely(path.join(dir, 'gone', 'x.xml'), 'x'), /x\.xml.*no longer exists|not connected/);
  ok('missing folder: a plain error');

  const clip = path.join(dir, 'Clip_A.mov');
  fs.writeFileSync(clip, 'x');
  assert.deepStrictEqual(await Store.filesExist([clip, path.join(dir, 'nope.mov'), dir, '/Volumes/SHOW/a.mov']), [true, false, false, false]);
  const found = await Store.findByName(dir, ['clip_a.MOV', 'other.mov']);
  assert.deepStrictEqual(found, { 'clip_a.MOV': clip }, 'found by name, whatever the case');
  assert.deepStrictEqual(await Store.findByName(path.join(dir, 'gone'), ['x']), {});
  const accented = path.join(dir, 'café.mov');
  fs.writeFileSync(accented, 'x');
  const decomposed = 'café.mov'; // how a project made on a Mac can hold the name
  const hit = (await Store.findByName(dir, [decomposed]))[decomposed];
  assert.ok(hit, 'a decomposed name finds the precomposed file');
  assert.strictEqual(hit.normalize('NFC'), accented.normalize('NFC'));
  ok('footage: existence check and finding files by name in a folder');

  const store = path.join(tmp, 'refstore');
  await Store.refPut(store, 'abc-1', 'data-a');
  await Store.refPut(store, 'abc-2', 'data-b');
  assert.strictEqual(Store.refGet(store, 'abc-1'), 'data-a');
  assert.strictEqual(Store.refGet(store, 'none'), null);
  Store.refPrune(store, ['abc-2']);
  assert.strictEqual(Store.refGet(store, 'abc-1'), null, 'pruned');
  assert.strictEqual(Store.refGet(store, 'abc-2'), 'data-b');
  await assert.rejects(Store.refPut(store, '../evil', 'x'), /Invalid reference key/);
  assert.strictEqual(fs.existsSync(path.join(tmp, 'evil.txt')), false);
  ok('reference image store: put, get, prune, and no path tricks in a key');
}

module.exports = { run };
