// 连接器目录的真机走查(连接器方案 P2 桌面那半):真 standalone 引擎 × 真 Electron 商店 / 设置页 × 假目录(/api/connectors)×
// 假授权服务器 × 要 Bearer 的假 MCP × 「用户自带 Key」的假 MCP,全在 127.0.0.1、隔离 home。浏览器那一步由脚本代劳(同 mcp-oauth.electron.cjs)。
// 走:商店连接 → 浏览器登录 → 出工具;Key 型填 Key → 连上(Key 不进配置 / 引擎日志);设置页看「已下线」与授权范围;
//     目录改地址 → 本地条目跟着改、旧 Key 作废;设置页断开 → 令牌与条目都删掉。
// 先 `cd ../tangu-agent && npm run build` 与 `npx electron-vite build`。用法:node scripts/connectors.electron.cjs(CONN_SHOTS=<目录> 指定截图位置)
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const ENGINE = path.join(ROOT, '..', 'tangu-agent')
const FIXTURES = path.join(ENGINE, 'test', 'fixtures')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-connectors-'))
const engineHome = path.join(home, 'tangu') // 与安装版同形:共享域 = home,引擎 home = home/tangu(桌面写目录缓存的地方)
const shots = process.env.CONN_SHOTS || path.join(home, 'shots')
fs.mkdirSync(engineHome, { recursive: true })
fs.mkdirSync(shots, { recursive: true })
const TOKEN = 'connectors-e2e'
const KEY = 'amap-K3y+/=secret'
let passed = 0
const check = (name, ok) => { if (!ok) throw new Error(`FAIL ${name}`); passed++; console.log(`PASS ${name}`) }
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
async function until(fn, ms, what) {
  const end = Date.now() + ms
  for (;;) { const v = await fn().catch(() => undefined); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await new Promise(r => setTimeout(r, 150)) }
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const pair = (zh, en) => ({ zh, en })

async function main() {
  const entry = path.join(ENGINE, 'dist', 'standalone', 'main.js')
  if (!fs.existsSync(entry) || !fs.existsSync(path.join(ROOT, 'out', 'main', 'main.js'))) throw new Error('build first: tangu-agent `npm run build` and desktop `npx electron-vite build`')
  const { startHttpServer } = await import(pathToFileURL(path.join(FIXTURES, 'fake-mcp-server.mjs')).href)
  const { startOAuthServer, browse } = await import(pathToFileURL(path.join(FIXTURES, 'fake-oauth-server.mjs')).href)
  const as = await startOAuthServer()
  const demo = await startHttpServer({ tag: 'demo', auth: { isValid: t => as.access.has(t), authServer: as.url } })
  const amap = await startHttpServer({ tag: 'amap', auth: { isValid: (_t, _b, url) => new URL(url, 'http://x').searchParams.get('key') === KEY, authServer: as.url } })
  const plain = await startHttpServer({ tag: 'old' })
  const catalog = { connectors: [
    { id: 'demo', kind: 'remote-mcp', status: 'published', order: 10, name: pair('演示文档', 'Demo docs'), description: pair('搜索和编辑演示文档', 'Search and edit demo docs'), url: demo.url, oauth: { scopes: ['docs.read', 'docs.write'] }, alwaysAsk: ['echo'] },
    { id: 'amap', kind: 'remote-mcp', status: 'published', order: 20, name: pair('演示地图', 'Demo maps'), description: pair('地点搜索与路线规划', 'Place search and routes'), url: `${amap.url}?key={userKey}`, auth: { type: 'user-key', applyUrl: 'https://console.example.com/key' } },
    { id: 'gone', kind: 'remote-mcp', status: 'retired', order: 30, name: pair('旧服务', 'Old service'), description: pair('已经下线', 'Retired'), url: plain.url },
  ] }
  let catalogHits = 0
  const cat = http.createServer((req, res) => {
    if (req.url !== '/api/connectors') { res.writeHead(404).end(); return }
    catalogHits++
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(catalog))
  })
  await new Promise(r => cat.listen(0, '127.0.0.1', r))
  const catalogBase = `http://127.0.0.1:${cat.address().port}`
  // 「已下线」那条:之前就连上了
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mcp: { mcpServers: { gone: { url: plain.url, connector: 'gone' }, mine: { url: plain.url } } } }))
  const port = await freePort()
  const engineLogFile = path.join(home, 'engine.log')
  const engineLog = fs.openSync(engineLogFile, 'a')
  const engine = spawn(process.execPath, [entry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(home, 'state.db'), '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN], {
    env: { ...process.env, TANGU_HOME: engineHome, TANGU_MCP_OAUTH_PORT: String(await freePort()), TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0' },
    stdio: ['ignore', engineLog, engineLog],
  })
  const engineUrl = `http://127.0.0.1:${port}`
  const tools = async () => (await (await fetch(`${engineUrl}/agent/tools?appId=tangu-agent`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).mcp ?? []
  const rowOf = async (name) => (await tools()).find(r => r.server === name)
  await until(async () => (await fetch(`${engineUrl}/health`)).ok, 60000, 'engine /health')
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: engineUrl, token: TOKEN, cloudUrl: catalogBase })) }
  const app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: engineHome, TANGU_BACKEND_URL: engineUrl, TANGU_HARNESS_QUIET: '1' } })
  const cfg = () => readJson(path.join(home, 'config.json')).mcp.mcpServers
  const auth = () => { try { return readJson(path.join(home, 'connector-auth.json')) } catch { return {} } }
  try {
    await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u) } })
    const main = await app.firstWindow()
    await main.waitForSelector('#root', { timeout: 40000 })
    check('leave onboarding', await skipOnboarding(main))
    await until(async () => fs.existsSync(path.join(engineHome, 'connector-catalog.json')), 15000, 'catalog cached at startup')
    check('startup fetch cached the catalog in the engine home', readJson(path.join(engineHome, 'connector-catalog.json')).connectors.find(c => c.id === 'demo').alwaysAsk[0] === 'echo')

    const floating = async (sel) => {
      for (let i = 0; i < 150; i++) {
        const w = app.windows().filter(x => !x.isClosed() && x.url().includes('window=floating')).pop()
        if (w && await w.locator(sel).count()) { await app.evaluate(({ BrowserWindow }) => { for (const b of BrowserWindow.getAllWindows()) if (b.webContents.getURL().includes('window=floating')) b.setContentSize(1180, 820) }); return w }
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error(`timeout: floating ${sel}`)
    }
    const shot = async (w, name) => { await w.waitForTimeout(300); await w.screenshot({ path: path.join(shots, `${name}.png`) }) }

    // ── 商店 ──
    const hitsBefore = catalogHits
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'market', title: 'Store', builtin: 'market', params: { tab: 'connector', nonce: Date.now() } }))
    let win = await floating('[data-connector-store]')
    await win.locator('[data-connector="demo"]').waitFor({ timeout: 15000 })
    check('opening the store refetches the catalog', catalogHits > hitsBefore)
    check('store lists published connectors only', await win.locator('[data-connector="amap"]').count() === 1 && await win.locator('[data-connector="gone"]').count() === 0)
    check('Connectors category is selected in the nav', await win.locator('.settings-nav button.active', { hasText: '连接器' }).count() === 1)
    await shot(win, 'A-store-light')

    await win.locator('[data-connector="demo"] [data-connector-action="connect"]').click()
    const opened = await until(() => app.evaluate(() => globalThis.__opened.find(u => u.includes('/authorize'))), 40000, 'openExternal')
    check('sign-in page opened in the browser', opened.startsWith(`${as.url}/authorize`))
    check('entry written with the connector marker', cfg().demo?.connector === 'demo' && cfg().demo.url === demo.url && cfg().demo.oauth?.scopes?.length === 2)
    await win.getByText('已在浏览器打开「演示文档」的登录页', { exact: false }).waitFor({ timeout: 5000 })
    check('browser callback page loads', await browse(opened) === 200)
    await win.locator('[data-connector="demo"][data-connector-state="connected"]').waitFor({ timeout: 20000 })
    check('card turns Connected', await win.locator('[data-connector="demo"] [data-connector-action="connected"]').count() === 1)
    check('engine lists the connector tools', ((await rowOf('demo'))?.tools.length ?? 0) > 0)
    await win.getByText('已连接「演示文档」', { exact: false }).waitFor({ timeout: 5000 })

    await win.locator('[data-connector="amap"] [data-connector-action="connect"]').click()
    await win.locator('[data-connector-keyform="amap"]').waitFor({ timeout: 40000 })
    check('user-key connector asks for a key, never opens a browser', !(await app.evaluate(() => globalThis.__opened.some(u => !u.includes('/authorize')))))
    await shot(win, 'B-store-keyform-light')
    await win.locator('[data-connector-keyform="amap"] input').fill('wrong-key')
    await win.locator('[data-connector-keyform="amap"] button[type="submit"]').click()
    await win.getByText('这个 Key 没有通过', { exact: false }).waitFor({ timeout: 15000 })
    check('wrong key is rejected and the form stays', await win.locator('[data-connector-keyform="amap"]').count() === 1)
    await win.locator('[data-connector-keyform="amap"] input').fill(KEY)
    await win.locator('[data-connector-keyform="amap"] button[type="submit"]').click()
    await win.locator('[data-connector="amap"][data-connector-state="connected"]').waitFor({ timeout: 20000 })
    check('right key connects', ((await rowOf('amap'))?.tools.length ?? 0) > 0)
    check('MCP config keeps the template only', cfg().amap.url === `${amap.url}?key={userKey}` && !fs.readFileSync(path.join(home, 'config.json'), 'utf8').includes('K3y'))
    check('key stored on this computer', Object.values(auth()).some(r => r.userKey === KEY))
    await shot(win, 'C-store-connected-light')
    await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await shot(win, 'C-store-connected-dark')
    await win.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.dataset.mode = 'light' })

    // ── 设置页 ──
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'mcp', n: Date.now() } }))
    win = await floating('[data-connector-settings]')
    const crow = (id) => win.locator(`[data-connector-row="${id}"]`)
    await crow('amap').getByText(/已连接 · \d+ 个工具/).waitFor({ timeout: 15000 })
    check('settings lists connected connectors', await crow('demo').count() === 1 && await crow('gone').count() === 1)
    check('retired connector is marked, not removed', await crow('gone').locator('.conn-badge', { hasText: '已下线' }).count() === 1 && !!cfg().gone)
    check('scopes are shown', await crow('demo').getByText('docs.read, docs.write', { exact: false }).count() === 1)
    check('connectors are not repeated in the manual list', await win.locator('.file-row b', { hasText: /^amap$/ }).count() === 0 && await win.locator('.file-row b', { hasText: /^mine$/ }).count() === 1)
    await shot(win, 'D-settings-light')
    await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await shot(win, 'D-settings-dark')
    await win.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.dataset.mode = 'light' })

    // 目录改了地址模板 → 本地条目跟着改,按模板存的 Key 作废
    catalog.connectors[1].url = `${amap.url}?v=2&key={userKey}`
    await win.evaluate(() => window.tangu.connectorsList(true))
    check('catalog URL change synced into the MCP config', cfg().amap.url === `${amap.url}?v=2&key={userKey}`)
    await until(async () => (await rowOf('amap'))?.status === 'needs-login', 20000, 'amap needs a key again')
    await crow('amap').getByRole('button', { name: /填写 Key/ }).waitFor({ timeout: 10000 })
    check('old key no longer applies after the URL changed', true)

    win.once('dialog', d => d.accept())
    await crow('demo').locator('[data-connector-disconnect]').click()
    await until(async () => !cfg().demo, 10000, 'demo removed from config')
    await crow('demo').waitFor({ state: 'detached', timeout: 10000 })
    check('disconnect removes the entry', !cfg().demo)
    check('disconnect removes the token', !Object.keys(auth()).some(k => k.startsWith(demo.url)))

    const log = fs.readFileSync(engineLogFile, 'utf8')
    check('engine log never contains the key', !log.includes('K3y') && !log.includes(encodeURIComponent(KEY)))
    fs.writeFileSync(path.join(shots, 'report.json'), JSON.stringify({ passed, home, shots }, null, 2))
    console.log(`PASS ${passed} checks; screenshots: ${shots}`)
  } finally {
    await app.close().catch(() => {})
    engine.kill('SIGTERM')
    for (const s of [demo, amap, plain, as]) await s.stop().catch(() => {})
    cat.close()
  }
}
main().catch(e => { console.error(e); console.error(`engine log: ${path.join(home, 'engine.log')}`); process.exitCode = 1 })
