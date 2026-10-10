// 点进一篇长笔记的那一下,主线程忙多久、忙在哪(2026-10-10)。
// 起因:聚焦时六个插件各发一次只带 meta 的事务(公式 / 高亮注释 / 双链 / 标签 / 结构前缀 / 占位提示),
// 而每个装饰插件的 `decorations(state)` 是「每次状态更新都整篇重算」—— 一次事务 = 所有装饰插件各扫一遍全文,
// 六次事务就是六遍。1500 段的笔记上,点进去第一下约 250ms。
// 量法:真鼠标点一段字,记 mousedown → click 之间每次 dispatch 的耗时,拆成「各插件算装饰」与其余(状态 apply + PM 比对 / 改 DOM)。
// 钉的不是毫秒(机器快慢不一),是次数:聚焦这一下,每个装饰插件至多重算 FOCUS_BUILDS_MAX 遍
// (2026-10-10 起六份焦点态并成 editorFocus 一份:焦点一笔 + 落光标一笔)。
// 另钉显示切换没丢:聚焦后光标所在那一段露源码、别的段照常渲染,失焦全部收回;标题的井号、空块的占位提示同理。
// 用法:npm run check:focuscost(由 e2e-editor 自起 / 复用 Vite;worktree 里设 HARNESS_URL)。
//   FOCUS_COST_N=300,1500   段数档位(缺省 300,1500)
//   FOCUS_COST_JSON=<文件>   把完整时间线落成 JSON(改前改后对比用)
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const SIZES = (process.env.FOCUS_COST_N || '300,1500').split(',').map(Number).filter(Boolean)
/** 聚焦这一下,每个装饰插件至多重算几遍(焦点态翻转 1 遍 + 点击落光标 1 遍)。 */
const FOCUS_BUILDS_MAX = 2
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

const bigNote = (n) => `# 长笔记\n\n${Array.from({ length: n }, (_, i) => `第 ${i + 1} 段 **粗体** [[某页]] #标签 $x^2$ ==高亮==`).join('\n\n')}\n`

/** 装探针:给 view.dispatch / updateState 和每个插件的 decorations 计时。 */
const install = (page) => page.evaluate(() => {
  const view = window.__upage.probe.view()
  const fc = (window.__fc = { ev: [], tx: [], deco: {}, depth: 0 })
  for (const type of ['mousedown', 'focusin', 'mouseup', 'click', 'keydown', 'keyup']) {
    window.addEventListener(type, (e) => fc.ev.push({ type: type === 'keydown' || type === 'keyup' ? `${type}:${e.key}` : type, t: performance.now() }), true)
  }
  for (const p of view.state.plugins) {
    const orig = p.props && p.props.decorations
    if (typeof orig !== 'function') continue
    const name = String(p.key).replace(/\$\d*$/, '')
    p.props.decorations = function (state) {
      const t0 = performance.now()
      const out = orig.call(this, state)
      const d = (fc.deco[name] ||= { n: 0, ms: 0 })
      d.n++
      d.ms += performance.now() - t0
      return out
    }
  }
  const snap = () => Object.fromEntries(Object.entries(fc.deco).map(([k, v]) => [k, { ...v }]))
  const dispatch = view.dispatch
  view.dispatch = (tr) => {
    const before = snap()
    const t0 = performance.now()
    const depth = ++fc.depth
    try { dispatch(tr) } finally { fc.depth-- }
    const ms = performance.now() - t0
    const after = snap()
    let decoMs = 0
    let decoN = 0
    for (const k of Object.keys(after)) { decoMs += after[k].ms - (before[k]?.ms ?? 0); decoN += after[k].n - (before[k]?.n ?? 0) }
    fc.tx.push({ t: t0, ms, depth, meta: Object.keys(tr.meta || {}).map((k) => k.replace(/\$\d*$/, '')), doc: tr.docChanged, sel: tr.selectionSet, decoMs, decoN })
  }
})
const reset = (page) => page.evaluate(() => { const fc = window.__fc; fc.ev = []; fc.tx = []; for (const k of Object.keys(fc.deco)) fc.deco[k] = { n: 0, ms: 0 } })
const read = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ ev: window.__fc.ev, tx: window.__fc.tx, deco: window.__fc.deco })))
const r1 = (x) => Math.round(x * 10) / 10

/** 一段时间线压成一行人话:总耗时、事务数、算装饰占多少、哪个插件重算了几遍。 */
function summarize(tl, fromEv, toEv) {
  const a = tl.ev.find((e) => e.type === fromEv)
  const b = [...tl.ev].reverse().find((e) => e.type === toEv)
  const tx = tl.tx.filter((t) => t.depth === 1)
  const txMs = tx.reduce((s, t) => s + t.ms, 0)
  const decoMs = Object.values(tl.deco).reduce((s, d) => s + d.ms, 0)
  const builds = Object.fromEntries(Object.entries(tl.deco).filter(([, d]) => d.n).map(([k, d]) => [k, d.n]))
  const costly = Object.entries(tl.deco).filter(([, d]) => d.ms >= 1).sort((x, y) => y[1].ms - x[1].ms).map(([k, d]) => `${k} ${r1(d.ms)}ms/${d.n}`)
  return { span: a && b ? r1(b.t - a.t) : null, txN: tx.length, txMs: r1(txMs), decoMs: r1(decoMs), restMs: r1(txMs - decoMs), builds, costly, tx: tx.map((t) => ({ meta: t.meta.join('+') || (t.doc ? '(doc)' : t.sel ? '(sel)' : '(none)'), ms: r1(t.ms), decoMs: r1(t.decoMs) })) }
}

/** 第 i 段里各种实况装饰的个数:标签胶囊 / 双链 / 藏起来的公式源码 / 藏起来的高亮定界符 / 露出来的高亮定界符。 */
const shown = (page, i) => page.evaluate(({ PM, i }) => {
  const el = document.querySelectorAll(PM + ' > p')[i]
  const n = (sel) => el.querySelectorAll(sel).length
  return [n('.amx-tag-pill'), n('.wikilink'), n('.math-src-hidden'), n('.amx-obs-hidden'), n('.amx-obs-delim')].join(',')
}, { PM, i })
const RENDERED = '1,1,1,2,0'
const SOURCE = '0,0,0,2,0' // 标签 / 双链 / 公式按「行」露源码;高亮按「光标碰到它」才露定界符
const SOURCE_AT_HL = '0,0,0,0,2'
const textPoint = (page, sel, i) => page.evaluate(({ sel, i }) => {
  const el = document.querySelectorAll(sel)[i]
  const r = document.createRange()
  r.selectNodeContents(el.firstChild)
  const g = r.getClientRects()[0]
  return { x: g.left + 6, y: g.top + g.height / 2 }
}, { sel, i })
const blur = async (page) => { await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.waitForTimeout(150) }
const count = (page, sel) => page.evaluate((sel) => document.querySelectorAll(sel).length, sel)

/** 聚焦 / 失焦该有的显示切换(六个插件现在读同一份焦点态,少接一个就在这里红)。 */
async function displaySwitch(browser) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${URL}?upage&upane`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.evaluate((md) => window.__upage.switchFile('Small.md', md), bigNote(3))
  await page.waitForFunction(() => document.querySelectorAll('.unified-body .ProseMirror > p').length >= 3, null, { timeout: 120000 })
  await page.waitForTimeout(500)
  const HEAD = '.amx-struct-prefix[data-structural-prefix="heading"]'
  check('切换:没聚焦时每段都是渲染态,标题不露井号', (await shown(page, 1)) === RENDERED && (await count(page, HEAD)) === 0, `${await shown(page, 1)} / 井号 ${await count(page, HEAD)}`)
  let at = await textPoint(page, PM + ' > p', 1)
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(200)
  check('切换:点进第 2 段 → 这一段的标签 / 双链 / 公式露源码,别的段不变', (await shown(page, 1)) === SOURCE && (await shown(page, 2)) === RENDERED, `${await shown(page, 1)} / ${await shown(page, 2)}`)
  await page.keyboard.press('End')
  await page.waitForTimeout(150)
  check('切换:光标挪到段尾的 ==高亮== 上 → 定界符露出来', (await shown(page, 1)) === SOURCE_AT_HL, await shown(page, 1))
  at = await textPoint(page, PM + ' > h1', 0)
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(200)
  check('切换:点进标题 → 标题露出可编辑的井号,第 2 段收回渲染态', (await count(page, HEAD)) === 1 && (await shown(page, 1)) === RENDERED, `井号 ${await count(page, HEAD)} / ${await shown(page, 1)}`)
  await blur(page)
  check('切换:失焦 → 井号收回', (await count(page, HEAD)) === 0, `井号 ${await count(page, HEAD)}`)
  // 焦点回来但光标没动(切回窗口 / Tab 进来 / 程序置焦都是这种):没有落光标那笔事务可搭,全靠焦点那一笔
  await page.evaluate((PM) => document.querySelector(PM).focus(), PM)
  await page.waitForTimeout(150)
  check('切换:焦点回来(光标没动)→ 井号又露出来', (await count(page, HEAD)) === 1, `井号 ${await count(page, HEAD)}`)
  at = await textPoint(page, PM + ' > p', 1)
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(200)
  await blur(page)
  check('切换:第 2 段露着源码时失焦 → 全部收回渲染态', (await shown(page, 1)) === RENDERED, await shown(page, 1))
  await page.close()

  // 空块的占位提示(只在聚焦时出)在 v3 块编辑器上验:统一编辑器另有一份不看焦点的空块提示(blockLayer),分不出来。
  // 缺省台架页 = 一个空块。
  const v3 = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  v3.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await v3.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await v3.waitForSelector('.md-block .ProseMirror', { timeout: 120000 })
  await v3.waitForTimeout(400)
  const PH = '.md-block .ProseMirror .is-empty[data-placeholder]'
  await blur(v3) // 台架页可能一开就把焦点给了首块
  const before = await count(v3, PH)
  const box = await v3.evaluate(() => { const b = document.querySelector('.md-block .ProseMirror').getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 } })
  await v3.mouse.click(box.x, box.y)
  await v3.waitForTimeout(200)
  const focused = await count(v3, PH)
  await blur(v3)
  check('切换(v3):空块的占位提示只在聚焦时出', before === 0 && focused === 1 && (await count(v3, PH)) === 0, `聚焦前 ${before} / 聚焦 ${focused} / 失焦 ${await count(v3, PH)}`)
  await v3.close()
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const dump = {}
  try {
    await displaySwitch(browser)
    for (const n of SIZES) {
      const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
      page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
      await page.goto(`${URL}?upage&upane`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await page.waitForSelector(PM, { timeout: 120000 })
      // 换到一篇从没聚焦过的长笔记(种子走 URL 放不下这么长)
      await page.evaluate((md) => window.__upage.switchFile('Big.md', md), bigNote(n))
      await page.waitForFunction((n) => document.querySelectorAll('.unified-body .ProseMirror > p').length >= n, n, { timeout: 120000 })
      await page.waitForTimeout(800)
      await install(page)

      // ── 聚焦那一下:真鼠标点第 3 段的字上
      const at = await page.evaluate((PM) => {
        const el = document.querySelectorAll(PM + ' > p')[2]
        const r = document.createRange()
        r.selectNodeContents(el.firstChild)
        const g = r.getClientRects()[0]
        return { x: g.left + 6, y: g.top + g.height / 2, focused: document.activeElement?.closest?.('.ProseMirror') != null }
      }, PM)
      check(`${n} 段:点之前编辑器没有焦点(量的是「第一下」)`, !at.focused)
      await reset(page)
      await page.mouse.click(at.x, at.y)
      await page.waitForTimeout(300)
      const focus = summarize(await read(page), 'mousedown', 'click')

      // ── 已聚焦之后:挪一次光标、打一个字、按一次回车(顺带看每键开销)
      const step = async (key) => {
        await reset(page)
        await page.keyboard.press(key)
        await page.waitForTimeout(200)
        return summarize(await read(page), `keydown:${key}`, `keyup:${key}`)
      }
      const arrow = await step('ArrowRight')
      const type = await step('a')
      const enter = await step('Enter')
      dump[n] = { focus, arrow, type, enter }

      const line = (label, s) => console.log(`  ${String(n).padStart(5)} 段  ${label.padEnd(6)} ${String(s.span).padStart(7)}ms  事务 ${s.txN} 次 ${s.txMs}ms(算装饰 ${s.decoMs}ms + 其余 ${s.restMs}ms)`)
      line('聚焦', focus); line('→', arrow); line('打字', type); line('回车', enter)
      for (const t of focus.tx) console.log(`           · ${t.meta.padEnd(34)} ${String(t.ms).padStart(6)}ms(算装饰 ${t.decoMs}ms)`)
      const worst = Object.entries(focus.builds).sort((x, y) => y[1] - x[1])
      console.log(`           聚焦这一下算装饰花得多的(毫秒 / 遍数): ${focus.costly.join('  ') || '(都不到 1ms)'}`)
      console.log(`           回车那一下: ${enter.costly.join('  ') || '(都不到 1ms)'}`)
      const over = worst.filter(([, v]) => v > FOCUS_BUILDS_MAX)
      check(`${n} 段:聚焦这一下,每个装饰插件至多重算 ${FOCUS_BUILDS_MAX} 遍`, worst.length > 0 && over.length === 0, over.length ? `超的: ${over.map(([k, v]) => `${k}×${v}`).join(' ')}` : `${worst.length} 个插件`)
      await page.close()
    }
  } finally {
    await browser.close()
  }
  if (process.env.FOCUS_COST_JSON) fs.writeFileSync(process.env.FOCUS_COST_JSON, JSON.stringify(dump, null, 1))
  const bad = results.filter((x) => !x).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
