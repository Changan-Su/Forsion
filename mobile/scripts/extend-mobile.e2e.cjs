/** Real bundled Extend × mobile production app. API fixtures only; no injected plugin registrations.
 * Build: FORSION_EXTEND_TEST_ROOT=<Extend checkout> npm run build -- --mode extend-test
 * Or npm run build with the official signed staged archive. Then npm run e2e:extend.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { startPreview } = require('./lib/preview.cjs')
const { chromium } = require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
function executable() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((s) => s.startsWith('chromium-')).sort().reverse()) {
    for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
      const p = path.join(root, d, rel); if (fs.existsSync(p)) return p
    }
  }
  throw new Error('Set CHROMIUM_EXE')
}
;(async () => {
  const locale = process.env.MOBILE_EXTEND_LOCALE || 'en-GB'
  const root = path.resolve(__dirname, '..'), shots = path.join(root, process.env.MOBILE_EXTEND_SHOTS || 'outputs/extend-mobile')
  const accountName = 'legacy-account-with-a-very-long-name'
  const legacyName = locale.startsWith('zh') ? '旧账号保留的很长的云盘文件名称，需要在手机中正常显示和下载.txt' : 'Existing account document with a long legacy filename for mobile layout.txt'
  fs.mkdirSync(shots, { recursive: true })
  const preview = await startPreview(root)
  let browser
  const errors = [], uploads = [], requests = [], files = [{ id: 'legacy-file', name: legacyName, fileType: 'file', fileSize: 19, updatedAt: '2026-10-01T00:00:00Z' }]
  try {
    await preview.ready()
    browser = await chromium.launch({ executablePath: executable(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale, acceptDownloads: true })
    await ctx.addInitScript((locale) => {
      if (!localStorage.getItem('forsion_token')) localStorage.setItem('forsion_token', 'legacy-account-token')
      localStorage.setItem('forsion_tangu_onboarding_done', '1')
      localStorage.setItem('tangu_locale', locale.startsWith('zh') ? 'zh' : 'en')
      localStorage.setItem('forsion.mobile.legacy-note', 'Preserve local notes and selected vault')
    }, locale)
    await ctx.route('**/api/**', async (route) => {
      const request = route.request(), url = new URL(request.url()), p = url.pathname
      requests.push({ p, token: request.headers().authorization, method: request.method() })
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,x-project-source', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      const json = (v, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(v) })
      if (p === '/api/auth/me') return json({ id: 'legacy-user', username: accountName, nickname: locale.startsWith('zh') ? '旧账号已有的很长的个人显示名称' : 'Existing account with a long display name', role: 'USER', email: 'legacy@example.test' })
      if (p === '/api/files/upload') {
        uploads.push(request.postDataBuffer().toString())
        assert.equal(request.headers().authorization, 'Bearer legacy-account-token')
        assert.equal(request.headers()['x-project-source'], 'penzor')
        files.push({ id: 'upload-file', name: 'Mobile upload.txt', fileType: 'file', fileSize: 25, updatedAt: new Date().toISOString() })
        return json({ id: 'upload-file' }, 201)
      }
      if (p === '/api/files/legacy-file/content') return route.fulfill({ status: 200, headers: cors, contentType: 'text/plain', body: 'Legacy account bytes' })
      if (p === '/api/files') return json(files)
      if (p === '/api/storage/quota') return json({ used: 19, quota: 1024 * 1024 })
      if (p === '/api/storage/files-by-app') return json({ apps: [{ appId: 'penzor', bytes: 19, files: files.length }], largest: [] })
      if (p === '/api/remotesync/vaults') return json({ vaults: [{ vault: 'Existing desktop vault', bytes: 10, files: 1 }] })
      if (p === '/api/amadeus/vaults') return json({ vaults: [] })
      if (p === '/api/exports/list') return json({ files: [], total: 0, totalBytes: 0 })
      if (p === '/api/trash') return json([])
      if (p === '/api/storage/source-trash/ama') return json({ entries: [] })
      if (p === '/api/market/items') return json({ items: [] })
      if (p === '/api/market/types') return json({ types: ['amadeus-plugin'] })
      if (p === '/api/token-quota/my') return json({ dailyLimit: 100, dailyRemaining: 100, weeklyLimit: 1000, weeklyRemaining: 900 })
      if (p === '/api/membership/my') return json({ membership: { tier: 'pro', status: 'active', plan: { name: locale.startsWith('zh') ? '旧账号已有的很长的专属会员方案名称' : 'Existing membership with a very long legacy plan name' } } })
      if (p === '/api/credits/balance') return json({ balance: 75 })
      if (p === '/api/features') return json({ shop: true })
      if (p === '/api/payment/offerings') return json({ membershipPlans: [{ id: 'pro', name: 'Pro fixture', priceMonthly: 10, isActive: true }], packages: [{ id: 'points', name: '100 points fixture', credits: 100, price: 1, isActive: true }] })
      if (p === '/api/shop/products') return json([{ id: 'quota-card', name: 'Quota reset card fixture', description: 'Existing account item', type: 'reset_card', pricePoints: 10, isActive: true }])
      if (p.startsWith('/api/agent/')) return route.abort()
      return json({}, 404)
    })
    const page = await ctx.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', (e) => errors.push(e.message))
    const cdp = await ctx.newCDPSession(page)
    const tap = async (loc) => {
      await loc.waitFor({ state: 'visible' }); await loc.scrollIntoViewIfNeeded()
      const box = await loc.boundingBox(); assert(box, 'tap target has geometry')
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(400)
    }
    const closeLeft = async () => { const close = page.locator('.mb-drawer--left.open [aria-label="close"]'); if (await close.count()) await tap(close) }
    const geometry = async (selector, name, shop = false) => {
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(150)
        const m = await page.locator(selector).evaluate((el, shop) => {
          const rect = el.getBoundingClientRect()
          const result = { width: rect.width, viewport: innerWidth, overflow: el.scrollWidth > el.clientWidth + 1, overlaps: false }
          if (shop) {
            const stats = el.querySelectorAll('.fx-shop-stat')
            const plan = stats[0].querySelector('b'), balance = stats[1].querySelector('b').getBoundingClientRect()
            const range = document.createRange(); range.selectNodeContents(plan)
            result.overlaps = [...range.getClientRects()].some(r => r.left < balance.right - 1 && r.right > balance.left + 1 && r.top < balance.bottom - 1 && r.bottom > balance.top + 1)
          }
          return result
        }, shop)
        assert(m.width <= width + 1 && !m.overflow && !m.overlaps, `${name} ${locale}/${width}: ${JSON.stringify(m)}`)
        await page.screenshot({ path: path.join(shots, `${name}-${width}.png`) })
      }
    }


    await page.goto(preview.url, { waitUntil: 'domcontentloaded' })
    await page.locator('.mb-topbar [aria-label="more"]').waitFor({ timeout: 30000 })
    await page.waitForTimeout(1800)
    const bundle = await page.evaluate(async () => (await window.amadeus.listPlugins()).find((p) => p.id === 'forsion-extend'))
    assert(bundle && bundle.locked && bundle.preinstalled && bundle.code.length > 100000, 'actual Extend is loaded from app bundle')
    assert.equal(await page.evaluate(() => typeof window.tangu.cloudInvoke), 'undefined', 'private cloudInvoke is not exposed on host')
    await tap(page.locator('.mb-topbar [aria-label="left panel"]'))
    await tap(page.locator('.mb-drawer--left [aria-label="settings"]'))
    await page.locator('[data-settings-tab="forsion"]').waitFor({ timeout: 15000 })
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: 'forsion/fx:forsion-extend:account-details' })))
    await page.locator('[data-fx-page="account-details"]').getByText(accountName, { exact: true }).waitFor()
    assert.equal(await page.locator('[data-settings-sub*="diagnostics"]').count(), 0, 'desktop diagnostics hidden')
    await page.waitForTimeout(350)
    await geometry('[data-fx-page="account-details"]', 'account-layout')
    await page.screenshot({ path: path.join(shots, 'account.png') })
    await tap(page.locator('.settings-mobile-detail-head button').last())
    await closeLeft()
    await tap(page.locator('.mb-topbar [aria-label="more"]'))
    await tap(page.locator('.mb-sheet [data-ribbon-id="rb-market"]'))
    await page.locator('[data-store-view="forsion-extend:membership"]').waitFor()
    await tap(page.locator('[data-store-view="forsion-extend:membership"]'))
    await page.locator('[data-fx-page="membership"]').getByText('Pro fixture', { exact: true }).waitFor()
    await tap(page.locator('[data-store-view="forsion-extend:points"]'))
    await page.locator('[data-fx-page="points"]').locator('.fx-shop-card strong').filter({ hasText: '100 points fixture' }).waitFor()
    await tap(page.locator('[data-store-view="forsion-extend:items"]'))
    await page.locator('[data-fx-page="items"]').getByText('Quota reset card fixture', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-fx-page="items"] [data-testid="shop-balance"]').innerText(), '75')
    await geometry('[data-fx-page="items"] .fx-shop-strip', 'store-layout', true)
    await geometry('[data-fx-page="items"]', 'store-content')
    await page.screenshot({ path: path.join(shots, 'store.png') })
    await tap(page.locator('[data-mobile-market] .settings-back').first())
    // Exercise the existing deep-link router, then the real location tree and file picker.
    await page.evaluate(() => { const a = document.createElement('a'); a.href = 'forsion://space/forsion-penzor'; a.id = 'mobile-extend-link'; a.textContent = 'Open drive'; Object.assign(a.style, { position: 'fixed', top: '300px', left: '20px', zIndex: '99999' }); document.body.appendChild(a) })
    await tap(page.locator('#mobile-extend-link')); await page.evaluate(() => document.getElementById('mobile-extend-link').remove())
    await page.locator('.pz').first().waitFor()
    await tap(page.locator('.mb-topbar [aria-label="left panel"]'))
    const driveRoot = page.locator('.mb-drawer--left [data-row-key="drive-root"]')
    if ((await driveRoot.getAttribute('aria-expanded')) !== 'true') await tap(driveRoot)
    await tap(page.locator('.mb-drawer--left [data-row-key="app:penzor"]'))
    await closeLeft()
    await page.locator('.pz').getByText(legacyName, { exact: true }).waitFor()
    const refreshedFiles = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/files' && r.request().method() === 'GET')
    const uploadDone = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/files/upload' && r.status() === 201)
    await page.locator('.pz input[type="file"]:not([webkitdirectory])').last().setInputFiles({ name: 'Mobile upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Uploaded from mobile host') })
    await page.waitForFunction(() => document.querySelector('.pz')?.textContent.includes('Mobile upload.txt'), null, { timeout: 15000 })
    await uploadDone
    await refreshedFiles
    await page.waitForTimeout(700)
    assert(uploads.some((s) => s.includes('Uploaded from mobile host') && s.includes('Mobile upload.txt')), 'actual multipart upload contains selected file bytes')
    const row = page.locator('.pz tr', { hasText: legacyName })
    const download = page.waitForEvent('download')
    await row.dblclick()
    const file = await download; const target = path.join(shots, 'download.txt'); await file.saveAs(target)
    assert.equal(fs.readFileSync(target, 'utf8'), 'Legacy account bytes', 'download preserves old-account file bytes')
    assert.equal(await page.evaluate(() => localStorage.getItem('forsion.mobile.legacy-note')), 'Preserve local notes and selected vault')
    assert.equal(await page.evaluate(() => localStorage.getItem('forsion_token')), 'legacy-account-token')
    await geometry('.pz', 'drive-layout')
    await page.screenshot({ path: path.join(shots, 'drive.png') })
    assert.equal(errors.length, 0, errors.join('\n'))
    assert(requests.filter((r) => r.method !== 'OPTIONS' && /^\/api\/(files|storage|remotesync)/.test(r.p)).every((r) => r.token === 'Bearer legacy-account-token'))
    console.log('PASS actual bundled Extend mobile: settings entry, legacy account details, desktop gates, store/items, drive list, multipart upload, exact-byte download, token/local preference preservation, no page errors')
  } catch (e) {
    if (browser) for (const ctx of browser.contexts()) for (const page of ctx.pages()) await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {})
    console.error('API calls', requests.slice(-25), 'Page errors', errors)
    if (browser) for (const ctx of browser.contexts()) for (const page of ctx.pages()) console.error('Visible location keys', await page.locator('.mb-drawer--left [data-row-key]').evaluateAll((els) => els.map((el) => el.getAttribute('data-row-key'))).catch(() => []))
    throw e
  } finally { await browser?.close(); preview.kill() }
})().catch((e) => { console.error(e); process.exitCode = 1 })
