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
//  · `[text][label]` / `[text][]` / `[text]` → link mark 带 `ref`(引用形 + label + 当时的 url),照常渲染成链接;
//    落盘时 url 没改就写回引用形,改过(链接卡改地址)就退成行内链接。collapsed / shortcut 的文字被改,
//    mdast-util-to-markdown 自己会退成 full 形,引用不断。
//  · `![alt][label]` 仍按 preset 转成行内图片(取舍:图片引用罕见,逐字要再扩 image schema,不值当)。
// ⚠️ 不能直接从 preset 里摘掉 remark-inline-links:剩下的 definition / linkReference 没有 schema → parserMatchError 白屏。
//    所以这里**自己**建定义表、同一趟把引用也处理掉 —— 只转定义不转引用,它开头 definitions(tree) 找不到定义,引用原样留下,一样白屏。
// 仪器:npm run check:rtcorpus(d12.* / entry.*)、refDefinitions.test.ts。
import { $remark } from '@milkdown/kit/utils'
import { linkAttr, linkSchema } from '@milkdown/kit/preset/commonmark'
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
  return {
    type: 'paragraph',
    children: [{ type: 'text', value: raw }],
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
        const ref: LinkRef = { referenceType: k.referenceType, label: String(k.label ?? k.identifier), url: def.url }
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

/** 段落正文 ↔ 原文的比较口径:remark-line-break 会吃掉换行前的行尾空白。 */
const displayForm = (s: string): string => s.replace(/[\t ]+(?=\n|$)/g, '')

/** 段落是「没被动过的定义原文」→ 返回要原样写回的原文;否则 null(按普通段落写)。 */
export function pristineRaw(node: PMNode): string | null {
  const raw = node.attrs.raw
  if (typeof raw !== 'string' || node.attrs.indent || (node.attrs.align && node.attrs.align !== 'left')) return null
  let plain = true
  node.forEach((c) => {
    if (c.marks.length) plain = false
    else if (!c.isText && !(c.type.name === 'hardbreak' && c.attrs.isInline && c.attrs.html == null)) plain = false
  })
  return plain && displayForm(node.textContent) === displayForm(raw) ? raw : null
}

const parseRef = (v: string | null): LinkRef | null => {
  if (!v) return null
  try {
    const r = JSON.parse(v)
    return r && typeof r.label === 'string' && typeof r.url === 'string' ? r : null
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
        if (ref && ref.url === mark.attrs.href) {
          state.withMark(mark, 'linkReference', undefined, { identifier: ref.label, label: ref.label, referenceType: ref.referenceType })
          return
        }
        return base.toMarkdown.runner(state, mark, node)
      },
    },
  }
})
/* eslint-enable @typescript-eslint/no-explicit-any */
