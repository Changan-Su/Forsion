/**
 * Shared Floating TOC UI contract (real Chromium + real Electron).
 *
 * Covers both seams introduced by the feature:
 *  1. A DOM-only external plugin mounts the host-native TOC through ctx.ui, then refreshes/disposes it.
 *  2. Amadeus opens a real markdown note and gets the same TOC in its real editor scroll surface.
 *
 * The Electron half reads out/, so run `npm run build` first.
 */
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { chromium, _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const SHOTS = process.env.FTOC_SHOTS || path.join(os.tmpdir(), 'forsion-floating-toc')
const results = []

function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${String(detail).slice(0, 240)}` : ''}`)
}

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()
  for (const dir of dirs) {
    for (const app of [
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const executable = path.join(cache, dir, 'chrome-mac-arm64', app)
      if (fs.existsSync(executable)) return executable
    }
  }
  throw new Error('找不到 Chromium；可通过 CHROMIUM_EXE 指定')
}

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false))
    req.setTimeout(1200, () => { req.destroy(); resolve(false) })
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

const PLUGIN_CODE = String.raw`
ctx.registerView({ id: 'toc-manual', title: 'Floating TOC probe', mount(el) {
  el.style.height = '100%'
  const shell = document.createElement('section')
  shell.dataset.probe = 'shell'
  Object.assign(shell.style, { height: '100%', minHeight: '0', background: 'var(--bg)' })
  const scroll = document.createElement('article')
  scroll.dataset.probe = 'scroll'
  Object.assign(scroll.style, {
    boxSizing: 'border-box', height: '100%', overflow: 'auto', padding: '48px 96px',
    color: 'var(--text)', fontFamily: 'var(--font-ui)', lineHeight: '1.65',
  })
  const section = (tag, title, body) => {
    const heading = document.createElement(tag)
    heading.textContent = title
    heading.style.margin = '0 0 16px'
    const copy = document.createElement('p')
    copy.textContent = body
    copy.style.minHeight = '560px'
    scroll.append(heading, copy)
  }
  section('h1', 'Getting started', 'The host scans plugin-owned DOM; the plugin keeps the content.')
  section('h2', 'Configuration', 'The scrolling surface is independent from the overlay shell.')
  section('h3', 'Lifecycle', 'The returned handle refreshes and disposes the host-owned layer.')
  shell.append(scroll)
  el.append(shell)
  const toc = ctx.ui?.mountFloatingToc(shell, {
    scrollContainer: scroll,
    selector: 'h1, h2, h3',
    label: 'Plugin table of contents',
  })
  window.__ftocProbe = { shell, scroll, toc }
  return () => { toc?.dispose(); delete window.__ftocProbe }
} })
`

async function checkPluginApi() {
  const externalUrl = process.env.FTOC_HARNESS_URL
  const port = externalUrl ? null : await freePort()
  const base = externalUrl || `http://127.0.0.1:${port}/harness.html`
  let vite = null
  if (!externalUrl) {
    vite = spawn('npx', ['vite', 'frontend', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: ROOT,
      stdio: 'ignore',
    })
    let up = false
    for (let i = 0; i < 80 && !up; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      up = await ping(base)
    }
    if (!up) throw new Error('Floating TOC web 台架没有启动')
  }

  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 860 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  try {
    await page.goto(`${base}?plugview`)
    await page.waitForFunction(() => !!window.__pv, null, { timeout: 20_000 })
    await page.evaluate((code) => window.__pv.loadPlugin(code, { id: 'floating-toc-probe', name: 'Floating TOC probe' }), PLUGIN_CODE)
    await page.waitForSelector('.lcl-ftoc', { timeout: 15_000 })

    check('插件 API：默认扫描 h1-h3', await page.locator('.lcl-ftoc-item').count() === 3)
    check('插件 API：挂载不接管正文 DOM', await page.locator('[data-probe="scroll"] h1').count() === 1)
    check('插件 API：静态 shell 被临时设为定位容器', await page.evaluate(() => window.__ftocProbe.shell.style.position === 'relative'))

    const toc = page.locator('.lcl-ftoc')
    await toc.hover()
    await page.waitForFunction(() => document.querySelector('.lcl-ftoc')?.classList.contains('open'))
    await page.waitForTimeout(300)
    const expanded = await toc.evaluate((el) => ({ width: el.getBoundingClientRect().width, text: el.innerText }))
    check('插件 API：hover 展开并显示目录文案', expanded.width > 180 && expanded.text.includes('Configuration'), JSON.stringify(expanded))
    await page.screenshot({ path: path.join(SHOTS, 'plugin-light.png') })

    await page.getByRole('button', { name: 'Configuration' }).click()
    await page.waitForFunction(() => {
      const scroll = window.__ftocProbe.scroll
      const heading = [...scroll.querySelectorAll('h1,h2,h3')].find((el) => el.textContent === 'Configuration')
      const active = document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title
      return heading && Math.abs(heading.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24) <= 12
        && active === 'Configuration'
    })
    const landing = await page.evaluate(() => {
      const scroll = window.__ftocProbe.scroll
      const heading = [...scroll.querySelectorAll('h1,h2,h3')].find((el) => el.textContent === 'Configuration')
      return {
        top: heading.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
        active: document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title,
      }
    })
    check('插件 API：点击平滑跳转并更新活动项', Math.abs(landing.top - 24) <= 12 && landing.active === 'Configuration', JSON.stringify(landing))

    await page.evaluate(() => {
      const heading = document.createElement('h2')
      heading.textContent = 'Dynamic section'
      window.__ftocProbe.scroll.append(heading)
    })
    await page.waitForFunction(() => document.querySelectorAll('.lcl-ftoc-item').length === 4)
    check('插件 API：正文 DOM 增删会自动重扫', await page.locator('.lcl-ftoc-item').count() === 4)

    await page.evaluate(() => {
      const heading = window.__ftocProbe.scroll.querySelector('h2:last-of-type')
      heading.dataset.lclTocTitle = 'Refreshed section'
      window.__ftocProbe.toc.refresh()
    })
    await page.waitForFunction(() => [...document.querySelectorAll('.lcl-ftoc-item')].some((el) => el.title === 'Refreshed section'))
    check('插件 API：refresh 可覆盖观察器看不到的属性变化', await page.locator('.lcl-ftoc-item[title="Refreshed section"]').count() === 1)

    await page.evaluate(() => { window.__ftocProbe.scroll.style.width = '480px' })
    await page.waitForFunction(() => !document.querySelector('.lcl-ftoc'))
    check('插件 API：窄滚动面自动隐藏', await page.locator('.lcl-ftoc').count() === 0)
    await page.evaluate(() => { window.__ftocProbe.scroll.style.width = '100%' })
    await page.waitForSelector('.lcl-ftoc')

    await page.evaluate(() => window.__pv.setMode('dark'))
    await page.locator('.lcl-ftoc').hover()
    await page.screenshot({ path: path.join(SHOTS, 'plugin-dark.png') })
    check('插件 API：暗色主题仍使用同一宿主组件', await page.locator('.am-app[data-mode="dark"] .lcl-ftoc.open').count() === 1)

    await page.evaluate(() => window.__ftocProbe.toc.dispose())
    await page.waitForFunction(() => !document.querySelector('.lcl-ftoc-mount-layer'))
    const disposed = await page.evaluate(() => ({ toc: !!document.querySelector('.lcl-ftoc'), inlinePosition: window.__ftocProbe.shell.style.position }))
    check('插件 API：dispose 清理挂载层并恢复 shell', !disposed.toc && disposed.inlinePosition === '', JSON.stringify(disposed))
    check('插件 API：无未捕获页面错误', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    await browser.close().catch(() => {})
    if (vite) vite.kill()
  }
}

function longSection(title, count) {
  return `${title}\n\n${Array.from({ length: count }, (_, i) => `用于目录滚动验证的正文第 ${i + 1} 段。`).join('\n\n')}\n\n`
}

async function checkAmadeus() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('缺 out/main/main.js；先运行 npm run build')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ftoc-'))
  const vault = path.join(home, 'vault')
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  const note = [
    longSection('# 总览', 32),
    longSection('## 架构', 32),
    longSection('### 插件 API', 20),
  ].join('')
  fs.writeFileSync(path.join(vault, 'Floating TOC 验证.md'), note)
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2200)
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.getByText(label, { exact: true }).first()
      if (await button.count().catch(() => 0)) { await button.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'amadeus'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.am-app', { timeout: 40_000 })
    await win.waitForTimeout(2200)
    if (!(await win.locator('.t2s-srow', { hasText: 'Floating TOC 验证' }).first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    await win.locator('.t2s-srow', { hasText: 'Floating TOC 验证' }).first().click()
    await win.waitForSelector('.page-view h1', { timeout: 30_000 })
    await win.waitForSelector('.lcl-ftoc', { timeout: 15_000 })

    const labels = await win.locator('.lcl-ftoc-item').evaluateAll((els) => els.map((el) => el.title))
    check('Amadeus：真实笔记生成 3 级 Floating TOC', JSON.stringify(labels) === JSON.stringify(['总览', '架构', '插件 API']), JSON.stringify(labels))
    check('Amadeus：目录复用 LCL 类而非 Amadeus 私有副本', await win.locator('.lcl-ftoc').count() === 1)

    const geometry = async () => win.evaluate(() => {
      const toc = document.querySelector('.lcl-ftoc')
      const pane = toc?.closest('.amx-pane')
      if (!toc || !pane) return null
      const t = toc.getBoundingClientRect()
      const p = pane.getBoundingClientRect()
      return { delta: Math.round((t.top + t.height / 2) - (p.top + p.height / 2)), top: pane.scrollTop }
    })
    const before = await geometry()
    check('Amadeus：折叠目录固定在编辑器视口中线', before && Math.abs(before.delta) <= 24, JSON.stringify(before))

    const toc = win.locator('.lcl-ftoc')
    await toc.hover()
    await win.waitForFunction(() => document.querySelector('.lcl-ftoc')?.classList.contains('open'))
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(SHOTS, 'amadeus-light.png') })
    await win.getByRole('button', { name: '架构' }).click()
    await win.waitForFunction(() => {
      const toc = document.querySelector('.lcl-ftoc')
      const pane = toc?.closest('.amx-pane')
      const heading = [...document.querySelectorAll('.page-view h2')].find((el) => el.textContent?.trim() === '架构')
      if (!pane || !heading) return false
      const offset = heading.getBoundingClientRect().top - pane.getBoundingClientRect().top
      const active = document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title
      return pane.scrollTop > 300 && Math.abs(offset - 24) <= 14 && active === '架构'
    })
    const after = await geometry()
    const active = await win.locator('.lcl-ftoc-item[aria-current="location"]').getAttribute('title')
    check('Amadeus：点击目录滚到标题并高亮当前节', after && after.top > 300 && active === '架构', JSON.stringify({ after, active }))
    check('Amadeus：滚动后目录仍固定在编辑器视口中线', after && Math.abs(after.delta) <= 24, JSON.stringify(after))

    await win.setViewportSize({ width: 500, height: 820 })
    await win.waitForFunction(() => !document.querySelector('.lcl-ftoc'))
    check('Amadeus：窄面板不挤占正文', await win.locator('.lcl-ftoc').count() === 0)
  } finally {
    await app.close().catch(() => {})
  }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  await checkPluginApi()
  await checkAmadeus()
  const failed = results.filter((result) => !result.ok)
  console.log(`\n截图：${SHOTS}`)
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.error(`失败：${failed.map((item) => item.name).join('；')}`)
    process.exit(1)
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
