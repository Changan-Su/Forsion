---
name: forsion-video-studio
description: Make and edit Forsion Video Studio videos — web-animation videos written as a single .fvs.md project file (HTML/CSS scenes, keyframes, a beat-grid timeline and a score). Use when the user asks for a promo, trailer, intro, title sequence, animated explainer or "a video like the 2.12 one", when a .fvs.md file is involved, or when asked to render, score, re-time or check the sync of such a video.
metadata:
  version: 0.1.0
  author: Forsion
  category: Forsion
---

# Forsion Video Studio

A video is **one Markdown file** (`*.fvs.md`). Scenes are web pages (HTML + CSS) animated by keyframes that
are a pure function of time; they play back to back on a timeline that sits on the music's beat grid.
The user edits the same file in the Video Studio editor (text, timing, code) and sees your edits live:
the editor reloads the file whenever it changes on disk.

Your jobs: write new projects and scenes, change pacing and copy, score the video, check that the picture
cuts land on the music, and render MP4s.

## Tools

The command line is one file, `fvs.mjs` (Node ≥ 18). The editor's hand-off message gives its absolute path.
Otherwise look for it in the vault at `<plugin work folder>/.fvs-tools/fvs.mjs`, or in the installed plugin:
`~/.forsion/plugins/forsion-video-studio/tools/fvs.mjs` (`~/.forsion-dev/…` for dev builds). The music
toolkit sits beside it in `music/` (read its README.md before scoring).

```
node fvs.mjs new <file.fvs.md> [--template eva|blank] [--title T]
node fvs.mjs info <project>                 # scenes, start/end, hits → READ THIS FIRST
node fvs.mjs check <project> --runtime      # parse errors + runs every scene script in a browser
node fvs.mjs sheet <project> [--every 2]    # contact sheet PNG (one frame per scene, or every N s) → look at it
node fvs.mjs still <project> --at cards:3   # one frame: seconds, a scene id, or scene:hit
node fvs.mjs cues <project>                 # the cue sheet JSON a score is written against
node fvs.mjs sync <project>                 # do the hits land on accents of the first audio track?
node fvs.mjs html <project>                 # standalone web-video player (.html)
node fvs.mjs render <project> --out x.mp4 [--workers 3] [--from s --to s] [--scale 0.5]
```

`still`, `sheet`, `render` and `check --runtime` need a Chromium: `npm i -g playwright-core` (or a local
install) plus Google Chrome or Microsoft Edge; the CLI also accepts `FVS_CHROMIUM=/path/to/chrome`, or run
`npx playwright install chromium`. `render` and `sync` need ffmpeg (`brew install ffmpeg`,
`winget install ffmpeg`, `apt install ffmpeg`, or `FFMPEG=/path`). Install what is missing yourself and say so.
After rendering, look at a few frames (`view_video` if you have it, or `still`) before reporting.

## The file format

````markdown
# Title (free prose — notes for people; ignored by the renderer)

```fvs
{
  "fvs": 1, "title": "…", "width": 1920, "height": 1080, "fps": 30,
  "tempo": { "bpm": 120, "beatsPerBar": 4 },
  "class": "my-film",                      // extra classes on the stage root
  "background": "#000",
  "fonts": ["https://fonts.googleapis.com/css2?family=…"],   // stylesheet URLs
  "audio": [{ "src": "audio/score.mp3", "role": "score", "at": 0, "gain": 0 }],
  "assets": ["assets/logo.png"]            // only files that scripts reference by string
}
```

```css
/* global stylesheet: scope rules under the stage class (.my-film …) */
```

```html stage
<!-- persistent layers; <div data-fvs-scenes></div> marks where the scenes go (default: at the bottom) -->
<div data-fvs-scenes></div>
<div class="grain"></div>
<div data-fvs-flash></div>     <!-- the runtime drives this layer from flash() calls -->
```

```js stage
// runs once after every scene is built; same API as a scene (root = the stage, t0 = 0, t1 = length)
grain('.grain')
```

## intro · 开场            ← one scene: "## <id> · <title>"; id = [A-Za-z][\w-]*

```fvs
{ "length": "2 bars", "hits": [0, 2, 4, 6], "class": "hud" }
```

```html
<!-- the scene's markup; its root is <div class="fvs-scene scene hud" data-scene="intro"> -->
```

```css
/* optional; scoped to this scene automatically (nested under [data-scene="intro"]) */
```

```js
// optional; the scene API below is in scope
```
````

- Scenes play **in document order, back to back**. A scene's start is the sum of the lengths before it.
- `length`: `"4 bars"`, `"6 beats"`, `"2.5s"` or a number of seconds. Bars and beats need `tempo`.
- `hits`: the scene's cut points, **in beats from the scene start** (seconds when there is no tempo).
  The picture cuts on them and the score accents them; `fvs cues` exports them. Keep them on the eighth-note
  grid (multiples of 0.5) unless there is a reason; 0.25 for sixteenth stabs.
- Everything outside the recognised blocks is kept byte for byte. Edit surgically: change the block you
  mean to change, keep the rest of the file exactly as it is (the user may be editing it too).
- Relative paths (`assets/…`, `audio/…`) resolve against the project file's folder.

## Scene API (in scope in every `js` block)

Times are **absolute seconds**. Selectors are strings scoped to the scene (or elements / arrays).

| name | meaning |
|---|---|
| `t0`, `t1`, `dur` | scene start, end, length |
| `hits` | the scene's hits in absolute seconds; `hit(i, beats=0)` = `hits[i]` plus an offset in beats |
| `beat`, `bar`, `at(n)` | seconds per beat / bar; `at(n)` = `t0 + n` beats |
| `root`, `stage`, `$`, `$$` | scene element, stage element, `querySelector`, `querySelectorAll` (array) |
| `K(sel, [[t, props, ease], …], {stagger})` | keyframes. props: `o` opacity, `x y z` px, `s sx sy` scale, `r rx ry` deg, `b` blur px, `br` brightness, `ct cr cb cl` clip inset %, `'--var'` any CSS custom property. Props carry forward. ease: `lin in out io expo back step` |
| `S(sel, a, b)` | shown (display) only in [a, b) — a hard cut |
| `seq(sel, times, end=t1)` | the i-th element is shown in [times[i], times[i+1]) |
| `cut(sel, t)` | hard cut in at t (opacity step) |
| `slide(sel, t, {x|y: px})` | cut in at t, then ease from the offset over 0.18 s |
| `fade(sel, t, d)` | fade in over d seconds |
| `type(sel, t, cps=30, gap=0)` | typewriter from t (gap = delay between elements) |
| `flash(t, strength=.85)` | white flash on the `data-fvs-flash` layer |
| `H(fn)` / `on(fn)` | a hook `fn(t)` run every frame — for canvas drawing, counters, blinking |
| `grain(sel)` | animated film grain on the selected layers |
| `prog(t, a, b, ease)`, `ease`, `clamp`, `lerp`, `rng(seed)` | helpers; `rng` is the only randomness allowed |
| `scenes` | every scene by id: `{ t0, t1, dur, hits, el }` (stage scripts use it for spans) |
| `during([...ids or [a, b]])`, `inside(t, spans)` | spans of scenes, membership test |
| `asset(path)`, `width`, `height`, `fps`, `length`, `project` | asset URL, stage size and settings |

**Declarative timing** (no script needed; the Studio edits these):

- `data-in="h2"` — appears at hit 2. Also `h2+0.5` / `h2-1` (beats), `2b` (beats from scene start), `1.5s`, `end-1`.
- `data-fx="cut|fade|up|down|left|right|pop|type"` with `data-dur` (beats), `data-dist` (px), `data-cps`.
- `data-out="h4"` — gone at hit 4 (`data-fx-out="fade"` to fade).
- `data-each="0.25"` on a container — apply the entrance to its children, 0.25 beats apart.
- `data-seq="h0"` on a container — its children show one after another on hits h0, h1, h2 … (last one to the scene end). The EVA intertitle pattern.

## Rules that keep a video renderable and editable

1. **Every frame is a pure function of t.** No `Date.now`, `setTimeout`, `requestAnimationFrame`, CSS
   `animation`/`transition`, video elements, `Math.random` or network in scripts. Use `K`, `H`, `rng`.
   The renderer seeks to each frame; anything time-based outside the API will stutter or freeze.
2. **Text lives in the HTML**, not in JS strings, so the user can edit it in the Studio (double-click in
   the picture, or the Text tab). Generate only geometry in JS (graph paths, grids).
3. **Cut on the hits.** Put visual changes on `hits` (declaratively or `hits[i]` in scripts); add or move
   hits in the scene settings rather than hard-coding times. Sub-beat stagger (`beat / 4`) is fine.
4. Scope global CSS under the project class; absolute-position layers inside a 1920×1080 (or project)
   frame in px. Fonts: add Google Fonts URLs to `fonts`; CJK needs a CJK family (Noto Sans/Serif SC).
5. Flashes and rapid cuts: if the video strobes, open with a photosensitivity warning scene.
6. After every edit: `check --runtime`, then look at `sheet`/`still` frames of what you changed.
   To show the user a project, call the UI command `fvs-open-project` with its vault path (if you have
   `run_ui_command`), or tell them the path.

## Workflows

**New video.** Ask for (or infer) the message, audience, length and look. `fvs new` from the `eva`
template (EVA-style intertitles, HUD panels) or `blank`, then write scenes: 1–4 bars each, a hit on every
change, text in HTML. Pick a tempo that suits the music you will write (120–160 BPM for cut-heavy promos).
Check, look at the contact sheet, iterate. Then score it.

**Change pacing.** Lengths and hits live in each scene's `fvs` block. Shortening a scene moves every later
scene earlier and breaks sync with an existing score; either re-score, or move the cut between two scenes
(shorten one, lengthen the next by the same amount) so later scenes stay put.

**Score.** Read `music/README.md`. `fvs cues`, then write a Python score from `music/score_template.py`
(or the worked example `score_episode_212.py`): accents on hits, bigger hits on scene starts, a
sixteenth of breath before hits inside running music. Write `audio/score.mp3` next to the project and add
it to `audio`. Run `fvs sync` and fix misses. Melodies must be original — a reference can guide style only.

**Sync check.** `fvs sync` lists hits without an accent. A hit on a drop to silence counts. For each miss,
move the picture-only hit onto the accent (nearest eighth) or change the score.

**Render.** `fvs render <project> --out <name>.mp4 --workers 3` (about real time ×5–10 on a laptop). Uses the
project's audio. For a quick preview use `--scale 0.5` or `--from/--to`.

The bundled example `examples/episode-2.12/episode-2.12.fvs.md` (the Forsion 2.12 promo, 94 s, 20 scenes) shows
every feature: declarative intertitles, HUD scenes with scripts, canvas hooks, backdrops in the stage script.
