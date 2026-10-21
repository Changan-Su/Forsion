/** 日历成员制 + 旧数据一次性迁移的统一入口。CalendarView / TodoListView / CalendarConfigView 共用,
 *  避免各自散落 `type==='calendarDate'` 的隐式识别。agent:// 只读源不在此(调用方另并 useAgentCalDbs)。 */
import { useEffect, useMemo } from 'react'
import { usePageStore } from './pageStore'
import { dbBusy, useDbStore } from './dbStore'
import { HUMAN_CAL, humanCalLegacy, readHumanCal } from './humanCalendarIo'
import { useCalendarConfig, memberOf, isMigrated } from './calendarConfigStore'
import {
  getAggDb,
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

  const human = useHumanCalDb()
  return useMemo(() => withHumanCal(human, resolveCalendarMembers(all, vault, byVault), vault), [human, all, byVault, vault])
}

/** 回到窗口时调:别的设备同步下来 / 引擎镜像合进来的改动先悄悄比一下版本,变了才重读(重读那一下条目是「加载中」,每次都重读整本日历会闪);
 *  有没落盘的改动时不重读(会把写进去还没确认的改动再重放一遍,Codex 评审);上次没读到(引擎还没起来)就重试。 */
export async function refreshHumanCal(): Promise<void> {
  const store = useDbStore.getState
  const cur = store().entries[HUMAN_CAL]
  if (cur?.status === 'missing') { await store().load(HUMAN_CAL, HUMAN_CAL); return }
  if (cur?.status !== 'ok' || dbBusy(HUMAN_CAL)) return
  const fresh = await readHumanCal()
  if (fresh.status === 'ok' && !dbBusy(HUMAN_CAL) && fresh.version !== store().entries[HUMAN_CAL]?.version) await store().reloadByPath(HUMAN_CAL)
}

/** 默认日历 human/CALENDAR.db 的 AggDb;引擎不在本机 / 还没读到 = null。库一换(dbStore 整片作废)就重读。 */
export function useHumanCalDb(): AggDb | null {
  const entry = useDbStore((s) => s.entries[HUMAN_CAL])
  const gen = useDbStore((s) => s.gen)
  useEffect(() => watchHumanCal(), [gen])
  return useMemo(() => (entry?.status === 'ok' ? getAggDb(HUMAN_CAL) : null), [entry])
}

/** Non-React consumers share the same bounded load/focus lifecycle as native views. */
export function watchHumanCal(): () => void {
  const store = useDbStore.getState
  let generation = store().gen
  const load = (): void => { void store().load(HUMAN_CAL, HUMAN_CAL) }
  load()
  const onFocus = (): void => { void refreshHumanCal() }
  window.addEventListener('focus', onFocus)
  const off = useDbStore.subscribe((s) => { if (s.gen !== generation) { generation = s.gen; load() } })
  const retries = [3_000, 10_000, 30_000].map((ms) => setTimeout(() => { if (store().entries[HUMAN_CAL]?.status === 'missing') load() }, ms))
  return () => { off(); window.removeEventListener('focus', onFocus); retries.forEach(clearTimeout) }
}

/** 默认日历排第一(没设过默认库时新建事件就落在这里);旧位置镜像的那份(默认笔记库根上的 Calendar.db)不再重复列出。
 *  Native views and calendar-capable plugins use this same projection. */
export function withHumanCal(human: AggDb | null, members: CalMemberDb[], vault: string): CalMemberDb[] {
  if (!human) return members
  const dateCol = firstDateCol(human)?.id
  if (!dateCol) return members
  const legacy = humanCalLegacy()
  const abs = (p: string): string => `${vault.replace(/[\\/]+$/, '')}/${p}`.replace(/\\/g, '/')
  const rest = legacy ? members.filter((m) => abs(m.db.path) !== legacy.replace(/\\/g, '/')) : members
  return [{ db: human, dateCol, checkboxCol: firstCheckboxCol(human)?.id }, ...rest]
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
