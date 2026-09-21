/** Real Electron contract for the sixth panel surface: native window behavior + rendered settings. */
const fs = require('fs'), os = require('os'), path = require('path')
const { spawn } = require('child_process')
const { _electron: electron, chromium } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-floating-panel-'))
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`) }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const WEB_ORIGIN = 'http://127.0.0.1:5199'

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(cache).filter((dir) => dir.startsWith('chromium-')).sort().reverse()
  for (const dir of dirs) for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
    const candidate = path.join(cache, dir, 'chrome-mac-arm64', app)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('Chromium not found; set CHROMIUM_EXE')
}

async function checkWeb() {
  const vite = spawn('npx', ['vite', 'frontend', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
  let browser
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(WEB_ORIGIN)).ok) break } catch { /* starting */ }
      await pause(100)
    }
    browser = await chromium.launch({ executablePath: findChromium(), headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-GB' })
    await page.goto(WEB_ORIGIN, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      const { useApp } = await import('/src/stores/appStore.ts')
      useApp.getState().setOnboarding(false)
      useApp.getState().openSettings('general')
    })
    await page.locator('.floating-panel-window .settings-page').waitFor({ timeout: 15000 })
    await page.waitForTimeout(500)
    await page.evaluate(() => document.getAnimations().forEach((animation) => {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish()
    }))
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('.floating-panel-window').getBoundingClientRect()
      const shell = document.querySelector('.shell-host')
      return { left: panel.left, right: innerWidth - panel.right, width: panel.width,
        shellVisible: getComputedStyle(shell).visibility !== 'hidden', appRegion: getComputedStyle(document.querySelector('.floating-panel-layer')).webkitAppRegion }
    })
    check('Web uses a centered non-fullscreen Floating panel', geometry.left > 20 && geometry.right > 20 && geometry.width < 1200, JSON.stringify(geometry))
    check('Web keeps the main workspace visible and panel non-draggable', geometry.shellVisible && geometry.appRegion === 'no-drag')
    const shot = path.join(temp, 'floating-settings-web.png')
    await page.screenshot({ path: shot })
    console.log(`WEB_SCREENSHOT ${shot}`)
  } finally {
    if (browser) await browser.close()
    vite.kill('SIGTERM')
  }
}

async function main() {
  const userData = path.join(temp, 'userdata')
  fs.mkdirSync(userData + '-dev', { recursive: true })
  const stub = await startStubEngine({ sessions: [] })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'floating-test-token' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=en-GB', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    const main = await app.firstWindow()
    await main.waitForSelector('.shell-host', { timeout: 30000, state: 'attached' })
    for (const name of ['Skip', '跳过引导']) { const button = main.getByRole('button', { name, exact: true }); if (await button.count()) { await button.click(); break } }
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'about' } }))
    let floating
    for (let i = 0; i < 120; i++) {
      floating = app.windows().find((page) => page.url().includes('window=floating'))
      if (floating) break
      await pause(50)
    }
    if (!floating) throw new Error('Floating window missing')
    await floating.waitForSelector('.floating-native-root .settings-page', { timeout: 30000 })
    check('Floating window never mounts the Forsion startup splash', await floating.locator('#tangu-splash').count() === 0)
    await floating.waitForTimeout(300)
    check('settings renders in a dedicated Floating window', app.windows().filter((page) => page.url().includes('window=floating')).length === 1)
    const native = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('window=floating'))
      return { minimizable: win.isMinimizable(), closable: win.isClosable(), resizable: win.isResizable(), parent: !!win.getParentWindow() }
    })
    check('native window is movable-family, minimizable, closable and resizable', native.minimizable && native.closable && native.resizable && native.parent, JSON.stringify(native))
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'plugins' } }))
    await pause(300)
    check('opening the same panel id reuses its native window', app.windows().filter((page) => page.url().includes('window=floating')).length === 1)
    const shot = path.join(temp, 'floating-settings.png')
    await floating.screenshot({ path: shot })
    check('panel has no viewport overflow', await floating.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth && document.documentElement.scrollHeight === document.documentElement.clientHeight))
    console.log(`SCREENSHOT ${shot}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
  await checkWeb()
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok)) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
