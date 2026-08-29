// 浮层落点回归实测:fixed 浮层的 left/top 是**视口坐标**,而祖先的 CSS zoom 会把它再乘一遍
// (实测 body{zoom:1.5} 下 left:100px 落在视口 150px)。Forsion 的 zoom 常年非 1(uiZoom 网页 1.1 /
// 触屏 1.15、singleColumn 的 .mini-shell .mb-main 0.85),而**桌面 Electron 默认 1 → 开发机上完全
// 看不见这个 bug**,只能靠这个脚本逐 zoom 钉死。修法唯一真源:lcl/engine/menuAnchor.tsx。
//
// 覆盖:① 编辑器 slash 菜单贴光标(harness) ② 下方没空间时翻到上方 ③ 工作区 tab 右键菜单贴鼠标
// ④ sash 刻度贴鼠标(后两条跑真 app)。
//
// 用法:npm run check:overlay(需 npm run web 起着 5173;没起会自己起)
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of [
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const ORIGIN = process.env.HARNESS_ORIGIN || 'http://localhost:5173'
const ZOOMS = [1, 0.85, 1.1, 1.15]
const TOL = 1.5 // px:亚像素舍入容差

const results = []
let dropBaseline = null // E 用:zoom=1 时落点提示相对目标组的归一化几何
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const ping = (url) =>
  new Promise((res) => {
    const req = http.get(url, (r) => {
      res(r.statusCode === 200)
      r.resume()
    })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => {
      req.destroy()
      res(false)
    })
  })

const setZoom = (page, z) => page.evaluate((v) => { document.body.style.zoom = v === 1 ? '' : String(v) }, z)

/** A/B:编辑器 slash 菜单(harness) */
async function editorOverlay(browser, z) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(`${ORIGIN}/harness.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
  await setZoom(page, z)
  await page.waitForTimeout(200)

  // A:菜单左上角贴光标(下方有空间)
  await page.locator('.md-block .ProseMirror').last().click()
  await page.keyboard.type('hello /', { delay: 20 })
  await page.waitForTimeout(350)
  const a = await page.evaluate(() => {
    const m = document.querySelector('.slash-menu')
    const sel = window.getSelection()
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).getClientRects()[0] : null
    if (!m || !r) return null
    const b = m.getBoundingClientRect()
    return { dx: b.left - r.left, dy: b.top - r.bottom, fixed: getComputedStyle(m).position }
  })
  check(`A slash 菜单贴光标 (zoom ${z})`, !!a && a.fixed === 'fixed' && Math.abs(a.dx) < TOL && Math.abs(a.dy) < TOL, JSON.stringify(a))

  // B:把编辑区推到视口底部 → 下方放不下 → 菜单翻到光标行上方(不再压着光标滑上来)
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const root = document.querySelector('.amadeus-root')
    if (root) root.style.marginTop = '760px'
  })
  await page.waitForTimeout(150)
  await page.locator('.md-block .ProseMirror').last().click()
  await page.keyboard.type(' /', { delay: 20 })
  await page.waitForTimeout(350)
  const b = await page.evaluate(() => {
    const m = document.querySelector('.slash-menu')
    const sel = window.getSelection()
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).getClientRects()[0] : null
    if (!m || !r) return null
    const box = m.getBoundingClientRect()
    return { menuBottom: box.bottom, lineTop: r.top, lineBottom: r.bottom, menuTop: box.top }
  })
  check(
    `B 下方没空间→菜单翻到光标上方 (zoom ${z})`,
    !!b && b.menuBottom <= b.lineTop + TOL,
    b && `menuBottom=${b.menuBottom.toFixed(1)} lineTop=${b.lineTop.toFixed(1)}`,
  )
  await page.close()
}

/** C/D:工作区 tab 右键菜单 + sash 刻度(真 app) */
async function appOverlay(browser, z) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  // ⚠️钉住启动 Space:2026-08-28 起「启动时进入」的缺省是 ribbon 主位槽(=主页 Space),
  // 而主页没有侧栏 → 没有 `.dv-sash`,D 那半会一直等到超时。C/D 要的是有侧栏的工作区形态。
  await page.addInitScript(() => { try { localStorage.setItem('forsion_default_space', 'tangu') } catch { /* private mode */ } })
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.wb-tab', { timeout: 30000 })
  await page.waitForTimeout(2500) // 布局/Space 落定,否则 tab 还会重排
  await setZoom(page, z)
  await page.waitForTimeout(400)

  const tab = await page.locator('.wb-tab').first().boundingBox()
  const cx = Math.round(tab.x + tab.width / 2)
  const cy = Math.round(tab.y + tab.height / 2)
  await page.mouse.move(cx, cy)
  await page.mouse.click(cx, cy, { button: 'right' })
  await page.waitForTimeout(350)
  const c = await page.evaluate(() => {
    const m = document.querySelector('.ctx-menu')
    if (!m) return null
    const b = m.getBoundingClientRect()
    return { left: b.left, top: b.top }
  })
  check(`C tab 右键菜单贴鼠标 (zoom ${z})`, !!c && Math.abs(c.left - cx) < TOL && Math.abs(c.top - cy) < TOL,
    c && `menu=(${c.left.toFixed(1)},${c.top.toFixed(1)}) mouse=(${cx},${cy})`)

  // F(codex#1):菜单开着时**运行期**改 zoom —— 改 body.zoom 不发 resize,浮层收不到通知就会当场偏掉。
  if (c) {
    const z2 = z === 1.15 ? 0.9 : 1.15
    await setZoom(page, z2)
    await page.waitForTimeout(250)
    const f = await page.evaluate(() => {
      const m = document.querySelector('.ctx-menu')
      if (!m) return null
      const b = m.getBoundingClientRect()
      return { left: b.left, top: b.top }
    })
    check(`F 菜单开着时改 zoom → 重新贴回鼠标 (${z}→${z2})`, !!f && Math.abs(f.left - cx) < TOL && Math.abs(f.top - cy) < TOL,
      f && `menu=(${f.left.toFixed(1)},${f.top.toFixed(1)}) mouse=(${cx},${cy})`)
    await setZoom(page, z)
    await page.waitForTimeout(150)
  } else {
    check(`F 菜单开着时改 zoom → 重新贴回鼠标 (zoom ${z})`, false, 'C 没打开菜单,F 无从测起')
  }
  await page.keyboard.press('Escape')
  await page.mouse.click(Math.round(1400 / 2), 700)
  await page.waitForTimeout(200)

  const sash = await page.locator('.dv-sash').first().boundingBox()
  if (!sash) {
    check(`D sash 刻度贴鼠标 (zoom ${z})`, false, '没有 sash —— app 布局没起来,断言无效')
    await page.close()
    return
  }
  const sx = Math.round(sash.x + sash.width / 2)
  const sy = Math.round(sash.y + sash.height * 0.4)
  await page.mouse.move(sx, sy)
  await page.waitForTimeout(250)
  const d = await page.evaluate(() => {
    const t = document.querySelector('.lcl-sash-tick')
    if (!t || !t.classList.contains('show')) return null
    const b = t.getBoundingClientRect()
    return { cy: b.top + b.height / 2 }
  })
  // 竖分界线:刻度纵向跟鼠标(横向刻意偏到卡缘,见 sashAffordance 的 CARD_INSET)
  check(`D sash 刻度纵向跟鼠标 (zoom ${z})`, !!d && Math.abs(d.cy - sy) < TOL, d && `tickY=${d.cy.toFixed(1)} mouseY=${sy}`)

  // E:拖 view tab 时的落点提示(.wb-drop-zone / .wb-drop-line)。没有「唯一真值 API」可比,
  // 用**缩放不变量**:提示相对目标组矩形的归一化位置/尺寸,在各 zoom 下必须与 zoom=1 一致。
  const e = await page.evaluate(() => {
    const tab = document.querySelector('.wb-tab')
    const group = tab.closest('.dv-groupview')
    const gr = group.getBoundingClientRect()
    const dt = new DataTransfer()
    const mid = { x: gr.left + gr.width / 2, y: gr.top + gr.height / 2 }
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: gr.left + 20, clientY: gr.top + 10, dataTransfer: dt }))
    const target = document.elementFromPoint(mid.x, mid.y) || group
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: mid.x, clientY: mid.y, dataTransfer: dt }))
    const ind = [...document.querySelectorAll('.wb-drop-zone, .wb-drop-line')].find((n) => n.style.display === 'block')
    const r = ind && ind.getBoundingClientRect()
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return r ? { dx: (r.left - gr.left) / gr.width, dy: (r.top - gr.top) / gr.height, w: r.width / gr.width, h: r.height / gr.height } : null
  })
  if (z === 1) {
    dropBaseline = e
    check('E 拖 view 的落点提示可量(zoom 1 基线)', !!e, JSON.stringify(e))
  } else {
    const near = (a, b) => Math.abs(a - b) <= 0.02 // 2% 组尺寸
    check(
      `E 拖 view 的落点提示:相对目标组的几何与 zoom=1 一致 (zoom ${z})`,
      !!e && !!dropBaseline && near(e.dx, dropBaseline.dx) && near(e.dy, dropBaseline.dy) && near(e.w, dropBaseline.w) && near(e.h, dropBaseline.h),
      `${JSON.stringify(e)} vs ${JSON.stringify(dropBaseline)}`,
    )
  }
  await page.close()
}

/** G:UI_ZOOM_EVENT 契约。F 靠 ResizeObserver 也能过 → 事件这条线行为断言盖不住,只能钉源码:
 *  uiZoom.apply() 必须派发,menuAnchor 必须监听。少任何一半,运行期改 zoom 时非 hook 浮层(行内工具栏)就停在旧位置。 */
function zoomEventContract() {
  const fs2 = require('fs')
  const rd = (rel) => fs2.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
  const evt = 'UI_ZOOM_EVENT'
  const emits = /dispatchEvent\(new Event\(UI_ZOOM_EVENT\)\)/.test(rd('frontend/src/uiZoom.ts'))
  const engine = rd('../lcl/engine/menuAnchor.tsx')
  const listens = engine.includes(`addEventListener(${evt}, apply)`)
  // 行内工具栏改走 OverlayAt 后就由 hook 兜住了;它若哪天又自己手写 left/top,就得自己接这个事件。
  const tb = rd('frontend/src/amadeus/blocks/markdown/InlineToolbar.tsx')
  const toolbar = /<OverlayAt[\s\S]*?className="inline-toolbar"|className="inline-toolbar"[\s\S]{0,80}?prefer=/.test(tb)
    ? true
    : tb.includes(`addEventListener(${evt}`)
  check('G UI_ZOOM_EVENT 契约:uiZoom 派发 + menuAnchor 监听 + 工具栏走 OverlayAt(或自己监听)',
    emits && listens && toolbar, `emits=${emits} hook=${listens} toolbar=${toolbar}`)
}

async function main() {
  let vite = null
  if (!(await ping(`${ORIGIN}/harness.html`))) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping(`${ORIGIN}/harness.html`)
    }
    if (!up) {
      console.error('vite 没起来')
      vite.kill()
      process.exit(1)
    }
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    for (const z of ZOOMS) await editorOverlay(browser, z)
    for (const z of ZOOMS) await appOverlay(browser, z)
    zoomEventContract()
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
