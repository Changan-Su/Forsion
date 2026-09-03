/**
 * 多文件 patch 的 diff 块必须各自带文件名(真 Chromium + 真 base.css + 真 diff2html 输出)。
 *
 * 为什么存在:base.css 把 `.d2h-file-header` 整个 `display:none`(单文件时工具行标题已经写了
 * 文件名,再显示一遍是噪音)。一次 apply_patch 改多个文件时同一条规则就致命:第二个 diff 块
 * 没有标题,看着像第一块的续篇 —— 2026-08-18 真机走查报的正是这个。
 * 修法是 `:not(:only-of-type)` 只在多块时放行,而**这条恰恰是几何断言看不见、只有真 CSS 才算得出**
 * 的那类(DESIGN.md §7:同特异性覆盖块的胜负、display 的继承)。
 *
 * 断言看**可见性**不看 DOM 存在:display:none 下 textContent 照样有,只查文本必假绿。
 * 负对照(单文件仍隐藏)同页跑,防止改成「一律显示」把噪音放回来。
 *
 * 跑:npm run check:diffmulti   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const ROOT = path.resolve(__dirname, '..')
const BASE_CSS = fs.readFileSync(path.join(ROOT, 'frontend/src/styles/base.css'), 'utf8')
const D2H_CSS = fs.readFileSync(path.join(ROOT, 'node_modules/diff2html/bundles/css/diff2html.min.css'), 'utf8')
const d2h = require(path.join(ROOT, 'node_modules/diff2html'))

const render = (text) => (d2h.html || d2h.default.html)(text, {
  outputFormat: 'line-by-line', drawFileList: false, matching: 'lines',
})

// 与 toolDiff.ts 的 codexPatchToUnified 产出同形(--- / +++ / @@,新建文件走 /dev/null)
const MULTI = '--- a.txt\n+++ a.txt\n@@ -1,1 +1,2 @@\n baseline\n+MULTI-A\n--- /dev/null\n+++ c.txt\n@@ -0,0 +1,1 @@\n+MULTI-C\n'
const SINGLE = '--- a.txt\n+++ a.txt\n@@ -1,1 +1,2 @@\n baseline\n+ONLY-A\n'

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; background:#fff; }
  ${D2H_CSS}
  ${BASE_CSS}
</style></head><body>
  <div class="tool-card-body"><div class="wsfile-diff" id="multi">${render(MULTI)}</div></div>
  <div class="tool-card-body"><div class="wsfile-diff" id="single">${render(SINGLE)}</div></div>
</body></html>`

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 720, height: 900 } })
  await page.setContent(HTML)
  await page.waitForTimeout(200)

  const probe = await page.evaluate(() => {
    const read = (id) => [...document.querySelectorAll(`#${id} .d2h-file-wrapper`)].map((w) => {
      const h = w.querySelector('.d2h-file-header')
      const vis = !!h && getComputedStyle(h).display !== 'none' && h.getClientRects().length > 0
      return { vis, name: (w.querySelector('.d2h-file-name')?.textContent || '').trim(), h: h ? h.getBoundingClientRect().height : 0 }
    })
    return { multi: read('multi'), single: read('single') }
  })

  check('D1 多文件:两块都渲染出来了', probe.multi.length === 2, JSON.stringify(probe.multi.map((x) => x.name)))
  check('D2 多文件:每块的文件名标题可见(不是仅 DOM 存在)',
    probe.multi.length === 2 && probe.multi.every((x) => x.vis && x.h > 8), JSON.stringify(probe.multi))
  check('D3 多文件:两块的文件名各不相同且对得上 patch',
    probe.multi.some((x) => x.vis && x.name.includes('a.txt')) && probe.multi.some((x) => x.vis && x.name.includes('c.txt')),
    JSON.stringify(probe.multi.map((x) => x.name)))
  check('D4 负对照:单文件仍隐藏标题(工具行已写了文件名,别把噪音放回来)',
    probe.single.length === 1 && !probe.single[0].vis, JSON.stringify(probe.single))

  await page.screenshot({ path: process.env.DIFF_SHOT || '/tmp/diff-multifile.png', fullPage: true })
  await browser.close()

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过  | 截图 ${process.env.DIFF_SHOT || '/tmp/diff-multifile.png'}`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
