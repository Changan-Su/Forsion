# Working-folder identity and one-time upgrades

Use this reference with the skill's “Vault files and the working folder” section. The local desktop host owns filesystem safety; the plugin owns the business schema. Feature-detect these APIs instead of guessing support from an app version.

## Identity and destination

- New external manifest IDs match `^[a-z0-9][a-z0-9-]{0,63}$`. Choose English words for new IDs and preserve published identities such as `bluebird` and `diting`.
- Default output uses `Plugins/<effective-plugin-id>`. A Store install's effective ID is `market-<UUID>`; multiple publishers can declare the same manifest ID. Ask `workFolder()` instead of deriving the effective ID yourself.
- Localized display names may stay Chinese. Historical package-directory aliases are independent of identity; do not mass-rename installed packages.
- A manual working-folder preference always wins, even if Chinese. Automatic migration targets only the new ID default; it must not relocate a custom folder.
- Older or unsupported hosts keep established legacy reads/recovery. Calling an absent migration method with optional chaining and then proceeding as though it migrated is unsafe.

## Request and result

The public shape mirrors the host's `WorkFolderMigration` and `WorkFolderMigrationResult`:

```ts
interface WorkFolderMigration {
  id: string
  expectedRoot: string
  source: string
  target: string
  plan?: {
    index: { path: string; before: string | null; after: string }
    requiredFiles?: string[]
    edits: Array<{ path: string; before: string; after: string }>
  }
}
interface WorkFolderMigrationResult {
  status: 'needed' | 'complete'
  backup?: string
}
```

`source` and `target` are vault-relative folders. A source is a single root-level legacy folder or `Plugins/<previous name>`; a target is the plugin's new ID default. `expectedRoot` captures `ctx.app.vaultRoot()` before asynchronous work. The host namespaces `id` by the effective plugin ID; use a stable ID for each upgrade, not a timestamp or translated name.

Within `plan`, all `path` and `requiredFiles` entries are relative to those folders, not full vault paths. `index.before` is the exact current **destination** index text, or `null` when absent. Each edit's `before` is exact **source** text. Include the index in `edits`, with the same `after` as `index.after`; add edits only for validated plugin-owned records. `requiredFiles` names referenced source assets that must exist and be nonempty. Do not use this API as a general-purpose directory mover.

With no plan, a request queries or reconciles the per-vault journal and returns `needed` or `complete`. A status-only request may target the previous display-name default to finish an interrupted predecessor journal; writing a plan into that old target remains forbidden. Check the predecessor before importing its root source again: the predecessor may have committed its index but not its completion marker. Verify the published files through the host instead of guessing from folder existence. A `needed` result is not permission to discard conflicts or overwrite a populated destination.

## Upgrade sequence

1. Wait for an active vault. Capture its root and the working-folder choice. Detect a manual preference and retain it; the host also rejects automatic migration when a preference is set.
2. When both APIs exist, request `workFolder({ preferId: true })` and reconcile the applicable journal(s). Without them, retain the old host's established folder/recovery flow.
3. Validate legacy index schemas, referenced notes and media, and the destination state. Two populated data sets require comparison/recovery. Corrupt schemas, missing media or changed files must preserve the originals and show a recoverable error, not an empty collection.
4. Build the exact-text plan, rewriting only owned record paths. Await `migrateWorkFolder(request)` and proceed only after completion. The host snapshots and hashes files, rejects traversal/symlinks/overlap, copies exclusively, checks required assets and exact preimages, then publishes the index under shared text locks and a structural guard. File data and supported directory metadata are flushed before publication; Windows flushes existing files using writable handles.
5. Use the migrated index for ordinary work. Keep the source as a backup. Completion belongs to the vault's durable journal; do not infer it from “the destination is empty” or reimport after the user deletes an item. Drop failed in-flight promise caches so a transient failure can be retried. Recheck captured scope across awaits; a vault switch, disabled plugin or changed preference must stop stale work.

Resolve bare media links against the **original vault** before rewriting. Attachments may live beside the note, under `assets/`, or elsewhere in the vault; do not invent an `assets/` path. Preserve unrelated links, frontmatter and code (fenced, inline, multiline and indented). Use the host's Markdown reference handling rather than global string replacement.

## Acceptance cases

Run on isolated vault copies; never mutate personal originals to test an upgrade.

- Fresh vault: English ID default; changing display language/name leaves it stable. Test Store effective IDs and historical install aliases separately.
- Old root folder and old Chinese `Plugins/<name>` folder: index and records work after automatic upgrade; originals remain byte-identical and copied media decodes.
- Custom preference (including Chinese): no automatic relocation. An unsupported host keeps its recovery path and never claims migration succeeded.
- Existing populated destination, corrupt index, missing/empty media or changed preimages: no overwrite; report recovery instead of an empty successful result.
- Interrupted copy and predecessor index-commit/marker interruption: resume safely. Retry a transient failure; switch vaults or disable the plugin during the operation and verify stale work is refused.
- Restart after completion, delete all entries, then restart again: no resurrection. A second vault gets its own upgrade.

The host owns the durable protocol. Plugin tests must also exercise actual schema/path rewriting and media references; a stub returning `complete` proves neither migration nor recovery.
