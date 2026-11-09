'use strict';
/* XtremeLED Remap Export — slice editor + export page */

const api = window.xre;
const $ = (id) => document.getElementById(id);
const IS_MAC = /Mac/i.test(navigator.platform);
const FILE_MANAGER = IS_MAC ? 'Finder' : 'Explorer';

// ---------------- state ----------------
let project = null;
let page = 'editor'; // 'editor' | 'render'
let view = 'input'; // 'input' | 'output'; in the Both view, the band last clicked
let bothView = false; // input and output together, on one canvas
let selId = null; // selected slice id
let selScreenId = null; // selected screen id (tree selection when no slice selected)
let activeScreenId = null;
let caps = null;
let gpuEncoders = null; // null until the background test has finished
let maskEditId = null; // the slice whose mask points are being edited
const collapsedScreens = new Set(); // screens folded shut in the tree, for this session
let revealedSelId = null; // the selection the tree last scrolled to
// Keep aspect ratio while scaling a slice in the Output view (toolbar lock or Shift).
let outLock = localStorage.getItem('xre:outlock') === '1';
const refImgs = { input: null, output: null };
const refImgKeys = { input: null, output: null }; // which stored image each refImgs entry shows
const vt = {
  input: { scale: 0.1, ox: 50, oy: 50 },
  output: { scale: 0.1, ox: 50, oy: 50 },
};

let canvas, ctx;
let spaceDown = false;
let drag = null;
let uidCounter = 1;
const uid = () => 'sl' + uidCounter++ + '_' + Math.random().toString(36).slice(2, 7);

const RULER = 20; // thickness of the pixel rulers on the work surface
const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif'];
// Footage can also be a format the browser can't show, as a reference image can't
const FOOTAGE_IMAGE_EXTS = [...IMAGE_EXTS, 'exr', 'dpx'];
const VIDEO_EXTS = ['mov', 'mp4', 'm4v', 'avi', 'mkv', 'mxf', 'webm', 'mpg', 'mpeg'];

const HANDLES = [
  { k: 'nw', fx: 0, fy: 0 }, { k: 'n', fx: 0.5, fy: 0 }, { k: 'ne', fx: 1, fy: 0 },
  { k: 'e', fx: 1, fy: 0.5 }, { k: 'se', fx: 1, fy: 1 }, { k: 's', fx: 0.5, fy: 1 },
  { k: 'sw', fx: 0, fy: 1 }, { k: 'w', fx: 0, fy: 0.5 },
];
const LOCK_PATHS = {
  on: 'M4 9h12v9H4z M7 9V6a3 3 0 0 1 6 0v3h-1.8V6a1.2 1.2 0 0 0-2.4 0v3H7z',
  off: 'M4 9h12v9H4z M11 9V6a1.2 1.2 0 0 1 2.4 0v1.6H15V6a3 3 0 0 0-6 0v3h2z',
};
const HANDLE_CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

// ---------------- helpers ----------------
function activeScreen() {
  return project.screens.find((s) => s.id === activeScreenId) || project.screens[0];
}
function sliceScreenId(s) {
  return s.screenId || project.screens[0].id;
}
function worldSize(v) {
  if (v === 'input') return { w: project.input.width, h: project.input.height };
  const sc = activeScreen();
  return { w: sc.width, h: sc.height };
}
function sliceRect(s, v) {
  return v === 'input' ? s.in : s.out;
}
function selected() {
  return project.slices.find((s) => s.id === selId) || null;
}
function selectedScreen() {
  if (selId) return null; // a slice selection wins
  return project.screens.find((s) => s.id === selScreenId) || null;
}

// Tree selection (Resolume-style): screen or slice
function selectScreen(id) {
  const changed = activeScreenId !== id;
  selScreenId = id;
  selId = null;
  activeScreenId = id;
  refreshSliceList();
  refreshProps();
  refreshScreenSelectors();
  if (outputShown() && changed) fitView('output');
  draw();
}
function selectSlice(id) {
  selId = id;
  const s = selected();
  if (s) {
    const scrId = sliceScreenId(s);
    const changed = activeScreenId !== scrId;
    selScreenId = scrId;
    activeScreenId = scrId;
    if (outputShown() && changed) fitView('output');
  }
  refreshSliceList();
  refreshProps();
  refreshScreenSelectors();
  draw();
}
function visibleSlices(v) {
  if (v === 'input') return project.slices;
  return project.slices.filter((s) => sliceScreenId(s) === activeScreen().id);
}
function extOf(p) {
  const m = String(p).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
function isImagePath(p) {
  return FOOTAGE_IMAGE_EXTS.includes(extOf(p));
}
// Safe arithmetic evaluator so number fields can be used as a calculator
// (supports + - * / and parentheses, e.g. "1920/2", "100*1.5", "(3840-64)/3").
function evalCalc(str) {
  const s = String(str).replace(/\s+/g, '');
  if (s === '') return NaN;
  if (!/^[-+*/().\d]+$/.test(s)) return NaN; // reject anything but math
  let i = 0;
  const peek = () => s[i];
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const t = term();
      v = op === '+' ? v + t : v - t;
    }
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const f = factor();
      v = op === '*' ? v * f : v / f;
    }
    return v;
  }
  function factor() {
    if (peek() === '(') { i++; const v = expr(); if (peek() === ')') i++; else throw 0; return v; }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '-') { i++; return -factor(); }
    let num = '';
    while (i < s.length && /[\d.]/.test(s[i])) num += s[i++];
    if (num === '') throw 0;
    return parseFloat(num);
  }
  try {
    const r = expr();
    return i === s.length && isFinite(r) ? r : NaN;
  } catch (e) {
    return NaN;
  }
}
// parse a field value: plain number or a math expression
function calcNum(v) {
  if (typeof v === 'number') return v;
  const str = String(v).trim();
  if (/^-?\d*\.?\d+$/.test(str)) return parseFloat(str);
  const r = evalCalc(str);
  return isFinite(r) ? r : NaN;
}
function clampInt(v, min, max) {
  let n = calcNum(v);
  if (!isFinite(n)) n = 0;
  v = Math.round(n);
  return Math.max(min, Math.min(max, v));
}
function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}
function sanitizeName(s) {
  return String(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}
function maskUsable(s) {
  return s.mask && s.mask.enabled && s.mask.points && s.mask.points.length >= 3;
}
function fmtTC(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// generic drag-to-reorder for list rows
function enableReorder(rowEl, index, onMove) {
  rowEl.draggable = true;
  rowEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(index));
    e.dataTransfer.effectAllowed = 'move';
  });
  rowEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const r = rowEl.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    rowEl.classList.toggle('drag-over-top', before);
    rowEl.classList.toggle('drag-over-bottom', !before);
  });
  rowEl.addEventListener('dragleave', () => rowEl.classList.remove('drag-over-top', 'drag-over-bottom'));
  rowEl.addEventListener('drop', (e) => {
    e.preventDefault();
    rowEl.classList.remove('drag-over-top', 'drag-over-bottom');
    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (Number.isNaN(from)) return;
    const r = rowEl.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    onMove(from, index + (before ? 0 : 1));
  });
}
function moveItem(arr, from, to) {
  if (from < to) to--;
  if (from === to || from < 0 || from >= arr.length) return false;
  const [it] = arr.splice(from, 1);
  arr.splice(to, 0, it);
  return true;
}

// ---------------- undo / redo ----------------
const history = { undo: [], redo: [] };
let lastNudge = 0;

// One undo step. A mapping edit leaves the footage list alone; a step taken before a project
// switch (import, open, new) also brings back the old footage and the file it belonged to.
function snapshot(withFootage) {
  return {
    mapping: JSON.stringify(ProjectDoc.withoutFootage(project)),
    footage: withFootage ? JSON.stringify(project.exportList) : null,
    file: withFootage ? { path: docFile.path, savedHash: docFile.savedHash } : null,
  };
}
function pushHistory(withFootage) {
  history.undo.push(snapshot(!!withFootage));
  if (history.undo.length > 100) history.undo.shift();
  history.redo.length = 0;
  updateUndoButtons();
}
function pushHistoryThrottled(ms) {
  const now = Date.now();
  if (now - lastNudge > (ms || 800)) pushHistory();
  lastNudge = now;
}
async function restoreSnapshot(entry) {
  const parsed = JSON.parse(entry.mapping);
  parsed.exportList = entry.footage !== null ? JSON.parse(entry.footage) : project.exportList;
  project = migrateProject(parsed);
  if (selId && !project.slices.some((s) => s.id === selId)) selId = null;
  if (selScreenId && !project.screens.some((s) => s.id === selScreenId)) selScreenId = null;
  if (!project.screens.some((s) => s.id === activeScreenId)) activeScreenId = project.screens[0].id;
  await loadAllRefs();
  if (entry.footage !== null) {
    loadExportListFromProject();
    syncExportList();
    Object.assign(docFile, entry.file);
    persistDocFile();
  }
  refreshAll();
  refreshDocBar();
  markDirty();
}
async function undo() {
  if (!history.undo.length) return;
  const entry = history.undo.pop();
  history.redo.push(snapshot(entry.footage !== null));
  await restoreSnapshot(entry);
  updateUndoButtons();
}
async function redo() {
  if (!history.redo.length) return;
  const entry = history.redo.pop();
  history.undo.push(snapshot(entry.footage !== null));
  await restoreSnapshot(entry);
  updateUndoButtons();
}
function updateUndoButtons() {
  $('btn-undo').disabled = !history.undo.length;
  $('btn-redo').disabled = !history.redo.length;
}

// ---------------- project model ----------------
function newSliceDefaults(s) {
  return Object.assign(
    { enabled: true, inOrient: 0, outOrient: 0, flip: 0, mask: null, screenId: null },
    s
  );
}

function newProject() {
  const scrId = 'scr' + Math.random().toString(36).slice(2, 7);
  return {
    name: 'Untitled',
    input: { width: 3840, height: 2160 },
    screens: [{ id: scrId, name: 'Output #1', width: 3840, height: 2160 }],
    refs: { input: null, output: null },
    exportList: [],
    slices: [
      newSliceDefaults({
        id: uid(), name: 'Slice 1', screenId: scrId,
        in: { x: 960, y: 540, w: 1920, h: 1080 },
        out: { x: 960, y: 540, w: 1920, h: 1080 },
      }),
    ],
  };
}

function checkerDataUrl(w, h, cell) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  for (let y = 0, j = 0; y < h; y += cell, j++) {
    for (let x = 0, i = 0; x < w; x += cell, i++) {
      g.fillStyle = (i + j) % 2 ? '#6f1c94' : '#9c27b0';
      g.fillRect(x, y, cell, cell);
    }
  }
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(w, h);
  g.moveTo(w, 0); g.lineTo(0, h);
  g.stroke();
  g.beginPath();
  g.arc(w / 2, h / 2, Math.min(w, h) / 2 - 4, 0, Math.PI * 2);
  g.stroke();
  return c.toDataURL('image/png');
}

function demoProject() {
  const scrId = 'scrdemo';
  return {
    name: "50x2m (100m2) P4.81 demo",
    input: { width: 10400, height: 416 },
    screens: [{ id: scrId, name: 'Output #1', width: 3840, height: 2160 }],
    refs: {
      input: { dataUrl: checkerDataUrl(2600, 104, 26), name: 'demo test card', opacity: 0.9 },
      output: null,
    },
    exportList: [],
    slices: [
      newSliceDefaults({ id: uid(), name: '50x2m part 1/3', screenId: scrId, in: { x: 0, y: 0, w: 3744, h: 416 }, out: { x: 0, y: 0, w: 3744, h: 416 } }),
      newSliceDefaults({ id: uid(), name: '50x2m part 2/3', screenId: scrId, in: { x: 3744, y: 0, w: 3744, h: 416 }, out: { x: 0, y: 416, w: 3744, h: 416 } }),
      newSliceDefaults({ id: uid(), name: '50x2m part 3/3', screenId: scrId, in: { x: 7488, y: 0, w: 2912, h: 416 }, out: { x: 0, y: 832, w: 2912, h: 416 } }),
    ],
  };
}

function migrateProject(p) {
  if (!p || !p.input || !Array.isArray(p.slices)) throw new Error('Invalid project file');
  if (!p.screens || !p.screens.length) {
    const out = p.output || { width: 1920, height: 1080 };
    p.screens = [{ id: 'scr' + Math.random().toString(36).slice(2, 7), name: 'Output #1', width: out.width, height: out.height }];
  }
  delete p.output;
  p.refs = p.refs || { input: null, output: null };
  p.exportList = p.exportList || [];
  p.slices = p.slices.map((s) => newSliceDefaults(s));
  p.slices.forEach((s) => {
    if (!s.id) s.id = uid();
    if (!s.screenId || !p.screens.some((sc) => sc.id === s.screenId)) s.screenId = p.screens[0].id;
    if (s.mask && !s.mask.points && s.mask.w > 0 && s.mask.h > 0) {
      s.mask = { enabled: s.mask.enabled !== false, points: Geometry.rectToPoints(s.mask) };
    }
    if (s.mask && (!s.mask.points || s.mask.points.length < 3)) s.mask = null;
  });
  ProjectDoc.internRefs(p, rememberRef);
  return p;
}

// ---------------- persistence ----------------
let saveTimer = null;
let docBarTimer = null;
function markDirty() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem('xre:project', JSON.stringify(project));
    } catch (e) { /* storage full: the last autosave stays */ }
  }, 400);
  if (!docBarTimer) {
    docBarTimer = setTimeout(() => {
      docBarTimer = null;
      refreshDocBar();
    }, 120);
  }
}

// The file this project belongs to, and the state it was last saved in. Unsaved means the
// content differs from that state, so undoing back to it counts as saved again.
const DEMO_MODE = new URLSearchParams(location.search).get('demo') === '1';
const docFile = { path: null, savedHash: null };
function persistDocFile() {
  if (DEMO_MODE) return;
  try {
    localStorage.setItem('xre:doc', JSON.stringify(docFile));
  } catch (e) { /* the next save tries again */ }
}
function loadDocFile() {
  try {
    const stored = JSON.parse(localStorage.getItem('xre:doc'));
    if (stored && typeof stored.savedHash === 'string') {
      docFile.path = stored.path || null;
      docFile.savedHash = stored.savedHash;
      return true;
    }
  } catch (e) { /* no usable record */ }
  return false;
}
function setDocFile(path) {
  docFile.path = path;
  docFile.savedHash = ProjectDoc.fingerprint(project);
  persistDocFile();
  refreshDocBar();
}
function docDirty() {
  return ProjectDoc.fingerprint(project) !== docFile.savedHash;
}
function docLabel() {
  return docFile.path ? baseName(docFile.path) : project.name || 'Untitled';
}
function refreshDocBar() {
  if (!project || docFile.savedHash === null) return;
  const dirty = docDirty();
  const name = $('proj-name');
  name.textContent = docLabel();
  name.title = docFile.path || 'Not saved to a file yet';
  $('proj-dot').classList.toggle('hidden', !dirty);
  document.title = `${docLabel()}${dirty ? ' •' : ''} - XtremeLED Remap Export${appFacts ? ` ${appFacts.version}` : ''}`;
}
function loadLocal() {
  try {
    const raw = localStorage.getItem('xre:project');
    if (!raw) return null;
    return migrateProject(JSON.parse(raw));
  } catch (e) {
    return null;
  }
}

// ---------------- ref images ----------------
// Each image is held once, under a key: undo steps and the autosave carry only the key.
const refStore = new Map();
function rememberRef(key, dataUrl) {
  if (refStore.has(key)) return;
  refStore.set(key, dataUrl);
  api.refPut(key, dataUrl).catch(() => { /* the session still has it in memory */ });
}
function makeRef(dataUrl, name, opacity) {
  const holder = { refs: { input: { dataUrl, name, opacity } } };
  ProjectDoc.internRefs(holder, rememberRef);
  return holder.refs.input;
}
function loadRefImage(v) {
  return new Promise((resolve) => {
    const ref = project.refs[v];
    const key = ref && ref.key;
    if (key && refImgs[v] && refImgKeys[v] === key) return resolve(); // already decoded
    const dataUrl = key ? refStore.get(key) : null;
    if (!dataUrl) {
      refImgs[v] = null;
      refImgKeys[v] = null;
      return resolve();
    }
    const img = new Image();
    img.onload = () => { refImgs[v] = img; refImgKeys[v] = key; resolve(); };
    img.onerror = () => { refImgs[v] = null; refImgKeys[v] = null; resolve(); };
    img.src = dataUrl;
  });
}
async function loadAllRefs() {
  await Promise.all([loadRefImage('input'), loadRefImage('output')]);
}
// After a restart the images come back from the store on disk
async function restoreStoredRefs() {
  for (const v of ['input', 'output']) {
    const ref = project.refs[v];
    if (!ref || !ref.key || refStore.has(ref.key)) continue;
    const dataUrl = await api.refGet(ref.key).catch(() => null);
    if (dataUrl) refStore.set(ref.key, dataUrl);
    else project.refs[v] = null;
  }
}

// ---------------- canvas & drawing (editor) ----------------
let lastCanvasSize = { w: 0, h: 0 };
function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const statusH = ($('statusbar') ? $('statusbar').offsetHeight : 24) + $('map-checkbar').offsetHeight + $('update-notice').offsetHeight;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(50, rect.width);
  const ch = Math.max(50, rect.height - statusH);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // the bands follow the canvas, so their views have to as well
  if (bothView && (cw !== lastCanvasSize.w || ch !== lastCanvasSize.h)) shownViews().forEach(fitView);
  lastCanvasSize = { w: cw, h: ch };
  draw();
}

function cssSize(c) {
  c = c || canvas;
  return { w: parseFloat(c.style.width) || c.width, h: parseFloat(c.style.height) || c.height };
}

function outputShown() {
  return bothView || view === 'output';
}

// The Both view stacks two bands on the one canvas: the input on top, as high as a wide wall
// needs, the output in the rest. Every view transform is in canvas coordinates.
const BOTH_MARGIN = 18;
function bothSplitY() {
  const { w: cw, h: ch } = cssSize();
  const { w: W, h: H } = worldSize('input');
  const wanted = Math.round((cw - BOTH_MARGIN * 2) * (H / W)) + BOTH_MARGIN * 2;
  return Math.round(Math.max(Math.min(ch * 0.35, 110), Math.min(ch * 0.55, wanted)));
}

function bandRect(v) {
  const { w: cw, h: ch } = cssSize();
  if (!bothView) return { x: 0, y: 0, w: cw, h: ch };
  const split = bothSplitY();
  return v === 'input' ? { x: 0, y: 0, w: cw, h: split } : { x: 0, y: split, w: cw, h: ch - split };
}

function bandAt(py) {
  return py < bothSplitY() ? 'input' : 'output';
}

// The band that was clicked becomes the one the arrows, list and zoom readout work on
function setBand(v) {
  if (!bothView || v === view) return;
  view = v;
  refreshRefPanel();
  refreshSliceList();
  updateZoomLabel();
}

function shownViews() {
  return bothView ? ['input', 'output'] : [view];
}

function fitView(v) {
  const t = vt[v];
  const { w: W, h: H } = worldSize(v);
  const b = bandRect(v);
  const margin = bothView ? BOTH_MARGIN : 50;
  const scale = Math.min((b.w - margin * 2) / W, (b.h - margin * 2) / H);
  t.scale = Math.max(0.001, Math.min(8, scale));
  t.ox = b.x + (b.w - W * t.scale) / 2;
  t.oy = b.y + (b.h - H * t.scale) / 2;
  updateZoomLabel();
}

function frameRect(v, r) {
  const t = vt[v];
  const b = bandRect(v);
  const margin = RULER + 12; // the slice stays clear of the rulers
  t.scale = Math.max(0.002, Math.min(8, Math.min((b.w - margin * 2) / r.w, (b.h - margin * 2) / r.h)));
  t.ox = b.x + (b.w - r.w * t.scale) / 2 - r.x * t.scale;
  t.oy = b.y + (b.h - r.h * t.scale) / 2 - r.y * t.scale;
}

// Fills the view with the selected slice; with nothing selected, the whole canvas
function frameSelection() {
  const s = selected();
  for (const v of shownViews()) {
    if (s) frameRect(v, sliceRect(s, v));
    else fitView(v);
  }
  updateZoomLabel();
  draw();
}

function zoomButtons(factor) {
  const active = view;
  for (const v of shownViews()) {
    const b = bandRect(v);
    view = v;
    zoomAt(b.x + b.w / 2, b.y + b.h / 2, factor);
  }
  view = active;
  updateZoomLabel();
}

function updateZoomLabel() {
  $('zoom-label').textContent = Math.round(vt[view].scale * 100) + '%';
}

function toScreenX(x) { return x * vt[view].scale + vt[view].ox; }
function toScreenY(y) { return y * vt[view].scale + vt[view].oy; }
function toWorld(px, py) {
  const t = vt[view];
  return { x: (px - t.ox) / t.scale, y: (py - t.oy) / t.scale };
}

function drawCheckerBg(g, cx, cy, cwid, chei) {
  g.fillStyle = '#0d0f10';
  g.fillRect(cx, cy, cwid, chei);
  const cell = 14;
  g.fillStyle = '#101214';
  for (let y = 0; y * cell < chei; y++) {
    for (let x = (y % 2); x * cell < cwid; x += 2) {
      g.fillRect(cx + x * cell, cy + y * cell, cell, cell);
    }
  }
}

function drawSliceContent(g, img, eff, t, kx, ky) {
  const { crop, place, rot, flip } = eff;
  const s = eff.slice;
  g.save();
  if (eff.polyMask && maskUsable(s)) {
    const poly = Geometry.maskPolyInPlace(s, eff);
    if (poly) {
      g.beginPath();
      poly.forEach((p, i) => {
        const x = (place.x + p.x) * t.scale + t.ox;
        const y = (place.y + p.y) * t.scale + t.oy;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.closePath();
      g.clip();
    }
  }
  const sx = crop.x * kx, sy = crop.y * ky, sw = crop.w * kx, sh = crop.h * ky;
  const pcx = (place.x + place.w / 2) * t.scale + t.ox;
  const pcy = (place.y + place.h / 2) * t.scale + t.oy;
  const swap = rot === 90 || rot === 270;
  const dw = (swap ? place.h : place.w) * t.scale;
  const dh = (swap ? place.w : place.h) * t.scale;
  g.translate(pcx, pcy);
  g.scale(flip & 1 ? -1 : 1, flip & 2 ? -1 : 1);
  g.rotate((rot * Math.PI) / 180);
  try {
    g.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  } catch (e) { /* out of range */ }
  g.restore();
}

function maskScreenPoints(s) {
  return s.mask.points.map((p) => ({ x: toScreenX(p.x), y: toScreenY(p.y) }));
}

function draw() {
  if (!project || !ctx || page !== 'editor') return;
  currentMapCheck();
  const { w: cw, h: ch } = cssSize();
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = '#121416';
  ctx.fillRect(0, 0, cw, ch);
  if (!bothView) {
    drawView();
    drawFrameTag();
    drawRulers(bandRect(view));
    return;
  }
  const active = view;
  for (const v of ['input', 'output']) {
    const b = bandRect(v);
    view = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    drawView();
    drawRulers(b);
    ctx.font = 'bold 10px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = v === active ? '#f7941e' : '#8b9195';
    ctx.fillText(v === 'input' ? 'INPUT' : `OUTPUT · ${activeScreen().name}`, b.x + b.w - 8, b.y + RULER + 5);
    ctx.restore();
  }
  view = active;
  ctx.fillStyle = '#2f3438';
  ctx.fillRect(0, bandRect('output').y, cw, 1);
}

// The output's name and size inside its own frame, when the frame is big enough to hold it
function drawFrameTag() {
  if (view !== 'output') return;
  const t = vt.output;
  const { w: W, h: H } = worldSize('output');
  const scr = activeScreen();
  if (W * t.scale < 190 || H * t.scale < 44) return;
  const text = `${scr.name} · ${scr.width}×${scr.height}`;
  ctx.font = '600 11px -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const x = toScreenX(W) - tw - 26, y = toScreenY(H) - 30;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, tw + 14, 20);
  ctx.fillStyle = '#cfd3d6';
  ctx.fillText(text, x + 7, y + 10);
}

function rulerStep(minWorld) {
  const base = Math.pow(10, Math.floor(Math.log10(minWorld)));
  for (const m of [1, 2, 5]) if (m * base >= minWorld) return m * base;
  return 10 * base;
}

// Pixel rulers along the top and left of a view; the selected slice is marked on both
function drawRulers(b) {
  const t = vt[view];
  const s = selected();
  const sel = s && visibleSlices(view).includes(s) ? sliceRect(s, view) : null;
  const step = Math.max(1, rulerStep(80 / t.scale));
  const minor = step / 5;
  const font = '9px -apple-system, "Segoe UI", sans-serif';
  const paint = (horiz) => {
    const origin = horiz ? t.ox : t.oy;
    const start = horiz ? b.x : b.y;
    const end = start + (horiz ? b.w : b.h);
    ctx.fillStyle = '#1a1d1f';
    if (horiz) ctx.fillRect(b.x, b.y, b.w, RULER);
    else ctx.fillRect(b.x, b.y, RULER, b.h);
    if (sel) {
      ctx.fillStyle = 'rgba(247,148,30,0.32)';
      const a = origin + (horiz ? sel.x : sel.y) * t.scale;
      const len = (horiz ? sel.w : sel.h) * t.scale;
      if (horiz) ctx.fillRect(a, b.y, len, RULER);
      else ctx.fillRect(b.x, a, RULER, len);
    }
    ctx.font = font;
    ctx.lineWidth = 1;
    const first = Math.floor((start - origin) / t.scale / step) * step;
    for (let i = 0; ; i++) {
      const p = first + i * minor;
      const pos = Math.round(p * t.scale + origin) + 0.5;
      if (pos > end) break;
      const major = i % 5 === 0;
      const reach = major ? 8 : 15;
      ctx.strokeStyle = '#5a6267';
      ctx.beginPath();
      if (horiz) { ctx.moveTo(pos, b.y + reach); ctx.lineTo(pos, b.y + RULER); }
      else { ctx.moveTo(b.x + reach, pos); ctx.lineTo(b.x + RULER, pos); }
      ctx.stroke();
      if (!major) continue;
      ctx.fillStyle = '#9aa2a7';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      if (horiz) ctx.fillText(String(Math.round(p)), pos + 3, b.y + 9);
      else {
        ctx.save();
        ctx.translate(b.x + 9, pos - 3);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(String(Math.round(p)), 0, 0);
        ctx.restore();
      }
    }
  };
  paint(true);
  paint(false);
  ctx.fillStyle = '#1a1d1f';
  ctx.fillRect(b.x, b.y, RULER, RULER);
  ctx.fillStyle = '#7f878c';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('px', b.x + RULER / 2, b.y + RULER / 2);
}

// One view of the mapping, in the current `view`
function drawView() {
  const t = vt[view];
  const { w: W, h: H } = worldSize(view);

  const cx = toScreenX(0), cy = toScreenY(0);
  const cwid = W * t.scale, chei = H * t.scale;

  ctx.save();
  ctx.beginPath();
  ctx.rect(cx, cy, cwid, chei);
  ctx.clip();
  drawCheckerBg(ctx, cx, cy, cwid, chei);

  const ref = project.refs[view];
  if (ref && refImgs[view]) {
    ctx.globalAlpha = ref.opacity != null ? ref.opacity : 0.6;
    ctx.drawImage(refImgs[view], cx, cy, cwid, chei);
    ctx.globalAlpha = 1;
  }

  if (view === 'output' && refImgs.input) {
    const img = refImgs.input;
    const kx = img.naturalWidth / project.input.width;
    const ky = img.naturalHeight / project.input.height;
    for (const eff of Geometry.effectiveSlices(project, activeScreen().id)) {
      drawSliceContent(ctx, img, eff, t, kx, ky);
    }
  }
  ctx.restore();

  ctx.strokeStyle = '#4c5358';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - 0.5, cy - 0.5, cwid + 1, chei + 1);

  const labels = []; // drawn last, so the red problem marks don't cover them
  for (const s of visibleSlices(view)) {
    const r = sliceRect(s, view);
    const x = toScreenX(r.x), y = toScreenY(r.y);
    const w = r.w * t.scale, h = r.h * t.scale;
    const isSel = s.id === selId;
    const off = s.enabled === false;

    ctx.fillStyle = off
      ? 'rgba(140,140,140,0.08)'
      : isSel
        ? 'rgba(247,148,30,0.15)'
        : 'rgba(247,148,30,0.06)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = off ? '#5a6165' : isSel ? '#f7941e' : '#b06a17';
    ctx.lineWidth = isSel ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));

    if (view === 'input' && maskUsable(s)) {
      const pts = maskScreenPoints(s);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      pts.slice().reverse().forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill('evenodd');
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = isSel ? '#ffd28a' : 'rgba(255,210,138,0.6)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (isSel && maskEditActive()) {
        pts.forEach((p) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffd28a';
          ctx.fill();
          ctx.strokeStyle = '#241503';
          ctx.stroke();
        });
      }
      ctx.restore();
    }

    if (w > 40 && h > 14) labels.push(() => {
      const label = s.name;
      const extras = [];
      if (Geometry.netRotation(s)) extras.push(Geometry.netRotation(s) + '°');
      if (s.flip) extras.push('flip');
      if (maskUsable(s) && view === 'input') extras.push('mask');
      if (view === 'input' && project.screens.length > 1) {
        const idx = project.screens.findIndex((sc) => sc.id === sliceScreenId(s));
        extras.push('S' + (idx + 1));
      }
      const sub = `${r.w}×${r.h}` + (extras.length ? ' · ' + extras.join(' ') : '');
      ctx.font = 'bold 11px -apple-system, "Segoe UI", sans-serif';
      const tw = Math.max(ctx.measureText(label).width, ctx.measureText(sub).width - 14);
      const px = x + w / 2, py = y + h / 2;
      ctx.fillStyle = 'rgba(10,12,13,0.78)';
      const bw = tw + 16, bh = 28;
      ctx.fillRect(px - bw / 2, py - bh / 2, bw, bh);
      ctx.fillStyle = off ? '#8b9195' : '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px, py - 6);
      ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = off ? '#6d7276' : '#f7941e';
      ctx.fillText(sub, px, py + 7);
      drawScalePill(s, px + bw / 2, py, x, y, w, h, bh, off);
    });
  }

  drawMapProblems();
  labels.forEach((drawLabel) => drawLabel());

  const sel = selected();
  if (sel && !maskEditActive()) {
    const r = sliceRect(sel, view);
    const x = toScreenX(r.x), y = toScreenY(r.y);
    const w = r.w * t.scale, h = r.h * t.scale;
    for (const hd of HANDLES) {
      const hx = x + w * hd.fx, hy = y + h * hd.fy;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#241503';
      ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
      ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
    }
  }

  ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = '#8b9195';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('0,0', cx + 3, cy - 3);
}

function maskEditActive() {
  const s = selected();
  return !!maskEditId && maskEditId === selId && view === 'input' && !!s && maskUsable(s);
}

// ---------------- mapping check ----------------
let mapCheck = null;
let mapCheckSig = '';
const mapChipPos = { overlap: -1, outside: -1 };

function currentMapCheck() {
  const sig = JSON.stringify([
    project.input,
    project.screens,
    project.slices.map((s) => [s.id, s.name, s.screenId, s.enabled, s.in, s.out, s.inOrient, s.outOrient, s.flip, s.mask]),
  ]);
  if (sig !== mapCheckSig || !mapCheck) {
    mapCheckSig = sig;
    mapCheck = MapCheck.analyze(project);
    renderCheckBar();
    refreshSliceList(); // the scale labels follow the mapping
  }
  return mapCheck;
}

function goToProblem(p) {
  if (!bothView && view !== p.view) switchView(p.view);
  selectSlice(p.sliceId);
}

function renderCheckBar() {
  const bar = $('map-checkbar');
  const c = mapCheck;
  const used = document.createElement('span');
  used.className = 'chk-chip';
  used.textContent = `Output used ${c.usedPct}%`;
  used.title = 'Share of the output area filled with slices';
  if (c.screens.length > 1) used.title += `\n${c.screens.map((s) => `${s.name}: ${s.usedPct}%`).join('\n')}`;
  const chip = (kind, list, text) => {
    if (!list.length) {
      const ok = document.createElement('span');
      ok.className = 'chk-chip ok';
      ok.textContent = text;
      return ok;
    }
    const b = document.createElement('button');
    b.className = 'chk-chip bad';
    b.textContent = text;
    b.title = `${list.map((p) => p.message).join('\n')}\n\nClick to select ${list.length > 1 ? 'the next one' : 'the slice'}`;
    b.onclick = () => {
      mapChipPos[kind] = (mapChipPos[kind] + 1) % list.length;
      goToProblem(list[mapChipPos[kind]]);
    };
    return b;
  };
  bar.replaceChildren(
    used,
    chip('overlap', c.overlaps, `${c.overlaps.length} overlap`),
    chip('outside', c.outside, `${c.outside.length} out of frame`)
  );
}

function drawHatch(rx, ry, rw, rh) {
  const { w: cw, h: ch } = cssSize();
  const x0 = Math.max(rx, 0), y0 = Math.max(ry, 0);
  const x1 = Math.min(rx + rw, cw), y1 = Math.min(ry + rh, ch);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.fillStyle = 'rgba(224,85,85,0.22)';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = 'rgba(224,85,85,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const span = y1 - y0;
  for (let d = x0 - span; d < x1 + span; d += 10) {
    ctx.moveTo(d, y1);
    ctx.lineTo(d + span, y0);
  }
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = '#e05555';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(rx + 0.75, ry + 0.75, Math.max(0.5, rw - 1.5), Math.max(0.5, rh - 1.5));
}

function drawMapProblems() {
  const t = vt[view];
  const hatch = (r) => drawHatch(toScreenX(r.x), toScreenY(r.y), r.w * t.scale, r.h * t.scale);
  const here = (p) => view === 'input' || p.screenId === activeScreen().id;
  for (const p of mapCheck.outside) {
    if (!here(p)) continue;
    if (view === p.view) p.rects.forEach(hatch);
    else if (view === 'output' && p.outRects) p.outRects.forEach(hatch);
  }
  if (view !== 'output') return;
  for (const p of mapCheck.overlaps) {
    if (!here(p)) continue;
    for (const r of p.rects) {
      const x = toScreenX(r.x), y = toScreenY(r.y), w = r.w * t.scale, h = r.h * t.scale;
      ctx.fillStyle = 'rgba(224,85,85,0.5)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#e05555';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
    }
  }
}

// The scale pill next to a slice's canvas label; only where there is room for it
function drawScalePill(s, labelRight, cy, x, y, w, h, labelH, off) {
  const info = MapCheck.scaleInfo(s);
  const rgb = info.exact ? '76,175,80' : '247,148,30';
  ctx.font = 'bold 10px -apple-system, "Segoe UI", sans-serif';
  const pw = Math.ceil(ctx.measureText(info.label).width) + 14, ph = 18;
  let px = Math.round(labelRight + 5), py = Math.round(cy - ph / 2);
  if (px + pw > x + w) {
    if (h < labelH + (ph + 4) * 2 || pw > w) return;
    px = Math.round(x + (w - pw) / 2);
    py = Math.round(cy + labelH / 2 + 3);
  }
  ctx.save();
  if (off) ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.roundRect(px + 0.5, py + 0.5, pw - 1, ph - 1, 8.5);
  ctx.fillStyle = 'rgba(10,12,13,0.88)';
  ctx.fill();
  ctx.fillStyle = `rgba(${rgb},0.18)`;
  ctx.fill();
  ctx.strokeStyle = `rgba(${rgb},0.7)`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = info.exact ? '#7fd283' : '#ffa940';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(info.label, px + pw / 2, py + ph / 2 + 0.5);
  ctx.restore();
}

// "This mapping has 2 problems: continue anyway?" at Start: 'go', 'fix' or null (stay here)
function askMappingProblems(check) {
  return new Promise((resolve) => {
    const n = check.problems;
    openModal(`
      <div class="modal" style="width:480px">
        <div class="modal-head"><span id="m-title"></span><button class="close-x" id="m-close">✕</button></div>
        <div class="modal-body"><div class="exists-list" id="m-list"></div></div>
        <div class="modal-foot">
          <button id="m-go">Export anyway</button>
          <button id="m-fix" class="accent">Fix mapping</button>
        </div>
      </div>
    `);
    $('m-title').textContent = `This mapping has ${n} problem${n === 1 ? '' : 's'}: continue anyway?`;
    [...check.outside, ...check.overlaps].forEach((p) => {
      const row = document.createElement('div');
      row.textContent = p.message;
      row.title = p.message;
      $('m-list').appendChild(row);
    });
    const done = (val) => {
      closeModal();
      resolve(val);
    };
    $('m-close').onclick = () => done(null);
    $('m-go').onclick = () => done('go');
    $('m-fix').onclick = () => done('fix');
    $('m-fix').focus();
  });
}

// ---------------- hit testing ----------------
function handleAt(px, py) {
  const sel = selected();
  if (!sel || maskEditActive()) return null;
  const t = vt[view];
  const r = sliceRect(sel, view);
  const x = toScreenX(r.x), y = toScreenY(r.y);
  const w = r.w * t.scale, h = r.h * t.scale;
  for (const hd of HANDLES) {
    const hx = x + w * hd.fx, hy = y + h * hd.fy;
    if (Math.abs(px - hx) <= 6 && Math.abs(py - hy) <= 6) return hd.k;
  }
  return null;
}

function maskPointAt(px, py) {
  const sel = selected();
  if (!maskEditActive()) return -1;
  const pts = maskScreenPoints(sel);
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(px - pts[i].x, py - pts[i].y) <= 8) return i;
  }
  return -1;
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (
      pts[i].y > y !== pts[j].y > y &&
      x < ((pts[j].x - pts[i].x) * (y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function sliceAt(px, py) {
  const wpt = toWorld(px, py);
  const list = visibleSlices(view);
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const r = sliceRect(s, view);
    if (wpt.x >= r.x && wpt.x <= r.x + r.w && wpt.y >= r.y && wpt.y <= r.y + r.h) return s;
  }
  return null;
}

function hideCtxMenu() {
  const m = $('ctx-menu');
  if (m) m.classList.add('hidden');
}

// ---------------- snapping ----------------
function snapDelta(r, v) {
  const t = vt[v];
  const thr = 6 / t.scale;
  const { w: W, h: H } = worldSize(v);
  const xEdges = [0, W];
  const yEdges = [0, H];
  for (const o of visibleSlices(v)) {
    if (o.id === selId) continue;
    const or = sliceRect(o, v);
    xEdges.push(or.x, or.x + or.w);
    yEdges.push(or.y, or.y + or.h);
  }
  let dx = null, dy = null;
  for (const e of xEdges) {
    for (const cand of [e - r.x, e - (r.x + r.w)]) {
      if (Math.abs(cand) <= thr && (dx === null || Math.abs(cand) < Math.abs(dx))) dx = cand;
    }
  }
  for (const e of yEdges) {
    for (const cand of [e - r.y, e - (r.y + r.h)]) {
      if (Math.abs(cand) <= thr && (dy === null || Math.abs(cand) < Math.abs(dy))) dy = cand;
    }
  }
  return { dx: dx || 0, dy: dy || 0 };
}

// Snap the edges being dragged during a resize to canvas borders and other slices' edges
function snapResize(r, k, v) {
  const t = vt[v];
  const thr = 6 / t.scale;
  const { w: W, h: H } = worldSize(v);
  const xE = [0, W];
  const yE = [0, H];
  for (const o of visibleSlices(v)) {
    if (o.id === selId) continue;
    const or = sliceRect(o, v);
    xE.push(or.x, or.x + or.w);
    yE.push(or.y, or.y + or.h);
  }
  const snapVal = (val, edges) => {
    let best = null;
    for (const e of edges) {
      const d = e - val;
      if (Math.abs(d) <= thr && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    return best;
  };
  if (k.includes('w')) { const d = snapVal(r.x, xE); if (d !== null) { r.x += d; r.w -= d; } }
  if (k.includes('e')) { const d = snapVal(r.x + r.w, xE); if (d !== null) r.w += d; }
  if (k.includes('n')) { const d = snapVal(r.y, yE); if (d !== null) { r.y += d; r.h -= d; } }
  if (k.includes('s')) { const d = snapVal(r.y + r.h, yE); if (d !== null) r.h += d; }
  r.w = Math.max(1, r.w);
  r.h = Math.max(1, r.h);
  return r;
}

// ---------------- mouse (editor) ----------------
// Resize maths (incl. the aspect-ratio lock) lives in Geometry so it can be tested.
const applyResize = (r0, k, dx, dy, keepRatio) => Geometry.resizeRect(r0, k, dx, dy, keepRatio);

// Aspect ratio is kept when the Output-rect lock is on (Output view) or Shift is held.
function keepAspectNow(e) {
  return !!((e && e.shiftKey) || (outLock && view === 'output'));
}

function insertMaskPoint(s, wx, wy) {
  const pts = s.mask.points;
  let best = { d: Infinity, idx: 0, x: wx, y: wy };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    let u = ((wx - a.x) * abx + (wy - a.y) * aby) / len2;
    u = Math.max(0, Math.min(1, u));
    const px = a.x + u * abx, py = a.y + u * aby;
    const d = Math.hypot(wx - px, wy - py);
    if (d < best.d) best = { d, idx: i + 1, x: px, y: py };
  }
  pts.splice(best.idx, 0, { x: Math.round(best.x), y: Math.round(best.y) });
}

function onMouseDown(e) {
  if (!project || page !== 'editor') return;
  const px = e.offsetX, py = e.offsetY;
  if (bothView) setBand(bandAt(py));
  const t = vt[view];

  if (e.button === 1 || spaceDown) {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: t.ox, oy: t.oy };
    return;
  }

  if (e.button === 2 && maskEditActive()) {
    const idx = maskPointAt(px, py);
    const sel = selected();
    if (idx >= 0 && sel.mask.points.length > 3) {
      pushHistory();
      sel.mask.points.splice(idx, 1);
      refreshProps();
      draw();
      markDirty();
    }
    return;
  }
  if (e.button !== 0) return;

  if (maskEditActive()) {
    const sel = selected();
    const idx = maskPointAt(px, py);
    if (idx >= 0) {
      pushHistory();
      drag = { mode: 'maskpoint', idx, start: toWorld(px, py), orig: { ...sel.mask.points[idx] } };
      return;
    }
    const wpt = toWorld(px, py);
    if (pointInPoly(wpt.x, wpt.y, sel.mask.points)) {
      pushHistory();
      drag = { mode: 'maskmove', start: wpt, orig: sel.mask.points.map((p) => ({ ...p })) };
      return;
    }
  }

  const hk = handleAt(px, py);
  if (hk) {
    const sel = selected();
    pushHistory();
    drag = { mode: 'resize', k: hk, start: toWorld(px, py), orig: { ...sliceRect(sel, view) } };
    return;
  }

  const s = sliceAt(px, py);
  if (s) {
    if (selId !== s.id) {
      const screenChanged = activeScreenId !== sliceScreenId(s);
      selId = s.id;
      selScreenId = sliceScreenId(s);
      activeScreenId = selScreenId;
      if (bothView && screenChanged) fitView('output');
      refreshSliceList();
      refreshProps();
    }
    pushHistory();
    drag = { mode: 'move', start: toWorld(px, py), orig: { ...sliceRect(s, view) } };
    draw();
    return;
  }
  if (selId !== null || selScreenId !== null) {
    selId = null;
    selScreenId = null;
    refreshSliceList();
    refreshProps();
    draw();
  }
  drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: t.ox, oy: t.oy };
}

function onDblClick(e) {
  if (!maskEditActive()) return;
  const sel = selected();
  const wpt = toWorld(e.offsetX, e.offsetY);
  pushHistory();
  insertMaskPoint(sel, wpt.x, wpt.y);
  refreshProps();
  draw();
  markDirty();
}

// Hovering only looks at the band under the cursor; a click is what makes it the active one
function onMouseMove(e) {
  if (!project || page !== 'editor') return;
  if (!bothView || drag) {
    trackMouse(e);
    return;
  }
  const active = view;
  view = bandAt(e.offsetY);
  trackMouse(e);
  view = active;
}

function trackMouse(e) {
  const px = e.offsetX, py = e.offsetY;
  const wpt = toWorld(px, py);
  $('status-pos').textContent = `${view === 'input' ? 'Input' : 'Output · ' + activeScreen().name}: ${Math.round(wpt.x)}, ${Math.round(wpt.y)}  ·  zoom ${Math.round(vt[view].scale * 100)}%${maskEditActive() ? '  ·  MASK EDIT' : ''}`;

  if (!drag) {
    if (maskEditActive() && maskPointAt(px, py) >= 0) {
      canvas.style.cursor = 'crosshair';
      return;
    }
    const hk = handleAt(px, py);
    canvas.style.cursor = hk
      ? HANDLE_CURSORS[hk]
      : sliceAt(px, py)
        ? 'move'
        : spaceDown
          ? 'grab'
          : 'default';
    return;
  }

  const t = vt[view];
  if (drag.mode === 'pan') {
    t.ox = drag.ox + (e.clientX - drag.sx);
    t.oy = drag.oy + (e.clientY - drag.sy);
    draw();
    return;
  }

  const sel = selected();
  if (!sel) return;
  const dx = wpt.x - drag.start.x;
  const dy = wpt.y - drag.start.y;

  if (drag.mode === 'maskpoint') {
    const p = sel.mask.points[drag.idx];
    if (p) {
      p.x = Math.round(drag.orig.x + dx);
      p.y = Math.round(drag.orig.y + dy);
    }
  } else if (drag.mode === 'maskmove') {
    sel.mask.points.forEach((p, i) => {
      p.x = Math.round(drag.orig[i].x + dx);
      p.y = Math.round(drag.orig[i].y + dy);
    });
  } else if (drag.mode === 'move') {
    const r = sliceRect(sel, view);
    let nr = { x: drag.orig.x + dx, y: drag.orig.y + dy, w: drag.orig.w, h: drag.orig.h };
    const sn = snapDelta(nr, view);
    nr.x += sn.dx;
    nr.y += sn.dy;
    r.x = Math.round(nr.x);
    r.y = Math.round(nr.y);
  } else if (drag.mode === 'resize') {
    const keep = keepAspectNow(e);
    const nr = applyResize(drag.orig, drag.k, dx, dy, keep);
    // free-form resize snaps to neighbouring edges; a locked ratio must not be
    // broken by that, so snapping is skipped while the ratio is held
    Object.assign(sliceRect(sel, view), keep ? nr : snapResize(nr, drag.k, view));
  }
  refreshProps();
  refreshSliceList();
  draw();
  markDirty();
}

function onMouseUp() {
  drag = null;
}

function onWheel(e) {
  if (page !== 'editor') return;
  e.preventDefault();
  const active = view;
  if (bothView) view = bandAt(e.offsetY);
  const t = vt[view];
  const mouse = MapEdit.isMouseWheel(e, IS_MAC);
  if (mouse) {
    zoomAt(e.offsetX, e.offsetY, MapEdit.notchFactor(e));
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
    zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.01)); // pinch on a trackpad
  } else {
    const pan = MapEdit.panDelta(e);
    t.ox -= pan.x;
    t.oy -= pan.y;
    draw();
  }
  view = active;
}

function zoomAt(px, py, factor) {
  const t = vt[view];
  const ns = Math.max(0.002, Math.min(16, t.scale * factor));
  t.ox = px - ((px - t.ox) / t.scale) * ns;
  t.oy = py - ((py - t.oy) / t.scale) * ns;
  t.scale = ns;
  updateZoomLabel();
  draw();
}

// ---------------- UI refresh ----------------
// Resolume Advanced Output-style tree: screens with their slices nested below.
function refreshSliceList() {
  const list = $('screen-tree');
  if (!list) return;
  const scroll = list.scrollTop;
  list.innerHTML = '';
  // A new selection opens its screen and scrolls to its row; a screen you fold shut stays shut
  const reveal = selId !== revealedSelId && selId !== null;
  revealedSelId = selId;
  if (reveal && selected()) collapsedScreens.delete(sliceScreenId(selected()));
  let selectedRow = null;

  project.screens.forEach((sc) => {
    const head = document.createElement('div');
    head.className = 'screen-row' + (selectedScreen() && selectedScreen().id === sc.id ? ' selected' : '');
    const chev = document.createElement('span');
    chev.className = 'chev';
    const folded = collapsedScreens.has(sc.id);
    chev.textContent = folded ? '▸' : '▾';
    chev.title = folded ? 'Show the slices' : 'Hide the slices';
    chev.onclick = (e) => {
      e.stopPropagation();
      if (folded) collapsedScreens.delete(sc.id);
      else collapsedScreens.add(sc.id);
      refreshSliceList();
    };
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = sc.name;
    const res = document.createElement('span');
    res.className = 'res';
    res.textContent = `${sc.width}×${sc.height}`;
    head.append(chev, nm, res);
    head.onclick = () => selectScreen(sc.id);
    // drop a slice onto the screen header = move it into this screen
    head.addEventListener('dragover', (e) => {
      e.preventDefault();
      head.classList.add('drag-over-bottom');
    });
    head.addEventListener('dragleave', () => head.classList.remove('drag-over-bottom'));
    head.addEventListener('drop', (e) => {
      e.preventDefault();
      head.classList.remove('drag-over-bottom');
      const sid = e.dataTransfer.getData('text/slice');
      const src = project.slices.find((x) => x.id === sid);
      if (!src) return;
      pushHistory();
      project.slices.splice(project.slices.indexOf(src), 1);
      project.slices.push(src);
      src.screenId = sc.id;
      refreshSliceList();
      refreshProps();
      draw();
      markDirty();
    });
    list.appendChild(head);

    project.slices.forEach((s) => {
      if (sliceScreenId(s) !== sc.id || collapsedScreens.has(sc.id)) return;
      const item = document.createElement('div');
      item.className = 'slice-item' + (s.id === selId ? ' selected' : '') + (s.enabled === false ? ' off' : '');
      if (s.id === selId) selectedRow = item;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.enabled !== false;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        pushHistory();
        s.enabled = cb.checked;
        refreshSliceList();
        refreshProps();
        draw();
        markDirty();
      });
      const snm = document.createElement('span');
      snm.className = 'nm';
      snm.textContent = s.name;
      const sz = document.createElement('span');
      sz.className = 'sz';
      const r = sliceRect(s, view);
      sz.textContent = `${r.w}×${r.h}`;
      const info = MapCheck.scaleInfo(s);
      const pill = document.createElement('span');
      pill.className = 'scale-pill ' + (info.exact ? 'exact' : 'scaled');
      pill.textContent = info.label;
      pill.title = info.exact ? 'Shown pixel for pixel' : 'Output size differs from the input size, so this slice is scaled';
      const meta = document.createElement('div');
      meta.className = 'sl-meta';
      meta.append(sz, pill);
      item.append(cb, snm, meta);
      item.addEventListener('click', () => selectSlice(s.id));
      // drag to reorder within / move between screens
      item.draggable = true;
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/slice', s.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        const rr = item.getBoundingClientRect();
        const before = e.clientY < rr.top + rr.height / 2;
        item.classList.toggle('drag-over-top', before);
        item.classList.toggle('drag-over-bottom', !before);
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over-top', 'drag-over-bottom'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over-top', 'drag-over-bottom');
        const sid = e.dataTransfer.getData('text/slice');
        if (!sid || sid === s.id) return;
        const src = project.slices.find((x) => x.id === sid);
        if (!src) return;
        pushHistory();
        const rr = item.getBoundingClientRect();
        const before = e.clientY < rr.top + rr.height / 2;
        project.slices.splice(project.slices.indexOf(src), 1);
        const idx = project.slices.indexOf(s) + (before ? 0 : 1);
        project.slices.splice(idx, 0, src);
        src.screenId = sliceScreenId(s);
        refreshSliceList();
        draw();
        markDirty();
      });
      list.appendChild(item);
    });
  });
  list.scrollTop = scroll;
  if (reveal && selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
}

const FLIP_LABELS = ['None', 'H', 'V', 'H+V'];
const FLIP_PATHS = [
  'M10 2 A8 8 0 1 1 9.99 2 Z',
  'M10 10 L16 4 A8 8 0 1 1 16 16 Z M10 10 L4 4 A8 8 0 0 0 4 16 Z',
  'M10 10 L4 4 A8 8 0 0 1 16 4 Z M10 10 L4 16 A8 8 0 0 0 16 16 Z',
  'M10 2 A8 8 0 1 1 2 10 L10 10 Z',
];

function refreshScreenSelectors() {
  const opts = project.screens
    .map((sc, i) => `<option value="${sc.id}">${i + 1}. ${sc.name} (${sc.width}×${sc.height})</option>`)
    .join('');
  const slsel = $('sl-screen');
  // no resolution here: the tree already lists it, and the name stays readable in the panel
  slsel.innerHTML = project.screens.map((sc, i) => `<option value="${sc.id}">${i + 1}. ${sc.name}</option>`).join('');
  if (selected()) slsel.value = sliceScreenId(selected());
  const rpsel = $('rp-screen-select');
  rpsel.innerHTML = opts;
  if (!project.screens.some((sc) => sc.id === rp.screenId)) rp.screenId = project.screens[0].id;
  rpsel.value = rp.screenId;
  rpsel.classList.toggle('hidden', !(project.screens.length > 1 && (rp.viewMode === 'output' || ck.active)));
}

// Write a value into a form field, but never into the one the user is typing in.
// Overwriting the focused field is the classic cause of "the box won't let me
// change the value" — reported repeatedly on Windows.
function setField(id, val) {
  const el = $(id);
  if (!el || el === document.activeElement) return;
  el.value = val;
}

function refreshProps() {
  const s = selected();
  const scr = selectedScreen();
  // Resolume-style: show only the selected item's properties
  $('slice-props').classList.toggle('hidden', !s);
  $('screen-props').classList.toggle('hidden', !scr);
  if (scr) {
    setField('scr-name', scr.name);
    setField('out-w', scr.width);
    setField('out-h', scr.height);
    const n = project.slices.filter((x) => sliceScreenId(x) === scr.id).length;
    $('scr-info').textContent = `${n} slice${n === 1 ? '' : 's'} on this screen`;
  }
  const set = setField;
  refreshOutLockBtn();
  // Edit mode belongs to one slice: it ends when the selection moves or the mask goes away
  if (maskEditId && (!s || s.id !== maskEditId || !maskUsable(s))) maskEditId = null;
  refreshMaskBar();
  if (!s) return;
  set('sl-name', s.name);
  $('sl-enabled').checked = s.enabled !== false;
  $('sl-screen').value = sliceScreenId(s);
  set('sl-in-x', s.in.x); set('sl-in-y', s.in.y); set('sl-in-w', s.in.w); set('sl-in-h', s.in.h);
  set('sl-out-x', s.out.x); set('sl-out-y', s.out.y); set('sl-out-w', s.out.w); set('sl-out-h', s.out.h);
  $('sl-out-1to1').disabled = MapCheck.scaleInfo(s).exact;
  $('sl-in-rot').value = String(s.inOrient || 0);
  $('sl-out-rot').value = String(s.outOrient || 0);
  $('flip-label').textContent = FLIP_LABELS[s.flip || 0];
  $('flip-pac').setAttribute('d', FLIP_PATHS[s.flip || 0]);
  $('sl-flip').classList.toggle('active', !!s.flip);

  const bb = s.mask ? Geometry.maskBBox(s.mask) : null;
  // Collapsed until there is a mask; a switched-off mask keeps its points and can come back
  const hasMask = maskUsable(s);
  $('mask-add-row').classList.toggle('hidden', hasMask);
  $('mask-body').classList.toggle('hidden', !hasMask);
  $('mask-add').textContent = s.mask && s.mask.points ? 'Turn mask back on' : 'Add mask';
  $('mask-enabled').checked = !!(s.mask && s.mask.enabled);
  $('mask-edit').classList.toggle('active', maskEditId === s.id);
  $('mask-edit').textContent = maskEditId === s.id ? 'Done editing' : 'Edit points';
  set('mask-x', bb ? bb.x : '');
  set('mask-y', bb ? bb.y : '');
  set('mask-w', bb ? bb.w : '');
  set('mask-h', bb ? bb.h : '');
}

function refreshMaskBar() {
  $('mask-bar').classList.toggle('hidden', !(maskEditId && maskEditId === selId && (bothView || view === 'input')));
}

function startMaskEdit() {
  const s = selected();
  if (!s || !maskUsable(s)) return;
  if (bothView) setBand('input');
  else if (view !== 'input') switchView('input');
  maskEditId = s.id;
  frameRect('input', s.in);
  updateZoomLabel();
  refreshProps();
  draw();
}

function stopMaskEdit() {
  maskEditId = null;
  refreshProps();
  draw();
}

function refreshProjectFields() {
  setField('p-name', project.name);
  setField('in-w', project.input.width);
  setField('in-h', project.input.height);
  refreshScreenSelectors();
}

function refreshOutLockBtn() {
  const btn = $('sl-out-lock');
  if (!btn) return;
  btn.classList.toggle('active', outLock);
  $('lock-path').setAttribute('d', outLock ? LOCK_PATHS.on : LOCK_PATHS.off);
  $('lock-label').textContent = outLock ? 'Locked' : 'Free';
}

function refreshRefPanel() {
  $('ref-view-label').textContent = view === 'input' ? 'Input' : 'Output';
  const ref = project.refs[view];
  $('ref-name').textContent = ref ? ref.name || 'image' : 'no image';
  $('ref-opacity').value = Math.round(((ref && ref.opacity) != null ? ref.opacity : 0.6) * 100);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function refreshEngineInfo() {
  const el = $('ffmpeg-info');
  if (appFacts) $('ab-name').textContent = `XtremeLED Remap Export ${appFacts.version}`;
  if (!caps || !caps.entries || !caps.entries.length) {
    el.innerHTML = 'ffmpeg not found';
    return;
  }
  const main = caps.entries.find((x) => x.path === caps.proresPath) || caps.entries[0];
  const line = (info) => `<div class="ab-line">${info.ok ? '<span class="ok">✓</span>' : ''}<span class="${info.ok ? 'val' : ''}">${escapeHtml(info.text)}</span></div>`;
  const tag = (okFlag, name) =>
    okFlag ? `<span style="color:#f7941e">${name} ✓</span>` : `${name} ✗`;
  el.innerHTML = line(AppInfo.pinLine(main.version, ffmpegPinState))
    + line(AppInfo.testsLine(appFacts && appFacts.buildInfo))
    + `<div>ProRes ✓ · ${tag(caps.hasDxv, 'DXV3')} · ${tag(caps.hasHap, 'HAP')} · ${tag(caps.hasX265, 'HEVC')}</div>`;
}

// ---------------- about, licenses, updates ----------------
const UPDATE_DISMISSED_KEY = 'xre:update-dismissed';
const UPDATE_CHECK_DELAY_MS = 8000;
const UPDATE_RETRY_MS = 5 * 60 * 1000;
let appFacts = null;
let ffmpegPinState = null;
let updateInfo = null;

function updateDismissed(version) {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY) === version;
  } catch (e) {
    return false;
  }
}

// Stays away during an export; what arrived meanwhile shows once the export is over
function refreshUpdateNotice() {
  const show = !!updateInfo && !rp.running && !updateDismissed(updateInfo.version);
  const box = $('update-notice');
  if (show === !box.classList.contains('hidden')) return;
  box.classList.toggle('hidden', !show);
  if (show) $('update-text').textContent = `Version ${updateInfo.version} is available`;
  if (page === 'editor') {
    resizeCanvas();
    draw();
  }
}

async function checkForUpdate() {
  if (rp.running) {
    setTimeout(checkForUpdate, UPDATE_RETRY_MS);
    return;
  }
  updateInfo = await api.checkForUpdate().catch(() => null);
  refreshUpdateNotice();
}

async function showLicenses() {
  const texts = await api.licenses().catch(() => null);
  openModal(`
    <div class="modal" style="width:680px">
      <div class="modal-head"><span>Open-source licenses</span><button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body"><pre class="lic-text" id="m-lic"></pre></div>
      <div class="modal-foot"><button id="m-ok">Close</button></div>
    </div>`);
  $('m-lic').textContent = texts ? `${texts.notice}\n\n${'-'.repeat(72)}\n\n${texts.gpl}` : 'The license files are missing from this installation.';
  $('m-close').onclick = closeModal;
  $('m-ok').onclick = closeModal;
}

async function copyDiagnostics(button) {
  const text = await api.diagnostics();
  await api.copyText(text);
  if (!button) return;
  const before = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = before; }, 1600);
}

async function showAbout() {
  const f = appFacts || (await api.appInfo());
  const pin = caps && caps.entries && caps.entries.length ? AppInfo.pinLine((caps.entries.find((x) => x.path === caps.proresPath) || caps.entries[0]).version, ffmpegPinState).text : 'ffmpeg not found';
  const row = (k, v) => `<div><span class="dim">${k}</span>${escapeHtml(v)}</div>`;
  openModal(`
    <div class="modal" style="width:460px">
      <div class="modal-head"><span>About XtremeLED Remap Export</span><button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body about-rows">
        ${row('Version', f.version)}
        ${row('Rendering', pin)}
        ${row('Tests', AppInfo.testsLine(f.buildInfo).text.replace(/^Tests: /, ''))}
        ${row('Electron', f.electron)}
        ${row('System', `${f.platform} ${f.arch}`)}
        ${row('Made by', 'XtremeLED')}
      </div>
      <div class="modal-foot">
        <button id="m-diag">Copy diagnostics</button>
        <button id="m-lic-open">Open-source licenses</button>
        <button id="m-ok" class="accent">Close</button>
      </div>
    </div>`);
  $('m-close').onclick = closeModal;
  $('m-ok').onclick = closeModal;
  $('m-diag').onclick = () => copyDiagnostics($('m-diag'));
  $('m-lic-open').onclick = () => showLicenses();
}

function handleMenu(action) {
  if (action === 'diagnostics') {
    copyDiagnostics(null);
    return;
  }
  // The app menu stays clickable behind a dialog, and an export may be waiting on that dialog's
  // answer: opening another one over it would leave the export hanging until a restart.
  if (modalOpen()) return;
  if (action === 'about') showAbout();
  else if (action === 'licenses') showLicenses();
}

function refreshAll() {
  refreshProjectFields();
  refreshRefPanel();
  refreshSliceList();
  refreshProps();
  draw();
  refreshFileList();
  drawRenderPreview();
}

// ---------------- actions ----------------
function switchView(v) {
  const wasBoth = bothView;
  bothView = v === 'both';
  if (!bothView) view = v;
  ['input', 'output', 'both'].forEach((id) => $(`tab-${id}`).classList.toggle('active', v === id));
  // the views live in canvas coordinates, and those change when the bands come or go
  if (bothView !== wasBoth) {
    fitView('input');
    fitView('output');
  }
  if (view === 'output' && !bothView) maskEditId = null;
  refreshRefPanel();
  refreshSliceList();
  refreshProps();
  refreshScreenSelectors();
  updateZoomLabel();
  draw();
}

function switchPage(p) {
  if (p !== 'render') stopPlayback(false);
  page = p;
  $('editor-page').classList.toggle('hidden', p !== 'editor');
  $('render-page').classList.toggle('hidden', p !== 'render');
  $('btn-render').classList.toggle('hidden', p === 'render');
  $('btn-back-editor').classList.toggle('hidden', p !== 'render');
  ['tb-editor-left', 'view-tabs'].forEach((id) => $(id).classList.toggle('hidden', p === 'render'));
  document.querySelectorAll('#toolbar .zoom, #toolbar .tb-sep:not(.doc-sep)').forEach((el) => el.classList.toggle('hidden', p === 'render'));
  refreshScreenSelectors();
  if (p === 'editor') {
    resizeCanvas();
  } else {
    resizeRenderCanvas();
    refreshFileList();
    refreshCodecUI();
    drawRenderPreview();
  }
}

function addSlice() {
  pushHistory();
  const inC = project.input;
  const sc = activeScreen();
  const s = newSliceDefaults({
    id: uid(),
    name: 'Slice ' + (project.slices.length + 1),
    screenId: sc.id,
    in: { x: Math.round(inC.width / 4), y: Math.round(inC.height / 4), w: Math.round(inC.width / 2), h: Math.round(inC.height / 2) },
    out: { x: Math.round(sc.width / 4), y: Math.round(sc.height / 4), w: Math.round(sc.width / 2), h: Math.round(sc.height / 2) },
  });
  project.slices.push(s);
  selectSlice(s.id);
  markDirty();
}

function duplicateSlice() {
  const s = selected();
  if (!s) return;
  pushHistory();
  const c = JSON.parse(JSON.stringify(s));
  c.id = uid();
  c.name = s.name + ' copy';
  c.in.x += 20; c.in.y += 20;
  c.out.x += 20; c.out.y += 20;
  if (c.mask && c.mask.points) c.mask.points.forEach((p) => { p.x += 20; p.y += 20; });
  project.slices.splice(project.slices.indexOf(s) + 1, 0, c);
  selectSlice(c.id);
  markDirty();
}

function deleteSlice() {
  const s = selected();
  if (!s) return;
  pushHistory();
  const scrId = sliceScreenId(s);
  project.slices.splice(project.slices.indexOf(s), 1);
  selId = null;
  selScreenId = scrId; // fall back to selecting its screen
  // last slice of this output gone? offer to remove the output as well
  const scr = project.screens.find((x) => x.id === scrId);
  const remaining = project.slices.filter((x) => sliceScreenId(x) === scrId).length;
  if (
    scr &&
    remaining === 0 &&
    project.screens.length > 1 &&
    confirm(`Output "${scr.name}" has no slices left. Delete this output too?`)
  ) {
    project.screens.splice(project.screens.indexOf(scr), 1);
    selScreenId = project.screens[0].id;
    activeScreenId = selScreenId;
    refreshScreenSelectors();
    if (outputShown()) fitView('output');
  }
  refreshSliceList();
  refreshProps();
  draw();
  markDirty();
}

function duplicateScreen() {
  const scr = selectedScreen();
  if (!scr) return;
  pushHistory();
  const copy = { id: 'scr' + Math.random().toString(36).slice(2, 7), name: scr.name + ' copy', width: scr.width, height: scr.height };
  project.screens.splice(project.screens.indexOf(scr) + 1, 0, copy);
  // copy the screen's slices too
  const newSlices = project.slices
    .filter((s) => sliceScreenId(s) === scr.id)
    .map((s) => {
      const c = JSON.parse(JSON.stringify(s));
      c.id = uid();
      c.screenId = copy.id;
      return c;
    });
  project.slices.push(...newSlices);
  selectScreen(copy.id);
  markDirty();
}

function deleteSelectedScreen() {
  const scr = selectedScreen();
  if (!scr || project.screens.length <= 1) return;
  if (!confirm(`Delete screen "${scr.name}"? Its slices move to the first screen.`)) return;
  pushHistory();
  project.screens.splice(project.screens.indexOf(scr), 1);
  project.slices.forEach((s) => {
    if (s.screenId === scr.id) s.screenId = project.screens[0].id;
  });
  selectScreen(project.screens[0].id);
  markDirty();
}

// ---------------- modals ----------------
function openModal(html) {
  const root = $('modal-root');
  root.innerHTML = html;
  root.classList.remove('hidden');
  return root;
}
function closeModal() {
  const root = $('modal-root');
  root.classList.add('hidden');
  root.innerHTML = '';
}

function modalOpen() {
  return !$('modal-root').classList.contains('hidden');
}

// A dialog field as a whole number: NaN when it isn't one. `empty` is what an empty field means.
function dialogInt(id, empty) {
  const str = String($(id).value).trim();
  if (str === '' && empty !== undefined) return empty;
  const n = Math.round(calcNum(str));
  return Number.isFinite(n) ? n : NaN;
}

function rememberedPanelWidth() {
  try {
    const stored = parseInt(localStorage.getItem('xre:panelw'), 10);
    if (stored > 0) return stored;
  } catch (e) { /* only a convenience */ }
  return $('tp-grid').checked && parseInt($('tp-grid-w').value, 10) > 0 ? parseInt($('tp-grid-w').value, 10) : '';
}

function rememberPanelWidth(panelW) {
  try {
    if (panelW > 0) localStorage.setItem('xre:panelw', String(panelW));
    else localStorage.removeItem('xre:panelw');
  } catch (e) { /* only a convenience */ }
}

// The rows on the output canvas, to scale; whatever does not fit shows red, outside the frame
function splitSketchSvg(l, canvas, short) {
  const VW = 480, VH = 270;
  const x0 = Math.min(0, ...l.rects.map((r) => r.x)), y0 = Math.min(0, ...l.rects.map((r) => r.y));
  const x1 = Math.max(canvas.w, l.right), y1 = Math.max(canvas.h, l.bottom);
  const k = Math.min(VW / (x1 - x0), VH / (y1 - y0));
  const sx = (x) => (x - x0) * k + 1;
  const sy = (y) => (y - y0) * k + 1;
  const parts = [`<rect x="${sx(0)}" y="${sy(0)}" width="${canvas.w * k}" height="${canvas.h * k}" fill="#0d0f10" stroke="#4c5358" />`];
  const noun = l.quarter ? 'Column' : 'Row';
  const seamsFit = l.panelW && l.panelW * k >= 3;
  l.rects.forEach((r, i) => {
    const over = r.x < 0 || r.y < 0 || r.x + r.w > canvas.w || r.y + r.h > canvas.h;
    const stroke = over ? '#e05555' : '#f7941e';
    const w = r.w * k, h = r.h * k;
    parts.push(`<rect x="${sx(r.x) + 0.5}" y="${sy(r.y) + 0.5}" width="${Math.max(1, w - 1)}" height="${Math.max(1, h - 1)}" fill="${over ? 'rgba(224,85,85,0.18)' : 'rgba(247,148,30,0.14)'}" stroke="${stroke}" />`);
    if (seamsFit) {
      const seams = Math.ceil(l.widths[i] / l.panelW);
      for (let p = 1; p < seams; p++) {
        const d = p * l.panelW * k;
        parts.push(l.quarter
          ? `<line x1="${sx(r.x)}" y1="${sy(r.y) + d}" x2="${sx(r.x) + w}" y2="${sy(r.y) + d}" stroke="rgba(247,148,30,0.28)" />`
          : `<line x1="${sx(r.x) + d}" y1="${sy(r.y)}" x2="${sx(r.x) + d}" y2="${sy(r.y) + h}" stroke="rgba(247,148,30,0.28)" />`);
      }
    }
    if (h >= 18 && w >= 170 && l.rects.length <= 12) {
      const panels = l.panels ? ` · ${Math.round(l.panels[i] * 10) / 10} panels` : '';
      const text = `${noun} ${i + 1}${panels} · ${r.w}×${r.h}`;
      const lw = text.length * 5.8 + 16;
      parts.push(`<rect x="${sx(r.x) + w / 2 - lw / 2}" y="${sy(r.y) + h / 2 - 10}" width="${lw}" height="20" rx="3" fill="#1a1d1f" />`);
      parts.push(`<text x="${sx(r.x) + w / 2}" y="${sy(r.y) + h / 2 + 4}" text-anchor="middle" font-size="11" fill="#cfd3d6">${text}</text>`);
    }
  });
  return `<svg class="nm-preview${short ? ' short' : ''}" viewBox="0 0 ${VW + 2} ${VH + 2}" preserveAspectRatio="xMidYMid meet" font-family="-apple-system, 'Segoe UI', sans-serif">${parts.join('')}</svg>`;
}

function openSplitModal() {
  const s = selected();
  if (!s) {
    alert('Select a slice first.');
    return;
  }
  const sc = activeScreen();
  const canvasSize = { w: sc.width, h: sc.height };
  const quarter = Geometry.netRotation(s) % 180 !== 0;
  const noun = quarter ? 'column' : 'row';
  const Noun = quarter ? 'Column' : 'Row';
  const room = Math.min(quarter ? sc.height : sc.width, s.in.w);
  const roundedPart = (panelW) => MapEdit.partWidth(room, panelW) || room;
  const panelDefault = rememberedPanelWidth();
  openModal(`
    <div class="modal" style="width:540px" data-enter-apply="1">
      <div class="modal-head"><span id="m-title"></span><button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body">
        <div class="nm-grid pairs">
          <label for="m-partw">Part width</label><div class="nm-field"><input type="text" id="m-partw" class="num" value="${roundedPart(panelDefault)}" /><span class="dim">px</span></div>
          <label for="m-panelw">Panel width</label><div class="nm-field"><input type="text" id="m-panelw" class="num" value="${panelDefault}" /><span class="dim">px</span></div>
          <label for="m-rowh">${Noun} ${quarter ? 'width' : 'height'}</label><div class="nm-field"><input type="text" id="m-rowh" class="num" value="${s.in.h}" /><span class="dim">px</span></div>
          <label for="m-gapy">${Noun} gap</label><div class="nm-field"><input type="text" id="m-gapy" class="num" value="0" /><span class="dim">px</span></div>
          <label for="m-startx">Start X</label><div class="nm-field"><input type="text" id="m-startx" class="num" value="0" /></div>
          <label for="m-starty">Start Y</label><div class="nm-field"><input type="text" id="m-starty" class="num" value="0" /></div>
        </div>
        <div class="nm-preview-wrap" id="m-sketch"></div>
        <div class="split-summary" id="m-summary"></div>
        <div class="split-note hidden" id="m-note"></div>
      </div>
      <div class="modal-foot">
        <button id="m-cancel">Cancel</button>
        <button id="m-apply" class="accent">Split</button>
      </div>
    </div>
  `);
  $('m-title').textContent = `Split "${s.name}" into ${noun}s`;
  const readLayout = () => {
    const panelW = dialogInt('m-panelw', 0);
    const partRaw = dialogInt('m-partw');
    const rowH = dialogInt('m-rowh');
    const gap = dialogInt('m-gapy', 0);
    const startX = dialogInt('m-startx', 0);
    const startY = dialogInt('m-starty', 0);
    const valid = [panelW, partRaw, rowH, gap, startX, startY].every(Number.isFinite) && panelW >= 0 && partRaw >= 1 && rowH >= 1 && gap >= 0;
    if (!valid) return null;
    const partW = panelW ? MapEdit.partWidth(partRaw, panelW) : partRaw;
    if (partW < 1) return { tooSmall: true };
    return MapEdit.layout({ totalW: s.in.w, rowH, partW, panelW, startX, startY, gap, canvas: canvasSize, quarter });
  };
  const update = () => {
    const l = readLayout();
    const usable = l && !l.tooSmall && l.fits;
    const summary = $('m-summary');
    summary.classList.toggle('bad', !usable);
    summary.textContent = !l ? 'Fill in the sizes' : l.tooSmall ? 'The part width is smaller than one panel' : MapEdit.summary(l, canvasSize);
    $('m-sketch').innerHTML = l && !l.tooSmall && l.rects.length
      ? splitSketchSvg(l, canvasSize, true) + `<span class="nm-res">Output ${sc.width}×${sc.height}</span>`
      : '';
    const apply = $('m-apply');
    apply.disabled = !usable;
    const n = l && !l.tooSmall ? l.widths.length : 0;
    apply.textContent = usable ? `Split into ${n} ${noun}${n === 1 ? '' : 's'}` : 'Split';
    const notes = [];
    if (l && !l.tooSmall && !MapCheck.scaleInfo(s).exact) notes.push(`This slice is scaled (${MapCheck.scaleInfo(s).label}). Split makes the parts pixel for pixel.`);
    if (l && !l.tooSmall && l.rects.length && l.rects[0][quarter ? 'w' : 'h'] !== s.in.h) notes.push(`${Noun}s are stretched: the input is ${s.in.h} px ${quarter ? 'wide' : 'high'}.`);
    const outside = usable ? MapEdit.partsOutsideMask(s, l) : 0;
    if (outside) notes.push(`${outside} part${outside === 1 ? '' : 's'} outside the mask start${outside === 1 ? 's' : ''} switched off.`);
    $('m-note').textContent = notes.join(' ');
    $('m-note').classList.toggle('hidden', !notes.length);
  };
  ['m-partw', 'm-rowh', 'm-gapy', 'm-startx', 'm-starty'].forEach((id) => ($(id).oninput = update));
  $('m-panelw').oninput = () => {
    const panelW = dialogInt('m-panelw', 0);
    if (Number.isFinite(panelW) && panelW >= 0) $('m-partw').value = roundedPart(panelW);
    update();
  };
  $('m-partw').onchange = () => {
    const panelW = dialogInt('m-panelw', 0);
    const partRaw = dialogInt('m-partw');
    if (panelW > 0 && partRaw >= panelW) $('m-partw').value = MapEdit.partWidth(partRaw, panelW);
    update();
  };
  update();
  $('m-close').onclick = closeModal;
  $('m-cancel').onclick = closeModal;
  $('m-apply').onclick = () => {
    const l = readLayout();
    const idx = project.slices.indexOf(s);
    if (!l || l.tooSmall || !l.fits || idx < 0) return;
    rememberPanelWidth(l.panelW);
    pushHistory();
    const parts = MapEdit.splitSlice(s, l, uid);
    project.slices.splice(idx, 1, ...parts);
    selId = parts[0].id;
    closeModal();
    refreshSliceList();
    refreshProps();
    draw();
    markDirty();
  };
  $('m-partw').focus();
}

const OUTPUT_PRESETS = [{ w: 3840, h: 2160 }, { w: 1920, h: 1080 }];

// One screen for the whole setup of a wall; the alternative is starting from a mapping file
function openNewMappingModal() {
  const sc = project.screens[0];
  const presetMatch = OUTPUT_PRESETS.findIndex((p) => p.w === sc.width && p.h === sc.height);
  let preset = presetMatch; // -1 is Custom
  const tabs = OUTPUT_PRESETS.map((p, i) => `<button class="tab" data-preset="${i}">${p.w}×${p.h}</button>`).join('');
  openModal(`
    <div class="modal" id="new-mapping" style="width:516px" data-enter-apply="1">
      <div class="modal-head">New mapping<button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body">
        <div class="nm-grid">
          <label>Stageview</label>
          <div class="nm-field">
            <span class="x">W</span><input type="text" class="num" id="nm-w" value="${project.input.width}" />
            <span class="x">H</span><input type="text" class="num" id="nm-h" value="${project.input.height}" />
            <span class="dim">px</span>
          </div>
          <label>Output</label>
          <div class="nm-field">
            <div class="tabs">${tabs}<button class="tab" data-preset="-1">Custom</button></div>
          </div>
          <label class="hidden" id="nm-custom-label">Custom</label>
          <div class="nm-field hidden" id="nm-custom">
            <span class="x">W</span><input type="text" class="num" id="nm-ow" value="${sc.width}" />
            <span class="x">H</span><input type="text" class="num" id="nm-oh" value="${sc.height}" />
            <span class="dim">px</span>
          </div>
          <label>Panel width</label>
          <div class="nm-field"><input type="text" class="num" id="nm-panel" value="${rememberedPanelWidth()}" /><span class="dim">px</span></div>
        </div>
        <div class="nm-preview-wrap" id="m-sketch"></div>
        <div class="split-summary" id="m-summary"></div>
      </div>
      <div class="modal-foot">
        <button id="m-cancel">Cancel</button>
        <button id="m-apply" class="accent">Create mapping</button>
      </div>
      <div class="nm-alt">
        <span class="lead">Or:</span>
        <button id="nm-xml">Import Resolume XML</button>
        <span class="sep">·</span>
        <button id="nm-csv">Import Hippo CSV</button>
        <span class="sep">·</span>
        <span class="drop">drag a file here</span>
      </div>
    </div>
  `);
  const outputSize = () => {
    if (preset >= 0) return OUTPUT_PRESETS[preset];
    return { w: dialogInt('nm-ow'), h: dialogInt('nm-oh') };
  };
  const inRange = (n) => Number.isFinite(n) && n >= 1 && n <= 32768;
  const readLayout = () => {
    const w = dialogInt('nm-w');
    const h = dialogInt('nm-h');
    const out = outputSize();
    const panelW = dialogInt('nm-panel', 0);
    if (![w, h, out.w, out.h].every(inRange) || !Number.isFinite(panelW) || panelW < 0) return null;
    const partW = MapEdit.partWidth(Math.min(w, out.w), panelW);
    if (partW < 1) {
      const narrow = w < out.w ? 'The stageview is' : w > out.w ? 'The output is' : 'The stageview and output are';
      return { tooSmall: `${narrow} narrower than one panel` };
    }
    return { w, h, out, l: MapEdit.layout({ totalW: w, rowH: h, partW, panelW, canvas: out }) };
  };
  const update = () => {
    document.querySelectorAll('#new-mapping [data-preset]').forEach((b) => b.classList.toggle('active', Number(b.dataset.preset) === preset));
    $('nm-custom').classList.toggle('hidden', preset >= 0);
    $('nm-custom-label').classList.toggle('hidden', preset >= 0);
    const r = readLayout();
    const usable = r && !r.tooSmall && r.l.fits;
    const summary = $('m-summary');
    summary.classList.toggle('bad', !usable);
    summary.textContent = !r ? 'Fill in the sizes' : r.tooSmall || MapEdit.summary(r.l, r.out);
    $('m-sketch').innerHTML = r && !r.tooSmall && r.l.rects.length
      ? splitSketchSvg(r.l, r.out, false) + `<span class="nm-res">Output ${r.out.w}×${r.out.h}</span>`
      : '';
    $('m-apply').disabled = !usable;
  };
  ['nm-w', 'nm-h', 'nm-ow', 'nm-oh', 'nm-panel'].forEach((id) => ($(id).oninput = update));
  document.querySelectorAll('#new-mapping [data-preset]').forEach((b) => {
    b.onclick = () => {
      preset = Number(b.dataset.preset);
      update();
      if (preset < 0) $('nm-ow').focus();
    };
  });
  update();
  $('m-close').onclick = closeModal;
  $('m-cancel').onclick = closeModal;
  $('nm-xml').onclick = () => { closeModal(); importXml(); };
  $('nm-csv').onclick = () => { closeModal(); importCsv(); };
  $('m-apply').onclick = async () => {
    const r = readLayout();
    if (!r || r.tooSmall || !r.l.fits) return;
    if (!(await guardUnsaved())) return;
    rememberPanelWidth(r.l.panelW);
    closeModal();
    pushHistory(true);
    await switchToProject(newMappingProject(r.w, r.h, r.out, r.l));
  };
  $('nm-w').focus();
}

// The whole stageview as rows of whole panels on one output
function newMappingProject(w, h, out, l) {
  const p = newProject();
  p.input = { width: w, height: h };
  const scr = p.screens[0];
  scr.width = out.w;
  scr.height = out.h;
  const whole = newSliceDefaults({ id: '', name: 'Row', screenId: scr.id, in: { x: 0, y: 0, w, h }, out: { x: 0, y: 0, w, h } });
  p.slices = MapEdit.splitSlice(whole, l, uid);
  if (p.slices.length === 1) p.slices[0].name = 'Slice 1';
  return p;
}

// Asked once per batch when outputs already exist: 'overwrite', 'version', 'skip' or null (cancel)
function askExisting(names, canSkip) {
  return new Promise((resolve) => {
    const title = names.length > 1 ? `These files already exist (${names.length})` : 'This file already exists';
    openModal(`
      <div class="modal" style="width:460px">
        <div class="modal-head"><span id="m-title"></span><button class="close-x" id="m-close">✕</button></div>
        <div class="modal-body"><div class="exists-list" id="m-list"></div></div>
        <div class="modal-foot">
          <button id="m-cancel">Cancel</button>
          ${canSkip ? '<button id="m-skip">Skip these</button>' : ''}
          <button id="m-overwrite">Overwrite</button>
          <button id="m-version" class="accent">Save as new version</button>
        </div>
      </div>
    `);
    $('m-title').textContent = title;
    names.forEach((n) => {
      const row = document.createElement('div');
      row.textContent = n;
      row.title = n;
      $('m-list').appendChild(row);
    });
    const done = (val) => {
      closeModal();
      resolve(val);
    };
    $('m-close').onclick = () => done(null);
    $('m-cancel').onclick = () => done(null);
    if (canSkip) $('m-skip').onclick = () => done('skip');
    $('m-overwrite').onclick = () => done('overwrite');
    $('m-version').onclick = () => done('version');
    $('m-version').focus();
  });
}

// Ask how to export multiple screens: separate / merged / both
function askOutputMode(clipCount) {
  return new Promise((resolve) => {
    const remembered = localStorage.getItem('xre:outmode') || 'separate';
    const counts = ExportPlan.outputCounts(clipCount, project.screens.length);
    const def = currentCodec();
    const noun = def.sequence ? 'folder' : 'file';
    const gives = (n) => `<span class="dim">(${ExportPlan.plural(n, noun)})</span>`;
    openModal(`
      <div class="modal" style="width:430px">
        <div class="modal-head">Multiple outputs<button class="close-x" id="m-close">✕</button></div>
        <div class="modal-body">
          <div class="note">This project has ${project.screens.length} screens. How do you want to export them?</div>
          <div class="radio-col">
            <label><input type="radio" name="m-outmode" value="separate" ${remembered === 'separate' ? 'checked' : ''} /> Separate file per screen ${gives(counts.separate)}</label>
            <label><input type="radio" name="m-outmode" value="merged" ${remembered === 'merged' ? 'checked' : ''} /> One merged video, screens side by side ${gives(counts.merged)}</label>
            <label><input type="radio" name="m-outmode" value="both" ${remembered === 'both' ? 'checked' : ''} /> Both ${gives(counts.both)}</label>
          </div>
        </div>
        <div class="modal-foot">
          <button id="m-cancel">Cancel</button>
          <button id="m-apply" class="accent">Export</button>
        </div>
      </div>
    `);
    const done = (val) => {
      closeModal();
      if (val) localStorage.setItem('xre:outmode', val);
      resolve(val);
    };
    $('m-close').onclick = () => done(null);
    $('m-cancel').onclick = () => done(null);
    $('m-apply').onclick = () => done(document.querySelector('input[name="m-outmode"]:checked').value);
  });
}

// ---------------- test pattern ----------------
function makeTestPatternCanvas() {
  const IW = project.input.width, IH = project.input.height;
  const k = Math.min(1, 16384 / Math.max(IW, IH));
  if (k < 1) showToast('Canvas wider than 16384 px: this pattern is scaled, so its lines are not pixel-exact');
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(IW * k));
  c.height = Math.max(2, Math.round(IH * k));
  const g = c.getContext('2d');
  // Whole device pixels only: a line on x.5 would land half on two columns
  const pxRect = (r) => [Math.round(r.x * k), Math.round(r.y * k), Math.max(1, Math.round(r.w * k)), Math.max(1, Math.round(r.h * k))];
  const fillAll = (rects) => rects.forEach((r) => g.fillRect(...pxRect(r)));

  const grid = panelGridSize();
  // checker background: half a panel when the panel grid is on
  const cellW = grid ? Math.max(2, Math.round((grid.w / 2) * k)) : Math.max(10, Math.round(50 * k));
  const cellH = grid ? Math.max(2, Math.round((grid.h / 2) * k)) : cellW;
  for (let y = 0, j = 0; y < c.height; y += cellH, j++) {
    for (let x = 0, i = 0; x < c.width; x += cellW, i++) {
      g.fillStyle = (i + j) % 2 ? '#26292d' : '#33373c';
      g.fillRect(x, y, cellW, cellH);
    }
  }
  if (!grid) {
    // 100px grid, stronger every 500px
    for (let x = 0; x <= IW; x += 100) {
      g.fillStyle = x % 500 === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
      g.fillRect(Math.round(x * k), 0, 1, c.height);
    }
    for (let y = 0; y <= IH; y += 100) {
      g.fillStyle = y % 500 === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
      g.fillRect(0, Math.round(y * k), c.width, 1);
    }
  }

  const colors = ['#f7941e', '#35e0b2', '#4fa3ff', '#e85dd0', '#ffd028', '#7fe860'];
  const slices = project.screens.flatMap((scr) => Geometry.effectiveSlices(project, scr.id));
  slices.forEach((eff, n) => {
    const i = project.slices.indexOf(eff.slice);
    const col = colors[i % colors.length];
    const x = eff.crop.x * k, y = eff.crop.y * k, w = eff.crop.w * k, h = eff.crop.h * k;
    g.save();
    g.beginPath();
    g.rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    g.clip();
    if (grid) {
      g.fillStyle = 'rgba(255,255,255,0.28)';
      fillAll(Conform.panelLines(eff.crop, grid.w, grid.h));
    }
    g.strokeStyle = col;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y); g.lineTo(x + w, y + h);
    g.moveTo(x + w, y); g.lineTo(x, y + h);
    g.stroke();
    g.beginPath();
    g.arc(x + w / 2, y + h / 2, Math.max(4, Math.min(w, h) / 2 - 2), 0, Math.PI * 2);
    g.stroke();

    const marks = Conform.sliceMarkers(eff, grid ? { panelW: grid.w, panelH: grid.h } : {});
    g.fillStyle = '#000';
    fillAll(marks.bands);
    g.fillStyle = col;
    fillAll(marks.teeth);
    g.fillStyle = '#fff';
    fillAll(marks.ticks);
    g.restore();

    // label pill that always fits inside the slice
    const label = `${i + 1} · ${eff.slice.name} · ${eff.crop.w}×${eff.crop.h}`;
    const coords = Conform.coordsLabel(eff);
    let fs = Math.min(h * 0.18, 40 * Math.max(k, 0.5), w * 0.5);
    fs = Math.max(9, fs);
    const widest = (size) => {
      g.font = `bold ${size}px -apple-system, sans-serif`;
      const t1 = g.measureText(label).width;
      g.font = `bold ${size * 0.5}px -apple-system, sans-serif`;
      return Math.max(t1, g.measureText(coords).width);
    };
    while (fs > 9 && widest(fs) > w * 0.85) fs *= 0.92;
    const pw = widest(fs) + fs * 1.2, ph = fs * 2.5;
    g.fillStyle = 'rgba(8,10,12,0.82)';
    g.fillRect(x + w / 2 - pw / 2, y + h / 2 - ph / 2, pw, ph);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${fs}px -apple-system, sans-serif`;
    g.fillText(label, x + w / 2, y + h / 2 - fs * 0.35);
    g.font = `bold ${fs * 0.5}px -apple-system, sans-serif`;
    g.fillStyle = '#ffd28a';
    g.fillText(coords, x + w / 2, y + h / 2 + fs * 0.7);
  });
  return c;
}

function panelGridSize() {
  const grid = rp.panelGrid;
  return grid.on && grid.w > 0 && grid.h > 0 ? { w: grid.w, h: grid.h } : null;
}

function refreshPanelGridUI() {
  const grid = rp.panelGrid;
  $('tp-grid').checked = grid.on;
  setField('tp-grid-w', grid.w);
  setField('tp-grid-h', grid.h);
  $('tp-grid-w').disabled = !grid.on;
  $('tp-grid-h').disabled = !grid.on;
}

function setPanelGrid(on, w, h) {
  rp.panelGrid = { on: !!on, w: clampInt(w, 2, 4096), h: clampInt(h, 2, 4096) };
  refreshPanelGridUI();
  exportSettingsChanged();
}

// The rate the show will run at: the export rate, else the active clip's. The still-image
// rate only counts when there is no moving footage to go by.
function playerTestRate() {
  const f = activeFile();
  const clipRate = f && !f.isImage ? (f.probe && f.probe.fps) || (f.sequence && f.sequence.fps) : 0;
  return outputRate() || clipRate || clampInt($('r-fps').value, 1, 240);
}

// Pick the kind of test: the still pattern or the moving player test
function askTestPattern() {
  const rate = playerTestRate();
  const grid = rp.panelGrid;
  openModal(`
    <div class="modal" style="width:440px">
      <div class="modal-head"><span>Test pattern</span><button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body">
        <div class="tp-kind">
          <label><input type="radio" name="tp-kind" value="still" checked /><span>Still pattern<small>One-pixel lines and edge markers on every slice, with input and output coordinates.</small></span></label>
          <label><input type="radio" name="tp-kind" value="player" /><span>Player test (${Conform.PLAYER_TEST_SECONDS} s at ${rate} fps)<small>A moving one-pixel bar and a frame counter. A player that drops frames or tears shows it here.</small></span></label>
        </div>
        <div class="row check-row">
          <label for="m-grid">Panel grid</label>
          <input type="checkbox" id="m-grid" ${grid.on ? 'checked' : ''} />
          <input type="text" inputmode="text" id="m-grid-w" class="num" style="width:56px" value="${grid.w}" />
          <label style="min-width:auto">×</label>
          <input type="text" inputmode="text" id="m-grid-h" class="num" style="width:56px" value="${grid.h}" />
          <span class="dim">px</span>
        </div>
      </div>
      <div class="modal-foot">
        <button id="m-cancel">Cancel</button>
        <button id="m-add" class="accent">Add</button>
      </div>
    </div>
  `);
  $('m-close').onclick = closeModal;
  $('m-cancel').onclick = closeModal;
  $('m-add').onclick = () => {
    const kind = document.querySelector('input[name="tp-kind"]:checked').value;
    setPanelGrid($('m-grid').checked, $('m-grid-w').value, $('m-grid-h').value);
    closeModal();
    if (kind === 'player') addPlayerTest();
    else addTestPattern();
  };
}

async function addPlayerTest() {
  const button = $('rp-testpattern');
  button.disabled = true;
  showToast('Building player test…');
  try {
    const slices = project.screens.flatMap((scr) => Geometry.effectiveSlices(project, scr.id));
    const file = await api.makePlayerTest({
      name: sanitizeName(project.name),
      width: project.input.width,
      height: project.input.height,
      fps: playerTestRate(),
      slices,
    });
    if (page !== 'render') switchPage('render');
    await addFootage([file], { select: true });
    showToast('Player test added');
  } catch (e) {
    alert('Player test failed: ' + (e.message || e));
  } finally {
    button.disabled = false;
  }
}

async function addTestPattern() {
  try {
    const c = makeTestPatternCanvas();
    const p = await api.writeTempDataUrl(`testpattern-${sanitizeName(project.name)}.png`, c.toDataURL('image/png'));
    if (page !== 'render') switchPage('render');
    await addFootage([p], { select: true });
  } catch (e) {
    alert('Test pattern failed: ' + (e.message || e));
  }
}

async function testPatternAsReference() {
  pushHistory();
  const c = makeTestPatternCanvas();
  project.refs.input = makeRef(c.toDataURL('image/png'), 'test pattern', 0.9);
  await loadRefImage('input');
  if (view !== 'input') switchView('input');
  refreshRefPanel();
  draw();
  markDirty();
}

async function saveTestPattern() {
  const p = await api.saveDialog({
    title: 'Save test pattern PNG',
    defaultPath: `testpattern-${sanitizeName(project.name)}-${project.input.width}x${project.input.height}.png`,
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (!p) return;
  const c = makeTestPatternCanvas();
  await api.writeFileDataUrl(p, c.toDataURL('image/png'));
  api.showInFolder(p);
}

// ---------------- check frame ----------------
// The Check frame tab: the real export of this frame at 100%, a verdict per slice and a way
// to walk along every seam. The picture and the verdict both come from the main process.
const ck = {
  active: false,
  running: false,
  run: 0,
  result: null,
  img: null,
  key: null,
  zoom: 1,
  x: 0,
  y: 0,
  seam: -1,
  selected: -1,
  drag: null,
  message: '',
};

function ckScreen() {
  return project.screens.find((s) => s.id === rp.screenId) || project.screens[0];
}

// What decides the picture: when this changes, the verdict on screen is about something else
function ckKey(f) {
  return JSON.stringify([f && f.path, f && !f.isImage ? f.curTime || 0 : 0, f && f.transform, f && f.sequence && f.sequence.fps, project.input, project.slices, ckScreen().id, $('r-codec').value, $('r-alpha').value, $('r-depth').value, $('r-bitrate').value, gpuActive(), fastProresActive()]);
}

function ckSetMessage(text) {
  ck.message = text || '';
  $('ck-status').textContent = ck.message;
  $('ck-status').classList.toggle('hidden', !ck.message);
}

function refreshCheckStale() {
  if (!ck.active) return;
  const stale = !!(ck.result && !ck.running && ck.key !== ckKey(activeFile()));
  $('ck-stale').classList.toggle('hidden', !stale);
}

function enterCheck() {
  ck.active = true;
  stopPlayback(false);
  $('rp-tab-input').classList.remove('active');
  $('rp-tab-output').classList.remove('active');
  $('rp-tab-check').classList.add('active');
  rpCanvas.classList.add('ck-off');
  $('ck-wrap').classList.remove('hidden');
  $('ck-tools').classList.remove('hidden');
  refreshScreenSelectors();
  refreshCheckStale();
  if (!ck.result || ck.key !== ckKey(activeFile())) runFrameCheck();
  else drawCheck();
}

function exitCheck() {
  if (!ck.active) return;
  ck.active = false;
  $('rp-tab-check').classList.remove('active');
  rpCanvas.classList.remove('ck-off');
  $('ck-wrap').classList.add('hidden');
  $('ck-tools').classList.add('hidden');
  refreshScreenSelectors();
  resizeRenderCanvas();
}

function setPreviewTab(mode) {
  if (mode === 'check') {
    enterCheck();
    return;
  }
  rp.viewMode = mode;
  exitCheck();
  $('rp-tab-input').classList.toggle('active', mode === 'input');
  $('rp-tab-output').classList.toggle('active', mode === 'output');
  refreshScreenSelectors();
  fitRenderView();
  drawRenderPreview();
}

function loadCheckImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The checked frame could not be loaded.'));
    img.src = url;
  });
}

async function runFrameCheck() {
  const f = activeFile();
  // This check takes over: whatever an earlier one still delivers is ignored
  const run = ++ck.run;
  ck.running = false;
  ck.result = null;
  ck.img = null;
  renderCheckRows();
  drawCheck();
  refreshCheckStale();
  if (!f || f.missing) {
    ckSetMessage(f ? 'This footage is missing.' : 'Add footage first.');
    return;
  }
  const def = currentCodec();
  if (def.audioOnly) {
    ckSetMessage('An audio export has no picture to check.');
    return;
  }
  if (rp.running) {
    ckSetMessage('An export is running.');
    return;
  }
  const key = ckKey(f);
  ck.running = true;
  ckSetMessage('Rendering this frame…');
  const scr = ckScreen();
  try {
    const maskFiles = await buildMaskFiles(project, scr.id);
    if (run !== ck.run) return;
    const res = await api.checkFrame({
      project: { name: project.name, input: project.input, screens: project.screens, slices: project.slices },
      job: { src: f.path, isImage: f.isImage, sequence: f.sequence || null, transform: f.transform, screen: { id: scr.id, name: scr.name, width: scr.width, height: scr.height }, maskFiles },
      codec: def.id,
      alpha: $('r-alpha').value,
      depth: parseInt($('r-depth').value, 10),
      bitrateMbps: calcNum($('r-bitrate').value) || null,
      fps: clampInt($('r-fps').value, 1, 240),
      outFps: outputRate(),
      imageDuration: clampInt($('r-dur').value, 1, 3600),
      gpu: gpuActive(),
      fastProres: fastProresActive(),
      atSec: f.isImage ? 0 : f.curTime || 0,
    });
    if (run !== ck.run) return;
    if (res.stale) {
      // only an export can stop the current check
      ckSetMessage(rp.running ? 'An export is running.' : '');
      return;
    }
    if (res.busy) {
      ckSetMessage('An export is running.');
      return;
    }
    const url = await api.pathToFileUrl(res.image);
    const img = await loadCheckImage(url);
    if (run !== ck.run) return;
    ck.result = res;
    ck.img = img;
    ck.key = key;
    ck.seam = -1;
    ck.zoom = 1;
    ckGoToSeam();
    ckSetMessage('');
    renderCheckRows();
    drawCheck();
    refreshCheckStale();
  } catch (e) {
    if (run !== ck.run) return;
    // an export that starts ends a running check on purpose
    const why = ipcMessage(e).split('\n')[0];
    ckSetMessage(rp.running ? 'An export is running.' : `The frame could not be checked.${/^ffmpeg error/.test(why) ? '' : ` ${why}`}`);
  } finally {
    if (run === ck.run) {
      ck.running = false;
      refreshCheckStale();
    }
  }
}

function checkTagFor(row) {
  if (row.state === 'identical') return { cls: 'identical', text: '✓ Pixel-identical' };
  if (row.state === 'different') return { cls: 'different', text: `${row.different.toLocaleString('en-US')} pixel${row.different === 1 ? '' : 's'} differ` };
  if (row.state === 'scaled') return { cls: 'other', text: 'Scaled, not compared' };
  if (row.state === 'masked') return { cls: 'other', text: 'Masked, not compared' };
  if (row.state === 'covered') return { cls: 'other', text: 'Not visible, not compared' };
  return { cls: 'other', text: 'Not compared' };
}

function renderCheckRows() {
  const list = $('ck-rows');
  list.innerHTML = '';
  const res = ck.result;
  if (!res) {
    $('ck-note').textContent = '';
    return;
  }
  res.rows.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'file-row' + (i === ck.selected ? ' selected' : '');
    const text = document.createElement('span');
    text.className = 'ck-text';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = `${i + 1} · ${row.name}`;
    nm.title = row.label;
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = `${row.place.w}×${row.place.h}`;
    text.append(nm, sz);
    const tagInfo = checkTagFor(row);
    const tag = document.createElement('span');
    tag.className = `ck-tag ${tagInfo.cls}`;
    tag.textContent = tagInfo.text;
    el.append(text, tag);
    el.onclick = () => {
      ck.selected = i;
      ck.zoom = 1;
      ck.x = row.place.x + row.place.w / 2;
      ck.y = row.place.y + row.place.h / 2;
      renderCheckRows();
      drawCheck();
    };
    list.appendChild(el);
  });
  const notes = ['This frame, exported with the current settings and compared with the source, slice by slice.'];
  if (res.lossy) notes.push(`Shown after ${res.codecLabel}; the comparison is made before compression, otherwise every lossy format would read as a broken mapping.`);
  if (res.codecProblem) notes.push(res.codecProblem);
  if (res.lumaOnly) notes.push('This source shares colour between neighbouring pixels, so brightness is compared.');
  $('ck-note').textContent = notes.join(' ');
}

function ckFitZoom() {
  const cw = $('ck-canvas').width || 1, ch = $('ck-canvas').height || 1;
  if (!ck.img) return 1;
  return Math.min(1, cw / ck.img.width, ch / ck.img.height);
}

function ckGoToSeam() {
  const res = ck.result;
  if (!res) return;
  const points = res.seams.length
    ? res.seams
    : res.rows.map((row, i) => ({ x: row.place.x + row.place.w / 2, y: row.place.y + row.place.h / 2, a: i }));
  if (!points.length) return;
  ck.seam = (ck.seam + 1) % points.length;
  const p = points[ck.seam];
  ck.x = p.x;
  ck.y = p.y;
  ck.selected = p.a != null ? p.a : -1;
}

function ckNextSeam() {
  if (!ck.result) return;
  ck.zoom = 1;
  ckGoToSeam();
  renderCheckRows();
  drawCheck();
}

function drawCheck() {
  const view = $('ck-view');
  if (!view) return;
  const c = $('ck-canvas');
  const dpr = window.devicePixelRatio || 1;
  const cssW = view.clientWidth, cssH = view.clientHeight;
  if (!cssW || !cssH) return;
  c.width = Math.max(1, Math.round(cssW * dpr));
  c.height = Math.max(1, Math.round(cssH * dpr));
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#16181a';
  g.fillRect(0, 0, c.width, c.height);
  $('ck-100').classList.toggle('on', ck.zoom === 1);
  if (!ck.img) {
    $('ck-coords').classList.add('hidden');
    return;
  }
  const z = ck.zoom; // canvas (device) pixels per output pixel
  const iw = ck.img.width, ih = ck.img.height;
  const clampCenter = (v, size, half) => (size * z <= half * 2 ? size / 2 : Math.max(half / z, Math.min(size - half / z, v)));
  ck.x = clampCenter(ck.x, iw, c.width / 2);
  ck.y = clampCenter(ck.y, ih, c.height / 2);
  const dx = Math.round(c.width / 2 - ck.x * z);
  const dy = Math.round(c.height / 2 - ck.y * z);
  g.drawImage(ck.img, 0, 0, iw, ih, dx, dy, Math.round(iw * z), Math.round(ih * z));
  // the slice in the middle of the view
  const res = ck.result;
  const coords = $('ck-coords');
  const hit = res ? [...res.rows].reverse().find((r) => ck.x >= r.place.x && ck.x < r.place.x + r.place.w && ck.y >= r.place.y && ck.y < r.place.y + r.place.h) : null;
  coords.classList.toggle('hidden', !hit);
  if (hit) {
    coords.textContent = hit.label;
    coords.style.top = `${Math.min(cssH - 28, cssH / 2 + 42)}px`;
  }
}

function bindCheckView() {
  const view = $('ck-view');
  view.addEventListener('wheel', (e) => {
    if (!ck.img) return;
    e.preventDefault();
    const c = $('ck-canvas');
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cursorX = (e.clientX - rect.left) * dpr, cursorY = (e.clientY - rect.top) * dpr;
    const toImage = (cx, v, half, z) => v + (cx - half) / z;
    const atX = toImage(cursorX, ck.x, c.width / 2, ck.zoom);
    const atY = toImage(cursorY, ck.y, c.height / 2, ck.zoom);
    const next = Math.max(ckFitZoom(), Math.min(8, ck.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
    ck.zoom = Math.abs(next - 1) < 0.04 ? 1 : next;
    ck.x = atX - (cursorX - c.width / 2) / ck.zoom;
    ck.y = atY - (cursorY - c.height / 2) / ck.zoom;
    drawCheck();
  }, { passive: false });
  view.addEventListener('mousedown', (e) => {
    ck.drag = { x: e.clientX, y: e.clientY, ox: ck.x, oy: ck.y };
    view.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!ck.drag) return;
    const dpr = window.devicePixelRatio || 1;
    ck.x = ck.drag.ox - ((e.clientX - ck.drag.x) * dpr) / ck.zoom;
    ck.y = ck.drag.oy - ((e.clientY - ck.drag.y) * dpr) / ck.zoom;
    drawCheck();
  });
  window.addEventListener('mouseup', () => {
    ck.drag = null;
    view.classList.remove('grabbing');
  });
  $('ck-100').onclick = () => {
    ck.zoom = ck.zoom === 1 ? ckFitZoom() : 1;
    drawCheck();
  };
  $('ck-next').onclick = ckNextSeam;
  $('ck-again').onclick = runFrameCheck;
  new ResizeObserver(() => { if (ck.active) drawCheck(); }).observe(view);
}

// ---------------- export page ----------------
const STATUS_ICONS = {
  done: '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M7 2.2l5.2 9.4H1.8L7 2.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 6v2.6M7 10.2v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  fail: '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  run: '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-width="2"/><path d="M7 1.8a5.2 5.2 0 0 1 3.4 9.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  wait: '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 4.6V7l1.7 1.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};
const STATUS_TITLES = { done: 'Exported', warn: 'Exported with a warning', fail: 'Failed', run: 'Exporting', wait: 'Waiting' };
const TRIM_ICON = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2 3h3M2 9h3M5 3l5 6M5 9l5-6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
const rp = {
  files: [], // {path, isImage, probe, transform, frameImg, frameTime, curTime, selected, inSec, outSec}
  activeIndex: -1,
  destDir: null, // null = next to each clip
  destProblem: null, // why the chosen output folder cannot be used right now
  running: false,
  clock: null, // the running batch: see beginExportUI
  jobFiles: [],
  jobStates: [],
  cancelRequested: false,
  retryTimers: new Set(),
  viewMode: 'input',
  screenId: null,
  watchDir: null,
  watching: false,
  watchQueue: [],
  vt: { scale: 0.1, ox: 40, oy: 40 },
  preflightMode: 'separate', // output mode the size check looks at (set by the last Start)
  padAcceptedKey: null, // codec + sizes the user agreed to pad (see preflightKey)
  panelGrid: { on: false, w: 104, h: 104 }, // the optional LED panel grid of the test pattern
};
let rpCanvas, rpCtx;
let frameTimer = null;
let rpDrag = null; // clip dragging / timeline dragging
let appPaths = null; // {temp, documents}

function activeFile() {
  return rp.files[rp.activeIndex] || null;
}

function syncExportList() {
  project.exportList = rp.files.map((f) => ({
    path: f.path,
    transform: f.transform,
    inSec: f.inSec,
    outSec: f.outSec,
    selected: f.selected !== false,
    stretchOk: f.stretchOk || null,
    sequence: f.sequence || null,
  }));
  markDirty();
  refreshActiveRowLength();
  refreshPanelDots();
  scheduleEstimate();
  refreshCheckStale();
}

function loadExportListFromProject() {
  const list = project.exportList || [];
  rp.files = list.map((e) => ({
    path: e.path,
    sequence: e.sequence || null,
    isImage: !e.sequence && isImagePath(e.path),
    probe: null,
    transform: Object.assign(Geometry.defaultTransform(), e.transform || {}),
    frameImg: null,
    frameTime: 0,
    curTime: 0,
    selected: e.selected !== false,
    inSec: e.inSec != null ? e.inSec : null,
    outSec: e.outSec != null ? e.outSec : null,
    stretchOk: e.stretchOk || null,
  }));
  rp.activeIndex = rp.files.length ? 0 : -1;
  refreshFileList();
  refreshClipControls();
  updateFileStates(rp.files.slice()); // async, the list follows as results come in
  if (rp.files.length) selectFile(0);
  else {
    layoutTimeline();
    drawRenderPreview();
  }
}

// Which of these files are still there? Those that are (back) get probed. Files that went
// missing keep their trims and settings; only what came from the file itself is cleared.
async function updateFileStates(list) {
  if (!list.length) return;
  const asked = list.map((f) => f.path);
  let there;
  try {
    there = await api.filesExist(asked);
  } catch (e) {
    there = list.map(() => true); // can't tell: treat them as there, ffmpeg will report what isn't
  }
  const flipped = [], toProbe = [];
  list.forEach((f, i) => {
    if (f.path !== asked[i]) return; // relinked while we were asking: this answer is about the old path
    if (!there[i]) {
      if (!f.missing) flipped.push(f);
      f.missing = true;
      f.probe = null;
      f.frameImg = null;
    } else {
      if (f.missing !== false) toProbe.push(f);
      f.missing = false;
    }
  });
  if (flipped.length) showFileStates(flipped);
  await Promise.all(toProbe.map(async (f) => {
    try {
      f.probe = await api.previewProbe(f.path, f.sequence);
    } catch (e) {
      f.probe = null;
    }
    showFileStates([f]);
  }));
}

function showFileStates(changed) {
  refreshFileList();
  if (!changed.includes(activeFile())) return;
  refreshClipControls();
  layoutTimeline();
  fetchFrame(true);
  loadWaveform(activeFile());
  drawRenderPreview();
}

// Points one missing row at the chosen file, then finds the other missing files by name in
// that same folder. Trims and settings stay: only the path and what came from the file change.
async function locateFile(f) {
  const paths = await api.openDialog({
    title: `Locate ${baseName(f.path)}`,
    filters: [
      { name: 'Footage', extensions: [...FOOTAGE_IMAGE_EXTS, ...VIDEO_EXTS] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!paths.length) return;
  await relinkFiles(f, paths[0]);
}

async function relinkFiles(f, chosen) {
  const inList = (p) => rp.files.some((o) => o !== f && Outputs.samePath(o.path, p));
  if (inList(chosen)) {
    alert(`${baseName(chosen)} is already in the footage list.`);
    return;
  }
  const relinks = [[f, chosen]];
  const others = rp.files.filter((o) => o !== f && o.missing);
  if (others.length) {
    const { dir } = await api.pathParse(chosen);
    const found = await api.findInFolder(dir, others.map((o) => baseName(o.path)));
    // Two rows can share a name in different folders: the file goes to the first, the rest stay Missing
    const nfc = (p) => String(p).normalize('NFC');
    const claimed = [chosen];
    others.forEach((o) => {
      const p = found[baseName(o.path)];
      if (!p || inList(p) || claimed.some((c) => Outputs.samePath(nfc(c), nfc(p)))) return;
      claimed.push(p);
      relinks.push([o, p]);
    });
  }
  await Promise.all(relinks.map(async ([file, p]) => {
    file.path = p;
    if (file.sequence) file.sequence = Conform.moveSequence(file.sequence, p);
    file.isImage = !file.sequence && isImagePath(p);
    file.missing = false;
    file.frameImg = null;
    file.waveform = null;
    try {
      file.probe = await api.previewProbe(p, file.sequence);
    } catch (e) {
      file.probe = null;
    }
  }));
  syncExportList();
  refreshCodecUI();
  selectFile(Math.max(0, rp.files.indexOf(f)));
  const left = rp.files.filter((o) => o.missing).length;
  showToast(left ? `Found ${relinks.length}, ${left} still missing` : `Found ${relinks.length} file${relinks.length === 1 ? '' : 's'}`);
}

function resizeRenderCanvas() {
  if (!rpCanvas) return;
  const rect = rpCanvas.parentElement.getBoundingClientRect();
  const tlH = ($('rp-timeline') ? $('rp-timeline').offsetHeight : 46) + ($('rp-viewbar') ? $('rp-viewbar').offsetHeight : 34);
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(50, rect.width);
  const ch = Math.max(50, rect.height - tlH);
  rpCanvas.style.width = cw + 'px';
  rpCanvas.style.height = ch + 'px';
  rpCanvas.width = Math.round(cw * dpr);
  rpCanvas.height = Math.round(ch * dpr);
  rpCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fitRenderView();
  layoutTimeline();
  drawRenderPreview();
}

function rpWorld() {
  if (rp.viewMode === 'input') return { w: project.input.width, h: project.input.height };
  const sc = project.screens.find((s) => s.id === rp.screenId) || project.screens[0];
  return { w: sc.width, h: sc.height };
}

function fitRenderView() {
  const { w: cw, h: ch } = cssSize(rpCanvas);
  const { w: W, h: H } = rpWorld();
  const margin = 40;
  const scale = Math.min((cw - margin * 2) / W, (ch - margin * 2) / H);
  rp.vt.scale = Math.max(0.001, Math.min(8, scale));
  rp.vt.ox = (cw - W * rp.vt.scale) / 2;
  rp.vt.oy = (ch - H * rp.vt.scale) / 2;
}

function clipFilterString(tr, scalePx) {
  const b = tr.brightness || 0;
  const c = tr.contrast || 0;
  const s = tr.saturation != null ? tr.saturation : 1;
  const filters = [];
  if (b) filters.push(`brightness(${(1 + b).toFixed(3)})`);
  if (c) filters.push(`contrast(${(1 + c).toFixed(3)})`);
  if (s !== 1) filters.push(`saturate(${s.toFixed(3)})`);
  if (tr.hue) filters.push(`hue-rotate(${tr.hue}deg)`);
  if (tr.blur > 0) filters.push(`blur(${(tr.blur * scalePx).toFixed(2)}px)`);
  return filters.join(' ') || 'none';
}

function drawClipInto(g, f, IW, IH, k) {
  const tr = f.transform;
  const lay = Geometry.clipLayout(f.probe.width, f.probe.height, tr, IW, IH);
  g.filter = clipFilterString(tr, k);
  g.save();
  g.translate(lay.cx * k, lay.cy * k);
  g.rotate(lay.angleRad);
  g.drawImage(f.frameImg, (-lay.bw / 2) * k, (-lay.bh / 2) * k, lay.bw * k, lay.bh * k);
  g.restore();
  g.filter = 'none';
}

function buildInputComposite(f) {
  const IW = project.input.width, IH = project.input.height;
  const maxW = 2048;
  const k = Math.min(1, maxW / IW);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(IW * k));
  c.height = Math.max(2, Math.round(IH * k));
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  if (f && f.frameImg && f.probe && f.probe.width) drawClipInto(g, f, IW, IH, k);
  return { canvas: c, k };
}

function drawRenderPreview() {
  if (page !== 'render' || !rpCtx || !project) return;
  const t = rp.vt;
  const { w: cw, h: ch } = cssSize(rpCanvas);
  const { w: W, h: H } = rpWorld();

  rpCtx.clearRect(0, 0, cw, ch);
  rpCtx.fillStyle = '#121416';
  rpCtx.fillRect(0, 0, cw, ch);

  const cx = t.ox, cy = t.oy;
  const cwid = W * t.scale, chei = H * t.scale;
  const f = activeFile();

  rpCtx.save();
  rpCtx.beginPath();
  rpCtx.rect(cx, cy, cwid, chei);
  rpCtx.clip();
  drawCheckerBg(rpCtx, cx, cy, cwid, chei);

  if (rp.viewMode === 'input') {
    if (f && f.frameImg && f.probe && f.probe.width) {
      rpCtx.save();
      rpCtx.translate(t.ox, t.oy);
      const lay = Geometry.clipLayout(f.probe.width, f.probe.height, f.transform, W, H);
      rpCtx.filter = clipFilterString(f.transform, t.scale);
      rpCtx.translate(lay.cx * t.scale, lay.cy * t.scale);
      rpCtx.rotate(lay.angleRad);
      rpCtx.drawImage(f.frameImg, (-lay.bw / 2) * t.scale, (-lay.bh / 2) * t.scale, lay.bw * t.scale, lay.bh * t.scale);
      rpCtx.filter = 'none';
      rpCtx.restore();
    }
  } else {
    const scr = project.screens.find((s) => s.id === rp.screenId) || project.screens[0];
    const comp = buildInputComposite(f);
    for (const eff of Geometry.effectiveSlices(project, scr.id)) {
      drawSliceContent(rpCtx, comp.canvas, eff, { scale: t.scale, ox: t.ox, oy: t.oy }, comp.k, comp.k);
    }
  }
  rpCtx.restore();

  rpCtx.strokeStyle = '#4c5358';
  rpCtx.strokeRect(cx - 0.5, cy - 0.5, cwid + 1, chei + 1);

  if (rp.viewMode === 'input') {
    for (const sl of project.slices) {
      if (sl.enabled === false) continue;
      const r = sl.in;
      const x = r.x * t.scale + t.ox, y = r.y * t.scale + t.oy;
      rpCtx.strokeStyle = 'rgba(247,148,30,0.65)';
      rpCtx.lineWidth = 1;
      rpCtx.strokeRect(x + 0.5, y + 0.5, r.w * t.scale - 1, r.h * t.scale - 1);
      if (maskUsable(sl)) {
        rpCtx.setLineDash([4, 3]);
        rpCtx.strokeStyle = 'rgba(255,210,138,0.5)';
        rpCtx.beginPath();
        sl.mask.points.forEach((p, i) => {
          const px = p.x * t.scale + t.ox, py = p.y * t.scale + t.oy;
          if (i === 0) rpCtx.moveTo(px, py); else rpCtx.lineTo(px, py);
        });
        rpCtx.closePath();
        rpCtx.stroke();
        rpCtx.setLineDash([]);
      }
    }
  } else {
    const scr = project.screens.find((s) => s.id === rp.screenId) || project.screens[0];
    for (const sl of project.slices) {
      if (sl.enabled === false || sliceScreenId(sl) !== scr.id) continue;
      const r = sl.out;
      rpCtx.strokeStyle = 'rgba(247,148,30,0.4)';
      rpCtx.lineWidth = 1;
      rpCtx.strokeRect(r.x * t.scale + t.ox + 0.5, r.y * t.scale + t.oy + 0.5, r.w * t.scale - 1, r.h * t.scale - 1);
    }
  }

  if (!rp.files.length) {
    rpCtx.fillStyle = '#8b9195';
    rpCtx.font = '14px -apple-system, sans-serif';
    rpCtx.textAlign = 'center';
    rpCtx.fillText('Add footage to preview it on the map', cw / 2, ch / 2);
  } else if (f && f.missing) {
    rpCtx.fillStyle = '#f08a8a';
    rpCtx.font = '14px -apple-system, sans-serif';
    rpCtx.textAlign = 'center';
    rpCtx.fillText(`${baseName(f.path)} is missing. Use Locate… in the footage list.`, cw / 2, ch / 2);
  }
}

function refreshFileList() {
  const list = $('rp-files');
  if (!list) return;
  list.innerHTML = '';
  if (!rp.files.length) {
    list.innerHTML = '<div class="file-empty">Add stageview footage (image or video), or drop files here. Drag rows to reorder.</div>';
  }
  rp.files.forEach((f, i) => {
    const row = document.createElement('div');
    const edited = !Geometry.isIdentityTransform(f.transform);
    row.className = 'file-row' + (i === rp.activeIndex ? ' selected' : '') + (edited ? ' edited' : '') + (f.missing ? ' missing' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = f.selected !== false;
    cb.title = 'Include in export';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      f.selected = cb.checked;
      updateStartButton();
      refreshDestUI();
      syncExportList();
    });
    const st = document.createElement('span');
    st.className = `st ${f.exportState || ''}`;
    st.innerHTML = STATUS_ICONS[f.exportState] || '';
    st.title = STATUS_TITLES[f.exportState] || '';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.title = [f.path, f.probe && f.probe.width ? `${f.probe.width}×${f.probe.height}` : ''].filter(Boolean).join('\n');
    const [headText, tailText] = ExportPlan.splitMiddle(rowName(f));
    const head = document.createElement('span');
    head.className = 'head';
    head.textContent = headText;
    const tail = document.createElement('span');
    tail.className = 'tail';
    tail.textContent = tailText;
    nm.append(head, tail);
    const sz = document.createElement('span');
    sz.dataset.len = String(i);
    fillRowLength(sz, f);
    const stretched = footageStretch(f);
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.alt = '';
    if (f.thumb && !f.missing) thumb.src = f.thumb;
    f.thumbEl = thumb;
    row.append(cb, st, thumb, nm, sz);
    if (f.sequence) {
      row.classList.add('seq');
      row.appendChild(sequenceRateLine(f));
    }
    if (f.missing) {
      const missingTag = document.createElement('span');
      missingTag.className = 'tag missing-tag';
      missingTag.textContent = 'Missing';
      sz.replaceWith(missingTag);
      const line = document.createElement('div');
      line.className = 'locate-line';
      const btn = document.createElement('button');
      btn.textContent = 'Locate…';
      btn.title = 'Find this file. Other missing files are found in the same folder.';
      btn.onclick = (e) => {
        e.stopPropagation();
        locateFile(f);
      };
      line.appendChild(btn);
      row.appendChild(line);
    }
    row.onclick = () => selectFile(i);
    enableReorder(row, i, (from, to) => {
      const act = activeFile();
      if (moveItem(rp.files, from, to)) {
        rp.activeIndex = rp.files.indexOf(act);
        refreshFileList();
        syncExportList();
      }
    });
    list.appendChild(row);
    if (stretched) list.appendChild(footageWarnRow(f, stretched));
  });
  pumpThumbs();
  const missing = rp.files.filter((f) => f.missing).length;
  $('rp-missing-line').textContent = `${missing} file${missing === 1 ? '' : 's'} missing`;
  $('rp-missing-line').classList.toggle('hidden', !missing);
  updateStartButton();
  refreshDestUI();
  $('rp-clip-name').textContent = activeFile() ? rowName(activeFile()) : 'no selection';
  // keep the "image footage" settings row in sync with the list contents
  const anyImage = rp.files.some((f) => f.isImage);
  const def = currentCodec();
  $('r-still-row').style.display = anyImage && !def.still && !def.audioOnly ? '' : 'none';
}

// Small preview per clip, made one at a time so a long batch doesn't stall the app
let thumbsRunning = false;
async function pumpThumbs() {
  if (thumbsRunning) return;
  thumbsRunning = true;
  try {
    for (;;) {
      const f = rp.files.find((x) => !x.thumb && !x.thumbTried && !x.missing && x.probe);
      if (!f) break;
      f.thumbTried = true;
      try {
        const at = f.isImage ? 0 : Math.min(1, (fileDuration(f) || 0) / 2);
        const url = await api.previewFrame(f.path, at, f.sequence);
        const img = new Image();
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
        const c = document.createElement('canvas');
        c.width = 92;
        c.height = 52;
        const g = c.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, c.width, c.height);
        const k = Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight);
        const w = img.naturalWidth * k, h = img.naturalHeight * k;
        g.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
        f.thumb = c.toDataURL('image/jpeg', 0.8);
        if (f.thumbEl) f.thumbEl.src = f.thumb;
      } catch (e) { /* the row keeps its empty thumbnail */ }
      await new Promise((r) => setTimeout(r, 30));
    }
  } finally {
    thumbsRunning = false;
  }
}

function rowName(f) {
  return f.sequence ? `${f.sequence.label} (${f.sequence.count} frames)` : baseName(f.path);
}

function clipLabel(f) {
  return f.sequence ? f.sequence.label : baseName(f.path);
}

function clipStem(f, pathInfo) {
  return f.sequence ? f.sequence.stem : pathInfo.base;
}

// The frame rate of a numbered sequence is not in the files, so it is asked for here
function sequenceRateLine(f) {
  const line = document.createElement('div');
  line.className = 'seq-line';
  const text = document.createElement('span');
  text.textContent = 'Frame rate';
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'text';
  input.className = 'num';
  input.value = f.sequence.fps;
  input.title = 'Frames per second of this sequence';
  input.onclick = (e) => e.stopPropagation();
  input.onchange = () => setSequenceRate(f, input.value);
  input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
  const unit = document.createElement('span');
  unit.textContent = 'fps';
  line.append(text, input, unit);
  return line;
}

function setSequenceRate(f, value) {
  const fps = calcNum(value);
  if (!(fps > 0)) {
    refreshFileList();
    return;
  }
  f.sequence.fps = Math.min(240, fps);
  if (f.probe) {
    f.probe.fps = f.sequence.fps;
    f.probe.durationSec = f.sequence.count / f.sequence.fps;
  }
  f.frameImg = null;
  refreshFileList();
  syncExportList();
  refreshClipControls();
  layoutTimeline();
  fetchFrame(true);
  refreshCodecUI();
}

// The table's length cell: the trimmed length, in orange when a trim is set
function fillRowLength(sz, f) {
  sz.className = 'sz';
  if (f.isImage) {
    sz.textContent = 'still';
    return;
  }
  const full = fileDuration(f);
  const trimmed = ExportPlan.isTrimmed(f.inSec, f.outSec);
  // A sequence row carries its frame count in the name; the length only matters once trimmed
  if (!full || (f.sequence && !trimmed)) {
    sz.textContent = '';
    return;
  }
  sz.textContent = ExportPlan.formatClock(ExportPlan.trimmedSeconds(full, f.inSec, f.outSec));
  sz.classList.toggle('trimmed', trimmed);
  sz.title = trimmed ? `Trimmed from ${ExportPlan.formatClock(full)}: in ${ExportPlan.formatClock(f.inSec || 0)}, out ${ExportPlan.formatClock(f.outSec != null ? f.outSec : full)}` : '';
  if (trimmed) sz.insertAdjacentHTML('afterbegin', TRIM_ICON);
}

function refreshActiveRowLength() {
  const f = activeFile();
  const sz = f && document.querySelector(`#rp-files .sz[data-len="${rp.activeIndex}"]`);
  if (sz) fillRowLength(sz, f);
}

// null, or the footage and canvas sizes when this file would be resized to the canvas
function footageStretch(f) {
  if (!MapCheck.footageStretched(f.probe, project.input, f.transform)) return null;
  const key = `${f.probe.width}x${f.probe.height}>${project.input.width}x${project.input.height}`;
  return { key, accepted: f.stretchOk === key, footage: `${f.probe.width}×${f.probe.height}`, canvas: `${project.input.width}×${project.input.height}` };
}

function useFootageAsCanvas(f) {
  pushHistory();
  project.input = { width: f.probe.width, height: f.probe.height };
  refreshAll();
  fitView('input');
  fitRenderView();
  refreshPixelCheck();
  drawRenderPreview();
  markDirty();
}

function footageWarnRow(f, st) {
  const box = document.createElement('div');
  if (st.accepted) {
    box.className = 'file-warn preflight accepted';
    const text = document.createElement('span');
    text.textContent = `Stretched to the ${st.canvas} canvas.`;
    const undo = document.createElement('button');
    undo.textContent = 'Undo';
    undo.onclick = () => {
      f.stretchOk = null;
      refreshFileList();
      syncExportList();
    };
    box.append(text, undo);
    return box;
  }
  box.className = 'file-warn preflight';
  const text = document.createElement('div');
  text.textContent = `${st.footage} footage on a ${st.canvas} canvas: it will be resized, so every pixel changes.`;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const useBtn = document.createElement('button');
  useBtn.textContent = 'Use footage size as canvas';
  useBtn.onclick = () => useFootageAsCanvas(f);
  const stretchBtn = document.createElement('button');
  stretchBtn.textContent = 'Stretch anyway';
  stretchBtn.onclick = () => {
    f.stretchOk = st.key;
    refreshFileList();
    syncExportList();
  };
  actions.append(useBtn, stretchBtn);
  box.append(text, actions);
  return box;
}

// Asked at Start for footage nobody has decided about: 'canvas', 'stretch' or null (stay here)
function askFootageStretch(list, files) {
  return new Promise((resolve) => {
    // offered only when no file in this export ends up resized by the new canvas,
    // including files that match the current canvas or were already accepted on it
    const canvasOk = MapCheck.canvasFitsAll(files, list[0].f.probe);
    const n = list.length;
    openModal(`
      <div class="modal" style="width:480px">
        <div class="modal-head"><span id="m-title"></span><button class="close-x" id="m-close">✕</button></div>
        <div class="modal-body">
          <div class="note" id="m-note"></div>
          <div class="exists-list" id="m-list"></div>
        </div>
        <div class="modal-foot">
          <button id="m-cancel">Cancel</button>
          <button id="m-stretch">Stretch anyway</button>
          ${canvasOk ? '<button id="m-canvas" class="accent">Use footage size as canvas</button>' : ''}
        </div>
      </div>
    `);
    $('m-title').textContent = `${n} file${n === 1 ? ' does' : 's do'} not match the canvas`;
    $('m-note').textContent = `The input canvas is ${list[0].st.canvas}. Footage of another size is resized to it, so every pixel changes.${canvasOk ? '' : ' The selected files differ in size, so no single canvas fits them all.'}`;
    list.forEach(({ f, st }) => {
      const row = document.createElement('div');
      row.textContent = `${baseName(f.path)} (${st.footage})`;
      row.title = f.path;
      $('m-list').appendChild(row);
    });
    const done = (val) => {
      closeModal();
      resolve(val);
    };
    $('m-close').onclick = () => done(null);
    $('m-cancel').onclick = () => done(null);
    $('m-stretch').onclick = () => done('stretch');
    if (canvasOk) {
      $('m-canvas').onclick = () => done('canvas');
      $('m-canvas').focus();
    }
  });
}

// Runs at Start, after the output mode is known. false = the export is called off.
// Unattended exports cannot be asked, so what they carry on with ends up in the log.
async function checkBeforeExport(files, isAuto, notes) {
  const unsure = files.map((f) => ({ f, st: footageStretch(f) })).filter((x) => x.st && !x.st.accepted);
  if (unsure.length && isAuto) {
    unsure.forEach(({ f, st }) => notes.push(`${baseName(f.path)}: ${st.footage} footage resized to the ${st.canvas} canvas.`));
  } else if (unsure.length) {
    const choice = await askFootageStretch(unsure, files);
    if (!choice) return false;
    if (choice === 'canvas') {
      useFootageAsCanvas(unsure[0].f);
    } else {
      unsure.forEach(({ f, st }) => { f.stretchOk = st.key; });
      refreshFileList();
      syncExportList();
    }
  }

  const check = currentMapCheck();
  if (!check.problems) return true;
  const lines = [...check.outside, ...check.overlaps].map((p) => p.message);
  if (isAuto) {
    lines.forEach((l) => notes.push(`Mapping: ${l}.`));
    return true;
  }
  const answer = await askMappingProblems(check);
  if (answer === 'fix') {
    switchPage('editor');
    goToProblem([...check.outside, ...check.overlaps][0]);
    return false;
  }
  if (answer !== 'go') return false;
  notes.push(`Exported with ${check.problems} mapping problem${check.problems === 1 ? '' : 's'}: ${lines.join('; ')}.`);
  return true;
}

function updateStartButton() {
  const ticked = rp.files.filter((f) => f.selected !== false);
  const skipped = ticked.filter((f) => f.missing).length;
  const state = ExportPlan.startState({ total: rp.files.length, ticked: ticked.length, missing: skipped, running: rp.running, destProblem: rp.destProblem });
  $('r-start').disabled = state.disabled;
  $('r-start').textContent = state.label;
  $('r-start').title = state.reason;
  $('r-start-why').textContent = state.reason;
  $('r-start-why').classList.toggle('hidden', !state.reason);
  $('r-missing-note').textContent = `${skipped} missing file${skipped === 1 ? '' : 's'} will be skipped`;
  $('r-missing-note').classList.toggle('hidden', !skipped);
}

// items: file paths, or {path, sequence} for a numbered image sequence
async function addFootage(items, opts) {
  let firstNew = -1;
  for (const item of items) {
    const p = typeof item === 'string' ? item : item.path;
    const sequence = typeof item === 'string' ? null : item.sequence;
    if (rp.files.some((f) => f.path === p)) continue;
    const f = {
      path: p,
      sequence,
      isImage: !sequence && isImagePath(p),
      probe: null,
      transform: Geometry.defaultTransform(),
      frameImg: null,
      frameTime: 0,
      curTime: 0,
      selected: true,
      inSec: null,
      outSec: null,
      missing: false,
    };
    if (firstNew < 0) firstNew = rp.files.length;
    rp.files.push(f);
    try {
      f.probe = await api.previewProbe(p, sequence);
    } catch (e) {
      f.probe = null;
    }
  }
  syncExportList();
  if ((rp.activeIndex < 0 || (opts && opts.select)) && firstNew >= 0) {
    selectFile(firstNew);
  } else {
    refreshFileList();
  }
  refreshCodecUI();
}

// Files, numbered frames and folders: numbered frames become one sequence clip
async function addScanned(paths, opts) {
  const scan = await api.scanFootage(paths, [...FOOTAGE_IMAGE_EXTS, ...VIDEO_EXTS], !!(opts && opts.anyFile));
  const rate = outputRate() || 25;
  const items = [
    ...scan.sequences.map((s) => ({ path: s.first, sequence: { pattern: s.pattern, start: s.start, count: s.count, fps: rate, label: s.label, stem: s.stem } })),
    ...scan.rest,
  ];
  if (items.length) await addFootage(items, opts);
  if (scan.gaps) showToast(`Frame numbers have gaps: ${ExportPlan.plural(items.length, 'clip')} added`);
}

function selectFile(i) {
  stopPlayback(false);
  rp.activeIndex = i;
  const f = activeFile();
  refreshFileList();
  refreshClipControls();
  openEditedPanels();
  layoutTimeline();
  if (f) {
    fetchFrame(true);
    loadWaveform(f);
  }
  drawRenderPreview();
}

// ---------------- timeline (trim UI) ----------------
function fileDuration(f) {
  return f && f.probe && f.probe.durationSec ? f.probe.durationSec : 0;
}

function layoutTimeline() {
  const f = activeFile();
  const track = $('tl-track');
  if (!track) return;
  const dur = fileDuration(f);
  const usable = f && !f.isImage && dur > 0.01;
  track.classList.toggle('disabled', !usable);
  ['rp-set-in', 'rp-set-out', 'rp-clear-trim'].forEach((id) => ($(id).disabled = !usable));
  const w = track.getBoundingClientRect().width || 1;
  const px = (sec) => Math.max(0, Math.min(1, dur ? sec / dur : 0)) * w;
  const inSec = usable && f.inSec != null ? f.inSec : 0;
  const outSec = usable && f.outSec != null ? f.outSec : dur;
  $('tl-in-h').style.left = px(inSec) + 'px';
  $('tl-out-h').style.left = px(outSec) + 'px';
  $('tl-sel').style.left = px(inSec) + 'px';
  $('tl-sel').style.width = Math.max(0, px(outSec) - px(inSec)) + 'px';
  $('tl-play').style.left = px(usable ? (f.curTime || 0) : 0) + 'px';
  $('tl-in-h').style.display = usable ? '' : 'none';
  $('tl-out-h').style.display = usable ? '' : 'none';
  $('tl-play').style.display = usable ? '' : 'none';
  $('tl-sel').style.display = usable ? '' : 'none';
  $('tl-cur').textContent = fmtTC(usable ? f.curTime || 0 : 0);
  updatePlayBtn();
  refreshCheckStale();
  if (usable) {
    const trimmed = (f.inSec != null || f.outSec != null);
    $('tl-len').textContent = trimmed
      ? `${fmtTC(inSec)} → ${fmtTC(outSec)} · ${(outSec - inSec).toFixed(2)}s of ${dur.toFixed(2)}s`
      : `length ${dur.toFixed(2)}s`;
  } else {
    $('tl-len').textContent = f && f.isImage ? 'still image' : '—';
  }
  ['tl-in-n', 'tl-out-n'].forEach((id) => ($(id).disabled = !usable));
  if (document.activeElement !== $('tl-in-n')) $('tl-in-n').value = usable && f.inSec != null ? f.inSec.toFixed(2) : '';
  if (document.activeElement !== $('tl-out-n')) $('tl-out-n').value = usable && f.outSec != null ? f.outSec.toFixed(2) : '';
  drawWaveform();
}

function drawWaveform() {
  const f = activeFile();
  const wc = $('tl-wave');
  if (!wc) return;
  const track = $('tl-track');
  const r = track.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  wc.width = Math.max(2, Math.round(r.width * dpr));
  wc.height = Math.max(2, Math.round(r.height * dpr));
  const g = wc.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  if (!f || f.isImage || !f.waveform || !f.waveform.length) return;
  const n = f.waveform.length;
  const mid = r.height / 2;
  g.fillStyle = 'rgba(90, 150, 230, 0.55)';
  const bw = r.width / n;
  for (let i = 0; i < n; i++) {
    const h = Math.max(1, f.waveform[i] * (r.height - 4));
    g.fillRect(i * bw, mid - h / 2, Math.max(1, bw - 0.5), h);
  }
}

function loadWaveform(f) {
  if (!f || f.isImage || f.missing !== false || f.waveform || f.waveLoading) return;
  if (f.probe && f.probe.hasAudio === false) return;
  f.waveLoading = true;
  api.previewWaveform(f.path).then((peaks) => {
    f.waveLoading = false;
    if (peaks && peaks.length) {
      f.waveform = peaks;
      if (activeFile() === f) drawWaveform();
    }
  }).catch(() => {
    f.waveLoading = false;
  });
}

function timelineSecFromEvent(e) {
  const f = activeFile();
  const track = $('tl-track');
  const r = track.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  return frac * fileDuration(f);
}

function bindTimeline() {
  const track = $('tl-track');
  const onSeek = (e) => {
    const f = activeFile();
    if (!f || f.isImage || !fileDuration(f)) return;
    f.curTime = timelineSecFromEvent(e);
    if (rp.playing && videoOkForPath === f.path) {
      try { rpVideo.currentTime = f.curTime; } catch (err) { /* seek */ }
    }
    layoutTimeline();
    fetchFrame(false);
  };
  $('tl-in-h').addEventListener('mousedown', (e) => {
    e.stopPropagation();
    rpDrag = { mode: 'tl-in' };
  });
  $('tl-out-h').addEventListener('mousedown', (e) => {
    e.stopPropagation();
    rpDrag = { mode: 'tl-out' };
  });
  track.addEventListener('mousedown', (e) => {
    rpDrag = { mode: 'tl-seek' };
    onSeek(e);
  });
  window.addEventListener('mousemove', (e) => {
    if (!rpDrag || !rpDrag.mode.startsWith('tl-')) return;
    const f = activeFile();
    if (!f) return;
    const dur = fileDuration(f);
    if (!dur) return;
    const sec = timelineSecFromEvent(e);
    if (rpDrag.mode === 'tl-seek') {
      onSeek(e);
    } else if (rpDrag.mode === 'tl-in') {
      f.inSec = Math.max(0, Math.min(sec, (f.outSec != null ? f.outSec : dur) - 0.05));
      layoutTimeline();
    } else if (rpDrag.mode === 'tl-out') {
      f.outSec = Math.min(dur, Math.max(sec, (f.inSec != null ? f.inSec : 0) + 0.05));
      layoutTimeline();
    }
  });
  window.addEventListener('mouseup', () => {
    if (rpDrag && (rpDrag.mode === 'tl-in' || rpDrag.mode === 'tl-out')) syncExportList();
    if (rpDrag && rpDrag.mode.startsWith('tl-')) rpDrag = null;
  });
}

function fetchFrame(immediate) {
  const f = activeFile();
  if (!f) return;
  if (f.missing !== false) { // gone, or not checked yet: the preview says so / the check fetches it
    drawRenderPreview();
    return;
  }
  if (rp.playing) return; // playback drives the preview
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = setTimeout(async () => {
    const time = f.isImage ? 0 : f.curTime || 0;
    try {
      const dataUrl = await api.previewFrame(f.path, time, f.sequence);
      const img = new Image();
      img.onload = () => {
        f.frameImg = img;
        f.frameTime = time;
        drawRenderPreview();
      };
      img.src = dataUrl;
    } catch (e) {
      f.frameImg = null;
      drawRenderPreview();
    }
  }, immediate ? 0 : 180);
}

// ---------------- preview playback (play/pause) ----------------
// Chromium-decodable footage (H.264/HEVC/VP9…) plays natively via a <video> element,
// smooth and with audio. Other codecs (ProRes/DXV/HAP) fall back to stepping
// ffmpeg-extracted frames at a lower rate.
let rpVideo = null;
let playRAF = null;
let playFallbackTimer = null;
let videoOkForPath = null; // path that loaded successfully in the <video> element
let lastPlayDraw = 0;

function updatePlayBtn() {
  const f = activeFile();
  const btn = $('rp-play');
  btn.innerHTML = icon(rp.playing ? 'pause' : 'play');
  btn.disabled = !f || f.isImage || !fileDuration(f);
}

// Codecs Chromium can actually decode in a <video> element. Everything else
// (ProRes, DXV, HAP, MJPEG, ...) is played by stepping ffmpeg-extracted frames —
// loading those into <video> gives a black picture or crashes the media stack.
const BROWSER_CODECS = new Set(['h264', 'avc1', 'hevc', 'hvc1', 'vp8', 'vp9', 'av1', 'theora']);
function isBrowserPlayable(f) {
  const vc = f && f.probe && f.probe.videoCodec ? f.probe.videoCodec.toLowerCase() : '';
  return BROWSER_CODECS.has(vc);
}

function loadNativeVideo(p) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      cleanup();
      // even after canplay, an undecodable track reports videoWidth 0
      if (ok && rpVideo.videoWidth > 0) resolve();
      else reject(new Error('codec not supported by preview player'));
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    const cleanup = () => {
      rpVideo.removeEventListener('loadeddata', onOk);
      rpVideo.removeEventListener('error', onErr);
      clearTimeout(to);
    };
    const to = setTimeout(() => finish(false), 4000);
    rpVideo.addEventListener('loadeddata', onOk);
    rpVideo.addEventListener('error', onErr);
    api.pathToFileUrl(p).then((url) => {
      rpVideo.src = url;
      rpVideo.load();
    }).catch(onErr);
  });
}

async function startPlayback() {
  const f = activeFile();
  if (!f || f.isImage) return;
  const dur = fileDuration(f);
  if (!dur) return;
  const inP = f.inSec != null ? f.inSec : 0;
  const outP = f.outSec != null ? f.outSec : dur;
  let startT = f.curTime || inP;
  if (startT >= outP - 0.05 || startT < inP) startT = inP;

  // decide native vs ffmpeg-fallback from the probed codec (reliable) — only *try*
  // the <video> element for codecs Chromium can decode.
  if (videoOkForPath !== f.path && videoOkForPath !== 'FAIL:' + f.path) {
    if (isBrowserPlayable(f)) {
      try {
        await loadNativeVideo(f.path);
        videoOkForPath = f.path;
      } catch (e) {
        videoOkForPath = 'FAIL:' + f.path;
      }
    } else {
      videoOkForPath = 'FAIL:' + f.path; // ProRes / DXV / HAP → ffmpeg frames
    }
  }
  rp.playing = true;
  updatePlayBtn();

  if (videoOkForPath === f.path) {
    // native, smooth playback (with audio) — interval instead of rAF so it also
    // runs when the window is hidden/minimized
    rpVideo.muted = rp.previewMuted !== false; // default muted: keeps the clock running
    $('rp-mute').innerHTML = icon(rpVideo.muted ? 'mute' : 'sound');
    rpVideo.currentTime = startT;
    rpVideo.play().catch(() => {});
    // watchdog: if the clock doesn't advance (broken decoder), fall back to ffmpeg stepping
    setTimeout(() => {
      if (rp.playing && videoOkForPath === f.path && rpVideo.currentTime <= startT + 0.05) {
        videoOkForPath = 'FAIL:' + f.path;
        stopPlayback(false);
        startPlayback();
      }
    }, 900);
    let lastT = -1;
    let lastChange = performance.now();
    playRAF = setInterval(() => {
      if (!rp.playing) return;
      const f2 = activeFile();
      if (!f2 || f2.path !== f.path) { stopPlayback(false); return; }
      // clock-stall safety net (e.g. after unmuting on a machine without working audio out)
      if (rpVideo.currentTime !== lastT) {
        lastT = rpVideo.currentTime;
        lastChange = performance.now();
      } else if (performance.now() - lastChange > 1200 && !rpVideo.muted) {
        rpVideo.muted = true;
        rp.previewMuted = true;
        $('rp-mute').innerHTML = icon('mute');
      }
      f.curTime = rpVideo.currentTime;
      const end = f.outSec != null ? f.outSec : fileDuration(f);
      if (rpVideo.ended || rpVideo.currentTime >= end - 0.02) {
        rpVideo.currentTime = f.inSec != null ? f.inSec : 0; // loop within trim
      }
      f.frameImg = rpVideo; // drawImage accepts a <video> element directly
      layoutTimeline();
      drawRenderPreview();
    }, 33);
  } else {
    // fallback: step ffmpeg frames (ProRes/DXV/HAP sources) — lower fps but real content
    f.curTime = startT;
    let last = performance.now();
    const step = async () => {
      if (!rp.playing) return;
      const now = performance.now();
      f.curTime = (f.curTime || 0) + (now - last) / 1000;
      last = now;
      const end = f.outSec != null ? f.outSec : fileDuration(f);
      if (f.curTime >= end) f.curTime = f.inSec != null ? f.inSec : 0;
      try {
        const dataUrl = await api.previewFrame(f.path, f.curTime, f.sequence);
        if (!rp.playing) return;
        const img = new Image();
        img.onload = () => {
          if (!rp.playing) return;
          f.frameImg = img;
          layoutTimeline();
          drawRenderPreview();
          playFallbackTimer = setTimeout(step, 20);
        };
        img.src = dataUrl;
      } catch (e) {
        playFallbackTimer = setTimeout(step, 250);
      }
    };
    step();
  }
}

function stopPlayback(fetchStill = true) {
  const wasPlaying = rp.playing;
  rp.playing = false;
  updatePlayBtn();
  if (playRAF) { clearInterval(playRAF); playRAF = null; }
  if (playFallbackTimer) { clearTimeout(playFallbackTimer); playFallbackTimer = null; }
  try { rpVideo.pause(); } catch (e) { /* not loaded */ }
  const f = activeFile();
  if (f && f.frameImg === rpVideo) f.frameImg = null;
  if (wasPlaying && fetchStill) fetchFrame(true); // pixel-accurate still at the pause point
  layoutTimeline();
}

function togglePlayback() {
  if (rp.playing) stopPlayback();
  else startPlayback();
}

// ---------------- clip controls ----------------
function prettyCodec(probe) {
  if (!probe || !probe.videoCodec) return '?';
  const v = probe.videoCodec;
  const variants = { apco: 'ProRes Proxy', apcs: 'ProRes LT', apcn: 'ProRes 422', apch: 'ProRes HQ', ap4h: 'ProRes 4444', ap4x: 'ProRes 4444 XQ' };
  if (v === 'prores') return variants[probe.proresVariant] || 'ProRes';
  return v.toUpperCase();
}

function refreshClipInfo() {
  const f = activeFile();
  const el = $('ct-info');
  if (f && f.missing) {
    el.style.display = '';
    el.textContent = `File missing: ${f.path}`;
    return;
  }
  if (!f || !f.probe) {
    el.textContent = f ? 'probing…' : '';
    el.style.display = f ? '' : 'none';
    return;
  }
  el.style.display = '';
  const pr = f.probe;
  const rows = [];
  rows.push(`${pr.width || '?'}×${pr.height || '?'} px · ${prettyCodec(pr)}${pr.pixFmt ? ` (${pr.pixFmt})` : ''}`);
  if (!f.isImage) {
    const parts = [];
    if (pr.durationSec) parts.push(`${pr.durationSec.toFixed(2)} s`);
    if (pr.fps) parts.push(`${pr.fps} fps`);
    if (pr.bitrateKbps) parts.push(`${(pr.bitrateKbps / 1000).toFixed(1)} Mbps`);
    parts.push(pr.hasAudio ? `audio ✓${pr.audioLayout ? ` (${pr.audioLayout}${pr.audioBits >= 24 ? ', 24-bit' : ''})` : ''}` : 'no audio');
    if (pr.timecode) parts.push(`TC ${pr.timecode}`);
    rows.push(parts.join(' · '));
  }
  el.innerHTML = rows.join('<br>');
}

// Pixel check card: what the export will really do to this clip, from the same plan buildArgs uses
const PX_CHECK_ICON = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2.5 7.6l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PX_WARN_ICON = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M7 2.2l5.2 9.4H1.8L7 2.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 6v2.6M7 10.2v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

let pxOpenChoice = null; // null: follows the check; otherwise what the user clicked
let pxHadWarning = false;

function refreshPixelCheck() {
  const card = $('rp-pixel-check');
  const f = activeFile();
  const def = currentCodec();
  if (!f || !f.probe || !def || def.audioOnly) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const slices = Geometry.effectiveSlices(project);
  const alpha = $('r-alpha').value !== 'none' && def.alpha.includes($('r-alpha').value);
  const plan = Codecs.pixelPlan(slices, f.probe, { alpha, transform: f.transform });
  const fps = outputRate() || (f.isImage ? clampInt($('r-fps').value, 1, 240) : f.probe.fps || 25);
  const rows = Codecs.pixelCheckRows(plan, def.id, fps, f.isImage);
  $('px-rows').innerHTML = rows
    .map((r) => `<div class="px-row${r.ok ? '' : ' warn'}">${r.ok ? PX_CHECK_ICON : PX_WARN_ICON}<span class="k">${r.key}</span><span class="v">${r.value}</span></div>`)
    .join('');
  $('px-note').textContent = Codecs.codecFidelityNote(def.id);
  const warns = rows.filter((r) => !r.ok).length;
  // Opens by itself as soon as something needs attention, whatever was chosen before
  if ((warns > 0) !== pxHadWarning) {
    pxHadWarning = warns > 0;
    pxOpenChoice = null;
  }
  const open = pxOpenChoice === null ? warns > 0 : pxOpenChoice;
  card.classList.toggle('warn', warns > 0);
  $('px-icon').innerHTML = warns ? PX_WARN_ICON : PX_CHECK_ICON;
  $('px-title').textContent = warns ? `Pixel check: ${warns} ${warns === 1 ? 'point' : 'points'} to review` : 'Pixel check: all clear';
  $('px-details').classList.toggle('hidden', !open);
  $('px-summary').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function scaleLinked(tr) {
  return tr.scaleY == null;
}

function refreshClipControls() {
  const f = activeFile();
  const tr = f ? f.transform : Geometry.defaultTransform();
  $('rp-clip-section').style.opacity = f ? 1 : 0.4;
  $('rp-color-section').style.opacity = f ? 1 : 0.4;
  refreshPanelDots();
  refreshClipInfo();
  refreshPixelCheck();
  $('ct-mode').value = tr.mode;
  $('ct-x').value = tr.x;
  $('ct-y').value = tr.y;
  $('ct-scale').value = tr.scale;
  $('ct-scale-n').value = tr.scale;
  const linked = scaleLinked(tr);
  $('ct-link').classList.toggle('active', linked);
  $('ct-scale-label').textContent = linked ? 'Scale' : 'Scale W';
  $('ct-scaley-row').classList.toggle('hidden', linked);
  $('ct-scaley').value = tr.scaleY != null ? tr.scaleY : tr.scale;
  $('ct-scaley-n').value = tr.scaleY != null ? tr.scaleY : tr.scale;
  $('ct-rot').value = tr.rotation;
  $('ct-rot-n').value = tr.rotation;
  $('ct-bright').value = Math.round(tr.brightness * 100);
  $('ct-bright-v').textContent = Math.round(tr.brightness * 100);
  $('ct-contrast').value = Math.round(tr.contrast * 100);
  $('ct-contrast-v').textContent = Math.round(tr.contrast * 100);
  $('ct-sat').value = Math.round(tr.saturation * 100);
  $('ct-sat-v').textContent = tr.saturation.toFixed(2);
  $('ct-hue').value = tr.hue;
  $('ct-hue-v').textContent = tr.hue + '°';
  $('ct-blur').value = tr.blur;
  $('ct-blur-v').textContent = tr.blur;
  refreshPixelReadout();
}

function refreshPixelReadout() {
  const f = activeFile();
  const el = $('ct-pixels');
  if (!f || !f.probe || !f.probe.width) {
    el.textContent = '';
    if (document.activeElement !== $('ct-px-w')) $('ct-px-w').value = '';
    if (document.activeElement !== $('ct-px-h')) $('ct-px-h').value = '';
    return;
  }
  const lay = Geometry.clipLayout(f.probe.width, f.probe.height, f.transform, project.input.width, project.input.height);
  el.textContent = `on canvas ${project.input.width}×${project.input.height}`;
  if (document.activeElement !== $('ct-px-w')) $('ct-px-w').value = Math.round(lay.bw);
  if (document.activeElement !== $('ct-px-h')) $('ct-px-h').value = Math.round(lay.bh);
}

// base (unscaled) clip size for the current fit mode — used to convert px <-> scale%
function clipBaseSize(f) {
  return Geometry.clipLayout(
    f.probe.width, f.probe.height,
    { mode: f.transform.mode, scale: 100, scaleY: 100, rotation: 0 },
    project.input.width, project.input.height
  );
}

function bindClipControls() {
  const upd = (fn) => {
    const f = activeFile();
    if (!f) return;
    fn(f.transform);
    refreshFileList();
    refreshPixelReadout();
    refreshPixelCheck();
    drawRenderPreview();
    syncExportList();
  };
  $('ct-mode').onchange = () => upd((t) => (t.mode = $('ct-mode').value));
  $('ct-x').onchange = () => upd((t) => { t.x = clampInt($('ct-x').value, -100000, 100000); $('ct-x').value = t.x; });
  $('ct-y').onchange = () => upd((t) => { t.y = clampInt($('ct-y').value, -100000, 100000); $('ct-y').value = t.y; });
  $('ct-scale').oninput = () => { $('ct-scale-n').value = $('ct-scale').value; upd((t) => (t.scale = parseFloat($('ct-scale').value))); };
  $('ct-scale-n').onchange = () => { const v = Math.max(1, Math.round((calcNum($('ct-scale-n').value) || 100) * 100) / 100); $('ct-scale-n').value = v; $('ct-scale').value = v; upd((t) => (t.scale = v)); };
  $('ct-scaley').oninput = () => { $('ct-scaley-n').value = $('ct-scaley').value; upd((t) => (t.scaleY = parseFloat($('ct-scaley').value))); };
  $('ct-scaley-n').onchange = () => { const v = Math.max(1, Math.round((calcNum($('ct-scaley-n').value) || 100) * 100) / 100); $('ct-scaley-n').value = v; $('ct-scaley').value = v; upd((t) => (t.scaleY = v)); };
  // type exact pixel size
  $('ct-px-w').onchange = () => {
    const f = activeFile();
    if (!f || !f.probe || !f.probe.width) return;
    const wanted = Math.max(1, Math.round(calcNum($('ct-px-w').value)) || 0);
    const base = clipBaseSize(f);
    f.transform.scale = Math.max(1, Math.round((wanted / base.bw) * 10000) / 100);
    refreshClipControls();
    refreshFileList();
    drawRenderPreview();
    syncExportList();
  };
  $('ct-px-h').onchange = () => {
    const f = activeFile();
    if (!f || !f.probe || !f.probe.width) return;
    const wanted = Math.max(1, Math.round(calcNum($('ct-px-h').value)) || 0);
    const base = clipBaseSize(f);
    const pct = Math.max(1, Math.round((wanted / base.bh) * 10000) / 100);
    if (scaleLinked(f.transform)) {
      f.transform.scaleY = pct; // auto-unlink so width stays as-is
    } else {
      f.transform.scaleY = pct;
    }
    refreshClipControls();
    refreshFileList();
    drawRenderPreview();
    syncExportList();
  };
  $('ct-link').onclick = () => {
    const f = activeFile();
    if (!f) return;
    const tr = f.transform;
    if (scaleLinked(tr)) {
      tr.scaleY = tr.scale; // unlink
    } else {
      tr.scaleY = null; // link back
    }
    refreshClipControls();
    drawRenderPreview();
    syncExportList();
  };
  $('ct-rot').oninput = () => { $('ct-rot-n').value = $('ct-rot').value; upd((t) => (t.rotation = parseFloat($('ct-rot').value))); };
  $('ct-rot-n').onchange = () => { const v = Math.round((calcNum($('ct-rot-n').value) || 0) * 100) / 100; $('ct-rot-n').value = v; $('ct-rot').value = v; upd((t) => (t.rotation = v)); };
  $('ct-bright').oninput = () => { $('ct-bright-v').textContent = $('ct-bright').value; upd((t) => (t.brightness = parseInt($('ct-bright').value, 10) / 100)); };
  $('ct-contrast').oninput = () => { $('ct-contrast-v').textContent = $('ct-contrast').value; upd((t) => (t.contrast = parseInt($('ct-contrast').value, 10) / 100)); };
  $('ct-sat').oninput = () => { const v = parseInt($('ct-sat').value, 10) / 100; $('ct-sat-v').textContent = v.toFixed(2); upd((t) => (t.saturation = v)); };
  $('ct-hue').oninput = () => { $('ct-hue-v').textContent = $('ct-hue').value + '°'; upd((t) => (t.hue = parseInt($('ct-hue').value, 10))); };
  $('ct-blur').oninput = () => { $('ct-blur-v').textContent = $('ct-blur').value; upd((t) => (t.blur = parseInt($('ct-blur').value, 10))); };
  $('ct-reset').onclick = () => {
    const f = activeFile();
    if (!f) return;
    f.transform = Geometry.defaultTransform();
    refreshClipControls();
    refreshFileList();
    drawRenderPreview();
    syncExportList();
  };
  $('ct-apply-all').onclick = () => {
    const f = activeFile();
    if (!f) return;
    rp.files.forEach((o) => {
      if (o !== f) o.transform = JSON.parse(JSON.stringify(f.transform));
    });
    refreshFileList();
    syncExportList();
  };
}

// drag the clip on the preview canvas (input view), with snapping
function bindPreviewDrag() {
  rpCanvas.addEventListener('mousedown', (e) => {
    if (rp.viewMode !== 'input') return;
    const f = activeFile();
    if (!f || !f.probe || !f.probe.width || !f.frameImg) return;
    const t = rp.vt;
    const W = project.input.width, H = project.input.height;
    const lay = Geometry.clipLayout(f.probe.width, f.probe.height, f.transform, W, H);
    const x0 = t.ox + lay.x * t.scale;
    const y0 = t.oy + lay.y * t.scale;
    const x1 = x0 + lay.rw * t.scale;
    const y1 = y0 + lay.rh * t.scale;
    if (e.offsetX < x0 || e.offsetX > x1 || e.offsetY < y0 || e.offsetY > y1) return;
    rpDrag = {
      mode: 'clip',
      startX: e.clientX,
      startY: e.clientY,
      origX: f.transform.x || 0,
      origY: f.transform.y || 0,
      rw: lay.rw,
      rh: lay.rh,
    };
    rpCanvas.style.cursor = 'move';
  });
  window.addEventListener('mousemove', (e) => {
    if (!rpDrag || rpDrag.mode !== 'clip') return;
    const f = activeFile();
    if (!f) return;
    const t = rp.vt;
    const W = project.input.width, H = project.input.height;
    let nx = rpDrag.origX + (e.clientX - rpDrag.startX) / t.scale;
    let ny = rpDrag.origY + (e.clientY - rpDrag.startY) / t.scale;
    // snap: clip edges/center to canvas edges/center
    const thr = 8 / t.scale;
    const cx = W / 2 + nx, cy = H / 2 + ny;
    const left = cx - rpDrag.rw / 2, right = cx + rpDrag.rw / 2;
    const top = cy - rpDrag.rh / 2, bottom = cy + rpDrag.rh / 2;
    const xSnaps = [
      { d: 0 - left }, { d: W - right }, { d: W / 2 - cx },
    ];
    const ySnaps = [
      { d: 0 - top }, { d: H - bottom }, { d: H / 2 - cy },
    ];
    let bx = null;
    for (const sN of xSnaps) if (Math.abs(sN.d) <= thr && (bx === null || Math.abs(sN.d) < Math.abs(bx))) bx = sN.d;
    let by = null;
    for (const sN of ySnaps) if (Math.abs(sN.d) <= thr && (by === null || Math.abs(sN.d) < Math.abs(by))) by = sN.d;
    if (bx !== null) nx += bx;
    if (by !== null) ny += by;
    f.transform.x = Math.round(nx);
    f.transform.y = Math.round(ny);
    $('ct-x').value = f.transform.x;
    $('ct-y').value = f.transform.y;
    drawRenderPreview();
  });
  window.addEventListener('mouseup', () => {
    if (rpDrag && rpDrag.mode === 'clip') {
      rpDrag = null;
      rpCanvas.style.cursor = 'default';
      refreshFileList();
      refreshPixelReadout();
      syncExportList();
    }
  });
}

// ---------------- codec UI ----------------
function buildCodecSelect() {
  const sel = $('r-codec');
  const prev = sel.value;
  const groups = {};
  for (const c of Codecs.CODECS) {
    (groups[c.group] = groups[c.group] || []).push(c);
  }
  sel.innerHTML = Object.entries(groups)
    .map(
      ([g, list]) =>
        `<optgroup label="${g}">` +
        list
          .map((c) => {
            const rt = runtimeUnsupported(c);
            return `<option value="${c.id}" ${c.unsupported || rt ? 'disabled' : ''}>${c.label}${c.unsupported || rt ? ' — n/a' : ''}</option>`;
          })
          .join('') +
        '</optgroup>'
    )
    .join('');
  const usable = (id) => {
    const c = Codecs.byId(id);
    return !!c && !c.unsupported && !runtimeUnsupported(c);
  };
  sel.value = prev && usable(prev) ? prev : ExportPlan.defaultCodec(usable);
  if (!sel.value) sel.value = 'prores_hq';
  refreshTargets();
}

function runtimeUnsupported(c) {
  if (!caps) return false;
  if (c.id === 'dxv' && !caps.hasDxv) return true;
  if ((c.id === 'hap' || c.id === 'hap_q' || c.needsHap) && !caps.hasHap) return true;
  if (c.id === 'hevc' && !caps.hasX265) return true;
  return false;
}

function currentCodec() {
  return Codecs.byId($('r-codec').value) || Codecs.byId('prores_hq');
}

function refreshCodecUI() {
  const def = currentCodec();
  const alphaSel = $('r-alpha');
  [...alphaSel.options].forEach((o) => {
    o.disabled = o.value !== 'none' && !def.alpha.includes(o.value);
  });
  if (alphaSel.selectedOptions[0] && alphaSel.selectedOptions[0].disabled) alphaSel.value = 'none';
  alphaSel.disabled = !def.alpha.length;
  const depthSel = $('r-depth');
  [...depthSel.options].forEach((o) => {
    o.disabled = !def.depths.includes(parseInt(o.value, 10));
  });
  if (depthSel.selectedOptions[0] && depthSel.selectedOptions[0].disabled) depthSel.value = String(def.depths[0]);
  depthSel.disabled = def.depths.length <= 1;
  $('r-bitrate-row').style.display = def.bitrate ? '' : 'none';
  refreshEncoderOptions(def);
  const notes = [];
  if (fastProresActive()) notes.push('Fast ProRes is not tested in every player yet: try a clip in Resolume and your player before the show.');
  if (def.unsupported) notes.push(def.unsupported);
  if (def.note) notes.push(def.note);
  if (def.id === 'dxv') notes.push('DXT1 — plays natively in Resolume.');
  if (def.sequence) notes.push('Frames are written into a new folder per export.');
  if (def.still) notes.push('One remapped frame at the current preview time — ideal for PowerPoint.');
  if (def.id === 'prores_4444' && $('r-alpha').value !== 'none') notes.push('Alpha requires footage with an alpha channel.');
  if (def.audioOnly) notes.push('Extracts the audio track as WAV — no video is rendered. Uses the in/out trim.');
  const af = activeFile();
  if (!def.audioOnly && !def.still && !def.sequence && af && af.probe && af.probe.hasAudio) {
    if ($('r-alpha').value === 'only') notes.push('The audio is not kept in an alpha-only export.');
    else notes.push(`Audio passthrough: ${af.probe.audioLayout || 'source'} (${af.probe.audioChannels || '?'} ch) as ${af.probe.audioBits >= 24 ? '24-bit ' : ''}PCM${def.ext === 'mp4' ? '/AAC' : ''}.`);
  }
  if (def.sequence && af && af.probe && af.probe.hasAudio) notes.push('A PNG sequence cannot hold sound; the audio is not kept.');
  if (def.sequence && af && af.probe && af.probe.timecode) notes.push(`Timecode ${af.probe.timecode} cannot be stored in a PNG sequence.`);
  const rateChoice = outputRate();
  if (!def.still && !def.audioOnly && rateChoice && af && !af.isImage && af.probe && af.probe.fps) {
    const rateWarning = Codecs.rateNote(af.probe.fps, rateChoice);
    if (rateWarning) notes.push(rateWarning);
  }
  $('r-rate-row').style.display = def.still || def.audioOnly ? 'none' : '';
  $('r-fps').disabled = !!rateChoice;
  $('r-fps').title = rateChoice ? 'Set by Output rate' : '';
  if (!def.audioOnly) notes.push(...autoPadNotes());
  $('r-codec-note').textContent = notes.join(' ');
  refreshTargets();
  refreshDestUI();
  refreshPixelCheck();
  renderPreflight();
  // still settings apply when image footage is exported to a video codec
  const anyImage = rp.files.some((f) => f.isImage);
  $('r-still-row').style.display = anyImage && !def.still && !def.audioOnly ? '' : 'none';
  updateStartButton();
  scheduleEstimate();
  refreshCheckStale();
}

// The chosen output frame rate, or null for the source's own
function outputRate() {
  const v = $('r-rate').value;
  return v === 'source' ? null : parseInt(v, 10);
}

function gpuActive() {
  return !$('r-gpu').disabled && $('r-gpu').checked;
}

function fastProresActive() {
  return !$('r-fast-prores').disabled && $('r-fast-prores').checked;
}

// The graphics card row and the Fast ProRes row follow the chosen codec and what was
// really tested on this machine; a hardware encoder that did not pass is never offered.
function refreshEncoderOptions(def) {
  const depth = parseInt($('r-depth').value, 10);
  const box = $('r-gpu');
  const label = $('r-gpu-label');
  const note = $('r-gpu-note');
  const tag = $('r-gpu-tag');
  const found = gpuEncoders && gpuEncoders.label;
  const enc = gpuEncoders ? Codecs.gpuFor(gpuEncoders, def.id, depth) : null;
  box.disabled = !enc;
  tag.hidden = !enc;
  $('r-gpu-row').classList.toggle('off', !enc);
  if (!gpuEncoders) {
    label.textContent = 'Graphics card: checking…';
    note.textContent = '';
  } else if (!found) {
    label.textContent = 'Graphics card: none found';
    note.textContent = 'No graphics encoder passed the test export on this computer, so the processor does the work.';
  } else {
    label.textContent = `Graphics card: ${enc ? enc.label : found}`;
    if (enc) {
      note.textContent = {
        qsv: 'Up to 4x faster for H.264 and HEVC',
        nvenc: 'Faster for H.264 and HEVC',
        amf: 'Faster for H.264 and HEVC',
        videotoolbox: "Uses the Mac's hardware encoder for ProRes, HEVC and H.264",
      }[enc.family];
      if (def.id === 'h264' && enc.family === 'qsv') note.textContent += '. A little softer than the processor on H.264, so the choice is yours.';
    } else if (def.id === 'hevc') {
      note.textContent = `HEVC ${depth}-bit stays on the processor on this computer.`;
    } else {
      note.textContent = `${found} works with ${gpuEncoders.family === 'videotoolbox' ? 'ProRes, HEVC and H.264' : 'H.264 and HEVC'}; this codec stays on the processor.`;
    }
  }
  const fast = $('r-fast-prores');
  const fastOk = Codecs.fastProresCapable(def.id) && !!(caps && caps.fastProres) && !(enc && gpuActive());
  fast.disabled = !fastOk;
  $('r-fast-row').classList.toggle('off', !fastOk);
  $('r-fast-hint').hidden = fastOk;
  $('r-fast-hint').textContent = !Codecs.fastProresCapable(def.id)
    ? (def.group === 'ProRes' ? 'Not for 4444' : 'ProRes only')
    : enc && gpuActive() ? 'Graphics card is on' : 'Not available';
}

async function sameAsSource() {
  const f = activeFile() || rp.files.find((x) => x.selected !== false);
  if (!f) {
    alert('Add footage first.');
    return;
  }
  const m = Codecs.matchSource(f.probe);
  const def = Codecs.byId(m.codec);
  if (def && !def.unsupported && !runtimeUnsupported(def)) {
    $('r-codec').value = m.codec;
  }
  refreshCodecUI();
  if (Codecs.byId($('r-codec').value).depths.includes(m.depth)) $('r-depth').value = String(m.depth);
  if (m.alpha !== 'none' && Codecs.byId($('r-codec').value).alpha.includes(m.alpha)) $('r-alpha').value = m.alpha;
  $('r-bitrate').value = m.bitrateMbps || '';
  refreshCodecUI();
  const padNotes = Codecs.byId($('r-codec').value).audioOnly ? [] : autoPadNotes();
  $('r-codec-note').textContent = [m.note, ...padNotes].join(' ');
  exportSettingsChanged();
}

// ---------------- plays back on ----------------
function buildTargetCards() {
  const host = $('r-targets');
  host.innerHTML = '';
  ExportPlan.TARGETS.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'target';
    b.dataset.codec = t.codec;
    const title = document.createElement('b');
    title.textContent = t.title;
    const chip = document.createElement('span');
    chip.className = 'codec';
    chip.textContent = t.chip;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = t.hint;
    b.append(title, chip, hint);
    b.onclick = () => {
      $('r-codec').value = t.codec;
      refreshCodecUI();
      exportSettingsChanged();
    };
    host.appendChild(b);
  });
}

// The cards follow the codec; a codec picked under Advanced that has no card is named instead
function refreshTargets() {
  const host = $('r-targets');
  if (!host || !host.children.length) return;
  const id = $('r-codec').value;
  [...host.children].forEach((b) => {
    const def = Codecs.byId(b.dataset.codec);
    const unavailable = !!(def && (def.unsupported || runtimeUnsupported(def)));
    b.disabled = unavailable;
    b.title = unavailable ? 'Not available in this ffmpeg build.' : '';
    b.classList.toggle('selected', b.dataset.codec === id);
  });
  const custom = $('r-target-custom');
  const def = Codecs.byId(id);
  custom.classList.toggle('hidden', !!ExportPlan.targetForCodec(id));
  custom.textContent = def ? `Set under Advanced: ${def.label}` : '';
}

// ---------------- export settings (kept in the project) ----------------
function captureExportSettings() {
  return {
    codec: $('r-codec').value,
    alpha: $('r-alpha').value,
    depth: parseInt($('r-depth').value, 10),
    bitrate: $('r-bitrate').value,
    fps: clampInt($('r-fps').value, 1, 240),
    dur: clampInt($('r-dur').value, 1, 3600),
    rate: $('r-rate').value,
    panelGrid: rp.panelGrid,
    destDir: rp.destDir,
  };
}

function lastUsedSettings() {
  if (DEMO_MODE) return {};
  try {
    return JSON.parse(localStorage.getItem('xre:exportdefaults')) || {};
  } catch (e) {
    return {};
  }
}

// Called for changes the user makes; loading a project never counts as one
function exportSettingsChanged() {
  project.exportSettings = captureExportSettings();
  if (!DEMO_MODE) {
    try {
      localStorage.setItem('xre:exportdefaults', JSON.stringify(project.exportSettings));
    } catch (e) { /* the next change tries again */ }
  }
  markDirty();
  refreshDestUI();
  updateStartButton();
  scheduleEstimate();
}

function applyProjectExportSettings() {
  const s = ExportPlan.resolveSettings(project.exportSettings, lastUsedSettings());
  const def = s.codec ? Codecs.byId(s.codec) : null;
  if (def && !def.unsupported && !runtimeUnsupported(def)) $('r-codec').value = s.codec;
  refreshCodecUI();
  if (s.alpha) $('r-alpha').value = s.alpha;
  if (s.depth) $('r-depth').value = String(s.depth);
  if (s.bitrate !== undefined) $('r-bitrate').value = s.bitrate;
  if (s.fps) $('r-fps').value = String(s.fps);
  if (s.dur) $('r-dur').value = String(s.dur);
  $('r-rate').value = s.rate || 'source';
  rp.panelGrid = s.panelGrid || { on: false, w: 104, h: 104 };
  refreshPanelGridUI();
  rp.destDir = s.destDir || null;
  rp.destProblem = null;
  rp.destFromProject = s.folderFromProject;
  refreshCodecUI();
  updateWatchConflict();
  checkDestFolder();
}

function setDestDir(dir) {
  rp.destDir = dir;
  rp.destProblem = null;
  rp.destFromProject = true;
  updateWatchConflict();
  exportSettingsChanged();
  checkDestFolder();
}

// A saved folder can be on a drive that is not connected. A folder the project asks for then
// holds up Start, so nothing lands somewhere else without notice; a remembered default from
// another project simply falls back to next to the footage.
let destCheck = 0;
async function checkDestFolder() {
  const dir = rp.destDir;
  const ticket = ++destCheck;
  if (!dir) {
    setDestProblem(null);
    return;
  }
  let info;
  try {
    [info] = await api.outputFolders([dir]);
  } catch (e) {
    return; // can't tell: the export itself checks the folder again
  }
  if (ticket !== destCheck || rp.destDir !== dir) return;
  if (info.problem && !rp.destFromProject) {
    rp.destDir = null;
    refreshDestUI();
    updateWatchConflict();
    scheduleEstimate();
    return;
  }
  setDestProblem(info.problem);
}

function setDestProblem(problem) {
  rp.destProblem = problem || null;
  refreshDestUI();
  updateStartButton();
}

function outputFolderFor(f) {
  return ExportPlan.outputFolder(f.path, rp.destDir, appPaths);
}

// One folder for what is ticked, or null when the clips go to several
function shownOutputFolder() {
  if (rp.destDir) return rp.destDir;
  const dirs = new Set(rp.files.filter((f) => f.selected !== false && !f.missing).map(outputFolderFor));
  if (dirs.size === 1) return [...dirs][0];
  const f = activeFile();
  return f ? outputFolderFor(f) : null;
}

function refreshDestUI() {
  const box = $('r-dest');
  if (!box) return;
  const ticked = rp.files.filter((f) => f.selected !== false && !f.missing);
  const dirs = new Set(ticked.map(outputFolderFor));
  box.textContent = rp.destDir || (dirs.size === 1 ? [...dirs][0] : ticked.length ? 'Next to each clip (several folders)' : 'Next to each clip');
  $('r-dest-same').classList.toggle('chosen', !rp.destDir);
  $('r-dest-same').title = rp.destDir ? 'Export next to the source clips' : 'Exports go next to the source clips';
  $('r-dest-open').disabled = !!rp.destProblem || !shownOutputFolder();
  const warn = $('r-dest-warn');
  const inTemp = !rp.destDir && ticked.some((f) => ExportPlan.outputFolder(f.path, null, appPaths) !== ExportPlan.folderOf(f.path));
  warn.textContent = rp.destProblem ? rp.destProblem : inTemp ? 'Clips from the Temp folder (test patterns) are saved in Documents.' : '';
  warn.classList.toggle('hidden', !warn.textContent);
  warn.style.color = rp.destProblem ? '' : 'var(--dim)';
  refreshOutputName();
}

function refreshOutputName() {
  const line = $('r-outname');
  const f = activeFile();
  const def = currentCodec();
  if (!f || !project) {
    line.classList.add('hidden');
    return;
  }
  const alpha = $('r-alpha').value;
  const targets = def.audioOnly ? [] : exportSizeTargets(rp.preflightMode);
  let name;
  if (def.audioOnly) {
    name = `${ExportPlan.stemOf(baseName(f.path))}_audio_${$('r-depth').value}bit.wav`;
  } else {
    const t = targets[0];
    const fit = Codecs.fitOutputSize(def.id, t.width, t.height, gpuSizeOpt());
    const suffix = project.screens.length > 1 ? `_${sanitizeName(t.name)}` : '';
    const stem = ExportPlan.outputStem(f.sequence ? f.sequence.stem : ExportPlan.stemOf(baseName(f.path)), def.id, alpha, fit.width, fit.height, suffix);
    name = def.sequence ? `${stem}_seq` : `${stem}.${def.ext}`;
  }
  const more = targets.length > 1 ? `, plus ${ExportPlan.plural(targets.length - 1, 'other')}` : '';
  line.textContent = `${name}${more}`;
  line.classList.remove('hidden');
}

// ---------------- folded panels ----------------
function panelOpenState() {
  try {
    return JSON.parse(localStorage.getItem('xre:panels')) || {};
  } catch (e) {
    return {};
  }
}

function setPanelOpen(name, open, dontRemember) {
  document.querySelector(`[data-acc="${name}"]`).setAttribute('aria-expanded', open ? 'true' : 'false');
  document.querySelector(`[data-acc-body="${name}"]`).classList.toggle('hidden', !open);
  if (dontRemember) return;
  try {
    const state = panelOpenState();
    state[name] = open;
    localStorage.setItem('xre:panels', JSON.stringify(state));
  } catch (e) { /* only a convenience */ }
}

function panelEdits(f) {
  if (!f) return { clip: false, color: false };
  const d = Geometry.defaultTransform();
  const color = ['brightness', 'contrast', 'saturation', 'hue', 'blur'];
  const differs = (k) => (f.transform[k] == null ? d[k] != null : f.transform[k] !== d[k]);
  return {
    clip: Object.keys(d).filter((k) => !color.includes(k)).some(differs),
    color: color.some(differs),
  };
}

function refreshPanelDots() {
  const edits = panelEdits(activeFile());
  $('acc-dot-clip').classList.toggle('hidden', !edits.clip);
  $('acc-dot-color').classList.toggle('hidden', !edits.color);
}

// A clip with changes opens the section that holds them, so they cannot go unnoticed
function openEditedPanels() {
  const edits = panelEdits(activeFile());
  if (edits.clip) setPanelOpen('clip', true, true);
  if (edits.color) setPanelOpen('color', true, true);
}

// ---------------- size estimate ----------------
const estimateCache = new Map(); // sampleKey -> {bytes, frames, pixels} | null, per session
let estimateTimer = null;
let estimateRun = 0;

function scheduleEstimate() {
  if (estimateTimer) clearTimeout(estimateTimer);
  estimateTimer = setTimeout(refreshEstimate, 500);
}

function sampleKey(def, f, atSec, target) {
  return JSON.stringify([
    def.id, $('r-alpha').value, $('r-depth').value, $('r-bitrate').value,
    gpuActive(), fastProresActive(), f.path, atSec, target,
    ProjectDoc.hashText(ProjectDoc.stableStringify([project.input, project.slices, f.transform])),
  ]);
}

async function refreshEstimate() {
  const line = $('r-estimate');
  if (!line || !project) return;
  if (page !== 'render' || rp.running) return; // an export is using the processor
  const run = ++estimateRun;
  const stale = () => run !== estimateRun;
  const clips = rp.files.filter((f) => f.selected !== false && !f.missing && (f.isImage || f.probe));
  if (!clips.length) {
    line.textContent = '';
    line.className = 'estimate';
    return;
  }
  const def = currentCodec();
  const imageDuration = clampInt($('r-dur').value, 1, 3600);
  const imageFps = clampInt($('r-fps').value, 1, 240);
  const depth = parseInt($('r-depth').value, 10);
  const seconds = (f) => (f.isImage ? imageDuration : ExportPlan.trimmedSeconds(fileDuration(f), f.inSec, f.outSec));
  const chosenRate = outputRate();
  const clipPlan = clips.map((f) => {
    const s = seconds(f);
    const frames = def.still && !def.sequence ? 1 : s * (chosenRate || (f.isImage ? imageFps : (f.probe && f.probe.fps) || 25));
    return { frames, audioBytes: ExportPlan.audioBytes(def, f.probe, f.isImage ? 0 : s, depth) };
  });
  const targets = def.audioOnly ? [{ width: 1, height: 1 }] : exportSizeTargets(rp.preflightMode).map((t) => ({ width: t.width, height: t.height }));
  let perOutput;
  if (def.audioOnly) {
    perOutput = { bytes: 1, frames: 1, pixels: 1 };
    clipPlan.forEach((c) => { c.frames = 0; });
  } else {
    const f = clips.includes(activeFile()) ? activeFile() : clips[0];
    const atSec = f.isImage ? 0 : (f.inSec > 0 ? f.inSec : 0) + seconds(f) / 2;
    const scr = project.screens[0];
    const key = sampleKey(def, f, atSec, [scr.width, scr.height]);
    if (estimateCache.has(key)) {
      perOutput = estimateCache.get(key);
    } else {
      line.textContent = 'Estimating size…';
      line.className = 'estimate';
      try {
        perOutput = await api.estimateSample({
          project: { name: project.name, input: project.input, screens: project.screens, slices: project.slices },
          job: { src: f.path, isImage: f.isImage, sequence: f.sequence || null, transform: f.transform, screen: { id: scr.id, name: scr.name, width: scr.width, height: scr.height } },
          codec: def.id,
          alpha: $('r-alpha').value,
          depth,
          bitrateMbps: calcNum($('r-bitrate').value) || null,
          fps: imageFps,
          outFps: chosenRate,
          imageDuration,
          gpu: gpuActive(),
          fastProres: fastProresActive(),
          atSec,
        });
      } catch (e) {
        perOutput = null;
      }
      if (stale()) return;
      if (perOutput) estimateCache.set(key, perOutput); // a failed sample may work next time
    }
  }
  const total = ExportPlan.estimateBytes(perOutput, clipPlan, targets);
  if (total == null) {
    line.textContent = '';
    line.className = 'estimate';
    return;
  }

  // Bytes per destination folder: "next to each clip" can mean several disks
  const perDir = new Map();
  clips.forEach((f, i) => {
    const dir = outputFolderFor(f);
    const one = ExportPlan.estimateBytes(perOutput, [clipPlan[i]], targets) || 0;
    perDir.set(dir, (perDir.get(dir) || 0) + one);
  });
  let folders = [];
  try {
    folders = await api.outputFolders([...perDir.keys()]);
  } catch (e) { /* free space stays unknown */ }
  if (stale()) return;
  const volume = ExportPlan.tightestVolume(ExportPlan.bytesPerVolume(folders, perDir).filter((v) => v.freeBytes != null));
  line.textContent = ExportPlan.spaceLine(total, volume, Outputs.formatSize);
  line.title = `Estimate from a short test encode of this clip, for ${ExportPlan.plural(clips.length, 'clip')}.`;
  line.className = `estimate${volume && volume.level !== 'ok' ? ` ${volume.level}` : ''}`;
}

// ---------------- pre-export size check ----------------
function gpuSizeOpt() {
  return { gpu: gpuActive() };
}

function mergedSize() {
  return {
    width: project.screens.reduce((sum, sc) => sum + sc.width, 0),
    height: Math.max(...project.screens.map((sc) => sc.height)),
  };
}

// Canvases one export would write, for an output mode (separate / merged / both)
function exportSizeTargets(mode) {
  const m = project.screens.length > 1 ? mode : 'separate';
  const list = [];
  if (m !== 'merged') project.screens.forEach((sc) => list.push({ name: sc.name, width: sc.width, height: sc.height }));
  if (m !== 'separate') list.push({ name: 'Merged', ...mergedSize() });
  return list;
}

function sizeProblems(mode) {
  const def = currentCodec();
  if (def.audioOnly) return [];
  return exportSizeTargets(mode)
    .map((t) => ({ target: t, problem: Codecs.sizeProblem(def.id, t.width, t.height, gpuSizeOpt()) }))
    .filter((x) => x.problem);
}

const preflightKey = (problems) => `${currentCodec().id}|${problems.map((x) => `${x.problem.reqW}x${x.problem.reqH}`).join(',')}`;

function preflightBlocked(mode) {
  const problems = sizeProblems(mode);
  return problems.length > 0 && rp.padAcceptedKey !== preflightKey(problems);
}

// Automatic padding (codecs that need even sizes) is listed in the codec notes
function autoPadNotes() {
  const def = currentCodec();
  if (Codecs.sizeRule(def.id, gpuSizeOpt()).strict) return [];
  const notes = [];
  for (const t of exportSizeTargets(rp.preflightMode)) {
    const fit = Codecs.fitOutputSize(def.id, t.width, t.height, gpuSizeOpt());
    if (fit.padded) notes.push(`${def.label} needs ${fit.rule.modH > 1 ? 'even sizes' : 'an even width'}: ${t.name} is written as ${fit.width}×${fit.height} (black added on the right and bottom), not ${fit.reqW}×${fit.reqH}.`);
  }
  return notes;
}

function renderPreflight() {
  const box = $('r-preflight');
  const problems = sizeProblems(rp.preflightMode);
  box.classList.toggle('hidden', !problems.length);
  box.classList.remove('flash');
  if (!problems.length) {
    box.innerHTML = '';
    return;
  }
  const many = problems.length > 1;
  const accepted = rp.padAcceptedKey === preflightKey(problems);
  box.innerHTML = '';
  const text = document.createElement('div');
  text.textContent = accepted
    ? `Black is added on the right and bottom: ${problems.map((x) => `${many ? x.target.name + ' ' : ''}${x.problem.width}×${x.problem.height}`).join(', ')}.`
    : problems.map((x) => `${x.problem.message}${many ? ` (${x.target.name})` : ''}`).join('; ');
  box.appendChild(text);
  const actions = document.createElement('div');
  actions.className = 'actions';
  const addBtn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    actions.appendChild(b);
  };
  if (accepted) {
    addBtn('Undo', () => {
      rp.padAcceptedKey = null;
      renderPreflight();
    });
  } else {
    addBtn(many ? 'Pad to next multiple of 4' : `Pad to ${problems[0].problem.width}×${problems[0].problem.height}`, () => {
      rp.padAcceptedKey = preflightKey(sizeProblems(rp.preflightMode));
      renderPreflight();
    });
    addBtn('Other codec', () => {
      setPanelOpen('advanced', true);
      const sel = $('r-codec');
      sel.scrollIntoView({ block: 'center' });
      sel.focus();
      try { sel.showPicker(); } catch (e) { /* focus is enough */ }
    });
  }
  box.appendChild(actions);
}

function flashPreflight() {
  const box = $('r-preflight');
  box.classList.remove('flash');
  void box.offsetWidth; // restart the animation
  box.classList.add('flash');
  box.scrollIntoView({ block: 'nearest' });
}

// ---------------- rasterized polygon masks ----------------
async function buildMaskFiles(proj, screenId) {
  const out = {};
  for (const eff of Geometry.effectiveSlices(proj, screenId)) {
    if (!eff.polyMask) continue;
    const s = eff.slice;
    const poly = Geometry.maskPolyInPlace(s, eff);
    if (!poly) continue;
    const c = document.createElement('canvas');
    c.width = Math.max(2, eff.place.w);
    c.height = Math.max(2, eff.place.h);
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff';
    g.beginPath();
    poly.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
    g.closePath();
    g.fill();
    out[s.id] = await api.writeTempDataUrl(`mask-${sanitizeName(s.name)}-${s.id}.png`, c.toDataURL('image/png'));
  }
  return out;
}

// merged project: all screens side by side on one canvas
function buildMergedProject() {
  let offX = 0;
  let H = 0;
  for (const sc of project.screens) H = Math.max(H, sc.height);
  const slices = [];
  for (const sc of project.screens) {
    for (const s of project.slices) {
      if (sliceScreenId(s) !== sc.id) continue;
      const c = JSON.parse(JSON.stringify(s));
      c.out.x += offX;
      c.screenId = 'merged';
      slices.push(c);
    }
    offX += sc.width;
  }
  return {
    name: project.name + ' (merged)',
    input: JSON.parse(JSON.stringify(project.input)),
    screens: [{ id: 'merged', name: 'Merged', width: offX, height: H }],
    slices,
  };
}

// ---------------- start export ----------------
// Marked busy before the first await, so a second start (a watch file, a double click) can't slip in
async function startRender(filesOverride, optsOverride) {
  if (rp.running) return;
  rp.running = true;
  updateStartButton();
  refreshUpdateNotice();
  try {
    await runExport(filesOverride, optsOverride);
  } finally {
    rp.running = false;
    updateStartButton();
    refreshUpdateNotice();
    $('rp-add').disabled = false;
    api.setTaskbarProgress(-1);
    processWatchQueue();
    // The export stopped or refused the check; the tab would keep saying an export is running
    if (ck.active && !ck.result) runFrameCheck();
  }
}

// Decides what happens with outputs that already exist; null means the export is called off
async function resolveExisting(jobs, isAuto) {
  if (isAuto) return { jobs, policy: 'version', skipped: [] };
  const found = await api.outputsExisting(jobs.map((j) => j.outDir || j.outPath));
  if (!found.length) return { jobs, policy: 'overwrite', skipped: [] };
  const choice = await askExisting(found.map(baseName), found.length < jobs.length);
  if (!choice) return null;
  if (choice !== 'skip') return { jobs, policy: choice, skipped: [] };
  const hit = new Set(found);
  const isHit = (j) => hit.has(j.outDir || j.outPath);
  return { jobs: jobs.filter((j) => !isHit(j)), policy: 'overwrite', skipped: jobs.filter(isHit) };
}

function logSkipped(skipped) {
  for (const j of skipped) logNote(`Skipped ${baseName(j.outDir || j.outPath)}: it already exists.`);
}

async function runExport(filesOverride, optsOverride) {
  stopPlayback(false);
  const chosen = filesOverride || rp.files.filter((f) => f.selected !== false);
  if (!chosen.length) return;
  await updateFileStates(chosen); // a file can have gone since the last look
  const files = chosen.filter((f) => !f.missing);
  const startNotes = chosen.filter((f) => f.missing).map((f) => `Skipped ${baseName(f.path)}: the file is missing.`);
  if (!files.length) {
    if (filesOverride) startNotes.forEach(logNote);
    else alert('The selected footage is missing. Use Locate… in the footage list first.');
    return;
  }
  const codecId = $('r-codec').value;
  const def = Codecs.byId(codecId);
  const alpha = $('r-alpha').value;
  const depth = parseInt($('r-depth').value, 10);
  const bitrateMbps = calcNum($('r-bitrate').value) || null;
  const fps = clampInt($('r-fps').value, 1, 240);
  const imageDuration = clampInt($('r-dur').value, 1, 3600);
  const gpu = gpuActive();
  const fastProres = fastProresActive();

  // audio-only export: one WAV per (video) file, no screens/mapping involved
  if (def.audioOnly) {
    const audioFiles = files.filter((f) => !f.isImage && (!f.probe || f.probe.hasAudio !== false));
    if (!audioFiles.length) {
      alert('No selected video footage with audio to extract.');
      return;
    }
    const wavJobs = [];
    for (const f of audioFiles) {
      const pp = await api.pathParse(f.path);
      const dest = outputFolderFor(f);
      wavJobs.push({
        sequence: null,
        src: f.path,
        isImage: false,
        outPath: await api.pathJoin(dest, `${pp.base}_audio_${depth}bit.wav`),
        inSec: f.inSec,
        outSec: f.outSec,
        label: `${baseName(f.path)} → WAV`,
      });
    }
    const wavPlan = await resolveExisting(wavJobs, !!filesOverride);
    if (!wavPlan) return;
    beginExportUI(wavPlan.jobs);
    startNotes.forEach(logNote);
    logSkipped(wavPlan.skipped);
    try {
      const wavResults = await api.renderStart({ project: { name: project.name, input: project.input, screens: project.screens, slices: project.slices }, jobs: wavPlan.jobs, codec: codecId, depth, fps, imageDuration, existingPolicy: wavPlan.policy });
      if (filesOverride) scheduleAutoRetries(filesOverride, wavResults);
    } catch (err) {
      failExportUI(err, wavPlan.jobs.length);
    }
    return;
  }

  // multiple screens: separate / merged / both
  let outMode = 'separate';
  if (project.screens.length > 1) {
    outMode = (optsOverride && optsOverride.mode) || (await askOutputMode(files.length));
    if (!outMode) return;
  }

  // HAP family refuses sizes that aren't multiples of 4: don't start until that is decided
  rp.preflightMode = outMode;
  refreshCodecUI(); // the notes and notice follow the output mode just chosen
  if (preflightBlocked(outMode)) {
    flashPreflight();
    if (filesOverride) {
      for (const f of filesOverride) {
        addErrorRow(baseName(f.path), `${sizeProblems(outMode)[0].problem.message}. Auto export skipped this file.`, null);
      }
    }
    return;
  }

  if (!(await checkBeforeExport(files, !!filesOverride, startNotes))) return;

  const jobs = await ExportPlan.buildJobs({
    project,
    merged: outMode === 'merged' || outMode === 'both' ? buildMergedProject() : null,
    outMode,
    files,
    codecId,
    codecDef: def,
    alpha,
    padAccepted: rp.padAcceptedKey != null,
  }, {
    fitSize: (screen) => Codecs.fitOutputSize(codecId, screen.width, screen.height, { gpu }),
    maskFilesFor: buildMaskFiles,
    pathParse: api.pathParse,
    pathJoin: api.pathJoin,
    folderFor: outputFolderFor,
    stemFor: clipStem,
    labelFor: clipLabel,
    sanitizeName,
  });

  const plan = await resolveExisting(jobs, !!filesOverride);
  if (!plan) return;
  beginExportUI(plan.jobs);
  startNotes.forEach(logNote);
  logSkipped(plan.skipped);

  const payload = {
    project: {
      name: project.name,
      input: project.input,
      screens: project.screens,
      slices: project.slices,
    },
    jobs: plan.jobs,
    codec: codecId,
    alpha,
    depth,
    bitrateMbps,
    fps,
    outFps: outputRate(),
    imageDuration,
    gpu,
    fastProres,
    existingPolicy: plan.policy,
  };
  try {
    const results = await api.renderStart(payload);
    if (filesOverride) scheduleAutoRetries(filesOverride, results);
  } catch (err) {
    failExportUI(err, plan.jobs.length);
  }
}

function beginExportUI(jobs) {
  rp.cancelRequested = false;
  const def = currentCodec();
  const imageDuration = clampInt($('r-dur').value, 1, 3600);
  rp.jobFiles = jobs.map((j) => rp.files.find((f) => f.path === j.src) || null);
  rp.jobStates = jobs.map(() => 'wait');
  rp.clock = ExportPlan.createBatchClock(jobs.map((j, i) => {
    const f = rp.jobFiles[i];
    return ExportPlan.jobWeight({ isImage: j.isImage, durationSec: f ? fileDuration(f) : 0, inSec: j.inSec, outSec: j.outSec }, def, imageDuration);
  }), Date.now());
  rp.files.forEach((f) => { f.exportState = ''; });
  applyJobStates();
  updateStartButton();
  $('rp-add').disabled = true;
  $('r-progress').style.display = '';
  $('r-cancel').style.display = '';
  $('r-log').innerHTML = '';
  api.setTaskbarProgress(0);
  $('r-bar').className = '';
  $('r-bar').style.width = '0%';
  $('r-plabel').className = '';
}

// End state of the bar: the real outcome, and no Cancel any more
function showBatchOutcome(okCount, total, cancelled, warned) {
  const o = Codecs.batchOutcome(okCount, total, cancelled, warned);
  const bar = $('r-bar'), plabel = $('r-plabel');
  bar.className = `state-${o.state}`;
  if (!cancelled) bar.style.width = '100%';
  plabel.className = `state-${o.state}`;
  plabel.textContent = o.text;
  $('r-ppct').textContent = '';
  $('r-cancel').style.display = 'none';
  api.setTaskbarProgress(-1);
  scheduleEstimate(); // the disk has less room now
  return o;
}

// A failed batch that never reached a batch-done event (for example no ffmpeg found)
function failExportUI(err, total) {
  const full = String((err && err.message) || err);
  addErrorRow('', full.split('\n')[0].replace(/^Error invoking remote method '[^']*': (Error: )?/, ''), full);
  rp.jobStates = rp.jobStates.map(() => 'fail');
  applyJobStates();
  showBatchOutcome(0, total, false);
}

function addErrorRow(label, message, detail) {
  const log = $('r-log');
  const div = document.createElement('div');
  div.className = 'err log-row';
  const x = document.createElement('span');
  x.className = 'x';
  x.textContent = '✗';
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = `${label ? label + ': ' : ''}${message} `;
  div.append(x, msg);
  if (detail) {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = 'Copy details';
    a.onclick = (e) => {
      e.preventDefault();
      api.copyText(detail);
      a.textContent = 'Copied';
      setTimeout(() => { a.textContent = 'Copy details'; }, 1500);
    };
    msg.appendChild(a);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function logNote(text) {
  const log = $('r-log');
  if (!log) return;
  const div = document.createElement('div');
  div.textContent = `ℹ ${text}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// The finished row: what was read back from the file, or what differs from what was asked
function addDoneRow(ev) {
  const log = $('r-log');
  const warned = ev.check.warnings.length > 0;
  const [first, second] = Outputs.summaryLines(ev.check);
  const label = `${ev.label || baseName(ev.out)}${ev.paddedTo ? ` (padded to ${ev.paddedTo})` : ''}`;
  const div = document.createElement('div');
  div.className = `${warned ? 'warn' : 'ok'} log-row`;
  const mark = document.createElement('span');
  mark.className = 'chk';
  mark.textContent = warned ? '⚠' : '✓';
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.append(`${label}: ${first}`, document.createElement('br'), `${second}${ev.savedAs ? ` · saved as ${ev.savedAs}` : ''} `);
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = `show in ${FILE_MANAGER}`;
  a.onclick = (e) => { e.preventDefault(); api.showInFolder(ev.out); };
  msg.appendChild(a);
  div.append(mark, msg);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function onRenderEvent(ev) {
  const bar = $('r-bar'), plabel = $('r-plabel'), ppct = $('r-ppct'), log = $('r-log');
  if (!bar) return;
  if (ev.type === 'player-test') {
    showToast(`Building player test: ${Math.round(ev.percent)}%`);
    return;
  }
  const clock = rp.clock;
  const clips = new Set(rp.jobFiles).size;
  // The bar and the percentage both show the batch, weighted by clip length
  const showProgress = (index, label) => {
    const snap = clock.snapshot(Date.now());
    bar.style.width = `${snap.fraction * 100}%`;
    ppct.textContent = `${Math.round(snap.fraction * 100)}%`;
    plabel.textContent = label !== undefined ? label : ExportPlan.progressLabel(index, ev.total, clips, snap);
    api.setTaskbarProgress(Math.min(0.99, snap.fraction));
  };
  if (ev.type === 'job-start') {
    if (clock) clock.start(ev.index, Date.now());
    setJobState(ev.index, 'run');
    if (clock) showProgress(ev.index);
  } else if (ev.type === 'progress') {
    if (clock) {
      clock.progress(ev.index, ev.percent);
      showProgress(ev.index);
    }
  } else if (ev.type === 'job-verify') {
    if (clock) showProgress(ev.index, `Checking ${ev.total > 1 ? `${clips !== ev.total ? 'file' : 'clip'} ${ev.index + 1} of ${ev.total}` : 'the export'}…`);
  } else if (ev.type === 'job-note') {
    logNote(ev.note);
  } else if (ev.type === 'job-done') {
    if (clock) clock.finish(ev.index);
    setJobState(ev.index, ev.check.warnings.length ? 'warn' : 'done');
    addDoneRow(ev);
  } else if (ev.type === 'job-error') {
    if (clock) clock.finish(ev.index);
    setJobState(ev.index, ev.error === 'Cancelled' ? '' : 'fail'); // stopping a clip is not a failure
    addErrorRow(ev.label || '', String(ev.error), ev.detail);
  } else if (ev.type === 'batch-done') {
    rp.jobStates = rp.jobStates.map((s) => (s === 'wait' ? '' : s)); // jobs a cancel never reached
    applyJobStates();
    const results = ev.results || [];
    const okResults = results.filter((r) => r.ok);
    const warned = okResults.filter((r) => r.check && r.check.warnings.length).length;
    const o = showBatchOutcome(okResults.length, ev.total || results.length, ev.cancelled, warned);
    if (!ev.cancelled) {
      const first = okResults[0];
      api.notifyExportDone({ title: o.state === 'ok' ? 'Export finished' : 'Export needs a look', body: o.text, showPath: first ? first.out : null });
    }
  }
}

// One clip's status follows from its outputs (one per screen)
function setJobState(index, state) {
  rp.jobStates[index] = state;
  applyJobStates();
}

function applyJobStates() {
  const byFile = new Map();
  rp.jobFiles.forEach((f, i) => {
    if (!f) return;
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(rp.jobStates[i]);
  });
  byFile.forEach((states, f) => {
    // A clip with an output that was cancelled is not "Exported", even if another output was
    const status = ExportPlan.clipStatus(states.filter(Boolean));
    f.exportState = states.every(Boolean) || status === 'fail' ? status : '';
  });
  refreshFileList();
}

// ---------------- watch folder ----------------
const WATCH_MAX_ATTEMPTS = 3;
const WATCH_RETRY_SEC = 15;

async function onWatchFile(p) {
  if (rp.files.some((f) => f.path === p)) return;
  await addFootage([p]);
  const log = $('r-log');
  if (log) {
    const div = document.createElement('div');
    div.textContent = `👁 New file: ${baseName(p)}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  if ($('w-auto').checked) {
    const f = rp.files.find((x) => x.path === p);
    if (f) queueAutoExport(f);
  }
}

// An empty output folder means "next to the footage", which for a watched file is the watch folder
function outputIsWatchFolder() {
  return !!rp.watchDir && (!rp.destDir || Outputs.samePath(rp.destDir, rp.watchDir));
}

function updateWatchConflict() {
  $('w-conflict').classList.toggle('hidden', !($('w-auto').checked && outputIsWatchFolder()));
}

function queueAutoExport(f) {
  if (outputIsWatchFolder()) {
    logNote(`${baseName(f.path)} was not exported automatically: the output folder is the watch folder.`);
    return;
  }
  if (rp.running) rp.watchQueue.push(f);
  else startRender([f], { mode: localStorage.getItem('xre:outmode') || 'separate' });
}

// A failed auto export is tried again (the source may still have been in use). Only when every
// output of that clip failed: a retry after a partial success would write its good files twice.
function scheduleAutoRetries(files, results) {
  if (rp.cancelRequested || !results) return;
  for (const f of files) {
    const own = results.filter((r) => r.src === f.path);
    if (!own.length || own.some((r) => r.ok)) continue;
    f.watchFails = (f.watchFails || 0) + 1;
    if (f.watchFails >= WATCH_MAX_ATTEMPTS) continue;
    logNote(`Trying ${baseName(f.path)} again in ${WATCH_RETRY_SEC} s (attempt ${f.watchFails + 1} of ${WATCH_MAX_ATTEMPTS}).`);
    const timer = setTimeout(() => {
      rp.retryTimers.delete(timer);
      if (rp.watching && rp.files.includes(f)) queueAutoExport(f);
    }, WATCH_RETRY_SEC * 1000);
    rp.retryTimers.add(timer);
  }
}

// Cancel means everything: the running export, what is queued and what was waiting to retry
function cancelEverything() {
  rp.cancelRequested = true;
  const queued = rp.watchQueue.splice(0).length + rp.retryTimers.size;
  rp.retryTimers.forEach((t) => clearTimeout(t));
  rp.retryTimers.clear();
  if (queued) logNote(`${queued} waiting ${queued === 1 ? 'file was' : 'files were'} not exported.`);
  api.renderCancel();
}

function processWatchQueue() {
  if (!rp.watchQueue.length || rp.running) return;
  const batch = rp.watchQueue.splice(0);
  startRender(batch, { mode: localStorage.getItem('xre:outmode') || 'separate' });
}

// ---------------- import / export / open / save ----------------
async function importXml() {
  const paths = await api.openDialog({
    title: 'Import Resolume Advanced Output XML',
    filters: [{ name: 'XML', extensions: ['xml'] }],
  });
  if (!paths.length) return;
  await importXmlPath(paths[0]);
}

// filePath: the project file this is, when it is one
async function switchToProject(p, filePath) {
  project = migrateProject(p);
  selId = null;
  selScreenId = null;
  activeScreenId = project.screens[0].id;
  await loadAllRefs();
  loadExportListFromProject();
  syncExportList(); // the tidied-up list is what counts as "no changes"
  applyProjectExportSettings();
  fitView('input');
  fitView('output');
  refreshAll();
  setDocFile(filePath || null);
  markDirty();
}

// Gives the imported mapping to the open project: footage, trims, name and reference images stay
function replaceMapping(imported) {
  project = ProjectDoc.adoptMapping(project, migrateProject(imported));
  selId = null;
  selScreenId = null;
  activeScreenId = project.screens[0].id;
  rp.screenId = activeScreenId;
  fitView('input');
  fitView('output');
  fitRenderView();
  refreshAll();
  refreshCodecUI();
  markDirty();
}

// With footage loaded the import is a mapping update: review it first, keep the footage by
// default. Returns 'replaced', 'clean', or null when nothing happened.
async function applyImport(imported, source) {
  if (!rp.files.length) {
    if (!(await guardUnsaved())) return null;
    pushHistory(true);
    await switchToProject(imported);
    return 'clean';
  }
  const update = source.derivedSizes ? ProjectDoc.keepDerivedSizes(project, imported) : imported;
  const choice = await askReplaceMapping(ProjectDoc.diffMapping(project, update), source);
  if (choice === 'replace') {
    pushHistory(); // undo brings the old mapping back and leaves the footage alone
    replaceMapping(update);
    showToast('Mapping replaced');
    return 'replaced';
  }
  if (choice === 'clean') {
    if (!(await guardUnsaved())) return null;
    pushHistory(true);
    await switchToProject(imported);
    return 'clean';
  }
  return null;
}

function askReplaceMapping(diff, source) {
  return new Promise((resolve) => {
    openModal(`
      <div class="modal" style="width:520px">
        <div class="modal-head"><span id="m-title"></span><button class="close-x" id="m-close">✕</button></div>
        <div class="modal-body">
          <div class="import-intro" id="m-intro"></div>
          <div id="m-summary"></div>
          <div class="exists-list map-diff-list hidden" id="m-details"></div>
          <div id="m-warn-wrap" class="hidden" style="margin-top:10px">
            <div class="import-sub">Not taken over</div>
            <div class="exists-list" id="m-warn"></div>
          </div>
        </div>
        <div class="modal-foot">
          <button id="m-cancel">Cancel</button>
          <button id="m-clean" title="Discards the footage list, trims and clip settings">Start clean</button>
          <button id="m-replace" class="accent">Replace mapping, keep footage</button>
        </div>
      </div>
    `);
    const n = rp.files.length;
    $('m-title').textContent = 'Replace the mapping?';
    $('m-intro').textContent = `${source.fileName} replaces the current mapping. Your ${n} footage file${n === 1 ? '' : 's'}, trims and clip settings stay.${source.note ? ' ' + source.note : ''}`;
    const addRow = (label, value) => {
      const row = document.createElement('div');
      row.className = 'map-diff-row';
      const a = document.createElement('span');
      a.textContent = label;
      const b = document.createElement('span');
      b.className = 'dim';
      b.textContent = value;
      row.append(a, b);
      $('m-summary').appendChild(row);
    };
    addRow('Canvas', diff.canvas ? `${diff.canvas.from} → ${diff.canvas.to}` : `${diff.canvasSize}, unchanged`);
    diff.screensResized.forEach((s) => addRow(`Output ${s.name}`, `${s.from} → ${s.to}`));
    if (diff.screensAdded.length) addRow('Outputs added', diff.screensAdded.join(', '));
    if (diff.screensRemoved.length) addRow('Outputs removed', diff.screensRemoved.join(', '));
    addRow('Slices', diff.identical
      ? 'no differences'
      : `${diff.slicesMoved.length} moved · ${diff.slicesAdded.length} added · ${diff.slicesRemoved.length} removed · ${diff.slicesUnchanged} unchanged`);
    const details = $('m-details');
    const addDetail = (text, cls) => {
      const row = document.createElement('div');
      row.textContent = text;
      row.title = text;
      if (cls) row.className = cls;
      details.appendChild(row);
    };
    diff.slicesAdded.forEach((name) => addDetail(`+ ${name}`, 'add'));
    diff.slicesRemoved.forEach((name) => addDetail(`− ${name}`, 'del'));
    diff.slicesMoved.forEach((m) => addDetail(`${m.name}: ${m.changes.join(', ')}`));
    details.classList.toggle('hidden', !details.children.length);
    $('m-warn-wrap').classList.toggle('hidden', !source.warnings.length);
    source.warnings.forEach((w) => {
      const row = document.createElement('div');
      row.textContent = w;
      row.style.whiteSpace = 'normal';
      $('m-warn').appendChild(row);
    });
    const done = (val) => {
      closeModal();
      resolve(val);
    };
    $('m-close').onclick = () => done(null);
    $('m-cancel').onclick = () => done(null);
    $('m-clean').onclick = () => done('clean');
    $('m-replace').onclick = () => done('replace');
    $('m-replace').focus();
  });
}

async function importXmlPath(p) {
  try {
    const text = await api.readFileText(p);
    const proj = Resolume.parseScreenSetup(text);
    const warnings = proj.warnings || [];
    delete proj.warnings;
    proj.refs = { input: null, output: null };
    proj.slices.forEach((s) => (s.id = uid()));
    const outcome = await applyImport(proj, { fileName: baseName(p), warnings });
    if (outcome === 'clean' && warnings.length) {
      showImportReport('XML import', `Imported ${proj.slices.length} slice${proj.slices.length === 1 ? '' : 's'}.`, warnings);
    }
  } catch (err) {
    alert('Import failed: ' + (err.message || err));
  }
}

async function importCsv() {
  const paths = await api.openDialog({
    title: 'Import Hippotizer VideoMapper CSV',
    filters: [{ name: 'VideoMapper CSV', extensions: ['csv'] }],
  });
  if (!paths.length) return;
  await importCsvPath(paths[0]);
}

async function importCsvPath(path) {
  try {
    const text = await api.readFileText(path);
    const pp = await api.pathParse(path);
    const proj = Hippo.parseCsv(text, { name: pp.base || 'Hippotizer CSV import' });
    const warnings = proj.warnings || [];
    delete proj.warnings;
    proj.refs = { input: null, output: null };
    proj.slices.forEach((s) => (s.id = uid()));
    const outcome = await applyImport(proj, {
      fileName: baseName(path),
      warnings,
      derivedSizes: true,
      note: 'A CSV holds no canvas or output size, so the current sizes stay as long as the tiles fit in them.',
    });
    if (outcome !== 'clean') return;
    const sc = proj.screens[0];
    showImportReport(
      'CSV import',
      `Imported ${proj.slices.length} tile${proj.slices.length === 1 ? '' : 's'}. Input canvas ${proj.input.width} × ${proj.input.height}, output ${sc.width} × ${sc.height}. A VideoMapper CSV holds no canvas or output resolution, so both were derived from the tiles. Correct them on the right if your real canvas or output is larger than the mapped area.`,
      warnings
    );
  } catch (err) {
    alert('CSV import failed: ' + (err.message || err));
  }
}

// What an import brought in, and what it could not take over
function showImportReport(title, intro, warnings) {
  openModal(`
    <div class="modal" style="width:480px">
      <div class="modal-head"><span id="m-title"></span><button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body">
        <div class="import-intro" id="m-intro"></div>
        <div id="m-warn-wrap" class="hidden">
          <div class="import-sub">Not taken over</div>
          <div class="exists-list" id="m-list"></div>
        </div>
      </div>
      <div class="modal-foot"><button id="m-ok" class="accent">OK</button></div>
    </div>
  `);
  $('m-title').textContent = title;
  $('m-intro').textContent = intro;
  $('m-warn-wrap').classList.toggle('hidden', !warnings.length);
  warnings.forEach((w) => {
    const row = document.createElement('div');
    row.textContent = w;
    row.style.whiteSpace = 'normal';
    $('m-list').appendChild(row);
  });
  $('m-close').onclick = closeModal;
  $('m-ok').onclick = closeModal;
  $('m-ok').focus();
}

async function exportCsv() {
  const screens = project.screens && project.screens.length ? project.screens : [];
  const target = await api.saveDialog({
    title: 'Export as Hippotizer VideoMapper CSV',
    defaultPath: (project.name || 'mapping').replace(/[/\\:]/g, '-') + '.csv',
    filters: [{ name: 'VideoMapper CSV', extensions: ['csv'] }],
  });
  if (!target) return;

  const written = [];
  const notes = [];
  try {
    if (screens.length > 1) {
      // one CSV is exactly one output, so a multi-screen project becomes one file per screen
      const pp = await api.pathParse(target);
      for (const sc of screens) {
        const file = await api.pathJoin(pp.dir, `${pp.base}-${sanitizeName(sc.name)}${pp.ext || '.csv'}`);
        await api.writeFileText(file, Hippo.exportCsv(project, sc.id));
        written.push(baseName(file));
        notes.push(...Hippo.exportNotes(project, sc.id));
      }
    } else {
      const sid = screens.length ? screens[0].id : null;
      await api.writeFileText(target, Hippo.exportCsv(project, sid));
      written.push(baseName(target));
      notes.push(...Hippo.exportNotes(project, sid));
    }
  } catch (err) {
    await showSaveError(err);
    return;
  }

  showToast(written.length > 1 ? `Saved ${written.length} files` : `Saved ${written[0]}`);
  if (written.length > 1 || notes.length) {
    const lines = [];
    if (written.length > 1) {
      lines.push(`A CSV holds one output, so ${written.length} files were written — one per screen:`, ...written.map((w) => '• ' + w));
    }
    if (notes.length) {
      if (lines.length) lines.push('');
      lines.push(...[...new Set(notes)].map((n) => '• ' + n));
    }
    alert(lines.join('\n'));
  }
}

async function exportXml() {
  const p = await api.saveDialog({
    title: 'Export as Resolume XML',
    defaultPath: (project.name || 'mapping').replace(/[/\\:]/g, '-') + '.xml',
    filters: [{ name: 'XML', extensions: ['xml'] }],
  });
  if (!p) return;
  try {
    await api.writeFileText(p, Resolume.exportScreenSetup(project));
    showToast(`Saved ${baseName(p)}`);
  } catch (err) {
    await showSaveError(err);
  }
}

// The message a failed save came with, without the wrapper Electron puts around it
function ipcMessage(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

function showSaveError(err) {
  return api.messageBox({ type: 'error', message: 'The file was not saved.', detail: ipcMessage(err), buttons: ['OK'] });
}

let toastTimer = null;
function showToast(text) {
  $('saved-toast-text').textContent = text;
  const toast = $('saved-toast');
  toast.classList.remove('hidden');
  // In the toolbar when there is room for it, just below when the buttons fill it
  toast.classList.remove('below');
  toast.classList.toggle('below', toast.getBoundingClientRect().left < document.querySelector('#toolbar .spacer').getBoundingClientRect().left);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('saved-toast').classList.add('hidden'), 2000);
}

// Commits a value still being typed, so it is part of what gets saved
function commitFieldEdit() {
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) el.blur();
}

// Save writes straight to the project's file; without one (or asNew) it asks where.
// True only when the project really is on disk.
let savingNow = null;
function saveProject(asNew) {
  if (!savingNow) {
    savingNow = writeProject(asNew === true).finally(() => {
      savingNow = null;
    });
  }
  return savingNow;
}

async function writeProject(asNew) {
  let target = asNew ? null : docFile.path;
  if (!target) {
    target = await api.saveDialog({
      title: 'Save project',
      defaultPath: docFile.path || (project.name || 'project').replace(/[/\\:]/g, '-') + '.xreproj',
      filters: [{ name: 'XtremeLED Remap project', extensions: ['xreproj'] }],
    });
    if (!target) return false;
  }
  syncExportList();
  project.exportSettings = captureExportSettings(); // a file always carries its export settings
  const hash = ProjectDoc.fingerprint(project);
  const text = JSON.stringify(ProjectDoc.embedRefs(project, (key) => refStore.get(key) || null), null, 2);
  try {
    await api.writeFileText(target, text);
  } catch (err) {
    if (asNew) {
      await showSaveError(err);
      return false;
    }
    const choice = await api.messageBox({
      type: 'error',
      message: 'The project was not saved.',
      detail: ipcMessage(err),
      buttons: ['Save as…', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    return choice === 0 ? writeProject(true) : false;
  }
  docFile.path = target;
  docFile.savedHash = hash;
  persistDocFile();
  refreshDocBar();
  showToast('Saved');
  return true;
}

// Before something replaces the project: asks only when something really changed.
// True means go ahead (saved, or the user chose not to).
async function guardUnsaved() {
  commitFieldEdit();
  if (!docDirty()) return true;
  const choice = await api.messageBox({
    type: 'warning',
    message: `Save the changes to ${docLabel()}?`,
    detail: 'Your changes are lost if you do not save them.',
    buttons: ['Save', "Don't save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice === 2) return false;
  return choice === 1 ? true : saveProject(false);
}

async function openProject() {
  const paths = await api.openDialog({
    title: 'Open project',
    filters: [{ name: 'XtremeLED Remap project', extensions: ['xreproj', 'json'] }],
  });
  if (!paths.length) return;
  await openProjectPath(paths[0]);
}

async function openProjectPath(p) {
  try {
    const parsed = migrateProject(JSON.parse(await api.readFileText(p)));
    if (!(await guardUnsaved())) return;
    pushHistory(true);
    await switchToProject(parsed, p);
  } catch (err) {
    alert('Open failed: ' + (err.message || err));
  }
}

async function loadReference() {
  const paths = await api.openDialog({
    title: 'Choose reference image',
    filters: [{ name: 'Images', extensions: IMAGE_EXTS }],
  });
  if (!paths.length) return;
  await setReferenceFromPath(paths[0]);
}

async function setReferenceFromPath(p) {
  pushHistory();
  const dataUrl = await api.readFileDataUrl(p);
  const pp = await api.pathParse(p);
  project.refs[view] = makeRef(dataUrl, pp.base + pp.ext, parseInt($('ref-opacity').value, 10) / 100);
  await loadRefImage(view);
  refreshRefPanel();
  draw();
  markDirty();
}

// ---------------- bind UI ----------------
function bindUI() {
  document.querySelector('.brand .logo').onclick = () => api.openExternal('https://www.xtremeled.nl/');
  $('tab-input').onclick = () => switchView('input');
  $('tab-output').onclick = () => switchView('output');
  $('tab-both').onclick = () => switchView('both');
  $('btn-render').onclick = () => switchPage('render');
  $('btn-back-editor').onclick = () => switchPage('editor');

  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;

  $('btn-zoom-in').onclick = () => zoomButtons(1.25);
  $('btn-zoom-out').onclick = () => zoomButtons(0.8);
  $('btn-zoom-fit').onclick = () => { shownViews().forEach(fitView); draw(); };
  $('btn-zoom-frame').onclick = frameSelection;

  $('btn-new').onclick = openNewMappingModal;
  $('btn-new').title = `New mapping (${IS_MAC ? '⌘N' : 'Ctrl+N'})`;
  $('btn-open-proj').onclick = openProject;
  $('btn-open-proj').title = `Open project (${IS_MAC ? '⌘O' : 'Ctrl+O'})`;
  $('btn-undo').title = `Undo (${IS_MAC ? '⌘Z' : 'Ctrl+Z'})`;
  $('btn-redo').title = `Redo (${IS_MAC ? '⇧⌘Z' : 'Ctrl+Y'})`;
  $('btn-save-proj').title = `Save project (${IS_MAC ? '⌘S' : 'Ctrl+S'})`;
  $('btn-save-proj').onclick = () => saveProject(false);
  $('btn-save-as').title = `Save the project under a new name (${IS_MAC ? '⇧⌘S' : 'Ctrl+Shift+S'})`;
  $('btn-save-as').onclick = () => saveProject(true);
  $('btn-mapping-file').onclick = (e) => {
    e.stopPropagation();
    $('mapping-file-menu').classList.toggle('hidden');
  };
  window.addEventListener('click', () => $('mapping-file-menu').classList.add('hidden'));
  $('btn-import-xml').onclick = importXml;
  $('btn-export-xml').onclick = exportXml;
  $('btn-import-csv').onclick = importCsv;
  $('btn-export-csv').onclick = exportCsv;

  // Duplicate / Delete apply to the tree selection (slice or screen)
  $('btn-dup-slice').onclick = () => {
    if (selected()) duplicateSlice();
    else if (selectedScreen()) duplicateScreen();
  };
  $('btn-del-slice').onclick = () => {
    if (selected()) deleteSlice();
    else if (selectedScreen()) deleteSelectedScreen();
  };
  $('btn-split-slice').onclick = openSplitModal;

  $('tp-preview').onclick = testPatternAsReference;
  $('tp-save').onclick = saveTestPattern;
  $('tp-export').onclick = addTestPattern;

  $('btn-ref-load').onclick = loadReference;
  $('btn-ref-clear').onclick = () => {
    pushHistory();
    project.refs[view] = null;
    refImgs[view] = null;
    refreshRefPanel();
    draw();
    markDirty();
  };
  $('ref-opacity').oninput = () => {
    if (project.refs[view]) {
      project.refs[view].opacity = parseInt($('ref-opacity').value, 10) / 100;
      draw();
      markDirty();
    }
  };

  $('p-name').onchange = () => { pushHistory(); project.name = $('p-name').value || 'Untitled'; markDirty(); };
  const bindInputDim = (id, key) => {
    $(id).onchange = () => {
      pushHistory();
      project.input[key] = clampInt($(id).value, 1, 32768);
      $(id).value = project.input[key];
      fitView('input');
      if (bothView) fitView('output'); // the bands share the height
      draw();
      drawRenderPreview();
      markDirty();
    };
  };
  bindInputDim('in-w', 'width');
  bindInputDim('in-h', 'height');

  // "+" menu (Resolume-style add button)
  $('btn-add-menu').onclick = (e) => {
    e.stopPropagation();
    $('add-popup').classList.toggle('hidden');
  };
  window.addEventListener('click', () => $('add-popup').classList.add('hidden'));
  $('add-screen-item').onclick = () => {
    pushHistory();
    const n = project.screens.length + 1;
    const sc = { id: 'scr' + Math.random().toString(36).slice(2, 7), name: 'Output #' + n, width: 1920, height: 1080 };
    project.screens.push(sc);
    // a new output always starts with one slice (full input -> full output)
    project.slices.push(newSliceDefaults({
      id: uid(),
      name: 'Slice 1',
      screenId: sc.id,
      in: { x: 0, y: 0, w: project.input.width, h: project.input.height },
      out: { x: 0, y: 0, w: sc.width, h: sc.height },
    }));
    selectScreen(sc.id);
    markDirty();
  };
  $('add-slice-item').onclick = () => addSlice();

  // screen properties (right panel, shown when a screen is selected in the tree)
  $('scr-name').onchange = () => {
    const scr = selectedScreen();
    if (!scr) return;
    pushHistory();
    scr.name = $('scr-name').value || 'Output';
    refreshSliceList();
    refreshScreenSelectors();
    markDirty();
  };
  const bindScreenDim = (id, key) => {
    $(id).onchange = () => {
      const scr = selectedScreen();
      if (!scr) return;
      pushHistory();
      scr[key] = clampInt($(id).value, 1, 32768);
      $(id).value = scr[key];
      refreshSliceList();
      refreshScreenSelectors();
      if (outputShown()) fitView('output');
      draw();
      drawRenderPreview();
      markDirty();
    };
  };
  bindScreenDim('out-w', 'width');
  bindScreenDim('out-h', 'height');

  $('sl-name').onchange = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    s.name = $('sl-name').value;
    refreshSliceList();
    draw();
    markDirty();
  };
  $('sl-enabled').onchange = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    s.enabled = $('sl-enabled').checked;
    refreshSliceList();
    draw();
    markDirty();
  };
  $('sl-screen').onchange = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    s.screenId = $('sl-screen').value;
    selScreenId = s.screenId;
    activeScreenId = s.screenId;
    refreshSliceList();
    draw();
    markDirty();
  };
  const bindRect = (id, which, key) => {
    $(id).onchange = () => {
      const s = selected();
      if (!s) return;
      pushHistory();
      const r = which === 'in' ? s.in : s.out;
      const isSize = key === 'w' || key === 'h';
      const was = { w: r.w, h: r.h };
      r[key] = clampInt($(id).value, isSize ? 1 : -100000, 100000);
      if (isSize && which === 'out' && outLock && was.w > 0 && was.h > 0) {
        const ar = was.w / was.h;
        if (key === 'w') r.h = Math.max(1, Math.round(r.w / ar));
        else r.w = Math.max(1, Math.round(r.h * ar));
      }
      $(id).value = r[key];
      refreshProps();
      refreshSliceList();
      draw();
      markDirty();
    };
  };
  bindRect('sl-in-x', 'in', 'x'); bindRect('sl-in-y', 'in', 'y');
  bindRect('sl-in-w', 'in', 'w'); bindRect('sl-in-h', 'in', 'h');
  bindRect('sl-out-x', 'out', 'x'); bindRect('sl-out-y', 'out', 'y');
  bindRect('sl-out-w', 'out', 'w'); bindRect('sl-out-h', 'out', 'h');

  $('sl-in-rot').onchange = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    s.inOrient = parseInt($('sl-in-rot').value, 10);
    refreshProps();
    draw();
    markDirty();
  };
  $('sl-out-rot').onchange = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    s.outOrient = parseInt($('sl-out-rot').value, 10);
    refreshProps();
    draw();
    markDirty();
  };
  $('sl-out-lock').onclick = () => {
    outLock = !outLock;
    localStorage.setItem('xre:outlock', outLock ? '1' : '0');
    refreshOutLockBtn();
  };

  $('sl-out-1to1').onclick = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    Object.assign(s.out, MapCheck.exactOutSize(s));
    refreshProps();
    refreshSliceList();
    draw();
    markDirty();
  };

  $('sl-flip').onclick = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    s.flip = ((s.flip || 0) + 1) % 4;
    refreshProps();
    draw();
    markDirty();
  };

  $('mask-enabled').onchange = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    if ($('mask-enabled').checked) {
      if (!s.mask || !s.mask.points) s.mask = { enabled: true, points: Geometry.rectToPoints(s.in) };
      s.mask.enabled = true;
    } else if (s.mask) {
      s.mask.enabled = false;
    }
    refreshProps();
    draw();
    markDirty();
  };
  $('mask-add').onclick = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    const fresh = !s.mask || !s.mask.points;
    if (fresh) s.mask = { enabled: true, points: Geometry.rectToPoints(s.in) };
    s.mask.enabled = true;
    refreshProps();
    draw();
    markDirty();
    if (fresh) startMaskEdit(); // an untouched mask does nothing yet, so go straight to the points
  };
  $('mask-edit').onclick = () => {
    if (maskEditId) stopMaskEdit();
    else startMaskEdit();
  };
  $('mask-reset').onclick = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    s.mask = { enabled: true, points: Geometry.rectToPoints(s.in) };
    refreshProps();
    draw();
    markDirty();
  };
  const bindMaskBBox = (id, key) => {
    $(id).onchange = () => {
      const s = selected();
      if (!s || !s.mask || !s.mask.points) return;
      const bb = Geometry.maskBBox(s.mask);
      if (!bb) return;
      pushHistory();
      const val = clampInt($(id).value, key === 'w' || key === 'h' ? 1 : -100000, 100000);
      if (key === 'x' || key === 'y') {
        const d = val - bb[key];
        s.mask.points.forEach((p) => (p[key] += d));
      } else {
        const axis = key === 'w' ? 'x' : 'y';
        const scaleF = val / bb[key];
        s.mask.points.forEach((p) => {
          p[axis] = Math.round(bb[axis] + (p[axis] - bb[axis]) * scaleF);
        });
      }
      refreshProps();
      draw();
      markDirty();
    };
  };
  bindMaskBBox('mask-x', 'x'); bindMaskBBox('mask-y', 'y');
  bindMaskBBox('mask-w', 'w'); bindMaskBBox('mask-h', 'h');

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('dblclick', onDblClick);
  window.addEventListener('mousemove', (e) => {
    if (drag) {
      const rect = canvas.getBoundingClientRect();
      onMouseMove({ offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey });
    }
  });
  canvas.addEventListener('mousemove', (e) => { if (!drag) onMouseMove(e); });
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  // right-click a slice in the Output view -> context menu with "Match input rect"
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    hideCtxMenu();
    if (bothView) setBand(bandAt(e.offsetY));
    if (page !== 'editor' || maskEditActive()) return;
    const s = sliceAt(e.offsetX, e.offsetY);
    if (!s || view !== 'output') return;
    if (selId !== s.id) selectSlice(s.id);
    const menu = $('ctx-menu');
    menu.innerHTML = '';
    const item = document.createElement('button');
    item.textContent = 'Match input rect (size & position)';
    item.onclick = () => {
      pushHistory();
      s.out = { x: s.in.x, y: s.in.y, w: s.in.w, h: s.in.h };
      hideCtxMenu();
      refreshProps();
      refreshSliceList();
      draw();
      markDirty();
    };
    menu.appendChild(item);
    menu.style.left = Math.min(e.clientX, window.innerWidth - 210) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 50) + 'px';
    menu.classList.remove('hidden');
  });
  window.addEventListener('click', hideCtxMenu);
  window.addEventListener('blur', hideCtxMenu);

  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('input[type="range"][data-default]')) {
      e.preventDefault();
      t.value = t.dataset.default;
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // ---- Windows text-field hardening -------------------------------------
  // Reports keep coming in that number fields "won't take the cursor" on
  // Windows. Two safety nets, both no-ops when things already work:
  //   1. after a click in a field, make sure focus actually landed there;
  //   2. select the current value on focus, so typing replaces it right away
  //      (a click-drag inside the field still selects by hand).
  let reselect = null;
  const editable = (el) =>
    !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
    !['checkbox', 'radio', 'range', 'button', 'file'].includes(el.type);

  document.addEventListener('pointerdown', (e) => {
    const el = e.target;
    if (!editable(el)) return;
    setTimeout(() => {
      if (document.activeElement !== el && document.body.contains(el)) {
        try { el.focus(); } catch (_) { /* ignore */ }
      }
    }, 0);
  }, true);

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!editable(el) || !el.classList.contains('num')) { reselect = null; return; }
    try { el.select(); } catch (_) { /* ignore */ }
    reselect = el;
  });
  document.addEventListener('focusout', () => { reselect = null; });
  // What a text field held when it last agreed with the mapping: anything else is still typing
  let fieldBaseline = null;
  document.addEventListener('focusin', (e) => {
    if (editable(e.target)) fieldBaseline = e.target.value;
  });
  document.addEventListener('change', (e) => {
    if (e.target === document.activeElement && editable(e.target)) fieldBaseline = e.target.value;
  });
  // Undo with a field focused goes to the mapping, then the field shows the restored value
  const undoFromField = async (el, redoing) => {
    el.blur();
    await (redoing ? redo() : undo());
    if (document.body.contains(el)) el.focus();
    fieldBaseline = el.value;
  };
  document.addEventListener('mouseup', (e) => {
    const el = reselect;
    reselect = null;
    // the click that gave focus also places a caret; restore the select-all
    // unless the user deliberately dragged out a selection
    if (el && el === e.target && el.selectionStart === el.selectionEnd) {
      try { el.select(); } catch (_) { /* ignore */ }
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const command = (e.ctrlKey || e.metaKey) && !e.altKey;
    const inModal = modalOpen();
    if (command && key === 's') {
      e.preventDefault();
      if (!inModal) {
        commitFieldEdit();
        saveProject(e.shiftKey);
      }
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (inModal) {
      // A dialog keeps the keyboard to itself. Esc cancels; Enter applies where that is safe.
      if (e.key === 'Escape') {
        e.preventDefault();
        const out = $('m-cancel') || $('m-close') || $('m-ok');
        if (out) out.click();
        return;
      }
      if (e.key === 'Enter' && tag !== 'button' && $('modal-root').querySelector('[data-enter-apply]')) {
        e.preventDefault();
        if (!$('m-apply').disabled) $('m-apply').click();
        return;
      }
      if (!inField) return;
    } else {
      if (command && !e.shiftKey && key === 'n') { e.preventDefault(); openNewMappingModal(); return; }
      if (command && !e.shiftKey && key === 'o') { e.preventDefault(); openProject(); return; }
      if (e.key === 'Escape' && maskEditId) { e.preventDefault(); stopMaskEdit(); return; }
    }
    if (inField) {
      // In text fields: ensure editing shortcuts work even if the platform menu
      // doesn't wire them up (seen on Windows). Let all other keys type normally.
      const textual = e.target.type === 'text' || e.target.type === 'search' || tag === 'textarea';
      if (command && textual && key === 'a') { e.preventDefault(); e.target.select(); }
      // c / v / x fall through to Chromium's native clipboard handling
      if (!inModal && page === 'editor' && command && (key === 'z' || key === 'y')) {
        // Still typing: the field undoes its own text. Otherwise undo belongs to the mapping.
        if (textual && e.target.value !== fieldBaseline) return;
        e.preventDefault();
        undoFromField(e.target, key === 'y' || e.shiftKey);
      }
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (meta && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (meta && key === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (page === 'render') {
      if (e.code === 'Space') { e.preventDefault(); togglePlayback(); return; }
      if (e.key.toLowerCase() === 'i') { $('rp-set-in').click(); return; }
      if (e.key.toLowerCase() === 'o') { $('rp-set-out').click(); return; }
      return;
    }
    // Space is for panning: without this it would also press the last clicked button
    if (e.code === 'Space') { e.preventDefault(); spaceDown = true; canvas.style.cursor = 'grab'; return; }
    if (!meta && key === 'f') { e.preventDefault(); frameSelection(); return; }
    const s = selected();
    if ((e.key === 'Delete' || e.key === 'Backspace') && s) { e.preventDefault(); deleteSlice(); return; }
    if (meta && e.key.toLowerCase() === 'd' && s) { e.preventDefault(); duplicateSlice(); return; }
    if (s && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      pushHistoryThrottled(800);
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      if (maskEditActive()) {
        s.mask.points.forEach((p) => { p.x += dx; p.y += dy; });
      } else {
        const r = sliceRect(s, view);
        r.x += dx;
        r.y += dy;
      }
      refreshProps();
      draw();
      markDirty();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; canvas.style.cursor = 'default'; }
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const paths = files.map((f) => api.getPathForFile(f)).filter(Boolean);
    const xmls = paths.filter((p) => extOf(p) === 'xml');
    const csvs = paths.filter((p) => extOf(p) === 'csv');
    const projs = paths.filter((p) => ['xreproj', 'json'].includes(extOf(p)));
    // A question on screen waits for its answer; only New mapping invites a dropped file
    const newDialog = !!$('new-mapping');
    if (modalOpen() && !newDialog) return;
    if (newDialog && (xmls.length || csvs.length || projs.length)) closeModal();
    if (xmls.length) return importXmlPath(xmls[0]);
    if (csvs.length) return importCsvPath(csvs[0]);
    if (projs.length) return openProjectPath(projs[0]);
    if (newDialog) return;
    const scan = await api.scanFootage(paths, [...FOOTAGE_IMAGE_EXTS, ...VIDEO_EXTS]);
    if (!scan.sequences.length && !scan.rest.length) return;
    const browserImage = scan.rest.find((p) => IMAGE_EXTS.includes(extOf(p)));
    if (page === 'editor' && !scan.sequences.length && browserImage) return setReferenceFromPath(browserImage);
    if (page !== 'render') switchPage('render');
    return addScanned(paths);
  });

  // export page
  $('rp-tab-input').onclick = () => setPreviewTab('input');
  $('rp-tab-output').onclick = () => setPreviewTab('output');
  $('rp-tab-check').onclick = () => setPreviewTab('check');
  bindCheckView();
  $('rp-screen-select').onchange = () => {
    rp.screenId = $('rp-screen-select').value;
    fitRenderView();
    drawRenderPreview();
    if (ck.active) runFrameCheck();
  };
  $('r-rate').onchange = () => { refreshCodecUI(); exportSettingsChanged(); };
  const gridFields = [$('tp-grid'), $('tp-grid-w'), $('tp-grid-h')];
  gridFields.forEach((el) => {
    el.onchange = () => setPanelGrid($('tp-grid').checked, $('tp-grid-w').value, $('tp-grid-h').value);
  });
  $('rp-add').onclick = async () => {
    const paths = await api.openDialog({
      title: 'Choose stageview footage',
      multi: true,
      filters: [
        { name: 'Footage', extensions: [...FOOTAGE_IMAGE_EXTS, ...VIDEO_EXTS] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (paths.length) addScanned(paths, { select: true, anyFile: true });
  };
  $('rp-testpattern').onclick = askTestPattern;
  $('rp-select-all').onclick = () => {
    const allSel = rp.files.every((f) => f.selected !== false);
    rp.files.forEach((f) => (f.selected = !allSel));
    refreshFileList();
    syncExportList();
  };
  $('rp-remove').onclick = () => {
    if (rp.activeIndex < 0) return;
    rp.files.splice(rp.activeIndex, 1);
    rp.activeIndex = Math.min(rp.activeIndex, rp.files.length - 1);
    syncExportList();
    refreshFileList();
    refreshClipControls();
    layoutTimeline();
    if (activeFile()) selectFile(rp.activeIndex);
    else drawRenderPreview();
  };
  $('rp-play').onclick = togglePlayback;
  $('px-summary').onclick = () => {
    pxOpenChoice = $('px-summary').getAttribute('aria-expanded') !== 'true';
    refreshPixelCheck();
  };
  $('rp-mute').onclick = () => {
    rp.previewMuted = rp.previewMuted === false; // toggle (default true)
    rp.previewMuted = !rpVideo.muted ? true : false;
    rpVideo.muted = rp.previewMuted;
    $('rp-mute').innerHTML = icon(rpVideo.muted ? 'mute' : 'sound');
  };
  $('rp-refresh').onclick = () => { stopPlayback(false); fetchFrame(true); };
  $('rp-set-in').onclick = () => {
    const f = activeFile();
    if (!f || f.isImage) return;
    f.inSec = f.curTime || 0;
    if (f.outSec != null && f.outSec <= f.inSec) f.outSec = null;
    layoutTimeline();
    syncExportList();
  };
  $('rp-set-out').onclick = () => {
    const f = activeFile();
    if (!f || f.isImage) return;
    f.outSec = f.curTime || 0;
    if (f.inSec != null && f.inSec >= f.outSec) f.inSec = null;
    layoutTimeline();
    syncExportList();
  };
  $('rp-clear-trim').onclick = () => {
    const f = activeFile();
    if (!f) return;
    f.inSec = null;
    f.outSec = null;
    layoutTimeline();
    syncExportList();
  };
  // precise numeric in/out
  $('tl-in-n').onchange = () => {
    const f = activeFile();
    if (!f || f.isImage) return;
    const v = calcNum($('tl-in-n').value);
    if (Number.isNaN(v) || $('tl-in-n').value === '') {
      f.inSec = null;
    } else {
      f.inSec = Math.max(0, Math.min(v, (f.outSec != null ? f.outSec : fileDuration(f)) - 0.05));
    }
    layoutTimeline();
    syncExportList();
  };
  $('tl-out-n').onchange = () => {
    const f = activeFile();
    if (!f || f.isImage) return;
    const v = calcNum($('tl-out-n').value);
    if (Number.isNaN(v) || $('tl-out-n').value === '') {
      f.outSec = null;
    } else {
      f.outSec = Math.min(fileDuration(f), Math.max(v, (f.inSec != null ? f.inSec : 0) + 0.05));
    }
    layoutTimeline();
    syncExportList();
  };
  $('r-codec').onchange = () => { refreshCodecUI(); exportSettingsChanged(); };
  $('r-alpha').onchange = () => { refreshCodecUI(); exportSettingsChanged(); };
  $('r-depth').onchange = () => { refreshCodecUI(); exportSettingsChanged(); };
  $('r-bitrate').addEventListener('change', exportSettingsChanged);
  $('r-fps').addEventListener('input', refreshPixelCheck);
  $('r-fps').addEventListener('change', exportSettingsChanged);
  $('r-dur').addEventListener('change', exportSettingsChanged);
  document.querySelectorAll('[data-acc]').forEach((b) => {
    setPanelOpen(b.dataset.acc, panelOpenState()[b.dataset.acc] === true, true);
    b.onclick = () => setPanelOpen(b.dataset.acc, b.getAttribute('aria-expanded') !== 'true');
  });
  buildTargetCards();
  const fileManager = `Open the folder in ${FILE_MANAGER}`;
  $('r-dest-open').title = fileManager;
  $('r-dest-open').onclick = () => {
    const dir = shownOutputFolder();
    if (dir) api.openFolder(dir).catch(() => showToast('That folder cannot be opened.'));
  };
  $('r-dest-same').onclick = () => setDestDir(null);
  $('r-same-as-source').onclick = sameAsSource;
  $('r-gpu').checked = localStorage.getItem('xre:gpu') === '1';
  $('r-gpu').onchange = () => {
    localStorage.setItem('xre:gpu', $('r-gpu').checked ? '1' : '0');
    refreshCodecUI();
  };
  $('r-fast-prores').checked = localStorage.getItem('xre:fastprores') === '1';
  $('r-fast-prores').onchange = () => {
    localStorage.setItem('xre:fastprores', $('r-fast-prores').checked ? '1' : '0');
    refreshCodecUI();
  };
  $('r-dest-btn').onclick = async () => {
    const dir = await api.openDirDialog({ title: 'Choose output folder' });
    if (dir) setDestDir(dir);
  };
  $('r-start').onclick = () => startRender();
  $('r-cancel').onclick = cancelEverything;
  bindClipControls();
  bindTimeline();
  bindPreviewDrag();

  $('w-choose').onclick = async () => {
    const dir = await api.openDirDialog({ title: 'Choose watch folder' });
    if (!dir) return;
    rp.watchDir = dir;
    $('w-dir').textContent = dir;
    $('w-toggle').disabled = false;
    updateWatchConflict();
  };
  $('w-auto').onchange = updateWatchConflict;
  $('w-toggle').onclick = async () => {
    if (!rp.watchDir) return;
    if (rp.watching) {
      await api.watchStop();
      rp.watching = false;
      $('w-toggle').textContent = 'Start';
      $('w-toggle').classList.remove('accent');
    } else {
      await api.watchStart(rp.watchDir);
      rp.watching = true;
      $('w-toggle').textContent = 'Stop';
      $('w-toggle').classList.add('accent');
    }
  };
  api.onWatchFile(onWatchFile);

  new ResizeObserver(() => {
    if (page === 'editor') resizeCanvas();
    else resizeRenderCanvas();
  }).observe($('main'));
  api.onRenderEvent(onRenderEvent);

  // A drive plugged back in (or a file moved away) shows as soon as you come back to the app
  window.addEventListener('focus', () => {
    updateFileStates(rp.files.slice());
    checkDestFolder();
    scheduleEstimate();
  });

  // Closing the window: main asks here first. 'asking' tells it we are alive and a question
  // may follow, so it waits without a time limit for the real answer.
  api.onCloseRequest(async () => {
    api.answerClose('asking');
    let allowed = false;
    try {
      allowed = await guardUnsaved();
    } catch (e) {
      allowed = false;
    }
    api.answerClose(allowed === true);
  });
}

// ---------------- init ----------------
window.addEventListener('DOMContentLoaded', async () => {
  canvas = $('editor');
  ctx = canvas.getContext('2d');
  rpCanvas = $('rp-canvas');
  rpCtx = rpCanvas.getContext('2d');
  rpVideo = $('rp-video');

  const params = new URLSearchParams(location.search);
  const demo = DEMO_MODE;
  const restored = demo ? null : loadLocal();
  project = restored || ProjectDoc.internRefs(demoProject(), rememberRef);
  activeScreenId = project.screens[0].id;
  rp.screenId = project.screens[0].id;

  buildCodecSelect();
  bindUI();
  updateUndoButtons();
  await restoreStoredRefs();
  await loadAllRefs();
  $('status-hint').textContent = `Drag = move · Handles = resize · Shift = keep ratio · ${IS_MAC ? 'Two fingers = pan · Pinch = zoom' : 'Scroll = zoom · Shift+scroll = pan'} · F = frame · Arrows = 1 px · ${IS_MAC ? '⌘' : 'Ctrl+'}Z undo`;
  resizeCanvas();
  fitView('input');
  fitView('output');
  appPaths = await api.appPaths().catch(() => null);
  loadExportListFromProject();
  syncExportList();
  applyProjectExportSettings();
  refreshAll();
  refreshCodecUI();
  if (!restored || !loadDocFile()) setDocFile(null); // anything else started out as "no changes"
  refreshDocBar();
  if (!demo) api.refPrune(ProjectDoc.refKeys(project)).catch(() => { /* tried on the next start */ });

  api.onMenu(handleMenu);
  $('ab-licenses').onclick = showLicenses;
  $('ab-diagnostics').onclick = () => copyDiagnostics($('ab-diagnostics'));
  $('update-view').onclick = () => { if (updateInfo) api.openRelease(updateInfo.url); };
  $('update-close').onclick = () => {
    try { if (updateInfo) localStorage.setItem(UPDATE_DISMISSED_KEY, updateInfo.version); } catch (e) { /* shows again next start */ }
    updateInfo = null;
    refreshUpdateNotice();
  };

  try {
    caps = await api.ffmpegCaps();
  } catch (e) {
    caps = null;
  }
  appFacts = await api.appInfo().catch(() => null);
  refreshDocBar();
  refreshEngineInfo();
  api.ffmpegPin().then((pin) => {
    ffmpegPinState = pin;
    refreshEngineInfo();
  }).catch(() => {
    ffmpegPinState = { state: 'unknown' };
    refreshEngineInfo();
  });
  if (!demo) setTimeout(checkForUpdate, UPDATE_CHECK_DELAY_MS);
  buildCodecSelect();
  refreshCodecUI();
  // Tests the graphics card encoders in the background; the checkbox waits for the result
  api.ffmpegGpu().then((r) => {
    gpuEncoders = r || { encoders: {}, label: null };
    refreshCodecUI();
  }).catch(() => {
    gpuEncoders = { encoders: {}, label: null };
    refreshCodecUI();
  });

  if (params.get('page') === 'render') switchPage('render');
  if (params.get('sel') === 'screen') selectScreen(project.screens[0].id);
  if (params.get('sel') === 'slice') selectSlice(project.slices[0] && project.slices[0].id);

  // Tour/screenshot hooks — only when launched with ?demo=1 (used by tools/--shoot)
  if (params.get('demo') === '1') {
    window.__demoApi = {
      goEditor: () => switchPage('editor'),
      goExport: () => switchPage('render'),
      viewInput: () => switchView('input'),
      viewOutput: () => switchView('output'),
      viewBoth: () => switchView('both'),
      selectSlice: (i) => {
        const s = project.slices[i];
        if (!s) return;
        selId = s.id;
        refreshSliceList();
        refreshProps();
        draw();
      },
      addTestFootage: async () => {
        await addTestPattern(); // switches to Export page and adds the test pattern
      },
      addFootagePath: async (p) => {
        if (page !== 'render') switchPage('render');
        await addFootage([p], { select: true });
      },
      playState: () => {
        const f = activeFile();
        return JSON.stringify({ playing: rp.playing, t: f ? f.curTime : null, native: videoOkForPath === (f && f.path) });
      },
      rpInput: () => setPreviewTab('input'),
      rpOutput: () => setPreviewTab('output'),
      rpCheck: () => setPreviewTab('check'),
      checkState: () => ({ result: ck.result, running: ck.running, seam: ck.seam, selected: ck.selected, message: ck.message }),
      nextSeam: () => ckNextSeam(),
      showUpdateNotice: (version, url) => {
        updateInfo = { version, url: url || AppInfo.RELEASES_PAGE };
        refreshUpdateNotice();
      },
      showAbout: () => showAbout(),
      showLicenses: () => showLicenses(),
      addScanned: (paths) => addScanned(paths, { select: true }),
      addPlayerTest: () => addPlayerTest(),
      setRate: (v) => { $('r-rate').value = v; refreshCodecUI(); },
      setPanelGrid: (on, w, h) => setPanelGrid(on, w, h),
      setCodec: (id) => { $('r-codec').value = id; refreshCodecUI(); },
      openPanels: () => ['clip', 'color', 'advanced'].forEach((n) => setPanelOpen(n, true, true)),
      projectState: () => JSON.stringify({ files: rp.files.map((f) => ({ path: f.path, inSec: f.inSec, outSec: f.outSec, x: f.transform.x, missing: f.missing })), dirty: docDirty(), path: docFile.path, input: project.input, slices: project.slices.length, canUndo: history.undo.length, undoBytes: history.undo.reduce((n, e) => n + e.mapping.length + (e.footage || '').length, 0) }),
      loadProjectFile: (p) => openProjectPath(p),
      importMapping: (p) => (extOf(p) === 'csv' ? importCsvPath(p) : importXmlPath(p)),
      saveTo: async (p) => { docFile.path = p; return saveProject(false); },
      undo: () => undo(),
      redo: () => redo(),
      relink: (i, p) => relinkFiles(rp.files[i], p),
      hasPreview: () => {
        const f = activeFile();
        return !!(f && f.frameImg);
      },
      // Exact bounding boxes of UI panels (physical px, matching capturePage output)
      // so tutorial highlight boxes are guaranteed to align.
      rects: () => {
        const dpr = window.devicePixelRatio || 1;
        const R = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr };
        };
        const union = (...rs) => {
          rs = rs.filter(Boolean);
          if (!rs.length) return null;
          const x0 = Math.min(...rs.map((r) => r.x));
          const y0 = Math.min(...rs.map((r) => r.y));
          const x1 = Math.max(...rs.map((r) => r.x + r.w));
          const y1 = Math.max(...rs.map((r) => r.y + r.h));
          return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        };
        const q = (sel) => document.querySelector(sel);
        const out = { page };
        if (page === 'render') ['clip', 'advanced'].forEach((n) => setPanelOpen(n, true, true));
        if (page === 'editor') {
          out.project = R(q('#project-section'));
          const items = [...document.querySelectorAll('#screen-tree .slice-item')];
          out.slices = union(R(q('#left .panel-title')), ...items.map(R));
          out.sliceProps = R(q('#slice-props'));
          out.xmlButtons = R($('btn-mapping-file'));
          // the drawn input canvas inside the editor view
          const cb = canvas.getBoundingClientRect();
          const t = vt[view];
          const ws = worldSize(view);
          out.canvasArea = {
            x: (cb.left + t.ox) * dpr,
            y: (cb.top + t.oy) * dpr,
            w: ws.w * t.scale * dpr,
            h: ws.h * t.scale * dpr,
          };
        } else {
          out.footage = union(
            R(q('#rp-left .panel-title')),
            ...[...document.querySelectorAll('.file-row')].map(R),
            R(q('#rp-left .left-buttons'))
          );
          const cb = rpCanvas.getBoundingClientRect();
          const w2 = rpWorld();
          out.previewCanvas = {
            x: (cb.left + rp.vt.ox) * dpr,
            y: (cb.top + rp.vt.oy) * dpr,
            w: w2.w * rp.vt.scale * dpr,
            h: w2.h * rp.vt.scale * dpr,
          };
          out.clip = R(q('#rp-clip-section'));
          out.timeline = R(q('#rp-timeline'));
          out.codecRow = R($('r-codec') && $('r-codec').closest('.row'));
          out.alphaGpu = union(
            R($('r-alpha') && $('r-alpha').closest('.row')),
            R($('r-same-as-source') && $('r-same-as-source').closest('.row')),
            R($('r-gpu') && $('r-gpu').closest('.row')),
            R($('r-codec-note'))
          );
          out.startBtn = R($('r-start'));
        }
        return out;
      },
    };
    window.__demoReady = true;
  }
});
