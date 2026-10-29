---
title: Reusable UI components
description: Reuse the Chat Box in Views and plugins, with clear ownership of drafts, model choice and submission.
---
# Reusable UI components

A Space organizes the layout, a View is a feature surface that can be opened on its own, and a UI component is a composable part inside a View. Amadeus document Blocks and dashboard Cards are not used as component names here. For the engineering layers and maintenance rules, see [LCL](../../lcl/README.md).

The Chat Box's card surface, input, action bar and submit button are maintained in `@lcl/components`. Chat and Home connect session behaviour through `Composer2`; Coding's new-project box connects the model catalog through `components/chatbox` and passes the chosen model and thinking level on once the project is created. Project details and Forsion capability selection are host slots. The aside panel also uses `components/chatbox`; its optional `leadingControls` slot puts the attach "+" before the model pill. This slot is for built-in hosts only: a plugin's `ctx.ui.mountChatBox` still has no attachments.

## Using it in plugins

`ctx.ui?.mountChatBox` mounts into your plugin's own View and needs no React. It currently supports text input, model selection, thinking level and keyboard submission. Attachments, commands, approvals and run controls belong to the session orchestrator; behaviour that isn't wired up is not shown.

For the whole "new chat" composer (the Home one: attachments, mode, project bar, run location, voice, calls), use `ctx.tangu?.mountComposer`. The host component is `NewChatComposer` in `desktop/frontend/src/views/newChatComposer.tsx`; the built-in Home and plugin mounts use the same one, and sending always has the host create the session and switch to Tangu.

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

Canonical types: `desktop/shared/chatBox.ts`.

| API | Contract |
| --- | --- |
| `value`, `modelId`, `thinkingLevel` | Initial draft; change parts of it with handle.update. Without a model, the host default is used; `agentSlug` can supply that Agent's initial default. |
| `label`, `placeholder`, `submitLabel`, `disabled` | Display and enabled state; the plugin provides both languages. update doesn't remount or lose input. |
| `submitOn` | Defaults to `modifier-enter` (⌘/Ctrl+Enter); can be set to `enter`. Shift+Enter adds a line, and IME confirmation never submits. |
| `onChange(draft)` | Returns `{ text, modelId, thinkingLevel }` when the text or model selection changes. Notifies only this component's host. |
| `onSubmit(draft)` | Return true to clear the submitted text; false or an exception keeps the draft. Repeat submissions are blocked while pending; an exception shows a retryable error. |
| `update(patch)`, `focus()`, `dispose()` | Update, focus, idempotent unmount. Async callbacks after unmount no longer touch the UI; the host cleans up on plugin disable, reload or setup failure. |

The model catalog is shared with chat: the main model list shows only LLMs, follows the user's sorting and hiding settings, and adds no brand restrictions. The selection stays in this component and changes neither the global default nor the current conversation. The submit callback receives the choices made for that submission; your plugin must pass them into its own flow rather than showing a choice and discarding it. Mounting and editing never send a model request or create a session. Feature-detect on older hosts; don't copy internal CSS to fake support.

## Android host presentation

On Android, the shared `ModelPill` can use a Kotlin / Jetpack Compose half-sheet picker through the `modelPickerHost` interface.
Plugins keep calling `ctx.ui.mountChatBox`; they don't create native Views or access Capacitor.
The host passes the model catalog, the selected value, bilingual labels and the theme to the native layer, and updates the input's model and thinking level atomically only after the user taps Done.
Cancelling and unmounting write nothing back; when the host is unavailable the web menu remains. Pickers a plugin draws itself don't get this capability automatically.

General sheets and the top bar work the same way: `presentNativeMenu` / `presentNativePrompt` / `presentNativeConfirm` from `@lcl/engine`
show menus, prompts and confirmations as Compose half-sheets on Android; on other platforms they return `{ handled: false }` and the caller renders its web UI.
The shared primitives are already wired: `ContextMenu`, `askString` and `ConfirmDialog` without children use the native sheet on Android automatically, so plugins built on these primitives get it.
The shell pushes the top bar through `setNativeChromeShell`; full-screen layers hide it temporarily with `useNativeChromeClaim({ mode: 'hidden' })`,
and pages with their own back semantics (such as Settings) use `mode: 'page'`.

```js
{ mode: 'page', title, back, onBack, close?, onClose? }
```

On Android, Space switching is a native bottom navigation bar (the host declares `spaces: true`): Spaces registered by plugins appear in it automatically with the icon from `SpaceDefinition.icon`, with no extra wiring.
A Space with a left sidebar has two-level navigation on Android: you land on the sidebar (a full-screen list), tapping an item opens the main area, and Back returns to the list. A Space whose sidebar isn't that kind of list sets `listFirst: false` in its definition; the main area is then the first level and the sidebar stays a drawer.
A view can add two things to this native top bar: `useNativeChromeExtras` — a search button in the right capsule and a second part of the title (tappable when `run` is given). Without a declaration there is neither, and only the current level's declaration applies.

```js
useNativeChromeExtras({ where: 'list' | 'main', search?: { label, run }, title?: { sub, run? } })
```

To know whether it is currently shown full-screen as the "list level" (so it can switch to a phone arrangement: one primary button, swipe actions), a view uses `useListFirst()`; without a native host it is always `false`. The built-in phone list parts (category capsules, swipeable rows, primary button, pull-down search) live in the app-level `components/phoneList` and are not open to plugins yet.
For a custom menu that should also support the native sheet, write its items once as a `SheetMenu` (labels + `run` callbacks), shared by the web render and the native sheet:
use `openNativeSheetMenu(build, { onFallback })` for click-triggered menus and `useNativeSheetMenu(open, build, onClose)` for state-driven ones (right-click / long-press).
Besides the ribbon's bottom items, the phone "⋯" menu lists commands that declare `Command.moreGroup = { id, title }` (one section per group, titled `title`);
commands an external plugin registers through `ctx.registerCommand` are placed there automatically, one section per plugin (titled with the plugin name), with no plugin code changes. The app market's full-screen page uses `page` mode, like Settings.

This interface only changes how interactions are presented; it doesn't change plugin installation, DOM Views or the editor extension mechanism.
Support for loading external plugins on mobile needs to be confirmed separately; see [Android pilot and acceptance](../../mobile/README.md).

## The Amadeus editor for API-backed documents

`ctx.ui?.mountMarkdownEditor` mounts the native Amadeus / Milkdown editor with visual editing, Markdown source and a publishing preview. The caller owns and saves the document entirely: the editor doesn't read or write the active vault, doesn't modify the current note and never calls a model on its own. The syntax follows CommonMark, GFM, CJK emphasis, `![[video link]]` and Obsidian callouts; a folded callout is written `> [!note]- Title`.

```js
ctx.ui?.mountMarkdownEditor(el, { value, label, readOnly, modes, onChange })
```

`modes: false` (since 2026-10-12) draws no row of "Amadeus editor / Markdown source / Preview" buttons and keeps the visual editor only. Use it when the editor sits inside your own card, cell or form field; by default all three modes are available. `update({ modes })` turns the row off or on at any time; turning it off while the source or preview is showing returns to the visual editor. Hosts up to 2.13.2 ignore the field and always draw the row: to support them, hide that row in your own stylesheet as a fallback and select no other host node.

```css
.your-box .amx-publishing-editor > div:has(> button[aria-pressed]) { display: none !important }
```

`handle.getValue()` synchronously reads the latest transaction; call it immediately before saving. `update({value})` switches documents, `insertMarkdown(text)` appends uploaded attachments or embeds, `focus()` focuses and `dispose()` cleans up idempotently. Plugin disable/reload and main-view teardown also take the mount back, and old handles can no longer change the content. On older hosts without this API, ask the user to update explicitly; don't fake a native editor. There is no autosave, and the editor and publishing renderer share the same Amadeus Markdown semantics.

### Plugin Chat Box selection and Director hand-off (2026-09-30)

When `ctx.tangu.chatSelection === true`, `startChat` accepts optional `modelId` and `thinkingLevel` from the native `ctx.ui.mountChatBox` submission. The host validates the live model catalog and supported thinking levels before changing the UI, then applies the explicit selection after Agent defaults, before prefill/send. Unrecognised selections return `ok:false`; keep the draft for retry. Older hosts omit the capability: retain a plain prompt adapter instead of showing a model picker whose selection cannot be honoured. Bundle ownership, vault-relative `folder`, plugin liveness and send gating remain unchanged.

The editor accepts `previewBaseUrl` to resolve relative public media when mounted in a desktop or cross-origin admin host.

### Native chat inside a plugin view (2026-10-04)

`ctx.tangu?.mountChat` mounts the host's native chat (composer, model and effort pickers, message stream, tool rows, approvals) inside a plugin view, pinned to one session. One session per (plugin, `folder`): the host remembers it on this device, reattaches on the next mount, and starts a new one after the user deletes or archives it. `folder` is vault-relative; once the backend is ready the host resolves and clamps it inside the vault as the session's working folder, so files the Agent generates land there. A `folder` that cannot be resolved to a local path makes `ready` fail instead of silently falling back to a sandboxed chat (omit `folder` for a sandboxed chat). The host never sends on the user's behalf: the handle offers `ready`, `quote(text)` (shown as the quote strip above the composer), `prefill(text)` (appended to the composer draft; the user presses Enter) and `dispose()`. Mounts are torn down when the plugin is disabled or reloaded. Older hosts lack the method; fall back to `startChat`.

```js
ctx.tangu?.mountChat?.(el, { agent, folder, title })
```

### The element is yours again after dispose (2026-10-04)

`ctx.ui.mount*`, `ctx.tangu.mountChat`, `ctx.table.mount`, `ctx.dashboard.mount`, `ctx.app.mountBlocks` and a file view's `mountNoteView` all render inside a layer the host adds to `el` (`display:contents`: it generates no box, so the element's height and flex still apply to the content). `dispose()` removes that layer synchronously and the element is the plugin's again at once: clear it, put your own content in, or mount on it again without waiting. Mounting again creates a fresh instance; use the handle's `update()` to change data or options in place. One element holds one host mount at a time: mounting on an element whose previous mount was not disposed retires that mount first, fully, as if it had been disposed; its handle goes inert, and the later call wins. `mountFloatingToc` is the exception: it overlays `shell` without taking it over, so it neither retires nor is retired by other mounts. Do not reach host nodes through `el > .x` or `el.firstElementChild`. Hosts up to 2.12.2 do not give this guarantee: to support them, mount into a child element you create and replace that child when the content changes.

### Following the host's appearance switches (2026-10-05)

Settings → Appearance has three switches the user turns on or off one by one ("Relaxed text" and "Gentle transitions" are on by default, "Dim surroundings" is off by default; which are on is up to the user): "Dim surroundings" (ribbon icons, inactive tabs and left-sidebar text recede while the user works, and return on pointer or keyboard focus), "Relaxed text" (looser line and paragraph spacing in note and chat bodies), and "Gentle transitions" (a slower view fade-in and a slower return of the surroundings). A plugin calls no API for these; it follows them by writing its styles this way:

- Use only `var(--text)`, `--text-light`, `--text-muted` and `--text-faint` for text and line icons. Do not hard-code colors or add your own `opacity` to mark secondary content: the host fades the left sidebar by fading those variables. Use semantic colors such as `--accent-ink` and `--danger` for state (unread, error, running); they do not fade.
- Mark the selected row of a left-sidebar list with `aria-selected="true"` or `aria-current` (the `.active`, `.on` and `.is-on` classes also work) so the host keeps it at full strength. Do not put `.on` on a container that wraps a whole panel, or nothing inside it will recede. Rows from `registerListSource` are drawn by the host and need nothing.
- For long-form reading text, use `line-height: var(--reading-line-height, 1.6)` and a paragraph gap of `var(--reading-paragraph-gap, 0.3em)`; the fallbacks are the values with the switch off. Lists, forms, cards and tables are interface text and do not use these tokens. Content mounted through `ctx.ui.mountMarkdownEditor`, `ctx.app.mountBlocks` or `ctx.tangu.mountChat` follows automatically.
- Do not add an entrance animation on the view root (the host already fades the main view in once when switching). Use `--duration-fast`, `--duration-base`, `--duration-slow` and `--ease-surface` for transitions inside the view, and turn them off under `prefers-reduced-motion`.
- The switches belong to the user: do not read or write `forsion_calm_*` or `<html data-calm-*>`, and do not ship a private switch of the same kind. Pages inside an iframe or webview cannot see host variables and will not fade.

### A whiteboard layer over your own content (2026-10-10)

`ctx.ui?.mountBoard?.(el, opts)` mounts the host whiteboard engine (the one behind `.excalidraw.md` boards, with the same seven pens) as a transparent layer without a toolbar over the plugin's own content, such as PDF pages, images or a timeline, for handwriting and circling. Strokes are whiteboard elements: store `scene.elements` verbatim as JSON and hand them back unchanged; they paste into a real board and back.

```js
const board = ctx.ui?.mountBoard?.(layerEl, {
  scene: { elements: saved },
  viewport: { scrollX, scrollY, zoom },   // a scene point lands at (point + scroll) × zoom from layerEl's top-left corner, in CSS pixels
  tool: 'freedraw', pen: 'fountain', theme: 'light',
  onChange: (scene) => saveSoon(scene.elements),
  onWheel: (ev) => scroller.scrollBy(ev.deltaX, ev.deltaY),
})
scroller.addEventListener('scroll', () => board?.update({ viewport: currentViewport() }))
```

- The caller owns the viewport: the layer never pans or zooms by itself, so call `update({ viewport })` when your scroll container or zoom changes. A scene point lands at `(point + scroll) × zoom` CSS pixels from the top-left corner of `el`. Wheel and pinch events are handed to `onWheel` untouched, and dropped without it.
- The host cancels the app's interface zoom (a user at 110%, for example): keep giving `viewport` in the element's own CSS pixels, and divide by `el.currentCSSZoom` when you derive it from `getBoundingClientRect()`.
- `tool` is one of `selection`, `freedraw`, `eraser`, `text`, `rectangle`, `ellipse`, `arrow`, `line`. `pen` (only meaningful with `freedraw`) is one of `default`, `finetip`, `fountain`, `marker`, `highlighter`, `thick-thin`, `thin-thick-thin`. `strokeColor` and `strokeWidth` override the pen's own color and width.
- `theme` follows the host's light/dark mode by default. Pass `'light'` when the content underneath stays light in dark mode (a PDF page); otherwise the engine inverts the ink.
- `onChange` fires only when elements change (a stroke ends, an erase, an undo), not for viewport changes or a `scene` you pushed in. It fires on every frame while drawing, so batch your saving.
- The handle has `update(patch)`, `getScene()` (deleted elements left out), `undo()`, `redo()` and `dispose()`. `update({ scene })` replaces the content wholesale without an undo entry. The layer does not take over global shortcuts.
- Invalid options (no `scene.elements`, or a `viewport` that is not three finite numbers with `zoom > 0`) throw `TypeError` synchronously. `dispose()` is idempotent and returns `el` to you; the host unmounts on plugin disable or reload.
- When you're not handwriting, `ctx.ui.boardToSvg` produces a static image as `{ svg, x, y, width, height }` (`null` for an empty scene). `x`, `y`, `width` and `height` are the bounding box in scene coordinates: place `svg` at `(x + scrollX) × zoom` with a width of `width × zoom` and it lines up with the whiteboard layer.

```js
await ctx.ui.boardToSvg({ elements }, { theme, padding })
```

- Older hosts lack both methods: feature-detect, and without them don't offer a handwriting entry rather than imitating one.

### The selection bar (2026-10-13)

The strip that appears over selected text is the same one in chat, in notes and in every plugin view that opts in: the view's own tools plus three actions every view shares — **Ask Tangu** (hands the text to the side chat as a quote), **Translate** (the result opens in a card under the selection) and **⋯** (actions added by plugins). Which block comes first is the user's choice under Settings → Appearance → Selection menu; the view's own tools lead by default. The buttons are maintained in `@lcl/components` (`SelectionBar`, `SelectionBarActions`); chat and plugin views wire selections and actions through the app-level `components/selectionBar/ViewSelectionBar`, and the note formatting toolbar embeds the action area in its own row.

A plugin view opts in with `ctx.ui?.mountSelectionBar?.(root, opts)`. A view that never calls it gets no bar (the host does not listen for selections globally):

```js
const bar = ctx.ui?.mountSelectionBar?.(el, {
  view: 'reader',                                   // selection actions see the view id '<plugin id>:reader'
  tools: [
    { id: 'yellow', title: zh ? '高亮' : 'Highlight', color: '#ffd400', run: (sel) => { highlight(sel.text); getSelection()?.removeAllRanges() } },
    { id: 'note', title: zh ? '写批注' : 'Add a note', icon: 'annotate', run: (sel) => openNote(sel.text) },
  ],
  source: () => ({ title: doc.title, path: doc.vaultPath, page }),
})
if (!bar) drawOwnMenu(el)                           // hosts up to 2.13.3: keep your own menu
```

- By default the host watches the DOM selection inside `root`: the bar shows on mouse-up and goes away when the selection collapses, the content scrolls or resizes, or the user clicks elsewhere. Selections inside inputs and editable regions never show it.
- For content the host cannot see into (an iframe, a canvas, a PDF text layer you position yourself) pass `watch: false` and call `bar.show({ text, rect })` and `bar.hide()` yourself. `rect` is the selection's bounding box in viewport pixels (`range.getBoundingClientRect()` as is; the host cancels the interface zoom, so do not divide).
- `tools` are declarative: an icon button (`icon` is a name from the plugin icon vocabulary, which gained `highlight`, `underline`, `strikethrough`, `annotate`, `copy` and `cite` for this) or a colour swatch (`color`). The host only draws the button and `run` decides what it does; once a tool has consumed the selection, clear it or call `bar.hide()` in `run`. There are no dropdowns: if you need more UI, open your own from `run`.
- `ask` replaces what Ask Tangu does when clicked (to add a page number, for example) and `false` removes that button. Without it the host hands the text and `source` to its side chat; hosts without a side chat don't draw that button.
- The bar adds nothing to `root` and does not take it over (it floats above the page), so it coexists with `mountFloatingToc` and other mounts. The handle has `show`, `hide`, `update(opts)` and `dispose()`; the host disposes it when the plugin is disabled or reloaded.

Add actions with `ctx.registerSelectionAction`; they are listed under "⋯ → Plugins". Without `scope` an action appears in notes only, as before. `scope: 'all'` lists it in every view that has opted in, `'own'` only in the plugin's own views, and an array names views (`'note'`, `'chat'`, `'<pluginId>:<viewId>'`). `when({ view, editable, length })` must return true for the action to be listed; it never receives the selected text, which only reaches the plugin through `run(cx)` after the user picks the action. The markdown `run` returns goes to the host's result card: Replace / Insert below / Copy / Discard in an editable note, where nothing is written until the user clicks, and read-only (Copy / Close) everywhere else. `output: 'none'` means the plugin handles the result and the host shows no card. `cx.pagePath` is only set in notes. Hosts up to 2.13.3 ignore the new fields: the action stays note-only, listed under "AI ▾ → Plugins".

### Settings parts (2026-10-17)

The small parts used by settings and store pages are open to plugins: group panels, setting rows, switches, buttons, inputs, segmented controls and selects, plus the new values, usage meters, steppers, code with copy, half-sheet choices and confirmations, and empty / loading / error states. The main entry is `ctx.ui.mountSettingsPage(el, schema)`: the plugin hands over a description of the whole page (which groups, which items in each group, values and callbacks) and the host draws it per device. `ctx.ui.mountSettingsItem(el, item)` mounts one part at a time to fill gaps (for example inside a `custom` block). The host's own Settings → Notifications page uses the same renderer. Canonical types: `desktop/shared/settingsPage.ts`; the renderer is the app-level `components/SettingsPage`.

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

| Item `type` | Drawn as | On phones (≤820 px) |
| --- | --- | --- |
| `switch` | A switch; it flips back if the promise returned by the callback rejects | Stays to the right of the title |
| `value` | A read-only value (a string the plugin formats) | Stays on the right |
| `button` | `buttons: [...]`, `kind` is `primary` / `ghost` (default) / `danger`, optionally with `confirm` | One button stays on the right; two or more move to the next line and fill it |
| `input` | An input, optionally with one button (`onClick(text)`) | Moves to the next line and fills it |
| `segmented` | A segmented control for switching a setting | Stays segmented if it fits |
| `select` | A dropdown | Moves to the next line and fills it |
| `choice` | "Picking runs it": a row of buttons on desktop | One button (labelled `button`) + a half sheet; native half sheet on Android, the host's half sheet in the mobile web shell |
| `stepper` | − value +, optionally with one button (`onClick(n)`) | Moves to the next line |
| `code` | Code + a copy button | Stays on the right |
| `meters` | Usage meters, two columns on desktop and one on phones; filled with the host's `--action-fill` | — |
| `state` | `empty` / `loading` / `error`, optionally with a retry `action`; a page-level `{ state }` draws only that for the whole page | — |
| `custom` | The host provides an empty element; `mount(el)` is called once per id, and the cleanup it returns runs when the block goes away or the page unmounts | — |

- **Text and color**: parts carry no text; everything comes from the plugin (in both languages, from the plugin's own strings). The host supplies only screen-reader names (the stepper's ±) and the confirmation dialog's "Cancel". Parts use only host variables and follow light/dark mode and the color scheme; plugins pass no colors. A group's `icon` is a name from the icon vocabulary; this release adds `bell`, `gauge`, `coins`, `clock`, `gift`, `user`, `shield`, `package`, `activity`, `message`, `plug` and `list-checks`.
- **Touch**: buttons, inputs and steppers are 36 tall.
- **Identity and updates**: every group and item needs a stable `id`, which the host uses to recognise rows. `update(schema)` replaces the whole description. A `value` you pass wins on every update; leave an input's or stepper's `value` out to keep what the user typed, or pass `value: ''` to clear it. Switch, segmented and select controls flip back if their callback fails; a button whose callback returns a promise stays disabled until it settles; a button with `confirm` asks first (a native half sheet on Android).
- **Lifecycle**: the same as the other `ctx.ui.mount*` (mounted in a layer the host adds to `el`; `el` is yours again right after `dispose()`; a later mount on the same `el` retires the earlier one). The host disposes everything on plugin disable or reload, after which no callback runs. Malformed calls (`el` not an element, `groups` not an array, or neither given) throw `TypeError` synchronously.
- **Older hosts**: hosts before 2026-10-17 lack both methods. Feature-detect with `ctx.ui?.mountSettingsPage` and keep your own page without it; don't copy the host's settings CSS to imitate it.
- **Not in this batch**: card grids and tables (needed for the backpack, the store and usage records) come in the second batch; a two-column tablet layout waits for the tablet design to be finalised, and the parts themselves won't change.

### Recording model choices (2026-10-14)

`ctx.ui?.mountModelPicker` mounts the existing native ModelPill menu without a prompt input. `kind` is `asr` or `translation`; `value: ''` follows that global slot, while ASR `value: 'local'` selects on-device SenseVoice. It reads the home engine catalog, includes dedicated translation models, and follows native model sorting and grouping preferences. Selection is a local draft delivered through `onChange`; the host never changes global settings or starts a model call. Use `{ update(patch), dispose() }`, change `scopeKey` when switching recordings, and feature-detect together with `ctx.tangu.modelCatalog`. Unready on-device models are explained and cannot become selected; download them through Settings → Voice. The host disposes the picker and aborts an open menu when the plugin is disabled or reloaded.

```js
ctx.ui?.mountModelPicker?.(el, { kind, value, label, followLabel, scopeKey, onChange })
```

`ctx.tangu?.modelCatalog?.(kind)` returns `{ models, defaultModelId }` from the same home target used by desktop ASR and inline AI. Each model has `id`, `name`, `provider`, `source`, `available`, and `supportsCorrection`; dedicated machine-translation models set `supportsCorrection: false`. No credentials are returned. `ctx.tangu.complete` and `ctx.tangu.translate` accept optional `modelId` overrides and return optional `model: { id, name, mt? }` provenance. An explicit override never writes the global model slot. When it is omitted, the existing global-slot behavior remains available. Desktop `window.tangu.transcribeAudio` accepts per-call `backend: 'local' | 'cloud'` as well as `modelId`; explicit offline ASR never falls through to a cloud Provider when the local model is unavailable. Pass `language` (`zh`, `en`, `ja`, `ko`, `yue`, …) when you know what is spoken: the on-device model otherwise guesses the language per utterance and can turn far-field English into Chinese or Japanese text; cloud models receive it as a hint. Omit it for mixed-language audio.

These APIs reuse the native model picker, and the selection stays a local draft of the plugin; model calls and per-record persistence remain the plugin's job. An empty value follows the global setting, and ASR's `local` means on-device SenseVoice. The catalog comes from the home engine that actually executes the calls; dedicated translation models are marked translation-only through `supportsCorrection`. Update `scopeKey` when switching records and take the host mount back with `dispose()`; plugin disable or reload also cleans up automatically. On older hosts without these optional methods, keep the follow-global-setting UI and don't show per-record overrides you can't honour.

### Record fields (2026-10-17)

`ctx.ui?.mountRecord` mounts the field list from the host calendar's event card (title, time summary with its editor, other properties) into the plugin's own card. The component is `RecordFields` in the app-level `views/calendar/EventCard`, the same one the built-in calendar card uses. Edits write to the table through the same path as `ctx.databases.setCell`, sharing data with any open table view. The plugin owns the frame, close button, Open / Delete actions and positioning. Only plugins that declare `databases` get it; a `path` that is not a table in the vault or a missing `rowId` throws `TypeError` synchronously. `dateCol` must be a date column and is ignored otherwise. A deleted row or a vault switch renders nothing; overlays (read-only tables) and `readOnly: true` show values only. The handle has `update(patch)` and `dispose()`; after `dispose()` the element is yours again, and the host unmounts on plugin disable or reload. Since 2026-10-24, `body: true` adds the record's Markdown body editor below the fields; it is the same body and write path as "Open record" in a table, and only appears for writable classic tables (not note views, overlays or `readOnly`). `hideColumns` lists property column ids to leave out, such as a done column the plugin already draws as a checkbox. Rows in `ctx.databases` snapshots carry `hasBody: true` when the body is not empty. Older hosts ignore all three.

```js
ctx.ui?.mountRecord?.(el, { path, rowId, dateCol, readOnly })
```

### View modes (2026-10-19)

Seeing the same thing another way (Chat / Canvas, Document / Canvas, Transcript / Notes / Summary, Day / Week / 3 days / Month) has one arrangement across the app: the switch sits at the **left end of the view's head row**, a 32px row inside the paper card that does not scroll with the content; the view's own title follows the switch. One switch per view, with 2–4 modes; more than four use tabs (database views). Filter and source pills look the same but never go in that position. For the proposal and trade-offs, see `docs/ToBeImproved/视图模式切换标准方案_2026-10-19` in the repository root.

- Native views: register with `useViewModes` (`@lcl/engine`), then put `<ViewModeSwitch leafId={leaf.id} />` at the left end of the head row; a view without its own top bar uses `<ViewHead leafId>{buttons}</ViewHead>` for the whole row. Views that already have a top bar (Amadeus `.amx-toolbar`, the calendar's `.amx-cal-bar`) add `container: lcl-viewhead / inline-size` to that row so the narrow-width fallback can read its width.

```js
useViewModes(leaf.id, { modes, value, onChange })
```

- The host handles it all: ⌥⌘V (Windows / Linux: Ctrl+Alt+V) switches to the next mode; the command palette has one "View: X" command per mode; the hover hint reads "X (⌥⌘V)" (options with their own key, like the calendar's "D", show their own); below 480 view width only icons remain (when every mode has an icon), and below 320 it collapses into a "Current ▾" dropdown; in the single-column phone shell the view draws nothing and the switch sits between the top bar's two capsules, and under the native top bar it goes into the "View" section of "⋯".
- Memory belongs to the view: notes per document, chats per tree root, Diting per recording, the calendar globally, Code Studio per project; the host stores nothing for it.
- As a plain part (not part of ⌥⌘V, for example preview / source inside a floating window): `ViewModeSwitch` (`@lcl/components`); `compact` always shows icons only.

```jsx
<ViewModeSwitch spec={{ modes, value, onChange }} />
```

Plugin views use `ctx.ui?.setViewModes?.(el, spec)`: `el` is the element `mount()` received, and `spec` has the shape below, where `icon` is a name from the plugin icon vocabulary (`audio-lines` / `notebook-pen` / `list-checks` are new). The handle is `{ set(id), update(patch), actions, dispose() }`: `set` moves only the switch and doesn't call `onChange`; `actions` is the empty slot at the right end of the same row, so move your toolbar buttons there and the whole view keeps a single head row. Calling it again on the same view replaces the previous one; the host takes it back on plugin disable / reload / view close. Fewer than 2 or more than 4 modes throws synchronously. Older hosts lack the method: keep your own tabs.

```js
spec = { modes: [{ id, label, labelEn?, icon? }], value, onChange(id) }
```

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

### Tooltips and motion tokens (2026-10-23)

The host's buttons, sidebar rows and Ribbon share one tooltip (LCL `hoverSurface`): it appears after 300ms of hovering; while one is showing, moving to a neighbouring element that also has one moves the same tooltip over without replaying; it closes 80ms after you leave (coming back within those 80ms keeps it); keyboard focus (`:focus-visible`) shows it at once without animation; pressing or scrolling hides it. Plugins don't need to write their own:

- Native views: spread `tooltipProps(content, { side })` onto the trigger element (`@lcl/components`). `content` is one line, several lines (the first is the title, the rest in a secondary color) or a function evaluated when it is due (may be async; returning null shows nothing). The DOM form is `attachTooltip(el, content, opts)`; `hideTooltip()` closes it temporarily. For hover cards (React content, such as app reference cards and chat link cards) use `useHoverCard(content, opts)`, which returns `triggerProps` and `portal`, timed by `--hovercard-*`; with `opts.longPress` a half-second press on a touch screen shows the card at once and lifting the finger closes it (for phones).
- Plugins: `ctx.ui?.attachTooltip`, where `content` is a string or an array of strings and `side` is `top` (default) / `bottom` / `left` / `right`, flipping when there's no room. The handle is `{ update(content), dispose() }`; the host disposes everything on plugin disable / reload. The tooltip doesn't name the element: keep `aria-label` on icon buttons and remove their `title` so two tooltips don't stack. Older hosts lack the method: keep using `title`.

```js
ctx.ui?.attachTooltip?.(el, content, { side })
```

```js
const tip = ctx.ui?.attachTooltip?.(exportBtn, ['导出', '另存一份 Markdown'], { side: 'bottom' })
if (!tip) exportBtn.title = '导出'
// …when the element is removed
tip?.dispose()
```

For your own motion, use the host's motion tokens instead of literal durations (the host's `check:motion` enforces this for built-in styles): `--ease-surface` (enter), `--ease-exit` (leave, accelerating away), `--ease-calm`, `--ease-drawer`, `--duration-instant` / `--duration-fast` / `--duration-base` / `--duration-slow` (100 / 150 / 200 / 250ms), `--collapse-duration` / `--collapse-ease` for collapsing, `--menu-enter-duration` 180ms / `--menu-exit-duration` 80ms, `--tip-enter` / `--tip-exit`, `--hovercard-enter` / `--hovercard-exit`. Leaving is shorter than entering; interruptible states use `transition`, not `keyframes`; don't tween width, height, padding or margin (use the collapse below or `transform` for size changes); don't write `transition: all`; things that are created, restored or scrolled into view don't animate in; with reduced motion keep colour and opacity changes and drop translation and scale.

### Motion the host applies for you (2026-10-25)

The plugin view lives in the same page as the host, so the following get Forsion motion from standard markup alone, with no keyframes of your own and no tokens to read. All of these host rules have zero specificity (`:where()`): an `animation` / `transition` you write on the same element wins, and the host turns them off when the system's "Reduce motion" is on. Pages inside an iframe / webview don't get them.

- **Native `<details>`**: the content fades in when opened and out when closed, with the same duration and curve as the collapse below (200ms). Only opacity moves and height is not tweened, so it stays steady inside scrolling lists.
- **Collapse, `data-motion="collapse"`** (since 2026-10-26): on a block that opens and closes (a folder's children, an expanded detail) write `data-motion="collapse"` on the outer element, `data-open="true"` when open and `"false"` when closed, and put the content in **exactly one** inner element. The host grows it from zero to its content height with `grid-template-rows` while fading it in, and closes it in the same 200ms; changing your mind halfway continues from where it is, and you don't measure heights. While closed the content is `visibility: hidden`, so Tab can't reach it. Give the chevron next to it `data-motion="chevron"` with the same `data-open`: it turns 90° when open (use a right-pointing chevron) and starts and stops with the content. Once open, the inner element still clips anything that sticks out; add `data-settled` on the outer element to release it (in React use the host's `AnimatedCollapse`, which handles this itself: import it from `@lcl/components` and use it as below; on close it plays the animation before unmounting). Don't measure `scrollHeight` and tween `height` yourself.

```jsx
<AnimatedCollapse open={open}>{open && …}</AnimatedCollapse>
```

- **Native `<dialog>` (`showModal()`) and `popover`**: they open with the same entrance as the command palette (120ms, fading in while scaling from 0.985 to 1), and the backdrop fades in with them.
- **`data-motion="enter"`**: put it on content that appears because the user just clicked something (a list they opened, a section they expanded, the other version they switched to); it fades in and rises 4px from below when it mounts (180ms). Only for what just happened: not for what is there when the view opens, what is restored from storage, or what scrolls into view. It animates the separate `translate` property, so positioning you do with `transform` is left alone.
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

### Drop indicators (2026-10-24)

The line that says "it will land here" while dragging to reorder or into a folder, and the outline for "drop into this", are one thing across the host (LCL `dropIndicator`): coloured with the theme's `--signal-line`; moving to another drop point fades the old one out where it is (90ms) and fades the new one in at the new position, unfolding from its near end (130ms); the same drop point merely moving with a scroll follows directly without replaying; with "Reduce motion" on, nothing animates. Don't draw your own line:

- Native views: `createDropIndicator({ host?, className? })` (`@lcl/components` or `@lcl/engine`), with the handle `line(rect, { key?, axis? })`, `zone(rect, { key? })`, `hide()`, `destroy()`; all coordinates are viewport px. Places that already own an indicator element call `dropRetarget(el, key, { axis? })` **before** writing the new position and `dropHide(el)` before hiding it. Lists that draw a pseudo-element line per row follow the head comment of `lcl/engine/dropIndicator.css`: keep the pseudo-element always present and transparent, and let the drop class only light it up (`--lcl-drop-enter` / `--lcl-drop-leave`); outline and background highlights use `transition: box-shadow var(--lcl-drop-fade)`.
- Plugins: `ctx.ui?.dropIndicator?.({ host? })`, with the handle `{ line, zone, hide, dispose }`. `line({ x, y, w })` is a horizontal line (`y` is its top edge), `line({ x, y, h }, { axis: 'v' })` a vertical one, and `zone({ x, y, w, h })` the "drop into this" outline. Pass a `key` (your row or slot id) so a scroll isn't taken for a new drop point. Call `hide()` on dragleave / drop / dragend and `dispose()` when the view goes away; the host disposes it on plugin disable / reload. Older hosts lack the method: keep drawing your own line.

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

**Landing after a drop (2026-10-25)**: after the drop, the dragged item glides from where it was let go (where the drag image was) into its new place: 160ms, decelerating (the same curve as the drop line, `--lcl-drop-ease`; duration token `--land-duration`), carrying a shadow that fades as it goes; neighbours don't make room; with "Reduce motion" on it simply appears in place. The host uses it for project groups in the Tangu sessions list, plugin list rows and the built-in to-do view's group changes (homepage tiles sort with dnd-kit and don't use it; the Calendar plugin's own to-do view has to call `drop.land` itself).

- Native views: at drag start `grab = dragGrab(el, e)`, at drop `from = releasePoint(e, grab)`; after re-rendering (before paint: `useLayoutEffect` / `requestAnimationFrame`) call `land(el, from, { with?, unclip? })` — `with` lists elements that move by the same offset (the block under an expanded group), and `unclip` lists folding containers whose clipping is lifted during the flight. When the data re-renders later (after a disk write or a plugin callback), use `landWhenMoved(() => findTheRow(), from, opts)`: it checks on every DOM addition or removal and lands once the row is re-mounted or has a new parent / previous sibling, giving up after 1.2 seconds without movement. Only the dragged element's own inline `transform` / `transition` / `box-shadow` are written, and they are restored after the flight; it moves with a `transition`, not keyframes.
- Plugins: `drop.land?.(target, from)` on the handle. `target` is the row already re-rendered in its new place; if it hasn't re-rendered yet, pass a function that finds it, and the host waits until it has moved before landing. `from` is as above (a top-left corner in viewport px). Older hosts lack `land`: rows simply appear in place.

```js
let grab = null
list.addEventListener('dragstart', (e) => { const r = e.target.getBoundingClientRect(); grab = { x: e.clientX - r.left, y: e.clientY - r.top } })
list.addEventListener('drop', async (e) => {
  drop?.hide()
  const from = grab && { x: e.clientX - grab.x, y: e.clientY - grab.y }
  await moveRow(id, target)             // your own move + re-render
  if (from) drop?.land?.(() => list.querySelector(`[data-row="${id}"]`), from)
})
```

### Host-drawn parts (2026-10-26)

Plugins can't get the host's React components (one React instance isn't shared across plugins), so the host turns common parts into mounts on `ctx.ui`, and plugins pass only data and callbacks. Text fields all take PluginText (a string, `() => string` or `{ zh, en }`); the host evaluates it at render time and re-evaluates it automatically when the language changes. The host-side implementation lives in `desktop/frontend/src/amadeus/plugins/` (`partsSurface.tsx`, `contextMenuSurface.tsx`, `pluginIcon.tsx`, `pluginText.ts`, `pluginParts.css`) and reuses the native components. Before 2026-10-26, `ctx.ui.contextMenu` kept only `label` / `run` / `checked` / `disabled` / `danger` and silently dropped every other field:

| API | Host component | Contract |
| --- | --- | --- |
| `ctx.ui.contextMenu(x, y \| { anchor, align, side }, entries, opts?)` | `.ctx-menu` shell + `OverlayAt` (Android: `runNativeSheetMenu`) | Rows `{ label, run, icon?, shortcut?, checked?, disabled?, danger? }`, `{ separator: true }`, `{ section }`; if any row has an icon, rows without one keep an empty slot of the same width; leading / trailing / adjacent separators and empty sections are removed automatically; `opts.keepOpen` + handle `update(entries)`; `opts.onClose`. |
| `ctx.ui.confirm(opts)` / `ctx.ui.openDialog(opts)` | Native `<dialog>` + `showModal`, looking like the notes ConfirmDialog (420 / 560px, `--radius-lg`, card background, `--card-shadow`); Android confirmations use `presentNativeConfirm` | Primary button on the right; with `danger` it is red and focus lands on "Cancel"; Enter = primary button; Esc / backdrop = cancel; `run` returning `false` keeps it open; the cleanup from `mount(el)` runs on close. |
| `ctx.ui.mountControl(el, { type, size: 'toolbar', … })` | Segmented = `ViewModeSwitch` (the view-mode capsule); dropdown = a 28px text button + `.ctx-menu` listbox (native drawer on Android) | Segmented takes 2–5 items; dropdowns with 6 or more items get search; a click moves the selection first, then calls `onChange`, and `update({ value })` makes the plugin's value win. |
| `ctx.ui.popover(anchor, { mount, side, align })` | `.ui-popover` shell, placed with `clampMenu` + `zoomOf` | Anchored, clamped to edges, interface-zoom aware; closes on Esc / outside click / blur; one at a time. |
| `ctx.ui.icon(name, { size })` | The `PLUGIN_ICONS` vocabulary (the 30 Space names are merged in) | Returns a new `<svg>`; a name outside the vocabulary → null plus one console warning (plugin id + name, with close matches); Spaces / lists fall back as before (stacked squares / file). |
| `ctx.ui.mountEmptyState(el, …)`, `ListSourceContribution.empty` | `components/EmptyState`; list sources register through `views/hostListEmpty.ts` | Desktop: the sidebar in the plugin's own Space doesn't say "Nothing here"; full-screen phone lists draw the same empty state. |
| `ctx.ui.mountWebCard(el, …)` | `components/WebCard` (the host's own local web page cards / service cards in `views/chat2/WebCards.tsx` use it too); thumbnails go through the main process `electron/pageThumb.ts` | Accepts only http(s) thumbnails, cached by url + version; `layout: 'row'` is a list row; an update that includes a key with value undefined / [] / null clears it. |
| `ctx.ui.setViewHead(el, { title, actions })` | `ViewHead` (`title` slot) + `plugin-viewhead-actions` | Coexists with `setViewModes`: capsule, title and two sets of buttons. |
| `ctx.ui.mount(name, el, props)` | One entry point for all of the above (`PluginUiParts` type) | For React / Vue plugins to mount on a ref; returns `{ update, dispose }`. |
| `ctx.addStyle(css)`, `ctx.i18n.define({ zh, en })` | `<style data-plugin>`, `defineMessages` in `pluginText.ts` | Removed on disable / reload; fallback chain current language → zh → key, with one warning for a missing en key. |

The lifecycle is the same as the other `ctx.ui.mount*`: the host disposes everything on plugin disable / reload / setup failure, after which callbacks are no longer called; malformed calls throw `TypeError` synchronously. Instruments: `desktop/frontend/src/amadeus/plugins/partsSurface.test.ts` (unit tests) and `desktop/scripts/r8dx-shots.cjs` (real Electron: installs the sample plugin `scripts/fixtures/r8dx-sample-v2` and captures light / dark / live switch to English / narrow pane shots while measuring geometry).

### Style contract (2026-10-26)

The host class names and CSS custom properties a plugin can rely on are published in the forsion-plugin skill's `tools/plugin-contract.json` (each with its purpose, versioned with `apiVersion`). Host class names and variables outside that list can be renamed or removed at any time.

- Public classes: `.btn` (`.primary` / `.ghost` / `.danger` / `.sm`), the `.ctx-menu` shell (its direct `<button>` children are the items; also `button.danger`, `.ctx-separator`, `.ctx-shortcut`, `.ctx-head` and `.ctx-menu-scroll`), and `.empty-state` / `.empty-title`. Do not borrow host-private classes such as `.amx-*`, `.fc-*` or `.t2-*`.
- Public tokens: colors, radii `--radius-*`, shadows, menu sizes `--menu-*`, interface type `--ui-font-*` / `--ui-line-*`, motion `--duration-*` / `--ease-*`, and `--focus-ring`. The contract lists names, not values: values follow the design language, accent and background. `--ease-out`, `--ease-spring`, `--ease-apple` and `--dur-*` are deprecated.
- No fallbacks: write `var(--radius-md)`, not `var(--radius-md, 10px)`. Keep a fallback for older hosts only for a token newer than your `minAppVersion` (the contract's `since` table); `--reading-line-height` and `--reading-paragraph-gap` take one by design.
- No hard-coded colors, shadows or radii: for a light wash use `color-mix()`. A color that is fixed because it belongs to the picture itself (a video letterbox, white text over a frame) is written as a keyword: `black` / `white`.

```css
color-mix(in srgb, var(--green) 14%, transparent)
```

- Check: `node check-plugin.mjs <plugin folder> --style` scans `main.js` and the folder's `.css` files and reports private classes, tokens that are not listed or are deprecated, needless fallbacks, hard-coded colors, radii of 4px or more, and shadows with a color. It only reports and does not change the exit code. CSS meant for another document (a page inside an iframe, an exported file) is skipped by putting `/* forsion-style: off */` on the same line.

DOM popovers opened with `ctx.ui.popover` use the same `ui-menu-exit` animation and tokens as `OverlayAt`. Cleanup runs immediately; only an inert visual copy remains until exit completes. Reduced motion follows host policy.

### Don't hand-draw what the host has a part for (2026-10-29)

A plugin view that draws its own dropdowns, menus, dialogs or tab bars looks foreign in Forsion and doesn't follow the user's theme, language, UI zoom or later host fixes. Reach for the parts above first, and draw only what no part covers (your content itself: rows, cards, charts).

| You need | Use | Not |
| --- | --- | --- |
| Several panes or tabs in a Space | native Panels in `space.json`; several views in one panel are native tabs | a tab bar inside one view |
| A title row with buttons | `ctx.ui.setViewHead` | your own header bar |
| A dropdown / 2–5 modes | `ctx.ui.mountControl({ type: 'select' })` / `{ type: 'segmented' }` | `<select>`, a listbox you position |
| A ⋯ or right-click menu | `ctx.ui.contextMenu({ anchor })` | a menu div with your own class |
| Confirm / ask for text / a small form | `ctx.ui.confirm`; for input, `ctx.ui.openDialog` with the field in `mount` | `window.prompt` (does nothing in the desktop app), `window.confirm`, `<dialog>`, a hand-made backdrop |
| A panel anchored to a button | `ctx.ui.popover` | `position: fixed` and your own math |
| Nothing yet | `ctx.ui.mountEmptyState`, a list source's `empty` | a centered line of text |
| Buttons | the public `.btn` classes (`.primary` / `.ghost` / `.danger` / `.sm`) | hand-styled `<button>` |
| Styles | `ctx.addStyle(css)` with public tokens | a `<style>` pushed into `document.head` |

- Check: `node check-plugin.mjs <plugin folder> --style` lists, under "UI parts", what the plugin still draws itself where the host has a part: one line per kind, with locations and the part to switch to. When Tangu verifies a plugin in the plugin sandbox (`plugin_sandbox`), every status it gets back carries the same list. It only reports: the exit code doesn't change, and nothing blocks installing or publishing. Plugins whose UI is a web page in an iframe stay allowed; put `/* forsion-style: off */` on that page's CSS lines.
- The rules live in the `forsion-plugin` skill's `tools/ui-reinvent.mjs` and go by how the code is written: `<select>` / `role="listbox"`, own `menu` / `dropdown` / `popup` class names or `role="menu"`, `<dialog>` / `showModal` / `window.confirm`, `tab` class names or `data-tab` / `role="tab"`, `position: fixed`, `<iframe>` / `<webview>`, `document.head.append…`, and hand-made buttons when the plugin never uses `.btn`. Library code minified onto one line (lines over 2000 characters) is skipped whole.
- The bundle template's counter view (`samples/forsion-sample-bundle`) follows this table (view head, toolbar select, ⋯ menu, confirm dialog, empty state, `.btn`); copy from it.
