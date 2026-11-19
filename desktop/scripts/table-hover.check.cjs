// 表格悬停层(unified/tableHover.ts;「页面编辑对齐 Notion」第 3 条,2026-11-17)。跑生产 UnifiedPage(台架 `?upage&upane`),
// 落盘以 window.__upage.writes 为准。
//   H  悬停:没悬停什么都不出;悬停一格 → 下 / 右加号条、右下角圆点、那一行的行首把手、那一列的列首把手;
//      条贴着表边、不盖住下一段;移开就收;表头行浅底 + 半粗 + 次级字色;110% 缩放下照样对齐;只读不出。
//   A  加号条:点下方 = 末尾加一行、光标进新行首格;点右侧 = 末尾加一列(`---`)、光标进新列表头;
//      落盘是标准 GFM;连点两下再撤销一次只少一行(每次一个撤销步)。
//   C  右下角圆点:拖出 3 行 2 列,拖的途中文档不动、条上标 +N;松手一笔加上、撤销一次全回去;Esc 中途作废。
//   G  把手菜单:行把手只列行操作(不带对齐、不带整表的删除 / 复制),列把手列列操作 + 对齐;表头行把手只有「在下方插入行」;
//      菜单里删行 / 设居中落盘;Esc 收起。
//   D  把手拖动换序:正文行搬到最上面一行正文;列搬到最左(居中对齐 `:-:` 跟着列走);撤销一次回去;表头行拖不动。
//   R  存盘重开逐字不变:把 D 之后的落盘重开、在后面一段打一个字,表格那几行逐字不变。
//   T  手机(粗指针 390×844):不悬停加号条也常显、右侧那条不出屏、底下那条不盖住下一段;点一下加一行;
//      长按单元格(安卓 WebView 发 contextmenu)出整表块菜单的表格区,锚在那一格。
//   E  英文界面:条的提示与把手菜单的标签是英文。
// 用法:npm run check:tablehover(由 e2e-editor 自起/复用 Vite;worktree 里设 HARNESS_URL 指独立端口)。
//   `--only=H,A` 只跑指定组;`--shot[=目录]` 存截图(缺省 /tmp/forsion-table-hover)。
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const ONLY = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length)).split(',').filter(Boolean)
const want = (g) => !ONLY.length || ONLY.includes(g)
const shotArg = process.argv.find((a) => a === '--shot' || a.startsWith('--shot='))
const SHOT = shotArg ? (shotArg.includes('=') ? shotArg.slice('--shot='.length) : '/tmp/forsion-table-hover') : null
if (SHOT) fs.mkdirSync(SHOT, { recursive: true })
const PM = '.unified-body .ProseMirror'
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  | ${detail}`}`)
}
const errors = []

const T = '# 关键数据\n\n| 指标 | 上一版 | 目标 |\n| --- | :-: | --- |\n| 冷启动 | 1.8 s | 1.2 s |\n| 崩溃率 | 0.4% | 0.2% |\n| 周活跃 | 3.1 万 | 4 万 |\n\n后面一段。\n'

let seq = 0
async function load(page, md) {
  const name = `Hover${++seq}.md`
  await page.evaluate(({ name, md }) => window.__upage.switchFile(name, md), { name, md })
  await page.waitForFunction(() => {
    const v = window.__upage.probe.view && window.__upage.probe.view()
    return v && !v.isDestroyed && document.querySelector('.unified-body .ProseMirror table')
  }, null, { timeout: 30000 })
  await page.mouse.move(5, 5)
  await page.waitForTimeout(350)
  return name
}
async function mdOf(page, name) {
  await page.waitForTimeout(1100)
  return page.evaluate((name) => {
    const w = window.__upage.writes.filter((x) => x.path === name)
    return w.length ? w[w.length - 1].text : null
  }, name)
}
const rows = (page) => page.evaluate(() => {
  const v = window.__upage.probe.view()
  let t = null
  v.state.doc.descendants((n) => { if (!t && n.type.name === 'table') { t = n; return false } return true })
  if (!t) return null
  const out = []
  t.forEach((r) => { const cells = []; r.forEach((c) => cells.push(c.textContent)); out.push(cells) })
  return out
})
/** 落盘里的表格:表头 / 分隔行 / 正文行(按 `|` 切好)。 */
function mdTable(md) {
  const lines = (md || '').split('\n').filter((l) => /^\|.*\|$/.test(l))
  const cells = (l) => l.slice(1, -1).split('|').map((s) => s.trim())
  return { lines, head: lines[0] ? cells(lines[0]) : [], delim: lines[1] ? cells(lines[1]) : [], body: lines.slice(2).map(cells) }
}
const isGfm = (t) => t.lines.length >= 3 && t.delim.length === t.head.length && t.delim.every((d) => /^:?-+:?$/.test(d)) && t.body.every((r) => r.length === t.head.length)
const ui = (page) => page.evaluate(() => {
  const o = {}
  for (const e of document.querySelectorAll('.amx-tbl-ui')) {
    if (e.dataset.touch != null) continue
    const k = e.classList.contains('amx-tbl-add') ? `add-${e.dataset.axis}` : e.classList.contains('amx-tbl-grip') ? `grip-${e.dataset.axis}` : e.classList.contains('amx-tbl-corner') ? 'corner' : e.classList.contains('amx-tbl-band') ? 'band' : 'drop'
    const r = e.getBoundingClientRect()
    o[k] = { show: e.hasAttribute('data-show'), x: r.x, y: r.y, w: r.width, h: r.height, index: e.dataset.index, text: e.textContent, title: e.title }
  }
  return o
})
const rectOf = (page, sel, text) => page.evaluate(({ sel, text }) => {
  const el = [...document.querySelectorAll(sel)].find((e) => text == null || e.textContent === text)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2, right: r.right, bottom: r.bottom }
}, { sel, text })
/** 悬停文字恰为 text 的格子,等浮层出来。 */
async function hoverCell(page, text) {
  const c = await rectOf(page, `${PM} td, ${PM} th`, text)
  await page.mouse.move(c.x + 12, c.cy, { steps: 3 })
  await page.waitForTimeout(220)
  return c
}
async function clickUi(page, key) {
  const u = (await ui(page))[key]
  await page.mouse.move(u.x + u.w / 2, u.y + u.h / 2, { steps: 2 })
  await page.waitForTimeout(80)
  await page.mouse.click(u.x + u.w / 2, u.y + u.h / 2)
  await page.waitForTimeout(250)
}
const where = (page) => page.evaluate(() => {
  const v = window.__upage.probe.view()
  const s = v.state.selection
  for (let d = s.$head.depth; d >= 1; d--) {
    const n = s.$head.node(d)
    if (n.type.spec.tableRole === 'cell' || n.type.spec.tableRole === 'header_cell') {
      const row = s.$head.index(d - 2), col = s.$head.index(d - 1)
      return { role: n.type.spec.tableRole, row, col, text: n.textContent, focused: v.hasFocus() }
    }
  }
  return { role: null, focused: v.hasFocus() }
})
const undo = async (page) => { await page.evaluate(() => window.__upage.probe.view().focus()); await page.keyboard.press('Meta+z'); await page.waitForTimeout(200) }
const menuItems = (page) => page.evaluate(() => {
  const m = document.querySelector('.amx-table-axis-menu')
  if (!m) return null
  return {
    ops: [...m.querySelectorAll('[data-table-op]')].map((b) => b.dataset.tableOp),
    aligns: [...m.querySelectorAll('[data-table-align]')].map((b) => b.dataset.tableAlign + (b.getAttribute('aria-checked') === 'true' ? '*' : '')),
    label: m.querySelector('.ubm-label')?.textContent,
    all: [...m.querySelectorAll('button')].map((b) => b.textContent.trim()),
  }
})
async function shot(page, name, clip) {
  if (!SHOT) return
  await page.screenshot({ path: path.join(SHOT, `${name}.png`), clip })
}
const clipAround = async (page) => {
  const t = await rectOf(page, `${PM} table`)
  return { x: Math.max(0, t.x - 70), y: Math.max(0, t.y - 70), width: t.w + 140, height: t.h + 140 }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 850 } })
    page.setDefaultTimeout(15000)
    page.on('pageerror', (e) => { errors.push(e.message); console.log('  [pageerror]', e.message) })
    await page.goto(`${URL}?upage&upane&useed=${encodeURIComponent('# t\n\nx\n')}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector(PM, { timeout: 120000 })
    await page.waitForTimeout(400)

    if (want('H')) {
      await load(page, T)
      let u = await ui(page)
      check('H1 没悬停:加号条 / 圆点 / 把手都不出', !u['add-row'].show && !u['add-col'].show && !u.corner.show && !u['grip-row'].show && !u['grip-col'].show, JSON.stringify(u))
      const cell = await hoverCell(page, '0.4%')
      u = await ui(page)
      const t = await rectOf(page, `${PM} table`)
      const row = await rectOf(page, `${PM} tr`, null).then(() => page.evaluate(() => { const r = document.querySelectorAll('.unified-body .ProseMirror tr')[2].getBoundingClientRect(); return { top: r.top, h: r.height } }))
      const th = await rectOf(page, `${PM} th`, '上一版')
      check('H2 悬停:下 / 右加号条 + 右下角圆点都出', u['add-row'].show && u['add-col'].show && u.corner.show)
      check('H3 下方条贴着表底、与表同宽;右侧条贴着表右缘、与表同高(缝 6、粗 18)',
        Math.abs(u['add-row'].x - t.x) < 1 && Math.abs(u['add-row'].w - t.w) < 1 && Math.abs(u['add-row'].y - (t.bottom + 6)) < 1.5 && Math.abs(u['add-row'].h - 18) < 1
        && Math.abs(u['add-col'].x - (t.right + 6)) < 1.5 && Math.abs(u['add-col'].h - t.h) < 1 && Math.abs(u['add-col'].w - 18) < 1, JSON.stringify({ u, t }))
      check('H4 行首把手在悬停那一行的左缘正中(第 3 行)', u['grip-row'].show && u['grip-row'].index === '2' && Math.abs(u['grip-row'].x + u['grip-row'].w / 2 - t.x) < 1.5 && Math.abs(u['grip-row'].y + u['grip-row'].h / 2 - (row.top + row.h / 2)) < 1.5, JSON.stringify({ g: u['grip-row'], row }))
      check('H5 列首把手在悬停那一列的上缘正中(第 2 列)', u['grip-col'].show && u['grip-col'].index === '1' && Math.abs(u['grip-col'].x + u['grip-col'].w / 2 - th.cx) < 1.5 && Math.abs(u['grip-col'].y + u['grip-col'].h / 2 - t.y) < 1.5, JSON.stringify({ g: u['grip-col'], th }))
      const next = await rectOf(page, `${PM} > p`, '后面一段。')
      check('H6 下方条不盖住下一段(表下让出了位置)', u['add-row'].y + u['add-row'].h <= next.y + 0.5, JSON.stringify({ bar: u['add-row'], next }))
      // 穿过表与条之间的缝,条不收
      await page.mouse.move(cell.x + 12, t.bottom + 3, { steps: 2 })
      await page.waitForTimeout(250)
      check('H7 指针穿过表与加号条之间的缝:条不收', (await ui(page))['add-row'].show)
      await shot(page, 'hover', await clipAround(page))
      await page.mouse.move(cell.x + 12, next.cy + 60, { steps: 3 })
      await page.waitForTimeout(400)
      u = await ui(page)
      check('H8 移开:整组收起', !u['add-row'].show && !u['grip-row'].show && !u['grip-col'].show)
      const style = await page.evaluate(() => {
        const th = getComputedStyle(document.querySelector('.unified-body .ProseMirror th'))
        const td = getComputedStyle(document.querySelector('.unified-body .ProseMirror td'))
        const probe = document.createElement('span'); probe.style.color = 'var(--text-muted)'; document.querySelector('.unified-body').append(probe)
        const muted = getComputedStyle(probe).color; probe.remove()
        return { thBg: th.backgroundColor, tdBg: td.backgroundColor, fw: th.fontWeight, color: th.color, muted }
      })
      check('H9 表头行:浅底 + 半粗(600)+ 次级字色', style.thBg !== 'rgba(0, 0, 0, 0)' && style.thBg !== style.tdBg && style.fw === '600' && style.color === style.muted, JSON.stringify(style))
      // 110% 缩放
      await page.evaluate(() => { document.documentElement.style.zoom = '1.1' })
      await page.waitForTimeout(200)
      await hoverCell(page, '0.4%')
      u = await ui(page)
      const tz = await rectOf(page, `${PM} table`)
      check('H10 110% 缩放:下方条仍贴着表底、右侧条仍贴着右缘',
        Math.abs(u['add-row'].x - tz.x) < 2 && Math.abs(u['add-row'].y - (tz.bottom + 6 * 1.1)) < 2 && Math.abs(u['add-col'].x - (tz.right + 6 * 1.1)) < 2 && Math.abs(u['add-col'].h - tz.h) < 2, JSON.stringify({ u: u['add-row'], c: u['add-col'], tz }))
      await shot(page, 'hover-110', await clipAround(page))
      await page.evaluate(() => { document.documentElement.style.zoom = '' })
      await page.mouse.move(5, 5)
      await page.waitForTimeout(300)
      // 只读
      await page.evaluate(() => window.__upage.probe.view().setProps({ editable: () => false }))
      await hoverCell(page, '0.4%')
      u = await ui(page)
      check('H11 只读:悬停什么都不出', !u['add-row'].show && !u['grip-row'].show && !u.corner.show)
      await page.evaluate(() => window.__upage.probe.view().setProps({ editable: () => true }))
    }

    if (want('A')) {
      let nm = await load(page, T)
      await hoverCell(page, '1.8 s')
      await clickUi(page, 'add-row')
      let r = await rows(page)
      let w = await where(page)
      await page.keyboard.type('新行')
      let md = await mdOf(page, nm)
      let mt = mdTable(md)
      check('A1 点下方条:末尾加一行,光标进新行首格', r.length === 5 && r[4].every((c) => c === '') && w.row === 4 && w.col === 0 && w.focused, JSON.stringify({ r, w }))
      check('A1 落盘:新行在末尾、是标准 GFM、无 <br />', isGfm(mt) && mt.body.length === 4 && mt.body[3][0] === '新行' && !/<br/i.test(md || ''), JSON.stringify(md))
      nm = await load(page, T)
      await hoverCell(page, '1.8 s')
      await clickUi(page, 'add-col')
      r = await rows(page)
      w = await where(page)
      await page.keyboard.type('备注')
      md = await mdOf(page, nm)
      mt = mdTable(md)
      check('A2 点右侧条:末尾加一列,光标进新列表头', r.every((x) => x.length === 4) && w.role === 'header_cell' && w.col === 3, JSON.stringify({ r, w }))
      check('A2 落盘:新列表头在、分隔是 `---`、原居中列仍 `:-:`', isGfm(mt) && mt.head[3] === '备注' && /^-+$/.test(mt.delim[3]) && /^:-+:$/.test(mt.delim[1]), JSON.stringify(mt))
      // 连点两下 → 撤销一次只少一行
      await load(page, T)
      await hoverCell(page, '1.8 s')
      await clickUi(page, 'add-row')
      await clickUi(page, 'add-row')
      const n2 = (await rows(page)).length
      await undo(page)
      const n1 = (await rows(page)).length
      await undo(page)
      const n0 = (await rows(page)).length
      check('A3 连点两次加一行、撤销一次只少一行(每次一个撤销步)', n2 === 6 && n1 === 5 && n0 === 4, JSON.stringify({ n2, n1, n0 }))
      // 打字之后马上点加号:撤销先撤加号那一步,字还在
      nm = await load(page, T)
      await page.evaluate(() => {
        const v = window.__upage.probe.view()
        let at = null
        v.state.doc.descendants((n, p) => { if (at == null && n.isTextblock && n.textContent === '后面一段。') at = p + n.nodeSize - 1; return at == null })
        v.focus(); v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at))))
      })
      await page.keyboard.type('甲')
      await hoverCell(page, '1.8 s')
      await clickUi(page, 'add-row')
      await undo(page)
      const after = await page.evaluate(() => document.querySelector('.unified-body .ProseMirror').textContent.includes('后面一段。甲'))
      check('A4 刚打完字就点加号:撤销一次只撤加号,刚打的字还在', (await rows(page)).length === 4 && after)
      // 加完行马上在新格里打字(500ms 内,prosemirror-history 会按相邻合组):撤销一次只撤字,再撤一次才撤行
      await load(page, T)
      await hoverCell(page, '1.8 s')
      await clickUi(page, 'add-row')
      await page.keyboard.type('乙')
      await undo(page)
      const u1 = await rows(page)
      await undo(page)
      const u2 = await rows(page)
      check('A5 加行后马上打字:撤销一次只撤字(新行还在),再撤一次才撤行', u1.length === 5 && u1[4][0] === '' && u2.length === 4, JSON.stringify({ u1, u2 }))
    }

    if (want('C')) {
      const nm = await load(page, T)
      await hoverCell(page, '1.8 s')
      const before = await rows(page)
      const geo = await page.evaluate(() => {
        const t = document.querySelector('.unified-body .ProseMirror table')
        const trs = [...t.rows]
        const body = trs.slice(1)
        // 横向步长 = min(列宽, 96)(tableHover.ts COL_STEP_MAX):整栏宽的表按列宽算要拖出窗外
        return { rowH: body.reduce((s, r) => s + r.getBoundingClientRect().height, 0) / body.length, colW: Math.min(96, t.getBoundingClientRect().width / trs[0].cells.length) }
      })
      const c = (await ui(page)).corner
      const sx = c.x + c.w / 2, sy = c.y + c.h / 2
      await page.mouse.move(sx, sy, { steps: 2 })
      await page.mouse.down()
      await page.mouse.move(sx + geo.colW * 2.1, sy + geo.rowH * 3.1, { steps: 10 })
      await page.waitForTimeout(120)
      const mid = await ui(page)
      const midRows = await rows(page)
      await shot(page, 'corner-drag', { x: 150, y: 120, width: 1050, height: 560 })
      await page.mouse.up()
      await page.waitForTimeout(200)
      const r = await rows(page)
      const pane = await rectOf(page, '.amx-pane')
      check('C1 拖右下角途中:文档不动,条上标 +3 / +2,右侧条不伸出滚动容器', JSON.stringify(midRows) === JSON.stringify(before) && mid['add-row'].text === '+3' && mid['add-col'].text === '+2' && mid['add-row'].h > 40 && mid['add-col'].w > 40
        && mid['add-col'].x + mid['add-col'].w <= pane.right, JSON.stringify({ row: mid['add-row'], col: mid['add-col'], pane }))
      check('C2 松手:一次加上 3 行 2 列', r.length === 7 && r.every((x) => x.length === 5) && JSON.stringify(r[0].slice(0, 3)) === JSON.stringify(before[0]), JSON.stringify(r))
      const md = await mdOf(page, nm)
      const mt = mdTable(md)
      check('C2 落盘:标准 GFM 7 行 5 列,新列 `---`', isGfm(mt) && mt.head.length === 5 && mt.body.length === 6 && /^-+$/.test(mt.delim[4]), JSON.stringify(mt))
      await undo(page)
      check('C3 撤销一次:3 行 2 列整批回去', JSON.stringify(await rows(page)) === JSON.stringify(before))
      // Esc 中途作废
      await hoverCell(page, '1.8 s')
      const c2 = (await ui(page)).corner
      await page.mouse.move(c2.x + c2.w / 2, c2.y + c2.h / 2, { steps: 2 })
      await page.mouse.down()
      await page.mouse.move(c2.x + 200, c2.y + 150, { steps: 6 })
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await page.waitForTimeout(200)
      const u = await ui(page)
      check('C4 拖到一半按 Esc:什么都不加,条复原', JSON.stringify(await rows(page)) === JSON.stringify(before) && u['add-row'].text === '' && Math.abs(u['add-row'].h - 18) < 1, JSON.stringify(u['add-row']))
    }

    if (want('G')) {
      let nm = await load(page, T)
      await hoverCell(page, '崩溃率')
      await clickUi(page, 'grip-row')
      let m = await menuItems(page)
      const band = (await ui(page)).band
      check('G1 行把手点开:只有行操作(上方 / 下方插入、删除行),不带对齐、不带整表删除 / 复制', m && m.ops.join(',') === 'rowAbove,rowBelow,deleteRow' && m.aligns.length === 0 && m.label === '行' && m.all.length === 3, JSON.stringify(m))
      check('G1 菜单开着:那一行盖着高亮', band.show, JSON.stringify(band))
      await shot(page, 'row-menu', { x: 150, y: 120, width: 1050, height: 560 })
      await page.click('.amx-table-axis-menu [data-table-op="deleteRow"]')
      await page.waitForTimeout(200)
      let md = await mdOf(page, nm)
      let mt = mdTable(md)
      check('G2 行菜单「删除行」:删掉的是把手那一行,落盘少一行', JSON.stringify((await rows(page)).map((x) => x[0])) === '["指标","冷启动","周活跃"]' && isGfm(mt) && mt.body.length === 2 && !(await menuItems(page)), JSON.stringify(mt))
      nm = await load(page, T)
      await hoverCell(page, '1.2 s')
      await clickUi(page, 'grip-col')
      m = await menuItems(page)
      check('G3 列把手点开:列操作 + 对齐(当前左对齐打勾)', m && m.ops.join(',') === 'colLeft,colRight,deleteCol' && m.aligns.join(',') === 'left*,center,right' && m.label === '列', JSON.stringify(m))
      await shot(page, 'col-menu', { x: 150, y: 80, width: 1050, height: 600 })
      await page.click('.amx-table-axis-menu [data-table-align="right"]')
      await page.waitForTimeout(200)
      md = await mdOf(page, nm)
      mt = mdTable(md)
      check('G4 列菜单「右对齐」:落盘第 3 列分隔是 `--:`', isGfm(mt) && /^-+:$/.test(mt.delim[2]) && /^:-+:$/.test(mt.delim[1]), JSON.stringify(mt))
      await load(page, T)
      await hoverCell(page, '指标')
      await clickUi(page, 'grip-row')
      m = await menuItems(page)
      check('G5 表头行把手:只有「在下方插入行」', m && m.ops.join(',') === 'rowBelow' && m.aligns.length === 0, JSON.stringify(m))
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      check('G6 Esc 收起菜单,焦点回编辑器', !(await menuItems(page)) && (await where(page)).focused)
      // 菜单外点一下收起
      await hoverCell(page, '冷启动')
      await clickUi(page, 'grip-row')
      await page.mouse.click(60, 60)
      await page.waitForTimeout(150)
      check('G7 点菜单外:收起', !(await menuItems(page)))
      // ↓ 进了菜单再按别的键:菜单收起、焦点回编辑器(不落到 body,之后打字照常进正文)
      await hoverCell(page, '冷启动')
      await clickUi(page, 'grip-row')
      await page.keyboard.press('ArrowDown')
      const inMenu = await page.evaluate(() => !!document.querySelector('.amx-table-axis-menu')?.contains(document.activeElement))
      await page.keyboard.press('a')
      await page.waitForTimeout(150)
      const back = await where(page)
      const active = await page.evaluate(() => document.activeElement === document.body)
      check('G8 ↓ 进菜单后按别的键:菜单收起,焦点回编辑器而不是 body', inMenu && !(await menuItems(page)) && back.focused && !active, JSON.stringify({ inMenu, back, active }))
    }

    if (want('D')) {
      let nm = await load(page, T)
      await hoverCell(page, '周活跃')
      let g = (await ui(page))['grip-row']
      const first = await rectOf(page, `${PM} td`, '冷启动')
      await page.mouse.move(g.x + g.w / 2, g.y + g.h / 2, { steps: 2 })
      await page.mouse.down()
      await page.mouse.move(g.x + g.w / 2, first.y + 4, { steps: 8 })
      await page.waitForTimeout(100)
      const mid = await ui(page)
      await shot(page, 'row-drag', { x: 150, y: 120, width: 1050, height: 560 })
      await page.mouse.up()
      await page.waitForTimeout(200)
      let r = await rows(page)
      check('D1 拖行把手:「周活跃」搬到第一行正文;拖的途中有落点线、加号条让开', JSON.stringify(r.map((x) => x[0])) === '["指标","周活跃","冷启动","崩溃率"]' && mid.drop.show && !mid['add-row'].show, JSON.stringify({ r, drop: mid.drop }))
      check('D1 松手不弹菜单', !(await menuItems(page)))
      let md = await mdOf(page, nm)
      let mt = mdTable(md)
      check('D1 落盘:行序跟着变、仍是标准 GFM', isGfm(mt) && mt.body.map((x) => x[0]).join(',') === '周活跃,冷启动,崩溃率', JSON.stringify(mt))
      await undo(page)
      check('D2 撤销一次:行序回去', JSON.stringify((await rows(page)).map((x) => x[0])) === '["指标","冷启动","崩溃率","周活跃"]')
      // 列:居中的第 2 列搬到最左,`:-:` 跟着走
      nm = await load(page, T)
      await hoverCell(page, '1.8 s')
      g = (await ui(page))['grip-col']
      const c0 = await rectOf(page, `${PM} th`, '指标')
      await page.mouse.move(g.x + g.w / 2, g.y + g.h / 2, { steps: 2 })
      await page.mouse.down()
      await page.mouse.move(c0.x + 10, g.y + g.h / 2, { steps: 8 })
      await page.waitForTimeout(100)
      await page.mouse.up()
      await page.waitForTimeout(200)
      r = await rows(page)
      md = await mdOf(page, nm)
      mt = mdTable(md)
      check('D3 拖列把手:「上一版」整列搬到最左', JSON.stringify(r[0]) === '["上一版","指标","目标"]' && JSON.stringify(r[1]) === '["1.8 s","冷启动","1.2 s"]', JSON.stringify(r))
      check('D3 落盘:居中 `:-:` 跟着列走到第 1 列', isGfm(mt) && /^:-+:$/.test(mt.delim[0]) && /^-+$/.test(mt.delim[1]) && mt.head[0] === '上一版', JSON.stringify(mt))
      await undo(page)
      check('D4 撤销一次:列序回去', JSON.stringify((await rows(page))[0]) === '["指标","上一版","目标"]')
      // 表头行拖不动
      await load(page, T)
      await hoverCell(page, '指标')
      g = (await ui(page))['grip-row']
      const last = await rectOf(page, `${PM} td`, '周活跃')
      await page.mouse.move(g.x + g.w / 2, g.y + g.h / 2, { steps: 2 })
      await page.mouse.down()
      await page.mouse.move(g.x + g.w / 2, last.bottom - 2, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(250)
      check('D5 表头行把手拖不动(表头恒为首行)', JSON.stringify((await rows(page)).map((x) => x[0])) === '["指标","冷启动","崩溃率","周活跃"]')
      await page.keyboard.press('Escape')
    }

    if (want('R')) {
      // 先做一轮:加一行一列、换一次行序、设一次右对齐,拿落盘
      const nm = await load(page, T)
      await hoverCell(page, '1.8 s')
      await clickUi(page, 'add-row')
      await page.keyboard.type('末行')
      await hoverCell(page, '1.8 s')
      await clickUi(page, 'add-col')
      await page.keyboard.type('备注')
      const md1 = await mdOf(page, nm)
      const t1 = mdTable(md1)
      await page.evaluate((md) => window.__upage.switchFile('Reopen.md', md), md1)
      await page.waitForTimeout(400)
      const reopened = await rows(page)
      await page.evaluate(() => {
        const v = window.__upage.probe.view()
        let at = null
        v.state.doc.descendants((n, p) => { if (at == null && n.isTextblock && n.textContent === '后面一段。') at = p + n.nodeSize - 1; return at == null })
        v.focus(); v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at))))
      })
      await page.keyboard.type('Z')
      const md2 = await mdOf(page, 'Reopen.md')
      const t2 = mdTable(md2)
      check('R1 存盘重开:表格内容一致、仍是标准 GFM', isGfm(t1) && reopened.length === 5 && reopened[0][3] === '备注' && reopened[4][0] === '末行', JSON.stringify(reopened))
      check('R2 重开后改别处:表格那几行逐字不变', !!md2 && t1.lines.join('\n') === t2.lines.join('\n') && md2.includes('后面一段。Z'), JSON.stringify({ t1: t1.lines, t2: t2.lines }))
    }

    if (want('E')) {
      await page.evaluate(() => window.__upage.setLocale && window.__upage.setLocale('en'))
      await page.waitForTimeout(200)
      await load(page, T)
      await hoverCell(page, '0.4%')
      const u = await ui(page)
      await clickUi(page, 'grip-row')
      const m = await menuItems(page)
      check('E1 英文界面:加号条 / 把手提示与菜单标签是英文', u['add-row'].title === 'Add a row' && u['add-col'].title === 'Add a column' && /^Click for options/.test(u['grip-row'].title) && m && m.label === 'Row' && m.all.includes('Insert row above'), JSON.stringify({ t: [u['add-row'].title, u['add-col'].title, u['grip-row'].title], m }))
      await page.keyboard.press('Escape')
      await page.evaluate(() => window.__upage.setLocale && window.__upage.setLocale('zh'))
    }

    if (want('H') && SHOT) {
      // 暗色截图(自查观感)
      const dark = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 850 } })
      await dark.goto(`${URL}?upage&upane&udark&useed=${encodeURIComponent(T)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await dark.waitForSelector(`${PM} table`, { timeout: 120000 })
      await dark.waitForTimeout(500)
      await hoverCell(dark, '0.4%')
      await shot(dark, 'hover-dark', await clipAround(dark))
      await dark.close()
    }
    await page.close()

    if (want('T')) {
      const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
      const phone = await ctx.newPage()
      phone.setDefaultTimeout(15000)
      phone.on('pageerror', (e) => { errors.push(e.message); console.log('  [pageerror]', e.message) })
      await phone.goto(`${URL}?upage&upane&useed=${encodeURIComponent(T)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await phone.waitForSelector(`${PM} table`, { timeout: 120000 })
      await phone.waitForTimeout(600)
      const coarse = await phone.evaluate(() => matchMedia('(pointer: coarse)').matches)
      const bars = () => phone.evaluate(() => [...document.querySelectorAll('.amx-tbl-add[data-touch]')].filter((e) => e.hasAttribute('data-show')).map((e) => { const r = e.getBoundingClientRect(); return { axis: e.dataset.axis, x: r.x, y: r.y, w: r.width, h: r.height } }))
      let b = await bars()
      const t = await rectOf(phone, `${PM} table`)
      const next = await rectOf(phone, `${PM} > p`, '后面一段。')
      const rowBar = b.find((x) => x.axis === 'row'), colBar = b.find((x) => x.axis === 'col')
      const grips = await phone.evaluate(() => [...document.querySelectorAll('.amx-tbl-grip, .amx-tbl-corner')].filter((e) => e.hasAttribute('data-show')).length)
      check('T1 手机:不悬停,表尾和右侧的加号条常显;没有把手和圆点', coarse && !!rowBar && !!colBar && grips === 0, JSON.stringify({ coarse, b, grips }))
      check('T2 手机:右侧条不出屏、底下条不盖住下一段、条够手指点(≥ 20)', colBar && colBar.x + colBar.w <= 390 && rowBar && rowBar.y + rowBar.h <= next.y + 0.5 && rowBar.h >= 20 && colBar.w >= 20 && Math.abs(rowBar.y - (t.bottom + 6)) < 1.5, JSON.stringify({ rowBar, colBar, t, next }))
      await phone.screenshot({ path: SHOT ? path.join(SHOT, 'phone.png') : '/tmp/forsion-table-hover-phone.png' })
      await phone.touchscreen.tap(rowBar.x + rowBar.w / 2, rowBar.y + rowBar.h / 2)
      await phone.waitForTimeout(300)
      b = await bars()
      const t2 = await rectOf(phone, `${PM} table`)
      const rb2 = b.find((x) => x.axis === 'row')
      check('T3 手机:点底下的条加一行,条跟着挪到新表尾', (await rows(phone)).length === 5 && rb2 && Math.abs(rb2.y - (t2.bottom + 6)) < 1.5, JSON.stringify({ rb2, t2 }))
      await phone.touchscreen.tap(colBar.x + colBar.w / 2, colBar.y + 20)
      await phone.waitForTimeout(300)
      check('T4 手机:点右侧的条加一列', (await rows(phone)).every((x) => x.length === 4))
      // 长按单元格:安卓 WebView 长按 = contextmenu(mobile/scripts 同一种派发法)
      const cell = await rectOf(phone, `${PM} td`, '崩溃率')
      await phone.evaluate(({ x, y }) => {
        const el = [...document.querySelectorAll('.unified-body .ProseMirror td')].find((e) => e.textContent === '崩溃率')
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
      }, { x: cell.x + 10, y: cell.cy })
      await phone.waitForTimeout(300)
      const m = await phone.evaluate(() => {
        const menu = document.querySelector('.unified-block-menu:not(.amx-table-axis-menu)')
        return menu && { ops: [...menu.querySelectorAll('[data-table-op]')].map((b) => b.dataset.tableOp), aligns: menu.querySelectorAll('[data-table-align]').length }
      })
      check('T5 手机长按单元格(contextmenu):出整表块菜单的表格区,锚在那一格(能删这一行、有对齐)', m && m.ops.includes('deleteRow') && m.ops.includes('rowAbove') && m.aligns === 3, JSON.stringify(m))
      if (m) {
        await phone.evaluate(() => document.querySelector('.unified-block-menu [data-table-op="deleteRow"]').click())
        await phone.waitForTimeout(250)
        check('T6 手机长按菜单删行:删的是按住的那一行', !(await rows(phone)).some((x) => x[0] === '崩溃率'))
      }
      await ctx.close()
    }
    check('Z 无未捕获页面错误', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
  }
  const fail = results.filter((x) => !x).length
  console.log(`\n${results.length - fail}/${results.length} PASS${fail ? `,${fail} FAIL` : ''}`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
