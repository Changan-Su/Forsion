// 锚标记段(独占一段的 `<!-- a id -->`)在编辑器里不露原文 —— 真键盘 / 真鼠标回归(2026-11-18)。
//
// 背景:取消分栏、收回画布卡、多锚的栏都会留下这种「惰性锚」(columns.ts「锚永不回收」),落盘必须留着给
// `![[笔记#id]]` 定位;此前它们以原文露在页面上,而且锚标记可见时 main 上就有几条路会把它毁掉(探针:
// 段首退格 / 段尾 Delete 把正文和锚标记并成一行 `<!-- a id -->正文`)。现在 anchorMarks.ts 把它收起、keyboard.ts
// 的 bsOverAnchorMarks / deleteOverAnchorMarks 跨过它去并真正的上一块 / 下一块。
//
// 每格断言:页面可见文字里没有 `<!-- a`;落盘与期望逐字一致(锚标记一行不少);光标不在锚标记段里;pageerror = 0。
// D 组(拖块落到藏着锚标记的缝里)只报告不计分:落点在 blockLayer / dropTargets,那边另有在改的 PR。
//
// 用法:node scripts/e2e-editor.cjs --check=anchor-marks
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
const PM = '.unified-body .ProseMirror'
const J = (lines) => lines.join('\n\n') + '\n'
const FLAT_LINES = ['段甲。', '<!-- a m1 -->', '段乙。', '<!-- a m2 -->', '<!-- a m3 -->', '<!-- a m4 -->', '段丙。', '段丁。', '<!-- a mz -->']
const FLAT = J(FLAT_LINES)
const COLS_FM = '---\namadeus_schema: amadeus.page/4\namadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["a1"],"width":1},{"refs":["a2","a3"],"width":1}],"tail":"ta"}]}\n---\n'
const COLS_LINES = ['开头。', '<!-- a a1 -->', '左栏。', '<!-- a a2 -->', '右上。', '<!-- a a3 -->', '右下。', '<!-- a ta -->', '后文。']
const COLS = COLS_FM + J(COLS_LINES)

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, seed) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForTimeout(600)
  return { p, errs }
}
const pt = (p, text, where) => p.evaluate(([s, text, where]) => {
  const el = [...document.querySelectorAll(s + ' p')].find((e) => e.textContent === text)
  if (!el) return null
  const t = el.firstChild
  const r = document.createRange()
  const n = t.textContent.length
  if (where === 'start') { r.setStart(t, 0); r.setEnd(t, 1) } else { r.setStart(t, n - 1); r.setEnd(t, n) }
  const b = r.getBoundingClientRect()
  return { x: where === 'start' ? b.left + 1 : b.right - 1, y: b.top + b.height / 2, top: b.top, bottom: b.bottom }
}, [PM, text, where])
const clickAt = async (p, text, where) => {
  const a = await pt(p, text, where)
  await p.mouse.click(a.x + (where === 'end' ? 4 : 0), a.y)
  await p.keyboard.press(where === 'end' ? 'End' : 'Home')
}
const state = (p) => p.evaluate((s) => {
  const v = window.__upage.probe.view()
  const par = v.state.selection.$head.parent
  const w = window.__upage.writes
  return {
    md: w.length ? w[w.length - 1].text : null,
    writes: w.length,
    seen: document.querySelector(s).innerText,
    onMark: par.type.name === 'paragraph' && par.childCount === 1 && par.firstChild.type.name === 'html',
    caret: par.textContent,
  }
}, PM)
/** 等 gutter 锚到指针下这一块且位置稳住,返回 ⠿ 中心(同 columns-realdrag.check 的 anchoredGutter)。 */
async function anchoredHandle(p, x, y) {
  let prev = null
  for (let t = 0; t < 5000; t += 50) {
    const cur = await p.evaluate(([x, y]) => {
      const g = document.querySelector('.unified-gutter')
      if (!g || g.dataset.show !== 'true') return null
      const el = document.elementFromPoint(x, y)?.closest('.ProseMirror > *, .amx-ucolcell > *')
      if (!el || Math.abs(g.getBoundingClientRect().top - el.getBoundingClientRect().top) > 20) return null
      const b = g.querySelector('.drag-handle')
      if (!b || getComputedStyle(b).display === 'none') return null
      const r = b.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + Math.min(10, r.height / 2) }
    }, [x, y])
    if (cur && prev && JSON.stringify(cur) === JSON.stringify(prev)) return cur
    prev = cur
    await p.waitForTimeout(50)
  }
  return null
}
const body = (t) => (t || '').replace(/^---[\s\S]*?---\n/, '')
const noRaw = (s) => !/<!--\s*a\s/.test(s.seen)

async function kase(browser, name, seed, act, want) {
  const { p, errs } = await open(browser, seed)
  let err = null
  try { await act(p) } catch (e) { err = e.message.slice(0, 120) }
  await p.waitForTimeout(1300)
  const s = await state(p)
  const ok = !err && errs.length === 0 && noRaw(s) && !s.onMark && want(s)
  check(name, ok, JSON.stringify({ md: body(s.md), caret: s.caret, err, errs: errs.map((m) => m.slice(0, 90)) }))
  await p.close()
  return s
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // ── V:看不见 ──
  for (const [label, seed] of [['平铺', FLAT], ['分栏(栏里多锚)', COLS]]) {
    const { p, errs } = await open(browser, seed)
    const s = await state(p)
    const hidden = await p.evaluate((s) => document.querySelectorAll(s + ' .amx-anchor-mark').length, PM)
    check(`V1 ${label}:页面可见文字里没有锚注释原文`, noRaw(s) && errs.length === 0 && hidden > 0, JSON.stringify({ hidden, seen: s.seen.replace(/\n+/g, ' | ') }))
    await p.close()
  }

  // ── K:键盘 ──
  await kase(browser, 'K1 段首退格(前面隔一枚锚)→ 并进上一段,锚挪到合并结果前', FLAT,
    async (p) => { await clickAt(p, '段乙。', 'start'); await p.keyboard.press('Backspace') },
    (s) => s.md === J(['<!-- a m1 -->', '段甲。段乙。', ...FLAT_LINES.slice(3)]) && s.caret === '段甲。段乙。')
  await kase(browser, 'K2 段尾 Delete(后面隔一枚锚)→ 把下一段并上来,锚挪到本段前', FLAT,
    async (p) => { await clickAt(p, '段甲。', 'end'); await p.keyboard.press('Delete') },
    (s) => s.md === J(['<!-- a m1 -->', '段甲。段乙。', ...FLAT_LINES.slice(3)]) && s.caret === '段甲。段乙。')
  await kase(browser, 'K3 段首退格(前面隔三枚)→ 三枚一起挪', FLAT,
    async (p) => { await clickAt(p, '段丙。', 'start'); await p.keyboard.press('Backspace') },
    (s) => s.md === J(['段甲。', '<!-- a m1 -->', '<!-- a m2 -->', '<!-- a m3 -->', '<!-- a m4 -->', '段乙。段丙。', '段丁。', '<!-- a mz -->']))
  await kase(browser, 'K4 文末只剩锚:段尾 Delete 不动、不写盘', FLAT,
    async (p) => { await clickAt(p, '段丁。', 'end'); await p.keyboard.press('Delete') },
    (s) => s.writes === 0)
  for (const [n, key, from, where, wantMd] of [
    ['K5', 'ArrowDown', '段甲。', 'end', J(['段甲。', '<!-- a m1 -->', '段乙。X', ...FLAT_LINES.slice(3)])],
    ['K6', 'ArrowRight', '段甲。', 'end', J(['段甲。', '<!-- a m1 -->', 'X段乙。', ...FLAT_LINES.slice(3)])],
    ['K7', 'ArrowLeft', '段乙。', 'start', J(['段甲。X', ...FLAT_LINES.slice(1)])],
    ['K8', 'ArrowUp', '段丙。', 'start', J(['段甲。', '<!-- a m1 -->', 'X段乙。', ...FLAT_LINES.slice(3)])],
  ]) {
    await kase(browser, `${n} ${key} 跨过锚再打字:字进看得见的段,锚原样`, FLAT,
      async (p) => { await clickAt(p, from, where); await p.keyboard.press(key); await p.keyboard.type('X') },
      (s) => s.md === wantMd)
  }
  await kase(browser, 'K9 段尾回车打字:新段落在锚前面,锚仍指着段乙', FLAT,
    async (p) => { await clickAt(p, '段甲。', 'end'); await p.keyboard.press('Enter'); await p.keyboard.type('X') },
    (s) => s.md === J(['段甲。', 'X', ...FLAT_LINES.slice(1)]))
  await kase(browser, 'K10 点文末空白打字:字接在段丁后,文末的锚原样', FLAT,
    async (p) => { const r = await p.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left + 60, y: b.bottom - 4 } }, PM); await p.mouse.click(r.x, r.y); await p.keyboard.type('X') },
    (s) => s.md === J([...FLAT_LINES.slice(0, 7), '段丁。X', '<!-- a mz -->']))
  await kase(browser, 'K11 段首粘贴两段:锚原样', FLAT,
    async (p) => {
      await clickAt(p, '段乙。', 'start')
      await p.evaluate((s) => { const dt = new DataTransfer(); dt.setData('text/plain', 'P1\n\nP2'); document.querySelector(s).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) }, PM)
    },
    (s) => /<!-- a m1 -->\n\nP1\n\nP2段乙。/.test(s.md || ''))
  await kase(browser, 'K12 K1 落盘之后 Cmd+Z:一下撤回,落盘回到原样', FLAT,
    async (p) => { await clickAt(p, '段乙。', 'start'); await p.keyboard.press('Backspace'); await p.waitForTimeout(1500); await p.keyboard.press('Meta+z') },
    (s) => s.writes >= 2 && s.md === FLAT)

  // ── C:栏里 ──
  await kase(browser, 'C1 栏里段首退格(前面是栏内锚 a3)→ 栏内合并,锚挪到合并结果前', COLS,
    async (p) => { await clickAt(p, '右下。', 'start'); await p.keyboard.press('Backspace') },
    (s) => body(s.md) === J(['开头。', '<!-- a a1 -->', '左栏。', '<!-- a a2 -->', '<!-- a a3 -->', '右上。右下。', '<!-- a ta -->', '后文。']) && /"refs":\["a2","a3"\]/.test(s.md || ''))
  await kase(browser, 'C2 栏里段尾 Delete', COLS,
    async (p) => { await clickAt(p, '右上。', 'end'); await p.keyboard.press('Delete') },
    (s) => body(s.md) === J(['开头。', '<!-- a a1 -->', '左栏。', '<!-- a a2 -->', '<!-- a a3 -->', '右上。右下。', '<!-- a ta -->', '后文。']))
  await kase(browser, 'C3 栏里 ↓ 跨过锚打字', COLS,
    async (p) => { await clickAt(p, '右上。', 'end'); await p.keyboard.press('ArrowDown'); await p.keyboard.type('X') },
    (s) => body(s.md) === J(['开头。', '<!-- a a1 -->', '左栏。', '<!-- a a2 -->', '右上。', '<!-- a a3 -->', '右下。X', '<!-- a ta -->', '后文。']))

  // ── R:重开 / 阅读模式 ──
  {
    const { p, errs } = await open(browser, FLAT)
    await clickAt(p, '段丁。', 'end')
    await p.keyboard.type('X')
    await p.waitForTimeout(1300)
    const s1 = await state(p)
    await p.evaluate((md) => window.__upage.switchFile('Other.md', md), s1.md)
    await p.waitForTimeout(900)
    const s2 = await state(p)
    check('R1 存盘再打开:锚一行不少、仍看不见', s1.md === J([...FLAT_LINES.slice(0, 7), '段丁。X', '<!-- a mz -->']) && noRaw(s2) && errs.length === 0, JSON.stringify({ md: s1.md, seen: s2.seen.replace(/\n+/g, ' | ') }))
    const btn = await p.$('button:has-text("阅读")')
    if (btn) {
      await btn.click()
      await p.waitForTimeout(900)
      const seen = await p.evaluate(() => document.querySelector('.amx-pane, .unified-body, body').innerText)
      check('R2 阅读模式:看不见锚注释原文', !/<!--\s*a\s/.test(seen) && seen.includes('段丁。X'), seen.replace(/\n+/g, ' | ').slice(0, 160))
    } else check('R2 阅读模式:看不见锚注释原文', false, '找不到「阅读」按钮')
    await p.close()
  }

  // ── D:拖块落到藏着锚的缝里(只报告)──
  {
    const { p } = await open(browser, FLAT)
    const src = await pt(p, '段丁。', 'start')
    await p.mouse.move(src.x + 30, src.y, { steps: 4 })
    const h = await anchoredHandle(p, src.x + 30, src.y)
    const a = await pt(p, '段乙。', 'end'), c = await pt(p, '段丙。', 'start')
    if (h) {
      const to = { x: c.x + 40, y: (a.bottom + c.top) / 2 }
      await p.mouse.move(h.x, h.y, { steps: 6 })
      await p.waitForTimeout(150)
      await p.mouse.down()
      await p.mouse.move(h.x + 5, h.y + 5, { steps: 2 })
      await p.mouse.move(to.x, to.y, { steps: 10 })
      for (let t = 0; t < 240; t += 15) { await p.mouse.move(to.x, to.y); await p.waitForTimeout(15) }
      await p.mouse.up()
      await p.waitForTimeout(1300)
    }
    const s = await state(p)
    console.log(`INFO  D1 拖段丁落到段乙、段丙之间(那里藏着 m2-m4):${h ? JSON.stringify(body(s.md)) : '没抓到把手'}`)
    await p.close()
  }

  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
