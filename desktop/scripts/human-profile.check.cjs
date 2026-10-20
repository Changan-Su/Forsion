/** 「我」资料页(human/ 文件夹,10-20 界面 A)的真 Electron 台架。
 *  会话列表和对话里的回执走假引擎(可编剧);/agent/human/** 与 Agent 的协作说明转给本检出 build 出来的真 standalone 引擎 ——
 *  保存、修改记录、撤销都落在真磁盘上,按文件断言。只有共识那份的回执是夹具:把一次真写入(actor user)的 change 改成 actor agent
 *  放进对话,id 和版本号都是真的,所以卡片上的撤销打的是真引擎。
 *  前置:cd ../tangu-agent && npm run build;npm run build(本目录,出 out/)。
 *  用法:node scripts/human-profile.check.cjs —— 截图落在最后打印的临时目录(亮 / 暗 / 英文 / 从卡片跳过来)。 */
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const assert = require('assert/strict')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..')
const ENTRY = path.join(ROOT, '..', 'tangu-agent', 'dist', 'standalone', 'main.js')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-human-profile-'))
const TOKEN = randomUUID()
const SEED = {
  'AGENT.md': '先给结论，再展开。\n',
  'SOUL.md': '## 称呼与语言\n\n叫你「林夏」；用中文聊，技术名词保留英文。\n\n## 做事的习惯\n\n喜欢先看图再看字。\n',
  'MEMORY.md': '做独立开发，Forsion 是主业。\n',
  'HUMAN.md': '- 改动大的事，先看 Agent 给的计划，回一句「开始」再让它动手。\n',
}
const SHARED_NEXT = SEED['HUMAN.md'] + '- 要比较两个方案时，当场选一个方向。\n'
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

async function run() {
  assert.ok(fs.existsSync(ENTRY), 'Build the engine first: cd ../tangu-agent && npm run build')
  assert.ok(fs.existsSync(path.join(ROOT, 'out', 'main', 'main.js')), 'Build the desktop first: npm run build')
  const engineHome = path.join(home, 'engine')
  fs.mkdirSync(path.join(engineHome, 'workspace'), { recursive: true })
  const port = await freePort(), real = `http://127.0.0.1:${port}`
  const log = fs.openSync(path.join(home, 'engine.log'), 'a')
  const engine = spawn(process.execPath, [ENTRY, '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(engineHome, 'state.db'), '--sandbox', 'none', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN],
    { env: { ...process.env, TANGU_HOME: engineHome, TANGU_DEFAULT_WORKSPACE: path.join(engineHome, 'workspace'), TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0' }, stdio: ['ignore', log, log] })
  let app, win, stub
  const proxied = [], errors = []
  const shot = async (name) => { await win.waitForTimeout(250); await win.screenshot({ path: path.join(home, `${name}.png`) }) }
  try {
    for (let i = 0; ; i++) { try { if ((await fetch(`${real}/health`)).ok) break } catch { /* 还没起来 */ } assert.ok(i < 120, 'Engine did not start, see engine.log'); await new Promise((r) => setTimeout(r, 250)) }
    const api = async (route, method = 'GET', body) => {
      const r = await fetch(real + route, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const v = await r.json(); assert.ok(r.ok, `${method} ${route}: ${r.status} ${JSON.stringify(v)}`); return v
    }
    const put = async (file, content, summary) => api(`/agent/human/${file}`, 'PUT', { expectedVersion: (await api(`/agent/human/${file}`)).version, content, summary })
    const docs = {}
    for (const [file, content] of Object.entries(SEED)) docs[file] = (await put(file, content, 'Fixture')).document
    const second = await put('HUMAN.md', SHARED_NEXT, '要比较两个方案时，当场选一个方向。')
    assert.deepEqual(second.change.scope, { kind: 'human', file: 'HUMAN.md' })
    const disk = (file) => fs.readFileSync(docs[file].path, 'utf8')
    assert.equal(disk('HUMAN.md'), SHARED_NEXT)
    const receipt = { ...second.change, actor: 'agent', evidence: '你说过两次「先给我看计划」' }

    const base = { archived: false, model_id: 'm1', created_at: '2026-10-20 09:00:00', updated_at: '2026-10-20 09:00:00', projectless: true, project_path: null, project_name: null }
    const session = { ...base, id: 'human-chat', title: 'Human profile chat', agent_config: { agentSlug: 'xyra', execMode: 'host', cwd: home } }
    const agents = [{ slug: 'xyra', name: 'Xyra', description: 'Default helper', tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: 'Be precise.', soul: '', createdBy: 'user', libraryDir: path.join(home, 'xyra', 'Library') }]
    const messages = [{ id: 'u1', session_id: session.id, role: 'user', content: '以后都先给我看计划', timestamp: 1 },
      { id: 'a1', session_id: session.id, role: 'model', content: '记下了。', agent_slug: 'xyra', timestamp: 2, tool_calls: [{ id: 'human-1', type: 'function', function: { name: 'manage_human', arguments: '{"action":"update","scope":"shared"}' } }],
        tool_results: [{ tool_call_id: 'human-1', content: JSON.stringify({ kind: 'human_update', change: receipt }), isError: false }] }]
    stub = await startStubEngine({ agents, sessions: [session], messages, override: async ({ path: p, method, url, body }) => {
      if (!p.startsWith('/agent/human/') && !/^\/agent\/agents\/[^/]+\/human(\/undo)?$/.test(p)) return undefined
      const b = method === 'GET' ? undefined : await body()
      const r = await fetch(real + p + url.search, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })
      proxied.push(`${method} ${p} ${r.status}`)
      return { __code: r.status, body: await r.json() }
    } })
    const ud = path.join(home, 'userData')
    for (const dir of [ud, `${ud}-dev`]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' })) }
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: path.join(home, 'shell'), TANGU_BACKEND_URL: stub.url } })
    win = await app.firstWindow(); win.setDefaultTimeout(15000)
    win.on('pageerror', (e) => errors.push(String(e)))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 940))
    await win.waitForSelector('#root'); await win.waitForTimeout(2000)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview')
    await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'agents'); localStorage.setItem('tangu_locale', 'zh') })
    await win.reload()
    await win.locator('[data-agents-space]').waitFor()

    // ── 「我」置顶:在搜索框之前、不随搜索过滤;点开 = 主区换成资料页,名册里只有「我」是选中的 ──
    const meRow = win.locator('[data-roster-me] .agents-roster-item')
    await meRow.waitFor()
    assert.equal(await win.locator('.agents-roster').evaluate((el) => !!(el.querySelector('[data-roster-me]').compareDocumentPosition(el.querySelector('.agents-search')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'Me sits above the roster search')
    await win.locator('.agents-search input').fill('zzz-no-agent')
    assert.equal(await meRow.isVisible(), true, 'Search does not filter Me out')
    await win.locator('.agents-search input').fill('')
    await meRow.click()
    const page = win.locator('[data-human-profile]')
    await page.waitFor()
    assert.equal(await meRow.getAttribute('aria-pressed'), 'true')
    assert.equal(await win.locator('.agents-roster-item.selected').count(), 1, 'Only Me is selected in the roster')
    assert.equal(await page.getByRole('tab', { name: '协作说明', exact: true }).getAttribute('aria-selected'), 'true')
    const agentMd = page.locator('[data-human-file="AGENT.md"]'), shared = page.locator('[data-human-file="HUMAN.md"]')
    await agentMd.getByText('先给结论', { exact: false }).waitFor(); await shared.getByText('当场选一个方向', { exact: false }).waitFor()
    assert.equal(await agentMd.locator('h3').innerText(), '你希望 Agent 怎么做')
    assert.equal(await shared.locator('h3').innerText(), '和你协作的共识')
    await shot('me-collab-light')
    console.log('PASS Me row pinned above search, opens the profile page, AGENT.md + HUMAN.md read from the real engine')

    // ── 改 AGENT.md → 真磁盘;修改记录里撤销 → 原样回来 ──
    await agentMd.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = agentMd.getByRole('textbox', { name: '编辑「你希望 Agent 怎么做」', exact: true })
    const edited = SEED['AGENT.md'] + '\n回复里少用术语。\n'
    await editor.fill(edited)
    await agentMd.getByRole('button', { name: '保存', exact: true }).click()
    await editor.waitFor({ state: 'detached' })
    assert.equal(disk('AGENT.md'), edited)
    await agentMd.getByRole('button', { name: '更多操作', exact: true }).click()
    await win.getByRole('menuitem', { name: '修改历史', exact: true }).click()
    const latest = agentMd.locator('.human-history article').first()
    assert.ok((await latest.innerText()).includes('你修改了 AGENT.md'), 'User edits of human/ files name the file in history')
    await latest.getByRole('button', { name: '撤销本次更新', exact: true }).click()
    await agentMd.getByText('本次更新已撤销', { exact: true }).waitFor()
    assert.equal(disk('AGENT.md'), SEED['AGENT.md'])
    console.log('PASS save and undo on AGENT.md hit the real humanStore and disk')

    // ── 画像 / 记忆:各是一份,标题换成自己的;记忆不出「旧版本写的」提示 ──
    await page.getByRole('tab', { name: '画像', exact: true }).click()
    await page.locator('[data-human-file="SOUL.md"]').getByText('技术名词保留英文', { exact: false }).waitFor()
    await shot('me-portrait-light')
    await page.getByRole('tab', { name: '记忆', exact: true }).click()
    const memory = page.locator('[data-human-file="MEMORY.md"]')
    await memory.getByText('Forsion 是主业', { exact: false }).waitFor()
    assert.equal(await memory.locator('h3').innerText(), '关于我')
    assert.equal(await memory.locator('[data-human-legacy]').count(), 0)
    await page.getByRole('tab', { name: '协作说明', exact: true }).click()
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'dark'); document.documentElement.classList.add('dark') })
    await shot('me-collab-dark')
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'light'); document.documentElement.classList.remove('dark') })
    console.log('PASS portrait / memory tabs, dark screenshot')

    // ── 对话里共识那份的更新卡:「查看说明」跳到「我」并高亮那条;「修改」打开编辑框;「撤销」打真引擎 ──
    const chat = async () => { await win.locator('[data-ribbon-id="space:tangu"], [data-id="space:tangu"]').first().click(); await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Human profile chat' }).first().click() }
    await chat()
    const card = win.locator(`[data-human-update="${receipt.id}"]`)
    await card.waitFor()
    assert.ok((await card.innerText()).includes('和你协作的共识'))
    await card.getByRole('button', { name: '查看说明', exact: true }).click()
    await page.waitFor()
    await shared.locator(`[data-human-change="${receipt.id}"].human-highlight`).waitFor()
    await shot('me-from-card')
    await chat()
    await card.getByRole('button', { name: '修改', exact: true }).click()
    const sharedEditor = shared.getByRole('textbox', { name: '编辑「和你协作的共识」', exact: true })
    await sharedEditor.waitFor()
    await shared.getByRole('button', { name: '放弃修改', exact: true }).click()
    // 换个标签再回来,面板重挂:跳转令牌已经用过,不许再开一次编辑框(Codex 评审 P2)
    await page.getByRole('tab', { name: '画像', exact: true }).click()
    await page.getByRole('tab', { name: '协作说明', exact: true }).click()
    await shared.locator('h3').waitFor()
    assert.equal(await sharedEditor.count(), 0, 'A consumed deep link does not reopen the editor after a tab switch')
    await chat()
    await card.getByRole('button', { name: '撤销本次更新', exact: true }).click()
    await card.getByText('本次更新已撤销', { exact: true }).waitFor()
    assert.equal(disk('HUMAN.md'), SEED['HUMAN.md'], 'Card undo restores human/HUMAN.md on disk')
    console.log('PASS consensus card view / revise deep-link to Me, card undo hits the real engine')

    // ── 跳转令牌是一次性的:重载后还在「我」,但不再自动展开修改记录 ──
    await win.locator('[data-ribbon-id="space:agents"], [data-id="space:agents"]').first().click()
    await page.waitFor()
    await win.reload()
    await page.waitFor(); await shared.locator('h3').waitFor()
    assert.equal(await shared.locator('.human-history').count(), 0, 'The jump does not replay after reload')
    // ── Agent 那边:点 Agent 行回到 TA 的详情、「我」不再选中;「协作」标签底下指路回「我」 ──
    await win.locator('.agents-roster-item').filter({ hasText: 'Xyra' }).click()
    const profile = win.locator('[data-agent-profile="xyra"]')
    await profile.waitFor()
    assert.equal(await meRow.getAttribute('aria-pressed'), 'false')
    await profile.getByRole('tab', { name: '协作', exact: true }).click()
    await profile.locator('[data-act="open-me"]').click()
    await page.waitFor()
    console.log('PASS one-shot jump, agent row deselects Me, agent collaboration tab links to Me')

    // ── 英文 ──
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.reload()
    // 布局存盘有节流:刚点完链接就重载,恢复的可能还是 Xyra —— 这里不验恢复,直接再点一次「我」
    await meRow.click()
    await page.waitFor()
    for (const tab of ['Collaboration', 'Portrait', 'Memory']) assert.equal(await page.getByRole('tab', { name: tab, exact: true }).count(), 1)
    assert.equal(await agentMd.locator('h3').innerText(), 'How you want Agents to work')
    assert.ok((await meRow.innerText()).includes('Me'))
    assert.equal(await page.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
    await shot('me-collab-english')
    assert.deepEqual(errors, [], 'No renderer errors')
    console.log('PASS English; screenshots:', home)
  } catch (e) {
    if (win) {
      await win.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {})
      console.error('main view text:', await win.locator('[data-agents-space], [data-chat-surface]').first().innerText().catch(() => '(none)'))
    }
    console.error('proxied:', proxied.join('\n  '), '\nrenderer errors:', errors, '\nartifacts:', home)
    throw e
  } finally { await app?.close().catch(() => {}); stub?.close?.(); engine.kill() }
}
run().catch((e) => { console.error(e); process.exitCode = 1 })
