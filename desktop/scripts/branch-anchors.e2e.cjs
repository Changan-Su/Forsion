/**
 * 挂点统一(方案 docs/ToBeImproved/Chat画布分支方案_2026-10-18 第二轮,第一步)的真 Electron 台架:
 * 桩引擎回一棵分支树(主线 + 两支分支 + 一个子会话)、一条存下来的顺便问,和一段对话。
 * 断言:一条回答下面一块「从这里分出 4」(分支 ×2 / 顺便问 / 子会话);左栏分支挂在主线下、图标是分支;
 * 操作条两个动词;点顺便问那行 = 右边面板载回存下来的往返、续写带 aside_id;从别的回答「顺便问」= 另起一段挂在那条上;
 * 清空 = 删记录;点分支那行 = 主区就地换、顶上「从 X 分出」;分支最后一条「带回这里」= 回到主线、输入框挂上引用;
 * 「接着问」不带标题(引擎记 New Chat)。截图自己看。
 * 量的是 out/ 产物:改了源码先 `npx electron-vite build`。
 *   node ../.claude/hooks/devlock.cjs run --vehicle=e2e --what="挂点台架" --eta=3 -- node scripts/branch-anchors.e2e.cjs
 *   SHOT_DIR=… 指定截图目录;LANG_EN=1 拍英文;DARK=1 拍深色
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir } = require('./lib/uiux-electron.cjs')

const R = '7c1e0a52-0000-4000-8000-0000000000a1'
const B1 = '7c1e0a52-0000-4000-8000-0000000000b1'
const B2 = '7c1e0a52-0000-4000-8000-0000000000b2'
const K = '7c1e0a52-0000-4000-8000-0000000000c1'
const NEWB = '7c1e0a52-0000-4000-8000-0000000000b9'
const T = Date.now() - 30 * 60_000

function sessions(dir, extra) {
  const base = { summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: dir, project_name: 'Forsion', projectless: false }
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = (id, title, mins, more = {}) => ({ ...base, id, title, created_at: at(mins + 60), updated_at: at(mins), ...more })
  return [
    row(R, 'Amadeus 离线同步怎么做', 1),
    row(B1, '如果用 CRDT', 2, { parent_session_id: R, fork_message_id: 'a1', fork_session_id: R, created_at: at(20) }),
    row(B2, '只做桌面端', 3, { parent_session_id: R, fork_message_id: 'a1', fork_session_id: R, busy: true, created_at: at(19) }),
    row(K, '查 Obsidian Sync 的冲突处理', 4, { parent_session_id: R, created_at: at(18) }),
    ...extra,
    row('7c1e0a52-0000-4000-8000-0000000000f1', '桌面端冷启动慢了 0.8 秒', 6),
  ]
}
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const rootMsgs = [
  { id: 'u1', role: 'user', timestamp: T, content: 'Amadeus 想支持离线编辑,同步怎么做?' },
  { id: 'a1', role: 'model', timestamp: T + 60_000,
    tool_calls: [call('s0', 'start_session', { title: 'obsidian', message: 'brief' })],
    tool_results: [{ tool_call_id: 's0', name: 'start_session', content: `Started child session "obsidian" (id ${K}). It is working on its own.`, isError: false }],
    content: '三条路线,从改动最小到最大:\n\n1. 文件级离线 + 三方合并\n2. 操作日志重放\n3. CRDT' },
  { id: 'u2', role: 'user', timestamp: T + 2 * 60_000, content: '第一条要改哪些模块?' },
  { id: 'a2', role: 'model', timestamp: T + 3 * 60_000, content: '合不上的时候,顶上出一条横幅,两份都留。' },
]
const branchMsgs = [
  { id: 'b-u1', role: 'user', timestamp: T, content: rootMsgs[0].content },
  { id: 'b-a1', role: 'model', timestamp: T + 60_000, content: rootMsgs[1].content },
  { id: 'c1', role: 'user', timestamp: T + 5 * 60_000, content: '如果用 CRDT 呢?' },
  { id: 'c2', role: 'model', timestamp: T + 6 * 60_000, content: 'Yjs 合适;代价是包大一圈,老笔记要迁一次。' },
]
const sse = (events) => ({ __buffer: Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), contentType: 'text/event-stream' })

async function main() {
  const r = makeReporter()
  const dir = shotDir('branch-anchors')
  let projectDir = ''
  const extra = []
  let saved = [{ id: 'x1', message_id: 'a1', turns: [{ question: 'Yjs 是什么?', answer: '一个 CRDT 库,浏览器和 Node 都能跑。' }], created_at: '', updated_at: '' }]
  const asks = []
  const deletes = []
  const branches = []
  const ctx = await launch({
    tag: 'branch-anchors',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method, body }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: sessions(projectDir, extra) }
      let m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: m[1] === R ? rootMsgs : m[1] === B1 ? branchMsgs : [] }
      m = /^\/agent\/sessions\/([^/]+)\/asides$/.exec(p)
      if (m && method === 'GET') return { asides: m[1] === R ? saved : [] }
      m = /^\/agent\/sessions\/([^/]+)\/asides\/([^/]+)$/.exec(p)
      if (m && method === 'DELETE') { deletes.push(m[2]); saved = saved.filter((a) => a.id !== m[2]); return { ok: true } }
      m = /^\/agent\/sessions\/([^/]+)\/aside$/.exec(p)
      if (m && method === 'POST') {
        const b = await body()
        asks.push({ sessionId: m[1], ...b })
        const id = b.aside_id || `x${asks.length + 1}`
        const at = b.message_id || 'a2'
        const turn = { question: b.question, answer: `答:${b.question}` }
        const hit = saved.find((a) => a.id === id)
        if (hit) hit.turns.push(turn); else saved.push({ id, message_id: at, turns: [...(b.thread || []), turn], created_at: '', updated_at: '' })
        return sse([{ type: 'delta', text: turn.answer }, { type: 'done', content: turn.answer, asideId: id, asideMessageId: at }])
      }
      m = /^\/agent\/sessions\/([^/]+)\/branch$/.exec(p)
      if (m && method === 'POST') {
        const b = await body()
        branches.push({ from: m[1], ...b })
        const s = { ...sessions(projectDir, [])[1], id: NEWB, title: b.title || 'New Chat', fork_message_id: b.message_id, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19), busy: false }
        extra.push(s)
        return { session: s, copied: 4 }
      }
      m = /^\/agent\/sessions\/([^/]+)\/detail$/.exec(p)
      if (m) { const s = sessions(projectDir, extra).find((x) => x.id === m[1]); if (s) return { session: { ...s, kind: 'user', delegate_running: false } } }
      return undefined
    },
  })
  projectDir = ctx.projectDir
  const { win } = ctx
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1440, height: 900 })
    if (process.env.LANG_EN) await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    if (process.env.DARK) await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') })
    const row = (id) => win.locator(`.t2s-srow[data-sel-id="${id}"]`).first()
    await row(R).waitFor({ timeout: 20_000 })

    // ── 左栏:分支和子会话都挂在主线下,分支的图标是分支 ──
    const tree = await win.evaluate(({ R, B1, B2, K }) => {
      const ids = [...document.querySelectorAll('.t2s-srow[data-sel-id]')].filter((e) => e.offsetParent).map((e) => e.dataset.selId)
      const q = (id) => document.querySelector(`.t2s-srow[data-sel-id="${id}"]`)
      return {
        nested: [B1, B2, K].every((id) => ids.indexOf(id) > ids.indexOf(R) && q(id)?.className.includes('t2s-kid')),
        branchIcon: !!q(B1)?.querySelector('.t2s-lead .lucide-git-branch'), childIcon: !q(K)?.querySelector('.t2s-lead .lucide-git-branch'),
      }
    }, { R, B1, B2, K })
    r.check('L1 分支和子会话都挂在主线下(一层)', tree.nested, '')
    r.check('L2 分支行的图标是分支,子会话不是', tree.branchIcon && tree.childIcon, JSON.stringify(tree))

    // ── 对话里:a1 下面一块「从这里分出 4」 ──
    await row(R).click()
    const block = win.locator('#tocmsg-a1 .t2-childs')
    await block.waitFor({ timeout: 15_000 })
    await win.locator('#tocmsg-a1 .t2-child-row[data-aside="x1"]').waitFor({ timeout: 10_000 })
    const b = await win.evaluate(({ B2 }) => {
      const el = document.querySelector('#tocmsg-a1 .t2-childs')
      const rows = [...el.querySelectorAll('.t2-child-row')]
      return {
        n: el.dataset.forks, head: el.querySelector('.t2-childs-head')?.textContent || '',
        order: rows.map((x) => x.dataset.branchSession || (x.dataset.aside ? 'aside' : x.dataset.childSession)),
        busy: el.querySelector(`[data-branch-session="${B2}"]`)?.dataset.status,
        a2Block: !!document.querySelector('#tocmsg-a2 .t2-childs'),
        verbs: [...document.querySelectorAll('#tocmsg-a2 .t2-actions [data-testid]')].map((x) => x.dataset.testid),
      }
    }, { B2 })
    r.check('F1 块头「从这里分出 4」,顺序:分支 / 分支 / 顺便问 / 子会话', b.n === '4' && /4/.test(b.head) && JSON.stringify(b.order) === JSON.stringify([B1, B2, 'aside', K]), JSON.stringify(b))
    r.check('F2 在跑的分支那行标在跑', b.busy === 'run', String(b.busy))
    r.check('F3 没东西分出去的回答下面不画块', !b.a2Block, '')
    r.check('V1 操作条两个动词:接着问 / 顺便问', b.verbs.includes('msg-branch') && b.verbs.includes('msg-aside') && !b.verbs.includes('msg-bring-back'), JSON.stringify(b.verbs))
    await block.screenshot({ path: path.join(dir, 'fork-block.png') })

    // ── 点存下来的顺便问:右边面板载回往返,续写带 aside_id ──
    const windowsBefore = ctx.app.windows().length
    await win.locator('#tocmsg-a1 .t2-child-row[data-aside="x1"]').click()
    const panel = win.locator('[data-aside-panel] .btw-panel')
    await panel.waitFor({ timeout: 10_000 })
    r.check('A1 顺便问开在右边那块面板,不新开窗,存下来的那一问载回来了', ctx.app.windows().length === windowsBefore && (await panel.locator('.btw-turn').count()) === 1 && (await panel.locator('.btw-turn-q').first().textContent()).includes('Yjs'), '')
    const box = panel.locator('.btw-input textarea')
    await box.fill('包有多大?')
    await box.press('Enter')
    await panel.locator('.btw-turn').nth(1).locator('.btw-turn-a').waitFor({ timeout: 10_000 })
    r.check('A2 续写带上记录 id 和挂点,往返带上前一问', asks[0]?.aside_id === 'x1' && asks[0]?.message_id === 'a1' && asks[0]?.thread?.length === 1, JSON.stringify(asks[0]))
    r.check('A3 主对话没有起 run', ctx.stub.seen.runs.length === 0, '')
    await win.screenshot({ path: path.join(dir, 'aside-panel.png') })

    // ── 从另一条回答「顺便问」:另起一段,挂在那条上 ──
    await win.locator('#tocmsg-a2').hover()
    await win.locator('#tocmsg-a2 [data-testid="msg-aside"]').click()
    await win.waitForFunction(() => document.querySelectorAll('[data-aside-panel] .btw-turn').length === 0, null, { timeout: 5_000 })
    await box.fill('横幅放哪?')
    await box.press('Enter')
    await panel.locator('.btw-turn-a').first().waitFor({ timeout: 10_000 })
    r.check('A4 换了挂点另起一段:带 message_id=a2、不带旧记录 id', asks[1]?.message_id === 'a2' && !asks[1]?.aside_id && asks[1]?.thread?.length === 0, JSON.stringify(asks[1]))
    await win.locator('#tocmsg-a2 .t2-child-row[data-aside]').waitFor({ timeout: 10_000 })
    r.check('A5 答完 a2 下面出现「从这里分出」里的顺便问那行', (await win.locator('#tocmsg-a2 .t2-child-row[data-aside]').count()) === 1, '')
    await panel.locator('.btw-bar .icon-btn').click()
    await win.waitForFunction(() => !document.querySelector('#tocmsg-a2 .t2-child-row[data-aside]'), null, { timeout: 5_000 }).catch(() => {})
    r.check('A6 清空 = 删掉这条记录,那一行跟着没了', deletes.length === 1 && deletes[0] === 'x3' && !(await win.locator('#tocmsg-a2 .t2-child-row[data-aside]').count()), JSON.stringify(deletes))
    await win.locator('[data-aside-panel] .agent-desk-head .icon-btn').click()

    // ── 点分支那行:主区就地换成那一支,顶上「从 X 分出」 ──
    await win.locator(`#tocmsg-a1 .t2-child-row[data-branch-session="${B1}"]`).click()
    await win.locator(`.t2s-srow.active[data-sel-id="${B1}"]`).waitFor({ timeout: 10_000 })
    const from = win.locator(`[data-branch-from="${R}"]`)
    await from.waitFor({ timeout: 10_000 })
    r.check('B1 点分支 = 主区换成那一支,顶上写从主线分出', (await from.textContent()).includes('Amadeus 离线同步怎么做'), await from.textContent())
    r.check('B2 分支顶上不写「简报」(那是子会话的)', !(await from.textContent()).includes('简报'), '')
    const bring = win.locator('#tocmsg-c2 [data-testid="msg-bring-back"]')
    r.check('B3 「带回这里」只在分支最后一条回答上', (await bring.count()) === 1 && (await win.locator('#tocmsg-b-a1 [data-testid="msg-bring-back"]').count()) === 0, '')
    await win.screenshot({ path: path.join(dir, 'branch-view.png') })
    await win.locator('#tocmsg-c2').hover()
    await bring.click()
    await win.locator(`.t2s-srow.active[data-sel-id="${R}"]`).waitFor({ timeout: 10_000 })
    await win.locator('.t2c-quote-text', { hasText: 'Yjs 合适' }).first().waitFor({ timeout: 10_000 })
    r.check('B4 带回 = 回到主线,输入框挂上那条回答的引用,没有自己发出去', ctx.stub.seen.runs.length === 0, '')
    await win.screenshot({ path: path.join(dir, 'brought-back.png') })

    // ── 接着问:不带标题 ──
    await win.locator('#tocmsg-a2').hover()
    await win.locator('#tocmsg-a2 [data-testid="msg-branch"]').click()
    await win.locator(`.t2s-srow.active[data-sel-id="${NEWB}"]`).waitFor({ timeout: 10_000 })
    r.check('C1 「接着问」从 a2 分出、不带标题(引擎记 New Chat 等第一句起名)', branches[0]?.from === R && branches[0]?.message_id === 'a2' && !branches[0]?.title, JSON.stringify(branches[0]))
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
