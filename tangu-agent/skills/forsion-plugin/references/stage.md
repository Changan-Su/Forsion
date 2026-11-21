# Demo stage: `ctx.stage` (2026-11-20+, experimental, desktop only)

A plugin that declares `"capabilities": ["stage"]` can start a **demo stage**: a separate, isolated copy of Forsion that holds only the demo content shipped in the plugin package plus the installed plugins it names. Not signed in; never reads the user's vault or plugin data (`plugins-data/` is not copied). Use it for store screenshots, release-note images and short demo videos. Host side: `desktop/electron/pluginStage.ts`; options and error codes: `desktop/shared/pluginStage.ts`.

```js
const stage = await ctx.stage?.open({
  fixture: 'fixtures/demo',        // folder inside the plugin package; vault/ → stage vault, engine.json → chat replay, human/CALENDAR.db → My calendar
  plugins: ['calendar'],           // installed plugin ids (market installs: their market-<uuid> id); built-ins must be named too
  includeSelf: false,              // default: the calling plugin is the director, not on stage
  theme: 'light',                  // or { mode, lang?, skin?, bg? }; glass is always off on stage
  locale: 'en',                    // default: the user's UI language
  window: [1440, 900, 2],          // CSS width/height + density; 640–3840 × 480–2400, density 1–3; may exceed the screen
  clock: '2026-11-20T10:00',       // "now" starts here (local time), then runs normally
  engine: 'scripted',              // 'none' (default, chat pages show disconnected) | 'scripted' (needs engine.json)
})
await stage.space('calendar')                 // Space id or visible name
await stage.command('calendar:new-event')     // command id
await stage.click('Friday')                   // target: e12 from read(), css:<selector>, or visible text
await stage.type('Launch', { target: 'css:input' })   // replaces by default; { append: true } appends; text appears at once
await stage.press('Enter')                    // Enter, Escape, Tab, ArrowDown, Meta+K, Mod+Enter…
await stage.scroll(undefined, 600)
const { outline } = await stage.read()        // visible controls with references
const png = await stage.capture({ selector: 'main' })   // or { rect: {x,y,width,height} } in CSS px; full window if omitted
const rec = await stage.record({ fps: 30, cursor: true, maxMs: 20000, format: 'mp4' })
const video = await rec.stop()                // { bytes, mime, width, height, durationMs }
await stage.close()
```

Rules that matter when writing a director:
- First `open` per plugin shows a permission dialog; declined → `denied`. Remembered afterwards.
- One stage per machine. Another plugin's stage open → `busy`. Re-`open` from the same plugin restarts it. Disabled / reloaded plugin → host closes it. Idle 5 minutes → stops; later calls → `closed`.
- Each `open` starts from a clean folder (`<forsionHome>/stages/<plugin id>/`), so steps must set up everything they need.
- Only installed plugins can open a stage (not dev copies in the plugin sandbox). `fixture` must be a relative path inside the package; symlinks are skipped; max 5000 files / 200 MB.
- Recording captures the stage window only (tab capture: no screen-recording permission, works while the window is behind others), max 3840 px wide and 120 s. `cursor: true` draws a pointer that glides to each click. Typing is instant, so recordings follow the "10–20 s loop, no typing or waiting" rule for What's New clips.
- `engine.json`: `{ "models": [...], "sessions": [...], "messages": [...], "runs": [{ "match"?: "substring of the user's message", "events": [{ "type", "payload", "delay"? }] }] }`. Each message sent in the stage replays the first unused matching run; events use the engine's SSE event types (`token` with `{ delta }` for streamed text, `reasoning`, `tool_call` / `tool_result`, `session_title`; `{ "type": "__hold" }` waits for an approval or answer); `done` is appended automatically. Finished turns are stored, so the chat survives a reload.
- `human/CALENDAR.db` (optional, needs `engine: 'scripted'`): the personal calendar (「我的日历」) is not a vault file; the calendar asks the engine for `human/CALENDAR.db`, and the replay engine serves this file in its place. Same format as the real one in the engine home: a classic database file `{ "version": 2, "name", "columns": [{ "id": "name", "name": "Name", "type": "text" }, { "id": "date", "name": "Date", "type": "calendarDate" }, { "id": "done", "name": "Done", "type": "checkbox" }], "rows": [{ "id", "cells": { "name": "Launch review", "date": "2026-11-20T14:00/2026-11-20T15:00" } }] }` (up to 8 MB, no `source`; every column needs `id` / `name` / `type`, every row `id` / `cells`; in a table with a checkbox column each row is drawn as a to-do with a tick box). Edits made on the stage stay in memory for that stage only. Without the file the stage shows an empty personal calendar; with `engine: 'none'` there is no engine, so the personal calendar cannot be loaded. A link, a non-file or a bad shape → `fixture-invalid`.
- Errors reject with `code`: `unsupported` · `invalid` · `denied` · `busy` · `fixture-invalid` · `plugin-missing` · `timeout` · `closed` · `error`.
- Store: packages declaring `stage` install from the official store only after review (same per-version gate as `internals-raw`; error `install: stage-unapproved`).
- Never call `window.tangu.pluginSandbox.*` or `window.tangu.pluginStage.*` directly; they are internal host channels.
