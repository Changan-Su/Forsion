/**
 * 贴按钮开的菜单(useEdgeNudge)纵向不出界 —— 用户 11-17:「列表有时候会被边界挡住」(矮窗口里项目菜单顶部被切)。
 * 真 ProjectSelector + 真 store + 生产 CSS(run-location 台架),灌 14 个项目:
 *   ① 窗口够高:照旧开在按钮上方、不翻面
 *   ② 窗口矮:两侧都放不下 → 留在空间大的一侧并封顶,搜索框钉在顶上,滚到底仍看得见
 *   ③ 按钮在顶部:上方放不下 → 翻到下方
 * 每档 100% / 110% 缩放、浅 / 深色。截图落 $TMPDIR/forsion-menu-edge/(交付前自己看)。
 * Run: npm run check:menuedge   (= node scripts/e2e-editor.cjs --check=menu-edge;worktree 里会自起一个空闲端口的 vite)
 */
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const baseUrl = new URL(process.env.HARNESS_URL || 'http://localhost:5173/harness.html')
baseUrl.pathname = '/run-location-harness.html'
const out = process.env.MENU_EDGE_SHOTS || path.join(os.tmpdir(), 'forsion-menu-edge')
fs.mkdirSync(out, { recursive: true })
const results = [], errors = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(detail)}`)
}

const geometry = (page) => page.evaluate(() => {
  const menu = document.querySelector('.composer-menu.project-menu:not([data-lcl-exit])')
  const pill = document.querySelector('.project-selector:not(.runloc) > .project-pill')
  if (!menu || !pill) return null
  const m = menu.getBoundingClientRect(), p = pill.getBoundingClientRect()
  const s = menu.querySelector('.project-menu-search')?.getBoundingClientRect()
  return {
    menu: { top: m.top, bottom: m.bottom, left: m.left, right: m.right, height: m.height },
    pill: { top: p.top, bottom: p.bottom },
    search: s ? { top: s.top, bottom: s.bottom, visible: s.top >= m.top - 1 && s.bottom <= m.bottom + 1 && s.top >= 0 && s.bottom <= innerHeight } : null,
    capped: menu.hasAttribute('data-edge-capped'),
    // 真能滚:overflow 不是 visible(封顶后内联 auto 被下一轮量丢过,评审 11-17)且内容比盒子高
    scrollable: getComputedStyle(menu).overflowY !== 'visible' && menu.scrollHeight > menu.clientHeight + 1,
    scrollTop: menu.scrollTop,
    rows: menu.querySelectorAll('.project-menu-item').length,
    vh: innerHeight, vw: innerWidth,
  }
})

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 900 } })
    page.on('pageerror', (e) => errors.push(String(e)))
    for (const zoom of [1, 1.1]) for (const dark of [false, true]) {
      const tag = `${zoom}${dark ? ' dark' : ''}`
      await page.setViewportSize({ width: 900, height: 900 })
      await page.goto(`${baseUrl}?zoom=${zoom}${dark ? '&dark' : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await page.waitForFunction(() => !!window.__runloc, null, { timeout: 60000 })
      // 14 个项目:每个项目一条本机会话(工作区列表由会话的 project_path 推出)
      await page.evaluate(() => {
        const { useApp } = window.__runloc
        const sessions = Array.from({ length: 14 }, (_, i) => ({
          id: `edge-${i}`, title: `会话 ${i}`, project_path: `/Users/me/code/project-${String(i).padStart(2, '0')}`, project_name: `project-${String(i).padStart(2, '0')}`,
          created_at: '2026-11-17T08:00:00Z', updated_at: `2026-11-17T08:${String(i).padStart(2, '0')}:00Z`,
        }))
        useApp.setState({ sessions })
      })
      const pill = page.locator('.project-selector:not(.runloc) > .project-pill')
      await pill.waitFor({ timeout: 60000 })
      const open = async () => { await pill.click(); await page.waitForTimeout(260) }
      const close = async () => { await page.keyboard.press('Escape'); await page.mouse.click(5, 5); await page.waitForTimeout(200) }

      // ① 够高:开在按钮上方,不封顶
      await open()
      let g = await geometry(page)
      check(`${tag} tall: opens above, not capped`, !!g && g.menu.bottom <= g.pill.top + 1 && g.menu.top >= 0 && !g.capped && g.rows >= 10, g)
      await close()

      // ② 矮:两侧都放不下 → 留在大的一侧封顶,搜索框钉住
      await page.setViewportSize({ width: 900, height: 330 })
      await page.waitForTimeout(150)
      await open()
      await page.waitForTimeout(400) // 入场动画放完、ResizeObserver 再量几轮之后,封顶的滚动还在
      g = await geometry(page)
      check(`${tag} short: menu stays inside the window`, !!g && g.menu.top >= 0 && g.menu.bottom <= g.vh + 1, g)
      check(`${tag} short: capped and scrollable`, !!g && g.capped && g.scrollable, g)
      check(`${tag} short: search visible`, !!g && !!g.search && g.search.visible, g)
      await page.screenshot({ path: path.join(out, `short-${zoom}${dark ? '-dark' : ''}.png`) })
      await page.evaluate(() => { const m = document.querySelector('.composer-menu.project-menu:not([data-lcl-exit])'); m.scrollTop = m.scrollHeight })
      await page.waitForTimeout(80)
      g = await geometry(page)
      check(`${tag} short: really scrolled and search stays pinned`, !!g && g.scrollTop > 20 && g.scrollable && !!g.search && g.search.visible, g)
      await page.screenshot({ path: path.join(out, `short-scrolled-${zoom}${dark ? '-dark' : ''}.png`) })
      await close()

      // ③ 按钮在顶部、下方空间大:翻到下方
      await page.setViewportSize({ width: 900, height: 620 })
      await page.evaluate(() => { document.querySelector('.t2-chat-view').style.justifyContent = 'flex-start' })
      await page.waitForTimeout(150)
      await open()
      g = await geometry(page)
      check(`${tag} pill at top: flips below the pill`, !!g && g.menu.top >= g.pill.bottom - 1 && g.menu.bottom <= g.vh + 1, g)
      await page.screenshot({ path: path.join(out, `flip-${zoom}${dark ? '-dark' : ''}.png`) })
      await close()
      await page.evaluate(() => { document.querySelector('.t2-chat-view').style.justifyContent = 'flex-end' })
    }
    check('no runtime errors', errors.length === 0, errors)
    console.log(`${results.filter((r) => r.ok).length}/${results.length} passed; shots: ${out}`)
    if (results.some((r) => !r.ok)) process.exitCode = 1
  } finally { await browser.close() }
})().catch((e) => { console.error(e); process.exitCode = 1 })
