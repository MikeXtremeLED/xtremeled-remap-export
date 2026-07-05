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
4. **Render**: pick stageview footage → the app cuts and places everything automatically.

## Features

- **Import / Export XML** — full round-trip with Resolume Advanced Output XML, including **input masks**, **rotation** (orientation) and **flip**.
- **Input masks** — per slice, exactly like Resolume: enable in the Slice panel, edit numerically or directly on canvas ("Edit on canvas").
- **Rotation & flip** — 90° rotation steps on input and output rects; flip (H/V/both) with pac-man indicator button.
- **Split rows** — cut a wide slice (e.g. a 50m×1m screen) into rows on the output canvas, with live summary of what you'll get.
- **Undo / redo** — ⌘Z / ⇧⌘Z or the toolbar buttons.
- **Reference images** — underlay for the Input Map; the Output Map shows a live preview of the mapped content.
- **Render page** — full-page workflow:
  - Add footage (images/videos), each with its own **clip transform**: fit mode, position, scale, rotation, brightness, contrast, saturation, hue, blur — with a **live preview frame** on the input map and a **timeline scrubber** for videos.
  - **Apple ProRes 422 HQ** (.mov), **DXV3** (.mov, bundled ffmpeg 8) or **PNG still** (for PowerPoint; videos use the chosen preview frame).
  - Images render as 1 second of video (duration/fps configurable, default 50 fps).
  - Audio from video sources is kept (PCM).
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

## Notes

- With fit mode "Stretch" (default) the source is stretched to the input canvas — use "Fit" and the transform controls when the footage resolution differs from the canvas.
- DXV3 via ffmpeg uses DXT1 (DXV "Normal Quality", no alpha); Resolume plays it directly. For maximum quality use ProRes HQ.
- Output canvas dimensions are rounded to even numbers when rendering (ProRes 4:2:2 requirement).
