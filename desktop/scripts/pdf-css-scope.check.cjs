/**
 * pdf.js 样式表隔离契约检查(真 Chromium 断言)。
 *
 * 为什么存在:`pdfjs-dist/legacy/web/pdf_viewer.css` 抢了 `.dialog` / `.sidebar` 等通用类名并**直接画
 * 背景色**。全局引入(`import '…/pdf_viewer.css'`)会接管 Amadeus 全 App 共用的 Dialogs.tsx
 * (className="dialog",23 处)—— 表现为「打开过 PDF 后输入弹窗配色不对」。故 PdfAnnotator 改成
 * `?inline` + `@scope (.pdfa-root)` 注入,并对 CSS 做两处改写(见 PdfAnnotator.scopePdfCss)。
 *
 * 跑:node scripts/pdf-css-scope.check.cjs   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
 * 何时跑:动 scopePdfCss / 升级 pdfjs-dist 之后。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

// 与 PdfAnnotator.scopePdfCss 保持一致(此处刻意复制:该文件是 .tsx 且带 Vite 专属 import,node 直跑不了)
const scopePdfCss = (css) =>
  `@scope (.pdfa-root) {\n${css.replace(/:root\b/g, ':scope').replace(/--viewer-container-height:\s*0;/g, '')}\n}`

// 自装 chromium 定位:新版 playwright 是 chrome-mac-arm64/"Google Chrome for Testing.app",
// 旧版是 chrome-mac/Chromium.app —— 两种都试,别写死。
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dir = fs.readdirSync(root).filter((x) => /^chromium-\d/.test(x)).sort().pop()
  const base = path.join(root, dir)
  for (const rel of [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  ]) {
    const p = path.join(base, rel)
    if (fs.existsSync(p)) return p
  }
  throw new Error(`未找到 chromium(看过 ${base});可设 CHROMIUM_EXE 指定`)
}

const CSS_PATH = path.join(__dirname, '../node_modules/pdfjs-dist/legacy/web/pdf_viewer.css')
let failed = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`}`)
}

;(async () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8')
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN' })
  // 复刻真实处境:Amadeus 自己的 .dialog 样式 + pdf.js 样式表 + 一个阅读器根
  await page.setContent(`
    <style>.dialog{background:rgb(1,2,3)}</style>
    <style id="sheet">${scopePdfCss(css)}</style>
    <div class="dialog" id="outside">Amadeus 弹窗(PDF 视图之外)</div>
    <div class="pdfa-root">
      <div class="pdfViewer"><div class="dummyPage" id="dummy"></div></div>
      <div class="textLayer" id="tl"><span>t</span></div>
      <div class="annotationLayer"><section class="underlineAnnotation" id="ul"></section></div>
    </div>`)
  // pdf.js 运行时就是这么写的(viewer 里唯一写 documentElement 的变量)
  await page.evaluate(() => document.documentElement.style.setProperty('--viewer-container-height', '765px'))

  const g = (id, prop) => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i)).getPropertyValue(p), [id, prop])

  console.log('— 隔离(pdf.js 不许污染 Amadeus)—')
  check('Amadeus .dialog 背景未被 pdf.js 接管', await g('outside', 'background-color'), 'rgb(1, 2, 3)')
  check('Amadeus .dialog 内边距未被 pdf.js 接管', await g('outside', 'padding'), '0px')

  console.log('— pdf.js 样式在阅读器内仍生效 —')
  check('.textLayer 定位', await g('tl', 'position'), 'absolute')
  check('.textLayer z-index', await g('tl', 'z-index'), '0')
  check('.annotationLayer section 有点击区(pdf.js 默认)', await g('ul', 'pointer-events'), 'auto')

  console.log('— :root→:scope 改写:变量没丢 —')
  check('pdf.js 变量落到阅读器根', (await g('tl', '--freetext-padding')).trim(), '2px')

  console.log('— --viewer-container-height:运行时值必须进得来(不被 :scope 默认压成 0)—')
  check('.dummyPage 拿到运行时高度', await g('dummy', 'height'), '765px')

  console.log('— 对照:若不隔离(旧的全局引入),Amadeus 弹窗会被污染 —')
  await page.evaluate((c) => { document.getElementById('sheet').textContent = c }, css)
  const bg = await g('outside', 'background-color')
  const pad = await g('outside', 'padding')
  const polluted = bg !== 'rgb(1, 2, 3)' || pad !== '0px'
  if (!polluted) failed++
  console.log(`${polluted ? '✓' : '✗'} 对照组确实被污染(证明本检查有效):背景=${bg} 内边距=${pad}`)

  await browser.close()
  console.log(failed ? `\n✗ ${failed} 项未通过` : '\n✓ 全部通过')
  process.exit(failed ? 1 : 0)
})()
