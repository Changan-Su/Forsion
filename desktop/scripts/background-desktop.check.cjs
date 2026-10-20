/** Validate the opt-in background desk before running real app probes on a busy Windows desktop. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { execFileSync } = require('node:child_process')
const electron = require('./lib/launch-electron.cjs')
async function main() {
  if (process.platform !== 'win32' || process.env.FORSION_TEST_DESKTOP !== 'left') throw new Error('Requires Windows and FORSION_TEST_DESKTOP=left')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-background-'))
  const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'ud')}`, path.join(__dirname, 'fixtures/windows-contracts-main.cjs')], env: { ...process.env, TANGU_HOME: home } })
  try {
    await app.firstWindow()
    const info = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const area = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x)[0].workArea
      w.show(); w.focus(); w.setAlwaysOnTop(true); w.setFocusable(true)
      const other = screen.getAllDisplays().find(d => d.workArea.x !== area.x) || screen.getPrimaryDisplay()
      w.setPosition(other.workArea.x + 100, 100)
      const moved = w.getBounds()
      w.setContentBounds({ x: 100, y: 100, width: 500, height: 300 })
      const resized = w.getBounds()
      const handle = w.getNativeWindowHandle()
      return { area, moved, resized, hwnd: (handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE()).toString(), pid: process.pid, top: w.isAlwaysOnTop(), focusable: w.isFocusable(), focused: w.isFocused() }
    })
    const inside = b => b.x >= info.area.x - 2 && b.x + b.width <= info.area.x + info.area.width + 2 && b.y >= info.area.y - 2 && b.y + b.height <= info.area.y + info.area.height + 2
    assert.ok(inside(info.moved) && inside(info.resized), JSON.stringify(info))
    console.log('PASS position and resize stay on the leftmost real display')
    assert.ok(!info.top && !info.focusable && !info.focused)
    console.log('PASS explicit focus, focusable and topmost requests remain disabled')
    // Read native Z order and foreground owner, without reading other window titles or injecting input.
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ProbeDesk { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c); }'; $p=0; $f=[ProbeDesk]::GetForegroundWindow(); [void][ProbeDesk]::GetWindowThreadProcessId($f,[ref]$p); $h=$f; $below=$false; for($i=0;$i -lt 1000 -and $h -ne [IntPtr]::Zero;$i++){ if($h.ToInt64() -eq ${info.hwnd}){$below=$true;break}; $h=[ProbeDesk]::GetWindow($h,2) }; @{foregroundIsProbe=($p -eq ${info.pid}); belowForeground=$below} | ConvertTo-Json -Compress`
    const native = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 }))
    assert.ok(!native.foregroundIsProbe && native.belowForeground, JSON.stringify(native))
    console.log('PASS native foreground is untouched and test window is below it')
    const sizes = await app.evaluate(async ({ BrowserWindow, screen }) => {
      const sizes = []
      for (let i = 0; i < 3; i++) {
        const work = screen.getPrimaryDisplay().workArea
        const w = new BrowserWindow({ x: work.x + 100, y: work.y + 40, width: 380, height: 300, frame: false, transparent: true, show: false })
        w.showInactive()
        await new Promise(r => setTimeout(r, 150))
        sizes.push({ ...w.getContentBounds(), contentSize: w.getContentSize() })
        w.destroy()
      }
      return sizes
    })
    assert.ok(sizes.every(b => b.width === 380 && b.height === 300), JSON.stringify(sizes))
    console.log('PASS repeated transparent windows preserve content size on the selected real display')
    console.log('4/4 passed')
  } finally { await app.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
