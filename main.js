'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const renderMod = require('./src/main/render');

app.setName('XtremeLED Remap Export');
// Desktop tool: allow the preview player to start programmatically (spacebar/UI)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Hardware H.264 decode silently stalls on some machines (video stuck at t=0,
// readyState 4, no error). Software decode is plenty for the preview player.
app.commandLine.appendSwitch('disable-accelerated-video-decode');

// Application menu with standard Edit roles. On Windows/Linux there is NO default
// menu, so without this the Cut/Copy/Paste/Undo/Select-All keyboard shortcuts don't
// work in text and number fields — making it look like you can't edit values.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []),
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let win = null;
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='));
const makeIconArg = process.argv.find((a) => a.startsWith('--makeicon='));
const makeHeroArg = process.argv.find((a) => a.startsWith('--makehero='));
const makePosterArg = process.argv.find((a) => a.startsWith('--makeposter='));
const makeVideoArg = process.argv.find((a) => a.startsWith('--makevideo='));
const shootArg = process.argv.find((a) => a.startsWith('--shoot='));
const makeTutArg = process.argv.find((a) => a.startsWith('--maketut='));
const e2eArg = process.argv.find((a) => a.startsWith('--e2e='));

// E2E test mode: load the real app (all IPC handlers live) and run a page-side script.
// The script runs as an async body; its return value is printed as E2E RESULT.
function runE2E() {
  const scriptPath = e2eArg.slice('--e2e='.length);
  const w = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: process.env.E2E_SHOW === '1',
    backgroundColor: '#1d2022',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false, // keep rAF/video running while hidden
    },
  });
  w.webContents.on('console-message', (e, l, msg) => console.log('PAGE:', msg));
  w.loadFile(path.join(__dirname, 'src/renderer/index.html'), { query: { demo: '1' } });
  w.webContents.once('did-finish-load', async () => {
    const code = fs.readFileSync(scriptPath, 'utf8');
    try {
      const out = await w.webContents.executeJavaScript(`(async () => { ${code} })()`);
      console.log('E2E RESULT:', out);
    } catch (err) {
      console.error('E2E ERROR:', err.message);
    }
    app.quit();
  });
}

// Render tools/tutorial-build.html frame-by-frame to a folder of PNGs (1920x1080 @ 30fps)
function makeTut() {
  const outDir = makeTutArg.slice('--maketut='.length);
  fs.mkdirSync(outDir, { recursive: true });
  const FPS = 30;
  const w = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  w.loadFile(path.join(__dirname, 'tools/tutorial-build.html'), { query: { capture: '1' } });
  w.webContents.once('did-finish-load', async () => {
    for (let i = 0; i < 200; i++) {
      const ready = await w.webContents.executeJavaScript('window.__ready === true').catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const dur = await w.webContents.executeJavaScript('window.__DUR').catch(() => 150);
    const total = Math.round(dur * FPS);
    console.log(`Rendering ${total} tutorial frames (${dur.toFixed(1)}s @ ${FPS}fps)…`);
    for (let i = 0; i < total; i++) {
      const t = i / FPS;
      await w.webContents.executeJavaScript(`window.__seek(${t})`);
      const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1920, height: 1080 });
      fs.writeFileSync(path.join(outDir, `frame_${String(i).padStart(5, '0')}.jpg`), img.toJPEG(94));
      if (i % 60 === 0) console.log(`  ${i}/${total}`);
    }
    console.log('TUT_FRAMES_DONE', total, FPS);
    app.quit();
  });
}

// Capture a set of real app-state screenshots for the tutorial (to shootArg dir)
function shootTutorial() {
  const outDir = shootArg.slice('--shoot='.length);
  fs.mkdirSync(outDir, { recursive: true });
  const win2 = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: '#1d2022',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win2.webContents.executeJavaScript(code).catch(() => null);
  const shot = async (name) => {
    const img = await win2.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
    console.log('SHOT', name);
  };
  win2.loadFile(path.join(__dirname, 'src/renderer/index.html'), { query: { demo: '1' } });
  win2.webContents.once('did-finish-load', async () => {
    for (let i = 0; i < 100; i++) {
      if (await js('window.__demoReady === true')) break;
      await wait(50);
    }
    const rects = {};
    await wait(600);
    await js('window.__demoApi.viewInput()');
    await wait(400);
    await shot('editor-input');
    rects.editor = await js('window.__demoApi.rects()');
    await js('window.__demoApi.selectSlice(1)');
    await wait(400);
    await shot('editor-slice');
    rects.editorSlice = await js('window.__demoApi.rects()');
    await js('window.__demoApi.viewOutput()');
    await wait(500);
    await shot('editor-output');
    // Export page with test-pattern footage + preview
    await js('window.__demoApi.addTestFootage()');
    // wait for ffmpeg preview frame
    for (let i = 0; i < 60; i++) {
      if (await js('window.__demoApi.hasPreview()')) break;
      await wait(150);
    }
    await wait(500);
    await js('window.__demoApi.rpInput()');
    await wait(400);
    await shot('export-input');
    rects.export = await js('window.__demoApi.rects()');
    await js("window.__demoApi.setCodec('dxv')");
    await wait(300);
    await shot('export-codec');
    rects.exportCodec = await js('window.__demoApi.rects()');
    await js('window.__demoApi.rpOutput()');
    await wait(500);
    await shot('export-output');
    fs.writeFileSync(path.join(outDir, 'shots.json'), JSON.stringify(rects, null, 2));
    console.log('SHOOT_DONE');
    app.quit();
  });
}

// Render tools/promo.html frame-by-frame to a folder of PNGs (1080x1920 @ 30fps)
function makeVideo() {
  const outDir = makeVideoArg.slice('--makevideo='.length);
  fs.mkdirSync(outDir, { recursive: true });
  const FPS = 30;
  const w = new BrowserWindow({
    width: 1080,
    height: 1920,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  w.loadFile(path.join(__dirname, 'tools/promo.html'), { query: { capture: '1' } });
  w.webContents.once('did-finish-load', async () => {
    // wait for assets (icon) to load
    for (let i = 0; i < 100; i++) {
      const ready = await w.webContents.executeJavaScript('window.__ready === true').catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const dur = await w.webContents.executeJavaScript('window.__DUR').catch(() => 16);
    const total = Math.round(dur * FPS);
    console.log(`Rendering ${total} frames (${dur}s @ ${FPS}fps)…`);
    for (let i = 0; i < total; i++) {
      const t = i / FPS;
      await w.webContents.executeJavaScript(`window.__seek(${t})`);
      const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1080, height: 1920 });
      fs.writeFileSync(path.join(outDir, `frame_${String(i).padStart(5, '0')}.png`), img.toPNG());
      if (i % 30 === 0) console.log(`  ${i}/${total}`);
    }
    console.log('FRAMES_DONE', total, FPS);
    app.quit();
  });
}

// Capture a static tools/<page>.html at a fixed size:
// --makeposter=out.png (poster.html 1080x1350) or --makeposter=explainer:out.png (explainer.html 1200x1500)
function makePoster() {
  let spec = makePosterArg.slice('--makeposter='.length);
  let page = 'poster', width = 1080, height = 1350;
  const m = spec.match(/^(\w+):(.+)$/);
  if (m) {
    page = m[1];
    spec = m[2];
    if (page === 'explainer') { width = 1200; height = 1500; }
    if (page === 'thumbnail') { width = 1280; height = 720; }
  }
  const outPng = spec;
  const w = new BrowserWindow({
    width, height, show: false, frame: false,
    webPreferences: { offscreen: true },
  });
  w.loadFile(path.join(__dirname, `tools/${page}.html`));
  w.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const img = await w.webContents.capturePage({ x: 0, y: 0, width, height });
        fs.writeFileSync(outPng, img.toPNG());
        console.log('Poster saved:', outPng);
      } catch (e) {
        console.error('Poster capture failed:', e);
      }
      app.quit();
    }, 800);
  });
}

// Capture tools/hero.html (README illustration) at 2000x780
function makeHero() {
  const outPng = makeHeroArg.slice('--makehero='.length);
  const heroWin = new BrowserWindow({
    width: 2000,
    height: 780,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  heroWin.loadFile(path.join(__dirname, 'tools/hero.html'));
  heroWin.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const img = await heroWin.webContents.capturePage({ x: 0, y: 0, width: 2000, height: 780 });
        fs.writeFileSync(outPng, img.toPNG());
        console.log('Hero saved:', outPng);
      } catch (e) {
        console.error('Hero capture failed:', e);
      }
      app.quit();
    }, 800);
  });
}

function makeIcon() {
  const outPng = makeIconArg.slice('--makeicon='.length);
  const iconWin = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  iconWin.loadFile(path.join(__dirname, 'tools/icon.html'));
  iconWin.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const img = await iconWin.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
        fs.writeFileSync(outPng, img.toPNG());
        console.log('Icon saved:', outPng);
      } catch (e) {
        console.error('Icon capture failed:', e);
      }
      app.quit();
    }, 800);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#1d2022',
    title: 'XtremeLED Remap Export',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const pageArg = process.argv.find((a) => a.startsWith('--page='));
  const query = {};
  if (screenshotArg) query.demo = '1';
  if (pageArg) query.page = pageArg.slice('--page='.length);
  const selArg = process.argv.find((a) => a.startsWith('--sel='));
  if (selArg) query.sel = selArg.slice('--sel='.length);
  const loadOpts = Object.keys(query).length ? { query } : undefined;
  win.loadFile(path.join(__dirname, 'src/renderer/index.html'), loadOpts);

  if (screenshotArg) {
    const outPng = screenshotArg.slice('--screenshot='.length);
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(outPng, img.toPNG());
          console.log('Screenshot saved:', outPng);
        } catch (e) {
          console.error('Screenshot failed:', e);
        }
        app.quit();
      }, 1800);
    });
  }
}

app.whenReady().then(() => {
  if (makeIconArg) return makeIcon();
  if (makeHeroArg) return makeHero();
  if (makePosterArg) return makePoster();
  if (makeVideoArg) return makeVideo();
  if (shootArg) return shootTutorial();
  if (makeTutArg) return makeTut();
  if (e2eArg) return runE2E();
  buildMenu();
  const iconPng = path.join(__dirname, 'build/icon.png');
  if (process.platform === 'darwin' && app.dock && fs.existsSync(iconPng)) {
    try {
      app.dock.setIcon(iconPng);
    } catch (e) {
      /* icon optional */
    }
  }
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------------- IPC ----------------
ipcMain.handle('dialog:open', async (e, opts = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: opts.title,
    filters: opts.filters,
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:openDir', async (e, opts = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: opts.title,
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:save', async (e, opts = {}) => {
  const res = await dialog.showSaveDialog(win, {
    title: opts.title,
    defaultPath: opts.defaultPath,
    filters: opts.filters,
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('file:readText', (e, p) => fs.readFileSync(p, 'utf8'));

ipcMain.handle('file:readDataUrl', (e, p) => {
  const ext = path.extname(p).toLowerCase().replace('.', '');
  const mime =
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      tif: 'image/tiff',
      tiff: 'image/tiff',
    }[ext] || 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
});

ipcMain.handle('file:writeText', (e, p, text) => {
  fs.writeFileSync(p, text, 'utf8');
  return true;
});

// Write a dataURL to an arbitrary path (e.g. save test pattern PNG)
ipcMain.handle('file:writeDataUrl', (e, p, dataUrl) => {
  const m = String(dataUrl).match(/^data:[^;]+;base64,(.+)$/s);
  if (!m) throw new Error('Invalid dataURL');
  fs.writeFileSync(p, Buffer.from(m[1], 'base64'));
  return true;
});

// Write a dataURL (e.g. rasterized mask / test pattern PNG) to a temp file, returns the path
ipcMain.handle('file:writeTempDataUrl', (e, name, dataUrl) => {
  const m = String(dataUrl).match(/^data:[^;]+;base64,(.+)$/s);
  if (!m) throw new Error('Invalid dataURL');
  const safe = String(name).replace(/[^\w.-]/g, '_');
  const p = path.join(os.tmpdir(), `xre-${Date.now()}-${safe}`);
  fs.writeFileSync(p, Buffer.from(m[1], 'base64'));
  return p;
});

ipcMain.handle('shell:showInFolder', (e, p) => {
  shell.showItemInFolder(p);
});

ipcMain.handle('shell:openExternal', (e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle('path:parse', (e, p) => ({
  dir: path.dirname(p),
  base: path.basename(p, path.extname(p)),
  ext: path.extname(p).toLowerCase(),
}));

ipcMain.handle('path:join', (e, ...parts) => path.join(...parts));
ipcMain.handle('path:toFileUrl', (e, p) => require('url').pathToFileURL(p).href);

ipcMain.handle('ffmpeg:caps', () => renderMod.getCapabilities());
ipcMain.handle('render:start', (e, payload) => renderMod.startBatch(win, payload));
ipcMain.handle('render:cancel', () => renderMod.cancel());
ipcMain.handle('preview:probe', (e, src) => {
  const caps = renderMod.getCapabilities();
  if (!caps.proresPath) throw new Error('ffmpeg not found');
  return renderMod.probeMedia(caps.proresPath, src);
});
ipcMain.handle('preview:frame', (e, src, timeSec) => renderMod.extractFrame(src, timeSec || 0));
ipcMain.handle('preview:waveform', (e, src) => {
  try {
    return renderMod.extractWaveform(src);
  } catch (err) {
    return null;
  }
});

// ---------------- watch folder ----------------
const MEDIA_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif',
  'mov', 'mp4', 'm4v', 'avi', 'mkv', 'mxf', 'webm', 'mpg', 'mpeg',
]);
let watcher = null;
const watchPending = new Map(); // path -> {size, timer}

function stopWatch() {
  if (watcher) {
    try { watcher.close(); } catch (e) { /* closed */ }
    watcher = null;
  }
  for (const p of watchPending.values()) clearTimeout(p.timer);
  watchPending.clear();
}

// Wait until the file size is stable (copy finished), then notify the renderer
function scheduleStableCheck(fullPath) {
  const check = () => {
    let size = -1;
    try {
      size = fs.statSync(fullPath).size;
    } catch (e) {
      watchPending.delete(fullPath);
      return;
    }
    const prev = watchPending.get(fullPath);
    if (prev && prev.size === size && size > 0) {
      watchPending.delete(fullPath);
      if (win && !win.isDestroyed()) win.webContents.send('watch:file', fullPath);
    } else {
      watchPending.set(fullPath, { size, timer: setTimeout(check, 900) });
    }
  };
  const existing = watchPending.get(fullPath);
  if (existing) clearTimeout(existing.timer);
  watchPending.set(fullPath, { size: -2, timer: setTimeout(check, 900) });
}

ipcMain.handle('watch:start', (e, dir) => {
  stopWatch();
  const existing = new Set(fs.readdirSync(dir));
  watcher = fs.watch(dir, (event, filename) => {
    if (!filename) return;
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    if (!MEDIA_EXTS.has(ext)) return;
    if (filename.startsWith('.')) return;
    const fullPath = path.join(dir, filename);
    if (existing.has(filename) && !watchPending.has(fullPath)) return;
    existing.add(filename);
    if (!fs.existsSync(fullPath)) return;
    scheduleStableCheck(fullPath);
  });
  return true;
});

ipcMain.handle('watch:stop', () => {
  stopWatch();
  return true;
});
