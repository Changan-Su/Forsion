"""决战 II — a battle march in the manner of an anime-orchestral 'decisive battle' cue, on recorded samples.

Style targets measured from the user's reference (not its notes): ~150 BPM in 4/4, E minor with
dorian/phrygian colour, straight-eighth snare accented on beat 2 and the 'and' of 4, low end hitting
1 · 2 · 2& · 3& · 4&, and a dark, low-heavy balance (most energy at 80–250 Hz).
All melodies and harmony here are original.
"""
import numpy as np
from pedalboard import Reverb, LowShelfFilter, HighShelfFilter, PeakFilter, Compressor, Limiter
from engine import Audio, mix, n, ns, SR, boom, impact, noise, reverse
from sampler import SampleTrack, orchestra
from cuts import CARDS, QUESTION, HUD, MAGI, EPISODE, TITLE, CUE_LEN

BPM = 150
BEAT = 60 / BPM
LOW_HITS = [0, 1, 1.5, 2.5, 3.5]           # beats where bass drum / timpani / low brass land
SNARE = [(0, .8), (.5, .45), (1, 1.0), (1.5, .45), (2, .7), (2.5, .45), (3, .55), (3.25, .5), (3.5, .95)]

# Theme A (horns + trombones, later tutti): i – VI – IV(dorian) – i | i – ♭II – V – i
THEME_A = [
    ('Em', [(0, 1.5, 'E4'), (1.5, .5, 'F#4'), (2, 1, 'G4'), (3, 1, 'B4')]),
    ('C', [(0, 1.5, 'C5'), (1.5, .5, 'B4'), (2, 1, 'G4'), (3, 1, 'E4')]),
    ('A', [(0, 1.5, 'C#5'), (1.5, .5, 'D5'), (2, 1, 'E5'), (3, 1, 'A4')]),
    ('Em', [(0, 2.5, 'B4'), (3, 1 / 3, 'G4'), (3 + 1 / 3, 1 / 3, 'A4'), (3 + 2 / 3, 1 / 3, 'B4')]),
    ('Em', [(0, 1.5, 'E5'), (1.5, .5, 'D5'), (2, 1, 'B4'), (3, 1, 'G4')]),
    ('F', [(0, 1.5, 'A4'), (1.5, .5, 'C5'), (2, 1, 'F5'), (3, 1, 'E5')]),
    ('B', [(0, 1.5, 'D#5'), (1.5, .5, 'C#5'), (2, 1, 'B4'), (3, 1, 'F#4')]),
    ('Em', [(0, 3, 'E4')]),
]
# Theme B (trumpets, fanfare with triplet turns): III – ♭VII – VI – V
THEME_B = [
    ('G', [(0, .5, 'D5'), (.5, .25, 'D5'), (.75, .25, 'D5'), (1, 1, 'G5'), (2, 1 / 3, 'F#5'), (2 + 1 / 3, 1 / 3, 'G5'), (2 + 2 / 3, 1 / 3, 'A5'), (3, 1, 'B5')]),
    ('D', [(0, 1.5, 'A5'), (1.5, .5, 'F#5'), (2, 1, 'D5'), (3, 1, 'A4')]),
    ('C', [(0, .5, 'G5'), (.5, .25, 'G5'), (.75, .25, 'G5'), (1, 1, 'C6'), (2, 1 / 3, 'B5'), (2 + 1 / 3, 1 / 3, 'A5'), (2 + 2 / 3, 1 / 3, 'G5'), (3, 1, 'E5')]),
    ('B', [(0, 2, 'F#5'), (2, 1, 'D#5'), (3, 1, 'B4')]),
]
CHORDS = {  # root (bass octave), triad pitch classes as intervals, brass voicing
    'Em': ('E1', [0, 3, 7], 'E3 G3 B3 E4'), 'C': ('C2', [0, 4, 7], 'E3 G3 C4 E4'), 'A': ('A1', [0, 4, 7], 'E3 A3 C#4 E4'),
    'F': ('F1', [0, 4, 7], 'F3 A3 C4 F4'), 'B': ('B1', [0, 4, 7], 'D#3 F#3 B3 D#4'), 'G': ('G1', [0, 4, 7], 'D3 G3 B3 D4'),
    'D': ('D2', [0, 4, 7], 'D3 F#3 A3 D4'), 'E': ('E1', [0, 4, 7], 'E3 G#3 B3 E4'),
}


def band():
    o = orchestra()
    T = lambda name, sus, short=None, **k: SampleTrack(name, o[sus], short=o[short] if short else None, **k)
    P = lambda name, bank, **k: SampleTrack(name, o[bank], pitched_=False, natural=True, **k)
    return dict(
        tpt=T('trumpets', 'tpt_sus', 'tpt_stac', gain=0.9, pan=0.25, send=0.26),
        hn=T('horns', 'hn_sus', 'hn_stac', gain=1.1, pan=-0.3, send=0.32),
        tbn=T('trombones', 'tbn_sus', 'tbn_stac', gain=0.8, pan=0.12, send=0.26),
        tuba=T('tuba', 'tuba_sus', 'tuba_stac', gain=0.9, pan=0.05, send=0.2),
        vln=T('violins', 'vln_sus', 'vln_spic', gain=0.5, pan=-0.45, send=0.24),
        trem=T('violins-trem', 'vln_trem', gain=0.7, pan=-0.35, send=0.3),
        vla=T('violas', 'vla_sus', 'vla_spic', gain=0.7, pan=0.3, send=0.22),
        vc=T('celli', 'vc_sus', 'vc_spic', gain=1.0, pan=0.2, send=0.18),
        cb=T('basses', 'cb_sus', 'cb_spic', gain=1.0, pan=0.35, send=0.16),
        timp=SampleTrack('timpani', o['timp'], natural=True, gain=1.1, send=0.22),
        snare=P('snare', 'snare', gain=0.55, pan=-0.05, send=0.16),
        bd=P('bass-drum', 'bd', gain=1.0, send=0.2),
        cym=P('cymbals', 'cym', gain=1.3, pan=0.15, send=0.22),
        cymroll=P('cym-roll', 'cymroll', gain=0.6, send=0.25),
        gong=P('gong', 'gong', gain=0.9, send=0.3),
        sfx=Audio('sfx', gain=0.6, send=0.1),
    )


def _tones(chord, octave_base):
    root, iv, _ = CHORDS[chord]
    r = n(root) + octave_base
    return r, [r + i for i in iv]


def groove(b, t0, chord, vel=100, strings=True, drums=True, low_brass=True):
    """One bar of the battle groove starting at t0."""
    root, iv, _ = CHORDS[chord]
    r = n(root)
    minor = iv[1] == 3
    if strings:
        pat = [0, 0, 12, 0, 3 if minor else 4, 0, 7, 12]
        for i, o in enumerate(pat):
            t = t0 + i * BEAT / 2
            b['vc'].note(t, 0.12, r + 12 + o, vel - (0 if i in (0, 3, 5, 7) else 18))
        for p in LOW_HITS:
            b['cb'].note(t0 + p * BEAT, 0.12, r, vel)
        fifth, top = r + 43, r + 48  # violins: repeated sixteenths on the fifth and the octave
        for i in range(16):
            b['vln'].note(t0 + i * BEAT / 4, 0.08, top if i % 4 == 2 else fifth, vel - (8 if i % 4 else 0))
        third = r + 24 + (3 if minor else 4)
        for i in range(4):
            b['vla'].note(t0 + (i + .5) * BEAT, 0.1, third, vel - 10)
    if drums:
        for p, a in SNARE:
            b['snare'].note(t0 + p * BEAT, 0.1, 60, int(vel * a + 10))
        for p in LOW_HITS:
            b['bd'].note(t0 + p * BEAT, 0.2, 60, vel + (10 if p == 0 else 0))
            b['timp'].note(t0 + p * BEAT, 0.3, r + 24 if p != 1.5 else r + 19, vel)
    if low_brass:
        for p in (0, 1.5, 2.5, 3.5):
            b['tbn'].chord(t0 + p * BEAT, 0.15, [r + 24, r + 31], vel - 5)
            b['tuba'].note(t0 + p * BEAT, 0.15, r + 12, vel)


def melody(b, t0, notes, tracks, vel=110, shift=0):
    for p, d, k in notes:
        for tr, sh in tracks:
            b[tr].note(t0 + p * BEAT, d * BEAT * 0.96, n(k) + sh + shift, vel)


def hit(b, t, chord, vel=120, dur=0.25, cym=False, gong=False):
    root, iv, voic = CHORDS[chord]
    r = n(root)
    b['tpt'].chord(t, dur, [k + 12 for k in ns(voic)[1:]], vel)
    b['hn'].chord(t, dur, voic, vel)
    b['tbn'].chord(t, dur, [r + 24, r + 31, r + 36], vel)
    b['tuba'].note(t, dur, r + 12, vel)
    b['vc'].chord(t, dur, [r + 12, r + 24], vel)
    b['cb'].note(t, dur, r, vel)
    b['vln'].chord(t, dur, [k + 12 for k in ns(voic)[1:]], vel)
    b['timp'].note(t, 0.5, r + 24, vel)
    b['bd'].note(t, 0.5, 60, vel)
    if cym:
        b['cym'].note(t, 2, 60, 127)
    if gong:
        b['gong'].note(t, 4, 60, 120)


def roll(b, t0, t1, v0=40, v1=120, timp=None):
    k = int((t1 - t0) / 0.05)
    for i in range(k):
        v = v0 + (v1 - v0) * i / max(1, k - 1)
        b['snare'].note(t0 + i * 0.05, 0.05, 60, int(v))
        if timp and i % 2 == 0:
            b['timp'].note(t0 + i * 0.05, 0.1, timp, int(v))


def final(b, t, chord='E', hold=3.6):
    root, iv, voic = CHORDS[chord]
    r = n(root)
    b['tpt'].chord(t, hold, [r + 36, r + 40, r + 43, r + 48], 122)
    b['hn'].chord(t, hold, voic, 120)
    b['tbn'].chord(t, hold, [r + 24, r + 31, r + 36, r + 40], 122)
    b['tuba'].chord(t, hold, [r + 12, r + 24], 122)
    b['vln'].chord(t, hold, [r + 40, r + 43, r + 48], 118)
    b['vla'].chord(t, hold, [r + 31, r + 36], 116)
    b['vc'].chord(t, hold, [r + 12, r + 24], 118)
    b['cb'].note(t, hold, r, 118)
    b['bd'].note(t, 1, 60, 127)
    b['cym'].note(t, 3, 60, 127)
    b['gong'].note(t, 4, 60, 124)
    for i in range(int(hold / 0.06)):  # timpani roll, decaying
        b['timp'].note(t + i * 0.06, 0.1, r + 24, int(max(30, 124 - i * 2.2)))


MIXFX = dict(reverb=Reverb(room_size=0.8, damping=0.45, wet_level=1.0, dry_level=0.0, width=1.0))


def _master():
    # dark, low-heavy balance like the reference: warm low shelf, tamed top
    return [LowShelfFilter(160, 2.5), PeakFilter(140, 1.5, 0.9), PeakFilter(480, -1.5, 0.8), PeakFilter(3200, -1.0, 0.8), HighShelfFilter(9000, -2.0),
            Compressor(threshold_db=-18, ratio=2.0, attack_ms=20, release_ms=220), Limiter(threshold_db=-1.5, release_ms=150)]


def battle_cue():
    b = band()
    for i, (t, c) in enumerate(zip(CARDS, ['Em', 'C', 'A', 'B'])):
        hit(b, t, c, vel=112 + i * 4, dur=0.28, cym=(i == 0))
    # 人类？: F major struck over the E bass (a ♭9 clash), then a roll into the HUD
    hit(b, QUESTION, 'F', vel=124, dur=0.3, cym=True, gong=True)
    b['cb'].note(QUESTION, 0.3, 'E1', 124)
    roll(b, QUESTION + 0.1, HUD - 0.02, 50, 122, timp='E3')
    b['cymroll'].note(QUESTION + 0.05, 1, 60, 110)
    # HUD: one bar of the groove with the theme's first bar in horns + trombones
    groove(b, HUD, 'Em', vel=108)
    b['cym'].note(HUD, 2, 60, 120)
    melody(b, HUD, THEME_A[0][1], [('hn', 0), ('tbn', -12)], vel=116)
    for t in MAGI:  # three panels flip: trumpet triple-tongue
        b['tpt'].chord(t, 0.08, 'B4 E5', 118)
    # EPISODE card: drop to a tremolo and the suspended-cymbal swell
    b['trem'].chord(EPISODE, TITLE - EPISODE, 'E5 B5', 100).ramp(EPISODE, TITLE, 11, 40, 127)
    b['cymroll'].note(EPISODE - 0.3, 1, 60, 120)
    final(b, TITLE, 'E', hold=2.6)
    b['sfx'].add(TITLE, boom(3.0, 90, 30, 0.4, 1.0, 1.8), 0.5)
    gates = [(EPISODE, TITLE, -60, {'violins-trem', 'cym-roll'})]
    return mix(list(b.values()), CUE_LEN, master=_master(), fade_out=0.9, gates=gates,
               master_gates=[(EPISODE + 0.01, TITLE - 0.2, -10, ())], **MIXFX)


def battle_full():
    b = band()
    t0 = 0.25
    at = lambda bar, beat=0.0: t0 + (bar * 4 + beat) * BEAT
    # bars 0–1: rolls and a low brass pedal swelling out of nothing
    roll(b, at(0), at(2) - 0.02, 20, 124, timp='E3')
    b['cymroll'].note(at(0, 1.5), 1, 60, 120)
    b['tbn'].chord(at(0), 8 * BEAT, 'E2 B2', 110).ramp(at(0), at(2), 11, 15, 127)
    b['tuba'].note(at(0), 8 * BEAT, 'E1', 110)
    b['cb'].note(at(0), 8 * BEAT, 'E2', 110)
    b['trem'].chord(at(0), 8 * BEAT, 'E4 B4', 100).ramp(at(0), at(2), 11, 20, 127)
    # bars 2–3: the groove, horn call
    hit(b, at(2), 'Em', 124, 0.3, cym=True, gong=True)
    for bar in (2, 3):
        groove(b, at(bar), 'Em', vel=104)
    melody(b, at(2), THEME_A[0][1] + [(4 + p, d, k) for p, d, k in THEME_A[3][1]], [('hn', 0)], vel=108)
    # bars 4–11: theme A in horns and trombones
    for i, (c, notes) in enumerate(THEME_A):
        bar = 4 + i
        groove(b, at(bar), c, vel=106)
        melody(b, at(bar), notes, [('hn', 0), ('tbn', -12)], vel=114)
        for p in (1.5, 3.5):
            b['tpt'].chord(at(bar, p), 0.12, [k + 12 for k in ns(CHORDS[c][2])[1:]], 104)
        if i in (0, 4):
            b['cym'].note(at(bar), 2, 60, 118)
    # bars 12–15: theme B in the trumpets, horns hold the chords
    for i, (c, notes) in enumerate(THEME_B):
        bar = 12 + i
        groove(b, at(bar), c, vel=110)
        melody(b, at(bar), notes, [('tpt', 0)], vel=120)
        b['hn'].chord(at(bar), 4 * BEAT * 0.97, CHORDS[c][2], 100)
        b['vln'].chord(at(bar), 4 * BEAT * 0.97, [k + 12 for k in ns(CHORDS[c][2])[1:3]], 96)
        if i == 0:
            b['cym'].note(at(bar), 2, 60, 122)
    # bar 16: drums and low strings only; bar 17: build on the dominant
    groove(b, at(16), 'Em', vel=100, low_brass=False)
    groove(b, at(17), 'B', vel=96, strings=False, drums=False)
    roll(b, at(17), at(18) - 0.02, 40, 126, timp='B2')
    b['cymroll'].note(at(16, 3.2), 1, 60, 124)
    b['hn'].chord(at(17), 4 * BEAT, 'D#4 F#4 B4', 110).ramp(at(17), at(18), 11, 35, 127)
    b['tbn'].chord(at(17), 4 * BEAT, 'B2 F#3 A3', 110).ramp(at(17), at(18), 11, 35, 127)
    b['tuba'].note(at(17), 4 * BEAT, 'B1', 110)
    b['trem'].chord(at(17), 4 * BEAT, 'D#5 A5', 100).ramp(at(17), at(18), 11, 30, 127)
    # bars 18–25: theme A tutti — trumpets and horns, trombones below, violins above
    for i, (c, notes) in enumerate(THEME_A):
        bar = 18 + i
        groove(b, at(bar), c, vel=116)
        melody(b, at(bar), notes, [('tpt', 0), ('hn', 0), ('tbn', -12), ('vln', 12)], vel=124)
        if i in (0, 2, 4, 6):
            b['cym'].note(at(bar), 2, 60, 124)
    # bars 26–27: ♭VI – ♭VII – I, the other half completed in E major
    hit(b, at(26), 'C', 124, 0.35, cym=True)
    hit(b, at(26, 1.5), 'C', 120, 0.3)
    hit(b, at(26, 3), 'D', 126, 0.35, cym=True)
    roll(b, at(26, 3.3), at(27) - 0.02, 70, 127)
    final(b, at(27), 'E', hold=4.2)
    # dynamic arc shaped like the reference: a long build from the rolls, a breath at bar 16, full at the reprise
    curve = [(0, -15), (at(2) - 0.05, -5), (at(2), -4), (at(4), -3), (at(12), -1.8), (at(16), -3.5), (at(18) - 0.05, -1.5), (at(18), 0)]
    return mix(list(b.values()), at(27) + 6.0, master=_master(), fade_out=1.8, curve=curve, **MIXFX)
