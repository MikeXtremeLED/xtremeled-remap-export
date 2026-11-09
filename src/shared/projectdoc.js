'use strict';
// The project as a document: what counts as a real change, what undo keeps, what a new
// mapping would change, and how reference images are stored once instead of per undo step.
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else global.ProjectDoc = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const REF_VIEWS = ['input', 'output'];

  // ---------------- fingerprint ----------------
  // JSON with sorted keys: two objects with the same content give the same text
  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  // 53-bit string hash (cyrb53), as text; good enough to tell two project states apart
  function hashText(text) {
    const s = String(text);
    let h1 = 0xdeadbeef ^ s.length;
    let h2 = 0x41c6ce57 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${s.length.toString(36)}-${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
  }

  function fingerprint(project) {
    return hashText(stableStringify(project));
  }

  // ---------------- undo ----------------
  // The footage list is not part of a mapping undo step
  function withoutFootage(project) {
    const copy = Object.assign({}, project);
    delete copy.exportList;
    return copy;
  }

  // ---------------- reference images ----------------
  // Replaces each embedded image by its key; remember(key, dataUrl) keeps the image itself
  function internRefs(project, remember) {
    REF_VIEWS.forEach((v) => {
      const ref = project.refs && project.refs[v];
      if (!ref || !ref.dataUrl) return;
      const key = hashText(ref.dataUrl);
      remember(key, ref.dataUrl);
      const kept = Object.assign({}, ref, { key });
      delete kept.dataUrl;
      project.refs[v] = kept;
    });
    return project;
  }

  // The project as written to a file: images embedded again, keys left out
  function embedRefs(project, lookup) {
    const refs = {};
    REF_VIEWS.forEach((v) => {
      const ref = project.refs && project.refs[v];
      const dataUrl = ref && ref.key ? lookup(ref.key) : null;
      if (!ref || !dataUrl) {
        refs[v] = null;
        return;
      }
      const kept = Object.assign({}, ref, { dataUrl });
      delete kept.key;
      refs[v] = kept;
    });
    return Object.assign({}, project, { refs });
  }

  function refKeys(project) {
    return REF_VIEWS.map((v) => project.refs && project.refs[v] && project.refs[v].key).filter(Boolean);
  }

  // ---------------- mapping replacement ----------------
  // A new mapping in an existing project: everything else stays
  function adoptMapping(current, imported) {
    return Object.assign({}, current, {
      input: imported.input,
      screens: imported.screens,
      slices: imported.slices,
    });
  }

  // A CSV has no canvas or output size: they are derived from the tiles and can come out too
  // small. The sizes the project already has win as long as the imported tiles fit in them.
  function keepDerivedSizes(current, imported) {
    const fits = (inner, outer) => inner.width <= outer.width && inner.height <= outer.height;
    const out = Object.assign({}, imported);
    if (fits(imported.input, current.input)) out.input = { width: current.input.width, height: current.input.height };
    if (imported.screens.length === 1 && current.screens.length && fits(imported.screens[0], current.screens[0])) {
      out.screens = [Object.assign({}, imported.screens[0], { width: current.screens[0].width, height: current.screens[0].height })];
    }
    return out;
  }

  const sizeText = (o) => `${o.width}×${o.height}`;

  // Pairs items by name; items sharing a name are paired in order
  function pairByName(oldItems, newItems) {
    const left = new Map();
    newItems.forEach((item) => {
      const name = item.name || '';
      if (!left.has(name)) left.set(name, []);
      left.get(name).push(item);
    });
    const pairs = [], removed = [];
    oldItems.forEach((item) => {
      const name = item.name || '';
      const candidates = left.get(name);
      if (candidates && candidates.length) pairs.push([item, candidates.shift()]);
      else removed.push(item);
    });
    const added = newItems.filter((item) => !pairs.some((p) => p[1] === item));
    return { pairs, added, removed };
  }

  function rectChanges(a, b, label) {
    return ['x', 'y', 'w', 'h']
      .filter((k) => Math.round(a[k]) !== Math.round(b[k]))
      .map((k) => `${label} ${k} ${Math.round(a[k])} → ${Math.round(b[k])}`);
  }

  // What is different about one slice, in short phrases; empty when nothing is
  function sliceChanges(a, b, oldScreenName, newScreenName) {
    const out = [...rectChanges(a.in, b.in, 'input'), ...rectChanges(a.out, b.out, 'output')];
    const norm = (s, k) => s[k] || 0;
    if (norm(a, 'inOrient') !== norm(b, 'inOrient') || norm(a, 'outOrient') !== norm(b, 'outOrient')) out.push('rotation changed');
    if (norm(a, 'flip') !== norm(b, 'flip')) out.push('flip changed');
    if (stableStringify(a.mask || null) !== stableStringify(b.mask || null)) out.push('mask changed');
    if ((a.enabled !== false) !== (b.enabled !== false)) out.push(b.enabled !== false ? 'enabled' : 'disabled');
    const oldName = oldScreenName(a), newName = newScreenName(b);
    if (oldName !== newName) out.push(`moved to ${newName}`);
    return out;
  }

  // What replacing the mapping of `current` by `next` changes. Slices are matched by name.
  function diffMapping(current, next) {
    const screenNames = (p) => (s) => {
      const sc = p.screens.find((x) => x.id === s.screenId) || p.screens[0];
      return sc ? sc.name : '';
    };
    const scr = pairByName(current.screens, next.screens);
    const sl = pairByName(current.slices, next.slices);
    const moved = [];
    let unchanged = 0;
    sl.pairs.forEach(([a, b]) => {
      const changes = sliceChanges(a, b, screenNames(current), screenNames(next));
      if (changes.length) moved.push({ name: b.name || '', changes });
      else unchanged++;
    });
    const canvasChanged = current.input.width !== next.input.width || current.input.height !== next.input.height;
    const screensResized = scr.pairs
      .filter(([a, b]) => a.width !== b.width || a.height !== b.height)
      .map(([a, b]) => ({ name: b.name, from: sizeText(a), to: sizeText(b) }));
    const result = {
      canvas: canvasChanged ? { from: sizeText(current.input), to: sizeText(next.input) } : null,
      canvasSize: sizeText(next.input),
      screensAdded: scr.added.map((s) => `${s.name} (${sizeText(s)})`),
      screensRemoved: scr.removed.map((s) => s.name),
      screensResized,
      slicesAdded: sl.added.map((s) => s.name || ''),
      slicesRemoved: sl.removed.map((s) => s.name || ''),
      slicesMoved: moved,
      slicesUnchanged: unchanged,
    };
    result.identical = !result.canvas && !screensResized.length && !result.screensAdded.length &&
      !result.screensRemoved.length && !moved.length && !result.slicesAdded.length && !result.slicesRemoved.length;
    return result;
  }

  return {
    stableStringify, hashText, fingerprint, withoutFootage,
    internRefs, embedRefs, refKeys,
    adoptMapping, keepDerivedSizes, diffMapping,
  };
});
