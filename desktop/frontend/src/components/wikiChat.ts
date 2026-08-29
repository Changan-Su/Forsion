// 聊天消息里的 [[双链]]:纯文本切分 + remark 插件(assistant 的 Markdown 与 user 纯文本气泡共用)。
// 消息契约(Composer [[ 选笔记时插入):`[[<vault 绝对路径>|<笔记名>]]` —— 气泡显示笔记名,agent 读到路径。
// 本模块保持纯净(只依赖 links.ts),解析/打开等副作用在 ChatWikiLink.tsx。
import { WIKILINK_RE, linkTarget } from '@amadeus-shared/links'

export interface WikiPiece {
  /** 原文片段(双链片段 = 含 [[ ]] 的原文)。 */
  text: string
  wiki?: { inner: string; label: string; target: string }
}

/** [[Name|alias]] → alias;[[Name#h]] / [[Name]] → 原样内文(与编辑器 wikilink.ts 同规则)。 */
export function wikiLabel(inner: string): string {
  const bar = inner.indexOf('|')
  const l = (bar === -1 ? inner : inner.slice(bar + 1)).trim()
  return l || inner.trim()
}

/** PDF 引用的**单层方括号**兜底:`[…/书.pdf#page=32]`。
 *  模型被要求写 `[[路径#page=N]]`,但库外文件的锚点是两百来字符的绝对路径、一段答案里还要重复好几次,
 *  实测(gpt-5.6-luna,08-27)会写丢一层括号 —— 那形态在 markdown 里就是一段普通文本,引用条直接消失。
 *  形态足够特征(必须以 `.pdf#page=<数字>` 收尾)才认,不会把寻常的 `[某某]` 误当引用。 */
const PDF_CITE_RE = /\[([^[\]\n]*\.pdf#page=\d+[^[\]\n]*)\]/gi

/** 行号引用的单层方括号兜底,同 PDF 那条的教训(锚点是长绝对路径,模型会写丢一层括号)。
 *  形态要求「扩展名 + #L<数字>」连写才认 —— 寻常散文里的 `[见 #L42]`、脚注 `[1]` 都不带
 *  扩展名紧贴 `#L`。行号之后只许 `|别名` 或直接收括号:放任尾随文本会把
 *  `[src/app.ts#L42 详见下文]` 这种正常散文整个吞成一条解析必败的灰链(Codex 一审)。 */
const LINE_CITE_RE = /\[([^[\]\n]*\.[A-Za-z0-9]{1,10}#L\d+(?:-L?\d+)?(?:\|[^[\]\n]*)?)\]/gi

/** 单括号行号引用的**路径头**校验(Codex 二审):`[see src/app.ts#L42]` 的前导散文也会被
 *  正则吞进 target,解析必败还吃掉原括号。判据:首个路径分隔符之前不许有空格 ——
 *  绝对路径(`/Users/x/My Docs/a.ts`)首字符就是分隔符,天然不受影响;误杀面只剩
 *  「首段目录名带空格的相对路径 + 手写单括号」这种影子形态。 */
function lineCiteHeadOk(inner: string): boolean {
  const target = inner.slice(0, inner.indexOf('#')) // LINE_CITE_RE 保证有 '#'
  const cut = target.search(/[/\\]/)
  const head = cut >= 0 ? target.slice(0, cut) : target // 裸文件名(无分隔符)整段都是头
  return !head.includes(' ')
}

/** 把一段纯文本按 [[..]](以及 PDF/行号引用的单括号兜底)切开;都没有 → 单段原文。
 *  三条形态并成一条正则:同一位置上双括号的分支排在前,`[[x]]` 不会被兜底那条抢去半截。 */
export function splitWiki(text: string): WikiPiece[] {
  if (text.indexOf('[') === -1) return [{ text }]
  // 全局正则防共享 lastIndex(与 parseWikiLinks 同款防御)
  const re = new RegExp(`${WIKILINK_RE.source}|${PDF_CITE_RE.source}|${LINE_CITE_RE.source}`, 'gi')
  const out: WikiPiece[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    // 单括号行号分支(m[3])多一道路径头校验:前导散文形态按普通文本放行,不吞括号
    if (m[3] !== undefined && !lineCiteHeadOk(m[3])) continue
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    const inner = m[1] ?? m[2] ?? m[3]
    out.push({ text: m[0], wiki: { inner, label: wikiLabel(inner), target: linkTarget(inner) } })
    last = m.index + m[0].length
  }
  if (last < text.length || !out.length) out.push({ text: text.slice(last) })
  return out
}

/** Composer [[ 选中笔记时插入的文本:`[[<vault 绝对路径>|<名字>]] ` —— splitWiki 的逆向契约。 */
export function noteRefInsert(vaultRoot: string, pagePath: string): string {
  const base = pagePath.split('/').pop()!.replace(/\.md$/i, '')
  return `[[${vaultRoot}/${pagePath}|${base}]] `
}

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/** remark 插件:text 节点里的 [[x]] → link(url=`#wiki=<inner>`),由 Markdown.tsx 的 a 组件拦截渲染。
 *  code/inlineCode/math 是独立节点类型天然不碰;link 内部不递归(双链不嵌进已有链接)。 */
export function remarkWiki() {
  const SKIP = new Set(['code', 'inlineCode', 'link', 'linkReference', 'math', 'inlineMath'])
  const walk = (node: MdNode): void => {
    const kids = node.children
    if (!kids) return
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]
      if (SKIP.has(k.type)) continue
      if (k.type !== 'text' || !k.value || k.value.indexOf('[') === -1) {
        walk(k)
        continue
      }
      const pieces = splitWiki(k.value)
      if (pieces.length === 1 && !pieces[0].wiki) continue
      const repl: MdNode[] = pieces.map((p) =>
        p.wiki
          ? { type: 'link', url: '#wiki=' + encodeURIComponent(p.wiki.inner), children: [{ type: 'text', value: p.wiki.label }] }
          : { type: 'text', value: p.text },
      )
      kids.splice(i, 1, ...repl)
      i += repl.length - 1
    }
  }
  return (tree: MdNode) => walk(tree)
}
