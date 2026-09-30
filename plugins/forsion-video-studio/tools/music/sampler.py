"""Sample-based orchestra from VSCO 2 Community Edition (CC0): https://github.com/sgossner/VSCO-2-CE

SampleTrack mirrors engine.Track (note / chord / cc / ramp / render), so pieces can swap
General MIDI instruments for recorded ones. Pitched samples are picked by nearest pitch,
velocity layer and round robin, then resampled to the target pitch. Unpitched percussion is
picked by dynamic marking. CC 11 events become a gain envelope (expression swells).

Each sample starts early by its own attack time (to reach 35% of its peak), so a brass stab lands its
body on the beat as a drum does, instead of swelling in 50 ms late.
"""
import os
import re
import glob
import pickle
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from engine import SR, n

VSCO = os.environ.get('VSCO', os.path.expanduser('~/vsco'))
CACHE = os.environ.get('FVS_CACHE', os.path.expanduser('~/.cache/fvs/vsco'))
_NOTE = re.compile(r'(?:^|_)([A-G]#?)(-?\d)(?=_)')
_PC = dict(C=0, D=2, E=4, F=5, G=7, A=9, B=11)
DYN = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff']


def _load(path):
    x, sr = sf.read(path, dtype='float32', always_2d=True)
    if x.shape[1] == 1:
        x = np.repeat(x, 2, 1)
    x = x[:, :2]
    if sr != SR:
        x = resample_poly(x, SR, sr, axis=0).astype(np.float32)
    # trim leading silence so notes land on the beat
    a = np.abs(x).max(1)
    i = int(np.argmax(a > a.max() * 0.03))
    return x[max(0, i - int(0.003 * SR)):]


def _midi(fn):
    m = _NOTE.search(os.path.basename(fn))
    pc = _PC[m.group(1)[0]] + (1 if '#' in m.group(1) else 0)
    return 12 * (int(m.group(2)) + 2) + pc  # VSCO names middle C as C3


def _num(pattern, fn, default=1):
    m = re.search(pattern, os.path.basename(fn), re.I)
    return int(m.group(1)) if m else default


def _attack(x, level=0.35, cap=0.09):
    """Seconds from the sample's start until its 5 ms envelope reaches `level` of the peak in its first 0.4 s."""
    a = np.abs(x[: int(0.4 * SR)]).max(1)
    w = int(0.005 * SR)
    env = np.convolve(a, np.ones(w) / w, mode='same')
    return min(cap, int(np.argmax(env >= level * env.max())) / SR)


class Bank:
    """Samples of one instrument articulation: list of (midi, layer, rr, audio)."""

    def __init__(self, key, samples, release):
        self.key, self.samples, self.release = key, samples, release
        self.attack = {id(s[3]): _attack(s[3]) for s in samples}
        self.layers = sorted({s[1] for s in samples})
        self.rr = {}
        loud = [np.sqrt((s[3][: SR // 2] ** 2).mean()) for s in samples if s[1] == self.layers[-1]]
        self.norm = 0.12 / (np.median(loud) + 1e-9)


_banks = {}


def pitched(key, folder, release=0.25, pattern='*.wav'):
    if key in _banks:
        return _banks[key]
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, key + '.pkl')
    if os.path.exists(cache):
        with open(cache, 'rb') as f:
            samples = pickle.load(f)
    else:
        samples = []
        for fn in sorted(glob.glob(os.path.join(VSCO, folder, pattern))):
            samples.append((_midi(fn), _num(r'_v(\d)', fn), _num(r'_rr(\d)', fn), _load(fn)))
        with open(cache, 'wb') as f:
            pickle.dump(samples, f)
    _banks[key] = Bank(key, samples, release)
    return _banks[key]


def unpitched(key, files, release=0.1):
    """files: {dynamic_index: [paths]} — dynamic index acts as the velocity layer."""
    if key in _banks:
        return _banks[key]
    samples = []
    for layer, paths in files.items():
        for i, p in enumerate(paths):
            samples.append((60, layer, i + 1, _load(os.path.join(VSCO, p))))
    _banks[key] = Bank(key, samples, release)
    return _banks[key]


def _render_note(bank, midi, vel, dur, pitched_=True):
    if pitched_:
        near = min(abs(s[0] - midi) for s in bank.samples)
        cand = [s for s in bank.samples if abs(s[0] - midi) == near]
    else:
        cand = bank.samples
    layers = sorted({s[1] for s in cand})
    li = layers[min(len(layers) - 1, int(vel / 128 * len(layers)))]
    cand = [s for s in cand if s[1] == li]
    k = (cand[0][0], li)
    i = bank.rr.get(k, 0)
    bank.rr[k] = i + 1
    s = cand[i % len(cand)]
    x = s[3]
    lead = bank.attack[id(x)]
    if pitched_ and s[0] != midi:
        ratio = 2 ** ((midi - s[0]) / 12)
        lead /= ratio
        idx = np.arange(0, len(x) - 1, ratio)
        i0 = idx.astype(int)
        fr = (idx - i0)[:, None].astype(np.float32)
        x = x[i0] * (1 - fr) + x[i0 + 1] * fr
    # velocity inside a layer still shapes loudness
    g = bank.norm * (0.35 + 0.65 * (vel / 127) ** 1.5)
    if dur is not None:
        L = min(len(x), int((dur + bank.release) * SR))
        x = x[:L].copy()
        r = min(L, int(bank.release * SR))
        cut = max(0, L - r)
        x[cut:] *= np.linspace(1, 0, L - cut, dtype=np.float32)[:, None] ** 2
    return x * g, lead


class SampleTrack:
    """Drop-in for engine.Track, backed by one or more VSCO banks (e.g. sustain + staccato)."""

    def __init__(self, name, bank, gain=1.0, pan=0.0, fx=None, send=0.25, short=None, short_below=0.3, pitched_=True, natural=False):
        self.name, self.bank, self.short, self.short_below = name, bank, short, short_below
        self.gain, self.pan, self.fx, self.send = gain, pan, fx or [], send
        self.pitched, self.natural = pitched_, natural
        self.notes, self.ccs = [], []

    def note(self, t, dur, key, vel=100):
        self.notes.append((t, dur, n(key) if self.pitched else 60, int(max(1, min(127, vel)))))
        return self

    def chord(self, t, dur, keys, vel=100):
        for k in (keys.split() if isinstance(keys, str) else keys):
            self.note(t, dur, k, vel)
        return self

    def cc(self, t, num, val):
        if num == 11:
            self.ccs.append((t, val / 127))
        return self

    def ramp(self, t0, t1, num, v0, v1, steps=24):
        for i in range(steps + 1):
            self.cc(t0 + (t1 - t0) * i / steps, num, v0 + (v1 - v0) * i / steps)
        return self

    def render(self, length):
        total = int(length * SR)
        out = np.zeros((total, 2), np.float32)
        for t, dur, midi, vel in sorted(self.notes):
            bank = self.short if (self.short is not None and dur <= self.short_below) else self.bank
            x, lead = _render_note(bank, midi, vel, None if (self.natural or bank is self.short) else dur, self.pitched)
            i = int((t - lead) * SR)
            if i >= total:
                continue
            if i < 0:
                x, i = x[-i:], 0
            j = min(total, i + len(x))
            out[i:j] += x[: j - i]
        if self.ccs:
            # like a MIDI channel: full expression until the first CC, then each value holds until the next
            ts, vs = zip(*sorted(self.ccs))
            idx = np.searchsorted(np.array(ts), np.arange(total) / SR, side='right') - 1
            out *= np.where(idx >= 0, np.array(vs, np.float32)[np.maximum(idx, 0)], 1.0).astype(np.float32)[:, None]
        return out


# ───────── the orchestra ─────────
def orchestra():
    P = 'VSCO 1 Percussion'
    snare = sorted(glob.glob(os.path.join(VSCO, P, 'drums/snare/drum1/snare1_*.wav')))
    rel = lambda p: os.path.relpath(p, VSCO)
    by = lambda files, tag: [rel(f) for f in files if re.search(rf'_{tag}(_|\.|\d)', os.path.basename(f))]
    snare_layers = {i: by(snare, d) for i, d in enumerate(['mp', 'f', 'ff', 'fff']) if by(snare, d)}
    bd = [f for f in sorted(glob.glob(os.path.join(VSCO, P, 'drums/bass/bdrum_*.wav'))) if not re.search('muted|roll|special', f)]
    bd_layers = {i: by(bd, d) for i, d in enumerate(['mp', 'f', 'ff', 'fff']) if by(bd, d)}
    cym = sorted(glob.glob(os.path.join(VSCO, P, 'varMetal/Cymbals/clash/crash_hit_*.wav')))
    cym_layers = {0: [rel(f) for f in cym if '_ff_' in f], 1: [rel(f) for f in cym if '_fff' in f]}
    gong = [rel(f) for f in sorted(glob.glob(os.path.join(VSCO, P, 'varMetal/Gong/gong_hit_ff*.wav')))]
    o = dict(
        tpt_sus=pitched('tpt-sus', 'Brass/Trumpet/sus', 0.2), tpt_stac=pitched('tpt-stac', 'Brass/Trumpet/stac', 0.1),
        hn_sus=pitched('hn-sus', 'Brass/F Horn/sus', 0.25), hn_stac=pitched('hn-stac', 'Brass/F Horn/stac', 0.1),
        tbn_sus=pitched('tbn-sus', 'Brass/Tenor Trombone/sus', 0.2), tbn_stac=pitched('tbn-stac', 'Brass/Tenor Trombone/stac', 0.1),
        tuba_sus=pitched('tuba-sus', 'Brass/Tuba/sus', 0.2), tuba_stac=pitched('tuba-stac', 'Brass/Tuba/stac', 0.1),
        vln_spic=pitched('vln-spic', 'Strings/Violin Section/Spic', 0.08), vln_sus=pitched('vln-sus', 'Strings/Violin Section/susVib', 0.3),
        vln_trem=pitched('vln-trem', 'Strings/Violin Section/Trem', 0.3),
        vla_spic=pitched('vla-spic', 'Strings/Viola Section/spic', 0.08), vla_sus=pitched('vla-sus', 'Strings/Viola Section/susvib', 0.3),
        vc_spic=pitched('vc-spic', 'Strings/Cello Section/spic', 0.08), vc_sus=pitched('vc-sus', 'Strings/Cello Section/susvib', 0.3),
        cb_spic=pitched('cb-spic', 'Strings/Solo Contrabass/Spic', 0.08), cb_sus=pitched('cb-sus', 'Strings/Solo Contrabass/SusVib', 0.3),
        snare=unpitched('snare', snare_layers), bd=unpitched('bd', bd_layers, 0.3),
        cym=unpitched('cym', cym_layers, 1.0), gong=unpitched('gong', {0: gong}, 2.0),
        cymroll=unpitched('cymroll', {0: [f'{P}/varMetal/Cymbals/susp/susp_hit_softmall_roll2_cresc.wav']}, 0.5),
        timp=timpani(),
    )
    for k in ('cymroll', 'gong'):  # swells: normalise by peak, not by the (quiet) first half-second
        b = o[k]
        b.norm = 0.35 / max(np.abs(x[3]).max() for x in b.samples)
    return o


def _timp_pitch(x):
    """Strongest spectral peak of the hit's body in the timpani range."""
    seg = x[int(0.05 * SR): int(0.6 * SR)].mean(1)
    sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    f = np.fft.rfftfreq(len(seg), 1 / SR)
    m = (f > 70) & (f < 260)
    return 69 + 12 * np.log2(f[m][np.argmax(sp[m])] / 440)


def timpani():
    if 'timp' in _banks:
        return _banks['timp']
    samples = []
    for d in range(1, 6):
        files = sorted(glob.glob(os.path.join(VSCO, 'Percussion/Timpani', f'Timpani{d}_Hit_*.wav')))
        if not files:
            continue
        loaded = [(_num(r'_v(\d)', fn), _num(r'_rr(\d)', fn), _load(fn)) for fn in files]
        loud = max(loaded, key=lambda s: s[0])
        midi = int(round(_timp_pitch(loud[2])))
        samples += [(midi, v, rr, x) for v, rr, x in loaded]
    _banks['timp'] = Bank('timp', samples, 0.4)
    return _banks['timp']
