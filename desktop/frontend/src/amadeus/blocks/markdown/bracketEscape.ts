/**
 * 正文里成对的字面方括号 `[词]`:序列化器加的 `\[` 还原成 `[`(Obsidian 手感对齐 K12h / K13b)。
 *
 * mdast-util-to-markdown 的 unsafe 表对正文里的 `[` 一律转义(`{character: '[', inConstruct: 'phrasing'}`),
 * 于是选中文字敲 `[` 包成的 `[there]`、正文自动成对打出的 `[{x}]` 一经编辑就落成 `\[there]` / `\[{x}]`。
 * Obsidian 原样写 `[there]`。在 CommonMark 里,一对不跟 `(` / `[` / `:`、也对不上任何链接定义的 `[词]` 就是字面,转义纯属多余。
 *
 * 只还原「重新解析仍是同一段字面」的那一种,其余一律保留转义:
 *  · 同一行里成对、中间不再有 `[` `]`;
 *  · `]` 后面不是 `(` `[` `:`(行内链接 / 完整引用 / 定义),前面不是 `!`(图片)和 `]`(`[a][b]` 引用);
 *    紧挨着另一个方括号(前面是 `[` / 后面是 `]`)也不动 —— 还原后会拼出 `[[` / `]]`(双链 / 嵌入的定界);
 *  · 里面不以 `^`(脚注)、`!`(callout 令牌,归 unescapeCalloutToken)开头,也不是 ` ` / `x` / 空(任务框);
 *  · 不在围栏 / 行内代码、链接地址、HTML、公式里(maskNonMath + scanMath,与 unescapeMathSource 同一口径);
 *  · 整篇里有链接定义(`[标签]: …`)时整篇不动 —— `[标签]` 会被读成引用链接。
 *    序列化串里看不到逐字回填的块(D-18 占位),所以 v4 落盘另在 serializeUnified 里按文档查定义(hasRefDefinition)。
 *  · 只用于 v4 整篇落盘(normalizeSerializedMd 的 literalBrackets,serializeUnified 打开):单块 / 剪贴板 / 片段
 *    只是文件的一部分,别处的定义看不见,照旧保留 `\[`。
 * 用户自己写的转义(D-11)此时是占位 + 字面字符,不是 `\[`,不受影响。
 * 仪器:bracketEscape.test.ts(往返逐字)、check:rtcorpus、check:obsfeel 的 K12h / K13b。
 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { maskNonMath, scanMath } from './mathLivePreview'
import { pristineRaw } from './refDefinitions'

/** 一对未转义的 `[标签]:`(脚注定义 `[^x]:` 不算:它不会把正文里的 `[x]` 读成链接)。 */
const DEFINITION = /(?:^|[^\\])\[(?!\^)(?:[^\\[\]\n]|\\.)+\]:/

/** `\[里面]`:前面的反斜杠个数为奇数(最后一个是转义 `[` 的那个),里面不含方括号与换行。 */
const ESCAPED_PAIR = /(?<!\\)((?:\\\\)*)\\\[([^[\]\n]*)\]/g

export function unescapeLiteralBrackets(md: string): string {
  if (!md.includes('\\[') || DEFINITION.test(md)) return md
  const masked = maskNonMath(md)
  const math = md.includes('$') ? scanMath(masked) : []
  return md.replace(ESCAPED_PAIR, (all: string, slashes: string, inner: string, at: number) => {
    const open = at + slashes.length // 转义 `[` 的反斜杠
    const end = at + all.length // `]` 之后
    if (/^[ xX]?$/.test(inner) || /^[\^!]/.test(inner)) return all
    const before = md[at - 1]
    if (slashes.length === 0 && (before === '!' || before === ']' || before === '[')) return all
    const after = md[end]
    if (after === '(' || after === '[' || after === ':' || after === ']' || (after === '\\' && md[end + 1] === '[')) return all
    if (masked.slice(open, end) !== md.slice(open, end)) return all // 代码 / 地址 / HTML 里
    if (math.some((s) => s.from < end && s.to > open)) return all
    return `${slashes}[${inner}]`
  })
}

/** 文档里有没有**会照原文写回**的链接定义段落(refDefinitions:没被动过的定义段落按 `raw` 原文落盘;动过的按普通段落
 *  转义写,不再是定义)。与串上的 DEFINITION 同一口径 —— 逐字回填的块在序列化串里只是占位,所以 v4 落盘按文档查。 */
export function hasRefDefinition(doc: PMNode): boolean {
  let found = false
  doc.descendants((n) => {
    if (found) return false
    if (typeof n.attrs?.raw === 'string' && pristineRaw(n) != null) found = true
    return !found && !n.isTextblock // 不进行内:定义段落本身就是文本块
  })
  return found
}
