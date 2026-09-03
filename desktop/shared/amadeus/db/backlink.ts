/** 真双向关联的反向侧 = **可编辑投影列**(DbColumn.type='lookup' + lookupKind='links' + refDb + lookupBackCol)的纯逻辑。
 *  无 React,渲染层(DatabaseEmbed 的投影 cell / 专用写口)与引擎(automationDbAction 把「写投影列」翻译成对侧写)共用同一份。
 *
 *  裁决(飞书对齐第二波 W2-A):**真值只存正向侧**——目标表(refDb)里 lookupBackCol 那一列的 rowlink cell;
 *  投影列的值 = 「目标表里哪些行的 backCol 含本行 id」,永远是算出来的,本表磁盘上没有它的 cell。
 *  所以「编辑投影列」= 改**目标表**的 rowlink cell(单文件、一次 mutate,无跨文件事务);否决双写(两边各存一份必漂)。
 *
 *  ⚠️ 这里不叫 rowlink.ts:渲染层已有 blocks/database/rowLink.ts(芯片文案/自引用清理),两个名字不能撞。 */
import type { CellValue, DbColumn, DbFile, DbRow } from './schema'

/** 路径口径归一(与渲染层 rowLink.normDbPath 同算法;shared 不能反向 import 渲染层,就地一行)。 */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

/** rowlink cell → 行 id 列表(单选 string / 多选 string[];其它形态当空)。 */
const idsOf = (v: CellValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : typeof v === 'string' && v ? [v] : []

/** 投影列判据(配置**齐全**才算:半配置态按普通反向 lookup 处理,由 pairIssues 报告)。 */
export const isLinksProjection = (c: DbColumn): boolean =>
  c.type === 'lookup' && c.lookupKind === 'links' && !!c.refDb && !!c.lookupBackCol

/** 目标表里 backCol 含本行 id 的行(反向 join 的原始命中,不聚合;lookup.ts 的反向模式与投影列共用这一条)。
 *  ponytail: O(n) 全扫(每行 × 目标表全行),表到万行再建 id → 行 反向索引。 */
export const backLinkRows = (targetDb: DbFile, backCol: string, rowId: string): DbRow[] =>
  targetDb.rows.filter((r) => idsOf(r.cells[backCol]).includes(rowId))

/** 投影列的值:目标表里哪些行指回本行(原始 id 列表,按目标表行序)。 */
export const backLinkIds = (targetDb: DbFile, backCol: string, rowId: string): string[] =>
  backLinkRows(targetDb, backCol, rowId).map((r) => r.id)

/** 幂等集合运算:让目标表 targetRowId 那行的 backCol「含 / 不含」本行 id,返回**新** rows(行与 cells 都是新对象,
 *  dbAggregateStore 复制/恢复行是浅拷贝 cells,原地改会连带副本);没变化 / 目标行不存在 / backCol 不是 rowlink 列 → null(拒写,不造悬空)。
 *  尊重 backCol 的 multiple:单值列 add = **覆盖**为本行 id(它本来就只能指一行);remove 只在它恰好指向本行时清空。 */
export function backLinkEdit(targetDb: DbFile, backCol: string, rowId: string, targetRowId: string, add: boolean): DbRow[] | null {
  const col = targetDb.columns.find((c) => c.id === backCol)
  if (!col || col.type !== 'rowlink') return null
  const idx = targetDb.rows.findIndex((r) => r.id === targetRowId)
  if (idx < 0) return null
  const row = targetDb.rows[idx]
  const cur = idsOf(row.cells[backCol])
  if (cur.includes(rowId) === add) return null // 幂等:已是目标态
  const cells = { ...row.cells }
  if (add) cells[backCol] = col.multiple ? [...cur, rowId] : rowId
  else {
    const rest = cur.filter((x) => x !== rowId)
    if (!rest.length) delete cells[backCol]
    else cells[backCol] = col.multiple || Array.isArray(row.cells[backCol]) ? rest : rest[0]
  }
  const rows = targetDb.rows.slice()
  rows[idx] = { ...row, cells }
  return rows
}

/** 整格赋值(setCell / 引擎写投影列的口径):让「指回本行」的目标行集合恰好 = targetIds(多的摘、少的加),
 *  逐个走 backLinkEdit;没变化 → null。⚠️ 空数组 = 摘掉全部反向关联(与把 rowlink cell 清空同义)。 */
export function backLinkSet(targetDb: DbFile, backCol: string, rowId: string, targetIds: string[]): DbRow[] | null {
  const want = [...new Set(targetIds)]
  const cur = backLinkIds(targetDb, backCol, rowId)
  let db = targetDb
  let changed = false
  for (const id of want) {
    if (cur.includes(id)) continue
    const rows = backLinkEdit(db, backCol, rowId, id, true)
    if (rows) { db = { ...db, rows }; changed = true }
  }
  for (const id of cur) {
    if (want.includes(id)) continue
    const rows = backLinkEdit(db, backCol, rowId, id, false)
    if (rows) { db = { ...db, rows }; changed = true }
  }
  return changed ? db.rows : null
}

export interface PairIssue {
  colId: string
  /** half = lookupKind='links' 却缺 refDb/lookupBackCol;target-missing = 目标表读不到;
   *  backcol-missing / backcol-not-rowlink / backcol-not-self = 指回列不存在 / 不是关联表列 / 不指回本表。 */
  kind: 'half' | 'target-missing' | 'backcol-missing' | 'backcol-not-rowlink' | 'backcol-not-self'
  detail: string
}

/** 单列体检(渲染层投影 cell 用它决定「渲 chip 还是提示待配置」;pairIssues 逐列调它)。非投影意图的列 → null。 */
export function projectionIssue(col: DbColumn, getDb: (path: string) => DbFile | null, selfPaths: string[]): PairIssue | null {
  if (col.type !== 'lookup' || col.lookupKind !== 'links') return null
  if (!col.refDb || !col.lookupBackCol) return { colId: col.id, kind: 'half', detail: `投影列缺 ${!col.refDb ? '目标表(refDb)' : '指回列(lookupBackCol)'}` }
  const target = getDb(col.refDb)
  if (!target) return { colId: col.id, kind: 'target-missing', detail: `目标表 ${col.refDb} 读不到` }
  const bc = target.columns.find((c) => c.id === col.lookupBackCol)
  if (!bc) return { colId: col.id, kind: 'backcol-missing', detail: `指回列 ${col.lookupBackCol} 在目标表里不存在` }
  if (bc.type !== 'rowlink') return { colId: col.id, kind: 'backcol-not-rowlink', detail: `指回列 ${col.lookupBackCol} 是 ${bc.type} 列,不是关联表列` }
  const self = new Set(selfPaths.map(norm))
  if (!bc.refDb || !self.has(norm(bc.refDb))) return { colId: col.id, kind: 'backcol-not-self', detail: `指回列 ${col.lookupBackCol} 指向 ${bc.refDb ?? '(空)'} 而非本表` }
  return null
}

/** 一张表全部投影列的配置体检(半残 / 指回列不是 rowlink / 不指回本表 …),报告列表,不修复。
 *  selfPaths = 本表的各种路径口径(store path / 嵌入 ref;DbFile 自己不带路径)。 */
export function pairIssues(db: DbFile, getDb: (path: string) => DbFile | null, selfPaths: string[]): PairIssue[] {
  const out: PairIssue[] = []
  for (const c of db.columns) {
    const i = projectionIssue(c, getDb, selfPaths)
    if (i) out.push(i)
  }
  return out
}
