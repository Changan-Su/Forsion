/** 对话回执里的画像行(10-30):真 Electron + 真 standalone 引擎,记忆和 human/ 的接口都走真引擎,对话走假引擎(编一条带三次 remember 的回复)。
 *  假引擎和 vi.fn 证不了的就是这段:回执里的 id / 版本和引擎的路由对不对得上,点了之后文件真的变了。
 *    ① 三行都认得出(挪进画像 / 写进画像 / Agent 记忆),状态 current
 *    ② 「让所有 Agent 都照做」:那句进 human/AGENT.md,从 Agent 记忆拿掉
 *    ③ 撤销挪动:新句子从画像拿掉,原句回到 Agent 记忆
 *    ④ 撤销新写的一条:从画像拿掉
 *  前置:tangu-agent 和 desktop 都已 npm run build(本脚本不构建)。截图落 PORTRAIT_SHOTS(缺省临时目录)。
 *  用法(desktop/):node ../../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="portrait receipt" --eta=2 -- npm run check:portrait-receipt
 *  (路径按你所在的检出改;主检出是 ../../.claude/hooks/devlock.cjs) */
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const assert = require('assert/strict')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const G = path.resolve(__dirname, '..')
const ENTRY = path.join(G, '..', 'tangu-agent', 'dist', 'standalone', 'main.js')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-portrait-receipt-'))
const SHOTS = process.env.PORTRAIT_SHOTS || path.join(home, 'shots'); fs.mkdirSync(SHOTS, { recursive: true })
const TOKEN = randomUUID()
const OLD = '用户希望被称呼为「老板」。', ASK = '改完代码先自己跑一遍再报结果。'
const NAME = '你希望别人叫你阿青，平时用中文。', LEARN = '你这几周在学线性代数。'
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })

async function run() {
  if (!fs.existsSync(ENTRY) || !fs.existsSync(path.join(G, 'out', 'main', 'main.js'))) throw new Error('Build tangu-agent and desktop first')
  const engineHome = path.join(home, 'engine'); fs.mkdirSync(path.join(engineHome, 'workspace'), { recursive: true })
  const port = await freePort(), real = `http://127.0.0.1:${port}`
  const log = fs.openSync(path.join(home, 'engine.log'), 'a')
  const engine = spawn(process.execPath, [ENTRY, '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(engineHome, 'state.db'), '--sandbox', 'none', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN],
    { env: { ...process.env, TANGU_HOME: engineHome, TANGU_DEFAULT_WORKSPACE: path.join(engineHome, 'workspace'), TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0' }, stdio: ['ignore', log, log] })
  let app, stub
  try {
    for (let i = 0; ; i++) { try { if ((await fetch(`${real}/health`)).ok) break } catch { /* 还没起来 */ } if (i > 120) throw new Error('engine did not start'); await new Promise((r) => setTimeout(r, 250)) }
    const api = async (route, method = 'GET', body) => {
      const r = await fetch(real + route, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const v = await r.json(); if (!r.ok) throw new Error(`${method} ${route}: ${r.status} ${JSON.stringify(v)}`); return v
    }
    const slug = 'nori'
    await api('/agent/agents', 'POST', { slug, name: 'Nori', systemPrompt: 'Be precise.' })
    const mem = () => api(`/agent/agents/${slug}/memory`)
    const soul = async () => (await api('/agent/human/SOUL.md')).content
    const handbook = async () => (await api('/agent/human/AGENT.md')).content
    const addEntry = async (fact) => (await api('/agent/human/SOUL.md/entries', 'POST', { action: 'add', fact, expectedVersion: (await api('/agent/human/SOUL.md/entries')).version })).entry

    // 回执里的东西全部来自真引擎:先把这几次写入真做一遍,再把回执编进假对话
    const seeded = await api(`/agent/agents/${slug}/memory`, 'PUT', { content: `- ${OLD}\n- ${ASK}\n`, expectedVersion: (await mem()).version })
    const oldEntry = seeded.entries.find((e) => e.content.includes('老板')), askEntry = seeded.entries.find((e) => e.content.includes('跑一遍'))
    const nameEntry = await addEntry(NAME), learnEntry = await addEntry(LEARN)
    await api(`/agent/agents/${slug}/memory/entries`, 'POST', { action: 'forget', id: oldEntry.id, expectedVersion: seeded.version })

    const results = [
      { action: 'update', scope: 'person', version: 'v', entry: nameEntry, moved: { from: 'agent', id: oldEntry.id, content: oldEntry.content } },
      { action: 'add', scope: 'person', version: 'v', entry: learnEntry },
      { action: 'add', scope: 'agent', version: 'v', entry: { id: askEntry.id, content: askEntry.content } },
    ]
    const session = { archived: false, model_id: 'm1', created_at: '2026-10-30 09:00:00', updated_at: '2026-10-30 09:00:00', projectless: true, project_path: null, project_name: null, id: 'portrait-chat', title: '换个称呼', agent_config: { agentSlug: slug, execMode: 'host', cwd: home } }
    const agents = [{ slug, name: 'Nori', description: 'Helper', tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: 'Be precise.', soul: '', createdBy: 'user', libraryDir: path.join(home, slug, 'Library') }]
    const messages = [
      { id: 'u1', session_id: session.id, role: 'user', content: '以后别叫我老板了，叫我阿青。', timestamp: Date.now() - 90_000 },
      { id: 'a1', session_id: session.id, role: 'model', content: '好的，阿青。', agent_slug: slug, timestamp: Date.now() - 60_000,
        tool_calls: results.map((r, i) => ({ id: `r${i}`, type: 'function', function: { name: 'remember', arguments: JSON.stringify({ action: r.action, scope: r.scope, fact: r.entry.content }) } })),
        tool_results: results.map((r, i) => ({ tool_call_id: `r${i}`, content: JSON.stringify({ ok: true, ...r }), isError: false })) },
    ]
    stub = await startStubEngine({ agents, sessions: [session], messages, override: async ({ path: p, method, url, body }) => {
      if (!p.startsWith('/agent/human/') && !/^\/agent\/agents\/[^/]+\/(human|memory)(\/|$)/.test(p)) return undefined
      const b = method === 'GET' ? undefined : await body()
      const r = await fetch(real + p + url.search, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })
      return { __code: r.status, body: await r.json() }
    } })
    const ud = path.join(home, 'userData')
    for (const dir of [ud, `${ud}-dev`]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' })) }
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', G], cwd: G, env: { ...process.env, TANGU_HOME: path.join(home, 'shell'), TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' } })
    const win = await app.firstWindow(); win.setDefaultTimeout(15000)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1512, 950))
    await win.waitForSelector('#root'); await win.waitForTimeout(2000)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview')
    await win.locator('[data-ribbon-id="space:tangu"], [data-id="space:tangu"]').first().click()
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: '换个称呼' }).first().click()
    const receipt = win.locator('[data-self-receipt]'); await receipt.waitFor()
    if (!(await receipt.evaluate((el) => el.open))) await receipt.locator('summary').click()
    const shot = async (name) => { await win.waitForTimeout(300); await win.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
    const row = (id) => win.locator(`[data-memory-update="${id}"]`)
    const moved = row(nameEntry.id), added = row(learnEntry.id), asked = row(askEntry.id)

    // ① 三行都认得出
    await moved.and(win.locator('[data-memory-state="current"]')).waitFor()
    await added.and(win.locator('[data-memory-state="current"]')).waitFor()
    await asked.and(win.locator('[data-memory-state="current"]')).waitFor()
    assert.equal(await moved.getAttribute('data-memory-scope'), 'person')
    assert.match(await moved.innerText(), /画像 · 所有 Agent 都看得到/)
    assert.match(await moved.innerText(), /原来那条已从「Nori 的记忆」拿掉/)
    assert.equal(await asked.getByRole('button', { name: '让所有 Agent 都照做' }).count(), 1)
    assert.equal(await added.getByRole('button', { name: '让所有 Agent 都照做' }).count(), 0, 'promote is for agent rows only')
    await shot('receipt-light')
    await win.evaluate(() => { const r = document.documentElement; r.setAttribute('data-mode', 'dark'); r.classList.add('dark') })
    await shot('receipt-dark')
    await win.evaluate(() => { const r = document.documentElement; r.setAttribute('data-mode', 'light'); r.classList.remove('dark') })

    // ② 交给所有 Agent
    await asked.getByRole('button', { name: '让所有 Agent 都照做' }).click()
    await asked.and(win.locator('[data-memory-state="promoted"]')).waitFor()
    assert.ok((await handbook()).includes(ASK), 'sentence is in human/AGENT.md')
    assert.ok(!(await mem()).content.includes(ASK), 'sentence left agent memory')

    // ③ 撤销挪动
    await moved.getByRole('button', { name: '撤销' }).click()
    await moved.and(win.locator('[data-memory-state="undone"]')).waitFor()
    assert.ok(!(await soul()).includes('阿青'), 'new sentence left the portrait')
    assert.ok((await mem()).content.includes('老板'), 'old sentence is back in agent memory')

    // ④ 撤销新写的一条
    await added.getByRole('button', { name: '撤销' }).click()
    await added.and(win.locator('[data-memory-state="undone"]')).waitFor()
    assert.ok(!(await soul()).includes('线性代数'), 'entry left the portrait')
    await shot('receipt-after')
    console.log('portrait receipt check passed; shots in', SHOTS)
  } finally {
    await app?.close().catch(() => {})
    try { await stub?.close?.() } catch { /* 已关 */ }
    engine.kill()
  }
}
run().catch((e) => { console.error(e); process.exit(1) })
