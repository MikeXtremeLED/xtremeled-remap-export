'use strict';
/* XtremeLED Remap Export — slice editor + render page */

const api = window.xre;
const $ = (id) => document.getElementById(id);

// ---------------- state ----------------
let project = null;
let page = 'editor'; // 'editor' | 'render'
let view = 'input'; // 'input' | 'output'
let selId = null;
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
function worldSize(v) {
  const c = v === 'input' ? project.input : project.output;
  return { w: c.width, h: c.height };
}
function sliceRect(s, v) {
  return v === 'input' ? s.in : s.out;
}
function selected() {
  return project.slices.find((s) => s.id === selId) || null;
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
  await loadAllRefs();
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
    { enabled: true, inOrient: 0, outOrient: 0, flip: 0, mask: null },
    s
  );
}

function newProject() {
  return {
    name: 'Untitled',
    input: { width: 3840, height: 2160 },
    output: { width: 3840, height: 2160 },
    refs: { input: null, output: null },
    slices: [
      newSliceDefaults({
        id: uid(), name: 'Slice 1',
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
  return {
    name: "50x2m (100m2) P4.81 demo",
    input: { width: 10400, height: 416 },
    output: { width: 3840, height: 2160 },
    refs: {
      input: { dataUrl: checkerDataUrl(2600, 104, 26), name: 'demo test card', opacity: 0.9 },
      output: null,
    },
    slices: [
      newSliceDefaults({ id: uid(), name: '50x2m part 1/3', in: { x: 0, y: 0, w: 3744, h: 416 }, out: { x: 0, y: 0, w: 3744, h: 416 } }),
      newSliceDefaults({ id: uid(), name: '50x2m part 2/3', in: { x: 3744, y: 0, w: 3744, h: 416 }, out: { x: 0, y: 416, w: 3744, h: 416 } }),
      newSliceDefaults({ id: uid(), name: '50x2m part 3/3', in: { x: 7488, y: 0, w: 2912, h: 416 }, out: { x: 0, y: 832, w: 2912, h: 416 } }),
    ],
  };
}

function migrateProject(p) {
  if (!p || !p.input || !p.output || !Array.isArray(p.slices)) throw new Error('Invalid project file');
  p.refs = p.refs || { input: null, output: null };
  p.slices = p.slices.map((s) => newSliceDefaults(s));
  p.slices.forEach((s) => { if (!s.id) s.id = uid(); });
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

// Draw the content of a slice (from the input reference image) into its output place rect
function drawSliceContent(g, img, eff, t, kx, ky) {
  const { crop, place, rot, flip } = eff;
  const sx = crop.x * kx, sy = crop.y * ky, sw = crop.w * kx, sh = crop.h * ky;
  const pcx = (place.x + place.w / 2) * t.scale + t.ox;
  const pcy = (place.y + place.h / 2) * t.scale + t.oy;
  const swap = rot === 90 || rot === 270;
  const dw = (swap ? place.h : place.w) * t.scale;
  const dh = (swap ? place.w : place.h) * t.scale;
  g.save();
  g.translate(pcx, pcy);
  g.scale(flip & 1 ? -1 : 1, flip & 2 ? -1 : 1);
  g.rotate((rot * Math.PI) / 180);
  try {
    g.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  } catch (e) { /* out of range */ }
  g.restore();
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
    for (const eff of Geometry.effectiveSlices(project)) {
      drawSliceContent(ctx, img, eff, t, kx, ky);
    }
  }
  ctx.restore();

  ctx.strokeStyle = '#42484c';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - 0.5, cy - 0.5, cwid + 1, chei + 1);

  // slices
  for (const s of project.slices) {
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

    // input mask visual (input view only)
    if (view === 'input' && s.mask && s.mask.enabled) {
      const m = Geometry.intersect(r, s.mask);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      if (m) {
        // darken the masked-out part of the slice
        const mx = toScreenX(m.x), my = toScreenY(m.y);
        const mw = m.w * t.scale, mh = m.h * t.scale;
        ctx.rect(mx + mw, my, -mw, mh); // reverse winding = hole
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill('evenodd');
        ctx.strokeStyle = isSel ? '#ffd28a' : 'rgba(255,210,138,0.6)';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(mx + 0.5, my + 0.5, mw - 1, mh - 1);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();
      }
      ctx.restore();
    }

    // label pill
    if (w > 40 && h > 14) {
      const label = s.name;
      const extras = [];
      if (Geometry.netRotation(s)) extras.push(Geometry.netRotation(s) + '°');
      if (s.flip) extras.push('flip');
      if (s.mask && s.mask.enabled && view === 'input') extras.push('mask');
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

  // handles on selection (slice, or its mask in mask-edit mode)
  const sel = selected();
  if (sel) {
    const r = editTargetRect(sel);
    if (r) {
      const x = toScreenX(r.x), y = toScreenY(r.y);
      const w = r.w * t.scale, h = r.h * t.scale;
      for (const hd of HANDLES) {
        const hx = x + w * hd.fx, hy = y + h * hd.fy;
        ctx.fillStyle = maskEditActive() ? '#ffd28a' : '#ffffff';
        ctx.strokeStyle = '#241503';
        ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
        ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
      }
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
  return maskEdit && view === 'input' && s && s.mask && s.mask.enabled;
}

// The rect currently editable on canvas: mask (in mask-edit mode) or slice rect
function editTargetRect(s) {
  if (maskEditActive()) return s.mask;
  return sliceRect(s, view);
}

// ---------------- hit testing ----------------
function handleAt(px, py) {
  const sel = selected();
  if (!sel) return null;
  const t = vt[view];
  const r = editTargetRect(sel);
  if (!r) return null;
  const x = toScreenX(r.x), y = toScreenY(r.y);
  const w = r.w * t.scale, h = r.h * t.scale;
  for (const hd of HANDLES) {
    const hx = x + w * hd.fx, hy = y + h * hd.fy;
    if (Math.abs(px - hx) <= 6 && Math.abs(py - hy) <= 6) return hd.k;
  }
  return null;
}

function sliceAt(px, py) {
  const wpt = toWorld(px, py);
  for (let i = project.slices.length - 1; i >= 0; i--) {
    const s = project.slices[i];
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
  for (const o of project.slices) {
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

function onMouseDown(e) {
  if (!project || page !== 'editor') return;
  const px = e.offsetX, py = e.offsetY;
  const t = vt[view];

  if (e.button === 1 || spaceDown) {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: t.ox, oy: t.oy };
    return;
  }
  if (e.button !== 0) return;

  const hk = handleAt(px, py);
  if (hk) {
    const sel = selected();
    pushHistory();
    drag = { mode: 'resize', k: hk, start: toWorld(px, py), orig: { ...editTargetRect(sel) } };
    return;
  }

  // mask-edit mode: drag inside mask moves the mask
  if (maskEditActive()) {
    const sel = selected();
    const wpt = toWorld(px, py);
    const m = sel.mask;
    if (wpt.x >= m.x && wpt.x <= m.x + m.w && wpt.y >= m.y && wpt.y <= m.y + m.h) {
      pushHistory();
      drag = { mode: 'move', start: wpt, orig: { ...m } };
      return;
    }
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

function onMouseMove(e) {
  if (!project || page !== 'editor') return;
  const px = e.offsetX, py = e.offsetY;
  const wpt = toWorld(px, py);
  $('status-pos').textContent = `${view === 'input' ? 'Input' : 'Output'}: ${Math.round(wpt.x)}, ${Math.round(wpt.y)}  ·  zoom ${Math.round(vt[view].scale * 100)}%${maskEditActive() ? '  ·  MASK EDIT' : ''}`;

  if (!drag) {
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
  const target = editTargetRect(sel);
  const dx = wpt.x - drag.start.x;
  const dy = wpt.y - drag.start.y;

  if (drag.mode === 'move') {
    let nr = { x: drag.orig.x + dx, y: drag.orig.y + dy, w: drag.orig.w, h: drag.orig.h };
    if (!maskEditActive()) {
      const sn = snapDelta(nr, view);
      nr.x += sn.dx;
      nr.y += sn.dy;
    }
    target.x = Math.round(nr.x);
    target.y = Math.round(nr.y);
  } else if (drag.mode === 'resize') {
    Object.assign(target, applyResize(drag.orig, drag.k, dx, dy));
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
  for (const s of project.slices) {
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
    const sz = document.createElement('span');
    sz.className = 'sz';
    const r = sliceRect(s, view);
    sz.textContent = `${r.w}×${r.h}`;
    item.append(cb, nm, sz);
    item.addEventListener('click', () => {
      selId = s.id;
      refreshSliceList();
      refreshProps();
      draw();
    });
    list.appendChild(item);
  }
  list.scrollTop = scroll;
}

const FLIP_LABELS = ['None', 'H', 'V', 'H+V'];
// pac-man style flip indicator: wedge opens differently per state
const FLIP_PATHS = [
  'M10 2 A8 8 0 1 1 9.99 2 Z', // none: full circle
  'M10 10 L16 4 A8 8 0 1 1 16 16 Z M10 10 L4 4 A8 8 0 0 0 4 16 Z', // H: two wedges facing
  'M10 10 L4 4 A8 8 0 0 1 16 4 Z M10 10 L4 16 A8 8 0 0 0 16 16 Z', // V
  'M10 2 A8 8 0 1 1 2 10 L10 10 Z', // both: pac-man
];

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
  set('sl-in-x', s.in.x); set('sl-in-y', s.in.y); set('sl-in-w', s.in.w); set('sl-in-h', s.in.h);
  set('sl-out-x', s.out.x); set('sl-out-y', s.out.y); set('sl-out-w', s.out.w); set('sl-out-h', s.out.h);
  $('sl-in-rot').value = String(s.inOrient || 0);
  $('sl-out-rot').value = String(s.outOrient || 0);
  $('flip-label').textContent = FLIP_LABELS[s.flip || 0];
  $('flip-pac').setAttribute('d', FLIP_PATHS[s.flip || 0]);
  $('sl-flip').classList.toggle('active', !!s.flip);

  const m = s.mask;
  $('mask-enabled').checked = !!(m && m.enabled);
  $('mask-edit').checked = maskEdit;
  set('mask-x', m ? m.x : '');
  set('mask-y', m ? m.y : '');
  set('mask-w', m ? m.w : '');
  set('mask-h', m ? m.h : '');
}

function refreshProjectFields() {
  $('p-name').value = project.name;
  $('in-w').value = project.input.width;
  $('in-h').value = project.input.height;
  $('out-w').value = project.output.width;
  $('out-h').value = project.output.height;
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
  const dxvTxt = caps.hasDxv
    ? '<span style="color:#f7941e">DXV3 ✓</span>'
    : 'DXV3 ✗';
  el.innerHTML = `ffmpeg ${main.version}<br>ProRes HQ ✓ · ${dxvTxt}`;
  const dxvRow = $('dxv-radio-row');
  if (dxvRow) {
    dxvRow.classList.toggle('disabled', !caps.hasDxv);
    dxvRow.querySelector('input').disabled = !caps.hasDxv;
  }
}

function refreshAll() {
  refreshProjectFields();
  refreshRefPanel();
  refreshSliceList();
  refreshProps();
  draw();
  drawRenderPreview();
}

// ---------------- actions ----------------
function switchView(v) {
  view = v;
  $('tab-input').classList.toggle('active', v === 'input');
  $('tab-output').classList.toggle('active', v === 'output');
  refreshRefPanel();
  refreshSliceList();
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
  if (p === 'editor') {
    resizeCanvas();
  } else {
    resizeRenderCanvas();
    refreshFileList();
    drawRenderPreview();
  }
}

function addSlice() {
  pushHistory();
  const inC = project.input, outC = project.output;
  const s = newSliceDefaults({
    id: uid(),
    name: 'Slice ' + (project.slices.length + 1),
    in: { x: Math.round(inC.width / 4), y: Math.round(inC.height / 4), w: Math.round(inC.width / 2), h: Math.round(inC.height / 2) },
    out: { x: Math.round(outC.width / 4), y: Math.round(outC.height / 4), w: Math.round(outC.width / 2), h: Math.round(outC.height / 2) },
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
  const defW = Math.min(project.output.width, s.out.w);
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
      `total ${totalH}px high on output (canvas ${project.output.height}px)`;
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

// ---------------- render page ----------------
const rp = {
  files: [], // {path, isImage, probe, transform, frameImg, frameTime}
  activeIndex: -1,
  destDir: null,
  running: false,
  vt: { scale: 0.1, ox: 40, oy: 40 },
};
let rpCanvas, rpCtx;
let frameTimer = null;

function activeFile() {
  return rp.files[rp.activeIndex] || null;
}

function resizeRenderCanvas() {
  if (!rpCanvas) return;
  const rect = rpCanvas.parentElement.getBoundingClientRect();
  const tlH = $('rp-timeline') ? $('rp-timeline').offsetHeight : 36;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(50, rect.width);
  const ch = Math.max(50, rect.height - tlH);
  rpCanvas.style.width = cw + 'px';
  rpCanvas.style.height = ch + 'px';
  rpCanvas.width = Math.round(cw * dpr);
  rpCanvas.height = Math.round(ch * dpr);
  rpCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fitRenderView();
  drawRenderPreview();
}

function fitRenderView() {
  const { w: cw, h: ch } = cssSize(rpCanvas);
  const W = project.input.width, H = project.input.height;
  const margin = 40;
  const scale = Math.min((cw - margin * 2) / W, (ch - margin * 2) / H);
  rp.vt.scale = Math.max(0.001, Math.min(8, scale));
  rp.vt.ox = (cw - W * rp.vt.scale) / 2;
  rp.vt.oy = (ch - H * rp.vt.scale) / 2;
}

function drawRenderPreview() {
  if (page !== 'render' || !rpCtx || !project) return;
  const t = rp.vt;
  const { w: cw, h: ch } = cssSize(rpCanvas);
  const W = project.input.width, H = project.input.height;

  rpCtx.clearRect(0, 0, cw, ch);
  rpCtx.fillStyle = '#202426';
  rpCtx.fillRect(0, 0, cw, ch);

  const cx = W * 0 * t.scale + t.ox, cy = t.oy;
  const cwid = W * t.scale, chei = H * t.scale;

  rpCtx.save();
  rpCtx.beginPath();
  rpCtx.rect(cx, cy, cwid, chei);
  rpCtx.clip();
  drawCheckerBg(rpCtx, cx, cy, cwid, chei);

  const f = activeFile();
  if (f && f.frameImg && f.probe && f.probe.width) {
    const tr = f.transform;
    const lay = Geometry.clipLayout(f.probe.width, f.probe.height, tr, W, H);
    const b = tr.brightness || 0;
    const c = tr.contrast || 0;
    const s = tr.saturation != null ? tr.saturation : 1;
    const filters = [];
    if (b) filters.push(`brightness(${(1 + b).toFixed(3)})`);
    if (c) filters.push(`contrast(${(1 + c).toFixed(3)})`);
    if (s !== 1) filters.push(`saturate(${s.toFixed(3)})`);
    if (tr.hue) filters.push(`hue-rotate(${tr.hue}deg)`);
    if (tr.blur > 0) filters.push(`blur(${(tr.blur * t.scale).toFixed(2)}px)`);
    rpCtx.filter = filters.join(' ') || 'none';
    rpCtx.save();
    rpCtx.translate(lay.cx * t.scale + t.ox, lay.cy * t.scale + t.oy);
    rpCtx.rotate(lay.angleRad);
    rpCtx.drawImage(
      f.frameImg,
      (-lay.bw / 2) * t.scale,
      (-lay.bh / 2) * t.scale,
      lay.bw * t.scale,
      lay.bh * t.scale
    );
    rpCtx.restore();
    rpCtx.filter = 'none';
  }
  rpCtx.restore();

  rpCtx.strokeStyle = '#42484c';
  rpCtx.strokeRect(cx - 0.5, cy - 0.5, cwid + 1, chei + 1);

  // slice outlines (thin), with masks
  for (const sl of project.slices) {
    if (sl.enabled === false) continue;
    const r = sl.in;
    const x = r.x * t.scale + t.ox, y = r.y * t.scale + t.oy;
    rpCtx.strokeStyle = 'rgba(247,148,30,0.65)';
    rpCtx.lineWidth = 1;
    rpCtx.strokeRect(x + 0.5, y + 0.5, r.w * t.scale - 1, r.h * t.scale - 1);
    if (sl.mask && sl.mask.enabled) {
      const m = Geometry.intersect(r, sl.mask);
      if (m) {
        rpCtx.setLineDash([4, 3]);
        rpCtx.strokeStyle = 'rgba(255,210,138,0.5)';
        rpCtx.strokeRect(m.x * t.scale + t.ox + 0.5, m.y * t.scale + t.oy + 0.5, m.w * t.scale - 1, m.h * t.scale - 1);
        rpCtx.setLineDash([]);
      }
    }
  }

  // hint when empty
  if (!rp.files.length) {
    rpCtx.fillStyle = '#8b9195';
    rpCtx.font = '14px -apple-system, sans-serif';
    rpCtx.textAlign = 'center';
    rpCtx.fillText('Add footage to preview it on the input map', cw / 2, ch / 2);
  }
}

function refreshFileList() {
  const list = $('rp-files');
  if (!list) return;
  list.innerHTML = '';
  if (!rp.files.length) {
    list.innerHTML = '<div class="file-empty">Add stageview footage (image or video), or drop files here.</div>';
  }
  rp.files.forEach((f, i) => {
    const row = document.createElement('div');
    const edited = !Geometry.isIdentityTransform(f.transform);
    row.className = 'file-row' + (i === rp.activeIndex ? ' selected' : '') + (edited ? ' edited' : '');
    row.innerHTML = `<span class="tag">${f.isImage ? 'IMG' : 'VID'}</span><span class="nm" title="${f.path}">${baseName(f.path)}</span><span class="sz">${f.probe && f.probe.width ? f.probe.width + '×' + f.probe.height : ''}</span>`;
    row.onclick = () => selectFile(i);
    list.appendChild(row);
  });
  $('r-start').disabled = !rp.files.length || rp.running;
  $('rp-clip-name').textContent = activeFile() ? baseName(activeFile().path) : 'no selection';
}

async function addFootage(paths) {
  for (const p of paths) {
    if (rp.files.some((f) => f.path === p)) continue;
    const f = {
      path: p,
      isImage: isImagePath(p),
      probe: null,
      transform: Geometry.defaultTransform(),
      frameImg: null,
      frameTime: 0,
    };
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
  if (rp.activeIndex < 0 && rp.files.length) {
    selectFile(0);
  } else {
    refreshFileList();
  }
}

function selectFile(i) {
  rp.activeIndex = i;
  const f = activeFile();
  refreshFileList();
  refreshClipControls();
  if (f) {
    const dur = f.probe && f.probe.durationSec ? f.probe.durationSec : 0;
    $('rp-time').max = f.isImage ? 0 : Math.max(0, dur - 0.05).toFixed(2);
    $('rp-time').value = Math.min(parseFloat($('rp-time').value) || 0, parseFloat($('rp-time').max));
    $('rp-time').disabled = f.isImage;
    updateTimeLabel();
    fetchFrame(true);
  }
  drawRenderPreview();
}

function updateTimeLabel() {
  $('rp-timelabel').textContent = `${(parseFloat($('rp-time').value) || 0).toFixed(2)} s`;
}

function fetchFrame(immediate) {
  const f = activeFile();
  if (!f) return;
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = setTimeout(async () => {
    const time = f.isImage ? 0 : parseFloat($('rp-time').value) || 0;
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

function refreshClipControls() {
  const f = activeFile();
  const tr = f ? f.transform : Geometry.defaultTransform();
  $('rp-clip-section').style.opacity = f ? 1 : 0.4;
  $('ct-mode').value = tr.mode;
  $('ct-x').value = tr.x;
  $('ct-y').value = tr.y;
  $('ct-scale').value = tr.scale;
  $('ct-scale-n').value = tr.scale;
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
}

function bindClipControls() {
  const upd = (fn) => {
    const f = activeFile();
    if (!f) return;
    fn(f.transform);
    refreshFileList();
    drawRenderPreview();
  };
  $('ct-mode').onchange = () => upd((t) => (t.mode = $('ct-mode').value));
  $('ct-x').onchange = () => upd((t) => (t.x = clampInt($('ct-x').value, -100000, 100000)));
  $('ct-y').onchange = () => upd((t) => (t.y = clampInt($('ct-y').value, -100000, 100000)));
  $('ct-scale').oninput = () => { $('ct-scale-n').value = $('ct-scale').value; upd((t) => (t.scale = parseFloat($('ct-scale').value))); };
  $('ct-scale-n').onchange = () => { $('ct-scale').value = $('ct-scale-n').value; upd((t) => (t.scale = Math.max(1, parseFloat($('ct-scale-n').value) || 100))); };
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
  };
  $('ct-apply-all').onclick = () => {
    const f = activeFile();
    if (!f) return;
    rp.files.forEach((o) => {
      if (o !== f) o.transform = JSON.parse(JSON.stringify(f.transform));
    });
    refreshFileList();
  };
}

async function startRender() {
  if (rp.running || !rp.files.length) return;
  const codec = document.querySelector('input[name="r-codec"]:checked').value;
  const fps = clampInt($('r-fps').value, 1, 240);
  const imageDuration = clampInt($('r-dur').value, 1, 3600);
  const OW = project.output.width, OH = project.output.height;
  const outExt = codec === 'png' ? 'png' : 'mov';

  const jobs = [];
  for (const f of rp.files) {
    const pp = await api.pathParse(f.path);
    const dest = rp.destDir || pp.dir;
    const outPath = await api.pathJoin(dest, `${pp.base}_remap_${OW}x${OH}.${outExt}`);
    jobs.push({
      src: f.path,
      isImage: f.isImage,
      outPath,
      transform: f.transform,
      pngTime: codec === 'png' && !f.isImage ? f.frameTime || 0 : 0,
    });
  }

  rp.running = true;
  $('r-start').disabled = true;
  $('rp-add').disabled = true;
  $('r-progress').style.display = '';
  $('r-log').innerHTML = '';
  $('r-bar').style.width = '0%';

  const payload = {
    project: {
      name: project.name,
      input: project.input,
      output: project.output,
      slices: project.slices,
    },
    jobs,
    codec,
    fps,
    imageDuration,
  };
  try {
    await api.renderStart(payload);
  } catch (err) {
    $('r-log').innerHTML += `<div class="err">✗ ${String(err.message || err).split('\n')[0]}</div>`;
  }
  rp.running = false;
  $('r-start').disabled = !rp.files.length;
  $('rp-add').disabled = false;
}

function onRenderEvent(ev) {
  const bar = $('r-bar'), plabel = $('r-plabel'), ppct = $('r-ppct'), log = $('r-log');
  if (!bar) return;
  const jobPart = 100 / Math.max(1, ev.total);
  if (ev.type === 'job-start') {
    plabel.textContent = `(${ev.index + 1}/${ev.total}) ${baseName(ev.file)}`;
    bar.style.width = `${ev.index * jobPart}%`;
    ppct.textContent = '0%';
  } else if (ev.type === 'progress') {
    bar.style.width = `${ev.index * jobPart + (ev.percent / 100) * jobPart}%`;
    ppct.textContent = `${Math.round(ev.percent)}%`;
  } else if (ev.type === 'job-done') {
    bar.style.width = `${(ev.index + 1) * jobPart}%`;
    const div = document.createElement('div');
    div.className = 'ok';
    div.textContent = `✓ ${baseName(ev.out)} `;
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
    div.textContent = `✗ ${String(ev.error).split('\n')[0]}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  } else if (ev.type === 'batch-done') {
    plabel.textContent = ev.cancelled ? 'Cancelled' : 'Done';
    if (!ev.cancelled) { bar.style.width = '100%'; ppct.textContent = '100%'; }
  }
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

async function importXmlPath(p) {
  try {
    const text = await api.readFileText(p);
    const proj = Resolume.parseScreenSetup(text);
    proj.refs = { input: null, output: null };
    proj.slices.forEach((s) => (s.id = uid()));
    pushHistory();
    project = migrateProject(proj);
    selId = null;
    await loadAllRefs();
    fitView('input');
    fitView('output');
    refreshAll();
    markDirty();
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
    project = migrateProject(JSON.parse(text));
    selId = null;
    await loadAllRefs();
    fitView('input');
    fitView('output');
    refreshAll();
    markDirty();
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
    project = newProject();
    selId = null;
    await loadAllRefs();
    fitView('input');
    fitView('output');
    refreshAll();
    markDirty();
  };
  $('btn-open-proj').onclick = openProject;
  $('btn-save-proj').onclick = saveProject;
  $('btn-import-xml').onclick = importXml;
  $('btn-export-xml').onclick = exportXml;

  $('btn-add-slice').onclick = addSlice;
  $('btn-dup-slice').onclick = duplicateSlice;
  $('btn-del-slice').onclick = deleteSlice;
  $('btn-split-slice').onclick = openSplitModal;

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

  // project fields
  $('p-name').onchange = () => { pushHistory(); project.name = $('p-name').value || 'Untitled'; markDirty(); };
  const bindDim = (id, objGetter, key) => {
    $(id).onchange = () => {
      pushHistory();
      objGetter()[key] = clampInt($(id).value, 1, 32768);
      $(id).value = objGetter()[key];
      draw();
      drawRenderPreview();
      markDirty();
    };
  };
  bindDim('in-w', () => project.input, 'width');
  bindDim('in-h', () => project.input, 'height');
  bindDim('out-w', () => project.output, 'width');
  bindDim('out-h', () => project.output, 'height');

  // slice fields
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

  // mask fields
  $('mask-enabled').onchange = () => {
    const s = selected();
    if (!s) return;
    pushHistory();
    if ($('mask-enabled').checked) {
      if (!s.mask) s.mask = { enabled: true, ...s.in };
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
    s.mask = { enabled: true, ...s.in };
    refreshProps();
    draw();
    markDirty();
  };
  const bindMask = (id, key) => {
    $(id).onchange = () => {
      const s = selected();
      if (!s || !s.mask) return;
      pushHistory();
      const isSize = key === 'w' || key === 'h';
      s.mask[key] = clampInt($(id).value, isSize ? 1 : -100000, 100000);
      $(id).value = s.mask[key];
      draw();
      markDirty();
    };
  };
  bindMask('mask-x', 'x'); bindMask('mask-y', 'y');
  bindMask('mask-w', 'w'); bindMask('mask-h', 'h');

  // editor canvas
  canvas.addEventListener('mousedown', onMouseDown);
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

  // keyboard
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (page !== 'editor') return;
    if (e.code === 'Space') { spaceDown = true; canvas.style.cursor = 'grab'; return; }
    const s = selected();
    if ((e.key === 'Delete' || e.key === 'Backspace') && s) { e.preventDefault(); deleteSlice(); return; }
    if (meta && e.key.toLowerCase() === 'd' && s) { e.preventDefault(); duplicateSlice(); return; }
    if (s && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      pushHistoryThrottled(800);
      const d = e.shiftKey ? 10 : 1;
      const r = editTargetRect(s);
      if (e.key === 'ArrowLeft') r.x -= d;
      if (e.key === 'ArrowRight') r.x += d;
      if (e.key === 'ArrowUp') r.y -= d;
      if (e.key === 'ArrowDown') r.y += d;
      refreshProps();
      draw();
      markDirty();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; canvas.style.cursor = 'default'; }
  });

  // drag & drop
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
        project = migrateProject(JSON.parse(await api.readFileText(projs[0])));
        selId = null;
        await loadAllRefs();
        fitView('input');
        fitView('output');
        refreshAll();
        markDirty();
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

  // render page
  $('rp-add').onclick = async () => {
    const paths = await api.openDialog({
      title: 'Choose stageview footage',
      multi: true,
      filters: [
        { name: 'Footage', extensions: [...IMAGE_EXTS, ...VIDEO_EXTS] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (paths.length) addFootage(paths);
  };
  $('rp-remove').onclick = () => {
    if (rp.activeIndex < 0) return;
    rp.files.splice(rp.activeIndex, 1);
    rp.activeIndex = Math.min(rp.activeIndex, rp.files.length - 1);
    refreshFileList();
    refreshClipControls();
    if (activeFile()) selectFile(rp.activeIndex);
    else drawRenderPreview();
  };
  $('rp-time').oninput = () => { updateTimeLabel(); fetchFrame(false); };
  $('rp-refresh').onclick = () => fetchFrame(true);
  $('r-dest-btn').onclick = async () => {
    const dir = await api.openDirDialog({ title: 'Choose output folder' });
    if (dir) {
      rp.destDir = dir;
      $('r-dest').textContent = dir;
    }
  };
  $('r-start').onclick = startRender;
  $('r-cancel').onclick = () => api.renderCancel();
  bindClipControls();

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

  bindUI();
  updateUndoButtons();
  await loadAllRefs();
  resizeCanvas();
  fitView('input');
  fitView('output');
  refreshAll();

  try {
    caps = await api.ffmpegCaps();
  } catch (e) {
    caps = null;
  }
  refreshEngineInfo();

  if (params.get('page') === 'render') switchPage('render');
});
