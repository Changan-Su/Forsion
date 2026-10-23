/** Isolated real Mini for native Windows acceptance. Quit by creating <home>/stop. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-win-open-'))
  const userData = path.join(home, 'userdata'), vault = path.join(home, 'Vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, 'Windows acceptance.md'), '# Tasks\n\n' + Array.from({ length: 60 }, (_, i) => `- [ ] Windows acceptance task ${i + 1} @2026-10-23`).join('\n'))
  const stub = await startStubEngine()
  for (const d of [userData, userData + '-dev']) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'fixture' }))
  }
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', '--remote-debugging-port=9451', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '0', FORSION_TEST_DESKTOP: '', PI_CU_SOCKET_PATH: path.join(home, 'no-helper.sock') } })
    const win = await app.firstWindow()
    if (!await skipOnboarding(win)) throw new Error('Onboarding did not close')
    await win.locator('.rb-space[aria-label="笔记"]').first().click()
    await win.waitForTimeout(1000)
    await win.evaluate(() => window.tangu.openMini({ spaceId: 'calendar' }))
    let mini
    for (let i = 0; i < 200; i++) { mini = app.windows().find(w => w.url().includes('window=mini')); if (mini) break; await win.waitForTimeout(50) }
    await mini.locator('.mini-todo').waitFor({ timeout: 30000 })
    const runtime = await app.evaluate(({ screen, BrowserWindow }) => {
      const mini = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=mini'))
      const primary = screen.getPrimaryDisplay().workArea
      mini.setContentBounds({ x: primary.x + 300, y: primary.y + 200, width: 360, height: 400 })
      mini.setTitle('Forsion Windows acceptance Mini')
      return { windows: process.getSystemVersion(), displays: screen.getAllDisplays(), mini: mini.getContentBounds(), pid: process.pid }
    })
    fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify(runtime, null, 2))
    await mini.evaluate(() => {
      window.__nativeEvents = []
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click']) document.addEventListener(type, e => {
        if (type !== 'pointermove' || e.buttons) window.__nativeEvents.push({ type, trusted: e.isTrusted, x: e.screenX, y: e.screenY, buttons: e.buttons, target: String(e.target?.className), time: performance.now() })
      }, true)
    })
    console.log('STAGE_HOME ' + home)
    console.log(JSON.stringify(runtime))
    while (!fs.existsSync(path.join(home, 'stop'))) {
      const command = path.join(home, 'command.json')
      if (fs.existsSync(command)) {
        const input = JSON.parse(fs.readFileSync(command, 'utf8')); fs.unlinkSync(command)
        const output = await app.evaluate(({ BrowserWindow, screen }, input) => {
          const mini = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=mini'))
          if (input.bounds) mini.setContentBounds(input.bounds)
          return { bounds: mini.getContentBounds(), displays: screen.getAllDisplays() }
        }, input)
        fs.writeFileSync(path.join(home, 'receipt.json'), JSON.stringify(output, null, 2))
      }
      await new Promise(r => setTimeout(r, 150))
    }
  } finally { await app?.close(); await stub.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
