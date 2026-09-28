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
// 四个桶(别把白名单做宽 —— 白名单用**黄金输出**断言,新的噪音照样红):
//   verbatim  必须逐字。红 = exit 1。
//   whitelist 评审附录 A / 拍板表里认定的既定规范化,断言「恰好规范成这个样子」,第二轮必须逐字。红 = exit 1。
//   stable    首轮允许偏离(修前就有的一次性丢失,另记在残余风险里),但**第二轮必须逐字**(相对首轮落盘)——
//             专抓「越存越多」(R-01 返修:读写两侧认公式不一致,反斜杠每存翻一倍,首轮看不出)。红 = exit 1。
//   pending   已知未修、归别的波次/包(R-25 → 0b;R-01 余项 / D-11)。按逐字断言但只记 XFAIL,
//             不算红;**意外通过**打 XPASS —— 修的人把它挪进 verbatim 桶。
//             ⚠️ D-18(0b)起**未编辑的顶层块逐字写回原文**:病在序列化器里的条目,EDITHERE 要和病灶放在**同一块**
//             (`${M} …`),否则逐字回填直接绕过序列化、XPASS 却什么都没修。附录 A 的规范化同理(*_edited 条目)。
// 另:任何桶打开即写盘、或命中 forbid(比「没修」更坏的形态),一律红。
// 编辑用例(EDITS,verbatim 桶):动作不是「首段敲字」而是删掉某一段,golden = 删后落盘;重开后链接 href 必须还是删之前那个,
//   第二轮敲字逐字(D-12 返修:删掉同名定义的第一条,引用形只在剩下的首个定义解析出同一地址时写回)。
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

const V = 'verbatim', W = 'whitelist', S = 'stable', P = 'pending'
/** golden:whitelist 桶第一轮的期望落盘(含首段的 Z)。forbid:任何桶都不许出现的形态;require:落盘必须含的形态。
 *  visible:打开后正文 innerText 必须含这段(「看得见」—— D-06 的换行、D-12 的定义行)。 */
const CASES = [
  // ── d18-rt 的 21 份(verify-integrity-3/d18-rt.cjs)────────────────────────────────
  { id: 'd18.ordered_tight', bucket: V, md: `${M}\n\n1. a\n2. b\n` },
  { id: 'd18.list_dash_tight', bucket: V, md: `${M}\n\n- a\n- b\n  - c\n` },
  { id: 'd18.tasks_dash', bucket: V, md: `${M}\n\n- [ ] todo\n- [x] done\n` },
  { id: 'd18.ordered_all1', bucket: V, md: `${M}\n\n1. a\n1. b\n1. c\n` },
  { id: 'd18.table', bucket: V, md: `${M}\n\n| A | B |\n|---|---|\n| 1 | 2 |\n` },
  { id: 'd18.setext', bucket: V, md: `${M}\n\nTitle\n=====\n\ntext\n` },
  { id: 'd18.fences_tilde', bucket: V, md: `${M}\n\n~~~js\nx\n~~~\n` },
  { id: 'd18.hr_dash', bucket: V, md: `${M}\n\n---\n\ntext\n` },
  { id: 'd18.hr_under', bucket: V, md: `${M}\n\n___\n\ntext\n` },
  { id: 'd18.emph_underscore', bucket: V, md: `${M}\n\n_emph_ and __strong__\n` },
  { id: 'd18.callout', bucket: V, md: `${M}\n\n> [!note] Title\n> body\n` },
  { id: 'd18.footnote', bucket: V, md: `${M}\n\nA[^1] B[^2].\n\n[^1]: one\n[^2]: two\n` },
  { id: 'd18.indented_code', bucket: V, md: `${M}\n\n    code\n\ntext\n` },
  { id: 'd18.hardbreak_2sp', bucket: V, md: `${M}\n\nline one  \nline two\n` },
  { id: 'd18.bare_url', bucket: V, md: `${M}\n\nsee https://x.com/a_b ok\n` },
  { id: 'd18.www_url', bucket: V, md: `${M}\n\nsee www.x.com ok\n` },
  { id: 'd18.snake', bucket: V, md: `${M}\n\nsnake_case_var and 5 * 3\n` },
  { id: 'd18.mark_html', bucket: V, md: `${M}\n\nsome <mark>hi</mark> text\n` },
  { id: 'd18.no_trailing_nl', bucket: V, md: `${M}\n\nlast` },
  { id: 'd18.bom', bucket: P, why: 'D-01(0a 另一包:BOM)', md: `\uFEFF${M}\n\npara\n` },
  { id: 'd18.task_upper_X', bucket: V, md: `${M}\n\n- [X] Done\n` },
  // 附录 A 认定的规范化对**被编辑的块**照旧适用(未编辑的块见上面逐字的同名条目)。
  { id: 'd18.emph_underscore_edited', bucket: W, why: '附录 A I-16:`_it_`→`*it*`(09-18 拍板);强调符统一 `*`(attentionFlanking.ts)', md: `_emph_ and __strong__ ${M}\n`, golden: `*emph* and **strong** ${M}Z\n` }, // 标记放句尾:紧跟光标的空格会被 I-06 换成 NBSP(另一包)
  { id: 'd18.bare_url_edited', bucket: W, why: '附录 A I-16 / D-18:句中 `<url>`(links.ts normalizeUrlLiterals 取舍)', md: `${M} see https://x.com/a_b ok\n`, golden: `${M}Z see <https://x.com/a_b> ok\n` },

  // ── D-05:编辑**列表里**的字 —— 整只列表重新序列化,列表符与紧凑度必须沿用原文(拍板 #17:记住原标记、写回沿用)──
  { id: 'd05.edit_in_list', bucket: V, md: `- ${M}\n- b\n  - c\n\ntail\n` },
  { id: 'd05.edit_in_tasks', bucket: V, md: `- [ ] ${M}\n- [x] done\n` },
  { id: 'd05.edit_plus_nested_star', bucket: V, md: `+ ${M}\n  * b\n+ c\n` },
  { id: 'd05.edit_loose', bucket: V, md: `- ${M}\n\n- b\n` },
  { id: 'd05.edit_nested_ordered', bucket: V, md: `1. ${M}\n   1. y\n2. z\n` },
  { id: 'd05.edit_upper_X', bucket: W, why: '附录 A D-05:被编辑的列表里 `[X]`→`[x]` 仍是规范化', md: `- [X] ${M}\n- [ ] b\n`, golden: `- [x] ${M}Z\n- [ ] b\n` },

  // ── D-06:行内 / 单元格 / 列表项里的 `<br>`(verify-rich-1/br.cjs、verify-keyboard-1/v01-br.cjs、d06_br.cjs)──
  { id: 'd06.para', bucket: V, md: `${M}\n\nhello<br>world\n\nOther.\n`, visible: 'hello\nworld' },
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
  // 段落里独占一行的 `<br>`:旧版(v3)空段落的落盘形,与写侧 stripEmptyLineBr 同口径 = 空行(不当换行,见 inlineBr.ts ownLine)。
  // 没被编辑的块里的整行 `<br>` 原样(D-18 逐字);被编辑的块按附录 A 的空行编码写。
  { id: 'd06.own_line_in_para', bucket: V, md: `${M}\n\ntext\n<br />\nmore\n` },
  { id: 'd06.block_br_line', bucket: V, md: `${M}\n\n甲\n\n<br>\n\n乙\n` },
  { id: 'd06.own_line_in_para_edited', bucket: W, why: '附录 A D-18:空行编码(被编辑的块)', md: `${M}\ntext\n<br />\nmore\n`, golden: `${M}Z\ntext\n\nmore\n` },

  // ── R-01:公式里的「反斜杠 + 标点」(verify-rich-1/math*.cjs、verify-integrity-1/d02_math*.cjs)──
  { id: 'r01.matrix_block', bucket: V, md: `${M}\n\n$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$\n` },
  { id: 'r01.aligned_block', bucket: V, md: `${M}\n\n$$\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n$$\n` },
  { id: 'r01.inline_brace', bucket: V, md: `${M}\n\nset $\\{x\\}$ here\n` },
  // 行内公式里的 `\$`:scanMath 见 `$` 就收、不认 `\$`(mathLivePreview 顶注 ponytail),落盘侧认不出这个跨度;
  // 解析侧补了反斜杠就会越存越多,所以两侧都不认、维持旧行为 —— 要逐字得连 scanMath / unescapeMathSource 一起改。
  // 放进被编辑的块:未编辑的块 D-18 起逐字写回,病只剩在「被编辑、要重新序列化」的块里。
  { id: 'r01.inline_dollar', bucket: P, why: 'R-01 余项:行内公式内的 `\\$`(scanMath 不认)', md: `${M} price $\\$5$ here\n`, forbid: /\\\\\$/ },
  { id: 'r01.punct_mix', bucket: V, md: `${M}\n\n$a\\,b \\| c \\% d \\# e \\_ f \\{g\\}$ 尾\n` },
  { id: 'r01.set_matrix_cn', bucket: V, md: `${M}\n\n集合 $\\{a,b\\}$ 与 $\\begin{matrix}1 \\\\ 2\\end{matrix}$ 尾\n` },
  { id: 'r01.single_line_display', bucket: V, md: `${M}\n\nseed\n\n$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$\n\nafter\n` },
  { id: 'r01.display_escaped_dollar', bucket: V, md: `${M}\n\n$$a\\$b$$\n` },
  { id: 'r01.containers', bucket: V, md: `${M}\n\n* 项 $\\{a\\}$\n\n> 引 $\\{b\\}$\n\n## 题 $\\{c\\}$\n` },
  { id: 'r01.control_cmds', bucket: V, md: `${M}\n\n$x_i + \\sum_{k} a*b$ ok\n\n$$\n\\frac{a}{b} + \\alpha_{1}\n$$\n` },
  { id: 'r01.escape_outside_math', bucket: V, why: '公式外的转义不许被补回(对照)', md: `${M}\n\nliteral \\*not em\\* and \\_x\\_ and $\\{y\\}$\n` },
  // 被转义的 `$` 不当定界符 —— 这条的旧病是 D-11(转义被剥,0b),但**绝不能**被本修复变成 `\\$x\\$`。
  { id: 'r01.escaped_dollars', bucket: P, why: 'D-11:转义被剥(被编辑的块;未编辑的块 D-18 起逐字)', md: `${M} not math: \\$x\\$ ok\n`, forbid: /\\\\\$/ },
  // R-01 返修(评审阻断 R-01-growth):行内代码 / 链接地址里的 `$`、粗体里的货币挨着公式 —— 返修前每存一次反斜杠翻一倍。
  // 两侧现按同一份原文认公式:这些行里的公式可能认不出(首轮反斜杠一次性丢掉 = 修前行为),但第二轮必须逐字。
  { id: 'r01.grow_code_dollar', bucket: S, md: `${M}\n\n用\`$\`包裹公式,例如$\\{a,b\\}$\n`, forbid: /\\\\\{/ },
  { id: 'r01.grow_code_home', bucket: S, md: `${M}\n\n先设置\`$HOME\`,再看集合$\\{a,b\\}$\n`, forbid: /\\\\\{/ },
  { id: 'r01.grow_link_url', bucket: S, md: `${M}\n\n[文档](http://x/?$top=1)里$\\{a\\}$\n`, forbid: /\\\\\{/ },
  { id: 'r01.grow_strong_currency', bucket: S, md: `${M}\n\n价格**$5**,集合$\\{a\\}$\n`, forbid: /\\\\\{/ },
  { id: 'r01.grow_escaped_dollar', bucket: S, md: `${M}\n\n$a \\$,x$\\{b\\}$\n`, forbid: /\\\\\{/ },
  { id: 'r01.code_path_verbatim', bucket: V, md: `${M}\n\nshell 里 \`echo $PATH\`之后$x\\_1$\n` },

  // ── D-12:链接定义行 / `[标签]: 值` / 引用式链接(verify-integrity-2/d12b.cjs、d11d12.cjs)──
  { id: 'd12.cn_label_line', bucket: V, md: `${M}\n\n会议记录\n\n[重要]: 明天开会\n\n[TODO]: 回复邮件\n\n结尾\n`, visible: '[重要]: 明天开会' },
  { id: 'd12.en_label', bucket: V, md: `${M}\n\nnotes\n\n[Note]: remember-this\n` },
  { id: 'd12.unused_defs', bucket: V, md: `${M}\n\ntext\n\n[bookmark]: https://example.com\n[other]: https://other.com "t"\n` },
  // 引用式链接所在的块没被编辑、定义也都在 → 逐字(D-18);被编辑 → 按 D-12 取舍写成行内链接(URL 不丢)。
  { id: 'd12.reflink', bucket: V, md: `${M}\n\nsee [a][1] and [b][] and [c]\n\n[1]: http://example.com "Title"\n[b]: http://x.y\n[c]: /c\n` },
  { id: 'd12.reflink_edited', bucket: W, why: 'D-12 取舍:被编辑的块里引用式链接写成行内链接,定义行逐字保留', md: `${M} see [a][1] and [b][] and [c]\n\n[1]: http://example.com "Title"\n[b]: http://x.y\n[c]: /c\n`,
    golden: `${M}Z see [a](http://example.com "Title") and [b](http://x.y) and [c](/c)\n\n[1]: http://example.com "Title"\n[b]: http://x.y\n[c]: /c\n` },
  { id: 'd12.def_in_quote', bucket: V, md: `${M}\n\n> 引文\n>\n> [ref]: https://q.example\n` },
  { id: 'd12.def_multiline_in_list', bucket: V, md: `${M}\n\n* [a]: http://x.example\n  "title"\n` },
  // 定义下一行紧跟正文:两块都没被编辑 → 逐字(D-18);定义行本身必须还在。
  { id: 'd12.def_then_text', bucket: V, md: `${M}\n\n[a]: x\ntext\n`, require: /\n\[a\]: x\n/ },
  { id: 'd12.def_escapes', bucket: V, md: `${M}\n\n[a_b]: https://x.com/a_b*c "t_1"\n\n[k]: <https://x.com/y z>\n` },
  // 同名定义(首个生效):剩下那条以原地址为前缀 / 地址写在下一行 —— 都还在时照旧逐字(删掉第一条见 EDITS)。
  { id: 'd12.dup_def_prefix', bucket: V, md: `${M}\n\nsee [a][1] here\n\n[1]: http://x.example/docs\n\n[1]: http://x.example/docs/v2\n` },
  { id: 'd12.dup_def_dest_next_line', bucket: V, md: `${M}\n\nsee [a][1] here\n\n[1]:\n  http://first.example\n\n[1]:\n  http://second.example\n` },
  { id: 'd12.dup_def_prefix_edited', bucket: W, why: 'D-12 取舍:被编辑的块里引用式链接写成行内链接(首个定义生效)', md: `${M} see [a][1] here\n\n[1]: http://x.example/docs\n\n[1]: http://x.example/docs/v2\n`,
    golden: `${M}Z see [a](http://x.example/docs) here\n\n[1]: http://x.example/docs\n\n[1]: http://x.example/docs/v2\n` },

  // ── R-25 行首 #tag(verify-rich-5/tags.cjs)─────────────────────────────────────────
  { id: 'tags.midLine', bucket: V, md: `${M}\n\n正文 #tag 与 #嵌套/标签\n` },
  { id: 'tags.heading', bucket: V, md: `${M}\n\n# 标题\n` },
  { id: 'tags.lineStart', bucket: V, why: 'R-25(0b 已修):行首 `#tag` 曾被转义成 `\\#tag`', md: `${M}\n\n#tag 与 #嵌套/标签 正文\n` },
  { id: 'tags.listItem', bucket: P, why: 'D-05(0b):紧凑 `-` 列表被改写(行首 `#` 的转义已由 R-25 修掉)', md: `${M}\n\n- #todo 买菜\n- 普通 #tag\n` },
  { id: 'tags.quote', bucket: V, why: 'R-25(0b 已修)', md: `${M}\n\n> #idea 想法\n` },
  { id: 'tags.onlyTag', bucket: V, why: 'R-25(0b 已修)', md: `${M}\n\n#tag\n` },
]

// ── 入口:修复挂在 remark 管线(唯一咽喉)上 —— 加载之外,外部回灌 / 切换文件 / 粘贴也必须同样保真 ──
// 用同一段混合正文(R-01 公式 + D-06 `<br>` + D-12 定义行)走三条入口,再在首段敲一个字,期望落盘逐字。
const ENTRY_BODY = `$$\n\\begin{pmatrix} a \\\\ b \\end{pmatrix}\n$$\n\n行内 $\\{x\\}$ 与 a<br>b\n\n[重要]: 明天开会\n`
const ENTRIES = [
  { id: 'entry.fire', kind: 'fire' },
  { id: 'entry.switch', kind: 'switch' },
  { id: 'entry.paste', kind: 'paste' },
]

// ── D-12:删掉同名定义的第一条 —— 落盘成带原地址的行内链接,重开不指向剩下那条。
// del = 删掉正文含它的第一段;href = 删之前 / 重开后链接都必须是它。
const EDITS = [
  { id: 'd12.del_first_def_prefix', md: `${M}\n\nsee [a][1] here\n\n[1]: http://x.example/docs\n\n[1]: http://x.example/docs/v2\n`, del: 'x.example/docs',
    golden: `${M}\n\nsee [a](http://x.example/docs) here\n\n[1]: http://x.example/docs/v2\n`, href: 'http://x.example/docs' },
  { id: 'd12.del_first_def_dest_next_line', md: `${M}\n\nsee [a][1] here\n\n[1]:\n  http://first.example\n\n[1]:\n  http://second.example\n`, del: 'first.example',
    golden: `${M}\n\nsee [a](http://first.example) here\n\n[1]:\n  http://second.example\n`, href: 'http://first.example' },
  { id: 'd12.del_first_def_identical', md: `${M}\n\nsee [a][1] here\n\n[1]: http://x.example/docs\n\n[1]: http://x.example/docs\n`, del: 'x.example/docs',
    golden: `${M}\n\nsee [a](http://x.example/docs) here\n\n[1]: http://x.example/docs\n`, href: 'http://x.example/docs' },
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
  if (c.visible) {
    const shown = await page.evaluate((s) => document.querySelector(s).innerText, PM)
    if (!shown.includes(c.visible)) r.errs.push(`看不见:正文 innerText 不含 ${JSON.stringify(c.visible)}(实际 ${JSON.stringify(shown.slice(0, 120))})`)
  }
  const one = await typeAndSave(page, M, 'Z')
  await page.close()
  const want1 = c.bucket === W ? c.golden : c.bucket === S ? null : c.md.replace(M, M + 'Z') // stable 首轮不比
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
  let quiet = -1 // 入口动作之后、敲字之前的写盘次数:回灌 / 切换 / 打开都不许回声写
  if (e.kind === 'fire') {
    page = await open(browser, `${M}\n\n占位\n`, errs)
    await page.evaluate((md) => window.__upage.fire('Unified.md', md), `${M}\n\n${ENTRY_BODY}`)
    await page.waitForTimeout(1500)
    quiet = await writeCount(page)
    out = (await typeAndSave(page, M, 'Z')).out
  } else if (e.kind === 'switch') {
    page = await open(browser, `${M}\n\n占位\n`, errs)
    await page.evaluate((md) => window.__upage.switchFile('Other.md', md), `${M}\n\n${ENTRY_BODY}`)
    await page.waitForTimeout(1500)
    quiet = await writeCount(page)
    out = (await typeAndSave(page, M, 'Z')).out
  } else {
    // 粘贴:首段末回车出一个空段,把正文当 text/plain 粘进去(plugin-clipboard → parserCtx → 同一条 remark 链)
    page = await open(browser, `${M}\n`, errs)
    quiet = await writeCount(page) // 粘贴本身就是编辑,这里只量打开
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
  return { id: e.id, bucket: V, rounds: [{ out, want }], openWrites: [quiet], errs }
}

const hrefsOf = (page) => page.evaluate((s) => [...document.querySelectorAll(s + ' a[href]')].map((a) => a.getAttribute('href')).join(' '), PM)

async function runEdit(browser, e) {
  const errs = []
  const r = { id: e.id, bucket: V, rounds: [], openWrites: [], errs }
  let page = await open(browser, e.md, errs)
  r.openWrites.push(await writeCount(page))
  const before = await hrefsOf(page)
  if (before !== e.href) errs.push(`打开时链接 href=${JSON.stringify(before)},期望 ${e.href}`)
  const w0 = await writeCount(page)
  const deleted = await page.evaluate((needle) => {
    const view = window.__upage.probe.view()
    let hit = null
    view.state.doc.descendants((n, pos) => {
      if (!hit && n.type.name === 'paragraph' && n.textContent.includes(needle)) hit = { pos, size: n.nodeSize }
      return !hit
    })
    if (!hit) return false
    view.dispatch(view.state.tr.delete(hit.pos, hit.pos + hit.size))
    return true
  }, e.del)
  for (let t = 0; deleted && t < 60 && (await writeCount(page)) === w0; t++) await page.waitForTimeout(100)
  await page.waitForTimeout(400)
  const out = deleted ? await lastWrite(page) : null
  await page.close()
  r.rounds.push({ out, want: e.golden, note: deleted ? undefined : `找不到含 ${e.del} 的段落` })
  if (out != null) {
    page = await open(browser, out, errs)
    r.openWrites.push(await writeCount(page))
    const after = await hrefsOf(page)
    if (after !== e.href) errs.push(`重开后链接 href=${JSON.stringify(after)},删之前是 ${e.href}(重开指向别处)`)
    const two = await typeAndSave(page, M, 'Y')
    await page.close()
    r.rounds.push({ out: two.out, want: out.replace(M, M + 'Y'), note: two.note })
  }
  return r
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
  const cases = [...CASES, ...ENTRIES.map((e) => ({ ...e, bucket: V })), ...EDITS.map((e) => ({ ...e, kind: 'edit', bucket: V }))].filter((c) => !ONLY || c.id.includes(ONLY))
  const results = await pool(cases, Number(process.env.RTCORPUS_JOBS || 4), (c) => (c.kind === 'edit' ? runEdit(browser, c) : c.kind ? runEntry(browser, c) : runCase(browser, c)))
  await browser.close()

  let red = 0
  const tally = { PASS: 0, FAIL: 0, XFAIL: 0, XPASS: 0 }
  for (const [k, r] of results.entries()) {
    const c = cases[k]
    const forbidden = (c.forbid ? r.rounds.find((x) => x.out != null && c.forbid.test(x.out)) : null)
      || (c.require ? r.rounds.find((x) => x.out == null || !c.require.test(x.out)) : null)
    const openDirty = r.openWrites.some((n) => n !== 0)
    const exact = r.rounds.every((x) => x.out != null && (x.want == null || x.out === x.want))
    const pageErr = r.errs.filter((e) => !/Failed to load resource/.test(e))
    let tag
    if (c.bucket === P) tag = exact ? 'XPASS' : 'XFAIL'
    else tag = exact ? 'PASS' : 'FAIL'
    if (openDirty || forbidden || pageErr.length) tag = 'FAIL'
    tally[tag]++
    if (tag === 'FAIL') red++
    const extra = [
      openDirty ? `openWrites=${JSON.stringify(r.openWrites)}` : '',
      forbidden ? `命中 forbid ${c.forbid || ''} / 缺 require ${c.require || ''}` : '',
      pageErr.length ? `errs=${JSON.stringify(pageErr.slice(0, 2))}` : '',
      c.why ? `(${c.why})` : '',
    ].filter(Boolean).join('  ')
    console.log(`${tag.padEnd(5)}  [${c.bucket}] ${c.id}${extra ? '  ' + extra : ''}`)
    for (const [i, x] of r.rounds.entries()) {
      if (DUMP) console.log(`        round${i + 1} out: ${JSON.stringify(x.out)}`)
      if ((tag === 'FAIL' || (tag === 'XPASS' && DUMP)) && x.out !== x.want) {
        if (x.out == null) { console.log(`        round${i + 1}: 没有落盘 ${x.note || ''}`); continue }
        if (x.want == null) { console.log(`        round${i + 1} out(stable 首轮不比): ${JSON.stringify(x.out)}`); continue }
        console.log(`        round${i + 1} diff(- 期望 / + 实际):`)
        for (const l of lineDiff(x.want, x.out).slice(0, 12)) console.log('          ' + l)
      }
    }
  }
  console.log(`\n${tally.PASS} PASS · ${tally.FAIL} FAIL · ${tally.XFAIL} XFAIL(已知,归 0b/别的包) · ${tally.XPASS} XPASS(意外通过:挪进 verbatim 桶)`)
  process.exit(red ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
