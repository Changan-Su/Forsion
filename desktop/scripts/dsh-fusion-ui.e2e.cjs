/**
 * DSH 融合插件第 1 档在真应用里的样子:真 Electron × 真引擎(托管模式,本检出 tangu-agent/dist)× 装好的 DSH2Forsion
 * (插件包拷进隔离 home 的 plugins/,运行时软链到已装好的那份)× 官方 DSH × 本机假模型 × 隔离 home(HOME / DSH_HOME / XDG 全换)。
 *
 * 点验:
 *   ① 把「浣溪沙」改成由 DSH 来跑:Harness 卡「运行在」下面多出插件给的三行(运行时 / 更新通道 / DSH 插件);
 *   ② 和它聊一句:这一轮连的是插件常驻的那个 DSH(没有另起每轮一个的 `--profile acp` 进程),回答出来;
 *   ③ 对话右键「在 DSH 工作台里打开」→ 主区开出「DSH 工作台」页签,里面是 DSH 自己的界面,直接落在这场对话上(问和答都在);
 *      在工作台里打字接着说,DSH 回答出来;关掉页签 DSH 还在;
 *   ④ 在工作台里装 dsh-genui@0.3.3(DSH 插件页走的那个远程方法):Forsion 先弹体检报告 → 点「装」→ 装上,Harness 卡「DSH 插件」变 1 个;
 *      再在 Forsion 里和 DSH 聊一句,DSH 给模型的系统提示里带上了 genui 那一节(插件对 Forsion 的对话生效)。
 *
 * 假模型:常驻 DSH 由插件起、环境走白名单(不带 provider key),所以地址和 key 写进隔离 DSH 目录的 .env —— 和用户自己配 DSH 是同一层。
 *
 * 用法:先 npm run build(桌面)+ tangu-agent 的 npm run build + DSH2Forsion 的 npm run build;
 *   npm run e2e:dshfusion -- --plugin … 或 node scripts/dsh-fusion-ui.e2e.cjs --plugin <DSH2Forsion 的 plugin/ 目录> --runtime <装好运行时的根目录:node/ 与 runtime/>
 *        --root <全新目录,不在系统临时目录下> [--hold]
 * --hold:跑完不关应用,开 9334 调试口,等 <root>/kick 出现再收(用来对照方案图逐页截图)。截图在 <root>/shots(只留本机)。
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
const PLUGIN = opt('plugin'), RUNTIME = opt('runtime'), ROOT_ARG = opt('root'), HOLD = argv.includes('--hold')
if (!PLUGIN || !RUNTIME || !ROOT_ARG) { console.error('用法见文件头'); process.exit(2) }
for (const f of ['out/main/main.js', '../tangu-agent/dist/standalone/main.js']) if (!fs.existsSync(path.join(ROOT, f))) { console.error(`缺 ${f} —— 先 build`); process.exit(2) }
if (!fs.existsSync(path.join(PLUGIN, 'tangu-plugins/dsh2forsion/dist/index.js'))) { console.error('--plugin 要指向 DSH2Forsion 构建好的 plugin/'); process.exit(2) }
fs.mkdirSync(ROOT_ARG, { recursive: true })
const R = fs.realpathSync(ROOT_ARG)
for (const t of [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']) {
  let rt = t; try { rt = fs.realpathSync(t) } catch { /* */ }
  if (R === rt || R.startsWith(rt + path.sep)) { console.error('--root 不能在系统临时目录下面'); process.exit(2) }
}
const D = (...p) => { const d = path.join(R, ...p); fs.mkdirSync(d, { recursive: true }); return d }
const SHOTS = D('shots')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${String(detail).replace(/\s+/g, ' ').replace(/token=[^\s&"']+/g, 'token=<redacted>').slice(0, 400)}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 300) { const end = Date.now() + ms; for (;;) { let v = null; try { v = await fn() } catch { v = null } if (v) return v; if (Date.now() > end) return null; await sleep(every) } }
const START = Date.now()

const VERSION = fs.readdirSync(path.join(RUNTIME, 'runtime')).find((v) => fs.existsSync(path.join(RUNTIME, 'runtime', v, '.dsh2forsion-ready')))
const NODE = path.join(RUNTIME, 'node', fs.readdirSync(path.join(RUNTIME, 'node'))[0], 'bin', 'node')
const BIN = path.join(RUNTIME, 'runtime', VERSION, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const MARK = `WB-${1000 + Math.floor(Math.random() * 9000)}`
const stub = { calls: 0, systems: [] }
// 假模型给 DSH 的脑子:工作台里说的那句回带记号的话,其余回 OK;记下每次的系统提示(看 genui 那一节进没进来)
function dshBrain(body) {
  const sys = typeof body?.system === 'string' ? body.system : Array.isArray(body?.system) ? body.system.map((x) => x.text || '').join('\n') : ''
  stub.systems.push(sys)
  const msgs = body?.messages || []
  const last = msgs[msgs.length - 1] || {}
  const said = (typeof last.content === 'string' ? last.content : (last.content || []).map((b) => b.text || '').join(' '))
  if (/from the workbench/i.test(said)) return { text: `Workbench heard you. ${MARK}` }
  if (/hello dsh/i.test(said)) return { text: `Hello from the resident DSH. ${MARK}` }
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
    if (withTools) stub.calls++
    const step = withTools ? dshBrain(body) : { text: 'check session' }
    const msg = { id: `msg_${stub.calls}`, type: 'message', role: 'assistant', model: body?.model || 'stub', stop_reason: null, stop_sequence: null }
    if (!body?.stream) return json({ ...msg, content: [{ type: 'text', text: step.text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { ...msg, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } }); ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    ev('message_stop', {}); res.end()
  })
})

const HOME = D('app')
const WS = D('workspace'), VAULT = D('vault')
let STUB = ''
let dshEnv = null
function prepareHome() {
  dshEnv = { HOME: D('dsh-home'), DSH_HOME: D('dsh'), XDG_CACHE_HOME: D('xc'), XDG_DATA_HOME: D('xd'), XDG_STATE_HOME: D('xs'), XDG_CONFIG_HOME: D('xcfg'),
    DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_BASE_URL: STUB, DEEPSEEK_API_KEY: 'stub-not-a-real-key' }
  // 底层那条路(插件没装 / 对不上时每轮起一个 DSH)也照样能跑:同一份 DSH 目录
  const engines = { engines: [{ id: 'dsh', name: 'DeepSeek Harness', command: NODE, args: [BIN, '--profile', 'acp'], env: { PATH: `${path.dirname(NODE)}:/usr/bin:/bin`, TMPDIR: D('dsh-tmp'), ...dshEnv } }] }
  for (const dir of [HOME, D('app', 'tangu')]) fs.writeFileSync(path.join(dir, 'engines.json'), JSON.stringify(engines, null, 2))
  // 常驻那个 DSH 由插件起,环境走白名单、不带 provider key:像用户那样,把模型地址和 key 写进 DSH 目录的 .env(DSH 自己认这一层)
  fs.writeFileSync(path.join(dshEnv.DSH_HOME, '.env'), `DEEPSEEK_BASE_URL=${STUB}\nDEEPSEEK_API_KEY=stub-not-a-real-key\n`)
  fs.writeFileSync(path.join(VAULT, 'welcome.md'), '# check\n')
  for (const dir of [D('app', 'userdata'), D('app', 'userdata-dev')]) {
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: VAULT, localVault: VAULT }))
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', sandbox: 'none', browserEnabled: false, unitHostEnabled: false, defaultWorkspaceDir: WS, modelId: 'stubjudge/judge' }))
  }
  // 装 DSH2Forsion:插件包原样拷进 plugins/;引擎半身的数据目录里软链已装好的运行时(省掉 1.1 GB 下载)
  fs.cpSync(PLUGIN, path.join(HOME, 'plugins', 'dsh2forsion'), { recursive: true })
  for (const base of [HOME, path.join(HOME, 'tangu')]) {
    const data = path.join(base, 'plugin-data', 'dsh2forsion'); fs.mkdirSync(data, { recursive: true })
    for (const sub of ['node', 'runtime']) if (!fs.existsSync(path.join(data, sub))) fs.symlinkSync(path.join(RUNTIME, sub), path.join(data, sub), 'dir')
  }
}
const dshProcs = () => { try { return execFileSync('pgrep', ['-fl', R], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('dsh/lib/bin.js')) } catch { return [] } }

async function shot(win, name) { await win.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {}) }
async function openAgents(win) {
  const btn = win.locator('[data-ribbon-id="space:agents"], [data-id="space:agents"] .rb-space, [data-id="space:agents"], button[title="Agents"]').first()
  if (await btn.count()) await btn.click()
  else await win.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await win.locator('.agents-roster').waitFor({ timeout: 20_000 })
  await sleep(800)
}
const rosterRow = (win, name) => win.locator('.agents-roster-list .agents-roster-item').filter({ hasText: name }).first()
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
const pluginRow = (win, id) => win.locator(`[data-plugin-row="${id}"]`).first()
// 工作台里的 DSH 页面:<webview> 的客体网页(主进程里拿它的 webContents)
async function guestEval(app, code) {
  return app.evaluate(async ({ webContents }, src) => {
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()))
    if (!wc) return { none: true }
    return { value: await wc.executeJavaScript(src, true) }
  }, code)
}
async function guestType(app, text) {
  return app.evaluate(async ({ webContents }, t) => {
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()))
    if (!wc) return false
    wc.focus()
    wc.insertText(t)
    await new Promise((r) => setTimeout(r, 300))
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    return true
  }, text)
}

const AGENT = '浣溪沙'
const GENUI = 'dsh-genui@0.3.3'

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  STUB = `http://127.0.0.1:${server.address().port}`
  prepareHome()
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(HOME, 'userdata')}`, '--lang=zh-CN', ...(HOLD ? ['--remote-debugging-port=9334'] : []), ROOT],
    cwd: ROOT,
    env: { ...process.env, ...dshEnv, TANGU_HOME: HOME, FORSION_WORKSPACE_DIR: WS, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1',
      TANGU_PROVIDER_ID: 'stubjudge', TANGU_PROVIDER_BASE_URL: `${STUB}/v1`, TANGU_PROVIDER_API_KEY: 'stub-not-a-real-key', TANGU_PROVIDER_MODELS: 'judge' },
  })
  const pageErrors = []
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    win.on('pageerror', (e) => pageErrors.push(e.message))
    // 不用 setViewportSize:它在宿主页上做设备尺寸模拟,内嵌网页容器的缩放比会对不上(画成左上角四分之一),那是台架造成的
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await win.waitForSelector('#root', { timeout: 40_000 })
    check('前置:跳过首启引导', await skipOnboarding(win))
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    const ready = await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 120_000 }).then(() => true, () => false)
    check('前置:托管模式,本检出的引擎就绪', ready)
    const fused = await until(async () => dshProcs().some((l) => l.includes('--profile forsion')), 90_000, 1000)
    check('前置:装了 DSH2Forsion,随 Forsion 起了常驻的融合 DSH(--profile forsion)', fused, dshProcs().map((l) => l.replace(/^\d+ /, '').slice(-60)).join(' / '))
    check('前置:融合组合建在 DSH 目录里,是插件建的', fs.existsSync(path.join(R, 'dsh/profiles/forsion/.dsh2forsion-fusion.json')))

    // ① Harness 卡
    await openAgents(win)
    await rosterRow(win, AGENT).click(); await sleep(1200)
    await win.locator('[data-profile-field="engine"] .profile-model-trigger').first().click()
    await win.locator('[data-profile-field="engine"] [role="option"][data-value="dsh"]').first().click()
    await sleep(500)
    await win.locator('.agent-profile button.btn.primary').filter({ hasText: '保存' }).first().click()
    const rowsUp = await until(async () => (await pluginRow(win, 'runtime').count()) && /在运行/.test(await pluginRow(win, 'runtime').innerText()), 30_000, 600)
    const runtimeText = await pluginRow(win, 'runtime').innerText().catch(() => '')
    await pluginRow(win, 'runtime').scrollIntoViewIfNeeded().catch(() => {})
    await sleep(400)
    await shot(win, '20-harness-rows')
    check('① Harness 卡「运行在」下面有插件给的三行:运行时 / 更新通道 / DSH 插件', rowsUp && (await pluginRow(win, 'channel').count()) && (await pluginRow(win, 'dsh-plugins').count()), runtimeText)
    check('① 运行时一行写着版本、在运行,带「打开工作台」「重启 DSH」', /0\.2\.2-rc\.3/.test(runtimeText) && /打开工作台/.test(runtimeText) && /重启 DSH/.test(runtimeText), runtimeText)

    // ② 和它聊一句:连的是常驻那个
    check('前置:进 Tangu', await enterSpace(win, 'tangu'))
    await sleep(1200)
    await win.getByText('新会话', { exact: true }).first().click(); await sleep(1200)
    await (await pickAgent(win, AGENT)).click(); await sleep(900)
    if (await win.locator('.ui-popover-backdrop').count()) { await win.keyboard.press('Escape'); await sleep(500) }
    const perTurnBefore = dshProcs().filter((l) => l.includes('--profile acp')).length
    let perTurnSeen = 0
    const watch = setInterval(() => { perTurnSeen = Math.max(perTurnSeen, dshProcs().filter((l) => l.includes('--profile acp')).length) }, 300)
    await send(win, 'Hello DSH, please say hello.')
    const answered = await until(async () => (await lastAsst(win)).includes(MARK), 90_000)
    clearInterval(watch)
    await shot(win, '21-chat-resident')
    check('② 回答出来', !!answered, await lastAsst(win))
    check('② 这一轮连的是常驻的那个 DSH(没有另起每轮一个的 --profile acp)', perTurnBefore === 0 && perTurnSeen === 0, `每轮进程 ${perTurnSeen}`)

    // ③ 右键 → 在 DSH 工作台里打开
    const title = win.locator('aside, nav, [class*="sidebar"], [class*="side"]').getByText(/^Hello DSH, please/).first()
    await title.click({ button: 'right' }); await sleep(600)
    const item = win.getByText('在 DSH 工作台里打开', { exact: true }).first()
    const hasItem = (await item.count()) > 0
    await shot(win, '22-context-menu')
    check('③ 对话右键菜单里有「在 DSH 工作台里打开」', hasItem)
    if (hasItem) await item.click()
    const wv = await until(async () => (await win.locator('[data-d2f="workbench"] webview').count()) > 0, 30_000, 500)
    check('③ 主区开出 DSH 工作台,里面是受控网页容器', !!wv)
    const partition = await win.locator('[data-d2f="workbench"] webview').first().getAttribute('partition').catch(() => '')
    check('③ 容器在插件自己的分区里', /^persist:plugin-surface-dsh2forsion/.test(partition || ''), partition)
    // DSH 自己第一次打开时的「预览版说明」:像用户一样点「继续」(工作台不藏 DSH 的任何界面)
    const notice = await until(async () => (await guestEval(app, `(() => { const b = [...document.querySelectorAll('button')].find((e) => /^(继续|Continue)$/.test((e.textContent || '').trim())); b?.click(); return !!b })()`)).value, 15_000, 600)
    if (notice) await sleep(800)
    // 落点:工作台直接打开这场对话 —— 看得到 ② 那一问和 DSH 的回答,不只是列表里的标题
    const listed = await until(async () => { const r = await guestEval(app, 'document.body.innerText'); return r.value && r.value.includes('Hello DSH, please say hello.') && r.value.includes(MARK) ? r.value : null }, 30_000, 800)
    await sleep(1000)
    await shot(win, '23-workbench')
    check('③ 工作台里是 DSH 自己的界面,直接落在这场 Forsion 对话上(问和答都在)', !!listed, notice ? '点过 DSH 的预览版说明' : '')
    const focused = await guestEval(app, `(() => { const ta = document.querySelector('textarea, [contenteditable="true"]'); ta?.focus(); return !!ta })()`)
    const typed = focused.value && await guestType(app, 'One more line from the workbench.')
    const heard = typed && await until(async () => { const r = await guestEval(app, 'document.body.innerText'); return r.value && r.value.includes(`Workbench heard you. ${MARK}`) }, 60_000, 800)
    await shot(win, '24-workbench-typed')
    check('③ 在工作台里打字接着说,DSH 回答出来(这场对话就是 Forsion 那场)', !!heard, typed ? '' : '没找到输入框')

    // ④ 在工作台里装 dsh-genui:Forsion 先给体检报告
    const reqId = `ui-${Date.now()}`
    void guestEval(app, `fetch('/api/pluginManager/installBundle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: '${reqId}', method: 'pluginManager/installBundle', payload: { args: { spec: '${GENUI}', options: { enabled: true, requestId: '${reqId}' } } } }) }).then((r) => r.json()).then((j) => { window.__d2fInstall = j; return true })`)
    const card = win.locator('[data-d2f="review"]').first()
    const checking = await until(async () => /正在体检/.test(await card.innerText().catch(() => '')), 20_000, 400)
    await shot(win, '25-review-checking')
    check('④ 工作台里点安装后,Forsion 先体检(安装被停住)', !!checking)
    const report = await until(async () => { const t = await card.innerText().catch(() => ''); return /要装 dsh-genui/.test(t) ? t : null }, 240_000, 1000)
    await shot(win, '26-review-report')
    // 观感:体检卡浮在工作台上,不能把里面的 DSH 网页撑宽(第 2 轮截图里报告出来后网页右边被裁掉)
    const geo = await win.evaluate(() => {
      const r = (q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return { w: Math.round(b.width), x: Math.round(b.x) } }
      return { space: r('[data-d2f="workbench"]'), surface: r('[data-d2f="workbench"] .d2f-surface'), webview: r('[data-d2f="workbench"] webview'), card: r('[data-d2f="review"]') }
    })
    const guestW = (await guestEval(app, 'window.innerWidth')).value
    check('④ 体检卡出现时工作台里的网页没被撑宽', !!geo.surface && !!geo.webview && Math.abs(geo.webview.w - geo.surface.w) <= 2 && Math.abs((guestW || 0) - geo.surface.w) <= 2, JSON.stringify({ ...geo, guestW }))
    check('④ 体检报告:工具、提示词字数、没启动的部分、启动时的外连', !!report && /工具/.test(report) && /提示词多了 \d+ 字/.test(report) && /启动/.test(report) && /外部主机/.test(report), report)
    await card.locator('[data-act="review-allow"]').click()
    const installed = await until(async () => { const r = await guestEval(app, 'window.__d2fInstall || null'); return r.value }, 120_000, 1000)
    check('④ 点「装」后装上了', installed?.result?.ok === true, JSON.stringify(installed?.result?.error || '').slice(0, 200))
    // 工作台里 DSH 自己的插件页(只截图,和第三轮方案图 round3-3 对照):装上的 genui 在列表里
    const toPlugins = await guestEval(app, `(() => { const hit = [...document.querySelectorAll('*')].find((e) => /^(插件|Plugins)$/.test((e.textContent || '').trim()) && e.getClientRects().length && !e.closest('[data-d2f]')); const el = hit?.closest('button, a, [role="button"], [role="menuitem"], [role="treeitem"], li') || hit; el?.click(); return el ? el.tagName + ' ' + (el.getAttribute('role') || '') : '' })()`)
    await sleep(2500)
    await shot(win, '26b-dsh-plugin-page')
    const pluginPage = (await guestEval(app, 'document.body.innerText')).value || ''
    check('④ 工作台里 DSH 自己的插件页列着刚装的 genui', /genui/i.test(pluginPage), toPlugins.value || '没找到「插件」入口')
    // Harness 卡「DSH 插件」变 1 个
    await openAgents(win); await rosterRow(win, AGENT).click(); await sleep(1500)
    const count = await until(async () => { const t = await pluginRow(win, 'dsh-plugins').innerText().catch(() => ''); return /1 个/.test(t) ? t : null }, 20_000, 800)
    await shot(win, '27-harness-after-install')
    check('④ Harness 卡「DSH 插件」变成 1 个', !!count, count)
    // 在 Forsion 里再聊一句:DSH 给模型的系统提示里带上了 genui 那一节
    await enterSpace(win, 'tangu'); await sleep(1000)
    const before = stub.systems.length
    await win.getByText('新会话', { exact: true }).first().click(); await sleep(1000)
    await (await pickAgent(win, AGENT)).click(); await sleep(800)
    if (await win.locator('.ui-popover-backdrop').count()) { await win.keyboard.press('Escape'); await sleep(500) }
    await send(win, 'Hello DSH again, please say hello.')
    await until(async () => stub.systems.length > before && (await lastAsst(win)).includes(MARK), 90_000)
    const sys = stub.systems.slice(before).join('\n')
    check('④ 装上后 Forsion 里和 DSH 的对话用上了它(系统提示里有 genui 那一节)', /genui/i.test(sys), `${sys.length} 字`)
    check('前置:工作台页签关不关都不影响,DSH 一直是同一个进程', dshProcs().filter((l) => l.includes('--profile forsion')).length === 1)

    if (HOLD) {
      console.log(`HOLD:应用开着,调试口 9334;touch ${path.join(R, 'kick')} 收尾`)
      await until(async () => fs.existsSync(path.join(R, 'kick')), 90 * 60_000, 1000)
    }
  } finally {
    await app.close().catch(() => {})
  }
  return { pageErrors }
}

main().then(({ pageErrors }) => {
  check('没有页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' / '))
}).catch((e) => { console.error(e); check('台架跑完', false, e.message) }).finally(async () => {
  server.close()
  await sleep(4000)
  const left = dshProcs()
  check('Forsion 退出后没有留下 DSH 进程', !left.length, left.join(' / '))
  check('真实的 ~/.dsh 与 ~/.agents 没被这次运行写过', ['.dsh', '.agents'].every((d) => { try { return fs.statSync(path.join(os.homedir(), d)).mtimeMs < START } catch { return true } }))
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})
