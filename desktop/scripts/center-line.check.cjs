// Exercises the actual UnifiedPage, desktop menu and mobile sheet on the same Markdown note.
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const url = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const seed = Array.from({ length: 40 }, (_, i) => '第 ' + (i + 1) + ' 段。' + ['调好狭缝后，分别记录两侧的明纹位置。交换观察次序后再读一轮，核对光栅是否移动。', '记录灯熄灭前后的暗计数。用两次背景的平均值修正同组的谱线读数，原始数值仍保留在表里。'][i % 2]).join('\n\n')
const shotDir = (process.argv.find(a => a.startsWith('--shot=')) || '').slice(7)

async function checkCenterLine(browser, mobile) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 780 } : { width: 1040, height: 680 }, locale: 'zh-CN', hasTouch: mobile })
  try {
    await page.goto(url + '?upage&upane' + (mobile ? '&umbar' : ''))
    await page.waitForFunction(() => window.__upage?.probe?.view?.())
    await page.evaluate(seed => window.__upage.switchFile('Writing.md', seed), seed)
    await page.locator('.unified-body .ProseMirror').getByText('第 40 段。', { exact: false }).waitFor()
    const menu = page.locator(mobile ? '.amx-mbar button[title="更多操作"]' : '.amx-toolbar .amx-more-btn')
    const toggle = page.locator(mobile ? '.mb-sheet [data-action="page-centerLine"]' : '[data-pagestyle="centerLine"]')
    await menu.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    await page.locator('.amx-seg-anchor[data-center-line]').waitFor({ state: 'attached' })
    // Close the menu independently of editing so Esc below tests the editor's command.
    if (mobile) await page.locator('.mb-sheet-scrim').click({ position: { x: 20, y: 20 } })
    else await menu.click()

    assert.equal(await page.evaluate(() => window.__upage.writes.length), 0)
    await page.emulateMedia({ media: 'print' })
    assert.equal(await page.locator('.amx-seg-anchor').evaluate(el => getComputedStyle(el).display), 'none')
    await page.emulateMedia({ media: 'screen' })

    const at = i => page.evaluate(i => {
      const v = window.__upage.probe.view()
      let pos = 1
      for (let n = 0; n < i; n++) pos += v.state.doc.child(n).nodeSize
      if (i === v.state.doc.childCount - 1) pos += v.state.doc.lastChild.content.size
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(pos))))
      v.focus()
    }, i)
    const distance = () => {
      const v = window.__upage.probe.view()
      const r = v.coordsAtPos(v.state.selection.head)
      const pane = v.dom.closest('.amx-pane')
      const toolbar = pane.querySelector('.amx-toolbar').getBoundingClientRect()
      const box = pane.getBoundingClientRect()
      const vv = window.visualViewport
      const top = Math.max(box.top, vv.offsetTop, toolbar.bottom)
      const mobileBar = document.querySelector('.amx-mbar')?.getBoundingClientRect()
      const bottom = Math.min(box.bottom, vv.offsetTop + vv.height, mobileBar && mobileBar.height && mobileBar.top > top ? mobileBar.top : Infinity)
      return (r.top + r.bottom - top - bottom) / 2
    }
    // Includes wrapped lines, the very first and the very last paragraph and non-default UI zoom.
    await page.evaluate(() => { document.body.style.zoom = '1.15' })
    for (const i of [0, 39, 19]) {
      await at(i)
      await page.keyboard.insertText('复核。')
      await page.waitForFunction('Math.abs((' + distance.toString() + ')()) <= 3', null, { timeout: 4000 })
    }
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 510 })
      await page.waitForFunction('Math.abs((' + distance.toString() + ')()) <= 3', null, { timeout: 4000 })
      await page.setViewportSize({ width: 390, height: 780 })
      await page.waitForFunction('Math.abs((' + distance.toString() + ')()) <= 3', null, { timeout: 4000 })
    }
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'typing-line-' + (mobile ? '390' : '1040') + '.png') })

    const pane = page.locator('.amx-pane').first()
    const position = () => pane.evaluate(el => el.scrollTop)
    const centered = await position()
    if (!mobile) {
      const points = await page.evaluate(() => {
        const v = window.__upage.probe.view()
        let pos = 1
        for (let n = 0; n < 19; n++) pos += v.state.doc.child(n).nodeSize
        return [pos + 2, pos + v.state.doc.child(19).nodeSize + 2].map(p => {
          const r = v.coordsAtPos(p)
          return { x: r.left, y: (r.top + r.bottom) / 2 }
        })
      })
      await page.mouse.move(points[0].x, points[0].y)
      await page.mouse.down()
      await page.mouse.move(points[1].x, points[1].y, { steps: 8 })
      await page.mouse.up()
      await page.waitForFunction(() => {
        const s = window.__upage.probe.view().state.selection
        return !s.empty && s.$from.parent !== s.$to.parent
      })
      assert(Math.abs(await position() - centered) < 4)
      await at(19)
    }
    await page.mouse.move(mobile ? 195 : 520, 350)
    if (mobile) {
      const touch = await page.context().newCDPSession(page)
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 300 }] })
      for (const y of [325, 350, 375, 400, 425]) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y }] })
        await page.waitForTimeout(60)
      }
      await page.waitForTimeout(150)
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await touch.detach()
    } else await page.mouse.wheel(0, -125)
    await page.waitForFunction(scroll => document.querySelector('.amx-pane').scrollTop < scroll - 40, centered)
    const manual = await position()
    await page.waitForTimeout(140)
    assert(Math.abs(await position() - manual) < 3)
    await page.keyboard.press('Shift+ArrowRight')
    await page.waitForFunction(() => !window.__upage.probe.view().state.selection.empty, null, { timeout: 3000 })
    assert(Math.abs(await position() - manual) < 4)
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction('Math.abs((' + distance.toString() + ')()) <= 3', null, { timeout: 4500 })

    // Move the caret off-center without editing. Chromium's native IME preedit must stay at that position.
    const cdp = await page.context().newCDPSession(page)
    const beforeWheel = await position()
    await page.mouse.wheel(0, -95)
    await page.waitForFunction(scroll => document.querySelector('.amx-pane').scrollTop < scroll - 35, beforeWheel)
    const beforeIme = await position()
    await cdp.send('Input.imeSetComposition', { text: 'yin', selectionStart: 3, selectionEnd: 3 })
    await page.waitForTimeout(100)
    assert(Math.abs(await position() - beforeIme) < 4)
    await cdp.send('Input.insertText', { text: '印' })
    await page.waitForFunction('Math.abs((' + distance.toString() + ')()) <= 3', null, { timeout: 4500 })
    await cdp.detach()
    await page.evaluate(() => window.__upage.probe.flush?.())
    await page.waitForFunction(() => window.__upage.vault.get('Writing.md')?.includes('印'))
    const switchNote = async (path, body) => {
      await page.evaluate(([path, body]) => window.__upage.switchFile(path, body), [path, body])
      await page.waitForFunction(name => document.querySelector('.amx-title-input')?.value === name, path.replace('.md', ''))
      await page.locator('.unified-body .ProseMirror').waitFor()
    }
    await switchNote('Control.md', '独立的对照笔记。')
    assert.equal(await page.locator('.amx-seg-anchor[data-center-line]').count(), 0)
    const saved = await page.evaluate(() => window.__upage.vault.get('Writing.md'))
    await switchNote('Writing.md', saved)
    await page.locator('.amx-seg-anchor[data-center-line]').waitFor({ state: 'attached' })
    await at(19)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.amx-seg-anchor[data-center-line]'))
    assert(await page.evaluate(() => window.__upage.probe.view().state.selection.empty))
    await menu.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    console.log('PASS typing line:', mobile ? '390px touch sheet' : 'desktop menu', 'first/last/middle, manual scroll, selection, native IME, Esc')
  } finally { await page.close() }
}

module.exports = {checkCenterLine}
if (require.main === module) (async () => {
  const browser = await chromium.launch({executablePath:findChromium()})
  try { await checkCenterLine(browser, false); await checkCenterLine(browser, true) }
  finally { await browser.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
