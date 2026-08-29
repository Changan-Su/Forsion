/**
 * 「整个界面被顶歪」的回归闸(用户 2026-08-28 报:ribbon + 标题栏不见了、侧栏文字左边被切)。
 *
 * 病理:.shell 曾是 `overflow: hidden`。hidden 同样看不见溢出,但它**仍然是个滚动容器** ——
 * 浏览器给焦点元素做 scrollIntoView 时会把整个壳横竖滚起来,而且没有滚动条能滚回来,只能重启。
 * 触发条件是 UI 缩放 ≠ 1(web 1.10 / 触屏 1.15 / 桌面用户按过 ⌘+=):dockview 的
 * .dv-floating-overlay-host 用「量 rect(已 ×zoom)再写回 px」定尺寸,于是比 .shell 大整整一个
 * zoom 倍差(实测 z=1.1:壳 1091×727、host 1152×800 → 可横滚 105px、纵滚 73px,正好是
 * ribbon 44 + 侧栏一截 / 标题栏 30 + tab 栏 32)。修法 = .shell 改 `overflow: clip`,clip 压根不建
 * 滚动容器。同一个坑的移动端版见 lcl/engine/singleColumn.css 的 .mb-body。
 *
 * ⚠️2026-08-28 又抓到同一类病的**上一层**:用户实报「回到 Tangu 就莫名突出来一块,把页面往上顶」,
 * 实测 `--uiz=1.2`、`.shell` 的 top = **-27**(顶上切 27px、底下空 27px)。根因不在壳而在**视口**:
 * `body { overflow: hidden }` 传播到视口后,视口**仍是可被程序化滚动的容器**,scrollIntoView 就能
 * 把整个界面滚上去且滚不回来。CSS 挡不住(body/html 改 clip 都实测无效,视口的 clip 被当 hidden),
 * 只能滚起来之后弹回去 → `viewportLock.ts`。E 就是钉这条的。
 *
 * 反向验证:把 engine.css 的 .shell 改回 overflow: hidden → A/B 必红;删掉 engine.css 里
 * .dv-floating-overlay-host 那条百分比覆盖 → D 必红(zoom≠1 两档);
 * 不装 installViewportLock() → E 必红。
 * 跑:npm run check:shellnoscroll(需 5173;没起会自己起)
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
const ZOOMS = [1, 1.1, 1.15]
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const ping = (url) =>
  new Promise((res) => {
    const req = http.get(url, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })

async function run(browser, z) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.addInitScript((v) => localStorage.setItem('forsion_ui_zoom', String(v)), z)
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.shell', { timeout: 30000 })
  await page.waitForTimeout(2500)

  const r = await page.evaluate(() => {
    const sh = document.querySelector('.shell')
    const rb = document.querySelector('.rb')
    const before = rb ? Math.round(rb.getBoundingClientRect().left) : null
    // ① 直接硬滚:clip 下写不进去,hidden 下会留在溢出量上
    sh.scrollLeft = 9999
    sh.scrollTop = 9999
    const forced = { x: Math.round(sh.scrollLeft), y: Math.round(sh.scrollTop) }
    sh.scrollLeft = 0
    sh.scrollTop = 0
    // ② 端到端:让浏览器把最右下的元素滚进视野(= 真实触发路径:焦点/scrollIntoView)
    const all = [...document.querySelectorAll('.shell *')]
    const far = all.reduce((a, b) => {
      const x = b.getBoundingClientRect()
      return x.right + x.bottom > (a ? a.getBoundingClientRect().right + a.getBoundingClientRect().bottom : -1e9) ? b : a
    }, null)
    if (far) far.scrollIntoView({ inline: 'end', block: 'end' })
    const de = document.documentElement
    return {
      forced,
      ribbonShift: rb ? Math.round(rb.getBoundingClientRect().left) - before : null,
      docOverflow: { x: de.scrollWidth - de.clientWidth, y: de.scrollHeight - de.clientHeight },
      overflowInside: { x: sh.scrollWidth - sh.clientWidth, y: sh.scrollHeight - sh.clientHeight },
      used: getComputedStyle(sh).overflowX,
      // dockview 浮层 host:上游量 rect(已 ×zoom)再写回 px → 不压住的话恒比 .dv-shell 大一个 z 倍
      hostRatio: (() => {
        const h = document.querySelector('.dv-floating-overlay-host')
        if (!h || !h.parentElement) return null
        const a = h.getBoundingClientRect(), b = h.parentElement.getBoundingClientRect()
        return { w: +(a.width / b.width).toFixed(3), h: +(a.height / b.height).toFixed(3) }
      })(),
    }
  })

  check(`A .shell 不是滚动容器 (zoom ${z})`, r.forced.x === 0 && r.forced.y === 0, `overflow=${r.used} forced=${JSON.stringify(r.forced)}`)
  check(`B scrollIntoView 推不动整壳 (zoom ${z})`, r.ribbonShift === 0, `ribbon 位移 ${r.ribbonShift}px`)
  check(`C 视口自身无可滚溢出 (zoom ${z})`, r.docOverflow.x <= 0 && r.docOverflow.y <= 0, JSON.stringify(r.docOverflow))
  // D 是溢出的**源头**闸:clip 只是兜底,壳里本就不该有东西溢出来。唯一的溢出源是 dockview 的
  //   .dv-floating-overlay-host(见 engine.css 里那条 !important 百分比覆盖);它一失效这里先红。
  check(`D 壳内零溢出 (zoom ${z})`, r.overflowInside.x <= 0 && r.overflowInside.y <= 0,
    `溢出 ${JSON.stringify(r.overflowInside)} host/壳 尺寸比 ${JSON.stringify(r.hostRatio)}`)

  // E 视口滚动锁:A-D 都是「别产生溢出」;E 守的是「万一产生了,界面也不许被顶走」。
  //   真实现场的溢出源是用户会话里的内容(PDF 阅读器、portal 到 body 的浮层),台架造不出来 →
  //   合成一个比视口高 30px 的绝对定位元素,再走一次程序化滚动,看一帧后有没有弹回去。
  const e = await page.evaluate(() => {
    const d = document.createElement('div')
    d.id = '__ovfprobe'
    d.style.cssText = 'position:absolute;left:0;top:0;width:4px;height:calc(100% + 30px);pointer-events:none'
    document.body.appendChild(d)
    const se = document.scrollingElement
    se.scrollTop = 999
    return { root: se.scrollHeight - se.clientHeight, moved: se.scrollTop }
  })
  await page.waitForTimeout(400)
  const settled = await page.evaluate(() => {
    const sh = document.querySelector('.shell')
    const out = { scrollY: Math.round(window.scrollY), shellTop: Math.round(sh.getBoundingClientRect().top) }
    document.getElementById('__ovfprobe')?.remove()
    return out
  })
  check(
    `E 视口被滚起来会自己弹回(zoom ${z})`,
    e.root > 0 && e.moved > 0 && settled.scrollY === 0 && settled.shellTop === 0,
    `合成溢出 ${e.root}px、当场滚到 ${e.moved} → 一帧后 scrollY=${settled.scrollY} shellTop=${settled.shellTop}` +
      (e.moved === 0 ? '(moved=0 = 夹具没造出可滚的视口,这条不算数)' : ''),
  )
  await page.close()
}

async function main() {
  let vite = null
  if (!(await ping(ORIGIN))) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping(ORIGIN)
    }
    if (!up) { console.error('vite 没起来'); vite.kill(); process.exit(1) }
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    for (const z of ZOOMS) await run(browser, z)
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
