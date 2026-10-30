---
title: Floating Panel development
description: The sixth panel surface, its behaviour on each platform, and the plugin API.
---
# Floating Panel development

The Floating Panel is the workspace's sixth panel surface, suited to standalone tool pages such as Settings, the Store, Achievements, Feedback and plugin tools. It does not take part in the Dockview layout and does not use a tab in the main area:

On desktop, Floating windows, Mini and standalone windows dragged out of Dockview are all satellite windows of an app that is already running. They must show their target content directly and must not replay the branded splash that belongs only to the first launch of the Forsion main window.

- macOS / Windows: the host creates a native child window of the main window that can be dragged, resized, minimized and closed. Opening the same `id` again focuses and updates the existing window.
- Web: the host shows a fixed, centered panel above the current page; it cannot be dragged. The main workbench stays behind it.
- Mobile: desktop windows are not emulated; full-screen secondary pages are used as before.

Register a normal DOM view with `ctx.registerView()` first, then open the Floating Panel with the relative view id. The host adds the `plugin:<pluginId>:` namespace and owns the native window / Web overlay chrome; a plugin cannot open or override another plugin's views.

```js
ctx.registerView({
  id: 'inspector',
  title: 'Inspector',
  mount(el, view) {
    el.textContent = `Surface: ${view?.surface}`
  },
})

ctx.registerCommand({
  id: 'open-inspector',
  title: 'Open Inspector',
  run() {
    ctx.openFloatingPanel?.('inspector', {
      title: 'Inspector',
      params: { source: 'command' },
      width: 880,
      height: 640,
    })
  },
})
```

`openFloatingPanel` options:

| Field | Meaning |
| --- | --- |
| `title` | Window/panel title; defaults to the registered view's title |
| `params` | Serializable instance parameters |
| `width` / `height` | Preferred size of the native desktop window |
| `minWidth` / `minHeight` | Minimum size of the native desktop window |

On this surface `mount(el, view)` receives `view.surface === 'floating'`. `getParams`, `setParams` and `onParamsChanged` behave as in the main panel; `showInMainPanel()` hands the current parameters back to the main workspace. Floating does not provide `extendView`. When the window closes or the plugin is disabled, the host calls the cleanup function returned by `mount`; clean up all subscriptions there. When an open plugin view is unregistered, its window or Web overlay closes automatically.

Feature-detect `ctx.openFloatingPanel?.(...)` for compatibility with older hosts. Desktop and Web both support Floating today; mobile has no desktop floating semantics, so keep providing a normal main view as a fallback.

## Verification

```bash
cd desktop && npm run typecheck
cd desktop && npm run build && npm run check:floatingpanel
cd desktop && npm run check:parity && npm run check:cssvar && npm run check:shadowcontract
```

Real-device checks should at least cover: dragging, minimizing and closing the native window, reuse of the same id, Web panels not being draggable, light and dark themes, cleanup after the plugin is disabled, and parameters handed over intact through "Show in main panel".

### Close from view content

Use `view.close?.()` for Close, Back and successful confirmation actions in plugin content; the owning host closes the desktop floating window or Web overlay. The callback is revoked after unmount. Do not call `window.close()` directly or reach into another window.
