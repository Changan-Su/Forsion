---
name: forsion-extension-development
description: 当用户要给 Forsion / Tangu 做插件、主题、Space、智能体(agent)或捆绑包(bundle)——或要把某个能力做成可分发/可上架商店的扩展——时使用;已装的插件 / Space / 视图不出现、加载失败、更新后不工作要排查时也用(带一份插件体检脚本 tools/check-plugin.mjs)。内置五类官方模板(samples/),讲清各自的格式基线与硬约束(尤其两种"插件"是完全不同的系统),照抄模板改比从零写靠谱。
metadata:
  version: 1.139.0
  author: Forsion
  category: Forsion
---

# Forsion 扩展开发

扩展**默认按 bundle 发行**：一个 Forsion 插件目录内嵌 UI / 引擎插件 / Agent / 技能 / Space，后续追加其他层无需迁移。四类单体形态仍支持，纯数据主题或 Space 可单独发行。**先复制 `samples/` 中对应的官方模板再改。**

| 类型 | 是什么 | 模板 | 最小产物 |
|------|--------|------|----------|
| **捆绑包(默认起点)** | 一个 Forsion 插件内嵌引擎插件/Agent/技能/Space | `samples/forsion-sample-bundle/` | `manifest.json` + 约定子目录 |
| **引擎插件** | 给 agent 加工具 / 设置 / 提示片段 | `samples/forsion-sample-plugin/` | `tangu-plugin.json` + `dist/index.js` |
| **主题** | 换 UI 结构+配色(纯数据) | `samples/forsion-sample-theme/` | `theme.json` + `theme.css` |
| **Space** | 视图布局配方(纯数据) | `samples/forsion-sample-space/` | `space.json` |
| **智能体** | 预设人设+记忆+技能的 agent | `samples/forsion-sample-agent/` | `config.toml` + `SOUL.md` |

> ⚠️ "插件"有**两个互不相干的系统**,先分清用户要哪个:
> - **引擎插件**(本技能 `samples/forsion-sample-plugin`):后端/Agent 层,`tangu-plugin.json` + `activate(ctx)`,给模型加工具。
> - **Amadeus/Forsion 桌面插件**:UI 层,`manifest.json` + 裸 `main.js`(宿主 `new Function('ctx', code)` 跑 —— **文件本身就是 `setup(ctx)` 的函数体**,顶层直接 `ctx.registerView(…)`;别包成 `function setup(ctx) { … }`,没人调用它 = 零注册、零报错),加命令/斜杠项/视图/文件类型。桌面端 设置 → 插件 有一键脚手架(hello-amadeus);捆绑包模板的根即这一形态。
> 要"一套功能跨两层发行"(UI+工具+Agent+Space)时,用**捆绑包**把它们装进一个目录。

## Default workflow: hand in a one-page plan first (2026-11-23+)

When asked to write a new plugin, theme, Space, agent or bundle, or to change one substantially (a new view, Space, engine tool, setting or data format), **do not write files first**. Read what you need (this skill, the template, the host references), then hand in a one-page plan and wait:

1. **Files**: which files you will create or change (`manifest.json`, `main.js`, `tangu-plugins/<pid>/…`, `spaces/<slug>/space.json`, `check.mjs` …).
2. **Host APIs and data it depends on**: each `ctx.*` call, and for every host surface where its data comes from and what side effects it has. Look these up in [references/host-data-sources.md](references/host-data-sources.md): `ctx.tangu.mountChat` resumes or creates a real session, the personal calendar is the engine's `human/CALENDAR.db`, `ctx.tangu.request` is callable only with the local managed engine, and so on.
3. **Host gaps found**: what the host the plugin targets does not provide for this plan. A missing API, data source or permission there is a stop: name it in the plan and let the user decide. (What only the plugin sandbox lacks, such as the engine, is not a gap: list it under acceptance.) Do not work around it (reading the host's private DOM or modules, copying host code, faking data the real host would not have).
4. **Acceptance**: how it will be checked: `check.mjs` assertions, `tools/check-plugin.mjs`, the `plugin_sandbox` steps (desktop plugins, when that tool is available), and what the sandbox cannot show (a bundle's engine half, signed-in or cloud features) and how the user will check that instead.
5. **Decisions for the user**: names and IDs, where data is kept, anything with more than one sensible answer.

Write code only after the user confirms. Skip this extra approval step when the user says to go straight ahead ("直接做", "just do it", "no plan needed"), and for small fixes, troubleshooting (run the checker first, see the next section) and questions; if troubleshooting turns up a substantial change, plan that change first. Do this whether or not the session is in plan mode. In plan mode you can only read: diagnose read-only and hand the plan in with `exit_plan_mode`; outside it, hand the plan in as your reply.

**Build in serial blocks, not in parallel sub-sessions.** While developing a plugin, do not start sub-sessions or parallel `delegate` runs to build parts at the same time: they all run on the same provider key, hit its rate limit together, and one 429 fails them all. Work one block at a time (for example engine tool → view → Space → checks) and commit each block locally once it works (`git init` a new plugin folder first), so a failed later block never costs the earlier ones. This is about how you develop; a finished plugin may still hand work to an agent at runtime with `delegate(agentSlug)` (see "三档路由" below).

## Reference files (read the one you need)

Read the matching `references/` file before using an API listed below or following a section's reference:

- [references/host-ui-mounts.md](references/host-ui-mounts.md): 可复用 UI 组件：ctx.ui.mountChatBox; 原生 Markdown 编辑器 ctx.ui.mountMarkdownEditor(`vault: true` 接当前库双链); 只读 Markdown ctx.ui.mountMarkdown; 原生悬浮目录 ctx.ui.mountFloatingToc; View modes: ctx.ui.setViewModes; Tooltips and motion tokens: ctx.ui.attachTooltip; Selection bar: ctx.ui.mountSelectionBar and registerSelectionAction scopes; Tool island: ctx.ui.mountToolIsland; Floats: ctx.ui.float; Host parts (dialogs, toolbar controls, menus, popovers, empty states, icons, view head, i18n, bare elements, failed mount card): ctx.ui.confirm / openDialog / mountControl / contextMenu / popover / mountEmptyState / mountWebCard / icon / setViewHead / mount, ctx.addStyle, ctx.i18n.define; Settings parts: ctx.ui.mountSettingsPage / mountSettingsItem; Plugin settings page: ctx.registerSettingsPage; 白板层 ctx.ui.mountBoard / ctx.ui.boardToSvg; 仪表盘 ctx.dashboard; 原生多维表 ctx.table.mount
- [references/tangu-host-apis.md](references/tangu-host-apis.md): 当前模型与当前 Space:ctx.tangu; Agent 状态:agentStatus / subscribeAgentStatus(含按 runId 跟状态与 stop); Agent 名册:agents; 开新对话:startChat; 把对话挂进自己的视图:mountChat; 新对话输入区:mountComposer; 正文 AI:ctx.tangu.complete 与 registerSelectionAction; 翻译:ctx.tangu.translate; 行内补全:ctx.tangu.fim; Agent Desk 伴随面:ctx.desk; 摘要栏插件卡:ctx.summary; 自动化规则播种:ctx.automation; agent 自建 Space 的数据:section `ctx.agent`(今天没有 agent 在用)
- [references/agent-settings.md](references/agent-settings.md): UI and engine `ctx.registerAgentSettings`; explicit read-only fields, secret configured flags, lifecycle revocation and the `read_plugin_settings` tool.
- [references/plugin-skill-providers.md](references/plugin-skill-providers.md): engine `ctx.registerSkillProvider` for live external skills.
- [references/plugin-model-providers.md](references/plugin-model-providers.md): engine `ctx.registerModelProvider` for native single-inference sources.
- [references/mini-panel.md](references/mini-panel.md): a Space's small floating window (`mini` in `space.json`)
- [references/bundle-mcp-hooks.md](references/bundle-mcp-hooks.md): stdio MCP servers and observe-only hooks a bundle declares in its manifest
- [references/note-reading-renderers.md](references/note-reading-renderers.md): `ctx.registerNoteRenderer`; staged read-only rendering, immutable snapshots, hot update rollback and host-owned persistence.
- [references/note-editor-surfaces.md](references/note-editor-surfaces.md): 块表面 ctx.app.getPage / mountBlocks / insertMarkdown / insertMarkdownAt (insert at the caret, cursor marker, refusal reasons); ctx.registerEditorExtension / registerSettingsView / loadData / saveData / watchFile
- [references/store-sources.md](references/store-sources.md): 商店来源 `storeSources` 与 `forsion-store.json` 目录格式、四种包出处、钉提交 `commit`、Forsion Git 私有仓
- [references/local-plugin-tasks.md](references/local-plugin-tasks.md): local plugin task APIs (Dispatch host branch) and recording model choices
- [references/work-folder-migration.md](references/work-folder-migration.md): one-time upgrade of old plugin data into the working folder (Identity and destination; Request and result; Upgrade sequence; Acceptance cases; Ordinary writes after upgrade)
- [references/calendar-overlays.md](references/calendar-overlays.md): ctx.calendar 的 `"calendar"` 档:订阅快照(成员、只读叠加源、颜色、隐藏、默认表、`myCalendar`、.ics 的地点 / 说明 / 链接列)、设置写口、.ics 订阅管理
- [references/calendar-todo-entries.md](references/calendar-todo-entries.md): the other entry points calendar / to-do plugins use (heading jumps, notify with Undo, `ctx.ui.mountRecord`, `ctx.calendar.events`, filtered view params)
- [references/agent-space.md](references/agent-space.md): an agent's own Space plugin (`agents/<slug>/Space/main.js`) and `ctx.agent`; unused since Muse moved to its brief layout
- [references/list-sources.md](references/list-sources.md): `registerListSource` row and action details, phone layout, trees / drag / rename / group headers; Intelligent UI list cards
- [references/tool-cards.md](references/tool-cards.md): `ctx.registerToolResultRenderer` (result cards) and `ctx.registerToolLabel` (process-row sentences) for your own engine tools
- [references/databases-note-tasks.md](references/databases-note-tasks.md): `ctx.databases` / `ctx.noteTasks` (declared capabilities): snapshots, cell / row / body / column writes, `mutate`
- [references/spaces-and-home.md](references/spaces-and-home.md): `ctx.spaces` (Space list, icons, Ribbon shelf) and `ctx.home` (core home plugin only)
- [references/vault-files-and-templates.md](references/vault-files-and-templates.md): `ctx.app.createFolder` / `stat` / `renamePath` / `movePath` (who gets asked, rejections); extending the host's templates with `ctx.registerTemplateProcessor` and `ctx.registerNoteBirth`; older-host fallback
- [references/plugin-sandbox.md](references/plugin-sandbox.md): `plugin_sandbox_inspect` in detail: element states, notifications in the way, commands that wait, the plugin's settings window
- [references/network.md](references/network.md): `ctx.net` (`PluginNetApi`) and manifest `network`: host-side requests for APIs without CORS headers, rules and error codes
- [references/internals.md](references/internals.md): `ctx.internals` (2026-11-16+, unstable, desktop only): manifest `internals` (read-only copies, subscribe) / `internals-raw` (real host modules), `internalsVerified`, failure cut-off, store review per version.
- [references/stage.md](references/stage.md): `ctx.stage` demo stage (2026-11-20+, experimental, desktop only): manifest `stage`, isolated Forsion with fixture vault + named plugins, window size / density / theme / clock, full-resolution capture, window recording with pointer, scripted chat replay (`engine.json`) and personal calendar (`human/CALENDAR.db`), permission prompt, error codes, store review.
- [references/host-data-sources.md](references/host-data-sources.md): where each host surface and mount reads its data (vault files / engine `human/` / plugin data / host memory / cloud), its side effects (real sessions, current vault, wiki-link subscriptions), whether it exists in the plugin sandbox and the demo stage and how to seed demo data, and which APIs need the local managed engine (`ctx.tangu.request`, host paths, channels). Read it while writing the plan.
- [references/contribution-points.md](references/contribution-points.md): the full table of desktop `ctx` contribution points (`registerCommand` … `registerFont`, `ctx.notify`, `ctx.loadData`, manifest `events` / `onboarding` / `widgets` / `guide`), Extend View (`view.extendView`), command `invoke` for the agent, `checked` toggles.
- [references/view-runtime-rules.md](references/view-runtime-rules.md): behaviour with no open vault (per method), following the appearance switches, the dispose contract of host mounts, self-drawn floats / HUDs, pointer math under host zoom.
- [references/vault-and-assets.md](references/vault-and-assets.md): read-only vault queries (`listPages` / `listFiles` / `searchVault` / `vaultRoot` / `reveal` / `platformAccounts` / `trash`), `ctx.app.onVaultEvent`, binary assets and bundling third-party libraries, the working folder and automatic upgrade of old data, templates and new notes.
- [references/manifest-declarations.md](references/manifest-declarations.md): `onboarding.requires` and `registerReadiness`, `requiresPlugins` and the setup / dispose lifecycle, bilingual labels and icons, `guide` tips, home widgets (`widgets` + `ctx.widgets`).
- [references/more-host-apis.md](references/more-host-apis.md): list sources (`registerListSource`), the Tangu / calendar / Spaces / home / databases pointers, Floating Panel, Coding Studio sandbox, `ctx.account`, Unit and browser asset paths, API-backed Markdown editor, whiteboard layer, Chat Box selection and Director hand-off, startup appearance, LCL view layout coordination, the 2026-11-12 host UI additions.

## Troubleshooting an installed plugin: Space missing, view blank, "stopped working after an update" (2026-10-10)

When a user says a plugin's Space / view / command is gone, or that a plugin broke after updating the app or the plugin, **run the checker first** — before reading the code, and before asking the user for logs:

```bash
node "<Skill folder>/tools/check-plugin.mjs"                      # every plugin installed in ~/.forsion/plugins
node "<Skill folder>/tools/check-plugin.mjs" <plugin folder>      # one plugin, e.g. the project you are developing
node "<Skill folder>/tools/check-plugin.mjs" <plugin folder> --style   # also: its CSS against the host style contract (report only)
```

Then read [references/troubleshooting.md](references/troubleshooting.md): what each mark means, how the host hides a Space, the `plugin-status` UI command, and running without `node` on PATH. Do not send the user to the developer console or ask for logs before the checker and `plugin-status` have both come back without an answer. Plugin authors: run the same checker before every release.

## Verify a desktop plugin in the plugin sandbox before installing it (2026-10-23+)

When `plugin_sandbox` is in your tool catalog (the desktop app, a work session on this computer), verify every desktop plugin you write there **before** you tell the user it works, and never install it into their Forsion yourself:

1. `plugin_sandbox` `{"action":"start","path":"<plugin folder with manifest.json>"}` (relative paths resolve against the working folder). You get the load status (registered views, the Space folders it ships and which were shown or hidden and why, setup error, mount errors, the plugin's own console) and a screenshot of the sandbox window, already on the plugin's first Space (or its first view when it ships no Space).
2. Fix what you see in the files. Saving reloads the sandbox by itself; look again with `plugin_sandbox_inspect` (`status`, `screenshot` with an optional `view` id, `logs`).
3. Use it like a person would, with `plugin_sandbox_inspect` (2026-11-03+; never computer use on the sandbox window): `read` gives an outline of the screen with `[e12]` references; `click` / `type` / `press` take a `target` (a reference, `css:<selector>`, or a control's visible text), `type` replaces the field's text unless `append` is true, `press` takes keys such as `Enter`, `ArrowDown`, `Mod+K`; `scroll` (`amount` pixels, negative = up) and `space` (switch to one of the plugin's Spaces). Each returns a screenshot after the page settles, plus console lines and toasts that appeared meanwhile. Before clicking something that opens a file picker (`<input type="file">` included), call `files` with `paths` inside the plugin folder (put test fixtures there); a native picker cannot be seen or clicked. Commands still work too: `{"action":"command","command":"<command id>","args":{...},"screenshot":true}` runs one the plugin registered with `ctx.registerCommand`.
4. Tell the user it is running in the sandbox. They can open the window from the sandbox card in the chat or the sandbox card in the right-hand summary panel, try it, report a problem back to this chat, and install it with **Install in my Forsion**, which asks them first.

Before acting in the sandbox, read [references/plugin-sandbox.md](references/plugin-sandbox.md). Since 2026-11-15 (desktops declaring `plugin.sandbox-v2`): `read` marks toggles `(pressed)` / `(not pressed)` and fields that won't take typing `(read-only)`, so check a toggle's state before clicking it; a notification covering the target is closed first; a `command` still running after ~1.5 s returns `pending: true` (don't run it again: read the window and continue there); `settings` opens this plugin's settings page in a separate window (then `window: "settings"`, references `s12`).

What the sandbox is: a separate Forsion with its own empty vault and data, signed out, **without the Tangu engine**, where only this plugin is loaded, plus the built-in plugins it lists in `requiresPlugins` (others, such as Forsion Extend or Calendar, are not there; declare what you depend on). The Ribbon shows only this plugin's Spaces. So a bundle's engine half (`plugins/`, `agents/`, `skills/`), anything that needs a signed-in account or cloud sync, and plugins that declare `fileExtensions` (blocked for dev copies) cannot be verified there; say so and test those after the user installs. Only one sandbox runs at a time; `reset` wipes its data and starts fresh; `stop` closes it.

No `plugin_sandbox` (mobile, web, cloud sessions, older desktop builds)? Fall back to `tools/check-plugin.mjs` and ask the user to try it. Coding Studio's Sandbox panel also has a **My Forsion** tier: that one loads the dev copy into the user's real app and real notes and is not isolated.

## 通用纪律

1. **先有动机再做**:每个扩展要能指回一条真实痛点,说不出就别做。
2. **注入模型的文本一律英文**:工具 `description`、参数说明、promptSection —— 给模型读的全英文;用户可见字段用 `name`/`nameEn`、`description`/`descriptionEn` 双语镜像。
3. **Stable English IDs**: external plugin manifest IDs must match `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase ASCII letters, digits and hyphens, 1–64 characters). Use an English name for new IDs; keep existing published IDs stable. Localized `name` / `nameEn` are display labels, never storage identities. Namespace command/slash/tool IDs because they share global registries; a theme ID is its `data-theme` value. Store installs use the host's immutable `market-<UUID>` effective ID; do not replace it with the manifest ID or rename historical install-folder aliases.
4. **交付=能跑+能回归**:非平凡逻辑留一个 `check.mjs`(`node check.mjs` 一条命令),范式见 `forsion-plugin-mindmap` / activitywatch 的 check 模式。**Validation errors name the field**: when a tool's arguments or a document your code saves fail validation, put the field path and what is wrong into the tool result (`data.example: missing "zh"`), not one generic line like "does not match the schema"; the model can only fix what the error shows it. Keep one negative case in `check.mjs`: break one field on purpose and assert the error names that field.
5. **动作性能力住引擎侧,渲染端命令只做导航**(2026-08-24 拍板):注册任何入口前先问一句——这是**导航**(开视图/切面板)还是**动作**(带参数、可 headless 完成的活,比如「分析这条链接」)?动作**不要**做成命令面板命令:`Command.run(): void` 类型上就没有参数位,而且命令表活在渲染进程,聊天 agent 与自动化都够不着。正确做法=把能力做成捆绑包的**引擎侧资产**,零通道基建。**先选对形态**:靠引擎已有工具就能复现的动作 → 包根 `skills/<slug>/SKILL.md`(**全局技能,默认选它**,进所有 agent 的技能目录,`use_skill` 直接用);要专属人设 / 独立上下文预算 / 稳定的自动化入口 → 才建 `agents/<slug>/` 具名 agent(+ 它自己的 `skills/`),聊天 agent 经 `delegate(agentSlug)`、自动化经 `agent_run` 调用(⚠️`agent_run` **必须指名 agentSlug**,只发全局技能的 bundle 靠被指名的那个 agent 身上带着这份技能来够到)。需要桌面主进程能力时引擎侧已有桥工具(如 `transcribe_audio` 语音转写)。范式=青鸟收藏夹:工作台 UI 归渲染端插件,分析管线归 bundle 内嵌的 `bluebird` agent+技能,两个入口(人点工作台 / agent 委派)共用同一条引擎管线。

## Desktop plugin UI: use the host's parts (2026-10-29+)

A view that draws its own dropdowns, menus, dialogs or tab bars looks foreign in Forsion and stops following the user's theme, language, UI zoom and every later host fix. The host draws these for you: reach for a part first, and hand-draw only what no part covers (your content itself: rows, cards, charts, canvases).

| You need | Use | Not |
|---|---|---|
| Several panes or tabs in a Space | native Panels in `space.json`; several views in one panel = native tabs (见下「布局:原生 Panel 优先」) | a tab bar inside one view |
| A title row with buttons | `ctx.ui.setViewHead(el, { title, actions })` | your own header bar |
| A dropdown (sort, filter, pick one) / 2–5 modes | `ctx.ui.mountControl(el, { type: 'select' })` / `{ type: 'segmented' }` | `<select>`, a listbox you position |
| A ⋯ or right-click menu | `ctx.ui.contextMenu({ anchor, align: 'end' }, entries)` | a `.my-menu` div |
| Confirm / ask for a name / a small form | `ctx.ui.confirm({ title, danger })`; `ctx.ui.openDialog({ title, mount, actions })` with your input in `mount` | `window.prompt` (does nothing in the desktop app), `window.confirm`, `<dialog>`, a modal div |
| A panel anchored to a button | `ctx.ui.popover(anchor, { mount })` | `position: fixed` and your own math |
| Nothing yet | `ctx.ui.mountEmptyState(el, { icon, title, line, action })`; a list source's `empty` | a centered line of text |
| A sidebar list | `ctx.registerListSource` (references/list-sources.md) | a list view in the left pane |
| Buttons and icons | classes `.btn` `.btn.primary` `.btn.ghost` `.btn.danger` `.btn.sm`; `ctx.ui.icon(name, { size })` | hand-styled `<button>`, pasted SVGs |
| CSS and labels | `ctx.addStyle(css)` with public tokens only (样式契约, next); labels as `{ zh, en }` or `ctx.i18n.define` | `<style>` in `document.head`; strings frozen at registration |
| Your plugin's settings page | `ctx.registerSettingsPage({ title, mount(page) { page.update({ groups }) } })` (2026-11-18+; older hosts: `registerSettingsView` + `ctx.ui.mountSettingsPage`) | a settings page drawn with copied `.settings-*` CSS |
| Settings, chat box, Markdown editor, table, board | `ctx.registerSetting` / `ctx.ui.mountSettingsPage`, `mountChatBox`, `mountMarkdownEditor`, `ctx.table.mount`, `ctx.ui.mountBoard` | your own copy |

Signatures and details: [references/host-ui-mounts.md](references/host-ui-mounts.md), section "Host parts" and the one for each mount. The bundle template's counter view (`samples/forsion-sample-bundle/main.js`) uses the parts; copy from it.

**Check it.** `node tools/check-plugin.mjs <plugin folder> --style` lists, under "UI parts", what the plugin still draws itself where a part exists, and `plugin_sandbox` adds the same list to every status it returns. It reports, never blocks: fix what you can and keep the rest only on purpose. A plugin whose UI is a web page in an iframe is still allowed (host tokens and theme don't reach it); mark that page's CSS lines `/* forsion-style: off */`.

### 样式契约:能依赖的宿主类名与 token(2026-10-26 起)

宿主把插件可以依赖的类名和 CSS 变量发布在 `tools/plugin-contract.json`(每个带用途,随 `apiVersion` 升级)。清单外的宿主类名 / 变量
随时可能改名或删掉:不报错,只是某天界面塌了或变了色。

- **公开类名**:`.btn`(`.primary` / `.ghost` / `.danger` / `.sm`)、`.ctx-menu` 外壳(直接子 `<button>` 是菜单项,`button.danger`、
  `.ctx-separator`、`.ctx-shortcut`、`.ctx-head`、`.ctx-menu-scroll`)、`.empty-state` / `.empty-title`。私有前缀 `.amx-*`(编辑器、数据库浮层、⌘P)、
  `.fc-*`(内置日历)、`.t2-*` 别借;自己的类名用自己的前缀。
- **公开 token**:色、圆角 `--radius-*`、阴影、菜单尺寸 `--menu-*`、界面字号 `--ui-font-*` / `--ui-line-*`、动效 `--duration-*` / `--ease-*`,
  外加 `--focus-ring`。契约只列名字不列值:值跟着设计语言 / 主题色 / 背景色走。`--ease-out`、`--ease-spring`、`--ease-apple`、`--dur-*`、`--radius-xl` 已弃用。
- **圆角按尺寸选档**:短边 ≤ 18px 的小件(徽标、计数、kbd、行内代码、色块)`--radius-xs`;按钮、输入、下拉、菜单项、芯片 `--radius-sm`;
  菜单、浮层、普通卡 `--radius-md`;面板、对话框 `--radius-lg`;胶囊 `--radius-pill`,圆写 `50%`。和外框成对的内圆角写 `calc(var(--radius-md) - 4px)`,
  不另写数字。`--radius-xl` 换 `--radius-lg`(宿主留着别名,只为老插件不掉角)。
- **不写兜底**:`var(--radius-md)`,不是 `var(--radius-md, 10px)`。宿主定义着的变量兜底永远不生效,抄来的值迟早和宿主对不上。例外:token
  比你的 `minAppVersion` 新(契约的 `since` 表),兜底留给老宿主;`--reading-*` 两个本来就带兜底。
- **不写死颜色、阴影、圆角**:浅底用 `color-mix(in srgb, var(--green) 14%, transparent)`,别抄 Tailwind 色板。画面本身要固定的色(视频黑边、
  压在画面上的白字)写关键字 `black` / `white`,一看就知道是故意的;检查只认 `#hex` / `rgb()` / `hsl()`。
- **体检**:`check-plugin.mjs <插件目录> --style` 扫 main.js 和目录里的 `.css`,报私有类名、清单外 / 已弃用的 token、多余兜底、写死的色、
  ≥4px 的圆角、带色阴影。**只报不拦**,不改退出码。给另一份文档用的 CSS(iframe 里的页面、导出文件,那里没有宿主变量)在同一行写
  `/* forsion-style: off */` 跳过;打包把一个模块压成一行时,一个标记管整行。

## 引擎插件(samples/forsion-sample-plugin)

三个常用贡献点:工具(`sample_greet`)、设置 schema(`text`/`toggle`,设置页通用渲染)、`promptSection`(启用时注入系统提示)。硬约束:

- **绝不运行时 import 核心包**。对 `@forsion/tangu-agent` 只允许 `import type`(模板 tsconfig 开了 `verbatimModuleSyntax`,值导入直接编译错误)。运行时能力全走 `activate(ctx)` 的 **`ctx.sdk`** —— 否则核心的模块级单例被复制成第二份,行为诡异。
- **`dist/` 必须提交**。商店安装 = 解压源码到 `~/.forsion/plugins/<id>/`,全程不构建;改 `src/` 后必须 `npm run build`(tsc→dist/)再提交。
- **工具门禁**:`isEnabledFor` 返回 `store.isPluginEnabledSync(id)`,插件启用才对模型可见。
- **动手前问不问用户**:工具的 `capabilities.approval`。不写 = 只读,不问。`'command'` = 与 `run_bash` 同档(「询问我批准」时每次问;用户点了「总允许」或开了完全通行就不问;聊天 / 云端会话不问)。`'always'` = **每次调用都由用户本人在卡上确认**:完全通行、「总允许」、用户的 allow 规则、hook 的 allow 都跳不过,聊天 / 云端会话照样弹卡;自动化、Muse 后台、远程会话里直接被拒(工具收不到调用)。花掉用户的东西、替用户对外发内容的动作用 `'always'`。读和写拆成两个工具名,只给写的那个声明;卡上显示的是这次调用的参数原文,所以一次调用只做一件事,参数写成人看得懂的字段。
- **生命周期**:关掉插件时宿主调 `deactivate()`(限时 5s)并撤掉它注册的工具 / 命令 / 路由(meta 留着,设置页照样列出);再打开会在**同一个模块对象**上再调一次 `activate(ctx)`。所以 activate 可能跑多次 —— 别依赖模块级「只做一次」的状态,activate 里起的定时器 / 子进程 / 监听(含 `process.once`)一律在 deactivate 里收掉。
- **限时**:import + `activate` 合计限时 30s,超时按激活失败处理(设置页显示错因);超时的 `activate` / `deactivate` 宿主不会再等,但在它真正结束前**不会**再激活同一个插件(防止迟到的收尾清掉新实例),结束后自动补上。activate 里别等永远不回的连接 —— 连不上就先返回、后台重试。
- **工具 provider id 用自己的命名空间**(`plugin:<你的 id>`):两个插件撞了同一个 id,后注册的覆盖前者。
- **账号权益**:manifest `"requires": { "entitlement": "<name>" }`(2026-10-31 起;也可再写 `"plugins": [...]`,那是 Unit 的包依赖,同数组写法,桌面和手机不读,桌面前置继续写 `requiresPlugins`)。插件照常激活,自己画引导页:`const { granted } = await ctx.account?.entitlements?.() ?? { granted: null }`。`true` 有,`false` 服务端明确说没有,`null` 不知道(离线、没登录、老服务端),**`null` 别当成没有**。没声明 = `true`。真正的闸在服务端。商店标签写 `entitlement:<name>`,卡片上画成一枚标记,不挡安装。老 Unit 读到对象写法会报 `Invalid plugin dependencies`,`minAppVersion` 写到含这项的版本。
- **前置插件**:manifest `"requiresPlugins": ["other-id", { "id": "x", "minVersion": "1.2.0" }]`。前置没装 / 版本低 / 关着 / 没在跑时本插件休眠(列出但不运行),前置就位后自动激活;互相依赖成环的永不激活。
- **Putting a view on the Agent Desk**: inside a tool's `execute(args, ctx)`, `ctx.presentDesk?.({ views: [{ type: 'view', view: 'plugin:<plugin id>:<view id>' }], size: 'half' })` does what the model's `desk_present` does, but code guarantees it instead of the model remembering (computer-use presents its live view this way after the first successful action). Use optional chaining: TUI and cloud runs have no Desk. Present once per run, tracked by `ctx.runId` (fall back to `ctx.sessionId`). Leave out `name` and the host uses the view's registered title, which follows the interface language (the engine does not know it). After the user closes the Desk the host keeps it closed until their next message.
- **IM 通道:`ctx.registerChannel(spec)`(2026-10-25 起;老宿主没有,先判 `if (!ctx.registerChannel)`)**。写一个通道驱动(传输层:`kind` / `start(onMessage)` / `stop` / `status` / `send`,可选 `sendMedia` / `setTyping`,外加设置页「连接」调的 `verify()`),宿主给它内置通道的整条管线:连接即新会话、审批、`/new` `/model` 等通道命令、收件箱转发、侧栏工作区(`~/Tangu/<kind>bot`)、`channel_send_image` / `channel_send_file`,以及「设置 → 通道」里的一张卡。`spec` 里写双语 `name` / `hint` 和 `fields`(凭据,键只能是 `appId` / `appSecret` / `botToken`,`secret: true` 的不回显,全部填齐才启动);驱动经 `ctx.sdk.channelSettings(kind)` 每次现读凭据。`kind`:小写字母开头、`[a-z0-9-]`、2–16 字符、不能与 `wechat` / `telegram` / `qq` 撞,非法或撞名 activate 抛错。`onMessage` 恒立即回 `''`,回复都经 `send` 推(可能晚到几分钟,别依赖「回复这一条」的时效窗口);`peerId` 由驱动编码、同一聊天恒定。停用插件 = 宿主完全停止该通道(挂起的审批按拒绝),绑定保留。只在本机引擎生效。实例:Forsion-Instrumentality-Project `forsion-plugin-wecom`(企业微信长连接;Node 自带 WebSocket 连不上企业微信网关,`ws` 用 esbuild 打进 dist)。
- **一个账号多个联系人:`spec.multiPeer: true`(2026-10-31 起)**。每个 `peerId` 一条绑定 + 一个会话 + 一个工作目录(`<工作区>/peers/<哈希>`),对话互不相通。⚠️ 这不是沙箱:Agent 记忆共用(同一个 Agent、同一个账号身份),这些会话不用项目记忆,host 工具走 `..` 仍然读得到别的目录,按这个前提定准入和审批;`peerId` ≤ 128 字符。连接后第一个 peer 接手连接时建的会话,之后各开各的;重复连接幂等,不断开已有 peer。**准入归驱动**:它交上来的 peer 都会开会话,跑在连接这个账号的用户身份下,不想放进来的别交上来。这些 peer 不是通道主人,所以只有 `/stop` 算命令(其余 `/x` 当普通消息),收件箱不转发,桌面也切换不了连接的会话。Agent 记忆是按 Agent 的,同一个 Agent 钉给多个 peer 时记忆是共用的。**老引擎会静默忽略这个键**,退回单联系人认领(别的 peer 全被拒),必须先判:`if (!ctx.channelCapabilities?.multiPeer) throw new Error('This engine is too old for this channel')`。引擎走 npm 热更新,别只看桌面版本。
- **无人值守:`spec.selfConnect: true`(配合 multiPeer)**。凭据写进配置、没人点「连接」时,账号从没连过就由第一个 peer 替本机用户连上;断开过的账号不复活。
- **钉 Agent:入站带 `agentSlug`(2026-10-31 起)**。`onMessage({ accountId, peerId, text, agentSlug: 'xyra' })`:这个 peer 的会话用这个 Agent,优先于会话存值与通道默认;写法不合法的忽略。
- **结构化审批卡:`driver.sendApproval(accountId, peerId, card, respond)`(2026-10-31 起,可选)**。有它就不发文字卡。`card = { approvalId, runId, toolName, arguments, preview, localOnly }`,`arguments` 是工具参数的 JSON 原串;怎么画、谁能批由驱动决定。`respond('approve' | 'reject')` 同步回布尔:`true` = 生效;`false` = 卡已结束,或此刻批不了(`sendApproval` 的结果还没回来 / `localOnly` / 这台电脑锁定了远程)。`reject` 除了卡已结束都能生效。回 `{ ok: false }` 或抛错 = 没送达,按拒绝兑现。同一 peer 一次一张,答完才出下一张;10 分钟从显示起算,超时按拒绝。文字消息不碰这张卡:「好」批不了,新消息也不作废它(新任务排在后面)。可选的 `driver.settleApproval(accountId, peerId, approvalId, outcome)`:交出去的卡结束时回调(`respond` 回 `true` 的那次除外),`outcome` 是 `approved` / `rejected`(别处答的)、`timeout`、`cancelled`(run 结束 / 被停 / 通道停止)、`undelivered`;有它时超时等提示由你写,没有就宿主发文字。询问(`ask_user`)仍是文字卡;run 的结束文本仍走 `driver.send`。
- **界面半身替用户连接自己的通道:`ctx.tangu?.connectChannel?.(kind, fields, { modelId })`(2026-10-31 起,只在桌面)**。存凭据 → `verify()` → 绑定,回 `{ ok: true, accountId, label, sessionId }` 或 `{ ok: false, error }`,不抛。只认本包捆绑的引擎插件注册的 `kind`,`fields` 只收 `spec.fields` 声明过的键,两条都由宿主判。`modelId` 可选,通道还没选过模型时当默认模型,用户在通道设置里选过的不动;桌面引擎没有全局默认模型,不传时入站会回「没配模型」。
- **只给官方插件的三样(2026-10-27 起;第三方插件写了也没用)**:`ctx.cloud`(以用户的 Forsion 账号请求云端,只放 `GET /api/market/mine` 与 `POST /api/market/mine/<id>/update[?dryRun=1]`)、工具的 `capabilities.approvalPreview(args) => string`(自己写审批卡文案)、以及进聊天(Chat 预设)会话的工具面。「官方」= 插件在 Forsion 签名的捆绑包里(包根 `SIGNATURE` 用引擎钉死的公钥验过,插件的 `tangu-plugin.json` 和入口都签在里面);其余插件拿到的 `ctx.cloud` 是 `undefined`、`approvalPreview` 被忽略(卡上照旧是参数原文)、工具进不了聊天会话。别为第三方插件设计依赖它们的功能。
- **常驻引擎:`ctx.registerResidentEngine?.({ engineId, connect(signal), onSession? })`(2026-11-15 起,只在本机引擎;DSH 融合插件用)**。替一个外部引擎(引擎清单里的 id,如 `'dsh'`)提供一个**已经在跑**的进程,这个引擎的普通对话改连它、不再每轮起一个。`connect()` 回 `{ id, input, output, closed }`:进程的 stdin、**只剩 JSON 行**的 stdout(不是 JSON 的行 —— 比如带启动令牌的就绪行 —— 插件自己滤掉,协议库会把它们原样打进日志)、进程没了就 resolve 的 promise;`id` 每次启动换一个。**只在进程确实没在跑时回 `null`**(这一轮照旧每轮起进程;两个进程开在同一份引擎目录上会互相挡住同一场会话)。一轮结束宿主不关会话(工作台要接得上);交给引擎的人设 / 记忆 / 技能目录走每场会话那座 MCP 桥在 `initialize` 里带的说明(DSH 只在连上时读一次,内容变了宿主关掉重接,这时调 `onSession({ type: 'reopened', engineSessionId, sessionId })`,插件据此重载工作台里开着那一场的页面)。工作台要打开 Forsion 的某场对话前,引擎插件路由里调 `ctx.sdk.engines.hold(engineId, sessionId, req.user.userId)` 先替它接上(回 `{ ok, engineSessionId, state }` 或 `{ ok: false, status, detail, code }`;接上时也会调 `onSession({ type: 'held' })`)。引擎发来的审批(`session/request_permission`)照常进这一轮的审批卡;没有 Forsion 的轮在等这一场时宿主回「取消」,所以同一个进程里还有别的界面(DSH 的工作台)时,插件要让引擎只把 Forsion 发的轮的审批交到这条连接上。引擎还能在 stdout 上发 ACP 扩展通知 `_forsion/notice` 给正在跑的那一轮一条提示:`{ sessionId, id, text: { zh, en }, action?: { id, label: { zh, en } } }` 进审批托盘、`{ sessionId, id, clear: true }` 撤掉,这一轮结束自动清;`action.id` 只认插件用 `ctx.registerEngineHarness` 登记的对话菜单项(按钮 = 跑那一项),DSH 融合插件用它报「DSH 在工作台里等你批准」+「打开工作台」。可选 `modelSeesImages(model, signal)`(2026-11-16 起):`model` 是这场会话此刻的模型(ACP 模型选项的值),回这个模型收不收图;交给引擎的 Computer Use 每次调用先问它,**只有回 `true` 才跑**(`false` / `undefined` / 抛错 / 3 秒没回都按不能,调用回一句原因、不问审批)—— 看不见屏幕的模型只能照文字猜坐标去点。截图类工具交回的图经那座桥回成 MCP image 内容(单张 base64 在 300 万字符以内原样交,Computer Use 按截图像素给坐标;超了先换同尺寸 JPEG,还超才缩小并在图前写明原尺寸和倍数,仍超就不交)。台架:`tangu-agent` 的 `scripts/dsh-engine.check.mjs --only resident`;图走这条路的实测在 DSH2Forsion 的 `tests/check-images.mjs`。
- 类型契约 `types/tangu-agent.d.ts` 是 apiVersion 1 的 API 拷贝,随模板分发;宿主升 apiVersion 时替换它并同步 manifest 的 `apiVersion`。

装本机:整夹拷到 `~/.forsion/plugins/<id>/` → 设置页重扫即生效,不用重启。同 id 覆盖升级也是重扫即热换代:单文件入口(esbuild 打成一个 bundle,推荐)直接换;多文件的**纯 ESM** 包(`"type": "module"`,入口相对 import 同包文件)在 Node ≥ 22.15 上也能整包换代。宿主证明不了整张模块图都会换代的,如实标「需重启」:包里有 CommonJS(`.cjs`、`require('./x')`、`createRequire` 造的函数)、原生 `.node`、任一层自带 `node_modules`、软链、`import(变量)`、引到插件目录外的文件,或运行时太旧。同一进程里热换代满 20 次后也一律「需重启」(旧模块卸不掉,省内存)。

## 主题(samples/forsion-sample-theme)

双轴模型:**语言(结构:圆角/字体/阴影/布局)× 配色(颜色)× 明暗**。磁盘主题装 `~/.forsion/themes/<id>/`,**目录名必须 == id**。

- 主题 CSS 是**全局注入**(非隔离),因此**每条规则都要 scope 在 `[data-theme='<id>']` 下**,否则污染其它主题。
- **不要硬编码颜色**:配色由 skin 提供,主题只定结构,消费 `var(--bg)`/`var(--text)`/`var(--accent)` 等词表 token —— 这样任意配色/明暗都成立。
- **正文行距、段距和切视图的时长归用户的外观开关管**(references/view-runtime-rules.md「外观开关:跟着宿主走」):主题别用更高权重的规则把笔记 / 对话正文的
  `line-height`、段间距或 `wb-view-enter` 的时长写死 —— 写死了,用户拨那几个开关就没有反应。
- 可选 `settings[]`(number/select/boolean/color)让用户在设置页调主题内参数:`key` **就是** CSS 自定义属性名,宿主把值写进 `:root` 内联变量,主题用 `var(--key, 默认值)` 消费。参考本仓内置 `genesis-glass` 主题(`desktop/frontend/src/theme/themes/genesis-glass/`)。
- **动效归宿主管,主题别碰**:装进来时宿主先过一遍 `theme.css` —— 动效 token(`--duration-*`、`--ease-*`、`--menu-enter/exit-*`、`--droplet-duration`、`--collapse-*`、`--tip-*`、`--hovercard-*`、`--switch-edge-*` 等)的声明在任何选择器上都删掉,`@property` 注册它们的整块也删;`settings[]` 用这些名字的项不生效;主题自己的 `@keyframes` 与 `@layer` 名加前缀 `t-<id>-`(`animation` / `animation-name` 里的引用一起改写,经 `var()` 转手的不改写);`@import` 一律删(谷歌字体写 `theme.json` 的 `fonts.google`);处理完浏览器再读一遍,还漏着就整套样式不加载;系统「减少动态效果」在宿主最先声明的层里,`!important` 也压不过。设置页会提示「N 项动效已忽略」。主题在自己选择器上直接写的 `transition` / `animation` 不在收口范围内,照常生效(减少动态效果下动画停、过渡只剩短的颜色 / 透明度)。
  动效主题(设置 → 外观,`<html data-motion-theme>` = genesis / droplet / stretch / glide,外加 `data-motion-fade="on"`「只淡入淡出」)归用户:`theme.json` 可写 `"motionTheme": "<四者之一>"` 建议一套,只在用户从没选过时生效;插件不读不写这两个属性,也别写死某一种效果 —— 用宿主的分段胶囊 / 开关 / `ctx.ui` 零件,自动跟着走。

## Space(samples/forsion-sample-space)

`space.json` 声明视图布局配方(引用视图类型 id;插件视图用 `plugin:<插件id>:<视图id>` 并在 `requires.views` 声明)。纯数据,无代码。

For a Space bundled at `spaces/<slug>/space.json`, `"autoDesktopShortcut": true` asks the installed desktop host to create a shortcut once when it registers the enabled plugin’s Space. Deleting or moving it is respected across reloads, updates, and restarts. Users can create it again from the Space menu. Older hosts ignore this field.

### 图标:`icon` + `iconFile`(2026-10-04 起)

图标库只有 30 枚,几个 Space 一多就撞图标。给 Space 配一枚自己的图:

```json
{ "icon": "video", "iconFile": "icon.png" }
```

- `icon`:宿主图标库里的名字(全表见 `samples/forsion-sample-space/README.md`),不认识的回落方块。
- `iconFile`:一枚图片的**裸文件名**(`.png` / `.svg`,不能带路径)。宿主先在 Space 自己的目录里找;插件内嵌的 Space 找不到,再到**插件包根**找。
  所以 `"iconFile": "icon.png"` 而 Space 目录里不放图 = **直接用插件图标**;想单独画一枚,就把图放进 `spaces/<slug>/`。
  - **PNG**:原色显示。和插件图标同一道门禁:正方形、边长 64~512 像素、≤256KB。
  - **SVG**:只取轮廓,颜色跟随主题和选中态(≤64KB)。照 Ribbon 线形图标的规格画最协调:`viewBox="0 0 24 24"`、2px 描边、不填充。SVG 里写的颜色不生效,要彩色用 PNG。
- **两个都写**。老宿主不认 `iconFile`;文件缺失或不合规时也退到 `icon`。
- 只换图标**不要**升 `space.json` 的 `version` —— 那个版本号一变,宿主会丢掉用户保存的布局。升插件 `manifest.json` 的版本即可,图标随插件更新自动换。
- 宿主只把图当图片显示(`<img>` / CSS mask),SVG 里的脚本、外链都不会执行,也别指望它们。

### 布局:原生 Panel 优先(2026-10-02 起规)

插件视图**先摆进宿主的原生 Panel**,别在一个 view 里自造侧栏、底栏、分栏 —— 原生 Panel 自带标签、拖宽、折叠、
mod+J、布局记忆和移动端抽屉,自造的一样都没有,还和别的 Space 长得不一样。按内容找位置:

| 内容 | 放哪 | 怎么写 |
|---|---|---|
| 可打开项的列表(工程、收藏、会话) | 左栏统一工作区 | `registerListSource` + `layout.left: [{ "type": "workspace", "params": { "mode": "plugin:<id>:<列表源>" } }]` |
| 主体(编辑器、播放器、详情) | 主区 | `layout.main`;要并排的另一份原生视图(笔记、聊天)用 `split: "right" / "down"` 分栏 |
| 这种主视图通常要的属性 / 检查器 / 对话 | 右栏 | 在 `registerView` 上写 `rightCompanions`(见下「右栏:主视图规则」);本 Space 的缺省组写 `layout.right` |
| 点了某一行 / 某个事件才出来的详情、表单 | 右栏临时 | Extend View(`view.extendView.open({ side: 'right' })`) |
| 横跨全片的时间线、日志、控制台、终端 | 底部面板 | `layout.bottom`(2026-10-02 起)或 `ctx.openView(id, { location: 'bottom' })` |

- **On-demand native main companions**: declare up to three `mainCompanions: [{ type: 'amadeus-editor', key: 'my-plugin-document', split: 'right' }]` on `registerView`. Types are `amadeus-editor` / `chat-panel`, splits `right` / `down`, and each stable key starts with this plugin's effective ID plus `-`; optional `params` follow native view parameters. Call the mounted `view.setCompanionsVisible?.(true)` to expand; `false` folds those keyed native views into the source tab group, preserving editor state, chat drafts and split sizes. Narrow/mobile hosts keep native tabs; unrelated views are untouched. Feature-detect on older hosts and keep an essential fallback in the Space recipe. Do not rebuild the Space or imitate native editors/chats to implement this toggle.
- 范例:**青鸟收藏夹**(左 = 收藏夹列表源;主区 = 详情 + 按需展开的原生笔记 / 聊天，旧宿主可用 `split: "right" / "down"` 配方)、
  **视频工作室**(左 = 工程列表;主区 = 舞台与走带;右 = 属性 Extend View;底部 = 时间线)。
- **一份状态,多个 view**:主区和底部是两个 `registerView`,同一窗口里共用插件模块里的那份状态,别各存一份。
  拆不开的 DOM 可以整块搬进另一个 view 的 `el`(事件监听跟着走),样式随之注入。
- ⚠️ **iframe 一搬就重新加载**,而宿主开合底部面板会把主区整列摘下重挂 —— 主区里的 iframe 同样重载。
  靠 postMessage 驱动的预览要在帧**每次**报告就绪时把时间、播放状态补发回去,不能只听第一次(否则画面一直是黑的)。
- **一个检测只开它自己那一块**:缺哪个能力就只少那一块,别拿一个接口当「新宿主」暗号、整块退回旧版(拿 `setBody` 判底部输入框,
  会让只缺子任务的宿主连输入框位置也退回去)。选项层面、`?.` 看不出来的查能力清单:`ctx.listCapabilities`、
  `ctx.ui.chatBoxCapabilities`、`ctx.table.caps`。
- **先 feature-detect 再依赖**:旧宿主静默忽略 `layout.bottom`;旧桌面宿主把 `openView(id, { location: 'bottom' })`
  当主区打开,会把当前主视图导航走。查 `ctx.viewLocations?.includes('bottom')`(移动端没有底部面板,不含它)。
  主视图让出内容的判据 = 配方传给它的参数(如 `{ "timeline": "bottom" }`)**且** `viewLocations` 含 bottom;任一不满足就在 view 内自绘。
- **右栏:主视图规则**(2026-10-20 起)。右栏 = 本 Space 的 pinned ∪ 主视图的组 ∪ 用户自带。主视图(主区前台那个)在
  `registerView` 上声明 `rightCompanions`,它到前台时右栏就换成这组;没声明就用本 Space 的 `layout.right`。
  ```js
  ctx.registerView({ id: 'session', title: 'Session', mount, rightCompanions: ['plugin:diting:chapters', 'chat-panel'] })
  ```
  - 类型写全名(同 space.json):自己的 `plugin:<pid>:<viewId>`,宿主的写名字。第一项 = 切过来时顶到前台的那个。
  - 宿主怎么换:切到这个视图 → 带上这组(排在最前);切走 → 收回不在下一组里的;同一类视图换文件(笔记 A → 笔记 B)不动;
    右栏收着只换暂存、不弹出来;新建标签页不算。用户自己开 / 拖进右栏的视图规则永远不关;配方里 `"pinned": true` 的右栏条目恒在。
  - `layout.right` 收窄成「没声明组的主视图用这组」:你的 Space 里打开宿主的笔记 / 对话 / PDF(它们自带组)时它会让位,
    回到你的主视图再回来。不想让位的条目写 `"pinned": true`。
  - 只放侧栏身份的视图:宿主的 `chat-panel`(侧栏对话)/ `outline` / `tangu-details` / `workspace` / `amadeus-backlinks` /
    `amadeus-graph` / `calendar-side`,或你自己的视图。主区实体(`chat`、`amadeus-editor`、`amadeus-pdf`…)会被滤掉;右栏要对话写
    `chat-panel`(`layout.right` 里写 `chat` 的老配方,宿主按 `chat-panel` 开)。最多 4 项,建议 ≤ 3(侧栏标签只有图标,4 个就溢出)。
  - 组只写「这种主视图通常需要什么」;点了某一行、某个事件才出来的详情 / 表单走 Extend View,别塞进组。
  - 宿主内置的组:对话 → Tangu 详情 / 文件 / 大纲;笔记 → 对话面板 / 大纲 / 反链 / 关系图;PDF 等文件 → 对话面板;Coding → 文件;日历 → 待办。
  - 旧宿主忽略 `rightCompanions`:要紧的右栏视图照旧写进 `layout.right`(新宿主上它是缺省组,旧宿主上照旧摆)。
  - **左栏不跟主视图走**:左栏是 Space 的,第一项一般是本 Space 的工作区视图、写 `"pinned": true`。`workspaceSource`
    只对没写 `mode` 的老配方生效,新插件别用。
- 配方里写了 `layout.bottom` 就**默认展开**;用户收起后 mod+J 照配方开回来(关掉最后一个标签也一样)。
- 底部横跨哪几列用 `layout.bottomSpan`:缺省 `right`(主区+右栏,左栏满高)/ `left`(左栏+主区,右栏满高)/ `full`(通栏)/ `main`(只在主区下方,左右栏都满高)。时间线要通栏就写 `full`;旧宿主忽略该字段、按缺省摆。
  改了 `layout` 要**抬 `version`**,否则用过这个 Space 的人永远停在旧布局。
- **Ribbon 落点 `"ribbon": { "after": "<spaceId>" }`**(2026-10-31 起):图标第一次出现时排在那个 Space 后面;用户已经摆过的位置不动,那个 Space 不在就按缺省排到末尾。
- **手机先落左栏 `"mobile": { "listFirst": true }`**(2026-10-31 起):左栏确实是「点一项进主区」的列表才写;缺省主区是第一层、左栏是抽屉。老宿主忽略这两个键。
- **默认主页 `"mainPage": true`**(2026-10-18 起):写在 `layout.main` 的一条上(至多一条;写在别处或写两条,配方被拒)。
  进这个 Space —— 从别的 Space 切进来、冷启动、人已在里面再点一次它的图标 —— 前台先是这个视图,不是上次离开时的前台;
  别的标签照旧留着,只退到后台;主区里没有它就开一个。不写 = 缺省「还原上次离开时的样子」。通常和 `"pinned": true` 一起写:
  不固定的话,命令里「先切过来再 `openView`」会把它就地换掉。旧宿主忽略该键。
- **启动布局 → 项目布局(照 Coding Studio,2026-10-02 起插件可做)**:没打开项目时左栏是项目导航、主区是启动台,
  底部收起;打开项目后左栏换成项目自己的内容(素材、对话),底部开出时间线 / 终端。换法:
  `ctx.replaceView?.('nav', 'media')` —— 只换自己的视图,**原地**换(同一块面板、尺寸不变、不重建布局,所以主区
  里的 iframe 不会重载);面板收着就只换暂存、保持收着;Space 的面板默认值跟着换。回到启动台反过来换,再
  `ctx.closeView?.('timeline')` 收起底部(关掉底部最后一个视图 = 面板收起,与用户点 × 一样)。侧栏要收起就带
  `{ collapse: true }`(2026-10-18 起):那一侧只剩这个视图时整侧收起、视图进暂存(用户展开或你下次 `openView` 时回来),
  不留「空侧栏」占位;侧栏里还有别的视图就照常关。旧宿主忽略这个选项、照旧留占位。像蓬洲云概览那样「这一页不要右栏、
  别的页出详情」就这么写。`replaceView` 返回 0 = 那个视图
  哪儿都没开着(用户关了它,或布局已经是项目态):**别**拿 `openView` 兜底 —— 它会把用户收起的面板弹出来。
  旧宿主没有这两个方法:左栏就一直是导航(视频工作室这么做:旧宿主上没有素材区,时间线仍画在编辑器里);
  非要内容就 `openView(id, { location: 'left' })` 多开一个标签,底部不动。
  ⚠️ 进出项目的布局跳转会让宿主重挂主区那一列(主区视图卸载再挂上;10-02 真 Electron 实测进、出各一次,⌘J 开合
  不会)。两条后果:① 跨这一下要留的临时状态(新建页里填的想法、刚选的模板)放模块作用域,**等用户真正用掉
  (发送 / 清空)才清** —— 别在第一次交给界面时就清,即将被卸掉的那一份可能先拿到;② 关项目时,新挂上的那份
  会按「参数里的文件 → 模块里的当前项 → 存盘的上次打开」找项目:先把这三样清干净(存盘那步要 await)再拆界面、
  换布局,否则它会把刚关的项目又打开。
  范例:视频工作室(导航 ↔ 素材,底部时间线随项目开合;仪器 `npm run verify:docked`)。

### Mini Panel 适配

A Space that should also open as a small floating window gets a `mini` block in `space.json`: read [references/mini-panel.md](references/mini-panel.md) before you add one.

## 智能体(samples/forsion-sample-agent)

文件夹式:`config.toml`(名字 `name_zh` / `name_en`、模型/工具/技能开关)+ `SOUL.md`(人设,英文写给模型)+ `Library/`(参考资料)+ 每-agent 记忆。装 `~/.forsion/agents/<slug>/`。

## 捆绑包(samples/forsion-sample-bundle)—— 默认起点

**新扩展默认从这个模板起步**:除非明确只做主题或单个纯数据 Space/智能体,插件类工作一律用 bundle 布局(只填用得上的子目录即可,单一内容的 bundle 完全合法)。一个 Forsion 桌面插件目录内嵌引擎侧/跨域内容,装进 `~/.forsion/plugins/<id>/` 一处全就位。识别全靠**标志文件**,manifest 无新增字段;所有子目录可选,纯捆绑包连 `main.js` 都可省:

```
<id>/manifest.json                     ← bundle 标志(普通 Forsion 插件 manifest)
     main.js                           ← UI 部分(可省)
     tangu-plugins/<pid>/tangu-plugin.json   ← 内嵌引擎插件:引擎原地加载(优先级最低,顶不掉手装同 id)
     skills/<slug>/SKILL.md            ← 内嵌全局技能:引擎原地扫描(内置 < bundle < 用户)
     agents/<slug>/config.toml         ← 内嵌 Agent:人格面播种一次,其 skills/ 指纹自愈
     spaces/<slug>/space.json          ← 内嵌 Space:随插件启停显隐(图标见上文 `iconFile`)
```

**多账号模式(一台机器上多个账号共用一个引擎进程)**:引擎只从 bundle 里取 `agents/` 的人设和 `skills/` 的技能(只读),`tangu-plugins/` 引擎代码不加载、插件自带的 MCP 与 hooks 不启动。要在这种模式下可用,核心能力放进人设和技能,别依赖引擎插件。缺省单人模式照旧全部加载。

**三种生命周期,发包前必须分清**:

| | 谁 | 升级时 |
|---|---|---|
| **随包** | 引擎插件、Space | 父插件禁用即级联关闭/收起,卸载一并消失 |
| **播种一次** | Agent 的**人格面**(config.toml / SOUL.md / Library / MEMORY) | 首次发现拷入引擎成为活体,**永不覆盖**,卸载保留 |
| **指纹自愈** | Agent 的 `skills/`(2026-08-25 起) | 每次启动比指纹:用户没动过的跟着 bundle 更新;动过的(含无指纹老副本)保护不覆盖并在引擎日志报出来 |

**上架商店后的安装目录与运行身份(2026-10-17 起)**:商店给每个条目一个不会变的 ID,新上架的条目装进 `plugins/market-<ID>/`(引擎插件是 `~/.tangu/plugins/market-<ID>/`),和显示名无关,显示名可以重复。装在这种目录里的插件以目录名为运行身份:包里的引擎插件照常按这个目录名挂 scoped 路由,`ctx.tangu.request` 由宿主拼好,不用管;单独上架的引擎插件 `ctx.paths.dataDir` 在 `plugin-data/market-<ID>/`,注册的工具名会被宿主改写成 `market_<原名前 16 位>_<哈希>`(两份同 id 的插件互不顶替),所以提示词和文档里别让模型按字面工具名去调;`sdk.runs.start` 的 `toolNames` 与 `sdk.automation.save` 的 `tool` 照写原名,宿主自己换。别的插件在 `requiresPlugins` 里写你 manifest 的 `id` 照样认得到,前提是只装着一份。这种条目只有 2.13.4 之后的桌面版本装得了,旧桌面会收到「请先升级 Forsion」。更早上架的条目保留原来由显示名推出的目录名:其中带引擎插件的包在桌面 2.13.3 及更早的版本上,目录名和 manifest `id` 不一样时页面调不到包里的引擎插件(每次 404、不报错)。没有引擎插件的包不受影响。

包根 `skills/`(全局技能)是原地扫描、不落盘拷贝,不在上表内。因此 onboarding 里**不要** recommends 自家已内嵌的 agent/skill(会引导去商店重复装)。真实范例:`Forsion-Instrumentality-Project/bluebird/`。

### 插件自带的 MCP server 与 hooks(2026-10-17 起;只收 stdio MCP、只开观察档 hooks)

A bundle can declare stdio MCP servers and observe-only hooks in its manifest: read [references/bundle-mcp-hooks.md](references/bundle-mcp-hooks.md) before you add either.

### 把动作搬进引擎侧:三档路由(通用纪律 5 的落地写法)

发现某个能力「只有点命令面板才能用」时,把它做成 bundle 的引擎侧资产(形态按纪律 5 选:默认包根 `skills/`,真需要专属人设/上下文预算/自动化入口才加 `agents/<slug>/`),然后在**通用技能**里写一张降级路由表(照抄 `bluebird/skills/bluebird-link/SKILL.md`)。**只发全局技能时第 2 档不适用**,直接写「自己做 / 指去工作台」两档即可:

1. **我自己就有那份技能**(即我就是那个专门 agent)→ `use_skill` 直接做。**这一档必须排最前**,否则专门 agent 会委派自己。
2. **有 `delegate` 工具且当前是本地库** → `delegate({ agentSlug: "<slug>", task })`,task 里带**真实库根路径**并要求它自己落盘、回报路径;顺带如实说明「委派产物不进插件侧栏索引」。
3. **都不行**(没 delegate / 云端库 / 第 2 档失败)→ 让用户从命令面板打开工作台自己操作。

需要桌面主进程能力时(语音转写、系统面)引擎侧已有 MCP 桥工具,如 `transcribe_audio(path, timestamps?)` —— 它在没开桌面/云端 worker 上自动隐身。**调用方明确说了「我自己接力转写」时,即使工具可见也不要调**。子 agent 继承**父会话**的审批档位,不是它 config 里的 `approval_mode`。

## 发布到商店

上架的地方叫 **Forsion 商店**——界面里的名字就是「商店」(英文界面 Store),不叫「应用市场」「插件商店」或 Market。过审后,用户从桌面端功能区底部的「商店」入口进去,在对应分类(插件 / 技能 / 主题;Agent 与 Space 归在「插件」分类下)里一键安装。给用户指路时照这个名字说。

推成独立 GitHub 公开仓库(引擎插件记得含 `dist/`)→ 商店 → 投稿 选对应类型给仓库链接或传 zip(zip 内容放根或单层文件夹,两层路径装不了)。捆绑包(默认形态)按 **amadeus-plugin** 类投稿(桌面按包内 manifest 实测路由,自然落进 `~/.forsion/plugins/`)。GitHub 来源会**锁定过审时的 release tag**,发新版需重新过审。

**发新版 / 改信息(2026-10-24 起)**:在「投稿」里选中自己的条目。ZIP 拖进新包;GitHub / npm 先在原渠道发新 Release / 新版本,再点「检查新版本」(从没打过 Release 的仓库没有可锁的版本,先发一个 Release)。**版本号只从包里 / 上游读,投稿页没有版本输入框**:manifest 写 `version`,技能写 SKILL.md frontmatter 的 `version` 或 `metadata.version`(两处都认,桌面检查更新用同一条规则),新版要高于商店当前版本。提交前服务端先把包检查一遍(只读、不落库),列出读到的类型、版本、图标、README 和包体提醒,作者确认后才真提交。简介、标签、长描述、版本要求可以在「商店信息 → 编辑」里单独改,不用传包、不升版本。已上架条目的新版本和信息改动都要过审,审核通过前商店照旧发原来的;审核结果发到投稿账号的收件箱。升版号必写 `CHANGELOG.md` 一节(`## x.y.z — YYYY-MM-DD`),宿主会渲染成插件详情页的更新日志。

**用户侧自动更新与回退(桌面 2.13.8 起)**:商店插件**缺省自动更新**(后台下好、下次启动换上;用户可全局或按插件关掉)。换版前旧版本留在本机(`~/.forsion/.plugin-versions/<类型>/<目录名>/<版本>/`,每个插件最近 2 份),用户能一键回退;回退或从「版本」页装旧版 = 固定在那一版,直到用户「恢复自动更新」。⚠️ **回退只换插件文件,数据不回退**(工作文件夹、`plugin-data`、设置原样):改数据格式时让旧版读新数据也不出错(忽略不认识的字段、别把旧数据原地改成旧版读不了的形状),或新格式写新文件。核心插件(Extend / 日历 / Computer Use)跟桌面版本走,不参与。

### 商店来源:自己维护一份目录,不走投稿(2026-11-08 起)

不想每版都过审、或东西很多时,让插件在商店左栏「来源」里挂一份自己维护的 `forsion-store.json`(manifest `storeSources`,GitHub / npm / https / Forsion Git 私有仓)。来源只交目录,下载安装照常走商店。写之前读 [references/store-sources.md](references/store-sources.md)。

### 投稿元数据、版本要求与评论(2026-10-17 起)

- 投稿表单可填:标签(≤8 个,每个 ≤40 字)、长描述(详情页「内容介绍」)、支持平台(`desktop` / `macos` / `windows` / `linux` / `android` / `ios` / `web`)、Forsion 版本范围(`minAppVersion` 含、`maxAppVersion` 不含,语义化版本号)。
- 包里 manifest 的 `minAppVersion` / `maxAppVersion` / `platforms` 优先于表单;已有的 `isDesktopOnly: true` 等同只支持桌面。桌面和手机安装前都会读包里的 manifest 再核一遍,不符就不下载、不写盘;旧版本的过审包和快照会留着,用户可以在「版本」栏装回历史版本。
- 不写版本范围 = 「未知」,商店照常展示但不算确认适配;靠新宿主接缝的插件写 `minAppVersion`,已知在某个版本坏掉的写 `maxAppVersion`。
- 每个条目有公开评论区(登录可评、可回复、本人可改可删)。新评论发到投稿账号的收件箱,回复通知被回复者;作者可以在评论区关掉全部或单个插件的评论消息。
- Tangu 用 `search_marketplace` 查候选，确认适合后用 `recommend_marketplace_plugin` 展示卡片。用户可在卡片上选择安装，所以标签和描述应写清实际能力。

### Android App 与 `isDesktopOnly`(2026-10-02 起)

Forsion Android App 也跑 Forsion 插件(同一份 `pluginStore`、同一个 `ctx`),**只经市场装**、只装 `amadeus-plugin` 类;插件住在 App 私有目录,`ctx.loadData` / `ctx.saveData` 照常可用。
- 依赖桌面才有的东西(本机程序 / Node / `ctx.app.hostPath` 必须非 null / 引擎插件 / 浮窗)且没有降级路径的,manifest 写 `"isDesktopOnly": true`(只认布尔 `true`):手机市场拒装并说明原因,已在列表里的显示「仅支持桌面端」且代码不执行。桌面上这个字段不影响任何行为。
- 能在手机上跑的,照「能力判断运行环境」写:`openFloatingPanel` / `openMiniPanel` 手机没有(可选链;`ctx.workspace.open` 的 `{ float: 'desktop' }` 在手机上自己降成半屏抽屉 / 主区),状态栏项手机不显示,捆绑包里的引擎插件 / Agent / 技能手机不装(手机上没有本机引擎)。
- 捆绑包里的 **Space**(`spaces/<slug>/space.json`)手机上照常注册(2026-10-09 起;此前不装),出现在底部导航栏,图标用 `iconFile` 那张 PNG(没有或是 SVG 就用 `icon` 的线条图标)。手机是单列:进这个 Space 先看到 `layout.main` 的第一个视图,`left` / `right` 是从顶栏按钮拉出来的抽屉,`bottom` 不开 —— 主视图要在约 400px 宽里独立可用,别把必经的操作只放在左栏或底部面板里。
- 手机上插件包的上限:下载 25 MB、解压 64 MB、2000 个文件。
- 手机的**主页只有一页、不开标签**(2026-10-11 起):用户停在主页时,命令里 `openView` 打开的视图会被带到「主人」那个 Space 去开 —— 主人 = `layout.main` 里列着这个视图的 Space(插件自带的 Space 就是这么认的)。没有任何 Space 列着它的视图仍然盖在主页上打开,但用户下次回到主页时会被宿主关掉:这类视图别攒没保存的状态,要长驻就给插件带一个 Space。
- 手机没有 ribbon:插件的 `registerCommand` 命令由宿主按插件分节列进顶栏「⋯」菜单(节标题 = 插件展示名),`checked` 开关在那里显示为勾选态 —— 命令 `title` 要能独立看懂(手机上它就是菜单行文案)。手机竖屏上「⋯」只装当前这一页的事(2026-11-18 起):这一节**只在插件自己的页面**出现 —— 屏上是它带的 Space,或主区是它注册的视图;别的页面上用户从命令面板(头像菜单里)搜得到。所以「随处要用」的动作别只靠这个入口:给插件带一个 Space / 视图,或让命令标题一搜就中。平板横屏照旧处处列出。

## Agent 自建 Space(2026-09-11 起;今天没有 agent 在用)

契约与 `ctx.agent` 在 references/agent-space.md。Muse 11-08 起改用下面的布局,不写 main.js。

### Muse: Today's brief layout (from 2026-11-08, Muse only)

Muse's Space no longer loads `main.js` (it stays on disk; do not edit it): the desktop draws the "Today's brief" template from two local files. `agents/muse/Space/space.json` is Muse's part (the one-line message, ≤160 characters, may link `[[Library path]]`; up to 3 prepared Library files; proposed cards), written with the `muse_space` tool: read first, then update only what changes, with `expectedRev`. `<tangu home>/ui/muse-space.json` is the user's grid (order, hidden, placed cards, tombstones of rejected proposals): Muse cannot write it, move or remove cards, or re-propose a rejected key. At most one message change and one proposal per cycle; `muse_space widget` creates Muse's own native widget to propose. A broken `space.json` is shown from its last valid version and never repaired automatically.

## Desktop plugin APIs: rules that hold everywhere (details moved to references/ on 2026-11-23)

The full API table and the per-topic contracts are in the reference files listed at the top; start from [references/contribution-points.md](references/contribution-points.md) for "which `ctx` entry does this" and [references/host-data-sources.md](references/host-data-sources.md) for "where does this surface read its data". The rules below are the ones people break most; each links to its full text.

- **Same `ctx` for built-in and external plugins** (`pluginStore.makeContext`). Type contract: `desktop/frontend/src/amadeus/plugins/types.ts`; canonical prose: `docs/Function/生态内容制作指南.md` in the Forsion repo.
- **No open vault**: every vault-path method (`readFile`, `writeFile`, `listPages`, `searchVault`, `trash`, `stat` …) needs an open vault and each fails differently without one, mostly silently (`readFile` gives `null`). `vaultRoot()` is the only probe; `workFolder()` is not. The vault restores lazily, so wait for `vaultRoot()` before reading at view mount. Features unrelated to notes must not depend on these methods: use `ctx.loadData` / `ctx.saveData`, `ctx.dashboard.mount` and your own DOM. Wrap start-up writes in try/catch. → [references/view-runtime-rules.md](references/view-runtime-rules.md)
- **List sources re-read in `subscribe()`**: setup runs before the vault is open, so the first read is usually empty. → [references/more-host-apis.md](references/more-host-apis.md), [references/list-sources.md](references/list-sources.md)
- **Follow the user's appearance switches**: text in host text tokens (no hard-coded colours or opacity for "secondary"), mark the selected row (`aria-selected` / `aria-current`), long reading text on `--reading-line-height` / `--reading-paragraph-gap`, no enter animation of your own on the view root, durations from `--duration-*`. → [references/view-runtime-rules.md](references/view-runtime-rules.md)
- **Host mounts sit in a `display:contents` layer the host adds to `el`**: `dispose()` gives `el` back at once; use the handle's `update()` to change data; never select host nodes with `el > .x`. → [references/view-runtime-rules.md](references/view-runtime-rules.md)
- **Commands for the agent (`invoke`)**: declaring `invoke` is the whitelist. Never opt in dangerous commands (deleting or overwriting user data, credentials, sending / publishing / buying, install / restart, irreversible bulk edits): web and mobile cloud runs skip the approval gate. Take explicit values, never toggles. → [references/contribution-points.md](references/contribution-points.md)
- **Prerequisites**: `onboarding.requires` only for what truly blocks the plugin; `check()` answers `'unknown'` when unsure; `requiresPlugins` with `market` for one-click install. → [references/manifest-declarations.md](references/manifest-declarations.md)
- **Self-drawn floats / HUDs and pointer math** under the host's UI zoom have their own rules. → [references/view-runtime-rules.md](references/view-runtime-rules.md)
