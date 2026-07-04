'use strict';
/* XtremeLED Remap Export — slice editor (input/output mapping zoals Resolume Advanced Output) */

const api = window.xre;
const $ = (id) => document.getElementById(id);

// ---------------- state ----------------
let project = null;
let view = 'input'; // 'input' | 'output'
let selId = null;
let caps = null;
const refImgs = { input: null, output: null }; // HTMLImageElement per view
const vt = {
  input: { scale: 0.1, ox: 50, oy: 50 },
  output: { scale: 0.1, ox: 50, oy: 50 },
};

let canvas, ctx;
let spaceDown = false;
let drag = null;
let hoverCursor = 'default';
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

// ---------------- project model ----------------
function newProject() {
  return {
    name: 'Untitled',
    input: { width: 3840, height: 2160 },
    output: { width: 3840, height: 2160 },
    refs: { input: null, output: null },
    slices: [
      {
        id: uid(), name: 'Slice 1', enabled: true,
        in: { x: 960, y: 540, w: 1920, h: 1080 },
        out: { x: 960, y: 540, w: 1920, h: 1080 },
      },
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
      input: { dataUrl: checkerDataUrl(2600, 104, 26), name: 'demo testkaart', opacity: 0.9 },
      output: null,
    },
    slices: [
      { id: uid(), name: '50x2m deel 1/3', enabled: true, in: { x: 0, y: 0, w: 3744, h: 416 }, out: { x: 0, y: 0, w: 3744, h: 416 } },
      { id: uid(), name: '50x2m deel 2/3', enabled: true, in: { x: 3744, y: 0, w: 3744, h: 416 }, out: { x: 0, y: 416, w: 3744, h: 416 } },
      { id: uid(), name: '50x2m deel 3/3', enabled: true, in: { x: 7488, y: 0, w: 2912, h: 416 }, out: { x: 0, y: 832, w: 2912, h: 416 } },
    ],
  };
}

function migrateProject(p) {
  if (!p || !p.input || !p.output || !Array.isArray(p.slices)) throw new Error('Ongeldig projectbestand');
  p.refs = p.refs || { input: null, output: null };
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
      // dataURLs te groot voor localStorage: sla op zonder refs
      try {
        localStorage.setItem('xre:project', JSON.stringify({ ...project, refs: { input: null, output: null } }));
      } catch (e2) { /* geef op */ }
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

// ---------------- canvas & drawing ----------------
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

function cssSize() {
  return { w: parseFloat(canvas.style.width) || canvas.width, h: parseFloat(canvas.style.height) || canvas.height };
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

function draw() {
  if (!project || !ctx) return;
  const t = vt[view];
  const { w: cw, h: ch } = cssSize();
  const { w: W, h: H } = worldSize(view);

  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = '#202426';
  ctx.fillRect(0, 0, cw, ch);

  const cx = toScreenX(0), cy = toScreenY(0);
  const cwid = W * t.scale, chei = H * t.scale;

  // canvas-gebied met subtiel dambord
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx, cy, cwid, chei);
  ctx.clip();
  ctx.fillStyle = '#141617';
  ctx.fillRect(cx, cy, cwid, chei);
  const cell = 14;
  ctx.fillStyle = '#191c1d';
  for (let y = 0; y * cell < chei; y++) {
    for (let x = (y % 2); x * cell < cwid; x += 2) {
      ctx.fillRect(cx + x * cell, cy + y * cell, cell, cell);
    }
  }

  // reference image (gestrekt over canvas)
  const ref = project.refs[view];
  if (ref && refImgs[view]) {
    ctx.globalAlpha = ref.opacity != null ? ref.opacity : 0.6;
    ctx.drawImage(refImgs[view], cx, cy, cwid, chei);
    ctx.globalAlpha = 1;
  }

  // output view: preview van input-reference door de slices heen
  if (view === 'output' && refImgs.input) {
    const img = refImgs.input;
    const kx = img.naturalWidth / project.input.width;
    const ky = img.naturalHeight / project.input.height;
    for (const s of project.slices) {
      if (s.enabled === false) continue;
      if (s.in.w <= 0 || s.in.h <= 0 || s.out.w <= 0 || s.out.h <= 0) continue;
      // bron-rect binnen de afbeelding klemmen
      const sx0 = Math.max(0, s.in.x) * kx;
      const sy0 = Math.max(0, s.in.y) * ky;
      const sx1 = Math.min(project.input.width, s.in.x + s.in.w) * kx;
      const sy1 = Math.min(project.input.height, s.in.y + s.in.h) * ky;
      if (sx1 - sx0 < 1 || sy1 - sy0 < 1) continue;
      const fx0 = (sx0 / kx - s.in.x) / s.in.w, fx1 = (sx1 / kx - s.in.x) / s.in.w;
      const fy0 = (sy0 / ky - s.in.y) / s.in.h, fy1 = (sy1 / ky - s.in.y) / s.in.h;
      const dx = toScreenX(s.out.x + fx0 * s.out.w);
      const dy = toScreenY(s.out.y + fy0 * s.out.h);
      const dw = (fx1 - fx0) * s.out.w * t.scale;
      const dh = (fy1 - fy0) * s.out.h * t.scale;
      try {
        ctx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, dx, dy, dw, dh);
      } catch (e) { /* bron-rect buiten afbeelding */ }
    }
  }
  ctx.restore();

  // canvas rand
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
        ? 'rgba(53,224,178,0.16)'
        : 'rgba(53,224,178,0.07)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = off ? '#5a6165' : isSel ? '#35e0b2' : '#2b9e80';
    ctx.lineWidth = isSel ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));

    // label pill
    if (w > 40 && h > 14) {
      const label = s.name;
      const sub = `${r.w}×${r.h}`;
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
      ctx.fillStyle = off ? '#6d7276' : '#35e0b2';
      ctx.fillText(sub, px, py + 7);
    }
  }

  // handles op selectie
  const sel = selected();
  if (sel) {
    const r = sliceRect(sel, view);
    const x = toScreenX(r.x), y = toScreenY(r.y);
    const w = r.w * t.scale, h = r.h * t.scale;
    for (const hd of HANDLES) {
      const hx = x + w * hd.fx, hy = y + h * hd.fy;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#10241d';
      ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
      ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
    }
  }

  // oorsprong-label
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillStyle = '#8b9195';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('0,0', cx + 3, cy - 3);
}

// ---------------- hit testing ----------------
function handleAt(px, py) {
  const sel = selected();
  if (!sel) return null;
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

// ---------------- mouse ----------------
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
  if (!project) return;
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
    drag = { mode: 'move', start: toWorld(px, py), orig: { ...sliceRect(s, view) } };
    draw();
    return;
  }
  // leeg gebied: deselecteren + pannen
  if (selId !== null) {
    selId = null;
    refreshSliceList();
    refreshProps();
    draw();
  }
  drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: t.ox, oy: t.oy };
}

function onMouseMove(e) {
  if (!project) return;
  const px = e.offsetX, py = e.offsetY;
  const wpt = toWorld(px, py);
  $('status-pos').textContent = `${view === 'input' ? 'Input' : 'Output'}: ${Math.round(wpt.x)}, ${Math.round(wpt.y)}  ·  zoom ${Math.round(vt[view].scale * 100)}%`;

  if (!drag) {
    const hk = handleAt(px, py);
    hoverCursor = hk ? HANDLE_CURSORS[hk] : sliceAt(px, py) ? 'move' : spaceDown ? 'grab' : 'default';
    canvas.style.cursor = hoverCursor;
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
  const r = sliceRect(sel, view);
  const dx = wpt.x - drag.start.x;
  const dy = wpt.y - drag.start.y;

  if (drag.mode === 'move') {
    let nr = { x: drag.orig.x + dx, y: drag.orig.y + dy, w: drag.orig.w, h: drag.orig.h };
    const sn = snapDelta(nr, view);
    nr.x = Math.round(nr.x + sn.dx);
    nr.y = Math.round(nr.y + sn.dy);
    Object.assign(r, nr);
  } else if (drag.mode === 'resize') {
    Object.assign(r, applyResize(drag.orig, drag.k, dx, dy));
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
  e.preventDefault();
  const t = vt[view];
  if (e.ctrlKey || e.metaKey) {
    const factor = Math.exp(-e.deltaY * 0.01);
    zoomAt(e.offsetX, e.offsetY, factor);
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

function refreshProps() {
  const s = selected();
  const sec = $('slice-props');
  sec.style.opacity = s ? 1 : 0.4;
  const set = (id, val) => { $(id).value = val; };
  if (!s) {
    ['sl-name'].forEach((id) => ($(id).value = ''));
    ['sl-in-x', 'sl-in-y', 'sl-in-w', 'sl-in-h', 'sl-out-x', 'sl-out-y', 'sl-out-w', 'sl-out-h'].forEach((id) => ($(id).value = ''));
    $('sl-enabled').checked = false;
    return;
  }
  set('sl-name', s.name);
  $('sl-enabled').checked = s.enabled !== false;
  set('sl-in-x', s.in.x); set('sl-in-y', s.in.y); set('sl-in-w', s.in.w); set('sl-in-h', s.in.h);
  set('sl-out-x', s.out.x); set('sl-out-y', s.out.y); set('sl-out-w', s.out.w); set('sl-out-h', s.out.h);
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
  $('ref-name').textContent = ref ? ref.name || 'afbeelding' : 'geen afbeelding';
  $('ref-opacity').value = Math.round(((ref && ref.opacity) != null ? ref.opacity : 0.6) * 100);
}

function refreshEngineInfo() {
  const el = $('ffmpeg-info');
  if (!caps || !caps.entries || !caps.entries.length) {
    el.innerHTML = 'ffmpeg niet gevonden.<br>Installeer via <b>brew install ffmpeg</b>';
    return;
  }
  const main = caps.entries[0];
  const dxvTxt = caps.hasDxv
    ? '<span style="color:#35e0b2">DXV3 ✓</span>'
    : 'DXV3 ✗ <span class="dim">(brew install ffmpeg voor DXV)</span>';
  el.innerHTML = `ffmpeg ${main.version}<br>ProRes HQ ✓ · ${dxvTxt}`;
}

function refreshAll() {
  refreshProjectFields();
  refreshRefPanel();
  refreshSliceList();
  refreshProps();
  draw();
}

// ---------------- acties ----------------
function switchView(v) {
  view = v;
  $('tab-input').classList.toggle('active', v === 'input');
  $('tab-output').classList.toggle('active', v === 'output');
  refreshRefPanel();
  refreshSliceList();
  updateZoomLabel();
  draw();
}

function addSlice() {
  const inC = project.input, outC = project.output;
  const s = {
    id: uid(),
    name: 'Slice ' + (project.slices.length + 1),
    enabled: true,
    in: { x: Math.round(inC.width / 4), y: Math.round(inC.height / 4), w: Math.round(inC.width / 2), h: Math.round(inC.height / 2) },
    out: { x: Math.round(outC.width / 4), y: Math.round(outC.height / 4), w: Math.round(outC.width / 2), h: Math.round(outC.height / 2) },
  };
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
    parts.push({
      id: uid(),
      name: `${s.name} ${i + 1}/${n}`,
      enabled: true,
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
    });
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
    alert('Selecteer eerst een slice.');
    return;
  }
  const defW = Math.min(project.output.width, s.out.w);
  openModal(`
    <div class="modal" style="width:420px">
      <div class="modal-head">Auto-split "${s.name}"<button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body">
        <div class="note">Verdeelt deze slice in delen die als rijen onder elkaar op de output canvas komen (zoals een lang LED-scherm over meerdere rijen).</div>
        <div class="row"><label style="min-width:110px">Deel-breedte</label><input type="number" id="m-partw" class="num" style="width:90px" value="${defW}" /></div>
        <div class="row"><label style="min-width:110px">Rij-hoogte</label><input type="number" id="m-rowh" class="num" style="width:90px" value="${s.out.h}" /></div>
        <div class="row"><label style="min-width:110px">Start X</label><input type="number" id="m-startx" class="num" style="width:90px" value="0" /></div>
        <div class="row"><label style="min-width:110px">Start Y</label><input type="number" id="m-starty" class="num" style="width:90px" value="0" /></div>
        <div class="row"><label style="min-width:110px">Tussenruimte Y</label><input type="number" id="m-gapy" class="num" style="width:90px" value="0" /></div>
      </div>
      <div class="modal-foot">
        <button id="m-cancel">Annuleer</button>
        <button id="m-apply" class="accent">Split</button>
      </div>
    </div>
  `);
  $('m-close').onclick = closeModal;
  $('m-cancel').onclick = closeModal;
  $('m-apply').onclick = () => {
    const partW = clampInt($('m-partw').value, 1, 100000);
    const rowH = clampInt($('m-rowh').value, 1, 100000);
    const startX = clampInt($('m-startx').value, -100000, 100000);
    const startY = clampInt($('m-starty').value, -100000, 100000);
    const gapY = clampInt($('m-gapy').value, 0, 100000);
    autoSplitSlice(s, partW, rowH, startX, startY, gapY);
    closeModal();
    refreshSliceList();
    refreshProps();
    draw();
    markDirty();
  };
}

// ---------------- render modal ----------------
const renderUI = { files: [], destDir: null, running: false };

function fileRowHtml(f, i) {
  const tag = isImagePath(f) ? 'IMG' : 'VID';
  return `<div class="file-item"><span class="tag">${tag}</span><span class="fn" title="${f}">${f.split('/').pop()}</span><button class="rm" data-i="${i}">✕</button></div>`;
}

function refreshRenderFiles() {
  const list = $('r-files');
  if (!list) return;
  list.innerHTML = renderUI.files.length
    ? renderUI.files.map(fileRowHtml).join('')
    : '<div class="file-empty">Voeg stageview-bestanden toe (foto of video), of sleep ze hierheen.</div>';
  list.querySelectorAll('.rm').forEach((b) => {
    b.onclick = () => {
      renderUI.files.splice(parseInt(b.dataset.i, 10), 1);
      refreshRenderFiles();
    };
  });
  const btn = $('r-start');
  if (btn) btn.disabled = !renderUI.files.length || renderUI.running;
}

async function addRenderFiles(paths) {
  for (const p of paths) {
    if (!renderUI.files.includes(p)) renderUI.files.push(p);
  }
  if (!renderUI.destDir && renderUI.files.length) {
    const pp = await api.pathParse(renderUI.files[0]);
    renderUI.destDir = pp.dir;
    const dd = $('r-dest');
    if (dd) dd.textContent = renderUI.destDir;
  }
  refreshRenderFiles();
}

function openRenderModal(prefill) {
  renderUI.files = [];
  renderUI.running = false;
  const dxvDisabled = caps && caps.hasDxv ? '' : 'disabled';
  const dxvNote = caps && caps.hasDxv
    ? ''
    : '<div class="note">DXV3 vereist ffmpeg 7.1+ met dxv-encoder (bijv. <b>brew install ffmpeg</b>). ProRes werkt altijd.</div>';
  openModal(`
    <div class="modal">
      <div class="modal-head">Render output content<button class="close-x" id="m-close">✕</button></div>
      <div class="modal-body">
        <div class="note">Bron = stageview render (wordt geschaald naar input canvas ${project.input.width}×${project.input.height}). Output = ${project.output.width}×${project.output.height} .mov</div>
        <button id="r-add">Add files…</button>
        <div class="file-list" id="r-files"></div>
        <div class="radio-row">
          <label><input type="radio" name="r-codec" value="prores" checked /> Apple ProRes 422 HQ</label>
          <label><input type="radio" name="r-codec" value="dxv" ${dxvDisabled} /> DXV3</label>
        </div>
        ${dxvNote}
        <div class="row">
          <label style="min-width:130px">FPS (voor foto's)</label>
          <input type="number" id="r-fps" class="num" style="width:70px" value="50" min="1" max="240" />
          <label style="min-width:90px">Duur foto (s)</label>
          <input type="number" id="r-dur" class="num" style="width:70px" value="1" min="1" max="3600" />
        </div>
        <div class="row">
          <label style="min-width:130px">Bestemming</label>
          <button id="r-dest-btn">Kies map…</button>
          <span id="r-dest" class="dim" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${renderUI.destDir || 'map van bronbestand'}</span>
        </div>
        <div class="progress-wrap" id="r-progress" style="display:none">
          <div class="progress-bar"><div id="r-bar"></div></div>
          <div class="progress-label"><span id="r-plabel"></span><span id="r-ppct"></span></div>
        </div>
        <div class="render-log" id="r-log"></div>
      </div>
      <div class="modal-foot">
        <button id="r-cancel">Sluiten</button>
        <button id="r-start" class="accent" disabled>Start render</button>
      </div>
    </div>
  `);
  $('m-close').onclick = () => { if (!renderUI.running) closeModal(); };
  $('r-cancel').onclick = async () => {
    if (renderUI.running) {
      await api.renderCancel();
    } else {
      closeModal();
    }
  };
  $('r-add').onclick = async () => {
    const paths = await api.openDialog({
      title: 'Kies stageview bestanden',
      multi: true,
      filters: [
        { name: 'Media', extensions: [...IMAGE_EXTS, ...VIDEO_EXTS] },
        { name: 'Alle bestanden', extensions: ['*'] },
      ],
    });
    if (paths.length) addRenderFiles(paths);
  };
  $('r-dest-btn').onclick = async () => {
    const dir = await api.openDirDialog({ title: 'Kies bestemmingsmap' });
    if (dir) {
      renderUI.destDir = dir;
      $('r-dest').textContent = dir;
    }
  };
  $('r-start').onclick = startRender;
  refreshRenderFiles();
  if (prefill && prefill.length) addRenderFiles(prefill);
}

async function startRender() {
  if (renderUI.running || !renderUI.files.length) return;
  const codec = document.querySelector('input[name="r-codec"]:checked').value;
  const fps = clampInt($('r-fps').value, 1, 240);
  const imageDuration = clampInt($('r-dur').value, 1, 3600);
  const OW = project.output.width, OH = project.output.height;

  const jobs = [];
  for (const src of renderUI.files) {
    const pp = await api.pathParse(src);
    const dest = renderUI.destDir || pp.dir;
    const outPath = await api.pathJoin(dest, `${pp.base}_remap_${OW}x${OH}.mov`);
    jobs.push({ src, isImage: isImagePath(src), outPath });
  }

  renderUI.running = true;
  $('r-start').disabled = true;
  $('r-add').disabled = true;
  $('r-cancel').textContent = 'Annuleer';
  $('r-progress').style.display = '';
  $('r-log').innerHTML = '';

  const payload = {
    project: { name: project.name, input: project.input, output: project.output, slices: project.slices },
    jobs,
    codec,
    fps,
    imageDuration,
  };
  try {
    await api.renderStart(payload);
  } catch (err) {
    const log = $('r-log');
    if (log) log.innerHTML += `<div class="err">✗ ${String(err.message || err).split('\n')[0]}</div>`;
  }
  renderUI.running = false;
  const startBtn = $('r-start');
  if (startBtn) {
    startBtn.disabled = false;
    $('r-add').disabled = false;
    $('r-cancel').textContent = 'Sluiten';
  }
}

function onRenderEvent(ev) {
  const bar = $('r-bar'), plabel = $('r-plabel'), ppct = $('r-ppct'), log = $('r-log');
  if (!bar) return;
  const jobPart = 100 / Math.max(1, ev.total);
  if (ev.type === 'job-start') {
    plabel.textContent = `(${ev.index + 1}/${ev.total}) ${ev.file.split('/').pop()}`;
    bar.style.width = `${ev.index * jobPart}%`;
    ppct.textContent = '0%';
  } else if (ev.type === 'progress') {
    bar.style.width = `${ev.index * jobPart + (ev.percent / 100) * jobPart}%`;
    ppct.textContent = `${Math.round(ev.percent)}%`;
  } else if (ev.type === 'job-done') {
    bar.style.width = `${(ev.index + 1) * jobPart}%`;
    const name = ev.out.split('/').pop();
    log.innerHTML += `<div class="ok">✓ ${name} <a href="#" data-p="${ev.out}" style="color:#35e0b2">toon in Finder</a></div>`;
    const a = log.querySelector(`a[data-p="${CSS.escape(ev.out)}"]`) || log.lastElementChild.querySelector('a');
    if (a) a.onclick = (e) => { e.preventDefault(); api.showInFolder(ev.out); };
    log.scrollTop = log.scrollHeight;
  } else if (ev.type === 'job-error') {
    log.innerHTML += `<div class="err">✗ ${String(ev.error).split('\n')[0]}</div>`;
    log.scrollTop = log.scrollHeight;
  } else if (ev.type === 'batch-done') {
    plabel.textContent = ev.cancelled ? 'Geannuleerd' : 'Klaar';
    if (!ev.cancelled) { bar.style.width = '100%'; ppct.textContent = '100%'; }
  }
}

// ---------------- import / export / open / save ----------------
async function importXml() {
  const paths = await api.openDialog({
    title: 'Importeer Resolume Advanced Output XML',
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
    project = proj;
    selId = null;
    await loadAllRefs();
    fitView('input');
    fitView('output');
    refreshAll();
    markDirty();
  } catch (err) {
    alert('Import mislukt: ' + (err.message || err));
  }
}

async function exportXml() {
  const p = await api.saveDialog({
    title: 'Exporteer als Resolume XML',
    defaultPath: (project.name || 'mapping').replace(/[/\\:]/g, '-') + '.xml',
    filters: [{ name: 'XML', extensions: ['xml'] }],
  });
  if (!p) return;
  await api.writeFileText(p, Resolume.exportScreenSetup(project));
}

async function saveProject() {
  const p = await api.saveDialog({
    title: 'Project opslaan',
    defaultPath: (project.name || 'project').replace(/[/\\:]/g, '-') + '.xreproj',
    filters: [{ name: 'XtremeLED Remap project', extensions: ['xreproj'] }],
  });
  if (!p) return;
  await api.writeFileText(p, JSON.stringify(project, null, 2));
}

async function openProject() {
  const paths = await api.openDialog({
    title: 'Project openen',
    filters: [{ name: 'XtremeLED Remap project', extensions: ['xreproj', 'json'] }],
  });
  if (!paths.length) return;
  try {
    const text = await api.readFileText(paths[0]);
    project = migrateProject(JSON.parse(text));
    selId = null;
    await loadAllRefs();
    fitView('input');
    fitView('output');
    refreshAll();
    markDirty();
  } catch (err) {
    alert('Openen mislukt: ' + (err.message || err));
  }
}

async function loadReference() {
  const paths = await api.openDialog({
    title: 'Kies reference afbeelding',
    filters: [{ name: 'Afbeeldingen', extensions: IMAGE_EXTS }],
  });
  if (!paths.length) return;
  await setReferenceFromPath(paths[0]);
}

async function setReferenceFromPath(p) {
  const dataUrl = await api.readFileDataUrl(p);
  const pp = await api.pathParse(p);
  project.refs[view] = { dataUrl, name: pp.base + pp.ext, opacity: parseInt($('ref-opacity').value, 10) / 100 };
  await loadRefImage(view);
  refreshRefPanel();
  draw();
  markDirty();
}

// ---------------- events binden ----------------
function bindUI() {
  $('tab-input').onclick = () => switchView('input');
  $('tab-output').onclick = () => switchView('output');

  $('btn-zoom-in').onclick = () => { const c = cssSize(); zoomAt(c.w / 2, c.h / 2, 1.25); };
  $('btn-zoom-out').onclick = () => { const c = cssSize(); zoomAt(c.w / 2, c.h / 2, 0.8); };
  $('btn-zoom-fit').onclick = () => { fitView(view); draw(); };

  $('btn-new').onclick = async () => {
    if (!confirm('Nieuw project starten? Niet-opgeslagen wijzigingen gaan verloren.')) return;
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
  $('btn-render').onclick = () => openRenderModal();

  $('btn-add-slice').onclick = addSlice;
  $('btn-dup-slice').onclick = duplicateSlice;
  $('btn-del-slice').onclick = deleteSlice;
  $('btn-split-slice').onclick = openSplitModal;

  $('btn-ref-load').onclick = loadReference;
  $('btn-ref-clear').onclick = () => {
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

  // project velden
  $('p-name').onchange = () => { project.name = $('p-name').value || 'Untitled'; markDirty(); };
  const bindDim = (id, obj, key) => {
    $(id).onchange = () => {
      obj[key] = clampInt($(id).value, 1, 32768);
      $(id).value = obj[key];
      draw();
      markDirty();
    };
  };
  bindDim('in-w', project.input, 'width');
  bindDim('in-h', project.input, 'height');
  bindDim('out-w', project.output, 'width');
  bindDim('out-h', project.output, 'height');

  // slice velden
  $('sl-name').oninput = () => {
    const s = selected();
    if (!s) return;
    s.name = $('sl-name').value;
    refreshSliceList();
    draw();
    markDirty();
  };
  $('sl-enabled').onchange = () => {
    const s = selected();
    if (!s) return;
    s.enabled = $('sl-enabled').checked;
    refreshSliceList();
    draw();
    markDirty();
  };
  const bindRect = (id, which, key) => {
    $(id).onchange = () => {
      const s = selected();
      if (!s) return;
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

  // canvas
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

  // toetsenbord
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.code === 'Space') { spaceDown = true; canvas.style.cursor = 'grab'; return; }
    const s = selected();
    if ((e.key === 'Delete' || e.key === 'Backspace') && s) { e.preventDefault(); deleteSlice(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && s) { e.preventDefault(); duplicateSlice(); return; }
    if (s && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const r = sliceRect(s, view);
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

  // drag & drop op het venster
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
        project = migrateProject(JSON.parse(await api.readFileText(projs[0])));
        selId = null;
        await loadAllRefs();
        fitView('input');
        fitView('output');
        refreshAll();
        markDirty();
      } catch (err) {
        alert('Openen mislukt: ' + (err.message || err));
      }
      return;
    }
    // media: in render-modal als die open is, anders afbeelding = reference
    const modalOpen = !$('modal-root').classList.contains('hidden') && $('r-files');
    if (modalOpen && (imgs.length || vids.length)) return addRenderFiles([...imgs, ...vids]);
    if (imgs.length) return setReferenceFromPath(imgs[0]);
    if (vids.length) return openRenderModal(vids);
  });

  new ResizeObserver(() => resizeCanvas()).observe(canvas.parentElement);
  api.onRenderEvent(onRenderEvent);
}

// re-bind projectvelden na project-wissel (bindDim houdt object-referenties vast)
function rebindProjectFields() {
  const bindDim = (id, objGetter, key) => {
    $(id).onchange = () => {
      objGetter()[key] = clampInt($(id).value, 1, 32768);
      $(id).value = objGetter()[key];
      draw();
      markDirty();
    };
  };
  bindDim('in-w', () => project.input, 'width');
  bindDim('in-h', () => project.input, 'height');
  bindDim('out-w', () => project.output, 'width');
  bindDim('out-h', () => project.output, 'height');
}

// ---------------- init ----------------
window.addEventListener('DOMContentLoaded', async () => {
  canvas = $('editor');
  ctx = canvas.getContext('2d');

  const params = new URLSearchParams(location.search);
  const demo = params.get('demo') === '1';
  project = (!demo && loadLocal()) || demoProject();

  bindUI();
  rebindProjectFields();
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
});
