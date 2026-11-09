'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, powerSaveBlocker, Notification, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const renderMod = require('./src/main/render');
const { checkOutputDir } = require('./src/main/errors');
const ExportPlan = require('./src/shared/exportplan');
const Files = require('./src/main/output-files');
const Store = require('./src/main/file-store');
const Outputs = require('./src/shared/outputs');
const AppInfo = require('./src/shared/appinfo');
const Maintenance = require('./src/main/app-info');
const ExportLog = require('./src/main/export-log');
const APP_VERSION = require('./package.json').version; // also right when started through another entry script

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
    {
      label: 'Help',
      submenu: [
        { label: `About ${app.getName()}`, click: () => sendMenu('about') },
        { label: 'Open-source licenses', click: () => sendMenu('licenses') },
        { type: 'separator' },
        { label: 'Copy diagnostics', click: () => sendMenu('diagnostics') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendMenu(action) {
  if (win && !win.isDestroyed()) win.webContents.send('app:menu', action);
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

// One copy at a time: a second one would run its own autosave and watch folder next to the
// first. Only for the installed app; development runs and tool modes come and go side by side.
const toolMode = [screenshotArg, makeIconArg, makeHeroArg, makePosterArg, makeVideoArg, shootArg, makeTutArg, e2eArg].some(Boolean);
const wantsSingleInstance = !toolMode && (app.isPackaged || process.env.XRE_SINGLE_INSTANCE === '1');
const isSecondCopy = wantsSingleInstance && !app.requestSingleInstanceLock();
if (isSecondCopy) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// E2E test mode: load the real app (all IPC handlers live) and run a page-side script.
// The script runs as an async body; its return value is printed as E2E RESULT.
function runE2E() {
  const scriptPath = e2eArg.slice('--e2e='.length);
  const w = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: process.env.E2E_SHOW === '1',
    backgroundColor: '#121416',
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
    backgroundColor: '#121416',
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
    await js('window.__demoApi.openPanels()'); // the tutorial points at settings inside the folded sections
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

// Asks the page whether it may close (it asks about unsaved work itself). A page that does
// not even answer "asking" in time has hung or crashed: it can't save anything, so close.
function pageAllowsClose(target) {
  const wc = target.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (answer) => {
      clearTimeout(noAnswer);
      ipcMain.removeListener('app:close-answer', onAnswer);
      resolve(answer);
    };
    const onAnswer = (e, answer) => {
      if (e.sender !== wc) return;
      if (answer === 'asking') clearTimeout(noAnswer);
      else finish(answer === true);
    };
    const noAnswer = setTimeout(() => finish(true), 5000);
    ipcMain.on('app:close-answer', onAnswer);
    wc.send('app:close-request');
  });
}

async function closeSteps(target) {
  if (!(await pageAllowsClose(target))) return;
  if (renderMod.isBusy()) {
    // Not a sync dialog: ffmpeg keeps running behind it. "Stop" lets ffmpeg stop and the
    // temporary files go before the window really closes.
    const { response } = await dialog.showMessageBox(target, {
      type: 'warning',
      message: 'An export is still running.',
      detail: 'Stop it and close the app? The file being exported is removed; finished files are kept.',
      buttons: ['Keep exporting', 'Stop and close'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return;
    renderMod.cancel();
    await renderMod.whenIdle();
  }
  closeConfirmed = true;
  if (!target.isDestroyed()) target.close();
}

// Unsaved work is asked about first: answering it never stops an export that then keeps running.
let closeAsking = false;
let closeConfirmed = false;
function confirmClose(e, target) {
  if (closeConfirmed) return;
  e.preventDefault();
  if (closeAsking) return;
  closeAsking = true;
  closeSteps(target).finally(() => {
    closeAsking = false;
  });
}

// The window died, the program didn't. An export still running has no page left to report to,
// and a reloaded page would look idle next to it, so it stops first. The work comes back
// from the autosave.
const logDir = () => path.join(app.getPath('userData'), 'logs');
let crashTimes = [];
let recoveringCrash = false;
async function recoverFromCrash(target, details) {
  if (details.reason === 'clean-exit' || recoveringCrash || target.isDestroyed()) return;
  recoveringCrash = true;
  try {
    ExportLog.appendCrash(logDir(), `window process gone: ${details.reason} (exit code ${details.exitCode})`);
    const wasExporting = renderMod.isBusy();
    if (wasExporting) {
      renderMod.cancel();
      await renderMod.whenIdle();
    }
    const step = Maintenance.crashAction(crashTimes, Date.now(), 60000, 2);
    crashTimes = step.recent;
    const detail = wasExporting
      ? 'The running export was stopped. Finished files are kept. Your mapping comes back from the autosave.'
      : 'Your mapping comes back from the autosave.';
    const { response } = await dialog.showMessageBox(target, {
      type: 'error',
      message: 'The app window stopped unexpectedly.',
      detail: step.ask ? `${detail}\n\nThis has now happened several times in a row.` : detail,
      buttons: step.ask ? ['Close the app', 'Try again'] : ['Continue'],
      defaultId: step.ask ? 1 : 0,
      cancelId: step.ask ? 0 : 0,
    });
    if (step.ask && response === 0) {
      closeConfirmed = true;
      if (!target.isDestroyed()) target.close();
      return;
    }
    if (!target.isDestroyed()) target.webContents.reload();
  } finally {
    recoveringCrash = false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#121416',
    title: 'XtremeLED Remap Export',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const thisWindow = win;
  win.on('close', (e) => confirmClose(e, thisWindow));
  win.webContents.on('render-process-gone', (e, details) => recoverFromCrash(thisWindow, details));

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
  if (isSecondCopy) return;
  if (process.platform === 'win32') app.setAppUserModelId('nl.xtremeled.remapexport'); // Windows shows no notifications without it
  renderMod.setLogging({ dir: logDir(), app: { version: APP_VERSION, platform: process.platform, arch: process.arch } });
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
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: APP_VERSION, copyright: 'XtremeLED' });
  }
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => renderMod.cancel()); // no ffmpeg left behind, whatever ended the app
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

ipcMain.handle('dialog:message', async (e, opts = {}) => {
  const res = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), opts);
  return res.response;
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

ipcMain.handle('file:writeText', async (e, p, text) => {
  await Store.writeTextSafely(p, text);
  return true;
});

ipcMain.handle('file:exists', (e, paths) => Store.filesExist(paths));
ipcMain.handle('file:findByName', (e, dir, names) => Store.findByName(dir, names));

const refStoreDir = () => path.join(app.getPath('userData'), 'reference-images');
ipcMain.handle('refs:put', (e, key, dataUrl) => Store.refPut(refStoreDir(), key, dataUrl));
ipcMain.handle('refs:get', (e, key) => Store.refGet(refStoreDir(), key));
ipcMain.handle('refs:prune', (e, keepKeys) => Store.refPrune(refStoreDir(), keepKeys));

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

ipcMain.handle('clipboard:writeText', (e, text) => clipboard.writeText(String(text)));

ipcMain.handle('shell:showInFolder', (e, p) => {
  shell.showItemInFolder(p);
});

ipcMain.handle('shell:openFolder', async (e, dir) => {
  // The path can come from a project file: openPath on a file would launch it
  if (!fs.statSync(dir).isDirectory()) throw new Error('Not a folder');
  const problem = await shell.openPath(dir);
  if (problem) throw new Error(problem);
});

ipcMain.handle('shell:openExternal', (e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle('app:paths', () => ({ temp: os.tmpdir(), documents: app.getPath('documents') }));

// ---------------- about, updates, diagnostics ----------------
// Written by the test run of the build (XRE_BUILD_INFO); absent for a build that ran none
function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function appFacts() {
  return {
    version: APP_VERSION,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    packaged: app.isPackaged,
    buildInfo: readBuildInfo(),
  };
}

// The hash of a 200 MB file takes a moment: once per ffmpeg path, off the main thread's back
const pinChecks = new Map();
function ffmpegPin() {
  const caps = renderMod.getCapabilities();
  const ffPath = caps.proresPath || (caps.entries[0] && caps.entries[0].path) || null;
  if (!pinChecks.has(ffPath)) pinChecks.set(ffPath, Maintenance.pinStatus(ffPath));
  return pinChecks.get(ffPath);
}

ipcMain.handle('app:info', () => appFacts());
ipcMain.handle('app:ffmpeg-pin', () => ffmpegPin());

ipcMain.handle('app:licenses', () => {
  const dirs = [path.join(process.resourcesPath || '', 'licenses'), path.join(__dirname, 'licenses')];
  const dir = dirs.find((d) => fs.existsSync(path.join(d, 'NOTICE.txt')));
  if (!dir) return null;
  const read = (n) => fs.readFileSync(path.join(dir, n), 'utf8');
  return { notice: read('NOTICE.txt'), gpl: read('FFmpeg-GPLv3.txt') };
});

ipcMain.handle('app:diagnostics', async () => Maintenance.buildDiagnostics({
  ...appFacts(),
  ffmpeg: renderMod.getCapabilities(),
  pin: await ffmpegPin(),
  log: ExportLog.latestLog(logDir()),
}));

// Never during an export; offline and any other trouble count as "no news"
ipcMain.handle('app:update-check', () => Maintenance.checkForUpdate(APP_VERSION, { isBusy: renderMod.isBusy, fetch: net.fetch.bind(net) }));
ipcMain.handle('app:open-release', (e, url) => {
  if (AppInfo.isReleaseUrl(url)) shell.openExternal(url);
});

// For each folder: can we write there, how much room is left and on which disk.
ipcMain.handle('output:folders', async (e, dirs) => Promise.all(dirs.map(async (dir) => {
  const problem = checkOutputDir(dir);
  let freeBytes = null;
  try {
    const st = await fs.promises.statfs(dir);
    freeBytes = st.bavail * st.bsize;
  } catch (err) {
    /* gone or not supported here: the size line then leaves the free space out */
  }
  return { dir, problem: problem ? problem.message : null, freeBytes, volume: ExportPlan.volumeLabel(dir, process.platform) };
})));

ipcMain.on('app:taskbar-progress', (e, fraction) => {
  const target = BrowserWindow.fromWebContents(e.sender);
  if (target && !target.isDestroyed()) target.setProgressBar(fraction);
});

// Only when the app is not in front: the toast is for someone working in another program.
// Kept in a variable so it is not collected before it can be clicked.
let exportNotice = null;
ipcMain.on('app:export-notice', (e, notice) => {
  const target = BrowserWindow.fromWebContents(e.sender);
  if (!target || target.isDestroyed() || target.isFocused() || !Notification.isSupported()) return;
  exportNotice = new Notification({ title: notice.title, body: notice.body });
  exportNotice.on('click', () => {
    if (notice.showPath) shell.showItemInFolder(notice.showPath);
    if (!target.isDestroyed()) target.show();
  });
  exportNotice.show();
});

ipcMain.handle('path:parse', (e, p) => ({
  dir: path.dirname(p),
  base: path.basename(p, path.extname(p)),
  ext: path.extname(p).toLowerCase(),
}));

ipcMain.handle('path:join', (e, ...parts) => path.join(...parts));
ipcMain.handle('path:toFileUrl', (e, p) => require('url').pathToFileURL(p).href);

ipcMain.handle('ffmpeg:caps', () => renderMod.getCapabilities());
ipcMain.handle('ffmpeg:gpu', () => renderMod.detectGpu());
ipcMain.handle('render:start', async (e, payload) => {
  const sleepBlock = powerSaveBlocker.start('prevent-app-suspension');
  try {
    return await renderMod.startBatch(BrowserWindow.fromWebContents(e.sender), payload);
  } finally {
    powerSaveBlocker.stop(sleepBlock);
    const done = BrowserWindow.fromWebContents(e.sender);
    if (done && !done.isDestroyed()) done.setProgressBar(-1); // also when the page never got to say so
  }
});
ipcMain.handle('render:cancel', () => renderMod.cancel());
ipcMain.handle('estimate:sample', (e, payload) => renderMod.sampleOutputSize(payload));
ipcMain.handle('render:existing', (e, targets) => renderMod.existingOutputs(targets));
ipcMain.handle('preview:probe', (e, src, sequence) => {
  const caps = renderMod.getCapabilities();
  if (!caps.proresPath) throw new Error('ffmpeg not found');
  return renderMod.probeSource(caps.proresPath, src, sequence);
});
ipcMain.handle('preview:frame', (e, src, timeSec, sequence) => renderMod.extractFrame(src, timeSec || 0, sequence));
ipcMain.handle('check:frame', (e, payload) => renderMod.checkFrame(payload));
ipcMain.handle('test:player', (e, input) => renderMod.makePlayerTest(BrowserWindow.fromWebContents(e.sender), input));
ipcMain.handle('footage:scan', (e, paths, mediaExts, keepOtherFiles) => renderMod.scanFootage(paths, mediaExts, keepOtherFiles));
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
const watchPending = new Map(); // path -> {size, mtime, since, timer}
const WATCH_POLL_MS = 1000;
const WATCH_STABLE_MS = 5000;
let watchTarget = null; // the window that started the watch

function stopWatch() {
  if (watcher) {
    try { watcher.close(); } catch (e) { /* closed */ }
    watcher = null;
  }
  for (const p of watchPending.values()) clearTimeout(p.timer);
  watchPending.clear();
}

// A file counts as arrived once it has not changed for a while and, on Windows, nobody is
// still writing it: during a copy Windows reports the full size from the start.
function scheduleStableCheck(fullPath) {
  const check = () => {
    let st;
    try {
      st = fs.statSync(fullPath);
    } catch (e) {
      watchPending.delete(fullPath);
      return;
    }
    const prev = watchPending.get(fullPath);
    const unchanged = prev && prev.size === st.size && prev.mtime === st.mtimeMs && st.size > 0;
    const since = unchanged ? prev.since : Date.now();
    if (unchanged && Date.now() - since >= WATCH_STABLE_MS && !Files.fileIsBusy(fullPath)) {
      watchPending.delete(fullPath);
      if (watchTarget && !watchTarget.isDestroyed()) watchTarget.webContents.send('watch:file', fullPath);
    } else {
      watchPending.set(fullPath, { size: st.size, mtime: st.mtimeMs, since, timer: setTimeout(check, WATCH_POLL_MS) });
    }
  };
  const existing = watchPending.get(fullPath);
  if (existing) clearTimeout(existing.timer);
  watchPending.set(fullPath, { size: -2, mtime: 0, since: 0, timer: setTimeout(check, WATCH_POLL_MS) });
}

ipcMain.handle('watch:start', (e, dir) => {
  stopWatch();
  watchTarget = BrowserWindow.fromWebContents(e.sender);
  const existing = new Set(fs.readdirSync(dir));
  watcher = fs.watch(dir, (event, filename) => {
    if (!filename) return;
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    if (!MEDIA_EXTS.has(ext)) return;
    if (filename.startsWith('.') || Outputs.isTempName(filename)) return;
    const fullPath = path.join(dir, filename);
    if (renderMod.isOwnOutput(fullPath)) return; // never re-export what this app just wrote
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
