// followAnchor(lcl/engine/menuAnchor.tsx)在真 Chromium 里的落位实测:锚在元素上的浮层(原生 popover、
// 插件 ctx.ui.popover)要一直在窗口里 —— 内容在打开之后才渲染、之后又异步长高、端级 CSS zoom、浮层自带 CSS 高度上限。
// 起因:2026-11-08 日历待办的日期 / 关联笔记弹层打开后只量一次高度(量到空壳),从吸底输入框往下开、掉出窗口。
//
// 用法:npm run check:followanchor(不需要起 dev server:esbuild 现打一个只含 menuAnchor 的页面)
// 负对照:FOLLOW_ANCHOR_NEG=1 换成「打开后 rAF 量一次」的旧写法,必须红。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { build } = require('esbuild')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const NEG = process.env.FOLLOW_ANCHOR_NEG === '1'
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

const ENTRY = `
import { followAnchor, zoomOf } from ${JSON.stringify(path.resolve(__dirname, '../../lcl/engine/menuAnchor.tsx'))}
// 旧写法(负对照):打开后下一帧量一次高度决定翻不翻,之后不再管
function onceAfterOpen(p, anchor) {
  const r = anchor.getBoundingClientRect(), z = zoomOf(anchor)
  p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth * z - 8)) / z + 'px'
  p.style.top = (r.bottom + 4) / z + 'px'
  requestAnimationFrame(() => {
    const h = p.offsetHeight * z
    if (r.bottom + 4 + h > innerHeight - 8) p.style.top = (r.top - h - 4 > 8 ? r.top - h - 4 : Math.max(8, innerHeight - h - 8)) / z + 'px'
  })
  return () => {}
}
const follow = ${NEG ? 'onceAfterOpen' : 'followAnchor'}
window.openPop = ({ anchorTop, rows, lateRows, cap }) => {
  document.body.innerHTML = ''
  const a = document.createElement('button')
  a.textContent = 'anchor'
  a.style.cssText = 'position:fixed;left:600px;width:28px;height:28px;top:' + anchorTop + 'px'
  const p = document.createElement('div')
  p.setAttribute('popover', 'auto')
  p.style.cssText = 'position:fixed;inset:auto;margin:0;width:260px;padding:6px;overflow:auto;border:1px solid #888'
  if (cap) { const st = document.createElement('style'); st.textContent = '.capped{max-height:' + cap + '}'; document.head.append(st); p.className = 'capped' } // 上限来自样式表(内联值会被 followAnchor 当成上一轮写的清掉)
  document.body.append(a, p)
  p.showPopover()
  window.stop = follow(p, a)
  // 内容在 toggle 之后才到(React 的 {shown && children}),再过一会儿异步长高(笔记列表)
  setTimeout(() => { for (let i = 0; i < rows; i++) p.append(Object.assign(document.createElement('div'), { textContent: 'row ' + i, style: 'height:30px' })) }, 30)
  setTimeout(() => { for (let i = 0; i < lateRows; i++) p.append(Object.assign(document.createElement('div'), { textContent: 'late ' + i, style: 'height:30px' })) }, 200)
}
window.measure = () => {
  const p = document.querySelector('[popover]'), a = document.querySelector('button')
  const r = p.getBoundingClientRect(), b = a.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, h: r.height, scroll: p.scrollHeight > p.clientHeight + 1, aTop: b.top, aBottom: b.bottom, vh: innerHeight }
}
`

async function main() {
  const out = await build({ stdin: { contents: ENTRY, resolveDir: __dirname, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', nodePaths: [path.join(__dirname, '../node_modules')] })
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0"></body><script>${out.outputFiles[0].text}</script>`
  const browser = await chromium.launch({ executablePath: findChromium() })
  try {
    for (const z of [1, 1.1]) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 720 } })
      await page.setContent(html)
      if (z !== 1) await page.evaluate((v) => { document.body.style.zoom = String(v) }, z)
      const vhLocal = 720 / z
      const run = async (name, o, expect) => {
        await page.evaluate((x) => window.openPop(x), o)
        await page.waitForTimeout(400)
        const m = await page.evaluate(() => window.measure())
        const inside = m.top >= 7.5 && m.bottom <= m.vh - 7.5
        check(`zoom ${z}: ${name}`, inside && expect(m), `top ${m.top.toFixed(1)} bottom ${m.bottom.toFixed(1)} of ${m.vh}; anchor ${m.aTop.toFixed(1)}–${m.aBottom.toFixed(1)}${m.scroll ? '; scrolls' : ''}`)
      }
      // 锚点贴窗口底(吸底输入框):内容晚到 → 必须翻到上方、底边贴锚点上沿
      await run('anchor at the bottom, content arrives late → opens above', { anchorTop: vhLocal - 60, rows: 10, lateRows: 0 }, (m) => m.bottom <= m.aTop + 0.5)
      // 同上,之后异步又长高 → 仍在窗口里、仍在锚点上方
      await run('content grows later → re-placed, still above', { anchorTop: vhLocal - 60, rows: 3, lateRows: 8 }, (m) => m.bottom <= m.aTop + 0.5)
      // 锚点在顶部 → 往下开
      await run('anchor near the top → opens below', { anchorTop: 60, rows: 10, lateRows: 0 }, (m) => m.top >= m.aBottom - 0.5)
      // 比两侧都高 → 放在空间大的一侧,封顶并在里面滚
      await run('taller than either side → capped on the roomier side and scrolls', { anchorTop: vhLocal / 2, rows: 40, lateRows: 0 }, (m) => m.scroll && m.bottom <= m.aTop + 0.5)
      // 浮层自带 CSS 上限(.plugin-popover 的 min(70vh, 520px))不被放大
      await run('own CSS max-height is kept', { anchorTop: 40, rows: 40, lateRows: 0, cap: '300px' }, (m) => Math.abs(m.h - (300 + 14) * z) < 2 && m.scroll) // content-box:300 + 内边距 12 + 边框 2
      // 视口相对的 CSS 上限(70vh)随窗口变:先在矮窗口里开,再把窗口拉高,上限要跟着放开
      await page.setViewportSize({ width: 1200, height: 400 })
      await page.evaluate(() => window.openPop({ anchorTop: 20, rows: 40, lateRows: 0, cap: '70vh' }))
      await page.waitForTimeout(400)
      await page.setViewportSize({ width: 1200, height: 900 })
      await page.waitForTimeout(400)
      const g = await page.evaluate(() => window.measure())
      check(`zoom ${z}: viewport-relative CSS cap follows a window resize`, g.h > 0.7 * 900 - 4 - 2 && g.bottom <= g.vh - 7.5, `h ${g.h.toFixed(1)} of ${g.vh}`)
      await page.close()
    }
  } finally { await browser.close() }
  const fails = results.filter((x) => !x).length
  console.log(`\n${results.length - fails}/${results.length} passed${NEG ? '(负对照:应当有红)' : ''}`)
  process.exit(NEG ? (fails ? 0 : 1) : fails ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
