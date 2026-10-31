/**
 * 摘要栏卡片栈 × 后台进程(2026-10-25 用户选方案 A)的真 Electron 台架:真 ChatView / 真 store × 可编剧假引擎 × 隔离 home。
 * 假引擎经 stubOverride 扮演 GET /agent/processes 与 output / kill 两条路由(真路由由 tangu-agent 的 processRoutes.test.ts 覆盖)。
 *
 * 断言:
 *  1 卡片按默认顺序出现(进度 / 后台 / 产物 / 来源 / 工作范围 / Desk),跑完后开合对(来源跑完收回、工作范围收起;空 Desk 收起)
 *  2 后台卡:3 行;卡头 = 标题 → 紧挨的折叠箭头 …… 右缘计数(10-29 卡头 3);在跑的绿点、结束的淡点;服务行显示地址
 *  3 左栏会话行尾:绿点 + 在跑个数 2
 *  4 点地址 → Desk 侧板开出内置浏览器(localhost:5173);收回侧板后 Desk 卡因新条目自动展开,正文 380
 *  4b 放不下(950 高 + Desk 展开):收掉最久没来新东西的卡(data-squeezed),进度不收;栈不超出车道,或只剩一张可收的且正文缩短
 *  5 悬停露停止,点了假引擎收到 kill(不走审批),行变成「已停止」
 *  6 点行 → Desk 里开进程输出,看得到输出尾巴
 *  7 第二轮(10-29 第三轮方案 A):来了新来源 → 来源卡自己展开、新的那行长出来(WAAPI);这一轮里用户收起的进度卡,
 *    来了新计划项也不自己开;跑完来源收回去
 *  7b 点卡头收起「产物」不落盘(localStorage 里没有 open);重载后按内容重新展开(或被限长收着)
 *  8 右键「工作范围」卡头 → 移到最上;重载后仍在最上;按住「后台」卡头拖到最下,顺序记住;拖完不顺带开合
 *  9 窄窗(<760):整栈收起,输入卡上方出现「N 个在后台跑」,点开列出在跑的行
 * 截图(观感自查用,人看):outputs/summary-cards/ 下亮 / 大窗口 / 暗 / 英文 / 窄窗。
 * 跳变探针(3c、7):逐帧量栈里每张卡的位置 / 高度,栈里没有在播的过渡、卡却变了 = 跳变(第三轮「没过渡的都补上」)。
 * MOTION_VIDEO=1 另录一份屏到 outputs/summary-cards/video/(看手感用,ffmpeg 抽帧)。
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
// 第二轮:先读一个新文件(来源 2 → 3),停一下再加一条计划项,再停一下收尾 —— 两段停顿留给断言看「跑着时」的样子
const TODOS2 = [...TODOS, { content: '加一张对比截图', status: 'pending' }]
const run2 = [
  tok('再看一眼。'),
  // 先跑一条不算来源的工具,停 900ms:进度卡里「正在 …」那一行出现又消失,别的卡都不动 —— 跳变探针专门看它
  tc('x0', 'bash', { command: 'ls src' }), { ...tr('x0', 'App.tsx'), delay: 900 },
  tc('s3', 'read_file', { path: 'src/hero.tsx' }), tr('s3', '…'),
  { ...tc('p1', 'todo_write', {}), delay: 1800 }, { type: 'todo', payload: { todos: TODOS2 } }, tr('p1', 'ok'),
  { ...tok('\n\n看完了，补了一项。'), delay: 1800 },
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
// 子代理行:委派给有头像的 Agent(标题 = 它的 name)要画头像;通用子代理(标题「Subagent」,配置里的 agentSlug 是父会话的回落)仍画 Bot
const AGENTS = [{ slug: 'ava', name: 'Ava', description: 'Research agent', createdBy: 'user', avatar: 'avatar.png', instructions: '', skills: [] }]
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const subRows = [
  { sessionId: 'd-ava', kind: 'delegate', title: 'Ava', createdAt: new Date(now - 30_000).toISOString(), runId: null, runStatus: 'running', agentSlug: 'ava' },
  { sessionId: 'd-gen', kind: 'delegate', title: 'Subagent', createdAt: new Date(now - 90_000).toISOString(), runId: null, runStatus: 'completed', agentSlug: 'ava' },
  // 10-25 用户报:跑完的子代理无限列下去,把进度卡撑满 —— 再垫 11 条跑完的历史子会话
  ...Array.from({ length: 11 }, (_, i) => ({ sessionId: `d-old${i}`, kind: 'delegate', title: `Subagent ${i + 2}`, createdAt: new Date(now - 600_000 - i * 60_000).toISOString(), runId: null, runStatus: 'completed', agentSlug: 'ava' })),
]
function override({ path: p, method }) {
  if (p === '/agent/processes' && method === 'GET') return { processes: procs.map(view) }
  if (p === '/agent/sessions/s-main/background' && method === 'GET') return { background: subRows }
  if (p === '/agent/agents/ava/avatar' && method === 'GET') return { __buffer: PNG, contentType: 'image/png' }
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
  const fixtures = { agents: AGENTS, sessions: [
    { ...base, updated_at: at(12), project_path: '__P__', project_name: 'Launch', projectless: false, id: 's-main', title: 'Launch 落地页' },
    { ...base, updated_at: at(5), projectless: true, id: 's-2', title: '周末去杭州的行程' },
  ] }
  const ctx = await launch({ tag: 'summary-cards', fixtures, messages: history, stubOverride: override,
    recordVideo: process.env.MOTION_VIDEO ? { dir: path.join(OUT, 'video'), size: { width: 1512, height: 1250 } } : undefined })
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
  // 跳变探针:每帧量一次每张卡(相对栈内容的 top、高度,按 body zoom 归一),同时看栈里有没有在播的动画 / 过渡;
  // 前后两帧都没在播、卡却挪了 / 变了高 = 一下子到位的跳变。过渡开头那帧和结尾落定那帧都算「在播」,不误报。
  const probeStart = () => ev(() => {
    const w = window, st = document.querySelector('.t2-tsum'), z = document.body.currentCSSZoom || 1
    const p = w.__probe = { on: true, jumps: [], frames: 0, prev: null, prevAnim: true, t0: performance.now() }
    const snap = () => {
      const sr = st.getBoundingClientRect(), m = {}
      for (const c of st.children) if (c.dataset && c.dataset.card && c.offsetParent) { const r = c.getBoundingClientRect(); m[c.dataset.card] = [(r.top - sr.top) / z + st.scrollTop, r.height / z] }
      return m
    }
    // 只算会播完的过渡 / 动画:正文的滚动驱动渐隐(t2-card-fade)和「正在运行」的流光是常驻的,算进来就永远「在播」、什么都抓不到
    const busy = () => document.getAnimations().some((a) => a.playState === 'running' && a.timeline === document.timeline
      && a.effect && a.effect.target && st.contains(a.effect.target) && Number.isFinite(a.effect.getComputedTiming().endTime))
    const tick = () => {
      if (!p.on) return
      const cur = snap(), anim = busy()
      p.frames++
      if (p.prev && !anim && !p.prevAnim) for (const k in cur) {
        const a = p.prev[k]; if (!a) continue
        const dt = cur[k][0] - a[0], dh = cur[k][1] - a[1]
        if (Math.abs(dt) > 1.5 || Math.abs(dh) > 1.5) p.jumps.push({ t: Math.round(performance.now() - p.t0), card: k, dt: Math.round(dt), dh: Math.round(dh) })
      }
      p.prev = cur; p.prevAnim = anim
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const probeStop = () => ev(() => { const p = window.__probe; p.on = false; return { frames: p.frames, jumps: p.jumps } })
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    await ev(() => localStorage.removeItem('forsion.summaryCards'))
    await openSession(true)
    await look('light')
    // 1250 高放得下全部展开的卡,先看开合策略本身(限长在 4b 单独看);等这一轮真的跑完(来源在跑完时收回)
    await win.setViewportSize({ width: 1512, height: 1250 })
    await win.locator('.t2-tsum[aria-busy="false"]').waitFor({ timeout: 15000 }); await win.waitForTimeout(800)

    // 1 顺序与默认开合
    const ids = await cardIds()
    check('1 卡片按默认顺序出现', JSON.stringify(ids) === JSON.stringify(['progress', 'bg', 'outputs', 'sources', 'scope', 'desk']), ids)
    const opens = {}; for (const id of ids) opens[id] = await isOpen(id)
    check('1 跑完后的开合:进度 / 后台(有在跑的)/ 产物展开,来源(跑完收回)/ 工作范围 / 空 Desk 收起',
      opens.progress && opens.bg && opens.outputs && !opens.sources && !opens.scope && !opens.desk, opens)
    check('1 1250 高放得下,不限长', !(await ev(() => document.querySelector('.t2-tsum [data-squeezed]'))))

    // 2 后台卡
    const bg = await ev(() => {
      const c = document.querySelector('.t2-tsum > [data-card="bg"]')
      const head = c.querySelector('.t2-card-head').getBoundingClientRect()
      const count = c.querySelector('.t2-card-head .t2-tsum-count').getBoundingClientRect()
      const chev = c.querySelector('.t2-card-head .t2-tsum-chev').getBoundingClientRect()
      const tx = c.querySelector('.t2-card-title > span').getBoundingClientRect()
      const z = document.body.currentCSSZoom || 1
      const rows = [...c.querySelectorAll('.t2-bg-row')]
      return {
        n: rows.length, count: c.querySelector('.t2-card-head .t2-tsum-count').textContent,
        chevToText: (chev.left - tx.right) / z, countToRight: (head.right - count.right) / z,
        dots: rows.map((r) => r.dataset.st), url: c.querySelector('.t2-bg-url')?.textContent,
        green: getComputedStyle(rows[0].querySelector('.t2-bg-dot')).backgroundColor,
      }
    })
    check('2 后台卡 3 行,计数 3', bg.n === 3 && bg.count === '3', bg)
    check('2 折叠箭头紧挨标题、计数贴卡头右缘', bg.chevToText >= 2 && bg.chevToText <= 6 && Math.abs(bg.countToRight) <= 1, bg)
    check('2 在跑 / 结束的点与服务地址', JSON.stringify(bg.dots) === '["running","running","done"]' && bg.url === 'localhost:5173', bg)

    // 3 左栏行尾
    const mark = await ev(() => document.querySelector('.t2s-srow[data-sel-id="s-main"] .t2s-bg')?.textContent ?? null)
    check('3 左栏会话行尾绿点 + 在跑个数', mark === '2', `mark=${mark}`)

    // 3b 子代理行的头像(10-25 用户报:有头像的 Agent 跑子代理时只画了 Bot)
    await win.locator('[data-subchat-done]').waitFor({ timeout: 10000 })
    // 3c 跑完的收进一行:默认只列在跑的那条 +「已完成 12 个」,点开才就地展开,再点收起
    const fold = await ev(() => ({ rows: [...document.querySelectorAll('[data-subchat-status] .t2o-desk-row')].map((r) => r.querySelector('.t2o-desk-name')?.textContent), more: document.querySelector('[data-subchat-done]')?.textContent }))
    check('3c 跑完的子代理默认收成一行,只列在跑的', JSON.stringify(fold.rows) === '["Ava"]' && /已完成 12 个/.test(fold.more || ''), fold)
    await shot('subfold')
    await probeStart()
    await win.locator('[data-subchat-done]').click(); await win.waitForTimeout(200)
    const subs = await ev(() => [...document.querySelectorAll('[data-subchat-status] .t2o-desk-row')].map((r) => {
      const img = r.querySelector('img[data-subagent-avatar]')
      return { name: r.querySelector('.t2o-desk-name')?.textContent, img: img ? { slug: img.dataset.subagentAvatar, blob: img.src.startsWith('blob:'), loaded: img.naturalWidth > 0, working: img.classList.contains('is-working'), w: img.getBoundingClientRect().width } : null, bot: !!r.querySelector('svg.lucide-bot') }
    }))
    const ava = subs.find((x) => x.name === 'Ava'), gen = subs.find((x) => x.name === 'Subagent')
    check('3b 委派给有头像的 Agent:行首是它的头像(在跑带工作环)', !!ava?.img && ava.img.slug === 'ava' && ava.img.blob && ava.img.loaded && ava.img.working && !ava.bot, subs)
    check('3b 通用子代理仍画 Bot,不借父会话 / 回落 slug 的头像', !!gen && !gen.img && gen.bot, subs)
    check('3c 点开列出全部 12 条已完成,在跑的仍在最上', subs.length === 13 && subs[0].name === 'Ava', subs.map((x) => x.name))
    await win.locator('[data-subchat-done]').click(); await win.waitForTimeout(200)
    // 收起的行缩回去时留着残影(data-tsum-ghost)播完才摘,不算数
    const folded = await ev(() => document.querySelectorAll('[data-subchat-status] .t2o-desk-row:not([data-tsum-ghost])').length)
    check('3c 再点收起', folded === 1, `rows=${folded}`)
    await win.waitForTimeout(500)
    const p3 = await probeStop()
    check('3c 展开 / 收起已完成的子代理:栈里没有跳变', p3.frames > 20 && p3.jumps.length === 0, p3)
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
      const st = document.querySelector('.t2-tsum')
      return { open: !!c?.open, frameH: f ? f.getBoundingClientRect().height / (document.body.currentCSSZoom || 1) : 0, hint: c?.querySelector('.t2-card-hint')?.textContent,
        below: c && st ? Math.round(c.getBoundingClientRect().bottom - st.getBoundingClientRect().bottom) : null }
    })
    check('4 收回侧板后 Desk 卡因新条目自动展开,正文 380', card.open && Math.abs(card.frameH - 380) <= 2, card)
    check('4 自动展开后栈滚到 Desk 卡露出下沿', card.below !== null && card.below <= 1, card)
    await win.setViewportSize({ width: 1512, height: 1250 }); await win.waitForTimeout(800)
    const tall = await ev(() => document.querySelector('.t2-tsum > [data-card="desk"]').getBoundingClientRect().height)
    await shot('big')
    await win.setViewportSize({ width: 1512, height: 950 }); await win.waitForTimeout(800)
    const short = await ev(() => document.querySelector('.t2-tsum > [data-card="desk"]').getBoundingClientRect().height)
    check('4 大窗口下 Desk 卡不被拉长', Math.abs(tall - short) <= 1, `950 高=${short} 1250 高=${tall}`)
    await shot('desk')

    // 4b 限长:950 高 + Desk 展开放不下
    const fit = await ev(() => {
      const st = document.querySelector('.t2-tsum')
      const cards = [...st.querySelectorAll(':scope > .t2-card')].filter((c) => c.offsetParent && c.dataset.card)
      return {
        overflow: st.scrollHeight - st.clientHeight,
        open: cards.filter((c) => c.open).map((c) => c.dataset.card),
        squeezed: cards.filter((c) => c.hasAttribute('data-squeezed')).map((c) => c.dataset.card),
        capped: cards.filter((c) => c.querySelector(':scope > .t2-card-body')?.style.maxHeight).map((c) => c.dataset.card),
        // 封顶真的生效:正文实际高度不超过写上去的 max-height
        capHeld: cards.every((c) => { const b = c.querySelector(':scope > .t2-card-body'); return !b?.style.maxHeight || b.offsetHeight <= parseFloat(b.style.maxHeight) + 1 }),
      }
    })
    const sqOpen = fit.open.filter((id) => id !== 'progress' && id !== 'desk')
    check('4b 放不下时收掉最久没来新东西的卡,进度 / Desk 不收', fit.squeezed.length >= 1 && fit.squeezed.every((id) => ['bg', 'outputs'].includes(id)) && fit.open.includes('progress') && fit.open.includes('desk'), fit)
    check('4b 栈不超出车道,或只剩一张可收的且正文已缩', fit.capHeld && (fit.overflow <= 1 || (sqOpen.length === 1 && fit.capped.includes(sqOpen[0]))), fit)
    // 后面要点后台卡里的行:被收着就手动点开(手动开的不再被挤收)
    if (!(await isOpen('bg'))) { await win.locator('.t2-tsum > [data-card="bg"] > .t2-card-head').click(); await win.waitForTimeout(500) }

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

    // 7 第二轮:新来源让来源卡自己开、新行长出来;用户这一轮收起的进度卡不被新计划项顶开;跑完来源收回
    await ev(() => {
      const w = window; w.__rowAnim = null; w.__cardGone = []
      const st = document.querySelector('.t2-tsum')
      w.__rowMo = new MutationObserver((recs) => {
        // 跑着的时候卡片不该被摘掉又装回(消息整份重拉会这样),否则每轮开跑都会播一遍缩回 + 长出
        for (const r of recs) if (r.target === st) for (const n of r.removedNodes) if (n instanceof HTMLElement && n.dataset.card && !n.isConnected) w.__cardGone.push(n.dataset.card)
        for (const r of recs) for (const n of r.addedNodes) {
          if (w.__rowAnim || !(n instanceof HTMLElement) || !n.matches('.t2-tsum-row') || !n.closest('.t2-tsum > [data-card="sources"]')) continue
          w.__rowAnim = { anims: n.getAnimations().length, h0: n.getBoundingClientRect().height }
        }
      })
      w.__rowMo.observe(document.querySelector('.t2-tsum'), { childList: true, subtree: true })
    })
    ctx.stub.script(run2)
    await probeStart()
    {
      const ta = win.locator('.t2c-ta').first()
      await ta.click(); await ta.fill('再看一眼 hero 组件。'); await win.keyboard.press('Enter')
    }
    const srcOpened = await win.waitForFunction(() => document.querySelector('.t2-tsum > [data-card="sources"]')?.open, null, { timeout: 2500 }).then(() => true, () => false)
    const rowAnim = await ev(() => window.__rowAnim)
    check('7 跑着来了新来源:来源卡自己展开', srcOpened)
    check('7 新的那行长出来(有过渡,不是一下到位)', !!rowAnim && rowAnim.anims > 0 && rowAnim.h0 < 20, rowAnim)
    await win.locator('.t2-tsum > [data-card="progress"] > .t2-card-head').click(); await win.mouse.move(150, 640)
    await win.waitForFunction(() => /\/6$/.test(document.querySelector('.t2-tsum > [data-card="progress"] .t2-tsum-count')?.textContent || ''), null, { timeout: 5000 })
    await win.waitForTimeout(400)
    check('7 这一轮里手动收起的进度卡,来了新计划项也不自己开', !(await isOpen('progress')))
    await win.getByText('看完了，补了一项').first().waitFor({ timeout: 8000 })
    await win.locator('.t2-tsum[aria-busy="false"]').waitFor({ timeout: 8000 }); await win.waitForTimeout(600)
    check('7 跑完来源收回去', !(await isOpen('sources')))
    const p7 = await probeStop()
    check('7 这一轮从开跑到跑完:栈里没有跳变', p7.frames > 60 && p7.jumps.length === 0, p7)
    // 探针自检(负对照):往开着的卡里直接塞一段不带过渡的内容,探针必须抓到这一下跳变,否则上面两条「没有跳变」不可信
    await win.waitForTimeout(400)
    await probeStart(); await win.waitForTimeout(300)
    // 插在栈里两张卡之间(正文封顶的卡里插东西高度不变,测不出来):下面的卡一下子挪 40px
    await ev(() => { const st = document.querySelector('.t2-tsum'); const d = document.createElement('div'); d.style.cssText = 'height:40px;flex:none'; d.id = 'probe-jump'; st.insertBefore(d, st.children[1] || null) })
    await win.waitForTimeout(300)
    await ev(() => document.getElementById('probe-jump')?.remove())
    await win.waitForTimeout(300)
    const pNeg = await probeStop()
    check('7 探针自检:不带过渡的变化能抓到', pNeg.jumps.length > 0, pNeg)
    const gone = await ev(() => window.__cardGone)
    check('7 跑的过程中卡片不闪(没有被摘掉又装回)', gone.length === 0, gone)
    await ev(() => window.__rowMo?.disconnect())

    // 7b 手动收起不落盘,重载后按内容重新来
    await win.locator('.t2-tsum > [data-card="outputs"] > .t2-card-head').click(); await win.waitForTimeout(400)
    if (await isOpen('outputs')) { await win.locator('.t2-tsum > [data-card="outputs"] > .t2-card-head').click(); await win.waitForTimeout(400) }
    const saved = await ev(() => JSON.parse(localStorage.getItem('forsion.summaryCards') || '{}'))
    await openSession(false)
    const outAfter = await ev(() => { const c = document.querySelector('.t2-tsum > [data-card="outputs"]'); return { open: !!c?.open, squeezed: !!c?.hasAttribute('data-squeezed') } })
    check('7b 手动收起「产物」不落盘;重载后按内容重新展开(或被限长收着)', saved.open === undefined && (outAfter.open || outAfter.squeezed), { saved, outAfter })

    // 8 右键移到最上 + 拖动
    await win.locator('.t2-tsum > [data-card="scope"] > .t2-card-head').click({ button: 'right' })
    await win.locator('.ctx-menu button', { hasText: /移到最上|Move to top/ }).first().click()
    await win.waitForTimeout(500)
    await openSession(false)
    const afterTop = await cardIds()
    check('8 右键「移到最上」,重载后仍在最上', afterTop[0] === 'scope', afterTop)
    // 拖动在 1250 高、Desk 收着时看:放得下就不限长,「拖完不顺带开合」才比得出来
    await win.setViewportSize({ width: 1512, height: 1250 }); await win.waitForTimeout(600)
    if (await isOpen('desk')) { await win.locator('.t2-tsum > [data-card="desk"] > .t2-card-head').click(); await win.waitForTimeout(600) }
    const bgOpenBefore = await isOpen('bg')
    // 坐标一律用 Playwright 的 boundingBox(视口坐标,body zoom 已算进去)
    const head = await win.locator('.t2-tsum > [data-card="bg"] > .t2-card-head').boundingBox()
    const last = await win.locator('.t2-tsum > [data-card="desk"]').boundingBox()
    // 整张卡头都能拖:从卡头中间(标题和计数之间的空处)按下
    const g = { gx: head.x + head.width / 2, gy: head.y + head.height / 2, ly: last.y + last.height - 4 }
    await win.mouse.move(g.gx, g.gy); await win.waitForTimeout(200)
    const slotSwap = await ev(() => { const h = document.querySelector('.t2-tsum > [data-card="bg"] .t2-card-head'); return { grip: Number(getComputedStyle(h.querySelector('.t2-card-grip')).opacity), count: Number(getComputedStyle(h.querySelector('.t2-tsum-count')).opacity) } })
    check('8 鼠标停在卡头上:计数换成拖动把手', slotSwap.grip === 1 && slotSwap.count === 0, slotSwap)
    await win.screenshot({ path: path.join(OUT, 'hover-head.png'), scale: 'css' }); console.log('shot hover-head') // 指针得停在卡头上,不走 shot()
    await win.mouse.down()
    for (let i = 1; i <= 12; i++) { await win.mouse.move(g.gx, g.gy + (g.ly - g.gy) * i / 12); await win.waitForTimeout(30) }
    await win.waitForTimeout(150)
    // 落点线必须落在栈里(10-25 首轮截图里它偏出一个聊天列的左上角:LCL fixedOrigin 把 container-type 当成 fixed 包含块)
    const line = await win.locator('.lcl-drop-ind').boundingBox()
    const stackBox = await win.locator('.t2-tsum').boundingBox()
    const deskBox = await win.locator('.t2-tsum > [data-card="desk"]').boundingBox()
    check('8 拖动时落点线画在栈里、最后一张卡下沿', !!line && line.x >= stackBox.x && line.x + line.width <= stackBox.x + stackBox.width + 1
      && Math.abs(line.y - (deskBox.y + deskBox.height)) <= 12, { line, stack: stackBox, deskBottom: deskBox && deskBox.y + deskBox.height })
    // 拖动中拍图不能走 shot():它先把指针挪到 (150,640),会把落点改掉
    await win.screenshot({ path: path.join(OUT, 'drag.png'), scale: 'css' }); console.log('shot drag')
    // 松手落位(LCL land,同左栏组头):逐帧记下「后台」卡的计算 transform(land 只在第一帧写内联 translate,
    // 之后是 CSS transition 把它过渡回原样 —— 只看内联样式只看得到一帧)。应有多帧位移、一路收小、落定后为 none。
    await ev(() => {
      const w = window; w.__land = []; const t0 = performance.now()
      const tick = () => {
        const c = document.querySelector('.t2-tsum > [data-card="bg"]')
        const m = c ? new DOMMatrixReadOnly(getComputedStyle(c).transform === 'none' ? undefined : getComputedStyle(c).transform) : null
        w.__land.push(m ? [Math.round(m.m41 * 10) / 10, Math.round(m.m42 * 10) / 10] : null)
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await win.mouse.up(); await win.waitForTimeout(600)
    const afterDrag = await cardIds()
    check('8 按住卡头把「后台」拖到最下', afterDrag[afterDrag.length - 1] === 'bg', afterDrag)
    check('8 拖完不顺带开合(松手那次 click 被吃掉)', (await isOpen('bg')) === bgOpenBefore, { before: bgOpenBefore })
    const landS = await ev(() => {
      const a = (window.__land || []).filter(Boolean); const fly = a.filter(([x, y]) => x || y)
      const ys = fly.map(([, y]) => Math.abs(y))
      return { frames: a.length, fly: fly.length, first: fly[0] || null, dxMax: Math.max(0, ...fly.map(([x]) => Math.abs(x))), shrinking: ys.every((y, i) => i === 0 || y <= ys[i - 1] + 0.5), last: a[a.length - 1] }
    })
    check('8 松手后从松手处滑进新位置(多帧位移一路收小、不横向漂、落定归零)',
      landS.fly >= 3 && landS.shrinking && landS.dxMax < 1 && landS.last && !landS.last[0] && !landS.last[1], landS)
    await ev(() => localStorage.removeItem('forsion.summaryCards'))
    await win.setViewportSize({ width: 1512, height: 950 })

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
