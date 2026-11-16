# Internal APIs: ctx.internals (2026-11-16+)

Unstable on purpose. Everything below follows Forsion's internals and may be renamed, reshaped or removed in any version
without notice. Use it only when the public `ctx` lacks what the plugin needs, and say so in the plugin's README.
Desktop only: on web, mobile, the device page and older hosts `ctx.internals` is `undefined` → always `if (!ctx.internals) return`.
A plugin that cannot work without it should also set `"isDesktopOnly": true`.

## Declaring

```json
{ "capabilities": ["internals"], "internalsVerified": ["2.14"] }
{ "capabilities": ["internals", "internals-raw"] }
```

- `internals` = level one (read-only copies). `internals-raw` = level two (real module objects); it only takes effect
  together with `internals` (declared alone, the host injects nothing).
- `internalsVerified`: Forsion minor versions the author checked. Label only: Settings → Plugins says "not checked on this
  version" when the running version is missing. It never blocks.

## Level one: read and subscribe

```js
const k = ctx.internals
k.stores()                                   // 'app' | 'commands' | 'page' | 'spaces' | 'ui' | 'workspace' (what is registered)
k.read('page')                               // frozen copy of the whole state
k.read('page', (s) => s.activePage)          // selector gets the copy, not the host object
const off = k.subscribe('workspace', (s) => s.activeMainPanel, (now, prev) => { … })
k.host.version()                             // Promise<string | null>, the installed app
k.host.ui()                                  // { source: 'bundled' | 'overlay', version } | null — the Tangu UI bundle running
k.host.window / k.host.mainWindow            // 'main' | 'detached' | 'mini' | 'floating' | 'pip'
```

- Copies: functions, accessors and class instances are dropped; `Date` → milliseconds, `Map` → `[key, value][]`, `Set` → array;
  deeper than 64 levels dropped. Unchanged subtrees reuse the previous copy, so repeated reads are cheap.
- `page` is the active panel's store (it follows panel switches). Field names are the host's own; read the Genesis source.
- `subscribe`: several host changes in one turn are computed once; the listener runs only when the selected data differs
  (deep comparison). Returns an unsubscribe; the host unsubscribes when the plugin is turned off.
- No writes at level one. Use the public APIs: `ctx.app.renamePath` / `movePath` / `createFolder` / `writeFile`
  (references/vault-files-and-templates.md), which ask the user before touching files the plugin didn't create.
- Every window runs its own plugin instance. Do plugin-initiated vault writes only when `k.host.mainWindow`.

## Level two: raw modules

```js
const ids = await ctx.internals.raw.modules()                 // keys of the host's shared module table
const pages = await ctx.internals.raw.import('host:desktop/frontend/src/amadeus/store/pageStore.ts')
const { useWorkspace } = await ctx.internals.raw.import('host:lcl/engine/index.ts')   // check modules() for exact keys
```

- Only modules in the shared module table (`desktop/frontend/src/coreTangu/sharedModules.generated.ts`, the table the
  hot-updatable Tangu UI bundle uses): page / chat state, the LCL engine, React, zustand and more. Anything else, including
  variables private to a function, is out of reach. Exports are live bindings.
- The host can't take these objects back. After turning such a plugin off the user is asked to save and reload the window.
  If the plugin replaces one of the host's own actions, it must restore it in its disposer.
- For note files, keep using the public write APIs: the host's writes check conflicts, rewrite links and record deletions for
  sync. Calling `setState` or old rename paths directly can corrupt notes (see the warning in `amadeus/lib/noteRename.ts`).

## Failures

For a plugin declaring `internals`, the host tags the installed code with a sourceURL and counts errors it doesn't catch
(and errors thrown from `subscribe` selectors / listeners) against the running version. Three within 60 seconds → the host
turns the plugin off and notifies the user, who can turn it back on. Errors the plugin catches itself are not counted.

## Store

Level one is reviewed as usual. Level two needs an application: the submission's internal APIs reason field must say which
modules and why the public APIs are not enough, and review is per version. The desktop app refuses to install an
`internals-raw` version from the official store unless that exact version was approved. Dev loads, manual installs and
third-party store sources are not gated.

`node tools/check-plugin.mjs <plugin folder>` flags: use without declaring, `internals-raw` without `internals`, reaching
into React internals (`__reactFiber$…`); and lists the raw module ids the source asks for.
