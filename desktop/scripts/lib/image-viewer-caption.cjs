/** Read-only Windows non-client hit tests and a PrintWindow capture of our test window.
 * No foreground activation or global pointer input. Coordinates start in renderer pixels.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.probeCaption = (handle, width, points, screenshot = '') => {
  const script = `Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ViewerCaptionProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr w);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr w, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr w, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr w, uint m, IntPtr wp, IntPtr lp, uint f, uint t, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr w, IntPtr dc, uint flags);
}
'@
[void][ViewerCaptionProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$hwnd = [IntPtr]::new([long]${handle})
$origin = New-Object ViewerCaptionProbe+POINT
$client = New-Object ViewerCaptionProbe+RECT
if (![ViewerCaptionProbe]::ClientToScreen($hwnd,[ref]$origin) -or ![ViewerCaptionProbe]::GetClientRect($hwnd,[ref]$client)) { throw 'Cannot read test window bounds' }
$scale = ($client.right-$client.left) / ${width}.0
$hits = @()
foreach ($p in ('${JSON.stringify(points)}' | ConvertFrom-Json)) {
  $x = $origin.x + [int][Math]::Round($p.x * $scale)
  $y = $origin.y + [int][Math]::Round($p.y * $scale)
  $lp = [IntPtr]::new([long](($y -band 65535) -shl 16) -bor ($x -band 65535))
  $result = [IntPtr]::Zero
  if ([ViewerCaptionProbe]::SendMessageTimeout($hwnd,0x84,[IntPtr]::Zero,$lp,2,1500,[ref]$result) -eq [IntPtr]::Zero) { throw 'WM_NCHITTEST timed out' }
  $hits += @{name=$p.name; hit=$result.ToInt64()}
}
$shot = '${screenshot.replace(/'/g, "''")}'
if ($shot) {
  $rect = New-Object ViewerCaptionProbe+RECT
  if (![ViewerCaptionProbe]::GetWindowRect($hwnd,[ref]$rect)) { throw 'Cannot read screenshot bounds' }
  $bitmap = New-Object Drawing.Bitmap ($rect.right-$rect.left),($rect.bottom-$rect.top)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $dc = $graphics.GetHdc()
  try {
    if (![ViewerCaptionProbe]::PrintWindow($hwnd,$dc,2)) { throw 'PrintWindow failed' }
  } finally { $graphics.ReleaseHdc($dc) }
  $bitmap.Save($shot)
  $graphics.Dispose(); $bitmap.Dispose()
}
@{dpi=[ViewerCaptionProbe]::GetDpiForWindow($hwnd);scale=$scale;hits=$hits} | ConvertTo-Json -Compress -Depth 4`
  return JSON.parse(execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim())
}

exports.checkWindowsCaption = async ({ app, win, check, closed, shots }) => {
  const evidence = { platform: process.platform, release: require('node:os').release(), cases: [] }
  const cases = [
    { name: 'normal', zoom: 1 }, { name: 'normal-110', zoom: 1.1 },
    { name: 'maximized', zoom: 1, maximized: true }, { name: 'maximized-110', zoom: 1.1, maximized: true },
    { name: 'compact', zoom: 1.7, compact: true }, { name: 'compact-200', zoom: 2, compact: true },
  ]
  for (const c of cases) {
    await app.evaluate(({ BrowserWindow }, c) => {
      const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === c.url)
      if (w.isMaximized()) w.unmaximize()
      w.setContentSize(c.compact ? 900 : 1440, 850)
      if (c.maximized) w.maximize()
    }, { ...c, url: win.url() })
    await win.evaluate(zoom => {
      document.body.style.zoom = String(zoom)
      document.documentElement.style.setProperty('--uiz', String(zoom))
      window.dispatchEvent(new Event('forsion:uizoom'))
    }, c.zoom)
    await win.waitForTimeout(500)
    await win.locator('#tocmsg-u1 .att-tile--img img').first().click()
    await win.locator('.iv').waitFor()
    await win.waitForTimeout(400)
    const g = await win.evaluate(() => {
      const root = document.documentElement, overlay = navigator.windowControlsOverlay
      const area = overlay?.getTitlebarAreaRect()
      const buttons = [...document.querySelectorAll('.iv-tools .iv-btn')].map((b, i) => {
        const r = b.getBoundingClientRect()
        return { name: `tool-${i}`, x: r.x + r.width / 2, y: r.y + r.height / 2, right: r.right }
      })
      const captionWidth = area && innerWidth - area.right
      return { width: innerWidth, overlay: overlay?.visible, area: area?.toJSON(), captionWidth,
        reserved: parseFloat(root.style.getPropertyValue('--windows-caption-width')), marker: root.hasAttribute('data-tab-titlebar'),
        compact: !!document.querySelector('.iv.is-compact'), more: !!document.querySelector('.iv-more'), buttons,
        points: [...buttons, ...['minimize', 'maximize', 'close'].map((name, i) => ({ name, x: area.right + captionWidth * (i + .5) / 3, y: area.height / 2 }))] }
    })
    check(`${c.name}: real Windows caption geometry is active`, g.marker && g.overlay && g.captionWidth > 100 && Math.abs(g.reserved - g.captionWidth) < 1, g)
    check(`${c.name}: every viewer tool clears the native caption`, g.buttons.length >= 2 && g.buttons.every(b => b.right <= g.area.right - 2), g)
    check(`${c.name}: expected compact toolbar`, g.compact === !!c.compact && g.more === !!c.compact, g)
    const meta = await app.evaluate(({ BrowserWindow }, url) => {
      const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)
      return { handle: w.getNativeWindowHandle().readBigUInt64LE().toString(), maximized: w.isMaximized() }
    }, win.url())
    check(`${c.name}: actual window maximize state`, meta.maximized === !!c.maximized, meta)
    const native = exports.probeCaption(meta.handle, g.width, g.points, shots ? path.join(shots, `windows-${c.name}.png`) : '')
    check(`${c.name}: viewer buttons receive native client input`, g.buttons.every(b => native.hits.some(h => h.name === b.name && h.hit === 1)), native)
    check(`${c.name}: native minimize/maximize/close stay reachable`, ['minimize', 'maximize', 'close'].every((name, i) => native.hits.some(h => h.name === name && h.hit === [8, 9, 20][i])), native)
    if (c.compact) {
      await win.locator('.iv-more .iv-btn').click()
      await win.locator('.iv-menu').waitFor()
      check(`${c.name}: More menu opens`, await win.locator('.iv-menu button').count() === 2)
      await win.keyboard.press('Escape')
    }
    await win.locator('.iv-tools > button:last-child').click()
    await closed()
    check(`${c.name}: viewer close keeps the chat window alive`, !win.isClosed() && await win.locator('#tocmsg-u1').count() === 1)
    evidence.cases.push({ ...c, geometry: g, native, maximized: meta.maximized })
  }
  if (shots) require('node:fs').writeFileSync(path.join(shots, 'windows-caption.json'), JSON.stringify(evidence, null, 2))
}
