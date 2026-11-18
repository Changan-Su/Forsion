// 图片工具条(2026-11-17「页面编辑对齐 Notion」第 4 条,方案 docs/ToBeImproved/Notion页面编辑对齐方案_2026-11-17 §4):
// 悬停出工具条(左 / 中 / 右 · 说明 · 替换 · 全屏 · 下载 · `</>` · ⋯)、两侧缩放把手、图下说明、手机贴底一排。
// 存法:宽度 `![alt|宽度](…)`、对齐 = 段首 `<span data-amadeus-align>`、说明 = 图片 title `![alt](src "说明")`。
// 真 v4 统一编辑器(`?upage`)+ 生产存盘链(writes 里是落盘文本);图片地址经 __assets 指向 /__img/<ref>(page.route 回真 PNG)。
// 纯函数 / 转义那一半在 vitest:frontend/src/amadeus/blocks/markdown/mdImageToolbar.test.ts、shared/amadeus/assets.test.ts。
//
// 用法:npm run check:imagetoolbar(= node scripts/e2e-editor.cjs --check=image-toolbar)
//      5173 被别的检出占着时:HARNESS_URL=http://localhost:<port>/harness.html;截图:SHOT_DIR=<目录>
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const ORIGIN = URL.split('/').slice(0, 3).join('/')
const SHOT = process.env.SHOT_DIR || ''
if (SHOT) fs.mkdirSync(SHOT, { recursive: true })
const PM = '.unified-body .ProseMirror'
const WRAP = `${PM} .wiki-inline-img-wrap`
const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`)
}
// 纯色 PNG;文件名里的 w<N> / h<N> 定尺寸
const png = (W, H) => {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((W * 3 + 1) * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw.set([143 + (x * 60 / W | 0), 169, 201 - (y * 50 / H | 0)], y * (W * 3 + 1) + 1 + x * 3)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const sizeOf = (name) => [+(/w(\d+)/.exec(name)?.[1] ?? 640), +(/h(\d+)/.exec(name)?.[1] ?? 360)]

async function open(ctx, seed, file = 'Pic.md', query = 'upage') {
  const p = await ctx.newPage()
  p.setDefaultTimeout(15000)
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.route(`${ORIGIN}/__img/**`, (r) => {
    const name = decodeURIComponent(r.request().url().split('/__img/')[1])
    r.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: png(...sizeOf(name)) })
  })
  await p.goto(`${URL}?${query}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await p.waitForSelector(PM, { timeout: 180000 })
  await p.evaluate(() => {
    const base = `${location.origin}/__img/`
    window.__assets.setUrlBuilder((ref) => base + encodeURIComponent(ref), (url) => (url.startsWith(base) ? decodeURIComponent(url.slice(base.length)) : null))
  })
  await reopen(p, seed, file)
  return { p, errs }
}
async function reopen(p, text, file = 'Pic.md') {
  await p.evaluate(({ file, text }) => window.__upage.switchFile(file, text), { file, text })
  await p.waitForFunction((s) => [...document.querySelectorAll(s + ' img.wiki-inline-img')].some((i) => i.complete && i.naturalWidth > 0), PM, { timeout: 15000 })
  await p.mouse.move(2, 2)
  await p.waitForTimeout(250)
}
/** 立刻落盘,取盘上的正文(writes 里最后一份)。 */
const saved = (p) => p.evaluate(async () => { await window.__upage.probe.flush(); return window.__upage.writes.at(-1)?.text ?? '' })
const box = (p, sel) => p.evaluate((sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2, r: r.right, b: r.bottom }
}, sel)
const tbState = (p) => p.evaluate((W) => {
  const tb = document.querySelector(W + ' > .amx-img-tb')
  if (!tb) return null
  const cs = getComputedStyle(tb)
  return { op: +cs.opacity, pe: cs.pointerEvents, acts: [...tb.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.dataset.act), pressed: [...tb.querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.act), titles: [...tb.querySelectorAll('button')].map((b) => b.title) }
}, WRAP)
async function hover(p) {
  const r = await box(p, `${WRAP} > img`)
  await p.mouse.move(r.x + 30, r.y + r.h - 20)
  await p.waitForTimeout(250)
}
async function tb(p, act) {
  await hover(p)
  await p.click(`${WRAP} > .amx-img-tb [data-act="${act}"]`)
  await p.waitForTimeout(200)
}
async function drag(p, sel, dx) {
  const h = await box(p, sel)
  await p.mouse.move(h.cx, h.cy)
  await p.mouse.down()
  await p.mouse.move(h.cx + dx / 2, h.cy, { steps: 4 })
  await p.mouse.move(h.cx + dx, h.cy, { steps: 4 })
  const during = await box(p, sel)
  await p.mouse.up()
  await p.waitForTimeout(250)
  return { start: h, during }
}
const imgW = async (p) => Math.round((await box(p, `${WRAP} > img`)).w)
const RIGHT = `${WRAP} > .amx-img-resize:not(.amx-img-resize--left)`
const LEFT = `${WRAP} > .amx-img-resize--left`

const SEED = '# 发布说明\n\n上周的数据如下。\n\n![新版主页|320](home-w640-h360.png)\n\n## 风险\n\n后文。\n'
const LINE = (md) => (md.split('\n').find((l) => l.includes('home-w640')) ?? '')

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 860 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] })
    let { p, errs } = await open(ctx, SEED)

    // ── T1 悬停出工具条(第一次悬停才建;移开后透明且不吃点击) ──
    let s = await tbState(p)
    check('T1 没悬停过:还没建工具条(长笔记不给每张图先挂一排按钮)', s === null, s)
    await hover(p)
    await p.mouse.move(2, 2)
    await p.waitForTimeout(250)
    s = await tbState(p)
    check('T1 移开:工具条透明且不吃点击', s && s.op === 0 && s.pe === 'none', s)
    await hover(p)
    s = await tbState(p)
    check('T1 悬停:工具条浮现', s && s.op === 1 && s.pe === 'auto', s)
    check('T1 一排按钮:左 / 中 / 右 · 说明 · 替换 · 全屏 · 下载 · </> · ⋯', JSON.stringify(s?.acts) === JSON.stringify(['alignLeft', 'alignCenter', 'alignRight', 'caption', 'replace', 'fullscreen', 'download', 'source', 'more']), s?.acts)
    check('T1 缺省左对齐高亮', JSON.stringify(s?.pressed) === '["alignLeft"]', s?.pressed)
    const tbr = await box(p, `${WRAP} > .amx-img-tb`), ir = await box(p, `${WRAP} > img`)
    check('T1 工具条在图片右上角里面', tbr && Math.abs(tbr.r - (ir.r - 8)) < 3 && tbr.y >= ir.y && tbr.y - ir.y < 14, { tbr, ir })
    check('T1 旧的单颗 `</>` 不再另挂', await p.locator(`${WRAP} > .amx-src-btn`).count() === 0)
    // 包裹层比图片高出图片自己的上下外边距(既有样式);说明为空时不许再多出一截。T3 清空说明后对照这个数。
    const gap0 = (await box(p, WRAP)).h - ir.h
    check('T1 空说明不占位:包裹层只比图片多出图片自己的外边距', gap0 >= 0 && gap0 <= 12.5, { wrap: await box(p, WRAP), ir })
    if (SHOT) await p.screenshot({ path: path.join(SHOT, 'hover.png') })

    // ── T2 对齐:落盘 = 段首对齐标记;几何真的居中 / 靠右;回左对齐标记消失 ──
    const col = await box(p, `${PM} > p`)
    await tb(p, 'alignCenter')
    let md = await saved(p)
    check('T2 居中落盘为段首对齐标记', LINE(md) === '<span data-amadeus-align="center"></span>![新版主页|320](home-w640-h360.png)', LINE(md))
    let r = await box(p, `${WRAP} > img`)
    check('T2 图片几何居中', Math.abs(r.cx - col.cx) < 3, { img: r.cx, col: col.cx })
    s = await tbState(p)
    check('T2 工具条高亮跟到「居中」', JSON.stringify(s?.pressed) === '["alignCenter"]', s?.pressed)
    await tb(p, 'alignRight')
    md = await saved(p)
    r = await box(p, `${WRAP} > img`)
    check('T2 靠右:标记 + 几何', LINE(md).startsWith('<span data-amadeus-align="right"></span>![') && Math.abs(r.r - col.r) < 3, { line: LINE(md), r: r.r, col: col.r })
    await tb(p, 'alignLeft')
    md = await saved(p)
    check('T2 回到左对齐:标记消失(缺省左,存量不变)', LINE(md) === '![新版主页|320](home-w640-h360.png)', LINE(md))
    await p.evaluate(() => window.__upage.probe.view().focus())
    await p.keyboard.press('Meta+z')
    md = await saved(p)
    check('T2 撤销一步回到靠右', LINE(md).startsWith('<span data-amadeus-align="right"></span>'), LINE(md))
    await tb(p, 'alignLeft')

    // ── T3 说明:输入 → 回车 → title 落盘(转义) → 图下灰字 → 重开逐字 ──
    await tb(p, 'caption')
    let line = await p.evaluate((W) => { const i = document.querySelector(W + ' > .amx-img-capline'); return i ? { focused: document.activeElement === i, value: i.value, ph: i.placeholder } : null }, WRAP)
    check('T3 点「说明」:图下出输入行并聚焦', line && line.focused && line.value === '' && line.ph === '写个说明…', line)
    s = await tbState(p)
    const capIn = await box(p, `${WRAP} > .amx-img-capline`), imgB = await box(p, `${WRAP} > img`)
    check('T3 输入行在图片下面', capIn && capIn.y >= imgB.b - 1, { capIn, imgB })
    const CAP = '新版主页 · "Team Desk" 视图 \\ 草稿'
    await p.keyboard.type(CAP)
    await p.keyboard.press('Enter')
    await p.waitForTimeout(200)
    md = await saved(p)
    check('T3 说明写进 title,双引号转义', LINE(md) === '![新版主页|320](home-w640-h360.png "新版主页 · \\"Team Desk\\" 视图 \\ 草稿")', LINE(md))
    const cap = await p.evaluate((W) => { const c = document.querySelector(W + ' > .amx-img-cap'); const cs = getComputedStyle(c); return { text: c.textContent, hidden: c.hidden, color: cs.color, body: getComputedStyle(document.querySelector('.unified-body .ProseMirror p')).color } }, WRAP)
    check('T3 图下显示说明(灰字,与正文不同色)', cap.text === CAP && !cap.hidden && cap.color !== cap.body, cap)
    const capB = await box(p, `${WRAP} > .amx-img-cap`), imgC = await box(p, `${WRAP} > img`)
    check('T3 说明在图片正下方', capB.y >= imgC.b && capB.y - imgC.b < 12 && Math.abs(capB.w - imgC.w) < 1.5, { capB, imgC })
    const md3 = md
    await reopen(p, md3, 'Reopened.md')
    const cap2 = await p.evaluate((W) => document.querySelector(W + ' > .amx-img-cap')?.textContent, WRAP)
    check('T3 重开显示同一句说明', cap2 === CAP, cap2)
    await p.evaluate(() => { const v = window.__upage.probe.view(); let at = -1; v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('后文')) at = pos + 2 }); v.dispatch(v.state.tr.insertText('X', at)) })
    md = await saved(p)
    check('T3 重开后编辑别处再存:图片这一行逐字不变', LINE(md) === LINE(md3) && md.includes('后文X'), LINE(md))
    // Esc 取消 / 失焦提交 / 清空去掉 title
    await tb(p, 'caption')
    await p.keyboard.press('Meta+a')
    await p.keyboard.type('不要了')
    await p.keyboard.press('Escape')
    md = await saved(p)
    check('T3 Esc 取消:说明不变', LINE(md) === LINE(md3), LINE(md))
    await tb(p, 'caption')
    await p.keyboard.press('Meta+a')
    await p.keyboard.type('失焦也提交')
    await p.mouse.click(col.x + 5, (await box(p, `${PM} h2`)).cy)
    await p.waitForTimeout(200)
    md = await saved(p)
    check('T3 失焦提交', LINE(md).endsWith('"失焦也提交")'), LINE(md))
    // 长说明不把包裹层撑宽(撑宽了右把手就离开图片右缘)
    await tb(p, 'caption')
    await p.keyboard.press('Meta+a')
    await p.keyboard.type('很长的一句说明 '.repeat(12))
    await p.keyboard.press('Enter')
    await p.waitForTimeout(250)
    let wr = await box(p, WRAP), im = await box(p, `${WRAP} > img`)
    check('T3 长说明:包裹层宽 = 图片宽', Math.abs(wr.w - im.w) < 1.5, { wr: wr.w, im: im.w })
    await hover(p)
    let rh = await box(p, RIGHT), lh = await box(p, LEFT)
    check('T4 两侧都有把手,竖直居中于图片(不被说明撑偏)', rh && lh && Math.abs(rh.cy - im.cy) < 2 && Math.abs(lh.cy - im.cy) < 2 && Math.abs(rh.cx - im.r) < 3 && Math.abs(lh.cx - im.x) < 3, { rh, lh, im })
    if (SHOT) await p.screenshot({ path: path.join(SHOT, 'caption.png') })
    await tb(p, 'caption')
    await p.keyboard.press('Meta+a')
    await p.keyboard.press('Backspace')
    await p.keyboard.press('Enter')
    md = await saved(p)
    wr = await box(p, WRAP); im = await box(p, `${WRAP} > img`)
    check('T3 清空说明 = 去掉 title,不占位', LINE(md) === '![新版主页|320](home-w640-h360.png)' && Math.abs(wr.h - im.h - gap0) < 1, { line: LINE(md), wr: wr.h, im: im.h, gap0 })

    // ── T4 两侧把手缩放:落盘 `|宽度`;左把手往左拖变宽;居中时把手跟着指针走;撤销 ──
    await hover(p)
    let d = await drag(p, RIGHT, 60)
    md = await saved(p)
    check('T4 右把手 +60 → `|380`', LINE(md) === '![新版主页|380](home-w640-h360.png)' && await imgW(p) === 380, LINE(md))
    await hover(p)
    d = await drag(p, LEFT, -40)
    md = await saved(p)
    check('T4 左把手往左拖 40 → 变宽 `|420`', LINE(md) === '![新版主页|420](home-w640-h360.png)' && await imgW(p) === 420, LINE(md))
    await tb(p, 'alignCenter')
    await hover(p)
    d = await drag(p, RIGHT, 30)
    md = await saved(p)
    check('T4 居中图右把手 +30 → 两边同时外扩 `|480`', LINE(md) === '<span data-amadeus-align="center"></span>![新版主页|480](home-w640-h360.png)', LINE(md))
    check('T4 居中图拖动中把手跟着指针', Math.abs(d.during.cx - (d.start.cx + 30)) < 3, { start: d.start.cx, during: d.during.cx })
    await hover(p)
    d = await drag(p, LEFT, 20)
    check('T4 居中图左把手往里拖 20 → `|440`,把手跟手', /\|440\]/.test(LINE(await saved(p))) && Math.abs(d.during.cx - (d.start.cx + 20)) < 3, { line: LINE(await saved(p)), d })
    await p.evaluate(() => window.__upage.probe.view().focus())
    await p.keyboard.press('Meta+z')
    md = await saved(p)
    check('T4 撤销一步回到 `|480`', /\|480\]/.test(LINE(md)), LINE(md))
    await tb(p, 'alignLeft')

    // ── T5 `</>`:源码行带上说明;Esc 不落盘 ──
    await reopen(p, '前文\n\n![封面|300](home-w640-h360.png "说 \\"明\\"")\n\n后文\n', 'Src.md')
    const before5 = await saved(p)
    await tb(p, 'source')
    const src = await p.evaluate((W) => document.querySelector(W + ' > .amx-img-srcline')?.value, WRAP)
    check('T5 `</>` 源码行 = 原文(含说明)', src === '![封面|300](home-w640-h360.png "说 \\"明\\"")', src)
    await p.keyboard.press('Escape')
    check('T5 Esc 不落盘', (await saved(p)) === before5)
    await tb(p, 'source')
    await p.keyboard.press('Meta+a')
    await p.keyboard.type('![封面|300](home-w640-h360.png "新 \\\\ 说明")')
    await p.keyboard.press('Enter')
    md = await saved(p)
    // 框里写 `\\` = 一个反斜杠;落盘时后面跟的是空格,CommonMark 不用转义,写回一个
    check('T5 源码行改说明 → title 跟着改', md.includes('![封面|300](home-w640-h360.png "新 \\ 说明")') && await p.evaluate((W) => document.querySelector(W + ' > .amx-img-cap')?.textContent, WRAP) === '新 \\ 说明', md)

    // T5b 多行 / 首尾空格的说明:「说明」「源码」没改就回车,盘上原样(单行框不许悄悄改写)
    // (多行 title 的图显示管线逐行换地址,本来就换不成显示地址 —— 既有限制;台架给裸路径也供一张图,免得是破图)
    await p.route(`${ORIGIN}/home-w640-h360.png`, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png(640, 360) }))
    for (const ML of ['![封面|300](home-w640-h360.png "first\nsecond")', '![封面|300](home-w640-h360.png "  spaced  ")']) {
      await p.evaluate(({ text, file }) => window.__upage.switchFile(file, text), { text: `前文\n\n${ML}\n\n后文\n`, file: ML.includes('\n') ? 'Multi.md' : 'Spaced.md' })
      await p.waitForFunction((s) => [...document.querySelectorAll(s + ' img.wiki-inline-img')].some((i) => i.complete && i.naturalWidth > 0), PM, { timeout: 15000 })
      await p.mouse.move(2, 2)
      await p.waitForTimeout(300)
      await tb(p, 'caption')
      const shown = await p.evaluate(() => document.querySelector('.amx-img-capline')?.value)
      await p.keyboard.press('Enter')
      await p.waitForTimeout(150)
      await tb(p, 'source')
      await p.keyboard.press('Enter')
      await p.waitForTimeout(150)
      const t = await p.locator(`${PM} > p`, { hasText: '后文' }).boundingBox()
      await p.mouse.click(t.x + t.width - 2, t.y + t.height / 2)
      await p.keyboard.press('End')
      await p.keyboard.type('X')
      md = await saved(p)
      check(`T5 ${ML.includes('\n') ? '多行' : '首尾空格'}说明:输入行摊成一行显示;没改就回车,盘上原样`, shown === (ML.includes('\n') ? 'first second' : '  spaced  ') && md.includes(ML) && md.includes('后文X'), { shown, md })
    }

    // ── T6 替换:同一个选图对话框,只换 src,宽度和说明留着 ──
    await reopen(p, '前文\n\n![封面|300](home-w640-h360.png "说明留着")\n\n后文\n', 'Rep.md')
    await p.evaluate(() => {
      window.__saved = []
      window.amadeus.saveAttachment = async (page, name, bytes) => { window.__saved.push({ page, name, n: bytes.length }); return { base: 'new-w200-h120.png', pageRel: 'new-w200-h120.png', vaultRel: 'new-w200-h120.png' } }
    })
    await hover(p)
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click(`${WRAP} > .amx-img-tb [data-act="replace"]`)])
    check('T6 「替换」开选图对话框(只收图片)', chooser && (await chooser.element().getAttribute('accept')) === 'image/*')
    await chooser.setFiles({ name: 'new.png', mimeType: 'image/png', buffer: png(200, 120) })
    await p.waitForFunction((W) => document.querySelector(W + ' > img')?.getAttribute('src')?.includes('new-w200'), WRAP, { timeout: 5000 }).catch(() => {})
    md = await saved(p)
    check('T6 替换后只换地址:宽度 `|300` 与说明都在', md.includes('![封面|300](new-w200-h120.png "说明留着")'), md)
    check('T6 存的是选中的那张', await p.evaluate(() => window.__saved.length === 1 && window.__saved[0].name === 'new.png'))

    // ── T7 全屏 / 下载 ──
    await reopen(p, SEED, 'Pic2.md')
    await tb(p, 'fullscreen')
    await p.waitForSelector('.iv[role="dialog"]', { timeout: 5000 }).catch(() => {})
    check('T7 全屏 = 图片查看器(ImageViewer)', await p.locator('.iv[role="dialog"]').count() === 1)
    if (SHOT) await p.screenshot({ path: path.join(SHOT, 'fullscreen.png') })
    await p.keyboard.press('Escape')
    await p.waitForTimeout(600)
    check('T7 Esc 关查看器', await p.locator('.iv[role="dialog"]').count() === 0)
    await hover(p)
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 8000 }).catch(() => null), p.click(`${WRAP} > .amx-img-tb [data-act="download"]`)])
    check('T7 下载:文件名取图片名', dl && dl.suggestedFilename() === 'home-w640-h360.png', dl?.suggestedFilename())

    // ── T8 ⋯:复制图片 / 删除(撤销回来) ──
    await tb(p, 'more')
    const items = await p.evaluate((W) => [...document.querySelectorAll(W + ' > .amx-img-more button')].map((b) => [b.dataset.act, b.textContent]), WRAP)
    check('T8 ⋯ 里只有「复制图片」「删除」', JSON.stringify(items) === JSON.stringify([['copy', '复制图片'], ['delete', '删除']]), items)
    const mr = await box(p, `${WRAP} > .amx-img-more`), tr8 = await box(p, `${WRAP} > .amx-img-tb`)
    check('T8 菜单贴在工具条下沿、右缘对齐', mr && Math.abs(mr.y - tr8.b - 4) < 3 && Math.abs(mr.r - tr8.r) < 3, { mr, tr8 })
    if (SHOT) await p.screenshot({ path: path.join(SHOT, 'more.png') })
    await p.click(`${WRAP} > .amx-img-more [data-act="copy"]`)
    let clip = null
    for (let i = 0; i < 30 && !clip?.png; i++) {
      await p.waitForTimeout(100)
      clip = await p.evaluate(async () => { const it = (await navigator.clipboard.read())[0]; return { png: it.types.includes('image/png'), types: it.types } }).catch(() => null)
    }
    check('T8 复制图片 = 剪贴板里是真图片', clip?.png, clip)
    await tb(p, 'more')
    await p.click(`${WRAP} > .amx-img-more [data-act="delete"]`)
    md = await saved(p)
    check('T8 删除:独占一段的图连段落一起删', !md.includes('home-w640') && md.includes('上周的数据如下。\n\n## 风险'), md)
    await p.evaluate(() => window.__upage.probe.view().focus())
    await p.keyboard.press('Meta+z')
    md = await saved(p)
    check('T8 撤销把图片找回来', LINE(md) === '![新版主页|320](home-w640-h360.png)', md)

    // ── T9 窄图:工具条挪到图片上方,不压住图片 ──
    await reopen(p, '第一段文字。\n\n![小|90](tiny-w90-h60.png)\n\n后文\n', 'Tiny.md')
    await hover(p)
    const t9 = await box(p, `${WRAP} > .amx-img-tb`), i9 = await box(p, `${WRAP} > img`)
    check('T9 窄图:工具条在图片上方、左缘对齐', t9 && t9.b <= i9.y && Math.abs(t9.x - i9.x) < 2 && (await tbState(p)).op === 1, { t9, i9 })
    if (SHOT) await p.screenshot({ path: path.join(SHOT, 'narrow.png') })
    {
      // 指针从图片往上挪到工具条:中间那道缝不许让工具条消失,按钮真点得到
      const b9 = await box(p, `${WRAP} > .amx-img-tb [data-act="alignCenter"]`)
      await p.mouse.move(i9.cx, i9.cy)
      await p.waitForTimeout(150)
      await p.mouse.move(b9.cx, b9.cy, { steps: 10 })
      await p.waitForTimeout(200)
      const at = await p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-act]')?.dataset.act ?? null, { x: b9.cx, y: b9.cy })
      const st = await tbState(p)
      await p.mouse.down()
      await p.mouse.up()
      await p.waitForTimeout(200)
      md = await saved(p)
      check('T9 窄图:从图片挪到上方工具条,工具条不消失、按钮点得到(居中落盘)', at === 'alignCenter' && st?.op === 1 && md.includes('<span data-amadeus-align="center"></span>![小|90](tiny-w90-h60.png)'), { at, st, md })
    }

    // ── T10 只读:不出会改文档的键,也没有把手 ──
    await reopen(p, SEED, 'Ro.md')
    await p.evaluate(() => window.__upage.probe.view().setProps({ editable: () => false }))
    await hover(p)
    s = await tbState(p)
    check('T10 只读:只剩全屏 / 下载 / ⋯(复制)', JSON.stringify(s?.acts) === JSON.stringify(['fullscreen', 'download', 'more']), s?.acts)
    check('T10 只读:没有把手', await p.evaluate((W) => [...document.querySelectorAll(W + ' > .amx-img-resize')].every((h) => getComputedStyle(h).display === 'none'), WRAP))
    await p.evaluate(() => window.__upage.probe.view().setProps({ editable: () => true }))

    // ── T11 英文界面 ──
    await p.evaluate(() => window.__upage.setLocale('en'))
    await p.mouse.move(2, 2) // 露着的那条订了语言广播;这里再移开、重新悬停,两条路都走一遍
    await hover(p)
    s = await tbState(p)
    check('T11 英文:工具条文案切过来', s?.titles.includes('Align center') && s.titles.includes('Caption') && s.titles.includes('View full screen'), s?.titles)
    await p.evaluate(() => window.__upage.setLocale('zh'))

    // ── T14 阅读模式:说明照样在图下、跟段落对齐;不带工具条 / ⋯ / 把手 ──
    await reopen(p, '前文\n\n<span data-amadeus-align="center"></span>![新版主页|320](home-w640-h360.png "阅读里的说明")\n\n尾巴\n', 'Read.md')
    await hover(p) // 先把工具条、把手建出来并选中图片,确认阅读快照里摘干净了
    {
      const r = await box(p, `${WRAP} > img`)
      await p.mouse.click(r.x + 20, r.y + r.h - 20)
      await p.waitForTimeout(200)
    }
    await p.evaluate(() => window.__upage.probe.setReading(true))
    await p.waitForFunction(() => !!document.querySelector('.amx-reading-renderer .wiki-inline-img-wrap img'), null, { timeout: 8000 }).catch(() => null)
    await p.waitForTimeout(300)
    const rd = await p.evaluate(() => {
      const root = document.querySelector('.amx-reading-renderer')
      const w = root?.querySelector('.wiki-inline-img-wrap')
      if (!w) return null
      const cap = w.querySelector('.amx-img-cap'), img = w.querySelector('img')
      const r = w.getBoundingClientRect(), pr = w.closest('p, div:not(.wiki-inline-img-wrap)').getBoundingClientRect()
      return {
        cap: cap?.textContent ?? null, capShown: !!cap && !cap.hidden && getComputedStyle(cap).display !== 'none',
        capBelow: !!cap && cap.getBoundingClientRect().y >= img.getBoundingClientRect().bottom - 1,
        chrome: root.querySelectorAll('.amx-img-tb, .amx-img-more, .amx-img-resize, .amx-img-capline').length,
        dcx: Math.round(Math.abs(r.x + r.width / 2 - (pr.x + pr.width / 2))),
      }
    })
    check('T14 阅读模式:说明在图下照样显示', rd && rd.cap === '阅读里的说明' && rd.capShown && rd.capBelow, rd)
    check('T14 阅读模式:没有工具条 / ⋯ / 把手 / 输入行', rd && rd.chrome === 0, rd)
    check('T14 阅读模式:居中图仍居中', rd && rd.dcx < 3, rd)
    if (SHOT) await p.screenshot({ path: path.join(SHOT, 'reading.png') })
    await p.evaluate(() => window.__upage.probe.setReading(false))
    await p.waitForTimeout(300)

    // ── T15 复制带说明的图 → 粘贴:说明在、盘上是库内路径(不是显示地址)、没说明的不被 alt 顶出假说明 ──
    const A15 = '![图|300](sub/a-w300-h160.png "说 \\"明\\" (x)")', B15 = '![无|200](sub/b-w200-h100.png)'
    await reopen(p, `前文\n\n${A15}\n\n${B15}\n\n尾巴\n`, 'Copy.md')
    const pasteAfterTail = async () => {
      const t = await p.locator(`${PM} > p`, { hasText: '尾巴' }).boundingBox()
      await p.mouse.click(t.x + t.width - 2, t.y + t.height / 2)
      await p.keyboard.press('End')
      await p.keyboard.press('Enter')
      await p.keyboard.press('Meta+v')
      await p.waitForTimeout(600)
      return saved(p)
    }
    const lines = (md, needle) => md.split('\n').filter((l) => l.includes(needle))
    const selectNth = async (n) => {
      const rr = await p.evaluate(({ PM, n }) => { const im = document.querySelectorAll(PM + ' .wiki-inline-img-wrap > img')[n]; const b = im.getBoundingClientRect(); return { x: b.x, y: b.y, h: b.height } }, { PM, n })
      await p.mouse.click(rr.x + 20, rr.y + rr.h - 20)
      await p.waitForTimeout(200)
    }
    await selectNth(0)
    await p.keyboard.press('Meta+c')
    await p.waitForTimeout(300)
    md = await pasteAfterTail()
    check('T15 Mod+C 复制带说明的图 → 粘贴:说明逐字跟过来', JSON.stringify(lines(md, 'sub/a-w300')) === JSON.stringify([A15, A15]), lines(md, 'sub/a-w300'))
    await selectNth(1)
    await p.keyboard.press('Meta+c')
    await p.waitForTimeout(300)
    md = await pasteAfterTail()
    check('T15 Mod+C 复制没说明的图 → 粘贴:不冒出拿 alt 顶的说明', JSON.stringify(lines(md, 'sub/b-w200')) === JSON.stringify([B15, B15]), lines(md, 'sub/b-w200'))
    await p.mouse.move(2, 2)
    await p.waitForTimeout(150)
    await tb(p, 'more')
    await p.click(`${WRAP} > .amx-img-more [data-act="copy"]`)
    await p.waitForTimeout(600)
    md = await pasteAfterTail()
    check('T15 ⋯「复制图片」→ 粘贴:说明逐字跟过来', JSON.stringify(lines(md, 'sub/a-w300')) === JSON.stringify([A15, A15, A15]), lines(md, 'sub/a-w300'))
    check('T15 盘上没有显示地址', !/__img|amadeus-asset|https?:/.test(md), md)

    // ── W* `![[x.png|200]]` 图片(2026-11-18 定「①」:同一排工具条,没有「说明」;`/图片`、拖放、手机上传写的都是这一形态)──
    //    存法一个字节不变:宽度 `|宽度`、对齐 = 段首对齐标记(同 `![](…)` / Mod-Shift-E)。
    const WSEED = '# 页\n\n前文。\n\n![[home-w640-h360.png|320]]\n\n后文。\n'
    const WLINE = (md) => (md.split('\n').find((l) => l.includes('home-w640') || l.includes('new-w200')) ?? '')
    await reopen(p, WSEED, 'Wiki.md')
    await p.evaluate(() => {
      window.__opened = []
      window.__pageStore.setState({ openWikiLink: (name, src, o) => { window.__opened.push({ name, o: o ?? null }) } })
    })
    s = await tbState(p)
    check('W1 没悬停过:还没建工具条', s === null, s)
    await hover(p)
    s = await tbState(p)
    check('W1 悬停:工具条浮现', s && s.op === 1 && s.pe === 'auto', s)
    check('W1 一排按钮:左 / 中 / 右 · 替换 · 全屏 · 下载 · </> · ⋯(没有「说明」)', JSON.stringify(s?.acts) === JSON.stringify(['alignLeft', 'alignCenter', 'alignRight', 'replace', 'fullscreen', 'download', 'source', 'more']), s?.acts)
    {
      const loose = await p.evaluate((W) => ({ open: document.querySelectorAll(W + ' > .amx-open-btn').length, src: [...document.querySelectorAll(W + ' > .amx-src-btn')].map((b) => getComputedStyle(b).display) }), WRAP)
      check('W1 旧的单颗 `</>` / 「打开」不再露出', loose.open === 0 && loose.src.every((d) => d === 'none'), loose)
      const tbr = await box(p, `${WRAP} > .amx-img-tb`), ir = await box(p, `${WRAP} > img`)
      check('W1 工具条在图片右上角里面', tbr && Math.abs(tbr.r - (ir.r - 8)) < 3 && tbr.y >= ir.y && tbr.y - ir.y < 14, { tbr, ir })
    }
    if (SHOT) await p.screenshot({ path: path.join(SHOT, 'wiki-hover.png') })

    // W2 对齐:指针不动连点 左 → 中 → 右(段落换 attrs 时 widget 整颗重建,工具条要跟到新那颗上)
    {
      const col = await box(p, `${PM} > p`)
      await hover(p)
      const bc = await box(p, `${WRAP} > .amx-img-tb [data-act="alignCenter"]`)
      await p.mouse.click(bc.cx, bc.cy)
      await p.waitForTimeout(250)
      md = await saved(p)
      let r = await box(p, `${WRAP} > img`)
      check('W2 居中落盘为段首对齐标记,源码一个字节不变', WLINE(md) === '<span data-amadeus-align="center"></span>![[home-w640-h360.png|320]]', WLINE(md))
      check('W2 图片几何居中', Math.abs(r.cx - col.cx) < 3, { img: r.cx, col: col.cx })
      s = await tbState(p)
      check('W2 指针没动:工具条还在、高亮跟到「居中」', s?.op === 1 && JSON.stringify(s?.pressed) === '["alignCenter"]', s)
      const br = await box(p, `${WRAP} > .amx-img-tb [data-act="alignRight"]`)
      if (br) { await p.mouse.move(br.cx, br.cy); await p.mouse.down(); await p.mouse.up() }
      await p.waitForTimeout(250)
      md = await saved(p)
      r = await box(p, `${WRAP} > img`)
      check('W2 接着点「靠右」:标记 + 几何', !!br && WLINE(md).startsWith('<span data-amadeus-align="right"></span>![[') && Math.abs(r.r - col.r) < 3, { line: WLINE(md), r: r?.r, col: col.r })
      // 重开:仍渲染成图、仍算独占一段(点一下选整段 → 选中环)
      await reopen(p, md, 'Wiki.md')
      const ib = await box(p, `${WRAP} > img`)
      await p.mouse.click(ib.x + 40, ib.cy)
      await p.waitForTimeout(250)
      const st = await p.evaluate((W) => ({ imgs: document.querySelectorAll(W + ' > img').length, sel: document.querySelector(W)?.hasAttribute('data-selected'), node: window.__upage.probe.view().state.selection.node?.type.name ?? null }), WRAP)
      check('W2 重开:照样是图、照样独占一段(点一下选整段)', st.imgs === 1 && st.sel && st.node === 'paragraph', st)
      await tb(p, 'alignLeft')
      md = await saved(p)
      check('W2 回左对齐:标记消失', WLINE(md) === '![[home-w640-h360.png|320]]', WLINE(md))
    }

    // W3 宽度:选中后两侧把手;右 +60 → `|380`;居中图两边同时外扩
    {
      const ib = await box(p, `${WRAP} > img`)
      await p.mouse.click(ib.x + 40, ib.cy)
      await p.waitForTimeout(250)
      check('W3 选中后两侧都有把手', await p.locator(RIGHT).count() === 1 && await p.locator(LEFT).count() === 1)
      await drag(p, RIGHT, 60)
      md = await saved(p)
      check('W3 右把手 +60 → `|380`', WLINE(md) === '![[home-w640-h360.png|380]]' && await imgW(p) === 380, WLINE(md))
      await tb(p, 'alignCenter')
      const ib2 = await box(p, `${WRAP} > img`)
      await p.mouse.click(ib2.x + 40, ib2.cy)
      await p.waitForTimeout(250)
      const d = await drag(p, RIGHT, 30)
      md = await saved(p)
      check('W3 居中图右把手 +30 → 两边同时外扩 `|440`,把手跟手', WLINE(md) === '<span data-amadeus-align="center"></span>![[home-w640-h360.png|440]]' && Math.abs(d.during.cx - (d.start.cx + 30)) < 3, { line: WLINE(md), start: d.start.cx, during: d.during.cx })
      await tb(p, 'alignLeft')
    }

    // W4 替换:同一个选图对话框,存进库(与 `/图片` 同一条 saveAttachment),只换库内名,`|宽度` 留着
    await reopen(p, WSEED, 'WikiRep.md')
    await p.evaluate(() => {
      window.__saved = []
      window.amadeus.saveAttachment = async (page, name, bytes) => { window.__saved.push({ page, name, n: bytes.length }); return { base: 'new-w200-h120.png', pageRel: 'new-w200-h120.png', vaultRel: 'new-w200-h120.png' } }
    })
    await hover(p)
    {
      const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click(`${WRAP} > .amx-img-tb [data-act="replace"]`)])
      check('W4 「替换」开选图对话框(只收图片)', chooser && (await chooser.element().getAttribute('accept')) === 'image/*')
      await chooser.setFiles({ name: 'new.png', mimeType: 'image/png', buffer: png(200, 120) })
      await p.waitForFunction((W) => document.querySelector(W + ' > img')?.getAttribute('src')?.includes('new-w200'), WRAP, { timeout: 5000 }).catch(() => {})
      md = await saved(p)
      check('W4 替换后写回 `![[新名字|320]]`', WLINE(md) === '![[new-w200-h120.png|320]]', WLINE(md))
      check('W4 存的是选中的那张,存进本页', await p.evaluate(() => window.__saved.length === 1 && window.__saved[0].name === 'new.png' && window.__saved[0].page === 'WikiRep.md'), await p.evaluate(() => window.__saved))
    }

    // W5 全屏 / 下载
    await reopen(p, WSEED, 'Wiki2.md')
    await tb(p, 'fullscreen')
    await p.waitForSelector('.iv[role="dialog"]', { timeout: 5000 }).catch(() => {})
    check('W5 全屏 = 图片查看器', await p.locator('.iv[role="dialog"]').count() === 1)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(600)
    await hover(p)
    {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 8000 }).catch(() => null), p.click(`${WRAP} > .amx-img-tb [data-act="download"]`)])
      check('W5 下载:文件名取库内名', dl && dl.suggestedFilename() === 'home-w640-h360.png', dl?.suggestedFilename())
    }

    // W6 ⋯:打开(⌘/Ctrl+点 = 新标签页)· 复制图片 · 删除
    await tb(p, 'more')
    {
      const items = await p.evaluate((W) => [...document.querySelectorAll(W + ' > .amx-img-more button')].map((b) => [b.dataset.act, b.textContent]), WRAP)
      check('W6 ⋯ 里是「打开」「复制图片」「删除」', JSON.stringify(items) === JSON.stringify([['open', '打开'], ['copy', '复制图片'], ['delete', '删除']]), items)
      await p.click(`${WRAP} > .amx-img-more [data-act="open"]`)
      await tb(p, 'more')
      await p.click(`${WRAP} > .amx-img-more [data-act="open"]`, { modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
      const op = await p.evaluate(() => window.__opened)
      check('W6 「打开」= openWikiLink(库内名);⌘/Ctrl+点 = 新标签页', op.length === 2 && op[0].name === 'home-w640-h360.png' && !op[0].o?.newTab && op[1].o?.newTab === true, op)
      await tb(p, 'more')
      await p.click(`${WRAP} > .amx-img-more [data-act="copy"]`)
      await p.waitForTimeout(500)
      const clip = await p.evaluate(async () => { try { const it = await navigator.clipboard.read(); return { png: it.some((x) => x.types.includes('image/png')) } } catch (e) { return { err: String(e) } } })
      check('W6 复制图片 = 剪贴板里是真图片', clip?.png, clip)
      await tb(p, 'more')
      await p.click(`${WRAP} > .amx-img-more [data-act="delete"]`)
      await p.waitForTimeout(200)
      md = await saved(p)
      check('W6 删除:独占一段的图连段落一起删', !md.includes('home-w640') && md.includes('前文。\n\n后文。'), md)
      await p.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
      await p.waitForTimeout(250)
      md = await saved(p)
      check('W6 撤销把图片找回来', WLINE(md) === '![[home-w640-h360.png|320]]', md)
    }

    // W7 工具条的 `</>` 露出字面源码
    await reopen(p, WSEED, 'Wiki3.md')
    await tb(p, 'source')
    check('W7 `</>` 露出字面源码可编辑', (await p.evaluate((pm) => document.querySelector(pm).innerText, PM)).includes('![[home-w640-h360.png|320]]'))

    // W8 小图(< 80px,夹在字里的图标):11-07 定只留一颗缩小版 `</>`,不出整排工具条
    await reopen(p, '前文 ![[icon-w40-h40.png]] 夹在字里。\n\n后文。\n', 'WikiTiny.md')
    await hover(p)
    {
      const st = await p.evaluate((W) => {
        const w = document.querySelector(W), tb = w?.querySelector(':scope > .amx-img-tb'), sb = w?.querySelector(':scope > .amx-src-btn')
        return { tiny: w?.classList.contains('amx-img-tiny'), tb: tb ? getComputedStyle(tb).display : null, src: sb ? +getComputedStyle(sb).opacity : null }
      }, WRAP)
      check('W8 小图:不出工具条,悬停露出那颗缩小版 `</>`', st.tiny && (st.tb === null || st.tb === 'none') && st.src === 1, st)
    }

    // W11 窄图在正文第一行(上方被编辑器 / 画布卡片的裁切容器裁掉,11-18 画布 C72 实测):工具条改叠在图上,整条都点得到
    await reopen(p, '![[tiny-w90-h60.png]]\n\n后文。\n', 'WikiTop.md')
    await hover(p)
    {
      const st = await p.evaluate((W) => {
        const w = document.querySelector(W), tb = w?.querySelector(':scope > .amx-img-tb')
        if (!tb) return null
        const hits = [...tb.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-act]') === b })
        return { over: w.getAttribute('data-tb-over'), out: w.getAttribute('data-tb-out'), op: +getComputedStyle(tb).opacity, hits }
      }, WRAP)
      check('W11 窄图在第一行:工具条叠在图上(没被裁掉),每颗按钮都点得到', st && st.op === 1 && (st.over || st.out) && st.hits.every(Boolean), st)
    }

    // W9 只读:不出会改文档的键,也没有把手;⋯ 里只剩打开 / 复制
    await reopen(p, WSEED, 'WikiRo.md')
    await p.evaluate(() => window.__upage.probe.view().setProps({ editable: () => false }))
    await hover(p)
    s = await tbState(p)
    check('W9 只读:只剩全屏 / 下载 / ⋯', JSON.stringify(s?.acts) === JSON.stringify(['fullscreen', 'download', 'more']), s?.acts)
    await tb(p, 'more')
    check('W9 只读 ⋯:打开 · 复制图片(没有删除)', JSON.stringify(await p.evaluate((W) => [...document.querySelectorAll(W + ' > .amx-img-more button')].map((b) => b.dataset.act), WRAP)) === '["open","copy"]')
    await p.keyboard.press('Escape')
    await p.evaluate(() => window.__upage.probe.view().setProps({ editable: () => true }))

    check('T12 无渲染错误(桌面)', errs.length === 0, errs)
    await p.close()

    // ── T13 手机:点图在底部出同一排按钮 ──
    const touch = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const ph = await open(touch, SEED)
    const ib = await box(ph.p, `${WRAP} > img`)
    await ph.p.touchscreen.tap(ib.cx, ib.cy)
    await ph.p.waitForTimeout(400)
    const sheet = await ph.p.evaluate(() => {
      const s = document.querySelector('.amx-img-sheet')
      if (!s) return null
      const r = s.getBoundingClientRect(), tb = s.querySelector('.amx-img-tb')
      return { bottom: Math.round(innerHeight - r.bottom), w: r.width, acts: [...tb.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.dataset.act), btnH: Math.round(tb.querySelector('button').getBoundingClientRect().height), tbR: tb.getBoundingClientRect().right }
    })
    check('T13 点图:底部出一排按钮(同一组)', sheet && sheet.bottom < 40 && sheet.acts.length === 9 && sheet.tbR <= 390, sheet)
    check('T13 手机按钮 ≥ 40px 高', sheet && sheet.btnH >= 40, sheet)
    check('T13 粗指针下图片上不叠悬停工具条', await ph.p.evaluate((W) => getComputedStyle(document.querySelector(W + ' > .amx-img-tb')).display === 'none', WRAP))
    if (SHOT) await ph.p.screenshot({ path: path.join(SHOT, 'phone.png') })
    await ph.p.locator('.amx-img-sheet [data-act="alignCenter"]').tap()
    md = await saved(ph.p)
    check('T13 底栏「居中」照样落段首标记', LINE(md).startsWith('<span data-amadeus-align="center"></span>![新版主页|320]'), LINE(md))
    const tail = await box(ph.p, `${PM} h2`)
    await ph.p.touchscreen.tap(tail.x + 10, tail.cy)
    await ph.p.waitForTimeout(400)
    check('T13 点别处:底栏收起', await ph.p.locator('.amx-img-sheet').count() === 0)
    // 底栏「说明」:图下出输入行,回车落盘;底栏还在(图仍选中)
    await ph.p.touchscreen.tap(ib.cx, ib.cy)
    await ph.p.waitForTimeout(400)
    await ph.p.locator('.amx-img-sheet [data-act="caption"]').tap()
    await ph.p.waitForTimeout(250)
    const capFocused = await ph.p.evaluate(() => document.activeElement?.classList.contains('amx-img-capline') ?? false)
    await ph.p.keyboard.type('手机上写的说明')
    await ph.p.keyboard.press('Enter')
    await ph.p.waitForTimeout(300)
    md = await saved(ph.p)
    check('T13 底栏「说明」:输入行聚焦,回车写进 title', capFocused && LINE(md).endsWith('(home-w640-h360.png "手机上写的说明")'), { capFocused, line: LINE(md) })
    check('T13 写完说明底栏还在', await ph.p.locator('.amx-img-sheet').count() === 1)
    await ph.p.locator('.amx-img-sheet [data-act="more"]').tap()
    await ph.p.waitForTimeout(250)
    const m13 = await ph.p.evaluate(() => {
      const m = document.querySelector('.amx-img-sheet .amx-img-more')
      if (!m) return null
      const r = m.getBoundingClientRect()
      return { x: r.x, y: r.y, r: r.right, b: r.bottom, W: innerWidth, H: innerHeight, items: [...m.querySelectorAll('button')].map((b) => b.dataset.act), btnH: Math.round(m.querySelector('button').getBoundingClientRect().height) }
    })
    check('T13 底栏 ⋯:菜单整个在屏幕里,按钮 ≥ 44px', m13 && m13.x >= 0 && m13.y >= 0 && m13.r <= m13.W && m13.b <= m13.H && JSON.stringify(m13.items) === '["copy","delete"]' && m13.btnH >= 44, m13)
    if (SHOT) await ph.p.screenshot({ path: path.join(SHOT, 'phone-more.png') })
    check('T13 无渲染错误(手机)', ph.errs.length === 0, ph.errs)
    // 生产壳 + 移动端编辑胶囊:底栏摆在胶囊上面,不叠
    const pb = await open(touch, SEED, 'Pic.md', 'upage&upane&umbar')
    const ib2 = await box(pb.p, `${WRAP} > img`)
    await pb.p.touchscreen.tap(ib2.cx, ib2.cy)
    await pb.p.waitForTimeout(400)
    const ov = await pb.p.evaluate(() => {
      const s = document.querySelector('.amx-img-sheet')?.getBoundingClientRect(), m = document.querySelector('.amx-mbar')?.getBoundingClientRect()
      return s && m ? { sheetB: Math.round(s.bottom), barT: Math.round(m.top), barH: Math.round(m.height) } : { sheet: !!s, bar: !!m }
    })
    check('T13 有移动端编辑胶囊时:底栏坐在胶囊上面,不叠', ov.sheetB !== undefined && ov.barH > 0 && ov.sheetB <= ov.barT, ov)
    if (SHOT) await pb.p.screenshot({ path: path.join(SHOT, 'phone-mbar.png') })
    check('T13 无渲染错误(手机 + 胶囊)', pb.errs.length === 0, pb.errs)
    // W10 手机:`![[…]]` 图点一下也在底部出同一排(没有「说明」)
    {
      const pw = await open(touch, '# 页\n\n前文。\n\n![[home-w640-h360.png|320]]\n\n后文。\n', 'WikiPh.md')
      const ib3 = await box(pw.p, `${WRAP} > img`)
      await pw.p.touchscreen.tap(ib3.cx, ib3.cy)
      await pw.p.waitForTimeout(400)
      const sh = await pw.p.evaluate(() => { const tb = document.querySelector('.amx-img-sheet .amx-img-tb'); return tb ? [...tb.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.dataset.act) : null })
      check('W10 手机:点 `![[…]]` 图,底部出同一排(没有说明)', JSON.stringify(sh) === JSON.stringify(['alignLeft', 'alignCenter', 'alignRight', 'replace', 'fullscreen', 'download', 'source', 'more']), sh)
      await pw.p.click('.amx-img-sheet [data-act="alignCenter"]')
      await pw.p.waitForTimeout(300)
      md = await saved(pw.p)
      const sheetLeft = await pw.p.locator('.amx-img-sheet').count()
      check('W10 底栏「居中」落段首标记,底栏还在', md.includes('<span data-amadeus-align="center"></span>![[home-w640-h360.png|320]]') && sheetLeft === 1, { md, sheetLeft })
      if (SHOT) await pw.p.screenshot({ path: path.join(SHOT, 'wiki-phone.png') })
      const t = await pw.p.locator(`${PM} > p`, { hasText: '后文' }).boundingBox()
      await pw.p.touchscreen.tap(t.x + 10, t.y + t.height / 2)
      await pw.p.waitForTimeout(300)
      check('W10 点别处:底栏收起', await pw.p.locator('.amx-img-sheet').count() === 0)
      check('W10 无渲染错误', pw.errs.length === 0, pw.errs)
    }
    await touch.close()
  } finally {
    await browser.close()
  }
  const fails = results.filter((x) => !x).length
  console.log(`\n${results.length - fails}/${results.length} passed, ${fails} failed`)
  process.exit(fails ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
