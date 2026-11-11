# Read-only note renderers

Use `ctx.registerNoteRenderer?.({ id, apiVersion: 1, mount(element, snapshot, host) })` to replace the note's reading surface. This is an actual host consumer, not a generic View registration. The latest active registration wins; the host bundles an official fallback.

- `snapshot` is immutable `{ path, markdown, html, revision }`. Markdown is the current body, without frontmatter. HTML is a host-produced static rendering with editing controls removed.
- `host.signal` cancels the mount. `host.openLink(href, 'wiki' | 'url')` opens links through the host.
- `mount` returns `void`, a disposer, or a promise of either. Resolve only when ready. Keep styles/resources inside the staging container. The host commits only the newest successful mount and disposes superseded surfaces.
- Throw/reject to keep the previous working surface. Package hot reload holds that surface during async setup; explicit disable restores the bundled module.
- Preserve `data-reading-anchor`, semantic headings, selectable text and accessible links. Never mutate the owning editor or write the note from a renderer.
- Reading mode waits for composition and strict save; save failure retains editable input. The editor stays mounted, so undo history and document state survive. The preference is per View, separate from page locking.
- Schema, serializer and file-format changes are outside this API.

Example and complete author guidance: `docs/customization/note-renderers.en.md` (Chinese counterpart: `note-renderers.md`). Type source: `desktop/frontend/src/amadeus/plugins/noteRenderers.ts`.
