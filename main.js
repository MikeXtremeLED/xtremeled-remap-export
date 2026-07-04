'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const renderMod = require('./src/main/render');

let win = null;
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='));

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

  const loadOpts = screenshotArg ? { query: { demo: '1' } } : undefined;
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

app.whenReady().then(createWindow);
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
