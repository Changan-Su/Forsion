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
