---
name: forsion-extension-development
description: 当用户要给 Forsion / Tangu 做插件、主题、Space、智能体(agent)或捆绑包(bundle)——或要把某个能力做成可分发/可上架商店的扩展——时使用;已装的插件 / Space / 视图不出现、加载失败、更新后不工作要排查时也用(带一份插件体检脚本 tools/check-plugin.mjs)。内置五类官方模板(samples/),讲清各自的格式基线与硬约束(尤其两种"插件"是完全不同的系统),照抄模板改比从零写靠谱。
metadata:
  version: 1.78.0
  author: Forsion
  category: Forsion
---

# Forsion 扩展开发

Forsion / Tangu 的扩展**默认按捆绑包(bundle)形态发行**(2026-07-25 起口径):一个 Forsion 插件目录内嵌 UI / 引擎插件 / Agent / 技能 / Space,装一处全就位 —— 哪怕当下只有一类内容,bundle 布局也让之后追加其它层零迁移。四类单体形态仍完整支持、互不影响(纯数据内容如主题、单个 Space 可以更轻)。每类都有一份官方模板放在本技能的 `samples/` 下 —— **先复制对应模板再改**,别从零搭。

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

## Reference files (read the one you need)

Tool results are capped, so this skill keeps long, API-by-API details in `references/` next to it. When a section below says 见下「…」 or names an API listed here, read that file before writing code:

- [references/host-ui-mounts.md](references/host-ui-mounts.md): 可复用 UI 组件：ctx.ui.mountChatBox; 原生 Markdown 编辑器 ctx.ui.mountMarkdownEditor; 原生悬浮目录 ctx.ui.mountFloatingToc; View modes: ctx.ui.setViewModes; Tooltips and motion tokens: ctx.ui.attachTooltip; Selection bar: ctx.ui.mountSelectionBar and registerSelectionAction scopes; Host parts (dialogs, toolbar controls, menus, popovers, empty states, icons, view head, i18n): ctx.ui.confirm / openDialog / mountControl / contextMenu / popover / mountEmptyState / mountWebCard / icon / setViewHead / mount, ctx.addStyle, ctx.i18n.define; Settings parts: ctx.ui.mountSettingsPage / mountSettingsItem; 白板层 ctx.ui.mountBoard / ctx.ui.boardToSvg; 仪表盘 ctx.dashboard; 原生多维表 ctx.table.mount
- [references/tangu-host-apis.md](references/tangu-host-apis.md): 当前模型与当前 Space:ctx.tangu; Agent 状态:agentStatus / subscribeAgentStatus; Agent 名册:agents; 开新对话:startChat; 把对话挂进自己的视图:mountChat; 新对话输入区:mountComposer; 正文 AI:ctx.tangu.complete 与 registerSelectionAction; 翻译:ctx.tangu.translate; 行内补全:ctx.tangu.fim; Agent Desk 伴随面:ctx.desk; 摘要栏插件卡:ctx.summary; 自动化规则播种:ctx.automation
- [references/work-folder-migration.md](references/work-folder-migration.md): one-time upgrade of old plugin data into the working folder (Identity and destination; Request and result; Upgrade sequence; Acceptance cases; Ordinary writes after upgrade)

## Troubleshooting an installed plugin: Space missing, view blank, "stopped working after an update" (2026-10-10)

When a user says a plugin's Space / view / command is gone, or that a plugin broke after updating the app or the plugin, **run the checker first** — before reading the code, and before asking the user for logs:

```bash
node "<Skill folder>/tools/check-plugin.mjs"                      # every plugin installed in ~/.forsion/plugins
node "<Skill folder>/tools/check-plugin.mjs" <plugin folder>      # one plugin, e.g. the project you are developing
node "<Skill folder>/tools/check-plugin.mjs" <plugin folder> --style   # also: its CSS against the host style contract (report only)
```

- `<Skill folder>` is printed at the top of this manual. With no argument it finds the install folder itself, so you do not need to locate the plugin first (installed desktop plugins live in `~/.forsion/plugins/<folder>/`; the folder name can differ from the manifest `id`). Add `--app-version <x.y.z>` if you know the app version.
- `--style` also checks the plugin's CSS against `tools/plugin-contract.json`, the host classes and tokens a plugin may rely on (section「样式契约」below). It only reports: the exit code stays the same.
- No `node` on PATH (the packaged app on macOS / Linux ships none)? The app binary runs it: `ELECTRON_RUN_AS_NODE=1 "/Applications/Forsion.app/Contents/MacOS/Forsion" "<Skill folder>/tools/check-plugin.mjs"`.
- It loads `main.js` the way the desktop host does (`new Function('ctx', source)(ctx)`), lists what got registered, checks every bundled Space against that, and names the lines that never ran. Read each line by its mark. **`✗` is proven from the files**: for example a `ctx.registerView` that sits inside a function nothing calls. The host has no extra step that would run that code either, so do not discount it as "only a stub" — that part is the host's result too. **`?` is undecided**: the registration sits behind a condition, or in a function something calls conditionally, and this is a dry run with stand-in host APIs and no saved plugin data or settings. Do not call a `?` a plugin bug and do not guess: settle it with the app's own record (`plugin-status`, below). `✓` means fine as far as the files go.
- To do this it executes each plugin's `main.js`, in a separate confined process (isolated context, no file writes or child processes where the runtime supports it, killed if it hangs). Plugins that are installed already run inside the user's app, so checking them is fine. For a plugin from an unknown source that is not installed yet, read its code instead of running the checker on it.

How the host behaves, so you can read the result and explain it:

- A bundled Space (`spaces/<slug>/space.json`) is shown only if **every view it names is registered once the plugin has loaded**. Otherwise the host skips it without an error: the Space is simply not on the Ribbon.
- `main.js` that throws → the plugin card in Settings → Plugins shows "failed to load". `main.js` that loads **without an error but registers nothing** → the plugin looks healthy and switched on; apps up to 2.13.1 show no badge and no message at all, later builds put a "Space hidden" badge with the reason on the card. When the checker marks that `✗`, it is a bug in the plugin's own `main.js`, not an app / plugin-API incompatibility: the registration code is not on any path that runs at load. Usual shapes: the file is wrapped in `function setup(ctx) { … }`; an earlier function lost its closing brace and swallowed the rest of the file (a stray `}` at the very end keeps it parseable). The checker names the function and its line range — read those lines next.
- **The running app's own record.** If `list_ui_commands` lists a `plugin-status` command (desktop builds after 2.13.1), also call `run_ui_command` with `{"id":"plugin-status","args":{"id":"<manifest id>"}}` (omit `args` to get whatever is wrong right now). It answers in one line what the checker cannot see from the files: whether the plugin is turned off, blocked by the host, failed to load in the real app (with the error), or waiting for a required plugin, which views it registered, and which bundled Space is hidden and why. When it and the checker disagree, the app's record is what actually happened; the checker only says what the files on disk would do. Not listed (older app, or a session without the desktop window)? Then a `✗` from the checker still stands on its own; for a `?`, say what is undecided and ask the user to look at the plugin's card in Settings → Plugins.
- Do not send the user to the developer console or ask for "host logs" first. End users cannot easily get them, and for a `✗` they hold nothing the checker does not print. Ask only after the checker and `plugin-status` have both come back without an answer.
- A diagnostic file a plugin writes for itself under `~/.forsion/plugins-data/` is a hint, not proof of where loading stopped.

Plugin authors: run the same checker before every release. It is the generic half of 通用纪律 4; your own `check.mjs` covers your plugin's logic.

## Verify a desktop plugin in the plugin sandbox before installing it (2026-10-23+)

When `plugin_sandbox` is in your tool catalog (the desktop app, a work session on this computer), verify every desktop plugin you write there **before** you tell the user it works, and never install it into their Forsion yourself:

1. `plugin_sandbox` `{"action":"start","path":"<plugin folder with manifest.json>"}` (relative paths resolve against the working folder). You get the load status (registered views, hidden Spaces, setup error, mount errors, the plugin's own console) and a screenshot of the sandbox window, with the plugin's first view open.
2. Fix what you see in the files. Saving reloads the sandbox by itself; look again with `plugin_sandbox_inspect` (`status`, `screenshot` with an optional `view` id, `logs`).
3. Exercise behaviour with `plugin_sandbox_inspect` `{"action":"command","command":"<command id>","args":{...}}`: it runs a command the plugin registered with `ctx.registerCommand`, passing `args` to `run(args)`. Register the actions you need to test as commands.
4. Tell the user it is running in the sandbox. They can open the window from the sandbox card in the chat, try it, report a problem back to this chat, and install it with **Install in my Forsion**, which asks them first.

What the sandbox is: a separate Forsion with its own empty vault and data, signed out, **without the Tangu engine**, where only this plugin is loaded. So a bundle's engine half (`plugins/`, `agents/`, `skills/`), anything that needs a signed-in account or cloud sync, and plugins that declare `fileExtensions` (blocked for dev copies) cannot be verified there; say so and test those after the user installs. Only one sandbox runs at a time; `reset` wipes its data and starts fresh; `stop` closes it.

No `plugin_sandbox` (mobile, web, cloud sessions, older desktop builds)? Fall back to `tools/check-plugin.mjs` and ask the user to try it. Coding Studio's Sandbox panel also has a **My Forsion** tier: that one loads the dev copy into the user's real app and real notes and is not isolated.

## 通用纪律

1. **先有动机再做**:每个扩展要能指回一条真实痛点,说不出就别做。
2. **注入模型的文本一律英文**:工具 `description`、参数说明、promptSection —— 给模型读的全英文;用户可见字段用 `name`/`nameEn`、`description`/`descriptionEn` 双语镜像。
3. **Stable English IDs**: external plugin manifest IDs must match `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase ASCII letters, digits and hyphens, 1–64 characters). Use an English name for new IDs; keep existing published IDs stable. Localized `name` / `nameEn` are display labels, never storage identities. Namespace command/slash/tool IDs because they share global registries; a theme ID is its `data-theme` value. Store installs use the host's immutable `market-<UUID>` effective ID; do not replace it with the manifest ID or rename historical install-folder aliases.
4. **交付=能跑+能回归**:非平凡逻辑留一个 `check.mjs`(`node check.mjs` 一条命令),范式见 `forsion-plugin-mindmap` / activitywatch 的 check 模式。
5. **动作性能力住引擎侧,渲染端命令只做导航**(2026-08-24 拍板):注册任何入口前先问一句——这是**导航**(开视图/切面板)还是**动作**(带参数、可 headless 完成的活,比如「分析这条链接」)?动作**不要**做成命令面板命令:`Command.run(): void` 类型上就没有参数位,而且命令表活在渲染进程,聊天 agent 与自动化都够不着。正确做法=把能力做成捆绑包的**引擎侧资产**,零通道基建。**先选对形态**:靠引擎已有工具就能复现的动作 → 包根 `skills/<slug>/SKILL.md`(**全局技能,默认选它**,进所有 agent 的技能目录,`use_skill` 直接用);要专属人设 / 独立上下文预算 / 稳定的自动化入口 → 才建 `agents/<slug>/` 具名 agent(+ 它自己的 `skills/`),聊天 agent 经 `delegate(agentSlug)`、自动化经 `agent_run` 调用(⚠️`agent_run` **必须指名 agentSlug**,只发全局技能的 bundle 靠被指名的那个 agent 身上带着这份技能来够到)。需要桌面主进程能力时引擎侧已有桥工具(如 `transcribe_audio` 语音转写)。范式=青鸟收藏夹:工作台 UI 归渲染端插件,分析管线归 bundle 内嵌的 `bluebird` agent+技能,两个入口(人点工作台 / agent 委派)共用同一条引擎管线。

## 引擎插件(samples/forsion-sample-plugin)

三个常用贡献点:工具(`sample_greet`)、设置 schema(`text`/`toggle`,设置页通用渲染)、`promptSection`(启用时注入系统提示)。硬约束:

- **绝不运行时 import 核心包**。对 `@forsion/tangu-agent` 只允许 `import type`(模板 tsconfig 开了 `verbatimModuleSyntax`,值导入直接编译错误)。运行时能力全走 `activate(ctx)` 的 **`ctx.sdk`** —— 否则核心的模块级单例被复制成第二份,行为诡异。
- **`dist/` 必须提交**。商店安装 = 解压源码到 `~/.forsion/plugins/<id>/`,全程不构建;改 `src/` 后必须 `npm run build`(tsc→dist/)再提交。
- **工具门禁**:`isEnabledFor` 返回 `store.isPluginEnabledSync(id)`,插件启用才对模型可见。
- **动手前问不问用户**:工具的 `capabilities.approval`。不写 = 只读,不问。`'command'` = 与 `run_bash` 同档(「询问我批准」时每次问;用户点了「总允许」或开了完全通行就不问;聊天 / 云端会话不问)。`'always'` = **每次调用都由用户本人在卡上确认**:完全通行、「总允许」、用户的 allow 规则、hook 的 allow 都跳不过,聊天 / 云端会话照样弹卡;自动化、Muse 后台、远程会话里直接被拒(工具收不到调用)。花掉用户的东西、替用户对外发内容的动作用 `'always'`。读和写拆成两个工具名,只给写的那个声明;卡上显示的是这次调用的参数原文,所以一次调用只做一件事,参数写成人看得懂的字段。
- **生命周期**:关掉插件时宿主调 `deactivate()`(限时 5s)并撤掉它注册的工具 / 命令 / 路由(meta 留着,设置页照样列出);再打开会在**同一个模块对象**上再调一次 `activate(ctx)`。所以 activate 可能跑多次 —— 别依赖模块级「只做一次」的状态,activate 里起的定时器 / 子进程 / 监听(含 `process.once`)一律在 deactivate 里收掉。
- **限时**:import + `activate` 合计限时 30s,超时按激活失败处理(设置页显示错因);超时的 `activate` / `deactivate` 宿主不会再等,但在它真正结束前**不会**再激活同一个插件(防止迟到的收尾清掉新实例),结束后自动补上。activate 里别等永远不回的连接 —— 连不上就先返回、后台重试。
- **工具 provider id 用自己的命名空间**(`plugin:<你的 id>`):两个插件撞了同一个 id,后注册的覆盖前者。
- **前置插件**:manifest `"requiresPlugins": ["other-id", { "id": "x", "minVersion": "1.2.0" }]`。前置没装 / 版本低 / 关着 / 没在跑时本插件休眠(列出但不运行),前置就位后自动激活;互相依赖成环的永不激活。
- **Putting a view on the Agent Desk**: inside a tool's `execute(args, ctx)`, `ctx.presentDesk?.({ views: [{ type: 'view', view: 'plugin:<plugin id>:<view id>' }], size: 'half' })` does what the model's `desk_present` does, but code guarantees it instead of the model remembering (computer-use presents its live view this way after the first successful action). Use optional chaining: TUI and cloud runs have no Desk. Present once per run, tracked by `ctx.runId` (fall back to `ctx.sessionId`). Leave out `name` and the host uses the view's registered title, which follows the interface language (the engine does not know it). After the user closes the Desk the host keeps it closed until their next message.
- **IM 通道:`ctx.registerChannel(spec)`(2026-10-25 起;老宿主没有,先判 `if (!ctx.registerChannel)`)**。写一个通道驱动(传输层:`kind` / `start(onMessage)` / `stop` / `status` / `send`,可选 `sendMedia` / `setTyping`,外加设置页「连接」调的 `verify()`),宿主给它内置通道的整条管线:连接即新会话、审批、`/new` `/model` 等通道命令、收件箱转发、侧栏工作区(`~/Tangu/<kind>bot`)、`channel_send_image` / `channel_send_file`,以及「设置 → 通道」里的一张卡。`spec` 里写双语 `name` / `hint` 和 `fields`(凭据,键只能是 `appId` / `appSecret` / `botToken`,`secret: true` 的不回显,全部填齐才启动);驱动经 `ctx.sdk.channelSettings(kind)` 每次现读凭据。`kind`:小写字母开头、`[a-z0-9-]`、2–16 字符、不能与 `wechat` / `telegram` / `qq` 撞,非法或撞名 activate 抛错。`onMessage` 恒立即回 `''`,回复都经 `send` 推(可能晚到几分钟,别依赖「回复这一条」的时效窗口);`peerId` 由驱动编码、同一聊天恒定。停用插件 = 宿主完全停止该通道(挂起的审批按拒绝),绑定保留。只在本机引擎生效。实例:Forsion-Instrumentality-Project `forsion-plugin-wecom`(企业微信长连接;Node 自带 WebSocket 连不上企业微信网关,`ws` 用 esbuild 打进 dist)。
- **只给官方插件的三样(2026-10-27 起;第三方插件写了也没用)**:`ctx.cloud`(以用户的 Forsion 账号请求云端,只放 `GET /api/market/mine` 与 `POST /api/market/mine/<id>/update[?dryRun=1]`)、工具的 `capabilities.approvalPreview(args) => string`(自己写审批卡文案)、以及进聊天(Chat 预设)会话的工具面。「官方」= 插件在 Forsion 签名的捆绑包里(包根 `SIGNATURE` 用引擎钉死的公钥验过,插件的 `tangu-plugin.json` 和入口都签在里面);其余插件拿到的 `ctx.cloud` 是 `undefined`、`approvalPreview` 被忽略(卡上照旧是参数原文)、工具进不了聊天会话。别为第三方插件设计依赖它们的功能。
- 类型契约 `types/tangu-agent.d.ts` 是 apiVersion 1 的 API 拷贝,随模板分发;宿主升 apiVersion 时替换它并同步 manifest 的 `apiVersion`。

装本机:整夹拷到 `~/.forsion/plugins/<id>/` → 设置页重扫即生效,不用重启。同 id 覆盖升级也是重扫即热换代:单文件入口(esbuild 打成一个 bundle,推荐)直接换;多文件的**纯 ESM** 包(`"type": "module"`,入口相对 import 同包文件)在 Node ≥ 22.15 上也能整包换代。宿主证明不了整张模块图都会换代的,如实标「需重启」:包里有 CommonJS(`.cjs`、`require('./x')`、`createRequire` 造的函数)、原生 `.node`、任一层自带 `node_modules`、软链、`import(变量)`、引到插件目录外的文件,或运行时太旧。同一进程里热换代满 20 次后也一律「需重启」(旧模块卸不掉,省内存)。

## 主题(samples/forsion-sample-theme)

双轴模型:**语言(结构:圆角/字体/阴影/布局)× 配色(颜色)× 明暗**。磁盘主题装 `~/.forsion/themes/<id>/`,**目录名必须 == id**。

- 主题 CSS 是**全局注入**(非隔离),因此**每条规则都要 scope 在 `[data-theme='<id>']` 下**,否则污染其它主题。
- **不要硬编码颜色**:配色由 skin 提供,主题只定结构,消费 `var(--bg)`/`var(--text)`/`var(--accent)` 等词表 token —— 这样任意配色/明暗都成立。
- **正文行距、段距和切视图的时长归用户的外观开关管**(见下文「外观开关:跟着宿主走」):主题别用更高权重的规则把笔记 / 对话正文的
  `line-height`、段间距或 `wb-view-enter` 的时长写死 —— 写死了,用户拨那几个开关就没有反应。
- 可选 `settings[]`(number/select/boolean/color)让用户在设置页调主题内参数:`key` **就是** CSS 自定义属性名,宿主把值写进 `:root` 内联变量,主题用 `var(--key, 默认值)` 消费。参考本仓内置 `genesis-glass` 主题(`desktop/frontend/src/theme/themes/genesis-glass/`)。

## Space(samples/forsion-sample-space)

`space.json` 声明视图布局配方(引用视图类型 id;插件视图用 `plugin:<插件id>:<视图id>` 并在 `requires.views` 声明)。纯数据,无代码。

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

Space 需要显式声明 `mini` 才会出现在 Mini Panel。它是一块扩展面板：默认 320×420，用户可拖卡片的边和角在 260×160 到 640×900 之间改大小（自动弹出的临时 Mini 固定 320×420），单层宿主栏提供 Space 切换、在主面板显示、关闭；只设计本能力的快捷交互，不复制应用导航、设置、标签管理或移动端抽屉。

Computer Use 占用外部应用前台时，宿主可临时打开 Tangu Mini 观察当前运行会话，无需用户先打开 Mini。自动窗口的焦点、跟随、会话同步与收起由宿主管理，不覆盖手动 Mini 的状态；插件无需监听前台信号或新增适配字段。

```json
"mini": {
  "name": { "zh": "快捷记录", "en": "Quick capture" },
  "view": { "type": "plugin:my-bundle:quick", "params": { "itemId": "today" } },
  "mainView": { "type": "plugin:my-bundle:detail" }
}
```

- `view` 与 `mainView` 都是 `{type, params?}`；必须使用**不同的已注册视图类型**。缺少适配或视图未注册时不显示在 Mini 中，完整 Space 仍可用。不要把可选 Mini 类型放进 `requires.views`，否则旧宿主会拒绝整个配方。
- 在 `mount(el, view)` 中用 `view.surface === 'mini'` 识别容器；老宿主这些字段可缺省。Mini 不提供 `extendView`。
- `view.getParams()` 读当前实体/筛选参数，`view.setParams(patch)` 合并更新，`view.onParamsChanged(fn)` 订阅后返回取消函数。参数更新不重挂 DOM；自己更新需要变化的内容，避免丢失正在输入的草稿。
- `view.showInMainPanel?.()` 打开 `mini.mainView`，同一份当前参数覆盖 `mainView.params`。两边使用相同实体键（如 `itemId`/`notePath`），不要另建一份业务数据。宿主顶部已有按钮，不必重复绘制。
- `mount` 返回清理函数，停止订阅/计时器并保存必要内容。旧实例的 context 在关闭、切换 Space 或禁用后失效，异步回调不得继续调用。
- 插件级清理:`main.js` 就是 `setup(ctx)` 的函数体,末尾 `return () => { … }`(async 时 resolve 出函数)就是整个插件的清理,停用 / 重载 / setup 失败时宿主调用。`ctx.register*`、`ctx.ui.*`、`ctx.addStyle`、`ctx.subscribeLocale` 这些宿主自己收;只有你自己挂到 `window` / `document` 上的监听、定时器、元素才需要写在这里。
- 布局跟随容器，不要写死 320×420：窄到 260、矮到 160 时内容自己滚动或省略，不撑出横向滚动条。
- 按中英、亮暗、320×420 与最小 260×160、实体定位与插件启停验证。参考捆绑包模板的 `mini-counter` / `counter` 视图及 `spaces/sample-bundle-mini/space.json`；Genesis 回归命令为 `desktop` 下 `npm run check:minicard`。

插件只有一块快捷视图、不值得为它建完整 Space 时，直接调用开放接口：

```js
ctx.openMiniPanel?.('mini-counter', {
  title: 'Counter', params: { itemId: 'today' },
  mainViewId: 'counter', mainViewParams: { section: 'inbox' },
})
```

`viewId` / `mainViewId` 都写**本插件相对 id**，宿主自动加 `plugin:<pluginId>:`，省略 `mainViewId` 就把同一视图交回主面板。仍须先 `registerView`；Web/mobile 或旧宿主可能没有原生 Mini，务必可选链并保留 `ctx.openView()` 回退。

## 智能体(samples/forsion-sample-agent)

文件夹式:`config.toml`(模型/工具/技能开关)+ `SOUL.md`(人设,英文写给模型)+ `Library/`(参考资料)+ 每-agent 记忆。装 `~/.forsion/agents/<slug>/`。

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

**三种生命周期,发包前必须分清**:

| | 谁 | 升级时 |
|---|---|---|
| **随包** | 引擎插件、Space | 父插件禁用即级联关闭/收起,卸载一并消失 |
| **播种一次** | Agent 的**人格面**(config.toml / SOUL.md / Library / MEMORY) | 首次发现拷入引擎成为活体,**永不覆盖**,卸载保留 |
| **指纹自愈** | Agent 的 `skills/`(2026-08-25 起) | 每次启动比指纹:用户没动过的跟着 bundle 更新;动过的(含无指纹老副本)保护不覆盖并在引擎日志报出来 |

**上架商店后的安装目录与运行身份(2026-10-17 起)**:商店给每个条目一个不会变的 ID,新上架的条目装进 `plugins/market-<ID>/`(引擎插件是 `~/.tangu/plugins/market-<ID>/`),和显示名无关,显示名可以重复。装在这种目录里的插件以目录名为运行身份:包里的引擎插件照常按这个目录名挂 scoped 路由,`ctx.tangu.request` 由宿主拼好,不用管;单独上架的引擎插件 `ctx.paths.dataDir` 在 `plugin-data/market-<ID>/`,注册的工具名会被宿主改写成 `market_<原名前 16 位>_<哈希>`(两份同 id 的插件互不顶替),所以提示词和文档里别让模型按字面工具名去调;`sdk.runs.start` 的 `toolNames` 与 `sdk.automation.save` 的 `tool` 照写原名,宿主自己换。别的插件在 `requiresPlugins` 里写你 manifest 的 `id` 照样认得到,前提是只装着一份。这种条目只有 2.13.4 之后的桌面版本装得了,旧桌面会收到「请先升级 Forsion」。更早上架的条目保留原来由显示名推出的目录名:其中带引擎插件的包在桌面 2.13.3 及更早的版本上,目录名和 manifest `id` 不一样时页面调不到包里的引擎插件(每次 404、不报错)。没有引擎插件的包不受影响。

包根 `skills/`(全局技能)是原地扫描、不落盘拷贝,不在上表内。因此 onboarding 里**不要** recommends 自家已内嵌的 agent/skill(会引导去商店重复装)。真实范例:`Forsion-Instrumentality-Project/bluebird/`。

### 插件自带的 MCP server 与 hooks(2026-10-17 起;只收 stdio MCP、只开观察档 hooks)

两样都写在**包里引擎插件的 `tangu-plugin.json`**(不是包根的 `manifest.json`),开关就跟着引擎插件走:捆绑包在桌面上拨开关时级联到引擎插件,所以「停用插件 → 它的 MCP 进程和 hooks 一起停」是现成的。两样都要在插件**进入运行态之后**才登记,启动时随即休眠的插件不会拉起子进程。入口里照常 `ctx.registerPlugin({ id, name, … })` 登记一次 —— **没登记的引擎插件没有开关**(引擎当它常开),桌面停用捆绑包时级联关不到它,MCP 进程就一直开着;只想带 MCP / hooks 的插件不注册工具也行,但这一步不能省。

```json
{
  "id": "my-plugin", "name": "My plugin", "version": "1.0.0", "apiVersion": 1, "entry": "dist/index.js",
  "mcpServers": {
    "mytools": { "command": "node", "args": ["${pluginDir}/mcp/server.js"], "env": { "DATA": "${pluginDir}/data" } }
  },
  "hooks": {
    "PostToolUse": [{ "matcher": "write_file", "hooks": [{ "type": "command", "command": "node ${pluginDir}/hooks/audit.js" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node ${pluginDir}/hooks/archive.js" }] }]
  }
}
```

- **MCP 只收 stdio**(随包发的静态 server):要有 `command`,`url` / `headers` 不收 —— 远端 server 的地址与令牌是运行期数据,写不进 manifest。能力在某台服务端的,照旧让**服务端自己出 MCP 端点**、插件只做「接入卡」(先例 = server-admin 的「接入 Agent(MCP)」+ server `microserver/admin-mcp/`)。
- `${pluginDir}` 在 command / args / env 里展开成插件目录的绝对路径;stdio 子进程的工作目录就是插件目录。子进程拿不到引擎凭据(同用户自己配的 MCP)。
- 工具名照常是 `mcp__<server 名>__<工具>`,server 名用你声明的那个(≤32 字符,字母数字 `_` `-`),取得短而独特;**和用户自己配的 server 撞名时你这份不起**,在设置 → MCP 里显示成错误。设置 → MCP 只读列出插件自带的 server(写着来自哪个插件),用户要关就停用插件。只在本机引擎上生效,云端 worker 没有 MCP。
- **hooks 只开观察档**:`SessionStart` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop`。hook 照常跑、照常从 stdin 收事件 JSON,但**输出一律不进判定**:`decision: block`、退出码 2、`continue: false`、`additionalContext` 都没有效果 —— 拦不住工具、停不了循环、也往对话里加不了东西。`PreToolUse` / `PermissionRequest` / `UserPromptSubmit` / `PreCompact` 不收(那是审批面的一部分)。适合审计、会话归档、写完文件跑一下自己的索引。设置 → Hooks 只读列出它们(「来自插件 X · 只观察」),排在用户自己的 hook 之后。
- hook 和 MCP server 都是插件自己的代码,信任级别与引擎插件相同,装上即生效、不走「需审阅」;**别在 hook 里做慢事**(它在 run 的关键路径上,会拖慢每一次工具调用),也别把用户数据往外发。

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

### 投稿元数据、版本要求与评论(2026-10-17 起)

- 投稿表单可填:标签(≤8 个,每个 ≤40 字)、长描述(详情页「内容介绍」)、支持平台(`desktop` / `macos` / `windows` / `linux` / `android` / `ios` / `web`)、Forsion 版本范围(`minAppVersion` 含、`maxAppVersion` 不含,语义化版本号)。
- 包里 manifest 的 `minAppVersion` / `maxAppVersion` / `platforms` 优先于表单;已有的 `isDesktopOnly: true` 等同只支持桌面。桌面和手机安装前都会读包里的 manifest 再核一遍,不符就不下载、不写盘;旧版本的过审包和快照会留着,用户可以在「版本」栏装回历史版本。
- 不写版本范围 = 「未知」,商店照常展示但不算确认适配;靠新宿主接缝的插件写 `minAppVersion`,已知在某个版本坏掉的写 `maxAppVersion`。
- 每个条目有公开评论区(登录可评、可回复、本人可改可删)。新评论发到投稿账号的收件箱,回复通知被回复者;作者可以在评论区关掉全部或单个插件的评论消息。
- Tangu 在聊天里可以用 `search_marketplace` 搜商店、给用户推荐(画成插件卡片,装不装由用户在卡片上点),所以标签和描述写清能力,别堆营销词。

### Android App 与 `isDesktopOnly`(2026-10-02 起)

Forsion Android App 也跑 Forsion 插件(同一份 `pluginStore`、同一个 `ctx`),**只经市场装**、只装 `amadeus-plugin` 类;插件住在 App 私有目录,`ctx.loadData` / `ctx.saveData` 照常可用。
- 依赖桌面才有的东西(本机程序 / Node / `ctx.app.hostPath` 必须非 null / 引擎插件 / 浮窗)且没有降级路径的,manifest 写 `"isDesktopOnly": true`(只认布尔 `true`):手机市场拒装并说明原因,已在列表里的显示「仅支持桌面端」且代码不执行。桌面上这个字段不影响任何行为。
- 能在手机上跑的,照「能力判断运行环境」写:`openFloatingPanel` / `openMiniPanel` 手机没有(可选链),状态栏项手机不显示,捆绑包里的引擎插件 / Agent / 技能手机不装(手机上没有本机引擎)。
- 捆绑包里的 **Space**(`spaces/<slug>/space.json`)手机上照常注册(2026-10-09 起;此前不装),出现在底部导航栏,图标用 `iconFile` 那张 PNG(没有或是 SVG 就用 `icon` 的线条图标)。手机是单列:进这个 Space 先看到 `layout.main` 的第一个视图,`left` / `right` 是从顶栏按钮拉出来的抽屉,`bottom` 不开 —— 主视图要在约 400px 宽里独立可用,别把必经的操作只放在左栏或底部面板里。
- 手机上插件包的上限:下载 25 MB、解压 64 MB、2000 个文件。
- 手机的**主页只有一页、不开标签**(2026-10-11 起):用户停在主页时,命令里 `openView` 打开的视图会被带到「主人」那个 Space 去开 —— 主人 = `layout.main` 里列着这个视图的 Space(插件自带的 Space 就是这么认的)。没有任何 Space 列着它的视图仍然盖在主页上打开,但用户下次回到主页时会被宿主关掉:这类视图别攒没保存的状态,要长驻就给插件带一个 Space。
- 手机没有 ribbon:插件的 `registerCommand` 命令由宿主按插件分节列进顶栏「⋯」菜单(节标题 = 插件展示名),`checked` 开关在那里显示为勾选态 —— 命令 `title` 要能独立看懂(手机上它就是菜单行文案)。

## Agent 自建 Space(2026-09-11 起;Muse 首例)

一个 agent 自己的 Space = 它目录下的一个桌面插件:`<tangu>/agents/<slug>/Space/{manifest.json, main.js}`,与普通桌面插件**同一份契约**(manifest + main.js,`registerView` / `registerCommand` / `registerStatusItem` / `registerSetting` / `notify` / `loadData` 都能用),但有五条不同:

> ⚠️ **main.js 整个文件就是 `setup(ctx)` 的函数体**(宿主 `new Function('ctx', code)(ctx)`):`ctx` 已在作用域里,顶层直接写 `ctx.registerView({ id: 'home', … })`。**别**写成 `function setup(ctx) { … }` —— 没人调用它,求值只声明了一个函数,零注册、零报错。09-27 实机:Muse 的 Space 每一版都这么包,从首建起空白了 16 天,它自己还一直在「升级」。

1. **id 固定 `agent-<slug>`**,manifest 里的 `id` 被无视 —— 写别家的 id 也顶不掉真插件;
2. **主槽 = `registerView({ id: 'home', … })`**:桌面该 agent 的 Space 主区渲染这一个视图,其它视图照常 `ctx.openView` 开标签页;
3. `capabilities` / `fileExtensions` / `requiresApp` / `onboarding` / `events` 一律不生效(没有「用户点安装」这步授权),bundle 子目录(引擎插件/技能/agents/spaces)也**不生效**(引擎只认一个 bundle 根);
4. 纯 JS、无构建、无 CDN(CSP `default-src 'self'`);想用库就内联进 main.js;
5. **不监听文件**:桌面按引擎在你周期收尾时打的内容戳重载,所以一个周期里改完再收尾即可;加载失败(setup 抛错 / manifest 缺失、坏或被 apiVersion·minAppVersion 挡下 / 装上了却没注册 `home` / `home` 的 mount 抛错)会以 `[feedback]` 行回到你的日志,下个周期修。**没收到 feedback 不等于用户看到了你的 Space** —— 它只在桌面打开过 Muse Space / Muse 面板时才会发。

### `ctx.agent`:读写你自己的数据(2026-09-27 起,**只有 agent 自建 Space 有**)

Space 应该**从数据渲染**,别把状态、时间、待办写死在 main.js 里、每个周期改一遍 —— 那既浪费你的额度,用户看到的也永远是旧的。
`ctx.agent` 只在 `agent-<slug>` 插件上存在、只能碰你自己这个 agent(普通插件整个没有;今天只有 Muse 有数据源):

| 成员 | 说明 |
|---|---|
| `slug` | 你的 agent slug(如 `'muse'`) |
| `status()` | `{ running, lastCycleAt, sleepUntil, sleepReason, mode, heartbeatMinutes, pendingApprovals }` 或 null |
| `todos(status?)` | 你提过的 TODO:`{ id, title, detail, status, createdAt }[]`;`status` 缺省 = 全部(`'pending'` / `'done'` / `'dismissed'` / `'injected'`) |
| `updateTodo(id, 'done' \| 'dismissed')` | **只在用户刚在你自己的视图里点过之后生效**(在你 Space 上按钮的 click 处理函数里调;宿主只认本视图里 1.5 秒内的真实点击 / 按键),挂载时 / 定时器 / 订阅回调 / 借别处的点击调一律 reject;效果同 Muse 面板的按钮,会以「用户处理了」的 `[feedback]` 回到你的日志;只改仍是 pending 的 |
| `schedule()` | 你 SCHEDULE.db 的条目:`{ id, name, date, repeat, auto, description, lastRun }[]` |
| `library.list()` / `library.read(path)` | 你的 Library:目录树 / 读一个文本文件(相对路径如 `'Journal/2026-09-27.md'`,≤1MB;越界、隐藏文件、不存在 → reject) |
| `subscribe(cb)` | 周期结束、睡醒、待批数或待办数变化、`updateTodo` 之后回调(宿主约 20 秒查一次);返回退订,禁用/重载宿主统一收 |

数据调用(status / todos / schedule / library / updateTodo)是 Promise,后端没就绪会 reject —— 自己画空态,别让 mount 抛错(mount 抛错也会以 `[feedback]` 回到你);`subscribe` 同步返回退订。
**挂载之后没接住的错也回到你**(2026-09-27 起):宿主给你当前这一版的代码打了 `sourceURL`,异步回调 / 事件处理 / 定时器 / 订阅回调里没接住的错,栈里有你的帧就以 `[feedback]` 回写、带 `main.js` 的行号(同一条只报一次,每版最多 3 条)—— 包括你 `await` 的宿主接口 reject 了你没接(异步栈里有你那一帧,行号落在 `await` 那行)。旧版漏清的定时器在重载后抛的不算。
手势闸防的是「顺手写个定时器 / 挂载时就标掉」这类失误,**不是安全边界**(插件与宿主同一个渲染进程);审批队列不开放。

```js
ctx.registerView({ id: 'home', title: 'Muse', mount(el) {
  const draw = async () => {
    const [st, todos] = await Promise.all([ctx.agent.status(), ctx.agent.todos('pending')]).catch(() => [null, []])
    el.replaceChildren()
    for (const t of todos) {
      const b = document.createElement('button')
      b.textContent = `✓ ${t.title}`
      b.onclick = () => ctx.agent.updateTodo(t.id, 'done').then(draw, () => {}) // 只能在点击里调
      el.append(b)
    }
  }
  draw()
  return ctx.agent.subscribe(draw) // 退订函数正好当 disposer
} })
```

## 桌面插件:贡献点全表(动手前先看这张表)

`ctx` 上的注册口就这些 —— **内置与外置拿到的是同一份**(`pluginStore.makeContext`,能力对等原则)。
细节正典 = 仓根 `docs/Function/生态内容制作指南.md`(本表每一行都能在那儿找到对应小节);
类型契约 = `Forsion-Genesis/desktop/frontend/src/amadeus/plugins/types.ts`。

| 贡献点 | 给用户的入口 | 备注 |
|---|---|---|
| `registerCommand` | 命令面板(+ 可选 agent 面) | `title` 可传 `() => string` 跟随界面语言(2026-10-02+,老宿主只认字符串);id 处于全局命名空间,裸名会互顶;默认只做导航,**动作性能力要么走引擎侧 agent/技能(通用纪律 5),要么给这条命令声明 `invoke`**(见下) |
| `registerSlashItem` | 笔记里的 `/` | 静态 `scaffold`,或动态 `run()`(先建文件再返回嵌入语法);`label` / `group` 传函数则跟随界面语言 |
| `registerSelectionAction` | 选中文字后浮出的那一条(划线条)里「⋯ → 插件」 | `run(cx)` 返回要给人看的 markdown,**只进宿主的结果卡**:笔记里用户点「替换 / 插入下方」才写,别处只读;`scope` 决定出现在哪些视图(缺省只在笔记),见下「Selection bar」。桌面 2.13.3 及更早在「AI ▾ → 插件」、只有笔记里有 |
| `registerView` | 独立标签页(`ctx.openView(id)` 打开) | `title` 2026-10-26 起收 PluginText;**DOM 挂载**(`mount(el, view?)` 返 disposer;可以是 async —— resolve 出的就是 disposer,reject 算挂载失败;`view.extendView` 可开临时扩展),外置插件的主力;加 `rightCompanions` 声明它到前台时右栏要的那组(见「右栏:主视图规则」);`workspaceSource` 只对没写 `mode` 的老配方的左栏生效。**样式不隔离**:选择器挂自家根类名,配色只用 `var(--bg)` / `--bg-card` / `--text` / `--text-muted` / `--border` / `--accent`(自造的变量名宿主没有,会落到你写死的兜底色) |
| `openFloatingPanel` | 第六种 Floating Panel | 先注册 view，再按相对 id 打开；桌面是真原生窗口，Web 是不可拖动居中面板；可选链兼容旧宿主 |
| `openMiniPanel` | Mini Panel（默认 320×420，用户可改大小） | 不建 Space 也能直开紧凑 view；用 `mainViewId` 声明回主面板的目标；仅原生桌面宿主提供 |
| `registerListSource` | **统一左栏**里的一条列表(收藏/任务/订阅…) | 宿主渲染,与会话/笔记行同一套 UI;⚠️`subscribe()` 里**必须重读一次数据**,见下。`title` / 动作 `label` 2026-10-26 起收 PluginText(`() => t('…')` 或 `{ zh, en }`,切语言即变;字符串在注册那一刻定格);`empty: { icon, title, line?, action? }` 让侧栏在你的 Space 里不写「暂无内容」、手机整屏列表画这份空态 |
| `registerFileType` | 自定义 `.x.md` 文件类型;`override: true` 可接管内置的 `.pdf` | 撞内置后缀返回 **`false`** → 整体退让(判定写 `=== false`) |
| `registerFileCreator` | 文件树右键 + 新建标签页启动器 | 与文件类型配套;**四条新建路径都要注册**,少一条用户就会问「为什么这儿没有」 |
| `registerEmbedRenderer` | `![[x]]` 嵌入的自绘渲染 | |
| `registerToolResultRenderer` | 对话里**你自己引擎半身注册的工具**跑完后的结果卡片(可直接进 Agent Desk) | 2026-10-19 起;别家插件的、核心的工具认领不了(唯一例外:签名的 Forsion Extend 画 `publish_web_page` / `forsion_account`);2026-10-28 起可带 `match({ tool, args })` 按参数收窄;老宿主没有 → `ctx.registerToolResultRenderer?.(…)`。见下「Tool result cards」 |
| `registerSetting` | 详情页声明式表单(number/boolean/text) | 每键一个字符串,**没有原子性**;同 key 重注册即覆盖 |
| `ctx.ui.mountMarkdownEditor` | 视图内原生 Amadeus Markdown 编辑器 | 正文归调用方(API 草稿等),**不碰笔记库**;保存前 `getValue()`;`modes: false` 不画「编辑 / 源码 / 预览」那一排;老宿主没有 → 可选链 |
| `ctx.ui.mountFloatingToc` | 视图内原生悬浮目录 | 插件保有正文 DOM,宿主负责扫描 / 滚动高亮 / 跳转 / 主题;老宿主没有 → 可选链 |
| `ctx.ui.setViewModes(el, spec)` | 视图的几种「看法」(转写 / 笔记 / 纪要、文档 / 画布这类同一份东西换摆法) | 2026-10-19 起;宿主把胶囊画在视图头行最左,⌥⌘V、命令面板「看法：X」、窄宽变形、手机顶栏都归宿主;2–4 种,`icon` 用图标词表名;句柄 `actions` = 同一行右边,把自己栏里的按钮挪进去;记忆归你(按记录 / 文件记);老宿主没有 → 可选链,保留自己的标签。见下「View modes」 |
| `ctx.ui.attachTooltip(el, content, opts?)` | 按钮 / 图标的悬停提示,和宿主自己的按钮同一个 | 2026-10-23 起;300ms 才出、弹着移到相邻触发点直接接力、键盘聚焦立刻出不做动画、按下 / 滚动即收;`content` = 一行或几行(首行标题);`side` 缺省 top、放不下翻面;句柄 `{ update, dispose }`,禁用时宿主统一收;留 `aria-label`、去掉 `title`;老宿主没有 → 可选链,照旧 `title`。见下「Tooltips」 |
| `ctx.ui.dropIndicator(opts?)` | 自己视图里拖动排序 / 拖进去时的落点线、「放进去」描边,和宿主编辑器 / 侧栏 / 标签条同一个 | 2026-10-24 起;句柄 `{ line, zone, hide, dispose }`,传视口坐标(`line({x,y,w})` 横线 y=上沿、`{axis:'v'}` 竖线、`zone({x,y,w,h})` 描边);换落点原地淡出淡入、颜色 `--signal-line`;给 `key`(行 id)滚动才不算换落点;dragleave / drop 时 `hide()`,禁用时宿主统一收;老宿主没有 → 可选链,照旧自己画。2026-10-25 起句柄多一个 `land?(行或找它的函数, 松手处)`:挪完之后被拖的那一行从松手处滑进新位置(160ms,减少动态效果下直接到位),邻居不让位。见下「Drop indicators」 |
| `ctx.ui.mountSelectionBar` | 自己的视图里选中文字后浮出宿主的划线条 | 宿主给「问 Tangu / 翻译 / ⋯」,你声明自己的工具(图标钮 / 颜色点);不接就什么都不出;老宿主没有 → 可选链,保留自己的菜单 |
| `ctx.ui.mountSettingsPage` / `ctx.ui.mountSettingsItem` | 设置类页面(账号、额度、诊断、偏好…)用宿主的设置零件画 | 只给 groups / items 数据和回调,宿主按端排版(手机上紧凑控件留右、宽控件换行、选了就执行 → 半屏);**别再抄宿主的设置 CSS**;老宿主没有 → 可选链,保留自己画的那套 |
| `ctx.ui.mountRecord` | 自己的卡片里挂宿主的「一行记录」编辑字段(标题 / 时间 / 属性,和内置日历的事件浮卡同一份) | 2026-10-17 起;⚠️**声明 `"databases"` 才有**;写口同 `ctx.databases.setCell`,外框 / 关闭 / 打开 / 删除归你;见下「日历 / 待办类插件的其余入口」 |
| `ctx.ui.haptic?.('tick')` | 移动端一次已接受操作的轻触反馈 | 2.13.7+；只有原生触感设备才存在，遵循系统设置。只在用户动作写入被接受后调用一次，撤销／同步不调用；不要拿浏览器震动模拟原生反馈 |
| `ctx.ui.claimHeader?.({ title, back, onBack })` | 移动端覆盖层临时原生顶栏 | 2.13.7+；返回 `{ dispose() }`，覆盖层关闭时释放。插件停用会自动撤销顶栏和回调；没有原生栏的宿主缺省不提供 |
| `ctx.ui.contextMenu(x, y, items, opts?)` / `ctx.ui.contextMenu({ anchor, align }, items, opts?)` | 宿主样式的右键菜单(和内置主页、Ribbon 的一样) | 2026-10-26 起:行可带 `icon`(词表名)/ `shortcut`(键位提示),条目可以是 `{ separator: true }` / `{ section: '小节' }`,第一个参数可以是 `{ anchor: 按钮, align: 'end' }`(宿主量按钮、管缩放),`opts.onClose`;Android 上同一份数据走原生底部抽屉;更早的宿主把这些字段静默丢掉、只认 (x, y)。2026-10-18 起;`items` = `{ label, run(), checked?, disabled?, danger? }`,视口坐标、放不下自己翻面,限高、项多 / 窗口矮时自己滚(最多 200 项);同一时刻只开一个,点外面 / Esc / 点了某项就关;返回关闭函数;老宿主没有 → `ctx.ui?.contextMenu?.(…)`。**勾选清单连勾**:`opts.keepOpen: true` 点了不关,你改完状态调返回句柄的 `close.update(items)` 换一份行 —— ⚠️勾和 `run` 都要换成新的;连点两下可能赶在重画之前(用的还是旧那份行),所以 `run` 里读**当下**的状态(ref / store),别只靠闭包,不然第二下会把第一下吞掉;空列表 = 关。更早的宿主不认 `opts`、点了照关,也没有 `update`(拿 `typeof close.update === 'function'` 判) |
| `ctx.ui.confirm(opts)` / `ctx.ui.openDialog(opts)` | 宿主的是 / 否确认框、带挂载区的对话框 | 2026-10-26 起;`confirm` → `Promise<boolean>`(`danger` 主按钮红、焦点落「取消」;Android 原生确认框);`openDialog({ title, body?, mount?(el), actions?, width? })` 420 / 560px 居中,Esc / 遮罩 / 焦点圈 / 进出场归宿主,`run` 返回 `false` 不关。别再用 `window.confirm` 或自己画 `<dialog>`。见下「Host parts」 |
| `ctx.ui.mountControl(el, { type: 'segmented' \| 'select', … })` | 视图头 / 工具栏里的分段与下拉 | 2026-10-26 起;分段 = 看法胶囊那一份(2–5 项),下拉 = 28px 文字钮 + ▾、点开是菜单外壳的 listbox(6 项起带搜索,Android 原生抽屉)。**设置零件是 56px 的行,别放进工具栏** |
| `ctx.ui.popover(anchor, { mount(el), side?, align? })` | 按钮下方的小面板(筛选、快捷设置) | 2026-10-26 起;宿主 `.ui-popover` 外壳(同菜单材质)、锚定 / 夹边 / 缩放 / Esc / 点外面关都归宿主;别自己算 `left/top` |
| `ctx.ui.icon(name, { size })` | 自己的按钮里画词表图标 | 2026-10-26 起;返回新的 `<svg>`(currentColor);**一张词表**:Space(`space.json` 的 `icon`)、列表、菜单、设置、视图标签、控件、空态都认同一份名字(`PluginIconName`);词表外的名字回落并在控制台警告一次(带近似名)。别再手抄 lucide 路径 |
| `ctx.ui.mountEmptyState(el, { icon, title, line?, action?, secondary? })` | 主区的空态 | 2026-10-26 起;与内置视图、列表源 `empty` 同一个 EmptyState;别借宿主的 `.empty-state` 类名(那份 CSS 只是碰巧被别处加载过) |
| `ctx.ui.mountWebCard(el, { name, status?, address?, note?, thumbnail?, actions?, trailing?, menu?, layout? })` | 网页卡片卡身:缩略图、名字 + 状态、地址、说明、按钮 | 2026-10-28 起;和宿主自己在对话里给 HTML / 本地服务画的那张同一份;`thumbnail: { url, version }` 由宿主主进程截图(只收 http(s),换 `version` 才重拍),拿不到画占位图标;`layout: 'row'` = 列表里一行;`update` 带了键、值是 `undefined` / `[]` / `null` = 清掉 |
| `ctx.ui.setViewHead(el, { title?, actions? })` | 视图的 32px 头行:左标题、右按钮 | 2026-10-26 起;不用先有看法;与 `setViewModes` 并存(胶囊在前) |
| `ctx.ui.mount(name, el, props)` | React / Vue 插件在 ref 上挂宿主零件 | 2026-10-26 起;`'menu' \| 'popover' \| 'dialog' \| 'segmented' \| 'select' \| 'emptyState' \| 'webCard' \| 'icon'`,props 有类型(`PluginUiParts`),返回 `{ update, dispose }`;**不要打包宿主组件的替身**(菜单、浮层、对话框、图标、i18n) |
| `ctx.addStyle(css)` / `ctx.i18n.define({ zh, en })` | 样式表 / 双语词表 | 2026-10-26 起;`addStyle` 停用 / 重载时宿主摘掉(别再 `document.head.append`);`define` 返回 `t(key, vars)`,回退链 当前语言 → zh → key,缺 en 的键警告一次;配合 PluginText 传 `() => t('key')` |
| `ctx.ui.mountBoard` / `ctx.ui.boardToSvg` | 盖在自己内容上的透明白板层(手写 / 圈画) | 和 `.excalidraw.md` 白板同一个引擎、同样的七支笔;**视口归调用方**(自己推 `viewport`、自己接滚轮);元素原样存取;不在手写时用 `boardToSvg` 出静态图;老宿主没有 → 不出手写入口 |
| `ctx.table.mount` | 面板里的原生多维表(只读) | 一份规格 → 真 DbTable(筛选/搜索/隐藏列/排序/统计全套),**不依赖笔记库**;老宿主没有 → 可选链 + 自己的表格降级(见下) |

#### Extend View:随主视图挂载的临时扩展(2026-09-05)

`registerView.mount(el, view?)` 在 Main View 中的第二参提供 **`view.extendView`**。用它承载新增/编辑表单、详情或临时工具;
宿主创建临时原生 View,加入现有 Left / Right / Bottom Panel 的标签组,由主视图管理生命周期。
不需要为每个插件 `registerView` 第二个常驻视图,不进永久视图目录、导航历史或布局存档。
原生标签栏保持可见,可在原有 View 与临时 View 间切换且保留草稿;宽度/高度沿用 Panel 设置。
侧栏原先收起时按需展开;关闭临时 View 后返回原有 View,仅有临时 View 的面板随之收起。
使用原生折叠按钮会收起整个 Panel 并销毁临时 View;再次展开仅还原常规 View。
内置 React 主视图从 `ViewProps.extendView` 取同一接口;侧栏 View、Dashboard 嵌卡和无侧栏的 mini 窗口没有这个接口。

```js
ctx.registerView({ id: 'items', title: 'Items', mount(el, view) {
  const button = document.createElement('button')
  button.textContent = ctx.getLocale().startsWith('zh') ? '编辑' : 'Edit'
  button.onclick = () => view?.extendView?.open({
    id: 'editor',
    title: () => ctx.getLocale().startsWith('zh') ? '编辑条目' : 'Edit item',
    side: 'right', // left / right / bottom;默认 right
    mount(body, handle) {
      const input = document.createElement('input')
      input.setAttribute('aria-label', 'Item name')
      body.appendChild(input)
      // 保存成功可调用 handle.close();失败时保留输入并提示。
      return () => { input.remove() } // 清理订阅/监听器/计时器
    },
    onClose(reason) { /* dismiss / layout / close / replace / owner,见下 */ },
  })
  el.appendChild(button)
  return () => { button.remove() }
} })
```

`onClose(reason)` 的五种原因:

| reason | 谁关的 | 插件该怎么想 |
|---|---|---|
| `dismiss` | 用户关的就是这块面板:它的 × / 返回、Esc、系统返回、关掉它的标签 | 这是用户的意思;要记「用户不想看它」就记在这里 |
| `layout` | 宿主连同它所在的位置一起收走:那一侧被收起(移动端抽屉被关上)、恢复默认布局、切 Space 换了整份布局、别的视图的扩展占了这一侧 | **不是**用户对这块面板的决定,别当成「已关闭」记下来;需要时再 `open` 即可(宿主不会替你还原) |
| `close` | 你自己调了 `handle.close()` / `view.extendView.close()` | — |
| `replace` | 同一个主视图开了另一份扩展 | — |
| `owner` | 主视图被隐藏或卸载 | 主视图回来后按需重开 |

`layout` 是 2.12.2 之后的宿主才有的;更早的宿主把这些情况一律报成 `dismiss`。两头都要跑的插件:把 `layout` 当作
「位置没了」单独处理,`dismiss` 仍可能是收起或重置,别在它上面记不可恢复的状态。

每个主视图同时至多一份扩展,同一个 Panel 也只容纳一份临时内容(后来者替换前者)。
移动端临时 View 进入原生左右抽屉的视图选择器;请求 bottom 时回落到右抽屉。
每个主视图内,相同 `id` 再次 `open` 只聚焦,**不重新 mount、不替换参数**,保留输入;
要切对象就换 id 或先 close。不同 id 替换前一份;旧 handle 的 close 无法关掉后来者。
`handle.isOpen` 可探测是否还活着。`view.extendView.close()` 收当前扩展。
主视图关闭、切 tab/Space、换实体参数或插件禁用会卸载内容;旧 controller 的异步 open 会抛错,
调用方应取消自己的请求或处理失败。扩展里的未保存草稿由主视图自行管理,不要把凭据写入布局。

**规则/Agent 入口**调用与按钮相同的 `open` 函数即可;Agent 入口仍须在 `registerCommand` 上声明下面的
`invoke` 白名单,传显式目标和稳定 id,不做 toggle。须先确保拥有这份扩展的主视图已经挂载,
不要把过期 `view` 存成跨视图的全局控制器。旧宿主需检查 `view?.extendView`,按需保留原来的内联表单。

#### `invoke`:把一条命令开给 agent(2026-09-04)

给 `registerCommand` 的条目加一个 `invoke`,这条命令就进 Tangu 的 `list_ui_commands` 目录、
可被 `run_ui_command` 派发。**存在即白名单** —— 不声明就对模型完全不可见。

```js
ctx.registerCommand({
  id: 'myplugin-open-report',
  title: () => t('报告'),
  keywords: 'report weekly 报告 周报',   // 命令面板的模糊搜索别名(中文/拼音都可以,不进模型面)
  run: () => openReport(),
  invoke: {
    // 英文,给模型看。**不要复用 title** —— title 跟随界面语言,中文用户的目录会整份变中文。
    description: 'Open the weekly report view.',
    // 有参数就给 JSON Schema;并且**一定要接显式值,不要做 toggle**:
    // 模型看不到当前界面状态,而派发事件在重连时会重放,toggle 会被翻两次。
    params: { type: 'object', properties: { week: { type: 'string' } } },
    run: (args) => openReport(String(args.week || '')),
    state: () => currentWeek(),           // 可选:当前值探针,省得模型靠猜
  },
})
```

`invoke.run` 可以返回一个字符串,作为**这一次调用**的回执回给模型(如 `'opened week 40'`),优先于 `state()`。
回执按调用给,并发的两次调用各拿各的;`state()` 每次起 run 都会被读进目录,别在里面放一次性的结果。
回执与 `state` 一样会被截到 200 字符。

要把**查询结果**交给模型(「白板上有哪些框」「这一页有几条批注」),让 `invoke.run` 返回 `{ state?, result }`(2026-10-17 起):
`result` 是字符串或能 `JSON.stringify` 的值,渲染端截到约 8000 字,引擎把它圈成**不可信数据**交给模型(带随机标签的围栏,
模型不会把里面的话当指令)。`state` 仍是一句 200 字以内的确认。老宿主只认字符串回执:对象回执在那里等于没有回执,
所以要兼容老宿主就别只靠 `result` 传达「做成了没有」。

```js
invoke: {
  description: 'List the frames on the open whiteboard (id, title, element count).',
  run: () => { const frames = listFrames(); return { state: `${frames.length} frames`, result: frames } },
}
```

三条硬纪律:

1. **危险类不许 opt-in** —— 删除或覆盖用户数据、凭据与安全设置、对外发送/发布/购买、
   安装升级重启退出、不可逆的批量操作。理由不是洁癖:**web 与移动端的云 run 根本不经过审批闸**
   (引擎对非 host 执行档直接 approve),你这份声明就是那两端的全部安全边界。
2. **先想清楚是导航还是动作。** 模型「帮用户开一个面板」几乎没有价值;有价值的是把它刚做出来的
   东西摆到用户眼前、或者改一个用户用话说出来的设置。
3. **插件命令只在桌面存在**(web 与 mobile 的 `listPlugins` 都返回 `[]`)。声明了 `invoke` 也不会
   出现在手机的目录里 —— 这是正确行为,不是 bug,别为此写特例。

#### `checked`:开关类命令的当前状态(2026-09-25)

用户可以把任意命令钉进 Ribbon 命令区。**开关类**命令(开 / 关某个模式)声明 `checked`,钉上去的按钮
就带 `aria-pressed` 并在开着时高亮,一眼看得出现在是开是关;不声明就是普通动作钮。

```js
ctx.registerCommand({
  id: 'myplugin-focus-mode',
  title: () => t('专注模式'),
  run: () => setFocus(!isFocus()),
  checked: () => isFocus(),   // 渲染期求值:要便宜、无副作用
})
```

- **只给真开关用**。「打开报告」这种动作声明了 `checked` 会被读屏报成「未按下」。
- 宿主**不订阅**你的状态:Ribbon 在点击后、悬停进出时重读;别处(快捷键、设置页)改了状态,
  按钮要等下一次重渲才跟上。旧宿主没有这个字段 = 静默忽略,不用做特性检测。

| `registerSettingsView` | 详情页里自己画的面板 | 会被反复挂载卸载,状态别放模块级单例;`title` 可传函数(切语言跟上)。`category: 'forsion'`(2026-09-28 起)只对带主进程半身的首方内置包(Forsion Extend)生效:面板成为设置「Forsion 云端」的一个子页,别的插件写了照旧画在详情页 |
| `registerStoreView` | 商店左栏里的一页(左栏多一个入口,整页正文自己画) | 2026-10-05 起;**只对带主进程半身的首方内置包(Forsion Extend)生效**,别的插件注册了不显示 —— 做普通插件用不到。旧宿主没有:`ctx.registerStoreView?.(…)`,没有就不注册,**别拿 `registerSettingsView` 顶替**(那会把页面画进插件详情页) |
| `ctx.app.openSettings?(target)` | 打开设置到某一页 / 子页(2026-09-28 起) | 口径同宿主深链,如 `'model/m-providers'`;旧宿主没有,一律 `?.` 调 |
| `ctx.app.watchAccountName?(cb)` | 当前登录的名字(有昵称用昵称,2026-10-18 起) | 先回调一次当前值,换账号 / 登出再回调,没登录 = 空串;只给名字,不给令牌和账号 id;返回退订,停用时宿主也会退 |
| `ctx.wallpaper.bing(locale?)` | 必应每日壁纸最近 8 张(2026-10-18 起) | `{ id, url, thumbnailUrl, title?, copyright?, startDate? }`;宿主代拉(桌面经主进程,插件直连必应会被 CSP 拦);拿不到 → reject;老宿主没有 → `ctx.wallpaper?.bing(…)` |
| `ctx.app.openSpace?(id)` | 切到某个 Space(2026-10-17 起) | resolve 在新 Space 布局建好之后,接着 `ctx.openView(…, { location: 'right' })` 就落在新 Space 里;不认识的 id → `false`;旧宿主没有 → `?.` |
| `ctx.app.openLink?(url)` | 在应用内打开一条 `forsion://` 链接(2026-10-17 起) | 口径同系统唤起的深链,只导航不执行;插件页 / 收件箱信 / 笔记正文里的 `<a href="forsion://…">` 宿主本来就在应用内接住,这条给按钮用 |
| `ctx.app.setSpaceProgress?(spaceId, progress)` | 在 Ribbon 上自己 Space 的图标外画一圈进度环(2026-10-18 起) | 只认本插件随包带的 Space,别人的 / 内置的恒 `false`;`0–1`,`null` 收起;按整百分比画,每 0.5 秒报一次也不会重渲;那个 Space 有未读角标时让给角标;插件停用时宿主收掉;Space 收进 Ribbon 文件夹 / 「⋯」时看不到环;旧宿主没有 → `?.` |
| `ctx.app.setSpaceDot?(spaceId, on)` | 在 Ribbon 上自己 Space 的图标右上角挂提示红点(2026-10-19 起;服务器管理插件给「反馈中心」挂提醒用) | 只认本插件随包带的 Space,别人的 / 内置的恒 `false`;`true` 挂、`false` 收,没变不重渲;红点和收件箱未读角标同一种红,有角标时让给角标,和进度环同时有时只画红点;插件停用时宿主收掉;挂着时图标读屏名带「有新提醒」;列表行的未读仍用 `ListItem.unread`(指示色,不是红),要在别的 Space 也看得到就配上它;旧宿主没有 → `?.` |
| `ctx.app.queuePopup?()` | 自己弹出来的弹窗排队(2026-10-19 起;Extend 公告用) | 应用里同一时间只露一个弹窗:协议更新、What's new 在前,插件排在后面,同级先来后到;全屏引导开着时谁都不出。返回 `{ ready, done }`:`await ready` 之后再挂弹窗,关掉时 `done()`;决定不弹了(换账号、数据过期)也调 `done()` 撤销,这时 `ready` 永远不 resolve。不 `done()` 会一直堵着队列,插件停用时宿主替你收掉。用户点了才打开的面板不用排;旧宿主没有 → 直接弹 |
| `ctx.app.runCommand?(id)` | 跑一条命令面板里的现成命令(2026-10-17 起) | **只对首方内置包生效**,别的插件恒 `false`(命令里有删除 / 改设置) |
| `ctx.app.spotlight?({ anchor, title, body?, step? } \| null)` | 在真界面上圈出一处 + 一张小卡(2026-10-19 起,使用指南的「带我去」) | **只对首方内置包生效**,别的插件恒 resolve `'missing'`;锚点是宿主的一张表(`ribbon-spaces` / `chat-composer` / `note-new` / `note-body` / `note-canvas` / `agent-new`),在收着的侧栏里会先展开;不压暗、不拦点击、同一时刻一处;resolve `ok` / `mute`(用户点了不再提示,插件自己记下)/ `gone` / `missing`(等 2 秒仍不在屏幕上)/ `replaced` / `closed`(传 `null` 收起);旧宿主没有 → `?.`,没有就照老做法 |
| `ctx.app.sync?` | 读写这台电脑的三项云同步(2026-10-20 起,蓬洲云「同步」页) | **只对首方内置包生效**,别的插件整个成员缺席;手机 / 网页、没有本地库远程同步的宿主上也缺席。`get()` 给快照(智库 / Agents 与记忆 / 插件数据各自开没开、进度、第二台电脑待定的合并问题)、`subscribe(fn)`、`refresh()`、`set(kind, on)`(`notes` / `agents` / `plugins`)、`resolveNotes('merge' \| 'cloud' \| 'skip')`、`runNow()`;开关与引擎都在宿主,插件只画界面 |
| `ctx.inbox` | 往收件箱发本机系统消息 + 信下挂自己画的卡(2026-10-17 起) | **只给首方内置包**,别的插件整个成员缺席;`post` / `archive` / `registerCard({ sender, mount })`,卡只认发件人 `plugin:<你的 id>` 的本机系统消息 |
| `registerReadiness` | onboarding 检查卡上的一行 `check` | 2026-09-21 起;**必须 `ctx.registerReadiness?.(…)`**;拿不准回 `'unknown'`,见下「前置条件」 |
| `registerEditorExtension` | 笔记编辑器的按键 / 装饰 | `'high'` 档不处理**必须 `return false`** |
| `registerStatusItem` | 全局状态栏 | 返回 handle,可原位 `update({text,title})` |
| `registerTheme` | 强调色主题 | 与磁盘主题包(`~/.forsion/themes/`)是两件事 |
| `registerAppearance` | 设置 → 外观 → 开屏与图标 | 图像方案，由用户选择；可选链兼容旧宿主，返回 disposer；见下文 Startup appearance |
| `registerFont` | 设置 → 外观 → 字体 | 2026-08-28 起;**返回 disposer**(宿主在禁用/重载时也会自己撤销,返回值可以不接);旧宿主没有 → `ctx.registerFont?.(…)` |
| `registerPanel` | 右侧栏面板 | ⚠️已弃用,收 **React 组件**(拿不到宿主的 React 实例,只有自带 React 的插件能用,mindmap 有先例);新代码一律 `registerView` |
| `registerPropertyType` | 多维表自定义列类型 | ⚠️同上,`Cell` 是 React 组件;`baseType` 决定落盘形状 |
| `ctx.notify(msg, {level, action, key})` | 右上角通知 | 自动标插件名,用户可按插件静音;`action: { label, run }` 在卡上放一个按钮(典型「撤销」,2026-10-17 起,旧宿主忽略)、`key` 同 key 的通知合并成一条 |
| `ctx.achievements` | 成就系列 + `track(event, n)`;2026-10-17 起 `count(event, { own? })` 读计数(缺省读官方事件,只读)、`subscribe(cb)`、自己系列的 `isClaimed(id)` / `claim(id)` | 宿主强制 `plugin:<id>:` 前缀,伪造不了官方成就;`count` 读不到别家插件的计数(恒 0);新成员旧宿主没有 → `?.` |
| `ctx.activity.log(event, detail)` | 写进活动日志(Muse 读得到) | 同款前缀纪律 |
| `ctx.loadData() / saveData()` | 每插件一份 JSON blob | 大块数据走这条(见下「编辑器」节) |
| `ctx.dashboard` | 原生仪表盘(网格/卡片/排版台) | 2026-09-01 起;**两条路线**(视图内 `mount` 不依赖库 / `source` 生成 `.dashboard.md` 需要库)见下节;一律 `ctx.dashboard?.` |
| `ctx.getLocale / subscribeLocale` | 跟随宿主中英切换 | 见下「双语」 |
| `ctx.tangu` | 当前模型 / 模型目录 / 当前 Space / 会话用量 / **agent 此刻在干什么**(只读)+ `agents()` 用户的 Agent 名册 + `startChat` 用指定 Agent 开一个可见的新对话 + `mountChat` 把原生对话挂进自己的视图(2026-10-04 起)+ `mountComposer` 把「新对话」输入区整块挂进来、发送归宿主(2026-10-18 起)+ `complete` 一次性文本补全(2026-09-28 起) | ⚠️**非 Tangu 宿主上整个不存在** → 一律 `ctx.tangu?.`;`agentStatus` / `subscribeAgentStatus` / `startChat` 是 2026-09-19 起、`agents` 是 2026-09-20 起的可选方法 → `ctx.tangu?.startChat?.(…)`;见下「当前模型」「Agent 状态」「Agent 名册」「开新对话」 |
| `ctx.desk` | Tangu 聊天右侧 **Agent Desk** 里挂一块自绘区(`registerCompanion`,典型:跟着 agent 状态做反应的 3D 形象) | 2026-09-19 起;⚠️**只在桌面 Tangu 上存在**(web / 移动端 / 纯 Amadeus 壳整个没有)→ `ctx.desk?.`;两种模式 `idle` / `always`,见下「Agent Desk 伴随面」 |
| `ctx.summary` | Tangu 聊天右侧**摘要栏**加一张卡(`registerCard`,和进度 / 后台 / 产物 / Agent Desk 同一个栈,用户可折叠、拖动排序) | 2026-10-25 起;⚠️**只在桌面 Tangu 上存在**(同 `ctx.desk`)→ `ctx.summary?.`;见下「摘要栏插件卡」 |
| `ctx.automation` | 播种多维表自动化规则(`ensure(rules)`) | 2026-09-02 起;⚠️**非 Tangu 宿主上整个不存在** → `void ctx.automation?.ensure(…)`;id 宿主加 `plugin:<id>:` 前缀;见下「自动化」 |
| `ctx.calendar` | 把插件种的表登记进 Calendar Space(`ensureMember`,人人有)+ 叠加源与日历设置(`subscribe` / `setColor` / `setHidden` / `setDefault` / `setMember` / `removeMember`)+ .ics 订阅管理(`ics.add` / `importText` / `rename` / `remove` / `refresh`) | `ensureMember` 2026-09-02 起;其余 2026-10-17 起,⚠️**声明 `"calendar"` 才有**(没声明时这几个成员不存在,不是空壳)→ `ctx.calendar?.subscribe`;见下「日历叠加源与设置」 |
| `ctx.spaces` | Space 列表 / 打开 / 图标 / 近况那一行 + 商店、成就两格 + Ribbon 上区的收纳架(顺序、收纳夹) | 2026-10-18 起;⚠️**声明 `"spaces"` 才存在**(收纳架改的是用户的 Ribbon);见下「Space 与 Ribbon 收纳架」 |
| `ctx.databases` | 全库多维表的实时聚合(`subscribe`)+ 按行按格读写(`setCell` / `addRow` / `duplicateRow` / `deleteRow`) | 2026-10-16 起;⚠️**manifest `capabilities` 声明 `"databases"` 才存在**;见下「全库多维表与笔记任务」 |
| `ctx.noteTasks` | 笔记正文里的 `@` 时间任务(`subscribe`)+ 就地勾选 / 改日期(`update`) | 2026-10-16 起;⚠️**声明 `"noteTasks"` 才存在**;同上节 |
| manifest `events[]` | 自动化(Automation)可订阅的事件 | 纯声明无代码;⚠️目前只有中文 `label`,英文界面下也显示中文 |
| manifest `onboarding` | 有 `requires` = **闸**(宿主实测,未满足才弹检查卡);没有 = 详情页里折叠的使用说明 | 见下「前置条件:onboarding.requires」;**别 recommends 自家已内嵌的 agent/skill**(会引导去商店重复装);⚠ `recommends` 只在闸的检查卡里渲染,没有 `requires` 就一个字都不显示 |

`ctx.app` 上另有三组:**整库文件读写**、**只读全库查询**、**块表面** —— 各占下面一节。

### ⚠️「没有活动库」时的统一行为(2026-09-02 立规)

上面三组里**凡走库内路径**的方法(`readFile / writeFile / readBytes / writeBytes / watchFile / openFile / loadPage /
createPage / listPages / listFiles / searchVault / reveal / trash`)都要求一个**已打开**的笔记库。
没有活动库时它们**各自失败得不一样**,而且大半是静默的:

| 方法 | 没有活动库时 |
|---|---|
| `readFile(p)` | **静默返回 `null`**(与「文件不存在」同形,try/catch 照不到) |
| `writeFile(p, t)` | **reject** —— 主进程抛 `Error('No vault is open')` |
| `readBytes(p)` / `writeBytes(p, bytes)`(2026-09-19+) | 同上两行:`readBytes` 给 `null` 不抛,`writeBytes` **reject** `'No vault is open'`。旧宿主 / 桥缺席时方法整个不存在 → `ctx.app.writeBytes?.(…)` |
| `mutateDb(p, fn)`(2026-09-02+) | `{ ok:false, error }`,**不抛**;云端/移动端桥没有 CAS 写口时同样 `{ ok:false }`。⚠️**改活表(补列属性、加视图)一律走它**:比对交换 + 冲突重读重放,`fn` 返 `null` 不写;`readFile`+`writeFile` 整文件覆盖会盖掉读写之间自动化/用户刚写的行且零报错。旧宿主没有 → `ctx.app.mutateDb?.(…)` 再走自己的回落路 |
| `listPages()` / `listFiles()` / `searchVault(q)` | 一律**给空数组、不 reject** |
| `trash(p)`(2026-10-05+) | **reject**(宿主的清单里找不到这个路径)。没有回收站的端 / 旧宿主**方法整个不存在** |
| `vaultRoot()` | `null` —— **唯一的可用性探针** |
| `workFolder()` | **照常返值**(它只是一条设置项的值)—— ⚠️**不是可用性探针**,拿到字符串不代表写得进去 |

- ⚠️**库是惰性恢复的**:`vaultRoot()` 为 null 只说明「当前没有**打开着的**库」,不代表用户没有库 ——
  用户这一程还没进过 Amadeus 之前它就是 null。插件在宿主**启动期**装载,setup 里那一发读写多半正撞在这上面。
  插件视图挂载时宿主会唤醒库(2026-10-02 起),但恢复是异步的:视图刚挂上那一下 `vaultRoot()` 仍可能是 null ——
  一进视图就要读库(列工程、恢复上次打开的文件)的,先等 `vaultRoot()` 有值再读,别把那一刻的空当成「用户没有内容」。
- **结论(2026-09-02 起规,起因:服务器总览面板误依赖笔记库,用户实报「太奇怪了」)**:
  **与笔记无关的功能(仪表盘 / 远程系统面板 / 工具面)不得建立在这些方法上** ——
  用 `ctx.dashboard.mount`(见下节)、`ctx.loadData` / `ctx.saveData`、以及自己视图里的 DOM。
- **启动期的写一律 try/catch**;要按「库在不在」分支就读 `vaultRoot()`,别去试探 `readFile` 的 null。
- 与列表源那条纪律是同一个病根:`registerListSource` 的 `subscribe()` 必须顺手重读一次(见下)。

### 外观开关:跟着宿主走(2026-10-05 起)

用户在 设置 → 外观 有三个各自可以开、可以关的开关(哪个开着由用户定,别假设):**外围淡出**(Ribbon 图标、未选中的标签、左栏文字平时退后,指针或键盘焦点
进来恢复)、**宽松正文**(笔记与对话正文的行距、段距放宽)、**舒缓过渡**(切视图的淡入、外围恢复慢一点)。插件不用接任何 API,
守住下面几条就自动跟上;违反了不报错,只是在用户眼里「就你这个插件不一样」:

- **文字和线性图标只用宿主的文字 token**(`var(--text)` / `--text-light` / `--text-muted` / `--text-faint`),不写死颜色,也不自己叠
  `opacity` 来表示「次要」。左栏的淡出是宿主把这几个变量调淡做出来的:写死的颜色不会跟着淡,在一片退后的侧栏里独自发亮;自己再叠一层
  透明度会淡两次。状态(未读、出错、进行中)用语义色 `--accent-ink` / `--danger` —— 它们不淡,正好留给需要被看见的东西。
- **左栏列表的选中行要标出来**:`aria-selected="true"` 或 `aria-current`(类名 `.active` / `.on` / `.is-on` 也认,后两个与 Ribbon 认的
  「开着」是同一个词)。宿主让选中行保持全亮,没标的会和其它行一起退后。别把 `.on` 挂在包着整块面板的容器上——里面的东西会全都不退后。
  走 `registerListSource` 的不用管,宿主画的行自带。
- **整段阅读的正文读两个公开 token**:`line-height: var(--reading-line-height, 1.6)`,段间距 `var(--reading-paragraph-gap, 0.3em)`
  (兜底值就是开关关着时的数)。只用于文章、说明、预览这类长文;列表、表单、卡片、表格是界面文字,不用这两个 token,也不跟这个开关。
  `ctx.ui.mountMarkdownEditor` / `ctx.app.mountBlocks` / `ctx.tangu.mountChat` 挂出来的正文是宿主画的,自动跟随。
- **视图根上不加自己的入场动画**:切主视图时宿主已经做了一次淡入,再加一层会叠成两段。视图里的悬停、展开过渡用宿主的
  `--duration-fast` / `--duration-base` / `--duration-slow` / `--ease-surface`,不写死毫秒、不写 `transition: all`;`prefers-reduced-motion` 下关掉。
- **展开 / 弹出先用标准写法,宿主自动给动效**(2026-10-25 起):原生 `<details>`、`<dialog>` / `popover` 自带 Forsion 的进出场;
  「用户点了才出现」的那块写 `data-motion="enter"` 就淡入上来;能开合的一块写 `data-motion="collapse"` + `data-open`
  (里面只套一层,箭头 `data-motion="chevron"`,React 用 `@lcl/components` 的 `AnimatedCollapse`),别自己量高度补间。细则见 references/host-ui-mounts.md「Motion the host applies for you」。
- **这三个开关是用户的**:不读、不写 `forsion_calm_*` 与 `<html data-calm-*>`,不提供同类的私有开关,也不在自己的视图里用 `:hover`
  去点亮或压暗宿主的外围。iframe / webview 里的页面拿不到宿主变量、不会跟着淡,导航类内容别装进 iframe 再放到左栏。

### 样式契约:能依赖的宿主类名与 token(2026-10-26 起)

宿主把插件可以依赖的类名和 CSS 变量发布在 `tools/plugin-contract.json`(每个带用途,随 `apiVersion` 升级)。清单外的宿主类名 / 变量
随时可能改名或删掉:不报错,只是某天界面塌了或变了色。

- **公开类名**:`.btn`(`.primary` / `.ghost` / `.danger` / `.sm`)、`.ctx-menu` 外壳(直接子 `<button>` 是菜单项,`button.danger`、
  `.ctx-separator`、`.ctx-shortcut`、`.ctx-head`、`.ctx-menu-scroll`)、`.empty-state` / `.empty-title`。私有前缀 `.amx-*`(编辑器、数据库浮层、⌘P)、
  `.fc-*`(内置日历)、`.t2-*` 别借;自己的类名用自己的前缀。
- **公开 token**:色、圆角 `--radius-*`、阴影、菜单尺寸 `--menu-*`、界面字号 `--ui-font-*` / `--ui-line-*`、动效 `--duration-*` / `--ease-*`,
  外加 `--focus-ring`。契约只列名字不列值:值跟着设计语言 / 主题色 / 背景色走。`--ease-out`、`--ease-spring`、`--ease-apple`、`--dur-*` 已弃用。
- **不写兜底**:`var(--radius-md)`,不是 `var(--radius-md, 10px)`。宿主定义着的变量兜底永远不生效,抄来的值迟早和宿主对不上。例外:token
  比你的 `minAppVersion` 新(契约的 `since` 表),兜底留给老宿主;`--reading-*` 两个本来就带兜底。
- **不写死颜色、阴影、圆角**:浅底用 `color-mix(in srgb, var(--green) 14%, transparent)`,别抄 Tailwind 色板。画面本身要固定的色(视频黑边、
  压在画面上的白字)写关键字 `black` / `white`,一看就知道是故意的;检查只认 `#hex` / `rgb()` / `hsl()`。
- **体检**:`check-plugin.mjs <插件目录> --style` 扫 main.js 和目录里的 `.css`,报私有类名、清单外 / 已弃用的 token、多余兜底、写死的色、
  ≥4px 的圆角、带色阴影。**只报不拦**,不改退出码。给另一份文档用的 CSS(iframe 里的页面、导出文件,那里没有宿主变量)在同一行写
  `/* forsion-style: off */` 跳过;打包把一个模块压成一行时,一个标记管整行。

### 宿主挂载接口的 dispose 契约(2026-10-04 起)

`ctx.app.mountBlocks` / 文件视图的 `mountNoteView` / `ctx.ui.mount*` / `ctx.table.mount` / `ctx.dashboard.mount` / `ctx.tangu.mountChat`
都把宿主的界面挂进**宿主自己加到 `el` 里的一层**(`display:contents`,不出盒子:`el` 的高度、flex 照旧作用在里面的内容上)。

- `dispose()` 同步摘掉这一层,**之后 `el` 立刻还给你**:清空它、放自己的内容、在同一个 `el` 上再挂,都不用等。
- dispose 再挂 = 一份全新的实例(输入焦点、排序筛选这些状态不带过来)。只是换数据 / 换参数就用句柄的 `update()`。
- 一个 `el` 同一时刻只有一份宿主界面:上一份没 dispose 就在同一个 `el` 上再挂,宿主先把上一份完整收掉(等同于你 dispose 了它,句柄此后不再生效),再挂新的;谁后调用谁留下,不看谁先加载完。要并排放两份,就各给一个子节点。
  `mountFloatingToc` 例外:它是叠在 `shell` 上的一层,不占用 `shell`,不收掉 `shell` 上别的挂载,也不被它们收掉。
- 别用 `el > .x` 去选宿主渲染的节点,也别假设它是 `el.firstElementChild` —— 中间隔着那一层。
- 2.12.2 及更早的宿主没有这条保证:dispose 之后那一拍里清空 `el`,宿主的卸载会报一条页面错误,或者再挂之后一片空白。
  要兼容它们,就把宿主内容挂进你自己建的子节点(`const slot = el.appendChild(document.createElement('div'))`),换内容时连子节点一起换掉。

### Host UI mounts: read references/host-ui-mounts.md

The full contracts, examples and old-host fallbacks for these mounts live in [references/host-ui-mounts.md](references/host-ui-mounts.md). When the table above says 见下「…」 for one of them, read that section there before writing code:

- 可复用 UI 组件：ctx.ui.mountChatBox（2026-09-24 起）
- 原生 Markdown 编辑器 ctx.ui.mountMarkdownEditor(2026-09-30 起)
- 原生悬浮目录 ctx.ui.mountFloatingToc(2026-09-07 起)
- View modes: ctx.ui.setViewModes (2026-10-19+)
- Tooltips and motion tokens: ctx.ui.attachTooltip (2026-10-23+)
- Drop indicators: ctx.ui.dropIndicator (2026-10-24+)
- Selection bar: ctx.ui.mountSelectionBar and registerSelectionAction scopes (2026-10-13+)
- Host parts: dialogs, toolbar controls, menus, popovers, empty states, icons, view head, i18n (2026-10-26+)
- Settings parts: ctx.ui.mountSettingsPage / mountSettingsItem (2026-10-17+)
- 白板层 ctx.ui.mountBoard / ctx.ui.boardToSvg(2026-10-10 起)
- 仪表盘 ctx.dashboard(2026-09-01 起)
- 原生多维表 ctx.table.mount(2026-09-05 起)

### 只读全库查询(2026-08-14 起)

全部可选 → 一律 `ctx.app.listPages?.()`;**没有活动库/桥缺席时给空数组不抛错**,`vaultRoot` 给 `null`。

| | 语义与坑 |
|---|---|
| `listPages()` | 笔记清单,vault 相对路径,**不截断**;插件自定义后缀已被主进程排除在外 |
| `listFiles()` | 文件树可见的非笔记文件。⚠️遍历**跳过一切点目录/点文件** → 经 `saveAsset()` 落进 `.amadeus/` 的页面附件枚举不到,**别声称「库里所有图片」** |
| `searchVault(q)` | 全库笔记全文检索。⚠️**最多 50 条且可能截断**,要穷举别靠它;`line` 是剥掉 frontmatter 后的行号**不是磁盘坐标**;`score` 不透明,跨版本不保证稳定 |
| `vaultRoot()` | 库的绝对路径(把路径喂给 Agent 的 host 工具时才需要)。⚠️含用户名/组织目录等**敏感信息,不得默认持久化或上报**;切库瞬间与主进程短暂不同源,**别缓存过夜** |
| `reveal(path)` | 在系统文件管理器里打开该路径所在目录并高亮它(2026-08-29 起)。⚠️对**不存在**的路径是静默 no-op,而工作文件夹是首写才诞生 → **先 `writeFile` 一份 README 再 reveal 它**;桥缺席时整条方法不存在,`if (ctx.app.reveal)` 才画按钮 |
| `trash(path)` | 把库内的一个文件或文件夹移进回收站(2026-10-05 起),等同用户在文件树里删它:宿主收掉开着它的编辑器与标签、提示「已移入回收站」,之后可在回收站恢复。返回 Promise,路径不存在 / 没有活动库 / 调用途中换了库 / 移动失败 → **reject**(路径按清单逐字匹配,只归一分隔符与首尾斜杠)。⚠️**文件夹连同里面的一切一起走,宿主不确认、也不看里面是不是别人的文件** —— 只在确认那个文件夹里全是你自己的东西时才传文件夹,否则传文件;⚠️**先让自己的编辑器停笔**(你的视图若还握着待存内容,下一次自动保存会把文件写回来);只有带回收站的宿主(本机桌面)才有这个方法,web / 移动端 / 2.12.2 及更早**整个不存在** → `ctx.app.trash` 没有就别画删除按钮 |

### 库级文件事件 ctx.app.onVaultEvent(2026-10-17 起)

`const off = ctx.app.onVaultEvent?.((events) => …)`:库里文件的新建 / 删除 / 改名 / 外部修改,约 200ms 攒成一批给你,插件停用时宿主自动退订。反链、自动整理、「新文件套模板」这类插件用它,别再轮询 `listFiles`。

| `kind` | 什么时候来 |
|---|---|
| `create` / `delete` | 任何笔记或文件进出库的清单,不管是谁做的(用户在 Forsion 里、别的程序、同步)。单独的文件夹不报 |
| `rename` | 在 Forsion 里(任何窗口)改名 / 移动:`{ path: 新, from: 旧 }`;整个文件夹挪走 = 一条 `folder: true`。**同一次改名不会再报一对删 / 建**。别的程序改的名分不出来,照「删 + 建」来 |
| `modify` | 内容在**本窗编辑器之外**变了(别的程序、Tangu、别的窗口、同步)。正在打开的那篇里的打字不在这里报,当前页用 `ctx.app.subscribePage` |
| `vault` | 换库或关库:你缓存的清单作废,重读 |

路径与 `readFile` 同一种写法(vault 相对、`/` 分隔)。没开库时什么都不来。回调里别做重活:一批可能有上百条(批量移动),先合并再处理。老宿主没有 → 可选链,退回轮询。

### 统一左栏列表源(2026-08-25 起)

`ctx.registerListSource?.({ id, title, items, subscribe, open, search?, groups?, actions?, itemMenu?, drop?, rename? })` ——
插件只出数据,搜索词与选中分组**由宿主持有**并经 `items({query, group})` 回传(插件对 UI 无状态);
`items()` 每次渲染都被调,自己缓存别读盘。露出左栏两条路:space.json 写
`{"type":"workspace","params":{"mode":"plugin:<插件id>:<源id>"}}`,或给 `registerView` 加 `workspaceSource`。

- ⚠️**`subscribe()` 必须顺手重读一次**:插件在宿主**启动期**装载,而笔记库恢复是**懒的** ——
  setup 里那次 `ctx.app.readFile` 多半撞在「还没有活动库」上,宿主此时**静默返回 `null` 不抛异常**
  (try/catch 照不到),列表就此定格为空。宿主挂载列表面 / 切库都会重订阅,这是重读的门。
  (青鸟 2026-08-28 实报「明明有记录却是空」,根因即此。)
- 行首图标 `iconUrl`(favicon 等)与 `icon`(词表键)**两个都给**:老宿主 / 取不到图时退 `icon`。
- 进度类列表(章节、关卡)的行状态用 `circle-check`(做完)/ `circle`(没做完)/ `lock`(锁住;2026-10-18 起,老宿主退兜底图标)。网盘 / 存储类的行用 `hard-drive`(2026-10-18 起;老宿主没有,可拿 `ctx.app.setSpaceProgress` 在不在判新旧,旧的退 `archive`)。`penzor` 是蓬洲云自己的图标(2026-10-23 起),别的插件别用。别用 `todo` 表示没做完 —— 它是块菜单的「待办」图标,自带勾。
- `actions` / `itemMenu()` 的每一项是 `{ id, label, primary?, danger?, icon?, run }`:`primary` 留在工具条外面(缺省第一项),其余收进「⋯」;
  `danger: true`(2026-09-25 起)= 不可逆动作(删除 / 移除),宿主在右键菜单和「⋯」里都用危险色画它。**只管配色,确认仍由插件自己在 `run()` 里做**
  (宿主不替你弹框);惯例把它排在最后一项。老宿主忽略该字段。
- 行可带 `unread: true`(2026-09-11 起):宿主在行首图标角上画与未读会话同一个点;老宿主忽略。
  宿主自己的收件箱就是这么接进统一左栏的(`plugin:inbox:messages`:按发信人归组的组头,筛选 = 未读 / 已归档),可当参考实现。
- 行可带 `subtitle`(2026-10-13 起):标题下面再画一行淡字,只占一行、超出省略 —— 写「谁发的 · 第一句话」「状态」这类一眼要看到的东西,
  纯文本、别放 markdown;不写就还是一行。文件夹行不认;老宿主忽略该字段、照旧画一行,不用探测。右边的 `hint` 对齐第一行。
  收件箱的行就是 `title` + `subtitle`(正文第一句;发信人在组头上,见下面「组头」)+ `hint`(时间)。词表新增三枚「谁发来的」图标:`cloud` / `workflow` / `agent`。
- **手机上的样子(2026-10-13 起)**:安卓原生外壳里,**平铺的**列表源(没有文件夹行、没有 `parent`)画成手机的整屏列表,和会话 / 笔记列表同一套 ——
  `groups()` 是一排分类胶囊(不是菜单);行是 44dp 图标块 + 标题与 `hint` 一行 + `subtitle` 一行;搜索在顶上胶囊的搜索钮和下拉里;
  `itemMenu()` 的动作藏在左滑后面,是**只有图标、不带字**的圆钮;`primary` 那个动作是右下角的主按钮,其余 `actions` 在它的长按菜单里。
  所以动作要带 `icon`(图标词表里的名字,和行的 `icon` 同一张表):**没有 `icon` 的行动作不进左滑**(仍在长按菜单里),没有 `icon` 的主动作画成加号。
  成对的动作各给各的图标(已读 `mail-open` / 未读 `mail`、归档 `archive` / 取消归档 `unarchive`);`label` 这时是读屏标签和首次提示里念的名字,照旧要写。
  动作用得上的词表名:`mail` / `mail-open` / `archive` / `unarchive` / `trash` / `refresh` / `edit` / `pin` / `bookmark` / `plus`。带层级的源在手机上仍是树;唯一的例外是只有一层「组头」的源(见下),它留在这套版式里。
  这套版式里行不能拖动(长按留给行的菜单):要让人在手机上排序 / 归类,给一个动作,别只靠 `drop`。没有 `actions`、只有 `groupActions` 的源,主按钮就是那张菜单。
  桌面 / 网页不受影响;老宿主忽略 `icon`。不用探测,照写即可。
- **桌面上行尾的图标钮(2026-10-14 起;写本条时桌面尚未发版)**:指针停在一行上(或键盘焦点走到这一行)时,`itemMenu()` 里**带 `icon` 的动作**
  在行尾排成一排图标钮,右边仍是「更多」(里面是带名字的全部动作)。和手机左滑出来的是同一批、同一个顺序 —— 所以把最常用的两三个动作
  (已读、归档、删除这一类)放在前面并配上图标;不想让它出现在行上的动作就别给 `icon`。图标钮出现时行里的 `hint` 暂时收起、标题让出位置。
  `danger` 的动作悬停时变警示色,确认仍由你在 `run()` 里做。触屏设备上没有这排按钮。不用探测:老宿主只有「更多」。
- `drop` 不声明就完全没有拖放;声明了也是宿主判形点亮、插件决定接不接。
- **层级 / 行内拖动 / 就地改名(2026-10-10 起;写本条时桌面尚未发版)**:三样都先探测
  `ctx.listCapabilities?.includes('tree' | 'items' | 'rename')`,探测不到就照旧输出平铺的行 ——
  旧宿主不认 `parent`,会把文件夹画成一条普通的行,点它还会调到你的 `open()`。
  - 层级:行仍是一张平铺数组,子行写 `parent: '<上一级的 key>'`,上一级写 `kind: 'folder'`(可以是空的)。
    数组顺序就是显示顺序。文件夹点一下开合、不调 `open()`;开合由宿主记(文件夹缺省收起,`activeKey()` 那一行
    所在的文件夹自动展开);搜索时宿主不画层级,只平铺匹配的行 —— 所以子行最好也写上 `group`。
    静态分组头(`group`)同样可以点开合,缺省展开。`itemMenu(文件夹)` 里带 `primary` 的那一项画成行尾的「+」。
  - 组头(2026-10-14 起;探测 `ctx.listCapabilities?.includes('group')`):最上面一级的文件夹再写 `folderStyle: 'group'`,
    就画成 Tangu 左栏里 Agent / 项目那种一级行 —— 40px 高,前面一个 30px 的前导(有 `iconUrl` 是圆头像,有 `icon` 是方块里的图标,
    都没有就画标题的首字),名字后面一个开合箭头,`hint` 画成行尾的小胶囊(放未读数这类数字)。用在「这些行是谁的」这种分法上
    (发信人、账号、来源),不是文件树。组里的行**不画自己的图标**(组头已经说了是谁的),前导槽里只留 `unread` 的圆点,
    所以 `subtitle` 里也别再重复组的名字;一组先列 5 条,其余在「查看更多 · N」后面。
    开合和普通文件夹不同:**只记这一次运行,不落盘**。写 `defaultOpen: true` 的组自己开着(例:里面有未读);这个字段由假变真时
    宿主会重新打开它(哪怕用户收起过),一直为真的期间用户收起就让它收着,变回假时不自己合上。不写就是收着。
    **顺序你自己排**:数组里谁在前谁就在上面(收件箱按各组最新的一封排,谁刚来信谁在最上面)。搜索时照旧不画层级,
    所以带 `query` 时返回平铺的行,并把组的名字放回行里(`subtitle` / `icon`)。
    手机上:只有组头这一层(组头下面直接是行)的源仍然画成整屏列表 —— 组头是同一种行放大到触屏尺寸,组里的行照样能左滑。
    探测不到 `'group'` 的宿主把它画成普通文件夹(缺省收起、行带各自的图标),能用,只是不好看;在意的话那时就别分组。
  - 行内拖动:能拖的行写 `draggable: true`,`drop.accepts` 加 `'items'`。落下时收到
    `onDrop({ items: [key] }, { item, position })`,`position` = `'before'` / `'after'`(排在那一行前 / 后)或
    `'into'`(放进文件夹)。`drop.canDrop({ items }, target)` 在指针移动时被问(同步、要快),返回 false =
    这个落点不收,宿主会改问下一个合理的落点(如「放进去」被拒就问「排在前 / 后」)。行不会被提议落在自己身上
    或自己下面。**宿主只画提示,不移动任何东西**:改完自己的数据再通知订阅者。
  - 就地改名:行写 `renamable: true`,源上声明 `rename(item, title)`。菜单里的「重命名」、输入框、按键
    (回车提交 / Esc 取消 / F2 开始 / 失焦提交)都是宿主的;你收到的是去掉首尾空格、非空且确实变了的新名字。
    行上的字要等你的 `items()` 给出新标题才变。
  - 参考实现 = server-admin 插件的「官网」Space(文件夹 = 官网侧栏的分区,拖动 = 改目录页)。
- 细节与全部字段语义见正典文档同名小节 + `amadeus/plugins/types.ts` 的 `ListSourceContribution`。

### Intelligent UI list cards (2026-10-09+)

Opt an existing `registerListSource` into chat with
`intelligent: { description: 'Live saved bookmarks; optional title search.', viewId: 'folder' }`.
Use English discovery metadata (max 400 characters); localize the source title. The host owns
rendering and assigns `plugin:<manifestId>:<sourceId>`. Reuse `items/subscribe/open`, including
reload on subscription and unsubscribe on disposal; do not build another chat UI or data store.
`search: true` permits a bounded initial query. The card displays up to six live items and a
button to the same plugin's registered full view. Disable revokes discovery and unmounts cards.
The host draws the frame, so write no card styles: the header shows the plugin icon and
`name · source title` (manifest `nameEn` in English; when one name already contains the other,
only the longer one is shown), a Live dot and the full-view button. A block title written by the
model is not shown. Rows show each item's `title` and `hint` with its `iconUrl`, falling back to
`icon` and then a generic link icon: set both, as for the sidebar list.
Agents use `list_intelligent_cards` then an `app-card` block in `intelligent_ui`. Rendering does
not read records into model context, save links, analyze videos, or create tasks. Keep those
operations in existing domain tools/skills. Old hosts ignore the optional declaration.

### Tool result cards: ctx.registerToolResultRenderer (2026-10-19+)

A bundle whose engine half registers tools can give each tool a native result card in the chat, drawn by your
desktop half in the host's DOM (not an iframe), instead of the generic one-line tool record:

```js
ctx.registerToolResultRenderer?.({
  tool: 'make_chart',             // exactly the name your engine half registered
  title: () => (ctx.getLocale?.() === 'en' ? 'Chart' : '图表'),   // card / placeholder / Desk capsule name; default = tool name
  surface: 'inline',              // default; 'desk' = straight into the Agent Desk (see below)
  mount(el, call) {
    // call: { id, tool, args (parsed JSON), result (text the model saw), surface, state, quote }
    const view = drawChart(el, call.args, call.state.get())
    view.onZoom((z) => call.state.set({ zoom: z }))
    view.onPick((label) => call.quote(label))
    return () => view.destroy()
  },
})
```

- **Ownership**: the host only hands you calls of a tool that one of your bundle's engine plugins
  (`tangu-plugins/<id>/`) has registered right now, and that no core tool or other plugin also registers. A core tool (`write_file`…), another plugin's tool, or any tool
  while the engine list is not known yet stays a generic record. A market install whose engine half gets a
  `market_…` alias name does not match its plain tool name: ship engine + desktop halves in one bundle.
  The one exception is fixed in the host: the signed Forsion Extend may draw the core `publish_web_page` and
  `forsion_account` tools (web publishing cards), and only while the engine reports one of its engine plugins as
  official. Third-party plugins cannot get on that list.
- **Narrowing by arguments (2026-10-28+)**: add `match({ tool, args })` to take only some calls of the tool, e.g.
  `match: ({ args }) => args?.section === 'web_pages'`. `false` or a throw = the generic record. `args` is the parsed
  JSON, or the raw string when it did not parse.
- **Web page body (2026-10-28+)**: a card about a web page (a published link, a local file, a server) should mount
  `ctx.ui.mountWebCard(el, card)` instead of drawing its own thumbnail and buttons, so it reads as the same family as
  the host's own local page and server cards. See [references/host-ui-mounts.md](references/host-ui-mounts.md).
- **When the card shows**: only for finished, successful calls. While the call runs, when it failed (`isError`),
  while it waits for approval, when your `mount` throws, and while your plugin is disabled or reloading, the generic
  record shows. Disabling the plugin unmounts every card (your cleanup runs). History works: the host matches by
  tool name, so reopened conversations get the cards too.
- **What you get**: data plus two narrow actions. No file writes, no sending messages: changes go through your own
  commands or engine tools. `call.quote(text)` attaches a quote card above the chat input (same as selecting reply
  text and pressing Quote); the person decides whether to send it. `result` is what the model saw, so put the
  structured data your card needs into the tool result itself.
- **Surfaces and moving**: `inline` cards sit in the reply where the call happened, with an "Open in Desk" button.
  `surface: 'desk'` cards go straight into the Agent Desk (half width) when the result arrives live, leaving a
  placeholder in the chat (name, plugin name, "Showing in Desk", "Back to chat"); the Desk capsule's ⋯ has "Move back
  to chat". Every move remounts you in the new place after cleaning up the old one, with `call.surface` telling
  you which: keep view state (scroll, zoom, selection) in `call.state` (in memory, keyed by call id) and restore it
  on mount. Where there is no Desk (phone, Desk turned off, a window too narrow to show it) everything is inline.
- **Styling**: the host draws the frame and the header (`title · plugin name`); draw only the content, with theme
  tokens (`var(--text)`, `--text-muted`, `--border`, `--accent-ink`, `--ui-font-body`…). No fixed colors, no own
  frame or shadow. In the Desk you get the whole pane: size to the element, not to a fixed width.
- **Not this**: pages from external MCP servers (`ui://` in a sandboxed iframe) are a later, separate step; an
  Intelligent UI HTML card is drawn by the model's own built-in tool, not something you register.

### 前置条件:onboarding.requires(2026-09-21 起)

1. **只为「不做就不工作」的东西写 `requires`**:没填的地址 / 令牌、没给的系统授权、服务端没配的依赖。
   用法说明写 `steps` / README。**不写励志句、营销句**;`intro` 一句话说清要做什么才能用,没有就不写。
2. 有 `requires` = **闸**:宿主实测,有 `unmet` 才弹检查卡 / 挂「待引导」/ 投一次 Inbox。没有 `requires` =
   **使用说明**:只在详情页里折叠展示,不弹不挂不提醒。**没有「完成设置」按钮,`__setupDone` 已废**,别读写它。
3. 只有三类,**里面不放文案**:
   - `{ "kind": "setting", "key": "serverUrl" }` —— key 必须 `registerSetting` 过(否则永远「无法检查」);
     判据 = localStorage `plugin.<id>.<key>` trim 后非空**且 ≠ `default`**,所以必填项 `default` 写 `''`,别写能用的默认值或示例值。
   - `{ "kind": "permission", "id": "microphone" }` —— id 只能是 `computerAccessibility` / `computerScreen` / `microphone` / `camera` / `screen`。
   - `{ "kind": "check", "id": "server-ready" }` —— 配套 `ctx.registerReadiness?.({ id, label, check })`,**必须可选链**(旧宿主没有这个方法)。
     `label` 是字符串或 `() => string`,按 `ctx.getLocale?.()` 给中英。
4. `check()` 返回 `'ok' | 'unmet' | 'unknown'` 或 `{ state, detail }`(`detail` 用户可见 → 中英两份)。
   **拿不准一律 `'unknown'`**:离线、未登录、本端没有 `window.tangu`、探测出错、HTTP 失败说不清原因。
   只有**确认**没配才回 `'unmet'` —— unknown 永远不算未满足,宿主不拿它催用户。
5. `check` 只在用户打开检查卡 / 点「重新检查」/ 手动启用 / 商店装完时被调,**启动期不调**,8 秒超时按 unknown。
   别在里面做重活,也别指望它在后台跑。
6. key / id 须匹配 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`,≤8 条;坏条目被 `sanitizeOnboarding` **静默丢弃**
   (全丢光闸就退化成说明,不报错)。英文走 `onboarding.en.intro` / `onboarding.en.steps`(与 `steps` 按下标对齐)。
   在 Forsion 仓里时,改完 manifest 用宿主真消毒器验一遍(命令见正典文档「前置条件与使用说明」节)。

范例:`samples/forsion-sample-bundle/`(setting 类 + `check.mjs` 断言 requires 的 key 都注册过)。

### 前置插件 requiresPlugins 与生命周期(2026-10-02 起)

- manifest `"requiresPlugins": ["other-id", { "id": "x", "minVersion": "1.2.0", "market": "x-slug", "name": "X" }]`(≤8 条;
  `market` = 商店 installSlug,新上架的条目是 `market-<商店 ID>`;设置页「在商店中查找」拿它预填搜索;`name` = 前置没装时显示的名字)。
  前置算齐 ⇔ 已安装、没被门禁挡、版本 ≥ `minVersion`、**正在运行**。没齐时:用户关着 → 开关灰掉开不了;用户开着 → 「等待前置插件」,
  前置就位自动激活;前置停用 / 卸载 → 自动暂停(依赖方先停),回来自动恢复。互相依赖成环的永不激活。
- 前置的意思是「我要它注册的东西在」(视图 / 命令 / 文件类型),**不是**「我能 import 它」—— 插件之间仍然不直接互调。
- **宿主替你记账**:经 ctx 登记的一切(订阅、挂载、字体、主题样式、编辑器扩展、属性类型、伴随面、在飞的 `complete`……)在停用 / 重载 /
  setup 失败时由宿主按相反顺序撤掉,详情页「运行占用」列着此刻挂了什么。你自己起的 `setInterval` / `addEventListener` 宿主看不见 ——
  仍然要在返回的 disposer 里清。
- **async setup**:可以 `return` 一个 promise。同步那段返回即算启用;resolve 出的函数就是 disposer(那时已被停用 / 重载 → 宿主当场调用它);
  reject 与同步抛错同一处理 —— 回滚已登记的一切、详情页显示「加载失败」、依赖它的插件跟着暂停,直到用户重开或重载。
  停用之后 await 醒来再 `register*` 一律作废(拿到空操作)。

### 双语与图标

- `ctx.getLocale()` 取初值 + `ctx.subscribeLocale(cb)` 只报变化。判定 = **切语言时视图不重挂也要变**;
  但整树重建会吃掉用户没提交的输入 —— 重建前快照、重建后回填。
- ⚠️`t()` 的占位符替换**必须单趟正则**:`s.replace(/\{(\w+)\}/g, (m,k)=> (k in vars ? String(vars[k]) : m))`。
  逐个 `split('{k}').join(v)` 会让先替进去的值被后面轮次再吃一遍(用户把卡组命名成 `{n}` → 自己的数据被当占位符)。
- ⚠️**会落盘的兜底默认名(文件名、frontmatter 值)一律钉死中文常量,不许取 `t()`** —— 否则英文界面建出来的
  文件名与中文界面对不上,同一个库里冒出两套。
- **slash 项的 `label` / `group` 可以传函数**(`label: () => t('…')`,2026-09-28 起):宿主每次渲染 slash 菜单时求值,
  切语言即时跟上 —— 传字符串会定格在注册那一刻(首次启动的 IP 语言校正还发生在插件 setup 之后)。
  其余贡献点的**标题仍是注册时的单字符串**(命令 title / view title / setting label / 成就标题),
  宿主不做运行时重解析 → 切语言要等重启。**不许**用「语言变了就 teardown 重注册」绕(会打断录音、写队列、已开的视图)。
- `icon` 一律写宿主词表里的名字(`'template'` / `'pin'` / `'callout-warning'`…),**别塞 emoji** ——
  命中词表宿主就画和内置项同一套 SVG。全表见正典文档「图标」节与 `components/icons` 的 `PLUGIN_ICONS`;
  ⚠️词表键全是 `[a-z0-9-]`,只增不改不删。


## Tangu host APIs: read references/tangu-host-apis.md

`ctx.tangu` (current model, agent status, agent roster, startChat, mountChat, mountComposer, complete, translate, fim), `ctx.desk`, `ctx.summary` and `ctx.automation` are documented in [references/tangu-host-apis.md](references/tangu-host-apis.md). None of them exist on non-Tangu hosts, so always use optional chaining. When the table above says 见下「…」 for one of them, read that section there:

- 当前模型与当前 Space:ctx.tangu(2026-08-29 起)
- Agent 状态:agentStatus / subscribeAgentStatus(2026-09-19 起)
- Agent 名册:agents(2026-09-20 起)
- 开新对话:startChat(2026-09-19 起)
- 把对话挂进自己的视图:mountChat(2026-10-04 起)
- 新对话输入区:mountComposer(2026-10-18 起)
- 正文 AI:ctx.tangu.complete 与 registerSelectionAction(2026-09-28 起)
- 翻译:ctx.tangu.translate(2026-10-13 起)
- 行内补全:ctx.tangu.fim(2026-10-26 起)
- Agent Desk 伴随面:ctx.desk(2026-09-19 起)
- 摘要栏插件卡:ctx.summary(2026-10-25 起)
- 自动化规则播种:ctx.automation(2026-09-02 起)


## 日历成员登记:ctx.calendar(2026-09-02 起)

Calendar Space 是**显式成员制**:有 `calendarDate` 列的表不会自动出现在日历里,得登记。插件种下任务表后:

```js
ctx.calendar?.ensureMember(`${ctx.app.workFolder()}/任务表.db`, 'c-date' /* 日期列 id */, 'c-done' /* 可选:完成勾选列 id */)
```

- 同步返回 void。已是成员 → **no-op**(不覆盖用户改过的列映射);库还没恢复 → 等库恢复后再登记(最多 60s)。
- 列给的是**列 id**(不是列名);日期列用 `calendarDate` 类型。
- 与 `ctx.automation` 不同,这条不需要 Tangu 宿主 —— 纯 Amadeus 壳也有;旧宿主没有,可选链。
- 只想「没有就加」用它;要**改**列映射、撤成员、改颜色,用下一节 `"calendar"` 能力档的写口。

### 日历叠加源与设置:ctx.calendar 的 `"calendar"` 档(2026-10-17 起)

Desktop 2.13.6+: plugins declaring both `databases` and `calendar` also receive the local personal calendar as the exact opaque path `human://CALENDAR.db`. Use `ctx.databases` writes, `ctx.ui.mountRecord`, and `ctx.app.mutateDb` (schema/name changes) with that path unchanged; never pass it to filesystem APIs. It is first in calendar members and the fallback default; the host hides the old vault mirror. Hosts without a local human calendar omit it. Database-only plugins do not receive this source. Its intrinsic date/done mapping and membership are managed: `setMember` and `removeMember` return false; use `setHidden` to hide it. Subscriptions own loading, focus refresh and teardown; writes retain the host CAS/replay protocol.

做一个完整的日历插件,光有库里的表(`ctx.databases`)和笔记任务(`ctx.noteTasks`)不够:宿主日历还叠着三类**只读源**
(Agent 日程、用户加的 .ics 订阅、Local↔Cloud 另一侧库里的表),以及用户的**日历设置**(哪些表在日历里、各用哪一列、颜色、
藏起来的源、新建默认落哪张表)。这一档把它们给插件,**default-deny**:

```json
{ "id": "my-calendar", "capabilities": ["calendar", "databases", "noteTasks"] }
```

```js
if (ctx.calendar?.subscribe) {                  // 没声明 "calendar" → ctx.calendar 只有 ensureMember
  const off = ctx.calendar.subscribe(({ ready, members, overlays, colors, hidden, defaultPath }) => {
    // members:[{ path, dateCol, checkboxCol? }] —— 已按宿主规则解析好的成员,行去 ctx.databases 的快照里按 path 找
    // overlays:只读表,形状同 ctx.databases 的表 + origin('agent' | 'ics' | 'otherVault')+ otherVault 的 vaultLabel
    // colors:每个成员 / 叠加源的 '#rrggbb',和宿主图例一致;hidden:用户藏起来的路径
    render({ members, overlays, colors, hidden, defaultPath })
  })
}
ctx.calendar?.setColor?.(path, '#5aa98b')       // null = 回到调色板色
ctx.calendar?.setHidden?.(path, true)
ctx.calendar?.setMember?.(db.path, dateColId, doneColId)   // 加进日历 / 改映射(会覆盖用户改过的)
ctx.calendar?.setDefault?.(db.path)
ctx.calendar?.removeMember?.(db.path)           // 只撤成员,不删表
```

- **订阅会让宿主替你刷新叠加源**:Agent 日程每分钟拉、.ics 订阅每半小时联网拉、换库时重读另一侧 —— 和打开着的宿主日历共用一个计时器,
  最后一个订阅者退订就停。只用设置不用叠加源也得订阅(设置在同一份快照里),用完退订;插件停用时宿主统一退订。
- `ready` waits for vault tables and the initial local personal-calendar read to settle (missing/unavailable also settles);叠加源各自尽力而为,Agent 引擎不在、.ics 拉不下来都只是少几个源,不报错。
- **写口都返回 boolean**,false = 宿主不收:颜色只收 `#rrggbb`;`setColor` / `setHidden` 的路径只认库里的表或当前的叠加源;
  `setMember` 只认库里可写的表,日期列必须是日期类列(`base === 'date'` 或 `calendarDate`)、勾选列必须是勾选类列;
  `setDefault` 只认可写的成员;`removeMember` 只认显式登记过的成员,而且日历做过首次整理才收(从没打开过日历的库里,订阅会在 `ready` 后替你做这一步,成员不变 —— 先订阅、等 ready 再撤)。叠加源不能当成员、不能设默认,拿它的 path 调 `ctx.databases` 的写口也是 false。
- 设置按**当前库**生效,和宿主日历左栏「日历」列表改的是同一处(存在本机,不进库文件、不同步)。
- 详情页那一行会多一项「读取 Agent 日程、.ics 订阅和另一侧库里的日历，管理 .ics 订阅并改日历设置」。

**.ics 订阅管理**(同一档,2026-10-17 起):和宿主日历设置里的「订阅」是同一份列表(存在本机,不进库),改了宿主那边立刻看到。

```js
const id = ctx.calendar?.ics?.add('webcal://example.com/holidays.ics')   // 只收 http(s) / webcal,≤2048 字;同一 URL 已在 → 返回原来那条的 id
const id2 = ctx.calendar?.ics?.importText('课表', icsText)               // 本地 .ics 文本导入(不联网),≤ 宿主的导入上限;解析不出来 → null
ctx.calendar?.ics?.rename(id, '节假日')
const ok = await ctx.calendar?.ics?.refresh(id)  // 立刻联网拉一次;拉成功才 true,导入的(没有 URL)恒 false
ctx.calendar?.ics?.remove(id)
// 快照里:icsSubscriptions: [{ id, path: 'ics://<id>', name, url, error? }];事件本身在 overlays(origin 'ics')里
```

- 不收的一律返回 `null` / `false`,不抛;插件停用后全部不做。删订阅不会删任何库文件(它本来就不在库里)。

### 日历 / 待办类插件的其余入口(2026-10-17 盘点)

- **跳到笔记里的某个标题**:`ctx.app.openNote?.(task.path, { heading: task.heading })` —— 与 `[[笔记#标题]]`、聊天引用条同一套跳转;
  找不到那个标题就只开笔记;跳标题会聚焦那篇笔记,所以带 `activate: false` 时只开不跳;旧宿主忽略 `heading`。**打开多维表视图**:`ctx.app.openFile(db.path)`(`.db` 路由到表格视图),不用另找方法。
- **迷你窗**:Space 配方的 `mini`(见上「Mini Panel 适配」)或 `ctx.openMiniPanel`,宿主日历的迷你待办也是这条路。
- **Intelligent UI**:给待办之类的列表源写 `intelligent`(见「Intelligent UI list cards」),宿主用原生列表画卡片,不画插件 DOM。
- **用户仪表盘里的卡片**:插件视图**不能**嵌进用户的 `.dashboard.md`(嵌卡是宿主白名单,插件自声明不算数)。要在自己视图里放仪表盘用 `ctx.dashboard.mount`。
- **提醒**:笔记里 `@remind:` 的到点通知由宿主发,和日历是哪个插件无关;宿主没有给插件排定时提醒的接口 —— 插件运行期间要提醒用 `ctx.notify`。
- **带按钮的通知(撤销)**:`ctx.notify(msg, { action: { label, run }, key })` —— `label` 截到 40 字,有按钮时通知留 8 秒;插件停用后点按钮什么都不做;
  `key` 让同一件事的通知合并成一条(宿主加 `plugin:<id>:` 前缀,和别的插件撞不上);合并时按钮跟新的这条走,新这条没带按钮就清掉旧的。
- **事件浮卡里的那排字段**:`ctx.ui?.mountRecord?.(el, { path, rowId, dateCol?, readOnly? })` 把宿主的行编辑字段(标题、时间摘要 + 展开编辑、
  其余属性)画进你的容器,返回 `{ update(patch), dispose() }`;改动直接写那张表(同 `ctx.databases.setCell`,和打开着的表格同一份),
  行被删 / 换库就什么都不画;`path` 不是库里的表或没有 `rowId` 当场抛 `TypeError`。外框、关闭、「打开 / 删除」按钮、定位归插件。
  `dateCol` 那一列当时间行、不在属性里重复(必须是日期类列,别的列类型忽略、照常列在属性里);叠加源(只读表)或 `readOnly: true` 只显示值。**声明 `"databases"` 才有。**
  2026-10-24+:`body: true` 在字段下面挂这条记录的 Markdown 正文编辑器(与表格「打开记录」同一份正文、同一条写口;只对可写经典表,笔记视图 / 叠加源 / `readOnly` 不画);
  `hideColumns: [colId…]` 不列出这些属性列(例如你已经画了勾选框的完成列)。`ctx.databases` 快照的行多了 `hasBody?: true`(正文非空),画「有备注」标记用。旧宿主忽略这三项,照常只有字段。
- **界面**:插件拿不到宿主的 React 实例,也拿不到宿主组件。要宿主零件就走 `ctx.ui.mount*` / `ctx.ui.mount(name, el, props)`(行编辑字段就是上面的 `mountRecord`;菜单、弹出层、对话框、下拉、分段、空态、图标见「Host parts」),只传数据;**不要把宿主的菜单 / 浮层 / 对话框 / 图标 / i18n 抄一份进包** —— 抄的是某一天的快照,宿主后来的退场动效、材质、夹边修复它都没有。自己的大块画面(日历网格这类)可以用自带的 React 画,边界是挂载点 DOM。

- **事件操作**（2.13.7+）：`ctx.calendar?.events` 共用宿主的完整记录剪贴板和条件撤销历史。`copy(path,rowId,dateCol,before,cut?)`、`clone(path,rowId,dateCol,before,after?)`、`paste(path?,ISO时间?)` 保留记录正文／属性／关联，笔记视图保留完整笔记。`reschedule` / `rescheduleNote` 检查旧日期；`remove` 复用原删除语义；`undo` / `redo` 不覆盖后续编辑。`clipboard()` + `subscribe(cb)` 供界面画剪切态，`scope()` 区分智库，`clearClipboard()` 清空。只在声明 `calendar` 能力后提供；旧宿主需检测，不能手写有损复制来降级。
- **从原生列表导航到筛选后的视图**（2.13.7+）：`ctx.openView('todo', { params: { view: 'today', db: 'Tasks.db' } })` 把参数交给这个视图的 leaf，挂载方通过 `view.getParams()` / `onParamsChanged(cb)` 读取，`view.setParams(patch)` 保存。仍只能打开本插件自己的视图。

## Space 与 Ribbon 收纳架:ctx.spaces(2026-10-18 起)

做「启动台 / 主页」一类插件时用:列出用户的 Space、点一下打开、画出图标和近况,在自己的界面里调整 Ribbon 上区的顺序和收纳夹。
manifest 必须声明 `"spaces"`(详情页会列出「打开 Space,调整 Ribbon 上 Space 的顺序和收纳夹」),没声明时 `ctx.spaces` 不存在。

```json
{ "id": "my-launcher", "capabilities": ["spaces"] }
```

```js
const s = ctx.spaces
const draw = () => {
  grid.replaceChildren()
  for (const it of s.shelf.items()) {                 // 按用户在 Ribbon 上排的顺序
    const tile = document.createElement('button')
    if (it.kind === 'space') {
      const icon = document.createElement('span'); tile.append(icon)
      disposers.push(s.mountIcon(icon, it.spaceId, { size: 20 }))   // 图标由宿主画(Space 图标是宿主组件 / 图片)
      tile.append(it.name)
      tile.onclick = () => s.open(it.spaceId)
    } else tile.textContent = `${it.name} (${it.spaceIds.length})`
    grid.append(tile)
  }
}
const off = s.subscribe(draw)                        // Space 注册 / Ribbon 顺序变了就重画
```

- **收纳架写的就是 Ribbon 那一份**:`shelf.move(id, targetId)` 把 `id` 落到 `targetId` 那一格,Ribbon 上跟着变;`moveIntoFolder(folderId, id)` /
  `moveOutOfFolder(id)`(回到顶层末尾)/ `reorderFolder(folderId, id, targetId)` / `addFolder(name)` / `renameFolder(id, name)` / `removeFolder(id)`(成员回到原位)。
  别自己存一份顺序 —— 两份迟早对不上。`items()` 不含收纳夹里的成员(它们在 `spaceIds` 里),含你自己那个 Space(不想画就自己滤掉)。
- `mountStatus(el, id)`:宿主把这个 Space 的近况那一行(继续某会话、最近的笔记、下一条日程、未读数;`actions()` 那两格是已装插件数、可领成就)画进 `el`,
  跟着数据自己更新;拿不到就是空的。目前只有内置 Space 有近况,插件 Space 还报不了自己的。
- `actions()`:商店、成就两格 `{ id, name, run() }`,图标同样用 `mountIcon(el, id)`。
- `open(id)` 口径同 Ribbon 上点它;本窗口是锁在某个 Space 上的 Space 窗口时,开到那个 Space 自己的窗口。不认识的 id → `false`。
- `mountIcon` / `mountStatus` 返回卸载函数,之后 `el` 立刻还给你;插件被停用 / 重载时宿主统一收掉,`subscribe` 也一并退订。
- `mountIcon` 画的图标跟着 Space 走:同一个 id 重新注册换了图标(插件更新了 `iconFile`)宿主原地重画;挂的时候还没注册的 id 先空着,注册上了再画 —— 不用为换图标自己重挂。

## 全库多维表与笔记任务:ctx.databases / ctx.noteTasks(2026-10-16 起)

日历、待办、习惯这类插件要的是「库里所有带日期 / 勾选列的表」和「笔记里 `- [ ] … @2026-10-20` 那种任务」,
不是某一张固定的表。两条接缝写的是用户自己的数据,**default-deny**:manifest 里声明了才注入,没声明 `ctx.databases` /
`ctx.noteTasks` 整个不存在(旧宿主同样不存在)。

```json
{ "id": "my-planner", "capabilities": ["databases", "noteTasks"] }
```

```js
const offDb = ctx.databases?.subscribe(({ ready, databases }) => {
  if (!ready) return showLoading()          // ready:false 时的空列表 ≠ 库里没有表
  const withDates = databases.filter((db) => db.columns.some((c) => c.base === 'date' || c.type === 'calendarDate'))
  render(withDates)                          // 每次都是整份新快照,别原地改
})
// 拖动改期 / 勾选:和用户在表格里改一格是同一条路
ctx.databases?.setCell(db.path, row.id, dateColId, '2026-10-20T15:00/2026-10-20T16:00')
// 2.13.7+:经典表的条件写入;当前不匹配返回 false,CAS 重放时也检查，适合完成待办后的撤销。
ctx.databases?.setCell(db.path, row.id, doneColId, undefined, { value: true })
const id = await ctx.databases?.addRow(db.path, { [dateColId]: '2026-10-21' }, '交周报')
const undo = ctx.databases?.deleteRow(db.path, row.id)   // 经典表才有撤销;笔记视图返回 null

const offTasks = ctx.noteTasks?.subscribe(({ ready, tasks }) => {
  if (!ready) return showLoading()          // 同上:库还没恢复 / 刚换库时的空列表 ≠ 笔记里没有任务
  renderTasks(tasks.filter((t) => t.isTask))
})
ctx.noteTasks?.update(task.id, { checked: true })        // false → 让用户去笔记里改:ctx.app.openNote(task.path)
```

- **表的两种 `kind`**:`table` = 经典 .db(行在文件里);`notes` = 笔记视图(一行 = 文件夹里一篇笔记,行 id 就是笔记路径,
  属性在 frontmatter)。列给 `type`(原样,含自定义类型)和 `base`(落盘的基础类型);找日期列看 `base === 'date' || type === 'calendarDate'`,
  勾选列看 `base === 'checkbox'`。日期值:`YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`,区间用 `/` 连两头。
- **与 `ctx.app.mutateDb` 的分工**:mutateDb = 单张 .db 的整文件比对交换(升级列结构、批量改);`ctx.databases` = 按行按格、
  和打开着的表格 / 编辑器实时一致,而且覆盖笔记视图。
- **写口都按「表格里改一格」的规矩**:`setCell` 返回 false = 表 / 行 / 列不存在、值不是合法单元格(字符串 / 数字 / 布尔 / 字符串数组 / null)、
  或那列是自动编号 / 创建时间(建行即定);`undefined` 清空该格。笔记视图的标题列(`type: 'page'`)= 笔记名,`setCell` 改它就是给笔记改名(只收非空字符串)。`addRow` 只收已有列,自动编号 / 创建时间由宿主盖;
  `duplicateRow` 同样重新盖章。
- **删除**:`deleteRow` 只删经典表的行,返回撤销函数(只生效一次;用户换了库再调不做事)。笔记视图的行是一篇笔记,
  这里不删(返回 null)——要删就 `ctx.app.trash(rowId)`,进回收站可恢复。
- **笔记任务**:`id` = `路径:行号`,两次加载之间稳定,笔记里行挪了会变 —— 每次以最新回调为准,别存起来。`isTask:false` 的普通行
  (`交周报 @2026-10-20`)没有勾选框,`update({checked})` 返回 false。`update` 先反映在下一次回调里,稍后写回那一行 markdown;
  那行已经对不上时宿主自己提示用户去笔记里改。网页 / 手机宿主不能回写 → false。
- 两个 `subscribe` 都**立刻回调一次**,插件停用时宿主统一退订(返回的退订函数照样可以自己调)。`ready` 两边同一个意思:库已恢复、**当前这个库**拉过了;换库那一刻翻回 `false`。(2026-10-16 早些的 seams 分支上 noteTasks 在库恢复前会先给 `ready:true` + 空列表,已修。)
- **声明的能力会写给用户看**:插件详情页在描述下面列一行「这个插件可以：读写你的多维表、读写笔记里的 @ 任务、读取前台窗口」(只列声明了的那几项,`activeWindow` / `calendar` 同理)。只声明真要用的 —— 多写一项,用户在详情页就多看到一项授权。
- 端到端台架:Genesis `desktop` 的 `npm run check:plugindata`(真 Electron × 外置探针插件 × 预置库,核对注入闸、ready 先假后真、写口落盘、详情页那一行;10-17 起含 `"calendar"` 档的闸、成员快照与 `setColor`)。

## Floating Panel:正式第六种面板(2026-09-17 起)

设置、商店、成就、反馈这类独立工具页不再自己盖全屏，统一走 Floating Panel。插件也先 `registerView`，再开面板：

```js
ctx.openFloatingPanel?.('inspector', {
  title: 'Inspector', params: { source: 'command' },
  width: 880, height: 640, minWidth: 560, minHeight: 420,
})
```

- 桌面端是真 BrowserWindow：可拖、可缩放、可最小化/关闭，并保持在主窗口上方；相同插件 view id 复用窗口。
- Web 是主界面上方固定居中的面板，**故意不可拖**；移动端不伪造桌面窗口，回退普通主视图。
- `mount(el, view)` 收到 `view.surface === 'floating'`，没有 `extendView`；`getParams/setParams/onParamsChanged` 照常，`showInMainPanel?.()` 将当前参数交回主区。
- 宿主自动命名空间，插件只写自己的相对 id；禁用插件或反注册 view 后，已开的原生窗口/Web 面板自动关闭。`mount` disposer 必须收订阅和计时器。
- 详细契约见 `Forsion-Genesis/docs/customization/floating-panel-development.md`；桌面回归 `npm run build && npm run check:floatingpanel`。

## 自绘浮层 / HUD:三条纪律

整页工具优先用正式 Floating Panel。只有锚定菜单、短时 HUD、画布工具等不适合注册成独立 view 的小层，才在渲染进程自行挂 DOM。此时：

1. **接鼠标的覆盖层根必须 `-webkit-app-region: no-drag`,且 append 到 body**(DOM 顺序须晚于 Shell)。mac 拖窗区按 **DOM 顺序**合成、**与 z-index 无关**;ribbon 与左侧栏是拖窗区,重叠矩形内的点击/hover/滚轮全被吞。**浏览器台架照不到,只有真 Electron 能验。**
**⚠️反向纪律:不遮挡的「HUD 层」正相反,绝不能写 no-drag。** 全屏浮层要 no-drag 是因为它盖住了拖窗区
还要能点;而一层**贴在角落、`pointer-events: none` 的装饰层**(游戏式 HUD、演出提示、角标)落在 ribbon
的拖窗区上,写了 no-drag 等于把那块**从拖窗区抠掉** —— 用户从此拖不动窗口,而且这个 bug 与浮层本身
毫无关系,极难联想。`-webkit-app-region` 是**几何合成**,与 hit-test 无关:`pointer-events: none` 挡不住它,
默认值 `none` 才是「既不加也不减」。判据一句话:**浮层要接鼠标 → no-drag;浮层纯装饰不接鼠标 → 什么都别写。**

2. **别指望 z-index 压过 Shell**(`.shell-host{isolation:isolate}` 已封箱)—— 靠 DOM 后置取胜。
3. **锚定式浮层别手写 `left/top`**:`body` 常年带 CSS zoom,`fixed` 的 `left/top` 也吃 zoom。整屏 `inset:0` 不受影响;贴元素的菜单 / 小面板走 `ctx.ui.contextMenu({ anchor })` / `ctx.ui.popover(anchor, …)`(2026-10-26 起;`@lcl/engine` 的 `OverlayAt`/`clampMenu` 是宿主内部,插件 import 不到)。更早的宿主只能原生 `popover` + 自己按「Pointer math under host zoom」那条除以 `currentCSSZoom` 并夹进视口。

**裸字母快捷键别注册成宿主热键**:`installHotkeys` 没有输入焦点闸,绑了 `f` 会在聊天框打字时触发。自挂 `keydown`,守卫必须含 `e.isComposing || e.keyCode === 229`(中文输入法选字)+ `INPUT/TEXTAREA/isContentEditable` + 「别的全屏浮层开着时让路」。顺带**也**注册一条 `registerCommand`,命令面板能搜、用户能改键。

参考实现 `Forsion-Instrumentality-Project/forsion-plugin-inspect`(检视台),`check.mjs` 把这几条做成了静态断言。

## Pointer math under host zoom (2026-10-05)

The host scales the whole interface with CSS `zoom` on `<body>` (the user changes it at any time; it is often not 1), so a view works in two pixel spaces. `clientX/clientY` and `getBoundingClientRect()` are **viewport** pixels; `style.left/top/width/height`, `translate()` offsets, `scrollLeft/scrollTop` and `clientWidth/offsetWidth` are the element's **own** pixels.

**Rule: when a pointer position or a `getBoundingClientRect()` value becomes one of your own pixel values, divide the viewport distance by that element's `currentCSSZoom`.**

```js
const cz = () => track.currentCSSZoom || 1 // read at pointer time, never cached at mount
const xIn = e => (e.clientX - track.getBoundingClientRect().left) / cz() // → style.left, scrollLeft, time = xIn / pxPerSecond
const dx = e => (e.clientX - startX) / cz() // drag distance → width, translate offset
```

- Read it when the pointer event fires, on the element whose pixels you write: zoom can change while the view is open, and `currentCSSZoom` is 1 for an element that is not rendered (`display: none`, detached).
- No division when both sides are viewport pixels: hit-testing `clientX` against a rect, or a ratio such as `(e.clientX - r.left) / r.width`.
- Skipping it puts every landing off by (zoom − 1) × the distance from the element's origin: playheads, clips, sliders, resizers, canvas pan and marquee drift further the farther the pointer is from the left/top edge. Test rigs run at 100% and stay green.
- Test once before shipping: run `document.body.style.zoom = '1.5'` in DevTools, drag far from the element's left edge, and check the thing stays under the pointer (reload to restore the user's zoom).
- Anchored overlays are the same conversion; use `ctx.ui.contextMenu({ anchor })` / `ctx.ui.popover(anchor, …)` (2026-10-26+) instead of repeating it — `OverlayAt` / `clampMenu` are host internals a plugin can't import.

## 库内二进制资源 + 第三方库进包(2026-08-29 起)

`ctx.app.readFile` 只读 UTF-8。`.glb` / 字体 / 任意 blob 走资源协议:

```js
const buf = await fetch(`amadeus-asset://v/${encodeURIComponent(vaultRel)}`).then((r) => r.arrayBuffer())
```

按 vault 夹紧(越界 403)、支持 Range、`<img>`/`<video>` 也能当 `src`。⚠️**需要 Forsion ≥ 2.9.0**(CSP 的 connect-src 放行它是 2.9.0 才进的,2.8.1 及更早没有)—— 更早版本 CSP 的 `connect-src` 没放行它,症状是「`<img>` 能显示、fetch 一律 `Failed to fetch`」。文件让用户放进 `ctx.app.workFolder()`,`ctx.app.listFiles?.()` 列出来;**别随包分发大资产或有版权的第三方资产**。仪器:desktop 的 `npm run check:assetfetch`。

**写/读字节(2026-09-19 起)**:`ctx.app.writeBytes?.(path, bytes)` / `ctx.app.readBytes?.(path)`。导入用户选的文件
不需要宿主的文件对话框 —— 在自己的 DOM 里放 `<input type="file" accept=".vrm,.glb" multiple>`(或拖放区),
`File.arrayBuffer()` 没有大小上限:

```js
const bytes = new Uint8Array(await file.arrayBuffer())
await ctx.app.writeBytes?.(`${ctx.app.workFolder()}/models/${file.name}`, bytes)   // 原子写、父目录自动建、已存在即覆盖
const back = await ctx.app.readBytes?.(`${ctx.app.workFolder()}/models/${file.name}`)  // Uint8Array | null
```

- 路径口径同 `writeFile`(库相对、越界由宿主钳死);收 `Uint8Array` / `ArrayBuffer` / 任意 TypedArray 视图(按字节原样)。
  没有活动库 → `writeBytes` reject `'No vault is open'`,`readBytes` 给 `null`(见上「没有活动库」表)。
- ⚠️**不走自写账本**:同一路径上的 `watchFile` 会把你自己这次写当成外部改动回调一次 —— watch 着自己写的文件时,回调里先比一下内容。(`watchFile` 只盯文本配置类文件和 PDF,别的二进制不报。)
- 多文件模型(`.gltf` + `.bin` + 贴图)要保留相对目录:`<input webkitdirectory>` 给每个 `File` 带 `webkitRelativePath`,逐个写到
  `${dest}/${f.webkitRelativePath}`。

**three.js 模型的两个坑**(`.glb` / `.vrm` / `.gltf`):
- **内嵌贴图**:GLTFLoader 在 Chromium 上用 `ImageBitmapLoader`,对内嵌图片走 `fetch(blob:)`;`.gltf` 里 base64 的 buffer 走 `fetch(data:)`。
  2026-09-19 起宿主 CSP 的 `connect-src` 放行了 `blob: data:`,原生 loader 直接能用;**更早的宿主**上贴图加载失败会被 loader 吞掉,
  症状是「模型出来了但一片白、只有一行 console.error」。兼容写法(贴图改走 `<img>`,`img-src` 一直放行 blob:):
  `loader.register((p) => { p.textureLoader = new THREE.TextureLoader(p.options.manager); return { name: 'forsion_csp_texture_fallback' } })`
  —— 旧宿主上 `.gltf` 的 base64 buffer 仍然不行。仪器:desktop 的 `npm run check:assetfetch`(T5–T7)。
- **相对 URI**:`amadeus-asset://v/<encodeURIComponent(整条路径)>` 把 `/` 编成了 `%2F`,`.gltf` 里 `tex/a.png` 这种相对引用按它解析会 404。
  用 `parse(buf, '')` + `manager.setURLModifier((u) => /^(blob:|data:|amadeus-asset:|https?:)/.test(u) ? u : ctx.app.assetUrl(join(dirOf(modelPath), decodeURI(u))))`,
  每端都对(web / unit 的资源 URL 是 `?ref=` 形,拼 base URL 那条路只在桌面成立)。

CSP 是 `default-src 'self'`(没有 CDN),依赖一律 esbuild `bundle: true` 打进单文件。`main.js` **没有大小上限**。需要 disposer 时:

```js
// build.mjs —— IIFE 的返回值会被丢掉,用 globalName + footer 把它 return 出去
globalName: 'myPlugin', footer: { js: 'return myPlugin.dispose;' }
```

## Vault files and the working folder (updated 2026-10-21)

`ctx.app.readFile/writeFile` use vault-relative paths, can access the whole active vault, reject traversal, and create parent folders on write. Every plugin gets the built-in `workFolder` setting. **New default: `Plugins/<effective-plugin-id>`**, for example `Plugins/bluebird` or `Plugins/diting`; Store IDs remain `market-<UUID>`. Display names and interface language never determine a new storage path. Always use `ctx.app.workFolder()` rather than constructing a path from the manifest, install-folder alias or translated label. A valid manual preference wins, including a Chinese or custom path outside `Plugins/`.

Use Markdown for user-facing notes and hidden sidecars for machine data. Keep default output under `Plugins/`; do not invent other top-level folders or write into the vault root. Re-register the built-in setting key to customize its label/description rather than creating a second storage setting. Changing the user's preference does not move existing data.

Local hosts may expose `ctx.app.writeFileScoped?(path, text, expectedRoot, { create: true })`. Capture `expectedRoot = ctx.app.vaultRoot()` before starting an asynchronous task. The host validates it under the filesystem lock and rejects a stale-vault write; create-only writes return `false` when the destination exists, successful writes return `true`. Feature-detect: an older host's renderer-side scope checks across awaits do not provide the same main-process guarantee. Keep that weaker fallback explicit and never silently overwrite an export/log name after a create-only conflict.

For hosts without `workFolder`, either ask for an upgrade or preserve the plugin's established legacy path until a schema-aware recovery can run. Do not silently switch an existing installation to a hard-coded new ID path: that would hide its old data again. `workFolder()` is not a readiness probe; wait for `ctx.app.vaultRoot?.()` and catch write errors when no vault is open.

### Automatic upgrade of old data

The earlier root-level `<display name>` and `Plugins/<display name>` defaults are **legacy sources**, not the rule for new output. Hosts keep an existing display-name folder readable for plugins without migration support. For a plugin implementing migration, feature-detect **both** `workFolder` and `migrateWorkFolder` before requesting `workFolder({ preferId: true })`. That option still honors manual preferences. Await migration/recovery before normal index reads, writes or a task starts; a failed migration must not look like an empty successful collection.

`ctx.app.migrateWorkFolder?(request)` is available on local desktop hosts implementing the contract; unsupported mobile/web/cloud hosts omit it. The plugin validates its own schema and record paths; the host validates the vault and snapshots, copies without overwriting, and commits the index last. **Keep originals as backups.** Never rename/delete user folders, recursively move arbitrary JSON or use a global completion flag. A completed per-vault journal prevents deleted items being imported again. Preserve manual folders and resolve two populated data sets through explicit recovery rather than merging blindly.

Read [the migration contract and acceptance cases](references/work-folder-migration.md) before implementing or changing storage. It defines plan-relative paths, predecessor-journal recovery, interruption handling and media-link preservation. Reference consumers: Bluebird and Diting. Sessions continue using the separate vault `Sessions/` convention.

## 块表面:当前这篇笔记的读写(2026-07-26 起;2026-08-20 改口径)

> **⚠️ 先看 `page.model`。** 普通笔记如今默认是 **v4/unified** 载体,**没有块 id** —— `blocks`/`order`
> 在它上面恒空,正文在 `page.text` 里。块寻址类调用在 v4 笔记上**诚实拒绝并 warn**(不静默),
> 改内容一律用两条路由都成立的 `insertMarkdown`:
>
> ```js
> const pg = ctx.app.getPage()
> const text = pg.text ?? (pg.order || []).map((id) => pg.blocks[id]).join('\n\n')  // 新老宿主通吃
> if (pg.model === 'blocks') { /* v3:可以按块 id 寻址 */ }
> ctx.app.insertMarkdown?.(pg.token, '> 一段引用', 'start')   // 'cursor'(缺省)/'start'/'end'
> ```
>
> **`mountBlocks` 完整可用的地方是插件自定义文件类型**(`.mindmap.md` / `.canvas.md`,经 `file.surface`)
> —— 那类文件按设计钉在 v3,思维导图那套一个字都不用改。下面这段讲的就是它。

**能力对等原则**:内置插件和外置插件拿到的 `ctx` 一模一样,唯一区别是内置的**已经装好了**。此前不是这样 —— 内置插件跑在进程内、能直接给 React 组件,所以只有它们能渲染真块;外置插件是裸 `setup(ctx)` 体,只有 DOM。补上 `ctx.app` 的块表面之后这条缺口关掉了。

想做「一个节点/一张卡片里就是一个可编辑的 Amadeus 块」这类界面(思维导图、看板、白板便签),别自己复刻编辑器 —— **把 DOM 交给宿主渲染**:

```js
const page = ctx.app.getPage()   // {token, path, status, text, model:'blocks'|'text', blocks, order, fmExtra}
const dispose = ctx.app.mountBlocks(el, {
  token: page.token,
  blockId,
  // 传了 onInsertAfter = 宣告「块结构归我管」:笔记式结构键(块首退格并块 / 方向键跨块 / 上下移块)
  // 被中和,而「会新建下一个块」的动作(/数据库 脚手架、非空块里 Shift+Enter)重路由到这里。
  onInsertAfter: (id, content) => addChildNode(id, content),
})
```

**改数据一律要带 `page.token`**:块 id 是**页内**递增的(两页都有 `b1`)。插件拿着 A 页的 id、用户已切到 B 页时继续提交,轻则把块插进 B、重则删掉 B 的同名块 —— 令牌不匹配宿主直接拒绝并 warn。每次 `await` 之后重新 `getPage()` 取新令牌。

| | 用途 | v4 笔记 |
|---|---|---|
| `getPage()` | 当前这篇的快照(**冻结且全插件共用,别改它**) | ✅ |
| `getPage().text` | 整篇正文 markdown(v3 = 块按 order 拼) | ✅ |
| `getPage().model` | `'blocks'`(v3)/ `'text'`(v4)。**分叉判据**;老宿主没这字段 → 当 `'blocks'` | ✅ |
| `subscribePage(cb)` | 正文/块/顺序/外来 frontmatter 变了才回调,返回退订函数 | ✅ |
| `insertMarkdown(token, md, where?)` | 插一段 md,`where` = `'cursor'`(缺省)/`'start'`/`'end'` | ✅ |
| `insertBlockAfter(token, afterId, content)` | 建块,返回新 id(`afterId=null` = 插到最前) | ❌ 返 `null` |
| `deleteBlock(token, id)` | 删块(async) | ❌ |
| `setFmExtra(token, text)` | 写**外来 frontmatter**——你的每页数据存这儿,进页面撤销栈 | ❌ 读可以,写还没开 |
| `undo(token)` / `redo(token)` | 走页面自己的撤销栈(结构改动天然可撤销) | ❌ |
| `requestFocus(id, place)` / `consumeFocus(id)` | 把光标送进某个块(只读焦点,不要令牌) | ❌ |
| `mountBlocks(el, {token, blockId, …})` | 宿主往你的 DOM 里渲染真块 | ❌ 插件文件类型面照常 ✅ |
| `prompt(title, initial)` | 模态输入。**Electron 没有 `window.prompt`,永远别用 DOM 那个** | ✅ |

坑,按踩到的顺序:

- **`page.text` 只读,而且在 v4 上是「上次保存那一刻」的快照**(≤800ms 陈旧)。**绝不「读全文 → 改 → 整篇写回」**:那 800ms 里用户敲的字会被你抹掉。改内容只有 `insertMarkdown`;插进去的文本必须能原样 markdown 往返(连续空格被压 → 宿主重载整篇 → 你的插件状态全没)。
- **不给 v4 合成块 id 是刻意的**:PM 顶层节点没有身份,按位置编号的 id 用户按一次回车就全体位移,而令牌只挡「换了一篇」挡不住「同一篇里 id 易主」。宁可空,不可假。
- **只服务活动页**。Amadeus 是「单活页」模型(同一时刻只加载一处,笔记编辑器和文件类型视图共用),插件跟着走。令牌闸是宿主兜的底,你自己也别拿旧快照连环操作。
- **`fmExtra` 要外科式改**:用户和别的插件的键也在同一份 frontmatter 里,整段重写会抹掉它们。**绝不把数据塞进 `amadeus_layout`**(zod 无 passthrough,未知键加载即被 strip)。
- **`blocks` 的引用是稳定的**:`subscribePage` 靠引用比较去重,自己缓存派生结果时也按引用判,别每帧深比较。快照本身是 `Object.freeze` 的(全插件共用一份,改它没用也不许改)。
- **块 id 会被复用**:落盘前剪掉指向已不存在的块的记录,否则新块会继承旧记录的状态。
- **自己的浮层要小心 `transform`**:`.slash-menu` / 行内工具栏这些是 `position: fixed` + 视口坐标;你的画布若带 pan/zoom 的 `transform`,它就成了 fixed 的包含块,浮层会被平移+缩放一次。把浮层传送到最近的 `.am-app` 下。
- **忘记清理宿主也会兜**:插件被禁用/重载/`setup` 抛错时,你开的 `subscribePage` 与 `mountBlocks` 由宿主统一收掉,之后整份 `ctx.app` 块表面变哑(在飞的异步任务改不动用户文件)。但这是安全网不是设计:该 dispose 还是要 dispose。`mountBlocks` 返回的 dispose 调用之后 `el` 立刻归还(见「dispose 契约」);dispose 再挂是一个新的编辑器,用户正在输入时别这么做(焦点和选区会丢)。
- **内置类型优先是硬规则**:`registerFileType` 的后缀若已被内置认领(`.excalidraw.md`/`.db`/`.pdf`/图片),又没有按下一条显式覆盖,宿主**拒绝注册并返回 `false`** —— 拿到 `false` 就整体退让,连创建器/斜杠项/命令一起别注册(那几个宿主拦不住,不退让用户会看到两份「新建 X」)。旧宿主返回 `undefined`,所以判定写 `=== false`。
- **接管内置的 PDF(2026-10-05 起)**:`.pdf` 是唯一可覆盖的内置后缀。`registerFileType({ id, extensions: ['.pdf'], override: true, mount })` 注册成功后,文件树点击、`ctx.app.openFile`、最近使用都进你的视图;内置阅读器退为兜底 —— 插件停用 / 卸载即回到内置,文件树右键始终有「用内置阅读器打开」。由谁打开归用户定:设置 → 插件 → 已安装 →「默认打开方式」(自动 / 内置阅读器 / 指定插件);「自动」= 归第一个启用中的接管插件,所以别假设注册成功就一定轮到你。不写 `override: true` 照旧返回 `false`;`.excalidraw.md` / `.db` / 图片写了也不行。旧宿主不认这个字段、返回 `false`,照上一条整体退让。要点:
  - **带落点的打开也归你(2.13.2 之后的桌面版本)**:笔记里的 `[[x.pdf#page=3]]`、聊天里的引用(带页码,常常还带一段引语)同样进你的视图,落点经 `mount(el, file)` 的 `file.onGoto?.(cb)` 交给你:`cb({ page, quote? })`,`page` 从 1 起,`quote` 是要在那一页标出来的原文。订阅之后,如果这次打开本身带落点,回调会马上来一次(异步,不在 `onGoto()` 调用里面);视图已经开着时再点别的链接,回调再来,视图不重挂。返回值是退订函数,视图关掉时宿主也会替你收掉。**回调到的时候你多半还没准备好**:文件可能还在加载,或者你的标签刚从后台切回来、还没按新尺寸排过版(这时滚动不生效)—— 把落点记下,等能滚了再跳。不订阅也不报错,只是文件开在你自己的默认位置。2.13.2 及更早没有 `onGoto`:这类跳转(以及笔记里不带页码的 `[[x.pdf]]`)进的是内置阅读器,所以一律 `file.onGoto?.(…)` 探测着用。
  - **换标签、新标签页、对话引用都是宿主管(2.13.3 之后的桌面版本;所有文件类型视图和主区插件视图一样)**:你的标签被换到后台时,宿主把视图的 DOM 从文档里摘下来(不调 unmount,状态都在),换回来原样挂回 —— 摘下期间量到的尺寸和滚动位置都是 0,别在这时候记「看到哪儿」,也别拿这时候的 0 去排版。换回来时宿主把视图里每个滚动容器的位置写回去(更早的版本一律回到顶上),不用自己存;你要是自己也在恢复位置,两边写的是同一个值,不冲突。⌘ / Ctrl + 点击文件树、双链、聊天引用这些入口 = 在新标签页打开你的视图(更早的版本里指向文件的双链会就地顶掉当前标签)。视图在主区显示时,侧栏对话自动把这份文件挂成引用(发给模型的是绝对路径),不用你做什么。
  - **不接管的**:`![[x.pdf]]` 嵌入仍由内置阅读器画(`registerEmbedRenderer` 对 `.pdf` 不会被问到);文件树右键「用内置阅读器打开」是用户点名要内置。
  - **读写走字节**:`ctx.app.readBytes?.(file.filePath)` 读、`ctx.app.writeBytes?.(…)` 存。`file.surface.loadPage` 和 `ctx.app.loadPage` 都只收 `.md` 笔记,对 PDF(以及白板)调用会被拒并打告警(那是笔记管线,放行就把文件写成 markdown);`ctx.app.openNote` 收到非笔记路径会改走 `openFile` 开对的视图。
  - **manifest 不要写 `fileExtensions: ['.pdf']`**:那个字段只保护 `.md` 类文件不被当笔记改写,PDF 用不着;写了反而让开发副本被判 `dev-fileext` 拒载。不写的话可以直接从 Sandbox 加载着测(开发副本只是不能注册 `.md` 类后缀)。
  - **内置阅读器只读(2026-10-05 起不再批注)**,文件一变就原地重载:你 `writeBytes` 之后,已经开着的内置标签页和 `![[x.pdf]]` 嵌入会跟上,不用你通知。`ctx.app.watchFile?.()` 对 `.pdf` 也会回调(外部工具改了文件、另一个插件写了它),但事件不比内容 —— 你自己写的那次也会来,回调里先比一下字节再决定要不要重载。
- **四条新建主路径都要注册**:文件树右键(`registerFileCreator`)、命令面板(`registerCommand`)、笔记里的 `/`(`registerSlashItem` + `run()`,建完就地嵌入)、**新建标签页启动器**(2026-07-26 起也列 `registerFileCreator`,与内置的「新建白板」并排)。少注册一条,用户就会问「为什么 XX 里没有它」。
- **想做「节点/卡片里是真块」的界面,照 `forsion-plugin-mindmap` 3.0.0 抄**:它是块表面 seam 的样板 —— 一层薄适配(`src/host.tsx`)把 `ctx.app` 伪装成宿主 store/组件的形状,画布本体几乎原样;令牌只在适配层管一次。⚠️那层里按内容去重的缓存**不是优化是正确性**:`getPage()` 每次返回新对象,不去重则 `useSyncExternalStore` 每次判「变了」→ 无限重渲挂死。React 也内联进包(插件拿不到宿主模块图;两份 React 共存没问题,边界就是 `mountBlocks` 那个 DOM 节点)。

## 伸进编辑器 + 自绘设置面板(2026-08-15 起)

「能力对等」的第二批兑现。此前只有宿主内置能碰笔记编辑器的按键与装饰,插件的设置也只能是一排
number/boolean/text 旋钮 —— 这两条卡死了一整类插件(输入法式片段展开、语法高亮、规则表编辑器)。
参考实现:`Forsion-Instrumentality-Project/forsion-plugin-latex-suite`(四条接缝全用上了)。

```js
// ① 往笔记编辑器里注 ProseMirror 插件。外置插件**没有 import**,所以宿主把自己那份 PM 递进来。
ctx.registerEditorExtension?.((pm) => [
  new pm.Plugin({
    key: new pm.PluginKey('my-thing'),
    props: {
      handleTextInput(view, from, to, text) {
        if (view.composing) return false      // ⚠️中文输入法组合中途绝不介入
        return false                           // 不处理就 false,把输入还给宿主
      },
    },
  }),
], { priority: 'high' })   // 'high' = 排在宿主全部插件之前(要抢 Tab 这类已占用的键才用)

// ② 自绘设置面板:宿主给裸容器,里面画什么全归你
ctx.registerSettingsView?.({ id: 'main', title: '高级', mount(el) { /* … */ return () => {} } })

// ③ 每插件一份 JSON blob(<Forsion 家目录>/plugins-data/<id>.json,dev 与安装版各一份,原子写)
const data = (await ctx.loadData?.()) ?? { rules: [] }
await ctx.saveData?.(data)

// ④ 库内文件的外部改动订阅(热重载用户手写的配置文件)
const off = ctx.app.watchFile?.('Snippets/latex.js', () => reload())
```

坑,按会栽的顺序:

- **`priority: 'high'` 是有义务的**:它坐在每一次按键最前面,**不该自己处理的必须 `return false`** ——
  少一个 false,宿主的列表缩进/回车分块在用户那里就静默消失了。只为「要接管宿主已占用的键」用它,
  纯装饰(高亮、隐藏、气泡)一律缺省 `'normal'`。
- **`pm` 里有什么就用什么**:`Plugin PluginKey Selection TextSelection NodeSelection Decoration
  DecorationSet Slice Fragment keymap InputRule inputRules`。`import type` 拿类型可以(会被擦掉),
  **运行时不许 import prosemirror** —— 打进包里就是第二份 PM,`instanceof` 与 PluginKey 全对不上。
- **factory 每个编辑器实例调一次**:一篇 v3 笔记是很多个小编辑器,别把「每编辑器状态」挂在工厂外的共享对象上。
- **零 schema / 零序列化**:只能产生纯文本改动 + 装饰 + 按键拦截。想改落盘格式的不走这条路。
- **`props.*` 宿主包了 try/catch,`state.apply` 没包** —— 后者吞异常等于放任状态损坏。状态迁移自己写稳。
- **设置类页面先用 `ctx.ui.mountSettingsPage`**(2026-10-17 起,见上):开关、按钮、输入、额度条都有宿主零件,手机排法由宿主管;
  只有清单外的内容才自己画(放进 `custom` 块)。
- **设置面板会被反复挂载卸载**(用户来回进出详情页):状态别放模块级单例,dispose 要真收干净
  (定时器、DOM 监听、内嵌的 CodeMirror 实例)。容器上有宿主主题变量但**没有样式重置**,自己带样式、深浅色都要过。
- **大块数据用 `loadData/saveData`,别塞 localStorage**:`registerSetting` 是每键一个字符串,没有原子性。
  用户手改坏了 JSON,宿主返回 `null` 当没写过 —— 插件要能靠默认值起来。
- **想让这份数据跟着账号走,manifest 写 `"syncData": true`**(2026-10-17 起,桌面 / 手机;网页版不同步):
  登录后 `saveData` 先写本机、后台推上云端,换设备时 `loadData` 先拉到较新的那份再返回(最多等 3 秒,
  没登录 / 断网照旧只用本机)。**整份取较新的,不做字段合并** —— 两台设备都改过,**编辑**得较晚的那次赢(离线改、晚上传的照样按编辑时刻比),
  另一份服务端留一版。单份 ≤512 KB、每个账号 ≤100 个插件。用户可以在插件详情页逐台设备关掉。
  内容服务端只存不读,不进任何模型上下文;但**别往里放密钥 / 令牌**(它会出现在用户的每台设备上)。
  `loadData` 只在调用时对一次账,**运行中别的设备改了不会推给你** —— 要实时互通的数据别走这条。
- **`watchFile` 缺位时整条方法不挂**(不是空壳):`if (ctx.app.watchFile) … else 轮询` 才走得对。
  它只报「内容变了」,新建/删除/改名不报;自己 `writeFile` 落的盘不会回声。

## 在 Coding Studio 里边写边看:Sandbox(2026-09-21 起)

桌面插件(Forsion 插件,`manifest.json` + 文件即 `setup(ctx)` 函数体的 `main.js`)可以直接从 Coding Space 的项目文件夹加载进正在运行的 Forsion,不用先拷进 `~/.forsion/plugins/`:

- **项目形态**:`manifest.json` 与 `main` 指向的文件放在**项目根**。Coding Studio 据此把项目判成「插件」(PWA 那种 `manifest.json` 不算——要同时有 `id` / `apiVersion` / `main`)。
- **加载**:用户在 Studio 底部工具条点开 **Sandbox** 面板 →「在 Forsion 中加载」。你(agent)点不了这个按钮——写完后请用户去点,别假装已经加载。
- **热重载**:项目开在 Coding Studio 期间,存盘即重载(宿主会把上次开着的插件视图重新打开)。关掉该项目后不再热重载。
  ⚠️监听器不看 `dist/` / `build/` / `node_modules/` 与点目录:`main` 指向构建产物(如 `dist/main.js`)的插件,改源码不会自动重载到新包 —— 构建完点面板里的「立即重载」(显式重载一律真拆真装)。桌面插件本来就建议 `main.js` 直接放项目根、不走构建。
- **报错在哪看**:Sandbox 面板收口三样——`setup` 抛错、视图 `mount` 抛错、这个插件自己的 `console` 输出(经 `ctx` 闭包归属,不会和别的插件混)。用户可以一键把它们发回对话;**以这些为准**,别凭空猜。
- ⚠️**这不是隔离沙箱**:dev 插件跑在真应用、用户的真笔记库上,与已安装插件同权。试验期间不要写、挪、删用户数据;定时器与监听必须在 disposer 里清(热重载会反复 `setup`,漏清一次就叠一层)。
- ⚠️**同 id 影子**:dev 副本会顶掉同 id 的已安装副本(卡片带 DEV 徽标,期间该插件的「卸载」被禁用)。要对比已安装版,先在 Sandbox 里卸载 dev 副本。
- ⚠️**声明了 `fileExtensions` 的插件不能从 Sandbox 加载**(宿主的毁档防线只覆盖已安装目录)——这类插件必须装上再测,面板会直说。只注册非 md 后缀的插件(如覆盖 `.pdf` 的)不必声明 `fileExtensions`,可以从 Sandbox 加载。
- 引擎插件(`tangu-plugin.json`)**不在 Sandbox 范围**:装进插件目录后重扫生效;同 id 覆盖升级可热换代(单文件 bundle,或纯 ESM 多文件包),带 CommonJS / node_modules / 软链 / 引到包外文件的仍须重启后端。

`check.mjs` 仍然要留(通用纪律 4):Sandbox 证「在真宿主里能起来」,`check.mjs` 证「逻辑回归得了」,两个证的不是一件事。

## Other host APIs and assets

### 共享账号 `ctx.account`（可选）

发布到 Unit 网页且安装账号提供方时、或在移动端应用中，宿主可提供 `ctx.account`：`status()` 返回经过服务端验证的 `loggedIn/userId/username/role/tenantId/workspaceId`，`login()` 打开共享 Forsion 登录页，`logout()` 吊销当前会话后退出，`request(path, init)` 在账号 API 基址下发送请求（例如 `/admin/users`），`subscribe(listener)` 订阅账号变化并返回退订函数。宿主在插件禁用或重载时自动退订。账号变更会取消旧请求，并使尚未消费的响应体失败；调用方仍需释放自己的视图与任务。不要保存凭据或从其他页面的 localStorage 导入令牌。个人 workspace 由服务端身份提供方确定，不接受客户端指定；组织与成员关系不在当前契约内。旧宿主与远程独立管理模式应先判断能力存在性。

移动端请求允许 `/files` 这样的 API 相对路径或同源 `/api/...` 绝对地址，拒绝其他源与重定向；宿主覆盖鉴权头并保留 FormData/Blob 上传。可选 `ctx.account.saveDownload(blob, name)` 返回 `{ ok, error? }`，Android 使用系统下载提供方。插件禁用/重载后账号请求与下载入口失效，不要保留旧 context 发起副作用。`status().cloudUrl` 是不含凭据的账号 API 基址。

Mobile account requests accept API-relative paths such as `/files` or same-origin absolute `/api/...` URLs, reject other origins and redirects, supply host-owned authentication headers, and preserve FormData/Blob uploads. Optional `ctx.account.saveDownload(blob, name)` returns `{ ok, error? }` and uses Android system Downloads. Account request and download methods are revoked when the plugin is disabled or reloaded. `status().cloudUrl` is the credential-free account API base.

### Unit 与浏览器资源路径（2026-09-09）

插件应以能力判断运行环境；Forsion Unit 是框架宿主。
- `ctx.app.assetUrl?.(vaultRelativePath)` 将库内相对路径转换为当前宿主可加载的资源 URL；Web/Unit 带资源授权，不要硬编码 `amadeus-asset://`。需要活动库；没有活动库时不要绘制库资源。
- `ctx.app.hostPath?.(vaultRelativePath)` 只在当前引擎和真实笔记库共享文件系统时返回绝对输出路径；无活动库、云库、浏览器虚拟库、远程引擎或未声明能力时返回 `null`。返回 null 时不要拼接 `vaultRoot()` 强行写本机路径。
- `window.tangu.executionCapabilities?.host` 是 Unit 对主机执行能力的声明；不存在不证明可用。网络视频分析还需网络、媒体工具和模型。
- 本地 Unit 通过安装包 `runtime: { apiVersion: 1, main: "runtime.mjs" }` 加载本地能力，公开多用户投射不加载该入口。业务包无需依赖 Server 才能显示 UI 或使用本地能力。

### API-backed Markdown editor

`ctx.ui?.mountMarkdownEditor(el, { value, label, readOnly, onChange })` mounts native Amadeus without using the active vault. The caller owns save/publish. It offers visual/source/publishing preview modes. `getValue()` reads the latest synchronous editor transaction; `update`, `insertMarkdown`, `focus`, and idempotent `dispose` are available; after `dispose` the element is yours again at once. The host revokes it on plugin unload. Feature-detect; absent hosts should ask for an upgrade.


### Whiteboard layer (2026-10-10)

`ctx.ui?.mountBoard?.(el, { scene, viewport, tool, pen, strokeColor, strokeWidth, theme, onChange, onWheel, onReady })` mounts the host whiteboard engine as a transparent, chrome-less layer over the plugin's own content (PDF pages, images, timelines). Strokes are real whiteboard elements: store `scene.elements` verbatim and hand them back unchanged. The caller owns the viewport — a scene point lands at `(point + scroll) * zoom` CSS pixels from the top-left of `el` — and pushes it with `handle.update({ viewport })`; the layer never pans or zooms by itself and forwards every wheel / pinch event to `onWheel`. The host cancels the app's interface zoom for you: keep giving the viewport in the element's own CSS pixels, and divide `getBoundingClientRect()` distances by `el.currentCSSZoom` when you derive it. `onChange` fires for element changes only. The handle exposes `update`, `getScene`, `undo`, `redo` and an idempotent `dispose`; invalid options throw `TypeError` synchronously. `await ctx.ui.boardToSvg({ elements }, { theme, padding })` renders a static SVG plus its scene-space bounds (`null` for an empty scene) for showing ink while no live layer is mounted. Feature-detect both on older hosts and hide the handwriting entry instead of imitating it.

### Plugin Chat Box selection and Director hand-off (2026-09-30)

When `ctx.tangu.chatSelection === true`, `startChat` accepts optional `modelId` and `thinkingLevel` from the native `ctx.ui.mountChatBox` submission. The host validates the live model catalog and supported thinking levels before changing the UI, then applies the explicit selection after Agent defaults, before prefill/send. Unrecognised selections return `ok:false`; keep the draft for retry. Older hosts omit the capability: retain a plain prompt adapter instead of showing a model picker whose selection cannot be honoured. Bundle ownership, vault-relative `folder`, plugin liveness and send gating remain unchanged.

For API-backed public documents, `ctx.ui.mountMarkdownEditor` accepts `previewBaseUrl` for resolving relative images and videos in a cross-origin host.


### Startup appearance / 开屏与图标

`ctx.registerAppearance?.({ id, label, labelEn, icon?, splash? })` registers a choice in Settings → Appearance → Startup and icons. `id` is a stable ASCII slug; the host namespaces it by plugin ID. Provide both localized labels. `icon` and `splash` are embedded base64 data images (`image/png`, `jpeg`, `webp`, `gif`, `svg+xml`), each at most 2,000,000 characters and 4096 × 4096 pixels. URLs, HTML, executable scripts and arbitrary CSS are not accepted by this contract. Render SVG as an image, never inject it into the host DOM.

Registration never selects or replaces the user's appearance. On selection, the host validates the image and snapshots it for offline startup before plugin code loads. Icons become static 256 × 256 PNGs and show inside the application at once. With the user's "Use in Dock / taskbar" switch on, an installed desktop build also saves the icon to the system, so it stays after Forsion quits: the Finder / Dock / Launchpad icon on macOS, and the Start menu, desktop and taskbar shortcuts on Windows (written again after an update). On Linux and in development builds it lasts only while the app runs. The installer's own icon is unchanged. On Android the home screen icon can only switch between icons shipped inside the app, so a plugin's icon (like an uploaded picture) stays inside the app and never becomes the home screen icon. Animated GIF/WebP/SVG may be used as splash artwork. Reduced motion uses the static icon. The host owns the readiness exit and 10-second safety ceiling, so a plugin cannot extend loading time.

The returned disposer removes only its own current registration. Disable, unload and failed setup revoke registrations; disabling or removing the plugin clears selected cached assets. A normal reload retains the selected snapshot: select the preset again to refresh artwork after editing it. Stale contexts cannot register again. Always feature-detect with optional chaining. A complete installable example is in `samples/forsion-sample-appearance/`.

中文：插件只贡献选项，不自动改用户选择。选择后缓存图像供离线启动使用，图标立即同步到应用内部；「同步到 Dock／任务栏」开着时，桌面安装版还会把它写进系统，退出 Forsion 后仍保留（macOS 的访达／Dock／启动台图标，Windows 的开始菜单、桌面和任务栏快捷方式，更新后重新写入；Linux 与开发版仅运行时）。安卓桌面图标只能在应用内置的图标之间切换，插件图标只在 App 内显示。普通重载保留快照，重新选择可更新素材。禁用或移除插件时恢复默认，旧上下文不能重新注册。安装包自身的图标不随此设置修改。


## Local plugin task APIs (Dispatch host branch, 2026-10-04)

Feature-detect these additive interfaces; released 2.12.2 builds do not contain them.

- Renderer `ctx.tangu.request?(enginePluginId, path, {method?,body?,signal?})`: authenticated JSON through the host, restricted to an engine plugin in the caller's bundle. Absolute route fragments only, no query/encoded/dot segments. Local desktop only. Disable aborts pending requests. The host builds the route from the bundle's install folder name, so the plugin never spells the prefix. Desktop 2.13.3 and earlier built it from the manifest `id` instead: there a bundle whose install folder name differs from its manifest `id` gets 404 on every call (see the bundle section for what to do when listing in the Store). New Store listings install into `market-<listing ID>` folders and need a desktop after 2.13.4, so this only concerns older listings.
- Renderer `await ctx.tangu.openSession?(id)`: hydrates hidden session metadata/model/config into the native child-session cache, then opens a native chat tab. No new run is started.
- Engine `ctx.registerScopedRoutes(router => { router.get('/snapshot', handler); })`: host mounts `/extensions/<bundle directory>/<engine id>` (the install folder name as found on disk, never an id the package declares), applies user authentication and rejects remote callers. `req.user.userId` is authoritative. Host removes the route on disable.
- Engine `ctx.paths.dataDir`: stable host-owned plugin data directory. Do not derive writable runtime data from installation paths.
- `ctx.sdk.runs.start({userId,cwd,prompt,modelId,thinkingLevel,agentSlug|engineId,engineModelId?,planMode?,sessionId?,requestId?,parentSessionId?,title?})` creates a local plugin-owned `kind=task` session/run. Persist an intent and reuse requestId on an uncertain outcome. Native approval/inquiry behavior remains active; callers cannot supply an approval mode. External engines require local host execution and do not support plan mode.
- `runs.status(runId,userId)` gives real status, bounded final summary, tokens and waiting kinds; `sessionRuns(sessionId,userId)` also tracks native continuations. `events`, `subscribe` and `stop` validate ownership. Subscribe returns an unsubscribe function and the host disposes it on disable.
- `ctx.sdk.engines.list()` reports available local external engines and sandbox restrictions. A registry entry does not prove the CLI is authenticated.
- Agent config `tools_strict=true` makes `tools_list` an exact allowlist over all tool sources, including gated/plugin/MCP tools. It is opt-in and config-only; old agents retain existing blacklist/allowlist behavior. Include `ask_user` explicitly when needed.

Task sessions, including native continuations, share a host FIFO by canonical project path. This is a single local engine guarantee, not a distributed lock between independent engine processes. Plugins still own task metadata, scheduling and lifecycle. Disabling a plugin removes its contributions but does not abort previously accepted native runs.

### Recording model choices / 记录中的模型选择（2026-10-14）

`ctx.ui?.mountModelPicker?.(el, { kind, value, label, followLabel, scopeKey, onChange })` mounts the existing native ModelPill menu without a prompt input. `kind` is `asr` or `translation`; `value: ''` follows that global slot, while ASR `value: 'local'` selects on-device SenseVoice. It reads the home engine catalog, includes dedicated translation models, and follows native model sorting and grouping preferences. Selection is a local draft delivered through `onChange`; the host never changes global settings or starts a model call. Use `{ update(patch), dispose() }`, change `scopeKey` when switching recordings, and feature-detect together with `ctx.tangu.modelCatalog`. Unready on-device models are explained and cannot become selected; download them through Settings → Voice. The host disposes the picker and aborts an open menu when the plugin is disabled or reloaded.

`ctx.tangu?.modelCatalog?.(kind)` returns `{ models, defaultModelId }` from the same home target used by desktop ASR and inline AI. Each model has `id`, `name`, `provider`, `source`, `available`, and `supportsCorrection`; dedicated machine-translation models set `supportsCorrection: false`. No credentials are returned. `ctx.tangu.complete` and `ctx.tangu.translate` accept optional `modelId` overrides and return optional `model: { id, name, mt? }` provenance. An explicit override never writes the global model slot. When it is omitted, the existing global-slot behavior remains available. Desktop `window.tangu.transcribeAudio` accepts per-call `backend: 'local' | 'cloud'` as well as `modelId`; explicit offline ASR never falls through to a cloud Provider when the local model is unavailable. Pass `language` (`zh`, `en`, `ja`, `ko`, `yue`, …) when you know what is spoken: the on-device model otherwise guesses the language per utterance and can turn far-field English into Chinese or Japanese text; cloud models receive it as a hint. Omit it for mixed-language audio.

这组接口复用原生模型选择器，选择保持为插件的局部草稿；模型调用和记录级持久化仍由插件负责。空值跟随全局设置，ASR 的 `local` 代表本机 SenseVoice。目录来自实际执行调用的 home 引擎；专用翻译模型通过 `supportsCorrection` 标明只支持翻译。切换记录更新 `scopeKey`，通过 `dispose()` 收回宿主挂载；插件禁用或重载也会自动清理。旧宿主没有这些可选方法时，保留跟随全局设置的界面，不显示无法兑现的记录级覆盖。
