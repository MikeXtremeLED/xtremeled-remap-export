'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('xre', {
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts || {}),
  openDirDialog: (opts) => ipcRenderer.invoke('dialog:openDir', opts || {}),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts || {}),
  readFileText: (p) => ipcRenderer.invoke('file:readText', p),
  readFileDataUrl: (p) => ipcRenderer.invoke('file:readDataUrl', p),
  messageBox: (opts) => ipcRenderer.invoke('dialog:message', opts),
  writeFileText: (p, t) => ipcRenderer.invoke('file:writeText', p, t),
  filesExist: (paths) => ipcRenderer.invoke('file:exists', paths),
  findInFolder: (dir, names) => ipcRenderer.invoke('file:findByName', dir, names),
  refPut: (key, dataUrl) => ipcRenderer.invoke('refs:put', key, dataUrl),
  refGet: (key) => ipcRenderer.invoke('refs:get', key),
  refPrune: (keepKeys) => ipcRenderer.invoke('refs:prune', keepKeys),
  onCloseRequest: (cb) => {
    ipcRenderer.on('app:close-request', () => cb());
  },
  answerClose: (answer) => ipcRenderer.send('app:close-answer', answer),
  writeTempDataUrl: (name, dataUrl) => ipcRenderer.invoke('file:writeTempDataUrl', name, dataUrl),
  writeFileDataUrl: (p, dataUrl) => ipcRenderer.invoke('file:writeDataUrl', p, dataUrl),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  previewWaveform: (src) => ipcRenderer.invoke('preview:waveform', src),
  pathParse: (p) => ipcRenderer.invoke('path:parse', p),
  pathJoin: (...parts) => ipcRenderer.invoke('path:join', ...parts),
  pathToFileUrl: (p) => ipcRenderer.invoke('path:toFileUrl', p),
  ffmpegCaps: () => ipcRenderer.invoke('ffmpeg:caps'),
  ffmpegGpu: () => ipcRenderer.invoke('ffmpeg:gpu'),
  previewProbe: (src) => ipcRenderer.invoke('preview:probe', src),
  previewFrame: (src, timeSec) => ipcRenderer.invoke('preview:frame', src, timeSec),
  renderStart: (payload) => ipcRenderer.invoke('render:start', payload),
  renderCancel: () => ipcRenderer.invoke('render:cancel'),
  outputsExisting: (targets) => ipcRenderer.invoke('render:existing', targets),
  estimateSample: (payload) => ipcRenderer.invoke('estimate:sample', payload),
  outputFolders: (dirs) => ipcRenderer.invoke('output:folders', dirs),
  appPaths: () => ipcRenderer.invoke('app:paths'),
  openFolder: (dir) => ipcRenderer.invoke('shell:openFolder', dir),
  setTaskbarProgress: (fraction) => ipcRenderer.send('app:taskbar-progress', fraction),
  notifyExportDone: (notice) => ipcRenderer.send('app:export-notice', notice),
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
