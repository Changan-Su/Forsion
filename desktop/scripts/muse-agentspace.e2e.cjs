/**
 * Muse 自建 Space(2026-09-11)回归:真 Electron × 假引擎 × **真主进程插件读取器**。
 * 家目录播一个 agent 自建插件(<TANGU_HOME>/tangu/agents/muse/Space/{manifest.json,main.js}),假引擎 status 带 spaceStamp:
 *  ① 进 Muse Space → 主区渲染插件的 home 视图(v1);manifest 里的 id 写成 "bluebird" 也被强制成 agent-muse、不带 capabilities;
 *  ② 磁盘改 main.js + 戳变 → ≤12s 主区变 v2(热重载);
 *  ③ 写坏 main.js(setup 抛错)+ 戳变 → 主区回落空白态(Library 打底)+ POST /agent/special/muse/feedback 收到失败原因;
 *  ④ 修好(v4)后再写成「包成 function setup(ctx){…} 却不调用」(09-27 实机 16 天空白的形态:零注册零报错)
 *    → 主区回落空白态 + feedback 点名「没注册 home、要顶层 registerView」;再写成「home 注册了但 mount 抛错」
 *    → 主区是「插件视图加载失败」+ feedback 点名 mount() threw;再换成用 ctx.agent 从数据渲染的一版(2026-09-27)
 *    → 渲染出待办数与 Journal、挂载时不经手势的 updateTodo 被拒、真点击才放行(引擎收到 done + from pending);再改回 v4;
 *    再换成 async mount(09-27 dev 上 Muse 真这么写):resolve 出的清理在切走 Space 时执行、视图卸载后才 resolve 的当场执行、
 *    reject → 主区「插件视图加载失败」+ feedback 点名(从前 Promise 被当成「没有清理」丢掉,异步抛错只剩控制台一行);
 *  ⑤ 退出 → 重启 → 点 Muse 图标 → 命名布局里存的是宿主类型 muse-library,恢复后直接是插件视图(不是 Tangu 内容 / 空框)。
 * 负对照 --nc:假引擎永不更新戳 → ② ③ ④ 必红。先 `npm run build`;跑法 `npm run e2e:museagentspace`;截图 $TMPDIR/forsion-muse-agentspace.png。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const SHOT = path.join(process.env.SHOT_DIR || os.tmpdir(), 'forsion-muse-agentspace.png')
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${detail || ''}`}`) }

const mainJs = (v) => `ctx.registerView({ id: 'home', title: 'Muse Home', mount(el) {
  el.innerHTML = '<div class="muse-space-hello" data-v="${v}" style="padding:24px;font-size:18px">Hello from Muse v${v}</div>'
  return () => { el.innerHTML = '' }
} })
return () => {}
`
const BROKEN = `ctx.registerView({ id: 'home', title: 'x', mount(el) { el.textContent = 'never' } })\nthrow new Error('boom v3')\n`
// 宿主把整个文件当 setup 的函数体跑:这里只声明了一个内部函数,registerView 永远不执行,也不抛错
const WRAPPED = `function setup(ctx) {\n  ctx.registerView({ id: 'home', title: 'x', mount(el) { el.textContent = 'never' } })\n}\n`
const MOUNT_THROWS = `ctx.registerView({ id: 'home', title: 'x', mount(el) { throw new Error('boom mount') } })\n`
// ctx.agent:从数据渲染;挂载时直接 updateTodo(没有手势)必须被拒;按钮的 click 里才放行
const AGENT_DATA = `ctx.registerView({ id: 'home', title: 'Muse', mount(el) {
  const box = document.createElement('div'); box.className = 'agent-data'; el.append(box)
  ctx.agent.updateTodo('t1', 'done').then(() => { box.dataset.nogesture = 'accepted' }, () => { box.dataset.nogesture = 'rejected' })
  // 借 Space 以外的点击偷偷标掉:宿主只认本视图里的真实交互 → 必须被拒
  const onDoc = (e) => { if (!el.contains(e.target)) ctx.agent.updateTodo('t1', 'dismissed').then(() => { box.dataset.outside = 'accepted' }, () => { box.dataset.outside = 'rejected' }) }
  document.addEventListener('click', onDoc, true)
  const draw = async () => {
    const [todos, journal] = await Promise.all([ctx.agent.todos('pending'), ctx.agent.library.read('Journal/today.md').catch(() => '')])
    box.dataset.todos = String(todos.length); box.dataset.journal = journal.slice(0, 80)
    box.replaceChildren(...todos.map((t) => {
      const b = document.createElement('button'); b.className = 'agent-done'; b.textContent = t.title
      b.onclick = () => ctx.agent.updateTodo(t.id, 'done').then(() => { box.dataset.clicked = 'ok' }, (e) => { box.dataset.clicked = String(e && e.message) })
      return b
    }))
  }
  draw()
  const off = ctx.agent.subscribe(draw)
  return () => { off(); document.removeEventListener('click', onDoc, true) }
} })
`
// async mount:先同步画个 loading 标记,等 __museAsyncDelay 毫秒再 resolve 清理(清理只数次数);box 在 await 前抓住,卸载后照样可写
const ASYNC_OK = `ctx.registerView({ id: 'home', title: 'Muse', async mount(el) {
  el.innerHTML = '<div class="muse-async" data-state="loading" style="padding:24px">async mount</div>'
  const box = el.firstChild
  await new Promise((r) => setTimeout(r, Number(window.__museAsyncDelay || 0)))
  box.dataset.state = 'ready'
  return () => { window.__museAsyncCleanups = (window.__museAsyncCleanups || 0) + 1 }
} })
`
const ASYNC_THROWS = `ctx.registerView({ id: 'home', title: 'x', async mount(el) { await null; throw new Error('boom async mount') } })\n`

async function launch(home, stubUrl) {
  const app = await electron.launch({
    // -ApplePersistenceIgnoreState YES:共用的 Electron.app 最近崩过(别的会话 / 台架),macOS 会在 ready 之前弹
    // 「重新打开窗口时意外退出,要不要再试」的模态框把主线程卡死 —— 台架实例后台起、没人点,firstWindow 永远等不到(09-27 采样实证)
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl },
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.locator('.ntf-close').evaluateAll((bs) => bs.forEach((b) => b.click())).catch(() => {})
  return { app, win }
}
async function clickSpace(win, re) {
  const ok = await win.evaluate((src) => {
    const r = new RegExp(src, 'i')
    const b = [...document.querySelectorAll('button.rb-space')].find((x) => r.test(x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || ''))
    if (b) b.click()
    return !!b
  }, re.source)
  await win.waitForTimeout(1200)
  return ok
}
const clickMuseSpace = (win) => clickSpace(win, /muse/)
const visible = async (win, sel, timeout) => win.waitForSelector(sel, { timeout, state: 'visible' }).then(() => true, () => false)

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-muse-agentspace-'))
  const agentDir = path.join(home, 'tangu', 'agents', 'muse')
  const space = path.join(agentDir, 'Space')
  const lib = path.join(agentDir, 'Library')
  fs.mkdirSync(space, { recursive: true })
  fs.mkdirSync(path.join(lib, 'Journal'), { recursive: true })
  fs.writeFileSync(path.join(lib, 'Home.md'), '# Muse\n\n工作区打底。\n', 'utf8')
  // manifest 故意写别家的 id:主进程必须无视它(id 固定 agent-muse),否则 Muse 一写就顶掉真插件
  fs.writeFileSync(path.join(space, 'manifest.json'), JSON.stringify({ id: 'bluebird', name: 'Muse Space', version: '0.1.0', apiVersion: 1, main: 'main.js', capabilities: ['activeWindow'] }), 'utf8')
  fs.writeFileSync(path.join(space, 'main.js'), mainJs(1), 'utf8')

  let stamp = 1
  const bump = () => { if (!NEGATIVE_CONTROL) stamp += 1 }
  const feedback = []
  let todos = []
  const patches = []
  const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) return [{ path: r, size: 0, mtime: 0, dir: true }, ...walk(path.join(dir, e.name), r)]
    const st = fs.statSync(path.join(dir, e.name))
    return [{ path: r, size: st.size, mtime: st.mtimeMs, dir: false }]
  })
  const stub = await startStubEngine({
    sessions: [], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    handle: async ({ path: p, method, body, url }) => {
      if (p === '/agent/special/muse/status') return { status: { enabled: true, hasModel: true, running: false, restartsThisWindow: 0, maxRestartsPerWindow: 3, lastCycleAt: null, lastError: null, sessionId: null, mode: 'ask', heartbeatMinutes: 120, pendingApprovals: 0, libraryDir: lib, spaceDir: space, spaceStamp: stamp } }
      if (p === '/agent/special/muse/library') return { root: lib, files: walk(lib) }
      if (p === '/agent/special/approvals') return { approvals: [] }
      if (p === '/agent/special/muse/todos') return { todos }
      if (p.startsWith('/agent/special/muse/todos/') && method === 'PATCH') { patches.push({ id: p.split('/').pop(), ...(await body()) }); return { ok: true } }
      if (p === '/agent/special/muse/library/file') return { path: url.searchParams.get('path'), content: fs.readFileSync(path.join(lib, url.searchParams.get('path') || 'x'), 'utf8') }
      if (p === '/agent/special/muse/triggers') return { triggers: [] }
      if (p === '/agent/special/schedule' && method === 'GET') return { schedules: [] }
      if (p === '/agent/special/muse/feedback' && method === 'POST') { feedback.push((await body()).text); return { ok: true } }
      return undefined
    },
  })

  let { app, win } = await launch(home, stub.url)
  try {
    // ⑤ 主进程读取器:id 强制 / 敏感能力剥离 / 来源标记
    const list = await win.evaluate(() => window.amadeus.listPlugins())
    const mine = list.find((x) => x.id === 'agent-muse')
    check('plugins:list 含 agent-muse(id 强制,manifest 的 bluebird 被无视,capabilities 剥掉,agent=muse)',
      !!mine && mine.agent === 'muse' && !mine.capabilities && mine.name === 'Muse Space' && !list.some((x) => x.id === 'bluebird'),
      JSON.stringify(list.map((x) => ({ id: x.id, agent: x.agent, caps: x.capabilities }))))

    // ① 进 Muse Space → 插件视图
    check('ribbon 有 Muse Space 并可进入', await clickMuseSpace(win))
    check('主区 = 插件 home 视图(v1)', await visible(win, '[data-muse-space="plugin"] .muse-space-hello[data-v="1"]', 15_000))

    // ② 热重载
    fs.writeFileSync(path.join(space, 'main.js'), mainJs(2), 'utf8'); bump()
    check('改 main.js + 戳变 → ≤12s 主区变 v2(只重载 agent-muse)', await visible(win, '.muse-space-hello[data-v="2"]', 12_000))
    if (!NEGATIVE_CONTROL) await win.screenshot({ path: SHOT }) // 负对照不截:别把 v1 假象盖在正向截图上

    // ③ 加载失败 → 空白态 + 回写
    fs.writeFileSync(path.join(space, 'main.js'), BROKEN, 'utf8'); bump()
    const empty = await visible(win, '[data-muse-space="empty"]', 12_000)
    const t0 = Date.now()
    while (Date.now() - t0 < 6000 && !feedback.length) await win.waitForTimeout(300)
    check('setup 抛错 → 主区回落空白态(Library 打底)', empty)
    check('失败原因经 POST /agent/special/muse/feedback 回写给 Muse', feedback.some((x) => /failed to load/.test(x) && /boom v3/.test(x)), JSON.stringify(feedback))
    const fbCount = feedback.length
    await win.waitForTimeout(5000)
    check('同一份坏内容只回写一次(不随轮询刷屏)', feedback.length === fbCount, JSON.stringify(feedback))

    // ④ 修好 → 再包成 function setup 不调用 → 空白态 + 回写 → 改回 v4
    fs.writeFileSync(path.join(space, 'main.js'), mainJs(4), 'utf8'); bump()
    check('修好后 ≤12s 恢复(v4)', await visible(win, '.muse-space-hello[data-v="4"]', 12_000))
    fs.writeFileSync(path.join(space, 'main.js'), WRAPPED, 'utf8'); bump()
    const wrappedEmpty = await visible(win, '[data-muse-space="empty"]', 12_000)
    const noHome = () => feedback.some((x) => /registered no "home" view/.test(x) && /top level/.test(x))
    const t1 = Date.now()
    while (Date.now() - t1 < 12_000 && !noHome()) await win.waitForTimeout(300)
    check('main.js 包成 function setup(ctx){…} 不调用 → 主区回落空白态', wrappedEmpty)
    check('「装上了却没注册 home」经 feedback 回写,点名顶层 registerView', noHome(), JSON.stringify(feedback))
    fs.writeFileSync(path.join(space, 'main.js'), MOUNT_THROWS, 'utf8'); bump()
    const mountFailed = await win.waitForFunction(() => /插件视图加载失败|Plugin view failed to load/.test(document.querySelector('[data-muse-space="plugin"]')?.textContent || ''), null, { timeout: 12_000 }).then(() => true, () => false)
    const mountFb = () => feedback.some((x) => /mount\(\) threw/.test(x) && /boom mount/.test(x))
    const t2 = Date.now()
    while (Date.now() - t2 < 8000 && !mountFb()) await win.waitForTimeout(300)
    check('home 注册了但 mount 抛错 → 主区显示「插件视图加载失败」', mountFailed)
    check('挂载失败经 feedback 回写给 Muse(从前只有用户看得见)', mountFb(), JSON.stringify(feedback))
    fs.writeFileSync(path.join(space, 'main.js'), mainJs(4), 'utf8'); bump()
    check('改回 v4 后 ≤12s 恢复', await visible(win, '.muse-space-hello[data-v="4"]', 12_000))

    // ctx.agent(2026-09-27):Space 从数据渲染;挂载时不经手势的 updateTodo 被拒;Playwright 真点击 = 真手势才放行
    const attached = async (sel, timeout) => win.waitForSelector(sel, { timeout, state: 'attached' }).then(() => true, () => false)
    todos = [{ id: 't1', title: 'Try X', detail: null, status: 'pending', source_session_id: null, created_at: '2026-09-27 10:00:00' }]
    fs.writeFileSync(path.join(lib, 'Journal', 'today.md'), '- 01:45 · heartbeat · done\n', 'utf8')
    fs.writeFileSync(path.join(space, 'main.js'), AGENT_DATA, 'utf8'); bump()
    check('ctx.agent:Space 从数据渲染出待办数与 Journal', await attached('.agent-data[data-todos="1"][data-journal*="heartbeat"]', 12_000))
    check('ctx.agent:挂载时不经手势的 updateTodo 被拒', await attached('.agent-data[data-nogesture="rejected"]', 5_000))
    await win.click('text=当前思考') // Space 以外(右栏 Muse 面板)的真实点击
    check('ctx.agent:借 Space 以外的点击调 updateTodo 被拒', await attached('.agent-data[data-outside="rejected"]', 5_000))
    await win.waitForTimeout(1700) // 过了 1.5 秒手势窗口,下面那一下才是唯一的放行来源
    await win.click('.agent-data .agent-done')
    const t3 = Date.now()
    while (Date.now() - t3 < 5000 && !patches.length) await win.waitForTimeout(200)
    check('ctx.agent:Space 里真点击 → updateTodo 放行,引擎收到 done + from pending;别处点击那次没发出去', patches.length === 1 && patches[0].id === 't1' && patches[0].status === 'done' && patches[0].from === 'pending', JSON.stringify(patches))
    todos = []
    fs.writeFileSync(path.join(space, 'main.js'), mainJs(4), 'utf8'); bump()
    check('改回 v4 后 ≤12s 恢复(ctx.agent 之后)', await visible(win, '.muse-space-hello[data-v="4"]', 12_000))

    // async mount(2026-09-27):Promise 形的 mount 从前被当成「没有清理」—— 切走 Space 时订阅 / 监听不退,异步抛错也不回写
    const cleanups = () => win.evaluate(() => window.__museAsyncCleanups || 0)
    await win.evaluate(() => { window.__museAsyncCleanups = 0; window.__museAsyncDelay = 0 })
    fs.writeFileSync(path.join(space, 'main.js'), ASYNC_OK, 'utf8'); bump()
    check('async mount:渲染出来', await visible(win, '.muse-async[data-state="ready"]', 12_000))
    const leftHome = await clickSpace(win, /主页|home/)
    check('async mount:切走 Space → resolve 出的清理执行一次', leftHome && (await cleanups()) === 1, `left=${leftHome} cleanups=${await cleanups()}`)
    await win.evaluate(() => { window.__museAsyncDelay = 2500 })
    await clickMuseSpace(win) // 重新挂载:这一版要 2.5 秒后才 resolve 清理
    const loading = await attached('.muse-async[data-state="loading"]', 5_000)
    await clickSpace(win, /主页|home/) // 还没 resolve 就卸载
    await win.waitForTimeout(2500)
    check('async mount:视图卸载后才 resolve 的清理当场执行', loading && (await cleanups()) === 2, `loading=${loading} cleanups=${await cleanups()}`)
    await win.evaluate(() => { window.__museAsyncDelay = 0 })
    await clickMuseSpace(win)
    fs.writeFileSync(path.join(space, 'main.js'), ASYNC_THROWS, 'utf8'); bump()
    const asyncFailed = await win.waitForFunction(() => /插件视图加载失败|Plugin view failed to load/.test(document.querySelector('[data-muse-space="plugin"]')?.textContent || ''), null, { timeout: 12_000 }).then(() => true, () => false)
    const asyncFb = () => feedback.some((x) => /mount\(\) threw/.test(x) && /boom async mount/.test(x))
    const t4 = Date.now()
    while (Date.now() - t4 < 8000 && !asyncFb()) await win.waitForTimeout(300)
    check('async mount reject → 主区显示「插件视图加载失败」', asyncFailed)
    check('async mount reject 经 feedback 回写给 Muse', asyncFb(), JSON.stringify(feedback))
    fs.writeFileSync(path.join(space, 'main.js'), mainJs(4), 'utf8'); bump()
    check('改回 v4 后 ≤12s 恢复(async mount 之后)', await visible(win, '.muse-space-hello[data-v="4"]', 12_000))

    // ⑤ 退出 → 重启 → 点进去就是插件视图(布局只存宿主类型 muse-library)
    await app.close()
    ;({ app, win } = await launch(home, stub.url))
    check('重启后 ribbon 仍有 Muse Space', await clickMuseSpace(win))
    check('重启 + 点进 Muse Space → 主区直接是插件视图(v4),不是空框/Tangu 内容', await visible(win, '[data-muse-space="plugin"] .muse-space-hello[data-v="4"]', 15_000))
  } finally {
    await app.close().catch(() => {})
    stub.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过` + (NEGATIVE_CONTROL ? '(负对照:热重载/回写两组应转红)' : `;截图 ${SHOT}`))
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
