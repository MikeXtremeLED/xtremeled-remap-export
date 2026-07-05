'use strict';
/* XtremeLED Remap Export — slice editor + export page */

const api = window.xre;
const $ = (id) => document.getElementById(id);

// ---------------- state ----------------
let project = null;
let page = 'editor'; // 'editor' | 'render'
let view = 'input'; // 'input' | 'output'
let selId = null;
let activeScreenId = null;
let caps = null;
let maskEdit = false;
const refImgs = { input: null, output: null };
const vt = {
  input: { scale: 0.1, ox: 50, oy: 50 },
  output: { scale: 0.1, ox: 50, oy: 50 },
};

let canvas, ctx;
let spaceDown = false;
let drag = null;
let uidCounter = 1;
const uid = () => 'sl' + uidCounter++ + '_' + Math.random().toString(36).slice(2, 7);

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif'];
const VIDEO_EXTS = ['mov', 'mp4', 'm4v', 'avi', 'mkv', 'mxf', 'webm', 'mpg', 'mpeg'];

const HANDLES = [
  { k: 'nw', fx: 0, fy: 0 }, { k: 'n', fx: 0.5, fy: 0 }, { k: 'ne', fx: 1, fy: 0 },
  { k: 'e', fx: 1, fy: 0.5 }, { k: 'se', fx: 1, fy: 1 }, { k: 's', fx: 0.5, fy: 1 },
  { k: 'sw', fx: 0, fy: 1 }, { k: 'w', fx: 0, fy: 0.5 },
];
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
function visibleSlices(v) {
  if (v === 'input') return project.slices;
  return project.slices.filter((s) => sliceScreenId(s) === activeScreen().id);
}
function extOf(p) {
  const m = String(p).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
function isImagePath(p) {
  return IMAGE_EXTS.includes(extOf(p));
}
function clampInt(v, min, max) {
  v = Math.round(Number(v) || 0);
  return Math.max(min, Math.min(max, v));
}
function baseName(p) {
  return String(p).split('/').pop();
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

function snapshot() {
  return JSON.stringify(project);
}
function pushHistory() {
  history.undo.push(snapshot());
  if (history.undo.length > 100) history.undo.shift();
  history.redo.length = 0;
  updateUndoButtons();
}
function pushHistoryThrottled(ms) {
  const now = Date.now();
  if (now - lastNudge > (ms || 800)) pushHistory();
  lastNudge = now;
}
async function restoreSnapshot(json) {
  project = migrateProject(JSON.parse(json));
  if (selId && !project.slices.some((s) => s.id === selId)) selId = null;
  if (!project.screens.some((s) => s.id === activeScreenId)) activeScreenId = project.screens[0].id;
  await loadAllRefs();
  loadExportListFromProject();
  refreshAll();
  markDirty();
}
async function undo() {
  if (!history.undo.length) return;
  history.redo.push(snapshot());
  await restoreSnapshot(history.undo.pop());
  updateUndoButtons();
}
async function redo() {
  if (!history.redo.length) return;
  history.undo.push(snapshot());
  await restoreSnapshot(history.redo.pop());
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
  return p;
}

// ---------------- persistence ----------------
let saveTimer = null;
function markDirty() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem('xre:project', JSON.stringify(project));
    } catch (e) {
      try {
        localStorage.setItem('xre:project', JSON.stringify({ ...project, refs: { input: null, output: null } }));
      } catch (e2) { /* give up */ }
    }
  }, 400);
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
function loadRefImage(v) {
  return new Promise((resolve) => {
    const ref = project.refs[v];
    if (!ref || !ref.dataUrl) {
      refImgs[v] = null;
      return resolve();
    }
    const img = new Image();
    img.onload = () => { refImgs[v] = img; resolve(); };
    img.onerror = () => { refImgs[v] = null; resolve(); };
    img.src = ref.dataUrl;
  });
}
async function loadAllRefs() {
  await Promise.all([loadRefImage('input'), loadRefImage('output')]);
}

// ---------------- canvas & drawing (editor) ----------------
function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const statusH = $('statusbar') ? $('statusbar').offsetHeight : 24;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(50, rect.width);
  const ch = Math.max(50, rect.height - statusH);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function cssSize(c) {
  c = c || canvas;
  return { w: parseFloat(c.style.width) || c.width, h: parseFloat(c.style.height) || c.height };
}

function fitView(v) {
  const t = vt[v];
  const { w: W, h: H } = worldSize(v);
  const { w: cw, h: ch } = cssSize();
  const margin = 50;
  const scale = Math.min((cw - margin * 2) / W, (ch - margin * 2) / H);
  t.scale = Math.max(0.001, Math.min(8, scale));
  t.ox = (cw - W * t.scale) / 2;
  t.oy = (ch - H * t.scale) / 2;
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
  g.fillStyle = '#141617';
  g.fillRect(cx, cy, cwid, chei);
  const cell = 14;
  g.fillStyle = '#191c1d';
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
  const t = vt[view];
  const { w: cw, h: ch } = cssSize();
  const { w: W, h: H } = worldSize(view);

  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = '#202426';
  ctx.fillRect(0, 0, cw, ch);

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

  ctx.strokeStyle = '#42484c';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - 0.5, cy - 0.5, cwid + 1, chei + 1);

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
      if (isSel && maskEdit) {
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

    if (w > 40 && h > 14) {
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
      ctx.font = 'bold 11px -apple-system, sans-serif';
      const tw = Math.max(ctx.measureText(label).width, ctx.measureText(sub).width - 14);
      const px = x + w / 2, py = y + h / 2;
      ctx.fillStyle = 'rgba(10,12,13,0.78)';
      const bw = tw + 16, bh = 28;
      ctx.fillRect(px - bw / 2, py - bh / 2, bw, bh);
      ctx.fillStyle = off ? '#8b9195' : '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px, py - 6);
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillStyle = off ? '#6d7276' : '#f7941e';
      ctx.fillText(sub, px, py + 7);
    }
  }

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

  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillStyle = '#8b9195';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('0,0', cx + 3, cy - 3);
}

function maskEditActive() {
  const s = selected();
  return maskEdit && view === 'input' && s && maskUsable(s);
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

// ---------------- mouse (editor) ----------------
function applyResize(r0, k, dx, dy) {
  let { x, y, w, h } = r0;
  if (k.includes('w')) { x = r0.x + dx; w = r0.w - dx; }
  if (k.includes('e')) { w = r0.w + dx; }
  if (k.includes('n')) { y = r0.y + dy; h = r0.h - dy; }
  if (k.includes('s')) { h = r0.h + dy; }
  if (w < 1) { if (k.includes('w')) x = r0.x + r0.w - 1; w = 1; }
  if (h < 1) { if (k.includes('n')) y = r0.y + r0.h - 1; h = 1; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
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
      selId = s.id;
      refreshSliceList();
      refreshProps();
    }
    pushHistory();
    drag = { mode: 'move', start: toWorld(px, py), orig: { ...sliceRect(s, view) } };
    draw();
    return;
  }
  if (selId !== null) {
    selId = null;
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

function onMouseMove(e) {
  if (!project || page !== 'editor') return;
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
    Object.assign(sliceRect(sel, view), applyResize(drag.orig, drag.k, dx, dy));
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
  const t = vt[view];
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.01));
  } else {
    t.ox -= e.deltaX;
    t.oy -= e.deltaY;
    draw();
  }
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
function refreshSliceList() {
  const list = $('slice-list');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  const multi = project.screens.length > 1;
  project.slices.forEach((s, idx) => {
    const item = document.createElement('div');
    item.className = 'slice-item' + (s.id === selId ? ' selected' : '') + (s.enabled === false ? ' off' : '');
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
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = s.name;
    item.append(cb, nm);
    if (multi) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'S' + (project.screens.findIndex((sc) => sc.id === sliceScreenId(s)) + 1);
      item.append(badge);
    }
    const sz = document.createElement('span');
    sz.className = 'sz';
    const r = sliceRect(s, view);
    sz.textContent = `${r.w}×${r.h}`;
    item.append(sz);
    item.addEventListener('click', () => {
      selId = s.id;
      if (view === 'output' && sliceScreenId(s) !== activeScreen().id) {
        activeScreenId = sliceScreenId(s);
        refreshScreenSelectors();
        fitView('output');
      }
      refreshSliceList();
      refreshProps();
      draw();
    });
    enableReorder(item, idx, (from, to) => {
      pushHistory();
      if (moveItem(project.slices, from, to)) {
        refreshSliceList();
        draw();
        markDirty();
      }
    });
    list.appendChild(item);
  });
  list.scrollTop = scroll;
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
  const psel = $('p-screen-select');
  psel.innerHTML = opts;
  psel.value = activeScreen().id;
  const tsel = $('screen-select');
  tsel.innerHTML = opts;
  tsel.value = activeScreen().id;
  tsel.classList.toggle('hidden', !(project.screens.length > 1 && view === 'output' && page === 'editor'));
  const slsel = $('sl-screen');
  slsel.innerHTML = opts;
  const rpsel = $('rp-screen-select');
  rpsel.innerHTML = opts;
  if (!project.screens.some((sc) => sc.id === rp.screenId)) rp.screenId = project.screens[0].id;
  rpsel.value = rp.screenId;
  rpsel.classList.toggle('hidden', !(project.screens.length > 1 && rp.viewMode === 'output'));
  const sc = activeScreen();
  $('scr-name').value = sc.name;
  $('out-w').value = sc.width;
  $('out-h').value = sc.height;
  $('p-screen-del').disabled = project.screens.length <= 1;
}

function refreshProps() {
  const s = selected();
  const sec = $('slice-props');
  sec.style.opacity = s ? 1 : 0.4;
  const set = (id, val) => { $(id).value = val; };
  if (!s) {
    ['sl-name', 'sl-in-x', 'sl-in-y', 'sl-in-w', 'sl-in-h', 'sl-out-x', 'sl-out-y', 'sl-out-w', 'sl-out-h', 'mask-x', 'mask-y', 'mask-w', 'mask-h'].forEach((id) => ($(id).value = ''));
    $('sl-enabled').checked = false;
    $('mask-enabled').checked = false;
    $('mask-edit').checked = false;
    return;
  }
  set('sl-name', s.name);
  $('sl-enabled').checked = s.enabled !== false;
  $('sl-screen').value = sliceScreenId(s);
  set('sl-in-x', s.in.x); set('sl-in-y', s.in.y); set('sl-in-w', s.in.w); set('sl-in-h', s.in.h);
  set('sl-out-x', s.out.x); set('sl-out-y', s.out.y); set('sl-out-w', s.out.w); set('sl-out-h', s.out.h);
  $('sl-in-rot').value = String(s.inOrient || 0);
  $('sl-out-rot').value = String(s.outOrient || 0);
  $('flip-label').textContent = FLIP_LABELS[s.flip || 0];
  $('flip-pac').setAttribute('d', FLIP_PATHS[s.flip || 0]);
  $('sl-flip').classList.toggle('active', !!s.flip);

  const bb = s.mask ? Geometry.maskBBox(s.mask) : null;
  $('mask-enabled').checked = !!(s.mask && s.mask.enabled);
  $('mask-edit').checked = maskEdit;
  set('mask-x', bb ? bb.x : '');
  set('mask-y', bb ? bb.y : '');
  set('mask-w', bb ? bb.w : '');
  set('mask-h', bb ? bb.h : '');
}

function refreshProjectFields() {
  $('p-name').value = project.name;
  $('in-w').value = project.input.width;
  $('in-h').value = project.input.height;
  refreshScreenSelectors();
}

function refreshRefPanel() {
  $('ref-view-label').textContent = view === 'input' ? 'Input' : 'Output';
  const ref = project.refs[view];
  $('ref-name').textContent = ref ? ref.name || 'image' : 'no image';
  $('ref-opacity').value = Math.round(((ref && ref.opacity) != null ? ref.opacity : 0.6) * 100);
}

function refreshEngineInfo() {
  const el = $('ffmpeg-info');
  if (!caps || !caps.entries || !caps.entries.length) {
    el.innerHTML = 'ffmpeg not found';
    return;
  }
  const main = caps.entries[0];
  const tag = (okFlag, name) =>
    okFlag ? `<span style="color:#f7941e">${name} ✓</span>` : `${name} ✗`;
  el.innerHTML = `ffmpeg ${main.version}<br>ProRes ✓ · ${tag(caps.hasDxv, 'DXV3')} · ${tag(caps.hasHap, 'HAP')} · ${tag(caps.hasX265, 'HEVC')}`;
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
  view = v;
  $('tab-input').classList.toggle('active', v === 'input');
  $('tab-output').classList.toggle('active', v === 'output');
  refreshRefPanel();
  refreshSliceList();
  refreshScreenSelectors();
  updateZoomLabel();
  draw();
}

function switchPage(p) {
  page = p;
  $('editor-page').classList.toggle('hidden', p !== 'editor');
  $('render-page').classList.toggle('hidden', p !== 'render');
  $('btn-render').classList.toggle('hidden', p === 'render');
  $('btn-back-editor').classList.toggle('hidden', p !== 'render');
  ['tb-editor-left', 'view-tabs'].forEach((id) => $(id).classList.toggle('hidden', p === 'render'));
  document.querySelectorAll('#toolbar .zoom, #toolbar .tb-sep').forEach((el) => el.classList.toggle('hidden', p === 'render'));
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
  selId = s.id;
  refreshSliceList();
  refreshProps();
  draw();
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
  selId = c.id;
  refreshSliceList();
  refreshProps();
  draw();
  markDirty();
}

function deleteSlice() {
  const s = selected();
  if (!s) return;
  pushHistory();
  project.slices.splice(project.slices.indexOf(s), 1);
  selId = null;
  refreshSliceList();
  refreshProps();
  draw();
  markDirty();
}

function autoSplitSlice(s, partW, rowH, startX, startY, gapY) {
  const n = Math.max(1, Math.ceil(s.out.w / partW));
  const parts = [];
  for (let i = 0; i < n; i++) {
    const ox0 = i * partW;
    const ow = Math.min(partW, s.out.w - ox0);
    const fx0 = ox0 / s.out.w;
    const fx1 = (ox0 + ow) / s.out.w;
    parts.push(newSliceDefaults({
      id: uid(),
      name: `${s.name} ${i + 1}/${n}`,
      screenId: sliceScreenId(s),
      in: {
        x: Math.round(s.in.x + fx0 * s.in.w),
        y: s.in.y,
        w: Math.round((fx1 - fx0) * s.in.w),
        h: s.in.h,
      },
      out: {
        x: Math.round(startX),
        y: Math.round(startY + i * (rowH + gapY)),
        w: Math.round(ow),
        h: Math.round(rowH),
      },
    }));
  }
  const idx = project.slices.indexOf(s);
  project.slices.splice(idx, 1, ...parts);
  selId = parts[0].id;
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

function openSplitModal() {
  const s = selected();
  if (!s) {
    alert('Select a slice first.');
    return;
  }
  const sc = activeScreen();
  const defW = Math.min(sc.width, s.out.w);
  openModal(`
    <div class="modal" style="width:440px">
      <div class="modal-head">Split "${s.name}" into rows<button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body">
        <div class="note">A wide LED screen often doesn't fit the output width in one piece.
        This cuts the slice into equal parts and stacks them as rows on the output canvas —
        exactly like the multi-row setup in Resolume. The input stays one continuous strip.</div>
        <div class="row"><label style="min-width:110px">Part width</label><input type="number" id="m-partw" class="num" style="width:90px" value="${defW}" /><span class="dim">px per row</span></div>
        <div class="row"><label style="min-width:110px">Row height</label><input type="number" id="m-rowh" class="num" style="width:90px" value="${s.out.h}" /><span class="dim">px</span></div>
        <div class="row"><label style="min-width:110px">Start X</label><input type="number" id="m-startx" class="num" style="width:90px" value="0" /></div>
        <div class="row"><label style="min-width:110px">Start Y</label><input type="number" id="m-starty" class="num" style="width:90px" value="0" /></div>
        <div class="row"><label style="min-width:110px">Row gap Y</label><input type="number" id="m-gapy" class="num" style="width:90px" value="0" /><span class="dim">px between rows</span></div>
        <div class="split-summary" id="m-summary"></div>
      </div>
      <div class="modal-foot">
        <button id="m-cancel">Cancel</button>
        <button id="m-apply" class="accent">Split</button>
      </div>
    </div>
  `);
  const updateSummary = () => {
    const partW = clampInt($('m-partw').value, 1, 100000);
    const n = Math.max(1, Math.ceil(s.out.w / partW));
    const last = s.out.w - (n - 1) * partW;
    const rowH = clampInt($('m-rowh').value, 1, 100000);
    const gap = clampInt($('m-gapy').value, 0, 100000);
    const totalH = n * rowH + (n - 1) * gap;
    $('m-summary').textContent =
      `→ ${n} rows: ${n > 1 ? `${n - 1} × ${partW}px + 1 × ${last}px` : `1 × ${last}px`}, ` +
      `total ${totalH}px high on output (canvas ${sc.height}px)`;
  };
  ['m-partw', 'm-rowh', 'm-gapy'].forEach((id) => ($(id).oninput = updateSummary));
  updateSummary();
  $('m-close').onclick = closeModal;
  $('m-cancel').onclick = closeModal;
  $('m-apply').onclick = () => {
    pushHistory();
    autoSplitSlice(
      s,
      clampInt($('m-partw').value, 1, 100000),
      clampInt($('m-rowh').value, 1, 100000),
      clampInt($('m-startx').value, -100000, 100000),
      clampInt($('m-starty').value, -100000, 100000),
      clampInt($('m-gapy').value, 0, 100000)
    );
    closeModal();
    refreshSliceList();
    refreshProps();
    draw();
    markDirty();
  };
}

// Ask how to export multiple screens: separate / merged / both
function askOutputMode() {
  return new Promise((resolve) => {
    const remembered = localStorage.getItem('xre:outmode') || 'separate';
    openModal(`
      <div class="modal" style="width:430px">
        <div class="modal-head">Multiple outputs<button class="close-x" id="m-close">✕</button></div>
        <div class="modal-body">
          <div class="note">This project has ${project.screens.length} screens. How do you want to export them?</div>
          <div class="radio-col">
            <label><input type="radio" name="m-outmode" value="separate" ${remembered === 'separate' ? 'checked' : ''} /> Separate file per screen</label>
            <label><input type="radio" name="m-outmode" value="merged" ${remembered === 'merged' ? 'checked' : ''} /> One merged video (screens side by side)</label>
            <label><input type="radio" name="m-outmode" value="both" ${remembered === 'both' ? 'checked' : ''} /> Both</label>
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
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(IW * k));
  c.height = Math.max(2, Math.round(IH * k));
  const g = c.getContext('2d');

  // checker background
  const cell = Math.max(10, Math.round(50 * k));
  for (let y = 0, j = 0; y < c.height; y += cell, j++) {
    for (let x = 0, i = 0; x < c.width; x += cell, i++) {
      g.fillStyle = (i + j) % 2 ? '#26292d' : '#33373c';
      g.fillRect(x, y, cell, cell);
    }
  }
  // 100px grid, stronger every 500px
  for (let x = 0; x <= IW; x += 100) {
    g.strokeStyle = x % 500 === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x * k, 0); g.lineTo(x * k, c.height); g.stroke();
  }
  for (let y = 0; y <= IH; y += 100) {
    g.strokeStyle = y % 500 === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
    g.beginPath(); g.moveTo(0, y * k); g.lineTo(c.width, y * k); g.stroke();
  }

  const colors = ['#f7941e', '#35e0b2', '#4fa3ff', '#e85dd0', '#ffd028', '#7fe860'];
  project.slices.forEach((s, i) => {
    if (s.enabled === false) return;
    const col = colors[i % colors.length];
    const x = s.in.x * k, y = s.in.y * k, w = s.in.w * k, h = s.in.h * k;
    g.strokeStyle = col;
    g.lineWidth = Math.max(1.5, 3 * k);
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    g.beginPath();
    g.moveTo(x, y); g.lineTo(x + w, y + h);
    g.moveTo(x + w, y); g.lineTo(x, y + h);
    g.stroke();
    g.beginPath();
    g.arc(x + w / 2, y + h / 2, Math.max(4, Math.min(w, h) / 2 - 2), 0, Math.PI * 2);
    g.stroke();

    // label pill that always fits inside the slice
    const label = `${i + 1} · ${s.name} · ${s.in.w}×${s.in.h}`;
    let fs = Math.min(h * 0.28, 64 * Math.max(k, 0.5), w * 0.5);
    fs = Math.max(9, fs);
    g.font = `bold ${fs}px -apple-system, sans-serif`;
    while (fs > 9 && g.measureText(label).width > w * 0.85) {
      fs *= 0.92;
      g.font = `bold ${fs}px -apple-system, sans-serif`;
    }
    const tw = g.measureText(label).width;
    const pw = tw + fs * 1.2, ph = fs * 1.7;
    g.fillStyle = 'rgba(8,10,12,0.82)';
    g.fillRect(x + w / 2 - pw / 2, y + h / 2 - ph / 2, pw, ph);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, x + w / 2, y + h / 2 + fs * 0.05);
  });
  return c;
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
  project.refs.input = { dataUrl: c.toDataURL('image/png'), name: 'test pattern', opacity: 0.9 };
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

// ---------------- export page ----------------
const rp = {
  files: [], // {path, isImage, probe, transform, frameImg, frameTime, curTime, selected, inSec, outSec}
  activeIndex: -1,
  destDir: null,
  running: false,
  viewMode: 'input',
  screenId: null,
  watchDir: null,
  watching: false,
  watchQueue: [],
  vt: { scale: 0.1, ox: 40, oy: 40 },
};
let rpCanvas, rpCtx;
let frameTimer = null;
let rpDrag = null; // clip dragging / timeline dragging

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
  }));
  markDirty();
}

function loadExportListFromProject() {
  const list = project.exportList || [];
  rp.files = list.map((e) => ({
    path: e.path,
    isImage: isImagePath(e.path),
    probe: null,
    transform: Object.assign(Geometry.defaultTransform(), e.transform || {}),
    frameImg: null,
    frameTime: 0,
    curTime: 0,
    selected: e.selected !== false,
    inSec: e.inSec != null ? e.inSec : null,
    outSec: e.outSec != null ? e.outSec : null,
  }));
  rp.activeIndex = rp.files.length ? 0 : -1;
  refreshFileList();
  refreshClipControls();
  // probe async, refresh as results come in
  rp.files.forEach(async (f) => {
    try {
      f.probe = await api.previewProbe(f.path);
    } catch (e) {
      f.probe = null;
    }
    refreshFileList();
    if (activeFile() === f) {
      refreshClipControls();
      layoutTimeline();
      fetchFrame(true);
    }
  });
  if (rp.files.length) selectFile(0);
  else {
    layoutTimeline();
    drawRenderPreview();
  }
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
  rpCtx.fillStyle = '#202426';
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

  rpCtx.strokeStyle = '#42484c';
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
    row.className = 'file-row' + (i === rp.activeIndex ? ' selected' : '') + (edited ? ' edited' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = f.selected !== false;
    cb.title = 'Include in export';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      f.selected = cb.checked;
      updateStartButton();
      syncExportList();
    });
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = f.isImage ? 'IMG' : 'VID';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.title = f.path;
    nm.textContent = baseName(f.path);
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = f.probe && f.probe.width ? `${f.probe.width}×${f.probe.height}` : '';
    row.append(cb, tag, nm, sz);
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
  });
  updateStartButton();
  $('rp-clip-name').textContent = activeFile() ? baseName(activeFile().path) : 'no selection';
}

function updateStartButton() {
  $('r-start').disabled = !rp.files.some((f) => f.selected !== false) || rp.running;
}

async function addFootage(paths, opts) {
  let firstNew = -1;
  for (const p of paths) {
    if (rp.files.some((f) => f.path === p)) continue;
    const f = {
      path: p,
      isImage: isImagePath(p),
      probe: null,
      transform: Geometry.defaultTransform(),
      frameImg: null,
      frameTime: 0,
      curTime: 0,
      selected: true,
      inSec: null,
      outSec: null,
    };
    if (firstNew < 0) firstNew = rp.files.length;
    rp.files.push(f);
    try {
      f.probe = await api.previewProbe(p);
    } catch (e) {
      f.probe = null;
    }
  }
  if (!rp.destDir && rp.files.length) {
    const pp = await api.pathParse(rp.files[0].path);
    rp.destDir = pp.dir;
    $('r-dest').textContent = rp.destDir;
  }
  syncExportList();
  if ((rp.activeIndex < 0 || (opts && opts.select)) && firstNew >= 0) {
    selectFile(firstNew);
  } else {
    refreshFileList();
  }
  refreshCodecUI();
}

function selectFile(i) {
  rp.activeIndex = i;
  const f = activeFile();
  refreshFileList();
  refreshClipControls();
  layoutTimeline();
  if (f) fetchFrame(true);
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
  if (usable) {
    const trimmed = (f.inSec != null || f.outSec != null);
    $('tl-len').textContent = trimmed
      ? `${fmtTC(inSec)} → ${fmtTC(outSec)} · ${(outSec - inSec).toFixed(2)}s of ${dur.toFixed(2)}s`
      : `length ${dur.toFixed(2)}s`;
  } else {
    $('tl-len').textContent = f && f.isImage ? 'still image' : '—';
  }
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
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = setTimeout(async () => {
    const time = f.isImage ? 0 : f.curTime || 0;
    try {
      const dataUrl = await api.previewFrame(f.path, time);
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
    parts.push(pr.hasAudio ? 'audio ✓' : 'no audio');
    rows.push(parts.join(' · '));
  }
  el.innerHTML = rows.join('<br>');
}

function scaleLinked(tr) {
  return tr.scaleY == null;
}

function refreshClipControls() {
  const f = activeFile();
  const tr = f ? f.transform : Geometry.defaultTransform();
  $('rp-clip-section').style.opacity = f ? 1 : 0.4;
  refreshClipInfo();
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
    return;
  }
  const lay = Geometry.clipLayout(f.probe.width, f.probe.height, f.transform, project.input.width, project.input.height);
  el.textContent = `→ clip ${Math.round(lay.bw)}×${Math.round(lay.bh)} px on canvas ${project.input.width}×${project.input.height}`;
}

function bindClipControls() {
  const upd = (fn) => {
    const f = activeFile();
    if (!f) return;
    fn(f.transform);
    refreshFileList();
    refreshPixelReadout();
    drawRenderPreview();
    syncExportList();
  };
  $('ct-mode').onchange = () => upd((t) => (t.mode = $('ct-mode').value));
  $('ct-x').onchange = () => upd((t) => (t.x = clampInt($('ct-x').value, -100000, 100000)));
  $('ct-y').onchange = () => upd((t) => (t.y = clampInt($('ct-y').value, -100000, 100000)));
  $('ct-scale').oninput = () => { $('ct-scale-n').value = $('ct-scale').value; upd((t) => (t.scale = parseFloat($('ct-scale').value))); };
  $('ct-scale-n').onchange = () => { $('ct-scale').value = $('ct-scale-n').value; upd((t) => (t.scale = Math.max(1, parseFloat($('ct-scale-n').value) || 100))); };
  $('ct-scaley').oninput = () => { $('ct-scaley-n').value = $('ct-scaley').value; upd((t) => (t.scaleY = parseFloat($('ct-scaley').value))); };
  $('ct-scaley-n').onchange = () => { $('ct-scaley').value = $('ct-scaley-n').value; upd((t) => (t.scaleY = Math.max(1, parseFloat($('ct-scaley-n').value) || 100))); };
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
  $('ct-rot-n').onchange = () => { $('ct-rot').value = $('ct-rot-n').value; upd((t) => (t.rotation = parseFloat($('ct-rot-n').value) || 0)); };
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
  sel.value = prev && Codecs.byId(prev) ? prev : 'prores_hq';
  if (!sel.value) sel.value = 'prores_hq';
}

function runtimeUnsupported(c) {
  if (!caps) return false;
  if (c.id === 'dxv' && !caps.hasDxv) return true;
  if ((c.id === 'hap' || c.id === 'hap_q') && !caps.hasHap) return true;
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
  $('r-gpu').disabled = !Codecs.gpuCapable(def.id);
  const notes = [];
  if (def.unsupported) notes.push(def.unsupported);
  if (def.id === 'dxv') notes.push('DXT1 — plays natively in Resolume.');
  if (def.sequence) notes.push('Frames are written into a new folder per export.');
  if (def.still) notes.push('One remapped frame at the current preview time — ideal for PowerPoint.');
  if (def.id === 'prores_4444' && $('r-alpha').value !== 'none') notes.push('Alpha requires footage with an alpha channel.');
  $('r-codec-note').textContent = notes.join(' ');
  const anyImage = rp.files.some((f) => f.selected !== false && f.isImage);
  $('r-still-row').style.display = anyImage && !def.still ? '' : 'none';
  updateStartButton();
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
  $('r-codec-note').textContent = m.note;
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
async function startRender(filesOverride, optsOverride) {
  if (rp.running) return;
  const files = filesOverride || rp.files.filter((f) => f.selected !== false);
  if (!files.length) return;
  const codecId = $('r-codec').value;
  const def = Codecs.byId(codecId);
  const alpha = $('r-alpha').value;
  const depth = parseInt($('r-depth').value, 10);
  const bitrateMbps = parseFloat($('r-bitrate').value) || null;
  const fps = clampInt($('r-fps').value, 1, 240);
  const imageDuration = clampInt($('r-dur').value, 1, 3600);
  const gpu = $('r-gpu').checked;

  // multiple screens: separate / merged / both
  let outMode = 'separate';
  if (project.screens.length > 1) {
    outMode = (optsOverride && optsOverride.mode) || (await askOutputMode());
    if (!outMode) return;
  }

  const targets = []; // {proj, screen, suffix}
  if (outMode === 'separate' || outMode === 'both') {
    for (const scr of project.screens) {
      targets.push({
        proj: null, // use main project
        screen: scr,
        suffix: project.screens.length > 1 ? `_${sanitizeName(scr.name)}` : '',
      });
    }
  }
  if (outMode === 'merged' || outMode === 'both') {
    const merged = buildMergedProject();
    targets.push({ proj: merged, screen: merged.screens[0], suffix: '_merged' });
  }

  const jobs = [];
  for (const tgt of targets) {
    const projForJob = tgt.proj || null;
    const projUsed = projForJob || project;
    const maskFiles = await buildMaskFiles(projUsed, tgt.screen.id);
    let OW = Math.round(tgt.screen.width);
    let OH = Math.round(tgt.screen.height);
    if (OW % 2) OW += 1;
    if (OH % 2) OH += 1;
    for (const f of files) {
      const pp = await api.pathParse(f.path);
      const dest = rp.destDir || pp.dir;
      const stem = `${pp.base}_remap_${codecId}${alpha !== 'none' ? '_' + alpha : ''}_${OW}x${OH}${tgt.suffix}`;
      let outPath, outDir = null;
      if (def.sequence) {
        outDir = await api.pathJoin(dest, stem + '_seq');
        outPath = await api.pathJoin(outDir, 'frame_%05d.png');
      } else {
        outPath = await api.pathJoin(dest, `${stem}.${def.ext}`);
      }
      jobs.push({
        src: f.path,
        isImage: f.isImage,
        outPath,
        outDir,
        transform: f.transform,
        inSec: f.inSec,
        outSec: f.outSec,
        pngTime: def.still && !def.sequence && !f.isImage ? f.frameTime || f.inSec || 0 : 0,
        screen: { id: tgt.screen.id, name: tgt.screen.name, width: tgt.screen.width, height: tgt.screen.height },
        maskFiles,
        project: projForJob || undefined,
        label: targets.length > 1 || project.screens.length > 1 ? `${baseName(f.path)} → ${tgt.screen.name}` : baseName(f.path),
      });
    }
  }

  rp.running = true;
  updateStartButton();
  $('rp-add').disabled = true;
  $('r-progress').style.display = '';
  $('r-log').innerHTML = '';
  $('r-bar').style.width = '0%';

  const payload = {
    project: {
      name: project.name,
      input: project.input,
      screens: project.screens,
      slices: project.slices,
    },
    jobs,
    codec: codecId,
    alpha,
    depth,
    bitrateMbps,
    fps,
    imageDuration,
    gpu,
  };
  try {
    await api.renderStart(payload);
  } catch (err) {
    $('r-log').innerHTML += `<div class="err">✗ ${String(err.message || err).split('\n')[0]}</div>`;
  }
  rp.running = false;
  updateStartButton();
  $('rp-add').disabled = false;
  processWatchQueue();
}

function onRenderEvent(ev) {
  const bar = $('r-bar'), plabel = $('r-plabel'), ppct = $('r-ppct'), log = $('r-log');
  if (!bar) return;
  const jobPart = 100 / Math.max(1, ev.total);
  if (ev.type === 'job-start') {
    plabel.textContent = `(${ev.index + 1}/${ev.total}) ${ev.label || baseName(ev.file)}`;
    bar.style.width = `${ev.index * jobPart}%`;
    ppct.textContent = '0%';
  } else if (ev.type === 'progress') {
    bar.style.width = `${ev.index * jobPart + (ev.percent / 100) * jobPart}%`;
    ppct.textContent = `${Math.round(ev.percent)}%`;
  } else if (ev.type === 'job-note') {
    const div = document.createElement('div');
    div.textContent = `ℹ ${ev.note}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  } else if (ev.type === 'job-done') {
    bar.style.width = `${(ev.index + 1) * jobPart}%`;
    const div = document.createElement('div');
    div.className = 'ok';
    div.textContent = `✓ ${ev.label || baseName(ev.out)} `;
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = 'show in Finder';
    a.onclick = (e) => { e.preventDefault(); api.showInFolder(ev.out); };
    div.appendChild(a);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  } else if (ev.type === 'job-error') {
    const div = document.createElement('div');
    div.className = 'err';
    div.textContent = `✗ ${ev.label ? ev.label + ': ' : ''}${String(ev.error).split('\n')[0]}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  } else if (ev.type === 'batch-done') {
    plabel.textContent = ev.cancelled ? 'Cancelled' : 'Done';
    if (!ev.cancelled) { bar.style.width = '100%'; ppct.textContent = '100%'; }
  }
}

// ---------------- watch folder ----------------
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
    if (f) {
      if (rp.running) {
        rp.watchQueue.push(f);
      } else {
        startRender([f], { mode: localStorage.getItem('xre:outmode') || 'separate' });
      }
    }
  }
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

async function switchToProject(p) {
  project = migrateProject(p);
  selId = null;
  activeScreenId = project.screens[0].id;
  await loadAllRefs();
  loadExportListFromProject();
  fitView('input');
  fitView('output');
  refreshAll();
  markDirty();
}

async function importXmlPath(p) {
  try {
    const text = await api.readFileText(p);
    const proj = Resolume.parseScreenSetup(text);
    proj.refs = { input: null, output: null };
    proj.slices.forEach((s) => (s.id = uid()));
    pushHistory();
    await switchToProject(proj);
  } catch (err) {
    alert('Import failed: ' + (err.message || err));
  }
}

async function exportXml() {
  const p = await api.saveDialog({
    title: 'Export as Resolume XML',
    defaultPath: (project.name || 'mapping').replace(/[/\\:]/g, '-') + '.xml',
    filters: [{ name: 'XML', extensions: ['xml'] }],
  });
  if (!p) return;
  await api.writeFileText(p, Resolume.exportScreenSetup(project));
}

async function saveProject() {
  const p = await api.saveDialog({
    title: 'Save project',
    defaultPath: (project.name || 'project').replace(/[/\\:]/g, '-') + '.xreproj',
    filters: [{ name: 'XtremeLED Remap project', extensions: ['xreproj'] }],
  });
  if (!p) return;
  await api.writeFileText(p, JSON.stringify(project, null, 2));
}

async function openProject() {
  const paths = await api.openDialog({
    title: 'Open project',
    filters: [{ name: 'XtremeLED Remap project', extensions: ['xreproj', 'json'] }],
  });
  if (!paths.length) return;
  try {
    const text = await api.readFileText(paths[0]);
    pushHistory();
    await switchToProject(JSON.parse(text));
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
  project.refs[view] = { dataUrl, name: pp.base + pp.ext, opacity: parseInt($('ref-opacity').value, 10) / 100 };
  await loadRefImage(view);
  refreshRefPanel();
  draw();
  markDirty();
}

// ---------------- bind UI ----------------
function bindUI() {
  $('tab-input').onclick = () => switchView('input');
  $('tab-output').onclick = () => switchView('output');
  $('btn-render').onclick = () => switchPage('render');
  $('btn-back-editor').onclick = () => switchPage('editor');

  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;

  $('btn-zoom-in').onclick = () => { const c = cssSize(); zoomAt(c.w / 2, c.h / 2, 1.25); };
  $('btn-zoom-out').onclick = () => { const c = cssSize(); zoomAt(c.w / 2, c.h / 2, 0.8); };
  $('btn-zoom-fit').onclick = () => { fitView(view); draw(); };

  $('btn-new').onclick = async () => {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;
    pushHistory();
    await switchToProject(newProject());
  };
  $('btn-open-proj').onclick = openProject;
  $('btn-save-proj').onclick = saveProject;
  $('btn-import-xml').onclick = importXml;
  $('btn-export-xml').onclick = exportXml;

  $('btn-add-slice').onclick = addSlice;
  $('btn-dup-slice').onclick = duplicateSlice;
  $('btn-del-slice').onclick = deleteSlice;
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
      draw();
      drawRenderPreview();
      markDirty();
    };
  };
  bindInputDim('in-w', 'width');
  bindInputDim('in-h', 'height');

  $('p-screen-select').onchange = () => {
    activeScreenId = $('p-screen-select').value;
    refreshScreenSelectors();
    if (view === 'output') fitView('output');
    refreshSliceList();
    draw();
  };
  $('screen-select').onchange = () => {
    activeScreenId = $('screen-select').value;
    refreshScreenSelectors();
    fitView('output');
    refreshSliceList();
    draw();
  };
  $('p-screen-add').onclick = () => {
    pushHistory();
    const n = project.screens.length + 1;
    const sc = { id: 'scr' + Math.random().toString(36).slice(2, 7), name: 'Output #' + n, width: 1920, height: 1080 };
    project.screens.push(sc);
    activeScreenId = sc.id;
    refreshScreenSelectors();
    refreshSliceList();
    draw();
    markDirty();
  };
  $('p-screen-del').onclick = () => {
    if (project.screens.length <= 1) return;
    const sc = activeScreen();
    if (!confirm(`Delete screen "${sc.name}"? Its slices move to the first screen.`)) return;
    pushHistory();
    project.screens.splice(project.screens.indexOf(sc), 1);
    project.slices.forEach((s) => {
      if (s.screenId === sc.id) s.screenId = project.screens[0].id;
    });
    activeScreenId = project.screens[0].id;
    refreshScreenSelectors();
    refreshSliceList();
    draw();
    markDirty();
  };
  $('scr-name').onchange = () => {
    pushHistory();
    activeScreen().name = $('scr-name').value || 'Output';
    refreshScreenSelectors();
    refreshSliceList();
    markDirty();
  };
  const bindScreenDim = (id, key) => {
    $(id).onchange = () => {
      pushHistory();
      activeScreen()[key] = clampInt($(id).value, 1, 32768);
      $(id).value = activeScreen()[key];
      refreshScreenSelectors();
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
      r[key] = clampInt($(id).value, isSize ? 1 : -100000, 100000);
      $(id).value = r[key];
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
  $('mask-edit').onchange = () => {
    maskEdit = $('mask-edit').checked;
    draw();
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
      onMouseMove({ offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, clientX: e.clientX, clientY: e.clientY });
    }
  });
  canvas.addEventListener('mousemove', (e) => { if (!drag) onMouseMove(e); });
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('input[type="range"][data-default]')) {
      e.preventDefault();
      t.value = t.dataset.default;
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (page === 'render') {
      if (e.key.toLowerCase() === 'i') { $('rp-set-in').click(); return; }
      if (e.key.toLowerCase() === 'o') { $('rp-set-out').click(); return; }
      return;
    }
    if (e.code === 'Space') { spaceDown = true; canvas.style.cursor = 'grab'; return; }
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
    const projs = paths.filter((p) => ['xreproj', 'json'].includes(extOf(p)));
    const imgs = paths.filter(isImagePath);
    const vids = paths.filter((p) => VIDEO_EXTS.includes(extOf(p)));
    if (xmls.length) return importXmlPath(xmls[0]);
    if (projs.length) {
      try {
        pushHistory();
        await switchToProject(JSON.parse(await api.readFileText(projs[0])));
      } catch (err) {
        alert('Open failed: ' + (err.message || err));
      }
      return;
    }
    if (page === 'render' && (imgs.length || vids.length)) return addFootage([...imgs, ...vids]);
    if (imgs.length && page === 'editor') return setReferenceFromPath(imgs[0]);
    if (vids.length || imgs.length) {
      switchPage('render');
      return addFootage([...imgs, ...vids]);
    }
  });

  // export page
  $('rp-tab-input').onclick = () => {
    rp.viewMode = 'input';
    $('rp-tab-input').classList.add('active');
    $('rp-tab-output').classList.remove('active');
    refreshScreenSelectors();
    fitRenderView();
    drawRenderPreview();
  };
  $('rp-tab-output').onclick = () => {
    rp.viewMode = 'output';
    $('rp-tab-output').classList.add('active');
    $('rp-tab-input').classList.remove('active');
    refreshScreenSelectors();
    fitRenderView();
    drawRenderPreview();
  };
  $('rp-screen-select').onchange = () => {
    rp.screenId = $('rp-screen-select').value;
    fitRenderView();
    drawRenderPreview();
  };
  $('rp-add').onclick = async () => {
    const paths = await api.openDialog({
      title: 'Choose stageview footage',
      multi: true,
      filters: [
        { name: 'Footage', extensions: [...IMAGE_EXTS, ...VIDEO_EXTS] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (paths.length) addFootage(paths, { select: true });
  };
  $('rp-testpattern').onclick = addTestPattern;
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
  $('rp-refresh').onclick = () => fetchFrame(true);
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
  $('r-codec').onchange = refreshCodecUI;
  $('r-alpha').onchange = refreshCodecUI;
  $('r-same-as-source').onclick = sameAsSource;
  $('r-gpu').checked = localStorage.getItem('xre:gpu') === '1';
  $('r-gpu').onchange = () => localStorage.setItem('xre:gpu', $('r-gpu').checked ? '1' : '0');
  $('r-dest-btn').onclick = async () => {
    const dir = await api.openDirDialog({ title: 'Choose output folder' });
    if (dir) {
      rp.destDir = dir;
      $('r-dest').textContent = dir;
    }
  };
  $('r-start').onclick = () => startRender();
  $('r-cancel').onclick = () => api.renderCancel();
  bindClipControls();
  bindTimeline();
  bindPreviewDrag();

  $('w-choose').onclick = async () => {
    const dir = await api.openDirDialog({ title: 'Choose watch folder' });
    if (!dir) return;
    rp.watchDir = dir;
    $('w-dir').textContent = dir;
    $('w-toggle').disabled = false;
  };
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
}

// ---------------- init ----------------
window.addEventListener('DOMContentLoaded', async () => {
  canvas = $('editor');
  ctx = canvas.getContext('2d');
  rpCanvas = $('rp-canvas');
  rpCtx = rpCanvas.getContext('2d');

  const params = new URLSearchParams(location.search);
  const demo = params.get('demo') === '1';
  project = (!demo && loadLocal()) || demoProject();
  activeScreenId = project.screens[0].id;
  rp.screenId = project.screens[0].id;

  buildCodecSelect();
  bindUI();
  updateUndoButtons();
  await loadAllRefs();
  resizeCanvas();
  fitView('input');
  fitView('output');
  loadExportListFromProject();
  refreshAll();
  refreshCodecUI();

  try {
    caps = await api.ffmpegCaps();
  } catch (e) {
    caps = null;
  }
  refreshEngineInfo();
  buildCodecSelect();
  refreshCodecUI();

  if (params.get('page') === 'render') switchPage('render');
});
