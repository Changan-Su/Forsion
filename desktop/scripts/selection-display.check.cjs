// Amadeus 文档选区:文字拖选按字符显示；正文留白拉框按整块显示；行间缝与行尾附近算文字(不起框选)。
// 用法: npm run e2e:editor -- --check=selection-display
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function chromiumPath() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const file = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(file)) return file
    }
  }
  throw new Error('找不到 Chromium')
}

const url = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const shotDir = (process.argv.find((arg) => arg.startsWith('--shot=')) || '').slice('--shot='.length)
if (shotDir) fs.mkdirSync(shotDir, { recursive: true })
const seed = '甲段文字开始结束。\n\n乙段中间文字。\n\n丙段文字开始结束。\n\n- 列表项目甲\n- 列表项目乙\n\n末尾。\n'
const results = []
function check(name, ok, detail) {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  | ${JSON.stringify(detail)}`)
}

async function open(browser, source = seed) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  await page.goto(`${url}?upage&upane&useed=${encodeURIComponent(source)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unified-body .ProseMirror > p', { timeout: 20000 })
  return page
}

async function main() {
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true })
  try {
    const page = await open(browser)
    const points = await page.evaluate(() => {
      const ps = [...document.querySelectorAll('.unified-body .ProseMirror > p')]
      const point = (el, offset) => {
        const range = document.createRange()
        range.setStart(el.firstChild, offset)
        range.setEnd(el.firstChild, offset + 1)
        const r = range.getBoundingClientRect()
        return { x: r.left + 1, y: r.top + r.height / 2 }
      }
      return { start: point(ps[0], 4), end: point(ps[2], 4) }
    })
    await page.mouse.move(points.start.x, points.start.y)
    await page.mouse.down()
    await page.mouse.move(points.end.x, points.end.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(180)
    const text = await page.evaluate(() => {
      const pm = document.querySelector('.unified-body .ProseMirror')
      return {
        selected: window.getSelection()?.toString(),
        whole: pm.querySelectorAll('.amx-block-selected').length,
        mode: pm.getAttribute('data-blocksel'),
      }
    })
    check('文字拖选跨块:按实际字符高亮', text.selected?.includes('乙段中间文字') &&
      !text.selected.startsWith('甲段文字') && !text.selected.endsWith('结束。') &&
      text.whole === 0 && !text.mode, text)
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'text-selection.png') })

    // 起点位于首段本行的文字右侧、但仍在段落 DOM 矩形之内。
    const blank = await page.evaluate(() => {
      const pm = document.querySelector('.unified-body .ProseMirror')
      const ps = [...pm.querySelectorAll(':scope > p')]
      const first = ps[0].getBoundingClientRect()
      const second = ps[1].getBoundingClientRect()
      const text = document.createRange()
      text.selectNodeContents(ps[0])
      const lastGlyph = text.getBoundingClientRect().right
      return { x1: lastGlyph + 40, y1: first.top + first.height / 2, x2: first.left + 8, y2: second.bottom - 2,
        insideBlock: lastGlyph + 40 < first.right }
    })
    await page.mouse.move(blank.x1, blank.y1)
    await page.mouse.down()
    await page.mouse.move(blank.x2, blank.y2, { steps: 10 })
    const during = await page.locator('.amx-marquee').count()
    await page.mouse.up()
    await page.waitForTimeout(180)
    const marquee = await page.evaluate(() => {
      const pm = document.querySelector('.unified-body .ProseMirror')
      return {
        blocks: [...pm.querySelectorAll('.amx-block-selected')].map((el) => el.textContent),
        mode: pm.getAttribute('data-blocksel'),
        focus: pm.contains(document.activeElement),
      }
    })
    check('正文行尾留白拉框:整块选中并保留键盘焦点', blank.insideBlock && during === 1 &&
      marquee.blocks.join('|') === '甲段文字开始结束。|乙段中间文字。' && marquee.mode === 'true' && marquee.focus,
    { blank, during, ...marquee })
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'block-selection.png') })

    // 原生跨块选区穿过列表:列表是已渲染结构，可按整块给反馈，旁边纯文本仍按字符。
    await page.evaluate(() => {
      const v = window.__upage.probe.view()
      const doc = v.state.doc
      const from = 4
      const to = doc.content.size - 3
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(doc, from, to)))
      v.focus()
    })
    const rendered = await page.evaluate(() => {
      const pm = document.querySelector('.unified-body .ProseMirror')
      return {
        list: pm.querySelectorAll('ul.amx-rendered-selected').length,
        plain: pm.querySelectorAll('p.amx-block-selected, p.amx-rendered-selected').length,
        mode: pm.getAttribute('data-blocksel'),
      }
    })
    check('跨块文字选区经过列表:结构块可整体着色，纯文本不整块着色',
      rendered.list === 1 && rendered.plain === 0 && !rendered.mode, rendered)
    await page.close()

    const single = await open(browser)
    const one = await single.evaluate(() => {
      const p = document.querySelector('.unified-body .ProseMirror > p')
      const r = p.getBoundingClientRect()
      const text = document.createRange()
      text.selectNodeContents(p)
      return { x1: text.getBoundingClientRect().right + 40, y1: r.top + r.height / 2,
        x2: r.left + 5, y2: r.top + r.height / 2 }
    })
    await single.mouse.move(one.x1, one.y1)
    await single.mouse.down()
    await single.mouse.move(one.x2, one.y2, { steps: 8 })
    await single.mouse.up()
    await single.waitForTimeout(120)
    const beforeDelete = await single.evaluate(() => ({
      marked: document.querySelectorAll('.unified-body .ProseMirror > p.amx-block-selected, .unified-body .ProseMirror > p.ProseMirror-selectednode').length,
      first: document.querySelector('.unified-body .ProseMirror > p')?.textContent,
    }))
    await single.keyboard.press('Backspace')
    const afterDelete = await single.evaluate(() => [...document.querySelectorAll('.unified-body .ProseMirror > p')].map((p) => p.textContent))
    check('留白框住单块:整块着色且 Delete 删除节点', beforeDelete.marked === 1 &&
      beforeDelete.first === '甲段文字开始结束。' && !afterDelete.includes('甲段文字开始结束。') &&
      afterDelete[0] === '乙段中间文字。', { beforeDelete, afterDelete })
    await single.close()

    const widgets = await open(browser, '开头文字。\n\n前文 [[Example]] 后文。\n\n![[table.db]]\n\n尾段文字。\n')
    await widgets.evaluate(() => {
      const v = window.__upage.probe.view()
      const doc = v.state.doc
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(doc, 3, doc.content.size - 3)))
      v.focus()
    })
    const special = await widgets.evaluate(() => {
      const pm = document.querySelector('.unified-body .ProseMirror')
      const links = [...pm.querySelectorAll('.wikilink')].filter((el) => el.getClientRects().length)
      return {
        link: links.length,
        linkSelected: links.filter((el) => el.hasAttribute('data-range-selected')).length,
        embed: pm.querySelectorAll('.unified-embed-host.amx-rendered-selected').length,
        plain: pm.querySelectorAll('p.amx-rendered-selected:not(.unified-embed-host)').length,
      }
    })
    check('跨块文字选区经过双链和数据库:渲染内容有选中反馈',
      special.link === 1 && special.linkSelected === 1 && special.embed === 1 && special.plain === 0, special)
    if (shotDir) await widgets.screenshot({ path: path.join(shotDir, 'rendered-selection.png') })
    await widgets.close()

    const imageSource = '开头。\n\n![示意](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==)\n\n结尾。\n'
    const imagePage = await open(browser, imageSource)
    await imagePage.evaluate(() => {
      const v = window.__upage.probe.view()
      const doc = v.state.doc
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(doc, 3, doc.content.size - 3)))
      v.focus()
    })
    const imageState = await imagePage.evaluate(() => ({
      images: document.querySelectorAll('.unified-body .wiki-inline-img-wrap').length,
      selected: document.querySelectorAll('.unified-body .wiki-inline-img-wrap[data-range-selected]').length,
      plain: document.querySelectorAll('.unified-body .ProseMirror > p.amx-block-selected').length,
    }))
    check('跨块文字选区经过 Markdown 图片:图片有选中环且文字不整块染色',
      imageState.images === 1 && imageState.selected === 1 && imageState.plain === 0, imageState)
    await imagePage.close()

    // ── 跨行拖选不被当成框选(2026-10-13 用户实报:「abcd"efg⏎hijklm" 选不准,一选就整个块选中」)──
    // 字形盒比行高矮(27px 行高里 18px),按在两行之间那条缝里、或行尾右侧几个像素,以前算「块内留白」,
    // 一拖就起了框选。每条都开新页:同一处连按两次会被浏览器当成双击(按词选),量出来的是另一回事。
    // 最后一组在界面缩放 110% 下再量一遍(行高是未缩放的 px、矩形是视口坐标,换算错了只在缩放下露出来)。
    const dragOnce = async (source, zoom, pick) => {
      const page = await open(browser, source)
      if (zoom !== 1) await page.evaluate((z) => { document.body.style.zoom = String(z) }, zoom)
      await page.waitForTimeout(200)
      const g = await page.evaluate(pick)
      await page.mouse.move(g.x1, g.y1)
      await page.mouse.down()
      await page.mouse.move((g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2, { steps: 6 })
      await page.mouse.move(g.x2, g.y2, { steps: 6 })
      const during = await page.locator('.amx-marquee').count()
      const box = await page.evaluate(() => {
        const m = document.querySelector('.amx-marquee')
        if (!m) return null
        const r = m.getBoundingClientRect(), cs = getComputedStyle(m)
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, position: cs.position, bg: cs.backgroundColor }
      })
      await page.mouse.up()
      await page.waitForTimeout(160)
      const out = await page.evaluate(() => {
        const pm = document.querySelector('.unified-body .ProseMirror')
        const sel = window.__upage.probe.view().state.selection
        return {
          text: window.getSelection()?.toString(),
          kind: sel.constructor.name.replace(/^_/, ''),
          whole: pm.querySelectorAll('.amx-block-selected, .ProseMirror-selectednode').length,
          mode: pm.getAttribute('data-blocksel'),
        }
      })
      await page.close()
      return { during, box, ...out, ...g }
    }
    /** 第 index 段第 offset 个字的矩形(offset < 0 从末尾数)。 */
    const glyph = `(index, offset) => {
      const p = [...document.querySelectorAll('.unified-body .ProseMirror > p')][index]
      const len = p.firstChild.textContent.length
      const o = offset < 0 ? len + offset : offset
      const r = document.createRange()
      r.setStart(p.firstChild, o)
      r.setEnd(p.firstChild, o + 1)
      return r.getBoundingClientRect()
    }`
    const twoParas = 'abcdefg\n\nhijklm\n\n尾段。\n'
    const wrapped = `${'春眠不觉晓处处闻啼鸟夜来风雨声花落知多少'.repeat(8)}\n\n尾段。\n`
    for (const zoom of [1, 1.1]) {
      const tag = zoom === 1 ? '' : `(界面缩放 ${Math.round(zoom * 100)}%)`
      // 末字右侧 8px 按下,往回拖到上一段的 d|e 之间
      const back = await dragOnce(twoParas, zoom, `(() => {
        const glyph = ${glyph}
        const e = glyph(0, 4), m = glyph(1, -1)
        return { x1: m.right + 8, y1: (m.top + m.bottom) / 2, x2: e.left + 1, y2: (e.top + e.bottom) / 2 }
      })()`)
      check(`从行尾往回拖到上一段行中:按字符选中,不起框选${tag}`,
        back.during === 0 && back.kind === 'TextSelection' && back.text === 'efg\n\nhijklm' && back.whole === 0 && !back.mode, back)
      // 字形盒上缘上方 3px(仍在这一行的行高里)按下,拖到下一段末字
      const lead = await dragOnce(twoParas, zoom, `(() => {
        const glyph = ${glyph}
        const e = glyph(0, 4), m = glyph(1, -1)
        return { x1: e.left + 1, y1: e.top - 3, x2: m.right - 1, y2: (m.top + m.bottom) / 2 }
      })()`)
      check(`按在字的上沿之外(行高之内)往下拖:按字符选中,不起框选${tag}`,
        lead.during === 0 && lead.kind === 'TextSelection' && lead.text === 'efg\n\nhijklm' && lead.whole === 0 && !lead.mode, lead)
      // 折成多行的一段:按在第 1、2 行之间的缝里,拖到第 3 行
      const gap = await dragOnce(wrapped, zoom, `(() => {
        const p = document.querySelector('.unified-body .ProseMirror > p')
        const r = document.createRange()
        r.selectNodeContents(p)
        const [l1, l2, l3] = [...r.getClientRects()]
        return { x1: l1.left + 120, y1: (l1.bottom + l2.top) / 2, x2: l3.left + 300, y2: (l3.top + l3.bottom) / 2,
          lines: r.getClientRects().length, gapPx: Math.round((l2.top - l1.bottom) * 10) / 10, full: p.textContent.length }
      })()`)
      check(`折行的段落里按在两行之间的缝上拖选:按字符选中,不把整段选成块${tag}`,
        gap.lines >= 3 && gap.gapPx >= 4 && gap.during === 0 && gap.kind === 'TextSelection' &&
        gap.text.length > 10 && gap.text.length < gap.full && gap.whole === 0 && !gap.mode,
        { ...gap, text: `${gap.text.slice(0, 6)}…(${gap.text.length} 字)` })
      // 行尾远处的留白仍然起框选 —— 那个矩形得看得见、且就画在指针拖过的那一块上。
      // (它挂在 body 上:样式选择器曾带着 `.am-app` 整条不命中,矩形没定位没底色;坐标也没除界面缩放。)
      const far = await dragOnce(twoParas, zoom, `(() => {
        const glyph = ${glyph}
        const g = glyph(0, -1), m = glyph(1, 0)
        return { x1: g.right + 90, y1: (g.top + g.bottom) / 2, x2: m.left + 20, y2: m.bottom + 6 }
      })()`)
      const b = far.box
      const near = (a, c) => Math.abs(a - c) <= 2
      check(`行尾远处留白拉框:矩形看得见,且贴着指针拖过的范围${tag}`,
        far.during === 1 && !!b && b.position === 'fixed' && !/rgba\(0, 0, 0, 0\)|transparent/.test(b.bg) &&
        near(b.left, Math.min(far.x1, far.x2)) && near(b.right, Math.max(far.x1, far.x2)) &&
        near(b.top, Math.min(far.y1, far.y2)) && near(b.bottom, Math.max(far.y1, far.y2)) && far.whole === 2,
        far)
    }
  } finally {
    await browser.close()
  }
  if (results.some((ok) => !ok)) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
