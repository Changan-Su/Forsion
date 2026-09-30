# Forsion 2.12 宣传片画面小样

「人类补完计划 · Complete the Other Half.」三个 5 秒画面方向，用于先定视觉、再配音乐。

| 小样 | 方向 | 比例 |
| --- | --- | --- |
| A · 另一半 | 品牌奶油色与铜棕，一个被补完的圆：左半 Agent，右半 HUMAN.md | 16:9 |
| B · 第 2.12 话 | EVA 致敬：明朝体标题卡快切、NERV 式 HUD、三联审议面板与人机同步率 | 4:3 |
| C · 一次协作的进化 | 深色舞台上的 Forsion 界面：「协作说明已更新」卡片推进到 Agent 详情「协作」页 | 16:9 |

所有画面由 `index.src.html` 中的关键帧引擎驱动，每一帧只取决于时间 `t`，因此可以在浏览器里实时播放，也可以逐帧截图合成视频。Logo 与 Arioso、Aria、Recita 头像在构建时从仓库原件内联。

```bash
node build.mjs                      # → dist/index.html（可直接发布的播放页）与 dist/capture.html
NODE_PATH=$(npm root -g) FFMPEG=/path/to/ffmpeg node render.cjs a b c   # → out/*.mp4，1920×1080 / 1440×1080，30 fps
```

渲染需要本机安装 Noto Serif SC、Noto Sans SC、Inter、Instrument Serif、JetBrains Mono、Barlow Condensed（渲染时不访问 Google Fonts），以及带 libx264 的 ffmpeg。`dist/` 与 `out/` 不入库。

## 方向 B 配乐小样（`music/`）

四个配乐方向，都按 B 的剪辑点写：01 决战（管弦进行曲）、02 MAGI（电子悬疑）、03 补完（圣咏与管风琴）、04 彼此（萨克斯哀歌）。每个方向有 6.5 秒对位版（`cue`）和约 30 秒完整版（`full`）。旋律全部原创，音色来自 General MIDI 音色库 [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS)，只用来判断方向。

```bash
pip install --no-deps tinysoundfont && pip install pedalboard soundfile numpy scipy matplotlib
SF2=/path/to/GeneralUser-GS.sf2 python3 music/make.py        # → out/audio/<方向>-cue.wav / -full.wav
python3 music/analyze.py /tmp/spec out/audio/*.wav           # 声谱图 + 响度曲线，标出 B 的剪辑点
node render.cjs b --dur 6.5 && FFMPEG=/path/to/ffmpeg bash music/mux.sh   # → out/score/B-score-*.mp4 / *.mp3
node build.mjs                                               # → dist/music.html（画面与配乐同步的试听页）
```

发布试听页时，把 `out/score/*.mp3` 作为 `audio/` 目录下的附带文件一起发布。

### 05 决战 II（真实采样）

`music/battle.py` 按参考曲测出的风格参数写成：约 150 BPM、E 小调带多利亚 / 弗里几亚色彩、连续八分音符军鼓（重音在第 2 拍与第 4 拍后半拍）、低音 1 · 2 · 2& · 3& · 4& 重击、能量集中在 80–250 Hz。旋律与和声全部原创。乐器来自 [VSCO 2 CE](https://github.com/sgossner/VSCO-2-CE)（CC0），由 `music/sampler.py` 按音高、力度层和轮换挑选采样。

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/sgossner/VSCO-2-CE.git ~/vsco
# 在 ~/vsco 里执行 git sparse-checkout set，目录列表见 sampler.orchestra() 用到的各个文件夹
VSCO=~/vsco python3 music/make.py 5-battle && bash music/mux.sh 5-battle && node build.mjs
```

## 完整版（`film.src.html`）

《第 2.12 话 · 人类补完计划》，4:3，约 94 秒，配乐「决战 II」。片头是光敏性癫痫警告，片尾是特别版 Logo 与 Made By Forsion Video Studio。画面致敬 EVA：明朝体标题卡、NERV 式界面、MAGI 审议、人机同步率、AT 力场式的 Interface。六边形背景只留在系统检查和 MAGI 两处；其余界面画面的背景和标题栏上是 Forsion 的红色树形标志，放在 NERV 标志会出现的位置。关键帧引擎核心在 `stage-engine.js`，由 `build.mjs` 内联进各个页面。

画面和配乐共用一张剪辑点表 `film/cuesheet.json`：`sections` 是按 150 BPM 小节编号的段落，`hits` 是每段里画面切换的拍点（从段落开头算的拍数，最小到八分音符）。画面的每个切点都从 `hits` 读出，`music/film_scores.py` 在同一批拍点上写重音。`music/sync_check.py` 从渲染出的帧里找出切点，逐个报告离八分音符网格差几毫秒、配乐在那一帧的重音有多强。

```bash
node build.mjs                                               # → dist/film.html（播放页）与 dist/film-capture.html
NODE_PATH=$(npm root -g) node render.cjs film --workers 4 --frames-only   # → out/frames-film（2833 帧）
VSCO=~/vsco python3 music/film_scores.py                     # → out/audio/film-battle.wav
FFMPEG=/path/to/ffmpeg bash music/mux_film.sh                # → out/film/*.mp4（原尺寸与 720p 分享版）与播放页用的 MP3
python3 music/sync_check.py                                  # 检查画面切点与配乐重音的对位
```

特别版 Logo 在 `logo/special.svg`：Logo 的树形 F 换成片中的红色，去掉底板，直接融进黑色画面。`node build.mjs` 会从 `.github/assets/showcase/logo.svg` 填入树形路径并写出 `dist/logo-2.12-special.svg`；`NODE_PATH=$(npm root -g) node logo/render-logo.cjs` 输出黑底与透明底 PNG。

## 成为 Forsion Video Studio 工程

这部完整版已经移植成 Forsion Video Studio 的示例工程：[`plugins/forsion-video-studio/examples/episode-2.12`](../../../plugins/forsion-video-studio/examples/episode-2.12/episode-2.12.fvs.md)。同一部片子、同一张拍点表，写成一份可以在编辑器里改文字和时间线、让 AI 接着写的 `.fvs.md` 文件。用 `node plugins/forsion-video-studio/tools/fvs.mjs render` 渲染出的 2832 帧与这里 `render.cjs` 的输出逐像素一致；`tools/music/score_episode_212.py` 从工程的拍点表重新生成「决战 II」。
