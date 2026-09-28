// 手打裸 URL 成链接(I-13,评审 2026-09-27)—— 输入规则 + 落盘形态两半,缺一半都不算修好。
//
// ① 输入规则:原先只有 `[文字](地址)` 一条(linkHref.ts),逐字键入的 `https://…` 一直是纯文本,点了没反应
//    (粘贴的会成链接,重开后 gfm autolink-literal 也会)。Notion 键入 URL 后按空格即成链接。
//    · 只认 `https?://`,不认 `www.`:gfm 给 `www.x` 的 href 是 `http://www.x` ≠ 文字,序列化成 `[www.x](http://www.x)`,平白改字节。
//    · 触发字符 = 空格(含 NBSP / 全角空格)+ 全角标点,不含回车。**ASCII 标点一律不触发** —— `.` `,` `?` `:` `;` `)` 都会出现在 URL 中间,
//      打到 `https://example.` 那一刻还不知道后面有没有 `com`。
//    · 触发前把 gfm 的尾随标点(`.,:;!?"'*_~` 与不配对的 `)`)剥在链接外 —— 与重开时 gfm 认出的边界一致。
//    · 前一个字是 ASCII 字母时不触发(gfm 同款:`abchttps://x` 不是链接)。代码块 / 行内代码 / 已有链接里不触发,
//      未闭合的反引号之后也不触发(那是还没闭合的行内代码);紧跟在 `](`、`[[`、`<` 后面的是用户在手写别的语法,不插手。
// ② 落盘:mdast 对「文字 === 地址」的链接一律写 `<url>`(formatLinkAsAutolink)。原先只有**整行** `<url>` 由
//    normalizeUrlLiterals 剥回裸 URL(书签卡的字面),句中的 `<url>` 是记在案的取舍(评审附录 A I-16/D-18)。
//    现在手打的句中链接成了常态,这条取舍不能再留:link handler 在「裸写之后重新解析还是**同一个**链接」时直接写裸 URL,
//    否则回落上游(`<url>`)。判等价不猜规则,直接用编辑器同一套 remark-parse + gfm 解析「前一字 + URL + 后文直到空白」:
//    `https://x.com。后` 会把 `。后` 吞进 URL(实测)、`abchttps://x` 不成链、`url.` + `**b**` 会接成 `url.**b` ——
//    这些一律 `<url>`,语义不走样;空格、行尾、句末 ASCII 标点后的照常裸写。
// ⚠️ handler 必须挂 `remarkStringifyOptionsCtx.handlers`(同 attentionFlanking.ts 顶注:options 那份恒压过 extensions)。
// 仪器:check:rtcorpus 的 bare_url 组(句中裸 URL 逐字 / 全角标点后落 `<url>`)、check:linkcard 的 AU 组(键入成链 / 书签卡不抢跑)。
import { $inputRule } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { config, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { defaultHandlers } from 'mdast-util-to-markdown'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { normalizeHref } from './linkHref'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

/** 全角标点:URL 里不会出现,出现即 URL 收尾。
 *  ⚠️ 触发字符不含 `\n`:Milkdown 的输入规则插件在**回车**时也会拿 `\n` 跑一遍规则 —— 认了它,回车就被吞成
 *  一个字面换行、段落拆不开(台架实测)。回车收尾的 URL 留给重开时的 gfm。 */
const CJK_PUNCT = '，。；：！？、）」』】》'
const TRIGGER_RE = new RegExp(`(?<![A-Za-z])(https?:\\/\\/[^\\s<>\\ufffc${CJK_PUNCT}（「『【《]+)([ \\t\\u00a0\\u3000${CJK_PUNCT}])$`, 'i')

/** 剥掉 gfm 当尾随标点的字符;不配对的 `)` 一并剥(gfm 同款:`(见 https://x.com/a)` 的 `)` 不算 URL)。 */
export function trimUrlTrail(url: string): string {
  let u = url
  for (;;) {
    const last = u[u.length - 1]
    if (/[.,:;!?"'*_~]/.test(last)) { u = u.slice(0, -1); continue }
    if (last === ')' && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) { u = u.slice(0, -1); continue }
    return u
  }
}

export const autolinkInputRule = $inputRule(
  () =>
    new InputRule(TRIGGER_RE, (state, match, start, end) => {
      const link = state.schema.marks.link
      if (!link) return null
      const url = trimUrlTrail(match[1])
      if (!/^https?:\/\/[^/?#\s]/i.test(url)) return null
      const $start = state.doc.resolve(start)
      if ($start.parent.type.spec.code) return null
      const lead = $start.parent.textBetween(0, $start.parentOffset, undefined, '\ufffc')
      if (/(?:\]\(|\[\[|<)$/.test(lead)) return null
      // 段内此前有未闭合的反引号 = 正在写行内代码(闭合那一下才由 code 输入规则转成 code mark),不插手。
      if (((lead.match(/`/g)?.length ?? 0) % 2) === 1) return null
      const to = start + url.length
      if (state.doc.textBetween(start, to) !== url) return null
      if (state.doc.rangeHasMark(start, to, link)) return null
      let coded = false
      state.doc.nodesBetween(start, to, (n) => {
        if (n.isText && n.marks.some((m) => m.type.spec.code || m.type.name === 'inlineCode' || m.type.name === 'code')) coded = true
      })
      if (coded) return null
      const href = normalizeHref(url)
      if (!href) return null
      // 触发字照常落下(规则返回事务 = 默认插入被接管);link 是 inclusive:false,落在链接之外。removeStoredMark 同 linkInputRule。
      return state.tr.addMark(start, to, link.create({ href })).insertText(match[2], end).removeStoredMark(link)
    }),
)

// ── 落盘:句中「文字 === 地址」的链接写裸 URL ──────────────────────────────────────────────

let gfmParser: { parse: (s: string) => unknown } | null = null
/** `before + url + after` 用编辑器同一套 remark-parse + gfm 解析:第一个链接从 before 之后起、地址与文字都恰好是 url 才算等价。 */
export function bareUrlRoundTrips(url: string, before: string, after: string): boolean {
  gfmParser ??= unified().use(remarkParse).use(remarkGfm)
  let tree: MdNode
  try { tree = gfmParser.parse(before + url + after) } catch { return false }
  let hit: MdNode = null
  const walk = (n: MdNode): void => {
    if (hit || !n) return
    if (n.type === 'link') { hit = n; return }
    for (const k of Array.isArray(n.children) ? n.children : []) walk(k)
  }
  walk(tree)
  return !!hit && hit.position?.start?.offset === before.length && hit.url === url &&
    hit.children?.length === 1 && hit.children[0].type === 'text' && hit.children[0].value === url
}

const PEEK_INFO = { before: '', after: '', now: { line: 1, column: 1 }, lineShift: 0 }
/** 链接之后实际会写出的文字,直到第一个空白(或兄弟写完 → 退到容器给的 info.after)。 */
function followingOutput(node: MdNode, parent: MdNode, state: any, info: any): string {
  const kids: MdNode[] = Array.isArray(parent?.children) ? parent.children : []
  let i = kids.indexOf(node)
  let out = ''
  while (i >= 0 && i + 1 < kids.length && !/\s/.test(out) && out.length < 256) {
    i++
    out += String(state.handle(kids[i], parent, state, PEEK_INFO))
  }
  if (!/\s/.test(out) && (i < 0 || i + 1 >= kids.length)) out += info?.after ?? ''
  return out
}

/** 能不能裸写:无 title、单个 text 子、文字 === 地址、http(s)、且裸写后重解析仍是这一个链接。 */
function bareForm(node: MdNode, parent: MdNode, state: any, info: any): string | null {
  const url = node?.url
  if (typeof url !== 'string' || node.title || !/^https?:\/\//i.test(url)) return null
  const kids = node.children
  if (!Array.isArray(kids) || kids.length !== 1 || kids[0]?.type !== 'text' || kids[0].value !== url) return null
  return bareUrlRoundTrips(url, info?.before ?? '', followingOutput(node, parent, state, info)) ? url : null
}

const upstreamLink = defaultHandlers.link as any
function linkHandler(node: MdNode, parent: MdNode, state: any, info: any): string {
  const bare = bareForm(node, parent, state, info)
  if (bare == null) return upstreamLink(node, parent, state, info)
  return state.createTracker(info).move(bare)
}
// containerPhrasing 用 peek 算前一个兄弟的 `after`(决定它尾巴要不要转义):裸写时首字是 `h`,不是 `<` / `[`。
linkHandler.peek = (node: MdNode, parent: MdNode, state: any, info: any): string =>
  bareForm(node, parent, state, info) != null ? 'h' : upstreamLink.peek(node, parent, state, info)

/** 挂进编辑器:`.use(autolinkSerializer)`。 */
export const autolinkSerializer = config((ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (o: any) => ({ ...o, handlers: { ...o.handlers, link: linkHandler } }))
})
/* eslint-enable @typescript-eslint/no-explicit-any */
