// Real keyboard/pointer regressions: math pairs and previews, fold body handles,
// image selection/resize (including headings), media side pairing, soft-line embeds.
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
const exe = process.env.CHROMIUM_EXE || fs.readdirSync(cache).filter(x => x.startsWith('chromium-')).sort().reverse()
  .flatMap(x => ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']
    .map(a => path.join(cache, x, 'chrome-mac-arm64', a))).find(x => fs.existsSync(x))
let failed = 0
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail ?? '')}`); if (!ok) failed++ }
const pause = p => p.waitForTimeout(200)
const state = p => p.evaluate(() => { const s = window.__upage.probe.view().state; return { text: s.doc.textContent, offset: s.selection.$head.parentOffset } })
const box = async loc => { const r = await loc.boundingBox(); if (!r) throw new Error('Missing box'); return { ...r, cx: r.x + r.width / 2, cy: r.y + r.height / 2 } }
async function main() {
  const b = await chromium.launch({ executablePath: exe, headless: true })
  try {
    let seq = 0
    const open = async seed => {
      const p = await b.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 1000 } })
      p.on('pageerror', e => console.log('PAGEERROR', e.message))
      await p.goto(`${URL}?upage&upane`)
      await p.waitForFunction(() => typeof window.__upage?.probe.view === 'function' && !!window.__upage.probe.view())
      await p.evaluate(([seed, seq]) => {
        window.__assets.setUrlBuilder(() => 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160"><rect width="300" height="160" fill="#789"/></svg>'))
        window.__upage.switchFile(`Editing-${seq}.md`, seed)
      }, [seed, ++seq])
      await p.waitForTimeout(700)
      return p
    }
    let p = await open('start\n')
    const pm = '.unified-body .ProseMirror'
    await p.locator(pm).click()
    await p.keyboard.press('Meta+End')
    await p.keyboard.press('End')
    await p.keyboard.press('Enter')
    await p.keyboard.type('$')
    let s = await state(p); check('first dollar stays literal', s.text.endsWith('$') && !s.text.endsWith('$$'), s)
    await p.keyboard.type('$'); s = await state(p); check('second dollar centers caret', s.text.endsWith('$$') && s.offset === 1, s)
    await p.keyboard.type('$'); s = await state(p); check('third dollar upgrades display pair', s.text.endsWith('$$$$') && s.offset === 2, s)
    await p.keyboard.press('Backspace'); s = await state(p); check('display pair backspace', s.text.endsWith('$$') && s.offset === 1, s)
    await p.keyboard.press('Backspace'); s = await state(p); check('inline pair backspace', !s.text.includes('$') && s.offset === 0, s)
    await p.keyboard.type('$$x$'); s = await state(p); check('closing dollar skips existing closer', s.text.endsWith('$x$') && s.offset === 3, s)
    await p.close()

    for (const [seed, offset, keys, expected, caret] of [
      ['$$x$$', 3, '$$', '$$x$$', 5],
      ['$$x$$', 4, 'Backspace', '$$x$', 3],
      // The preceding rendered formula is deleted atomically; the next stays intact.
      ['$x$$y$', 3, 'Backspace', '$y$', 0],
      ['$$$$', 2, 'Enter', '$$\n\n$$', 3],
    ]) {
      p = await open(seed + '\n')
      await p.evaluate(offset => {
        const v = window.__upage.probe.view()
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, offset + 1)))
        v.focus()
      }, offset)
      if (keys === '$$') await p.keyboard.type(keys)
      else await p.keyboard.press(keys)
      const got = await p.evaluate(() => { const v = window.__upage.probe.view(); return {
        text: v.state.doc.firstChild.textBetween(0, v.state.doc.firstChild.content.size, '\n', '\n'),
        count: v.state.doc.childCount, offset: v.state.selection.$head.parentOffset,
      } })
      check(`${seed} at ${offset}: ${keys}`, got.text === expected && got.offset === caret && got.count === 1, got)
      await p.close()
    }

    p = await open('Example: $x+y$ and $x^2$ and $\\frac{3!}{2!}=3$.\n\nTail\n')
    await p.locator('.math-rendered').first().click()
    await pause(p)
    check('only active formula previews', await p.locator('.math-preview--inline').count() === 1 && await p.locator('.math-rendered').count() === 2)
    const geom = await p.evaluate(() => {
      const preview = document.querySelector('.math-preview--inline').getBoundingClientRect()
      const para = document.querySelector('.math-preview--inline').parentElement
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT)
      let bottom = 0
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement.closest('.math-preview')) continue
        const r = document.createRange(); r.selectNodeContents(n)
        for (const rect of r.getClientRects()) if (rect.width) bottom = Math.max(bottom, rect.bottom)
      }
      return { previewTop: preview.top, sourceBottom: bottom }
    })
    check('preview does not cover text', geom.previewTop >= geom.sourceBottom, geom)
    fs.mkdirSync('out/amadeus-editing', { recursive: true })
    await p.screenshot({ path: 'out/amadeus-editing/math-preview.png' })
    await p.close()

    p = await open('Top\n\n> [!fold]+ Details\n>\n> Inside one\n>\n> Inside two\n\nTail\n')
    let r = await box(p.locator('blockquote p').filter({ hasText: 'Inside two' }))
    await p.mouse.move(r.x + 35, r.cy); await pause(p)
    const g = p.locator('.unified-gutter .drag-handle')
    let h = await box(g)
    check('fold body has own handle', Math.abs(h.y - r.y) < 30, { h, r })
    await p.mouse.move(h.cx, h.y + 8, { steps: 5 }); await pause(p)
    await p.mouse.down(); await p.mouse.move(h.cx + 10, h.y + 15, { steps: 3 }); await pause(p)
    let dragged = await p.evaluate(() => { const v = window.__upage.probe.view(); return { text: v.state.selection.content().content.textBetween(0, v.state.selection.content().content.size), drag: !!v.dragging } })
    check('fold child drags independently', dragged.drag && dragged.text === 'Inside two', dragged)
    const tail = await box(p.locator(`${pm} > p`).filter({ hasText: 'Tail' }))
    await p.mouse.move(tail.cx, tail.y + tail.height + 15, { steps: 12 })
    for (let i = 0; i < 8; i++) { await p.mouse.move(tail.cx, tail.y + tail.height + 15); await p.waitForTimeout(20) }
    await p.mouse.up(); await pause(p)
    check('fold child moves out without taking siblings', await p.locator('blockquote').innerText().then(t => t.includes('Inside one') && !t.includes('Inside two')) &&
      await p.locator(`${pm} > p`).filter({ hasText: 'Inside two' }).count() === 1)
    await p.close()

    for (const format of ['wiki', 'markdown', 'heading']) {
      p = await open(`Top\n\n${format === 'markdown' ? '![pic|200](pic.png)' : (format === 'heading' ? '# ' : '') + '![[pic.png|200]]'}\n\nTail\n`)
      const image = p.locator('.wiki-inline-img').first()
      await image.click(); await pause(p)
      const hasHandle = await p.locator('.amx-img-resize').count() === 1
      check(`${format} click exposes resize handle`, hasHandle)
      if (!hasHandle) { await p.close(); continue }
      r = await box(p.locator('.amx-img-resize').first())
      // Exercise the outer half as well as the center covered by image-select.check.
      await p.mouse.move(r.x + r.width - 2, r.cy); await p.mouse.down()
      await p.mouse.move(r.x + r.width + 58, r.cy, { steps: 8 }); await p.mouse.up(); await pause(p)
      check(`${format} outer grip resizes`, Math.abs((await box(image)).width - 260) < 2, await state(p))
      check(`${format} resize does not start marquee`, await p.locator('.amx-marquee').count() === 0)
      await p.close()
    }

    for (const side of ['left', 'right']) {
      p = await open('Top\n\n![[pic.png|200]]\n\nMove me\n\nTail\n')
      r = await box(p.locator(`${pm} > p`).filter({ hasText: 'Move me' }))
      await p.mouse.move(r.x + 40, r.cy); await pause(p)
      h = await box(p.locator('.unified-gutter .drag-handle'))
      const img = await box(p.locator('.wiki-inline-img-wrap'))
      const x = side === 'left' ? img.x + 3 : img.x + img.width - 3
      await p.mouse.move(h.cx, h.y + 8, { steps: 5 }); await pause(p)
      await p.mouse.down(); await p.mouse.move(h.cx + 10, h.y + 15, { steps: 3 })
      await p.mouse.move(x, img.cy, { steps: 16 })
      for (let i = 0; i < 10; i++) { await p.mouse.move(x, img.cy); await p.waitForTimeout(20) }
      check(`text -> image ${side} has side indicator`, await p.locator('.unified-drop-vline').evaluateAll(es => es.some(e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).display !== 'none')))
      await p.mouse.up(); await pause(p)
      const cols = await p.locator('.amx-ucolcell').allTextContents()
      check(`text -> image ${side} creates columns`, cols.length === 2 && cols[side === 'left' ? 0 : 1].includes('Move me'), cols)
      await p.close()
    }

    const embedSeed = '[[Normal]]\n![[example.pdf|200]]\n[[Other]]\n![[example.pdf|200]]\n'
    p = await open(embedSeed)
    check('soft-line embeds render independently', await p.locator('.unified-embed').count() === 2, await p.locator(pm).innerText())
    check('ordinary neighboring links remain', await p.locator('.wikilink').filter({ hasText: 'Normal' }).count() === 1 && await p.locator('.wikilink').filter({ hasText: 'Other' }).count() === 1)
    if (await p.locator('.unified-embed').count() !== 2) { await p.close(); process.exitCode = 1; return }
    // Same content twice: source controls and width writes must use the second range.
    r = await box(p.locator('.unified-embed').nth(1))
    await p.mouse.move(r.cx, r.cy); await pause(p)
    r = await box(p.locator('.unified-embed .amx-img-resize').nth(1))
    await p.mouse.move(r.cx, r.cy); await p.mouse.down()
    await p.mouse.move(r.cx + 60, r.cy, { steps: 6 }); await p.mouse.up()
    await p.waitForFunction(f => window.__upage.vault.get(f)?.includes('|260]]'), `Editing-${seq}.md`, { timeout: 5000 })
    let saved = await p.evaluate(f => window.__upage.vault.get(f), `Editing-${seq}.md`)
    check('second soft embed resize preserves first and soft breaks', saved === embedSeed.replace(/200\]\]\n$/, '260]]\n'), saved)
    await p.locator('.unified-embed').nth(1).hover()
    await p.locator('.unified-embed .amx-src-btn:not(.amx-open-btn)').nth(1).click()
    await pause(p)
    const sourceState = await state(p)
    check('second soft embed source opens at second range', sourceState.offset === embedSeed.lastIndexOf('![['), sourceState)
    await p.keyboard.type('X')
    await pause(p)
    check('editing one soft embed keeps the other', await p.locator('.unified-embed').count() === 1)
    await p.keyboard.press('Meta+z'); await pause(p)
    check('undo restores both soft embeds', await p.locator('.unified-embed').count() === 2)
    await p.close()
  } finally { await b.close() }
  process.exitCode = failed ? 1 : 0
}
main().catch(e => { console.error(e); process.exitCode = 1 })
