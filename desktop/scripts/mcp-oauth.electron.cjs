// MCP OAuth 登录的真机走查(连接器方案第一步):真 standalone 引擎(tangu-agent/dist)× 真 Electron 设置页 × 假授权服务器 ×
// 要 Bearer 的假 MCP server,全在 127.0.0.1、隔离 home。浏览器那一步由脚本代劳:拦下主进程的 shell.openExternal,
// 拿到授权页地址后自己去打开、跟回本机回调。先 `cd ../tangu-agent && npm run build` 与 `npx electron-vite build`。
// 用法:node scripts/mcp-oauth.electron.cjs(MCP_SHOTS=<目录> 指定截图位置)
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const ENGINE = path.join(ROOT, '..', 'tangu-agent')
const FIXTURES = path.join(ENGINE, 'test', 'fixtures')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mcp-oauth-'))
const shots = process.env.MCP_SHOTS || path.join(home, 'shots')
fs.mkdirSync(shots, { recursive: true })
const TOKEN = 'mcp-oauth-e2e'
let passed = 0
const check = (name, ok) => { if (!ok) throw new Error(`FAIL ${name}`); passed++; console.log(`PASS ${name}`) }
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
async function until(fn, ms, what) {
  const end = Date.now() + ms
  for (;;) { const v = await fn().catch(() => undefined); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await new Promise(r => setTimeout(r, 150)) }
}

async function main() {
  const entry = path.join(ENGINE, 'dist', 'standalone', 'main.js')
  if (!fs.existsSync(entry) || !fs.existsSync(path.join(ROOT, 'out', 'main', 'main.js'))) throw new Error('build first: tangu-agent `npm run build` and desktop `npx electron-vite build`')
  const { startHttpServer } = await import(pathToFileURL(path.join(FIXTURES, 'fake-mcp-server.mjs')).href)
  const { startOAuthServer, browse } = await import(pathToFileURL(path.join(FIXTURES, 'fake-oauth-server.mjs')).href)
  const as = await startOAuthServer()
  const mcp = await startHttpServer({ tag: 'demo', auth: { isValid: t => as.access.has(t), authServer: as.url } })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mcp: { mcpServers: { demo: { url: mcp.url } } } }))
  const port = await freePort()
  const engineLog = fs.openSync(path.join(home, 'engine.log'), 'a')
  const engine = spawn(process.execPath, [entry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(home, 'state.db'), '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN], {
    env: { ...process.env, TANGU_HOME: home, TANGU_MCP_OAUTH_PORT: String(await freePort()), TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0' },
    stdio: ['ignore', engineLog, engineLog],
  })
  const engineUrl = `http://127.0.0.1:${port}`
  await until(async () => (await fetch(`${engineUrl}/health`)).ok, 60000, 'engine /health')
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: engineUrl, token: TOKEN })) }
  const app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: engineUrl, TANGU_HARNESS_QUIET: '1' } })
  try {
    // 浏览器那一步:主进程的 shell.openExternal 换成记下地址
    await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u) } })
    const main = await app.firstWindow()
    await main.waitForSelector('#root', { timeout: 40000 })
    check('leave onboarding', await skipOnboarding(main))
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'mcp', n: Date.now() } }))
    let win
    for (let i = 0; i < 150; i++) { win = app.windows().filter(w => !w.isClosed() && w.url().includes('window=floating')).pop(); if (win && await win.locator('.settings-sub--mcp').count()) break; await new Promise(r => setTimeout(r, 100)) }
    await win.locator('.settings-sub--mcp').waitFor()
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('window=floating')) w.setContentSize(1120, 820) })
    const row = () => win.locator('.file-row').filter({ has: win.getByText('demo', { exact: true }) })
    const shot = async name => { await win.waitForTimeout(250); await win.screenshot({ path: path.join(shots, `${name}.png`) }) }

    await row().getByText('需要登录', { exact: true }).waitFor({ timeout: 20000 })
    check('401 shows needs sign-in with a sign-in button', await row().getByRole('button', { name: /登录/ }).count() === 1)
    check('no sign-out before signing in', await row().getByTitle('断开', { exact: true }).count() === 0)
    await shot('A-needs-login-light')

    await row().getByRole('button', { name: /登录/ }).click()
    const opened = await until(() => app.evaluate(() => globalThis.__opened[0]), 15000, 'openExternal')
    check('sign-in page opened in the browser', opened.startsWith(`${as.url}/authorize`))
    await win.getByText('已在浏览器打开「demo」的登录页', { exact: false }).waitFor({ timeout: 5000 })
    await row().getByText('登录中…', { exact: true }).waitFor({ timeout: 5000 })
    await shot('B-logging-in-light')
    check('browser callback page loads', await browse(opened) === 200)
    await row().getByText(/^已连接 · \d+ 工具$/).waitFor({ timeout: 20000 })
    check('connected after sign-in, tools listed', true)
    await win.getByText('已登录「demo」', { exact: false }).waitFor({ timeout: 5000 })
    check('sign-in message replaced by the result', await win.getByText('已在浏览器打开「demo」', { exact: false }).count() === 0)
    check('sign-out button appears', await row().getByTitle('断开', { exact: true }).count() === 1)
    check('sign-in button gone', await row().getByRole('button', { name: /^登录$/ }).count() === 0)
    const store = JSON.parse(fs.readFileSync(path.join(home, 'connector-auth.json'), 'utf8'))
    check('token stored for this server URL only', Object.keys(store).length === 1 && Object.keys(store)[0] === mcp.url && !!store[mcp.url].tokens)
    if (process.platform !== 'win32') check('token file is 0600', (fs.statSync(path.join(home, 'connector-auth.json')).mode & 0o777) === 0o600)
    await shot('C-connected-light')
    await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await shot('C-connected-dark')
    await win.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.dataset.mode = 'light' })

    win.once('dialog', d => d.accept())
    await row().getByTitle('断开', { exact: true }).click()
    await row().getByText('需要登录', { exact: true }).waitFor({ timeout: 10000 })
    const after = JSON.parse(fs.readFileSync(path.join(home, 'connector-auth.json'), 'utf8'))
    check('sign-out removes the stored token', Object.keys(after).length === 0)

    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.reload({ waitUntil: 'domcontentloaded' }); await win.locator('.settings-sub--mcp').waitFor()
    await row().getByText('Sign-in required', { exact: true }).waitFor({ timeout: 10000 })
    check('English labels', await row().getByRole('button', { name: /Sign in/ }).count() === 1)
    await shot('D-needs-login-en')
    fs.writeFileSync(path.join(shots, 'report.json'), JSON.stringify({ passed, home, shots }, null, 2))
    console.log(`PASS ${passed} checks; screenshots: ${shots}`)
  } finally {
    await app.close().catch(() => {})
    engine.kill('SIGTERM')
    await mcp.stop().catch(() => {})
    await as.stop().catch(() => {})
  }
}
main().catch(e => { console.error(e); console.error(`engine log: ${path.join(home, 'engine.log')}`); process.exitCode = 1 })
