/**
 * 移动端「有新版本会不会提醒」仪器(2026-09-15)。
 *
 * 病理:更新那套 UI 全是共享渲染层(bootstrap 启动静默检查 → 自动弹「更新」标签页;设置-关于的按钮),
 * 全部门控在 `window.tangu?.checkForUpdates` / `onUpdaterStatus` 这类可选链上 —— 而 mobileShim 一直
 * 没实现它们,于是装着旧版的用户**永远不会收到任何提示**。typecheck 看不到(方法是可选的)、
 * check:parity 当时也扫不到(bootstrap.ts 不在门控台账里)、boot 冒烟更不会点更新。
 *
 * 断言:
 *   A. 网关报了更高版本 → checkForUpdates 出 available,并自动弹出「更新」页(.changelog-view)
 *   B. 「下载更新」落到网关的安卓下载端点(大陆可达;不是 github.com)
 *   C. 负对照:网关报的版本不比装机版本新 → not-available,且不弹页
 *
 * 跑法:npm run build && npm run e2e:update。机制照抄 settings-config.e2e.cjs。
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const PORT = 5285 // 与 boot(5279)/unitsentry(5281)/settingscfg(5283) 错开
const URL = `http://localhost:${PORT}/`
const NEWER = '99.0.0'
const OLDER = '0.0.1'

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
    const req = http.get(URL, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
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
  const fails = []
  const pass = (name, extra) => console.log(`PASS  ${name}${extra ? `  | ${extra}` : ''}`)
  const fail = (name, extra) => { fails.push(name); console.log(`FAIL  ${name}${extra ? `  | ${extra}` : ''}`) }
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error(`vite preview 没起来(${PORT} 被占?)\n${previewErr.slice(-800) || '(无 stderr)'}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })

    /** 开一页:网关报 `version`,GitHub 一律断网(只验网关这条路,顺便证明 GitHub 不可达也不影响)。 */
    const open = async (version) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      await ctx.addInitScript(() => { try { localStorage.setItem('forsion_tangu_onboarding_done', '1') } catch { /* ignore */ } })
      await ctx.addInitScript(() => { try { localStorage.setItem('forsion_token', 'e2e-update') } catch { /* ignore */ } })
      // 自动弹页每个版本只弹一次(localStorage 记号),每个 ctx 都是新 profile,不会互相干扰。
      const ctxPage = await ctx.newPage()
      await ctxPage.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
      await ctxPage.route('**/api/**', (r) => r.abort())
      await ctxPage.route('**/api.github.com/**', (r) => r.abort())
      // ⚠️ 必须**后**注册:playwright 后注册的路由先匹配,写在 abort 前面会被整片 abort 吃掉。
      await ctxPage.route('**/website/config', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ platforms: { android: { version, filename: `Forsion-Tangu-${version}-android.apk` } } }),
      }))
      // 「下载更新」在 web 分支走 window.open —— 截下来看落点。
      await ctxPage.addInitScript(() => {
        window.__opened = []
        window.open = (u) => { window.__opened.push(String(u)); return null }
      })
      await ctxPage.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await ctxPage.waitForTimeout(5000) // 启动检查是异步的(fetch + 自动弹页)
      return { ctx, page: ctxPage }
    }

    // ── A/B:网关报了更高版本 ──
    {
      const { ctx, page } = await open(NEWER)
      const st = await page.evaluate(() => window.tangu.checkForUpdates())
      if (st && st.phase === 'available' && st.version === NEWER) pass('网关报新版本 → available', `${st.version}`)
      else fail('网关报新版本 → available', JSON.stringify(st))

      const opened = await page.locator('.changelog-view').count()
      if (opened > 0) pass('启动自动弹出「更新」页')
      else fail('启动自动弹出「更新」页', '没找到 .changelog-view')

      await page.evaluate(() => window.tangu.downloadUpdate())
      const urls = await page.evaluate(() => window.__opened || [])
      if (urls.some((u) => /\/website\/download\/android$/.test(u))) pass('「下载更新」落到网关安卓下载端点', urls.join(' '))
      else fail('「下载更新」落到网关安卓下载端点', urls.join(' ') || '(没开任何链接)')
      await ctx.close()
    }

    // ── C:负对照 —— 网关那份不比装机版新,就不该有任何动静 ──
    {
      const { ctx, page } = await open(OLDER)
      const st = await page.evaluate(() => window.tangu.checkForUpdates())
      if (st && st.phase === 'not-available') pass('负对照:旧版本 → not-available')
      else fail('负对照:旧版本 → not-available', JSON.stringify(st))
      const opened = await page.locator('.changelog-view').count()
      if (opened === 0) pass('负对照:不弹「更新」页')
      else fail('负对照:不弹「更新」页', '弹了')
      await ctx.close()
    }
  } catch (e) {
    fail('台架异常', String((e && e.message) || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  if (fails.length) {
    console.log(`\n${fails.length} 条失败`)
    process.exit(1)
  }
  console.log('\n全部通过')
}

main()
