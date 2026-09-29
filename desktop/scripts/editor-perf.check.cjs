// 编辑器按键性能护栏(评审 2026-09-27 P-03 / P-04 / P-05)。用法:npm run check:editorperf
// (= node scripts/e2e-editor.cjs --check=editor-perf;worktree 里设 HARNESS_URL)。
//
// 判据尽量用**计数 / 身份**,不用墙钟 —— 机器负载一高,毫秒阈值就乱红。墙钟只作报告,或留 ≥10 倍余量。
//
//  P5 大文档(~760KB)改一个字后,落盘序列化(与 200ms 监听同一条链)耗时 < 60ms。
//     评审时 189–280ms;D-18(e97df2d6)让没动过的顶层块逐字回填后降到个位数 ms。
//     负对照:verbatim.ts 的 planVerbatim 恒回 null → 回到整篇 remark,这一格变红。
//  P4 公式 / 双链 / 行内图片:在文首打字,下游 widget 一个都不重建(每键移除的渲染节点 = 0);
//     widget 里取位置的地方(点公式进源码、data-src-from、点图片选中源码)仍指向打字之后的新位置。
//  P3 代码块高亮:纯选区事务复用同一份 DecorationSet(身份不变,不重跑 lowlight);块外打字 lowlight 零次、
//     块内打字只重算那一块(计数);在块内 / 块外 / 删行 / 改语言 / 删块 / 插块之后,高亮与重开同一份 md 逐 span 一致。
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
const ONLY = (process.env.EDITORPERF_ONLY || '').split(',').filter(Boolean) // 调试用:只跑 P3 / P4 / P5 里的几段
const want = (k) => !ONLY.length || ONLY.includes(k)
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 大文档经 switchFile 灌进来(useed 走 URL,几百 KB 会撑爆地址)。 */
async function openDoc(browser, md, file = 'Doc.md') {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  // 资源计时缓冲默认 250 条,dev 下几百个模块早溢出 —— P3 靠它找「应用实际加载的那个」codeBlock.ts。
  await p.addInitScript(() => performance.setResourceTimingBufferSize(10000))
  await p.goto(`${URL}?upage&useed=${encodeURIComponent('# s\n\nx\n')}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await switchTo(p, md, file)
  return p
}
async function switchTo(p, md, file) {
  await p.evaluate(async ({ md, file }) => {
    window.__upage.switchFile(file, md)
    const want = md.split('\n\n').length * 0.5
    await new Promise((res) => {
      const t0 = performance.now()
      const tick = () => {
        const pm = document.querySelector('.unified-body .ProseMirror')
        if ((pm && pm.childElementCount >= want) || performance.now() - t0 > 30000) return setTimeout(res, 400)
        requestAnimationFrame(tick)
      }
      tick()
    })
  }, { md, file })
}

/** 光标放到首个文本为 text 的文本块末尾并聚焦(直驱 PM,不靠坐标)。 */
const caretEndOf = (p, text) => p.evaluate((text) => {
  const v = window.__upage.probe.view()
  let at = -1
  v.state.doc.descendants((n, pos) => { if (at < 0 && n.isTextblock && n.textContent === text) at = pos + n.nodeSize - 1; return at < 0 })
  const TS = v.state.selection.constructor
  v.focus()
  v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, at)).scrollIntoView())
  return at
}, text)

function perfDoc(kind) {
  const out = ['# 技术笔记', '开头段落。']
  for (let s = 0; s < 40; s++) {
    out.push(`## 小节 ${s}`)
    for (let q = 0; q < 5; q++) {
      let t = `第 ${s}-${q} 段正文,普通长度的一句话,带一点英文 words here.`
      if (kind === 'math' && q % 2 === 0) t += ` 公式 $E_{${s}} = mc^2 + \\sum_{i=0}^{n} x_i$ 。`
      if (kind === 'wiki' && q % 2 === 0) t += ` 参见 [[笔记${s}]] 和 [[Embedded]]。`
      if (kind === 'img' && q === 0) t += ` 行内图 ![[shot${s}.png]] 在这里。`
      out.push(t)
    }
    if (kind === 'code' && s % 4 === 0) {
      const lines = []
      for (let i = 0; i < 40; i++) lines.push(`const v${i} = compute(${i}, "text", { a: ${i} }) // note`)
      out.push('```ts\n' + lines.join('\n') + '\n```')
    }
  }
  return out.join('\n\n') + '\n'
}

function bigDoc(sections) {
  const out = []
  for (let s = 0; s < sections; s++) {
    out.push(`## 第 ${s} 节标题`)
    for (let q = 0; q < 10; q++) out.push(`第 ${s}-${q} 段:这里是一段比较有代表性的正文内容,用于测大文档的打字延迟与装饰重算成本。Lorem ipsum dolor sit amet.`)
    if (s % 3 === 0) out.push(`- 列表 ${s} 项一\n- 列表 ${s} 项二\n  - 子项 A\n  - 子项 B\n- 列表 ${s} 项三`)
  }
  return out.join('\n\n') + '\n'
}

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] }

async function p5(browser) {
  const md = bigDoc(1000)
  const p = await openDoc(browser, md, 'Big.md')
  await caretEndOf(p, '第 500-5 段:这里是一段比较有代表性的正文内容,用于测大文档的打字延迟与装饰重算成本。Lorem ipsum dolor sit amet.')
  await p.keyboard.type('a')
  await p.waitForTimeout(300)
  const r = await p.evaluate(() => {
    const ms = []
    let out = null
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      out = window.__upage.probe.serializeNow()
      ms.push(performance.now() - t)
    }
    return { ms, len: out?.length ?? -1, typed: !!out && out.includes('sit amet.a') }
  })
  await p.close()
  const med = median(r.ms)
  record(`P5 ~${Math.round(md.length / 1024)}KB 改一字后落盘序列化 < 60ms(评审时 189–280ms)`, r.typed && med < 60,
    `median=${med.toFixed(1)}ms all=${r.ms.map((x) => x.toFixed(1)).join('/')} len=${r.len} typed=${r.typed}`)
}

async function p4(browser) {
  const CLS = { math: 'math-rendered', wiki: 'wikilink', img: 'wiki-inline-img-wrap' }
  for (const kind of ['math', 'wiki', 'img']) {
    const p = await openDoc(browser, perfDoc(kind))
    const n0 = await p.evaluate((c) => document.querySelectorAll(`.unified-body .ProseMirror .${c}`).length, CLS[kind])
    await caretEndOf(p, '开头段落。')
    await p.waitForTimeout(200)
    await p.evaluate((cls) => {
      window.__rm = 0
      window.__disp = []
      const v = window.__upage.probe.view()
      const orig = v.dispatch.bind(v)
      v.dispatch = (tr) => { const t = performance.now(); orig(tr); if (tr.docChanged) window.__disp.push(performance.now() - t) }
      window.__mo = new MutationObserver((recs) => { for (const r of recs) for (const n of r.removedNodes) if (n.nodeType === 1 && n.classList.contains(cls)) window.__rm++ })
      window.__mo.observe(document.querySelector('.unified-body .ProseMirror'), { childList: true, subtree: true })
    }, CLS[kind])
    for (const ch of 'abcdefghij') { await p.keyboard.type(ch); await p.waitForTimeout(40) }
    await p.waitForTimeout(150)
    const r = await p.evaluate(() => { window.__mo.disconnect(); const d = [...window.__disp].sort((a, b) => a - b); return { rm: window.__rm, keys: d.length, p50: d[Math.floor(d.length / 2)] } })
    // 位置读活值:widget 复用后,它身上的位置必须跟着文档走(key 去掉 pos 的代价就在这儿)。
    let live = null
    if (kind === 'math') {
      live = await p.evaluate(async () => {
        const all = document.querySelectorAll('.unified-body .ProseMirror .math-rendered')
        const el = all[all.length - 1]
        el.scrollIntoView({ block: 'center' })
        await new Promise((r) => setTimeout(r, 150))
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
        await new Promise((r) => setTimeout(r, 150))
        const v = window.__upage.probe.view()
        const h = v.state.selection.head
        return { before: v.state.doc.textBetween(h - 1, h), after: v.state.doc.textBetween(h, Math.min(h + 6, v.state.doc.content.size)) }
      })
    } else {
      live = await p.evaluate(({ cls, img }) => {
        const v = window.__upage.probe.view()
        const bad = []
        for (const el of document.querySelectorAll(`.unified-body .ProseMirror .${cls}`)) {
          const f = Number(el.dataset.srcFrom), t = Number(el.dataset.srcTo)
          const src = v.state.doc.textBetween(f, t)
          if (!(img ? /^!\[\[[^\]]+\]\]$/.test(src) : /^\[\[[^\]]+\]\]$/.test(src))) bad.push(src.slice(0, 20))
        }
        return { bad: bad.length, sample: bad.slice(0, 2) }
      }, { cls: CLS[kind], img: kind === 'img' })
      if (kind === 'img') {
        const pick = await p.evaluate(async () => {
          const all = document.querySelectorAll('.unified-body .ProseMirror .wiki-inline-img-wrap')
          const el = all[all.length - 1]
          el.scrollIntoView({ block: 'center' })
          await new Promise((r) => setTimeout(r, 150))
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
          await new Promise((r) => setTimeout(r, 150))
          const v = window.__upage.probe.view()
          const { from, to } = v.state.selection
          return v.state.doc.textBetween(from, to)
        })
        live.picked = pick
      }
    }
    await p.close()
    const posOk = kind === 'math'
      ? live.before === '$' && live.after.startsWith('E_{')
      : live.bad === 0 && (kind !== 'img' || live.picked === '![[shot39.png]]')
    record(`P4 ${kind}×${n0}:文首打 10 字,下游渲染节点零重建,位置读活值`, n0 > 0 && r.rm === 0 && posOk,
      `removed=${r.rm}(${(r.rm / 10).toFixed(1)}/键) dispatch p50=${r.p50?.toFixed(1)}ms live=${JSON.stringify(live)}`)
  }
}

/** 每个代码块的高亮签名:逐 span 的 class + 文字(与重新打开同一份 md 比)。 */
const codeSig = (p) => p.evaluate(() => [...document.querySelectorAll('.unified-body .ProseMirror pre')].map((pre) => {
  const code = pre.querySelector('code')
  return (pre.getAttribute('data-language') ?? '') + '|' + [...code.querySelectorAll('[class*="hljs-"]')].map((s) => `${s.className}:${s.textContent}`).join(',')
}))

async function p3(browser) {
  const md = perfDoc('code')
  const p = await openDoc(browser, md)
  await caretEndOf(p, '开头段落。')
  await p.waitForTimeout(200)
  await p.evaluate(() => {
    const v = window.__upage.probe.view()
    window.__cb = { sets: [], ms: 0, calls: 0 }
    for (const pl of v.state.plugins) {
      if (!/^amx-code-block/.test(pl.key) || !pl.props.decorations) continue
      const orig = pl.props.decorations
      pl.props.decorations = function (s) { const t = performance.now(); const r = orig.call(this, s); window.__cb.ms += performance.now() - t; window.__cb.calls++; window.__cb.sets.push(r); return r }
    }
  })
  // 纯选区:10 次方向键
  for (let i = 0; i < 10; i++) { await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(30) }
  const sel = await p.evaluate(() => { const c = window.__cb; const r = { calls: c.calls, uniq: new Set(c.sets).size, ms: c.ms }; window.__cb = { sets: [], ms: 0, calls: 0 }; return r })
  record('P3a 纯选区事务复用同一份代码块 DecorationSet(10 次方向键,身份不变)', sel.calls >= 10 && sel.uniq === 1,
    `calls=${sel.calls} uniqueSets=${sel.uniq} decoMs=${sel.ms.toFixed(1)}`)
  // 文首打字 / 块内打字:lowlight 实际跑了几次(计数,不看墙钟;codeBlock.ts 的 codeHighlightRuns,
  // 与编辑器同一个模块实例)。dispatch 耗时只报告。
  // ⚠️ 必须 import **应用实际加载的那个 URL**:vite 给热更过的模块带 `?t=`,裸路径会拿到另一个模块实例(计数恒 0)。
  const runs = () => p.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/amadeus\/blocks\/markdown\/codeBlock\.ts(\?|$)/.test(n))
    if (!url) return NaN
    const m = await import(url)
    return typeof m.codeHighlightRuns === 'function' ? m.codeHighlightRuns() : NaN
  })
  const typeTen = async () => {
    await p.evaluate(() => {
      window.__disp = []
      const v = window.__upage.probe.view()
      if (!v.__wrapped) { const orig = v.dispatch.bind(v); v.dispatch = (tr) => { const t = performance.now(); orig(tr); if (tr.docChanged) window.__disp.push(performance.now() - t) }; v.__wrapped = true }
    })
    for (const ch of 'abcdefghij') { await p.keyboard.type(ch); await p.waitForTimeout(30) }
    return p.evaluate(() => { const d = [...window.__disp].sort((a, b) => a - b); return d[Math.floor(d.length / 2)] })
  }
  await caretEndOf(p, '开头段落。')
  const r0 = await runs()
  const outP50 = await typeTen()
  const r1 = await runs()
  await p.evaluate(() => { // 光标放进第 1 个代码块首行末尾
    const v = window.__upage.probe.view()
    let at = -1
    v.state.doc.descendants((n, pos) => { if (at < 0 && n.type.name === 'code_block') at = pos + 1 + n.textContent.indexOf('\n'); return at < 0 })
    v.focus()
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
  })
  const inP50 = await typeTen()
  const r2 = await runs()
  record('P3b 块外打 10 字 lowlight 零次;块内打 10 字只重算那一块(= 10 次;评审时每键全部 10 块)',
    r1 - r0 === 0 && r2 - r1 === 10,
    `outside=${r1 - r0}次 inside=${r2 - r1}次 dispatch p50 块外=${outP50?.toFixed(1)}ms 块内=${inP50?.toFixed(1)}ms`)
  await p.evaluate(() => { window.__cb = { sets: [], ms: 0, calls: 0 } })
  // 正确性:块内打字 / 删行 / 改语言 / 新插一块 / 视图态开关 之后,与重开同一份 md 逐 span 一致
  const ops = await p.evaluate(() => {
    const v = window.__upage.probe.view()
    const TS = v.state.selection.constructor
    const blocks = () => { const out = []; v.state.doc.descendants((n, pos) => { if (n.type.name === 'code_block') out.push({ pos, n }); return true }); return out }
    // 1 块内:第 2 块第 3 行行首插一行关键字
    let b = blocks()[1]
    let lineStart = b.pos + 1 + b.n.textContent.split('\n').slice(0, 2).join('\n').length + 1
    v.dispatch(v.state.tr.insertText('let added = await fetch("x")\n', lineStart))
    // 2 删行:第 3 块删掉第 1 行
    b = blocks()[2]
    const first = b.n.textContent.indexOf('\n')
    v.dispatch(v.state.tr.delete(b.pos + 1, b.pos + 1 + first + 1))
    // 3 改语言:第 4 块 ts → python
    b = blocks()[3]
    v.dispatch(v.state.tr.setNodeMarkup(b.pos, undefined, { ...b.n.attrs, language: 'python' }))
    // 4 跨块边界:第 5 块整块删掉,再在文首插一块 js
    b = blocks()[4]
    v.dispatch(v.state.tr.delete(b.pos, b.pos + b.n.nodeSize))
    const cb = v.state.schema.nodes.code_block
    v.dispatch(v.state.tr.insert(v.state.doc.child(0).nodeSize, cb.create({ language: 'javascript' }, v.state.schema.text('function f(a) { return a + 1 }'))))
    // 5 转成段落(setBlockType):逐 token 的装饰会跟着文字映射进段落,必须清掉
    b = blocks()[5]
    v.dispatch(v.state.tr.setBlockType(b.pos + 1, b.pos + 1, v.state.schema.nodes.paragraph))
    // 6 块内逐字打字(每字一笔,走映射路径)
    b = blocks()[0]
    let at = b.pos + 1 + b.n.textContent.length
    for (const ch of '\nif (x) { return null }') { v.dispatch(v.state.tr.insertText(ch, at)); at++ }
    v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, 1)))
    return blocks().length
  })
  // ⚠️ 残留高亮要在按视图态开关**之前**量:开关走全量重建,会把残留顺手抹掉(测不到增量路径)。
  const strayA = await p.evaluate(() => [...document.querySelectorAll('.unified-body .ProseMirror [class*="hljs-"]')].filter((e) => !e.closest('pre')).length)
  // 视图态开关:折行第 2 块,再在块外打字 —— 类名不能丢
  await p.evaluate(() => { const btn = [...document.querySelectorAll('.unified-body .ProseMirror pre')][1].querySelector('.amx-code-btn:nth-of-type(2)'); btn?.click() })
  await caretEndOf(p, '开头段落。abcdefghij')
  await p.keyboard.type('Z')
  await p.waitForTimeout(200)
  const wrapKept = await p.evaluate(() => [...document.querySelectorAll('.unified-body .ProseMirror pre')][1].classList.contains('amx-code-wrap'))
  const sigA = await codeSig(p)
  const now = await p.evaluate(() => window.__upage.probe.serializeNow())
  await switchTo(p, now, 'Doc2.md')
  const sigB = await codeSig(p)
  await p.close()
  const diff = sigA.findIndex((s, i) => s !== sigB[i])
  record('P3c 块内打字 / 删行 / 改语言 / 删块 / 插块 / 转段落之后,高亮与重开同一份 md 逐 span 一致;段落里不残留高亮;折行态不丢',
    ops === sigA.length && sigA.length === sigB.length && diff === -1 && strayA === 0 && wrapKept,
    `blocks=${sigA.length}/${sigB.length} firstDiff=${diff}${diff >= 0 ? ` A=${sigA[diff].slice(0, 120)} B=${sigB[diff]?.slice(0, 120)}` : ''} stray=${strayA} wrapKept=${wrapKept}`)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    if (want('P5')) await p5(browser)
    if (want('P4')) await p4(browser)
    if (want('P3')) await p3(browser)
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
