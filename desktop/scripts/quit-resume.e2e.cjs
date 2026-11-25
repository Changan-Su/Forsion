#!/usr/bin/env node
/**
 * 中断任务续跑(方案 B)「退出 → 再打开 → 接着做」整条链:真 Electron × 真托管引擎(本检出 tangu-agent/dist)× 本机假模型 × 隔离 home。
 * 方案页:仓根 docs/ToBeImproved/中断任务续跑方案_2026-11-20/。界面那半的静态截图在 resume-lines.shots.cjs,这里量的是真退出、真重启。
 *
 * 假模型(OpenAI 兼容 /v1/chat/completions,一个阶段旗标由脚本拨,不按请求计数):
 *   第一次打开:主循环那条请求(带 tools、用户话里有探针串)流两段正文 PARTIAL-ALPHA / PARTIAL-BETA 后**挂住不收尾**,
 *     run 真的停在 running;标题 / Historian 之类不带 tools 的请求一律当场答 OK。
 *   再打开:最后一条用户消息是 <turn_resume> 的主循环请求当场答 RESUMED-OK。每条请求的摘要与原文都记下来。
 * 步骤:
 *   ① 隔离 home 起 dev Electron(托管模式,provider 走 TANGU_PROVIDER_* 指向假模型),进 Tangu、点「新会话」、在真输入框里发一句;
 *      从界面发出的 POST /agent/runs 记下 runId / session_id;等假模型收到这条、界面出现 PARTIAL-BETA、引擎 GET /agent/runs 报 running。
 *   ② 退出前记下引擎 pid、命令行 --data-dir、引擎进程环境里的 TANGU_HOME / TANGU_AUTO_RESUME。然后像用户一样退出:
 *      主进程 app.quit()(= Cmd+Q / 托盘「退出」→ before-quit → backend.stop('app_quit'))。退出前确认框(quitGuards)若弹出,
 *      照 restart-update.e2e.cjs 的做法替身成「退出」并记下来。退出过程中持续读引擎日志环(主进程一退就没了)。
 *   ③ 应用退出后:引擎 pid 已不在;shutdown-intent.json 还在(只有下次启动的恢复流程会删),reason=app_quit、pid=那个引擎,
 *      所在目录 = 引擎 --data-dir 的目录 = 引擎进程里的 TANGU_HOME(都按 realpath 比);node:sqlite 读 state.db:
 *      那个 run status=interrupted、error=interrupted:app_quit(不是 crash / engine_stop / aborted),回答行里存着半截正文。
 *   ④ 同一个 home 再打开:旧 run 的 resumed_by = 新 run id;新 run input.trigger=recovery、resumeOf=旧 id、终态 done;
 *      假模型收到最后一条用户消息(引擎每轮末尾追加的「## Presentation choice」提示不算)含 <turn_resume> 与 [auto-resume: app_quit] 的请求;界面出现 ↻ 续跑行与 RESUMED-OK;
 *      意图文件已被恢复流程删掉;引擎日志里有 `interrupted run <旧> (app_quit) resumed as <新>`。截下聊天区。
 * 负对照 --auto-resume-off:第一次打开时经设置页同一条 IPC(window.tangu.setConfig({ autoResumeInterrupted: false }))关掉开关,
 *   核对桌面配置文件落了盘、再打开的引擎环境是 TANGU_AUTO_RESUME=0。期望:resumed_by='-'、没有续跑 run、假模型没收到 <turn_resume>、
 *   会话里多一条 <turn_interrupted>[reason: app_quit] 说明行、界面是 ⏸ 中断行 +「继续生成」、引擎日志 `not resumed: disabled`。
 *   两种模式都把「正向断言」和「负向断言」在同一份观测上各算一遍:正向模式要求正向全绿,负对照要求负向全绿且正向里只属于续跑的那几条全红
 *   (被打断、意图文件这几条两种模式共用,负对照里照样绿)。
 * 只覆盖 dev 拉起路径(系统 node 直接跑 standalone);安装包经 dist/boot/launch.js 拉起,那条路上的 pid 对应不在这里量。
 *
 * 用法(cd desktop;先 npx electron-vite build + tangu-agent 里 npm run build,本脚本不替你 build):
 *   node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="quit resume e2e" --eta=4 -- node scripts/quit-resume.e2e.cjs [--auto-resume-off]
 *   旋钮:SHOT_DIR=<目录>(截图,缺省系统临时目录 forsion-quit-resume);原始请求 / 引擎日志 / 库行落在系统临时目录 forsion-quit-resume-<模式>-<时刻>/。
 * 退出码:本模式要求的断言任一 FAIL、或渲染层抛错 → 1。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.join(__dirname, '..')
const OFF = process.argv.includes('--auto-resume-off')
const WINDOWS = process.platform === 'win32'
const MODE = OFF ? 'off' : 'on'
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-quit-resume')
const SHOT = path.join(SHOT_DIR, OFF ? 'quit-resume-off-zh.png' : 'quit-resume-zh.png')
const OUT = path.join(os.tmpdir(), `forsion-quit-resume-${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const ENGINE_OBSERVER = path.join(__dirname, 'lib', 'quit-resume-windows.cjs')
const PROVIDER = 'stubresume'
const MODEL = 'resume-model'
const PROBE = 'QUIT-RESUME-PROBE'
const ASK = `${PROBE}:请写一段三百字左右的短文，介绍秋天的银杏。不要用任何工具。`
const COPY = { resumed: '应用退出时这一轮还没做完，已接着做', interrupted: '应用退出时这一轮还没做完', continue: '继续生成' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 250) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(every) } }

const results = []
/** level: required = 本模式必须绿;expectRed = 本模式必须红(负对照里的续跑断言);info = 只打印。 */
function check(name, ok, detail = '', level = 'required') {
  const pass = level === 'expectRed' ? !ok : !!ok
  results.push({ name, ok: !!ok, level, pass })
  const tag = level === 'expectRed' ? (ok ? 'FAIL(应红却绿)' : 'RED (预期)') : level === 'info' ? (ok ? 'info✓' : 'info✗') : (ok ? 'PASS' : 'FAIL')
  console.log(`${tag.padEnd(12)} ${name}${detail ? `  | ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`)
}
const pageErrors = []

// ── 本机假模型 ──────────────────────────────────────────────────────────────
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '')
const userTexts = (body) => (body?.messages || []).filter((m) => m.role === 'user').map((m) => textOf(m.content))
/** 引擎每轮在对话末尾追加一条「## Presentation choice for this turn」user 提示(不是会话里的行):「最后一条用户消息」按它之前那条算。 */
const TURN_HINT = '## Presentation choice for this turn'
const lastTurnUser = (users) => { let i = users.length - 1; while (i > 0 && users[i].startsWith(TURN_HINT)) i--; return users[i] || '' }
const fake = { phase: 'hang', hungOnce: false, requests: [], hung: new Set(), sockets: new Set() }
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => { raw += d })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    const p = (req.url || '').split('?')[0]
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.method === 'GET' && /\/models$/.test(p)) return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] })
    if (!(req.method === 'POST' && /\/chat\/completions$/.test(p))) return json({ error: { message: `stub: no route ${req.method} ${p}` } }, 404)
    const users = userTexts(body)
    const lastUser = lastTurnUser(users)
    const tools = Array.isArray(body?.tools) ? body.tools.length : 0
    const main = tools > 0
    const anyResume = users.some((u) => u.includes('<turn_resume>'))
    let action = 'ok'
    if (main && fake.phase === 'hang' && !fake.hungOnce && users.some((u) => u.includes(PROBE)) && !anyResume) action = 'hang'
    else if (main && lastUser.includes('<turn_resume>')) action = 'resumed'
    const rec = { at: new Date().toISOString(), phase: fake.phase, action, stream: !!body?.stream, tools, model: body?.model, lastUser: lastUser.slice(0, 400), trailingHint: (users[users.length - 1] || '').startsWith(TURN_HINT), anyResume, body }
    fake.requests.push(rec)
    console.log(`  · 假模型 #${fake.requests.length} phase=${fake.phase} action=${action} stream=${rec.stream} tools=${tools} lastUser=${JSON.stringify(lastUser.slice(0, 80))}`)
    const base = { id: `chatcmpl_${fake.requests.length}`, created: Math.floor(Date.now() / 1000), model: body?.model || MODEL }
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`)
    if (action === 'hang') {
      fake.hungOnce = true
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      fake.hung.add(res)
      res.on('close', () => { rec.closedAt = new Date().toISOString(); fake.hung.delete(res) })
      chunk({ role: 'assistant', content: '' })
      chunk({ content: 'PARTIAL-ALPHA ' })
      setTimeout(() => { if (!res.writableEnded && !res.destroyed) chunk({ content: 'PARTIAL-BETA ' }) }, 300)
      return // 不收尾:run 停在 running,直到应用退出时引擎中止这条流
    }
    const content = action === 'resumed' ? 'RESUMED-OK' : 'OK'
    if (!body?.stream) return json({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    chunk({ role: 'assistant', content: '' })
    chunk({ content })
    chunk({}, 'stop', { usage })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
server.on('connection', (s) => { fake.sockets.add(s); s.on('close', () => fake.sockets.delete(s)) })

// ── 应用 ────────────────────────────────────────────────────────────────────
let STUB = ''
const home = fs.mkdtempSync(path.join(os.tmpdir(), `forsion-quit-resume-${MODE}-`))
const userData = path.join(home, 'userdata')
const desktopCfgFile = path.join(`${userData}-dev`, 'tangu-desktop-config.json') // 未打包时主进程用 <dir>-dev
const ownPids = new Set() // 本脚本拉起的进程(Electron 主进程、它拉起的引擎);收尾只杀这些
function prepareHome() {
  const ws = path.join(home, 'workspace')
  const vault = path.join(home, 'vault')
  for (const d of [`${userData}-dev`, ws, vault]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(vault, 'welcome.md'), '# quit resume\n')
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  fs.writeFileSync(desktopCfgFile, JSON.stringify({ mode: 'managed', sandbox: 'none', browserEnabled: false, unitHostEnabled: false, defaultWorkspaceDir: ws, modelId: `${PROVIDER}/${MODEL}` }))
}
function launch() {
  const env = {
    ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: 'http://127.0.0.1:1', TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1',
    TANGU_PROVIDER_ID: PROVIDER, TANGU_PROVIDER_BASE_URL: `${STUB}/v1`, TANGU_PROVIDER_API_KEY: 'stub-not-a-real-key', TANGU_PROVIDER_MODELS: MODEL,
  }
  delete env.TANGU_BACKEND_URL
  delete env.TANGU_AUTO_RESUME // 只由桌面按设置注入
  const observerArgs = WINDOWS ? ['-r', ENGINE_OBSERVER] : []
  if (WINDOWS) env.FORSION_QUIT_RESUME_OBSERVATIONS = OUT
  return electron.launch({ args: [...observerArgs, `--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env, timeout: 60_000 })
}
async function boot(app, firstTime) {
  const pid = app.process()?.pid
  if (pid) ownPids.add(pid)
  const win = await app.firstWindow({ timeout: 60_000 })
  win.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 200)))
  win.setDefaultTimeout(15_000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 860)).catch(() => {})
  await win.waitForSelector('#root', { timeout: 40_000 })
  check(`${firstTime ? '一开' : '再开'}:主窗离开首启引导`, await skipOnboarding(win, firstTime ? 15_000 : 4_000), '', 'info')
  await win.waitForSelector('.rb', { timeout: 45_000 })
  // 启动遮罩(#tangu-splash)在 .rb 出现后还会盖一会儿:不等它撤掉,截图截到的是遮罩
  await win.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {})
  const ready = await until(async () => (await win.evaluate(() => window.tangu.backendStatus())).state === 'ready', 90_000, 200)
  check(`${firstTime ? '一开' : '再开'}:托管引擎就绪`, !!ready)
  if (!ready) throw new Error('托管引擎没有就绪:' + JSON.stringify(await win.evaluate(() => window.tangu.backendStatus()).catch(() => null)))
  return win
}
/** 引擎进程的 pid、--data-dir、环境里的 TANGU_HOME / TANGU_AUTO_RESUME(ps -E:同一用户的进程看得到环境)。 */
async function engineInfo(win) {
  const st = await win.evaluate(() => window.tangu.backendStatus())
  const pid = st.pid
  if (pid) ownPids.add(pid)
  if (WINDOWS) {
    const observation = JSON.parse(fs.readFileSync(path.join(OUT, `engine-${pid}.json`), 'utf8'))
    return { pid, url: st.url, ...observation }
  }
  const cmd = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  const withEnv = execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  const dataDir = (cmd.match(/--data-dir\s+(\S+)/) || [])[1] || ''
  const envHome = (withEnv.match(/(?:^|\s)TANGU_HOME=(\S+)/) || [])[1] || ''
  const envAuto = (withEnv.match(/(?:^|\s)TANGU_AUTO_RESUME=(\S*)/) || [])[1]
  return { pid, url: st.url, dataDir, envHome, envAuto: envAuto === undefined ? null : envAuto }
}
const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const mainWindowSend = (app, action, payload) => app.evaluate(({ BrowserWindow }, [a, p]) => {
  const w = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed() && !x.webContents.getURL().includes('window=')).sort((m, n) => m.id - n.id)[0]
  w.webContents.send('window:mainAction', a, p)
}, [action, payload])
async function engineFetch(win, route) {
  return win.evaluate(async (r) => {
    const cfg = await window.tangu.getConfig()
    const res = await fetch(cfg.backendUrl + r, { headers: { Authorization: `Bearer ${cfg.token}` } })
    return { status: res.status, body: await res.json().catch(() => null) }
  }, route)
}
function withDb(dbPath, fn) {
  process.removeAllListeners('warning') // node:sqlite 的 ExperimentalWarning 不进输出
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try { db.exec('PRAGMA busy_timeout = 5000'); return fn(db) } finally { db.close() }
}
const runRow = (db, id) => db.prepare('SELECT id, session_id, status, error, resumed_by, interrupted_at, assistant_message_id, input FROM agent_runs WHERE id = ?').get(id)
const parse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s || {} } catch { return {} } }
const logLines = (lines) => (lines || []).filter((l) => /interrupted run|not resumed|resumed as|re-enqueued|settled as aborted|run preparation interrupted|half-written resume|stale runs/.test(l))

/** 像用户那样退出:主进程 app.quit() → before-quit → backend.stop('app_quit') → app.exit(0)。返回退出耗时、退出过程中读到的最后一份引擎日志、弹过的确认框。 */
async function quitLikeUser(app, win) {
  const dialogs = []
  app.on('console', (m) => { const t = m.text(); if (t.includes('[quit-resume] dialog')) dialogs.push(t) })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (w, o) => { const opt = o || w || {}; console.log('[quit-resume] dialog ' + JSON.stringify({ message: opt.message, buttons: opt.buttons })); return { response: 0, checkboxChecked: false } }
  })
  let logs = await win.evaluate(() => window.tangu.backendLogs()).catch(() => [])
  const proc = app.process()
  const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal })))
  const t0 = Date.now()
  app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0) }).catch(() => {})
  let polling = true
  const poll = (async () => {
    while (polling) {
      try { logs = await win.evaluate(() => window.tangu.backendLogs()) } catch { break }
      await sleep(100)
    }
  })()
  const exit = await Promise.race([exited, sleep(25_000).then(() => null)])
  polling = false
  await poll
  return { exit, startedAt: t0, ms: Date.now() - t0, logs, dialogs }
}

async function openSession(app, win, sid) {
  await mainWindowSend(app, 'open-link', `forsion://session/${sid}`)
  const surface = win.locator(`[data-chat-surface="chat"][data-session-id="${sid}"]`)
  await surface.waitFor({ timeout: 20_000 })
  return surface
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  STUB = `http://127.0.0.1:${server.address().port}`
  prepareHome()
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const obs = { mode: MODE, home, stub: STUB }

  // ① 第一次打开,发一句
  let app = await launch()
  let win
  try {
    win = await boot(app, true)
    obs.engine1 = await engineInfo(win)
    console.log(`  · 引擎一:pid=${obs.engine1.pid} --data-dir=${obs.engine1.dataDir} TANGU_HOME=${obs.engine1.envHome} TANGU_AUTO_RESUME=${obs.engine1.envAuto}`)
    if (OFF) {
      const after = await win.evaluate(() => window.tangu.setConfig({ autoResumeInterrupted: false }))
      obs.cfgAfterToggle = after?.autoResumeInterrupted
      obs.cfgFile = parse(fs.readFileSync(desktopCfgFile, 'utf8')).autoResumeInterrupted
    }
    const runCap = {}
    win.on('response', async (r) => {
      try {
        if (r.request().method() !== 'POST' || !/\/agent\/runs(\?|$)/.test(r.url()) || runCap.runId) return
        const req = r.request().postDataJSON()
        const j = await r.json()
        if (!String(req?.message || '').includes(PROBE)) return
        Object.assign(runCap, { runId: j.runId, sessionId: req.session_id, assistantMessageId: j.assistantMessageId })
      } catch { /* 不是这一条 */ }
    })
    check('一开:进 Tangu', await enterSpace(win, 'tangu'))
    await sleep(1200)
    await win.getByText('新会话', { exact: true }).first().click()
    const ta = win.locator('.t2c-ta').last()
    await ta.waitFor({ timeout: 15_000 })
    await until(() => ta.isEnabled(), 20_000, 300)
    await ta.click()
    await ta.fill(ASK)
    await ta.press('Enter')
    const got = await until(async () => fake.hungOnce && runCap.runId, 60_000)
    check('一开:界面发出的这一轮到了假模型(主循环请求挂住)', !!got, `runId=${runCap.runId} session=${runCap.sessionId}`)
    if (!got) throw new Error('假模型没收到主循环请求 / 没截到 POST /agent/runs')
    Object.assign(obs, { runId: runCap.runId, sessionId: runCap.sessionId, assistantMessageId: runCap.assistantMessageId })
    const partial = await until(async () => (await win.evaluate(() => [...document.querySelectorAll('.t2-asst')].map((e) => e.innerText).join('\n'))).includes('PARTIAL-BETA'), 30_000)
    check('一开:界面上出现了半截正文 PARTIAL-BETA', !!partial)
    const running = await until(async () => {
      const r = await engineFetch(win, `/agent/runs?session_id=${encodeURIComponent(obs.sessionId)}`)
      const row = (r.body?.runs || []).find((x) => x.id === obs.runId)
      return row && row.status === 'running' ? row : null
    }, 15_000)
    check('一开:引擎 GET /agent/runs 报这个 run 在 running', !!running, running ? running.status : '')
    obs.engineLogs1Before = await win.evaluate(() => window.tangu.backendLogs()).catch(() => [])

    // ② 像用户一样退出
    const q = await quitLikeUser(app, win)
    obs.quit = { exit: q.exit, startedAt: q.startedAt, ms: q.ms, dialogs: q.dialogs }
    obs.engineLogs1 = q.logs
    check('退出:应用进程退出', !!q.exit, `${q.ms}ms exit=${JSON.stringify(q.exit)}`)
    check('退出:没有弹退出前确认框', q.dialogs.length === 0, q.dialogs.join(' / '), 'info')
  } catch (e) {
    if (win) await win.screenshot({ path: path.join(OUT, 'failure-launch1.png') }).catch(() => {})
    throw e
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(10_000)])
  }

  // ③ 退出之后:引擎没了、意图文件、库里的行
  const enginePid1 = obs.engine1.pid
  const gone = await until(async () => !alive(enginePid1), 10_000, 200)
  check('退出后:引擎进程已不在', !!gone, `pid=${enginePid1}`)
  if (!gone) { try { process.kill(enginePid1, 'SIGKILL') } catch { /* 已退 */ } }
  const expectIntent = path.join(obs.engine1.envHome || path.dirname(obs.engine1.dataDir), 'shutdown-intent.json')
  obs.intentPath = expectIntent
  obs.intent = fs.existsSync(expectIntent) ? parse(fs.readFileSync(expectIntent, 'utf8')) : null
  if (WINDOWS) {
    const beforeShutdown = path.join(OUT, `before-shutdown-${enginePid1}.json`)
    obs.beforeShutdown = fs.existsSync(beforeShutdown) ? parse(fs.readFileSync(beforeShutdown, 'utf8')) : null
  }
  const intentFiles = []
  for (const d of [home, path.join(home, 'tangu')]) {
    try { for (const f of fs.readdirSync(d)) if (f.startsWith('shutdown-intent')) intentFiles.push(path.join(d, f)) } catch { /* 无 */ }
  }
  obs.intentFiles = intentFiles
  const dbPath = obs.engine1.dataDir
  withDb(dbPath, (db) => {
    obs.run1 = runRow(db, obs.runId)
    obs.answer1 = obs.run1?.assistant_message_id ? db.prepare('SELECT role, content FROM chat_messages WHERE id = ?').get(obs.run1.assistant_message_id) : null
  })
  console.log(`  · 退出后 run 行:${JSON.stringify({ ...obs.run1, input: undefined })}`)
  console.log(`  · 退出后意图文件:${JSON.stringify(obs.intent)} @ ${expectIntent};目录里所有意图文件:${JSON.stringify(intentFiles)}`)
  console.log(`  · 引擎一日志(退出前后,摘):\n    ${logLines(obs.engineLogs1).join('\n    ') || '(无相关行)'}`)

  // ④ 同一个 home 再打开
  fake.phase = 'answer'
  app = await launch()
  try {
    win = await boot(app, false)
    obs.engine2 = await engineInfo(win)
    console.log(`  · 引擎二:pid=${obs.engine2.pid} TANGU_AUTO_RESUME=${obs.engine2.envAuto}`)
    // 恢复流程跑完:旧行被认领(resumed_by 有值)
    const settled = await until(async () => withDb(dbPath, (db) => runRow(db, obs.runId)?.resumed_by != null), 30_000, 400)
    check('再开:恢复流程处理了旧 run(resumed_by 已写)', !!settled)
    // 续跑 run 走完(负对照里没有续跑 run,等一小会儿就过)
    await until(async () => withDb(dbPath, (db) => {
      const r = runRow(db, obs.runId)
      if (!r?.resumed_by || r.resumed_by === '-') return true
      const n = runRow(db, r.resumed_by)
      return n && ['done', 'failed', 'aborted', 'interrupted'].includes(n.status)
    }), 45_000, 400)
    withDb(dbPath, (db) => {
      obs.run1After = runRow(db, obs.runId)
      const rb = obs.run1After?.resumed_by
      obs.run2 = rb && rb !== '-' ? runRow(db, rb) : null
      obs.resumeRuns = db.prepare('SELECT id, status, input FROM agent_runs WHERE session_id = ? AND id <> ?').all(obs.sessionId, obs.runId)
        .filter((r) => parse(r.input).resumeOf === obs.runId).map((r) => r.id)
      obs.messages = db.prepare('SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY rowid').all(obs.sessionId)
        .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 160) }))
    })
    console.log(`  · 再开后旧 run:${JSON.stringify({ ...obs.run1After, input: undefined })}`)
    console.log(`  · 续跑 run:${obs.run2 ? JSON.stringify({ id: obs.run2.id, status: obs.run2.status, error: obs.run2.error, trigger: parse(obs.run2.input).trigger, resumeOf: parse(obs.run2.input).resumeOf }) : '(无)'}`)
    obs.intentAfterRelaunch = fs.existsSync(expectIntent)

    // 界面
    const surface = await openSession(app, win, obs.sessionId)
    if (OFF) await surface.locator('[data-interrupted]').first().waitFor({ timeout: 20_000 }).catch(() => {})
    else await until(async () => (await surface.evaluate((el) => [...el.querySelectorAll('.t2-asst')].map((e) => e.innerText).join('\n'))).includes('RESUMED-OK'), 30_000)
    await win.evaluate(() => document.fonts.ready)
    await sleep(900)
    await win.mouse.move(5, 400)
    obs.ui = await surface.evaluate((el) => {
      const txt = (s) => [...el.querySelectorAll(s)].map((e) => (e.textContent || '').trim())
      return {
        resumeLines: txt('[data-turn-resume]').map((t, i) => ({ attr: el.querySelectorAll('[data-turn-resume]')[i].getAttribute('data-turn-resume'), text: t })),
        interruptedLines: txt('[data-interrupted]').map((t, i) => ({ attr: el.querySelectorAll('[data-interrupted]')[i].getAttribute('data-interrupted'), text: t })),
        continueBtn: txt('[data-testid="msg-continue"]'),
        asst: [...el.querySelectorAll('.t2-asst')].map((e) => e.innerText.trim().slice(0, 200)),
      }
    })
    await win.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
    check('再开:截图前启动遮罩已撤掉', (await win.locator('#tangu-splash').count()) === 0)
    await surface.screenshot({ path: SHOT, animations: 'disabled' })
    obs.engineLogs2 = await win.evaluate(() => window.tangu.backendLogs()).catch(() => [])
  } catch (e) {
    if (win) await win.screenshot({ path: path.join(OUT, 'failure-launch2.png') }).catch(() => {})
    obs.engineLogs2 = obs.engineLogs2 || await win?.evaluate(() => window.tangu.backendLogs()).catch(() => []) || []
    throw e
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(15_000)])
    fs.writeFileSync(path.join(OUT, 'observation.json'), JSON.stringify({ ...obs, run1: obs.run1 && { ...obs.run1, input: parse(obs.run1.input) }, run2: obs.run2 && { ...obs.run2, input: parse(obs.run2.input) } }, null, 2))
    fs.writeFileSync(path.join(OUT, 'engine1.log'), (obs.engineLogs1 || []).join('\n'))
    fs.writeFileSync(path.join(OUT, 'engine2.log'), (obs.engineLogs2 || []).join('\n'))
    fs.writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(fake.requests, null, 2))
  }
  console.log(`  · 引擎二日志(摘):\n    ${logLines(obs.engineLogs2).join('\n    ') || '(无相关行)'}`)
  return obs
}

// ── 断言:同一份观测,正向 / 负向各算一遍 ───────────────────────────────────
function evaluate(obs) {
  const pos = OFF ? 'expectRed' : 'required'
  const neg = OFF ? 'required' : 'info'
  console.log('\n── 两种模式共用(被打断、意图文件)')
  check('run 在退出后 status=interrupted', obs.run1?.status === 'interrupted', obs.run1?.status)
  check('run 的 error=interrupted:app_quit(不是 crash / engine_stop / aborted)', obs.run1?.error === 'interrupted:app_quit', obs.run1?.error)
  check('回答行里存着退出前流出的半截正文', /PARTIAL-ALPHA/.test(obs.answer1?.content || ''), (obs.answer1?.content || '').slice(0, 80))
  check('意图文件在退出后还在、reason=app_quit、pid=那个引擎', obs.intent?.reason === 'app_quit' && obs.intent?.pid === obs.engine1?.pid, `${JSON.stringify(obs.intent)} vs pid ${obs.engine1?.pid}`)
  if (WINDOWS) {
    const request = obs.beforeShutdown
    check('Windows:经私有 stdin 请求关停前已写好意图', request?.method === 'stdin' && request.intent?.reason === 'app_quit' && request.intent?.pid === obs.engine1?.pid, JSON.stringify(request))
  }
  const dDir = obs.engine1?.dataDir ? real(path.dirname(obs.engine1.dataDir)) : ''
  const dHome = obs.engine1?.envHome ? real(obs.engine1.envHome) : ''
  const dIntent = obs.intentFiles?.length === 1 ? real(path.dirname(obs.intentFiles[0])) : `(${obs.intentFiles?.length || 0} 个意图文件)`
  check('桌面写意图的目录 = 引擎 --data-dir 所在目录 = 引擎进程里的 TANGU_HOME', !!dDir && dIntent === dDir && dHome === dDir, `intent=${dIntent} dataDir=${dDir} TANGU_HOME=${dHome}`)
  check('意图写在这次退出过程中(at 落在 app.quit() 到进程退出之间)', !!obs.intent && !!obs.quit && obs.intent.at >= obs.quit.startedAt - 1000 && obs.intent.at <= obs.quit.startedAt + obs.quit.ms + 1000, obs.intent && obs.quit ? `at=+${obs.intent.at - obs.quit.startedAt}ms / 退出用了 ${obs.quit.ms}ms` : '')
  check('再开后意图文件被恢复流程删掉', obs.intentAfterRelaunch === false)
  check('一开的引擎 TANGU_AUTO_RESUME=1(开关缺省开)', obs.engine1?.envAuto === '1', obs.engine1?.envAuto)

  console.log(`\n── 正向(自动续跑)${OFF ? ' —— 负对照里应全红' : ''}`)
  const rb = obs.run1After?.resumed_by
  check('旧 run 的 resumed_by = 一个新 run id', !!rb && rb !== '-' && !!obs.run2, rb, pos)
  const in2 = parse(obs.run2?.input)
  check('续跑 run:input.trigger=recovery、resumeOf=旧 run', in2.trigger === 'recovery' && in2.resumeOf === obs.runId, `${in2.trigger} / ${in2.resumeOf}`, pos)
  check('续跑 run 终态 done', obs.run2?.status === 'done', obs.run2?.status, pos)
  const resumeReq = fake.requests.find((r) => r.phase === 'answer' && r.tools > 0 && r.lastUser.includes('<turn_resume>') && r.lastUser.includes('[auto-resume: app_quit]'))
  check('假模型收到最后一条用户消息(引擎每轮追加的 Presentation 提示不算)含 <turn_resume> 与 [auto-resume: app_quit] 的请求', !!resumeReq, resumeReq ? resumeReq.lastUser.slice(0, 60) : `再开后请求 ${fake.requests.filter((r) => r.phase === 'answer').length} 条`, pos)
  const line = (obs.ui?.resumeLines || []).find((l) => l.attr === 'app_quit')
  check(`界面:↻ 续跑行「${COPY.resumed}」`, !!line && line.text.startsWith('↻') && line.text.includes(COPY.resumed), line?.text || JSON.stringify(obs.ui?.resumeLines), pos)
  check('界面:续写正文 RESUMED-OK', (obs.ui?.asst || []).some((t) => t.includes('RESUMED-OK')), (obs.ui?.asst || []).join(' / ').slice(0, 120), pos)
  const resumedLog = logLines(obs.engineLogs2).find((l) => l.includes(`interrupted run ${obs.runId} (app_quit) resumed as`))
  check('引擎日志:interrupted run … (app_quit) resumed as …', !!resumedLog, resumedLog || '', pos)

  console.log(`\n── 负向(开关关着不续)${OFF ? '' : ' —— 正向模式里只打印'}`)
  if (OFF) {
    check('关开关:setConfig 回显 false、桌面配置文件落盘 false', obs.cfgAfterToggle === false && obs.cfgFile === false, `${obs.cfgAfterToggle} / ${obs.cfgFile}`, neg)
    check('再开的引擎 TANGU_AUTO_RESUME=0', obs.engine2?.envAuto === '0', obs.engine2?.envAuto, neg)
  }
  check("旧 run 的 resumed_by='-'", rb === '-', rb, neg)
  check('没有 resumeOf 指向旧 run 的续跑 run', (obs.resumeRuns || []).length === 0, JSON.stringify(obs.resumeRuns), neg)
  check('假模型没收到 <turn_resume> 请求', !fake.requests.some((r) => r.anyResume), '', neg)
  check('会话里多了 <turn_interrupted>[reason: app_quit] 说明行', (obs.messages || []).some((m) => m.role === 'user' && m.content.startsWith('<turn_interrupted>\n[reason: app_quit]')), '', neg)
  const iline = (obs.ui?.interruptedLines || []).find((l) => l.attr === 'app_quit')
  check(`界面:⏸ 中断行「${COPY.interrupted}」`, !!iline && iline.text.startsWith('⏸') && iline.text.includes(COPY.interrupted) && !iline.text.includes('已接着做'), iline?.text || '', neg)
  check(`界面:有「${COPY.continue}」按钮`, (obs.ui?.continueBtn || []).length === 1 && obs.ui.continueBtn[0] === COPY.continue, JSON.stringify(obs.ui?.continueBtn), neg)
  check('界面:没有 ↻ 续跑行', (obs.ui?.resumeLines || []).length === 0, '', neg)
  const notLog = logLines(obs.engineLogs2).find((l) => l.includes(`interrupted run ${obs.runId} (app_quit) not resumed: disabled`))
  check('引擎日志:interrupted run … (app_quit) not resumed: disabled', !!notLog, notLog || '', neg)
}

;(async () => {
  for (const f of ['out/main/main.js', '../tangu-agent/dist/standalone/main.js']) if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`缺 ${f} —— 先 build`)
  console.log(`模式:${OFF ? '负对照(--auto-resume-off)' : '正向'} · home=${home}`)
  let obs = null
  try {
    obs = await main()
  } catch (e) {
    console.error(e)
    check('台架跑完', false, e?.message || e)
  }
  if (obs) evaluate(obs)
  if (pageErrors.length) check('没有渲染层报错', false, [...new Set(pageErrors)].slice(0, 3).join(' / '))
  for (const res of fake.hung) { try { res.destroy() } catch { /* */ } }
  for (const s of fake.sockets) { try { s.destroy() } catch { /* */ } }
  server.close()
  // 只收自己拉起的进程
  await sleep(1500)
  for (const pid of ownPids) if (alive(pid)) { console.log(`  · 收尾:进程 ${pid} 还在,SIGKILL`); try { process.kill(pid, 'SIGKILL') } catch { /* */ } }
  if (!WINDOWS) {
    let left = ''
    try { left = execFileSync('pgrep', ['-fl', home], { encoding: 'utf8' }).trim() } catch { left = '' }
    check('没有留下带隔离 home 的进程', !left, left, 'info')
  }
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(`${home}-workspace`, { recursive: true, force: true })
  const bad = results.filter((r) => !r.pass && r.level !== 'info')
  const counted = results.filter((r) => r.level !== 'info')
  console.log(`\n${MODE === 'off' ? '负对照' : '正向'}:${counted.length - bad.length}/${counted.length} 按预期 · 截图 ${SHOT} · 原始数据 ${OUT}`)
  process.exitCode = bad.length ? 1 : 0
})()
