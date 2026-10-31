### Live external skills (engine API, 2026-10-31)

Use `ctx.registerSkillProvider` to expose skills managed by an external system without copying them into the user's skills directory. Feature-detect it on older hosts. Do not import the engine at runtime.

```js
if (typeof ctx.registerSkillProvider === 'function') {
  ctx.registerSkillProvider({
    id: 'external',
    async list({ cwd, signal }) {
      const entries = await externalSource.list({ cwd, signal });
      return entries.filter(s => s.enabled).map(s => ({
        id: s.slug, name: s.name, description: s.description,
        content: s.body, ...(s.absoluteDir ? { dir: s.absoluteDir } : {}),
      }));
    },
  });
}
```

Provider and entry IDs must match `[a-z0-9][a-z0-9-]{0,63}`. The host assigns `local:plugin/<engineId>/<providerId>/<entryId>`; never construct user-owned `local:<slug>` IDs. The engine ID is the host's canonical installed identity, including marketplace ownership. Duplicate provider IDs in one activation are rejected. `content` is Markdown instructions without YAML frontmatter; optional `dir` must be absolute and grants no file permissions.

Each list/read calls the source again, including native `use_skill`. Return only enabled, model-invocable skills. Each call has a 5-second deadline and receives an abort signal; errors/timeouts omit that source while preserving other skills. Disable/unload/failed activation revokes providers and discards pending results. Re-enabling calls `activate` again, so register again there.

These are read-only source entries: manage per-skill enable/delete in the external system. The user-directory file catalog does not list or mutate them. `/agent/skills` exposes `source: 'plugin'`, `origin: null`, `readOnly: true`, `sourcePluginId` and `sourceProviderId`; keep this ownership in any management UI. Discovery does not bypass the agent's selected-skill allowance or tool approvals.
