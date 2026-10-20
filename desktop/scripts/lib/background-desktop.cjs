/** Opt-in Windows verification desk: leftmost display, below ordinary windows, no OS focus.
 * Loaded before the application through Electron's -r flag; only harness launches opt in.
 * Do not use this mode to claim foreground/physical-input behavior was verified.
 */
const electron = require('electron')
const { app, screen } = electron
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
// A harness preload is not an external document for the app's argv file handler.
process.argv = process.argv.filter((arg, i, args) => arg !== __filename && !((arg === '-r' || arg === '--require') && args[i + 1] === __filename))
const lower = win => {
  if (win.isDestroyed()) return
  const handle = win.getNativeWindowHandle()
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE())
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LowerWindow { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags); }';
if (![LowerWindow]::SetWindowPos([IntPtr][long]${hwnd}, [IntPtr]1, 0, 0, 0, 0, 0x4213)) { throw 'Could not lower test window' }
`], { windowsHide: true, timeout: 10000, stdio: 'pipe' })
}
app.focus = () => {}
// Route the application's default-placement queries to the selected real monitor.
// In particular Mini must be constructed there, rather than moved across DPI later.
// This opt-in mode is not evidence about the actual primary monitor or focus behavior.
app.once('ready', () => { screen.getPrimaryDisplay = () => screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x)[0] })
app.on('browser-window-created', (_event, win) => {
  const requestedContent = win.getContentBounds()
  let displayed = false
  const work = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x)[0].workArea
  // Electron exposes these native methods on each instance, not its JS prototype.
  const bounds = win.setBounds.bind(win), content = win.setContentBounds.bind(win), position = win.setPosition.bind(win)
  const inactive = win.showInactive.bind(win), top = win.setAlwaysOnTop.bind(win), focusable = win.setFocusable.bind(win)
  const confined = b => {
    // Framed windows can grow/round their non-client border during mixed-DPI moves.
    // Transparent Mini has no border and must still reach the real docking edge.
    const margin = win.getBounds().width - win.getContentBounds().width > 2 ? 16 : 0
    return { ...b, x: Math.max(work.x + margin, Math.min(b.x, work.x + work.width - b.width - margin)),
      y: Math.max(work.y + margin, Math.min(b.y, work.y + work.height - b.height - margin)) }
  }
  const settle = () => {
    // Crossing real mixed-DPI displays can change the native frame size after the move.
    for (let i = 0; i < 3; i++) {
      const b = win.getBounds(), next = confined(b)
      if (b.x === next.x && b.y === next.y) return
      const inner = win.getContentBounds()
      content({ ...inner, x: inner.x + next.x - b.x, y: inner.y + next.y - b.y })
    }
  }
  win.setBounds = (b, animate) => {
    const next = confined({ ...win.getBounds(), ...b })
    bounds({ ...b, x: next.x, y: next.y }, animate); settle()
  }
  win.setContentBounds = (b, animate) => {
    const outer = win.getBounds(), inner = win.getContentBounds(), next = { ...inner, ...b }
    const dx = inner.x - outer.x, dy = inner.y - outer.y
    const frame = confined({ x: next.x - dx, y: next.y - dy, width: next.width + outer.width - inner.width, height: next.height + outer.height - inner.height })
    content({ ...next, x: frame.x + dx, y: frame.y + dy }, animate); settle()
  }
  win.setPosition = (x, y, animate) => { const b = confined({ ...win.getBounds(), x, y }); position(b.x, b.y, animate); settle() }
  win.showInactive = () => {
    // browser-window-created precedes the constructor's final position/style pass.
    // Reapply the requested content size once on the chosen display, after that pass.
    if (!displayed) {
      const scale = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x)[0].scaleFactor
      const grid = Array.from({ length: 16 }, (_, i) => i + 1).find(n => Math.abs(n * scale - Math.round(n * scale)) < 1e-6) || 1
      const b = win.getContentBounds()
      content({ ...b, x: Math.ceil(b.x / grid) * grid, y: Math.ceil(b.y / grid) * grid, width: requestedContent.width, height: requestedContent.height })
      displayed = true
    }
    settle(); inactive(); lower(win)
  }
  win.show = win.showInactive
  win.focus = () => {}
  win.setAlwaysOnTop = () => top(false)
  win.setFocusable = () => focusable(false)
  const initial = win.getBounds()
  if (initial.x < work.x || initial.x + initial.width > work.x + work.width || initial.y < work.y || initial.y + initial.height > work.y + work.height) {
    const inner = win.getContentBounds()
    content({ ...inner, x: work.x + 20, y: work.y + 40, width: Math.min(inner.width, work.width - 80), height: Math.min(inner.height, work.height - 100) })
  }
  top(false); focusable(false)
  win.on('show', () => lower(win))
  lower(win)
})
