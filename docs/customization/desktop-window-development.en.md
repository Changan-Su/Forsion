---
title: Desktop window development
description: Transparent, chrome-less windows that float above other apps (desktop pets, widgets): the capability, the controller, click-through and the guardrails.
---
# Desktop window development (2026-11-26+)

A desktop window is a small window that is **transparent, has no frame or title row, and floats above other apps**. Your view draws everything in it: desktop pets, floating widgets and timer pills are all this kind. It goes through the same entry as the [Mini Panel](./mini-panel-development.en.md) and the [Floating Panel](./floating-panel-development.en.md), `ctx.workspace.open`, with the look `form: 'bare'`.

## Declare and open

Declare the capability in the manifest:

```json
{ "capabilities": ["desktopWindow"] }
```

Have the view support the `bare` look, then open it on the desktop layer:

```js
ctx.registerView({ id: 'pet', title: 'Pet', forms: { bare: true }, mount(el, view) { /* draw the pet */ } })

if (ctx.workspace?.forms?.includes('bare')) {
  const r = await ctx.workspace.open('pet', { layer: { float: 'desktop' }, form: 'bare', key: 'cat', size: { width: 160, height: 160 } })
  if (r.ok) { /* r.layer.float is 'desktop' (a desktop window) or 'window' (fell back to a card in the window) */ }
} else if (ctx.workspace?.open) {
  await ctx.workspace.open('pet', { layer: { float: 'desktop' } })   // 2.13.8–2.14.x: a Mini instead
} else ctx.openMiniPanel?.('pet')                                     // older hosts
```

- `size` is the window's initial size (160 × 160 by default). The host remembers where the window was moved and how it was sized per `key`, and reopens it there.
- `pin` defaults to `true` (above other apps); a `pin: false` window stays on the normal window level. On macOS it never covers full-screen apps.
- **Opening the same view with the same `key` again does not open a second window**; the new params go to the view (`view.onParamsChanged`). Use a stable identifier as `key`, not a timestamp.
- **At most 3 windows per plugin at a time**: the 4th returns `{ ok: false, reason: 'limit', limit: 3 }`. The host does not tell the person for you.
- `close()` on the result closes the window. The host also closes it when the person closes it from the tray, when the plugin is disabled or reloaded, when the view is unregistered, and when the main window reloads; each close runs the cleanup returned by `mount`. Windows do not come back after the main window reloads on their own: reopen them in your plugin's `setup` if they should stay.

### The person agrees on first use

The first time a plugin opens a desktop window, the host asks the person once whether to allow it, and remembers the answer. The person can take it back in Settings → Plugins → that plugin. That closes the plugin's open windows, and the host asks again next time.

When the plugin does not declare `desktopWindow`, the person said no, or the host cannot open system windows (web, phones), **nothing throws: the view falls back to a card floating in the main window, also without a title row** (`r.layer.float === 'window'`, `view.surface` is `'floating'`). Draw the view so that it works in both.

## What the view gets

In `mount(el, view)`:

| Member | Meaning |
| --- | --- |
| `view.surface` | `'desktop'` in a desktop window; `'floating'` in the fallback card. Older hosts never report `'desktop'` |
| `view.desktop` | Only in a desktop window: the controller below |
| `view.getParams()` / `onParamsChanged(fn)` | As in other looks |
| `view.close()` | Closes this window |

`view.desktop` (screen coordinates, logical pixels):

| Method | Meaning |
| --- | --- |
| `bounds()` | Where the window is now and how big it is |
| `workArea()` | The work area of the screen the window is on (without the Dock, taskbar, menu bar). A pet "stands" at `workArea().y + workArea().height` |
| `screens()` | Every screen, each with `bounds` (the whole screen) and `workArea` |
| `moveTo(x, y)` / `moveBy(dx, dy)` / `resize(w, h)` | Move and resize. Anything outside the guardrails is clamped; read the result with `bounds()` |
| `drag(event)` | Call it from `pointerdown`: the window follows the pointer until it is released |
| `setClickThrough(mode)` | `'shape'` (default): clicks on empty parts fall through to the app underneath, the pointer over an element you drew is caught; `'none'`: the whole window catches; `'all'`: nothing is caught (look, don't touch) |
| `clickThrough` | Whether this platform can click through. `false` on Linux: the whole window always catches clicks, so keep it tight |
| `setHitTest(fn)` | For drawings on a canvas: `fn(x, y)` returns whether that point (window CSS pixels) is on your drawing. `null` goes back to elements |
| `requestFrame(cb)` / `cancelFrame(h)` | This window's own animation frames. **Don't use the global `requestAnimationFrame`**: it belongs to the main window and slows down when that is hidden |
| `onBounds(fn)` | The window moved or resized (your calls, dragging, a screen change). Returns unsubscribe |
| `close()` | Closes it |

Every controller call after the window closed throws; stop your frames and subscriptions in the cleanup.

## Guardrails (the host keeps them)

- The window is at most half of its screen's work area in width and height, and at least 16 px.
- At least 32 px stay on some screen: a pet can peek in from the edge but is never lost off screen, and it can stand on the Dock / taskbar.
- When screens change or a second screen is unplugged, the host pulls the window back on screen.
- The tray menu "Desktop windows" lists every open window: close one, or "Hide all for now" and "Show all" to bring them back.
- On macOS, after a click in the window the front app goes back to the one that was in front, so Forsion's main window does not jump forward.

## Things to watch

The window shares the main window's renderer process but is **another document**:

- Find its `document` / `window` through `el.ownerDocument` and `el.ownerDocument.defaultView`; the global `document` and `window` are the main window's. Attach listeners to `el` or `el.ownerDocument`.
- Don't use checks like `instanceof HTMLElement`: elements of another document are not the main window's `HTMLElement`.
- Theme CSS variables (`--accent-ink` and so on) and light / dark follow along, so style with the semantic variables as usual; the page background is transparent, anything you don't draw is see-through.
- Host components such as `ctx.ui.mount*` are for views in the window; don't mount them into a desktop window.
- `ctx.ui.float({ scope: 'desktop' })` still does not exist: component floats have no desktop scope. Use the entry above to reach the desktop.

## Debugging

`npm run check:desktopwindow` (in `Forsion-Genesis/desktop`) is a real Electron harness: opening, transparency, theme, clamped moves, click-through, same-key reuse, the limit, fallbacks, animation frames while the main window is hidden, and closing on disable and reload. The probe plugin in `scripts/desktop-window.check.cjs` is a starting point for your own.
