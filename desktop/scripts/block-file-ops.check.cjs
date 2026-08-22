// 「块基本操作 × 文件引用块」的出口门仪器(2026-08-20)。用法:node scripts/e2e-editor.cjs --check=block-file-ops
//
// 三件事一个仪器,因为它们共用同一条链路(整块删除的入口):
//   B1 框选多块后**焦点回编辑器** —— 修前 activeElement=BODY,选中一片块却 Delete/Cmd+C/Cmd+X
//      全部没反应(用户实报「必须通过菜单」的真根因,探针实测)
//   B2 框选后 Cmd+X = 整批剪走,不留合并出来的空段壳(PM 自带 cut 走文字语义)
//   B3 点 ⠿ 开菜单后焦点仍在编辑器(块选着就能直接按键);Esc 关菜单
//   B4 整块删掉文件引用块 → 问「磁盘文件也删吗」;选「一并删除」才真删
//   B5 手动编辑删掉 `![[x]]` 的字符 → **不问**(用户拍板:只有整块删除才问)
//   B6 剪切文件引用块 → **不问**(搬家不是删除)
//   B7 画布空白拖入 OS 文件 = 落点一张独立卡片 + 引用,且**没有**被外层 EditorScope 再导入一遍
//   B10 落点**压在卡片上**照样归舞台(卡的 DOM 住在 .ProseMirror 里 —— 老判据把卡覆盖的那片
//       舞台整个让给了 PM,而仪器一直往 .amx-stage 上派发,这条从没被测到过)
//   B11 粘贴文件(截图 Cmd+V)= 同一条链路,落在视野中间
//   B12 剪切整张卡 = 不问「磁盘文件也删吗」(与 B6 同一条:搬家不是删除)
//   B13 卡片**正在编辑**时把文件拖到它身上 = 仍归舞台(文件是空间动作;让给 PM 会按光标插,落点撒谎)
//   B14 上传在途被剪切+粘贴(锚换了)= 占位仍被换成引用,不会永远停在「上传中」
const fs = require('fs')
const os = require('os')
const path = require('path')
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
const PM = '.unified-body .ProseMirror'
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, seed) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(400)
  return p
}

/** 附件面的桩:harness 的 saveAttachment 是拒绝的,exclusiveAssets/trashEntry 压根没有。
 *  ⚠️ 必须改**同一个 window.amadeus 对象**(api.ts 抓的是这个引用,整份替换会失联)。 */
const stubAttachments = (p) => p.evaluate(() => {
  const g = window
  g.__stub = { saved: [], trashed: [], asked: 0 }
  Object.assign(g.amadeus, {
    saveAttachment: (page, name) => {
      g.__stub.saved.push(name)
      return Promise.resolve({ base: name, pageRel: name })
    },
    exclusiveAssets: () => Promise.resolve(g.__stub.exclusive ?? []),
    trashEntry: (rel) => { g.__stub.trashed.push(rel); return Promise.resolve() },
  })
})

const blocks = (p) => p.evaluate(() => [...document.querySelectorAll('.unified-body .ProseMirror > *')].map((x) => `${x.tagName}:${x.textContent}`))

/** 从块 a 的上方空白拉框到块 b 的下缘(blockLayer 的 marquee 只在**块矩形之外**起框)。 */
async function marquee(p, aText, bText) {
  const box = await p.evaluate(({ aText, bText }) => {
    const els = [...document.querySelectorAll('.unified-body .ProseMirror > *')]
    const a = els.find((x) => x.textContent.includes(aText)).getBoundingClientRect()
    const b = els.find((x) => x.textContent.includes(bText)).getBoundingClientRect()
    const pm = document.querySelector('.unified-body .ProseMirror').getBoundingClientRect()
    return { sx: pm.left - 20, sy: a.top - 4, ex: pm.right - 4, ey: b.bottom - 2 }
  }, { aText, bText })
  await p.mouse.move(box.sx, box.sy)
  await p.mouse.down()
  await p.mouse.move(box.ex, box.ey, { steps: 8 })
  await p.mouse.up()
  await p.waitForTimeout(160)
}

/** hover 出把手并点 ⠿(mousedown 选块 + click 开菜单)。 */
async function openBlockMenu(p, text) {
  // ⚠️ 悬停点取块的**左上角**而不是中心:嵌入卡(PDF/文件卡)动辄几百 px 高,落在中心时把手
  //    追踪不到这一块(实测拿到的是上一块的位置)。两次 move 是为了跨过 80ms 节流的后沿。
  const at = await p.evaluate((t) => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror > *')].find((x) => (x.textContent ?? '').includes(t))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + 30, y: r.top + 10 }
  }, text)
  if (!at) return false
  await p.mouse.move(at.x, at.y)
  await p.waitForTimeout(150)
  await p.mouse.move(at.x + 2, at.y + 2)
  await p.waitForTimeout(260)
  const h = await p.evaluate(() => {
    const d = document.querySelector('.unified-gutter .drag-handle')
    if (!d) return null
    const r = d.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (!h) return false
  await p.mouse.click(h.x, h.y)
  await p.waitForTimeout(200)
  return true
}

const dialog = (p) => p.evaluate(() => {
  const d = document.querySelector('.dialog-overlay .dialog')
  return d ? { title: d.querySelector('.dialog-title')?.textContent ?? '', btns: [...d.querySelectorAll('.dialog-btn')].map((b) => b.textContent) } : null
})

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // ── B1/B2 框选 → 焦点 → 剪切 ────────────────────────────────────────────────
  const SEED = '# 标题\n\n第一段。\n\n第二段。\n\n第三段。\n'
  const p = await open(browser, SEED)
  await marquee(p, '第一段', '第二段')
  const b1 = await p.evaluate(() => ({
    selected: document.querySelectorAll('.amx-block-selected').length,
    inPm: document.querySelector('.unified-body .ProseMirror').contains(document.activeElement),
  }))
  record('B1 框选两块:选中呈现 + 焦点回到编辑器(修前 activeElement=BODY)', b1.selected === 2 && b1.inPm, JSON.stringify(b1))

  await p.keyboard.press('Meta+x')
  await p.waitForTimeout(250)
  const afterCut = await blocks(p)
  record('B2 Cmd+X 整批剪走,不留空段壳', JSON.stringify(afterCut) === JSON.stringify(['H1:标题', 'P:第三段。']), JSON.stringify(afterCut))

  // ── B3 ⠿ 菜单不吃焦点 + Esc 关 ───────────────────────────────────────────────
  const p3 = await open(browser, SEED)
  await openBlockMenu(p3, '第二段')
  const b3a = await p3.evaluate(() => ({
    menu: !!document.querySelector('.unified-block-menu'),
    inPm: document.querySelector('.unified-body .ProseMirror').contains(document.activeElement),
    node: !!document.querySelector('.ProseMirror-selectednode'),
  }))
  await p3.keyboard.press('Escape')
  await p3.waitForTimeout(150)
  const b3b = await p3.evaluate(() => ({ menu: !!document.querySelector('.unified-block-menu'), node: !!document.querySelector('.ProseMirror-selectednode') }))
  record('B3 点 ⠿:菜单开着焦点仍在编辑器;Esc 关菜单、块仍选中',
    b3a.menu && b3a.inPm && b3a.node && !b3b.menu && b3b.node, JSON.stringify({ ...b3a, ...b3b }))
  await p3.keyboard.press('Delete')
  await p3.waitForTimeout(200)
  const b3c = await blocks(p3)
  record('B3b 块选中按 Delete 直接删块(不必走菜单)', !b3c.some((x) => x.includes('第二段')), JSON.stringify(b3c))

  // ── B4/B5/B6 文件引用块的删除询问 ───────────────────────────────────────────
  const REF = '# 附件页\n\n![[report.pdf]]\n\n尾段。\n'
  const p4 = await open(browser, REF)
  await stubAttachments(p4)
  await p4.evaluate(() => { window.__stub.exclusive = ['report.pdf'] })
  await openBlockMenu(p4, 'report.pdf')
  const hasMenu = await p4.evaluate(() => !!document.querySelector('.unified-block-menu'))
  await p4.evaluate(() => [...document.querySelectorAll('.unified-block-menu button')].find((b) => b.textContent.includes('删除'))?.click())
  await p4.waitForTimeout(300)
  const d4 = await dialog(p4)
  record('B4a 块菜单删掉文件引用块 → 弹「磁盘文件也删吗」', hasMenu && !!d4 && /引用块/.test(d4.title), JSON.stringify(d4))
  await p4.evaluate(() => [...document.querySelectorAll('.dialog-btn')].find((b) => b.textContent.includes('保留'))?.click())
  await p4.waitForTimeout(200)
  const kept = await p4.evaluate(() => window.__stub.trashed)
  record('B4b 选「保留文件」→ 一个字节都不动', kept.length === 0, JSON.stringify(kept))

  const p5 = await open(browser, REF)
  await stubAttachments(p5)
  await p5.evaluate(() => { window.__stub.exclusive = ['report.pdf'] })
  await openBlockMenu(p5, 'report.pdf')
  await p5.keyboard.press('Escape')
  await p5.waitForTimeout(120)
  await p5.keyboard.press('Delete') // 块选中 → 键盘删
  await p5.waitForTimeout(300)
  await p5.evaluate(() => [...document.querySelectorAll('.dialog-btn')].find((b) => b.textContent.includes('一并'))?.click())
  await p5.waitForTimeout(250)
  const trashed = await p5.evaluate(() => window.__stub.trashed)
  record('B4c 键盘删块 → 同一条询问;选「一并删除」才进回收站', JSON.stringify(trashed) === JSON.stringify(['report.pdf']), JSON.stringify(trashed))

  // B5 手动编辑删字符:不问
  const p6 = await open(browser, REF)
  await stubAttachments(p6)
  await p6.evaluate(() => { window.__stub.exclusive = ['report.pdf'] })
  await p6.click(`${PM} p`) // 光标落进引用段
  await p6.evaluate(() => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror > *')].find((x) => x.textContent.includes('report.pdf'))
    const r = el.getBoundingClientRect()
    return { x: r.right, y: r.top + r.height / 2 }
  })
  await p6.keyboard.press('Meta+a') // 一级 = 本段内容
  await p6.keyboard.press('Backspace')
  await p6.waitForTimeout(300)
  const d6 = await dialog(p6)
  record('B5 手动编辑清空引用段 → 不问(判据是结构性的:没走整块删除入口)', d6 === null, JSON.stringify(d6))

  // B6 剪切:不问
  const p7 = await open(browser, '# 附件页\n\n![[report.pdf]]\n\n第二个附件段。\n')
  await stubAttachments(p7)
  await p7.evaluate(() => { window.__stub.exclusive = ['report.pdf'] })
  await marquee(p7, 'report.pdf', '第二个附件段')
  await p7.keyboard.press('Meta+x')
  await p7.waitForTimeout(300)
  const d7 = await dialog(p7)
  record('B6 剪切引用块 → 不问(搬家不是删除)', d7 === null, JSON.stringify(d7))

  // ── B7 画布空白拖入文件 = 落点一张卡 + 引用 ──────────────────────────────────
  const p8 = await open(browser, '# 画布页\n\n主卡一段。\n')
  await stubAttachments(p8)
  await p8.click('.amx-modeseg button:nth-child(3)')
  await p8.waitForTimeout(1000)
  const dropped = await p8.evaluate(() => {
    const stage = document.querySelector('.amx-stage')
    const r = stage.getBoundingClientRect()
    const at = { clientX: r.left + r.width - 180, clientY: r.top + 260 }
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'diagram.png', { type: 'image/png' }))
    const fire = (ev) => stage.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
    fire('dragover')
    const dropEv = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at })
    let bubbledOut = false
    const spy = () => { bubbledOut = true }
    document.addEventListener('drop', spy, true) // 捕获期看得到,冒泡到 document 才算漏出去
    document.body.addEventListener('drop', spy)
    stage.dispatchEvent(dropEv)
    document.removeEventListener('drop', spy, true)
    return { defaultPrevented: dropEv.defaultPrevented }
  })
  await p8.waitForTimeout(600)
  const b7 = await p8.evaluate(() => ({
    cards: [...document.querySelectorAll('.amx-ucard')].map((c) => c.textContent),
    main: document.querySelector('.unified-body .ProseMirror')?.textContent ?? '',
    saved: window.__stub.saved,
  }))
  const cardText = b7.cards.join('|')
  record('B7 画布空白落文件 = 一张独立卡片 + `![[base]]` 引用',
    dropped.defaultPrevented && b7.saved.length === 1 && b7.cards.length === 1 && cardText.includes('![[diagram.png]]'),
    JSON.stringify(b7))
  record('B7b 没有被外层 EditorScope 再导入一遍(主卡正文里不该多出引用)',
    !b7.main.replace(cardText, '').includes('diagram.png'), JSON.stringify({ main: b7.main }))

  // B8:删掉这张卡 → 同一条「磁盘文件也删吗」询问(拖进来的文件就是这样成卡的,删卡是最顺手的反悔路径)
  await p8.evaluate(() => { window.__stub.exclusive = ['diagram.png'] })
  const cardAt = await p8.evaluate(() => {
    const c = document.querySelector('.amx-ucard')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + 6 } // 卡的 chrome 圈:单击=选中
  })
  if (cardAt) {
    await p8.mouse.click(cardAt.x, cardAt.y)
    await p8.waitForTimeout(200)
    await p8.keyboard.press('Delete')
    await p8.waitForTimeout(400)
  }
  const d8 = await dialog(p8)
  await p8.evaluate(() => [...document.querySelectorAll('.dialog-btn')].find((b) => b.textContent.includes('一并'))?.click())
  await p8.waitForTimeout(250)
  const t8 = await p8.evaluate(() => ({ trashed: window.__stub.trashed, cards: document.querySelectorAll('.amx-ucard').length }))
  record('B8 舞台上删掉这张卡 → 同一条询问;选「一并删除」才真删文件',
    !!d8 && /引用块/.test(d8.title) && JSON.stringify(t8.trashed) === JSON.stringify(['diagram.png']) && t8.cards === 0,
    JSON.stringify({ d8, ...t8 }))

  // B9:上传在途时用户改了这张卡 → 回调**不许**覆盖他写的字(Codex 评审 high 的竞态)
  const p9 = await open(browser, '# 画布页\n\n主卡一段。\n')
  await stubAttachments(p9)
  await p9.evaluate(() => {
    window.__stub.gate = {}
    window.__stub.gate.promise = new Promise((r) => { window.__stub.gate.resolve = r })
    window.amadeus.saveAttachment = (page, name) => window.__stub.gate.promise.then(() => ({ base: name, pageRel: name }))
  })
  await p9.click('.amx-modeseg button:nth-child(3)')
  await p9.waitForTimeout(1000)
  await p9.evaluate(() => {
    const stage = document.querySelector('.amx-stage')
    const r = stage.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([1])], 'slow.png', { type: 'image/png' }))
    const at = { clientX: r.left + r.width - 180, clientY: r.top + 260 }
    stage.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
    stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
  })
  await p9.waitForTimeout(400)
  const held = await p9.evaluate(() => document.querySelector('.amx-ucard')?.textContent ?? '')
  // 用户在上传期间自己把这张卡改了(真实路径是打字;这里直接改文档,同一笔事务语义)
  await p9.evaluate(() => {
    const view = window.__upage.probe.view()
    let pos = null
    view.state.doc.forEach((n, off) => { if (pos == null && n.type.name === 'amadeusCanvasCard') pos = off })
    const card = view.state.doc.nodeAt(pos)
    const para = view.state.schema.nodes.paragraph.create(null, view.state.schema.text('我自己写的'))
    view.dispatch(view.state.tr.replaceWith(pos + 1, pos + card.nodeSize - 1, para))
  })
  await p9.waitForTimeout(200)
  await p9.evaluate(() => window.__stub.gate.resolve())
  await p9.waitForTimeout(500)
  const b9 = await p9.evaluate(() => ({ cards: [...document.querySelectorAll('.amx-ucard')].map((c) => c.textContent) }))
  record('B9 上传在途时用户改了这张卡 → 回调不覆盖他写的字(乐观锁)',
    b9.cards.length === 1 && b9.cards[0].includes('我自己写的') && !b9.cards[0].includes('![['),
    JSON.stringify({ held, ...b9 }))

  // ── B10/B11/B12 落点在卡片上的文件 / 粘贴文件 / 剪切卡(2026-08-20 用户实报「拖不进也粘不上」)──
  const p10 = await open(browser, '# 画布页\n\n主卡一段。\n')
  await stubAttachments(p10)
  await p10.click('.amx-modeseg button:nth-child(3)')
  await p10.waitForTimeout(1000)
  // 先落一张卡当靶子(空白双击建卡),再把文件拖到**那张卡上** —— B7 一直往 .amx-stage 上派发,
  // 「落点压在卡片上」这条从没被测到过,而卡的 DOM 就住在 .ProseMirror 里(用户实报的那一半)。
  const blank10 = await p10.evaluate(() => {
    const r = document.querySelector('.amx-stage').getBoundingClientRect()
    return { x: r.right - 160, y: r.top + r.height * 0.4 }
  })
  await p10.mouse.dblclick(blank10.x, blank10.y)
  await p10.waitForTimeout(400)
  await p10.keyboard.press('Escape')
  const onCard10 = await p10.evaluate(() => {
    const card = document.querySelector('.amx-ucard')
    if (!card) return null
    const r = card.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'oncard.png', { type: 'image/png' }))
    const el = document.elementFromPoint(at.clientX, at.clientY) ?? card
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at })
    el.dispatchEvent(over)
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at })
    el.dispatchEvent(drop)
    return { target: `${el.tagName}.${el.className}`.slice(0, 40), over: over.defaultPrevented, drop: drop.defaultPrevented }
  })
  await p10.waitForTimeout(600)
  const b10 = await p10.evaluate(() => ({
    cards: [...document.querySelectorAll('.amx-ucard')].map((c) => c.textContent),
    saved: window.__stub.saved,
  }))
  record('B10 文件落点压在卡片上也归舞台(卡的 DOM 住在 .ProseMirror 里,老判据把这片舞台整个让出去)',
    !!onCard10 && onCard10.over && onCard10.drop && b10.saved.length === 1 && b10.cards.some((t) => t.includes('![[oncard.png]]')),
    JSON.stringify({ ...onCard10, ...b10 }))

  // B11 粘贴文件(截图 Cmd+V)= 同一条链路,落在视野中间
  await p10.mouse.click(blank10.x, blank10.y) // 焦点回舞台
  const paste11 = await p10.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([9])], 'pasted.png', { type: 'image/png' }))
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    ;(document.activeElement ?? document.body).dispatchEvent(ev)
    return ev.defaultPrevented
  })
  await p10.waitForTimeout(600)
  const b11 = await p10.evaluate(() => ({
    cards: [...document.querySelectorAll('.amx-ucard')].map((c) => c.textContent),
    saved: window.__stub.saved,
  }))
  record('B11 粘贴文件 = 一张卡 + 引用(与拖入同一条链路)',
    paste11 && b11.saved.length === 2 && b11.cards.some((t) => t.includes('![[pasted.png]]')), JSON.stringify(b11))

  // B12 剪切整张卡 → **不问**「磁盘文件也删吗」(搬家不是删除,与 B6 同一条纪律)
  await p10.evaluate(() => { window.__stub.exclusive = ['oncard.png', 'pasted.png'] })
  const cutAt = await p10.evaluate(() => {
    const c = [...document.querySelectorAll('.amx-ucard')].find((x) => (x.textContent ?? '').includes('oncard.png'))
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: r.left + 4, y: r.top + 4 } // chrome 圈:选中而不是落光标
  })
  await p10.mouse.click(cutAt.x, cutAt.y)
  const cut12 = await p10.evaluate(() => {
    const dt = new DataTransfer()
    const ev = new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: dt })
    ;(document.activeElement ?? document.body).dispatchEvent(ev)
    return { prevented: ev.defaultPrevented, text: dt.getData('text/plain') }
  })
  await p10.waitForTimeout(400)
  const d12 = await dialog(p10)
  const b12 = await p10.evaluate(() => ({ cards: [...document.querySelectorAll('.amx-ucard')].map((c) => c.textContent) }))
  record('B12 剪切整张卡:卡走了、剪贴板有内容,且**不问**磁盘文件(搬家不是删除)',
    cut12.prevented && cut12.text.includes('oncard.png') && d12 === null && !b12.cards.some((t) => t.includes('oncard.png')),
    JSON.stringify({ ...cut12, dialog: d12, ...b12 }))
  await p10.close()

  // ── B13 编辑态卡片上的外部拖放(Codex 评审 medium)──────────────────────────────
  // 文件/侧栏引用是**空间动作**,即便落在正在编辑的那张卡上也归舞台。让出去的话外层 EditorScope
  // 会按光标插(落点撒谎:实测插到卡**旁边**而不是卡里),侧栏引用更是没人接管、直接消失。
  const p13 = await open(browser, '# 画布页\n\n主卡一段。\n')
  await stubAttachments(p13)
  await p13.click('.amx-modeseg button:nth-child(3)')
  await p13.waitForTimeout(1000)
  const blank13 = await p13.evaluate(() => {
    const r = document.querySelector('.amx-stage').getBoundingClientRect()
    return { x: Math.round(r.right - 170), y: Math.round(r.top + r.height * 0.4) }
  })
  await p13.mouse.dblclick(blank13.x, blank13.y) // 建一张卡
  await p13.waitForTimeout(400)
  const card13 = await p13.evaluate(() => {
    const c = document.querySelector('.amx-ucard')
    const r = c.getBoundingClientRect()
    return { sel: { x: Math.round(r.left + 4), y: Math.round(r.top + 4) }, mid: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }
  })
  await p13.mouse.click(card13.sel.x, card13.sel.y)
  await p13.keyboard.press('Space') // 进编辑态
  await p13.waitForTimeout(300)
  const editing13 = await p13.evaluate(() => document.activeElement?.classList.contains('ProseMirror') ?? false)
  const drop13 = await p13.evaluate(({ mid }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([7])], 'while-editing.png', { type: 'image/png' }))
    const at = { clientX: mid.x, clientY: mid.y }
    const el = document.elementFromPoint(at.clientX, at.clientY)
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at })
    el.dispatchEvent(over)
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at })
    el.dispatchEvent(drop)
    return { over: over.defaultPrevented, drop: drop.defaultPrevented }
  }, { mid: card13.mid })
  await p13.waitForTimeout(600)
  const b13 = await p13.evaluate(() => ({
    cards: [...document.querySelectorAll('.amx-ucard')].map((c) => c.textContent),
    saved: window.__stub.saved,
  }))
  record('B13 卡片正在编辑时把文件拖到它身上:仍归舞台落成新卡(不让给 PM 按光标插)',
    editing13 && drop13.over && drop13.drop && b13.saved.includes('while-editing.png')
      && b13.cards.filter((t) => t.includes('![[while-editing.png]]')).length === 1,
    JSON.stringify({ editing: editing13, ...drop13, ...b13 }))
  await p13.close()

  // ── B14 上传在途剪切/粘贴:占位不许永远停在「上传中」(Codex 评审 high)────────────
  const p14 = await open(browser, '# 画布页\n\n主卡一段。\n')
  await stubAttachments(p14)
  await p14.evaluate(() => {
    window.__stub.gate = {}
    window.__stub.gate.promise = new Promise((r) => { window.__stub.gate.resolve = r })
    window.amadeus.saveAttachment = (page, name) => window.__stub.gate.promise.then(() => ({ base: name, pageRel: name }))
  })
  await p14.click('.amx-modeseg button:nth-child(3)')
  await p14.waitForTimeout(1000)
  const blank14 = await p14.evaluate(() => {
    const r = document.querySelector('.amx-stage').getBoundingClientRect()
    return { x: Math.round(r.right - 170), y: Math.round(r.top + r.height * 0.4) }
  })
  await p14.evaluate(({ at }) => {
    const stage = document.querySelector('.amx-stage')
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([1])], 'inflight.png', { type: 'image/png' }))
    const o = { clientX: at.x, clientY: at.y, dataTransfer: dt }
    stage.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, ...o }))
    stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, ...o }))
  }, { at: blank14 })
  await p14.waitForTimeout(400)
  const held14 = await p14.evaluate(() => document.querySelector('.amx-ucard')?.textContent ?? '')
  // 上传还没回来就把这张卡剪走、粘到别处(锚会换成新的)
  const at14 = await p14.evaluate(() => {
    const c = document.querySelector('.amx-ucard')
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.left + 4), y: Math.round(r.top + 4) }
  })
  await p14.mouse.click(at14.x, at14.y)
  const clip14 = await p14.evaluate(() => {
    const dt = new DataTransfer()
    const cut = new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: dt })
    ;(document.activeElement ?? document.body).dispatchEvent(cut)
    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    ;(document.activeElement ?? document.body).dispatchEvent(paste)
    return { cut: cut.defaultPrevented, paste: paste.defaultPrevented }
  })
  await p14.waitForTimeout(300)
  await p14.evaluate(() => window.__stub.gate.resolve())
  await p14.waitForTimeout(600)
  const b14 = await p14.evaluate(() => ({ cards: [...document.querySelectorAll('.amx-ucard')].map((c) => c.textContent) }))
  record('B14 上传在途被剪切+粘贴(锚换了)→ 占位仍被换成引用,不会永远停在「上传中」',
    held14.includes('上传中') && clip14.cut && clip14.paste
      && b14.cards.length === 1 && b14.cards[0].includes('![[inflight.png]]') && !b14.cards.some((t) => t.includes('上传中')),
    JSON.stringify({ held: held14, ...clip14, ...b14 }))
  await p14.close()

  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  console.log('SKIP  真机 Electron 的原生文件拖入(DataTransfer.files 由 OS 填)—— 合成 DragEvent 只覆盖到分流逻辑')
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
