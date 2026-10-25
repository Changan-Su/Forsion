/**
 * 摘要栏卡片栈 × 后台进程(2026-10-25 用户选方案 A)的真 Electron 台架:真 ChatView / 真 store × 可编剧假引擎 × 隔离 home。
 * 假引擎经 stubOverride 扮演 GET /agent/processes 与 output / kill 两条路由(真路由由 tangu-agent 的 processRoutes.test.ts 覆盖)。
 *
 * 断言:
 *  1 卡片按默认顺序出现(进度 / 后台 / 产物 / 来源 / 工作范围 / Desk),默认开合对(来源、工作范围收起;空 Desk 收起)
 *  2 后台卡:3 行,计数紧贴折叠箭头靠右;在跑的绿点、结束的淡点;服务行显示地址
 *  3 左栏会话行尾:绿点 + 在跑个数 2
 *  4 点地址 → Desk 侧板开出内置浏览器(localhost:5173);收回侧板后 Desk 卡因新条目自动展开,正文 380
 *  5 悬停露停止,点了假引擎收到 kill(不走审批),行变成「已停止」
 *  6 点行 → Desk 里开进程输出,看得到输出尾巴
 *  7 点卡头折叠「产物」→ 记进 localStorage;重载后仍收起
 *  8 右键「工作范围」卡头 → 移到最上;重载后仍在最上;拖动块把「后台」拖到最下,顺序记住
 *  9 窄窗(<760):整栈收起,输入卡上方出现「N 个在后台跑」,点开列出在跑的行
 * 截图(观感自查用,人看):outputs/summary-cards/ 下亮 / 大窗口 / 暗 / 英文 / 窄窗。
 *
 * npm run build && node scripts/summary-cards.e2e.cjs
 * 台架上锁:node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="summary-cards" --eta=4 -- node scripts/summary-cards.e2e.cjs
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

const OUT = path.join(__dirname, '..', 'outputs', 'summary-cards')
fs.mkdirSync(OUT, { recursive: true })
let fails = 0
function check(name, ok, detail) {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}

const T = Date.now() - 20 * 60_000
const at = (min) => new Date(T + min * 60_000).toISOString().replace('T', ' ').slice(0, 19)
const base = { summary: '', archived: false, model_id: 'm1', agent_config: null, created_at: at(0) }
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, ui_content_offset: 0 })
const res = (id, name, content) => ({ tool_call_id: id, name, content, isError: false })
const history = [
  { id: 'u1', role: 'user', timestamp: T, content: '给 Launch 做一版落地页:一屏标题 + 三个卖点 + 下载按钮,用 vite + React。' },
  { id: 'a1', role: 'model', timestamp: T + 6 * 60_000,
    tool_calls: [call('w1', 'write_file', { path: 'index.html' }), call('w2', 'write_file', { path: 'src/main.tsx' }), call('w3', 'write_file', { path: 'src/App.tsx' })],
    tool_results: [res('w1', 'write_file', 'written'), res('w2', 'write_file', 'written'), res('w3', 'write_file', 'written')],
    content: '写好了三份文件:index.html、src/main.tsx、src/App.tsx。' },
]
const tc = (id, name, args) => ({ type: 'tool_call', payload: { id, name, arguments: JSON.stringify(args) } })
const tr = (id, result) => ({ type: 'tool_result', payload: { id, result, elapsedMs: 40 } })
const tok = (delta) => ({ type: 'token', payload: { delta } })
const TODOS = [['写入口和三份文件', 'completed'], ['起 dev server', 'completed'], ['挂上测试 watch', 'completed'], ['做深色版', 'in_progress'], ['补手机布局', 'pending']]
  .map(([content, status]) => ({ content, status }))
const runPlan = [
  tok('好。'),
  tc('p0', 'todo_write', {}), { type: 'todo', payload: { todos: TODOS } }, tr('p0', 'ok'),
  tc('s1', 'read_file', { path: 'src/App.tsx' }), tr('s1', '…'),
  tc('s2', 'web_search', { query: 'vite react landing page hero layout' }), tr('s2', '5 results'),
  tc('t1', 'run_background', { command: 'npm run dev' }), tr('t1', 'started background process p1'),
  tc('t3', 'run_background', { command: 'npx vitest --watch' }), tr('t3', 'started background process p2'),
  tok('\n\n起好了:http://localhost:5173/ 。测试在后台 watch 着。'),
]
const VITE_OUT = '> launch@0.1.0 dev\n> vite\n\n  VITE v6.3.5  ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose'
const VITEST_OUT = ' ✓ src/App.test.tsx (4 tests) 38ms\n ✓ src/hero.test.tsx (8 tests) 61ms\n\n Test Files  2 passed (2)\n      Tests  12 passed (12)'
const now = Date.now()
const procs = [
  { id: 'p1', sessionId: 's-main', command: 'npm run dev', status: 'running', exitCode: null, startedAt: now - 240_000, endedAt: null, origin: 'local', url: 'http://localhost:5173/', last: '➜  Network: use --host to expose', output: VITE_OUT },
  { id: 'p2', sessionId: 's-main', command: 'npx vitest --watch', status: 'running', exitCode: null, startedAt: now - 230_000, endedAt: null, origin: 'local', url: null, last: 'Tests  12 passed (12)', output: VITEST_OUT },
  { id: 'p3', sessionId: 's-main', command: 'npx tsc --noEmit', status: 'exited', exitCode: 0, startedAt: now - 120_000, endedAt: now - 60_000, origin: 'local', url: null, last: '', output: '' },
]
const kills = []
const view = ({ output, ...p }) => p // eslint-disable-line no-unused-vars
function override({ path: p, method }) {
  if (p === '/agent/processes' && method === 'GET') return { processes: procs.map(view) }
  const m = p.match(/^\/agent\/sessions\/([^/]+)\/processes\/([^/]+)\/(output|kill)$/)
  if (!m) return undefined
  const proc = procs.find((x) => x.sessionId === m[1] && x.id === m[2])
  if (!proc) return { __code: 404, body: { detail: 'Process not found' } }
  if (m[3] === 'kill' && method === 'POST') {
    kills.push(proc.id)
    Object.assign(proc, { status: 'killed', url: null, endedAt: Date.now() })
    return view(proc)
  }
  return { ...view(proc), output: proc.output, truncated: false }
}

async function main() {
  const fixtures = { agents: [], sessions: [
    { ...base, updated_at: at(12), project_path: '__P__', project_name: 'Launch', projectless: false, id: 's-main', title: 'Launch 落地页' },
    { ...base, updated_at: at(5), projectless: true, id: 's-2', title: '周末去杭州的行程' },
  ] }
  const ctx = await launch({ tag: 'summary-cards', fixtures, messages: history, stubOverride: override })
  for (const s of fixtures.sessions) if (s.project_path === '__P__') s.project_path = ctx.projectDir
  const { win, app } = ctx
  const ev = (fn, arg) => win.evaluate(fn, arg)
  const look = (mode, lang) => ev(({ mode }) => {
    const r = document.documentElement; r.dataset.mode = mode; r.classList.toggle('dark', mode === 'dark')
    r.style.setProperty('--uiz', '1.1'); document.body.style.zoom = '1.1'
  }, { mode, lang })
  const shot = async (name) => { await win.mouse.move(150, 640); await win.waitForTimeout(500); await win.screenshot({ path: path.join(OUT, `${name}.png`), scale: 'css' }); console.log('shot', name) }
  const openSession = async (send) => {
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await win.waitForTimeout(1200)
    const row = win.locator('.t2s-srow[data-sel-id="s-main"]').first(); await row.waitFor({ timeout: 20000 }); await row.click()
    await win.locator('#tocmsg-a1 .t2-content').waitFor({ timeout: 15000 })
    if (send) {
      ctx.stub.script(runPlan)
      const ta = win.locator('.t2c-ta').first()
      for (let i = 0; i < 40 && !(await ta.isEnabled().catch(() => false)); i++) await win.waitForTimeout(300)
      await ta.click(); await ta.fill('起起来我看看,测试也挂在后台跑着。'); await win.keyboard.press('Enter')
      await win.getByText('测试在后台 watch 着').first().waitFor({ timeout: 15000 })
    }
    await win.locator('.t2-tsum [data-card="bg"]').waitFor({ timeout: 15000 })
    await win.waitForTimeout(800)
  }
  const cardIds = () => ev(() => [...document.querySelectorAll('.t2-tsum > .t2-card')].filter((c) => c.offsetParent).map((c) => c.dataset.card))
  const isOpen = (id) => ev((id) => !!document.querySelector(`.t2-tsum > [data-card="${id}"]`)?.open, id)
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    await ev(() => localStorage.removeItem('forsion.summaryCards'))
    await openSession(true)
    await look('light')

    // 1 顺序与默认开合
    const ids = await cardIds()
    check('1 卡片按默认顺序出现', JSON.stringify(ids) === JSON.stringify(['progress', 'bg', 'outputs', 'sources', 'scope', 'desk']), ids)
    const opens = {}; for (const id of ids) opens[id] = await isOpen(id)
    check('1 默认开合:进度 / 后台 / 产物展开,来源 / 工作范围 / 空 Desk 收起',
      opens.progress && opens.bg && opens.outputs && !opens.sources && !opens.scope && !opens.desk, opens)

    // 2 后台卡
    const bg = await ev(() => {
      const c = document.querySelector('.t2-tsum > [data-card="bg"]')
      const count = c.querySelector('.t2-card-head .t2-tsum-count').getBoundingClientRect()
      const chev = c.querySelector('.t2-card-head .t2-tsum-chev').getBoundingClientRect()
      const rows = [...c.querySelectorAll('.t2-bg-row')]
      return {
        n: rows.length, count: c.querySelector('.t2-card-head .t2-tsum-count').textContent, gap: chev.left - count.right,
        dots: rows.map((r) => r.dataset.st), url: c.querySelector('.t2-bg-url')?.textContent,
        green: getComputedStyle(rows[0].querySelector('.t2-bg-dot')).backgroundColor,
      }
    })
    check('2 后台卡 3 行,计数 3', bg.n === 3 && bg.count === '3', bg)
    check('2 计数紧贴折叠箭头靠右', bg.gap >= 0 && bg.gap <= 6, `gap=${bg.gap}`)
    check('2 在跑 / 结束的点与服务地址', JSON.stringify(bg.dots) === '["running","running","done"]' && bg.url === 'localhost:5173', bg)

    // 3 左栏行尾
    const mark = await ev(() => document.querySelector('.t2s-srow[data-sel-id="s-main"] .t2s-bg')?.textContent ?? null)
    check('3 左栏会话行尾绿点 + 在跑个数', mark === '2', `mark=${mark}`)
    await shot('light')

    // 大窗口:Desk 卡不被拉长(先在 Desk 上放东西,看 1250 高下的样子)
    // 4 点地址 → Desk 侧板开内置浏览器
    await win.locator('.t2-tsum [data-card="bg"] .t2-bg-url').first().click()
    await win.waitForTimeout(1500)
    const desk = await ev(() => ({
      open: !!document.querySelector('.agent-desk.open'),
      browser: !!document.querySelector('.agent-desk.open webview') || (document.querySelector('.agent-desk.open')?.textContent || '').includes('localhost:5173'),
    }))
    check('4 点地址在 Desk 侧板里开内置浏览器', desk.open && desk.browser, desk)
    await ev(() => { const b = [...document.querySelectorAll('.agent-desk button')].find((x) => /收起|Collapse/.test(x.title || x.getAttribute('aria-label') || '')); b?.click() })
    await win.waitForTimeout(1200)
    const card = await ev(() => {
      const c = document.querySelector('.t2-tsum > [data-card="desk"]')
      const f = c?.querySelector('.agent-desk-card-frame')
      return { open: !!c?.open, frameH: f ? f.getBoundingClientRect().height / (document.body.currentCSSZoom || 1) : 0, hint: c?.querySelector('.t2-card-hint')?.textContent }
    })
    check('4 收回侧板后 Desk 卡因新条目自动展开,正文 380', card.open && Math.abs(card.frameH - 380) <= 2, card)
    await win.setViewportSize({ width: 1512, height: 1250 }); await win.waitForTimeout(800)
    const tall = await ev(() => document.querySelector('.t2-tsum > [data-card="desk"]').getBoundingClientRect().height)
    await shot('big')
    await win.setViewportSize({ width: 1512, height: 950 }); await win.waitForTimeout(800)
    const short = await ev(() => document.querySelector('.t2-tsum > [data-card="desk"]').getBoundingClientRect().height)
    check('4 大窗口下 Desk 卡不被拉长', Math.abs(tall - short) <= 1, `950 高=${short} 1250 高=${tall}`)
    await shot('desk')

    // 5 停止
    const row2 = win.locator('.t2-tsum [data-card="bg"] .t2-bg-row').nth(1)
    await row2.hover(); await win.waitForTimeout(300)
    const stopOp = await row2.locator('.t2-bg-stop').evaluate((b) => Number(getComputedStyle(b).opacity))
    await row2.locator('.t2-bg-stop').click(); await win.waitForTimeout(1200)
    const killedDot = await ev(() => [...document.querySelectorAll('.t2-tsum [data-card="bg"] .t2-bg-row')].map((r) => r.dataset.st))
    check('5 悬停露停止,点了直接停(假引擎收到 kill)', stopOp === 1 && kills.includes('p2') && killedDot.includes('killed'), { stopOp, kills, killedDot })

    // 6 点行 → Desk 里看输出
    await win.locator('.t2-tsum [data-card="bg"] .t2-bg-row').first().locator('.t2-bg-main').click()
    await win.waitForTimeout(1800)
    const log = await ev(() => document.querySelector('.agent-desk.open .t2-proclog-out')?.textContent || '')
    check('6 点行在 Desk 里开进程输出', log.includes('ready in 412 ms'), log.slice(0, 80))
    await ev(() => { const b = [...document.querySelectorAll('.agent-desk button')].find((x) => /收起|Collapse/.test(x.title || x.getAttribute('aria-label') || '')); b?.click() })
    await win.waitForTimeout(1000)

    // 7 折叠记住
    await win.locator('.t2-tsum > [data-card="outputs"] > .t2-card-head').click()
    await win.waitForTimeout(500)
    const saved = await ev(() => JSON.parse(localStorage.getItem('forsion.summaryCards') || '{}'))
    await openSession(false)
    check('7 折叠「产物」记进 localStorage,重载后仍收起', saved.open?.outputs === false && !(await isOpen('outputs')), saved)

    // 8 右键移到最上 + 拖动
    await win.locator('.t2-tsum > [data-card="scope"] > .t2-card-head').click({ button: 'right' })
    await win.locator('.ctx-menu button', { hasText: /移到最上|Move to top/ }).first().click()
    await win.waitForTimeout(500)
    await openSession(false)
    const afterTop = await cardIds()
    check('8 右键「移到最上」,重载后仍在最上', afterTop[0] === 'scope', afterTop)
    // 坐标一律用 Playwright 的 boundingBox(视口坐标,body zoom 已算进去)
    const head = await win.locator('.t2-tsum > [data-card="bg"] > .t2-card-head').boundingBox()
    const last = await win.locator('.t2-tsum > [data-card="desk"]').boundingBox()
    await win.mouse.move(head.x + 40, head.y + 10); await win.waitForTimeout(200)
    const grip = await win.locator('.t2-tsum > [data-card="bg"] .t2-card-grip').boundingBox()
    const g = { hx: head.x + 40, hy: head.y + 10, gx: grip.x + grip.width / 2, gy: grip.y + grip.height / 2, ly: last.y + last.height - 4 }
    await win.mouse.move(g.hx, g.hy); await win.waitForTimeout(200)
    await win.mouse.move(g.gx, g.gy); await win.mouse.down()
    for (let i = 1; i <= 12; i++) { await win.mouse.move(g.gx, g.gy + (g.ly - g.gy) * i / 12); await win.waitForTimeout(30) }
    await win.waitForTimeout(150)
    await shot('drag')
    await win.mouse.up(); await win.waitForTimeout(600)
    const afterDrag = await cardIds()
    check('8 拖动块把「后台」拖到最下', afterDrag[afterDrag.length - 1] === 'bg', afterDrag)
    await ev(() => localStorage.removeItem('forsion.summaryCards'))

    // 暗色 / 英文
    await openSession(false)
    await look('dark'); await shot('dark')
    await ev(() => localStorage.setItem('tangu_locale', 'en'))
    await openSession(false)
    await look('light'); await shot('en')
    await ev(() => localStorage.setItem('tangu_locale', 'zh'))

    // 9 窄窗
    await openSession(false)
    await look('light')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 950))
    await win.setViewportSize({ width: 900, height: 950 }); await win.waitForTimeout(1200)
    const narrow = await ev(() => ({
      stack: getComputedStyle(document.querySelector('.t2-tsum')).display,
      strip: document.querySelector('.t2-bgstrip-main')?.textContent || null,
    }))
    check('9 窄窗整栈收起,输入卡上方出现后台胶囊', narrow.stack === 'none' && /1 个在后台跑/.test(narrow.strip || ''), narrow)
    await win.locator('.t2-bgstrip-main').click(); await win.waitForTimeout(500)
    const pop = await ev(() => document.querySelectorAll('.t2-bgpop .t2-bg-row').length)
    check('9 点开胶囊列出在跑的行', pop === 1, `rows=${pop}`)
    await shot('narrow')
  } finally { await ctx.close() }
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  process.exitCode = fails ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 2 })
