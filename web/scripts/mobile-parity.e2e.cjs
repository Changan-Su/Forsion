/** Real built Web mobile shell, with isolated browser storage and fixture APIs. No native host or live account.
 * Run after web build: npm run e2e:mobile. Saves screenshots and a machine-readable report. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('../../desktop/node_modules/playwright-core')
const { startPreview } = require('../../mobile/scripts/lib/preview.cjs')
const { startStubEngine } = require('../../desktop/scripts/lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.resolve(process.env.OUT || path.join(ROOT, 'outputs/mobile-parity'))
const results = []
fs.mkdirSync(OUT, { recursive: true })
function executable() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  if (fs.existsSync(chromium.executablePath())) return chromium.executablePath()
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const dir of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const file = path.join(root, dir, rel)
        if (fs.existsSync(file)) return file
      }
    }
  }
  throw new Error('Install Chromium or set CHROMIUM_EXE')
}
const session = (id, title) => ({ id, title, summary: 'Fixture preview', model_id: 'fixture-model', archived: false,
  emoji: null, agent_config: { execMode: 'host', approvalMode: 'auto-edit' }, project_path: null, project_name: null,
  projectless: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
const messages = [{ id: 'fixture-message', role: 'model', content: 'Fixture reply', timestamp: Date.now(), model_id: 'fixture-model' }]

async function main() {
  const preview = await startPreview(ROOT)
  await preview.ready()
  const stub = await startStubEngine({ sessions: [session('fixture-one', 'Fixture session one'), session('fixture-two', 'Fixture session two')], messages,
    models: [{ id: 'fixture-model', name: 'Fixture model', provider: 'Fixture', source: 'forsion', modelType: 'llm' }] })
  const browser = await chromium.launch({ executablePath: executable(), headless: true })
  try {
    for (const config of [{ width: 390, locale: 'zh-CN', mode: 'light' }, { width: 320, locale: 'en-GB', mode: 'dark' }]) {
      const ctx = await browser.newContext({ viewport: { width: config.width, height: 844 }, hasTouch: true, isMobile: true, locale: config.locale })
      const errors = []
      await ctx.addInitScript((cfg) => {
        localStorage.setItem('forsion_token', 'fixture-only')
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('tangu_locale', cfg.locale.startsWith('zh') ? 'zh' : 'en')
        localStorage.setItem('forsion_theme', cfg.mode)
        localStorage.setItem('forsion_theme_lang', 'lovable')
      }, config)
      await ctx.route('**/api/**', async (route) => {
        const u = new URL(route.request().url())
        const p = u.pathname.replace(/^\/api/, '')
        const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
        if (p === '/auth/me') return json({ id: 'fixture-user', username: 'Fixture' })
        if (p === '/auth/region') return json({ country: 'GB' })
        if (p === '/amadeus/vaults') return json({ vaults: [{ id: 'default', name: 'Fixture vault', lastChangeSeq: 1, sizeBytes: 0, createdAt: new Date().toISOString() }] })
        if (p.endsWith('/tree')) return json({ pages: ['Fixture note.md'], folders: [], files: [], seq: 1 })
        if (p.endsWith('/file')) return json({ path: 'Fixture note.md', kind: 'page', content: '# Fixture note\n\nFixture body.\n', seq: 1, hash: 'fixture', updatedAt: new Date().toISOString() })
        if (p.endsWith('/asset-token')) return json({ token: 'fixture-asset', ttlSec: 300 })
        if (/\/events$|\/stream$/.test(p)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
        const response = await route.fetch({ url: stub.url + p + u.search })
        return route.fulfill({ response })
      })
      const page = await ctx.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/before-forsion', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Before Forsion</title><p>Previous page</p>' }))
      await page.goto(preview.url + 'before-forsion')
      await page.goto(preview.url, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-browser-mobile-chrome]', { timeout: 60_000 })
      await page.waitForTimeout(1600)
      const check = async (name, fn) => {
        try { await fn(); results.push({ name: `${config.width}/${config.locale}/${config.mode}: ${name}`, ok: true }); console.log('PASS', name) }
        catch (error) {
          results.push({ name, ok: false, error: String(error) })
          const geometry = await page.evaluate(() => [...document.querySelectorAll('.bmc-chrome,.bmc-top,.bmc-dock,.bmc-capsule,.mb-shell')].map((el) => {
            const c = getComputedStyle(el); return { class: el.className, mode: el.getAttribute('data-mode'), text: el.textContent, rect: el.getBoundingClientRect().toJSON(), css: { position: c.position, display: c.display, visibility: c.visibility, opacity: c.opacity, zIndex: c.zIndex, zoom: c.zoom } }
          }))
          fs.writeFileSync(path.join(OUT, `fail-${results.length}.json`), JSON.stringify({ geometry, errors }, null, 2))
          await page.screenshot({ path: path.join(OUT, `fail-${results.length}.png`) })
          throw error
        }
      }
      const sheet = () => page.locator('[data-browser-mobile-sheet]')
      const closeSheet = () => page.locator('.bmc-sheet-head > button').last().click()
      const item = (id) => page.locator(`[data-sheet-item="${id}"] > button.bmc-sheet-row`)
      await check('touch viewport automatically installs mobile dock', async () => {
        // Product default remains Tangu; explicitly visit Home for the home screenshot below.
        assert.equal(await page.locator('.mb-shell').getAttribute('data-space'), 'tangu')
        assert(await page.locator('.bmc-dock [data-space]').count() > 1)
        assert.equal(await page.locator('.mb-drawer-foot').count(), 0)
        const hit = await page.locator('.bmc-dock').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })
        assert(hit, 'Dock fits the viewport')
      })
      await page.locator('.bmc-dock [data-space="home"]').click()
      await page.waitForSelector('.mb-shell[data-space="home"]')
      await page.screenshot({ path: path.join(OUT, `home-${config.width}-${config.mode}.png`) })
      await check('all Spaces and dock picks stay usable and save on close', async () => {
        await page.locator('[data-chrome-action="spacesAll"]').click()
        await item('dock:edit').click()
        await page.waitForSelector('[data-browser-mobile-sheet="checklist"]')
        await sheet().evaluate((el) => { el.dataset.stable = 'same-sheet' })
        const toggles = sheet().locator('input[type=checkbox]')
        const n = await toggles.count()
        assert(n > 3)
        for (let i = 0; i < n; i++) if (await toggles.nth(i).isChecked()) await toggles.nth(i).uncheck()
        await toggles.nth(n - 1).check()
        assert.equal(await sheet().getAttribute('data-stable'), 'same-sheet')
        await closeSheet()
        assert((await page.evaluate(() => JSON.parse(localStorage.getItem('lcl_dock_pins_v1')))).length === 1)
        await page.reload()
        await page.waitForSelector('.bmc-dock')
        assert.equal(await page.locator('.bmc-dock [data-space]').count(), 2)
      })
      await check('Space list is first level; session opens detail and Back returns to the list', async () => {
        await page.locator('[data-chrome-action="spacesAll"]').click()
        await item('space:tangu').click()
        await page.waitForSelector('.mb-shell[data-nav="list"]')
        await page.getByText('Fixture session one', { exact: true }).click()
        await page.waitForSelector('.mb-shell[data-nav="detail"]')
        assert.equal(await page.locator('.bmc-dock').count(), 0)
        assert(await page.locator('[data-chrome-action="left"] svg').count())
        await page.locator('[data-chrome-action="left"]').click()
        await page.waitForSelector('.mb-shell[data-nav="list"]')
        await page.getByText('Fixture session one', { exact: true }).click()
        await page.waitForSelector('.mb-shell[data-nav="detail"]')
        await page.waitForTimeout(150)
        await page.goBack()
        await page.waitForSelector('.mb-shell[data-nav="list"]')
      })
      await page.screenshot({ path: path.join(OUT, `sessions-${config.width}-${config.mode}.png`) })
      await check('view search and More use mobile actions; browser Back closes the sheet', async () => {
        await page.locator('[data-chrome-action="search"]').click()
        // QuickFind uses the shared command overlay.
        assert(await page.locator('.cmd-overlay').count())
        await page.goBack()
        await page.waitForTimeout(200)
        assert.equal(await page.locator('.cmd-overlay').count(), 0)
        await page.locator('[data-chrome-action="more"]').click()
        await page.waitForSelector('[data-browser-mobile-sheet="menu"]')
        assert(await sheet().locator('[data-sheet-item="rb-cmd"]').count())
        await page.waitForTimeout(100)
        await page.goBack()
        await page.waitForSelector('[data-browser-mobile-sheet]', { state: 'detached' })
      })
      await check('account menu reaches settings; mobile page header Back and Close work', async () => {
        await page.locator('[data-chrome-action="account"]').click()
        await item('rb-settings').click()
        await page.waitForSelector('.settings-page--mobile')
        assert.equal(await page.locator('[data-browser-mobile-chrome]').getAttribute('data-mode'), 'page')
        const header = await page.locator('[data-chrome-action="back"]').evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint((r.left+r.right)/2, (r.top+r.bottom)/2)?.closest('button') === el })
        assert(header, 'Back is not blocked by settings')
        await page.screenshot({ path: path.join(OUT, `settings-${config.width}-${config.mode}.png`) })
        await page.locator('.settings-mobile-row').filter({ has: page.locator('strong', { hasText: config.locale.startsWith('zh') ? /^外观$/ : /^Appearance$/ }) }).click()
        await page.waitForSelector('[data-chrome-action="close"]')
        await page.locator('[data-chrome-action="back"]').click()
        await page.waitForSelector('.settings-page--mobile-menu')
        await page.waitForTimeout(100)
        await page.goBack()
        await page.waitForSelector('.settings-page--mobile', { state: 'detached' })
      })
      await check('return Home then browser Back leaves the app; no empty-page trap', async () => {
        await page.locator('.bmc-dock [data-space="home"]').click()
        await page.waitForSelector('.mb-shell[data-space="home"]')
        await page.waitForTimeout(250)
        await page.goBack()
        await page.waitForFunction(() => document.title === 'Before Forsion')
        assert.equal(errors.length, 0, errors.join('\n'))
      })
      await ctx.close()
    }
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await desktop.addInitScript(() => { localStorage.setItem('forsion_token', 'fixture-only'); localStorage.setItem('forsion_tangu_onboarding_done', '1') })
    await desktop.route('**/api/**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ username: 'Fixture', ok: true, sessions: [], agents: [], models: [], items: [], vaults: [] }) }))
    const desktopPage = await desktop.newPage()
    await desktopPage.goto(preview.url)
    await desktopPage.waitForSelector('.shell', { timeout: 60_000 })
    assert.equal(await desktopPage.locator('[data-browser-mobile-chrome]').count(), 0)
    results.push({ name: 'Desktop browser retains desktop shell', ok: true })
    await desktop.close()
  } finally {
    await browser.close()
    preview.kill()
    await stub.close()
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
  }
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
