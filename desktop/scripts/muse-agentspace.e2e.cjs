/**
 * Muse 自建 Space(2026-09-11)回归:真 Electron × 假引擎 × **真主进程插件读取器**。
 * 家目录播一个 agent 自建插件(<TANGU_HOME>/tangu/agents/muse/Space/{manifest.json,main.js}),假引擎 status 带 spaceStamp:
 *  ① 进 Muse Space → 主区渲染插件的 home 视图(v1);manifest 里的 id 写成 "bluebird" 也被强制成 agent-muse、不带 capabilities;
 *  ② 磁盘改 main.js + 戳变 → ≤12s 主区变 v2(热重载);
 *  ③ 写坏 main.js(setup 抛错)+ 戳变 → 主区回落空白态(Library 打底)+ POST /agent/special/muse/feedback 收到失败原因;
 *  ④ 修好(v4)→ 退出 → 重启 → 点 Muse 图标 → 命名布局里存的是宿主类型 muse-library,恢复后直接是插件视图(不是 Tangu 内容 / 空框)。
 * 负对照 --nc:假引擎永不更新戳 → ② ③ 必红。先 `npm run build`;跑法 `npm run e2e:museagentspace`;截图 $TMPDIR/forsion-muse-agentspace.png。
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
  const ok = await win.evaluate(() => {
    const b = [...document.querySelectorAll('button.rb-space')].find((x) => /muse/i.test(x.getAttribute('title') || x.textContent || ''))
    if (b) b.click()
    return !!b
  })
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
  fs.writeFileSync(path.join(lib, 'Home.md'), '# Muse\n\n工作区打底。\n', 'utf8')
  // manifest 故意写别家的 id:主进程必须无视它(id 固定 agent-muse),否则 Muse 一写就顶掉真插件
  fs.writeFileSync(path.join(space, 'manifest.json'), JSON.stringify({ id: 'bluebird', name: 'Muse Space', version: '0.1.0', apiVersion: 1, main: 'main.js', capabilities: ['activeWindow'] }), 'utf8')
  fs.writeFileSync(path.join(space, 'main.js'), mainJs(1), 'utf8')

  let stamp = 1
  const bump = () => { if (!NEGATIVE_CONTROL) stamp += 1 }
  const feedback = []
  const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) return [{ path: r, size: 0, mtime: 0, dir: true }, ...walk(path.join(dir, e.name), r)]
    const st = fs.statSync(path.join(dir, e.name))
    return [{ path: r, size: st.size, mtime: st.mtimeMs, dir: false }]
  })
  const stub = await startStubEngine({
    sessions: [], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    handle: async ({ path: p, method, body }) => {
      if (p === '/agent/special/muse/status') return { status: { enabled: true, hasModel: true, running: false, restartsThisWindow: 0, maxRestartsPerWindow: 3, lastCycleAt: null, lastError: null, sessionId: null, mode: 'ask', heartbeatMinutes: 120, pendingApprovals: 0, libraryDir: lib, spaceDir: space, spaceStamp: stamp } }
      if (p === '/agent/special/muse/library') return { root: lib, files: walk(lib) }
      if (p === '/agent/special/approvals') return { approvals: [] }
      if (p === '/agent/special/muse/todos') return { todos: [] }
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

    // ④ 修好 → 退出 → 重启 → 点进去就是插件视图(布局只存宿主类型 muse-library)
    fs.writeFileSync(path.join(space, 'main.js'), mainJs(4), 'utf8'); bump()
    check('修好后 ≤12s 恢复(v4)', await visible(win, '.muse-space-hello[data-v="4"]', 12_000))
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
