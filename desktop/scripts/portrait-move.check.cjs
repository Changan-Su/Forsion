/** 搬家卡(「我 › 画像」,10-30 第 2 步):真 Electron + 真 standalone 引擎,后台模型是本地假接口(挑哪几条写死,模型判得准不准归 live 台架 portraitmove)。
 *  人点了才扫 → 逐条挪 / 留着 / 撤销 → 以后再说、重载后卡还在 → 上次挪到一半,打开卡片接着做。每一步都回读真文件。
 *  前置:tangu-agent 和 desktop 都已 npm run build(本脚本不构建)。截图落 PORTRAIT_SHOTS(缺省临时目录)。
 *  用法(desktop/):node ../../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="portrait move" --eta=2 -- npm run check:portrait-move
 *  (路径按你所在的检出改;主检出是 ../../.claude/hooks/devlock.cjs) */
const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const path = require('path')
const assert = require('assert/strict')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const G = path.resolve(__dirname, '..')
const ENTRY = path.join(G, '..', 'tangu-agent', 'dist', 'standalone', 'main.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-portrait-move-'))
const SHOTS = process.env.PORTRAIT_SHOTS || path.join(tmp, 'shots'); fs.mkdirSync(SHOTS, { recursive: true })
const TOKEN = randomUUID()
const PICKS = {
  '用户希望被称呼为「阿青」。': '你希望别人叫你阿青。',
  '用户这几周在学线性代数。': '你这几周在学线性代数。',
  '用户平时用中文交流，技术名词保留英文。': '你平时用中文交流，技术名词保留英文。',
  '用户在做一个记账小程序。': '你在做一个记账小程序。',
}
const [NAME, LEARN, LANG, BUILD] = Object.keys(PICKS), ASK = '改完代码先自己跑一遍再报结果。'
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })

async function run() {
  if (!fs.existsSync(ENTRY) || !fs.existsSync(path.join(G, 'out', 'main', 'main.js'))) throw new Error('Build tangu-agent and desktop first')
  let modelCalls = 0
  const llm = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c
    const text = (m) => typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join('')
    const messages = JSON.parse(raw).messages
    if (!text(messages[0]).startsWith('You sort one AI agent')) { // 配了后台模型,Muse 之类的周期也会来问:不是扫描就别答
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); return
    }
    modelCalls++
    const entries = JSON.parse(text(messages.at(-1))) // 引擎已去掉列表前缀
    const content = JSON.stringify({ picks: entries.filter((e) => PICKS[e.content]).map((e) => ({ id: e.id, fact: PICKS[e.content] })) })
    await new Promise((r) => setTimeout(r, 600)) // 真模型要几秒:台架得看得到「正在看」那一行
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise((r) => llm.listen(0, '127.0.0.1', r))
  const shared = path.join(tmp, 'forsion'), engineHome = path.join(shared, 'tangu'); fs.mkdirSync(path.join(engineHome, 'workspace'), { recursive: true })
  fs.writeFileSync(path.join(shared, 'config.json'), JSON.stringify({ providers: [{ providerId: 'fakebg', baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'x', modelIds: ['fake-bg'] }], models: { background: 'fakebg/fake-bg' } }))
  const port = await freePort(), real = `http://127.0.0.1:${port}`
  const log = fs.openSync(path.join(tmp, 'engine.log'), 'a')
  const engine = spawn(process.execPath, [ENTRY, '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(engineHome, 'state.db'), '--sandbox', 'none', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN],
    { env: { ...process.env, TANGU_HOME: engineHome, TANGU_DEFAULT_WORKSPACE: path.join(engineHome, 'workspace'), TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0' }, stdio: ['ignore', log, log] })
  let app, stub, win; const errors = []
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
    await api(`/agent/agents/${slug}/memory`, 'PUT', { content: `- ${NAME}\n- ${LEARN}\n- ${LANG}\n- ${BUILD}\n- ${ASK}\n`, expectedVersion: (await mem()).version })

    const agents = [{ slug, name: 'Nori', description: 'Helper', tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: 'Be precise.', soul: '', createdBy: 'user', libraryDir: path.join(tmp, slug, 'Library') }]
    stub = await startStubEngine({ agents, sessions: [], messages: [], override: async ({ path: p, method, url, body }) => {
      if (!p.startsWith('/agent/human/')) return undefined
      const b = method === 'GET' ? undefined : await body()
      const r = await fetch(real + p + url.search, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })
      return { __code: r.status, body: await r.json() }
    } })
    const ud = path.join(tmp, 'userData')
    for (const dir of [ud, `${ud}-dev`]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' })) }
    app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', G], cwd: G, env: { ...process.env, TANGU_HOME: path.join(tmp, 'shell'), TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' } })
    win = await app.firstWindow(); win.setDefaultTimeout(15000)
    win.on('pageerror', (e) => errors.push(String(e)))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 940))
    await win.waitForSelector('#root'); await win.waitForTimeout(2000)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview')
    await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'agents'); localStorage.setItem('tangu_locale', 'zh') })
    await win.reload()
    await win.locator('[data-agents-space]').waitFor()
    const openPortrait = async (name = '画像') => {
      await win.locator('[data-roster-me] .agents-roster-item').click()
      await win.locator('[data-human-profile]').getByRole('tab', { name, exact: true }).click()
    }
    const shot = async (name) => { await win.waitForTimeout(300); await win.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
    const row = (content) => win.locator('[data-portrait-move-item]').filter({ hasText: content })
    const portrait = win.locator('[data-human-file="SOUL.md"]')

    // ① 打开画像页什么都不做:只有入口,模型一次没调
    await openPortrait()
    const start = win.locator('[data-portrait-move-start]')
    await start.waitFor()
    assert.equal(await start.innerText(), '把各 Agent 记住的关于你的事整理进来')
    assert.equal(modelCalls, 0, 'nothing scans until the user clicks')
    await shot('move-entry')

    // ② 点了才扫:进度行 → 卡片;对 Agent 的要求不在卡上
    await start.click()
    await win.locator('[data-portrait-move-scanning]').waitFor()
    const card = win.locator('[data-portrait-move]'); await card.waitFor()
    assert.ok(modelCalls >= 1)
    assert.equal(await win.locator('[data-portrait-move-item]').count(), 4)
    assert.equal(await card.locator('h4').innerText(), '各 Agent 的记忆里有 4 件关于你的事')
    assert.match(await card.innerText(), /画像会随账号同步上云/)
    assert.match(await row(NAME).innerText(), /Nori 的记忆/)
    assert.match(await row(NAME).innerText(), /你希望别人叫你阿青/)
    assert.equal(await card.getByText(ASK).count(), 0, 'a request to the agent stays out')
    assert.equal((await soul()).trim(), '', 'scanning writes nothing')
    await shot('move-card-light')
    await win.evaluate(() => { const r = document.documentElement; r.setAttribute('data-mode', 'dark'); r.classList.add('dark') })
    await shot('move-card-dark')
    await win.evaluate(() => { const r = document.documentElement; r.setAttribute('data-mode', 'light'); r.classList.remove('dark') })

    // ③ 挪:画像里有了,记忆里没了,页面当场刷新
    await row(NAME).getByRole('button', { name: '挪进画像' }).click()
    await row(NAME).and(win.locator('[data-state="moved"]')).waitFor()
    assert.ok((await soul()).includes('你希望别人叫你阿青'))
    assert.ok(!(await mem()).content.includes(NAME))
    await portrait.locator('.md-body').getByText('你希望别人叫你阿青').waitFor()
    await shot('move-row-moved')

    // ④ 撤销:原句回记忆,句子离开画像
    await row(NAME).getByRole('button', { name: '撤销' }).click()
    await row(NAME).waitFor({ state: 'detached' })
    assert.ok((await mem()).content.includes(NAME), 'original is back')
    assert.ok(!(await soul()).includes('阿青'))

    // ⑤ 留着:记忆不变,以后不再提
    await row(LEARN).getByRole('button', { name: '留着' }).click()
    await row(LEARN).waitFor({ state: 'detached' })
    assert.ok((await mem()).content.includes(LEARN))
    assert.ok(!(await soul()).includes('线性代数'))

    // ⑥ 以后再说:卡收起,入口写还有几件;重载后卡还在
    await card.getByRole('button', { name: '以后再说' }).click()
    assert.match(await start.innerText(), /继续整理（还有 2 件）/)
    await win.reload()
    await openPortrait()
    await card.waitFor()
    assert.equal(await win.locator('[data-portrait-move-item]').count(), 2)

    // ⑦ 上次挪到一半(画像写好了、记忆还没删):打开卡片接着做
    const record = path.join(engineHome, 'human-history', 'portrait-move.json')
    await api('/agent/human/SOUL.md/entries', 'POST', { action: 'add', fact: PICKS[LANG], expectedVersion: (await api('/agent/human/SOUL.md/entries')).version })
    const saved = JSON.parse(fs.readFileSync(record, 'utf8'))
    const hit = saved.items.find((i) => i.content.includes(LANG)); assert.ok(hit); hit.state = 'moving'
    fs.writeFileSync(record, JSON.stringify(saved))
    await openPortrait('记忆'); await openPortrait('画像')
    await card.waitFor()
    await win.waitForFunction(() => !document.querySelector('[data-portrait-move-item][data-state="moving"]'))
    assert.ok(!(await mem()).content.includes(LANG), 'the interrupted move finished')
    assert.ok((await soul()).includes(PICKS[LANG]))
    assert.equal(await win.locator('[data-portrait-move-item]').count(), 1)

    // ⑧ 最后一条挪完:标题换掉、可收起;再扫一遍不再出现留着的和撤销过的
    await row(BUILD).getByRole('button', { name: '挪进画像' }).click()
    await row(BUILD).and(win.locator('[data-state="moved"]')).waitFor()
    assert.equal(await card.locator('h4').innerText(), '这一轮挪好了')
    await card.getByRole('button', { name: '收起' }).click()
    await start.click()
    await win.locator('[data-portrait-move-none]').waitFor()
    assert.equal(await win.locator('[data-portrait-move-item]').count(), 0)
    const memory = (await mem()).content
    assert.ok(memory.includes(NAME) && memory.includes(LEARN) && memory.includes(ASK), 'kept and undone entries stay in memory')
    await shot('move-done')

    // ⑨ 英文
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.reload()
    await win.locator('[data-roster-me] .agents-roster-item').click()
    await win.locator('[data-human-profile]').getByRole('tab', { name: 'Portrait', exact: true }).click()
    assert.equal(await start.innerText(), 'Bring in what your agents remember about you')
    assert.deepEqual(errors, [], 'no renderer errors')
    console.log('portrait move check passed; shots in', SHOTS)
  } catch (e) {
    await win?.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {})
    console.error('artifacts:', tmp, '\nrenderer errors:', errors)
    throw e
  } finally {
    await app?.close().catch(() => {})
    try { await stub?.close?.() } catch { /* 已关 */ }
    engine.kill(); llm.close()
  }
}
run().catch((e) => { console.error(e); process.exit(1) })
