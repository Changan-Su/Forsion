// Native pointer/keyboard regression: rendered wiki/math at a textblock endpoint.
// Run through e2e-editor.cjs; optional LATEX_PLUGIN_DIR exercises the built plugin.
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
const exe = process.env.CHROMIUM_EXE || fs.readdirSync(cache).filter(x => x.startsWith('chromium-')).sort().reverse()
  .flatMap(x => ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']
    .map(a => path.join(cache, x, 'chrome-mac-arm64', a))).find(x => fs.existsSync(x))
let failed = 0
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); if (!ok) failed++ }
const settle = p => p.waitForTimeout(180)
const shotDir = process.env.SHOT_DIR || 'out/editor-inline-edges'
async function main() {
  const browser = await chromium.launch({ executablePath: exe, headless: true })
  const errors = []
  fs.mkdirSync(shotDir, { recursive: true })
  const open = async (seed, smooth = false, zoom = 1) => {
    const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 })
    p.on('pageerror', e => errors.push(e.message))
    await p.goto(`${URL}?upage&upane${smooth ? '&caret' : ''}&useed=${encodeURIComponent(seed)}`)
    await p.waitForFunction(() => !!window.__upage?.probe.view?.())
    await p.evaluate(z => { document.body.style.zoom = String(z) }, zoom)
    await settle(p)
    return p
  }
  try {
    for (const smooth of (process.env.EDITOR_EDGE_ONLY_PLUGIN ? [] : [false, true])) for (const zoom of [1, 1.1]) {
      for (const [name, source, text] of [
        ['heading-wiki', '# [[Target]]', '[[Target]]'],
        ['heading-text-wiki', '# Heading [[Target]]', 'Heading [[Target]]'],
        ['inline-math', '$x+y$', '$x+y$'],
        ['text-inline-math', 'Text $x+y$', 'Text $x+y$'],
      ]) {
        const p = await open(`${source}\n\nTail\n`, smooth, zoom)
        const label = `${name} ${smooth ? 'smooth' : 'native'} ${zoom}`
        const first = p.locator('.unified-body .ProseMirror > :first-child')
        await p.locator('.unified-body .ProseMirror > p').last().click()
        await settle(p)
        const r = await first.boundingBox()
        await p.mouse.click(r.x + r.width - 10, r.y + Math.min(r.height / 2, 15 * zoom))
        await settle(p)
        const state = await p.evaluate(() => {
          const v = window.__upage.probe.view(), s = document.getSelection()
          const anchor = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement
          const marker = document.querySelector('.amx-inline-caret')?.getBoundingClientRect()
          const caret = document.querySelector('.sc-caret')?.getBoundingClientRect()
          return { end: v.state.selection.$head.parentOffset === v.state.doc.firstChild.content.size,
            first: v.state.selection.$head.parent === v.state.doc.firstChild,
            hidden: !!anchor?.closest('.math-src-hidden,.wikilink-src-hidden,.katex'),
            marker: marker && { x: marker.x, y: marker.y, h: marker.height },
            caret: caret && { x: caret.x, y: caret.y, h: caret.height } }
        })
        check(`${label}: click reaches visible endpoint`, state.end && state.first && !state.hidden, state)
        if (smooth) check(`${label}: smooth caret stays at rendered edge`, state.marker && state.caret &&
          Math.abs(state.caret.x - state.marker.x) <= 2 && Math.abs(state.caret.y - state.marker.y) <= 2, state)
        if (smooth && zoom === 1.1) await p.screenshot({ path: path.join(shotDir, `${name}.png`) })
        await p.keyboard.type(' Z')
        await settle(p)
        const typed = await p.evaluate(() => window.__upage.probe.view().state.doc.firstChild.textContent)
        check(`${label}: typing follows preview, with no decoration text`, typed === text + ' Z', typed)
        await p.evaluate(() => window.__upage.probe.flush?.())
        await p.waitForTimeout(650)
        const disk = await p.evaluate(() => window.__upage.vault.get('Unified.md'))
        check(`${label}: saved text has no zero-width marker`, disk === `${source} Z\n\nTail\n`, disk)
        await p.keyboard.press('Meta+z')
        await settle(p)
        check(`${label}: undo preserves original preview`, await p.evaluate(() => window.__upage.probe.view().state.doc.firstChild.textContent) === text)
        await p.evaluate(offset => { const v = window.__upage.probe.view(); v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, offset + 1))); v.focus() }, text.length)
        await p.keyboard.press('ArrowLeft')
        check(`${label}: Left enters source in one key`, await p.evaluate(() => window.__upage.probe.view().state.selection.$head.parentOffset) === text.length - 1)
        await p.evaluate(offset => { const v = window.__upage.probe.view(); v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, offset + 1))) }, text.length)
        await p.keyboard.press('Backspace')
        const prefix = text.replace(/\[\[Target\]\]|\$x\+y\$/, '')
        check(`${label}: Backspace removes the preview in one key`, await p.evaluate(() => window.__upage.probe.view().state.doc.firstChild.textContent) === prefix)
        await p.keyboard.press('Meta+z')
        check(`${label}: undo restores deleted preview`, await p.evaluate(() => window.__upage.probe.view().state.doc.firstChild.textContent) === text)
        if (name === 'heading-text-wiki' && !smooth && zoom === 1) {
          await p.mouse.move(r.x + r.width - 10, r.y + 15)
          await p.mouse.down()
          await p.mouse.move(r.x + 5, r.y + 15, { steps: 10 })
          await p.mouse.up()
          await settle(p)
          check('dragging from trailing whitespace keeps native selection', await p.evaluate(() => !window.__upage.probe.view().state.selection.empty))
        }
        await p.close()
      }
    }
    if (!process.env.EDITOR_EDGE_ONLY_PLUGIN) {
      for (const [openKey, closeKey] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        const p = await open('$$\n\nTail\n')
        await p.evaluate(() => { const v = window.__upage.probe.view(); v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 2))); v.focus() })
        await p.keyboard.type(openKey)
        await settle(p)
        const paired = await p.evaluate(() => { const s = window.__upage.probe.view().state; return { text: s.doc.firstChild.textContent, offset: s.selection.$head.parentOffset } })
        check(`host pairs ${openKey} inside math without plugin`, paired.text === '$' + openKey + closeKey + '$' && paired.offset === 2, paired)
        await p.keyboard.press('Backspace')
        check(`host deletes empty ${openKey} pair`, await p.evaluate(() => window.__upage.probe.view().state.doc.firstChild.textContent) === '$$')
        await p.close()
      }
    }
    const pluginDir = process.env.LATEX_PLUGIN_DIR
    if (pluginDir) {
      const p = await open('$x$\n\nTail\n')
      const code = fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8')
      await p.evaluate(code => window.__ep.loadPlugin(code, { id: 'latex-suite', name: 'LaTeX Suite' }), code)
      await p.waitForTimeout(600)
      const set = async (seed, offset) => {
        await p.evaluate(([seed, offset]) => {
          const v = window.__upage.probe.view()
          let tr = v.state.tr.replaceWith(0, v.state.doc.content.size, v.state.schema.node('paragraph', null, v.state.schema.text(seed)))
          tr = tr.setSelection(v.state.selection.constructor.create(tr.doc, offset + 1))
          v.dispatch(tr); v.focus()
        }, [seed, offset])
        await settle(p)
      }
      for (const [seed, expected] of [['$ps$', '$\\psi$'], ['$$ps$$', '$$\\psi$$'], ['$Ps$', '$\\Psi$']]) {
        await set(seed, seed.indexOf('s') + 1)
        await p.keyboard.type('i')
        await settle(p)
        check(`plugin expands ${seed} at the delimiter`, await p.evaluate(() => window.__upage.probe.view().state.doc.textContent) === expected)
      }
      await set('$$', 1)
      await p.keyboard.type('//a')
      await p.keyboard.press('Tab')
      await p.keyboard.type('b')
      await p.keyboard.press('Tab')
      await p.keyboard.press('Tab')
      const after = await p.evaluate(() => { const s = window.__upage.probe.view().state; return { text: s.doc.textContent, offset: s.selection.$head.parentOffset } })
      check('plugin final tabstop hands the same Tab to equation exit', after.text === '$\\frac{a}{b}$' && after.offset === after.text.length, after)
      for (const [keys, expected] of [['(', '$()$'], ['[', '$[]$'], ['{', '${}$']]) {
        await set('$$', 1)
        await p.keyboard.type(keys)
        check(`math pairs ${keys} with plugin loaded`, await p.evaluate(() => window.__upage.probe.view().state.doc.textContent) === expected)
        await settle(p)
        await p.keyboard.press('Backspace')
        const deleted = await p.evaluate(() => window.__upage.probe.view().state.doc.textContent)
        check(`plugin Backspace recovers literal ${keys} trigger`, deleted === '$' + keys + '$', deleted)
      }
      await p.close()
    }
    check('no renderer errors', errors.length === 0, errors)
  } finally { await browser.close() }
  process.exitCode = failed ? 1 : 0
}
main().catch(e => { console.error(e); process.exit(1) })
