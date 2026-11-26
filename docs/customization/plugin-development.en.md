---
title: Plugin development
description: Write desktop plugins and engine plugins for Forsion: layout, list sources, approvals, host parts, cards and other extension points.
---
# Plugin development

For plugin authors. Installing plugins, bundles and the security model are covered in [Plugins](./plugins.md).

## Getting started

Plugins are written in JavaScript / TypeScript, with official type definitions and templates. The built-in "Forsion extension development" skill lets the agent scaffold a plugin, theme, Space or agent straight from the official templates; see [Skills](../agents/skills.md).

Engine plugins can expose live, read-only external skills through `registerSkillProvider` without copying them into the user's skills directory. See the [external skill provider contract](plugin-skill-providers.en.md).

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

When a folder is also something to select (a parent tag, say), set `opensOnClick: true` on the folder row and detect it with `ctx.listCapabilities?.includes('folderOpen')`. Clicking the name calls `open()` and unfolds the row, only the leading arrow folds it, and the row highlights when `activeKey` points at it. Older hosts ignore the field and a click only folds, so keep a child row when the capability is missing.

To group rows by whose they are (senders, accounts, sources), also set `folderStyle: 'group'` on the top-level folders: each is drawn like the first-level rows for agents and projects in the Tangu sidebar, led by an avatar (`iconUrl`), an icon in a tile (`icon`) or the first letter of the title, with `hint` as a small pill at the end (good for an unread count). Rows inside a group give up their own icon and keep only the unread dot; a group lists five rows first and puts the rest behind "View more". These groups remember their fold state only until the app restarts: a group with `defaultOpen: true` is open (say, while it holds something unread) and the host reopens it each time the flag turns from false to true; without the flag it starts folded. Groups appear in the order of your array. Search shows no hierarchy, so return flat rows when `query` is set. On a phone, a list whose only level is these group heads stays a full-screen list, and rows inside a group can still be swiped. Check `ctx.listCapabilities?.includes('group')`; hosts without it draw a plain folder.

On a desktop, while the pointer is over a list row, the actions from `itemMenu()` that carry an `icon` line up as icon buttons at the end of the row, next to the "more" menu that still lists every action. They are the same actions, in the same order, as the ones behind the left swipe on a phone, so put the most used ones first and give them icons; an action without an `icon` appears only in the menu. Older hosts show the "more" menu alone.

A list row can have a second line: set `subtitle` and the host draws one dim line under the title (one line only, cut with an ellipsis) — good for "who sent it · first sentence" or a status. Rows without it stay one line high. It takes plain text only, folder rows do not show it, and older hosts ignore the field. The `hint` on the right and the leading icon stay aligned with the first line. The icon vocabulary also gains three source icons: `cloud`, `workflow` and `agent`.

On a phone (the Android native shell) a flat list source — no folder rows, no `parent` — is drawn as the phone's full-screen list, the same parts the session and notes lists use: `groups()` become a row of category chips; a row is an icon block, the title and `hint` on one line, `subtitle` on the next; search sits behind the search button at the top and a pull-down; the actions from `itemMenu()` sit behind a left swipe as round, icon-only buttons; the `primary` action is the main button at the bottom right, with the other `actions` in its long-press menu. So an action may carry an `icon` (a name from the icon vocabulary): a row action without one is left out of the swipe tray (it stays in the long-press menu), and a primary action without one is drawn as a plus sign; give paired actions each their own icon. The vocabulary gained `mail`, `mail-open`, `archive`, `unarchive`, `trash` and `refresh` for this. Sources with a hierarchy stay a tree on a phone (except a list with only one level of group heads, see above). Older hosts ignore `icon`.

When a plugin's bundled Space is missing from the ribbon, check the plugin's card in Settings first: a **Space hidden** badge opens to the Space's name and what it is missing — a view that was never registered, or a newer Forsion version. The most common cause is a plugin that loads without an error yet registers no views: an unclosed function in `main.js` swallowed the `ctx.registerView` calls after it. For a development copy, the Sandbox panel in Coding Studio lists the views the current load registered. You can also ask the agent: the built-in "Forsion extension development" skill ships a plugin checker (`tools/check-plugin.mjs`) that runs `main.js` the way the host does, reconciles the views each Space needs, and points to the line range of registration code that never ran. The checker executes the plugin's code, so use it only on plugins you trust.

Trying a plugin in the sandbox (2026-10-23+, desktop): when you ask the agent to write a desktop plugin, it runs it in the **plugin sandbox** first instead of installing it straight into your Forsion. The sandbox is a separate Forsion on your computer with its own empty vault, signed out and without the Tangu engine, where only this plugin is loaded (as a development copy that reloads when its files are saved). The agent looks at screenshots, reads the plugin's own console and runs the commands it registered. You can try it yourself with **Open sandbox window** on the sandbox card in the chat; if something is off, use **Report a problem** at the top of that window and what you write lands in the input box of the chat that started it. When you are happy with it, **Install in my Forsion** asks you once, then copies the plugin into your plugins folder (without `node_modules`). The sandbox has no engine, so a bundle's engine plugins, agents and skills are tried after installing. Only one sandbox runs at a time, and it stops by itself after 15 minutes without use while its window is not in front. The Sandbox panel in Coding Studio has the same two tiers: **Isolated sandbox** (the default) and **My Forsion**, the earlier loader that puts the development copy straight into the Forsion you are using and is not isolated.

Since 2026-11-03 the sandbox also works like this: only this plugin is loaded, and of the built-in plugins only those it lists in `requiresPlugins` (list Forsion Extend there if you depend on it). The ribbon shows only this plugin's Spaces and the window opens on its first Space; the window title reads "Forsion sandbox · plugin name". The agent can use the plugin the way a person does: read which buttons and fields are on screen, click, type, press keys, scroll and switch Spaces, looking at a screenshot and at the console lines and toasts after each step. When something needs a file, it prepares test files from the plugin folder first, so clicking **Choose file** does not open the system picker. The chat that started the sandbox also gets a sandbox card in the summary panel on the right: the thumbnail is the agent's latest screenshot (click it to open the sandbox window), with the number of views, the Space, console errors and the last step below it. When the sandbox stops the card turns grey; **Start again** brings it back.

Since 2026-11-15 (with a desktop from the same release): when the agent reads the sandbox window it sees whether a toggle is pressed and whether a field or note is read-only (a note in reading mode, for example), and checks a toggle's state before clicking it; when a notification covers what it wants to click, the notifications are closed first; when a plugin command opens its own dialog and is still running, the agent doesn't run it again but reads the window and carries on in the dialog; and the agent can open this plugin's page in Settings (a separate settings window in the sandbox: its page under Settings → Plugin settings when it has settings, otherwise its detail page under Settings → Plugins) to fill in settings and press Save.

An engine plugin tool declares whether the user is asked first with `capabilities.approval`. Leave it out for read-only tools (never asked). `'edit'` (2026-11-26+) puts the tool in the same class as editing a file: asked only in "Ask for approval" mode, and done directly in "Approve for me" and "Full access". Use it for write tools that only change the plugin's own data and take no path (saving a draft, exporting a picture); older engines don't know it and treat it as left out (never asked), so check `ctx.toolCapabilities?.approvalEdit` first and declare `'command'` when it is missing, or the tool writes without asking in "Ask for approval" on an older engine. `'command'` puts the tool in the same class as running a command: asked every time in "Ask for approval" and "Approve for me", and no longer asked once the user picks "always allow" or turns on full access. `'always'` means the user confirms every single call on the approval card themselves: full access, "always allow" and the user's own allow rules cannot skip it, chat and cloud sessions show the card as well, and automations, Muse background runs and remote sessions are refused outright. Use `'always'` for actions that spend something the user owns or send something out on their behalf. Split reading and writing into two tool names and declare it only on the writing one. The card shows the arguments of that call, so keep one call to one action.

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
- Icons come from one vocabulary: `space.json`'s `icon`, lists, menus, settings, view tabs, controls and empty states all take the same names, and `ctx.ui.icon(name, { size })` gives your own buttons an `<svg>` (on a name's first use its paths arrive in a microtask, so call it again for each copy rather than cloning); a wrong name is reported once in the console with the closest match.
- A list source can declare `empty: { icon, title, line, action }`: inside your own Space the sidebar then stops saying "Nothing here yet", and the full-screen phone list draws that empty state directly; draw the same one in the main area with `ctx.ui.mountEmptyState(el, …)`.
- A card about a web page (a published link, a local file, a running service) uses `ctx.ui.mountWebCard` (2026-10-28+): the host takes the thumbnail, and the card is the same one the host draws for HTML files and local services.

```js
ctx.ui.mountWebCard(el, { name, status, address, note, thumbnail, actions, menu })
```

- When your plugin runs a local service with its own web UI (the DSH fusion plugin's workbench), `ctx.ui.mountWebSurface(el, { url })` (2026-11-15+, desktop only) puts that page in your view: a top-level page Forsion owns, so the service's own sign-in cookie works. It loads only loopback addresses, keeps cookies in your plugin's own partition, moves only within its own origin and gets no Forsion API. The returned `navigate('#…')` only changes the fragment of the page's current address (same page, no reload).
- For agents that run on an external engine, `ctx.registerEngineHarness?.({ engineId, rows, sessionActions })` (2026-11-15+, desktop) adds rows to the Harness card (runtime, update channel and so on) and items to those conversations' right-click menu; Forsion itself draws only "Runs on". Those menu items can also be the button of an engine notice: when a resident engine (`ctx.registerResidentEngine`) sends the `_forsion/notice` ACP extension notification, Forsion puts the sentence in the conversation's approval tray and the item whose id matches `action.id` becomes its button (the DSH fusion plugin's "DSH is waiting for your approval in the workbench" + "Open the workbench"). A resident engine can also provide `modelSeesImages(model)` (2026-11-16+): it answers whether the session's current model takes images, and computer control handed to the engine runs only when it answers `true`; otherwise Forsion tells the model that this model cannot see the screen. `registerEngineHarness` can also take `railView` (2026-11-16+): the id of a view you register. While the conversation in the main area runs on that engine, Forsion adds the view to the right sidebar after Details, Files and Outline; it does not take the front tab and closes when the user moves to a conversation that runs elsewhere. The view follows the active conversation with `ctx.tangu.subscribeAgentStatus`, so a main tab pinned to another conversation does not get it (the DSH fusion plugin's DSH page in the right sidebar).
- `ctx.ui.setViewHead(el, { title })` gives a view its head row (title on the left, buttons on the right) without needing view modes first.
- Add stylesheets with `ctx.addStyle(css)`; the host removes them on disable and reload.
- `ctx.i18n.define({ zh, en })` returns `t(key, vars)`, and list-source titles, action names, view titles, menus, dialogs, controls and empty states take `() => t('key')` or `{ zh, en }`, so what the host draws for you is recomputed when the user switches language (a plain string is still frozen when you register it).
- Plugins written with React or Vue never get the host's components: mount host parts on a ref with `ctx.ui.mount(name, el, props)` (`menu`, `popover`, `dialog`, `segmented`, `select`, `emptyState`, `webCard`, `icon`, with typed props) rather than bundling copies of the host's menus, overlays, dialogs, icons or i18n.

None of these exist on older hosts, so check with optional chaining.

## Where host UI data comes from (2026-11-23)

Before a plugin mounts a host surface or calls a host API, know four things about it. When Tangu writes a plugin it hands in a one-page plan first, and this table is the source for the plan's "host data it depends on" part (the skill carries the same table as `references/host-data-sources.md`). For every host surface or mount your plugin uses, it answers four questions: what it reads, what it does to the user's data or sessions, whether it exists in the plugin sandbox and the demo stage (and how to seed demo data there), and whether it needs the **local managed engine**. Checked against desktop source on 2026-11-23; paths are in the Genesis repo, `FE` = `desktop/frontend/src`, `PS` = `FE/amadeus/plugins/pluginStore.ts`.

Source categories: **vault** (the user's open note library), **engine `human/`** (files in the Tangu engine's home, served by `/agent/human/*`), **plugin data** (`ctx.loadData` / `saveData`, and the plugin data folder `ctx.storage`), **host memory** (state inside the running app, gone on restart), **cloud** (the user's Forsion account).

### The local managed engine gate

The desktop runs the Tangu engine either itself ("managed", the default install) or connects to one started elsewhere ("external"). Some plugin APIs only work with the managed engine on this computer. There are two separate checks:

- **The desktop's gate** `hostExecution()` (`FE/tanguProbe.ts:553`): `window.tangu.executionCapabilities.host ?? (desktopConfig.mode === 'managed')`. On the desktop only the mode decides; web and mobile hosts set `host` themselves (mobile: `false`). The methods below stay present on `ctx`; they are only **callable** when the gate passes.
- **The engine's own authorization** of some routes (its `hostExec` and whether the request is remote). It applies whatever the desktop's mode, so an engine that is not local refuses even a correct call.

| API | Gate | When refused |
|---|---|---|
| `ctx.tangu.request(...)` | desktop gate, then the engine's route check | **throws** `A local engine is required` (before waiting for the engine) or `Local engine is unavailable` after the wait (PS:3003, :3011); the engine itself answers 403 `Local plugin routes only` for a non-local or remote request (`tangu-agent/src/plugins/bootstrap.ts:217-229`) |
| `ctx.tangu.connectChannel(...)` | desktop gate | returns `{ ok: false, error }` with the same two messages, never throws (PS:3023-3044) |
| `ctx.app.hostPath(rel)` | desktop gate | returns `null` silently; also `null` with no open vault, a cloud vault, or an absolute / `..` path (`FE/amadeus/plugins/hostPaths.ts:2-9`) |
| `ctx.storage.hostPath(path)` (2026-11-26+) | desktop gate | resolves `null` (also on mobile and after the plugin is turned off); an invalid path still rejects |
| `ctx.tangu.startChat({ folder })` | via `hostPath` | the folder is **dropped silently** and the chat gets the normal workspace selection (work mode may still pick a default project) (PS:3131-3132) |
| `ctx.tangu.mountChat(el, { folder })` | via `hostPath` | with no engine connected: `engine is not connected` first; with an engine but no host path: `folder is not available on this host: <folder>` in `ready.error`, and the mount shows a localized message; no session is made (`FE/views/pluginChat.tsx:48-53`) |
| personal calendar `human://CALENDAR.db` | the engine (calendar I/O goes straight to the configured engine, not through the desktop gate) | a non-local real engine answers 404 `HUMAN_LOCAL_ONLY` → `myCalendar: 'absent'`; no engine reachable → `'unknown'` (`FE/amadeus/store/humanCalendarIo.ts:44-60`, `tangu-agent/src/routes/human.ts:80-93`). The stage's scripted engine serves it although the stage is in external mode |

**The gate itself logs nothing** (no console line, no diagnostics entry); only an error that escapes your `setup` is recorded, as a setup error. A polling loop that swallows the error leaves only an empty view. So: catch the error, show its message in your view, and say in your plan and README that the engine half needs the local managed engine. `workPath` does not exist; `ctx.app.workFolder()` always returns a string (the user's choice, `Plugins/<id>`, or an existing legacy `Plugins/<display name>` folder), even with no vault, so it is not an availability probe.

### Surfaces and mounts

| API | Reads | Side effects | Sandbox / stage | Managed engine? |
|---|---|---|---|---|
| `ctx.tangu.mountChat(el, { agent, folder, title })` | an **engine session**, one per (plugin, absolute working folder). The slot → session id map is in localStorage `tangu.pluginChats`. On mount it resumes that session; if it was deleted (404) or archived it **creates a new real session** (`FE/views/pluginChat.tsx:35-103`) | creates sessions that appear in the user's chat list; writes localStorage. **You cannot inject messages**: the handle only has `quote()` (the app-wide quote slot) and `prefill()` (the draft); the user sends. To write history use `ctx.tangu.importSessions` (capability `agentImport`), which makes separate sessions | sandbox: no engine → after 15 s `engine is not connected`. Stage with `engine: 'scripted'`: works without `folder`; sessions live in the replay engine's memory, and it does not reproduce the deleted-session recovery (an unknown id gets a 200 without a session, not a 404). With `folder` it fails (no host path) | engine: yes; managed engine: only with `folder` |
| `ctx.tangu.mountComposer` | Tangu's new-chat composer; `prefill` fills the new-chat draft only if empty (`FE/tanguProbe.ts:467-492`) | the host sends, your `draft()` is read-only | unverified | no |
| `ctx.tangu.startChat` | host app state; opens a visible new chat; `send: true` only for an Agent your plugin seeded, otherwise it prefills (PS:3114-3143) | changes what the user sees in the main area; an allowed `send: true` sends the prompt and **starts a run** (`FE/tanguProbe.ts:405`) | `folder` dropped (see the gate) | only for `folder` |
| `ctx.ui.mountChatBox` | with `modelPicker: false` it **still subscribes** to the host's default model and the Agent list, then ignores them: the model you get is `options.modelId ?? ''` (`FE/amadeus/plugins/chatBoxSurface.tsx:235-260`). `@page` mentions read the vault's page list | none; `onSubmit` is yours | works wherever there is a DOM | no |
| `ctx.ui.mountRecord` | a **vault `.db` table**; needs capability `databases` and throws unless the path is a table in the **open vault** (PS:2453-2492). `human://CALENDAR.db` also needs `calendar` | edits the row in the user's table | the table must already be **loaded**, not just written: wait until it shows up in `ctx.databases.subscribe` before mounting. Sandbox: the vault starts empty. Stage: fixture tables, after they load | only for the personal calendar |
| `ctx.ui.mountMarkdown` (read-only) | the chat Markdown renderer. Every `[[name]]` in prose becomes a link that **subscribes to the vault's page list** to resolve it, and may also point at chat sessions and files (`FE/components/ChatWikiLink.tsx:40-53`); clicking opens the target. Code spans stay inert | none on data; links into the user's notes | links show unresolved with no vault | no |
| `ctx.ui.mountMarkdownEditor` | default: no vault (no `[[` completion, links inert). `vault: true`: completes and opens links from the current vault (PS:2493-2532) | only `onChange`; you store the text | fine without a vault | no |
| any plugin view (`registerView` mount) | on mount the host calls `ensureAmadeusReady()`, which **reopens the user's last vault** (`FE/pluginViews.tsx:74-78`, `FE/amadeusPlugins.ts:160-171`) | may open the last vault; it restores asynchronously, so `vaultRoot()` can still be `null` right after mount | sandbox: its own empty `vault/`; stage: the copied fixture vault | no |
| `ctx.calendar` / "My calendar" | members and colours: host config keyed by vault (`ensureMember` waits for a vault); the personal calendar is **engine `human/CALENDAR.db`** via `GET/PUT /agent/human/CALENDAR.db`, never a vault file (`FE/amadeus/store/humanCalendarIo.ts:15-60`) | `ensureMember` writes calendar config; subscribing starts overlay refreshes and may save default colours and migrate members; `ctx.databases` / `mountRecord` writes to the personal calendar need both `calendar` and `databases`, but `ctx.calendar.events` can remove or reschedule its rows with `calendar` alone (`FE/amadeus/plugins/pluginCalendarEvents.ts:43`); a real engine write may also update the old vault mirror of the calendar | sandbox and stage with `engine: 'none'`: `myCalendar: 'unknown'`. Stage with `engine: 'scripted'`: serves `<fixture>/human/CALENDAR.db` (see "Demo stage: `ctx.stage`" below); absent = empty calendar; edits stay in that stage | the real engine: yes; the stage's replay engine: no gate |
| `ctx.databases` | every vault `.db` and folder note view; plus the personal calendar when `calendar` is declared. Capability `databases` | writes cells / rows like the UI does | sandbox: empty; stage: fixture tables | only for the personal calendar |
| `ctx.noteTasks` | `@` task marks in vault Markdown. Capability `noteTasks` | `update` rewrites that line of the note | vault-dependent | no |
| `ctx.table.mount` | only the spec you pass (read-only rows in memory) | none | works | no |
| `ctx.dashboard` | `mount`: an in-memory page store, never the vault; layout comes back through `onLayout`. `source`: compiles the recipe (and optional `existingFileText` you pass) into `.dashboard.md` text, no vault I/O; writing that file is up to you | `mount`: none | `mount` works with no vault | no |
| `ctx.ui.mountBoard` | only your `scene` / `viewport` | none | works | no |
| `ctx.loadData` / `saveData` | plugin data: `<forsion home>/plugins-data/<id>.json` in the main process; `syncData: true` plugins also sync through the cloud. Unreadable data **rejects** (`plugin-data-unreadable`), never-saved gives `null` (PS:2390-2429) | writes the file; may sync | sandbox: its own empty home; stage: plugin data is **not** copied in | no |
| `ctx.storage` (2026-11-26+) | the plugin data folder, outside the vault: desktop `~/.forsion/tangu/plugin-data/<plugin ID>/` (the same folder as a same-ID engine plugin's `paths.dataDir`); `vault()` is a per-library subfolder `vaults/<key>/`. Not synced. Missing file → `null` / `[]`, any other read failure **rejects** | writes files there; nothing in the vault | sandbox and stage run with their own home, so the folder starts empty; the user's plugin data is not copied in | no |
| `ctx.widgets` | rows your plugin provides; cards declared in manifest `widgets` (host memory) | none | works | no |
| `ctx.home` | only for the plugin that owns the home page; layout in localStorage, widget list from the engine (`GET /agent/widgets`) | writes the home layout | not for normal plugins | engine for the widget list |
| `ctx.spaces` | host Space and Ribbon state. Capability `spaces` | changes the user's Ribbon | works | no |
| `ctx.desk` / `ctx.summary` | host memory (registered companions / cards); desktop with Tangu only | adds UI | unverified | no |
| `ctx.tts` | the voice model the user picked; errors `tts_unavailable` / `tts_no_model` | plays audio | unverified | no |
| `ctx.account` | **cloud**: the user's Forsion account | sign in / out | signed out in the sandbox and the stage | no |
| `ctx.agent` | engine Muse endpoints; only for an Agent's own Space plugin (today only Muse) | patches its to-dos | unverified | engine yes |
| `ctx.internals` | frozen copies of host state; `internals-raw` = live host modules; Electron desktop only | raw: anything | the sandbox counts as desktop | no |
| `ctx.net` | requests made by the main process, allowed by manifest `network` | network requests | the sandbox reads `network` from your dev manifest | no |

### Identity and routes

- A view's type is `plugin:<plugin id>:<view id>`, where the plugin id is the install folder name for store installs (`market-<UUID>`), otherwise the manifest `id`, and the folder name when the manifest id is missing or invalid (`desktop/shared/products.ts:19-28`).
- Your bundle's **engine routes** hang off the **install folder name**, not the manifest id. The engine mounts them under the folder's actual spelling and matches case-insensitively; `ctx.tangu.request` calls `/extensions/<folder lowercased>/<engine plugin id>/<path>` (`FE/amadeus/plugins/engineRequest.ts:32-43`). The lowercased folder name must match `^[a-z0-9][a-z0-9-]{0,63}$`, or the call throws.

### Wiki links in rendered text

`mountMarkdown` (and `mountMarkdownEditor` with `vault: true`) treat `[[…]]` as links into the user's vault. The Markdown parser decodes character entities before wiki links are found, so entity-encoded brackets (`&#91;&#91;x&#93;&#93;`) in prose **also become links** (checked 2026-11-23 against the installed parser); a plugin filter that strips literal `[[` does not stop them. If the text is not the user's own note (model output, imported data, demo content) and must not link into the vault, render it as plain text or code rather than filtering `[[` yourself.

### The sandbox and the demo stage

| | Plugin sandbox (`plugin_sandbox`) | Demo stage (`ctx.stage`) |
|---|---|---|
| Engine | none (points at a dead port); external mode | `engine: 'none'`: none. `engine: 'scripted'`: a local replay engine from `engine.json`; still **external mode**, so the desktop-gated APIs above are refused (the personal calendar is the exception: the replay engine serves it) |
| Vault | its own, starts empty, kept between starts, wiped by `reset` | a copy of `<fixture>/vault/`, wiped on every open |
| Plugin data | its own, starts empty | not copied in |
| Account | signed out | signed out |
| Personal calendar | `myCalendar: 'unknown'` | from `<fixture>/human/CALENDAR.db` with `engine: 'scripted'` |
| Who can use it | the dev copy you are writing | only an **installed** plugin that declares `stage` (the sandbox is refused). A dev copy that shadows an installed plugin with the same id can call it, but the stage loads the **installed** package and its fixtures, not your working copy |

Demo data for the stage:

```
<plugin>/<fixture>/vault/…              → the stage's vault (notes, .db tables)
<plugin>/<fixture>/engine.json          → required for engine: 'scripted' ({ "runs": [] } if you only need the calendar)
<plugin>/<fixture>/human/CALENDAR.db    → "My calendar": a regular database table, ≤ 8 MB
```

Then `ctx.stage.open({ fixture, engine: 'scripted', clock, plugins, includeSelf })`.

Not verified yet:

- Whether `ctx.tangu`, `ctx.desk` and `ctx.tts` are present at all in the sandbox and the stage.
- `ctx.account` at runtime in the sandbox (signed out is derived from its isolated home).

## Tool validation errors should name the field (writing advice, from 2026-11-23)

When an engine plugin tool's arguments, or a document your code is about to save, fail validation, put **the field path and what is wrong** into the tool result, for example `data.example: missing "zh"`, instead of one generic line such as "does not match the format". The model can only fix what the error shows it: Showcase's `showcase_save_deck` once answered only "The deck does not match the Showcase v1 schema." The validator knew the problem was `data.example` missing `zh`, yet the agent editing the deck kept getting it wrong.

Keep one negative case in `check.mjs`: break one field on purpose and assert that the error names that field. If someone later turns the error back into a generic line, the check fails.

The host does not need to change for this; it is how the plugin itself is written.

## Store identity and install folders

The Store gives every listing an ID that never changes. New listings install into `plugins/market-<ID>/`, unrelated to the display name, so display names may repeat. A plugin in such a folder runs under the folder name: engine plugins inside a bundle still mount their routes under it, a standalone engine plugin's id becomes `market-<ID>` with its data under `plugin-data/market-<ID>/`, and the host rewrites its tool names to unique hashed names (two plugins sharing an id never replace each other). A bundled Space recipe keeps naming its own views by your manifest `id` (`plugin:<id>:<view>`); under `market-<ID>` the host maps them to the runtime id (from 2.13.8; on earlier versions such a Space does not appear). Other plugins can still list your manifest `id` in `requiresPlugins` as long as only one copy is installed; for a one-click install from the Store they also need `market: "market-<ID>"`, because the Store matches the exact slug and never guesses from the display name. These listings need a desktop version after 2.13.4; older versions ask the person to update Forsion first. Older listings keep the folder name derived from their display name; for those, a bundle with an engine plugin whose folder name differs from its manifest `id` cannot reach that engine plugin from its pages on desktop 2.13.3 and earlier (every call returns 404, with no error shown).

## Publishing and updates

When you submit, you can add tags (up to 8), a long description, supported platforms (`desktop` / `macos` / `windows` / `linux` / `android` / `ios` / `web`) and a Forsion version range: the minimum is inclusive, the maximum exclusive. `minAppVersion`, `maxAppVersion` and `platforms` in the package manifest take precedence over the form. The Store home filters on them, and desktop and phone check the package manifest again before installing: a version or platform that does not fit is never downloaded or written to disk. Every listing has a public comment section. New comments reach your inbox (the submitting account) and replies also notify the person replied to; you can turn off comment messages for all your plugins or for one, and the comments stay public.

To ship a new version or change the Store details, select your item under Submissions: drop a new ZIP, or for GitHub and npm publish the new version there first and choose "Check for a new version". The version is only ever read from the package or upstream (for skills, `version` or `metadata.version` in SKILL.md) and must be higher than the Store's current one. The package is checked before anything is submitted: you see the type, version, icon and README that were read, and it is submitted only after you confirm. Summary, tags, long description and version requirements can be edited on their own, without a package. Every change to a published item is reviewed; until it passes, the Store keeps showing the current one, and the review result goes to your inbox.

On the user side (desktop 2.13.8 and later), Store plugins **auto-update by default**: a new version downloads in the background and applies the next time Forsion starts. Users can turn this off for everything on the Updates page, or for one plugin on its page. Before a version is replaced, the desktop keeps the old one on the device (the 2 most recent per plugin, under `~/.forsion/.plugin-versions/`), so users can roll back in one click. Rolling back, or installing an older version from the Versions tab, pins the plugin at that version until the user chooses "Resume auto-update". **Rolling back only swaps your plugin's files; your data (work folder, `plugin-data`, settings) stays as it is.** When a new version changes a data format, make sure an older version can still read it (ignore unknown fields, never rewrite old data in place into a shape the old version cannot read), or write the new format to a new file. Core plugins (Extend, Calendar, Computer Use) follow the desktop version and are not affected.

## Store sources (from 2026-11-08)

A plugin can add an entry to the store's **Sources** group in the left column, pointing at a catalog you maintain, `forsion-store.json`. **A source only supplies the catalog**: the store draws the cards and details and handles download, checks, install, updates and uninstall as usual. You don't draw any UI, and you don't get a page slot in the store (`registerStoreView` is still Extend-only). Users can also click + next to Sources and paste an address themselves, no plugin needed.

Declare it in the manifest (up to 4 per plugin):

```json
"storeSources": [
  { "id": "main", "title": { "zh": "图片 Skills 大全", "en": "Image skills" }, "index": "github:pixel-lab/image-skills", "icon": "image" }
]
```

- `id`: unique within the plugin, `^[a-z0-9][a-z0-9-]{0,31}$`. `title` is a string or `{ zh, en }`. `icon` is optional: pick one of `image` / `sparkles` / `palette` / `wrench` / `bot` / `package` / `globe` / `crown` / `coins`. Anything else gets a default icon for the address type.
- `index`: where the catalog lives. `github:owner/repo` reads `forsion-store.json` at the root of the default branch; `https://github.com/owner/repo/tree/<ref>/<folder>` picks a branch and folder. `npm:<package>` reads `forsion-store.json` at the package root of the `latest` version, checked against the registry's sha512. An `https://` address points straight at the JSON. `forsion-git:owner/repo` is a private repository on Forsion Git (it reads `forsion-store.json` at the root of the default branch; `https://git.forsion.net/owner/repo/src/branch/<ref>/<folder>` picks a branch and folder). The Forsion server reads it as the signed-in account, so only repositories that person can read will open. Signed out, the source page offers "Sign in to Forsion"; a repository that can't be read says it doesn't exist or there is no read access (the two are kept together on purpose); a server without Forsion Git says it isn't available yet. Private catalogs are kept in memory per account only, never in the disk cache, and are read again after switching accounts.
- The source appears while your plugin is turned on and goes away when it's turned off or uninstalled. Users can switch your source off from "⋯" on the source page. When a source is gone, what was installed from it stays, but no longer updates automatically.

`forsion-store.json`:

```json
{
  "schema": 1,
  "title": { "zh": "图片 Skills 大全", "en": "Image skills" },
  "author": "Pixel Lab",
  "description": "Posters, product shots, covers…",
  "items": [
    {
      "id": "poster", "type": "skill", "version": "1.2.0",
      "name": { "zh": "海报排版", "en": "Poster layout" },
      "summary": "Lays out an event poster by size and hierarchy rules.",
      "tags": ["poster", "layout"], "icon": "icons/poster.png", "readme": "# Poster layout\n…",
      "minAppVersion": "2.13.8",
      "package": { "github": "pixel-lab/image-skills", "ref": "v1.2.0", "commit": "3b1f0c9e5a7d2e4b6c8a0f1e3d5b7a9c2e4f6a8b", "path": "skills/poster" }
    }
  ]
}
```

- `type` uses the same set as store submissions: `skill` / `amadeus-plugin` / `plugin` / `agent` / `space` / `theme`. `id` is unique within the catalog, `^[a-z0-9][a-z0-9-]{0,47}$`. **Don't change it once published**: the local install folder and updates are both keyed on it.
- `package` is one of: `{ "github", "ref", "path"? }` downloads the repository archive at that ref, and `path` keeps just one folder of it. `{ "npm", "version", "integrity"? }` must match the item's `version`; without `integrity`, the registry's sha512 for that version is used. `{ "url", "sha256" }` requires the sha256. `{ "forsionGit": "owner/repo", "ref", "path"? }` is a private Forsion Git repository: the server downloads the archive at that ref as the installing user, and `path` keeps just one folder of it. That user must be signed in and able to read the repository. `ref` is a branch, tag or commit; a missing one reports that the branch, tag or commit isn't there.
- **Pinning a commit (`commit`, 2026-11-21+)**: GitHub and Forsion Git packages can add `commit`, a full 40-character lowercase hex commit id. With it, the app downloads that commit and checks it against the commit id the archive carries (the one `git archive` writes as the zip comment), and doesn't install on a mismatch. A `ref` that is itself a full commit id pins too. Without `commit`, one push to the branch or tag changes what new installs get while the catalog's version stays the same, so write it when you publish. `ref` is still required: older app versions don't know `commit` and install from `ref`. A malformed `commit` (a short id, not a string) skips the item; it never falls back to `ref`. For an unpinned item, the commit actually installed is recorded with where it came from; if the same version number later comes from another commit, automatic updates stop and wait for the user. This check catches "not the commit named", it isn't a checksum against forged archives.
- A relative `icon` resolves against where the catalog lives. npm sources and private Forsion Git repositories have no public location, so use a full `https://` address there. Up to 1000 items and 64 KB of README per item are read; a broken item is skipped without affecting the rest. Version and platform requirements in the package manifest still apply, the same as for store items.
- Updates: change the item's `version` and `package` in the catalog. The store updates it according to the user's auto-update settings. **If the package's origin changes (another repository, npm package name or download host), the automatic update stops** and waits for the user to click.
- The local identity is `src-<source hash>-<item id>`, so the `market` field in `requiresPlugins` can't point at source items. The store asks once in the detail sidebar before the first install from a source, and before each item that runs code (plugins, Agents, Spaces). Source items are marked "Not reviewed by Forsion".

### Collected skills (skills.sh) and Tangu's store results (2026-11-23+)

The store has one built-in source, `skills.sh` (source id `25aae625`): the Forsion server collects popular skills from the skills.sh leaderboard, pins a commit, reads the security audits, and labels them "Collected by Forsion · Not manually reviewed". Card ids are `src_25aae625_<item id>`; the local install folder is `src-25aae625-<item id>`.

Results of Tangu's `search_marketplace` / `get_marketplace_plugin` / `recommend_marketplace_plugin` (the data behind the store card in chat) carry two more fields per entry. Older servers don't send them, so treat both as optional:

| Field | Shape | Meaning |
|---|---|---|
| `origin` | `{ kind: 'forsion', publisher: 'official' \| 'developer' }` or `{ kind: 'collected' \| 'source', sourceId, sourceTitle }` | Where the entry comes from. Absent = a Forsion developer submission. `collected` = collected by Forsion (skills.sh), not manually reviewed |
| `requirements` | `{ cli, apiKeys, desktopOnly, scripts, auditWarn }` | Needs a command-line tool, which API keys (variable names), desktop only, how many scripts, an outside security audit rated it medium |

A malformed `origin` or `requirements` drops just that field, never the entry. At equal search hits, Forsion entries come first. The user still decides on the card whether to install.

Two related conventions for skill authors:
- `disable-model-invocation: true` in SKILL.md frontmatter (same meaning as in Claude Code) = use only when the user names it: the skill stays out of the skills list Agents see, an Agent's own `use_skill` call is refused, and it loads only in a turn where the user picked it with `/skill`. Settings and the skill picker still list it.
- `.forsion-adapt.md` in a skill folder is a reserved file name: the "adaptation note" of a collected skill (how the parts written for Claude Code / Codex map to Tangu). The installer writes it and `use_skill` puts it before the instructions in local sessions (up to 1200 characters). It only counts for skills installed from a store source (folder `src-<source id>-…`); a file of that name shipped inside a package is deleted on install, and one in a project or plugin-package skill is ignored.

## Platform accounts and sign-ins (desktop 2.13.8+)

Some content only loads for signed-in users (members-only, HD or rate-limited Bilibili videos). `ctx.app.platformAccounts` lets a plugin use **the account the user signed in to in the built-in browser**. Your plugin never stores the sign-in itself:

```js
const acc = ctx.app.platformAccounts            // missing on web, mobile and older hosts → show no account UI
const st = await acc?.status('bilibili')        // { state: 'connected' | 'expired' | 'none', name? }
await acc.connect('bilibili')                   // call only from a click: opens Bilibili's own sign-in page (QR code) and closes when done
const cookie = await acc.cookie('bilibili')     // the Cookie header; null if not signed in or the user declined
```

- Only `bilibili` for now (`platforms()` lists what this host supports). The host owns the platform list; you cannot pass arbitrary domains.
- The sign-in lives in the built-in browser only (shared with the built-in browser's own sign-in state). It never goes into the vault and never syncs. `pasteCookie(platform, text)` is an advanced fallback that also writes into the built-in browser. `disconnect` signs the built-in browser out of that platform and withdraws every plugin's permission.
- Permission is per plugin and platform: when the user connects or pastes from your plugin, your plugin is allowed. A plugin that was never allowed gets a host dialog the first time it calls `cookie()`.
- **Never write the sign-in to the vault, logs, plugin data or a prompt.** To hand it to a script the agent runs, put it in `secret_env` on `POST /agent/runs` (for example `{ "BLUEBIRD_COOKIE": cookie }`). It stays in memory and only that run's `run_bash` processes see it. If the script prints it, the value is replaced with `[REDACTED:NAME]` before the model sees the output. Remote runs drop it. Names must be upper case (`^[A-Z][A-Z0-9_]{2,63}$`), at most 8, and reserved names such as `PATH`, `TANGU_*` and `FORSION_*` are refused. Older engines ignore the field, so the fetch simply runs without the sign-in. In the prompt, only tell the model that the variable is already set and must not be printed.
- Only `run_bash` gets `secret_env`; processes started with `run_background` do not. Cookie-style values (`a=b; c=d`) are also redacted item by item. Redaction stops accidental printing. The value still goes to a shell the model can program, so deliberate encoding can get past it: only pass what a script you trust needs.
- Plugins run inside the host renderer. Per-plugin permission is a consent prompt for the user, not an isolation boundary between plugins.
- Only send the sign-in to a local engine (`127.0.0.1` / `localhost`), never to an external engine. Check the **real hostname** before handing it over, and have the script send the cookie only to that platform's hosts.

## Plugin settings (from 2026-11-18)

Every installed plugin that has settings is listed under Settings › Extensions › Plugin settings: one item per plugin, sorted by display name. With more than 8, only the 5 most recently opened are shown, followed by "N more…", which opens a list of all of them with a filter. Disabled plugins stay in the list, greyed out; their page is a "Disabled · Enable" card, and their stored values are kept. Settings search finds a plugin by its name and by the keywords you give.

Each plugin's page starts with an identity card the host draws (icon, name, `version · Built-in / Store / Local`, an "Open plugin" button when the plugin has a Space, and the on/off switch). Below it come the plugin's settings, **drawn only with the host's settings parts**. Uninstall and auto-update stay on the Plugins page; the plugin's detail page there no longer draws the settings a second time, it has a "Settings" button that opens this page.

For a new settings page, describe the whole page as data with `ctx.registerSettingsPage` and let the host draw it:

```js
ctx.registerSettingsPage?.({ title, keywords, mount(page) { page.update({ groups }); return cleanup } })
```

- `mount` runs when the page opens. Call `page.update({ groups })` (or `{ state }`) in it; the parts and rules are the same as `ctx.ui.mountSettingsPage` (a stable `id` per group and item, `update` replaces the whole description, a rejected switch or select callback flips back, `custom` blocks for anything else). The cleanup you return runs when the page closes or your plugin is disabled or reloaded; callbacks from the old page are not called after that.
- `title` can be a function so it follows the language; re-call `update` from `ctx.subscribeLocale` for the text on the page. `keywords` are search aliases in either language. `id` defaults to `'main'`; registering the same id again replaces the page.
- The older interfaces keep working, authors change nothing, and they land on the same page: `ctx.registerSetting` rows go into a "General" group (a switch, a stepper for a number with a small range, a text field otherwise; values stay in localStorage `plugin.<plugin id>.<key>`); each `ctx.registerSettingsView` panel becomes its own group after "General", as a custom block. Engine plugins' manifest `settings.fields` are converted too: a section starts a group, toggle is a switch, select is a select, number is a stepper or a text field, text is a text field (`secret` is a password field), textarea and image-list are custom blocks, note is a line of text, and link is an "Open" button. Switches and selects save at once and text fields save when they lose focus, as before.
- If your `registerSettingsView` panel only calls `ctx.ui.mountSettingsPage`, switch to `registerSettingsPage`.
- **Plugins must not imitate the host's `.settings-*` styles**: the parts belong to the host, lay out per device and follow host changes; a copy breaks on phones and drifts. For the host's look inside a `custom` block, mount parts there with `ctx.ui.mountSettingsItem`.
- Hosts before 2026-11-18 don't have `registerSettingsPage`: feature-detect it and fall back to `registerSettingsView` + `ctx.ui.mountSettingsPage` (the built-in Voice input plugin does exactly this).

## Secret settings

Engine plugin text settings can declare `secret: true`, and the host renders a password input (a `textarea` also becomes a single-line password input). This masks the UI only: values still use the existing local plugin settings store and the authenticated settings API; no encryption is added. Older hosts ignore this optional field.

## Mini Panel extensions

A Space inside a plugin can declare a dedicated Mini view that offers only quick actions for its current capability; the host's "Show in main panel" carries the current entity parameters. Spaces that haven't opted in don't appear in Mini, and an adapter is withdrawn automatically when its plugin is disabled. See [Mini Panel development](./mini-panel-development.md).

A plugin can also skip the full Space and open a registered compact view directly with `ctx.openMiniPanel?.(viewId, options)`; `mainViewId` sets where "Show in main panel" goes. Since 2.13.8 several Mini windows can be open on desktop: opening the same `viewId` again brings up its open window, and a stable `key` gives different content its own window; at 6 the host tells the user itself. See "Several Mini windows" in [Mini Panel development](./mini-panel-development.md). For a wide standalone tool page, use `ctx.openFloatingPanel?.(viewId, options)`. The host adds the plugin namespace automatically and owns the window lifecycle. See [Floating Panel development](./floating-panel-development.md).

### One way to open views: `ctx.workspace.open` (2.13.8+)

The ways to open a view above (`openView` docked, `openMiniPanel` small window, `openFloatingPanel` panel window) are now forms of one entry point that writes **where** (`layer`) apart from **what it looks like** (`form`). The three old calls keep working and go through it inside the host; new code can call it directly:

```js
const open = ctx.workspace?.open
if (open) {
  await open('board', { layer: { dock: 'right' } })                              // = openView('board', { location: 'right' })
  await open({ view: 'board', params: { id } }, { layer: { float: 'desktop' } }) // = openMiniPanel; the compact view comes from forms
  await open('board', { layer: { float: 'desktop', pin: true }, form: 'main' })  // = openFloatingPanel, kept on top
  const r = await open('board', { layer: { float: 'space' } })                   // a card floating over the current Space
  if (r.ok) r.close?.()
} else ctx.openView('board')                                                     // older hosts
```

| `layer` | Where it goes |
|---|---|
| `{ dock: 'main' \| 'left' \| 'right' \| 'bottom' }` | Docked in the workbench, like `openView`'s `location`; the place sets the look (either side panel is `side`) |
| `{ float: 'desktop', pin? }` | A small system window: `form: 'mini'` (default) is the Mini Panel (on top by default; `pin: false` keeps it level with other windows and it no longer folds away at the screen edge; several at once, reused by `key`, position and size remembered per entity across restarts); `'main'` is the Floating Panel (not on top unless `pin: true`) |
| `{ float: 'space', anchor? }` | A card floating over the current Space; hidden while another Space is shown, back as it was on return |
| `{ float: 'window', anchor? }` | A card floating over the whole window; stays across Space switches |
| `{ float: 'view', host, anchor? }` | A card floating inside one element (`host`) of your view |

The last three are the same floating layer as `ctx.ui.float` (six anchors, the person can drag the card to another corner). The difference is that the card holds your whole registered **view**, not DOM you draw: the host draws the card head (title, "Show in main panel", close) and your view's `mount` gets its `view` as usual (`surface` is `'mini'` or `'floating'`; `showInMainPanel()` opens the main area with the current params and closes the card). Cards close when your plugin is disabled or reloaded, when the view is unregistered, when you call `close()`, or when the person closes them. Opening the same view with the same `key` again brings up that card with the new params; params never count as identity.

Where cards are remembered (2.13.8+):
- `space`: the cards open in a Space (view, current params including those your view changed with `view.setParams`, look, `key`, anchor) are saved with that Space's layout. They come back after a restart, when the person returns to that Space, and when they undo "Reset layout". If your plugin loads after the layout, the card opens as soon as its view registers. "Reset layout" closes them. A card closed and opened again goes back to the corner the person last dragged it to in that Space. Cards closed because the plugin was disabled do not come back when it is enabled again.
- `window`: the anchor is remembered on this device per view + `key`; the card itself does not survive a restart.
- `view`: the card belongs to your view, which opens it again each time it mounts; the anchor is remembered on this device per view + `key` and is not written into the host view's params.

**Declare looks with `forms`**: pass `forms` to `registerView` to say which looks the view supports:

```js
ctx.registerView({ id: 'board', title, mount, forms: { main: true, side: true, mini: { view: 'board-mini' } } })
```

Without `forms` every look works, as before. With it, anything left out is unsupported. `mini: { view }` names a compact view of this plugin (relative id): whenever `board` opens in the Mini look (desktop Mini, floating card), `board-mini` is what shows, and "Show in main panel" goes back to `board`. This replaces the half of a Space recipe's `mini` that pairs a compact view with its main view; the recipe's `mini` keeps working.

**Fallback rules** (when the asked-for look is unsupported):

1. Docked: the place sets the look; `form` is ignored. Unsupported → the next place on the ladder: main → right → bottom; left / right → main → bottom; bottom → right → main. Hosts without a bottom panel (phones, satellite windows) use right for bottom. A view with no docked look at all (only `mini`) floats over the current Space instead; with no `mini` either (for example `forms: {}`) the result is `'unsupported'`.
2. Floating: `form` defaults to `'mini'`; `'side'` / `'bottom'` count as `'main'`. `mini` unsupported → `main`; the view itself unsupported → `mini`.
3. The Mini look shows `forms.mini.view` (the view itself if that one is not registered, or when `mini` is not an object). Only compact views of your own plugin count. A view without `forms` opened with `openMiniPanel` behaves as in 2.13.7: the Mini shows the view itself.
4. Web has no Mini window: the Mini look of `{ float: 'desktop' }` becomes a card floating in the window. On phones it is a half-height sheet along the bottom, and the main look docks in the main area (a panel filling the phone screen is the main area). Space cards on phones sit just above the bottom bar.
5. Windows without a workbench (Mini windows, Floating Panel windows) cannot open the `space` / `window` / `view` layers.

The result `{ ok: true, layer, form, close? }` says where the view actually went after the fallback rules (desktop windows have no `close`). When it cannot open you get `{ ok: false, reason }`: `'unknown-view'` (not one of your registered views), `'unsupported'` (none of the declared looks can be used), `'unavailable'` (this window cannot open it), `'limit'` (too many Mini windows; the host already told the person, and `limit` is the cap), or `'disabled'` (your plugin is disabled). Malformed options throw a `TypeError` at once. Plugins can only open their own views. `{ float: 'desktop' }` is only another way to write Mini / Floating Panel; the component float `ctx.ui.float` still has no desktop scope.

When a View needs an input box with model selection, use `ctx.ui.mountChatBox`; it reuses the host component, and the plugin handles submission explicitly. Pass `modelPicker: false` to drop the model selection, `toolbar` for controls in the bottom row, `suggest` for completion such as `#` (since 2026-11-02 it can be a list, for example one for `#` and one for `[[`; pass a list only when `ctx.ui.chatBoxCapabilities` includes `'suggestMany'`; when the box sits in the lower half of the window the suggestions open upward), and call `insertText` to insert at the caret. For the `@` date / note panel from notes, pass `mentions` and handle picks in `onMention` (since 2026-11-20; check for `'mentions'` in the capabilities first). For bold, lists and other formatting, pass `format: 'inline' | 'basic'`: the value becomes Markdown, and `ctx.ui.parseInlineMarkdown` reads it back for display (since 2026-11-21; capability `'format'`). See [Reusable UI components](./ui-components.md).

Settings-like pages (account, quota and credits, diagnostics, preferences) hand the host a description of the whole page through `ctx.ui.mountSettingsPage(el, { groups })`: each group has an icon, title, description, top-right buttons and items (switch, value, buttons, input, segmented, select, pick-to-run choice, stepper, code with copy, usage meters, empty / loading / error, custom block). The plugin supplies only the text, values and callbacks; the host draws them with its own settings parts and lays them out per device — on phones switches, values and single buttons stay at the right, inputs, steppers and two or more buttons move to the next line, and a pick-to-run choice becomes one button and a half sheet. Put anything outside that list in a `custom` block and mount single parts there with `ctx.ui.mountSettingsItem`. Stop copying the host's settings CSS; hosts before 2026-10-17 lack both methods, so feature-detect and keep your own page there. See [Reusable UI components](./ui-components.md).

To handwrite or circle things on your own content (PDF pages, images), use `ctx.ui.mountBoard` to mount the host whiteboard engine as a transparent layer, and `ctx.ui.boardToSvg` for a static image when you're not handwriting; the viewport and saving belong to the plugin. See [Reusable UI components](./ui-components.md).

A file type that takes over `.pdf` with `override: true` receives every "open this PDF" entry: the file tree, recent items, `[[x.pdf]]` note links, and jumps that carry a page or a quote (`[[x.pdf#page=3]]`, chat citations). Those jumps reach the plugin through `file.onGoto?.(cb)` on `mount(el, file)` as `{ page, quote? }` (desktop versions after 2.13.2; earlier versions send note links and such jumps to the built-in reader). The callback can arrive while the file is still loading or just as a background tab comes back to the front, so hold the target until you can scroll. `![[x.pdf]]` embeds and "Open with the built-in reader" are not taken over.

When a tab goes to the background the host detaches the view's DOM from the document (the view is not unmounted and keeps its state) and re-attaches it when the tab comes back; sizes and scroll positions read as 0 while detached. Desktop versions after 2.13.3 write every scroll container's position in the view back on return, so a plugin does not need to remember it (earlier versions always come back at the top). In the same versions, Cmd / Ctrl + click on the file tree, wikilinks and chat citations opens a file-type view in a new tab, and while the view is shown in the main area the side chat automatically references that file.

To "Ask Tangu" about selected text, call `ctx.tangu.askInChat(text)` first (from 2026-11-15): the quote is attached above the composer of the native side chat, the same panel notes use for Ask Tangu, without sending it or touching the draft. Append the source yourself; write a vault file as `[[path]]` (optionally with `#page=N`). It returns `false` when this window has no side chat (detached windows, Mini, floating panels); then fall back to `file.extendView` + `mountChat` or copy to the clipboard. Older hosts lack the method: `ctx.tangu?.askInChat?.(text)`.

Plugins that need a full, persistent chat inside a view (for example the right panel of a creative Space) use `ctx.tangu.mountChat`; the host pins the native chat to one session per plugin and folder, and files the Agent generates land in that folder. See [Reusable UI components](./ui-components.md).

A plugin that wants a "type here, send to a new Tangu chat" box, as Home has, uses `ctx.tangu.mountComposer`: the host mounts the full new-chat composer from Home (attachments, modes, projects, run location, voice and calls included), and when the user presses Send the host creates the session, switches to Tangu and sends it; the plugin can read the draft (`draft()`) but cannot change what is sent. From 2026-11-09 a plugin can put a sentence into an empty composer and focus it (`prefill(text)`); a half-written draft is left alone, and the user still presses Enter.

When a plugin only needs the model to return a piece of text, use `ctx.tangu.complete` (a one-shot call: no tools, no session, on the current chat model). For translation use `ctx.tangu.translate({ text, language })`: the same channel, but on the model the user picked under Settings → Models → Translation. When none is picked, a machine translation model is used if the account has one, and the chat model otherwise (desktop versions up to 2.13.3 go straight to the chat model when none is picked). High-volume work such as sentence-by-sentence translation belongs here; it returns the translation only. Older versions have no `translate`, so feature-detect and fall back to `complete`. When calling it from a selection action's `run`, pass `cx.signal` through as `signal` (2026-11-22+): the result card then names the model that answered (the first call in that run), like the built-in translate. The same goes for `complete`. The selection's surroundings (the note text before and after it, page instructions) are added only to the host's core translation plugin's `translate` requests, never to other plugins'.

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

The selection bar — the strip that appears over selected text — is open to plugins in two halves. First, adding actions: entries from `ctx.registerSelectionAction` are listed under "⋯ → Plugins" on the bar, and the markdown `run(cx)` returns goes to the host's result card (in a note nothing is written until the user picks Replace or Insert below; elsewhere the card is read-only). Without `scope` an action appears in notes only; `scope: 'all'` lists it in every view that has the bar (notes, chat, plugin views that opted in), `'own'` only in the plugin's own views, and an array names views. `when({ view, editable, length })` filters by view and length, and `output: 'none'` means the plugin handles the result itself. Second, using the bar in your own view: `ctx.ui?.mountSelectionBar` gives the view Ask Tangu, Translate and "⋯" from the host next to the tools the plugin declares (icon buttons or colour swatches); a view that does not call it gets no bar. Both halves exist only in desktop versions after 2.13.3. Earlier versions list actions in notes only (under "AI ▾ → Plugins") and have no `mountSelectionBar`, so feature-detect and keep your own menu there. Since 2026-11-08 the bar and its result card follow the text on scroll and zoom and hide while it is off screen; a `watch: false` view that reports its own selection passes `getRect` to `show()` to get the same. Since 2026-11-21 an action can sit on the bar itself (`placement: 'bar'`; at most three plugin actions fit, and the user's pin / "Move to ⋯" / Settings choice always wins), can declare that it supports running right after a selection (`auto: true`; the switch belongs to the user and starts off; when on, the result card opens as soon as the selection rests and `run` gets `cx.auto`; the switch is a user-facing setting, not a security boundary, since plugins run in the same renderer as the host, so don't flip it yourself; notes never run actions automatically, so an action whose `scope` only reaches notes gets no switch), and can have the host draw a target-language picker (`cx.language`), the original text and speaker buttons on its result card (`card`); `title` also takes `{ zh, en }`. The bar gains **Read aloud**; to read text yourself use `ctx.tts?.speak(text)` (the user's read-aloud model; with none set the host points to Settings, never a system voice). The host's own Translate gives way to a plugin with id `translation` when that plugin is a core plugin the host ships or preinstalls (even while disabled), or when it is enabled and has registered a selection action; it then keeps the placement the user chose for the host's Translate. See [Reusable UI components](./ui-components.md).

```js
ctx.registerSelectionAction({ id, title, run, placement, auto, card })
ctx.ui?.mountSelectionBar?.(root, { tools, source, ask, watch })
await ctx.tts?.speak(text, { signal })
```

A "hold a tool and work" view (PDF annotation and the like) switches tools with the host's tool island: `ctx.ui?.mountToolIsland?.(root, { tools, active, onPick, slots })` sits centred at the top (docked at the bottom below 520 px), selection is controlled (call `setActive` from `onPick`), and the handle's `row` is the row under the island for you to fill. On older hosts draw your own bar. See "The tool island" in [Reusable UI components](./ui-components.en.md).

For something that floats (a transfer progress card, an "export finished" strip, a recording timer capsule) use `ctx.ui?.float?.({ scope, anchor, role, id })`: `scope` says what it floats over (`view` your view / `space` the whole Space, hidden while another is open / `window` the whole window). Put your content in the handle's `el`; placement, stacking, motion and drag-to-snap belong to the host, so don't write your own `position: fixed` + z-index. On older hosts keep drawing your own. See "Floats" in [Reusable UI components](./ui-components.en.md).

## Tables and note tasks

Calendar, to-do and habit plugins need to read and edit the tables in your vault and the dated tasks in your notes (`- [ ] Send report @2026-10-20`). A plugin gets them only if its manifest declares `databases` (tables) or `noteTasks` (note tasks); plugins that do not declare them cannot see this data. Once granted, a plugin changing a cell or ticking a task goes the same way as your own edit in the table or the note: open tables update at once, and note-view properties are written into that note. A plugin can undo deleting a row from a classic table; a note-view row is a note, so a plugin can only move it to the recycle bin. The plugin's detail page lists what it declared in one line, "This plugin can: …" (reading the front window through `activeWindow` is listed there too). Since 2026-11-02, `- [ ]` lines indented under a task with an `@` date reach plugins as its subtasks (up to two levels; a subtask without its own `@` never shows up as a separate task), and every task carries the `#tags` on its line. Plugins can also read and write a table row's record body (the same text as "Open record", checked against what is there before writing) and add a column to a table (for example a multi-select "Tags" column the first time tags are used). Since 2026-11-04 a plugin can also change a whole table in one go (rename columns, add options, reorder rows, create views) through the same write path the table itself uses: open tables update at once and edits not yet saved are kept. The first column, autonumbers and created / edited times stay with the host, and a change that breaks the rules is refused as a whole. Since 2026-11-15, tasks written as `- [ ] Buy groceries @todo` in a note reach plugins too: they have no date (`due` is an empty string and there is no `parentId`), meaning the task belongs in the task list but is not scheduled yet. When a plugin gives one a date, the host replaces `@todo` with it; clearing a task's date (`due` set to an empty string) puts `@todo` back, so it stays in the task list. Dated callout and fold titles no longer carry the leading `[!fold]-` marker in the text plugins receive. API details are in the `ctx.databases` / `ctx.noteTasks` section of the plugin development skill.

### Calendar overlays and calendar settings

A calendar plugin also needs the read-only sources the host calendar layers in: Agent schedules, the .ics subscriptions you added, and tables in the vault on the other side (Local↔Cloud), plus your calendar settings (which tables are in the calendar and which columns they use for the date and the done checkbox, colours, hidden sources, and the table new events go into by default). A plugin gets them only if its manifest declares `calendar`; plugins that do not declare it can still only add their own table to the calendar. Once granted, a plugin changing a colour or adding or removing a table in the calendar changes the same settings as the "Calendars" list in the calendar's left panel, for the current vault only; overlays can be read but not changed. While a plugin is subscribed, the host refreshes these sources on schedule for it (.ics subscriptions go online; the timer is shared with an open calendar, so nothing is fetched twice). The same capability lets a plugin add, remove, rename and immediately refresh .ics subscriptions or import a local .ics text; it is the same list as "Subscriptions" in the calendar settings. The detail page line gains "read Agent schedules, .ics subscriptions and calendars in the vault on the other side, manage .ics subscriptions and change calendar settings". Plugins can also open a note and jump straight to a heading (`ctx.app.openNote(path, { heading })`), put one button (such as Undo) on a notification, and, if they declare `databases`, mount the field list from the host's event card (title, time, properties) into their own card with `ctx.ui.mountRecord`; edits go straight back to the table. Dashboard cards and a plugin's own scheduled reminders are not open yet. Since 2026-11-15, an .ics subscription or imported calendar whose events have a location, description or link gains `location`, `description` and `url` columns (named in the interface language); an event without that item leaves the cell empty. Older hosts only have the name and date columns. API details are in the section on the `calendar` tier of `ctx.calendar` in the plugin development skill.

### Spaces and the Ribbon shelf

Set `"autoDesktopShortcut": true` in a bundled Space’s `spaces/<slug>/space.json` to create a shortcut on the system desktop when the installed desktop app first registers the Space for an enabled plugin. Moving or deleting the shortcut is respected across plugin reloads, updates, and app restarts. Users can create it again from the Space menu. Older hosts ignore the field.

Launcher and home-style plugins can list your Spaces, open one with a click, show their icons and a status line (continue a chat, the latest note, the next event, unread count), and rearrange the order of Spaces and the shelf folders on the Ribbon from their own view. A plugin gets this only if it declares `spaces`; it changes the Ribbon's own order, so a drag in the plugin moves the Ribbon too, and the other way round. When a Space's icon changes (say its plugin updates), the icon drawn in the plugin changes with it. From 2026-11-09, right-clicking a Space in a plugin opens the same menu as on the Ribbon and Home (`ctx.spaces.contextMenu`, with room for a few items of the plugin's own at the end), a plugin can ask whether clicking a Space opens it in its own window (`opensElsewhere`), and the Store and Achievements tiles are followed by first-party Ribbon entries such as the activity center. The detail page gains "open Spaces and rearrange the order of Spaces and shelf folders on the Ribbon". API details are in the `ctx.spaces` section of the plugin development skill.

Three smaller pieces: plugins can read the signed-in name (`ctx.app.watchAccountName`, the nickname if there is one; the name only, never a token), get Bing's daily wallpapers (`ctx.wallpaper.bing`, fetched by Forsion), and open a right-click menu styled like Forsion's own (`ctx.ui.contextMenu`). Long menus scroll when the window is short, and a checklist menu can stay open after a click so you can tick several items in one go. Plugins can also read the motion preference (`ctx.app.motion`, from 2026-11-09): when the system asks for reduced motion, or the user picked fade only in Settings, skip movement and scaling, the same rule Forsion's own interface follows.

The core plugin that takes over Home gets a set of Home-only APIs (`ctx.home`: the host draws card contents into the plugin's slots, reads and writes the Home layout, and passes on the Edit Home command). Other plugins don't get it and can't ask for it.

## Creating agents and importing chats (2026-11-16+)

A "move from another AI" plugin can create an agent for you and write the old chats from an export file as sessions under it: opening one shows the original chat, and you can keep talking. The plugin must declare `agentImport` in its manifest to get `ctx.tangu.createAgent` / `ctx.tangu.importSessions`; the plugin's detail page then lists "create agents and import chats".

- **Which device**: on desktop they go into the local engine, on phone and web into the cloud. Nothing syncs across devices: chats imported on the desktop do not show up on the phone, so import again on the phone to use them there.
- **Append only**: the same chat from the same source a second time comes back as "exists" and the session is left as it is, so anything you added by continuing it is never overwritten.
- **Kept as they were**: original titles and times; they sort by their own dates instead of jumping to the top, show no unread dot, and no background job (titles, memory tidying) runs on them.
- **Session shape**: the same as a new Chat (no project), under the given agent, not in its private chat.
- Times are milliseconds. Pass as many chats as you like; the host batches them and reports progress after each batch. Errors are returned, not thrown: `{ ok: false, error, results }`, with the batches already written listed in `results`.

See the capability table of the plugin development skill (the `ctx.tangu.createAgent` / `ctx.tangu.importSessions` row) for the details.

## Bundled MCP servers, hooks and file events

A plugin can ship its own MCP servers (only ones that run on this computer). Once it is installed and enabled, Tangu gains those tools; disabling the plugin stops them. Settings → MCP lists them with the plugin they come from; to turn them off, disable the plugin in plugin settings. Like MCP servers the user adds, these tools load on demand by default: each request carries one catalog line per tool (its name and the first line of its description), and the AI loads a tool before calling it. Make the first line of each description say on its own what the tool does. For a server needed on every turn, set `"deferLoading": false` in its declaration to keep its tools loaded. A plugin can also ship hooks that are notified when a session starts, when a tool has run and when an answer ends, for auditing or archiving. These hooks only watch: they cannot block anything or add to the conversation. Settings → Hooks lists them too, marked "Observe only".

Plugins can also receive file events in your vault: files created, deleted, renamed or moved in Forsion, changed by another program or by Tangu, and switching vaults. Backlink and tidy-up plugins use this to keep up with changes without rescanning the vault again and again. For the API, see the plugin development skill's sections on bundled MCP servers and hooks and on vault file events (`ctx.app.onVaultEvent`); how a plugin command hands query results back to Tangu is in the "`invoke`" section.

## Plugins in multi-account mode (2026-11-21+)

The local engine can run in "multi-account mode": several accounts on one machine share one engine process, and each account's chats, agents, memory, skills and files live in that account's own folder. In this mode the engine takes only two things from a plugin bundle, both read-only: the agent personas in `agents/` and the skills in `skills/`. It does not load the engine code in `tangu-plugins/`, and it does not start the plugin's own MCP servers or hooks. If a plugin should work in this mode, put its core abilities in personas and skills rather than in an engine plugin. The default single-user mode is unchanged and still loads everything.

### Scripts in skills (2026-11-23+)

Multi-account mode has no `run_bash`, so the agent cannot start arbitrary commands. When a skill needs to run code, such as transcribing audio, put the script in the skill folder, for example `skills/<skill>/scripts/transcribe.py`. The agent runs it with the `run_plugin_script` tool and passes three things: the skill name, the script's path inside the skill folder, and a list of arguments. Say in the skill's `SKILL.md` how to fill in all three. The rules:

- **Only the original in the plugin bundle runs.** Copies of the skill in the account folder do not run, and neither do scripts the agent wrote. A file in the bundle that links outside the bundle does not run either. If the agent passes the absolute path of the account copy, the engine runs the bundle original instead.
- **Supported types:** `.py` (python3), `.js` / `.mjs` / `.cjs` (the engine's own Node), and `.sh` (sh). There is no shell: arguments are passed as a list, exactly as given, with no quoting, globbing or variable expansion.
- **Where files go:** the script starts in the turn's working directory, which is inside the account folder. Any argument that looks like a path (absolute, or containing `..`) must point inside the account folder. Values that start with `~` are refused; URLs are not checked. Keep input and output files in the account folder.
- **Environment:** only `PATH` and the language and time zone variables are passed through. `HOME`, `TMPDIR` and `XDG_CACHE_HOME` point to a temporary folder for this run, whose path is also in `FORSION_SCRIPT_SCRATCH`, and that folder is deleted afterwards. Scripts get no sign-in details and no API keys, so do not rely on either. Python does not write `.pyc` files or read the user's site-packages: dependencies must be installed on the machine or shipped in the bundle.
- **Limits:** only one script runs at a time on the whole engine, and the rest wait in a queue. By default a script may run for 5 minutes, use 2 GB of temporary space and print 1 MB to stdout. A script that goes over is stopped together with any processes it started. What the script writes into the account folder counts toward that account's disk limit.
- **Afterwards:** symlinks the script left in the account folder are removed. Hard links shared with a file outside the account folder are broken: a name the script created is removed, and an existing file keeps a copy of its own. The model gets back the exit code, stdout and stderr. Any exit code other than 0 counts as a failure.
- **Only the skill folder counts:** code elsewhere in the bundle, such as `tangu-plugins/`, never runs as a script, not even through a symlink. The tool is not available on Windows hosts.
- **Scripts may run as a separate user (2026-11-25+):** some deployments run scripts as a separate system user instead of the engine's own. The script can then read and write only this account's folder (except the account database, `state.db*`), the temporary folder for this run, and files on the machine that everyone can read. Other accounts' folders and the engine's own files are out of reach. When the script ends, every process it started ends too, including ones that left its process group. So do not assume the script runs as root, do not write outside the account folder and the temporary folder, and make sure dependencies shipped in the bundle are readable by everyone. If such an engine cannot switch users, it does not run the script and the tool returns an error.

Single-user mode does not have this tool; the agent runs the same script with `run_bash` there. Write both ways into the skill: use `run_plugin_script` when it is available, otherwise `run_bash`.

**Transcribing audio a script hands back** (2026-11-25+): have the agent call `transcribe_audio` with the script's audio path in the same turn. The temporary folder is deleted when the turn ends, so a later turn cannot find the file, and the plugin's UI cannot reach files on that machine either. In multi-account mode the tool only uses Forsion cloud transcription, billed by audio length, and only reads files in the current account folder, including this turn's temporary folder. Cloud transcription takes 16-bit PCM mono WAV (16 kHz) up to 20 minutes and the engine splits it itself; other formats are refused, so convert to that WAV in the script. Single-user mode is unchanged: with the desktop app running, the desktop's speech recognition does it.

**How the UI half knows to use this path:** when the host declares `window.tangu.executionCapabilities.pluginScripts === true` (with `host` false), the engine has no shell and only runs scripts that ship inside the plugin. Switch the task text to `run_plugin_script` and do not save media into the vault (a script can only write the account folder). With `host` true, keep using `run_bash`. With neither, only do work that needs no script. On device pages the token in the config can be an empty string or the placeholder `tunnel`; then send engine requests without `Authorization` and let the page carry the identity.

## Folders, file times, renaming and moving in the vault (2026-11-16+)

Plugins can create folders, read a file's size and times, and rename or move files in the vault, the same way you do it in the file tree: renaming or moving a note rewrites the `[[links]]` to it across the vault, editors that have it open follow, and its subnotes move with it. All of these need an open vault; older hosts don't have them, so check with optional chaining.

```js
await ctx.app.createFolder?.('Plugins/my-plugin/Archive')
const info = await ctx.app.stat?.('Notes/Idea.md')        // { kind, size, mtime, ctime } or null
const moved = await ctx.app.movePath?.('Notes/Idea.md', 'Plugins/my-plugin/Archive')
const renamed = await ctx.app.renamePath?.(moved, 'Idea (done)')
```

- `stat` tells you whether the path is a file or a folder, its size in bytes, and when it was modified and created (milliseconds; `ctime` is `null` where the file system doesn't record it). A missing path, or no open vault, gives `null`. The web version has no file times, so the method is absent there.
- `renamePath` takes the new name without a folder; a missing suffix such as `.md` or `.db` is added back, and a rename can't change the file type. The destination folder of `movePath` must already exist; an empty string means the vault root. Both return the new path.
- A plugin's own things are changed directly: files in its work folder, and files and folders the plugin itself created during this run (new files written with `writeFile` or `writeBytes`, folders made with `createFolder`). Before changing any other file, Forsion asks you once (Allow / Cancel, with Cancel focused); if you cancel, the plugin gets a `user_declined` error and nothing changes.
- Not done: moving a table (`.db`) or a folder that contains one, renames that change the file type, renaming images and PDFs, moving a note's subnote folder (`.fd`) on its own, and moving into a folder that doesn't exist. If the file was moved but the links could not all be updated, the error says where the file is now.

## Templates and new notes (2026-11-16+)

Forsion has templates of its own: the notes in the vault's `templates/` folder, with `{{date}}`, `{{date:format}}`, `{{time}}` and `{{title}}` filled in on insert (formats from `.obsidian/templates.json`); the daily note's folder, name and template come from Settings or `.obsidian/daily-notes.json`. A Templater-style plugin, or one that gives new notes in a folder a template, should plug into these rather than ship a second template picker.

A template processor gets the template's raw text before Forsion fills in its variables; processors run one after another in registration order. Returning `null` leaves the text unchanged; throwing cancels that insert, and the notice names the plugin; if the plugin is disabled or reloaded halfway, that processor counts as unchanged and the next ones still run. If the library, the pane or the note changed while waiting, nothing is inserted. `folders()` adds folders to the template picker. It covers two flows: inserting a template picked in the template picker (`kind` is `'insert'`), and creating a daily note (`'daily'`).

```js
const off = ctx.registerTemplateProcessor?.({
  id: 'tp',
  name: 'Templater',
  folders: () => ['Templates'],
  process: async (source, { templatePath, targetPath, kind }) => render(source, targetPath),
})
```

A new note's first content: when someone creates an empty note, Forsion asks plugins for its content before writing it. The first plugin that answers with something other than `null` has its content written together with the new note, so the editor opens on it. It is asked for every "New note" entry point (including a plugin calling `ctx.app.createPage()`, whose own provider is asked too), a new note in a folder, child notes, creating a note from the quick switcher, opening a `[[link]]` to a note that doesn't exist yet, and a new daily note when no daily-note template is set. It is only not asked for files plugins write themselves with `writeFile`, `writeBytes` or a file creator, rows added to a table, and files that arrive through sync. A plugin may ask the user something; if it takes a while, Forsion shows "<plugin> is preparing this note…" with Cancel. On Cancel, or with no answer after 10 minutes, the note is created empty as before.

- `signal` aborts when Forsion stops waiting for the plugin: Cancel, the 10-minute limit, a library switch, the plugin being disabled or reloaded, or the note having been created. When it fires, the plugin should close its prompt; an answer that arrives later is ignored.
- A library switch while waiting: the note is not created, and a notice says why.
- If you moved to another pane or note while waiting, the note is still created but you are not taken back to it: "New note" shows a "Created …" notice with an Open button, and a child note's link is still inserted into its parent.

```js
ctx.registerNoteBirth?.({
  id: 'folder-templates',
  initial: async ({ path, folder, signal }) => (folder.startsWith('Journal') ? render(journalTemplate, path) : null),
})
```

Both methods return a function that removes the registration, and Forsion removes it too when the plugin is disabled. Older hosts don't have them. Don't replace them with "wait for the file-created event, then `writeFile` into the note": measured, the open editor never sees that write, and once the user types and saves, the template is moved into a "conflict" copy.

## Inserting into a note (2026-11-16+)

`ctx.app.insertMarkdownAt` inserts Markdown into the current note and does three things the older `insertMarkdown` can't: `where: 'caret'` inserts inside the line the caret is on (when the content is a single paragraph; selected text is replaced, as typing would); `cursorMarker` is a marker string you put in the content, which Forsion removes after inserting and puts the caret there; and when nothing could be inserted, it tells you why. Every insert is its own undo step.

```js
const page = ctx.app.getPage()
const r = ctx.app.insertMarkdownAt?.(page.token, 'Hello {{cursor}}', { where: 'caret', cursorMarker: '{{cursor}}' })
// r = { ok: true } or { ok: false, reason: 'stale-token' | 'no-note' | 'empty' | 'read-only' | 'no-editor' }
```

- `read-only`: the note is in reading mode or locked, and nothing was inserted; you can ask the user to switch back to editing. `no-editor`: the editor isn't ready yet, or it is in source mode. `stale-token`: the user has switched to another note, or the plugin was disabled or reloaded.
- A marker in front of syntax at the start of a line, such as `#` or `-`, would change the Markdown structure; then the content is inserted as written and the caret is not placed.
- Older block notes have no caret, so `'caret'` falls back to the end of the note. On hosts without the method, fall back to `insertMarkdown`.

Editor extensions (`ctx.registerEditorExtension`) receive the Forsion editor's own ProseMirror, so besides handling keys and adding decorations they can change text and move the caret (the LaTeX Suite plugin jumps the caret between placeholders this way). But if all you need is "insert a template at the caret and put the caret on a marker", use `insertMarkdownAt` above first: parsing, undo and the read-only check are handled for you.

## Network access and third-party libraries

The desktop app's Content Security Policy (CSP) blocks loading **scripts** from other sites, so bundle third-party libraries into the plugin's own `main.js` (there is no size limit). **Network requests are not limited by the CSP**: it allows `https:` and `wss:`, and when an API sends cross-origin headers (`Access-Control-Allow-Origin`) the plugin can call it with `fetch` directly. When an API doesn't send that header, the request fails (`TypeError: Failed to fetch`) because of the browser's cross-origin rules (CORS), not the CSP.

For those APIs use `ctx.net.request`, which Forsion's main process sends on the plugin's behalf (2026-11-16+, desktop only; web, mobile and older hosts have no `ctx.net`, so check before using it). The plugin first lists the hosts it will reach in the manifest's `network` array:

```json
{ "network": ["api.example.com", "*.cdn.example.com"] }
```

```js
const res = await ctx.net.request('https://api.example.com/v1/items', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(query) })
if (res.status === 200) render(res.json())
```

- Write host names only, with no scheme, port or path. `*.example.com` covers subdomains at any depth but not `example.com` itself; list both if you need both. The main process reads this list from the manifest on disk for every request. The plugin's detail page, the store facts of an installed plugin and the sandbox install confirmation show "Accesses: …"; it is not shown before a store install yet.
- Only https on the default port (443). Hosts written as IP addresses, or that resolve at connect time to local, private or reserved addresses, are refused; at most 5 redirects, and every hop is checked against the list again. Forsion's cookies and sign-in are never attached: send your own `Authorization` header if the API needs one.
- The response is at most 10 MB after decompression; `timeoutMs` defaults to 30 seconds and is capped at 60; each plugin can have at most 8 requests in flight; requests still pending when the plugin is disabled fail.
- `res` has `status`, `headers` (lower-case names), `bytes`, `url` (the final URL after redirects), `text()` and `json()`. 4xx and 5xx responses resolve normally; only transport problems reject, with an error whose `code` is `net_domain_not_declared` (not in your list), `net_blocked_address`, `net_timeout`, `net_too_large`, `net_bad_url`, `net_bad_request` or `net_failed`.
- https APIs that send cross-origin headers can still be called with plain `fetch`.

The web and mobile versions have different CSPs; test there separately.

## Secrets and translation services: `ctx.secrets`, `ctx.registerTranslationEngine` (2026-11-24+)

### Storing API keys: `ctx.secrets`

Desktop only (check `if (ctx.secrets)` first). Values are encrypted with the system keychain and stored on this computer, separately per plugin; they are not synced, not part of plugin data and not in diagnostic snapshots. Uninstalling the plugin without "Keep settings" deletes them.

```js
await ctx.secrets.set('svc.deepl', JSON.stringify({ key }))
const saved = JSON.parse(await ctx.secrets.get('svc.deepl') || 'null')
```

- Methods: `get(key)` (`null` if never set), `set(key, value)`, `delete(key)`, `has(key)`, `keys()`. `has` and `keys` do not decrypt.
- Keys match `^[a-z0-9][a-z0-9._-]{0,63}$`, values are at most 8192 characters, at most 64 keys per plugin.
- Failures carry `err.code`: `secrets_bad_key`, `secrets_too_large`, `secrets_too_many`, `secrets_unavailable` (no system encryption on this computer; nothing was stored, never plaintext), `secrets_locked` (stored but cannot be decrypted right now, e.g. a locked keychain; **not** "never set": don't treat it as empty or overwrite it), `secrets_failed`.
- Never put a saved key back into an input; show "Saved, leave empty to keep it".
- Plugins share the renderer process with the host: per-plugin separation keeps things tidy, it is not a security boundary.

### Offering a translation service to the whole app: `ctx.registerTranslationEngine`

Same gate as `ctx.tangu.translate`. Once registered, users can pick it in the result card's service menu and in Settings → Models → Default models → Translate; when it is chosen, editor Translate, selection-bar translation and other plugins' `ctx.tangu.translate` calls without a `modelId` all go through it.

```js
const off = ctx.registerTranslationEngine({
  id: 'deepl',                       // ^[a-z0-9][a-z0-9-]{0,31}$; registering the same id again replaces it
  name: 'DeepL',                     // a string or { zh, en }
  ready: () => hasKey,               // cheap and synchronous; false hides it from the choices
  translate: async ({ text, to, before, signal }) => callDeepL(text, to, before, signal),
})
```

- `to` is an English language name (`'Chinese (Simplified)'`, `'English'`, `'Japanese'`, `'Korean'`, `'French'`, `'German'`, `'Spanish'`, `'Russian'`; more may be added); map it to the vendor's codes yourself.
- Formulas, code and link targets in `text` have been replaced with markers like `ZXQ1a2b3c4d_0QXZ`; keep them unchanged in the translation. The host restores and checks them; if markers are lost it retries once with the same engine, then fails with `translation_format_lost`.
- `before` is the passage before the selection, for disambiguation only (e.g. DeepL's `context`); don't translate it into the result.
- On failure reject with a human-readable message ("DeepL didn't translate: the key was rejected (HTTP 403)"); that is what the user sees on the card, with the code `translation_engine_failed`. If the chosen service's `ready()` is false the call fails with `translation_engine_unavailable`; the host **never switches services silently**, and the card offers "Retry with Forsion models".
- Disabling or reloading the plugin unregisters it. A choice whose engine is not registered (plugin disabled, web and mobile) counts as no choice and uses Forsion models.
- The choice is stored on this computer and not synced (the keys stay on this computer too).

### The current choice: `ctx.translation`

- `current()` returns `{ engine: { pluginId, id, name } | null, model: { id?, name } }`; `engine: null` means Forsion models (the Translate slot).
- `use(id | null)`: switch to one of **your own** engines, or back to Forsion models; other plugins' engines are refused.
- `subscribe(cb)`: called when the choice or the set of registered engines changes (in any window); returns an unsubscribe function.

### Service menu on the result card: `card.service`

Add `service: true` to `card` in `registerSelectionAction` (only for `output: 'preview'`): the card head's "Machine translation · …" line becomes a small dropdown with the current service, listing every available engine, "Forsion models · <model>" and, when the plugin registered a settings page, "Translation settings…". Picking one changes this computer's choice and reruns immediately. When the action fails the card adds "Retry with Forsion models" (this time only: that run gets `cx.noEngine === true` and its `ctx.tangu.translate` calls skip the engine; if you keep a cache, don't serve this run from the engine's entries or store its result under the engine) and "Open settings". This only matters when `run` translates through `ctx.tangu.translate`.

Write each vendor adapter from the vendor's official API docs, list the API hosts in the manifest's `network`, and call them with `ctx.net.request`.

## Internal APIs: `ctx.internals` (2026-11-16+)

When the public APIs are missing something and you don't want to wait for a Forsion release, internal APIs let you read Forsion's own state or take its internal modules directly. **They are not stable**: everything in them follows Forsion's internals and can be renamed, reshaped or removed in any version, without notice and without counting as a breaking change. Desktop only: on web, mobile and older hosts `ctx.internals` is `undefined`, so always check before use.

There are two levels, both declared in the manifest's `capabilities`:

```json
{ "capabilities": ["internals"], "internalsVerified": ["2.14"] }
```

**Level one, `internals`**: read only. You get frozen copies of the data with no functions in them, so they can't change Forsion.

```js
const k = ctx.internals
if (!k) return
k.stores()                                            // what you can read: page, app, workspace, spaces, commands, ui…
const path = k.read('page', (s) => s.activePage)      // page is the active panel
const off = k.subscribe('page', (s) => s.activePage, (now, prev) => { /* … */ })
k.host.mainWindow                                      // each window runs its own copy of the plugin; do your own vault writes in the main window only
```

- Copies drop functions and class instances; a `Date` becomes milliseconds, a `Map` an array of `[key, value]` pairs, a `Set` an array. The `selector` gets a copy too.
- `subscribe` handles several changes in one turn once, and only calls you when the selected data changed. The host unsubscribes when the plugin is turned off.
- To write, use the public APIs: renaming, moving, folders and file writes are in "Folders, file times, renaming and moving in the vault" above, which ask the user before touching files your plugin didn't create.

**Level two, `internals-raw`**: the real objects of Forsion's internal modules, for reading and writing. Declare it together with `internals`.

```json
{ "capabilities": ["internals", "internals-raw"] }
```

```js
const ids = await ctx.internals.raw.modules()          // which modules you can take
const { usePageStore } = await ctx.internals.raw.import('host:desktop/frontend/src/amadeus/store/pageStore.ts')
```

- Only modules registered in Forsion's shared module table are available (page state, chat state, the layout engine, React and others); unregistered modules and variables private to a function are not.
- **At your own risk**: writing something wrong may not throw; objects you took can't be taken back when the plugin is turned off, so the user is asked to save and reload the window. If you change one of Forsion's own actions, undo it yourself when the plugin is turned off.
- For note files, still prefer the public APIs: Forsion's writes check for conflicts, rewrite links and record deletions for sync, and going around them loses data.

**How the plugin page and the store show it**: plugins that declare internal APIs carry a badge in Settings → Plugins (a stronger one for level two), and the detail page states the risk. Use `internalsVerified` to list the Forsion versions you checked (minor versions only, such as `"2.14"`). When the user's version isn't listed, the detail page says it wasn't checked on this version. That is a label, not a block.

**When it fails**: errors that a plugin declaring internal APIs doesn't catch are counted against it. Three within a minute and Forsion turns it off and tells the user, who can turn it back on in the plugin page. A copy loaded for development in the sandbox is never turned off this way; its errors go to the console as usual.

**Store listing**: level one is reviewed as usual. Level two needs an application: in the submission's internal APIs reason field, say which modules you need and why the public APIs are not enough. Review is per version, so each new version is reviewed again before users get it. The desktop app won't install an unapproved version from the official store. Development loads, manual installs and third-party store sources aren't affected.

Check it with `node check-plugin.mjs <plugin folder>`: it reports use without declaring, declaring level two alone and reaching into React's internals, and lists the level-two modules the plugin takes.

## Demo stage: `ctx.stage` (2026-11-20+, experimental)

To make demo images or videos of a feature (store screenshots, release notes, promo material), you can ask Forsion to start a **demo stage**: a separate, isolated copy of Forsion that only holds the demo content your plugin package ships and the plugins you name. It is not signed in and never touches the user's vault or plugin data. You drive it step by step, then take full-resolution screenshots or record video. Desktop only; declare it in the manifest:

```json
{ "capabilities": ["stage"] }
```

```js
const stage = await ctx.stage?.open({
  fixture: 'fixtures/calendar-demo',  // folder in your plugin package: vault/ becomes the stage's vault, engine.json drives chat replay, human/CALENDAR.db is My calendar
  plugins: ['calendar'],              // installed plugins to bring in (package only, not their data)
  theme: 'light', locale: 'en',
  window: [1440, 900, 2],             // 1440×900 content at density 2: captures are 2880×1800 whatever the user's screen
  clock: '2026-11-20T10:00',          // where "now" starts in the stage (local time), so dates look the same every take
  engine: 'scripted',                 // optional: replay chats from engine.json, no model quota; default is no engine
})
await stage.space('calendar')
await stage.click('Friday')            // a reference from read (e12), css:<selector>, or the control's visible text
await stage.type('Launch event'); await stage.press('Enter')
const { outline } = await stage.read()
const shot = await stage.capture({ selector: 'main' })   // { bytes, width, height, mime: 'image/png' }
const rec = await stage.record({ fps: 30 })               // records this window; a pointer moves to each click first
await stage.click('New event')
const video = await rec.stop()                             // { bytes, mime, width, height, durationMs }
await stage.close()
```

- **The first `open` asks the user** for permission; once allowed it does not ask again. If they decline → `denied`.
- There is one stage per computer at a time: while another plugin has it open → `busy`. Opening again from your own plugin closes the previous one first. The host closes it when your plugin is disabled or reloaded; after 5 idle minutes it stops on its own.
- Every `open` starts fresh from the demo content; tabs and settings from the last run are not carried over.
- `fixture` only accepts a relative path inside your plugin package, and symlinks in it are not copied. Only installed plugins can open a stage (not the copy running in the plugin sandbox).
- Screenshot pixels = window size × density; `rect` is in CSS pixels. Recordings are at most 3840 pixels wide and 120 seconds long (they stop on their own at the limit and `stop()` still returns them). The default is mp4; pass `format: 'webm'` for WebM.
- `engine.json`: `{ "models": [...], "runs": [{ "match": "text from the user's message (optional)", "events": [{ "type": "token", "payload": { "delta": "…" }, "delay": 40 }] }] }`. Each message sent in the stage replays the first matching entry in `runs`.
- The personal calendar (My calendar) is not in the vault: the calendar asks the engine for `human/CALENDAR.db`. To film a calendar with events, put `human/CALENDAR.db` in the fixture and use `engine: 'scripted'` (for a calendar-only shot, `engine.json` can be `{ "runs": [] }`). The replay engine serves it in place of the file in the real engine home. The format is the same as the real one, a plain database table up to 8 MB; every column needs `id` / `name` / `type` and every row `id` / `cells`, and in a table with a checkbox column every row is drawn as a to-do with a tick box: `{ "version": 2, "name": "My calendar", "columns": [{ "id": "name", "name": "Name", "type": "text" }, { "id": "date", "name": "Date", "type": "calendarDate" }, { "id": "done", "name": "Done", "type": "checkbox" }], "rows": [{ "id": "ev1", "cells": { "name": "Launch review", "date": "2026-11-20T14:00/2026-11-20T15:00" } }] }`. Edits to the calendar on the stage stay in that stage only. Without the file the stage shows an empty personal calendar; with `engine: 'none'` there is no engine, so the personal calendar can't be loaded. A link, something that is not a file, or a bad format makes `open` fail with `fixture-invalid`.
- Every failure rejects with an error that has a `code`: `unsupported`, `invalid`, `denied`, `busy`, `fixture-invalid`, `plugin-missing`, `timeout`, `closed`, `error`.
- **Publishing**: plugins that declare `stage` must pass store review before the official store installs them (the same per-version review as `internals-raw`). Dev loading and manual installs are not affected.
- ⚠️ `window.tangu.pluginSandbox` and `window.tangu.pluginStage` are internal host channels. Do not call them from a plugin; use `ctx.stage`.

## Removing commands and default shortcuts

`ctx.registerCommand` returns a function that removes exactly this registration (2026-11-16+). Registering the same `id` again from the same plugin replaces the earlier command in place (title, action and shortcut all updated), and the replaced registration's remover no longer does anything. So a plugin can add and remove commands while it runs (one per enabled template, say) without being reloaded. Disabling the plugin still removes all of its commands. Older hosts return `undefined` and add a duplicate when an `id` is registered again, so write `off?.()` and register each `id` only once there.

```js
const off = ctx.registerCommand({ id: 'my-plugin-insert-daily', title: 'Insert daily template', hotkey: 'Mod+Shift+Y', run: insertDaily })
off?.()
```

`hotkey` is the command's default shortcut, and only a suggestion:

- It must include `Mod` (⌘ on macOS, Ctrl elsewhere). With `Shift`, pair it with a letter, `[`, `]` or a named key such as `ArrowUp`, `F5` or `Enter` (Shift with a digit or punctuation types a different character and never matches); `Space` is not supported. Anything else is ignored with a console warning.
- It takes effect only while nothing else uses the key: Forsion's own commands, system and editor shortcuts, a key you set for another command, or another plugin's default for the same key (then neither plugin gets it). A key you set for this command always wins.
- An inactive default is marked in Settings → Shortcuts with "Plugin default {key} conflicts with “{other}” — not active", and switches on by itself once the key is free. You can always set a key for the command there yourself.
- Older hosts ignore `hotkey`.

## IM channels

An engine plugin can bring in another chat app (WeCom, for example) and reuse everything the built-in WeChat, Telegram and QQ channels have: a fresh session on connect, remote approvals, commands such as `/new` and `/model`, inbox forwarding, and the channel folder in the sidebar. Once installed, Settings → Channels shows a card for it; fill in the credentials the plugin asks for and click Connect. Disabling the plugin stops the channel and keeps the sessions it was bound to. For the API, see `ctx.registerChannel` in the engine plugin section of the plugin development skill; the WeCom plugin is a working example.

One account can also serve many contacts: with `multiPeer: true`, each contact gets its own binding, session and working folder, so their conversations stay apart. They all use the same agent under the same account, so agent memory is shared, and these sessions have no project memory. The working folder only keeps files apart and is not a sandbox: tools running on the host can still read other folders, so be careful about who may talk and how tools are approved. The driver decides who may talk. These contacts do not own the channel, so `/stop` is the only command, inbox messages are not forwarded, and the desktop cannot switch the connected session. Older engines silently ignore the key, so check `ctx.channelCapabilities?.multiPeer` first. An inbound message can carry `agentSlug` to pin an agent for that contact.

For an unattended deployment whose credentials are written straight into the config, with nobody to press Connect, add `selfConnect: true`: on an account that has never connected, the first contact your driver hands over connects it for the local user. An account the user disconnected stays disconnected.

When a driver implements `sendApproval`, approvals stop being text cards: the driver receives the tool name, arguments and preview, draws them itself, and answers through `respond`. Chat text can neither approve nor dismiss such a card, and it is rejected after 10 minutes with no answer. Implement `settleApproval` to learn how a card ended. A plugin's UI can fill in and connect a channel from its own bundle with `ctx.tangu.connectChannel(kind, fields, { modelId })`. This is desktop only, and other plugins' channels are refused. `modelId` becomes the channel's default model when it has none yet; a model the user chose stays.

## Automation triggers

A plugin can add its own "when" to automations: register it with `ctx.automation.registerTrigger`, then call `ctx.automation.emit` when the event happens. Once registered it appears in the "External and plugins" group of the automation canvas trigger node. Users write the rules themselves and can restrict them by hours, weekdays, cooldown and a daily limit. "Remind me directly" costs no budget; "Wake Muse" goes through the usual budget checks.

You can only register inside your own namespace: `id` is a key, and the host builds `plugin:<plugin id>:<key>`. Names need both zh and en. When the plugin is disabled or uninstalled the trigger is unregistered; its rules are kept, paused with a stated reason, and resume once it is back. Events are not saved to disk, so an engine restart loses any a rule has not seen yet. Engine plugins use the same methods on `ctx.sdk.automation`. See `references/tangu-host-apis.md` in the plugin development skill for the code.

## Notifications (`ctx.notify`)

`ctx.notify(message, { level, title, action, key, undo, urgent })` shows a card in the top-right corner on desktop. On a phone (a window narrower than 640) it is a banner under the status bar: it covers the row of capsules at the top, never the page's content, and shows one card at a time while the rest wait. The source and the message take one line each and are cut at the end when they do not fit; the button and × sit on the same line at the right. On a phone, tapping the message does what the button does, and swiping up or tapping × dismisses it.

- How long it stays: on desktop, 8 seconds with a button, otherwise by level. On a phone, 5 seconds, 10 seconds while a screen reader is on; `error` and `sticky: true` stay until dismissed.
- `key`: a later card with the same key replaces the earlier one. On a phone the words and the button change in place, and the time counts from when the card first appeared, without starting again.
- Throttling on a phone: after a card from your plugin goes away, the host shows no more of your cards for a while (30 seconds when it timed out, 2 minutes when the person swiped it away or tapped ×). `ctx.notify` still returns normally and does not throw, so keep counts or state in your own interface (numbers in a list, a badge on a tab) for when the person comes back. System notifications while the app is in the background are never throttled.
- `undo: true` (since 2026-11-15): this card is the way back from something the person just did (Undo after a delete). On a phone it stays 8 seconds and is never throttled.
- A card with a button that you show synchronously while handling the person's tap or key press (an Undo right after a delete) is treated the same way on a phone, even without `undo`: 8 seconds, never throttled. If you show it from a callback, after waiting for a file or the network, the host cannot tell it came from what the person just did, so pass `undo: true` yourself.
- While the app is in the background, a phone shows no banner, only the system notification. The cards wait and come one at a time once the person is back, with the same throttling, but not as a whole backlog. The card on screen when the app goes to the background (unless it is sticky) is taken back too: it comes first once the person is back (waiting `urgent` cards still go before it), for its full time, and never times out in the background. These always stay: cards with `undo`, sticky cards, `error` cards, the card that was on screen, and cards whose system notification could not be posted (for example when the person turned system notifications off or never allowed them; these come one by one once the person is back, without the per-plugin cooldown). Of the rest, `urgent` cards keep the newest one per plugin and key, and all of them stay (separate approvals all stay; the system notifications are cleared from the shade once the person is back, so none are dropped). Other cards keep the newest one per plugin and fill whatever is left of 3 slots, newest first; when there are already 3 or more `urgent` cards, none of them stay. The system notifications for the ones left out have already been posted; keep the numbers in your own interface.
- While a native sheet from the bottom of a phone's screen (a menu, a text prompt, a confirmation) is open, no banner shows either: the cards wait, without counting down, the card on screen (unless it is sticky) is taken back as well, and they come once it closes, each for its full time.
- System notifications: a plugin keeps only its latest one, except cards with both `urgent: true` and a `key`, which get their own notification per plugin and key (a later one with the same key replaces it). So give cards like approvals `urgent: true` and their own key, and your later ordinary cards will not replace them.
- `urgent: true` (since 2026-11-15): someone, a person or an agent, is stopped and waiting for the person (an approval, for example). On a phone it is never throttled and goes ahead of cards that can wait. It is not sticky; it stays as long as any other card.
- Both only count when they are `true`, and older hosts ignore them, so you can pass them without checking the host version. Give a card that skips the throttle its own `key` (such as `approval:<id>`) instead of sharing one with ordinary cards; otherwise it replaces them.

## When plugin data can't be read

Since 2026-11-17, `ctx.loadData()` tells "never saved" apart from "saved but unreadable". It returns `null` when nothing was ever saved (or when the saved value is `null`). When the data exists but can't be read (a read error, an empty file, a write cut off halfway, a hand edit that broke it), it rejects with an error whose `code` is `plugin-data-unreadable`. Before, the host treated that case as never saved too, so the plugin started from defaults and its next `saveData` overwrote everything the user had.

When you get this error, don't carry on with defaults and save. Turn off the feature that needs the data, tell the user, and try again on the next load. The host never changes the original file. If a plugin catches the error and saves anyway, the desktop and phone apps first copy the original to `<id>.json.unreadable-<time>`, and refuse the save when even the original can't be copied. For a plugin with `"syncData": true`, if the local file's content is broken and there is a copy in the cloud, the host restores the cloud copy and `loadData` returns normally. Data the plugin saves after a failed read is not uploaded and can't replace the cloud copy until the host has checked with the cloud, even if a later read succeeds or the app restarts. Once a read has failed, this applies to every save the plugin makes until it is reloaded. The next time the cloud is reachable, the cloud copy replaces it if there is one, and the local data it replaces is first copied to `<id>.json.replaced-<time>`. If the cloud has no copy, the local data is uploaded, unless another device uploads one first, in which case that copy wins. If you `await` it in `setup` without catching it, the plugin fails to load and the plugin list shows "Failed to load". Older hosts still return `null` when the data can't be read.

Since 2026-11-18, `ctx.saveData()` rejects a value that turns into nothing as JSON (a function, a `toJSON` that returns `undefined`) and writes nothing. Before, such a value was written as empty content, which the next load then couldn't read. A BigInt or a circular reference already made it reject.

## Plugin data sync across devices

A plugin that sets `"syncData": true` in its manifest has the data it saves with `ctx.saveData` synced to your other computers and phones through your Forsion account. When you are signed out or offline, the data stays on this device as before and is uploaded once you are back online. If two devices both changed it, the later change wins. The plugin's detail page has a "Sync plugin data across devices" switch to turn it off on one device. If someone uninstalls the plugin without ticking "Keep settings", the copy in the cloud is cleared too; restoring from the Trash uploads this device's copy again, and any other device that still has the plugin uploads its copy as well. The web version does not sync yet. For the API, see the `loadData/saveData` notes in the editor section of the plugin development skill.

## Plugin data folder: `ctx.storage` (2026-11-26+)

Plugins used to have only the one JSON blob of `ctx.loadData` / `saveData`, so a plugin that stored images, drafts, caches or indexes had to write them into the user's vault under `Plugins/<plugin ID>/`: the vault kept growing, and all of it synced along with the notes. Now every plugin has a **plugin data folder outside the vault**, `ctx.storage`, for text or binary files of any size. The skill carries the same description in `references/plugin-storage.md`.

### What goes in the vault, what goes in plugin data

- **In the vault** (through `ctx.app.workFolder()`): notes the plugin saves for the user (things they open from the file tree), the files those notes embed, and finished exports the user asked to save there.
- **In `ctx.storage`**: everything that belongs to the plugin itself: settings and state beyond the JSON blob, indexes, caches, drafts, trial versions, intermediate output, logs, job records, undo copies, version snapshots, window captures, renders, bundled scripts and tools.
- **Self-check**: after uninstalling this plugin, would the user still want this in their vault? Yes → vault. No → `ctx.storage`.
- **The one exception**: a small index (a few KB) that only makes sense next to the notes, such as "which note was clipped from which URL", may stay a dot-file in the work folder. Anything large or ever-growing (snapshots, undo copies, one sidecar per image, renders, window captures, tool scripts) goes into `ctx.storage`.

| Example | Where |
|---|---|
| Clipped articles, meeting minutes, transcripts, quick notes, literature notes, weekly reports, card decks, whiteboards, mind maps, video project files | vault |
| Images, audio and video embedded in those notes; a PDF or mp4 the user chose to export | vault (beside the note, or where the user chose) |
| Trial drafts, the image of every render, window captures | `ctx.storage`; give the user a "Save to vault" button for the one they want to keep |
| Indexes, caches, job records, undo copies, version snapshots, raw output of a failed model call | `ctx.storage` (per-library ones in the `vault()` layer) |
| Scripts, tools, music and notes the plugin keeps for itself | `ctx.storage`, or ship them in the plugin package |
| Recordings, imported 3D models, dropped-in reference originals | either: the vault when a note links or embeds it, `ctx.storage` when only the plugin uses it |
| A few-KB index that matches notes to their sources | may stay a dot-file in the work folder |

The host does not block vault writes. A dev copy that writes a dot-file, or a single non-note file (not `.md` / `.db`) over 5 MB, into the vault gets one console hint; installed plugins get none. The work folder's default is unchanged (`Plugins/<plugin ID>`, and a folder the user set still wins); its meaning narrows to "where the plugin saves notes for the user". A plugin that saves no notes never creates its folder in the vault.

### API

Paths are relative to the layer and `/`-separated; `..`, absolute paths (a leading `/`) and drive letters throw a `TypeError`. After the plugin is turned off, the read and write methods reject (`plugin-disposed`) and `url()` / `vault()` return `null`.

```js
const store = ctx.storage
if (store) {
  await store.write('exports/c1.png', pngBytes)          // atomic, creates parent folders
  img.src = store.url('exports/c1.png')                   // an address for <img> / <video>
    ?? URL.createObjectURL(new Blob([await store.readBytes('exports/c1.png')], { type: 'image/png' }))
  const files = await store.list('exports')               // [{ name, path, kind, size, mtime }]
}
```

- `readText(path)` / `readBytes(path)`: `null` when the file does not exist; **any other read failure rejects**. Never treat it as empty and write defaults over it.
- `write(path, data)`: temp file + rename, replaces an existing file. A plugin's write-type calls (`write` / `append` / `remove` / `move` / `importFromVault`) share one queue and run in call order, so while a long `importFromVault` runs, that plugin's later writes wait for it. `append(path, data)` appends (creating the file when missing), for writing large output such as recordings in chunks; it is not atomic.
- `list(folder?)`, `stat(path)`: `[]` / `null` when missing. `remove(path)` deletes permanently (this is the plugin's own data: no trash). `move(from, to)` moves within the same layer and rejects when the target exists.
- `usage()`: bytes of the whole folder (both layers) and of its `cache/` folders.
- `url(path)`: a synchronous address for `<img>` / `<video>` / `fetch`, read in byte ranges (videos can seek). `null` where the host cannot give one: then read the bytes and make a Blob URL.
- `hostPath(path?)`: the absolute path of a file or folder in this layer on the computer (omitted = the layer root), for handing to the Agent or a script (a `cwd`, a script path). Async; it has a value only when the engine runs on this computer (the same gate as `ctx.app.hostPath`), and is `null` on mobile and after the plugin is turned off. It only computes the path: it does not create the folder or check that it exists, so write into it first. Older hosts lack it: `await ctx.storage?.hostPath?.('tools')`.

### Two layers

- `ctx.storage` follows the app: it survives switching vaults and works with no vault open.
- `ctx.storage.vault()` is a layer per library (`vaults/<library key>/` in the same folder), for indexes and caches derived from one vault's notes. `null` with no library open; the methods are the same. It is also `null` while the library is still being restored at startup: call `vault()` when you need it rather than keeping the one you got at startup. The key comes from the library folder's path: a library moved outside Forsion gets a fresh, empty layer, and the old one stays and still counts in `usage()`. After the user switches libraries, operations on the old library's layer reject: call `vault()` again.
- `cache/` in either layer is the plugin's to rebuild at any time: "Clear cache" in the Data section of the desktop plugin page empties only that.
- Reserved names (any letter case): the top-level `vaults/` on the app layer and the top-level `.forsion-imports/` (import records) on a vault layer; writes there are refused.

### Where it lives, where it exists

| Host | `ctx.storage` |
|---|---|
| Desktop | `~/.forsion/tangu/plugin-data/<plugin ID>/` (dev: `~/.forsion-dev/…`; Store installs use `market-<uuid>` as the plugin ID), the same folder as a same-ID engine plugin's `paths.dataDir` |
| Mobile app | the app's private data folder (`Data/plugin-data/<plugin ID>/`). `url()` returns `null` until the app has resolved its file address at startup. `importFromVault` rejects on a cloud vault (nothing is written) and works on a local vault; uninstalling keeps this folder (like the JSON blob) |
| Web, shared pages, older hosts | absent: write `ctx.storage?.…` |

⚠️ Don't confuse it with `~/.forsion/plugins-data/<id>.json` (with an s): that is the `ctx.loadData` / `saveData` blob. Hard-code neither path.

Not synced with the account (`syncData` covers only the JSON blob), not in the vault, no library needed. When the plugin is uninstalled on desktop, its data folder goes to Forsion's trash together with its settings; ticking "Keep settings and data for a reinstall" keeps it.

When the host has no `ctx.storage` (web, older versions), keep doing what you did before (small state in the JSON blob, files in the work folder), or turn the feature off and say why; don't push large data into `localStorage`.

### Old data already in the vault

The host never moves or deletes old files in the vault. For old data the plugin recognises, copy it in with `importFromVault`; the originals stay in the vault for the user to delete or keep (the Data section of the plugin page says how many files the work folder still holds).

```js
const v = ctx.storage?.vault()                      // needs an open library
if (v) {
  const r = await v.importFromVault({
    id: 'index-v1',                                   // [a-z0-9][a-z0-9._-]{0,63}; once per library
    from: `${ctx.app.workFolder()}/.my-index.json`,   // vault-relative
    to: 'index.json',                                 // optional; default: the layer root
  })
  // r.status: 'complete' / 'already-done' → read the copy in v from now on
  //           'missing' → nothing there, nothing recorded; call again later (sync may deliver it)
  // r.skipped: targets that already existed with different content, left alone
}
```

- `from` must be inside your work folder, `Plugins/<plugin ID>` or `Plugins/<display name>` (the default before 2026-10-21); anything else rejects.
- Copy, never move: every file is checked against its original. A second call with the same `id` returns `already-done`; a completion record that cannot be read or recognised rejects, so don't treat that as "not copied yet".
- Call `ctx.storage.importFromVault` for data that follows the app and the `vault()` layer's for per-library data; both need an open library.
- Don't delete the vault originals yourself after copying; tell the user they can.
- This is not `ctx.app.migrateWorkFolder`: that one moves **notes** from an old folder into the new English-ID work folder.

### The engine half

`ctx.paths.dataDir` is still `<TANGU_HOME>/plugin-data/<engine plugin ID>/`. An engine plugin inside a Forsion plugin bundle also gets `ctx.paths.bundleDataDir` (2026-11-26+): the bundle's plugin data folder `<TANGU_HOME>/plugin-data/<bundle plugin ID>/`, which is what the desktop half sees as `ctx.storage` (the `market-<uuid>` folder name for Store installs, the bundle manifest `id` otherwise); it equals `dataDir` when the two IDs match. Older engines lack it: `ctx.paths.bundleDataDir ?? ctx.paths.dataDir`. The two halves share one folder only when the engine runs on this computer (the local managed engine); with an engine on another computer they are separate. The engine half also leaves the top-level `vaults/` alone and expects `cache/` to be emptied.

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

## Process-row sentences

Tangu folds a reply's tool calls into one process row; expanded, each call is one line. A plugin tool's line reads "plugin name · tool name" plus its first argument by default. A plugin with an engine half can call `ctx.registerToolLabel?.(…)` to describe its own tools in plain language instead, such as "Clicking “Send” in Chatter" or "Typed “See you tomorrow” in Chatter", optionally with the icon of the app being worked on. Claiming works like tool result cards: only tools the plugin's own engine half registered are handed to it.

The host calls the plugin's `describe` whenever it draws that line, passing the call's arguments, its result, its phase (running, done or error), the interface language, and the plugin's own earlier calls in the same reply (up to 40, so app and button names from earlier results can be reused). While the tool runs, the folded process row rolls through each step's sentence; once everything finished, the folded row keeps its summary and each line of the expanded list shows the "done" sentence. The current-step line in the Tangu summary panel uses the same sentence. Lines are rebuilt when you reopen an old conversation or switch the interface language. If `describe` throws or gives no sentence, the line shows as before; the sentences go away when the plugin is disabled or reloaded. App icons show only in the desktop app on macOS; elsewhere the usual tool icon shows. Only this line for people changes: what the model sees (tool descriptions and results) stays the same.

The host remembers each sentence: it asks again only when the call itself, its phase, the interface language or the earlier calls change. Write `describe` as a function of the data passed in, with no side effects. If a sentence or icon also depends on something else (an app icon you only learn later, for example), add `revision()` returning a number or string that changes along with it; the host asks again when it differs.

```js
ctx.registerToolLabel?.({ tool: ['act_ui', 'observe_ui'], describe(call) { return { text, icon: { appBundleId } } } })
```

## Stopping a run and following a run's status

`ctx.tangu.agentStatus` / `subscribeAgentStatus` take a session. From 2026-11-13 they also take `{ runId }`, which means the session that is running that run right now. That suits views that know a `runId` but not the session (such as the Computer Use live view). When no session is running it, the status is idle with an empty `runId`.

`ctx.tangu.stop?.(…)` stops a run the same way the stop button in the chat input does: with no argument it stops the current session in the main area, with a session id that session, and with `{ runId }` the session running that run. If the run cannot be found or the session is not running, nothing is stopped and it returns `false`; it never stops another session instead. Older versions and setups without chat do not have it, so do not show a stop button there. For the API, see the "Agent status" section of the plugin development skill.

```js
const ok = await ctx.tangu?.stop?.({ runId })
```

## Summary panel cards

The summary panel on the right of a Tangu chat (desktop versions after 2.13.8-beta.1) is a stack of cards: Progress, Background, Outputs, Sources, Scope and the Agent Desk. A plugin adds a card with `ctx.summary?.registerCard`. It sits in the same stack as the built-in cards; plugin cards start out above the Agent Desk, and the host remembers the order people drag them into. Cards open and close with their content: a card opens by itself when its `count` goes up. When someone opens or collapses a card by hand, that lasts until the current chat turn ends and is not remembered. `defaultCollapsed` decides whether the card stays collapsed while nothing new arrives. When the panel runs out of room, the host first collapses the card that has gone longest without anything new, or makes the last card's body shorter, so do not count on a 240px body. `mount` runs once in each chat's summary panel (switching chats unmounts and mounts again), and `host.sessionId` is the chat this copy belongs to. `host.update({ count, hidden })` sets the count in the card header or hides the card for now. The body is at most 240px tall (less when the panel is short), and the host scrolls anything longer. Only desktop Tangu has the summary panel, so use optional chaining; earlier versions have no `ctx.summary`. For the API, see the summary panel plugin card section of the plugin development skill.

```js
ctx.summary?.registerCard({ id, title: { zh, en }, defaultCollapsed, mount(el, host) })
```

## Home widgets (since 2026-11-07)

Home has widgets in its left and right columns and in the row under the chat box. A plugin can add its own cards: the plugin declares the card in its manifest and supplies the data, and the host draws it in the same style as the built-in Inbox and Recent notes cards. People add cards from Home → right-click → Edit Home → Add, where plugin cards sit in the Plugins group. When a plugin is turned off, its card shows a placeholder; when it is uninstalled, the card is not drawn (the placement is kept and comes back if the plugin does).

This version supports **list cards** only: each row has a time or a checkbox on the left, a title, and a short note on the right, rows can be grouped (for example "Tomorrow"), and there can be a footer line. Cards are read-only. Clicking the header or a row opens the Space you declare; the first version cannot check items off or write back.

List the card folders in your manifest. Each folder holds a `manifest.json`, the same folder layout as widgets made by agents:

```json
// manifest.json
"widgets": ["widgets/today"]

// widgets/today/manifest.json
{ "schemaVersion": 1, "id": "today", "title": "Today", "titleEn": "Today", "layout": "list", "icon": "date", "space": "calendar" }
```

- `id` is unique within your plugin (lowercase letters, digits, hyphens) and is stored in the Home layout as `plugin:<plugin id>/<id>`. `title` is required (your canonical name, usually Chinese); `titleEn` is shown in the English UI.
- `icon` is a name from the plugin icon vocabulary (the same list as `registerView`'s `icon`). Without it, the card uses your icon.png.
- `space` is the Space id opened when the header or a row is clicked; leave it out to stay on Home. Up to 8 cards; a broken one is dropped on its own.

Supply the data with `ctx.widgets.provide`. The host asks while the card is on Home; return an array of rows or `{ rows, footer, empty }`.

```js
ctx.widgets?.provide('today', async (_params, { signal }) => ({
  rows: [{ id: 'e1', time: '10:00', title: 'Book club', meta: 'In 1 h', tone: 'accent', now: true },
         { id: 'e2', time: '10:00', title: 'Product weekly', group: 'Tomorrow' }],
  footer: '1 of 3 done today',
  empty: 'Nothing on today',
}))
ctx.widgets?.invalidate('today') // data changed: ask the host to fetch again
```

- A row can have `title` (required), `time` (left column), `meta` (short note on the right), `tone` (`accent` / `warn` / `muted`), `done` (any value draws a checkbox; `true` strikes the row through), `now` (filled dot) and `group` (a small heading above the row when it changes). Up to 50 rows. Give the text in the language from `ctx.getLocale()`; the host fetches again when the language changes.
- The host asks when the card mounts, when you call `invalidate`, and when the window comes back to the front (at least 30 seconds after the last time). Only one request per card runs at a time, and a newer one aborts the older `signal`. If you take longer than 10 seconds or throw, the card says it couldn't load. It is never treated as an empty list.
- The host stops asking when the card is not on Home, so don't poll outside `provide`. For time-based text such as "In 1 h", call `invalidate` on a timer after you've been asked, and stop when you haven't been asked for a few minutes.
- Older hosts ignore `widgets` and have no `ctx.widgets`, so always use `?.`. API details are in the plugin development skill, section "Home widgets"; the Today and To-dos cards of the core Calendar plugin are the reference.

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

- `ctx.app.openSpace?(id)` switches to a Space and resolves once its layout is built; an unknown id returns `false`. From 2.13.8 it behaves like clicking the Space in the Ribbon: in a Space window locked to another Space, it opens that Space in its own window and leaves this window where it is. If the window is locked and can't open a new one, it returns `false`.
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

### First-use tips (since 2026-11-02)

When someone reaches a feature of your plugin, the host shows a one-time tip on how to use it, and stops once they have used it. You declare tips in the manifest; the host decides when they show, so you don't track "seen" yourself.

```json
"guide": {
  "tips": [
    {
      "id": "drag-to-calendar",
      "at": "todo-row",
      "style": "ring",
      "platform": "desktop",
      "when": { "visible": ["calendar-grid"] },
      "done": ["todo.schedule"],
      "title": "拖到日历上排时间",
      "text": "按住这条待办拖进日历的时间格，就排成那半小时。",
      "en": { "title": "Drag onto the calendar to schedule", "text": "Drop it on a time slot to book half an hour." }
    }
  ]
}
```

- `at`: the `data-guide-anchor="<name>"` of an element in one of your own views. The host only looks inside your views, so names can't clash with other plugins. A tip can only show while that element is on screen.
- `style`: `line` puts one line on the anchor's top edge (good for inputs); `ring` rings the anchor with a small card beside it and needs a `title`.
- `when`, one of: `{ "open": "<view id>", "times": 1 }` how often that view has been opened; `{ "count": "<event>", "atLeast": 3 }` a counter reached a number; `{ "visible": ["<anchor>", …] }` these anchors are on screen together. No `when` = it only shows when you call `ctx.guide.show(id)`.
- `done`: once any of these counters is ≥ 1 the tip counts as learned and never shows again. Counters are `ctx.achievements.track('<event>')`: report it once when the user actually does the thing. Bare names are your own tracked events; an `app:` prefix reads an official host event (for example `app:note.wikilink`).
- `platform`: `desktop` / `mobile`; leave it out for both. Dragging, hovering and shortcuts have no phone equivalent, so mark those `desktop`.
- Text: Chinese `title` / `text` plus the `en` mirror. **In an English interface a tip without `en` doesn't show** rather than falling back to Chinese. Keep titles to about 16 Chinese characters and bodies to about 40.
- Ids use lowercase letters, digits and `-`; up to 12 tips. A malformed tip is dropped on its own and the rest still work.

The host sets the pace: one tip at a time across the whole app (shared with the user guide's spotlight); at most 3 a day; a tip waits 2 seconds after its anchor appears and 1.5 seconds after the user stops typing; at most one per view opening; it waits while a popup is queued or open, or while first-run onboarding is open. Got it / × / Esc marks a tip as seen; "Don't show again" turns off all of your plugin's tips; Settings → Notifications → Tips turns tips off or resets them. Seen and turned-off state is stored on this device only.

**When a new version adds a feature**, give it a tip with a **new id**. Tips are recorded per plugin id + tip id, so people who upgrade see the new one when they get there, while old tips they have seen stay hidden. Don't rename an existing tip's id; that makes everyone see it again.

At runtime:

```js
inputEl.dataset.guideAnchor = 'todo-input'   // mark an anchor
ctx.achievements.track('todo.tag')            // the user really did the thing
ctx.guide?.show('tags')                        // ask for a tip when its condition can't be written in the manifest (pace and records still apply)
ctx.guide?.state('tags')                       // 'waiting' | 'seen' | 'learned' | 'muted' | 'off'
```

**Examples in an empty state**: `ctx.ui.mountEmptyState` now takes `examples` (up to 3). Clicking one should usually put that sentence into your input so people watch it get recognised and send it themselves, rather than creating something for them:

```js
ctx.ui.mountEmptyState(el, {
  icon: 'list-todo', title: 'No to-dos yet', line: 'Just type one below.',
  examples: [{ label: 'Tomorrow 3pm send weekly report #work', note: 'Dates and tags work as you type', run: () => box.insertText('Tomorrow 3pm send weekly report #work') }],
})
```

To see tips again while developing, run "Reset tips" from the command palette or use Settings → Notifications → Tips → Reset, then call `ctx.guide.show(id)` to bring up a specific tip. If a tip never shows, check in the developer tools that the element carries `data-guide-anchor` and sits inside your own view, and that its condition actually holds.

How this differs from the requirement gate (manifest `onboarding.requires`): a gate means the plugin can't work until something is done; a tip means it works and here is a trick. Older hosts ignore `guide` and show nothing; always call `ctx.guide` with `?.`.

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

Since 2026-11-26 the work folder holds only the notes the plugin saves for the user (plus the files those notes embed and exports the user asked to save there). The plugin's own indexes, caches, snapshots and drafts go in `ctx.storage`, and old data already in the vault is copied out with `ctx.storage.importFromVault`; see "Plugin data folder: `ctx.storage`" above. `migrateWorkFolder` only moves notes into the new work folder.

A status query without a plan can reconcile the migration journal of the previous display-name folder; write plans for an old target are still rejected, and manual preferences and vault / revocation checks still apply. Before migrating, bare media links are resolved against the original vault as they actually resolve there, keeping user-added attachments where they are (beside notes) instead of assuming an `assets/` location.

### Personal calendar (Desktop 2.13.6+)

Plugins that declare both `databases` and `calendar` receive `human://CALENDAR.db` when the local engine provides a personal calendar. Calendar members list it first and hide its old vault mirror. Pass this opaque reference unchanged to `ctx.databases`, `ctx.ui.mountRecord` and `ctx.app.mutateDb` (for schema / name changes); never hand it to filesystem read/write APIs. Membership and the date / done column mapping are managed by the host: `setMember` / `removeMember` return false, and hiding uses `setHidden`. Plugins with only the `databases` capability cannot access it; remote or mobile hosts without this source don't list it. Writes reuse the host's CAS and conflict replay.

When you subscribe to the calendar, `myCalendar` in the snapshot tells you how the personal calendar read went (hosts from 2026-11-10 on; older hosts leave the field out, so keep your existing check there): `ok` means it was read (a file that doesn't exist yet counts too; the first write creates it); `absent` means the host confirmed it has none (an older engine or server, or a device page showing someone else's device), so fall back to the behaviour you had without a personal calendar; `unknown` means this read failed (engine not running, network error, server error, damaged file), and `loading` means it is still being read. In the last two cases, don't create another table to stand in for it just because it isn't among the members: a failed read is not the same as no calendar. Ask the user to try again shortly and keep what they typed; the host pushes a new snapshot once the read succeeds. Treat values you don't recognise as `unknown`.

### Shared account

Desktop (with Forsion Extend loaded), Unit web account hosts and the mobile app all provide `ctx.account`, so the same plugin code runs on all three. Check that it exists before using `status()`, `login()`, `logout()`, `request(path, init)` and `subscribe(listener)`. `request` only reaches the account API and accepts no other origin; the host supplies credentials and preserves FormData/Blob file uploads. Switching accounts cancels old requests and makes reads from old response bodies fail; plugins must still cancel their own deferred tasks and clear the previous account's UI. The optional `saveDownload(blob, name)` returns `{ ok, error? }`: Android saves to the system Downloads, and browsers save a download file. Never store, import or forward account tokens.

On desktop, `request` is sent by the main process, which brings a few limits: request bodies must be JSON strings (FormData and Blob throw; use a presigned URL for large files), responses are JSON only, custom headers do not travel, each call has a 120-second cap, and DELETE sends no body. `abort` rejects at once, but a request already sent runs to completion and its result is dropped. Desktop `status()` has no `userId`. Paths are always relative to `/api`.

### Account entitlements

When a plugin needs the user to hold an entitlement, write `"requires": { "entitlement": "<name>" }` in the manifest. The array form still works. The plugin activates as usual and draws its own onboarding page: `ctx.account.entitlements()` returns `{ granted }`, where `true` means they have it, `false` means the server said they do not, and `null` means unknown (offline, signed out, an older server). Do not treat `null` as no. With nothing declared it returns `true`. The real gate is on the server. `requires.plugins` is Unit's package dependency list; desktop and mobile prerequisites stay in `requiresPlugins`. A store tag `entitlement:<name>` shows as a badge on the card and does not block installing.

### Space ribbon position and phone layout

In `space.json`, `"ribbon": { "after": "<spaceId>" }` places the icon after that Space the first time it appears, and leaves any position the user already chose alone. `"mobile": { "listFirst": true }` opens the left list first on phones, and picking an item opens the main view. Use it only when the left panel really is such a list; by default the main view comes first and the left panel is a drawer. When the main view takes over the native header, use `ctx.ui.claimHeader?.({ title, back, onBack, toList: true })`: back slides the list in, following the finger on an edge swipe, and `onBack` runs once the list is showing. A cancelled swipe calls nothing. Without `toList` the system back gesture and the header arrow only call `onBack`, which suits an overlay.

### External PDF file views (2026-10-29, feature branch)

Set both `external: true` and `override: true` to handle external PDFs opened with the operating system's Open With action on desktop hosts that support this API. Default opener preferences still apply. Cold startup waits for initial plugin loading. Older hosts and plugins without `external` keep the built-in preview.

For an external PDF, `mount(el, file)` receives `file.io`: `readBytes(path)` reads this PDF or its adjacent `.<filename>.annot.json`; `writeBytes(path, bytes)` writes only that annotation sidecar or a `.broken-<timestamp>` recovery copy. The source PDF remains read-only. `saveCopy(name, bytes)` shows the native Save As dialog, returns the saved name or `null` on cancellation, and refuses to overwrite the source. The general `ctx.app` file APIs remain vault-scoped. Surface write failures when the source directory is read-only.

A file-type cleanup may return `Promise<void>`. Closing a tab waits for its final save before revoking `file.io`; disabling the plugin still revokes immediately. When multiple tabs share a document, discard the handle belonging to a closed tab. External files are not imported into a vault or sent through note storage.

## Coordinated View layout

LCL keeps split Views side by side. When space runs out, the workspace content scrolls while the Ribbon, top chrome and status stay fixed. Panels and splits share a geometry transition without whole-page fading or text scaling. Collapsing a sidebar retains its mounted content; explicitly closing the View, disabling its plugin or replacing the workspace layout disposes it.

Use `ctx.registerView({ layout: { minWidth: 360, minHeight: 200 }, ... })` to declare minimum dimensions in logical CSS pixels. Existing Views inherit defaults: main 320 × 180, left 220 × 180, right 240 × 180 and bottom 240 × 140. A tab group takes the largest minimum among its tabs, so switching tabs does not repeatedly squeeze neighbouring Views.

In `mount(el, view)`, `view.getLayout?.()` returns `{ width, height, visible, compact, phase }`. `view.onLayout?.(callback)` sends an immediate snapshot and subsequent size, visibility or phase changes, and returns an unsubscribe function. `phase` is `transition` or `settled`; `compact` means content width below 480px. Expensive PDF, canvas or terminal adapters can update cheap chrome during transitions and refit when `settled && visible`. Do not remount content or reset document zoom merely because the window narrows. The host removes outstanding subscriptions when the View is disposed. Older hosts lack these methods; use `ResizeObserver` as a fallback.

Optional `preferredWidth` / `preferredHeight` seed allocation weights for new splits and the initial size of a sidebar that the user has not resized. Saved user ratios and sidebar sizes take precedence.


### Temporary panels for file views

Feature-detect `file.extendView` in `registerFileType.mount(el, file)`. It follows the same contract as `view.extendView`: `file.extendView?.open({ id: "ask", title: "Tangu", side: "right", mount(el) { /* ctx.tangu.mountChat(el) */ } })`. Main and detached file windows retain the document; file views in side panels get an overlay with Back. Reopening the same id retains content. Closing, navigating or disabling the file plugin closes the extension and revokes the old controller. On older hosts without this field, do not replace the document with a main-area chat as a contextual fallback.


## Agent settings and settings-page anchors

Use [`ctx.registerAgentSettings`](plugin-agent-settings.en.md) to expose effective values explicitly. UI and engine plugins share the contract; secrets expose configured status only.

Cloud settings pages can accept optional `mount(el, { anchor })` context. A `forsion/fx:<pluginId>:<pageId>#<anchor>` deep link supplies the section anchor. Scroll/focus the section after loading; ordinary mounts must not steal focus. Existing mount(el) implementations remain compatible.

### Note reading renderers

Use `ctx.registerNoteRenderer` to replace the read-only note surface while the host retains document and persistence ownership. See [Note reading renderers](./note-renderers.en.md) for the contract, failure fallback and lifecycle.

### Styling hooks for formula source in notes (since 2026-11-15)

While the caret is inside a formula (inline `$…$` or display `$$…$$`, single or multi-line), its source is shown and the host adds the
`math-source` class to the whole source, `$` included. It looks like Obsidian: monospace, italic, inline-code size. Each token also gets
a kind class: `math-source-dollar` (`$` / `$$`), `math-source-command` (commands such as `\frac` and escaped symbols such as `\{`),
`math-source-script` (`_ ^ &`), `math-source-letter`, `math-source-number` and `math-source-bracket` (`( ) [ ] { }`). Spaces,
operators and `%` comments keep the text color. Formulas the caret is not in, rendered output and the preview never carry these classes.

- **The classes sit on the same span**, not on a wrapper: write `.math-source.math-source-bracket`, not `.math-source .math-source-bracket`.
- **The host's token colors have zero specificity** (the selectors are wrapped in `:where()`), so a plain class selector on the class your
  plugin adds to a bracket, `$` or placeholder wins, whatever the stylesheet order. Host colors come from the `--math-src-*` variables
  and follow light/dark; give your own colors a light and a dark value too.
- Selected characters drop their token classes (the native selection color wins); `math-source` stays, so the font does not jump.
- `math-source-delimiter` is the older umbrella class (`$`, brackets, `_ ^`), kept for compatibility; the host no longer colors it.
- **A selection inside a formula** (both ends between the `$` signs, such as a placeholder selected with Tab) keeps the preview (the
  floating bubble above the line for inline formulas, with the caret mark at the selection end; below the source for display formulas)
  and gets no formatting toolbar, so selection actions listed under "⋯ → Plugins" on that toolbar do not appear there. A selection that
  crosses out of the formula, or takes the whole formula with its `$` signs, still gets the toolbar and no preview.

### Official cloud inbox channel

The locked first-party `forsion-extend` package can provide the account inbox through `ctx.app.provideInboxChannel?.(channel)`.
The channel implements `list(filter)`, `unreadCount()`, `patch(id, { read, archived })`, `readAll()`, `remove(id)` and `claim(id, client)`.
Optional `importLegacy(messages)` adopts owned desktop read/archive flags only when no cloud state exists.
Cloud message IDs start with `cloud:` and lists use the existing `InboxMessage` fields. Unread results may include
`revision` and `latestCreatedAt`, allowing reward and archive changes to refresh even when the unread count is unchanged.
Credentials remain in Extend's account adapter. The host merges this channel with native Agent/system letters and
filters duplicate legacy official broadcasts. Pass `null` to revoke the provider. The host also revokes it on disable/reload;
provide a fresh channel when the account changes. Older hosts omit this optional API.

The legacy desktop mailbox has no per-message cloud owner. Adoption binds that device cache once to the currently verified upgrade account; later account switches cannot import it again. Unowned legacy mobile caches are not imported.


### Split selection tools and shape corners (2026-11-12)

A `mountSelectionBar` tool may declare `menu: { title, open(sel, anchor) }`. The primary button still calls `run(sel)`. Its separate arrow calls `menu.open` with the actual button element, ready for `ctx.ui.popover(anchor, ...)`; never find anchors by inspecting host DOM. ArrowRight on the primary also opens its menu; Enter/Space operate either button. A child menu consumes Escape before the bar closes. Supply `title` in the current locale. Older hosts ignore menu, so retain a usable primary action or a fallback menu entry. Capture selection data when opening a menu that consumes it, and dispose menus when the view unloads or the plugin stops; never apply a stale selection.

```js
{ id: 'underline', title: t('underline'), icon: 'underline',
  run: (sel) => underline(sel),
  menu: { title: t('colors'), open: (sel, anchor) => openColors(sel, anchor) } }
```

`mountBoard` and `handle.update` accept optional `roundness: 'sharp' | 'round'`, forwarded to the engine's next-shape `currentItemRoundness`. Omission preserves the existing default. It never rewrites elements already in the scene. To edit an existing rectangle, preserve its complete element data and explicitly update the scene; do not normalize old scenes to a new corner style.
