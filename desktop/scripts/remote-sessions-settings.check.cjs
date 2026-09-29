/**
 * 设置 ·「远程会话」页(P1 · K4):真组件 + 生产 CSS,Chromium 里点一遍(桩 window.tangu.remoteSessions,不连主进程)。
 * 覆盖:各状态 × 深浅色 × zh/en 无横向溢出、长设备名省略不撑宽;父开关关 / 设备凭据未加密时开关置灰;
 *   「本账号的浏览器与网页版」三态(已允许 → 撤销 = 严格档 → 在这里允许;还没允许;本机没登录)—— 评审 P1/P2;
 *   选全自动先就地确认(没勾「我了解风险」不写)、确认后常驻警示;警示 / 确认条正文对比度 ≥ 4.5(深浅色);窄栏三档变单列。
 * 截图落 $TMPDIR/forsion-remote-sessions-settings/*.png(交付前自己看)。
 * Run: node scripts/e2e-editor.cjs --check=remote-sessions-settings   (worktree 里加 HARNESS_URL=http://localhost:<port>/harness.html)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const file = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(file)) return file
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const baseUrl = new URL(process.env.HARNESS_URL || 'http://localhost:5173/harness.html')
baseUrl.pathname = '/remote-sessions-harness.html'
const base = baseUrl.toString()
const out = process.env.RS_SHOT_DIR || path.join(os.tmpdir(), 'forsion-remote-sessions-settings')
fs.mkdirSync(out, { recursive: true })
let pass = 0, fail = 0
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, JSON.stringify(detail)) } }

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 1300 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()) })
  const open = async (query) => {
    await page.goto(`${base}?${query}`)
    await page.locator('.rs-page').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(300)
  }
  const overflow = () => page.evaluate(() => {
    const bad = []
    const vw = document.documentElement.clientWidth
    for (const el of document.querySelectorAll('.rs-page *')) {
      const r = el.getBoundingClientRect()
      if (r.width && r.right > vw + 0.5) bad.push(`${el.className || el.tagName}:${Math.round(r.right)}`)
    }
    return { scroll: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 5) }
  })
  /** 文字对合成后底色的对比度(同 computer-history-settings.check 的算法)。 */
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
    return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100
  }, sel)

  for (const [name, query] of [
    ['light-on', 'state=on'], ['dark-on', 'state=on&dark'],
    ['light-on-en', 'state=on&lang=en'], ['dark-on-en', 'state=on&dark&lang=en'],
    ['light-nohost', 'state=nohost'], ['light-insecure', 'state=insecure'], ['dark-insecure-en', 'state=insecure&dark&lang=en'],
    ['light-fullauto', 'state=fullauto'], ['dark-fullauto', 'state=fullauto&dark'], ['light-fullauto-en', 'state=fullauto&lang=en'],
    ['light-empty', 'state=empty'], ['light-off', 'state=off'],
    ['light-strict', 'state=strict'], ['dark-strict', 'state=strict&dark'], ['light-strict-en', 'state=strict&lang=en'], ['dark-strict-en', 'state=strict&dark&lang=en'],
    ['light-empty-en', 'state=empty&lang=en'], ['light-signedout', 'state=signedout'], ['dark-signedout-en', 'state=signedout&dark&lang=en'],
  ]) {
    await open(query)
    const o = await overflow()
    check(`${name}: 无横向溢出`, o.scroll <= o.vw && o.bad.length === 0, o)
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true })
    if (query.includes('lang=en')) {
      const han = await page.evaluate(() => /[一-鿿]/.test(document.querySelector('.rs-page').textContent.replace(/小米[^·]*·[^（]*（[^）]*）/g, '')))
      check(`${name}: 英文界面没有汉字漏出(设备名是数据,除外)`, !han)
    }
  }

  // 置灰:父开关关 / 设备凭据未加密
  await open('state=nohost')
  check('父开关关:开关置灰 + 提示先开「允许其他设备连接本机」', await page.locator('[data-setting-anchor="remote-sessions-switch"] [role="switch"]').isDisabled()
    && (await page.locator('[data-rs-need-host]').textContent()).includes('允许其他设备连接本机'))
  await open('state=insecure')
  check('设备凭据未加密:开关显示关且置灰,挂 K5 提示', await page.locator('[data-setting-anchor="remote-sessions-switch"] [role="switch"]').isDisabled()
    && (await page.locator('[data-setting-anchor="remote-sessions-switch"] [role="switch"]').getAttribute('aria-checked')) === 'false'
    && (await page.locator('[data-secrets="plaintext"]').count()) === 1)

  // 「本账号的浏览器与网页版」:撤销 → 严格档行(写明不再弹框)+「允许」→ 回到已允许(评审 P1:撤销 = D8 严格档,不是「下次再弹」)
  await open('state=on')
  await page.locator('[data-rs-revoke="account"]').click()
  await page.locator('[data-rs-allow-account="strict"]').waitFor({ timeout: 3000 })
  const strictText = await page.locator('[data-setting-anchor="remote-trusted-devices"]').textContent()
  check('撤销账号条目 → 严格档行:写明只能查看 / 答审批 / 停止、不再弹框,可在这里允许', strictText.includes('已撤销') && strictText.includes('不会再弹框询问')
    && (await page.evaluate(() => window.__rs.view().accountEntry)) === 'strict', strictText)
  const rowGeo = await page.evaluate(() => {
    const btn = document.querySelector('[data-rs-allow-account]').getBoundingClientRect()
    const rev = document.querySelector('[data-rs-revoke]').getBoundingClientRect()
    return { btnRight: Math.round(btn.right), revRight: Math.round(rev.right) }
  })
  check('「允许」与设备行的「撤销」同一右缘', Math.abs(rowGeo.btnRight - rowGeo.revRight) <= 1, rowGeo)
  await page.locator('[data-rs-allow-account]').click()
  await page.locator('[data-rs-revoke="account"]').waitFor({ timeout: 3000 })
  check('在设置里点「允许」→ 回到已允许(撤销键回来)', (await page.evaluate(() => window.__rs.view().accountEntry)) === 'trusted')
  await open('state=empty')
  check('还没允许:账号行带「允许」,说明写 P2P 只能在这里允许', (await page.locator('[data-rs-allow-account="none"]').count()) === 1
    && (await page.locator('[data-setting-anchor="remote-trusted-devices"]').textContent()).includes('P2P 连接不会弹框'))
  await open('state=signedout')
  check('本机没登录:不画账号行,如实说明', (await page.locator('[data-rs-allow-account]').count()) === 0 && (await page.locator('[data-rs-signed-out]').count()) === 1)

  // 长设备名(窄栏里放不下):省略号,不撑宽
  await page.setViewportSize({ width: 520, height: 1300 })
  await open('state=on&width=520')
  const nameBox = await page.evaluate(() => { const el = document.querySelector('.rs-name'); el.textContent = el.textContent.repeat(4); const r = el.getBoundingClientRect(); return { sw: el.scrollWidth, cw: el.clientWidth, right: r.right, vw: document.documentElement.clientWidth } })
  check('长设备名省略(scrollWidth > clientWidth)且不越界', nameBox.sw > nameBox.cw && nameBox.right <= nameBox.vw, nameBox)
  await page.setViewportSize({ width: 900, height: 1300 })

  // 全自动:就地确认
  for (const dark of [false, true]) {
    await open(`state=on${dark ? '&dark' : ''}`)
    await page.locator('[data-cap="full-auto"]').click()
    const confirmBtn = page.locator('[data-rs-fullauto-confirm] .btn.danger')
    check(`${dark ? 'dark' : 'light'} 选全自动:出确认条、确认键未勾选前禁用、审批档不变`, await page.locator('[data-rs-fullauto-confirm]').isVisible()
      && await confirmBtn.isDisabled() && (await page.evaluate(() => window.__rs.view().maxApprovalMode)) === 'auto-edit')
    const c1 = await contrastOf('[data-rs-fullauto-confirm] p')
    check(`${dark ? 'dark' : 'light'} 确认条正文对比度 ≥ 4.5`, c1 >= 4.5, c1)
    await page.screenshot({ path: path.join(out, `${dark ? 'dark' : 'light'}-fullauto-confirm.png`), fullPage: true })
    await page.locator('[data-rs-fullauto-confirm] input[type="checkbox"]').check()
    await confirmBtn.click()
    await page.locator('[data-rs-fullauto-warn]').waitFor({ timeout: 3000 })
    check(`${dark ? 'dark' : 'light'} 确认后写入 full-auto,常驻警示`, (await page.evaluate(() => window.__rs.view().maxApprovalMode)) === 'full-auto')
    const c2 = await contrastOf('[data-rs-fullauto-warn] p')
    check(`${dark ? 'dark' : 'light'} 警示正文对比度 ≥ 4.5`, c2 >= 4.5, c2)
  }

  // 窄栏:三档单列、无溢出
  await page.setViewportSize({ width: 520, height: 1300 })
  await open('state=on&width=520')
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.rs-cap-grid')).gridTemplateColumns.split(' ').length)
  check('窄栏:三档变单列', cols === 1, cols)
  const o = await overflow()
  check('窄栏:无横向溢出', o.scroll <= o.vw && o.bad.length === 0, o)
  await page.screenshot({ path: path.join(out, 'light-narrow.png'), fullPage: true })

  check('页面无运行期错误', errors.length === 0, errors.slice(0, 3))
  await browser.close()
  console.log(`\n${fail ? '❌' : '✅'} ${pass} 过 / ${fail} 挂 —— 截图:${out}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
