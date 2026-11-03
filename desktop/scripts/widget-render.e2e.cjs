/**
 * 小组件第 3 步「渲染」的真机台架:真 Electron × 真主进程 × 真磁盘 × 桩引擎(GET /agent/widgets/:id 由桩回原件 + 记录)。
 * 引擎那半(按 id 跨层找、records 绑定、真模型会不会用)在 tangu-agent 的单测与 live 台架里,这里只验桌面接得对不对。
 *
 *   W1 对话卡:最新那次调用标题下一行「小组件 · v3 · 归属」+ 三个去处;旧版本那次压成一行「看最新」
 *   W2 records 绑上了:卡上合计 = 桩里 data.db 的行(9,250),不是文档里的空列表
 *   W3 放进卡片区 → Dashboards/卡片区.dashboard.md 落一条 ```widget 围栏,卡片区出现这张、画出合计
 *   W4 存到仪表盘 → Dashboards/今天.dashboard.md;打开这块板,卡在网格里、画出合计
 *   W5 放到主页 → 本机摆放(下排被近况卡占满 → 右栏),主页 1512 宽下右栏画出这张
 *   W6 原件被删 → 卡片区换成「已删除」占位;点恢复 → 卡回来(POST restore)
 *   W7 卡里点「吃喝」→ 关掉重开:卡片区 / 主页里这张仍是吃喝(界面状态按小组件 id 存)、三处摆放都还在
 *   W8 编辑主页:铅笔钮进、Esc 出;右键空白是三项菜单
 *
 * 用法:npm run build && node .claude/hooks/devlock.cjs run --vehicle=e2e --what=小组件渲染 --eta=6 -- node scripts/widget-render.e2e.cjs
 *   (--shot 存截图到 /tmp/forsion-widget-*.png)
 */
const path = require('path')
const U = require('./lib/uiux-electron.cjs')
const electron = require('./lib/launch-electron.cjs')

const SHOT = process.argv.includes('--shot')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const WID = 'w_7f3a1c9e0b12'
const T0 = 1793174400000
const ROWS = [
  { id: 'r_1', cells: { item: '成田特快', cat: '交通', amount: 3070, day: '11/01' } },
  { id: 'r_2', cells: { item: '一兰拉面', cat: '吃喝', amount: 980, day: '11/01' } },
  { id: 'r_3', cells: { item: 'Suica 充值', cat: '交通', amount: 2000, day: '11/02' } },
  { id: 'r_4', cells: { item: '浅草寺御守', cat: '杂项', amount: 800, day: '11/02' } },
  { id: 'r_5', cells: { item: '筑地早饭', cat: '吃喝', amount: 2400, day: '11/03' } },
]
// 模型惯写的样子:先声明一个空的 records(宿主绑定后读 data.db 的行)
const DOC = {
  version: 2, id: 'tokyo-ledger', title: '东京账本',
  inputs: [{ id: 'cat', kind: 'choice', label: '分类', initial: 'all', options: [{ id: 'all', label: '全部' }, { id: 'food', label: '吃喝' }, { id: 'move', label: '交通' }] }],
  state: [{ id: 'records', initial: [] }],
  derived: [
    { id: 'shown', expr: "filter(records,'r',cat=='all' or (cat=='food' and r.cat=='吃喝') or (cat=='move' and r.cat=='交通'))" },
    { id: 'total', expr: "sum(each(shown,'r',r.amount))" },
  ],
  resources: [],
  blocks: [
    { id: 'pick', kind: 'controls', inputIds: ['cat'] },
    { id: 'head', kind: 'stats', items: [{ label: '一共花了', value: "'¥'+format(total,'number')" }, { label: '笔数', value: "format(count(shown),'number')" }] },
    { id: 'rows', kind: 'table', columns: ['日期', '项目', '金额'], rows: "each(sortBy(shown,'r',r.day),'r',[r.day,r.item,'¥'+format(r.amount,'number')])" },
  ],
}
const call = (id, args) => ({ id, type: 'function', function: { name: 'intelligent_ui', arguments: JSON.stringify(args) }, ui_content_offset: 0 })
const saved = (rev) => `Intelligent UI rendered: 东京账本 (3 blocks).\nSaved widget "tokyo-ledger" (id ${WID}, rev ${rev}, saved to you).`
const HIST = [
  { id: 'u0', role: 'user', content: '帮我做个小组件，记这次东京旅行的账。', timestamp: T0 },
  { id: 'a0', role: 'model', timestamp: T0 + 1000, content: '做好了。', tool_calls: [call('w1', { document: JSON.stringify(DOC), widget: { name: 'tokyo-ledger' } })], tool_results: [{ tool_call_id: 'w1', name: 'intelligent_ui', content: saved(2), isError: false }] },
  { id: 'u1', role: 'user', content: '表格只要日期、项目、金额。', timestamp: T0 + 60_000 },
  { id: 'a1', role: 'model', timestamp: T0 + 61_000, content: '改好了。', tool_calls: [call('w2', { document: JSON.stringify(DOC), widget: { name: 'tokyo-ledger' } })], tool_results: [{ tool_call_id: 'w2', name: 'intelligent_ui', content: saved(3), isError: false }] },
]
const t = (i) => `2026-11-03 09:${String(40 - i).padStart(2, '0')}:00`
const sessions = [{ id: 'trip', title: '东京五日旅行', summary: '', model_id: 'm1', archived: false, agent_config: { agentSlug: 'xyra' }, projectless: true, created_at: t(0), updated_at: t(0) }]
const agents = [{ slug: 'xyra', name: 'Xyra', description: 'General assistant', createdBy: 'user' }]

const W = { deleted: false, restores: 0 }
const summary = () => ({ id: WID, rev: 3, name: 'tokyo-ledger', title: '东京账本', entry: 'widget.json', scope: 'agent', agentSlug: 'xyra', updatedAt: '2026-11-03T09:40:00Z', ...(W.deleted ? { deletedAt: '2026-11-03T10:00:00Z' } : {}) })
const override = async ({ path: p, method }) => {
  const m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
  if (m && m[1] === 'trip') return { messages: HIST }
  if (p === '/agent/widgets' && method === 'GET') return { widgets: [summary()], unreadable: [] }
  if (p === `/agent/widgets/${WID}` && method === 'GET') return { widget: { ...summary(), content: JSON.stringify(DOC), records: { status: 'ok', rows: ROWS } } }
  if (p === `/agent/widgets/${WID}/restore` && method === 'POST') { W.deleted = false; W.restores++; return { widget: summary() } }
}

async function main() {
  const ctx = await U.launch({ tag: 'widget-render', fixtures: { agents, sessions }, messages: [], stubOverride: override })
  let app = ctx.app, win = ctx.win
  const shot = async (n) => { if (SHOT) await win.screenshot({ path: `/tmp/forsion-widget-${n}.png` }).catch(() => {}) }
  const text = (sel) => win.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent || '').join(' | '), sel)
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await win.waitForTimeout(150); v = await fn() } return v }
  // 走应用自己的读文件 IPC(笔记库在哪由主进程定,不猜路径)
  const file = (rel) => win.evaluate((r) => window.amadeus.readTextFile(r).catch(() => ''), rel)
  const railCard = `.t2-tsum [data-card="widget:${WID}"]`
  const openTrip = async () => {
    await U.enterSpace(win, 'tangu')
    for (const label of ['稍后', 'Later']) { const b = win.getByRole('button', { name: label, exact: true }); if (await b.count()) await b.first().click().catch(() => {}) }
    await win.locator('.t2s-srow[data-sel-id="trip"]').first().click()
    await win.waitForSelector('.intelligent-ui', { timeout: 15_000 })
  }
  try {
    await U.boot(app, win, { space: 'tangu', width: 1512, height: 950 })
    await openTrip()

    // W1 / W2
    const meta = await until(() => text('.intelligent-ui .wgt-meta'))
    check('W1 最新那次调用有卡头第二行:版本 + 归属 + 三个去处', /v3/.test(meta) && /Xyra/.test(meta) && /放进卡片区/.test(meta) && /存到仪表盘/.test(meta) && /放到主页/.test(meta), meta)
    const old = await text('.wgt-old')
    check('W1b 旧版本那次调用压成一行「东京账本 第 2 版 · 看最新」', /第 2 版/.test(old) && /看最新/.test(old), old)
    const chatStats = await text('[data-widget-live] .iui-stats')
    check('⚠️W2 records 绑上了:对话卡合计 = data.db 的行', /9,250/.test(chatStats) && /5/.test(chatStats), chatStats)
    await shot('chat')

    // W3 卡片区
    await win.locator('.wgt-meta button', { hasText: '放进卡片区' }).click()
    const railFile = await until(async () => { const f = await file('Dashboards/卡片区.dashboard.md'); return f.includes(`id: ${WID}`) && f })
    check('⚠️W3 卡片区写进 Dashboards/卡片区.dashboard.md 的 widget 围栏(只有 id)', !!railFile && /```widget\nid: w_7f3a1c9e0b12\n```/.test(railFile), String(railFile).slice(-120))
    const railStats = await until(() => text(`${railCard} .iui-stats`))
    check('W3b 卡片区出现这张,画出合计,按钮变「已在卡片区」', /9,250/.test(railStats) && /已在卡片区/.test(await text('.wgt-meta')), railStats)

    // W4 仪表盘
    await win.locator('.wgt-meta button', { hasText: '存到仪表盘' }).click()
    const today = await until(async () => (await file('Dashboards/今天.dashboard.md')).includes(`id: ${WID}`))
    check('W4 存到仪表盘 → Dashboards/今天.dashboard.md', !!today && /已在仪表盘/.test(await text('.wgt-meta')))

    // W5 主页
    await win.locator('.wgt-meta button', { hasText: '放到主页' }).click()
    const layout = await win.evaluate(() => JSON.parse(localStorage.getItem('forsion.homepage.widgets.desktop.v1') || 'null'))
    check('W5 放到主页:下排被近况卡占满 → 进右栏', !!layout && layout.right[0] === WID && layout.row.length === 1, JSON.stringify(layout))
    await shot('rail')

    // W6 删除占位 + 恢复
    W.deleted = true
    await win.evaluate(() => window.dispatchEvent(new Event('focus')))
    const ph = await until(async () => /这张卡已删除/.test(await text(railCard)))
    check('W6 原件删了 → 卡片区换成「已删除」占位(不清摆放)', ph && (await file('Dashboards/卡片区.dashboard.md')).includes(WID))
    await win.locator(`${railCard} button`, { hasText: '恢复' }).click()
    const back = await until(async () => /9,250/.test(await text(`${railCard} .iui-stats`)))
    check('W6b 点恢复 → POST restore,卡回来', back && W.restores === 1, `restores=${W.restores}`)

    // W7 交互:卡片区里点「吃喝」,合计变成 3,380
    await win.locator(`${railCard} fieldset.iui-choice label`, { hasText: '吃喝' }).first().click()
    const food = await until(async () => /3,380/.test(await text(`${railCard} .iui-stats`)))
    check('W7 卡里能交互:点「吃喝」合计 3,380', food, await text(`${railCard} .iui-stats`))

    // W4b 打开今天这块板
    await U.enterSpace(win, 'amadeus')
    await win.waitForTimeout(1200)
    const todayRow = win.locator('.t2s-srow', { hasText: '今天' }).first()
    if (!(await todayRow.isVisible().catch(() => false))) await win.locator('.t2s-folder-row', { hasText: 'Dashboards' }).first().click({ timeout: 10_000 })
    await todayRow.click({ timeout: 10_000 })
    const dashOk = await until(async () => /东京账本/.test(await text('.dash3-card[data-kind="widget"]')) && /¥/.test(await text('.dash3-card[data-kind="widget"] .iui-stats')), 15_000)
    check('⚠️W4b 打开今天这块板:卡在网格里,卡头是原件标题,画出合计', dashOk, (await text('.dash3-card[data-kind="widget"]')).slice(0, 160))
    // 文字对了不等于排对了:正文曾被 .dash-widget 的居中 flex 压成一个字宽(截图才发现)
    const dashW = await win.evaluate(() => {
      const card = document.querySelector('.dash3-card[data-kind="widget"]')?.getBoundingClientRect()
      const stats = document.querySelector('.dash3-card[data-kind="widget"] .iui-stats')?.getBoundingClientRect()
      return card && stats ? { card: Math.round(card.width), stats: Math.round(stats.width) } : null
    })
    check('⚠️W4c 仪表盘里小组件正文铺满卡宽(不被居中压窄)', !!dashW && dashW.stats >= dashW.card * 0.7, JSON.stringify(dashW))
    await shot('dashboard')

    // W5b 主页右栏
    await U.enterSpace(win, 'home')
    const homeOk = await until(async () => /东京账本/.test(await text('.hp-rail-right .hp-wcard')), 10_000)
    const rails = await win.evaluate(() => document.querySelector('.hp-root')?.getAttribute('data-rails'))
    check('W5b 主页(1512 窗口)右栏画出这张', homeOk && /open$/.test(rails || ''), `rails=${rails}`)
    const gap = await win.evaluate(() => {
      const c = document.querySelector('.hp-stack')?.getBoundingClientRect(), r = document.querySelector('.hp-rail-right')?.getBoundingClientRect()
      return c && r ? Math.round(r.left - c.right) : null
    })
    check('⚠️W5c 中间 840 和右栏之间至少 32,不互相侵占', gap !== null && gap >= 31, `gap=${gap}`)
    await shot('home')

    // W8 编辑态
    await win.locator('.hp-edit-button').click()
    const editing = await until(() => win.evaluate(() => !!document.querySelector('.hp-root.hp-editing .hp-edit-bar') && document.querySelectorAll('.hp-part-frame').length >= 3))
    await shot('home-edit')
    await win.keyboard.press('Escape')
    const exited = await until(() => win.evaluate(() => !document.querySelector('.hp-root.hp-editing')))
    check('W8 铅笔钮进编辑态(主页组件带框),Esc 退出', editing && exited)
    await win.locator('.hp-root').click({ button: 'right', position: { x: 60, y: 600 } })
    const menu = await until(() => text('.ctx-menu'))
    check('W8b 右键空白 = 编辑主页 / 换壁纸 / 整理 Space', /编辑主页/.test(menu) && /整理 Space/.test(menu), menu)
    await win.keyboard.press('Escape')

    // W7b 重启保值
    await app.close()
    const home = ctx.home
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', U.ROOT], cwd: U.ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: ctx.stub.url } })
    win = await app.firstWindow()
    await U.boot(app, win, { space: null, width: 1512, height: 950 })
    await openTrip()
    const after = await until(async () => /3,380/.test(await text(`${railCard} .iui-stats`)), 15_000)
    const railKeys = await win.evaluate(() => ({ tsum: !!document.querySelector('.t2-tsum'), cards: [...document.querySelectorAll('.t2-tsum [data-card]')].map((e) => e.getAttribute('data-card')) }))
    check('⚠️W7b 重启后卡片区还在,且仍是「吃喝」(界面状态按小组件 id 存本机)', after, `${await text(`${railCard} .iui-stats`)} ${JSON.stringify(railKeys)}`)
    await shot('rail-after-restart')
    await U.enterSpace(win, 'home')
    const homeAfter = await until(async () => /3,380/.test(await text('.hp-rail-right .hp-wcard .iui-stats')), 10_000)
    check('W7c 重启后主页右栏还在,和卡片区同一份界面状态', homeAfter)
    await shot('home-after-restart')
  } finally {
    await app.close().catch(() => {})
    await ctx.close()
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} passed / ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
