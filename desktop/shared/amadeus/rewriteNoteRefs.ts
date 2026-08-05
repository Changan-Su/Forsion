/** 笔记改名/移动后的引用重写(纯函数,主进程 propagateRenames 用,可测;与 db/rewriteDbRefs 同一先例)。
 *
 *  规则:对每处 `[[..]]` / `![[..]]`,取其笔记名部分,用 resolvePageName 在「操作前」的页面表上
 *  解析 —— 解析到的目标经 pairs 映射后,若「操作后」的解析结果已不等于它,就把笔记名改写成
 *  仍指向原目标的最小形态(裸名优先;裸名歧义或原文本就是路径限定 → 全路径)。
 *  这一条同时覆盖:改名(旧名解析不到了)、移动(路径限定断了)、以及**遮蔽**(移进来的同名
 *  文件靠「同文件夹优先」抢走了别人的裸名链接 —— 此时被抢的链接补路径限定)。
 *
 *  已知缺口(v1,如实记录):md 风格 `[名](x.md)` 链接、`[[x.excalidraw]]`/`[[x.pdf]]` 等
 *  文件引用(走 resolveFileName,不在 pages 表)不重写;行内代码里的 `[[..]]` 会被误改
 *  (围栏代码块已跳过,与 unescapeWikiOutsideFences 同款取舍)。
 */
import { resolvePageName } from './links'

export interface NoteRenamePlan {
  /** 旧页面路径 → 新页面路径(vault 相对、POSIX 分隔、含 .md)。文件夹操作 = 树下每页一对。 */
  pairs: ReadonlyMap<string, string>
  /** 操作前的全量页面表,已排序(resolvePageName 的并列序靠它确定)。 */
  pagesBefore: readonly string[]
  /** 操作后的全量页面表,已排序。 */
  pagesAfter: readonly string[]
}

/** inner 拆成笔记名 + 尾巴:笔记名止于第一个 `#` 或 `|`(与 linkTarget 的语义一致)。 */
const splitInner = (inner: string): { note: string; suffix: string } => {
  const cut = inner.search(/[#|]/)
  return cut < 0 ? { note: inner, suffix: '' } : { note: inner.slice(0, cut), suffix: inner.slice(cut) }
}

const baseNameNoMd = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

export function rewriteNoteRefs(source: string, srcBefore: string, srcAfter: string, plan: NoteRenamePlan): string {
  if (!source.includes('[[')) return source
  const before = plan.pagesBefore as string[]
  const after = plan.pagesAfter as string[]
  const lines = source.split('\n')
  // 围栏须记「字符 + 开栏长度」:闭栏必须同字符且 ≥ 开栏长度(CommonMark)——
  // 否则 ```` 四反引号块里的 ``` 行会被当闭栏,块内 [[链接]] 被误改(Codex 评审 P1)。
  let fence: { mark: '`' | '~'; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (fm) {
      const mark = fm[1][0] as '`' | '~'
      if (!fence) fence = { mark, len: fm[1].length }
      else if (mark === fence.mark && fm[1].length >= fence.len) fence = null
      continue
    }
    if (fence) continue
    lines[i] = lines[i].replace(/(!?)\[\[([^\]\n]+)\]\]/g, (m, bang: string, inner: string) => {
      const { note, suffix } = splitInner(inner)
      const name = note.trim()
      if (!name) return m // [[#锚]] / ![[#块]]:本页内引用,无笔记名
      const was = resolvePageName(name, before, srcBefore)
      if (!was) return m // 本来就是断链(或指向文件/画板):不接手,断的保持断
      const want = plan.pairs.get(was) ?? was
      if (resolvePageName(name, after, srcAfter) === want) return m // 现名仍准确(如裸名跨移动自愈)
      const bare = baseNameNoMd(want)
      const keepPath = /[\\/]/.test(name) // 原文是路径限定 → 保持路径限定,不替用户降级成裸名
      const target =
        !keepPath && resolvePageName(bare, after, srcAfter) === want ? bare : want.replace(/\.md$/i, '')
      return `${bang}[[${target}${suffix}]]`
    })
  }
  return lines.join('\n')
}
