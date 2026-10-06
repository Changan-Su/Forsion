/**
 * 设置 ·「电脑历史」页:真组件 + 生产 CSS,Chromium 里点一遍(桩 window.tangu.computerHistory,不连 helper)。
 * 覆盖:各状态 × 深浅色 × zh/en 无横向溢出、开启前同意确认(开关保持关)、窄栏;
 *   同意条 / 清除确认的正文与标题对比度 ≥ 4.5(五套配色 × 深浅色,底色逐层按 alpha 合成);
 *   helper_missing 版式(刷新在首张面板状态行、权限卡是同页面板且左缘对齐、不给暂停);面板头动作与行内控件同一右缘;添加按钮与输入框等高;
 *   Windows 版(?platform=win32):不挂权限卡、刷新照给,中英 × 宽窄无横向溢出。
 * Run: npm run check:computerhistory   (worktree 里加 HARNESS_URL=http://localhost:<port>/harness.html;--shot 留截图)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const baseUrl = new URL(process.env.HARNESS_URL || 'http://localhost:5173/harness.html')
baseUrl.pathname = '/computer-history-harness.html'
const base = baseUrl.toString()
const out = path.join(os.tmpdir(), 'forsion-computer-history-settings')
fs.mkdirSync(out, { recursive: true })
let pass = 0, fail = 0
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, JSON.stringify(detail)) } }

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 1400 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()) })
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`) })
  const open = async (query) => {
    await page.goto(`${base}?${query}`)
    await page.locator('.ch-page').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(400)
  }
  /** 文字对合成后底色的对比度(同 computer-history.e2e.cjs 的 contrastOf):颜色经 1×1 canvas 归一,底色从 <html> 往下按 alpha 合成。 */
  const contrastOf = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const cv = document.createElement('canvas')
    cv.width = cv.height = 1
    const x = cv.getContext('2d', { willReadFrequently: true })
    const rgba = (c) => { x.clearRect(0, 0, 1, 1); x.fillStyle = '#000'; x.fillStyle = c; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
    const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]))
    const chain = []
    for (let e = el; e; e = e.parentElement) chain.unshift(e)
    let bg = [255, 255, 255]
    for (const e of chain) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) bg = over(c, bg) }
    const fg = over(rgba(getComputedStyle(el).color), bg)
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
    const [a, b] = [lum(fg), lum(bg)].sort((p, q) => q - p)
    return { ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100, fg: fg.map(Math.round), bg: bg.map(Math.round) }
  }, sel)
  const rect = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, height: r.height } }, sel)
  const overflow = () => page.evaluate(() => {
    const bad = []
    const vw = document.documentElement.clientWidth
    for (const el of document.querySelectorAll('.ch-page *')) {
      const r = el.getBoundingClientRect()
      if (r.width && r.right > vw + 0.5) bad.push(`${el.className || el.tagName}:${Math.round(r.right)}`)
    }
    return { scroll: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 5) }
  })

  for (const [name, query] of [
    ['light-recording', 'status=recording'],
    ['dark-recording', 'status=recording&dark'],
    ['light-no-permission', 'status=no_permission'],
    ['dark-no-permission', 'status=no_permission&dark'],
    ['light-helper-missing', 'status=helper_missing'],
    ['dark-helper-missing', 'status=helper_missing&dark'],
    ['dark-en-outdated', 'status=helper_outdated&dark&lang=en'],
    ['light-en-recording', 'status=recording&lang=en'],
    ['win-en-recording', 'status=recording&lang=en&platform=win32'],
    ['win-helper-missing-dark', 'status=helper_missing&dark&platform=win32'],
  ]) {
    await open(query)
    await page.locator('.ch-page').screenshot({ path: path.join(out, `${name}.png`) })
    const o = await overflow()
    check(`${name} 无横向溢出`, o.scroll <= o.vw && o.bad.length === 0, o)
  }

  // 开启前的同意确认(深浅色)截图
  for (const [name, query] of [['light-consent', 'status=off&empty'], ['dark-consent', 'status=off&empty&dark']]) {
    await open(query)
    await page.locator('[role="switch"]').first().click()
    await page.locator('.ch-confirm--consent').waitFor()
    await page.locator('.ch-page').screenshot({ path: path.join(out, `${name}.png`) })
    check(`${name} 确认条出现且开关仍关`, await page.locator('[role="switch"]').first().getAttribute('aria-checked') === 'false', null)
  }
  // 同意条 / 清除确认:正文(11px)与标题对比度 ≥ 4.5,五套配色 × 深浅色(暗色经典配色的 accent-light 曾把正文压到 3.07)
  for (const skin of ['cream', 'coral', 'teal', 'lavender', 'zhi']) {
    for (const dark of [false, true]) {
      const tag = `${skin}-${dark ? 'dark' : 'light'}`
      await open(`status=off&empty&skin=${skin}${dark ? '&dark' : ''}`)
      await page.locator('[role="switch"]').first().click()
      await page.locator('.ch-confirm--consent').waitFor()
      for (const part of ['p', 'strong']) {
        const c = await contrastOf(`.ch-confirm--consent ${part}`)
        check(`[${tag}] 同意条 ${part} 对比度 ≥ 4.5`, !!c && c.ratio >= 4.5, c)
      }
      await open(`status=recording&skin=${skin}${dark ? '&dark' : ''}`)
      await page.locator('[data-clear="all"]').click()
      await page.locator('.ch-confirm').waitFor()
      if (skin === 'cream' && dark) await page.locator('.ch-confirm').screenshot({ path: path.join(out, 'dark-clear-confirm.png') })
      for (const part of ['p', 'strong']) {
        const c = await contrastOf(`.ch-confirm:not(.ch-confirm--consent) ${part}`)
        check(`[${tag}] 清除确认 ${part} 对比度 ≥ 4.5`, !!c && c.ratio >= 4.5, c)
      }
    }
  }

  // 版式:面板头动作(开关)与行内控件(暂停按钮)同一右缘;添加按钮与输入框等高
  await open('status=recording')
  {
    const sw = await rect('.ch-page [role="switch"]')
    const pause = await page.evaluate(() => { const bs = [...document.querySelectorAll('.ch-page .ch-btn-row .btn')]; const r = bs.at(-1)?.getBoundingClientRect(); return r ? { right: r.right } : null })
    check('开关与暂停按钮右缘对齐(±1px)', !!sw && !!pause && Math.abs(sw.right - pause.right) <= 1, { sw, pause })
    const reveal = await page.evaluate(() => { const b = document.querySelectorAll('.ch-page .settings-panel-head .settings-panel-actions .btn')[0]; const p = b?.closest('.settings-panel'); if (!b || !p) return null; return { gap: p.getBoundingClientRect().right - b.getBoundingClientRect().right } })
    const rowGap = await page.evaluate(() => { const b = document.querySelector('.ch-page .ch-btn-row .btn:last-child'); const p = b?.closest('.settings-panel'); if (!b || !p) return null; return p.getBoundingClientRect().right - b.getBoundingClientRect().right })
    check('面板头按钮与行内控件到面板右缘距离一致', !!reveal && rowGap !== null && Math.abs(reveal.gap - rowGap) <= 1, { head: reveal, row: rowGap })
    for (const form of ['app', 'site']) {
      const h = await page.evaluate((f) => { const el = document.querySelector(`[data-ch-add="${f}"]`); const i = el?.querySelector('input')?.getBoundingClientRect(); const b = el?.querySelector('button')?.getBoundingClientRect(); return i && b ? { input: i.height, button: b.height, dTop: Math.abs(i.top - b.top) } : null }, form)
      check(`添加行(${form}):按钮与输入框等高、顶对齐`, !!h && Math.abs(h.input - h.button) <= 0.5 && h.dTop <= 0.5, h)
    }
  }

  // helper_missing:刷新挂在首张面板状态行;权限卡 = 同页面板(有描边、头与首张面板左缘对齐、行控件右缘对齐);不给暂停
  for (const dark of [false, true]) {
    await open(`status=helper_missing${dark ? '&dark' : ''}`)
    await page.locator('.ch-permission [data-permission="computerAccessibility"]').waitFor()
    const tag = `helper-missing-${dark ? 'dark' : 'light'}`
    const layout = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('.ch-page .settings-panel')]
      const refresh = document.querySelector('[data-ch-refresh-status]')
      const card = document.querySelector('.ch-page .ch-permission')
      const cardBtn = card?.querySelector('[data-permission] .btn')
      const headL = (p) => p?.querySelector('.settings-panel-head')?.getBoundingClientRect().left
      const copyL = (p) => p?.querySelector('.settings-panel-head .settings-panel-icon')?.getBoundingClientRect().left
      const cs = card ? getComputedStyle(card) : null
      return {
        refreshInFirstPanel: !!refresh && !!panels[0]?.contains(refresh) && !!refresh.closest('.settings-control-row'),
        cardIsPanel: !!card?.classList.contains('settings-panel'),
        cardBorder: cs ? parseFloat(cs.borderTopWidth) : 0,
        cardRadius: cs?.borderTopLeftRadius, firstRadius: panels[0] ? getComputedStyle(panels[0]).borderTopLeftRadius : null,
        headLeft: [headL(panels[0]), headL(card)], iconLeft: [copyL(panels[0]), copyL(card)],
        rowRight: [refresh?.getBoundingClientRect().right, cardBtn?.getBoundingClientRect().right],
        rowLeft: [panels[0]?.querySelector('.settings-control-row .settings-control-copy')?.getBoundingClientRect().left, card?.querySelector('.desktop-permissions-copy')?.getBoundingClientRect().left],
        pauseRow: !!document.querySelector('.ch-page .ch-btn-row'),
        toolbar: !!card?.querySelector('.desktop-permissions-toolbar'),
      }
    })
    check(`[${tag}] 刷新状态在首张面板的状态行`, layout.refreshInFirstPanel, layout)
    check(`[${tag}] 权限卡是 .settings-panel、有描边、圆角同首张面板`, layout.cardIsPanel && layout.cardBorder > 0 && layout.cardRadius === layout.firstRadius, layout)
    check(`[${tag}] 权限卡头 / 图标与首张面板左缘对齐`, Math.abs(layout.headLeft[0] - layout.headLeft[1]) <= 0.5 && Math.abs(layout.iconLeft[0] - layout.iconLeft[1]) <= 0.5, layout)
    check(`[${tag}] 权限行文字左缘与状态行对齐、按钮右缘与刷新按钮对齐`, Math.abs(layout.rowLeft[0] - layout.rowLeft[1]) <= 0.5 && Math.abs(layout.rowRight[0] - layout.rowRight[1]) <= 0.5, layout)
    check(`[${tag}] 不给暂停、卡上没有自带工具条`, !layout.pauseRow && !layout.toolbar, layout)
  }

  // Windows:没有要授的权限、没有单独安装的助手 —— 缺 / 旧组件不挂权限卡,刷新照样在首张面板状态行
  for (const st of ['helper_missing', 'helper_outdated']) {
    await open(`status=${st}&platform=win32`)
    const w = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('.ch-page .settings-panel')]
      const refresh = document.querySelector('[data-ch-refresh-status]')
      return { card: !!document.querySelector('.ch-page .ch-permission, .ch-page [data-permission]'), refreshInFirstPanel: !!refresh && !!panels[0]?.contains(refresh) }
    })
    check(`[win-${st}] 不挂权限卡、刷新在首张面板`, !w.card && w.refreshInFirstPanel, w)
  }

  // 窄栏(≈ 设置浮窗最窄 / 手机宽)
  await page.setViewportSize({ width: 420, height: 1600 })
  for (const [name, query] of [['narrow-recording', 'status=recording'], ['narrow-no-permission-dark', 'status=no_permission&dark'], ['narrow-win-en-recording', 'status=recording&lang=en&platform=win32']]) {
    await open(query)
    await page.locator('.ch-page').screenshot({ path: path.join(out, `${name}.png`) })
    const o = await overflow()
    check(`${name} 无横向溢出`, o.scroll <= o.vw && o.bad.length === 0, o)
  }
  check('无页面错误', errors.length === 0, errors)
  await browser.close()
  console.log(`${pass} passed / ${fail} failed; SHOT ${out}`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
