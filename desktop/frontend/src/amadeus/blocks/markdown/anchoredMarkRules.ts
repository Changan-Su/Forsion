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
// `*` / 行内代码的正则与 preset 逐字相同(本来就有 `$`),只多包一层;`**` / `__` 的后顾分开收(I-18,见 STRONG_RE)。
// 仪器:anchoredMarkRules.test.ts(真 Milkdown + 真 customInputRules);npm run check:attention 的 I1~I4(键盘 + CDP 输入法)。
import { markRule } from '@milkdown/kit/prose'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { $inputRule, $remark } from '@milkdown/kit/utils'
import {
  emphasisSchema, emphasisStarInputRule, emphasisUnderscoreInputRule, inlineCodeInputRule, inlineCodeSchema,
  strongInputRule, strongSchema,
} from '@milkdown/kit/preset/commonmark'
import { gfm, remarkGFMPlugin, strikethroughInputRule, strikethroughSchema } from '@milkdown/kit/preset/gfm'

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
/** 加粗(I-18):preset 那条 `(?<![\w:/])` 对 `**` 与 `__` 一视同仁 → `API**注意**`、`v2**重要**` 不触发,落盘成 `\*\*`。
 *  按 CommonMark / Obsidian:词内的 `**` 本来就成立,只排除 `:` `/`(`https://**` 这类);词内的 `__` 按规范是字面,保持原样。
 *  两种开定界符各带各的后顾,再用前瞻钉住「收尾定界符与开头同种」(preset 那条 `**x__` 也认,顺手堵上);
 *  仍是**一条**规则、一个捕获组 —— markRule 取最后一个捕获组当正文,commonmark 的原位替换表也保持一换一。
 *  落盘两侧的开合由 attentionFlanking 的边界编码兜(check:cjk;`API**「注意」**后` 这类见 anchoredMarkRules.test)。 */
export const STRONG_RE = /(?:(?<![:/])\*\*(?=[^*_]+?\*\*$)|(?<![\w:/])__(?=[^*_]+?__$))([^*_]+?)(?:\*\*|__)$/
const strong = $inputRule((ctx) => endsAtCursor(markRule(STRONG_RE, strongSchema.type(ctx), {
  getAttr: (match) => ({ marker: match[0].startsWith('*') ? '*' : '_' }),
})))

// ── gfm:删除线 ──
/** 删除线:加 `$` 锚;开定界符前不是字母数字 / `:` `/` / `~`;内容首尾非空白、不含 `~`。
 *  **只认 `~~`**(I-03,用户拍板 #1):单个 `~` 不是删除线,同 Obsidian —— 与下面解析 / 落盘两侧同口径。 */
export const STRIKETHROUGH_RE = /(?<![\w:/~])(~~)([^\s~](?:[^~]*[^\s~])?)~~$/
const strikethrough = $inputRule((ctx) => endsAtCursor(markRule(STRIKETHROUGH_RE, strikethroughSchema.type(ctx))))

// ── I-03:单个 `~` 不算删除线(`3~5小时，持续2~3周` 打开就被划线,编辑一处落盘成 `3~~5`)──
// 三层同口径,缺一层都不成立:① 输入规则只认 `~~`(上面);② 解析:remark-gfm 与 CJK 友好删除线扩展(cjkFriendly.ts)
// 都设 singleTilde:false —— micromark 里后者返回 nok 会落到前者,两个都得关;③ 落盘:mdast-util-gfm-strikethrough 的
// unsafe 对 phrasing 里**每个** `~` 都转义(不然 `3~5` 存成 `3\~5`),收窄成「紧挨另一个 `~` 才转义」——
// 单个 `~` 不再能开删除线,只有凑成 `~~` 才危险(`a\~\~b`、贴着 `~~删~~` 的 `a\~` 照旧转义)。
// ⚠️ 收窄写成**一条**非吞字的 after 条件 `(?=~)|(?<=~~)`(后面是 `~`,或自己与前一个都是 `~`):拆成 before/after
//    两条的话,连串中间那个会被两条同时命中、升格成「无条件转义」,safe() 随即把它两边的条件转义省掉 —— `\~\~\~`
//    落成 `~\~~`(语义等价但改写了存量字面)。一条就是「连串里每个都转义」,与修前逐字相同。
/** remark-gfm 的选项:原位替换 preset 里 remarkGFMPlugin 的选项 ctx(同一把 key,插件读到的就是它)。 */
const gfmOptionsNoSingleTilde: MilkdownPlugin = (ctx) => {
  ctx.inject(remarkGFMPlugin.options.key, { singleTilde: false })
  return () => () => {
    ctx.remove(remarkGFMPlugin.options.key)
  }
}
/* eslint-disable @typescript-eslint/no-explicit-any */
/** 收窄 gfm 删除线扩展的 `~` unsafe。mdast-util-to-markdown 把各处 unsafe **拼接**,经 remarkStringifyOptionsCtx 删不掉,
 *  只能在 remark-gfm 挂上之后原地改它推进 toMarkdownExtensions 的那份(每个 processor 各自一份新对象)。 */
export function remarkStrictTildeUnsafe(this: any): void {
  const walk = (ext: any): void => {
    if (!ext || typeof ext !== 'object') return
    if (Array.isArray(ext.extensions)) ext.extensions.forEach(walk)
    if (!ext.handlers?.delete || !Array.isArray(ext.unsafe)) return
    ext.unsafe = ext.unsafe.map((u: any) =>
      u.character === '~' && !('before' in u) && !('after' in u) && !u.atBreak ? { ...u, after: '(?=~)|(?<=~~)' } : u)
  }
  for (const ext of (this.data().toMarkdownExtensions ?? []) as unknown[]) walk(ext)
}
/* eslint-enable @typescript-eslint/no-explicit-any */
const strictTildeUnsafe = $remark('amadeusStrictTildeUnsafe', () => remarkStrictTildeUnsafe)

/** commonmark preset 数组里的原位替换表(paragraphIndent 的 commonmarkWithIndent 用)。 */
export const commonmarkMarkRuleReplacements = new Map<unknown, unknown>([
  [emphasisStarInputRule, emphasisStar],
  [emphasisUnderscoreInputRule, emphasisUnderscore],
  [inlineCodeInputRule, inlineCode],
  [strongInputRule, strong],
])

/** gfm preset 的原位替换版:删除线输入规则换成带锚的;remark-gfm 关掉单波浪线、紧跟着收窄 `~` 的落盘转义(I-03)。
 *  MarkdownBlock 里 `.use(gfmWithAnchoredRules)` 代替 `.use(gfm)`。 */
export const gfmWithAnchoredRules = gfm.flatMap((p): MilkdownPlugin[] =>
  (p as unknown) === (strikethroughInputRule as unknown) ? [strikethrough as unknown as MilkdownPlugin]
  : (p as unknown) === (remarkGFMPlugin.options as unknown) ? [gfmOptionsNoSingleTilde]
  : (p as unknown) === (remarkGFMPlugin.plugin as unknown) ? [p, ...strictTildeUnsafe]
  : [p])
