/**
 * Forsion Market 真浏览器 UI 门禁:发现首页、搜索、详情、已安装、明暗截图与横向溢出。
 * 自带起停隔离的 Vite；数据来自 marketHarnessBridge,不访问账号、网络或用户目录。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..')
const ORIGIN = 'http://127.0.0.1:5197'
const SHOTS = {
  light: '/tmp/forsion-market-discover-light.png',
  dark: '/tmp/forsion-market-discover-dark.png',
  detail: '/tmp/forsion-market-detail.png',
  installed: '/tmp/forsion-market-installed.png',
}

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()
  for (const dir of dirs) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = path.join(cache, dir, 'chrome-mac-arm64', app)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error('找不到 Chromium,请设置 CHROMIUM_EXE')
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` | ${detail}` : ''}`)
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${ORIGIN}/market-harness.html`)
      if (response.ok) return
    } catch { /* Vite 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Vite 启动超时')
}

async function main() {
  const vite = spawn('npx', ['vite', 'frontend', '--host', '127.0.0.1', '--port', '5197', '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
  let browser
  try {
    await waitForServer()
    browser = await chromium.launch({ executablePath: findChromium(), headless: true })
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${ORIGIN}/market-harness.html`, { waitUntil: 'networkidle' })
    await page.locator('.mk-featured').waitFor({ state: 'visible' })

    const initial = await page.evaluate(() => {
      const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
      const lum = (value) => rgb(value).map((n) => n / 255).map((n) => n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0)
      const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
      const hero = document.querySelector('.mk-featured').getBoundingClientRect()
      const card = getComputedStyle(document.querySelector('.mk-card'))
      const title = getComputedStyle(document.querySelector('.mk-card-title'))
      return {
        hero: { width: hero.width, height: hero.height },
        recent: document.querySelectorAll('.mk-recent-grid .mk-card').length,
        popular: document.querySelectorAll('.mk-section:last-child .mk-card').length,
        navGroups: document.querySelectorAll('.settings-nav-group').length,
        navLabels: [...document.querySelectorAll('.settings-nav-list button')].map((button) => button.textContent?.trim()),
        updateCount: document.querySelector('.mk-nav-count')?.textContent,
        border: card.borderTopColor,
        titleContrast: contrast(card.backgroundColor, title.color),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    check('发现首页有主精选区', initial.hero.width > 700 && initial.hero.height >= 240, `${Math.round(initial.hero.width)}x${Math.round(initial.hero.height)}`)
    check('最近上架与热门内容都有真实卡片', initial.recent === 4 && initial.popular >= 4, `recent=${initial.recent} popular=${initial.popular}`)
    check('侧栏按发现/分类/管理分成三组', initial.navGroups === 3, String(initial.navGroups))
    check('插件分类已合并且侧栏不再显示 Forsion 插件', initial.navLabels.filter((label) => label === '插件').length === 1 && !initial.navLabels.includes('Forsion 插件'), initial.navLabels.join(' / '))
    check('可更新数量来自已安装版本比对', initial.updateCount === '1', String(initial.updateCount))
    check('普通商品卡没有装饰性实色描边', /rgba\([^)]*,\s*0\)|transparent/.test(initial.border), initial.border)
    check('亮色商品标题对比度达到 WCAG AA', initial.titleContrast >= 4.5, initial.titleContrast.toFixed(2))
    check('桌面宽度没有横向溢出', initial.overflow <= 0, `${initial.overflow}px`)
    await page.screenshot({ path: SHOTS.light, fullPage: true })

    // 卡片图标(2026-08-26):投稿包 icon.png → 卡片显示真图;没有图 / 图解码失败 → 回落类型字形,绝不留白框。
    const icons = await page.evaluate(() => {
      const of = (name) => {
        const card = [...document.querySelectorAll('.mk-card')].find((el) => el.querySelector('.mk-card-title')?.textContent?.trim() === name)
        const box = card?.querySelector('.mk-card-visual')
        if (!box) return null
        const img = box.querySelector('img.mk-icon-img')
        const rect = box.getBoundingClientRect()
        return { img: !!img, svg: !!box.querySelector('svg'), w: rect.width, h: rect.height }
      }
      return { withIcon: of('LaTeX Suite'), noIcon: of('Research Companion'), broken: of('Source Check') }
    })
    check('有 icon.png 的商品显示自己的图标', icons.withIcon?.img === true && icons.withIcon?.svg === false, JSON.stringify(icons.withIcon))
    check('没有图标的商品回落类型字形', icons.noIcon?.img === false && icons.noIcon?.svg === true, JSON.stringify(icons.noIcon))
    check('图标加载失败也回落类型字形', icons.broken?.img === false && icons.broken?.svg === true, JSON.stringify(icons.broken))
    check('图标没有把卡片图标位撑变形', icons.withIcon?.w === icons.noIcon?.w && icons.withIcon?.h === icons.noIcon?.h, `${icons.withIcon?.w}x${icons.withIcon?.h} vs ${icons.noIcon?.w}x${icons.noIcon?.h}`)

    await page.getByRole('button', { name: '插件', exact: true }).click()
    await page.locator('.mk-grid').waitFor()
    const pluginNames = await page.locator('.mk-grid .mk-card-title').allTextContents()
    check('插件分类同时展示引擎插件与 Forsion 插件', pluginNames.includes('Calendar Tools') && pluginNames.includes('LaTeX Suite') && pluginNames.includes('Mindmap'), pluginNames.join(' / '))
    await page.getByRole('button', { name: '商店首页', exact: true }).click()

    const search = page.locator('.mk-search input')
    await search.fill('LaTeX')
    await page.locator('.mk-card-title', { hasText: 'LaTeX Suite' }).waitFor()
    check('搜索会收敛到匹配商品', await page.locator('.mk-grid .mk-card').count() === 1)
    await page.locator('.mk-card-title', { hasText: 'LaTeX Suite' }).click()
    await page.locator('.mk-detail-sidebar').waitFor()
    check('详情页显示来源、版本与上架审核说明', await page.locator('.mk-facts').isVisible() && await page.locator('.mk-trust-row').isVisible())
    check('详情页安装动作独立固定在侧栏', await page.locator('.mk-detail-actions .mk-wide-btn').count() >= 1)
    await page.screenshot({ path: SHOTS.detail, fullPage: true })

    await page.locator('.mk-detail-back').click()
    await page.locator('.settings-nav-list button', { hasText: '已安装' }).click()
    await page.locator('.mk-grid').waitFor()
    check('已安装区只列出本机已有市场内容', await page.locator('.mk-grid .mk-card').count() === 2)

    // 卸载(2026-08-25):此前市场只有「重新安装」,装错/不想要的东西没有出口。
    // ⚠️ 卸载走 window.confirm,Playwright 不接管 dialog 会一直挂着 —— 这条断言最初就是这么卡住的。
    await page.screenshot({ path: SHOTS.installed, fullPage: true })
    page.on('dialog', (d) => { void d.accept() })
    const beforeCount = await page.locator('.mk-grid .mk-card').count()
    check('已安装卡上有卸载按钮', await page.locator(`.mk-grid .mk-card button[aria-label="卸载"]`).count() === beforeCount)
    await page.locator('.mk-grid .mk-card button[aria-label="卸载"]').first().click()
    await page.waitForFunction((n) => document.querySelectorAll('.mk-grid .mk-card').length === n - 1, beforeCount - 0, { timeout: 5000 })
    check('卸载后该项从已安装区消失', await page.locator('.mk-grid .mk-card').count() === beforeCount - 1)

    await page.locator('.settings-nav-list button', { hasText: '商店首页' }).click()
    await page.evaluate(() => {
      document.documentElement.classList.add('dark')
      document.documentElement.dataset.mode = 'dark'
      document.body.offsetHeight
      document.getAnimations().forEach((animation) => animation.finish())
    })
    await page.screenshot({ path: SHOTS.dark, fullPage: true })
    const dark = await page.evaluate(() => {
      const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
      const lum = (value) => rgb(value).map((n) => n / 255).map((n) => n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0)
      const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
      const card = document.querySelector('.mk-card')
      const style = getComputedStyle(card)
      const title = getComputedStyle(card.querySelector('.mk-card-title'))
      return { bg: style.backgroundColor, text: title.color, titleContrast: contrast(style.backgroundColor, title.color), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
    })
    check('暗色态商品卡仍有独立表面', dark.bg !== dark.text, `${dark.bg} / ${dark.text}`)
    check('暗色商品标题对比度达到 WCAG AA', dark.titleContrast >= 4.5, dark.titleContrast.toFixed(2))
    check('暗色态没有横向溢出', dark.overflow <= 0, `${dark.overflow}px`)
    check('页面运行无 console/page error', errors.length === 0, errors.slice(0, 3).join(' ; '))

    console.log(`SHOT  ${SHOTS.light}`)
    console.log(`SHOT  ${SHOTS.dark}`)
    console.log(`SHOT  ${SHOTS.detail}`)
  } finally {
    if (browser) await browser.close()
    vite.kill('SIGTERM')
  }
  const bad = results.filter((item) => !item.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
