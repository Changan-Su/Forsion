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
// 用法:npm run check:musestarters(先 npx electron-vite build)
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
const emptyFaded = (win) => win.evaluate(() => window.__anims.some(({ el, k }) => el.classList?.contains('t2-empty') && Array.isArray(k) && k[k.length - 1]?.opacity === 0))

;(async () => {
  const patches = []
  const { app, win, stub, close } = await U.launch({
    tag: 'musestarters',
    messages: MESSAGES,
    stubOverride: async ({ path: p, method, body }) => {
      if (p === '/agent/special/muse/starters' && method === 'GET') {
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
    await win.waitForSelector('.t2-starter', { timeout: 15_000 })
    await sleep(600)

    // ① ②
    let g = await geom(win)
    check('① 三行画在 Chat Box 正下方', g.rows.length === 3 && g.starters && g.card && g.starters.top >= g.card.bottom - 1, { rows: g.rows.length, starters: g.starters, card: g.card })
    check('① label 画成链接;Muse 自己的那条不是链接', g.rows[0].link.startsWith('产品周会') && !g.rows[0].static && g.rows[2].static, g.rows)
    const topGap = g.empty.top - g.col.top, bottomGap = g.col.bottom - g.anchor.bottom
    check('② 空对话:空状态 + 输入区整块居中', !!g.translate && Math.abs(topGap - bottomGap) <= 4, { topGap, bottomGap, translate: g.translate })

    // ③
    const before = g.card.top
    await win.locator('.t2-starter').nth(1).click()
    await sleep(300)
    g = await geom(win)
    check('③ 点一行 = 整句填进输入框,焦点在输入框', g.ta === STARTERS[1].text && g.focused, { ta: g.ta, focused: g.focused })
    check('③ 三行淡出但居中的那一块不动', g.hidden === true && Math.abs(g.card.top - before) <= 1, { hidden: g.hidden, before, now: g.card.top })
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
    check('⑦ 没发出去:输入区留在底部,空状态淡回来,草稿还在', !g.translate && g.emptyOpacity === '1' && g.ta === '这句发不出去', { translate: g.translate, emptyOpacity: g.emptyOpacity, ta: g.ta })
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
  } finally { await close() }
  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
