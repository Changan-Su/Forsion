# External skill providers for engine plugins

[中文](plugin-skill-providers.md) · [Plugin development](plugin-development.en.md)

Register a live, read-only skill source inside `activate(ctx)`. The host integrates it with native skill discovery, loadouts and `use_skill` without copying files into the user's skills directory. Static bundled skills can still live in the bundle's `skills/` folder.

```js
if (typeof ctx.registerSkillProvider === 'function') {
  ctx.registerSkillProvider({
    id: 'external',
    async list({ cwd, signal }) {
      const rows = await source.list({ cwd, signal });
      return rows.filter(row => row.enabled).map(row => ({
        id: row.slug, name: row.name, description: row.description,
        content: row.instructions,
        ...(row.absoluteDir ? { dir: row.absoluteDir } : {}),
      }));
    },
  });
}
```

`source` stands for the plugin's own adapter. Canonical types live in `tangu-agent/plugin-api/tangu-agent.d.ts`. Obtain runtime capabilities from `ctx`; do not import engine values. Feature-detect this additive capability on older hosts; `apiVersion` remains `1`.

## Identity and reads

- Provider and entry IDs must match `[a-z0-9][a-z0-9-]{0,63}`. Duplicate provider IDs within one activation throw; invalid entries are omitted.
- The host assigns `local:plugin/<engineId>/<providerId>/<entryId>`. The engine ID is the host's actual installed identity, including marketplace isolation. Plugins cannot choose another owner's namespace. Matching user filenames, other plugins and other providers remain distinct.
- `name` and `content` must be nonempty; `description` must be a string. `content` is Markdown instructions without YAML frontmatter. Optional `dir` must be absolute and provides resource location context, not file permissions.
- `cwd` is supplied when the current run has a working directory. The host always supplies `signal`, aborted after a 5-second deadline or registration revocation. Sources should honor cancellation to stop background work.
- Every list or item read calls the source afresh, including native `use_skill`. Return only enabled, model-invocable entries. Body changes, disabling and deletion apply on the next read. Item reads query only their owning provider.

## Lifecycle and management

Errors, timeouts and invalid responses omit that source while preserving filesystem skills and other providers. The host never writes a failed read back to the source. Disable, unload, replacement and failed activation revoke registrations and discard pending results. Re-enabling invokes `activate` again; register again inside it.

Sources are read-only. The external system owns per-skill enable, edit and delete actions. The user-directory file catalog neither lists nor mutates provider entries. `/agent/skills` summaries retain `source: 'plugin'`, `origin: null`, `readOnly: true`, `sourcePluginId` and `sourceProviderId`. Preserve those fields in management UI instead of presenting these entries as writable user files. Discovery does not bypass session skill selection or tool approvals.

## Verification

`src/skills/pluginSkills.test.ts` covers identities, errors, deadlines and revoke races. `pluginSkills.native.test.ts` exercises the actual list/get/loadout/use_skill chain, body refresh, deletion and same-name user-file isolation. The `plugin skill sources` suite in `src/plugins/lifecycle.test.ts` covers marketplace ownership, disable/re-enable, uninstall and activation failure. `src/routes/assets.origin.test.ts` checks HTTP summary ownership.
