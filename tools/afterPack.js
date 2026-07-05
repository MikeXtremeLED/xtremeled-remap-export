'use strict';
// 1) On macOS, remove the ffmpeg binary for the *other* architecture from
//    Contents/Resources/bin (extraResources — NOT inside the asar, so deleting it is
//    safe and cannot break asar integrity). Saves ~60-80 MB per installer.
// 2) Ad-hoc code sign macOS builds (no Apple Developer certificate available) —
//    required for Apple Silicon: unsigned arm64 apps refuse to launch.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

exports.default = async function afterPack(context) {
  const isMac = context.electronPlatformName === 'darwin';
  if (!isMac) return; // Windows resources already contain only ffmpeg-win64.exe

  // electron-builder Arch enum: 1 = x64, 3 = arm64
  const arch = context.arch === 3 ? 'arm64' : 'x64';
  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);
  const binDir = path.join(appPath, 'Contents', 'Resources', 'bin', 'ffmpeg-dxv');

  const drop = arch === 'arm64' ? 'ffmpeg-x64' : 'ffmpeg-arm64';
  const dropPath = path.join(binDir, drop);
  if (fs.existsSync(dropPath)) {
    fs.rmSync(dropPath, { force: true });
    console.log(`  • stripped ${drop} (keeping ffmpeg-${arch})`);
  }

  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'pipe' });
    console.log(`  • ad-hoc signed ${appName} (${arch})`);
  } catch (e) {
    console.warn('  • ad-hoc signing failed:', e.message);
  }
};
