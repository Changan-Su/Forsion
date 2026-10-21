/**
 * 使用指南(Forsion Extend 0.9)× 手机单列壳 —— `npm run build && npm run e2e:guide`。
 *
 * 手机 App 随包带经签名验证的 Extend,这里使用真实捆绑代码,
 * 看指南在手机布局下落在哪、宿主那几条接缝在手机上通不通:
 *   ① 冷启动(落主页)不算一次「换 Space」(bootstrapEngine 里启动后 3s 内不计);
 *   ② 有「已达成未领取」的成就 →「⋯」上挂红点、「⋯」里成就那行挂红点(读屏念「有可领取的成就」);
 *   ③ 页内 forsion:// 链接在应用内路由,点下到切过去 < 1.5s(单列壳没有 Dockview api,等 api 会白等 8s);
 *   ④ 主区是只读阅读页,章节树在左抽屉(App 原生底栏下是两级导航的列表层);右栏「进度」在右抽屉;
 *   ⑤ 「带我去」切到目标 Space,伴读进目标 Space 的右抽屉(不自动弹开盖住目标页);
 *   ⑥ 电脑上才能做的任务写「在电脑上做」,不给「带我去」;
 *   ⑦ 负对照:没有可领的成就 → 两处都没有红点。
 * 截图在 mobile/outputs/guide-mobile/(已 gitignore),交付前人眼看一遍。
 * 负对照(③):把 E2E_ROOT 指到没修的检出的 mobile/(先在那边 build),③ 必须红。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { startPreview } = require('./lib/preview.cjs')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const ROOT = process.env.E2E_ROOT ? path.resolve(process.env.E2E_ROOT) : path.resolve(__dirname, '..')
const SHOTS = path.resolve(__dirname, '../outputs/guide-mobile')
const EXT_ID = 'forsion-extend'
const GUIDE = 'forsion-guide'
const ACH_KEY = 'forsion_tangu_achievements'
// Lv.1–3 的官方事件都做过,只差两件:space.switch(①要看它冷启动后还是 0)和 note.wikilink(⑤要一条没做完的任务)。
const SEED = {
  'chat.send': 5, 'note.create': 1, 'note.canvas': 1, 'theme.change': 1,
  'base.create': 1, 'market.install': 1, 'space.save': 1, 'calendar.event': 1, 'todo.done': 1,
  'agent.create': 1, 'muse.open': 1, 'automation.create': 1,
}

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const exe = path.join(root, d, rel)
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) { console.error(`✗ ${ROOT} 没有 dist/,先 npm run build`); process.exit(1) }
  fs.mkdirSync(SHOTS, { recursive: true })
  const preview = await startPreview(ROOT)
  const fails = []
  const check = (ok, name, extra) => { if (!ok) fails.push(name); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  | ${extra}` : ''}`) }
  let browser = null
  try {
    await preview.ready()
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const newCtx = async (seed) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
      await ctx.addInitScript(([key, counters]) => {
        try {
          localStorage.setItem('forsion_tangu_onboarding_done', '1')
          localStorage.setItem('forsion_token', 'e2e-guide')
          if (counters && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ v: 1, counters, claimed: [] }))
        } catch { /* ignore */ }
      }, [ACH_KEY, seed])
      await ctx.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
      await ctx.route('**/api/**', (r) => r.abort())
      // ⚠️ context 的第一张页有时没有触屏模拟(界面照桌面渲染):读 maxTouchPoints,没有就再开一张
      let page = await ctx.newPage()
      await page.goto('about:blank')
      if (!(await page.evaluate(() => navigator.maxTouchPoints))) page = await ctx.newPage()
      return { ctx, page }
    }

    const { page } = await newCtx(SEED)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const cdp = await page.context().newCDPSession(page)
    // body zoom 下 Playwright 的可点性判定失真 → 同手机套件:CDP 触摸打 boundingBox 中心
    const tap = async (loc, what) => {
      await loc.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      await loc.first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      const b = await loc.first().boundingBox({ timeout: 5000 })
      if (!b) throw new Error(`目标不可见: ${what}`)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(500)
    }
    const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    const counters = () => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) || '{}').counters || {}), ACH_KEY)
    const boot = async () => { await page.waitForSelector('.mb-topbar [aria-label="more"]', { timeout: 30_000 }); await page.waitForTimeout(4000) }
    const more = page.locator('.mb-topbar [aria-label="more"]')
    const space = () => page.locator('.mb-shell').getAttribute('data-space')
    /** 页内 forsion:// 链接(挂在正文外,不在可编辑区里):点下 → data-space 变成目标,量耗时。 */
    const followLink = async (href, want) => {
      await page.evaluate((h) => { const a = document.createElement('a'); a.href = h; a.textContent = 'guide link'; a.id = 'e2e-link'; Object.assign(a.style, { position: 'fixed', left: '120px', top: '400px', zIndex: '99999', padding: '12px', background: '#fff' }); document.body.appendChild(a) }, href)
      const t0 = Date.now()
      await tap(page.locator('#e2e-link'), 'forsion:// 链接')
      await page.waitForFunction((id) => document.querySelector('.mb-shell')?.getAttribute('data-space') === id, want, { timeout: 12_000 }).catch(() => {})
      const ms = Date.now() - t0 - 500 // tap 自带 500ms 落定
      await page.evaluate(() => document.getElementById('e2e-link')?.remove())
      return { ms, on: await space() }
    }

    await page.goto(preview.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await boot()

    // ① 冷启动不计「换 Space」
    check(!(await counters())['space.switch'], '① 冷启动落主页不算一次「换 Space」', JSON.stringify((await counters())['space.switch'] ?? 0))

    // ② 红点
    check(await more.locator('.rb-dot').count() === 1, '② 有可领的成就 →「⋯」上挂红点')
    await shot('1-more-dot')
    await tap(more, '「⋯」')
    const achRow = page.locator('.mb-sheet [data-ribbon-id="rb-achievements"]')
    const rowDot = await achRow.locator('.rb-dot').getAttribute('aria-label').catch(() => null)
    check(rowDot === '有可领取的成就', '② 「⋯」里成就那行挂红点(读屏念出意思)', String(rowDot))
    await shot('2-more-sheet')
    // The official renderer is part of the app; test its real host listing rather than installing a duplicate identity.
    const ext = await page.evaluate(async () => (await window.amadeus.listPlugins()).find((p) => p.id === 'forsion-extend'))
    check(!!ext?.locked && !!ext?.preinstalled, '手机捆绑的 Extend 已装载')
    await page.locator('.mb-sheet-scrim').click({ position: { x: 10, y: 10 } }).catch(() => page.keyboard.press('Escape'))

    // ③ forsion:// 链接
    const l1 = await followLink(`forsion://space/${GUIDE}`, GUIDE)
    check(l1.on === GUIDE && l1.ms < 1500, '③ 页内 forsion:// 链接在应用内切到指南 Space,< 1.5s', `${l1.on} ${l1.ms}ms`)
    if (l1.on !== GUIDE) throw new Error('没进指南 Space,后面问不了')
    await page.waitForTimeout(1500)

    // ④ 章节树 + 阅读页。App 里原生底栏在场 → 两级导航(先列表,listFirstNow,所有带左栏的 Space 同一条);
    //    浏览器里没有原生宿主 → 抽屉形态:主区是阅读页,章节树在左抽屉。两种都认,哪种记进结果。
    const nav = await page.locator('.mb-shell').getAttribute('data-nav')
    check(await page.locator('.fxg-reader').first().isVisible().catch(() => false) || nav === 'list', '④ 进指南 Space:主区是只读阅读页', `data-nav=${nav}`)
    await shot('3-guide-reader-first')
    if (nav !== 'list') await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
    const tree = page.locator(nav === 'list' ? '.mb-shell' : '.mb-drawer--left.open').getByText('写下第一篇笔记', { exact: true })
    check(await tree.first().isVisible().catch(() => false), `④ 章节树在${nav === 'list' ? '列表层' : '左抽屉'}里`)
    await shot('4-guide-chapters')
    await tap(tree, '章节「写下第一篇笔记」')
    await page.waitForTimeout(800)
    const goBtn = page.locator('.fxg-task[data-task="note-link"] .fxg-go')
    const drawerLeft = await page.locator('.mb-drawer--left.open').count()
    check(drawerLeft === 0 && await goBtn.isVisible().catch(() => false), '④ 点章节 → 回到阅读页(正文 + 本章任务,没做完的有「带我去」)', `左抽屉开着=${drawerLeft}`)
    check((await page.locator('.fxg-task[data-task="note-create"] .fxg-task-state').innerText().catch(() => '')).trim() === '已完成', '④ 做过的任务写「已完成」')
    await shot('5-guide-reader')
    await tap(page.locator('.mb-topbar [aria-label="right panel"]'), '右栏')
    check(await page.locator('.mb-drawer--right.open .fxg-side').isVisible().catch(() => false), '④ 右栏「进度 / 问 Tangu」在右抽屉')
    await shot('6-guide-side')
    await tap(page.locator('.mb-drawer--right.open [aria-label="close"]'), '收右栏') // 抽屉开着时盖住顶栏那颗钮
    await page.waitForTimeout(400)

    // ⑤ 带我去 → 目标 Space;伴读在右抽屉里,不自己弹开
    await tap(goBtn, '带我去')
    await page.waitForTimeout(1200)
    const there = await space()
    const drawerOpen = await page.locator('.mb-drawer--right.open').count()
    check(there === 'amadeus' && drawerOpen === 0, '⑤ 「带我去」切到笔记 Space,右抽屉不自己弹开', `${there} drawerOpen=${drawerOpen}`)
    await shot('7-go-target')
    await tap(page.locator('.mb-topbar [aria-label="right panel"]'), '右栏')
    check(await page.locator('.mb-drawer--right.open .fxg-companion [data-task="note-link"]').isVisible().catch(() => false), '⑤ 伴读(本章任务)挂在目标 Space 的右抽屉里')
    await shot('8-companion')

    // ⑥ 电脑上才能做的:Lv.3 都做完(补上那一条)→ Lv.4 解锁,任务写「在电脑上做」
    await page.evaluate((k) => { const d = JSON.parse(localStorage.getItem(k)); d.counters['note.wikilink'] = 1; d.counters['space.switch'] = Math.max(1, d.counters['space.switch'] || 0); localStorage.setItem(k, JSON.stringify(d)) }, ACH_KEY)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await boot()
    const l2 = await followLink(`forsion://space/${GUIDE}`, GUIDE)
    check(l2.on === GUIDE && l2.ms < 1500, '③ 冷启动之后再点一次,同样 < 1.5s', `${l2.on} ${l2.ms}ms`)
    await page.waitForTimeout(1500)
    const listNow = await page.locator('.mb-shell').getAttribute('data-nav')
    if (listNow !== 'list') await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '回章节列表')
    await tap(page.getByText('让 Tangu 操作电脑', { exact: true }), '章节「让 Tangu 操作电脑」')
    await page.waitForTimeout(800)
    const cu = page.locator('.fxg-task[data-task="cu-use"]')
    const cuState = (await cu.locator('.fxg-task-state').innerText().catch(() => '')).trim()
    check(cuState === '在电脑上做' && await cu.locator('.fxg-go').count() === 0, '⑥ 电脑上才能做的任务:写「在电脑上做」,没有「带我去」', cuState)
    await cu.scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(300)
    await shot('9-desktop-only')

    check(!errors.length, '页面没有未捕获错误', errors.slice(0, 3).join(' / '))

    // ⑦ 负对照:没有可领的成就 → 没有红点
    const { page: p2 } = await newCtx(null)
    await p2.goto(preview.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await p2.waitForSelector('.mb-topbar [aria-label="more"]', { timeout: 30_000 })
    await p2.waitForTimeout(2500)
    check(await p2.locator('.mb-topbar [aria-label="more"] .rb-dot').count() === 0, '⑦ 负对照:没有可领的成就 →「⋯」上没有红点')
  } finally {
    await browser?.close().catch(() => {})
    preview.kill()
  }
  console.log(fails.length ? `\n✗ ${fails.length} 项失败` : '\n✓ 全部通过')
  console.log(`截图:${SHOTS}`)
  process.exit(fails.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
