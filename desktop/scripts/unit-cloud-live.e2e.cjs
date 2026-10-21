/** Real private-PG/S3 staging only. Credentials stay inside the process; never targets production. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
;(async () => {
  const fixture = JSON.parse(fs.readFileSync(process.env.FORSION_TEST_FIXTURE_ACCOUNTS, 'utf8'))
  const origin = new URL(fixture.origin)
  assert(['127.0.0.1', 'localhost'].includes(origin.hostname), 'Only an isolated loopback staging fixture is allowed')
  assert(fixture.accounts.length === 2 && fixture.accounts.every((a) => /^web-(alice|bob)-/.test(a.username)), 'Only generated staging accounts are allowed')
  const shots = process.env.SHOT_DIR || '/tmp/forsion-unit-cloud-live'
  fs.mkdirSync(shots, { recursive: true })
  const users = []
  for (const account of fixture.accounts) {
    const response = await fetch(new URL('/api/auth/login', origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: account.username, password: account.password }) })
    assert.equal(response.status, 200, 'Staging login must succeed')
    const { token } = await response.json()
    const auth = { Authorization: `Bearer ${token}`, 'X-Project-Source': 'penzor' }
    const name = `Existing-${randomUUID()}.txt`, bytes = Buffer.from(`Existing staged account bytes ${randomUUID()}`)
    const form = new FormData(); form.set('file', new File([bytes], name)); form.set('parentId', 'ROOT')
    const upload = await fetch(new URL('/api/files/upload', origin), { method: 'POST', headers: auth, body: form })
    assert.equal(upload.status, 201, 'Seed the old account through the real file service')
    const file = await upload.json()
    users.push({ ...account, token, auth, name, bytes, file })
  }
  assert.equal((await fetch(new URL(`/api/files/${users[0].file.id}/content`, origin), { headers: users[1].auth })).status, 404, 'A second user cannot download the first user’s file')
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const results = []
  try {
    for (let index = 0; index < users.length; index++) {
      const user = users[index]
      const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'zh-CN', acceptDownloads: true })
      await context.addInitScript(({ token }) => {
        localStorage.setItem('forsion_token', token)
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_tangu_onboarding_version', '2.13.6')
      }, { token: user.token })
      const page = await context.newPage(), errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      const ribbon = async (id) => {
        const item = page.locator(`.rb [data-id="${id}"]`).first()
        if (await item.isVisible()) await item.click()
        else { await page.locator('.rb-more').first().click(); await page.locator(`[data-id="${id}"]`).last().click() }
      }
      await page.goto(new URL('/web/?ui=desktop', origin).href)
      await page.locator('.rb').first().waitFor()
      await ribbon('rb-settings')
      await page.locator('.settings-nav button').filter({ hasText: 'Forsion 云端' }).first().click()
      await page.getByText(user.username, { exact: true }).first().waitFor()
      assert.equal(await page.getByText(users[1 - index].username, { exact: true }).count(), 0)
      await page.screenshot({ path: path.join(shots, `real-account-${index}.png`) })
      await page.locator('.settings-back').first().click()
      await ribbon('rb-market')
      await page.locator('[data-store-view="forsion-extend:membership"]').waitFor()
      for (const id of ['points', 'items']) { await page.locator(`[data-store-view="forsion-extend:${id}"]`).click(); await page.locator('.mk-page').waitFor() }
      await page.screenshot({ path: path.join(shots, `real-store-${index}.png`) })
      await page.locator('.mk-page .settings-back').first().click()
      await page.locator('[data-space-id="forsion-penzor"], [data-id="forsion-penzor"]').first().click()
      const root = page.locator('[data-row-key="drive-root"]').first()
      await root.waitFor()
      if (await root.getAttribute('aria-expanded') !== 'true') await root.click()
      await page.locator('[data-row-key="app:penzor"]').first().click()
      await page.getByText(user.name, { exact: true }).waitFor()
      assert.equal(await page.getByText(users[1 - index].name, { exact: true }).count(), 0)
      const uploadName = `网页验收-${index}-${randomUUID()}.txt`, uploadBytes = Buffer.from(`真实浏览器上传 ${index}`)
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: uploadName, mimeType: 'text/plain', buffer: uploadBytes })
      await page.getByText(uploadName, { exact: true }).first().waitFor({ timeout: 30_000 })
      const files = await fetch(new URL('/api/files', origin), { headers: user.auth }).then((r) => r.json())
      const uploaded = files.find((f) => f.name === uploadName)
      assert(uploaded, 'The real service preserves the browser’s UTF-8 filename')
      const actual = Buffer.from(await fetch(new URL(`/api/files/${uploaded.id}/content`, origin), { headers: user.auth }).then((r) => r.arrayBuffer()))
      assert.equal(digest(actual), digest(uploadBytes))
      const nextDownload = page.waitForEvent('download')
      await page.locator('.pz tr', { hasText: user.name }).dblclick()
      const downloaded = await nextDownload
      assert.equal(digest(fs.readFileSync(await downloaded.path())), digest(user.bytes))
      await page.screenshot({ path: path.join(shots, `real-drive-${index}.png`) })
      assert.equal(errors.length, 0, errors.join('\n'))
      results.push({ account: index, identity: true, store: true, utf8Upload: true, downloadSha256: digest(user.bytes), isolation: true, pageErrors: 0 })
      await context.close()
    }
    fs.writeFileSync(path.join(shots, 'real-browser-report.json'), JSON.stringify({ ok: true, results }, null, 2))
    console.log('PASS real PostgreSQL/S3 browser: both accounts, store, UTF-8 upload, exact-byte download and isolation')
  } finally { await browser.close() }
})().catch((e) => { console.error(e); process.exitCode = 1 })
