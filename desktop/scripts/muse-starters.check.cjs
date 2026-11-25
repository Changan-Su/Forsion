// Muse 开场建议 + 空对话居中 → 首发落底(MuseStarters.tsx / EmptyState2.tsx / freshLayout.ts;方案页 docs/ToBeImproved/Muse预制提示词方案_2026-10-25)
// 真 Electron × 桩引擎(桩回三条开场建议,记下 PATCH):
//   ① 三行画在 Chat Box 正下方,句子里的 label 是链接;Muse 自己的那条不画成链接
//   ② 空对话时「空状态 + 输入区」整块居中(上下留白差 ≤ 4px)
//   ③ 点一行 = 填进输入框、焦点给输入框、三行淡出但居中的那一块不动;删空草稿三行回来
//   ④ × = 从眼前拿掉 + 回写 dismissed
//   ⑤ 按 Enter:输入区落底的动画 420ms、从居中处(上抬 >100px)回到 0,空状态淡出;播完贴底;回写 used
//   ⑥ 从有消息的会话点「新对话」:输入区从底部升到中间
//   ⑦ 没发出去:输入区留在底部,空状态淡回来,草稿还在
//   ⑧ 引擎慢(受理要 3s):按下 600ms 时输入区已经在底部(不等受理)
//   ⑨ 减少动态效果:不出位移动画,直接到位
//   ⑩ 不画建议的右栏对话(Tangu「显示对话面板」):输入框贴底、不上抬;主区照旧居中(11-23)
//   ⑪ 窗口拖窄到主区很窄:主区建议照画(两行)→ 照旧居中;右栏跨尺寸一直贴底
//   ⑫ Amadeus 右栏缺省宽:同 ⑩
//   ⑬ 从右栏发第一句:不出落底动画;气泡起点在输入框那一行
// 用法:npm run check:musestarters(先 npx electron-vite build);NARROW_SHOTS=<目录> 时拍 ⑩–⑫ 的整窗截图
// 「居中与否」与「画不画建议」读同一个位置判定(freshLayout.ts startersPlace),单测在 freshLayout.test.ts
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U

const STARTERS = [
  { id: 's1', text: '明天 10:00 的「产品周会」还没有议程。按本周开发日志起一份议程。', source: { kind: 'calendar', label: '产品周会', ref: '2026-10-26' } },
  { id: 's2', text: '「蓬洲云同步简化方案」三天没动了。把剩下的待定项列成清单。', source: { kind: 'note', label: '蓬洲云同步简化方案', ref: 'Projects/蓬洲云同步简化方案.md' } },
  { id: 's3', text: '每周一为「AI 学习仪表盘」规划一个开发里程碑，附实现建议和验收标准。', source: { kind: 'muse', label: 'AI 学习仪表盘' } },
]
const MESSAGES = [
  { id: 'm1', role: 'user', content: '上周的会议纪要整理好了吗?', timestamp: 1 },
  { id: 'm2', role: 'model', content: '整理好了,放在笔记库里。', timestamp: 2 },
]

let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  | ${JSON.stringify(detail)}`}`) }

// 拦下页面里每一个 element.animate:__hold 时暂停并记下(同 check:sendflight)
const HOOK = () => {
  window.__anims = []
  if (window.__animHooked) return
  window.__animHooked = true
  const orig = Element.prototype.animate
  Element.prototype.animate = function (k, o) {
    const a = orig.call(this, k, o)
    window.__anims.push({ el: this, a, k, o })
    if (window.__hold) a.pause()
    return a
  }
}
const release = (win) => win.evaluate(() => { window.__hold = false; window.__anims.forEach(({ a }) => { try { a.play() } catch { /* 已结束 */ } }) })

const geom = (win) => win.evaluate(() => {
  const col = [...document.querySelectorAll('.t2-chat-col')].filter((e) => e.offsetParent).sort((a, b) => b.offsetWidth - a.offsetWidth)[0]
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, height: b.height } }
  const anchor = col.querySelector(':scope > .composer-anchor')
  const empty = col.querySelector(':scope > .t2-empty')
  return {
    col: r(col), anchor: r(anchor), card: r(anchor.querySelector('.t2c-card')), empty: r(empty), starters: r(anchor.querySelector('.t2-starters')),
    translate: anchor.style.translate || '',
    emptyOpacity: empty ? getComputedStyle(empty).opacity : null,
    rows: [...anchor.querySelectorAll('.t2-starter')].map((x) => ({ kind: x.dataset.kind, link: x.querySelector('.t2-starter-link')?.textContent || '', static: !!x.querySelector('.t2-starter-link[data-static]') })),
    hidden: anchor.querySelector('.t2-starters')?.hasAttribute('data-hidden') ?? null,
    ta: anchor.querySelector('.t2c-ta')?.value ?? null,
    focused: document.activeElement === anchor.querySelector('.t2c-ta'),
    users: col.querySelectorAll('.t2-userwrap').length,
  }
})
// 落底 / 升起的那段动画:作用在 .composer-anchor 上、关键帧写 translate 的那一个
const liftAnim = (win) => win.evaluate(() => {
  const x = [...window.__anims].reverse().find(({ el, k }) => el.classList?.contains('composer-anchor') && Array.isArray(k) && String(k[0]?.translate || '').length)
  if (!x) return null
  const px = (v) => -parseFloat(String(v).split(' ')[1] || '0')
  return { from: px(x.k[0].translate), to: px(x.k[1].translate), duration: x.o?.duration, easing: x.o?.easing }
})
// 按承载形态量(主区 chat / 右栏 chat-panel 同时挂着时,别用整页选择器):只量看得见的那一个
const surf = (win, kind) => win.evaluate((kind) => {
  const view = [...document.querySelectorAll(`[data-chat-surface="${kind}"]`)].find((e) => e.offsetParent && e.getBoundingClientRect().width > 0)
  const col = view?.querySelector('.t2-chat-col')
  const anchor = col?.querySelector(':scope > .composer-anchor')
  if (!col || !anchor) return null
  const c = col.getBoundingClientRect(), a = anchor.getBoundingClientRect()
  const empty = col.querySelector(':scope > .t2-empty')
  const e = empty?.getBoundingClientRect()
  return {
    width: Math.round(c.width), colH: Math.round(c.height),
    empty: !!empty, starters: !!anchor.querySelector('.t2-starters'), rows: anchor.querySelectorAll('.t2-starter').length,
    translate: anchor.style.translate || '',
    anchorTop: Math.round(a.top - c.top), cardTop: Math.round((anchor.querySelector('.t2c-card') || anchor).getBoundingClientRect().top - c.top),
    topGap: e ? Math.round(e.top - c.top) : null, bottomGap: Math.round(c.bottom - a.bottom),
  }
}, kind)
const brief = (s) => s && { w: s.width, h: s.colH, rows: s.rows, starters: s.starters, translate: s.translate, cardTop: s.cardTop, topGap: s.topGap, bottomGap: s.bottomGap }
const emptyFaded = (win) => win.evaluate(() => window.__anims.some(({ el, k }) => el.classList?.contains('t2-empty') && Array.isArray(k) && k[k.length - 1]?.opacity === 0))

;(async () => {
  const patches = []
  const gets = []
  const { app, win, stub, close } = await U.launch({
    tag: 'musestarters',
    messages: MESSAGES,
    stubOverride: async ({ path: p, method, body }) => {
      if (p === '/agent/special/muse/starters' && method === 'GET') {
        gets.push(Date.now())
        const gone = new Set(patches.map((x) => x.id))
        return { starters: STARTERS.filter((s) => !gone.has(s.id)) }
      }
      const m = /^\/agent\/special\/muse\/starters\/([^/]+)$/.exec(p)
      if (m && method === 'PATCH') { patches.push({ id: m[1], ...(await body()) }); return { ok: true } }
      return undefined
    },
  })
  try {
    await U.boot(app, win, { space: 'tangu', width: 1400, height: 900 })
    await win.evaluate(HOOK)
    // 有夹具会话时启动会落在某个会话里:先开一个新对话
    await win.getByRole('button', { name: /^新会话$|^新对话$/ }).first().click({ timeout: 10_000 })
    await win.waitForSelector('.t2-starter', { timeout: 15_000 }).catch(async (e) => {
      const dom = await win.evaluate(() => ({
        anchor: [...document.querySelectorAll('.composer-anchor > *')].map((x) => x.className),
        opening: !!document.querySelector('.newchat-projectbar'),
        cache: localStorage.getItem('forsion_muse_starters'),
      }))
      console.log('DIAG', JSON.stringify({ gets: gets.length, dom }))
      throw e
    })
    await sleep(600)

    // ① ②
    let g = await geom(win)
    check('① 三行画在 Chat Box 正下方', g.rows.length === 3 && g.starters && g.card && g.starters.top >= g.card.bottom - 1, { rows: g.rows.length, starters: g.starters, card: g.card })
    check('① label 画成链接;Muse 自己的那条不是链接', g.rows[0].link.startsWith('产品周会') && !g.rows[0].static && g.rows[2].static, g.rows)
    const topGap = g.empty.top - g.col.top, bottomGap = g.col.bottom - g.anchor.bottom
    check('② 空对话:空状态 + 输入区整块居中', !!g.translate && Math.abs(topGap - bottomGap) <= 4, { topGap, bottomGap, translate: g.translate })

    // ③
    const before = g
    await win.locator('.t2-starter').nth(1).click()
    await sleep(600)
    g = await geom(win)
    check('③ 点一行 = 整句填进输入框,焦点在输入框', g.ta === STARTERS[1].text && g.focused, { ta: g.ta, focused: g.focused })
    // 三行只淡出、高度留着;卡片因挂上笔记引用变高,整块按新高度重新居中 = 上移卡片增高的一半(别的都不该动)
    const grew = g.card.height - before.card.height
    check('③ 三行淡出但留着高度,整块只因卡片变高重新居中', g.hidden === true && Math.abs(g.starters.height - before.starters.height) <= 1 && Math.abs((before.card.top - g.card.top) - grew / 2) <= 2,
      { hidden: g.hidden, rows: [before.starters.height, g.starters.height], cardGrew: grew, moved: before.card.top - g.card.top })
    await win.locator('.composer-anchor .t2c-ta').first().fill('')
    await sleep(300)
    g = await geom(win)
    check('③ 删空草稿,三行回来', g.hidden === false && g.rows.length === 3)

    // ④
    await win.locator('.t2-starter').first().hover()
    await win.locator('.t2-starter').first().locator('.t2-starter-x').click()
    await sleep(400)
    g = await geom(win)
    check('④ × = 拿掉 + 回写 dismissed', g.rows.length === 2 && patches.some((x) => x.id === 's1' && x.status === 'dismissed'), { rows: g.rows.length, patches })

    if (process.env.SHOTS) {
      await win.locator('.t2-starter').nth(0).hover()
      await sleep(300)
      await win.screenshot({ path: `${process.env.SHOTS}/real-rest.png`, scale: 'css' })
      for (const mode of ['dark']) {
        await win.evaluate((m) => { const r = document.documentElement; r.dataset.mode = m; r.classList.toggle('dark', m === 'dark') }, mode)
        await sleep(300)
        await win.screenshot({ path: `${process.env.SHOTS}/real-${mode}.png`, scale: 'css' })
        await win.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'light'; r.classList.remove('dark') })
      }
    }
    // ⑤
    await win.locator('.t2-starter').first().click() // s2(笔记)
    await sleep(200)
    await win.evaluate(() => { window.__anims = []; window.__hold = true })
    await win.keyboard.press('Enter')
    await sleep(120)
    const drop = await liftAnim(win)
    const faded = await emptyFaded(win)
    await release(win)
    check('⑤ 按 Enter:输入区从居中处落底(420ms,与发送动效同曲线)', !!drop && drop.from > 100 && drop.to === 0 && drop.duration === 420 && drop.easing === 'cubic-bezier(0.2, 0.8, 0.3, 1)', drop)
    check('⑤ 空状态同时淡出', faded)
    await sleep(1500)
    g = await geom(win)
    check('⑤ 播完贴底、不再上抬', !g.translate && Math.abs(g.col.bottom - g.anchor.bottom) <= 2, { translate: g.translate, colBottom: g.col.bottom, anchorBottom: g.anchor.bottom })
    check('⑤ 回写 used', patches.some((x) => x.id === 's2' && x.status === 'used'), patches)

    // ⑥
    const newChat = async () => {
      await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click({ timeout: 10_000 })
      await sleep(1500)
      await win.evaluate(() => { window.__anims = []; window.__hold = true })
      await win.getByRole('button', { name: /^新会话$|^新对话$/ }).first().click({ timeout: 10_000 })
      await sleep(200)
    }
    await newChat()
    const rise = await liftAnim(win)
    await release(win)
    check('⑥ 从会话点「新对话」:输入区从底部升到中间', !!rise && rise.from === 0 && rise.to > 100 && rise.duration === 420, rise)
    await sleep(800)
    g = await geom(win)
    check('⑥ 升完居中', !!g.translate && Math.abs((g.empty.top - g.col.top) - (g.col.bottom - g.anchor.bottom)) <= 4, { translate: g.translate })

    // ⑦
    stub.state.failRuns = true
    await win.locator('.composer-anchor .t2c-ta').first().fill('这句发不出去')
    await win.keyboard.press('Enter')
    await sleep(1500)
    g = await geom(win)
    // 新对话的第一句没发出去:会话已经建好,现有的失败处理把那句留成失败气泡(或放回输入框)—— 不再是空对话;输入区留在底部、不回升
    const kept = await win.evaluate(() => [...document.querySelectorAll('.t2-chat-col')].some((c) => c.textContent.includes('这句发不出去')) || [...document.querySelectorAll('.t2c-ta')].some((t) => t.value.includes('这句发不出去')))
    check('⑦ 没发出去:输入区留在底部,那句话还在(失败气泡或输入框里)', !g.translate && kept, { translate: g.translate, kept, empty: g.emptyOpacity })
    stub.state.failRuns = false
    await win.locator('.composer-anchor .t2c-ta').first().fill('')

    // ⑧
    await newChat()
    await release(win)
    await sleep(700)
    stub.state.runDelayMs = 3000
    await win.locator('.composer-anchor .t2c-ta').first().fill('引擎慢的时候')
    await win.keyboard.press('Enter')
    await sleep(600)
    g = await geom(win)
    check('⑧ 引擎慢:按下 600ms 输入区已在底部,不等受理', !g.translate && Math.abs(g.col.bottom - g.anchor.bottom) <= 2 && g.users === 0, { translate: g.translate, users: g.users })
    stub.state.runDelayMs = 0
    await sleep(3500)

    // ⑨
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await newChat()
    const still = await liftAnim(win)
    await release(win)
    await sleep(300)
    g = await geom(win)
    check('⑨ 减少动态效果:不出位移动画,直接居中', !still && !!g.translate, { still, translate: g.translate })
    await win.evaluate(() => { window.__anims = []; window.__hold = true })
    await win.locator('.composer-anchor .t2c-ta').first().fill('减少动态效果')
    await win.keyboard.press('Enter')
    await sleep(150)
    const still2 = await liftAnim(win)
    await release(win)
    g = await geom(win)
    check('⑨ 减少动态效果:发送时直接落底', !still2 && !g.translate, { still2, translate: g.translate })

    // ⑩–⑬ 不画建议的对话页(11-23):右栏 chat-panel 不画 Muse 建议 → 输入框贴底、不居中;主区画建议,宽窄都居中
    await win.emulateMedia({ reducedMotion: 'no-preference' })
    await newChat()
    await release(win)
    await win.waitForSelector('[data-chat-surface="chat"] .t2-starter', { timeout: 10_000 })
    await sleep(800)
    const sizeTo = async (w) => { await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w, h: 900 }); await sleep(900) }
    const shot = async (name) => { if (process.env.NARROW_SHOTS) await U.captureWindow(app, `${process.env.NARROW_SHOTS}/${name}.png`) }
    const numbers = {}
    const centered = (s) => !!s && !!s.translate && Math.abs(s.topGap - s.bottomGap) <= 4
    const docked = (s) => !!s && !s.translate && s.bottomGap <= 2

    let main = await surf(win, 'chat')
    numbers['① 主区宽'] = brief(main)
    check('⑩ 前置:主区新对话画着建议、居中', main?.empty && main.rows >= 1 && centered(main), brief(main))
    await shot('w1-main-wide')

    // Tangu 右栏(命令面板「显示对话面板」,同 check:chatside 28)
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    await win.locator('.cmd-input:visible').fill('显示对话面板')
    await win.locator('.cmd-item', { hasText: '显示对话面板' }).first().click()
    await win.locator('[data-chat-surface="chat-panel"] .t2c-ta').first().waitFor({ timeout: 10_000 })
    await sleep(1200)
    let panel = await surf(win, 'chat-panel')
    main = await surf(win, 'chat')
    numbers['② Tangu 右栏'] = brief(panel)
    numbers['① 主区(右栏开着)'] = brief(main)
    check('⑩ 前置:右栏是新对话空状态、不画建议', !!panel?.empty && !panel.starters, brief(panel))
    check('⑩ 右栏(不画建议):输入框贴底、不上抬', docked(panel), brief(panel))
    check('⑩ 主区照旧:画建议、居中', main?.rows >= 1 && centered(main), brief(main))
    await shot('w2-tangu-panel')

    // 窗口拖窄:主区被挤窄(建议在窄档折成两行、照画)→ 照旧居中;右栏一直贴底(跨尺寸不卡半路)
    for (const w of [1100, 880]) {
      await sizeTo(w)
      main = await surf(win, 'chat')
      panel = await surf(win, 'chat-panel')
      numbers[`③ 主区窗宽 ${w}`] = brief(main)
      numbers[`② 右栏窗宽 ${w}`] = brief(panel)
      check(`⑪ 窗宽 ${w}:主区 ${main?.width}px 画建议就居中`, main?.rows >= 1 && centered(main), brief(main))
      check(`⑪ 窗宽 ${w}:右栏仍贴底`, docked(panel), brief(panel))
    }
    await shot('w3-main-narrow')
    await sizeTo(1400)
    panel = await surf(win, 'chat-panel')
    check('⑪ 拖回宽:右栏仍贴底', docked(panel), brief(panel))

    // Amadeus 右栏缺省宽(笔记 Space 展开右栏 = 对话)
    check('⑫ 前置:进笔记 Space', await U.enterSpace(win, 'amadeus'))
    await sleep(2000)
    if (!(await surf(win, 'chat-panel'))) await win.click('.dv-edge-right', { timeout: 10_000 })
    await win.locator('[data-chat-surface="chat-panel"] .t2c-ta').first().waitFor({ timeout: 10_000 })
    await sleep(1500)
    panel = await surf(win, 'chat-panel')
    numbers['② Amadeus 右栏'] = brief(panel)
    check('⑫ 前置:Amadeus 右栏是新对话空状态、不画建议', !!panel?.empty && !panel.starters, brief(panel))
    check(`⑫ Amadeus 右栏(${panel?.width}px):输入框贴底、不上抬`, docked(panel), brief(panel))
    await shot('w2b-amadeus-panel')

    // ⑬ 从右栏发第一句:不出「中间 → 底」的落底动画(本来就在底);气泡从输入框那一行升起
    await win.evaluate(() => { window.__anims = []; window.__hold = true })
    const taBox = await win.evaluate(() => {
      const ta = [...document.querySelectorAll('[data-chat-surface="chat-panel"] .t2c-ta')].find((e) => e.offsetParent)
      const b = ta.getBoundingClientRect()
      return { top: b.top, bottom: b.bottom }
    })
    const pta = win.locator('[data-chat-surface="chat-panel"] .t2c-ta').first()
    await pta.click()
    await pta.fill('右栏发第一句')
    await win.keyboard.press('Enter')
    let flight = null
    for (let i = 0; i < 40 && !flight; i++) {
      await sleep(100)
      flight = await win.evaluate(() => {
        const wrap = [...document.querySelectorAll('[data-chat-surface="chat-panel"] .t2-userwrap')].find((w) => w.textContent.includes('右栏发第一句'))
        if (!wrap) return null
        const move = window.__anims.find((x) => x.el === wrap && String(x.k?.[0]?.transform || '').includes('translateY'))
        const b = wrap.getBoundingClientRect() // 动画停在 0ms:这就是起点
        return { moved: !!move, startTop: b.top, startBottom: b.bottom }
      })
    }
    const panelDrop = await win.evaluate(() => window.__anims.some(({ el, k }) => el.classList?.contains('composer-anchor') && el.closest('[data-chat-surface="chat-panel"]') && Array.isArray(k) && String(k[0]?.translate || '').length))
    await release(win)
    check('⑬ 右栏发第一句:输入框不出落底动画', !panelDrop, { panelDrop })
    // 起点 = 按发送时输入框那一行(sendFlight noteSend);贴底时再被「气泡下方到内容底边的空间」截住(和已开始的对话发消息同一规则),
    // 所以量的是起点那一格压着输入框那一行,而不是顶边逐像素对齐
    check('⑬ 气泡起点在输入框那一行(跟着输入框实际位置)', !!flight?.moved && flight.startTop <= taBox.top + 4 && flight.startBottom >= taBox.top, { flight, taBox })
    console.log('NUMBERS', JSON.stringify(numbers))
  } finally { await close() }
  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
