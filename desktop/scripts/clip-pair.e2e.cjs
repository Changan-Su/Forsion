/**
 * 端到端:Clip 一次配对(Clip 安装引导方案 C 第二步)—— 真 Clip 构建 × 隔离 Forsion(out/ 构建、临时家目录、真引擎)× Chrome for Testing。
 *  ① 装上 → 欢迎页自动向本机 Forsion 请求配对 →(台架后门 FORSION_UNIT_AUTO_PAIR 自动批准)→ Clip 领到 Tangu 连接码 → 浏览器控制连上;
 *  ② 改扩展文件夹里的版本号、叫引擎让连着的 Clip 重载 → 连回来报新版本,且不再弹欢迎页(reason=update)。
 * 跑:cd ../tangu-agent && npm run build;npm run build;Clip worktree 里 `FORSION_GENESIS_ROOT=<Genesis> npx wxt build`;
 *    CLIP_BUILD=<那份 .output/chrome-mv3> node scripts/clip-pair.e2e.cjs     (HEADED=1 看着跑)
 * 隔离:Unit 口只听回环(FORSION_UNIT_BIND_LOOPBACK=1 —— 自动批准配对时绝不能露到局域网);扩展桥另找空闲端口,不碰在跑的引擎;
 * Chrome 用临时配置。Clip 缺省找 127.0.0.1:8791,所以要 8791 空着。
 */
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const { chromium } = require('playwright-core')
const electron = require('./lib/launch-electron.cjs') // 台架统一入口:临时默认工作区,绝不打开开发者真实的 ~/Forsion-Dev/Amadeus
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const CLIP_ID = 'gpajikakdmhjebadgcbmhidkkajclfoi'
const UNIT_PORT = 8791
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
  if (!(await portFree(UNIT_PORT))) throw new Error(`${UNIT_PORT} 被占(有 Forsion 开着「允许其他设备连接本机」?)—— Clip 缺省就找这个口`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-clippair-'))
  const clipDir = path.join(home, 'Forsion Clip') // 和装好的用户一样:Chrome 从这份加载(下面改它的版本号测重载)
  fs.cpSync(src, clipDir, { recursive: true })
  const version = JSON.parse(fs.readFileSync(path.join(clipDir, 'manifest.json'), 'utf8')).version
  const userData = path.join(home, 'userdata')
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({
      mode: 'managed', cloudUrl: 'http://127.0.0.1:9', sandbox: 'none', browserEnabled: false,
      defaultWorkspaceDir: path.join(home, 'workspace'), unitHostEnabled: true, unitWebPort: UNIT_PORT,
    }))
  }
  let app = null
  let ctx = null
  try {
    app = await electron.launch({
      ...(process.env.STAGE_ELECTRON ? { executablePath: process.env.STAGE_ELECTRON } : {}),
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: {
        ...process.env, TANGU_HOME: home, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1',
        FORSION_UNIT_AUTO_PAIR: '1', FORSION_UNIT_BIND_LOOPBACK: '1', TANGU_BROWSER_EXTENSION_PORT: String(await freePort()),
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
    await waitFor(() => fetch(`http://127.0.0.1:${UNIT_PORT}/unit/meta`).then((r) => r.ok), 30000, 'Unit 口起来')
    check('装之前:引擎没见过扩展(设置页显示「未安装」)', (await engine('/agent/browser-extension')).lastClient === null)

    ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'clippair-chrome-')), {
      executablePath: CFT, headless: process.env.HEADED !== '1',
      args: [`--disable-extensions-except=${clipDir}`, `--load-extension=${clipDir}`, '--no-first-run'],
    })
    const isWelcome = (p) => p.url().startsWith(`chrome-extension://${CLIP_ID}/options.html`) && p.url().includes('welcome=1')
    const welcome = await waitFor(async () => ctx.pages().find(isWelcome), 30000, '欢迎页')
    check('刚装上就打开欢迎页(设置 › 桌面联动)', !!welcome)

    const live = await waitFor(async () => { const s = await engine('/agent/browser-extension'); return s.connected ? s : null }, 60000, 'Clip 用领到的连接码连上浏览器控制').catch(async (e) => {
      // 现场倒出来:欢迎页上写了什么、Clip 存了什么、主进程记了什么
      console.log('WELCOME', (await welcome.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1200))
      console.log('STORAGE', JSON.stringify(await welcome.evaluate(async () => {
        const all = await chrome.storage.local.get(null)
        return { keys: Object.keys(all), tangu: !!all.tanguPairing, desktop: all.forsion_integration?.desktop ? { ...all.forsion_integration.desktop, token: all.forsion_integration.desktop.token ? '(有)' : '' } : null }
      }).catch((err) => String(err))))
      console.log('BRIDGE', JSON.stringify(await engine('/agent/browser-extension').then((x) => ({ listening: x.listening, error: x.error, port: x.port })).catch((err) => String(err))))
      console.log('ROUTE', JSON.stringify(await welcome.evaluate(async (port) => {
        const d = (await chrome.storage.local.get('forsion_integration')).forsion_integration?.desktop
        const r = await fetch(`http://127.0.0.1:${port}/unit/browser-control`, { headers: { Authorization: `Bearer ${d?.token}` } })
        return { status: r.status, body: (await r.text()).slice(0, 200) }
      }, UNIT_PORT).catch((err) => String(err))))
      console.log('LOG', mainLog.filter((l) => /unit|pair|配对/i.test(l)).slice(-15).join('\n'))
      throw e
    })
    check('一次配对:批准后 Clip 自己领到连接码、连上 Tangu 浏览器控制', live.clients.at(-1)?.version === version, live.clients)
    check('引擎记下了连上来的扩展(设置页据此分「未安装 / 未连接」)', live.lastClient?.version === version, live.lastClient)
    const card = await waitFor(async () => {
      const text = await welcome.locator('[data-testid="clip-welcome"]').textContent()
      return /已连上本机的 Forsion|Connected to Forsion/.test(text || '') ? text : null
    }, 20000, '欢迎卡片写明已连上')
    check('欢迎卡片写明已连上', !!card)

    // ② Forsion 换了扩展文件夹里的版本 → 引擎叫连着的 Clip 重载 → 读进新版本、连回来;重载是 update,不再弹欢迎页
    const bumped = version.replace(/(\d+)$/, (n) => String(Number(n) + 1))
    const mf = path.join(clipDir, 'manifest.json')
    fs.writeFileSync(mf, JSON.stringify({ ...JSON.parse(fs.readFileSync(mf, 'utf8')), version: bumped }))
    let welcomesAfter = 0
    ctx.on('page', (p) => { p.waitForURL(/./, { timeout: 5000 }).catch(() => {}).then(() => { if (isWelcome(p)) welcomesAfter++ }) })
    const r = await engine('/agent/browser-extension/reload-clients', 'POST')
    check('引擎叫到了连着的 Clip', r.reloaded >= 1, r)
    const back = await waitFor(async () => { const s = await engine('/agent/browser-extension'); return s.connected && s.clients.at(-1)?.version === bumped ? s : null }, 40000, `重载后以 ${bumped} 连回来`)
    check('重载后读进扩展文件夹里的新版本并连回来(不用重新拖)', !!back)
    await sleep(1500)
    check('重载不算新装:不再弹欢迎页', welcomesAfter === 0, { welcomesAfter })
    console.log(`\n${checks} checks passed`)
  } finally {
    try { await ctx?.close() } catch { /* ignore */ }
    if (app) { await Promise.race([app.close().catch(() => {}), sleep(5000)]); try { app.process().kill('SIGKILL') } catch { /* ignore */ } }
  }
}

main().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1) })
