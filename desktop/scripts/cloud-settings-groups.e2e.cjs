// Real Electron + signed Extend package + local cloud. Never uses the active user's home or account.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { startFakeForsionCloud } = require('./lib/fake-forsion-cloud.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const arg = key => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3)
const ROOT = path.resolve(__dirname, '..'), PKG = arg('pkg')
const OUT = path.resolve(arg('out') || path.join(os.tmpdir(), 'forsion-cloud-settings-groups'))
const LANG = arg('lang') === 'en' ? 'en' : 'zh'
const T = LANG === 'en' ? {
  nav: ['Account', 'Membership & usage', 'Backpack', 'Submissions', 'Cloud sync', 'Help & diagnostics'],
  profile: 'Profile', details: 'Sign-in & details', security: 'Security', points: 'Points & invites', usage: 'Usage', feedback: 'Feedback', diagnostics: 'Diagnostic data', login: 'Sign in to Forsion', retry: 'Retry', advanced: 'Advanced connection', phone: '138****5678', search: 'Search settings',
} : {
  nav: ['账号', '会员与用量', '背包', '插件投稿', '云端同步', '帮助与诊断'],
  profile: '个人主页', details: '登录与资料', security: '安全', points: '积分与邀请', usage: '用量记录', feedback: '反馈', diagnostics: '诊断数据', login: '登录 Forsion', retry: '重试', advanced: '高级连接', phone: '138****5678', search: '搜索设置',
}
async function main() {
  assert(PKG && fs.existsSync(path.join(PKG, 'SIGNATURE')), 'Pass --pkg=<freshly built and signed Extend package>')
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-cloud-settings-'))
  fs.cpSync(PKG, path.join(home, 'plugins/forsion-extend'), { recursive: true })
  const stub = await startStubEngine(), cloud = await startFakeForsionCloud({ scenario: 'both' })
  let failQuota = false
  const front = http.createServer((req, res) => {
    if (failQuota && req.url === '/api/token-quota/my') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"detail":"fixture temporarily unavailable"}') }
    const second = (() => { try { return JSON.parse(Buffer.from(String(req.headers.authorization).split('.')[1], 'base64url').toString()).userId === 'u2' } catch { return false } })()
    const up = http.request(cloud.url + req.url, { method: req.method, headers: req.headers }, response => {
      const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => {
        let data = Buffer.concat(chunks)
        if (second && ['/api/auth/me', '/api/brain/users/me', '/api/profile/me'].includes(req.url)) {
          const json = JSON.parse(data.toString())
          const user = json.profile || json; user.username = 'second_user'; user.nickname = 'Second user'; data = Buffer.from(JSON.stringify(json))
        }
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json' }); res.end(data)
      })
    })
    up.on('error', () => { res.writeHead(502); res.end('{}') }); req.pipe(up)
  })
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve))
  const cloudUrl = `http://127.0.0.1:${front.address().port}`
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const token = id => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: id, username: id === 'u1' ? 'demo_user' : 'second_user' })}.fixture`
  const creds = id => ({ cloudUrl, token: token(id) })
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(creds('u1')))
  fs.writeFileSync(path.join(home, 'auth-accounts.json'), JSON.stringify({ version: 1, accounts: ['u1', 'u2'].map(id => ({ id: `${cloudUrl}::${id}`, ...creds(id), username: id === 'u1' ? 'demo_user' : 'second_user' })) }))
  const results = [], errors = []
  const pass = name => { results.push(name); console.log('PASS', name) }
  let app, sp
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, `--lang=${LANG === 'en' ? 'en-US' : 'zh-CN'}`, ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' }, timeout: 90000 })
    const win = await app.firstWindow(); await win.waitForSelector('#root'); await skipOnboarding(win)
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'forsion' } }))
    for (let i = 0; i < 100 && !sp; i++) { for (const w of app.windows()) if (w.url().includes('window=floating') && await w.locator('.settings-page').count().catch(() => 0)) sp = w; if (!sp) await win.waitForTimeout(150) }
    assert(sp, 'Settings window opened'); sp.setDefaultTimeout(12000); sp.on('pageerror', error => errors.push(String(error)))
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)?.setContentSize(1180, 900), sp.url())
    await sp.evaluate(() => { document.documentElement.style.setProperty('--uiz', '1.1'); document.body.style.zoom = '1.1' })
    const nav = label => sp.locator('#settings-nav-subitems-forsion .settings-nav-subitem').filter({ hasText: label })
    const tab = label => sp.locator('.settings-cloud-tabs').getByRole('tab', { name: label, exact: true })
    const page = id => sp.locator(`[data-fx-page="${id}"]`)
    const shot = async name => { await sp.mouse.move(1100, 60); await sp.waitForTimeout(200); await sp.screenshot({ path: path.join(OUT, `${LANG}-${name}.png`), scale: 'css' }) }
    const jump = async target => { await sp.evaluate(target => window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: target })), target); await sp.waitForTimeout(400) }
    await page('account').locator('.fx-pf-root').waitFor()
    const entries = await sp.locator('#settings-nav-subitems-forsion .settings-nav-subitem').allTextContents()
    assert.deepEqual(entries.map(s => s.trim()), T.nav); pass('Six sidebar pages in the approved order')
    assert.equal(await tab(T.profile).getAttribute('aria-selected'), 'true')
    assert.equal(await sp.locator('.settings-main-title').innerText(), T.nav[0]); pass('Account defaults to the real profile')
    await shot('account-profile')
    await tab(T.details).click(); await page('account-details').locator('.fx-link-row').first().waitFor()
    assert.equal(await page('account-details').locator('input[type=file], .fx-avatar, [role=switch], .fx-tier').count(), 0)
    await page('account-details').getByRole('button', { name: T.phone, exact: true }).click()
    await page('security').locator('.settings-panel').first().waitFor()
    assert.equal(await nav(T.nav[0]).getAttribute('aria-current'), 'page'); pass('Contact row opens Security while the sidebar stays on Account')
    await tab(T.details).click(); await page('account-details').locator('.fx-link-row').first().waitFor(); await shot('account-details')
    await tab(T.details).focus(); await sp.keyboard.press('ArrowRight')
    assert.equal(await tab(T.security).getAttribute('aria-selected'), 'true')
    assert.equal(await tab(T.security).evaluate(el => el === document.activeElement), true)
    await sp.keyboard.press('Home'); await page('account').locator('.fx-pf-root').waitFor(); pass('Arrow keys and Home move focus and select the matching tab')
    for (const [id, root] of [['profile', T.nav[0]], ['security', T.nav[0]], ['usage', T.nav[1]], ['feedback', T.nav[5]]]) {
      await jump(`forsion/fx:forsion-extend:${id}`)
      await page(id === 'profile' ? 'account' : id).waitFor()
      assert.equal(await nav(root).getAttribute('aria-current'), 'page')
    }
    pass('Old profile, security, usage and feedback links reach the correct groups')
    await nav(T.nav[1]).click(); await page('quota').locator('.fx-tier').waitFor()
    assert.equal(await page('quota').locator('[data-testid=points-balance]').count(), 0)
    await tab(T.points).click(); await page('points').locator('[data-testid=points-balance]').waitFor()
    assert.equal(await page('points').locator('[data-testid=invite-code]').count(), 1)
    assert.equal(await page('points').locator('.fx-tier, [role=progressbar]').count(), 0); pass('Membership/quota and points/invites occupy separate sections')
    await shot('points-invites')
    await nav(T.nav[1]).click(); await page('quota').locator('.fx-tier').waitFor(); await shot('membership-quota')
    await sp.evaluate(() => window.tangu.cloudInvoke('diagnostics:set', { enabled: false, activity: false, sessions: false, memory: false }))
    const before = await sp.evaluate(() => window.tangu.cloudInvoke('diagnostics:get'))
    await nav(T.nav[5]).click(); await page('feedback').locator('.settings-panel').first().waitFor()
    await tab(T.diagnostics).click(); await page('diagnostics').locator('[role=switch]').first().waitFor()
    const after = await sp.evaluate(() => window.tangu.cloudInvoke('diagnostics:get'))
    for (const key of ['enabled', 'activity', 'sessions', 'memory', 'lastUploadAt']) assert.equal(after[key], before[key])
    assert(!cloud.requests.some(r => /diagnostics.*upload|remotesync.*(snapshot|upload)/.test(r.path) && r.method !== 'GET'))
    pass('Visiting Help and diagnostics preserves all consent switches and does not upload'); await shot('help-diagnostics')
    const search = sp.locator('.settings-nav-search input')
    await search.fill('login')
    await sp.locator('[data-setting-result="forsion-account"]').click()
    await page('account-details').locator('.fx-link-row').first().waitFor(); pass('Existing login search opens sign-in details')
    await search.fill(LANG === 'en' ? 'diagnostic' : '诊断')
    await sp.locator('[data-setting-result="cloud-forsion-extend-diagnostics"]').click(); await page('diagnostics').waitFor()
    pass('Diagnostics search opens its hidden section')
    await search.fill(''); await nav(T.nav[4]).click()
    assert.equal(await sp.locator('.settings-cloud-advanced-toggle').getAttribute('aria-expanded'), 'false')
    assert.equal(await sp.locator('[data-setting-anchor="cloud-url"]').count(), 0)
    await jump('forsion/f-conn'); await sp.locator('[data-setting-anchor="cloud-url"]').waitFor()
    assert.equal(await nav(T.nav[4]).getAttribute('aria-current'), 'page')
    pass('Connection is folded in Sync; its old deep link expands it')
    await search.fill(LANG === 'en' ? 'cloud server' : '云端')
    await sp.locator('[data-setting-result="cloud-url"]').click()
    await sp.locator('[data-setting-anchor="cloud-url"]').waitFor(); pass('Cloud URL search expands the advanced connection panel')
    await search.fill(''); await shot('sync-connection')
    await nav(T.nav[0]).click(); await tab(T.details).click(); await page('account-details').locator('.fx-local-account').count().catch(() => 0)
    // Switch through the real account bridge; the rendered page must reload under the new identity.
    await sp.evaluate(id => window.tangu.forsionSwitchAccount(id), `${cloudUrl}::u2`)
    await page('account-details').getByText('second_user', { exact: true }).first().waitFor()
    const second = await sp.evaluate(() => window.tangu.cloudInvoke('diagnostics:get'))
    assert.equal(second.enabled, false)
    await sp.evaluate(id => window.tangu.forsionSwitchAccount(id), `${cloudUrl}::u1`)
    await page('account-details').getByText('demo_user', { exact: true }).first().waitFor()
    const restored = await sp.evaluate(() => window.tangu.cloudInvoke('diagnostics:get'))
    assert.equal(restored.sessions, false); assert.equal(restored.memory, false); pass('Account switch reloads details and preserves per-account diagnostic preferences')
    await win.locator('.ribbon-account:visible, .account-card:visible').first().click()
    await win.locator('.account-pop').getByRole('button', { name: LANG === 'en' ? 'Backpack' : '背包', exact: true }).click()
    await page('backpack').locator('.fx-backpack-grid').waitFor()
    assert.equal(await nav(T.nav[2]).getAttribute('aria-current'), 'page'); pass('Avatar menu opens the same Backpack page')
    failQuota = true; await nav(T.nav[1]).click(); await page('quota').getByRole('button', { name: T.retry, exact: true }).waitFor()
    assert.equal(await page('quota').locator('.fx-tier').count(), 1); pass('Membership remains visible when quota fails')
    failQuota = false; await page('quota').getByRole('button', { name: T.retry, exact: true }).click(); await page('quota').locator('.fx-tier').waitFor(); pass('Load failure retains the native retry path')
    await nav(T.nav[0]).click(); await page('account').locator('.fx-pf-root').waitFor()
    await sp.evaluate(() => { document.documentElement.dataset.mode = 'dark'; document.documentElement.classList.add('dark') }); await shot('account-dark')
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)?.setContentSize(760, 900), sp.url())
    await sp.waitForTimeout(250)
    const geometry = await sp.locator('.settings-body').evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }))
    assert(geometry.scrollWidth <= geometry.width + 1); pass('Narrow settings window has no horizontal content overflow'); await shot('account-narrow-dark')
    await tab(T.details).click(); await sp.evaluate(() => window.tangu.forsionLogout())
    await page('account-details').getByRole('button', { name: T.login, exact: true }).waitFor()
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(creds('u1')))
    await page('account-details').getByText('demo_user', { exact: true }).first().waitFor(); pass('Sign-in state changes return to the selected details section')
    assert.deepEqual(errors, []); pass('No renderer errors')
  } catch (error) {
    if (sp) await sp.screenshot({ path: path.join(OUT, `${LANG}-failure.png`) }).catch(() => {})
    throw error
  } finally {
    fs.writeFileSync(path.join(OUT, `${LANG}-report.json`), JSON.stringify({ results, errors, home, count: results.length, fixture: true, zoom: '110%', pkg: PKG }, null, 2))
    if (app) await app.close(); await new Promise(resolve => front.close(resolve)); await cloud.close(); await stub.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
