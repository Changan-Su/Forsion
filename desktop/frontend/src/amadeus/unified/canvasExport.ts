// 画布 → JSON Canvas 1.0 的**单向导出**(V-19,拍板 #10:只导出,不导入 —— 做导入就等于复刻已被否掉的多文档画布)。
// 规范:https://jsoncanvas.org/spec/1.0/ 。Obsidian 打开 `.canvas` 就看得到这份布局;回到 Amadeus 不读它。
//
// 映射(每条都是按 JSON Canvas 的语义挑的,写在这里免得以后有人「顺手统一」):
//  · 卡片 → **text 节点**(内容 = 卡的 markdown)。卡是笔记里的一段内容,不是独立文件;JSON Canvas 的 file 节点
//    只能指向整份文件(或 #标题 / #^块),而卡锚 `<!-- a k -->` 在 Obsidian 里不是块 id,指过去解析不了。
//    例外:卡的全部内容**恰好是一个** `![[目标]]` 且目标解析得到库内笔记 → **file 节点**(`file` = 库内路径,
//    `#标题` 进 `subpath`)—— 侧栏拖笔记进画布生成的就是这种卡(V-09),它在两边都是「嵌入一篇笔记」。
//    解析不到的嵌入照旧 text(Obsidian 的 text 节点本来就渲染 `![[…]]`)。
//  · 主卡(未入卡的正文)→ text 节点,id 固定 `main`;正文为空且没有任何线连着它就不导出(空壳节点没有信息)。
//  · 形状 / 文本 → text 节点(文字 = 形状里的字)。⚠️ JSON Canvas 没有形状:矩形 / 椭圆的外形导出后丢失,只剩位置与文字。
//  · Frame → group 节点(label = 标题)。排在 nodes 最前面 = 最底层(规范:数组序即 z 序)。
//  · 连线 → edge:label / color / fromEnd·toEnd(V-17 同名同义,只在盘上写了才导出,缺省值交给规范缺省);
//    fromSide/toSide 按我们自己画线的那条规则算出来(规范标可选,但不赌读端对缺省的处理)。
//  · 层级(tree)→ edge,`toEnd:"none"`(层级线在画布上本来就不带箭头)。
//  · 颜色:只导出过得了 canvasColorCss 的值(编码本来就是 JSON Canvas 的 `"1"`–`"6"` / `#rrggbb`),怪值不导。
// 节点 id 带前缀(`card-` / `el-` / `main`),卡锚与元素 id 的字符集重叠,裸值会撞。
import { linkTarget, resolvePageName } from '@amadeus-shared/links'
import { canvasColorCss } from './canvasEdit'

export interface ExportBox { x: number; y: number; w: number; h: number }
/** 一张卡:锚 + 画布上的盒(h 必须是实际高度 —— h=0 的自适应卡由调用方量 DOM)+ 颜色原值 + 内容的 markdown。 */
export interface ExportCard extends ExportBox { ref: string; color?: unknown; md: string }
export interface ExportInput {
  cards: ExportCard[]
  /** 主卡的盒与非卡正文的 markdown;null = 不导出主卡。 */
  main: (ExportBox & { md: string }) | null
  /** `amadeus_canvas.elements` 原始条目(未校验)。 */
  elements: unknown
  /** `amadeus_canvas.tree` 原始对象(未校验)。 */
  tree: unknown
  /** 库内笔记名册(解析 `![[目标]]` 用);缺省 = 一律 text 节点。 */
  pages?: string[]
  /** 本篇路径(同目录优先解析,与编辑器点链接同一把尺)。 */
  sourcePath?: string
}

export type JcSide = 'top' | 'right' | 'bottom' | 'left'
export type JcNode =
  | { id: string; type: 'text'; x: number; y: number; width: number; height: number; text: string; color?: string }
  | { id: string; type: 'file'; x: number; y: number; width: number; height: number; file: string; subpath?: string; color?: string }
  | { id: string; type: 'group'; x: number; y: number; width: number; height: number; label?: string; color?: string }
export interface JcEdge {
  id: string
  fromNode: string
  fromSide?: JcSide
  fromEnd?: 'none' | 'arrow'
  toNode: string
  toSide?: JcSide
  toEnd?: 'none' | 'arrow'
  color?: string
  label?: string
}
export interface JsonCanvas { nodes: JcNode[]; edges: JcEdge[] }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const colorOf = (v: unknown): string | null => (canvasColorCss(v) ? (v as string) : null)
const endOf = (v: unknown): 'none' | 'arrow' | null => (v === 'none' || v === 'arrow' ? v : null)
const geo = (b: ExportBox): { x: number; y: number; width: number; height: number } => ({
  x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.w)), height: Math.max(1, Math.round(b.h)),
})

/** 一张卡的内容**恰好是**一个嵌入 → 它的目标原文(`Note#标题|别名` 里的 `Note#标题`);否则 null。 */
function soleEmbed(md: string): string | null {
  const m = /^!\[\[([^\]\n]+)\]\]$/.exec(md.trim())
  return m ? m[1] : null
}

/** 连线从 from 盒出发的那条边 —— 与 canvasElements 的 edgeAnchor **同一条规则**(水平分量占优走左右,否则上下),
 *  导出的线才与画布上看到的出入口一致。 */
function sideOf(from: ExportBox, to: ExportBox): JcSide {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  if (Math.abs(dx) * from.h >= Math.abs(dy) * from.w) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

export function buildJsonCanvas(input: ExportInput): JsonCanvas {
  const groups: JcNode[] = []
  const shapes: JcNode[] = []
  const cards: JcNode[] = []
  const boxes = new Map<string, ExportBox>() // 节点 id → 盒(算 edge 出入边用)
  const pages = input.pages ? [...input.pages].sort() : []

  const raw = Array.isArray(input.elements) ? input.elements : []
  const seen = new Set<string>()
  const conns: Array<Record<string, unknown>> = []
  for (const it of raw) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue
    const o = it as Record<string, unknown>
    const id = str(o.id)
    if (!id || seen.has(id)) continue // 重复 id:后到的丢(与 safeElements 同口径)
    if (o.type === 'connector') { seen.add(id); conns.push(o); continue }
    if (o.type !== 'shape' && o.type !== 'text' && o.type !== 'frame') continue
    const x = num(o.x)
    const y = num(o.y)
    const w = num(o.w)
    const h = num(o.h)
    if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) continue
    seen.add(id)
    const nid = `el-${id}`
    const box = { x, y, w, h }
    boxes.set(nid, box)
    const color = colorOf(o.color)
    if (o.type === 'frame') {
      const label = str(o.title)
      groups.push({ id: nid, type: 'group', ...geo(box), ...(label ? { label } : {}), ...(color ? { color } : {}) })
    } else {
      shapes.push({ id: nid, type: 'text', ...geo(box), text: typeof o.text === 'string' ? o.text : '', ...(color ? { color } : {}) })
    }
  }

  for (const c of input.cards) {
    const nid = `card-${c.ref}`
    boxes.set(nid, c)
    const color = colorOf(c.color)
    const embed = soleEmbed(c.md)
    const file = embed && pages.length ? resolvePageName(linkTarget(embed), pages, input.sourcePath) : null
    if (embed && file) {
      // `Note#标题|别名` → subpath `#标题`(别名只是显示名,JSON Canvas 没有对应字段)。
      const noAlias = embed.split('|')[0]
      const hash = noAlias.indexOf('#')
      const subpath = hash >= 0 ? noAlias.slice(hash).trim() : ''
      cards.push({ id: nid, type: 'file', ...geo(c), file, ...(subpath.length > 1 ? { subpath } : {}), ...(color ? { color } : {}) })
    } else {
      cards.push({ id: nid, type: 'text', ...geo(c), text: c.md, ...(color ? { color } : {}) })
    }
  }

  const edges: JcEdge[] = []
  const nodeOfEnd = (v: unknown): string | null => {
    if (!v || typeof v !== 'object') return null
    const e = v as { ref?: unknown; id?: unknown; main?: unknown }
    const nid = str(e.ref) ? `card-${e.ref as string}` : str(e.id) ? `el-${e.id as string}` : e.main === true ? 'main' : null
    return nid && (boxes.has(nid) || nid === 'main') ? nid : null
  }
  // 主卡的盒先登记(连线 / 层级会连到它);是否真的落一个节点,等连线算完再定。
  if (input.main) boxes.set('main', input.main)
  let mainUsed = false
  const pushEdge = (e: JcEdge): void => {
    const a = boxes.get(e.fromNode)
    const b = boxes.get(e.toNode)
    if (!a || !b) return // 端点没了(主卡不导出 / 悬空线):不导
    if (e.fromNode === 'main' || e.toNode === 'main') mainUsed = true
    edges.push({ ...e, fromSide: sideOf(a, b), toSide: sideOf(b, a) })
  }
  for (const o of conns) {
    const from = nodeOfEnd(o.from)
    const to = nodeOfEnd(o.to)
    if (!from || !to || from === to) continue
    const fromEnd = endOf(o.fromEnd)
    const toEnd = endOf(o.toEnd)
    const label = str(o.label)
    const color = colorOf(o.color)
    pushEdge({ id: `edge-${o.id as string}`, fromNode: from, toNode: to, ...(fromEnd ? { fromEnd } : {}), ...(toEnd ? { toEnd } : {}), ...(label ? { label } : {}), ...(color ? { color } : {}) })
  }
  const tree = input.tree && typeof input.tree === 'object' && !Array.isArray(input.tree) ? (input.tree as Record<string, unknown>) : {}
  for (const child of Object.keys(tree)) {
    const parent = tree[child]
    if (typeof parent !== 'string' || !parent || parent === child) continue
    const from = parent === 'm:' ? 'main' : `card-${parent}`
    const to = `card-${child}`
    if (!boxes.has(to)) continue
    pushEdge({ id: `tree-${child}`, fromNode: from, toNode: to, toEnd: 'none' })
  }

  const nodes: JcNode[] = [...groups, ...shapes]
  if (input.main && (input.main.md.trim() || mainUsed)) nodes.push({ id: 'main', type: 'text', ...geo(input.main), text: input.main.md })
  nodes.push(...cards)
  return { nodes, edges }
}

/** JSON Canvas 落盘的文本形态(Obsidian 自己写的就是制表符缩进)。 */
export const jsonCanvasText = (c: JsonCanvas): string => `${JSON.stringify(c, null, '\t')}\n`

/** `folder/Note.md` → 同目录的导出候选:`folder/Note.canvas`、`folder/Note 2.canvas`、…(第 n 个,从 1 起)。 */
export function canvasExportPath(notePath: string, n = 1): string {
  const slash = notePath.lastIndexOf('/')
  const dir = slash >= 0 ? notePath.slice(0, slash + 1) : ''
  const base = notePath.slice(slash + 1).replace(/\.md$/i, '')
  return `${dir}${base}${n > 1 ? ` ${n}` : ''}.canvas`
}

/** 写口的最小面(= window.amadeus 的两个方法;单测注入假的)。 */
export interface ExportFs {
  readTextFile(path: string): Promise<string | null>
  writeTextFile(path: string, text: string, opts?: { create?: boolean }): Promise<void | { ok: true } | { ok: false; current: string | null }>
}

/** 写到同目录 `<笔记名>.canvas`,**绝不覆盖**:用宿主原子的仅新建(`create:true`),重名依次试 ` 2`、` 3`…。
 *  配方与 writeSafety 的冲突副本同一套:先读预查(不认 create 的旧宿主会照写 —— 预查为空才发);
 *  宿主说已存在 → 下一个编号;说没建成又拿不出现文 → 抛(调用方报错,不许当成功)。返回实际写成的路径。 */
export async function writeJsonCanvas(fs: ExportFs, notePath: string, text: string): Promise<string> {
  for (let n = 1; n <= 50; n++) {
    const candidate = canvasExportPath(notePath, n)
    if ((await fs.readTextFile(candidate).catch(() => null)) != null) continue
    const r = await fs.writeTextFile(candidate, text, { create: true })
    if (r && r.ok === false) {
      if (r.current != null) continue
      throw new Error(`Could not create ${candidate}`)
    }
    return candidate
  }
  throw new Error('Too many exported canvases with the same name')
}
