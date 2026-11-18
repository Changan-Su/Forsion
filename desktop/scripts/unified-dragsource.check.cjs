// 拖动途中被拖块被别处改了(另一个分栏 / 同步 / Agent 写盘回灌进来):松手搬的必须是**现在的内容**。
// 真输入:`page.mouse` 真拖 + 静止期同坐标 mouse.move 模拟 OS 周期 dragover(同 unified-dragfeel)。
// 拖动途中的改动经台架探针直驱 PM 事务(`__upage.probe.view()`,不进撤销栈 = 同回灌口径),S3 走真回灌
// (`__upage.fire` 改盘 → UnifiedPage 的 reconcile → reconcileTr 最小差异事务)。
//
// 修前(PR #755 之上):performDrop 删的是当前选区 / dragstart 时的 `dragging.node`,插的是 dragstart 缓存的
// `view.dragging.slice` —— 新字丢掉;位置挪过时还会删错区间。修后:dragstart 记下来源区间,每个事务都映射它,
// 松手按映射后的区间取现内容删 + 插;来源被删 / 换了类型 = 整次拖动作废(不动文档、不留线)。
//
//  S1 正文里的缝(落点插件 handleDrop → performDrop)+ 途中给被拖段补字 → 落下的那段带着新字(修前红)
//  S2 左页边 ⠿ 那一道(页边路由 → performDrop)+ 途中补字 → 同上(修前红)
//  S3 真回灌:途中盘上那段被改写、回灌进视图 → 落下的是改写后的那段(修前红)
//  S4 途中被拖段被删 → 作废:文档只少了那段、旧内容不复活、松手后 0 根线、无落位动画、view.dragging 清掉
//  S5 途中被拖段换了类型(段落 → 标题)→ 作废:标题留在原位
//  S6 途中被拖标题只改了属性(## → ###,整块替换、块选区随之退化)→ 照搬,搬过去的是 ### 那份(修前:松手无反应)
//  S7 途中在它前面插了一段(位置整体后移)→ 搬的是被拖那段,插进来的那段原样留着
//  S8 跨块选区整批拖(正文 → executeMoveBlocks)+ 途中改其中一段 → 两段一起搬、改动在(回归护栏)
//  S9 拖到右缘拼栏(executePair)+ 途中补字 → 成列、新字在(回归护栏)
//  S10 途中被拖段被删、紧跟着的是分隔线 → 作废(修前:块选区退化到分隔线上,松手删掉分隔线、旧的段2 复活)
//  PM 自己起的拖拽(块选中后按住正文拖,不经 ⠿;Codex 评审 11-18):
//  S11 原生拖 + 途中补字 → 落下的那段带着新字(PM 改字后会换掉 view.dragging 对象,来源记录不能认它的身份)
//  S12 原生拖 + 途中被删、后跟分隔线、松手在分隔线上 → 作废,分隔线还在(修前:PM 缺省 drop 删掉分隔线、旧字复活)
//  S13 原生拖 + 途中补字、松手在它自己身上(落点插件不给目标 → 走 PM 缺省落点那条)→ 新字还在(修前:换回旧字)
// 用法:node scripts/e2e-editor.cjs --check=unified-dragsource(或 npm run check:dragsource)
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

const FILE = 'Source.md'
const P = (n) => `段${n}。这是第 ${n} 段,用来拖。`
const SEED = Array.from({ length: 8 }, (_, i) => P(i + 1)).join('\n\n') + '\n'
/** 某块的下半(落在它之后);dx = 相对块左缘,right = 相对块右缘。 */
const lowerHalf = (p, prefix, dx = 120) => async () => { const t = await rectOf(p, prefix); return { x: t.x + dx, y: t.y + t.h * 0.75 } }
/** 只数落位动画(被拖块身上的;落点线的淡入淡出不算)。 */
const landAnims = (p) => p.evaluate(() => window.__anims.filter((x) => x.text.startsWith('段')).length)
const SEED_HR = [P(1), P(2), '---', P(3), P(4), P(5), P(6)].join('\n\n') + '\n'
const SEED_H = [P(1), '## 甲节标题', P(2), P(3), P(4), P(5), P(6)].join('\n\n') + '\n'
const READY = '.unified-body .ProseMirror > p'

async function openPage(browser, seed) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 1000 }, reducedMotion: 'no-preference' })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.addInitScript(() => {
    // 落位动画探针(同 unified-dragfeel):作废的拖动不该播。
    window.__anims = []
    const origA = Element.prototype.animate
    Element.prototype.animate = function (kf, o) {
      try { window.__anims.push({ text: (this.textContent || '').slice(0, 6) }) } catch { /* 探针不碍事 */ }
      return origA.call(this, kf, o)
    }
  })
  await p.goto(`${URL}?upage&upane`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.unified-body .ProseMirror', { timeout: 20000 })
  await p.evaluate(([f, s]) => window.__upage.switchFile(f, s), [FILE, seed])
  await p.waitForSelector(READY, { timeout: 20000 })
  await p.waitForTimeout(600)
  return p
}

/** 可见的指示线(宽度 > 0)。 */
const lines = (p) => p.evaluate(() => [...document.querySelectorAll('.unified-drop-line, .unified-drop-vline')]
  .filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0)
  .map((el) => { const r = el.getBoundingClientRect(); return { v: el.classList.contains('unified-drop-vline'), y: Math.round(r.y + r.height / 2) } }))

/** 文档速写:顶层节点 → 段落「段N」/ 标题「hN:文字」/ 分栏行 { row };full = 每块全文(查新字在不在)。 */
const snap = (p) => p.evaluate(() => {
  const v = window.__upage.probe.view()
  const tag = (n) => n.type.name === 'paragraph' ? (n.textContent.match(/^段\d+/)?.[0] ?? n.textContent.slice(0, 4))
    : n.type.name === 'heading' ? `h${n.attrs.level}:${n.textContent}` : n.type.name
  const shape = []
  const full = []
  v.state.doc.forEach((n) => {
    if (n.type.name === 'amadeusColumnRow') {
      const row = []
      n.forEach((c) => { const cell = []; c.forEach((k) => { cell.push(tag(k)); full.push(k.textContent) }); row.push(cell) })
      shape.push({ row })
    } else {
      shape.push(tag(n))
      full.push(n.textContent)
    }
  })
  return { shape, full, dragging: !!v.dragging }
})
const rectOf = (p, prefix) => p.evaluate((k) => {
  const el = [...document.querySelectorAll('.unified-body .ProseMirror > p, .unified-body .ProseMirror > h2, .unified-body .ProseMirror > h3')].find((x) => x.textContent.startsWith(k))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }
}, prefix)
const gutterState = (p) => p.evaluate(() => {
  const g = document.querySelector('.unified-gutter')
  const h = g?.querySelector('.drag-handle')
  if (!g || !h) return null
  const r = h.getBoundingClientRect()
  return { show: g.dataset.show === 'true', x: r.x + r.width / 2, y: r.y + Math.min(10, r.height / 2) }
})
/** hover 到块 → 等 gutter 挂出且稳住 → ⠿ 中心。 */
async function handleAt(p, x, y) {
  await p.mouse.move(x, y, { steps: 4 })
  let prev = null
  for (let t = 0; t < 3000; t += 40) {
    await p.waitForTimeout(40)
    const g = await gutterState(p)
    if (g?.show && prev && Math.abs(prev.y - g.y) < 0.5) return g
    prev = g
  }
  return null
}
/** 静止期:同坐标反复 move = OS 周期补发的 dragover。 */
const idle = async (p, x, y, ms = 240) => { for (let t = 0; t < ms; t += 15) { await p.mouse.move(x, y); await p.waitForTimeout(15) } }
async function press(p, from) {
  await p.mouse.move(from.x, from.y)
  await p.mouse.down()
  await p.mouse.move(from.x + 3, from.y + 4, { steps: 2 })
}

/** 拖动途中别处改了文档:经探针直驱一笔不进撤销栈的事务(同回灌口径)。of = 目标块文字前缀。 */
const remoteEdit = (p, kind, arg) => p.evaluate(([kind, arg]) => {
  const v = window.__upage.probe.view()
  let hit = null
  v.state.doc.forEach((n, off) => { if (!hit && n.textContent.startsWith(arg.of)) hit = { n, off } })
  if (!hit) return 'miss'
  const { n, off } = hit
  let tr = v.state.tr
  // insert 而不是 insertText:后者在选区末端正好是插入点时会把选区收成光标(探针假象,回灌走 tr.replace 不会)。
  if (kind === 'append') tr = tr.insert(off + n.nodeSize - 1, v.state.schema.text(arg.text))
  else if (kind === 'delete') tr = tr.delete(off, off + n.nodeSize)
  else if (kind === 'retype') tr = tr.setNodeMarkup(off, v.state.schema.nodes[arg.type], arg.attrs)
  else if (kind === 'attrs') tr = tr.setNodeMarkup(off, undefined, { ...n.attrs, ...arg.attrs })
  else if (kind === 'before') tr = tr.insert(off, v.state.schema.nodes.paragraph.create(null, v.state.schema.text(arg.text)))
  v.dispatch(tr.setMeta('addToHistory', false))
  return 'ok'
}, [kind, arg])

/** 跨块文字选区:从 a 段内容首铺到 b 段内容尾(同 toplevel-realdrag 的 selectAcross)。 */
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
}, [a, b])

/** 块选中某段(NodeSelection,同 ⠿ 单击的结果):之后按住它的正文拖 = PM 自己起拖。 */
const selectNode = (p, prefix) => p.evaluate((pre) => {
  const v = window.__upage.probe.view()
  let at = -1
  v.state.doc.forEach((n, off) => { if (at < 0 && n.textContent.startsWith(pre)) at = off })
  let Base = v.state.selection.constructor
  while (Object.getPrototypeOf(Base) !== Function.prototype) Base = Object.getPrototypeOf(Base)
  v.dispatch(v.state.tr.setSelection(Base.fromJSON(v.state.doc, { type: 'node', anchor: at })))
  v.focus() // 没聚焦时按下去先聚焦、PM 按 DOM 选区把块选中换成光标,就不起原生拖了
  return v.state.selection.constructor.name
}, prefix)
/** 拖动中:谁起的拖(⠿ = 块层 dataset;native = 只有 PM 的 view.dragging)。 */
const dragKind = (p) => p.evaluate(() => { const v = window.__upage.probe.view(); return !v.dragging ? 'none' : v.dom.dataset.dragging === 'true' ? 'handle' : 'native' })
/** 按住块的正文(块选中时 PM 起原生拖)→ 同 dragWithEdit。 */
async function nativeDragWithEdit(p, from, aim, edit) {
  await p.mouse.move(from.x, from.y)
  await p.mouse.down()
  await p.mouse.move(from.x + 4, from.y + 6, { steps: 3 })
  let to = await aim()
  await p.mouse.move(to.x, to.y, { steps: 10 })
  await idle(p, to.x, to.y)
  const kind = await dragKind(p)
  const editRes = await edit()
  to = await aim()
  await p.mouse.move(to.x, to.y, { steps: 3 })
  await idle(p, to.x, to.y)
  await p.mouse.up()
  await p.waitForTimeout(450)
  return { kind, editRes, after: await lines(p) }
}

/** 拖 ⠿ 那块,先到 aim()(静止一会儿让落点定下来)→ 途中改动 → 重新瞄准 aim()(改动可能让目标块挪了位置,
 *  人会跟着目标走)并静止(落点按新文档重判)→ 松手。 */
async function dragWithEdit(p, h, aim, edit) {
  await press(p, h)
  let to = await aim()
  await p.mouse.move(to.x, to.y, { steps: 10 })
  await idle(p, to.x, to.y)
  const editRes = await edit()
  to = await aim()
  await p.mouse.move(to.x, to.y, { steps: 3 })
  await idle(p, to.x, to.y)
  const during = await lines(p)
  await p.mouse.up()
  await p.waitForTimeout(450)
  const after = await lines(p)
  return { editRes, during, after }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const shot = async (p, name) => { if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await p.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) }) } }
  const ADD = '(拖动途中补的字)'

  // ── S1 正文里的缝 + 途中补字 ───────────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED)
    const a = await rectOf(p, '段2')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const r = h ? await dragWithEdit(p, h, lowerHalf(p, '段6'), () => remoteEdit(p, 'append', { of: '段2', text: ADD })) : null
    const s = await snap(p)
    const moved = s.full.filter((x) => x.startsWith('段2'))
    check('S1 前置:把手挂出、途中改动落进去了、松手前有一根线', !!h && r?.editRes === 'ok' && r.during.length === 1, JSON.stringify(r))
    check('S1 段2 落到段6 之后、只有一份', s.shape.indexOf('段2') === s.shape.indexOf('段6') + 1 && moved.length === 1, JSON.stringify(s.shape))
    check('S1 落下的段2 带着途中补的字(修前:丢)', moved.length === 1 && moved[0].includes(ADD), JSON.stringify(moved))
    check('S1 松手后不留线', !!r && r.after.length === 0, JSON.stringify(r?.after))
    await shot(p, 'S1-after')
    await p.close()
  }

  // ── S2 左页边 ⠿ 那一道 + 途中补字 ──────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED)
    const a = await rectOf(p, '段2')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const r = h ? await dragWithEdit(p, h, async () => ({ x: h.x, y: (await lowerHalf(p, '段6')()).y }), () => remoteEdit(p, 'append', { of: '段2', text: ADD })) : null
    const s = await snap(p)
    const moved = s.full.filter((x) => x.startsWith('段2'))
    check('S2 前置:途中改动落进去了、松手前有一根横线', !!h && r?.editRes === 'ok' && r.during.length === 1 && !r.during[0].v, JSON.stringify(r))
    check('S2 段2 落到段6 之后、只有一份', s.shape.indexOf('段2') === s.shape.indexOf('段6') + 1 && moved.length === 1, JSON.stringify(s.shape))
    check('S2 落下的段2 带着途中补的字(修前:丢)', moved.length === 1 && moved[0].includes(ADD), JSON.stringify(moved))
    await p.close()
  }

  // ── S3 真回灌:途中盘上那段被改写 ──────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED)
    const a = await rectOf(p, '段2')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const t = await rectOf(p, '段6')
    const NEW = '段2。别处改写过的第二段。'
    const r = h ? await dragWithEdit(p, h, lowerHalf(p, '段6'), async () => {
      const before = await p.evaluate(() => window.__upage.probe.reconciled ?? 0)
      await p.evaluate(([f, s]) => window.__upage.fire(f, s), [FILE, SEED.replace(P(2), NEW)])
      for (let k = 0; k < 40; k++) {
        await idle(p, t.x + 120, t.y + t.h * 0.75, 60)
        const got = await p.evaluate((pre) => window.__upage.probe.view().state.doc.textContent.includes(pre), NEW)
        if (got) return `ok(reconciled ${before}→${await p.evaluate(() => window.__upage.probe.reconciled ?? 0)})`
      }
      return 'reconcile never landed'
    }) : null
    const s = await snap(p)
    const moved = s.full.filter((x) => x.startsWith('段2'))
    check('S3 前置:回灌在拖动途中落进视图', !!h && /^ok/.test(r?.editRes ?? ''), JSON.stringify(r))
    check('S3 段2 落到段6 之后、只有一份', s.shape.indexOf('段2') === s.shape.indexOf('段6') + 1 && moved.length === 1, JSON.stringify(s.shape))
    check('S3 落下的是改写后的那段(修前:回到旧字)', moved.length === 1 && moved[0] === NEW, JSON.stringify(moved))
    await p.close()
  }

  // ── S4 途中被拖段被删 → 作废 ──────────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED)
    const a = await rectOf(p, '段2')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    await p.evaluate(() => { window.__anims.length = 0 })
    const r = h ? await dragWithEdit(p, h, lowerHalf(p, '段6'), () => remoteEdit(p, 'delete', { of: '段2' })) : null
    const s = await snap(p)
    const anims = await landAnims(p)
    const want = ['段1', '段3', '段4', '段5', '段6', '段7', '段8']
    check('S4 前置:途中删除落进去了', !!h && r?.editRes === 'ok', JSON.stringify(r?.editRes))
    check('S4 文档 = 原文少了段2(旧内容没复活、别的块没被删)', JSON.stringify(s.shape) === JSON.stringify(want), JSON.stringify(s.shape))
    check('S4 松手后 0 根线、无落位动画、view.dragging 已清', !!r && r.after.length === 0 && anims === 0 && !s.dragging, JSON.stringify({ after: r?.after, anims, dragging: s.dragging }))
    await p.close()
  }

  // ── S5 途中换了类型(段落 → 标题)→ 作废 ───────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED)
    const a = await rectOf(p, '段2')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    await p.evaluate(() => { window.__anims.length = 0 })
    const r = h ? await dragWithEdit(p, h, lowerHalf(p, '段6'), () => remoteEdit(p, 'retype', { of: '段2', type: 'heading', attrs: { level: 2 } })) : null
    const s = await snap(p)
    const anims = await landAnims(p)
    check('S5 前置:途中换类型落进去了', !!h && r?.editRes === 'ok', JSON.stringify(r?.editRes))
    check('S5 标题留在原位(第 2 块)、没被搬、没多出段2', s.shape[1] === `h2:${P(2)}` && s.shape.length === 8 && !s.shape.includes('段2'), JSON.stringify(s.shape))
    check('S5 松手后 0 根线、无落位动画、view.dragging 已清', !!r && r.after.length === 0 && anims === 0 && !s.dragging, JSON.stringify({ after: r?.after, anims, dragging: s.dragging }))
    await p.close()
  }

  // ── S6 途中只改了属性(## → ###)→ 照搬新的那份 ────────────────────────────────────────
  {
    const p = await openPage(browser, SEED_H)
    const a = await rectOf(p, '甲节标题')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const r = h ? await dragWithEdit(p, h, lowerHalf(p, '段5'), () => remoteEdit(p, 'attrs', { of: '甲节标题', attrs: { level: 3 } })) : null
    const s = await snap(p)
    check('S6 前置:途中改属性落进去了', !!h && r?.editRes === 'ok', JSON.stringify(r?.editRes))
    check('S6 标题搬到段5 之后、是 ### 那份、只有一份(修前:松手无反应)', s.shape.indexOf('h3:甲节标题') === s.shape.indexOf('段5') + 1 && s.shape.filter((x) => /甲节标题/.test(x)).length === 1, JSON.stringify(s.shape))
    check('S6 松手后不留线', !!r && r.after.length === 0, JSON.stringify(r?.after))
    await p.close()
  }

  // ── S7 途中在它前面插了一段(位置整体后移)→ 搬对块 ─────────────────────────────────────
  {
    const p = await openPage(browser, SEED)
    const a = await rectOf(p, '段3')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const r = h ? await dragWithEdit(p, h, lowerHalf(p, '段6'), () => remoteEdit(p, 'before', { of: '段1', text: '新来的一段。' })) : null
    const s = await snap(p)
    const want = ['新来的一', '段1', '段2', '段4', '段5', '段6', '段3', '段7', '段8']
    check('S7 前置:途中插入落进去了', !!h && r?.editRes === 'ok', JSON.stringify(r?.editRes))
    check('S7 搬的是段3、插进来的那段原样在文首', JSON.stringify(s.shape) === JSON.stringify(want) && s.full[0] === '新来的一段。', JSON.stringify(s.shape))
    await p.close()
  }

  // ── S8 跨块选区整批拖(正文 → executeMoveBlocks)+ 途中改其中一段 ─────────────────────────
  {
    const p = await openPage(browser, SEED)
    await selectAcross(p, '段2', '段3')
    await p.waitForTimeout(200)
    const a = await rectOf(p, '段2')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const r = h ? await dragWithEdit(p, h, async () => { const t = await rectOf(p, '段6'); return { x: t.x + t.w * 0.5, y: t.y + t.h * 0.75 } }, () => remoteEdit(p, 'append', { of: '段3', text: ADD })) : null
    const s = await snap(p)
    const want = ['段1', '段4', '段5', '段6', '段2', '段3', '段7', '段8']
    check('S8 前置:途中改动落进去了', !!h && r?.editRes === 'ok', JSON.stringify(r))
    check('S8 段2 段3 一起搬到段6 之后', JSON.stringify(s.shape) === JSON.stringify(want), JSON.stringify(s.shape))
    check('S8 段3 的新字在、只有一份', s.full.filter((x) => x.startsWith('段3')).length === 1 && s.full.find((x) => x.startsWith('段3'))?.includes(ADD), JSON.stringify(s.full.filter((x) => x.startsWith('段3'))))
    await p.close()
  }

  // ── S9 拖到右缘拼栏(executePair)+ 途中补字 ────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED)
    const a = await rectOf(p, '段2')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    const r = h ? await dragWithEdit(p, h, async () => { const t = await rectOf(p, '段5'); return { x: t.r - 10, y: t.y + t.h / 2 } }, () => remoteEdit(p, 'append', { of: '段2', text: ADD })) : null
    const s = await snap(p)
    const row = s.shape.find((n) => n && n.row)?.row
    check('S9 前置:途中改动落进去了、松手前是竖线', !!h && r?.editRes === 'ok' && r.during.length === 1 && r.during[0].v, JSON.stringify(r))
    check('S9 成列 [段5 | 段2]', !!row && row[0][0] === '段5' && row[1][0] === '段2', JSON.stringify(s.shape))
    check('S9 列里的段2 带着新字、只有一份', s.full.filter((x) => x.startsWith('段2')).length === 1 && s.full.find((x) => x.startsWith('段2'))?.includes(ADD), JSON.stringify(s.full.filter((x) => x.startsWith('段2'))))
    await p.close()
  }

  // ── S10 途中被删、后面紧跟分隔线 → 作废(不许删到分隔线)─────────────────────────────────
  {
    const p = await openPage(browser, SEED_HR)
    const a = await rectOf(p, '段2')
    const h = await handleAt(p, a.x + 30, a.y + a.h / 2)
    await p.evaluate(() => { window.__anims.length = 0 })
    const r = h ? await dragWithEdit(p, h, lowerHalf(p, '段5'), () => remoteEdit(p, 'delete', { of: '段2' })) : null
    const s = await snap(p)
    const anims = await landAnims(p)
    const want = ['段1', 'hr', '段3', '段4', '段5', '段6']
    check('S10 前置:途中删除落进去了', !!h && r?.editRes === 'ok', JSON.stringify(r?.editRes))
    check('S10 分隔线还在、段2 没复活、别的块没动', JSON.stringify(s.shape) === JSON.stringify(want), JSON.stringify(s.shape))
    check('S10 作废后不出线、松手后 0 根线、无落位动画', !!r && r.during.length === 0 && r.after.length === 0 && anims === 0, JSON.stringify({ during: r?.during, after: r?.after, anims }))
    await p.close()
  }

  // ── S11 原生拖 + 途中补字 ─────────────────────────────────────────────────────────────
  {
    const p = await openPage(browser, SEED)
    const sel = await selectNode(p, '段2')
    const a = await rectOf(p, '段2')
    const r = await nativeDragWithEdit(p, { x: a.x + 60, y: a.y + a.h / 2 }, lowerHalf(p, '段6'), () => remoteEdit(p, 'append', { of: '段2', text: ADD }))
    const s = await snap(p)
    const moved = s.full.filter((x) => x.startsWith('段2'))
    check('S11 前置:块选中、PM 自己起的拖、途中改动落进去了', /NodeSelection/.test(sel) && r.kind === 'native' && r.editRes === 'ok', JSON.stringify({ sel, ...r }))
    check('S11 段2 落到段6 之后、只有一份、带着新字', s.shape.indexOf('段2') === s.shape.indexOf('段6') + 1 && moved.length === 1 && moved[0].includes(ADD), JSON.stringify({ shape: s.shape, moved }))
    await p.close()
  }

  // ── S12 原生拖 + 途中被删、后跟分隔线、松手在分隔线上 → 作废 ───────────────────────────────
  {
    const p = await openPage(browser, SEED_HR)
    const sel = await selectNode(p, '段2')
    const a = await rectOf(p, '段2')
    const hrAim = async () => p.evaluate(() => {
      const el = document.querySelector('.unified-body .ProseMirror > hr, .unified-body .ProseMirror > [data-type="hr"], .unified-body .ProseMirror > .hr')
      const r = (el || document.querySelector('.unified-body .ProseMirror hr')).getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    const r = await nativeDragWithEdit(p, { x: a.x + 60, y: a.y + a.h / 2 }, hrAim, () => remoteEdit(p, 'delete', { of: '段2' }))
    const s = await snap(p)
    check('S12 前置:PM 自己起的拖、途中删除落进去了', /NodeSelection/.test(sel) && r.kind === 'native' && r.editRes === 'ok', JSON.stringify({ sel, ...r }))
    check('S12 分隔线还在、段2 没复活', JSON.stringify(s.shape) === JSON.stringify(['段1', 'hr', '段3', '段4', '段5', '段6']), JSON.stringify(s.shape))
    await p.close()
  }

  // ── S13 原生拖 + 途中补字 + 松手在自己身上(落点插件无目标,走 PM 缺省落点)──────────────────
  {
    const p = await openPage(browser, SEED)
    const sel = await selectNode(p, '段2')
    const a = await rectOf(p, '段2')
    const self = async () => { const r = await rectOf(p, '段2'); return { x: r.x + 160, y: r.y + r.h / 2 } }
    // 先拖远(起拖),再回到段2 正中松手
    const r = await nativeDragWithEdit(p, { x: a.x + 60, y: a.y + a.h / 2 }, async () => (await self()), () => remoteEdit(p, 'append', { of: '段2', text: ADD }))
    const s = await snap(p)
    const moved = s.full.filter((x) => x.startsWith('段2'))
    check('S13 前置:PM 自己起的拖、途中改动落进去了', /NodeSelection/.test(sel) && r.kind === 'native' && r.editRes === 'ok', JSON.stringify({ sel, ...r }))
    check('S13 段2 只有一份、新字还在、其余块次序不变', moved.length === 1 && moved[0].includes(ADD) && JSON.stringify(s.shape) === JSON.stringify(['段1', '段2', '段3', '段4', '段5', '段6', '段7', '段8']), JSON.stringify({ shape: s.shape, moved }))
    await p.close()
  }

  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} passed`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
