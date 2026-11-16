/**
 * DSH 融合插件第 1 档在真应用里的样子:真 Electron × 真引擎(托管模式,本检出 tangu-agent/dist)× 装好的 DSH2Forsion
 * (插件包拷进隔离 home 的 plugins/,运行时软链到已装好的那份)× 官方 DSH × 本机假模型 × 隔离 home(HOME / DSH_HOME / XDG 全换)。
 *
 * 点验:
 *   ① 把「浣溪沙」改成由 DSH 来跑:Harness 卡「运行在」下面多出插件给的三行(运行时 / 更新通道 / DSH 插件);
 *   ② 和它聊一句:这一轮连的是插件常驻的那个 DSH(没有另起每轮一个的 `--profile acp` 进程),回答出来;
 *   ③ 对话右键「在 DSH 工作台里打开」→ 主区开出「DSH 工作台」页签,里面是 DSH 自己的界面,直接落在这场对话上(问和答都在);
 *      在工作台里打字接着说,DSH 回答出来;工作台开着时再右键,页面不重载(只换 # 那段);回到 Forsion 同一场再发一句,
 *      DSH 那边是同一场(上文里有工作台那一句);关掉工作台页签,从 Harness 卡「打开工作台」进,看得到这场并接着说;
 *   ④ 在工作台里装 dsh-genui@0.3.3(DSH 插件页走的那个远程方法):Forsion 先弹体检报告 → 点「装」→ 装上,Harness 卡「DSH 插件」变 1 个;
 *      再在 Forsion 里和 DSH 聊一句,DSH 给模型的系统提示里带上了 genui 那一节(插件对 Forsion 的对话生效);要一张卡,
 *      右键这场在工作台里看,DSH 自己把它画成了卡片;工作台页签在前面时右键另一场,同一个页面里落到那场。
 *   ⑤ 整页重新载入时带着落点(重开工作台、DSH 重启都走这条),在两场之间来回切 8 次,每次都落在要的那场(DSH 自己恢复上次那场
 *      不能把落点盖回去)。
 *
 *   ⑥(--approvals,审批 B)DSH 自己的审批:先在工作台装 @michengai/dsh-skills-manager@1.4.6(要重启 DSH);
 *      Forsion 发的轮里提权写文件、create_skill 都弹 Forsion 的审批卡,批准 / 拒绝都管用;工作台发的轮审批留在工作台,Forsion 的托盘
 *      里什么都没有;两边同时有待批的,各回各的。
 *   ⑦(--approvals-fallback)故意让桥的自检对不上(DSH2FORSION_APPROVAL_EVENT 改事件名):Forsion 的轮不接管,托盘里是
 *      「DSH 在工作台里等你批准」+「打开工作台」,点了落到那场、在工作台里批,Forsion 那一轮接着跑完、提示撤掉。
 *
 *   ⑧(--rail,第 2 档右栏页)装测试用的右栏页插件(DSH2Forsion tests/fixtures/rail-page,用 DSH 自己的 `plugin add`)、重启 DSH;
 *      DSH 跑的对话右栏「详情 / 文件 / 大纲」后面多一页 DSH(前台不动)→ 点开是 DSH 的文件页 → 在它自己那排页签里开插件页
 *      → 换到 Tangu 的新对话这页就关 → 回到 DSH 那场它回来、前台不抢,点开还是刚才那页插件页 → 选了 DSH Agent 还没发的新对话:说明。
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
const MODE = argv.includes('--approvals-fallback') ? 'fallback' : argv.includes('--approvals') ? 'approvals' : 'full'
const RAIL = argv.includes('--rail')
const RAIL_FIXTURE = opt('rail-fixture') || path.join(PLUGIN || '.', '..', 'tests', 'fixtures', 'rail-page')
const RAIL_TYPE = 'plugin:dsh2forsion:rail'
const RENAMED_EVENT = 'approval/request-renamed-by-e2e'
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
const stub = { calls: 0, systems: [], tools: new Map(), seq: 0 }
// ⑥ / ⑦ 的剧本:「WRITE <名>」往工作区外写(沙箱拒)→ 带提权再写(DSH 要问审批)→ 按结果回 WROTE / NOT-WRITTEN;
// 「SKILL <名>」→ create_skill(skills-manager 在 tools/pre-execute 里要问审批)→ 回 SKILL-DONE / SKILL-REFUSED
const OUTSIDE = D('outside')
const toolStep = (name, input, meta) => { const id = `toolu_e2e_${++stub.seq}`; stub.tools.set(id, meta); return { tool: { id, name, input } } }
function approvalBrain(last, said) {
  const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []
  // 被取消的上一轮的工具结果会和新的一句并在同一条 user 消息里:新口令优先
  if (results.length && !/(WRITE|SKILL) \S+/.test(said)) {
    const r = results[results.length - 1]
    const meta = stub.tools.get(r.tool_use_id)
    if (!meta) return null
    const out = (Array.isArray(r.content) ? r.content.map((x) => x.text || '').join(' ') : String(r.content || '')).slice(0, 100)
    if (meta.kind === 'write' && meta.step === 1) return toolStep('write', { file_path: path.join(OUTSIDE, meta.name), content: meta.name, sandbox_permissions: 'danger-full-access', justification: 'e2e: retry the exact write the sandbox denied' }, { kind: 'write', name: meta.name, step: 2 })
    if (meta.kind === 'write') return { text: `${r.is_error ? 'NOT-WRITTEN' : 'WROTE'} ${meta.name}: ${out}` }
    if (meta.kind === 'skill') return { text: `${r.is_error ? 'SKILL-REFUSED' : 'SKILL-DONE'} ${meta.name}: ${out}` }
  }
  let m
  if ((m = said.match(/WRITE (\S+)/))) return toolStep('write', { file_path: path.join(OUTSIDE, m[1]), content: m[1] }, { kind: 'write', name: m[1], step: 1 })
  if ((m = said.match(/SKILL (\S+)/))) return toolStep('create_skill', { name: m[1], description: `E2E skill ${m[1]}`, body: `# ${m[1]}\nAn e2e skill.` }, { kind: 'skill', name: m[1] })
  return null
}
// 假模型给 DSH 的脑子:工作台里说的那句回带记号的话,其余回 OK;记下每次的系统提示(看 genui 那一节进没进来)
function dshBrain(body) {
  const sys = typeof body?.system === 'string' ? body.system : Array.isArray(body?.system) ? body.system.map((x) => x.text || '').join('\n') : ''
  stub.systems.push(sys)
  const msgs = body?.messages || []
  const last = msgs[msgs.length - 1] || {}
  const said = (typeof last.content === 'string' ? last.content : (last.content || []).filter((b) => b.type === 'text' || b.text).map((b) => b.text || '').join(' '))
  const scripted = approvalBrain(last, said)
  if (scripted) return scripted
  if (/from the workbench/i.test(said)) return { text: `Workbench heard you. ${MARK}` }
  if (/back in forsion/i.test(said)) { stub.sawWorkbenchLine = JSON.stringify(msgs).includes('One more line from the workbench'); return { text: `Back in Forsion. ${MARK}` } }
  if (/from the card/i.test(said)) return { text: `Card path heard you. ${MARK}` }
  // genui 装上后:回一张 genui 卡(和第三轮方案实测同一个格式),工作台里 DSH 自己把它画成卡片
  if (/show me a card/i.test(said)) return { text: '这是一张卡片：\n```schemaJson\n' + JSON.stringify({ componentName: 'Page', state: {}, children: [{ componentName: 'h3', children: 'GENUI_PROBE_CARD' }, { componentName: 'p', children: 'rendered by dsh-genui' }] }) + '\n```' }
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
    const stop = step.tool ? 'tool_use' : 'end_turn'
    if (!body?.stream) return json({ ...msg, content: step.tool ? [{ type: 'tool_use', ...step.tool }] : [{ type: 'text', text: step.text }], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { ...msg, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
    if (step.tool) { ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: step.tool.id, name: step.tool.name, input: {} } }); ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } }) }
    else { ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } }) }
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })
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
  // 右栏的文件页要有东西可看(⑧)
  fs.writeFileSync(path.join(WS, 'README.md'), '# Release check\n')
  fs.mkdirSync(path.join(WS, 'docs'), { recursive: true }); fs.writeFileSync(path.join(WS, 'docs', 'notes.md'), '# Notes\n')
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

// 截图走 Electron 原生 capturePage。Playwright 的 win.screenshot() 截图那几十毫秒会把工作台 <webview> 里网页的视口改成整窗大小
// (1440×900)再改回来,赶上那一帧截到的就是「DSH 网页右边被裁掉」(11-16 量到:每次截图正好一对视口跳变,宿主盒子从没变过;
// 第 2 / 14 / 16 轮和观测第 4 轮的裁切都是这么来的,用户那边没有)。拿不到原生窗口时才退回 Playwright
let APP = null
async function shot(win, name) {
  const file = path.join(SHOTS, `${name}.png`)
  try {
    if (APP) {
      const b64 = await (await APP.browserWindow(win)).evaluate(async (w) => (await w.capturePage()).toPNG().toString('base64'))
      fs.writeFileSync(file, Buffer.from(b64, 'base64')); return
    }
  } catch { /* 退回 Playwright */ }
  await win.screenshot({ path: file }).catch(() => {})
}
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
  return app.evaluate(async ({ webContents, session }, src) => {
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()) && w.session !== session.fromPartition('persist:plugin-surface-dsh2forsion-rail'))
    if (!wc) return { none: true }
    return { value: await wc.executeJavaScript(src, true) }
  }, code)
}
async function guestType(app, text) {
  return app.evaluate(async ({ webContents, session }, t) => {
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()) && w.session !== session.fromPartition('persist:plugin-surface-dsh2forsion-rail'))
    if (!wc) return false
    wc.focus()
    wc.insertText(t)
    await new Promise((r) => setTimeout(r, 300))
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    return true
  }, text)
}
// 按文字找网页里最里层的那个元素,用真实的鼠标事件点它的中心(DSH 侧栏不吃 element.click())
async function guestClickText(app, pattern) {
  const pt = (await guestEval(app, `(() => { const re = ${pattern}; const hit = [...document.querySelectorAll('body *')].filter((e) => re.test((e.textContent || '').trim()) && e.getClientRects().length).pop(); if (!hit) return null; const b = hit.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), tag: hit.tagName } })()`)).value
  if (!pt) return null
  await app.evaluate(({ webContents, session }, p) => {
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()) && w.session !== session.fromPartition('persist:plugin-surface-dsh2forsion-rail'))
    if (!wc) return
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  }, pt)
  return pt
}

// 右栏那页 DSH(第 2 档):同样是 <webview>,地址 # 里带 d2f-rail=
async function railEval(app, code) {
  return app.evaluate(async ({ webContents, session }, src) => {
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && w.session === session.fromPartition('persist:plugin-surface-dsh2forsion-rail'))
    if (!wc) return { none: true }
    return { value: await wc.executeJavaScript(src, true) }
  }, code)
}
async function railClick(app, selectorJs) {
  const pt = (await railEval(app, `(() => { const e = (${selectorJs})(); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)).value
  if (!pt) return null
  await app.evaluate(({ webContents, session }, p) => {
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && w.session === session.fromPartition('persist:plugin-surface-dsh2forsion-rail'))
    if (!wc) return
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  }, pt)
  return pt
}
/** 右栏的页签(按顺序):类型 + 是不是前台。右栏在窗口右半边。 */
const rightTabs = (win) => win.evaluate(() => [...document.querySelectorAll('.dv-tab')].filter((t) => t.getBoundingClientRect().x > innerWidth * 0.55 && t.getBoundingClientRect().width > 0)
  .map((t) => ({ type: t.querySelector('.wb-tab')?.getAttribute('data-view-type') || '', active: t.classList.contains('dv-active-tab') })))
async function clickRightTab(win, type) {
  const pt = await win.evaluate((type) => { const t = [...document.querySelectorAll('.dv-tab')].find((x) => x.querySelector('.wb-tab')?.getAttribute('data-view-type') === type && x.getBoundingClientRect().x > innerWidth * 0.55); if (!t) return null; const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }, type)
  if (pt) await win.mouse.click(pt.x, pt.y)
  return !!pt
}
const railText = async (app) => (await railEval(app, 'document.body.innerText')).value || ''

const AGENT = '浣溪沙'
const GENUI = 'dsh-genui@0.3.3'

// ⑥ / ⑦ 的小工具:Forsion 对话里的审批托盘、工作台(客体网页)里 DSH 自己的审批卡
const SKILLS_MANAGER = '@michengai/dsh-skills-manager@1.4.6'
const sidebarTitle = (win, re) => win.locator('aside, nav, [class*="sidebar"], [class*="side"]').getByText(re).first()
const trayState = (win) => win.evaluate(() => {
  const b = document.querySelector('.t2c-apv')
  if (!b) return { n: 0, kind: '', text: '', notice: '', action: '' }
  return { n: Number(b.getAttribute('data-approval-tray')) || 0, kind: b.querySelector('.t2c-apv-body')?.getAttribute('data-tray-kind') || '', text: b.innerText.replace(/\s+/g, ' ').trim(),
    notice: b.querySelector('[data-engine-notice]')?.innerText.replace(/\s+/g, ' ').trim() || '', action: b.querySelector('[data-engine-notice-action]')?.getAttribute('data-engine-notice-action') || '' }
})
const streamText = (win) => win.evaluate(() => document.querySelector('.t2-stream')?.innerText || '')
// 上一轮刚答完时输入框可能还没放开:发出去后流里没出现这句就再发一次
async function sendSure(win, text) {
  const count = async () => (await streamText(win)).split(text).length - 1
  const before = await count()
  await sleep(1500)
  await send(win, text)
  if (await until(async () => (await count()) > before, 6_000, 300)) return true
  await sleep(2000); await send(win, text)
  return !!(await until(async () => (await count()) > before, 6_000, 300))
}
async function decideInTray(win, action) {
  const btn = win.locator(`.t2c-apv .t2c-apv-body[data-tray-kind="approval"] .btn.${action === 'approve' ? 'primary' : 'danger'}`).first()
  await btn.waitFor({ timeout: 30_000 })
  await sleep(700) // 托盘按钮出现后 350ms 才接收点击(防误点)
  await btn.click()
}
const guestPending = async (app) => (await guestEval(app, `document.querySelectorAll('[data-approval-key]').length`)).value || 0
const guestText = async (app) => (await guestEval(app, 'document.body.innerText')).value || ''
async function openInWorkbench(app, win, titleRe, landedText) {
  await sidebarTitle(win, titleRe).click({ button: 'right' }); await sleep(600)
  await win.getByText('在 DSH 工作台里打开', { exact: true }).first().click()
  await until(async () => (await win.locator('[data-d2f="workbench"] webview').count()) > 0, 30_000, 500)
  const notice = await until(async () => (await guestEval(app, `(() => { const b = [...document.querySelectorAll('button')].find((e) => /^(继续|Continue)$/.test((e.textContent || '').trim())); b?.click(); return !!b })()`)).value, 4_000, 500)
  if (notice) await sleep(800)
  return !!(await until(async () => (await guestText(app)).includes(landedText), 30_000, 700))
}
async function typeInWorkbench(app, text) {
  await guestEval(app, `(() => { const ta = document.querySelector('textarea, [contenteditable="true"]'); ta?.focus(); return !!ta })()`)
  return guestType(app, text)
}
// 像用户那样点页签(元素的 .click() 不切页签;客体网页藏着也收得到输入事件,所以要另核工作台真的在前面)
async function toWorkbenchTab(win) {
  await win.locator('.wb-tab', { has: win.locator('.wb-tab-name', { hasText: 'DSH 工作台' }) }).first().click()
  return !!(await until(async () => (await win.locator('[data-d2f="workbench"] webview').first().isVisible().catch(() => false)), 5_000, 250))
}
const outside = (name) => fs.existsSync(path.join(OUTSIDE, name))
const skillAt = (name) => fs.existsSync(path.join(R, 'dsh', 'skills', name))

// ⑥ / ⑦:审批 B。进来时已在 Tangu 里新开了和「浣溪沙」(由 DSH 跑)的对话。
async function approvalsWalk(app, win, guestLogs) {
  const failLogs = async () => (await guestLogs()).slice(-12).join(' | ')
  // A 那场:先聊一句,标题固定下来
  check(`${MODE === 'fallback' ? '⑦' : '⑥'} 前置:和 DSH 聊一句`, await sendSure(win, 'Hello DSH, please say hello.') && !!(await until(async () => (await lastAsst(win)).includes(MARK), 90_000)), await lastAsst(win))

  if (MODE === 'fallback') {
    // ⑦ 自检对不上(事件名被改):Forsion 的轮不接管,托盘里是「DSH 在工作台里等你批准」+「打开工作台」
    await sendSure(win, 'WRITE e2e-fallback.txt')
    const noticed = await until(async () => { const t = await trayState(win); return t.notice ? t : null }, 60_000, 400)
    await shot(win, '40-fallback-notice')
    check('⑦ 自检对不上时 Forsion 的轮不接管:托盘里是「DSH 在工作台里等你批准」', !!noticed && /DSH 在工作台里等你批准/.test(noticed.notice) && noticed.kind === 'notice', JSON.stringify(noticed) + ' ' + await failLogs())
    check('⑦ 提示带「打开工作台」按钮(插件登记的对话菜单项)', noticed?.action === 'open-in-workbench' && /打开工作台/.test(noticed.notice), JSON.stringify(noticed))
    await sleep(700)
    await win.locator('.t2c-apv [data-engine-notice-action]').first().click()
    await until(async () => (await win.locator('[data-d2f="workbench"] webview').count()) > 0, 30_000, 500)
    const notice = await until(async () => (await guestEval(app, `(() => { const b = [...document.querySelectorAll('button')].find((e) => /^(继续|Continue)$/.test((e.textContent || '').trim())); b?.click(); return !!b })()`)).value, 6_000, 500)
    if (notice) await sleep(800)
    const waiting = await until(async () => (await guestPending(app)) > 0, 30_000, 700)
    await shot(win, '41-fallback-workbench')
    check('⑦ 点「打开工作台」:落到这场,DSH 自己的审批卡在工作台里等着', !!waiting && (await guestText(app)).includes('WRITE e2e-fallback.txt'), await failLogs())
    const clicked = await guestClickText(app, '/^允许一次$/')
    const wrote = await until(async () => (await guestText(app)).includes('WROTE e2e-fallback.txt'), 60_000, 700)
    check('⑦ 在工作台里批准:文件写上了', !!clicked && !!wrote && outside('e2e-fallback.txt'), clicked ? '' : '没找到「允许一次」')
    await sidebarTitle(win, /^Hello DSH, please/).click(); await sleep(1500)
    const finished = await until(async () => /WROTE e2e-fallback\.txt/.test(await lastAsst(win)), 30_000, 500)
    const after = await trayState(win)
    await shot(win, '42-fallback-done')
    check('⑦ Forsion 那一轮接着跑完(没有无声停住),提示撤掉了', !!finished && !after.notice, `${await lastAsst(win)} | 托盘 ${JSON.stringify(after)}`)
    return
  }

  // ⑥-0 在工作台里装 skills-manager(插件页走的远程方法 → 体检 → 放行),它要重启 DSH 才加载
  check('⑥ 前置:工作台落在 A 那场', await openInWorkbench(app, win, /^Hello DSH, please/, MARK), await failLogs())
  const card = win.locator('[data-d2f="review"]').first()
  const installSkm = async () => {
    const reqId = `ui-${Date.now()}`
    await guestEval(app, 'window.__d2fInstall = null')
    void guestEval(app, `fetch('/api/pluginManager/installBundle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: '${reqId}', method: 'pluginManager/installBundle', payload: { args: { spec: '${SKILLS_MANAGER}', options: { enabled: true, requestId: '${reqId}' } } } }) }).then((r) => r.json()).then((j) => { window.__d2fInstall = j; return true })`)
  }
  // skills-manager 1.4.6 带 koffi 的构建脚本,DSH 0.2.2 的 pnpm 11 不跑没允许过的构建脚本。产品不替用户允许:
  // 体检卡写明要跑原生构建脚本、这次会装不上、去 DSH 插件页「允许这些脚本并重试」,装好后可能要「重启 DSH」。这里按「不装」
  await installSkm()
  const needs = await until(async () => { const t = await card.innerText().catch(() => ''); return /要装 /.test(t) ? t : null }, 300_000, 1000)
  await shot(win, '30a-skm-review-needs-build')
  check('⑥ 前置:体检卡写明要跑 koffi 的原生构建脚本、没允许这次装不上、去 DSH 插件页允许、装好可能要重启 DSH', !!needs && /要跑原生构建脚本: koffi@3\.1\.1/.test(needs) && /允许这些脚本并重试/.test(needs) && /重启 DSH/.test(needs), needs)
  if (needs) await card.locator('[data-act="review-deny"]').click()
  await until(async () => (await guestEval(app, 'window.__d2fInstall || null')).value, 30_000, 500)
  // 和 test:approvals 一样由测试替用户选「不跑它的构建脚本」(koffi 自带预编译;只写在这个临时目录里,不是产品缺省),再装一次
  fs.writeFileSync(path.join(R, 'dsh/profiles/forsion/pnpm-workspace.yaml'), 'allowBuilds:\n  koffi: false\n')
  await installSkm()
  const report = await until(async () => { const t = await card.innerText().catch(() => ''); return /要装 /.test(t) && /不跑这些构建脚本/.test(t) ? t : null }, 300_000, 1000)
  await shot(win, '30-skm-review')
  check('⑥ 前置:工作台里装 skills-manager,Forsion 先给体检报告(写明按组合设置不跑 koffi 的构建脚本)', !!report && /koffi@3\.1\.1/.test(report), report)
  if (report) await card.locator('[data-act="review-allow"]').click()
  const installed = await until(async () => (await guestEval(app, 'window.__d2fInstall || null')).value, 180_000, 1000)
  const application = installed?.result?.value?.application ?? installed?.result?.application
  check('⑥ 前置:skills-manager 装上了', installed?.result?.ok === true && application !== 'failed', JSON.stringify(installed?.result ?? installed).slice(0, 300))
  // 重启 DSH:Harness 卡上的「重启 DSH」
  const pidOf = () => dshProcs().filter((l) => l.includes('--profile forsion')).map((l) => l.split(' ')[0]).join(',')
  const oldPid = pidOf()
  await openAgents(win); await rosterRow(win, AGENT).click(); await sleep(1500)
  await pluginRow(win, 'runtime').locator('button', { hasText: '重启 DSH' }).first().click()
  const restarted = await until(async () => { const p = pidOf(); return p && p !== oldPid && !p.includes(',') && /在运行/.test(await pluginRow(win, 'runtime').innerText().catch(() => '')) ? p : null }, 90_000, 1000)
  check('⑥ 前置:Harness 卡「重启 DSH」后是新的一个常驻进程', !!restarted, `${oldPid} → ${pidOf()}`)
  await sleep(4000) // 桥的自检在 DSH 起来 3 秒后跑一次(接管时还会再判)

  // ⑥-1 B 那场:Forsion 发的轮里提权写文件 / create_skill,弹 Forsion 的审批卡,批准 / 拒绝都管用
  await enterSpace(win, 'tangu'); await sleep(1000)
  await win.getByText('新会话', { exact: true }).first().click(); await sleep(1000)
  await (await pickAgent(win, AGENT)).click(); await sleep(800)
  if (await win.locator('.ui-popover-backdrop').count()) { await win.keyboard.press('Escape'); await sleep(500) }
  check('⑥ 前置:B 那场聊一句', await sendSure(win, 'Hello DSH, this is the approvals chat.') && !!(await until(async () => (await lastAsst(win)).includes(MARK), 90_000)), await lastAsst(win))
  const turns = [
    ['WRITE e2e-allow.txt', 'approve', /WROTE e2e-allow\.txt/, () => outside('e2e-allow.txt'), '提权写文件,批准:写上了'],
    ['WRITE e2e-reject.txt', 'reject', /NOT-WRITTEN e2e-reject\.txt/, () => !outside('e2e-reject.txt'), '提权写文件,拒绝:没写'],
    ['SKILL e2e-skill-allow', 'approve', /SKILL-DONE e2e-skill-allow/, () => skillAt('e2e-skill-allow'), 'skills-manager 的 create_skill(插件审批),批准:技能建好了'],
    ['SKILL e2e-skill-reject', 'reject', /SKILL-REFUSED e2e-skill-reject/, () => !skillAt('e2e-skill-reject'), 'create_skill,拒绝:没建'],
  ]
  let n = 0
  for (const [say, decision, answerRe, effect, label] of turns) {
    n++
    const sent = await sendSure(win, say)
    const asked = await until(async () => { const t = await trayState(win); return t.kind === 'approval' ? t : null }, 60_000, 400)
    if (n === 1 || n === 3) await shot(win, `3${n}-forsion-card`)
    if (asked) await decideInTray(win, decision)
    const answered = await until(async () => answerRe.test(await lastAsst(win)), 60_000, 500)
    check(`⑥ Forsion 的轮,${label}(审批卡弹在 Forsion)`, sent && !!asked && !!answered && effect(), `${asked ? asked.text.slice(0, 120) : '托盘里没有审批卡'} | ${await lastAsst(win)} | ${asked ? '' : await failLogs()}`)
  }

  // ⑥-2 工作台发的轮(在 B 这场,Forsion 正 hold 着):审批留在工作台,Forsion 的托盘里什么都没有
  check('⑥ 前置:工作台落在 B 那场', await openInWorkbench(app, win, /^Hello DSH, this is the/, 'this is the approvals chat'), await failLogs())
  await typeInWorkbench(app, 'WRITE e2e-workbench.txt')
  const wbWaiting = await until(async () => (await guestPending(app)) > 0, 60_000, 700)
  await shot(win, '35-workbench-own-approval')
  await sidebarTitle(win, /^Hello DSH, this is the/).click(); await sleep(2000)
  const forsionTray = await trayState(win)
  await shot(win, '36-forsion-tray-empty')
  check('⑥ 工作台发的轮:DSH 的审批卡在工作台里,Forsion 的托盘里没有', !!wbWaiting && forsionTray.n === 0 && !forsionTray.kind, `工作台待批 ${await guestPending(app)};托盘 ${JSON.stringify(forsionTray)}`)
  const wbFront = await toWorkbenchTab(win); await sleep(1200)
  await shot(win, '35b-workbench-approve')
  const clickedWb = await guestClickText(app, '/^允许一次$/')
  const wroteWb = await until(async () => (await guestText(app)).includes('WROTE e2e-workbench.txt'), 60_000, 700)
  check('⑥ 切到工作台页签(在前面)批准它:写上了', wbFront && !!clickedWb && !!wroteWb && outside('e2e-workbench.txt'), `${wbFront ? '' : '工作台没到前面;'}${clickedWb ? '' : '没找到「允许一次」'}`)

  // ⑥-3 两边同时有待批的:工作台在 A 那场等着,Forsion 在 B 那场问;各回各的
  check('⑥ 前置:工作台落在 A 那场', await openInWorkbench(app, win, /^Hello DSH, please/, MARK), await failLogs())
  await typeInWorkbench(app, 'WRITE e2e-wb-both.txt')
  const wbBoth = await until(async () => (await guestPending(app)) > 0, 60_000, 700)
  await sidebarTitle(win, /^Hello DSH, this is the/).click(); await sleep(1500)
  await sendSure(win, 'WRITE e2e-forsion-both.txt')
  const bothAsked = await until(async () => { const t = await trayState(win); return t.kind === 'approval' ? t : null }, 60_000, 400)
  await shot(win, '37-both-pending-forsion')
  check('⑥ 两边同时待批:Forsion 的托盘里只有自己这一件,工作台那件还在工作台', !!wbBoth && !!bothAsked && bothAsked.n === 1 && (await guestPending(app)) > 0, `托盘 ${JSON.stringify(bothAsked)};工作台待批 ${await guestPending(app)}`)
  if (bothAsked) await decideInTray(win, 'approve')
  const forsionDone = await until(async () => /WROTE e2e-forsion-both\.txt/.test(await lastAsst(win)), 60_000, 500)
  check('⑥ Forsion 这件在 Forsion 批完:写上了,工作台那件还等着', !!forsionDone && outside('e2e-forsion-both.txt') && !outside('e2e-wb-both.txt') && (await guestPending(app)) > 0, await lastAsst(win))
  const wbFront2 = await toWorkbenchTab(win); await sleep(1200)
  await shot(win, '38-both-pending-workbench')
  const clickedBoth = await guestClickText(app, '/^允许一次$/')
  const wroteBoth = await until(async () => (await guestText(app)).includes('WROTE e2e-wb-both.txt'), 60_000, 700)
  check('⑥ 工作台那件切到工作台批完:写上了', wbFront2 && !!clickedBoth && !!wroteBoth && outside('e2e-wb-both.txt'), `${wbFront2 ? '' : '工作台没到前面;'}${clickedBoth ? '' : '没找到「允许一次」'}`)
}

// ⑧ 第 2 档右栏页(--rail):在 DSH 跑的那场对话上走一遍(③c 之后,那场正在前台)
async function widenRail(win) {
  const sash = await win.evaluate(() => {
    const v = [...document.querySelectorAll('.wb-view--right')].find((x) => x.getBoundingClientRect().width > 0)?.getBoundingClientRect()
    if (!v || v.width >= 340) return null
    const c = [...document.querySelectorAll('.dv-sash')].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.width < 12 && b.height > 300 && Math.abs(b.x + b.width / 2 - v.x) < 14)
    return c[0] ? { x: c[0].x + c[0].width / 2, y: c[0].y + c[0].height / 2 } : null
  })
  if (!sash) return
  await win.mouse.move(sash.x, sash.y); await win.mouse.down(); await win.mouse.move(sash.x - 60, sash.y, { steps: 6 }); await win.mouse.move(sash.x - 113, sash.y, { steps: 6 }); await win.mouse.up(); await sleep(900)
}
async function railWalk(app, win) {
  const dshTitle = sidebarTitle(win, /^Hello DSH, please/)
  const railTab = (t) => t.find((x) => x.type === RAIL_TYPE)
  await dshTitle.click(); await sleep(1500)
  // 右栏收着时(新窗口的缺省)先用右上角的开关打开,和用户一样
  if ((await win.locator('.dv-edge-right').first().getAttribute('aria-pressed').catch(() => null)) !== 'true') { await win.locator('.dv-edge-right').first().click(); await sleep(1200) }
  const tabs0 = await until(async () => { const t = await rightTabs(win); return railTab(t) ? t : null }, 15_000, 500)
  await shot(win, '30-rail-tab')
  check('⑧ DSH 跑的对话:右栏自带那几页后面多一页 DSH,前台不是它', !!tabs0 && tabs0[tabs0.length - 1].type === RAIL_TYPE && !railTab(tabs0).active, JSON.stringify(await rightTabs(win)))
  // 缺省宽度下右栏的页签条放不下第四个:DSH 那页进 dockview 的「⌄N」溢出菜单。照用户那样从菜单里点它,得点得到、开得出来
  const ov = await win.evaluate(() => {
    const s = [...document.querySelectorAll('.dv-tabs-container')].find((x) => x.getBoundingClientRect().x > innerWidth * 0.55)
    const o = s?.closest('.dv-tabs-and-actions-container')?.querySelector('.dv-tabs-overflow-dropdown-root')
    const b = o?.getBoundingClientRect()
    return { cw: s?.clientWidth ?? 0, sw: s?.scrollWidth ?? 0, at: b && b.width > 0 ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null }
  })
  if (ov.at) {
    await win.mouse.click(ov.at.x, ov.at.y); await sleep(600)
    const item = await win.evaluate((type) => { const t = [...document.querySelectorAll('.dv-tab')].find((x) => x.querySelector(`[data-view-type="${type}"]`) && x.getBoundingClientRect().y > 10 && x.getBoundingClientRect().width > 0); if (!t) return null; const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }, RAIL_TYPE)
    if (item) await win.mouse.click(item.x, item.y)
    const opened = !!item && await until(async () => ((await win.locator('[data-d2f="rail"]').first().evaluate((e) => e.getBoundingClientRect().width > 0).catch(() => false)) ? true : null), 10_000, 400)
    await sleep(1500); await shot(win, '30b-rail-overflow')
    check('⑧ 缺省宽度放不下第四个页签:DSH 收进右栏的「⌄」菜单,从菜单里点得到', !!opened, `页签条 ${ov.cw}/${ov.sw}px;菜单里${item ? '有' : '没有'} DSH`)
  } else check('⑧ (缺省宽度下四个页签放得下,没有溢出菜单)', true, `页签条 ${ov.cw}/${ov.sw}px`)
  // 往后按方案图的宽度走(右栏拉宽 113px,同方案目录 shoot4.cjs),再把前台换回「详情」
  await widenRail(win)
  await clickRightTab(win, 'tangu-details'); await sleep(600)
  await clickRightTab(win, RAIL_TYPE)
  const railUp = await until(async () => (await win.locator('[data-d2f="rail"] .d2f-rail-box:not([hidden]) webview').count()) > 0, 30_000, 500)
  const filesShown = railUp && await until(async () => (/README\.md/.test(await railText(app)) ? true : null), 20_000, 700)
  await sleep(800); await shot(win, '31-rail-files')
  const railPartition = await win.locator('[data-d2f="rail"] webview').first().getAttribute('partition').catch(() => '')
  check('⑧ 点开:是 DSH 右侧栏的文件页(这场对话的工作区),开在右栏自己的分区里', !!filesShown && /dsh2forsion-rail$/.test(railPartition || ''),
    `${railPartition} | ${(await railText(app)).replace(/\s+/g, ' ').slice(0, 160)} | ${(await win.locator('[data-d2f="rail"]').innerText().catch(() => '')).slice(0, 120)}`)
  // 插件页:像用户那样在 DSH 自己那排页签点「+」(DSH 0.2.2 的标签是「新标签页」),在引导页里点测试插件那一项(或在「更多工具」里)
  const visible = 'b.getBoundingClientRect().width > 0'
  const plus = await railClick(app, `() => [...document.querySelectorAll('button[aria-label]')].find((b) => /^(新标签页|New tab)$/.test(b.getAttribute('aria-label') || '') && ${visible})`)
  await sleep(900)
  const fixtureEntry = `() => [...document.querySelectorAll('button, [role=button], [role=menuitem], a')].find((b) => /Fixture page/.test(b.textContent || '') && ${visible})`
  let entry = await railClick(app, fixtureEntry)
  if (!entry) {
    await railClick(app, `() => [...document.querySelectorAll('button, [role=button]')].find((b) => /更多工具|More tools/.test(b.textContent || '') && ${visible})`)
    await sleep(700)
    entry = await railClick(app, fixtureEntry)
  }
  const pluginShown = await until(async () => (/D2F-FIXTURE-PAGE/.test(await railText(app)) ? true : null), 15_000, 600)
  await sleep(600); await shot(win, '32-rail-plugin-page')
  check('⑧ 在 DSH 自己那排页签里开插件登记的页', !!pluginShown, `+ ${plus ? '点到' : '没找到'};入口 ${entry ? '点到' : '没找到'};${(await railText(app)).replace(/\s+/g, ' ').slice(0, 200)}`)
  // 换到 Tangu 跑的新对话:这一页关掉
  await win.getByText('新会话', { exact: true }).first().click(); await sleep(1200)
  if (railTab(await rightTabs(win))) {
    await win.locator('.agent-select-strip .compact-chat-picker').first().click(); await sleep(500)
    const names = await win.locator('.chat-pick-row .chat-pick-name').allInnerTexts()
    const other = names.find((n) => n.trim() === 'Tangu') ?? names.find((n) => n.trim() && n.trim() !== AGENT && !/DeepSeek|DSH/.test(n))
    if (other) await win.locator('.chat-pick-row', { has: win.locator('.chat-pick-name', { hasText: other }) }).first().click()
    await sleep(900)
    if (await win.locator('.ui-popover-backdrop').count()) { await win.keyboard.press('Escape'); await sleep(400) }
  }
  const gone = await until(async () => (!railTab(await rightTabs(win)) ? true : null), 8_000, 400)
  await shot(win, '33-tangu-no-rail')
  check('⑧ 换到 Tangu 跑的对话:这一页关掉', !!gone, JSON.stringify(await rightTabs(win)))
  // 回到 DSH 那场:它回来、前台不抢;点开还是刚才那页插件页(DSH 自己按会话记的)
  await dshTitle.click(); await sleep(1500)
  const tabs1 = await until(async () => { const t = await rightTabs(win); return railTab(t) ? t : null }, 10_000, 400)
  check('⑧ 回到 DSH 那场:这一页回来,前台不是它', !!tabs1 && !railTab(tabs1).active, JSON.stringify(tabs1))
  await clickRightTab(win, RAIL_TYPE)
  const remembered = await until(async () => (/D2F-FIXTURE-PAGE/.test(await railText(app)) ? true : null), 20_000, 600)
  await sleep(600); await shot(win, '34-rail-remembered')
  check('⑧ 点开还是刚才那页插件页(不跳回文件)', !!remembered, (await railText(app)).replace(/\s+/g, ' ').slice(0, 160))
  // 选了 DSH Agent、还没发的新对话:说明一句
  await win.getByText('新会话', { exact: true }).first().click(); await sleep(1200)
  await (await pickAgent(win, AGENT)).click(); await sleep(900)
  if (await win.locator('.ui-popover-backdrop').count()) { await win.keyboard.press('Escape'); await sleep(400) }
  await until(async () => (railTab(await rightTabs(win)) ? true : null), 8_000, 400)
  await clickRightTab(win, RAIL_TYPE)
  const noted = await until(async () => { const t = await win.locator('[data-d2f="rail"] .d2f-rail-note:not([hidden])').innerText().catch(() => ''); return /发一句之后/.test(t) ? t : null }, 10_000, 400)
  await sleep(400); await shot(win, '35-rail-not-started')
  check('⑧ 选了 DSH Agent、还没发的新对话:右栏写「发一句之后,这里显示 DSH 的页面」', !!noted, noted || await win.locator('[data-d2f="rail"]').innerText().catch(() => '(没有右栏页)'))
  await dshTitle.click(); await sleep(1500)
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  STUB = `http://127.0.0.1:${server.address().port}`
  prepareHome()
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(HOME, 'userdata')}`, '--lang=zh-CN', ...(HOLD ? ['--remote-debugging-port=9334'] : []), ROOT],
    cwd: ROOT,
    env: { ...process.env, ...dshEnv, TANGU_HOME: HOME, FORSION_WORKSPACE_DIR: WS, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1',
      TANGU_PROVIDER_ID: 'stubjudge', TANGU_PROVIDER_BASE_URL: `${STUB}/v1`, TANGU_PROVIDER_API_KEY: 'stub-not-a-real-key', TANGU_PROVIDER_MODELS: 'judge',
      ...(MODE === 'fallback' ? { DSH2FORSION_APPROVAL_EVENT: RENAMED_EVENT } : {}) },
  })
  APP = app
  const pageErrors = []
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    win.on('pageerror', (e) => pageErrors.push(e.message))
    // 观测:工作台网页的每次导航(整页 / 同页)和控制台,宿主页里插件的提示;失败的那一步把它们带出来(地址里的令牌抹掉)
    const hostLogs = []
    // 每次右键 hold 回来的 DSH 会话 id(按先后,不去重);④ / ④b 各取自己那次。
    // ⚠️来源是 DSH2Forsion 渲染半身的开发日志「[dsh2forsion] hold ok <id>」:插件删了这行,④b / ⑤ 会因为拿不到 id 假红
    const holds = []
    win.on('console', (m) => {
      if (!/dsh2forsion|d2f/i.test(m.text())) return
      hostLogs.push(`host ${m.type()}: ${m.text()}`.slice(0, 300))
      const id = m.text().match(/hold ok (\S+)/)?.[1]
      if (id) holds.push(id)
    })
    await app.evaluate(({ app: eapp }) => {
      globalThis.__d2fGuestLogs = []
      const push = (line) => { globalThis.__d2fGuestLogs.push(`${new Date().toISOString().slice(11, 19)} ${String(line).replace(/token=[^&#\s]+/g, 'token=<redacted>')}`.slice(0, 300)) }
      eapp.on('web-contents-created', (_e, wc) => {
        if (wc.getType() !== 'webview') return
        wc.on('did-navigate', (_ev, url) => push(`navigate ${url}`))
        wc.on('did-navigate-in-page', (_ev, url, main) => { if (main) push(`in-page ${url}`) })
        wc.on('console-message', (ev, level, message) => { const text = typeof ev?.message === 'string' ? ev.message : message; if (/dsh2forsion|d2f/i.test(String(text))) push(`console ${text}`) })
      })
    })
    const guestLogs = async () => (await app.evaluate(() => globalThis.__d2fGuestLogs.splice(0))).concat(hostLogs.splice(0))
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
    if (RAIL) {
      // ⑧ 的前置:像用户在 DSH 里装插件那样(dsh plugin add)把测试用的右栏页插件装进 forsion 组合,再重启常驻 DSH 让它加载
      const binDir = path.join(path.dirname(BIN), '..', '..', '..', '.bin')
      const add = require('child_process').spawnSync(NODE, [BIN, 'plugin', '--profile', 'forsion', 'add', '--ignore-scripts', `file:${RAIL_FIXTURE}`],
        { env: { ...process.env, ...dshEnv, PATH: `${path.dirname(NODE)}:${binDir}:/usr/bin:/bin` }, encoding: 'utf8' })
      const restarted = add.status === 0 ? await win.evaluate(async () => {
        const c = await window.tangu.getConfig()
        const r = await fetch(`${c.backendUrl}/extensions/dsh2forsion/dsh2forsion/sidecar/restart`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: '{}' })
        return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 200) }
      }).catch((e) => ({ ok: false, status: 0, body: String(e?.message ?? e).slice(0, 200) })) : null
      const back = restarted?.ok && await until(async () => dshProcs().some((l) => l.includes('--profile forsion')), 60_000, 1000)
      check('前置(⑧):测试用的右栏页插件装进 DSH,常驻 DSH 重启好了', !!back, add.status !== 0 ? (add.stdout + add.stderr).slice(-300) : restarted?.ok ? (back ? '' : '重启后 60 秒内没见到 --profile forsion 进程') : `重启请求 ${restarted?.status}: ${restarted?.body}`)
    }

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
    check('① Harness 卡「运行在」下面有插件给的三行:运行时 / 更新通道 / DSH 插件', rowsUp && (await pluginRow(win, 'channel').count()) && (await pluginRow(win, 'dsh-plugins').count()), runtimeText || hostLogs.filter((l) => /harness rows/.test(l)).join(' | ') || '没有行,宿主也没报错')
    check('① 运行时一行写着版本、在运行,带「打开工作台」「重启 DSH」', /0\.2\.2-rc\.3/.test(runtimeText) && /打开工作台/.test(runtimeText) && /重启 DSH/.test(runtimeText), runtimeText)

    // ② 和它聊一句:连的是常驻那个
    check('前置:进 Tangu', await enterSpace(win, 'tangu'))
    await sleep(1200)
    await win.getByText('新会话', { exact: true }).first().click(); await sleep(1200)
    await (await pickAgent(win, AGENT)).click(); await sleep(900)
    if (await win.locator('.ui-popover-backdrop').count()) { await win.keyboard.press('Escape'); await sleep(500) }
    if (MODE !== 'full') await approvalsWalk(app, win, guestLogs)
    else {
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

    // ③b 工作台已经开着时再右键一次:只换地址 # 那段、页面不重载(页面里的标记还在),仍是这场
    await guestEval(app, `window.__d2fKeep = 'keep'`)
    await title.click({ button: 'right' }); await sleep(600)
    await win.getByText('在 DSH 工作台里打开', { exact: true }).first().click()
    await sleep(2500)
    const kept = (await guestEval(app, 'window.__d2fKeep || null')).value
    const still = ((await guestEval(app, 'document.body.innerText')).value || '').includes('One more line from the workbench.')
    const where = (await guestEval(app, `(location.search.includes('token=') ? '?token=…' : location.search || '/') + location.hash`)).value
    check('③ 工作台开着时再右键:页面没重载(只换 # 那段),仍是这场', kept === 'keep' && still, `标记 ${kept};地址 ${where}`)

    // ③c 回到 Forsion 这场对话接着发:DSH 那边是同一场(交给模型的上文里有工作台那一句)
    await title.click(); await sleep(1500)
    stub.sawWorkbenchLine = false
    await send(win, 'Back in Forsion, are you there?')
    const back = await until(async () => (await lastAsst(win)).includes(`Back in Forsion. ${MARK}`), 90_000)
    await shot(win, '24b-back-in-forsion')
    check('③ 回到 Forsion 同一场接着发:答得出,DSH 那边是同一场(上文里有工作台那一句)', !!back && stub.sawWorkbenchLine === true, await lastAsst(win))

    if (RAIL) await railWalk(app, win)

    // ③d 关掉工作台页签,从 Harness 卡的「打开工作台」进:看得到这场对话(连同刚才 Forsion 那一轮),并接着说
    await win.evaluate(() => [...document.querySelectorAll('.wb-tab')].find((t) => /DSH 工作台/.test(t.querySelector('.wb-tab-name')?.textContent || ''))?.querySelector('.wb-tab-close')?.click())
    await until(async () => (await win.locator('[data-d2f="workbench"] webview').count()) === 0, 5_000, 300)
    const closedTab = (await win.locator('[data-d2f="workbench"] webview').count()) === 0
    await openAgents(win); await rosterRow(win, AGENT).click(); await sleep(1500)
    await pluginRow(win, 'runtime').locator('button', { hasText: '打开工作台' }).first().click()
    await until(async () => (await win.locator('[data-d2f="workbench"] webview').count()) > 0, 30_000, 500)
    let seen = await until(async () => { const t = (await guestEval(app, 'document.body.innerText')).value || ''; return t.includes('Back in Forsion') ? 'shown' : null }, 8_000, 600)
    if (!seen) { // DSH 没自己回到上次那场:像用户一样在它的会话列表里点这场
      await guestClickText(app, '/^Hello DSH, please say hello\\.$/')
      seen = await until(async () => { const t = (await guestEval(app, 'document.body.innerText')).value || ''; return t.includes('Back in Forsion') ? 'clicked in the list' : null }, 15_000, 600)
    }
    await guestEval(app, `(() => { const ta = document.querySelector('textarea, [contenteditable="true"]'); ta?.focus(); return !!ta })()`)
    const typed2 = await guestType(app, 'Hello from the card path.')
    const heard2 = typed2 && await until(async () => ((await guestEval(app, 'document.body.innerText')).value || '').includes(`Card path heard you. ${MARK}`), 60_000, 800)
    await shot(win, '24c-card-path')
    check('③ 从 Harness 卡打开工作台:看得到这场(含 Forsion 刚才那一轮)并接着说', closedTab && !!seen && !!heard2, `页签关掉了 ${closedTab};${seen || '没看到这场'}`)

    // ④ 在工作台里装 dsh-genui:Forsion 先给体检报告
    // 从这里起记下宿主 webview 盒子的每次变化、网页视口的每次 resize(下面断言体检前后都没变过)
    await win.evaluate(() => {
      const wv = document.querySelector('[data-d2f="workbench"] webview'); const log = (window.__d2fBox = [])
      if (!wv) return
      const t0 = performance.timeOrigin
      new ResizeObserver(() => { const b = wv.getBoundingClientRect(); log.push({ t: Math.round(t0 + performance.now()), x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), on: wv.isConnected }) }).observe(wv)
    }).catch(() => {})
    await guestEval(app, `(() => { const log = (window.__d2fVp = []); addEventListener('resize', () => log.push({ t: Date.now(), w: innerWidth, h: innerHeight })); return true })()`)
    const reqId = `ui-${Date.now()}`
    void guestEval(app, `fetch('/api/pluginManager/installBundle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: '${reqId}', method: 'pluginManager/installBundle', payload: { args: { spec: '${GENUI}', options: { enabled: true, requestId: '${reqId}' } } } }) }).then((r) => r.json()).then((j) => { window.__d2fInstall = j; return true })`)
    const card = win.locator('[data-d2f="review"]').first()
    const checking = await until(async () => /正在体检/.test(await card.innerText().catch(() => '')), 20_000, 400)
    await shot(win, '25-review-checking')
    check('④ 工作台里点安装后,Forsion 先体检(安装被停住)', !!checking)
    const report = await until(async () => { const t = await card.innerText().catch(() => ''); return /要装 dsh-genui/.test(t) ? t : null }, 240_000, 1000)
    await shot(win, '26-review-report')
    // 体检卡出来前后,宿主的 webview 盒子和里面网页的视口都没变过(截图也不能把它撑大:见 shot 的说明)
    { const box = await win.evaluate(() => window.__d2fBox || null).catch(() => null)
      const vp = (await guestEval(app, 'window.__d2fVp || null')).value
      const same = Array.isArray(box) && box.length >= 1 && box.every((b) => b.w === box[0].w && b.h === box[0].h && b.x === box[0].x && b.on)
      check('④ 体检卡出来前后工作台网页的尺寸没变过(截图不撑大网页)', same && Array.isArray(vp) && vp.length === 0, `宿主盒子 ${JSON.stringify(box)};网页视口变化 ${JSON.stringify(vp)}`) }
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
    const toPlugins = await guestClickText(app, '/^(插件|Plugins)$/')
    // DSH 的插件页先画骨架再取列表(第 20 轮 2.5 秒时还是骨架):等列表出来
    const pluginPage = (await until(async () => { const t = (await guestEval(app, 'document.body.innerText')).value || ''; return /genui/i.test(t) ? t : null }, 20_000, 500)) || ((await guestEval(app, 'document.body.innerText')).value || '')
    await sleep(500)
    await shot(win, '26b-dsh-plugin-page')
    check('④ 工作台里 DSH 自己的插件页列着刚装的 genui', /genui/i.test(pluginPage), toPlugins ? `点在 ${toPlugins.tag} (${toPlugins.x},${toPlugins.y})` : '没找到「插件」入口')
    // Harness 卡「DSH 插件」变 1 个
    await openAgents(win); await rosterRow(win, AGENT).click(); await sleep(1500)
    // --rail 时 ⑧ 的前置先装了一个测试用的右栏页插件,genui 是第 2 个
    const want = RAIL ? 2 : 1
    const count = await until(async () => { const t = await pluginRow(win, 'dsh-plugins').innerText().catch(() => ''); return new RegExp(`${want} 个`).test(t) ? t : null }, 20_000, 800)
    await shot(win, '27-harness-after-install')
    check(`④ Harness 卡「DSH 插件」变成 ${want} 个`, !!count, count || await pluginRow(win, 'dsh-plugins').innerText().catch(() => ''))
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
    // genui 卡:在 Forsion 里要一张卡,再右键这场在工作台里看 —— DSH 自己把它画成卡片(和第三轮方案图第二张对照)
    // 上一轮刚答完时输入框可能还没放开,发出去的那句会被吞掉:等它放开,没答出来就照实记失败
    await sleep(2000)
    await send(win, 'Please show me a card.')
    let cardAnswer = await until(async () => /GENUI_PROBE_CARD/.test(await lastAsst(win)), 30_000)
    if (!cardAnswer) { await sleep(2000); await send(win, 'Please show me a card.'); cardAnswer = await until(async () => /GENUI_PROBE_CARD/.test(await lastAsst(win)), 30_000) }
    check('④ 在 Forsion 里要一张卡:DSH 答出来了(下面到工作台里看它画成什么)', !!cardAnswer, await lastAsst(win))
    const nHold4 = holds.length
    const title2 = win.locator('aside, nav, [class*="sidebar"], [class*="side"]').getByText(/^Hello DSH again/).first()
    await title2.click({ button: 'right' }); await sleep(600)
    await guestLogs() // 只留右键之后的
    await win.getByText('在 DSH 工作台里打开', { exact: true }).first().click()
    await sleep(1200)
    const toast = ((await win.evaluate(() => document.body.innerText)) || '').match(/这场对话[^\n]*|没能把这场对话[^\n]*/)?.[0] || ''
    const genuiCard = await until(async () => {
      const r = (await guestEval(app, `({ text: document.body.innerText, cards: document.querySelectorAll('dsh-genui-card, [data-dsh-genui-card]').length })`)).value
      return r && r.text.includes('GENUI_PROBE_CARD') && !r.text.includes('componentName') ? r : null
    }, 30_000, 800)
    await sleep(800)
    await shot(win, '28-genui-card')
    const log4 = await guestLogs()
    const idB = holds[nHold4]
    console.log(`   ④ 右键另一场之后的记录:提示「${toast}」\n     ${log4.join('\n     ')}`)
    check('④ 工作台里 DSH 把 genui 卡画成了卡片(不是代码块)', !!genuiCard, genuiCard ? `卡片元素 ${genuiCard.cards} 个` : '没落到这场,记录见上')

    // ④b 工作台页签就在前面时,从左栏右键另一场:宿主只换 # 那段,同一个页面里落到那场(页面里的标记还在)
    await win.evaluate(() => [...document.querySelectorAll('.wb-tab')].find((t) => /DSH 工作台/.test(t.querySelector('.wb-tab-name')?.textContent || ''))?.click())
    await sleep(1200)
    await guestEval(app, `window.__d2fKeep4 = 'keep'`)
    await guestLogs()
    const nHold4b = holds.length
    const titleA = win.locator('aside, nav, [class*="sidebar"], [class*="side"]').getByText(/^Hello DSH, please say hello/).first()
    await titleA.click({ button: 'right' }); await sleep(600)
    await win.getByText('在 DSH 工作台里打开', { exact: true }).first().click()
    const landedA = await until(async () => ((await guestEval(app, 'document.body.innerText')).value || '').includes('Card path heard you'), 15_000, 500)
    const kept4 = (await guestEval(app, 'window.__d2fKeep4 || null')).value
    const log4b = await guestLogs()
    const idA = holds[nHold4b]
    console.log(`   ④b 记录:\n     ${log4b.join('\n     ')}`)
    await shot(win, '28b-land-in-page')
    check('④ 工作台开着时右键另一场:落到那场,页面没重载(只换 # 那段)', !!landedA && kept4 === 'keep', `落上 ${!!landedA};标记 ${kept4 ?? '没了(页面重载过)'}`)

    // ⑤ 快速复现:整页重新载入时带着落点(重开工作台、DSH 重启后都是这条路),来回切 8 次,看每次是否落在要的那场
    // A = ③ 那场(只有它有「Card path heard you」),B = ④ 那场(只有它有 genui 卡)
    if (idA && idB && idA !== idB) {
      let landed = 0
      const misses = []
      for (let i = 0; i < 8; i++) {
        const want = i % 2 === 0 ? idA : idB
        const mark = want === idA ? 'Card path heard you' : 'GENUI_PROBE_CARD'
        await guestLogs()
        await guestEval(app, `(() => { history.replaceState(null, '', location.pathname + '#d2f-session=' + encodeURIComponent(${JSON.stringify(want)}) + '&n=${200 + i}'); setTimeout(() => location.reload(), 50); return true })()`).catch(() => null)
        await sleep(1500)
        const ok = await until(async () => ((await guestEval(app, 'document.body.innerText')).value || '').includes(mark), 8_000, 400)
        // 落上之后再等一会儿:DSH 自己的恢复要是晚到,会把它改回去
        await sleep(2500)
        const still = ((await guestEval(app, 'document.body.innerText')).value || '').includes(mark)
        if (ok && still) landed++
        else misses.push(`#${i} ${want === idA ? 'A' : 'B'} ${ok ? '落上后又被改回' : '没落上'}:${(await guestLogs()).join(' | ')}`)
      }
      for (const m of misses) console.log(`   ⑤ ${m}`)
      check('⑤ 整页重新载入时带落点:8 次都落在要的那场', landed === 8, `${landed}/8`)
    } else check('⑤ 整页重新载入时带落点:8 次都落在要的那场', false, `没拿到两场的 id:A ${idA} / B ${idB}`)
    } // MODE === 'full'
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
  // 等最多 12 秒:宿主退出时 3 秒就 SIGKILL 引擎,插件自己停 DSH 的 4 秒上限赶不上,DSH 是自己收尾退出的;
  // 装了 skills-manager 并重启过之后实测要 ~8 秒(审批走查,没装时 1 秒内)。秒数照实打出来
  const t0 = Date.now()
  const gone = await until(async () => dshProcs().length === 0, 12_000, 500)
  const left = dshProcs()
  check('Forsion 退出后没有留下 DSH 进程(最多等 12 秒)', !!gone && !left.length, gone ? `${((Date.now() - t0) / 1000).toFixed(1)} 秒后没了` : left.join(' / '))
  // 退出那几秒 DSH 是自己收尾的,会话没丢:每场的会话文件(多帧 zstd,Node 只解得开第一帧,用 zstd 命令)整份解得开、
  // 逐行是 JSON、开过几轮就收了几轮尾(turn/start 与 turn/end 一样多)。本机没有 zstd 命令就记未验
  if (gone) {
    const files = []
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl.zstd')) files.push(p) } }
    try { walk(path.join(R, 'dsh', 'sessions')) } catch { /* 没有会话目录 = 下面判失败 */ }
    let zstd = true
    try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }) } catch { zstd = false }
    if (!zstd) console.log('未验  Forsion 退出后 DSH 的会话文件完整(本机没有 zstd 命令)')
    else {
      const seen = files.map((f) => {
        const id = path.basename(path.dirname(f)).slice(0, 8)
        try {
          const rows = execFileSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } })
          const n = (t) => rows.filter((r) => r?.type === t).length
          return { id, lines: rows.length, bad: rows.filter((r) => !r).length, turns: n('turn/start'), ended: n('turn/end') }
        } catch (e) { return { id, error: String(e.message).slice(0, 80) } }
      })
      check('Forsion 退出后 DSH 的会话文件完整(整份解得开、逐行是 JSON、每轮都收了尾)', files.length > 0 && seen.some((s) => s.turns > 0) && seen.every((s) => !s.error && s.bad === 0 && s.turns === s.ended), JSON.stringify(seen))
    }
  }
  check('真实的 ~/.dsh 与 ~/.agents 没被这次运行写过', ['.dsh', '.agents'].every((d) => { try { return fs.statSync(path.join(os.homedir(), d)).mtimeMs < START } catch { return true } }))
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})
