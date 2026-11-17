// 笔记里正在编辑的公式源码:观感契约 + `$$` 空格(真浏览器 + ?upage 生产编辑器,真按键)。
//   A. `$$|$$` 里按空格只插一个空格,不把闭合的 `$$` 切进新段(第三个 `$` 自动成对出来的就是这个形态);
//      表格单元格里 `$$` / ``` + 空格只插空格,不出骨架(单元格只放得下一段,出骨架会把表格劈成两张);
//      反向护栏:行首只有 `$$` / `￥￥` 时空格照样出骨架。
//   B. 整段源码(含 `$`)每个 span 都带 .math-source:等宽、斜体、行内代码字号(0.88em)、不加字距;预览 / 渲染结果不受影响。
//   C. token 颜色只读 --math-src-*(浅 / 深);宿主选择器权重为 0,插件一条普通类选择器(哪怕样式表排在宿主之前)就能盖过。
//   D. 选区盖住公式时字体不跳;离开公式后钩子类全部收走。
//   E. 行内公式编辑中的预览是浮在这一行上方的气泡(读浮层 token,▶ 标光标,放不下翻到下方,不推挤正文);块公式预览照旧在源码下方。
//   F. 选区整个落在一个公式两头的 `$` 之间(真按键 Shift+→ 选中占位):不弹格式浮条;选区跨出公式、连 `$` 选中整个公式照旧弹。
//   H. 没有 .am-app 祖先的宿主(插件 mountRecord({ body: true }) 的正文):浮层照样是浮层、有表面,源码照样等宽上色,不推挤卡片。
//   G. 同上的选区:预览照常(行内浮层 ▶ 标在选区末端 —— 同 LaTeX Suite;块公式在源码下方);选区跨出公式照旧不出预览。
// 用法:npm run check:mathsource(自起 vite;HARNESS_URL=… 指到自己起的端口)。可选 LATEX_PLUGIN_DIR=<插件目录> 再验真插件的
//      token 色叠在宿主上时插件赢。MATH_SHOTS=<目录> 顺手存一张无 .am-app 宿主的截图。只跑几部分:--only=space,look,float,select,bare。
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
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length).split(',').filter(Boolean)
const want = (part) => !ONLY.length || ONLY.includes(part)
const TOOLBAR = '[data-testid="inline-toolbar"]'

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
  // A4:光标后面的 `$$` 在行内代码里 —— 不算闭合,照旧出骨架(余文挪到下一段)
  p = await open(browser, '前文。\n\n$$ `$$`\n\n后文。\n')
  await caret(p, '$$', 2)
  await p.keyboard.press('Space')
  await settle(p)
  const a4 = await paragraphs(p)
  check('A4 后面的 $$ 在行内代码里时空格照样出骨架', a4[1] === '$$  $$' && a4.length === 4, a4)
  await p.close()
  // A5:余文原样搬进新段:粗体 / 行内代码 / 图片 / 硬换行逐个节点留着,不被压成纯文本
  p = await open(browser, '前文。\n\n$$**粗**`码`![图](a.png)\\\n续\n\n后文。\n')
  const inlineSig = (from) => p.evaluate(([from]) => {
    const v = window.__upage.probe.view()
    let blk = null
    v.state.doc.forEach((n) => { if (!blk && n.textContent.startsWith('$$')) blk = n })
    if (!blk) return null
    const out = []
    blk.content.cut(from).forEach((c) => out.push([c.type.name, c.isText ? c.text : '', c.marks.map((m) => m.type.name).sort().join('+')]))
    return out
  }, [from])
  const before5 = await inlineSig(2)
  await caret(p, '$$', 2)
  await p.keyboard.press('Space')
  await settle(p)
  const a5 = await p.evaluate(() => {
    const v = window.__upage.probe.view(), out = []
    v.state.doc.forEach((n) => { const c = []; n.content.forEach((x) => c.push([x.type.name, x.isText ? x.text : '', x.marks.map((m) => m.type.name).sort().join('+')])); out.push({ type: n.type.name, text: n.textContent, c }) })
    return out
  })
  const kinds5 = (before5 || []).map((x) => x[0])
  check('A5 出骨架时光标后的粗体 / 行内代码 / 图片 / 硬换行原样留在下一段',
    !!before5 && kinds5.some((k) => /image/i.test(k)) && kinds5.some((k) => /break/i.test(k)) && a5[1]?.text === '$$  $$'
      && JSON.stringify(a5[2]?.c) === JSON.stringify(before5), { before5, a5 })
  await p.close()
  // A6:行内代码里的 `$$`(光标在代码里,后面没有别的 `$$`)不当公式触发符
  p = await open(browser, '前文。\n\n`$$x` 尾。\n\n后文。\n')
  await caret(p, '$$x', 2)
  await p.keyboard.press('Space')
  await settle(p)
  const a6 = await paragraphs(p)
  check('A6 行内代码开头的 $$ 后按空格只插空格', JSON.stringify(a6) === JSON.stringify(['前文。', '$$ x 尾。', '后文。']), a6)
  await p.close()
  // A7–A10:表格单元格开头的 `$$` / ``` + 空格(光标后有字 / 没字):只插空格,还是同一张表
  for (const [fence, rest] of [['$$', 'foo'], ['```', 'foo'], ['$$', ''], ['```', '']]) {
    p = await open(browser, `| h1 | h2 |\n| --- | --- |\n| ${fence}${rest} | x |\n| r2 | y |\n`)
    await caret(p, `${fence}${rest}`, fence.length)
    await p.keyboard.press('Space')
    await settle(p)
    const t = await p.evaluate(() => {
      const d = window.__upage.probe.view().state.doc, tables = []
      d.descendants((n) => {
        if (n.type.name !== 'table') return true
        const rows = []; n.forEach((r) => { const c = []; r.forEach((x) => c.push(x.textContent)); rows.push(c) }); tables.push(rows)
        return false
      })
      return tables
    })
    const want = [[['h1', 'h2'], [`${fence} ${rest}`, 'x'], ['r2', 'y']]]
    check(`A${7 + ['$$foo', '```foo', '$$', '```'].indexOf(fence + rest)} 单元格里 ${fence}${rest ? '(后面有字)' : '(空格)'} + 空格只插空格、表格不拆`, JSON.stringify(t) === JSON.stringify(want), t)
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
    // 真插件叠在宿主上:插件 token 里每个字的实际颜色 = 只带插件类的探针在同一主题下的颜色(插件规则说了算)。
    const code = fs.readFileSync(path.join(process.env.LATEX_PLUGIN_DIR, 'main.js'), 'utf8')
    await p.evaluate((c) => window.__ep.loadPlugin(c, { id: 'latex-suite', name: 'LaTeX Suite' }), code)
    await settle(p, 900)
    await caret(p, 'n_{j}', 3)
    await p.waitForFunction((sel) => document.querySelectorAll(`${sel} .latex-suite-math-token`).length > 0, PM, { timeout: 15000 }).catch(() => {})
    await settle(p)
    const plug = await p.evaluate((sel) => {
      const host = document.querySelector(sel)
      const box = document.createElement('div'); box.className = 'ProseMirror'; box.style.cssText = 'position:absolute;left:-9999px'
      host.closest('.am-app').appendChild(box)
      const rows = []
      for (const t of host.querySelectorAll('.latex-suite-math-token')) {
        const own = [...t.classList].filter((c) => !c.startsWith('math-source'))
        const probe = document.createElement('span'); probe.className = own.join(' '); probe.textContent = 'x'
        box.appendChild(probe)
        const want = getComputedStyle(probe).color
        const tw = document.createTreeWalker(t, NodeFilter.SHOW_TEXT)
        for (let n = tw.nextNode(); n; n = tw.nextNode()) rows.push({ t: n.data, cls: n.parentElement.className, got: getComputedStyle(n.parentElement).color, want })
      }
      box.remove()
      return rows
    }, PM)
    const hostColored = plug.filter((r) => /math-source-(dollar|command|script|letter|number|bracket)/.test(r.cls))
    check(`C2 ${tag}: 真插件的 token 色叠在宿主 token 上时插件赢`, hostColored.length > 0 && plug.every((r) => r.got === r.want), plug)
  }
  await p.close()
}

async function partFloat(browser, dark) {
  const tag = dark ? 'dark' : 'light'
  const seed = '前一行写得长一点,好让气泡压在它上面也看得出来。\n\n行内 $x^2 + \\sqrt{y}$ 结束,后面还有字。\n\n$$ \\frac{a}{b} $$\n\n下一段。\n' + '\n填充一行。\n'.repeat(40)
  const p = await open(browser, seed, { dark })
  const paraBox = () => p.evaluate((sel) => { const el = [...document.querySelectorAll(`${sel} p`)].find((x) => x.textContent.includes('结束')); const r = el.getBoundingClientRect(); return { top: r.top, height: r.height } }, PM)
  await caret(p, '结束', 0)
  await settle(p)
  const restH = (await paraBox()).height
  await caret(p, 'sqrt{', 5)
  await settle(p)
  const g = await p.evaluate((sel) => {
    const f = document.querySelectorAll('.math-preview--float')
    const el = f[0]
    if (!el) return { count: 0 }
    const para = [...document.querySelectorAll(`${sel} p`)].find((x) => x.textContent.includes('结束'))
    const dollar = [...para.querySelectorAll('.math-source-dollar')][0].getBoundingClientRect()
    const r = el.getBoundingClientRect(), inner = el.querySelector('.math-preview-inner').getBoundingClientRect()
    const cs = getComputedStyle(el)
    const probe = document.createElement('div')
    probe.style.cssText = 'background: var(--surface-float, var(--bg-card)); border: 1px solid var(--surface-edge, var(--border)); position: absolute'
    para.appendChild(probe)
    const pc = getComputedStyle(probe)
    const want = { bg: pc.backgroundColor, edge: pc.borderTopColor }
    probe.remove()
    return {
      count: f.length, below: el.classList.contains('is-below'), bottom: r.bottom, top: r.top, left: r.left, innerLeft: inner.left,
      lineTop: dollar.top, lineBottom: dollar.bottom, dollarLeft: dollar.left, position: cs.position,
      bg: cs.backgroundColor, edge: cs.borderTopColor, shadow: cs.boxShadow, radius: cs.borderTopLeftRadius, want,
      annotation: el.querySelector('annotation')?.textContent ?? null,
    }
  }, PM)
  check(`E1 ${tag}: 光标在行内公式里,只出一个浮层预览`, g.count === 1, g)
  check(`E2 ${tag}: 浮层在这一行上方、不压源码`, !g.below && g.bottom <= g.lineTop + 0.5 && g.position === 'absolute', g)
  check(`E3 ${tag}: 浮层左缘对齐公式开头(预览字与 $ 对齐)`, Math.abs(g.innerLeft - g.dollarLeft) < 3, g)
  check(`E4 ${tag}: 不推挤正文 —— 出预览前后段落高度不变`, Math.abs((await paraBox()).height - restH) < 0.5, { restH, now: (await paraBox()).height })
  check(`E5 ${tag}: 表面读浮层 token(底、边),有阴影`, g.bg === g.want.bg && g.edge === g.want.edge && g.shadow !== 'none', g)
  check(`E6 ${tag}: ▶ 标在光标处(\\sqrt{ 与 y 之间)`, g.annotation === 'x^2 + \\sqrt{{\\blacktriangleright}y}', g.annotation)
  await caret(p, 'sqrt{', 3)
  await settle(p)
  const inCmd = await p.evaluate(() => document.querySelector('.math-preview--float annotation')?.textContent)
  check(`E7 ${tag}: 光标在命令名中间时 ▶ 挪到命令前,不拆坏命令`, inCmd === 'x^2 + {\\blacktriangleright}\\sqrt{y}', inCmd)
  await caret(p, '行内 $', 0, 5)
  await settle(p)
  check(`E8 ${tag}: 选区跨出公式时不出预览(现有规则)`, await p.locator('.math-preview--float').count() === 0)
  // 放不下就翻到下方:把公式那一行滚到可视区顶上
  await caret(p, 'sqrt{', 5)
  await p.evaluate((sel) => { const el = [...document.querySelectorAll(`${sel} p`)].find((x) => x.textContent.includes('结束')); el.scrollIntoView({ block: 'start' }) }, PM)
  await settle(p, 300)
  const flip = await p.evaluate((sel) => {
    const el = document.querySelector('.math-preview--float'); if (!el) return null
    const para = [...document.querySelectorAll(`${sel} p`)].find((x) => x.textContent.includes('结束'))
    const d = para.querySelector('.math-source-dollar').getBoundingClientRect(), r = el.getBoundingClientRect()
    return { below: el.classList.contains('is-below'), top: r.top, lineBottom: d.bottom }
  }, PM)
  check(`E9 ${tag}: 顶上放不下时翻到这一行下方`, !!flip && flip.below && flip.top >= flip.lineBottom - 0.5, flip)
  // 块公式的预览仍在源码下方
  await caret(p, '\\frac{a', 6)
  await settle(p)
  const blk = await p.evaluate((sel) => {
    const el = document.querySelector('.math-preview--block'); if (!el) return null
    const para = [...document.querySelectorAll(`${sel} p`)].find((x) => x.textContent.includes('\\frac'))
    return { float: document.querySelectorAll('.math-preview--float').length, top: el.getBoundingClientRect().top, srcBottom: para.querySelector('.math-source-dollar').getBoundingClientRect().bottom }
  }, PM)
  check(`E10 ${tag}: 块公式的预览照旧在源码下方、不是浮层`, !!blk && blk.float === 0 && blk.top >= blk.srcBottom, blk)
  await caret(p, '下一段', 1)
  await settle(p)
  check(`E11 ${tag}: 离开公式浮层收走`, await p.locator('.math-preview--float').count() === 0)
  await p.close()
}

/** H:没有 .am-app 祖先的宿主 —— 插件 ctx.ui.mountRecord({ body: true }) 的正文就是这样(同样的 DOM 形状:
 *  data-host-mount > .plugin-record > section.plugin-record-body > PlainMarkdownEditor)。 */
async function partBare(browser) {
  const p = await open(browser, '占位。\n')
  await p.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name)
    const React = (await import(urls.find((u) => /\/deps\/react\.js/.test(u)))).default
    const rdc = await import(urls.find((u) => /\/deps\/react-dom_client\.js/.test(u)))
    const createRoot = rdc.createRoot || rdc.default.createRoot
    const { PlainMarkdownEditor } = await import('/src/amadeus/blocks/markdown/MarkdownBlock.tsx')
    await import('/src/amadeus/plugins/recordSurface.css')
    const card = document.createElement('div')
    card.id = 'bare-card'
    card.style.cssText = 'position:fixed;left:40px;top:260px;width:420px;padding:8px;background:#fff;border:1px solid #888;z-index:9000'
    card.innerHTML = '<div data-host-mount style="display:contents"><div class="plugin-record"><div>字段行</div><section class="plugin-record-body"></section></div></div><div class="foot">卡片底部</div>'
    document.body.appendChild(card)
    createRoot(card.querySelector('section')).render(React.createElement(PlainMarkdownEditor, { initial: '备注 $x^2+y$ 尾巴', onChange: () => {}, immediate: true }))
  })
  await p.waitForSelector('#bare-card .math-rendered', { timeout: 15000 })
  await settle(p, 400)
  const cardH = () => p.evaluate(() => document.getElementById('bare-card').getBoundingClientRect().height)
  const before = await cardH()
  check('H0 卡片不在 .am-app 下(台架形状对)', await p.evaluate(() => !document.getElementById('bare-card').closest('.am-app')))
  const k = await p.locator('#bare-card .math-rendered').boundingBox()
  await p.mouse.click(k.x + k.width / 2, k.y + k.height / 2)
  await settle(p, 200)
  await p.keyboard.press('ArrowRight')
  await settle(p, 400)
  const g = await p.evaluate(() => {
    const card = document.getElementById('bare-card')
    const el = card.querySelector('.math-preview--float'), pm = card.querySelector('.ProseMirror')
    const dollar = card.querySelector('.math-source-dollar')
    if (!el || !dollar) return { float: !!el, dollar: !!dollar }
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), d = dollar.getBoundingClientRect(), ds = getComputedStyle(dollar)
    return { float: true, inContent: pm.contains(el), position: cs.position, bg: cs.backgroundColor, border: parseFloat(cs.borderTopWidth),
      top: r.top, bottom: r.bottom, lineTop: d.top, lineBottom: d.bottom, ff: ds.fontFamily, fst: ds.fontStyle, color: ds.color,
      text: getComputedStyle(card.querySelector('.ProseMirror p')).color }
  })
  check('H1 没有 .am-app 也是浮层:绝对定位、不进正文', g.float && g.position === 'absolute' && !g.inContent, g)
  check('H2 没有 .am-app 也有浮层表面(底色、描边)', g.float && g.bg !== 'rgba(0, 0, 0, 0)' && g.border >= 1, g)
  check('H3 浮层不压这一行源码', g.float && (g.bottom <= g.lineTop + 0.5 || g.top >= g.lineBottom - 0.5), g)
  const after = await cardH()
  check('H4 不推挤卡片:出预览前后卡片高度不变', Math.abs(after - before) < 0.5, { before, after })
  check('H5 没有 .am-app 源码照样等宽斜体、$ 上色', !!g.ff && /mono/i.test(g.ff) && g.fst === 'italic' && g.color !== g.text, g)
  if (process.env.MATH_SHOTS) { fs.mkdirSync(process.env.MATH_SHOTS, { recursive: true }); await p.screenshot({ path: path.join(process.env.MATH_SHOTS, 'bare-host.png'), clip: { x: 20, y: 200, width: 480, height: 200 } }) }
  await p.close()
}

async function partSelect(browser) {
  const p = await open(browser, '前一行。\n\n行内 $x^2 + \\sqrt{y}$ 结束。\n\n$$ \\sum_{i=1}^{N} $$\n\n下一段。\n')
  const bar = () => p.locator(TOOLBAR).count()
  const select = async (needle, at, n, key = 'Shift+ArrowRight') => {
    await caret(p, needle, at)
    await settle(p, 120)
    for (let i = 0; i < n; i++) await p.keyboard.press(key)
    await settle(p, 350)
    return p.evaluate(() => { const s = window.__upage.probe.view().state.selection; return s.$from.sameParent(s.$to) ? s.$from.parent.textBetween(s.$from.parentOffset, s.$to.parentOffset) : '<跨段>' })
  }
  // 正对照:普通正文的选区照常弹浮条(台架里浮条根本不出的话,下面的「不弹」就没意义)
  let got = await select('结束', 0, 2)
  check('F0 正文里选中两个字照常弹格式浮条', got === '结束' && await bar() === 1, { got, bar: await bar() })
  // F1 / G1:行内公式里选中 y
  got = await select('sqrt{y', 5, 1)
  const f1 = { got, bar: await bar(), float: await p.locator('.math-preview--float').count(),
    ann: await p.evaluate(() => document.querySelector('.math-preview--float annotation')?.textContent ?? null) }
  check('F1 行内公式源码里选中一个字不弹格式浮条', f1.got === 'y' && f1.bar === 0, f1)
  check('G1 同上:行内预览照常出,▶ 标在选区末端', f1.float === 1 && f1.ann === 'x^2 + \\sqrt{y{\\blacktriangleright}}', f1)
  // F2 / G2:块公式里选中 i
  got = await select('sum_{i', 5, 1)
  const f2 = { got, bar: await bar(), block: await p.locator('.math-preview--block').count(), float: await p.locator('.math-preview--float').count() }
  check('F2 块公式源码里选中一个字不弹格式浮条', f2.got === 'i' && f2.bar === 0, f2)
  check('G2 同上:块公式的预览照常在源码下方', f2.block === 1 && f2.float === 0, f2)
  // F3 / G3:选区从公式里往左跨到正文(一半在公式里)—— 现状不变
  got = await select('x^2', 1, 5, 'Shift+ArrowLeft')
  const f3 = { got, bar: await bar(), float: await p.locator('.math-preview--float').count(), block: await p.locator('.math-preview--block').count() }
  check('F3 选区一半在公式里、一半在正文照旧弹格式浮条', f3.got === '行内 $x' && f3.bar === 1, f3)
  check('G3 同上:跨出公式的选区照旧不出预览', f3.float === 0 && f3.block === 0, f3)
  // F5 / G5:连两头的 `$` 一起选中整个行内公式 = 对整个公式动手,现状不变
  await caret(p, '$x^2', 0, 16)
  await settle(p, 350)
  const f5 = { got: await p.evaluate(() => { const s = window.__upage.probe.view().state.selection; return s.$from.parent.textBetween(s.$from.parentOffset, s.$to.parentOffset) }),
    bar: await bar(), float: await p.locator('.math-preview--float').count() }
  check('F5 连 $ 一起选中整个公式照旧弹格式浮条', f5.got === '$x^2 + \\sqrt{y}$' && f5.bar === 1, f5)
  check('G5 同上:不出预览(现状)', f5.float === 0, f5)
  // F4:选区从公式里跨到公式外(块公式选到行尾之后的下一段)—— 照旧弹
  got = await select('sum_{i', 5, 20)
  const f4 = { got, bar: await bar(), block: await p.locator('.math-preview--block').count() }
  check('F4 选区从块公式里跨出到下一段照旧弹浮条、不出预览', f4.bar === 1 && f4.block === 0, f4)
  await p.close()
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, headless: true })
  try {
    if (want('space')) await partSpace(browser)
    if (want('look')) { await partLook(browser, false); await partLook(browser, true) }
    if (want('float')) { await partFloat(browser, false); await partFloat(browser, true) }
    if (want('select')) await partSelect(browser)
    if (want('bare')) await partBare(browser)
  } finally {
    await browser.close()
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
