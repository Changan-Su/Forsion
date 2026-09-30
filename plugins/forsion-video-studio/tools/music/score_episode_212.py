"""The score of 第 2.12 话 (examples/episode-2.12): 决战 II, a sampled battle march at 150 BPM, E minor → E major.

A worked example of scoring against a Forsion Video Studio cue sheet. Every accent is placed on a time
read from the project: H(scene) gives a scene's hits in seconds, SEC[scene] its start and end. Bars in
B(bar, beat) are counted from the boot scene (the warning card before it is silent).

    python3 score_episode_212.py path/to/episode-2.12.fvs.md [--out audio/episode-2.12-score.mp3]
    node ../fvs.mjs sync path/to/episode-2.12.fvs.md        # then check the hits land on accents
"""
import os
import sys
from pedalboard import HighpassFilter
import battle
from battle import band, groove, melody, hit, knock, pad, roll, final, THEME_A, THEME_B, CHORDS, master_chain, MIXFX, match_loudness
from engine import Audio, mix, n, ns, boom, beep
from cues import Cues, write_audio

PROJECT = next((a for a in sys.argv[1:] if not a.startswith('--')), None)
if not PROJECT:
    sys.exit(__doc__)
C = Cues.load(PROJECT)
battle.set_tempo(C.bpm)
BEAT, BAR, LEN = C.beat, C.bar, C.length
LEAD = round(C.t0('boot') / BAR)
SEC = {s['id']: (s['t0'], s['t1']) for s in C.scenes}


def H(scene):
    """The picture's hit points in a scene, in seconds."""
    return C.hits(scene)


def B(bar, beat=0.0):
    return C.at(bar + LEAD, beat)


def common_sfx():
    """Interface sounds: boot beeps, HUMAN.md update chirps, sub hits on the big reveals."""
    ui = Audio('ui', gain=0.3, send=0.15, fx=[HighpassFilter(300)])
    for i in range(7):
        ui.add(SEC['boot'][0] + 0.12 + i * 0.36, beep(1760 if i < 6 else 740, 0.05 if i < 6 else 0.18, shape='sine' if i < 6 else 'square'), 0.5 if i < 6 else 0.7)
    for t in H('evolve')[1::2]:  # HUMAN.md UPDATED
        ui.add(t, beep(2093, 0.06), 0.5)
        ui.add(t + BEAT / 4, beep(2637, 0.06), 0.45)
    sub = Audio('sub', gain=0.55, send=0.05)
    for t in (SEC['question'][0], B(11, 2), SEC['finale'][0] + 2 * BAR, SEC['finale'][0] + 5 * BAR):
        sub.add(t, boom(2.5, 100, 28, 0.35, 0.9, 1.8), 0.8)
    return [ui, sub]


def score():
    b = band()
    # boot: a roll and a low pedal out of silence
    roll(b, B(0), B(2) - 0.02, 12, 96, timp='E3')
    b['tbn'].chord(B(0), 2 * BAR, 'E2 B2', 100).ramp(B(0), B(2), 11, 10, 110)
    b['tuba'].note(B(0), 2 * BAR, 'E1', 100)
    b['cb'].note(B(0), 2 * BAR, 'E1', 100)
    b['trem'].chord(B(0), 2 * BAR, 'E4 B4', 90).ramp(B(0), B(2), 11, 15, 110)
    # the seven intertitles, one stab each; the ticker gets a roll
    cards = H('cards')
    for i, c in enumerate(['Em', 'C', 'A', 'B', 'Em', 'C', 'D']):
        hit(b, cards[i], c, vel=104 + i * 3, dur=0.3, cym=(i == 0))
    roll(b, cards[7], SEC['cards'][1] - BEAT / 4, 60, 118, timp='E3')
    # years: low and held, a timpani stroke under each line
    b['vc'].chord(B(6), 2 * BAR, 'E2 B2', 84)
    b['cb'].note(B(6), 2 * BAR, 'E1', 88)
    b['hn'].chord(B(6), BAR, 'E3 G3 B3', 74).chord(B(7), BAR, 'E3 G3 C4', 78)
    for k, t in enumerate(H('years')):
        b['timp'].note(t, 0.3, 'E3', 100 if k == 0 else 86)
    # half: the groove enters
    groove(b, B(8), 'Em', vel=92, low_brass=False)
    groove(b, B(9), 'Em', vel=98)
    b['cym'].note(H('half')[0], 2, 60, 100)
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
    # two sides, HUMAN.md: a stab on each card; the lines inside land on the groove's low hits
    knock(b, H('twosides')[0], 'C', 116, cym=True)
    knock(b, H('humanmd')[0], 'A', 118, cym=True)
    # the five questions: a stab per card (3 + 3 + 3 + 3 + 4 eighths across Em | F)
    for t in H('asks'):
        knock(b, t, 'Em' if t < B(17) else 'F', 116, cym=(t == H('asks')[0]))
    # MEMORY, then HUMAN.md
    b['cym'].note(H('memory')[0], 2, 60, 104)
    hit(b, H('memory')[1], 'Em', 120, 0.3, cym=True)
    # MAGI round 1: bright C, the panels approve one by one, the owner lands
    mg = H('magi')
    groove(b, B(20), 'C', vel=108)
    b['cym'].note(mg[0], 2, 60, 116)
    for i in range(3):
        b['tpt'].chord(mg[1] + i * BEAT / 4, 0.08, 'E5 G5', 116)
    knock(b, mg[2], 'C', 112)
    # round 2: the clash, the handover, alarm trumpets on the dominant
    hit(b, mg[3], 'F', 122, 0.3, cym=True)
    b['cb'].note(mg[3], 0.3, 'E1', 122)
    groove(b, B(21), 'B', vel=112, low_brass=False)
    for i in range(3):
        b['tpt'].chord(mg[4] + i * BEAT / 4, 0.08, 'F5 B5', 120)
    knock(b, mg[5], 'B', 120)
    groove(b, B(22), 'B', vel=114)
    for i in range(8):
        b['tpt'].chord(B(22, i * 0.5), 0.12, 'B4 D#5', 108 + i * 2)
    roll(b, B(22, 2), B(23) - BEAT / 4, 60, 124)
    # two layers: theme B; each layer's caption gets a stroke
    for i, (c, notes) in enumerate(THEME_B):
        bar = 23 + i
        groove(b, B(bar), c, vel=110)
        melody(b, B(bar), notes, [('tpt', 0)], vel=120)
        b['hn'].chord(B(bar), BAR * 0.97, CHORDS[c][2], 100)
        b['vln'].chord(B(bar), BAR * 0.97, [k + 12 for k in ns(CHORDS[c][2])[1:3]], 96)
        if i in (0, 2):
            b['cym'].note(B(bar), 2, 60, 120)
    lh = H('layers')
    for t, c in ((lh[6], 'D'), (lh[12], 'B')):
        b['timp'].note(t, 0.4, n(CHORDS[c][0]) + 24, 116)
        b['bd'].note(t, 0.3, 60, 116)
        b['cym'].note(t, 1.5, 60, 96)
    # collaboration evolves: theme A returns, lighter; a crash on the first quote
    for i in range(3):
        c, notes = THEME_A[i]
        groove(b, B(27 + i), c, vel=100, low_brass=i > 0)
        melody(b, B(27 + i), notes, [('hn', 0), ('vln', 12)], vel=110)
    for t in H('evolve')[0::2]:  # a crash on each quote
        b['cym'].note(t, 2, 60, 106)
    for t in H('evolve')[1::2]:
        b['timp'].note(t, 0.3, 'B3', 96)
    # control: one hit per intertitle, then the banner on the dominant
    ct = H('control')
    for k, c in enumerate(['Em', 'C', 'D', 'B']):
        hit(b, ct[k], c, 110 + k * 4, 0.25, cym=(k == 0))
    pad(b, ct[4], BAR, 'B', 112)
    b['cym'].note(ct[4], 2, 60, 118)
    b['hn'].ramp(ct[4], B(32), 11, 60, 127)
    roll(b, ct[4] + BEAT, B(32) - BEAT / 4, 50, 118, timp='B2')
    # interface: breakdown under the two cards, then build into the montage from the field
    it = H('interface')
    groove(b, B(32), 'Em', vel=88, strings=False, low_brass=False)
    groove(b, B(33), 'Em', vel=92, low_brass=False)
    hit(b, it[0], 'Em', 118, 0.3)
    for t in it[:2]:
        b['timp'].note(t, 0.5, 'E3', 118)
        b['bd'].note(t, 0.5, 60, 120)
        b['cb'].note(t, 0.3, 'E1', 118)
    hit(b, it[2], 'Em', 116, 0.3, cym=True)
    b['tbn'].chord(B(34), BAR, 'E2 B2', 110).ramp(B(34), B(35), 11, 30, 127)
    b['trem'].chord(B(34), BAR, 'E5 B5', 100).ramp(B(34), B(35), 11, 30, 127)
    roll(b, B(34) + BEAT, B(35) - BEAT / 4, 30, 126, timp='E3')
    b['cymroll'].note(B(34, 0.8), 1, 60, 124)
    # montage: theme A tutti, a crash on every new screen
    for i, (c, notes) in enumerate(THEME_A):
        bar = 35 + i
        groove(b, B(bar), c, vel=116)
        melody(b, B(bar), notes, [('tpt', 0), ('hn', 0), ('tbn', -12), ('vln', 12)], vel=124)
    mo = H('montage')
    for k in (0, 3, 4, 5, 9, 10):
        bar = round((mo[k] - B(35)) / BAR)
        hit(b, mo[k], THEME_A[bar][0], 124, 0.2, cym=True)
    # finale: a solo horn over low strings, a swell, HUMAN., ♭VI – ♭VII – I
    b['vc'].chord(B(43), 2 * BAR, 'E2 B2', 64)
    b['cb'].note(B(43), 2 * BAR, 'E1', 66)
    b['hn'].note(B(43), 2 * BEAT, 'E4', 86).note(B(43, 2), 2 * BEAT, 'B4', 86)
    b['timp'].note(B(44), 0.5, 'E3', 70)
    b['hn'].chord(B(44), BAR, 'E3 G3 C4', 80).ramp(B(44), B(45), 11, 40, 120)
    b['vln'].chord(B(44), BAR, 'E4 G4 C5', 64)
    roll(b, B(44, 2), B(45) - BEAT / 4, 30, 112, timp='E3')
    hit(b, B(45), 'Em', 127, 0.5, cym=True, gong=True)
    pad(b, B(46), BAR, 'C', 104)
    b['cym'].note(B(46), 2, 60, 104)
    pad(b, B(47), BAR, 'D', 108)
    b['cym'].note(B(47), 2, 60, 108)
    b['hn'].ramp(B(47), B(48), 11, 70, 127)
    roll(b, B(47, 2), B(48) - BEAT / 4, 50, 124, timp='D3')
    final(b, B(48), 'E', hold=5.8)
    # release: a quiet E major while the logo draws, a lift when it fills, then the credit
    rl = H('release')
    b['hn'].chord(rl[0], 2 * BAR, 'E3 G#3 B3', 78)
    b['vln'].chord(rl[0], 2 * BAR, 'G#4 B4 E5', 70)
    b['cb'].note(rl[0], 2 * BAR, 'E1', 80)
    b['timp'].note(rl[0], 0.5, 'E3', 70)
    b['tpt'].chord(rl[1], BAR, 'G#4 B4 E5', 92)
    b['timp'].note(rl[1], 0.5, 'E3', 96)
    b['cym'].note(rl[1], 2, 60, 88)
    cr = H('credit')[0]
    b['hn'].chord(cr, 1.5 * BAR, 'E3 B3 E4', 70)
    b['cb'].note(cr, 0.3, 'E1', 90)
    b['timp'].note(cr, 0.5, 'E2', 84)
    gates = [(B(11), B(11, 2), -60, {'violins-trem', 'cym-roll'}),
             (B(43), B(45), -40, {'celli', 'basses', 'horns', 'violins', 'timpani', 'snare', 'ui', 'sub'})]
    curve = [(0, -14), (B(2), -5), (B(6) - .05, -5), (B(6), -9), (B(8), -6), (B(10), -2), (B(12), -3), (B(20), -2), (B(23), -1.5),
             (B(27), -4), (B(30), -2), (B(32) - .05, -1), (B(32), -3), (B(32) + .3, -9), (B(34), -4), (B(35), 0), (B(43) - .05, 0), (B(43), -12), (B(44), -10), (B(45) - .05, -6), (B(45), 0), (B(46), -3), (B(48), 0), (B(52), -6)]
    # a sixteenth of breath before the hits that land inside running music, so they read as cuts
    breaths = [(t - BEAT / 4, t, -8, ()) for t in H('asks') + ct[1:4] + it[:1] + [mo[k] for k in (3, 4, 5, 9, 10)]]
    return mix(list(b.values()) + common_sfx(), LEN, master=master_chain(), fade_out=2.5, gates=gates,
               master_gates=[(B(11) + 0.01, B(11, 2) - 0.2, -10, ()), (B(43) + 0.02, B(44) - 0.1, -7, ())] + breaths, curve=curve, **MIXFX)


if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else os.path.join(os.path.dirname(os.path.abspath(PROJECT)), 'audio', 'episode-2.12-score.mp3')
    x = match_loudness(score())
    print(f'{write_audio(x, out)} · {len(x) / 48000:.1f} s')
