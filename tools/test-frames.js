'use strict';
// Quick check: render single tutorial frames at given times (electron tools/test-frames.js t1 t2 …)
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const times = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));
const outDir = '/tmp/tut-test';
fs.mkdirSync(outDir, { recursive: true });

app.whenReady().then(() => {
  const w = new BrowserWindow({
    width: 1920, height: 1080, show: false, frame: false,
    webPreferences: { offscreen: true },
  });
  w.loadFile(path.join(__dirname, 'tutorial-build.html'), { query: { capture: '1' } });
  w.webContents.once('did-finish-load', async () => {
    for (let i = 0; i < 200; i++) {
      const ready = await w.webContents.executeJavaScript('window.__ready === true').catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const t of times) {
      await w.webContents.executeJavaScript(`window.__seek(${t})`);
      const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1920, height: 1080 });
      fs.writeFileSync(path.join(outDir, `t${t}.png`), img.toPNG());
      console.log('frame', t);
    }
    console.log('TESTFRAMES_DONE');
    app.quit();
  });
});
