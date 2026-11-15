import { mapOutsideFences } from '@amadeus-shared/links'

/**
 * 落盘前把行首 `#标签` 的 `\#` 还原成 `#`(R-25,评审 2026-09-27)。
 *
 * mdast-util-to-markdown 的 unsafe 表对「行首的 `#`」一律转义(`{atBreak: true, character: '#'}`,防读成
 * ATX 标题),于是段落 / 列表项 / 引用 / 任务项开头的 `#tag` 落盘成 `\#tag`:编辑器里看着正常,但
 * Obsidian 与我们自己的标签索引(links.ts TAG_RE 要求 `#` 前是行首或空白)都不认 —— 标签静默消失。
 * 新段行首亲手敲 `#tag`,第一次落盘就已经是 `\#tag`。
 *
 * 只还原**不可能是标题**的那种:`\#` 后面紧跟非空白、非 `#` 的字符。`\# 文字`(`#` 后空格)、`\#`(行尾,
 * 空标题)、`\##…` 这三种去掉转义就真成标题了,原样保留。
 * 认的行首前缀:缩进、列表标记(`-*+`、`1.`、`1)`)、任务框 `[ ]`/`[x]`、引用 `>`,可叠加。围栏代码整块跳过
 * (links.mapOutsideFences:代码里的 `\#` 是用户真写的字节)。行内代码碰不到这里:行内代码里「换行 + `#`」
 * 会被序列化器换成空格,反引号串里不会出现行首 `\#`。
 *
 * ⚠️ 必须排在 unescapeMathSource **之前**(normalizeSerializedMd 的链序):公式块里 LaTeX 的 `\#`(字面井号)
 * 此时还是序列化器写出的 `\\#`,不匹配;排到后面它已被还原成 `\#`,再被这里剥成 `#` = 改坏 TeX。
 * ponytail: 用户**故意**在行首写 `\#不是标签` 的,会被还原成真标签 —— 与行中 `\#` 早已被剥掉同一回事(D-11,
 *   解析侧没留转义痕迹),修那条要按 position 记字面区间,不在这里。
 */
const TAG_AT_LINE_START = /^((?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|[ \t]*>[ \t]?)*[ \t]*)\\#(?=[^\s#])/

export function unescapeTagAtLineStart(md: string): string {
  if (!md.includes('\\#')) return md
  return mapOutsideFences(md, (line) => line.replace(TAG_AT_LINE_START, '$1#'))
}

/**
 * 行首 `==高亮==` 的 `\==` 还原成 `==`(I-17,评审 2026-09-27)。
 *
 * 同一张 unsafe 表还有 `{atBreak: true, character: '='}`(防读成 setext 标题下划线):段落 / 列表项 / 引用开头的
 * `==重点==` 一经编辑就落成 `\==重点==` —— Obsidian 按转义显示成字面 `=` 加半截高亮,高亮当场失效。
 * setext 下划线要求**整行只有 `=`**;`\=` 后面(可再隔一个 `=`)紧跟非空白、非 `=` 的字符,这一行就不可能是下划线,
 * 转义纯属多余。单个 `=` 同理:选中文字敲 `=` 包成 `=词=`(Obsidian 的 autoPairMarkdown,见 unified/keyboard.ts)在行首时
 * 落成 `\=词=`,一并还原。
 *
 * ⚠️ 挂在序列化器的 **text handler** 上(textSafe.handleText 的出口),不在整串上做:只动这段正文文字**自己**被 safe
 * 加的那个转义 —— 节点开头(node.value 本身以 `=` 开头,而 `=` 只有行首这一条 unsafe)或节点内换行之后。
 * HTML 块 / 行内 HTML 里用户写的 `\=`、代码、用户转义(D-11)都不经过这里。二审(Codex)实测整串版把
 * `<pre>\n\=keep\n</pre>` 落成 `=keep`(mapOutsideFences 只跳围栏,不跳 HTML)。
 * 节点末尾的判据字符取 info.after(`==` 后紧跟 `**粗**` / `<kbd>` 也得认,rtcorpus i17)。
 * 公式里 LaTeX 的 `\=` 在这里是序列化器翻倍后的 `\\=`,不匹配。
 */
const HL_IN_TEXT = /(^|\n[ \t]*)\\=/g

export function unescapeHighlightInText(out: string, value: string, after: string | undefined): string {
  if (!out.includes('\\=')) return out
  const s = out + (after ?? '')
  return out.replace(HL_IN_TEXT, (all: string, lead: string, at: number) => {
    if (at === 0 && !lead && !value.startsWith('=')) return all
    return /^=?[^\s=]/.test(s.slice(at + all.length)) ? `${lead}=` : all
  })
}
