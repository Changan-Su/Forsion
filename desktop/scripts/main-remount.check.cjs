/**
 * 展侧栏时主区到底发生了什么(真 Chromium + 真 Dockview + 真 dockviewStore,harness.html?dock)。
 *
 * 为什么存在:用户实报「Left/Right Panel 展开时,main view 像是从右边全部重新加载闪烁一遍;
 * 收起时反而丝滑」。这条只可能在 DOM 接线层看见——纯函数单测和 mock dockview 都测不到:
 *   ① 主区视图有没有被 Dockview 摘下来重挂(remount = 内容真的重建一遍 = 用户说的「重新加载」);
 *   ② 主区宽度有没有在一帧里先暴缩(新组按默认 ~50% 诞生)再弹回(setSize(1))。
 *
 * ⚠️量宽用 rAF 逐帧采样,不要用同步循环:同步循环不推进动画帧,读到的永远是起始值 = 假绿。
 * ⚠️主区「过冲」的判据是**低于终值**:展右栏时主区本来就要收窄到终值,只有窄过头才是病。
 *
 * 跑:npm run check:remount   (5173 没起会自起 vite,跑完自收;CHROMIUM_EXE 可覆盖)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const URL = `${BASE}?dock`

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 驱动一次 toggle,并用 rAF 逐帧采主区组宽 + 主区视图挂载数。 */
const run = (page, side) => page.evaluate(async (s) => {
  const d = window.__dock
  const before = d.mounts.main ?? 0
  const w = []
  await new Promise((done) => {
    const t0 = performance.now()
    const tick = () => {
      w.push(Math.round(d.mainW()))
      if (performance.now() - t0 < 700) requestAnimationFrame(tick)
      else done()
    }
    d.toggle(s)
    requestAnimationFrame(tick)
  })
  return { remounts: (d.mounts.main ?? 0) - before, w }
}, side)

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await page.addInitScript(() => localStorage.clear()) // 布局/侧栏宽都落 localStorage,别串味
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.dockh-body[data-tag="main"]', { timeout: 20000 })
    await page.waitForTimeout(500) // 等 pinSides 的 rAF²+60ms 沉降

    for (const side of ['right', 'left']) {
      const open = await run(page, side)
      const floor = Math.min(...open.w)
      const last = open.w[open.w.length - 1]
      const label = side === 'right' ? '右栏' : '左栏'
      // ① 用户主诉:内容不该重建。Dockview onlyWhenVisible 会把不可见面板的 DOM 摘掉,
      //    一旦展侧栏碰到主区面板的可见性/组归属,主区就整块重挂 = 「重新加载闪一遍」。
      check(`⚠️展${label}:主区视图不重挂(用户报的「重新加载闪一遍」)`, open.remounts === 0, `remount ×${open.remounts}`)
      // ② 新组若按 Dockview 默认宽诞生,主区会在一帧里缩到 ~一半再弹回来。终值才是它该到的宽。
      check(`⚠️展${label}:主区不「先暴缩再弹回」(新组须按 1px 诞生)`, floor >= last - 2, `谷底 ${floor} / 终值 ${last}`)
      check(`展${label}:主区确实让出了位置`, open.w[0] - last > 50, `${open.w[0]} → ${last}`)

      const close = await run(page, side)
      check(`收${label}:主区视图不重挂`, close.remounts === 0, `remount ×${close.remounts}`)
      console.log(`      收${label}轨迹 ${close.w.filter((_, i) => i % 4 === 0).join(' ')}`)
    }

    const bad = results.filter((r) => !r.ok)
    console.log(`\n${results.length - bad.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
