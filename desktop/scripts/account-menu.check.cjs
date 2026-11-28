/**
 * 账号菜单(AccountCard)落位仪器:方向和限高都交给 OverlayAt(锚点跟随 + boundary 封顶),不许自己拿 innerHeight 算
 * (lcl/engine/overlayPlacement.guard.test.ts)。真 Chromium + 真 Ribbon + 真 AccountCard,账号是桩:
 *   harness.html?ribbon&unit&unitpanel(桌面 Unit 版)/ &many(20 台,考封顶只滚 Unit 列表)/ &web(网页主入口,没有 Unit 段)
 *
 * 判据(视口 px,高 720 / 520 / 647 / 651 / 633 × 缩放 1 / 1.1 / 1.25):
 *   B 底部头像(侧栏完整卡 / Ribbon 收起):往上开、整张在 [8, vh-8] 里、不压头像、账号头与最后一行看得见;20 台时只滚 Unit 列表
 *   T 窗口顶部锚点(Chat 头像资料卡点「账号」= forsion:account-activate + detail.anchor):往下开、不出窗、不压锚点
 *   C 窗口中部锚点:不出窗、不压锚点(110% 下浮点尾数曾让「刚好放得下」判成两侧都放不下、夹住压锚点)
 *   R 开着菜单把窗口 600 → 830 → 520:面板跟着头像走,不按打开那一刻的坐标翻到下方压住挪过去的头像
 *   M 真网页手机壳(?ui=mobile,390×844 触屏 + 844×390 横屏)左抽屉底部的账号卡:往上开、不出窗、不压头像
 * 负对照(2026-11-28 实跑):AccountCard 去掉 boundary → 20 台那档全红;menuAnchor 回到严格比较 → 700 高 110% 的 C 红。
 * 截图(B / T / M)落到 ACCOUNT_MENU_SHOT_DIR(缺省系统临时目录)。
 *
 * 跑:npm run check:accountmenu(HARNESS_URL 指向本检出起的 vite;没起就在 5173 自起,跑完自收)
 *    ACCOUNT_MENU_ONLY=many 只跑某一档;ACCOUNT_MENU_SIZES='[[700,1.1]]' 只跑这些尺寸
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:5173/harness.html'
const ORIGIN = new URL(BASE).origin
const SHOTS = process.env.ACCOUNT_MENU_SHOT_DIR || os.tmpdir()
const ONLY = process.env.ACCOUNT_MENU_ONLY
const SIZES = process.env.ACCOUNT_MENU_SIZES ? JSON.parse(process.env.ACCOUNT_MENU_SIZES) : [[720, 1], [520, 1], [720, 1.1], [520, 1.1], [647, 1.1], [651, 1.1], [633, 1.25]]

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  | ' + detail}`) }

const geo = (page, anchorSel) => page.evaluate((sel) => {
  const pop = document.querySelector('.account-pop:not([data-lcl-exit])')
  const a = document.querySelector(sel)
  if (!pop || !a) return null
  const p = pop.getBoundingClientRect(), r = a.getBoundingClientRect()
  const items = Array.from(pop.querySelectorAll('.ap-item'))
  const last = items[items.length - 1]?.getBoundingClientRect()
  const head = pop.querySelector('.ap-head')?.getBoundingClientRect()
  const list = pop.querySelector('.ap-units-list'), body = pop.querySelector('.ap-body')
  return {
    top: +p.top.toFixed(1), bottom: +p.bottom.toFixed(1), left: +p.left.toFixed(1), right: +p.right.toFixed(1),
    vw: innerWidth, vh: innerHeight, aTop: +r.top.toFixed(1), aBottom: +r.bottom.toFixed(1),
    units: pop.classList.contains('account-pop--units'),
    lastVisible: !!last && last.top >= p.top - 0.5 && last.bottom <= p.bottom + 0.5,
    headVisible: !!head && head.top >= p.top - 0.5 && head.bottom <= p.bottom + 0.5,
    listScrolls: !!list && list.scrollHeight > list.clientHeight + 1,
    bodyScrolls: !!body && body.scrollHeight > body.clientHeight + 1,
  }
}, anchorSel)
const inView = (g) => g && g.top >= 8 - 0.6 && g.bottom <= g.vh - 8 + 0.6 && g.left >= 0 && g.right <= g.vw + 0.5
const clearOf = (g) => g && (g.bottom <= g.aTop + 0.6 || g.top >= g.aBottom - 0.6)

async function boot(page, extra, expanded) {
  await page.goto(`${ORIGIN}/harness.html?ribbon&unit&unitpanel${extra}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.rb-bottom .unitsw-pill', { timeout: 90000 })
  await page.evaluate((e) => { window.__rb.setState({ expanded: e }) }, expanded)
  await page.waitForSelector(expanded ? '.account-card' : '.ribbon-account', { timeout: 10000 })
  await page.waitForFunction(() => !!document.querySelector('.account-card .account-name, .ribbon-account .account-avatar') && !/登录|Sign in/.test(document.querySelector('.account-card .account-name')?.textContent ?? 'x'), null, { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(150)
}
async function waitPop(page) {
  await page.waitForSelector('.account-pop', { timeout: 5000 })
  await page.waitForFunction(() => document.querySelectorAll('.account-pop .ap-item').length >= 3, null, { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500) // 液滴流出 + 额度回来
}
async function closePop(page) {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.account-pop:not([data-lcl-exit])'), null, { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(400)
}
/** 在 (left, top) 放一枚假头像,发 Chat 资料卡那条事件 */
async function openAt(page, top) {
  await page.evaluate((t) => {
    let el = document.getElementById('probe-anchor')
    if (!el) { el = document.createElement('button'); el.id = 'probe-anchor'; document.body.appendChild(el) }
    Object.assign(el.style, { position: 'fixed', left: '420px', top: `${t}px`, width: '32px', height: '32px', borderRadius: '50%', background: '#c9a', zIndex: 5 })
    window.dispatchEvent(new CustomEvent('forsion:account-activate', { cancelable: true, detail: { anchor: el } }))
  }, top)
  await waitPop(page)
}

;(async () => {
  let vite = null
  if (!(await ping())) {
    const viteEntry = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js')
    const port = new URL(BASE).port || '5173'
    vite = spawn(process.execPath, [viteEntry, 'frontend', '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore', windowsHide: true })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来(端口被占着、又不是本检出的台架?)')
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 720 } })
    page.on('pageerror', (e) => { if (!/excalidraw/.test(e.message)) console.log('[pageerror]', e.message) })
    await page.addInitScript(() => localStorage.clear())
    for (const [variant, extra] of [['Unit 版', ''], ['Unit 版 · 20 台', '&many'], ['网页版', '&web']].filter(([, e]) => !ONLY || e === `&${ONLY}`)) {
      for (const [h, z] of SIZES) {
        await page.setViewportSize({ width: 1200, height: h })
        for (const expanded of [true, false]) {
          await boot(page, extra, expanded)
          if (z !== 1) { await page.evaluate((v) => { document.body.style.zoom = String(v); window.dispatchEvent(new Event('forsion:uizoom')) }, z); await page.waitForTimeout(150) }
          const tag = `${variant} 1200×${h} 缩放 ${z}`
          // B 底部头像
          await page.click(expanded ? '.account-card' : '.ribbon-account')
          await waitPop(page)
          const b = await geo(page, expanded ? '.account-card' : '.ribbon-account')
          check(`B 底部头像${expanded ? '(侧栏)' : '(收起)'}往上开、不出窗、不压头像 · ${tag}`, inView(b) && b.bottom <= b.aTop + 0.6 && b.lastVisible && b.headVisible, JSON.stringify(b))
          if (extra === '&many') check(`B 20 台只滚 Unit 列表 · ${tag}${expanded ? '' : ' 收起'}`, b.listScrolls && !b.bodyScrolls, JSON.stringify(b))
          if (expanded && h === 720 && z === 1) await page.screenshot({ path: path.join(SHOTS, `B-${variant.replace(/[ ·]/g, '')}.png`) })
          await closePop(page)
          if (!expanded) continue
          // T 顶部锚点(Chat 资料卡)
          await openAt(page, 40)
          const t = await geo(page, '#probe-anchor')
          check(`T 顶部锚点往下开、不出窗、不压锚点 · ${tag}`, inView(t) && t.top >= t.aBottom - 0.6 && t.lastVisible && t.headVisible, JSON.stringify(t))
          if (extra === '&many') check(`T 20 台封顶只滚 Unit 列表 · ${tag}`, t.listScrolls && !t.bodyScrolls, JSON.stringify(t))
          if (h === 720 && z === 1) await page.screenshot({ path: path.join(SHOTS, `T-${variant.replace(/[ ·]/g, '')}.png`) })
          await closePop(page)
          // C 中部锚点
          await openAt(page, Math.round(h / 2 - 16))
          const c = await geo(page, '#probe-anchor')
          check(`C 中部锚点不出窗、不压锚点 · ${tag}`, inView(c) && clearOf(c) && c.lastVisible && c.headVisible, JSON.stringify(c))
          await closePop(page)
        }
      }
    }
    // R 开着菜单拉高窗口(Codex 评审 P2):头像跟着窗口底挪,面板要跟过去,不许按旧坐标翻到下方压住新头像
    for (const [variant, extra] of [['网页版', '&web'], ['Unit 版', '']]) {
      await page.setViewportSize({ width: 1200, height: 600 })
      await boot(page, extra, true)
      await page.click('.account-card'); await waitPop(page)
      const before = await geo(page, '.account-card')
      await page.setViewportSize({ width: 1200, height: 830 })
      await page.waitForTimeout(400)
      const after = await geo(page, '.account-card')
      check(`R ${variant} 开着菜单 600→830 拉高:跟着头像、不出窗、不压头像`, inView(after) && after.bottom <= after.aTop + 0.6 && after.aTop > before.aTop + 100, JSON.stringify({ before: [before.top, before.bottom, before.aTop], after }))
      await page.setViewportSize({ width: 1200, height: 520 })
      await page.waitForTimeout(400)
      const shrunk = await geo(page, '.account-card')
      check(`R ${variant} 再缩到 520:不出窗、不压头像`, inView(shrunk) && shrunk.bottom <= shrunk.aTop + 0.6, JSON.stringify(shrunk))
      await closePop(page)
    }
    // X 开着菜单切 Ribbon 展开态(锚点节点被换掉):菜单收起,不留「看不见但还开着」;点新头像一下就开(Codex 评审)
    await page.setViewportSize({ width: 1200, height: 720 })
    await boot(page, '&web', true)
    await page.click('.account-card'); await waitPop(page)
    await page.evaluate(() => { window.__rb.setState({ expanded: false }) })
    await page.waitForSelector('.ribbon-account', { timeout: 5000 })
    await page.waitForTimeout(500)
    const stale = await page.evaluate(() => !!document.querySelector('.account-pop:not([data-lcl-exit])'))
    check('X 锚点被换掉(切 Ribbon 展开态)→ 菜单收起', !stale, 'still open (hidden)')
    await page.click('.ribbon-account'); await waitPop(page)
    const x = await geo(page, '.ribbon-account')
    const hidden = await page.evaluate(() => document.querySelector('.account-pop:not([data-lcl-exit])')?.hasAttribute('data-anchor-hidden') ?? true)
    check('X 点新头像一下就开、看得见、不压头像', !!x && !hidden && inView(x) && x.bottom <= x.aTop + 0.6, JSON.stringify({ x, hidden }))
    await closePop(page)
    await page.close()
    if (ONLY) throw Object.assign(new Error('only'), { only: true })

    // ── 真网页手机壳:左抽屉底部的账号卡 ──
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })
    await ctx.addInitScript(() => {
      try { localStorage.setItem('forsion_token', 'probe'); localStorage.setItem('lcl.uiMode', 'mobile') } catch { /* ignore */ }
      const stub = {
        authStatus: async () => ({ loggedIn: true, tokenValid: true, cloudUrl: 'https://cloud.test', tokenSource: 'tangu-login', username: 'Lin', nickname: '林一' }),
        authAccounts: async () => [{ id: 'lin', cloudUrl: 'https://cloud.test', username: 'Lin', active: true }, { id: 'bob', cloudUrl: 'https://cloud.test', username: 'Bob', active: false }],
        forsionLogin: async () => { throw new Error('probe') },
        forsionLogout: async () => ({ ok: true }),
        accountQuota: async () => ({ status: 200, json: { dailyPercent: 28, weeklyPercent: 28, dailyLimit: 100, weeklyLimit: 500, weeklyResetAt: '2026-11-16' } }),
      }
      window.__probeStub = stub
      window.tangu = Object.assign(window.tangu || {}, stub)
    })
    const m = await ctx.newPage()
    m.on('pageerror', (e) => { if (!/excalidraw/.test(e.message)) console.log('[m pageerror]', e.message) })
    await m.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"probe"}' }))
    await m.goto(`${ORIGIN}/?ui=mobile`, { waitUntil: 'domcontentloaded' })
    await m.waitForSelector('.mb-shell', { timeout: 90000 })
    await m.waitForTimeout(2500)
    const hasStub = await m.evaluate(() => !!window.tangu?.authStatus)
    await m.click('.mb-topbar .mb-icon-btn')
    await m.waitForSelector('.mb-drawer-foot', { timeout: 8000 }).catch(() => {})
    await m.waitForTimeout(800)
    const card = await m.$('.mb-drawer-foot .account-card')
    check('M 手机抽屉底部有账号卡', !!card, JSON.stringify({ hasStub }))
    if (card) {
      await m.waitForFunction(() => !/登录|Sign in/.test(document.querySelector('.mb-drawer-foot .account-card .account-name')?.textContent ?? 'x'), null, { timeout: 8000 }).catch(() => {})
      await card.click()
      await waitPop(m)
      const g = await geo(m, '.mb-drawer-foot .account-card')
      const zoom = await m.evaluate(() => document.querySelector('.account-pop')?.currentCSSZoom ?? 1)
      check('M 手机抽屉:往上开、不出窗、不压头像、退出登录看得见', inView(g) && g.bottom <= g.aTop + 0.6 && g.lastVisible && g.headVisible, JSON.stringify({ ...g, zoom }))
      await m.screenshot({ path: path.join(SHOTS, 'M-drawer.png') })
      await closePop(m)
      // 横屏矮窗:844×390
      await m.setViewportSize({ width: 844, height: 390 })
      await m.waitForTimeout(800)
      const card2 = await m.$('.account-card')
      if (card2 && await card2.isVisible()) {
        await card2.click(); await waitPop(m)
        const g2 = await geo(m, '.account-card')
        check('M 横屏 844×390:不出窗、不压头像', inView(g2) && clearOf(g2), JSON.stringify(g2))
        await m.screenshot({ path: path.join(SHOTS, 'M-landscape.png') })
        await closePop(m)
      } else console.log('SKIP  横屏下账号卡不可见')
    }
    await ctx.close()
  } catch (e) { if (!e.only) throw e } finally { await browser.close(); vite?.kill() }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} PASS`)
  process.exit(bad.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
