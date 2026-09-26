// Production UnifiedPage regression for toggle motion, page-end scroll stability, and title carets.
// npm run e2e:editor -- --check=toggle-motion
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const FOLD = '.unified-body .ProseMirror > blockquote.callout-fold'
const HEAD = `${FOLD} > p:first-child`
const ARROW = `${HEAD} > .callout-chevron`
const checks = []
function check(name, ok, detail = '') {
  checks.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}
function chromiumPath() {
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing', 'Chromium']) {
      const p = path.join(root, dir, 'chrome-mac-arm64', `${app}.app/Contents/MacOS/${app}`)
      if (fs.existsSync(p)) return p
    }
  throw new Error('Chromium missing')
}
async function main() {
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true })
  const errors = []
  try {
    const prefix = Array.from({ length: 20 }, (_, i) => `前文 ${i} 一段内容`).join('\n\n')
    const seed = `${prefix}\n\n> [!fold]+ 标题123\n>\n> 正文第一行\n>\n> 正文第二行\n>\n> 正文第三行\n\n后文一段内容`
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: 'zh-CN' })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${URL}?upage&upane&caret&useed=${encodeURIComponent(seed)}`)
    await page.locator(ARROW).waitFor()
    await page.waitForTimeout(1700) // UnifiedPage may restore saved scroll for up to 1.5s.
    await page.evaluate(() => { const pane = document.querySelector('.amx-pane'); pane.scrollTop = pane.scrollHeight })
    await page.waitForTimeout(100)
    const sample = async () => page.evaluate(async () => {
      const pane = document.querySelector('.amx-pane')
      const arrow = document.querySelector('.unified-body .callout-fold > p:first-child .callout-chevron')
      const read = () => {
        const title = document.querySelector('.unified-body .callout-fold > p:first-child')
        const body = document.querySelector('.unified-body .callout-fold > p:nth-child(2)')
        return {
          top: pane.scrollTop, title: title.getBoundingClientRect().top,
          height: body.getBoundingClientRect().height, display: getComputedStyle(body).display,
          overflow: getComputedStyle(body).overflow,
          attr: title.parentElement.hasAttribute('data-fold-animating'),
          special: body.matches('blockquote.callout-fold.callout-collapsed[data-fold-animating] > *:not(:first-child)'),
          angle: getComputedStyle(title.querySelector('.callout-chevron svg')).transform,
        }
      }
      const frames = [read()]
      arrow.click()
      frames.push(read())
      const began = performance.now()
      while (performance.now() - began < 245) {
        await new Promise(requestAnimationFrame)
        frames.push(read())
      }
      return frames
    })
    const close = await sample()
    const atEnd = close[0]
    check('页尾收起期间滚动位置与标题位置稳定',
      close.every((f) => Math.abs(f.top - atEnd.top) < 1 && Math.abs(f.title - atEnd.title) < 1),
      { before: atEnd, after: close.at(-1) })
    check('收起正文有中间高度并最终真正隐藏',
      close.some((f) => f.height > 0 && f.height < atEnd.height) && close.at(-1).display === 'none',
      close.map((f) => [Math.round(f.height * 10) / 10, f.display, f.attr, f.special]))
    check('三角在收起时旋转', close.some((f) => f.angle !== atEnd.angle && f.angle !== close.at(-1).angle))
    const open = await sample()
    check('展开期间滚动位置与标题位置稳定',
      open.every((f) => Math.abs(f.top - atEnd.top) < 1 && Math.abs(f.title - atEnd.title) < 1),
      { before: atEnd, after: open.at(-1) })
    check('正文逐步展开并恢复可溢出的子内容',
      open.some((f) => f.height > 0 && f.height < open.at(-1).height)
      && open.at(-1).height > 0 && open.at(-1).overflow === 'visible')
    check('三角在展开时旋转', open.some((f) => f.angle !== open[0].angle && f.angle !== open.at(-1).angle))

    const point = await page.locator(HEAD).evaluate((title) => {
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        if (node.parentElement.closest('button,.callout-syntax')) continue
        const r = document.createRange(); r.setStart(node, 0); r.setEnd(node, 1)
        const b = r.getBoundingClientRect()
        return { x: b.left + 0.1, y: b.top + b.height / 2 }
      }
    })
    await page.mouse.click(point.x, point.y)
    const caret = async () => page.evaluate(() => {
      const s = document.getSelection(), r = s.getRangeAt(0).getClientRects()[0]
      const overlay = document.querySelector('.sc-caret')
      const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(overlay?.style.transform || '')
      const view = window.__upage?.probe?.view?.()
      return { text: s.anchorNode?.textContent, offset: s.anchorOffset,
        pmPos: view?.state.selection.from,
        rect: r && { x: r.x, y: r.y, h: r.height },
        overlay: match && { x: Number(match[1]), y: Number(match[2]), h: parseFloat(overlay.style.height) } }
    })
    await page.waitForTimeout(130)
    const clicked = await caret()
    check('首字前原生光标有正常高度', clicked.text === '标题123' && clicked.offset === 0 && clicked.rect?.h > 10, clicked)
    check('首字前丝滑光标与原生位置重合', clicked.overlay
      && Math.abs(clicked.overlay.x - clicked.rect.x) <= 1 && Math.abs(clicked.overlay.y - clicked.rect.y) <= 1, clicked)
    const emptySeed = '> [!fold]+ \n\n后续段落'
    const empty = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: 'zh-CN' })
    empty.on('pageerror', (e) => errors.push(e.message))
    await empty.goto(`${URL}?upage&upane&caret&useed=${encodeURIComponent(emptySeed)}`)
    await empty.locator('.callout-toggle-title').click({ position: { x: 45, y: 12 } })
    await empty.waitForTimeout(130)
    const emptySmooth = await empty.evaluate(() => {
      const title = document.querySelector('.callout-toggle-title'), sc = document.querySelector('.sc-caret')
      const b = title.getBoundingClientRect()
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(sc.style.transform)
      return { x: b.x, y: b.y, h: b.height, caret: title.hasAttribute('data-empty-caret'),
        overlay: m && { x: Number(m[1]), y: Number(m[2]), h: parseFloat(sc.style.height) } }
    })
    check('空标题丝滑光标在文字起点与行内高度', emptySmooth.overlay
      && Math.abs(emptySmooth.overlay.x - emptySmooth.x) <= 1
      && Math.abs(emptySmooth.overlay.y - (emptySmooth.y + (emptySmooth.h - emptySmooth.overlay.h) / 2)) <= 1, emptySmooth)
    const native = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: 'zh-CN' })
    native.on('pageerror', (e) => errors.push(e.message))
    await native.goto(`${URL}?upage&upane&useed=${encodeURIComponent(emptySeed)}`)
    await native.locator('.callout-toggle-title').click({ position: { x: 45, y: 12 } })
    await native.waitForTimeout(130)
    const emptyNative = await native.evaluate(() => {
      const title = document.querySelector('.callout-toggle-title')
      return !!title?.hasAttribute('data-empty-caret') && getComputedStyle(title, '::before').content === '""'
    })
    check('空标题普通模式显示输入光标', emptyNative)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await page.locator(ARROW).evaluate((el) => {
      const body = el.closest('blockquote').querySelector(':scope > p:nth-child(2)')
      return { arrow: getComputedStyle(el.querySelector('svg')).transitionDuration,
        body: getComputedStyle(body).transitionDuration }
    })
    check('减少动态效果时关闭箭头与正文过渡', parseFloat(reduced.arrow) < 0.001 && parseFloat(reduced.body) < 0.001, reduced)
    check('页面没有运行时错误', errors.length === 0, errors)
  } finally { await browser.close() }
  const failed = checks.filter((ok) => !ok).length
  console.log(`\n${checks.length - failed}/${checks.length} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
