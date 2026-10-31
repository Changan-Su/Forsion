/**
 * Muse 私聊 × 收件箱分工(方案 docs/ToBeImproved/Muse私聊与收件箱分工方案_2026-10-17,用户 10-18 选 B)的真 Electron 台架:
 * 桩引擎扮一台「Muse 主动发来三条(问一句 / 提一个待办 / 一步要批)、Xyra 后台跑完一轮没看」的电脑。
 * 断言:
 *  R1 左栏 Muse 行尾 = 等你、Xyra 行尾 = 有新消息;Muse 头像角上不再有常亮的「主动式」点
 *  R2 Tangu 角标 = 2(两条私聊),有人在等你 → 警示色(dm-wait)
 *  R3 点 Muse 行进私聊:三条主动消息头上都有「主动发来 · 时间」,用户 / 普通回答没有
 *  R4 Muse 提的待办(任务书)和后台审批都进对话末尾的卡片堆(10-23「交互卡片一律在最新位置」):
 *     审批在上、待办垫底;流里待办那条只留一行「任务卡「…」· 在对话最下面」,输入框上方不再有 Muse 自己的托盘
 *  R5 审批那条:围栏不进正文,流里一行指向对话最下面;卡片堆最上面是那张审批卡
 *  R6 打开即读过:引擎收到 POST /agent/sessions/<Muse 私聊>/read
 *  R7 卡片堆里点批准 → 审批离开卡片堆,流里那行变成「你在 HH:MM 批准了 · <结果>」;角标降到 1,不再是警示色;
 *     卡片堆顶上换成待办卡,按钮依次「交给 Muse 执行(主)/ 在这里做 / 新会话执行 / 忽略」,没有「开个子会话」
 *  R8 点「交给 Muse 执行」→ 引擎收到批准待办,卡片堆清空,流里那行变成「已交给 Muse 执行」
 *  R9 点 Xyra 行 → 角标清零
 * 截图(亮 / 暗)自己看。量的是 out/ 产物:改了源码先 `npx electron-vite build`。
 *   node ../.claude/hooks/devlock.cjs run --vehicle=e2e --what="Muse 私聊台架" --eta=3 -- node scripts/muse-dm.e2e.cjs
 *   SHOT_DIR=… 指定截图目录;LANG_EN=1 拍英文;DARK=1 拍深色
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir } = require('./lib/uiux-electron.cjs')

const MUSE = '5e0d7c11-7a2b-4c1e-9d10-0000000000a1'
const XYRA = '5e0d7c11-7a2b-4c1e-9d10-0000000000b1'
const LIB = '/tmp/forsion-musedm-lib'
const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
const sess = (id, title, slug, mins) => ({
  id, title, summary: '', model_id: 'm1', archived: false, emoji: null, project_path: null, project_name: null, projectless: true,
  agent_config: { soloAgentSlug: slug, agentSlug: slug, execMode: 'host', cwd: LIB, preset: null },
  created_at: at(mins + 600), updated_at: at(mins),
})
const AGENTS = [
  { slug: 'xyra', name: 'Xyra', description: 'General assistant', createdBy: 'user', libraryDir: LIB },
  { slug: 'muse', name: 'Muse', description: 'Background agent', createdBy: 'system', libraryDir: LIB },
]
const T0 = Date.now() - 50 * 60_000
const MUSE_MSGS = [
  { id: 'u1', role: 'user', timestamp: T0, content: '以后 CI 红了先跟我说一声。' },
  { id: 'a1', role: 'model', agent_slug: 'muse', timestamp: T0 + 60_000, content: '好的,记下了。' },
  { id: 'p1', role: 'model', agent_slug: 'muse', origin: 'proactive', timestamp: T0 + 20 * 60_000, content: 'main 上的 CI 红了一次,我重跑了一遍是绿的。要把 `sync.test.ts` 记成已知抖动吗?' },
  { id: 'p2', role: 'model', agent_slug: 'muse', origin: 'proactive:todo', timestamp: T0 + 30 * 60_000,
    content: '想做:补 README 的 Windows 安装步骤\n\n```forsion-task\ntitle: 补 README 的 Windows 安装步骤\ntodo: t1\ntldr: 现在只写了 macOS\n---\n在 README 里补上 Windows 的安装与常见报错。写完先给用户看。\n```' },
  { id: 'p3', role: 'model', agent_slug: 'muse', origin: 'proactive:approval', timestamp: T0 + 40 * 60_000,
    content: 'write\\_file · Inbox/2026-10-18.md(1.2 KB)\n\n```forsion-approval\n{"id":"a1"}\n```' },
]

async function main() {
  const r = makeReporter()
  const dir = shotDir('muse-dm')
  const seen = { read: [], todoApprove: 0, approve: 0 }
  let approved = false
  let xyraRead = false
  const attention = () => [
    { id: MUSE, unread: !seen.read.includes(MUSE), awaiting: !approved },
    ...(xyraRead ? [] : [{ id: XYRA, unread: true, awaiting: false }]),
  ]
  const row = () => ({
    id: 'a1', session_id: 'cycle', run_id: 'r', agent_slug: 'muse', tool: 'write_file', args: '{}', preview: 'Inbox/2026-10-18.md(1.2 KB)\n+ # 今天整理的三篇', reason: null, cwd: LIB,
    status: approved ? 'approved' : 'pending', decided_by: approved ? 'user' : null, note: null,
    result: approved ? 'Wrote Inbox/2026-10-18.md (1.2 KB)' : null, created_at: at(10), decided_at: approved ? at(0) : null,
  })
  const ctx = await launch({
    tag: 'muse-dm',
    fixtures: { agents: AGENTS, sessions: [] },
    stubOverride: ({ path: p, method }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: [sess(MUSE, 'Muse', 'muse', 2), sess(XYRA, 'Xyra', 'xyra', 5)] }
      if (p === '/agent/sessions/attention') return { sessions: attention() }
      let m = /^\/agent\/sessions\/([^/]+)\/read$/.exec(p)
      if (m && method === 'POST') { seen.read.push(m[1]); if (m[1] === XYRA) xyraRead = true; return { ok: true } }
      m = /^\/agent\/sessions\/([^/]+)\/config$/.exec(p)
      if (m && method === 'GET') return { agent_config: sess(m[1], '', m[1] === MUSE ? 'muse' : 'xyra', 0).agent_config }
      m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: m[1] === MUSE ? MUSE_MSGS : [{ id: 'x1', role: 'model', agent_slug: 'xyra', timestamp: T0, content: '跑完了。' }] }
      if (p === '/agent/runs') return { runs: [] }
      if (p === '/agent/solo/agent/muse/open') return { session: sess(MUSE, 'Muse', 'muse', 2), created: false }
      if (p === '/agent/solo/agent/xyra/open') return { session: sess(XYRA, 'Xyra', 'xyra', 5), created: false }
      if (p === '/agent/special/muse/todos/t1' && method === 'GET') return { todo: { id: 't1', title: '补 README 的 Windows 安装步骤', status: seen.todoApprove ? 'injected' : 'pending' } }
      if (p === '/agent/special/muse/todos/t1/approve' && method === 'POST') { seen.todoApprove++; return { ok: true } }
      if (p === '/agent/special/approvals/a1' && method === 'GET') return { approval: row() }
      if (p === '/agent/special/approvals/a1/approve' && method === 'POST') { seen.approve++; approved = true; return { ok: true, status: 'approved', result: row().result } }
      if (p === '/agent/special/approvals') return { approvals: approved ? [] : [row()] }
      if (p === '/agent/special/config') return { config: { historian: { enabled: false }, muse: { enabled: true, mode: 'ask' } } }
      if (p === '/agent/special/muse/library') return { root: LIB, files: [] }
      if (p === '/agent/special/muse/todos') return { todos: seen.todoApprove ? [] : [{ id: 't1', title: '补 README 的 Windows 安装步骤', detail: null, status: 'pending', source_session_id: null, created_at: at(20) }] }
      return undefined
    },
  })
  const { win } = ctx
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.evaluate((en) => { if (en) localStorage.setItem('tangu_locale', 'en') }, !!process.env.LANG_EN)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    if (process.env.DARK) await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') })
    const orbit = (name) => win.locator('.t2o-row', { has: win.locator('.t2o-name', { hasText: new RegExp(`^${name}$`) }) }).first()
    await orbit('Muse').waitFor({ timeout: 20_000 })
    await win.waitForFunction(() => !!document.querySelector('.t2o-row .t2s-st'), null, { timeout: 15_000 }).catch(() => {})
    const badge = () => win.evaluate(() => {
      const b = document.querySelector('button.rb-space[data-space-id="tangu"] .rb-badge')
      return b ? { n: b.textContent, wait: b.classList.contains('dm-wait') } : null
    })

    // ── 左栏 + 角标 ──
    const rows = await win.evaluate(() => {
      const byName = (n) => [...document.querySelectorAll('.t2o-row')].find((e) => e.querySelector('.t2o-name')?.textContent === n)
      const st = (n) => byName(n)?.querySelector('.t2s-st')
      return {
        muse: st('Muse')?.className.replace('t2s-st', '').trim() || '', xyra: st('Xyra')?.className.replace('t2s-st', '').trim() || '',
        xyraTip: st('Xyra')?.getAttribute('title') || '', proactiveDot: !!byName('Muse')?.querySelector('.t2s-dot.proactive'),
      }
    })
    r.check('R1 Muse 行尾等你、Xyra 行尾有新消息;Muse 头像角没有常亮点', rows.muse === 'wait' && rows.xyra === 'done' && /新消息|New messages/.test(rows.xyraTip) && !rows.proactiveDot, JSON.stringify(rows))
    const b0 = await badge()
    r.check('R2 Tangu 角标 2,警示色', b0?.n === '2' && b0.wait, JSON.stringify(b0))

    // ── 进 Muse 私聊 ──
    await orbit('Muse').click()
    await win.locator('#tocmsg-p3').waitFor({ timeout: 15_000 })
    const DECK = '[data-pending-deck] .t2c-apv'
    await win.waitForSelector(`${DECK} .t2c-apv-body[data-tray-kind="muse-approval"] .ibx-approval[data-approval-status="pending"]`, { timeout: 10_000 }).catch(() => {})
    await win.waitForSelector('#tocmsg-p2 [data-task-trace="pending"]', { timeout: 10_000 }).catch(() => {})
    const chat = await win.evaluate((DECK) => {
      const from = (id) => document.querySelector(`#tocmsg-${id} .t2-dm-from`)?.textContent || ''
      const deck = document.querySelector(DECK)
      return {
        from: ['p1', 'p2', 'p3'].map(from), none: ['a1'].map(from).join(''),
        inStream: !!deck?.closest('.t2-stream-inner'), kinds: deck?.getAttribute('data-tray-msgs') || '', n: deck?.getAttribute('data-approval-tray') || '',
        top: deck?.querySelector('.t2c-apv-body')?.getAttribute('data-tray-kind') || '', more: deck?.querySelector('.t2c-apv-more')?.textContent || '',
        p2card: !!document.querySelector('#tocmsg-p2 .t2-taskcard'), p2trace: document.querySelector('#tocmsg-p2 [data-task-trace]')?.textContent || '',
        oldTray: !!document.querySelector('[data-muse-tray]'),
        fenceLeak: /forsion-approval|"id":"a1"/.test(document.querySelector('#tocmsg-p3')?.textContent || ''),
        pointer: document.querySelector('#tocmsg-p3 [data-muse-approval]')?.getAttribute('data-muse-approval') || '',
        pointerText: document.querySelector('#tocmsg-p3 [data-muse-approval]')?.textContent || '',
        tray: !!deck?.querySelector('.t2c-apv-body[data-tray-kind="muse-approval"] .ibx-approval[data-approval-status="pending"]'),
      }
    }, DECK)
    r.check('R3 三条主动消息头上有「主动发来 · 时间」,普通回答没有', chat.from.every((x) => /主动发来 · \d|Reached out · \d/.test(x)) && !chat.none, JSON.stringify(chat.from))
    r.check('R4 待办与后台审批都在对话末尾的卡片堆(审批在上、待办垫底);流里待办只剩一行;没有 Muse 自己的托盘',
      chat.inStream && chat.n === '2' && chat.top === 'muse-approval' && /任务卡 1|task cards: 1/.test(chat.more) && !chat.p2card && /在对话最下面|at the end of the chat/.test(chat.p2trace) && !chat.oldTray, JSON.stringify(chat))
    r.check('R5 审批围栏不进正文,流里一行指向对话最下面,卡片堆里有那张卡', !chat.fenceLeak && chat.pointer === 'pending' && /对话最下面|end of the chat/.test(chat.pointerText) && chat.tray, `${chat.pointer} · ${chat.pointerText}`)
    await win.waitForTimeout(500)
    r.check('R6 打开即读过(POST read)', seen.read.includes(MUSE), JSON.stringify(seen.read))
    await win.screenshot({ path: path.join(dir, 'dm.png') })

    // ── 卡片堆里批准 ──
    await win.locator(`${DECK} .t2c-apv-body[data-tray-kind="muse-approval"] .ibx-approval button.primary`).click()
    await win.waitForSelector('#tocmsg-p3 [data-muse-approval="approved"]', { timeout: 10_000 }).catch(() => {})
    await win.waitForSelector(`${DECK} .t2c-apv-body[data-tray-kind="task"] .t2-taskcard-actions button.primary`, { timeout: 10_000 }).catch(() => {})
    await win.waitForTimeout(800)
    const after = await win.evaluate((DECK) => ({
      top: document.querySelector(`${DECK} .t2c-apv-body`)?.getAttribute('data-tray-kind') || '',
      buttons: [...document.querySelectorAll(`${DECK} .t2c-apv-body[data-tray-kind="task"] .t2-taskcard-actions button`)].map((b) => `${b.classList.contains('primary') ? '*' : ''}${b.textContent.trim()}`),
      line: document.querySelector('#tocmsg-p3 [data-muse-approval]')?.textContent || '',
      st: document.querySelector('#tocmsg-p3 [data-muse-approval]')?.getAttribute('data-muse-approval') || '',
    }), DECK)
    const b1 = await badge()
    r.check('R7a 批准后审批离开卡片堆、流里变回执;角标 1 且不再警示色', seen.approve === 1 && after.top === 'task' && after.st === 'approved' && /(你在 \d{1,2}:\d{2} 批准了|You approved at).*Wrote Inbox/.test(after.line) && b1?.n === '1' && !b1.wait, `${JSON.stringify(after)} badge=${JSON.stringify(b1)}`)
    const want = process.env.LANG_EN ? ['*Let Muse do it', 'Do it here', 'Run in new session', 'Ignore'] : ['*交给 Muse 执行', '在这里做', '新会话执行', '忽略']
    r.check('R7b 卡片堆顶上换成待办卡:交给 Muse 执行(主)/ 在这里做 / 新会话执行 / 忽略,没有开个子会话', JSON.stringify(after.buttons) === JSON.stringify(want), JSON.stringify(after.buttons))
    await win.screenshot({ path: path.join(dir, 'dm-approved.png') })

    // ── 交给 Muse 执行 ──
    await win.locator(`${DECK} .t2c-apv-body[data-tray-kind="task"] .t2-taskcard-actions button.primary`).click()
    await win.waitForFunction(() => !document.querySelector('[data-pending-deck] .t2c-apv'), null, { timeout: 10_000 }).catch(() => {})
    await win.waitForSelector('#tocmsg-p2 [data-task-trace="muse"]', { timeout: 10_000 }).catch(() => {})
    const done = await win.evaluate(() => ({ deck: !!document.querySelector('[data-pending-deck] .t2c-apv'), trace: document.querySelector('#tocmsg-p2 [data-task-trace]')?.textContent || '' }))
    r.check('R8 交给 Muse 执行 → 引擎收到批准待办,卡片堆清空,流里那行是结局', seen.todoApprove === 1 && !done.deck && /已交给 Muse 执行|Handed to Muse/.test(done.trace), `approve=${seen.todoApprove} ${JSON.stringify(done)}`)
    await win.screenshot({ path: path.join(dir, 'dm-done.png') })

    // ── 点 Xyra 行 → 角标清零 ──
    await orbit('Xyra').click()
    await win.waitForFunction(() => !document.querySelector('button.rb-space[data-space-id="tangu"] .rb-badge'), null, { timeout: 10_000 }).catch(() => {})
    r.check('R9 点 Xyra 行 → 角标清零', !(await badge()) && seen.read.includes(XYRA), JSON.stringify({ badge: await badge(), read: seen.read }))
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
