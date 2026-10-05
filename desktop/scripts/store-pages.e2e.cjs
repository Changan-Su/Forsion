/**
 * 商店左栏的插件页(ctx.registerStoreView)× 真 Electron × 真 Extend:签过名的 Extend 包装进隔离 home,
 * 在商店浮窗里点开「会员 / 积分 / 物品」,走一次积分兑换,核对「去支付」打开的地址。云端是本地假服务,绝不碰生产;
 * 浏览器不会真的打开(主进程的 shell.openExternal 被换成记录)。
 *
 * 前置:① desktop 先 `npm run build`(读 out/);② Extend 已 `npm run build`,且带商店页(0.9 起);
 *       ③ 本机有 Extend 的签名钥(同 market-submissions.e2e.cjs)。Extend 目录缺省 ../../Forsion-Extend,用 EXTEND_DIR 指别处。
 * 用法:node scripts/store-pages.e2e.cjs [--en]
 */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert/strict')
const { createPrivateKey } = require('crypto'), { pathToFileURL } = require('url')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs'), { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), EXTEND = path.resolve(process.env.EXTEND_DIR || path.join(ROOT, '../../Forsion-Extend')), OUT = path.join(ROOT, 'outputs/store-pages')
const lang = process.argv.includes('--en') ? 'en' : 'zh'
const L = lang === 'zh'
  ? { group: '会员与积分', membership: '会员', points: '积分', items: '物品', yearly: '年付', pay: '去支付', redeem: '99 积分兑换', confirm: '确认花 99 积分', redeemed: '已兑换', backpack: '打开背包' }
  : { group: 'Membership & points', membership: 'Membership', points: 'Points', items: 'Items', yearly: 'Yearly', pay: 'Pay', redeem: 'Redeem for 99 points', confirm: 'Confirm: spend 99 points', redeemed: 'Redeemed', backpack: 'Open backpack' }
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url')
const token = `${b64({ alg: 'HS256' })}.${b64({ userId: 'fixture-user', username: 'fixture' })}.fixture`
async function until(fn, name) { const end = Date.now() + 30000; while (!await fn()) { assert.ok(Date.now() < end, `Timed out: ${name}`); await new Promise((r) => setTimeout(r, 100)) } }
async function signedBundle(home) {
  const dir = path.join(home, 'plugins/forsion-extend'); fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  const files = ['package.json', 'manifest.json', 'dist/main.js', 'dist/desktop.mjs']
  for (const f of files) fs.copyFileSync(path.join(EXTEND, f), path.join(dir, f))
  // 只有隔离 home 里这份的版本号被抬高(压过随包那份);仓库与已装的 npm 包都不动。
  for (const f of ['package.json', 'manifest.json']) { const p = path.join(dir, f), data = JSON.parse(fs.readFileSync(p)); data.version = '99.0.0-e2e'; fs.writeFileSync(p, JSON.stringify(data)) }
  const privateKey = process.env.EXTEND_SIGNING_KEY || fs.readFileSync(path.join(os.homedir(), '.forsion-dev/secrets/forsion-extend-signing/key.pem'), 'utf8')
  const { signFiles } = await import(pathToFileURL(path.join(EXTEND, 'scripts/signature.mjs')).href)
  const signature = await signFiles(dir, files, createPrivateKey(privateKey)); fs.writeFileSync(path.join(dir, 'SIGNATURE'), JSON.stringify(signature))
}
async function main() {
  assert.ok(fs.readFileSync(path.join(EXTEND, 'dist/main.js'), 'utf8').includes('registerStoreView'), `Extend at ${EXTEND} has no store pages: build a 0.9+ checkout or set EXTEND_DIR`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-store-pages-')), purchases = [], appLogs = []
  fs.mkdirSync(OUT, { recursive: true }); await signedBundle(home)
  let balance = 1240, stock = 3, base, app, win, market
  const plans = [
    { id: 'p-plus', name: 'Plus', tier: 'plus', description: 'Light daily use', priceMonthly: 29.9, priceQuarterly: 79.9, priceYearly: 299, currency: 'CNY', isActive: true },
    { id: 'p-pro', name: 'Pro', tier: 'pro', description: 'Four times the Plus quota', priceMonthly: 99, priceQuarterly: 259, priceYearly: 999, currency: 'CNY', isActive: true },
  ]
  const packs = [{ id: 'k-basic', name: 'Basic', description: 'Starter pack', credits: 100, price: 9.9, currency: 'CNY', isActive: true }]
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://fixture').pathname
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (p === '/api/brain/users/me' || p === '/api/auth/me') return send(200, { id: 'fixture-user', username: 'fixture', nickname: 'Fixture', role: 'USER', membershipTier: 'plus' })
    if (p === '/api/auth/handoff') return send(200, { code: 'C0DE-E2E', expires_in: 60 })
    if (p === '/api/membership/my') return send(200, { membership: { tier: 'plus', status: 'active', expiresAt: '2026-11-03T00:00:00.000Z', plan: { name: 'Plus' } } })
    if (p === '/api/credits/balance') return send(200, { balance })
    if (p === '/api/features') return send(200, { payment: true, shop: true })
    if (p === '/api/payment/offerings') return send(200, { packages: packs, membershipPlans: plans })
    if (p === '/api/shop/products') return send(200, [{ id: 'code-5', name: 'API code 5', description: 'Redeem at the token site', type: 'api_quota_key', pricePoints: 99, priceRmb: 9.9, currency: 'CNY', isActive: true, availableKeys: stock }])
    if (p === '/api/shop/purchase' && req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c)
      purchases.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), auth: req.headers.authorization })
      balance -= 99; stock -= 1
      return send(200, { success: true, payMethod: 'points', inventoryItemId: 'inv-1', key: 'FSN-E2E-KEY-0001' })
    }
    if (p === '/api/market/items') return send(200, { items: [] })
    req.resume(); return send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  fs.writeFileSync(path.join(home, 'config.json'), '{}'); fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ token, cloudUrl: base }))
  fs.mkdirSync(path.join(home, 'userdata-dev')); fs.writeFileSync(path.join(home, 'userdata-dev/tangu-desktop-config.json'), JSON.stringify({ cloudUrl: base, mode: 'external', unitHostEnabled: false }))
  const stub = await startStubEngine()
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, `--lang=${lang === 'zh' ? 'zh-CN' : 'en-US'}`, ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: base, TANGU_BACKEND_URL: stub.url }, timeout: 60000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => appLogs.push(String(d)))
    // 「去支付」会调 shell.openExternal:换成记录,测试里不许真开浏览器
    await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (url) => { globalThis.__opened.push(String(url)) } })
    const opened = () => app.evaluate(() => globalThis.__opened)
    win = await app.firstWindow(); win.setDefaultTimeout(15000); await win.waitForSelector('#root'); await win.waitForTimeout(1200); await skipOnboarding(win)
    assert.equal((await win.evaluate(() => window.tangu.authStatus())).loggedIn, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'plugins/forsion-extend/manifest.json'))).version, '99.0.0-e2e')
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'market', title: 'market', builtin: 'market', params: { n: Date.now() } }))
    await until(async () => { market = app.windows().find((w) => !w.isClosed() && w.url().includes('window=floating') && w.url().includes('market')); return !!market }, 'market window')
    market.setDefaultTimeout(15000); await market.locator('.settings-nav').waitFor()

    // ① 左栏:Extend 的三页进了「会员与积分」一组;没有混进设置里的「Forsion 云端」
    const view = (id) => market.locator(`[data-store-view="forsion-extend:${id}"]`)
    await view('membership').waitFor()
    const group = market.locator('[data-store-group]')
    assert.equal(await group.locator('.settings-nav-grouphead').textContent(), L.group) // textContent:英文界面的组名有 text-transform,innerText 读到的是大写
    assert.deepEqual((await group.locator('button').allInnerTexts()).map((s) => s.trim()), [L.membership, L.points, L.items])

    // ② 会员页:真页面挂进商店正文;切年付后「去支付」只开支付页,地址带档位与周期预选、用一次性交接码而不是 token
    await view('membership').click()
    await market.locator('[data-fx-page="membership"] .fx-shop-tier').first().waitFor()
    assert.equal(await market.locator('[data-plugin-settings="forsion-extend:membership"]').count(), 1)
    assert.equal(await market.locator('.settings-main-title').innerText(), L.membership)
    assert.equal(await market.locator('.mk-search').count(), 0)
    await market.evaluate(() => document.fonts.ready); await market.screenshot({ path: path.join(OUT, `${lang}-membership.png`) })
    await market.locator('.fx-seg button', { hasText: L.yearly }).click()
    await market.locator('.fx-shop-tier', { hasText: 'Pro' }).getByRole('button', { name: L.pay }).click()
    await until(async () => (await opened()).length === 1, 'pay page opened')
    assert.equal((await opened())[0], `${base}/pay?tab=membership&plan=p-pro&period=yearly&code=C0DE-E2E&redirect=${encodeURIComponent(`${base}/account`)}`)
    assert.ok(!(await opened())[0].includes(token))

    // ③ 积分页:积分包「去支付」开支付页的积分 tab
    await view('points').click()
    await market.locator('[data-fx-page="points"] .fx-shop-card').first().waitFor()
    await market.screenshot({ path: path.join(OUT, `${lang}-points.png`) })
    await market.locator('.fx-shop-card', { hasText: 'Basic' }).getByRole('button').click()
    await until(async () => (await opened()).length === 2, 'credits pay page opened')
    assert.ok((await opened())[1].startsWith(`${base}/pay?tab=credits&code=`))
    assert.equal(purchases.length, 0) // 花钱的一律不在应用里下单

    // ④ 物品页:积分兑换点两次才发请求;请求带本机登录凭据、契约对得上;成功后亮出卡密,余额与库存跟着变
    await view('items').click()
    const card = market.locator('[data-fx-page="items"] .fx-shop-card', { hasText: 'API code 5' }); await card.waitFor()
    await card.getByRole('button', { name: L.redeem }).click()
    await card.getByRole('button', { name: L.confirm }).waitFor(); assert.equal(purchases.length, 0)
    await market.screenshot({ path: path.join(OUT, `${lang}-items-confirm.png`) })
    await card.getByRole('button', { name: L.confirm }).click()
    await card.locator('.fx-shop-key code').waitFor()
    assert.deepEqual(purchases, [{ body: { productId: 'code-5', payMethod: 'points' }, auth: `Bearer ${token}` }])
    assert.equal(await card.locator('.fx-shop-key code').innerText(), 'FSN-E2E-KEY-0001')
    assert.ok((await card.innerText()).includes(L.redeemed))
    await until(async () => (await market.locator('[data-testid="shop-balance"]').innerText()) === '1,141', 'balance refreshed')
    await market.screenshot({ path: path.join(OUT, `${lang}-items-redeemed.png`) })

    // ⑤ 深色 + 窄窗:不横向溢出
    await market.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('id=market')); w.setSize(780, 780) })
    await market.setViewportSize({ width: 780, height: 780 }); await view('membership').click(); await market.locator('.fx-shop-tier').first().waitFor()
    await market.screenshot({ path: path.join(OUT, `${lang}-membership-dark-narrow.png`) })
    assert.equal(await market.locator('.mk-body').evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)

    // ⑥ 设置里的「Forsion 云端」没有被这三页混进去(它们只进商店左栏)
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'settings', builtin: 'settings', params: { tab: 'forsion/fx:forsion-extend:backpack', n: Date.now() } }))
    let settings; await until(async () => { settings = app.windows().find((w) => !w.isClosed() && w.url().includes('window=floating') && w.url().includes('settings')); return !!settings }, 'settings window')
    settings.setDefaultTimeout(15000); await settings.locator('[data-fx-page="backpack"]').waitFor()
    const settingsNav = (await settings.locator('.settings-nav button').allInnerTexts()).map((x) => x.trim())
    assert.ok(!settingsNav.includes(L.items) && !settingsNav.includes(L.membership), settingsNav.join(' / '))
    await settings.close()
    console.log(`PASS ${lang}: signed Extend pages in the store nav, pay deep links (plan/period, handoff code, no token), points redemption via real IPC with the device credential, key shown, balance refreshed, dark/narrow; ${OUT}`)
  } catch (e) { if (market && !market.isClosed()) await market.screenshot({ path: path.join(OUT, `${lang}-failed.png`) }).catch(() => {}); console.error(appLogs.join('').split('\n').filter((l) => /cloud-host|extend|error/i.test(l)).slice(-12).join('\n')); throw e }
  finally { if (app) await app.close().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(r)); await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
