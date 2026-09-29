"""Check that the picture cuts of the film land on accents of its score.

  python3 music/sync_check.py [frames_dir] [audio.wav] [--fps 30]

Picture cuts are frames whose change from the previous frame spikes above the frames around them (a
hard cut, a card, a flash), so steady animation does not count. For each cut the report gives
  grid:   distance to the nearest eighth note of the cue sheet grid (150 BPM: every 0.2 s, 6 frames)
  accent: the strongest onset of the score within one frame plus 30 ms, relative to the loudest
          onsets in the surrounding second (1.0 = as strong as the strongest there)
A cut into silence (the score drops by 6 dB or more on that frame) counts as on the music: the drop is
the accent. Other cuts are flagged when off the grid by more than a frame, or when the accent is weak (< 0.6).
"""
import glob
import os
import sys
import numpy as np
import librosa
from PIL import Image

HERE = os.path.dirname(__file__)
args = [a for a in sys.argv[1:] if not a.startswith('--')]
FRAMES = args[0] if args else os.path.join(HERE, '..', 'out', 'frames-film')
AUDIO = args[1] if len(args) > 1 else os.path.join(HERE, '..', 'out', 'audio', 'film-battle.wav')
FPS = 30
if '--fps' in sys.argv:
    FPS = float(sys.argv[sys.argv.index('--fps') + 1])
CUT = 6.0        # mean absolute change (0–255) that can count as a cut
SPIKE = 2.5      # ... and how far it must stand above the neighbouring frames
WEAK = 0.6       # accent below this share of the local maximum is flagged
GRID = 0.2       # eighth note at 150 BPM

files = sorted(glob.glob(os.path.join(FRAMES, '*.png')))
prev, diff = None, [0.0]
for f in files:
    x = np.asarray(Image.open(f).convert('L').resize((96, 72), Image.BILINEAR), np.float32)
    if prev is not None:
        diff.append(float(np.abs(x - prev).mean()))
    prev = x
diff = np.array(diff)


def spike(i):
    around = np.r_[diff[max(1, i - 4):i], diff[i + 1:i + 5]]
    return diff[i] >= CUT and diff[i] >= SPIKE * max(np.median(around), 1.0) and diff[i] >= diff[i - 1]


cuts = [i for i in range(1, len(diff)) if spike(i)]

y, sr = librosa.load(AUDIO, sr=44100, mono=True)


def level(a, b):
    return 20 * np.log10(np.sqrt((y[int(a * sr):int(b * sr)] ** 2).mean()) + 1e-9)


hop = 256
env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
env = env / (np.percentile(env, 95) + 1e-9)
t_env = librosa.frames_to_time(np.arange(len(env)), sr=sr, hop_length=hop)

rows, bad = [], []
for i in cuts:
    t = i / FPS
    g = t - round(t / GRID) * GRID
    m = (t_env >= t - 1 / FPS - 0.03) & (t_env <= t + 0.03)
    local = np.percentile(env[(t_env > t - 1) & (t_env < t + 1)], 99)
    a = float(env[m].max() / (local + 1e-9)) if m.any() else 0.0
    drop = level(t, t + .07) - level(t - .08, t - .01) <= -6
    flag = ('off grid ' if abs(g) > 1.01 / FPS else '') + ('weak accent' if a < WEAK and not drop else '')
    rows.append((t, diff[i], g, a, flag or ('cut to quiet' if drop else '')))
    if flag and flag != 'cut to quiet':
        bad.append(t)

for t, d, g, a, flag in rows:
    print(f"{t:7.2f}s  cut {d:5.1f}  grid {g * 1000:+5.0f} ms  accent {a:4.2f}  {('<< ' + flag) if flag and flag != 'cut to quiet' else flag}")
print(f"\n{len(rows)} cuts, {len(rows) - len(bad)} on the beat with an accent, {len(bad)} flagged: {', '.join(f'{t:.2f}' for t in bad)}")
