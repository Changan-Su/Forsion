# Showcase assets / 展示素材

The README images in this folder come from one sample project, a neighborhood book fair, the same example the [forsion.net](https://forsion.net) home page walks through. / 本目录的 README 配图都来自同一个样例项目「筹办社区书展」，和 [forsion.net](https://forsion.net/zh/) 首页走的是同一个例子。

## Product screenshots / 产品截图

Six screenshots per language, taken from an isolated **v2.14.0** desktop build (`95f819ee`). `README.md` uses the `-en.png` set and `README.zh-CN.md` the set without a suffix; interface language, notes, file names, conversations and widgets follow the language. / 每种语言六张，拍自隔离运行的 **v2.14.0** 桌面构建（`95f819ee`）。`README.md` 用 `-en.png`，`README.zh-CN.md` 用不带后缀的一套；界面语言、笔记、文件名、对话和小组件都跟着语言换。

| Asset / 素材 | What it shows / 展示内容 |
| --- | --- |
| `home.png` / `home-en.png` | Home with widgets on both sides. / 主页两边的小组件。 |
| `answer-card.png` / `answer-card-en.png` | Tangu's answer with a card that works out the stall fee. / Tangu 的回答带一张算摊位费的卡。 |
| `dashboard.png` / `dashboard-en.png` | The book fair dashboard built from two tables. / 从两张表算出来的书展仪表盘。 |
| `muse-space.png` / `muse-space-en.png` | Muse's own Space. / 卜算子自己的 Space。 |
| `store.png` / `store-en.png` | The store window. / 商店窗口。 |
| `sandbox.png` / `sandbox-en.png` | A plugin Tangu wrote, running in a sandboxed Forsion. / Tangu 写的插件在沙箱里的 Forsion 跑起来。 |

The interface is real. Notes, conversations, widgets and Muse's brief and letters are seeded sample data served by a scripted backend in an isolated home folder; no model was called and no personal data was used. The store window shows the public store listing as it was on 2026-11-10, so plugins that describe themselves in Chinese appear that way in the English set too. Each window is 1280 × 800 and the screenshots are downscaled to 1600 px wide, with no crop, frame, matte or recoloring. / 界面是真的。笔记、对话、小组件、卜算子的简报和信是预置的样例数据，由脚本化的后端在隔离的 home 里提供；没有调用模型，没有个人数据。商店窗口是 2026-11-10 的公开商店列表，插件自己写的中文简介在英文那套里也照原样显示。窗口 1280 × 800，截图缩到 1600 宽，不裁边、不加框、不铺底、不调色。

## Header image / 首图

`hero-en-light.png`, `hero-en-dark.png`, `hero-zh-light.png` and `hero-zh-dark.png` are stills of the forsion.net first screen (the ASCII tree and the slogan) with the navigation and buttons hidden, in light and dark. The READMEs pick one through `<picture>` and `prefers-color-scheme`. `social-preview.png` is the same scene at 1280 × 640 for the repository's social preview, which is uploaded in the repository settings. / 四张 `hero-*.png` 是 forsion.net 首屏（ASCII 树和 Slogan）去掉顶栏与按钮后的静帧，分浅色和深色；README 用 `<picture>` 按 `prefers-color-scheme` 选一张。`social-preview.png` 是同一画面的 1280 × 640 版，在仓库设置里上传作为分享预览。

[manifest.json](manifest.json) records dimensions, SHA-256 hashes, the source build and the capture method for each asset. / 清单逐图记录尺寸、SHA-256、来源构建和拍法。

## Earlier set / 上一套

The v2.11 research-project screenshots were removed from this folder when the READMEs moved to the book fair; they remain in git history. [`docs/showcase/capture.cjs`](../../../docs/showcase/capture.cjs) still reproduces those scenes. / 换成书展之后，v2.11 研究项目那套截图已从本目录删除，留在 git 历史里；[`docs/showcase/capture.cjs`](../../../docs/showcase/capture.cjs) 仍能复现那几个场景。

Messaging and the boundaries of each claim: [中文](../../../docs/showcase/messaging.md) · [English](../../../docs/showcase/messaging.en.md).
