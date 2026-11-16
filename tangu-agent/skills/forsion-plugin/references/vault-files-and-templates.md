# Vault file operations, templates and new notes

Read this before creating folders, reading file times, renaming or moving files, or building anything template-like (Templater-style variables, folder templates, "new note from template"). Inserting text at the caret is in [note-editor-surfaces.md](note-editor-surfaces.md) (`insertMarkdownAt`).

## File and folder operations (2026-11-16+)

`ctx.app.createFolder` / `stat` / `renamePath` / `movePath` are optional (older hosts lack them: call with `?.`), need an open vault (see SKILL.md 「没有活动库」), and take vault-relative paths with `/` (leading and trailing slashes are dropped; `..` and drive letters reject).

| Method | What it does | Result |
|---|---|---|
| `createFolder(path)` | Creates the folder and any missing parents. A folder that already exists resolves. | `Promise<void>`. Rejects: no vault (`'No vault is open'`), a path escaping the vault, a segment starting with `.` or with surrounding spaces, a file in the way. Older hosts: `writeFile` creates parent folders. |
| `stat(path)` | Kind, size and times. `''` = the vault root. | `{ kind: 'file' \| 'folder', size, mtime, ctime }`: `size` in bytes (0 for folders), `mtime` / `ctime` in ms since epoch, `ctime` (created) `null` where the file system doesn't record it. Missing path or no vault → `null` (same shape as `readFile`); escapes and real IO errors reject. **Desktop and mobile only**: web hosts list files without times, so the method is absent there. |
| `renamePath(path, newName)` | Renames in place, exactly like the file tree: `[[links]]` to it are rewritten across the vault, open editors follow, a note's `*.fd` subnotes go with it. | The new vault-relative path (an unchanged name → the same path). `newName` has no folder. A missing `.md` / `.db` / compound suffix (`.canvas.md`, `.excalidraw.md`) is added back; the file kind can't change. |
| `movePath(path, destFolder)` | Moves a file or folder into an **existing** folder (`''` = vault root), exactly like dragging it in the file tree. | The new vault-relative path. |

### Who gets asked

- **No dialog** when the source is inside your plugin's `workFolder()` (not the work folder itself), or is a path **your plugin created in this app session**: `writeFile` / `writeBytes` / `writeFileScoped(…, { create: true })` to a path that did not exist before, or a folder `createFolder` actually created. Creating the work folder never records the work folder or its parents (`Plugins/`). A created folder, or a created note with `*.fd` subnotes, counts as yours only while every file inside is also yours.
- **Anything else asks the user first**: a host dialog "<plugin> wants to rename / move …" with Allow / Cancel (Cancel focused, one dialog at a time per plugin; native sheet on mobile). Cancel rejects with `Error('user_declined')`: treat it as a normal answer, not a failure.
- Call these from a user action. Never loop over the user's vault renaming things: every file outside your own gets its own dialog.

### Rejections (rename and move)

No vault; missing source; target already exists; invalid name (slashes, leading `.`, surrounding spaces); **renaming** kinds the file tree can't rename (images, PDFs, …; moving them is fine); **moving** `.db` files, and renaming or moving folders that contain one or notes whose `*.fd` holds one (relation columns in other tables would lose them); a `*.fd` subnote folder on its own; renaming a folder to `*.fd`; moving a folder into itself or into a `*.fd` (a note may move into one: it becomes a subnote); `movePath` to a destination folder that does not exist; plugin disabled.

- Relative Markdown links to a moved attachment are not rewritten (wikilinks resolve by name and keep working), same as the tree.
- If the file was moved but the host could not finish (links, `.fd` subnotes), the call rejects with a message naming the new path. `stat` both paths before retrying.
- All structural operations run through one host-wide queue, one at a time.

```js
const archive = `${ctx.app.workFolder()}/Archive`
await ctx.app.createFolder?.(archive)
const st = await ctx.app.stat?.(notePath)          // null = missing (or no vault); st.mtime / st.ctime in ms
try {
  const moved = await ctx.app.movePath?.(notePath, archive)   // → 'Plugins/my-plugin/Archive/Idea.md'
  const renamed = await ctx.app.renamePath?.(moved, 'Idea (done)')   // `.md` is added back
} catch (e) {
  if (e?.message === 'user_declined') return       // the user said no
  ctx.notify?.(String(e?.message ?? e), { level: 'error' })
}
```

## Templates: extend the host's instead of shipping your own

The host already has templates. Do not build a second template picker; plug into this one.

- Templates are the notes in the vault's `templates/` folder. The host picker inserts one at the cursor of the open note and substitutes `{{date}}`, `{{date:fmt}}`, `{{time}}` and `{{title}}` (formats from `.obsidian/templates.json` when present).
- The daily note takes its folder, name format and template from Settings or `.obsidian/daily-notes.json`; default `YYYY-MM-DD.md` with `templates/daily.md`.

### ctx.registerTemplateProcessor (2026-11-16+)

```js
const off = ctx.registerTemplateProcessor?.({
  id: 'tp',
  name: () => 'Templater',                        // shown to the user (errors name it)
  folders: () => ['Templates', 'Plugins/my-plugin/templates'],  // extra picker folders, next to templates/
  async process(source, { templatePath, targetPath, kind }) {
    // kind: 'insert' (picker → cursor of targetPath) | 'daily' (new daily note) | 'new-note' (reserved, not emitted yet)
    if (!source.includes('<%')) return null       // null = leave unchanged
    return render(source, { file: targetPath })   // may prompt the user; no time limit
  },
})
```

- `process` gets the template file's **raw text** (frontmatter included) **before** the host's own `{{…}}` substitution. Processors run in registration order, each on the previous one's output. Throwing aborts that insert with a host toast naming your plugin; nothing is written.
- After a slow `process`, the host re-checks the vault, the pane, the target note and the block before inserting; if the user moved on, the insert is dropped.
- `folders()` is asked each time the picker opens: vault-relative folders, duplicates merged, absolute paths and `..` ignored; a call that throws or takes longer than 2 s adds nothing.
- Returns a disposer; the host also removes it on disable / reload. Same `id` again replaces the earlier processor.
- To put the caret somewhere inside inserted text (Templater's cursor), insert yourself with `ctx.app.insertMarkdownAt?.(token, md, { where: 'caret', cursorMarker })` from a command; the picker path does not place the caret.

### ctx.registerNoteBirth (2026-11-16+)

Folder templates, "every new note starts with this frontmatter", and similar: give a brand-new empty note its content **before** the host writes it, so the editor opens on it.

```js
const off = ctx.registerNoteBirth?.({
  id: 'folder-templates',
  async initial({ path, folder, signal }) {
    const tpl = rules.find((r) => folder === r.folder || folder.startsWith(r.folder + '/'))
    if (!tpl) return null                          // null = pass; the next provider is asked
    return renderWithPrompt(tpl, { path, signal }) // close your prompt when signal aborts
  },
})
```

- **Asked for**: "New note" from every entry point (sidebar, command, ⌘N, new-tab page, and `ctx.app.createPage()`, so your own provider is asked for it too), "New note" in a folder, child notes, creating a note from the quick switcher, confirming an unresolved `[[link]]`, and today's daily note when no daily-note template is set. **Not asked for**: rows added to a notes database, files plugins write themselves (`writeFile`, `writeBytes`, file creators; yours included), files arriving via sync.
- Providers are asked one at a time in registration order; the **first non-null** answer becomes the note's content in the same write that creates it. A provider that throws is skipped (toast naming the plugin) and the next one is asked.
- You may prompt the user. After about 400 ms the host shows "<plugin> is preparing this note…" with Cancel. Cancel, or no answer within 10 minutes, creates the note empty as before. `signal` aborts when the host stops waiting for you (Cancel, time-out, or the note was created): close your prompt then; a late answer is ignored.
- The note is never lost or blocked: births of the same path queue; a vault switch while waiting creates nothing; while one ask is pending, other new notes (including one your `initial` creates) are born empty.
- Returns a disposer; removed on disable / reload; same `id` replaces.

### Older hosts

Feature-detect both (`if (ctx.registerNoteBirth)`). The old workaround, `ctx.app.onVaultEvent` `create` + `writeFile` into the new note, is **measured broken**: the editor has already read the empty file, never sees your write, and its first save keeps only what the user typed and moves your template into a `(conflict …)` copy. On hosts without the hook, prefer a command ("New note from template") that creates the note with its content (`writeFile` to a new path, then `ctx.app.openNote`), over filling notes after they open.
