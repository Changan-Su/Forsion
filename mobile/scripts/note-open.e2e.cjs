/**
 * 移动端「点列表行能不能真打开」e2e —— `npm run e2e:noteopen`(mobile 目录,先 npm run build)。
 *
 * 起因(2026-08-05):移动端 Amadeus 点笔记行「有按压反馈但没打开」。根因是单列壳 LeafHost
 * 只订阅 active leaf 的 id+type,而主区就地导航在「编辑器→编辑器」时只换 params.notePath ——
 * 宿主不重渲,编辑器永远不知道要换笔记。Amadeus space 主区恒为编辑器,故该 space 100% 中招。
 *
 * 断言链(真 touch 事件,手机视口):
 *  1. 种两篇笔记 → 进 Amadeus space(此时主区已是 amadeus-editor);
 *  2. 开左抽屉,touch 点「甲」 → 编辑器标题=甲、抽屉自动收回;   ← 首开(可能借 type 变化侥幸过)
 *  3. 再开抽屉,touch 点「乙」 → 编辑器标题=乙、抽屉自动收回。   ← 编辑器→编辑器,当年的病灶
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 借 desktop 的 */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const PORT = 5283 // 避开 dev 5274 / boot-e2e 5279
const URL = `http://localhost:${PORT}/`

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) { const e = path.join(root, d, rel); if (fs.existsSync(e)) return e }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE')
}
const ping = () => new Promise((res) => {
  const req = http.get(URL, (r) => { res(r.statusCode === 200); r.resume() })
  req.on('error', () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false) })
})

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let previewErr = ''
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  const killPreview = () => { try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } } }

  let browser = null
  const fails = []
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping() }
    if (!up) throw new Error(`vite preview 没起来\n${previewErr.slice(-500)}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    // 假 token 过登录闸(同 mobile-boot.e2e);本地库模式(Capacitor FS 的 web 实现 = IndexedDB,免真机)。
    await ctx.addInitScript(() => {
      try { localStorage.setItem('forsion_token', 'e2e-note-open'); localStorage.setItem('amadeus_vault_mode', 'local') } catch { /* ignore */ }
    })
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    page.on('pageerror', (e) => fails.push(`未捕获异常: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)

    const cdp = await ctx.newCDPSession(page)
    const tapBox = async (b) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(400)
    }
    const tap = async (locator) => {
      const b = await locator.boundingBox()
      if (!b) throw new Error('目标不可见')
      await tapBox(b)
    }
    /** 编辑器标题控件的当前值(input/textarea/contenteditable 三种形态都接)。 */
    const editorTitle = () => page.evaluate(() => {
      const t = document.querySelector('.amx-doc input, .amx-doc textarea, .amx-doc [contenteditable]')
      return ((t && ('value' in t ? t.value : t.textContent)) || '').trim()
    })

    await page.evaluate(async () => { await window.amadeus.newPage('e2e甲.md'); await window.amadeus.newPage('e2e乙.md') })

    // 进 Amadeus space:Space 切换条在**左抽屉底部**(2026-08-05 改版)→ 先开抽屉再点。
    await tap(page.locator('.mb-topbar .mb-icon-btn').first())
    await page.waitForTimeout(600)
    const tabs = await page.$$eval('.mb-drawer-foot .mb-tab', (els) => els.map((e) => e.textContent.trim()))
    const idx = tabs.findIndex((t) => /amadeus|笔记/i.test(t))
    if (idx < 0) throw new Error(`左抽屉底部没有 Amadeus space tab(现有: ${tabs.join(',')})`)
    await tap(page.locator(`.mb-drawer-foot .mb-tab >> nth=${idx}`))
    await page.waitForTimeout(900)
    // 切 Space 走 resetLayout → 抽屉应自动收回
    if (await page.$('.mb-drawer--left.open')) fails.push('切 Space 后左抽屉没有自动收回')

    /** 开抽屉 → touch 点名为 name 的笔记行 → 断言编辑器装入它且抽屉收回。
     *  ⚠️ push 形态抽屉容器**恒挂载**(开合动画需要),开没开只认 .open 类。 */
    const openAndAssert = async (name, label) => {
      await tap(page.locator('.mb-topbar .mb-icon-btn').first())
      await page.waitForTimeout(600)
      if (!(await page.$('.mb-drawer--left.open'))) { fails.push(`${label}: 左抽屉没开`); return }
      const row = page.locator('.mb-drawer--left .t2s-srow', { hasText: name }).first()
      const b = await row.boundingBox()
      if (!b) { fails.push(`${label}: 抽屉里没有「${name}」行`); return }
      await tapBox(b)
      await page.waitForTimeout(1100)
      const got = await editorTitle()
      if (got !== name) fails.push(`${label}: 点了「${name}」,编辑器却是「${got || '(空)'}」—— 行点开没生效`)
      if (await page.$('.mb-drawer--left.open')) fails.push(`${label}: 点行后抽屉没有自动收回`)
    }

    await openAndAssert('e2e甲', '首开(type 变化路径)')
    await openAndAssert('e2e乙', '连续切换(编辑器→编辑器,params-only 路径)')
  } catch (e) {
    fails.push(String(e && e.message || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  if (fails.length) { console.error('❌ e2e:noteopen\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
  console.log('✅ e2e:noteopen —— 移动端点笔记行:两连切换都真打开,抽屉自动收回')
}

main()
