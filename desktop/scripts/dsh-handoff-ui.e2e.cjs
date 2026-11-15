/**
 * 交接(DSH 融合底层第 3 步)在真应用里的样子:真 Electron × 真引擎(托管模式,本检出 tangu-agent/dist)
 * × 真 DSH(官方包 @deepseek-ai/dsh,`--profile acp`)× 本机假模型 × 隔离 home。
 *
 * 假模型(给 DSH 的 Anthropic Messages 口)照真模型的样子用桥:
 *   - 用户让它记住喝茉莉花茶 → 调 mcp__forsion__remember;
 *   - 工具回的是编号(Pending … forsion_wait {"ticket":…,"attempt":…})→ 照着调 forsion_wait;
 *   - 拿到结果 → 回一句「Saved.」。
 * 审批规则(config.json 的 approval,自定义档)要求 remember 先问;新对话的起步档是自定义(上次用的档)。
 *
 * 点验:
 *   ① 配置页:把「浣溪沙」改成由 DSH 来跑并保存,Harness 卡写明交过去什么、还交不过去什么;
 *   ② 新对话里选它,让它记住一件事 → Forsion 画出审批卡,卡上是记忆工具;
 *   ③ 过了 50 秒(超过桥的 45 秒)才批 → 模型拿到的是编号并用 forsion_wait 取,批了之后拿到结果,回答出来;
 *      工具卡由 Forsion 画(用 Tangu 的名字,没有 mcp__ 那张),记忆只写了一次、写在它名下;
 *   ④ 整窗重载后这张工具卡还在。
 *
 * 用法:先 npm run build(桌面)+ tangu-agent 的 npm run build;
 *   node scripts/dsh-handoff-ui.e2e.cjs --node <Node ≥ 24.9> --dsh <@deepseek-ai/dsh 的 lib/bin.js> --root <全新目录,不在系统临时目录下>
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

const MARK = `TEA-${1000 + Math.floor(Math.random() * 9000)}`
const stub = { dsh: 0, tickets: 0, toolNames: [], saw: [] }
// ── 假模型给 DSH 的脑子:只看最后一条消息
function dshBrain(body) {
  const msgs = body?.messages || []
  const last = msgs[msgs.length - 1] || {}
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : (last.content || [])
  const result = blocks.find((b) => b.type === 'tool_result')
  if (result) {
    const text = (Array.isArray(result.content) ? result.content.map((c) => c.text || '').join(' ') : String(result.content || ''))
    stub.saw.push(text.slice(0, 200))
    const m = text.match(/\{"ticket":"(T\d+)","attempt":(\d+)\}/)
    if (/^Pending:/.test(text) && m) { stub.tickets++; return { tool: 'mcp__forsion__forsion_wait', args: { ticket: m[1], attempt: Number(m[2]) } } }
    return { text: result.is_error ? `It failed: ${text.slice(0, 80)}` : 'Saved.' }
  }
  const said = blocks.map((b) => b.text || '').join(' ')
  if (/jasmine tea/i.test(said)) return { tool: 'mcp__forsion__remember', args: { action: 'add', fact: `The user drinks jasmine tea. ${MARK}`, scope: 'agent' } }
  return { text: 'OK' }
}
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d })
  req.on('end', () => {
    let body = null; try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    const p = (req.url || '').split('?')[0]
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.method === 'GET' && /\/models$/.test(p)) return json({ object: 'list', data: [{ id: 'judge', object: 'model' }] })
    if (req.method === 'POST' && /\/messages\/count_tokens$/.test(p)) return json({ input_tokens: 10 })
    if (req.method === 'POST' && /\/chat\/completions$/.test(p)) {
      const base = { id: 'chatcmpl_1', created: Math.floor(Date.now() / 1000), model: body?.model || 'judge' }
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      if (!body?.stream) return json({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`)
      chunk({ role: 'assistant', content: 'OK' }); chunk({}, 'stop', { usage }); res.write('data: [DONE]\n\n'); return res.end()
    }
    if (!(req.method === 'POST' && /\/messages$/.test(p))) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `stub: no such route ${p}` } })) }
    const withTools = Array.isArray(body?.tools) && body.tools.length > 0
    if (withTools) { stub.dsh++; if (!stub.toolNames.length) stub.toolNames = body.tools.map((t) => t.name) }
    const step = withTools ? dshBrain(body) : { text: 'check session' }
    const blocks = step.tool ? [{ type: 'tool_use', id: `toolu_${stub.dsh}_${Date.now() % 100000}`, name: step.tool, input: step.args }] : [{ type: 'text', text: step.text }]
    const stop = step.tool ? 'tool_use' : 'end_turn'
    const msg = { id: `msg_${stub.dsh}`, type: 'message', role: 'assistant', model: body?.model || 'stub', stop_reason: null, stop_sequence: null }
    if (!body?.stream) return json({ ...msg, content: blocks, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { ...msg, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
    blocks.forEach((b, index) => {
      if (b.type === 'text') { ev('content_block_start', { index, content_block: { type: 'text', text: '' } }); ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } }) }
      else { ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }); ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }) }
      ev('content_block_stop', { index })
    })
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })
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
  // 自定义审批档:基础照自动编辑,remember 一律先问
  const config = { approval: { base: 'auto-edit', ask: ['remember'] } }
  for (const dir of [HOME, D('app', 'tangu')]) {
    fs.writeFileSync(path.join(dir, 'engines.json'), JSON.stringify(engines, null, 2))
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))
  }
  fs.writeFileSync(path.join(VAULT, 'welcome.md'), '# check\n')
  for (const dir of [D('app', 'userdata'), D('app', 'userdata-dev')]) {
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: VAULT, localVault: VAULT }))
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', sandbox: 'none', browserEnabled: false, unitHostEnabled: false, defaultWorkspaceDir: WS, modelId: 'stubjudge/judge', lastApprovalMode: 'custom' }))
  }
}
const agentDirs = (slug) => [path.join(HOME, 'agents', slug), path.join(HOME, 'tangu', 'agents', slug)]
const memoryOf = (slug) => agentDirs(slug).map((d) => path.join(d, 'MEMORY.md')).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n')

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
  await win.locator('.agent-select-strip .compact-chat-picker').first().click()
  const row = win.locator('.chat-pick-row', { has: win.locator('.chat-pick-name', { hasText: name }) }).first()
  await row.waitFor({ timeout: 10_000 })
  return row
}
async function send(win, text) {
  const ta = win.locator('.t2c-ta').last()
  await ta.click(); await ta.fill(text); await ta.press('Enter')
}
const lastAsst = (win) => win.evaluate(() => [...document.querySelectorAll('.t2-asst')].map((e) => e.innerText.trim()).pop() || '')
// Forsion 画的工具卡:普通工具在 .tool-group 里;remember 画成「记住了 N 件事」的记忆回执([data-self-receipt])
const toolHeads = (win) => win.evaluate(() => [...document.querySelectorAll('.tool-group .tool-row-head, [data-self-receipt]')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
const asstHasMcpName = (win) => win.evaluate(() => [...document.querySelectorAll('.t2-asst')].some((e) => /mcp__/.test(e.innerText)))

const AGENT = '浣溪沙' // 自带的 Aria(中文界面里的名字)

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  STUB = `http://127.0.0.1:${server.address().port}`
  prepareHome()
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(HOME, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: HOME, FORSION_WORKSPACE_DIR: WS, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1',
      TANGU_PROVIDER_ID: 'stubjudge', TANGU_PROVIDER_BASE_URL: `${STUB}/v1`, TANGU_PROVIDER_API_KEY: 'stub-not-a-real-key', TANGU_PROVIDER_MODELS: 'judge' },
  })
  const pageErrors = []
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    win.on('pageerror', (e) => pageErrors.push(e.message))
    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    check('前置:跳过首启引导', await skipOnboarding(win))
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    const ready = await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 120_000 }).then(() => true, () => false)
    check('前置:托管模式,本检出的引擎就绪', ready)

    // ① 配置页
    await openAgents(win)
    await rosterRow(win, AGENT).click(); await sleep(1200)
    await win.locator('[data-profile-field="engine"] .profile-model-trigger').first().click()
    await win.locator('[data-profile-field="engine"] [role="option"][data-value="dsh"]').first().click()
    await sleep(500)
    await win.locator('.agent-profile button.btn.primary').filter({ hasText: '保存' }).first().click()
    check('① 保存后名册里浣溪沙挂上 DSH 小标', !!(await until(async () => (await rowEngineTag(win, AGENT).count()) === 1, 15_000)))
    await sleep(600)
    const handoffText = await win.locator('[data-engine-handoff]').first().innerText().catch(() => '')
    const limitsText = await win.locator('[data-engine-handoff-limits]').first().innerText().catch(() => '')
    await win.locator('[data-engine-handoff]').first().scrollIntoViewIfNeeded().catch(() => {})
    await shot(win, '10-profile-handoff')
    check('① Harness 卡写明交过去什么(人设 / 记忆 / 技能 / Forsion 的工具 / 审批)', ['人设', '记忆', '技能', 'Forsion 的工具', '审批'].every((w) => handoffText.includes(w)), handoffText)
    check('① 也写明还交不过去的(浏览器 / 电脑 / 手机控制、定时和自动化、团队和 @)', ['浏览器', '定时', '团队'].every((w) => limitsText.includes(w)), limitsText)

    // ② 新对话里选它,让它记住一件事
    check('前置:进 Tangu', await enterSpace(win, 'tangu'))
    await sleep(1200)
    await win.getByText('新会话', { exact: true }).first().click(); await sleep(1200)
    await (await pickAgent(win, AGENT)).click(); await sleep(900)
    // 选完浮层偶尔还开着(描述区盖住输入框):按 Esc 收起,再核一次选中的是它
    if (await win.locator('.ui-popover-backdrop').count()) { await win.keyboard.press('Escape'); await sleep(500) }
    const picked = await win.locator('.agent-select-strip .compact-chat-picker').first().innerText().catch(() => '')
    await shot(win, '10b-picked')
    check('前置:选中的是它', picked.includes(AGENT), picked)
    const pill = await win.locator('.mode-pill-btn .t2c-pill-label').first().innerText().catch(() => '')
    check('前置:这场对话起步是自定义审批档(上次用的档)', /自定义/.test(pill), pill)
    await send(win, 'Please remember that I drink jasmine tea.')
    const card = win.locator('.approval-card:not(.resolved)').first()
    const asked = await card.waitFor({ timeout: 90_000 }).then(() => true, () => false)
    const t0 = Date.now()
    const cardText = asked ? await card.innerText().catch(() => '') : ''
    await shot(win, '11-approval-card')
    check('② Forsion 画出审批卡,卡上是记忆工具、写着要记的那句', asked && cardText.includes(MARK), cardText)
    check('② 交给 DSH 的工具里有桥的 remember 与 forsion_wait,没有桥里的读写文件 / 跑命令', stub.toolNames.includes('mcp__forsion__remember') && stub.toolNames.includes('mcp__forsion__forsion_wait') && !stub.toolNames.some((n) => /^mcp__forsion__(read_file|write_file|edit_file|run_bash)$/.test(n)), `${stub.toolNames.filter((n) => n.startsWith('mcp__forsion__')).length} 个桥工具`)

    // ③ 过了 50 秒才批
    await until(async () => Date.now() - t0 > 50_000, 60_000, 1000)
    check('③ 超过 45 秒还没批:模型收到的是编号,并用 forsion_wait 来取(没收到超时)', stub.tickets >= 1 && !stub.saw.some((s) => /timed out/i.test(s)), stub.saw.join(' || ').slice(0, 300))
    await card.locator('.approval-actions .btn.primary').first().click()
    const answered = await until(async () => /Saved\./.test(await lastAsst(win)), 60_000)
    await sleep(800)
    const heads = await toolHeads(win)
    await shot(win, '12-after-approve')
    check('③ 批了之后拿到结果,回答出来', !!answered, await lastAsst(win))
    check('③ 工具卡由 Forsion 画(记忆回执;没有 mcp__ 那张)', heads.some((h) => /记住了/.test(h)) && !(await asstHasMcpName(win)), heads.join(' | '))
    const mem = memoryOf('aria')
    check('③ 记忆只写了一次,写在它名下', mem.split(MARK).length - 1 === 1, `aria 名下 ${mem.split(MARK).length - 1} 处;xyra 名下 ${memoryOf('xyra').split(MARK).length - 1} 处`)

    // ④ 重载后工具卡还在
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
    await enterSpace(win, 'tangu'); await sleep(1500)
    const title = win.locator('aside, nav, [class*="sidebar"], [class*="side"]').getByText(/^Please remember that I d/).first()
    if (await title.count()) { await title.click(); await sleep(1800) }
    const headsAfter = await toolHeads(win)
    await shot(win, '13-after-reload')
    check('④ 重载后这张工具卡还在', headsAfter.some((h) => /记住了/.test(h)) && !(await asstHasMcpName(win)), headsAfter.join(' | '))
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
