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
//  R5b 顶层配对:先由落点插件画线再进配对区 → 只剩竖线、松手零残留(钉微任务收敛)
//  R6 行下沿正下方静止 → 只有一条线、落到行后
//  R7 落回自身(右栏末块拖回右栏空白)→ 不出线、文档不变
//  R8 文末之下(tail 路由)松手 → 零残留
//  R9 两栏之间的缝(深处)松手 → 不进任何一列(修前:线画在左列、块进左列)
//  R10 右栏首段上缘 → 落进右栏首位,仍是两列
//  R11 另一列一串短段挤满候选表时,高块中段仍出线且落进本列(评审 P2:库只问最近 8 个候选)
//  R12 折叠列(末块 rect 全 0)不画零宽线、不把块塞进隐藏区(评审 P1)
//  R13 配对竖线只出在 executePair 接得住的目标上(评审 P1:列表第 2 项起恒 false)
//  R14 拖进「移到新列」造出的空列,不留占位空段(评审 P3)
//  R15 列内分割线(叶子块)上缘的线 → 松手真落在 hr 之前(评审二 P1:drop 侧曾从 DOM 反推位置,叶子块少 1)
//  R16 嵌套折叠(先折 ### 再折 ##)拖到列末 → 两层都展开,块不掉进内层隐藏区(评审二 P2)
//  R17 列内 callout 里面悬停 → 交回落点插件,块能落进 callout(评审二 P3:列内曾整块接管容器)
//  R18 列内落回自身 → 不出线,也不顺手展开上方的折叠小节(评审二 P3)
//  ⚠️ R7/R18 从**右栏**块拖起:「不出线 / 文档不变」在拖拽根本没起来时也成立,所以先断言 view.dragging。
//     右栏块的 ⠿ 画在前一列上方,指针一靠近,把手曾被重新锚到左栏块 → R7 自第一版起恒绿(09-22 第二轮)。
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

/** 死区布局:左栏一串短段(把落点插件的 8 个候选挤满),右栏一张高图。 */
const SEED_DEAD = [
  '---', 'amadeus_schema: amadeus.page/4',
  'amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["d0"],"width":1},{"refs":["d1"],"width":1}],"tail":"d2"}]}',
  '---', '开头段。', '', '<!-- a d0 -->', '',
  ...Array.from({ length: 6 }, (_, i) => `短段 ${i + 1}。\n`),
  '<!-- a d1 -->', '', '![[tall.png|300]]', '', '<!-- a d2 -->', '', '行后段。', '',
].join('\n')

/** 折叠列:右栏是「标题 + 段落」,折起标题后末块 display:none(rect 全 0)。 */
const SEED_FOLD = [
  '---', 'amadeus_schema: amadeus.page/4',
  'amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["f0"],"width":1},{"refs":["f1"],"width":1}],"tail":"f2"}]}',
  '---', '开头段。', '', '<!-- a f0 -->', '', '![[tall.png|185]]', '',
  '<!-- a f1 -->', '', '## 小节标题', '', '小节正文。', '', '<!-- a f2 -->', '', '行后段。', '',
].join('\n')

/** 空列(「移到新列」造出来的形态:两个锚之间没有内容)。 */
const SEED_EMPTY = [
  '---', 'amadeus_schema: amadeus.page/4',
  'amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["e0"],"width":1},{"refs":["e1"],"width":1}],"tail":"e2"}]}',
  '---', '开头段。', '', '<!-- a e0 -->', '', '![[tall.png|185]]', '', '<!-- a e1 -->', '', '<!-- a e2 -->', '', '行后段。', '',
].join('\n')

/** 列内分割线:右栏 = 段甲 / hr / 段乙(hr 是叶子块,没有 contentDOM)。 */
const SEED_HR = [
  '---', 'amadeus_schema: amadeus.page/4',
  'amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["h0"],"width":1},{"refs":["h1"],"width":1}],"tail":"h2"}]}',
  '---', '开头段。', '', '<!-- a h0 -->', '', '![[tall.png|185]]', '',
  '<!-- a h1 -->', '', '段甲。', '', '---', '', '段乙。', '', '<!-- a h2 -->', '', '行后段。', '',
].join('\n')

/** 嵌套折叠:右栏 = ## 甲 / 甲一 / ### 乙 / 乙一。 */
const SEED_NFOLD = [
  '---', 'amadeus_schema: amadeus.page/4',
  'amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["n0"],"width":1},{"refs":["n1"],"width":1}],"tail":"n2"}]}',
  '---', '开头段。', '', '<!-- a n0 -->', '', '![[tall.png|185]]', '',
  '<!-- a n1 -->', '', '## 甲', '', '甲一。', '', '### 乙', '', '乙一。', '', '<!-- a n2 -->', '', '行后段。', '',
].join('\n')

/** 列内 callout:右栏 = 一只 callout(标注 / 内一 / 内二)。 */
const SEED_CALLOUT = [
  '---', 'amadeus_schema: amadeus.page/4',
  'amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["q0"],"width":1},{"refs":["q1"],"width":1}],"tail":"q2"}]}',
  '---', '开头段。', '', '<!-- a q0 -->', '', '![[tall.png|185]]', '',
  '<!-- a q1 -->', '', '> [!note] 标注', '>', '> 内一。', '>', '> 内二。', '', '<!-- a q2 -->', '', '行后段。', '',
].join('\n')

/** 落回自身:右栏 = ## 甲(将折起) / 甲一 / ## 乙(被拖的就是它)。 */
const SEED_SELF = [
  '---', 'amadeus_schema: amadeus.page/4',
  'amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["s0"],"width":1},{"refs":["s1"],"width":1}],"tail":"s2"}]}',
  '---', '开头段。', '', '<!-- a s0 -->', '', '![[tall.png|185]]', '',
  '<!-- a s1 -->', '', '## 甲', '', '甲一。', '', '## 乙', '', '<!-- a s2 -->', '', '行后段。', '',
].join('\n')

/** 顶层列表:配对判据的负面目标(第 2 项起 executePair 必 false)。 */
const SEED_LIST = ['开头段。', '', '- 甲', '- 乙', '- 丙', '', '末段。', ''].join('\n')

async function openPage(browser, seed = SEED, file = 'Cols.md', ready = '.unified-body .amx-ucolrow') {
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
  await p.evaluate(([f, seed]) => window.__upage.switchFile(f, seed), [file, seed])
  await p.waitForSelector(ready, { timeout: 20000 })
  await p.waitForTimeout(700)
  await p.evaluate(() => {
    window.__dnd = { allowed: null, vdrag: null }
    // 冒泡末端记 dragstart 之后的 effectAllowed(gutter 自己的 dragstart 在 content 上,先于 window 冒泡)
    window.addEventListener('dragstart', (e) => { window.__dnd.allowed = e.dataTransfer?.effectAllowed ?? null })
  })
  return p
}

/** 可见的指示线:横线(.unified-drop-line,blockLayer 自己的与落点插件的各一枚)+ 竖线(.unified-drop-vline)。
 *  all=true 连零宽的也算:拿折叠块(rect 全 0)当落点画出的线就是 display:block + 宽 0,默认过滤会把它
 *  滤掉 —— R12「不画零宽线」曾因此恒绿(负对照 NC8 实跑才现形)。 */
const lines = (p, all = false) => p.evaluate((all) => [...document.querySelectorAll('.unified-drop-line, .unified-drop-vline')]
  .filter((el) => getComputedStyle(el).display !== 'none' && (all || el.getBoundingClientRect().width > 0))
  .map((el) => { const r = el.getBoundingClientRect(); return { v: el.classList.contains('unified-drop-vline'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } }), all)

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

/** 等 gutter 真锚到指针下的这一块、且位置稳住(连读两次相同),返回 ⠿ 与折叠钮的中心;2s 等不到 → null。
 *  hover 有 80ms 节流 + 后沿:固定等 250ms 在高负载(load 30+)下不够,读到的是指针途经那一块的把手 ——
 *  09-22 实测拖错块两次(行后段拖成左栏大图 → 左列拖空、整行解散)。 */
async function anchoredGutter(p, x, y) {
  let prev = null
  for (let t = 0; t < 2000; t += 50) {
    const cur = await p.evaluate(([x, y]) => {
      const g = document.querySelector('.unified-gutter')
      if (!g || g.dataset.show !== 'true') return null
      const el = document.elementFromPoint(x, y)?.closest('.ProseMirror > *, .amx-ucolcell > *')
      if (!el || Math.abs(g.getBoundingClientRect().top - el.getBoundingClientRect().top) > 20) return null
      const at = (sel) => {
        const b = g.querySelector(sel)
        if (!b || getComputedStyle(b).display === 'none') return null
        const r = b.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + Math.min(10, r.height / 2) }
      }
      return { handle: at('.drag-handle'), fold: at('.block-fold') }
    }, [x, y])
    if (cur && prev && JSON.stringify(cur) === JSON.stringify(prev)) return cur
    prev = cur
    await p.waitForTimeout(50)
  }
  return null
}
/** hover 到块 → 等 gutter 锚稳 → ⠿ 中心。 */
async function handleAt(p, x, y) {
  await p.mouse.move(x, y, { steps: 4 })
  return (await anchoredGutter(p, x, y))?.handle ?? null
}
/** 悬停标题 → 点 gutter 的折叠钮;点到返回 true。 */
async function foldHeading(p, tag, text) {
  const head = await p.evaluate(([t, s]) => {
    const el = [...document.querySelectorAll(`.unified-body .ProseMirror ${t}`)].find((x) => x.textContent.includes(s))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, h: r.height }
  }, [tag, text])
  if (!head) return false
  await p.mouse.move(head.x + 30, head.y + head.h / 2, { steps: 3 })
  const fold = (await anchoredGutter(p, head.x + 30, head.y + head.h / 2))?.fold
  if (!fold) return false
  await p.mouse.click(fold.x, fold.y)
  await p.waitForTimeout(350)
  return true
}
/** 静止期:同坐标反复 move = OS 周期补发的 dragover(真机指针不动时 Chromium 仍在派发)。 */
const idle = async (p, x, y, ms = 240) => { for (let t = 0; t < ms; t += 15) { await p.mouse.move(x, y); await p.waitForTimeout(15) } }
/** 从 ⠿ 按下 → 沿途经过 via(可空)→ 停在 to 静止 → 读线 → 松手 → 读线。 */
async function drag(p, from, via, to) {
  // 真人路径:从块上分步移到把手、停一下再按(> hover 的 80ms 节流,让节流的末次 move 在按下前落地)。
  // 瞬移 + 立刻按下会赶在节流之前,把手「被重新锚走」这类 bug 就只在一部分轮次里现形。
  await p.mouse.move(from.x, from.y, { steps: 6 })
  await p.waitForTimeout(150)
  await p.mouse.down()
  await p.mouse.move(from.x + 5, from.y + 5, { steps: 2 })
  if (via) { await p.mouse.move(via.x, via.y, { steps: 8 }); await idle(p, via.x, via.y, 120) }
  const viaLines = via ? await lines(p) : null
  await p.mouse.move(to.x, to.y, { steps: 10 })
  await idle(p, to.x, to.y)
  const during = await lines(p)
  const duringAll = await lines(p, true)
  const vdrag = await p.evaluate(() => !!window.__upage.probe.view().dragging)
  await p.mouse.up()
  await p.waitForTimeout(450)
  return { during, duringAll, viaLines, after: await lines(p), vdrag, allowed: await p.evaluate(() => window.__dnd.allowed) }
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

  // ── R5b 顶层配对:先让**落点插件**画出横线,再进配对区 → 只剩竖线;松手成行后零残留 ────────
  // (R5 的列内路径如今整支由 planCellDrop 自解析,插件根本不出线 —— 那条测不到「同步收敛」。
  //  这里的 via 停在分栏之外的顶层段落下缘,线由插件画,才真正钉住微任务收敛 + 各收尾口的藏。
  //  ⚠️ via 要贴段落**左端**:插件按「到线段端点」的距离只问最近 8 个候选,停在段落横向中点时最近的
  //  全是下方分栏行在列缝附近的端点(行内位置 / 列缝都被否掉)→ 那里本来就不出线,前置态摆不出来;
  //  也别进左缘 EDGE(28px)以内,那是配对区,出的是竖线。)
  {
    const p = await openPage(browser)
    const img = await rect(p, '.wiki-inline-img-wrap', 1)
    const h = await handleAt(p, img.x + 30, img.y + 30)
    const top = await blockRect(p, '热力图等内容')
    const target = await blockRect(p, 'Forsion Extend')
    const r = h && top && target ? await drag(p, h, { x: top.x + 40, y: top.b - 2 }, { x: target.x + 6, y: target.y + target.h / 2 }) : null
    check('R5b 前置:经过点上落点插件真画出了横线', !!r && (r.viaLines ?? []).some((l) => !l.v), JSON.stringify(r?.viaLines))
    check('R5b 顶层配对区静止:只有竖线(插件那条横线已收敛)', !!r && r.during.length === 1 && r.during[0].v, JSON.stringify(r?.during))
    const doc = await shape(p)
    const rows = doc.filter((n) => n && n.row)
    check('R5b 松手成行(Forsion 段与图并成新的一行,原来那行还在)', rows.length === 2 && rows[0].row.some((c) => c.some((k) => k.startsWith('Forsion'))), JSON.stringify(doc))
    check('R5b 松手后零指示线', !!r && r.after.length === 0, JSON.stringify(r?.after))
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
    check('R7 前置:右栏块的 ⠿ 真拖起来了(view.dragging 在)', !!r && r.vdrag, JSON.stringify({ vdrag: r?.vdrag, allowed: r?.allowed }))
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

  // ── R11 死区:左栏一串短段挤满候选表 → 右栏高图中段仍要出线、落进右栏 ────────────────
  // (库只问最近 8 个候选;左栏短段的块边全在前 8 里,两道新拒绝把它们拒光就会「不出线也不落」。
  //  修法不是继续跟库讨价还价,而是列内落点整支由 planCellDrop 自解析。)
  {
    const p = await openPage(browser, SEED_DEAD, 'Dead.md')
    const src = await blockRect(p, '行后段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const img = await rect(p, '.amx-ucolcell:nth-of-type(2) .wiki-inline-img-wrap')
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const r = h && img ? await drag(p, h, null, { x: img.x + img.w * 0.5, y: img.y + img.h * 0.5 }) : null
    const row = rowOf(await shape(p))
    const inCol = (r?.during ?? []).filter((l) => !l.v && l.x >= cell2.x - 2 && l.x + l.w <= cell2.r + 2)
    check('R11 高图中段悬停:出线且线在右栏', !!r && r.during.length === 1 && inCol.length === 1, JSON.stringify(r?.during))
    check('R11 松手 → 落进右栏(不留在行后、不进左栏)', !!row && row[1].some((k) => k === '行后段。') && !row[0].some((k) => k === '行后段。'), JSON.stringify(row))
    await p.close()
  }

  // ── R12 折叠列:末块被折叠藏起来(rect 全 0)→ 不许出零宽线、不许把块塞进隐藏区 ────────
  {
    const p = await openPage(browser, SEED_FOLD, 'Fold.md')
    // 折起右栏的标题:悬停它 → gutter 的折叠钮
    const head = await foldHeading(p, 'h2', '小节标题')
    const folded = head && await p.evaluate(() => [...document.querySelectorAll('.unified-body .amx-ucolcell p')].some((el) => el.textContent.startsWith('小节正文') && el.getClientRects().length === 0))
    check('R12 前置:右栏末块真被折叠藏起来(rect 全 0)', folded, JSON.stringify({ head, folded }))
    const src = await blockRect(p, '行后段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const rowR = await rect(p, '.amx-ucolrow')
    const r = h ? await drag(p, h, null, { x: cell2.x + cell2.w * 0.6, y: cell2.b + (rowR.b - cell2.b) * 0.5 }) : null
    const zero = (r?.duringAll ?? []).filter((l) => l.w <= 1)
    check('R12 折叠列里不画零宽线', !!r && zero.length === 0, JSON.stringify(r?.duringAll))
    const inCol12 = (r?.during ?? []).filter((l) => !l.v && l.x >= cell2.x - 2 && l.x + l.w <= cell2.r + 2)
    check('R12 折叠列末悬停:恰好一条线且在右栏', !!r && r.during.length === 1 && inCol12.length === 1, JSON.stringify(r?.during))
    const row12 = rowOf(await shape(p))
    check('R12 松手后落进右栏末尾', !!row12 && row12[1].at(-1) === '行后段。', JSON.stringify(row12))
    const hidden = await p.evaluate(() => [...document.querySelectorAll('.unified-body .ProseMirror p')].some((el) => el.textContent.startsWith('行后段') && el.getClientRects().length === 0))
    check('R12 松手后被拖的块仍在画面上(没掉进隐藏区)', !hidden, JSON.stringify({ hidden, doc: await shape(p) }))
    await p.close()
  }

  // ── R13 配对判据与 executePair 同源:列表第 2 项左缘不许出竖线 ──────────────────────
  // (executePair 对「非顶层、且祖先没有顶级行」的目标恒 false;竖线只看 EDGE 距离 → 修前是
  //  「竖线明晃晃地在、松手零反应」,加了 dropGuard 之后更明显。)
  {
    const p = await openPage(browser, SEED_LIST, 'List.md', '.unified-body .ProseMirror li')
    const src = await blockRect(p, '末段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const li = await p.evaluate(() => {
      const el = [...document.querySelectorAll('.unified-body .ProseMirror li')][1]
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, h: r.height }
    })
    const r = h && li ? await drag(p, h, null, { x: li.x + 6, y: li.y + li.h / 2 }) : null
    check('R13 列表第 2 项左缘:不出竖线', !!r && r.during.every((l) => !l.v), JSON.stringify(r?.during))
    const doc = await shape(p)
    check('R13 松手后没有凭空多出列', !doc.some((n) => n && n.row), JSON.stringify(doc))
    await p.close()
  }

  // ── R14 空列(「移到新列」造出来的形态):拖进去不留占位空段 ──────────────────────────
  {
    const p = await openPage(browser, SEED_EMPTY, 'Empty.md')
    const before = rowOf(await shape(p))
    const src = await blockRect(p, '行后段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const r = h ? await drag(p, h, null, { x: cell2.x + cell2.w * 0.5, y: cell2.y + 12 }) : null
    const row = rowOf(await shape(p))
    check('R14 前置:右栏是空列', !!before && before[1].length === 1 && before[1][0] === '', JSON.stringify(before))
    check('R14 拖进空列:列里只剩那个块(没留占位空段)', !!row && row[1].length === 1 && row[1][0] === '行后段。', JSON.stringify({ row, during: r?.during }))
    await p.close()
  }

  // ── R15 列内分割线:线画在 hr 上缘 → 松手就落在 hr 之前 ────────────────────────────
  // (评审二 P1:drop 侧曾用 posAtDOM(lineEl,0)-1 反推位置 —— 有内容的块 posAtDOM 给内容起点,减 1
  //  正好是块前位;hr 这类叶子块没有 contentDOM,给的就是块前位,再减 1 就错位 → 解析失败被吞 = 线在、
  //  松手零反应。)
  {
    const p = await openPage(browser, SEED_HR, 'Hr.md')
    const src = await blockRect(p, '行后段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const a = await blockRect(p, '段甲')
    const hr = await rect(p, '.amx-ucolcell hr')
    check('R15 前置:右栏里有 hr,且它与段甲之间有缝', !!a && !!hr && hr.y - a.b >= 4, JSON.stringify({ a, hr }))
    const r = h && a && hr ? await drag(p, h, null, { x: cell2.x + cell2.w * 0.5, y: (a.b + hr.y) / 2 }) : null
    const inCol = (r?.during ?? []).filter((l) => !l.v && l.x >= cell2.x - 2 && l.x + l.w <= cell2.r + 2)
    check('R15 段甲与 hr 之间悬停:恰好一条线在右栏', !!r && r.during.length === 1 && inCol.length === 1, JSON.stringify(r?.during))
    const row = rowOf(await shape(p))
    check('R15 松手 → 落在 hr 之前', !!row && JSON.stringify(row[1]) === JSON.stringify(['段甲。', '行后段。', 'hr', '段乙。']), JSON.stringify(row))
    await p.close()
  }

  // ── R16 嵌套折叠:先折乙(###)再折甲(##),拖到列末 → 两层都得展开 ─────────────────────
  // (评审二 P2:只展开最外层的话,块插在乙一之后,仍在乙的隐藏小节里 = 当场看不见。)
  {
    const p = await openPage(browser, SEED_NFOLD, 'NFold.md')
    const f1 = await foldHeading(p, 'h3', '乙')
    const f2 = await foldHeading(p, 'h2', '甲')
    const hid = await p.evaluate(() => ['甲一', '乙一'].map((t) => [...document.querySelectorAll('.unified-body .amx-ucolcell p')].some((el) => el.textContent.startsWith(t) && el.getClientRects().length === 0)))
    check('R16 前置:甲、乙两层都折起(甲一、乙一都不可见)', f1 && f2 && hid[0] && hid[1], JSON.stringify({ f1, f2, hid }))
    const src = await blockRect(p, '行后段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    const rowR = await rect(p, '.amx-ucolrow')
    const r = h ? await drag(p, h, null, { x: cell2.x + cell2.w * 0.6, y: cell2.b + (rowR.b - cell2.b) * 0.5 }) : null
    const vis = await p.evaluate(() => [...document.querySelectorAll('.unified-body .ProseMirror p')].some((el) => el.textContent.startsWith('行后段') && el.getClientRects().length > 0))
    const row = rowOf(await shape(p))
    check('R16 松手后块落进右栏末尾且看得见(两层折叠都展开了)', !!r && vis && !!row && row[1].at(-1) === '行后段。', JSON.stringify({ vis, row }))
    await p.close()
  }

  // ── R17 列内 callout:指针在它里面 → 交回落点插件,块落进 callout 里 ──────────────────
  // (评审二 P3:列内曾把容器块整块接管,只能落在 callout 前后;v1 与顶层都能拖进去。)
  {
    const p = await openPage(browser, SEED_CALLOUT, 'Callout.md')
    const src = await blockRect(p, '行后段')
    const h = src ? await handleAt(p, src.x + 30, src.y + src.h / 2) : null
    const a = await blockRect(p, '内一')
    const b = await blockRect(p, '内二')
    const cell2 = await rect(p, '.amx-ucolcell', 1)
    check('R17 前置:callout 里两段都渲染出来了', !!a && !!b && b.y > a.b, JSON.stringify({ a, b }))
    const r = h && a && b ? await drag(p, h, null, { x: cell2.x + cell2.w * 0.5, y: (a.b + b.y) / 2 }) : null
    const inner = await p.evaluate(() => {
      let out = null
      window.__upage.probe.view().state.doc.descendants((n) => {
        if (out) return false
        if (n.type.name !== 'blockquote') return true
        out = []
        n.forEach((k) => out.push(k.textContent.slice(0, 8)))
        return false
      })
      return out
    })
    check('R17 callout 内两段之间悬停:恰好一条横线', !!r && r.during.length === 1 && !r.during[0].v, JSON.stringify(r?.during))
    check('R17 松手 → 落进 callout(内一、行后段、内二)', !!inner && inner.indexOf('行后段。') > 0 && inner.indexOf('行后段。') === inner.indexOf('内一。') + 1, JSON.stringify(inner))
    await p.close()
  }

  // ── R18 列内落回自身:不出线,也不顺手展开上方的折叠小节 ─────────────────────────────
  // (评审二 P3:展开曾排在「落回自身」判定之前 —— no-op 的 drop 把甲展开了。)
  {
    const p = await openPage(browser, SEED_SELF, 'Self.md')
    const hiddenP = (pre) => p.evaluate((t) => [...document.querySelectorAll('.unified-body .ProseMirror p')].some((el) => el.textContent.startsWith(t) && el.getClientRects().length === 0), pre)
    const f = await foldHeading(p, 'h2', '甲')
    const hid0 = await hiddenP('甲一')
    check('R18 前置:甲折起(甲一不可见)', f && hid0, JSON.stringify({ f, hid0 }))
    const hb = await p.evaluate(() => {
      const el = [...document.querySelectorAll('.unified-body .ProseMirror h2')].find((x) => x.textContent.includes('乙'))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    const h = hb ? await handleAt(p, hb.x + 30, hb.y + hb.h / 2) : null
    const r = h ? await drag(p, h, null, { x: hb.x + hb.w * 0.5, y: hb.y + hb.h * 0.3 }) : null
    const hid1 = await hiddenP('甲一')
    const row = rowOf(await shape(p))
    check('R18 前置:右栏块的 ⠿ 真拖起来了(view.dragging 在)', !!r && r.vdrag, JSON.stringify({ vdrag: r?.vdrag, allowed: r?.allowed }))
    check('R18 落回自身:不出线、文档不变、甲仍折着', !!r && r.during.length === 0 && hid1 && !!row && row[1].length === 3, JSON.stringify({ during: r?.during, hid1, row }))
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
