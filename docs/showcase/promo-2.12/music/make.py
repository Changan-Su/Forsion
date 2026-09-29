"""Render every direction: out/audio/<id>-cue.wav (6.5 s, synced to study B) and <id>-full.wav (~30 s)."""
import os, sys, time
import soundfile as sf
from pieces import DIRECTIONS

out = os.path.join(os.path.dirname(__file__), '..', 'out', 'audio')
os.makedirs(out, exist_ok=True)
for key in (sys.argv[1:] or DIRECTIONS):
    title, cue, full = DIRECTIONS[key]
    for kind, fn in (('cue', cue), ('full', full)):
        t = time.time()
        x = fn()
        sf.write(os.path.join(out, f'{key}-{kind}.wav'), x, 48000, subtype='PCM_24')
        print(f'{key}-{kind}: {len(x) / 48000:.1f}s  ({time.time() - t:.1f}s)')
