'use strict';
// 1) Strip ffmpeg binaries that don't belong to the target platform/arch
//    (each is 60-150 MB — shipping all three would triple the installer size).
// 2) Ad-hoc code sign macOS builds (no Apple Developer certificate available) —
//    required for Apple Silicon: unsigned arm64 apps refuse to launch.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ALL_FFMPEG = ['ffmpeg-x64', 'ffmpeg-arm64', 'ffmpeg-win64.exe', 'ffmpeg'];

function stripFfmpeg(binDir, keep) {
  if (!fs.existsSync(binDir)) return;
  for (const name of ALL_FFMPEG) {
    if (name === keep) continue;
    const p = path.join(binDir, name);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      console.log(`  • stripped ${name}`);
    }
  }
}

exports.default = async function afterPack(context) {
  const isMac = context.electronPlatformName === 'darwin';
  const isWin = context.electronPlatformName === 'win32';
  // electron-builder Arch enum: 1 = x64, 3 = arm64
  const arch = context.arch === 3 ? 'arm64' : 'x64';

  if (isMac) {
    const appName = context.packager.appInfo.productFilename + '.app';
    const appPath = path.join(context.appOutDir, appName);
    const binDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'bin', 'ffmpeg-dxv');
    stripFfmpeg(binDir, arch === 'arm64' ? 'ffmpeg-arm64' : 'ffmpeg-x64');
    try {
      execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'pipe' });
      console.log(`  • ad-hoc signed ${appName} (${arch})`);
    } catch (e) {
      console.warn('  • ad-hoc signing failed:', e.message);
    }
  } else if (isWin) {
    const binDir = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'bin', 'ffmpeg-dxv');
    stripFfmpeg(binDir, 'ffmpeg-win64.exe');
  }
};
