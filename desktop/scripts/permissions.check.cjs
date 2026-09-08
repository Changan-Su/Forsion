/** Real Electron + real preload/IPC, isolated fake native socket/OS prompts.
 * Never opens System Settings, installs a helper, or changes actual TCC grants.
 * Run after npm run build: npm run check:permissions. Screenshots stay in /tmp.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')

async function main() {
  assert.equal(process.platform, 'darwin', 'This Electron/OS integration check targets macOS')
  assert.ok(fs.existsSync(path.join(ROOT, 'out/main/main.js')), 'Run npm run build first')
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-permissions-'))
  const socketPath = path.join(homeDir, 'helper.sock')
  const helperApp = path.join(homeDir, 'tangu-computer-use.app')
  fs.mkdirSync(path.join(helperApp, 'Contents/MacOS'), { recursive: true })
  fs.writeFileSync(path.join(helperApp, 'Contents/MacOS/bridge'), 'test fixture; never executed')
  const dataDir = path.join(homeDir, 'userdata-dev'), vault = path.join(homeDir, 'vault')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const state = { accessibility: false, screenRecordingPreflight: false, settingsFrontmost: true,
    source: { attribution: 'helper-app', pid: 81 }, settingsWindow: { x: 180, y: 100, width: 570, height: 600 } }
  const calls = []
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      const request = JSON.parse(buffer.split('\n')[0])
      calls.push(request)
      const result = request.cmd === 'checkPermissions'
        ? { ...state, screenRecordingCapturable: state.screenRecordingPreflight }
        : request.cmd === 'permissionStatus' ? state : {}
      socket.end(JSON.stringify({ id: request.id, ok: true, result }) + '\n')
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  const stub = await startStubEngine()
  let running
  let passed = 0
  const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`) }
  try {
    running = await electron.launch({ args: [`--user-data-dir=${path.join(homeDir, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: homeDir, TANGU_BACKEND_URL: stub.url,
        PI_CU_SOCKET_PATH: socketPath, PI_COMPUTER_USE_HELPER_APP_PATH: helperApp }, timeout: 45_000 })
    await running.evaluate(({ shell, systemPreferences, desktopCapturer }) => {
      globalThis.__permissionTestOpens = []
      shell.openExternal = async url => { globalThis.__permissionTestOpens.push(url) }
      systemPreferences.getMediaAccessStatus = () => 'not-determined'
      systemPreferences.askForMediaAccess = async () => { throw new Error('Unexpected native prompt in read-only check') }
      desktopCapturer.getSources = async () => { throw new Error('Unexpected capture in read-only check') }
    })
    const win = await running.firstWindow()
    const errors = []
    win.on('pageerror', error => errors.push(error.message))
    await win.waitForSelector('.ob-shell', { timeout: 40_000 })
    await win.locator('.ob-hero-actions .btn.primary').click()
    for (let step = 0; step < 8; step++) {
      if (await win.locator('.desktop-permissions').count()) break
      await win.locator('.ob-step-actions .btn.primary').click()
    }
    await win.waitForSelector('[data-permission="computerAccessibility"]')
    check('permission step appears in onboarding with five permission rows', await win.locator('[data-permission]').count() === 5)
    check('page entry only calls permissionStatus', calls.length > 0 && calls.every(call => call.cmd === 'permissionStatus'))
    await win.screenshot({ path: '/tmp/forsion-permissions-onboarding-zh.png', animations: 'disabled' })
    const guideOpening = running.waitForEvent('window', { predicate: page => page !== win, timeout: 10_000 })
    await win.locator('[data-permission="computerAccessibility"] button').click()
    const guide = await guideOpening
    await guide.waitForSelector('h1')
    check('selected permission requests only accessibility', calls.some(call => call.cmd === 'registerPermissions' && call.kind === 'accessibility') && !calls.some(call => call.cmd === 'checkPermissions'))
    check('guide shows the helper identity', (await guide.locator('.app strong').textContent()) === 'tangu-computer-use')
    const opens = await running.evaluate(() => globalThis.__permissionTestOpens)
    check('one system pane is opened through the guarded OS boundary', opens.length === 1 && opens[0].endsWith('Privacy_Accessibility'))
    await guide.screenshot({ path: '/tmp/forsion-permissions-guide-zh.png' })
    await guide.locator('a[href$="/verify"]').click()
    await guide.waitForSelector('a[href$="/verify"]')
    check('accessibility verify never probes screen access', !calls.some(call => call.cmd === 'checkPermissions'))
    state.accessibility = true
    await guide.locator('.status.success').waitFor()
    check('guide refreshes after an external grant change', true)
    const before = await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('data:text/html'))?.getBounds())
    state.settingsWindow.x += 50
    await guide.waitForTimeout(1100)
    const after = await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('data:text/html'))?.getBounds())
    check('guide follows changed settings window bounds', before && after && before.x !== after.x)
    const guideClosing = guide.waitForEvent('close')
    await guide.locator('a[href$="/return"]').click()
    await guideClosing
    await win.locator('.ob-step-actions button').filter({ hasText: '稍后设置' }).click()
    check('Set up later advances without requiring grants', await win.locator('.desktop-permissions').count() === 0)
    await win.locator('.ob-step-actions button').filter({ hasText: '跳过' }).click()
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.keyboard.press('Meta+,')
    await win.locator('.settings-nav-list button').filter({ hasText: '设备权限' }).click()
    await win.waitForSelector('.desktop-permissions')
    check('settings keeps a permanent permissions entry', await win.locator('[data-permission]').count() === 5)
    await win.screenshot({ path: '/tmp/forsion-permissions-settings-zh.png', animations: 'disabled' })
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_theme_pref', 'dark'); localStorage.setItem('forsion_tangu_onboarding_done', '1') })
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.keyboard.press('Meta+,')
    await win.locator('.settings-nav-list button').filter({ hasText: 'Device permissions' }).click()
    await win.waitForSelector('.desktop-permissions')
    await win.screenshot({ path: '/tmp/forsion-permissions-settings-en-dark.png', animations: 'disabled' })
    check('English permissions text contains no untranslated Chinese', !/[\u3400-\u9fff]/.test(await win.locator('.desktop-permissions').innerText()))
    const overflow = await win.locator('.desktop-permissions').evaluate(el => el.scrollWidth > el.clientWidth + 1)
    check('permissions content has no horizontal overflow', !overflow)
    check('no renderer exceptions', errors.length === 0)
    console.log(`${passed} checks passed. Native TCC grant toggles are deliberately not exercised.`)
  } catch (error) {
    if (running) for (const [index, page] of running.windows().entries()) await page.screenshot({ path: `/tmp/forsion-permissions-failure-${index}.png` }).catch(() => {})
    throw error
  } finally {
    if (running) await running.close().catch(() => {})
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await stub.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
