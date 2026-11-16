/**
 * 正文里成对的字面方括号 `[词]`:序列化器加的 `\[` 还原成 `[`(Obsidian 手感对齐 K12h / K13b)。
 *
 * mdast-util-to-markdown 的 unsafe 表对正文里的 `[` 一律转义(`{character: '[', inConstruct: 'phrasing'}`),
 * 于是选中文字敲 `[` 包成的 `[there]`、正文自动成对打出的 `[{x}]` 一经编辑就落成 `\[there]` / `\[{x}]`。
 * Obsidian 原样写 `[there]`。在 CommonMark 里,一对不跟 `(` / `[` / `:`、也对不上任何链接定义的 `[词]` 就是字面,转义纯属多余。
 *
 * ⚠️ 挂在序列化器的 **text handler** 上(textSafe.handleText 的出口),不在整串上做:只有正文 text 节点经过这里 ——
 * 图片说明、HTML(行内 / 块)、代码、链接地址天然碰不到;链接文字(构造栈里有 `label`)跳过。
 * 二审(Codex)实测整串版的三处丢数据:`![a [b] c](/i)` 说明里的 `\]` 被当成闭括号、`<img src="\[a].png">`
 * 属性里的反斜杠被删、HTML 块里的 `\[a]` 被删 —— 都是「串上分不清这个 `\[` 是谁写的」,移到这里就不存在了。
 *
 * 只还原「重新解析仍是同一段字面」的那一种,其余一律保留转义:
 *  · 同一个 text 节点里成对、中间不再有方括号(转义的也不算)与换行,闭括号是未转义的 `]`;
 *    被 mark 拆开的一对(`[**a** b]`)看不全,保留转义;
 *  · `]` 后面不是 `(` `[` `:` `]`、`\`(行内链接 / 引用 / 定义 / 双链 `]]` / 后面接转义);
 *    `[` 前面不是 `!`(图片)、`]`(`[a][b]`)、`[`(双链 `[[`);`[` 落在节点开头时,前一个兄弟的末字必须是
 *    空白或 `* _ ~ \` >`(强调 / 删除线 / 行内代码 / HTML 的收尾)—— 裸链接的尾巴会把紧跟的 `[x]` 吞进地址;
 *  · 里面不以 `^`(脚注)、`!`(callout 令牌,归 unescapeCalloutToken)开头,也不是任务框形状
 *    (空、单个空格 / Tab / `x` / `X`:GFM 认空格与 Tab);
 *  · 节点文字里的裸 URL / 公式不动(maskNonMath + scanMath,与 unescapeMathSource 同一口径;公式里的 `\[`
 *    反正会被 unescapeMathSource 还原,这里不动只是不重复);
 *  · 只在 v4 整篇落盘期间打开(withLiteralBrackets,serializeUnified 包住整个 serializeForSave),且整篇没有
 *    会照原文写回的链接定义(hasRefDefinition)—— 有定义时 `[标签]` 会被读成引用链接;单块 / 剪贴板 / 片段
 *    只是文件的一部分,别处的定义看不见,照旧保留 `\[`。
 * 用户自己写的转义(D-11)是单独的节点(amadeusEscape),不经过这里。
 * 仪器:bracketEscape.test.ts(往返逐字 + 重开结构)、check:rtcorpus、check:obsfeel 的 K12h / K13b。
 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { maskNonMath, scanMath } from './mathLivePreview'
import { pristineRaw } from './refDefinitions'

let enabled = false

/** 在 `run` 期间打开 / 关闭正文方括号还原(同步;嵌套时还原外层状态)。 */
export function withLiteralBrackets<T>(on: boolean, run: () => T): T {
  const prev = enabled
  enabled = on
  try {
    return run()
  } finally {
    enabled = prev
  }
}

/** `\[里面]`:`\[` 前的反斜杠成对(那是字面反斜杠);里面按「`\X` 算一个单位」走,不含方括号(转义的也不行)与换行;
 *  于是闭括号必然是未转义的 `]`。 */
const ESCAPED_PAIR = /(?<!\\)((?:\\\\)*)\\\[((?:[^\\[\]\n]|\\[^[\]\n])*)\]/g
/** 节点开头的 `[`:前一个兄弟输出的末字(info.before)只认这些。 */
const EDGE_BEFORE = /^[\s*_~`>]$/

/** 一个 text 节点的序列化结果里,还原可还原的 `\[词]`。before / after = 节点外的前后文(info.before / info.after,
 *  容器给的可能不止一个字:标题 `# `、加粗 `**`;只看紧邻的那一个。不知道就给空串 → 节点边上的一律保留)。 */
export function unescapeTextBrackets(out: string, before: string, after: string): string {
  if (!out.includes('\\[')) return out
  const prevEdge = before.slice(-1)
  const nextEdge = after.charAt(0)
  const masked = maskNonMath(out)
  const math = out.includes('$') ? scanMath(masked) : []
  return out.replace(ESCAPED_PAIR, (all: string, slashes: string, inner: string, at: number) => {
    const open = at + slashes.length // 转义 `[` 的反斜杠
    const end = at + all.length // `]` 之后
    if (/^[ \txX]?$/.test(inner) || /^[\^!]/.test(inner)) return all
    if (slashes.length === 0) {
      if (at === 0 ? !EDGE_BEFORE.test(prevEdge) : '!][\\'.includes(out[at - 1])) return all
    }
    const next = end < out.length ? out[end] : nextEdge
    if (!next || '([:]'.includes(next)) return all
    if (next === '\\' && (end + 1 >= out.length || out[end + 1] === '[')) return all
    if (masked.slice(open, end) !== out.slice(open, end)) return all // 裸 URL 等
    if (math.some((s) => s.from < end && s.to > open)) return all
    return `${slashes}[${inner}]`
  })
}

/* eslint-disable @typescript-eslint/no-explicit-any -- mdast handler 签名(同 textSafe) */
/** text handler 的出口(textSafe.handleText)。 */
export function literalBracketsInText(out: string, state: any, info: any): string {
  if (!enabled || !out.includes('\\[')) return out
  const stack: string[] = Array.isArray(state?.stack) ? state.stack : []
  if (stack.includes('label') || stack.includes('reference')) return out // 链接文字 / 引用:`]` 是构造自己的
  return unescapeTextBrackets(out, info?.before ?? '', info?.after ?? '')
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 文档里有没有**会照原文写回**的链接定义段落(refDefinitions:没被动过的定义段落按 `raw` 原文落盘;动过的按普通段落
 *  转义写,不再是定义)。逐字回填的块在序列化时只是占位,所以按文档查。 */
export function hasRefDefinition(doc: PMNode): boolean {
  let found = false
  doc.descendants((n) => {
    if (found) return false
    if (typeof n.attrs?.raw === 'string' && pristineRaw(n) != null) found = true
    return !found && !n.isTextblock // 不进行内:定义段落本身就是文本块
  })
  return found
}
