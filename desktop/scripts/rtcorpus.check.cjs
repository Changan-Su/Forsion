// 往返语料仪器(check:rtcorpus):**只改被编辑的首段,其余逐字节不变**。
//
// 真浏览器台架(?upage = 生产 UnifiedPage 全链)。每条语料:
//   ① 打开 → 越过防抖 → 必须零写盘;
//   ② 首段 `EDITHERE` 末尾敲一个字 → 落盘必须 === 原文(只有首段多了那个字);
//   ③ 用②的落盘再打开、再敲一个字 → 第二轮同样逐字(「重开后再编辑」:R-01 就是第二轮才坏)。
//
// 语料来源(评审 2026-09-27,docs/ToBeImproved/amadeus-editor-review-2026-09-27-probes/):
//   verify-integrity-3/d18-rt.cjs 的 21 份、verify-integrity-2/d12b.cjs + d11d12.cjs、verify-rich-5/tags.cjs,
//   加上 D-06 / R-01 / D-12 各自的复现串(verify-rich-1/br.cjs、math*.cjs、verify-integrity-1/d02_*.cjs)。
//
// 三个桶(别把白名单做宽 —— 白名单用**黄金输出**断言,新的噪音照样红):
//   verbatim  必须逐字。红 = exit 1。
//   whitelist 评审附录 A / 拍板表里认定的既定规范化,断言「恰好规范成这个样子」,第二轮必须逐字。红 = exit 1。
//   pending   已知未修、归别的波次/包(D-18/D-05/R-25 → 0b;D-01 → 0a 另一包)。按逐字断言但只记 XFAIL,
//             不算红;**意外通过**打 XPASS —— 修的人把它挪进 verbatim 桶。
// 另:任何桶打开即写盘、或命中 forbid(比「没修」更坏的形态),一律红。
//
// 用法:npm run check:rtcorpus(自带起停 vite;worktree 里设 HARNESS_URL 指到自己的端口)
//      node scripts/e2e-editor.cjs --check=rtcorpus --only=d06   只跑 id 含 d06 的
//      --dump   把每条的落盘原文打出来(给新语料定黄金输出用)
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

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const M = 'EDITHERE'
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length)
const DUMP = process.argv.includes('--dump')

const V = 'verbatim', W = 'whitelist', P = 'pending'
/** golden:whitelist 桶第一轮的期望落盘(含首段的 Z)。forbid:任何桶都不许出现的形态。 */
const CASES = [
  // ── d18-rt 的 21 份(verify-integrity-3/d18-rt.cjs)────────────────────────────────
  { id: 'd18.ordered_tight', bucket: V, md: `${M}\n\n1. a\n2. b\n` },
  { id: 'd18.list_dash_tight', bucket: P, why: 'D-05(0b):`-`→`*` 是既定,但紧凑变松散是 bug', md: `${M}\n\n- a\n- b\n  - c\n` },
  { id: 'd18.tasks_dash', bucket: P, why: 'D-05(0b)', md: `${M}\n\n- [ ] todo\n- [x] done\n` },
  { id: 'd18.ordered_all1', bucket: P, why: 'D-18(0b):`1. 1. 1.` 被重编号', md: `${M}\n\n1. a\n1. b\n1. c\n` },
  { id: 'd18.table', bucket: P, why: 'D-18(0b):表格对齐重排(tablePipeAlign)', md: `${M}\n\n| A | B |\n|---|---|\n| 1 | 2 |\n` },
  { id: 'd18.setext', bucket: P, why: 'D-18(0b):setext→ATX', md: `${M}\n\nTitle\n=====\n\ntext\n` },
  { id: 'd18.fences_tilde', bucket: P, why: 'D-18(0b):`~~~`→```', md: `${M}\n\n~~~js\nx\n~~~\n` },
  { id: 'd18.hr_dash', bucket: W, why: '拍板 #16(推荐不改):分割线落 `***`,文首 `---` 会被当 frontmatter 栅栏', md: `${M}\n\n---\n\ntext\n`, golden: `${M}Z\n\n***\n\ntext\n` },
  { id: 'd18.hr_under', bucket: W, why: '拍板 #16(同上)', md: `${M}\n\n___\n\ntext\n`, golden: `${M}Z\n\n***\n\ntext\n` },
  { id: 'd18.emph_underscore', bucket: W, why: '附录 A I-16:`_it_`→`*it*`(09-18 拍板);D-18:强调符统一 `*`(attentionFlanking.ts)', md: `${M}\n\n_emph_ and __strong__\n`, golden: `${M}Z\n\n*emph* and **strong**\n` },
  { id: 'd18.callout', bucket: P, why: 'D-18(0b):callout 标题后插 `>` 空行', md: `${M}\n\n> [!note] Title\n> body\n` },
  { id: 'd18.footnote', bucket: P, why: 'D-18(0b):脚注之间插空行', md: `${M}\n\nA[^1] B[^2].\n\n[^1]: one\n[^2]: two\n` },
  { id: 'd18.indented_code', bucket: P, why: 'D-18(0b):缩进代码→围栏', md: `${M}\n\n    code\n\ntext\n` },
  { id: 'd18.hardbreak_2sp', bucket: P, why: 'D-18(0b):两空格硬换行→`\\`', md: `${M}\n\nline one  \nline two\n` },
  { id: 'd18.bare_url', bucket: W, why: '附录 A I-16 / D-18:句中 `<url>`(links.ts normalizeUrlLiterals 取舍)', md: `${M}\n\nsee https://x.com/a_b ok\n`, golden: `${M}Z\n\nsee <https://x.com/a_b> ok\n` },
  { id: 'd18.www_url', bucket: P, why: 'D-18(0b):`www.` 被改写成显式链接', md: `${M}\n\nsee www.x.com ok\n` },
  { id: 'd18.snake', bucket: P, why: 'D-18(0b):`snake\\_case`、`5 \\* 3`', md: `${M}\n\nsnake_case_var and 5 * 3\n` },
  { id: 'd18.mark_html', bucket: P, why: 'D-18(0b):`<mark>` 被补 style', md: `${M}\n\nsome <mark>hi</mark> text\n` },
  { id: 'd18.no_trailing_nl', bucket: P, why: 'D-18(0b):自动补文末换行', md: `${M}\n\nlast` },
  { id: 'd18.bom', bucket: P, why: 'D-01(0a 另一包:BOM)', md: `\uFEFF${M}\n\npara\n` },
  { id: 'd18.task_upper_X', bucket: W, why: '附录 A D-05:`[X]`→`[x]` 是规范化;`-`→`*` 列表符(拍板 #17 未改缺省)', md: `${M}\n\n- [X] Done\n`, golden: `${M}Z\n\n* [x] Done\n` },

  // ── D-06:行内 / 单元格 / 列表项里的 `<br>`(verify-rich-1/br.cjs、verify-keyboard-1/v01-br.cjs、d06_br.cjs)──
  { id: 'd06.para', bucket: V, md: `${M}\n\nhello<br>world\n\nOther.\n` },
  { id: 'd06.para_variants', bucket: V, md: `${M}\n\nline a<br>line b<br/>line c<br />line d<br >line e\n` },
  { id: 'd06.para_upper_attr', bucket: V, md: `${M}\n\nx<BR>y 与 x<br class="k">y\n` },
  { id: 'd06.cjk', bucket: V, md: `${M}\n\n第一行<br>第二行\n\n甲<br>乙\n` },
  { id: 'd06.list_item', bucket: V, why: '单项列表 + `*`:只考 `<br>`,不掺 D-05', md: `${M}\n\n* 项<br>续行\n` },
  // 单元格:种子先写成序列化器的规范宽度(--dump 取;否则 D-18 的表格对齐重排会盖住 `<br>` 的结果)。
  // 0b 若关掉 tablePipeAlign,这两条种子要跟着改成新的规范形。
  { id: 'd06.table_cell', bucket: V, md: `${M}\n\n| 名称 | 说明             |\n| -- | -------------- |\n| a  | 第一行<br>第二行     |\n| b  | x<br/>y<br />z |\n` },
  { id: 'd06.table_cell_trailing', bucket: V, md: `${M}\n\n| k | v         |\n| - | --------- |\n| a | Alice<br> |\n` },
  { id: 'd06.heading', bucket: V, md: `${M}\n\n## 上<br>下\n\ntext\n` },
  { id: 'd06.soft_then_br', bucket: V, md: `${M}\n\nline<br>\nnext\n` },
  { id: 'd06.block_br_line', bucket: W, why: '附录 A D-18:空行编码(整行 `<br>` = 空段落 = 真空行)', md: `${M}\n\n甲\n\n<br>\n\n乙\n`, golden: `${M}Z\n\n甲\n\n\n\n乙\n` },

  // ── R-01:公式里的「反斜杠 + 标点」(verify-rich-1/math*.cjs、verify-integrity-1/d02_math*.cjs)──
  { id: 'r01.matrix_block', bucket: V, md: `${M}\n\n$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$\n` },
  { id: 'r01.aligned_block', bucket: V, md: `${M}\n\n$$\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n$$\n` },
  { id: 'r01.inline_brace', bucket: V, md: `${M}\n\nset $\\{x\\}$ here\n` },
  // 行内公式里的 `\$`:scanMath 见 `$` 就收、不认 `\$`(mathLivePreview 顶注 ponytail),落盘侧认不出这个跨度;
  // 解析侧补了反斜杠就会越存越多,所以两侧都不认、维持旧行为 —— 要逐字得连 scanMath / unescapeMathSource 一起改。
  { id: 'r01.inline_dollar', bucket: P, why: 'R-01 余项:行内公式内的 `\\$`(scanMath 不认)', md: `${M}\n\nprice $\\$5$ here\n`, forbid: /\\\\\$/ },
  { id: 'r01.punct_mix', bucket: V, md: `${M}\n\n$a\\,b \\| c \\% d \\# e \\_ f \\{g\\}$ 尾\n` },
  { id: 'r01.set_matrix_cn', bucket: V, md: `${M}\n\n集合 $\\{a,b\\}$ 与 $\\begin{matrix}1 \\\\ 2\\end{matrix}$ 尾\n` },
  { id: 'r01.single_line_display', bucket: V, md: `${M}\n\nseed\n\n$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$\n\nafter\n` },
  { id: 'r01.display_escaped_dollar', bucket: V, md: `${M}\n\n$$a\\$b$$\n` },
  { id: 'r01.containers', bucket: V, md: `${M}\n\n* 项 $\\{a\\}$\n\n> 引 $\\{b\\}$\n\n## 题 $\\{c\\}$\n` },
  { id: 'r01.control_cmds', bucket: V, md: `${M}\n\n$x_i + \\sum_{k} a*b$ ok\n\n$$\n\\frac{a}{b} + \\alpha_{1}\n$$\n` },
  { id: 'r01.escape_outside_math', bucket: V, why: '公式外的转义不许被补回(对照)', md: `${M}\n\nliteral \\*not em\\* and \\_x\\_ and $\\{y\\}$\n` },
  // 被转义的 `$` 不当定界符 —— 这条的旧病是 D-11(转义被剥,0b),但**绝不能**被本修复变成 `\\$x\\$`。
  { id: 'r01.escaped_dollars', bucket: P, why: 'D-11(0b):转义被剥', md: `${M}\n\nnot math: \\$x\\$ ok\n`, forbid: /\\\\\$/ },

  // ── D-12:链接定义行 / `[标签]: 值` / 引用式链接(verify-integrity-2/d12b.cjs、d11d12.cjs)──
  { id: 'd12.cn_label_line', bucket: V, md: `${M}\n\n会议记录\n\n[重要]: 明天开会\n\n[TODO]: 回复邮件\n\n结尾\n` },
  { id: 'd12.en_label', bucket: V, md: `${M}\n\nnotes\n\n[Note]: remember-this\n` },
  { id: 'd12.unused_defs', bucket: V, md: `${M}\n\ntext\n\n[bookmark]: https://example.com\n[other]: https://other.com "t"\n` },
  { id: 'd12.reflink', bucket: V, md: `${M}\n\nsee [a][1] and [b][] and [c]\n\n[1]: http://example.com "Title"\n[b]: http://x.y\n[c]: /c\n` },
  { id: 'd12.def_in_quote', bucket: V, md: `${M}\n\n> 引文\n>\n> [ref]: https://q.example\n` },
  { id: 'd12.def_escapes', bucket: V, md: `${M}\n\n[a_b]: https://x.com/a_b*c "t_1"\n\n[k]: <https://x.com/y z>\n` },

  // ── R-25 行首 #tag(verify-rich-5/tags.cjs)─────────────────────────────────────────
  { id: 'tags.midLine', bucket: V, md: `${M}\n\n正文 #tag 与 #嵌套/标签\n` },
  { id: 'tags.heading', bucket: V, md: `${M}\n\n# 标题\n` },
  { id: 'tags.lineStart', bucket: P, why: 'R-25(0b):行首 `#tag` 被转义成 `\\#tag`', md: `${M}\n\n#tag 与 #嵌套/标签 正文\n` },
  { id: 'tags.listItem', bucket: P, why: 'R-25 + D-05(0b)', md: `${M}\n\n- #todo 买菜\n- 普通 #tag\n` },
  { id: 'tags.quote', bucket: P, why: 'R-25(0b)', md: `${M}\n\n> #idea 想法\n` },
  { id: 'tags.onlyTag', bucket: P, why: 'R-25(0b)', md: `${M}\n\n#tag\n` },
]

// ── 入口:修复挂在 remark 管线(唯一咽喉)上 —— 加载之外,外部回灌 / 切换文件 / 粘贴也必须同样保真 ──
// 用同一段混合正文(R-01 公式 + D-06 `<br>` + D-12 定义行)走三条入口,再在首段敲一个字,期望落盘逐字。
const ENTRY_BODY = `$$\n\\begin{pmatrix} a \\\\ b \\end{pmatrix}\n$$\n\n行内 $\\{x\\}$ 与 a<br>b\n\n[重要]: 明天开会\n`
const ENTRIES = [
  { id: 'entry.fire', kind: 'fire' },
  { id: 'entry.switch', kind: 'switch' },
  { id: 'entry.paste', kind: 'paste' },
]

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n')
  const n = A.length, m = B.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push('- ' + JSON.stringify(A[i++])); else out.push('+ ' + JSON.stringify(B[j++]))
  }
  while (i < n) out.push('- ' + JSON.stringify(A[i++]))
  while (j < m) out.push('+ ' + JSON.stringify(B[j++]))
  return out
}

async function open(browser, md, errs) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`${BASE}?upage&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.waitForTimeout(1300) // 越过 800ms 防抖:只读打开不许有任何写
  return page
}

/** 光标落到 needle 之后(直接设 PM 选区:鼠标/方向键在 headless 下落点不稳)。 */
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

const writeCount = (page) => page.evaluate(() => window.__upage.writes.length)
const lastWrite = (page) => page.evaluate(() => { const w = window.__upage.writes; return w.length ? w[w.length - 1].text : null })

/** 敲一个字,等落盘(轮询写盘计数,再多等一拍收尾写)。 */
async function typeAndSave(page, needle, ch) {
  const w0 = await writeCount(page)
  if (!(await caretAfter(page, needle))) return { out: null, note: `找不到 ${needle}` }
  await page.keyboard.type(ch)
  for (let t = 0; t < 60 && (await writeCount(page)) === w0; t++) await page.waitForTimeout(100)
  await page.waitForTimeout(400)
  return { out: await lastWrite(page) }
}

async function runCase(browser, c) {
  const errs = []
  const r = { id: c.id, bucket: c.bucket, why: c.why, rounds: [], openWrites: [], errs }
  // 第一轮
  let page = await open(browser, c.md, errs)
  r.openWrites.push(await writeCount(page))
  const one = await typeAndSave(page, M, 'Z')
  await page.close()
  const want1 = c.bucket === W ? c.golden : c.md.replace(M, M + 'Z')
  r.rounds.push({ out: one.out, want: want1, note: one.note })
  // 第二轮:用第一轮的落盘重开再编辑(pending 桶第一轮就不逐字,第二轮不跑)。
  if (c.bucket !== P && one.out != null) {
    page = await open(browser, one.out, errs)
    r.openWrites.push(await writeCount(page))
    const two = await typeAndSave(page, M + 'Z', 'Y')
    await page.close()
    r.rounds.push({ out: two.out, want: one.out.replace(M + 'Z', M + 'ZY'), note: two.note })
  }
  return r
}

async function runEntry(browser, e) {
  const errs = []
  const want = `${M}Z\n\n${ENTRY_BODY}`
  let out = null
  let page
  if (e.kind === 'fire') {
    page = await open(browser, `${M}\n\n占位\n`, errs)
    await page.evaluate((md) => window.__upage.fire('Unified.md', md), `${M}\n\n${ENTRY_BODY}`)
    await page.waitForTimeout(1500)
    out = (await typeAndSave(page, M, 'Z')).out
  } else if (e.kind === 'switch') {
    page = await open(browser, `${M}\n\n占位\n`, errs)
    await page.evaluate((md) => window.__upage.switchFile('Other.md', md), `${M}\n\n${ENTRY_BODY}`)
    await page.waitForTimeout(1500)
    out = (await typeAndSave(page, M, 'Z')).out
  } else {
    // 粘贴:首段末回车出一个空段,把正文当 text/plain 粘进去(plugin-clipboard → parserCtx → 同一条 remark 链)
    page = await open(browser, `${M}\n`, errs)
    await caretAfter(page, M)
    await page.keyboard.press('Enter')
    await page.evaluate((md) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', md)
      document.querySelector('.unified-body .ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, ENTRY_BODY)
    await page.waitForTimeout(300)
    out = (await typeAndSave(page, M, 'Z')).out
  }
  await page.close()
  return { id: e.id, bucket: V, rounds: [{ out, want }], openWrites: [0], errs }
}

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const cases = [...CASES, ...ENTRIES.map((e) => ({ ...e, bucket: V }))].filter((c) => !ONLY || c.id.includes(ONLY))
  const results = await pool(cases, Number(process.env.RTCORPUS_JOBS || 4), (c) => (c.kind ? runEntry(browser, c) : runCase(browser, c)))
  await browser.close()

  let red = 0
  const tally = { PASS: 0, FAIL: 0, XFAIL: 0, XPASS: 0 }
  for (const [k, r] of results.entries()) {
    const c = cases[k]
    const forbidden = c.forbid ? r.rounds.find((x) => x.out != null && c.forbid.test(x.out)) : null
    const openDirty = r.openWrites.some((n) => n !== 0)
    const exact = r.rounds.every((x) => x.out != null && x.out === x.want)
    const pageErr = r.errs.filter((e) => !/Failed to load resource/.test(e))
    let tag
    if (c.bucket === P) tag = exact ? 'XPASS' : 'XFAIL'
    else tag = exact ? 'PASS' : 'FAIL'
    if (openDirty || forbidden || pageErr.length) tag = 'FAIL'
    tally[tag]++
    if (tag === 'FAIL') red++
    const extra = [
      openDirty ? `openWrites=${JSON.stringify(r.openWrites)}` : '',
      forbidden ? `命中 forbid ${c.forbid}` : '',
      pageErr.length ? `pageerror=${JSON.stringify(pageErr.slice(0, 2))}` : '',
      c.why ? `(${c.why})` : '',
    ].filter(Boolean).join('  ')
    console.log(`${tag.padEnd(5)}  [${c.bucket}] ${c.id}${extra ? '  ' + extra : ''}`)
    for (const [i, x] of r.rounds.entries()) {
      if (DUMP) console.log(`        round${i + 1} out: ${JSON.stringify(x.out)}`)
      if ((tag === 'FAIL' || (tag === 'XPASS' && DUMP)) && x.out !== x.want) {
        if (x.out == null) { console.log(`        round${i + 1}: 没有落盘 ${x.note || ''}`); continue }
        console.log(`        round${i + 1} diff(- 期望 / + 实际):`)
        for (const l of lineDiff(x.want, x.out).slice(0, 12)) console.log('          ' + l)
      }
    }
  }
  console.log(`\n${tally.PASS} PASS · ${tally.FAIL} FAIL · ${tally.XFAIL} XFAIL(已知,归 0b/别的包) · ${tally.XPASS} XPASS(意外通过:挪进 verbatim 桶)`)
  process.exit(red ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
