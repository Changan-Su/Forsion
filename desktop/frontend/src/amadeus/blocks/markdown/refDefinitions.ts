// D-12(评审 2026-09-27):链接定义行、形如 `[标签]: 值` 的中文行,打开时看不见,编辑任意一处就从磁盘上删掉。
//
// 病:commonmark preset 的 remark-inline-links 删掉**所有** definition 节点(schema 里没有 definition),
// 并把 `[a][1]` 改写成行内链接。`[重要]: 明天开会`、`[TODO]: 回复邮件` 在 CommonMark 里就是合法的链接定义
// —— 用户写的是笔记,编辑器当成元数据吃掉了;没被引用的书签定义连 URL 一起丢。
//
// 修法(逐字往返优先;commonmarkWithIndent 里原位插在 remark-inline-links **之前**,它随后无事可做):
//  · 定义 → 可见、可编辑的**字面段落**:正文 = 原文切片,原文另记在段落的 `raw` attr。落盘时段落没被动过
//    (无 mark、无缩进/对齐、正文 === 原文)就原样写回原文;动过就按普通段落写(`\[…]` 转义,仍是那行字,不再是定义)。
//    相邻行的多个定义合成**一个**段落(否则落盘时段落之间插空行);合成段落带 position,blankLineRemark 靠它算空行。
//  · `[text][label]` / `[text][]` / `[text]` → link mark 带 `ref`(引用形 + label + 当时的 url + 定义原文首行),照常渲染成链接;
//    落盘时写回引用形**当且仅当**:url 没改(链接卡没改地址)、且**正在序列化的这份文档**里还有一个没被动过的定义段落,
//    该 label 的首个定义就是当初那一行(CommonMark 首个定义生效)。否则退成行内链接 —— 引用形离开定义就是一串
//    字面 `[a][1]`,URL 从文件里消失(评审返修 D-12-orphan-ref:跨笔记粘贴、删掉定义行、结构化复制给外部应用、
//    改了定义行,四条路都会把引用变孤儿)。collapsed / shortcut 的文字被改,mdast-util-to-markdown 自己会退成 full 形。
//    「正在序列化的文档」由 doc 节点的序列化器在进出时登记(docWithRefScope)—— 剪贴板 / 切块序列化的是切片文档,
//    不能拿编辑器里那份 state.doc 判断。
//  · `![alt][label]` 仍按 preset 转成行内图片(取舍:图片引用罕见,逐字要再扩 image schema,不值当)。
// ⚠️ 不能直接从 preset 里摘掉 remark-inline-links:剩下的 definition / linkReference 没有 schema → parserMatchError 白屏。
//    所以这里**自己**建定义表、同一趟把引用也处理掉 —— 只转定义不转引用,它开头 definitions(tree) 找不到定义,引用原样留下,一样白屏。
// 仪器:npm run check:rtcorpus(d12.* / entry.*)、refDefinitions.test.ts。
import { $remark } from '@milkdown/kit/utils'
import { nodesCtx } from '@milkdown/kit/core'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { docSchema, linkAttr, linkSchema } from '@milkdown/kit/preset/commonmark'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

// mdast 是动态形状的 AST,这层统一按 any 处理(同 softBreak.ts / marks.ts)。
/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

/** link mark 的 `ref` attr:它是从哪种引用形解析来的。 */
export interface LinkRef {
  referenceType: 'full' | 'collapsed' | 'shortcut'
  /** 原文里的 label(`[a][Label]` 的 `Label`;collapsed / shortcut 就是链接文字本身)。 */
  label: string
  /** 解析当时定义给的地址:落盘时 href 仍是它 → 写回引用形。 */
  url: string
  /** 当初那条定义的原文首行(`[1]: http://x "T"`):落盘时文档里该 label 的首个定义仍以它开头,才写回引用形。
   *  可选:旧剪贴板里的 data-md-ref 没有它,那时只按 label 判断。 */
  def?: string
}

/** 同 mdast-util-definitions:按大写后的 identifier 匹配,CommonMark 首个优先。 */
const clean = (v: unknown): string => String(v ?? '').toUpperCase()

/** 原文里的一段(容器里的多行定义:续行按起始列剥掉 `> ` / 列表缩进前缀)。 */
function sliceOf(def: MdNode, source: string): string | null {
  const s = def?.position?.start, e = def?.position?.end
  if (typeof s?.offset !== 'number' || typeof e?.offset !== 'number') return null
  const raw = source.slice(s.offset, e.offset)
  if (s.column <= 1 || !raw.includes('\n')) return raw
  const strip = new RegExp(`^[ \\t>]{0,${s.column - 1}}`)
  return raw.split('\n').map((l, i) => (i ? l.replace(strip, '') : l)).join('\n')
}

/** 没有位置信息时按字段重拼(纯防御,remark 解析出来的恒有 position)。 */
const rebuild = (def: MdNode): string =>
  `[${def.label ?? def.identifier}]: ${def.url}${def.title ? ` "${def.title}"` : ''}`

function literalParagraph(defs: MdNode[], parent: MdNode, source: string): MdNode {
  const start = defs[0].position?.start
  const end = defs[defs.length - 1].position?.end
  let raw: string
  if (parent?.type === 'root' && typeof start?.offset === 'number' && typeof end?.offset === 'number') {
    // 根一层:从首个定义到末个定义连续切(行首 ≤3 空格的缩进也算原文)。
    let from = start.offset
    while (from > 0 && (source[from - 1] === ' ' || source[from - 1] === '\t')) from--
    if (from > 0 && source[from - 1] !== '\n') from = start.offset
    raw = source.slice(from, end.offset)
  } else {
    raw = defs.map((d) => sliceOf(d, source) ?? rebuild(d)).join('\n')
  }
  raw = raw.replace(/\r\n?/g, '\n')
  // 一行一个定义:行间用硬换行(渲染成 `<br>`)—— 软换行在笔记里按 CommonMark 渲染成空格,几条定义会挤成一行。
  const children: MdNode[] = []
  raw.split('\n').forEach((line, i) => {
    if (i) children.push({ type: 'break' })
    if (line) children.push({ type: 'text', value: line })
  })
  return {
    type: 'paragraph',
    children,
    data: { amadeusRaw: raw },
    ...(start && end ? { position: { start, end } } : {}),
  }
}

/** 就地改树:定义 → 字面段落,引用 → 带 ref 的 link / 行内图片(导出供单测)。 */
export function literalizeReferences(tree: MdNode, source: string): void {
  const defs = new Map<string, MdNode>()
  const collect = (n: MdNode): void => {
    if (n?.type === 'definition') {
      const id = clean(n.identifier)
      if (id && !defs.has(id)) defs.set(id, n)
    }
    for (const c of n?.children ?? []) collect(c)
  }
  collect(tree)

  const walk = (node: MdNode): void => {
    const kids: MdNode[] | undefined = node?.children
    if (!Array.isArray(kids)) return
    const out: MdNode[] = []
    let group: MdNode[] = []
    const flush = (): void => {
      if (group.length) out.push(literalParagraph(group, node, source))
      group = []
    }
    for (const k of kids) {
      if (k?.type === 'definition') {
        const prev = group[group.length - 1]
        // 紧挨着的下一行才并组;隔了空行 = 两个段落(落盘时段落间本来就是一个空行)。
        if (prev && k.position?.start?.line !== (prev.position?.end?.line ?? -2) + 1) flush()
        group.push(k)
        continue
      }
      flush()
      if (k?.type === 'linkReference') {
        const def = defs.get(clean(k.identifier))
        if (!def) { const tmp = { children: k.children ?? [] }; walk(tmp); out.push(...tmp.children); continue } // 防御:micromark 只给有定义的 label 出引用
        const defLine = (sliceOf(def, source) ?? rebuild(def)).split('\n')[0].trimStart()
        const ref: LinkRef = { referenceType: k.referenceType, label: String(k.label ?? k.identifier), url: def.url, def: defLine }
        const link = { type: 'link', url: def.url, title: def.title ?? null, children: k.children ?? [], position: k.position, data: { amadeusRef: ref } }
        walk(link)
        out.push(link)
        continue
      }
      if (k?.type === 'imageReference') {
        const def = defs.get(clean(k.identifier))
        out.push(def ? { type: 'image', url: def.url, title: def.title ?? null, alt: k.alt, position: k.position } : { type: 'text', value: k.alt ?? '' })
        continue
      }
      walk(k)
      out.push(k)
    }
    flush()
    node.children = out
  }
  walk(tree)
}

export const refDefinitionsRemark = $remark('amadeusRefDefinitions', () => () =>
  (tree: MdNode, file: MdNode): void => literalizeReferences(tree, String(file?.value ?? '')))

/** 段落正文 ↔ 原文的比较口径:行尾空白不计(v3 拆段 / 软换行路径会吃掉它)。 */
const displayForm = (s: string): string => s.replace(/[\t ]+(?=\n|$)/g, '')

/** 段落是「没被动过的定义原文」→ 返回要原样写回的原文;否则 null(按普通段落写)。 */
export function pristineRaw(node: PMNode): string | null {
  const raw = node.attrs.raw
  if (typeof raw !== 'string' || node.attrs.indent || (node.attrs.align && node.attrs.align !== 'left')) return null
  let plain = true
  node.forEach((c) => {
    if (c.marks.length) plain = false
    else if (!c.isText && !(c.type.name === 'hardbreak' && c.attrs.html == null)) plain = false
  })
  return plain && displayForm(node.textContent) === displayForm(raw) ? raw : null
}

/** 同 mdast normalizeIdentifier:空白折叠、首尾去空、大小写不敏感。 */
const normLabel = (v: string): string => v.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '').toLowerCase().toUpperCase()
/** 一行定义的开头:≤3 格缩进 + `[label]:`(label 里不许有未转义的方括号,同 CommonMark)。 */
const DEF_START = /^[ \t]{0,3}(\[((?:[^\\[\]]|\\[\s\S])+)\]:)/

/** 外来的定义原文(剪贴板 HTML 的 data-md-raw):首行得是定义的样子才收(这份原文会不经转义写进 .md)。 */
export const literalRawFromDom = (v: string | null): string | null => (v != null && DEF_START.test(v.split('\n')[0]) ? v : null)

/** 正在序列化的那份文档(doc 节点序列化器进出时登记,可重入);null = 序列化的不是整份文档。 */
let serializeRoot: PMNode | null = null
/** 每份文档:label → 该 label 首个定义那一行(从 `[` 起)。只认没被动过的定义段落 —— 动过的落盘是转义字面,不再是定义。 */
const defIndex = new WeakMap<PMNode, Map<string, string>>()
function firstDefinitions(root: PMNode): Map<string, string> {
  let idx = defIndex.get(root)
  if (idx) return idx
  const found = new Map<string, string>()
  root.descendants((node) => {
    if (node.type.name !== 'paragraph') return true
    const raw = pristineRaw(node)
    if (raw != null) {
      for (const line of raw.split('\n')) {
        const m = DEF_START.exec(line)
        const label = m ? normLabel(m[2]) : ''
        if (label && !found.has(label)) found.set(label, line.slice(line.indexOf(m![1])))
      }
    }
    return false
  })
  idx = found
  defIndex.set(root, idx)
  return idx
}

/** 引用形写回去之后还解析得回同一个地址吗:这份文档里该 label 的首个定义就是当初那一行。 */
function refStillDefined(ref: LinkRef): boolean {
  if (!serializeRoot) return false
  const line = firstDefinitions(serializeRoot).get(normLabel(ref.label))
  return line != null && (ref.def == null || line.startsWith(ref.def))
}

/** preset 的 doc 节点原样注册,只把 toMarkdown 包一层:进出时登记「正在序列化的文档」(见顶注)。
 *  挂法:commonmarkWithIndent 里**原位替换** docSchema(追加 .use 会让同名节点 filter+append 挪到节点序尾部)。 */
export const docWithRefScope: MilkdownPlugin = (ctx) => async () => {
  const cleanup = await docSchema(ctx)()
  ctx.update(nodesCtx, (ns) => ns.map(([id, spec]) => {
    if (id !== 'doc') return [id, spec]
    const base = spec.toMarkdown
    return [id, {
      ...spec,
      toMarkdown: {
        match: base.match,
        runner: (state, node) => {
          const prev = serializeRoot
          serializeRoot = node
          try { return base.runner(state, node) } finally { serializeRoot = prev }
        },
      },
    }]
  }))
  return cleanup as () => void // $node 恒返回卸载函数(撤掉 nodesCtx 里的 doc)
}

const parseRef = (v: string | null): LinkRef | null => {
  if (!v) return null
  try {
    const r = JSON.parse(v)
    return r && typeof r.label === 'string' && typeof r.url === 'string'
      ? { referenceType: r.referenceType, label: r.label, url: r.url, ...(typeof r.def === 'string' ? { def: r.def } : {}) }
      : null
  } catch { return null }
}

/** link mark + `ref` attr。toDOM 不能再把 attrs 整个铺进 `<a>`(preset 是 `...mark.attrs`):对象 attr 进 DOM 就是
 *  `ref="[object Object]"`;原文改走 `data-md-ref`,粘贴链路(md → PM → DOM → parseSlice)靠它带回来。 */
export const linkWithRefSchema = linkSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), ref: { default: null } },
    parseDOM: [{
      tag: 'a[href]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return { href: el.getAttribute('href'), title: el.getAttribute('title'), ref: parseRef(el.getAttribute('data-md-ref')) }
      },
    }],
    toDOM: (mark) => {
      const { ref, ...rest } = mark.attrs
      return ['a', { ...ctx.get(linkAttr.key)(mark), ...rest, ...(ref ? { 'data-md-ref': JSON.stringify(ref) } : {}) }]
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, markType) => {
        const ref = (node as MdNode).data?.amadeusRef ?? null
        state.openMark(markType, { href: node.url as string, title: (node.title as string | null) ?? null, ref })
        state.next(node.children as never)
        state.closeMark(markType)
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, mark, node) => {
        const ref = mark.attrs.ref as LinkRef | null
        if (ref && ref.url === mark.attrs.href && refStillDefined(ref)) {
          state.withMark(mark, 'linkReference', undefined, { identifier: ref.label, label: ref.label, referenceType: ref.referenceType })
          return
        }
        return base.toMarkdown.runner(state, mark, node)
      },
    },
  }
})
/* eslint-enable @typescript-eslint/no-explicit-any */
