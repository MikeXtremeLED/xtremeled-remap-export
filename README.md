# XtremeLED Remap Export

Zet stageview renders (foto/video) om naar output-mapped content voor LED-schermen — zodat je geen dure playout software (zoals Resolume Arena) nodig hebt om content af te spelen. Gemaakt voor macOS, draait via Electron (later ook Windows mogelijk).

## Starten

```bash
cd "~/Documents/XtremeLED remap export"
npm install        # eenmalig
npm start          # of dubbelklik "XtremeLED Remap Export.command"
```

## Hoe het werkt

1. **Input canvas** = de resolutie van je stageview canvas (bijv. 10400×416 voor een 50×2m P4.81 scherm).
2. **Output canvas** = de resolutie van je uiteindelijke output (bijv. 3840×2160).
3. Maak **slices**: elke slice heeft een *input rect* (waar hij uit de stageview knipt) en een *output rect* (waar hij op de output geplaatst wordt) — net als Resolume Advanced Output.
4. **Render**: kies stageview foto's/video's → de app knipt en plaatst alles automatisch → klaar om af te spelen vanaf elke laptop.

### Features

- **Import XML** — laad een Resolume Advanced Output XML; slice-masks (lange strip over meerdere rijen) worden automatisch omgerekend naar losse slices.
- **Export XML** — sla je mapping op als Resolume-compatible XML.
- **Auto-split** — verdeel een lange slice (bijv. 50m×1m scherm) automatisch over meerdere rijen op de output canvas.
- **Reference image** — laad een stageview afbeelding als onderlaag in de Input Map; de Output Map toont live een preview van hoe de content gemapt wordt.
- **Render** — batch-render:
  - **Apple ProRes 422 HQ** (.mov)
  - **DXV3** (.mov) — via de meegeleverde ffmpeg 8 in `bin/ffmpeg-dxv/`
  - **PNG (still)** — één remapped beeld, bijv. om via PowerPoint af te spelen; bij een video wordt het eerste frame gebruikt.
  - Foto's worden 1 seconde video (duur en fps instelbaar, standaard 50 fps).
  - Audio van videobronnen wordt meegenomen (PCM).
- **Project opslaan/openen** (`.xreproj`), automatische sessie-herstel, drag & drop van XML/afbeeldingen/video's.

### Bediening editor

- Slepen = slice verplaatsen (met snapping op canvas- en slice-randen)
- Witte handles = schalen
- Scroll = pannen · ⌘/Ctrl+scroll = zoomen · spatie+slepen = pannen
- Pijltjestoetsen = 1px verschuiven (Shift = 10px) · Delete = verwijderen · ⌘D = dupliceren

## Tests

```bash
npm test
```

Test XML import/export (round-trip met het echte 50x2m voorbeeldbestand in `examples/`) en een echte ffmpeg render.

## Mac app (.app / .dmg) bouwen

```bash
npm install --save-dev electron-builder
npx electron-builder --mac
```

Voor Windows later: `npx electron-builder --win` (op een Windows machine of met wine).

## Opmerkingen

- De bron wordt geschaald naar het input canvas — zorg dat je stageview render dezelfde verhouding heeft als je input canvas.
- DXV3 via ffmpeg gebruikt DXT1 (DXV "Normal Quality", geen alpha); Resolume speelt dit direct af. Voor maximale kwaliteit is ProRes HQ de betere keuze.
- Output-canvasafmetingen worden bij het renderen op even getallen afgerond (ProRes 4:2:2 vereiste).
