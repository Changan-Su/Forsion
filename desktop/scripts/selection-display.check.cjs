// Amadeus 文档选区:文字拖选按字符显示；正文留白拉框按整块显示。
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
  } finally {
    await browser.close()
  }
  if (results.some((ok) => !ok)) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
