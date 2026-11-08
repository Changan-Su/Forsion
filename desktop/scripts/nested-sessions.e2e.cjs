/**
 * 父子会话 + 任务卡(方案 docs/ToBeImproved/子会话与任务卡方案_2026-10-17,左栏 A + 对话里 B)的真 Electron 台架:
 * 桩引擎回一份带 parent_session_id / busy / awaiting_user 的会话名册和一段「开了三个子会话 → 回来了 → 接着做 + 任务卡」的对话。
 * 断言:左栏树(子会话紧跟主会话、最后一个拐弯、个数、收起后状态冒上来)、行尾状态(在跑 / 等你 / 做完了)、对话里子会话块、
 * <child_sessions_update> 系统行、任务卡(有效期、先问卡、撤回、过期)、点「开个子会话」后卡原地变成子会话行、
 * 主区被挤窄时子会话面板不消失(720 并排 / 600 顶掉聊天列);子会话发给主会话的 <session_message> 画成系统行 + 正文(10-28)。
 * 11-08 会话互通升级(E / F 段):hand_off_task 挪出去的会话单独一块(不进三个子会话那块)、子会话 / 任务卡上的模型芯片、
 * 任务卡 model: 随「开个子会话」发给引擎、树外会话来信(relation=peer)的头行与说明;运行中发送键右键菜单(插话 / 另起话题)、
 * ⌘Enter = 另起话题、Enter = 插话 —— 反向断言 steer 请求体里的 newTopic。截图自己看。
 * 量的是 out/ 产物:改了源码先 `npx electron-vite build`。
 *   node ../.claude/hooks/devlock.cjs run --vehicle=e2e --what="父子会话台架" --eta=3 -- node scripts/nested-sessions.e2e.cjs
 *   SHOT_DIR=… 指定截图目录;LANG_EN=1 拍英文;DARK=1 拍深色
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir } = require('./lib/uiux-electron.cjs')

const P = '0b6f8c2e-1a10-4c4e-9b11-0000000000a1'
const K = ['0b6f8c2e-1a10-4c4e-9b11-0000000000c1', '0b6f8c2e-1a10-4c4e-9b11-0000000000c2', '0b6f8c2e-1a10-4c4e-9b11-0000000000c3']
const CAL = '0b6f8c2e-1a10-4c4e-9b11-0000000000b1'
const CALK = ['0b6f8c2e-1a10-4c4e-9b11-0000000000d1', '0b6f8c2e-1a10-4c4e-9b11-0000000000d2']
const NEWKID = '0b6f8c2e-1a10-4c4e-9b11-0000000000e1'
const HAND = '0b6f8c2e-1a10-4c4e-9b11-0000000000a2'
const PEER = '0b6f8c2e-1a10-4c4e-9b11-0000000000a3'
const T = Date.now() - 20 * 60_000
const OLD = Date.now() - 9 * 24 * 3600_000

function sessions(dir, withNew) {
  const base = { summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: dir, project_name: 'Forsion', projectless: false }
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = (id, title, mins, extra = {}) => ({ ...base, id, title, created_at: at(mins + 60), updated_at: at(mins), ...extra })
  return [
    row(P, '三家笔记软件的离线同步怎么做', 1),
    row(K[0], '查 Obsidian Sync 的冲突处理', 2, { parent_session_id: P, busy: true, created_at: at(19) }),
    row(K[1], '查 Notion 离线模式', 3, { parent_session_id: P, awaiting_user: true, created_at: at(18) }),
    row(K[2], '查 Logseq 的同步', 4, { parent_session_id: P, created_at: at(17) }),
    row(HAND, '写完离线同步的对比表', 5, { parent_session_id: P, busy: true, model_id: 'm2', agent_config: { handoffFrom: P }, created_at: at(16) }),
    ...(withNew ? [row(NEWKID, '写 Amadeus 离线同步的设计稿', 0, { parent_session_id: P, busy: true, created_at: at(0) })] : []),
    row('0b6f8c2e-1a10-4c4e-9b11-0000000000f1', '桌面端冷启动慢了 0.8 秒', 6, { awaiting_user: true }),
    row(CAL, '日历显示优化', 8),
    row(PEER, '发布窗口排期', 7),
    row(CALK[0], '日历标签切走再切回来跳到 8 月', 9, { parent_session_id: CAL, busy: true }),
    row(CALK[1], '待办视图单独打开也完整', 10, { parent_session_id: CAL }),
  ]
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const res = (id, name, content) => ({ tool_call_id: id, name, content, isError: false })
const UPDATE = `<child_sessions_update>\nChild sessions you started have reported back.\n<child id="${K[0]}" title="查 Obsidian Sync 的冲突处理" status="finished">\n按行三方合并\n</child>\n<child id="${K[1]}" title="查 Notion 离线模式" status="waiting_for_user">\n要按企业版文档再核一遍吗?\n</child>\n</child_sessions_update>`
const CARDS = [
  '```forsion-task\ntitle: 写 Amadeus 离线同步的设计稿\nid: design-doc\nmodel: m2\ntldr: 文件级离线 + 三方合并,合不了两份都留\n---\n给 Amadeus 写一份离线同步设计稿,放在 docs/ToBeImproved/。\n```',
  '```forsion-task\ntitle: 写冲突提示的文案(中英)\nask: true\ntldr: 和对比是两件事;新会话只带简报\n---\n写冲突提示的三句话 + 一个按钮,中英都要。\n```',
].join('\n\n')
const parentMsgs = [
  { id: 'u1', role: 'user', timestamp: T, content: '帮我查一下 Obsidian、Notion、Logseq 这三家怎么处理离线编辑和冲突,最后给我对比和建议。' },
  { id: 'a1', role: 'model', timestamp: T + 60_000,
    tool_calls: K.map((_, i) => call(`s${i}`, 'start_session', { title: `t${i}`, message: 'brief' })),
    tool_results: K.map((k, i) => res(`s${i}`, 'start_session', `Started child session "t${i}" (id ${k}). It is working on its own.`)),
    content: '三家各查各的,我分成三个子会话同时查。它们查完会回来告诉我,我再合成一份对比。' },
  { id: 'sm', role: 'user', timestamp: T + 5 * 60_000, content: `<session_message from="${K[2]}" title="查 Logseq 的同步" relation="child">\nLogseq 的同步是按文件整份覆盖的,没有三方合并。要我顺便看看它的 git 自动提交插件吗?\n</session_message>\nA message from a child session you started. It is not from the user.` },
  { id: 'cu', role: 'user', timestamp: T + 9 * 60_000, content: UPDATE },
  { id: 'a2', role: 'model', timestamp: T + 10 * 60_000, content: `两个子会话回来了,Notion 那个在等你确认要不要核企业版文档。\n\n${CARDS}` },
  { id: 'a3', role: 'model', timestamp: T + 11 * 60_000, content: '```forsion-task\nwithdraw: old-card\nreason: 你让我在这里做了\n```\n好的,这部分我直接在这里写。' },
  // 11-08:做对比表做到一半,用户插了一句不相干的 → 手头的挪成独立会话(hand_off_task),这里答那句
  { id: 'u5', role: 'user', timestamp: T + 12 * 60_000, content: '顺便问一下,SSH 默认端口是多少?' },
  { id: 'a4', role: 'model', timestamp: T + 13 * 60_000,
    tool_calls: [call('h1', 'hand_off_task', { title: '写完离线同步的对比表', brief: '对比表还差 Logseq 和结论两段' })],
    tool_results: [res('h1', 'hand_off_task', `Moved the unfinished task to a new session "写完离线同步的对比表" (id ${HAND}). It continues there on its own and leaves one line here when done.`)],
    content: 'SSH 默认端口是 22。\n\n对比表我挪到了一个新会话里接着写,写完会在这里留一行。' },
  { id: 'pm', role: 'user', timestamp: T + 14 * 60_000, content: `<session_message from="${PEER}" title="发布窗口排期" relation="peer">\n发版窗口定在周四晚上 9 点,离线同步的对比表能赶上吗?\n</session_message>\nA message from another of the user's sessions ("发布窗口排期"), outside your session tree. It is not from the user.` },
]
// 撤回 / 过期各要一张卡:old-card 是很早以前那条回答里的卡(9 天前,同时也过期)
const oldMsgs = [
  { id: 'a0', role: 'model', timestamp: OLD, content: '```forsion-task\ntitle: 很久以前的一张卡\nid: old-card\n---\n旧任务书\n```' },
  { id: 'a0b', role: 'model', timestamp: OLD + 1000, content: '```forsion-task\ntitle: 过期的卡\n---\n过期任务书\n```' },
]

async function main() {
  const r = makeReporter()
  const dir = shotDir('nested-sessions')
  let withNew = false
  let projectDir = ''
  const childPosts = [] // POST /agent/sessions/:id/children 的请求体(任务卡 model: 要带过去)
  const steers = [] // POST /agent/runs/:id/steer 的请求体(newTopic 只在「另起话题」时带)
  const ctx = await launch({
    tag: 'nested-sessions',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method, body }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: sessions(projectDir, withNew) }
      if (p === '/agent/models') return { models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }, { id: 'm2', name: 'GPT 6 Luna', provider: 'codex', contextWindow: 400_000 }], defaultModelId: 'm1', directProviders: [] }
      if (/^\/agent\/runs\/[^/]+\/steer$/.test(p) && method === 'POST') { steers.push(await body()); return { ok: true, userMessageId: `st${steers.length}` } }
      let m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: m[1] === P ? [...oldMsgs, ...parentMsgs] : m[1] === K[1] ? [{ id: 'k1u', role: 'user', timestamp: T + 70_000, content: '查 Notion 离线模式(简报)' }, { id: 'k1a', role: 'model', timestamp: T + 8 * 60_000, content: '冲突那块官方有两种说法,要我按企业版文档再核一遍吗?' }] : [] }
      m = /^\/agent\/sessions\/([^/]+)\/children$/.exec(p)
      if (m && method === 'POST') { childPosts.push(await body()); withNew = true; return { sessionId: NEWKID, runId: 'r-new', title: '写 Amadeus 离线同步的设计稿' } }
      m = /^\/agent\/sessions\/([^/]+)\/detail$/.exec(p)
      if (m) { const s = sessions(projectDir, withNew).find((x) => x.id === m[1]); if (s) return { session: { ...s, kind: 'user' } } }
      return undefined
    },
  })
  projectDir = ctx.projectDir
  const { win } = ctx
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.evaluate(({ unread, collapsed, en }) => {
      localStorage.setItem('forsion_tangu_unread_sessions', JSON.stringify(unread))
      localStorage.setItem('forsion_tangu_collapsed_parents', JSON.stringify(collapsed))
      if (en) localStorage.setItem('tangu_locale', 'en')
    }, { unread: [K[2]], collapsed: [CAL], en: !!process.env.LANG_EN })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    if (process.env.DARK) await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') })
    const row = (id) => win.locator(`.t2s-srow[data-sel-id="${id}"]`).first()
    await row(P).waitFor({ timeout: 20_000 })

    // ── 左栏树 ──
    const tree = await win.evaluate(({ P, K, CAL, CALK }) => {
      const rows = [...document.querySelectorAll('.t2s-srow[data-sel-id]')].filter((e) => e.offsetParent)
      const ids = rows.map((e) => e.dataset.selId)
      const q = (id) => document.querySelector(`.t2s-srow[data-sel-id="${id}"]`)
      const st = (id) => q(id)?.querySelector('.t2s-st')?.className.replace('t2s-st', '').trim() || ''
      let lastId = null
      for (let i = ids.indexOf(P) + 1; i < ids.length && q(ids[i])?.classList.contains('t2s-kid'); i++) lastId = ids[i]
      const after = getComputedStyle(q(lastId || K[2]), '::after')
      return {
        // 挪出去的那条(HAND)也挂在 P 下面:三个子会话按原序紧跟,中间 / 后面多它一行不算错
        order: ids.indexOf(P) >= 0 && (() => { const kids = []; for (let i = ids.indexOf(P) + 1; i < ids.length && q(ids[i])?.classList.contains('t2s-kid'); i++) kids.push(ids[i]); return K.every((k) => kids.includes(k)) && kids.filter((k) => K.includes(k)).join() === K.join() })(),
        lastKid: (() => { let last = null; for (let i = ids.indexOf(P) + 1; i < ids.length && q(ids[i])?.classList.contains('t2s-kid'); i++) last = ids[i]; return last })(),
        kidCls: K.map((k) => q(k)?.className || ''),
        parentKids: q(P)?.querySelector('.t2s-kids')?.textContent || '',
        st: { run: st(K[0]), wait: st(K[1]), done: st(K[2]), parent: st(P) },
        calHidden: CALK.every((k) => !q(k) || !q(k).offsetParent), calSt: st(CAL),
        lastElbow: after.borderBottomWidth, padKid: parseFloat(getComputedStyle(q(K[0])).paddingLeft), padParent: parseFloat(getComputedStyle(q(P)).paddingLeft),
        noCornerDot: !q(K[0]).querySelector('.t2s-lead .t2s-dot'),
      }
    }, { P, K, CAL, CALK })
    r.check('A1 子会话紧跟在主会话下面', tree.order, JSON.stringify(tree.kidCls))
    const lastCls = await row(tree.lastKid).getAttribute('class').catch(() => '')
    r.check('A2 子会话带 t2s-kid,最后一个带 last 并画拐弯', tree.kidCls.every((c) => c.includes('t2s-kid')) && /\blast\b/.test(lastCls || '') && tree.lastElbow === '1px', `${tree.lastElbow} last=${tree.lastKid}`)
    r.check('A3 子会话比主会话缩进', tree.padKid > tree.padParent + 10, `${tree.padParent} → ${tree.padKid}`)
    r.check('A4 主会话行尾有子会话个数 4(三个子会话 + 挪出去的一个)', tree.parentKids.trim() === '4', tree.parentKids)
    r.check('A5 行尾状态:在跑 / 等你 / 做完了没看', tree.st.run === 'run' && tree.st.wait === 'wait' && tree.st.done === 'done', JSON.stringify(tree.st))
    r.check('A6 状态不再贴在图标角上', tree.noCornerDot, '')
    r.check('A7 收起的主会话藏起子会话,状态冒上来(在跑)', tree.calHidden && tree.calSt === 'run', tree.calSt)

    // 点个数 → 展开日历那组
    await row(CAL).locator('.t2s-kids').click()
    await win.waitForTimeout(300)
    r.check('A8 点个数展开', await row(CALK[0]).isVisible(), '')
    await row(CAL).locator('.t2s-kids').click()

    // ── 对话 ──
    await row(P).click()
    await win.locator('#tocmsg-a1 .t2-childs').waitFor({ timeout: 15_000 })
    const chat = await win.evaluate(() => {
      const block = document.querySelector('#tocmsg-a1 .t2-childs')
      return {
        rows: block ? [...block.querySelectorAll('.t2-child-row')].map((e) => e.dataset.status) : [],
        waitActions: !!block?.querySelector('.t2-child-row[data-status="wait"] .t2-child-actions'),
        head: block?.querySelector('.t2-childs-head')?.textContent || '',
        update: document.querySelector('.t2-child-update')?.textContent || '',
        updateBubble: !!document.querySelector('#tocmsg-cu .t2-user, #tocmsg-cu .t2-bubble'),
        sessMsg: document.querySelector('[data-session-message]')?.textContent || '',
        sessMsgBubble: !!document.querySelector('#tocmsg-sm'),
        sessMsgLeak: (document.querySelector('[data-session-message]')?.parentElement?.textContent || '').includes('session_message'),
        cards: [...document.querySelectorAll('#tocmsg-a2 .t2-taskcard')].map((e) => e.dataset.taskState),
        valid: !!document.querySelector('#tocmsg-a2 .t2-taskcard-expire'),
        askNote: !!document.querySelector('#tocmsg-a2 .t2-taskcard-note'),
        old: [...document.querySelectorAll('#tocmsg-a0 .t2-taskcard, #tocmsg-a0b .t2-taskcard')].map((e) => e.dataset.taskState + ':' + (e.querySelector('.t2-taskcard-done')?.textContent || '')),
        withdrawFenceHidden: !document.querySelector('#tocmsg-a3 pre') && !(document.querySelector('#tocmsg-a3')?.textContent || '').includes('withdraw:'),
      }
    })
    r.check('B1 开出子会话那条回答下面一块,三行:在跑 / 等你 / 做完了', JSON.stringify(chat.rows) === '["run","wait","done"]', JSON.stringify(chat.rows))
    r.check('B2 等你的那行带「去回复 / 让 Tangu 回答」', chat.waitActions, '')
    r.check('B3 块头写着 1 个在等你', /1/.test(chat.head), chat.head)
    r.check('B4 <child_sessions_update> 画成系统行,不是用户气泡', !!chat.update && !chat.updateBubble, chat.update)
    r.check('B5 <session_message> 画成系统行(谁发的 + 正文),不是用户气泡、不露标签', /查 Logseq 的同步/.test(chat.sessMsg) && /三方合并/.test(chat.sessMsg) && !chat.sessMsgBubble && !chat.sessMsgLeak, chat.sessMsg)
    r.check('C1 任务卡:普通卡带「7 天内有效」,先问卡带说明', chat.valid && chat.askNote && JSON.stringify(chat.cards) === '["open","ask"]', JSON.stringify(chat.cards))
    r.check('C2 撤回的卡写「已撤回 · 理由」,过期的卡写「已过期」', /withdrawn:.*你让我在这里做了/.test(chat.old[0] || '') && /^expired:/.test(chat.old[1] || ''), JSON.stringify(chat.old))
    r.check('C3 撤回围栏本身不出现在正文里', chat.withdrawFenceHidden, '')
    // ── E:挪出去 / 树外来信 / 模型芯片(11-08 会话互通升级)──
    await win.locator('#tocmsg-a4 .t2-handoff').waitFor({ timeout: 10_000 }).catch(() => {})
    const e = await win.evaluate(({ HAND, PEER, K }) => {
      const hb = document.querySelector('#tocmsg-a4 .t2-handoff')
      const sm = document.querySelector(`[data-session-message="${PEER}"]`)
      const kidSm = document.querySelector(`[data-session-message="${K[2]}"]`)
      return {
        handRows: hb ? [...hb.querySelectorAll('.t2-child-row')].map((x) => x.dataset.childSession) : [],
        handHead: hb?.querySelector('.t2-childs-head')?.textContent || '',
        handElsewhere: document.querySelectorAll(`.t2-child-row[data-child-session="${HAND}"]`).length,
        chip: hb?.querySelector('.t2-model-chip')?.textContent || '',
        chipModel: hb?.querySelector('.t2-model-chip')?.dataset.model || '',
        kidChips: document.querySelectorAll('#tocmsg-a1 .t2-model-chip').length,
        tool: document.querySelector('#tocmsg-a4')?.textContent || '',
        peerHead: sm?.querySelector('.t2-session-msg-head')?.textContent || '',
        peerNote: sm?.querySelector('.t2-session-msg-note')?.textContent || '',
        peerRel: sm?.dataset.relation || '',
        kidNote: !!kidSm?.querySelector('.t2-session-msg-note'),
        // 任务卡 10-23 起挪进输入框上方的托盘(一次一张),不在那条回答里 → 整页找
        cardChip: document.querySelector('.t2-taskcard .t2-model-chip')?.textContent || '',
      }
    }, { HAND, PEER, K })
    r.check('E1 挪出去的会话在那条回答下面单独一块,不进三个子会话那块', JSON.stringify(e.handRows) === JSON.stringify([HAND]) && e.handElsewhere === 1 && /挪到了这里/.test(e.handHead), `${e.handHead} ${JSON.stringify(e.handRows)} ×${e.handElsewhere}`)
    r.check('E2 挪出去的会话换了模型 → 行上有模型芯片(显示名);跟主会话同模型的子会话没有', e.chipModel === 'm2' && /GPT 6 Luna/.test(e.chip) && e.kidChips === 0, `${e.chip} / kids ${e.kidChips}`)
    r.check('E3 hand_off_task 的过程行有说法', /把手头的活挪到了子会话|挪到子会话/.test(e.tool), '')
    r.check('E4 树外会话来信:头行写「另一个会话「…」」+ 一行说明;同树的来信没有说明', e.peerRel === 'peer' && /另一个会话「发布窗口排期」/.test(e.peerHead) && /不是你说的/.test(e.peerNote) && !e.kidNote, `${e.peerHead} | ${e.peerNote}`)
    r.check('E5 任务卡写了 model: → 卡上有模型芯片', /GPT 6 Luna/.test(e.cardChip), e.cardChip)
    await win.locator('#tocmsg-a4').scrollIntoViewIfNeeded()
    await win.screenshot({ path: path.join(dir, 'handoff.png') })
    await win.locator(`[data-session-message="${PEER}"]`).scrollIntoViewIfNeeded()
    await win.screenshot({ path: path.join(dir, 'peer-message.png') })
    await win.mouse.move(1400, 880) // 别悬停在会话行上(悬停时图标换成开合箭头)
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(dir, 'sidebar.png'), clip: { x: 40, y: 110, width: 270, height: 260 } })
    await win.locator('#tocmsg-a1 .t2-childs').scrollIntoViewIfNeeded()
    await win.screenshot({ path: path.join(dir, 'chat-block.png') })
    await win.locator(`[data-session-message="${K[2]}"]`).scrollIntoViewIfNeeded()
    await win.screenshot({ path: path.join(dir, 'session-message.png') })
    await win.locator('#tocmsg-a2 .t2-tasks').scrollIntoViewIfNeeded()
    await win.screenshot({ path: path.join(dir, 'cards.png') })

    // 点「开个子会话」→ 卡原地变成子会话行
    // 点不到也别中断整轮:下面 C4 照样记红,D 段(子会话面板)继续跑
    // 10-23 起卡在托盘里:回答里那张找不到就点托盘里的(C4/C5 的断言仍按旧位置写,10-28 记过「台架没跟上」)
    const inMsg = win.locator('#tocmsg-a2 .t2-taskcard[data-task-state="open"] .t2-taskcard-actions button.primary')
    await ((await inMsg.count()) ? inMsg : win.locator('.t2-taskcard[data-task-state="open"] .t2-taskcard-actions button.primary').first()).click({ timeout: 10_000 }).catch(() => {})
    await win.locator(`#tocmsg-a2 .t2-tasks .t2-childs .t2-child-row[data-child-session="${NEWKID}"]`).waitFor({ timeout: 10_000 }).catch(() => {})
    r.check('C4 点「开个子会话」后卡原地变成子会话行', await win.locator(`#tocmsg-a2 .t2-child-row[data-child-session="${NEWKID}"]`).count() === 1, '')
    r.check('C5 新开的子会话进了左栏、挂在主会话下面', await row(NEWKID).evaluate((e) => e.classList.contains('t2s-kid')).catch(() => false), '')
    await win.screenshot({ path: path.join(dir, 'card-started.png') })
    r.check('C6 任务卡的 model: 随「开个子会话」发给引擎', childPosts.some((b) => b && b.model === 'm2'), JSON.stringify(childPosts.map((b) => b && b.model)))

    // ── F:运行中发送键 —— 右键 / 长按出「插话 / 另起话题」,⌘Enter = 另起话题,Enter = 插话(11-08)──
    ctx.stub.script([{ type: '__hold' }])
    const ta = win.locator('.t2c-ta').first()
    const sendKey = win.locator('button.t2c-send[aria-haspopup="menu"]').first() // 侧栏「…」等也带 aria-haspopup,只认输入框的发送键
    const type = async (text) => { await ta.click(); await ta.fill(text); await win.waitForTimeout(200) }
    await type('把三家的对比表写完')
    await win.keyboard.press('Enter')
    await win.locator('.t2c-stop').first().waitFor({ timeout: 10_000 }).catch(() => {})
    const runId = ctx.stub.seen.runs.at(-1)?.runId
    console.log(`[F] runs=${JSON.stringify(ctx.stub.seen.runs.map((x) => [x.runId, x.sessionId, String(x.message).slice(0, 20)]))} stop=${await win.locator('.t2c-stop').count()} ta=${await ta.count()}`)
    await win.screenshot({ path: path.join(dir, 'f-running.png') })
    await type('SSH 默认端口是多少?')
    await sendKey.waitFor({ timeout: 5000 }).catch(() => {})
    await sendKey.click({ button: 'right' }).catch(() => {})
    const menu = win.locator('.t2c-send-menu')
    await menu.waitFor({ timeout: 5000 }).catch(() => {})
    const items = await menu.locator('[role="menuitem"], button, .ctx-item').allTextContents().catch(() => [])
    r.check('F1 运行中右键发送键 → 菜单两项:插话 / 另起话题(各带一行说明)', /插话/.test(items.join('|')) && /另起话题/.test(items.join('|')) && /挪到子会话/.test(items.join('|')), items.join(' | ').slice(0, 160))
    const mb = await menu.boundingBox().catch(() => null)
    const kb = await sendKey.boundingBox().catch(() => null)
    r.check('F2 菜单往上开、不盖住发送键', !!mb && !!kb && mb.y + mb.height <= kb.y + 1, JSON.stringify({ mb, kb }))
    if (mb) await win.screenshot({ path: path.join(dir, 'send-menu.png'), clip: { x: Math.max(0, mb.x - 420), y: Math.max(0, mb.y - 20), width: Math.min(1440, mb.width + 480), height: Math.min(900 - Math.max(0, mb.y - 20), (kb ? kb.y + kb.height : mb.y + mb.height) - mb.y + 60) } })
    await menu.getByText('另起话题', { exact: true }).click().catch(() => {})
    await win.waitForTimeout(800)
    r.check('F3 点「另起话题」→ steer 请求带 newTopic', steers.length === 1 && steers[0].newTopic === true && steers[0].message === 'SSH 默认端口是多少?', JSON.stringify(steers))
    await type('顺便把 README 的错字改了')
    await win.keyboard.press('Meta+Enter')
    await win.waitForTimeout(800)
    r.check('F4 运行中 ⌘Enter → 另起话题', steers.length === 2 && steers[1].newTopic === true, JSON.stringify(steers[1] || null))
    await type('对比表加一列价格')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(800)
    r.check('F5 运行中 Enter → 普通插话(不带 newTopic)', steers.length === 3 && !('newTopic' in (steers[2] || {})), JSON.stringify(steers[2] || null))
    // 长按 ≥500ms 出菜单,松手后那一下 click 不能顺手发出去
    await type('长按试试')
    const kb2 = await sendKey.boundingBox().catch(() => null)
    if (kb2) {
      await win.mouse.move(kb2.x + kb2.width / 2, kb2.y + kb2.height / 2)
      await win.mouse.down(); await win.waitForTimeout(700); await win.mouse.up()
    }
    await win.waitForTimeout(500)
    r.check('F6 长按出菜单,松手不顺手发出去', (await menu.count()) === 1 && steers.length === 3, `menu=${await menu.count()} steers=${steers.length}`)
    await win.keyboard.press('Escape')
    await ta.fill('')
    if (runId) ctx.stub.finish(runId)
    await win.waitForTimeout(800)

    // 点子会话行 → 右侧子会话面板,顶上「来自 主会话」
    await win.locator(`#tocmsg-a1 .t2-child-row[data-child-session="${K[1]}"]`).click()
    await win.locator('.child-chat-panel .t2-child-from').waitFor({ timeout: 15_000 }).catch(() => {})
    r.check('D1 子会话面板顶上写着来自主会话', await win.locator('.child-chat-panel .t2-child-from').count() === 1, '')
    await win.screenshot({ path: path.join(dir, 'child-panel.png') })
    // 主区被右栏挤窄(10-26 录屏):<760 时 Desk 规则曾把子会话面板一起藏掉,≤700 又藏了聊天列 → 整块空白
    const narrow = async (w) => win.evaluate((w) => {
      const v = document.querySelector('.t2-chat-view:has(> .child-chat-panel)')
      v.style.flex = 'none'; v.style.width = `${w}px`
      const vis = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 50
      return { col: vis(v.querySelector(':scope > .t2-chat-col')), panel: vis(v.querySelector(':scope > .child-chat-panel')) }
    }, w)
    await narrow(720); await win.waitForTimeout(600) // 等 flex-basis 过渡走完再量
    const n720 = await narrow(720)
    r.check('D2 主区 720px:聊天列和子会话面板都在', n720.col && n720.panel, JSON.stringify(n720))
    await narrow(600); await win.waitForTimeout(600)
    const n600 = await narrow(600)
    r.check('D3 主区 600px:子会话面板顶掉聊天列,不是整块空白', !n600.col && n600.panel, JSON.stringify(n600))
    await win.evaluate(() => { const v = document.querySelector('.t2-chat-view:has(> .child-chat-panel)'); v.style.flex = ''; v.style.width = '' })
    const panel = await win.locator('.child-chat-panel').boundingBox()
    if (panel) await win.screenshot({ path: path.join(dir, 'child-panel-zoom.png'), clip: { x: panel.x, y: panel.y, width: panel.width, height: Math.min(panel.height, 560) } })
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
