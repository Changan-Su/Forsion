/** Real note-link regression: opening/closing a split must preserve shell widths.
 * Run after npm run build: npm run check:mainsplitwidth (under devlock).
 * Uses an isolated vault, real Excalidraw and database views, and frame-by-frame geometry.
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, shotDir, makeReporter } = require('./lib/uiux-electron.cjs')
const R = makeReporter()
const OUT = shotDir('main-split-sidewidth')
const drawing = ['---', 'excalidraw-plugin: parsed', '---', '', '## Drawing', '```json',
  JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} }), '```', '%%'].join('\n')

async function main() {
  const ctx = await launch({ tag: 'main-split-width', beforeLaunch: ({ vault }) => {
    fs.writeFileSync(path.join(vault, 'Layout probe.md'), '# Layout probe\n\n[[Board.excalidraw]]\n\n[[Table.db]]\n\nKeep the sidebar and this note in place.\n')
    fs.writeFileSync(path.join(vault, 'Board.excalidraw.md'), drawing)
    fs.writeFileSync(path.join(vault, 'Table.db'), JSON.stringify({ version: 1, name: 'Table', columns: [{ id: 'title', name: 'Title', type: 'text' }], rows: [], views: [] }))
  } })
  const { app, win } = ctx
  const measure = () => win.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
    const groups = [...document.querySelectorAll('.dv-groupview')].filter(g => g.getBoundingClientRect().width > 0)
    const left = groups.find(g => g.querySelector('.t2s-srow-title'))
    const right = groups.find(g => g.querySelector('.wb-tab--icon:not(.wb-tab--left)'))
    return { left: left ? rect(left) : null, right: right ? rect(right) : null, groups: groups.map(rect), saved: localStorage.getItem('lcl.sideWidth2.amadeus') }
  })
  try {
    await boot(app, win, { space: 'amadeus', width: 1512, height: 950 })
    await win.locator('.t2s-srow').filter({ has: win.locator('.t2s-srow-title', { hasText: /^Layout probe$/ }) }).first().click()
    await win.locator('.wikilink').filter({ hasText: 'Board.excalidraw' }).first().waitFor()
    await win.waitForTimeout(700)
    for (const scenario of ['default', 'custom']) {
      if (scenario === 'custom') {
        await win.locator('.dv-edge-right').first().click()
        await win.waitForTimeout(600)
        const before = await measure()
        const sash = await win.evaluate(edge => [...document.querySelectorAll('.dv-sash')].map(e => {
          const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height, w: r.width }
        }).find(r => r.h > 100 && r.w < 20 && Math.abs(r.x - edge) < 10), before.left.x + before.left.w)
        if (!sash) throw new Error('Left sidebar sash not found')
        await win.mouse.move(sash.x, sash.y); await win.mouse.down()
        await win.mouse.move(sash.x + 345 - before.left.w, sash.y, { steps: 12 }); await win.mouse.up()
        await win.waitForTimeout(500)
        const custom = await measure()
        R.check('Real sidebar drag remains available', Math.abs(custom.left.w - 345) <= 2 && JSON.parse(custom.saved)?.left === 345, JSON.stringify(custom))
        R.check('Right sidebar is present for split coverage', !!custom.right)
      }
    for (const [target, type, content] of [['Board.excalidraw', 'amadeus-drawing', '.amx-drawview .excalidraw canvas.interactive'], ['Table.db', 'amadeus-db', '.amx-dbview .amx-db']]) {
      const before = await measure()
      await win.evaluate(() => {
        window.__splitWidths = []; window.__sampleSplit = true
        const sample = () => {
          if (!window.__sampleSplit) return
          const g = [...document.querySelectorAll('.dv-groupview')].find(g => g.querySelector('.t2s-srow-title'))
          const right = [...document.querySelectorAll('.dv-groupview')].find(g => g.querySelector('.wb-tab--icon:not(.wb-tab--left)'))
          if (g) window.__splitWidths.push({ left: g.getBoundingClientRect().width, right: right?.getBoundingClientRect().width ?? null })
          requestAnimationFrame(sample)
        }
        sample()
      })
      await win.locator('.wikilink').filter({ hasText: target }).first().click()
      await win.waitForSelector(content, { timeout: 30000 })
      await win.waitForTimeout(900)
      const opened = await measure()
      const frames = await win.evaluate(() => { window.__sampleSplit = false; return window.__splitWidths })
      R.check(`${target}: real link creates a split`, opened.groups.length === before.groups.length + 1, JSON.stringify({ before, opened }))
      R.check(`${scenario}/${target}: sidebar widths stay fixed on every frame`, before.left && frames.length > 2 && frames.every(w => Math.abs(w.left - before.left.w) <= 2 && (!before.right || Math.abs(w.right - before.right.w) <= 2)), JSON.stringify({ before, leftRange: [Math.min(...frames.map(w => w.left)), Math.max(...frames.map(w => w.left))] }))
      R.check(`${target}: sidebar preference stays unchanged`, before.saved === opened.saved, JSON.stringify({ before: before.saved, after: opened.saved }))
      await win.screenshot({ path: path.join(OUT, `${scenario}-${target}-open.png`) })
      // Close the new split with the same tab close button used in the recording.
      await win.locator(`.wb-tab[data-view-type="${type}"] .wb-tab-close`).last().click({ timeout: 5000 })
      await win.waitForTimeout(700)
      const closed = await measure()
      R.check(`${target}: closing restores main area and keeps sidebars`, closed.groups.length === before.groups.length && Math.abs(closed.left.w - before.left.w) <= 2 && (!before.right || Math.abs(closed.right.w - before.right.w) <= 2) && closed.saved === before.saved, JSON.stringify(closed))
    }
    const beforeCommand = await measure()
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Backslash' : 'Control+Backslash')
    await win.waitForTimeout(500)
    const splitCommand = await measure()
    R.check(`${scenario}: split command preserves shell widths`, splitCommand.groups.length === beforeCommand.groups.length + 1 && Math.abs(splitCommand.left.w - beforeCommand.left.w) <= 2 && splitCommand.saved === beforeCommand.saved, JSON.stringify(splitCommand))
    await win.locator('.wb-tab[data-view-type="amadeus-editor"] .wb-tab-close').last().click({ timeout: 5000 })
    await win.waitForTimeout(500)
    }
    await win.screenshot({ path: path.join(OUT, 'closed.png') })
  } finally { await ctx.close() }
  console.log(`Screenshots: ${OUT}`)
  process.exitCode = R.summary() ? 1 : 0
}
main().catch(e => { console.error(e); process.exitCode = 1 })
