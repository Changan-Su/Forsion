# Video Studio music toolkit

Scores for Forsion Video Studio projects, written in Python against the project's cue sheet: every
accent goes on a time the picture cuts on. Offline and deterministic; the result is a WAV (and an MP3
when ffmpeg is around) that you add to the project's `audio` list.

## Setup (once)

```sh
pip install -r requirements.txt          # numpy scipy soundfile pedalboard
python3 fetch_samples.py                  # VSCO 2 CE orchestra samples (CC0) into ~/vsco, needs git
```

`VSCO=/path` points the sampler at samples elsewhere; `FVS_CACHE` is where it keeps its analysis cache
(default `~/.cache/fvs/vsco`). The first run builds the cache and takes a minute or two.

## Files

| file | what it is |
|---|---|
| `cues.py` | `Cues.load(project)`: tempo, scene starts and ends, each scene's hits in seconds; `write_audio()` |
| `engine.py` | the mixer (`mix`: layers, gates, dynamic curve, reverb bus, master) and sound design (`boom`, `beep`, `riser`, `alarm`…) |
| `sampler.py` | `SampleTrack`: note/chord/ramp on recorded orchestra samples, with attack compensation so stabs land on the beat |
| `battle.py` | one style, 决战 II (a battle march): `band()`, `groove()`, `melody()`, `hit()`, `knock()`, `pad()`, `roll()`, `final()`, `set_tempo()` |
| `score_template.py` | a first score for any project with a tempo: groove throughout, a stab on every hit, a final chord |
| `score_episode_212.py` | the real score of the 2.12 example: how a finished score treats each scene |
| `fetch_samples.py` | downloads the samples |

## Workflow

1. `node ../fvs.mjs info <project>` — the scenes, their bars and hits.
2. Copy `score_template.py` next to the project (or start from `score_episode_212.py`) and write the score:
   one section per scene, reading `C.t0(id)`, `C.t1(id)` and `C.hits(id)`. Big cuts get `hit(..., cym=True)`,
   cuts inside a phrase get `knock()`, and a hit that falls inside running music gets a sixteenth of
   breath before it (`master_gates=[(t - BEAT / 4, t, -8, ())]`) so it reads as a cut.
3. `python3 score.py <project> --out <project dir>/audio/score.mp3`, then add it to the project settings:
   `"audio": [{ "src": "audio/score.mp3", "role": "score" }]`.
4. `node ../fvs.mjs sync <project>` — every hit should land on an accent (or on a drop to quiet).
   Fix misses in the score, or move a picture-only hit onto the accent.

Keep melodies original. A reference track can guide tempo, key, groove and balance; never its notes.
