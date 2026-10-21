/** Real Windows caption hit testing, native double-click/maximize/minimize/close,
 * plus renderer geometry at UI zoom and display DPI. No physical pointer input.
 * npm run build && npm run check:tabtitlebar [-- --scale=1.25] */
const fs = require('fs'), os = require('os'), path = require('path')
const { execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-tab-titlebar-'))
const output = path.resolve(process.env.TITLEBAR_OUTPUT || path.join(home, 'evidence'))
fs.mkdirSync(output, { recursive: true })
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail === undefined ? '' : JSON.stringify(detail))
}
const pause = ms => new Promise(r => setTimeout(r, ms))

// NCHITTEST reaches Windows' real non-client routing, unlike Playwright mouse
// events which go straight to Chromium and can falsely pass on a drag region.
function native(handle, points = [], action = '', screenshot = '', viewportWidth = 0) {
  const script = `Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CaptionProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr w);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr w, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr w, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr w, uint m, IntPtr wp, IntPtr lp, uint f, uint t, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr w, uint m, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr w, IntPtr dc, uint flags);
}
'@
[void][CaptionProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$hwnd = [IntPtr]::new([long]${handle})
$origin = New-Object CaptionProbe+POINT
[void][CaptionProbe]::ClientToScreen($hwnd,[ref]$origin)
$dpi = [CaptionProbe]::GetDpiForWindow($hwnd) / 96.0
$client = New-Object CaptionProbe+RECT
[void][CaptionProbe]::GetClientRect($hwnd,[ref]$client)
$scale = if (${viewportWidth} -gt 0) { ($client.right-$client.left) / ${viewportWidth}.0 } else { $dpi }
$hits = @()
$points = '${JSON.stringify(points)}' | ConvertFrom-Json
foreach ($p in $points) {
  $x = $origin.x + [int][Math]::Round($p.x * $scale)
  $y = $origin.y + [int][Math]::Round($p.y * $scale)
  $lp = [IntPtr]::new([long](($y -band 65535) -shl 16) -bor ($x -band 65535))
  $result = [IntPtr]::Zero
  [void][CaptionProbe]::SendMessageTimeout($hwnd,0x84,[IntPtr]::Zero,$lp,2,1500,[ref]$result)
  $hits += @{name=$p.name; hit=$result.ToInt64(); x=$x; y=$y}
}
$action = '${action}'
if ($action -eq 'doubleclick') { [void][CaptionProbe]::PostMessage($hwnd,0xA3,[IntPtr]::new(2),[IntPtr]::Zero) }
if ($action -eq 'minimize') { [void][CaptionProbe]::PostMessage($hwnd,0x112,[IntPtr]::new(0xF020),[IntPtr]::Zero) }
if ($action -eq 'close') { [void][CaptionProbe]::PostMessage($hwnd,0x112,[IntPtr]::new(0xF060),[IntPtr]::Zero) }
$shot = '${screenshot.replace(/'/g, "''")}'
if ($shot) {
  $rect = New-Object CaptionProbe+RECT
  [void][CaptionProbe]::GetWindowRect($hwnd,[ref]$rect)
  $bitmap = New-Object Drawing.Bitmap ($rect.right-$rect.left),($rect.bottom-$rect.top)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $dc = $graphics.GetHdc()
  [void][CaptionProbe]::PrintWindow($hwnd,$dc,2)
  $graphics.ReleaseHdc($dc)
  $bitmap.Save($shot)
  $graphics.Dispose(); $bitmap.Dispose()
}
@{dpi=$dpi;scale=$scale;hits=$hits} | ConvertTo-Json -Compress -Depth 4`
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim())
}

async function metadata(app, page) {
  return app.evaluate(({ BrowserWindow }, url) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)
    return { handle: w.getNativeWindowHandle().readBigUInt64LE().toString(), bounds: w.getBounds(), content: w.getContentBounds(), maximized: w.isMaximized(), minimized: w.isMinimized() }
  }, page.url())
}
async function geometry(page) {
  return page.evaluate(() => {
    const overlay = navigator.windowControlsOverlay
    const area = overlay?.getTitlebarAreaRect()
    const edge = document.querySelector('.dv-edge-actions')
    const er = edge?.getBoundingClientRect()
    const tabs = [...document.querySelectorAll('.dv-tabs-and-actions-container')].filter(el => { const r = el.getBoundingClientRect(); return r.top < 2 && r.height > 0 })
    const tr = tabs[0]?.getBoundingClientRect()
    const point = (name, el) => { const r = el?.getBoundingClientRect(); return r && { name, x: r.x + r.width / 2, y: r.y + r.height / 2 } }
    const lastButton = edge?.lastElementChild?.getBoundingClientRect()
    const width = area?.height > 0 ? innerWidth - area.right : 0
    return { width: innerWidth, reserved: document.documentElement.style.getPropertyValue('--windows-caption-width'), overlay: overlay?.visible, area: area?.toJSON(), captionWidth: width,
      edge: er?.toJSON(), tabs: tr?.toJSON(), lastButton: lastButton?.toJSON(),
      points: [point('tab', tabs[0]?.querySelector('.dv-tab')), point('new-tab', tabs[0]?.querySelector('.dv-new-tab')),
        point('toolbar', edge?.lastElementChild),
        tr && { name: 'drag', x: (tr.left + tr.right) / 2, y: tr.top + tr.height / 2 },
        ...['minimize', 'maximize', 'close'].map((name, i) => ({ name, x: (area?.right ?? innerWidth) + width * (i + .5) / 3, y: (area?.height ?? 32) / 2 }))].filter(Boolean) }
  })
}

async function main() {
  if (process.platform !== 'win32') { console.log('Windows-only native titlebar check'); return }
  const stub = await startStubEngine()
  let app
  try {
    const userData = path.join(home, 'userdata')
    fs.mkdirSync(userData + '-dev', { recursive: true })
    fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'titlebar-test' }))
    const scale = process.argv.find(a => a.startsWith('--scale='))?.slice(8)
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ...(scale ? [`--force-device-scale-factor=${scale}`] : []), ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(home, 'no-helper.sock') } })
    const page = await app.firstWindow()
    await page.waitForSelector('.dv-groupview', { state: 'attached', timeout: 60000 })
    check('onboarding dismissed', await skipOnboarding(page))
    await pause(800)
    // Record the actual overlay updates without replacing the native method.
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.__titlebarUpdates = []
      for (const w of BrowserWindow.getAllWindows()) {
        const original = w.setTitleBarOverlay.bind(w)
        w.setTitleBarOverlay = options => { globalThis.__titlebarUpdates.push(options); original(options) }
      }
    })
    for (const zoom of [1, 1.1, .8, .5, 1.5, 2]) {
      await page.evaluate(zoom => { document.body.style.zoom = String(zoom); document.documentElement.style.setProperty('--uiz', String(zoom)); window.dispatchEvent(new Event('forsion:uizoom')) }, zoom)
      await pause(350)
      const g = await geometry(page), meta = await metadata(app, page)
      check(`main ${zoom}: native controls share top tab row`, g.overlay && g.captionWidth > 100 && g.tabs.top < 2 && Math.abs(g.area.height - g.tabs.height) <= 2, { tabs: g.tabs, area: g.area })
      check(`main ${zoom}: tools end before caption buttons`, g.lastButton.right <= g.area.right - 2)
      const n = native(meta.handle, g.points, '', path.join(output, `main-${zoom}.png`), g.width)
      check(`main ${zoom}: tab/new-tab/tools are client input`, ['tab', 'new-tab', 'toolbar'].every(name => n.hits.some(h => h.name === name && h.hit === 1)), n)
      check(`main ${zoom}: blank tab area is native caption`, n.hits.find(h => h.name === 'drag')?.hit === 2)
      check(`main ${zoom}: all native caption buttons reachable`, ['minimize', 'maximize', 'close'].every((name, i) => n.hits.some(h => h.name === name && h.hit === [8, 9, 20][i])))
    }
    await page.evaluate(() => { localStorage.setItem('forsion_theme', 'dark'); localStorage.setItem('forsion_ui_zoom', '1.1'); localStorage.setItem('forsion_locale', 'en') })
    await page.reload()
    await page.waitForSelector('.dv-groupview', { timeout: 30000 })
    await pause(700)
    let g = await geometry(page), meta = await metadata(app, page)
    native(meta.handle, [], '', path.join(output, 'main-dark.png'))
    check('dark caption symbols follow effective theme', (await app.evaluate(() => globalThis.__titlebarUpdates)).some(v => v.symbolColor === '#ecebea'))

    // Native titlebar double-click uses the same HTCAPTION route tested above.
    native(meta.handle, [], 'doubleclick')
    await pause(500)
    check('native double-click maximizes', (await metadata(app, page)).maximized)
    g = await geometry(page)
    check('maximized tools avoid native buttons', g.lastButton.right <= g.area.right - 2)
    native(meta.handle, [], '', path.join(output, 'main-maximized.png'))
    native(meta.handle, [], 'doubleclick')
    await pause(500)
    check('native double-click restores', !(await metadata(app, page)).maximized)
    native(meta.handle, [], 'minimize')
    await pause(300)
    check('native minimize works', (await metadata(app, page)).minimized)
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('window=')); w.restore(); w.show() })
    await pause(350)

    // Chromium's WCO rect can remain stale in OS fullscreen; native state wins.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('window=')).setFullScreen(true))
    await pause(450)
    g = await geometry(page)
    const fullHits = native(meta.handle, g.points, '', path.join(output, 'main-fullscreen.png'), g.width)
    check('fullscreen releases hidden native caption reservation', parseFloat(g.reserved) === 0, { reserved: g.reserved, area: g.area, hits: fullHits })
    await page.reload()
    await page.waitForSelector('.dv-groupview', { timeout: 30000 })
    await pause(400)
    check('reload in fullscreen keeps caption reservation released', parseFloat((await geometry(page)).reserved) === 0)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('window=')).setFullScreen(false))
    await pause(450)
    g = await geometry(page)
    check('leaving fullscreen restores caption reservation', g.captionWidth > 100 && g.lastButton.right < g.area.right, g)

    // Many real tabs and a visible right group exercise the toolbar padding guard.
    for (let i = 0; i < 9; i++) await page.locator('.dv-new-tab').first().click()
    await page.locator('.dv-edge-right').click()
    await pause(500)
    g = await geometry(page)
    check('overflow tabs stay outside the toolbar reservation', await page.evaluate(() => {
      return [...document.querySelectorAll('.dv-tabs-and-actions-container.dv-under-edge')].every(el => {
        const tabs = el.querySelector('.dv-tabs-container')?.getBoundingClientRect()
        const edge = document.querySelector('.dv-edge-actions').getBoundingClientRect()
        return !tabs || tabs.right <= edge.left + 2
      })
    }))
    native(meta.handle, [], '', path.join(output, 'main-overflow.png'))
    const inactive = page.locator('.dv-tab:not(.dv-active-tab)').first()
    await inactive.evaluate(el => { el.dataset.captionSwitchProbe = '1' })
    await inactive.click()
    check('tab switching activates the clicked tab', await page.locator('.dv-tab[data-caption-switch-probe="1"]').evaluate(el => el.classList.contains('dv-active-tab')))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('window=')).setSize(880, 640))
    await pause(350)
    g = await geometry(page)
    check('minimum main window width preserves caption/tools separation', g.lastButton.right <= g.area.right - 2, g)
    native(meta.handle, [], '', path.join(output, 'main-narrow.png'))

    // Detached/Space windows use the same native buttons with no Ribbon.
    const opened = app.waitForEvent('window')
    await page.evaluate(() => window.tangu.openDetached([{ type: 'home' }]))
    const detached = await opened
    await detached.waitForSelector('.shell--noribbon .dv-tab', { timeout: 30000 })
    await pause(600)
    g = await geometry(detached)
    const dm = await metadata(app, detached)
    const dn = native(dm.handle, g.points, '', path.join(output, 'detached-dark.png'), g.width)
    check('detached window shares controls with tab row', g.captionWidth > 100 && g.tabs.top < 2 && g.lastButton.right < g.area.right)
    check('detached native drag/tab/close routes', ['drag', 'tab', 'close'].every((name, i) => dn.hits.some(h => h.name === name && h.hit === [2, 1, 20][i])), dn)
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url).setSize(480, 360), detached.url())
    await pause(350)
    g = await geometry(detached)
    check('minimum detached width preserves caption/tools separation', g.lastButton.right <= g.area.right - 2)
    native(dm.handle, [], '', path.join(output, 'detached-narrow.png'))
    native(dm.handle, [], 'close')
    await pause(400)
    check('native close closes only detached window', detached.isClosed() && !page.isClosed())

    check('malformed caption requests rejected', !(await page.evaluate(() => window.tangu.setTabTitleBar({ height: -1, symbolColor: 'red' }))).ok)
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
    console.log('Evidence:', output)
    if (app) await app.close()
    await stub.close()
  }
  if (results.some(r => !r.ok)) process.exitCode = 1
}
main().catch(e => { console.error(e); process.exitCode = 1 })
