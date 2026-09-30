"""Tiny offline score renderer: timed note events → stems → mixed stereo WAV (48 kHz).

Track renders General MIDI through a SoundFont (optional: pip install tinysoundfont, SF2=/path/to/font.sf2);
sampler.SampleTrack is the same interface on recorded orchestra samples. Audio places pre-rendered clips.
mix() renders every layer, applies gates and a dynamic curve, shares one reverb bus and masters the result.
Sound design (booms, beeps, alarms, risers) is synthesized with numpy.
"""
import os
import numpy as np
from pedalboard import Pedalboard, Reverb, Compressor, Limiter, HighpassFilter, LowpassFilter, PeakFilter

SR = 48000
SF2 = os.environ.get('SF2', os.path.expanduser('~/sf/GeneralUser-GS.sf2'))
NAMES = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def n(name):
    """'C#4' → 61 (C4 = 60). Also accepts ints."""
    if isinstance(name, int):
        return name
    pc = NAMES[name[0]]
    i = 1
    while i < len(name) and name[i] in '#b':
        pc += 1 if name[i] == '#' else -1
        i += 1
    return 12 * (int(name[i:]) + 1) + pc


def ns(names):
    return [n(x) for x in names.split()] if isinstance(names, str) else [n(x) for x in names]


class Track:
    def __init__(self, name, preset, bank=0, drums=False, gain=1.0, pan=0.0, fx=None, send=0.25):
        self.name, self.preset, self.bank, self.drums = name, preset, bank, drums
        self.gain, self.pan, self.fx, self.send = gain, pan, fx or [], send
        self.ev = []  # (t, order, kind, a, b)

    def note(self, t, dur, key, vel=100):
        k = n(key)
        self.ev.append((t, 1, 'on', k, int(max(1, min(127, vel)))))
        self.ev.append((t + dur, 0, 'off', k, 0))
        return self

    def chord(self, t, dur, keys, vel=100):
        for k in (ns(keys) if isinstance(keys, str) else keys):
            self.note(t, dur, k, vel)
        return self

    def cc(self, t, num, val):
        self.ev.append((t, 0, 'cc', num, int(max(0, min(127, val)))))
        return self

    def ramp(self, t0, t1, num, v0, v1, steps=24):
        for i in range(steps + 1):
            self.cc(t0 + (t1 - t0) * i / steps, num, v0 + (v1 - v0) * i / steps)
        return self

    def render(self, length):
        total = int(length * SR)
        out = np.zeros((total, 2), np.float32)
        if not self.ev:
            return out
        import tinysoundfont  # optional: only General MIDI tracks need it
        s = tinysoundfont.Synth(samplerate=SR)
        sfid = s.sfload(SF2)
        s.program_select(0, sfid, self.bank, self.preset, is_drums=self.drums)
        pos = 0
        for t, _, kind, a, b in sorted(self.ev, key=lambda e: (e[0], e[1])):
            idx = min(total, max(0, int(round(t * SR))))
            if idx > pos:
                out[pos:idx] = np.frombuffer(s.generate(idx - pos), np.float32).reshape(-1, 2)
                pos = idx
            if kind == 'on':
                s.noteon(0, a, b)
            elif kind == 'off':
                s.noteoff(0, a)
            else:
                s.control_change(0, a, b)
        if pos < total:
            out[pos:] = np.frombuffer(s.generate(total - pos), np.float32).reshape(-1, 2)
        return out


class Audio:
    """A pre-rendered stereo layer (sound design) placed on the timeline."""

    def __init__(self, name, gain=1.0, pan=0.0, fx=None, send=0.2):
        self.name, self.gain, self.pan, self.fx, self.send = name, gain, pan, fx or [], send
        self.clips = []

    def add(self, t, sig, gain=1.0):
        self.clips.append((t, sig, gain))
        return self

    def render(self, length):
        total = int(length * SR)
        out = np.zeros((total, 2), np.float32)
        for t, sig, g in self.clips:
            if sig.ndim == 1:
                sig = np.stack([sig, sig], 1)
            i = int(t * SR)
            if i >= total:
                continue
            j = min(total, i + len(sig))
            out[i:j] += sig[: j - i] * g
        return out


def _pan(x, p):
    l, r = np.cos((p + 1) * np.pi / 4), np.sin((p + 1) * np.pi / 4)
    return x * np.array([l, r], np.float32) * np.sqrt(2)


def gate_env(total, gates, name=None, ramp=0.012):
    """Gain envelope from (t0, t1, db, keep_names) windows: EVA-style hard cuts to near silence."""
    env = np.ones(total, np.float32)
    r = int(ramp * SR)
    for t0, t1, db, keep in gates:
        if name is not None and name in keep:
            continue
        a, b = int(t0 * SR), min(total, int(t1 * SR))
        g = 10 ** (db / 20)
        seg = np.full(b - a, g, np.float32)
        k = min(r, len(seg) // 2)
        seg[:k] = np.linspace(1, g, k)
        seg[len(seg) - k:] = np.linspace(g, 1, k)
        env[a:b] = np.minimum(env[a:b], seg)
    return env[:, None]


def mix(layers, length, reverb=None, master=None, target_peak_db=-1.0, fade_out=0.0, gates=(), master_gates=(), curve=()):
    """Render layers, apply per-layer fx and gates, share one reverb bus, then master chain and peak-normalize."""
    total = int(length * SR)
    dry = np.zeros((total, 2), np.float32)
    bus = np.zeros((total, 2), np.float32)
    for L in layers:
        x = L.render(length) * L.gain
        if L.fx:
            x = Pedalboard(L.fx)(x.T.copy(), SR).T
        x = _pan(x, L.pan)
        if gates:
            x = x * gate_env(total, gates, L.name)
        if os.environ.get('REPORT'):
            w = os.environ.get('REPORT_WIN')  # e.g. "69.2,72" to measure one passage
            seg = x[int(float(w.split(',')[0]) * SR):int(float(w.split(',')[1]) * SR)] if w else x
            rms = np.sqrt((seg ** 2).mean()) + 1e-12
            print(f'    {L.name:14s} rms {20 * np.log10(rms):6.1f} dB  peak {20 * np.log10(np.abs(x).max() + 1e-12):6.1f} dB')
        dry += x
        bus += x * L.send
    rv = reverb or Reverb(room_size=0.82, damping=0.35, wet_level=1.0, dry_level=0.0, width=1.0)
    wet = Pedalboard([HighpassFilter(180), rv])(bus.T.copy(), SR).T
    out = dry + wet
    if master_gates:
        out = out * gate_env(total, master_gates)
    if curve:  # dynamic arc: [(t, db), ...] interpolated before the master chain
        ts, dbs = zip(*curve)
        out = out * (10 ** (np.interp(np.arange(total) / SR, ts, dbs) / 20))[:, None].astype(np.float32)
    chain = master or [Compressor(threshold_db=-18, ratio=1.8, attack_ms=15, release_ms=200), Limiter(threshold_db=-1.5, release_ms=150)]
    out = Pedalboard(chain)(out.T.copy(), SR).T
    if fade_out:
        k = int(fade_out * SR)
        out[-k:] *= np.linspace(1, 0, k)[:, None] ** 2
    peak = np.abs(out).max() + 1e-9
    return (out * (10 ** (target_peak_db / 20) / peak)).astype(np.float32)


# ───────── sound design ─────────
_rng = np.random.default_rng(2012)


def env_exp(nsamp, decay):
    return np.exp(-np.arange(nsamp) / (decay * SR)).astype(np.float32)


def boom(dur=2.5, f0=90.0, f1=28.0, sweep=0.35, decay=0.7, drive=1.6):
    """Cinematic sub hit: pitch-dropping sine, soft-clipped."""
    t = np.arange(int(dur * SR)) / SR
    f = f1 + (f0 - f1) * np.exp(-t / sweep)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) * np.exp(-t / decay)
    x[: int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))
    return np.tanh(x * drive).astype(np.float32) / np.tanh(drive)


def noise(dur, lp=None, hp=None, decay=None):
    x = _rng.standard_normal(int(dur * SR)).astype(np.float32)
    fx = []
    if hp:
        fx.append(HighpassFilter(hp))
    if lp:
        fx.append(LowpassFilter(lp))
    if fx:
        x = Pedalboard(fx)(x[None], SR)[0]
    if decay:
        x *= env_exp(len(x), decay)
    return x / (np.abs(x).max() + 1e-9)


def impact(dur=3.0, weight=1.0):
    """Boom + noise crack, for hard cuts."""
    b = boom(dur, 110, 30, 0.25, 0.9) * weight
    c = noise(dur, lp=5000, hp=300, decay=0.08) * 0.5
    return (b + c) / 1.3


def click(dur=0.05, lp=9000):
    return noise(dur, lp=lp, hp=1500, decay=0.006)


def glitch(dur=0.18, seed=0):
    r = np.random.default_rng(seed)
    x = np.zeros(int(dur * SR), np.float32)
    for _ in range(6):
        a = r.integers(0, len(x) - 400)
        ln = r.integers(120, 900)
        f = r.choice([800, 1600, 2400, 4000, 6000])
        seg = np.sign(np.sin(2 * np.pi * f * np.arange(ln) / SR)) * r.uniform(.3, 1)
        x[a:a + ln] += seg[: len(x) - a].astype(np.float32)
    return np.clip(x, -1, 1) * 0.6


def beep(freq=1000, dur=0.12, shape='sine', attack=0.003, release=0.02):
    t = np.arange(int(dur * SR)) / SR
    w = np.sin(2 * np.pi * freq * t) if shape == 'sine' else np.sign(np.sin(2 * np.pi * freq * t)) * 0.5
    e = np.ones_like(t)
    a, r = int(attack * SR), int(release * SR)
    e[:a] = np.linspace(0, 1, a)
    e[-r:] = np.linspace(1, 0, r)
    return (w * e).astype(np.float32)


def alarm(dur=1.0, f1=880, f2=660, rate=4.0):
    """Two-tone warning siren (square, band-limited)."""
    t = np.arange(int(dur * SR)) / SR
    f = np.where(np.floor(t * rate) % 2 == 0, f1, f2)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sign(np.sin(ph)) * 0.5 + np.sin(ph * 2) * 0.2
    x = Pedalboard([LowpassFilter(3200), HighpassFilter(300)])(x[None].astype(np.float32), SR)[0]
    fade = int(0.01 * SR)
    x[:fade] *= np.linspace(0, 1, fade)
    x[-fade:] *= np.linspace(1, 0, fade)
    return x


def riser(dur=2.0, f0=200, f1=4000, tone=True):
    t = np.arange(int(dur * SR)) / SR
    k = t / dur
    nz = noise(dur, hp=400) * (k ** 2.2)
    # sweep a resonant peak by chunks
    out = np.zeros_like(nz)
    chunks = 40
    for i in range(chunks):
        a, b = i * len(nz) // chunks, (i + 1) * len(nz) // chunks
        fc = f0 * (f1 / f0) ** (i / chunks)
        out[a:b] = Pedalboard([PeakFilter(fc, 14, 1.2), LowpassFilter(fc * 2)])(nz[None, a:b], SR)[0]
    x = out / (np.abs(out).max() + 1e-9)
    if tone:
        f = f0 * 0.5 * (f1 / f0 / 4) ** k
        x = x * 0.7 + np.sin(2 * np.pi * np.cumsum(f) / SR) * (k ** 2) * 0.4
    return x.astype(np.float32)


def drone(dur, freq=36.7, detune=0.4, lp=400):
    t = np.arange(int(dur * SR)) / SR
    x = sum(np.sin(2 * np.pi * freq * m * (1 + detune * 0.001 * i) * t + i) / m for i, m in enumerate([1, 2, 3, 4]))
    x += noise(dur, lp=lp) * 0.15
    x = Pedalboard([LowpassFilter(lp)])(x[None].astype(np.float32), SR)[0]
    fade = int(0.5 * SR)
    x[:fade] *= np.linspace(0, 1, fade)
    x[-fade:] *= np.linspace(1, 0, fade)
    return x / (np.abs(x).max() + 1e-9)


def heartbeat():
    a = boom(0.35, 70, 40, 0.05, 0.08, 2.5)
    b = boom(0.45, 60, 36, 0.05, 0.1, 2.5) * 0.7
    out = np.zeros(int(0.8 * SR), np.float32)
    out[: len(a)] += a
    k = int(0.22 * SR)
    out[k:k + len(b)] += b
    return out


def tone(freq, dur, fade=0.02):
    t = np.arange(int(dur * SR)) / SR
    x = np.sin(2 * np.pi * freq * t)
    f = int(fade * SR)
    x[:f] *= np.linspace(0, 1, f)
    x[-f:] *= np.linspace(1, 0, f)
    return x.astype(np.float32)


def reverse(x):
    return x[::-1].copy()


def fade_in(x, dur):
    k = int(dur * SR)
    x = x.copy()
    x[:k] *= np.linspace(0, 1, k) ** 2
    return x
