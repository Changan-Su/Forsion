/**
 * Muse Space「今日简报」(2026-11-08,方案 D 第一期)的真 Electron 台架。桩引擎按新引擎的两条路由回
 * (GET /agent/special/muse/space、POST …/placement,带 expectedRev),摆放规则在桩里照契约简化实现,量的是渲染与接线:
 *  B 静止态:那句话(by 行、[[链接]] 点了在主区开文件)、备好的三份、格子顺序、提议卡、待你看的勾 = 完成、在跟的;
 *    提议「放上」→ 进格子、「不要」→ 消失;小组件「⋯ → 放到主页」写进主页摆放;
 *  E 编辑态:铅笔 → 把手;隐藏 → 「已隐藏」里点回来;添加浮层(内置已放打勾、卜算子做的列出来);拖动换位 → move;恢复默认;
 *  R 右栏 = 管理面:没有「待办」「它给自己排的」;
 *  S 停用横条、读坏警示点、第一轮之前的空状态(叫醒 → POST /muse/wake);
 *  H 主页上的「待你看的」「在跟的」两张;
 *  亮 / 暗 / 英文 / 窄(900 宽)各拍一张主区(SHOT_DIR 指定出图目录)。
 *
 *   npx electron-vite build
 *   node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="Muse 简报台架" --eta=4 -- node scripts/muse-brief.e2e.cjs
 * 负对照:对着 11-08 之前的构建跑 → 主区没有 [data-muse-brief],B/E/S/H 全红。
 */
const path = require('path')
const { launch, boot, enterSpace, shotDir, makeReporter, sleep } = require('./lib/uiux-electron.cjs')

const OUT = shotDir('muse-brief')
const MIN = 60_000
const now = Date.now()
const d = new Date()
const TODAY = `Journal/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`
const LIB = '/tmp/muse-brief-lib'

const DOC = (title, items) => ({
  version: 2, id: title, title,
  inputs: [], state: [], derived: [], resources: [],
  blocks: [{ id: 'head', kind: 'stats', items }],
})
const WIDGETS = {
  w_release: { id: 'w_release', rev: 4, name: 'release-214', title: '2.14 发版清单', entry: 'widget.json', scope: 'agent', agentSlug: 'muse', updatedAt: new Date(now - 3 * 3600_000).toISOString(), doc: DOC('2.14 发版清单', [{ label: '已完成', value: "'4 / 7'" }, { label: '还差', value: "'What’s new'" }]) },
  w_focus: { id: 'w_focus', rev: 1, name: 'focus-week', title: '本周花在哪', entry: 'widget.json', scope: 'agent', agentSlug: 'muse', updatedAt: new Date(now - 20 * MIN).toISOString(), doc: DOC('本周花在哪', [{ label: 'Genesis', value: "'14.2 h'" }, { label: '阅读', value: "'3.1 h'" }]) },
  w_book: { id: 'w_book', rev: 2, name: 'book-club', title: '读书会', entry: 'widget.json', scope: 'agent', agentSlug: 'muse', updatedAt: new Date(now - 26 * 3600_000).toISOString(), doc: DOC('读书会', [{ label: '明天', value: "'15:00'" }]) },
}
const TODOS = [
  { id: 't1', title: '给 2.14 What’s new 起一份草稿', detail: '12 个 PR 还没人整理', status: 'pending', createdAt: now - 3 * 3600_000 },
  { id: 't2', title: '周一产品周会还没有议程', detail: '草稿在「备好的」里', status: 'pending', createdAt: now - 2 * 3600_000 },
  { id: 't3', title: '整理《置身事内》第 5 章摘录', detail: '读书会在明天', status: 'pending', createdAt: now - 1 * 3600_000 },
]
const TRACKS = [
  { id: 's1', name: '读书会提醒', date: new Date(now + 20 * 3600_000).toISOString().slice(0, 16), repeat: '', auto: true, description: '' },
  { id: 's2', name: '周报回顾', date: new Date(now + 5 * 86400_000).toISOString().slice(0, 10), repeat: '7d', auto: true, description: '' },
]
const JOURNAL = `# 今天\n\n## 09:12 上午\n你从 8 点起一直在改主页小组件，#489 合了。把「2.14 What’s new」记成待办。\n\n## 15:20 下午\n你下午在读《置身事内》，整理了两条摘录放进 [[Reading/置身事内 · 摘录.md]]。\n\n## 18:05 傍晚\n周会议程还空着，起了一版草稿放在「备好的」，等你看。\n`

// ── 世界:照契约简化的一份摆放 ──
const W = {
  enabled: true, hasDoc: true, problems: [], rev: 0, ops: [], wakes: 0, patches: [], lastCycleAt: now - 38 * MIN,
  cards: ['todos', 'release', 'tracking'], hidden: [], added: { release: { widgetId: 'w_release' } },
  proposed: [{ key: 'focus-week', ref: { widgetId: 'w_focus' }, why: '你这周大半时间在 Genesis' }, { key: 'book-club', ref: { widgetId: 'w_book' }, why: '读书会在明天' }],
  hero: { text: '你今天大半天在改主页小组件，#489 已经合了。周一周会的[[Drafts/周会议程.md|议程]]我起了一版，放在下面等你看。', at: now - 25 * MIN, sources: [] },
}
const BUILTINS = ['todos', 'tracking', 'today', 'status']
const refOf = (k) => (BUILTINS.includes(k) ? { builtin: k } : W.added[k])
const view = () => ({
  enabled: W.enabled, hasDoc: W.hasDoc, libraryRoot: LIB,
  hero: W.hasDoc ? W.hero : null,
  prepared: W.hasDoc ? [
    { path: 'Drafts/周会议程.md', title: '周会议程', mtime: now - 25 * MIN },
    { path: 'Reading/置身事内 · 摘录.md', title: '置身事内 · 摘录', mtime: now - 3 * 3600_000 },
    { path: 'Journal/本周回顾.md', title: '本周回顾', mtime: now - 26 * 3600_000 },
  ] : [],
  cards: W.cards.filter((k) => !W.hidden.includes(k)).map((k) => ({ key: k, ref: refOf(k), source: W.added[k] ? 'added' : 'default' })),
  hidden: W.cards.filter((k) => W.hidden.includes(k)).map((k) => ({ key: k, ref: refOf(k), source: W.added[k] ? 'added' : 'default' })),
  proposed: W.hasDoc ? W.proposed : [],
  sections: { prepared: !W.hidden.includes('section:prepared'), today: !W.hidden.includes('section:today') },
  rev: { doc: 1, placement: W.rev }, problems: W.problems, stoppedAt: W.enabled ? null : W.hero.at,
})
function applyOp(op) {
  const visible = W.cards.filter((k) => !W.hidden.includes(k))
  if (op.type === 'move') { const v = visible.filter((k) => k !== op.key); v.splice(Math.min(op.to, v.length), 0, op.key); W.cards = [...v, ...W.cards.filter((k) => W.hidden.includes(k))] }
  if (op.type === 'hide') W.hidden.push(op.key)
  if (op.type === 'show') W.hidden = W.hidden.filter((k) => k !== op.key)
  if (op.type === 'add') { if (!W.cards.includes(op.card.key)) W.cards.push(op.card.key); if (op.card.ref.widgetId) W.added[op.card.key] = op.card.ref; W.hidden = W.hidden.filter((k) => k !== op.card.key) }
  if (op.type === 'accept') { const p = W.proposed.find((x) => x.key === op.key); W.proposed = W.proposed.filter((x) => x.key !== op.key); W.added[p.key] = p.ref; W.cards.push(p.key) }
  if (op.type === 'reject') W.proposed = W.proposed.filter((x) => x.key !== op.key)
  if (op.type === 'reset') { W.cards = ['todos', 'today', 'tracking']; W.hidden = []; W.added = {} }
  W.rev++
}
const status = () => ({ enabled: W.enabled, hasModel: true, running: false, restartsThisWindow: 1, maxRestartsPerWindow: 6, lastCycleAt: W.lastCycleAt, lastError: null, sessionId: 'mr-1', mode: 'ask', heartbeatMinutes: 120, pendingApprovals: 0, sleepUntil: null, sleepReason: null, spaceStamp: 0, wakePending: W.wakes > 0, wakeBlocked: null })

const override = async ({ path: p, method, url, body }) => {
  if (p === '/agent/special/muse/status') return { status: status() }
  if (p === '/agent/special/muse/space' && method === 'GET') return { view: view() }
  if (p === '/agent/special/muse/space/placement' && method === 'POST') {
    const b = await body()
    if (b.expectedRev !== W.rev) return { __code: 409, body: { detail: 'rev', view: view() } }
    W.ops.push(b.op); applyOp(b.op)
    return { view: view() }
  }
  if (p === '/agent/special/muse/wake' && method === 'POST') { W.wakes++; return { status: status() } }
  if (p === '/agent/special/muse/todos') return { todos: TODOS.filter((t) => !W.patches.some((x) => x.id === t.id)) }
  if (p.startsWith('/agent/special/muse/todos/') && method === 'PATCH') { W.patches.push({ id: p.split('/').pop(), ...(await body()) }); return { ok: true } }
  if (p === '/agent/special/schedule' && method === 'GET') return { schedules: [{ slug: 'muse', entries: TRACKS }] }
  if (p === '/agent/special/muse/library/file') return url.searchParams.get('path') === TODAY ? { path: TODAY, content: JOURNAL, size: JOURNAL.length, mtime: now } : { __code: 404, body: { detail: 'not found' } }
  if (p === '/agent/widgets' && method === 'GET') return { widgets: Object.values(WIDGETS).map(({ doc, ...s }) => s), unreadable: 0 }
  const wm = /^\/agent\/widgets\/(w_[a-z]+)$/.exec(p)
  if (wm && WIDGETS[wm[1]]) { const { doc, ...s } = WIDGETS[wm[1]]; return { widget: { ...s, content: JSON.stringify(doc), records: { status: 'ok', rows: [] } } } }
  if (p === '/agent/special/muse/triggers') return { triggers: [] }
  if (p === '/agent/special/approvals') return { approvals: [] }
  if (p === '/agent/special/muse/rounds') return { rounds: [] }
  if (p === '/agent/special/automation/runs') return { runs: [] }
  return undefined
}

async function main() {
  const r = makeReporter()
  const ctx = await launch({ tag: 'muse-brief', fixtures: { agents: [{ slug: 'muse', name: 'Muse', nameZh: '卜算子', nameEn: 'Muse', description: 'Muse', createdBy: 'system' }], sessions: [] }, stubOverride: override })
  const { app, win } = ctx
  const brief = win.locator('[data-muse-brief]').first()
  const text = () => brief.innerText().catch(() => '')
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(250) } return false }
  const keys = () => win.locator('[data-section="widgets"] [data-card-key]:not(.msb-proposed)').evaluateAll((els) => els.map((e) => e.getAttribute('data-card-key')))
  const lastOp = () => W.ops[W.ops.length - 1] || {}
  const shot = async (name) => { await sleep(500); const f = path.join(OUT, `${name}.png`); await win.locator('.dv-groupview').filter({ has: brief }).first().screenshot({ path: f }).catch(() => win.screenshot({ path: f })); r.note('shot', f) }
  // enterSpace 在 Ribbon 收起时会点开「更多 Space」浮层,进去以后它还开着、会盖进截图:按一次 Esc 收掉
  const closeOverflow = async () => { await win.keyboard.press('Escape').catch(() => {}); await sleep(200) }
  const reenter = async () => { await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await enterSpace(win, 'muse'); await brief.waitFor({ timeout: 15000 }); await closeOverflow() }
  try {
    await boot(app, win, { space: null, width: 1512, height: 950 })
    r.check('进 Muse Space', await enterSpace(win, 'muse'))
    await closeOverflow()
    await brief.waitFor({ timeout: 15000 })
    await until(async () => (await keys()).length === 3)

    // ── B 静止态 ──
    const t0 = await text()
    r.check('B1 那句话:by 行「卜算子 · … 写的」+ 正文,[[链接]] 画成「议程」', /卜算子 · .+ 写的/.test(t0) && /周一周会的议程我起了一版/.test(t0) && (await win.locator('.msb-lede .msb-link').innerText()) === '议程', t0.slice(0, 160))
    r.check('B2 备好的三份,新的在前', JSON.stringify(await win.locator('[data-file]').evaluateAll((els) => els.map((e) => e.getAttribute('data-file')))) === JSON.stringify(['Drafts/周会议程.md', 'Reading/置身事内 · 摘录.md', 'Journal/本周回顾.md']))
    r.check('B3 格子:待你看的 · 2.14 发版清单 · 在跟的', JSON.stringify(await keys()) === JSON.stringify(['todos', 'release', 'tracking']), JSON.stringify(await keys()))
    r.check('B3b 卜算子做的那张画出原件标题和「卜算子做的」', await until(async () => /2\.14 发版清单/.test(await win.locator('[data-card-key="release"]').innerText().catch(() => '')) && /卜算子做的/.test(await win.locator('[data-card-key="release"]').innerText().catch(() => ''))))
    r.check('B4 待你看的三条;今天三段(手记按 ## 切,时刻进左列)', await until(async () => (await win.locator('[data-card-key="todos"] [data-todo-id]').count()) === 3) && (await win.locator('[data-section="today"] .msb-tli').count()) === 3)
    r.check('B5 在跟的两条', (await win.locator('[data-card-key="tracking"] .msb-ev').count()) === 2)
    r.check('B6 两张提议卡,卡顶「卜算子想加这张 · 理由」', (await win.locator('.msb-proposed').count()) === 2 && /卜算子想加这张 · 你这周大半时间在 Genesis/.test(await win.locator('[data-proposal="focus-week"]').innerText()))
    await shot('brief-light')

    await win.locator('[data-card-key="todos"] [data-todo-id="t1"] .msb-box').click()
    r.check('B7 勾第一条 → 引擎收到 t1 done', await until(async () => W.patches.some((x) => x.id === 't1' && x.status === 'done')), JSON.stringify(W.patches))

    await win.locator('[data-proposal="focus-week"] .msb-pill.solid').click()
    r.check('B8 提议「放上」→ accept,进格子', await until(async () => lastOp().type === 'accept' && (await keys()).includes('focus-week')), JSON.stringify(W.ops))
    await win.locator('[data-proposal="book-club"] .msb-pill.ghost').click()
    r.check('B9 提议「不要」→ reject,卡消失', await until(async () => lastOp().type === 'reject' && (await win.locator('.msb-proposed').count()) === 0), JSON.stringify(W.ops))

    await win.locator('[data-card-key="release"] .msb-ch .msb-icbtn').click()
    await win.locator('.ctx-menu, [role="menu"]').locator('text=放到主页').first().click()
    r.check('B10 小组件「⋯ → 放到主页」写进主页摆放', await until(async () => /w_release/.test(await win.evaluate(() => localStorage.getItem('forsion.homepage.widgets.desktop.v1') || ''))))

    await win.locator('.msb-lede .msb-link').click()
    r.check('B11 点那句话里的链接 → 主区新标签开文件', await until(async () => (await win.locator('.dv-tab', { hasText: '周会议程' }).count()) > 0))
    await win.locator('.dv-tab', { hasText: 'Muse' }).first().click().catch(() => {})
    await brief.waitFor({ timeout: 10000 })

    // ── R 右栏管理面 ──
    const panel = win.locator('[data-muse-panel]').first()
    r.check('R1 右栏 = 管理面:没有「待办」「它给自己排的」,有「什么时候叫醒它」', await until(async () => (await panel.locator('[data-section="wake"]').count()) === 1) && (await panel.locator('[data-section="todos"], [data-section="tracks"], [data-section="inject"]').count()) === 0)

    // ── E 编辑态 ──
    await win.locator('[data-action="edit"]').click()
    r.check('E1 铅笔 → 每张卡出把手,头行变成「恢复默认 / 完成」', await until(async () => (await win.locator('[data-section="widgets"] .msb-grip').count()) >= 3) && /恢复默认/.test(await text()))
    await win.locator('[data-card-key="tracking"] .msb-ch .msb-icbtn').click()
    r.check('E2 隐藏「在跟的」→ hide,进「已隐藏」', await until(async () => lastOp().type === 'hide' && (await win.locator('[data-hidden-cards]').innerText().catch(() => '')).includes('在跟的')))
    await win.locator('[data-hidden-cards] .msb-pill').first().click()
    r.check('E3 在「已隐藏」里点回来 → show', await until(async () => lastOp().type === 'show' && (await keys()).includes('tracking')))
    await win.locator('[data-action="add"]').click()
    const pop = win.locator('[data-add-popover]')
    r.check('E4 添加浮层:内置里「待你看的」已放打勾;卜算子做的列出三张', await until(async () => (await pop.locator('[data-add="todos"]').isDisabled()) && (await pop.locator('[data-add^="w_"]').count()) === 3))
    await pop.locator('[data-add="status"]').click()
    r.check('E5 点「卜算子状态」→ add,放到最后一格', await until(async () => lastOp().type === 'add' && (await keys()).at(-1) === 'status'), JSON.stringify(await keys()))
    // 拖动:把「在跟的」拖到第一张前面
    const grip = win.locator('[data-card-key="tracking"] .msb-ch')
    const first = await win.locator('[data-card-key="todos"]').boundingBox()
    const g = await grip.boundingBox()
    await win.mouse.move(g.x + 8, g.y + g.height / 2); await win.mouse.down()
    await win.mouse.move(g.x + 30, g.y + 10, { steps: 4 })
    await win.mouse.move(first.x + 10, first.y + first.height / 2, { steps: 12 }); await sleep(200)
    await win.mouse.up()
    r.check('E6 拖「在跟的」到最前 → move(to 0)', await until(async () => lastOp().type === 'move' && lastOp().key === 'tracking' && lastOp().to === 0 && (await keys())[0] === 'tracking'), JSON.stringify(W.ops.slice(-2)))
    await shot('brief-editing')
    await win.locator('.msb-head .msb-pill.ghost', { hasText: '恢复默认' }).click()
    r.check('E7 恢复默认 → reset,回到缺省三张', await until(async () => lastOp().type === 'reset' && JSON.stringify(await keys()) === JSON.stringify(['todos', 'today', 'tracking'])))
    await win.locator('[data-action="edit-done"]').click()

    // ── 暗色 / 英文 / 窄 ──
    await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'dark'); localStorage.setItem('forsion_theme', 'dark') })
    await reenter(); await sleep(800); await shot('brief-dark')
    await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_theme', 'light'); localStorage.setItem('tangu_locale', 'en') })
    await reenter()
    r.check('L1 英文:Today\'s brief / Ready for you / Widgets / For you / Tracking', await until(async () => { const s = await text(); return /Today's brief/.test(s) && /Ready for you/.test(s) && /Widgets/.test(s) && /For you/.test(s) && /Tracking/.test(s) }), (await text()).slice(0, 300))
    await shot('brief-en')
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'zh'))
    await win.setViewportSize({ width: 900, height: 950 })
    await reenter(); await sleep(600)
    const cols = await win.locator('[data-section="widgets"] .msb-grid3').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    r.check('N1 窄(主区 < 720)→ 格子单列', cols === 1, `cols=${cols}`)
    await shot('brief-narrow')
    await win.setViewportSize({ width: 1512, height: 950 })

    // ── S 读坏 / 停用 / 空状态 ──
    W.problems = [{ file: 'space', message: 'space.json: Unexpected token' }]
    r.check('S1 读坏 → 头行警示点', await until(async () => (await win.locator('.msb-warn[data-problems]').count()) === 1, 12000))
    W.problems = []
    W.enabled = false
    r.check('S2 停用 → 横条「卜算子已停用，下面是 … 停下前留的」,铅笔收起,那句话还在', await until(async () => /卜算子已停用，下面是 .+ 停下前留的/.test(await text()) && (await win.locator('[data-action="edit"]').count()) === 0 && /周一周会的/.test(await text()), 12000), (await text()).slice(0, 200))
    await shot('brief-off')
    W.enabled = true; W.hasDoc = false; W.lastCycleAt = null
    r.check('S3 第一轮之前:by「还没醒过」+ 首轮说明;格子照画内置卡', await until(async () => /卜算子 · 还没醒过/.test(await text()) && /第一次醒来后/.test(await text()) && (await keys()).includes('todos'), 12000), (await text()).slice(0, 200))
    await shot('brief-empty')
    await win.locator('[data-hero="empty"] [data-action="muse-wake"]').click()
    r.check('S4 「现在叫醒它」→ POST /muse/wake,写「叫醒了，马上开始」', await until(async () => W.wakes === 1 && /叫醒了，马上开始/.test(await text())))
    W.wakes = 0; W.enabled = false
    r.check('S5 从没开过(关着、没那句话、没醒过)→ 公共空态「Muse 还没开」+ 一颗「开启 Muse」,不画格子', await until(async () =>
      (await win.locator('[data-muse-brief][data-state="off"] .empty-state[data-state="off"] .empty-state-action').count()) === 1
      && (await win.locator('[data-muse-brief] .msb-grid3, [data-muse-brief] [data-hero]').count()) === 0, 12000), (await text()).slice(0, 200))
    await shot('brief-never')
    W.enabled = true; W.hasDoc = true; W.lastCycleAt = now - 38 * MIN

    // ── H 主页上的两张 ──
    await win.evaluate(() => localStorage.setItem('forsion.homepage.widgets.desktop.v1', JSON.stringify({ left: [], center: ['clock', 'composer', 'row', 'dock'], row: [{ id: 'builtin:status', w: 4 }], right: ['builtin:museTodos', 'builtin:museTracking'] })))
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 })
    await enterSpace(win, 'home')
    const homeText = async () => win.locator('.hp-wcard, [data-home-id]').evaluateAll((els) => els.map((e) => e.textContent).join(' | ')).catch(() => '')
    r.check('H1 主页右栏「待你看的」「在跟的」两张,带数据', await until(async () => { const s = await homeText(); return /待你看的/.test(s) && /在跟的/.test(s) && /周一产品周会还没有议程/.test(s) && /读书会提醒/.test(s) }, 12000), (await homeText()).slice(0, 300))
    // 文字断言读得到被启动画面盖着的 DOM:截图前等卡片中心真的露在最上层
    await until(() => win.evaluate(() => { const c = document.querySelector('.hp-wcard'); if (!c) return false; const b = c.getBoundingClientRect(); const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!el && c.contains(el) }), 20000)
    await closeOverflow(); await sleep(400)
    const hf = path.join(OUT, 'home-widgets.png'); await win.screenshot({ path: hf }); r.note('shot', hf)
  } catch (e) {
    r.check('台架跑完', false, String((e && e.stack) || e).slice(0, 700))
    const f = path.join(OUT, 'fail.png')
    await win.screenshot({ path: f }).then(() => r.note('fail shot', f), () => {})
  } finally {
    await ctx.close()
  }
  process.exit(r.summary() ? 1 : 0)
}

main()
