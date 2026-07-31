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
// 空行(空段落)落盘 = 一条**真**空行,不再是 `<br />` 记号:写端 stripEmptyLineBr 抹平,
// 读端 expand 按 mdast 的 position 行距把空段落还原回来。外部 `a\n\nb` 因此原样往返(此前会收敛成
// `a\nb`)。只在 paragraph↔paragraph 之间还原 —— 标题/列表与正文之间的空行是 markdown 常态,不是空段落。
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
 * `<br…>` 开头的 html 节点 = 换行(而不是要显示出来的字)。
 *
 * Milkdown 的 preserve-empty-line 只认**四种精确写法**(`<br />` `<br>` `<br >` `<br/>`),别的一律当
 * 原始 HTML 留着 —— 而 Milkdown 把 html 节点渲染成 contenteditable=false 的原子块,于是
 * `<BR>` / `<br  />` / `<br class="x">` / 后面紧跟文本的 `<br />` 会**原样以字面量出现在正文里**。
 * 云端笔记多由 AI 写,这些变体正是模型的常见口味(用户实报「云端笔记有时候莫名会出现 <br />」)。
 * 取证见 softBreak.test.ts 的「br 变体」组 + editor-triggers e2e T33。
 */
const BR_LEAD_RE = /^(?:\s*<br\b[^>]*>)+/i

interface BrLead {
  /** 开头连着几个 `<br…>`;0 = 该节点不是 br 打头,别动它。 */
  count: number
  /** 去掉这些标签之后剩下的原文。 */
  rest: string
}
function brLead(n: MdNode): BrLead {
  if (n?.type !== 'html' || typeof n.value !== 'string') return { count: 0, rest: '' }
  const m = BR_LEAD_RE.exec(n.value)
  if (!m) return { count: 0, rest: '' }
  return { count: (m[0].match(/<br\b/gi) ?? []).length, rest: n.value.slice(m[0].length) }
}
/** 剩余原文里没有尖括号 = 纯文本,可以安全地当正文接回去;含标签的一律保持 html 原样(别乱解释用户写的 HTML)。 */
const restAsText = (rest: string): string | null => {
  const t = rest.replace(/^\n+/, '')
  return t && !t.includes('<') ? t : null
}

/**
 * 把一个 paragraph 按行拆成若干 paragraph。没有换行 → 返回 [原节点](不复制,零开销)。
 * text 节点里的 '\n' 与 break 节点都算换行;拆完丢掉空段(remark 不会产出,纯防御)。
 */
export function splitParagraph(p: MdNode): MdNode[] {
  const kids: MdNode[] = Array.isArray(p?.children) ? p.children : []
  const hasNl = kids.some((k) =>
    isBreak(k) || brLead(k).count > 0 || (k?.type === 'text' && typeof k.value === 'string' && k.value.includes('\n')))
  if (!hasNl) return [p]

  const lines: MdNode[][] = [[]]
  const push = (n: MdNode): void => void lines[lines.length - 1].push(n)
  for (const k of kids) {
    if (isBreak(k)) {
      lines.push([])
      continue
    }
    // 行内 `<br…>`:一个标签 = 一次换行(HTML 语义,也是 Obsidian 的渲染)。
    const br = brLead(k)
    if (br.count > 0) {
      for (let i = 0; i < br.count; i++) lines.push([])
      const t = restAsText(br.rest)
      if (t) push({ type: 'text', value: t })
      else if (br.rest.trim()) push({ ...k, value: br.rest })
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

/**
 * 落盘前抹掉「整行只有 `<br />`」的行,还原成一条真正的空行。
 *
 * Milkdown 的 preserve-empty-line 把空段落序列化成 `<br />`(preset-commonmark/node/paragraph.ts),
 * 于是文件里到处是莫名其妙的 `<br />` —— 在 Obsidian / 任何别的编辑器里都看得见(用户实报)。
 * 空行本身要留住:读回时按**行距**重建空段落(见 expand 里的 blankGap),不再靠 `<br />` 当记号。
 * 围栏内的 `<br />` 是代码不是排版,一律不动;行内的 `<br />`(`a<br />b`)也不动(brLead 认它)。
 */
export function stripEmptyLineBr(md: string): string {
  if (!md.includes('<br')) return md
  const lines = md.split('\n')
  let fence: '`' | '~' | null = null
  for (let i = 0; i < lines.length; i++) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (f) {
      const mark = f[1][0] as '`' | '~'
      if (!fence) fence = mark
      else if (mark === fence) fence = null
      continue
    }
    if (fence) continue
    // 空段落也可能长在列表项 / 引用里(列表中连按两次回车就是),那时整行是 `* <br />` / `> <br />`。
    // 留下前缀本身(`*` = 空列表项,`>` = 空引用行)——那才是这行原本的意思。
    const m = /^(\s*(?:(?:[-*+]|\d+[.)])\s+|>\s?)*)<br\s*\/?>\s*$/i.exec(lines[i])
    if (m) lines[i] = m[1].replace(/\s+$/, '')
  }
  return lines.join('\n')
}

/** 相邻两个 paragraph 之间的真空行条数(mdast 的 position 行号差 - 1);拿不到位置信息 → 0。 */
function blankGap(prev: MdNode, next: MdNode): number {
  if (prev?.type !== 'paragraph' || next?.type !== 'paragraph') return 0
  const end = prev.position?.end?.line
  const start = next.position?.start?.line
  if (typeof end !== 'number' || typeof start !== 'number') return 0
  return Math.max(0, start - end - 1)
}

/** 递归:把树里每个含 paragraph 的 children 数组就地展开(导出仅供单测,生产入口是 softBreakRemark)。 */
export function expand(node: MdNode): void {
  if (!Array.isArray(node?.children)) return
  const out: MdNode[] = []
  let prev: MdNode | null = null
  for (const child of node.children) {
    // 两个 paragraph 之间的空行 = 用户敲出来的空段落。序列化时相邻 paragraph 只隔一个 '\n'
    // (softBreakJoin),所以文件里多出来的那条空行**只可能**是空段落 —— 不还原的话「a⏎⏎b」
    // 重开就贴到一起了(旧实现靠落盘 `<br />` 当记号,那记号现在不写了,见 stripEmptyLineBr)。
    for (let i = 0; i < blankGap(prev, child); i++) out.push({ type: 'paragraph', children: [] })
    prev = child
    if (child?.type === 'paragraph') {
      out.push(...splitParagraph(child))
      continue
    }
    // 块级 `<br…>`(自成一行):等价于一个空段落 = 一条空行,与 Milkdown 对四种精确写法的处理对齐。
    const br = brLead(child)
    if (br.count > 0) {
      for (let i = 0; i < br.count; i++) out.push({ type: 'paragraph', children: [] })
      const t = restAsText(br.rest)
      if (t) out.push({ type: 'paragraph', children: [{ type: 'text', value: t }] })
      else if (br.rest.trim()) out.push({ ...child, value: br.rest })
      continue
    }
    expand(child)
    out.push(child)
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
