/** Real note-link regression: opening/closing a split must preserve shell widths.
 * Run after npm run build: npm run check:mainsplitwidth (under devlock).
 * Uses an isolated vault, real Excalidraw and database views, and frame-by-frame geometry.
 * --extended also covers the built-in PDF reader and actual Better PDF/Notebook/Bluebird
 * packages from SPLIT_PLUGIN_ROOT (default ~/.forsion-dev/plugins), copying package files
 * only. Public companion create/fold/reopen is exercised by an isolated probe plugin.
 * --plugins-only reruns the plugin portion at 110% zoom without the native-reader pass.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { tinyPdf } = require('./lib/tiny-pdf.cjs')
const { launch, boot, shotDir, makeReporter } = require('./lib/uiux-electron.cjs')
const R = makeReporter()
const OUT = shotDir('main-split-sidewidth')
const drawing = ['---', 'excalidraw-plugin: parsed', '---', '', '## Drawing', '```json',
  JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} }), '```', '%%'].join('\n')

const EXTENDED = process.argv.includes('--extended') || process.argv.includes('--plugins-only')
const pluginRoot = process.env.SPLIT_PLUGIN_ROOT || path.join(os.homedir(), '.forsion-dev/plugins')
const probe = `
ctx.registerView({ id: 'workbench', title: 'Split probe', singleton: false,
  mainCompanions: [{ type: 'amadeus-editor', key: 'split-probe-document', split: 'right' }],
  mount(el, view) {
    el.innerHTML = '<div class="split-probe-owner"><button data-show>Show companion</button><button data-hide>Hide companion</button><input aria-label="Owner draft" value="Keep this draft"></div>';
    el.querySelector('[data-show]').onclick = () => view.setCompanionsVisible(true);
    el.querySelector('[data-hide]').onclick = () => view.setCompanionsVisible(false);
  }
});
ctx.registerFileType({ id: 'probe', extensions: ['.splitprobe'], title: 'Probe file', mount(el) { el.innerHTML = '<p class="split-probe-file">Plugin file mounted</p>'; } });
`

async function run(mode) {
  const ctx = await launch({ tag: 'main-split-width', beforeLaunch: ({ home, vault }) => {
    fs.writeFileSync(path.join(vault, 'Layout probe.md'), '# Layout probe\n\n[[Board.excalidraw]]\n\n[[Table.db]]\n\n[[Reading.pdf]]\n\n[[Notebook.ipynb]]\n\n[[Plugin.splitprobe]]\n\nKeep the sidebar and this note in place.\n')
    fs.writeFileSync(path.join(vault, 'Board.excalidraw.md'), drawing)
    fs.writeFileSync(path.join(vault, 'Table.db'), JSON.stringify({ version: 1, name: 'Table', columns: [{ id: 'title', name: 'Title', type: 'text' }], rows: [], views: [] }))
    fs.writeFileSync(path.join(vault, 'Reading.pdf'), tinyPdf(['PDF sidebar split regression', 'Second page remains readable']))
    fs.writeFileSync(path.join(vault, 'Notebook.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'probe', cell_type: 'code', metadata: {}, source: ['print("Notebook split probe")'], execution_count: null, outputs: [] }] }))
    fs.writeFileSync(path.join(vault, 'Plugin.splitprobe'), 'Plugin file fixture')
    if (mode === 'plugins') {
      for (const id of ['pdf-reader', 'notebook', 'bluebird']) {
        const dest = path.join(home, 'plugins', id); fs.mkdirSync(dest, { recursive: true })
        for (const file of ['main.js', 'manifest.json', 'icon.png', 'icon.svg']) {
          const source = path.join(pluginRoot, id, file)
          if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dest, file))
          else if (file === 'main.js' || file === 'manifest.json') throw new Error(`Missing actual plugin package: ${source}`)
        }
        console.log(`PACKAGE ${id} ${JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'))).version}`)
      }
      const dest = path.join(home, 'plugins', 'split-probe'); fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ id: 'split-probe', name: 'Split probe', version: '1.0.0', minAppVersion: '0.0.1' }))
      fs.writeFileSync(path.join(dest, 'main.js'), probe)
    }
  } })
  const { app, win } = ctx
  const closeTab = async type => {
    const tab = win.locator(`.wb-tab[data-view-type="${type}"]`).last()
    // Single-tab groups reveal their close button only after hovering the tab.
    await tab.hover()
    await tab.locator('.wb-tab-close').click({ timeout: 5000 })
    await win.waitForTimeout(700)
  }
  const measure = () => win.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
    const groups = [...document.querySelectorAll('.dv-groupview')].filter(g => g.getBoundingClientRect().width > 0)
    const left = groups.find(g => g.querySelector('.t2s-srow-title'))
    const right = groups.find(g => g.querySelector('.wb-tab--icon:not(.wb-tab--left)'))
    return { left: left ? rect(left) : null, right: right ? rect(right) : null, groups: groups.map(rect), mains: groups.filter(g => g.querySelector('.wb-tab:not(.wb-tab--icon)')).map(rect), saved: localStorage.getItem('lcl.sideWidth2.amadeus') }
  })
  const startSampling = () => win.evaluate(() => {
    window.__splitWidths = []; window.__sampleSplit = true
    const sample = () => {
      if (!window.__sampleSplit) return
      const groups = [...document.querySelectorAll('.dv-groupview')]
      const left = groups.find(g => g.querySelector('.t2s-srow-title'))
      const right = groups.find(g => g.querySelector('.wb-tab--icon:not(.wb-tab--left)'))
      if (left) window.__splitWidths.push({ left: left.getBoundingClientRect().width, right: right?.getBoundingClientRect().width ?? null })
      requestAnimationFrame(sample)
    }
    sample()
  })
  const stopSampling = () => win.evaluate(() => { window.__sampleSplit = false; return window.__splitWidths })
  const stableFrames = (before, frames) => frames.length > 2 && frames.every(w => Math.abs(w.left - before.left.w) <= 2 && (!before.right || Math.abs(w.right - before.right.w) <= 2))
  try {
    await boot(app, win, { space: 'amadeus', width: 1512, height: 950 })
    if (mode === 'plugins') {
      await win.evaluate(() => localStorage.setItem('forsion_ui_zoom', '1.1'))
      await win.reload({ waitUntil: 'domcontentloaded' })
      await win.waitForSelector('.dv-groupview')
      await win.waitForTimeout(1500)
      R.check('Plugin coverage uses 110% UI zoom', await win.evaluate(() => Math.abs(Number(getComputedStyle(document.body).zoom) - 1.1) < 0.001))
    }
    await win.locator('.t2s-srow').filter({ has: win.locator('.t2s-srow-title', { hasText: /^Layout probe$/ }) }).first().click()
    await win.locator('.wikilink').filter({ hasText: 'Board.excalidraw' }).first().waitFor()
    await win.waitForTimeout(700)
    for (const scenario of ['default', 'custom']) {
      if (scenario === 'custom') {
        if (await win.evaluate(() => document.documentElement.dataset.mode !== 'dark')) {
          await win.locator('.rb-slot[data-id="rb-mode"] button').first().click()
        }
        if (await win.locator('.dv-edge-right').first().getAttribute('aria-pressed') !== 'true') await win.locator('.dv-edge-right').first().click()
        await win.waitForTimeout(600)
        const before = await measure()
        const sash = await win.evaluate(edge => [...document.querySelectorAll('.dv-sash')].map(e => {
          const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height, w: r.width }
        }).find(r => r.h > 100 && r.w < 20 && Math.abs(r.x - edge) < 10), before.left.x + before.left.w)
        if (!sash) throw new Error('Left sidebar sash not found')
        await win.mouse.move(sash.x, sash.y); await win.mouse.down()
        const zoom = await win.evaluate(() => Number(getComputedStyle(document.body).zoom) || 1)
        await win.mouse.move(sash.x + 345 * zoom - before.left.w, sash.y, { steps: 12 }); await win.mouse.up()
        await win.waitForTimeout(500)
        const custom = await measure()
        R.check('Real sidebar drag remains available', custom.left.w > before.left.w + 30 && Math.abs(JSON.parse(custom.saved)?.left - custom.left.w / zoom) <= 1, JSON.stringify(custom))
        R.check('Right sidebar is present for split coverage', !!custom.right)
      }
      const cases = [['Board.excalidraw', 'amadeus-drawing', '.amx-drawview .excalidraw canvas.interactive'], ['Table.db', 'amadeus-db', '.amx-dbview .amx-db']]
      if (mode === 'native') cases.push(['Reading.pdf', 'amadeus-pdf', '.amx-pdfview .textLayer span'])
      if (mode === 'plugins') cases.push(['Reading.pdf', 'amadeus-plugin-file', '.pr-root .textLayer span'], ['Notebook.ipynb', 'amadeus-plugin-file', '.nb .cm-editor'], ['Plugin.splitprobe', 'amadeus-plugin-file', '.split-probe-file'])
      for (const [target, type, content] of cases) {
        const before = await measure()
        await startSampling()
        await win.locator('.wikilink').filter({ hasText: target }).first().click()
        await win.waitForSelector(content, { timeout: 30000 })
        await win.waitForTimeout(900)
        const opened = await measure()
        const frames = await stopSampling()
        R.check(`${target}: real link creates a Main split`, opened.mains.length === before.mains.length + 1, JSON.stringify({ before, opened }))
        R.check(`${scenario}/${target}: sidebar widths stay fixed on every frame`, stableFrames(before, frames), JSON.stringify({ before, leftRange: [Math.min(...frames.map(w => w.left)), Math.max(...frames.map(w => w.left))] }))
        R.check(`${target}: sidebar preference stays unchanged`, before.saved === opened.saved, JSON.stringify({ before: before.saved, after: opened.saved }))
        await win.screenshot({ path: path.join(OUT, `${mode}-${scenario}-${target}-open.png`) })
        // Close the new split with the same tab close button used in the recording.
        await closeTab(type)
        const closed = await measure()
        R.check(`${target}: closing restores main area and keeps sidebars`, closed.mains.length === before.mains.length && Math.abs(closed.left.w - before.left.w) <= 2 && (!before.right || Math.abs(closed.right.w - before.right.w) <= 2) && closed.saved === before.saved, JSON.stringify(closed))
      }
      await win.locator('.wb-tab[data-view-type="amadeus-editor"]').last().click()
      const beforeCommand = await measure()
      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Backslash' : 'Control+Backslash')
      await win.waitForTimeout(500)
      const splitCommand = await measure()
      R.check(`${scenario}: split command creates a Main group and preserves shell widths`, splitCommand.mains.length === beforeCommand.mains.length + 1 && Math.abs(splitCommand.left.w - beforeCommand.left.w) <= 2 && splitCommand.saved === beforeCommand.saved, JSON.stringify(splitCommand))
      await closeTab('amadeus-editor')
    }
    if (mode === 'plugins') {
      // Use the public plugin view API through a real mounted contribution.
      await win.evaluate(() => {
        const a = document.createElement('a'); a.href = 'forsion://open?view=plugin:split-probe:workbench'; document.body.append(a); a.click(); a.remove()
      })
      await win.waitForSelector('.split-probe-owner', { timeout: 15000 })
      const draft = win.getByRole('textbox', { name: 'Owner draft' })
      await draft.fill('Owner draft survives companion folding')
      for (const visible of [true, false, true]) {
        const before = await measure()
        await startSampling()
        await win.locator(visible ? '[data-show]' : '[data-hide]').click()
        await win.waitForTimeout(600)
        const after = await measure()
        R.check(`Public plugin companion ${visible ? 'show' : 'hide'} preserves sidebars and preferences`, stableFrames(before, await stopSampling()) && after.saved === before.saved, JSON.stringify({ before, after }))
        R.check('Companion actually changes the Main split', after.mains.length === before.mains.length + (visible ? 1 : -1))
        R.check('Companion operation preserves owner draft', await draft.inputValue() === 'Owner draft survives companion folding')
      }
      await win.screenshot({ path: path.join(OUT, 'plugin-companion.png') })
      await closeTab('amadeus-editor')
      await win.evaluate(() => {
        const a = document.createElement('a'); a.href = 'forsion://open?view=plugin:bluebird:folder'; document.body.append(a); a.click(); a.remove()
      })
      await win.locator('.wb-tab[data-view-type="plugin:bluebird:folder"]').waitFor({ timeout: 15000 })
      await win.waitForSelector('.bb-root', { timeout: 15000 })
      await win.locator('.wb-tab[data-view-type="plugin:bluebird:folder"]').click()
      const before = await measure()
      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Backslash' : 'Control+Backslash')
      await win.waitForTimeout(800)
      const after = await measure()
      R.check('Actual Bluebird view splits without changing shell widths', after.mains.length === before.mains.length + 1 && Math.abs(after.left.w - before.left.w) <= 2 && after.saved === before.saved && await win.locator('.bb-root').count() === 2, JSON.stringify(after))
    }
    await win.screenshot({ path: path.join(OUT, `${mode}-closed.png`) })
  } finally { await ctx.close() }
}
async function main() {
  for (const mode of process.argv.includes('--plugins-only') ? ['plugins'] : EXTENDED ? ['native', 'plugins'] : ['base']) await run(mode)
  console.log(`Screenshots: ${OUT}`)
  process.exitCode = R.summary() ? 1 : 0
}
main().catch(e => { console.error(e); process.exitCode = 1 })
