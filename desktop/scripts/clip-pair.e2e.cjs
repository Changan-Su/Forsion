/**
 * 端到端:Clip 连接重做(Clip 体验优化方案 B 的必修那半)—— 真 Clip 构建 × 隔离 Forsion(out/ 构建、临时家目录、真引擎)× Chrome for Testing。
 *  ① 复现 11-05 用户现场:「允许其他设备连接本机」关着(真实缺省),且记着的互联口早漂到了随机口 → 本机只有固定口上的门铃(开发版 8792)。
 *     装上 Clip:不开欢迎页,后台只在本机找一遍 → 第一次打开侧栏:连接浮层自动弹出、只找到一台就自动发配对请求 →
 *    (台架后门 FORSION_UNIT_AUTO_PAIR 自动点「允许并打开」)→ 互联在漂走的随机口上打开,固定口换成转发入口 → Clip 经固定口领到令牌和
 *     Tangu 连接码 → 浏览器控制连上;Clip 记下的地址是固定口,不是随机口;外观跟着 Forsion;
 *  ② 改扩展文件夹里的版本号、叫引擎让连着的 Clip 重载 → 连回来报新版本,且不弹任何页(reason=update)。
 * 跑:cd ../tangu-agent && npm run build;npm run build;Clip worktree 里 `FORSION_GENESIS_ROOT=<Genesis> npx wxt build`;
 *    CLIP_BUILD=<那份 .output/chrome-mv3> node scripts/clip-pair.e2e.cjs     (HEADED=1 看着跑;SHOTS=<目录> 存侧栏截图)
 * 隔离:Unit 口只听回环(FORSION_UNIT_BIND_LOOPBACK=1 —— 自动批准配对时绝不能露到局域网);扩展桥另找空闲端口,不碰在跑的引擎;
 * Chrome 用临时配置。开发版的固定口是 8792 / 8794(安装版 8791 / 8793),要 8792 空着 —— 别的开发版 Forsion 开着就先关掉。
 */
const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const path = require('path')
const { chromium } = require('playwright-core')
const electron = require('./lib/launch-electron.cjs') // 台架统一入口:临时默认工作区,绝不打开开发者真实的 ~/Forsion-Dev/Amadeus
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const CLIP_ID = 'gpajikakdmhjebadgcbmhidkkajclfoi'
const UNIT_PORT = 8792 // 开发版构建的第一个固定口(main.ts clipEntrancePorts)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CFT = process.env.CFT_EXE || (() => {
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const exe = path.join(root, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 Chrome for Testing(npx playwright install chromium,或设 CFT_EXE)')
})()
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const portFree = (p) => new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))); s.listen(p, '127.0.0.1') })

let checks = 0
function check(name, ok, detail) {
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`)
  checks++
  console.log(`PASS ${name}`)
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(500)
  }
  throw new Error(`等不到:${label}`)
}

async function main() {
  const src = process.env.CLIP_BUILD
  if (!src || !fs.existsSync(path.join(src, 'manifest.json'))) throw new Error('设 CLIP_BUILD=<Clip 构建出的 chrome-mv3 目录>')
  if (!fs.existsSync(path.join(ROOT, 'out', 'main'))) throw new Error('先跑 npm run build')
  if (!(await portFree(UNIT_PORT))) throw new Error(`${UNIT_PORT} 被占(有开发版 Forsion 开着?)—— 台架要在这个固定口上开门铃`)
  const drifted = await freePort() // 用户现场:互联口撞过一次后退到随机口,一直记着
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-clippair-'))
  const clipDir = path.join(home, 'Forsion Clip') // 和装好的用户一样:Chrome 从这份加载(下面改它的版本号测重载)
  fs.cpSync(src, clipDir, { recursive: true })
  const version = JSON.parse(fs.readFileSync(path.join(clipDir, 'manifest.json'), 'utf8')).version
  const userData = path.join(home, 'userdata')
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({
      mode: 'managed', cloudUrl: 'http://127.0.0.1:9', sandbox: 'none', browserEnabled: false,
      defaultWorkspaceDir: path.join(home, 'workspace'), unitHostEnabled: false, unitWebPort: drifted,
    }))
  }
  let app = null
  let ctx = null
  let articleServer = null
  try {
    app = await electron.launch({
      ...(process.env.STAGE_ELECTRON ? { executablePath: process.env.STAGE_ELECTRON } : {}),
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: {
        ...process.env, TANGU_HOME: home, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1',
        FORSION_UNIT_AUTO_PAIR: '1', FORSION_UNIT_BIND_LOOPBACK: '1', FORSION_CLIP_ENTRANCE: '1', TANGU_BROWSER_EXTENSION_PORT: String(await freePort()),
      },
    })
    const mainLog = []
    app.process().stdout?.on('data', (d) => mainLog.push(...String(d).split('\n')))
    app.process().stderr?.on('data', (d) => mainLog.push(...String(d).split('\n')))
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40000 })
    if (!(await skipOnboarding(win))) throw new Error('主窗没离开首启引导')
    await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 90000 })
    const cfg = await win.evaluate(() => window.tangu.getConfig())
    const engine = (p, method = 'GET') => fetch(`${cfg.backendUrl}${p}`, { method, headers: { Authorization: `Bearer ${cfg.token}` } }).then((r) => r.json())
    const meta = await waitFor(() => fetch(`http://127.0.0.1:${UNIT_PORT}/unit/meta`).then((r) => (r.ok ? r.json() : null)), 30000, '固定口上的门铃起来')
    check('门铃开在固定口上、自报开发版(Clip 用它区分两份 Forsion)', meta.build === 'dev', meta)
    check('互联关着:只有门铃,配对流以外一律 503', (await fetch(`http://127.0.0.1:${UNIT_PORT}/unit/whoami`)).status === 503)
    await win.evaluate(() => { window.tangu.onConfigChanged(() => { window.__cfgChanged = (window.__cfgChanged || 0) + 1 }) })
    check('装之前:引擎没见过扩展(设置页显示「未安装」)', (await engine('/agent/browser-extension')).lastClient === null)

    ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'clippair-chrome-')), {
      executablePath: CFT, headless: process.env.HEADED !== '1', locale: 'zh-CN',
      args: [`--disable-extensions-except=${clipDir}`, `--load-extension=${clipDir}`, '--no-first-run'],
    })
    const isExtPage = (p) => p.url().startsWith(`chrome-extension://${CLIP_ID}/`)
    const worker = ctx.serviceWorkers().find((w) => w.url().includes(CLIP_ID)) || await ctx.waitForEvent('serviceworker', { timeout: 30000 })
    const integration = () => worker.evaluate(async () => (await chrome.storage.local.get('forsion_integration')).forsion_integration?.desktop || null)
    const found = await waitFor(async () => { const d = await integration(); return d && Object.keys(d.instances || {}).length ? d : null }, 20000, '装好后后台在本机找到 Forsion')
    const instanceId = Object.keys(found.instances)[0]
    check('装好后只在后台找一遍:找到这台、还没配对', found.instances[instanceId].build === 'dev' && !found.instances[instanceId].token && !found.pair, found)
    await sleep(1500)
    check('刚装上不开欢迎页(也不开别的扩展页)', !ctx.pages().some(isExtPage), ctx.pages().map((p) => p.url()))

    // 第一次打开侧栏:浮层自动弹出,只找到一台就自动发配对请求
    const panel = await ctx.newPage()
    await panel.setViewportSize({ width: 420, height: 760 })
    await panel.goto(`chrome-extension://${CLIP_ID}/sidepanel.html`)
    const rpc = (method, params = {}) => panel.evaluate(([m, p]) => chrome.runtime.sendMessage({ type: 'forsion-rpc', method: m, params: p }), [method, params])
    const live = await waitFor(async () => { const s = await engine('/agent/browser-extension'); return s.connected ? s : null }, 60000, 'Clip 用领到的连接码连上浏览器控制').catch(async (e) => {
      // 现场倒出来:侧栏上写了什么、Clip 存了什么、主进程记了什么
      console.log('PANEL', (await panel.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1200))
      console.log('SUMMARY', JSON.stringify(await rpc('desktop-summary').catch((err) => String(err))))
      console.log('BRIDGE', JSON.stringify(await engine('/agent/browser-extension').then((x) => ({ listening: x.listening, error: x.error, port: x.port })).catch((err) => String(err))))
      console.log('LOG', mainLog.filter((l) => /unit|pair|配对|entrance|入口/i.test(l)).slice(-20).join('\n'))
      throw e
    })
    check('第一次打开侧栏就连上:自动发请求、批准后领到连接码、连上 Tangu 浏览器控制', live.clients.at(-1)?.version === version, live.clients)
    check('引擎记下了连上来的扩展(设置页据此分「未安装 / 未连接」)', live.lastClient?.version === version, live.lastClient)
    const cfgAfter = await win.evaluate(() => window.tangu.getConfig())
    check('门铃上点了允许 = 顺带打开了「允许其他设备连接本机」', cfgAfter.unitHostEnabled === true)
    check('打开互联后通知了各窗口重读配置(开着的设置页不显示旧的「关」)', (await win.evaluate(() => window.__cfgChanged || 0)) >= 1)
    const summary = await waitFor(async () => { const r = await rpc('desktop-summary'); return r?.ok && r.data.state === 'connected' ? r.data : null }, 20000, '摘要显示已连上')
    check('连上的是这一台,记下的地址是固定口(互联口在漂走的随机口上,经转发入口连通)',
      summary.current?.instanceId === instanceId && summary.current?.endpoint === `http://127.0.0.1:${UNIT_PORT}` && (await integration()).instances[instanceId].endpoint === `http://127.0.0.1:${UNIT_PORT}`,
      { current: summary.current, drifted })
    check('互联口确实在随机口上(没被挪回固定口)', (await fetch(`http://127.0.0.1:${drifted}/unit/meta`).then((r) => r.json())).instanceId === instanceId)
    const vault = await rpc('desktop-vault')
    check('智库请求经固定口转发到了 Forsion(拿到智库,或 Forsion 回「没开智库」)', vault?.ok ? typeof vault.data.root === 'string' : vault?.code === 'VAULT_NOT_READY', vault)
    const look = await worker.evaluate(async () => (await chrome.storage.local.get('forsion_appearance_last')).forsion_appearance_last || null)
    check('外观跟着 Forsion(连上后取到并缓存)', !!look && ['light', 'dark'].includes(look.mode) && look.locale === 'zh', look)
    const capsule = await waitFor(async () => { const t = await panel.locator('body').innerText(); return /本机 Forsion/.test(t) ? t : null }, 15000, '侧栏胶囊写「本机 Forsion」')
    check('侧栏胶囊写「本机 Forsion」', !!capsule)

    // ③ 用户每天走的路:剪一篇网页 → 侧栏里点保存 → 文件真的落在 Forsion 当前智库的「Forsion Clip」文件夹里
    const vaultNow = await rpc('desktop-vault')
    console.log('VAULT', JSON.stringify(vaultNow))
    check('Forsion 有打开的智库(新用户第一次保存就靠它)', vaultNow?.ok && typeof vaultNow.data.root === 'string', vaultNow)
    const TITLE = '慢阅读:把收藏变成思考'
    articleServer = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${TITLE}</title></head><body><article><h1>${TITLE}</h1><p>收藏很容易,读完很难。这是一篇台架合成的文章,用来验证剪藏能真的存进 Forsion。</p><p>第二段:让收藏回到每天用的地方。</p></article></body></html>`) })
    const articlePort = await new Promise((r) => articleServer.listen(0, '127.0.0.1', () => r(articleServer.address().port)))
    // 真侧栏和网页在同一个窗口里:文章开在侧栏这页所在的窗口(Playwright 的 newPage 会另开窗口,Clip 只看当前窗口的网页)
    await panel.evaluate(async (url) => { const w = await chrome.windows.getCurrent(); await chrome.tabs.create({ url, windowId: w.id, active: false }) }, `http://127.0.0.1:${articlePort}/slow-reading.html`)
    await sleep(1500)
    await panel.bringToFront()
    await panel.reload() // 侧栏打开时对窗口里的网页取正文
    await waitFor(async () => (await panel.locator('body').innerText()).includes('让收藏回到每天用的地方'), 20000, '侧栏取到文章正文(标题在输入框里,innerText 不含)').catch(async (e) => {
      console.log('TABS', JSON.stringify(await rpc('tabs').catch((err) => String(err))))
      console.log('ALLTABS', JSON.stringify(await panel.evaluate(async () => (await chrome.tabs.query({})).map((t) => [t.id, t.windowId, t.active, t.url]))))
      console.log('PANEL', (await panel.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600))
      throw e
    })
    const clipsDir = path.join(vaultNow.data.root, 'Forsion Clip')
    const before = fs.existsSync(clipsDir) ? fs.readdirSync(clipsDir) : []
    await panel.locator('button.cl-save').click()
    const savedFile = await waitFor(async () => {
      if (!fs.existsSync(clipsDir)) return null
      const f = fs.readdirSync(clipsDir).find((x) => x.endsWith('.md') && !before.includes(x))
      return f && fs.readFileSync(path.join(clipsDir, f), 'utf8').includes('让收藏回到每天用的地方') ? f : null
    }, 30000, '剪藏落进 Forsion 智库')
    check('侧栏点保存:剪藏落进 Forsion 当前智库的 Forsion Clip 文件夹', !!savedFile, { savedFile, clipsDir })
    await waitFor(async () => /已保存|Saved/.test(await panel.locator('body').innerText()), 10000, '侧栏写明已保存')
    check('侧栏写明已保存(报错不出现)', true)
    if (process.env.SHOTS) { await sleep(400); await panel.screenshot({ path: path.join(process.env.SHOTS, 'e2e-saved-light.png') }) }
    if (process.env.SHOTS) {
      fs.mkdirSync(process.env.SHOTS, { recursive: true })
      await panel.keyboard.press('Escape').catch(() => {})
      await sleep(400)
      await panel.screenshot({ path: path.join(process.env.SHOTS, 'e2e-connected-light.png') })
      // Forsion 换成暗色苔绿:主题入口报上来 → 侧栏重开时跟着换(断开后也留着这套)
      await win.evaluate(() => window.tangu.reportUiAppearance({ skin: 'sage', bg: 'default', mode: 'dark' }))
      await panel.reload()
      await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('forsion_appearance_last')).forsion_appearance_last))?.mode === 'dark', 15000, '外观换成暗色')
      await sleep(800)
      await panel.screenshot({ path: path.join(process.env.SHOTS, 'e2e-connected-sage-dark.png') })
    }

    // ② Forsion 换了扩展文件夹里的版本 → 引擎叫连着的 Clip 重载 → 读进新版本、连回来;重载是 update,不再弹欢迎页
    // 真用户是开着开发者模式拖进去的;开发者模式关着时 Chrome 会以 unsupportedDeveloperExtension 停掉重载后的未打包扩展(实测)
    const ext = await ctx.newPage()
    await ext.goto('chrome://extensions')
    await ext.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }))
    await ext.close()
    const bumped = version.replace(/(\d+)$/, (n) => String(Number(n) + 1))
    const mf = path.join(clipDir, 'manifest.json')
    fs.writeFileSync(mf, JSON.stringify({ ...JSON.parse(fs.readFileSync(mf, 'utf8')), version: bumped }))
    await panel.close()
    let welcomesAfter = 0
    ctx.on('page', (p) => { p.waitForURL(/./, { timeout: 5000 }).catch(() => {}).then(() => { if (isExtPage(p)) welcomesAfter++ }) })
    const r = await engine('/agent/browser-extension/reload-clients', 'POST')
    check('引擎叫到了连着的 Clip', r.reloaded >= 1, r)
    const back = await waitFor(async () => { const s = await engine('/agent/browser-extension'); return s.connected && s.clients.at(-1)?.version === bumped ? s : null }, 40000, `重载后以 ${bumped} 连回来`).catch(async (e) => {
      console.log('AFTER', JSON.stringify(await engine('/agent/browser-extension').then((x) => ({ connected: x.connected, clients: x.clients, lastClient: x.lastClient }))))
      console.log('WORKERS', JSON.stringify(ctx.serviceWorkers().map((w) => w.url())), 'PAGES', JSON.stringify(ctx.pages().map((p) => p.url())))
      throw e
    })
    check('重载后读进扩展文件夹里的新版本并连回来(不用重新拖)', !!back)
    await sleep(1500)
    check('重载不算新装:不弹任何扩展页', welcomesAfter === 0, { welcomesAfter })
    console.log(`\n${checks} checks passed`)
  } finally {
    try { await ctx?.close() } catch { /* ignore */ }
    try { articleServer?.close() } catch { /* ignore */ }
    if (app) { await Promise.race([app.close().catch(() => {}), sleep(5000)]); try { app.process().kill('SIGKILL') } catch { /* ignore */ } }
  }
}

main().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1) })
