// 页内目录块(```toc,Notion 的 /目录):真 v4 编辑器 × 嵌入层,台架页里点一遍。
//   /目录 插入 → 落盘 ```toc + 两行范围、光标落在下面的空行;列 H1–H3(H4 不列)、缩进表示层级;
//   改 / 加 / 删标题目录当场跟着变,正文打字不动目录 DOM;点一条平滑滚到标题并闪一下;空页灰字(中英);
//   `</>` 露源码改 max_depth → 范围跟着变;撤销;存盘重开逐字不变;/toc /table of contents /mulu /ml 搜得到;
//   只读页 / 阅读模式 / 手机照样显示、能点跳转。
// 用法:HARNESS_URL=http://localhost:5371/harness.html npm run check:tocblock(worktree 里先换空闲端口,见 e2e-editor.cjs)
// harness.html 不加载主题 CSS(台架老样子):观感另拍真 Electron 截图。
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')
const origin = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const out = process.env.SHOT_DIR || '/tmp/forsion-toc-block'
const checks = [], errors = []
fs.mkdirSync(out, { recursive: true })
const ok = (name, value, detail) => {
  if (!value) console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail))
  assert.ok(value, name)
  checks.push(name)
  console.log('PASS', name)
}
const PM = '.unified-body .ProseMirror'
const FENCE = '```toc\nmin_depth: 1\nmax_depth: 3\n```'
const filler = (n) => Array.from({ length: n }, (_, i) => `正文第 ${i + 1} 段,用来把下一个标题推到屏幕外面。`).join('\n\n')
const seed = `# 周报\n\n本页汇总 2.15 发布前要对齐的事项。\n\n## 本周目标\n\n${filler(6)}\n\n## 三方分工\n\n### 设计\n\n${filler(4)}\n\n### 研发\n\n#### 太深\n\n${filler(8)}\n\n## 风险\n\n${filler(30)}\n`
const frames = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const items = (p, root = PM) => p.$$eval(`${root} .amx-toc-item`, (es) => es.map((e) => ({ text: e.textContent, level: Number(e.dataset.level), pad: parseFloat(getComputedStyle(e).paddingLeft) })))
const texts = async (p, root) => (await items(p, root)).map((i) => i.text)
const disk = (p, name = 'Unified.md') => p.evaluate((n) => window.__upage.vault.get(n), name)
const flush = async (p, name = 'Unified.md') => {
  await p.waitForFunction(() => !!window.__upage.lifecycle)
  await p.evaluate((n) => window.__upage.lifecycle.flushUnifiedPath(n, true), name)
}
const docHasToc = (p) => p.evaluate(() => { let n = 0; window.__upage.probe.view().state.doc.descendants((x) => { if (x.type.name === 'code_block' && x.attrs.language === 'toc') n++ }); return n })
/** 光标放到第 n 个段落末尾(按 PM 文档,不靠坐标)。 */
const caretAfterParagraph = (p, n = 0) => p.evaluate((n) => {
  const v = window.__upage.probe.view()
  let i = 0, at = null
  v.state.doc.descendants((node, pos) => { if (at == null && node.type.name === 'paragraph' && i++ === n) at = pos + node.nodeSize - 1; return at == null })
  v.focus()
  v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
}, n)
const caretInHeading = (p, text, where = 'end') => p.evaluate(({ text, where }) => {
  const v = window.__upage.probe.view()
  let at = null
  v.state.doc.descendants((node, pos) => { if (at == null && node.type.name === 'heading' && node.textContent === text) at = where === 'end' ? pos + node.nodeSize - 1 : pos + 1; return at == null })
  v.focus()
  v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
}, { text, where })
async function slash(p, query) {
  await p.keyboard.type(query, { delay: 25 })
  await p.waitForSelector('.slash-menu')
  await frames(p)
  return p.$$eval('.slash-item[data-key]', (es) => es.map((e) => e.getAttribute('data-key')))
}
async function open(browser, md, flags = '', ctx = { locale: 'zh-CN', viewport: { width: 1200, height: 850 } }) {
  const p = await (ctx.newPage ? ctx.newPage() : browser.newPage(ctx))
  p.setDefaultTimeout(15000)
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(`${origin}?upage&upane${flags}&useed=${encodeURIComponent(md)}`, { timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForFunction(() => !!window.__upage?.probe?.view?.())
  await frames(p)
  return p
}
/** 点第 i 条 → 等闪光片出现,量标题顶离滚动容器顶多远(应 ≈ 顶栏 + 12)。 */
async function jump(p, label, root = PM, click = (loc) => loc.click()) {
  const loc = p.locator(`${root} .amx-toc-item`).filter({ hasText: label }).first()
  await click(loc)
  await p.waitForSelector('.am-citeflash', { state: 'attached', timeout: 5000 })
  return p.evaluate(({ label, root }) => {
    const scope = document.querySelector(root)
    const h = [...scope.querySelectorAll('h1,h2,h3,h4,h5,h6')].find((e) => e.textContent === label)
    const pane = h.closest('.amx-pane') || document.scrollingElement
    const bar = pane.querySelector(':scope > .amx-toolbar')
    const inset = bar && getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().height : 0
    const flash = document.querySelector('.am-citeflash').getBoundingClientRect()
    return { off: h.getBoundingClientRect().top - pane.getBoundingClientRect().top - inset, scrolled: pane.scrollTop, flashTop: flash.top, headTop: h.getBoundingClientRect().top }
  }, { label, root })
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    // ── 插入 + 落盘 + 光标 ─────────────────────────────────────────────
    let p = await open(browser, seed)
    await caretAfterParagraph(p, 0)
    await p.keyboard.press('Enter')
    const rows = await slash(p, '/目录')
    ok('/目录 first slash row is toc', rows[0] === 'toc', rows)
    ok('slash row is labelled 目录', (await p.locator('.slash-item[data-key="toc"]').textContent()).includes('目录'))
    await p.keyboard.press('Enter')
    await p.waitForSelector(`${PM} .amx-toc-item`)
    await p.keyboard.type('接着写')
    await flush(p)
    let saved = await disk(p)
    ok('disk has ```toc with the two option lines', saved.includes(`本页汇总 2.15 发布前要对齐的事项。\n\n${FENCE}\n\n接着写\n\n## 本周目标`), saved.slice(0, 200))
    ok('typing right after insert lands on a new line below, not in the hidden source', !/```toc[^`]*接着写/.test(saved) && saved.includes('## 本周目标\n'))
    await p.waitForTimeout(100)
    let list = await items(p)
    ok('lists H1–H3 in order, H4 not listed', JSON.stringify(list.map((i) => i.text)) === JSON.stringify(['周报', '本周目标', '三方分工', '设计', '研发', '风险']), list)
    ok('indent shows the level', list[0].pad < list[1].pad && list[1].pad < list[3].pad && list[1].pad === list[2].pad, list.map((i) => i.pad))
    ok('no code toolbar on the toc block', await p.locator(`${PM} pre[data-language="toc"] .amx-code-tools`).count() === 0)
    ok('toc source text is hidden', await p.locator(`${PM} pre[data-language="toc"]`).evaluate((e) => !e.innerText.includes('min_depth')))
    await p.screenshot({ path: path.join(out, 'inserted.png') })

    // ── 跟着标题变;正文打字不动目录 DOM ─────────────────────────────────
    await p.evaluate(() => {
      window.__tocMut = 0
      new MutationObserver((m) => { window.__tocMut += m.length }).observe(document.querySelector('.amx-toc'), { subtree: true, childList: true, characterData: true, attributes: true })
    })
    await caretAfterParagraph(p, 2)
    await p.keyboard.type('无关的字')
    await frames(p); await frames(p)
    ok('typing in a paragraph does not touch the toc DOM', await p.evaluate(() => window.__tocMut) === 0)
    await caretInHeading(p, '本周目标')
    await p.keyboard.type('改')
    await p.waitForFunction(() => [...document.querySelectorAll('.amx-toc-item')].some((e) => e.textContent === '本周目标改'))
    ok('renaming a heading updates the toc at once', (await texts(p))[1] === '本周目标改')
    await caretAfterParagraph(p, 3)
    await p.keyboard.press('Enter')
    await p.keyboard.type('## 新加的标题')
    await p.waitForFunction(() => [...document.querySelectorAll('.amx-toc-item')].some((e) => e.textContent === '新加的标题'))
    ok('adding a heading adds a toc row in document order', (await texts(p)).indexOf('新加的标题') === 2, await texts(p))
    await caretInHeading(p, '新加的标题', 'start')
    await p.keyboard.press('Backspace') // 标题首退格 = 变回段落
    await p.waitForFunction(() => ![...document.querySelectorAll('.amx-toc-item')].some((e) => e.textContent === '新加的标题'))
    ok('turning a heading back into text removes its row', !(await texts(p)).includes('新加的标题'))

    // ── 点一条:平滑滚 + 闪 ─────────────────────────────────────────
    await p.evaluate(() => { document.querySelector('.amx-pane').scrollTop = 0 })
    const selBefore = await p.evaluate(() => window.__upage.probe.view().state.selection.from)
    const smooth = p.evaluate(() => new Promise((res) => {
      const pane = document.querySelector('.amx-pane'), seen = new Set()
      const onScroll = () => seen.add(Math.round(pane.scrollTop))
      pane.addEventListener('scroll', onScroll)
      setTimeout(() => { pane.removeEventListener('scroll', onScroll); res(seen.size) }, 1500)
    })).catch(() => 0)
    let j = await jump(p, '风险')
    ok('click scrolls the heading to the reading position', j.scrolled > 200 && Math.abs(j.off - 12) <= 4, j)
    ok('the scroll is smooth (several intermediate positions)', (await smooth) >= 3)
    ok('the landing heading flashes', Math.abs(j.flashTop - j.headTop) <= 6, j)
    ok('clicking a row does not move the caret', await p.evaluate(() => window.__upage.probe.view().state.selection.from) === selBefore)
    await p.screenshot({ path: path.join(out, 'jumped.png') })

    // ── `</>` 露源码改范围 ──────────────────────────────────────────
    await p.evaluate(() => { document.querySelector('.amx-pane').scrollTop = 0 })
    await p.locator(`${PM} .amx-toc`).hover()
    await p.locator(`${PM} .unified-embed:has(.amx-toc) .amx-src-btn`).click()
    await p.waitForFunction(() => document.querySelector('.unified-body pre[data-language="toc"]')?.innerText.includes('max_depth'))
    ok('</> reveals the source as a plain code block', await p.locator(`${PM} .amx-toc`).count() === 0)
    ok('revealed toc source still has no code toolbar', await p.locator(`${PM} pre[data-language="toc"] .amx-code-tools`).count() === 0)
    const tocState = () => p.evaluate(() => { const v = window.__upage.probe.view(); const s = v.state.selection; let t = null; v.state.doc.descendants((n) => { if (n.type.name === 'code_block' && n.attrs.language === 'toc') t = n.textContent }); return { sel: s.from, parent: s.$from.parent.type.name, toc: t, rendered: !!document.querySelector('.amx-toc') } })
    // 选中源码里 max_depth 的那个 3,真键入 4(End 键在长页上 Chromium 会滚页而不是到行尾,不拿它定位)。
    await p.evaluate(() => {
      const v = window.__upage.probe.view()
      let at = null
      v.state.doc.descendants((n, pos) => { if (at == null && n.type.name === 'code_block' && n.attrs.language === 'toc') at = pos + 1 + n.textContent.lastIndexOf('3'); return at == null })
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at, at + 1)))
    })
    await p.keyboard.type('4')
    ok('typing in the revealed source edits the range', (await tocState()).toc === 'min_depth: 1\nmax_depth: 4', await tocState())
    await caretAfterParagraph(p, 4)
    await p.waitForSelector(`${PM} .amx-toc-item`)
    await p.waitForFunction(() => [...document.querySelectorAll('.amx-toc-item')].some((e) => e.textContent === '太深'))
    ok('max_depth: 4 lists the H4 too', (await texts(p)).includes('太深'))
    await flush(p)
    saved = await disk(p)
    ok('edited range is saved as written', saved.includes('```toc\nmin_depth: 1\nmax_depth: 4\n```'))

    // ── 存盘重开逐字不变 ──────────────────────────────────────────────
    const before = (await p.evaluate(() => window.__upage.writes.length))
    await p.evaluate((md) => window.__upage.switchFile('Reopened.md', md), saved)
    await p.waitForSelector(`${PM} .amx-toc-item`)
    await frames(p)
    await flush(p, 'Reopened.md')
    ok('reopening renders the same toc', (await texts(p)).includes('太深') && (await texts(p)).length === 7)
    ok('reopen + save is byte-identical', await disk(p, 'Reopened.md') === saved && !(await p.evaluate((n) => window.__upage.writes.slice(n).some((w) => w.path === 'Reopened.md'), before)))
    await p.close()

    // ── 撤销 ────────────────────────────────────────────────────────
    p = await open(browser, '# 撤销\n\n正文。\n')
    await caretAfterParagraph(p, 0)
    await p.keyboard.press('Enter')
    await slash(p, '/目录')
    await p.keyboard.press('Enter')
    await p.waitForSelector(`${PM} .amx-toc-item`)
    ok('inserted once', await docHasToc(p) === 1)
    // 插完不打字直接存:光标落脚的空行按 v4 的空段落口径存成空行,重开逐字不变
    await flush(p)
    saved = await disk(p)
    ok('insert without typing saves the fence plus a blank line', saved === `# 撤销\n\n正文。\n\n${FENCE}\n\n`, saved)
    await p.keyboard.press('Meta+z')
    await frames(p)
    ok('one undo removes the toc block', await docHasToc(p) === 0 && await p.locator(`${PM} .amx-toc`).count() === 0)
    await flush(p)
    ok('after undo the saved note is back to the original bytes', await disk(p) === '# 撤销\n\n正文。\n', await disk(p))
    await p.close()

    // ── 斜杠搜索别名 ─────────────────────────────────────────────────
    p = await open(browser, '# 搜索\n\n正文。\n')
    // 斜杠查询遇空格即关菜单(wikiAutocomplete 的既定设计:「/foo 」留成字面),所以 /table of contents 打不完整 —— 不连空格的写法都要搜到。
    for (const q of ['/toc', '/tableofcontents', '/contents', '/mulu', '/ml']) {
      await caretAfterParagraph(p, 0)
      await p.keyboard.press('Enter')
      const r = await slash(p, q)
      ok(`${q} finds the toc row first`, r[0] === 'toc', r)
      await p.keyboard.press('Escape')
      await p.evaluate(() => { const v = window.__upage.probe.view(); const { $from } = v.state.selection; v.dispatch(v.state.tr.delete($from.before(), $from.after())) })
    }
    await p.evaluate(() => window.__upage.setLocale('en'))
    await caretAfterParagraph(p, 0)
    await p.keyboard.press('Enter')
    const en = await slash(p, '/table')
    ok('English UI: /table lists “Table of contents” right after Table', en[0] === 'table' && en[1] === 'toc' && (await p.locator('.slash-item[data-key="toc"]').textContent()).includes('Table of contents'), en)
    await p.keyboard.press('Escape')
    await p.close()

    // ── 空页灰字(中 / 英)────────────────────────────────────────────
    p = await open(browser, `开头一段。\n\n${FENCE}\n\n没有标题的一页。\n`)
    await p.waitForSelector(`${PM} .amx-toc-empty`)
    ok('empty page shows the zh hint', (await p.locator(`${PM} .amx-toc-empty`).textContent()) === '加几个标题就会出现在这里')
    await p.screenshot({ path: path.join(out, 'empty-zh.png') })
    await p.evaluate(() => window.__upage.setLocale('en'))
    await p.waitForFunction(() => document.querySelector('.amx-toc-empty')?.textContent === "Add headings and they'll show up here")
    ok('empty page shows the en hint', true)
    await caretAfterParagraph(p, 1)
    await p.keyboard.press('Enter')
    await p.keyboard.type('# First heading')
    await p.waitForFunction(() => document.querySelector('.amx-toc-item')?.textContent === 'First heading')
    ok('the first heading replaces the hint', (await texts(p))[0] === 'First heading' && await p.locator(`${PM} .amx-toc-empty`).count() === 0)
    await p.close()

    const tocSeed = seed.replace('本页汇总 2.15 发布前要对齐的事项。\n\n', `本页汇总 2.15 发布前要对齐的事项。\n\n${FENCE}\n\n`)

    // ── 整块选中目录块再打字:字落在下面新起的一段,不进藏着的源码 ──────────────
    p = await open(browser, `# 选中\n\n${FENCE}\n\n正文。\n\n看 [网页](https://example.com) 这条链接。\n`)
    await p.waitForSelector(`${PM} .amx-toc-item`)
    // 条目是 `#标题` 锚点,不是正文链接:悬停不弹链接卡(正对照:正文链接照弹)
    await p.locator(`${PM} a[href="https://example.com"]`).hover(); await p.waitForTimeout(800)
    const cardOnLink = await p.locator('.amx-linkcard').count()
    await p.mouse.move(5, 5); await p.waitForTimeout(600)
    await p.locator(`${PM} .amx-toc-item`).first().hover(); await p.waitForTimeout(800)
    ok('hovering a toc row shows no link card (a body link still does)', cardOnLink === 1 && await p.locator('.amx-linkcard').count() === 0, { cardOnLink })
    await caretAfterParagraph(p, 0)
    await p.evaluate(() => { const v = window.__upage.probe.view(); const s = v.state.selection; v.dispatch(v.state.tr.setSelection(s.constructor.create(v.state.doc, s.$from.start()))) })
    await p.keyboard.press('ArrowUp')
    ok('ArrowUp from the paragraph below selects the whole toc block', await p.evaluate(() => { const s = window.__upage.probe.view().state.selection; return !!s.node && s.node.attrs.language === 'toc' }))
    await p.keyboard.type('abc')
    await flush(p)
    saved = await disk(p)
    ok('typing on a selected toc block starts a new line below, source untouched', saved.includes(`${FENCE}\n\nabc\n\n正文。\n`), saved)
    await p.close()

    // ── 折起的小节里的标题:点了先展开再跳 ──────────────────────────────
    p = await open(browser, tocSeed)
    await p.waitForSelector(`${PM} .amx-toc-item`)
    await p.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/src\/amadeus\/unified\/headingFold\.ts(\?|$)/.test(n))
      const { toggleFoldAt } = await import(url || '/src/amadeus/unified/headingFold.ts')
      const v = window.__upage.probe.view()
      let at = null
      v.state.doc.descendants((n, pos) => { if (at == null && n.type.name === 'heading' && n.textContent === '三方分工') at = pos; return at == null })
      toggleFoldAt(v, at)
    })
    await frames(p)
    ok('folding a section keeps its child headings listed', (await texts(p)).includes('研发') && await p.evaluate(() => [...document.querySelectorAll('.unified-body h3')].find((e) => e.textContent === '研发').getBoundingClientRect().height === 0))
    j = await jump(p, '研发')
    ok('clicking a heading inside a folded section unfolds it and jumps', Math.abs(j.off - 12) <= 4, j)
    await p.close()

    // ── 110% 缩放(用户 dev 的缩放):落点与闪光片仍对得上 ─────────────────
    p = await open(browser, tocSeed)
    await p.waitForSelector(`${PM} .amx-toc-item`)
    await p.evaluate(() => { document.documentElement.style.zoom = '1.1' })
    await frames(p)
    j = await jump(p, '风险')
    ok('110% zoom: jump lands at the reading position and the flash covers the heading', j.scrolled > 200 && Math.abs(j.off - 12) <= 4 && Math.abs(j.flashTop - j.headTop) <= 6, j)
    await p.close()

    // ── 只读页:照样显示、能点跳转,没有 `</>` ──────────────────────────
    p = await open(browser, tocSeed, '&uro')
    await p.waitForSelector(`${PM} .amx-toc-item`)
    ok('read-only page lists the headings', (await texts(p)).length === 6)
    ok('read-only page has no </> button', await p.locator(`${PM} .unified-embed .amx-src-btn`).count() === 0)
    j = await jump(p, '研发')
    ok('read-only page: click jumps and flashes', Math.abs(j.off - 12) <= 4, j)
    await p.close()

    // ── 阅读模式:快照里的目录照样能点 ──────────────────────────────────
    p = await open(browser, tocSeed)
    await p.waitForSelector(`${PM} .amx-toc-item`)
    await p.locator('[data-reading-toggle]').click()
    await p.locator('[data-reading-surface] .amx-toc-item').first().waitFor()
    ok('reading mode keeps the toc rows', (await texts(p, '[data-reading-surface]')).length === 6)
    await p.locator('[data-reading-surface] .amx-toc-item').filter({ hasText: '风险' }).click()
    await p.waitForFunction(() => {
      const h = [...document.querySelectorAll('[data-reading-surface] h2')].find((e) => e.textContent === '风险')
      const pane = document.querySelector('.amx-pane')
      return h && Math.abs(h.getBoundingClientRect().top - pane.getBoundingClientRect().top) < 80
    })
    ok('reading mode: clicking a row jumps to the heading', true)
    await p.close()

    // ── 手机:窄屏照样显示,轻点跳转 ───────────────────────────────────
    const touch = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    p = await open(browser, tocSeed, '', touch)
    await p.waitForSelector(`${PM} .amx-toc-item`)
    const box = await p.locator(`${PM} .amx-toc`).boundingBox()
    ok('phone: toc fits the narrow column', box.x >= 0 && box.x + box.width <= 391)
    await p.screenshot({ path: path.join(out, 'phone.png') })
    j = await jump(p, '风险', PM, (loc) => loc.tap())
    ok('phone: tapping a row jumps and flashes', j.scrolled > 200 && Math.abs(j.off - 12) <= 4, j)
    await touch.close()

    ok('no renderer errors', errors.length === 0, errors)
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ checks, errors }, null, 2))
    await browser.close()
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
