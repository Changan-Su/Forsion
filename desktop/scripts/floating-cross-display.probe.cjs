/**
 * 最小复现:设置浮窗(主窗的子窗)和主窗不在同一块屏时,台架发的第一个按键让 Electron 主进程 SIGSEGV。
 *
 * 要两块屏。10-14 在 Electron 40.10.2 上:只把浮窗挪到另一块屏 → 崩(线程 CrBrowserMain、地址 0x70、出错帧
 * Electron Framework +0x2b4c968);两扇都挪过去、或挪过去再挪回主窗那块屏 → 不崩;按回车还是字母都一样。
 * e2e:computerhistory 原来用 w.center() 摆浮窗,多屏时 center() 会把它摆到另一块屏上,于是 T15 按回车就崩。
 * 按键是 CDP 合成的(playwright press),真键盘会不会也崩没验证 —— 手动:打开设置 → 把浮窗拖到另一块屏 → 在搜索框敲一个字。
 *
 * 用法(占 GUI 锁跑):npm run build && node scripts/floating-cross-display.probe.cjs
 * 退出码:1 = 还会崩;0 = 不崩了(比如升级 Electron 之后);2 = 只有一块屏;3 = 这一轮判不了(键没按上,或同屏的对照组也崩了)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')

async function attempt(crossDisplay) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-xdisplay-'))
  const stub = await startStubEngine()
  const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
  let died = null, keyError = null
  app.process().on('exit', (code, sig) => { died = sig || `exit ${code}` })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40_000 })
    await skipOnboarding(win)
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    const opened = app.waitForEvent('window')
    await win.keyboard.press('Meta+Comma')
    const settings = await opened
    await settings.waitForSelector('.settings-nav-search input', { timeout: 30_000 })
    const displays = await app.evaluate(({ BrowserWindow, screen }, cross) => {
      const float = BrowserWindow.getAllWindows().find((w) => /window=floating/.test(w.webContents.getURL()))
      const home = screen.getDisplayMatching(float.getParentWindow().getBounds()).workArea
      const other = screen.getAllDisplays().map((d) => d.workArea).find((a) => a.x !== home.x || a.y !== home.y)
      if (other && cross) float.setPosition(other.x + 80, other.y + 60)
      return screen.getAllDisplays().length
    }, crossDisplay)
    if (displays < 2) return 'one-display'
    await settings.waitForTimeout(500)
    await settings.locator('.settings-nav-search input').press('a').catch((e) => { keyError = e }) // 崩了的话这一下会抛「页面已关」
    await new Promise((r) => setTimeout(r, 1_500))
    return died || (keyError ? `键没按上:${String(keyError.message).split('\n')[0]}` : 'alive') // 在收尾关窗之前定结果
  } finally {
    if (!died) await app.close().catch(() => {})
    stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}

;(async () => {
  const other = await attempt(true)
  if (other === 'one-display') { console.log('只有一块屏,测不了'); process.exit(2) }
  const same = await attempt(false)
  console.log(`浮窗在另一块屏:${other}  ｜  浮窗在主窗那块屏:${same}`)
  if (same !== 'alive' || other.startsWith('键没按上')) process.exit(3)
  process.exit(other === 'alive' ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(3) })
