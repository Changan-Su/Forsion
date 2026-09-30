# Forsion Video Studio

AI 辅助的网页动画视频编辑器。Forsion 2.12 的宣传片就是用这套工具做的，现在它是一个插件。

一段视频就是一份 `.fvs.md` 工程文件：每个场景是一页网页（HTML + CSS，加一点关键帧脚本），场景首尾相接地排在时间线上，时间线踩在音乐的拍子上。每个场景写着自己的**拍点**，画面在拍点上切，配乐也在拍点上给重音。

- **手动编辑**：实时预览、播放；时间线上拖场景右边缘改长度，拖拍点改切点；双击画面里的文字直接改；右侧面板改场景设置、全部文字、代码和工程设置。撤销、重做、自动保存。
- **交给 AI**：「问 AI」「配乐」「导出 MP4」把任务交给内置的 **Video Studio 导演** Agent。它直接改这份文件，编辑器自动载入改动，而且可以撤销。文字面板里每一行都有「AI 改写」。
- **卡点检查**：编辑器分析配乐的重音，时间线上的拍点绿色表示落在重音上，黄色表示没有，蓝色表示切到安静。
- **导出**：「导出网页视频」立刻写出一个单文件 `.html`（素材和配乐都在里面，双击就能播放）；「导出 MP4」由导演 Agent 在本机渲染。
- **工程文件 AI 读得懂**：它就是 Markdown，里面是 JSON、HTML、CSS、JS 代码块。格式和场景 API 写在内置技能 `forsion-video-studio` 里。

## 开始

1. 命令面板「Video Studio：打开示例 · 第 2.12 话」：打开 2.12 宣传片的工程（94 秒，20 个场景），配乐会自动下载。
2. 文件树右键「新建视频工程」、命令面板「Video Studio：新建视频工程」，或在笔记里输入 `/` 选「新建视频工程」（会把视频嵌进笔记）。
3. 第一次打开别人给的工程时，编辑器会先问你是否运行它的脚本。预览跑在隔离的 iframe 里，碰不到你的笔记库和账号，但只打开你信任的工程。

导出 MP4 和配乐在你的电脑上运行，需要：

- **MP4**：Node 18+、Chrome 或 Edge（或 `npx playwright install chromium`）、`playwright-core`（`npm i -g playwright-core`）、ffmpeg。
- **配乐**：Python 3 和 `tools/music/requirements.txt` 里的包，外加 VSCO 2 CE 管弦乐采样（CC0，`python3 tools/music/fetch_samples.py` 下载）。

缺什么，导演 Agent 会先装好或者告诉你。

## 工程文件

````markdown
# 片名（随便写的说明文字，渲染时忽略）

```fvs
{ "fvs": 1, "title": "…", "width": 1920, "height": 1080, "fps": 30,
  "tempo": { "bpm": 120, "beatsPerBar": 4 }, "audio": [{ "src": "audio/score.mp3" }] }
```

```css
/* 全局样式 */
```

## cards · 标题卡

```fvs
{ "length": "2 bars", "hits": [0, 2, 4, 6] }
```

```html
<div data-seq="h0">            <!-- 子元素依次在第 0、1、2、3 个拍点出现 -->
  <div class="card">人格</div><div class="card">记忆</div><div class="card">技能</div><div class="card">工具</div>
</div>
```

```js
flash(hits[0], .6)            // 可选：关键帧脚本
```
````

完整说明见 [`skills/forsion-video-studio/SKILL.md`](skills/forsion-video-studio/SKILL.md)，完整示例见 [`examples/episode-2.12/episode-2.12.fvs.md`](examples/episode-2.12/episode-2.12.fvs.md)。

## 命令行

`tools/fvs.mjs` 是单个文件，不用安装：

```sh
node tools/fvs.mjs new my-video.fvs.md          # 从 EVA 标题卡模板开始
node tools/fvs.mjs info my-video.fvs.md         # 场景、时间、拍点
node tools/fvs.mjs check my-video.fvs.md --runtime
node tools/fvs.mjs sheet my-video.fvs.md        # 每个场景一帧的缩略图
node tools/fvs.mjs render my-video.fvs.md --out my-video.mp4
node tools/fvs.mjs sync my-video.fvs.md         # 拍点有没有落在配乐的重音上
node tools/fvs.mjs html my-video.fvs.md         # 单文件网页视频
```

## 包里有什么

```
forsion-video-studio/
├── manifest.json · main.js · icon.png      桌面插件：.fvs.md 编辑器、新建入口、笔记嵌入
├── runtime/fvs-runtime.js                  播放运行时：预览、网页导出和渲染都用它
├── tools/fvs.mjs                           命令行
├── tools/music/                            配乐工具包（Python）
├── skills/forsion-video-studio/SKILL.md    全局技能：格式、场景 API、工作流程
├── agents/fvs-director/                    Video Studio 导演 Agent
├── examples/episode-2.12/                  示例：第 2.12 话
├── src/                                    源码（main.js、runtime、tools/fvs.mjs 由它构建）
└── test/ · check.mjs
```

## 开发

```sh
npm install && npm run build      # src/ → main.js、runtime/fvs-runtime.js、tools/fvs.mjs
node check.mjs                    # 自检：宿主同构求值 main.js、单元测试、命令行跑示例
NODE_PATH=$(npm root -g) node test/studio.e2e.mjs   # 在 Chromium 里用模拟宿主把编辑器完整走一遍
```

装到本机：整个文件夹拷到 `~/.forsion/plugins/forsion-video-studio/`，重启 Forsion（Agent 和技能由引擎在启动时发现）。

---

## English

An AI-assisted editor for videos made of animated web pages; the Forsion 2.12 promo was made with it. A video
is one `.fvs.md` project file: scenes are web pages, they play back to back on a timeline that sits on the
music's beat grid, and each scene lists its **hits** — the picture cuts on them and the score accents them.

Edit by hand (live preview, drag scene edges and hits on the timeline, double-click text in the picture,
panels for scene settings, text, code and project), hand work to the bundled **Video Studio Director** agent
(write scenes, score, check sync, render MP4), and export a single-file web video or an MP4. The format and
the scene API are documented in the bundled skill; `examples/episode-2.12` is a complete project.
