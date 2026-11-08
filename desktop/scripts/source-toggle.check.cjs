// 「查看源码」`</>` 按钮回归(2026-07-31)。
// 契约:渲染出来的块(公式 / 图片·PDF·文件嵌入 / 插件嵌入)悬停浮现一颗 `</>`;点它 → 露出该处的
// 字面源码可编辑;光标离开那片区域 → 复渲染。不悬停时按钮必须**不吃点击**(pointer-events:none),
// 否则会盖住下面的内容 —— 这条纯 CSS,只有真浏览器量得到。
//
// 用法:1) desktop 仓 `npm run web`  2) `npm run check:srcbtn`
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
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const btnState = (p, sel) =>
  p.evaluate((s) => {
    const b = document.querySelector(s)
    if (!b) return null
    const cs = getComputedStyle(b)
    const r = b.getBoundingClientRect()
    return { opacity: +cs.opacity, pe: cs.pointerEvents, w: Math.round(r.width), text: b.textContent }
  }, sel)

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const open = async (query) => {
    const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 600 } })
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${URL}?${query}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.md-block .ProseMirror, .block-host, .unified-body .ProseMirror', { timeout: 20000 })
    await p.waitForTimeout(600)
    return p
  }

  // ── 行内:块级公式 $$…$$ ──
  let p = await open(`seed=${encodeURIComponent('前面一句\n\n$$\\frac{1}{2}$$\n\n后面一句')}`)
  check('S1 块级公式渲染出 KaTeX', (await p.locator('.math-rendered--block .katex').count()) > 0)
  let b = await btnState(p, '.math-rendered--block .amx-src-btn:not(.amx-src-btn--copy)')
  check('S1 公式上挂了 `</>` 按钮', !!b && b.text === '</>', JSON.stringify(b))
  check('S1 不悬停时透明且不吃点击', !!b && b.opacity === 0 && b.pe === 'none', JSON.stringify(b))
  await p.hover('.math-rendered--block')
  await p.waitForTimeout(300)
  b = await btnState(p, '.math-rendered--block .amx-src-btn:not(.amx-src-btn--copy)')
  check('S1 悬停后浮现且可点', !!b && b.opacity === 1 && b.pe === 'auto', JSON.stringify(b))
  // 复制键:同一排、在 `</>` 左边,一起浮现
  const cp = await p.evaluate(() => {
    const host = document.querySelector('.math-rendered--block')
    const c = host?.querySelector(':scope > .amx-src-btn--copy'), s = host?.querySelector(':scope > .amx-src-btn:not(.amx-src-btn--copy)')
    if (!c || !s) return null
    const rc = c.getBoundingClientRect(), rs = s.getBoundingClientRect()
    return { left: rc.right <= rs.left, sameRow: Math.abs(rc.top - rs.top) < 2, opacity: Number(getComputedStyle(c).opacity) }
  })
  check('S1 复制键在 `</>` 左边、同排、同时浮现', !!cp && cp.left && cp.sameRow && cp.opacity === 1, JSON.stringify(cp))

  // 点它 → 源码露出(该行的公式装饰撤掉,字面 $$…$$ 可见),且光标落在源码里
  await p.click('.math-rendered--block .amx-src-btn:not(.amx-src-btn--copy)')
  await p.waitForTimeout(350)
  const after = await p.evaluate(() => {
    const s = window.getSelection()
    const r = s && s.rangeCount ? s.getRangeAt(0) : null
    return {
      stillRendered: document.querySelectorAll('.math-rendered--block').length,
      caretText: r ? (r.startContainer.textContent || '').slice(0, 24) : null,
      text: document.querySelector('.md-block .ProseMirror').textContent,
    }
  })
  check('S2 点 `</>` 后公式回到源码态', after.stillRendered === 0, JSON.stringify(after))
  check('S2 光标落在公式源码里', !!after.caretText && after.caretText.includes('frac'), JSON.stringify(after.caretText))

  // 光标离开这一行 → 复渲染(「离开才复渲染」是这条特性的后半句)。
  // ⚠️ 必须点到**别的段落**:实况预览是按「光标所在行」判的,点回同一行等于没走。
  await p.locator('.md-block .ProseMirror > p').last().click()
  await p.waitForTimeout(400)
  check(
    'S3 光标离开该行 → 自动复渲染',
    (await p.locator('.math-rendered--block .katex').count()) > 0,
    `rendered=${await p.locator('.math-rendered--block').count()}`
  )
  await p.close()

  // ── 行内:混在文字里的图片嵌入 `![[pic.png]]` ──
  // ⚠️ 图片行不能是最后一行:harness 默认把光标放在文末,同一行会露源码而不渲染(设计如此)。
  p = await open(`seed=${encodeURIComponent('文字 ![[pic.png]] 更多文字\n\n最后一行')}`)
  check('S4 行内图片渲染成 <img>', (await p.locator('.wiki-inline-img').count()) === 1)
  b = await btnState(p, '.wiki-inline-img-wrap .amx-src-btn')
  check('S4 行内图片挂了 `</>`', !!b && b.text === '</>', JSON.stringify(b))
  check('S4 不悬停时不吃点击', !!b && b.pe === 'none', JSON.stringify(b))
  await p.close()

  // ── 块级:整块嵌入(图片 / PDF)由 BlockHost 画按钮 ──
  p = await open('embed')
  const blocks = await p.evaluate(() =>
    [...document.querySelectorAll('.block-host')].map((h) => ({
      embed: h.hasAttribute('data-embed'),
      btn: !!h.querySelector(':scope > .amx-src-btn:not(.amx-open-btn)'),
    }))
  )
  check('S5 嵌入块都有 `</>`,普通文字块没有', blocks.length >= 3 && blocks.filter((x) => x.embed).every((x) => x.btn) && blocks.filter((x) => !x.embed).every((x) => !x.btn), JSON.stringify(blocks))
  const first = '.block-host[data-embed]'
  b = await btnState(p, `${first} > .amx-src-btn:not(.amx-open-btn)`)
  check('S5 不悬停时透明且不吃点击', !!b && b.opacity === 0 && b.pe === 'none', JSON.stringify(b))
  await p.hover(first)
  await p.waitForTimeout(300)
  b = await btnState(p, `${first} > .amx-src-btn:not(.amx-open-btn)`)
  check('S5 悬停后浮现(.block-host[data-embed]:hover 选择器真的命中)', !!b && b.opacity === 1 && b.pe === 'auto', JSON.stringify(b))

  // 点它 → 进源码行(可编辑 input),失焦 → 退出
  await p.click(`${first} > .amx-src-btn:not(.amx-open-btn)`)
  await p.waitForTimeout(350)
  check('S6 点 `</>` 进源码编辑行', (await p.locator('.embed-src-input').count()) === 1, `count=${await p.locator('.embed-src-input').count()}`)
  const val = await p.locator('.embed-src-input').inputValue()
  check('S6 源码行内容 = 该块原文', val.includes('![['), JSON.stringify(val))
  await p.keyboard.press('Escape')
  await p.waitForTimeout(350)
  check('S6 离开后退出源码态(复渲染)', (await p.locator('.embed-src-input').count()) === 0)
  await p.close()

  // ── v4 文件引用嵌入(通用附件):光标进到那一行 = 源码露在嵌入体上方、嵌入体不让位(2026-10-13 用户定,Obsidian 的光标逻辑;
  //    此前是「难源码编辑块」,只有 `</>` 能开门、开了整块让位)。`</>` 仍在,等于把光标送进源码。细节在 check:embedsource。──
  p = await open(`upage&useed=${encodeURIComponent('前一段\n\n![[archive.zip]]\n\n后一段\n')}`)
  await p.waitForSelector('.unified-embed')
  const hard = await p.evaluate(() => {
    const view = window.__upage.probe.view()
    let at = -1
    view.state.doc.descendants((n, pos) => {
      if (at < 0 && n.isTextblock && n.textContent === '![[archive.zip]]') at = pos
      return at < 0
    })
    const Sel = view.state.selection.constructor
    view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, at + 3)))
    view.focus()
    return { at }
  })
  await p.waitForTimeout(250)
  const entered = await p.evaluate(() => ({ embed: !!document.querySelector('.unified-embed'), src: document.querySelector('.unified-body .ProseMirror')?.innerText ?? '' }))
  check('S7 光标进到附件那一行:源码露出来、嵌入体仍在', hard.at >= 0 && entered.embed && entered.src.includes('![[archive.zip]]'), JSON.stringify({ ...hard, ...entered }))
  await p.locator('.unified-body .ProseMirror > p').last().click()
  await p.waitForTimeout(350)
  const left = await p.evaluate(() => ({ embed: !!document.querySelector('.unified-embed'), src: document.querySelector('.unified-body .ProseMirror')?.innerText ?? '' }))
  check('S7 光标离开后源码收起、嵌入体仍在', left.embed && !left.src.includes('![[archive.zip]]'), JSON.stringify(left))
  b = await btnState(p, '.unified-embed > .amx-src-btn')
  check('S7 v4 通用附件挂着源码入口 `</>`', !!b && b.text === '</>' && b.pe === 'none', JSON.stringify(b))
  await p.hover('.unified-embed')
  await p.click('.unified-embed > .amx-src-btn')
  await p.waitForTimeout(350)
  const opened = await p.evaluate(() => ({ embed: !!document.querySelector('.unified-embed'), text: document.querySelector('.unified-body .ProseMirror')?.innerText ?? '' }))
  check('S7 点 `</>` = 光标进源码(源码露出、嵌入体不让位)', opened.embed && opened.text.includes('![[archive.zip]]'), JSON.stringify(opened))
  await p.locator('.unified-body .ProseMirror > p').last().click()
  await p.waitForTimeout(350)
  check('S7 光标离开源码后只剩一份嵌入体', (await p.locator('.unified-embed').count()) === 1)
  await p.close()

  // ── v4 附件嵌入的「打开」键(11-07):排在 `</>` 左边、悬停浮现;点 = 与点双链同一口径(文件开在旁边),⌘/Ctrl+点 = 新标签页 ──
  const spyOpen = (pg) => pg.evaluate(() => {
    window.__opened = []
    window.__pageStore.setState({ openWikiLink: (name, src, o) => { window.__opened.push({ name, o: o ?? null }) } })
  })
  p = await open(`upage&useed=${encodeURIComponent('前一段\n\n![[report.pdf]]\n\n![[pic.png]]\n\n后一段\n')}`)
  await p.waitForSelector('.unified-embed')
  await spyOpen(p)
  const ob = await p.evaluate(() => {
    const host = document.querySelector('.unified-embed')
    const kids = [...host.querySelectorAll(':scope > .amx-src-btn')]
    return { n: kids.length, first: kids[0]?.textContent, open: !!host.querySelector(':scope > .amx-open-btn.amx-src-btn--block') }
  })
  check('S8 PDF 嵌入挂了「打开」+ `</>` 两颗,第一颗仍是 `</>`', ob.n === 2 && ob.first === '</>' && ob.open, JSON.stringify(ob))
  b = await btnState(p, '.unified-embed > .amx-open-btn')
  check('S8 「打开」不悬停时不吃点击', !!b && b.pe === 'none', JSON.stringify(b))
  await p.hover('.unified-embed')
  await p.waitForTimeout(300)
  const geo = await p.evaluate(() => {
    const o = document.querySelector('.unified-embed > .amx-open-btn').getBoundingClientRect()
    const s = document.querySelector('.unified-embed > .amx-src-btn:not(.amx-open-btn)').getBoundingClientRect()
    return { oRight: Math.round(o.right), sLeft: Math.round(s.left), sameRow: Math.abs(o.top - s.top) < 1, op: +getComputedStyle(document.querySelector('.unified-embed > .amx-open-btn')).opacity }
  })
  check('S8 悬停浮现,排在 `</>` 左边同一行不重叠', geo.op === 1 && geo.sameRow && geo.oRight <= geo.sLeft, JSON.stringify(geo))
  await p.click('.unified-embed > .amx-open-btn')
  await p.click('.unified-embed > .amx-open-btn', { modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  let opened8 = await p.evaluate(() => window.__opened)
  check('S8 点「打开」= 开在旁边;⌘/Ctrl+点 = 新标签页', opened8.length === 2 && opened8[0].name === 'report.pdf' && opened8[0].o?.split === true && opened8[1].o?.newTab === true, JSON.stringify(opened8))
  const stay = await p.evaluate(() => ({ text: document.querySelector('.unified-body .ProseMirror')?.innerText ?? '' }))
  check('S8 点「打开」不露源码、不改选区', !stay.text.includes('![[report.pdf]]'), JSON.stringify(stay))
  await p.evaluate(() => { window.__opened = [] })
  await p.hover('.wiki-inline-img-wrap')
  await p.waitForTimeout(300)
  const imgBtns = await p.evaluate(() => [...document.querySelectorAll('.wiki-inline-img-wrap > .amx-src-btn')].map((x) => x.classList.contains('amx-open-btn') ? 'open' : x.textContent))
  check('S8 图片也挂「打开」,第一颗仍是 `</>`', imgBtns.length === 2 && imgBtns[0] === '</>' && imgBtns[1] === 'open', JSON.stringify(imgBtns))
  await p.click('.wiki-inline-img-wrap > .amx-open-btn')
  opened8 = await p.evaluate(() => window.__opened)
  check('S8 点图片的「打开」→ openWikiLink(pic.png)', opened8.length === 1 && opened8[0].name === 'pic.png', JSON.stringify(opened8))
  await p.close()

  // 只读(分享页形态):没有 `</>`,「打开」独占右上角
  p = await open(`upage&uro&useed=${encodeURIComponent('前一段\n\n![[report.pdf]]\n\n后一段\n')}`)
  await p.waitForSelector('.unified-embed')
  const ro = await p.evaluate(() => {
    const host = document.querySelector('.unified-embed')
    const kids = [...host.querySelectorAll(':scope > .amx-src-btn')]
    const o = host.querySelector(':scope > .amx-open-btn')
    return { n: kids.length, solo: !!o?.classList.contains('amx-src-btn--solo'), gap: o ? Math.round(host.getBoundingClientRect().right - o.getBoundingClientRect().right) : null }
  })
  check('S9 只读:只有「打开」一颗、靠最右', ro.n === 1 && ro.solo && ro.gap !== null && ro.gap <= 8, JSON.stringify(ro))
  await p.close()

  // ── 11-07 后续五条(方案页 docs/ToBeImproved/附件嵌入打开键方案_2026-11-07,用户「都按建议做」)──
  const IMGURL = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#8fa9c9"/></svg>').toString('base64')
  {
    const pg = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 900 } })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    // 只给图片换成能加载的图(PDF 走原路径,别被当成图)
    await pg.addInitScript((img) => {
      let v
      Object.defineProperty(window, '__assets', { configurable: true, get: () => v, set: (n) => { v = n; n.setUrlBuilder((ref, exact) => /\.(png|jpe?g|gif|webp|svg)$/i.test(ref) ? img : 'about:blank') } })
    }, IMGURL)
    const seed = '前一段\n\n![[report.pdf]]\n\n![[archive.zip]]\n\n![[https://example.com/a]]\n\n图标 ![[dot.png|22]] 和大图 ![[big.png|200]] 在这里\n\n后一段\n'
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector('.unified-embed .embed-file')
    await pg.waitForTimeout(800)
    await pg.evaluate(() => {
      const st = window.__pageStore.getState()
      window.__pageStore.setState({ files: [...new Set([...(st.files || []), 'report.pdf', 'archive.zip'])] })
      window.__opened = []
      window.__pageStore.setState({ openWikiLink: (name, src, o) => { window.__opened.push({ name, o: o ?? null }) } })
    })
    const hosts = '.unified-body .unified-embed'
    // 1A:卡里不再有「打开 ↗」;文件卡整张点击 = 同一个打开
    const inline = await pg.evaluate(() => ({
      head: [...document.querySelectorAll('.embed-media-head .embed-media-btn')].map((b) => b.textContent),
      cardOpen: !!document.querySelector('.embed-file .embed-file-open'),
    }))
    check('S10 PDF 标题行只剩「收起」,文件卡不写「打开 ↗」', inline.head.length === 1 && !inline.cardOpen, JSON.stringify(inline))
    await pg.click('.unified-embed .embed-file')
    let op = await pg.evaluate(() => window.__opened.splice(0))
    check('S10 点文件卡 = 和「打开」键同一条路(开在旁边)', op.length === 1 && op[0].name === 'archive.zip' && op[0].o?.split === true, JSON.stringify(op))
    // 2A:外壳收到卡片宽,两颗键在卡片右端、竖直居中、不压文件名
    await pg.hover('.unified-embed .embed-file')
    await pg.waitForTimeout(300)
    const g = await pg.evaluate(() => {
      const card = document.querySelector('.unified-embed .embed-file')
      const host = card.closest('.unified-embed')
      const r = (e) => e.getBoundingClientRect()
      const c = r(card), h = r(host), o = r(host.querySelector(':scope > .amx-open-btn')), sb = r(host.querySelector(':scope > .amx-src-btn:not(.amx-open-btn)')), n = r(card.querySelector('.embed-file-name'))
      return { hostVsCard: Math.round(h.width - c.width), inside: o.left >= c.left && sb.right <= c.right + 0.5, mid: Math.abs((o.top + o.bottom) / 2 - (c.top + c.bottom) / 2) < 1.5, nameClear: n.right <= o.left }
    })
    check('S11 小文件卡:外壳=卡宽,键在卡里右端竖直居中、不压文件名', g.hostVsCard <= 1 && g.inside && g.mid && g.nameClear, JSON.stringify(g))
    // 3A:右键文件卡 = 链接菜单(含复制路径、编辑链接);块层不弹块菜单
    await pg.click('.unified-embed .embed-file', { button: 'right' })
    await pg.waitForTimeout(300)
    const m1 = await pg.evaluate(() => [...document.querySelectorAll('.amx-link-menu button')].map((b) => b.dataset.act))
    check('S12 右键文件卡弹链接菜单(复制路径 + 编辑链接)', m1.includes('copypath') && m1.includes('edit'), JSON.stringify(m1))
    await pg.click('.amx-link-menu [data-act="edit"]')
    await pg.waitForTimeout(300)
    const srcShown = await pg.evaluate(() => document.querySelector('.unified-body .ProseMirror').innerText.includes('![[archive.zip]]'))
    check('S12 菜单「编辑链接」= 露源码', srcShown)
    await pg.locator('.unified-body .ProseMirror > p').last().click()
    await pg.waitForTimeout(300)
    // 4A:网页嵌入有「在浏览器中打开」;外链箭头不挂在卡上 / 藏起来的源码链接上
    const web = await pg.evaluate((sel) => {
      const h = [...document.querySelectorAll(sel)].find((x) => x.querySelector('.amx-web'))
      const ob = h?.querySelector(':scope > .amx-open-btn')
      const after = (el) => el ? getComputedStyle(el, '::after').content : null
      const hidden = h?.closest('p')?.querySelector('a:has(> .wikilink-src-hidden)')
      return { open: ob?.title ?? null, card: after(h?.querySelector('a.amx-bm')), hidden: after(hidden), hasHidden: !!hidden }
    }, hosts)
    check('S13 网页嵌入挂「在浏览器中打开」,卡与隐藏源码链接都不挂 ↗', web.open === '在浏览器中打开' && web.card === 'none' && (!web.hasHidden || web.hidden === 'none'), JSON.stringify(web))
    await pg.evaluate((sel) => { [...document.querySelectorAll(sel)].find((x) => x.querySelector('.amx-web')).querySelector(':scope > .amx-open-btn').click() }, hosts)
    op = await pg.evaluate(() => window.__opened.splice(0))
    check('S13 点它 → openWikiLink(网址)', op.length === 1 && op[0].name === 'https://example.com/a', JSON.stringify(op))
    const wb = await pg.evaluate((sel) => [...document.querySelectorAll(sel)].find((x) => x.querySelector('.amx-web')).getBoundingClientRect().toJSON(), hosts)
    await pg.mouse.click(wb.right - 60, wb.top + 30, { button: 'right' })
    await pg.waitForTimeout(300)
    const m2 = await pg.evaluate(() => [...document.querySelectorAll('.amx-link-menu button')].map((b) => b.dataset.act))
    check('S13 右键网页嵌入:浏览器 / 复制链接 / 编辑链接', m2.join(',') === 'browser,copylink,edit', JSON.stringify(m2))
    await pg.keyboard.press('Escape')
    // 附件丢了:嵌入的右键菜单不给「创建笔记」(否则建出一篇叫 `gone.zip` 的笔记),只剩「编辑链接」
    await pg.evaluate(() => { const st = window.__pageStore.getState(); window.__pageStore.setState({ files: st.files.filter((f) => f !== 'archive.zip') }) })
    await pg.click('.unified-embed .embed-file', { button: 'right' })
    await pg.waitForTimeout(300)
    const m3 = await pg.evaluate(() => [...document.querySelectorAll('.amx-link-menu button')].map((b) => b.dataset.act))
    check('S13b 附件丢了:嵌入菜单只有「编辑链接」,没有「创建笔记」', m3.join(',') === 'edit', JSON.stringify(m3))
    await pg.keyboard.press('Escape')
    // 5A:显示宽 < 80px 的图只留缩小版 `</>`;大图两颗都在
    const tiny = await pg.evaluate(() => [...document.querySelectorAll('.wiki-inline-img-wrap')].map((w) => ({
      w: Math.round(w.querySelector('img').getBoundingClientRect().width),
      tiny: w.classList.contains('amx-img-tiny'),
      open: getComputedStyle(w.querySelector('.amx-open-btn')).display,
      srcH: Math.round(w.querySelector('.amx-src-btn:not(.amx-open-btn)').getBoundingClientRect().height),
    })))
    const small = tiny.find((x) => x.w === 22), big = tiny.find((x) => x.w === 200)
    check('S14 22px 图只留 16px 高的 `</>`,200px 图两颗都在', !!small && small.tiny && small.open === 'none' && small.srcH === 16 && !!big && !big.tiny && big.open !== 'none', JSON.stringify(tiny))
    await pg.close()
  }

  const fails = results.filter((r) => !r).length
  console.log(`\n${results.length - fails}/${results.length} passed, ${fails} failed`)
  await browser.close()
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e)
  process.exit(1)
})
