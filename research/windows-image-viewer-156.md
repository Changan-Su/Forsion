# Windows image viewer caption verification (#156)

Baseline: `7b9c7354`, including the spacing fix merged in #155.

The original overlap is resolved, but Windows still classified the zoom buttons
above the tab row as `HTCAPTION` (2). Playwright's renderer clicks bypass this
native routing, so geometry and renderer interaction alone missed the problem.
Declaring the viewer overlay `-webkit-app-region: no-drag` makes those points
`HTCLIENT` (1) while preserving the native window buttons.

The old synthetic check also removed the actual Windows titlebar marker and
caption width. It now runs only on other platforms and restores the prior values.
Windows checks read the real `navigator.windowControlsOverlay` geometry instead.

## Local evidence

Windows build `10.0.26200`, real display DPI 120 (125%). Tests used isolated user
data and the background desktop harness. Native read-only `WM_NCHITTEST` probes
and `PrintWindow` screenshots require no foreground activation or global input.

| Window | UI zoom | Viewport width | Gap before caption buttons |
| --- | --- | --- | --- |
| Normal | 100% | 1440 | 12 px |
| Normal | 110% | 1440 | 13 px |
| Maximized | 100% | 2048 | 12 px |
| Maximized | 110% | 2048 | 13 px |
| Compact | 170% | 900 | 20 px |
| Compact | 200% | 900 | 24 px |

- 69 image viewer checks passed, including all six native cases.
- Every viewer tool is `HTCLIENT`; native minimize/maximize/close remain 8/9/20.
- Clicking viewer close removes only the viewer and retains the chat window.
- Compact More menus open and expose their two actions.
- 13 related titlebar, harness and CSS guard unit tests passed.
- Both negative controls failed at their intended assertion: removing the gap
  causes overlap; removing `no-drag` restores native drag interception.
- Normal and compact screenshots were visually inspected, including native controls.

## Reproduction

From `desktop/`, after `npm ci`:

```powershell
npm run build
$env:SHOTS = 'outputs/image-viewer-windows'
npm run check:imageviewer
# Both commands below must exit nonzero at their respective native assertion.
node scripts/chat-image-viewer.check.cjs --no-caption-gap
node scripts/chat-image-viewer.check.cjs --no-viewer-client-region
```

The `probe-image-viewer-windows` PR workflow repeats all three runs and publishes
native screenshots, geometry/DPI JSON and negative-control output as an artifact.
Physical pointer input and a newly packaged release are outside this check.
