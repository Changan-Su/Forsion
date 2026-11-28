/** Capture ⑬A and M1/M2 from the built Web and Mobile apps.
 *  SHOT_DIR=/path/to/output node web/scripts/shoot-vault-switch.cjs
 *  The browser serves build assets from disk and cloud responses from fixtures.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('../../desktop/node_modules/playwright-core')
const { findChromium } = require('../../desktop/scripts/lib/find-chromium.cjs')

const root = path.resolve(__dirname, '../..')
const origin = 'http://localhost:17345'
const legacyId = 'default:Amadeus/Notes/'
const libraries = [
  { id: 'default', vaultId: 'default', kind: 'default', prefix: 'Amadeus/', name: 'My Vault', files: 41, devices: [] },
  { id: legacyId, vaultId: 'default', kind: 'legacy', prefix: 'Amadeus/Notes/', name: 'Notes', files: 12, devices: [{ deviceId: 'laptop', name: 'Laptop' }] },
  { id: 'work', vaultId: 'work', kind: 'own', prefix: 'Amadeus/', name: 'Work', files: 3, devices: [{ deviceId: 'laptop', name: 'Laptop' }, { deviceId: 'desktop', name: 'Desktop' }] },
]
const notes = {
  'Welcome.md': '# 观察笔记\n\n这里是云端笔记的目录。\n',
  'Notes/Field notes.md': '# 观察记录\n\n## 要点\n\n记录这次观测的条件和结果。\n',
}

async function installFixtures(page, dist, mode) {
  await page.addInitScript(({ mode, origin }) => {
    if (location.origin !== origin) return
    localStorage.setItem('forsion_token', 'fixture.' + btoa(JSON.stringify({ userId: 'vault-switch-fixture' })) + '.fixture')
    localStorage.setItem('forsion_tangu_onboarding_done', '1')
    localStorage.setItem('tangu_locale', 'zh')
    localStorage.setItem('forsion_theme', mode)
    localStorage.setItem('amadeus_vault_mode', 'cloud')
    window.__FORSION_PRODUCT_RUNTIME__ = {
      id: 'vault-switch-fixture', displayName: 'Forsion', defaultSpace: 'amadeus', spaces: [],
      nativeFeatures: ['tangu', 'amadeus'], market: false, agentBackend: false, onboarding: false,
    }
  }, { mode, origin })
  await page.routeWebSocket('**/*', (socket) => socket.close())
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url())
    const p = u.pathname
    const headers = {
      'access-control-allow-origin': origin, 'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    }
    const json = (value, status = 200) => route.fulfill({ status, headers, json: value })
    if (p.startsWith('/api/')) {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
      if (p === '/api/auth/me' || p === '/api/brain/users/me') return json({ userId: 'vault-switch-fixture', username: 'Fixture', tokenValid: true })
      if (p === '/api/auth/region') return json({ country: 'GB' })
      if (p === '/api/amadeus/libraries') return json({ libraries })
      if (p === '/api/amadeus/vaults') return json({ vaults: [{ id: 'default', name: 'My Vault', isDefault: true }, { id: 'work', name: 'Work', isDefault: false }] })
      if (p === '/api/amadeus/vaults/default/tree') {
        return json({
          pages: Object.keys(notes), folders: ['Notes'], files: [], seq: 1,
          entries: Object.keys(notes).map((path, index) => ({ id: `fixture-note-${index}`, path, kind: 'page', seq: 1 })),
        })
      }
      if (p === '/api/amadeus/vaults/default/file') {
        const file = u.searchParams.get('path')
        const content = notes[file]
        return typeof content === 'string'
          ? json({ path: file, kind: 'page', content, seq: 1, updatedAt: '2026-11-28T00:00:00Z' })
          : json({ detail: 'File not found' }, 404)
      }
      if (p.endsWith('/asset-token')) return json({ token: 'fixture', ttlSec: 3600 })
      if (p.endsWith('/events')) return route.fulfill({ headers, contentType: 'text/event-stream', body: ': fixture\n\n' })
      return json({ ok: true, items: [], sessions: [], agents: [], models: [], units: [] })
    }
    if (u.origin !== origin) return route.abort()
    const file = path.resolve(dist, p === '/' ? 'index.html' : `.${decodeURIComponent(p)}`)
    if (!file.startsWith(dist + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      return route.fulfill({ status: 404 })
    }
    return route.fulfill({ path: file })
  })
}

async function openNotesDrawer(page) {
  const drawer = page.locator('.mb-drawer--left')
  await page.locator('.mb-topbar .mb-icon-btn').first().waitFor()
  if (!(await drawer.evaluate((el) => el.classList.contains('open')))) {
    await page.locator('.mb-topbar .mb-icon-btn').first().tap()
  }
  await page.locator('.mb-drawer--left.open').waitFor()
  await drawer.locator('.amx-tree').waitFor()
  return drawer
}

async function shoot(browser, out, platform, mode) {
  const mobile = platform === 'mobile'
  const dist = path.join(root, platform, 'dist')
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), `Build ${platform} before running this script`)
  const page = await browser.newPage({
    locale: 'zh-CN', colorScheme: mode, deviceScaleFactor: 1, serviceWorkers: 'block',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 820 },
    hasTouch: mobile, isMobile: mobile,
  })
  page.setDefaultTimeout(30_000)
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}-${mode}.png`), animations: 'disabled' })
  try {
    await installFixtures(page, dist, mode)
    await page.goto(origin + (mobile ? '/' : '/?ui=desktop'))
    await page.locator(`html[data-mode="${mode}"]`).waitFor()
    if (!mobile) {
      await page.locator('.amx-tree .amx-vault-name').filter({ hasText: '云端笔记' }).click()
      const menu = page.locator('.ctx-menu.ctx-vault-menu[role=menu]')
      await menu.getByRole('menuitemradio', { name: '云端笔记' }).waitFor()
      assert.equal(await menu.getByRole('menuitemradio', { name: '云端笔记' }).getAttribute('aria-checked'), 'true')
      assert.equal(await menu.getByRole('menuitemradio').count(), libraries.length)
      assert.doesNotMatch(await menu.innerText(), /这台电脑上|落盘到这台/)
      await shot('web-wide')
      return
    }

    let drawer = await openNotesDrawer(page)
    const footer = () => drawer.locator('.t2s-foot button[aria-haspopup=dialog]')
    await footer().filter({ hasText: '云端笔记' }).tap()
    const sheet = page.getByRole('dialog', { name: '智库', exact: true }).filter({ has: page.locator('.cloud-vault-sheet-hint') })
    await Promise.all([
      page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
      sheet.getByRole('button', { name: /Notes/ }).tap(),
    ])
    await page.waitForFunction((id) => Object.keys(localStorage).some((key) =>
      /^amadeus\.cloudLibrary(?::account:|$)/.test(key) && localStorage.getItem(key) === id), legacyId)
    drawer = await openNotesDrawer(page)
    const note = drawer.locator('.t2s-srow[data-sel-id="Field notes.md"]')
    await note.tap()
    await page.locator('.unified-body').getByText('记录这次观测的条件和结果。').waitFor()
    drawer = await openNotesDrawer(page)
    await footer().scrollIntoViewIfNeeded()
    assert.equal(await footer().getAttribute('aria-label'), 'Notes · 已保存')
    await shot('mobile-M2')
    await footer().tap()
    await sheet.getByText('手机上都是在线打开，改动直接存到云端。', { exact: true }).waitFor()
    // The hint renders on open, before the refreshed library list arrives.
    const rows = sheet.locator('button[aria-pressed]')
    await rows.nth(libraries.length - 1).waitFor({ state: 'visible' })
    assert.equal(await rows.count(), libraries.length)
    assert.match(await sheet.getByRole('button', { pressed: true }).innerText(), /Notes/)
    await shot('mobile-M1')
  } finally {
    await page.close()
  }
}

async function main() {
  assert.ok(process.env.SHOT_DIR, 'Set SHOT_DIR to the screenshot output directory')
  const out = path.resolve(process.env.SHOT_DIR)
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--disable-background-networking'] })
  try {
    for (const mode of ['light', 'dark']) {
      await shoot(browser, out, 'web', mode)
      await shoot(browser, out, 'mobile', mode)
    }
    console.log('Captured 6 screenshots')
  } finally {
    await browser.close()
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
