// ⚠️ vendor 自 desktop/shared/amadeus/db/lookup.ts(scripts/sync-db-shared.mjs 生成),勿手改;
// 改源文件后跑 npm run sync:db-shared,typecheck 里的 --check 会抓漂移。
/** 引用列(lookup)物化:纯函数、无 React,渲染层(DatabaseEmbed compRows)与引擎(museTriggers 物化)共用同一份。
 *
 *  两种模式(判据 = 列上有 `refDb` **且** `lookupBackCol` → 反向;否则正向):
 *  - 正向:沿本表 `lookupRel` 指向的 rowlink 列找到目标行(cell 为 string = 一行;string[] = 多行),
 *    取目标行的 `lookupCol` 值 → `computeLookup(values, lookupAgg)`。
 *  - 反向(rollup):扫 `refDb` 全表,凡其 `lookupBackCol` 单元格(string 或 string[])含本行 id 的行,
 *    取 `lookupCol` 值 → 聚合。
 *
 *  目标列取值规则(三条路径共用一个 valueOf,别各写各的):
 *  - 目标列是 formula:磁盘 cell 里没有它的值,先把目标行公式物化了再读;
 *  - 目标列是 lookup:给 null(一跳截断,跨库链会引出环,不追);
 *  - 其余:直接读 cell(缺 = null)。
 *
 *  反向模式的第三种用法:`lookupKind='links'`(可编辑投影列,见 db/backlink.ts)—— 值 = 命中行的**原始 id 数组**
 *  (不聚合、不 join 文案,lookupCol/lookupAgg 忽略),渲染层照 rowlink cell 的形状消费。
 *
 *  只返回 lookup 列的值 `{ 列id → 值 }`;本行自己的公式列由调用方随后 evalRowFormulas
 *  (lookup 必须**先于**公式跑,公式才能引用 lookup 结果)。结果只进呈现管道,绝不落盘。 */
import { computeLookup, evalRowFormulas, type EvalOpts } from './dbFormula.js'
import { backLinkRows } from './dbBacklink.js'
import type { CellValue, DbColumn, DbFile, DbRow } from './amadeusDb.js'

/** 反向模式判据(ColMenu 配置面与引擎按同一条分支)。 */
export const isBackLookup = (c: DbColumn): boolean => !!c.refDb && !!c.lookupBackCol

export function computeRowLookups(
  db: DbFile,
  row: DbRow,
  getDb: (path: string) => DbFile | null,
  opts: EvalOpts = {},
): Record<string, CellValue> {
  const out: Record<string, CellValue> = {}
  const lookupCols = db.columns.filter((c) => c.type === 'lookup')
  if (!lookupCols.length) return out

  /** 目标行的目标列取值(formula 先物化 / lookup 截断 / 其余直读)。 */
  const valueOf = (target: DbFile, hit: DbRow, tCol: DbColumn): CellValue =>
    tCol.type === 'formula' ? (evalRowFormulas(target.columns, hit.cells, opts)[tCol.id] ?? null)
    : tCol.type === 'lookup' ? null
    : (hit.cells[tCol.id] ?? null)

  for (const c of lookupCols) {
    let target: DbFile | null = null
    let hits: DbRow[] = []
    if (isBackLookup(c)) {
      target = getDb(c.refDb as string)
      // 反向 join 单源在 backlink.ts(投影列的读端也是它;O(n·m) 全扫的 ponytail 注在那边)
      if (target) hits = backLinkRows(target, c.lookupBackCol as string, row.id)
      if (c.lookupKind === 'links') {
        // 投影列:原始 id 数组就是值(目标表没到 → 空数组,与「没人指回」同形;渲染层按 rowLinkIds 消费)
        out[c.id] = hits.map((h) => h.id)
        continue
      }
    } else {
      const rel = db.columns.find((x) => x.id === c.lookupRel && x.type === 'rowlink')
      target = rel?.refDb ? getDb(rel.refDb) : null
      const rid = rel ? row.cells[rel.id] : null
      const ids = typeof rid === 'string' && rid ? [rid] : Array.isArray(rid) ? rid : []
      if (target) {
        const t = target
        hits = ids.map((id) => t.rows.find((x) => x.id === id)).filter((x): x is DbRow => !!x)
      }
    }
    const tCol = target && c.lookupCol ? target.columns.find((x) => x.id === c.lookupCol) : null
    const values = target && tCol ? hits.map((h) => valueOf(target as DbFile, h, tCol)) : []
    out[c.id] = computeLookup(values, c.lookupAgg)
  }
  return out
}
