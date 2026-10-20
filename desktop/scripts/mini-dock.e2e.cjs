/** Windows Mini docking: real Electron/native window + simulated adjacent display topology.
 * npm run build && npm run check:minidock. Uses an isolated home and no physical OS input.
 * --baseline records the pre-fix failures; --scale=1.25 exercises fractional display scale. */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mini-dock-'))
const output = path.resolve(process.env.MINI_DOCK_OUTPUT || path.join(temp, 'evidence'))
fs.mkdirSync(output, { recursive: true })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const results = [], baseline = process.argv.includes('--baseline')
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail ?? '') }
const sampleFrames = (mini, duration = 500) => mini.evaluate(async (duration) => {
  const el = document.querySelector('.mini-card-shell'), frames = [], start = performance.now()
  while (performance.now() - start < duration) {
    const r = el.getBoundingClientRect()
    frames.push({ t: performance.now() - start, x: r.x, y: r.y, width: r.width, height: r.height })
    await new Promise(requestAnimationFrame)
  }
  return frames
}, duration)
const positions = (frames) => new Set(frames.map((r) => `${Math.round(r.x)},${Math.round(r.y)}`)).size
// Read the actual Win32 input region, without moving the physical pointer or sending OS input.
function nativeRegion(handle) {
  const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MiniRegion {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr w, IntPtr r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out RECT r);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr r, out RECT b);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r, int x, int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr r);
}
'@
$region = [MiniRegion]::CreateRectRgn(0,0,0,0)
$box = New-Object MiniRegion+RECT
$window = New-Object MiniRegion+RECT
$hwnd = [IntPtr]::new([long]${handle})
$kind = [MiniRegion]::GetWindowRgn($hwnd,$region)
[void][MiniRegion]::GetRgnBox($region,[ref]$box)
[void][MiniRegion]::GetWindowRect($hwnd,[ref]$window)
$centerHits = [MiniRegion]::PtInRegion($region,[int](($window.right-$window.left)/2),[int](($window.bottom-$window.top)/2))
$peekHits = [MiniRegion]::PtInRegion($region,[int](($box.left+$box.right)/2),[int](($box.top+$box.bottom)/2))
@{kind=$kind; centerHits=$centerHits; peekHits=$peekHits; left=$box.left; top=$box.top; right=$box.right; bottom=$box.bottom} | ConvertTo-Json -Compress
[void][MiniRegion]::DeleteObject($region)`
  return JSON.parse(require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim())
}
async function main() {
  const stub = await startStubEngine({ sessions: [{ id: 'mini-dock', title: 'Mini docking', created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', agent_config: { execMode: 'host' } }] })
  const userData = path.join(temp, 'userdata')
  fs.mkdirSync(userData + '-dev', { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'test-only' }))
  let app
  try {
    const scale = process.argv.find((s) => s.startsWith('--scale='))?.split('=')[1]
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ...(scale ? [`--force-device-scale-factor=${scale}`] : []), ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(temp, 'no-helper.sock') } })
    const win = await app.firstWindow()
    await win.waitForSelector('.dv-groupview', { state: 'attached', timeout: 60000 })
    await skipOnboarding(win)
    await win.evaluate(() => window.tangu.openMini({ sessionId: 'mini-dock' }))
    let mini
    for (let i = 0; i < 200; i++) { mini = app.windows().find((w) => w.url().includes('window=mini')); if (mini) break; await pause(50) }
    if (!mini) throw new Error('Mini window missing')
    await mini.waitForSelector('.mini-card-shell .t2c-ta', { timeout: 60000 })
    const errors = []
    mini.on('pageerror', (e) => errors.push(e.message))
    await mini.evaluate(() => { document.body.style.zoom = '1.1'; document.documentElement.style.setProperty('--uiz', '1.1') })
    await pause(500)
    const meta = await app.evaluate(({ screen, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=mini'))
      const primary = screen.getPrimaryDisplay()
      globalThis.__miniProbe = { w, shapes: [], boundsWrites: [], cursor: { x: primary.workArea.x + primary.workArea.width / 2, y: primary.workArea.y + primary.workArea.height / 2 } }
      const probe = globalThis.__miniProbe
      const setShape = w.setShape.bind(w), setBounds = w.setBounds.bind(w), setContent = w.setContentBounds.bind(w)
      w.setShape = (r) => { probe.shapes.push(r); setShape(r) }
      w.setBounds = (...a) => { probe.boundsWrites.push(a); setBounds(...a) }
      w.setContentBounds = (...a) => { probe.boundsWrites.push(a); setContent(...a) }
      screen.getCursorScreenPoint = () => ({ ...probe.cursor })
      // Deterministic horizontal/vertical neighbours, including negative origins, on any CI monitor.
      const area = primary.workArea
      globalThis.__miniProbeArea = area
      const displays = [primary, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, y], i) => ({ ...primary, id: primary.id + i + 100, bounds: { ...area, x: area.x + x * area.width, y: area.y + y * area.height }, workArea: { ...area, x: area.x + x * area.width, y: area.y + y * area.height } }))]
      screen.getAllDisplays = () => displays
      screen.getDisplayMatching = (b) => displays.reduce((best, d) => {
        const overlap = (a) => Math.max(0, Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)) * Math.max(0, Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y))
        return overlap(d.workArea) > overlap(best.workArea) ? d : best
      }, primary)
      const card = w.getContentBounds()
      return { area, cardSize: { width: card.width, height: card.height }, displays: displays.map((d) => ({ id: d.id, area: d.workArea })), platform: process.platform, scaleFactor: primary.scaleFactor, electron: process.versions.electron }
    })
    console.log('PLATFORM', JSON.stringify(meta))
    const corner = async () => app.evaluate(async () => {
      const image = await globalThis.__miniProbe.w.webContents.capturePage()
      const b = image.toBitmap(), { width, height } = image.getSize()
      return { alpha: b[3], center: b[(Math.floor(height / 2) * width + Math.floor(width / 2)) * 4 + 3] }
    })
    await mini.evaluate(() => window.tangu.setWindowMaterial({ material: 'opaque', mode: 'light', backgroundColor: '#f8f7f6' }))
    await pause(150)
    const alpha = await corner()
    check('theme changes preserve transparent rounded corners', alpha.alpha < 32 && alpha.center > 240, alpha)
    await mini.screenshot({ path: path.join(output, 'expanded-light.png'), omitBackground: true })
    let settledSize
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      await app.evaluate((_, edge) => {
        const p = globalThis.__miniProbe, a = globalThis.__miniProbeArea, b = p.w.getContentBounds()
        // The actual display origin is read before getDisplayMatching is replaced.
        const x = edge === 'left' ? a.x + 4 : edge === 'right' ? a.x + a.width - b.width - 4 : a.x + Math.round((a.width - b.width) / 2)
        const y = edge === 'top' ? a.y + 4 : edge === 'bottom' ? a.y + a.height - b.height - 4 : a.y + Math.round((a.height - b.height) / 2)
        p.cursor = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
        p.w.setContentBounds({ ...b, x, y })
      }, edge)
      const closing = await sampleFrames(mini, 700)
      check(`${edge}: collapse has intermediate compositor frames`, positions(closing) > 3, { unique: positions(closing) })
      fs.writeFileSync(path.join(output, `${edge}-collapse-frames.json`), JSON.stringify(closing))
      const tucked = await app.evaluate(() => { const p = globalThis.__miniProbe; return { bounds: p.w.getContentBounds(), shape: p.shapes.at(-1) } })
      const a = meta.area, b = tucked.bounds
      // The first placement may align a fractional native client edge by up to 2 DIP.
      // What regressed was growth on EVERY move: compare subsequent docks to that settled size.
      settledSize ||= { width: b.width, height: b.height }
      check(`${edge}: native moves do not accumulate DPI size rounding`, b.width === settledSize.width && b.height === settledSize.height && Math.abs(b.width - meta.cardSize.width) <= 2 && Math.abs(b.height - meta.cardSize.height) <= 2, b)
      check(`${edge}: native window stays on its owning monitor`, b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height, tucked)
      check(`${edge}: only the peek strip accepts OS input`, tucked.shape?.length === 1 && (['left', 'right'].includes(edge) ? tucked.shape[0].width === 14 : tucked.shape[0].height === 14), tucked.shape)
      if (edge === 'right' && process.platform === 'win32') {
        const handle = await app.evaluate(() => globalThis.__miniProbe.w.getNativeWindowHandle().readBigUInt64LE().toString())
        const region = nativeRegion(handle)
        check('Win32 region passes hidden card input through, keeps the peek interactive', region.kind !== 0 && !region.centerHits && region.peekHits, region)
        await mini.evaluate(() => new Promise((resolve) => { const frame = document.createElement('iframe'); frame.hidden = true; frame.onload = resolve; frame.srcdoc = '<p>Embedded sketch frame</p>'; document.body.appendChild(frame) }))
        await pause(100)
        check('child-frame navigation preserves docking and its native mask', await app.evaluate(() => globalThis.__miniProbe.shapes.at(-1)?.length === 1))
      }
      const visible = await mini.evaluate(() => { const r = document.querySelector('.mini-card-shell').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight } })
      check(`${edge}: peek is 14 DIP at 110% UI zoom`, Math.abs((edge === 'left' ? visible.x + visible.width : edge === 'right' ? visible.vw - visible.x : edge === 'top' ? visible.y + visible.height : visible.vh - visible.y) - 14) <= 1, visible)
      await mini.screenshot({ path: path.join(output, `${edge}-collapsed.png`), omitBackground: true })
      await app.evaluate((_, edge) => { const p = globalThis.__miniProbe, a = globalThis.__miniProbeArea, b = p.w.getContentBounds(); p.cursor = { x: edge === 'left' ? a.x + 7 : edge === 'right' ? a.x + a.width - 7 : b.x + b.width / 2, y: edge === 'top' ? a.y + 7 : edge === 'bottom' ? a.y + a.height - 7 : b.y + b.height / 2 }; p.boundsWrites = [] }, edge)
      const frames = await sampleFrames(mini)
      fs.writeFileSync(path.join(output, `${edge}-expand-frames.json`), JSON.stringify(frames))
      const unique = positions(frames)
      check(`${edge}: expansion has intermediate compositor frames`, unique > 3, { unique, frames: frames.length })
      const expanded = await app.evaluate(() => { const p = globalThis.__miniProbe; return { bounds: p.w.getContentBounds(), writes: p.boundsWrites.length, shape: p.shapes.at(-1) } })
      check(`${edge}: animation does not move or resize the native window each frame`, expanded.writes === 0, expanded)
      const eb = expanded.bounds
      check(`${edge}: expansion returns to the original display edge`, edge === 'left' ? eb.x === a.x : edge === 'right' ? eb.x + eb.width === a.x + a.width : edge === 'top' ? eb.y === a.y : eb.y + eb.height === a.y + a.height, eb)
      await mini.screenshot({ path: path.join(output, `${edge}-expanded.png`), omitBackground: true })
      // A deliberate drag away must cancel docking and release the native input mask.
      await app.evaluate(() => { const p = globalThis.__miniProbe, a = globalThis.__miniProbeArea; p.w.setContentBounds({ ...p.w.getContentBounds(), x: a.x + 50, y: a.y + 50 }) })
      await pause(400)
      check(`${edge}: dragging away restores the full card and native input region`, await mini.evaluate(() => getComputedStyle(document.querySelector('.mini-card-shell')).transform === 'none') && await app.evaluate(() => globalThis.__miniProbe.shapes.at(-1)?.length === 0))
    }
    await mini.emulateMedia({ reducedMotion: 'reduce' })
    await app.evaluate(() => { const p = globalThis.__miniProbe, a = globalThis.__miniProbeArea; p.w.setContentBounds({ ...p.w.getContentBounds(), x: a.x + 4, y: a.y + 100 }) })
    const reduced = await sampleFrames(mini, 700)
    check('reduced motion settles without intermediate animation frames', positions(reduced) <= 2, { unique: positions(reduced) })
    await mini.reload()
    await mini.waitForSelector('.mini-card-shell .t2c-ta', { timeout: 60000 })
    await pause(300)
    check('reload while collapsed restores a visible usable card', await mini.evaluate(() => getComputedStyle(document.querySelector('.mini-card-shell')).transform === 'none') && await app.evaluate(() => globalThis.__miniProbe.shapes.at(-1)?.length === 0))
    await mini.evaluate(() => localStorage.setItem('forsion_theme_pref', 'dark'))
    await mini.reload()
    await mini.waitForSelector('.mini-card-shell .t2c-ta', { timeout: 60000 }); await pause(500)
    const darkAlpha = await corner()
    check('dark theme retains alpha corners', darkAlpha.alpha < 32 && darkAlpha.center > 240, darkAlpha)
    await mini.screenshot({ path: path.join(output, 'expanded-dark.png'), omitBackground: true })
    check('no Mini renderer errors', errors.length === 0, errors)
    fs.writeFileSync(path.join(output, 'platform.json'), JSON.stringify(meta, null, 2))
  } finally { if (app) await app.close().catch(() => {}); await stub.close(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); console.log('EVIDENCE', output) }
  if (!baseline && results.some((r) => !r.ok)) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
