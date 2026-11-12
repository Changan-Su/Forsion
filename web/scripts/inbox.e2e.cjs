/** Built Web inbox regression: real desktop/mobile shells, isolated account storage,
 * fixture broadcasts/claims, no live account. Run npm run build && npm run e2e:inbox. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('../../desktop/node_modules/playwright-core')
const { startPreview } = require('../../mobile/scripts/lib/preview.cjs')
const { startStubEngine } = require('../../desktop/scripts/lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.resolve(process.env.OUT || path.join(ROOT, 'outputs/inbox'))
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

const EXTEND = process.env.EXTEND_BUNDLE
const token = (id) => `fixture.${Buffer.from(JSON.stringify({ userId: id })).toString('base64url')}.fixture`
const letter = (account) => ({ id: `cloud:${account}-welcome`, origin_broadcast_id: `${account}-welcome`, sender_kind: 'server', sender_id: 'forsion', title: account === 'a' ? '网页来信' : '账号 B 来信', body: '第一行消息\n第二行消息', title_en: account === 'a' ? 'Web welcome' : 'Account B message', body_en: 'First message line\nSecond message line', created_at: '2026-11-12 09:00:00.000001', read_at: null, archived_at: null, attachments: { items: [{ kind: 'resetCard', label: { zh: '重置卡', en: 'Reset card' } }], claimed: false } })
const rows = { a: [letter('a')], b: [letter('b')] }
const results = [], errors = [], forbidden = [], contexts = []
let revision = 0, claims = 0, calls = 0
async function main() {
  assert(EXTEND && fs.existsSync(EXTEND), 'Set EXTEND_BUNDLE to a built Forsion Extend dist/main.js')
  const pluginCode = fs.readFileSync(EXTEND, 'utf8')
  const preview = await startPreview(ROOT); await preview.ready()
  const stub = await startStubEngine({})
  const browser = await chromium.launch({ executablePath: executable(), headless: true })
  const open = async (mobile, standalone = false) => {
    const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, locale: mobile ? 'zh-CN' : 'en-GB' }); contexts.push(ctx)
    await ctx.addInitScript(({ credential, mobile, standalone }) => {
      if (!standalone) window.__FORSION_UNIT_PAGE__ = { instanceId: 'inbox-fixture', name: 'Forsion', version: '2.14.1', projection: 'public', inheritWebAccount: true, account: { apiBase: location.origin + '/api', loginPath: '/auth' }, capabilities: { amadeus: { adapter: 'forsion-cloud-v1', apiBase: location.origin + '/api' }, tangu: { adapter: 'forsion-cloud-v1', apiBase: location.origin + '/api', execution: 'fleet' } } }
      window.__FORSION_PRODUCT_RUNTIME__ = { id: 'inbox-fixture', displayName: 'Forsion', defaultSpace: 'tangu', spaces: [], nativeFeatures: ['tangu', 'amadeus'], market: true, agentBackend: false, onboarding: false }
      if (standalone) localStorage.setItem('forsion_token', credential)
      if (!localStorage.getItem('unit:inbox-fixture:account')) localStorage.setItem('unit:inbox-fixture:account', credential)
      localStorage.setItem('forsion_tangu_onboarding_done', '1'); localStorage.setItem('tangu_locale', mobile ? 'zh' : 'en'); localStorage.setItem('forsion_theme', mobile ? 'dark' : 'light'); localStorage.setItem('forsion_theme_lang', 'lovable')
    }, { credential: token(standalone ? 'b' : 'a'), mobile, standalone })
    const fixture = async (route) => {
      const req = route.request(), u = new URL(req.url()), p = u.pathname.replace(/^\/api/, '')
      const account = req.headers().authorization === `Bearer ${token('b')}` ? 'b' : 'a'
      const json = (value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) })
      if (['/unit/account', '/auth/me', '/brain/users/me'].includes(p)) return json({ userId: account, username: account, role: 'USER', tokenValid: true })
      if (p === '/unit/plugins') return json({ plugins: [{ id: 'forsion-extend', name: 'Forsion Extend', version: '0.10.4', apiVersion: 1, code: pluginCode, preinstalled: true, locked: true, bundleOff: false }] })
      if (p.startsWith('/unit/plugin-data/')) return json({ data: null })
      if (p.startsWith('/unit/')) return json({ config: {}, spaces: [] })
      if (p === '/auth/region') return json({ country: 'GB' })
      if (p === '/brain/inbox/messages/unread-count') { calls++; const live = rows[account].filter((m) => !m.deleted_at && !m.archived_at); return json({ count: live.filter((m) => !m.read_at).length, latestId: live[0]?.id ?? null, revision: String(revision), latestCreatedAt: live[0]?.created_at }) }
      if (p === '/brain/inbox/messages') { calls++; const f = u.searchParams.get('filter'); return json({ messages: rows[account].filter((m) => !m.deleted_at && (f === 'archived' ? !!m.archived_at : !m.archived_at) && (f !== 'unread' || !m.read_at)), nextCursor: null }) }
      if (p.startsWith('/brain/inbox/messages/')) {
        const m = rows[account].find((m) => m.id === `cloud:${p.split('/').at(-1)}`)
        if (!m) return route.fulfill({ status: 404, body: '{}' })
        const patch = req.postDataJSON()
        if (req.method() === 'DELETE') m.deleted_at = '2026-11-12 10:00:00'
        else { if ('read' in patch) m.read_at = patch.read ? '2026-11-12 10:00:00' : null; if ('archived' in patch) m.archived_at = patch.archived ? '2026-11-12 10:00:00' : null }
        revision++; return json({ ok: true })
      }
      if (p.endsWith('/claim')) { const m = rows[account].find((m) => p.includes(m.origin_broadcast_id)); const alreadyClaimed = m.attachments.claimed; if (!alreadyClaimed) claims++; m.attachments.claimed = true; revision++; return json({ claimed: true, alreadyClaimed }) }
      if (p.startsWith('/agent/inbox')) { forbidden.push(p); return route.fulfill({ status: 404, body: '{}' }) }
      if (p === '/amadeus/vaults') return json({ vaults: [{ id: 'default', name: 'Fixture vault', lastChangeSeq: 1 }] })
      if (p.endsWith('/file')) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'Fixture file not found' }) })
      if (p.endsWith('/tree')) return json({ pages: [], folders: [], files: [], seq: 1 })
      if (p.endsWith('/asset-token')) return json({ token: 'fixture', ttlSec: 300 })
      if (/\/events$|\/stream$/.test(p)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
      return route.fulfill({ response: await route.fetch({ url: stub.url + p + u.search }) })
    }
    await ctx.route('**/api/**', fixture); await ctx.route('**/unit/**', fixture)
    // Real Unit documents permit signed plugin evaluation; standalone Web keeps its stricter policy.
    if (!standalone) await ctx.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback()
      const response = await route.fetch()
      const html = (await response.text()).replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
      return route.fulfill({ response, body: html })
    })
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${mobile ? 'mobile' : 'desktop'}/${standalone ? 'standalone' : 'Unit'}: ${e.stack}`)); page.on('console', (m) => { if (m.type() === 'error') fs.appendFileSync(path.join(OUT, 'console.log'), m.text() + '\n') })
    await page.goto(preview.url + `?ui=${mobile ? 'mobile' : 'desktop'}`, { waitUntil: 'domcontentloaded' }); await page.waitForSelector(mobile ? '.bmc-chrome' : '.rb', { timeout: 60_000 })
    return { page, mobile }
  }
  const inbox = async ({ page, mobile }) => { if (mobile) { await page.locator('.bmc-dock [data-space="inbox"]').click(); await page.waitForSelector('.mb-shell[data-space="inbox"]') } else await page.locator('[data-space-id="inbox"]').first().click() }
  const wake = ({ page }) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  let desktop, mobile
  try {
    desktop = await open(false); mobile = await open(true)
    await inbox(desktop); await inbox(mobile)
    await desktop.page.getByText('Web welcome', { exact: true }).first().click(); await desktop.page.waitForSelector('.ibx-reader-title'); assert(rows.a[0].read_at)
    await wake(mobile); await mobile.page.getByText('网页来信', { exact: true }).first().click(); await mobile.page.waitForSelector('.ibx-reader-title')
    await desktop.page.locator('.ibx-claim-btn').click(); await eventually(() => rows.a[0].attachments.claimed); await wake(mobile); await mobile.page.waitForSelector('.ibx-claim-btn.done'); assert.equal(claims, 1)
    await desktop.page.screenshot({ path: path.join(OUT, 'desktop-light-en.png') }); await mobile.page.screenshot({ path: path.join(OUT, 'mobile-dark-zh.png') })
    await desktop.page.locator('.ibx-iconbtn[title="Archive"]').click(); await eventually(() => rows.a[0].archived_at); await wake(mobile); await mobile.page.waitForFunction(() => !document.querySelector('.ibx-reader-title'))
    await desktop.page.reload({ waitUntil: 'domcontentloaded' }); await desktop.page.waitForSelector('.rb'); assert(rows.a[0].archived_at)
    await desktop.page.evaluate((credential) => localStorage.setItem('unit:inbox-fixture:account', credential), token('b')); await desktop.page.reload({ waitUntil: 'domcontentloaded' }); await desktop.page.waitForSelector('.rb'); await inbox(desktop)
    await desktop.page.getByText('Account B message', { exact: true }).first().waitFor(); assert.equal(await desktop.page.getByText('Web welcome', { exact: true }).count(), 0)
    const standalone = await open(false, true); await inbox(standalone); await standalone.page.getByText('Account B message', { exact: true }).first().waitFor()
    assert.equal(forbidden.length, 0); assert.deepEqual(errors, [])
    results.push({ ok: true, shells: ['desktop/en/light', 'mobile/zh/dark', 'standalone/en/light'], claims, calls, checks: ['Unit inbox entry', 'Extend provider', 'read state', 'cross-client claim', 'cross-client archive', 'reload', 'account separation', 'no engine-only inbox calls', 'standalone Web account adapter'] }); console.log(JSON.stringify(results, null, 2))
  } catch (e) {
    for (const [name, target] of [['desktop', desktop], ['mobile', mobile]]) if (target) { await target.page.screenshot({ path: path.join(OUT, `failure-${name}.png`) }); fs.writeFileSync(path.join(OUT, `failure-${name}.txt`), await target.page.locator('body').innerText()) }
    throw e
  } finally { fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, errors, forbidden }, null, 2)); for (const ctx of contexts) await ctx.close(); await browser.close(); await stub.close(); preview.kill() }
}
async function eventually(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)) } assert.fail('Condition not met within ten seconds') }
main().catch((e) => { console.error(e); process.exitCode = 1 })
