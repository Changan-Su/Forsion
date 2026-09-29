"""Four scoring directions for study B (「第 2.12 话」). All melodies are original.

Each direction has:
  cue()  — 6.5 s, hits locked to study B's cuts (see CUT times below)
  full() — ~30 s, the same idea developed so the style can be judged on its own
"""
import numpy as np
from pedalboard import Reverb, Compressor, Limiter, HighpassFilter, LowpassFilter, Distortion, Chorus, Gain, LowShelfFilter, HighShelfFilter
from engine import (Track, Audio, mix, n, ns, SR, boom, impact, noise, click, glitch, beep, alarm, riser,
                    drone, heartbeat, tone, reverse, fade_in)

from cuts import CARDS, QUESTION, HUD, LINES, MAGI, WARN, EPISODE, TITLE, CUE_LEN  # noqa: F401

KIT = dict(bd=36, sd=38, sd2=40, cym=57, cym2=59)


def grid(bpm, start=0.0):
    b = 60 / bpm
    return b, (lambda bar, beat=0.0: start + (bar * 4 + beat) * b)


# ═════════════════════ 1 · 决战：管弦进行曲 ═════════════════════
def _march_band():
    return dict(
        lo=Track('strings-lo', 48, gain=1.0, pan=-0.2, send=0.22),
        hi=Track('strings-hi', 48, gain=0.7, pan=0.3, send=0.3),
        trem=Track('tremolo', 44, gain=2.2, pan=0.1, send=0.3),
        brass=Track('brass', 61, gain=1.0, pan=0.05, send=0.28),
        tpt=Track('trumpet', 56, gain=1.7, pan=0.18, send=0.3),
        tpt2=Track('trumpet-2', 56, bank=1, gain=1.2, pan=-0.12, send=0.3),
        horn=Track('horns', 60, gain=1.3, pan=-0.35, send=0.35),
        tbn=Track('trombone', 57, gain=0.8, pan=0.25, send=0.25),
        tuba=Track('tuba', 58, gain=0.9, send=0.2),
        timp=Track('timpani', 47, gain=0.85, send=0.3),
        perc=Track('perc', 48, drums=True, gain=0.7, send=0.3),
        hit=Track('orch-hit', 55, gain=0.55, send=0.3),
        choir=Track('choir', 52, gain=1.4, send=0.45),
        sfx=Audio('sfx', gain=0.9, send=0.1),
    )


CH = {  # stab voicings (mid register) and roots
    'Dm': ('D3 A3 D4 F4', 'D2'), 'F': ('C4 F4 A4', 'F2'), 'C': ('C4 E4 G4', 'C2'), 'Bb': ('Bb3 D4 F4', 'Bb1'),
    'Gm': ('Bb3 D4 G4', 'G1'), 'A7': ('C#4 E4 G4 A4', 'A1'), 'A': ('C#4 E4 A4', 'A1'), 'Eb': ('Eb4 G4 Bb4', 'Eb2'),
}


def _stab(b, t, chord, vel=112, dur=0.22, hit=True, cym=False):
    voic, root = CH[chord]
    b['brass'].chord(t, dur, voic, vel)
    b['tbn'].chord(t, dur, [n(root) + 12, n(root) + 19], vel - 5)
    b['tuba'].note(t, dur, n(root) + 12 if n(root) < 36 else root, vel)
    b['lo'].chord(t, dur, [n(root) + 12, n(root) + 24], vel)
    b['timp'].note(t, 0.5, n(root) + 12 if n(root) < 38 else root, vel)
    b['perc'].note(t, 0.3, KIT['bd'], vel)
    if hit:
        b['hit'].note(t, dur, n(root) + 36, vel - 20)
    if cym:
        b['perc'].note(t, 1.5, KIT['cym'], 118)


def _gallop(b, t0, beat, root, beats=4, vel=92):
    r = n(root)
    r = r + 12 if r < 38 else r
    for k in range(beats):
        for off, d, v in ((0, 0.45, vel), (0.5, 0.2, vel - 14), (0.75, 0.2, vel - 10)):
            b['lo'].chord(t0 + (k + off) * beat, d * beat, [r, r + 12], v)


def _snare_bar(b, t0, beat, roll=False, vel=100):
    pat = [(0, 1.0), (1, .7), (1.5, .78), (1.75, .7), (2, .92), (3, .7), (3.5, .78), (3.75, .7)]
    for p, a in pat:
        b['perc'].note(t0 + p * beat, 0.1, KIT['sd'], int(vel * a))
    if roll:
        for i in range(8):
            b['perc'].note(t0 + (2 + i * 0.25) * beat, 0.08, KIT['sd2'], int(60 + i * 8))


THEME = [
    [(0, .75, 'A4'), (.75, .25, 'A4'), (1, 1, 'D5'), (2, .5, 'E5'), (2.5, .5, 'F5'), (3, .5, 'E5'), (3.5, .5, 'D5')],
    [(0, 1.5, 'C5'), (1.5, .5, 'A4'), (2, 1, 'F4'), (3, 1, 'G4')],
    [(0, .75, 'A4'), (.75, .25, 'A4'), (1, 1, 'D5'), (2, 1, 'F5'), (3, 1, 'A5')],
    [(0, 1.5, 'G5'), (1.5, .5, 'F5'), (2, 2, 'E5')],
    [(0, .75, 'F5'), (.75, .25, 'E5'), (1, 1, 'D5'), (2, 1, 'C5'), (3, 1, 'Bb4')],
    [(0, 1.5, 'A4'), (1.5, .5, 'Bb4'), (2, 1, 'C5'), (3, 1, 'D5')],
    [(0, .75, 'E5'), (.75, .25, 'F5'), (1, 1, 'G5'), (2, 1, 'A5'), (3, .5, 'E5'), (3.5, .5, 'C#5')],
    [(0, 3, 'D5')],
]
THEME_CH = ['Dm', 'F', 'Dm', 'C', 'Bb', 'Gm', 'A7', 'Dm']


def _final_chord(b, t, hold=2.6, choir=True):
    """D major: the other half completed (Picardy third)."""
    b['brass'].chord(t, hold, 'D3 F#3 A3 D4 F#4 A4', 120)
    b['tpt'].chord(t, hold, 'D5 F#5', 118)
    b['tpt2'].note(t, hold, 'A4', 112)
    b['horn'].chord(t, hold, 'A3 D4 F#4', 115)
    b['tbn'].chord(t, hold, 'D2 A2 D3', 118)
    b['tuba'].note(t, hold, 'D2', 120)
    b['lo'].chord(t, hold, 'D2 D3 A3', 115)
    b['hi'].chord(t, hold, 'F#4 A4 D5 F#5', 110)
    b['hit'].note(t, 0.4, 'D5', 110)
    if choir:
        b['choir'].chord(t, hold + 0.4, 'D4 F#4 A4 D5', 118)
    for i in range(22):  # timpani roll, decaying
        b['timp'].note(t + i * 0.055, 0.06, 'D2', int(120 - i * 3.5))
    b['perc'].note(t, 2.5, KIT['bd'], 127)
    b['perc'].note(t, 3.0, KIT['cym'], 127)
    b['perc'].note(t + 0.01, 3.0, KIT['cym2'], 120)
    b['sfx'].add(t, impact(3.0), 0.55)


def march_cue():
    b = _march_band()
    for t, c in zip(CARDS, ['Dm', 'Bb', 'Gm', 'A']):
        _stab(b, t, c, vel=108 + CARDS.index(t) * 4, dur=0.26, cym=(t == CARDS[0]))
    # 人类？: a clashing Eb over D, then a snare/timpani roll into the HUD
    b['brass'].chord(QUESTION, 0.3, 'Eb4 G4 Bb4 D5', 124)
    b['tbn'].chord(QUESTION, 0.3, 'D2 D3', 120)
    b['hit'].note(QUESTION, 0.3, 'Eb5', 115)
    b['perc'].note(QUESTION, 1.2, KIT['cym'], 124)
    b['perc'].note(QUESTION, 0.3, KIT['bd'], 124)
    for i in range(14):
        tt = QUESTION + 0.12 + i * (HUD - QUESTION - 0.14) / 14
        b['perc'].note(tt, 0.05, KIT['sd2'], 55 + i * 5)
        b['timp'].note(tt, 0.06, 'A1', 60 + i * 4)
    b['trem'].chord(QUESTION + 0.1, HUD - QUESTION - 0.1, 'A3 A4', 90).ramp(QUESTION + 0.1, HUD, 11, 40, 127)
    # HUD: one bar of the march at 148 bpm (1.78 → 3.40)
    beat, at = grid(148, HUD)
    _gallop(b, HUD, beat, 'D2')
    _snare_bar(b, HUD, beat)
    b['perc'].note(HUD, 1.5, KIT['cym'], 120)
    b['timp'].note(HUD, 0.4, 'D2', 118).note(at(0, 2), 0.4, 'A1', 105)
    for p, d, k in THEME[0]:
        b['tpt'].note(at(0, p), d * beat * 0.95, k, 115)
        b['tpt2'].note(at(0, p), d * beat * 0.95, n(k) - 12, 100)
    b['horn'].chord(HUD, 4 * beat, 'D4 F4 A4', 88)
    for t in MAGI:  # three panels flip: rat-tat-tat
        b['brass'].chord(t, 0.07, 'D4 F4 A4', 118)
        b['perc'].note(t, 0.05, KIT['sd'], 120)
    _stab(b, at(0, 3.5), 'Dm', vel=112, dur=0.18, hit=False)
    # EPISODE card: everything drops out; tremolo + reverse cymbal pull toward the title
    b['trem'].chord(EPISODE + 0.02, TITLE - EPISODE, 'A4 A5', 80).ramp(EPISODE, TITLE, 11, 30, 120)
    rc = reverse(noise(0.6, hp=3000, decay=0.25))
    b['swell'] = Audio('swell', send=0.1).add(TITLE - 0.6, rc * np.linspace(0.2, 1, len(rc)) ** 2, 0.35)
    _final_chord(b, TITLE)
    gates = [(EPISODE, TITLE, -60, {'tremolo', 'swell'})]
    return mix(list(b.values()), CUE_LEN, fade_out=0.9, gates=gates, master_gates=[(EPISODE + 0.01, TITLE - 0.25, -14, ())])


def march_full():
    b = _march_band()
    beat, at = grid(148, 0.3)
    # bars 0–1: hit pattern over a low tremolo pedal
    b['trem'].chord(at(0), 8 * beat, 'D2 D3', 100).ramp(at(0), at(2), 11, 50, 120)
    for bar, beats in ((0, [0, 1.5, 3]), (1, [0, 1.5, 3, 3.5])):
        for p in beats:
            _stab(b, at(bar, p), 'Dm', vel=110 + (5 if p == 0 else 0), dur=0.24, cym=(bar == 0 and p == 0))
    for i in range(8):
        b['perc'].note(at(1, 2 + i * 0.25), 0.08, KIT['sd2'], 60 + i * 8)
    # bars 2–3: ostinato + snare, horns announce the motif
    for bar in (2, 3):
        _gallop(b, at(bar), beat, 'D2', vel=88)
        _snare_bar(b, at(bar), beat, roll=(bar == 3))
        b['timp'].note(at(bar, 0), 0.4, 'D2', 110).note(at(bar, 2), 0.4, 'A1', 100)
        _stab(b, at(bar, 1.5), 'Dm', vel=100, dur=0.16, hit=False)
        _stab(b, at(bar, 3.5), 'Dm', vel=100, dur=0.16, hit=False)
    for p, d, k in THEME[0]:
        b['horn'].note(at(2, p), d * beat * 0.95, n(k) - 12, 108)
    b['horn'].note(at(3), 3 * beat, 'D4', 104)
    # bars 4–11: the theme
    for i, (bar_notes, c) in enumerate(zip(THEME, THEME_CH)):
        bar = 4 + i
        voic, root = CH[c]
        _gallop(b, at(bar), beat, root, vel=94)
        _snare_bar(b, at(bar), beat, roll=(i == 7))
        b['timp'].note(at(bar, 0), 0.4, n(root) + 12 if n(root) < 38 else root, 112)
        b['timp'].note(at(bar, 2), 0.4, n(root) + 19 if n(root) < 38 else n(root) + 7, 100)
        _stab(b, at(bar, 1.5), c, vel=104, dur=0.16, hit=False)
        _stab(b, at(bar, 3.5), c, vel=104, dur=0.16, hit=False)
        b['horn'].chord(at(bar), 4 * beat * 0.98, voic, 78)
        if i in (0, 4):
            b['perc'].note(at(bar), 1.6, KIT['cym'], 118)
        for p, d, k in bar_notes:
            b['tpt'].note(at(bar, p), d * beat * 0.95, k, 118)
            b['tpt2'].note(at(bar, p), d * beat * 0.95, n(k) - 12, 104)
            if i >= 4:
                b['hi'].note(at(bar, p), d * beat * 0.95, n(k) + 12, 100)
    # bars 12–13: build (Bb → C → A), rising strings, rolls
    for k in range(4):
        _stab(b, at(12, k), 'Bb', vel=108, dur=0.2, hit=(k == 0))
    _stab(b, at(13, 0), 'C', vel=112, dur=0.2)
    _stab(b, at(13, 1), 'C', vel=114, dur=0.2, hit=False)
    b['brass'].chord(at(13, 2), 2 * beat, 'C#4 E4 A4', 118)
    b['tbn'].chord(at(13, 2), 2 * beat, 'A1 A2 E3', 116)
    scale = ns('D4 E4 F4 G4 A4 Bb4 C5 C#5 D5 E5 F5 G5 A5 Bb5 C#6 D6')
    for i, k in enumerate(scale):
        b['hi'].note(at(12, i * 0.5), 0.5 * beat, k, 90 + i * 2)
    for i in range(32):
        b['perc'].note(at(12, i * 0.25), 0.06, KIT['sd2'], 50 + i * 2)
        b['timp'].note(at(13, 2 + i * 0.0625), 0.05, 'A1', 70 + i)
    b['sfx'].add(at(14) - 1.6, riser(1.6, 300, 6000, tone=False), 0.25)
    # bar 14: D major, held
    _final_chord(b, at(14), hold=4.6)
    return mix(list(b.values()), at(14) + 6.2, fade_out=1.6, curve=[(0, -7), (at(2), -6), (at(4), -3.5), (at(12), -2), (at(14) - 0.05, -1.5), (at(14), 0)])


# ═════════════════════ 2 · MAGI：电子悬疑 ═════════════════════
def _magi_band():
    return dict(
        bass=Track('synth-bass', 38, bank=1, gain=0.9, send=0.08, fx=[Distortion(6), LowpassFilter(1400)]),
        pad=Track('pad', 94, gain=0.8, send=0.35),
        trem=Track('tremolo', 44, gain=1.8, send=0.3),
        bell=Track('tubular', 14, gain=0.8, send=0.45),
        cbell=Track('church-bell', 14, bank=8, gain=0.8, send=0.5),
        choir=Track('choir', 52, gain=0.8, send=0.5),
        low=Track('low-brass', 61, gain=0.8, send=0.35),
        hats=Track('hats', 24, drums=True, gain=1.6, send=0.05, fx=[HighpassFilter(2000)]),
        kick=Track('kick', 25, drums=True, gain=0.8, send=0.05),
        sfx=Audio('sfx', gain=0.5, send=0.15),
        ui=Audio('ui', gain=0.5, send=0.2, fx=[HighpassFilter(300)]),
    )


def _typing(ui, t0, chars, cps=60, seed=0):
    r = np.random.default_rng(seed)
    for i in range(chars):
        ui.add(t0 + i / cps + r.uniform(0, 0.004), click(0.03, lp=6000), r.uniform(0.15, 0.3))


def magi_cue():
    b = _magi_band()
    d = drone(2.5, 36.7)[: int(QUESTION * SR)]
    d[-240:] *= np.linspace(1, 0, 240)
    b['sfx'].add(0, d, 0.22)
    for i, (t, k) in enumerate(zip(CARDS, ['D5', 'F5', 'A5', 'C6'])):
        b['ui'].add(t, glitch(0.16, seed=i), 0.9)
        b['sfx'].add(t, boom(0.5, 80, 40, 0.06, 0.12, 2.0), 0.6)
        b['bell'].note(t, 0.6, k, 100)
    b['ui'].add(QUESTION, beep(1000, 0.42, release=0.05), 0.55)  # flatline
    sw = reverse(boom(0.45, 60, 30, 0.2, 0.3))
    b['swell'] = Audio('swell', send=0.1).add(HUD - 0.45, sw * np.linspace(0, 1, len(sw)), 1.0)
    b['sfx'].add(HUD, impact(2.0), 0.8)
    b['pad'].chord(HUD, EPISODE - HUD, 'D3 A3 F4', 90).ramp(HUD, EPISODE, 11, 60, 120)
    b['trem'].chord(HUD, EPISODE - HUD, 'D2 A2', 95)
    s16 = 60 / 128 / 4
    i, t = 0, HUD
    while t < EPISODE - 0.02:
        acc = i % 4 == 0
        b['bass'].note(t, s16 * 0.8, 'D2' if i % 8 != 6 else 'D3', 118 if acc else 92)
        if i % 2 == 0:
            b['hats'].note(t, 0.05, 42, 90 if acc else 60)
        if i % 4 == 0:
            b['kick'].note(t, 0.2, 36, 110)
        i, t = i + 1, t + s16
    lens = [19, 15, 15, 15, 14]
    for j, (t, c) in enumerate(zip(LINES, lens)):
        _typing(b['ui'], t, c, seed=j)
        b['ui'].add(t, beep([1480, 1760, 1976, 2217, 2637][j], 0.07), 0.9)
    g = np.linspace(0, 1, int((3.1 - 1.95) * SR))
    b['sfx'].add(1.95, (np.sin(2 * np.pi * np.cumsum(220 * 4 ** g) / SR) * g * 0.3).astype(np.float32), 0.35)
    for t, f in zip(MAGI, [1760, 1320, 880]):
        b['ui'].add(t, beep(f, 0.07, shape='square'), 1.2)
    b['sfx'].add(WARN, alarm(EPISODE - WARN, 880, 660, 6.0), 0.3)
    b['sfx'].add(2.7, riser(EPISODE - 2.7, 300, 5000), 0.3)
    b['swell'].add(EPISODE, tone(3520, TITLE - EPISODE), 0.12)
    rc = reverse(noise(0.38, hp=2500, decay=0.2))
    b['swell'].add(TITLE - 0.38, rc, 0.35)
    b['sfx'].add(TITLE, boom(3.2, 120, 24, 0.5, 1.2, 2.2), 1.0)
    b['sfx'].add(TITLE, impact(2.5), 0.6)
    b['low'].chord(TITLE, 2.4, 'D2 A2 D3 Eb3', 120)
    b['choir'].chord(TITLE, 2.6, 'D3 A3 D4 F4', 110)
    b['cbell'].note(TITLE, 2.5, 'D4', 115)
    b['pad'].chord(TITLE, 2.6, 'D2 A2', 100)
    gates = [(QUESTION, HUD, -60, {'ui', 'swell'}), (EPISODE, TITLE, -60, {'swell'})]
    return mix(list(b.values()), CUE_LEN, fade_out=0.9, gates=gates, master_gates=[(QUESTION + 0.01, HUD - 0.3, -10, ()), (EPISODE + 0.01, TITLE - 0.2, -16, ())])


def magi_full():
    b = _magi_band()
    L = 31.0
    b['sfx'].add(0, drone(22.3, 36.7), 0.2)
    for t in np.arange(0.4, 22, 1.08):
        b['sfx'].add(t, heartbeat(), 0.55 if t < 8 else 0.4)
    r = np.random.default_rng(4)
    for t in np.arange(1.0, 22, 0.9):
        if r.random() < 0.55:
            b['ui'].add(t + r.uniform(0, 0.3), beep(r.choice([1319, 1568, 1760, 2093, 2637]), 0.06), r.uniform(0.5, 0.9))
    for t in (0.5, 4.5):
        b['bell'].note(t, 3.5, 'D5', 90)
    for t in (2.2, 5.6):
        b['ui'].add(t, noise(0.25, lp=4000, hp=800, decay=0.1), 0.18)
    # 8 s: the pulse (120 bpm)
    beat = 0.5
    prog = [('D2', 'D3 A3 F4'), ('D2', 'D3 A3 F4'), ('Bb1', 'D3 F3 Bb3'), ('C2', 'E3 G3 C4'), ('A1', 'C#3 E3 A3'), ('A1', 'C#3 E3 A3'), ('D2', 'D3 A3 F4')]
    t0 = 8.0
    for bar, (root, pad) in enumerate(prog):
        tb = t0 + bar * 4 * beat
        b['pad'].chord(tb, 4 * beat, pad, 85 + bar * 5)
        b['trem'].chord(tb, 4 * beat, [n(root), n(root) + 7], 90)
        b['bell'].note(tb, 1.5, n(root) + 48, 85)
        for i in range(16):
            tt = tb + i * beat / 4
            rr = n(root) + (12 if i % 8 == 6 else 0)
            b['bass'].note(tt, beat / 4 * 0.8, rr + 12 if rr < 38 else rr, 118 if i % 4 == 0 else 90)
            if i % 2 == 0:
                b['hats'].note(tt, 0.05, 42, 85 if i % 4 == 0 else 55)
            if bar >= 3 and i % 4 == 0:
                b['kick'].note(tt, 0.2, 36, 112)
    b['sfx'].add(16.0, alarm(6.0, 880, 660, 3.0), 0.22)
    b['sfx'].add(19.0, riser(3.0, 250, 6000), 0.35)
    # 22 s: impact, then a breath of silence
    b['sfx'].add(22.0, boom(4.0, 130, 22, 0.5, 1.4, 2.4), 1.0)
    b['sfx'].add(22.0, impact(3.0), 0.7)
    b['low'].chord(22.0, 1.2, 'D2 A2 D3 Eb3', 124)
    b['sfx'].add(22.3, tone(3520, 0.6), 0.05)
    # 22.8 s: choir and bell, heartbeat slowing, flatline
    b['choir'].chord(22.9, 6.5, 'D3 A3 D4 E4', 96).ramp(22.9, 26.0, 11, 50, 115)
    b['pad'].chord(22.9, 7.0, 'D2 A2 D3', 90)
    b['cbell'].note(23.0, 4.0, 'D4', 100).note(26.2, 3.5, 'A3', 90)
    for t in (23.5, 25.0, 27.0):
        b['sfx'].add(t, heartbeat(), 0.45)
    b['ui'].add(28.6, beep(1000, 1.6, release=0.3), 0.35)
    return mix(list(b.values()), L, fade_out=1.8, curve=[(0, -6), (8, -5), (16, -2.5), (21.9, -1), (22, 0), (23, -2)])


# ═════════════════════ 3 · 补完：圣咏与管风琴 ═════════════════════
def _choral_band():
    return dict(
        organ=Track('organ', 19, gain=0.75, send=0.45),
        organ2=Track('organ-full', 19, bank=8, gain=0.6, send=0.5),
        choir=Track('choir', 52, gain=1.0, send=0.5),
        strings=Track('strings', 49, gain=0.8, send=0.45),
        bass=Track('basses', 43, gain=0.8, send=0.35),
        harp=Track('harpsichord', 6, gain=1.6, pan=0.3, send=0.3),
        timp=Track('timpani', 47, gain=0.75, send=0.35),
        cbell=Track('church-bell', 14, bank=8, gain=0.7, send=0.55),
        perc=Track('perc', 48, drums=True, gain=0.9, send=0.4),
        sfx=Audio('sfx', gain=0.8, send=0.1),
    )


def _voice(b, t, dur, satb, vel=100, choir=True, organ=True, strings=True):
    s, a, tn, bs = ns(satb)
    if organ:
        b['organ'].chord(t, dur, [s, a, tn, bs], vel)
    if choir:
        b['choir'].chord(t, dur, [s, a, tn], vel)
    if strings:
        b['strings'].chord(t, dur, [a, tn], vel - 10)
        b['bass'].note(t, dur, bs, vel)


# Soprano / alto / tenor / bass, one chord per beat. D minor, ending in D major.
CHORALE = [
    ['A4 F4 D4 D3', 'Bb4 G4 D4 Bb2', 'A4 E4 A3 C#3', 'D5 F4 A3 D3'],
    ['C5 F4 A3 F2', 'Bb4 G4 D4 G2', 'A4 F4 D4 A2', 'A4 E4 C#4 A2'],
    ['F5 A4 D4 D3', 'E5 A4 C#4 C#3', 'D5 F4 Bb3 Bb2', 'C#5 E4 A3 A2'],
    ['D5 F4 A3 D3', 'D5 F4 A3 D3', None, None],
    ['A4 F#4 D4 D3', 'B4 G4 D4 B2', 'C#5 E4 A3 A2', 'D5 F#4 A3 F#2'],
    ['E5 B4 G4 G2', 'F#5 B4 D4 B2', 'E5 A4 C#4 C#3', 'D5 A4 F#4 D3'],
    ['G5 B4 D4 B2', 'F#5 A4 D4 A2', 'E5 A4 C#4 A2', 'E5 G4 C#4 A2'],
    ['D5 A4 F#4 D2', None, None, None],
]


def choral_cue():
    b = _choral_band()
    chords = ['A4 F4 D4 D3', 'Bb4 F4 D4 Bb2', 'Bb4 G4 D4 G2', 'A4 E4 C#4 A2']
    for i, (t, satb) in enumerate(zip(CARDS + [QUESTION], chords + [None])):
        if satb is None:
            break
        nxt = (CARDS + [QUESTION])[i + 1]
        _voice(b, t, nxt - t - 0.02, satb, 100 + i * 5, choir=(i == 3))
        b['timp'].note(t, 0.3, 'D2' if i != 3 else 'A1', 100)
    b['solo'] = Track('solo', 52, bank=1, gain=1.2, send=0.6).note(QUESTION + 0.02, HUD - QUESTION + 0.1, 'A5', 96)  # a single voice, asking
    # HUD: baroque figuration in D minor under an organ pedal
    b['organ'].note(HUD, EPISODE - HUD, 'D2', 100)
    b['strings'].chord(HUD, EPISODE - HUD, 'D3 A3 F4', 92).ramp(HUD, EPISODE, 11, 70, 120)
    fig = ns('D4 F4 A4 D5 A4 F4 D4 A3 C#4 E4 A4 E4')
    s16 = 60 / 104 / 4
    for i, k in enumerate(fig):
        t = HUD + i * s16
        if t < EPISODE:
            b['harp'].note(t, s16 * 0.9, k, 100)
            b['harp'].note(t, s16 * 0.9, k - 12, 80)
    b['timp'].note(HUD, 0.4, 'D2', 110).note(HUD + 4 * s16 * 2, 0.4, 'A1', 100)
    b['cbell'].note(WARN, 1.2, 'D4', 110)
    for t in MAGI:
        b['organ'].chord(t, 0.07, 'A4 D5', 105)
    b['sfx'].add(TITLE - 0.5, reverse(noise(0.5, hp=4000, decay=0.2)), 0.5)
    # title: D major, full
    b['organ2'].chord(TITLE, 2.6, 'D2 D3 A3 D4 F#4 A4 D5', 115)
    _voice(b, TITLE, 2.6, 'F#5 A4 D4 D2', 118)
    b['choir'].note(TITLE, 2.6, 'D5', 112)
    b['cbell'].note(TITLE, 2.6, 'D4', 115).note(TITLE, 2.6, 'A3', 100)
    for i in range(20):
        b['timp'].note(TITLE + i * 0.06, 0.06, 'D2', int(118 - i * 3))
    b['perc'].note(TITLE, 3.0, KIT['cym'], 110)
    gates = [(QUESTION, HUD, -60, {'solo'}), (EPISODE, TITLE, -60, {'sfx'})]
    return mix(list(b.values()), CUE_LEN, gates=gates, master_gates=[(EPISODE + 0.01, TITLE - 0.2, -12, ())], reverb=Reverb(room_size=0.92, damping=0.3, wet_level=1.0, dry_level=0.0, width=1.0), fade_out=0.9)


def choral_full():
    b = _choral_band()
    beat = 60 / 66
    t = 0.4
    for bar, chords in enumerate(CHORALE):
        bar_start = t
        lens = [beat * (1 + 0.14 * k if bar == 6 else 1) for k in range(4)]  # ritardando into the last bar
        for k, satb in enumerate(chords):
            if satb is not None:
                span = 1
                while k + span < 4 and chords[k + span] is None:
                    span += 1
                d = 5.5 * beat if bar == 7 else sum(lens[k:k + span]) - 0.03
                _voice(b, t, d, satb, 92 + bar * 3, choir=bar >= 2 or k % 2 == 0)
            t += lens[k]
        if 4 <= bar < 7:  # harpsichord figuration: the EVA irony of baroque over crisis
            pairs = [ns(c)[1:3] for c in chords if c]
            s16 = beat / 4
            for i in range(16):
                pair = pairs[min(i // 4, len(pairs) - 1)]
                b['harp'].note(bar_start + i * s16, s16 * 0.9, pair[i % 2] + (12 if i % 4 > 1 else 0), 90)
            b['timp'].note(bar_start, 0.5, 'D2' if bar % 2 == 0 else 'A1', 100)
        if bar == 3:
            b['cbell'].note(bar_start, 2.5, 'D4', 90)
        if bar == 7:
            final = bar_start
    b['organ2'].chord(final, 5.5, 'D2 D3 A3 D4 F#4 A4 D5', 115)
    b['cbell'].note(final, 5, 'D4', 110).note(final + 1.8, 4, 'A3', 95)
    for i in range(30):
        b['timp'].note(final + i * 0.07, 0.07, 'D2', int(115 - i * 2.5))
    b['perc'].note(final, 4.0, KIT['cym'], 112)
    return mix(list(b.values()), final + 6.8, curve=[(0, -7), (14.9, -5), (final - 0.1, -2.5), (final, 0)], reverb=Reverb(room_size=0.93, damping=0.3, wet_level=1.0, dry_level=0.0, width=1.0), fade_out=2.2)


# ═════════════════════ 4 · 彼此：萨克斯哀歌 ═════════════════════
def _ballad_band():
    return dict(
        sax=Track('alto-sax', 65, gain=1.5, pan=0.1, send=0.32),
        piano=Track('piano', 0, gain=0.6, pan=-0.2, send=0.35),
        strings=Track('strings', 49, gain=0.75, send=0.45),
        bass=Track('fretless', 35, gain=0.6, send=0.12),
        kit=Track('brushes', 40, drums=True, gain=0.55, send=0.2),
        oohs=Track('oohs', 53, gain=0.6, send=0.5),
        sfx=Audio('sfx', gain=0.6, send=0.2),
    )


BALLAD = [  # (root, pad voicing, melody [(beat, dur, note)])
    ('D2', 'F3 A3 C4 E4', [(1, .5, 'A4'), (1.5, .5, 'D5'), (2, 1, 'E5'), (3, 1, 'F5')]),
    ('Bb1', 'D3 F3 A3', [(0, 1.5, 'E5'), (1.5, .5, 'D5'), (2, 2, 'A4')]),
    ('G1', 'F3 Bb3 D4', [(.5, .5, 'Bb4'), (1, .5, 'C5'), (1.5, .5, 'D5'), (2, 1, 'F5'), (3, .5, 'E5'), (3.5, .5, 'D5')]),
    ('A1', 'C#3 E3 G3', [(0, 2, 'E5'), (2, 1, 'C#5'), (3, 1, 'A4')]),
    ('D2', 'F3 A3 D4', [(.5, .5, 'A4'), (1, .5, 'D5'), (1.5, .5, 'E5'), (2, 1, 'F5'), (3, 1, 'G5')]),
    ('Bb1', 'D3 F3 A3', [(0, 1.5, 'A5'), (1.5, .5, 'G5'), (2, 1, 'F5'), (3, 1, 'D5')]),
    ('A1', 'C#3 E3 G3', [(0, 1, 'F5'), (1, .5, 'E5'), (1.5, .5, 'D5'), (2, 1, 'E5'), (3, 1, 'C#5')]),
    ('D2', 'F#3 A3 C#4 E4', [(0, 1, 'D5'), (1, 1, 'E5'), (2, 5, 'F#5')]),
]


def _brush_bar(b, t0, beat, vel=80):
    b['kit'].note(t0, 0.3, 36, vel)
    b['kit'].note(t0 + 2.5 * beat, 0.3, 36, vel - 20)
    for p in (1, 3):
        b['kit'].note(t0 + p * beat, 0.3, 38, vel - 5)
    for i in range(8):
        b['kit'].note(t0 + i * beat / 2 + (0.06 if i % 2 else 0), 0.1, 42, vel - 25 - (10 if i % 2 else 0))


def ballad_cue():
    b = _ballad_band()
    for t, k in zip(CARDS, ['D5', 'C5', 'Bb4', 'A4']):
        b['piano'].note(t, 1.2, k, 72).note(t, 1.2, n(k) - 12, 55)
    b['strings'].chord(CARDS[0], QUESTION - CARDS[0], 'D3 A3 F4', 60)
    b['piano'].chord(QUESTION, 0.4, 'E5 A5', 40)
    beat = 60 / 84
    b['bass'].note(HUD, 1.0, 'D2', 100).note(HUD + 2 * beat, 0.6, 'A1', 90)
    b['strings'].chord(HUD, EPISODE - HUD + 0.3, 'F3 A3 C4 E4', 80).ramp(HUD, EPISODE, 11, 50, 110)
    _brush_bar(b, HUD, beat, 72)
    for i, k in enumerate(ns('D4 A4 C5 E5 A4 C5')):
        b['piano'].note(HUD + i * beat / 2, beat, k, 55)
    for p, d, k in [(0, .5, 'A4'), (.5, .5, 'D5'), (1, 1, 'E5'), (2, 1.9, 'F5')]:
        b['sax'].note(HUD + p * beat, d * beat * 0.97, k, 100)
    b['sax'].ramp(HUD + 2 * beat, EPISODE, 11, 127, 70)
    b['sfx'].add(TITLE - 0.8, reverse(noise(0.8, hp=5000, decay=0.4)) * 1.0, 0.12)
    b['strings'].chord(TITLE, 2.7, 'D3 F#3 A3 C#4 E4', 100).ramp(TITLE, TITLE + 1.2, 11, 60, 118)
    b['oohs'].chord(TITLE, 2.7, 'A3 D4 F#4', 90)
    b['bass'].note(TITLE, 2.6, 'D2', 100)
    b['piano'].chord(TITLE, 2.6, 'D3 A3 E4 F#4 C#5', 70)
    b['sax'].note(TITLE + 0.1, 2.3, 'F#5', 96).ramp(TITLE + 0.1, TITLE + 2.4, 11, 90, 127)
    b['kit'].note(TITLE, 2.0, 49, 60)
    gates = [(QUESTION, HUD, -40, {'piano'}), (EPISODE, TITLE, -14, {'strings', 'sfx'})]
    return mix(list(b.values()), CUE_LEN, fade_out=1.0, gates=gates)


def ballad_full():
    b = _ballad_band()
    beat = 60 / 70
    t0 = 0.3
    for i, k in enumerate(ns('D4 A4 C5 E5')):
        b['piano'].note(t0 + i * beat / 2, 2 * beat, k, 58)
    t0 += 2 * beat
    for bar, (root, pad, mel) in enumerate(BALLAD):
        tb = t0 + bar * 4 * beat
        last = bar == len(BALLAD) - 1
        hold = 7 * beat if last else 4 * beat
        b['strings'].chord(tb, hold, pad, 78 + bar * 4)
        if bar in (0, 4):
            b['strings'].ramp(tb, tb + 4 * beat, 11, 60, 110)
        r = n(root)
        b['bass'].note(tb, 1.9 * beat, r + 12 if r < 38 else r, 100)
        if not last:
            b['bass'].note(tb + 2 * beat, 1.9 * beat, (r + 12 if r < 38 else r) + 7, 88)
        else:
            b['bass'].note(tb, 6 * beat, 'D2', 100)
        tones = ns(pad)
        for i in range(8 if not last else 4):
            b['piano'].note(tb + i * beat / 2, beat * 0.9, tones[i % len(tones)] + 12, 52 + (8 if i % 4 == 0 else 0))
        if bar >= 1 and not last:
            _brush_bar(b, tb, beat, 70 + (8 if bar >= 4 else 0))
        for p, d, k in mel:
            b['sax'].note(tb + p * beat, d * beat * 0.96, k, 102 if bar >= 4 else 94)
        if bar >= 4:
            b['oohs'].chord(tb, hold, ns(pad)[:2], 70)
    end = t0 + 7 * 4 * beat
    b['piano'].chord(end, 6 * beat, 'D3 A3 E4 F#4 C#5', 64)
    b['oohs'].chord(end, 6 * beat, 'A3 D4 F#4', 84)
    b['kit'].note(end, 3.0, 49, 55)
    b['sax'].ramp(end + 2 * beat, end + 7 * beat, 11, 127, 50)
    return mix(list(b.values()), end + 7.5 * beat + 1.2, fade_out=2.0, curve=[(0, -6), (15.7, -4), (22, -1.5), (end, 0)])


DIRECTIONS = {
    '1-march': ('决战 · 管弦进行曲', march_cue, march_full),
    '2-magi': ('MAGI · 电子悬疑', magi_cue, magi_full),
    '3-choral': ('补完 · 圣咏与管风琴', choral_cue, choral_full),
    '4-ballad': ('彼此 · 萨克斯哀歌', ballad_cue, ballad_full),
}

from battle import battle_cue, battle_full  # noqa: E402  (sample-based; needs VSCO 2 CE)
DIRECTIONS['5-battle'] = ('决战 II · 采样管弦', battle_cue, battle_full)
