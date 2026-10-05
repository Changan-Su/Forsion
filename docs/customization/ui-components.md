---
title: 可复用界面组件 / Reusable UI components
description: 在 View 与插件中复用 Chat Box，明确草稿、模型选择与提交的归属。
---

# 可复用界面组件 / Reusable UI components

Space 组织布局，View 是可独立打开的功能面，UI component 是 View 内可组合的部件。此处不使用 Amadeus 的文档 Block 或仪表盘 Card 作为组件名称。工程分层及维护规则见 [LCL](../../lcl/README.md)。

Chat Box 的卡面、输入、操作栏和提交按钮由 `@lcl/components` 维护。聊天与首页通过 `Composer2` 接会话行为；Coding 的新建项目通过 `components/chatbox` 接模型目录，并在创建完成后传递选定模型与思考档。项目详情与 Forsion 能力选择是宿主插槽。

## 插件使用

`ctx.ui?.mountChatBox` 可挂到插件自己的 View 中，不需要 React。当前支持文本输入、模型选择、思考档、键盘提交；附件、命令、审批和运行控制属于会话编排器，未接线的行为不显示。

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

## English API notes

Use `ctx.ui?.mountChatBox?.(element, options)` inside a plugin View. The host supplies the same input surface and model picker used by built-in Views; the plugin supplies localized labels and owns submission. `onSubmit` receives `{ text, modelId, thinkingLevel }`: return true to clear the submitted text, or false to keep it. Rejected submissions keep the draft and show a retryable error. Model and effort choices remain local, without changing the active conversation or global defaults.

`handle.update(patch)` preserves mounted state; `focus()` focuses the input; `dispose()` is idempotent. The host also cleans up on plugin disable, reload, or setup failure. Submission is locked while pending, and disposed instances ignore late results. Default keyboard submission is ⌘/Ctrl+Enter; Shift+Enter adds a line and IME confirmation never submits. Text, model selection, and effort are supported; conversation-only attachments, slash commands, approvals, and run controls require their session host. Feature-detect on older hosts. The canonical options and handle types live in `desktop/shared/chatBox.ts`.

## API 文档的 Amadeus 编辑器 / Amadeus for API-backed documents

`ctx.ui?.mountMarkdownEditor(el, { value, label, readOnly, onChange })` 挂载原生 Amadeus / Milkdown 编辑器，支持可视编辑、Markdown 源码和发布预览。正文完全由调用方保存，不读写活动智库、不修改当前笔记、不自动请求模型。句法沿用 CommonMark、GFM、CJK 强调、`![[视频链接]]` 与 Obsidian callout；折叠 callout 使用 `> [!note]- 标题`。

`handle.getValue()` 同步取最新事务，保存前必须调用；`update({value})` 切换文档，`insertMarkdown(text)` 追加上传附件或嵌入，`focus()` 聚焦，`dispose()` 幂等清理。插件禁用/重载与主视图卸载也会收回挂载，旧句柄不能再改内容。旧宿主缺少此 API 时应明确要求升级，不能伪装成原生编辑器。

The caller owns the document and persistence. No implicit vault, active page, AI calls or autosave. The editor and publishing renderer share Amadeus Markdown semantics. Read `getValue()` immediately before saving; dispose mounts on view teardown. Feature-detect on older hosts.


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

设置 → 外观有三个缺省开着、可逐项关掉的开关：「外围淡出」（Ribbon 图标、未选中的标签、左侧栏文字平时退后，指针或键盘焦点进来恢复）、「宽松正文」（笔记与对话正文的行距、段距放宽）、「舒缓过渡」（切换视图的淡入、外围恢复慢一点）。插件不需要调用任何接口，按下面几条写样式就会跟着走：

- 文字与线性图标只用 `var(--text)`、`--text-light`、`--text-muted`、`--text-faint`，不写死颜色，也不自己叠 `opacity` 表示次要。左侧栏的淡出是宿主调淡这几个变量实现的；状态（未读、出错、进行中）用 `--accent-ink`、`--danger` 这类语义色，它们不淡。
- 左侧栏列表的选中行用 `aria-selected="true"` 或 `aria-current` 标出来（类名 `.active` / `.on` / `.is-on` 也认），宿主让它保持全亮。别把 `.on` 挂在包着整块面板的容器上，否则里面的内容都不会退后。`registerListSource` 的行由宿主画，不用处理。
- 整段阅读的正文用 `line-height: var(--reading-line-height, 1.6)` 和段间距 `var(--reading-paragraph-gap, 0.3em)`，兜底值是开关关着时的数。列表、表单、卡片、表格属于界面文字，不用这两个 token。`ctx.ui.mountMarkdownEditor`、`ctx.app.mountBlocks`、`ctx.tangu.mountChat` 挂出来的正文自动跟随。
- 视图根上不加自己的入场动画（宿主切主视图时已经淡入一次）；视图内的过渡用 `--duration-fast`、`--duration-slow`、`--ease-out`，并在 `prefers-reduced-motion` 下关闭。
- 这三个开关属于用户：不读写 `forsion_calm_*` 与 `<html data-calm-*>`，不做同类的私有开关。iframe 或 webview 里的页面拿不到宿主变量，不会跟着淡。

Settings → Appearance has three switches, all on by default and each can be turned off: "Dim surroundings" (ribbon icons, inactive tabs and left-sidebar text fade while the user works, and return on pointer or keyboard focus), "Relaxed text" (looser line and paragraph spacing in note and chat bodies), and "Gentle transitions" (a slower view fade and a slower return of the surroundings). A plugin calls no API for these; it follows them by writing its styles this way:

- Use `var(--text)`, `--text-light`, `--text-muted` and `--text-faint` for text and line icons. Do not hard-code colors or add your own `opacity` to mark secondary content: the host fades the left sidebar by fading those variables. Use semantic colors such as `--accent-ink` and `--danger` for state (unread, error, running); they do not fade.
- Mark the selected row of a left-sidebar list with `aria-selected="true"` or `aria-current` (the `.active`, `.on` and `.is-on` classes also work) so the host keeps it at full strength. Do not put `.on` on a container that wraps a whole panel, or nothing inside it will dim. Rows from `registerListSource` are drawn by the host and need nothing.
- For long-form reading text, use `line-height: var(--reading-line-height, 1.6)` and a paragraph gap of `var(--reading-paragraph-gap, 0.3em)`; the fallbacks are the values with the switch off. Lists, forms, cards and tables are interface text and do not use these tokens. Content mounted through `ctx.ui.mountMarkdownEditor`, `ctx.app.mountBlocks` or `ctx.tangu.mountChat` follows automatically.
- Do not add an entrance animation on the view root (the host already fades the main view in once). Use `--duration-fast`, `--duration-slow` and `--ease-out` for transitions inside the view, and disable them under `prefers-reduced-motion`.
- The switches belong to the user: do not read or write `forsion_calm_*` or `<html data-calm-*>`, and do not ship a private switch of the same kind. Pages inside an iframe or webview cannot see host variables and will not fade.
