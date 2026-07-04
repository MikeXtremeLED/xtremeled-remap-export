'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('xre', {
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts || {}),
  openDirDialog: (opts) => ipcRenderer.invoke('dialog:openDir', opts || {}),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts || {}),
  readFileText: (p) => ipcRenderer.invoke('file:readText', p),
  readFileDataUrl: (p) => ipcRenderer.invoke('file:readDataUrl', p),
  writeFileText: (p, t) => ipcRenderer.invoke('file:writeText', p, t),
  showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),
  pathParse: (p) => ipcRenderer.invoke('path:parse', p),
  pathJoin: (...parts) => ipcRenderer.invoke('path:join', ...parts),
  ffmpegCaps: () => ipcRenderer.invoke('ffmpeg:caps'),
  renderStart: (payload) => ipcRenderer.invoke('render:start', payload),
  renderCancel: () => ipcRenderer.invoke('render:cancel'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onRenderEvent: (cb) => {
    ipcRenderer.on('render:event', (e, data) => cb(data));
  },
});
