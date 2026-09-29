"""Spectrogram + loudness plots with study B's cut times marked (for checking without ears)."""
import sys, os
import numpy as np, soundfile as sf
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from pieces import CARDS, QUESTION, HUD, MAGI, WARN, EPISODE, TITLE
out = sys.argv[1]
for f in sys.argv[2:]:
    x, sr = sf.read(f); m = x.mean(1)
    fig, ax = plt.subplots(2, 1, figsize=(14, 6), sharex=True, gridspec_kw=dict(height_ratios=[2, 1]))
    ax[0].specgram(m, NFFT=2048, Fs=sr, noverlap=1536, cmap='magma', vmin=-120, vmax=-20)
    ax[0].set_ylim(20, 8000); ax[0].set_yscale('log'); ax[0].set_title(os.path.basename(f))
    w = int(0.02 * sr); rms = np.sqrt(np.convolve(m ** 2, np.ones(w) / w, 'same')); t = np.arange(len(m)) / sr
    ax[1].plot(t, 20 * np.log10(rms + 1e-9), lw=.8); ax[1].set_ylim(-70, 0); ax[1].grid(alpha=.3)
    if 'film' in f:
        import json
        cue = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'film', 'cuesheet.json')))
        bar = 60 / cue['bpm'] * cue['beatsPerBar']
        for sct in cue['sections']:
            for a in ax: a.axvline(sct['bar'] * bar, color='cyan', lw=.7, alpha=.8)
            ax[0].text(sct['bar'] * bar + .2, 6500, sct['id'], color='cyan', fontsize=7, rotation=90, va='top')
    if 'cue' in f:
        for c in CARDS + [QUESTION, HUD, EPISODE, TITLE] + MAGI:
            for a in ax: a.axvline(c, color='cyan', lw=.7, alpha=.8)
    fig.tight_layout(); fig.savefig(os.path.join(out, os.path.basename(f).replace('.wav', '.png')), dpi=70); plt.close(fig)
    print(os.path.basename(f), f'peak {20*np.log10(np.abs(x).max()):.1f} dBFS, rms {20*np.log10(np.sqrt((x**2).mean())):.1f} dB')
