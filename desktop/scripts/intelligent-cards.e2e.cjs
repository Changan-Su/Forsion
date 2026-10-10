/** Real compiled Electron, actual Calendar DB and Bluebird plugin. Stub only model events
 * unless launched by live-harness --only intelligentcards (then real GPT-6 Luna composer). */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs'), { enterSpace } = require('./lib/uiux-electron.cjs'), { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..'), OUT = process.env.TANGU_IUI_OUT || path.join(ROOT, 'outputs/intelligent-cards')
const LIVE = !!process.env.TANGU_IUI_TOKEN, MODEL = process.env.TANGU_IUI_MODEL || 'm1'
const CARD_IDS = ['native:calendar', 'native:todo-list', 'plugin:bluebird:library-list']
const report = { key: 'intelligentcards', name: '原生日历、待办和青鸟收藏卡片', live: LIVE, model: MODEL, checks: [], screenshots: [], turns: [] }
const check = (name, ok) => { assert.ok(ok, name); report.checks.push(name); console.log(`PASS ${name}`) }
const save = () => fs.writeFileSync(path.join(OUT, 'intelligent-cards-evidence.json'), JSON.stringify(report, null, 2))
let base, token
async function api(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  assert.ok(r.ok, `${route}: ${r.status}`); return r.json()
}
async function observe(runId) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 180000), ev = { runId, calls: [], results: [], content: '' }
  try {
    const r = await fetch(`${base}/agent/runs/${runId}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal })
    let buf = ''; const dec = new TextDecoder()
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true }); let pos
      while ((pos = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, pos); buf = buf.slice(pos + 2)
        for (const line of frame.split('\n')) if (line.startsWith('data:')) {
          const e = JSON.parse(line.slice(5)), p = e.payload || {}
          if (e.type === 'tool_call') ev.calls.push(p)
          if (e.type === 'tool_result') ev.results.push(p)
          if (e.type === 'done') { ev.content = p.content; ev.done = true; return ev }
          if (e.type === 'error') throw new Error(p.error)
        }
      }
    }
    throw new Error('No completion')
  } finally { clearTimeout(timer); abort.abort() }
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true }); const t0 = Date.now()
  const bluebird = process.env.TANGU_IUI_BLUEBIRD
  assert.ok(bluebird && fs.readFileSync(path.join(bluebird, 'main.js'), 'utf8').includes('intelligent:'), 'Set TANGU_IUI_BLUEBIRD to the adapted actual plugin checkout')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-iui-cards-')), vault = path.join(home, 'vault')
  const date = new Date().toISOString().slice(0, 10)
  fs.mkdirSync(path.join(vault, 'videos/.bluebird'), { recursive: true })
  const dbPath = path.join(vault, 'tasks.db')
  const notePath = path.join(vault, 'weekly.md')
  fs.writeFileSync(notePath, `# 本周\n- [ ] 完成 Markdown 练习 @${date}\n- 物理读书会 @${date}\n`)
  fs.writeFileSync(dbPath, JSON.stringify({ version: 1, name: '本周安排', columns: [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }], rows: [
    { id: 'review', cells: { name: '检查课程报告', date } }, { id: 'reading', cells: { name: '整理物理笔记', date } }, { id: 'meeting', cells: { name: '项目讨论', date } },
  ] }))
  const entries = ['Physics revision notes', 'Design systems reading', 'Weekend walking route'].map((title, i) => ({ id: `entry-${i}`, title, kind: 'link', date, sourceUrl: `https://example.com/reference-${i}`, notePath: `videos/note-${i}.md`, meta: { title }, summaryMarkdown: `# ${title}\n\nSaved acceptance fixture.`, savedAt: new Date().toISOString() }))
  entries[0].kind = 'video'; entries[0].segments = [{ start: 0, text: 'Saved transcript must not be sent merely by opening.' }]
  fs.writeFileSync(path.join(vault, 'videos/.bluebird-index.json'), JSON.stringify({ folders: [], items: entries }))
  for (const e of entries) { fs.writeFileSync(path.join(vault, `videos/.bluebird/${e.id}.json`), JSON.stringify(e)); fs.writeFileSync(path.join(vault, e.notePath), e.summaryMarkdown) }
  const pluginRoot = path.join(home, 'plugins/bluebird'); fs.mkdirSync(pluginRoot, { recursive: true })
  for (const name of ['main.js', 'manifest.json', 'icon.png', 'icon.svg', 'README.md']) if (fs.existsSync(path.join(bluebird, name))) fs.copyFileSync(path.join(bluebird, name), path.join(pluginRoot, name))
  let stub, sid = 's1', app, win
  if (LIVE) {
    base = process.env.TANGU_BACKEND_URL; token = process.env.TANGU_IUI_TOKEN
    sid = (await api('/agent/sessions', 'POST', { title: 'ZZ-IUI 原生卡片验收', model_id: MODEL, agent_config: { preset: 'chat', execMode: 'sandbox' } })).session.id
  } else {
    const doc = { version: 1, id: 'native-cards', title: '我的日程与收藏', inputs: [], resources: [], blocks: CARD_IDS.map((cardId, i) => ({ id: `card-${i}`, kind: 'app-card', cardId })) }
    stub = await startStubEngine({ override: ({ path: requestPath }) => requestPath === '/agent/special/schedule' ? { schedules: [{ slug: 'study', name: 'Study agent', db: { columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }], rows: [{ id: 'agent-event', cells: { name: 'Agent 复习提醒', date } }] } }] } : undefined, sessions: [{ id: sid, title: '原生卡片验收', model_id: MODEL, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], messages: [{ id: 'a1', role: 'model', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'intelligent_ui', arguments: JSON.stringify({ document: JSON.stringify(doc) }) }, ui_content_offset: 0 }], tool_results: [{ tool_call_id: 'c1', name: 'intelligent_ui', content: 'Intelligent UI rendered.' }] }], models: [{ id: MODEL, name: MODEL, provider: 'stub' }] })
    base = stub.url; token = 'test'
  }
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: base, token }))
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  }
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: base } })
    win = await app.firstWindow(); win.setDefaultTimeout(20000)
    let runRequests = 0
    win.on('request', r => { if (r.method() === 'POST' && /\/agent\/runs$/.test(r.url())) runRequests++ })
    await win.waitForSelector('#root')
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_tangu_onboarding_done', '1') })
    await win.reload(); await win.waitForTimeout(1500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    async function openChat() {
      await win.waitForSelector('.dv-groupview'); await enterSpace(win, 'tangu')
      const tab = win.locator('.dv-tab').filter({ hasText: '原生卡片验收' }).first()
      if (await tab.isVisible().catch(() => false)) { await tab.click(); return }
      const row = win.locator(`.t2s-srow[data-sel-id="${sid}"]`).first()
      if (!(await row.isVisible().catch(() => false))) await win.getByText('无项目会话', { exact: true }).first().click()
      await row.click()
    }
    await openChat()
    if (LIVE) {
      const response = win.waitForResponse(r => /\/agent\/runs$/.test(r.url()) && r.request().method() === 'POST')
      const ta = win.locator('.t2c-ta').first()
      await ta.fill('把我在 Forsion 里已有的近期日程、未完成待办、青鸟收藏夹放到这条回答里，方便我直接查看、勾选已有待办、搜索和打开收藏。展示实时卡片就好，不用分析内容，也不要新建数据或编造示例。'); await ta.press('Enter')
      const res = await response, req = res.request().postDataJSON()
      check('真实输入框使用 GPT-6 Luna', req.model_id === 'codex/gpt-6-luna')
      check('请求只传卡片目录，没有条目内容', CARD_IDS.every(id => req.ui_cards.some(c => c.id === id)) && !JSON.stringify(req.ui_cards).includes('Physics revision'))
      const ev = await observe((await res.json()).runId); report.turns.push(ev); save()
      check('模型先发现可用卡片，再调用 Intelligent UI', ev.calls.some(c => c.name === 'list_intelligent_cards') && ev.calls.some(c => c.name === 'intelligent_ui'))
      check('模型没有把 JSON 当回答', !/"blocks"\s*:|"document"\s*:/.test(ev.content || ''))
    }
    for (const id of CARD_IDS) await win.locator(`[data-app-card="${id}"]`).waitFor()
    const todo = win.locator('[data-app-card="native:todo-list"]'), bookmarks = win.locator('[data-app-card="plugin:bluebird:library-list"]')
    await todo.getByRole('button', { name: /检查课程报告/ }).waitFor()
    await bookmarks.getByRole('button', { name: /Physics revision notes/ }).waitFor()
    await todo.getByRole('button', { name: /完成 Markdown 练习/ }).waitFor()
    await win.locator('[data-app-card="native:calendar"]').getByText('物理读书会', { exact: true }).waitFor()
    check('Markdown 待办和日程与完整视图一致', true)
    if (!LIVE) { await win.locator('[data-app-card="native:calendar"]').getByText('Agent 复习提醒', { exact: true }).waitFor(); check('未打开完整 Calendar 也加载 Agent 日程', true) }
    check('三个真实数据源均已显示', await win.locator('[data-app-card]').count() >= 3)
    const shot = async name => { const f = path.join(OUT, `${name}.png`); await win.screenshot({ path: f }); report.screenshots.push(f) }
    const localRunCount = runRequests
    for (const [id, name] of [['native:calendar', 'calendar-detail'], ['native:todo-list', 'todo-detail'], ['plugin:bluebird:library-list', 'bluebird-detail']]) {
      const f = path.join(OUT, `${name}.png`); await win.locator(`[data-app-card="${id}"]`).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); await win.waitForTimeout(200); await win.locator(`[data-app-card="${id}"]`).screenshot({ path: f }); report.screenshots.push(f)
    }
    await win.locator('[data-app-card="native:calendar"]').getByRole('button', { name: '打开完整视图', exact: true }).click()
    await win.locator('.amx-cal').waitFor()
    check('日历卡片打开原生完整 Calendar', await win.locator('.amx-cal').count() > 0)
    await openChat()
    await todo.scrollIntoViewIfNeeded(); await shot('native-cards-light')
    await todo.getByRole('button', { name: /检查课程报告/ }).click()
    await win.waitForFunction(() => ![...document.querySelectorAll('[data-app-card="native:todo-list"] button')].some(e => e.textContent.includes('检查课程报告')))
    for (let n = 0; n < 40 && !JSON.parse(fs.readFileSync(dbPath)).rows.find(r => r.id === 'review').cells.done; n++) await win.waitForTimeout(100)
    check('聊天勾选已写回原始多维表', JSON.parse(fs.readFileSync(dbPath)).rows.find(r => r.id === 'review').cells.done === true)
    await todo.getByRole('button', { name: /完成 Markdown 练习/ }).click()
    for (let n = 0; n < 40 && !fs.readFileSync(notePath, 'utf8').includes('- [x]'); n++) await win.waitForTimeout(100)
    check('Markdown 勾选写回原笔记', fs.readFileSync(notePath, 'utf8').includes('- [x]'))
    await bookmarks.getByRole('textbox').fill('Physics')
    check('收藏搜索沿用青鸟数据源', await bookmarks.locator('.iui-app-row').count() === 1)
    await bookmarks.getByRole('textbox').fill('')
    await bookmarks.scrollIntoViewIfNeeded(); await shot('bluebird-card-light')
    await bookmarks.getByRole('button', { name: /Physics revision notes/ }).click()
    await win.locator('.bb-root').waitFor()
    await win.waitForTimeout(700)
    check('打开含字幕的视频收藏不调用模型', runRequests === localRunCount)
    check('点击收藏打开青鸟原生工作台', await win.locator('.bb-root').innerText().then(t => t.includes('Physics revision notes')))
    await openChat()
    await win.reload(); await openChat(); await todo.getByRole('button', { name: /整理物理笔记/ }).waitFor()
    check('刷新后读取已保存的待办状态', await todo.getByRole('button', { name: /检查课程报告/ }).count() === 0)
    await win.evaluate(() => { document.documentElement.dataset.mode = 'dark'; document.documentElement.classList.add('dark') })
    await bookmarks.scrollIntoViewIfNeeded(); await shot('bluebird-card-dark')
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(360, 500); w.setSize(500, 850) })
    await bookmarks.scrollIntoViewIfNeeded(); await shot('bluebird-card-narrow')
    check('窄窗口卡片没有横向溢出', await bookmarks.evaluate(e => e.scrollWidth <= e.clientWidth + 1))
    check('本地操作没有额外模型请求', runRequests === localRunCount)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 820))
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'amadeus-plugins', n: Date.now() } }))
    let panel
    for (let i = 0; i < 60 && !panel; i++) {
      for (const w of app.windows()) if (w.url().includes('window=floating') && await w.locator('.settings-page').count().catch(() => 0)) panel = w
      if (!panel) await win.waitForTimeout(250)
    }
    assert.ok(panel, 'Settings opens')
    await panel.getByRole('button', { name: '已安装插件', exact: true }).click()
    const plugin = panel.locator('[data-plugin-id="bluebird"]'); await plugin.waitFor()
    const toggle = plugin.locator('input[data-plugin-switch], input[data-bundle-switch]')
    await toggle.uncheck()
    await win.locator('[data-card-unavailable="plugin:bluebird:library-list"]').waitFor()
    check('禁用青鸟即时撤下现有卡片', await bookmarks.count() === 0)
    await toggle.check()
    await bookmarks.getByRole('button', { name: /Physics revision notes/ }).waitFor()
    check('重新启用恢复同一条回答中的真实收藏', await bookmarks.locator('.iui-app-row').count() === 3)
    await panel.close()
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_theme_pref', 'light') })
    await win.reload()
    await win.locator('[data-app-card="plugin:bluebird:library-list"]').getByPlaceholder('Search this list').waitFor()
    await win.locator('[data-app-card="plugin:bluebird:library-list"]').scrollIntoViewIfNeeded(); await shot('bluebird-card-english')
    check('英文界面使用对应卡片文案', await win.locator('.iui-app-card .iui-live').evaluateAll(es => es.length >= 3 && es.every(e => e.textContent === 'Live')) && await win.locator('[data-app-card="native:calendar"]').getByRole('button', { name: 'Open full view', exact: true }).count() === 1)
    report.ok = true
  } catch (e) { report.ok = false; report.detail = String(e.stack || e); if (win) await win.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); throw e }
  finally { report.ms = Date.now() - t0; save(); if (app) await app.close().catch(() => {}); if (stub) await stub.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
