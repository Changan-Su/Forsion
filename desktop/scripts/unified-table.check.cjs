// v4 统一编辑器的表格编辑(K-10,Amadeus 评审 2026-09-27 波次 1 · table 包;合并 R-06 / R-07)。
// 全部跑生产 UnifiedPage(台架 `?upage`),落盘以 window.__upage.writes 为准。
//   E  键盘:Enter 下移同列 / 末行加行 / 表头 → 首行 / 单元格里只有触发符 `-` 也下移;Mod-Enter 跳出(含引用里的表);
//      Shift+Enter 格内换行落盘 `<br>` 且重开仍是两行;末格 Tab 加行进新行首格;首格 Shift-Tab 不动不丢焦点;
//      新行的空格子落盘为空(不是 `<br />`)。
//   M  块菜单:右键单元格出「表格」区、不列文字类「转换为」;段落上照旧;插行/插列/删行/删列/对齐 → 落盘 md;
//      表头行不给「上方插入行 / 删除行」;只剩一行正文不给删行、一列不给删列;⠿ 打开只给追加行列;斜杠建的表能长大。
//   S  落盘:格内文字以空格结尾且含 `|` 照样转义(L-09b)。
//   L  `/表格` 骨架的表头跟界面语言落盘(R-16):英文界面 `| Column 1 | Column 2 |`,中文界面 `| 列 1 | 列 2 |`。
// 用法:npm run check:table(由 e2e-editor 自起/复用 Vite;worktree 里设 HARNESS_URL)。`--only=E,M` 只跑指定组。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const ONLY = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length)).split(',').filter(Boolean)
const want = (g) => !ONLY.length || ONLY.includes(g)
const PM = '.unified-body .ProseMirror'
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

const T3 = '# 表\n\n| a | b |\n| --- | --- |\n| r1 | x |\n| r2 | y |\n| r3 | z |\n\n后段。\n'

async function open(browser) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${URL}?upage&useed=${encodeURIComponent('# t\n\nx\n')}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.waitForTimeout(400)
  return page
}
let seq = 0
/** 同一页换一篇新笔记(比整页重开快);返回文件名,落盘按它过滤。 */
async function load(page, md) {
  const name = `Table${++seq}.md`
  await page.evaluate(({ name, md }) => window.__upage.switchFile(name, md), { name, md })
  await page.waitForFunction(() => {
    const v = window.__upage.probe.view && window.__upage.probe.view()
    return v && !v.isDestroyed && document.querySelector('.unified-body .ProseMirror')
  }, null, { timeout: 30000 })
  await page.waitForTimeout(350)
  return name
}
/** 该文件最后一次落盘(等过防抖)。 */
async function mdOf(page, name) {
  await page.waitForTimeout(1100)
  return page.evaluate((name) => {
    const w = window.__upage.writes.filter((x) => x.path === name)
    return w.length ? w[w.length - 1].text : null
  }, name)
}
/** 表格逐行逐格的文字(第 n 张表)。 */
const rows = (page, nth = 0) => page.evaluate((nth) => {
  const v = window.__upage.probe.view()
  const tables = []
  v.state.doc.descendants((n) => { if (n.type.name === 'table') { tables.push(n); return false } return true })
  const t = tables[nth]
  if (!t) return null
  const out = []
  t.forEach((r) => { const cells = []; r.forEach((c) => cells.push(c.textContent)); out.push(cells) })
  return out
}, nth)
/** 光标放进文字恰为 text 的单元格(内容末尾);直接派发 PM 选区,不赌点击后的异步 selectionchange。 */
const caretInCell = (page, text, atStart = false) => page.evaluate(({ text, atStart }) => {
  const v = window.__upage.probe.view()
  let hit = null
  v.state.doc.descendants((n, p) => {
    if (hit != null) return false
    const role = n.type.spec.tableRole
    if ((role === 'cell' || role === 'header_cell') && n.textContent === text) { hit = atStart ? p + 2 : p + n.nodeSize - 2; return false }
    return true
  })
  if (hit == null) return false
  v.focus()
  v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(hit))))
  return true
}, { text, atStart })
/** 选区摘要:所在格文字 / 是否在表内 / 父块。 */
const where = (page) => page.evaluate(() => {
  const v = window.__upage.probe.view()
  const s = v.state.selection
  let cell = null
  for (let d = s.$head.depth; d >= 1; d--) {
    const role = s.$head.node(d).type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') { cell = s.$head.node(d).textContent; break }
  }
  return { type: s.toJSON().type, cell, parent: s.$head.parent.type.name, focused: v.hasFocus() }
})
const topBlocks = (page) => page.evaluate(() => {
  const o = []
  window.__upage.probe.view().state.doc.forEach((n) => o.push(`${n.type.name}:${n.type.name === 'table' ? '' : JSON.stringify(n.textContent)}`))
  return o.join(' / ')
})
/** 右键文字恰为 text 的单元格(或段落),等块菜单出来。 */
async function rightClick(page, text, sel = 'td, th') {
  const c = await page.evaluate(({ PM, text, sel }) => {
    const el = [...document.querySelectorAll(`${PM} ${sel}`)].find((e) => e.textContent === text)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + Math.min(12, r.width / 2), y: r.top + r.height / 2 }
  }, { PM, text, sel })
  if (!c) return false
  await page.mouse.click(c.x, c.y, { button: 'right' })
  await page.waitForSelector('.unified-block-menu', { timeout: 3000 })
  return true
}
/** 块的 ⠿ 把手上右键出块菜单(评审 G4-08 起正文文字上的右键归系统菜单):悬停该块 → 把手出现 → 右键。 */
async function gripRightClick(page, text, sel) {
  const c = await page.evaluate(({ PM, text, sel }) => {
    const el = [...document.querySelectorAll(`${PM} ${sel}`)].find((e) => e.textContent === text)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + Math.min(12, r.width / 2), y: r.top + r.height / 2 }
  }, { PM, text, sel })
  if (!c) return false
  await page.mouse.move(c.x, c.y, { steps: 2 })
  await page.waitForTimeout(250)
  const g = await page.evaluate(() => {
    const el = document.querySelector('.unified-gutter[data-show="true"] .drag-handle')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (!g) return false
  await page.mouse.click(g.x, g.y, { button: 'right' })
  await page.waitForSelector('.unified-block-menu', { timeout: 3000 })
  return true
}
/** 块菜单 + 「转换为 ›」子菜单(10-02 c2 起转换项在子菜单里:先悬停那一行把它拉出来)的项。 */
const menu = async (page) => {
  await page.hover('.unified-block-menu [data-sub="turnInto"]', { timeout: 1500 }).catch(() => {})
  await page.waitForTimeout(120)
  return menuNow(page)
}
const menuNow = (page) => page.evaluate(() => {
  const m = document.querySelector('.unified-block-menu')
  if (!m) return null
  const sub = document.querySelector('.unified-block-submenu')
  return {
    labels: [...m.querySelectorAll('button'), ...(sub ? sub.querySelectorAll('button') : [])].map((b) => b.textContent.trim()),
    ops: [...m.querySelectorAll('[data-table-op]')].map((b) => b.dataset.tableOp),
    aligns: [...m.querySelectorAll('[data-table-align]')].map((b) => b.dataset.tableAlign + (b.getAttribute('aria-checked') === 'true' ? '*' : '')),
  }
})
async function clickMenu(page, sel) {
  await page.click(`.unified-block-menu ${sel}`)
  await page.waitForTimeout(150)
}
const closeMenu = async (page) => { await page.keyboard.press('Escape'); await page.waitForTimeout(120) }

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await open(browser)

    if (want('E')) {
      // E1 正文格 Enter → 下一行同列,不在表后插段。
      {
        const nm = await load(page, T3)
        await caretInCell(page, 'r1')
        await page.keyboard.press('Enter')
        const w = await where(page)
        await page.keyboard.type('Q')
        const md = await mdOf(page, nm)
        check('E1 正文格 Enter → 下一行同列(光标在 r2 末尾,不插段)', w.cell === 'r2' && /\| r2Q +\| y +\|/.test(md || '') && !/\n\nQ\n/.test(md || '') && (await topBlocks(page)) === 'heading:"表" / table: / paragraph:"后段。"', `${JSON.stringify(w)} md=${JSON.stringify(md)}`)
      }
      // E2 表头格 Enter → 第一行正文同列。
      {
        const nm = await load(page, T3)
        await caretInCell(page, 'b')
        await page.keyboard.press('Enter')
        const w = await where(page)
        await page.keyboard.type('Q')
        const md = await mdOf(page, nm)
        check('E2 表头格 Enter → 首行正文同列', w.cell === 'x' && /\| r1 +\| xQ +\|/.test(md || ''), `${JSON.stringify(w)} md=${JSON.stringify(md)}`)
      }
      // E3 末行 Enter → 先加一行再过去(同列),新行其余格落盘为空,不是 `<br />`。
      {
        const nm = await load(page, T3)
        await caretInCell(page, 'z')
        await page.keyboard.press('Enter')
        const w = await where(page)
        await page.keyboard.type('Q')
        const r = await rows(page)
        const md = await mdOf(page, nm)
        check('E3 末行 Enter → 加一行、光标进新行同列', r.length === 5 && r[4][0] === '' && r[4][1] === 'Q' && w.cell === '' && w.type === 'text', `${JSON.stringify(r)} ${JSON.stringify(w)}`)
        check('E3 落盘:新行 `|  | Q |`,空格子不写 <br />', /\n\| +\| Q +\|\n/.test(md || '') && !/<br/i.test(md || ''), JSON.stringify(md))
      }
      // E4 单元格里只有块级触发符 `-` 时 Enter 仍是下移(表格回车必须先于 enterRunsTrigger)。
      {
        const nm = await load(page, '| a | b |\n| --- | --- |\n| - | x |\n| r2 | y |\n')
        await caretInCell(page, '-')
        await page.keyboard.press('Enter')
        const w = await where(page)
        await page.keyboard.type('Q')
        const md = await mdOf(page, nm)
        check('E4 格内只有 `-` 时 Enter 仍下移,不转列表', w.cell === 'r2' && /\| - +\| x +\|/.test(md || '') && /\| r2Q +\| y +\|/.test(md || ''), `${JSON.stringify(w)} md=${JSON.stringify(md)}`)
      }
      // E5 Mod-Enter → 跳出:表后新建空段,表不变。
      {
        const nm = await load(page, T3)
        await caretInCell(page, 'r1')
        await page.keyboard.press('Meta+Enter')
        const w = await where(page)
        await page.keyboard.type('Q')
        const md = await mdOf(page, nm)
        check('E5 Mod-Enter 跳出表格(表后新段)', w.cell == null && w.parent === 'paragraph' && /\| r3 +\| z +\|\n\nQ\n\n后段。/.test(md || ''), `${JSON.stringify(w)} md=${JSON.stringify(md)}`)
      }
      // E6 引用里的表:Mod-Enter 同样跳出,单元格不被塞进 `\` 换行(modEnterCmd 的「引用内换行」支)。
      {
        const nm = await load(page, '> | a | b |\n> | --- | --- |\n> | r1 | x |\n\n后段。\n')
        const isTable = (await rows(page)) != null
        await caretInCell(page, 'r1')
        await page.keyboard.press('Meta+Enter')
        await page.keyboard.type('Q')
        const r = await rows(page)
        const md = await mdOf(page, nm)
        check('E6 引用里的表 Mod-Enter 跳出,单元格不变', isTable && JSON.stringify(r) === '[["a","b"],["r1","x"]]' && /> \| r1 +\| x +\|\n>\n> Q/.test(md || '') && !/\\\n/.test(md || ''), `${JSON.stringify(r)} md=${JSON.stringify(md)}`)
      }
      // E7 Shift+Enter → 格内换行,落盘 `<br>`;把这份落盘重新打开仍是两行,改别处 `<br>` 逐字留着。
      {
        const nm = await load(page, T3)
        await caretInCell(page, 'r1')
        await page.keyboard.press('Shift+Enter')
        const w = await where(page)
        await page.keyboard.type('Q')
        const md = await mdOf(page, nm)
        check('E7 Shift+Enter 在格内换行(不跳出、不下移),落盘 `r1<br>Q`', w.cell === 'r1\n' && /\| r1<br>Q +\| x +\|/.test(md || ''), `${JSON.stringify(w)} md=${JSON.stringify(md)}`)
        const nm2 = await load(page, md || '')
        const td = await page.evaluate((PM) => [...document.querySelectorAll(`${PM} td`)].find((e) => e.textContent.startsWith('r1'))?.innerText, PM)
        await caretInCell(page, 'z')
        await page.keyboard.type('Z')
        const md2 = await mdOf(page, nm2)
        check('E7 重开:格内仍是两行,编辑别处后 `<br>` 逐字写回', td === 'r1\nQ' && /\| r1<br>Q +\| x +\|/.test(md2 || '') && /\| r3 +\| zZ +\|/.test(md2 || ''), `td=${JSON.stringify(td)} md=${JSON.stringify(md2)}`)
      }
      // E8 末格 Tab → 加一行,光标进新行首格;新行空格子落盘为空。中间格 Tab 照旧跳下一格(全选格内容)。
      {
        const nm = await load(page, T3)
        await caretInCell(page, 'z')
        await page.keyboard.press('Tab')
        const w = await where(page)
        await page.keyboard.type('Z')
        const r = await rows(page)
        const md = await mdOf(page, nm)
        check('E8 末格 Tab → 加一行、进新行首格', r.length === 5 && r[4][0] === 'Z' && r[4][1] === '' && w.cell === '', `${JSON.stringify(r)} ${JSON.stringify(w)}`)
        check('E8 落盘:新行 `| Z |  |`,无 <br />', /\n\| Z +\| +\|\n/.test(md || '') && !/<br/i.test(md || ''), JSON.stringify(md))
        const nm2 = await load(page, T3)
        await caretInCell(page, 'r2')
        await page.keyboard.press('Tab')
        await page.keyboard.type('Y')
        const md2 = await mdOf(page, nm2)
        check('E8 中间格 Tab 仍跳下一格(整格替换)', /\| r2 +\| Y +\|/.test(md2 || '') && (await rows(page)).length === 4, JSON.stringify(md2))
      }
      // E9 首格 Shift-Tab:不动、不丢焦点、不改文档。
      {
        const nm = await load(page, T3)
        await caretInCell(page, 'a')
        const before = await where(page)
        await page.keyboard.press('Shift+Tab')
        const w = await where(page)
        const active = await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror'))
        const md = await mdOf(page, nm)
        check('E9 首格 Shift-Tab:原地不动,焦点仍在编辑器,不写盘', w.cell === 'a' && before.cell === 'a' && active && md == null, `${JSON.stringify(w)} active=${active} md=${JSON.stringify(md)}`)
      }
    }

    if (want('M')) {
      // M1 右键正文格:出表格区,不列文字类转换;「卡片」仍在。
      {
        await load(page, T3)
        await rightClick(page, 'r2')
        const m = await menu(page)
        check('M1 右键单元格:表格区完整,无「正文/标题 1」等文字转换', m && m.ops.join(',') === 'rowAbove,rowBelow,colLeft,colRight,deleteRow,deleteCol' && m.aligns.join(',') === 'left*,center,right'
          && !m.labels.some((l) => /^(正文|标题 1|无序列表|引用|折叠)$/.test(l)) && m.labels.includes('卡片'), JSON.stringify(m))
        await closeMenu(page)
      }
      // M2 段落的块菜单(⠿ 右键;G4-08 起文字上右键归系统菜单):文字转换照旧、没有表格区(别把隐藏做过头)。
      {
        await load(page, T3)
        await gripRightClick(page, '后段。', '> p')
        const m = await menu(page)
        check('M2 右键段落:「转换为」照旧,无表格区', m && m.labels.includes('正文') && m.labels.includes('标题 1') && m.ops.length === 0 && m.aligns.length === 0, JSON.stringify(m))
        await closeMenu(page)
      }
      // M3 在下方插入行(对着 r2)→ 新行在 r2 之后,光标进新行同列。
      {
        const nm = await load(page, T3)
        await rightClick(page, 'y')
        await clickMenu(page, '[data-table-op="rowBelow"]')
        const w = await where(page)
        await page.keyboard.type('N')
        const md = await mdOf(page, nm)
        check('M3 在下方插入行 → r2 之后多一行,光标进新行同列', JSON.stringify(await rows(page)) === '[["a","b"],["r1","x"],["r2","y"],["","N"],["r3","z"]]' && w.cell === '' && /\| r2 +\| y +\|\n\| +\| N +\|\n\| r3/.test(md || ''), `${JSON.stringify(w)} md=${JSON.stringify(md)}`)
      }
      // M4 在上方插入行 / 在左侧插入列(新列写 `---`,不是缺省对齐的 `:--`)。
      {
        const nm = await load(page, T3)
        await rightClick(page, 'r1')
        await clickMenu(page, '[data-table-op="rowAbove"]')
        await rightClick(page, 'x')
        await clickMenu(page, '[data-table-op="colLeft"]')
        const r = await rows(page)
        const md = await mdOf(page, nm)
        const delim = (md || '').split('\n').find((l) => /^\| *:?-/.test(l)) || ''
        check('M4 在上方插入行 + 在左侧插入列', JSON.stringify(r) === '[["a","","b"],["","",""],["r1","","x"],["r2","","y"],["r3","","z"]]', JSON.stringify(r))
        check('M4 落盘:新列分隔符是 `---`(无对齐),全表无 <br />', /^\| -+ \| -+ \| -+ \|$/.test(delim) && !/<br/i.test(md || ''), JSON.stringify(md))
      }
      // M5 在右侧插入列 → 删除列 → 删除行(对着 r1)。
      {
        const nm = await load(page, T3)
        await rightClick(page, 'a')
        await clickMenu(page, '[data-table-op="colRight"]')
        const r1 = await rows(page)
        await rightClick(page, 'b')
        await clickMenu(page, '[data-table-op="deleteCol"]')
        await rightClick(page, 'r1')
        await clickMenu(page, '[data-table-op="deleteRow"]')
        const r2 = await rows(page)
        const md = await mdOf(page, nm)
        check('M5 在右侧插入列(插在 a 之后)', JSON.stringify(r1) === '[["a","","b"],["r1","","x"],["r2","","y"],["r3","","z"]]', JSON.stringify(r1))
        check('M5 删除列 b + 删除行 r1 → 落盘 md', JSON.stringify(r2) === '[["a",""],["r2",""],["r3",""]]' && /^# 表\n\n\| a +\| +\|\n\| -+ \| -+ \|\n\| r2 +\| +\|\n\| r3 +\| +\|\n\n后段。\n$/.test(md || ''), `${JSON.stringify(r2)} md=${JSON.stringify(md)}`)
      }
      // M6 对齐:居中 → `:-:`(别的列不动);右对齐 → `--:`;左对齐 → 收回 `---`;菜单打勾跟着走。
      {
        const nm = await load(page, T3)
        const delim = async () => ((await mdOf(page, nm)) || '').split('\n').find((l) => /^\| *:?-/.test(l)) || ''
        await rightClick(page, 'y')
        await clickMenu(page, '[data-table-align="center"]')
        const d1 = await delim()
        await rightClick(page, 'x')
        const m = await menu(page)
        await clickMenu(page, '[data-table-align="right"]')
        const d2 = await delim()
        await rightClick(page, 'b')
        await clickMenu(page, '[data-table-align="left"]')
        const d3 = await delim()
        const ta = await page.evaluate((PM) => [...document.querySelectorAll(`${PM} td`)].find((e) => e.textContent === 'y')?.style.textAlign, PM)
        check('M6 居中 → 第二列 `:-:`,第一列不动', /^\| -+ \| :-+: \|$/.test(d1), JSON.stringify(d1))
        check('M6 菜单打勾跟着当前列对齐走', m && m.aligns.join(',') === 'left,center*,right', JSON.stringify(m))
        check('M6 右对齐 → `--:`;左对齐 → 收回 `---`', /^\| -+ \| -+: \|$/.test(d2) && /^\| -+ \| -+ \|$/.test(d3) && ta === 'left', JSON.stringify({ d2, d3, ta }))
      }
      // M7 表头行不给「上方插入行 / 删除行」;只剩一行正文不给删行;一列不给删列。
      {
        await load(page, T3)
        await rightClick(page, 'a')
        const h = await menu(page)
        await closeMenu(page)
        await load(page, '| k |\n| --- |\n| v |\n')
        await rightClick(page, 'v')
        const one = await menu(page)
        await closeMenu(page)
        check('M7 表头行:无「在上方插入行 / 删除行」', h && h.ops.join(',') === 'rowBelow,colLeft,colRight,deleteCol', JSON.stringify(h))
        check('M7 单行单列表:无删行、无删列', one && one.ops.join(',') === 'rowAbove,rowBelow,colLeft,colRight', JSON.stringify(one))
      }
      // M8 斜杠菜单建表 → ⠿ 菜单(无格子上下文)只给追加;追加行后末行 Enter 还能继续长。
      {
        const nm = await load(page, '# 表\n\n前段。\n')
        await page.evaluate(() => {
          const v = window.__upage.probe.view()
          v.focus()
          v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.atEnd(v.state.doc)))
        })
        await page.keyboard.press('Enter')
        await page.keyboard.type('/表格')
        await page.waitForTimeout(300)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(400)
        const made = await rows(page)
        const hc = await page.evaluate((PM) => {
          const el = document.querySelector(`${PM} table`)
          const r = el.getBoundingClientRect()
          return { x: r.left + 30, y: r.top + 10 }
        }, PM)
        await page.mouse.move(hc.x, hc.y)
        await page.waitForTimeout(350)
        await page.click('.unified-gutter .drag-handle')
        await page.waitForSelector('.unified-block-menu', { timeout: 3000 })
        const m = await menu(page)
        await clickMenu(page, '[data-table-op="rowBelow"]')
        await page.evaluate(() => { // 光标进末行末格
          const v = window.__upage.probe.view()
          let last = null
          v.state.doc.descendants((n, p) => { if (n.type.spec.tableRole === 'cell') last = p + n.nodeSize - 2; return true })
          v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(last))))
        })
        await page.keyboard.press('Enter')
        await page.keyboard.type('G')
        const r = await rows(page)
        const md = await mdOf(page, nm)
        check('M8 ⠿ 打开(无格子上下文)只给追加行列', m && m.ops.join(',') === 'rowBelow,colRight' && m.aligns.length === 0, JSON.stringify(m))
        check('M8 斜杠建的表能长大(⠿ 追加一行 + 末行 Enter 再加一行)', made && made.length === 2 && r.length === 4 && r[3][1] === 'G' && (md || '').split('\n').filter((l) => l.startsWith('|')).length === 5 && !/<br/i.test(md || ''), `${JSON.stringify({ made, r })} md=${JSON.stringify(md)}`)
      }
    }
    if (want('S')) {
      // S1 单元格文字以空格结尾且含 `|`(L-09b):milkdown 的 text handler 对这种文本整段跳过转义 → `|` 裸写,
      //    重开单元格被拆成两格。别名双链同病(`[[Alpha|别名]] `)。落盘必须转义成 `\|`,重开仍是两列。
      for (const typed of [' A | B ', ' [[Alpha|别名]] ']) {
        const nm = await load(page, '# T\n\n| a | b |\n| --- | --- |\n| c1 | x |\n\n尾段\n')
        await caretInCell(page, 'c1')
        await page.keyboard.type(typed)
        const md = await mdOf(page, nm)
        await load(page, md || '')
        const r = await rows(page)
        check(`S1 格内以空格结尾且含 |(${JSON.stringify(typed)}):落盘转义,重开仍是两列`, /\\\|/.test(md || '') && r && r[1].length === 2 && r[1][0].startsWith('c1'), `${JSON.stringify(r)} md=${JSON.stringify(md)}`)
      }
    }
    if (want('L')) {
      // L1/L2 表头是落盘产物命名(CLAUDE.md 双语准则):以前表里写死「列 1 | 列 2」,英文界面照样把中文表头写进磁盘。
      for (const [lang, trigger, head] of [['en', '/table', '| Column 1 | Column 2 |'], ['zh', '/表格', '| 列 1 | 列 2 |']]) {
        await page.evaluate((l) => window.__upage.setLocale(l), lang)
        const nm = await load(page, '# T\n\n前段。\n')
        await page.evaluate(() => {
          const v = window.__upage.probe.view()
          v.focus()
          v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.atEnd(v.state.doc)))
        })
        await page.keyboard.press('Enter')
        await page.keyboard.type(trigger)
        await page.waitForTimeout(300)
        await page.keyboard.press('Enter')
        const md = await mdOf(page, nm)
        check(`L ${lang} 界面 ${trigger} → 表头落盘 ${head}`, (md || '').split('\n').includes(head), JSON.stringify(md))
      }
      await page.evaluate(() => window.__upage.setLocale('zh'))
    }
    await page.close()
  } finally {
    await browser.close()
  }
  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
