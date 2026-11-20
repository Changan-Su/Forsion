#!/usr/bin/env node
/**
 * 中断任务续跑(方案 B)的界面截图 + 轻断言:真 Electron × 真托管引擎 × 隔离 home。
 * 方案页:仓根 docs/ToBeImproved/中断任务续跑方案_2026-11-20/index.html 第 7 节(界面)。
 *
 * 摆三个场景,每个场景旁边断言 DOM,再截图交给人看(观感不外包):
 *   A  一轮回答两个工具调用(read_file 有真结果、write_file 只有占位 { tool_call_id, name, inflight: started/write })
 *      → 引擎自动续跑行 autoResumeMarker('app_update') → 续写正文。期望「↻ 更新打断了这一轮，已接着做」,
 *      折叠头不把那一步算成写入、只说「1 步被打断」;展开后那一行整行淡色、行尾写「结果未知」,再展开先说结局、
 *      打算写的内容收在折叠「打算做的改动」里。折叠 / 展开各一张。
 *   B  同样的第一轮,最后一行是 interruptedNoticeMarker('app_quit')。期望「⏸ 应用退出时这一轮还没做完」+「继续生成」。
 *   C  设置 › Agent › 名册页的「重启后自动接着做未完成的任务」开关(缺省开)。
 * 中文跑亮 / 暗两套(A、B)+ 亮色 C;英文(--lang=en-US,另起一个实例、内容也换英文)跑亮色 A、B 看文案。
 *
 * 怎么种数据:
 *   ① POST /agent/sessions/import(真路由)建会话和四 / 三条消息 —— 续跑行、中断行本来就是 user 行,正文照原样导入;
 *   ② 导入接口不收 tool_calls / tool_results,所以再用 node:sqlite 直接改隔离 home 里那份 state.db:
 *      第一条回答补上两个调用和结果(占位就是引擎边跑边落库留下的那种形状),role 改回引擎自己写的 'model',
 *      origin 与会话 agent_config.imported 去掉(真被打断的会话不是导入的)。改完先 GET /messages 核一遍占位真的带着 inflight。
 * 引擎令牌 / 地址从渲染层 window.tangu.getConfig() 取(托管模式就绪后 = 本机令牌 + 引擎地址),库路径取引擎进程的 --data-dir。
 * 打开会话走 forsion://session/<id>(主窗的 open-link 动作,同 deep link)。
 *
 * 用法(cd desktop;量的是 out/ 产物,先 npx electron-vite build;引擎跑 ../tangu-agent/dist,本脚本不替你 build):
 *   node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="resume lines shots" --eta=6 -- node scripts/resume-lines.shots.cjs
 *   旋钮:SHOT_DIR=<目录>(缺省系统临时目录 forsion-resume-lines-shots)、--only=zh|en
 * 退出码:任一断言 FAIL 或渲染层抛错 → 1。截图是否「看起来对」仍要人看。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { pathToFileURL } = require('url')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const OUT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-resume-lines-shots')
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const pageErrors = []

/** 两种语言的夹具文字:英文实例里内容也是英文,界面上剩下的中文就一定是应用自己的。 */
const TEXT = {
  zh: {
    ask: '把 notes 目录下的周报合并成一份月报',
    readPath: 'notes/week1.md', readOut: '# 第一周\n- 登录页改版上线\n- 修了同步冲突的两个 bug\n',
    writePath: 'notes/月报-11月.md', writeBody: '# 11 月月报\n\n## 第一周\n- 登录页改版上线\n\n## 第二周\n- 发布 2.14 beta\n',
    first: '前两周的内容已经合并进月报，接下来处理第三周的。',
    cont: '月报里前两周已经在了，从第三周接着合并：第三周的三条要点已经补进「第三周」一节，月报现在是完整的。',
    autoLine: '更新打断了这一轮，已接着做', quitLine: '应用退出时这一轮还没做完', cont_btn: '继续生成',
    cutSum: '1 步被打断', wroteWord: '写入', unknown: '结果未知', toggle: '重启后自动接着做未完成的任务', cardState: '被打断',
  },
  en: {
    ask: 'Merge the weekly reports in the notes folder into one monthly report',
    readPath: 'notes/week1.md', readOut: '# Week 1\n- Shipped the new sign-in page\n- Fixed two sync conflict bugs\n',
    writePath: 'notes/monthly-report-nov.md', writeBody: '# November report\n\n## Week 1\n- Shipped the new sign-in page\n\n## Week 2\n- Released 2.14 beta\n',
    first: 'Weeks 1 and 2 are merged into the monthly report. Moving on to week 3.',
    cont: 'Weeks 1 and 2 are already in the report, so I continued from week 3: its three points are now under "Week 3" and the report is complete.',
    autoLine: 'An update interrupted this task — picked up where it left off', quitLine: 'This task was cut off when the app quit', cont_btn: 'Continue',
    cutSum: '1 interrupted', wroteWord: 'Wrote', unknown: 'Outcome unknown', toggle: 'Resume unfinished tasks after a restart', cardState: 'Interrupted',
  },
}

/** 第一轮回答的两个调用:read_file 做完了(真结果),write_file 只留下引擎边跑边落库的占位。ui_content_offset 0 = 工具行在正文前面。 */
function firstTurnTools(x) {
  const calls = [
    { id: 'call_read_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: x.readPath }) }, ui_content_offset: 0 },
    { id: 'call_write_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: x.writePath, content: x.writeBody }) }, ui_content_offset: 0 },
  ]
  const results = [
    { tool_call_id: 'call_read_1', name: 'read_file', content: x.readOut, isError: false, startedAt: Date.now() - 60_000, elapsedMs: 120, outputChars: x.readOut.length },
    { tool_call_id: 'call_write_1', name: 'write_file', inflight: { state: 'started', sideEffect: 'write' } },
  ]
  return { calls, results }
}

async function engineFetch(cfg, route, init = {}) {
  const r = await fetch(cfg.backendUrl + route, { ...init, headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } })
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${route} → ${r.status} ${JSON.stringify(body)}`)
  return body
}

/** 引擎进程命令行里的 --data-dir(= state.db 文件路径)。 */
function engineDbPath(pid) {
  const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  const m = cmd.match(/--data-dir\s+(\S+)/)
  if (!m) throw new Error(`引擎命令行里没有 --data-dir:${cmd.slice(0, 200)}`)
  return m[1]
}

/** 导入两条会话(A、B),再在库里补工具调用 / 占位;返回 { A, B } 会话 id。 */
async function seed(win, lang, M) {
  const x = TEXT[lang]
  const cfg = await win.evaluate(() => window.tangu.getConfig())
  if (!cfg.backendUrl || !cfg.token) throw new Error('getConfig 里没有引擎地址 / 令牌(托管引擎没就绪?)')
  const first = [{ role: 'user', content: x.ask }, { role: 'assistant', content: x.first }]
  const body = {
    app_id: 'tangu', source: 'gui-shots', projectless: true,
    conversations: [
      { external_id: `resume-a-${lang}`, title: lang === 'zh' ? '续跑 A · 更新后自动接着做' : 'Resume A · auto-resumed after update', messages: [...first, { role: 'user', content: M.autoResumeMarker('app_update') }, { role: 'assistant', content: x.cont }] },
      { external_id: `resume-b-${lang}`, title: lang === 'zh' ? '续跑 B · 退出后没自动续' : 'Resume B · not resumed after quit', messages: [...first, { role: 'user', content: M.interruptedNoticeMarker('app_quit') }] },
    ],
  }
  const { results: res } = await engineFetch(cfg, '/agent/sessions/import', { method: 'POST', body: JSON.stringify(body) })
  const ids = Object.fromEntries(res.map((r) => [r.external_id.startsWith('resume-a') ? 'A' : 'B', r.session_id]))
  if (!ids.A || !ids.B) throw new Error(`导入失败:${JSON.stringify(res)}`)

  const st = await win.evaluate(() => window.tangu.backendStatus())
  const dbPath = engineDbPath(st.pid)
  process.removeAllListeners('warning') // node:sqlite 的 ExperimentalWarning 不进输出
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const { calls, results } = firstTurnTools(x)
    for (const sid of [ids.A, ids.B]) {
      const row = db.prepare(`SELECT id FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY timestamp, rowid LIMIT 1`).get(sid)
      if (!row) throw new Error(`会话 ${sid} 里没找到第一条回答`)
      db.prepare('UPDATE chat_messages SET tool_calls = ?, tool_results = ? WHERE id = ?').run(JSON.stringify(calls), JSON.stringify(results), row.id)
      db.prepare(`UPDATE chat_messages SET role = CASE role WHEN 'assistant' THEN 'model' ELSE role END, origin = NULL WHERE session_id = ?`).run(sid)
      db.prepare('UPDATE chat_sessions SET agent_config = NULL, title_manual = FALSE WHERE id = ?').run(sid)
    }
  } finally { db.close() }

  // 核对引擎吐出来的确实是占位(带 inflight、没有 content),再打开界面
  for (const [k, sid] of Object.entries(ids)) {
    const { messages } = await engineFetch(cfg, `/agent/sessions/${sid}/messages`)
    const asst = messages.find((m) => m.role === 'model' && Array.isArray(m.tool_results) && m.tool_results.length)
    const ph = asst?.tool_results?.find((r) => r.tool_call_id === 'call_write_1')
    check(`${lang} 种子 ${k}:引擎返回占位 inflight=started、没有 content`, ph?.inflight?.state === 'started' && ph.content === undefined, JSON.stringify(ph))
    check(`${lang} 种子 ${k}:最后一行是机器行`, /^<turn_(resume|interrupted)>/.test(messages[messages.length - (k === 'A' ? 2 : 1)].content || ''), `${messages.length} 条`)
  }
  return { ids, dbPath }
}

const mainWindowSend = (app, action, payload) => app.evaluate(({ BrowserWindow }, [a, p]) => {
  const w = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed() && !x.webContents.getURL().includes('window=')).sort((m, n) => m.id - n.id)[0]
  w.webContents.send('window:mainAction', a, p)
}, [action, payload])

async function openSession(app, win, sid, wantAssistants) {
  await mainWindowSend(app, 'open-link', `forsion://session/${sid}`)
  const surface = win.locator(`[data-chat-surface="chat"][data-session-id="${sid}"]`)
  await surface.waitFor({ timeout: 20_000 })
  await win.waitForFunction(([s, n]) => document.querySelectorAll(`[data-chat-surface="chat"][data-session-id="${s}"] .t2-asst`).length >= n, [sid, wantAssistants], { timeout: 20_000 })
  await win.evaluate(() => document.fonts.ready)
  await sleep(700) // 入场动效、滚到底
  await win.mouse.move(5, 400) // 悬停操作条别挂在消息上
  return surface
}

async function setMode(win, mode) {
  await win.evaluate((m) => localStorage.setItem('forsion_theme_pref', m), mode)
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('.rb', { timeout: 30_000 })
  await win.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, { timeout: 10_000 })
  await sleep(1200)
}

async function shotA(app, win, ids, lang, mode) {
  const x = TEXT[lang]
  const surface = await openSession(app, win, ids.A, 2)
  const line = surface.locator('[data-turn-resume="app_update"]')
  const lineText = (await line.textContent().catch(() => '')) || ''
  check(`${lang}/${mode} A:续跑行文案`, lineText.includes(x.autoLine) && lineText.trim().startsWith('↻'), lineText.trim())
  const head = surface.locator('.tool-group-head').first()
  const sum = ((await head.locator('.tool-group-sum-long').textContent().catch(() => '')) || '').trim()
  check(`${lang}/${mode} A:折叠头只说被打断、不算写入`, sum.includes(x.cutSum) && !sum.includes(x.wroteWord), sum)
  check(`${lang}/${mode} A:折叠头没有失败红叉`, (await head.locator('.tool-group-status svg').count()) === 1 && !(await head.locator('.tool-group-status svg').first().evaluate((s) => s.getAttribute('style') || '')).includes('--danger'))
  await surface.screenshot({ path: path.join(OUT, `${lang}-${mode}-A-collapsed.png`), animations: 'disabled' })
  await head.click()
  const row = surface.locator('.tool-row[data-inflight="started"]')
  await row.waitFor({ timeout: 5000 })
  check(`${lang}/${mode} A:占位那一步标成 inflight=started(只有一行)`, (await surface.locator('.tool-row[data-inflight]').count()) === 1)
  // 占位那一行整行淡色(方案「灰色的一步」):动词、目标的字色都和做完那一行不同;行尾写明「结果未知」
  const colors = await surface.evaluate((el) => [...el.querySelectorAll('.tool-row')].map((r) => ({ inflight: !!r.getAttribute('data-inflight'), verb: getComputedStyle(r.querySelector('.tool-row-verb')).color, target: getComputedStyle(r.querySelector('.tool-row-target') || r).color })))
  const cut = colors.find((c) => c.inflight), ok = colors.find((c) => !c.inflight)
  check(`${lang}/${mode} A:占位那一行是淡色(动词 / 目标都和做完那行不同)`, !!cut && !!ok && cut.verb !== ok.verb && cut.target !== ok.target, JSON.stringify(colors))
  const tail = ((await row.locator('.tool-row-inflight').textContent().catch(() => '')) || '').trim()
  check(`${lang}/${mode} A:行尾写明结果未知`, tail === x.unknown, tail)
  await row.locator('.tool-row-head').click()
  await sleep(500)
  const body = ((await row.textContent().catch(() => '')) || '')
  check(`${lang}/${mode} A:展开后说结果未知`, body.includes(x.unknown), body.replace(/\s+/g, ' ').slice(0, 160))
  check(`${lang}/${mode} A:占位那一步不报 +N 行`, !/\+\d+/.test(((await row.locator('.tool-row-head').textContent()) || '')))
  const order = await row.locator('.tool-card-body').evaluate((b) => ({ first: b.firstElementChild?.className || '', diffTop: [...b.children].some((c) => c.matches('.wsfile-diff, .wsfile-diff-raw')), diffFolded: !!b.querySelector('details .wsfile-diff, details .wsfile-diff-raw, details .spin') }))
  check(`${lang}/${mode} A:展开先说结局,打算写的内容收在折叠里`, order.first === 'label' && !order.diffTop && order.diffFolded, JSON.stringify(order))
  await win.mouse.move(5, 400)
  await sleep(300)
  await surface.screenshot({ path: path.join(OUT, `${lang}-${mode}-A-expanded.png`), animations: 'disabled' })
}

async function shotB(app, win, ids, lang, mode) {
  const x = TEXT[lang]
  const surface = await openSession(app, win, ids.B, 1)
  const line = surface.locator('[data-interrupted="app_quit"]')
  const lineText = (await line.textContent().catch(() => '')) || ''
  check(`${lang}/${mode} B:中断行文案`, lineText.includes(x.quitLine) && lineText.trim().startsWith('⏸'), lineText.trim())
  const btn = surface.locator('[data-testid="msg-continue"]')
  const btnText = ((await btn.textContent().catch(() => '')) || '').trim()
  check(`${lang}/${mode} B:有「继续生成」`, (await btn.count()) === 1 && btnText === x.cont_btn, btnText)
  check(`${lang}/${mode} B:没有红色失败行`, (await surface.locator('.t2-tool.err').count()) === 0)
  const card = ((await win.locator('.t2-tsum-state-tx').first().textContent().catch(() => '')) || '').trim()
  check(`${lang}/${mode} B:右侧任务卡说「被打断」不说「已停止」`, card === x.cardState, card)
  await surface.screenshot({ path: path.join(OUT, `${lang}-${mode}-B.png`), animations: 'disabled' })
}

async function shotC(app, lang) {
  const x = TEXT[lang]
  const win = app.windows()[0]
  await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'agents/ag-roster', n: Date.now() } }))
  let fl = null
  for (let i = 0; i < 80 && !fl; i++) {
    for (const w of app.windows().filter((p) => !p.isClosed() && p.url().includes('window=floating'))) {
      if (await w.locator('[data-setting-anchor="auto-resume"]').count().catch(() => 0)) { fl = w; break }
    }
    if (!fl) await sleep(250)
  }
  check(`${lang} C:设置浮窗里有自动续跑开关`, !!fl)
  if (!fl) return
  const anchor = fl.locator('[data-setting-anchor="auto-resume"]')
  await anchor.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await sleep(600)
  const sw = anchor.locator('[role="switch"]')
  check(`${lang} C:开关缺省开`, (await sw.getAttribute('aria-checked')) === 'true')
  check(`${lang} C:开关标题`, ((await anchor.textContent()) || '').includes(x.toggle), ((await anchor.textContent()) || '').replace(/\s+/g, ' ').slice(0, 160))
  await fl.screenshot({ path: path.join(OUT, `${lang}-light-C-settings.png`), animations: 'disabled' })
}

async function run(lang, M) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `forsion-resume-shots-${lang}-`))
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(`${userData}-dev`, { recursive: true }) // 未打包时主进程读 <dir>-dev
  fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', unitHostEnabled: false }))
  const env = { ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: 'http://127.0.0.1:1' }
  delete env.TANGU_BACKEND_URL
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, `--lang=${lang === 'zh' ? 'zh-CN' : 'en-US'}`, ROOT], cwd: ROOT, env, timeout: 60_000 })
    app.on('window', (w) => w.on('pageerror', (e) => pageErrors.push(`${lang}: ${String(e?.message || e).slice(0, 200)}`)))
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(`${lang}: ${String(e?.message || e).slice(0, 200)}`))
    win.setDefaultTimeout(15_000)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 860))
    await win.waitForSelector('#root')
    await sleep(1500)
    for (const label of ['跳过引导', 'Skip onboarding', 'Skip']) {
      const b = win.getByRole('button', { name: label, exact: true })
      if (await b.count()) await b.click()
    }
    await win.waitForSelector('.rb', { timeout: 45_000 })
    for (let i = 0; i < 450; i++) {
      if ((await win.evaluate(() => window.tangu.backendStatus())).state === 'ready') break
      await sleep(100)
    }
    const { ids } = await seed(win, lang, M)
    await mainWindowSend(app, 'sessions-changed')
    const modes = lang === 'zh' ? ['light', 'dark'] : ['light']
    for (const mode of modes) {
      await setMode(win, mode)
      await shotA(app, win, ids, lang, mode)
      await shotB(app, win, ids, lang, mode)
    }
    if (lang === 'zh') { await setMode(win, 'light'); await shotC(app, lang) }
  } finally {
    if (app) await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(`${home}-workspace`, { recursive: true, force: true })
  }
}

;(async () => {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('缺 out/main/main.js —— 先 npx electron-vite build')
  const contract = path.join(ROOT, '..', 'tangu-agent', 'dist', 'contracts', 'turnResume.js')
  if (!fs.existsSync(contract)) throw new Error('缺 tangu-agent/dist —— 先在 tangu-agent 里 npm run build')
  const M = await import(pathToFileURL(contract).href)
  fs.mkdirSync(OUT, { recursive: true })
  for (const lang of ['zh', 'en']) if (!ONLY || ONLY === lang) await run(lang, M)
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过 · 截图 → ${OUT}`)
  if (pageErrors.length) console.log(`渲染层报错 ${pageErrors.length} 个:\n  ${[...new Set(pageErrors)].join('\n  ')}`)
  if (failed || pageErrors.length) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })
