/** 商店里已装插件的「打开设置」落点:真 Electron / IPC / 磁盘 / 内置引擎,商店清单是本地夹具。
 * 三个插件的**目录名都与装载 id 不同** —— 落点只能靠 market:installed 带回的 id 对上:
 *   Forsion 插件 → 设置窗口直达它的详情面;引擎插件(有设置项)→ 它的设置表单;引擎插件(没设置项)→ 引擎插件列表。
 * 第二、三步时设置窗口已经开着,一并验「开着也跳得过去」。先 npm run build。截图落 outputs/market-open-settings/。
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert/strict')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'outputs', 'market-open-settings')
async function until(check, description) {
  const deadline = Date.now() + 45000
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${description}`); await new Promise((r) => setTimeout(r, 100)) }
}
function writeFiles(dir, files) { fs.mkdirSync(dir, { recursive: true }); for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content) }
const enginePlugin = (id, name, settings) => ({
  'tangu-plugin.json': JSON.stringify({ id, name, version: '1.0.0', apiVersion: 1, entry: 'index.mjs' }),
  'index.mjs': `export default { activate(ctx) { ctx.registerPlugin(${JSON.stringify({ id, name, description: 'Open-settings fixture', ...(settings ? { settings } : {}) })}) } }`,
})
async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, 'out/main/main.js')), 'Run npm run build first'); fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-market-settings-')), userData = path.join(home, 'userdata')
  const items = [
    { id: 'item-ui', name: 'UI Plugin', type: 'amadeus-plugin', installSlug: 'ui-dir' },
    { id: 'item-engine', name: 'Engine Plugin', type: 'plugin', installSlug: 'engine-dir' },
    { id: 'item-bare', name: 'Bare Plugin', type: 'plugin', installSlug: 'bare-dir' },
  ].map((x) => ({ ...x, source: 'zip', latestVersion: '1.0.0', author: 'Fixture author', summary: 'Open-settings fixture', downloads: 0, tags: [] }))
  writeFiles(path.join(home, 'plugins', 'ui-dir'), { 'manifest.json': JSON.stringify({ id: 'ui-real', name: 'UI Plugin', version: '1.0.0', apiVersion: 1 }), 'main.js': '' })
  writeFiles(path.join(home, 'tangu/plugins', 'engine-dir'), enginePlugin('engine-real', 'Engine Plugin', { fields: [{ key: 'greeting', type: 'text', label: 'Fixture greeting' }] }))
  writeFiles(path.join(home, 'tangu/plugins', 'bare-dir'), enginePlugin('bare-real', 'Bare Plugin'))
  fs.writeFileSync(path.join(home, 'config.json'), '{"plugins":{"global":{"engine-real":{"__enabled":true},"bare-real":{"__enabled":true}}}}')
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://fixture')
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (u.pathname === '/api/market/items') return send(200, { items: items.filter((x) => !u.searchParams.get('type') || x.type === u.searchParams.get('type')) })
    const item = items.find((x) => u.pathname === `/api/market/items/${x.id}`)
    return item ? send(200, { ...item, readme: '# Fixture plugin' }) : send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`
  fs.mkdirSync(`${userData}-dev`); fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', cloudUrl: base, unitHostEnabled: false }))
  const env = { ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: base }; delete env.TANGU_BACKEND_URL
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env, timeout: 60000 })
    const win = await app.firstWindow(); win.setDefaultTimeout(15000); await win.waitForSelector('#root'); await win.waitForTimeout(1000)
    for (const label of ['跳过引导', 'Skip onboarding', 'Skip']) { const skip = win.getByRole('button', { name: label, exact: true }); if (await skip.count()) await skip.click() }
    await win.waitForSelector('.rb'); await until(async () => (await win.evaluate(() => window.tangu.backendStatus())).state === 'ready', 'managed engine ready')
    const floating = () => app.windows().filter((w) => w.url().includes('window=floating') && !w.isClosed())
    /** 商店 → 已安装 → 点进这张卡 → 「打开设置」;返回落在 `selector` 上的那个设置窗口。 */
    async function openSettingsFromMarket(name, selector) {
      await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'market', title: 'Market', builtin: 'market', params: { n: Date.now() } }))
      let market
      await until(async () => { for (const w of floating()) if (await w.locator('.mk-body').count()) market = w; return !!market }, 'market panel')
      market.setDefaultTimeout(15000)
      await market.getByRole('button', { name: '已安装', exact: true }).click()
      await market.locator('.mk-card-title', { hasText: name }).click(); await market.locator('.mk-detail-sidebar').waitFor()
      await market.locator('.mk-detail-actions').getByRole('button', { name: '打开设置' }).click()
      let settings
      await until(async () => { for (const w of floating()) if (await w.locator(selector).count().catch(() => 0)) settings = w; return !!settings }, `${name} → ${selector}`)
      await until(async () => market.isClosed(), 'market panel closes')
      await settings.evaluate(() => document.fonts.ready); await settings.screenshot({ path: path.join(OUT, `${name.split(' ')[0].toLowerCase()}.png`) })
      return settings
    }
    // 1. Forsion 插件:直达它自己的详情面(不是卡片列表)
    let settings = await openSettingsFromMarket('UI Plugin', '[data-plugin-detail="ui-real"]')
    assert.equal(await settings.locator('.plugin-card').count(), 0, 'plugin card list must not be showing')
    // 2. 引擎插件(启用且有设置项):它的设置表单。设置窗口此时开着
    settings = await openSettingsFromMarket('Engine Plugin', 'text=Fixture greeting')
    assert.equal(await settings.locator('[data-engine-plugin]').count(), 0, 'engine plugin list must not be showing')
    // 3. 引擎插件(没设置项):引擎插件列表,那一行在
    settings = await openSettingsFromMarket('Bare Plugin', '.settings-sub[data-settings-sub="pl-engine"] [data-engine-plugin="bare-real"]')
    console.log(`PASS market open-settings: Forsion detail / engine settings form / engine list — screenshots in ${OUT}`)
  } finally {
    await app?.close().catch(() => {}); server.close(); fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
