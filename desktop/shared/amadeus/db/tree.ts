/** 表格「层级树」(DbView.treeCol)的纯逻辑:按自指关联列(cell = 父行 id)把行摊成带缩进的一条序列。
 *  渲染层 DatabaseEmbed 消费;不在引擎 sync-db-shared 的 FILES 表里(引擎不渲染表格)。
 *
 *  ⚠️ 铁律:**任何输入下 nodes.length === rows.length**(绝不丢行)。所以形状一有问题就整体退回平铺,
 *  而不是「丢掉坏的那几行」:环(A→B→A / 自指)、深度超上限、重复行 id —— 三者任一命中 → flat=true,
 *  全部 depth 0。tree.test.ts 的模糊用例把这条不变式当机器判据钉住。
 *
 *  ⚠️ 输入 rows 是**筛选 + 排序之后**的行:兄弟节点保持输入序,所以「用户排序只在兄弟间生效」是自动成立的,
 *     不需要渲染层再做什么。
 *
 *  ⚠️ **孤儿(父 id 不在本行集里)当根,不退平铺**(Notion 那套;2026-09-02 编排者裁决,推翻首版的「四者任一
 *     退平铺」)。理由:树视图下筛选与搜索是常态 —— 标题搜索、或任何筛掉了父行的筛选,都会造出孤儿;
 *     「有一个孤儿就把整棵树压平」等于**搜索一次功能就退化一次**,哪怕只有一个孤儿、其余子树完好。
 *     孤儿当根时行数守恒同样成立(它只是少一条父边,仍在森林里),完好子树保住缩进,代价只是用户会看到
 *     一个「父不在场的根」—— 那正是筛选结果该有的样子。环 / 超深 / 重复 id 三条**维持退平铺不变**:那三样
 *     是数据本身坏了,不是筛选的正常产物。孤儿仍然可观测(TreeResult.orphanIds),只是不再触发平铺。 */
import type { CellValue } from './schema'

/** 深度上限(**渲染缩进**的上限,根 = 0;孤儿也是根 = 0)。无环时深度天然 ≤ 行数,这条只是对病态数据的第二道闸。
 *  ⚠️ 孤儿当根后「深度从哪起算」= **从孤儿自己起算**:被筛掉的祖先根本不上屏,不占缩进,自然不该计入。
 *  由此(数学上)重新扎根只会**减少**深度、只会**删边**:所以筛选既不可能凭空造出环,也不可能把一张原本
 *  不超深的表筛成超深 —— 这道闸在筛选下比不筛时更难命中,不是更容易。 */
export const MAX_TREE_DEPTH = 32

export interface TreeNode<R> {
  row: R
  /** 根 = 0。 */
  depth: number
  /** 本行在**本行集内**有子节点(折叠钮据此显示)。 */
  hasKids: boolean
}

/** 退回平铺的原因:off = 没配树列(不是异常);lost = 不该发生的兜底(见 buildTree 末尾)。
 *  ⚠️ 没有 'orphan' —— 孤儿当根,**不是**退平铺的理由(见文件头裁决)。 */
export type TreeFallback = 'off' | 'dup' | 'cycle' | 'depth' | 'lost'

export interface TreeResult<R> {
  nodes: Array<TreeNode<R>>
  /** true = 平铺(全部 depth 0、hasKids 全 false)。 */
  flat: boolean
  /** flat 的原因;flat=false 时恒 null。 */
  reason: TreeFallback | null
  /** 父链爬不到根(命中环)的行 id,按输入序;无环 = []。 */
  cycleIds: string[]
  /** 孤儿(父 id 非空但不在本行集里 —— 含被筛选/搜索掉的父)的行 id,按输入序。
   *  **不影响 flat**:这些行当根渲染(flat=false 时它们的 depth 恒 0)。给体检/仪器观测用
   *  (check:rowlink 之类将来可据此判「这张表有多少行的父被筛没了」)。
   *  ⚠️ 口径:父指针那一趟跑过之后才有值 —— 所以 reason='off'(没配树列)与 'dup'(重复行 id,
   *  在这趟之前就退了)恒为 [];'cycle' / 'depth' / 'lost' 三种平铺仍照实带出(平铺与孤儿可同时成立)。 */
  orphanIds: string[]
}

interface TreeRowLike {
  id: string
  cells: Record<string, CellValue>
}

/** 父行 id 提取(rowlink cell:单选存 string、多选存 string[])。
 *  ponytail: 多值关联当父列时**只取第一个** id —— 多父就是 DAG 不是树,后面的忽略(不报错、不丢行)。
 *  数字 / 布尔 / null / 缺键一律当「无父」(= 根),与 rowLink.rowLinkIds 对脏值的口径一致。 */
export function parentIdOf(v: CellValue | undefined): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.find((x) => typeof x === 'string' && !!x) ?? ''
  return ''
}

/** 摊平成 `{row, depth, hasKids}[]`(前序:父在前,其子紧随)。treeCol 缺 = 直接平铺(reason='off')。 */
export function buildTree<R extends TreeRowLike>(rows: R[], treeCol: string | undefined | null): TreeResult<R> {
  /** 孤儿:父指针那一趟往里填,之后只读。flatOf 拷一份带出去(平铺了也要能看见有几个孤儿)。 */
  const orphanIds: string[] = []
  const flatOf = (reason: TreeFallback, cycleIds: string[] = []): TreeResult<R> => ({
    nodes: rows.map((row) => ({ row, depth: 0, hasKids: false })),
    flat: true,
    reason,
    cycleIds,
    orphanIds: orphanIds.slice(),
  })
  if (!treeCol) return flatOf('off')

  // 重复行 id:后面任何按 id 建的 Map 都会吞掉一行 → 干脆先平铺(数据本身已坏,不是树的问题)
  const byId = new Map<string, R>()
  for (const r of rows) {
    if (byId.has(r.id)) return flatOf('dup')
    byId.set(r.id, r)
  }

  // 父指针 + 孤儿判定:非空父 id 在**本行集**里找不到 = 孤儿(含被筛选/搜索掉的父)。
  // 孤儿**不设父指针** → 下面收根时它自然落进 roots(depth 0),整棵子树跟着保住缩进。见文件头裁决。
  const parent = new Map<string, string>()
  for (const r of rows) {
    const p = parentIdOf(r.cells[treeCol])
    if (!p) continue
    if (!byId.has(p)) { orphanIds.push(r.id); continue } // 孤儿 → 当根(不再退平铺)
    parent.set(r.id, p)
  }

  // 环:沿父指针爬到根。safe = 已确认能爬到根的 id(记忆化,避免长链退化成 O(n²))。
  const cycleIds: string[] = []
  const safe = new Set<string>()
  for (const r of rows) {
    const path: string[] = []
    let cur: string | undefined = r.id
    let hit = false
    while (cur !== undefined && !safe.has(cur)) {
      if (path.includes(cur)) { hit = true; break } // path 长度 = 链深,includes 足够
      path.push(cur)
      cur = parent.get(cur)
    }
    if (hit) cycleIds.push(r.id)
    else for (const id of path) safe.add(id)
  }
  if (cycleIds.length) return flatOf('cycle', cycleIds)

  // 子表:兄弟保持输入序(= 视图筛选/排序后的序)。roots = 真·无父行 + 孤儿(父被筛没了的行)。
  const kids = new Map<string, R[]>()
  const roots: R[] = []
  for (const r of rows) {
    const p = parent.get(r.id)
    if (p === undefined) { roots.push(r); continue }
    const a = kids.get(p)
    if (a) a.push(r)
    else kids.set(p, [r])
  }

  // 前序展开用显式栈(不递归:深链不炸调用栈)
  const nodes: Array<TreeNode<R>> = []
  const stack: Array<{ row: R; depth: number }> = []
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ row: roots[i], depth: 0 })
  while (stack.length) {
    const { row, depth } = stack.pop() as { row: R; depth: number }
    if (depth > MAX_TREE_DEPTH) return flatOf('depth')
    const ks = kids.get(row.id)
    nodes.push({ row, depth, hasKids: !!ks?.length })
    if (ks) for (let i = ks.length - 1; i >= 0; i--) stack.push({ row: ks[i], depth: depth + 1 })
  }

  // 无环时展开必然覆盖全部行(每行要么无父、要么是孤儿根、要么是某个在场父的子);
  // 万一没覆盖(逻辑 bug)也**绝不丢行** —— 退平铺而不是交一份短了的表。
  if (nodes.length !== rows.length) return flatOf('lost')
  return { nodes, flat: false, reason: null, cycleIds: [], orphanIds }
}
