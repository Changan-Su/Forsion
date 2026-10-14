// 文件引用嵌入 `![[…]]` 的光标逻辑 = Obsidian(2026-10-13 用户定:「除了图片,其他文件引用的光标逻辑都应该和 obsidian 一样」)。
//
//  光标走到嵌入那一行 → `![[…]]` 源码露在嵌入体**上方**、嵌入体照常渲染(同一个 DOM,不重挂);光标离开 → 源码收起。
//  实现:embedLayer 的 soft 类别(嵌入体挂段尾、revealPos)+ keyboard.ts 的 arrowEmbedSource。
//  图片(行内双链层)和「难源码」类别(书签卡等)不变。
//
//  S1 平时:源码藏着、嵌入体在;嵌入段的高度 = 嵌入体的高度(段尾没有多撑出一行空白)
//  S2 上一段末行按 ↓ → 光标进源码;源码露出来、排在嵌入体上方;嵌入体还是原来那个 DOM
//  S3 源码里再按 ↓ → 越过嵌入体到下一段;源码收起
//  S4 下一段首行按 ↑ → 光标进源码
//  S5 上一段末尾按 → = 源码行首;下一段开头按 ← = 源码行尾;源码行尾按 → = 下一段开头
//  S6 悬停的 `</>` → 光标进源码、嵌入体不让位(仍在)
//  S7 源码露着时编辑器失焦 → 源码照旧整行显示、嵌入体位置不跳
//  S8 改源码:删掉 `!` → 嵌入体消失、只剩链接源码;补回 `!` → 嵌入体回来
//  S9 嵌入是最后一块:源码里按 ↓ → 在它后面新起一段
//  S10 文件卡(`![[x.zip]]`)同样的逻辑
//  S11 图片 `![[pic.png]]` 不变:上一段按 ↓ 不露它的源码
//  S12 「难源码」类别不变:上一段按 ↓ 撞书签卡 / 分割线 = 整块选中
//  S13 整块选中(块尾 Delete 撞上)不露源码
//
// 用法:npm run check:embedsource(= node scripts/e2e-editor.cjs --check=embed-source;worktree 里设 HARNESS_URL)
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
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, seed, waitEmbed = true) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  if (waitEmbed) await p.waitForSelector(`${PM} .unified-embed`, { timeout: 20000 })
  await p.waitForTimeout(400)
  return p
}

/** 光标放到内容恰为 t 的顶层块:where = 'end' | 'start'。 */
const caret = (p, t, where = 'end') => p.evaluate(([t, where]) => {
  const v = window.__upage.probe.view()
  let at = -1
  v.state.doc.forEach((n, off) => { if (n.textContent === t) at = where === 'end' ? off + n.nodeSize - 1 : off + 1 })
  v.focus()
  v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at))))
}, [t, where])

/** 嵌入段(源码以 src 开头的那一段)的现状:选区在不在它里面、源码看不看得见、嵌入体在哪。 */
const look = (p, src = '![[') => p.evaluate((src) => {
  const v = window.__upage.probe.view()
  const sel = v.state.selection
  let pos = -1, node = null
  v.state.doc.forEach((n, off) => { if (pos < 0 && n.textContent.startsWith(src)) { pos = off; node = n } })
  const dom = pos < 0 ? null : v.nodeDOM(pos)
  const embed = dom ? dom.querySelector(':scope > .unified-embed') : null
  let textTop = null, textH = 0, shown = ''
  if (dom) {
    const w = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT)
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      if ((embed && embed.contains(t)) || t.parentElement.closest('.wikilink')) continue
      const r = document.createRange(); r.selectNodeContents(t)
      let seen = false
      for (const b of r.getClientRects()) if (b.width > 0 && b.height > 0) { seen = true; textTop = textTop == null ? b.top : Math.min(textTop, b.top); textH = Math.max(textH, b.height) }
      if (seen) shown += t.textContent
    }
  }
  const er = embed ? embed.getBoundingClientRect() : null
  const pr = dom ? dom.getBoundingClientRect() : null
  if (embed && embed.__mark === undefined) embed.__mark = Math.random()
  return {
    inside: pos >= 0 && sel.from > pos && sel.to < pos + node.nodeSize && sel.empty,
    offset: pos >= 0 ? sel.from - pos - 1 : null,
    size: node ? node.content.size : null,
    selType: sel.toJSON().type,
    selParent: sel.$from.parent.textContent,
    selOffset: sel.$from.parentOffset,
    srcVisible: textTop != null,
    shown,
    srcAbove: textTop != null && !!er && textTop + textH <= er.top + 1,
    embed: !!embed && er.height > 10,
    embedTop: er ? Math.round(er.top) : null,
    extra: pr && er ? Math.round(pr.height - er.height) : null,
    mark: embed ? embed.__mark : null,
    cls: dom ? dom.className : '',
    blocks: (() => { const o = []; v.state.doc.forEach((n) => o.push(`${n.type.name}:${n.textContent.slice(0, 14)}`)); return o.join(' / ') })(),
  }
}, src)
const press = async (p, k) => { await p.keyboard.press(k); await p.waitForTimeout(160) }

const NOTE = '# T\n\n上一段。\n\n![[Embedded]]\n\n下一段。\n'

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    // S1–S5
    let p = await open(browser, NOTE)
    let s = await look(p)
    const mark = s.mark
    record('S1 平时源码藏着、嵌入体在;段尾没有多撑出一行', !s.srcVisible && s.embed && s.extra != null && s.extra <= 2, JSON.stringify({ src: s.srcVisible, embed: s.embed, extra: s.extra }))

    await caret(p, '上一段。'); await press(p, 'ArrowDown')
    s = await look(p)
    record('S2 上一段按 ↓ → 光标进源码,源码露在嵌入体上方,嵌入体不重挂', s.inside && s.shown === '![[Embedded]]' && s.srcAbove && s.embed && s.mark === mark, JSON.stringify({ inside: s.inside, sel: s.selType, shown: s.shown, above: s.srcAbove, same: s.mark === mark, cls: s.cls }))

    await press(p, 'ArrowDown')
    s = await look(p)
    record('S3 源码里再按 ↓ → 到下一段,源码收起', !s.inside && s.selParent === '下一段。' && !s.srcVisible && s.embed && s.mark === mark, JSON.stringify({ parent: s.selParent, src: s.srcVisible, same: s.mark === mark }))

    await press(p, 'ArrowUp')
    s = await look(p)
    record('S4 下一段按 ↑ → 光标进源码', s.inside && s.srcVisible && s.srcAbove, JSON.stringify({ inside: s.inside, src: s.srcVisible, sel: s.selType, parent: s.selParent }))
    await press(p, 'ArrowUp')
    s = await look(p)
    const upOut = !s.inside && s.selParent === '上一段。' && !s.srcVisible

    await caret(p, '上一段。'); await press(p, 'ArrowRight')
    const r1 = await look(p)
    await caret(p, '下一段。', 'start'); await press(p, 'ArrowLeft')
    const r2 = await look(p)
    await press(p, 'ArrowRight')
    const r3 = await look(p)
    record('S5 → 进源码行首;← 进源码行尾;行尾 → 到下一段开头;源码里 ↑ 回上一段',
      r1.inside && r1.offset === 0 && r2.inside && r2.offset === r2.size && !r3.inside && r3.selParent === '下一段。' && r3.selOffset === 0 && upOut,
      JSON.stringify({ right: [r1.inside, r1.offset], left: [r2.inside, r2.offset, r2.size], out: [r3.selParent, r3.selOffset], upOut }))

    // S6
    await caret(p, '下一段。')
    await p.hover(`${PM} .unified-embed`)
    await p.click(`${PM} .unified-embed > .amx-src-btn`)
    await p.waitForTimeout(200)
    s = await look(p)
    record('S6 `</>` → 光标进源码,嵌入体不让位', s.inside && s.srcVisible && s.embed && s.mark === mark, JSON.stringify({ inside: s.inside, src: s.srcVisible, embed: s.embed, same: s.mark === mark }))

    // S7
    const topBefore = s.embedTop
    await p.evaluate(() => { const b = document.createElement('button'); b.id = 'blur-probe'; b.style.cssText = 'position:fixed;right:4px;bottom:4px'; document.body.appendChild(b); b.focus() })
    await p.waitForTimeout(200)
    s = await look(p)
    const focused = await p.evaluate(() => window.__upage.probe.view().hasFocus())
    record('S7 源码露着时失焦 → 源码仍整行在、嵌入体不跳', !focused && s.shown === '![[Embedded]]' && s.embedTop === topBefore, JSON.stringify({ focused, shown: s.shown, top: [topBefore, s.embedTop] }))
    await p.close()

    // S8
    p = await open(browser, NOTE)
    await caret(p, '上一段。'); await press(p, 'ArrowRight')
    await press(p, 'Delete')
    let s8a = await look(p, '[[')
    await p.keyboard.type('!'); await p.waitForTimeout(600)
    let s8b = await look(p)
    record('S8 删掉 `!` → 嵌入体消失;补回 → 嵌入体回来', !s8a.embed && s8a.srcVisible && s8b.embed && s8b.inside && s8b.srcVisible, JSON.stringify({ gone: !s8a.embed, back: s8b.embed, inside: s8b.inside }))
    await p.close()

    // S9
    p = await open(browser, '# T\n\n上一段。\n\n![[Embedded]]\n')
    await caret(p, '上一段。'); await press(p, 'ArrowDown'); await press(p, 'ArrowDown')
    s = await look(p)
    record('S9 嵌入是最后一块:源码里按 ↓ → 后面新起一段', !s.inside && s.selParent === '' && /paragraph:!\[\[Embedded\]\] \/ paragraph:$/.test(s.blocks) && !s.srcVisible, s.blocks)
    await p.close()

    // S10
    p = await open(browser, '# T\n\n上一段。\n\n![[data.zip]]\n\n下一段。\n')
    await caret(p, '上一段。'); await press(p, 'ArrowDown')
    const f1 = await look(p)
    await press(p, 'ArrowDown')
    const f2 = await look(p)
    record('S10 文件卡同样的逻辑', f1.inside && f1.srcVisible && f1.srcAbove && f1.embed && !f2.inside && f2.selParent === '下一段。' && !f2.srcVisible, JSON.stringify({ in: [f1.inside, f1.srcVisible, f1.srcAbove], out: [f2.selParent, f2.srcVisible] }))
    await p.close()

    // S11
    p = await open(browser, '# T\n\n上一段。\n\n![[pic.png]]\n\n下一段。\n', false)
    await p.waitForSelector(`${PM} .wiki-inline-img-wrap`, { timeout: 20000 })
    await caret(p, '上一段。'); await press(p, 'ArrowDown')
    const img = await p.evaluate(() => ({ rendered: !!document.querySelector('.unified-body .wiki-inline-img-wrap'), embed: !!document.querySelector('.unified-body .unified-embed') }))
    record('S11 图片不变:↓ 经过不露源码(仍是渲染出来的图片,不归嵌入层)', img.rendered && !img.embed, JSON.stringify(img))
    await p.close()

    // S12
    p = await open(browser, '# T\n\n上一段。\n\nhttps://example.com/a\n\n中间。\n\n---\n\n下一段。\n')
    await caret(p, '上一段。'); await press(p, 'ArrowDown')
    const h1 = await p.evaluate(() => { const s = window.__upage.probe.view().state.selection; return { type: s.toJSON().type, text: s.node ? s.node.textContent : null } })
    await caret(p, '中间。'); await press(p, 'ArrowDown')
    const h2 = await p.evaluate(() => { const s = window.__upage.probe.view().state.selection; return { type: s.toJSON().type, node: s.node ? s.node.type.name : null } })
    record('S12 难源码类别不变:↓ 撞书签卡 / 分割线 = 整块选中', h1.type === 'node' && h1.text === 'https://example.com/a' && h2.type === 'node' && /hr|horizontal_rule/.test(h2.node || ''), JSON.stringify({ bookmark: h1, hr: h2 }))
    await p.close()

    // S13
    p = await open(browser, NOTE)
    await caret(p, '上一段。'); await press(p, 'Delete')
    s = await look(p)
    record('S13 整块选中(块尾 Delete 撞上)不露源码', s.selType === 'node' && !s.srcVisible && s.embed, JSON.stringify({ sel: s.selType, src: s.srcVisible }))

    if (process.argv.some((x) => x.startsWith('--shot'))) {
      const dir = (process.argv.find((x) => x.startsWith('--shot=')) || '').slice(7) || os.tmpdir()
      await caret(p, '上一段。'); await press(p, 'ArrowDown')
      await p.screenshot({ path: path.join(dir, 'embed-source-revealed.png') })
      await press(p, 'ArrowDown')
      await p.screenshot({ path: path.join(dir, 'embed-source-hidden.png') })
      console.log('shot →', dir)
    }
    await p.close()
  } finally {
    await browser.close()
  }
  const bad = results.filter((x) => !x).length
  console.log(bad ? `\n${bad} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
