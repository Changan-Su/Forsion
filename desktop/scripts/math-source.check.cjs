// 笔记里正在编辑的公式源码:观感契约 + `$$` 空格(真浏览器 + ?upage 生产编辑器,真按键)。
//   A. `$$|$$` 里按空格只插一个空格,不把闭合的 `$$` 切进新段(第三个 `$` 自动成对出来的就是这个形态);
//      反向护栏:行首只有 `$$` / `￥￥` 时空格照样出骨架。
//   B. 整段源码(含 `$`)每个 span 都带 .math-source:等宽、斜体、行内代码字号(0.88em)、不加字距;预览 / 渲染结果不受影响。
//   C. token 颜色只读 --math-src-*(浅 / 深);宿主选择器权重为 0,插件一条普通类选择器(哪怕样式表排在宿主之前)就能盖过。
//   D. 选区盖住公式时字体不跳;离开公式后钩子类全部收走。
// 用法:npm run check:mathsource(自起 vite;HARNESS_URL=… 指到自己起的端口)。可选 LATEX_PLUGIN_DIR=<插件目录> 再验真插件的括号色盖过宿主。
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
const exe = process.env.CHROMIUM_EXE || fs.readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()
  .flatMap((x) => ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']
    .map((a) => path.join(cache, x, 'chrome-mac-arm64', a))).find((x) => fs.existsSync(x))
let failed = 0, passed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`)
  if (ok) passed++; else failed++
}
const settle = (p, ms = 160) => p.waitForTimeout(ms)
const PM = '.unified-body .ProseMirror'

// 缺省值 = Obsidian 1.15 实测(base.css 的 --math-src-*);换配色时两处一起改。
const DEFAULTS = {
  light: { dollar: 'rgb(138, 92, 245)', command: 'rgb(233, 49, 71)', letter: 'rgb(0, 191, 188)', number: 'rgb(120, 82, 238)', bracket: 'rgb(92, 92, 92)' },
  dark: { dollar: 'rgb(166, 138, 249)', command: 'rgb(251, 70, 76)', letter: 'rgb(83, 223, 221)', number: 'rgb(168, 130, 255)', bracket: 'rgb(179, 179, 179)' },
}

async function open(browser, seed, { dark = false } = {}) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 700 } })
  p.on('pageerror', (e) => console.log('pageerror', e.message))
  await p.goto(`${URL}?upage&upane${dark ? '&udark' : ''}&useed=${encodeURIComponent(seed)}`)
  await p.waitForFunction(() => !!window.__upage?.probe.view?.())
  await settle(p, 300)
  return p
}
/** 光标放进第一个含 needle 的文本块:块内偏移 = needle 起点 + delta(toDelta 给了就是选区)。 */
const caret = (p, needle, delta, toDelta) => p.evaluate(([needle, delta, toDelta]) => {
  const v = window.__upage.probe.view()
  let at = null, to = null
  v.state.doc.descendants((n, pos) => {
    if (at != null || !n.isTextblock) return at == null
    const i = n.textBetween(0, n.content.size, '\n', '￼').indexOf(needle)
    if (i >= 0) { at = pos + 1 + i + delta; to = toDelta == null ? at : pos + 1 + i + toDelta }
    return false
  })
  const Sel = v.state.selection.constructor
  v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, at, to)))
  v.focus()
  return at
}, [needle, delta, toDelta ?? null])
const paragraphs = (p) => p.evaluate(() => {
  const out = []
  window.__upage.probe.view().state.doc.forEach((n) => out.push(n.textContent))
  return out
})
const caretOffset = (p) => p.evaluate(() => window.__upage.probe.view().state.selection.$head.parentOffset)

/** 公式所在段的逐字样式(跳过 KaTeX / 预览 / 渲染结果)。 */
const chars = (p, needle) => p.evaluate(([sel, needle]) => {
  const para = [...document.querySelectorAll(`${sel} p`)].find((x) => x.textContent.includes(needle))
  const out = []
  const tw = document.createTreeWalker(para, NodeFilter.SHOW_TEXT)
  let n
  while ((n = tw.nextNode())) {
    const el = n.parentElement
    if (el.closest('.katex, .math-preview, .math-rendered')) continue
    const cs = getComputedStyle(el)
    for (let i = 0; i < n.data.length; i++) {
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1)
      out.push({ ch: n.data[i], cls: el.className, color: cs.color, ff: cs.fontFamily, fst: cs.fontStyle, fs: parseFloat(cs.fontSize), ls: cs.letterSpacing, w: +r.getBoundingClientRect().width.toFixed(2) })
    }
  }
  return { paraFs: parseFloat(getComputedStyle(para).fontSize), out }
}, [PM, needle])
/** 变量的实际取值(经 canvas 归一成 rgb())。 */
const varColors = (p) => p.evaluate(() => {
  const root = getComputedStyle(document.documentElement)
  const c = document.createElement('canvas').getContext('2d')
  const norm = (v) => { c.fillStyle = '#000'; c.fillStyle = v; const h = c.fillStyle; if (!h.startsWith('#')) return h; const n = parseInt(h.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})` }
  return Object.fromEntries(['dollar', 'command', 'letter', 'number', 'bracket'].map((k) => [k, norm(root.getPropertyValue(`--math-src-${k}`).trim())]))
})

async function partSpace(browser) {
  // A1:打 `$$$` → `$$|$$`,真按空格
  let p = await open(browser, '前文。\n\n后文。\n')
  await caret(p, '前文。', 3)
  await p.keyboard.press('Enter')
  await p.keyboard.type('$$$', { delay: 40 })
  await settle(p)
  const shape = await paragraphs(p)
  check('A1 打三个 $ 得到 $$|$$', shape[1] === '$$$$' && await caretOffset(p) === 2, { shape, at: await caretOffset(p) })
  await p.keyboard.press('Space')
  await settle(p)
  const after = await paragraphs(p)
  check('A1 $$|$$ 里按空格只插一个空格、仍是一段', JSON.stringify(after) === JSON.stringify(['前文。', '$$ $$', '后文。']) && await caretOffset(p) === 3, { after, at: await caretOffset(p) })
  await p.close()
  // A2:现成的 `$$x$$`,光标紧跟开头 `$$`
  p = await open(browser, '前文。\n\n$$x$$\n\n后文。\n')
  await caret(p, '$$x$$', 2)
  await p.keyboard.press('Space')
  await settle(p)
  const a2 = await paragraphs(p)
  check('A2 $$|x$$ 里按空格只插空格', JSON.stringify(a2) === JSON.stringify(['前文。', '$$ x$$', '后文。']), a2)
  await p.close()
  // A3 / A4:反向护栏 —— 行首只有触发符时照样出骨架
  for (const [label, typed] of [['$$', null], ['￥￥', '￥￥']]) {
    p = await open(browser, typed ? '前文。\n\n后文。\n' : '前文。\n\n$$\n\n后文。\n')
    if (typed) { await caret(p, '前文。', 3); await p.keyboard.press('Enter'); await p.keyboard.type(typed, { delay: 40 }) }
    else await caret(p, '$$', 2)
    await settle(p)
    await p.keyboard.press('Space')
    await settle(p)
    const s = await paragraphs(p)
    check(`A3 行首只有 ${label} 时空格照样出公式骨架`, s[1] === '$$  $$' && await caretOffset(p) === 3 && s.length === 3, { s, at: await caretOffset(p) })
    await p.close()
  }
}

async function partLook(browser, dark) {
  const tag = dark ? 'dark' : 'light'
  const p = await open(browser, '前文。\n\n$$ t(\\{n_{j}\\}) $$\n\n行内 $x^2 + \\sqrt{y}$ 结束。\n', { dark })
  check(`B0 ${tag}: 编辑前没有钩子类`, await p.locator(`${PM} .math-source`).count() === 0)
  await caret(p, 'n_{j}', 3)
  await settle(p)
  const { paraFs, out } = await chars(p, '$$')
  const src = out.filter((c) => c.cls.split(' ').includes('math-source'))
  check(`B1 ${tag}: 整段源码(含 $$ 与空格)每个字都带 .math-source`, src.map((c) => c.ch).join('') === '$$ t(\\{n_{j}\\}) $$' && src.length === out.length, out.map((c) => [c.ch, c.cls]))
  check(`B2 ${tag}: 斜体、不加字距`, src.every((c) => c.fst === 'italic' && c.ls === 'normal'), src.map((c) => [c.fst, c.ls]))
  check(`B3 ${tag}: 字号 = 正文 × 0.88(行内代码同档)`, src.every((c) => Math.abs(c.fs - paraFs * 0.88) < 0.05), { paraFs, fs: [...new Set(src.map((c) => c.fs))] })
  const widths = [...new Set(src.filter((c) => c.ch !== ' ').map((c) => c.w))]
  check(`B4 ${tag}: 等宽 —— ( j t $ \\ 同宽`, widths.length > 0 && Math.max(...widths) - Math.min(...widths) < 0.06, { widths, ff: src[0]?.ff })
  const want = await varColors(p)
  check(`B5 ${tag}: 变量缺省值 = Obsidian 实测`, JSON.stringify(want) === JSON.stringify(DEFAULTS[tag]), want)
  const colorOf = (ch, nth = 0) => src.filter((c) => c.ch === ch)[nth]?.color
  const expect = [['$', 'dollar'], ['t', 'letter'], ['(', 'bracket'], ['\\', 'command'], ['_', 'command'], ['{', 'bracket', 1], ['j', 'letter'], [')', 'bracket']]
  const got = expect.map(([ch, k, nth]) => [ch, colorOf(ch, nth ?? 0), want[k]])
  check(`B6 ${tag}: 每类 token 读自己的变量`, got.every(([, a, b]) => a === b), got)
  const space = src.find((c) => c.ch === ' ')
  const text = await p.evaluate((sel) => getComputedStyle(document.querySelector(`${sel} p`)).color, PM)
  check(`B7 ${tag}: 空格 / 运算符保持正文色`, space?.color === text, { space: space?.color, text })
  const preview = await p.evaluate(() => { const el = document.querySelector('.math-preview .katex'); const cs = el && getComputedStyle(el); return cs && { ff: cs.fontFamily.split(',')[0], fst: cs.fontStyle } })
  check(`B8 ${tag}: 预览不被带成等宽斜体`, !!preview && preview.fst === 'normal' && !/mono/i.test(preview.ff), preview)
  check(`B9 ${tag}: 没在编辑的行内公式照常渲染、不带钩子类`, await p.locator(`${PM} p:has-text("结束") .math-rendered`).count() === 1 && await p.locator(`${PM} p:has-text("结束") .math-source`).count() === 0)

  // C:插件盖得过 —— 样式表故意插在 <head> 最前面(源码顺序在宿主之前),只靠一条普通类选择器
  const over = await p.evaluate((sel) => {
    const st = document.createElement('style')
    st.textContent = '.x-plugin-bracket { color: rgb(1, 2, 3); } .x-plugin-dollar { color: rgb(4, 5, 6); } .x-plugin-cmd { color: rgb(7, 8, 9); }'
    document.head.prepend(st)
    // 按字找宿主的 token span(不按新类名找:旧代码上同样能量出谁赢)
    const spans = [...document.querySelectorAll(`${sel} .math-source-token`)]
    const pick = (text) => spans.find((s) => s.textContent.startsWith(text))
    const b = pick('('), d = pick('$$'), c = pick('\\{')
    if (!b || !d || !c) { st.remove(); return ['missing', !!b, !!d, !!c] }
    b.classList.add('x-plugin-bracket'); d.classList.add('x-plugin-dollar'); c.classList.add('x-plugin-cmd')
    const r = [getComputedStyle(b).color, getComputedStyle(d).color, getComputedStyle(c).color]
    st.remove()
    return r
  }, PM)
  check(`C1 ${tag}: 插件的普通类选择器盖过宿主括号 / $ / 命令色`, JSON.stringify(over) === JSON.stringify(['rgb(1, 2, 3)', 'rgb(4, 5, 6)', 'rgb(7, 8, 9)']), over)

  // D:选区盖住公式字体不跳,离开后收干净
  const srcWidth = (c) => +c.out.reduce((a, x) => a + x.w, 0).toFixed(1)
  const before = srcWidth({ out })
  await caret(p, 't(\\{', 0, 12)
  await settle(p)
  const sel = await chars(p, '$$')
  check(`D1 ${tag}: 选区里的字仍是 .math-source,字号不变`, sel.out.every((c) => c.cls.includes('math-source') && Math.abs(c.fs - paraFs * 0.88) < 0.05), sel.out.map((c) => [c.ch, c.cls, c.fs]))
  const afterW = srcWidth(sel)
  check(`D2 ${tag}: 选区出现前后公式源码总宽不变`, Math.abs(afterW - before) < 0.5, { before, afterW })
  await caret(p, '前文。', 1)
  await settle(p)
  check(`D3 ${tag}: 离开公式后钩子类与 token 类全部收走`, await p.locator(`${PM} .math-source, ${PM} .math-source-token`).count() === 0)

  if (process.env.LATEX_PLUGIN_DIR) {
    const code = fs.readFileSync(path.join(process.env.LATEX_PLUGIN_DIR, 'main.js'), 'utf8')
    await p.evaluate((c) => window.__ep.loadPlugin(c, { id: 'latex-suite', name: 'LaTeX Suite' }), code)
    await p.waitForFunction(() => window.__upage.probe.view().state.plugins.some((x) => String(x.key).startsWith('LATEX_SUITE_KEYS')), null, { timeout: 15000 })
    await settle(p, 900)
    await caret(p, 'n_{j}', 3)
    await settle(p)
    const plug = await p.evaluate((sel) => [...document.querySelectorAll(`${sel} [class*="ls-bracket-"]`)].map((s) => ({ t: s.textContent, c: getComputedStyle(s).color, cls: s.className })), PM)
    check(`C2 ${tag}: 真插件的括号深度色盖过宿主括号色`, plug.length > 0 && plug.every((x) => x.c !== want.bracket), plug)
  }
  await p.close()
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, headless: true })
  try {
    await partSpace(browser)
    await partLook(browser, false)
    await partLook(browser, true)
  } finally {
    await browser.close()
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
