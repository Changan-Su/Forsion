/** Real workspace device component + production styles in Chromium; no user data or live devices.
 * Run: npm run check:device-sidebar (HARNESS_URL selects an isolated worktree port).
 * Covers default fold, keyboard toggling, stale session hiding, roster changes and zh/en light/dark screenshots.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const url = new URL(process.env.HARNESS_URL || 'http://localhost:5173/harness.html')
url.pathname = '/run-location-harness.html'
const out = process.env.DEVICE_SIDEBAR_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-device-sidebar-'))
fs.mkdirSync(out, { recursive: true })

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  let passed = 0
  try {
    for (const config of [
      { name: 'light-zh', query: 'sidebar', width: 900 },
      { name: 'dark-zh', query: 'sidebar&dark&zoom=1.1', width: 900 },
      { name: 'narrow-en', query: 'sidebar&lang=en', width: 320 },
    ]) {
      const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: config.width, height: 720 } })
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e)))
      // The original picker harness initializes its stores before selecting the sidebar fixture.
      await page.route('http://127.0.0.1:41000/**', (route) => route.fulfill({ json: {} }))
      await page.route('http://127.0.0.1:41234/**', (route) => route.fulfill({ json: {} }))
      url.search = config.query
      await page.goto(url.toString())
      const fold = page.locator('[data-device-offline-toggle]')
      await fold.waitFor()
      assert.equal(await fold.getAttribute('aria-expanded'), 'false')
      assert.match(await fold.innerText(), config.name === 'narrow-en' ? /Offline devices\s*14/ : /离线设备\s*14/)
      assert.equal(await page.locator('[data-device-section]').count(), 1)
      await page.screenshot({ path: path.join(out, `${config.name}-collapsed.png`) })
      await fold.focus()
      await page.keyboard.press('Enter')
      assert.equal(await fold.getAttribute('aria-expanded'), 'true')
      assert.equal(await page.locator('[data-device-status="offline"]').count(), 14)
      assert.equal(await page.locator('[data-device-status="offline"] [data-remote-session]').count(), 0)
      await page.screenshot({ path: path.join(out, `${config.name}-expanded.png`) })
      await page.keyboard.press('Space')
      assert.equal(await fold.getAttribute('aria-expanded'), 'false')
      assert.equal(await page.locator('[data-device-section]').count(), 1)
      await page.evaluate(() => window.__deviceSidebar.setOnline(window.__deviceSidebar.offlineId, true))
      await page.waitForFunction(() => document.querySelector('[data-device-offline-toggle]')?.textContent.includes('13'))
      assert.equal(await page.locator('[data-device-section]').count(), 2)
      await page.evaluate(() => window.__deviceSidebar.setAllOnline())
      await fold.waitFor({ state: 'detached' })
      assert.equal(await page.locator('[data-device-section]').count(), 15)
      assert.deepEqual(errors, [])
      passed++
      console.log(`PASS ${config.name}: default fold, Enter/Space, reconnect and empty group`)
      await page.close()
    }
    console.log(`${passed}/3 configurations passed. Screenshots: ${out}`)
  } finally { await browser.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
