// 丝滑光标「文档变了但选区对象没变」的落点契约(真 Chromium + 真 Milkdown + 真 smoothCaret.ts)。
//
// 病(用户实报):开着丝滑光标,在第二行行首按退格 —— 内容并到第一行去了,光标却还留在第二行。
// 两条路径都要量:① 块内两段合并(ProseMirror joinBackward);② 跨块合并(前块内容变 → 编辑器重挂)。
// check:caret 那支量的是「覆盖层与原生 caret 重合」的几何,量不到这里 —— 它不驱动真编辑器。
//
// 用法:npm run check:caretmerge(自带起停 vite);或 npm run web 后 node scripts/caret-merge.check.cjs
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
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 原生 caret(collapsed range 矩形)与覆盖层各自的视口坐标。 */
const geom = (page) =>
  page.evaluate(() => {
    const sel = getSelection()
    const rr = sel && sel.rangeCount ? sel.getRangeAt(0).getClientRects()[0] || sel.getRangeAt(0).getBoundingClientRect() : null
    const ov = document.querySelector('.sc-caret')
    const or = ov && ov.style.display !== 'none' ? ov.getBoundingClientRect() : null
    return {
      native: rr ? { top: Math.round(rr.top), left: Math.round(rr.left) } : null,
      overlay: or ? { top: Math.round(or.top), left: Math.round(or.left) } : null,
    }
  })

/** 光标落到第 bi 个块的第 li 个顶层子元素的第 off 个字符(off<0 = 末尾)。 */
async function caretAt(page, bi, li, off) {
  await page.locator('.md-block .ProseMirror').nth(bi).click()
  await page.evaluate(([b, i, o]) => {
    const pm = document.querySelectorAll('.md-block .ProseMirror')[b]
    const el = pm.children[i]
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const t = w.nextNode()
    const r = document.createRange()
    if (t) r.setStart(t, o < 0 ? t.length : Math.min(o, t.length))
    else r.setStart(el, 0)
    r.collapse(true)
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
  }, [bi, li, off])
  await page.waitForTimeout(200)
}

async function open(browser, seed) {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(`${BASE}?caret&seed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
  await page.waitForTimeout(600)
  return page
}

/** 覆盖层有 CSS 过渡,给它跑完的时间再量(过渡时长见 base.css 的 .sc-caret)。 */
const settle = (page) => page.waitForTimeout(500)

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // C1 块内:第 2 段行首退格 → 两段并成一段,光标该在合并点(第 1 行)
  {
    const page = await open(browser, '一行\n二行')
    await caretAt(page, 0, 1, 0)
    await settle(page)
    const before = await geom(page)
    check('C1 覆盖层已就位', !!before.overlay, JSON.stringify(before))
    await page.keyboard.press('Backspace')
    await settle(page)
    const after = await geom(page)
    check('C1 内容已合并', (await page.evaluate(() => document.querySelectorAll('.md-block .ProseMirror')[0].children.length)) === 1)
    check(
      'C1 光标跟到第一行(不留在第二行)',
      !!after.overlay && !!after.native && Math.abs(after.overlay.top - after.native.top) <= 3,
      JSON.stringify(after),
    )
    check('C1 光标确实上移了', !!after.overlay && !!before.overlay && after.overlay.top < before.overlay.top - 5, JSON.stringify({ before: before.overlay, after: after.overlay }))
    await page.close()
  }

  // C2 跨块:第 2 块行首退格 → 并进第 1 块(前块编辑器重挂),光标该落在合并点
  {
    const page = await open(browser, '第一块')
    // Shift+Enter 造第二块并打字
    await caretAt(page, 0, 0, -1)
    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(500)
    await page.keyboard.type('第二块', { delay: 25 })
    await page.waitForTimeout(600)
    const n0 = await page.locator('.md-block .ProseMirror').count()
    check('C2 造出两个块', n0 === 2, `blocks=${n0}`)
    await caretAt(page, 1, 0, 0)
    await settle(page)
    const before = await geom(page)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(900) // 跨块合并要等重挂 + 焦点回落
    const after = await geom(page)
    const n1 = await page.locator('.md-block .ProseMirror').count()
    check('C2 并成一个块', n1 === 1, `blocks=${n1}`)
    check(
      'C2 覆盖层与原生 caret 重合(焦点没丢)',
      !!after.overlay && !!after.native && Math.abs(after.overlay.top - after.native.top) <= 3,
      JSON.stringify({ before: before.overlay, after }),
    )
    // 接缝 = 前块原内容之后 = 合并块的**第一行**;落到第二行末尾就是用户实报的「光标还留在第二行」。
    const line1Top = await page.evaluate(() => Math.round(document.querySelectorAll('.md-block .ProseMirror')[0].children[0].getBoundingClientRect().top))
    check('C2 光标落在接缝处(第一行),不是并上来那段的尾巴', !!after.overlay && Math.abs(after.overlay.top - line1Top) <= 6, JSON.stringify({ overlay: after.overlay, line1Top }))
    await page.close()
  }

  // C3 空标题:`### ` 打完还没打字时,块里只剩 headingSource 的 `###` widget + PM 的零尺寸
  // `img.ProseMirror-separator`。collapsed range 此时一个矩形都给不出,旧代码的退路直接取
  // `childNodes[offset]` = 那个 separator → 光标画在基线上、还按 `.ProseMirror` 的字号取高
  // (h3 偏 17px/短 3px,h1 偏 25px/短 12px)。用户实报:「开丝滑光标后打标题必定偏」。
  // 真值取法与 check:caret 的空行用例同源 —— 补一个字符,量它 offset 0 处的 range 矩形。
  for (const [lv, hashes] of [[3, '### '], [1, '# ']]) {
    const page = await open(browser, '')
    await caretAt(page, 0, 0, 0)
    await page.keyboard.type(hashes, { delay: 25 })
    await settle(page)
    const empty = await geom(page)
    const emptyH = await page.evaluate(() => { const o = document.querySelector('.sc-caret'); return o && o.style.display !== 'none' ? Math.round(o.getBoundingClientRect().height) : null })
    const tag = `C3(h${lv}) 空标题`
    check(`${tag} 已变成 h${lv} 且露出井号`, (await page.evaluate((l) => !!document.querySelector(`.md-block .ProseMirror h${l} .heading-hash`), lv)), '')
    await page.keyboard.type('x', { delay: 25 })
    await settle(page)
    const truth = await page.evaluate((l) => {
      const h = document.querySelector(`.md-block .ProseMirror h${l}`)
      const t = Array.from(h.childNodes).find((n) => n.nodeType === 3)
      const r = document.createRange()
      r.setStart(t, 0)
      r.collapse(true)
      const b = r.getClientRects()[0]
      return { top: Math.round(b.top), left: Math.round(b.left), height: Math.round(b.height) }
    }, lv)
    check(
      `${tag}:覆盖层落在真值处(不是 separator 的基线)`,
      !!empty.overlay && Math.abs(empty.overlay.top - truth.top) <= 2 && Math.abs(empty.overlay.left - truth.left) <= 2,
      `空标题时 ${JSON.stringify(empty.overlay)},真值 ${JSON.stringify(truth)}`,
    )
    check(`${tag}:覆盖层高度 = 标题行内盒(不是 .ProseMirror 的字号)`, emptyH !== null && Math.abs(emptyH - truth.height) <= 2, `实画高 ${emptyH},真值高 ${truth.height}`)
    await page.close()
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
