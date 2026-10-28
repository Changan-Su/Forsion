/**
 * 编辑重发 / 重新生成留旧版本(方案 docs/ToBeImproved/编辑重发分支与编辑框方案_2026-10-28 ①)的真 Electron 台架:
 * 桩引擎记下 UI 发来的「分支 / 删消息 / 起 run」,并像真引擎一样维护主会话的消息(删掉的不再回、新跑的那轮补上)。
 * 断言:点「重新生成」= 先复制整份成一支(复制到最后一条、分叉点在上一条回答、标题「旧版本 · 原标题」),再删、再重发;
 * 主区还是主会话,左栏多一行旧版本;对话页上一条回答下「从这里分出」列它;画布里新的一轮和旧的一支是同一张卡下的两个孩子。
 * 再「编辑重发」一次:又多一支,三个孩子。
 * 量的是 out/ 产物:改了源码先 `npm run build`。
 *   node ../.claude/hooks/devlock.cjs run --vehicle=e2e --what="编辑留分支台架" --eta=2 -- node scripts/edit-keeps-branch.e2e.cjs
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir } = require('./lib/uiux-electron.cjs')

const R = '8e1e0a52-0000-4000-8000-0000000000a1'
const TITLE = 'Amadeus 离线同步怎么做'
const T = Date.now() - 60 * 60_000
const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
const base = { summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: null, project_name: null, projectless: true }
const msg = (id, role, mins, content) => ({ id, role, timestamp: T + mins * 60_000, content })

async function main() {
  const r = makeReporter()
  const dir = shotDir('edit-keeps-branch')
  const seed = [
    msg('u1', 'user', 0, 'Amadeus 想做离线同步:两台设备离线时都改了同一篇笔记,回来怎么合?'),
    msg('a1', 'model', 1, '三条路线:按行三方合并、CRDT、后写的赢。建议走 1。'),
    msg('u2', 'user', 2, '按行三方合并展开说,要改哪些模块?'),
    msg('a2', 'model', 3, '五块:同步基线、对账器、合并器、冲突提示、测试。'),
  ]
  // 主会话的消息 = 起始几条 + 每次 run 的问答(桩引擎 seen.runs 里有原话),去掉删过的 —— 同真引擎
  const deleted = new Set()
  const replyOf = (id) => `新的回答 ${id}`
  const rMsgsNow = () => [...seed, ...ctx.stub.seen.runs.flatMap((x, i) => [msg(`u-${x.runId}`, 'user', 30 + 2 * i, x.message), msg(`a-${x.runId}`, 'model', 31 + 2 * i, replyOf(x.runId))])].filter((x) => !deleted.has(x.id))
  const sessions = [{ ...base, id: R, title: TITLE, created_at: at(70), updated_at: at(1) }]
  const branchMsgs = {}
  const log = [] // 「分支 / 删 / 起 run」的先后
  const branchBodies = []
  let ctx = null
  ctx = await launch({
    tag: 'edit-keeps-branch',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method, body }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions }
      let m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: m[1] === R ? rMsgsNow() : branchMsgs[m[1]] || [] }
      m = /^\/agent\/sessions\/([^/]+)\/branch$/.exec(p)
      if (m && method === 'POST') {
        const b = await body()
        log.push('branch'); branchBodies.push(b)
        const all = rMsgsNow(), i = all.findIndex((x) => x.id === b.message_id)
        const id = `8e1e0a52-0000-4000-8000-0000000000b${branchBodies.length}`
        branchMsgs[id] = all.slice(0, i + 1).map((x) => ({ ...x, id: `${id.slice(-2)}-${x.id}` }))
        const s = { ...base, id, title: b.title || 'New Chat', created_at: at(0), updated_at: at(0), parent_session_id: R, fork_message_id: b.fork_message_id || b.message_id, fork_session_id: R, kind: 'user' }
        sessions.push(s)
        return { session: s, copied: i + 1 }
      }
      if (p === `/agent/sessions/${R}/messages/delete` && method === 'POST') {
        const b = await body()
        log.push('delete')
        for (const x of b.ids || []) deleted.add(x)
        return { ok: true, deleted: (b.ids || []).length }
      }
      if (p === '/agent/runs' && method === 'POST') {
        // 不读请求体(读了桩引擎就读不到了):只排剧本,run 由桩引擎记进 seen.runs(id 同它的算法)
        log.push('run')
        const reply = replyOf(`r${ctx.stub.seen.runs.length + 1}`)
        ctx.stub.script([{ type: 'token', payload: { text: reply } }, { type: 'done', payload: { content: reply } }])
        return undefined
      }
      m = /^\/agent\/sessions\/([^/]+)\/asides$/.exec(p)
      if (m && method === 'GET') return { asides: [] }
      m = /^\/agent\/sessions\/([^/]+)\/detail$/.exec(p)
      if (m) { const s = sessions.find((x) => x.id === m[1]); if (s) return { session: { ...s, kind: 'user', delegate_running: false } } }
      return undefined
    },
  })
  const { win } = ctx
  win.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  const active = () => win.evaluate(() => document.querySelector('.t2-chat-view')?.dataset.sessionId)
  const hoverClick = async (sel, title) => {
    await win.locator(sel).first().scrollIntoViewIfNeeded()
    const b = await win.locator(sel).first().boundingBox()
    await win.mouse.move(b.x + b.width / 2, b.y + Math.min(20, b.height / 2))
    await win.waitForTimeout(300)
    await win.locator(`${sel} .t2-iconbtn[title="${title}"]`).first().click()
  }
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.evaluate(() => localStorage.setItem('tangu.chatCanvas.hintsSeen', '3'))
    await enterSpace(win, 'tangu')
    const row = (id) => win.locator(`.t2s-srow[data-sel-id="${id}"]`).first()
    await row(R).waitFor({ timeout: 20_000 })
    await row(R).click()
    await win.locator('#tocmsg-a2').waitFor({ timeout: 15_000 })

    // ── 重新生成 a2 ──
    await hoverClick('#tocmsg-a2', '重新生成')
    await win.getByText('新的回答 r1').first().waitFor({ timeout: 15_000 })
    await win.waitForTimeout(800)
    const b1 = branchBodies[0] || {}
    r.check('EB1 重新生成:先复制整份成一支(复制到最后一条 a2、分叉点在上一条回答 a1、标题「旧版本 · 原标题」)', b1.message_id === 'a2' && b1.fork_message_id === 'a1' && b1.title === `旧版本 · ${TITLE}`, JSON.stringify(b1))
    r.check('EB2 顺序:分支 → 删 → 重发', log.slice(0, 3).join(',') === 'branch,delete,run', log.join(','))
    const V1 = sessions[1]?.id
    const a1now = await active()
    await win.evaluate((R) => document.querySelector(`.t2s-srow[data-sel-id="${R}"] [aria-expanded="false"]`)?.click(), R)
    await win.waitForTimeout(300)
    const side = await win.evaluate((V1) => document.querySelector(`.t2s-srow[data-sel-id="${V1}"]`)?.textContent || '', V1)
    r.check('EB3 主区还是主会话;左栏主会话下多一行旧版本', a1now === R && side.includes('旧版本'), JSON.stringify({ a1now, side }))
    await win.evaluate(() => document.querySelector('#tocmsg-a1')?.scrollIntoView({ block: 'start' }))
    await win.waitForTimeout(500)
    const fork = await win.evaluate(() => [...document.querySelectorAll('#tocmsg-a1 .t2-childs .t2-child-row, #tocmsg-a1 .t2-childs [data-branch]')].map((e) => e.textContent).join('|'))
    r.check('EB4 对话页:上一条回答下「从这里分出」列着旧版本那支', /旧版本/.test(fork), fork.slice(0, 120))
    await win.screenshot({ path: path.join(dir, 'chat.png') })

    // ── 编辑重发新的那句 ──
    await hoverClick('#tocmsg-u-r1', '编辑')
    const ta = win.locator('.t2-edit textarea').first()
    await ta.waitFor({ timeout: 5_000 })
    await ta.fill('只列第一版必须做的模块')
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await win.getByText('新的回答 r2').first().waitFor({ timeout: 15_000 })
    await win.waitForTimeout(800)
    const b2 = branchBodies[1] || {}
    r.check('EB5 编辑重发:又留一支(复制到 a-r1、分叉点仍在 a1)', b2.message_id === 'a-r1' && b2.fork_message_id === 'a1', JSON.stringify(b2))

    // ── 画布:同一张卡下三个孩子 ──
    const seg = win.locator('.t2-chat-col > .lcl-viewhead [data-testid="chat-canvas-seg"]')
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 8_000 })
    await win.waitForTimeout(1500)
    const cv = await win.evaluate((R) => {
      const nodes = [...document.querySelectorAll('.t2cv-turn')].map((e) => ({ k: e.dataset.cvNode, y: parseFloat(e.style.top), x: parseFloat(e.style.left) }))
      const u1 = nodes.find((n) => n.k === `${R}:u1`)
      return { n: nodes.length, kids: nodes.filter((n) => u1 && n.y > u1.y + 10).map((n) => n.k), sameRow: new Set(nodes.filter((n) => u1 && n.y > u1.y + 10).map((n) => n.y)).size }
    }, R)
    r.check('EB6 画布:第一轮下面三个孩子同一行 —— 新主线 + 两支旧版本', cv.n === 4 && cv.kids.length === 3 && cv.sameRow === 1 && cv.kids.some((k) => k.startsWith(`${R}:`)), JSON.stringify(cv))
    await win.screenshot({ path: path.join(dir, 'canvas.png') })
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
