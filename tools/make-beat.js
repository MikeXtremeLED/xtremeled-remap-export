'use strict';
// Generates an original royalty-free electronic beat (16s, 120 BPM, A-minor Am-F-C-G)
// synced to the promo video's scenes. Writes a 16-bit stereo WAV to argv[2].
// Pure synthesis — no samples, no copyright.
const fs = require('fs');

const SR = 44100;
const DUR = 16;
const N = SR * DUR;
const BPM = 120;
const beat = 60 / BPM;      // 0.5s
const bar = beat * 4;       // 2s
const L = new Float64Array(N);
const R = new Float64Array(N);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const note = (semisFromA4) => 440 * Math.pow(2, semisFromA4 / 12);
// helpers for note names in A minor
const A2 = note(-24), C3 = note(-21), D3 = note(-19), E3 = note(-17), F3 = note(-16), G3 = note(-14);
const A3 = note(-12), C4 = note(-9), E4 = note(-5), G4 = note(-2), B3 = note(-10), D4 = note(-7), A4 = 440;

// chord progression per bar (root for bass, triad for chords/arp)
const prog = [
  { root: A2, triad: [A3, C4, E4] }, // Am
  { root: F3, triad: [F3, A3, C4] }, // F
  { root: C3, triad: [C4, E4, G4] }, // C
  { root: G3, triad: [G3, B3, D4] }, // G
];
function chordAt(tSec) {
  const b = Math.floor(tSec / bar) % 4;
  return prog[b];
}

// simple one-pole lowpass state per voice
function makeLP() { return { y: 0 }; }
function lp(state, x, cutoffHz) {
  const a = clamp((2 * Math.PI * cutoffHz) / SR, 0, 1);
  state.y += a * (x - state.y);
  return state.y;
}

// envelopes
function expEnv(tInto, decay) { return Math.exp(-tInto / decay); }
function adsr(tInto, dur, a, d, s, r) {
  if (tInto < 0 || tInto > dur) return 0;
  if (tInto < a) return tInto / a;
  if (tInto < a + d) return 1 - (1 - s) * ((tInto - a) / d);
  if (tInto < dur - r) return s;
  return s * (1 - (tInto - (dur - r)) / r);
}

// sidechain ducking envelope (pumps on every beat)
function sidechain(tSec) {
  const ph = (tSec % beat) / beat;
  // dip to 0.35 at beat, recover
  return 0.35 + 0.65 * clamp(ph * 1.6, 0, 1);
}

// deterministic noise
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; }

// section gains: intro(0-2s) sparse, build(2-8), full(8-14), climax riser(14-16)
function sectionMix(tSec) {
  if (tSec < 2) return { kick: 0.6, bass: 0.5, hat: 0.3, chord: 0.5, arp: 0.0, clap: 0.0 };
  if (tSec < 4) return { kick: 1.0, bass: 0.9, hat: 0.7, chord: 0.7, arp: 0.4, clap: 0.6 };
  if (tSec < 14) return { kick: 1.0, bass: 1.0, hat: 1.0, chord: 0.85, arp: 0.9, clap: 1.0 };
  return { kick: 1.0, bass: 0.7, hat: 1.0, chord: 0.7, arp: 0.7, clap: 0.5 }; // riser section
}

const lpArp = makeLP(), lpChord = makeLP(), lpRise = makeLP();

for (let i = 0; i < N; i++) {
  const t = i / SR;
  const mix = sectionMix(t);
  const ch = chordAt(t);
  const sc = sidechain(t);

  let s = 0;

  // ---- kick: 4 on the floor ----
  {
    const tb = t % beat;
    const env = expEnv(tb, 0.11);
    const pitch = 120 * Math.exp(-tb / 0.03) + 45; // pitch drop
    const k = Math.sin(2 * Math.PI * pitch * tb) * env;
    s += k * 0.9 * mix.kick;
  }

  // ---- sub bass (root), 8th-note pattern with sidechain ----
  {
    const t8 = t % (beat / 2);
    const env = adsr(t8, beat / 2, 0.005, 0.05, 0.8, 0.06);
    const b = Math.sin(2 * Math.PI * ch.root * t) * env;
    s += b * 0.55 * mix.bass * sc;
  }

  // ---- closed hats on 8ths, accent offbeat ----
  {
    const t8 = t % (beat / 2);
    const off = Math.floor((t % beat) / (beat / 2)) === 1;
    const env = expEnv(t8, 0.02);
    const h = lp({ y: 0 }, rnd(), 9000) * env;
    s += h * (off ? 0.28 : 0.16) * mix.hat;
  }

  // ---- clap/snare on beats 2 & 4 ----
  {
    const tb2 = (t % (beat * 2));
    const hit = beat; // beat 2 within 2-beat window; also beat 4 -> use beat*... simpler: on every 2nd beat
    const tinto = (t % (beat * 2)) - beat;
    if (tinto >= 0) {
      const env = expEnv(tinto, 0.09);
      const c = lp({ y: 0 }, rnd(), 5000) * env;
      s += c * 0.4 * mix.clap;
    }
  }

  // ---- chord pad (saw-ish via summed sines), sidechained ----
  {
    let c = 0;
    for (const f of ch.triad) {
      c += Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 2 * t);
    }
    c /= ch.triad.length * 1.5;
    c = lp(lpChord, c, 2200);
    s += c * 0.18 * mix.chord * sc;
  }

  // ---- arp: 16th-note arpeggio of the triad ----
  {
    const step = beat / 4;
    const idx = Math.floor(t / step);
    const f = ch.triad[idx % ch.triad.length] * 2; // one octave up
    const tinto = t % step;
    const env = adsr(tinto, step, 0.004, 0.04, 0.3, 0.03);
    let a = Math.sin(2 * Math.PI * f * t);
    a += 0.5 * (2 * ((f * t) % 1) - 1); // saw layer
    a = lp(lpArp, a, 3500 + 2000 * Math.sin(t * 0.5));
    s += a * env * 0.16 * mix.arp * sc;
  }

  // ---- riser sweep in the last 2 bars (14-16s) into the CTA ----
  if (t >= 14) {
    const p = (t - 14) / 2; // 0..1
    const cutoff = 400 + p * p * 9000;
    let nz = lp(lpRise, rnd(), cutoff);
    const swell = p * p;
    s += nz * 0.25 * swell;
    // rising tone
    const tone = Math.sin(2 * Math.PI * (300 + p * 1400) * t) * 0.08 * swell;
    s += tone;
  }
  // impact on the CTA hit at ~13.7-14 (downbeat of bar 8)
  {
    const tImpact = t - 14;
    if (tImpact >= 0 && tImpact < 0.5) {
      const env = expEnv(tImpact, 0.25);
      s += Math.sin(2 * Math.PI * 60 * tImpact) * env * 0.5; // big kick/impact
      s += lp({ y: 0 }, rnd(), 6000) * env * 0.25; // crash-ish
    }
  }

  // master: gentle stereo width + soft limit
  const width = 0.015 * Math.sin(2 * Math.PI * 0.7 * t);
  let ls = s * (1 - width);
  let rs = s * (1 + width);
  // soft clip
  ls = Math.tanh(ls * 1.1);
  rs = Math.tanh(rs * 1.1);
  L[i] = ls;
  R[i] = rs;
}

// fade in/out
const fadeIn = SR * 0.05, fadeOut = SR * 0.5;
for (let i = 0; i < fadeIn; i++) { const g = i / fadeIn; L[i] *= g; R[i] *= g; }
for (let i = 0; i < fadeOut; i++) { const g = i / fadeOut; L[N - 1 - i] *= g; R[N - 1 - i] *= g; }

// write 16-bit stereo WAV
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
let o = 44;
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(clamp(Math.round(L[i] * 32000), -32768, 32767), o); o += 2;
  buf.writeInt16LE(clamp(Math.round(R[i] * 32000), -32768, 32767), o); o += 2;
}
fs.writeFileSync(process.argv[2] || '/tmp/beat.wav', buf);
console.log('Beat written:', process.argv[2], `${DUR}s ${BPM}BPM`);
