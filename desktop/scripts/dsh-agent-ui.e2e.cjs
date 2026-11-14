/**
 * 「由谁来跑」(DSH 融合底层第 2 步「身份合一」)在真应用里的样子:真 Electron × 真引擎(托管模式,本检出 tangu-agent/dist)
 * × 真 DSH(官方包 @deepseek-ai/dsh,`--profile acp`)× 本机假模型 × 隔离 home。
 *
 * 假模型一个端口两张嘴:
 *   - Anthropic Messages(/v1/messages)给 DSH:记得住上文里出现过的暗号(形如 HERON-1234),被问「What code word」就从上文里找;
 *   - OpenAI 兼容(/v1/chat/completions)给 Forsion 这边的后台模型(Historian 判官):回一份判断(日志 + 一条记忆候选,内容取暗号)。
 *
 * 点验:
 *   ① 名册:自带的 DSH 在,行尾有 DSH 小标;Tangu 的 Agent 没有小标;
 *   ② 配置页:DSH 的 Harness 卡只有「运行在」一行,写着 DeepSeek Harness;
 *   ③ 把「浣溪沙」(Aria)改成由 DSH 来跑并保存 → 名册里它也挂上小标;
 *   ④ 新对话的选择器里它带小标;选它发两句,第二句的回答记得第一句;回答记在它名下(消息上的名字);
 *   ⑤ 它的文件夹里有 Historian 写的当天日志和记忆候选,缺省 Agent(行香子 / xyra)那边没有;
 *   ⑥ 整窗重载后,这场对话里用户的两句各出现一次(引擎对话现在也存用户那一句);
 *   ⑦a 本机引擎清单为空(手机 / 网页 store 里就是空的;这里拦掉那一个请求)→ 输入框写「只能在电脑上用」,名册照样列着它;
 *   ⑦b 关掉应用、去掉台架加的 dsh 条目再起(本机 PATH 上没有 dsh)→ 引擎自己报未安装:名册「未安装」、Harness 卡给「怎么安装」、
 *      输入框说明原因。
 *
 * 用法:先 npm run build(桌面)+ tangu-agent 的 npm run build;
 *   node scripts/dsh-agent-ui.e2e.cjs --node <Node ≥ 24.9> --dsh <@deepseek-ai/dsh 的 lib/bin.js> --root <全新目录,不在系统临时目录下>
 * 截图在 <root>/shots(只留本机)。跑完核对有没有留下 DSH 进程。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : '' }
const NODE = opt('node'), BIN = opt('dsh'), ROOT_ARG = opt('root')
if (!NODE || !BIN || !ROOT_ARG) { console.error('用法见文件头'); process.exit(2) }
for (const f of ['out/main/main.js', '../tangu-agent/dist/standalone/main.js']) if (!fs.existsSync(path.join(ROOT, f))) { console.error(`缺 ${f} —— 先 build`); process.exit(2) }
fs.mkdirSync(ROOT_ARG, { recursive: true })
const R = fs.realpathSync(ROOT_ARG)
for (const t of [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']) {
  let rt = t; try { rt = fs.realpathSync(t) } catch { /* */ }
  if (R === rt || R.startsWith(rt + path.sep)) { console.error('--root 不能在系统临时目录下面'); process.exit(2) }
}
const D = (...p) => { const d = path.join(R, ...p); fs.mkdirSync(d, { recursive: true }); return d }
const SHOTS = D('shots')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${String(detail).replace(/\s+/g, ' ').slice(0, 400)}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 300) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every) } }

// ── 本机假模型
const CODE = /\b[A-Z]{4,8}-\d{4}\b/g
function dshBrain(body) {
  const msgs = body?.messages || []
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  const blocks = typeof lastUser?.content === 'string' ? [lastUser.content] : (lastUser?.content || []).map((b) => b.text).filter((t) => typeof t === 'string')
  const last = [...blocks].reverse().find((t) => /code word/i.test(t)) || ''
  if (/What code word/i.test(last)) {
    const earlier = JSON.stringify(msgs).split(JSON.stringify(last).slice(1, -1)).join('')
    const seen = [...new Set(earlier.match(CODE) || [])]
    return seen.length ? seen.join(' ') : 'NONE'
  }
  return 'OK'
}
function judgeReply(body) {
  const text = JSON.stringify(body?.messages || [])
  if (!/\[Task: judge\]/.test(text)) return 'OK'
  const word = (text.match(CODE) || ['nothing'])[0]
  return JSON.stringify({ title: 'Code word', summary: `The user shared the code word ${word}.`, log: `Talked about the code word ${word}.`, memory_candidates: [`The user's test code word is ${word}.`] })
}
const stub = { dsh: 0, judge: 0 }
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d })
  req.on('end', () => {
    let body = null; try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    const p = (req.url || '').split('?')[0]
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.method === 'GET' && /\/models$/.test(p)) return json({ object: 'list', data: [{ id: 'judge', object: 'model' }] })
    if (req.method === 'POST' && /\/messages\/count_tokens$/.test(p)) return json({ input_tokens: 10 })
    if (req.method === 'POST' && /\/chat\/completions$/.test(p)) {
      stub.judge++; const content = judgeReply(body)
      const base = { id: `chatcmpl_${stub.judge}`, created: Math.floor(Date.now() / 1000), model: body?.model || 'judge' }
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      if (!body?.stream) return json({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`)
      chunk({ role: 'assistant', content }); chunk({}, 'stop', { usage }); res.write('data: [DONE]\n\n'); return res.end()
    }
    if (!(req.method === 'POST' && /\/messages$/.test(p))) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `stub: no such route ${p}` } })) }
    const withTools = Array.isArray(body?.tools) && body.tools.length > 0
    if (withTools) stub.dsh++
    const text = withTools ? dshBrain(body) : 'check session'
    const msg = { id: `msg_${stub.dsh}`, type: 'message', role: 'assistant', model: body?.model || 'stub', stop_reason: null, stop_sequence: null }
    if (!body?.stream) return json({ ...msg, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { ...msg, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    ev('message_stop', {}); res.end()
  })
})

const HOME = D('app')
const WS = D('workspace'), VAULT = D('vault')
let STUB = ''
function prepareHome() {
  const dshEnv = { PATH: `${path.dirname(NODE)}:/usr/bin:/bin`, HOME: D('dsh-home'), DSH_HOME: D('dsh'), TMPDIR: D('dsh-tmp'),
    XDG_CACHE_HOME: D('xc'), XDG_DATA_HOME: D('xd'), XDG_STATE_HOME: D('xs'), XDG_CONFIG_HOME: D('xcfg'), DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_BASE_URL: STUB, DEEPSEEK_API_KEY: 'stub-not-a-real-key' }
  const engines = { engines: [{ id: 'dsh', name: 'DeepSeek Harness', command: NODE, args: [BIN, '--profile', 'acp'], env: dshEnv }] }
  // Historian:开着、每轮都评、判官用假模型的 OpenAI 口(provider 由下面的 TANGU_PROVIDER_* 环境变量给)
  const config = { specialAgents: { historian: { enabled: true, everyRounds: 1, firstRoundTrigger: true, modelId: 'stubjudge/judge' } } }
  for (const dir of [HOME, D('app', 'tangu')]) {
    fs.writeFileSync(path.join(dir, 'engines.json'), JSON.stringify(engines, null, 2))
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))
  }
  fs.writeFileSync(path.join(VAULT, 'welcome.md'), '# check\n')
  for (const dir of [D('app', 'userdata'), D('app', 'userdata-dev')]) {
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: VAULT, localVault: VAULT }))
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', sandbox: 'none', browserEnabled: false, unitHostEnabled: false, defaultWorkspaceDir: WS, modelId: 'stubjudge/judge' }))
  }
}

// 隔离 home 下某个 Agent 的文件夹(托管模式的引擎 home 在 app/ 或 app/tangu/,两处都看)
const agentDirs = (slug) => [path.join(HOME, 'agents', slug), path.join(HOME, 'tangu', 'agents', slug)]
function trail(slug) {
  let logs = '', raw = ''
  for (const dir of agentDirs(slug)) {
    const logDir = path.join(dir, 'LOG')
    if (fs.existsSync(logDir)) for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith('.md'))) logs += fs.readFileSync(path.join(logDir, f), 'utf8')
    const rawFile = path.join(dir, '.memory-raw.md')
    if (fs.existsSync(rawFile)) raw += fs.readFileSync(rawFile, 'utf8')
  }
  return { logs, raw }
}

async function shot(win, name) { await win.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {}) }
async function openAgents(win) {
  const btn = win.locator('[data-ribbon-id="space:agents"], [data-id="space:agents"] .rb-space, [data-id="space:agents"], button[title="Agents"]').first()
  if (await btn.count()) await btn.click()
  else await win.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await win.locator('.agents-roster').waitFor({ timeout: 20_000 })
  await sleep(800)
}
const rosterRow = (win, name) => win.locator('.agents-roster-list .agents-roster-item').filter({ hasText: name }).first()
const rowEngineTag = (win, name) => rosterRow(win, name).locator('[data-agent-engine]')
async function pickAgent(win, name) {
  const pill = win.locator('.agent-select-strip .compact-chat-picker').first()
  await pill.click()
  const row = win.locator('.chat-pick-row', { has: win.locator('.chat-pick-name', { hasText: name }) }).first()
  await row.waitFor({ timeout: 10_000 })
  return row
}
async function send(win, text) {
  const ta = win.locator('.t2c-ta').last()
  await ta.click(); await ta.fill(text); await ta.press('Enter')
}
const lastAsst = (win) => win.evaluate(() => [...document.querySelectorAll('.t2-asst')].map((e) => e.innerText.trim()).pop() || '')
const asstCount = (win) => win.evaluate(() => document.querySelectorAll('.t2-asst').length)

const AGENT = '浣溪沙' // 自带的 Aria(中文界面里的名字)
const WORD = `HERON-${1000 + Math.floor(Math.random() * 9000)}`

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  STUB = `http://127.0.0.1:${server.address().port}`
  prepareHome()
  const launch = () => electron.launch({
    args: [`--user-data-dir=${path.join(HOME, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: HOME, FORSION_WORKSPACE_DIR: WS, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1',
      TANGU_PROVIDER_ID: 'stubjudge', TANGU_PROVIDER_BASE_URL: `${STUB}/v1`, TANGU_PROVIDER_API_KEY: 'stub-not-a-real-key', TANGU_PROVIDER_MODELS: 'judge' },
  })
  let app = await launch()
  const pageErrors = []
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    win.on('pageerror', (e) => pageErrors.push(e.message))
    win.on('response', async (r) => { if (/\/agent\/runs(\?|$)/.test(r.url()) && r.request().method() === 'POST' && r.status() >= 400) console.log(`  · POST /agent/runs → ${r.status()} ${(await r.text().catch(() => '')).slice(0, 300)}`) })
    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    check('前置:跳过首启引导', await skipOnboarding(win))
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    const ready = await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 120_000 }).then(() => true, () => false)
    check('前置:托管模式,本检出的引擎就绪', ready)

    // ① 名册
    await openAgents(win)
    await shot(win, '10-roster')
    check('① 名册里有自带的 DSH,行尾有 DSH 小标', (await rowEngineTag(win, 'DSH').count()) === 1 && (await rowEngineTag(win, 'DSH').innerText()).trim() === 'DSH')
    check('① 装着 DSH:名册里没有「未安装」', (await win.locator('.agents-roster [data-engine-missing]').count()) === 0)
    check('① Tangu 的 Agent 没有小标', (await rowEngineTag(win, AGENT).count()) === 0 && (await rowEngineTag(win, '行香子').count()) === 0)

    // ② DSH 的配置页
    await rosterRow(win, 'DSH').click(); await sleep(1200)
    const runsOn = await win.locator('[data-profile-field="engine"] .profile-model-trigger').first().innerText().catch(() => '')
    await shot(win, '11-dsh-profile')
    check('② DSH 的 Harness 卡:运行在 DeepSeek Harness', runsOn.includes('DeepSeek Harness'), runsOn)
    check('② Harness 卡只有「运行在」一行(没有运行时 / 更新通道 / 插件)', (await win.locator('[data-profile-field="engine"]').count()) === 1 && !(await win.locator('.agent-profile').innerText()).includes('更新通道'))

    // ③ 把浣溪沙改成由 DSH 来跑
    await rosterRow(win, AGENT).click(); await sleep(1200)
    await shot(win, '12-aria-before')
    const before = await win.locator('[data-profile-field="engine"] .profile-model-trigger').first().innerText().catch(() => '')
    check('③ 浣溪沙原来由 Tangu 来跑', before.includes('Tangu'), before)
    await win.locator('[data-profile-field="engine"] .profile-model-trigger').first().click()
    await win.locator('[data-profile-field="engine"] [role="option"][data-value="dsh"]').first().click()
    await sleep(500)
    await shot(win, '13-aria-dsh-unsaved')
    await win.locator('.agent-profile button.btn.primary').filter({ hasText: '保存' }).first().click()
    const saved = await until(async () => (await rowEngineTag(win, AGENT).count()) === 1, 15_000)
    await sleep(600)
    await shot(win, '14-aria-dsh-saved')
    check('③ 保存后名册里浣溪沙挂上 DSH 小标', !!saved)
    const onDisk = agentDirs('aria').map((d) => path.join(d, 'config.toml')).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    check('③ 写进了它的 config.toml(engine = "dsh")', /^engine\s*=\s*"dsh"/m.test(onDisk))

    // ④ 新对话里选它,发两句
    check('前置:进 Tangu', await enterSpace(win, 'tangu'))
    await sleep(1200)
    await win.getByText('新会话', { exact: true }).first().click(); await sleep(1200)
    const row = await pickAgent(win, AGENT)
    const rowText = await row.innerText()
    await shot(win, '15-picker')
    check('④ 选择器里它带 DSH 小标', /\bDSH\b/.test(rowText), rowText)
    check('④ 选择器的「外部引擎」分组不再单列 DeepSeek Harness', (await win.locator('.chat-pick-row .chat-pick-name', { hasText: /^DeepSeek Harness$/ }).count()) === 0)
    await row.click(); await sleep(900)
    const n0 = await asstCount(win)
    // 第一句写长一点:Historian 新增不到 120 个字符的一轮当琐碎轮跳过(产品规则)
    await send(win, `Remember this code word for later: ${WORD}. It is written on the shelf that holds the spare keys for the lab cabinet, next to the blue toolbox. Do not use any tools. Reply with just: OK`)
    const a1 = await until(async () => (await asstCount(win)) > n0 && /\bOK\b/.test(await lastAsst(win)), 90_000)
    check('④ 第一句有回答', !!a1, await lastAsst(win))
    await sleep(1500)
    await send(win, 'Answer only from what was said in this conversation. Do not use any tools. What code word did I ask you to remember?')
    const a2 = await until(async () => (await lastAsst(win)).includes(WORD), 90_000)
    await shot(win, '16-two-turns')
    check('④ 第二句的回答记得第一句给的暗号', !!a2, await lastAsst(win))
    check('④ 两句都交给了 DSH(假模型被 DSH 调过)', stub.dsh >= 2, `DSH 请求 ${stub.dsh} 次`)
    const who = await win.evaluate(() => [...document.querySelectorAll('.t2-asst-col, .t2-asst')].map((e) => e.innerText).join('\n'))
    check('④ 回答上署的是它的名字', who.includes(AGENT), who.slice(0, 200))

    // ⑤ 记忆和日志归属
    const t = await until(() => { const x = trail('aria'); return x.logs.includes(WORD) && x.raw.includes(WORD) ? x : null }, 60_000, 800)
    const x = trail('xyra')
    check('⑤ 它的文件夹里有当天日志(Historian 写的,带暗号)', !!t, `判官被问 ${stub.judge} 次`)
    check('⑤ 它的文件夹里有记忆候选(带暗号)', !!t && t.raw.includes(WORD))
    check('⑤ 缺省 Agent(xyra)那边没有这段', !x.logs.includes(WORD) && !x.raw.includes(WORD))

    // ⑥ 重载后用户那两句各出现一次
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
    await enterSpace(win, 'tangu'); await sleep(1500)
    // 会话标题:Historian 的假判官会把它改成「Code word」;还没改的话是第一句的开头
    const title = win.locator('aside, nav, [class*="sidebar"], [class*="side"]').getByText(/^(Code word|Remember this code word.*)$/).first()
    if (await title.count()) { await title.click(); await sleep(1800) }
    const users = await win.evaluate(() => [...document.querySelectorAll('.t2-user')].map((e) => e.innerText.trim()))
    await shot(win, '17-after-reload')
    check('⑥ 重载后用户那两句都在、各一次', users.filter((u) => u.includes(WORD)).length === 1 && users.filter((u) => u.includes('What code word')).length === 1, users.join(' | ').slice(0, 300))

    const openChat = async (w) => {
      await enterSpace(w, 'tangu'); await sleep(1200)
      const tt = w.locator('aside, nav, [class*="sidebar"], [class*="side"]').getByText(/^(Code word|Remember this code word.*)$/).first()
      if (await tt.count()) { await tt.click(); await sleep(1500) }
    }

    // ⑦a 引擎清单是空的(手机 / 网页从不拉本机引擎清单,store 里就是空的):这里拦掉这一个请求,store 回落成同一个空清单
    await win.route('**/agent/engines', (route) => (route.request().method() === 'GET' ? route.abort() : route.continue()))
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
    await openChat(win)
    const phElsewhere = await win.locator('.t2c-ta').last().getAttribute('placeholder').catch(() => '')
    const offElsewhere = await win.locator('.t2c-ta').last().isDisabled().catch(() => false)
    await shot(win, '18-elsewhere-composer')
    check('⑦a 清单为空(手机 / 网页的样子):输入框不能发,写「只能在电脑上用」', offElsewhere && String(phElsewhere).includes('只能在电脑上用'), phElsewhere)
    await openAgents(win)
    await rosterRow(win, AGENT).click(); await sleep(1200)
    await shot(win, '19-elsewhere-profile')
    check('⑦a 清单为空:名册照样列着它,Harness 卡说明只能在装了 DSH 的电脑上对话', (await rosterRow(win, AGENT).count()) === 1 && (await win.locator('[data-engine-elsewhere]').count()) === 1)
    await win.unroute('**/agent/engines')

    // ⑦b 这台电脑没装 DSH:关掉应用,去掉台架加的 dsh 覆盖条目(内置那条要求 PATH 上有 dsh,本机没有),再起 —— 引擎自己报「未安装」
    await app.close().catch(() => {}); await sleep(2500)
    let dropped = 0
    for (const f of [path.join(HOME, 'config.json'), path.join(HOME, 'tangu', 'config.json'), path.join(HOME, 'engines.json'), path.join(HOME, 'tangu', 'engines.json')]) {
      if (!fs.existsSync(f)) continue
      let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
      const box = f.endsWith('engines.json') ? c : c.engines
      if (!box || !Array.isArray(box.engines)) continue
      const n = box.engines.length; box.engines = box.engines.filter((e) => e.id !== 'dsh'); dropped += n - box.engines.length
      fs.writeFileSync(f, JSON.stringify(c, null, 2))
    }
    let onPath = ''; try { onPath = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim() } catch { onPath = '' }
    check('前置:去掉了台架的 dsh 条目,本机 PATH 上也没有 dsh', dropped >= 1 && !onPath, `去掉 ${dropped} 条;which dsh = ${onPath || '(无)'}`)
    app = await launch()
    const w2 = await app.firstWindow({ timeout: 60_000 })
    w2.on('pageerror', (e) => pageErrors.push(e.message))
    await w2.setViewportSize({ width: 1440, height: 900 })
    await w2.waitForSelector('.dv-groupview', { timeout: 60_000 })
    await w2.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 120_000 }).catch(() => {})
    await sleep(1500)
    await openChat(w2)
    const phMissing = await w2.locator('.t2c-ta').last().getAttribute('placeholder').catch(() => '')
    const offMissing = await w2.locator('.t2c-ta').last().isDisabled().catch(() => false)
    await shot(w2, '20-not-installed-composer')
    check('⑦b 没装 DSH:输入框不能发,并写明原因', offMissing && String(phMissing).includes('没装在这台电脑上'), phMissing)
    await openAgents(w2)
    await shot(w2, '21-not-installed-roster')
    check('⑦b 没装 DSH:名册行尾有「未安装」(自带的 DSH 和改过的浣溪沙)', (await w2.locator('.agents-roster [data-engine-missing]').count()) >= 2)
    await rosterRow(w2, AGENT).click(); await sleep(1200)
    await shot(w2, '22-not-installed-profile')
    check('⑦b 没装 DSH:Harness 卡给「怎么安装」', (await w2.locator('[data-act="engine-install"]').count()) === 1)
  } finally {
    await app.close().catch(() => {})
  }
  return { pageErrors }
}

main().then(({ pageErrors }) => {
  check('没有页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' / '))
}).catch((e) => { console.error(e); check('台架跑完', false, e.message) }).finally(async () => {
  server.close()
  await sleep(3000)
  let left = ''; try { left = execFileSync('pgrep', ['-fl', R], { encoding: 'utf8' }).trim() } catch { left = '' }
  check('没有留下 DSH 进程', !left, left)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})
