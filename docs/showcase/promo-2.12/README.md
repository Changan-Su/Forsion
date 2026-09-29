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
