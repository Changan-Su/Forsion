/** Real Electron + managed engine. Only update announcements, task inventory and native dialog choices are scripted.
 * Final app exit/relaunch is intercepted so the test never launches an untracked process; backend shutdown is real.
 */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'outputs', 'restart-update')
const lang = process.argv.includes('--en') ? 'en' : 'zh'
const labels = lang === 'en' ? { restart: 'Restart to update', settings: 'Settings', later: 'Restart later', force: 'Force quit and update' } : { restart: '重启更新', settings: '设置', later: '稍后重启', force: '强制退出并更新' }
async function until(check, description) {
  const deadline = Date.now() + 45000
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
async function scenario(idle) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-restart-update-'))
  const userData = path.join(home, 'userdata')
  // Development main.ts appends -dev to Electron's userData path.
  fs.mkdirSync(`${userData}-dev`)
  fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', unitHostEnabled: false }))
  const env = { ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: 'http://127.0.0.1:1' }; delete env.TANGU_BACKEND_URL
  let app, win
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, `--lang=${lang === 'zh' ? 'zh-CN' : 'en-US'}`, ROOT], cwd: ROOT, env, timeout: 60000 })
    win = await app.firstWindow(); win.setDefaultTimeout(15000)
    await win.waitForSelector('#root'); await win.waitForTimeout(1500)
    for (const label of ['跳过引导', 'Skip onboarding', 'Skip']) {
      const b = win.getByRole('button', { name: label, exact: true }); if (await b.count()) await b.click()
    }
    await win.waitForSelector('.rb', { timeout: 45000 })
    await until(async () => (await win.evaluate(() => window.tangu.backendStatus())).state === 'ready', 'managed engine ready')
    await win.evaluate(() => document.fonts.ready)
    await win.waitForTimeout(500) // Let the onboarding exit transition finish before recording the UI.
    assert.equal(await win.locator('[data-restart-update]').count(), 0)
    await app.evaluate(({ app, dialog }) => {
      const originalFetch = globalThis.fetch, originalQuit = app.quit.bind(app), originalRelaunch = app.relaunch.bind(app), originalDialog = dialog.showMessageBox
      const state = globalThis.__restartTest = { activity: { tasks: 2, processes: 1 }, response: 0, dialogs: [], quit: 0, relaunch: 0, reads: 0, originalFetch, originalQuit, originalRelaunch, originalDialog }
      globalThis.fetch = (input, init) => {
        if (String(input).endsWith('/agent/remote/restart-status')) { state.reads++; return Promise.resolve(new Response(JSON.stringify(state.activity), { status: state.activity === null ? 503 : 200 })) }
        return originalFetch(input, init)
      }
      dialog.showMessageBox = async (_win, options) => { state.dialogs.push(options); return { response: state.response, checkboxChecked: false } }
      app.relaunch = () => { state.relaunch++ }; app.quit = () => { state.quit++ }
    })
    const announce = (phase = 'staged', checking = false) => app.evaluate(({ BrowserWindow }, args) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('updater:core-status', {
        checking: args.checking, items: [{ id: 'forsion-extend', packageName: '@forsion/extend', installedVersion: '0.7.0', pendingVersion: '0.7.1', phase: args.phase }],
      })
    }, { phase, checking })
    await announce(); const button = win.locator('[data-restart-update]'); await button.waitFor()
    await win.locator('.ntf').filter({ hasText: 'Forsion Extend 0.7.1' }).waitFor()
    const geometry = await win.evaluate((settingsLabel) => {
      const restart = document.querySelector('[data-restart-update]').getBoundingClientRect()
      const account = document.querySelector('.rb-pinned .account-card, .rb-pinned .ribbon-account')
      const settings = [...document.querySelectorAll('.rb button')].find((b) => b.getAttribute('aria-label') === settingsLabel)
      return { restart: { y: restart.y, bottom: restart.bottom }, accountY: account?.getBoundingClientRect().y, settingsBottom: settings?.getBoundingClientRect().bottom }
    }, labels.settings)
    assert.ok(geometry.restart.y >= geometry.settingsBottom, JSON.stringify(geometry))
    assert.ok(geometry.restart.bottom <= geometry.accountY, JSON.stringify(geometry))
    if (idle) {
      await app.evaluate(() => { globalThis.__restartTest.activity = { tasks: 0, processes: 0 } })
      await button.click()
      await until(() => app.evaluate(() => globalThis.__restartTest.quit === 1), 'idle restart requested')
      assert.equal((await win.evaluate(() => window.tangu.backendStatus())).state, 'stopped')
      assert.deepEqual(await app.evaluate(() => ({ dialogs: globalThis.__restartTest.dialogs.length, quit: globalThis.__restartTest.quit, relaunch: globalThis.__restartTest.relaunch })), { dialogs: 0, quit: 1, relaunch: 1 })
      console.log(`PASS ${lang}: idle restart reaches real backend shutdown without a confirmation`)
      return
    }
    await win.screenshot({ path: path.join(OUT, `${lang}-compact-light.png`), animations: 'disabled' })
    await win.locator('.rb-toggle').click(); await win.locator('.rb-expanded').waitFor()
    await win.waitForTimeout(350) // Ribbon width transitions while its expanded contents mount.
    await win.screenshot({ path: path.join(OUT, `${lang}-expanded-light.png`), animations: 'disabled' })
    await announce('checking', true); await announce('error', false)
    assert.equal(await win.locator('.ntf').filter({ hasText: 'Forsion Extend 0.7.1' }).count(), 1)
    assert.equal((await win.evaluate(() => window.tangu.backendStatus())).state, 'ready')
    await button.click()
    await win.waitForTimeout(150)
    const first = await app.evaluate(() => globalThis.__restartTest.dialogs[0])
    assert.deepEqual(first.buttons, [labels.later, labels.force]); assert.equal(first.defaultId, 0); assert.equal(first.cancelId, 0)
    assert.match(first.detail, /2/); assert.match(first.detail, /1/)
    assert.equal(await app.evaluate(() => globalThis.__restartTest.quit), 0)
    assert.equal((await win.evaluate(() => window.tangu.backendStatus())).state, 'ready')
    // The existing core settings action routes through the same task check.
    await win.evaluate(() => window.tangu.relaunchApp())
    assert.equal(await app.evaluate(() => globalThis.__restartTest.dialogs.length), 2)
    await app.evaluate(() => { globalThis.__restartTest.activity = null })
    await button.click()
    assert.match(await app.evaluate(() => globalThis.__restartTest.dialogs[2].message), /状态|status/)
    assert.equal(await app.evaluate(() => globalThis.__restartTest.quit), 0)
    await win.getByRole('button', { name: lang === 'en' ? 'Toggle light/dark mode' : '切换明暗模式', exact: true }).click()
    await win.waitForFunction(() => document.documentElement.dataset.mode === 'dark')
    await win.waitForTimeout(350)
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(640, 540); w.setSize(760, 640) })
    await win.screenshot({ path: path.join(OUT, `${lang}-expanded-dark-narrow.png`), animations: 'disabled' })
    const rect = await button.boundingBox(); const size = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    assert.ok(rect.y >= 0 && rect.y + rect.height <= size.h && rect.x + rect.width <= size.w)
    await app.evaluate(() => { globalThis.__restartTest.activity = { tasks: 1, processes: 0 }; globalThis.__restartTest.response = 1 })
    await button.click()
    await until(() => app.evaluate(() => globalThis.__restartTest.quit === 1), 'forced restart requested')
    assert.equal((await win.evaluate(() => window.tangu.backendStatus())).state, 'stopped')
    assert.deepEqual(await app.evaluate(() => ({ quit: globalThis.__restartTest.quit, relaunch: globalThis.__restartTest.relaunch, dialogs: globalThis.__restartTest.dialogs.length })), { quit: 1, relaunch: 1, dialogs: 4 })
    fs.writeFileSync(path.join(OUT, `${lang}-dialogs.json`), JSON.stringify(await app.evaluate(() => globalThis.__restartTest.dialogs), null, 2))
    console.log(`PASS ${lang}: pinned location, notification dedupe, busy/later, unknown/later, force restart, real backend shutdown and light/dark/narrow layouts`)
  } catch (error) {
    if (win) console.log('Backend status:', await win.evaluate(() => window.tangu.backendStatus()).catch(() => null))
    if (win) await win.screenshot({ path: path.join(OUT, `${lang}-failure.png`) }).catch(() => {})
    throw error
  } finally {
    if (app) {
      await app.evaluate(({ app, dialog }) => {
        const s = globalThis.__restartTest
        if (s) { app.quit = s.originalQuit; app.relaunch = s.originalRelaunch; dialog.showMessageBox = s.originalDialog; globalThis.fetch = s.originalFetch }
      }).catch(() => {})
      await app.close()
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
}
;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  assert.ok(fs.existsSync(path.join(ROOT, 'out/main/main.js')), 'Run npm run build first')
  await scenario(false); await scenario(true)
})().catch((e) => { console.error(e); process.exitCode = 1 })
