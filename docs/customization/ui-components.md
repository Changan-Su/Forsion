---
title: 可复用界面组件 / Reusable UI components
description: 在 View 与插件中复用 Chat Box，明确草稿、模型选择与提交的归属。
---

# 可复用界面组件 / Reusable UI components

Space 组织布局，View 是可独立打开的功能面，UI component 是 View 内可组合的部件。此处不使用 Amadeus 的文档 Block 或仪表盘 Card 作为组件名称。工程分层及维护规则见 [LCL](../../lcl/README.md)。

Chat Box 的卡面、输入、操作栏和提交按钮由 `@lcl/components` 维护。聊天与首页通过 `Composer2` 接会话行为；Coding 的新建项目通过 `components/chatbox` 接模型目录，并在创建完成后传递选定模型与思考档。项目详情与 Forsion 能力选择是宿主插槽。顺便问面板也用 `components/chatbox`，可选插槽 `leadingControls` 把附件「+」放在模型药丸前面；这个插槽只给内置宿主，插件的 `ctx.ui.mountChatBox` 仍不带附件。

## 插件使用

`ctx.ui?.mountChatBox` 可挂到插件自己的 View 中，不需要 React。当前支持文本输入、模型选择、思考档、键盘提交；附件、命令、审批和运行控制属于会话编排器，未接线的行为不显示。

要整块「新对话」输入区（主页那一套：附件、模式、项目栏、运行位置、语音、通话）时用 `ctx.tangu?.mountComposer`：宿主组件是 `desktop/frontend/src/views/newChatComposer.tsx` 的 `NewChatComposer`，内置主页和插件挂的是同一份，发送一律由宿主建会话、切到 Tangu。Use `ctx.tangu?.mountComposer` for the full new-chat composer from Home; the host owns sending.

```js
ctx.registerView({
  id: 'prompt', title: 'Prompt',
  mount(el) {
    const zh = ctx.getLocale?.() === 'zh'
    const box = ctx.ui?.mountChatBox?.(el, {
      label: zh ? '描述需求' : 'Describe your request',
      placeholder: zh ? '输入要处理的内容…' : 'Describe what to work on…',
      submitLabel: zh ? '保存草稿' : 'Save draft',
      async onSubmit({ text, modelId, thinkingLevel }) {
        // The plugin owns what happens next. This example only saves a draft.
        await ctx.saveData?.({ text, modelId, thinkingLevel })
        return true
      },
    })
    if (!box) el.textContent = zh ? '请更新 Forsion 以使用共享输入框。' : 'Update Forsion to use the shared input.'
    return () => box?.dispose()
  },
})
```

类型真源：`desktop/shared/chatBox.ts`。

| API | 约定 |
| --- | --- |
| `value`, `modelId`, `thinkingLevel` | 初始草稿；通过 handle.update 可局部修改。未指定模型时使用宿主默认；`agentSlug` 可提供该 Agent 的初始默认。 |
| `label`, `placeholder`, `submitLabel`, `disabled` | 展示与可操作状态，插件负责双语；update 不重挂、不丢输入。 |
| `submitOn` | 默认 `modifier-enter`（⌘/Ctrl+Enter）；可设 `enter`。Shift+Enter 换行，输入法确认不会提交。 |
| `onChange(draft)` | 文本或模型选择变化时返回 `{ text, modelId, thinkingLevel }`。只通知本组件的宿主。 |
| `onSubmit(draft)` | 返回 true 清空已提交文本；false 或异常保留草稿。等待期间防重复提交；异常显示可重试提示。 |
| `update(patch)`, `focus()`, `dispose()` | 更新、聚焦、幂等卸载。卸载后的异步回调不再修改 UI；宿主在插件禁用、重载、setup 失败时统一回收。 |

模型目录与聊天共用，主模型只展示 LLM，遵守用户的排序和隐藏设置，不额外按品牌限制。选择停留在此组件，不修改全局默认或当前会话。提交回调拿到的是当次选择；插件必须将它们传给自己的业务流程，不能展示了选择却丢弃它。挂载和编辑不发起模型请求、不自动创建会话。旧宿主必须 feature-detect，不复制内部 CSS 伪装支持。

## Android 宿主展示

Android 的共享 `ModelPill` 可通过 `modelPickerHost` 接口使用 Kotlin / Jetpack Compose 半屏选择器。
插件继续调用 `ctx.ui.mountChatBox`，不用创建原生 View，也不用访问 Capacitor。
宿主将模型目录、已选值、双语标签和主题传给原生层，用户点击完成后才原子更新该输入框的模型和思考档。
取消与卸载不写回；宿主不可用时保留 Web 菜单。插件独立绘制的选择器不会自动获得该能力。

通用底单与顶栏同理：`@lcl/engine` 的 `presentNativeMenu` / `presentNativePrompt` / `presentNativeConfirm`
在 Android 上用 Compose 半屏底单展示菜单、输入与确认，其余平台返回 `{ handled: false }`，由调用方继续渲染 Web UI。
共享原语已接入：`ContextMenu`、`askString`、无 children 的 `ConfirmDialog` 在 Android 上自动走原生底单，插件经这些原语即可获得。
顶栏由外壳通过 `setNativeChromeShell` 推送；全屏层用 `useNativeChromeClaim({ mode: 'hidden' })` 临时收起，
自带返回语义的页面（如设置）用 `{ mode: 'page', title, back, onBack, close?, onClose? }`。
Space 切换在 Android 上是原生底部导航栏（宿主声明 `spaces: true`）：插件注册的 Space 自动出现在里面，图标取 `SpaceDefinition.icon`，不需要额外接线。
有左栏的 Space 在 Android 上是两级导航：进来先看左栏（全屏列表），点条目进主区，返回回到列表。左栏不是这种列表的 Space 在定义里写 `listFirst: false`，主区就是第一层、左栏仍是抽屉。
视图可以往这条原生顶栏上加两样东西：`useNativeChromeExtras({ where: 'list' | 'main', search?: { label, run }, title?: { sub, run? } })` —— 右胶囊里的搜索钮、标题的第二段（给了 `run` 就可点）；不声明就没有，只有当前这一层的声明生效。
视图要知道自己是不是正作为「列表层」整屏显示（好换成手机的摆法：一颗主按钮、左滑操作），用 `useListFirst()`；没有原生宿主时恒为 `false`。内置的那套手机列表件（分类胶囊、左滑一行、主按钮、下拉搜索）在应用层的 `components/phoneList`，目前不对插件开放。
自绘菜单想同时支持原生底单时，把条目写成一份 `SheetMenu`（文案 + `run` 回调），Web 渲染与原生底单共用：
点击触发用 `openNativeSheetMenu(build, { onFallback })`，状态驱动（右键 / 长按）用 `useNativeSheetMenu(open, build, onClose)`。
手机「⋯」菜单除 ribbon 底部项外，还列出声明了 `Command.moreGroup = { id, title }` 的命令（同组一节、节标题 = `title`）；
外置插件经 `ctx.registerCommand` 注册的命令由宿主自动按插件分节放进去（节标题 = 插件名），插件无需改代码。应用市场全屏页与设置同款走 `page` 模式。

此接口只改变交互的展示层，不改变插件安装、DOM View 或编辑器扩展机制。
移动端外部插件加载的支持情况需独立确认，详见 [Android 试点与验收](../../mobile/README.md)。

## English API notes

Built-in prompt hosts (Coding's new-project box, the aside panel) use the `components/chatbox` wrapper. Its optional `leadingControls` slot renders before the model pill, which is where the aside panel puts its attach "+". The slot is host-only: `ctx.ui.mountChatBox` still has no attachments.

Use `ctx.ui?.mountChatBox?.(element, options)` inside a plugin View. The host supplies the same input surface and model picker used by built-in Views; the plugin supplies localized labels and owns submission. `onSubmit` receives `{ text, modelId, thinkingLevel }`: return true to clear the submitted text, or false to keep it. Rejected submissions keep the draft and show a retryable error. Model and effort choices remain local, without changing the active conversation or global defaults.

`handle.update(patch)` preserves mounted state; `focus()` focuses the input; `dispose()` is idempotent. The host also cleans up on plugin disable, reload, or setup failure. Submission is locked while pending, and disposed instances ignore late results. Default keyboard submission is ⌘/Ctrl+Enter; Shift+Enter adds a line and IME confirmation never submits. Text, model selection, and effort are supported; conversation-only attachments, slash commands, approvals, and run controls require their session host. Feature-detect on older hosts. The canonical options and handle types live in `desktop/shared/chatBox.ts`.

On Android, `presentNativeMenu` / `presentNativePrompt` / `presentNativeConfirm` from `@lcl/engine` show a Compose bottom sheet; elsewhere they resolve `{ handled: false }` and the caller renders its web UI. `ContextMenu`, `askString` and `ConfirmDialog` (without children) already use them, so plugins built on these primitives get native sheets for free. The shell pushes the native top bar with `setNativeChromeShell`; full-screen layers hide it with `useNativeChromeClaim({ mode: 'hidden' })`, and pages with their own back semantics (Settings) claim `{ mode: 'page', title, back, onBack, close?, onClose? }`. A custom menu that should also open natively keeps one `SheetMenu` (labels + `run` callbacks) for both renders: `openNativeSheetMenu(build, { onFallback })` for click-triggered menus, `useNativeSheetMenu(open, build, onClose)` for state-driven ones (right-click / long-press). Besides the ribbon's bottom items, the mobile "⋯" sheet lists every command that declares `Command.moreGroup = { id, title }` (one section per group id, titled `title`); commands an external plugin registers through `ctx.registerCommand` are grouped there per plugin automatically (section title = plugin name), with no plugin code changes. The app market's full-screen page claims `page` mode like Settings.

## API 文档的 Amadeus 编辑器 / Amadeus for API-backed documents

`ctx.ui?.mountMarkdownEditor(el, { value, label, readOnly, modes, onChange })` 挂载原生 Amadeus / Milkdown 编辑器，支持可视编辑、Markdown 源码和发布预览。正文完全由调用方保存，不读写活动智库、不修改当前笔记、不自动请求模型。句法沿用 CommonMark、GFM、CJK 强调、`![[视频链接]]` 与 Obsidian callout；折叠 callout 使用 `> [!note]- 标题`。

`modes: false`（2026-10-12 起）不画顶上那排「Amadeus 编辑 / Markdown 源码 / 预览」切换按钮，只留可视编辑器，用在把编辑器放进自己的卡片、单元格或表单项里的场合；缺省三档都在。`update({ modes })` 可以随时开关，关掉的那一刻停在源码或预览档会回到可视编辑器。2.13.2 及更早的宿主不认这个字段、照样画那一排：要兼容它们，就在自己的样式里藏掉那一排当兜底（`.your-box .amx-publishing-editor > div:has(> button[aria-pressed]) { display: none !important }`），别的宿主节点不要选。

`handle.getValue()` 同步取最新事务，保存前必须调用；`update({value})` 切换文档，`insertMarkdown(text)` 追加上传附件或嵌入，`focus()` 聚焦，`dispose()` 幂等清理。插件禁用/重载与主视图卸载也会收回挂载，旧句柄不能再改内容。旧宿主缺少此 API 时应明确要求升级，不能伪装成原生编辑器。

The caller owns the document and persistence. No implicit vault, active page, AI calls or autosave. The editor and publishing renderer share Amadeus Markdown semantics. Read `getValue()` immediately before saving; dispose mounts on view teardown. Feature-detect on older hosts.

`modes: false` (since 2026-10-12) draws no row of "Amadeus editor / Markdown source / Preview" buttons and keeps the visual editor only. Use it when the editor sits inside your own card, cell or form field; by default all three modes are available. `update({ modes })` turns the row off or on at any time; turning it off while the source or preview is showing returns to the visual editor. Hosts up to 2.13.2 ignore the field and always draw the row: to support them, hide that row in your own stylesheet as a fallback (`.your-box .amx-publishing-editor > div:has(> button[aria-pressed]) { display: none !important }`) and select no other host node.


### Plugin Chat Box selection and Director hand-off (2026-09-30)

When `ctx.tangu.chatSelection === true`, `startChat` accepts optional `modelId` and `thinkingLevel` from the native `ctx.ui.mountChatBox` submission. The host validates the live model catalog and supported thinking levels before changing the UI, then applies the explicit selection after Agent defaults, before prefill/send. Unrecognised selections return `ok:false`; keep the draft for retry. Older hosts omit the capability: retain a plain prompt adapter instead of showing a model picker whose selection cannot be honoured. Bundle ownership, vault-relative `folder`, plugin liveness and send gating remain unchanged.

The editor accepts `previewBaseUrl` to resolve relative public media when mounted in a desktop or cross-origin admin host.


### 插件视图里的原生对话 / Native chat inside a plugin view (2026-10-04)

`ctx.tangu?.mountChat?.(el, { agent, folder, title })` 把宿主的原生对话（输入框、模型与思考档、消息流、工具展示、审批）挂进插件自己的视图，固定在一条会话上。一个（插件，`folder`）对应一条会话：宿主记在本机，下次挂载接回同一条，用户删除或归档后新开。`folder` 是库相对路径，宿主在后端就绪后解析并钳在库内，作为会话的工作目录，Agent 生成的文件直接落进这个文件夹；给了 `folder` 却落不到本机路径时 `ready` 返回失败，不会悄悄退成沙箱对话（不给 `folder` 才是沙箱对话）。宿主永不替用户送出：句柄只提供 `ready`、`quote(text)`（挂成输入框上方的引用条）、`prefill(text)`（放进输入框草稿，回车由用户按）和 `dispose()`。插件禁用、重载时宿主统一卸载。旧宿主没有这个方法，退回 `startChat`。

`ctx.tangu?.mountChat?.(el, { agent, folder, title })` mounts the host's native chat (composer, model and effort pickers, message stream, tool rows, approvals) inside a plugin view, pinned to one session. One session per (plugin, `folder`): the host remembers it on this device, reattaches on the next mount, and starts a new one after the user deletes or archives it. `folder` is vault-relative; once the backend is ready the host resolves and clamps it inside the vault as the session's working folder, so files the Agent generates land there. A `folder` that cannot be resolved to a local path makes `ready` fail instead of silently falling back to a sandboxed chat (omit `folder` for a sandboxed chat). The host never sends on the user's behalf: the handle offers `ready`, `quote(text)` (shown as the quote strip above the composer), `prefill(text)` (appended to the composer draft; the user presses Enter) and `dispose()`. Mounts are torn down when the plugin is disabled or reloaded. Feature-detect on older hosts and fall back to `startChat`.

### 卸载之后容器归还插件 / The element is yours again after dispose (2026-10-04)

`ctx.ui.mount*`、`ctx.tangu.mountChat`、`ctx.table.mount`、`ctx.dashboard.mount`、`ctx.app.mountBlocks` 与文件视图的 `mountNoteView` 都把宿主的界面挂进宿主自己加到 `el` 里的一层（`display:contents`，不出盒子，`el` 的高度与 flex 照旧作用在内容上）。`dispose()` 同步摘掉这一层，之后 `el` 立刻还给插件：清空它、放自己的内容、在同一个 `el` 上再挂都不用等。再挂的是一份新实例；只换数据或参数时用句柄的 `update()`。一个 `el` 同一时刻只有一份宿主界面：上一份没 dispose 就在同一个 `el` 上再挂，宿主先把上一份完整收掉（等同于 dispose，它的句柄此后不再生效），谁后调用谁留下。`mountFloatingToc` 例外：它叠在 `shell` 上，不占用 `shell`，不收掉也不被收掉。不要用 `el > .x` 或 `el.firstElementChild` 去取宿主渲染的节点。2.12.2 及更早的宿主没有这条保证，要兼容就把宿主内容挂进插件自己建的子节点，换内容时连子节点一起换掉。

`ctx.ui.mount*`, `ctx.tangu.mountChat`, `ctx.table.mount`, `ctx.dashboard.mount`, `ctx.app.mountBlocks` and a file view's `mountNoteView` all render inside a layer the host adds to `el` (`display:contents`: it generates no box, so the element's height and flex still apply to the content). `dispose()` removes that layer synchronously and the element is the plugin's again at once: clear it, put your own content in, or mount on it again without waiting. Mounting again creates a fresh instance; use the handle's `update()` to change data or options in place. One element holds one host mount at a time: mounting on an element whose previous mount was not disposed retires that mount first, fully, as if it had been disposed; its handle goes inert, and the later call wins regardless of load order. `mountFloatingToc` is the exception: it overlays `shell` without taking it over, so it neither retires nor is retired by other mounts. Do not reach host nodes through `el > .x` or `el.firstElementChild`. Hosts up to 2.12.2 do not give this guarantee: to support them, mount into a child element you create and replace that child when the content changes.

### 跟随宿主的外观开关 / Following the host's appearance switches (2026-10-05)

设置 → 外观有三个可以逐项开关的开关（「宽松正文」「舒缓过渡」默认开，「外围淡出」默认关；哪个开着由用户定）：「外围淡出」（Ribbon 图标、未选中的标签、左侧栏文字平时退后，指针或键盘焦点进来恢复）、「宽松正文」（笔记与对话正文的行距、段距放宽）、「舒缓过渡」（切换视图的淡入、外围恢复慢一点）。插件不需要调用任何接口，按下面几条写样式就会跟着走：

- 文字与线性图标只用 `var(--text)`、`--text-light`、`--text-muted`、`--text-faint`，不写死颜色，也不自己叠 `opacity` 表示次要。左侧栏的淡出是宿主调淡这几个变量实现的；状态（未读、出错、进行中）用 `--accent-ink`、`--danger` 这类语义色，它们不淡。
- 左侧栏列表的选中行用 `aria-selected="true"` 或 `aria-current` 标出来（类名 `.active` / `.on` / `.is-on` 也认），宿主让它保持全亮。别把 `.on` 挂在包着整块面板的容器上，否则里面的内容都不会退后。`registerListSource` 的行由宿主画，不用处理。
- 整段阅读的正文用 `line-height: var(--reading-line-height, 1.6)` 和段间距 `var(--reading-paragraph-gap, 0.3em)`，兜底值是开关关着时的数。列表、表单、卡片、表格属于界面文字，不用这两个 token。`ctx.ui.mountMarkdownEditor`、`ctx.app.mountBlocks`、`ctx.tangu.mountChat` 挂出来的正文自动跟随。
- 视图根上不加自己的入场动画（宿主切主视图时已经淡入一次）；视图内的过渡用 `--duration-fast`、`--duration-base`、`--duration-slow`、`--ease-surface`，并在 `prefers-reduced-motion` 下关闭。
- 这三个开关属于用户：不读写 `forsion_calm_*` 与 `<html data-calm-*>`，不做同类的私有开关。iframe 或 webview 里的页面拿不到宿主变量，不会跟着淡。

Settings → Appearance has three switches the user turns on or off one by one ("Relaxed text" and "Gentle transitions" are on by default, "Dim surroundings" is off by default; never assume which are on): "Dim surroundings" (ribbon icons, inactive tabs and left-sidebar text fade while the user works, and return on pointer or keyboard focus), "Relaxed text" (looser line and paragraph spacing in note and chat bodies), and "Gentle transitions" (a slower view fade and a slower return of the surroundings). A plugin calls no API for these; it follows them by writing its styles this way:

- Use `var(--text)`, `--text-light`, `--text-muted` and `--text-faint` for text and line icons. Do not hard-code colors or add your own `opacity` to mark secondary content: the host fades the left sidebar by fading those variables. Use semantic colors such as `--accent-ink` and `--danger` for state (unread, error, running); they do not fade.
- Mark the selected row of a left-sidebar list with `aria-selected="true"` or `aria-current` (the `.active`, `.on` and `.is-on` classes also work) so the host keeps it at full strength. Do not put `.on` on a container that wraps a whole panel, or nothing inside it will dim. Rows from `registerListSource` are drawn by the host and need nothing.
- For long-form reading text, use `line-height: var(--reading-line-height, 1.6)` and a paragraph gap of `var(--reading-paragraph-gap, 0.3em)`; the fallbacks are the values with the switch off. Lists, forms, cards and tables are interface text and do not use these tokens. Content mounted through `ctx.ui.mountMarkdownEditor`, `ctx.app.mountBlocks` or `ctx.tangu.mountChat` follows automatically.
- Do not add an entrance animation on the view root (the host already fades the main view in once). Use `--duration-fast`, `--duration-base`, `--duration-slow` and `--ease-surface` for transitions inside the view, and disable them under `prefers-reduced-motion`.
- The switches belong to the user: do not read or write `forsion_calm_*` or `<html data-calm-*>`, and do not ship a private switch of the same kind. Pages inside an iframe or webview cannot see host variables and will not fade.

### 盖在自己内容上的白板层 / A whiteboard layer over your own content (2026-10-10)

`ctx.ui?.mountBoard?.(el, opts)` 把宿主的白板引擎（和 `.excalidraw.md` 白板同一个，同样的七支笔）挂成一块透明、没有工具栏的层，盖在插件自己的内容上（PDF 页、图片、时间轴），用来手写和圈画。画出来的是白板元素：`scene.elements` 原样（JSON）保存、原样交回，能和真白板互相粘贴。

```js
const board = ctx.ui?.mountBoard?.(layerEl, {
  scene: { elements: saved },
  viewport: { scrollX, scrollY, zoom },   // 画布上的点落在 (点 + scroll) × zoom 处，相对 layerEl 左上角，CSS 像素
  tool: 'freedraw', pen: 'fountain', theme: 'light',
  onChange: (scene) => saveSoon(scene.elements),
  onWheel: (ev) => scroller.scrollBy(ev.deltaX, ev.deltaY),
})
scroller.addEventListener('scroll', () => board?.update({ viewport: currentViewport() }))
```

- 视口归调用方：这层自己不滚不缩，滚动容器或缩放变了就 `update({ viewport })`；滚轮和捏合事件原样交给 `onWheel`，不传就丢弃。
- 界面缩放（用户把界面调到 110% 之类）由宿主抵消：`viewport` 仍按 `el` 自己的 CSS 像素给；从 `getBoundingClientRect()` 换算时除以 `el.currentCSSZoom`。
- `tool` 取 `selection`、`freedraw`、`eraser`、`text`、`rectangle`、`ellipse`、`arrow`、`line`；`pen`（只对 `freedraw` 有意义）取 `default`、`finetip`、`fountain`、`marker`、`highlighter`、`thick-thin`、`thin-thick-thin`；`strokeColor`、`strokeWidth` 覆盖这支笔自带的颜色和粗细。
- `theme` 缺省跟随宿主明暗。底下的内容在深色模式下仍是浅色（PDF 页）时传 `'light'`，否则引擎会给笔迹反色。
- `onChange` 只在元素变了时触发（画完一笔、擦除、撤销），视口变化和调用方自己推进去的 `scene` 不触发；落笔途中每帧都会来，保存要自己攒。
- 句柄：`update(patch)`、`getScene()`（不含已删除的元素）、`undo()`、`redo()`、`dispose()`。`update({ scene })` 整份替换且不进撤销栈。这层不接管全局快捷键。
- 参数不对（缺 `scene.elements`，或 `viewport` 不是三个有限数且 `zoom > 0`）同步抛 `TypeError`。`dispose()` 幂等，之后 `el` 归还；插件禁用或重载时宿主统一卸载。
- 不在手写时用 `await ctx.ui.boardToSvg({ elements }, { theme, padding })` 出静态图，得到 `{ svg, x, y, width, height }`（空场景是 `null`）；`x`、`y`、`width`、`height` 是画布坐标里的包围盒，把 `svg` 放在 `(x + scrollX) × zoom`、宽 `width × zoom` 处即与白板层里的位置重合。
- 旧宿主没有这两个方法：先特性探测，没有就不出手写入口，不要仿一个。

`ctx.ui?.mountBoard?.(el, opts)` mounts the host whiteboard engine (the one behind `.excalidraw.md` boards, with the same seven pens) as a transparent layer without a toolbar over the plugin's own content, such as PDF pages, images or a timeline. Strokes are whiteboard elements: store `scene.elements` verbatim as JSON and hand them back unchanged; they paste into a real board and back.

- The caller owns the viewport. A scene point lands at `(point + scroll) * zoom` CSS pixels from the top-left corner of `el`. The layer never pans or zooms by itself: call `update({ viewport })` when your scroll container or zoom changes. Wheel and pinch events are handed to `onWheel` untouched and dropped without it.
- The host cancels the app's interface zoom (a user at 110%, for example): keep giving `viewport` in the element's own CSS pixels, and divide `getBoundingClientRect()` distances by `el.currentCSSZoom` when you derive it.
- `tool` is one of `selection`, `freedraw`, `eraser`, `text`, `rectangle`, `ellipse`, `arrow`, `line`. `pen` (only with `freedraw`) is one of `default`, `finetip`, `fountain`, `marker`, `highlighter`, `thick-thin`, `thin-thick-thin`. `strokeColor` and `strokeWidth` override the pen's own.
- `theme` defaults to the host's mode. Pass `'light'` when the surface underneath stays light in dark mode (a PDF page), otherwise the engine recolours the ink.
- `onChange` fires when elements change (a stroke ends, an erase, an undo), not for viewport changes or a `scene` you pushed in. It fires on every frame while drawing, so debounce your saving.
- The handle has `update(patch)`, `getScene()` (deleted elements left out), `undo()`, `redo()` and `dispose()`. `update({ scene })` replaces the content without an undo entry. The layer does not handle global shortcuts.
- Invalid options (no `scene.elements`, or a `viewport` that is not three finite numbers with `zoom > 0`) throw `TypeError` synchronously. `dispose()` is idempotent and returns `el` to you; the host also unmounts on plugin disable or reload.
- While no live layer is mounted, `await ctx.ui.boardToSvg({ elements }, { theme, padding })` returns `{ svg, x, y, width, height }` (`null` for an empty scene). The bounds are in scene units: place `svg` at `(x + scrollX) * zoom` with a width of `width * zoom` to match the live layer.
- Older hosts lack both methods. Feature-detect and hide the handwriting entry instead of imitating it.

### 划线条 / The selection bar (2026-10-13)

选中一段文字之后浮出来的那一条,聊天、笔记和接入了的插件视图是同一条:当前视图自己的工具,加上每个视图都有的三样 —— 「问 Tangu」(把这段文字作为引用交给侧栏对话)、「翻译」(结果在选区下面的一张卡里)、「⋯」(插件加的动作)。哪一块排在前面由用户在「设置 → 外观 → 划线菜单」里定,缺省是视图自己的工具在前。条上的按钮由 `@lcl/components` 的 `SelectionBar` / `SelectionBarActions` 维护;聊天和插件视图经应用层的 `components/selectionBar/ViewSelectionBar` 接选区与动作,笔记的格式工具栏把动作区嵌进自己那一行。

插件视图用 `ctx.ui?.mountSelectionBar?.(root, opts)` 接入,不接就什么都不出(宿主不做全局的选区监听):

```js
const bar = ctx.ui?.mountSelectionBar?.(el, {
  view: 'reader',                                   // 划线动作看到的视图 id 是 '<插件 id>:reader'
  tools: [
    { id: 'yellow', title: zh ? '高亮' : 'Highlight', color: '#ffd400', run: (sel) => { highlight(sel.text); getSelection()?.removeAllRanges() } },
    { id: 'note', title: zh ? '写批注' : 'Add a note', icon: 'annotate', run: (sel) => openNote(sel.text) },
  ],
  source: () => ({ title: doc.title, path: doc.vaultPath, page }),
})
if (!bar) drawOwnMenu(el)                           // 2.13.3 及更早的宿主:保留自己的菜单
```

- 缺省由宿主看 `root` 里的 DOM 选区:松开鼠标时出;选区收起、内容滚动或尺寸变了、点到别处时收。输入框和可编辑区里的选区不出。
- 宿主看不到的内容(iframe、画布、自己定位的 PDF 文字层)传 `watch: false`,自己调 `bar.show({ text, rect })` 和 `bar.hide()`。`rect` 是选区外接矩形的视口像素(`range.getBoundingClientRect()` 原样给;界面缩放由宿主抵消,不要自己除)。
- `tools` 是声明式的:一个图标钮(`icon` 取插件图标词表里的名字;为此加了 `highlight`、`underline`、`strikethrough`、`annotate`、`copy`、`cite`),或一个颜色点(`color`)。宿主只画按钮,做什么由 `run` 决定;工具用掉了选区就在 `run` 里清掉选区或调 `bar.hide()`。没有下拉,要更多界面就在 `run` 里开自己的。
- `ask` 接管「问 Tangu」点了之后做什么(比如带上页码),`false` 去掉这一格;不写就由宿主把文字和 `source` 交给侧栏对话(没有侧栏对话的宿主不画这一枚)。
- 条不往 `root` 里加任何东西,也不接管它(条浮在页面上方),和 `mountFloatingToc` 等别的挂载互不影响。句柄有 `show` / `hide` / `update(opts)` / `dispose()`;插件停用或重载时宿主统一收掉。

往条里加动作用 `ctx.registerSelectionAction`(列在「⋯ → 插件」)。不写 `scope` 时只在笔记里出现,和以前一样;`scope: 'all'` 出现在所有接入了的视图,`'own'` 只在这个插件自己的视图,数组点名视图(`'note'`、`'chat'`、`'<插件 id>:<视图 id>'`)。`when({ view, editable, length })` 返回真才列出,它拿不到选中的文字,文字在用户点了动作之后才经 `run(cx)` 交给插件。`run` 返回的 markdown 进宿主的结果卡:可编辑的笔记里是「替换 / 插入下方 / 复制 / 丢弃」,点了才写;别处只读(「复制 / 关闭」)。`output: 'none'` 表示插件自己处理结果,宿主不出卡。`cx.pagePath` 只在笔记里有。2.13.3 及更早的宿主忽略这些新字段:动作只在笔记里、列在「AI ▾ → 插件」。

The strip that appears over selected text is the same one in chat, in notes and in every plugin view that opts in: the view's own tools plus three actions every view shares — **Ask Tangu** (hands the text to the side chat as a quote), **Translate** (the result opens in a card under the selection) and **⋯** (actions added by plugins). Which block comes first is the user's choice under Settings → Appearance → Selection menu; the view's own tools lead by default. The buttons are maintained in `@lcl/components` (`SelectionBar`, `SelectionBarActions`); chat and plugin views wire selections and actions through the app-level `components/selectionBar/ViewSelectionBar`, and the note formatting toolbar embeds the shared actions in its own row.

A plugin view opts in with `ctx.ui?.mountSelectionBar?.(root, opts)`. A view that never calls it gets no bar: the host does not listen for selections globally.

- By default the host watches the DOM selection inside `root`: the bar shows on mouse-up and goes away when the selection collapses, the content scrolls or resizes, or the user clicks elsewhere. Selections inside inputs and editable regions never show it.
- For content the host cannot see into (an iframe, a canvas, a PDF text layer you position yourself) pass `watch: false` and call `bar.show({ text, rect })` and `bar.hide()` yourself. `rect` is the selection's bounding box in viewport pixels (`range.getBoundingClientRect()` as is; the host cancels the interface zoom, so do not divide).
- `tools` are declarative: an icon button (`icon` is a name from the plugin icon vocabulary, which gained `highlight`, `underline`, `strikethrough`, `annotate`, `copy` and `cite` for this) or a colour swatch (`color`). The host only draws the button and `run` decides what it does; once a tool has consumed the selection, clear it or call `bar.hide()` in `run`. There are no dropdowns: open your own UI from `run`.
- `ask` replaces what Ask Tangu does (to add a page number, for example) and `false` removes that button. Without it the host hands the text and `source` to its side chat; hosts without a side chat draw no button.
- The bar adds nothing to `root` and does not take it over (it floats above the page), so it coexists with `mountFloatingToc` and other mounts. The handle has `show`, `hide`, `update(opts)` and `dispose()`; the host disposes it when the plugin is disabled or reloaded.

Add actions with `ctx.registerSelectionAction`; they are listed behind "⋯" under "Plugins". Without `scope` an action appears in notes only, as before. `scope: 'all'` lists it in every view that shows the bar, `'own'` only in the plugin's own views, and an array names views (`'note'`, `'chat'`, `'<pluginId>:<viewId>'`). `when({ view, editable, length })` must return true for the action to be listed; it never receives the selected text, which only reaches the plugin through `run(cx)` after the user picks the action. The markdown `run` returns goes to the host's result card: Replace / Insert below / Copy / Discard in an editable note, where nothing is written until the user confirms, and read-only (Copy / Close) everywhere else. `output: 'none'` means the plugin handles the result and the host shows no card. `cx.pagePath` is only set in notes. Hosts up to 2.13.3 ignore the new fields: the action stays note-only under "AI ▾ → Plugins".

### 设置零件 / Settings parts (2026-10-17)

设置页、商店页用的那批小零件（分组面板、设置行、开关、按钮、输入框、分段、下拉，以及新加的数值、额度条、步进器、代码 + 复制、半屏选择 / 确认、空 / 加载 / 出错）对插件开放。主接法是 `ctx.ui.mountSettingsPage(el, schema)`：插件交一份整页描述（有哪些组、每组有哪些项、值和回调），宿主按端去画；`ctx.ui.mountSettingsItem(el, item)` 一次挂一件，用来补位（例如放进 `custom` 块里）。宿主自己的「设置 → 通知」用的是同一份画法。类型真源：`desktop/shared/settingsPage.ts`；渲染在应用层的 `components/SettingsPage`。

```js
const zh = ctx.getLocale?.() === 'zh'
const page = ctx.ui?.mountSettingsPage?.(el, { groups: [
  { id: 'quota', icon: 'gauge', title: zh ? 'AI 额度' : 'AI quota', items: [
    { type: 'meters', id: 'm', meters: [{ label: zh ? '今日' : 'Today', value: 0.69 }] },
    { type: 'button', id: 'reset', title: zh ? '额度重置卡' : 'Reset card', buttons: [{ label: zh ? '使用一张' : 'Use one', onClick: useCard }] },
  ] },
  { id: 'bg', icon: 'clock', title: zh ? '后台额度' : 'Background quota', items: [
    { type: 'switch', id: 'fallback', title: zh ? '用完后改用 AI 额度继续' : 'Fall back to AI quota', value: true, onChange: save },
    { type: 'choice', id: 'convert', title: zh ? '从 AI 额度转入' : 'Convert from AI quota', button: zh ? '转入…' : 'Convert…',
      options: [{ value: '5', label: '5%' }, { value: '10', label: '10%' }, { value: '20', label: '20%' }], onPick: convert },
  ] },
] })
if (!page) drawOwnPage(el)
```

| 项 `type` | 画成 | 手机上（≤820 px） |
| --- | --- | --- |
| `switch` | 开关；回调返回的 promise 失败会弹回去 | 留在标题右边 |
| `value` | 只读数值（插件格式化好的字符串） | 留在右边 |
| `button` | `buttons: [...]`，`kind` 为 `primary` / `ghost`（缺省）/ `danger`，可带 `confirm` | 一枚留右；两枚以上换到下一行并占满 |
| `input` | 输入框，可带一枚按钮（`onClick(text)`） | 换到下一行并占满 |
| `segmented` | 切换设置的分段选择 | 放得下就照画分段 |
| `select` | 下拉 | 换到下一行并占满 |
| `choice` | 「选了就执行」：桌面一排按钮 | 一枚按钮（文字 = `button`）+ 半屏；Android 走原生半屏，网页手机壳走宿主半屏 |
| `stepper` | − 数值 +，可带一枚按钮（`onClick(n)`） | 换到下一行 |
| `code` | 代码 + 复制按钮 | 留在右边 |
| `meters` | 额度条，桌面两列、手机一列；填充用宿主的 `--action-fill` | — |
| `state` | `empty` / `loading` / `error`，可带重试 `action`；页面级 `{ state }` 整页只画它 | — |
| `custom` | 宿主给一块空元素，`mount(el)` 每个 id 只调一次，块没了 / 整页卸载时调它返回的收尾 | — |

- **文字和颜色**：零件不带文字，全部由插件传入（中英文跟插件自己的词条）；宿主只提供读屏名（步进器 ± ）和确认框的「取消」。零件只用宿主变量，跟明暗与配色走，插件不传颜色。分组 `icon` 取图标词表的名字，这次加了 `bell`、`gauge`、`coins`、`clock`、`gift`、`user`、`shield`、`package`、`activity`、`message`、`plug`、`list-checks`。
- **触屏**：按钮、输入框、步进器高 36。
- **身份与更新**：每个组和项都要稳定的 `id`，宿主按它认行。`update(schema)` 整份替换。给了的 `value` 每次 update 都以它为准；输入框 / 步进器不给 `value` 就保留用户已经输入的，要清空就传 `value: ''`。按钮回调返回 promise 时按钮禁用到它结束。
- **生命周期**：与其他 `ctx.ui.mount*` 同一套（挂在宿主加进 `el` 的一层里；`dispose()` 后 `el` 立刻归还；同一个 `el` 后调用的挂载收掉前一份）。插件停用、重载时宿主统一收，之后回调不再调用；形态不对（`el` 不是元素、`groups` 不是数组、两样都没给）同步抛 `TypeError`。
- **旧宿主**：2026-10-17 之前的宿主没有这两个方法。先 `ctx.ui?.mountSettingsPage` 探测，没有就继续用自己画的那套，别抄宿主的设置 CSS 冒充。
- **不在这一批**：卡片网格、表格（背包、商店、用量记录要用）放第二批；平板两栏等平板档定稿，零件本身不变。

The small parts used by settings and store pages are open to plugins: group panels, setting rows, switches, buttons, inputs, segmented controls and selects, plus new values, usage meters, steppers, code with copy, half-sheet choices and confirmations, and empty / loading / error states. The main entry is `ctx.ui.mountSettingsPage(el, schema)`: the plugin describes the page (groups, items, values and callbacks) and the host draws it per device. `ctx.ui.mountSettingsItem(el, item)` mounts one part at a time for anything the description does not cover, for example inside a `custom` block. The host's own Settings → Notifications page uses the same renderer. Types live in `desktop/shared/settingsPage.ts`; the renderer is the application-level `components/SettingsPage`.

- On phones (≤820 px) switches, values, codes and single buttons stay to the right of the title; inputs, selects, steppers and two or more buttons move under it and fill the row; a segmented control stays one while it fits; a `choice` (picking runs something) becomes one button labelled `button` that opens a half sheet — native on Android, the host's sheet on the mobile web. Touch targets are 36 px tall.
- Parts carry no text and no colors: every label comes from the plugin, and colors follow the host theme. Group icons use vocabulary names; this release adds `bell`, `gauge`, `coins`, `clock`, `gift`, `user`, `shield`, `package`, `activity`, `message`, `plug` and `list-checks`.
- Every group and item needs a stable `id`. `update(schema)` replaces the whole description. A `value` you pass is applied on every update; leave an input's or stepper's `value` out to keep what the user typed, or pass `''` to clear it. A rejected switch / segmented / select callback flips the control back; a button whose callback returns a promise stays disabled until it settles. `confirm` on a button asks first (a native half sheet on Android).
- The same mount protocol as the other `ctx.ui.mount*` applies: the element is yours again after `dispose()`, one host mount per element, and the host disposes mounts on disable or reload, after which no callback runs. Malformed calls throw `TypeError` synchronously. Hosts before 2026-10-17 lack both methods: feature-detect and keep your own page; do not imitate the host by copying its CSS.
- Card grids and tables come in a later batch; a two-column tablet layout waits for the tablet design. The parts themselves will not change.

### Recording model choices / 记录中的模型选择（2026-10-14）

`ctx.ui?.mountModelPicker?.(el, { kind, value, label, followLabel, scopeKey, onChange })` mounts the existing native ModelPill menu without a prompt input. `kind` is `asr` or `translation`; `value: ''` follows that global slot, while ASR `value: 'local'` selects on-device SenseVoice. It reads the home engine catalog, includes dedicated translation models, and follows native model sorting and grouping preferences. Selection is a local draft delivered through `onChange`; the host never changes global settings or starts a model call. Use `{ update(patch), dispose() }`, change `scopeKey` when switching recordings, and feature-detect together with `ctx.tangu.modelCatalog`. Unready on-device models are explained and cannot become selected; download them through Settings → Voice. The host disposes the picker and aborts an open menu when the plugin is disabled or reloaded.

`ctx.tangu?.modelCatalog?.(kind)` returns `{ models, defaultModelId }` from the same home target used by desktop ASR and inline AI. Each model has `id`, `name`, `provider`, `source`, `available`, and `supportsCorrection`; dedicated machine-translation models set `supportsCorrection: false`. No credentials are returned. `ctx.tangu.complete` and `ctx.tangu.translate` accept optional `modelId` overrides and return optional `model: { id, name, mt? }` provenance. An explicit override never writes the global model slot. When it is omitted, the existing global-slot behavior remains available. Desktop `window.tangu.transcribeAudio` accepts per-call `backend: 'local' | 'cloud'` as well as `modelId`; explicit offline ASR never falls through to a cloud Provider when the local model is unavailable. Pass `language` (`zh`, `en`, `ja`, `ko`, `yue`, …) when you know what is spoken: the on-device model otherwise guesses the language per utterance and can turn far-field English into Chinese or Japanese text; cloud models receive it as a hint. Omit it for mixed-language audio.

这组接口复用原生模型选择器，选择保持为插件的局部草稿；模型调用和记录级持久化仍由插件负责。空值跟随全局设置，ASR 的 `local` 代表本机 SenseVoice。目录来自实际执行调用的 home 引擎；专用翻译模型通过 `supportsCorrection` 标明只支持翻译。切换记录更新 `scopeKey`，通过 `dispose()` 收回宿主挂载；插件禁用或重载也会自动清理。旧宿主没有这些可选方法时，保留跟随全局设置的界面，不显示无法兑现的记录级覆盖。

### 一行记录的编辑字段 / Record fields (2026-10-17)

`ctx.ui?.mountRecord?.(el, { path, rowId, dateCol, readOnly })` 把宿主日历事件浮卡里那排字段（标题、时间摘要和展开编辑、其余属性）画进插件自己的卡片。组件是应用层的 `views/calendar/EventCard` 里的 `RecordFields`，内置日历的浮卡用的是同一个。改动直接写那张表，与 `ctx.databases.setCell` 同一条写口，和打开着的表格是同一份数据。外框、关闭、「打开 / 删除」、定位都归插件。只有声明了 `databases` 的插件才有；`path` 不是库里的表或缺 `rowId` 时同步抛 `TypeError`。`dateCol` 必须是日期类列，否则忽略。行被删或换了库就什么都不画；叠加源（只读表）和 `readOnly: true` 只显示值。句柄是 `update(patch)` 和 `dispose()`，`dispose()` 后 `el` 归还，插件禁用或重载时宿主统一卸载。2026-10-24 起：`body: true` 在字段下面挂这条记录的 Markdown 正文编辑器，和表格「打开记录」是同一份正文、同一条写口，只对可写的经典表生效（笔记视图、叠加源和 `readOnly` 不画）；`hideColumns` 列出不想显示的属性列 id，例如插件自己已经画了勾选框的完成列。`ctx.databases` 快照里正文非空的行带 `hasBody: true`。旧宿主忽略这三项。

`ctx.ui?.mountRecord?.(el, { path, rowId, dateCol, readOnly })` mounts the field list from the host calendar's event card (title, time summary with its editor, other properties) into the plugin's own card. The component is `RecordFields` in the app-level `views/calendar/EventCard`, the same one the built-in calendar card uses. Edits write to the table through the same path as `ctx.databases.setCell`, sharing data with any open table view. The plugin owns the frame, close button, Open / Delete actions and positioning. Only plugins that declare `databases` get it; a `path` that is not a table in the vault or a missing `rowId` throws `TypeError` synchronously. `dateCol` must be a date column and is ignored otherwise. A deleted row or a vault switch renders nothing; overlays (read-only tables) and `readOnly: true` show values only. The handle has `update(patch)` and `dispose()`; after `dispose()` the element is yours again, and the host unmounts on plugin disable or reload. Since 2026-10-24, `body: true` adds the record's Markdown body editor below the fields; it is the same body and write path as "Open record" in a table, and only appears for writable classic tables (not note views, overlays or `readOnly`). `hideColumns` lists property column ids to leave out, such as a done column the plugin already draws as a checkbox. Rows in `ctx.databases` snapshots carry `hasBody: true` when the body is not empty. Older hosts ignore all three.

### 视图模式 / View modes (2026-10-19)

同一份东西换一种看法（对话 / 画布、文档 / 画布、转写 / 笔记 / 纪要、日 / 周 / 3 日 / 月）全应用一个摆法：胶囊在**视图头行的最左**，头行 32px、在纸卡里、不随正文滚；视图自己的标题排在胶囊后面。一个视图最多一颗，2–4 种；超过 4 种的用标签（数据库视图）。筛选、换来源的胶囊长相一样，但不放进这个位置。方案与取舍见仓根 `docs/ToBeImproved/视图模式切换标准方案_2026-10-19`。

- 原生视图：`useViewModes(leaf.id, { modes, value, onChange })`（`@lcl/engine`）登记，再在头行最左放 `<ViewModeSwitch leafId={leaf.id} />`；没有自己顶栏的视图整行用 `<ViewHead leafId>{按钮}</ViewHead>`。已有顶栏的（Amadeus `.amx-toolbar`、日历 `.amx-cal-bar`）给那一行加 `container: lcl-viewhead / inline-size`，窄时的退化才认得这一行的宽度。
- 宿主统一管：⌥⌘V（Windows / Linux：Ctrl+Alt+V）切到下一种；命令面板里每种一条「看法：X」；悬停提示「X（⌥⌘V）」（选项自带键的如日历「D」写自己的）；视图宽度 < 480 只留图标（每种都给了图标时），< 320 收成「当前 ▾」下拉；手机单列壳里视图自己不画，胶囊在顶栏两颗胶囊中间，原生顶栏下进「⋯」的「看法」一节。
- 记忆归视图：笔记按篇、对话按树根、谛听按记录、日历全局、Code Studio 按项目；宿主不替它存。
- 当普通零件用（不进 ⌥⌘V，比如浮窗里的预览 / 源码）：`<ViewModeSwitch spec={{ modes, value, onChange }} />`（`@lcl/components`）；`compact` 恒只留图标。

插件视图用 `ctx.ui?.setViewModes?.(el, spec)`：`el` 是 `mount()` 收到的那个元素，`spec = { modes: [{ id, label, labelEn?, icon? }], value, onChange(id) }`，`icon` 用插件图标词表里的名字（新增 `audio-lines` / `notebook-pen` / `list-checks`）。句柄 `{ set(id), update(patch), actions, dispose() }`：`set` 只改胶囊、不回调 `onChange`；`actions` 是同一行右边的空位，把自己栏里的按钮放进去，整个视图只剩一条头行。同一视图再调一次 = 覆盖；插件禁用 / 重载 / 视图关闭时宿主收回。少于 2 或多于 4 种同步抛错。旧宿主没有这个方法：保留自己的标签。

```js
mount(el) {
  const modes = ctx.ui?.setViewModes?.(el, {
    modes: [{ id: 'transcript', label: '转写', labelEn: 'Transcript', icon: 'audio-lines' }, { id: 'summary', label: '纪要', labelEn: 'Summary', icon: 'list-checks' }],
    value: memo[recordId] || 'transcript',
    onChange: (id) => { memo[recordId] = id; show(id) },
  })
  if (modes) modes.actions.append(myMoreButton)
  else drawOwnTabs(el)
  return () => modes?.dispose()
}
```

The same thing seen another way (Chat / Canvas, Document / Canvas, Transcript / Notes / Summary, Day / Week / 3 days / Month) has one place everywhere: a switch at the **left end of the view's head row**, a 32px row inside the paper that does not scroll; the view's own title follows the switch. One switch per view with 2–4 modes; more than four stays as tabs (database views). Filter and source pills look the same but never sit in that slot. Native views register with `useViewModes(leaf.id, { modes, value, onChange })` from `@lcl/engine` and render `<ViewModeSwitch leafId />` (or `<ViewHead leafId>` for a whole row). The host owns ⌥⌘V (Ctrl+Alt+V) to the next mode, one "View: X" command per mode, the hover hint, icons only under 480px of view width, a "Current ▾" menu under 320px, and the phone top bar (the view draws nothing in the single-column shell; under the native Android top bar the modes are a "View mode" section of "⋯"). The view remembers the mode per thing it shows; the host stores nothing. `<ViewModeSwitch spec />` from `@lcl/components` is the plain part for places outside a view.

Plugin views call `ctx.ui?.setViewModes?.(el, spec)` with the element `mount()` received. `spec` is `{ modes: [{ id, label, labelEn?, icon? }], value, onChange(id) }` with icon names from the plugin icon vocabulary. The handle has `set(id)` (moves the switch without calling `onChange`), `update(patch)`, `actions` (the right end of the same row — move your toolbar buttons there so the view keeps one head row) and `dispose()`. Calling it again on the same view replaces the previous one; the host removes it on disable, reload or view close. Fewer than 2 or more than 4 modes throws. Older hosts lack the method: keep your own tabs there.


### 提示框与动效 token / Tooltips and motion tokens (2026-10-23)

宿主按钮、侧栏行、Ribbon 用的是同一个提示框（LCL `hoverSurface`）：悬停 300ms 才出；弹着的时候移到旁边那个也带提示的元素，同一张提示直接挪过去、不重播；离开 80ms 后才收（这 80ms 里回来不收）；键盘聚焦（`:focus-visible`）立刻出、不做动画；按下或滚动即收。插件不用自己写：

- 原生视图：`tooltipProps(content, { side })` 摊到触发元素上（`@lcl/components`），`content` 是一行、几行（第一行标题、其余次要色）或到点才算的函数（可异步，返回 null 不弹）；DOM 写法 `attachTooltip(el, content, opts)`；临时收起用 `hideTooltip()`。悬停卡（内容是 React，比如应用引用卡、聊天链接卡）用 `useHoverCard(content, opts)`，返回 `triggerProps` 和 `portal`，时长走 `--hovercard-*`；`opts.longPress` 打开后触屏按住 0.5 秒立刻出卡、松手收（手机端用）。
- 插件：`ctx.ui?.attachTooltip?.(el, content, { side })`，`content` 是字符串或字符串数组，`side` 是 `top`（缺省）/ `bottom` / `left` / `right`，放不下自己翻面。句柄 `{ update(content), dispose() }`；插件禁用 / 重载时宿主统一收。提示不给元素起名：图标按钮留 `aria-label`，同时去掉 `title`，免得两层提示叠在一起。旧宿主没有这个方法：照旧用 `title`。

```js
const tip = ctx.ui?.attachTooltip?.(exportBtn, ['导出', '另存一份 Markdown'], { side: 'bottom' })
if (!tip) exportBtn.title = '导出'
// …元素拿走时
tip?.dispose()
```

自己写动效时用宿主的动效 token，不写死时长（宿主的 `check:motion` 对内置样式按这条把关）：`--ease-surface`（进场）/ `--ease-exit`（退场，加速离开）/ `--ease-calm` / `--ease-drawer`，`--duration-instant` / `--duration-fast` / `--duration-base` / `--duration-slow`（100 / 150 / 200 / 250ms），折叠用 `--collapse-duration` / `--collapse-ease`，`--menu-enter-duration` 180ms / `--menu-exit-duration` 80ms，`--tip-enter` / `--tip-exit`，`--hovercard-enter` / `--hovercard-exit`。退场比进场短；会被打断的状态用 `transition` 不用 `keyframes`；不要补间宽高和内外边距（尺寸变化用下面的折叠或 `transform`）；不要写 `transition: all`；新建、恢复、滚进视口的东西不做入场；减少动态效果时留颜色和透明度、去掉位移和缩放。

The host's buttons, sidebar rows and Ribbon share one tooltip (LCL `hoverSurface`): it appears after 300ms of hovering; while one is showing, moving to a neighbouring element that also has one hands the same tooltip over without replaying its animation; it closes 80ms after you leave (coming back within that window keeps it); keyboard focus (`:focus-visible`) shows it at once without animation; pressing or scrolling hides it. Native views spread `tooltipProps(content, { side })` from `@lcl/components` onto the trigger (one line, several lines — the first is the title — or a function evaluated when it is due, may be async, `null` = don't show), use `attachTooltip(el, content, opts)` for DOM, and `hideTooltip()` to close it. `useHoverCard(content, opts)` is the React-content variant (returns `triggerProps` and `portal`, timed by `--hovercard-*`); with `opts.longPress` a half-second press on a touch screen shows it at once and lifting the finger closes it (phones). Plugins call `ctx.ui?.attachTooltip?.(el, content, { side })` with a string or an array of strings; `side` is `top` (default), `bottom`, `left` or `right` and flips when there is no room. The handle has `update(content)` and `dispose()`; the host disposes everything on disable or reload. The tooltip does not name the element: keep `aria-label` on icon buttons and drop their `title` so two tooltips don't stack. Older hosts lack the method: keep `title` there.

For your own motion use the host's motion tokens instead of literal durations: `--ease-surface` (enter), `--ease-exit` (leave, accelerating), `--ease-calm`, `--ease-drawer`, `--duration-instant` / `--duration-fast` / `--duration-base` / `--duration-slow` (100 / 150 / 200 / 250ms), `--collapse-duration` / `--collapse-ease` for collapsing, `--menu-enter-duration` 180ms / `--menu-exit-duration` 80ms, `--tip-enter` / `--tip-exit`, `--hovercard-enter` / `--hovercard-exit`. Leaving is shorter than entering; interruptible states use `transition`, not `keyframes`; don't tween width, height, padding or margin (use the collapse below or `transform` for size changes); don't write `transition: all`; things that are created, restored or scrolled into view don't animate in; with reduced motion keep colour and opacity changes and drop translation and scale.

### 宿主自动给的动效 / Motion the host applies for you (2026-10-25)

插件视图和宿主在同一个页面里，下面这几样用标准写法就自动是 Forsion 的动效，不用自己写关键帧、不用读 token。宿主这几条都是零特异性（`:where()`），你自己给同一个元素写了 `animation` / `transition` 就以你的为准；系统开了「减少动态效果」时宿主一并收掉。iframe / webview 里的页面拿不到。

- **原生 `<details>`**：展开时内容淡入、收起时淡出，与下面的折叠同一对时长和曲线（200ms）。只动透明度、不补间高度，放在会滚动的列表里也不抖。
- **折叠 `data-motion="collapse"`**（2026-10-26 起）：可以开合的一块（文件夹的子项、展开的详情）外层写 `data-motion="collapse"`，开着写 `data-open="true"`、收着写 `"false"`，**里面只套一层**元素放内容。宿主用 `grid-template-rows` 让它从 0 长到内容高、同时淡入，收起同样 200ms；中途反悔会从当前位置接着走，不用量高度。收着时内容 `visibility: hidden`，Tab 走不进去。旁边的箭头写 `data-motion="chevron"` 加同一个 `data-open`，开着转 90°（用朝右的箭头），和内容一起开始、一起停。展开好了里层仍会裁切探出去的内容；需要放开就在外层加 `data-settled`（React 用宿主的 `AnimatedCollapse`，它自己处理：从 `@lcl/components` 导入，`<AnimatedCollapse open={open}>{open && …}</AnimatedCollapse>`，收起时放完动画再卸载）。不要自己量 `scrollHeight` 补间 `height`。
- **原生 `<dialog>`（`showModal()`）和 `popover`**：打开时与命令面板同一档进场（120ms，淡入并从 0.985 放大到 1），遮罩一起淡入。
- **`data-motion="enter"`**：给「用户刚点了才出现」的那块内容写上这个属性（点开的清单、展开的分区、换出来的另一版），它挂上时淡入并从下方 4px 上来（180ms）。只写在刚发生的东西上：一打开视图就有的、从存档恢复的、滚进视口的不要写。动的是独立的 `translate` 属性，不会打乱你用 `transform` 做的定位。
- 菜单、提示框、落点提示、Chat Box 用宿主的组件就自带进退场（见上文和下一节），不要自己再包一层动画。

```js
const more = document.createElement('div')
more.dataset.motion = 'enter'        // 用户点了「展开」才挂上
list.after(more)
```

```js
// 折叠:外层一个属性,里面只套一层
section.innerHTML = '<button class="head"><span data-motion="chevron" data-open="false">›</span> 详情</button>' +
  '<div data-motion="collapse" data-open="false"><div class="body">…</div></div>'
const box = section.querySelector('[data-motion="collapse"]'), chev = section.querySelector('[data-motion="chevron"]')
section.querySelector('.head').onclick = () => { const open = box.dataset.open !== 'true'; box.dataset.open = chev.dataset.open = String(open) }
```

The plugin view lives in the same page as the host, so the following get Forsion motion from standard markup alone, with no keyframes of your own and no tokens to read. All of these host rules have zero specificity (`:where()`): an `animation` / `transition` you write on the same element wins, and the host turns them off under reduced motion. Pages inside an iframe / webview don't get them.

- **Native `<details>`**: the content fades in when opened and out when closed, with the same duration and curve as the collapse below (200ms). Only opacity moves, height is not tweened, so it stays steady inside scrolling lists.
- **Collapse, `data-motion="collapse"`** (2026-10-26+): on a block that opens and closes (a folder's children, an expanded detail) write `data-motion="collapse"` on the outer element, `data-open="true"` when open and `"false"` when closed, and put the content in **exactly one** inner element. The host grows it from zero to its content height with `grid-template-rows` while fading it in, and closes it in the same 200ms; changing your mind halfway continues from where it is, and nothing measures heights. While closed the content is `visibility: hidden`, so Tab can't reach it. Give the chevron next to it `data-motion="chevron"` with the same `data-open`: it turns 90° when open (use a right-pointing chevron) and starts and stops with the content. Once open, the inner element still clips anything that sticks out; add `data-settled` on the outer element to release it (in React use the host's `AnimatedCollapse` from `@lcl/components`, which does this for you: `<AnimatedCollapse open={open}>{open && …}</AnimatedCollapse>`, and on close it plays the animation before unmounting). Don't measure `scrollHeight` and tween `height` yourself.
- **Native `<dialog>` (`showModal()`) and `popover`**: they open like the command palette (120ms, fade in while scaling from 0.985 to 1) and the backdrop fades in with them.
- **`data-motion="enter"`**: put it on content that appears because the user just did something (a list they opened, a section they expanded, the other version they switched to); it fades in and rises 4px when it mounts (180ms). Only for what just happened: not for what is there when the view opens, is restored, or scrolls into view. It animates the separate `translate` property, so positioning you do with `transform` is left alone.
- Menus, tooltips, drop indicators and the Chat Box carry their own enter / leave motion when you use the host's components (see above and the next section); don't wrap them in another animation.

```js
const more = document.createElement('div')
more.dataset.motion = 'enter'        // mounted only after the user clicks "Show more"
list.after(more)
```

```js
// Collapse: one attribute on the outer element, exactly one inner element
section.innerHTML = '<button class="head"><span data-motion="chevron" data-open="false">›</span> Details</button>' +
  '<div data-motion="collapse" data-open="false"><div class="body">…</div></div>'
const box = section.querySelector('[data-motion="collapse"]'), chev = section.querySelector('[data-motion="chevron"]')
section.querySelector('.head').onclick = () => { const open = box.dataset.open !== 'true'; box.dataset.open = chev.dataset.open = String(open) }
```

### 落点提示 / Drop indicators (2026-10-24)

拖动排序、拖进文件夹时那根「会落在这里」的线和那圈「放进去」的描边，宿主各处用的是同一个（LCL `dropIndicator`）：颜色是主题的 `--signal-line`；换落点时旧的在原地淡出（90ms）、新的在新位置淡入并从近端展开（130ms）；同一个落点只是跟着滚动挪了坐标，就直接跟过去、不重播；系统开了「减少动态效果」就不做动画。不要自己画线：

- 原生视图：`createDropIndicator({ host?, className? })`（`@lcl/components` 或 `@lcl/engine`），句柄 `line(rect, { key?, axis? })`、`zone(rect, { key? })`、`hide()`、`destroy()`；坐标一律视口 px。已经有自己落点元素的，在写新位置**之前**调 `dropRetarget(el, key, { axis? })`，藏之前调 `dropHide(el)`。每行自己用伪元素画线的列表，照 `lcl/engine/dropIndicator.css` 顶注写：伪元素常驻、平时透明，落点类只把它亮起来（`--lcl-drop-enter` / `--lcl-drop-leave`）；描边、底色类用 `transition: box-shadow var(--lcl-drop-fade)`。
- 插件：`ctx.ui?.dropIndicator?.({ host? })`，句柄 `{ line, zone, hide, dispose }`。`line({ x, y, w })` 是横线（`y` 是线的上沿），`line({ x, y, h }, { axis: 'v' })` 是竖线，`zone({ x, y, w, h })` 是「放进去」的描边。给 `key`（你的行 / 槽位 id），滚动时才不会被当成换了落点。dragleave / drop / dragend 时 `hide()`；视图拿走时 `dispose()`，插件禁用 / 重载时宿主统一收。旧宿主没有这个方法：照旧画自己的线。

```js
const drop = ctx.ui?.dropIndicator?.()
list.addEventListener('dragover', (e) => {
  const row = e.target.closest('[data-row]'); if (!row) return
  e.preventDefault()
  const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2
  drop?.line({ x: r.left + 4, y: (after ? r.bottom : r.top) - 1.5, w: r.width - 8 }, { key: `${row.dataset.row}:${after}` })
})
list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) drop?.hide() })
list.addEventListener('drop', () => drop?.hide())
```

**松手落位（2026-10-25）**：松手后被拖的那一个从松手的位置（拖影所在处）滑进新位置，160ms 减速（曲线同落点线 `--lcl-drop-ease`，时长 token `--land-duration`），一路带着淡下去的阴影；邻居不让位；「减少动态效果」下直接到位。宿主的 Tangu 会话档项目组、插件列表的行、内置待办视图换组都用它（主页卡片是 dnd-kit 排序，不走这里；日历插件自带的待办视图要它自己调 `drop.land`）。

- 原生视图：拖起时 `grab = dragGrab(el, e)`，松手时 `from = releasePoint(e, grab)`；重渲之后（绘制之前：`useLayoutEffect` / `requestAnimationFrame`）调 `land(el, from, { with?, unclip? })`——`with` 是跟着同一段位移走的元素（展开的组底下那块），`unclip` 是飞行时临时放开裁剪的折叠容器。数据要过一会儿才重渲（写盘、插件回调之后）就用 `landWhenMoved(() => 找到那一行, from, opts)`：每次 DOM 有增删就问一次，等它重新挂载或换了父节点 / 前一个兄弟才落，1.2 秒没动就作罢。只写被拖元素自己的内联 `transform` / `transition` / `box-shadow`，飞完原样还回去；动的是 `transition`，不是关键帧。
- 插件：句柄上的 `drop.land?.(target, from)`。`target` 是已经重渲到新位置的那一行；还没重渲就传一个找它的函数，宿主等它换了地方再落。`from` 同上（视口 px 的左上角）。旧宿主没有 `land`：照旧瞬时到位。

```js
let grab = null
list.addEventListener('dragstart', (e) => { const r = e.target.getBoundingClientRect(); grab = { x: e.clientX - r.left, y: e.clientY - r.top } })
list.addEventListener('drop', async (e) => {
  drop?.hide()
  const from = grab && { x: e.clientX - grab.x, y: e.clientY - grab.y }
  await moveRow(id, target)             // 你自己的挪动 + 重渲
  if (from) drop?.land?.(() => list.querySelector(`[data-row="${id}"]`), from)
})
```

After a drop, `land` makes the moved item glide from where it was let go (where the drag image was) into its new place: 160ms, decelerating (the drop line's `--lcl-drop-ease`; duration token `--land-duration`), its lift shadow fading out; neighbours don't make room; with reduced motion it simply appears there. The host uses it for project groups in the Tangu sessions list, plugin list rows and the built-in to-do view's group changes (homepage tiles sort with dnd-kit and don't; the Calendar plugin's own to-do view has to call `drop.land` itself). Native views keep `grab = dragGrab(el, e)` at dragstart and `from = releasePoint(e, grab)` at drop, then after re-rendering (before paint: `useLayoutEffect` / `requestAnimationFrame`) call `land(el, from, { with?, unclip? })` — `with` lists elements that move by the same offset (an expanded group's rows), `unclip` folding containers whose clipping is lifted for the flight. When the re-render comes later (after a write or a plugin callback), `landWhenMoved(() => findRow(), from, opts)` checks on every DOM change (a MutationObserver, before paint) and lands once the row is re-mounted or has a new parent / previous sibling, giving up after 1.2s. Only the item's own inline `transform` / `transition` / `box-shadow` are written for the flight and restored afterwards; it is a `transition`, not keyframes. Plugins call `drop.land?.(target, from)` on the handle: `target` is the row already in its new place, or a function that finds it once your re-render lands; `from` as above, a viewport top-left. Older hosts lack `land`: rows simply appear in place.

The line that says "it will land here" while dragging to reorder, and the outline for "drop into this", are one thing across the host (LCL `dropIndicator`): coloured with the theme's `--signal-line`; moving to another drop point fades the old one out where it is (90ms) and fades the new one in where it lands, unfolding from its near end (130ms); the same drop point merely moving with a scroll follows without replaying; with reduced motion nothing animates. Don't draw your own. Native views use `createDropIndicator({ host?, className? })` from `@lcl/components` (handle: `line(rect, { key?, axis? })`, `zone(rect, { key? })`, `hide()`, `destroy()`, viewport px); places that already own an indicator element call `dropRetarget(el, key, { axis? })` **before** writing the new position and `dropHide(el)` before hiding it; lists that draw a pseudo-element line per row keep it always present and transparent and let the drop class light it up with `--lcl-drop-enter` / `--lcl-drop-leave` (see the head of `lcl/engine/dropIndicator.css`), and outline or background highlights use `transition: box-shadow var(--lcl-drop-fade)`. Plugins call `ctx.ui?.dropIndicator?.({ host? })`: `line({ x, y, w })` is a horizontal line whose top edge is at `y`, `line({ x, y, h }, { axis: 'v' })` a vertical one, `zone({ x, y, w, h })` the outline. Pass a `key` (your row or slot id) so a scroll is not taken for a new drop point. Call `hide()` on dragleave / drop / dragend and `dispose()` when the view goes away; the host disposes it on disable or reload. Older hosts lack the method: keep your own line there.

### 宿主替插件画的零件 / Host-drawn parts (2026-10-26)

插件拿不到宿主的 React 组件(一份 React 不跨插件共享),所以宿主把常用零件做成 `ctx.ui` 上的挂载,插件只传数据和回调。文案字段都收 PluginText(字符串 / `() => string` / `{ zh, en }`),宿主在画的那一刻求值,切语言自动重算。宿主侧实现都在 `desktop/frontend/src/amadeus/plugins/`(`partsSurface.tsx`、`contextMenuSurface.tsx`、`pluginIcon.tsx`、`pluginText.ts`、`pluginParts.css`),复用的是原生那一份:

| 接口 | 宿主那一份 | 约定 |
| --- | --- | --- |
| `ctx.ui.contextMenu(x, y \| { anchor, align, side }, entries, opts?)` | `.ctx-menu` 外壳 + `OverlayAt`(Android:`runNativeSheetMenu`) | 行 `{ label, run, icon?, shortcut?, checked?, disabled?, danger? }`、`{ separator: true }`、`{ section }`;有一项带图标,没图标的留同宽空位;首尾 / 相邻分隔与空小节自动去掉;`opts.keepOpen` + 句柄 `update(entries)`;`opts.onClose`。 |
| `ctx.ui.confirm(opts)` / `ctx.ui.openDialog(opts)` | 原生 `<dialog>` + `showModal`,外观同笔记的 ConfirmDialog(420 / 560px、`--radius-lg`、卡片底、`--card-shadow`);Android 确认走 `presentNativeConfirm` | 主按钮在右,`danger` 时红、焦点落「取消」;Enter = 主按钮;Esc / 遮罩 = 取消;`run` 返回 `false` 不关;`mount(el)` 的清理在关闭时跑。 |
| `ctx.ui.mountControl(el, { type, size: 'toolbar', … })` | 分段 = `ViewModeSwitch`(看法胶囊);下拉 = 28px 文字钮 + `.ctx-menu` listbox(Android 原生抽屉) | 分段 2–5 项;下拉 6 项起带搜索;点了先挪过去再回调 `onChange`,`update({ value })` 以插件为准。 |
| `ctx.ui.popover(anchor, { mount, side, align })` | `.ui-popover` 外壳,`clampMenu` + `zoomOf` 落位 | 锚定、夹边、界面缩放、Esc / 点外面 / 失焦关;同一时刻一个。 |
| `ctx.ui.icon(name, { size })` | `PLUGIN_ICONS` 词表(Space 那 30 个名字已并入) | 返回新 `<svg>`;词表外 → null + 控制台警告一次(插件 id + 名字,带近似名);Space / 列表照旧回落(方块堆 / 文件)。 |
| `ctx.ui.mountEmptyState(el, …)`、`ListSourceContribution.empty` | `components/EmptyState`;列表源经 `views/hostListEmpty.ts` 登记 | 桌面:插件自己的 Space 里侧栏不写「暂无内容」;手机整屏列表画同一份空态。 |
| `ctx.ui.mountWebCard(el, …)` | `components/WebCard`(宿主自己的本地网页卡 / 服务卡 `views/chat2/WebCards.tsx` 也用它);缩略图走主进程 `electron/pageThumb.ts` | 只收 http(s) 缩略图,按 url + version 缓存;`layout: 'row'` 是列表一行;update 带了键、值为 undefined / [] / null = 清掉。 |
| `ctx.ui.setViewHead(el, { title, actions })` | `ViewHead`(`title` 插槽)+ `plugin-viewhead-actions` | 与 `setViewModes` 并存:胶囊、标题、两份按钮。 |
| `ctx.ui.mount(name, el, props)` | 上面这些的同一入口(`PluginUiParts` 类型) | 给 React / Vue 插件在 ref 上挂;返回 `{ update, dispose }`。 |
| `ctx.addStyle(css)`、`ctx.i18n.define({ zh, en })` | `<style data-plugin>`、`pluginText.ts` 的 `defineMessages` | 停用 / 重载时摘掉;回退链 当前语言 → zh → key,缺 en 键警告一次。 |

生命周期同其它 `ctx.ui.mount*`:插件停用 / 重载 / setup 失败时宿主统一收,回调此后不再调;形态错同步抛 `TypeError`。仪器:`desktop/frontend/src/amadeus/plugins/partsSurface.test.ts`(单测)、`desktop/scripts/r8dx-shots.cjs`(真 Electron:装样例插件 `scripts/fixtures/r8dx-sample-v2`,明 / 暗 / 现场切英文 / 窄窗格拍图并量几何)。

The host draws these parts for plugins, which never get its React components. Text fields take PluginText (string, `() => string` or `{ zh, en }`) and follow a language switch. Menus gained icons, shortcut hints, separators, section headings, anchoring to a button and the Android bottom sheet; dialogs, toolbar controls, popovers, empty states, the view head, one icon vocabulary (`ctx.ui.icon`), `ctx.addStyle` and `ctx.i18n.define` are new, and `ctx.ui.mount(name, el, props)` is the typed entry point for React / Vue plugins. Before 2026-10-26 `ctx.ui.contextMenu` kept only `label` / `run` / `checked` / `disabled` / `danger` and dropped every other field silently.

### 样式契约 / Style contract (2026-10-26)

插件可以依赖的宿主类名和 CSS 变量发布在 forsion-plugin 技能的 `tools/plugin-contract.json`（每个带用途，随 `apiVersion` 升级）；清单外的宿主类名和变量随时可能改名或删掉。

- 公开类名：`.btn`（`.primary` / `.ghost` / `.danger` / `.sm`）、`.ctx-menu` 外壳（直接子 `<button>` 是菜单项，另有 `button.danger`、`.ctx-separator`、`.ctx-shortcut`、`.ctx-head`、`.ctx-menu-scroll`）、`.empty-state` / `.empty-title`。不要借用 `.amx-*`、`.fc-*`、`.t2-*` 这些宿主私有类名。
- 公开 token：色、圆角 `--radius-*`、阴影、菜单尺寸 `--menu-*`、界面字号 `--ui-font-*` / `--ui-line-*`、动效 `--duration-*` / `--ease-*`，以及 `--focus-ring`。只列名字不列值，值跟着设计语言、主题色和背景色变。`--ease-out`、`--ease-spring`、`--ease-apple`、`--dur-*` 已弃用。
- 不写兜底：写 `var(--radius-md)`，不写 `var(--radius-md, 10px)`。只有 token 比插件的 `minAppVersion` 新（契约里的 `since` 表）时才给老宿主留兜底；`--reading-line-height` / `--reading-paragraph-gap` 本来就带兜底。
- 不写死颜色、阴影和圆角：浅底用 `color-mix(in srgb, var(--green) 14%, transparent)`。画面本身要固定的颜色（视频黑边、压在画面上的白字）写关键字 `black` / `white`。
- 检查：`node check-plugin.mjs <插件目录> --style` 扫 `main.js` 和目录里的 `.css`，报私有类名、清单外或已弃用的 token、多余兜底、写死的颜色、4px 及以上的圆角和带颜色的阴影。只报告，不改变退出码。给另一份文档用的 CSS（iframe 里的页面、导出文件）在同一行写 `/* forsion-style: off */` 跳过。

The host class names and CSS custom properties a plugin can rely on are published in the forsion-plugin skill's `tools/plugin-contract.json` (each with its purpose, versioned with `apiVersion`). Host class names and variables outside that list can be renamed or removed in any release.

- Public classes: `.btn` (`.primary` / `.ghost` / `.danger` / `.sm`), the `.ctx-menu` shell (its direct `<button>` children are the items; also `button.danger`, `.ctx-separator`, `.ctx-shortcut`, `.ctx-head` and `.ctx-menu-scroll`), and `.empty-state` / `.empty-title`. Do not borrow host-private classes such as `.amx-*`, `.fc-*` or `.t2-*`.
- Public tokens: colors, radii `--radius-*`, shadows, menu sizes `--menu-*`, interface type `--ui-font-*` / `--ui-line-*`, motion `--duration-*` / `--ease-*`, and `--focus-ring`. The contract lists names, not values: values follow the design language, accent and background. `--ease-out`, `--ease-spring`, `--ease-apple` and `--dur-*` are deprecated.
- No fallbacks: write `var(--radius-md)`, not `var(--radius-md, 10px)`. Keep a fallback only for a token newer than your `minAppVersion` (the contract's `since` table); `--reading-line-height` and `--reading-paragraph-gap` take one by design.
- No hard-coded colors, shadows or radii: for a wash use `color-mix(in srgb, var(--green) 14%, transparent)`. A color that is fixed on purpose because it belongs to the artwork (a video letterbox, white text over a frame) is written as a keyword: `black` / `white`.
- Check: `node check-plugin.mjs <plugin folder> --style` scans `main.js` and the folder's `.css` files and reports private classes, tokens that are not public or are deprecated, needless fallbacks, hard-coded colors, radii of 4px or more, and shadows with a hard-coded color. It only reports and does not change the exit code. CSS meant for another document (a page inside an iframe, an exported file) is skipped by putting `/* forsion-style: off */` on the same line.

