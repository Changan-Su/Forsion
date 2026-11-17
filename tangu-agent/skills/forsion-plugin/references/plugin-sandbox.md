# Using the plugin sandbox: plugin_sandbox_inspect in detail

SKILL.md, section "Verify a desktop plugin in the plugin sandbox", has the workflow (start → fix → use it → tell the user). This file is the detail for using the sandbox like a person would. Engine contract: `tangu-agent/docs/plugin-sandbox.md` in the Genesis repo.

## Reading the screen

- `read` (optionally `target` to narrow it) gives an outline: one line per visible control with a reference (`[e12] button "Add book" (disabled)`); headings and text blocks are listed without one. References are renumbered on every `read`; after the page changes an old reference is refused with "read again".
- **States follow the name in brackets** (2026-11-15+): `disabled`, `checked`, `selected`, `pressed` / `not pressed` (toggle buttons, `aria-pressed`), `read-only` (a field or editor that will not take typing), `expanded` / `collapsed`, `focused`, `value "…"`.
- A toggle's name says what it controls; its state is `pressed`. The note's reading toggle has a fixed name ("Reading mode" / 「阅读模式」) and is `pressed` while the note is in reading mode. **Check the state before clicking a toggle**: clicking it blindly flips it the wrong way half the time.
- A note in reading mode is `read-only`: typing into it does nothing, and `ctx.app.insertMarkdownAt` returns `{ ok: false, reason: 'read-only' }` there. Switch the toggle off first when the test needs to edit.

## Acting

- `target`: a reference from `read`; `css:<selector>`; or the control's visible text (exact name first, then contains, then any element's text, the smallest match).
- `click` / `type` / `press` are real input events. `type` replaces the field's text unless `append: true`; `press` takes keys such as `Enter`, `Escape`, `ArrowDown`, `Mod+K` (space-separated to press several). Each returns a screenshot after the page settles, plus the plugin's console lines and toasts from meanwhile.
- **Notifications in the way** (2026-11-15+): if a host notification card (including one from `ctx.notify`) covers the target, the host closes the notifications first, waits for them to leave, then acts, and says so ("a notification was covering it"; the notification text comes back as data). If new ones keep appearing for a second, the action is refused rather than landing on a notification's own button (its "Undo", say).
- Before clicking something that opens a file picker, call `files` with `paths` inside the plugin folder; a native picker cannot be seen or clicked.

## Commands that wait (2026-11-15+)

`{"action":"command","command":"<id>","args":{...}}` runs a command the plugin registered. If it is still running after about 1.5 s (typically waiting on a dialog or picker it opened), the result says it **started and is still running** (`pending: true`). Do **not** run it again to "retry": `read` the window (or look at the screenshot) and continue the flow there, e.g. pick the option in the dialog. An error thrown later lands in the plugin's console (`logs`).

When the sandbox can't answer, the result says which: the window is not open, it is still starting, the page did not answer in time (busy or stuck), or the call itself failed (the page may have just reloaded: try again).

## The plugin's settings page (2026-11-15+)

Plugin settings are not in the sandbox's main window: `registerSetting` rows and `registerSettingsView` panels are drawn in Settings → Plugins → this plugin, which is a **separate settings window**.

- `{"action":"settings"}` opens it there and returns that window's outline and a screenshot; `{"action":"settings","close":true}` closes it.
- `read` / `click` / `type` / `press` / `scroll` / `screenshot` take `window: "main" | "settings"` (default `"main"`). `space` is main-window only.
- References are per window: `e12` in the main window, `s12` in the settings window. A `target` of `sN` without `window` goes to the settings window by itself; a reference from the other window is refused (never "the same number over there").
- `window: "settings"` while the settings window is closed → refused: call `settings` first.

## Older desktops

All of the 2026-11-15 additions need a desktop that declares the client capability `plugin.sandbox-v2`. On older desktops the engine sends none of the new arguments, `command` waits for the command to finish (up to about 10 s) instead of returning `pending`, and `settings` is refused with "this Forsion desktop is older than the tool": ask the user to update Forsion or to check the plugin's settings in the sandbox window by hand.
