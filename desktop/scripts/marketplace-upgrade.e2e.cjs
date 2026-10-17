/** Real renderer + Electron/IPC + isolated PostgreSQL market. Replays verified model results; never uses installed Forsion. */
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict')
const { createPrivateKey } = require('crypto'), { pathToFileURL } = require('url')
const { launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')
const ROOT = path.resolve(__dirname, '..'), EXTEND = path.resolve(process.env.EXTEND_DIR || path.join(ROOT, '../../Forsion-Extend'))
const OUT = path.resolve(process.env.MARKET_ACCEPTANCE_OUT || path.join(ROOT, 'outputs/marketplace-upgrade'))
const evidence = JSON.parse(fs.readFileSync(process.env.MARKET_LIVE_EVIDENCE, 'utf8'))
const fixture = JSON.parse(fs.readFileSync(process.env.MARKET_FIXTURE_INFO, 'utf8'))
assert.equal(new URL(fixture.base).hostname, '127.0.0.1', 'Only an isolated loopback fixture is permitted')
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${b64({ alg: 'HS256' })}.${b64({ userId: 'owner', username: 'Alice' })}.fixture`
const session = { id: 'market-acceptance', title: '插件选择验收', model_id: 'm1', archived: false, projectless: true, agent_config: null, created_at: '2026-10-14 17:00:00', updated_at: '2026-10-14 17:00:00' }
const recommendation = evidence.recommendation
const toolPairs = recommendation.toolArgs.map((call, n) => ({ call, result: recommendation.toolResults[n] })).filter(pair => pair.call.name === 'search_marketplace' && JSON.parse(pair.result.result).items?.length)
const messages = [
  { id: 'market-user', role: 'user', content: '帮我在商店找两个整理 PDF 阅读笔记的插件。', timestamp: Date.now() },
  { id: 'market-answer', role: 'model', content: recommendation.content, timestamp: Date.now() + 1,
    tool_calls: toolPairs.map(({ call }) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments }, ui_content_offset: 0 })),
    tool_results: toolPairs.map(({ call, result }) => ({ tool_call_id: call.id, name: call.name, content: result.result, isError: result.isError })) },
]
const state = () => fetch(`${fixture.base}/__fixture/state`).then(r => r.json())
const ownMessages = async () => (await state()).inbox.filter(row => JSON.parse(row.target_user_ids).includes('owner')).map(row => ({ ...row, body: row.body || '', sender_kind: 'server', sender_id: 'forsion', origin_broadcast_id: row.id, read_at: null, archived_at: null, attachments: null, expires_at: null }))
async function signedBundle(home) {
  const dir = path.join(home, 'plugins/forsion-extend'); fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  const files = ['package.json', 'manifest.json', 'dist/main.js', 'dist/desktop.mjs']
  for (const file of files) fs.copyFileSync(path.join(EXTEND, file), path.join(dir, file))
  for (const file of ['package.json', 'manifest.json']) { const target = path.join(dir, file), data = JSON.parse(fs.readFileSync(target)); data.version = '99.0.0-e2e'; fs.writeFileSync(target, JSON.stringify(data)) }
  const privateKey = process.env.EXTEND_SIGNING_KEY || fs.readFileSync(path.join(os.homedir(), '.forsion-dev/secrets/forsion-extend-signing/key.pem'), 'utf8')
  const { signFiles } = await import(pathToFileURL(path.join(EXTEND, 'scripts/signature.mjs')).href)
  fs.writeFileSync(path.join(dir, 'SIGNATURE'), JSON.stringify(await signFiles(dir, files, createPrivateKey(privateKey))))
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  assert.ok((await fetch(`${fixture.base}/__fixture/reset`, { method: 'POST' })).ok)
  const errors = [], checks = []
  const ctx = await launch({ tag: 'marketplace-upgrade', fixtures: { agents: [], sessions: [session] }, messages,
    beforeLaunch: async ({ home, userData, backend }) => {
      await signedBundle(home)
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ token, cloudUrl: fixture.base }))
      fs.writeFileSync(path.join(home, 'config.json'), '{}')
      for (const dir of [userData, `${userData}-dev`]) fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: backend, token: 'e2e', cloudUrl: fixture.base, unitHostEnabled: false }))
    },
    stubOverride: async ({ path: route, method }) => {
      if (route === '/agent/inbox/unread-count') { const messages = await ownMessages(); return { count: messages.length, latestId: messages[0]?.id || null } }
      if (route === '/agent/inbox' && method === 'GET') return { messages: await ownMessages() }
      if (route.startsWith('/agent/inbox')) return { ok: true, pulled: true, added: 1 }
      return undefined
    },
  })
  const { app, win, home } = ctx
  win.on('pageerror', error => errors.push(String(error)))
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(OUT, `${name}.png`) }) }
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    await win.locator('.t2s-srow[data-sel-id="market-acceptance"]').first().click()
    await win.locator('.mk-chat-card').first().waitFor()
    assert.equal(await win.locator('.mk-chat-card').count(), 2)
    assert.equal(await win.locator('.mk-chat-card [data-market-compat="compatible"]').count(), 2)
    await shot(win, 'chat-cards-light'); checks.push('Real model search results rendered as native Chat View cards')
    for (const item of fixture.entries.slice(0, 2)) {
      const button = win.locator(`[data-market-card-install="${item.id}"]`)
      await button.click(); await button.filter({ hasText: '已安装' }).waitFor({ timeout: 30000 })
      assert.ok(fs.existsSync(path.join(home, 'plugins', item.installSlug, 'manifest.json')))
    }
    const loaded = await win.evaluate(() => window.amadeus.listPlugins())
    assert.ok(fixture.entries.slice(0, 2).every(item => loaded.some(plugin => plugin.id === item.installSlug)))
    checks.push('Two same-name / same-manifest-ID plugins installed into distinct directories and host IDs')
    await shot(win, 'chat-installed')
    await win.locator(`[data-marketplace-item="${fixture.entries[0].id}"]`).getByRole('button', { name: '详情', exact: true }).click()
    let market
    for (let i = 0; i < 100 && !market; i++) { market = app.windows().find(page => !page.isClosed() && page.url().includes('window=floating') && page.url().includes('market')); if (!market) await win.waitForTimeout(100) }
    assert.ok(market); market.setDefaultTimeout(15000); market.on('pageerror', error => errors.push(String(error)))
    await market.locator('.mk-detail-hero').waitFor()
    await shot(market, 'store-overview-light')
    await market.getByRole('button', { name: '评论', exact: true }).click()
    await market.locator('.mk-comment').first().waitFor()
    const area = market.locator('.mk-comment-compose textarea'); await area.fill('作者补充：可以保留页码。')
    await market.getByRole('button', { name: '发布评论', exact: true }).click()
    await market.getByText('作者补充：可以保留页码。', { exact: true }).waitFor()
    await market.locator('.mk-comment').filter({ hasText: '作者补充：可以保留页码。' }).getByRole('button', { name: '编辑', exact: true }).click()
    await area.fill('作者补充：页码会保留。'); await market.getByRole('button', { name: '保存', exact: true }).click()
    await market.getByText('作者补充：页码会保留。', { exact: true }).waitFor()
    await market.locator('.mk-comment').filter({ hasText: '可以保留 PDF 的页码吗？' }).getByRole('button', { name: '回复', exact: true }).click()
    await area.fill('可以，在摘录中保留页码。'); await market.getByRole('button', { name: '发布评论', exact: true }).click()
    await market.locator('.mk-comment-replies').getByText('可以，在摘录中保留页码。', { exact: true }).waitFor()
    await shot(market, 'store-comments-light'); checks.push('Comments, author badge, edits and threaded replies through authenticated real routes')
    const before = (await state()).inbox.length
    await market.getByLabel('接收此插件的评论消息', { exact: true }).uncheck()
    await market.waitForFunction(() => [...document.querySelectorAll('.mk-notification-settings input')].every(input => !input.disabled))
    await fetch(`${fixture.base}/__fixture/comment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Muted notification probe' }) })
    assert.equal((await state()).inbox.length, before)
    await market.getByLabel('接收此插件的评论消息', { exact: true }).check()
    await market.waitForFunction(() => [...document.querySelectorAll('.mk-notification-settings input')].every(input => !input.disabled))
    await market.getByLabel('接收商店评论消息', { exact: true }).uncheck()
    await market.waitForFunction(() => !document.querySelector('.mk-notification-settings input').disabled)
    await fetch(`${fixture.base}/__fixture/comment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Global mute probe' }) })
    assert.equal((await state()).inbox.length, before); checks.push('Per-item and global notification switches suppress actual inbox writes')
    await market.getByLabel('接收商店评论消息', { exact: true }).check()
    await market.getByRole('button', { name: '版本', exact: true }).click(); await market.locator('.mk-version-row').waitFor(); await shot(market, 'store-versions')
    await win.getByRole('button', { name: '切换明暗模式', exact: true }).click()
    await market.waitForFunction(() => document.documentElement.dataset.mode === 'dark')
    await shot(market, 'store-dark')
    await app.evaluate(({ BrowserWindow }) => { const market = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('market')); market.setContentSize(600, 800) })
    await shot(market, 'store-narrow')
    await app.evaluate(({ BrowserWindow }) => { const market = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('market')); market.setContentSize(1180, 850) })
    await market.locator('.mk-detail-back').click(); await market.locator('.mk-upgrade-filters').waitFor(); await shot(market, 'store-home-filters')
    await market.getByLabel('只看适配当前版本', { exact: true }).check()
    assert.equal(await market.getByText('Future PDF', { exact: true }).count(), 0); checks.push('Homepage compatibility filter excludes incompatible store entries')
    await assert.rejects(() => win.evaluate(id => window.tangu.marketInstall(id), fixture.entries[2].id), /400|requires|incompatible/)
    assert.ok(!fs.existsSync(path.join(home, 'plugins', fixture.entries[2].installSlug))); checks.push('Incompatible package rejected before disk writes')
    await enterSpace(win, 'inbox'); await win.getByText('New comment on PDF Notes', { exact: true }).first().click()
    await win.getByRole('button', { name: '查看插件评论', exact: true }).waitFor(); await shot(win, 'inbox-comment')
    await win.getByRole('button', { name: '查看插件评论', exact: true }).click(); await market.locator('.mk-discussion').waitFor(); checks.push('Author inbox notification opens the matching plugin discussion')
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ok: true, checks, errors, fixture: 'PGlite + real market routes; controlled inbox transport; real GPT-6 Luna result replay', installedHomeRemovedAfterRun: true }, null, 2))
    console.log(JSON.stringify({ ok: true, checks, errors, out: OUT }, null, 2))
  } catch (error) { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ok: false, checks, errors, error: String(error) }, null, 2)); await win.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); throw error }
  finally { await ctx.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
