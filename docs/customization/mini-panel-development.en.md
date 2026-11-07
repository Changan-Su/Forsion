---
title: Mini Panel development
description: The Mini contract for Space adapters, plugin context and foreground Computer Use.
---
# Mini Panel development

A Space's `mini` is an explicit capability declaration. Both `SpaceDefinition.mini` and `space.json.mini` contain `view` and `mainView`, each of the form `{type, params?}`, plus an optional `name`. Native names can be evaluated lazily; JSON names can be written as `{zh,en}`.

```json
{
  "mini": {
    "name": { "zh": "快捷记录", "en": "Quick capture" },
    "view": { "type": "plugin:my-plugin:quick", "params": { "itemId": "today" } },
    "mainView": { "type": "plugin:my-plugin:detail" }
  }
}
```

The two view types must differ and both must be registered. Mini is opt-in; if an optional Mini view is missing, the full Space still loads. Do not make an optional Mini type a hard dependency in `requires.views`. Mini mounts a dedicated view: it does not run `Space.build()`, does not restore the desktop/mobile layout, and provides no tabs, global Ribbon actions or mobile drawer. Links to other full views are handed to the main panel.

The window opens at 320×420. The user can drag the card's four edges and four corners to resize it between 260×160 and 640×900, and reopening it keeps the last size (within the current run). Lay the view out against its container: at 260 wide or 160 tall the content should scroll or truncate on its own, so don't hard-code a 320×420 size. The temporary Mini that Computer Use opens automatically stays fixed at 320×420. Adapters reuse the domain data and editing capabilities and get purpose-built quick interactions. Use semantic theme variables, provide Chinese and English text, and don't fill the panel with branded welcome pages, global settings or duplicate navigation. The host owns Space switching, locating content in the main panel, and closing.

A plugin doesn't need a full Space for one quick card. After registering a view, open Mini directly:

```js
ctx.openMiniPanel?.('quick', {
  title: 'Quick capture',
  params: { itemId: 'today' },
  mainViewId: 'detail',
  mainViewParams: { section: 'inbox' },
})
```

`viewId` and `mainViewId` are both ids relative to the current plugin; the host adds `plugin:<pluginId>:` automatically. If you omit `mainViewId`, the main panel opens the same view. Older hosts and Web/mobile may not have this native window API, so call it optionally and keep a `ctx.openView()` fallback.

## Plugin context

The second argument of `ctx.registerView({id, title, mount(el, view)})` gains the following optional members; check that they exist first on older hosts.

| Member | Behaviour |
| --- | --- |
| `surface` | `mini`, `floating` or `main`; Mini/Floating don't provide `extendView` |
| `getParams()` | The current instance's entity or filter parameters |
| `setParams(patch)` | Merges parameters and updates the main-panel target |
| `onParamsChanged(fn)` | Notifies on parameter changes; returns an unsubscribe function and does not remount the DOM |
| `showInMainPanel()` | Mini only; uses `mini.mainView`, with the current parameters overriding its defaults |

After closing, switching Space or disabling the plugin, the old context is revoked. When enable/disable preferences change in the main panel, Mini cleans up or re-registers the local instance and Space accordingly, without re-sending the action that disables automation. The cleanup function returned by `mount` should stop async callbacks and subscriptions. Full and compact views use the same entity keys and don't copy data. Code samples are in `tangu-agent/skills/forsion-plugin/samples/forsion-sample-bundle/`.

## Foreground Computer Use

At the point where real HID input is posted, the macOS helper writes `foreground.json` (v1) in the same directory as its socket. It contains only `active`, `updatedAt`, `expiresAt` and `helperPid`. Candidate foreground strategies, AX successes and PID-targeted background input produce no signal. A recursive physical-input scope activates on the first real input and ends when the outermost scope exits; while active it is renewed every second, the lease is capped at 2500ms, and a short click keeps the signal for 350ms after it ends so polling can catch it. If the helper disappears, the file is corrupt or the lease expires, no new foreground signal is produced, the helper is not started and no screenshot is taken; once a foreground run has been confirmed, the session/run and Forsion's focus decide when it ends.

Electron reads the signal every 60ms after the app starts, without depending on a manual Mini window. The main renderer reports only the current `sessionId/runId` through `window:miniSession`; the main process accepts it only from the main window's top-level frame. A temporary session window starts only when all three hold: a valid foreground lease, Forsion not focused, and a run in the current session. The observer window stays up between calls within the same run, and hides when the run ends, the session changes or focus returns to Forsion. **When the run ends and the user never came back to Forsion in the meantime**, the main process returns focus to the Forsion window that was focused last before the automatic Mini opened (a window the user hid meanwhile isn't forced back; returning focus, taking over with ⌘⇧M, or quitting never trigger the hand-back). Background calls and ordinary focus loss never open the window on their own.

The temporary window uses `window=mini&transient=1` and targets the Tangu session view. It calls `showInactive` only after it receives `miniSessionReady` from the actual Chat mount and the conditions still hold. It sits at the top-right of the work area of the display under the cursor (24px inset) and does not follow the cursor; opening it does not steal focus, and it does not write the manual Mini's Space/layout persistence. The window is focusable with `acceptFirstMouse`, so the header drag area can be dragged on the first press. That press activates Forsion (on macOS `type:'panel'` doesn't prevent it either, verified with a real mouse), but focus lands on the card itself and `hasForsionFocus` excludes the automatic Mini, so dragging doesn't count as "returning to Forsion". A manual Mini takes priority, and a hidden manual window is neither reused nor overwritten; a shortcut can hand the temporary session over to a manual Mini. Plugins need no new APIs and don't listen for the foreground signal themselves.

During Computer Use (throughout for the temporary Mini; for a manual Mini while `following()` is true), mouse pass-through is switched every 50ms by pointer position: pointer off the card → pass-through, so clicks land on the app being controlled; pointer on the card → interactive, so the user can drag it away. `setIgnoreMouseEvents` is called only when the state changes. Known limit: if CU's moveMouse hover happens to stop on the card, the next click at the same point lands on the card; if that actually happens, switch to per-tool-call pass-through.

Genesis and `tangu-computer-use` are separate repositories; delivery needs matching updates and a rebuilt helper. The built-in bundle must be at least 0.5.2. When you change the bundled helper contents, bump the manifest version, because desktop intentionally skips same-version copies. After a successful helper update, restart the resident process as well; the same protocol number and path don't mean the running binary has been updated. The signal is currently implemented for macOS; older helpers and other platforms keep Mini as a static panel.

## Verification

- `desktop`:

```bash
npm run typecheck
npm run check:parity
npm run check:cssvar
npm run build && npm run check:minicard && npm run check:miniauto
```

- Unit tests: `miniAutoPanel.test.ts`, `miniForeground.test.ts`, `lcl/spaces/miniPanel.test.ts`, plus the Space registry and i18n coverage tests.
- Computer Use plugin: `npm run check:helper-refresh`, `npm run check:helper-signal`, `npm run check:mini-foreground`; the full Swift type check covers new files and all native sources.
- Electron tests use a temporary backend, Vault, on-disk plugins and a foreground signal to verify that the real BrowserWindow position stays put, pass-through switches, and screenshots; they send no physical input to the user's apps. Real HID-to-signal is covered by the native reporter tests and the input-path wiring check.
- `npm run check:mininative` uses the installed, authorized real macOS helper and operates only an isolated Electron test window: it moves the mouse through a real `act` to activate the foreground, then verifies the native signal, the automatic session window, no focus stealing, staying visible between calls, the card staying put while the real mouse moves, and hiding at the end with focus returned to the main window. No real model is needed; session SSE uses fixtures. It doesn't inject `foreground.json` or override cursor APIs, so source or simulated signals can't go all green while a shipped old helper sends no signal at all.
- `check:miniauto` uses a separate isolated Electron process to hold real OS focus and verifies: automatic pop-up without a manual Mini ever opened, top-right placement, pointer movement not dragging the window, interactive under the pointer and pass-through elsewhere, staying visible across SSE in the same session, persistence between calls, hiding on run end / refocus, focus returned to the main window when the run ends, and that the manual window and saved data are not overwritten. The geometry part of `check:minicard` pins cursor and focus inputs; real focus behaviour is covered by the former.
- The premise that "dragging the card doesn't steal focus to the main window" was measured on 2026-09-28 by dragging an isolated Electron window with a real mouse while another app was in front: focusable + `acceptFirstMouse` → draggable, the card itself gets focus; `focusable:false` → not draggable and the main window gets focus; `type:'panel'` → draggable but the main window gets focus (which in Forsion means the card hides). A programmatic `focus()` can't reproduce this end state (`app.focus` focuses the main window first), so the harness doesn't cover this step.
- `check:miniauto` starts with `TANGU_HARNESS_QUIET=0`: instances launched by Playwright are quiet by default (`present()` only calls `showInactive` and doesn't really refocus at the end), so it must be turned off to test the hand-back semantics.
- The resize part of `check:minicard`: a real pointer presses the hot zone at the card's edge, with the cursor position supplied by a stand-in, and it verifies that only the manual Mini can resize itself, the opposite edge stays put, sizes clamp at the minimum, content fills the new size, and reopening keeps the size. Transparent frameless windows have no system resize edges on Windows, so the card draws its own resize edges and all three platforms use the same path; the renderer only reports which edge, and the main process computes the displacement from the cursor.
