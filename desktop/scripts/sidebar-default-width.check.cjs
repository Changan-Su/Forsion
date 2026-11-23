/** Saved sidebar widths must survive normal loads, reset explicitly, and return on undo.
 * npm run check:sidebar-default-width. Real WorkspaceHost in an isolated browser profile. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { build } = require('esbuild')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const root = path.resolve(__dirname, '..')
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-default-width-'))
const key = 'lcl.sideWidth2.layout-probe'
const remembered = { left: 606, right: 380, bottomH: 260 }
async function main() {
  await build({ entryPoints: [path.join(__dirname, 'fixtures/lcl-layout.tsx')], outfile: path.join(out, 'app.js'), bundle: true,
    platform: 'browser', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')],
    alias: { '@lcl': path.resolve(root, '../lcl'), '@': path.join(root, 'frontend/src') },
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl' }, logLevel: 'warning' })
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"><style>
    *{box-sizing:border-box}html,body,#root{margin:0;width:100%;height:100%}.probe-shell{height:100%;display:flex;background:var(--sidebar-bg)}.probe-ribbon{width:44px;flex:none;padding:14px}main{flex:1;min-width:0;display:flex;flex-direction:column}header,footer{height:32px;flex:none;padding:6px 16px}section{flex:1;min-height:0;position:relative}.probe-content{height:100%;padding:14px;overflow:auto}.probe-content textarea,.probe-content iframe{width:100%}
    </style></head><body><div id="root"></div><script src="app.js"></script></body></html>`)
  const server = http.createServer((req, res) => {
    const file = path.join(out, req.url === '/' ? 'index.html' : req.url.split('?')[0])
    if (req.url === '/blank.html') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>blank</title>'); return }
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
    res.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() })
  try {
    const page = await browser.newPage({ viewport: { width: 1862, height: 821 }, deviceScaleFactor: 1.375 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const settled = () => page.waitForFunction(() => probe.coordinator() && !probe.coordinator().busy && document.querySelector('.wb-workspace-viewport')?.dataset.layoutPhase === 'settled')
    const app = `http://127.0.0.1:${server.address().port}/`
    // Seed storage from a same-origin blank page: on the app page the debounced layout save can land after
    // localStorage.clear(), so the next load silently took the restore path instead of the default build.
    const seed = async (fn, arg) => { await page.goto(`${app}blank.html`); await page.evaluate(fn, arg); await page.goto(app); await settled() }
    const measure = () => page.evaluate(key => ({ widths: { ...probe.ws.getState().sideWidths },
      groups: Object.fromEntries(probe.ws.getState().api.groups.map(g => [g.panels[0]?.params.__loc, g.api.width])),
      saved: JSON.parse(localStorage.getItem(key)), other: localStorage.getItem('lcl.sideWidth2.other-space') }), key)
    // 1. No saved layout: the default builder runs.
    await seed(({ key, remembered }) => {
      localStorage.clear()
      localStorage.setItem(key, JSON.stringify(remembered))
      localStorage.setItem('lcl.sideWidth2.other-space', JSON.stringify({ left: 450 }))
    }, { key, remembered })
    assert.equal(await page.evaluate(() => probe.bootFellThrough()), true, 'first load builds the default layout')
    assert.equal((await measure()).groups.left, 606, 'default build preserves a saved width')
    // 2. Saved layout (the ordinary restart): restore skips the builder, the remembered width still wins over
    // the width serialized in the layout.
    const layoutKey = await page.evaluate(() => probe.layoutKey)
    await page.waitForFunction(layoutKey => localStorage.getItem(layoutKey) !== null, layoutKey)
    await seed(({ key, layoutKey }) => {
      if (localStorage.getItem(layoutKey) === null) throw new Error('layout was not saved')
      localStorage.setItem(key, JSON.stringify({ left: 520 }))
    }, { key, layoutKey })
    assert.equal(await page.evaluate(() => probe.bootFellThrough()), false, 'second load restores the saved layout')
    assert.equal((await measure()).groups.left, 520, 'restored layout uses the remembered width')
    await seed(({ key, remembered }) => localStorage.setItem(key, JSON.stringify(remembered)), { key, remembered })
    assert.equal(await page.evaluate(() => probe.bootFellThrough()), false)
    assert.equal((await measure()).groups.left, 606, 'ordinary load preserves a saved width')
    await page.screenshot({ path: path.join(out, 'before.png'), scale: 'css' })
    await page.locator('.dv-edge-reset').click()
    await settled()
    const reset = await measure()
    assert.equal(reset.groups.left, 280, 'explicit reset returns the left side to its default')
    assert.equal(reset.groups.right, 300, 'explicit reset returns the right side to its default')
    assert.deepEqual(reset.widths, { left: null, right: null, bottom: null })
    assert.equal(reset.saved, null, 'reset removes the current Space width preference')
    assert.equal(reset.other, JSON.stringify({ left: 450 }), 'other Spaces keep their widths')
    await page.screenshot({ path: path.join(out, 'reset.png'), scale: 'css' })
    assert.equal(await page.evaluate(() => probe.ws.getState().undoResetLayout()), true)
    await settled()
    const undone = await measure()
    assert.equal(undone.groups.left, 606, 'undo restores the original left width')
    assert.equal(undone.groups.right, 380, 'undo restores the original right width')
    assert.deepEqual(undone.saved, remembered, 'undo restores all remembered dimensions')
    await page.evaluate(() => probe.ws.getState().resetLayout({ undoable: true }))
    await settled()
    await page.reload()
    await settled()
    assert.equal((await measure()).groups.left, 280, 'reset survives reload')
    assert.deepEqual(errors, [])
    console.log('PASS saved widths, explicit reset, Space isolation, undo and reload')
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => console.log(`Artifacts: ${out}`))
