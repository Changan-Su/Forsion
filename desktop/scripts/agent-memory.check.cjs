/** Real Electron + production memory routes/repository + isolated SQLite/home.
 * Only unrelated engine endpoints and provider completions are scripted.
 * Run after building tangu-agent and desktop: node scripts/agent-memory.check.cjs
 * Hold the app open on the Growth › Log layer for a manual walk-through: STAGE_MS=600000 TANGU_HARNESS_QUIET=0 node scripts/agent-memory.check.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const electron = require('./lib/launch-electron.cjs')
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
  const SHOTS = process.env.SHOT_DIR || home // 截图落点(缺省留在隔离家目录里,随 ARTIFACTS 一起看)
  fs.mkdirSync(SHOTS, { recursive: true }) // 自定义落点可能还不存在(Codex 第三轮 H2-4;Playwright 1.61 截图自己也会建父目录,这里不依赖它)
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
  // 成长 › 日志(10-13):Alpha 有 9 天的日志(今天往前数),Beta 一天都没有。格式照引擎写的:文件头 `# 日期`,每条 `### HH:MM` + `@设备号 正文`(设备号 = 8 位十六进制)。
  const logDir = path.join(home, 'agents/alpha/LOG')
  fs.mkdirSync(logDir, { recursive: true })
  const logDays = Array.from({ length: 9 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }) // 新 → 旧
  logDays.forEach((date, i) => fs.writeFileSync(path.join(logDir, `${date}.md`), `# ${date}\n\n### 09:30\n@a1b2c3d4 第 ${i + 1} 天:整理了季度复盘的提纲。\n\n### 14:05\n@a1b2c3d4 出了三道练习题。\n`))
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
    let win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 960))
    await win.waitForSelector('#root')
    await win.waitForTimeout(1600)
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.getByRole('button', { name: label, exact: true }).first()
      if (await button.isVisible().catch(() => false)) { await button.click(); break }
    }
    await win.locator('.ob-hero-skip').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    // 记忆面板早已不在设置里(AgentsTab 退役):住在 Agents Space → Agent 详情 →「成长」标签 →「记忆」分段。
    // 全程在主窗里走真 UI:Ribbon 进 Agents Space → 名册点 Agent → 成长 → 记忆。明暗 / 语言切换走命令面板。
    const palette = async (command) => {
      await win.keyboard.press('Meta+k')
      await win.locator('.cmd-input:visible').fill(command)
      await win.locator('.cmd-item', { hasText: command }).click()
      await win.waitForTimeout(250)
    }
    const enterAgentsSpace = async () => {
      const slot = win.locator('.rb-slot[data-id="space:agents"] .rb-space').first()
      if (await slot.count()) await slot.click()
      else {
        await win.locator('.rb-top .rb-more').first().click() // 「…」= 展开
        await win.waitForTimeout(300)
        await win.locator('.rb-top .rb-space[aria-label="Agents"]').first().click()
        await win.evaluate(() => document.querySelector('.rb-open-top .rb-more')?.click()) // 收起:展开时命令区让出来,后续步骤要用
      }
      await win.locator('.agents-roster').first().waitFor({ timeout: 15000 })
    }
    const openAgent = async (slug) => {
      await enterAgentsSpace()
      await win.locator('.agents-roster-item').filter({ hasText: `Memory ${slug}` }).first().click()
      await win.locator('.agent-section-nav [role="tab"][id$="-growth"]').first().click() // 成长 / Growth(按 id,不按文案)
      await win.locator('.profile-segment button').first().click() // 记忆 / Memory
      const panel = win.locator(`[data-testid="agent-memory-panel"][data-agent-slug="${slug}"]`)
      await panel.waitFor()
      await win.waitForTimeout(220)
      return panel
    }
    const openDream = async (panel) => {
      const d = panel.locator('details.profile-disclosure > summary', { hasText: 'Dream' }).first().locator('..')
      if (!(await d.evaluate((el) => el.open))) await d.locator(':scope > summary').click()
      return d
    }
    let panel = await openAgent('alpha')
    await panel.getByText('Alpha 私有事实：偏好简洁中文。', { exact: false }).first().waitFor()
    check('Alpha panel excludes Beta facts', !(await panel.textContent()).includes('BLUE-SILK'))
    await panel.screenshot({ path: path.join(SHOTS, 'memory-light.png') })
    fs.writeFileSync(path.join(home, 'panel-text.txt'), await panel.textContent())
    check('Opening the panel does not mutate either Agent', alpha.snapshot().version === initialAlpha.version && beta.snapshot().version === initialBeta.version)
    const wait = async (predicate, label) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await win.waitForTimeout(40) } throw new Error(`Timed out: ${label}`) }
    // 成长页里的折叠标题可能在名字后面带一枚 <small>(版本号 / 自动·状态),按「以它开头」认。
    const summary = (text) => panel.locator(':scope details > summary').filter({ hasText: new RegExp(`^${text}`) }).first()
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
      const record = panel.locator('details details > summary', { hasText: initialAlpha.version.slice(0, 8) }).first().locator('..')
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
    // 自动整理默认开(09-19):进来就是勾着的;关掉只影响这一个 Agent,再开回来。
    await openDream(panel)
    const dreamFile = (slug) => JSON.parse(fs.readFileSync(path.join(home, `agents/${slug}/.memory-dream.json`)))
    const betaBefore = JSON.stringify(dreamFile('beta').config)
    check('Automatic maintenance starts enabled', await panel.getByRole('checkbox', { name: '自动整理', exact: true }).isChecked())
    await panel.getByRole('checkbox', { name: '自动整理', exact: true }).click()
    await wait(() => dreamFile('alpha').config.enabled === false, 'disable Alpha Dream')
    check('Dream opt-out is isolated per Agent', JSON.stringify(dreamFile('beta').config) === betaBefore && dreamFile('beta').config.enabled === true)
    await panel.getByRole('checkbox', { name: '自动整理', exact: true }).click()
    await wait(() => dreamFile('alpha').config.enabled === true, 're-enable Alpha Dream')
    await panel.getByRole('button', { name: '立即整理', exact: true }).click()
    // 成长页里整理状态写在 Dream 折叠标题的 <small> 里(「自动 · 整理完成」)。
    await panel.locator('details.profile-disclosure > summary small', { hasText: '整理完成' }).first().waitFor({ timeout: 10000 })
    check('Dream UI starts and observes the real verified transaction', alpha.snapshot().content.includes('Alpha 私有事实'))
    await panel.screenshot({ path: path.join(SHOTS, 'memory-completed.png') })
    // ── 成长 › 日志:日志有自己的一段。按天折叠、最近一天展开;读的是去掉文件头和设备标记的那一份;保存走真路由、带着读到的版本号 ──
    const segments = win.locator('.profile-segment button')
    const layerNames = () => segments.locator('strong').evaluateAll((titles) => titles.map((title) => [...title.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join('').trim()).join('|')) // 只取标题自己的文字(「进化」卡上可能挂着数字角标)
    check('Growth has three layers in order: memory, log, evolution', await layerNames() === '记忆|日志|进化')
    await segments.nth(1).click()
    const log = win.locator('[data-testid="agent-log-panel"][data-agent-slug="alpha"]')
    const bodies = log.locator('.agentmem-log-body')
    await bodies.first().waitFor()
    const today = logDays[0]
    const todayFile = path.join(logDir, `${today}.md`)
    const older = log.locator(':scope > details')
    check('Log lists the seven most recent days newest first and folds the older ones',
      (await log.locator(':scope > .agentmem-log').evaluateAll((rows) => rows.map((row) => row.dataset.logDate))).join() === logDays.slice(0, 7).join()
      && (await log.locator('.harness-summary').innerText()).includes('9 天有记录')
      && (await older.locator(':scope > summary').innerText()).trim() === '更早的 2 天' && !(await older.evaluate((el) => el.open)))
    const reading = await bodies.first().innerText()
    check('Only the newest day is open and it is marked as today', await bodies.count() === 1 && (await log.locator(`[data-log-date="${today}"] .agentmem-log-head`).innerText()).includes('今天'))
    check('The reading view drops the file title and the device marker', reading.includes('第 1 天:整理了季度复盘的提纲。') && reading.includes('09:30') && !reading.includes('@a1b2c3d4') && !reading.includes(today))
    await win.waitForTimeout(220)
    await log.screenshot({ path: path.join(SHOTS, 'log-growth-light.png') })
    await win.screenshot({ path: path.join(SHOTS, 'log-growth-window.png') })
    // 人工 / Codex 走查用:STAGE_MS=<毫秒> 时在这里停住(中文、亮色、Alpha 的「成长 › 日志」开着,数据在隔离目录里),到点直接收场,后面的断言不跑。
    // 要让窗口能被点到前台,同时带 TANGU_HARNESS_QUIET=0。
    if (process.env.STAGE_MS) { console.log(`STAGE ${home}`); await win.waitForTimeout(Number(process.env.STAGE_MS)); return }
    await log.locator(`[data-log-date="${logDays[1]}"] .agentmem-log-head`).click()
    await log.getByText('第 2 天:整理了季度复盘的提纲。', { exact: false }).waitFor()
    check('Opening another day closes the previous one', await bodies.count() === 1)
    await log.locator(`[data-log-date="${today}"] .agentmem-log-head`).click()
    await log.getByText('第 1 天:整理了季度复盘的提纲。', { exact: false }).waitFor()
    const logEditor = log.getByRole('textbox', { name: `编辑 ${today} 的日志`, exact: true })
    const editToday = () => log.getByRole('button', { name: `编辑 ${today} 的日志`, exact: true }).click()
    await editToday()
    check('Editing shows the file as stored', await logEditor.inputValue() === fs.readFileSync(todayFile, 'utf8'))
    check('Days cannot be switched while a draft is open', await log.locator('.agentmem-log-head:not(:disabled)').count() === 0)
    const logDraft = `${await logEditor.inputValue()}\n### 15:00\n@a1b2c3d4 界面里补的一条。\n`
    await logEditor.fill(logDraft)
    // 并发追加放在切分段之前:切回来时如果面板重读了(草稿就会对上新版本号),下面那次保存会把这一条盖掉 —— 这样断言才抓得住(Codex 评审 10-13)
    fs.appendFileSync(todayFile, '\n### 14:30\n@e5f6a7b8 另一端并发追加的一条。\n')
    await segments.nth(0).click()
    await segments.nth(1).click()
    await win.waitForTimeout(300)
    check('Switching Growth layers keeps the log draft', await logEditor.inputValue() === logDraft)
    await log.getByRole('button', { name: '保存', exact: true }).click()
    await log.getByRole('alert').first().waitFor()
    check('A stale log save is refused: the draft stays and the concurrent write survives', await logEditor.inputValue() === logDraft
      && fs.readFileSync(todayFile, 'utf8').includes('另一端并发追加') && !fs.readFileSync(todayFile, 'utf8').includes('界面里补的一条'))
    await log.screenshot({ path: path.join(SHOTS, 'log-growth-conflict.png') })
    check('The refusal is explained in the interface language with a way out', (await log.getByRole('alert').first().innerText()).includes('这一天的日志已有新版本'))
    await log.getByRole('button', { name: '放弃草稿并载入当前版本', exact: true }).click()
    await log.getByText('另一端并发追加的一条。', { exact: false }).waitFor()
    await editToday()
    await logEditor.fill(`${await logEditor.inputValue()}\n### 15:00\n@a1b2c3d4 界面里补的一条。\n`)
    await log.getByRole('button', { name: '保存', exact: true }).click()
    await wait(() => fs.readFileSync(todayFile, 'utf8').includes('界面里补的一条'), 'log saved')
    await log.getByText('已保存', { exact: true }).waitFor()
    check('A log edit persists through the real route with the version it loaded', fs.readFileSync(todayFile, 'utf8').includes('另一端并发追加') && await logEditor.count() === 0)
    // 弹窗里的「日志」标签用的是同一个面板:从「记忆」段底部的入口进去,读到的应是刚存下的那一份
    await segments.nth(0).click()
    await win.getByRole('button', { name: '记忆、日志与资料库' }).click()
    await win.getByRole('button', { name: '日志', exact: true }).last().click()
    const modalLog = win.locator('[data-testid="agent-log-panel"]:visible')
    await modalLog.getByText('界面里补的一条。', { exact: false }).waitFor()
    check('The dialog\'s Log tab is the same panel on the current file', await modalLog.locator('.agentmem-log-body').count() === 1
      && !(await modalLog.locator('.agentmem-log-body').innerText()).includes('@a1b2c3d4'))
    await win.screenshot({ path: path.join(SHOTS, 'log-modal.png') })
    await win.getByText('Memory alpha · Agent 大脑', { exact: true }).locator('..').locator('.icon-btn').click()
    await modalLog.waitFor({ state: 'detached' })
    await segments.nth(1).click()
    panel = await openAgent('beta')
    await panel.getByText('Beta 私有事实：工程代号 BLUE-SILK。', { exact: false }).first().waitFor()
    check('Switching to Beta shows only Beta memory', !(await panel.textContent()).includes('Alpha 私有事实'))
    check('All Alpha writes left Beta unchanged', beta.snapshot().version === initialBeta.version)
    await segments.nth(1).click()
    await win.locator('[data-testid="agent-log-panel"][data-agent-slug="beta"]').getByText('暂无日志', { exact: true }).waitFor()
    check('An Agent without a log gets the empty state, not another Agent\'s days', await win.locator('[data-testid="agent-log-panel"][data-agent-slug="beta"] .agentmem-log').count() === 0)
    await segments.nth(0).click()
    const geometry = await panel.evaluate((el) => ({ width: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth }))
    check('Memory panel has no horizontal overflow', geometry.scroll <= geometry.client + 1)
    await panel.screenshot({ path: path.join(SHOTS, 'memory-growth-light.png') })
    await palette('切换明暗模式')
    panel = await openAgent('beta')
    await panel.screenshot({ path: path.join(SHOTS, 'memory-growth-dark.png') })
    await openAgent('alpha')
    await segments.nth(1).click()
    await win.locator('[data-testid="agent-log-panel"][data-agent-slug="alpha"] .agentmem-log-body').first().waitFor()
    await win.waitForTimeout(220)
    await win.screenshot({ path: path.join(SHOTS, 'log-growth-dark.png') })
    await palette('切换语言')
    panel = await openAgent('beta')
    await openDream(panel)
    await panel.locator('summary', { hasText: 'Dream · Memory maintenance' }).first().waitFor()
    await panel.screenshot({ path: path.join(SHOTS, 'memory-growth-english.png') })
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(400, 500); w.setSize(480, 740) })
    await win.waitForTimeout(250)
    check('Narrow memory panel stays within its viewport', await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth))
    await panel.screenshot({ path: path.join(SHOTS, 'memory-growth-narrow.png') })
    const cardFit = await segments.evaluateAll((cards) => cards.map((card) => [card.scrollWidth, card.clientWidth]))
    console.log(`segment cards (scrollWidth/clientWidth) ${JSON.stringify(cardFit)} · ${await layerNames()}`)
    check('Growth layers translate and each card fits a narrow panel', await layerNames() === 'Memory|Log|Evolution' && cardFit.every(([scroll, client]) => scroll <= client + 1))
    await win.locator('.profile-segment').screenshot({ path: path.join(SHOTS, 'segment-english-narrow.png') })
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
