"""Two scores for the full study-B film, both written to film/cuesheet.json.

film_battle(): 决战 II — sampled battle march, 150 BPM, E minor → E major.
film_choral(): 补完 — organ and chorale, 75 BPM (one chorale beat = half a march bar), D minor → D major.
Picture cuts sit on the 150 BPM bar grid, so both scores land their hits on the same frames.
"""
import json
import os
import sys
import numpy as np
import soundfile as sf
from pedalboard import HighpassFilter, Reverb
from engine import Audio, Track, mix, n, ns, boom, noise, beep, reverse
from battle import band as battle_band, groove, melody, hit, roll, final, THEME_A, THEME_B, CHORDS, BEAT, _master, MIXFX
from pieces import _choral_band, _voice, CHORALE, KIT

HERE = os.path.dirname(__file__)
CUE = json.load(open(os.path.join(HERE, '..', 'film', 'cuesheet.json')))
BAR = 4 * BEAT
LEN = CUE['length']
SEC = {s['id']: (s['bar'] * BAR, (s['bar'] + s['bars']) * BAR) for s in CUE['sections']}
MG, R2 = SEC['magi'][0], SEC['magi'][0] + BAR


def B(bar, beat=0.0):
    return (bar * 4 + beat) * BEAT


def common_sfx():
    """Interface sounds shared by both scores: boot beeps, HUMAN.md update chirps, sub hits on the big reveals."""
    ui = Audio('ui', gain=0.3, send=0.15, fx=[HighpassFilter(300)])
    for i in range(7):
        ui.add(0.12 + i * 0.36, beep(1760 if i < 6 else 740, 0.05 if i < 6 else 0.18, shape='sine' if i < 6 else 'square'), 0.5 if i < 6 else 0.7)
    for i in range(3):
        ui.add(SEC['evolve'][0] + i * BAR + 0.45, beep(2093, 0.06), 0.5)
        ui.add(SEC['evolve'][0] + i * BAR + 0.55, beep(2637, 0.06), 0.45)
    sub = Audio('sub', gain=0.55, send=0.05)
    for t in (SEC['question'][0], B(11, 2), SEC['finale'][0] + 2 * BAR, SEC['finale'][0] + 5 * BAR):
        sub.add(t, boom(2.5, 100, 28, 0.35, 0.9, 1.8), 0.8)
    return [ui, sub]


# ═════════════════════ 决战 II ═════════════════════
def _pad(b, t, dur, chord, vel=100):
    root, iv, voic = CHORDS[chord]
    r = n(root)
    b['hn'].chord(t, dur, voic, vel)
    b['tbn'].chord(t, dur, [r + 24, r + 31], vel - 4)
    b['tuba'].note(t, dur, r + 12, vel)
    b['vln'].chord(t, dur, [k + 12 for k in ns(voic)[1:3]], vel - 6)
    b['vla'].chord(t, dur, ns(voic)[1:3], vel - 8)
    b['vc'].note(t, dur, r + 12, vel)
    b['cb'].note(t, dur, r, vel)


def film_battle():
    b = battle_band()
    # boot: a roll and a low pedal out of silence
    roll(b, B(0), B(2) - 0.02, 12, 96, timp='E3')
    b['tbn'].chord(B(0), 2 * BAR, 'E2 B2', 100).ramp(B(0), B(2), 11, 10, 110)
    b['tuba'].note(B(0), 2 * BAR, 'E1', 100)
    b['cb'].note(B(0), 2 * BAR, 'E1', 100)
    b['trem'].chord(B(0), 2 * BAR, 'E4 B4', 90).ramp(B(0), B(2), 11, 15, 110)
    # the seven intertitles, one stab each; the ticker gets a roll
    for i, c in enumerate(['Em', 'C', 'A', 'B', 'Em', 'C', 'D']):
        hit(b, B(2 + i * 0.5), c, vel=104 + i * 3, dur=0.3, cym=(i == 0))
    roll(b, B(5, 2), B(6) - 0.02, 60, 118, timp='E3')
    # years: low and held
    b['vc'].chord(B(6), 2 * BAR, 'E2 B2', 84)
    b['cb'].note(B(6), 2 * BAR, 'E1', 88)
    b['hn'].chord(B(6), BAR, 'E3 G3 B3', 74).chord(B(7), BAR, 'E3 G3 C4', 78)
    for bar in (6, 7):
        for p in (0, 2):
            b['timp'].note(B(bar, p), 0.3, 'E3', 72)
    # half: the groove enters
    groove(b, B(8), 'Em', vel=92, low_brass=False)
    groove(b, B(9), 'Em', vel=98)
    # 人类？: F over E, gong, roll
    hit(b, B(10), 'F', 124, 0.3, cym=True, gong=True)
    b['cb'].note(B(10), 0.3, 'E1', 124)
    roll(b, B(10) + 0.1, B(11) - 0.02, 50, 122, timp='E3')
    b['cymroll'].note(B(10) + 0.05, 1, 60, 110)
    # EPISODE card (gated to a tremolo), then the title hit and theme A
    b['trem'].chord(B(11), 2 * BEAT, 'E5 B5', 100).ramp(B(11), B(11, 2), 11, 40, 127)
    b['cymroll'].note(B(11) - 0.3, 1, 60, 118)
    hit(b, B(11, 2), 'Em', 126, 0.4, cym=True, gong=True)
    b['hn'].chord(B(11, 2), 2 * BEAT, 'E3 B3 E4', 116)
    for i, (c, notes) in enumerate(THEME_A):
        bar = 12 + i
        groove(b, B(bar), c, vel=106)
        melody(b, B(bar), notes, [('hn', 0), ('tbn', -12)], vel=114)
        for p in (1.5, 3.5):
            b['tpt'].chord(B(bar, p), 0.12, [k + 12 for k in ns(CHORDS[c][2])[1:]], 102)
        if i in (0, 4):
            b['cym'].note(B(bar), 2, 60, 116)
    # MAGI round 1: bright C, the panels approve
    groove(b, B(20), 'C', vel=108)
    for t in (MG + .5, MG + .6, MG + .7):
        b['tpt'].chord(t, 0.08, 'E5 G5', 116)
    # round 2: the clash, the handover, alarm trumpets on the dominant
    hit(b, R2, 'F', 122, 0.3, cym=True)
    b['cb'].note(R2, 0.3, 'E1', 122)
    groove(b, B(21), 'B', vel=112, low_brass=False)
    for t in (R2 + .35, R2 + .47, R2 + .59):
        b['tpt'].chord(t, 0.08, 'F5 B5', 120)
    groove(b, B(22), 'B', vel=114)
    for i in range(8):
        b['tpt'].chord(B(22, i * 0.5), 0.12, 'B4 D#5', 108 + i * 2)
    roll(b, B(22, 2), B(23) - 0.02, 60, 124)
    # two layers: theme B
    for i, (c, notes) in enumerate(THEME_B):
        bar = 23 + i
        groove(b, B(bar), c, vel=110)
        melody(b, B(bar), notes, [('tpt', 0)], vel=120)
        b['hn'].chord(B(bar), BAR * 0.97, CHORDS[c][2], 100)
        b['vln'].chord(B(bar), BAR * 0.97, [k + 12 for k in ns(CHORDS[c][2])[1:3]], 96)
        if i in (0, 2):
            b['cym'].note(B(bar), 2, 60, 120)
    # collaboration evolves: theme A returns, lighter
    for i in range(3):
        c, notes = THEME_A[i]
        groove(b, B(27 + i), c, vel=100, low_brass=i > 0)
        melody(b, B(27 + i), notes, [('hn', 0), ('vln', 12)], vel=110)
    # control: one hit per hexagon, then the banner on the dominant
    for k, c in enumerate(['Em', 'C', 'D', 'B']):
        hit(b, B(30, k), c, 110 + k * 4, 0.25, cym=(k == 0))
    _pad(b, B(31), BAR, 'B', 112)
    b['hn'].ramp(B(31), B(32), 11, 60, 127)
    roll(b, B(31), B(32) - 0.02, 50, 118, timp='B2')
    # interface: breakdown, then build into the montage
    groove(b, B(32), 'Em', vel=88, strings=False, low_brass=False)
    groove(b, B(33), 'Em', vel=92, low_brass=False)
    b['tbn'].chord(B(34), BAR, 'E2 B2', 110).ramp(B(34), B(35), 11, 30, 127)
    b['trem'].chord(B(34), BAR, 'E5 B5', 100).ramp(B(34), B(35), 11, 30, 127)
    roll(b, B(34), B(35) - 0.02, 30, 126, timp='E3')
    b['cymroll'].note(B(34, 0.8), 1, 60, 124)
    # montage: theme A tutti
    for i, (c, notes) in enumerate(THEME_A):
        bar = 35 + i
        groove(b, B(bar), c, vel=116)
        melody(b, B(bar), notes, [('tpt', 0), ('hn', 0), ('tbn', -12), ('vln', 12)], vel=124)
        if i % 2 == 0:
            b['cym'].note(B(bar), 2, 60, 124)
    # finale: a solo horn over low strings, a swell, HUMAN., ♭VI – ♭VII – I
    b['vc'].chord(B(43), 2 * BAR, 'E2 B2', 64)
    b['cb'].note(B(43), 2 * BAR, 'E1', 66)
    b['hn'].note(B(43), 2 * BEAT, 'E4', 86).note(B(43, 2), 2 * BEAT, 'B4', 86)
    b['hn'].chord(B(44), BAR, 'E3 G3 C4', 80).ramp(B(44), B(45), 11, 40, 120)
    b['vln'].chord(B(44), BAR, 'E4 G4 C5', 64)
    roll(b, B(44, 2), B(45) - 0.02, 30, 112, timp='E3')
    hit(b, B(45), 'Em', 127, 0.5, cym=True, gong=True)
    _pad(b, B(46), BAR, 'C', 104)
    _pad(b, B(47), BAR, 'D', 108)
    b['hn'].ramp(B(47), B(48), 11, 70, 127)
    roll(b, B(47, 2), B(48) - 0.02, 50, 124, timp='D3')
    final(b, B(48), 'E', hold=4.6)
    # release card: a quiet E major
    b['hn'].chord(B(52), 1.5 * BAR, 'E3 G#3 B3', 78)
    b['vln'].chord(B(52), 1.5 * BAR, 'G#4 B4 E5', 70)
    b['cb'].note(B(52), 1.5 * BAR, 'E1', 80)
    b['timp'].note(B(52), 0.5, 'E3', 70)
    gates = [(B(11), B(11, 2), -60, {'violins-trem', 'cym-roll'}),
             (B(43), B(45), -40, {'celli', 'basses', 'horns', 'violins', 'timpani', 'snare', 'ui', 'sub'})]
    curve = [(0, -14), (B(2), -5), (B(6) - .05, -5), (B(6), -9), (B(8), -6), (B(10), -2), (B(12), -3), (B(20), -2), (B(23), -1.5),
             (B(27), -4), (B(30), -2), (B(32), -8), (B(34), -4), (B(35), 0), (B(43) - .05, 0), (B(43), -12), (B(44), -10), (B(45) - .05, -6), (B(45), 0), (B(46), -3), (B(48), 0), (B(52), -6)]
    return mix(list(b.values()) + common_sfx(), LEN, master=_master(), fade_out=2.5, gates=gates,
               master_gates=[(B(11) + 0.01, B(11, 2) - 0.2, -10, ()), (B(43) + 0.02, B(44) - 0.1, -7, ())], curve=curve, **MIXFX)


# ═════════════════════ 补完 ═════════════════════
CB = 2 * BEAT  # one chorale beat = half a march bar = 0.8 s
PHRASE_A = CHORALE[0] + CHORALE[1]
PHRASE_B = CHORALE[2] + CHORALE[3]
PHRASE_C = CHORALE[4] + CHORALE[5]
PHRASE_D = CHORALE[6]
FINAL = CHORALE[7][0]


def _lay(b, t0, seq, vel, choir=True):
    k = 0
    while k < len(seq):
        if seq[k] is None:
            k += 1
            continue
        span = 1
        while k + span < len(seq) and seq[k + span] is None:
            span += 1
        _voice(b, t0 + k * CB, span * CB - 0.03, seq[k], vel, choir=choir)
        k += span


def _harp(b, t0, seq, vel=90):
    """Baroque sixteenths over each chorale beat's alto / tenor / soprano."""
    s16 = CB / 4
    for k, satb in enumerate(seq):
        if satb is None:
            continue
        s, a, tn, _ = ns(satb)
        for i, key in enumerate([tn, a, s, a]):
            b['harp'].note(t0 + k * CB + i * s16, s16 * 0.9, key, vel)


def film_choral():
    b = _choral_band()
    b['solo'] = Track('solo', 52, bank=1, gain=1.2, send=0.6)
    # boot: organ pedal and tolling bell
    b['organ'].note(B(0), 2 * BAR, 'D2', 100)
    b['organ'].ramp(B(0), B(2), 11, 20, 110)
    b['cbell'].note(B(0), 2.5, 'D4', 96).note(B(1), 2.5, 'D4', 100)
    # the seven intertitles: one chord each
    cards = ['A4 F4 D4 D3', 'Bb4 F4 D4 Bb2', 'Bb4 G4 D4 G2', 'A4 E4 C#4 A2', 'A4 F4 D4 D3', 'C5 A4 F4 F2', 'C5 G4 E4 C3']
    for i, satb in enumerate(cards):
        _voice(b, B(2 + i * 0.5), CB - 0.03, satb, 100 + i * 3, choir=i >= 4)
        b['timp'].note(B(2 + i * 0.5), 0.3, 'D2' if i % 2 == 0 else 'A1', 96)
    for i, k in enumerate(ns('D3 F3 A3 D4 F4 A4 D5 F5 A5 D6 A5 F5 D5 A4 F4 D4')):
        b['harp'].note(B(5, 2) + i * 0.05, 0.05, k, 100)
    # years and half: the first phrase, the choir joins halfway
    _lay(b, B(6), PHRASE_A[:4], 88, choir=False)
    _lay(b, B(8), PHRASE_A[4:], 94)
    # 人类？: a single voice
    b['solo'].note(B(10) + 0.02, BAR + 0.1, 'A5', 96)
    # EPISODE card silent, then the title chord
    b['sfx'].add(B(11, 2) - 0.5, reverse(noise(0.5, hp=4000, decay=0.2)), 0.5)
    b['organ2'].chord(B(11, 2), 1.5 * BAR - 0.03, 'D2 D3 A3 D4 F4 A4 D5', 116)
    _voice(b, B(11, 2), 1.5 * BAR - 0.03, 'F5 A4 D4 D2', 116)
    b['cbell'].note(B(11, 2), 2.5, 'D4', 112)
    b['perc'].note(B(11, 2), 3.0, KIT['cym'], 110)
    for i in range(20):
        b['timp'].note(B(11, 2) + i * 0.06, 0.06, 'D2', int(116 - i * 3))
    # two sides → memory: phrases B and A
    _lay(b, B(13), PHRASE_B, 96)
    _lay(b, B(17), PHRASE_A[:6], 100)
    # MAGI: harpsichord over a dominant pedal; the bell at the second proposal
    b['organ'].note(B(20), 3 * BAR, 'A2', 104)
    b['strings'].chord(B(20), 3 * BAR, 'A3 E4', 96).ramp(B(20), B(23), 11, 70, 125)
    magi_seq = ['A4 E4 C#4 A2', 'A4 F4 D4 D3', 'G4 E4 C#4 A2', 'A4 E4 C#4 A2', 'Bb4 F4 D4 Bb2', 'A4 E4 C#4 A2']
    _harp(b, B(20), magi_seq, 96)
    for t in (MG + .5, MG + .6, MG + .7):
        b['organ'].chord(t, 0.08, 'A4 C#5 E5', 108)
    b['cbell'].note(R2, 2.5, 'D4', 118)
    b['organ2'].chord(R2, 0.6, 'Bb3 D4 F4 A4', 118)
    b['perc'].note(R2, 2.0, KIT['cym'], 112)
    for t in (R2 + .35, R2 + .47, R2 + .59):
        b['organ'].chord(t, 0.08, 'Bb4 D5', 110)
    for bar in (20, 21, 22):
        b['timp'].note(B(bar), 0.4, 'A1', 100 + (bar - 20) * 8)
    # two layers: the D major phrase, harpsichord running underneath
    _lay(b, B(23), PHRASE_C, 104)
    _harp(b, B(23), PHRASE_C, 88)
    b['perc'].note(B(25), 2.0, KIT['cym'], 104)
    # collaboration evolves: the cadence phrase, then D major
    _lay(b, B(27), PHRASE_D, 104)
    _harp(b, B(27), PHRASE_D, 88)
    _voice(b, B(29), CB * 2 - 0.03, 'D5 A4 F#4 D3', 104)
    # control: a chord per hexagon, the banner on the dominant
    for k, satb in enumerate(['D5 A4 F#4 D3', 'D5 B4 G4 G2', 'E5 A4 C#4 A2', 'F#5 A4 D4 D3']):
        _voice(b, B(30, k), BEAT - 0.03, satb, 108 + k * 3)
        b['timp'].note(B(30, k), 0.3, 'D2' if k % 2 == 0 else 'A1', 100)
    _voice(b, B(31), BAR - 0.03, 'E5 A4 C#4 A2', 112)
    b['choir'].ramp(B(31), B(32), 11, 60, 127)
    for i in range(24):
        b['timp'].note(B(31) + i * 0.066, 0.06, 'A1', int(60 + i * 2.5))
    # interface: almost nothing — one voice and the organ, pianissimo
    b['organ'].chord(B(32), 3 * BAR - 0.2, 'D3 A3 D4', 70)
    b['solo'].note(B(32), BAR * 1.5, 'D5', 80).note(B(33, 2), BAR * 0.5, 'C#5', 84).note(B(34), BAR, 'D5', 92)
    b['cbell'].note(B(34), 2.5, 'A3', 96)
    b['strings'].chord(B(34), BAR, 'D3 A3 F4', 80).ramp(B(34), B(35), 11, 30, 125)
    b['sfx'].add(B(35) - 0.6, reverse(noise(0.6, hp=3500, decay=0.25)), 0.5)
    # montage: the chorale fortissimo, full organ, harpsichord and timpani
    _lay(b, B(35), PHRASE_A + PHRASE_B, 118)
    _harp(b, B(35), PHRASE_A + PHRASE_B, 100)
    for k, satb in enumerate(PHRASE_A + PHRASE_B):
        if satb:
            b['organ2'].note(B(35) + k * CB, CB - 0.03, ns(satb)[3] - 12, 110)
    for bar in range(35, 43):
        b['timp'].note(B(bar), 0.4, 'D2' if bar % 2 else 'A1', 110)
    b['perc'].note(B(35), 3.0, KIT['cym'], 118).note(B(39), 3.0, KIT['cym'], 118)
    # finale: quiet, HUMAN. on the dominant, the cadence, D major
    b['organ'].chord(B(43), 2 * BAR - 0.05, 'A3 D4 F4', 76)
    b['solo'].note(B(43, 1), 1.5 * BAR, 'A5', 86)
    b['strings'].chord(B(44), BAR, 'D3 A3', 70).ramp(B(44), B(45), 11, 40, 120)
    b['organ2'].chord(B(45), BAR - 0.03, 'A2 E3 A3 C#4 E4 A4', 118)
    _voice(b, B(45), BAR - 0.03, 'E5 A4 C#4 A2', 116)
    b['cbell'].note(B(45), 2.5, 'A3', 116)
    b['perc'].note(B(45), 2.5, KIT['cym'], 112)
    _lay(b, B(46), PHRASE_D, 112)
    b['organ2'].chord(B(48), 4.6, 'D2 D3 A3 D4 F#4 A4 D5', 118)
    _voice(b, B(48), 4.6, FINAL, 120)
    b['choir'].note(B(48), 4.6, 'D5', 116)
    b['cbell'].note(B(48), 5, 'D4', 118).note(B(48) + 1.6, 4, 'A3', 100)
    for i in range(34):
        b['timp'].note(B(48) + i * 0.07, 0.07, 'D2', int(118 - i * 2.4))
    b['perc'].note(B(48), 4.0, KIT['cym'], 116)
    # release card: a quiet D major and one bell
    b['organ'].chord(B(52), 1.5 * BAR, 'D3 A3 F#4', 72)
    b['cbell'].note(B(52), 3, 'D5', 84)
    gates = [(B(10), B(11), -60, {'solo'}), (B(11), B(11, 2), -60, {'sfx'})]
    curve = [(0, -12), (B(2), -5), (B(6), -8), (B(10), -3), (B(11, 2), 0), (B(13), -4), (B(20), -2.5), (B(23), -2), (B(32), -9),
             (B(35) - .05, -6), (B(35), 0), (B(43) - .05, 0), (B(43), -9), (B(45), -1), (B(46), -2), (B(48), 0), (B(52), -6)]
    return mix(list(b.values()) + common_sfx(), LEN, fade_out=2.5, gates=gates, master_gates=[(B(11) + 0.01, B(11, 2) - 0.2, -12, ())],
               curve=curve, reverb=Reverb(room_size=0.92, damping=0.3, wet_level=1.0, dry_level=0.0, width=1.0))


def match_loudness(x, target_db=-13.5):
    """Bring both scores to the same average level so they compare fairly; a limiter keeps the peaks under -1 dBFS."""
    from pedalboard import Pedalboard, Limiter
    rms = 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-12)
    y = x * 10 ** ((target_db - rms) / 20)
    y = Pedalboard([Limiter(threshold_db=-1.2, release_ms=120)])(y.T.copy(), 48000).T
    return (y / max(1.0, np.abs(y).max() / 10 ** (-1 / 20))).astype(np.float32)


if __name__ == '__main__':
    out = os.path.join(HERE, '..', 'out', 'audio')
    os.makedirs(out, exist_ok=True)
    for name in (sys.argv[1:] or ['battle', 'choral']):
        x = match_loudness({'battle': film_battle, 'choral': film_choral}[name]())
        sf.write(os.path.join(out, f'film-{name}.wav'), x, 48000, subtype='PCM_24')
        print(f'film-{name}: {len(x) / 48000:.1f}s')
