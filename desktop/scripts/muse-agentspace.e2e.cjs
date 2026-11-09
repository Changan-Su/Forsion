/**
 * Muse Space 不再装载卜算子自己写的 main.js(2026-11-08 方案 D,用户定:老用户直接换成宿主画的「今日简报」,
 * main.js 留在 agents/muse/Space/ 不删、不加载、不加切回开关)。真 Electron × 假引擎 × **真主进程插件读取器**。
 * 家目录播一份卜算子以前写的 Space(manifest.json + main.js,内容是会注册 home 视图的老写法):
 *  ① plugins:list 里没有 agent-muse(主进程 readAgentSpacePlugins 跳过 muse);
 *  ② 进 Muse Space → 主区是简报([data-muse-brief]),没有插件视图、没有 main.js 画的字;
 *  ③ 几轮轮询后引擎没收到任何关于 Space 的 [feedback](不装载 = 不会把它的报错回灌给卜算子);
 *  ④ 退出 → 重启 → 点 Muse 图标:命名布局里存的是宿主类型 muse-library,恢复后直接是简报;
 *  ⑤ main.js 原样留在磁盘上(字节不变)。
 * 11-08 之前这份台架测的是 main.js 插件的热重载 / 失败回写 / ctx.agent;那条路对 Muse 已经关了(agentSpaceSync 仍在,留给以后别的 agent)。
 * 负对照:对着 11-08 之前的构建跑 → ① ② 必红(插件装上、主区是插件视图)。
 * 先 `npm run build`;跑法 `npm run e2e:museagentspace`;截图 $TMPDIR/forsion-muse-agentspace.png。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const SHOT = path.join(process.env.SHOT_DIR || os.tmpdir(), 'forsion-muse-agentspace.png')
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${detail || ''}`}`) }

const OLD_MAIN = `ctx.registerView({ id: 'home', title: 'Muse Home', mount(el) {
  el.innerHTML = '<div class="muse-space-hello" style="padding:24px">Hello from Muse main.js</div>'
  return () => { el.innerHTML = '' }
} })
`

async function launch(home, stubUrl) {
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
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
async function clickMuseSpace(win) {
  const hit = () => win.evaluate(() => {
    const b = [...document.querySelectorAll('button.rb-space')].find((x) => /muse/i.test(x.getAttribute('aria-label') || x.getAttribute('title') || x.textContent || ''))
    if (b) b.click()
    return !!b
  })
  let ok = await hit()
  // Ribbon 收起态只渲染窗口内的 Space,窗外是无按钮的 .rb-cell 占位:先点「…」展开,点完再收起(同 muse-space.e2e)。
  if (!ok) {
    await win.locator('.rb-top .rb-more').first().click().catch(() => {})
    await win.waitForTimeout(300)
    ok = await hit()
    await win.evaluate(() => document.querySelector('.rb-open-top .rb-more')?.click())
  }
  await win.waitForTimeout(1200)
  return ok
}
const visible = async (win, sel, timeout) => win.waitForSelector(sel, { timeout, state: 'visible' }).then(() => true, () => false)

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-muse-agentspace-'))
  const agentDir = path.join(home, 'tangu', 'agents', 'muse')
  const space = path.join(agentDir, 'Space')
  const lib = path.join(agentDir, 'Library')
  fs.mkdirSync(space, { recursive: true })
  fs.mkdirSync(path.join(lib, 'Journal'), { recursive: true })
  fs.writeFileSync(path.join(space, 'manifest.json'), JSON.stringify({ name: 'Muse Space', version: '1.5.14', apiVersion: 1, main: 'main.js' }), 'utf8')
  fs.writeFileSync(path.join(space, 'main.js'), OLD_MAIN, 'utf8')
  const mainBytes = fs.readFileSync(path.join(space, 'main.js'))

  const feedback = []
  const stub = await startStubEngine({
    sessions: [], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    handle: async ({ path: p, method, body }) => {
      if (p === '/agent/special/muse/status') return { status: { enabled: true, hasModel: true, running: false, restartsThisWindow: 0, maxRestartsPerWindow: 3, lastCycleAt: Date.now() - 600_000, lastError: null, sessionId: null, mode: 'ask', heartbeatMinutes: 120, pendingApprovals: 0, libraryDir: lib, spaceDir: space, spaceStamp: 5, wakePending: false, wakeBlocked: null } }
      if (p === '/agent/special/muse/space') return { view: { enabled: true, hasDoc: true, libraryRoot: lib, hero: { text: '简报台架:这句话来自 space.json。', at: Date.now() - 300_000, sources: [] }, prepared: [], cards: [{ key: 'todos', ref: { builtin: 'todos' }, source: 'default' }, { key: 'today', ref: { builtin: 'today' }, source: 'default' }, { key: 'tracking', ref: { builtin: 'tracking' }, source: 'default' }], hidden: [], proposed: [], sections: { prepared: true, today: true }, rev: { doc: 1, placement: 0 }, problems: [], stoppedAt: null } }
      if (p === '/agent/special/muse/library') return { root: lib, files: [] }
      if (p === '/agent/special/muse/library/file') return { __code: 404, body: { detail: 'not found' } }
      if (p === '/agent/special/approvals') return { approvals: [] }
      if (p === '/agent/special/muse/todos') return { todos: [] }
      if (p === '/agent/special/muse/triggers') return { triggers: [] }
      if (p === '/agent/special/muse/rounds') return { rounds: [] }
      if (p === '/agent/special/schedule' && method === 'GET') return { schedules: [] }
      if (p === '/agent/special/muse/feedback' && method === 'POST') { feedback.push((await body()).text); return { ok: true } }
      return undefined
    },
  })

  let { app, win } = await launch(home, stub.url)
  try {
    const list = await win.evaluate(() => window.amadeus.listPlugins())
    check('① plugins:list 里没有 agent-muse(磁盘上有 main.js 也不装)', !list.some((x) => x.id === 'agent-muse'), JSON.stringify(list.map((x) => x.id)))

    check('ribbon 有 Muse Space 并可进入', await clickMuseSpace(win))
    check('② 主区 = 今日简报(那句话来自 space.json)', await visible(win, '[data-muse-brief] [data-hero] .msb-lede', 15_000)
      && /这句话来自 space.json/.test(await win.locator('[data-muse-brief] .msb-lede').innerText().catch(() => '')))
    check('② 没有插件视图、没有 main.js 画的字', (await win.locator('[data-muse-space="plugin"], .muse-space-hello').count()) === 0)
    await win.screenshot({ path: SHOT })

    await win.waitForTimeout(6000) // 几轮面板 / 简报轮询
    check('③ 引擎没收到关于 Space 的 [feedback]', !feedback.some((x) => /Space|main\.js/.test(x)), JSON.stringify(feedback))

    await app.close()
    ;({ app, win } = await launch(home, stub.url))
    await clickMuseSpace(win)
    check('④ 重启后点 Muse 图标 → 恢复的就是简报', await visible(win, '[data-muse-brief] [data-hero]', 15_000))
    check('⑤ main.js 原样留在磁盘上', Buffer.compare(fs.readFileSync(path.join(space, 'main.js')), mainBytes) === 0)
  } catch (e) {
    check('台架跑完', false, String((e && e.stack) || e).slice(0, 600))
  } finally {
    await app.close().catch(() => {})
    stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main()
