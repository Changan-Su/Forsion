# Desktop windows: `form: 'bare'` on the desktop layer (2026-11-26+, desktop only)

For desktop pets, floating widgets, timer pills: a window that is **transparent, has no frame or card head, floats above other apps**, and is drawn entirely by your view. Full manual: `docs/customization/desktop-window-development.md` (Genesis repo).

```json
{ "capabilities": ["desktopWindow"] }
```

```js
ctx.registerView({ id: 'pet', title: 'Pet', forms: { bare: true }, mount(el, view) {
  const doc = el.ownerDocument, win = doc.defaultView          // NOT the global document / window
  const pet = doc.createElement('div'); el.append(pet)
  const d = view.desktop                                       // only when view.surface === 'desktop'
  let h = 0
  if (d) {
    pet.addEventListener('pointerdown', (e) => d.drag(e))      // window follows the pointer
    const step = () => { /* d.moveBy(1, 0) … */ h = d.requestFrame(step) }  // the window's own frames
    h = d.requestFrame(step)
  }
  return () => { if (d && h) d.cancelFrame(h) }
} })

if (ctx.workspace?.forms?.includes('bare')) {
  const r = await ctx.workspace.open('pet', { layer: { float: 'desktop' }, form: 'bare', key: 'cat', size: { width: 160, height: 160 } })
  // r.ok && r.layer.float === 'desktop' → desktop window; 'window' → fell back to a bare card in the main window
} else if (ctx.workspace?.open) await ctx.workspace.open('pet', { layer: { float: 'desktop' } })  // 2.13.8–2.14.x: Mini
else ctx.openMiniPanel?.('pet')
```

## Rules

- **Capability + consent**: without `desktopWindow` in the manifest, or after the person said no to the one-time prompt, or on web / phones, the call does **not** fail: it opens a bare card (no head) floating in the main window, `view.surface === 'floating'`, no `view.desktop`. Draw so both work. The person can revoke in Settings → Plugins → the plugin (closes its windows, asks again next time).
- **Identity**: view + `key`. Same key again = no new window, new params reach `view.onParamsChanged`. Position / size are remembered per plugin + key.
- **Limit**: 3 desktop windows per plugin → 4th is `{ ok: false, reason: 'limit', limit: 3 }`; the host does not tell the person.
- **Guardrails (host-enforced, calls are clamped)**: at most half the screen's work area each way, at least 16 px; at least 32 px stay on a screen (peeking from the edge, standing on the Dock is fine); pulled back on screen changes. `pin` defaults to true; never above macOS full-screen apps.
- **Closing**: `r.close()` / `view.close()` / `view.desktop.close()`; also on tray close, plugin disable / reload, view unregister, main-window reload (windows do **not** come back by themselves: reopen in `setup` if they should persist). Cleanup from `mount` runs every time; controller calls after close throw.
- **Click-through**: `setClickThrough('shape')` (default: empty parts pass clicks to the app underneath, your elements catch), `'none'`, `'all'`. `setHitTest((x, y) => boolean)` for canvas drawings. `view.desktop.clickThrough === false` on Linux (always catches: keep the window tight).
- **Another document, same process**: use `el.ownerDocument` / `.defaultView`; no `instanceof HTMLElement`; don't mount `ctx.ui.*` host components into it; use `view.desktop.requestFrame`, not the global `requestAnimationFrame` (that one slows down when the main window is hidden). Theme variables and light / dark follow; the page background is transparent.
- `ctx.ui.float({ scope: 'desktop' })` still does not exist.

## Controller `view.desktop`

`bounds()`, `workArea()` (screen minus Dock / taskbar / menu bar; a pet stands at `y + height`), `screens()`, `moveTo(x, y)`, `moveBy(dx, dy)`, `resize(w, h)`, `drag(pointerEvent)`, `setClickThrough(mode)`, `clickThrough`, `setHitTest(fn | null)`, `requestFrame(cb)` / `cancelFrame(h)`, `onBounds(fn) → unsubscribe`, `close()`. Screen coordinates in logical pixels.

Real-Electron harness for the host side: `npm run check:desktopwindow` in `Forsion-Genesis/desktop`; its probe plugin (`scripts/desktop-window.check.cjs`) is a minimal working example.
