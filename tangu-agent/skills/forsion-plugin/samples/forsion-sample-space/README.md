# tangu-sample-space

Forsion Desktop **自定义 Space（数据配方）**模板 —— 一个文件就是一个 Space：`space.json`。

Space 是纯数据的布局配方（L0）：把**已注册的视图**组合成左/中/右三栏，装上后出现在左侧功能条顶部。它不含代码，所以随便分享、无信任问题。

## 快速开始（推荐路径：不用手写）

最省事的做法是在应用里摆好布局，命令面板（Cmd/Ctrl+K）→「**将当前布局另存为 Space**」——配方自动落到 `~/.forsion/spaces/<id>/space.json`，功能条立即出现图标（右键图标可删除）。然后打开该文件微调（改名、换图标、加 `version`）即可发布。

手动安装本模板：拷贝文件夹到 `~/.forsion/spaces/research-desk/`，重启或从市场装任一 space 触发重载（市场安装是免重启热注册的）。

## space.json 契约速查

- `id`：kebab-case（`/^[a-z0-9][a-z0-9-]{0,63}$/`），保留字 `tangu` / `inbox` / `amadeus` 不可用。
- `name`：字符串 或 `{ "zh": "…", "en": "…" }`。
- `icon`（可选）：白名单 26 个——`bot, inbox, mail, notebook-text, book-open, briefcase, calendar-days, message-circle, folder, folder-open, file-text, star, heart, home, target, zap, globe, music, image, video, code, terminal, layout-grid, sparkles, boxes, list-tree`；不认识的名字静默回落方块图标。
- `layout.main / left / right`：`{ "type": "<视图>", "params": {…} }` 数组；**main 至少一个视图**。
- `layout.main` 第二项起可加 `"split":"right"` 或 `"split":"down"`，建立宿主原生 Dockview 分栏；省略时仍与旧配方一样开成同组标签页。`split` 不可用于第一项或左右侧栏。
- 可用视图（随产品能力门禁）：通用 `workspace`（params.mode: sessions/files/notes/auto）、`outline`、`changelog`、`activity-log`；Tangu 对话档案 `chat`（params: followActive/reuseKey）、`memory`、`subchats`、`wechat`；Amadeus 档案 `amadeus-editor/-backlinks/-search/-tags/-graph`、`todo-list`、`calendar`；收件箱 `inbox-list`、`inbox-reader`；自动化档案 `automation-list`、`automation-runs`。绑定具体文件/会话的视图（`wsfile`、`amadeus-db/-drawing/-pdf`）是机器态，不进配方。引用了目标安装上未注册的视图会整包拒载（报「引用了未注册的视图」）。
- **插件视图也能组合**：桌面插件经 `ctx.registerView` 注册的视图，类型名固定为 `plugin:<插件id>:<视图id>`——配方可直接引用，记得在 `requires.views` 里声明，让没装该插件的安装尽早报清晰错误。
- 有意义的 params 只有 `workspace.mode` 与 `chat.followActive/reuseKey`——其余（sessionId、notePath 等）都是机器特定的，别写。
- `minAppVersion`（可选）：低于此版本的应用拒载。
- `version`（可选但**发布必填**）：解析器忽略它，但市场「可更新」检查读它。
- `requires.views`（可选）：显式声明依赖的视图，让不满足的安装尽早报清晰错误。

## 发布到 Forsion Market

把 `space.json` 打包成 zip（在 zip 根或单层文件夹内均可），个人中心 → 投稿 选「空间」；或推成 GitHub 公开仓。用户在 市场 → 空间 一键安装，功能条实时出现，免重启。

---

## English (short)

A Forsion Desktop custom Space is a single data file: `space.json` composing already-registered views into main/left/right panes. Easiest authoring path: arrange the layout in-app, then Command Palette → "Save current layout as Space", and hand-tune the emitted file. `layout.main` needs ≥1 view; later items may declare `"split":"right"` or `"split":"down"` for native Dockview splits (omission keeps tab behavior). Ids are kebab-case (`tangu`/`inbox`/`amadeus` reserved); include a top-level `version` so market update checks work.

MIT © Changan Su
