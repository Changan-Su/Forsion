// PM-under-transform Spike(Canvas 双模式方案 §7 的 go/no-go 前置,2026-08-15)。
// 问的问题只有一个:把生产 UnifiedPage 放进一张 `transform: scale(k)` 的画布卡片里,
// 编辑面还成不成立 —— 点击落点(posAtCoords)、⠿ 把手定位、拖拽落点、IME 落字、多卡重叠命中。
// 背景:现行补偿一律走 zoomOf(=currentCSSZoom),而 CSS transform **不进** currentCSSZoom;
// getBoundingClientRect 却是缩放后的视口值。两者混用会出 k² 级偏差 —— 这个脚本负责实测而不是推理。
// 用法:node scripts/unified-scale.check.cjs   (需要 5173 上的 vite:npx vite frontend)
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
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, q) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&${q}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(400)
  return p
}

/** 目标段落的**视口**矩形(缩放后的真实屏幕位置 —— 用户点的就是这里)。 */
const rectOf = (p, text, card = 0) => p.evaluate(({ text, card }) => {
  const pm = [...document.querySelectorAll('[data-card]')][card]?.querySelector('.unified-body .ProseMirror')
  const el = [...pm.querySelectorAll(':scope > p')].find((x) => (x.textContent ?? '').includes(text))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}, { text, card })

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  for (const k of [1, 0.5, 2]) {
    const p = await open(browser, `uscale=${k}`)
    const tag = `scale=${k}`

    // S1 点击落点:点「第二段。」的行内,光标必须落进这一段(缩放下 posAtCoords 是否仍对)。
    const r1 = await rectOf(p, '第二段')
    await p.mouse.click(r1.x + 3, r1.y + r1.h / 2)
    await p.keyboard.type('X')
    const s1 = await p.evaluate((s) => {
      const kids = [...document.querySelector(s).children].map((x) => x.textContent ?? '')
      return { hit: kids.findIndex((t) => t.includes('X')), kids }
    }, PM)
    record(`S1 ${tag} 点击落点进对块`, s1.hit === 2 && /^X/.test(s1.kids[2]), JSON.stringify(s1.kids))

    // S2 ⠿ 把手定位:真鼠标悬到段上,把手要贴着该段首行(左侧泳道)。这是 zoomOf 补偿的正面。
    const r2 = await rectOf(p, '第一段')
    await p.mouse.move(r2.x + r2.w / 2, r2.y + r2.h / 2)
    await p.waitForTimeout(200)
    const s2 = await p.evaluate((k) => {
      const g = document.querySelector('.unified-gutter')
      if (!g || g.dataset.show !== 'true') return { show: false }
      const gr = g.getBoundingClientRect()
      const el = [...document.querySelectorAll('.unified-body .ProseMirror > p')].find((x) => (x.textContent ?? '').includes('第一段'))
      const pr = el.getBoundingClientRect()
      // 首行带的高度是**布局** 24px,量在视口里要乘回缩放(否则 k≠1 时这条断言自己就是错的)。
      return { show: true, dy: (gr.top + gr.height / 2) - (pr.top + Math.min(pr.height, 24 * k) / 2), left: gr.left < pr.left }
    }, k)
    record(`S2 ${tag} 把手贴块首行(|dy|≤8 且在正文左侧)`, !!s2.show && Math.abs(s2.dy) <= 8 && s2.left, JSON.stringify(s2))

    // S3 拖拽落点:从 ⠿ 把 “第一段” 拖到 “第二段” 下沿 —— 指示线要出现在目标块底,落盘顺序真的换。
    //    量之前必须等一帧以上:指示线的入场动画会在 100ms 内压过内联 transform(见 blockLayer 注释),
    //    量早了拿到的是动画里的位置,不是代码算的位置(第一版仪器就栽在这,dy 三个缩放全一样)。
    await p.evaluate((s) => {
      const gutter = document.querySelector('.unified-gutter')
      const drag = gutter.querySelector('.drag-handle')
      const md = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
      drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      const dt = new DataTransfer()
      window.__dt = dt
      md('dragstart', gutter, { dataTransfer: dt })
      const pm = document.querySelector(s)
      const p2 = [...pm.querySelectorAll(':scope > p')].find((x) => (x.textContent ?? '').includes('第二段'))
      const r = p2.getBoundingClientRect()
      window.__at = { clientX: r.left + 40, clientY: r.bottom - 2, dataTransfer: dt }
      window.__target = r.bottom
      md('dragover', pm, window.__at)
      md('dragover', pm, window.__at)
    }, PM)
    await p.waitForTimeout(200)
    const s3 = await p.evaluate((s) => {
      const md = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
      const all = [...document.querySelectorAll('.unified-drop-line')]
      const line = all.find((x) => x.style.display !== 'none')
      const shown = !!line
      const dy = shown ? line.getBoundingClientRect().top - window.__target : null
      const pm = document.querySelector(s)
      md('drop', pm, window.__at)
      md('dragend', document.querySelector('.unified-gutter'), { dataTransfer: window.__dt })
      return { shown, dy }
    }, PM)
    await p.waitForTimeout(1200)
    const s3b = await p.evaluate(() => {
      const w = window.__upage.writes
      return (w[w.length - 1]?.text ?? '')
    })
    // 断整段序列而不是 /第二段…第一段/:后者在「块被复制成两份」时照样绿(Codex P2 假绿面)。
    const blocks = s3b.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)
    const orderOk = blocks.length === 3 && /第二段/.test(blocks[1]) && /第一段/.test(blocks[2])
    record(`S3 ${tag} 拖拽:指示线贴目标块底(|dy|≤10)+ 顺序落盘`, s3.shown && Math.abs(s3.dy ?? 99) <= 10 && orderOk, JSON.stringify({ ...s3, orderOk }))

    // S4 IME:CDP 起真组合再提交(合成事件的 isComposing 到不了 React —— 既有仪器坑)。
    //    断言要落到**落点**上:点某一段的行首 → 组合出的字必须出现在那一段的开头。只断「某处含你好」
    //    的话,落进隔壁块也算绿(Codex P2 假绿面)。⚠️候选窗位置无头量不到,不在本仪器覆盖内。
    const cdp = await p.context().newCDPSession(p)
    const r4 = await rectOf(p, '第一段')
    await p.mouse.click(r4.x + 3, r4.y + r4.h / 2)
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
    await cdp.send('Input.insertText', { text: '你好' })
    await p.waitForTimeout(200)
    const s4 = await p.evaluate((s) => [...document.querySelector(s).children].map((x) => x.textContent ?? ''), PM)
    record(`S4 ${tag} IME 组合落字在光标处(该段开头)`, s4.some((t) => /^你好第一段/.test(t)), JSON.stringify(s4))

    await p.close()
  }

  // S5 多卡重叠:两张缩放卡片交叠,悬在上层卡的正文上,把手必须属于上层卡(命中不穿透)。
  const p5 = await open(browser, 'uscale=0.5&ucards=2')
  const r5 = await rectOf(p5, '卡二段一', 1)
  const at5 = { x: r5.x + r5.w / 2, y: r5.y + r5.h / 2 }
  await p5.mouse.move(at5.x, at5.y)
  await p5.waitForTimeout(250)
  const s5 = await p5.evaluate((at) => {
    // 先证「采样点真的落在两张卡的交叠区」—— 不证的话两卡没重叠也照样绿(Codex P2 假绿面)。
    const inCard = [...document.querySelectorAll('[data-card]')].map((c) => {
      const r = c.getBoundingClientRect()
      return at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom
    })
    const shown = [...document.querySelectorAll('.unified-gutter')].filter((g) => g.dataset.show === 'true')
    return { overlap: inCard.filter(Boolean).length, n: shown.length, cards: shown.map((g) => g.closest('[data-card]')?.dataset.card ?? '?') }
  }, at5)
  record('S5 重叠两卡:采样点在交叠区 + 把手只出在上层卡', s5.overlap === 2 && s5.n === 1 && s5.cards[0] === '1', JSON.stringify(s5))
  await p5.close()

  // 明确未覆盖(方案 §7 的 Codex 加测里属于 Phase 1 才存在的东西,现在没有可测对象):
  // 跨卡块拖放、跨卡选区夹断 —— 两者都要先有 amadeusCanvasCard 节点与卡片路由。别把「没测」
  // 读成「测过了」:Phase 1 落地时这两条要补进 unified-canvas.check.cjs。
  console.log('SKIP  跨卡块拖放 / 跨卡选区夹断:Phase 1 才有被测对象,记账在此,勿当已覆盖')

  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  // 结论行:给 §7 的 go/no-go 用。红了不是「测试挂了」,是渲染架构要回炉/先补 scale 补偿。
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
