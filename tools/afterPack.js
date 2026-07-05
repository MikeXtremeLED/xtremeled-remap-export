'use strict';
// Ad-hoc code sign macOS builds (no Apple Developer certificate available).
// Required for Apple Silicon: unsigned arm64 apps refuse to launch.
const path = require('path');
const { execSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'pipe' });
    console.log(`  • ad-hoc signed ${appName} (${context.arch === 3 ? 'arm64' : 'x64'})`);
  } catch (e) {
    console.warn('  • ad-hoc signing failed:', e.message);
  }
};
