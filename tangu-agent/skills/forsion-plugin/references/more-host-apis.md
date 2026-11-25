# More host APIs: list sources, Tangu, calendar, Spaces, home, databases, Floating Panel, Coding Studio sandbox, account, assets, whiteboard, Chat Box, startup appearance, LCL layout

Moved out of SKILL.md (2026-11-23) verbatim. Most sections here point on to a dedicated reference file; read that one for the contract.

**Where "见下 / 见上 / below" pointers in this file land** (the sections moved apart on 2026-11-23): Selection bar, View modes, Tooltips, Drop indicators, Host parts, Settings parts, dashboard, `ctx.table.mount` → `host-ui-mounts.md`; 没有活动库, 外观开关, dispose 契约, 自绘浮层, pointer math → `view-runtime-rules.md`; 只读全库查询, onVaultEvent, 二进制资源, working folder, Templates and new notes → `vault-and-assets.md`; 前置条件 / onboarding.requires, requiresPlugins, 双语与图标, 上手提示 / guide, 主页小组件 / widgets → `manifest-declarations.md`; 统一左栏列表源, Floating Panel, Startup appearance, 共享账号, Whiteboard, Chat Box, LCL layout → `more-host-apis.md`; 当前模型, Agent 状态 / 名册, 开新对话, Agent Desk, 摘要栏, 自动化 → `tangu-host-apis.md`; 日历叠加源 → `calendar-overlays.md`; 日历 / 待办其余入口 → `calendar-todo-entries.md`; Space 与 Ribbon, 主页宿主件 → `spaces-and-home.md`; 全库多维表与笔记任务 → `databases-note-tasks.md`; 编辑器 / loadData / 块表面 → `note-editor-surfaces.md`; Tool result cards, Process-row sentences → `tool-cards.md`; where a surface's data comes from → `host-data-sources.md`. All in `references/`.

### Host UI mounts: read references/host-ui-mounts.md

The full contracts, examples and old-host fallbacks for these mounts live in [references/host-ui-mounts.md](references/host-ui-mounts.md). When the table above says 见下「…」 for one of them, read that section there before writing code:

- 可复用 UI 组件：ctx.ui.mountChatBox（2026-09-24 起）
- 原生 Markdown 编辑器 ctx.ui.mountMarkdownEditor(2026-09-30 起)
- 原生悬浮目录 ctx.ui.mountFloatingToc(2026-09-07 起)
- View modes: ctx.ui.setViewModes (2026-10-19+)
- Tooltips and motion tokens: ctx.ui.attachTooltip (2026-10-23+)
- Drop indicators: ctx.ui.dropIndicator (2026-10-24+)
- Selection bar: ctx.ui.mountSelectionBar and registerSelectionAction scopes (2026-10-13+); placement / auto / card / ctx.tts (2026-11-21+)
- Tool island: ctx.ui.mountToolIsland (2026-11-04+)
- Floats: ctx.ui.float (2026-11-07+)
- Host parts: dialogs, toolbar controls, menus, popovers, empty states, icons, view head, i18n (2026-10-26+)
- Settings parts: ctx.ui.mountSettingsPage / mountSettingsItem (2026-10-17+)
- Plugin settings page: ctx.registerSettingsPage (2026-11-18+)
- 白板层 ctx.ui.mountBoard / ctx.ui.boardToSvg(2026-10-10 起)
- 仪表盘 ctx.dashboard(2026-09-01 起)
- 原生多维表 ctx.table.mount(2026-09-05 起)

### 统一左栏列表源(2026-08-25 起)

`ctx.registerListSource?.({ id, title, items, subscribe, open, search?, groups?, actions?, itemMenu?, drop?, rename? })` ——
插件只出数据,搜索词与选中分组**由宿主持有**并经 `items({query, group})` 回传(插件对 UI 无状态);
`items()` 每次渲染都被调,自己缓存别读盘。露出左栏两条路:space.json 写
`{"type":"workspace","params":{"mode":"plugin:<插件id>:<源id>"}}`,或给 `registerView` 加 `workspaceSource`。

- ⚠️**`subscribe()` 必须顺手重读一次**:插件在宿主**启动期**装载,而笔记库恢复是**懒的** ——
  setup 里那次 `ctx.app.readFile` 多半撞在「还没有活动库」上,宿主此时**静默返回 `null` 不抛异常**
  (try/catch 照不到),列表就此定格为空。宿主挂载列表面 / 切库都会重订阅,这是重读的门。
  (青鸟 2026-08-28 实报「明明有记录却是空」,根因即此。)
- Row icons (`iconUrl` + `icon`), `actions` / `itemMenu()` items (`{ id, label, primary?, danger?, icon?, run }`), `unread`, `subtitle`, `empty`, the phone layout, row icon buttons, folders / group headers / drag / rename (`ctx.listCapabilities`): read [references/list-sources.md](references/list-sources.md) before using any of them.

### Intelligent UI list cards (2026-10-09+)

Opt a list source into chat cards with `intelligent: { description, viewId }` (English, ≤400 characters); the host draws the card. Details: [references/list-sources.md](references/list-sources.md).

### Tool result cards: ctx.registerToolResultRenderer (2026-10-19+)

Your bundle's engine half registered a tool → its desktop half may draw that tool's result card (`ctx.registerToolResultRenderer?.({ tool, title?, surface?, match?, mount(el, call) })`, inline or in the Agent Desk). Only tools your own engine plugins register right now; only finished, successful calls. Read [references/tool-cards.md](references/tool-cards.md) before writing one.

### Process-row sentences: ctx.registerToolLabel (2026-11-13+)

`ctx.registerToolLabel?.({ tool, describe(call), revision? })` turns each call of your own engine tools into one plain sentence in the chat's process row (`describe` synchronous, pure, cached). Read [references/tool-cards.md](references/tool-cards.md).

## Tangu host APIs: read references/tangu-host-apis.md

`ctx.tangu` (current model, agent status, agent roster, startChat, mountChat, mountComposer, complete, translate, fim), `ctx.desk`, `ctx.summary` and `ctx.automation` are documented in [references/tangu-host-apis.md](references/tangu-host-apis.md). None of them exist on non-Tangu hosts, so always use optional chaining. When the table above says 见下「…」 for one of them, read that section there:

- 当前模型与当前 Space:ctx.tangu(2026-08-29 起)
- Agent 状态:agentStatus / subscribeAgentStatus(2026-09-19 起;2026-11-13 起可传 `{ runId }`,另有 `stop`)
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
- 插件自己的触发事件:ctx.automation.registerTrigger / emit(2026-10-30 起)


## 日历成员登记:ctx.calendar(2026-09-02 起)

Calendar Space 是**显式成员制**:有 `calendarDate` 列的表不会自动出现在日历里,得登记。插件种下任务表后:

```js
ctx.calendar?.ensureMember(`${ctx.app.workFolder()}/任务表.db`, 'c-date' /* 日期列 id */, 'c-done' /* 可选:完成勾选列 id */)
```

- 同步返回 void。已是成员 → **no-op**(不覆盖用户改过的列映射);库还没恢复 → 等库恢复后再登记(最多 60s)。
- 列给的是**列 id**(不是列名);日期列用 `calendarDate` 类型。
- 与 `ctx.automation` 不同,这条不需要 Tangu 宿主 —— 纯 Amadeus 壳也有;旧宿主没有,可选链。
- 只想「没有就加」用它;要**改**列映射、撤成员、改颜色,用下一节 `"calendar"` 能力档的写口。

### 日历叠加源与设置:read references/calendar-overlays.md

声明 `"calendar"`(连同 `databases`)才有:`ctx.calendar.subscribe` 快照(成员 / 只读叠加源 Agent·.ics·另一侧库 / 颜色 / 隐藏 / 默认表 / `myCalendar`)、设置写口、`.ics` 订阅管理。用之前先读 [references/calendar-overlays.md](references/calendar-overlays.md)。

### 日历 / 待办类插件的其余入口(2026-10-17 盘点)

Jump to a heading (`ctx.app.openNote?.(path, { heading })`), open a table (`ctx.app.openFile(db.path)`), mini window, Intelligent UI, dashboards, reminders, notifications with an Undo button (`ctx.notify(msg, { action, key })`) and how they show on phones (a banner under the status bar; `undo` / `urgent`), the host record fields in your card (`ctx.ui?.mountRecord?.(el, { path, rowId, dateCol?, readOnly?, body?, hideColumns? })`, declared `"databases"` only), host parts instead of copied UI, `ctx.calendar?.events` (copy / paste / reschedule / undo) and filtered view params: read [references/calendar-todo-entries.md](references/calendar-todo-entries.md).

## Space 与 Ribbon 收纳架:ctx.spaces(2026-10-18 起)

Declared `"spaces"` only: list / open the user's Spaces, `mountIcon` / `mountStatus`, `actions()`, `contextMenu?`, `opensElsewhere?`, and `shelf.*`, which writes the Ribbon's own order and folders (never keep a second copy). Read [references/spaces-and-home.md](references/spaces-and-home.md).

## 主页宿主件:ctx.home(2026-11-09 起,只给接管主页的核心插件)

Not for ordinary plugins (only the core plugin that claims the host home page gets it). Contract: [references/spaces-and-home.md](references/spaces-and-home.md).

## 全库多维表与笔记任务:ctx.databases / ctx.noteTasks(2026-10-16 起)

Declared `"databases"` / `"noteTasks"` only: live snapshots of every table / every `@` task in the vault, per-cell and per-row writes (`setCell` with `expected`, `addRow`, `duplicateRow`, `deleteRow`), record bodies (`readBody` / `setBody`), `addColumn`, whole-table `mutate(path, fn)` (pure `fn`, replayed on conflict), `@todo` tasks, `parentId` / `tags`. `ready: false` with an empty list ≠ no data. Read [references/databases-note-tasks.md](references/databases-note-tasks.md) before using either.

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
- `view.surface` 还有 `'pip'`(2026-11-13 起):宿主自己开的置顶悬浮小画面(只在桌面、用户点了才开,目前只挂 Computer Use 实时画面),画紧凑卡;不认识的 `surface` 值按 `'floating'` 处理。
- 宿主自动命名空间，插件只写自己的相对 id；禁用插件或反注册 view 后，已开的原生窗口/Web 面板自动关闭。`mount` disposer 必须收订阅和计时器。
- 详细契约见 `Forsion-Genesis/docs/customization/floating-panel-development.md`；桌面回归 `npm run build && npm run check:floatingpanel`。

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
Pass `vault: true` (2.13.8+) for `[[` completion and links that open the note beside the view; `ctx.ui?.mountMarkdown(el, { markdown })` renders read-only Markdown with math and links (same version, so its presence means `vault` is honoured).


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


## Local plugin task APIs and recorded model choices: read references/local-plugin-tasks.md

插件自己开后台任务(`ctx.tasks` 一族,Dispatch 宿主分支)和录音 / 转写类插件记录所用模型时,先读 [references/local-plugin-tasks.md](references/local-plugin-tasks.md)。

### LCL View layout coordination

All docked Views inherit side-by-side constrained geometry and interruptible drawer motion. Declare `layout: { minWidth, minHeight }` on a View only when it needs larger minima. Defaults are main 320×180, left 220×180, right 240×180 and bottom 240×140 logical CSS pixels; undersized workspaces scroll, without collapsing splits into tabs. Sidebar collapse keeps mounts alive. `mount(el, view)` exposes optional `getLayout()` and `onLayout(callback)` returning an unsubscribe function. Snapshots contain `width`, `height`, `visible`, `compact` (<480px), and `phase` (`transition`/`settled`). Defer expensive content refits until visible/settled; never reset document zoom/drafts on layout. The host revokes subscriptions on disposal; feature-detect these methods on older hosts. Space-native `newPage(target)` callbacks use `target.open(type, params)` to retain the originating split across awaits.

Official account inbox: only the locked `forsion-extend` package may call `ctx.app.provideInboxChannel?.(channel)`.
Use `cloud:` IDs and server-owned read/archive/delete/reward state; return a revision for changes that do not affect unread count.
The host merges native engine letters and filters duplicate official broadcasts. Pass null on disposal; re-provide after account changes.
See the plugin development manual for the full channel and legacy-state import contract.

### 2026-11-12 host UI additions

Selection tools may expose `menu: { title, open(sel, anchor) }`; the host draws a separate arrow and passes the real anchor. Keep `run` as the primary action; dispose child menus and capture selection data before opening. Board mounts/updates accept `roundness: sharp | round` for new shapes only; never rewrite existing scene corners on load. Details and compatibility: references/host-ui-mounts.md.
