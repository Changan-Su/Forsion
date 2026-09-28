// D-18(评审 2026-09-27):落盘 diff 局部化 —— **没被编辑的顶层块逐字写回原文**。
//
// 病:v4 每次保存整篇重新序列化,离编辑处很远的块也被改写(表格对齐重排、setext→ATX、`~~~`→```、
// `1. 1. 1.` 重编号、`snake\_case`、脚注间插空行、文末补换行…),git diff 整篇抖动,Obsidian 侧看到的是
// 一份「被格式化过」的文件。Obsidian 只改动被编辑的字符。
//
// 修法(解析时记切片、保存时回填,不需要块 id):
//  · 读侧:preset 的 doc 节点换成本文件的 `verbatimDocSchema`(paragraphIndent.ts 原位替换)。根 runner 逐个
//    跑 mdast 根子节点,把新推进 doc 的 PM 顶层节点记到「来源」(本次解析的源文 + 该子节点的 position 切片)。
//    记账挂在节点对象上(WeakMap):PM 节点不可变,没被动过的顶层块在后续事务里**还是同一个对象**。
//  · 写侧:`serializeForSave` 先按身份(标题的 id 会被 syncHeadingIdPlugin 在加载后改掉 → 退到「邻居推断
//    位置 + 忽略标题 id 的深比较」)把当前顶层块对回来源,连续对上的一段 = 一个「逐字段」;序列化时每段只发一个
//    占位节点,**先**过 normalizeSerializedMd(它会改原文:裸 URL 包 `<url>`、整行 `<br>` 抹成空行、`> \[!` 反转义),
//    **再**把占位换回原文切片。段间、段与被编辑块之间的连接仍由 to-markdown 的 join 决定(= 今天的口径)。
//    只有 `serializeForSave` 包裹期间才发占位(模块级 session):剪贴板 / 画布复制 / v3 块编辑器拿到的仍是纯序列化。
//  · 被编辑的块照旧走序列化器 —— 附录 A 认定的规范化(`_it_`→`*it*`、`[X]`→`[x]`、分割线落 `***`…)只作用于它们。
//
// 什么时候**不**逐字(每条都有反例,见 verbatim.test.ts 的 fuzz 与 check:rtcorpus):
//  · 段的起止要落在「有干净边界」的块上:没有 position 的合成节点(blankLineRemark 补的空段落、分栏/画布行)
//    只在文首 / 文末锚定时并进段;两块之间的原文里有不属于任何块的非空白字(= 切片可能不忠实)→ 该边界封死。
//  · 引用式链接 / 图片:定义变了(删改、换序、别处带进新定义)→ `[a][1]` 逐字写回会在重开时指到别处,
//    改走今天的行内链接写法(D-12 取舍)。
//  · 到 EOF 的围栏 / HTML 块(可能没闭合):后面接了新块就不逐字,否则新内容重开后被吞进代码块。
//  · 跨段边界相邻的两只同类列表(逐字的那只不参与 to-markdown 的换符交替,会并成一只)、列表后紧跟的缩进代码
//    (会被吸进列表项)、挪到正文首行的 `---` 分割线(拍板 #16:文首 `---` 会被当 frontmatter 栅栏)。
//  · 源文含 CR:逐字切片会造成混合换行,整份来源关掉逐字(统一写成 LF)。纯 CRLF 的笔记到不了这里 —— UnifiedPage 在
//    磁盘边界已归一成 LF、写盘再还原(D-19,unified/eol.ts);剩下的只有行尾混杂的文件。
// 仪器:npm run check:rtcorpus(真浏览器,pending 桶里的 D-18 项)、verbatim.test.ts(含「逐字输出与规范输出
// 重解析结构相等」的 fuzz —— 证明拼接绝不改变今天写出去的语义)。
import { config, remarkStringifyOptionsCtx, serializerCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { Mark, type Node as PMNode } from '@milkdown/kit/prose/model'
import { $node, $remark } from '@milkdown/kit/utils'
import { pristineRaw } from './refDefinitions'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

/** 一次解析的来源:源文 + 该次解析产出的顶层节点(按序)及每个节点的切片边界与闸位。 */
interface Src {
  text: string
  nodes: PMNode[]
  /** 左边界(已回退到行首);null = 没有(合成节点 / 多节点组的非首个)。 */
  from: (number | null)[]
  /** 右边界(已吃掉行尾空白);null = 没有。 */
  to: (number | null)[]
  /** 该节点前 / 后的原文里有不属于任何块的非空白字:段不许从这里起 / 在这里止(文首文末锚定除外)。 */
  sealBefore: boolean[]
  sealAfter: boolean[]
  /** 到 EOF 的围栏代码 / HTML 块(可能没闭合)。 */
  eofOpen: boolean[]
  /** 切片以空白起头(缩进代码、行首带 1–3 格的块):接在列表 / 脚注定义后面会被当成续行吸进去。 */
  indentStart: boolean[]
  /** 含链接定义(D-12 的定义行字面段落)。 */
  def: boolean[]
  /** 含引用式链接 / 图片(结果取决于定义)。 */
  ref: boolean[]
}

const originOf = new WeakMap<PMNode, { src: Src; idx: number }>()

const isBlank = (s: string): boolean => !/\S/.test(s)

/** 块起点回退到行首(mdast 的列表 / 标题起点在标记字符上,切片不带行首缩进,重解析时后续行的相对缩进就变了)。
 *  行首到起点之间 ≥4 列空白(或有制表符 / 非空白)= 这块只能是上文的续行(例:链接定义后的缩进行是段落续行,
 *  单独拿出来是缩进代码)—— 返回 null:起点不回退,且不许从这里起段。 */
function lineStart(text: string, at: number): number | null {
  let i = at
  while (i > 0 && text[i - 1] !== '\n') i--
  const pre = text.slice(i, at)
  if (!pre) return at
  return /^ {1,3}$/.test(pre) ? i : null
}
function lineEnd(text: string, at: number): number {
  let i = at
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  return i === text.length || text[i] === '\n' ? i : at
}

const IMAGE_REF = /!\[(?!\[)[^\]\n]*\](?!\()/ // `![alt][label]` / `![alt][]` / `![alt]`;`![[嵌入]]` 不算
function scanFlags(node: PMNode): { def: boolean; link: boolean } {
  let def = node.type.name === 'paragraph' && typeof node.attrs.raw === 'string' // descendants 不含节点自己
  let link = false
  node.descendants((n) => {
    if (n.type.name === 'paragraph' && typeof n.attrs.raw === 'string') def = true
    if (n.isText && n.marks.some((m) => m.type.name === 'link' && m.attrs.ref != null)) link = true
    return !(def && link)
  })
  return { def, link }
}

const isHtmlBlock = (md: MdNode): boolean =>
  md?.type === 'html' || (md?.type === 'paragraph' && md.children?.length === 1 && md.children[0]?.type === 'html')

/** 根 runner 的记账。groups[i] = 第 i 个 mdast 根子节点与它产出的 PM 节点。 */
function recordSrc(text: string, groups: Array<{ md: MdNode; made: PMNode[] }>, content: PMNode[]): void {
  const n = content.length
  const src: Src = {
    text, nodes: content.slice(),
    from: new Array(n).fill(null), to: new Array(n).fill(null),
    sealBefore: new Array(n).fill(false), sealAfter: new Array(n).fill(false),
    eofOpen: new Array(n).fill(false), indentStart: new Array(n).fill(false),
    def: new Array(n).fill(false), ref: new Array(n).fill(false),
  }
  const idxOf = new Map<PMNode, number>()
  content.forEach((node, i) => idxOf.set(node, i))
  let lastEnd = 0
  for (const g of groups) {
    if (!g.made.length) continue
    const first = idxOf.get(g.made[0])
    const last = idxOf.get(g.made[g.made.length - 1])
    if (first == null || last == null) continue
    const s0 = g.md?.position?.start?.offset
    const e0 = g.md?.position?.end?.offset
    if (typeof s0 !== 'number' || typeof e0 !== 'number' || s0 > e0 || e0 > text.length) continue
    // structuralIndent 摘掉的 `<!-- amadeus-indent:N -->` 标记属于紧随其后的这一块。
    const marker = g.md?.data?.amadeusIndentFrom
    const s1 = typeof marker === 'number' && marker >= 0 && marker < s0 ? marker : s0
    if (s1 < lastEnd) continue // 与上一块重叠(拆段的复制品):不给边界,由封边兜住
    const ls = lineStart(text, s1)
    const s = ls ?? s1
    const e = lineEnd(text, e0)
    src.from[first] = s
    src.to[last] = e
    if (ls == null) src.sealBefore[first] = true
    lastEnd = e
    const slice = text.slice(s, e)
    const md = g.md
    if (e === text.length || isBlank(text.slice(e))) {
      if ((md?.type === 'code' && /^[ \t]*(`{3,}|~{3,})/.test(slice)) || isHtmlBlock(md)) src.eofOpen[last] = true
    }
    if (/^[ \t]/.test(slice)) src.indentStart[first] = true
    let def = false
    let ref = IMAGE_REF.test(slice)
    for (const node of g.made) {
      const f = scanFlags(node)
      def ||= f.def
      ref ||= f.link
    }
    for (let i = first; i <= last; i++) {
      src.def[i] = def
      src.ref[i] = ref
    }
  }
  // 封边:两块之间(及文首、文末)的原文若含非空白字,它不属于任何带边界的块 —— 该边界不许作段的起止。
  let prev: number | null = null
  let prevTo = 0
  for (let i = 0; i < n; i++) {
    const f = src.from[i]
    if (f != null && !isBlank(text.slice(prevTo, f))) {
      src.sealBefore[i] = true
      if (prev != null) src.sealAfter[prev] = true
    }
    const t = src.to[i]
    if (t != null) {
      prev = i
      prevTo = t
    }
  }
  if (prev != null && !isBlank(text.slice(prevTo))) src.sealAfter[prev] = true
  content.forEach((node, idx) => originOf.set(node, { src, idx }))
}

// ── 读侧:根 runner ────────────────────────────────────────────────────────────
function parseRoot(state: MdNode, node: MdNode, type: MdNode): void {
  state.openNode(type)
  const top = state.top()
  const text = node?.data?.amadeusSource
  const groups: Array<{ md: MdNode; made: PMNode[] }> = []
  let sane = !!top && typeof text === 'string' && !text.includes('\r')
  for (const child of Array.isArray(node?.children) ? node.children : []) {
    const before = top ? top.content.length : 0
    state.next(child)
    if (!sane) continue
    // 子 runner 必须把栈还原、且只追加:否则 content 与 mdast 的对应关系不可信,本次不记账(= 今天的行为)。
    if (state.top() !== top || top.content.length < before) { sane = false; continue }
    groups.push({ md: child, made: top.content.slice(before) })
  }
  if (sane) recordSrc(text, groups, top.content)
}

/** 源文印到 mdast 根上(parser 的 remark.runSync 把源串当 file 交给 transformer)。 */
export const verbatimSourceRemark = $remark('amadeusVerbatimSource', () => () =>
  (tree: MdNode, file: MdNode): void => {
    tree.data = { ...tree.data, amadeusSource: String(file?.value ?? '') }
  })

// ── 写侧:计划 ────────────────────────────────────────────────────────────────
function attrsSame(a: PMNode, b: PMNode): boolean {
  const skipId = a.type.name === 'heading'
  for (const k of Object.keys(a.attrs)) {
    if (skipId && k === 'id') continue
    const x = a.attrs[k]
    const y = b.attrs[k]
    if (x !== y && JSON.stringify(x) !== JSON.stringify(y)) return false
  }
  return true
}
/** 内容相同(忽略标题的 id attr —— syncHeadingIdPlugin 加载即改,会让每个标题都「变了」)。 */
export function sameContent(a: PMNode, b: PMNode): boolean {
  if (a === b) return true
  if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks)) return false
  if (a.isText) return a.text === b.text
  if (!attrsSame(a, b) || a.childCount !== b.childCount) return false
  for (let i = 0; i < a.childCount; i++) if (!sameContent(a.child(i), b.child(i))) return false
  return true
}

interface Run { a: number; b: number; src: Src; from: number; to: number; tail: boolean }
interface Plan { doc: PMNode; runs: Run[]; startAt: Map<number, number>; nonce: string }

const isList = (n: PMNode): boolean => n.type.name === 'bullet_list' || n.type.name === 'ordered_list'
/** 会把后面缩进起头的行当续行吸进去的容器(列表项、脚注定义;空行挡不住)。 */
const absorbsIndented = (n: PMNode): boolean => isList(n) || n.type.name === 'footnote_definition'
const isEmptyPara = (n: PMNode): boolean => n.type.name === 'paragraph' && n.content.size === 0
function hasPristineDef(node: PMNode): boolean {
  let hit = node.type.name === 'paragraph' && pristineRaw(node) != null // descendants 不含节点自己
  node.descendants((n) => {
    if (!hit && n.type.name === 'paragraph' && pristineRaw(n) != null) hit = true
    return !hit
  })
  return hit
}

/** 当前 doc 的逐字计划;没有可逐字的段 = null(整篇照旧序列化)。导出供单测。 */
export function planVerbatim(doc: PMNode): Plan | null {
  const m = doc.childCount
  if (!m) return null
  const cur: PMNode[] = []
  doc.forEach((c) => { cur.push(c) })
  type Res = { src: Src; idx: number } | null
  const res: Res[] = cur.map((c) => originOf.get(c) ?? null)
  if (!res.some(Boolean)) return null
  // 身份没对上的:按邻居推断它在来源里的位置,深比较(忽略标题 id)确认。
  const infer = (j: number, near: Res, step: 1 | -1): void => {
    if (res[j] || !near) return
    const k = near.idx + step
    if (k >= 0 && k < near.src.nodes.length && sameContent(cur[j], near.src.nodes[k])) res[j] = { src: near.src, idx: k }
  }
  for (let j = 1; j < m; j++) infer(j, res[j - 1], 1)
  for (let j = m - 2; j >= 0; j--) infer(j, res[j + 1], -1)
  if (!res[0]) {
    const any = res.find(Boolean)
    if (any && sameContent(cur[0], any.src.nodes[0])) res[0] = { src: any.src, idx: 0 }
  }
  for (let j = 1; j < m; j++) infer(j, res[j - 1], 1)
  // 同一来源节点出现两次(同一对象被复制插入):后出现的按普通块写。
  const seen = new Set<string>()
  const ids = new WeakMap<Src, number>()
  let nextId = 0
  const key = (r: NonNullable<Res>): string => {
    let id = ids.get(r.src)
    if (id == null) ids.set(r.src, (id = nextId++))
    return `${id}:${r.idx}`
  }
  res.forEach((r, j) => {
    if (!r) return
    const k = key(r)
    if (seen.has(k)) res[j] = null
    else seen.add(k)
  })
  // 定义完好:该来源的定义块都在、各一次、顺序不变;没有别的来源带进定义;被编辑的块里没有仍会按定义写回的字面段落。
  const intact = new Map<Src, boolean>()
  const defsIntact = (src: Src): boolean => {
    let v = intact.get(src)
    if (v != null) return v
    v = true
    let last = -1
    const found = new Set<number>()
    res.forEach((r, j) => {
      if (!r) { if (hasPristineDef(cur[j])) v = false; return }
      if (r.src !== src) { if (r.src.def[r.idx]) v = false; return }
      if (!src.def[r.idx]) return
      if (r.idx < last) v = false
      last = r.idx
      found.add(r.idx)
    })
    src.def.forEach((d, i) => { if (d && !found.has(i)) v = false })
    intact.set(src, v)
    return v
  }
  const elig = res.map((r, j) => {
    if (!r) return false
    if (r.src.ref[r.idx] && !defsIntact(r.src)) return false
    if (r.src.eofOpen[r.idx] && !(j === m - 1 && r.idx === r.src.nodes.length - 1)) return false
    return true
  })
  const headOk = (j: number): boolean => j === 0 && res[j]!.idx === 0
  const tailOk = (j: number): boolean => j === m - 1 && res[j]!.idx === res[j]!.src.nodes.length - 1
  for (let guard = 0; guard <= m + 1; guard++) {
    // 连续段:同一来源、原序号逐一递增。
    const runs: Array<[number, number]> = []
    for (let j = 0; j < m; j++) {
      if (!elig[j]) continue
      const a = j
      while (j + 1 < m && elig[j + 1] && res[j + 1]!.src === res[a]!.src && res[j + 1]!.idx === res[j]!.idx + 1) j++
      runs.push([a, j])
    }
    let changed = false
    for (const [a, b] of runs) {
      const src = res[a]!.src
      const left = headOk(a) || (src.from[res[a]!.idx] != null && !src.sealBefore[res[a]!.idx])
      const right = tailOk(b) || (src.to[res[b]!.idx] != null && !src.sealAfter[res[b]!.idx])
      if (!left) { elig[a] = false; changed = true }
      if (!right) { elig[b] = false; changed = true }
    }
    if (changed) continue
    // 段两端的邻块(跳过空段落 —— 它们落盘只是空行,隔不开任何东西)。
    const prevSolid = (j: number): number => { let k = j - 1; while (k >= 0 && isEmptyPara(cur[k])) k--; return k }
    const nextSolid = (j: number): number => { let k = j + 1; while (k < m && isEmptyPara(cur[k])) k++; return k }
    for (const [a, b] of runs) {
      const src = res[a]!.src
      // 同类列表跨段边界相邻(中间只有空行):逐字那只不参与 to-markdown 的换符交替,重开并成一只。
      const p = prevSolid(a)
      if (p >= 0 && isList(cur[a]) && cur[p].type === cur[a].type) { elig[a] = false; changed = true }
      const q = nextSolid(b)
      if (q < m && isList(cur[b]) && cur[q].type === cur[b].type) { elig[b] = false; changed = true }
      // 缩进起头的块(缩进代码、`  - x`、`   ## h`)接在列表 / 脚注定义后面会被吸成续行;缩进代码接在代码块后面会并成一块。
      if (src.indentStart[res[a]!.idx] && p >= 0 && (absorbsIndented(cur[p]) || (cur[a].type.name === 'code_block' && cur[p].type.name === 'code_block'))) {
        elig[a] = false
        changed = true
      }
      // 正文首行的 `---`(拍板 #16):文首 `---` 会被当 frontmatter 栅栏。不看是否文首锚定 —— 插进来的片段(粘贴 /
      // 模板)也是一份来源,它的「文首」不是这篇笔记的文首;原文就以 `---` 开头的罕见情形按规范形 `***` 写,也是安全的。
      if (a === 0 && /^---\r?\n/.test(src.text.slice(headOk(0) ? 0 : src.from[res[0]!.idx] ?? 0))) { elig[0] = false; changed = true }
    }
    if (changed) continue
    if (!runs.length) return null
    const out: Run[] = runs.map(([a, b]) => {
      const src = res[a]!.src
      return {
        a, b, src,
        from: headOk(a) ? 0 : src.from[res[a]!.idx]!,
        to: tailOk(b) ? src.text.length : src.to[res[b]!.idx]!,
        tail: tailOk(b),
      }
    })
    const startAt = new Map<number, number>()
    out.forEach((r, i) => startAt.set(r.a, i))
    return { doc, runs: out, startAt, nonce: Math.random().toString(36).slice(2, 10) }
  }
  return null
}

// ── 写侧:根 runner + 占位 handler ─────────────────────────────────────────────
let active: Plan | null = null
const token = (plan: Plan, i: number): string => `${plan.nonce}:${i}`

function serializeRoot(state: MdNode, node: PMNode): void {
  state.openNode('root')
  const plan = active && active.doc === node ? active : null
  if (!plan) {
    state.next(node.content)
    return
  }
  for (let j = 0; j < node.childCount; j++) {
    const r = plan.startAt.get(j)
    if (r == null) {
      state.next(node.child(j))
      continue
    }
    state.addNode('amadeusVerbatim', undefined, token(plan, r))
    j = plan.runs[r].b
  }
}

const verbatimHandlers = config((ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (o: any) => ({
    ...o,
    handlers: { ...o.handlers, amadeusVerbatim: (node: MdNode) => String(node.value ?? '') },
  }))
})

/** preset `docSchema` 的原位替换(content 与 match 同 preset;只换两侧 runner)。 */
export const verbatimDocSchema = $node('doc', () => ({
  content: 'block+',
  parseMarkdown: { match: ({ type }) => type === 'root', runner: parseRoot },
  toMarkdown: { match: (node) => node.type.name === 'doc', runner: serializeRoot },
}))

/** 与 preset 同进同出的附属插件(源文印章 + 占位 handler),挂在 commonmarkWithIndent。 */
export const verbatimPlugins = [verbatimSourceRemark, verbatimHandlers].flat()

/** 整篇保存用的序列化(**唯一入口**:监听器、serializeNow、canonical 必须同一个函数)。
 *  normalize = normalizeSerializedMd(由调用方传入,避免与 MarkdownBlock 循环引用)。 */
export function serializeForSave(ctx: Ctx, doc: PMNode, normalize: (md: string) => string): string {
  const serializer = ctx.get(serializerCtx)
  let plan: Plan | null = null
  try {
    plan = planVerbatim(doc)
  } catch {
    plan = null
  }
  if (!plan) return normalize(serializer(doc))
  active = plan
  let raw: string
  try {
    raw = serializer(doc)
  } finally {
    active = null
  }
  const md = normalize(raw)
  // 占位换回原文。每个占位必须恰好出现一次;否则(被规范化链改坏)整篇退回纯序列化。
  let out = md
  for (let i = 0; i < plan.runs.length; i++) {
    const t = token(plan, i)
    const at = out.indexOf(t)
    if (at < 0 || out.indexOf(t, at + t.length) >= 0) return normalize(serializer(doc))
    const run = plan.runs[i]
    const slice = run.src.text.slice(run.from, run.to)
    // 文末锚定的段自带原文的文末(有没有换行、几条空行);to-markdown 在末尾硬补的那个 `\n` 去掉。
    const end = at + t.length
    const drop = run.tail && out.length === end + 1 && out[end] === '\n' ? 1 : 0
    out = out.slice(0, at) + slice + out.slice(end + drop)
  }
  if (out.includes('' + plan.nonce)) return normalize(serializer(doc))
  return out
}

/** 外部回灌(applyMinimalDiff)后:被保留的前后缀节点改记到新盘上文本的来源 ——
 *  否则外部只改了格式(`- a`→`* a`,PM 内容相同)时,旧对象带着旧切片,下一次保存把外部改动写回旧样。 */
export function adoptOrigins(doc: PMNode, next: PMNode): void {
  const n = Math.min(doc.childCount, next.childCount)
  const adopt = (a: PMNode, b: PMNode): boolean => {
    if (a === b) return true
    if (!sameContent(a, b)) return false
    const o = originOf.get(b)
    if (o) originOf.set(a, o)
    else originOf.delete(a)
    return true
  }
  let i = 0
  while (i < n && adopt(doc.child(i), next.child(i))) i++
  for (let k = 1; k <= n - i; k++) {
    if (!adopt(doc.child(doc.childCount - k), next.child(next.childCount - k))) break
  }
}
