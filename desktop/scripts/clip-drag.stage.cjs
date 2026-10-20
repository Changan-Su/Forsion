/**
 * 摆台:用真鼠标把 Forsion Clip 扩展文件夹从「设置 › 浏览器」拖进 Chrome 扩展页,看能不能装上
 * (方案页 docs/ToBeImproved/Clip安装引导方案_2026-10-20 的 C 第一步)。CDP 合成拖放到不了浏览器侧
 * (Chrome 报 No dragged path),所以只能真鼠标;这里把两边摆好、等拖、读 Chrome 的扩展列表判结果。
 *  - Forsion:out/ 构建 × 临时家目录 × 托管模式;/agent/** 改道假引擎,/agent/browser-extension 由它的 handle 回答。
 *  - Chrome:Playwright 带的 Chrome for Testing,临时配置 + 开发者模式打开,绝不碰用户的 Chrome。
 * 跑(worktree 里先 cd ../tangu-agent && npm run build,托管模式起真引擎):npm run build && STAGE_ELECTRON=<改过 bundle id 的 Electron.app>/Contents/MacOS/Electron node scripts/clip-drag.stage.cjs
 *   (改 bundle id 的做法见 gui-verify §4.2;computer use 按 bundle id 认应用,不改会认成正在跑的 dev)
 * 打印 READY 之后,把「扩展文件夹」那行的 Forsion Clip 卡片拖到右边 Chrome 的扩展页上。
 * 装上 = 退出码 0;CLIP_DRAG_WAIT_S(缺省 300)秒内没装上 = 1。NEG=devoff 负对照:开发者模式关着,拖了也不该装上。
 * HIDE_OTHERS=1:READY 前把别的应用藏起来(只留这两个窗口,免得拖到被截图藏掉的窗口上),退出时全部显示;
 * HIDE_OTHERS=kick:等 <临时家目录>/hide 出现再藏(computer use 要先拿到全屏授权,授权卡片弹在 Claude 窗口里,先藏就弹不出来)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const CLIP_ID = 'gpajikakdmhjebadgcbmhidkkajclfoi'
const WAIT_S = Number(process.env.CLIP_DRAG_WAIT_S || 300)
const NEG = process.env.NEG === 'devoff'
const CFT = process.env.CFT_APP || (() => {
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const app = path.join(root, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app')
    if (fs.existsSync(app)) return app
  }
  throw new Error('找不到 Chrome for Testing(npx playwright install chromium,或设 CFT_APP)')
})()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpEval(port, expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('chrome://extensions'))
  if (!page) throw new Error(`扩展页不在了:${list.map((t) => t.url).join(', ')}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  const msg = await new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d) } })
  ws.close()
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description || 'evaluate failed')
  return msg.result?.result?.value
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main'))) throw new Error('先跑 npm run build')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-clipdrag-'))
  const userData = path.join(home, 'userdata')
  const status = { enabled: true, port: 47655, listening: true, error: '', connected: false, clients: [], extensionId: CLIP_ID, extensionDir: '/bundle/tangu-server/browser-extension', code: `tangu:47655:${'ab'.repeat(24)}` }
  const stub = await startStubEngine({ handle: ({ path: p }) => (p === '/agent/browser-extension' ? status : undefined) })
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({
      mode: 'managed', backendUrl: stub.url, token: 'e2e', cloudUrl: 'http://127.0.0.1:9',
      sandbox: 'none', browserEnabled: false, defaultWorkspaceDir: path.join(home, 'workspace'), unitHostEnabled: false,
    }))
  }
  let app = null
  let chrome = null
  const cleanup = async () => {
    if (process.env.HIDE_OTHERS && app) await app.evaluate(({ Menu }) => Menu.sendActionToFirstResponder('unhideAllApplications:')).catch(() => {})
    try { chrome?.kill('SIGKILL') } catch { /* ignore */ }
    // 退出守卫可能拦住 close(实测进程会留着)→ 等 5 秒,再按本实例的 PID 收掉
    if (app) { await Promise.race([app.close().catch(() => {}), sleep(5000)]); try { app.process().kill('SIGKILL') } catch { /* ignore */ } }
    try { stub.close() } catch { /* ignore */ }
  }
  try {
    app = await electron.launch({
      ...(process.env.STAGE_ELECTRON ? { executablePath: process.env.STAGE_ELECTRON } : {}),
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '0' }, // 摆给人拖的:静默会把窗口压到层级 -1,人看不见(10-20 用户)
    })
    const win = await app.firstWindow()
    await app.context().route('**/agent/**', async (route) => {
      const url = new URL(route.request().url())
      return route.continue({ url: `${stub.url}${url.pathname}${url.search}` })
    })
    await win.waitForSelector('#root', { timeout: 40000 })
    if (!(await skipOnboarding(win))) throw new Error('主窗没离开首启引导')
    // 托管模式要等真引擎就绪(卡片的请求发往引擎地址;worktree 里先 cd tangu-agent && npm run build)
    await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 60000 })

    const opened = app.waitForEvent('window', { timeout: 20000 })
    await win.keyboard.press('Meta+Comma')
    const sp = await opened
    await sp.waitForSelector('.settings-main', { timeout: 20000 })
    // 设置浮窗:按页面地址认,同地址的取最后开出来的那个
    const spId = await app.evaluate(({ BrowserWindow }, url) => Math.max(...BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL() === url).map((w) => w.id)), sp.url())
    if (!Number.isFinite(spId)) throw new Error(`认不出设置浮窗:${sp.url()}`)
    const chip = sp.locator('[data-testid="browser-extension-drag"]')
    try {
      await sp.locator('.settings-nav-parent > button', { hasText: /^(浏览器控制|Browser control)$/ }).first().click({ timeout: 10000 })
      await chip.waitFor({ timeout: 15000 })
    } catch (e) { // 现场倒出来再报
      console.log('NAV', JSON.stringify(await sp.evaluate(() => [...document.querySelectorAll('.settings-nav-parent > button')].map((el) => el.textContent))))
      console.log('CARD', (await sp.locator('.settings-browser-ext-panel').innerText().catch(() => '(没有扩展卡片)')).slice(0, 800))
      console.log('API', JSON.stringify(await sp.evaluate(async () => ({ clip: !!window.tangu?.clipExtension, mode: (await window.tangu?.getConfig?.())?.mode }))))
      throw e
    }
    const copyDir = path.join(home, 'Forsion Clip')
    if (!fs.existsSync(path.join(copyDir, 'manifest.json'))) throw new Error(`扩展没复制出来:${copyDir}`)

    // 摆位:设置窗靠左,Chrome 靠右,中间不留缝
    const wa = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    const leftW = Math.min(820, Math.round(wa.width * 0.5))
    await app.evaluate(({ BrowserWindow }, b) => {
      // 主窗藏到设置窗后面(右边缘对齐),免得盖住右边的 Chrome(10-20 用户);设置窗是它的子窗,挪主窗会带着走,所以先挪主窗
      const sp = BrowserWindow.fromId(b.id)
      const main = sp?.getParentWindow()
      if (main) {
        const w = Math.max(main.getMinimumSize()[0], b.bounds.width)
        main.setBounds({ ...b.bounds, x: b.bounds.x + b.bounds.width - w, width: w })
      }
      sp?.setBounds(b.bounds)
      sp?.moveTop()
    }, { id: spId, bounds: { x: wa.x, y: wa.y, width: leftW, height: wa.height } })
    await chip.scrollIntoViewIfNeeded()
    await sleep(500)

    const port = 9400 + Math.floor(Math.random() * 400)
    const cudd = fs.mkdtempSync(path.join(os.tmpdir(), 'clipdrag-chrome-'))
    chrome = spawn(path.join(CFT, 'Contents/MacOS/Google Chrome for Testing'), [
      `--user-data-dir=${cudd}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
      `--window-position=${wa.x + leftW},${wa.y}`, `--window-size=${wa.width - leftW},${wa.height}`, 'about:blank',
    ], { stdio: 'ignore' })
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break } catch { await sleep(250) } }
    await fetch(`http://127.0.0.1:${port}/json/new?chrome://extensions`, { method: 'PUT' })
    await sleep(1500)
    await cdpEval(port, `chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: ${!NEG} })`)
    const devMode = await cdpEval(port, 'chrome.developerPrivate.getProfileConfiguration().then((c) => c.inDeveloperMode)')

    const hideOthers = async () => {
      await app.evaluate(({ Menu }) => Menu.sendActionToFirstResponder('hideOtherApplications:'))
      await new Promise((r) => spawn('open', ['-a', CFT]).on('exit', r))
      await sleep(800)
      await app.evaluate(({ app: a }) => a.focus({ steal: true }))
      await sp.bringToFront()
      console.log('HIDDEN 别的应用已藏起')
    }
    if (process.env.HIDE_OTHERS === '1') await hideOthers()
    await app.evaluate(({ app: a }) => a.focus({ steal: true }))
    await sp.bringToFront()
    // 卡片中心的屏幕坐标(点):窗口内容区原点 + 元素中心 × 缩放
    const box = await chip.boundingBox()
    const geo = await app.evaluate(({ BrowserWindow }, id) => {
      const w = BrowserWindow.fromId(id)
      return { content: w.getContentBounds(), zoom: w.webContents.getZoomFactor() }
    }, spId)
    const from = { x: Math.round(geo.content.x + (box.x + box.width / 2) * geo.zoom), y: Math.round(geo.content.y + (box.y + box.height / 2) * geo.zoom) }
    const to = { x: Math.round(wa.x + leftW + (wa.width - leftW) / 2), y: Math.round(wa.y + wa.height / 2) }
    console.log(`READY devMode=${devMode} copyDir=${copyDir}`)
    console.log(`DRAG from=${from.x},${from.y} to=${to.x},${to.y} (屏幕坐标,点)`)
    fs.writeFileSync(path.join(home, 'stage.json'), JSON.stringify({ from, to, copyDir, port }))
    console.log(`STAGE ${path.join(home, 'stage.json')}`)

    const deadline = Date.now() + WAIT_S * 1000
    let found = null
    let hidden = process.env.HIDE_OTHERS === '1'
    while (Date.now() < deadline && !found) {
      await sleep(1000)
      if (!hidden && process.env.HIDE_OTHERS === 'kick' && fs.existsSync(path.join(home, 'hide'))) { hidden = true; await hideOthers() }
      const list = await cdpEval(port, 'chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }).then((l) => l.map((x) => ({ id: x.id, location: x.location, path: x.prettifiedPath || "", version: x.version })))').catch(() => [])
      found = list.find((x) => x.id === CLIP_ID) || null
    }
    const out = path.join(os.tmpdir(), 'forsion-clip-drag')
    fs.mkdirSync(out, { recursive: true })
    await sp.screenshot({ path: path.join(out, `settings${NEG ? '-neg' : ''}.png`) }).catch(() => {})
    if (found) {
      console.log(`INSTALLED ${JSON.stringify(found)}`)
      const fromCopy = found.location === 'UNPACKED' && found.path.replace(/^~/, os.homedir()).includes('Forsion Clip')
      console.log(fromCopy ? 'PASS 拖进去装上了,装的是复制出包的那份' : `FAIL 装上了但不是复制出包的那份:${found.path}`)
      process.exitCode = NEG ? 1 : (fromCopy ? 0 : 1)
      if (NEG) console.log('FAIL 负对照:开发者模式关着也装上了')
    } else {
      console.log(NEG ? 'PASS 负对照:开发者模式关着,拖进去没装上' : `FAIL ${WAIT_S}s 内没装上`)
      process.exitCode = NEG ? 0 : 1
    }
  } finally {
    await cleanup()
  }
}

main().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1) })
