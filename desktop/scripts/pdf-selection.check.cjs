/**
 * PDF 批注不挡文字选区 —— 契约检查(真 Chromium 断言 pointer-events 层序)。
 *
 * 为什么存在(根因,源码实证 pdf.js AnnotationEditorLayer.updateMode):
 *   NONE 分支    → toggleAnnotationLayerPointerEvents(true)  → 注释层 section 有点击区
 *   HIGHLIGHT 等 → toggleAnnotationLayerPointerEvents(false) → 注释层 section 无点击区
 * 我们的 鼠标/下划线/波浪线/删除线/便签/形状 工具都跑在 NONE 模式 → 已标注过的文字被 section 盖住,
 * mousedown 落不到 textLayer、拿不到 `.selecting` → **选不中**(只有高亮工具正常)。
 * 修法见 pdfAnnotator.css:让纯装饰的文本标记 section 永不挡选区,链接/便签(要点)不动。
 *
 * 跑:node scripts/pdf-selection.check.cjs   (需 playwright-core 自装 chromium;CHROMIUM_EXE 可覆盖)
 * 何时跑:动 pdfAnnotator.css 的 pointer-events 规则 / 升级 pdfjs-dist 之后。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

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

const scopePdfCss = (css) =>
  `@scope (.pdfa-root) {\n${css.replace(/:root\b/g, ':scope').replace(/--viewer-container-height:\s*0;/g, '')}\n}`

const R = (p) => path.join(__dirname, '..', p)
let failed = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    实际: ${JSON.stringify(actual)} / 期望: ${JSON.stringify(expected)}`}`)
}

;(async () => {
  const pdfCss = fs.readFileSync(R('node_modules/pdfjs-dist/legacy/web/pdf_viewer.css'), 'utf8')
  const ourCss = fs.readFileSync(R('frontend/src/amadeus/pdf/pdfAnnotator.css'), 'utf8')
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN' })

  // 复刻 pdf.js 的真实页内层序:.page > .textLayer + .annotationLayer > section(各类注释)
  // section 的位置/内联 z-index 也照抄 pdf.js(style.zIndex = parent.zIndex++)。
  const dom = (tool) => `
    <style id="pdfjs">${scopePdfCss(pdfCss)}</style>
    <style>${ourCss}</style>
    <div class="pdfa-root"><div class="pdfa-viewport">
      <div class="pdfa-container" data-tool="${tool}" style="width:400px;height:300px">
        <div class="pdfViewer"><div class="page" style="width:380px;height:280px;position:relative">
          <div class="textLayer" style="inset:0"><span id="word" style="position:absolute;left:40px;top:40px;width:100px;height:14px">文字</span></div>
          <div class="annotationLayer" style="inset:0">
            <section class="underlineAnnotation" id="ul" style="z-index:1;left:40px;top:40px;width:100px;height:14px"></section>
            <section class="highlightAnnotation" id="hl" style="z-index:2;left:40px;top:70px;width:100px;height:14px"></section>
            <section class="strikeoutAnnotation" id="so" style="z-index:3;left:40px;top:100px;width:100px;height:14px"></section>
            <section class="squigglyAnnotation" id="sq" style="z-index:4;left:40px;top:130px;width:100px;height:14px"></section>
            <section class="linkAnnotation" id="lk" style="z-index:5;left:40px;top:160px;width:100px;height:14px"></section>
            <section class="textAnnotation" id="note" style="z-index:6;left:40px;top:190px;width:20px;height:20px"></section>
          </div>
        </div></div>
      </div>
      <div class="pdfa-bottombar" id="bar"><button class="pdfa-btn" id="zoomin">＋</button></div>
    </div></div>`

  const pe = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).pointerEvents, id)
  // 命中测试:点某元素的正中,最终会被谁接住 —— 这才是「能不能起选区」的真判据(光看 pointer-events 不够)。
  const hitCenterOf = (id) => page.evaluate((i) => {
    const r = document.getElementById(i).getBoundingClientRect()
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return el ? (el.id || el.className || el.tagName) : '(null)'
  }, id)

  for (const tool of ['mouse', 'underline']) {
    await page.setContent(dom(tool))
    console.log(`— data-tool="${tool}" —`)
    check('下划线 section 不挡', await pe('ul'), 'none')
    check('高亮 section 不挡', await pe('hl'), 'none')
    check('删除线 section 不挡(类名是 strikeout,小写 o)', await pe('so'), 'none')
    check('波浪线 section 不挡', await pe('sq'), 'none')
    // 链接与便签在鼠标模式必须仍可点(否则跳转/看评论就废了);形状/标记模式下让位给拖拽是有意为之
    check('链接 section 仍可点', await pe('lk'), tool === 'mouse' ? 'auto' : 'auto')
    check('便签 section 仍可点', await pe('note'), 'auto')
    // 决定性:点在「已划过下划线的那行字」正中,必须落到文字层(而不是被 underline section 接住)
    check('点已标注文字 → 落到文字层(可起选区)', await hitCenterOf('word'), 'word')
  }

  console.log('— 对照:去掉本项修复(只留 pdf.js 原样),同一点会被 section 接住 —')
  await page.setContent(dom('mouse'))
  await page.evaluate(() => {
    // 抹掉我们那条「文本标记 section 不挡选区」的规则,退回 pdf.js 在 NONE 模式下的原生行为
    for (const s of document.querySelectorAll('style')) {
      if (s.id !== 'pdfjs') s.textContent = s.textContent.replace(/\.pdfa-container \.annotationLayer section:is\([^)]*\)\s*\{[^}]*\}/g, '')
    }
  })
  const blocked = await hitCenterOf('word')
  const ok = blocked === 'ul'
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} 对照组确实被 section 挡住(证明本检查有效):点到了 "${blocked}"`)

  console.log('— 形状工具:文字层让位给拖拽 —')
  await page.setContent(dom('rect'))
  check('形状模式下文字层不抢指针', await pe('word'), 'none')

  console.log('— 底部胶囊必须压得住 pdf.js 内部图层(isolation:isolate)—')
  await page.setContent(dom('mouse'))
  await page.evaluate(() => {
    // 复刻 pdf.js 选中态编辑器的 z-index:100000(.annotationEditorLayer 无 z-index → 不成层叠上下文)
    const d = document.createElement('div')
    d.className = 'annotationEditorLayer'
    d.style.cssText = 'position:absolute;inset:0;z-index:100000;background:red'
    document.querySelector('.page').append(d)
  })
  const bar = await page.evaluate(() => {
    const b = document.getElementById('zoomin').getBoundingClientRect()
    const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
    return el?.id || el?.className || '(null)'
  })
  check('缩放按钮点得到(没被 z-index:100000 盖住)', bar, 'zoomin')

  await browser.close()
  console.log(failed ? `\n✗ ${failed} 项未通过` : '\n✓ 全部通过')
  process.exit(failed ? 1 : 0)
})()
