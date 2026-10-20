// 白板手写笔输入的真 Excalidraw 契约(harness ?board 模式,CDP 发真的笔 / 触摸事件)。
// 补丁原理见 frontend/src/amadeus/blocks/excalidraw/penInput.ts;补丁本体在 build/copy-excalidraw-assets.cjs。
//
//   P0 回归:从没见过笔时手指照常能画(补丁只管笔;这条原版补丁版都必须过,放最前 = 笔模式还没被打开)。
//   P1 丢点:一帧里连发好几下笔移动,笔画要把每个采样都收下(引擎原样每帧只留最后一个)。
//   P2 断笔:笔画到一半手掌按下、再抬起,这一笔不许被收掉 / 删掉,也不许被手掌带着缩放。
//   P3 手掌先放:手掌按着时笔落下,照样要画出来(引擎原样会把两者当双指,笔画不开始)。
//   P4 笔的抬起丢了:下一次(鼠标)按下要把上一笔收在笔最后到的地方,鼠标也要能接着画
//      (Codex 评审抓到:只认这支笔的过滤一度把引擎的补收笔也拦了,旧笔画的监听永远摘不掉)。
//
// 每条都跑两遍:补丁版(public/excalidraw 的副本)必须过;**原版引擎**(拦下请求换成 node_modules 里没打补丁的)
// 必须红 —— 原版也绿 = 这条量不出补丁的作用,判台架失效(负对照,每次都跑)。
//
// 用法:npm run check:boardpen(自带起停 vite);或 npm run web 后 HARNESS_URL=… node scripts/board-pen.check.cjs
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const ORIGINAL = path.join(__dirname, '../node_modules/@excalidraw/excalidraw/dist/obsidian/excalidraw.production.min.js')

/** 别用 0.5:引擎把压力恰好 0.5 的输入当鼠标、改走模拟压感,就量不到压感有没有跟着点走了 */
const PRESSURE = 0.7
const freedraws = (p) => p.evaluate(() => (window.__scene?.elements ?? []).filter((e) => e.type === 'freedraw' && !e.isDeleted))
const settle = (p) => p.waitForTimeout(450)

/** 一个跑场景的会话:页面 + CDP。patched=false 时把引擎换成原版。 */
async function open(browser, patched) {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1, hasTouch: true })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  // P4 用:吞掉下一次笔的 pointerup(window 捕获阶段最先注册,引擎和 penInput 都收不到 = 抬起丢了)
  await p.addInitScript(() => {
    window.addEventListener('pointerup', (e) => {
      if (window.__dropPenUp && e.pointerType === 'pen') {
        window.__dropPenUp = false
        e.stopImmediatePropagation()
      }
    }, true)
  })
  if (!patched) await p.route('**/excalidraw/excalidraw.js', (r) => r.fulfill({ path: ORIGINAL, contentType: 'application/javascript' }))
  await p.goto(`${BASE}?board`)
  await p.waitForSelector('.excalidraw canvas.excalidraw__canvas.interactive', { timeout: 20000 })
  await p.waitForTimeout(600)
  const marker = await p.evaluate(() => globalThis.__forsionPenPatch ?? null)
  const box = await p.evaluate(() => {
    const r = document.querySelector('.excalidraw').getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  const cdp = await ctx.newCDPSession(p)
  const pen = (type, x, y, extra = {}) =>
    cdp.send('Input.dispatchMouseEvent', {
      type, x, y, pointerType: 'pen', button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1, force: PRESSURE, ...extra,
    })
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
  // 焦点给画布 + 选自由画笔(P = Draw)
  await p.mouse.click(box.x + 900, box.y + 700)
  await p.keyboard.press('p')
  await p.waitForTimeout(150)
  return { ctx, p, cdp, pen, touch, frame, box, errs, marker }
}

/** 一笔:笔落下 → 每帧 burst 次移动(不等帧,逼引擎在同一帧里收到好几下)→ 抬起。返回发出的移动数。 */
async function stroke(s, from, frames, burst, dx = 6, dy = 2, between = null) {
  await s.pen('mousePressed', from.x, from.y)
  await s.frame()
  let x = from.x
  let y = from.y
  let sent = 0
  for (let f = 0; f < frames; f++) {
    const batch = []
    for (let i = 0; i < burst; i++) {
      x += dx
      y += dy + (i % 2 ? 1.5 : -1.5) // 锯齿:每个采样都在不同位置,丢了就看得出
      batch.push(s.pen('mouseMoved', x, y))
      sent++
    }
    await Promise.all(batch)
    if (between) await between(f)
    await s.frame()
  }
  await s.pen('mouseReleased', x, y)
  await settle(s.p)
  return { sent, end: { x, y } }
}

/** 最后一个点的场景坐标(初始视口 scroll=0 / zoom=1 下 = 视口坐标 − 容器左上角) */
const lastScene = (el) => {
  const [px, py] = el.points[el.points.length - 1]
  return { x: el.x + px, y: el.y + py }
}
const near = (a, b, tol = 2.5) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol

async function scenarios(s) {
  const out = {}
  // P0 手指画一笔(此时还没见过笔,笔模式关着)
  {
    const before = (await freedraws(s.p)).length
    const f = { x: s.box.x + 120, y: s.box.y + 650, id: 3 }
    await s.touch('touchStart', [f])
    await s.frame()
    for (let i = 1; i <= 10; i++) {
      await s.touch('touchMove', [{ ...f, x: f.x + i * 10, y: f.y + i }])
      await s.frame()
    }
    await s.touch('touchEnd', [])
    await settle(s.p)
    const els = await freedraws(s.p)
    const el = els.length > before ? els[els.length - 1] : null
    const span = el ? { x: el.points[el.points.length - 1][0] - el.points[0][0], y: el.points[el.points.length - 1][1] - el.points[0][1] } : null
    out.P0 = {
      always: true,
      ok: !!el && el.points.length >= 10 && near(span, { x: 100, y: 10 }),
      detail: el ? `手指画出 ${el.points.length} 个点,位移 (${span.x.toFixed(1)},${span.y.toFixed(1)}) 应为 (100,10)` : '手指没画出笔画',
    }
  }
  // P1 丢点:30 帧 × 每帧 4 下
  {
    const before = (await freedraws(s.p)).length
    const { sent, end } = await stroke(s, { x: s.box.x + 120, y: s.box.y + 120 }, 30, 4, 4, 1)
    const els = await freedraws(s.p)
    const el = els[els.length - 1]
    const kept = el ? el.points.length - 1 : 0 // 第一个点是落笔处
    out.P1 = {
      ok: els.length === before + 1 && kept >= sent * 0.9 && near(lastScene(el), { x: end.x - s.box.x, y: end.y - s.box.y }) &&
        !el.simulatePressure && el.pressures.length === el.points.length && el.pressures.slice(1, -1).every((v) => Math.abs(v - PRESSURE) < 0.01), // 末点是引擎在抬笔时自己补的,压力 0
      detail: `发出 ${sent} 下移动,笔画收下 ${kept} 个点(${Math.round((kept / sent) * 100)}%)` +
        (el ? `;压感 ${el.simulatePressure ? '模拟' : el.pressures.length + '/' + el.points.length}` : ';没画出笔画'),
    }
  }
  // P2 断笔:画到第 5 帧手掌按下,第 12 帧手掌挪一下,第 18 帧手掌抬起,笔一直画到第 25 帧
  {
    const before = (await freedraws(s.p)).length
    const palm = { x: s.box.x + 700, y: s.box.y + 500, id: 7 }
    const { sent, end } = await stroke(s, { x: s.box.x + 120, y: s.box.y + 300 }, 25, 1, 8, 1, async (f) => {
      if (f === 5) await s.touch('touchStart', [palm])
      if (f === 12) await s.touch('touchMove', [{ ...palm, x: palm.x + 40, y: palm.y + 30 }])
      if (f === 18) await s.touch('touchEnd', [])
    })
    const els = await freedraws(s.p)
    const el = els[els.length - 1]
    const kept = el ? el.points.length - 1 : 0
    const last = el ? lastScene(el) : null
    out.P2 = {
      ok: els.length === before + 1 && kept >= sent * 0.9 && near(last, { x: end.x - s.box.x, y: end.y - s.box.y }),
      detail: `笔画数 ${before} → ${els.length};这一笔 ${kept}/${sent} 个点;末点场景坐标 ` +
        (last ? `(${last.x.toFixed(1)},${last.y.toFixed(1)}) 应在 (${(end.x - s.box.x).toFixed(1)},${(end.y - s.box.y).toFixed(1)})` : '无'),
    }
  }
  // P3 手掌先放:手掌按着、挪一下,笔落下画 15 帧,笔抬起后手掌才抬。
  //    手掌落笔前那一下挪动会单指平移画布(笔模式本来如此,分不出是手掌还是想平移的手指),
  //    所以这条不比绝对坐标,比笔画自身的位移:被当成双指缩放的话位移会跟着缩放走样。
  {
    const before = (await freedraws(s.p)).length
    const palm = { x: s.box.x + 700, y: s.box.y + 300, id: 9 }
    await s.touch('touchStart', [palm])
    await s.frame()
    await s.touch('touchMove', [{ ...palm, x: palm.x + 5, y: palm.y + 5 }])
    await s.frame()
    const start = { x: s.box.x + 120, y: s.box.y + 480 }
    const { sent, end } = await stroke(s, start, 15, 1, 8, 2)
    await s.touch('touchEnd', [])
    await settle(s.p)
    const els = await freedraws(s.p)
    const el = els.length > before ? els[els.length - 1] : null
    const kept = el ? el.points.length - 1 : 0
    const span = el ? { x: el.points[el.points.length - 1][0] - el.points[0][0], y: el.points[el.points.length - 1][1] - el.points[0][1] } : null
    const want = { x: end.x - start.x, y: end.y - start.y }
    out.P3 = {
      ok: !!el && kept >= sent * 0.9 && near(span, want),
      detail: el ? `画出了,${kept}/${sent} 个点,笔画位移 (${span.x.toFixed(1)},${span.y.toFixed(1)}) 应为 (${want.x},${want.y})` : '笔画没开始(手掌和笔被当成双指)',
    }
  }
  // P4 笔的抬起丢了 → 鼠标按下
  {
    const before = (await freedraws(s.p)).length
    await s.p.evaluate(() => { window.__dropPenUp = true })
    const start = { x: s.box.x + 500, y: s.box.y + 120 }
    const { end } = await stroke(s, start, 8, 1, 8, 2)
    const b = { x: s.box.x + 500, y: s.box.y + 600 }
    await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', buttons: 0 })
    await s.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 10; i++) {
      await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + i * 10, y: b.y, button: 'none', buttons: 1 })
      await s.frame()
    }
    await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x + 100, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
    await settle(s.p)
    // 按创建顺序认:先笔后鼠标。P3 的手掌平移过画布,不比绝对坐标,比笔画自身的位移
    const [penEl, mouseEl] = (await freedraws(s.p)).slice(before)
    const span = penEl ? { x: penEl.points[penEl.points.length - 1][0] - penEl.points[0][0], y: penEl.points[penEl.points.length - 1][1] - penEl.points[0][1] } : null
    const want = { x: end.x - start.x, y: end.y - start.y }
    out.P4 = {
      ok: !!penEl && near(span, want) && !!mouseEl && mouseEl.points.length >= 8,
      detail: `笔那一笔位移 ${span ? `(${span.x.toFixed(1)},${span.y.toFixed(1)})` : '无'} 应为 (${want.x},${want.y})` +
        `;鼠标那一笔 ${mouseEl ? mouseEl.points.length + ' 个点' : '没画出来'}`,
    }
  }
  return out
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  let failed = 0
  const runs = {}
  for (const patched of [true, false]) {
    const s = await open(browser, patched)
    const tag = patched ? '补丁版' : '原版引擎(负对照)'
    if (patched && s.marker !== 1) {
      console.log(`FAIL  ${tag}:副本没打补丁(__forsionPenPatch=${s.marker}),先跑 node build/copy-excalidraw-assets.cjs`)
      failed++
    }
    runs[tag] = await scenarios(s)
    for (const [k, r] of Object.entries(runs[tag])) {
      const pass = patched || r.always ? r.ok : !r.ok
      if (!pass) failed++
      console.log(`${pass ? 'PASS' : 'FAIL'}  [${tag}] ${k} ${patched || r.always ? '' : '应当红:'}${r.ok ? '过' : '没过'}  | ${r.detail}`)
    }
    if (s.errs.length) {
      failed++
      console.log(`FAIL  [${tag}] 页面报错:${s.errs.join(' / ')}`)
    }
    await s.ctx.close()
  }
  await browser.close()
  console.log(failed ? `\n${failed} 条没过` : '\n全部通过')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
