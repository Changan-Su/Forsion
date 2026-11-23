# Where host UI data comes from (2026-11-23)

Read this while writing the plan (SKILL.md, "Default workflow"). For every host surface or mount your plugin uses, it answers four questions: what it reads, what it does to the user's data or sessions, whether it exists in the plugin sandbox and the demo stage (and how to seed demo data there), and whether it needs the **local managed engine**. Checked against desktop source on 2026-11-23; paths are in the Genesis repo, `FE` = `desktop/frontend/src`, `PS` = `FE/amadeus/plugins/pluginStore.ts`.

Source categories: **vault** (the user's open note library), **engine `human/`** (files in the Tangu engine's home, served by `/agent/human/*`), **plugin data** (`ctx.loadData` / `saveData`), **host memory** (state inside the running app, gone on restart), **cloud** (the user's Forsion account).

## The local managed engine gate

The desktop runs the Tangu engine either itself ("managed", the default install) or connects to one started elsewhere ("external"). Some plugin APIs only work with the managed engine on this computer. The gate is `hostExecution()` in `FE/tanguProbe.ts:553`: `window.tangu.executionCapabilities.host ?? (desktopConfig.mode === 'managed')`. On the desktop only the mode decides; web and mobile hosts set `host` themselves (mobile: `false`).

| API | With an external engine (and in the sandbox and stage) |
|---|---|
| `ctx.tangu.request(...)` | **throws** `A local engine is required` (before waiting for the engine), or `Local engine is unavailable` after the wait (PS:3003, :3011) |
| `ctx.tangu.connectChannel(...)` | returns `{ ok: false, error }` with the same two messages, never throws (PS:3023-3044) |
| `ctx.app.hostPath(rel)` | returns `null` silently; also `null` with no open vault, a cloud vault, or an absolute / `..` path (`FE/amadeus/plugins/hostPaths.ts:2-9`) |
| `ctx.tangu.startChat({ folder })` | the folder is **dropped silently**; the chat opens without a working directory (PS:3131-3132) |
| `ctx.tangu.mountChat(el, { folder })` | the mount shows `folder is not available on this host: <folder>` and no session is made (`FE/views/pluginChat.tsx:52-53`) |
| engine routes of your bundle (`/extensions/<folder>/<engine id>/…`) | the engine answers 403 `Local plugin routes only` (`tangu-agent/src/plugins/bootstrap.ts:217-229`) |
| personal calendar `human://CALENDAR.db` | the real engine answers 404 `HUMAN_LOCAL_ONLY`; the snapshot's `myCalendar` reads `unknown` (`tangu-agent/src/routes/human.ts:80-93`) |

**The host logs none of these refusals** (no console line, no diagnostics entry). A polling loop that swallows the error leaves only an empty view. So: catch the error, show its message in your view, and say in your plan and README that the engine half needs the local managed engine. `workPath` does not exist; `ctx.app.workFolder()` always returns a string (`Plugins/<id>` or the user's choice), even with no vault, so it is not an availability probe.

## Surfaces and mounts

| API | Reads | Side effects | Sandbox / stage | Managed engine? |
|---|---|---|---|---|
| `ctx.tangu.mountChat(el, { agent, folder, title })` | an **engine session**, one per (plugin, absolute working folder). The slot → session id map is in localStorage `tangu.pluginChats`. On mount it resumes that session; if it was deleted (404) or archived it **creates a new real session** (`FE/views/pluginChat.tsx:35-103`) | creates sessions that appear in the user's chat list; writes localStorage. **You cannot inject messages**: the handle only has `quote()` (the app-wide quote slot) and `prefill()` (the draft); the user sends. To write history use `ctx.tangu.importSessions` (capability `agentImport`), which makes separate sessions | sandbox: no engine → after 15 s `engine is not connected`. Stage with `engine: 'scripted'`: works without `folder` (the replay engine creates real sessions); with `folder` it fails (no host path) | engine: yes; managed engine: only with `folder` |
| `ctx.tangu.mountComposer` | Tangu's new-chat composer; `prefill` fills the new-chat draft only if empty (`FE/tanguProbe.ts:467-492`) | the host sends, your `draft()` is read-only | unverified | no |
| `ctx.tangu.startChat` | host app state; opens a visible new chat; `send: true` only for an Agent your plugin seeded, otherwise it prefills (PS:3114-3143) | changes what the user sees in the main area | `folder` dropped (see the gate) | only for `folder` |
| `ctx.ui.mountChatBox` | with `modelPicker: false` it **still subscribes** to the host's default model and the Agent list, then ignores them: the model you get is `options.modelId ?? ''` (`FE/amadeus/plugins/chatBoxSurface.tsx:235-260`). `@page` mentions read the vault's page list | none; `onSubmit` is yours | works wherever there is a DOM | no |
| `ctx.ui.mountRecord` | a **vault `.db` table**; needs capability `databases` and throws unless the path is a table in the **open vault** (PS:2453-2492). `human://CALENDAR.db` also needs `calendar` | edits the row in the user's table | sandbox: the vault is empty, so it throws until you write a `.db` there. Stage: use fixture tables | only for the personal calendar |
| `ctx.ui.mountMarkdown` (read-only) | the chat Markdown renderer. Every `[[name]]` becomes a link that **subscribes to the vault's page list** to resolve it (`FE/components/ChatWikiLink.tsx:40-51`); clicking opens that note | none on data; links into the user's notes | links show unresolved with no vault | no |
| `ctx.ui.mountMarkdownEditor` | default: no vault (no `[[` completion, links inert). `vault: true`: completes and opens links from the current vault (PS:2493-2532) | only `onChange`; you store the text | fine without a vault | no |
| any plugin view (`registerView` mount) | on mount the host calls `ensureAmadeusReady()`, which **reopens the user's last vault** (`FE/pluginViews.tsx:74-78`, `FE/amadeusPlugins.ts:160-171`) | may open the last vault; it restores asynchronously, so `vaultRoot()` can still be `null` right after mount | sandbox: its own empty `vault/`; stage: the copied fixture vault | no |
| `ctx.calendar` / "My calendar" | members and colours: host config keyed by vault (`ensureMember` waits for a vault); the personal calendar is **engine `human/CALENDAR.db`** via `GET/PUT /agent/human/CALENDAR.db`, never a vault file (`FE/amadeus/store/humanCalendarIo.ts:15-60`) | `ensureMember` writes calendar config; writing the personal calendar needs both `calendar` and `databases` | sandbox and stage with `engine: 'none'`: `myCalendar: 'unknown'`. Stage with `engine: 'scripted'`: serves `<fixture>/human/CALENDAR.db` (see [stage.md](stage.md)); absent = empty calendar; edits stay in that stage | the real engine: yes; the stage's replay engine: no gate |
| `ctx.databases` | every vault `.db` and folder note view; plus the personal calendar when `calendar` is declared. Capability `databases` | writes cells / rows like the UI does | sandbox: empty; stage: fixture tables | only for the personal calendar |
| `ctx.noteTasks` | `@` task marks in vault Markdown. Capability `noteTasks` | `update` rewrites that line of the note | vault-dependent | no |
| `ctx.table.mount` | only the spec you pass (read-only rows in memory) | none | works | no |
| `ctx.dashboard` | `mount`: an in-memory page store, never the vault; layout comes back through `onLayout`. `source`: compiles a `.dashboard.md` recipe (that one lives in the vault) | `mount`: none | `mount` works with no vault | no |
| `ctx.ui.mountBoard` | only your `scene` / `viewport` | none | works | no |
| `ctx.loadData` / `saveData` | plugin data: `<forsion home>/plugins-data/<id>.json` in the main process; `syncData: true` plugins also sync through the cloud. Unreadable data **rejects** (`plugin-data-unreadable`), never-saved gives `null` (PS:2390-2429) | writes the file; may sync | sandbox: its own empty home; stage: plugin data is **not** copied in | no |
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

- A view's type is `plugin:<plugin id>:<view id>`, where the plugin id is the install folder name for store installs (`market-<UUID>`) and the manifest `id` otherwise (PS:1600-1601).
- Your bundle's **engine routes** are mounted under the **install folder name, lowercased**, not the manifest id: `ctx.tangu.request` calls `/extensions/<folder lowercased>/<engine plugin id>/<path>` (`FE/amadeus/plugins/engineRequest.ts:32-43`). A folder name with characters outside `a-z 0-9 -` cannot be routed at all (the call throws).

### Wiki links in rendered text

`mountMarkdown` (and `mountMarkdownEditor` with `vault: true`) treat `[[…]]` as links into the user's vault. The host has no special handling for HTML character entities, and a 2026-11-19 review found that a plugin filter that strips literal `[[` was bypassed with entity-encoded brackets. If the text is not the user's own note (model output, imported data, demo content) and must not link into the vault, render it as plain text or code rather than filtering `[[` yourself.

## The sandbox and the demo stage

| | Plugin sandbox (`plugin_sandbox`) | Demo stage (`ctx.stage`, [stage.md](stage.md)) |
|---|---|---|
| Engine | none (points at a dead port); external mode | `engine: 'none'`: none. `engine: 'scripted'`: a local replay engine from `engine.json`; still **external mode**, so every API in the gate table above is refused |
| Vault | its own, starts empty, kept between starts, wiped by `reset` | a copy of `<fixture>/vault/`, wiped on every open |
| Plugin data | its own, starts empty | not copied in |
| Account | signed out | signed out |
| Personal calendar | `myCalendar: 'unknown'` | from `<fixture>/human/CALENDAR.db` with `engine: 'scripted'` |
| Who can use it | the dev copy you are writing | only an **installed** plugin that declares `stage` (dev copies and the sandbox are refused) |

Demo data for the stage:

```
<plugin>/<fixture>/vault/…              → the stage's vault (notes, .db tables)
<plugin>/<fixture>/engine.json          → required for engine: 'scripted' ({ "runs": [] } if you only need the calendar)
<plugin>/<fixture>/human/CALENDAR.db    → "My calendar": a regular database table, ≤ 8 MB
```

Then `ctx.stage.open({ fixture, engine: 'scripted', clock, plugins, includeSelf })`.

## Not verified yet

- Whether `ctx.tangu`, `ctx.desk` and `ctx.tts` are present at all in the sandbox and the stage.
- How entity-encoded `[[…]]` renders in `mountMarkdown` today.
- `ctx.account` at runtime in the sandbox (signed out is derived from its isolated home).
