// 块拖拽手感仪器(页面编辑手感方案 2026-11-17,批了 1/2/3/4/5①/6/8)。真输入:`page.mouse` 真拖 +
// 静止期同坐标 mouse.move 模拟 OS 周期 dragover(同 columns-realdrag / toplevel-realdrag)。
//
//  第 1 条 左缝分道(照 Notion):⠿ 那一道和正文里 = 换位;越过 ⠿ 再往左 = 拼左栏;右缘 / 右页边拼右栏
//  D1 ⠿ 那一道笔直往下拖:一路只出横线、从不出竖线;松手是换位、不成列(修前:左缝 0 根线、松手无反应)
//  D2 越过 ⠿ 左沿(正文左缘外 90px)静止:只有竖线;松手成列、被拖块在左
//  D3 从 ⠿ 往右进正文左缘内 14px:只有横线(修前:正文左缘 28px 是拼栏带,一进正文就变竖线)
//  D4 正文右缘内 10px:竖线,松手成列、被拖块在右(右缘规则不变)
//  D4b 右页边(正文右缘外 30px):同样拼右栏
//  D12 页边在末块之下:文末那条线,松手搬到文末
//  D13 窄 pane(700px,⠿ 左边没地方):⠿ 那一道仍是换位;拼左栏退回正文左缘内 28px(不丢能力)
//  D14 悬浮目录:900px 时目录盖住 ⠿ 左边那块 → 同 D13 退回左缘带;1200px 时越过 ⠿ 照常拼、目录上不出线
//  评审回归(Codex 11-18)
//  D15 页边只认本编辑器:拖到吸顶工具栏上松手 → 不动文档(修前:页边路由当成左页边、topBlockAtY 把块挪到文首)
//  D16 从 ⠿ 道斜进正文宽度内的文末续写区 → 只剩一根线(修前:页边那根没收,两根同在)
//  D17 贴边自动滚远了再放进列表项当子项 → 视图不往回跳(修前:选区留在源处,scrollIntoView 一跳几百 px)
//  D18 按住复制键拖到源块紧邻的缝 → 复制成功(修前:落点库按起拖时的 move 当「落回自己」拒掉)
//  第 2 条 自动滚动按帧 + 滚动后原地重判
//  D5 长文贴 pane 下沿按住不动 → pane 滚下去;松手落在指针下那块附近(修前:落回滚动前那条缝,偏 ~290px)
//  第 3 条 拖影
//  D7 setDragImage 拿到的是副本包装(.unified-drag-ghost),里面没有选中类,下一帧就从文档摘掉
//  第 4 条 把手按帧跟手
//  D8 指针从 A 块挪到 B 块,40ms 内把手已锚到 B(修前:80ms 节流 + 后沿)
//  第 5① 条 一条缝只画一根线、画在缝中线
//  D6 同一条缝:靠上块下半 / 靠下块上半 两处悬停,线的 y 一样、都在两块之间的中线
//  第 6 条 松手落位
//  D10 松手后被拖块身上有一段进行中的动画(Web Animations,不写内联样式)
//  D11 减少动效时没有落位动画
//  第 8 条 滚动停下补一次把手命中
//  D9 指针停在块上滚 pane,停下 300ms 内把手回来、锚在指针下的那块
// 用法:node scripts/e2e-editor.cjs --check=unified-dragfeel(或 npm run check:dragfeel)
//      5173 被别的检出占着时:HARNESS_URL=http://localhost:<port>/harness.html
const fs = require('fs'), os = require('os'), path = require('path')
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
const SHOT_DIR = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice('--shot='.length)
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const P = (n) => `段${n}。这是第 ${n} 段,用来拖。`
/** 八段短文:左缝分道 / 缝中线 / 把手跟手。 */
const SEED_SHORT = Array.from({ length: 8 }, (_, i) => P(i + 1)).join('\n\n') + '\n'
/** 八十段长文:贴边自动滚动。 */
const SEED_LONG = Array.from({ length: 80 }, (_, i) => P(i + 1)).join('\n\n') + '\n'
/** 带标题的八段(悬浮目录要有标题才挂出来)。 */
const SEED_TOC = ['## 甲节', P(1), P(2), '## 乙节', P(3), P(4), P(5), '## 丙节', P(6), P(7), '## 丁节', P(8)].join('\n\n') + '\n'
const READY = '.unified-body .ProseMirror > p'

async function openPage(browser, seed, opts = {}) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: opts.width ?? 1200, height: opts.height ?? 1000 }, reducedMotion: opts.reducedMotion ?? 'no-preference' })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.addInitScript(() => {
    // 拖影探针:记下 setDragImage 拿到的元素,再隔两帧看它还在不在文档里。
    window.__ghost = []
    const origDI = DataTransfer.prototype.setDragImage
    DataTransfer.prototype.setDragImage = function (el, x, y) {
      const er = el.getBoundingClientRect()
      const br = el.querySelector('.unified-drag-ghost-blk')?.getBoundingClientRect()
      const rec = {
        cls: String(el.className), x, y, connected: el.isConnected,
        blkDx: br ? br.left - er.left : null, blkDy: br ? br.top - er.top : null,
        blk: el.querySelectorAll('.unified-drag-ghost-blk').length,
        sel: el.querySelectorAll('.amx-block-selected, .ProseMirror-selectednode').length,
        text: (el.textContent || '').slice(0, 20), later: null,
      }
      window.__ghost.push(rec)
      requestAnimationFrame(() => requestAnimationFrame(() => { rec.later = el.isConnected }))
      return origDI.call(this, el, x, y)
    }
    // 动画探针:谁调了 Element.animate(落位动画走 WAAPI;evaluate 往返赶不上 160ms 的动画本身)。
    window.__anims = []
    const origA = Element.prototype.animate
    Element.prototype.animate = function (kf, o) {
      try { window.__anims.push({ text: (this.textContent || '').slice(0, 6), dur: typeof o === 'number' ? o : o?.duration }) } catch { /* 探针不碍事 */ }
      return origA.call(this, kf, o)
    }
  })
  await p.goto(`${URL}?upage&upane${opts.query ?? ''}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.unified-body .ProseMirror', { timeout: 20000 })
  await p.evaluate(([f, s]) => window.__upage.switchFile(f, s), ['Feel.md', seed])
  await p.waitForSelector(READY, { timeout: 20000 })
  await p.waitForTimeout(600)
  return p
}

/** 可见的指示线(宽度 > 0)。 */
const lines = (p) => p.evaluate(() => [...document.querySelectorAll('.unified-drop-line, .unified-drop-vline')]
  .filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0)
  .map((el) => { const r = el.getBoundingClientRect(); return { v: el.classList.contains('unified-drop-vline'), x: Math.round(r.x), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) } }))

/** 文档速写:顶层节点,段落取「段N」,分栏行记成 { row: [[…],[…]] }。 */
const shape = (p) => p.evaluate(() => {
  const v = window.__upage.probe.view()
  const tag = (n) => n.type.name === 'paragraph' ? (n.textContent.match(/^段\d+/)?.[0] ?? n.textContent.slice(0, 4)) : n.type.name
  const out = []
  v.state.doc.forEach((n) => {
    if (n.type.name === 'amadeusColumnRow') {
      const row = []
      n.forEach((c) => { const cell = []; c.forEach((k) => cell.push(tag(k))); row.push(cell) })
      out.push({ row })
    } else out.push(tag(n))
  })
  return out
})
const rectOf = (p, n) => p.evaluate((k) => {
  const el = [...document.querySelectorAll('.unified-body .ProseMirror > p')].find((x) => x.textContent.startsWith(`段${k}。`))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }
}, n)
const gutterState = (p) => p.evaluate(() => {
  const g = document.querySelector('.unified-gutter')
  const h = g?.querySelector('.drag-handle')
  if (!g || !h) return null
  const r = h.getBoundingClientRect()
  return { show: g.dataset.show === 'true', x: r.x + r.width / 2, y: r.y + Math.min(10, r.height / 2), top: r.y }
})

/** hover 到块 → 等 gutter 挂出且稳住 → ⠿ 中心。 */
async function handleAt(p, x, y) {
  await p.mouse.move(x, y, { steps: 4 })
  let prev = null
  for (let t = 0; t < 3000; t += 40) {
    await p.waitForTimeout(40)
    const g = await gutterState(p)
    if (g?.show && prev && Math.abs(prev.y - g.y) < 0.5) return g
    prev = g
  }
  return null
}
/** 静止期:同坐标反复 move = OS 周期补发的 dragover。 */
const idle = async (p, x, y, ms = 240) => { for (let t = 0; t < ms; t += 15) { await p.mouse.move(x, y); await p.waitForTimeout(15) } }
async function press(p, from) {
  await p.mouse.move(from.x, from.y)
  await p.mouse.down()
  await p.mouse.move(from.x + 3, from.y + 4, { steps: 2 })
}
async function release(p) {
  await p.mouse.up()
  await p.waitForTimeout(450)
}
const hasRow = (doc) => doc.some((n) => n && typeof n === 'object' && n.row)

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const shot = async (p, name) => { if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await p.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) }) } }

  // ── D1 ⠿ 那一道笔直往下 → 只出横线;松手换位 ─────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const t = await rectOf(p, 6)
    const seen = []
    if (h) {
      await press(p, h)
      // 笔直往下:x 钉在 ⠿ 中心,每 10px 停一下读线(真人往下拖时 ⠿ 那一道就是这条竖带)
      for (let y = h.y + 10; y <= t.y + t.h * 0.75; y += 10) {
        await p.mouse.move(h.x, y)
        await idle(p, h.x, y, 45)
        seen.push(...(await lines(p)))
      }
      await p.mouse.move(h.x, t.y + t.h * 0.75)
      await idle(p, h.x, t.y + t.h * 0.75)
    }
    const during = h ? await lines(p) : []
    if (h) await release(p)
    const doc = await shape(p)
    check('D1 前置:把手挂出来了', !!h, JSON.stringify(h))
    check('D1 ⠿ 那一道往下:一路出过横线、从没出过竖线', seen.some((l) => !l.v) && !seen.some((l) => l.v), JSON.stringify({ n: seen.length, v: seen.filter((l) => l.v).length }))
    check('D1 松手前停在段6 下半:恰好一条横线', during.length === 1 && !during[0].v, JSON.stringify(during))
    check('D1 松手是换位(段2 落到段6 之后)、不成列', !hasRow(doc) && doc.indexOf('段2') === doc.indexOf('段6') + 1, JSON.stringify(doc))
    await shot(p, 'D1-after')
    await p.close()
  }

  // ── D2 越过 ⠿ 左沿 → 竖线;松手成列、被拖块在左 ────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const t = await rectOf(p, 5)
    let during = []
    if (h) {
      await press(p, h)
      await p.mouse.move(t.x - 90, t.y + t.h / 2, { steps: 10 })
      await idle(p, t.x - 90, t.y + t.h / 2)
      during = await lines(p)
      await shot(p, 'D2-during')
      await release(p)
    }
    const doc = await shape(p)
    const row = doc.find((n) => n && n.row)?.row
    check('D2 越过 ⠿ 左沿静止:只有竖线', during.length === 1 && during[0].v, JSON.stringify(during))
    check('D2 松手成列 [段2 | 段5]', !!row && row.length === 2 && row[0][0] === '段2' && row[1][0] === '段5', JSON.stringify(doc))
    await p.close()
  }

  // ── D3 从 ⠿ 往右进正文左缘内 14px → 只有横线 ───────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const t = await rectOf(p, 5)
    let during = []
    const seen = []
    if (h) {
      await press(p, h)
      // 先斜着从 ⠿ 往右下进正文(修前一进正文左缘就是拼栏带)
      for (let k = 1; k <= 8; k++) {
        const x = h.x + ((t.x + 14) - h.x) * k / 8, y = h.y + ((t.y + t.h * 0.3) - h.y) * k / 8
        await p.mouse.move(x, y)
        await idle(p, x, y, 45)
        seen.push(...(await lines(p)))
      }
      during = await lines(p)
      await release(p)
    }
    const doc = await shape(p)
    check('D3 从 ⠿ 斜进正文左缘内 14px:一路没出过竖线', !seen.some((l) => l.v), JSON.stringify(seen.filter((l) => l.v)))
    check('D3 停住时只有横线', during.length === 1 && !during[0].v, JSON.stringify(during))
    check('D3 松手是换位、不成列', !hasRow(doc), JSON.stringify(doc))
    await p.close()
  }

  // ── D4 / D4b 右缘 / 右页边 → 拼右栏 ───────────────────────────────────────────────────
  for (const [name, dx] of [['D4 正文右缘内 10px', -10], ['D4b 右页边(右缘外 30px)', 30]]) {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const t = await rectOf(p, 5)
    let during = []
    if (h) {
      await press(p, h)
      await p.mouse.move(t.r + dx, t.y + t.h / 2, { steps: 10 })
      await idle(p, t.r + dx, t.y + t.h / 2)
      during = await lines(p)
      await release(p)
    }
    const doc = await shape(p)
    const row = doc.find((n) => n && n.row)?.row
    check(`${name}:只有竖线`, during.length === 1 && during[0].v, JSON.stringify(during))
    check(`${name}:松手成列 [段5 | 段2]`, !!row && row.length === 2 && row[0][0] === '段5' && row[1][0] === '段2', JSON.stringify(doc))
    await p.close()
  }

  // ── D12 页边在末块之下 → 文末 ──────────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const last = await rectOf(p, 8)
    let during = []
    if (h) {
      await press(p, h)
      await p.mouse.move(h.x, last.b + 40, { steps: 12 })
      await idle(p, h.x, last.b + 40)
      during = await lines(p)
      await release(p)
    }
    const doc = await shape(p)
    check('D12 左页边、末块之下:一条横线', during.length === 1 && !during[0].v, JSON.stringify(during))
    check('D12 松手搬到文末', doc.filter((n) => typeof n === 'string' && n.startsWith('段')).at(-1) === '段2' && !hasRow(doc), JSON.stringify(doc))
    await p.close()
  }

  // ── D6 一条缝一根线、画在缝中线 ────────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 7)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const u = await rectOf(p, 3), d = await rectOf(p, 4)
    const ys = []
    if (h) {
      await press(p, h)
      for (const y of [u.b - 3, d.y + 3]) {
        await p.mouse.move(u.x + 120, y, { steps: 6 })
        await idle(p, u.x + 120, y)
        ys.push(await lines(p))
      }
      await p.keyboard.press('Escape')
      await release(p)
    }
    const mid = (u.b + d.y) / 2
    const [l1, l2] = ys
    check('D6 段3 下沿 / 段4 上沿各一根线', !!l1 && !!l2 && l1.length === 1 && l2.length === 1 && !l1[0].v && !l2[0].v, JSON.stringify(ys))
    check('D6 两处的线同一个 y,在缝中线 ±2px', !!l1?.[0] && !!l2?.[0] && Math.abs(l1[0].y - l2[0].y) <= 1 && Math.abs(l1[0].y - mid) <= 2, JSON.stringify({ y1: l1?.[0]?.y, y2: l2?.[0]?.y, mid }))
    await p.close()
  }

  // ── D7 拖影 = 副本包装、无选中类、下一帧摘掉 ────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 3)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    if (h) {
      await press(p, h)
      await p.mouse.move(h.x + 40, h.y + 80, { steps: 6 })
      await idle(p, h.x + 40, h.y + 80, 120)
      await p.keyboard.press('Escape')
      await release(p)
    }
    const g = await p.evaluate(() => window.__ghost)
    const rec = g?.[0]
    // 拖影里块相对指针的位置 = 页面上块相对按下点的位置(拿起不跳)。dragstart 坐标是越过拖动阈值那一下,给 6px 余量。
    const ghostDx = rec && rec.blkDx != null ? rec.blkDx - rec.x : null, ghostDy = rec && rec.blkDy != null ? rec.blkDy - rec.y : null
    check('D7 setDragImage 只调了一次、给的是副本包装', !!rec && g.length === 1 && /unified-drag-ghost/.test(rec.cls) && rec.blk === 1 && rec.connected, JSON.stringify(g))
    check('D7 副本里没有选中类、内容是被拖那段', !!rec && rec.sel === 0 && rec.text.startsWith('段3'), JSON.stringify(rec))
    check('D7 拿起不跳:拖影里块相对指针的位置 = 页面上块相对按下点(±6px)', !!h && ghostDx != null && Math.abs(ghostDx - (a.x - h.x)) <= 6 && Math.abs(ghostDy - (a.y - h.y)) <= 6, JSON.stringify({ ghost: [ghostDx, ghostDy], page: h && [a.x - h.x, a.y - h.y] }))
    check('D7 下一帧副本已摘掉', !!rec && rec.later === false, JSON.stringify(rec?.later))
    const left = await p.evaluate(() => document.querySelectorAll('.unified-drag-ghost').length)
    check('D7 文档里不留拖影', left === 0, String(left))
    await p.close()
  }

  // ── D8 把手按帧跟手 ───────────────────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 2), b = await rectOf(p, 6)
    const c = await rectOf(p, 4)
    await handleAt(p, a.x + 30, a.y + a.h / 2)
    // 两步:先过段4,紧跟着到段6(节流窗口里的第二下;前沿节流只认第一下,后沿要等满 80ms)
    await p.mouse.move(c.x + 30, c.y + c.h / 2)
    await p.mouse.move(b.x + 30, b.y + b.h / 2)
    await p.waitForTimeout(30)
    const g = await gutterState(p)
    check('D8 指针经段4 再到段6,30ms 后把手已锚到段6', !!g && g.show && g.y >= b.y - 2 && g.y <= b.b + 2, JSON.stringify({ g, b6: [b.y, b.b] }))
    await p.close()
  }

  // ── D9 滚动停下补一次把手命中 ──────────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_LONG, { height: 800 })
    const a = await rectOf(p, 5)
    await handleAt(p, a.x + 30, a.y + a.h / 2)
    const x = a.x + 30, y = a.y + a.h / 2
    await p.mouse.wheel(0, 300)
    await p.waitForTimeout(320)
    const g = await gutterState(p)
    const under = await p.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y)?.closest('.unified-body .ProseMirror > p')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { t: el.textContent.slice(0, 4), y: r.y, b: r.bottom }
    }, [x, y])
    check('D9 前置:滚动真把内容挪了(指针下换了一段)', !!under && under.t !== '段5。', JSON.stringify(under))
    check('D9 停下 320ms 内把手回来、锚在指针下那段', !!g && g.show && !!under && g.y >= under.y - 2 && g.y <= under.b + 2, JSON.stringify({ g, under }))
    await p.close()
  }

  // ── D5 贴边自动滚动 + 滚动后原地重判 ────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_LONG, { height: 800 })
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const pane = await p.evaluate(() => {
      const v = window.__upage.probe.view()
      let el = v.dom.parentElement
      while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement
      el = el || document.scrollingElement
      const r = el === document.scrollingElement ? { top: 0, bottom: innerHeight } : el.getBoundingClientRect()
      window.__pane = el
      return { top: r.top, bottom: r.bottom, st: el.scrollTop }
    })
    let res = null
    if (h) {
      await press(p, h)
      const x = a.x + 120, y = pane.bottom - 14
      await p.mouse.move(x, y, { steps: 12 })
      // 贴下沿按住不动(同坐标的 dragover 只是系统补发):内容在指针下滚过去,不挪指针直接松手。
      // 修前:同坐标沿用上次落点 → 线和落点都停在滚动开始那条缝。
      await idle(p, x, y, 900)
      const line = await lines(p)
      const under = await p.evaluate(([, y]) => {
        const ps = [...document.querySelectorAll('.unified-body .ProseMirror > p')]
        let best = null, bd = Infinity
        for (const el of ps) { const r = el.getBoundingClientRect(); const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0; if (d < bd) { bd = d; best = el } }
        return best?.textContent.match(/^段\d+/)?.[0] ?? null
      }, [x, y])
      await release(p)
      const st = await p.evaluate(() => window.__pane.scrollTop)
      const doc = await shape(p)
      res = { st0: pane.st, st, line, y2: y, under, idx: doc.indexOf('段2'), uIdx: doc.indexOf(under) }
    }
    check('D5 贴下沿按住:pane 滚下去了(>400px)', !!res && res.st - res.st0 > 400, JSON.stringify(res && { st0: res.st0, st: res.st }))
    check('D5 滚动中:线在指针附近(±40px),不是停在滚动前那条缝', !!res && res.line.length === 1 && Math.abs(res.line[0].y - res.y2) <= 40, JSON.stringify(res && { line: res.line, y2: res.y2 }))
    check('D5 不挪指针直接松手:落在指针下那段旁边(±2 段,松手那一刻还在滚)', !!res && res.idx >= 0 && res.uIdx >= 0 && Math.abs(res.idx - res.uIdx) <= 2, JSON.stringify(res && { under: res.under, idx: res.idx, uIdx: res.uIdx }))
    await p.close()
  }

  // ── D10 / D11 松手落位动画(减少动效时没有) ───────────────────────────────────────────
  for (const [name, rm] of [['D10', 'no-preference'], ['D11', 'reduce']]) {
    const p = await openPage(browser, SEED_SHORT, { reducedMotion: rm })
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const t = await rectOf(p, 6)
    let anim = null
    if (h) {
      await press(p, h)
      await p.mouse.move(t.x + 120, t.b - 4, { steps: 10 })
      await idle(p, t.x + 120, t.b - 4)
      await p.evaluate(() => { window.__anims.length = 0 })
      await p.mouse.up()
      await p.waitForTimeout(400)
      anim = await p.evaluate(() => {
        const v = window.__upage.probe.view()
        let el = null
        v.state.doc.forEach((n, off) => { if (n.textContent.startsWith('段2。')) el = v.nodeDOM(off) })
        const mine = window.__anims.filter((x) => x.text.startsWith('段2'))
        return { n: mine.length, dur: mine[0]?.dur ?? null, inline: el?.getAttribute('style') ?? '' }
      })
    }
    const doc = await shape(p)
    check(`${name} 前置:松手换位成功`, doc.indexOf('段2') === doc.indexOf('段6') + 1, JSON.stringify(doc))
    if (rm === 'reduce') check('D11 减少动效:没有落位动画', !!anim && anim.n === 0, JSON.stringify(anim))
    else check('D10 松手后被拖块起了一段落位动画(WAAPI)、不写内联样式', !!anim && anim.n >= 1 && !/transform/.test(anim.inline), JSON.stringify(anim))
    await p.close()
  }

  // ── D13 窄 pane:⠿ 左边没地方 → ⠿ 道换位、拼左栏退回正文左缘内 ────────────────────────────
  async function laneAndInner(name, seed, opts) {
    const p = await openPage(browser, seed, opts)
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const t = await rectOf(p, 5)
    const seen = []
    let during = []
    if (h) {
      await press(p, h)
      for (let y = h.y + 10; y <= t.y + t.h * 0.75; y += 12) {
        await p.mouse.move(h.x, y)
        await idle(p, h.x, y, 45)
        seen.push(...(await lines(p)))
      }
      await p.mouse.move(t.x + 8, t.y + t.h / 2, { steps: 4 })
      await idle(p, t.x + 8, t.y + t.h / 2)
      during = await lines(p)
      await release(p)
    }
    const doc = await shape(p)
    const row = doc.find((n) => n && n.row)?.row
    check(`${name} ⠿ 那一道往下:只出横线`, seen.some((l) => !l.v) && !seen.some((l) => l.v), JSON.stringify({ n: seen.length, v: seen.filter((l) => l.v).length }))
    check(`${name} 正文左缘内 8px:竖线(退回左缘带)`, during.length === 1 && during[0].v, JSON.stringify(during))
    check(`${name} 松手成列 [段2 | 段5]`, !!row && row.length === 2 && row[0][0] === '段2' && row[1][0] === '段5', JSON.stringify(doc))
    await p.close()
  }
  await laneAndInner('D13 窄 pane 700px:', SEED_SHORT, { width: 700 })
  await laneAndInner('D14a 目录 900px:', SEED_TOC, { width: 900, query: '&utoc' })

  // ── D14b 目录 1200px:越过 ⠿ 照常拼左栏;指针在目录上不出线 ─────────────────────────────
  {
    const p = await openPage(browser, SEED_TOC, { width: 1200, query: '&utoc' })
    const toc = await p.evaluate(() => { const el = document.querySelector('.lcl-ftoc'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, r: r.right, y: r.y, b: r.bottom } })
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const t = await rectOf(p, 5)
    let onToc = null, during = []
    if (h && toc) {
      await press(p, h)
      await p.mouse.move(t.x - 90, t.y + t.h / 2, { steps: 8 })
      await idle(p, t.x - 90, t.y + t.h / 2)
      during = await lines(p)
      const ty = Math.min(Math.max(t.y + t.h / 2, toc.y + 4), toc.b - 4)
      await p.mouse.move((toc.x + toc.r) / 2, ty, { steps: 6 })
      await idle(p, (toc.x + toc.r) / 2, ty)
      onToc = await lines(p)
      await p.mouse.move(t.x - 90, t.y + t.h / 2, { steps: 6 })
      await idle(p, t.x - 90, t.y + t.h / 2)
      await release(p)
    }
    const doc = await shape(p)
    const row = doc.find((n) => n && n.row)?.row
    check('D14b 前置:目录挂出来了', !!toc, JSON.stringify(toc))
    check('D14b 目录 1200px 越过 ⠿:竖线', during.length === 1 && during[0].v, JSON.stringify(during))
    check('D14b 指针在目录上:不出线', !!onToc && onToc.length === 0, JSON.stringify(onToc))
    check('D14b 回到 ⠿ 左边松手成列 [段2 | 段5]', !!row && row[0][0] === '段2' && row[1][0] === '段5', JSON.stringify(doc))
    await p.close()
  }

  // ── D15 吸顶工具栏上松手:不归页边管 ─────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_LONG, { height: 800 })
    const a0 = await rectOf(p, 3)
    await p.mouse.move(a0.x + 200, a0.y + 10)
    await p.mouse.wheel(0, 240)
    await p.waitForTimeout(400)
    const bar = await p.evaluate(() => { const el = document.querySelector('.amx-toolbar'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, pos: getComputedStyle(el).position } })
    const vis = await p.evaluate(() => { const el = [...document.querySelectorAll('.unified-body .ProseMirror > p')].find((x) => x.getBoundingClientRect().top > 160); const r = el.getBoundingClientRect(); return { t: el.textContent.match(/^段\d+/)[0], x: r.x, y: r.y, h: r.height } })
    const before = await shape(p)
    const h = await handleAt(p, vis.x + 30, vis.y + vis.h / 2)
    let during = null
    if (h && bar) {
      await press(p, h)
      const tx = vis.x - 60, ty = bar.y + bar.h / 2
      await p.mouse.move(tx, ty, { steps: 10 })
      await idle(p, tx, ty)
      during = await lines(p)
      await release(p)
    }
    const after = await shape(p)
    check('D15 前置:工具栏在、拖起来了', !!bar && !!h, JSON.stringify({ bar, h: !!h }))
    check('D15 工具栏上:不出线', !!during && during.length === 0, JSON.stringify(during))
    check('D15 工具栏上松手:文档不变', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ moved: vis.t, head: after.slice(0, 4) }))
    await p.close()
  }

  // ── D16 ⠿ 道 → 正文宽度内的文末续写区:只剩一根线 ───────────────────────────────────────
  {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 2)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const t = await rectOf(p, 5), last = await rectOf(p, 8)
    let mid = null, end = null
    if (h) {
      await press(p, h)
      await p.mouse.move(h.x, t.y + t.h * 0.75, { steps: 8 })
      await idle(p, h.x, t.y + t.h * 0.75)
      mid = await lines(p)
      // 停在 ⠿ 道、末块下半(页边画的是正文同一套精确线),再**一步**跳进正文宽度内的文末续写区:
      // 中间不经过 view.dom,正文路由收不到 dragleave,页边那根线只能由路由切换时收掉。
      await p.mouse.move(h.x, last.y + last.h * 0.75, { steps: 6 })
      await idle(p, h.x, last.y + last.h * 0.75)
      await p.mouse.move(last.x + 200, last.b + 40)
      await idle(p, last.x + 200, last.b + 40)
      end = await lines(p)
      await release(p)
    }
    const doc = await shape(p)
    check('D16 ⠿ 道里:一根横线', !!mid && mid.length === 1 && !mid[0].v, JSON.stringify(mid))
    check('D16 斜进文末续写区:仍只有一根线', !!end && end.length === 1, JSON.stringify(end))
    check('D16 松手搬到文末', doc.filter((n) => typeof n === 'string' && n.startsWith('段')).at(-1) === '段2', JSON.stringify(doc))
    await p.close()
  }

  // ── D17 自动滚远后放进列表项当子项:视图不往回跳 ──────────────────────────────────────────
  {
    const items = Array.from({ length: 8 }, (_, i) => `- 项${i + 1}:列表里的一项`).join('\n')
    const seed = Array.from({ length: 30 }, (_, i) => P(i + 1)).join('\n\n') + '\n\n' + items + '\n\n' + Array.from({ length: 30 }, (_, i) => P(i + 31)).join('\n\n') + '\n'
    const p = await openPage(browser, seed, { height: 800 })
    const a = await rectOf(p, 1)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const pane = await p.evaluate(() => {
      const v = window.__upage.probe.view()
      let el = v.dom.parentElement
      while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement
      window.__pane = el
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    })
    let res = null
    if (h) {
      await press(p, h)
      const x = a.x + 120, y = pane.bottom - 12
      await p.mouse.move(x, y, { steps: 10 })
      let li = null
      for (let k = 0; k < 40 && !li; k++) {
        await idle(p, x, y, 100)
        li = await p.evaluate(([top, bottom]) => {
          const el = [...document.querySelectorAll('.unified-body .ProseMirror > ul > li')].find((x) => { const r = x.getBoundingClientRect(); return r.top > top + 120 && r.bottom < bottom - 120 })
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { t: el.textContent.slice(0, 3), x: r.x, y: r.y, h: r.height }
        }, [pane.top, pane.bottom])
      }
      if (li) {
        const tx = li.x + 80, ty = li.y + li.h - 4
        await p.mouse.move(tx, ty, { steps: 6 })
        await idle(p, tx, ty)
        const st0 = await p.evaluate(() => window.__pane.scrollTop)
        await p.mouse.up()
        await p.waitForTimeout(600)
        const st1 = await p.evaluate(() => window.__pane.scrollTop)
        const nested = await p.evaluate(() => { const el = [...document.querySelectorAll('.unified-body .ProseMirror li li')].find((x) => x.textContent.startsWith('段1。')); if (!el) return null; const r = el.getBoundingClientRect(); return { y: r.y, inView: r.top >= 0 && r.bottom <= innerHeight } })
        res = { li: li.t, st0, st1, nested }
      } else {
        await release(p)
      }
    }
    check('D17 前置:滚到列表、段1 当子项放进去了', !!res && !!res.nested, JSON.stringify(res))
    check('D17 松手后视图不往回跳(±80px)、落下的那项看得见', !!res && Math.abs(res.st1 - res.st0) <= 80 && !!res.nested?.inView, JSON.stringify(res))
    await p.close()
  }

  // ── D18 按住复制键拖到源块紧邻的缝:复制 ─────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_SHORT)
    const a = await rectOf(p, 3)
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    let during = null
    if (h) {
      await p.keyboard.down('Alt')
      await press(p, h)
      await p.mouse.move(a.x + 150, a.b - 3, { steps: 6 })
      await idle(p, a.x + 150, a.b - 3)
      during = await lines(p)
      await release(p)
      await p.keyboard.up('Alt')
    }
    const doc = await shape(p)
    check('D18 复制键 + 源块下沿:出一根线', !!during && during.length === 1 && !during[0].v, JSON.stringify(during))
    check('D18 松手复制出一份(段3 两份、段4 还在后面)', doc.filter((n) => n === '段3').length === 2 && doc.indexOf('段4') > doc.lastIndexOf('段3'), JSON.stringify(doc))
    await p.close()
  }

  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} passed`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
