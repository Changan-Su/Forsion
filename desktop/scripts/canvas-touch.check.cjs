// 画布**触屏**手势仪器(2026-08-22)。用法:node scripts/e2e-editor.cjs --check=canvas-touch
//
// 为什么另起一层:check:canvas 那 106 格全是鼠标(Playwright mouse / 合成 PointerEvent),
// `pointerType` 恒为 'mouse' —— 本轮加的三件事(双指缩放平移 / 长按出菜单 / 触屏 slop)一格都测不到。
// 这里用 CDP `Input.dispatchTouchEvent` 打真触摸(每个事件带**全部**在场触点,与浏览器的真实电文一致),
// 并且页面开 `hasTouch` —— 实测这一开关同时让 `(pointer: coarse)` 命中、`body{zoom:1.15}` 生效,
// 于是「两级缩放」(应用级 CSS zoom × 舞台 z)这条真机专属的坑在仪器里就是常态,不是特例。
//
//   T1 双指捏合 = 以**两指中心**为锚缩放:中心底下的舞台点一动不动(少 ÷zoomOf 这里必红)
//   T2 双指等距平移 = 只平移不缩放
//   T3 第二根手指落下 = 在途的单指拖拽整笔作废(卡片坐标一字不变),不是两根手指一起驱动同一笔
//   T4 长按 500ms = 右键菜单;中途移动超过阈值则作废
//   T5 触屏轻点带 6px 抖动仍是「点」:只选中,几何不落笔(CLICK_SLOP=3 时这条必红)
//   T6 触屏双击卡片仍进编辑(回归护栏:本轮动了 onDown/onUp,别把唯一的进编辑入口弄丢)
//   T7 手势结束时剩下的那根手指被吞掉,不当成拖拽也不当成点选
//   T10 拖卡途中第二根手指落在**工具条**上并抬起 → 不许替第一根落笔(drag 有主人)
//   T11 card/text 工具下,捏合与长按都不许平白建出一张卡(触屏的一击建推迟到抬手)
//   T12 三指 → 抬掉原始两指之一 → 视口零跳变(pinch 触点对换人必须重建基线)
//   T9 空白**单指**拖 = 平移(不是框选;2026-08-23 用户拍板),而鼠标那条路仍是框选
//   T13 触屏两段式(2026-09-02):未选中的卡上拖 = 平移画布 / 点一下才选中 / 选中后拖才搬卡
//   T8 (pointer: coarse) 下的命中面与层叠:工具按钮 ≥34px、工具条不溢出舞台、HUD 不再压在
//      悬浮编辑胶囊那 46px 里、三条 chrome 互不重叠(**工具条与 HUD 的按钮逐颗量**)
//
// ⚠️ 够不到的两格(写下来,别当已覆盖):①「手指抬在舞台外」的幽灵手指兜底 —— harness 里舞台
//    铺满视口,制造不出这个落点;②真机(Android WebView / iOS Safari)自己的手势仲裁,只有
//    APK 装机人工点得了。**本仪器全绿 ≠ 真机验收。**
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const SEED = '# 触屏画布\n\n主卡一段。\n'
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** ⚠️ `hasTouch` 是整套仪器的地基:没有它 CDP 的触摸事件不落地,`pointer: coarse` 也不命中。
 *  视口按窄机取(412×860),与 `.amx-mbar` 那条「360pt ÷ zoom 装得下吗」的账同一个量级。 */
async function open(browser) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 412, height: 860 }, hasTouch: true })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(400)
  await p.evaluate(() => [...document.querySelectorAll('.amx-modeseg button')].find((b) => (b.textContent ?? '').includes('画布'))?.click())
  await p.waitForTimeout(400)
  const cdp = await p.context().newCDPSession(p)
  // ⚠️ CDP 的 `touchEnd` 按协议注释该传空 touchPoints,而这里靠「传谁就放开谁」的宽容行为
  //    只放开一根(否则没法测「剩下那根被吞掉」)。**别把它当已知成立** —— 把实际的 pointerId
  //    记下来,由用例断言「放开的是第二根、接着动的是第一根」(Codex 2026-08-23 medium)。
  await p.evaluate(() => {
    const pe = { down: [], up: [], lastMove: null }
    window.__pe = pe
    addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') pe.down.push(e.pointerId) }, true)
    addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') pe.up.push(e.pointerId) }, true)
    addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') pe.lastMove = e.pointerId }, true)
  })
  return { p, cdp }
}

const tp = (x, y, id) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: 8, radiusY: 8, force: 1 })
const send = (cdp, type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })
const wait = (p, ms) => p.waitForTimeout(ms)

async function tap(cdp, p, x, y, jitter = 0) {
  await send(cdp, 'touchStart', [tp(x, y, 1)])
  await wait(p, 30)
  if (jitter) { await send(cdp, 'touchMove', [tp(x + jitter, y + jitter, 1)]); await wait(p, 20) }
  await send(cdp, 'touchEnd', [])
  await wait(p, 120)
}
async function doubleTap(cdp, p, x, y) {
  await tap(cdp, p, x, y)
  await wait(p, 40)
  await tap(cdp, p, x, y)
  await wait(p, 400)
}

/** 舞台视口:`.amx-stage-inner` 的 transform 就是 (x, y, z) 的唯一真源(局部未缩放 px)。 */
const vpOf = (p) => p.evaluate(() => {
  const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.amx-stage-inner')).transform)
  return { x: m.e, y: m.f, z: m.a }
})
/** 某个**视口坐标**下的舞台点。两级缩放:先 ÷ currentCSSZoom 回局部,再 ÷ 舞台 z。 */
const stagePointAt = (p, cx, cy) => p.evaluate(([x, y]) => {
  const host = document.querySelector('.amx-stage')
  const u = host.currentCSSZoom || 1
  const r = host.getBoundingClientRect()
  const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.amx-stage-inner')).transform)
  return { x: ((x - r.left) / u - m.e) / m.a, y: ((y - r.top) / u - m.f) / m.d }
}, [cx, cy])

/** 卡片的**落盘几何**与**当前画面位置**一起取:只看 dataset 的话,「拖拽样式表没清干净」这类
 *  病(数据没落笔、卡却永远停在手指松开的地方)一格都抓不到 —— 负对照实测过。
 *  offsetLeft/Top 相对 `.amx-stage-inner`(C12 钉着这条 offsetParent 契约)。 */
const cardsOf = (p) => p.evaluate(() => [...document.querySelectorAll('.amx-ucard')].map((el) => ({
  anchor: el.dataset.anchor, x: Number(el.dataset.x) || 0, y: Number(el.dataset.y) || 0,
  px: el.offsetLeft, py: el.offsetTop,
})))
const rectOf = (p, sel) => p.evaluate((s) => {
  const el = document.querySelector(s)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
}, sel)
/** 舞台空白:主卡下方、工具条/HUD/缩略图之上的一条。 */
async function blankPoint(p) {
  const main = await rectOf(p, PM)
  const stage = await rectOf(p, '.amx-stage')
  return { x: Math.round(stage.x + 34), y: Math.round(main.bottom + 80) }
}

/** 按**标题**挑工具,别按位置(往工具栏插一颗按钮,写死的 nth-child 会静默改测另一个工具)。 */
const pickTool = async (p, title) => {
  const i = await p.evaluate((t) => [...document.querySelectorAll('.amx-stage-tools button')].findIndex((b) => (b.title ?? '').includes(t)), title)
  if (i < 0) throw new Error(`工具栏没有「${title}」`)
  await p.click(`.amx-stage-tools button:nth-child(${i + 1})`)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })

  // ── T1/T2/T7 视口手势 ───────────────────────────────────────────────────────
  {
    const { p, cdp } = await open(browser)
    const c = { x: 206, y: 420 } // 屏幕中心附近,与任何 chrome 都不重叠
    const before = await stagePointAt(p, c.x, c.y)
    const z0 = (await vpOf(p)).z
    await send(cdp, 'touchStart', [tp(c.x - 40, c.y, 1)])
    await send(cdp, 'touchStart', [tp(c.x - 40, c.y, 1), tp(c.x + 40, c.y, 2)])
    await wait(p, 40)
    for (const d of [55, 70, 85, 100]) {
      await send(cdp, 'touchMove', [tp(c.x - d, c.y, 1), tp(c.x + d, c.y, 2)])
      await wait(p, 25)
    }
    const after = await stagePointAt(p, c.x, c.y)
    const z1 = (await vpOf(p)).z
    await send(cdp, 'touchEnd', [tp(c.x + 100, c.y, 2)])
    await wait(p, 30)
    const pe1 = await p.evaluate(() => ({ ...window.__pe }))
    record('T1 双指捏合以两指中心为锚缩放(锚点舞台坐标不动)',
      z1 > z0 * 1.8 && Math.abs(after.x - before.x) < 1.5 && Math.abs(after.y - before.y) < 1.5,
      JSON.stringify({ z0, z1, before, after }))

    // 先证明触点序列真是我以为的那样:两根落下、放开的是**第二根**
    record('T1b CDP 触点序列如实:两根 pointerdown,touchEnd([id2]) 放开的是第二根',
      pe1.down.length === 2 && pe1.up.length === 1 && pe1.up[0] === pe1.down[1], JSON.stringify(pe1))

    // T7:剩下那根手指被吞掉 —— 大幅移动 + 抬起,视口与选中集都不该动
    const vpKeep = await vpOf(p)
    const selKeep = await p.evaluate(() => document.querySelectorAll('.amx-el-selbox').length)
    await send(cdp, 'touchMove', [tp(c.x - 240, c.y + 200, 1)])
    await wait(p, 60)
    await send(cdp, 'touchEnd', [])
    await wait(p, 150)
    const vpAfter = await vpOf(p)
    const selAfter = await p.evaluate(() => document.querySelectorAll('.amx-el-selbox').length)
    const pe2 = await p.evaluate(() => ({ ...window.__pe }))
    record('T7 手势尾巴上那根手指被吞掉(不平移、不点选;且动的确实是剩下那根)',
      pe2.lastMove === pe2.down[0]
      && Math.abs(vpAfter.x - vpKeep.x) < 0.6 && Math.abs(vpAfter.y - vpKeep.y) < 0.6 && Math.abs(vpAfter.z - vpKeep.z) < 0.01 && selAfter === selKeep,
      JSON.stringify({ movedId: pe2.lastMove, want: pe2.down[0], vpKeep, vpAfter, selKeep, selAfter }))

    // T2:等距双指整体平移
    const vpB = await vpOf(p)
    const u = await p.evaluate(() => document.querySelector('.amx-stage').currentCSSZoom || 1)
    await send(cdp, 'touchStart', [tp(c.x - 40, c.y, 3)])
    await send(cdp, 'touchStart', [tp(c.x - 40, c.y, 3), tp(c.x + 40, c.y, 4)])
    await wait(p, 40)
    for (const k of [1, 2, 3]) {
      await send(cdp, 'touchMove', [tp(c.x - 40 + k * 20, c.y + k * 10, 3), tp(c.x + 40 + k * 20, c.y + k * 10, 4)])
      await wait(p, 25)
    }
    const vpA = await vpOf(p)
    await send(cdp, 'touchEnd', [tp(c.x + 100, c.y + 30, 4)])
    await send(cdp, 'touchEnd', [])
    await wait(p, 120)
    record('T2 双指等距 = 纯平移(位移 ÷ 应用级 zoom,缩放不变)',
      Math.abs(vpA.z - vpB.z) < 0.001 && Math.abs(vpA.x - vpB.x - 60 / u) < 1.5 && Math.abs(vpA.y - vpB.y - 30 / u) < 1.5,
      JSON.stringify({ u, dx: vpA.x - vpB.x, dy: vpA.y - vpB.y, want: [60 / u, 30 / u] }))
    await p.close()
  }

  // ── T6 双击进编辑 ──────────────────────────────────────────────────────────
  // ⚠️ 单开一页,而且两次手势之间必须**等过双击间隔**:浏览器的点击计数是连续的,
  //    「上一格留下的一次轻点 + 本格的第一下」会先凑成一次 dblclick —— 那一下进了编辑并触发
  //    聚焦动画,卡片当场从手指底下挪走,本格的第二下于是落在空白上把编辑态又清了。
  //    (调试时误判成「触屏进不了编辑」栽过一次,别把 wait 删掉。)
  {
    const { p, cdp } = await open(browser)
    const blank = await blankPoint(p)
    await doubleTap(cdp, p, blank.x, blank.y)
    const cards = await cardsOf(p)
    record('T6a 触屏双击空白 = 建卡(双击链路在触屏上仍成立)', cards.length === 1, JSON.stringify(cards))
    const card = await rectOf(p, '.amx-ucard')
    const mid = { x: Math.round(card.x + card.w / 2), y: Math.round(card.y + card.h / 2) }
    await wait(p, 700) // 断开点击计数
    await doubleTap(cdp, p, mid.x, mid.y)
    const editing = await p.evaluate(() => !!document.querySelector('.amx-el-selbox.is-editing'))
    record('T6 触屏双击卡片 = 进编辑(手机上唯一的进编辑入口:空格进编辑要键盘)', editing, JSON.stringify({ editing }))
    await p.close()
  }

  // ── T5/T3 卡片上的单指与双指 ───────────────────────────────────────────────
  {
    const { p, cdp } = await open(browser)
    const blank = await blankPoint(p)
    await doubleTap(cdp, p, blank.x, blank.y)
    const cards = await cardsOf(p)
    const card = await rectOf(p, '.amx-ucard')
    const mid = { x: Math.round(card.x + card.w / 2), y: Math.round(card.y + card.h / 2) }
    await wait(p, 700)

    // T5:带 6px 抖动的轻点 —— 选中,但几何一字不变
    await tap(cdp, p, mid.x, mid.y, 6)
    const afterTap = await cardsOf(p)
    const selBox = await p.evaluate(() => document.querySelectorAll('.amx-el-selbox').length)
    record('T5 触屏轻点带 6px 抖动仍是「点」:选中且几何不落笔',
      selBox === 1 && afterTap[0].x === cards[0].x && afterTap[0].y === cards[0].y,
      JSON.stringify({ selBox, before: cards[0], after: afterTap[0] }))
    await wait(p, 700)

    // T3:单指拖到一半来第二根手指 → 整笔作废
    const geo0 = (await cardsOf(p))[0]
    await send(cdp, 'touchStart', [tp(mid.x, mid.y, 1)])
    await wait(p, 30)
    await send(cdp, 'touchMove', [tp(mid.x + 45, mid.y + 45, 1)])
    await wait(p, 40)
    await send(cdp, 'touchStart', [tp(mid.x + 45, mid.y + 45, 1), tp(mid.x + 130, mid.y + 45, 2)])
    await wait(p, 40)
    await send(cdp, 'touchMove', [tp(mid.x + 20, mid.y + 45, 1), tp(mid.x + 170, mid.y + 45, 2)])
    await wait(p, 40)
    await send(cdp, 'touchEnd', [tp(mid.x + 170, mid.y + 45, 2)])
    await send(cdp, 'touchEnd', [])
    await wait(p, 250)
    const geo1 = (await cardsOf(p))[0]
    record('T3 第二根手指落下 = 在途拖拽整笔作废(落盘几何不变**且画面回位**)',
      geo1.x === geo0.x && geo1.y === geo0.y && Math.abs(geo1.px - geo1.x) < 1 && Math.abs(geo1.py - geo1.y) < 1,
      JSON.stringify({ geo0, geo1 }))
    await p.close()
  }

  // ── T13 触屏两段式:未选中的卡上单指拖 = 平移画布(2026-09-02 用户实报)────────────
  //    ①未选中 → 拖 = 平移,卡的落盘几何一字不变、也不被选中;②轻点 = 选中;③选中后再拖 = 搬卡。
  //    负对照实跑过:把 onDown 里的 touchKey 那道闸注释掉,①当场红(卡被拖走、视口没动)。
  {
    const { p, cdp } = await open(browser)
    const blank = await blankPoint(p)
    await doubleTap(cdp, p, blank.x, blank.y) // 建一张卡(建完是选中态)
    await wait(p, 700)
    await p.keyboard.press('Escape') // 取消选中(点空白也行,但这一带全是卡,Esc 没有歧义)
    await wait(p, 250)
    const selBefore = await p.evaluate(() => document.querySelectorAll('.amx-el-selbox').length)
    const card = await rectOf(p, '.amx-ucard')
    const mid = { x: Math.round(card.x + card.w / 2), y: Math.round(card.y + card.h / 2) }
    const u = await p.evaluate(() => document.querySelector('.amx-stage').currentCSSZoom || 1)

    // ① 未选中的卡上拖 = 平移
    const geo0 = (await cardsOf(p))[0]
    const vp0 = await vpOf(p)
    await send(cdp, 'touchStart', [tp(mid.x, mid.y, 1)])
    await wait(p, 30)
    for (const k of [1, 2, 3]) {
      await send(cdp, 'touchMove', [tp(mid.x + k * 20, mid.y + k * 12, 1)])
      await wait(p, 25)
    }
    await send(cdp, 'touchEnd', [])
    await wait(p, 250)
    const geo1 = (await cardsOf(p))[0]
    const vp1 = await vpOf(p)
    const selAfterPan = await p.evaluate(() => document.querySelectorAll('.amx-el-selbox').length)
    const panned = Math.abs(vp1.x - vp0.x - 60 / u) < 1.5 && Math.abs(vp1.y - vp0.y - 36 / u) < 1.5
    record('T13a 未选中的卡上单指拖 = 平移画布(卡不动、也不被选中)',
      panned && geo1.x === geo0.x && geo1.y === geo0.y && selAfterPan === 0 && selBefore === 0,
      JSON.stringify({ selBefore, selAfterPan, dx: vp1.x - vp0.x, dy: vp1.y - vp0.y, want: [60 / u, 36 / u], geo0, geo1 }))

    // ② 轻点 = 选中(几何仍不落笔)
    const card2 = await rectOf(p, '.amx-ucard')
    const mid2 = { x: Math.round(card2.x + card2.w / 2), y: Math.round(card2.y + card2.h / 2) }
    await tap(cdp, p, mid2.x, mid2.y)
    await wait(p, 300)
    const selAfterTap = await p.evaluate(() => document.querySelectorAll('.amx-el-selbox').length)
    const geo2 = (await cardsOf(p))[0]
    record('T13b 轻点未选中的卡 = 选中它(几何不落笔)',
      selAfterTap === 1 && geo2.x === geo0.x && geo2.y === geo0.y,
      JSON.stringify({ selAfterTap, geo2 }))

    // ③ 选中之后再拖 = 搬卡(视口不动)
    const vp2 = await vpOf(p)
    await send(cdp, 'touchStart', [tp(mid2.x, mid2.y, 1)])
    await wait(p, 30)
    for (const k of [1, 2, 3]) {
      await send(cdp, 'touchMove', [tp(mid2.x + k * 20, mid2.y + k * 12, 1)])
      await wait(p, 25)
    }
    await send(cdp, 'touchEnd', [])
    await wait(p, 350)
    const geo3 = (await cardsOf(p))[0]
    const vp3 = await vpOf(p)
    record('T13c 选中之后再拖 = 搬卡(这一笔视口不动)',
      (geo3.x !== geo2.x || geo3.y !== geo2.y) && Math.abs(vp3.x - vp2.x) < 0.6 && Math.abs(vp3.y - vp2.y) < 0.6,
      JSON.stringify({ geo2, geo3, dvp: { x: vp3.x - vp2.x, y: vp3.y - vp2.y } }))
    await p.close()
  }

  // ── T13d 未选中的卡上双击仍进编辑(回归护栏:两段式把「选中」从 pointerdown 挪到了 pointerup,
  //    而 T6 测的是新建即选中那张 —— 手机上唯一的进编辑入口不能因此丢在未选中态上)。
  {
    const { p, cdp } = await open(browser)
    const blank = await blankPoint(p)
    await doubleTap(cdp, p, blank.x, blank.y)
    await wait(p, 700)
    await p.keyboard.press('Escape') // 取消选中
    await wait(p, 250)
    const card = await rectOf(p, '.amx-ucard')
    await doubleTap(cdp, p, Math.round(card.x + card.w / 2), Math.round(card.y + card.h / 2))
    const editing = await p.evaluate(() => !!document.querySelector('.amx-el-selbox.is-editing'))
    record('T13d 未选中的卡上双击仍进编辑(两段式没吃掉手机端的进编辑入口)', editing, JSON.stringify({ editing }))
    await p.close()
  }

  // ── T9 空白单指拖 = 平移 ───────────────────────────────────────────────────
  {
    const { p, cdp } = await open(browser)
    const blank = await blankPoint(p)
    const vp0 = await vpOf(p)
    const u = await p.evaluate(() => document.querySelector('.amx-stage').currentCSSZoom || 1)
    await send(cdp, 'touchStart', [tp(blank.x, blank.y, 1)])
    await wait(p, 30)
    for (const k of [1, 2, 3]) {
      await send(cdp, 'touchMove', [tp(blank.x + k * 25, blank.y - k * 15, 1)])
      await wait(p, 25)
    }
    const marqueeUp = await p.evaluate(() => !!document.querySelector('.amx-el-marquee'))
    await send(cdp, 'touchEnd', [])
    await wait(p, 150)
    const vp1 = await vpOf(p)
    record('T9 空白单指拖 = 平移(不出框选框,视口按位移 ÷ 应用级 zoom 走)',
      !marqueeUp && Math.abs(vp1.x - vp0.x - 75 / u) < 1.5 && Math.abs(vp1.y - vp0.y + 45 / u) < 1.5 && Math.abs(vp1.z - vp0.z) < 0.001,
      JSON.stringify({ marqueeUp, dx: vp1.x - vp0.x, dy: vp1.y - vp0.y, want: [75 / u, -45 / u] }))

    // 鼠标那条路一字未动:同样的空白拖仍是框选、视口不动(负对照就在同一页里)
    const vp2 = await vpOf(p)
    await p.mouse.move(blank.x, blank.y)
    await p.mouse.down()
    await p.mouse.move(blank.x + 60, blank.y - 40, { steps: 4 })
    const marqueeMouse = await p.evaluate(() => !!document.querySelector('.amx-el-marquee'))
    await p.mouse.up()
    await wait(p, 150)
    const vp3 = await vpOf(p)
    record('T9b 同一片空白:鼠标拖仍是框选,视口不动(触屏那条没泄进桌面)',
      marqueeMouse && Math.abs(vp3.x - vp2.x) < 0.6 && Math.abs(vp3.y - vp2.y) < 0.6,
      JSON.stringify({ marqueeMouse, dx: vp3.x - vp2.x, dy: vp3.y - vp2.y }))
    await p.close()
  }

  // ── T10 拖卡途中,第二根手指落在工具条上(Codex high:drag 得有主人)───────────
  {
    const { p, cdp } = await open(browser)
    const blank = await blankPoint(p)
    await doubleTap(cdp, p, blank.x, blank.y)
    const card = await rectOf(p, '.amx-ucard')
    const mid = { x: Math.round(card.x + card.w / 2), y: Math.round(card.y + card.h / 2) }
    await wait(p, 700)
    const geo0 = (await cardsOf(p))[0]
    const tbtn = await rectOf(p, '.amx-stage-tools button')
    const tb = { x: Math.round(tbtn.x + tbtn.w / 2), y: Math.round(tbtn.y + tbtn.h / 2) }
    await send(cdp, 'touchStart', [tp(mid.x, mid.y, 1)])
    await wait(p, 30)
    await send(cdp, 'touchMove', [tp(mid.x + 50, mid.y + 50, 1)])
    await wait(p, 40)
    // 第二根手指落在工具条按钮上:那一支在**登记触点之前**就早退了(凑不成双指手势),
    // 于是它的 pointerup 会冒泡到舞台 —— 修前这一下就把第一根手指的拖拽提前落了笔。
    await send(cdp, 'touchStart', [tp(mid.x + 50, mid.y + 50, 1), tp(tb.x, tb.y, 2)])
    await wait(p, 40)
    await send(cdp, 'touchEnd', [tp(tb.x, tb.y, 2)])
    await wait(p, 220)
    const held = (await cardsOf(p))[0]
    await send(cdp, 'touchEnd', [])
    await wait(p, 300)
    const done = (await cardsOf(p))[0]
    record('T10 拖卡途中别人的手指抬起:不许替它落笔,且这一笔还活着(画面仍跟手);自己抬手才落',
      held.x === geo0.x && held.y === geo0.y && held.px - held.x > 40
      && (done.x !== geo0.x || done.y !== geo0.y),
      JSON.stringify({ geo0, held, done }))
    await p.close()
  }

  // ── T11 card 工具下的捏合与长按不许平白建卡(Codex high:一击建推迟到抬手)────
  {
    const { p, cdp } = await open(browser)
    const blank = await blankPoint(p)
    await pickTool(p, '新建卡片')
    await send(cdp, 'touchStart', [tp(blank.x, blank.y, 1)])
    await wait(p, 30)
    await send(cdp, 'touchStart', [tp(blank.x, blank.y, 1), tp(blank.x + 90, blank.y, 2)])
    await wait(p, 40)
    await send(cdp, 'touchMove', [tp(blank.x - 30, blank.y, 1), tp(blank.x + 140, blank.y, 2)])
    await wait(p, 40)
    await send(cdp, 'touchEnd', [tp(blank.x + 140, blank.y, 2)])
    await send(cdp, 'touchEnd', [])
    await wait(p, 300)
    const afterPinch = (await cardsOf(p)).length
    await wait(p, 500)
    await send(cdp, 'touchStart', [tp(blank.x, blank.y, 1)])
    await wait(p, 700)
    const menu = await p.evaluate(() => !!document.querySelector('.ctx-menu'))
    await send(cdp, 'touchEnd', [])
    await wait(p, 250)
    const afterPress = (await cardsOf(p)).length
    // 正向对照:工具还 armed 着,单指轻点确实建得出卡(否则这一格靠「功能被删」也能全绿)。
    // ⚠️ 落点必须**避开刚弹出的菜单**:菜单是 clamp 过的浮层,位置不能凭长按点推算 ——
    //    压在它上面那一下会被 `.ctx-menu` 早退吃掉(甚至点中某个菜单项),看起来就是「建不出卡」。
    const menuBox = await rectOf(p, '.ctx-menu')
    const stage = await rectOf(p, '.amx-stage')
    const tapPt = menuBox && menuBox.y > stage.y + 140
      ? { x: Math.round(stage.x + 30), y: Math.round(menuBox.y - 70) }
      : { x: Math.round(stage.x + 30), y: Math.round((menuBox ? menuBox.bottom : stage.y) + 50) }
    const hits = await p.evaluate(([x, y]) => (document.elementFromPoint(x, y) || {}).className ?? '', [tapPt.x, tapPt.y])
    await wait(p, 500)
    await tap(cdp, p, tapPt.x, tapPt.y)
    await wait(p, 350)
    const afterTap = (await cardsOf(p)).length
    record('T11 card 工具:捏合/长按都不平白建卡,而单指轻点照建(一击建推迟到抬手)',
      afterPinch === 0 && menu && afterPress === 0 && afterTap === 1 && String(hits).includes('amx-stage'),
      JSON.stringify({ afterPinch, menu, afterPress, afterTap, tapPt, hits, menuBox }))
    await p.close()
  }

  // ── T12 三指换手(Codex medium:触点对换人必须重建基线)───────────────────────
  {
    const { p, cdp } = await open(browser)
    const c = { x: 206, y: 420 }
    await send(cdp, 'touchStart', [tp(c.x - 80, c.y, 1)])
    await send(cdp, 'touchStart', [tp(c.x - 80, c.y, 1), tp(c.x + 80, c.y, 2)])
    await wait(p, 40)
    await send(cdp, 'touchMove', [tp(c.x - 100, c.y, 1), tp(c.x + 100, c.y, 2)])
    await wait(p, 40)
    await send(cdp, 'touchStart', [tp(c.x - 100, c.y, 1), tp(c.x + 100, c.y, 2), tp(c.x + 200, c.y + 120, 3)])
    await wait(p, 40)
    await send(cdp, 'touchEnd', [tp(c.x - 100, c.y, 1)]) // 抬掉原始那对里的一根 → 触点对换人
    await wait(p, 60)
    const vp0 = await vpOf(p)
    // ⚠️ 每一帧都必须**真的挪动坐标**:CDP 对「与上一帧相同」的触点一个事件都不发
    //    (协议原文:one event per any changed point)—— 原地不动的两帧是假绿,F3 打断了照样通过。
    //    这里两指整体平移 2px:间距不变 ⇒ 缩放该纹丝不动,平移量最多 2/u ≈ 1.7px;
    //    基线没重建的话,换手那一帧的 z 会按「新触点对间距 ÷ 旧基线间距」(156/200)一步跳掉两成。
    for (const k of [1, 2]) {
      await send(cdp, 'touchMove', [tp(c.x + 100 + k * 2, c.y, 2), tp(c.x + 200 + k * 2, c.y + 120, 3)])
      await wait(p, 40)
    }
    const vp1 = await vpOf(p)
    await send(cdp, 'touchEnd', [])
    await wait(p, 150)
    record('T12 三指抬掉一根 = 触点对换人:按当前视口重建基线,换手不跳变(缩放纹丝不动)',
      Math.abs(vp1.z - vp0.z) < 0.005 && Math.abs(vp1.x - vp0.x) < 8 && Math.abs(vp1.y - vp0.y) < 8,
      JSON.stringify({ vp0, vp1 }))
    await p.close()
  }

  // ── T4 长按 ────────────────────────────────────────────────────────────────
  {
    const { p, cdp } = await open(browser)
    const blank = await blankPoint(p)
    await send(cdp, 'touchStart', [tp(blank.x, blank.y, 1)])
    await wait(p, 700)
    const menuUp = await p.evaluate(() => !!document.querySelector('.ctx-menu'))
    await send(cdp, 'touchEnd', [])
    await wait(p, 150)
    const menuStill = await p.evaluate(() => !!document.querySelector('.ctx-menu'))
    await tap(cdp, p, blank.x + 40, blank.y) // 点走关掉
    await wait(p, 150)

    await send(cdp, 'touchStart', [tp(blank.x, blank.y, 1)])
    await wait(p, 120)
    await send(cdp, 'touchMove', [tp(blank.x + 40, blank.y + 8, 1)])
    await wait(p, 600)
    const menuMoved = await p.evaluate(() => !!document.querySelector('.ctx-menu'))
    await send(cdp, 'touchEnd', [])
    await wait(p, 150)
    record('T4 长按 500ms = 画布菜单;中途移动则作废',
      menuUp && menuStill && !menuMoved, JSON.stringify({ menuUp, menuStill, menuMoved }))
    await p.close()
  }

  // ── T8 触屏命中面与层叠 ────────────────────────────────────────────────────
  {
    const { p } = await open(browser)
    // ⚠️ 必须遍历**全部**按钮:只量工具条第一颗时,HUD 那四颗(12px 图标 + 6px padding = 24px)
    //    仍然过小而 T8 照绿 —— Codex 2026-08-23 抓的正是这一格假绿。
    const geo = await p.evaluate(() => {
      const q = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, right: r.right } }
      const u = document.querySelector('.amx-stage').currentCSSZoom || 1
      const btns = [...document.querySelectorAll('.amx-stage-tools button, .amx-stage-hud button')].map((b) => {
        const r = b.getBoundingClientRect()
        return { t: (b.getAttribute('title') || '').slice(0, 6), w: +(r.width / u).toFixed(1), h: +(r.height / u).toFixed(1) }
      })
      return { coarse: matchMedia('(pointer: coarse)').matches, u, btns, tools: q('.amx-stage-tools'), hud: q('.amx-stage-hud'), stage: q('.amx-stage'), mini: q('.amx-stage-minimap') }
    })
    const tooSmall = geo.btns.filter((b) => b.w < 33.5 || b.h < 33.5)
    // `.amx-mbar` 只在移动端外壳里渲染(harness 没有),所以按它的契约尺寸算:bottom:10 + 约 46 高。
    const mbarTop = geo.stage.bottom - (10 + 46) * geo.u
    const noOverlap = (a, b) => !a || !b || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5
    record('T8 触屏命中面:按钮 ≥34px、工具条不溢出、HUD 脱离悬浮胶囊、三条 chrome 不重叠',
      geo.coarse && geo.btns.length >= 12 && tooSmall.length === 0
        && geo.tools.x >= geo.stage.x && geo.tools.right <= geo.stage.right
        && geo.hud.x >= geo.stage.x && geo.hud.right <= geo.stage.right
        && geo.hud.bottom < mbarTop && noOverlap(geo.hud, geo.tools) && noOverlap(geo.mini, geo.hud),
      JSON.stringify({ coarse: geo.coarse, n: geo.btns.length, tooSmall, mbarTop, hud: geo.hud, tools: geo.tools, mini: geo.mini }))
    await p.close()
  }

  finish(browser)
})()

function finish(browser) {
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  browser.close().then(() => process.exit(ok === results.length ? 0 : 1))
}
