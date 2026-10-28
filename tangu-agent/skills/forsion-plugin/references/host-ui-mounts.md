# Host UI mounts for desktop plugins

Split out of the forsion-plugin SKILL.md (1.63.0) because the model only sees the head and tail of a long tool result (capToolResult keeps 34k + 12k of anything over 48k chars). Read the section for the API you are about to use; the contribution table in SKILL.md links here. A 见「…」 that is not in this file points back to SKILL.md.

### 可复用 UI 组件：ctx.ui.mountChatBox（2026-09-24 起）

Space 管布局，View 管独立功能面，**UI component** 是 View 内可组合的部件；不要与 Amadeus 文档 Block / Dashboard Card 混用。
开发插件 View 前先查宿主组件目录；已经公开的组件通过 `ctx.ui` 挂载，不复制聊天 JSX/CSS，也不打包第二份 React。

`ctx.ui?.mountChatBox?.(el, opts)` 挂载与原生聊天同源的输入卡和模型选择器，返回 `{ update(patch), focus(), dispose() }`。
`opts` 支持 `value`、`modelId`、`thinkingLevel`、`agentSlug`（初始默认）、`label`、`placeholder`、`submitLabel`、`disabled`、
`submitOn: 'modifier-enter' | 'enter'`、`onChange(draft)`、`onSubmit(draft)`。`draft = { text, modelId, thinkingLevel }`。
提交返回 true 清空已提交内容；false / reject 保留，等待中防重复。默认 ⌘/Ctrl+Enter，Shift+Enter 换行，输入法确认不提交。
模型目录与聊天共用，只展示 LLM；模型与思考档是组件局部草稿，不改全局默认/当前会话，不自动开会话或调用模型。
**调用方必须使用回调里的模型与思考档**，不能只接 text。附件、命令、审批与运行控制属于会话编排器，不是此提示表单 API。
插件主动在 View 卸载时 dispose（之后 `el` 立刻归还，见上「dispose 契约」）；宿主仍会在插件禁用/重载/setup 失败时统一回收，卸载后晚到的异步结果无效。
完整双语示例与契约：`docs/customization/ui-components.md`；类型真源：`desktop/shared/chatBox.ts`。
新增公共组件时一起维护类型、本文、原生消费者和生命周期测试，`contractDocs.test.ts` 覆盖 `ctx.ui` 嵌套方法。

### 原生 Markdown 编辑器 ctx.ui.mountMarkdownEditor(2026-09-30 起)

`ctx.ui?.mountMarkdownEditor?.(el, opts)` 挂载与笔记同源的 Amadeus 编辑器(可视 / Markdown 源码 / 发布预览三档),
返回 `{ getValue(), update(patch), insertMarkdown(md), focus(), dispose() }`。
`opts` 支持 `value`(必填字符串)、`label`、`readOnly`、`previewBaseUrl`(预览里相对路径图片/视频的源)、`onChange(markdown)`、`modes`。
**`modes: false` = 不画顶上那排「编辑 / 源码 / 预览」切换按钮,只留可视编辑器**(2026-10-12 起):编辑器放进自己的卡片、单元格、表单项里时用;
缺省是三档都在。`update({ modes })` 可以随时开关(关掉的那一刻停在源码或预览档,会回到可视编辑器)。
2.13.2 及更早的宿主不认这个字段、照样画那一排 —— 要兼容它们就在自己的样式里把那一排藏掉当兜底
(`.你的容器 .amx-publishing-editor > div:has(> button[aria-pressed]) { display: none !important }`),别的宿主节点一律不要选。
**正文与持久化归调用方**:不读写活动库、不改当前笔记、不自动保存、不调模型。保存前必须同步调 `getValue()`(含最新一笔编辑事务)。
`update({ value })` 换文档,`insertMarkdown` 追加附件/嵌入(只读时无效),`dispose()` 幂等(之后 `el` 立刻归还,见上「dispose 契约」);宿主在插件禁用/重载/setup 失败时统一回收,旧句柄不再改内容。
老宿主没有此方法时明确提示升级,不要拿 textarea 冒充原生编辑器。完整契约:`docs/customization/ui-components.md`;类型真源:`desktop/shared/markdownEditor.ts`。

### 原生悬浮目录 ctx.ui.mountFloatingToc(2026-09-07 起)

长内容视图不用复制 Chat View 的目录实现。`ctx.ui.mountFloatingToc(shell, opts)` 在插件自己的
`shell` 上叠一层宿主原生 Floating TOC(默认左侧刻度条、hover / 键盘聚焦展开),正文 DOM 与滚动仍归插件。
宿主负责 MutationObserver 增量扫描、当前段高亮、平滑跳转、窄栏隐藏、明暗 / 配色 / 扁平模式与键盘可达性。

```js
ctx.registerView({ id: 'manual', title: 'Manual', mount(el) {
  el.innerHTML = `
    <div data-role="shell" style="height:100%;min-height:0">
      <article data-role="scroll" style="height:100%;overflow:auto">
        <h1>Getting started</h1><p>…</p>
        <h2>Configuration</h2><p>…</p>
      </article>
    </div>`
  const shell = el.querySelector('[data-role="shell"]')
  const scroll = el.querySelector('[data-role="scroll"]')
  const toc = ctx.ui?.mountFloatingToc(shell, {
    scrollContainer: scroll,
    contentRoot: scroll,               // 省略时就是 scrollContainer
    selector: 'h1, h2, h3',
    label: ctx.getLocale?.() === 'en' ? 'Table of contents' : '目录',
    minItems: 2,                       // 缺省 2;只有一个标题时不占边栏
    hideBelow: 520,                    // 缺省 520 CSS px
    topOffset: 24,
    side: 'left',                      // 也可 right
  })
  return () => toc?.dispose()
} })
```

- `shell` 是**非滚动**定位外壳,`scrollContainer` 是里面真正滚动的元素;宿主只在 `shell` 追加覆盖层,
  不会清空或接管插件正文。两者写成同一个滚动元素会让覆盖层跟着正文滚,不要这样搭。
- 普通标题不用额外标记。非 `h1-h3` 条目可加 `data-lcl-toc-title="显示名"`、
  `data-lcl-toc-level="2"`;需要强层级样式再加空属性 `data-lcl-toc-primary`。
- 特殊 DOM 可传 `itemFromElement(element, index) → {text, level, primary?, onSelect?} | null`。
  回调抛错会被宿主隔离;不传 `onSelect` 就按元素位置在 `scrollContainer` 内平滑滚动。
- DOM 的增删和文字变化会自动重扫;只有 Shadow DOM / 第三方画布等观察不到的变化才调返回句柄的 `refresh()`。
  内容一直在变(流式输出、打字)时最多每 500ms 扫一次,安静之后的第一处变化下一帧就扫(2026-10-16 起);
  懒挂的重件(代码高亮、嵌入体)可以包在带 `data-lcl-toc-ignore` 的元素里,里面的变化不触发重扫。
  跳转落地后宿主会再量一次、差得多就补,正文用了 `content-visibility: auto` 也落得准。
  `dispose()` 幂等,同步摘掉宿主加在 `shell` 里的那层(你的正文不动);插件禁用 / 重载时宿主也会统一卸载。
- 旧宿主整个 `ctx.ui` 不存在,一律 `ctx.ui?.mountFloatingToc(...)`;缺席时可继续显示正文,不必仿一份目录。

### View modes: ctx.ui.setViewModes (2026-10-19+)

Two to four ways to look at the **same thing** (Transcript / Notes / Summary, Document / Canvas, Day / Week / Month)
are a *view mode* switch. Every view puts it in the same place: the left end of the view's 32px head row. Do not
draw your own tabs for this on new hosts — report the modes and let the host draw them:

```js
ctx.registerView({ id: 'session', title: 'Session', mount(el) {
  const memo = loadMemo()                                     // remember per thing you show (record, file) — the host stores nothing
  const modes = ctx.ui?.setViewModes?.(el, {                  // el = the element mount() received
    modes: [
      { id: 'transcript', label: '转写', labelEn: 'Transcript', icon: 'audio-lines' },
      { id: 'notes',      label: '笔记', labelEn: 'Notes',      icon: 'notebook-pen' },
      { id: 'summary',    label: '纪要', labelEn: 'Summary',    icon: 'list-checks' },
    ],
    value: memo[recordId] || 'transcript',                    // a newly opened thing starts on the first mode
    onChange: (id) => { memo[recordId] = id; saveMemo(memo); show(id) },  // click, ⌥⌘V and the command palette all land here
  })
  if (modes) modes.actions.append(targetSelect, moreButton)  // your toolbar buttons: right end of the same row
  else drawOwnTabs(el)                                         // hosts up to 2.13.4: keep your tabs
  return () => modes?.dispose()
} })
```

- The host owns ⌥⌘V (Ctrl+Alt+V) to the next mode, one "View: X" command per mode in the palette, the hover hint,
  icons only under 480px of view width (only if every mode has a known `icon`), a "Current ▾" menu under 320px,
  and the phone top bar. `modes.set(id)` moves the switch when *you* switch (it does not call `onChange`);
  `modes.update(patch)` changes labels or the mode list (call it on a locale change if you pass one language only).
- `icon` is a name from the plugin icon vocabulary (`audio-lines` / `notebook-pen` / `list-checks` were added for
  this; `layout`, `page`, `code`… work too). `labelEn` is used in the English UI; otherwise `label` is shown.
- One switch per view, 2–4 modes; fewer or more throws (more than four belongs in tabs). Calling it again on the same
  view replaces the previous switch. The host removes it on disable / reload / view close.
- Filters ("All / Mine") and source switches are not view modes: draw those in your own content, not in this slot.

### Tooltips and motion tokens: ctx.ui.attachTooltip (2026-10-23+)

Hover hints use the host's own tooltip — the one on the host's buttons, sidebar rows and Ribbon — not `title` and not
a hand-made one. It appears after 300ms; while it shows, moving to a neighbouring element that also has one hands the
same tooltip over without replaying the animation; it closes 80ms after you leave; keyboard focus (`:focus-visible`)
shows it at once without animation; pressing or scrolling hides it.

```js
const tip = ctx.ui?.attachTooltip?.(exportBtn, ['Export', 'Saves a Markdown copy'], { side: 'bottom' })  // first line = title
if (!tip) exportBtn.title = 'Export'                          // older hosts: keep title
exportBtn.setAttribute('aria-label', 'Export')               // the tooltip does not name the element
// later: tip?.update('Export again'); tip?.dispose()        // the host also disposes on disable / reload
```

- `side`: `top` (default) / `bottom` / `left` / `right`; it flips when there is no room. Drop `title` on elements
  that have a host tooltip, or two tooltips stack.
- Your own motion: use the host tokens, not literal durations — `--ease-surface` (enter), `--ease-exit` (leave,
  accelerating), `--ease-calm`, `--ease-drawer`, `--duration-instant` / `fast` / `base` / `slow` (100 / 150 / 200 / 250ms),
  `--collapse-duration` / `--collapse-ease`, `--menu-enter-duration` 180ms / `--menu-exit-duration` 80ms,
  `--tip-enter` / `--tip-exit`, `--hovercard-enter` / `--hovercard-exit`. Leaving is shorter than entering;
  interruptible states use `transition`, not `keyframes`; don't tween width / height / padding / margin (use the collapse
  below or `transform`) and don't write `transition: all`; created / restored / scrolled-in content doesn't animate in;
  under reduced motion keep colour and opacity, drop translation and scale.
- Motion the host applies for you (2026-10-25+, same page, standard markup, no keyframes or tokens needed): native
  `<details>` fades its content in / out (200ms, the collapse tokens) — opacity only, height is not tweened; native `<dialog>`
  (`showModal()`) and `popover` open like the command palette (120ms fade + 0.985 → 1 scale, backdrop fades in);
  `data-motion="enter"` on content that appears because the user just did something (a list they opened, a section
  they expanded) fades it in and lifts it 4px when it mounts (180ms). Don't put `data-motion` on what is there when the
  view opens, is restored or scrolls in. It animates the separate `translate` property, so your `transform` positioning
  is untouched. These host rules have zero specificity: your own `animation` / `transition` on the element wins; the
  host turns them off under reduced motion. Pages inside an iframe / webview don't get them.
- Collapse (2026-10-26+): `data-motion="collapse"` + `data-open="true|false"` on the outer element, content in exactly
  one inner element. The host animates `grid-template-rows` 0fr ↔ 1fr with a fade (200ms both ways, interruptible, no
  height measuring); closed content is `visibility: hidden`. A chevron with `data-motion="chevron"` + the same
  `data-open` turns 90° when open (use a right-pointing one). The inner element clips while open; add `data-settled` to
  release it. React: `import { AnimatedCollapse } from '@lcl/components'`, `<AnimatedCollapse open={open}>{open && …}
  </AnimatedCollapse>` — keeps the last content while closing, unmounts after, skips the animation on first mount, sets
  `data-settled` itself. Don't measure `scrollHeight` and tween `height`.

### Drop indicators: ctx.ui.dropIndicator (2026-10-24+)

While dragging to reorder or into something in your own view, show the host's drop indicator — the same line and
"drop into" outline as the host editor, sidebar and tab bar, in the theme's `--signal-line` — instead of drawing one.
Moving to another drop point fades the old one out where it is and the new one in (unfolding from its near end); the
same drop point moving with a scroll follows without replaying; reduced motion turns the fades off.

```js
const drop = ctx.ui?.dropIndicator?.()                       // opts.host defaults to document.body
list.addEventListener('dragover', (e) => {
  const row = e.target.closest('[data-row]'); if (!row) return
  e.preventDefault()
  const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2
  drop?.line({ x: r.left + 4, y: (after ? r.bottom : r.top) - 1.5, w: r.width - 8 }, { key: `${row.dataset.row}:${after}` })
})
list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) drop?.hide() })
list.addEventListener('drop', () => drop?.hide())
// a folder that takes the dragged item: drop?.zone({ x, y, w, h }, { key: folderId })
// later: drop?.dispose()  — the host also disposes it on disable / reload
```

- Coordinates are viewport px (clientX/Y, getBoundingClientRect); zoom and transformed ancestors are handled.
  `line({ x, y, w })` is horizontal with its top edge at `y`; `line({ x, y, h }, { axis: 'v' })` vertical.
- `key` names the drop point (row / slot id + side). Without it any coordinate change counts as a new drop point,
  so a scroll would replay the fade.
- Older hosts lack the method: keep your own line there.

**Landing after the drop (2026-10-25+, `drop.land`)**: after your drop handler has moved the row, let the host glide it
from where it was let go into its new place (160ms, decelerating, its lift shadow fading out; neighbours don't move;
reduced motion = it just appears). Record the grab point at dragstart and turn it into the release point at drop:

```js
let grab = null
list.addEventListener('dragstart', (e) => { const r = e.target.getBoundingClientRect(); grab = { x: e.clientX - r.left, y: e.clientY - r.top } })
list.addEventListener('drop', async (e) => {
  drop?.hide()
  const from = grab && { x: e.clientX - grab.x, y: e.clientY - grab.y }   // viewport top-left of the drag image
  await moveRow(id, target)                                               // your move + re-render
  if (from) drop?.land?.(() => list.querySelector(`[data-row="${id}"]`), from)
})
```

- `target` is the row element already in its new place, or a function that finds it: the host then checks on every DOM change (a MutationObserver, before paint)
  for up to ~1.2s and lands it once it is re-mounted or has a new parent / previous sibling (before it is painted there).
- Only the row's inline `transform` / `transition` / `box-shadow` are touched for the flight, then restored; disabling
  the plugin cancels pending and in-flight landings. Feature-detect `drop.land` — older hosts lack it.

### Selection bar: ctx.ui.mountSelectionBar and registerSelectionAction scopes (2026-10-13+)

The **selection bar** is the strip that appears over selected text. Chat, notes and any plugin view that opts in
show the same one: the view's own tools plus three shared actions — **Ask Tangu** (hands the text to the side chat
as a quote), **Translate** (result in a card under the selection) and **⋯** (selection actions from plugins). Which
block comes first is the user's setting (Settings → Appearance → Selection menu); do not depend on the order.

**Give your own view the bar.** Do not draw your own popup menu on new hosts.

```js
ctx.registerView({ id: 'reader', title: 'Reader', mount(el) {
  el.innerHTML = '<div class="acme-reader" style="height:100%;overflow:auto">…</div>'
  const bar = ctx.ui?.mountSelectionBar?.(el, {
    view: 'reader',                                  // selection actions see 'acme:reader' as cx.view
    tools: [                                         // your own tools: icon buttons, or colour swatches
      { id: 'yellow', title: 'Highlight', color: '#ffd400', run: (sel) => { highlight(sel.text); window.getSelection()?.removeAllRanges() } },
      { id: 'note', title: 'Add a note', icon: 'annotate', run: (sel) => openNoteEditor(sel.text) },
    ],
    source: () => ({ title: doc.title, path: doc.vaultPath, page: currentPage }),   // optional: where the text is from
    // ask: (sel) => askWithPageNumber(sel.text),    // optional: replace what "Ask Tangu" does; false removes it
  })
  if (!bar) drawOwnSelectionMenu(el)                 // hosts up to 2.13.3: keep your old menu
  return () => bar?.dispose()
} })
```

- By default the host watches the DOM selection inside the element you pass: the bar shows on mouse-up and goes
  away when the selection collapses, the content scrolls or resizes, or the user clicks elsewhere. Selections in
  `<input>` / `<textarea>` / `contenteditable` never show it.
- Content the host cannot see into (an `<iframe>`, a canvas, a PDF text layer you position yourself): pass
  `watch: false` and drive it — `bar.show({ text, rect })` with the selection's bounding box in **viewport pixels**
  (`range.getBoundingClientRect()` works as is; do not divide by zoom, the host compensates), `bar.hide()` when it
  is gone. `bar.update({ tools })` changes options on a live bar.
- A tool is `{ id, title, icon?, color?, on?, run(sel) }`. `icon` is a name from the plugin icon vocabulary
  (`highlight` / `underline` / `strikethrough` / `annotate` / `copy` / `cite` were added for this; `edit`, `pin`,
  `bookmark`, `trash`… also work); `color` draws a round swatch instead. The host only draws the button — clear
  the selection (or call `bar.hide()`) in `run` once your tool has consumed it. No dropdowns: open your own UI
  from `run` if a tool needs more.
- The bar adds nothing to your DOM and takes nothing over (it floats above the page), so it coexists with
  `mountFloatingToc` and other mounts on the same element. The host disposes it on disable / reload.
- A view that never calls `mountSelectionBar` gets no bar: the host does not sniff selections globally.

**Add an action to the bar.** `ctx.registerSelectionAction` entries are listed behind "⋯" under "Plugins".
With no `scope` they appear in notes only, exactly as before; opt into more with the new optional fields:

```js
ctx.registerSelectionAction({
  id: 'define',
  title: ctx.getLocale?.() === 'en' ? 'Define' : '查词',
  icon: 'bookmark',
  scope: 'all',                                      // 'note' (default) | 'all' | 'own' | ['chat', 'acme:reader']
  when: (cx) => cx.length <= 40,                     // { view, editable, length } — not the text itself
  run: async (cx) => (await lookUp(cx.text, { signal: cx.signal })).markdown,
})
```

| `scope` | Listed in |
|---|---|
| omitted / `'note'` | v4 notes only |
| `'all'` | every view that shows the bar: notes, chat, plugin views that mounted one |
| `'own'` | only this plugin's own views (those that called `mountSelectionBar`) |
| `['chat', 'acme:reader']` | the named views. `'note'`, `'chat'` (main chat, side chat, Mini) or `'<pluginId>:<view>'`; a bare `'<pluginId>'` matches all of that plugin's views |

- `when` runs every time the bar opens: keep it synchronous and cheap. It gets the view, whether the selection
  can be replaced and its length — the text only reaches you in `run`, after the user picked your action. A throw
  or a non-true return leaves the action out; when nothing is listed the "⋯" button is not drawn.
- `run(cx)`: `cx.text`, `cx.markdown` (equals `text` outside notes), `cx.view`, `cx.editable`, `cx.source`
  (`{ title?, path?, sessionId?, page? }` when the view knows), `cx.signal` (aborted when the card closes),
  `cx.onDelta(chunk)` to stream into the card. **`cx.pagePath` is only set in notes** — an action that opted into
  other views must not assume it.
- The returned markdown goes to the host's result card. In an editable note the card offers Replace / Insert
  below / Copy / Discard and nothing is written until the user confirms; everywhere else the card is read-only
  (Copy / Close). You cannot bypass the card to write into a note.
- `output: 'none'`: you handle the result yourself (open a view, save a clipping) — the host shows no card and
  ignores the return value. Report failures yourself or throw: the host shows a toast with the error message.
- Hosts up to 2.13.3 ignore the new fields: the action stays note-only, sits under "AI ▾ → Plugins", and `cx`
  has only `text` / `markdown` / `pagePath`. Write `run` so it works with just those.

### Settings parts: ctx.ui.mountSettingsPage / mountSettingsItem (2026-10-17+)

For any settings-like page (account, quota, diagnostics, preferences — inside `registerSettingsView`, `registerStoreView` or your own view) describe the page as data and let the host draw it with its own settings parts. Do **not** copy the host's `.settings-*` CSS into your plugin: the copy breaks on phones (blank gaps, controls pushed off the row) and never follows later host changes.

```js
const zh = ctx.getLocale?.() === 'zh'
const page = ctx.ui?.mountSettingsPage?.(el, { groups: [
  { id: 'quota', icon: 'gauge', title: zh ? 'AI 额度' : 'AI quota', desc: zh ? '今日和本周' : 'Today and this week',
    actions: [{ label: zh ? '充值' : 'Top up', kind: 'primary', onClick: () => openTopUp() }],
    items: [
      { type: 'meters', id: 'm', meters: [{ label: zh ? '今日' : 'Today', value: 0.69, caption: zh ? '每天 0:00 重置' : 'Resets daily' }] },
      { type: 'switch', id: 'fallback', title: zh ? '用完后继续' : 'Continue when used up', value: state.fallback,
        onChange: async (on) => { await save({ fallback: on }) } },            // reject → the switch flips back
      { type: 'choice', id: 'convert', title: zh ? '转入' : 'Convert', button: zh ? '转入…' : 'Convert…',
        options: [{ value: '5', label: '5%' }, { value: '10', label: '10%' }], onPick: (v) => convert(v) },
      { type: 'input', id: 'code', title: zh ? '兑换码' : 'Redeem code', placeholder: 'XXXX',
        button: { label: zh ? '兑换' : 'Redeem', onClick: (text) => redeem(text) } },
    ] },
] })
if (!page) drawOwnPage(el)            // hosts before 2026-10-17: keep your own page for one release
return () => page?.dispose()
```

- Item types: `switch`, `value` (read-only figure), `button` (`buttons: [...]`; `kind` primary / ghost / danger; optional `confirm: { title, message, confirmLabel, danger }`), `input` (+ optional `button` that receives the text), `segmented` (a setting with a few options), `select`, `choice` (picking **runs** something: a row of buttons on desktop, one button labeled `button` + a half sheet on phones), `stepper` (+ optional `button` that receives the number), `code` (code + copy button), `meters` (fractions 0–1, filled with the host action color), `state` (`empty` / `loading` / `error` with an optional retry `action`), and `custom` (`mount(el)` returns a cleanup; mount parts into it with `ctx.ui.mountSettingsItem`). A page-level `{ state }` replaces the groups (loading / signed out / failed).
- Every group and item needs a stable `id`. `update(schema)` replaces the whole description; rows keep their identity by id.
- Values: a defined `value` you pass is applied on every `update()`. Leave an `input` / `stepper` `value` out to keep what the user typed; pass `value: ''` to clear it. Callbacks may return a promise: buttons stay disabled until it settles; a rejected switch / segmented / select flips back.
- No colors, no text from the host: every label comes from you (both languages). `icon` takes vocabulary names; settings pages gained `bell`, `gauge`, `coins`, `clock`, `gift`, `user`, `shield`, `package`, `activity`, `message`, `plug`, `list-checks`.
- Layout is the host's: in a narrow pane switches, values, codes and single buttons stay at the right of the title; inputs, selects, steppers and two or more buttons move under it and fill the row; touch targets grow to 36 px on phones. Hosts before the round-8 fix decide this by **window** width (≤820 px), so in a 280 px right panel of a wide window the title is squeezed to one character per line — test your page in a narrow side panel. On Android the choice sheet is native; on the mobile web it is the host's sheet.
- Settings parts are rows (56 px with padding). Don't put them in a toolbar or a view head — use `ctx.ui.mountControl` there (next section). Their schema stays plain strings (it crosses to the native half-sheet): call `update(schema)` from `ctx.subscribeLocale` to follow a language switch.
- Lifecycle: same mount protocol as the other `ctx.ui.mount*` (element returned to you after `dispose()`, one mount per element, host disposes on disable / reload, callbacks stop after that). Malformed calls throw `TypeError` synchronously.

### Host parts: dialogs, toolbar controls, menus, popovers, empty states, icons, view head, i18n (2026-10-26+)

The host draws these for you so a plugin looks native without copying host CSS, hand-placing overlays or freezing strings. All of them are feature-detected (`ctx.ui?.confirm`, …), stop calling you after disable / reload, are cleaned up by the host on disable / reload, and throw `TypeError` synchronously on malformed input. Text fields take **PluginText**: a string, `() => string` (evaluated whenever the host draws) or `{ zh, en }` — the last two follow a language switch at once.

```js
const t = ctx.i18n.define({ zh: { title: '清单', newItem: '新建条目', del: '删除', delQ: '删除全部条目?' },
                            en: { title: 'Items', newItem: 'New item', del: 'Delete', delQ: 'Delete all items?' } })
const T = (k) => () => t(k)                               // a PluginText that follows the language
ctx.addStyle(`.my-card { border-radius: var(--radius-md); background: var(--bg-card); }`)   // removed on disable / reload

ctx.registerListSource({ id: 'items', title: T('title'), /* … */
  empty: { icon: 'list-checks', title: T('empty'), line: T('emptyLine'), action: { label: T('newItem'), icon: 'plus', run: add } },
  actions: [{ id: 'new', label: T('newItem'), icon: 'plus', primary: true, run: add }] })

ctx.registerView({ id: 'main', title: { zh: '清单', en: 'Items' }, mount(el) {
  const head = ctx.ui.setViewHead(el, { title: T('title') })           // the 32 px head row, title left, buttons right
  const body = el.appendChild(document.createElement('div'))
  const seg = document.createElement('span'), sort = document.createElement('span')
  ctx.ui.mountControl(seg, { type: 'segmented', value: 'all', onChange: setFilter,
    options: [{ value: 'all', label: T('all') }, { value: 'open', label: T('open') }] })
  ctx.ui.mountControl(sort, { type: 'select', value: 'new', label: T('sort'), onChange: setSort,
    options: [{ value: 'new', label: T('newest') }, { value: 'name', label: T('name') }] })
  const more = document.createElement('button')
  more.append(ctx.ui.icon('more', { size: 16 }))
  more.onclick = () => ctx.ui.contextMenu({ anchor: more, align: 'end' }, [
    { section: T('item') },
    { label: T('rename'), icon: 'pencil', shortcut: 'F2', run: rename },
    { separator: true },
    { label: T('del'), icon: 'trash-2', danger: true, run: async () => {
      if (await ctx.ui.confirm({ title: T('delQ'), danger: true })) removeAll() } },
  ])
  head.actions.append(seg, sort, more)
  // empty main area: the same empty state as the list source's
  const empty = ctx.ui.mountEmptyState(body, { icon: 'list-checks', title: T('empty'), line: T('emptyLine'),
    action: { label: T('newItem'), icon: 'plus', run: add } })
  return () => { empty.dispose(); head.dispose() }
} })
```

- **Dialogs.** `ctx.ui.confirm({ title, body?, ok?, cancel?, danger? })` → `Promise<boolean>` (true only for the main button; Escape, the backdrop, Cancel and plugin disable are false). `ctx.ui.openDialog({ title, body?, mount?(el), actions?, width?: 'sm' | 'md', onClose? })` → `{ update, close, dispose }`: 420 / 560 px, centered, the host's card surface and buttons (main one rightmost; `danger` + `primary` = red). Enter presses the main button (not from a textarea / another button / IME composition); focus starts on it, or on Cancel for `danger`. An action's `run` may return `false` (or a promise of it) to keep the dialog open; no `run` = just close. `mount(el)` returns a cleanup that runs when the dialog closes. On Android `confirm` is the native confirm sheet. Replaces `window.confirm` and hand-made `<dialog>`s (if you still use your own `<dialog>`: append it to `document.body`, and on hosts before the round-8 fix set `margin: auto` yourself or it opens in the top-left corner).
- **Toolbar controls.** `ctx.ui.mountControl(el, { type: 'segmented' | 'select', size?: 'toolbar', value, options: [{ value, label, icon? }], onChange, label?, disabled? })` → `{ update, dispose }`. Segmented = the same pill as view modes (2–5 options, 24 px). Select = a 28 px text button + ▾ without a border; it opens a listbox in the menu shell (current option ticked in `--accent-ink`, ↑↓ / Home / End / Enter / Escape, a search field from 6 options on); Android opens the native sheet. Picking moves the control at once and then calls `onChange`; `update({ value })` sets it from your side. Settings parts are not for toolbars.
- **Menus.** `ctx.ui.contextMenu(x, y, entries, opts?)` or `ctx.ui.contextMenu({ anchor, align?: 'start' | 'end', side?: 'bottom' | 'top' }, entries, opts?)`. Entries: rows `{ label, run, icon?, shortcut?, checked?, disabled?, danger? }`, `{ separator: true }`, `{ section: 'Heading' }`. Icons are 13 px and muted; once any row has one, rows without keep the gap. Leading / trailing / doubled separators and headings with no rows under them are dropped. `opts.onClose` runs once however it closed; clicking the anchor again closes it. Android shows the same entries as the native bottom sheet (sections become its groups; `keepOpen` / `update` don't apply there). Before 2026-10-26 the host dropped every field but label / run / checked / disabled / danger, and took only (x, y).
- **Popovers.** `ctx.ui.popover(anchor, { mount(el), side?, align?, label?, onClose? })` → `{ update, dispose }`: the host's `.ui-popover` surface (same material as menus, including the Glass theme), placed under / above the anchor, kept on screen, UI zoom handled, Escape / click outside / window blur close it, one open at a time. `update()` re-measures the anchor. Don't position overlays yourself: `OverlayAt` / `clampMenu` are host internals a plugin can't import.
- **Icons.** One vocabulary (`PluginIconName` in the types) for Spaces (`space.json` `icon`), list rows and actions, menus, settings groups, view tabs, view modes, toolbar controls, empty states and `ctx.ui.icon(name, { size })`, which returns a fresh `<svg>` in `currentColor`. It now includes the Space names (`bot`, `inbox`, `book-open`, `calendar-days`, `file-text`, `folder-open`, `layout-grid`, `sparkles`, `boxes`, `list-todo`, `server`, …) and `pencil`, `trash-2`, `download`, `upload`, `search`, `check`, `x`, `settings`, `external-link`. An unknown name falls back where it is used and is reported once per plugin in the console (`[my-plugin] unknown icon "list-check" (did you mean list-checks?)`). Before 2026-10-26 `space.json` only knew 30 names of its own and fell back to a stack of boxes silently.
- **Empty states.** `ListSourceContribution.empty = { icon?, title, line?, action?: { label, icon?, run } }`: on a desktop the sidebar then writes nothing while one of your Spaces is open (your main view explains it — draw the same with `ctx.ui.mountEmptyState(el, { icon?, title, line?, action?, secondary?: { label, run } })`); on a phone, where the list is the whole page, the host draws this empty state in the list. Without it the sidebar says "Nothing here yet". Don't borrow the host's `.empty-state` class names: they only look right when some host view happened to load that CSS first.
- **Web page card (2026-10-28+).** `ctx.ui.mountWebCard(el, { name, status?: { label, tone?: 'neutral' | 'ok' | 'muted' | 'danger', dot?: 'running' | 'stopped' | 'failed' }, address?: { text, icon?: 'globe' | 'file', struck?, muted? }, note?, thumbnail?: { url, version? } | null, placeholderIcon?, actions?, trailing?, menu?, layout?: 'card' | 'row' })` → `{ update, dispose }`: the body the host draws for HTML files and local servers in chat (thumbnail, name with a status pill, one address line, one note line, buttons left and right, a ⋯ menu). Buttons are `{ label, icon?, variant?: 'primary' | 'danger', disabled?, run }` (at most 6 per side); `menu` takes `contextMenu` entries. The host captures `thumbnail.url` (http(s) only) in a hidden window and caches it by `url` + `version` — change `version` when the page changes; without a picture it draws `placeholderIcon`. `layout: 'row'` is one list row (small thumbnail, two lines, ⋯; no note or buttons). `update(patch)` merges: a key you pass with `undefined`, `[]` or `null` clears it (drop the ⋯ with `menu: undefined`). Use it inside a tool result card, a view or a list rather than copying its look.
  ```js
  const card = ctx.ui.mountWebCard?.(body, {
    name: page.name, status: { label: T('live'), tone: 'ok' }, address: { text: page.url },
    thumbnail: { url: page.url, version: page.updatedAt },
    actions: [{ label: T('open'), icon: 'external-link', run: () => open(page.url) }],
    menu: [{ label: T('takeDown'), icon: 'trash-2', danger: true, run: takeDown }],
  })
  ```
- **View head.** `ctx.ui.setViewHead(el, { title?, actions? })` → `{ update, actions, dispose }`: the same 32 px row `setViewModes` draws, without needing view modes. Title left (after the mode switch if any), your buttons right (`handle.actions` or `actions: [el, …]`). Both can be used together; the switch comes first.
- **Styles.** `ctx.addStyle(css)` → `{ update(css), dispose }` instead of `document.head.append(style)`: removed on disable / reload.
- **Messages.** `ctx.i18n.define({ zh, en })` → `t(key, vars)`: current language → Chinese → the key (the host's chain), `{name}` placeholders from `vars`; keys present in `zh` but missing in `en` are reported once. Pass `() => t('key')` wherever a PluginText is taken; read `t()` in your own drawing code and redraw from `ctx.subscribeLocale`. Before 2026-10-26 list-source titles, action names and view titles took strings only, frozen at registration.
- **React / Vue plugins: `ctx.ui.mount(name, el, props)`** → `{ update(patch), dispose() }` for `'menu' | 'popover' | 'dialog' | 'segmented' | 'select' | 'emptyState' | 'webCard' | 'icon'`, with props typed by `PluginUiParts`. Mount on a ref and dispose in the effect cleanup:

  ```tsx
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => { const h = ctx.ui.mount('select', ref.current!, { value, options, onChange }); return () => h.dispose() }, [])
  ```

  `'menu'` / `'popover'` open anchored at `el` (or `props.anchor`) while mounted; `'dialog'` ignores `el`. Plugins never get the host's React components (a second React can't share the host's instance): don't bundle copies of the host's menus, overlays, dialogs, icons or i18n — they freeze at the day you copied them and miss later fixes (exit motion, materials, edge clamping).

### 白板层 ctx.ui.mountBoard / ctx.ui.boardToSvg(2026-10-10 起)

要在自己的内容上**手写 / 圈画**(PDF 页、图片、时间轴)时,不要自己做笔迹:`ctx.ui.mountBoard(el, opts)` 把宿主的白板引擎
(和 `.excalidraw.md` 白板同一个,同样的七支笔与笔触)挂成一块**透明、没有工具栏**的层,盖在你的内容上。
画出来的就是白板元素 —— 原样(JSON)存、原样交回,能和真白板互相粘贴。

```js
if (ctx.ui?.mountBoard) {                                  // 老宿主没有:不出「手写」入口,别仿一个
  const board = ctx.ui.mountBoard(layerEl, {
    scene: { elements: saved },                            // 上次存的元素,原样交回
    viewport: { scrollX, scrollY, zoom },                  // 画布上的点落在 (点 + scroll) × zoom 处(相对 layerEl 左上角,CSS 像素)
    tool: 'freedraw', pen: 'fountain', theme: 'light',     // 底下的内容深色模式也是浅色的(PDF 页)就钉 'light',否则引擎会给笔迹反色
    onChange: (scene) => saveSoon(scene.elements),         // 落笔途中每帧都来 → 自己攒一下再存
    onWheel: (ev) => scroller.scrollBy(ev.deltaX, ev.deltaY), // 这层吃指针、不吃滚轮:滚轮 / 捏合原样交给你
  })
  scroller.addEventListener('scroll', () => board.update({ viewport: currentViewport() }))
  // board.update({ tool: 'eraser' }) / board.update({ pen, strokeColor, strokeWidth }) / board.undo() / board.redo()
  // 视图卸载、或退出手写:board.dispose()
}
```

- **视口归你。** 这层自己不滚不缩:你的滚动容器、缩放控件变了就 `update({ viewport })`;引擎自己挪了视口会被拉回你给的值。
- **界面缩放宿主替你抵消了。** 用户把界面调到 110% 之类(⌘+)时,`viewport` 仍按 `el` 自己的 CSS 像素给;你自己从 `getBoundingClientRect()` 换算视口时要除以 `el.currentCSSZoom`(矩形是缩放后的,`offsetWidth` 这类不是)。
- **坐标系归你。** 元素的 `x` / `y` 是画布坐标。想让笔迹跟着内容走(换缩放、换窗口宽度都不偏),存之前换成你内容自己的坐标(PDF 用页内 pt),挂载时再换回来;只平移 `x` / `y` 即可,别动 `points`。
- `tool`:`selection` `freedraw` `eraser` `text` `rectangle` `ellipse` `arrow` `line`;`pen`(仅 `freedraw`):`default` `finetip` `fountain` `marker` `highlighter` `thick-thin` `thin-thick-thin`。`strokeColor` / `strokeWidth`(引擎线宽 0.5 / 1 / 2 / 4)覆盖这支笔自带的。
- `onChange` 只在**元素**变了时来(画完一笔、擦掉、撤销),视口变化和你自己 `update({ scene })` 推进去的不算。`getScene()` 不含已删除的元素。
- `update({ scene })` 是「从盘上重载」:整份替换、不进撤销栈。
- 不接管全局快捷键:撤销 / 重做由你接按键(或放按钮)再调 `undo()` / `redo()`。
- `dispose()` 幂等,之后 `el` 立刻归还(见上「dispose 契约」);插件禁用 / 重载时宿主统一卸载。**退出手写前先 `getScene()` 存一次。**
- 参数不对(没给 `scene.elements` / `viewport` 不是三个有限数且 `zoom > 0`)同步抛 `TypeError`。

**不在手写时怎么显示笔迹**:`await ctx.ui.boardToSvg({ elements }, { theme: 'light', padding: 4 })` → `{ svg, x, y, width, height } | null`(空场景是 `null`)。
`x` / `y` / `width` / `height` 是这幅画在画布坐标里的包围盒(含 `padding`):把 `svg` 放在 `(x + scrollX) × zoom`、宽 `width × zoom`,就和白板层里的位置重合。
荧光笔要和底下的内容「正片叠底」才不盖字:给白板层的容器和静态 SVG 都加 `mix-blend-mode: multiply`,并保证它们到内容之间没有新的层叠上下文。

参考实现:`forsion-plugin-pdf-reader` 的 `src/ink.ts`(整份文档一张连续画布、按页拆存、静态图与导出)。
仪器:宿主 `frontend/src/amadeus/plugins/boardSurface.test.ts` / `boardCtx.test.ts`;真 Electron 见 PDF 阅读器插件仓的 `npm run verify`。

### 仪表盘 ctx.dashboard(2026-09-01 起)

插件能拿到**真的** Dashboard(dashboard3 网格 / 卡片 / 排版台,不是自己画的仿制品)。
**两条路线,按「要不要住进笔记库」分**:`ctx.dashboard.mount(el, opts)` 渲在插件自己的容器里、**不依赖笔记库**;
`ctx.dashboard.source(recipe, opts)` 把配方编译成真 `.dashboard.md` 字节、**需要已打开的笔记库**。

```js
// 路线 A —— 在插件自己的视图容器里渲染,**不依赖笔记库**(库开没开、有没有库都能用)
ctx.registerView?.({ id: 'overview', title: '总览', mount(el) {
  return ctx.dashboard?.mount?.(el, {
    recipe,                                   // 配方见下
    layoutText: saved,                        // 上次存下的整页文本;首次传 null
    onLayout: (text) => ctx.saveData?.({ layout: text }),   // 用户在排版台手排后交出整页文本
    locked: true,                             // true=成品页(只看);false=排版台(可拖可改)
  })                                          // 返回卸载函数 —— 正好当 mount 的 disposer(调用后 el 立刻归还,见「dispose 契约」)
}})

// 路线 B —— 编译成一份真 `.dashboard.md` 字节,落进库、用原生 tab 打开(**需要已打开的笔记库**)
const r = ctx.dashboard?.source(recipe, { existingFileText })   // {ok:true,text} | {ok:false,error}
if (r?.ok) {
  const p = `${ctx.app.workFolder()}/总览.dashboard.md`
  await ctx.app.writeFile(p, r.text)          // ⚠️无库会 reject,见上表
  ctx.app.openFile?.(p)                       // amadeusNav 把 .dashboard.md 路由到原生 Dashboard tab
}
```

**配方(`recipe`)的卡片只有四种**:

| kind | 字段 | 说明 |
|---|---|---|
| `stat` | `id / label / value / unit?` | 数字卡。`value` 是**字面值**(插件自己算好的字符串),不是查询表达式 |
| `section` | `id / label` | 分节标题 |
| `text` | `id / md` | 一段 markdown |
| `view` | `id / type / params?` | 嵌一个视图 |

- ⚠️**卡 `id` 是跨次稳定契约**:手排布局按卡 id 保留。id 变了 = 那张卡的位置/尺寸丢失,用户白排一次。
  别拿数组下标或本地化字符串当 id。
- 路线 B 再生成时**把现有文件字节传 `existingFileText`**:用户手排的布局(`dashboard3`/`dashboard3x`)与页面筛选会存活;
  读不懂的现有布局会**拒编译**(`ok:false`)—— 宿主绝不拿默认值覆盖用户布局,所以 `ok:false` 要如实报给用户,别静默重写。
- 围栏格式与 frontmatter 词表**留在宿主**(格式无版本契约,手抄 = 将来破兼容)—— 只出配方,别自己拼 `.dashboard.md` 文本。
- 旧宿主没有,两条都要可选链:`ctx.dashboard?.mount?.(…)` / `ctx.dashboard?.source(…)`,并备一条降级 UI。

### 原生多维表 ctx.table.mount(2026-09-05 起)

面板里的表格不用再手搓 `<table>`:给**一份规格**,宿主用真的多维表渲(筛选 / 搜索 / 隐藏列 / 排序 / 统计
一样不少),**不依赖笔记库** —— 与 `ctx.dashboard.mount` 同一路线(远程系统面板也能用)。
表是**只读**的:没有加行 / 加列 / 删行,单元格也编辑不了。

```js
const spec = {
  id: 'models',                                   // 槽位键:同 id 再来 = 更新,不是重挂
  columns: [
    { key: 'name',  label: '模型', kind: 'text', width: 200 },
    { key: 'calls', label: '调用', kind: 'number' },
    { key: 'state', label: '状态', kind: 'select', options: [{ value: 'on', label: '启用', color: 'green' }] },
  ],
  rows: models.map((m) => ({
    id: m.id,
    attrs: { 'data-id': m.id },                   // 落到行元素上,既有的事件委托照常收得到
    cells: {
      name:  { text: m.name, sub: m.slug, avatar: { src: m.icon, letter: m.name[0] } },
      calls: { text: '58.5 万', sortValue: 585000 },   // 显示归 text,排序归 sortValue
      state: m.enabled ? 'on' : 'off',
    },
  })),
  actionsLabel: '操作',
  actions: (row) => [{ act: 'm-edit', label: '编辑', attrs: { 'data-id': row.id } }],  // 真 <button data-act>
  empty: '还没有模型',
  onRowOpen: (row) => openDetail(row.id),         // 行点击 / Enter(点在按钮、链接上时不触发)
  onSort: (s) => { state.sort = s },              // 用户改了排序 → 面板自己记一份
}

const h = ctx.table.mount(el, spec)               // 同步返回 { update, dispose }
refresh = (rows) => h.update({ ...spec, rows })   // 数据刷新走 update:排序/筛选/列宽存活
// 视图卸载时 h.dispose()(幂等,之后 el 立刻归还;插件禁用时宿主也会统一卸掉)
```

- **数据刷新一律 `update(spec)`,不要 dispose 了重挂** —— 用户当前的排序 / 筛选 / 隐藏列 / 列宽住在表自己的
  状态里,重挂就全没了(面板每次重绘都清一次 = 用户没法用)。
- **单元格里不许出现 HTML 字符串**:`text` 只收字符串/数字,装饰走 `sub` / `tone` / `dot` / `mono` / `title` /
  `avatar` / `href` 这些字段。规格非法(没列 / 行缺 id / `text` 不是基元)**当场同步抛**。
- `sortValue` 是给复合文案用的:显示 `58.5 万`、排序按 `585000`。不给就按字面排(「585000 < 9」那种)。
- `onRender(root)` 是**只读**回调(挂懒加载观察器一类):表是宿主的 React 树,**往里塞/删节点会在下一次
  `update()` 的对账里被抹掉**。头像懒加载的正确姿势是「拿到 src → 改规格 → `update()`」。
- `sort` 只吃首份规格;之后用户在表头改的排序归表自己记,`update()` 不冲掉它(所以要在 `onSort` 里同步面板状态)。
- 列的 `align` / `nowrap` 只有降级路径认(原生表有自己的列宽 / 对齐语汇);`row.className` 两条路径都认(原生路径并进行的 className)。
- 行只是分页 / 截断的一片(服务端分页、按页切)就标 `partial: true`:原生表整条工具栏(筛选 / 搜索 / 导出 / 视图设置)不给 —— 它们只会看到本页并给出错误的数据视图;表头排序照留(本页内)。
- 规格里的 `attrs`(行 / 格 / 头像 / 动作)只放行 `data-*` / `aria-*` / `title` / `id` / `role` / `tabindex` / `lang` / `dir` / `hidden` / `class`;`on*` / `style` / `src` / `href` 一律丢弃,`data-act` / `type` / `disabled` 这类固定属性不可被 attrs 覆盖。
- **规则行折叠 `fold`(2026-09-21 起,先查 `ctx.table.caps?.fold`)**:`fold: { by: ['user'], time: 'at', minutes: 30 }` =
  `by` 各列值全等、且 `time` 列落在同一个 30 分钟**本地时钟**窗口(:00 / :30)的行收成一条**汇总行**,点开展开成员行
  (`by` / `time` 至少给一个;`minutes` 缺省 30)。通用汇总:数字求和、日期画「最早 – 最晚」、其余列出包含的值与次数;
  想自己定某几列的汇总格就给 `fold.summary = (rows) => ({ cost: { text: '-2.62', tone: 'amber' } })`(`text` 原样显示,
  没给的列走通用汇总;回调在渲染期被调,别做重活)。表头排序作用在**汇总值**上。`update()` 里改了 `fold` 会立即重折
  (与 `sort` 相反:折叠规则跟宿主走,面板的时间窗控件靠它)。`partial` 的表要**按折叠单元分页**、把整单元的成员行一起给,
  否则一个单元会被页边切成两半。宿主不认 `fold`(没有 `caps.fold`)时字段被静默忽略 = 成员行平铺。
- 旧宿主没有:`if (ctx.table && ctx.table.mount) { … } else { 画自己的经典表格 }`。整个 `ctx.table` 会**不存在**
  (不是空壳),抛出来的错也当「宿主不收」处理 —— 两种情况都走降级 UI。
