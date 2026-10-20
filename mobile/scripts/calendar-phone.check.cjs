/** Full mobile entry + single-column shell, actual local vault bridge; Chromium touch input, native chrome stand-in. */
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { chromium } = require('../../desktop/node_modules/playwright-core')
const { findChromium } = require('../../desktop/scripts/lib/find-chromium.cjs')
const { stubApi, installChrome, stage, moduleUrl, loaded, SCREEN } = require('./phone-stage.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.CALENDAR_PHONE_OUT || path.join(os.tmpdir(), 'forsion-calendar-phone-shell')
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { createServer } = await import('vite')
  const server = await createServer({ root: ROOT, server: { port: 5296, strictPort: true } })
  await server.listen()
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const errors = [], unknown = new Set()
  try {
    const context = await browser.newContext({ viewport: SCREEN, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await context.addInitScript(() => {
      localStorage.setItem('forsion_tangu_onboarding_done', '1')
      localStorage.setItem('forsion_token', 'stage')
      localStorage.setItem('amadeus_vault_mode', 'local')
    })
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('request', (r) => { const u = new URL(r.url()); if (/\.(tsx?|jsx?)$/.test(u.pathname)) loaded.set(u.pathname, u.pathname + u.search) })
    await stubApi(page, unknown)
    await page.goto('http://localhost:5296/', { waitUntil: 'domcontentloaded' })
    await page.locator('.mb-shell').waitFor({ timeout: 180000 })
    await installChrome(page)
    // Seed through the real mobile filesystem bridge, then use the same stores all calendar sources consume.
    await page.evaluate(async ({ pageUrl, dbUrl, configUrl, navUrl }) => {
      const { usePageStore } = await import(pageUrl)
      const { useDbStore } = await import(dbUrl)
      const { useCalendarConfig } = await import(configUrl)
      const { useCalendarNav } = await import(navUrl)
      await usePageStore.getState().restoreVault()
      const now = new Date(), p = (n) => String(n).padStart(2, '0')
      const day = `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}`
      const data = { version: 1, name: 'Phone events', columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }], rows: [
        { id: 'short', body: '# Phone body', cells: { name: 'Phone stand-up', date: `${day}T11:30/${day}T11:45` } },
      ] }
      await window.amadeus.writeDatabase('Phone.db', data)
      await usePageStore.getState().refreshStructure()
      await useDbStore.getState().reload('Phone.db', 'Phone.db')
      useCalendarConfig.getState().migrate(usePageStore.getState().vaultRoot, [{ dbPath: 'Phone.db', dateCol: 'date' }])
      useCalendarNav.getState().setMode('3day')
      window.__phoneCal = { useDbStore, useCalendarNav, day }
    }, {
      pageUrl: moduleUrl('../desktop/frontend/src/amadeus/store/pageStore.ts'),
      dbUrl: moduleUrl('../desktop/frontend/src/amadeus/store/dbStore.ts'),
      configUrl: moduleUrl('../desktop/frontend/src/amadeus/store/calendarConfigStore.ts'),
      navUrl: moduleUrl('../desktop/frontend/src/amadeus/store/calendarNavStore.ts'),
    })
    await stage.space(page, 'calendar')
    await page.locator('[data-key="Phone.db::short"]').waitFor({ timeout: 15000 })
    await page.evaluate(() => {
      const sc = document.querySelector('.amx-cal-tscroll'), cell = document.querySelector(`.amx-cal-daycol2[data-date="${window.__phoneCal.day}"]`)
      sc.scrollLeft = cell.offsetLeft
      const px = parseFloat(getComputedStyle(document.querySelector('.amx-cal-timerow')).getPropertyValue('--amx-hour-px')) || 44
      sc.scrollTop = cell.offsetTop + 10 * px
    })
    await page.waitForTimeout(200)
    const event = page.locator('[data-key="Phone.db::short"]'), r = await event.boundingBox()
    await page.touchscreen.tap(r.x + r.width/2, r.y + 3)
    await page.locator('.amx-cal-drawer').waitFor()
    assert.equal((await stage.state(page)).mode, 'page', 'drawer hides native dock through the real chrome seam')
    const drawer = await page.locator('.amx-cal-drawer').boundingBox()
    assert.ok(Math.abs(drawer.y + drawer.height - SCREEN.height) < 2, 'drawer sits on screen bottom')
    await page.screenshot({ path: path.join(OUT, 'phone-shell-drawer.png') })
    await page.getByRole('button', { name: '事件操作', exact: true }).tap()
    await page.getByRole('menuitem', { name: '克隆', exact: true }).tap()
    await page.waitForFunction(() => window.__phoneCal.useDbStore.getState().entries['Phone.db'].data.rows.length === 2)
    await page.evaluate(() => window.__phoneCal.useDbStore.getState().flushAll(true))
    assert.equal(await page.evaluate(async () => (await window.amadeus.readDatabase('Phone.db', 'Phone.db')).data.rows.length), 2, 'phone clone persisted through mobile bridge')
    await page.getByRole('button', { name: '事件操作', exact: true }).tap()
    await page.getByRole('menuitem', { name: '删除', exact: true }).tap()
    await page.getByRole('button', { name: '撤销', exact: true }).tap()
    await page.evaluate(() => window.__phoneCal.useDbStore.getState().flushAll(true))
    assert.equal(await page.evaluate(async () => (await window.amadeus.readDatabase('Phone.db', 'Phone.db')).data.rows.length), 2, 'phone delete and notification undo persisted')
    assert.equal(errors.length, 0, errors.join('\n'))
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ passed: 5, errors, unknown: [...unknown], vehicle: 'full mobile entry + real local bridge + Chromium touch, native chrome stand-in' }, null, 2))
    console.log(`PASS mobile shell: short tap, dock, clone persistence, delete/undo persistence, no exceptions. ${OUT}`)
  } finally { await browser.close(); await server.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
