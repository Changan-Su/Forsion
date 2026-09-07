/**
 * 代码回退(B1)的**整条链路** e2e:真 Electron × 真组件/store/HTTP 层
 * × 受控后端。
 *
 * 为什么要这一层(前两层都证不到):
 *  - vitest 证的是引擎语义(真 sqlite/真 express)与 store 归约,证不到「渲染进程真的把这些接上了」;
 *  - `check:plancard` 注入真 CSS 但用的是静态 DOM,证的是几何,不是接线。
 *  中间那截 —— 回退菜单会不会拉 checkpoint、按下去发的 `at` 对不对 —— 此前**一个测试都没有**。
 *
 * 做法:`TANGU_BACKEND_URL` 指向本脚本起的桩后端。桩既回确定应答,又**记录 UI 发来的请求**,
 * 于是能反向断言「restore 带的 at 是那条消息的时间戳」这类接线事实。
 * 引擎侧的真文件另有 vitest 覆盖(checkpoints.test),
 * 这里刻意不再起真引擎:那会把测试变成「等模型/等迁移」,慢且脆。
 *
 * 需先 npm run build。用法:npm run e2e:recall
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先 pkill -f "node_modules/electron/dist/Electron.app"。
 */
const fs = require('fs')
const os = require('os')
const http = require('http')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

// ── 受控后端 ──────────────────────────────────────────────────────────────
const T_MSG = Date.UTC(2026, 7, 14, 3, 0, 0) // 命中消息的时间戳
const SESSIONS = [
  { id: 's-hit', title: '上周那次排查', summary: '', model_id: 'm1', archived: false, emoji: null, agent_config: null, projectless: true, project_path: null, project_name: null, created_at: '2026-08-14 10:00:00', updated_at: '2026-08-14 10:00:00' },
  { id: 's-other', title: '另一个会话', summary: '', model_id: 'm1', archived: false, emoji: null, agent_config: null, projectless: true, project_path: null, project_name: null, created_at: '2026-08-13 10:00:00', updated_at: '2026-08-13 10:00:00' },
]
const MESSAGES = [
  { id: 'u1', role: 'user', content: '帮我看看登录那块', reasoning: null, tool_calls: null, tool_results: null, attachments: null, display_files: null, agent_slug: null, timestamp: T_MSG - 60_000, model_id: 'm1', is_error: false },
  { id: 'a1', role: 'model', content: '看了,localStorage 初始化有问题', reasoning: null, tool_calls: null, tool_results: null, attachments: null, display_files: null, agent_slug: null, timestamp: T_MSG, model_id: 'm1', is_error: false },
]
const CHECKPOINT_AT = T_MSG - 30_000 // 落在 u1 之后:回退到 u1 时该被算进去

const seen = { checkpoints: 0, restore: [] }

function serve(req, res) {
  const u = new URL(req.url, 'http://x')
  const p = u.pathname
  const json = (body, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (/^\/agent\/sessions\/[^/]+\/checkpoints$/.test(p)) {
    seen.checkpoints += 1
    return json({ checkpoints: [{ runId: 'r1', at: CHECKPOINT_AT, files: ['/tmp/demo/a.ts', '/tmp/demo/b.ts'], skipped: [] }] })
  }
  if (/^\/agent\/sessions\/[^/]+\/checkpoints\/restore$/.test(p)) {
    let raw = ''
    req.on('data', (c) => { raw += c })
    return req.on('end', () => {
      try { seen.restore.push(JSON.parse(raw || '{}')) } catch { seen.restore.push({ parseError: raw }) }
      json({ restored: ['/tmp/demo/a.ts', '/tmp/demo/b.ts'], deleted: [], skipped: [], conflicts: [], failed: [] })
    })
  }
  if (p === '/agent/sessions') return json({ sessions: SESSIONS })
  if (/^\/agent\/sessions\/[^/]+\/messages$/.test(p)) return json({ messages: MESSAGES })
  if (/^\/agent\/sessions\/[^/]+\/config$/.test(p)) return json({ agent_config: { execMode: 'host', approvalMode: 'auto-edit' } })
  if (/^\/agent\/sessions\/[^/]+\/background$/.test(p)) return json({ background: [] })
  if (p === '/agent/models') return json({ models: [{ id: 'm1', name: 'Stub', provider: 'stub', contextWindow: 128000 }], defaultModelId: 'm1' })
  // 其余一律给「空但结构正确」的应答:桌面启动会摸不少端点,少一个就卡在加载态。
  return json({ ok: true, items: [], list: [], data: [], skills: [], agents: [], tools: [], commands: [], engines: [], providers: [], background: [], messages: [], sessions: [] })
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const srv = http.createServer(serve)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const backend = `http://127.0.0.1:${srv.address().port}`
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-recall-'))

  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: backend },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(1500)
    // renderer 的「上次 Space」可能来自另一个 dev 实例;显式进入 Tangu,别拿侧栏里任意搜索框当 Space 探针。
    const spaceBtn = win.locator('.rb-space[title="Agent"]').first()
    if (await spaceBtn.count().catch(() => 0)) { await spaceBtn.click().catch(() => {}); await win.waitForTimeout(1000) }
    // 侧栏折叠时先展开(同 check:newtab)
    if (!(await win.locator('.t2s-mode').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(800)
    }

    // ① 从会话列表打开预置会话,确认历史消息已经水合。
    await win.locator('.t2s-srow', { hasText: '上周那次排查' }).first().click()
    await win.waitForTimeout(1800)
    const messageCount = await win.evaluate(() => document.querySelectorAll('[id^="tocmsg-"]').length)
    check('① 会话打开并水合历史消息', messageCount >= 2, `messages=${messageCount}`)

    // ② 回退菜单:hover 用户消息 → 打开 → 文件数来自后端 checkpoints
    const userRow = win.locator('.t2-userwrap').first()
    await userRow.hover()
    await win.waitForTimeout(300)
    const rewindBtn = userRow.locator('.t2-iconbtn').nth(2) // 复制 / 编辑 / 回退
    await rewindBtn.click()
    await win.waitForTimeout(900)
    const menuText = await win.locator('.rewind-menu').first().textContent().catch(() => '')
    check('② 回退菜单打开,文件数取自后端(2 个)', /2/.test(menuText || '') && seen.checkpoints > 0,
      `checkpointsReq=${seen.checkpoints} menu=${JSON.stringify((menuText || '').slice(0, 60))}`)

    // ③ 点「仅回退代码」→ POST restore,at 必须是那条用户消息的时间戳
    await win.locator('.rewind-menu .menu-item').first().click()
    await win.waitForTimeout(1200)
    check('③ 发出 restore 请求', seen.restore.length === 1, JSON.stringify(seen.restore))
    check('③ ⚠️restore 带的 at = 该用户消息的时间戳(回退点算错=回退到别的时刻)',
      seen.restore[0]?.at === MESSAGES[0].timestamp, `at=${seen.restore[0]?.at} 期望=${MESSAGES[0].timestamp}`)

    // ④ 仅回退代码不该删对话(消息还在)
    const afterMsgs = await win.evaluate(() => document.querySelectorAll('[id^="tocmsg-"]').length)
    check('④ 仅回退代码不动对话', afterMsgs >= 2, `msgs=${afterMsgs}`)

    await win.screenshot({ path: process.env.RECALL_SHOT || '/tmp/recall-rewind.png' }).catch(() => {})
  } finally {
    await app.close().catch(() => {})
    srv.close()
    fs.rmSync(home, { recursive: true, force: true })
  }

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
