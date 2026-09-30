"""A first score for any Forsion Video Studio project with a tempo: the 决战 II march under the whole
timeline, a stab on every hit, a breath before hits that land inside running music, a final chord.

Copy it next to the project and make it yours: pick chords per scene, drop the groove where the picture
goes quiet, give the big cuts hit(..., cym=True, gong=True) and the small ones knock(). Keep melodies original.

    python3 score_template.py path/to/video.fvs.md [--out audio/score.mp3]
    node ../fvs.mjs sync path/to/video.fvs.md
"""
import math
import os
import sys
import battle
from battle import band, groove, melody, hit, knock, roll, final, THEME_A, master_chain, MIXFX, match_loudness
from engine import mix
from cues import Cues, write_audio

PROJECT = next((a for a in sys.argv[1:] if not a.startswith('--')), None)
if not PROJECT:
    sys.exit(__doc__)
C = Cues.load(PROJECT)
if not C.bpm:
    sys.exit('this project has no tempo; add "tempo": { "bpm": 120 } to its settings')
battle.set_tempo(C.bpm)
BEAT, BAR = C.beat, C.bar


def chord_at(t):
    """Theme A's harmony, one chord per bar, looping every eight bars."""
    return THEME_A[int(t // BAR) % len(THEME_A)][0]


def score():
    b = band()
    last = C.scenes[-1]
    end = last['t0']  # the last scene holds the final chord
    first = C.scenes[0]
    # an opening roll into the first bar line after the first scene
    roll(b, 0, min(first['t1'], 2 * BAR) - BEAT / 4, 20, 110, timp='E3')
    bars = math.ceil(end / BAR)
    for k in range(bars):
        t = k * BAR
        if t < first['t1']:
            continue
        chord, notes = THEME_A[k % len(THEME_A)]
        groove(b, t, chord, vel=104)
        if k % 16 >= 8:  # the melody in the second half of every sixteen bars
            melody(b, t, notes, [('hn', 0), ('tbn', -12)], vel=112)
    breaths = []
    for s in C.scenes:
        for i, t in enumerate(s['hitTimes']):
            if t >= end:
                continue
            if i == 0:
                hit(b, t, chord_at(t), vel=118, dur=0.25, cym=True)
            else:
                knock(b, t, chord_at(t), vel=112)
            if t > first['t1'] and (t % BAR) > 1e-6:
                breaths.append((t - BEAT / 4, t, -8, ()))
    final(b, end, 'E', hold=max(1.0, min(5.0, last['t1'] - end - .3)))
    return mix(list(b.values()), C.length, master=master_chain(), fade_out=min(2.0, (last['t1'] - end) / 2), master_gates=breaths, **MIXFX)


if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else os.path.join(os.path.dirname(os.path.abspath(PROJECT)), 'audio', 'score.mp3')
    x = match_loudness(score())
    print(f'{write_audio(x, out)} · {len(x) / 48000:.1f} s')
