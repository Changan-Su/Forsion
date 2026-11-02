/**
 * Shared Floating TOC UI contract (real Chromium + real Electron).
 *
 * Covers both seams introduced by the feature:
 *  1. A DOM-only external plugin mounts the host-native TOC through ctx.ui, then refreshes/disposes it.
 *  2. Amadeus opens a real markdown note and gets the same TOC in its real editor scroll surface.
 *  3. Layout and motion (DESIGN §6「悬浮目录」): the gutter keeps text, ticks and block handles apart, hover intent,
 *     the droplet timeline, reopening never shows an empty panel, long lists pool, keyboard, reduced motion.
 *  4. Chat in real Electron: the gutter, the summary rail, and the composer staying clear of the open list.
 *
 * The Electron half reads out/, so run `npm run build` first.
 */
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')
const electron = require('./lib/launch-electron.cjs')
const U = require('./lib/uiux-electron.cjs')

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

    const openToc = async () => {
      await page.locator('.lcl-ftoc').hover()
      await page.waitForFunction(() => document.querySelector('.lcl-ftoc')?.classList.contains('open'))
      await page.waitForTimeout(500)
    }
    const closeToc = async () => {
      await page.mouse.move(1000, 100)
      await page.waitForFunction(() => !document.querySelector('.lcl-ftoc-panel'))
    }
    await openToc()
    check('插件 API：默认扫描 h1-h3', await page.locator('.lcl-ftoc-item').count() === 3)
    await closeToc()
    check('插件 API：挂载不接管正文 DOM', await page.locator('[data-probe="scroll"] h1').count() === 1)
    check('插件 API：静态 shell 被临时设为定位容器', await page.evaluate(() => window.__ftocProbe.shell.style.position === 'relative'))

    const toc = page.locator('.lcl-ftoc')
    await toc.hover()
    await page.waitForFunction(() => document.querySelector('.lcl-ftoc')?.classList.contains('open'))
    await page.waitForTimeout(500)
    const expanded = await page.locator('.lcl-ftoc-panel').evaluate((el) => ({ width: el.getBoundingClientRect().width, text: el.innerText }))
    check('插件 API：hover 展开并显示目录文案', expanded.width >= 168 && expanded.text.includes('Configuration'), JSON.stringify(expanded))
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
    await openToc()
    await page.waitForFunction(() => document.querySelectorAll('.lcl-ftoc-item').length === 4)
    check('插件 API：正文 DOM 增删会自动重扫', await page.locator('.lcl-ftoc-item').count() === 4)

    await page.evaluate(() => {
      const heading = window.__ftocProbe.scroll.querySelector('h2:last-of-type')
      heading.dataset.lclTocTitle = 'Refreshed section'
      window.__ftocProbe.toc.refresh()
    })
    await page.waitForFunction(() => [...document.querySelectorAll('.lcl-ftoc-item')].some((el) => el.title === 'Refreshed section'))
    check('插件 API：refresh 可覆盖观察器看不到的属性变化', await page.locator('.lcl-ftoc-item[title="Refreshed section"]').count() === 1)

    await page.evaluate(() => {
      const headings = Array.from({ length: 80 }, (_, index) => {
        const heading = document.createElement('h2')
        heading.textContent = `Long section ${index + 1}`
        return heading
      })
      window.__ftocProbe.scroll.append(...headings)
    })
    await page.waitForFunction(() => document.querySelectorAll('.lcl-ftoc-item').length === 84)
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    await closeToc()
    await page.waitForTimeout(300)
    const compact = await toc.evaluate((el) => {
      const bounds = el.getBoundingClientRect()
      const ticks = [...el.querySelectorAll('.lcl-ftoc-tick')].map((t) => t.getBoundingClientRect())
      return { height: bounds.height, max: window.innerHeight * 0.44 + 16, lastBottom: Math.max(...ticks.map((t) => t.bottom)), bottom: bounds.bottom, ticks: ticks.length }
    })
    check('长目录：折叠态压进视口且末项可见', compact.height <= compact.max + 2 && compact.lastBottom <= compact.bottom + 1, JSON.stringify(compact))
    await page.screenshot({ path: path.join(SHOTS, 'plugin-long-collapsed.png') })
    await openToc()
    const longOpen = await page.locator('.lcl-ftoc-panel').evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, max: window.innerHeight * 0.56, count: el.querySelectorAll('.lcl-ftoc-item').length }))
    check('长目录：展开态限制高度并保留滚动', longOpen.count === 84 && longOpen.clientHeight <= longOpen.max + 2 && longOpen.scrollHeight > longOpen.clientHeight, JSON.stringify(longOpen))
    await page.screenshot({ path: path.join(SHOTS, 'plugin-long-expanded.png') })

    await page.evaluate(() => { window.__ftocProbe.scroll.style.width = '480px' })
    await page.waitForFunction(() => !document.querySelector('.lcl-ftoc'))
    check('插件 API：窄滚动面自动隐藏', await page.locator('.lcl-ftoc').count() === 0)
    await page.evaluate(() => { window.__ftocProbe.scroll.style.width = '100%' })
    await page.waitForSelector('.lcl-ftoc')

    await page.evaluate(() => window.__pv.setMode('dark'))
    await openToc()
    await page.screenshot({ path: path.join(SHOTS, 'plugin-dark.png') })
    check('插件 API：暗色主题仍使用同一宿主组件', await page.locator('.am-app[data-mode="dark"] .lcl-ftoc.open').count() === 1)

    await page.evaluate(() => window.__ftocProbe.toc.dispose())
    await page.waitForFunction(() => !document.querySelector('.lcl-ftoc-mount-layer'))
    const disposed = await page.evaluate(() => ({ toc: !!document.querySelector('.lcl-ftoc'), inlinePosition: window.__ftocProbe.shell.style.position }))
    check('插件 API：dispose 清理挂载层并恢复 shell', !disposed.toc && disposed.inlinePosition === '', JSON.stringify(disposed))
    check('插件 API：无未捕获页面错误', pageErrors.length === 0, pageErrors.join(' | '))
    await checkNoteSurface(browser, base)
  } finally {
    await browser.close().catch(() => {})
    if (vite) vite.kill()
  }
}

/** 笔记页(生产的 NoteFloatingToc):留沟几何 + 水滴时间轴。液滴的时长取 token,台架不写死帧。 */
async function checkNoteSurface(browser, base) {
  // 种子走 URL,长目录用短标题,不然撞请求头上限
  const seed = (n) => Array.from({ length: n }, (_, i) => (n > 40 ? `## S${i + 1}\n\nx\n\n` : `${i % 4 ? '##' : '#'} 第 ${i + 1} 节\n\n占位正文,把页面撑长,看目录刻度和正文左缘的相对位置。\n\n`)).join('')
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const load = async (n, extra = '') => {
    await page.goto(`${base}?upage&upane&utoc${extra}&useed=${encodeURIComponent(seed(n))}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lcl-ftoc', { timeout: 30_000 })
    await page.waitForTimeout(500)
  }
  const geometry = () => page.evaluate(() => {
    const pane = document.querySelector('.amx-pane'), box = pane.getBoundingClientRect()
    const view = document.querySelector('.page-view'), doc = document.querySelector('.amx-doc')
    const left = (el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft) - box.left
    const ticks = [...document.querySelectorAll('.lcl-ftoc-tick')].map((t) => t.getBoundingClientRect().right - box.left)
    const gutter = document.querySelector('.unified-gutter')?.getBoundingClientRect()
    return { pane: box.width, text: left(view), title: doc ? left(doc) : null, rail: ticks.length ? Math.max(...ticks) : null, gutter: gutter ? gutter.left - box.left : null, room: pane.hasAttribute('data-lcl-ftoc') }
  })
  await load(14)
  for (const width of [1400, 1000, 900, 760, 640, 560]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(200)
    await page.locator('.page-view p').nth(2).hover()
    await page.waitForTimeout(250)
    const g = await geometry()
    const clear = g.room && g.rail <= 36 && g.text >= 86 && (g.gutter == null || g.gutter >= 36) && Math.abs(g.text - g.title) <= 1
    check(`留沟：${width} 宽时目录、手柄、正文互不重叠，标题和正文对齐`, clear, JSON.stringify(g))
    if (width === 760) await page.screenshot({ path: path.join(SHOTS, 'note-760.png') })
  }
  await page.setViewportSize({ width: 500, height: 900 })
  await page.waitForFunction(() => !document.querySelector('.lcl-ftoc'))
  await page.waitForTimeout(200)
  const narrow = await geometry()
  check('留沟：目录隐藏的窄面板不让位', !narrow.room && narrow.text === 48, JSON.stringify(narrow))
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.waitForSelector('.lcl-ftoc')

  const rail = async () => {
    const box = await page.locator('.lcl-ftoc').boundingBox()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const away = async () => {
    await page.mouse.move(700, 40)
    await page.waitForFunction(() => !document.querySelector('.lcl-ftoc-panel'), null, { timeout: 3000 })
  }
  const settled = () => page.evaluate(() => {
    const panel = document.querySelector('.lcl-ftoc-panel'), list = panel?.querySelector('.lcl-ftoc-list')
    if (!panel || !list) return null
    const row = panel.querySelector('.lcl-ftoc-item.active')?.getBoundingClientRect(), p = panel.getBoundingClientRect()
    return {
      opacity: getComputedStyle(list).opacity, clip: getComputedStyle(panel).clipPath, visibility: getComputedStyle(panel).visibility,
      pouring: panel.classList.contains('lcl-droplet-pouring'), liquid: document.querySelector('.lcl-droplet')?.style.display ?? 'gone',
      rowInside: !!row && row.top >= p.top && row.bottom <= p.bottom, width: p.width,
    }
  })
  const whole = (s) => !!s && s.opacity === '1' && s.clip === 'none' && s.visibility === 'visible' && !s.pouring && s.rowInside && s.width >= 168 && (s.liquid === 'none' || s.liquid === 'gone')

  await page.locator('.amx-pane').evaluate((pane) => { pane.scrollTop = pane.scrollHeight / 2 })
  await page.waitForTimeout(300)
  const at = await rail()
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(60)
  await page.mouse.move(700, 40)
  await page.waitForTimeout(260)
  check('悬停意图：一扫而过不展开', await page.locator('.lcl-ftoc-panel').count() === 0)

  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(120 + 210) // 悬停 120ms + 液滴走到一半
  const pouring = await page.evaluate(() => {
    const panel = document.querySelector('.lcl-ftoc-panel'), layer = document.querySelector('.lcl-droplet')
    if (!panel || !layer) return null
    const l = layer.getBoundingClientRect(), p = panel.getBoundingClientRect(), s = document.querySelector('.lcl-ftoc-source').getBoundingClientRect()
    return { pouring: panel.classList.contains('lcl-droplet-pouring'), bg: getComputedStyle(panel).backgroundColor, covers: l.left <= s.left && l.right >= p.right && l.top <= p.top && l.bottom >= p.bottom, gap: p.left - s.right, display: layer.style.display }
  })
  check('水滴：倾倒期面板无底色、液体层罩住源和面板、缝不超过 12px', pouring?.pouring && pouring.bg === 'rgba(0, 0, 0, 0)' && pouring.covers && pouring.gap >= 0 && pouring.gap <= 12, JSON.stringify(pouring))
  await page.waitForTimeout(400)
  let s = await settled()
  check('水滴：液体停稳后真面板接手、内容完整', whole(s), JSON.stringify(s))
  const aligned = await page.evaluate(() => {
    const row = document.querySelector('.lcl-ftoc-item.active').getBoundingClientRect(), mark = document.querySelector('.lcl-ftoc-mark').getBoundingClientRect()
    return { row: row.top + row.height / 2, mark: mark.top }
  })
  check('展开：当前项对着自己的刻度', Math.abs(aligned.row - aligned.mark) <= 2, JSON.stringify(aligned))
  await page.screenshot({ path: path.join(SHOTS, 'note-open.png') })

  await away()
  await page.waitForTimeout(100)
  check('收起：液体层和面板都清干净', await page.locator('.lcl-droplet, .lcl-ftoc-panel').count() === 0)
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(650)
  s = await settled()
  check('再次展开：内容不空', whole(s), JSON.stringify(s))
  for (const ms of [20, 80, 160, 240, 290]) {
    await page.mouse.move(700, 40)
    await page.waitForTimeout(150 + ms) // 收起前的 150ms 延时之后
    await page.mouse.move(at.x, at.y)
    await page.waitForTimeout(700)
    s = await settled()
    check(`收到 ${ms}ms 时回来：内容不空`, whole(s), JSON.stringify(s))
  }
  await away()

  await page.locator('.amx-pane').evaluate((pane) => { pane.scrollTop = pane.scrollHeight / 4 })
  await page.waitForTimeout(1600)
  const tick = () => page.evaluate(() => { const t = document.querySelector('.lcl-ftoc-tick'); return { now: Number(getComputedStyle(t).opacity), full: Number(t.style.getPropertyValue('--o')) } })
  const idle = await tick()
  await page.locator('.amx-pane').evaluate((pane) => { pane.scrollTop += 80 })
  await page.waitForTimeout(350)
  const awake = await tick()
  check('平时退后、滚动时亮起', Math.abs(idle.now - idle.full * 0.6) < 0.02 && Math.abs(awake.now - awake.full) < 0.02, JSON.stringify({ idle, awake }))

  await page.keyboard.press('Tab')
  await page.locator('.lcl-ftoc-hit').focus()
  await page.waitForTimeout(650)
  s = await settled()
  check('键盘：聚焦刻度展开', whole(s), JSON.stringify(s))
  await page.keyboard.press('Tab')
  const focusRow = await page.evaluate(() => document.activeElement?.className)
  check('键盘：Tab 进列表', /lcl-ftoc-item/.test(focusRow), focusRow)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const esc = await page.evaluate(() => ({ panel: !!document.querySelector('.lcl-ftoc-panel'), focus: document.activeElement?.className }))
  check('键盘：Esc 收起、焦点回刻度', !esc.panel && /lcl-ftoc-hit/.test(esc.focus), JSON.stringify(esc))
  await page.evaluate(() => document.activeElement?.blur())

  // 键盘焦点在列表里时,鼠标路过再离开不收起
  await page.keyboard.press('Tab')
  await page.locator('.lcl-ftoc-hit').focus()
  await page.waitForTimeout(650)
  await page.keyboard.press('Tab')
  const passBy = await rail()
  await page.mouse.move(passBy.x, passBy.y)
  await page.waitForTimeout(40)
  await page.mouse.move(700, 40)
  await page.waitForTimeout(650)
  s = await settled()
  check('键盘：焦点在列表里时鼠标离开不收起', whole(s), JSON.stringify(s))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.evaluate(() => document.activeElement?.blur())

  // 展开时容器变了:收起,不留一张定位过期的面板
  const before = await rail()
  await page.mouse.move(before.x, before.y)
  await page.waitForTimeout(650)
  await page.setViewportSize({ width: 1000, height: 640 })
  await page.waitForTimeout(650)
  check('展开时容器变矮：列表收起', await page.locator('.lcl-ftoc-panel').count() === 0)
  await page.mouse.move(700, 40)
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.waitForTimeout(300)

  // 悬停计时中目录被隐藏:恢复后不能冒出一张没定位的面板
  const late = await rail()
  await page.mouse.move(late.x, late.y)
  await page.setViewportSize({ width: 500, height: 900 })
  await page.waitForFunction(() => !document.querySelector('.lcl-ftoc'))
  await page.waitForTimeout(200)
  await page.mouse.move(400, 40)
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.waitForSelector('.lcl-ftoc')
  await page.waitForTimeout(300)
  check('悬停计时中被隐藏：恢复后不展开', await page.locator('.lcl-ftoc-panel').count() === 0)

  // 液滴中途隐藏:残影只有刻度
  const mid = await rail()
  await page.mouse.move(mid.x, mid.y)
  await page.waitForFunction(() => document.querySelector('.lcl-droplet'))
  await page.waitForTimeout(100)
  await page.setViewportSize({ width: 500, height: 900 })
  await page.waitForFunction(() => document.querySelector('[data-lcl-exit]') || !document.querySelector('.lcl-ftoc'))
  const ghost = await page.evaluate(() => ({ ghost: !!document.querySelector('.lcl-ftoc-rail[data-lcl-exit]'), panel: document.querySelectorAll('.lcl-ftoc-panel, .lcl-droplet').length }))
  check('液滴中途隐藏：残影只有刻度，面板不露出', ghost.panel === 0, JSON.stringify(ghost))
  await page.mouse.move(400, 40)
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.waitForSelector('.lcl-ftoc')

  await load(200)
  const long = await page.evaluate(() => ({ ticks: document.querySelectorAll('.lcl-ftoc-tick').length, marks: document.querySelectorAll('.lcl-ftoc-mark').length, rail: document.querySelector('.lcl-ftoc').getBoundingClientRect().height, max: innerHeight * 0.44 + 16 }))
  check('长目录：200 条归并、只有一个标记、高度压进 44vh', long.ticks < 200 && long.marks === 1 && long.rail <= long.max + 1, JSON.stringify(long))
  const hugeAt = await rail()
  await page.mouse.move(hugeAt.x, hugeAt.y)
  await page.waitForTimeout(650)
  const rows = await page.locator('.lcl-ftoc-item').count()
  check('长目录：展开列出全部 200 条', rows === 200, rows)
  await page.mouse.move(700, 40)
  await page.waitForFunction(() => !document.querySelector('.lcl-ftoc-panel'), null, { timeout: 3000 })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await load(14)
  const quiet = await rail()
  await page.mouse.move(quiet.x, quiet.y)
  await page.waitForTimeout(170)
  check('减少动态效果：不走液滴', await page.locator('.lcl-ftoc-panel').count() === 1 && await page.locator('.lcl-droplet').count() === 0)
  await page.waitForTimeout(200)
  s = await settled()
  check('减少动态效果：内容完整', whole(s), JSON.stringify(s))
  await page.mouse.move(700, 40)
  await page.waitForTimeout(400)
  await page.mouse.move(quiet.x, quiet.y)
  await page.waitForTimeout(450)
  s = await settled()
  check('减少动态效果：再次展开内容不空', whole(s), JSON.stringify(s))
  check('笔记页：无未捕获页面错误', errors.length === 0, errors.join(' | '))
  await context.close()
}

/** Chat 里真的是 ChatView + 假引擎:留沟随聊天列宽走,右栏车道算进去,展开的列表不压输入框。 */
async function checkChat() {
  const answer = (i) => [`## 小节 ${i}`, '正文第一段,足够长,让它在聊天列里折成两行。'.repeat(3), `### 细节 ${i}`, '第二段。'].join('\n\n')
  const messages = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'model' : 'user', content: i % 2 ? answer(i) : `问题 ${i}`, timestamp: i + 1 }))
  const { app, win, close } = await U.launch({ tag: 'ftoc', messages })
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click({ timeout: 10_000 })
    await win.waitForSelector('.lcl-ftoc', { timeout: 15_000 })
    await win.waitForTimeout(1200)
    const geometry = () => win.evaluate(() => {
      const stream = document.querySelector('.t2-stream'), box = stream.getBoundingClientRect()
      const inner = document.querySelector('.t2-stream-inner'), r = inner.getBoundingClientRect()
      const ticks = [...document.querySelectorAll('.lcl-ftoc-tick')].map((t) => t.getBoundingClientRect().right - box.left)
      return { stream: Math.round(box.width), text: r.left + parseFloat(getComputedStyle(inner).paddingLeft) - box.left, rail: ticks.length ? Math.max(...ticks) : null, room: stream.hasAttribute('data-lcl-ftoc') }
    })
    for (const width of [1440, 1200, 1040, 900]) {
      await win.setViewportSize({ width, height: 900 })
      await win.waitForTimeout(300)
      const g = await geometry()
      check(`Chat：窗口 ${width} 宽时正文不压刻度`, g.room && g.rail <= 36 && g.text >= 36 - 0.5, JSON.stringify(g))
    }
    await win.screenshot({ path: path.join(SHOTS, 'chat-900.png') })
    await win.setViewportSize({ width: 1440, height: 760 })
    await win.waitForTimeout(300)
    await win.locator('.t2-stream').evaluate((el) => { el.scrollTop = 0 })
    await win.waitForTimeout(400)
    await win.locator('.lcl-ftoc').hover()
    await win.waitForTimeout(700)
    const open = await win.evaluate(() => {
      const panel = document.querySelector('.lcl-ftoc-panel')?.getBoundingClientRect(), composer = document.querySelector('.composer-anchor .t2c-inner, .composer-anchor')?.getBoundingClientRect()
      const list = document.querySelector('.lcl-ftoc-list')
      return panel && { bottom: panel.bottom, composer: composer?.top, opacity: list && getComputedStyle(list).opacity, h: panel.height }
    })
    check('Chat：展开的列表不压输入框', open && open.opacity === '1' && open.bottom <= open.composer + 1, JSON.stringify(open))
    await win.screenshot({ path: path.join(SHOTS, 'chat-open.png') })
    await win.mouse.move(900, 40)
    await win.waitForTimeout(600)
    check('Chat：收起干净', await win.locator('.lcl-droplet, .lcl-ftoc-panel').count() === 0)
  } finally {
    await close()
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

    const opened = async () => {
      await win.locator('.lcl-ftoc').hover()
      await win.waitForFunction(() => document.querySelector('.lcl-ftoc')?.classList.contains('open'))
      await win.waitForTimeout(550)
    }
    await opened()
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

    await win.screenshot({ path: path.join(SHOTS, 'amadeus-light.png') })
    await win.getByRole('button', { name: '架构' }).click()
    // 落不准时把现场打出来(scrollTop / 标题离顶 / 当前项),别只剩一行超时
    const landing = () => win.evaluate(() => {
      const toc = document.querySelector('.lcl-ftoc'); const pane = toc?.closest('.amx-pane')
      const heading = [...document.querySelectorAll('.page-view h2')].find((el) => el.textContent?.trim() === '架构')
      return { top: pane && Math.round(pane.scrollTop), offset: pane && heading && Math.round(heading.getBoundingClientRect().top - pane.getBoundingClientRect().top), active: document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title }
    })
    await win.waitForFunction(() => {
      const toc = document.querySelector('.lcl-ftoc')
      const pane = toc?.closest('.amx-pane')
      const heading = [...document.querySelectorAll('.page-view h2')].find((el) => el.textContent?.trim() === '架构')
      if (!pane || !heading) return false
      const offset = heading.getBoundingClientRect().top - pane.getBoundingClientRect().top
      const active = document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title
      // 笔记目录停在 sticky 顶栏下 12px(NoteFloatingToc:READING_GAP + stickyTopInset),不是 LCL 缺省的 24
      const bar = pane.querySelector(':scope > .amx-toolbar')
      const inset = bar && getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().height : 0
      return pane.scrollTop > 300 && Math.abs(offset - inset - 12) <= 14 && active === '架构'
    }, null, { timeout: 8000 }).catch(async (e) => { console.log('落点现场', JSON.stringify(await landing())); throw e })
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
  await checkChat()
  const failed = results.filter((result) => !result.ok)
  console.log(`\n截图：${SHOTS}`)
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.error(`失败：${failed.map((item) => item.name).join('；')}`)
    process.exit(1)
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
