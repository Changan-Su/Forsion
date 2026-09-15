/**
 * 收件箱正文 Amadeus 化(2026-09-11)回归:真 Electron × 假引擎。
 *  ⓪ Inbox Space 左栏 = 统一工作区(自动 · 收件箱列表源):行 = 共享 SidebarRow + 未读点,分组(未读 / 发信人 / 已归档)可筛,
 *     已归档是单独拉的一份(filter=archived)且点得开;旧 Gmail 式列表(.ibx-row / .ibx-chips)不复存在;
 *  ① agent 消息:正文经 UnifiedPage 只读渲染(表格 / 标题是 Milkdown DOM),页面标题被隐、阅读面板 h1 唯一,围栏原文不进正文;
 *  ② 末尾 forsion-approval 围栏 → 审批卡,卡上的预览来自 GET /agent/special/approvals 的行(正文里没这串字);
 *     点「批准并执行」→ POST /agent/special/approvals/apv-1/approve,卡定格「已批准并执行」+ 结果;
 *  ③ 末尾 forsion-task 围栏 → 任务卡,三个落点(没有「在此执行」);点「忽略」→ 反馈行进 Muse LOG;
 *  ④ forsion-button 块渲染成按钮(桥在场 → 显示「规则不存在」而非「不支持」),只读态没有齿轮;未配置的按钮 disabled、不开构建器;
 *  ⑤ 服务端广播里的同名围栏:不出卡,按代码块显示(信任闸)。
 *  ⑥ 广播附件的领取条件(版本 / 会员档位):不满足 → 物品与条件都看得到、按钮禁用且硬点不发请求;
 *     满足 → 领取请求带本端版本标签 desktop/x.y.z(服务端按它判最低版本);只有会员条件且档位不知道 → 可点,
 *     服务端 403 claim_requirements_unmet → toast 走本地化文案,不把服务端原句甩给用户。
 *  ⑦ Muse TODO 信(正文 = 引擎单测钉住的夹具 tangu-agent/test/fixtures/muse-todo-mail*.md 原样):卡的主按钮「交给 Muse 执行」→
 *     POST /agent/special/muse/todos/:id/approve(引擎按 id 读库里的任务书建日程),前端不自己建日程;detail 代码块没收口的那封
 *     照样出卡,点「忽略」→ 回写 dismissed、前端不另记反馈;别的 agent(xyra)信里抄来的 todo 头不生效 → 普通任务卡;
 *     引擎里已不是 pending 的待办(重启后模块级「已处理」记录没了)→ 卡按真状态定格,不再给按钮;状态读失败 → 零落点按钮、给重试;
 *     「忽略」带 from=pending(CAS)。
 * 负对照 --nc:假引擎按 id 读审批回 404(列表也没有 apv-1),且广播消息伪装成 agent 发信 → ② ⑤ 必红(≥3 条);⑥ 的 403 不带错误码 → 本地化那条也红。
 * 先 `npm run build`;跑法 `npm run e2e:inboxamadeus`;截图 $TMPDIR/forsion-inbox-amadeus.png、forsion-inbox-claimreq.png、forsion-inbox-musetodo.png。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const SHOT = path.join(process.env.SHOT_DIR || os.tmpdir(), 'forsion-inbox-amadeus.png')
const SHOT_REQ = path.join(process.env.SHOT_DIR || os.tmpdir(), 'forsion-inbox-claimreq.png')
const SHOT_TODO = path.join(process.env.SHOT_DIR || os.tmpdir(), 'forsion-inbox-musetodo.png')
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${detail || ''}`}`) }

const F = '```'
const PREVIEW = 'write ~/Documents/todo.md (120 chars)' // 只在假引擎的审批行里,正文绝不出现 → 卡上出现它 = 按 id 读了行
const FENCES = `${F}forsion-approval\n{"id":"apv-1"}\n${F}\n\n${F}forsion-task\ntitle: 补 README 的 Windows 安装步骤\ntldr: 现在只有 mac/linux\n---\n在 README.md 的安装章节补 Windows 步骤,含 PowerShell 命令。\n${F}`
const BODY_AGENT = `Muse 想把今天的待办整理进笔记。\n\n## 今日整理\n\n| 项目 | 状态 |\n|---|---|\n| 收件箱 Amadeus 化 | 进行中 |\n\n> [!note]\n> 这是一条 callout。\n\n${FENCES}`
const BODY_BUTTON = `点一下整理:\n\n${F}forsion-button\n{"v":1,"label":"整理今天的笔记","icon":"✨","triggerId":"w-nonexistent"}\n${F}\n\n未配置的按钮:\n\n${F}forsion-button\n{"v":1,"label":""}\n${F}`
const BODY_SERVER = `服务端广播也带围栏(不该出卡):\n\n${FENCES}`
const at = (h) => `2026-09-11 ${h}:00:00`
const MESSAGES = [
  { id: 'm1', title: '请审批:写待办文件', body: BODY_AGENT, sender_kind: 'agent', sender_id: 'muse', origin_broadcast_id: null, read_at: null, archived_at: null, created_at: at('09') },
  { id: 'm2', title: '按钮块', body: BODY_BUTTON, sender_kind: 'agent', sender_id: 'muse', origin_broadcast_id: null, read_at: null, archived_at: null, created_at: at('08') },
  { id: 'm4', title: '已归档的旧消息', body: '旧消息正文。', sender_kind: 'agent', sender_id: 'muse', origin_broadcast_id: null, read_at: at('06'), archived_at: at('06'), created_at: at('06') },
  { id: 'm3', title: '系统公告', body: BODY_SERVER, sender_kind: NEGATIVE_CONTROL ? 'agent' : 'server', sender_id: NEGATIVE_CONTROL ? 'muse' : null, origin_broadcast_id: 'b1', read_at: null, archived_at: null, created_at: at('07') },
]
// ⑥ 带领取条件的两封广播:前面的行数 / 分组断言按上面 4 封算,这两封到 ⑥ 才塞进假引擎(经「拉取新消息」刷进列表)。
const POINTS = [{ kind: 'points', amount: 100, label: { zh: '积分 ×100', en: 'Points ×100' } }]
const CLAIM_MESSAGES = [
  { id: 'm5', title: '新版本专属奖励', body: '升级到新版本即可领取。', sender_kind: 'server', sender_id: null, origin_broadcast_id: 'b5', read_at: null, archived_at: null, created_at: at('11'),
    attachments: { items: POINTS, claimed: false, requires: { minVersion: '99.0.0', tiers: ['plus', 'pro'] } } },
  { id: 'm6', title: '人人可领的奖励', body: '点下面领取。', sender_kind: 'server', sender_id: null, origin_broadcast_id: 'b6', read_at: null, archived_at: null, created_at: at('10'),
    attachments: { items: POINTS, claimed: false, requires: { minVersion: '0.0.1' } } },
  { id: 'm7', title: '会员专属奖励', body: 'Pro 会员可领。', sender_kind: 'server', sender_id: null, origin_broadcast_id: 'b7', read_at: null, archived_at: null, created_at: at('12'),
    attachments: { items: POINTS, claimed: false, requires: { tiers: ['pro'] } } },
]
const M7_DETAIL = '需要 Pro 会员才能领取 / Requires a Pro plan to claim'
const APPROVAL = { id: 'apv-1', session_id: 'S', run_id: 'R', agent_slug: 'muse', tool: 'write_file', args: '{}', preview: PREVIEW, reason: '{"kind":"escalate","mode":"auto-edit"}', cwd: '/tmp/muse', status: 'pending', decided_by: null, note: null, result: null, created_at: at('09'), decided_at: null }

async function clickInboxSpace(win) {
  const ok = await win.evaluate(() => {
    const b = [...document.querySelectorAll('button.rb-space')].find((x) => /收件箱|inbox/i.test(x.getAttribute('title') || x.textContent || ''))
    if (b) b.click()
    return !!b
  })
  await win.waitForTimeout(1200)
  return ok
}
async function openMessage(win, title) {
  const row = win.locator('.t2sw-plug-list .t2s-srow', { hasText: title }).first()
  await row.click()
  await win.waitForTimeout(1500)
}
// ⑦ 的信原样用引擎单测钉住的夹具(手写一份就是两端键名漂移的来路)
const fixture = (name) => fs.readFileSync(path.resolve(ROOT, '../tangu-agent/test/fixtures', name), 'utf8')
const TODO_MAIL = fixture('muse-todo-mail.md')
const TODO_MESSAGES = [
  { id: 'm8', title: '恢复并验收鹈鹕骑自行车网页动画', body: TODO_MAIL, sender_kind: 'agent', sender_id: 'muse', origin_broadcast_id: null, read_at: null, archived_at: null, created_at: at('13') },
  { id: 'm9', title: '给导出脚本补上错误处理', body: fixture('muse-todo-mail-openfence.md'), sender_kind: 'agent', sender_id: 'muse', origin_broadcast_id: null, read_at: null, archived_at: null, created_at: at('14') },
  // 别的 agent 抄一张带 todo 头的卡:只能是普通任务卡(追踪语义),不许冒充 Muse 的待办
  { id: 'm10', title: '别的 agent 抄来的待办卡', body: TODO_MAIL, sender_kind: 'agent', sender_id: 'xyra', origin_broadcast_id: null, read_at: null, archived_at: null, created_at: at('15') },
  // 重启前就处理过的待办:模块级「已处理」记录没了,卡要按引擎里的真状态定格(桩的 GET /agent/special/muse/todos 回 injected)
  { id: 'm11', title: '重启前已经交给 Muse 的待办', body: TODO_MAIL.replace(/todo-fixture-1/g, 'todo-fixture-3'), sender_kind: 'agent', sender_id: 'muse', origin_broadcast_id: null, read_at: null, archived_at: null, created_at: at('16') },
  // 状态读不到(桩回 500):不能当 pending 给按钮
  { id: 'm12', title: '状态读不到的待办', body: TODO_MAIL.replace(/todo-fixture-1/g, 'todo-fixture-4'), sender_kind: 'agent', sender_id: 'muse', origin_broadcast_id: null, read_at: null, archived_at: null, created_at: at('17') },
]
const bodyText = (win) => win.locator('.ibx-reader-body').first().evaluate((el) => el.textContent || '').catch(() => '')

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-inbox-amadeus-'))
  const seen = { approve: [], feedback: [], schedule: [], patch: [], filters: [], claim: [], todo: [] }
  let pullAdded = 0
  const stub = await startStubEngine({
    sessions: [], messages: [], models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off'] }],
    agents: [{ slug: 'muse', name: 'Muse', description: '', builtin: true }],
    handle: async ({ path: p, method, body, url }) => {
      if (p === '/agent/inbox' && method === 'GET') {
        const f = url.searchParams.get('filter') || 'all'
        seen.filters.push(f)
        return { messages: f === 'archived' ? MESSAGES.filter((m) => m.archived_at) : MESSAGES.filter((m) => !m.archived_at && (f !== 'unread' || !m.read_at)) }
      }
      if (p === '/agent/inbox/unread-count') return { count: MESSAGES.filter((m) => !m.read_at && !m.archived_at).length, latestId: 'm1' }
      if (p === '/agent/inbox/pull') { const added = pullAdded; pullAdded = 0; return { pulled: added > 0, added } }
      if (/^\/agent\/inbox\/[^/]+\/claim$/.test(p)) {
        const id = p.split('/')[3]; const b = await body(); seen.claim.push({ id, method, client: b.client })
        if (id === 'm7') return { __code: 403, body: NEGATIVE_CONTROL ? { detail: M7_DETAIL } : { error: 'claim_requirements_unmet', detail: M7_DETAIL } }
        const m = MESSAGES.find((x) => x.id === id)
        if (m?.attachments) m.attachments.claimed = true
        return { ok: true, alreadyClaimed: false }
      }
      if (p === '/agent/inbox/read-all') return { ok: true }
      if (/^\/agent\/inbox\/[^/]+$/.test(p) && method === 'PATCH') {
        // 已读 / 归档落回假引擎:切档重拉时服务端口径与客户端乐观更新一致(否则刚读的又变未读)
        const b = await body(); const id = p.split('/').pop(); seen.patch.push({ id, ...b })
        const m = MESSAGES.find((x) => x.id === id)
        if (m && typeof b.read === 'boolean') m.read_at = b.read ? at('10') : null
        if (m && typeof b.archived === 'boolean') m.archived_at = b.archived ? at('10') : null
        return { ok: true }
      }
      if (p === '/agent/special/approvals') return { approvals: NEGATIVE_CONTROL ? [] : [APPROVAL] }
      if (p === '/agent/special/approvals/apv-1' && method === 'GET') return NEGATIVE_CONTROL ? { __code: 404, body: { detail: 'approval not found' } } : { approval: APPROVAL }
      // 决定端点只认 POST:前端误改成 GET 必须红(Codex 09-11 P2)
      if (/^\/agent\/special\/approvals\/[^/]+\/(approve|reject)$/.test(p) && method !== 'POST') return { __code: 405, body: { detail: 'method not allowed' } }
      if (/^\/agent\/special\/approvals\/[^/]+\/(approve|reject)$/.test(p)) {
        seen.approve.push({ id: p.split('/')[4], decision: p.split('/')[5], method })
        return { ok: true, status: 'approved', result: 'wrote todo.md (120 chars)' }
      }
      if (p === '/agent/special/muse/feedback' && method === 'POST') { seen.feedback.push((await body()).text); return { ok: true } }
      if (p === '/agent/special/muse/todos' && method === 'GET') return { todos: [{ id: 'todo-fixture-3', title: '重启前已经交给 Muse 的待办', detail: null, status: 'injected', source_session_id: null, created_at: at('09') }] }
      if (/^\/agent\/special\/muse\/todos\/[^/]+$/.test(p) && method === 'GET') {
        const st = { 'todo-fixture-1': 'pending', 'todo-fixture-2': 'pending', 'todo-fixture-3': 'injected' }[p.split('/').pop()]
        if (p.endsWith('/todo-fixture-4')) return { __code: 500, body: { detail: 'db locked' } }
        return st ? { todo: { id: p.split('/').pop(), title: 't', status: st } } : { __code: 404, body: { error: 'todo_not_found', detail: 'todo not found' } }
      }
      if (/^\/agent\/special\/muse\/todos\/[^/]+\/approve$/.test(p)) { seen.todo.push({ id: p.split('/')[5], action: 'approve', method }); return { ok: true } }
      if (/^\/agent\/special\/muse\/todos\/[^/]+$/.test(p) && method === 'PATCH') { seen.todo.push({ id: p.split('/').pop(), ...(await body()) }); return { ok: true } }
      if (p === '/agent/special/schedule/muse/entries' && method === 'POST') { const b = await body(); seen.schedule.push(b); return { entry: { id: 's-2', ...b, lastRun: '' }, created: true } }
      return undefined
    },
  })
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1500, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.locator('.ntf-close').evaluateAll((bs) => bs.forEach((b) => b.click())).catch(() => {})

    // ① 进收件箱 Space,打开 agent 消息
    const spaced = await clickInboxSpace(win)
    await win.waitForSelector('.t2sw-plug-list .t2s-srow', { timeout: 15_000 }).catch(() => {})
    await win.waitForTimeout(600)
    const ws = await win.evaluate(() => {
      const plug = document.querySelector('.t2sw-plug')
      const root = plug?.closest('.t2sw')
      return {
        trigger: root?.querySelector('.t2sw-mode-label')?.textContent || '',
        rows: plug ? plug.querySelectorAll('.t2sw-plug-list .t2s-srow').length : 0,
        dots: plug ? plug.querySelectorAll('.t2sw-plug-list .t2s-srow .t2s-dot.unread').length : 0,
        groups: plug ? [...plug.querySelectorAll(':scope > .t2s-srow .t2s-srow-title')].map((e) => e.textContent) : [],
        oldRows: document.querySelectorAll('.ibx-row, .ibx-chips').length,
        dotInCorner: (() => {
          const dot = plug?.querySelector('.t2sw-plug-list .t2s-srow .t2s-dot.unread')
          const lead = dot?.closest('.t2s-lead')
          if (!dot || !lead) return false
          const a = lead.getBoundingClientRect(), b = dot.getBoundingClientRect()
          const cx = b.left + b.width / 2, cy = b.top + b.height / 2
          return b.width > 0 && cx >= a.left + a.width / 2 && cx <= a.right + 3 && cy >= a.top + a.height / 2 && cy <= a.bottom + 3
        })(),
      }
    })
    check('收件箱 Space 左栏 = 统一工作区(自动 · 收件箱):3 行、未读点 3 个且贴在图标右下角,旧 Gmail 式列表 0 个', spaced && ws.trigger.includes('收件箱') && ws.rows === 3 && ws.dots === 3 && ws.dotInCorner && ws.oldRows === 0, JSON.stringify({ spaced, ...ws }))
    check('工作区分组(文件夹):全部 / 未读 / 按发信人(Muse、Forsion)/ 已归档', ['全部', '未读', 'Muse', 'Forsion', '已归档'].every((g) => ws.groups.includes(g)), JSON.stringify(ws.groups))
    await openMessage(win, '请审批')
    // 块编辑器挂在 .unified-page 的兄弟容器里,探针以 .ibx-amadeus(整个只读页宿主)为根。
    await win.waitForSelector('.ibx-reader-body .ibx-amadeus table', { timeout: 20_000 }).catch(() => {})
    const dom = await win.evaluate(() => {
      const host = document.querySelector('.ibx-reader-body .ibx-amadeus')
      const text = host?.textContent || ''
      const titleWrap = host?.querySelector('.amx-title-wrap')
      return {
        page: !!host?.querySelector('.unified-page'), table: !!host?.querySelector('table'), h2: !!host?.querySelector('h2'), callout: text.includes('这是一条 callout'),
        titleHidden: !titleWrap || getComputedStyle(titleWrap).display === 'none',
        // 可见的 h1 只能有阅读面板自己那个(隐掉的页面标题仍在 DOM 里,不算)
        h1s: [...document.querySelectorAll('.ibx-reader-wrap h1')].filter((el) => el.offsetParent !== null).length,
        leak: text.includes('forsion-approval') || text.includes('forsion-task') || text.includes('apv-1'),
      }
    })
    check('正文经 UnifiedPage 只读渲染:表格 / 二级标题 / callout 都是 Milkdown DOM', dom.page && dom.table && dom.h2 && dom.callout, JSON.stringify(dom))
    check('页面标题被隐、阅读面板 h1 唯一;两道围栏原文不进正文', dom.titleHidden && dom.h1s === 1 && !dom.leak, JSON.stringify(dom))

    // ② 审批卡:内容来自行,不来自正文
    await win.waitForSelector('.ibx-approval[data-approval-status="pending"]', { timeout: 10_000 }).catch(() => {})
    const apv = await win.evaluate(() => {
      const c = document.querySelector('.ibx-approval')
      return { n: document.querySelectorAll('.ibx-approval').length, status: c?.getAttribute('data-approval-status'), preview: c?.querySelector('.ibx-approval-preview')?.textContent, buttons: [...(c?.querySelectorAll('.t2-taskcard-actions button') || [])].map((b) => b.textContent.trim()) }
    })
    check('审批卡:预览 = 假引擎行里的文字(正文里没有它),状态 pending,两个按钮', apv.n === 1 && apv.status === 'pending' && apv.preview === PREVIEW && apv.buttons.length === 2 && apv.buttons[0].includes('批准'), JSON.stringify(apv))

    // ③ 任务卡:三个落点,没有「在此执行」
    const task = await win.evaluate(() => {
      const c = document.querySelector('.ibx-cards .t2-taskcard:not(.ibx-approval)')
      return { n: document.querySelectorAll('.ibx-cards .t2-taskcard:not(.ibx-approval)').length, title: c?.querySelector('.t2-taskcard-head b')?.textContent, buttons: [...(c?.querySelectorAll('.t2-taskcard-actions button') || [])].map((b) => b.textContent.trim()) }
    })
    check('任务卡:标题对、三个落点(新会话 / Muse / 忽略),没有「在此执行」', task.n === 1 && task.title === '补 README 的 Windows 安装步骤' && task.buttons.length === 3 && !task.buttons.some((b) => b.includes('在此')) && task.buttons.some((b) => b.includes('新会话')) && task.buttons.some((b) => b.includes('Muse')), JSON.stringify(task))
    if (!NEGATIVE_CONTROL) await win.screenshot({ path: SHOT }).catch(() => {})

    // 批准 → 引擎收到 POST,卡定格
    const approveBtn = win.locator('.ibx-approval .t2-taskcard-actions button').first()
    if (await approveBtn.count()) await approveBtn.click()
    await win.waitForSelector('.ibx-approval[data-approval-status="approved"]', { timeout: 10_000 }).catch(() => {})
    const after = await win.evaluate(() => {
      const c = document.querySelector('.ibx-approval')
      return { status: c?.getAttribute('data-approval-status'), done: c?.querySelector('.t2-taskcard-done')?.textContent, result: c?.querySelector('.ibx-approval-result')?.textContent, buttons: c?.querySelectorAll('.t2-taskcard-actions button').length ?? -1 }
    })
    check('「批准并执行」→ POST /agent/special/approvals/apv-1/approve,卡定格「已批准并执行」+ 结果,按钮消失', seen.approve.length === 1 && seen.approve[0].id === 'apv-1' && seen.approve[0].decision === 'approve' && seen.approve[0].method === 'POST' && after.status === 'approved' && after.done === '已批准并执行' && (after.result || '').includes('wrote todo.md') && after.buttons === 0, JSON.stringify({ approve: seen.approve, after }))

    // 忽略任务卡 → 反馈行
    const ignoreBtn = win.locator('.ibx-cards .t2-taskcard:not(.ibx-approval) .t2-taskcard-actions button', { hasText: '忽略' }).first()
    if (await ignoreBtn.count()) await ignoreBtn.click()
    await win.waitForTimeout(800)
    check('任务卡「忽略」→ Muse LOG 收到 [feedback] 行,卡定格', seen.feedback.some((x) => /ignored/.test(x)) && (await win.locator('.ibx-cards .t2-taskcard.done:not(.ibx-approval)').count()) === 1, JSON.stringify(seen.feedback))

    // 工作区分组筛选:未读(客户端)/ 按发信人 / 已归档(换服务端 filter)/ 回到全部
    const clickGroup = async (name) => { await win.locator('.t2sw-plug > .t2s-srow', { hasText: name }).first().click().catch(() => {}); await win.waitForTimeout(900) }
    const listRows = () => win.locator('.t2sw-plug-list .t2s-srow').count()
    await clickGroup('未读'); const unreadRows = await listRows()
    await clickGroup('Muse'); const museRows = await listRows()
    await clickGroup('已归档'); const archivedRows = await listRows()
    await openMessage(win, '已归档的旧消息')
    const archivedTitle = await win.locator('.ibx-reader-title').first().textContent().catch(() => '')
    await clickGroup('全部'); const allRows = await listRows()
    check('分组筛选:未读剩 2(刚读的那封掉出)/ Muse 2(不含已归档)/ 已归档 1 封且点得开 / 回到全部 3;已归档是单独拉的(filter=archived)',
      unreadRows === 2 && museRows === 2 && archivedRows === 1 && archivedTitle === '已归档的旧消息' && allRows === 3 && seen.filters.includes('archived'),
      JSON.stringify({ unreadRows, museRows, archivedRows, archivedTitle, allRows, filters: seen.filters }))

    // ④ 按钮块
    await openMessage(win, '按钮块')
    await win.waitForSelector('.ibx-reader-body .amx-btnblock', { timeout: 15_000 }).catch(() => {})
    await win.waitForTimeout(1000)
    const btn = await win.evaluate(() => {
      const all = [...document.querySelectorAll('.ibx-reader-body .amx-btnblock')]
      const b = all[0]
      const blank = all[1]?.querySelector('.amx-btnblock-btn')
      return { n: all.length, label: b?.querySelector('.amx-btnblock-btn')?.textContent, gears: b?.querySelectorAll('.amx-btnblock-gear').length ?? -1, status: b?.querySelector('.amx-btnblock-status')?.textContent || '', blankDisabled: !!blank?.disabled, blankAttr: blank?.hasAttribute('data-blank') }
    })
    check('forsion-button 渲染成按钮(桥在场:提示规则不存在,而非「不支持」),只读态无齿轮', btn.n === 2 && (btn.label || '').includes('整理今天的笔记') && btn.gears === 0 && /不存在/.test(btn.status) && !/不支持/.test(btn.status), JSON.stringify(btn))
    // 未配置的按钮:只读态 disabled;硬点一下也不许开自动化构建器
    await win.locator('.ibx-reader-body .amx-btnblock').nth(1).locator('.amx-btnblock-btn').click({ force: true }).catch(() => {})
    await win.waitForTimeout(600)
    const builderOpen = await win.evaluate(() => !!document.querySelector('.automation-builder, .auto-builder, [data-automation-builder], .amx-btnblock-cfg'))
    check('未配置的按钮在只读消息里 disabled,点了也不开构建器', btn.blankDisabled && btn.blankAttr && !builderOpen, JSON.stringify({ blankDisabled: btn.blankDisabled, blankAttr: btn.blankAttr, builderOpen }))

    // ⑤ 服务端广播:同名围栏不出卡,按代码块露出
    await openMessage(win, '系统公告')
    await win.waitForSelector('.ibx-reader-body .unified-page', { timeout: 15_000 }).catch(() => {})
    await win.waitForTimeout(800)
    const srv = await win.evaluate(() => ({
      cards: document.querySelectorAll('.ibx-cards, .ibx-cards .t2-taskcard').length,
      code: [...document.querySelectorAll('.ibx-reader-body pre, .ibx-reader-body code')].some((el) => (el.textContent || '').includes('"id":"apv-1"')),
      approvalLeak: (document.querySelector('.ibx-reader-body')?.textContent || '').includes('批准并执行'),
    }))
    check('服务端广播里的围栏:零卡片,围栏内容按代码块露出(信任闸)', srv.cards === 0 && srv.code && !srv.approvalLeak, JSON.stringify(srv))

    // 切回 m1:审批卡仍是已批准(重挂后按 id 重读行,不是靠正文)
    await openMessage(win, '请审批')
    await win.waitForTimeout(1200)
    const back = await win.evaluate(() => document.querySelector('.ibx-approval')?.getAttribute('data-approval-status'))
    // 假引擎的列表仍回 pending(它不记状态)→ 这里只验卡重挂后仍按 id 读到了行;真引擎会回 approved。
    check('切走再切回:审批卡按 id 重读行(不是 missing)', back === 'pending' || back === 'approved', JSON.stringify({ back }))

    // ⑥ 领取条件
    MESSAGES.push(...CLAIM_MESSAGES); pullAdded = CLAIM_MESSAGES.length
    await win.locator('.t2sw-plug-btn', { hasText: '拉取新消息' }).first().click().catch(() => {})
    await win.waitForSelector('.t2sw-plug-list .t2s-srow:has-text("新版本专属奖励")', { timeout: 10_000 }).catch(() => {})
    await openMessage(win, '新版本专属奖励')
    await win.waitForSelector('.ibx-attach', { timeout: 10_000 }).catch(() => {})
    await win.waitForTimeout(600) // 会员档位现拉(未登录 → 不知道)落定
    const gated = await win.evaluate(() => {
      const box = document.querySelector('.ibx-attach')
      const b = box?.querySelector('.ibx-claim-btn')
      return { chips: [...(box?.querySelectorAll('.ibx-req-chip') || [])].map((c) => ({ text: c.textContent || '', cls: c.className })), btn: b?.textContent || '', disabled: !!b?.disabled }
    })
    check('领取条件不满足(要 99.0.0 + Plus/Pro):物品与条件都看得到,版本那枚标 ✗,会员档位没登录不知道 → 不标;按钮禁用写「未满足领取条件」',
      gated.chips.length === 2 && gated.chips[0].text.includes('99.0.0') && gated.chips[0].cls.includes('bad') && gated.chips[1].text.includes('Plus') && !/\b(ok|bad)\b/.test(gated.chips[1].cls) && gated.disabled && gated.btn === '未满足领取条件',
      JSON.stringify(gated))
    await win.screenshot({ path: SHOT_REQ }).catch(() => {})
    await win.locator('.ibx-claim-btn').first().click({ force: true }).catch(() => {})
    await win.waitForTimeout(600)
    check('禁用的领取按钮硬点也不发领取请求', seen.claim.length === 0, JSON.stringify(seen.claim))
    await openMessage(win, '人人可领的奖励')
    await win.waitForSelector('.ibx-attach .ibx-req-chip', { timeout: 10_000 }).catch(() => {})
    const okChip = await win.evaluate(() => document.querySelector('.ibx-attach .ibx-req-chip')?.className || '')
    await win.locator('.ibx-claim-btn').first().click().catch(() => {})
    await win.waitForTimeout(1200)
    const claimedText = await win.locator('.ibx-claim-btn').first().textContent().catch(() => '')
    check('条件满足(0.0.1):版本那枚标 ✓ → 点领取 = POST /agent/inbox/m6/claim 且带本端版本标签 desktop/x.y.z,按钮翻「已领取」',
      okChip.includes('ok') && seen.claim.length === 1 && seen.claim[0].id === 'm6' && seen.claim[0].method === 'POST' && /^desktop\/\d+\.\d+/.test(seen.claim[0].client || '') && claimedText === '已领取',
      JSON.stringify({ okChip, claim: seen.claim, claimedText }))
    await openMessage(win, '会员专属奖励')
    await win.waitForSelector('.ibx-attach .ibx-req-chip', { timeout: 10_000 }).catch(() => {})
    await win.waitForTimeout(600)
    const m7Btn = win.locator('.ibx-claim-btn').first()
    const m7Enabled = await m7Btn.isEnabled().catch(() => false)
    await m7Btn.click().catch(() => {})
    await win.waitForTimeout(1000)
    const m7 = await win.evaluate(() => ({ text: document.body.innerText, btn: document.querySelector('.ibx-claim-btn')?.textContent || '' }))
    const m7Claim = seen.claim.find((c) => c.id === 'm7')
    check('只有会员条件、档位不知道:按钮可点 → 服务端 403 → toast 是本地化的「未满足领取条件」而不是服务端原句,按钮不翻「已领取」',
      m7Enabled && !!m7Claim && /^desktop\//.test(m7Claim.client || '') && m7.text.includes('未满足领取条件，暂时领不了') && !m7.text.includes('Requires a Pro plan') && m7.btn === '领取',
      JSON.stringify({ m7Enabled, m7Claim, btn: m7.btn, toast: (m7.text.match(/未满足领取条件[^\n]*|需要 Pro[^\n]*/) || [''])[0] }))

    // ⑦ Muse TODO 信:引擎拼的任务卡(todo 头)→「交给 Muse 执行」= 引擎批准端点(按 id 读库里的任务书),反馈由引擎写
    MESSAGES.push(...TODO_MESSAGES); pullAdded = TODO_MESSAGES.length
    await win.locator('.t2sw-plug-btn', { hasText: '拉取新消息' }).first().click().catch(() => {})
    await win.waitForSelector('.t2sw-plug-list .t2s-srow:has-text("恢复并验收")', { timeout: 10_000 }).catch(() => {})
    const cardOf = () => win.evaluate(() => {
      const cards = [...document.querySelectorAll('.ibx-cards .t2-taskcard:not(.ibx-approval)')]
      const btns = [...(cards[0]?.querySelectorAll('.t2-taskcard-actions button') || [])]
      return { n: cards.length, title: cards[0]?.querySelector('.t2-taskcard-head b')?.textContent || '', buttons: btns.map((b) => b.textContent.trim()), primary: btns.filter((b) => b.classList.contains('primary')).map((b) => b.textContent.trim()), body: document.querySelector('.ibx-reader-body .ibx-amadeus')?.textContent || '' }
    })
    await openMessage(win, '恢复并验收')
    await win.waitForSelector('.ibx-cards .t2-taskcard:not(.ibx-approval) .t2-taskcard-actions button', { timeout: 10_000 }).catch(() => {}) // 状态确认 pending 后才有按钮
    const todoCard = await cardOf()
    check('Muse TODO 信:正文 = detail(围栏原文不露),末尾任务卡的主按钮是排第一的「交给 Muse 执行」,另有新会话 / 忽略',
      todoCard.n === 1 && todoCard.buttons.length === 3 && todoCard.buttons[0] === '交给 Muse 执行' && todoCard.primary.length === 1 && todoCard.primary[0] === '交给 Muse 执行' && todoCard.buttons.some((b) => b.includes('新会话')) && todoCard.body.includes('pelican-cycling.html') && !todoCard.body.includes('forsion-task') && !todoCard.body.includes('todo-fixture-1'),
      JSON.stringify(todoCard))
    if (!NEGATIVE_CONTROL) await win.screenshot({ path: SHOT_TODO }).catch(() => {})
    const nSched = seen.schedule.length
    await win.locator('.ibx-cards .t2-taskcard:not(.ibx-approval) .t2-taskcard-actions button', { hasText: '交给 Muse 执行' }).first().click({ timeout: 3000 }).catch(() => {})
    await win.waitForTimeout(1000)
    const doneText = await win.locator('.ibx-cards .t2-taskcard.done:not(.ibx-approval) .t2-taskcard-done').first().textContent({ timeout: 2000 }).catch(() => '')
    check('「交给 Muse 执行」= POST /agent/special/muse/todos/todo-fixture-1/approve(引擎按 id 读任务书),前端不自己建日程,卡定格',
      seen.todo.some((x) => x.id === 'todo-fixture-1' && x.action === 'approve' && x.method === 'POST') && seen.schedule.length === nSched && doneText === '已交给 Muse 执行',
      JSON.stringify({ todo: seen.todo, schedule: seen.schedule.slice(nSched), doneText }))
    await openMessage(win, '给导出脚本补上错误处理')
    await win.waitForSelector('.ibx-cards .t2-taskcard:not(.done)', { timeout: 10_000 }).catch(() => {})
    const openFence = await cardOf()
    const nFeedback = seen.feedback.length
    await win.locator('.ibx-cards .t2-taskcard:not(.ibx-approval) .t2-taskcard-actions button', { hasText: '忽略' }).first().click({ timeout: 3000 }).catch(() => {})
    await win.waitForTimeout(800)
    check('detail 的代码块没收口也照样出卡(引擎补了收口);「忽略」= 回写 dismissed,前端不另记反馈(引擎 PATCH 路由自己写,见引擎 museTodoApprove.test)',
      openFence.n === 1 && openFence.title === '给导出脚本补上错误处理' && openFence.body.includes('exportAll') && !openFence.body.includes('forsion-task') && seen.todo.some((x) => x.id === 'todo-fixture-2' && x.status === 'dismissed' && x.from === 'pending') && seen.feedback.length === nFeedback,
      JSON.stringify({ openFence, todo: seen.todo, feedback: seen.feedback.slice(nFeedback) }))
    await openMessage(win, '别的 agent 抄来的待办卡')
    await win.waitForSelector('.ibx-cards .t2-taskcard', { timeout: 10_000 }).catch(() => {})
    const forged = await cardOf()
    check('别的 agent 的信里写了 todo 头:只当普通任务卡(主按钮「新会话执行」、Muse 那档是「追踪」),不冒充 Muse 的待办',
      forged.n === 1 && forged.primary.length === 1 && forged.primary[0] === '新会话执行' && forged.buttons.includes('交给 Muse 追踪') && !forged.buttons.includes('交给 Muse 执行'),
      JSON.stringify(forged))
    await openMessage(win, '重启前已经交给 Muse 的待办')
    await win.waitForSelector('.ibx-cards .t2-taskcard', { timeout: 10_000 }).catch(() => {})
    await win.waitForTimeout(600) // 待办真状态现拉
    const settled = await win.evaluate(() => {
      const c = document.querySelector('.ibx-cards .t2-taskcard:not(.ibx-approval)')
      return { done: !!c?.classList.contains('done'), text: c?.querySelector('.t2-taskcard-done')?.textContent || '', buttons: c?.querySelectorAll('.t2-taskcard-actions button').length ?? -1 }
    })
    check('引擎里已不是 pending 的待办:卡按真状态定格「这条待办已经处理过了」,不再给按钮(重启后也不能再点一次)',
      settled.done && settled.text === '这条待办已经处理过了' && settled.buttons === 0, JSON.stringify(settled))
    await openMessage(win, '状态读不到的待办')
    await win.waitForTimeout(600)
    const unknown = await win.evaluate(() => {
      const c = document.querySelector('.ibx-cards .t2-taskcard:not(.ibx-approval)')
      return { text: c?.querySelector('.t2-taskcard-done')?.textContent || '', landing: c?.querySelectorAll('.t2-taskcard-actions button').length ?? -1, retry: [...(c?.querySelectorAll('.t2-taskcard-done button') || [])].map((b) => b.textContent.trim()) }
    })
    check('待办状态读失败:不当 pending 给落点按钮(零个),只给「重试」', unknown.landing === 0 && unknown.text.includes('待办状态读取失败') && unknown.retry.includes('重试'), JSON.stringify(unknown))
  } finally {
    await app.close().catch(() => {})
    stub.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过${NEGATIVE_CONTROL ? `(负对照:${failed.length} 条转红,预期 ≥3)` : ''}${NEGATIVE_CONTROL ? '' : ` · 截图 ${SHOT}、${SHOT_REQ}`}`)
  if (NEGATIVE_CONTROL) process.exit(failed.length >= 3 ? 1 : 2)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
