# Showcase assets / 展示素材

These assets support the English and Chinese repository READMEs and the Forsion website. Product screenshots and demonstration data are described separately.

这些素材用于中英文 README 与官网展示。桌面截图和样例数据均在展示处注明，不表示所有界面来自同一个版本。

| Asset / 素材 | Source / 来源 |
| --- | --- |
| `workbench.png` | Unmodified desktop screenshot from `Forsion-Website/assets/screenshots/coding.png`, website source commit `632eae8`. / 原官网保留的真实桌面截图，展示智能体对话与赛车项目预览，未改动界面内容。 |
| `calendar.png` | Unmodified desktop screenshot from `Forsion-Website/assets/screenshots/calendar.png`, website source commit `632eae8`. / 原官网真实日历截图，未改动界面内容。 |
| `notes.png` | Production `UnifiedPage` renderer at Genesis source commit `172d9bae`, using the public fixture in `docs/showcase/note-sample.md`. / 真实笔记编辑器渲染的公开样例，使用内存桥；不是真实用户资料或一次 AI 执行的产出。 |
| `logo.svg` | Existing Forsion logo from `Forsion-Website/assets/Forsion-LOGO3.svg`. / 复用现有扶桑标志。 |
| `social-preview.png` | Browser export of `docs/showcase/social-preview.html` at 1280 × 640 pixels. / 分享封面源文件的浏览器截图导出。 |

For GitHub Social Preview, upload `social-preview.png` in the repository settings. The website uses the same image as `public/showcase-social.png`; Vite copies it to `/showcase-social.png`, outside the indefinitely cached asset directory.

GitHub 的 Social Preview 可使用 `social-preview.png`。官网使用相同图片，构建输出到 `/showcase-social.png`，避开带 immutable 缓存的资源目录，供 Open Graph 与 Twitter 分享卡片引用。

The proposed GitHub About text is: **Your local AI workbench. Bring agents, knowledge, and everyday work together.** Repository settings are not changed by this branch.

建议 GitHub About 简介：**Your local AI workbench. Bring agents, knowledge, and everyday work together.** 本分支提供文案与素材，仓库设置未修改。
