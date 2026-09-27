// I-01(评审 2026-09-27):段落里已有字面 `~x~` / `_x_` 时,每按一次键都删掉远处一个字、吞掉刚输入的字。
//
// 病:preset 的两条行内输入规则没有 `$` 锚 —— gfm 删除线 `/(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/`、
// commonmark 下划线强调 `/\b_(?![_\s])(.*?[^_\s])_\b/`。跑规则的 @milkdown/prose customInputRules.run 用
// `start = from - (match[0].length - text.length)` 推起点,**假定匹配紧贴光标**;匹配其实落在行首附近
// (「今天好累~ 明天继续~」里那对 `~`),起点就算歪了:删掉远处的字、吞掉刚敲的字、后半段变删除线。
// compositionend 还会拿空串再跑一遍,于是每次输入法上屏再删一个字。行内代码里的 `` `_tmp_` `` 同样中招。
//
// 修法(照 paragraphIndent 的原位替换写法,commonmark 与 gfm 两处都换):
//  ① 两条无锚规则换成带 `$` 锚、内容首尾非空白、且**内容不含定界符本身**的版本(加锚后正则是最左匹配,
//     内容能含定界符的话 `a _b_ c _d_` 会从第一个 `_` 一路吃到行尾)。
//  ② 所有 mark 输入规则(`*` / `**` / `_` / `` ` `` / `~`)外面再包一层:匹配终点不贴着光标就放弃(返回 null,
//     run 接着试下一条)—— run 的起点公式只在这个前提下成立,以后谁再加一条无锚规则也不会删远处的字。
// `*` / `**` / 行内代码的正则与 preset 逐字相同(本来就有 `$`),只多包一层。
// 仪器:anchoredMarkRules.test.ts(真 Milkdown + 真 customInputRules);npm run check:attention 的 I1~I4(键盘 + CDP 输入法)。
import { markRule } from '@milkdown/kit/prose'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'
import {
  emphasisSchema, emphasisStarInputRule, emphasisUnderscoreInputRule, inlineCodeInputRule, inlineCodeSchema,
  strongInputRule, strongSchema,
} from '@milkdown/kit/preset/commonmark'
import { gfm, strikethroughInputRule, strikethroughSchema } from '@milkdown/kit/preset/gfm'

type Handler = (state: EditorState, match: RegExpMatchArray, start: number, end: number) => Transaction | null

/** 匹配终点必须就是光标(textBefore 的末尾),否则这条规则本次不适用。 */
export function endsAtCursor(rule: InputRule): InputRule {
  const r = rule as unknown as { match: RegExp; handler: Handler; undoable: boolean; inCode: boolean | 'only'; inCodeMark: boolean | 'only' }
  return new InputRule(
    r.match,
    (state, match, start, end) =>
      typeof match.index === 'number' && typeof match.input === 'string' && match.index + match[0].length === match.input.length
        ? r.handler(state, match, start, end)
        : null,
    { undoable: r.undoable, inCode: r.inCode, inCodeMark: r.inCodeMark as boolean },
  )
}

// ── commonmark:四条 mark 规则(正则除下划线那条外与 preset 逐字相同)──
const emphasisStar = $inputRule((ctx) => endsAtCursor(markRule(/(?:^|[^*])\*([^*]+)\*$/, emphasisSchema.type(ctx), {
  getAttr: () => ({ marker: '*' }),
  updateCaptured: ({ fullMatch, start }) => (!fullMatch.startsWith('*') ? { fullMatch: fullMatch.slice(1), start: start + 1 } : {}),
})))
/** 下划线强调:加 `$` 锚;内容首尾非空白、不含 `_`。 */
export const UNDERSCORE_EMPHASIS_RE = /\b_(?![_\s])([^_]*[^_\s])_$/
const emphasisUnderscore = $inputRule((ctx) => endsAtCursor(markRule(UNDERSCORE_EMPHASIS_RE, emphasisSchema.type(ctx), {
  getAttr: () => ({ marker: '_' }),
  updateCaptured: ({ fullMatch, start }) => (!fullMatch.startsWith('_') ? { fullMatch: fullMatch.slice(1), start: start + 1 } : {}),
})))
const inlineCode = $inputRule((ctx) => endsAtCursor(markRule(/(?:`)([^`]+)(?:`)$/, inlineCodeSchema.type(ctx))))
const strong = $inputRule((ctx) => endsAtCursor(markRule(/(?<![\w:/])(?:\*\*|__)([^*_]+?)(?:\*\*|__)(?![\w/])$/, strongSchema.type(ctx), {
  getAttr: (match) => ({ marker: match[0].startsWith('*') ? '*' : '_' }),
})))

// ── gfm:删除线 ──
/** 删除线:加 `$` 锚;开定界符前不是字母数字 / `:` `/` / `~`;内容首尾非空白、不含 `~`。 */
export const STRIKETHROUGH_RE = /(?<![\w:/~])(~{1,2})([^\s~](?:[^~]*[^\s~])?)\1$/
const strikethrough = $inputRule((ctx) => endsAtCursor(markRule(STRIKETHROUGH_RE, strikethroughSchema.type(ctx))))

/** commonmark preset 数组里的原位替换表(paragraphIndent 的 commonmarkWithIndent 用)。 */
export const commonmarkMarkRuleReplacements = new Map<unknown, unknown>([
  [emphasisStarInputRule, emphasisStar],
  [emphasisUnderscoreInputRule, emphasisUnderscore],
  [inlineCodeInputRule, inlineCode],
  [strongInputRule, strong],
])

/** gfm preset 的原位替换版:删除线输入规则换成带锚的。MarkdownBlock 里 `.use(gfmWithAnchoredRules)` 代替 `.use(gfm)`。 */
export const gfmWithAnchoredRules = gfm.map((p) => ((p as unknown) === (strikethroughInputRule as unknown) ? strikethrough : p))
