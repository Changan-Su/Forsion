"""The cue sheet of a Forsion Video Studio project: scenes, tempo and hits, in seconds.

    from cues import Cues
    c = Cues.load('path/to/video.fvs.md')      # or a JSON file written by `fvs cues`
    c.bpm, c.beat, c.bar, c.length
    c.t0('cards'), c.t1('cards')               # scene start and end (s)
    c.hits('cards')                            # the scene's hits, absolute seconds
    c.at(bar, beat=0)                          # a point on the project's bar grid (bar 0 = t 0)
    for s in c.scenes: s['id'], s['t0'], s['t1'], s['hitTimes']

The picture cuts on these hits and the score should put its accents on the same times.
"""
import json
import os
import subprocess


class Cues:
    def __init__(self, data):
        self.data = data
        self.scenes = data['scenes']
        self.by_id = {s['id']: s for s in self.scenes}
        self.bpm = data.get('bpm')
        self.beats_per_bar = data.get('beatsPerBar') or 4
        self.beat = 60 / self.bpm if self.bpm else None
        self.bar = self.beat * self.beats_per_bar if self.bpm else None
        self.length = data['length']
        self.fps = data.get('fps', 30)
        self.audio = data.get('audio', [])

    @classmethod
    def load(cls, path):
        """A .fvs.md project (read through the fvs CLI next to this folder) or a cue sheet JSON."""
        if path.endswith('.json'):
            return cls(json.load(open(path, encoding='utf-8')))
        here = os.path.dirname(os.path.abspath(__file__))
        cli = next((p for p in (os.path.join(here, '..', 'fvs.mjs'), os.environ.get('FVS_CLI', '')) if p and os.path.exists(p)), None)
        if not cli:
            raise FileNotFoundError('fvs.mjs not found next to the music folder; pass a cue sheet JSON from `fvs cues` instead')
        out = subprocess.run(['node', cli, 'cues', path], capture_output=True, text=True, check=True).stdout
        return cls(json.loads(out))

    def scene(self, sid):
        if sid not in self.by_id:
            raise KeyError(f'no scene {sid!r}; scenes: {", ".join(self.by_id)}')
        return self.by_id[sid]

    def t0(self, sid):
        return self.scene(sid)['t0']

    def t1(self, sid):
        return self.scene(sid)['t1']

    def hits(self, sid):
        return list(self.scene(sid)['hitTimes'])

    def at(self, bar, beat=0.0):
        """Seconds at a bar (and beat) of the project's grid; bar 0 starts at 0 s."""
        if not self.bpm:
            raise ValueError('this project has no tempo')
        return (bar * self.beats_per_bar + beat) * self.beat

    def all_hits(self):
        return [(s['id'], i, t) for s in self.scenes for i, t in enumerate(s['hitTimes'])]


def write_audio(x, path, sr=48000):
    """WAV next to the project, plus an MP3 when ffmpeg is around (the Studio and the player like MP3)."""
    import soundfile as sf
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    wav = os.path.splitext(path)[0] + '.wav'
    sf.write(wav, x, sr, subtype='PCM_24')
    ff = os.environ.get('FFMPEG') or 'ffmpeg'
    mp3 = os.path.splitext(path)[0] + '.mp3'
    try:
        subprocess.run([ff, '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', mp3], check=True)
        return mp3
    except (OSError, subprocess.CalledProcessError):
        return wav
