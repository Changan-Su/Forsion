/** Real settings, preload and config persistence; isolated userData/home and no model calls.
 * Build both ../tangu-agent and desktop first, then run: node scripts/host-sandbox.check.cjs. Screenshots go to /tmp.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')

// Playwright waitForFunction treats an async predicate's Promise as truthy in this
// installed version. Await IPC in Node and poll the resolved value explicitly.
async function poll(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 75))
  }
  throw new Error(`Timed out: ${label}`)
}
async function waitPolicy(win, home, expected) {
  let matchedAt = 0
  await poll(async () => {
    const actual = await win.evaluate(async () => (await window.tangu.getConfig()).hostSandbox)
    const disk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).hostSandbox
    if (JSON.stringify(actual) !== JSON.stringify(expected) || JSON.stringify(disk) !== JSON.stringify(expected)) {
      matchedAt = 0
      return false
    }
    matchedAt ||= Date.now()
    return Date.now() - matchedAt >= 300
  }, `IPC and disk preserve ${JSON.stringify(expected)}`)
}
async function waitReady(win) {
  let readyAt = 0
  await poll(async () => {
    if ((await win.evaluate(() => window.tangu.backendStatus())).state !== 'ready') { readyAt = 0; return false }
    readyAt ||= Date.now()
    return Date.now() - readyAt >= 400
  }, 'managed backend stably ready')
}

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, '../tangu-agent/dist/standalone/main.js')), 'Build tangu-agent first; a missing backend is not a passing runtime test')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-host-sandbox-ui-'))
  const userdata = path.join(home, 'userdata'), vault = path.join(home, 'vault')
  fs.mkdirSync(userdata); fs.mkdirSync(vault)
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }))
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ workspace: vault }))
  const stub = await startStubEngine()
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const win = await app.firstWindow()
    await win.waitForSelector('#root')
    await win.evaluate(() => {
      localStorage.setItem('forsion_tangu_onboarding_done', '1')
      localStorage.setItem('tangu_locale', 'zh')
    })
    await win.reload()
    const skip = win.getByText('跳过引导', { exact: true })
    await skip.waitFor({ timeout: 30_000 })
    await skip.click()
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })
    await win.keyboard.press('Meta+,')
    await win.locator('.settings-page').waitFor()
    await win.locator('.settings-choice-card').filter({ hasText: '托管' }).click()
    const panel = win.getByTestId('host-sandbox-settings')
    await panel.waitFor()
    assert.equal(await win.locator('#host-sandbox-mode').inputValue(), 'off')
    assert.equal(await win.locator('#host-sandbox-network').isDisabled(), true)
    await win.locator('#host-sandbox-mode').selectOption('workspace-write')
    assert.equal(await win.locator('#host-sandbox-network').inputValue(), 'deny')
    assert.match(await panel.innerText(), /MCP/)
    await win.locator('.settings-runtime-panel button').filter({ hasText: '保存并重启' }).click()
    await waitPolicy(win, home, { mode: 'workspace-write', network: 'deny' })
    await waitReady(win)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).hostSandbox,
      { mode: 'workspace-write', network: 'deny' })
    await panel.scrollIntoViewIfNeeded()
    await win.screenshot({ path: '/tmp/forsion-host-sandbox-zh.png', animations: 'disabled' })
    await win.evaluate(() => {
      localStorage.setItem('tangu_locale', 'en')
      localStorage.setItem('forsion_theme_pref', 'dark')
    })
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })
    await win.keyboard.press('Meta+,')
    await panel.waitFor()
    assert.equal(await win.locator('#host-sandbox-mode').inputValue(), 'workspace-write')
    assert.equal(/[\u3400-\u9fff]/.test(await panel.innerText()), false)
    assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
    await win.locator('#host-sandbox-mode').selectOption('read-only')
    await win.locator('#host-sandbox-network').selectOption('allow')
    // A real backend restart changes p.cfg/its port and triggers a settings refresh.
    // Unsaved policy must survive this refresh and still be the value actually saved.
    await win.evaluate(() => window.tangu.backendRestart())
    await waitReady(win)
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(await win.locator('#host-sandbox-mode').inputValue(), 'read-only', 'backend refresh must preserve the mode draft')
    assert.equal(await win.locator('#host-sandbox-network').inputValue(), 'allow', 'backend refresh must preserve the network draft')
    await win.locator('.settings-runtime-panel button').filter({ hasText: 'Save & restart' }).click()
    await waitPolicy(win, home, { mode: 'read-only', network: 'allow' })
    await waitReady(win)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).hostSandbox,
      { mode: 'read-only', network: 'allow' })
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })
    await win.keyboard.press('Meta+,')
    await panel.waitFor()
    assert.equal(await win.locator('#host-sandbox-mode').inputValue(), 'read-only')
    assert.equal(await win.locator('#host-sandbox-network').inputValue(), 'allow')
    await panel.scrollIntoViewIfNeeded()
    await win.screenshot({ path: '/tmp/forsion-host-sandbox-en-dark.png', animations: 'disabled' })
    console.log('PASS real settings: legacy default, mode/network controls, disk persistence, managed backend restart preserves drafts, reload, bilingual text and layout')
  } catch (error) {
    if (app) await (await app.firstWindow()).screenshot({ path: '/tmp/forsion-host-sandbox-failure.png' }).catch(() => {})
    throw error
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
