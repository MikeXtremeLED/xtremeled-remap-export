#!/bin/bash
# Downloads the Windows ffmpeg build (DXV/HAP/x265) needed to build the Windows installer.
# Not committed to git (149 MB). Run once before: npx electron-builder --win
set -e
cd "$(dirname "$0")/.."
curl -fsSL -o /tmp/xre-ff-win.zip "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
unzip -oq /tmp/xre-ff-win.zip -d /tmp/xre-ff-win
cp /tmp/xre-ff-win/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe bin/ffmpeg-dxv/ffmpeg-win64.exe
echo "ffmpeg-win64.exe installed"
