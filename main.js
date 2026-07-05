'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const renderMod = require('./src/main/render');

app.setName('XtremeLED Remap Export');

let win = null;
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='));
const makeIconArg = process.argv.find((a) => a.startsWith('--makeicon='));

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

ipcMain.handle('path:parse', (e, p) => ({
  dir: path.dirname(p),
  base: path.basename(p, path.extname(p)),
  ext: path.extname(p).toLowerCase(),
}));

ipcMain.handle('path:join', (e, ...parts) => path.join(...parts));

ipcMain.handle('ffmpeg:caps', () => renderMod.getCapabilities());
ipcMain.handle('render:start', (e, payload) => renderMod.startBatch(win, payload));
ipcMain.handle('render:cancel', () => renderMod.cancel());
ipcMain.handle('preview:probe', (e, src) => {
  const caps = renderMod.getCapabilities();
  if (!caps.proresPath) throw new Error('ffmpeg not found');
  return renderMod.probeMedia(caps.proresPath, src);
});
ipcMain.handle('preview:frame', (e, src, timeSec) => renderMod.extractFrame(src, timeSec || 0));

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
