// Where the music accents are, and whether the picture's hits land on them. DOM-free, so the Studio
// (WebAudio-decoded samples) and the CLI (ffmpeg-decoded samples) share one answer.

export const ONSET_SR = 22050;
const N = 1024, HOP = 128, BLOCK = 110; // 46 ms windows every 5.8 ms; levels in 5 ms blocks

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Mono samples at any rate → mono at ONSET_SR (box filter, good enough for onsets). */
export function downsample(x, sr) {
  if (sr === ONSET_SR) return x;
  const r = sr / ONSET_SR, out = new Float32Array(Math.floor(x.length / r));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * r), b = Math.max(a + 1, Math.floor((i + 1) * r));
    let s = 0; for (let k = a; k < b; k++) s += x[k];
    out[i] = s / (b - a);
  }
  return out;
}

const MELS = 64;
const hz2mel = f => 2595 * Math.log10(1 + f / 700), mel2hz = m => 700 * (10 ** (m / 2595) - 1);
let bank = null;
/** Triangular mel filters over the FFT bins (built once). */
function melBank() {
  if (bank) return bank;
  const bins = N / 2 + 1, top = hz2mel(ONSET_SR / 2), pts = [];
  for (let i = 0; i < MELS + 2; i++) pts.push(mel2hz(top * i / (MELS + 1)) / (ONSET_SR / 2) * (bins - 1));
  bank = [];
  for (let m = 0; m < MELS; m++) {
    const [l, c, r] = [pts[m], pts[m + 1], pts[m + 2]], w = [];
    for (let k = Math.floor(l); k <= Math.ceil(r) && k < bins; k++) {
      const v = k < c ? (k - l) / Math.max(1e-9, c - l) : (r - k) / Math.max(1e-9, r - c);
      if (v > 0) w.push([k, v]);
    }
    bank.push(w);
  }
  return bank;
}

/**
 * Onset strength the way librosa computes it: mel spectrogram in dB (80 dB below the loudest frame is the
 * floor), then the mean over bands of the positive frame-to-frame rise; normalised so the 95th percentile is 1.
 * Also returns the mean power per frame (dB) for "cut to quiet" detection.
 */
export function onsetEnvelope(mono, sr = ONSET_SR) {
  const x = downsample(mono, sr);
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const env = new Float32Array(frames), level = new Float32Array(frames);
  const rms = new Float32Array(Math.floor(x.length / BLOCK));
  for (let b = 0; b < rms.length; b++) { let e = 0; for (let i = b * BLOCK; i < (b + 1) * BLOCK; i++) e += x[i] * x[i]; rms[b] = e / BLOCK; }
  const win = new Float32Array(N).map((_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / N));
  const B = melBank();
  const mel = new Float32Array(frames * MELS);
  const re = new Float32Array(N), im = new Float32Array(N);
  let top = -Infinity;
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    let ss = 0;
    for (let i = 0; i < N; i++) { const v = x[o + i]; re[i] = v * win[i]; im[i] = 0; ss += v * v; }
    level[f] = 10 * Math.log10(ss / N + 1e-12);
    fft(re, im);
    for (let m = 0; m < MELS; m++) {
      let e = 0;
      for (const [k, w] of B[m]) e += w * (re[k] * re[k] + im[k] * im[k]);
      const db = 10 * Math.log10(Math.max(e, 1e-10));
      mel[f * MELS + m] = db;
      if (db > top) top = db;
    }
  }
  const floor = top - 80;
  for (let i = 0; i < mel.length; i++) if (mel[i] < floor) mel[i] = floor;
  for (let f = 1; f < frames; f++) {
    let s = 0;
    for (let m = 0; m < MELS; m++) { const d = mel[f * MELS + m] - mel[(f - 1) * MELS + m]; if (d > 0) s += d; }
    env[f] = s / MELS;
  }
  const sorted = [...env].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * .95)] || 1;
  for (let f = 0; f < frames; f++) env[f] /= p95;
  return { env, level, rms, block: BLOCK / ONSET_SR, hop: HOP / ONSET_SR, offset: N / 2 / ONSET_SR };
}

const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0; };

/**
 * For each hit of each scene: the strongest accent from a frame before it to just after it, where it is, and how strong it
 * is next to the loudest accents in the surrounding second (1 = as strong as the strongest there).
 * A hit where the music drops by 6 dB or more is on the music too: the drop is the accent.
 */
export function syncReport(scenes, { env, rms, block, hop, offset }, { before = .065, after = .03, weak = .6 } = {}) {
  const at = t => Math.round((t - offset) / hop);
  const rows = [];
  for (const s of scenes) {
    (s.hitTimes || s.hits || []).forEach((t, i) => {
      const a = Math.max(0, at(t - before)), b = Math.min(env.length - 1, at(t + after));
      let best = -1, bi = a;
      for (let k = a; k <= b; k++) if (env[k] > best) { best = env[k]; bi = k; }
      const la = Math.max(0, at(t - 1)), lb = Math.min(env.length, at(t + 1));
      const local = pct(env.subarray(la, lb), .99) || 1;
      const strength = best < 0 ? 0 : best / local;
      const lvl = (p, q) => { const x = rms.subarray(Math.max(0, Math.ceil(p / block)), Math.max(0, Math.floor(q / block))); let s = 0; for (const v of x) s += v; return x.length ? 10 * Math.log10(s / x.length + 1e-12) : -120; };
      const drop = lvl(t, t + .07) - lvl(t - .08, t - .01) <= -6;
      const off = best < 0 ? null : (bi * hop + offset) - t;
      rows.push({ scene: s.id, hit: i, t, offset: off, strength: +strength.toFixed(2), quiet: drop, ok: drop || strength >= weak });
    });
  }
  return rows;
}
