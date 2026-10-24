/**
 * Chat 画布(方案 docs/ToBeImproved/Chat画布分支方案_2026-10-18 第二步)的真 Electron 台架:
 * 桩引擎回一棵会话树(主线三轮 + 从第一轮分出的两支,分支开头是复制出来的新 id、时间戳和主线对不上)。
 * 断言:对话列头行的「对话 / 画布」胶囊;一轮一个格子(提问卡 + 回答卡)、复制段不重画;竖排(子卡在下、兄弟并排)/ 横排(子卡在右、兄弟上下叠);
 * 卡里是全文、超长的只露预览、「阅读」在右边开全文;「只看这一支」(旁支淡、点了切过去);自动跟随(卡底停在输入框上方)、滚走停跟出箭头、
 * 点箭头飞回并恢复跟随;双击 = 右边阅读栏、卡让开它(方案 Chat画布第三轮);胶囊切回对话只有一份正文;偏好按树根记;
 * ⊕:回答卡下 = 草稿提问卡(卡里写、Enter 建分支并发进去)/ 末尾那张 = 聚焦输入框,提问卡左右 = 换个问法。最后拍亮 / 暗 / 柔青三张,自己看。
 * 阅读栏 A(画布交互统一方案_2026-10-24 read.html):卡框长出、顶上轮次直接跳、底下一排操作、换轮滑入、关掉淡出、「在对话里打开」;
 * 空白处右键按住拖 = 平移(握紧的抓手),没拖才弹菜单。
 * 第一轮(画布交互统一方案 index.html):卡里 / 阅读栏里划线出划线菜单、顺便问挂到那张卡那一支、挪镜头收起;卡底「从这里分出」只列顺便问;
 * 胶囊 − % + ⤢ 视图 ?、说明只出前 3 次、缩略图缺省关;对话 ↔ 画布镜头拉远 / 推回;空格 / 中键拖平移、⌘0 ⌘− ⇧1、Esc 先退抓手。
 * 量的是 out/ 产物:改了源码先 `npm run build`。
 *   node ../.claude/hooks/devlock.cjs run --vehicle=e2e --what="Chat 画布台架" --eta=4 -- node scripts/chat-canvas.e2e.cjs
 *   SHOT_DIR=… 指定截图目录;LANG_EN=1 拍英文
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir } = require('./lib/uiux-electron.cjs')

const R = '5c1e0a52-0000-4000-8000-0000000000a1'
const B1 = '5c1e0a52-0000-4000-8000-0000000000b1'
const B2 = '5c1e0a52-0000-4000-8000-0000000000b2'
const K = '5c1e0a52-0000-4000-8000-0000000000c1'
const F1 = '5c1e0a52-0000-4000-8000-0000000000f1'
const B3 = '5c1e0a52-0000-4000-8000-0000000000b3' // 草稿提问卡发出去时建的分支
const T = Date.now() - 60 * 60_000
const LONG = Array.from({ length: 70 }, (_, i) => `${i + 1}. 第 ${i + 1} 处要改的地方:同步基线、对账器、合并器之一。`).join('\n')

function sessions(dir) {
  const base = { summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: dir, project_name: 'Forsion', projectless: false }
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = (id, title, mins, more = {}) => ({ ...base, id, title, created_at: at(mins + 60), updated_at: at(mins), ...more })
  return [
    row(R, 'Amadeus 离线同步怎么做', 1),
    row(B1, '如果用 CRDT', 2, { parent_session_id: R, fork_message_id: 'a1', fork_session_id: R, created_at: at(20) }),
    row(B2, '只做桌面端', 3, { parent_session_id: R, fork_message_id: 'a1', fork_session_id: R, created_at: at(19) }),
    row(K, '查 Obsidian Sync 的冲突处理', 4, { parent_session_id: R, created_at: at(18) }),
    row(F1, '桌面端冷启动慢了 0.8 秒', 6),
  ]
}
const msg = (id, role, mins, content) => ({ id, role, timestamp: T + mins * 60_000, content })
const rootMsgs = [
  msg('u1', 'user', 0, 'Amadeus 想做离线同步:两台设备离线时都改了同一篇笔记,回来怎么合?'),
  msg('a1', 'model', 1, '三条路线,按改动从小到大:\n\n1. **按行三方合并**\n2. **CRDT(Yjs)**\n3. **后写的赢 + 冲突副本**\n\n建议走 1。'),
  msg('u2', 'user', 2, '按行三方合并展开说,要改哪些模块?'),
  msg('a2', 'model', 3, `要动的地方很多,逐条列出来:\n\n${LONG}\n\n最后一行:完。`),
  msg('u3', 'user', 4, '合不了的时候,用户看到的是什么?'),
  msg('a3', 'model', 5, '笔记顶部出现一条提示:另一台设备上也改了这篇,带两个按钮 —— 逐处比较、保留这边的。'),
]
// 分支开头是复制出来的:新 id,服务端时间戳(和主线那份不一样)
const copy = (p) => [msg(`${p}-u1`, 'user', -30, rootMsgs[0].content), msg(`${p}-a1`, 'model', -29, rootMsgs[1].content)]
const b1Msgs = [...copy('b'), msg('c1', 'user', 10, '如果改用 Yjs 做 CRDT 呢?代价是什么?'), msg('c2', 'model', 11, 'Yjs 能保证永远合得上,代价有三条:磁盘上多一份操作记录、外部编辑器改了 md 要反推、块编辑器要整层接 Yjs。')]
const b2Msgs = [...copy('d'), msg('d1', 'user', 12, '第一版只做桌面端,模块清单能砍到多少?'), msg('d2', 'model', 13, '砍到三处:同步基线、对账器、合并器。\n\n```ts\nexport function reconcile(base: string, ours: string, theirs: string): MergeResult { return threeWay(base, ours, theirs, { granularity: "line" }) }\n```')]
const fMsgs = [msg('f-u', 'user', 0, '冷启动慢了'), msg('f-a', 'model', 1, '先量一下。')]
// 主线第一条回答上挂着两段顺便问(卡底那块只列它们;从这条分出的两支已经是卡,不再列)
const asides = [
  { id: 'as1', session_id: R, message_id: 'a1', turns: [{ question: 'Yjs 打包后多大?', answer: '压缩后约 80 KB。' }], created_at: '2026-10-24 10:00:00', updated_at: '2026-10-24 10:00:00' },
  { id: 'as2', session_id: R, message_id: 'a1', turns: [{ question: '三方合并要存基线吗?', answer: '要,存上次同步的那一份。' }], created_at: '2026-10-24 10:01:00', updated_at: '2026-10-24 10:01:00' },
]

async function main() {
  const r = makeReporter()
  const dir = shotDir('chat-canvas')
  let projectDir = ''
  const branchCalls = []
  let b3 = null
  const patches = []
  const ctx = await launch({
    tag: 'chat-canvas',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method, body }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: [...(b3 && !b3.archived ? [b3] : []), ...sessions(projectDir)] } // 真引擎建了分支就会列出来
      if (b3 && p === `/agent/sessions/${B3}` && (method === 'PATCH' || method === 'PUT')) { const b = await body(); patches.push(b); Object.assign(b3, b); return b3 }
      let m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: { [R]: rootMsgs, [B1]: b1Msgs, [B2]: b2Msgs, [F1]: fMsgs }[m[1]] || [] }
      m = /^\/agent\/sessions\/([^/]+)\/config$/.exec(p)
      if (m && m[1] === B3 && method === 'GET') { await new Promise((res) => setTimeout(res, 900)); return { agent_config: { execMode: 'host', approvalMode: 'auto-edit', thinkingLevel: 'high' } } }
      m = /^\/agent\/sessions\/([^/]+)\/asides$/.exec(p)
      if (m && method === 'GET') return { asides: m[1] === R && !process.env.CV_NOASIDES ? asides : [] }
      m = /^\/agent\/sessions\/([^/]+)\/detail$/.exec(p)
      if (m) { const s = sessions(projectDir).find((x) => x.id === m[1]); if (s) return { session: { ...s, kind: 'user', delegate_running: false } } }
      // 草稿提问卡发出去:从那张回答分出一支(真引擎会复制前面的历史;这里新分支的历史是空的,够画出挂点)
      m = /^\/agent\/sessions\/([^/]+)\/branch$/.exec(p)
      if (m && method === 'POST') {
        const b = await body()
        branchCalls.push({ from: m[1], body: b })
        const at = new Date().toISOString().replace('T', ' ').slice(0, 19)
        b3 = { id: B3, title: 'New Chat', summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: projectDir, project_name: 'Forsion', projectless: false,
          created_at: at, updated_at: at, parent_session_id: R, fork_message_id: b.message_id, fork_session_id: m[1], kind: 'user' }
        return { session: b3, copied: 0 }
      }
      return undefined
    },
  })
  projectDir = ctx.projectDir
  const { win } = ctx
  win.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  if (process.env.CV_DEBUG) win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 300)) })
  const card = (sid, mid) => win.locator(`.t2cv-turn[data-cv-node="${sid}:${mid}"]`)
  // 空白处的说明:左上角有卡压着就让开,空着就露出来(按 DOM 实测矩形核对,不信组件自己的算术)
  const hintsCheck = async (tag) => {
    await win.waitForTimeout(250)
    const h = await win.evaluate(() => {
      const el = document.querySelector('.t2cv-hints'), hr = el.getBoundingClientRect()
      const hit = [...document.querySelectorAll('.t2cv-turn')].some((n) => { const r = n.getBoundingClientRect(); return r.left < hr.right && r.right > hr.left && r.top < hr.bottom && r.bottom > hr.top })
      return { hit, hidden: getComputedStyle(el).opacity === '0' }
    })
    r.check(`${tag}·说明 左上角被卡压着就让开、空着就露出来`, h.hit === h.hidden, JSON.stringify(h))
  }
  // 镜头落在这一支末尾,别的卡常在视口外(Playwright 平移不了画布;展开过的长卡让「适应内容」在最小缩放下也装不下):
  // 用滚轮(= 平移)把那张卡的卡头挪到舞台中间再点
  const show = async (sid, mid) => {
    const d = await win.evaluate((sel) => {
      const c = document.querySelector(sel).getBoundingClientRect(), s = document.querySelector('.t2cv-stage').getBoundingClientRect()
      return { mx: s.left + s.width / 2, my: s.top + s.height / 2, dx: c.left + c.width / 2 - (s.left + s.width / 2), dy: c.top + 40 - (s.top + s.height / 2) }
    }, `.t2cv-turn[data-cv-node="${sid}:${mid}"]`)
    await win.mouse.move(d.mx, d.my)
    await win.mouse.wheel(d.dx, d.dy)
    await win.waitForTimeout(300)
  }
  const zNow = () => win.evaluate(() => +new DOMMatrix(getComputedStyle(document.querySelector('.t2cv-world')).transform).a.toFixed(3))
  const worldXY = () => win.evaluate(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector('.t2cv-world')).transform); return { x: m.e, y: m.f } })
  const settled = () => win.waitForFunction(() => document.querySelector('.t2cv') && !document.querySelector('.t2cv[data-switch]'), null, { timeout: 5_000 })
  const allInView = () => win.evaluate(() => {
    const s = document.querySelector('.t2cv-stage').getBoundingClientRect()
    return [...document.querySelectorAll('.t2cv-turn')].every((n) => { const r = n.getBoundingClientRect(); return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 })
  })
  // 「视图」菜单(胶囊上那颗):排法 / 只看这一支 / 缩略图 / 抓手都在这里
  const viewPick = async (re) => {
    await win.locator('[data-testid="cv-view"]').click()
    await win.locator('.ctx-menu').waitFor({ timeout: 5_000 })
    await win.locator('.ctx-menu .ctx-item').filter({ hasText: re }).first().click()
    await win.locator('.ctx-menu').waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {})
  }
  // 在某块正文里拖选一段字(鼠标真拖,划线菜单认 mouseup)
  const dragSelect = async (sel) => {
    const b = await win.locator(sel).first().boundingBox()
    await win.mouse.move(b.x + 4, b.y + 9)
    await win.mouse.down()
    await win.mouse.move(b.x + Math.min(160, b.width - 4), b.y + 9, { steps: 6 })
    await win.mouse.up()
  }
  const rect = (sid, mid) => card(sid, mid).evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height } })
  // 生成中那张卡的底边离「阅读线」(输入框上沿再往上 28px)多远;正数 = 卡底在线上面
  const readGap = (sel) => win.evaluate((sel) => {
    const host = document.querySelector('.t2cv-stage')
    const el = document.querySelector(sel)
    if (!host || !el) return null
    const u = host.currentCSSZoom || 1
    const ch = parseFloat(getComputedStyle(host).getPropertyValue('--t2-composer-h')) || 96
    return Math.round(host.getBoundingClientRect().bottom - (ch + 44) * u - el.getBoundingClientRect().bottom)
  }, sel)
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1440, height: 900 })
    if (process.env.LANG_EN) await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.evaluate(() => localStorage.setItem('tangu.chatCanvas.hintsSeen', '-999')) // 说明只出前 3 次:台架里一直让它出,末尾 HN1 单独核「第 4 次不出」
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    const row = (id) => win.locator(`.t2s-srow[data-sel-id="${id}"]`).first()
    await row(R).waitFor({ timeout: 20_000 })
    await row(R).click()
    await win.locator('#tocmsg-a3').waitFor({ timeout: 15_000 })

    // ── 入口:标签栏右端的胶囊 ──
    const seg = win.locator('.t2-chat-col > .lcl-viewhead [data-testid="chat-canvas-seg"]')
    await seg.waitFor({ timeout: 10_000 })
    // 视图模式标准(方案 A):胶囊在对话这一列头行的左端,不在标签栏、不盖右栏
    const segBox = await seg.evaluate((e) => {
      const b = e.getBoundingClientRect(); const col = e.closest('.t2-chat-col').getBoundingClientRect(); const head = e.closest('.lcl-viewhead').getBoundingClientRect()
      return { left: Math.round(b.left - col.left), top: Math.round(b.top - col.top), headH: Math.round(head.height), inTabbar: !!e.closest('.dv-tabs-and-actions-container') }
    })
    r.check('E1 胶囊在对话列头行左端', !segBox.inTabbar && segBox.left <= 16 && segBox.top <= 8 && segBox.headH === 32, JSON.stringify(segBox))
    // 逐帧记镜头:点胶囊那一刻起 1.5s
    const preAnchor = await win.evaluate(() => {
      const body = document.querySelector('.t2-chat-col > .t2-chat-body'), r = body.getBoundingClientRect()
      const ch = parseFloat(getComputedStyle(body).getPropertyValue('--t2-composer-h'))
      return { bottom: Math.round(r.bottom), ch, msgs: [...body.querySelectorAll('.t2-asst[id^="tocmsg-"]')].map((e) => { const c = (e.querySelector('.t2-asst-col') ?? e).getBoundingClientRect(); return `${e.id.slice(7)}:${Math.round(c.top)}-${Math.round(c.bottom)}` }) }
    })
    await win.evaluate(() => {
      window.__sw = []
      const t0 = performance.now()
      const tick = () => {
        const w = document.querySelector('.t2cv-world'), c = document.querySelector('.t2cv')
        const col = (id) => { const e = document.querySelector(`.t2-chat-col > .t2-chat-body #tocmsg-${id} .t2-asst-col`); return e ? Math.round(e.getBoundingClientRect().top) : null }
        if (!w) window.__pre = (window.__pre || []).concat([{ t: Math.round(performance.now() - t0), a2: col('a2'), a3: col('a3') }]).slice(-4)
        if (w) window.__sw.push({ t: Math.round(performance.now() - t0), z: +new DOMMatrix(getComputedStyle(w).transform).a.toFixed(3), sw: c?.dataset.switch || '',
          body: getComputedStyle(document.querySelector('.t2-chat-col > .t2-chat-body')).visibility, anchor: document.querySelector('.t2cv-turn[data-anchor]')?.dataset.cvNode || '', })
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 10_000 })
    await card(R, 'u1').waitFor({ timeout: 10_000 })
    await win.waitForFunction(() => document.querySelectorAll('.t2cv-turn[data-measured]').length >= 5, null, { timeout: 15_000 })
    await win.waitForTimeout(1300)
    const sw = await win.evaluate(() => window.__sw)
    const preFrames = await win.evaluate(() => window.__pre)
    const swIn = sw.filter((x) => x.sw === 'enter'), swEnd = sw[sw.length - 1]
    r.check('SW1 切到画布:对话里最下面那条回答原地变成它那张卡(起点 100%),镜头拉到落位(90%);途中对话流不先藏;播完收掉',
      swIn.length >= 5 && Math.abs(swIn[0].z - 1) < 0.03 && swIn[0].body === 'visible' && swIn[0].anchor === `${R}:u3` && Math.abs(swEnd.z - 0.9) < 0.005 && !swEnd.sw && swEnd.body === 'hidden',
      JSON.stringify({ n: swIn.length, first: swIn[0], mid: swIn[Math.floor(swIn.length / 2)], end: swEnd, preAnchor, preFrames }))
    const shape = await win.evaluate(() => ({
      cards: [...document.querySelectorAll('.t2cv-turn')].map((e) => e.dataset.cvNode),
      bodyHidden: getComputedStyle(document.querySelector('.t2-chat-body')).visibility === 'hidden',
      rail: [...document.querySelectorAll('.t2-rail .t2-tsum, .t2-rail .agent-desk-card')].some((e) => getComputedStyle(e).display !== 'none'),
      edges: document.querySelectorAll('.t2cv-edges path').length,
      segOn: document.querySelector('[data-testid="chat-canvas-seg"] [aria-selected="true"]')?.textContent,
    }))
    r.check('E2 切到画布:对话流藏起来,右侧车道收起', shape.bodyHidden && !shape.rail, JSON.stringify(shape))
    r.check('C1 一轮一张卡:主线三轮 + 两支各一轮,复制段不重画', shape.cards.length === 5 && [`${R}:u1`, `${R}:u2`, `${R}:u3`, `${B1}:c1`, `${B2}:d1`].every((k) => shape.cards.includes(k)), JSON.stringify(shape.cards))
    r.check('C2 四根线(每张非根卡一根)', shape.edges === 4, String(shape.edges))
    const q = await card(B1, 'c1').locator('.t2cv-q').textContent()
    r.check('C3 提问卡是问题,回答卡里是真消息渲染', q.includes('Yjs') && (await card(B1, 'c1').locator('.t2cv-acard .t2-content').count()) === 1 && (await card(B1, 'c1').locator('.t2cv-qcard .t2-content').count()) === 0, q)
    const qa = await card(R, 'u3').evaluate((e) => { const q = e.querySelector('.t2cv-qcard').getBoundingClientRect(), a = e.querySelector('.t2cv-acard').getBoundingClientRect(); return { qb: q.bottom, at: a.top, qh: q.height } })
    r.check('C4 一轮两张卡:提问卡在上、回答卡在下,中间留一小段', qa.at > qa.qb + 4 && qa.at < qa.qb + 20 && qa.qh < 90, JSON.stringify(qa))
    // ── 胶囊 A ──
    const hud = await win.evaluate(() => {
      const h = document.querySelector('.t2cv .amx-stage-hud')
      return { n: h.querySelectorAll('button').length, view: !!h.querySelector('[data-testid="cv-view"]'), help: !!h.querySelector('[data-testid="cv-help"]'),
        old: document.querySelectorAll('[data-testid="cv-dir-h"], [data-testid="cv-dir-v"], [data-testid="cv-focus"], [data-testid="cv-hand"]').length,
        mini: !!document.querySelector('.t2cv .amx-stage-minimap') }
    })
    r.check('CP1 胶囊 = − % + ⤢ 视图 ?:排法 / 只看这一支 / 抓手收进「视图」,缩略图缺省不出', hud.view && hud.help && !hud.old && !hud.mini && hud.n <= 6, JSON.stringify(hud))
    await win.locator('[data-testid="cv-help"]').click()
    const helpN = await win.locator('[data-testid="cv-helppop"] span').count()
    await win.keyboard.press('Escape')
    await win.locator('[data-testid="cv-helppop"]').waitFor({ state: 'detached', timeout: 2_000 }).catch(() => {})
    r.check('CP2 「?」弹出画布怎么用(四句),Esc 收起', helpN === 4 && (await win.locator('[data-testid="cv-helppop"]').count()) === 0, String(helpN))
    // ── 顺便问 A:卡底那块只列挂在这条回答上的顺便问,分支不列(已经是卡);在正文外面,折起不裁 ──
    await card(R, 'u1').locator('.t2cv-acard > .t2-childs').waitFor({ timeout: 5_000 }).catch(() => {})
    const fk = await card(R, 'u1').evaluate((e) => {
      const b = e.querySelector('.t2cv-acard > .t2-childs')
      return b ? { asides: b.querySelectorAll('[data-aside]').length, branches: b.querySelectorAll('[data-branch-session]').length, inBody: !!e.querySelector('.t2cv-body .t2-childs'), vis: getComputedStyle(b).display !== 'none' } : null
    })
    r.check('AS1 卡底「从这里分出」:两段顺便问,不列分支,不在正文(折起区)里', !!fk && fk.vis && fk.asides === 2 && fk.branches === 0 && !fk.inBody, JSON.stringify(fk))
    await win.waitForTimeout(600) // 长卡量完折起之后
    const land = await win.evaluate(() => {
      const t = document.querySelector('.t2cv-card[data-sel]')?.closest('.t2cv-turn')
      const c = t?.getBoundingClientRect()
      const s = document.querySelector('.t2cv-stage').getBoundingClientRect()
      return c && { sel: t.dataset.cvNode, top: Math.round(c.top - s.top), bottom: Math.round(c.bottom - s.top), h: Math.round(s.height) }
    })
    r.check('L1 一打开镜头落在这一支最后一张卡上:整张在视野里、贴着输入框上方(上面露出前几轮,不落进空白)', !!land && land.sel === `${R}:u3` && land.top > 200 && land.bottom <= land.h - 100, JSON.stringify(land))
    // ── 划线修:卡里拖选 = 划线菜单(引用 / 顺便问);挪镜头就收;顺便问挂到那张卡那一支(不是主区正开着的那一支) ──
    await show(B2, 'd1')
    const btwBtn = win.locator('[data-testid="selection-btw"]')
    await dragSelect(`.t2cv-turn[data-cv-node="${B2}:d1"] .t2cv-acard .t2-content p`)
    const barUp = await btwBtn.waitFor({ timeout: 3_000 }).then(() => true, () => false)
    const quoteUp = (await win.locator('[data-testid="selection-quote"]').count()) === 1
    const sm = await win.evaluate(() => { const s = document.querySelector('.t2cv-stage').getBoundingClientRect(); return { x: s.left + 60, y: s.top + s.height * 0.7 } }) // 别落在划线菜单上(它就在选区上面、舞台中间)
    const wb0 = await worldXY()
    await win.evaluate(() => { window.__vpm = 0; document.addEventListener('selbar:viewport-moved', () => { window.__vpm++ }, true) })
    await win.mouse.move(sm.x, sm.y)
    await win.mouse.wheel(0, 60)
    const barGone = await btwBtn.waitFor({ state: 'detached', timeout: 2_000 }).then(() => true, () => false)
    const wb1 = await worldXY(), vpm = await win.evaluate(() => window.__vpm)
    r.check('SB1 卡里划线出划线菜单(引用 / 顺便问),一挪镜头就收', barUp && quoteUp && barGone, JSON.stringify({ barUp, quoteUp, barGone, wb0, wb1, vpm, btw: await btwBtn.count() }))
    await win.evaluate(() => window.getSelection().removeAllRanges()) // 在选区里按下去是拖走那段字,不是重新选
    await show(B2, 'd1')
    await dragSelect(`.t2cv-turn[data-cv-node="${B2}:d1"] .t2cv-acard .t2-content p`)
    await btwBtn.waitFor({ timeout: 3_000 })
    await btwBtn.click()
    const btwPanel = win.locator('.btw-panel')
    await btwPanel.waitFor({ timeout: 5_000 })
    const btwSid = await btwPanel.getAttribute('data-btw-session')
    const activeNow = await win.evaluate(() => document.querySelector('.t2-chat-view')?.dataset.sessionId)
    r.check('SB2 卡里划线「顺便问」:挂在那张卡那一支上(主区还是主线)', btwSid === B2 && activeNow === R, JSON.stringify({ btwSid, activeNow }))
    await win.locator('.agent-desk-head:has(+ .btw-panel) .icon-btn').click()
    await btwPanel.waitFor({ state: 'detached', timeout: 3_000 })
    await win.waitForTimeout(400) // 面板收起后舞台变宽、卡重新露出那一下

    // ── 竖排(缺省):子卡在下、兄弟并排 ──
    const [u1, u2, c1, d1] = [await rect(R, 'u1'), await rect(R, 'u2'), await rect(B1, 'c1'), await rect(B2, 'd1')]
    r.check('V1 竖排:三个子卡都在第一张卡下面、同一行并排', [u2, c1, d1].every((k) => k.y > u1.b && Math.abs(k.y - u2.y) < 2) && u2.r <= c1.x && c1.r <= d1.x, JSON.stringify({ u1, u2, c1, d1 }))
    r.check('V2 父卡在子卡们正上方居中', Math.abs((u1.x + u1.r) / 2 - (u2.x + d1.r) / 2) < 3, '')
    await win.screenshot({ path: path.join(dir, 'canvas-vertical.png') })

    // ── 全文 / 折起 ──
    const a3 = await card(R, 'u3').locator('.t2-content').textContent()
    r.check('R1 卡里直接是全文', a3.includes('逐处比较、保留这边的'), a3.slice(0, 60))
    const readBtn = card(R, 'u2').locator('[data-testid="cv-readbtn"]')
    r.check('R2 超长回答在卡里只露预览,下面一个「阅读」(没有原地展开)', (await readBtn.count()) === 1 && (await card(R, 'u2').locator('.t2cv-body[data-folded]').count()) === 1 && (await win.locator('.t2cv-more').count()) === 0
      && (await card(R, 'u2').locator('.t2cv-body').evaluate((e) => e.getBoundingClientRect().height)) < 300, '')
    const hPrev = (await rect(R, 'u2')).h
    await readBtn.evaluate((b) => b.click()) // 按钮常在视口外,Playwright 平移不了画布
    await win.locator('[data-testid="cv-read"]').waitFor({ timeout: 5_000 })
    await win.waitForTimeout(500)
    const full = await win.locator('[data-testid="cv-read"]').textContent()
    r.check('R3 「阅读」在右边阅读栏开全文,卡本身不变高', full.includes('最后一行:完。') && Math.abs((await rect(R, 'u2')).h - hPrev) < 2, JSON.stringify({ hPrev }))
    await win.locator('[data-testid="cv-read-close"]').click()
    await win.waitForTimeout(300)

    // ── 横排:子卡在右、兄弟上下叠 ──
    await viewPick(/横排/)
    await win.waitForTimeout(500)
    const [hu1, hu2, hc1, hd1] = [await rect(R, 'u1'), await rect(R, 'u2'), await rect(B1, 'c1'), await rect(B2, 'd1')]
    r.check('H1 横排:子卡都在第一张卡右边、同一列', [hu2, hc1, hd1].every((k) => k.x > hu1.r && Math.abs(k.x - hu2.x) < 2), JSON.stringify({ hu1, hu2, hc1, hd1 }))
    r.check('H2 兄弟上下叠、不重叠,第一个子卡与父卡齐顶', hu2.b <= hc1.y && hc1.b <= hd1.y && Math.abs(hu2.y - hu1.y) < 2, '')
    await win.screenshot({ path: path.join(dir, 'canvas-horizontal.png') })
    await viewPick(/竖排/)
    await win.waitForTimeout(400)

    // ── 只看这一支 ──
    await viewPick(/只看这一支/)
    const dims = () => win.evaluate(() => [...document.querySelectorAll('.t2cv-turn[data-dim]')].map((e) => e.dataset.cvNode).sort())
    const d0 = await dims()
    r.check('F1 只看这一支:不在当前这一支(主线)上的两支变淡', JSON.stringify(d0) === JSON.stringify([`${B1}:c1`, `${B2}:d1`].sort()), JSON.stringify(d0))
    await win.screenshot({ path: path.join(dir, 'canvas-focus.png') })
    await show(B1, 'c1')
    await card(B1, 'c1').locator('.t2cv-q').click()
    await win.locator(`.t2s-srow.active[data-sel-id="${B1}"]`).waitFor({ timeout: 10_000 })
    await win.waitForTimeout(300)
    const d1x = await dims()
    r.check('F2 点淡的那张 = 切到那一支(主区就地换),它亮、主线后两轮淡', JSON.stringify(d1x) === JSON.stringify([`${R}:u2`, `${R}:u3`, `${B2}:d1`].sort()) && !!(await win.locator('.t2cv').count()), JSON.stringify(d1x))
    const hot = await win.evaluate(() => document.querySelectorAll('.t2cv-edges path.hot').length)
    r.check('F3 选中卡到树根那一路的线加深,点的是提问卡就亮提问卡', hot === 1 && (await card(B1, 'c1').locator('.t2cv-qcard[data-sel]').count()) === 1, String(hot))
    await viewPick(/看全部分支/)
    await row(R).click()
    await win.locator(`.t2s-srow.active[data-sel-id="${R}"]`).waitFor({ timeout: 10_000 })
    await win.waitForTimeout(300)

    // ── 自动跟随:发出一句,生成中的卡跟到输入框上方;滚走就停、出箭头;点箭头飞回并恢复跟随 ──
    ctx.stub.script(Array.from({ length: 70 }, (_, i) => ({ type: 'token', delay: 110, payload: { delta: `第 ${i + 1} 段:提示条的文案、按钮和副本位置。\n\n` } })))
    const ta = win.locator('.t2c-ta').first()
    await ta.click()
    await ta.fill('提示条长什么样?')
    // 逐帧记世界层的位移(从按下 Enter 起 1.2s)
    const samp = win.evaluate(() => new Promise((res) => {
      const out = [], t0 = performance.now(), w = document.querySelector('.t2cv-world')
      const f = () => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(w.style.transform); if (m) out.push(+m[2]); if (performance.now() - t0 < 1200) requestAnimationFrame(f); else res(out) }
      requestAnimationFrame(f)
    }))
    await win.keyboard.press('Enter')
    const ys = await samp
    const steps = ys.slice(1).map((y, i) => Math.abs(y - ys[i])).filter((d) => d > 0.3)
    const total = Math.abs(ys[ys.length - 1] - ys[0]), maxStep = Math.max(0, ...steps)
    r.check('K1 新一轮出来时镜头逐帧追过去:走了好几帧,单帧位移封顶,不是一帧切过去', total > 60 && steps.length >= 5 && maxStep <= 200 && maxStep < total * 0.6, JSON.stringify({ total: Math.round(total), frames: steps.length, maxStep: Math.round(maxStep) }))
    const live = '.t2cv-turn[data-streaming]'
    await win.locator(live).waitFor({ timeout: 10_000 })
    await win.waitForTimeout(1500)
    const g1 = await readGap(live)
    const h1 = await win.locator(live).evaluate((e) => e.offsetHeight)
    await win.waitForTimeout(900)
    const g2 = await readGap(live)
    const h2 = await win.locator(live).evaluate((e) => e.offsetHeight)
    r.check('A1 生成中:卡在长,卡底一直停在输入框上方', h2 > h1 + 40 && Math.abs(g1) < 40 && Math.abs(g2) < 40, JSON.stringify({ g1, g2, h1, h2 }))
    const stage = await win.locator('.t2cv-stage').boundingBox()
    await win.mouse.move(stage.x + stage.width / 2, stage.y + 160)
    await win.mouse.wheel(0, -700)
    await win.waitForTimeout(900)
    const g3 = await readGap(live)
    const jump = win.locator('.t2cv-jump')
    r.check('A2 往上滚了一下就停跟:卡底掉到阅读线下面,出向下的箭头', g3 < -200 && (await jump.count()) === 1 && (await jump.getAttribute('data-dir')) === 'down', JSON.stringify({ g3 }))
    await win.screenshot({ path: path.join(dir, 'canvas-follow-arrow.png') })
    await jump.click()
    await win.waitForTimeout(700)
    const g4 = await readGap(live)
    await win.waitForTimeout(800)
    const g5 = await readGap(live)
    r.check('A3 点箭头飞回去、箭头收起,之后接着跟', (await jump.count()) === 0 && Math.abs(g4) < 40 && Math.abs(g5) < 40, JSON.stringify({ g4, g5 }))
    await win.waitForFunction(() => !document.querySelector('.t2cv-turn[data-streaming]'), null, { timeout: 20_000 })
    r.check('A4 跑完:新的一轮长在主线最后一张卡下面', (await win.locator(`.t2cv-turn[data-cv-node^="${R}:"]`).count()) === 4, '')
    await win.waitForTimeout(500)
    const doneSel = `.t2cv-turn[data-cv-node="${R}:u-r1"]`
    const g6 = await readGap(doneSel)
    const doneH = await win.locator(doneSel).evaluate((e) => e.offsetHeight)
    r.check('A5 刚写完的长回答不折起,视野还停在它末尾(不掉进空白)', doneH > 900 && (await win.locator(`${doneSel} .t2cv-body[data-folded]`).count()) === 0 && Math.abs(g6) < 60, JSON.stringify({ g6, doneH }))

    // ── 双击 = 右边开阅读栏,镜头让开它;回对话走胶囊(方案 Chat画布第三轮)──
    await show(B2, 'd1')
    await card(B2, 'd1').locator('.t2cv-q').dblclick()
    const pane = win.locator('[data-testid="cv-read"]')
    await pane.waitFor({ timeout: 5_000 })
    await win.locator(`.t2s-srow.active[data-sel-id="${B2}"]`).waitFor({ timeout: 10_000 })
    await win.waitForTimeout(500) // 让位那一下缓动
    const rd = await win.evaluate((k) => {
      const p = document.querySelector('[data-testid="cv-read"]'), pr = p.getBoundingClientRect()
      const c = document.querySelector(`.t2cv-turn[data-cv-node="${k}"]`).getBoundingClientRect(), s = document.querySelector('.t2cv-stage').getBoundingClientRect()
      return { key: p.dataset.cvRead, text: p.textContent.slice(0, 200), canvas: !!document.querySelector('.t2cv'), cardL: Math.round(c.left - s.left), cardR: Math.round(c.right), paneL: Math.round(pr.left),
        hudR: Math.round(document.querySelector('.t2cv .amx-stage-hud').getBoundingClientRect().right), noSel: window.getSelection().isCollapsed }
    }, `${B2}:d1`)
    r.check('D1 双击 = 右边阅读栏读那一轮,画布还在,卡让到阅读栏左边,缩放胶囊也让开,没顺手选中字', rd.key === `${B2}:d1` && rd.text.includes('砍到三处') && rd.canvas && rd.cardR <= rd.paneL - 8 && rd.cardL >= 0 && rd.hudR <= rd.paneL && rd.noSel, JSON.stringify(rd))
    await hintsCheck('D1')
    await win.screenshot({ path: path.join(dir, 'canvas-read.png') })
    await win.keyboard.press('ArrowUp')
    await win.waitForTimeout(300)
    const prevKey = await pane.getAttribute('data-cv-read')
    await pane.getByRole('button', { name: /下一轮|Next turn/ }).click()
    await win.waitForTimeout(300)
    const nextKey = await pane.getAttribute('data-cv-read')
    await win.keyboard.press('ArrowUp')
    await win.waitForTimeout(300)
    const prevKey2 = await pane.getAttribute('data-cv-read')
    await win.keyboard.press('Escape')
    await pane.waitFor({ state: 'detached', timeout: 2_000 }).catch(() => {}) // 关 = 往右淡出 200ms 再拿掉
    const backOnStage = await win.evaluate(() => document.activeElement?.classList.contains('t2cv-stage'))
    r.check('D3 双击后直接 ↑ 换到上一轮、点「下一轮」后 ↑ 照样翻,Esc 关掉、焦点回舞台', prevKey === `${R}:u1` && nextKey === `${B2}:d1` && prevKey2 === `${R}:u1` && (await pane.count()) === 0 && backOnStage,
      JSON.stringify({ prevKey, nextKey, prevKey2, backOnStage }))
    await win.waitForTimeout(500) // 关阅读栏那一下镜头还在回位
    const memoBefore = await worldXY()
    await seg.getByRole('tab').nth(0).click()
    const exitSeen = await win.waitForFunction(() => document.querySelector('.t2cv[data-switch="exit"]') && getComputedStyle(document.querySelector('.t2-chat-col > .t2-chat-body')).visibility === 'visible', null, { timeout: 1_000 }).then(() => true, () => false)
    const t0x = Date.now()
    await win.waitForFunction(() => !document.querySelector('.t2cv'), null, { timeout: 5_000 })
    const exitMs = Date.now() - t0x
    // 画布开着换过会话(F2 点淡卡、D1 双击别的支)后对话列里只能有一份正文:卡和正文同 key 时旧会话那份留在 DOM 里,上下叠成两个对话窗口(10-20 用户报)
    const bodyCount = await win.locator('.t2-chat-col > .t2-chat-body').count()
    r.check('D2 胶囊切回对话 = 正在看的这一支,只有一份正文(画布开着换会话不留旧的)', bodyCount === 1 && (await win.locator('#tocmsg-d1').count()) === 1, String(bodyCount))

    // ── 偏好按树根记:分支里切回画布 → 换到无关会话是对话 → 回到这棵树的主线还是画布 ──
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 5_000 })
    await settled()
    const memoAfter = await worldXY()
    r.check('SW2 切回对话:画布留着推回那一条、对话流已经露出来,不到半秒卸掉;再切回画布落在切走前的位置', exitSeen && exitMs < 700 && Math.abs(memoAfter.x - memoBefore.x) < 2 && Math.abs(memoAfter.y - memoBefore.y) < 2,
      JSON.stringify({ exitSeen, exitMs, memoBefore, memoAfter }))
    await row(F1).click()
    await win.locator(`.t2s-srow.active[data-sel-id="${F1}"]`).waitFor({ timeout: 10_000 })
    await win.waitForTimeout(300)
    const offOther = (await win.locator('.t2cv').count()) === 0
    await row(R).click()
    await win.locator(`.t2s-srow.active[data-sel-id="${R}"]`).waitFor({ timeout: 10_000 })
    await win.waitForTimeout(300)
    r.check('P1 画布开关按树记:在分支里开的,主线也是画布;无关会话不受影响', offOther && (await win.locator('.t2cv').count()) === 1, '')
    await win.waitForTimeout(600)

    // ── ⊕:提问卡左右 = 换个问法;末尾回答卡下 = 聚焦输入框;不在末尾的回答卡下 = 草稿提问卡 → Enter 建分支并发进去 ──
    await show(B1, 'c1')
    await card(B1, 'c1').locator('.t2cv-qcard').hover()
    const sideAdds = await card(B1, 'c1').locator('.t2cv-qcard > .t2cv-add').evaluateAll((bs) => bs.map((b) => ({ side: b.dataset.add, vis: getComputedStyle(b).opacity === '1', title: b.title })))
    r.check('Q1 悬停提问卡:左右各一颗 ⊕「换个问法」', sideAdds.length === 2 && sideAdds.every((b) => b.vis && /换个问法|Ask it differently/.test(b.title)), JSON.stringify(sideAdds))
    // 主线这时的最后一张是 A 段生成出来的那一轮(u-r1,很长:⊕ 在卡底,常在视口外 → 悬停后直接点)
    await show(R, 'u-r1')
    await card(R, 'u-r1').locator('.t2cv-acard').hover()
    const tailAdd = card(R, 'u-r1').locator('.t2cv-acard > .t2cv-add')
    const tailTitle = await tailAdd.getAttribute('title')
    await tailAdd.evaluate((b) => b.click())
    await win.waitForTimeout(200)
    const fu = await win.evaluate(() => ({ focus: document.activeElement?.classList.contains('t2c-ta'), flash: !!document.querySelector('.t2cv-attach[data-flash]'), draft: !!document.querySelector('[data-testid="cv-draft"]') }))
    r.check('Q2 末尾那张回答卡的 ⊕ =「接着问」:不建卡,输入框聚焦,「接在」闪一下', /接着问|Ask a follow-up/.test(tailTitle) && fu.focus && fu.flash && !fu.draft, JSON.stringify({ tailTitle, ...fu }))
    await show(R, 'u1')
    await win.mouse.wheel(0, 220) // 这张回答卡底下挂着顺便问那块,卡底的 ⊕ 会落到输入框底下
    await win.waitForTimeout(300)
    await card(R, 'u1').locator('.t2cv-acard').hover()
    const plus = card(R, 'u1').locator('.t2cv-acard > .t2cv-add')
    const plusTitle = await plus.getAttribute('title')
    await plus.click()
    const dta = win.locator('[data-testid="cv-draft"]')
    await dta.waitFor({ timeout: 5_000 })
    await win.waitForTimeout(500)
    const dr = await win.evaluate(() => {
      const t = document.querySelector('[data-testid="cv-draft"]'), b = t.closest('.t2cv-turn').getBoundingClientRect(), s = document.querySelector('.t2cv-stage').getBoundingClientRect()
      return { focus: document.activeElement === t, inView: b.left >= s.left && b.right <= s.right && b.top >= s.top && b.bottom <= s.bottom, scrolled: document.querySelector('.t2cv-stage').scrollTop + document.querySelector('.t2cv-stage').scrollLeft }
    })
    r.check('Q3 不在末尾的回答卡 ⊕ =「从这里分出一支」:画布上出一张草稿提问卡,露在视野里、已聚焦', /从这里分出一支|Branch from here/.test(plusTitle) && dr.focus && dr.inView && dr.scrolled === 0, JSON.stringify({ plusTitle, ...dr }))
    await hintsCheck('Q3')
    await win.screenshot({ path: path.join(dir, 'canvas-draft.png') })
    ctx.stub.script([{ type: 'token', delay: 40, payload: { delta: '直接删,不算冲突。' } }])
    await dta.fill('两台都删了同一段呢?')
    ctx.stub.state.failRuns = true
    await win.keyboard.press('Enter')
    for (let i = 0; i < 100 && !ctx.stub.seen.runs.some((x) => x.sessionId === B3); i++) await win.waitForTimeout(100)
    await win.waitForFunction(() => { const t = document.querySelector('[data-testid="cv-draft"]'); return t && !t.readOnly }, null, { timeout: 10_000 })
    await win.waitForTimeout(300)
    const kept = await win.evaluate(() => { const t = document.querySelector('[data-testid="cv-draft"]'); return { text: t?.value, focus: document.activeElement === t } })
    r.check('Q5 起 run 失败:草稿和字都留着(焦点回到草稿),分支只建了一次', kept.text === '两台都删了同一段呢?' && kept.focus && branchCalls.length === 1, JSON.stringify({ kept, branchCalls: branchCalls.length }))
    ctx.stub.state.failRuns = false
    ctx.stub.script([{ type: 'token', delay: 40, payload: { delta: '直接删,不算冲突。' } }])
    await win.keyboard.press('Enter')
    await win.waitForFunction(() => !document.querySelector('[data-testid="cv-draft"]'), null, { timeout: 10_000 })
    await win.locator(`.t2cv-turn[data-cv-node^="${B3}:"]`).waitFor({ timeout: 10_000 })
    await win.waitForTimeout(800)
    const run = ctx.stub.seen.runs.at(-1)
    const geo = await win.evaluate(({ a, b }) => {
      const pe = document.querySelector(`.t2cv-turn[data-cv-node="${a}"]`), n = document.querySelector(`.t2cv-turn[data-cv-node^="${b}:"]`)
      if (!pe || !n) return { below: false, q: null, nodes: [...document.querySelectorAll('.t2cv-turn')].map((e) => e.dataset.cvNode), canvas: !!document.querySelector('.t2cv') }
      return { below: n.getBoundingClientRect().top > pe.getBoundingClientRect().bottom, q: n.querySelector('.t2cv-q')?.textContent }
    }, { a: `${R}:u1`, b: B3 })
    r.check('Q4 Enter = 从第一轮回答建分支、这句发进新分支;草稿变成提问卡挂在第一轮下面',
      branchCalls.length === 1 && branchCalls[0].from === R && branchCalls[0].body.message_id === 'a1' && run?.sessionId === B3 && String(run?.message).includes('两台都删了同一段') && geo.below && geo.q === '两台都删了同一段呢?',
      JSON.stringify({ branchCalls, run: run && { s: run.sessionId, m: run.message }, geo }))
    const firstB3 = ctx.stub.seen.runs.find((x) => x.sessionId === B3)
    r.check('Q6 新分支的配置(慢一拍才到)等到了再发:头一次发出去的这句就带着分支继承来的配置', firstB3?.agentConfig?.thinkingLevel === 'high' && run?.agentConfig?.thinkingLevel === 'high', JSON.stringify(firstB3?.agentConfig))
    await hintsCheck('Q4')
    await win.screenshot({ path: path.join(dir, 'canvas-sent.png') })

    // ── 卡里的列表 / 代码:序号圆点不被裁、长行在卡里换行(方案 ③ 顺带的两个 bug)──
    const lc = await win.evaluate(({ a, b }) => {
      const ol = document.querySelector(`.t2cv-turn[data-cv-node="${a}"] .t2cv-acard ol`), pre = document.querySelector(`.t2cv-turn[data-cv-node="${b}"] .t2cv-acard pre`)
      return { pad: ol ? parseFloat(getComputedStyle(ol).paddingInlineStart) : -1, ws: pre && getComputedStyle(pre).whiteSpace, over: pre ? pre.scrollWidth - pre.clientWidth : -1 }
    }, { a: `${R}:u1`, b: `${B2}:d1` })
    r.check('L1 卡里的列表给序号留了位置,代码块长行换行、不横向溢出', lc.pad >= 16 && lc.ws === 'pre-wrap' && lc.over <= 1, JSON.stringify(lc))

    // ── 右键(方案 ⑤)──
    const menuItems = () => win.locator('.ctx-menu .ctx-item').evaluateAll((bs) => bs.map((b) => ({ t: b.getAttribute('aria-label'), off: b.disabled })))
    const rclick = async (sid, mid, part) => {
      await show(sid, mid)
      const el = card(sid, mid).locator(part === 'q' ? '.t2cv-qcard' : '.t2cv-acard')
      if (process.env.CV_DEBUG) {
        await win.evaluate(() => { window.__ctx = []; window.addEventListener('contextmenu', (e) => window.__ctx.push({ t: e.target.className, dp: e.defaultPrevented }), { once: true }) })
        const bb = await el.boundingBox()
        const hit = await win.evaluate(({ x, y }) => { const h = document.elementFromPoint(x, y); return h && `${h.tagName}.${h.className} in-turn=${!!h.closest('.t2cv-turn')}` }, { x: bb.x + 40, y: bb.y + 16 })
        console.log('RCLICK', sid.slice(-3), mid, part, JSON.stringify(bb), hit)
      }
      await el.click({ button: 'right', position: { x: 40, y: 16 } })
      if (process.env.CV_DEBUG) { await win.waitForTimeout(200); console.log('CTX', JSON.stringify(await win.evaluate(() => window.__ctx)), await win.locator('.ctx-menu').count()) }
      await win.locator('.ctx-menu').waitFor({ timeout: 5_000 })
    }
    const pickItem = (re) => win.locator('.ctx-menu .ctx-item').filter({ hasText: re }).first().click()
    await rclick(R, 'u1', 'a')
    const m1 = await menuItems()
    await win.waitForTimeout(300) // 菜单有一段淡入
    await win.screenshot({ path: path.join(dir, 'canvas-menu.png') })
    const has = (m, re, off) => m.some((x) => re.test(x.t) && (off === undefined || x.off === off))
    r.check('M1 回答卡右键:分出一支 / 复制回答 / 顺便问 / 阅读 / 只看这一支 / 收起(正看的这一支穿过它 → 灰)',
      has(m1, /从这里分出一支/) && has(m1, /复制回答/) && has(m1, /顺便问/) && has(m1, /^阅读$/) && has(m1, /只看这一支/) && has(m1, /收起下面的卡/, true), JSON.stringify(m1))
    await win.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    await win.locator('.ctx-menu').waitFor({ state: 'detached', timeout: 5_000 })
    // 右键也会选中(焦点这时落在主线上,主线上的卡收不了):先切到 B2 那一支,再收主线第二轮下面
    await show(B2, 'd1')
    await card(B2, 'd1').locator('.t2cv-q').click()
    await win.locator(`.t2s-srow.active[data-sel-id="${B2}"]`).waitFor({ timeout: 10_000 })
    await rclick(R, 'u2', 'a')
    await pickItem(/收起下面的卡/)
    await win.waitForTimeout(400)
    const pill = card(R, 'u2').locator('[data-testid="cv-foldpill"]')
    const gone = (await card(R, 'u3').count()) === 0 && (await card(R, 'u-r1').count()) === 0
    const pillText = await pill.textContent().catch(() => null)
    r.check('M2 收起下面的卡:下面两张不见了,卡下挂一颗「+2」', gone && pillText === '+2', JSON.stringify({ gone, pillText }))
    await win.screenshot({ path: path.join(dir, 'canvas-fold.png') })
    await pill.evaluate((b) => b.click())
    await card(R, 'u3').waitFor({ timeout: 5_000 })
    r.check('M3 点「+2」展开回来', (await pill.count()) === 0, '')
    const b3Mid = (await win.locator(`.t2cv-turn[data-cv-node^="${B3}:"]`).first().getAttribute('data-cv-node')).split(':').pop()
    await rclick(B3, b3Mid, 'q')
    const m4 = await menuItems()
    r.check('M4 一支开头那张提问卡右键:换个问法 / 改写这句再问 / 复制问题 / 重命名 / 归档', has(m4, /换个问法/) && has(m4, /改写这句再问/) && has(m4, /复制问题/) && has(m4, /重命名这一支/) && has(m4, /归档这一支/), JSON.stringify(m4))
    await pickItem(/重命名这一支/)
    const rn = win.locator('[data-testid="cv-rename"]')
    await rn.waitFor({ timeout: 5_000 })
    const activeBefore = await win.locator('.t2s-srow.active').getAttribute('data-sel-id')
    await rn.dblclick() // 改名框里双击 = 选词:不开阅读栏、不切支(Codex 评审)
    await win.waitForTimeout(300)
    const dblOk = (await pane.count()) === 0 && (await win.locator('.t2s-srow.active').getAttribute('data-sel-id')) === activeBefore && (await rn.count()) === 1
    r.check('M5a 改名框里双击只是选词:不开阅读栏、不切到那一支', dblOk, JSON.stringify({ activeBefore }))
    await rn.fill('删同一段')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(400)
    const rowTitle = await row(B3).textContent()
    r.check('M5 原地改名:Enter 存进引擎,左栏那一行跟着换', patches.some((x) => x.title === '删同一段') && rowTitle.includes('删同一段') && (await rn.count()) === 0, JSON.stringify({ patches, rowTitle }))
    // 空白处
    const blank = await win.evaluate(() => {
      const s = document.querySelector('.t2cv-stage').getBoundingClientRect()
      for (let y = s.top + 220; y < s.bottom - 160; y += 40) for (let x = s.left + 40; x < s.right - 40; x += 40) {
        const el = document.elementFromPoint(x, y)
        if (el && el.closest('.t2cv-stage') && !el.closest('.t2cv-turn, .amx-stage-hud, .amx-stage-minimap, .t2cv-hints, button')) return { x, y }
      }
      return null
    })
    await win.mouse.click(blank.x, blank.y, { button: 'right' })
    await win.locator('.ctx-menu').waitFor({ timeout: 5_000 })
    const m6 = await menuItems()
    r.check('M6 空白处右键:回到最新 / 看全部 / 横排 / 只看这一支 / 缩略图', has(m6, /回到最新/) && has(m6, /看全部$/) && has(m6, /横排/) && has(m6, /只看这一支/) && has(m6, /缩略图/), JSON.stringify(m6))
    await pickItem(/^看全部(⇧1)?$/) // 菜单项后面带着快捷键 ⇧1
    await win.waitForTimeout(500)
    const fitAll = await win.evaluate(() => {
      const s = document.querySelector('.t2cv-stage').getBoundingClientRect()
      return [...document.querySelectorAll('.t2cv-turn')].every((n) => { const r = n.getBoundingClientRect(); return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 })
    })
    r.check('M7 「看全部」:所有卡都进了视野', fitAll, '')
    // 归档这一支:正看着它 → 先回到上一支,画布还开着,那一支从画布上下去
    await show(B3, b3Mid)
    await card(B3, b3Mid).locator('.t2cv-q').click()
    await win.locator(`.t2s-srow.active[data-sel-id="${B3}"]`).waitFor({ timeout: 10_000 })
    // 先让这一支有两轮,在第一轮下面开一张写了字的草稿(挂在这一支上),再归档它:字不能丢(Codex 评审)
    ctx.stub.script([{ type: 'token', delay: 30, payload: { delta: '先看基线。' } }])
    await win.locator('.t2c-ta').first().fill('那冲突副本放哪?')
    await win.keyboard.press('Enter')
    await win.waitForFunction((b) => document.querySelectorAll(`.t2cv-turn[data-cv-node^="${b}:"]`).length === 2 && !document.querySelector('.t2cv-turn[data-streaming]'), B3, { timeout: 15_000 })
    await rclick(B3, b3Mid, 'a')
    await pickItem(/从这里分出一支/)
    await win.locator('[data-testid="cv-draft"]').fill('换成按块合并呢?')
    await rclick(B3, b3Mid, 'q')
    await pickItem(/归档这一支/)
    await win.locator(`.t2s-srow.active[data-sel-id="${R}"]`).waitFor({ timeout: 10_000 })
    await win.waitForFunction((b) => !document.querySelector(`.t2cv-turn[data-cv-node^="${b}:"]`), B3, { timeout: 10_000 })
    r.check('M8 归档正看着的这一支:先回到上一支,画布还开着,它从画布上下去', patches.some((x) => x.archived === true) && (await win.locator('.t2cv').count()) === 1, JSON.stringify(patches))
    const keptText = await win.evaluate(() => document.querySelector('[data-testid="cv-draft"]')?.value ?? null)
    r.check('M9 挂在被归档那一支上的草稿:字留着,挪到它上一张卡下面', keptText === '换成按块合并呢?', JSON.stringify({ keptText }))
    await win.locator('[data-testid="cv-draft"]').press('Escape')

    // ── 阅读栏左边缘拖宽,记在本机 ──
    await show(R, 'u1')
    await card(R, 'u1').locator('.t2cv-q').dblclick()
    await pane.waitFor({ timeout: 5_000 })
    await win.waitForTimeout(400)
    const pb = await pane.boundingBox()
    await win.mouse.move(pb.x + 2, pb.y + pb.height / 2)
    await win.mouse.down()
    await win.mouse.move(pb.x - 60, pb.y + pb.height / 2, { steps: 4 })
    await win.mouse.move(pb.x - 120, pb.y + pb.height / 2, { steps: 4 })
    await win.mouse.up()
    await win.waitForTimeout(500)
    const pb2 = await pane.boundingBox()
    const savedW = await win.evaluate(() => localStorage.getItem('tangu.chatCanvas.readW'))
    const cardOk = await win.evaluate((k) => document.querySelector(`.t2cv-turn[data-cv-node="${k}"]`).getBoundingClientRect().right <= document.querySelector('[data-testid="cv-read"]').getBoundingClientRect().left, `${R}:u1`)
    r.check('G1 阅读栏左边缘拖宽:变宽、记在本机,卡照样让到它左边', pb2.width > pb.width + 60 && Number(savedW) > 0 && cardOk, JSON.stringify({ w0: Math.round(pb.width), w1: Math.round(pb2.width), savedW, cardOk }))
    await win.screenshot({ path: path.join(dir, 'canvas-read-wide.png') })
    await win.keyboard.press('Escape')
    await pane.waitFor({ state: 'detached', timeout: 2_000 })

    // ── 阅读栏 A:卡框长出、顶上轮次、底下一排操作(同卡边 ⊕ 的规则)、换轮滑入、关掉往右淡出 ──
    await show(R, 'u2')
    const miniBefore = await win.evaluate(() => !!document.querySelector('.t2cv .amx-stage-minimap'))
    await card(R, 'u2').locator('.t2cv-q').dblclick()
    await pane.waitFor({ timeout: 5_000 })
    const ghost = await win.evaluate(() => !!document.querySelector('.t2cv-read-ghost'))
    await win.waitForTimeout(500)
    const ra = await win.evaluate((k) => {
      const p = document.querySelector('[data-testid="cv-read"]')
      const chips = [...p.querySelectorAll('.t2cv-read-steps > button')]
      return { chips: chips.length, cur: chips.findIndex((b) => b.getAttribute('aria-current') === 'true'), follow: !!p.querySelector('[data-testid="cv-read-follow"]'),
        branch: !!p.querySelector('[data-testid="cv-read-branch"]'), msgActs: [...p.querySelectorAll('.t2-actions')].filter((e) => e.offsetParent).length,
        ring: !!document.querySelector(`.t2cv-turn[data-cv-node="${k}"][data-reading]`), mini: !!document.querySelector('.t2cv .amx-stage-minimap'),
        ghostLeft: !!document.querySelector('.t2cv-read-ghost'), wr: +(p.getBoundingClientRect().width / document.querySelector('.t2cv').getBoundingClientRect().width).toFixed(3) }
    }, `${R}:u2`)
    r.check('RA1 双击:卡框从卡长出来、到位后收掉;顶上一排轮次第 2 轮亮;中间那轮出「从这里分出」不出「接着问」;正读的卡描一圈;缩略图收起;消息自己那行操作藏掉;拖宽过的也不超过画布 70%',
      ghost && !ra.ghostLeft && ra.chips >= 3 && ra.cur === 1 && ra.branch && !ra.follow && ra.ring && !ra.mini && ra.msgActs === 0 && ra.wr <= 0.701, JSON.stringify({ ghost, miniBefore, ...ra }))
    await win.screenshot({ path: path.join(dir, 'canvas-read-a.png') })
    await dragSelect('[data-testid="cv-read"] .t2-content p')
    const readBar = await win.locator('[data-testid="selection-btw"]').waitFor({ timeout: 3_000 }).then(() => true, () => false)
    r.check('SB3 阅读栏里划线也出划线菜单', readBar, '')
    await win.evaluate(() => window.getSelection().removeAllRanges())
    await win.locator('.t2cv-read-steps > button').first().click()
    await win.waitForTimeout(60)
    const rb = await win.evaluate(() => { const p = document.querySelector('[data-testid="cv-read"]'); return { key: p.dataset.cvRead, dir: p.querySelector('.t2cv-read-b').dataset.dir ?? null } })
    r.check('RA2 点轮次「1」直接跳到第一轮,正文从上面滑进来', rb.key === `${R}:u1` && rb.dir === '-1', JSON.stringify(rb))
    await win.locator('.t2cv-read-steps > button').last().click()
    await win.waitForTimeout(300)
    const rc = await win.evaluate(() => { const p = document.querySelector('[data-testid="cv-read"]'); return { key: p.dataset.cvRead, follow: !!p.querySelector('[data-testid="cv-read-follow"]'), branch: !!p.querySelector('[data-testid="cv-read-branch"]'), dir: p.querySelector('.t2cv-read-b').dataset.dir ?? null } })
    await win.locator('[data-testid="cv-read-follow"]').click()
    await win.waitForTimeout(100)
    const focusTa = await win.evaluate(() => !!document.activeElement?.classList.contains('t2c-ta') && !!document.querySelector('.t2cv-attach[data-flash]'))
    r.check('RA3 这一支最后一轮出「接着问」:点了聚焦下面的输入框、「接在」闪一下;往下跳正文从下面滑进来', rc.follow && !rc.branch && rc.dir === '1' && focusTa, JSON.stringify({ ...rc, focusTa }))
    await win.locator('[data-testid="cv-read-close"]').click()
    const out = await win.evaluate(() => document.querySelector('[data-testid="cv-read"]')?.hasAttribute('data-out') ?? false)
    await pane.waitFor({ state: 'detached', timeout: 2_000 })
    const ringLeft = await win.locator('.t2cv-turn[data-reading]').count()
    r.check('RA4 关:先往右淡出再拿掉,卡上那一圈跟着没了', out && ringLeft === 0, JSON.stringify({ out, ringLeft }))

    // ── 空白处右键按住拖 = 平移;没拖才弹空白菜单(用户 10-24 定)──
    const blankPt = () => win.evaluate(() => {
      const s = document.querySelector('.t2cv-stage').getBoundingClientRect()
      for (let y = s.top + 220; y < s.bottom - 160; y += 40) for (let x = s.left + 40; x < s.right - 40; x += 40) {
        const el = document.elementFromPoint(x, y)
        if (el && el.closest('.t2cv-stage') && !el.closest('.t2cv-turn, .amx-stage-hud, .amx-stage-minimap, .t2cv-hints, button')) return { x, y }
      }
      return null
    })
    let bp = await blankPt()
    const w0 = await worldXY()
    await win.mouse.move(bp.x, bp.y)
    await win.mouse.down({ button: 'right' })
    await win.mouse.move(bp.x + 90, bp.y + 50, { steps: 6 })
    const grab = await win.evaluate(() => getComputedStyle(document.querySelector('.t2cv-stage')).cursor)
    await win.mouse.up({ button: 'right' })
    await win.waitForTimeout(250)
    const w1 = await worldXY()
    const menuAfterDrag = await win.locator('.ctx-menu').count()
    r.check('RP1 空白处右键按住拖 = 平移(拖着是握紧的抓手),松开不弹菜单', w1.x - w0.x > 40 && w1.y - w0.y > 20 && grab === 'grabbing' && menuAfterDrag === 0, JSON.stringify({ w0, w1, grab, menuAfterDrag }))
    bp = await blankPt()
    await win.mouse.move(bp.x, bp.y)
    await win.mouse.down({ button: 'right' })
    const menuOnDown = await win.locator('.ctx-menu').count()
    await win.mouse.up({ button: 'right' })
    await win.locator('.ctx-menu').waitFor({ timeout: 3_000 })
    const m10 = await menuItems()
    r.check('RP2 空白处右键没拖:按下不弹、松开才弹空白菜单', menuOnDown === 0 && has(m10, /看全部$/), JSON.stringify({ menuOnDown, m10 }))
    await win.keyboard.press('Escape')
    await win.locator('.ctx-menu').waitFor({ state: 'detached', timeout: 3_000 })

    // ── 三种画布同一套键位(unify.html §2) ──
    await win.locator('.t2cv-stage').focus()
    const iw0 = await win.evaluate(() => window.innerWidth)
    await win.keyboard.press('Meta+Digit0')
    await win.waitForTimeout(450)
    const kz0 = await zNow()
    await win.keyboard.press('Meta+Minus')
    await win.waitForTimeout(450)
    const kz1 = await zNow()
    await win.keyboard.press('Shift+Digit1')
    await win.waitForTimeout(450)
    const kfit = await allInView()
    const iw1 = await win.evaluate(() => window.innerWidth)
    r.check('KB1 ⌘0 回 100%、⌘− 缩小一档、⇧1 看全部;整窗不跟着缩放', Math.abs(kz0 - 1) < 0.01 && Math.abs(kz1 - 1 / 1.2) < 0.01 && kfit && iw0 === iw1, JSON.stringify({ kz0, kz1, kfit, iw0, iw1 }))
    // 按住空格在卡上拖 = 平移(不选字);松开不开阅读栏。轻按一下空格 = 开 / 关阅读栏
    await show(R, 'u3')
    await card(R, 'u3').locator('.t2cv-q').click()
    const cb = await card(R, 'u3').locator('.t2cv-acard').boundingBox()
    const sp0 = await worldXY()
    await win.keyboard.down('Space')
    const handOn = await win.evaluate(() => document.querySelector('.t2cv').hasAttribute('data-hand'))
    await win.mouse.move(cb.x + 60, cb.y + 30)
    await win.mouse.down()
    await win.mouse.move(cb.x + 180, cb.y + 90, { steps: 6 })
    await win.mouse.up()
    await win.keyboard.up('Space')
    await win.waitForTimeout(250)
    const sp1 = await worldXY()
    const spSel = await win.evaluate(() => window.getSelection().isCollapsed)
    r.check('SP1 按住空格在卡上拖 = 平移(握手光标、不选字),松开空格不开阅读栏', handOn && sp1.x - sp0.x > 80 && sp1.y - sp0.y > 30 && spSel && (await pane.count()) === 0, JSON.stringify({ handOn, sp0, sp1, spSel }))
    await win.keyboard.press('Space')
    const spOpen = await pane.waitFor({ timeout: 2_000 }).then(() => true, () => false)
    await win.waitForTimeout(450)
    await win.locator('.t2cv-stage').focus()
    await win.keyboard.press('Space')
    const spClose = await pane.waitFor({ state: 'detached', timeout: 2_000 }).then(() => true, () => false)
    r.check('SP2 轻按空格开阅读栏、再按关上', spOpen && spClose, JSON.stringify({ spOpen, spClose }))
    // 中键在卡上拖 = 平移
    await show(R, 'u3')
    const mb = await card(R, 'u3').locator('.t2cv-acard').boundingBox()
    const md0 = await worldXY()
    await win.mouse.move(mb.x + 60, mb.y + 30)
    await win.mouse.down({ button: 'middle' })
    await win.mouse.move(mb.x - 60, mb.y - 20, { steps: 6 })
    await win.mouse.up({ button: 'middle' })
    const md1 = await worldXY()
    r.check('MD1 中键在卡上拖 = 平移', md0.x - md1.x > 80 && md0.y - md1.y > 30, JSON.stringify({ md0, md1 }))
    // 抓手开着:Esc 先退抓手(不关别的)
    await viewPick(/抓手/)
    const hand0 = await win.evaluate(() => document.querySelector('.t2cv').hasAttribute('data-hand'))
    await win.locator('.t2cv-stage').focus()
    await win.keyboard.press('Escape')
    const hand1 = await win.evaluate(() => document.querySelector(".t2cv").hasAttribute("data-hand"))
    r.check('HD1 「视图 → 抓手」开着时 Esc 先退抓手', hand0 && !hand1, JSON.stringify({ hand0, hand1 }))

    // ── 观感:亮 / 暗 / 柔青 ──
    await win.waitForTimeout(500)
    await win.screenshot({ path: path.join(dir, 'look-light.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') })
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(dir, 'look-dark.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'light'; e.classList.remove('dark'); e.dataset.skin = 'teal'; e.dataset.bg = 'teal' })
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(dir, 'look-teal.png') })

    // 「在对话里打开」:切回对话、停在这一支,滚到那一轮的提问
    await show(R, 'u2')
    await card(R, 'u2').locator('.t2cv-q').dblclick()
    await pane.waitFor({ timeout: 5_000 })
    await win.locator('[data-testid="cv-read-chat"]').click()
    await win.waitForFunction(() => !document.querySelector('.t2cv'), null, { timeout: 5_000 })
    // 对话页从底部平滑滚上去:台架跑到这里对话已经很长(前面加过几轮),滚完要一秒多;落稳了那一条会闪一下,等它
    await win.waitForFunction(() => document.getElementById('tocmsg-u2')?.classList.contains('t2-jump-flash'), null, { timeout: 5_000 }).catch(() => {})
    const ic = await win.evaluate(() => {
      const el = document.getElementById('tocmsg-u2'), b = el?.getBoundingClientRect()
      return { found: !!el, top: b ? Math.round(b.top) : null, inView: !!b && b.top > 40 && b.top < window.innerHeight * 0.6, seg: document.querySelector('[data-testid="chat-canvas-seg"] [aria-selected="true"]')?.textContent }
    })
    r.check('RA5 「在对话里打开」:回到对话,那一轮的提问滚进视野', ic.found && ic.inView && /对话|Chat/.test(ic.seg || ''), JSON.stringify(ic))
    // 说明只出前 3 次:第 4 次打开画布不再出,要看点「?」
    await win.evaluate(() => localStorage.setItem('tangu.chatCanvas.hintsSeen', '3'))
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 5_000 })
    await settled()
    r.check('HN1 说明出过 3 次后不再出', (await win.locator('.t2cv-hints').count()) === 0, '')
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
