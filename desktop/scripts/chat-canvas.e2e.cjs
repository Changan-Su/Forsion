/**
 * Chat 画布(方案 docs/ToBeImproved/Chat画布分支方案_2026-10-18 第二步)的真 Electron 台架:
 * 桩引擎回一棵会话树(主线三轮 + 从第一轮分出的两支,分支开头是复制出来的新 id、时间戳和主线对不上)。
 * 断言:对话列头行的「对话 / 画布」胶囊;一轮一个格子(提问卡 + 回答卡)、复制段不重画;竖排(子卡在下、兄弟并排)/ 横排(子卡在右、兄弟上下叠);
 * 卡里是全文、超长的只露预览、「阅读」在右边开全文;「只看这一支」(旁支淡、点了切过去);自动跟随(卡底停在输入框上方)、滚走停跟出箭头、
 * 点箭头飞回并恢复跟随;双击 = 右边阅读栏、卡让开它(方案 Chat画布第三轮);胶囊切回对话只有一份正文;偏好按树根记;
 * ⊕:回答卡下 = 草稿提问卡(卡里写、Enter 建分支并发进去)/ 末尾那张 = 聚焦输入框,提问卡左右 = 换个问法。最后拍亮 / 暗 / 柔青三张,自己看。
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
const b2Msgs = [...copy('d'), msg('d1', 'user', 12, '第一版只做桌面端,模块清单能砍到多少?'), msg('d2', 'model', 13, '砍到三处:同步基线、对账器、合并器。')]
const fMsgs = [msg('f-u', 'user', 0, '冷启动慢了'), msg('f-a', 'model', 1, '先量一下。')]

async function main() {
  const r = makeReporter()
  const dir = shotDir('chat-canvas')
  let projectDir = ''
  const branchCalls = []
  let b3 = null
  const ctx = await launch({
    tag: 'chat-canvas',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method, body }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: [...(b3 ? [b3] : []), ...sessions(projectDir)] } // 真引擎建了分支就会列出来
      let m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: { [R]: rootMsgs, [B1]: b1Msgs, [B2]: b2Msgs, [F1]: fMsgs }[m[1]] || [] }
      m = /^\/agent\/sessions\/([^/]+)\/config$/.exec(p)
      if (m && m[1] === B3 && method === 'GET') { await new Promise((res) => setTimeout(res, 900)); return { agent_config: { execMode: 'host', approvalMode: 'auto-edit', thinkingLevel: 'high' } } }
      m = /^\/agent\/sessions\/([^/]+)\/asides$/.exec(p)
      if (m && method === 'GET') return { asides: [] }
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
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 10_000 })
    await card(R, 'u1').waitFor({ timeout: 10_000 })
    await win.waitForFunction(() => document.querySelectorAll('.t2cv-turn[data-measured]').length >= 5, null, { timeout: 15_000 })
    const shape = await win.evaluate(() => ({
      cards: [...document.querySelectorAll('.t2cv-turn')].map((e) => e.dataset.cvNode),
      bodyHidden: getComputedStyle(document.querySelector('.t2-chat-body')).visibility === 'hidden',
      rail: !!document.querySelector('.t2-rail'),
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
    await win.waitForTimeout(600) // 长卡量完折起之后
    const land = await win.evaluate(() => {
      const t = document.querySelector('.t2cv-card[data-sel]')?.closest('.t2cv-turn')
      const c = t?.getBoundingClientRect()
      const s = document.querySelector('.t2cv-stage').getBoundingClientRect()
      return c && { sel: t.dataset.cvNode, top: Math.round(c.top - s.top), bottom: Math.round(c.bottom - s.top), h: Math.round(s.height) }
    })
    r.check('L1 一打开镜头落在这一支最后一张卡上:整张在视野里、贴着输入框上方(上面露出前几轮,不落进空白)', !!land && land.sel === `${R}:u3` && land.top > 200 && land.bottom <= land.h - 100, JSON.stringify(land))

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
    await win.locator('[data-testid="cv-dir-h"]').click()
    await win.waitForTimeout(500)
    const [hu1, hu2, hc1, hd1] = [await rect(R, 'u1'), await rect(R, 'u2'), await rect(B1, 'c1'), await rect(B2, 'd1')]
    r.check('H1 横排:子卡都在第一张卡右边、同一列', [hu2, hc1, hd1].every((k) => k.x > hu1.r && Math.abs(k.x - hu2.x) < 2), JSON.stringify({ hu1, hu2, hc1, hd1 }))
    r.check('H2 兄弟上下叠、不重叠,第一个子卡与父卡齐顶', hu2.b <= hc1.y && hc1.b <= hd1.y && Math.abs(hu2.y - hu1.y) < 2, '')
    await win.screenshot({ path: path.join(dir, 'canvas-horizontal.png') })
    await win.locator('[data-testid="cv-dir-v"]').click()
    await win.waitForTimeout(400)

    // ── 只看这一支 ──
    await win.locator('[data-testid="cv-focus"]').click()
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
    await win.locator('[data-testid="cv-focus"]').click()
    await row(R).click()
    await win.locator(`.t2s-srow.active[data-sel-id="${R}"]`).waitFor({ timeout: 10_000 })
    await win.waitForTimeout(300)

    // ── 自动跟随:发出一句,生成中的卡跟到输入框上方;滚走就停、出箭头;点箭头飞回并恢复跟随 ──
    ctx.stub.script(Array.from({ length: 70 }, (_, i) => ({ type: 'token', delay: 110, payload: { delta: `第 ${i + 1} 段:提示条的文案、按钮和副本位置。\n\n` } })))
    const ta = win.locator('.t2c-ta').first()
    await ta.click()
    await ta.fill('提示条长什么样?')
    await win.keyboard.press('Enter')
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
    await win.waitForTimeout(200)
    const backOnStage = await win.evaluate(() => document.activeElement?.classList.contains('t2cv-stage'))
    r.check('D3 双击后直接 ↑ 换到上一轮、点「下一轮」后 ↑ 照样翻,Esc 关掉、焦点回舞台', prevKey === `${R}:u1` && nextKey === `${B2}:d1` && prevKey2 === `${R}:u1` && (await pane.count()) === 0 && backOnStage,
      JSON.stringify({ prevKey, nextKey, prevKey2, backOnStage }))
    await seg.getByRole('tab').nth(0).click()
    await win.waitForFunction(() => !document.querySelector('.t2cv'), null, { timeout: 5_000 })
    // 画布开着换过会话(F2 点淡卡、D1 双击别的支)后对话列里只能有一份正文:卡和正文同 key 时旧会话那份留在 DOM 里,上下叠成两个对话窗口(10-20 用户报)
    const bodyCount = await win.locator('.t2-chat-col > .t2-chat-body').count()
    r.check('D2 胶囊切回对话 = 正在看的这一支,只有一份正文(画布开着换会话不留旧的)', bodyCount === 1 && (await win.locator('#tocmsg-d1').count()) === 1, String(bodyCount))

    // ── 偏好按树根记:分支里切回画布 → 换到无关会话是对话 → 回到这棵树的主线还是画布 ──
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 5_000 })
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

    // ── 观感:亮 / 暗 / 柔青 ──
    await win.waitForTimeout(500)
    await win.screenshot({ path: path.join(dir, 'look-light.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') })
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(dir, 'look-dark.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'light'; e.classList.remove('dark'); e.dataset.skin = 'teal'; e.dataset.bg = 'teal' })
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(dir, 'look-teal.png') })
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
