'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('xre', {
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts || {}),
  openDirDialog: (opts) => ipcRenderer.invoke('dialog:openDir', opts || {}),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts || {}),
  readFileText: (p) => ipcRenderer.invoke('file:readText', p),
  readFileDataUrl: (p) => ipcRenderer.invoke('file:readDataUrl', p),
  writeFileText: (p, t) => ipcRenderer.invoke('file:writeText', p, t),
  writeTempDataUrl: (name, dataUrl) => ipcRenderer.invoke('file:writeTempDataUrl', name, dataUrl),
  writeFileDataUrl: (p, dataUrl) => ipcRenderer.invoke('file:writeDataUrl', p, dataUrl),
  showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  previewWaveform: (src) => ipcRenderer.invoke('preview:waveform', src),
  pathParse: (p) => ipcRenderer.invoke('path:parse', p),
  pathJoin: (...parts) => ipcRenderer.invoke('path:join', ...parts),
  pathToFileUrl: (p) => ipcRenderer.invoke('path:toFileUrl', p),
  ffmpegCaps: () => ipcRenderer.invoke('ffmpeg:caps'),
  previewProbe: (src) => ipcRenderer.invoke('preview:probe', src),
  previewFrame: (src, timeSec) => ipcRenderer.invoke('preview:frame', src, timeSec),
  renderStart: (payload) => ipcRenderer.invoke('render:start', payload),
  renderCancel: () => ipcRenderer.invoke('render:cancel'),
  watchStart: (dir) => ipcRenderer.invoke('watch:start', dir),
  watchStop: () => ipcRenderer.invoke('watch:stop'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onRenderEvent: (cb) => {
    ipcRenderer.on('render:event', (e, data) => cb(data));
  },
  onWatchFile: (cb) => {
    ipcRenderer.on('watch:file', (e, p) => cb(p));
  },
});
