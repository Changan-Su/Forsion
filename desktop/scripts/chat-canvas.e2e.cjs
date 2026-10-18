/**
 * Chat 画布(方案 docs/ToBeImproved/Chat画布分支方案_2026-10-18 第二步)的真 Electron 台架:
 * 桩引擎回一棵会话树(主线三轮 + 从第一轮分出的两支,分支开头是复制出来的新 id、时间戳和主线对不上)。
 * 断言:标签栏右端「对话 / 画布」胶囊;一轮一张卡、复制段不重画;竖排(子卡在下、兄弟并排)/ 横排(子卡在右、兄弟上下叠);
 * 卡里是全文、超长的折起后原地展开;「只看这一支」(旁支淡、点了切过去);自动跟随(卡底停在输入框上方)、滚走停跟出箭头、
 * 点箭头飞回并恢复跟随;双击回对话滚到那一轮;偏好按树根记。最后拍亮 / 暗 / 柔青三张,自己看。
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
  const ctx = await launch({
    tag: 'chat-canvas',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: sessions(projectDir) }
      let m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: { [R]: rootMsgs, [B1]: b1Msgs, [B2]: b2Msgs, [F1]: fMsgs }[m[1]] || [] }
      m = /^\/agent\/sessions\/([^/]+)\/asides$/.exec(p)
      if (m && method === 'GET') return { asides: [] }
      m = /^\/agent\/sessions\/([^/]+)\/detail$/.exec(p)
      if (m) { const s = sessions(projectDir).find((x) => x.id === m[1]); if (s) return { session: { ...s, kind: 'user', delegate_running: false } } }
      return undefined
    },
  })
  projectDir = ctx.projectDir
  const { win } = ctx
  const card = (sid, mid) => win.locator(`.t2cv-card[data-cv-node="${sid}:${mid}"]`)
  const rect = (sid, mid) => card(sid, mid).evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height } })
  // 生成中那张卡的底边离「阅读线」(输入框上沿再往上 28px)多远;正数 = 卡底在线上面
  const readGap = (sel) => win.evaluate((sel) => {
    const host = document.querySelector('.t2cv-stage')
    const el = document.querySelector(sel)
    if (!host || !el) return null
    const u = host.currentCSSZoom || 1
    const ch = parseFloat(getComputedStyle(host).getPropertyValue('--t2-composer-h')) || 96
    return Math.round(host.getBoundingClientRect().bottom - (ch + 28) * u - el.getBoundingClientRect().bottom)
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
    const seg = win.locator('.dv-view-chrome [data-testid="chat-canvas-seg"]')
    await seg.waitFor({ timeout: 10_000 })
    const segBox = await seg.evaluate((e) => { const b = e.getBoundingClientRect(); return { top: b.top, right: b.right, inTabbar: !!e.closest('.dv-tabs-and-actions-container'), w: window.innerWidth } })
    r.check('E1 胶囊在主区标签栏右端', segBox.inTabbar && segBox.top < 40 && segBox.right > segBox.w * 0.6, JSON.stringify(segBox))
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 10_000 })
    await card(R, 'u1').waitFor({ timeout: 10_000 })
    await win.waitForFunction(() => document.querySelectorAll('.t2cv-card[data-measured]').length >= 5, null, { timeout: 15_000 })
    const shape = await win.evaluate(() => ({
      cards: [...document.querySelectorAll('.t2cv-card')].map((e) => e.dataset.cvNode),
      bodyHidden: getComputedStyle(document.querySelector('.t2-chat-body')).visibility === 'hidden',
      rail: !!document.querySelector('.t2-rail'),
      edges: document.querySelectorAll('.t2cv-edges path').length,
      segOn: document.querySelector('[data-testid="chat-canvas-seg"] [aria-selected="true"]')?.textContent,
    }))
    r.check('E2 切到画布:对话流藏起来,右侧车道收起', shape.bodyHidden && !shape.rail, JSON.stringify(shape))
    r.check('C1 一轮一张卡:主线三轮 + 两支各一轮,复制段不重画', shape.cards.length === 5 && [`${R}:u1`, `${R}:u2`, `${R}:u3`, `${B1}:c1`, `${B2}:d1`].every((k) => shape.cards.includes(k)), JSON.stringify(shape.cards))
    r.check('C2 四根线(每张非根卡一根)', shape.edges === 4, String(shape.edges))
    const q = await card(B1, 'c1').locator('.t2cv-q').textContent()
    r.check('C3 卡头是问题,卡里是真消息渲染', q.includes('Yjs') && (await card(B1, 'c1').locator('.t2-content').count()) === 1, q)

    // ── 竖排(缺省):子卡在下、兄弟并排 ──
    const [u1, u2, c1, d1] = [await rect(R, 'u1'), await rect(R, 'u2'), await rect(B1, 'c1'), await rect(B2, 'd1')]
    r.check('V1 竖排:三个子卡都在第一张卡下面、同一行并排', [u2, c1, d1].every((k) => k.y > u1.b && Math.abs(k.y - u2.y) < 2) && u2.r <= c1.x && c1.r <= d1.x, JSON.stringify({ u1, u2, c1, d1 }))
    r.check('V2 父卡在子卡们正上方居中', Math.abs((u1.x + u1.r) / 2 - (u2.x + d1.r) / 2) < 3, '')
    await win.screenshot({ path: path.join(dir, 'canvas-vertical.png') })

    // ── 全文 / 折起 ──
    const a3 = await card(R, 'u3').locator('.t2-content').textContent()
    r.check('R1 卡里直接是全文', a3.includes('逐处比较、保留这边的'), a3.slice(0, 60))
    const fold = card(R, 'u2').locator('.t2cv-more')
    r.check('R2 超长回答在卡里折起,底部「展开全文」', (await fold.count()) === 1 && (await card(R, 'u2').locator('.t2cv-body[data-folded]').count()) === 1, '')
    const hFolded = (await rect(R, 'u2')).h
    await fold.click()
    await win.waitForFunction((k) => !document.querySelector(`.t2cv-card[data-cv-node="${k}"] .t2cv-body[data-folded]`), `${R}:u2`, { timeout: 5_000 })
    await win.waitForTimeout(400)
    const hFull = (await rect(R, 'u2')).h
    const u3After = await rect(R, 'u3')
    r.check('R3 原地展开:卡变高,下面那张跟着让位', hFull > hFolded + 200 && u3After.y > (await rect(R, 'u2')).b, JSON.stringify({ hFolded, hFull }))

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
    const dims = () => win.evaluate(() => [...document.querySelectorAll('.t2cv-card[data-dim]')].map((e) => e.dataset.cvNode).sort())
    const d0 = await dims()
    r.check('F1 只看这一支:不在当前这一支(主线)上的两支变淡', JSON.stringify(d0) === JSON.stringify([`${B1}:c1`, `${B2}:d1`].sort()), JSON.stringify(d0))
    await win.screenshot({ path: path.join(dir, 'canvas-focus.png') })
    await card(B1, 'c1').locator('.t2cv-q').click()
    await win.locator(`.t2s-srow.active[data-sel-id="${B1}"]`).waitFor({ timeout: 10_000 })
    await win.waitForTimeout(300)
    const d1x = await dims()
    r.check('F2 点淡的那张 = 切到那一支(主区就地换),它亮、主线后两轮淡', JSON.stringify(d1x) === JSON.stringify([`${R}:u2`, `${R}:u3`, `${B2}:d1`].sort()) && !!(await win.locator('.t2cv').count()), JSON.stringify(d1x))
    const hot = await win.evaluate(() => document.querySelectorAll('.t2cv-edges path.hot').length)
    r.check('F3 选中卡到树根那一路的线加深', hot === 1 && (await card(B1, 'c1').getAttribute('data-sel')) === '', String(hot))
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
    const live = '.t2cv-card[data-streaming]'
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
    await win.waitForFunction(() => !document.querySelector('.t2cv-card[data-streaming]'), null, { timeout: 20_000 })
    r.check('A4 跑完:新的一轮长在主线最后一张卡下面', (await win.locator(`.t2cv-card[data-cv-node^="${R}:"]`).count()) === 4, '')

    // ── 双击:回对话,滚到那一轮 ──
    await card(B2, 'd1').locator('.t2cv-q').dblclick()
    await win.locator(`.t2s-srow.active[data-sel-id="${B2}"]`).waitFor({ timeout: 10_000 })
    await win.waitForFunction(() => !document.querySelector('.t2cv'), null, { timeout: 5_000 })
    const inView = await win.locator('#tocmsg-d1').evaluate((e) => { const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight })
    r.check('D1 双击 = 切回对话、换到那一支、滚到那一轮', inView && (await seg.locator('[aria-selected="true"]').textContent()) !== shape.segOn, '')

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
