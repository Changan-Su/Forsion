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

// 设置自 2026-09-20 住在独立浮窗里(Floating Panel):UI 断言一律打在浮窗 page 上,getConfig / backendStatus 仍走主窗。
// 每次重开都带一个新 params(SettingsModal 按 params 作 key 重挂),再 reload 一次让浮窗读到最新 tangu_locale / 主题。
async function openSettingsWin(app, win) {
  await win.evaluate((n) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'connection', n } }), Date.now())
  let sw
  await poll(async () => { sw = app.windows().find((w) => w.url().includes('window=floating')); return !!sw }, 'settings floating window')
  await sw.reload({ waitUntil: 'domcontentloaded' })
  await sw.locator('.settings-page').waitFor({ timeout: 30_000 })
  return sw
}

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, '../tangu-agent/dist/standalone/main.js')), 'Build tangu-agent first; a missing backend is not a passing runtime test')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-host-sandbox-ui-'))
  const userdata = path.join(home, 'userdata'), vault = path.join(home, 'vault')
  fs.mkdirSync(userdata); fs.mkdirSync(vault)
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }))
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ workspace: vault }))
  const stub = await startStubEngine()
  // 落盘的外部连接(A-1):托管切外部时表单必须从这份填,而不是托管后端的临时地址 / 令牌。
  // backendUrl / token 是 shell 键(userData 的 tangu-desktop-config.json);dev 下 userData 可能带 -dev 后缀,两处都写。
  const EXT = { backendUrl: stub.url, token: 'ext-seed-token' }
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify(EXT))
  }
  let app, sw
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
    sw = await openSettingsWin(app, win)
    // 09-25 起卡片默认收起、点卡只改草稿(U-01):先展开,真正切换走吸底栏「切换到托管并启动」。
    const modeToggle = sw.locator('.settings-mode-panel [data-action="mode-change"]')
    if (await modeToggle.count()) await modeToggle.click()
    await sw.locator('.settings-choice-card').filter({ hasText: '托管' }).click()
    let panel = sw.getByTestId('host-sandbox-settings')
    await panel.waitFor()
    assert.equal(await sw.locator('#host-sandbox-mode').inputValue(), 'off')
    assert.equal(await sw.locator('#host-sandbox-network').isDisabled(), true)
    await sw.locator('#host-sandbox-mode').selectOption('workspace-write')
    assert.equal(await sw.locator('#host-sandbox-network').inputValue(), 'deny')
    assert.match(await panel.innerText(), /MCP/)
    await sw.locator('.settings-runtime-panel button').filter({ hasText: /保存并重启|切换到托管并启动/ }).click()
    await waitPolicy(win, home, { mode: 'workspace-write', network: 'deny' })
    await waitReady(win)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).hostSandbox,
      { mode: 'workspace-write', network: 'deny' })
    await panel.scrollIntoViewIfNeeded()
    await sw.screenshot({ path: '/tmp/forsion-host-sandbox-zh.png', animations: 'disabled' })
    await win.evaluate(() => {
      localStorage.setItem('tangu_locale', 'en')
      localStorage.setItem('forsion_theme_pref', 'dark')
    })
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })
    sw = await openSettingsWin(app, win); panel = sw.getByTestId('host-sandbox-settings')
    await panel.waitFor()
    assert.equal(await sw.locator('#host-sandbox-mode').inputValue(), 'workspace-write')
    assert.equal(/[\u3400-\u9fff]/.test(await panel.innerText()), false)
    assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1), false)
    await sw.locator('#host-sandbox-mode').selectOption('read-only')
    await sw.locator('#host-sandbox-network').selectOption('allow')
    // A real backend restart changes p.cfg/its port and triggers a settings refresh.
    // Unsaved policy must survive this refresh and still be the value actually saved.
    await win.evaluate(() => window.tangu.backendRestart())
    await waitReady(win)
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(await sw.locator('#host-sandbox-mode').inputValue(), 'read-only', 'backend refresh must preserve the mode draft')
    assert.equal(await sw.locator('#host-sandbox-network').inputValue(), 'allow', 'backend refresh must preserve the network draft')
    await sw.locator('.settings-runtime-panel button').filter({ hasText: 'Save & restart' }).click()
    await waitPolicy(win, home, { mode: 'read-only', network: 'allow' })
    await waitReady(win)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).hostSandbox,
      { mode: 'read-only', network: 'allow' })
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })
    sw = await openSettingsWin(app, win); panel = sw.getByTestId('host-sandbox-settings')
    await panel.waitFor()
    assert.equal(await sw.locator('#host-sandbox-mode').inputValue(), 'read-only')
    assert.equal(await sw.locator('#host-sandbox-network').inputValue(), 'allow')
    await panel.scrollIntoViewIfNeeded()
    await sw.screenshot({ path: '/tmp/forsion-host-sandbox-en-dark.png', animations: 'disabled' })

    // U-01 反方向:托管 → 外部。点「外部连接」卡只改草稿(不停内置后端);显式「切换到外部连接并重连」才落 mode 并停后端。
    await waitReady(win)
    await sw.locator('.settings-mode-panel [data-action="mode-change"]').click()
    await sw.locator('.settings-mode-panel .settings-choice-card[role="radio"]').nth(1).click()
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal((await win.evaluate(() => window.tangu.getConfig())).mode, 'managed', 'clicking the external card must not persist mode')
    assert.equal((await win.evaluate(() => window.tangu.backendStatus())).state, 'ready', 'clicking the external card must not stop the managed backend')
    const ext = sw.locator('.settings-external-panel')
    // A-1(Codex 第一轮):不动表单直接切 —— 表单必须是落盘的外部连接,不是托管后端的临时地址 / 令牌。
    const managedUrl = (await win.evaluate(() => window.tangu.getConfig())).backendUrl
    assert.notEqual(managedUrl, EXT.backendUrl, 'precondition: the managed backend runs on its own address')
    assert.equal(await ext.locator('input[type="text"]').inputValue(), EXT.backendUrl, 'external form shows the persisted external URL, not the managed one')
    assert.equal(await ext.locator('input[type="password"]').inputValue(), EXT.token, 'external form shows the persisted external token, not the managed one')
    await ext.locator('button.btn.primary').filter({ hasText: 'Switch to external and reconnect' }).click()
    await poll(async () => (await win.evaluate(() => window.tangu.getConfig())).mode === 'external', 'explicit switch persists mode=external')
    await poll(async () => (await win.evaluate(() => window.tangu.backendStatus())).state !== 'ready', 'managed backend stops after switching to external')
    await new Promise(resolve => setTimeout(resolve, 600))
    const afterSwitch = await win.evaluate(() => window.tangu.getConfig())
    assert.equal(afterSwitch.backendUrl, EXT.backendUrl, 'switching without editing keeps the persisted external URL')
    assert.equal(afterSwitch.token, EXT.token, 'switching without editing keeps the persisted external token (managed token not written)')
    assert.equal(await sw.locator('.settings-mode-panel .settings-choice-card').count(), 0, 'mode cards collapse after the explicit switch')
    console.log('PASS real settings: legacy default, mode/network controls, disk persistence, managed backend restart preserves drafts, reload, bilingual text and layout, explicit managed→external switch keeps the persisted external connection')
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
