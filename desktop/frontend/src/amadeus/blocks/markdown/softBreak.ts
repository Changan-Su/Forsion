// 块内换行的落盘形态:**一个 `\n` 就是一次换行**(Obsidian 语义),不再是「空行分段」。
//
// 病:块内每按一次回车,ProseMirror 的 splitBlock 生成一个新 paragraph,remark 序列化相邻段落
// 恒隔一个空行 → .md 源码里每行之间都夹一条空行,肉眼读起来全是窟窿(用户实报)。
//
// 两侧对称改,缺一round-trip 就不闭合:
//  · 序列化:toMarkdownExtensions 的 `join` —— 相邻两个 paragraph 之间 0 条空行(即单个 '\n')。
//  · 解析:paragraph 里的换行(text 值里的 '\n' 或 remark 的 break 节点)重新拆成多个 paragraph。
//    不做这一步,重新打开笔记后整块会塌成**一个**多行 textblock,行首触发符(`# ` / `- ` / `> `)
//    从第 2 行起全部失效 —— 症状是「刚打的时候好好的,重开就不灵了」。
//
// 代价(有意接受):外部写的 `a\n\nb`(真空行分段)在本编辑器里保存后收敛成 `a\nb`。
// Amadeus 的块模型本来就把「段落」呈现为「行」,两者渲染完全一致;想要真空行敲两次回车留一个空段落。
//
// ⚠️ 只拆 paragraph 的**直接** children。`<u>a\nb</u>` 这类换行被夹在 mark 节点内部的,'\n' 原样留在
// 文本里 —— ProseMirror 的 white-space:pre-wrap 照样渲染成换行,只是不拆成独立段落。刻意不递归:
// 递归拆会把跨行的 mark 撕成两半(开合标签分家),marks.ts 的折叠桥就配不上对了。
import { $remark } from '@milkdown/kit/utils'

// mdast 是动态形状的 AST,这层统一按 any 处理(同 marks.ts)。
/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

/** 该 inline 节点是否是一次换行:remark 的 break 节点(行尾 `\` 或两空格)。 */
const isBreak = (n: MdNode): boolean => n?.type === 'break'

/**
 * 把一个 paragraph 按行拆成若干 paragraph。没有换行 → 返回 [原节点](不复制,零开销)。
 * text 节点里的 '\n' 与 break 节点都算换行;拆完丢掉空段(remark 不会产出,纯防御)。
 */
export function splitParagraph(p: MdNode): MdNode[] {
  const kids: MdNode[] = Array.isArray(p?.children) ? p.children : []
  const hasNl = kids.some((k) => isBreak(k) || (k?.type === 'text' && typeof k.value === 'string' && k.value.includes('\n')))
  if (!hasNl) return [p]

  const lines: MdNode[][] = [[]]
  const push = (n: MdNode): void => void lines[lines.length - 1].push(n)
  for (const k of kids) {
    if (isBreak(k)) {
      lines.push([])
      continue
    }
    if (k?.type === 'text' && typeof k.value === 'string' && k.value.includes('\n')) {
      const parts = k.value.split('\n')
      parts.forEach((v: string, i: number) => {
        if (i > 0) lines.push([])
        if (v) push({ ...k, value: v })
      })
      continue
    }
    push(k)
  }
  // 只削首尾的空行(解析残渣),**中间的空行必须留**:它就是用户敲两次回车要的那个空段落。
  // Milkdown 的 preserve-empty-line 把空段落落盘成 `<br />`,解析时又摘掉只剩空 paragraph ——
  // 这里若一并过滤,那个空行每次重开笔记就少一个(实测:a⏎⏎b 重开后 a、b 贴到了一起)。
  while (lines.length && lines[0].length === 0) lines.shift()
  while (lines.length && lines[lines.length - 1].length === 0) lines.pop()
  return lines.map((children) => ({ ...p, children }))
}

/** 递归:把树里每个含 paragraph 的 children 数组就地展开。 */
function expand(node: MdNode): void {
  if (!Array.isArray(node?.children)) return
  const out: MdNode[] = []
  for (const child of node.children) {
    if (child?.type === 'paragraph') out.push(...splitParagraph(child))
    else {
      expand(child)
      out.push(child)
    }
  }
  node.children = out
}

/**
 * 相邻段落之间不留空行。返回 undefined = 不表态,交给 mdast-util-to-markdown 的默认/后续 join
 * (别返回 1,那会把「列表项之间」这类本该由 list 逻辑决定的间距一起接管)。
 */
export const softBreakJoin = (left: MdNode, right: MdNode): number | undefined =>
  left?.type === 'paragraph' && right?.type === 'paragraph' ? 0 : undefined

export const softBreakRemark = $remark('amadeusSoftBreak', () =>
  function softBreak(this: any) {
    const data = this.data()
    const toMd = (data.toMarkdownExtensions ||= [])
    toMd.push({ join: [softBreakJoin] })
    return (tree: MdNode): void => expand(tree)
  },
)
