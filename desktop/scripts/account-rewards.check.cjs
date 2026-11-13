/** Production account menu/settings receipt/compaction notice in an isolated browser fixture. */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { chromium } = require('playwright-core')
const caches = path.join(os.homedir(), 'Library/Caches/ms-playwright')
const executablePath = process.env.CHROMIUM_EXE || fs.readdirSync(caches).filter(x => x.startsWith('chromium-')).sort().reverse().flatMap(d => ['Google Chrome for Testing', 'Chromium'].map(n => path.join(caches, d, 'chrome-mac-arm64', `${n}.app/Contents/MacOS/${n}`))).find(fs.existsSync)
;(async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 820 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const menuReady = async () => {
    await page.waitForFunction(() => {
      const el = document.querySelector('.account-pop')
      return el && !el.classList.contains('lcl-droplet-pouring') && +getComputedStyle(el.firstElementChild).opacity > .99
    })
    const rect = await page.locator('.account-pop').boundingBox()
    assert.ok(rect && rect.width >= 220 && rect.height >= 180 && rect.x >= 0 && rect.y >= 0, `Menu has finished opening inside the viewport: ${JSON.stringify(rect)}`)
  }
  try {
    await page.goto(process.env.HARNESS_URL || 'http://127.0.0.1:5277/account-harness.html?rewards')
    await page.locator('.account-card').click()
    await page.locator('[data-testid="account-points"]').filter({ hasText: '1,280' }).waitFor()
    const rows = await page.locator('.ap-item').allTextContents()
    const pointsInset = await page.locator('[data-testid="account-points"]').evaluate(el => el.parentElement.getBoundingClientRect().right - el.getBoundingClientRect().right)
    assert.ok(pointsInset < 20, 'Backpack points sit at the right edge of the menu row')
    assert.match(rows[rows.findIndex(x => x.includes('背包')) + 1], /邀请奖励/)
    assert.equal(await page.locator('.plugin-settings-card').getByText('已配置', { exact: true }).count(), 1)
    await page.getByRole('button', { name: '跳过，立即继续', exact: true }).waitFor()
    await menuReady()
    await page.screenshot({ path: '/tmp/forsion-account-rewards-light.png' })
    await page.getByRole('button', { name: '邀请奖励', exact: true }).click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.settingsTarget), 'forsion/fx:forsion-extend:points#invite')
    await page.locator('.plugin-settings-card button').click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.settingsTarget), 'fplugin:latex-suite')
    await page.evaluate(async () => {
      const { setLocaleGlobal } = await import('/src/i18n.tsx')
      const { applyTheme } = await import('/src/theme/loader.ts')
      setLocaleGlobal('en'); applyTheme('lovable', 'cream', 'paper', 'dark')
    })
    await page.setViewportSize({ width: 560, height: 820 })
    await page.locator('.account-card').click()
    await page.locator('[data-testid="account-points"]').filter({ hasText: 'points' }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await menuReady()
    await page.screenshot({ path: '/tmp/forsion-account-rewards-dark-en.png' })
    await page.locator('.account-card').click()
    await page.locator('.account-pop').waitFor({ state: 'detached' })
    const compactionLine = await page.locator('.t2-compaction-line').evaluate(el => {
      const icon = el.querySelector('svg').getBoundingClientRect()
      const text = el.querySelector('span').getBoundingClientRect()
      return { icon: { y: icon.y, bottom: icon.bottom }, text: { y: text.y, bottom: text.bottom } }
    })
    assert.ok(compactionLine.icon.y < compactionLine.text.bottom && compactionLine.icon.bottom > compactionLine.text.y, 'Summary spinner shares the text row')
    await page.screenshot({ path: '/tmp/forsion-compaction-settings-dark-en.png' })
    console.log('PASS backpack points, invitation order/deep link, native settings receipt, early skip notice, dark/English/narrow layout')
    if (process.env.EXTEND_BUNDLE) {
      const code = fs.readFileSync(process.env.EXTEND_BUNDLE, 'utf8')
      await page.evaluate((bundle) => {
        const views = []
        const ctx = { getLocale: () => 'en', subscribeLocale: () => () => {}, registerSettingsView: view => views.push(view), app: {} }
        window.__extendDispose = new Function('ctx', bundle)(ctx)
        const points = views.find(v => v.id === 'points')
        if (!points) throw new Error('Built Extend did not register the points page')
        document.querySelector('#root').style.display = 'none'
        const host = document.createElement('div')
        host.style.cssText = 'max-width:650px;margin:32px auto;padding:24px'
        host.dataset.testid = 'built-extend-points'
        document.body.append(host)
        window.__pointsDispose = points.mount(host, { anchor: 'invite' })
      }, code)
      await page.waitForFunction(() => document.activeElement?.matches('[data-settings-anchor="invite"]'))
      const invite = page.locator('[data-testid="built-extend-points"] [data-settings-anchor="invite"]')
      assert.ok(await invite.locator('.fx-row').first().evaluate(el => el.getBoundingClientRect().height < 200), 'Invite row remains compact on narrow screens')
      assert.equal(await invite.evaluate(el => el === document.activeElement && el.getBoundingClientRect().bottom > 0 && el.getBoundingClientRect().top < innerHeight), true)
      await page.screenshot({ path: '/tmp/forsion-extend-invite-anchor.png' })
      console.log('PASS actual Extend dist/main.js registration and points mount: invite anchor receives focus and is visible')
      await page.evaluate(() => { window.__pointsDispose?.(); window.__extendDispose?.() })
    } else console.log('NOT RUN Extend built bundle anchor check: set EXTEND_BUNDLE to the freshly built dist/main.js')
    assert.deepEqual(errors, [], 'No browser runtime errors')
  } finally { await browser.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
