#!/bin/bash
# Generates the tutorial voice-over (Samantha, en_US) — one clip per scene,
# timed to the scene starts of tools/gen-tutorial.js (16 scenes / 141 s).
set -e
VOICE="Samantha"
RATE=172
OUT=/tmp/vo
rm -rf "$OUT" && mkdir -p "$OUT"

# "startSec|text"  (start = scene start + small lead-in)
LINES=(
  "0.8|Welcome to XtremeLED Remap Export — turn stageview content into ready-to-play LED output."
  "7.0|This is the Mapping page. You build your input-to-output mapping here — the same slice principle as Resolume."
  "15.4|First, set the input canvas to your stageview resolution, and add one or more output screens."
  "24.4|Then create slices. Each slice takes a region of the input, and places it on the output."
  "33.4|Every slice supports rotation, flipping, and input masks with adjustable key points."
  "42.9|Already have a Resolume setup? Import your Advanced Output XML directly — or export your mapping back to XML."
  "51.9|Switch to the Output Map to preview exactly how your content will land on each screen."
  "60.9|Now, let's export some content."
  "64.4|On the Export page, add your stageview footage — images or video."
  "73.4|You instantly see it on the input map, with all slices and masks drawn on top."
  "82.4|Each clip has its own fit, position, scale, rotation and full color controls — all live in the preview."
  "92.4|Trim your video with draggable in and out points, guided by the audio waveform."
  "101.9|Choose your codec: DXV3 for Resolume, HAP, ProRes, HEVC, H.264, PNG — or even a WAV audio extract."
  "111.9|Set alpha, bit depth and GPU acceleration — or simply match the source with one click."
  "121.4|Check the output view, choose a destination, and hit Start export."
  "130.8|Play the result on any device — a laptop, VLC, even PowerPoint. Free and open source, for Mac and Windows. Download it on GitHub."
)

i=0
for entry in "${LINES[@]}"; do
  start="${entry%%|*}"
  text="${entry#*|}"
  f="$OUT/line_$(printf '%02d' $i).aiff"
  say -v "$VOICE" -r "$RATE" -o "$f" "$text"
  echo "$start|$f" >> "$OUT/timeline.txt"
  i=$((i+1))
done
echo "VOICE_LINES_DONE $i"
