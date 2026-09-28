/**
 * 设置 · 远程会话 ·「急停与远程锁定」(P1 · K2):真组件(经 K4 扩展槽挂在远程会话页末尾)+ 生产 CSS,Chromium 里点一遍
 * (桩 window.tangu.remoteSafety,不连主进程;主进程行为在 electron/remoteSafety.test.ts)。
 * 覆盖:四态(空闲 / 运行中 / 锁定 + 写盘失败 + 待补发 / 热键被占用)× 深浅色 × zh/en 无横向溢出、英文无汉字漏出、长设备名省略;
 *   急停 → 锁定出「解锁…」→ 解锁回未锁;热键录制(⌃⌥⇧K)/ 关闭 / 恢复默认;失败红字对比度 ≥ 4.5(深浅色);窄栏。
 * 截图落 $TMPDIR/forsion-remote-safety-settings/*.png(交付前自己看)。
 * Run: HARNESS_URL=http://localhost:<空闲端口>/harness.html node scripts/e2e-editor.cjs --check=remote-safety-settings
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
baseUrl.pathname = '/remote-safety-harness.html'
const base = baseUrl.toString()
const out = process.env.RSF_SHOT_DIR || path.join(os.tmpdir(), 'forsion-remote-safety-settings')
fs.mkdirSync(out, { recursive: true })
let pass = 0, fail = 0
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, JSON.stringify(detail)) } }

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 1500 }, deviceScaleFactor: 2 })
  page.setDefaultNavigationTimeout(180_000) // 共享机器上 vite 首次编译可能很慢
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()) })
  const open = async (query) => {
    await page.goto(`${base}?${query}`)
    await page.locator('[data-setting-anchor="remote-safety"]').waitFor({ timeout: 90_000 })
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

  const panelShot = async (name) => {
    const el = page.locator('[data-setting-anchor="remote-safety"]')
    await el.scrollIntoViewIfNeeded()
    await el.screenshot({ path: path.join(out, `${name}.png`) })
  }

  for (const [name, query] of [
    ['light-idle', 'state=idle'], ['dark-idle', 'state=idle&dark'],
    ['light-running', 'state=running'], ['dark-running', 'state=running&dark'],
    ['light-running-en', 'state=running&lang=en'], ['dark-running-en', 'state=running&dark&lang=en'],
    ['light-locked', 'state=locked'], ['dark-locked', 'state=locked&dark'], ['light-locked-en', 'state=locked&lang=en'],
    ['light-hotkeyfail', 'state=hotkeyfail'], ['dark-hotkeyfail-en', 'state=hotkeyfail&dark&lang=en'],
  ]) {
    await open(query)
    const o = await overflow()
    check(`${name}: 无横向溢出`, o.scroll <= o.vw && o.bad.length === 0, o)
    await panelShot(name)
    if (query.includes('lang=en')) {
      const han = await page.evaluate(() => /[\u4e00-\u9fff]/.test(document.querySelector('[data-setting-anchor="remote-safety"]').textContent.replace(/小米[^·]*·[^（]*（[^）]*）/g, '')))
      check(`${name}: 英文界面没有汉字漏出(设备名是数据,除外)`, !han)
    }
  }

  // 失败可见:红字对比度(深浅色)
  for (const dark of [false, true]) {
    await open(`state=locked${dark ? '&dark' : ''}`)
    const c1 = await contrastOf('[data-rsf-persist-failed]')
    check(`${dark ? 'dark' : 'light'} 写盘失败红字对比度 ≥ 4.5`, c1 >= 4.5, c1)
    await open(`state=hotkeyfail${dark ? '&dark' : ''}`)
    const c2 = await contrastOf('[data-rsf-hotkey-state="in_use"]')
    check(`${dark ? 'dark' : 'light'} 热键被占用红字对比度 ≥ 4.5`, c2 >= 4.5, c2)
    check(`${dark ? 'dark' : 'light'} 热键被占用:键帽画成失效`, (await page.locator('[data-rsf="hotkey"]').getAttribute('class')).includes('rsf-kbd--off'))
  }

  // 急停 → 锁定 → 解锁
  await open('state=running')
  check('运行中:三条远程任务、一条标「等你处理」', (await page.locator('[data-rsf-stop]').count()) === 3 && (await page.locator('[data-rsf-waiting]').count()) === 1)
  await page.locator('[data-rsf="estop"]').click()
  await page.locator('[data-rsf="unlock"]').waitFor({ timeout: 3000 })
  check('点「立即急停」→ 锁定 + 出「解锁…」', (await page.locator('[data-rsf-lock-state]').textContent()).includes('已锁定'))
  await panelShot('light-after-estop')
  await page.locator('[data-rsf="unlock"]').click()
  await page.locator('[data-rsf="unlock"]').waitFor({ state: 'detached', timeout: 3000 })
  check('解锁 → 回到未锁定', (await page.locator('[data-rsf-lock-state]').textContent()) === '未锁定')

  // 热键录制
  await open('state=idle')
  await page.locator('[data-rsf="hotkey-change"]').click()
  await page.locator('[data-rsf="hotkey-recorder"]').waitFor({ timeout: 3000 })
  await panelShot('light-recording')
  await page.keyboard.press('Control+Alt+Shift+KeyK')
  await page.locator('[data-rsf="hotkey"]').waitFor({ timeout: 3000 })
  check('录制 ⌃⌥⇧K', (await page.locator('[data-rsf="hotkey"]').textContent()) === '⌃⌥⇧K')
  await page.locator('[data-rsf="hotkey-reset"]').click()
  await page.waitForTimeout(200)
  check('恢复默认 ⌃⌥⇧.', (await page.locator('[data-rsf="hotkey"]').textContent()) === '⌃⌥⇧.')
  await page.locator('[data-rsf="hotkey-off"]').click()
  await page.waitForTimeout(200)
  check('关闭 → 说明急停只能从菜单栏或这里用', (await page.locator('[data-rsf-hotkey-state="disabled"]').count()) === 1)

  // 窄栏:长设备名省略、按钮换行不撑宽
  await page.setViewportSize({ width: 520, height: 1500 })
  await open('state=running&width=520')
  const o = await overflow()
  check('窄栏:无横向溢出', o.scroll <= o.vw && o.bad.length === 0, o)
  const nameBox = await page.evaluate(() => { const el = document.querySelector('.rsf-name'); el.textContent = el.textContent.repeat(3); const r = el.getBoundingClientRect(); return { sw: el.scrollWidth, cw: el.clientWidth, right: r.right, vw: document.documentElement.clientWidth } })
  check('窄栏:长设备名省略且不越界', nameBox.sw > nameBox.cw && nameBox.right <= nameBox.vw, nameBox)
  await panelShot('light-narrow')

  check('页面无运行期错误', errors.length === 0, errors.slice(0, 3))
  await browser.close()
  console.log(`\n${fail ? '❌' : '✅'} ${pass} 过 / ${fail} 挂 —— 截图:${out}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
