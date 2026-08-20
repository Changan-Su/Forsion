// 白板元素(`amadeus_canvas.elements`)的写侧:纯函数,零 DOM、零 React。
//
// ⚠️ 唯一一条不许破的纪律:**一切写操作都作用在磁盘上的原始条目对象上**,绝不拿
// `safeElements()` 的结果回吐。那一步是**渲染用的收窄视图** —— 它按类型重建条目,丢掉
// 认不出的条目、也丢掉条目里的未知字段(迁移带过来的 `note`、将来别的端写的键)。拿它当写侧
// 基底的话,用户每挪动一次形状,全篇的未来字段就被吞一遍 —— 正是方案 §8「老端绝不吞新端的
// 元素」明令禁止的那件事,而且**静默**(界面上一切照常,只有文件被削了)。
// 所以这里全部签名吃 `unknown[]` 吐 `unknown[]`:认不出的条目原位留着,只有被点名的那一条
// 按键 patch。仪器 C19 直接钉这条(移动带未知字段的形状后,`"note"` 与顶层 `futureKey` 逐字还在)。
export type RawEl = Record<string, unknown>

/** 条目 id(对象 + 非空字符串 id 才算);认不出 → null,调用方一律「跳过但保留」。 */
function idOf(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const v = (item as RawEl).id
  return typeof v === 'string' && v ? v : null
}

/** 端点里的形状 id(`{id}` 形态);`{ref}`(卡锚)一律返回 null —— 两个命名空间。 */
function endShapeId(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null
  const id = (v as { id?: unknown }).id
  return typeof id === 'string' && id ? id : null
}

export function rawList(v: unknown): unknown[] {
  return Array.isArray(v) ? [...v] : []
}

/** 按 id 局部 patch(只覆盖 patch 里点名的键,其余逐字保留)。 */
export function patchElement(list: unknown[], id: string, patch: RawEl): unknown[] {
  return list.map((it) => (idOf(it) === id ? { ...(it as RawEl), ...patch } : it))
}

/** 删除一批元素;**顺手剪掉端点落在被删形状上的连线**(同一笔写盘 → 撤销时一起回来)。
 *  ⚠️ 端点是卡锚(`{ref}`)的连线一个都不碰:卡片的删除走 PM 事务,那边的剪枝必须与那笔事务
 *  同生共死(见 canvasElements 顶注)—— 在这里越权剪,撤销删卡时连线不会回来。 */
export function removeElements(list: unknown[], ids: ReadonlySet<string>): unknown[] {
  const gone = new Set<string>()
  const kept = list.filter((it) => {
    const i = idOf(it)
    if (i && ids.has(i)) {
      gone.add(i)
      return false
    }
    return true
  })
  if (!gone.size) return kept
  return kept.filter((it) => {
    if (!it || typeof it !== 'object' || (it as RawEl).type !== 'connector') return true
    const o = it as RawEl
    const a = endShapeId(o.from)
    const b = endShapeId(o.to)
    return !((a && gone.has(a)) || (b && gone.has(b)))
  })
}

/** 整批平移(只动**有数值 x/y** 的条目 —— 连线没有自己的几何,跟着端点走)。 */
export function moveElements(list: unknown[], ids: ReadonlySet<string>, dx: number, dy: number): unknown[] {
  return list.map((it) => {
    const id = idOf(it)
    if (!id || !ids.has(id)) return it
    const o = it as RawEl
    if (typeof o.x !== 'number' || typeof o.y !== 'number') return it
    return { ...o, x: Math.round(o.x + dx), y: Math.round(o.y + dy) }
  })
}

/** 新元素 id:`<前缀><递增数字>`,避开**本表已用的一切 id**(不看卡锚:端点靠 `{ref}`/`{id}` 消歧,
 *  两个命名空间不会撞;而 safeElements 的去重是按 id 全表做的,同表内唯一才是真约束)。 */
export function freshElId(list: unknown[], prefix: string): string {
  const used = new Set<string>()
  for (const it of list) {
    const i = idOf(it)
    if (i) used.add(i)
  }
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`
    if (!used.has(id)) return id
  }
}

/** 主卡的哨兵键:既是舞台的选中键,也是层级里的**主卡父键**(2026-08-19)。渲染层从这里转出。 */
export const MAIN_KEY = 'm:'

export const SHAPE_SIZE = { rect: { w: 200, h: 120 }, ellipse: { w: 180, h: 120 }, text: { w: 180, h: 40 } } as const
/** Frame 的默认尺寸(工具栏点一下 / 右键新建时用;拖出来的以拖为准)。 */
export const FRAME_SIZE = { w: 480, h: 320 } as const
export type ShapeKind = keyof typeof SHAPE_SIZE

/** 新形状/文本条目(**显式盒**:x/y 是左上角)。字段名与迁移产物(canvasMigrate)完全一致 ——
 *  磁盘格式只有一套。拖拽画出来的形状走这条(2026-08-19)。 */
export function newShapeBox(id: string, kind: ShapeKind, b: { x: number; y: number; w: number; h: number }): RawEl {
  return {
    id,
    type: kind === 'text' ? 'text' : 'shape',
    ...(kind === 'text' ? {} : { shape: kind }),
    x: Math.round(b.x),
    y: Math.round(b.y),
    w: Math.round(b.w),
    h: Math.round(b.h),
    ...(kind === 'text' ? { text: '文本' } : {}),
  }
}

/** 新形状(**点击建**:x/y 是中心,尺寸取默认)。 */
export function newShape(id: string, kind: ShapeKind, x: number, y: number): RawEl {
  const d = SHAPE_SIZE[kind]
  return newShapeBox(id, kind, { x: x - d.w / 2, y: y - d.h / 2, w: d.w, h: d.h })
}

/** 端点:选中键 `c:<卡锚>` → `{ref}`,`e:<元素id>` → `{id}`,`m:` (主卡) → `{main:true}`。
 *  ⚠️ `{main}` 是 2026-08-18 新增的第三形态:老端的 safeElements 认不出 → 那条连线**不画但
 *  一个字节不动**(写侧恒作用于原始条目),正是方案 §8 要的前向兼容。 */
export function endpointOf(key: string): RawEl | null {
  if (key === 'm:') return { main: true }
  if (key.startsWith('c:')) return { ref: key.slice(2) }
  if (key.startsWith('e:')) return { id: key.slice(2) }
  return null
}

/** 连线;两端相同或已有同一对端点(无向)→ 返回原表(与插件 completeEdge 同口径)。 */
export function addConnector(list: unknown[], fromKey: string, toKey: string): unknown[] {
  if (fromKey === toKey) return list
  const from = endpointOf(fromKey)
  const to = endpointOf(toKey)
  if (!from || !to) return list
  const same = (a: RawEl, b: unknown): boolean => {
    const o = b as RawEl | undefined
    return !!o && o.ref === a.ref && o.id === a.id
  }
  const dup = list.some((it) => {
    if (!it || typeof it !== 'object' || (it as RawEl).type !== 'connector') return false
    const o = it as RawEl
    return (same(from, o.from) && same(to, o.to)) || (same(from, o.to) && same(to, o.from))
  })
  if (dup) return list
  return [...list, { id: freshElId(list, 'e'), type: 'connector', from, to }]
}

/** 文字/标签:空串 = 删键(而不是写 `text: ""` —— 磁盘上多一个空键,读侧还得当有文字处理)。 */
export function setElementText(list: unknown[], id: string, key: 'text' | 'label' | 'title', text: string): unknown[] {
  return list.map((it) => {
    if (idOf(it) !== id) return it
    const next = { ...(it as RawEl) }
    if (text) next[key] = text
    else delete next[key]
    return next
  })
}

// ── 节点层级(`amadeus_canvas.tree`,2026-08-18)────────────────────────────────────────
// 形态是最小的:`{ 子卡锚: 父卡锚 }`。父位还可以是主卡的哨兵键 `m:`(2026-08-19,主卡也能长子节点)——
// 锚的字符集是 `[A-Za-z0-9_-]`,冒号不在里面,所以这枚哨兵**永远撞不上真锚**,setParent/pruneTree/
// childrenOf 一行都不用改(它们只做字符串等值比较)。旧端读到 `m:` 只是画不出那条线,数据不丢。
// 为什么不存邻接表/不存 children 数组 —— 一个子节点只有一个
// 父节点,反向映射是这个事实的**最紧表示**,天然免疫「A 的 children 里有 B、B 的 parent 却是 C」
// 这类只能靠校验维持的不一致。画出来的层级线是它的**呈现**,不另存一份连线条目(同一件事存两份
// 必然分叉:手动删掉线 ≠ 解除父子)。

/** 磁盘上那份 tree 的原始对象(未校验)→ 可写的浅拷贝;认不出的一律当空表。
 *  ⚠️ 两条都不是洁癖(Codex 评审 P2-1):
 *   · **必须 `Object.create(null)`**:卡锚的字符集允许 `__proto__`,写进普通字面量对象会命中原型
 *     setter 而不是建自有属性 —— 那一条关系当场蒸发,而 `withTree` 又是整表替换,盘上那份跟着没。
 *   · **值不是字符串也照样留着**:tree 与 elements 同待遇(读侧不校验、渲染侧才收窄),
 *     过滤掉别的端写的新形态 = 老端吞新端的数据,正是方案 §8 明令禁止的。 */
export function rawTree(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const k of Object.keys(v as object)) out[k] = (v as Record<string, unknown>)[k]
  return out
}

/** 认爹。自环直接拒绝;**成环也拒绝**(顺着 parent 往上能走回 child 就是环)——
 *  环本身不会让渲染死循环(层级线是逐条画的,不递归),但会让「找根/算兄弟」这类遍历永远转下去。 */
export function setParent(tree: Record<string, unknown>, child: string, parent: string): Record<string, unknown> {
  if (!child || !parent || child === parent) return tree
  let p: unknown = parent
  const seen = new Set<string>([child])
  while (typeof p === 'string' && p) {
    if (seen.has(p)) return tree
    seen.add(p)
    p = tree[p]
  }
  const out = rawTree(tree)
  out[child] = parent
  return out
}

/** 卡片没了 → 把与它相关的父子关系剪掉。
 *  ⚠️ 被删卡的**子节点直接认祖父**(而不是一起孤立):删中间一层是常规操作,断掉整条支脉不是用户的本意。 */
export function pruneTree(tree: Record<string, unknown>, gone: ReadonlySet<string>): Record<string, unknown> {
  if (!gone.size) return tree
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const child of Object.keys(tree)) {
    if (gone.has(child)) continue
    let p: unknown = tree[child]
    const seen = new Set<string>()
    while (typeof p === 'string' && gone.has(p) && !seen.has(p)) {
      seen.add(p)
      p = tree[p]
    }
    // ⚠️ `p === child` 必须丢掉:盘上若是一条环(`{x:'a',a:'x'}`),删 a 时顺着往上正好走回 x,
    //    写出去就是一条自环。读侧的 safeTree 会把它藏起来,于是**盘上有、界面上看不见**(Codex P2-2)。
    if (typeof p !== 'string' || !p || gone.has(p) || p === child) continue
    out[child] = p
  }
  return out
}

/** 某个节点的直接子节点(按锚字典序,稳定次序 = 新子节点的摆位可复现)。 */
export const childrenOf = (tree: Record<string, unknown>, parent: string): string[] =>
  Object.keys(tree).filter((c) => tree[c] === parent).sort()

/** `node` 是不是 `ancestor` 的**真后代**(自己不算)。父值认不出(非字符串 / 主卡哨兵 / 指向不存在的
 *  卡)就是一条走到头的链,返回 false。环由 seen 兜底 —— setParent 已拒环,但盘上那份是外部可改的。 */
export function isUnder(tree: Record<string, unknown>, node: string, ancestor: string): boolean {
  if (!node || !ancestor || node === ancestor) return false
  const seen = new Set<string>([node])
  let p: unknown = tree[node]
  while (typeof p === 'string' && p && !seen.has(p)) {
    if (p === ancestor) return true
    seen.add(p)
    p = tree[p]
  }
  return false
}

/** 层级深度 = 文档模式的缩进档位(2026-08-19 用户拍板「有父子属性的 Card 嵌套包裹」)。
 *  `alive` = 本篇 doc 里**真实存在**的卡锚。父不在其中的一律停在这一层 —— 主卡哨兵 `m:`、
 *  手改坏的值、指向已删卡的悬空父,统统算「没有爹」→ 深度 0 = **自由卡不包裹**(用户第二句话)。
 *  ⚠️ 与 deriveCanvasJson 的剪枝同一条纪律:认不出的父值既不当错误、也不当层级,只是没有爹。
 *  ⚠️ 主卡的子节点故意也算 0:文档模式下主卡就是正文本身,它的子卡「已经在它里面」,再缩进
 *     等于把整篇正文的直属卡全体右推一格,没有信息量。
 *  `cap` 是缩进档位上限(不是环保护,环由 seen 管):再深就只是把卡越推越窄。 */
export function depthOf(tree: Record<string, unknown>, node: string, alive: ReadonlySet<string>, cap = 6): number {
  let d = 0
  const seen = new Set<string>([node])
  let p: unknown = tree[node]
  while (typeof p === 'string' && p && alive.has(p) && !seen.has(p) && d < cap) {
    d++
    seen.add(p)
    p = tree[p]
  }
  return d
}

/** 新 Frame(2026-08-18)。`title` 空着由渲染侧兜底成 "Frame" —— 空串不写键(与 setElementText 同口径)。 */
export function newFrame(id: string, x: number, y: number, w: number, h: number, title?: string): RawEl {
  const out: RawEl = { id, type: 'frame', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
  if (title) out.title = title
  return out
}
