'use strict';
// Renames the dev Electron binary to "XtremeLED Remap Export" (macOS menu bar shows
// the CFBundleName from Info.plist). Re-signs ad-hoc afterwards so the app still launches.
// Runs automatically via npm postinstall.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NAME = 'XtremeLED Remap Export';
const appDir = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(appDir, 'Contents', 'Info.plist');

if (process.platform !== 'darwin' || !fs.existsSync(plist)) {
  process.exit(0);
}

let t = fs.readFileSync(plist, 'utf8');
if (t.includes(`<string>${NAME}</string>`)) {
  console.log('Electron app name already patched');
  process.exit(0);
}
t = t.replace(
  /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
  `$1${NAME}$2`
);
t = t.replace(
  /(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/,
  `$1${NAME}$2`
);
fs.writeFileSync(plist, t);

try {
  // NB: --preserve-metadata keeps the entitlements (allow-jit etc.) — without it,
  // re-signing breaks Chromium's media codecs (H.264 videos freeze at t=0).
  execSync(`codesign --force --deep --preserve-metadata=entitlements,requirements,flags --sign - "${appDir}"`, { stdio: 'pipe' });
  console.log('Electron app name patched and re-signed');
} catch (e) {
  console.warn('codesign failed (app may still work):', e.message);
}
