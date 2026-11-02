/**
 * Chat 画布里的子会话(方案 docs/ToBeImproved/画布子会话显示方案_2026-10-26,A)的真 Electron 台架:
 * 桩引擎回一棵树(主线三轮 + 从第一轮分出一支),第二轮回答用 start_session 开了两个子会话:K1 做完了(两轮)、K2 在等你。
 * 断言:缺省开着,子会话整支挂在开出它的回答卡下(主线、分支之后),简报卡标「子会话 · 标题 · 状态」、线是 kid 那份灰;
 * 那张回答卡底的「从这里分出」不再列它们(对话页照列);子会话卡上没有换个问法 / 从这里分支;单击 = 主区切到子会话、画布留在这棵树上;
 * 等你的那个最后一张卡底「去回复 / 让 Tangu 回答」(后者发给主会话);「视图」里关掉 = 卡没了、卡底那块又列回来、记进本机;
 * 没有子会话的对话这项置灰。最后拍亮 / 暗 / 柔青三张,自己看。
 * 量的是 out/ 产物:改了源码先 `npm run build`。
 *   node ../.claude/hooks/devlock.cjs run --vehicle=e2e --what="画布子会话台架" --eta=2 -- node scripts/chat-canvas-kids.e2e.cjs
 *   SHOT_DIR=… 指定截图目录;LANG_EN=1 拍英文
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir } = require('./lib/uiux-electron.cjs')

const R = '6d1e0a52-0000-4000-8000-0000000000a1'
const B1 = '6d1e0a52-0000-4000-8000-0000000000b1'
const K1 = '6d1e0a52-0000-4000-8000-0000000000c1'
const K2 = '6d1e0a52-0000-4000-8000-0000000000c2'
const F1 = '6d1e0a52-0000-4000-8000-0000000000f1'
const T = Date.now() - 60 * 60_000
const T1 = '查 Obsidian Sync 怎么处理冲突', T2 = '数一数笔记库里的大文件'

let k1Bump = false // 主会话再派给 K1 一轮(send_to_session):K1 的 updated_at 变了、多两条消息
function sessions(dir) {
  const base = { summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: dir, project_name: 'Forsion', projectless: false }
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = (id, title, mins, more = {}) => ({ ...base, id, title, created_at: at(mins + 60), updated_at: at(mins), ...more })
  return [
    row(R, 'Amadeus 离线同步怎么做', 1),
    row(B1, '如果用 CRDT', 2, { parent_session_id: R, fork_message_id: 'a1', fork_session_id: R, created_at: at(20) }),
    row(K1, T1, k1Bump ? 0 : 3, { parent_session_id: R, created_at: at(16) }),
    row(K2, T2, 4, { parent_session_id: R, created_at: at(15), awaiting_user: true }),
    row(F1, '桌面端冷启动慢了 0.8 秒', 6),
  ]
}
const msg = (id, role, mins, content, more = {}) => ({ id, role, timestamp: T + mins * 60_000, content, ...more })
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const started = (id, title, sid) => ({ tool_call_id: id, name: 'start_session', content: `Started child session "${title}" (id ${sid}). It is working on its own.`, isError: false })
const rootMsgs = [
  msg('u1', 'user', 0, 'Amadeus 想做离线同步:两台设备离线时都改了同一篇笔记,回来怎么合?'),
  msg('a1', 'model', 1, '三条路线,按改动从小到大:按行三方合并、CRDT、后写的赢。建议走 1。'),
  msg('u2', 'user', 2, '按行三方合并展开说,要改哪些模块?'),
  msg('a2', 'model', 3, '五块:同步基线、对账器、合并器、冲突提示、测试。我另开两个子会话去查 Obsidian 的做法、数一下大文件。', {
    tool_calls: [call('s1', 'start_session', { title: T1, message: 'brief' }), call('s2', 'start_session', { title: T2, message: 'brief' })],
    tool_results: [started('s1', T1, K1), started('s2', T2, K2)],
  }),
  msg('u3', 'user', 4, '合不了的时候,用户看到的是什么?'),
  msg('a3', 'model', 5, '笔记顶部出现一条提示,带两个按钮 —— 逐处比较、保留这边的。'),
]
const b1Msgs = [msg('b-u1', 'user', -30, rootMsgs[0].content), msg('b-a1', 'model', -29, rootMsgs[1].content), msg('c1', 'user', 10, '如果改用 Yjs 呢?'), msg('c2', 'model', 11, 'Yjs 永远合得上,代价是多一份操作记录。')]
const k1Msgs = [
  msg('k1u1', 'user', 3.2, '查一下 Obsidian Sync 在两台设备离线改了同一篇笔记时怎么处理,结论写成三五行。'),
  msg('k1a1', 'model', 3.6, '文本按段合并,合不上另存一份冲突副本;附件不合并,后写的赢。'),
  msg('k1u2', 'user', 6, '附件那条有没有被抱怨过丢数据?'),
  msg('k1a2', 'model', 7, '有,官方的回答是去版本历史里找回。'),
]
const k1More = [msg('k1u3', 'user', 20, '再查一下 Obsidian 的版本历史保留多久。'), msg('k1a3', 'model', 21, '官方说保留一年。')]
const k2Msgs = [
  msg('k2u1', 'user', 3.3, '数一下当前笔记库里超过 2 MB 的笔记和附件各有多少。只读,别动任何文件。'),
  msg('k2a1', 'model', 4.5, '超过 2 MB 的:笔记 3 篇、附件 41 个。录屏这 6 个要算进同步范围吗?'),
]

async function main() {
  const r = makeReporter()
  const dir = shotDir('chat-canvas-kids')
  let projectDir = ''
  const ctx = await launch({
    tag: 'chat-canvas-kids',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: sessions(projectDir) }
      let m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: { [R]: rootMsgs, [B1]: b1Msgs, [K1]: k1Bump ? [...k1Msgs, ...k1More] : k1Msgs, [K2]: k2Msgs }[m[1]] || [] }
      m = /^\/agent\/sessions\/([^/]+)\/asides$/.exec(p)
      if (m && method === 'GET') return { asides: [] }
      m = /^\/agent\/sessions\/([^/]+)\/detail$/.exec(p)
      if (m) { const s = sessions(projectDir).find((x) => x.id === m[1]); if (s) return { session: { ...s, kind: 'user', delegate_running: false } } }
      return undefined
    },
  })
  projectDir = ctx.projectDir
  const { win } = ctx
  win.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  const turn = (sid, mid) => win.locator(`.t2cv-turn[data-cv-node="${sid}:${mid}"]`)
  const box = (sid, mid) => turn(sid, mid).evaluate((e) => ({ x: parseFloat(e.style.left), y: parseFloat(e.style.top) }))
  const active = () => win.evaluate(() => document.querySelector('.t2-chat-view')?.dataset.sessionId)
  const viewItem = async (re) => {
    await win.locator('[data-testid="cv-view"]').click()
    await win.locator('.ctx-menu').waitFor({ timeout: 5_000 })
    return win.locator('.ctx-menu .ctx-item').filter({ hasText: re }).first()
  }
  const closeMenu = async () => { await win.keyboard.press('Escape'); await win.locator('.ctx-menu').waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {}) }
  const kidRows = (scope) => win.locator(`${scope} .t2-child-row[data-child-session]`).count()
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1440, height: 900 })
    if (process.env.LANG_EN) await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.evaluate(() => { localStorage.setItem('tangu.chatCanvas.hintsSeen', '3'); localStorage.removeItem('tangu.chatCanvas.children') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    const row = (id) => win.locator(`.t2s-srow[data-sel-id="${id}"]`).first()
    await row(R).waitFor({ timeout: 20_000 })
    await row(R).click()
    await win.locator('#tocmsg-a3').waitFor({ timeout: 15_000 })
    // 对话页:那条回答下面照列两个子会话(没变)
    await win.waitForFunction(() => document.querySelectorAll('.t2-chat-body .t2-child-row[data-child-session]').length === 2, null, { timeout: 8_000 }).catch(() => {})
    const chatRows = await kidRows('.t2-chat-body')

    const seg = win.locator('.t2-chat-col > .lcl-viewhead [data-testid="chat-canvas-seg"]')
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 8_000 })
    await turn(K2, 'k2u1').waitFor({ timeout: 8_000 })
    await win.waitForTimeout(800)

    // ── 缺省开:子会话整支进树 ──
    const nodes = await win.evaluate(() => [...document.querySelectorAll('.t2cv-turn')].map((e) => e.dataset.cvNode))
    const want = [`${R}:u1`, `${R}:u2`, `${R}:u3`, `${B1}:c1`, `${K1}:k1u1`, `${K1}:k1u2`, `${K2}:k2u1`]
    r.check('KD1 缺省开:主线三轮 + 一支 + 子会话 K1 两轮、K2 一轮,一轮一张卡', nodes.length === want.length && want.every((k) => nodes.includes(k)), JSON.stringify(nodes))
    const u3 = await box(R, 'u3'), k1 = await box(K1, 'k1u1'), k2 = await box(K2, 'k2u1'), k1b = await box(K1, 'k1u2')
    r.check('KD2 子会话挂在开出它的第二轮下:和主线下一轮同一行,排在主线之后、按开出的先后;第二轮长在下面',
      Math.abs(k1.y - u3.y) < 2 && Math.abs(k2.y - u3.y) < 2 && u3.x < k1.x && k1.x < k2.x && k1b.y > k1.y && Math.abs(k1b.x - k1.x) < 2, JSON.stringify({ u3, k1, k2, k1b }))
    const head = await turn(K1, 'k1u1').evaluate((e) => ({
      kid: e.dataset.kid, label: e.querySelector('[data-testid="cv-kid-label"]')?.textContent || '',
      qbg: getComputedStyle(e.querySelector('.t2cv-qcard')).backgroundColor, card: getComputedStyle(document.querySelector('.t2cv-acard')).backgroundColor,
      adds: e.querySelectorAll('.t2cv-qcard .t2cv-add').length, branchBtn: e.querySelectorAll('[data-testid="msg-branch"]').length,
    }))
    r.check('KD3 简报卡:标「子会话 · 标题 · 做完了」+「简报」,底色同回答卡(不染强调色);没有换个问法 ⊕、没有「从这里分支」',
      head.kid === 'head' && head.label.includes(T1) && /做完了|Finished/.test(head.label) && /简报|Brief/.test(head.label) && head.qbg === head.card && head.adds === 0 && head.branchBtn === 0, JSON.stringify(head))
    const more = await turn(K1, 'k1u2').evaluate((e) => ({ kid: e.dataset.kid, label: e.querySelector('.t2cv-qlabel')?.textContent }))
    r.check('KD4 子会话里你自己追问的那一轮照常标「你」', more.kid === '' && /你|You/.test(more.label || ''), JSON.stringify(more))
    const edges = await win.evaluate(() => ({ kid: document.querySelectorAll('.t2cv-edges path.kid').length, all: document.querySelectorAll('.t2cv-edges path').length }))
    r.check('KD5 连到子会话的三根线是 kid 那份(灰),其余照旧', edges.kid === 3 && edges.all === 6, JSON.stringify(edges))
    const canvasRows = await kidRows('.t2cv')
    r.check('KD6 开着时:第二轮卡底「从这里分出」不再列子会话;对话页那块照列', canvasRows === 0 && chatRows === 2, JSON.stringify({ canvasRows, chatRows }))
    const waitCard = await turn(K2, 'k2u1').evaluate((e) => ({ st: e.querySelector('.t2cv-kidst')?.dataset.st, acts: [...e.querySelectorAll('.t2cv-kidacts button')].map((b) => b.textContent.trim()) }))
    r.check('KD7 等你的那个:标签行「等你回复」,最后一张卡底「去回复 / 让 Tangu 回答」', waitCard.st === 'wait' && waitCard.acts.length === 2, JSON.stringify(waitCard))

    // ── 观感 ──
    await win.screenshot({ path: path.join(dir, 'kids-light.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') })
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(dir, 'kids-dark.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'light'; e.classList.remove('dark'); e.dataset.skin = 'teal'; e.dataset.bg = 'teal' })
    await win.waitForTimeout(400)
    await win.screenshot({ path: path.join(dir, 'kids-teal.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.skin = 'cream'; e.dataset.bg = 'cream' })

    // ── 单击子会话的卡 = 主区切过去,画布留在这棵树上 ──
    await turn(K1, 'k1u2').locator('.t2cv-q').click()
    await win.waitForTimeout(600)
    const a1 = await active()
    const still = await win.evaluate(() => ({ canvas: !!document.querySelector('.t2cv'), n: document.querySelectorAll('.t2cv-turn').length, hot: document.querySelectorAll('.t2cv-turn[data-hot]').length }))
    r.check('KD8 单击子会话的卡:主区切到子会话,画布还是这棵树(卡一张不少)', a1 === K1 && still.canvas && still.n === want.length, JSON.stringify({ a1, still }))

    // ── 去回复:切到 K2、输入框拿到焦点 ──
    await turn(K2, 'k2u1').locator('.t2cv-kidacts button').first().click()
    await win.waitForTimeout(500)
    const a2 = await active()
    const focused = await win.evaluate(() => !!document.activeElement?.closest('.composer-anchor'))
    r.check('KD9 「去回复」:主区切到等你的子会话,输入框拿到焦点', a2 === K2 && focused, JSON.stringify({ a2, focused }))

    // ── 让 Tangu 回答:发给主会话 ──
    const runs0 = ctx.stub.seen.runs.length
    await turn(K2, 'k2u1').locator('.t2cv-kidacts button').nth(1).click()
    for (let i = 0; i < 30 && ctx.stub.seen.runs.length === runs0; i++) await win.waitForTimeout(200)
    const run = ctx.stub.seen.runs[runs0]
    r.check('KD10 「让 Tangu 回答」:一句话发给主会话(不是子会话)', !!run && run.sessionId === R && String(run.message || '').includes(T2), JSON.stringify(run && { sid: run.sessionId, msg: String(run.message).slice(0, 60) }))
    await win.waitForTimeout(800)

    // ── 视图里关掉 ──
    const off = await viewItem(/隐藏子会话|Hide child sessions/)
    const offOk = (await off.count()) === 1
    await off.click()
    await win.locator('.ctx-menu').waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {})
    await win.waitForTimeout(600)
    const afterOff = await win.evaluate(() => ({ n: document.querySelectorAll('.t2cv-turn').length, kid: document.querySelectorAll('.t2cv-turn[data-kid]').length, pref: localStorage.getItem('tangu.chatCanvas.children') }))
    const canvasRowsOff = await kidRows('.t2cv')
    const a3 = await active()
    r.check('KD11 正看着子会话时「隐藏子会话」:回到开出它的主会话、画布还在,子会话的卡没了、卡底那块又列回两个、记进本机',
      offOk && a3 === R && afterOff.n >= 4 && afterOff.kid === 0 && canvasRowsOff === 2 && afterOff.pref === '0', JSON.stringify({ offOk, a3, afterOff, canvasRowsOff }))
    const on = await viewItem(/显示子会话|Show child sessions/)
    await on.click()
    await turn(K2, 'k2u1').waitFor({ timeout: 5_000 })
    r.check('KD12 再开回来:子会话的卡回来', (await win.locator('.t2cv-turn[data-kid]').count()) === 3, '')

    // ── 阅读栏:从子会话第一轮按「上一轮」到主线那张,主区不被切回主会话,「下一轮」回到子会话 ──
    await turn(K1, 'k1u1').locator('.t2cv-q').click()
    await win.waitForTimeout(400)
    await turn(K1, 'k1u1').locator('.t2cv-q').dblclick()
    await win.locator('[data-testid="cv-read"]').waitFor({ timeout: 5_000 })
    await win.keyboard.press('ArrowUp')
    await win.waitForTimeout(500)
    const up = { active: await active(), key: await win.locator('[data-testid="cv-read"]').getAttribute('data-cv-read') }
    await win.keyboard.press('ArrowDown')
    await win.waitForTimeout(500)
    const down = await win.locator('[data-testid="cv-read"]').getAttribute('data-cv-read')
    const branchDis = await win.locator('[data-testid="cv-read-branch"]').evaluate((b) => b.disabled).catch(() => 'none')
    r.check('KD14 阅读栏:子会话第一轮按 ↑ 到主线那张,主区还是子会话;↓ 回到子会话;子会话的轮里「从这里分支」不可用',
      up.active === K1 && up.key === `${R}:u2` && down === `${K1}:k1u1` && branchDis === true, JSON.stringify({ up, down, branchDis }))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    // ── 主会话开着时,子会话在后台又跑了一轮:画布跟着长出来 ──
    await row(R).click() // 左栏点主会话(镜头这时可能把主线那几张挪到左栏后面去了)
    await win.waitForTimeout(600)
    const a4 = await active()
    k1Bump = true
    const grew = await turn(K1, 'k1u3').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)
    r.check('KD15 正看着主会话时子会话后台又跑一轮:新的一轮出现在画布上', a4 === R && grew, JSON.stringify({ a4, grew }))

    // ── 没有子会话的对话:这项置灰 ──
    await row(F1).click()
    await win.waitForTimeout(800)
    if (!(await win.locator('.t2cv').count())) { await seg.getByRole('tab').nth(1).click(); await win.locator('.t2cv').waitFor({ timeout: 5_000 }) }
    const it = await viewItem(/显示子会话|Show child sessions|隐藏子会话|Hide child sessions/)
    const dis = await it.evaluate((e) => e.disabled || e.getAttribute('aria-disabled') === 'true' || e.hasAttribute('data-disabled'))
    await closeMenu()
    r.check('KD13 没有子会话的对话:这项置灰', dis, String(dis))
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
