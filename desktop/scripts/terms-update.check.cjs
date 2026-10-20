/**
 * 协议更新提示 + 弹窗排队(web harness `harness.html?terms`,真组件 × 真 CSS × 桩 cloudFetch / forsionLogout)。
 *
 * 钉住:
 *  ① 登录后查 GET /auth/terms,required → 弹卡;notice 只有「知道了」,点了 POST /auth/terms/agree 带版本号再关;
 *  ② 卡开着时打开 What's new → 先排着不出;卡关了 What's new 才出(stores/popupQueue,同一时间只露一个);
 *  ③ 反过来 What's new 先开着、再登录 → 协议卡不抢占,What's new 关了才出;
 *  ④ consent:「同意」/「不同意并退出登录」两个按钮;点「不同意」调 forsionLogout、不记同意;
 *  ⑤ 点外面、按 Esc 都关不掉;⑥ required: false / 老服务端 404 → 不弹。
 * 截图:os.tmpdir()/forsion-terms-update/(亮 / 暗 / 窄屏;DESIGN §8:几何全绿 ≠ 看起来对,自己看)。
 *
 * 跑:node scripts/terms-update.check.cjs(自起一份 vite,端口现找,不借别的检出开着的 5173)
 */
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-terms-update')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const ping = (url) => new Promise((res) => { const r = http.get(url, (x) => { res(x.statusCode === 200); x.resume() }); r.on('error', () => res(false)); r.setTimeout(1500, () => { r.destroy(); res(false) }) })

const CHANGES = { zh: '隐私政策按桌面端、网页版、Android 分别写清你的数据存放在哪里（第 1、4、8 节）。', en: 'The Privacy Policy now states where your data is stored on desktop, on the web and on Android (sections 1, 4 and 8).' }

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}/harness.html`
  const vite = spawn('npx', ['vite', 'frontend', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
  const browser = await chromium.launch({ executablePath: findChromium() })
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i++) { up = await ping(base); if (!up) await new Promise((r) => setTimeout(r, 500)) }
    if (!up) throw new Error('vite 起不来')

    async function open({ mode = 'notice', status = 200, required = true, dark = false, width = 1100, height = 720 } = {}) {
      // 钉中文(浏览器台架的 --lang 无效,走 newPage 的 locale)
      const page = await browser.newPage({ locale: 'zh-CN', viewport: { width, height }, reducedMotion: 'reduce' })
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.addInitScript(({ mode, status, required, changes }) => {
        window.__calls = []
        window.__logouts = 0
        window.tangu = {
          platform: 'darwin',
          getWebsiteReleases: async () => null, // What's new 不出网
          forsionLogout: async () => { window.__logouts++; window.__signOut(); return { ok: true } },
          cloudFetch: async (req) => {
            window.__calls.push(req)
            if (req.path === '/auth/terms') return status === 200 ? { status, json: { latest: '2026-10-19', agreed: '2026-08-25', required, mode, changes } } : { status, json: null }
            if (req.path === '/auth/terms/agree') return { status: 200, json: { agreed: req.body.version } }
            return { status: 404, json: null }
          },
        }
      }, { mode, status, required, changes: CHANGES })
      await page.goto(base + '?terms' + (dark ? '&dark' : ''), { timeout: 120000 }) // 冷启动的 vite 要现编依赖
      await page.waitForFunction(() => typeof window.__signIn === 'function', null, { timeout: 60000 }) // 第一次打开要等 vite 现编
      return { page, errors }
    }
    const visible = (page, sel) => page.locator(sel).count()
    const footButtons = (page) => page.$$eval('.terms-foot button', (bs) => bs.map((b) => b.textContent))

    // ── notice + 排队:协议卡先开着,What's new 后到 ──
    {
      const { page, errors } = await open()
      await page.evaluate(() => window.__signIn())
      await page.locator('.terms-modal').waitFor({ timeout: 5000 })
      check('登录后弹卡;notice 只有「知道了」;写着这次的变化与版本', (await footButtons(page)).join('|') === '知道了' && (await page.locator('.terms-modal').innerText()).includes('第 1、4、8 节') && (await page.locator('.terms-modal').innerText()).includes('版本 2026-10-19'))
      await page.screenshot({ path: path.join(SHOTS, 'notice-light.png') })
      await page.keyboard.press('Escape')
      await page.mouse.click(20, 20)
      await page.waitForTimeout(200)
      check('Esc 与点外面都关不掉', await visible(page, '.terms-modal') === 1)
      await page.evaluate(() => window.__openWhatsNew())
      await page.waitForTimeout(300)
      check('卡开着时 What\'s new 先排着不出', await visible(page, '.wn-modal') === 0)
      await page.locator('.terms-foot button', { hasText: '知道了' }).click()
      await page.locator('.wn-modal').waitFor({ timeout: 5000 }).catch(() => {})
      const agree = await page.evaluate(() => window.__calls.find((c) => c.path === '/auth/terms/agree'))
      check('点「知道了」→ POST /auth/terms/agree 带版本号', agree && agree.method === 'POST' && agree.body.version === '2026-10-19', JSON.stringify(agree))
      check('卡关了 What\'s new 接着出', await visible(page, '.terms-modal') === 0 && await visible(page, '.wn-modal') === 1)
      check('无页面错误', errors.length === 0, errors.join(' / '))
      await page.close()
    }

    // ── 不抢占:What's new 先开着,再登录 ──
    {
      const { page } = await open()
      await page.evaluate(() => window.__openWhatsNew())
      await page.locator('.wn-modal').waitFor({ timeout: 5000 })
      await page.evaluate(() => window.__signIn())
      await page.waitForFunction(() => window.__calls.some((c) => c.path === '/auth/terms'), null, { timeout: 5000 })
      await page.waitForTimeout(300)
      check('What\'s new 开着时协议卡不抢占', await visible(page, '.terms-modal') === 0 && await visible(page, '.wn-modal') === 1)
      await page.locator('.wn-foot button', { hasText: '关闭' }).click()
      await page.locator('.terms-modal').waitFor({ timeout: 5000 }).catch(() => {})
      check('What\'s new 关了协议卡才出', await visible(page, '.terms-modal') === 1)
      await page.close()
    }

    // ── consent(暗色):同意 / 不同意并退出 ──
    {
      const { page, errors } = await open({ mode: 'consent', dark: true })
      await page.evaluate(() => window.__signIn())
      await page.locator('.terms-modal').waitFor({ timeout: 5000 })
      check('consent:「不同意并退出登录」「同意」两个按钮,带退出说明', (await footButtons(page)).join('|') === '不同意并退出登录|同意' && (await page.locator('.terms-modal').innerText()).includes('下次登录时会再询问你'))
      await page.screenshot({ path: path.join(SHOTS, 'consent-dark.png') })
      await page.locator('.terms-foot button', { hasText: '不同意并退出登录' }).click()
      await page.waitForFunction(() => window.__logouts > 0, null, { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(200)
      const st = await page.evaluate(() => ({ logouts: window.__logouts, agreed: window.__calls.some((c) => c.path === '/auth/terms/agree') }))
      check('不同意 → forsionLogout,不记同意;退出后卡收掉', st.logouts === 1 && !st.agreed && await visible(page, '.terms-modal') === 0, JSON.stringify(st))
      check('无页面错误(consent)', errors.length === 0, errors.join(' / '))
      await page.close()
    }

    // ── 窄屏(手机 / 网页移动布局) ──
    {
      const { page } = await open({ mode: 'consent', width: 390, height: 780 })
      await page.evaluate(() => window.__signIn())
      await page.locator('.terms-modal').waitFor({ timeout: 5000 })
      const box = await page.locator('.terms-modal').boundingBox()
      check('窄屏:卡不超出视口', box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box))
      await page.screenshot({ path: path.join(SHOTS, 'consent-narrow.png') })
      await page.close()
    }

    // ── 不用弹 ──
    for (const [label, opts] of [['required: false', { required: false }], ['老服务端 404', { status: 404 }]]) {
      const { page } = await open(opts)
      await page.evaluate(() => window.__signIn())
      await page.waitForFunction(() => window.__calls.some((c) => c.path === '/auth/terms'), null, { timeout: 5000 })
      await page.waitForTimeout(400)
      check(`${label} → 不弹`, await visible(page, '.terms-modal') === 0)
      await page.close()
    }
  } finally {
    await browser.close()
    vite.kill()
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过 · 截图在 ${SHOTS}`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
