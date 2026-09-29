// 大纲 / 标题锚 / 块锚跳转的落点(评审 2026-09-27 C-03;G4-01、L-05 复用同一实现 revealBlockAtTop)。
//
//  旧病:reveal 先 dispatch(scrollIntoView) 再 focus —— PM 只在 DOM 选区已在编辑器里时才滚,所以刚打开笔记 /
//  焦点在标题框里时**首击不动**;而且那是最小滚动:往下跳标题贴视口底边,往上跳停在 top:0 被 sticky 顶栏盖住。
//  现在:先 focus、只放选区,再显式把块顶滚到「滚动容器顶 + 顶栏高 + 12」。
//
//  用**真** lifecycle.unifiedRevealHeading / unifiedRevealBlock(与 UnifiedPage 同一模块实例),接一排仿右栏大纲
//  按钮(编辑器外的真按钮,真鼠标点击 = 焦点离开编辑器,与侧栏点击同形)。&upane = 生产壳(.amx-pane 滚动 + sticky 顶栏)。
//  O1 新开笔记、从没点过正文 → 首击往下跳即生效,标题顶落在顶栏下 12px
//  O2 同一条再点一次 → 幂等(scrollTop 不变)
//  O3 往上跳 → 标题不被顶栏盖住,同样落在顶栏下 12px
//  O4 焦点在标题输入框里 → 首击即生效
//  O5 先在正文点过(常规路径)→ 往下跳不再贴视口底边
//  O6 块锚 `^id`(unifiedRevealBlock)新开笔记首击即生效、贴顶
//  O7 端级 zoom 1.25 下落点不按比例过冲;引用条闪片(flash)正落在标题上
//
//  —— 编辑器里点笔记锚点链接(评审 L-05:原先 `[[笔记#标题]]` / `[[笔记#^块]]` 只开笔记丢锚点,`[[#标题]]` 画成坏链点了没反应)——
//  L1 显示:`[[Alpha#Sec]]` →「Alpha › Sec」、`[[Alpha#^b1]]` →「Alpha › ^b1」、`[[#小节 5]]` →「小节 5」且**不**是虚线坏链
//  L2 点 `[[#小节 5]]`(本页锚点)→ 不换页,标题落在顶栏下 12px
//  L3 点 `[[Unified#小节 4]]`(指名本页)→ 不换页,标题落点正确
//  L4 点 `[[Nope#X]]`(笔记不存在)→ 询问创建的名字是「Nope」,不是「Nope#X」
//  L5 点 `[[Alpha#Sec]]` → 打开 Alpha.md 并把 Sec 标题亮到阅读位置(台架的 loadPage 换成 switchFile,模拟宿主路由)
//  L6 点 `[[Alpha#^b1]]` → 打开 Alpha.md 并把挂 ^b1 的那段亮到阅读位置
//
//  —— 全智库搜索 / 标签面板点命中(评审 G4-01:v4 笔记只打开不定位)。走生产接缝 lifecycle.unifiedRevealText ——
//  S1 深处的命中 → 落在顶栏下 12px,选区正好盖住命中文字
//  S2 命中在折起的标题小节里 → 先展开那一节再定位(光标守卫不许把选区放进隐藏区)
//  S3 命中在折起的列表子项里 → 先展开那一项再定位
//  S4 标签边界:`#work` 落在真正的 #work 上,不落在前面的 #workshop 上
//
// 用法:npm run check:outlinereveal(= node scripts/e2e-editor.cjs --check=outline-reveal;worktree 里设 HARNESS_URL)
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
const GAP = 12
const TOL = 3
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const sec = (n) => `## 小节 ${n}\n\n` + Array.from({ length: 12 }, (_, i) => `第 ${n}-${i} 段填充文字填充文字。${n === 4 && i === 5 ? ' ^blk4' : ''}`).join('\n\n')
const MD = `# 文首\n\n${[1, 2, 3, 4, 5, 6].map(sec).join('\n\n')}\n`

async function open(browser) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(MD)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForFunction(() => !!(window.__upage && window.__upage.lifecycle), null, { timeout: 20000 })
  await p.waitForTimeout(400)
  // 仿右栏大纲:编辑器外的一排真按钮,点击走生产 lifecycle 接缝。
  await p.evaluate(() => {
    const lc = window.__upage.lifecycle
    const hs = lc.unifiedHeadings('Unified.md')
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;right:0;top:120px;width:150px;z-index:99;background:#eee;display:flex;flex-direction:column'
    hs.forEach((h, i) => {
      const b = document.createElement('button')
      b.className = 'fake-ol'
      b.dataset.t = h.text
      b.textContent = h.text
      b.onclick = () => { window.__ret = lc.unifiedRevealHeading('Unified.md', i, h.text) }
      box.appendChild(b)
    })
    document.body.appendChild(box)
  })
  return p
}

/** 目标块与顶栏的视口几何 + 滚动量。 */
const measure = (p, sel, text) => p.evaluate(([sel, text]) => {
  const pane = document.querySelector('.amx-pane')
  const el = [...document.querySelectorAll(sel)].find((x) => x.textContent.includes(text))
  const r = el.getBoundingClientRect()
  return {
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    bar: Math.round(document.querySelector('.amx-pane > .amx-toolbar').getBoundingClientRect().bottom),
    scroll: Math.round(pane.scrollTop), paneH: Math.round(pane.getBoundingClientRect().height),
  }
}, [sel, text])
const H = `${PM} h2`
const landed = (m) => Math.abs(m.top - (m.bar + GAP)) <= TOL
const clickOl = async (p, text) => { await p.click(`.fake-ol[data-t="${text}"]`); await p.waitForTimeout(250) }

// ── L-05:编辑器里的笔记锚点链接 ────────────────────────────────────────────────────────────────
const LINK_MD = `# 文首\n\n见 [[Alpha#Sec]] 与 [[#小节 5]] 与 [[Alpha#^b1]] 与 [[Unified#小节 4]] 与 [[Nope#X]] 完\n\n${[1, 2, 3, 4, 5, 6].map(sec).join('\n\n')}\n`
const ALPHA_MD = `# Alpha\n\n${Array.from({ length: 30 }, (_, i) => `Alpha 填充 ${i}。`).join('\n\n')}\n\n## Sec\n\n小节正文。\n\n${Array.from({ length: 20 }, (_, i) => `后续 ${i}。`).join('\n\n')}\n\n锚定的那一段 ^b1\n\n${Array.from({ length: 40 }, (_, i) => `尾部 ${i}。`).join('\n\n')}\n`

async function openLinks(browser) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(LINK_MD)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForFunction(() => !!(window.__upage && window.__upage.lifecycle), null, { timeout: 20000 })
  await p.waitForTimeout(400)
  await p.evaluate((alpha) => {
    const up = window.__upage
    up.vault.set('Alpha.md', alpha)
    window.__loaded = []
    // 台架没有宿主路由:把 store 的 loadPage 换成 switchFile(= 生产里 leaf 换到那篇、UnifiedPage 按新路径挂载)。
    up.pageStore.setState({ pages: ['Alpha.md', 'Unified.md'], loadPage: async (path) => { window.__loaded.push(path); up.switchFile(path) } })
    const v = up.probe.view()
    v.dispatch(v.state.tr) // pages 变了 → 让双链装饰按新解析态重建
  }, ALPHA_MD)
  await p.waitForTimeout(200)
  return p
}
const clickLink = async (p, text) => {
  // 链接在文首那一行:上一步的定位可能把它滚出了视口,先滚回顶再点(真鼠标点不到视口外)。
  await p.evaluate(() => { document.querySelector('.amx-pane').scrollTop = 0 })
  await p.waitForTimeout(150)
  const b = await p.evaluate((t) => {
    const el = [...document.querySelectorAll('.unified-body .wikilink')].find((x) => x.textContent === t)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, text)
  if (!b) return false
  await p.mouse.click(b.x, b.y)
  return true
}
/** 等到当前挂载的是 path 那篇、且 sel 里含 text 的块落在顶栏下 12px(或超时)。 */
const waitLanded = async (p, sel, text, ms = 3000) => {
  const t0 = Date.now()
  let m = null
  while (Date.now() - t0 < ms) {
    m = await p.evaluate(([sel, text]) => {
      const pane = document.querySelector('.amx-pane')
      const el = [...document.querySelectorAll(sel)].find((x) => x.textContent.includes(text))
      if (!el || !pane) return null
      const r = el.getBoundingClientRect()
      const v = window.__upage.probe.view()
      const s = v.state.selection
      const $f = v.state.doc.resolve(s.from)
      return {
        top: Math.round(r.top), bar: Math.round(document.querySelector('.amx-pane > .amx-toolbar').getBoundingClientRect().bottom),
        scroll: Math.round(pane.scrollTop), selIn: $f.parent.textContent.includes(text),
      }
    }, [sel, text])
    if (m && landed(m) && m.selIn) break
    await p.waitForTimeout(100)
  }
  // reveal 在 600ms 后还有一次补跳(amadeusNav.reveal*WhenReady):不等它落完,下一步「滚回顶再点」会被它滚走、点空。
  await p.waitForTimeout(750)
  return m
}

async function anchorLinks(browser) {
  let p = await openLinks(browser)
  const links = await p.evaluate(() => [...document.querySelectorAll('.unified-body .wikilink')].map((e) => ({ t: e.textContent, bad: e.classList.contains('wikilink-unresolved') })))
  const by = (t) => links.find((x) => x.t === t)
  record('L1 锚点链接显示「笔记 › 标题」,本页锚点不是坏链',
    !!by('Alpha › Sec') && !!by('Alpha › ^b1') && !!by('Unified › 小节 4') && by('小节 5')?.bad === false && by('Nope › X')?.bad === true,
    JSON.stringify(links))
  await clickLink(p, '小节 5')
  const l2 = await waitLanded(p, `${PM} h2`, '小节 5')
  record('L2 点 [[#小节 5]] → 本页标题落在顶栏下 12px,不换页', !!l2 && landed(l2) && l2.selIn && (await p.evaluate(() => window.__loaded.length)) === 0, JSON.stringify(l2))
  await clickLink(p, 'Unified › 小节 4')
  const l3 = await waitLanded(p, `${PM} h2`, '小节 4')
  record('L3 点 [[Unified#小节 4]] → 指名本页也就地定位,不换页', !!l3 && landed(l3) && l3.selIn && (await p.evaluate(() => window.__loaded.length)) === 0, JSON.stringify(l3))
  await clickLink(p, 'Nope › X')
  await p.waitForTimeout(300)
  const pend = await p.evaluate(() => window.__upage.pageStore.getState().pendingWikiCreate)
  record('L4 点 [[Nope#X]] → 询问创建「Nope」(不带 #X)', pend?.name === 'Nope', JSON.stringify(pend))
  await p.evaluate(() => window.__upage.pageStore.getState().cancelWikiCreate())
  await clickLink(p, 'Alpha › Sec')
  const l5 = await waitLanded(p, `${PM} h2`, 'Sec')
  const loaded5 = await p.evaluate(() => window.__loaded)
  record('L5 点 [[Alpha#Sec]] → 打开 Alpha.md 并定位到 Sec', loaded5.join() === 'Alpha.md' && !!l5 && landed(l5) && l5.selIn, JSON.stringify({ loaded5, ...l5 }))
  await p.close()

  p = await openLinks(browser)
  await clickLink(p, 'Alpha › ^b1')
  const l6 = await waitLanded(p, `${PM} p`, '^b1')
  const loaded6 = await p.evaluate(() => window.__loaded)
  record('L6 点 [[Alpha#^b1]] → 打开 Alpha.md 并定位到挂 ^b1 的段', loaded6.join() === 'Alpha.md' && !!l6 && landed(l6) && l6.selIn, JSON.stringify({ loaded6, ...l6 }))
  await p.close()
}

// ── G4-01:搜索 / 标签命中定位 ─────────────────────────────────────────────────────────────────
const SEARCH_MD = `# 文首\n\n前面提到 #workshop 与别的。\n\n${[1, 2, 3, 4, 5].map(sec).join('\n\n')}\n\n- 父项\n  - 子项里的 listneedle 在这\n- 另一项\n\n## 收尾\n\n这里才是 #work 标签。\n\n${Array.from({ length: 30 }, (_, i) => `尾部 ${i}。`).join('\n\n')}\n`

async function openSearch(browser) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(SEARCH_MD)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForFunction(() => !!(window.__upage && window.__upage.lifecycle), null, { timeout: 20000 })
  await p.waitForTimeout(400)
  return p
}
/** 折叠:直接发两个折叠插件自己的 toggle meta(与把手上的折叠钮同一条路),不经鼠标 hover。 */
const fold = (p, kind, text) => p.evaluate(([kind, text]) => {
  const v = window.__upage.probe.view()
  const plugin = v.state.plugins.find((x) => x.key.startsWith(kind === 'heading' ? 'AMX_HEADING_FOLD' : 'AMX_LIST_FOLD'))
  let at = null
  v.state.doc.descendants((n, pos) => {
    if (at != null) return false
    if (kind === 'heading' && n.type.name === 'heading' && n.textContent === text) at = pos
    if (kind === 'list' && n.type.name === 'list_item' && n.firstChild.textContent === text) at = pos
    return at == null
  })
  v.dispatch(v.state.tr.setMeta(plugin, { toggle: at }))
  return at
}, [kind, text])
/** 命中文字的视口几何 + 选区是否正好盖住它。 */
const measureHit = (p, needle) => p.evaluate((needle) => {
  const v = window.__upage.probe.view()
  const s = v.state.selection
  const picked = v.state.doc.textBetween(s.from, s.to)
  const dom = v.domAtPos(s.from)
  const node = dom.node.nodeType === 3 ? dom.node.parentElement : dom.node
  const r = node.getBoundingClientRect()
  return {
    picked, top: Math.round(r.top), h: Math.round(r.height),
    bar: Math.round(document.querySelector('.amx-pane > .amx-toolbar').getBoundingClientRect().bottom),
    scroll: Math.round(document.querySelector('.amx-pane').scrollTop),
    headFolded: document.querySelectorAll('.amx-heading-folded').length, listFolded: document.querySelectorAll('.amx-listitem-folded').length,
    ok: picked.toLowerCase() === needle.toLowerCase(),
  }
}, needle)
const reveal = (p, needles, opts) => p.evaluate(([n, o]) => window.__upage.lifecycle.unifiedRevealText('Unified.md', n, o), [needles, opts])

async function textReveal(browser) {
  let p = await openSearch(browser)
  const r1 = await reveal(p, ['第 4-6 段'])
  await p.waitForTimeout(200)
  const m1 = await measureHit(p, '第 4-6 段')
  record('S1 深处命中 → 落在顶栏下 12px、选区盖住命中', r1 === true && m1.ok && m1.scroll > 0 && Math.abs(m1.top - (m1.bar + GAP)) <= TOL, JSON.stringify({ r1, ...m1 }))
  await p.close()

  p = await openSearch(browser)
  await fold(p, 'heading', '小节 3')
  await p.waitForTimeout(150)
  const before2 = await p.evaluate(() => document.querySelectorAll('.amx-heading-folded').length)
  const r2 = await reveal(p, ['第 3-7 段'])
  await p.waitForTimeout(200)
  const m2 = await measureHit(p, '第 3-7 段')
  record('S2 命中在折起的标题小节里 → 先展开再定位', before2 === 1 && r2 === true && m2.ok && m2.headFolded === 0 && m2.h > 0 && Math.abs(m2.top - (m2.bar + GAP)) <= TOL, JSON.stringify({ before2, r2, ...m2 }))
  await p.close()

  p = await openSearch(browser)
  await fold(p, 'list', '父项')
  await p.waitForTimeout(150)
  const before3 = await p.evaluate(() => document.querySelectorAll('.amx-listitem-folded').length)
  const r3 = await reveal(p, ['listneedle'])
  await p.waitForTimeout(200)
  const m3 = await measureHit(p, 'listneedle')
  record('S3 命中在折起的列表子项里 → 先展开再定位', before3 === 1 && r3 === true && m3.ok && m3.listFolded === 0 && m3.h > 0 && Math.abs(m3.top - (m3.bar + GAP)) <= TOL, JSON.stringify({ before3, r3, ...m3 }))
  await p.close()

  p = await openSearch(browser)
  const r4 = await reveal(p, ['#work'], { tag: true })
  await p.waitForTimeout(200)
  const m4 = await p.evaluate(() => { const v = window.__upage.probe.view(); const s = v.state.selection; return { picked: v.state.doc.textBetween(s.from, s.to), para: v.state.doc.resolve(s.from).parent.textContent } })
  record('S4 标签 #work 按边界匹配,不落在 #workshop 上', r4 === true && m4.picked === '#work' && m4.para.includes('这里才是'), JSON.stringify({ r4, ...m4 }))
  await p.close()
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    let p = await open(browser)
    await clickOl(p, '小节 4')
    const m1 = await measure(p, H, '小节 4')
    record('O1 新开笔记首击往下跳即生效,标题落在顶栏下 12px', m1.scroll > 0 && landed(m1), JSON.stringify(m1))
    await clickOl(p, '小节 4')
    const m2 = await measure(p, H, '小节 4')
    record('O2 同一条再点 → 幂等', Math.abs(m2.scroll - m1.scroll) <= 1 && landed(m2), JSON.stringify(m2))
    await clickOl(p, '小节 2')
    const m3 = await measure(p, H, '小节 2')
    record('O3 往上跳 → 不被顶栏盖住,落在顶栏下 12px', m3.top >= m3.bar && landed(m3), JSON.stringify(m3))
    await p.close()

    p = await open(browser)
    await p.click('.amx-title-input')
    await clickOl(p, '小节 3')
    const m4 = await measure(p, H, '小节 3')
    record('O4 焦点在标题输入框 → 首击即生效', m4.scroll > 0 && landed(m4), JSON.stringify(m4))
    await p.close()

    p = await open(browser)
    const at = await p.evaluate((s) => { const r = document.querySelector(s + ' p').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } }, PM)
    await p.mouse.click(at.x, at.y)
    await clickOl(p, '小节 5')
    const m5 = await measure(p, H, '小节 5')
    record('O5 先点过正文 → 往下跳不贴视口底边', landed(m5) && m5.bottom < m5.paneH - 100, JSON.stringify(m5))
    await p.close()

    p = await open(browser)
    const ok6 = await p.evaluate(() => window.__upage.lifecycle.unifiedRevealBlock('Unified.md', 'blk4'))
    await p.waitForTimeout(250)
    const m6 = await measure(p, `${PM} p`, '^blk4')
    record('O6 块锚 ^id 新开笔记首击即生效、贴顶', ok6 === true && m6.scroll > 0 && landed(m6), JSON.stringify({ ok6, ...m6 }))
    await p.close()

    p = await open(browser)
    await p.evaluate(() => { document.body.style.zoom = '1.25' })
    await p.waitForTimeout(200)
    await p.evaluate(() => {
      const lc = window.__upage.lifecycle
      const hs = lc.unifiedHeadings('Unified.md')
      const i = hs.findIndex((h) => h.text === '小节 5')
      lc.unifiedRevealHeading('Unified.md', i, hs[i].text, true)
    })
    await p.waitForTimeout(100)
    const m7 = await measure(p, H, '小节 5')
    const flash = await p.evaluate((s) => {
      const f = document.querySelectorAll('.am-citeflash')
      const h = [...document.querySelectorAll(s)].find((x) => x.textContent.includes('小节 5')).getBoundingClientRect()
      if (f.length !== 1) return { n: f.length }
      const r = f[0].getBoundingClientRect()
      return { n: 1, dTop: Math.round(r.top - h.top), dLeft: Math.round(r.left - h.left) }
    }, H)
    record('O7 端级 zoom 1.25:落点不过冲、闪片正落在标题上',
      landed(m7) && flash.n === 1 && Math.abs(flash.dTop + 2) <= TOL && Math.abs(flash.dLeft + 4) <= TOL,
      JSON.stringify({ ...m7, flash }))
    await p.close()
    await anchorLinks(browser)
    await textReveal(browser)
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
