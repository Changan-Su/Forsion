// 分栏 × ⠿ 块拖拽的**真实输入**仪器(2026-09-22 用户录屏:图片拖进短列不落地、指示线松手残留、
// 横竖线同现、图片「选中了」却拖不动)。
//
// 为什么另起一支:unified-columns 的 C3 把合成 DragEvent 直接派到 `.ProseMirror` 上,走不到这轮全部
// 病灶 —— 真命中测试把 drop 派给 `.amx-ucolrow`(短列底下不在任何 cell 里)、捕获期路由
// stopPropagation、dragend 发在 gutter 的 ⠿ 上、指针静止时 OS 周期补发 dragover。这里一律
// `page.mouse` 真拖(Playwright 拦截原生拖拽 → Input.dispatchDragEvent,受信任事件 + 真命中),
// 静止期用同坐标 mouse.move 模拟 OS 的周期 dragover(macOS 真机就是这样,落点插件的 30ms 延时
// 隐藏会被它作废)。
//
// 种子 = 用户笔记 Forsion v2.11.x 的真实几何:左栏一张高图、右栏两段短字、行后一张图。
//  R1 行后图 → 右栏末段下方浅处 → 落进右栏末尾(修前:最近边是 cell 下沿=行内非法位置,删了又插回原处)
//  R2 行后图 → 右栏深处空白 → 落进右栏末尾(修前:无线,落进左栏)
//  R3 文末段 → 右栏深处空白 → 落进右栏末尾(修前:线画在整行底,落到行外)
//  R4 单块被选满(一次没落成的 drop 留下的选区 / 选中的图片)→ ⠿ 仍能拖(修前:dragstart 不序列化,裸拖绿 +)
//  R5 配对区静止 → 只剩竖线;松手成列后零残留(修前:旧横线与竖线同现,松手后横线还在)
//  R6 行下沿正下方静止 → 只有一条线、落到行后
//  R7 落回自身(右栏末块拖回右栏空白)→ 不出线、文档不变
//  R8 文末之下(tail 路由)松手 → 零残留
//  R9 两栏之间的缝(深处)松手 → 不进任何一列(修前:线画在左列、块进左列)
//  R10 右栏首段上缘 → 落进右栏首位,仍是两列
// 用法:node scripts/e2e-editor.cjs --check=columns-realdrag(或 npm run check:coldrag)
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

const SEED = [
  '---',
  'amadeus_schema: amadeus.page/4',
  'amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["c0js0"],"width":1},{"refs":["cb63f"],"width":1}],"tail":"c6yph"}]}',
  '---',
  '热力图等内容',
  '',
  'Forsion Extend隔离。',
  '',
  '<!-- a c0js0 -->',
  '',
  '![[tall.png|185]]',
  '',
  '<!-- a cb63f -->',
  '',
  '窄size下chatboxUI混乱。',
  '',
  '拖动blocks的时候，特别是分栏的时候，横向的位置指示的条有时候会出现，并且放手后依旧存在。',
  '',
  '<!-- a c6yph -->',
  '',
  '![[wide.png|282]]',
  '',
  'Prompts编程。',
  '',
  '存储相关的.prompt文件里面。',
  '',
].join('\n')

async function openPage(browser) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 1300 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  // &upane = 生产壳镜像(.am-app.tangu-lovable[data-mode]):--primary 才有值,--shot 截图里的线才看得见
  // (默认 720px 盒子没有这层 scope,线的底色 var(--primary) 计算成透明 —— 几何全绿、截图空白)。
  await p.goto(`${URL}?upage&upane`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.unified-body .ProseMirror', { timeout: 20000 })
  // 图片要真加载出几何(amadeus-asset:// 在浏览器里解析不了,会塌成 0×0):tall=左栏聊天截图比例,wide=被拖那张。
  await p.evaluate(() => {
    const svg = (w, h, c) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${c}"/></svg>`)}`
    window.__assets.setUrlBuilder((ref) => (/tall/.test(ref) ? svg(185, 417, '#556') : svg(282, 200, '#8a6')))
  })
  // 换一篇 = UnifiedPage 按新 key 重挂载,图片按上面的构建器重新出 URL。
  await p.evaluate((seed) => window.__upage.switchFile('Cols.md', seed), SEED)
  await p.waitForSelector('.unified-body .amx-ucolrow .wiki-inline-img-wrap img', { timeout: 20000 })
  await p.waitForTimeout(700)
  await p.evaluate(() => {
    window.__dnd = { allowed: null, vdrag: null }
    // 冒泡末端记 dragstart 之后的 effectAllowed(gutter 自己的 dragstart 在 content 上,先于 window 冒泡)
    window.addEventListener('dragstart', (e) => { window.__dnd.allowed = e.dataTransfer?.effectAllowed ?? null })
  })
  return p
}

/** 可见的指示线:横线(.unified-drop-line,blockLayer 自己的与落点插件的各一枚)+ 竖线(.unified-drop-vline)。 */
const lines = (p) => p.evaluate(() => [...document.querySelectorAll('.unified-drop-line, .unified-drop-vline')]
  .filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0)
  .map((el) => { const r = el.getBoundingClientRect(); return { v: el.classList.contains('unified-drop-vline'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } }))

/** 文档速写:顶层节点 + 行内各列子节点(段落取前 8 字)。 */
const shape = (p) => p.evaluate(() => {
  const v = window.__upage.probe.view()
  const nm = (n) => (n.type.name === 'paragraph' ? n.textContent.slice(0, 8) : n.type.name)
  const doc = []
  v.state.doc.forEach((n) => {
    if (n.type.name !== 'amadeusColumnRow') return doc.push(nm(n))
    const row = []
    n.forEach((c) => { const kids = []; c.forEach((k) => kids.push(nm(k))); row.push(kids) })
    doc.push({ row })
  })
  return doc
})
const rowOf = (doc) => doc.find((n) => n && n.row)?.row ?? null
const rect = (p, sel, i = 0) => p.evaluate(([s, k]) => {
  const el = document.querySelectorAll(s)[k]
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }
}, [sel, i])
/** 按正文开头找块(拖完位置会变,别拿旧坐标重找)。 */
const blockRect = (p, prefix) => p.evaluate((pre) => {
  const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => x.textContent.startsWith(pre))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }
}, prefix)

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
/** 静止期:同坐标反复 move = OS 周期补发的 dragover(真机指针不动时 Chromium 仍在派发)。 */
const idle = async (p, x, y, ms = 240) => { for (let t = 0; t < ms; t += 15) { await p.mouse.move(x, y); await p.waitForTimeout(15) } }
/** 从 ⠿ 按下 → 沿途经过 via(可空)→ 停在 to 静止 → 读线 → 松手 → 读线。 */
async function drag(p, from, via, to) {
  await p.mouse.move(from.x, from.y)
  await p.mouse.down()
  await p.mouse.move(from.x + 5, from.y + 5, { steps: 2 })
  if (via) { await p.mouse.move(via.x, via.y, { steps: 8 }); await idle(p, via.x, via.y, 120) }
  await p.mouse.move(to.x, to.y, { steps: 10 })
  await idle(p, to.x, to.y)
  const during = await lines(p)
  const vdrag = await p.evaluate(() => !!window.__upage.probe.view().dragging)
  await p.mouse.up()
  await p.waitForTimeout(450)
  return { during, after: await lines(p), vdrag, allowed: await p.evaluate(() => window.__dnd.allowed) }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const shot = async (p, name) => { if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await p.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) }) } }

  // ── R1 行后图 → 右栏末段下方浅处 ───────────────────────────────────────────────
  {
    const p = await openPage(browser)
    const img = await rect(p, '.wiki-inline-img-wrap', 1)
    const h = await handleAt(p, img.x + 30, img.y + 30)
    const last = await blockRect(p, '拖动blocks')
    const r = h && last ? await drag(p, h, null, { x: last.x + last.w * 0.6, y: last.b + 20 }) : null
    const row = rowOf(await shape(p))
    check('R1 行后图拖到右栏末段下方(浅)→ 落进右栏末尾', !!row && row[1].at(-1)?.startsWith('![[wide'), JSON.stringify({ row, during: r?.during }))
    check('R1 松手后零指示线', !!r && r.after.length === 0, JSON.stringify(r?.after))
    await p.close()
  }

  // ── R2 行后图 → 右栏深处空白 ───────────────────────────────────────────────────
  {
    const p = await openPage(browser)
    const img = await rect(p, '.wiki-inline-img-wrap', 1)
    const h = await handleAt(p, img.x + 30, img.y + 30)
    const rowR = await rect(p, '.amx-ucolrow')
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const to = { x: cell2.x + cell2.w * 0.6, y: cell2.b + (rowR.b - cell2.b) * 0.6 }
    const r = h ? await drag(p, h, null, to) : null
    const row = rowOf(await shape(p))
    const inCol = r?.during.filter((l) => !l.v && l.x >= cell2.x - 2 && l.x + l.w <= cell2.r + 2) ?? []
    check('R2 右栏深处悬停:有一条线且画在右栏里', !!r && r.during.length === 1 && inCol.length === 1, JSON.stringify({ during: r?.during, cell2: [Math.round(cell2.x), Math.round(cell2.r)] }))
    check('R2 松手 → 落进右栏末尾(不进左栏、不出行)', !!row && row[1].at(-1)?.startsWith('![[wide') && row[0].length === 1, JSON.stringify(row))
    await shot(p, 'R2-after')
    await p.close()
  }

  // ── R3 文末段 → 右栏深处空白 ───────────────────────────────────────────────────
  {
    const p = await openPage(browser)
    const src = await blockRect(p, 'Prompts')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const rowR = await rect(p, '.amx-ucolrow')
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const r = h ? await drag(p, h, null, { x: cell2.x + cell2.w * 0.6, y: cell2.b + (rowR.b - cell2.b) * 0.6 }) : null
    const row = rowOf(await shape(p))
    check('R3 文末段拖到右栏深处 → 落进右栏末尾', !!row && !!row[1].at(-1)?.startsWith('Prompts'), JSON.stringify({ row, during: r?.during }))
    await p.close()
  }

  // ── R4 单块被选满后 ⠿ 拖 ─────────────────────────────────────────────────────────
  // 前置态必须真摆出来:文字选区**恰好**铺满图片段落的内容(= 一次没落成的 drop 之后、或选中图片的样子),
  // 否则 mousedown 那条守卫根本不会被走到(负对照假绿的第 3 类)。
  {
    const p = await openPage(browser)
    const pre = await p.evaluate(() => {
      const v = window.__upage.probe.view()
      let at = -1
      v.state.doc.forEach((n, off) => { if (at < 0 && n.type.name === 'paragraph' && n.textContent.startsWith('![[wide')) at = off })
      const n = v.state.doc.nodeAt(at)
      // 页面里拿不到 PM 的类:沿当前选区的类链爬到根类 Selection,按 JSON 反解出 TextSelection。
      let Base = v.state.selection.constructor
      while (Object.getPrototypeOf(Base) !== Function.prototype) Base = Object.getPrototypeOf(Base)
      const ts = Base.fromJSON(v.state.doc, { type: 'text', anchor: at + 1, head: at + n.nodeSize - 1 })
      v.dispatch(v.state.tr.setSelection(ts))
      v.focus()
      const s = v.state.selection
      return { sel: `${s.constructor.name}(${s.from},${s.to})`, want: `(${at + 1},${at + n.nodeSize - 1})` }
    })
    const img = await rect(p, '.wiki-inline-img-wrap', 1)
    const h = await handleAt(p, img.x + 30, img.y + 30)
    const para = await blockRect(p, '窄size')
    const r = h && para ? await drag(p, h, null, { x: para.x + para.w * 0.4, y: para.b + 3 }) : null
    const row = rowOf(await shape(p))
    check('R4 前置态:选区恰好铺满图片段落', !pre.err && pre.sel.endsWith(pre.want), JSON.stringify(pre))
    check('R4 ⠿ 拖起有块数据(effectAllowed=copyMove,view.dragging 在)', !!r && r.allowed === 'copyMove' && r.vdrag, JSON.stringify({ allowed: r?.allowed, vdrag: r?.vdrag }))
    check('R4 落进右栏两段之间', !!row && row[1][1]?.startsWith('![[wide'), JSON.stringify(row))
    await p.close()
  }

  // ── R5 配对区静止 → 只剩竖线;松手成列零残留 ───────────────────────────────────
  {
    const p = await openPage(browser)
    const img = await rect(p, '.wiki-inline-img-wrap', 1)
    const h = await handleAt(p, img.x + 30, img.y + 30)
    const para = await blockRect(p, '窄size')
    // 先经过一个普通落点(让落点插件画出横线),再进段落左缘配对区静止
    const r = h && para ? await drag(p, h, { x: para.x + 80, y: para.b + 3 }, { x: para.x + 6, y: para.y + para.h / 2 }) : null
    const row = rowOf(await shape(p))
    check('R5 配对区静止:只有竖线,没有横线', !!r && r.during.length === 1 && r.during[0].v, JSON.stringify(r?.during))
    check('R5 松手成列(新列插在右栏左侧)', !!row && row.length === 3 && row[1][0]?.startsWith('![[wide'), JSON.stringify(row))
    check('R5 松手后零指示线', !!r && r.after.length === 0, JSON.stringify(r?.after))
    await shot(p, 'R5-after')
    await p.close()
  }

  // ── R6 行下沿正下方静止 → 只有一条线,落到行后 ─────────────────────────────────────
  // (行与下一块之间只有 ~4.5px 段距,belowRef 的判定带几乎为零;这里由落点插件按行下沿给出「行后」,
  //  验的是:接管/插件两套线互斥、线与落点一致、松手零残留。)
  {
    const p = await openPage(browser)
    const src = await blockRect(p, 'Prompts')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const rowR = await rect(p, '.amx-ucolrow')
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const para = await blockRect(p, '窄size')
    const r = h ? await drag(p, h, { x: para.x + 80, y: para.b + 3 }, { x: cell2.x + 100, y: rowR.b + 2 }) : null
    const doc = await shape(p)
    check('R6 行下沿正下方静止:只有一条横线', !!r && r.during.length === 1 && !r.during[0].v, JSON.stringify(r?.during))
    check('R6 松手 → 紧跟在行后 + 零残留', doc.findIndex((n) => typeof n === 'string' && n.startsWith('Prompts')) === doc.findIndex((n) => n && n.row) + 1 && r.after.length === 0, JSON.stringify({ doc, after: r?.after }))
    await p.close()
  }

  // ── R9 两栏之间的缝(深处)→ 不进任何一列 ─────────────────────────────────────────
  // 缝不归任何列:修前库把左列末块下沿当最近边(线画在左列、块进左列),指针明明在两列之间。
  {
    const p = await openPage(browser)
    const src = await blockRect(p, 'Prompts')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const rowR = await rect(p, '.amx-ucolrow')
    const cell1 = await rect(p, '.amx-ucolcell', 0)
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const r = h ? await drag(p, h, null, { x: (cell1.r + cell2.x) / 2, y: cell2.b + (rowR.b - cell2.b) * 0.6 }) : null
    const row = rowOf(await shape(p))
    const inCol = !!row && row.some((c) => c.some((k) => k.startsWith('Prompts')))
    check('R9 列缝松手:不进任何一列 + 零残留', !inCol && !!r && r.after.length === 0, JSON.stringify({ row, during: r?.during, after: r?.after }))
    await p.close()
  }

  // ── R10 右栏首段上缘 → 落进右栏首位(仍是两列)───────────────────────────────────
  // (「拒行内位置」那一刀的负对照由 R6 抓:去掉它,行下沿那一拖会选中行内位置,整行被解散。
  //  首段上方 4px 段距带里行上沿与首段上沿等距,平局按 pos 小者 = 行前,线也画在行上沿 —— 线与落点一致,不算错。)
  {
    const p = await openPage(browser)
    const src = await blockRect(p, 'Prompts')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const first = await blockRect(p, '窄size')
    const r = h && first ? await drag(p, h, null, { x: first.x + first.w * 0.5, y: first.y + 1 }) : null
    const row = rowOf(await shape(p))
    check('R10 右栏首段上缘 → 落进右栏首位,仍是两列', !!row && row.length === 2 && !!row[1][0]?.startsWith('Prompts'), JSON.stringify({ row, during: r?.during }))
    await p.close()
  }

  // ── R7 落回自身:右栏末块拖回右栏空白 ────────────────────────────────────────────
  {
    const p = await openPage(browser)
    const before = JSON.stringify(await shape(p))
    const src = await blockRect(p, '拖动blocks')
    const h = src ? await handleAt(p, src.x + 30, src.y + 8) : null
    const rowR = await rect(p, '.amx-ucolrow')
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const r = h ? await drag(p, h, null, { x: cell2.x + cell2.w * 0.5, y: cell2.b + (rowR.b - cell2.b) * 0.5 }) : null
    check('R7 落回自身:不出线', !!r && r.during.length === 0, JSON.stringify(r?.during))
    check('R7 落回自身:文档不变', JSON.stringify(await shape(p)) === before, JSON.stringify(await shape(p)))
    await p.close()
  }

  // ── R8 文末之下(tail)松手零残留 ─────────────────────────────────────────────────
  {
    const p = await openPage(browser)
    const img = await rect(p, '.wiki-inline-img-wrap', 1)
    const h = await handleAt(p, img.x + 30, img.y + 30)
    const last = await blockRect(p, '存储相关')
    const r = h && last ? await drag(p, h, { x: last.x + 80, y: last.y + 2 }, { x: last.x + 80, y: last.b + 14 }) : null
    const doc = await shape(p)
    check('R8 文末之下松手 → 搬到文末', doc.at(-1)?.startsWith('![[wide'), JSON.stringify(doc))
    check('R8 松手后零指示线', !!r && r.after.length === 0, JSON.stringify(r?.after))
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
