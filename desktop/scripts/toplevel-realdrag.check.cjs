// 顶层 ⠿ 块拖拽 / OS 文件拖入的**真实输入**仪器(2026-09-22,分栏拖拽那轮留下的两处顶层旧伤)。
// 与 columns-realdrag 同一套手法:`page.mouse` 真拖 + 静止期同坐标 mouse.move 模拟 OS 周期 dragover;
// OS 文件拖入 Playwright 摆不出来,走合成 DragEvent(只验落点解析这一段)+ 生产同一条 lifecycle 入口插文件。
//
//  ① 叶子块(`---` 分割线)的位置反推:`posAtDOM(el,0)-1` 只对有 contentDOM 的块成立,hr 给的就是块前位。
//  T0 对照:多块选区拖到普通段落下半 → 落在它之后
//  T1 多块选区拖到 hr 下半 → 落在 hr 之后(修前:解析成 null,松手零反应)
//  T2 多块选区拖到 hr 上半 → 落在 hr 之前(修前:同上)
//  T3 两条相邻 hr,拖到第二条下半 → 落在第二条之后(修前:错一格,落在两条之间)
//  T4 OS 文件拖到 hr 上 → 线画在 hr 下沿、文件落在 hr 之后(修前:不出线/线停在上一块、文件进上一块之后)
//  T5 OS 文件拖到「前面也是 hr」的 hr 上 → 同上(修前:光标被吸成 hr 的 NodeSelection,文件落到文末)
//  ② 折叠小节:落点在隐藏区里 = 块一落下就被 display:none 吞掉(「线在明处、块进暗处」)。
//  T6 文末是折叠小节,⠿ 拖到折叠标题下半(落点插件那条路)→ 小节展开、块紧跟标题且看得见
//  T7 嵌套折叠(## 甲 ⊃ ### 乙 都折着)+ 下一节 ## 丙也折着,拖到 ## 丙上缘 → 甲乙都展开、丙仍折着、块看得见
//  T8 多块选区拖到折叠标题下半(executeMoveBlocks 那条路)→ 展开,块看得见
//  T8b 多块选区拖到嵌套折叠之后的下一节标题上缘 → 逐层展开(只展开外层,块仍在内层小节里看不见)
//  T9 OS 文件拖到折叠标题上 → 文件落在标题之后且看得见
// 用法:node scripts/e2e-editor.cjs --check=toplevel-realdrag(或 npm run check:topdrag)
//      5173 被别的检出占着时:HARNESS_URL=http://localhost:<port>/harness.html
const fs = require('fs'), os = require('os'), path = require('path')
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

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const SHOT_DIR = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice('--shot='.length)
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 三条 hr:第一条前面是文字段(posAtDOM-1 落进段尾 → nodeAt=null),后两条相邻(-1 落到前一条 hr 上 = 错一格)。 */
const SEED_HR = ['段甲。', '', '段乙。', '', '段丙。', '', '---', '', '段丁。', '', '---', '', '---', '', '段戊。', ''].join('\n')
/** 文末是一节可折叠的小节:折起后末块 display:none(tail 分支因此让路,落点全归插件)。 */
const SEED_TAIL = ['开头段。', '', '被拖段。', '', '## 末节', '', '末节正文一。', '', '末节正文二。', ''].join('\n')
/** 嵌套折叠:甲节(##)包着乙节(###),丙节是下一枚同级标题,自己也有小节。 */
const SEED_NEST = ['开头段。', '', '被拖段。', '', '## 甲节', '', '### 乙节', '', '乙节正文。', '', '## 丙节', '', '丙节正文。', ''].join('\n')

async function openPage(browser, seed, file, ready) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 1300 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  // &upane = 生产壳镜像(.am-app.tangu-lovable[data-mode]):--primary 才有值,--shot 截图里的线才看得见。
  await p.goto(`${URL}?upage&upane`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.unified-body .ProseMirror', { timeout: 20000 })
  await p.evaluate(([f, s]) => window.__upage.switchFile(f, s), [file, seed])
  await p.waitForSelector(ready, { timeout: 20000 })
  await p.waitForTimeout(600)
  // 附件面的桩(harness 的 saveAttachment 恒拒绝):⚠️ 必须改**同一个** window.amadeus 对象(api.ts 抓的是它)。
  await p.evaluate(() => Object.assign(window.amadeus, { saveAttachment: (_page, name) => Promise.resolve({ base: name, pageRel: name }) }))
  return p
}

/** 可见的指示线(all=true 连零宽的也算)。 */
const lines = (p, all = false) => p.evaluate((all) => [...document.querySelectorAll('.unified-drop-line, .unified-drop-vline')]
  .filter((el) => getComputedStyle(el).display !== 'none' && (all || el.getBoundingClientRect().width > 0))
  .map((el) => { const r = el.getBoundingClientRect(); return { v: el.classList.contains('unified-drop-vline'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } }), all)

/** 文档速写:顶层节点(段落取前 6 字,hr 记 `—`,标题记 `#甲节`),看不见的(折叠隐藏)前缀 `~`。 */
const shape = (p) => p.evaluate(() => {
  const v = window.__upage.probe.view()
  const out = []
  v.state.doc.forEach((n, off) => {
    const t = n.type.name === 'paragraph' ? n.textContent.slice(0, 6)
      : n.type.name === 'heading' ? '#' + n.textContent
      : n.type.name === 'hr' ? '—' : n.type.name
    const el = v.nodeDOM(off)
    out.push((el instanceof HTMLElement && el.getClientRects().length > 0 ? '' : '~') + t)
  })
  return out
})
/** 按文本开头找顶层块的矩形(sel 限定元素类型)。折叠标题行首挂着展开钮 widget(`▸`),比对前剥掉。 */
const elRect = (p, sel, prefix) => p.evaluate(([s, pre]) => {
  const el = [...document.querySelectorAll(`.unified-body .ProseMirror > ${s}`)].find((x) => x.textContent.replace('▸', '').startsWith(pre))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }
}, [sel, prefix])
/** 第 i 条顶层 hr 的矩形。 */
const hrRect = (p, i) => p.evaluate((k) => {
  const el = document.querySelectorAll('.unified-body .ProseMirror > hr')[k]
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }
}, i)

/** hover 到块 → 等 gutter 挂出 → ⠿ 中心。 */
async function handleAt(p, x, y) {
  await p.mouse.move(x, y, { steps: 4 })
  await p.waitForTimeout(250)
  return p.evaluate(() => {
    const g = document.querySelector('.unified-gutter')
    const h = g?.querySelector('.drag-handle')
    if (!h || g.dataset.show !== 'true') return null
    const r = h.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + Math.min(10, r.height / 2) }
  })
}
/** 静止期:同坐标反复 move = OS 周期补发的 dragover。 */
const idle = async (p, x, y, ms = 240) => { for (let t = 0; t < ms; t += 15) { await p.mouse.move(x, y); await p.waitForTimeout(15) } }
/** 从 ⠿ 按下 → 停在 to 静止 → 读线 → 松手 → 读线。 */
async function drag(p, from, to) {
  await p.mouse.move(from.x, from.y)
  await p.mouse.down()
  await p.mouse.move(from.x + 5, from.y + 5, { steps: 2 })
  await p.mouse.move(to.x, to.y, { steps: 10 })
  await idle(p, to.x, to.y)
  const during = await lines(p)
  await p.mouse.up()
  await p.waitForTimeout(450)
  return { during, after: await lines(p) }
}

/** 跨块文字选区:从 a 段内容首铺到 b 段内容尾(= 框选 / Shift 扩选的产物,⠿ 按下时保留它整批拖)。 */
const selectAcross = (p, a, b) => p.evaluate(([a, b]) => {
  const v = window.__upage.probe.view()
  let from = -1, to = -1
  v.state.doc.forEach((n, off) => {
    if (n.textContent.startsWith(a) && from < 0) from = off + 1
    if (n.textContent.startsWith(b)) to = off + n.nodeSize - 1
  })
  let Base = v.state.selection.constructor
  while (Object.getPrototypeOf(Base) !== Function.prototype) Base = Object.getPrototypeOf(Base)
  v.dispatch(v.state.tr.setSelection(Base.fromJSON(v.state.doc, { type: 'text', anchor: from, head: to })))
  v.focus()
  const s = v.state.selection
  return `${s.constructor.name}(${s.from},${s.to}) want (${from},${to})`
}, [a, b])

/** 折起一枚标题:悬停它 → gutter 的折叠钮。返回该标题是否真的进了折叠态(看它下一块是否 rect 全 0)。 */
async function foldHeading(p, text) {
  const h = await elRect(p, 'h2, h3', text)
  if (!h) return false
  await p.mouse.move(h.x + 30, h.y + h.h / 2, { steps: 3 })
  await p.waitForTimeout(300)
  const btn = await p.evaluate(() => {
    const b = document.querySelector('.unified-gutter .block-fold')
    if (!b || getComputedStyle(b).display === 'none') return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (!btn) return false
  await p.mouse.click(btn.x, btn.y)
  await p.waitForTimeout(350)
  return p.evaluate((t) => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror > h2, .unified-body .ProseMirror > h3')].find((x) => x.textContent.replace('▸', '').startsWith(t))
    const next = el?.nextElementSibling
    return !!next && next.getClientRects().length === 0
  }, text)
}

/** OS 文件拖入(合成 DragEvent,Playwright 摆不出 OS 文件拖拽):可选先经过 via → 停在 at → 读线 → drop;
 *  然后照生产宿主(amadeusViews 的 EditorScope onDrop)经 lifecycle.insertFilesForPath 把文件递给实例。 */
const fileDrop = (p, file, at, via) => p.evaluate(async ([file, at, via]) => {
  const dt = new DataTransfer()
  dt.items.add(new File([new Uint8Array([1, 2, 3])], 'drop.png', { type: 'image/png' }))
  const fire = (type, pt) => {
    const el = document.elementFromPoint(pt.x, pt.y)
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y }))
  }
  if (via) { fire('dragenter', via); fire('dragover', via) }
  fire('dragover', at)
  const line = [...document.querySelectorAll('.unified-drop-line')].filter((l) => getComputedStyle(l).display !== 'none')
    .map((l) => { const r = l.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } })
  fire('drop', at)
  const lc = await import('/src/amadeus/unified/lifecycle.ts')
  const handed = lc.insertFilesForPath(file, [...dt.files])
  return { line, handed }
}, [file, at, via ?? null])

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const shot = async (p, name) => { if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await p.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) }) } }
  const READY_HR = '.unified-body .ProseMirror > hr'
  const READY_H = '.unified-body .ProseMirror > h2'

  // ⚠️ 生产 hr 的盒子只有 1px 高(上下各 12px 是 margin,不在任何块的矩形里),整数坐标下只点得中一个像素、
  //    分不出上下两半。executeMoveBlocks 按「指针落在哪个块的矩形里」取目标 —— 被测的是块位反推,与盒高无关,
  //    所以 T0–T3 把 hr 的盒子用 padding 撑到 17px 再真拖(T4/T5 文件拖入用生产几何)。
  const tallHr = (p) => p.addStyleTag({ content: '.unified-body .ProseMirror > hr { padding: 8px 0 !important; }' })

  // ── T0 对照:多块选区拖到普通段落下半 → 落在它之后(有 contentDOM 的块,修前修后都该绿)────────────
  {
    const p = await openPage(browser, SEED_HR, 'Hr.md', READY_HR)
    await tallHr(p)
    await selectAcross(p, '段甲', '段乙')
    const src = await elRect(p, 'p', '段甲')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const tgt = await elRect(p, 'p', '段丁')
    if (h && tgt) await drag(p, h, { x: tgt.x + tgt.w * 0.5, y: tgt.y + tgt.h * 0.75 })
    const doc = await shape(p)
    check('T0 对照:多块选区拖到段落下半 → 落在它之后', JSON.stringify(doc.slice(0, 5)) === JSON.stringify(['段丙。', '—', '段丁。', '段甲。', '段乙。']), JSON.stringify(doc))
    await p.close()
  }

  // ── T1 / T2 多块选区 → 第一条 hr 的下半 / 上半 ───────────────────────────────────────────
  for (const [tag, frac, want] of [
    ['T1', 0.75, ['段丙。', '—', '段甲。', '段乙。', '段丁。']],
    ['T2', 0.25, ['段丙。', '段甲。', '段乙。', '—', '段丁。']],
  ]) {
    const p = await openPage(browser, SEED_HR, 'Hr.md', READY_HR)
    await tallHr(p)
    const pre = await selectAcross(p, '段甲', '段乙')
    const src = await elRect(p, 'p', '段甲')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const hr = await hrRect(p, 0)
    const r = h && hr ? await drag(p, h, { x: hr.x + hr.w * 0.5, y: hr.y + hr.h * frac }) : null
    const doc = await shape(p)
    check(`${tag} 多块选区拖到 hr ${frac > 0.5 ? '下半 → 落在 hr 之后' : '上半 → 落在 hr 之前'}`,
      JSON.stringify(doc.slice(0, 5)) === JSON.stringify(want), JSON.stringify({ pre, hr: hr && Math.round(hr.h), doc, during: r?.during }))
    await p.close()
  }

  // ── T3 两条相邻 hr:拖到第二条的下半 → 落在第二条之后 ──────────────────────────────────────
  {
    const p = await openPage(browser, SEED_HR, 'Hr.md', READY_HR)
    await tallHr(p)
    await selectAcross(p, '段甲', '段乙')
    const src = await elRect(p, 'p', '段甲')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const hr = await hrRect(p, 2)
    if (h && hr) await drag(p, h, { x: hr.x + hr.w * 0.5, y: hr.y + hr.h * 0.75 })
    const doc = await shape(p)
    check('T3 相邻 hr 的第二条下半 → 落在第二条之后(不错一格)',
      JSON.stringify(doc) === JSON.stringify(['段丙。', '—', '段丁。', '—', '—', '段甲。', '段乙。', '段戊。']), JSON.stringify(doc))
    await p.close()
  }

  // ── T4 / T5 OS 文件拖到 hr 上 ───────────────────────────────────────────────────────────────
  for (const [tag, idx, want] of [
    ['T4', 0, ['段丙。', '—', '![[dro', '段丁。']],
    ['T5', 2, ['—', '—', '![[dro', '段戊。']],
  ]) {
    const p = await openPage(browser, SEED_HR, 'Hr.md', READY_HR)
    const via = await elRect(p, 'p', '段甲') // 先经过一个普通块:修前那条线会停在这里不动(线在撒谎)
    const hr = await hrRect(p, idx)
    const r = await fileDrop(p, 'Hr.md', { x: hr.x + hr.w * 0.5, y: hr.y + hr.h * 0.5 }, { x: via.x + 40, y: via.y + via.h / 2 })
    await p.waitForTimeout(400)
    const doc = await shape(p)
    const at = doc.findIndex((t) => t.startsWith('![[dro'))
    check(`${tag} 文件拖到${idx ? '「前面也是 hr」的' : ''} hr 上:线画在这条 hr 的下沿`,
      r.line.length === 1 && Math.abs(r.line[0].y - (hr.b + 6)) <= 2, JSON.stringify({ line: r.line, hrBottom: Math.round(hr.b) }))
    check(`${tag} 文件落在这条 hr 之后`, r.handed && at > 0 && JSON.stringify(doc.slice(at - 2, at + 2)) === JSON.stringify(want), JSON.stringify({ handed: r.handed, doc }))
    await p.close()
  }

  // ── T6 文末折叠小节 → ⠿ 拖到折叠标题下半(落点插件那条路)───────────────────────────────────
  {
    const p = await openPage(browser, SEED_TAIL, 'Tail.md', READY_H)
    const folded = await foldHeading(p, '末节')
    const src = await elRect(p, 'p', '被拖段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const head = await elRect(p, 'h2', '末节')
    const r = h && head ? await drag(p, h, { x: head.x + head.w * 0.5, y: head.y + head.h * 0.8 }) : null
    const doc = await shape(p)
    check('T6 前置:末节真折起来了', folded, JSON.stringify(doc))
    check('T6 折叠标题下半悬停:只有一条横线,在标题下沿', !!r && r.during.length === 1 && !r.during[0].v && Math.abs(r.during[0].y - head.b) <= 8, JSON.stringify({ during: r?.during, headBottom: head && Math.round(head.b) }))
    check('T6 松手 → 块紧跟标题且看得见(小节已展开)', JSON.stringify(doc) === JSON.stringify(['开头段。', '#末节', '被拖段。', '末节正文一。', '末节正文二。']), JSON.stringify(doc))
    check('T6 松手后零指示线', !!r && r.after.length === 0, JSON.stringify(r?.after))
    await shot(p, 'T6-after')
    await p.close()
  }

  // ── T7 嵌套折叠 → 拖到下一节标题上缘 ───────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_NEST, 'Nest.md', READY_H)
    const f1 = await foldHeading(p, '乙节') // 先折内层,再折外层(外层折起后内层看不见,顺序反了折不到)
    const f2 = await foldHeading(p, '甲节')
    const f3 = await foldHeading(p, '丙节')
    const src = await elRect(p, 'p', '被拖段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const next = await elRect(p, 'h2', '丙节')
    const r = h && next ? await drag(p, h, { x: next.x + next.w * 0.5, y: next.y + next.h * 0.2 }) : null
    const doc = await shape(p)
    check('T7 前置:乙、甲、丙三节都折起来了', f1 && f2 && f3, JSON.stringify({ f1, f2, f3 }))
    check('T7 松手 → 甲乙逐层展开、块在丙节之前且看得见;丙节仍折着',
      JSON.stringify(doc) === JSON.stringify(['开头段。', '#甲节', '#乙节', '乙节正文。', '被拖段。', '#丙节', '~丙节正文。']), JSON.stringify({ doc, during: r?.during }))
    await p.close()
  }

  // ── T8 多块选区 → 折叠标题下半(executeMoveBlocks 那条路)─────────────────────────────────────
  {
    const p = await openPage(browser, SEED_TAIL, 'Tail.md', READY_H)
    const folded = await foldHeading(p, '末节')
    await selectAcross(p, '开头段', '被拖段')
    const src = await elRect(p, 'p', '开头段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const head = await elRect(p, 'h2', '末节')
    if (h && head) await drag(p, h, { x: head.x + head.w * 0.5, y: head.y + head.h * 0.8 })
    const doc = await shape(p)
    check('T8 多块选区拖到折叠标题下半 → 小节展开、两块紧跟标题且看得见', folded && JSON.stringify(doc) === JSON.stringify(['#末节', '开头段。', '被拖段。', '末节正文一。', '末节正文二。']), JSON.stringify({ folded, doc }))
    await p.close()
  }

  // ── T8b 多块选区 → 嵌套折叠下一节标题上缘(unfoldOver 要逐层展开;只展开一层块仍在乙节里看不见)──────
  {
    const p = await openPage(browser, SEED_NEST, 'Nest.md', READY_H)
    const f = (await foldHeading(p, '乙节')) && (await foldHeading(p, '甲节')) && (await foldHeading(p, '丙节'))
    await selectAcross(p, '开头段', '被拖段')
    const src = await elRect(p, 'p', '开头段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const next = await elRect(p, 'h2', '丙节')
    if (h && next) await drag(p, h, { x: next.x + next.w * 0.5, y: next.y + next.h * 0.25 })
    const doc = await shape(p)
    check('T8b 多块选区拖到嵌套折叠后的下一节上缘 → 甲乙逐层展开、两块看得见;丙节仍折着',
      f && JSON.stringify(doc) === JSON.stringify(['#甲节', '#乙节', '乙节正文。', '开头段。', '被拖段。', '#丙节', '~丙节正文。']), JSON.stringify({ f, doc }))
    await p.close()
  }

  // ── T9 OS 文件 → 折叠标题 ────────────────────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_TAIL, 'Tail.md', READY_H)
    const folded = await foldHeading(p, '末节')
    const head = await elRect(p, 'h2', '末节')
    const r = await fileDrop(p, 'Tail.md', { x: head.x + head.w * 0.5, y: head.y + head.h * 0.5 })
    await p.waitForTimeout(400)
    const doc = await shape(p)
    check('T9 文件拖到折叠标题上 → 落在标题之后且看得见', folded && r.handed && JSON.stringify(doc.slice(2, 4)) === JSON.stringify(['#末节', '![[dro']), JSON.stringify({ folded, doc, line: r.line }))
    await p.close()
  }

  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
