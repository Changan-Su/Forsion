/** Real Electron + production memory routes/repository + isolated SQLite/home.
 * Only unrelated engine endpoints and provider completions are scripted.
 * Run after building tangu-agent and desktop: node scripts/agent-memory.check.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const express = require('express')
const ROOT = path.resolve(__dirname, '..')
const ENGINE = path.resolve(ROOT, '../tangu-agent/dist')
const load = (name) => import(pathToFileURL(path.join(ENGINE, name)).href)
const checks = []
function check(name, ok) { assert.ok(ok, name); checks.push(name); console.log(`PASS ${name}`) }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-memory-electron-'))
  process.env.TANGU_HOME = home
  const userData = path.join(home, 'userdata')
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed' }))
  }
  const [{ configureTangu }, { createTanguProfile }, { createSqliteHost }, { STANDALONE_SCHEMA }, { toSqliteDDL },
    { createLocalMemoryBrain }, registry, { createMemoryRepository }, { configureMemoryDream }, { default: agentsRouter }, { default: dreamRouter }] = await Promise.all([
    load('seams/runtime.js'), load('profiles/index.js'), load('adapters/standalone/sqliteHost.js'), load('db/schemaStandalone.js'), load('core/dialectDDL.js'),
    load('adapters/standalone/localMemoryBrain.js'), load('agents/agentRegistry.js'), load('services/memoryRepository.js'), load('services/memoryDream.js'),
    load('routes/agents.js'), load('routes/memoryMaintenance.js'),
  ])
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'e2e', userId: 'memory-instrument' })
  db.exec(toSqliteDDL(STANDALONE_SCHEMA))
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: { calculateCost: async () => 0, logApiUsage: async () => {} }, brain: {
    memory: createLocalMemoryBrain(), llm: {
      resolveModelAndKey: async () => ({ model: { name: 'Instrument', provider: 'instrument' }, apiKey: 'fake', baseUrl: '', apiModelId: 'instrument' }),
      buildProviderPayload: async (payload) => payload,
      streamProviderCompletion: async ({ payload }) => ({ content: JSON.stringify(payload.messages[0].content.startsWith('Consolidate')
        ? { groups: JSON.parse(payload.messages[1].content).map((s) => ({ fact: s.fact, sourceIds: [s.id] })), discarded: [] }
        : { ok: true }), toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }, users: { getUserById: async () => ({ id: 'memory-instrument' }) },
  } })
  for (const slug of ['alpha', 'beta']) {
    await registry.saveAgent({ slug, name: `Memory ${slug}`, description: 'Isolated memory instrument', systemPrompt: 'Test agent', createdBy: 'user' })
    configureMemoryDream(slug, { modelId: 'instrument' })
  }
  const alpha = createMemoryRepository(path.join(home, 'agents/alpha'))
  const beta = createMemoryRepository(path.join(home, 'agents/beta'))
  alpha.add('Alpha 私有事实：偏好简洁中文。')
  beta.add('Beta 私有事实：工程代号 BLUE-SILK。')
  const initialAlpha = alpha.snapshot()
  const initialBeta = beta.snapshot()
  const stub = await startStubEngine()
  const backend = express()
  backend.use(express.json())
  backend.use((req, _res, next) => { req.headers.authorization = 'Bearer e2e'; next() })
  backend.use(agentsRouter)
  backend.use(dreamRouter)
  backend.use(async (req, res) => {
    try {
      const response = await fetch(`${stub.url}${req.originalUrl}`, { method: req.method,
        headers: { 'content-type': 'application/json' }, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: JSON.stringify(req.body || {}) }) })
      res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(Buffer.from(await response.arrayBuffer()))
    } catch (e) { res.status(500).json({ detail: e.message }) }
  })
  const server = await new Promise((resolve) => { const s = backend.listen(0, '127.0.0.1', () => resolve(s)) })
  const url = `http://127.0.0.1:${server.address().port}`
  for (const dir of [userData, `${userData}-dev`]) fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: url, token: 'e2e' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: url } })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 960))
    await win.waitForSelector('#root')
    await win.waitForTimeout(1600)
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.getByRole('button', { name: label, exact: true }).first()
      if (await button.isVisible().catch(() => false)) { await button.click(); break }
    }
    await win.locator('.ob-hero-skip').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    await win.keyboard.press('Meta+,')
    await win.waitForTimeout(500)
    const agentsNav = win.getByRole('button', { name: '智能体', exact: true }).first()
    await agentsNav.click({ timeout: 15000 })
    const openAgent = async (slug) => {
      const row = win.locator('.file-row').filter({ has: win.locator('b', { hasText: `Memory ${slug}` }) }).first()
      await row.locator('button').filter({ has: win.locator('svg.lucide-book-open') }).click()
      const panel = win.locator('[data-testid="agent-memory-panel"]')
      await panel.waitFor()
      await win.waitForTimeout(220)
      return panel
    }
    let panel = await openAgent('alpha')
    await panel.getByText('Alpha 私有事实：偏好简洁中文。', { exact: false }).first().waitFor()
    check('Alpha panel excludes Beta facts', !(await panel.textContent()).includes('BLUE-SILK'))
    await panel.screenshot({ path: path.join(home, 'memory-light.png') })
    fs.writeFileSync(path.join(home, 'panel-text.txt'), await panel.textContent())
    check('Opening the panel does not mutate either Agent', alpha.snapshot().version === initialAlpha.version && beta.snapshot().version === initialBeta.version)
    const wait = async (predicate, label) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await win.waitForTimeout(40) } throw new Error(`Timed out: ${label}`) }
    const summary = (text) => panel.locator('summary').filter({ hasText: new RegExp(`^${text}$`) })
    await summary('编辑原文').click()
    const editor = panel.getByRole('textbox', { name: '记忆原文', exact: true })
    const draft = `${initialAlpha.content}\n- UI 草稿需要保留。`
    await editor.fill(draft)
    alpha.add('并发追加不得被旧编辑器覆盖。')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await panel.getByRole('alert').first().waitFor()
    check('409 preserves the unsaved draft', await editor.inputValue() === draft)
    check('409 preserves the concurrent disk write', alpha.snapshot().content.includes('并发追加') && !alpha.snapshot().content.includes('UI 草稿'))
    await panel.getByRole('button', { name: '刷新', exact: true }).first().click()
    await panel.getByText('记忆已有新版本。', { exact: false }).waitFor()
    await panel.getByRole('button', { name: '放弃草稿并载入当前版本', exact: true }).click()
    check('Reload exposes the current disk version', (await editor.inputValue()).includes('并发追加'))
    await editor.fill(`${await editor.inputValue()}\n- UI 保存的测试事实。`)
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await wait(() => alpha.snapshot().content.includes('UI 保存'), 'memory saved')
    check('UI edit persists through the real route and repository', alpha.snapshot().content.includes('并发追加'))
    await summary('编辑原文').click()
    const restoreInitial = async () => {
      const revisions = summary('版本记录')
      if (await revisions.evaluate((el) => el.parentElement.open)) await revisions.click()
      await revisions.click()
      const record = panel.locator('summary').filter({ hasText: initialAlpha.version.slice(0, 8) }).locator('..')
      await record.locator(':scope > summary').click()
      await record.getByRole('button', { name: '恢复此版本', exact: true }).click()
    }
    await restoreInitial()
    await wait(() => alpha.snapshot().content === initialAlpha.content, 'revision restored')
    check('Revision restore uses the current version', alpha.snapshot().version !== initialAlpha.version)
    const initialEntry = panel.locator('[data-memory-entry-id]').filter({ hasText: 'Alpha 私有事实' }).first()
    await initialEntry.getByRole('button', { name: '遗忘', exact: true }).click()
    await wait(() => alpha.snapshot().entries.length === 0, 'entry forgotten')
    check('Forget removes active memory and records its tombstone', alpha.snapshot().tombstones.length > 0)
    await restoreInitial()
    await wait(() => panel.getByRole('button', { name: '刷新', exact: true }).first().isEnabled(), 'restore settled')
    check('Restoring an old revision does not resurrect forgotten memory', alpha.snapshot().content === '')
    await summary('添加记忆').click()
    await panel.getByRole('textbox', { name: '要记住的事实', exact: true }).fill(initialAlpha.content)
    await panel.getByRole('button', { name: '添加记忆', exact: true }).click()
    await wait(() => alpha.snapshot().entries.length === 1, 'explicit re-add')
    check('Explicit re-add can deliberately remember the fact again', alpha.snapshot().content === initialAlpha.content)
    await summary('版本记录').click()
    await summary('添加记忆').click()
    await panel.getByRole('checkbox', { name: '自动整理', exact: true }).click()
    await wait(() => JSON.parse(fs.readFileSync(path.join(home, 'agents/alpha/.memory-dream.json'))).config.enabled, 'enable Alpha Dream')
    check('Dream opt-in is isolated per Agent', JSON.parse(fs.readFileSync(path.join(home, 'agents/beta/.memory-dream.json'))).config.enabled === false)
    await panel.getByRole('checkbox', { name: '自动整理', exact: true }).click()
    await wait(() => !JSON.parse(fs.readFileSync(path.join(home, 'agents/alpha/.memory-dream.json'))).config.enabled, 'disable Alpha Dream')
    await panel.getByRole('button', { name: '立即整理', exact: true }).click()
    await panel.getByText('整理完成', { exact: true }).waitFor({ timeout: 10000 })
    check('Dream UI starts and observes the real verified transaction', alpha.snapshot().content.includes('Alpha 私有事实'))
    await panel.screenshot({ path: path.join(home, 'memory-completed.png') })
    const card = panel.locator('..')
    await card.locator('button').filter({ has: win.locator('svg.lucide-x') }).first().click()
    panel = await openAgent('beta')
    await panel.getByText('Beta 私有事实：工程代号 BLUE-SILK。', { exact: false }).first().waitFor()
    check('Switching to Beta shows only Beta memory', !(await panel.textContent()).includes('Alpha 私有事实'))
    check('All Alpha writes left Beta unchanged', beta.snapshot().version === initialBeta.version)
    const geometry = await panel.evaluate((el) => ({ width: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth }))
    check('Memory panel has no horizontal overflow', geometry.scroll <= geometry.client + 1)
    await panel.locator('..').screenshot({ path: path.join(home, 'memory-modal-light.png') })
    await panel.locator('..').locator('button').filter({ has: win.locator('svg.lucide-x') }).first().click()
    await win.getByRole('button', { name: '返回应用', exact: true }).click()
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input:visible').fill('切换明暗模式')
    await win.locator('.cmd-item', { hasText: '切换明暗模式' }).click()
    await win.waitForTimeout(250)
    await win.keyboard.press('Meta+,')
    await win.locator('button[aria-controls="settings-nav-subitems-agents"]').click()
    panel = await openAgent('beta')
    await panel.locator('..').screenshot({ path: path.join(home, 'memory-modal-dark.png') })
    await panel.locator('..').locator('button').filter({ has: win.locator('svg.lucide-x') }).first().click()
    await win.getByRole('button', { name: '返回应用', exact: true }).click()
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input:visible').fill('切换语言')
    await win.locator('.cmd-item', { hasText: '切换语言' }).click()
    await win.keyboard.press('Meta+,')
    await win.locator('button[aria-controls="settings-nav-subitems-agents"]').click()
    panel = await openAgent('beta')
    await panel.getByText('Dream · Memory maintenance', { exact: true }).waitFor()
    await panel.locator('..').screenshot({ path: path.join(home, 'memory-modal-english.png') })
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(400, 500); w.setSize(480, 740) })
    await win.waitForTimeout(250)
    check('Narrow memory panel stays within its viewport', await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth))
    await panel.locator('..').screenshot({ path: path.join(home, 'memory-modal-narrow.png') })
    check('Memory controls translate to English', await panel.getByRole('button', { name: 'Run now', exact: true }).count() === 1)
    fs.writeFileSync(path.join(home, 'result.json'), JSON.stringify({ checks, home }, null, 2))
    console.log(`ARTIFACTS ${home}`)
  } catch (e) {
    if (app) { const win = await app.firstWindow(); await win.screenshot({ path: path.join(home, 'failure.png') }); fs.writeFileSync(path.join(home, 'failure.txt'), await win.locator('body').innerText()); }
    console.error(`ARTIFACTS ${home}`); throw e
  } finally {
    await app?.close(); await stub.close(); await new Promise((resolve) => server.close(resolve)); db.close()
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
