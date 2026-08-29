/**
 * 引用条临时高亮的**几何**契约 —— 真 pdf.js(PDFViewer + PDFFindController)+ 真 CSS,
 * 拿「画布像素上的字迹」当基准尺,量我们画出来的黄带到底盖在哪。
 *
 * 为什么存在(08-28,同一个「位置不对」被报第二次 → 冻结改码先建观测):
 *   pdf.js 把文本层的 span 顶设成 `baseline − fontHeight × ascentRatio`、盒高 1em(line-height:1);
 *   而 `.highlight` 是这个 span 的**行内子元素**,背景铺的是「字体 bounding box」(ascent+descent,
 *   常 >1em)。两者差多少**逐字体而异** → 任何写死的比例(曾经的 62% 渐变)换本书就偏。
 *   探针另外证实:`::highlight()`(CSS Custom Highlight API)和原生选区画的也是行内盒,换不掉。
 *   所以正解只能是「让画出来的带子 = 父 span 的行盒」,本脚本就断言这一条。
 *
 * 跑:node scripts/pdf-highlight-geometry.check.cjs
 *    换真书:PDF=~/Downloads/LN-CMP.pdf PAGE=2 Q='Things you should be able to do' node scripts/...
 * 何时跑:动 pdfAnnotator.css 的 .highlight 规则 / 动 hlBand.ts / 升 pdfjs-dist 之后。
 */
const fs = require('fs')
const os = require('os')
const http = require('http')
const path = require('path')
const { chromium } = require('playwright-core')
const { tinyPdf } = require('./lib/tiny-pdf.cjs')

const ROOT = path.join(__dirname, '..')
const R = (p) => path.join(ROOT, p)
const SCALE = 1.5
const TOL = 1.5 // px:带子与行盒的允差(亚像素取整 + border-radius)

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

// 与 PdfAnnotator.ensureScopedCss 同一套作用域改写(那边是运行时,这里照抄一份)
const scopePdfCss = (css) =>
  `@scope (.pdfa-root) {\n${css.replace(/:root\b/g, ':scope').replace(/--viewer-container-height:\s*0;/g, '')}\n}`

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

// 生产代码本体(hlBand.ts)现打现用,保证台架量的就是线上那份;还没有就退化成空实现(红跑用)
function bundleHlBand() {
  const src = R('frontend/src/amadeus/pdf/hlBand.ts')
  if (!fs.existsSync(src)) return 'export const paintHlBands = () => {}\n'
  const out = require('esbuild').buildSync({
    entryPoints: [src], bundle: true, format: 'esm', write: false, target: 'chrome120',
  })
  return out.outputFiles[0].text
}

const MAIN_JS = `
import * as pdfjsLib from '/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from '/node_modules/pdfjs-dist/legacy/web/pdf_viewer.mjs'
import { paintHlBands } from '/hlband.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
const nextTick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

window.run = async ({ page, q }) => {
  const container = document.getElementById('vc')
  const eventBus = new EventBus()
  const linkService = new PDFLinkService({ eventBus })
  const findController = new PDFFindController({ linkService, eventBus })
  const viewer = new PDFViewer({ container, eventBus, linkService, findController, annotationEditorMode: -1 })
  linkService.setViewer(viewer)
  const doc = await pdfjsLib.getDocument({ url: '/doc.pdf' }).promise
  const loaded = new Promise((r) => eventBus.on('pagesloaded', r, { once: true }))
  viewer.setDocument(doc); linkService.setDocument(doc, null); findController.setDocument(doc)
  eventBus.on('pagesinit', () => { viewer.currentScaleValue = '${SCALE}'; if (page > 1) viewer.currentPageNumber = page }, { once: true })
  await loaded
  if (page > 1) viewer.currentPageNumber = page
  await nextTick()
  const matched = new Promise((r) => eventBus.on('updatetextlayermatches', r, { once: true }))
  eventBus.dispatch('find', { source: window, type: '', query: q, caseSensitive: false,
    entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false })
  await Promise.race([matched, new Promise((r) => setTimeout(r, 4000))])
  await nextTick()
  paintHlBands(document) // 生产里挂在 updatetextlayermatches/textlayerrendered 上(PdfAnnotator)
  window.__viewer = viewer
  if (window.__debug) {
    const el = document.querySelector('.textLayer .highlight')
    const cs = getComputedStyle(el, '::before')
    window.__dbg = { hlw: el.style.getPropertyValue('--hl-w'), content: cs.content, pos: cs.position,
      w: cs.width, h: cs.height, bg: cs.backgroundColor, display: cs.display, elDisplay: getComputedStyle(el).display }
  }
  return document.querySelectorAll('.textLayer .highlight').length
}

/** 逐条高亮:父行盒 / 画布上的字迹 / 我们画出来的黄带 —— 一律换算到「画布左上角」为原点的 CSS px。
 *  ⚠️ 坐标原点只能取画布:pdf.js 的 .page 带边框,page 与 canvas 的原点差好几 px(踩过)。 */
window.measure = async (b64) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode()
  const shot = document.createElement('canvas'); shot.width = img.width; shot.height = img.height
  const sctx = shot.getContext('2d'); sctx.drawImage(img, 0, 0)
  const sd = sctx.getImageData(0, 0, shot.width, shot.height).data
  if (window.__debug) { // DBG=1:带子到底画到哪、成色多少、身上还压着谁的底色(两次都是靠这段定位的)
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0
    for (let y = 0; y < shot.height; y++) for (let x = 0; x < shot.width; x++) {
      const i = (y * shot.width + x) * 4
      if (sd[i] > 120 && sd[i] - sd[i + 2] > 40 && sd[i + 1] - sd[i + 2] > 30) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    }
    const px = (x, y) => { const i = (y * shot.width + x) * 4; return [sd[i], sd[i + 1], sd[i + 2], sd[i + 3]] }
    const anc = []
    for (let e = document.querySelector('.textLayer .highlight'); e && e !== document.body; e = e.parentElement) {
      const g = getComputedStyle(e)
      if (g.filter !== 'none' || g.opacity !== '1' || g.mixBlendMode !== 'normal' || g.backgroundColor !== 'rgba(0, 0, 0, 0)')
        anc.push((e.className || e.tagName) + ' filter:' + g.filter + ' op:' + g.opacity + ' blend:' + g.mixBlendMode + ' bg:' + g.backgroundColor)
    }
    window.__yellow = { n, box: [x0, y0, x1, y1], 祖先: anc, shot: [shot.width, shot.height],
      样点: n ? { 带心: px(Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)), 带角: px(x0 + 2, y0 + 2),
        带上方: px(x0 + 2, y0 - 6), 页面空白: px(x1 + 40, y0 + 10), 带右下: px(x1 - 2, y1 - 2) } : null }
  }
  const out = []
  for (const hl of document.querySelectorAll('.textLayer .highlight')) {
    const cv = hl.closest('.page').querySelector('canvas')
    const cr = cv.getBoundingClientRect()
    const dpr = cv.width / cr.width // 画布像素 / CSS px(pdf.js 按 outputScale 放大画布)
    // 行盒 = 那条绝对定位的 textDiv:整段命中时类就打在它身上,部分命中时是它的父
    const lineEl = getComputedStyle(hl).position === 'absolute' ? hl : hl.parentElement
    const par = lineEl.getBoundingClientRect()
    const r = hl.getBoundingClientRect()
    const L = (v) => +(v - cr.top).toFixed(1) // 纵向:→ 画布原点
    const xa = Math.max(0, r.left - cr.left), xb = Math.min(cr.width, r.right - cr.left)
    // 扫描窗按行高定,不能写死 px:真书行距 19px,±24px 会把上下两行的字迹和黄带一起吸进来(踩过)
    const lh = par.height
    const yTop = Math.max(0, par.top - cr.top - lh), yBot = Math.min(cr.height, par.bottom - cr.top + lh)
    // 字迹:画布上该列区间里「暗」的行
    const cctx = cv.getContext('2d', { willReadFrequently: true })
    const cw = Math.max(1, Math.round((xb - xa) * dpr)), ch = Math.max(1, Math.round((yBot - yTop) * dpr))
    const cd = cctx.getImageData(Math.round(xa * dpr), Math.round(yTop * dpr), cw, ch).data
    let iT = null, iB = null
    for (let y = Math.round((par.top - cr.top - yTop - lh * 0.15) * dpr); y < Math.min(ch, Math.round((par.bottom - cr.top - yTop + lh * 0.15) * dpr)); y++) for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4
      if (cd[i + 3] > 40 && (cd[i] * 0.3 + cd[i + 1] * 0.59 + cd[i + 2] * 0.11) < 140) {
        if (iT === null) iT = +(yTop + y / dpr).toFixed(1); iB = +(yTop + (y + 1) / dpr).toFixed(1); break
      }
    }
    // 黄带:截图里该列区间中「发黄」的行(255,226,92 multiply 到白纸 ≈ 255,242,165)
    const sx0 = Math.round(cr.left + xa), sw = Math.max(1, Math.round(xb - xa))
    const yellow = []
    for (let y = Math.round(yTop); y < Math.round(yBot); y++) {
      const sy = Math.round(cr.top) + y
      let hit = false
      for (let x = 0; x < sw; x++) {
        const i = (sy * shot.width + sx0 + x) * 4
        if (sd[i] > 120 && sd[i] - sd[i + 2] > 40 && sd[i + 1] - sd[i + 2] > 30) { hit = true; break } // 偏黄:红绿明显高于蓝
      }
      yellow.push(hit)
    }
    // 只取「包含本行中心」的那一段连续黄:相邻行也可能有带子,不切开就量成一整条
    const mid = Math.round((par.top + par.bottom) / 2 - cr.top - yTop)
    let bT = null, bB = null
    if (yellow[mid]) {
      let a = mid, b = mid
      while (a > 0 && yellow[a - 1]) a--
      while (b < yellow.length - 1 && yellow[b + 1]) b++
      bT = Math.round(yTop) + a; bB = Math.round(yTop) + b + 1
    }
    // 横向:取「包含本段中心」的连续有带列 —— 防宽度算错时整行变黄却不报。
    // ⚠️ v4(multiply overlay)后墨迹**不再染黄**:单行扫描会被字形笔画切断(v3 时代字上有黄可用)。
    //   改成「带内任一行该列发黄」:行盒比字高(上下有留白),字形几乎不可能吃满整列。
    let hL = null, hR = null
    if (bT !== null) {
      const gx0 = Math.max(0, Math.round(cr.left + par.left - cr.left - 4)), gx1 = Math.min(shot.width - 1, Math.round(cr.left + (par.right - cr.left) + 4))
      const cxm = Math.round(cr.left + (r.left + r.right) / 2 - cr.left)
      const yel = (x) => {
        for (let y = Math.round(bT) + 1; y < Math.round(bB) - 1; y++) {
          const i = ((Math.round(cr.top) + y) * shot.width + x) * 4
          if (sd[i] > 120 && sd[i] - sd[i + 2] > 40 && sd[i + 1] - sd[i + 2] > 30) return true
        }
        return false
      }
      if (yel(cxm)) {
        let a = cxm, b = cxm
        while (a > gx0 && yel(a - 1)) a--
        while (b < gx1 && yel(b + 1)) b++
        hL = +(a - cr.left).toFixed(1); hR = +(b + 1 - cr.left).toFixed(1)
      }
    }
    // 带子在**白纸上**的成色:pdf.js 自带的墨绿底(--highlight-*-bg-color)若没关干净,
    // 黄叠墨绿 = 橄榄色,几何再准也难看 —— 这条专门盯那个(08-28 真踩过)。
    let paper = null
    if (bT !== null) {
      const row = Math.round((bT + bB) / 2)
      for (let x = Math.round(xa) + 1; x < Math.round(xb) - 1 && !paper; x++) {
        const ci = cctx.getImageData(Math.round(x * dpr), Math.round(row * dpr), 1, 1).data
        if (ci[0] > 240 && ci[1] > 240 && ci[2] > 240) { // 这一点画布是白纸(没字)
          const i = ((Math.round(cr.top) + row) * shot.width + Math.round(cr.left) + x) * 4
          paper = [sd[i], sd[i + 1], sd[i + 2]]
        }
      }
    }
    // 带内**墨迹**的成色:v4 的核心承诺 —— multiply 真混,字保持纯黑;半透明叠色(v3)会把字
    // 染成褐黄 rgb(173,141,35) 量级,这条当场红。取带内画布上确定是字迹的一点,采截图同点。
    let inkShot = null
    if (bT !== null) {
      outer: for (let y = Math.round(bT) + 1; y < Math.round(bB) - 1; y++) {
        for (let x = Math.round(xa) + 1; x < Math.round(xb) - 1; x++) {
          const ci = cctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
          if (ci[3] > 40 && (ci[0] * 0.3 + ci[1] * 0.59 + ci[2] * 0.11) < 90) {
            const i = ((Math.round(cr.top) + y) * shot.width + Math.round(cr.left) + x) * 4
            inkShot = [sd[i], sd[i + 1], sd[i + 2]]
            break outer
          }
        }
      }
    }
    out.push({
      paper, inkShot,
      x: [+(r.left - cr.left).toFixed(1), +(r.right - cr.left).toFixed(1)], bandX: hL === null ? null : [hL, hR],
      cls: hl.className, pos: getComputedStyle(hl).position,
      parentPos: getComputedStyle(hl.parentElement).position, dpr: +dpr.toFixed(3),
      box: [L(r.top), L(r.bottom)], line: [L(par.top), L(par.bottom)],
      ink: iT === null ? null : [iT, iB], band: bT === null ? null : [bT, bB],
    })
  }
  return out
}
`

const HTML = (pdfCss, ourCss) => `<!doctype html><html><head><meta charset="utf-8"><title>hl geometry</title>
<style>${scopePdfCss(pdfCss)}</style>
<style>${ourCss}</style>
<style>/* ⚠️ 照抄 app 的全局 reset:少了这一行,台架会把「文本层比画布大 7%」这种错判成绿(08-28 踩过) */
 *,*::before,*::after{box-sizing:border-box}
 html,body{margin:0;background:#fff}
 .pdfa-root{position:relative;width:1000px;height:900px}
 #vc{position:absolute;inset:0;overflow:auto}</style>
</head><body><div class="pdfa-root"><div id="vc"><div id="viewer" class="pdfViewer"></div></div></div>
<script type="module" src="/main.js"></script></body></html>`

;(async () => {
  const pdfPath = process.env.PDF && process.env.PDF.replace(/^~/, os.homedir())
  // 夹具两个要点,少一个断言就分辨不出错:
  //  · 同一行两个 Tj(中间 Td)→ 匹配跨两个 span(begin/middle/end 结构),真书里最常见的形态;
  //  · 前后各留一个词(Alpha/Omega)→ 命中只占 item 的**一截**,否则 --hl-w 恒 100%,横向断言恒真;
  //  · Td 的位移要留出词间空档(125:太小 → 两段字重叠,pdf.js 不补合成空格,查询就永远不命中)。
  const doc = pdfPath ? fs.readFileSync(pdfPath) : tinyPdf([['Alpha Things you', [125, 0], 'should be able to do Omega']])
  const q = process.env.Q || 'Things you should be able to do'
  const pageNum = Number(process.env.PAGE || 1)
  const pdfCss = fs.readFileSync(R('node_modules/pdfjs-dist/legacy/web/pdf_viewer.css'), 'utf8')
  const ourCss = fs.readFileSync(R('frontend/src/amadeus/pdf/pdfAnnotator.css'), 'utf8')
  const html = HTML(pdfCss, ourCss)
  const hlband = bundleHlBand()

  const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf' }
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    if (url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html)
    if (url === '/main.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(MAIN_JS)
    if (url === '/hlband.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(hlband)
    if (url === '/doc.pdf') return res.writeHead(200, { 'content-type': 'application/pdf' }).end(doc)
    const f = path.join(ROOT, decodeURIComponent(url))
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.log('  [page error]', e.message))
  await page.goto(`http://127.0.0.1:${port}/`)
  if (process.env.DBG) await page.evaluate(() => { window.__debug = true })
  const n = await page.evaluate((a) => window.run(a), { page: pageNum, q })
  if (process.env.DBG) console.log('  [dbg]', JSON.stringify(await page.evaluate(() => window.__dbg)))
  console.log(`文档:${pdfPath || '内置夹具'} p.${pageNum}  查「${q}」→ ${n} 个 .highlight\n`)
  check('找到高亮(find 命中)', n > 0, `n=${n}`)
  if (!n) { await browser.close(); server.close(); process.exit(1) }

  const shot = (await page.screenshot()).toString('base64')
  const ms = await page.evaluate((b) => window.measure(b), shot)
  if (process.env.DBG) console.log('  [dbg 全图黄]', JSON.stringify(await page.evaluate(() => window.__yellow)))
  if (process.env.SHOT) { // 观感自查用:只截高亮那一带(几何全绿 ≠ 看着对,DESIGN.md §8)
    const box = await page.evaluate(() => {
      const r = document.querySelector('.textLayer .highlight').getBoundingClientRect()
      return { x: Math.max(0, r.left - 60), y: Math.max(0, r.top - 30), width: Math.min(880, r.width + 260), height: r.height + 60 }
    })
    fs.writeFileSync(process.env.SHOT, await page.screenshot({ clip: box }))
    console.log(`  截图 → ${process.env.SHOT}`)
  }

  // C0 文本层必须与画布同尺寸:pdf.js 按 content-box 写的样式碰上 app 的 border-box reset
  //    会让文本层整层比画布大 7%(.page 的 9px 边框),高亮/选区/笔迹全跟着偏。
  const lay = await page.evaluate(() => {
    // 取「有高亮的那一页」:跳页后前面的页可能还没渲染,textLayer/canvas 都还不存在
    const pg = document.querySelector('.textLayer .highlight').closest('.page')
    const t = pg.querySelector('.textLayer').getBoundingClientRect(), c = pg.querySelector('canvas').getBoundingClientRect()
    return { t: [+t.width.toFixed(1), +t.height.toFixed(1)], c: [+c.width.toFixed(1), +c.height.toFixed(1)],
      dx: +(t.left - c.left).toFixed(1), dy: +(t.top - c.top).toFixed(1) }
  })
  check('文本层与画布同尺寸同原点', Math.abs(lay.t[0] - lay.c[0]) <= 1 && Math.abs(lay.t[1] - lay.c[1]) <= 1
    && Math.abs(lay.dx) <= 1 && Math.abs(lay.dy) <= 1, `文本层=${lay.t} 画布=${lay.c} 原点差=[${lay.dx},${lay.dy}]`)

  // C0b 落地提醒动画必须由调用方显式开(paintHlBands 的 pulse 形参):滚动/缩放会一路发
  //     textlayerrendered → 带子 DOM 重建,默认带动画就是「一滚一闪」;而且动画期间 opacity 在动,
  //     本台架下面那些取色断言会随相位漂。本台架直调 paintHlBands(document) 不传 pulse。
  const anim = await page.evaluate(() => {
    const b = document.querySelector('.pdfa-citehl-band')
    return b ? { name: getComputedStyle(b).animationName, cls: b.className } : null
  })
  check('默认重画不放提醒动画(pulse 由调用方显式开)',
    !!anim && anim.name === 'none' && !/is-pulse/.test(anim.cls), JSON.stringify(anim))

  // C1 前提:每条高亮的**包含块**都是绝对定位元素(整段命中 → 类直接打在 textDiv 上,自己就是;
  //         部分命中 → 是 .appended 行内子元素,包含块是父 textDiv)。伪元素的 top:0/bottom:0 靠这条。
  check('高亮的包含块是绝对定位的行盒',
    ms.every((m) => (m.pos === 'absolute' ? true : m.parentPos === 'absolute')),
    ms.map((m) => `${m.pos}/${m.parentPos}`).join(' '))
  console.log(`  (画布像素/CSS px = ${ms[0].dpr})`)
  // C2 跨 span:真书里的匹配几乎都跨 span,夹具也要覆盖
  check('匹配跨 span(≥2 段高亮)', ms.length >= 2, `${ms.length} 段`)

  for (const [i, m] of ms.entries()) {
    const tag = `#${i + 1}[${m.cls.replace(/ appended/, '')}]`
    if (!m.band) { check(`${tag} 量到黄带`, false, 'band=null'); continue }
    const dT = +(m.band[0] - m.line[0]).toFixed(1), dB = +(m.band[1] - m.line[1]).toFixed(1)
    console.log(`  ${tag} 行盒=[${m.line}] 字迹=[${m.ink || '空档'}] 行内盒=[${m.box}] 黄带=[${m.band}]  Δ顶=${dT} Δ底=${dB}`)
    // C3 行盒里确实有字(黄带盖的是正文,不是空白)。ink=null = 落在两个 item 中间的空档,跳过。
    //    「行盒是否恰好包住字迹」是 pdf.js 自己的事(夹具那种独立行上验过),真书行距密,量窗切不干净。
    if (m.ink) check(`${tag} 行盒里有字迹`, m.ink[1] > m.line[0] && m.ink[0] < m.line[1])
    // C4 我们的契约:画出来的黄带 = 行盒(纵)× 命中那截(横)
    check(`${tag} 黄带贴合行盒(±${TOL}px)`, Math.abs(dT) <= TOL && Math.abs(dB) <= TOL, `Δ顶=${dT} Δ底=${dB}`)
    // 同一行上相邻的两段黄本来就该连成一条 → 横向按「本行所有命中段的并集」量:
    // 带子要盖住本段,又不许越出本行命中范围(--hl-w 算错成整行宽,这里会红)。
    // 成色:亮黄(允差给得宽,只拦「叠了别的底色」这种量级的错)
    if (m.paper) check(`${tag} 白纸上是批注同款亮黄 rgb(${m.paper})`, m.paper[0] >= 245 && m.paper[1] >= 200 && m.paper[2] >= 50 && m.paper[2] <= 130)
    // v4 核心承诺:multiply 真混,带内字迹保持深色(v3 半透明叠色 ≈ luma 122-139,这里会红)
    if (m.inkShot) check(`${tag} 带内墨迹保持深色 rgb(${m.inkShot})`, m.inkShot[0] * 0.3 + m.inkShot[1] * 0.59 + m.inkShot[2] * 0.11 < 110)
    const sib = ms.filter((o) => Math.abs(o.line[0] - m.line[0]) < 1)
    const uL = Math.min(...sib.map((o) => o.x[0])), uR = Math.max(...sib.map((o) => o.x[1]))
    check(`${tag} 黄带盖住本段且不越出本行命中范围`,
      !!m.bandX && m.bandX[0] <= m.x[0] + TOL && m.bandX[1] >= m.x[1] - TOL && m.bandX[0] >= uL - TOL && m.bandX[1] <= uR + TOL,
      m.bandX ? `本段=[${m.x}] 黄带=[${m.bandX}] 本行命中并集=[${uL},${uR}]` : 'bandX=null')
  }

  await browser.close()
  server.close()
  console.log(failed ? `\n${failed} 项不合格` : '\n全部合格')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
