/** Real desktop layout regression: note heads, Better PDF and Browser share tab-strip navigation.
 * Build first. PDF_PLUGIN_ROOT optionally points to a built Better PDF package (copied into an isolated home).
 * Run npm run check:viewnav. No user data or external web pages are opened.
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const { PDFDocument } = require('pdf-lib')
const { launch, boot, shotDir, makeReporter } = require('./lib/uiux-electron.cjs')
const out = shotDir('view-navigation'), report = makeReporter()
const plugin = process.env.PDF_PLUGIN_ROOT
const markup = '<!doctype html><meta charset="utf-8"><title>Navigation fixture</title><style>body{font:16px system-ui;margin:32px;background:#faf9f6;color:#30322d}h1{font-size:28px}a{color:#596f51}</style><h1>Reading guide</h1><p>A local page for checking the browser and View navigation.</p><a href="/chapter">Continue to chapter two</a>'

async function main() {
  const pdf = await PDFDocument.create(), p = pdf.addPage([595, 842])
  p.drawText('Reading reference', { x: 50, y: 760, size: 24 })
  p.drawText('A local PDF for checking the View layout.', { x: 50, y: 720, size: 14 })
  const bytes = await pdf.save()
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(markup) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  let env
  const errors = []
  try {
    env = await launch({ tag: 'view-navigation', beforeLaunch: ({ home, vault }) => {
      if (plugin) fs.cpSync(plugin, path.join(home, 'plugins/pdf-reader'), { recursive: true })
      fs.writeFileSync(path.join(vault, 'Reading reference.pdf'), bytes)
      fs.writeFileSync(path.join(vault, 'Reading notes.md'), '# Reading notes\n\nFirst page of the navigation check.\n\n[[Research index]]\n')
      fs.writeFileSync(path.join(vault, 'Research index.md'), '# Research index\n\nSecond page of the navigation check.\n\n[[Reading notes]]\n')
    } })
    const { app, win } = env
    win.on('pageerror', e => errors.push(e.message))
    await boot(app, win, { space: 'amadeus', width: 1512, height: 900 })
    const open = async title => {
      await win.locator('.t2s-srow').filter({ hasText: title }).first().click()
      await win.waitForTimeout(600)
    }
    await open('Reading notes')
    await open('Research index')
    const leafId = await win.locator('.dv-prefix .lcl-viewnav').filter({ has: win.locator('button[data-press="back"]:enabled') }).first().getAttribute('data-view-nav')
    const nav = win.locator(`[data-view-nav="${leafId}"]`)
    await nav.locator('[data-press="back"]').click()
    await win.waitForTimeout(650)
    report.check('Note back restores the previous note', await win.locator('.wb-view--main').filter({ hasText: 'First page of the navigation check.' }).count() > 0)
    await nav.locator('[data-press="forward"]').click()
    await win.waitForTimeout(650)
    report.check('Note forward restores the next note', await win.locator('.wb-view--main').filter({ hasText: 'Second page of the navigation check.' }).count() > 0)
    report.check('Note toolbar has no duplicate navigation', await win.locator('.wb-view .lcl-viewnav, .wb-view .lcl-viewnav-fallback').count() === 0)
    await win.screenshot({ path: path.join(out, 'notes.png') })
    await open('Reading reference')
    if (plugin) await win.waitForSelector('.pr-root .page', { timeout: 30000 })
    else await win.waitForTimeout(1000)
    await win.locator('.wb-view--main').filter({ visible: true }).last().click({ position: { x: 330, y: 200 } })
    await win.keyboard.press('Meta+Backslash')
    await win.waitForTimeout(700)
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.send('app:open-url', url, true), origin + '/reading')
    await win.waitForSelector('webview', { timeout: 20000 })
    await win.waitForTimeout(1600)
    const geometry = await win.evaluate(() => {
      const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom } }
      const hosts = [...document.querySelectorAll('.wb-view--main')].filter(e => e.getBoundingClientRect().width > 0)
      const bars = [...document.querySelectorAll('.dv-tabs-and-actions-container')].filter(e => e.querySelector('.dv-prefix .lcl-viewnav') && e.getBoundingClientRect().width > 0)
      const pdf = document.querySelector('.pr-root')
      const browser = document.querySelector('webview')?.parentElement?.parentElement
      return { hosts: hosts.map(rect), bars: bars.map(rect), navCounts: bars.map(e => e.querySelectorAll('.lcl-viewnav').length), pdf: pdf && rect(pdf), browser: browser && rect(browser), extraRows: document.querySelectorAll('.wb-view .lcl-viewnav-fallback').length }
    })
    report.check('Each split has one tab-strip navigation pair', geometry.bars.length === 2 && geometry.navCounts.every(n => n === 1), JSON.stringify(geometry))
    report.check('Browser content starts immediately below its tab strip', geometry.browser && geometry.bars.some(b => geometry.browser.x >= b.x && geometry.browser.x < b.x + b.width && Math.abs(b.bottom - geometry.browser.y) < 3))
    if (plugin) report.check('Better PDF content starts immediately below its tab strip', geometry.pdf && geometry.bars.some(b => geometry.pdf.x >= b.x && geometry.pdf.x < b.x + b.width && Math.abs(b.bottom - geometry.pdf.y) < 3))
    report.check('No content navigation fallback row remains', geometry.extraRows === 0)
    for (const [name, width, mode, skin] of [['split-light', 1512, 'light', 'cream'], ['split-dark', 1512, 'dark', 'cream'], ['split-narrow', 1000, 'light', 'sage']]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width)
      await win.evaluate(({ mode, skin }) => { document.documentElement.dataset.mode = mode; document.documentElement.classList.toggle('dark', mode === 'dark'); document.documentElement.dataset.skin = skin }, { mode, skin })
      await win.waitForTimeout(450)
      await win.screenshot({ path: path.join(out, name + '.png') })
    }
    report.check('Renderer has no uncaught errors', errors.length === 0, JSON.stringify(errors))
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ results: report.results, geometry, errors, betterPdf: !!plugin }, null, 2))
    process.exitCode = report.summary() ? 1 : 0
  } catch (e) { if (env) await env.win.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw e }
  finally { if (env) await env.close(); await new Promise(r => server.close(r)) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
