// 粘贴保真仪器(check:pastefidelity,评审 2026-09-27 §6 规划名):D-10(PF1–PF9)、D-13(PF10–PF14);
// 另含复制出去的 text/plain(D-14,CP1–CP5)。
//
// D-10(拍板 #12):剪贴板只有 text/plain、不像 markdown 的多行文本 → **一行一段**(单个 `\n` 升成段落);
// 像 markdown 的照旧走 CommonMark(紧凑列表不许变 loose、硬折行的 markdown 段落不许拆行);代码块内粘贴不变;
// 带 text/html 的走 HTML 那条(不归本分支)。修前:三行地址粘进来显示成一行(磁盘上 `\n` 还在)。
//
// G4-04:外部拖入的 text/plain 与粘贴同口径 —— 修前 markdown 被转义成字面 `\-` `\*\*`(粘贴却解析成结构);
// 单条裸 URL 拖到空段照旧是裸 URL(书签卡);内部附件引用粘贴(走 pasteText)不受拖入解析器影响。用例 PFD1–PFD4。
//
// 真浏览器台架(?upage = 生产 UnifiedPage 全链)。粘贴用合成 ClipboardEvent + DataTransfer(PM 只读 clipboardData,
// 不看 isTrusted;真 Meta+V 需要剪贴板权限,headless 下不稳)。断言看**落盘**与**段落数**两样。
//
// 用法:npm run check:pastefidelity(自带起停 vite;worktree 里设 HARNESS_URL 指到自己的端口)
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

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, md, errs) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`${BASE}?upage&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.waitForTimeout(500)
  return page
}
/** 光标落到 needle 之后(直接设 PM 选区)。 */
const caretAfter = (page, needle) => page.evaluate((text) => {
  const view = window.__upage.probe.view()
  let found = -1
  view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.isText) { const i = node.text.indexOf(text); if (i >= 0) { found = pos + i + text.length; return false } }
    return true
  })
  if (found < 0) return false
  let proto = Object.getPrototypeOf(view.state.selection)
  while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
  view.focus()
  view.dispatch(view.state.tr.setSelection(proto.constructor.near(view.state.doc.resolve(found))))
  return true
}, needle)
const paste = (page, data) => page.evaluate(({ s, data }) => {
  const dt = new DataTransfer()
  for (const [k, v] of Object.entries(data)) dt.setData(k, v)
  document.querySelector(s).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
}, { s: PM, data })
const writeCount = (page) => page.evaluate(() => window.__upage.writes.length)
const lastWrite = (page) => page.evaluate(() => { const w = window.__upage.writes; return w.length ? w[w.length - 1].text : null })
async function settle(page, w0) {
  for (let t = 0; t < 60 && (await writeCount(page)) === w0; t++) await page.waitForTimeout(100)
  await page.waitForTimeout(400)
  return lastWrite(page)
}
/** 顶层块形状:[类型, 文本] —— 段落数是「看得见的换行」的直接量。 */
const shape = (page) => page.evaluate(() => {
  const out = []
  window.__upage.probe.view().state.doc.forEach((n) => out.push(`${n.type.name}:${n.textContent}`))
  return out
})

/** 空段落粘贴:ANCHOR 后回车出空段,粘 data。 */
async function pasteCase(browser, data, seed = 'ANCHOR\n\ntail\n', anchor = 'ANCHOR', enter = true) {
  const errs = []
  const page = await open(browser, seed, errs)
  await caretAfter(page, anchor)
  if (enter) await page.keyboard.press('Enter')
  const w0 = await writeCount(page)
  await paste(page, data)
  const out = await settle(page, w0)
  const blocks = await shape(page)
  await page.close()
  return { out, blocks, errs }
}

/** 外部拖入:ANCHOR 后回车出空段,把 data 拖到这个空段上(合成 DragEvent,PM 的 drop 只读 dataTransfer)。 */
async function dropCase(browser, data) {
  const errs = []
  const page = await open(browser, 'ANCHOR\n\ntail\n', errs)
  await caretAfter(page, 'ANCHOR')
  await page.keyboard.press('Enter')
  const w0 = await writeCount(page)
  await page.evaluate(({ data }) => {
    const v = window.__upage.probe.view()
    const el = v.domAtPos(v.state.selection.from).node
    const blk = el.nodeType === 1 ? el : el.parentElement
    const r = blk.getBoundingClientRect()
    const x = r.left + 4
    const y = r.top + r.height / 2
    const dt = new DataTransfer()
    for (const [k, val] of Object.entries(data)) dt.setData(k, val)
    const at = document.elementFromPoint(x, y)
    for (const t of ['dragenter', 'dragover', 'drop']) at.dispatchEvent(new DragEvent(t, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }))
  }, { data })
  const out = await settle(page, w0)
  const blocks = await shape(page)
  await page.close()
  return { out, blocks, errs }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    // PF1 纯文本多行(微信 / 终端的地址)→ 一行一段
    {
      const r = await pasteCase(browser, { 'text/plain': 'Alice Zhang\nRoom 1203\nBeijing 100000' })
      check('PF1 纯文本多行 → 一行一段', r.out === 'ANCHOR\n\nAlice Zhang\n\nRoom 1203\n\nBeijing 100000\n\ntail\n' &&
        r.blocks.filter((b) => b.startsWith('paragraph:')).length === 5 && !r.errs.length, JSON.stringify(r))
    }
    // PF2 CRLF + 原有空行:CRLF 归一,已有的空行原样(不再额外加倍)
    {
      const r = await pasteCase(browser, { 'text/plain': '第一行\r\n第二行\r\n\r\n第三段' })
      check('PF2 CRLF 归一 + 已有空行不加倍', r.out === 'ANCHOR\n\n第一行\n\n第二行\n\n第三段\n\ntail\n' && !r.errs.length, JSON.stringify(r))
    }
    // PF3 像 markdown 的(紧凑列表)照旧 CommonMark:仍是一只紧凑列表,落盘不许多出空行
    {
      const r = await pasteCase(browser, { 'text/plain': '- 苹果\n- 香蕉\n- 橙子' })
      check('PF3 紧凑列表照旧 CommonMark(不变 loose)', r.out === 'ANCHOR\n\n- 苹果\n- 香蕉\n- 橙子\n\ntail\n' && !r.errs.length, JSON.stringify(r))
    }
    // PF4 带行内标记的硬折行 markdown 段落:软换行语义不动(不拆成两段)
    {
      const r = await pasteCase(browser, { 'text/plain': '**要点**在第一行\n接着第二行' })
      check('PF4 行内 markdown 的硬折行段落不拆', r.out === 'ANCHOR\n\n**要点**在第一行\n接着第二行\n\ntail\n' && !r.errs.length, JSON.stringify(r))
    }
    // PF5 代码块内粘贴:`\n` 就是代码换行,整段仍在同一个代码块里
    {
      const r = await pasteCase(browser, { 'text/plain': 'x = 1\ny = 2' }, 'ANCHOR\n\n```js\nCODE\n```\n', 'CODE', false)
      check('PF5 代码块内粘贴不变', r.out === 'ANCHOR\n\n```js\nCODEx = 1\ny = 2\n```\n' && r.blocks.filter((b) => b.startsWith('code_block')).length === 1 && !r.errs.length, JSON.stringify(r))
    }
    // PF6 同时带 text/html:归 HTML 那条(本分支不接管)—— 一个行内 span 的 HTML 只出一段
    {
      const r = await pasteCase(browser, { 'text/plain': 'a\nb', 'text/html': '<meta charset="utf-8"><span>a b</span>' })
      check('PF6 带 text/html 的不走纯文本分支', r.out === 'ANCHOR\n\na b\n\ntail\n' && !r.errs.length, JSON.stringify(r))
    }
    // PF7~PF9(Codex 复核):「像 markdown」漏判的三类必须走原 CommonMark —— 加倍换行会把结构拆散。
    // PF7 无首尾 `|` 的 GFM 表格:仍是一张表(不是三段)
    {
      const r = await pasteCase(browser, { 'text/plain': 'Name | Age\n--- | ---\nAda | 37' })
      check('PF7 无首尾 | 的表格照旧成表', r.blocks.filter((b) => b.startsWith('table')).length === 1 && !r.blocks.some((b) => b === 'paragraph:--- | ---') && !r.errs.length, JSON.stringify(r))
    }
    // PF8 四空格缩进代码:仍是一个代码块,行间不多空行
    {
      const r = await pasteCase(browser, { 'text/plain': '    x = 1\n    y = 2' })
      check('PF8 缩进代码照旧成一个代码块', r.blocks.includes('code_block:x = 1\ny = 2') && !r.errs.length, JSON.stringify(r))
    }
    // PF9 跨行 `%%` 注释:仍在一段里(三段就配不上对了),落盘逐字
    {
      const r = await pasteCase(browser, { 'text/plain': '%%\n注释内容\n%%' })
      check('PF9 跨行 %% 注释不拆段', r.out === 'ANCHOR\n\n%%\n注释内容\n%%\n\ntail\n' && !r.errs.length, JSON.stringify(r))
    }
    // ── D-13:单行纯文本粘进一段已有文字的中间 —— 解析出块结构的逐字插入,只有行内标记的照常解析、首尾空白补回 ──
    const mid = (text, seed = 'ANCHOR\n\nsee TAIL\n', anchor = 'see ') => pasteCase(browser, { 'text/plain': text }, seed, anchor, false)
    {
      const r = await mid(' world ', 'ANCHOR\n\nhelloTAIL\n', 'hello')
      check('PF10 句中粘 ` world `:首尾空格不被吃', r.out === 'ANCHOR\n\nhello world TAIL\n' && !r.errs.length, JSON.stringify(r))
    }
    for (const [id, text, want] of [
      ['PF11', '2024. A good year', 'see 2024. A good yearTAIL'],
      ['PF11b', '- 2 cups', 'see - 2 cupsTAIL'],
      ['PF11c', '# Title words', 'see # Title wordsTAIL'],
      ['PF11d', '> quoted', 'see > quotedTAIL'],
    ]) {
      const r = await mid(text)
      check(`${id} 句中粘 ${JSON.stringify(text)}:行首标记原样留在句中`, r.out === `ANCHOR\n\n${want}\n` && r.blocks.join('|') === `paragraph:ANCHOR|paragraph:${want}` && !r.errs.length, JSON.stringify(r))
    }
    {
      const r = await mid(' **粗** ')
      check('PF12 对照:句中粘行内标记照常成格式(首尾空白也补回)', r.out === 'ANCHOR\n\nsee  **粗** TAIL\n' && !r.errs.length, JSON.stringify(r))
    }
    {
      const r = await pasteCase(browser, { 'text/plain': '- 2 cups' })
      check('PF13 对照:空段落里粘 `- 2 cups` 照旧转列表(同 Obsidian)', r.blocks.includes('bullet_list:2 cups') && !r.errs.length, JSON.stringify(r))
    }
    {
      // ⌘⇧V:PM 在 keydown 里记 Shift(input.shiftKey),合成 paste 时按住 Shift 即同一状态。
      const errs = []
      const page = await open(browser, 'ANCHOR\n\ntail\n', errs)
      await caretAfter(page, 'ANCHOR')
      await page.keyboard.press('Enter')
      const w0 = await writeCount(page)
      await page.keyboard.down('Shift')
      // 只有 text/plain(终端 / 纯文本来源):带 HTML 时 PM 自己按 Shift 出纯文本切片、Milkdown 照收,只有这一形态会被当 markdown 解析。
      await paste(page, { 'text/plain': '**粗** 与 - x' })
      await page.keyboard.up('Shift')
      const out = await settle(page, w0)
      await page.close()
      check('PF14 ⌘⇧V 逐字粘贴(只有 text/plain):不解析 markdown', out === 'ANCHOR\n\n\\*\\*粗\\*\\* 与 - x\n\ntail\n' && !errs.length, JSON.stringify({ out, errs }))
    }
    // ── D-14:复制到外部的 text/plain(真 copy 事件 → PM 的 clipboardTextSerializer,与 Cmd+C 同一条路径)──
    {
      const MD = 'Intro para with **bold** and [[Wiki]] end.\n\nSecond para *ital* here.\n\n- item one **b**\n- [ ] task two\n- item three\n\nAfter list.\n'
      const errs = []
      const page = await open(browser, MD, errs)
      /** 文字选区 [from 里第 fo 字, to 里第 to2 字) —— selection 初始就是 TextSelection,构造器直接拿来 create。 */
      const selectText = (from, fo, to, to2) => page.evaluate(({ from, fo, to, to2 }) => {
        const v = window.__upage.probe.view()
        const find = (t, off) => { let p = -1; v.state.doc.descendants((n, pos) => { if (p >= 0) return false; if (n.isTextblock && n.textContent.includes(t)) { p = pos + 1 + n.textContent.indexOf(t) + off; return false } return true }); return p }
        v.focus()
        const TS = window.__cpTextSel || (window.__cpTextSel = v.state.selection.constructor) // 首次调用时还是文字选区,记下构造器
        v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, find(from, fo), find(to, to2))))
      }, { from, fo, to, to2 })
      const copy = () => page.evaluate(() => {
        const v = window.__upage.probe.view()
        const dt = new DataTransfer()
        v.dom.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: dt }))
        return { plain: dt.getData('text/plain'), sel: v.state.selection.toJSON().type }
      })
      await selectText('Second', 7, 'task two', 8)
      const c1 = await copy()
      check('CP1 从段落中间选到待办末尾:待办的 `- [ ]` 不丢,块间空行', c1.plain === 'para *ital* here.\n\n- item one **b**\n- [ ] task two', JSON.stringify(c1))
      await selectText('task two', 2, 'task two', 2)
      await page.waitForTimeout(150)
      await page.keyboard.press('Escape') // 块选中:列表项 NodeSelection
      await page.waitForTimeout(150)
      const c2 = await copy()
      check('CP2 块选中的待办复制:带 `- [ ]`(修前只剩纯文字)', c2.sel === 'node' && c2.plain === '- [ ] task two', JSON.stringify(c2))
      await selectText('Intro', 0, 'here.', 5)
      const c3 = await copy()
      check('CP3 两整段纯文字:纯文本(贴微信),段间空一行', c3.plain === 'Intro para with bold and [[Wiki]] end.\n\nSecond para ital here.', JSON.stringify(c3))
      await selectText('Intro', 0, 'task two', 8)
      const c4 = await copy()
      check('CP4 跨块复制含双链:双链不被转义成 `\\[\\[`', c4.plain.startsWith('Intro para with **bold** and [[Wiki]] end.\n\n') && c4.plain.endsWith('- [ ] task two') && !c4.plain.includes('\\['), JSON.stringify(c4))
      await selectText('Intro', 6, 'end.', 4)
      const c5 = await copy()
      check('CP5 对照:段内半句照旧纯文本', c5.plain === 'para with bold and [[Wiki]] end.', JSON.stringify(c5))
      await page.close()
      check('CP 无页面错误', !errs.length, JSON.stringify(errs))
    }
    // PFD1 外部拖入 markdown 纯文本 → 解析成结构(与粘贴同口径;修前落盘 `\- 项一` `\*\*粗\*\*体`)
    {
      const md = '# 拖入标题\n\n- 项一\n- 项二\n\n**粗**体'
      const d = await dropCase(browser, { 'text/plain': md })
      const p = await pasteCase(browser, { 'text/plain': md })
      check('PFD1 外部拖入 markdown → 与粘贴同样解析成结构', d.out === p.out && /\n- 项一\n- 项二\n/.test(d.out || '') && !/\\[-*]/.test(d.out || '') && !d.errs.length, JSON.stringify({ drop: d.out, paste: p.out }))
    }
    // PFD2 外部拖入不像 markdown 的多行 → 一行一段(D-10 同一条)
    {
      const r = await dropCase(browser, { 'text/plain': 'Alice Zhang\nRoom 1203' })
      check('PFD2 外部拖入纯文本多行 → 一行一段', /Alice Zhang\n\nRoom 1203/.test(r.out || '') && !r.errs.length, JSON.stringify(r))
    }
    // PFD3 单条裸 URL 拖到空段 → 照旧裸 URL(不被 autolink 包成链接 → 书签卡形态不变)
    {
      const r = await dropCase(browser, { 'text/uri-list': 'https://example.com/article', 'text/plain': 'https://example.com/article' })
      check('PFD3 裸 URL 拖入空段照旧是裸 URL', r.out === 'ANCHOR\n\nhttps://example.com/article\n\ntail\n' && !r.errs.length, JSON.stringify(r))
    }
    // PFD4 对照:内部附件引用粘贴(走 pasteText,拖入解析器不插手)照旧落成引用
    {
      const r = await pasteCase(browser, { 'application/x-forsion-attachment-reference': '![[a.png]]' })
      check('PFD4 对照:内部附件引用粘贴照旧', /ANCHOR\n\n!\[\[a\.png\]\]\n\ntail/.test(r.out || '') && !r.errs.length, JSON.stringify(r))
    }
  } finally {
    await browser.close()
  }
  const bad = results.filter((x) => !x).length
  console.log(`\n${results.length - bad}/${results.length} PASS`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
