/** 日历成员制 + 旧数据一次性迁移的统一入口。CalendarView / TodoListView / CalendarConfigView 共用,
 *  避免各自散落 `type==='calendarDate'` 的隐式识别。agent:// 只读源不在此(调用方另并 useAgentCalDbs)。 */
import { useEffect, useMemo } from 'react'
import { usePageStore } from './pageStore'
import { useCalendarConfig, memberOf, isMigrated } from './calendarConfigStore'
import {
  useAllDatabases,
  useDatabasesReady,
  firstDateCol,
  firstCheckboxCol,
  type AggDb,
} from './dbAggregateStore'

export interface CalMemberDb {
  db: AggDb
  dateCol: string // 已解析的日期列 id(成员映射优先,列失效则回退首个日期列)
  checkboxCol?: string // 完成/待办勾选列 id(可空;映射失效则清)
}

export function useCalendarMembers(): CalMemberDb[] {
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const all = useAllDatabases()
  const ready = useDatabasesReady()
  const byVault = useCalendarConfig((s) => s.byVault)
  const migrate = useCalendarConfig((s) => s.migrate)
  const migrated = isMigrated(vault, byVault)

  // 一次性迁移:全库 .db 落定后,把「有日期列」的旧库(首个日期列 + 首个勾选列)收编为成员。之后成员全靠显式增删。
  useEffect(() => {
    if (migrated || !ready) return
    migrate(vault, migrationSeeds(all))
  }, [migrated, ready, all, vault, migrate])

  return useMemo(() => resolveCalendarMembers(all, vault, byVault), [all, byVault, vault])
}

/** 一次性迁移的种子:有日期列的可写库(首个日期列 + 首个勾选列)= 迁移前的隐式成员,迁移后解析结果不变。
 *  日历视图(useCalendarMembers)与插件订阅(pluginCalendar)共用。 */
export const migrationSeeds = (all: AggDb[]): Array<{ dbPath: string; dateCol: string; checkboxCol?: string }> => all
  .filter((db) => !db.readonly && firstDateCol(db))
  .map((db) => ({ dbPath: db.path, dateCol: firstDateCol(db)!.id, checkboxCol: firstCheckboxCol(db)?.id }))

/** 成员解析(纯函数):日历视图与插件接缝 ctx.calendar(pluginCalendar.ts)共用,两边看到的成员与日期列一致。
 *  成员映射优先;映射的列失效则回退首个日期列。迁移落定前沿用旧行为(有日期列即入历),防首帧闪空。
 *  ⚠️只解析、不迁移 —— 一次性迁移在 useCalendarMembers 与插件订阅里(库读完后各跑一次,幂等)。 */
export function resolveCalendarMembers(all: AggDb[], vault: string, byVault: Parameters<typeof memberOf>[1]): CalMemberDb[] {
  const migrated = isMigrated(vault, byVault)
  const out: CalMemberDb[] = []
  const push = (db: AggDb, storedDate: string | undefined, storedCheck: string | undefined): void => {
    const dateCol = storedDate && db.columns.some((c) => c.id === storedDate) ? storedDate : firstDateCol(db)?.id
    if (!dateCol) return // 无可用日期列 → 不作为日历库(config 列表的坏成员清理留 Phase 2)
    const checkboxCol = storedCheck && db.columns.some((c) => c.id === storedCheck) ? storedCheck : undefined
    out.push({ db, dateCol, checkboxCol })
  }
  for (const db of all) {
    const m = memberOf(vault, byVault, db.path)
    if (m) push(db, m.dateCol, m.checkboxCol)
    else if (!migrated) push(db, firstDateCol(db)?.id, firstCheckboxCol(db)?.id)
  }
  return out
}
