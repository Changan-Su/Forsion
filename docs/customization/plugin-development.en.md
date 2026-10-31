---
title: Plugin development
description: Write desktop plugins and engine plugins for Forsion: layout, list sources, approvals, host parts, cards and other extension points.
---
# Plugin development

For plugin authors. Installing plugins, bundles and the security model are covered in [Plugins](./plugins.md).

## Getting started

Plugins are written in JavaScript / TypeScript, with official type definitions and templates. The built-in "Forsion extension development" skill lets the agent scaffold a plugin, theme, Space or agent straight from the official templates; see [Skills](../agents/skills.md).

To link what your plugin produces with the native notes panel, use `ctx.app.openNote`: an Amadeus panel with the same `reuseKey` switches to the new note in place, and `activate:false` keeps the user's focus on the plugin panel. Combined with `split:"right"` / `split:"down"` on a Space's main-area entries, your plugin doesn't need to copy a document editor or chat interface into its own DOM.

```js
ctx.app.openNote(path, { reuseKey, activate })
```

Lay plugin views out in native panels instead of drawing sidebars or bottom bars inside one view: lists in the left workspace (`registerListSource`), the subject in main, properties and inspectors on the right (or in an Extend View), and full-width content such as timelines, logs or consoles in the bottom panel (`layout.bottom` in a Space recipe, or `ctx.openView(id, { location: 'bottom' })`). A recipe's `layout.bottomSpan` picks the columns the bottom panel spans: `right` (default; main and right sidebar), `left`, `full` or `main` (main only). Older hosts and mobile have no bottom panel: check `ctx.viewLocations?.includes('bottom')` first and fall back to drawing it in the view. To switch layouts the way Coding Studio does (navigation on the left until a project is open, then the project's own content), swap your own views in place with `ctx.replaceView?.('nav', 'media')`. If it returns 0, don't fall back to `openView`: that would expand a panel the person collapsed. Swap back on the way out to the launcher, then call `ctx.closeView?.('timeline')` to close the bottom panel. Side panels work the same way: when one page doesn't need the right panel and only other pages show details there (like Penzor Cloud's overview), call `ctx.closeView?.('info', { collapse: true })` on that page. If the panel holds nothing but that view, it folds away (the view waits in the stash and comes back when the person reopens the panel or on your next `openView`) instead of showing an empty placeholder; with other views in the panel it closes as usual. Older hosts ignore the option and leave the placeholder (2026-10-18+). To keep the navigation reachable at all times, mark it `"pinned": true` in the recipe (a pinned view: its panel always keeps one, it cannot be closed or dragged out of that panel). The same `replaceView('nav', 'media')` then leaves the navigation in place and opens `media` as a second tab beside it, in front; swapping back only removes `media`. The plugin code stays the same. To have people land on one view every time they enter the Space (like the built-in Home), set `"mainPage": true` on that item in the recipe's `layout.main` (the default main page, at most one). Switching to the Space, launching into it, or clicking its icon again while already in it then brings that view to the front, with other tabs kept behind it. Without it, the Space restores the way it was last left. Usually pair it with `"pinned": true`. Side-panel tabs show an icon only: give any view that shares a side panel with another an `icon` when registering it (a name from the plugin icon vocabulary, such as `list-view` or `image`), or the tabs all show the same generic icon. Jumping into and out of a project layout makes the host remount the main view. Keep temporary state that must survive that jump at module scope, and clear it only once the person has actually used it (not the first time it is handed to the UI). When closing a project, first clear whatever a new mount would reopen the project from (the view's params, the module's current item, the saved last-opened project — await the save), then tear down the UI and swap the layout.

The right panel follows the main view (2026-10-20+): it holds the Space's pinned views, the group the front main view brings along, and whatever the person opened there themselves. Give a view `rightCompanions` when you register it (an array of full view types, written the same way as in space.json: your own as `plugin:<plugin id>:<view id>`, host views by name such as `chat-panel`, `outline`, `tangu-details` or `workspace`). When that view comes to the front of the main area, the right panel switches to that group and its first entry comes to the front; switching away retires the entries the next group does not have. Opening another file in the same kind of view changes nothing, a collapsed right panel only has its stash updated and does not pop open, and a new tab does not count. A view without `rightCompanions` uses the recipe's `layout.right`, so when your Space opens a host note, chat or PDF (they bring their own groups), `layout.right` steps aside and comes back when you return to your view; mark an entry `"pinned": true` to keep it from stepping aside. Only views that can live in a side panel belong in a group: the main-area `chat`, the note editor and PDF are dropped, so ask for `chat-panel` to get a chat on the right (older recipes with `chat` in `layout.right` are opened as `chat-panel`). At most 4 entries; keep it to 3 or fewer. A group says what this kind of view usually needs; details and forms that open from one row belong in an Extend View. Views the person opens or drags into the right panel themselves are never closed by these rules. Older hosts ignore `rightCompanions`, so keep the right-panel views that matter in `layout.right` too. The left panel does not follow the main view: it belongs to the Space, and its first entry is usually the Space's workspace view, marked `"pinned": true`.

The left-sidebar list (`registerListSource`) can be hierarchical, drawn like the folders of the notes tree. Rows stay one flat array: give a row `parent` (the `key` of the row above it) and mark that row `kind: 'folder'`. Clicking a folder folds or unfolds it instead of calling `open()`; the host remembers which folders are open and unfolds the one holding the currently open row. Search shows matching rows flat, without folders. Static section headings (`group`) fold too. An action marked `primary` in `itemMenu(folder)` becomes the `+` button at the end of the row. To let people rearrange by dragging, mark rows `draggable: true` and add `'items'` to `drop.accepts`; `onDrop({ items }, { item, position })` then tells you which rows moved and whether they landed `before` or `after` a row or `into` a folder, and `canDrop` can refuse a spot by returning false. The host only draws the hint and never moves anything for you: update your own data, then notify the subscriber. Renaming in place works the same way: mark rows `renamable: true` and declare `rename(item, title)` on the source; the host owns the menu entry, the input and the keys (Enter commits, Escape cancels, F2 starts). Older hosts have none of these three. Check `ctx.listCapabilities` and keep emitting flat rows when it is missing, otherwise a folder shows up as an ordinary row.

```js
ctx.listCapabilities?.includes('tree' | 'items' | 'rename')
```

To group rows by whose they are (senders, accounts, sources), also set `folderStyle: 'group'` on the top-level folders: each is drawn like the first-level rows for agents and projects in the Tangu sidebar, led by an avatar (`iconUrl`), an icon in a tile (`icon`) or the first letter of the title, with `hint` as a small pill at the end (good for an unread count). Rows inside a group give up their own icon and keep only the unread dot; a group lists five rows first and puts the rest behind "View more". These groups remember their fold state only until the app restarts: a group with `defaultOpen: true` is open (say, while it holds something unread) and the host reopens it each time the flag turns from false to true; without the flag it starts folded. Groups appear in the order of your array. Search shows no hierarchy, so return flat rows when `query` is set. On a phone, a list whose only level is these group heads stays a full-screen list, and rows inside a group can still be swiped. Check `ctx.listCapabilities?.includes('group')`; hosts without it draw a plain folder.

On a desktop, while the pointer is over a list row, the actions from `itemMenu()` that carry an `icon` line up as icon buttons at the end of the row, next to the "more" menu that still lists every action. They are the same actions, in the same order, as the ones behind the left swipe on a phone, so put the most used ones first and give them icons; an action without an `icon` appears only in the menu. Older hosts show the "more" menu alone.

A list row can have a second line: set `subtitle` and the host draws one dim line under the title (one line only, cut with an ellipsis) — good for "who sent it · first sentence" or a status. Rows without it stay one line high. It takes plain text only, folder rows do not show it, and older hosts ignore the field. The `hint` on the right and the leading icon stay aligned with the first line. The icon vocabulary also gains three source icons: `cloud`, `workflow` and `agent`.

On a phone (the Android native shell) a flat list source — no folder rows, no `parent` — is drawn as the phone's full-screen list, the same parts the session and notes lists use: `groups()` become a row of category chips; a row is an icon block, the title and `hint` on one line, `subtitle` on the next; search sits behind the search button at the top and a pull-down; the actions from `itemMenu()` sit behind a left swipe as round, icon-only buttons; the `primary` action is the main button at the bottom right, with the other `actions` in its long-press menu. So an action may carry an `icon` (a name from the icon vocabulary): a row action without one is left out of the swipe tray (it stays in the long-press menu), and a primary action without one is drawn as a plus sign; give paired actions each their own icon. The vocabulary gained `mail`, `mail-open`, `archive`, `unarchive`, `trash` and `refresh` for this. Sources with a hierarchy stay a tree on a phone (except a list with only one level of group heads, see above). Older hosts ignore `icon`.

When a plugin's bundled Space is missing from the ribbon, check the plugin's card in Settings first: a **Space hidden** badge opens to the Space's name and what it is missing — a view that was never registered, or a newer Forsion version. The most common cause is a plugin that loads without an error yet registers no views: an unclosed function in `main.js` swallowed the `ctx.registerView` calls after it. For a development copy, the Sandbox panel in Coding Studio lists the views the current load registered. You can also ask the agent: the built-in "Forsion extension development" skill ships a plugin checker (`tools/check-plugin.mjs`) that runs `main.js` the way the host does, reconciles the views each Space needs, and points to the line range of registration code that never ran. The checker executes the plugin's code, so use it only on plugins you trust.

Trying a plugin in the sandbox (2026-10-23+, desktop): when you ask the agent to write a desktop plugin, it runs it in the **plugin sandbox** first instead of installing it straight into your Forsion. The sandbox is a separate Forsion on your computer with its own empty vault, signed out and without the Tangu engine, where only this plugin is loaded (as a development copy that reloads when its files are saved). The agent looks at screenshots, reads the plugin's own console and runs the commands it registered. You can try it yourself with **Open sandbox window** on the sandbox card in the chat; if something is off, use **Report a problem** at the top of that window and what you write lands in the input box of the chat that started it. When you are happy with it, **Install in my Forsion** asks you once, then copies the plugin into your plugins folder (without `node_modules`). The sandbox has no engine, so a bundle's engine plugins, agents and skills are tried after installing. Only one sandbox runs at a time, and it stops by itself after 15 minutes without use while its window is not in front. The Sandbox panel in Coding Studio has the same two tiers: **Isolated sandbox** (the default) and **My Forsion**, the earlier loader that puts the development copy straight into the Forsion you are using and is not isolated.

An engine plugin tool declares whether the user is asked first with `capabilities.approval`. Leave it out for read-only tools (never asked). `'command'` puts the tool in the same class as running a command: asked every time in "ask me to approve" mode, and no longer asked once the user picks "always allow" or turns on full access. `'always'` means the user confirms every single call on the approval card themselves: full access, "always allow" and the user's own allow rules cannot skip it, chat and cloud sessions show the card as well, and automations, Muse background runs and remote sessions are refused outright. Use `'always'` for actions that spend something the user owns or send something out on their behalf. Split reading and writing into two tool names and declare it only on the writing one. The card shows the arguments of that call, so keep one call to one action.

Three things are for official plugins only (2026-10-27+): `ctx.cloud` (calls Forsion with the user's Forsion account, limited to two endpoints: the Store's "my listings" and submitting an update), a tool's `capabilities.approvalPreview` (the plugin writes the text on its own approval card), and the tool surface of Chat sessions. Official means the plugin sits in a bundle signed by Forsion: the bundle's root `SIGNATURE` verifies against a public key built into the engine, and the plugin's manifest and entry file are covered by it. For third-party plugins `ctx.cloud` is `undefined`, `approvalPreview` is ignored (the card shows the call's arguments as before), and their tools stay out of Chat sessions.

An engine plugin tool can call `ctx.presentDesk` while it runs to put one of its views on the Agent Desk. It does the same as the model calling `desk_present`, without relying on the model to remember. Present once per run and track it with `ctx.runId` (fall back to `ctx.sessionId` when it is missing). A view without a `name` gets the view title it was registered with. `presentDesk` doesn't exist where there is no Desk, so call it with optional chaining. After the user closes the Desk it won't pop up again until their next message.

```js
ctx.presentDesk?.({ views: [{ type: 'view', view: 'plugin:<plugin id>:<view id>' }], size: 'half' })
```

Parts the host draws for plugins (2026-10-26+): no more copying host CSS, positioning overlays by hand, or strings frozen at registration.

- Dialogs: `ctx.ui.confirm` returns `Promise<boolean>`, and `ctx.ui.openDialog` gives you the host's frame — centered, the host's card look, Escape / backdrop / focus handled by the host; a dangerous action gets a red main button with focus starting on Cancel, and Android shows the native confirmation.

```js
ctx.ui.confirm({ title, body, danger })
ctx.ui.openDialog({ title, body, mount(el), actions })
```

- For a segmented switch or a select in a view head or toolbar, use `ctx.ui.mountControl`: the segmented switch is the same one view modes use, and the select is a 28px text button that opens a list in the menu style (with search from six options on; the native drawer on Android). Settings parts are full rows and don't belong in a toolbar.

```js
ctx.ui.mountControl(el, { type: 'segmented' | 'select', value, options, onChange })
```

- Rows of `ctx.ui.contextMenu` take an `icon` and a `shortcut`, the list takes `{ separator: true }` and `{ section: 'Heading' }`, the first argument can be `{ anchor: button, align: 'end' }`, and on Android the same entries open as the native bottom drawer; older hosts silently drop these fields.
- For a small panel under a button use `ctx.ui.popover(button, { mount(el) })`.
- Icons come from one vocabulary: `space.json`'s `icon`, lists, menus, settings, view tabs, controls and empty states all take the same names, and `ctx.ui.icon(name, { size })` gives your own buttons an `<svg>`; a wrong name is reported once in the console with the closest match.
- A list source can declare `empty: { icon, title, line, action }`: inside your own Space the sidebar then stops saying "Nothing here yet", and the full-screen phone list draws that empty state directly; draw the same one in the main area with `ctx.ui.mountEmptyState(el, …)`.
- A card about a web page (a published link, a local file, a running service) uses `ctx.ui.mountWebCard` (2026-10-28+): the host takes the thumbnail, and the card is the same one the host draws for HTML files and local services.

```js
ctx.ui.mountWebCard(el, { name, status, address, note, thumbnail, actions, menu })
```

- `ctx.ui.setViewHead(el, { title })` gives a view its head row (title on the left, buttons on the right) without needing view modes first.
- Add stylesheets with `ctx.addStyle(css)`; the host removes them on disable and reload.
- `ctx.i18n.define({ zh, en })` returns `t(key, vars)`, and list-source titles, action names, view titles, menus, dialogs, controls and empty states take `() => t('key')` or `{ zh, en }`, so what the host draws for you is recomputed when the user switches language (a plain string is still frozen when you register it).
- Plugins written with React or Vue never get the host's components: mount host parts on a ref with `ctx.ui.mount(name, el, props)` (`menu`, `popover`, `dialog`, `segmented`, `select`, `emptyState`, `webCard`, `icon`, with typed props) rather than bundling copies of the host's menus, overlays, dialogs, icons or i18n.

None of these exist on older hosts, so check with optional chaining.

## Store identity and install folders

The Store gives every listing an ID that never changes. New listings install into `plugins/market-<ID>/`, unrelated to the display name, so display names may repeat. A plugin in such a folder runs under the folder name: engine plugins inside a bundle still mount their routes under it, a standalone engine plugin's id becomes `market-<ID>` with its data under `plugin-data/market-<ID>/`, and the host rewrites its tool names to unique hashed names (two plugins sharing an id never replace each other). Other plugins can still list your manifest `id` in `requiresPlugins` as long as only one copy is installed; for a one-click install from the Store they also need `market: "market-<ID>"`, because the Store matches the exact slug and never guesses from the display name. These listings need a desktop version after 2.13.4; older versions ask the person to update Forsion first. Older listings keep the folder name derived from their display name; for those, a bundle with an engine plugin whose folder name differs from its manifest `id` cannot reach that engine plugin from its pages on desktop 2.13.3 and earlier (every call returns 404, with no error shown).

## Publishing and updates

When you submit, you can add tags (up to 8), a long description, supported platforms (`desktop` / `macos` / `windows` / `linux` / `android` / `ios` / `web`) and a Forsion version range: the minimum is inclusive, the maximum exclusive. `minAppVersion`, `maxAppVersion` and `platforms` in the package manifest take precedence over the form. The Store home filters on them, and desktop and phone check the package manifest again before installing: a version or platform that does not fit is never downloaded or written to disk. Every listing has a public comment section. New comments reach your inbox (the submitting account) and replies also notify the person replied to; you can turn off comment messages for all your plugins or for one, and the comments stay public.

To ship a new version or change the Store details, select your item under Submissions: drop a new ZIP, or for GitHub and npm publish the new version there first and choose "Check for a new version". The version is only ever read from the package or upstream (for skills, `version` or `metadata.version` in SKILL.md) and must be higher than the Store's current one. The package is checked before anything is submitted: you see the type, version, icon and README that were read, and it is submitted only after you confirm. Summary, tags, long description and version requirements can be edited on their own, without a package. Every change to a published item is reviewed; until it passes, the Store keeps showing the current one, and the review result goes to your inbox.

## Secret settings

Engine plugin text settings can declare `secret: true`, and the host renders a password input (a `textarea` also becomes a single-line password input). This masks the UI only: values still use the existing local plugin settings store and the authenticated settings API; no encryption is added. Older hosts ignore this optional field.

## Mini Panel extensions

A Space inside a plugin can declare a dedicated Mini view that offers only quick actions for its current capability; the host's "Show in main panel" carries the current entity parameters. Spaces that haven't opted in don't appear in Mini, and an adapter is withdrawn automatically when its plugin is disabled. See [Mini Panel development](./mini-panel-development.md).

A plugin can also skip the full Space and open a registered compact view directly with `ctx.openMiniPanel?.(viewId, options)`; `mainViewId` sets where "Show in main panel" goes. For a wide standalone tool page, use `ctx.openFloatingPanel?.(viewId, options)`. The host adds the plugin namespace automatically and owns the window lifecycle. See [Floating Panel development](./floating-panel-development.md).

When a View needs an input box with model selection, use `ctx.ui.mountChatBox`; it reuses the host component, and the plugin handles submission explicitly. See [Reusable UI components](./ui-components.md).

Settings-like pages (account, quota and credits, diagnostics, preferences) hand the host a description of the whole page through `ctx.ui.mountSettingsPage(el, { groups })`: each group has an icon, title, description, top-right buttons and items (switch, value, buttons, input, segmented, select, pick-to-run choice, stepper, code with copy, usage meters, empty / loading / error, custom block). The plugin supplies only the text, values and callbacks; the host draws them with its own settings parts and lays them out per device — on phones switches, values and single buttons stay at the right, inputs, steppers and two or more buttons move to the next line, and a pick-to-run choice becomes one button and a half sheet. Put anything outside that list in a `custom` block and mount single parts there with `ctx.ui.mountSettingsItem`. Stop copying the host's settings CSS; hosts before 2026-10-17 lack both methods, so feature-detect and keep your own page there. See [Reusable UI components](./ui-components.md).

To handwrite or circle things on your own content (PDF pages, images), use `ctx.ui.mountBoard` to mount the host whiteboard engine as a transparent layer, and `ctx.ui.boardToSvg` for a static image when you're not handwriting; the viewport and saving belong to the plugin. See [Reusable UI components](./ui-components.md).

A file type that takes over `.pdf` with `override: true` receives every "open this PDF" entry: the file tree, recent items, `[[x.pdf]]` note links, and jumps that carry a page or a quote (`[[x.pdf#page=3]]`, chat citations). Those jumps reach the plugin through `file.onGoto?.(cb)` on `mount(el, file)` as `{ page, quote? }` (desktop versions after 2.13.2; earlier versions send note links and such jumps to the built-in reader). The callback can arrive while the file is still loading or just as a background tab comes back to the front, so hold the target until you can scroll. `![[x.pdf]]` embeds and "Open with the built-in reader" are not taken over.

When a tab goes to the background the host detaches the view's DOM from the document (the view is not unmounted and keeps its state) and re-attaches it when the tab comes back; sizes and scroll positions read as 0 while detached. Desktop versions after 2.13.3 write every scroll container's position in the view back on return, so a plugin does not need to remember it (earlier versions always come back at the top). In the same versions, Cmd / Ctrl + click on the file tree, wikilinks and chat citations opens a file-type view in a new tab, and while the view is shown in the main area the side chat automatically references that file.

Plugins that need a full, persistent chat inside a view (for example the right panel of a creative Space) use `ctx.tangu.mountChat`; the host pins the native chat to one session per plugin and folder, and files the Agent generates land in that folder. See [Reusable UI components](./ui-components.md).

A plugin that wants a "type here, send to a new Tangu chat" box, as Home has, uses `ctx.tangu.mountComposer`: the host mounts the full new-chat composer from Home (attachments, modes, projects, run location, voice and calls included), and when the user presses Send the host creates the session, switches to Tangu and sends it; the plugin can read the draft (`draft()`) but cannot change what is sent.

When a plugin only needs the model to return a piece of text, use `ctx.tangu.complete` (a one-shot call: no tools, no session, on the current chat model). For translation use `ctx.tangu.translate({ text, language })`: the same channel, but on the model the user picked under Settings → Models → Translation. When none is picked, a machine translation model is used if the account has one, and the chat model otherwise (desktop versions up to 2.13.3 go straight to the chat model when none is picked). High-volume work such as sentence-by-sentence translation belongs here; it returns the translation only. Older versions have no `translate`, so feature-detect and fall back to `complete`.

For suggestions at the cursor as the user types (ghost text), use `ctx.tangu.fim({ before, after })` (2026-10-26+): the text before and after the cursor goes verbatim to a completion model (FIM, fill-in-the-middle) with no prompt, and you get the raw model text back (not trimmed) plus the `model` that was used. The model is the one the user picked under Settings → Models → Completion, or the account's first completion model. `maxTokens` is clamped to 1..512 (default 64); `stop` takes up to 4 strings of at most 32 characters. When there is no completion model, or the model or engine cannot do FIM, it rejects with `Error('fim_unavailable')`: fall back to `complete` and remember not to retry for the rest of the session. If the cloud catalog could not be fetched this time it rejects with `Error('fim_catalog_unreachable')` instead: that one is transient, so try `fim` again next time. Together with `complete` and `translate` it is limited to 3 requests in flight per user, so abort the previous request on every keystroke. Older versions have no `fim`; feature-detect it.

Several views of the same thing (Transcript / Notes / Summary, Document / Canvas and so on) are drawn by the host: `ctx.ui?.setViewModes`, where `el` is the element `mount()` received and `modes` is 2–4 `{ id, label, labelEn?, icon? }`. The host draws the switch at the left end of the view's head row and owns ⌥⌘V (Windows / Linux: Ctrl+Alt+V) to the next mode, one "View: X" command per mode in the command palette, icons only when the view is narrower than 480px, a dropdown below 320px, and the top bar on phones. The handle's `actions` is the empty slot at the right end of the same row: move your toolbar buttons there so the whole view keeps one head row; `set(id)` switches from the plugin side (without calling `onChange`). Remember which mode is shown per record or file yourself; the host stores nothing. 2.13.4 and earlier lack the method, so feature-detect and keep your own tabs. See [Reusable UI components](./ui-components.md).

```js
ctx.ui?.setViewModes?.(el, { modes, value, onChange })
```

Hover hints on buttons and icons use the host tooltip: `ctx.ui?.attachTooltip` — it appears after 300ms, neighbours hand the open tooltip over without replaying it, keyboard focus shows it at once, the same look as the host's own buttons. `content` is one or several lines of text; the handle is `{ update, dispose }`, and the host disposes it on plugin disable. Keep `aria-label` on icon buttons and drop their `title`; older hosts lack the method, so keep using `title` there. See [Reusable UI components](./ui-components.md).

```js
ctx.ui?.attachTooltip?.(el, content, { side })
```

Drag-to-reorder and drag-into indicators use the host's too: `ctx.ui?.dropIndicator?.()` returns `{ line, zone, hide, dispose }` taking viewport coordinates; moving to another drop point fades out and in where they are, in the theme's colour, a `key` keeps a scroll from counting as a new drop point, and the host disposes it on plugin disable. Older hosts lack it, so keep drawing your own there. See [Reusable UI components](./ui-components.md). After a drop, `drop.land?.(row or a function that finds it, release point)` glides the dragged row from where it was let go into its new place (2026-10-25+, 160ms; instant with reduced motion).

The selection bar — the strip that appears over selected text — is open to plugins in two halves. First, adding actions: entries from `ctx.registerSelectionAction` are listed under "⋯ → Plugins" on the bar, and the markdown `run(cx)` returns goes to the host's result card (in a note nothing is written until the user picks Replace or Insert below; elsewhere the card is read-only). Without `scope` an action appears in notes only; `scope: 'all'` lists it in every view that has the bar (notes, chat, plugin views that opted in), `'own'` only in the plugin's own views, and an array names views. `when({ view, editable, length })` filters by view and length, and `output: 'none'` means the plugin handles the result itself. Second, using the bar in your own view: `ctx.ui?.mountSelectionBar` gives the view Ask Tangu, Translate and "⋯" from the host next to the tools the plugin declares (icon buttons or colour swatches); a view that does not call it gets no bar. Both halves exist only in desktop versions after 2.13.3. Earlier versions list actions in notes only (under "AI ▾ → Plugins") and have no `mountSelectionBar`, so feature-detect and keep your own menu there. See [Reusable UI components](./ui-components.md).

```js
ctx.registerSelectionAction({ id, title, run })
ctx.ui?.mountSelectionBar?.(root, { tools, source, ask, watch })
```

## Tables and note tasks

Calendar, to-do and habit plugins need to read and edit the tables in your vault and the dated tasks in your notes (`- [ ] Send report @2026-10-20`). A plugin gets them only if its manifest declares `databases` (tables) or `noteTasks` (note tasks); plugins that do not declare them cannot see this data. Once granted, a plugin changing a cell or ticking a task goes the same way as your own edit in the table or the note: open tables update at once, and note-view properties are written into that note. A plugin can undo deleting a row from a classic table; a note-view row is a note, so a plugin can only move it to the recycle bin. The plugin's detail page lists what it declared in one line, "This plugin can: …" (reading the front window through `activeWindow` is listed there too). API details are in the `ctx.databases` / `ctx.noteTasks` section of the plugin development skill.

### Calendar overlays and calendar settings

A calendar plugin also needs the read-only sources the host calendar layers in: Agent schedules, the .ics subscriptions you added, and tables in the vault on the other side (Local↔Cloud), plus your calendar settings (which tables are in the calendar and which columns they use for the date and the done checkbox, colours, hidden sources, and the table new events go into by default). A plugin gets them only if its manifest declares `calendar`; plugins that do not declare it can still only add their own table to the calendar. Once granted, a plugin changing a colour or adding or removing a table in the calendar changes the same settings as the "Calendars" list in the calendar's left panel, for the current vault only; overlays can be read but not changed. While a plugin is subscribed, the host refreshes these sources on schedule for it (.ics subscriptions go online; the timer is shared with an open calendar, so nothing is fetched twice). The same capability lets a plugin add, remove, rename and immediately refresh .ics subscriptions or import a local .ics text; it is the same list as "Subscriptions" in the calendar settings. The detail page line gains "read Agent schedules, .ics subscriptions and calendars in the vault on the other side, manage .ics subscriptions and change calendar settings". Plugins can also open a note and jump straight to a heading (`ctx.app.openNote(path, { heading })`), put one button (such as Undo) on a notification, and, if they declare `databases`, mount the field list from the host's event card (title, time, properties) into their own card with `ctx.ui.mountRecord`; edits go straight back to the table. Dashboard cards and a plugin's own scheduled reminders are not open yet. API details are in the section on the `calendar` tier of `ctx.calendar` in the plugin development skill.

### Spaces and the Ribbon shelf

Launcher and home-style plugins can list your Spaces, open one with a click, show their icons and a status line (continue a chat, the latest note, the next event, unread count), and rearrange the order of Spaces and the shelf folders on the Ribbon from their own view. A plugin gets this only if it declares `spaces`; it changes the Ribbon's own order, so a drag in the plugin moves the Ribbon too, and the other way round. When a Space's icon changes (say its plugin updates), the icon drawn in the plugin changes with it. The detail page gains "open Spaces and rearrange the order of Spaces and shelf folders on the Ribbon". API details are in the `ctx.spaces` section of the plugin development skill.

Three smaller pieces: plugins can read the signed-in name (`ctx.app.watchAccountName`, the nickname if there is one; the name only, never a token), get Bing's daily wallpapers (`ctx.wallpaper.bing`, fetched by Forsion), and open a right-click menu styled like Forsion's own (`ctx.ui.contextMenu`). Long menus scroll when the window is short, and a checklist menu can stay open after a click so you can tick several items in one go.

## Bundled MCP servers, hooks and file events

A plugin can ship its own MCP servers (only ones that run on this computer). Once it is installed and enabled, Tangu gains those tools; disabling the plugin stops them. Settings → MCP lists them with the plugin they come from; to turn them off, disable the plugin in plugin settings. A plugin can also ship hooks that are notified when a session starts, when a tool has run and when an answer ends, for auditing or archiving. These hooks only watch: they cannot block anything or add to the conversation. Settings → Hooks lists them too, marked "Observe only".

Plugins can also receive file events in your vault: files created, deleted, renamed or moved in Forsion, changed by another program or by Tangu, and switching vaults. Backlink and tidy-up plugins use this to keep up with changes without rescanning the vault again and again. For the API, see the plugin development skill's sections on bundled MCP servers and hooks and on vault file events (`ctx.app.onVaultEvent`); how a plugin command hands query results back to Tangu is in the "`invoke`" section.

## IM channels

An engine plugin can bring in another chat app (WeCom, for example) and reuse everything the built-in WeChat, Telegram and QQ channels have: a fresh session on connect, remote approvals, commands such as `/new` and `/model`, inbox forwarding, and the channel folder in the sidebar. Once installed, Settings → Channels shows a card for it; fill in the credentials the plugin asks for and click Connect. Disabling the plugin stops the channel and keeps the sessions it was bound to. For the API, see `ctx.registerChannel` in the engine plugin section of the plugin development skill; the WeCom plugin is a working example.

## Automation triggers

A plugin can add its own "when" to automations: register it with `ctx.automation.registerTrigger`, then call `ctx.automation.emit` when the event happens. Once registered it appears in the "External and plugins" group of the automation canvas trigger node. Users write the rules themselves and can restrict them by hours, weekdays, cooldown and a daily limit. "Remind me directly" costs no budget; "Wake Muse" goes through the usual budget checks.

You can only register inside your own namespace: `id` is a key, and the host builds `plugin:<plugin id>:<key>`. Names need both zh and en. When the plugin is disabled or uninstalled the trigger is unregistered; its rules are kept, paused with a stated reason, and resume once it is back. Events are not saved to disk, so an engine restart loses any a rule has not seen yet. Engine plugins use the same methods on `ctx.sdk.automation`. See `references/tangu-host-apis.md` in the plugin development skill for the code.

## Plugin data sync across devices

A plugin that sets `"syncData": true` in its manifest has the data it saves with `ctx.saveData` synced to your other computers and phones through your Forsion account. When you are signed out or offline, the data stays on this device as before and is uploaded once you are back online. If two devices both changed it, the later change wins. The plugin's detail page has a "Sync plugin data across devices" switch to turn it off on one device. If someone uninstalls the plugin without ticking "Keep settings", the copy in the cloud is cleared too; restoring from the Trash uploads this device's copy again, and any other device that still has the plugin uploads its copy as well. The web version does not sync yet. For the API, see the `loadData/saveData` notes in the editor section of the plugin development skill.

## Startup and icons

Settings → Appearance → Startup and icons lets you upload a brand icon and animated startup artwork, choose Default / Breathing / Spinning / Still, and preview or restore the defaults. The brand icon updates in the app at once; desktop also writes it to the system so it stays after quitting (the Finder / Dock / Launchpad icon on macOS, the Start menu, desktop and taskbar shortcuts on Windows; on Linux only while running). The startup screen takes effect at the next launch, and the installer icon doesn't change. The default startup screen is the built-in Tree shadow (window light and branch shadows on a wall, with one classical verse); it does not follow the app icon and yields only when the user picks startup artwork. The original animated tree logo is under Startup artwork → Built-in → Classic logo, which still follows the app icon. Web and Mobile share the in-app settings; on Android the home screen icon follows built-in icons only (the system only allows switching between icons shipped in the app, and the switch happens after the app is left), uploaded images and plugin icons show only inside the app, and the phone's system launch screen is not part of this entry.

Plugins contribute optional image choices through `ctx.registerAppearance`. The artwork is embedded in the plugin package and cached once selected, so launching needs no network and doesn't wait for the plugin to run; disabling or removing the plugin falls back to the default. A complete sample is in `tangu-agent/skills/forsion-plugin/samples/forsion-sample-appearance/`.

```js
ctx.registerAppearance?.({ id, label, labelEn, icon, splash })
```

Plugin tasks, read-only external engines, isolated Git workspaces, native schedules and the Desktop MCP seams are covered in [Task SDK](./plugin-tasks.md).

## Tool result cards

A plugin with an engine half can give the tools it registers a result card: after Tangu calls such a tool successfully, the chat shows the plugin's card instead of the generic one-line tool record. The card is drawn right in the Forsion interface and follows the theme and text size. Only tools the plugin's own engine half registered can get a card; built-in tools and other plugins' tools cannot (the one exception is hard-coded in the host: the signed Forsion Extend can draw cards for the two built-in tools that publish web pages and list my web pages). From 2026-10-28 a `match` can take only some of a tool's calls (for example when one argument has a certain value). While the tool is still running, when it failed or is waiting for your approval, and while the plugin is disabled or reloading, the generic record shows as before. Cards are still there when you reopen an old conversation.

A card sits in the chat by default, with "Open in Desk" at its top right. A plugin can also declare that a card goes straight into the Agent Desk (for whiteboards and boards that need room); the chat then keeps a placeholder card that says "Showing in Desk", and "Back to chat" moves it back. The ⋯ menu at the top of the Desk has "Move back to chat" too. The plugin keeps state such as zoom and scroll position across moves. On phones, with the Agent Desk turned off, or when the window is too narrow for the Desk, cards always show in the chat. A card can quote part of its content above the chat input, the same as selecting text in a reply and quoting it, and you decide whether to send it; cards cannot write files or send messages for you. For the API, see the "Tool result cards" section of the plugin development skill.

## Summary panel cards

The summary panel on the right of a Tangu chat (desktop versions after 2.13.8-beta.1) is a stack of cards: Progress, Background, Outputs, Sources, Scope and the Agent Desk. A plugin adds a card with `ctx.summary?.registerCard`. It sits in the same stack as the built-in cards; plugin cards start out above the Agent Desk, and the host remembers the order people drag them into. Cards open and close with their content: a card opens by itself when its `count` goes up. When someone opens or collapses a card by hand, that lasts until the current chat turn ends and is not remembered. `defaultCollapsed` decides whether the card stays collapsed while nothing new arrives. When the panel runs out of room, the host first collapses the card that has gone longest without anything new, or makes the last card's body shorter, so do not count on a 240px body. `mount` runs once in each chat's summary panel (switching chats unmounts and mounts again), and `host.sessionId` is the chat this copy belongs to. `host.update({ count, hidden })` sets the count in the card header or hides the card for now. The body is at most 240px tall (less when the panel is short), and the host scrolls anything longer. Only desktop Tangu has the summary panel, so use optional chaining; earlier versions have no `ctx.summary`. For the API, see the summary panel plugin card section of the plugin development skill.

```js
ctx.summary?.registerCard({ id, title: { zh, en }, defaultCollapsed, mount(el, host) })
```

## Intelligent UI cards

A plugin can open an existing list source as a native card in chat by adding an `intelligent` declaration to `registerListSource`. The host renders the list; `items` / `subscribe` / `open` remain the single data and navigation implementation (see the sample code below).

- The host assigns the card ID `plugin:<manifestId>:<sourceId>`; `viewId` resolves only inside the same plugin. Write `description` in English (it is for model discovery) and keep it under 400 characters; older hosts ignore `intelligent`.
- For a list that declares `search: true`, the card can carry an optional `query` (up to 200 characters). The model cannot pass arbitrary props, HTML, CSS, handlers or component names. The compact list shows the first six items; the rest are in the full view.
- The host draws the card frame, so there is nothing to style. The header shows your plugin's icon, `plugin name · list name` (manifest `nameEn` in the English interface; when one name already contains the other, only the longer one is shown), a "Live" dot, and a button that opens the full view; a title the model writes for the block is not shown. Each row shows the item's `title` and `hint`, and its leading icon uses the item's own `iconUrl`, falling back to `icon` and then a generic link icon, exactly as in the sidebar list — set both so rows stay recognisable.
- Agents discover the current catalog with `list_intelligent_cards`, then reference it with an `app-card` block in `intelligent_ui`. The request carries metadata only: showing a card does not send its records to the model and does not save generated plans; analysis and writes still go through authorized domain tools and skills, and the native plan approval flow is unchanged.
- Subscribe on mount and read again once the vault is available; notify on data changes and return an unsubscribe function. Cards resubscribe when the vault changes. Disabling the plugin removes the source from the catalog, unmounts existing cards and shows "Unavailable"; unknown or disabled cards are never replaced with generated content, and an exception in the plugin only affects that one card. A card is a live view of the current vault (including when an old conversation is reopened), not a historical snapshot or a cross-device copy of the data.

```js
ctx.registerListSource({
  id: 'library-list',
  title: t('viewLibrary'),
  search: true,
  intelligent: {
    description: 'Live saved bookmarks. Optional title/author search. Opens existing entries; does not save or analyze links.',
    viewId: 'folder',
  },
  items: ({ query } = {}) => cachedItems.filter(item => matches(item, query)),
  subscribe: listener => subscribeAndReload(listener),
  open: item => openExistingEntry(item.key),
})
```

### Cloud settings groups

First-party built-in bundles' `registerSettingsView` pages may set `parent` to a top-level page ID in the same plugin. The host lists only the parent in the sidebar, and tabs above the content switch between the parent page and its children. The parent is the default tab, and `tabTitle` supplies its tab label while `title` remains the sidebar page name. Both labels may be functions so they follow the language. `aliases` maps old page IDs, with real IDs taking priority; `keywords` supplies Chinese and English search aliases for settings search. Missing, cross-plugin or cyclic parents remain standalone entries rather than being hidden silently. The mount/unmount contract is unchanged, and switching tabs still calls the existing mount / dispose. Older hosts ignore these optional metadata fields and keep showing flat pages.

```js
registerSettingsView({ category: 'forsion', ... })
```

### Seams used by the Guide

Since 2026-10-17 the host offers a few more seams (added with the Guide Space in Forsion Extend):

- `ctx.app.openSpace?(id)` switches to a Space and resolves once its layout is built; an unknown id returns `false`.
- `ctx.app.openLink?(url)` opens a `forsion://` link inside the app. It only navigates, never runs anything. `forsion://` links in plugin pages, inbox letters and note text are already handled inside the app without going through the system.
- `ctx.app.runCommand?(id)` runs an existing command-palette command. **First-party built-in bundles only**; for any other plugin it returns `false`.
- `ctx.app.spotlight?` (since 2026-10-19, **first-party built-in bundles only**) rings one spot the host has marked in the real interface (anchors: `ribbon-spaces`, `chat-composer`, `note-new`, `note-body`, `note-canvas`, `agent-new`) and shows a small card beside it with the step and what to do. It doesn't dim the screen or block clicks, and only one spot shows at a time; if the target sits in a collapsed sidebar, the host opens that sidebar first. The returned promise gives the result: `ok` (Got it / Esc), `mute` (Don't show again; the plugin should remember it and not ring it again), `gone` (the target disappeared), `missing` (unknown anchor, still not on screen after 2 seconds, or not a first-party bundle) or `replaced` (a newer spotlight took over); pass `null` to close it, which gives `closed`. Older hosts don't have the method, so call it with `?.` and fall back to the old behaviour.

```js
ctx.app.spotlight?({ anchor, title, body?, step? })
```

- `ctx.achievements.count?(event, { own? })` / `subscribe?(cb)` / `isClaimed?(id)` / `claim?(id)` read achievement counters (official events by default, read-only; other plugins' counters can't be read), call back when counters or claims change, and read or claim achievements in your own series.
- `ctx.inbox` (**first-party built-in bundles only**): `post({ title, body })` sends a local system message, `archive(id)` archives one, and `registerCard({ sender, mount })` draws your own card under your letters and sets the sender's display name.
- The list icon vocabulary gains `circle` (not done), `circle-check` (done) and `lock` (locked) for progress lists. `todo` is the block menu's to-do icon and already shows a tick, so don't use it for "not done".

### Seams used by the cloud drive

Since 2026-10-18 (added with the cloud drive in Forsion Extend's Penzor Cloud):

- `ctx.app.setSpaceProgress?(spaceId, progress)` draws a progress ring around your own Space's icon in the Ribbon. It only accepts a Space bundled with your plugin; for anyone else's or a built-in Space it returns `false`. `progress` is `0`–`1`; pass `null` to remove it. The host draws whole percents, so frequent updates don't re-render the Ribbon. An unread badge on that Space is shown first, and the host clears the ring for you when your plugin is disabled. A Space tucked into a Ribbon folder or the "⋯" overflow shows no ring.
- The list icon vocabulary gains `hard-drive` for drive and storage rows. Older hosts lack this icon: tell old from new by whether `ctx.app.setSpaceProgress` exists, and fall back to `archive` on old ones.

### Penzor Cloud's icon

Since 2026-10-23:

- The `icon` library for `space.json` gains `cloud`; the full list of 30 is in the forsion-plugin skill's `samples/forsion-sample-space/README.md`. Older hosts don't know it and fall back to the boxes icon.
- The list icon vocabulary gains `penzor`, Penzor Cloud's own icon (an auspicious cloud), for Penzor Cloud's views. Other plugins shouldn't use it to mean anything else. Older hosts fall back to the default icon.

### Seams used by Server Admin

Since 2026-10-19 (added when Server Admin started flagging the feedback center):

- `ctx.app.setSpaceDot?(spaceId, on)` puts an attention dot on the top-right of your own Space's icon in the Ribbon, in the same red as the inbox unread badge. Pass `true` to show it and `false` to remove it. It only accepts a Space bundled with your plugin; for anyone else's or a built-in Space it returns `false`. If the Space has both a dot and a progress ring, only the dot is drawn; an unread badge is shown first. The host clears the dot for you when your plugin is disabled. While the dot is shown, the icon's accessible name says it has new activity.
- Unread rows in a list still use `ListItem.unread` (the shared unread dot, drawn in the theme's indicator colour rather than red). To make it noticeable from other Spaces too, pair it with `setSpaceDot`.
- `ctx.app.sync?` (since 2026-10-20, **first-party built-in bundles only**; used by Penzor Cloud's Sync page) reads and changes this computer's three cloud sync items. `get()` returns a snapshot (whether the vault, agents & memory, and plugin data are each on, first-sync progress, and the pending merge question when the cloud already holds a copy from a second computer); `subscribe(fn)` notifies on change; `refresh()` re-reads; `set(kind, on)` turns one item on or off (`notes` / `agents` / `plugins`); `resolveNotes('merge' | 'cloud' | 'skip')` answers the merge question; `runNow()` syncs once right away. The host owns the switches and the sync engines; the plugin only draws the page. For ordinary plugins, on phones and on the web, the whole member is absent.

### Popup queue

Since 2026-10-19 (added when Extend's announcements, the host's terms update notice and What's new could pile up):

- `ctx.app.queuePopup?()`: a popup your plugin opens on its own (a startup announcement, a reminder and the like, not a panel the user just clicked open) should queue first. Only one popup shows in the app at a time: the terms update notice and What's new go first, plugin popups come after them, and popups at the same level show in arrival order. Nothing shows while the full-screen onboarding is open.
- It returns `{ ready, done }`. Show your popup after `await ready`, and call `done()` when it closes to make way for the next one. If you decide not to show it after all (the account changed, the data is stale), call `done()` too: that withdraws it, and `ready` never resolves.
- Until you call `done()` your popup holds the queue and nothing after it can show; the host clears it for you when your plugin is disabled. Older hosts don't have this method: show the popup straight away, as before.

```js
const turn = ctx.app.queuePopup?.()
if (turn) await turn.ready
showMyDialog({ onClose: () => turn?.done() })
```

## On-demand native main companions

`registerView` can declare `mainCompanions`. `amadeus-editor` / `chat-panel` are supported, keys start with the plugin id plus `-`, and there are at most three entries. `view.setCompanionsVisible?.(true)` on the view's mount context expands them on demand; `false` folds these native views into this view's tab group, keeping the document content, chat drafts and split sizes. Narrow windows and phones use native tabs. Other views are never closed or rewritten, and the Space is not rebuilt. Older hosts lack this method, so important reading layouts can still stay in the Space recipe.

```js
mainCompanions: [{ type: 'amadeus-editor', key: 'my-plugin-document', split: 'right' }]
```

Local hosts may also provide `ctx.app.writeFileScoped`: it validates the active vault inside the main process's file lock and rejects writes from an old task after a vault switch; with `create:true` it returns false for an existing file and never overwrites it. A normal write returns true. When the method is absent, the plugin must recheck the vault at every async boundary and must not claim main-process scope protection.

```js
ctx.app.writeFileScoped?.(path, text, expectedRoot, {create:true})
```

`ctx.app.migrateWorkFolder?` is a one-time local upgrade migration into the plugin's default `Plugins/<plugin ID>` folder. The plugin owns the schema and path rewrites; the host owns validation, exclusive copying, committing after comparing the index, and recovery from interruptions; the original folder stays as a backup. A request supplies an upgrade `id`, the captured `expectedRoot`, the legacy vault-root or `Plugins/<previous name>` `source`, the default `target`, and an optional `plan`: the exact index text `before`/`after`, source text edits (`path`, `before`, `after`) and the referenced nonempty `requiredFiles`. Without a plan it only queries / reconciles the per-vault journal. The plugin validates its own schema and refuses when both sides hold data; the host validates snapshots, rejects symlinks and path traversal, copies without overwriting, verifies hashes, then publishes the index under the shared text lock. A completed journal never re-imports deleted entries. A manually set work folder rejects automatic migration; unsupported hosts (web, mobile, cloud) omit this method, so the plugin must keep an explicit recovery entry.

Default folders use the stable English plugin ID and don't change with the display name or language. External manifest IDs must match `^[a-z0-9][a-z0-9-]{0,63}$`; use English words for new IDs and keep published IDs stable. Store installs use the immutable `market-<UUID>` as the effective ID, which may differ from the manifest ID or a historical install-folder alias; call `workFolder()` rather than building the identity folder yourself. Plugins without migration support keep reading their existing display-name folders. To migrate, first feature-detect both APIs, get the new default folder with `workFolder({ preferId: true })`, validate your own data, then wait for the migration to finish. A folder the user set manually always takes precedence.

A status query without a plan can reconcile the migration journal of the previous display-name folder; write plans for an old target are still rejected, and manual preferences and vault / revocation checks still apply. Before migrating, bare media links are resolved against the original vault as they actually resolve there, keeping user-added attachments where they are (beside notes) instead of assuming an `assets/` location.

### Personal calendar (Desktop 2.13.6+)

Plugins that declare both `databases` and `calendar` receive `human://CALENDAR.db` when the local engine provides a personal calendar. Calendar members list it first and hide its old vault mirror. Pass this opaque reference unchanged to `ctx.databases`, `ctx.ui.mountRecord` and `ctx.app.mutateDb` (for schema / name changes); never hand it to filesystem read/write APIs. Membership and the date / done column mapping are managed by the host: `setMember` / `removeMember` return false, and hiding uses `setHidden`. Plugins with only the `databases` capability cannot access it; remote or mobile hosts without this source don't list it. Writes reuse the host's CAS and conflict replay.

### Shared account

Unit web account hosts and the mobile app may provide `ctx.account`. Check that it exists before using `status()`, `login()`, `logout()`, `request(path, init)` and `subscribe(listener)`. `request` only reaches the account API and accepts no other origin; the host supplies credentials and preserves FormData/Blob file uploads. Switching accounts cancels old requests and makes reads from old response bodies fail; plugins must still cancel their own deferred tasks and clear the previous account's UI. The optional `saveDownload(blob, name)` returns `{ ok, error? }`: Android saves to the system Downloads, and browsers save a download file. Never store, import or forward account tokens.

### External PDF file views (2026-10-29, feature branch)

Set both `external: true` and `override: true` to handle external PDFs opened with the operating system's Open With action on desktop hosts that support this API. Default opener preferences still apply. Cold startup waits for initial plugin loading. Older hosts and plugins without `external` keep the built-in preview.

For an external PDF, `mount(el, file)` receives `file.io`: `readBytes(path)` reads this PDF or its adjacent `.<filename>.annot.json`; `writeBytes(path, bytes)` writes only that annotation sidecar or a `.broken-<timestamp>` recovery copy. The source PDF remains read-only. `saveCopy(name, bytes)` shows the native Save As dialog, returns the saved name or `null` on cancellation, and refuses to overwrite the source. The general `ctx.app` file APIs remain vault-scoped. Surface write failures when the source directory is read-only.

A file-type cleanup may return `Promise<void>`. Closing a tab waits for its final save before revoking `file.io`; disabling the plugin still revokes immediately. When multiple tabs share a document, discard the handle belonging to a closed tab. External files are not imported into a vault or sent through note storage.
