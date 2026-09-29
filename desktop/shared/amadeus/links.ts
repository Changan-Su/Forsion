// Shared, isomorphic wikilink + tag parsing and page-name resolution.
// Runs in BOTH the Electron main process (the vault index) and the renderer
// (editor decorations, [[ autocomplete, the store). MUST stay free of
// Node / Electron / React — only standard JS.
//
// This is the single source of truth for: the [[…]] / #tag regexes, reducing a
// link to its target page name, normalizing a page key for matching, resolving a
// name to an existing page, and cleaning a page's markdown for the search index.

/** Matches [[Target]] / [[Target|alias]] / [[Target#heading]]; capture group = inner text. */
export const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g

/** Matches ![[Target]] transclusion embeds; capture group = inner text (e.g. "b_x.block"). */
export const EMBED_RE = /!\[\[([^\]\n]+)\]\]/g

/** Matches #tag preceded by start-or-whitespace; capture = tag text. */
export const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu

/** 别名分隔符的位置:`|`,或表格单元格里的 `\|`(GFM 单元格里 `|` 必须转义,Obsidian 同款写法)—— 指向反斜杠(L-09)。
 *  没有 = -1。调用方按「分隔符之前 = 笔记名」切,两种写法一个口径。 */
export function aliasBarIndex(inner: string): number {
  const i = inner.indexOf('|')
  return i > 0 && inner[i - 1] === '\\' ? i - 1 : i
}

/** Reduce a wikilink's inner text to its target page name: "Name|alias" / "Name#heading" → "Name".
 *  表格里的 `Name\|alias` 同样认(L-09:此前取成 `Name\`,反链不计、改名不跟)。 */
export function linkTarget(inner: string): string {
  let s = inner.trim()
  const bar = aliasBarIndex(s)
  if (bar >= 0) s = s.slice(0, bar)
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(0, hash)
  return s.trim()
}

/** Distinct, order-preserving wikilink targets found in markdown.
 *  代码(围栏 / 行内)里的 `[[x]]` 是示例文本,不是链接(docs/amadeus/links-and-properties.md;L-16):先 maskCode。 */
export function parseWikiLinks(md: string): string[] {
  md = maskCode(md)
  const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags)
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    const t = linkTarget(m[1])
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** Distinct, order-preserving embed targets (`![[ ]]`) found in markdown. */
export function parseEmbeds(md: string): string[] {
  const re = new RegExp(EMBED_RE.source, EMBED_RE.flags)
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    const t = m[1].trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** Distinct, order-preserving #tags found in markdown (pure-numeric tokens are ignored).
 *  代码里的 `#include`、`#!/bin/sh` 不是标签(L-14):先 maskCode。 */
export function parseTags(md: string): string[] {
  md = maskCode(md)
  const re = new RegExp(TAG_RE.source, TAG_RE.flags)
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    const t = m[1]
    if (/^[0-9/]+$/.test(t)) continue // "#1", "#1/2" etc. are not tags
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** 标签归一(fm `tags:` 的值、查询串):去首尾空白与前导 `#`;不合 TAG_RE 字符集或纯数字 → null(口径同 parseTags)。 */
export function normTag(raw: string): string | null {
  const t = raw.trim().replace(/^#/, '')
  if (!t || !/^[\p{L}\p{N}_/-]+$/u.test(t) || /^[0-9/]+$/.test(t)) return null
  return t
}

/** 嵌套标签前缀匹配(Obsidian 口径,L-14):查 `work` 命中 `work` 与 `work/urgent`,不命中 `workshop`。大小写不敏感。 */
export function tagMatches(tag: string, query: string): boolean {
  const t = tag.toLowerCase()
  const q = query.trim().replace(/^#/, '').replace(/\/+$/, '').toLowerCase()
  return !!q && (t === q || t.startsWith(`${q}/`))
}

/** Normalized key for matching a page by name: basename, without .md, lowercased. */
export function pageKey(pathOrName: string): string {
  const seg = pathOrName.split(/[\\/]/).pop() ?? pathOrName
  return seg.replace(/\.md$/i, '').trim().toLowerCase()
}

const normSep = (p: string): string => p.replace(/\\/g, '/')

/** Full-path key: separators normalized, .md stripped, lowercased (path-qualified link matching). */
const pathKey = (p: string): string => normSep(p).replace(/\.md$/i, '').trim().toLowerCase()

/**
 * Resolve a link/name to an existing page path — the one rule every consumer shares
 * (editor click / autocomplete / graph / backlinks / server vendor copy).
 *
 * - Path-qualified name (contains '/'): exact path match (case-insensitive, .md implied)
 *   or null — it deliberately does NOT fall back to basename, so `[[a/Foo]]` can never
 *   silently bind to `b/Foo.md`.
 * - Bare name, with `sourcePath` context: same-folder sibling → the source's own
 *   `<base>.fd/` children → vault-wide first match.
 * - Bare name, no context: vault-wide first match (callers pass a sorted list, so ties
 *   are deterministic — identical to the historical behavior).
 */
export function resolvePageName(name: string, pages: string[], sourcePath?: string): string | null {
  const raw = name.trim()
  if (!raw) return null
  if (/[\\/]/.test(raw)) {
    const key = pathKey(raw).replace(/^\/+/, '')
    return pages.find((p) => pathKey(p) === key) ?? null
  }
  const target = pageKey(raw)
  if (!target) return null
  if (sourcePath) {
    const src = normSep(sourcePath)
    const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/') + 1) : ''
    const sib = pages.find((p) => {
      const q = normSep(p)
      return q.startsWith(dir) && !q.slice(dir.length).includes('/') && pageKey(p) === target
    })
    if (sib) return sib
    const fd = `${src.replace(/\.md$/i, '')}.fd/`.toLowerCase()
    const child = pages.find((p) => normSep(p).toLowerCase().startsWith(fd) && pageKey(p) === target)
    if (child) return child
  }
  return pages.find((p) => pageKey(p) === target) ?? null
}

// ── 围栏代码块(存盘还原 / 改名重写 / 搜索解码共用一套配对)───────────────────────────────
// 围栏行:可带列表 / 引用前缀(`* ```js`、`> ```` —— 编辑器把列表项首个代码块写成前一种);容 CRLF。
const FENCE_LINE = /^(?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+|[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?$/

/** 开围栏:反引号围栏的信息串里不许再有反引号(否则是行内代码,如 ```` ```a``` 前 ````)。 */
function fenceOpen(line: string): { ch: string; n: number } | null {
  const m = FENCE_LINE.exec(line)
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null
  return { ch: m[1][0], n: m[1].length }
}
/** 收尾:同字符、不短于开头、后面只许空白(```` ```js ```` 不是收尾)。 */
const fenceCloses = (line: string, open: { ch: string; n: number }): boolean => {
  const m = FENCE_LINE.exec(line)
  return !!m && m[1][0] === open.ch && m[1].length >= open.n && !m[2].trim()
}

/**
 * 围栏代码块之外的每一行交给 fn;整块围栏(含开、收两行)逐字留着。按行切 `\n`,CRLF 的 `\r` 留在行尾。
 * **只有找得到配对收尾的才算围栏**:编辑器序列化出来的围栏永远成对(且外层比块内任何反引号串都长),
 * 配不上对的「开围栏」只可能是误判。旧写法「见到像围栏的行就翻转」在编辑器自己写出的形态上错位 ——
 * ````` ```` `````-里套-```` ``` ````、列表项里的 `* ```js` + 缩进收尾 —— 于是后文整段被当成围栏内跳过:
 * 新打的 `[[链接]]` 按 `\[\[` 落盘成死链、URL 转义留着、改名不跟、搜索不解(09-18 评审实测)。
 * ponytail: 一堆没收尾的开围栏各扫到文末是 O(行²),真实笔记碰不到。
 */
export function mapOutsideFences(md: string, fn: (line: string) => string): string {
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i])
    if (open) {
      let j = i + 1
      while (j < lines.length && !fenceCloses(lines[j], open)) j++
      if (j < lines.length) { i = j; continue }
    }
    lines[i] = fn(lines[i])
  }
  return lines.join('\n')
}

/** maskCode 的填充字符:既非空白(不让 `` `x`#t `` 凭空多出「空白 + #」的标签)、也非字母数字(不把相邻标签续长)、
 *  也不是 `[` `]`(不拼出链接)。 */
export const CODE_MASK = '\u0001'

/**
 * 索引口径(L-14 / L-16):**配对的**围栏代码块整块置空行、行内代码逐字符换成 CODE_MASK —— 行数与列位都不变
 * (行号 / 列号仍对得上原文)。代码里的 `#include`、`[[x]]` 从此不算标签、不算反链。
 * 围栏配对与 mapOutsideFences 同一套(配不上对的开围栏当普通行);行内代码与 outsideCodeSpans 同一套。
 * ponytail: 缩进代码块、跨行的行内代码不认(按行处理)—— 只多几条标签 / 反链,不落盘。
 */
export function maskCode(md: string): string {
  if (!md.includes('`') && !md.includes('~~~')) return md
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i])
    if (open) {
      let j = i + 1
      while (j < lines.length && !fenceCloses(lines[j], open)) j++
      if (j < lines.length) {
        for (let k = i; k <= j; k++) lines[k] = ''
        i = j
        continue
      }
    }
    if (lines[i].includes('`')) lines[i] = outsideCodeSpans(lines[i], (seg) => seg, (span) => CODE_MASK.repeat(span.length))
  }
  return lines.join('\n')
}

/**
 * Undo remark-stringify's escaping of plain-text `[[` (it emits `\[\[` for wikilinks that were
 * typed but not yet re-parsed into nodes — the index regex above then never matches, so freshly
 * added links form no relations). Fenced code blocks are verbatim user content — a literal `\[\[`
 * there (regex/escaping examples) must NOT be touched, so a per-line fence state machine skips
 * ``` / ~~~ blocks. ponytail: inline-code `\[\[` and indented code blocks accept residual risk
 * (remark emits fenced by default; go AST-level if it ever matters).
 */
export function unescapeWikiOutsideFences(md: string): string {
  if (!md.includes('\\[\\[')) return md
  return mapOutsideFences(md, (line) => line.replace(/\\\[\\\[/g, '[['))
}

/**
 * 把 remark 序列化出来的 URL 还原成**用户写的字面**。两件事,都只发生在「文档里新写/改过」之后
 * (从磁盘读上来没动过的那份不经过序列化器,所以「打开旧笔记看着好好的」结构性照不到这两条):
 *
 * 1. **反转义**:gfm 的 autolink-literal 给纯文本里的 `://` / `www.` / `a@b` 加反斜杠,免得自己再
 *    解析成自动链接。可这三种形态在 Amadeus 里都是**有意义的语法** —— `![[https://…]]` 网页嵌入、
 *    `[[a.md]]` 双链目标、独占一行的裸 URL = 书签卡。带着反斜杠落盘 = `URL_RE` 与后缀判定全不匹配
 *    (嵌入变「丢失」、书签卡变一行怪字),Obsidian 那边也打不开。
 *    三条规则是 mdast-util-gfm-autolink-literal 那三条 `unsafe` 的**逐字逆运算**(带 before/after
 *    上下文),不会误伤散文里别的反斜杠。
 * 2. **脱尖括号**:URL 被解析成链接节点后,若裸写会需要转义(`https://www.…` 里的 `www.`),
 *    mdast 就改用 autolink 形态 `<url>`。`![[<https://www.youtube.com/x>]]` 我们自己照样渲染
 *    (`textContent` 里尖括号是语法不是文本),但**Obsidian 解析不了**,而且每次保存都在改字节。
 *    只脱两处**没有歧义**的:`[[<url>` 开头,以及整行恰好是 `<url>`(那正是书签卡的字面)。
 *
 * 围栏与**行内代码**内一律不碰(反引号里的反斜杠是用户真写的字节,序列化器根本不碰那儿)。
 *
 * ⚠️ 两条明知的取舍,不是疏漏:
 *  - 用户**故意**写 `https\://x` 阻止自动链接的,会被还原一次(此后稳定不再翻覆)。
 *  - 整行恰好 `<url>` 会被剥成裸 URL。这是**二选一**:mdast 对「文字===地址」的链接节点就是
 *    输出 `<url>`,不剥的话用户写的**裸 URL**(书签卡的正典字面,远比显式 autolink 常见)每次
 *    保存都被改成 `<url>`。两头都churn,选churn得少的那头 —— 且两种字面在我们这儿渲染完全一致。
 *
 * 2026-08-29 由「粘贴为」与宽度把手的台架揪出;行内代码那条由 Codex 评审补上。
 */
export function normalizeUrlLiterals(md: string): string {
  if (!md.includes('\\') && !md.includes('<')) return md
  return mapOutsideFences(md, (line) =>
    // ⚠️ **行内代码逐字保留**:``\`https\\://host\`` 是用户真写的字节(转义示例/正则示例),
    // 序列化器根本不碰反引号里的内容,所以那里出现的反斜杠不是它加的,不许还原
    // (Codex 2026-08-29)。按反引号切段,只处理段外。
    line
      .split(/(`+[^`]*`+)/)
      .map((seg, k) => (k % 2 === 1 ? seg : seg
        .replace(/(?<=[ps])\\:(?=\/)/g, ':')
        .replace(/(?<=[Ww])\\\.(?=[-.\w])/g, '.')
        .replace(/(?<=[+\-.\w])\\@(?=[-.\w])/g, '@')
        .replace(/(\[\[)<(https?:\/\/[^>\s\]]+)>/g, '$1$2')))
      .join('')
      .replace(/^<(https?:\/\/[^>\s]+)>$/, '$1'),
  )
}

/**
 * 这个码点写成数字字符引用(`&#x..;`)能不能原样读回来。照抄 micromark-util-decode-numeric-character-reference
 * 的拒收表:C0 控制符(除 HT/LF/FF/CR)、DEL 与 C1 控制符、代理项、非字符、越界 —— 这些一律解成 U+FFFD。
 * 编码侧(attentionFlanking:能不能编)与解码侧(decodeCharRefs:能不能解)共用这一张表。
 */
export function refDecodable(cp: number): boolean {
  return !(
    cp < 0x09 || cp === 0x0b || (cp > 0x0d && cp < 0x20) || (cp > 0x7e && cp < 0xa0) ||
    (cp > 0xd7ff && cp < 0xe000) || (cp > 0xfdcf && cp < 0xfdf0) ||
    (cp & 0xffff) === 0xffff || (cp & 0xffff) === 0xfffe || cp > 0x10ffff
  )
}

// micromark 的长度上限:十六进制 ≤6 位、十进制 ≤7 位,超了就不是字符引用。
const NUMERIC_REF = /&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));/g

/** 一行里行内代码(`` ` `` 串到同长 `` ` `` 串)之外的段交给 fn;没配上对的反引号按字面处理。
 *  onCode(可选)= 行内代码段(含两端反引号)的改写,缺省逐字保留。 */
export function outsideCodeSpans(line: string, fn: (seg: string) => string, onCode: (span: string) => string = (x) => x): string {
  let out = ''
  let last = 0
  let i = 0
  while ((i = line.indexOf('`', i)) >= 0) {
    let bs = 0
    while (line[i - 1 - bs] === '\\') bs++
    if (bs % 2) { i++; continue } // `\`` 是字面反引号,开不了行内代码(剩下的反引号照常)
    let n = 0
    while (line[i + n] === '`') n++
    let j = i + n
    let close = -1
    while ((j = line.indexOf('`', j)) >= 0) {
      let k = 0
      while (line[j + k] === '`') k++
      if (k === n) { close = j; break }
      j += k
    }
    if (close < 0) { i += n; continue }
    out += fn(line.slice(last, i)) + onCode(line.slice(i, close + n))
    last = i = close + n
  }
  return out + fn(line.slice(last))
}

/**
 * 正文里的数字字符引用解回字符 —— **只给搜索 / 标签 / 双链 / 摘要用的副本**。编辑器为了让 `**`/`~~` 往返,
 * 会把定界符旁的字写成 `&#x540E;` 这类引用(attentionFlanking);索引读原文就会「后面」搜不到
 * `**注意：**&#x540E;面`、`#项&#x76EE;` 被截成标签 `#项`。
 * ⚠️ 别拿它去改 stripForIndex 的输出:`@` 时间标记按「清洗文本的第 occ 条同文行」回写磁盘,要的是原文。
 * 口径:只解 micromark 认的(refDecodable);换行类(LF/CR)解成空格,保证解码副本与原文逐行对齐
 * (搜索命中行号靠它);反斜杠转义的 `\&#x41;`、行内代码与围栏代码块里的一律不动;单趟替换不会二次解。
 * ponytail: 跨行的行内代码、缩进代码块、`$` 数学不认(按行处理),里头的引用会被解 —— 只多几条搜索命中,不落盘。
 *   未配对的「开围栏」同理当普通行。最坏情况是一堆没收尾的开围栏各扫到文末(O(行²)),真实笔记里碰不到。
 */
export function decodeCharRefs(md: string): string {
  if (!md.includes('&#')) return md
  const decode = (seg: string): string =>
    seg.replace(NUMERIC_REF, (m: string, hex: string | undefined, dec: string | undefined, off: number, str: string) => {
      let bs = 0
      while (str[off - 1 - bs] === '\\') bs++
      if (bs % 2) return m
      const cp = hex ? parseInt(hex, 16) : parseInt(dec as string, 10)
      if (!refDecodable(cp)) return m
      return cp === 0x0a || cp === 0x0d ? ' ' : String.fromCodePoint(cp)
    })
  // 围栏见 mapOutsideFences(只认配对的:在代码里多解几个只多几条搜索命中,状态错位则后文全不解)。
  return mapOutsideFences(md, (line) => (line.includes('&#') ? outsideCodeSpans(line, decode) : line))
}

/** `[[Name|alias]]` → alias;`[[Name#h]]` → `Name › h`(`#^id` 同);`[[Name]]` → Name。反链 / 提及摘录用。 */
function wikiLabel(inner: string): string {
  const bar = aliasBarIndex(inner)
  const alias = bar >= 0 ? inner.slice(inner.indexOf('|', bar) + 1).trim() : ''
  if (alias) return alias
  const base = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
  return base.replace(/\s*#\^?\s*/, ' › ').replace(/^ › /, '')
}

/**
 * 反链 / 未链接提及的摘录(L-16):一行 markdown → 去掉语法的可读文本。**有损,只用于展示**。
 * 剥:行首引用 / 列表 / 任务框 / 标题井号,`[[ ]]`(显示别名或「笔记 › 标题」)、md 链接与图片(留文字)、HTML 标签、
 * `**` `__` `~~` `==` `*` `_` 强调、行内代码反引号、反斜杠转义、`%%注释%%`、行尾 `^块 id`。
 */
export function plainSnippet(line: string): string {
  return line
    .replace(/^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+)?/, '')
    .replace(/!?\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => wikiLabel(inner))
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/%%.*?%%/g, '')
    .replace(/<\/?[A-Za-z][^>\n]*>/g, '')
    .replace(/(\*\*|__|~~|==)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\p{L}\p{N}*_])[*_](?=\S)(.+?)(?<=\S)[*_](?![\p{L}\p{N}*_])/gu, '$1$2')
    .replace(/(`+)([^`]*?)\1/g, '$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|>=])/g, '$1')
    .replace(/\s\^[A-Za-z0-9-]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Strip YAML frontmatter and all HTML comments (the invisible Amadeus block/layout
 * markers) so search snippets and indexed text never surface marker noise.
 */
export function stripForIndex(md: string): string {
  return md
    .replace(/^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, '') // leading YAML frontmatter(口径=split.ts:空 fm 合法+收尾栅栏独占一行+容文件头 BOM;与 mdMarks.findMarkLine 成对改)
    .replace(/<!--[\s\S]*?-->/g, '') // HTML comments (amadeus:block / amadeus:layout)
}
