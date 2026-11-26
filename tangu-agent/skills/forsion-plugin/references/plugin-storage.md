# Plugin data folder: `ctx.storage` (2026-11-26+)

Type contract: `PluginStorage` / `PluginStorageEntry` / `PluginStorageImportOptions` and the `storage` member of `PluginContext` in `desktop/frontend/src/amadeus/plugins/types.ts`; shared constants in `desktop/shared/amadeus/pluginStorage.ts`.

Until now a plugin had one private JSON blob (`ctx.loadData` / `saveData`), so images, drafts, caches, indexes, snapshots, renders and bundled scripts ended up in the user's vault under `Plugins/<plugin ID>/`. That bloats the vault and syncs junk with the notes. `ctx.storage` is a folder of the plugin's own, **outside the vault**, for text or binary files of any size.

## What goes where

- **Vault, through `ctx.app.workFolder()`**: notes for the user (things they open from the file tree), files those notes embed, and finished exports the user asked to save there.
- **`ctx.storage`**: everything that belongs to the plugin itself: settings and state beyond the JSON blob, indexes, caches, drafts, trial versions, intermediate output, logs, job records, undo copies, version snapshots, window captures, renders, bundled scripts and tools.
- **Self-check**: "After uninstalling this plugin, would the user still want this in their vault?" Yes → vault. No → `ctx.storage`.
- **One exception**: a small index (a few KB) that only makes sense next to the notes, such as "which note was clipped from which URL", may stay a dot-file in the work folder. Anything large or ever-growing (snapshots, undo copies, one sidecar per image, renders, window captures, tool scripts) goes into `ctx.storage`.

| Example | Where |
|---|---|
| Clipped articles, meeting minutes, transcripts, quick notes, literature notes, weekly reports, card decks, whiteboards, mind maps, video project files | vault |
| Images / audio / video embedded in those notes; a PDF or mp4 the user chose to export | vault (beside the note, or where the user chose) |
| Draft decks, the output image of every render, window captures | `ctx.storage`; give the user a "save to vault" action for the one they want to keep |
| Indexes, caches, job records, undo copies, version snapshots, raw failed model output | `ctx.storage` (per-library ones in `ctx.storage.vault()`) |
| Scripts, tools, music or a README the plugin keeps for itself | `ctx.storage`, or ship them in the plugin package |
| Recordings, imported 3D models, dropped-in reference originals | either: vault when a note links or embeds it, `ctx.storage` when only the plugin uses it |
| A few-KB index that maps notes to their sources | may stay a dot-file in the work folder |

The host does not block vault writes. A **dev copy** gets one console warning (once per load) when it writes a dot-file path, or a non-note file (not `.md` / `.db`) over 5 MB, into the vault. Installed plugins get no warning.

`workFolder()` keeps its default (`Plugins/<plugin ID>`, a manual preference still wins); only its meaning is narrowed to "where the plugin saves notes". The folder still appears on the first write, so a plugin that saves no notes never creates it.

## API

All paths are relative to the layer and `/`-separated. `..`, absolute paths (a leading `/`) and drive letters reject with a `TypeError`. After the plugin is turned off, the read and write methods reject with `Error('plugin-disposed')` and `url()` / `vault()` return `null`.

| Method | Behaviour |
|---|---|
| `readText(path)` / `readBytes(path)` | UTF-8 text / `Uint8Array`; `null` when the file does not exist |
| `write(path, data)` | atomic (temp file + rename), creates parent folders, replaces an existing file; strings stored as UTF-8. All of a plugin's write-type calls (`write` / `append` / `remove` / `move` / `importFromVault`) share one queue in call order, so a long import holds back later writes |
| `append(path, data)` | creates the file when missing; for streaming large output (recordings) in chunks. Not atomic: a crash can leave a partial tail |
| `list(folder?)` | direct children (`''` or omitted = layer root), sorted by name, `{ name, path, kind, size, mtime }`; folders report size 0; missing folder → `[]` |
| `stat(path)` | `{ kind, size, mtime }` or `null` |
| `remove(path)` | deletes a file or whole folder **permanently** (no trash); missing → resolves |
| `move(from, to)` | inside the same layer; rejects when the target exists |
| `usage()` | `{ bytes, cacheBytes }` for the whole data folder (both layers) and its `cache/` folders |
| `url(path)` | synchronous address for `<img src>` / `<video src>` / `fetch`, streamed with byte ranges (videos can seek). `null` where the host cannot serve files: read the bytes and use a Blob URL. Throws on an invalid path; does not check that the file exists |
| `vault()` | the layer for the open library, or `null` with none open |
| `importFromVault(opts)` | copy old data from the vault, once per library (below) |

**Missing is not failure**: a missing file gives `null` / `[]`; any other read failure **rejects**. Never treat a failed read as "empty" and write defaults over it.

```js
const store = ctx.storage
if (store) {
  await store.write('exports/c1.png', pngBytes)
  const src = store.url('exports/c1.png')
    ?? URL.createObjectURL(new Blob([await store.readBytes('exports/c1.png')], { type: 'image/png' }))
  img.src = src
}
```

## Two layers

- `ctx.storage` follows the app: it survives switching vaults and needs no vault at all.
- `ctx.storage.vault()` is a separate folder per library (`vaults/<library key>/` inside the same data folder), for indexes and caches derived from one vault's notes. `null` with no library open, and also while the library is still being restored at startup: call `vault()` when you need it, don't keep the startup one. Same methods; on a vault layer `vault()` returns itself.
- The key comes from the library folder's path: a library moved outside Forsion gets a fresh, empty layer; the old one stays and still counts in `usage()`.
- Operations on a vault layer reject once the user switches libraries: call `ctx.storage.vault()` again instead of caching the layer across a switch.
- `cache/` in either layer is yours to regenerate: the desktop plugin page's **Clear cache** button empties it. Keep nothing there you cannot rebuild.
- Reserved names, matched in any letter case: the top-level `vaults/` on the app layer, the top-level `.forsion-imports/` (import records) on a vault layer.

## Where it lives

| Host | `ctx.storage` |
|---|---|
| Desktop | `~/.forsion/tangu/plugin-data/<plugin ID>/` (dev: `~/.forsion-dev/…`). Store installs use `market-<uuid>` as the plugin ID. It is the same folder an engine plugin with the same ID gets as `paths.dataDir` |
| Mobile app | the app's private data folder (`Data/plugin-data/<plugin ID>/`). `url()` is `null` until the app resolves its file address at startup. `importFromVault` rejects on a cloud vault (writes nothing), works on a local vault. Uninstall keeps the folder, like the `loadData` blob |
| Web, shared pages, older hosts | absent: write `ctx.storage?.…` |

⚠️ Do not confuse it with `~/.forsion/plugins-data/<id>.json` (with an **s**): that is the `ctx.loadData` / `saveData` blob. Never hard-code either path; use the API, or `paths.dataDir` / `paths.bundleDataDir` in the engine half.

Not synced with the account (`syncData` covers only the `loadData` blob), not in the vault, no library needed. On desktop uninstall the data folder goes to Forsion's trash together with the plugin's settings, unless the user ticks "Keep settings and data for a reinstall".

**Older hosts and the web**: when `ctx.storage` is missing, fall back to what the plugin did before (the `loadData` blob for small state, the work folder for files), or turn the feature off with a short explanation. Do not move large data into `localStorage`.

## Old data already in the vault

The host never moves or deletes plugin files in the vault. A plugin copies what it recognises with `importFromVault`, and the originals stay for the user to delete (the plugin page's **Data** section shows how many files the work folder still holds).

```js
const v = ctx.storage?.vault()           // needs an open library
if (v) {
  const r = await v.importFromVault({
    id: 'index-v1',                       // [a-z0-9][a-z0-9._-]{0,63}; done once per library
    from: `${ctx.app.workFolder()}/.my-index.json`,
    to: 'index.json',                     // file path when `from` is a file, folder otherwise; default: layer root
  })
  // r.status: 'complete' | 'already-done' → read from v from now on
  //           'missing' → nothing there; nothing recorded, so call again later (sync may still deliver it)
  // r.skipped: targets that already existed with different content, left alone
}
```

- `from` is vault-relative and must be inside your working folder, `Plugins/<plugin ID>` or `Plugins/<display name>` (the pre-2026-10-21 default); anything else rejects.
- Copy, never move: each file is verified against its source. A second call with the same `id` returns `already-done`. A completion record that cannot be read or recognised rejects: do not treat that as "not imported yet".
- Call it on the app layer (`ctx.storage.importFromVault`) for data that should follow the app, on `vault()` for per-library data. Both need an open library.
- Do not delete the vault originals yourself after copying; tell the user they can.
- This is separate from `ctx.app.migrateWorkFolder` ([references/work-folder-migration.md](references/work-folder-migration.md)), which moves **notes** from an old vault folder into the new ID work folder.

## Engine half

- `ctx.paths.dataDir` = `<TANGU_HOME>/plugin-data/<engine plugin ID>/` (unchanged).
- `ctx.paths.bundleDataDir` (2026-11-26+, only for an engine plugin shipped inside a Forsion plugin bundle) = the bundle's plugin data folder `<TANGU_HOME>/plugin-data/<bundle plugin ID>/`: the folder the desktop half sees as `ctx.storage` (bundle plugin ID = the `market-<uuid>` folder for Store installs, the bundle manifest ID otherwise). Equal to `dataDir` when the IDs match. Older engines lack it: `ctx.paths.bundleDataDir ?? ctx.paths.dataDir`.
- The two halves share one folder only when the engine runs on the same computer as the desktop (the local managed engine). An engine on another computer has its own home, so there the folders are separate.
- The engine half follows the same layout: leave the top-level `vaults/` folder to the host, and expect `cache/` to be emptied.
