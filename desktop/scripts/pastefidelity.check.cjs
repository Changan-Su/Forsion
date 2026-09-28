// 粘贴保真仪器(check:pastefidelity,评审 2026-09-27 §6 规划名;本轮先装 D-10,D-13 等后续条目往这里加)。
//
// D-10(拍板 #12):剪贴板只有 text/plain、不像 markdown 的多行文本 → **一行一段**(单个 `\n` 升成段落);
// 像 markdown 的照旧走 CommonMark(紧凑列表不许变 loose、硬折行的 markdown 段落不许拆行);代码块内粘贴不变;
// 带 text/html 的走 HTML 那条(不归本分支)。修前:三行地址粘进来显示成一行(磁盘上 `\n` 还在)。
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
  } finally {
    await browser.close()
  }
  const bad = results.filter((x) => !x).length
  console.log(`\n${results.length - bad}/${results.length} PASS`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
