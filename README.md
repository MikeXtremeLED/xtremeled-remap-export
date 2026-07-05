# XtremeLED Remap Export

Convert stageview renders (image/video) into output-mapped content for LED screens — so you can play content from any laptop without expensive playout software like Resolume Arena. Built for macOS with Electron (Windows possible later).

## Launch

```bash
cd "~/Documents/XtremeLED remap export"
npm install        # once
npm start          # or double-click "XtremeLED Remap Export.command"
```

## How it works

1. **Input canvas** = the resolution of your stageview canvas (e.g. 10400×416 for a 50×2m P4.81 screen).
2. **Output canvas** = the resolution of your final output (e.g. 3840×2160).
3. Create **slices**: each slice has an *input rect* (where it samples the stageview) and an *output rect* (where it lands on the output) — just like Resolume Advanced Output.
4. **Export**: pick stageview footage → the app cuts and places everything automatically.

## Features

- **Import / Export XML** — full round-trip with Resolume Advanced Output XML, including **input masks**, **rotation** (orientation) and **flip**.
- **Input masks with key points** — per slice, exactly like Resolume: polygon masks with draggable points (double-click an edge to add, right-click a point to remove), editable numerically too. Full XML round-trip.
- **Rotation & flip** — 90° rotation steps on input and output rects; flip (H/V/both) with pac-man indicator button.
- **Split rows** — cut a wide slice (e.g. a 50m×1m screen) into rows on the output canvas, with live summary of what you'll get.
- **Undo / redo** — ⌘Z / ⇧⌘Z or the toolbar buttons.
- **Reference images** — underlay for the Input Map; the Output Map shows a live preview of the mapped content.
- **Multiple screens (outputs)** — manage screens in the Project panel; each slice is assigned to a screen. On export you choose: separate file per screen, one merged video (screens side by side), or both.
- **Test pattern** — generate a test card (grid, circles, slice labels) from the Mapping page: set as reference, save as PNG, or send to the Export page to render in any codec.
- **Export page** — full-page workflow:
  - Footage list with per-file selection checkboxes; **test pattern generator** (renders slice names/grid at input canvas size); **watch folder** with auto-export of new files.
  - Per clip: full **info** (resolution, codec, duration, fps, bitrate), **transform** (fit mode, position, linked or separate W/H scale with pixel readout, rotation) and **color** with live preview — Input *and* Output view. Drag the clip directly in the preview (snaps to canvas edges/center).
  - Trim timeline with draggable **in/out handles** and playhead (keys: I / O), Shutter Encoder-style.
  - **GPU acceleration** (VideoToolbox) for ProRes/HEVC/H.264 with automatic CPU fallback.
  - The footage list (with per-file checkboxes) is saved inside the project; drag rows to reorder — slices in the Mapping page reorder the same way.
  - **Codecs**: ProRes 422 Proxy/LT/422/HQ, ProRes 4444 (with/only alpha), DXV3, HAP Standard/Q (HAP alpha), HEVC/H.265 (8/10/12-bit, bitrate), H.264, PNG still (8/16-bit) and PNG sequence (written into its own folder). Codec name is part of the output filename.
  - **Remap same as source** matches codec, bit depth and bitrate of the source footage.
  - Right-click any slider to reset it to its default (like Resolume).
  - Images render as 1 second of video (duration/fps configurable); audio from video sources is kept.
- **Project save/open** (`.xreproj`), session auto-restore, drag & drop everywhere.

### Editor controls

- Drag = move (snaps to canvas and slice edges) · handles = resize
- Scroll = pan · ⌘/Ctrl+scroll = zoom · space+drag = pan
- Arrow keys = nudge 1px (Shift = 10px) · Delete = remove · ⌘D = duplicate · ⌘Z = undo

## Tests

```bash
npm test
```

Covers XML import/export round-trip (with the real 50x2m example in `examples/`), mask/rotation geometry, and real ffmpeg renders (ProRes, DXV3, PNG, clip transforms, frame extraction).

## Build a Mac app (.app / .dmg)

```bash
npm install --save-dev electron-builder
npx electron-builder --mac
```

The app icon lives in `build/icon.icns` (regenerate with `npx electron . --makeicon=build/icon.png` + `iconutil`). For Windows later: `npx electron-builder --win`.

## Intel & Apple Silicon

The app bundles native ffmpeg binaries for both architectures (`bin/ffmpeg-dxv/ffmpeg-x64` and `ffmpeg-arm64`); the right one is picked automatically. On Apple Silicon the x64 binary also works via Rosetta as fallback.

## Notes

- With fit mode "Stretch" (default) the source is stretched to the input canvas — use "Fit" and the transform controls when the footage resolution differs from the canvas.
- DXV3 via ffmpeg uses DXT1 (DXV "Normal Quality", no alpha); Resolume plays it directly. For maximum quality use ProRes HQ.
- Output canvas dimensions are rounded to even numbers when rendering (ProRes 4:2:2 requirement).
