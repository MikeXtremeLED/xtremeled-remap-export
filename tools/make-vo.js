'use strict';
// Generates the tutorial voice-over from tools/vo-manifest.json using a macOS voice,
// checks each line fits inside its scene, and writes /tmp/vo/timeline.txt (start|file).
// Usage: node tools/make-vo.js "Ava (Premium)" [rate]
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const voice = process.argv[2] || 'Ava (Premium)';
const rate = process.argv[3] || '175';
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'vo-manifest.json'), 'utf8'));
const OUT = '/tmp/vo';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function aiffDur(f) {
  const out = execSync(`afinfo "${f}" 2>/dev/null | grep -m1 'estimated duration'`).toString();
  const m = out.match(/([\d.]+)\s*sec/);
  return m ? parseFloat(m[1]) : 0;
}

const tl = [];
let warn = 0;
manifest.forEach((line, i) => {
  const f = path.join(OUT, `line_${String(i).padStart(2, '0')}.aiff`);
  execSync(`say -v "${voice}" -r ${rate} -o "${f}" ${JSON.stringify(line.text)}`);
  const d = aiffDur(f);
  const end = line.start + d;
  const fits = end <= line.sceneEnd + 0.25;
  if (!fits) { warn++; console.log(`  ⚠ line ${i}: ends ${end.toFixed(1)}s > scene ${line.sceneEnd.toFixed(1)}s  "${line.text}"`); }
  tl.push(`${line.start}|${f}`);
});
fs.writeFileSync(path.join(OUT, 'timeline.txt'), tl.join('\n'));
console.log(`VO done: ${manifest.length} lines, ${warn} too long, voice="${voice}" rate=${rate}`);
