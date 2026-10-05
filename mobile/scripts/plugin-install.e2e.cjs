/**
 * Android 插件体系端到端仪器(2026-10-02)—— `npm run build && npm run e2e:plugins`。
 *
 * 真把 mobile/dist 在手机视口的 headless Chromium 里跑:市场 / 下载地址由 page.route 扮演(假市场),
 * 插件存储走 @capacitor/filesystem 的 web 实现(IndexedDB),与真机同一条 PluginFs → pluginHost / mobileMarket 链路;
 * 不同的只有下载器(真机 = Filesystem.downloadFile,这里 = fetch)。
 *
 * 流程(锚点一律 data-* / id,不按文案找元素;语言钉 zh-CN):
 *   1. 「⋯」菜单 → 市场;只列 Forsion 插件(没请求过别的类型)、显示范围说明
 *   2. 安装示例插件 → 不刷新即启用:命令进命令面板、运行 → 打开插件视图(锚点)、saveData 落盘
 *   3. 刷新 → 插件仍在、仍启用;再运行一次 → loadData 读回上次写的计数(数据跨重载)
 *   4. 第二项声明 isDesktopOnly → 安装被拒,错误提示 = 本地化原因;什么都没落盘
 *   5. 设置 → 插件:关掉 → 命令与视图消失;卸载 → 文件没了(listPlugins / marketInstalled 都看不到)
 *
 * 负对照:`npm run e2e:plugins -- --negative` 把页面 CSP 里的 'unsafe-eval' 去掉再跑 —— 插件代码求值被拦,
 * 第 2 步必须红(证明这台仪器真的在测「插件代码跑起来了」,不是只测到「文件写进去了」)。
 * 截图写进 mobile/outputs/native-20261002/(已 gitignore)。
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const JSZip = require('jszip')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const PORT = 5301 // 避开 dev 5274 / boot 5279 / unitsentry 5281 / settingscfg 5283 / … / runon 5299
const APP_URL = `http://localhost:${PORT}/`
const NEGATIVE = process.argv.includes('--negative')
const SHOTS = path.resolve(__dirname, '../outputs/native-20261002')
const CDN = 'https://market-cdn.e2e.test'
const PLUGIN_ID = 'e2e-hello'
const CMD_ID = `amadeus:${PLUGIN_ID}:open-panel`
const DESK_ID = 'e2e-desk'
/** 期望的本地化拒装原因(台架钉 zh-CN;与 installMobilePlugins.ts 的 mobilemarket.desktopOnlyPlugin 同文)。 */
const DESK_REASON_ZH = '这个插件声明了「仅支持桌面端」'

// 示例插件:一条命令(计数 +1 → saveData → 打开视图)+ 一个视图(把 loadData 读到的计数挂在 data-* 锚点上)。
const PLUGIN_MAIN = `
ctx.registerView({
  id: 'panel',
  title: 'E2E plugin panel',
  async mount(el) {
    const d = (await ctx.loadData()) || { runs: 0 }
    const box = document.createElement('div')
    box.setAttribute('data-e2e-plugin-view', '')
    box.setAttribute('data-e2e-runs', String(d.runs))
    box.textContent = 'E2E plugin view, runs=' + d.runs
    el.appendChild(box)
    return () => box.remove()
  },
})
ctx.registerCommand({
  id: 'open-panel',
  title: 'E2E plugin: open panel',
  keywords: 'e2eplugin',
  async run() {
    const d = (await ctx.loadData()) || { runs: 0 }
    d.runs += 1
    await ctx.saveData(d)
    ctx.openView('panel')
  },
})
`
const card = (id, name) => ({ id, type: 'amadeus-plugin', source: 'zip', name, summary: `${name} (e2e)`, author: 'e2e', installSlug: id, downloads: id === PLUGIN_ID ? 10 : 1, latestVersion: '1.0.0', tags: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
const CARDS = [card(PLUGIN_ID, 'E2E Hello'), card(DESK_ID, 'E2E Desk')]

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const roots = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
    for (const d of dirs.reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) {
        const exe = path.join(root, d, rel)
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

function ping() {
  return new Promise((res) => {
    const req = http.get(APP_URL, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

async function zipOf(entries) {
  const z = new JSZip()
  for (const [n, c] of Object.entries(entries)) z.file(n, c)
  return Buffer.from(await z.generateAsync({ type: 'uint8array' }))
}

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  const zips = {
    [PLUGIN_ID]: await zipOf({
      // 包一层目录 + macOS 垃圾:顺带验重定根(真实 GitHub archive 就长这样)
      [`${PLUGIN_ID}-main/manifest.json`]: JSON.stringify({ id: PLUGIN_ID, name: 'E2E Hello', version: '1.0.0', apiVersion: 1 }),
      [`${PLUGIN_ID}-main/main.js`]: PLUGIN_MAIN,
      '__MACOSX/._main.js': 'junk',
    }),
    [DESK_ID]: await zipOf({
      'manifest.json': JSON.stringify({ id: DESK_ID, name: 'E2E Desk', version: '1.0.0', apiVersion: 1, isDesktopOnly: true }),
      'main.js': 'ctx.registerCommand({ id: "x", title: "x", run() {} })',
    }),
  }

  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  })
  let previewErr = ''
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  const killPreview = () => {
    try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } }
  }

  let browser = null
  let page = null
  const fails = []
  const pageErrors = []
  const marketQueries = []
  const pass = (name, extra) => console.log(`PASS  ${name}${extra ? `  | ${extra}` : ''}`)
  const fail = (name, extra) => { fails.push(name); console.log(`FAIL  ${name}${extra ? `  | ${extra}` : ''}`) }
  const check = (ok, name, extra) => (ok ? pass(name, extra) : fail(name, extra))
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error(`vite preview 没起来(${PORT} 被占?)\n${previewErr.slice(-800) || '(无 stderr)'}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    // ⚠️ 语言钉 zh-CN 必须走 context/page 的 locale(chromium --lang 对浏览器台架无效)
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await ctx.addInitScript(() => { try { localStorage.setItem('forsion_tangu_onboarding_done', '1') } catch { /* ignore */ } })
    await ctx.addInitScript(() => { try { localStorage.setItem('forsion_token', 'e2e-plugins') } catch { /* ignore */ } })
    page = await ctx.newPage()
    page.on('pageerror', (e) => pageErrors.push(e.message))
    page.on('dialog', (d) => { void d.accept() }) // 卸载确认
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    // ⚠️ 后注册先匹配:假市场必须写在 abort 之后。
    await page.route('**/api/market/**', (r) => {
      const u = new URL(r.request().url())
      const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      let m
      if (u.pathname === '/api/market/items') {
        const type = u.searchParams.get('type')
        marketQueries.push(type || '(all)')
        return json({ items: CARDS.filter((c) => !type || c.type === type) })
      }
      if ((m = /^\/api\/market\/items\/([^/]+)\/install$/.exec(u.pathname))) {
        return json({ type: 'amadeus-plugin', installSlug: m[1], downloadUrl: `${CDN}/${m[1]}.zip`, source: 'zip' })
      }
      if ((m = /^\/api\/market\/items\/([^/]+)$/.exec(u.pathname))) {
        const c = CARDS.find((x) => x.id === m[1])
        return c ? json({ ...c, readme: `# ${c.name}` }) : json({}, 404)
      }
      return json({}, 404)
    })
    await page.route(`${CDN}/**`, (r) => {
      const id = path.basename(new URL(r.request().url()).pathname, '.zip')
      const body = zips[id]
      return body
        ? r.fulfill({ status: 200, body, headers: { 'content-type': 'application/zip', 'access-control-allow-origin': '*', 'content-length': String(body.length) } })
        : r.fulfill({ status: 404, body: 'no' })
    })
    if (NEGATIVE) {
      // 负对照:CSP 去掉 'unsafe-eval' —— 插件求值(new Function)必须被拦下。
      await page.route(APP_URL, async (r) => {
        const res = await r.fetch()
        const raw = await res.text()
        // 只改 meta 里 script-src 那一段(index.html 的注释里也写着 'unsafe-eval',全局替换第一处会改错地方)
        const html = raw.replace(/(script-src[^;"]*?) 'unsafe-eval'/, '$1')
        await r.fulfill({ response: res, body: html })
      })
    }

    // body zoom:1.15 下 Playwright 的可点性判定失真 → 套件口径:CDP 触摸打 boundingBox 中心。
    const cdp = await ctx.newCDPSession(page)
    const tap = async (locator, what) => {
      await locator.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      await locator.first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {}) // 折叠线以下的目标:触摸打不到视口外
      await page.waitForTimeout(150)
      const b = await locator.first().boundingBox({ timeout: 5000 })
      if (!b) throw new Error(`目标不可见: ${what}`)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(500)
    }
    const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${NEGATIVE ? 'neg-' : ''}${name}.png`) })
    const boot = async () => {
      await page.waitForSelector('.mb-topbar [aria-label="more"]', { timeout: 30_000 })
      await page.waitForTimeout(2500)
    }
    const openMore = async (ribbonId) => {
      // 从左抽屉底部进的设置,关掉后回到的还是开着的抽屉,它盖住顶栏的「⋯」—— 先收起(被推到右边的那颗左栏钮还点得到)。
      if (await page.locator('.mb-drawer--left.open').count()) await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '收起左抽屉')
      await tap(page.locator('.mb-topbar [aria-label="more"]'), '「⋯」')
      await tap(page.locator(`.mb-sheet [data-ribbon-id="${ribbonId}"]`), ribbonId)
    }
    /** 命令面板里有没有插件命令(不运行)。 */
    const commandListed = async () => {
      await openMore('rb-cmd')
      await page.locator('.cmd-panel input').fill('e2eplugin')
      await page.waitForTimeout(300)
      const n = await page.locator(`.cmd-panel [data-command-id="${CMD_ID}"]`).count()
      return n > 0
    }
    const runCommand = async () => {
      if (!(await commandListed())) return false
      await tap(page.locator(`.cmd-panel [data-command-id="${CMD_ID}"]`), '插件命令')
      return true
    }
    const closePalette = async () => { if (await page.locator('.cmd-panel').count()) await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
    const viewRuns = async () => {
      const el = page.locator('[data-e2e-plugin-view]').first()
      try { await el.waitFor({ state: 'visible', timeout: 6000 }) } catch { return null }
      return el.getAttribute('data-e2e-runs')
    }
    const hostState = () => page.evaluate(async (id) => ({
      listed: (await window.amadeus.listPlugins()).filter((p) => p.id === id).length,
      installed: (await window.tangu.marketInstalled())['amadeus-plugin'].map((x) => x.slug),
    }), PLUGIN_ID)

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await boot()
    // 页面实际生效的 script-src(负对照下必须没有 'unsafe-eval',否则「红」不成立)。
    // ⚠️ 别在 page.evaluate 里试 new Function 判断:CDP 求值不受页面 CSP 约束,恒为放行。
    const scriptSrc = await page.evaluate(() => (/script-src[^;]*/.exec(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '') || [''])[0])
    console.log(`      CSP: ${scriptSrc}`)
    if (NEGATIVE && scriptSrc.includes('unsafe-eval')) fail('负对照未生效(CSP 仍含 unsafe-eval)')

    // 1. 市场入口与范围
    await openMore('rb-market')
    const marketOpen = await page.locator('[data-mobile-market]').waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)
    check(marketOpen, '「⋯」→ 市场 全屏打开')
    await page.locator(`[data-market-install="${PLUGIN_ID}"]`).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    check(marketQueries.length > 0 && marketQueries.every((q) => q === 'amadeus-plugin'), '市场只请求可装类型(amadeus-plugin)', marketQueries.join(','))
    check(await page.locator('[data-market-scope-hint]').count() > 0, '市场显示「只列本机可装」说明')
    await shot('market-discover')

    // 2. 安装 → 不刷新即启用 → 命令 / 视图 / saveData
    await tap(page.locator(`[data-market-install="${PLUGIN_ID}"]`), '安装 E2E Hello')
    await page.locator(`[data-market-notice]`).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
    const notice1 = await page.locator('[data-market-notice]').getAttribute('data-market-notice').catch(() => null)
    check(notice1 === 'ok', '安装成功提示', `${notice1}: ${(await page.locator('[data-market-notice]').innerText().catch(() => '')).trim()}`)
    await shot('market-installed')
    const s1 = await hostState()
    check(s1.listed === 1 && s1.installed.includes(PLUGIN_ID), '插件已落盘并被宿主列出', JSON.stringify(s1))
    await tap(page.locator('[data-mobile-market] .settings-back').first(), '关闭市场')
    await page.waitForTimeout(600)
    const ran1 = await runCommand()
    check(ran1, '不刷新:插件命令已进命令面板')
    const runs1 = ran1 ? await viewRuns() : null
    check(runs1 === '1', '运行命令 → 打开插件视图(锚点在、saveData 写入 runs=1)', `runs=${runs1}`)
    if (!ran1) await closePalette()
    await shot('plugin-view')

    // 3. 刷新:插件仍启用;数据跨重载
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await boot()
    const ran2 = await runCommand()
    check(ran2, '刷新后插件仍启用(命令仍在)')
    const runs2 = ran2 ? await viewRuns() : null
    check(runs2 === '2', '刷新后 loadData 读回上次写的数据(runs=2)', `runs=${runs2}`)
    if (!ran2) await closePalette()

    // 4. isDesktopOnly → 拒装,本地化原因,不落盘
    await openMore('rb-market')
    await page.locator(`[data-market-install="${DESK_ID}"]`).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await tap(page.locator(`[data-market-install="${DESK_ID}"]`), '安装 E2E Desk')
    await page.locator('[data-market-notice="error"]').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
    const deskText = (await page.locator('[data-market-notice="error"]').innerText().catch(() => '')).trim()
    check(deskText.includes(DESK_REASON_ZH), '仅桌面插件被拒,提示本地化原因', deskText.replace(/\s+/g, ' '))
    const deskState = await page.evaluate(async (id) => (await window.tangu.marketInstalled())['amadeus-plugin'].map((x) => x.slug).includes(id), DESK_ID)
    check(!deskState, '仅桌面插件没有落盘')
    await shot('market-desktop-only')
    await tap(page.locator('[data-mobile-market] .settings-back').first(), '关闭市场')

    // 5. 设置 → 插件:关掉 → 贡献撤下;卸载 → 文件没了
    const row = page.locator(`[data-plugin-id="${PLUGIN_ID}"]`)
    /** 抽屉 → 设置 → 插件 → Forsion 插件(设置会记住上次的页 / 展开态:已在目标页就不再点)。 */
    const openPluginSettings = async () => {
      await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
      await tap(page.locator('.mb-drawer--left.open .mb-foot-row .mb-icon-btn[aria-label="settings"]'), '设置钮')
      if (await row.first().isVisible().catch(() => false)) return
      if (!(await page.locator('[data-settings-sub="pl-forsion"]').first().isVisible().catch(() => false))) {
        await tap(page.locator('[data-settings-tab="amadeus-plugins"]'), '插件 一级项')
      }
      await tap(page.locator('[data-settings-sub="pl-forsion"]'), 'Forsion 插件 子项')
      await row.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    }
    await openPluginSettings()
    await shot('settings-plugins')
    // 防空过:关之前插件视图必须在(设置盖在上面,视图仍挂在 DOM 里),否则下面的「被撤下」恒绿。
    const viewBefore = await page.locator('[data-e2e-plugin-view]').count()
    check(viewBefore > 0, '关之前插件视图仍挂着(防空过)', `有 ${viewBefore}`)
    await tap(row.locator('input[type="checkbox"]'), '插件开关')
    const offChecked = await row.locator('input[type="checkbox"]').first().isChecked().catch(() => null)
    check(offChecked === false, '设置里关掉插件')
    const stillView = await page.locator('[data-e2e-plugin-view]').count()
    check(stillView === 0, '关掉后插件视图被撤下', `剩 ${stillView}`)
    await tap(page.locator('.settings-mobile-detail-head button').last(), '关闭设置')
    const listedOff = await commandListed()
    check(!listedOff, '关掉后命令从命令面板撤下(不刷新)')
    await closePalette()
    await openPluginSettings()
    await tap(row, '插件详情')
    await tap(page.locator('[data-plugin-uninstall]'), '卸载')
    await page.waitForTimeout(800)
    const s2 = await hostState()
    check(s2.listed === 0 && !s2.installed.includes(PLUGIN_ID), '卸载后文件没了(listPlugins / marketInstalled 都看不到)', JSON.stringify(s2))
    await page.keyboard.press('Escape').catch(() => {})
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await boot()
    const listedAfter = await commandListed()
    check(!listedAfter, '卸载并刷新后命令不再出现')
    await closePalette()

    const evalErr = pageErrors.filter((m) => /unsafe-eval|EvalError|Content Security Policy/i.test(m))
    if (evalErr.length) console.log(`      页面错误(CSP): ${evalErr[0].slice(0, 200)}`)
  } catch (e) {
    fail('台架异常', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e))
    if (page) await page.screenshot({ path: path.join(SHOTS, 'exception.png') }).catch(() => {}) // 抛错那一刻页面长什么样
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  console.log(`\n${fails.length ? `✗ ${fails.length} 项失败` : '✓ 全部通过'}${NEGATIVE ? '(负对照模式:期望红)' : ''}`)
  process.exit(fails.length ? 1 : 0)
}

main()
