/** ctx.calendar 的 'calendar' 能力档(2026-10-17;manifest 声明了才注入,接线在 pluginStore,ensureMember 那一档人人有)。
 *  读:叠加源(Agent 日程 / .ics 订阅 / 另一侧库)+ 日历设置(成员、颜色、显隐、默认表)。叠加源与日历视图共用同一份
 *  store 和计时器(acquireAgentSchedulePolling / startIcsRefresh / watchOtherSideCal),订阅期间持有、退订或插件停用时释放。
 *  写:与日历左栏同一组 store 动作(calendarConfigStore),按当前库生效。成员解析与日历视图同一个函数(resolveCalendarMembers)。 */
import { colorForDb, defaultDbPath, isHidden, memberOf, useCalendarConfig } from '../store/calendarConfigStore'
import { resolveCalendarMembers } from '../store/calendarMembers'
import { getAggDb, isCheckboxCol, isDateCol, watchAllDatabases, type AggDb } from '../store/dbAggregateStore'
import { usePageStore } from '../store/pageStore'
import { acquireAgentSchedulePolling, agentScheduleDbs, useAgentSchedules } from '../../stores/agentScheduleStore'
import { icsCalDbsNow, startIcsRefresh, useIcsCalendars } from '../../stores/icsCalendarStore'
import { useOtherSideCal, watchOtherSideCal } from '../../stores/otherVaultCalStore'
import { normalizeVaultRel } from './pluginAutomation'
import { toDb, type DataScope } from './pluginData'
import type { PluginCalendarOverlay, PluginCalendarSnapshot, PluginContext } from './types'

type CalendarApi = Omit<Required<NonNullable<PluginContext['calendar']>>, 'ensureMember'>

const HEX = /^#[0-9a-f]{6}$/i

/** 叠加源,顺序同日历左栏的图例(Agent → 另一侧 → .ics):调色板色按这个顺序取,和宿主图例对得上。 */
function overlaysNow(): Array<{ db: AggDb; origin: PluginCalendarOverlay['origin'] }> {
  const agent = useAgentSchedules.getState().schedules
  return [
    ...agentScheduleDbs(Array.isArray(agent) ? agent : []).map((db) => ({ db, origin: 'agent' as const })),
    ...useOtherSideCal.getState().dbs.map((db) => ({ db, origin: 'otherVault' as const })),
    ...icsCalDbsNow().map((db) => ({ db, origin: 'ics' as const })),
  ]
}

function snapshotOf(dbs: AggDb[], ready: boolean): PluginCalendarSnapshot {
  const vault = usePageStore.getState().vaultRoot ?? ''
  const byVault = useCalendarConfig.getState().byVault
  const members = resolveCalendarMembers(dbs, vault, byVault)
  const overlays = overlaysNow()
  const colors: Record<string, string> = {}
  ;[...members.map((m) => m.db), ...overlays.map((o) => o.db)].forEach((db, i) => { colors[db.path] = colorForDb(vault, byVault, db.path, i) })
  return {
    ready,
    members: members.map((m) => ({ path: m.db.path, dateCol: m.dateCol, ...(m.checkboxCol ? { checkboxCol: m.checkboxCol } : {}) })),
    overlays: overlays.map(({ db, origin }) => ({ ...toDb(db), origin, ...(db.vaultLabel ? { vaultLabel: db.vaultLabel } : {}) })),
    colors,
    hidden: [...(byVault[vault]?.hidden ?? [])],
    defaultPath: defaultDbPath(vault, byVault),
  }
}

export function createCalendarApi(scope: DataScope): CalendarApi {
  // 设置按 vaultRoot 存(calendarConfigStore 的键),不是 pluginData 的 `side:root` —— 键对不上,插件改的颜色宿主看不见。
  const vault = (): string | null => (scope.alive() ? usePageStore.getState().vaultRoot : null)
  const path = (p: unknown): string => (typeof p === 'string' ? normalizeVaultRel(p) : '')
  const table = (p: string): AggDb | null => (p ? getAggDb(p) : null)
  const isOverlay = (p: string): boolean => !!p && overlaysNow().some((o) => o.db.path === p)
  // 颜色 / 显隐:库里的表或当前的叠加源(叠加源的路径是 agent:// / ics:// / otherside:,不归一,原样比)
  const legendPath = (raw: unknown): string => {
    const p = path(raw)
    if (table(p)) return p
    return typeof raw === 'string' && isOverlay(raw) ? raw : ''
  }
  const member = (v: string, db: AggDb): boolean => resolveCalendarMembers([db], v, useCalendarConfig.getState().byVault).length > 0

  return {
    subscribe: (cb) => {
      if (!scope.alive() || typeof cb !== 'function') return () => {}
      let dbs: AggDb[] = []
      let ready = false
      let live = false
      let last: unknown[] = []
      const emit = (): void => {
        if (!live || !scope.alive()) return
        // 只在输入真变了时回调:.ics 的 loading 位、另一侧 store 的无关字段变化不该把整份快照推一遍
        const sig = [dbs, ready, usePageStore.getState().vaultRoot, useCalendarConfig.getState().byVault,
          useAgentSchedules.getState().schedules, useOtherSideCal.getState().dbs, useIcsCalendars.getState().subs, useIcsCalendars.getState().events]
        if (sig.length === last.length && sig.every((x, i) => x === last[i])) return
        last = sig
        try { cb(snapshotOf(dbs, ready)) } catch (e) { console.error('[amadeus] ctx.calendar 回调抛错', e) }
      }
      const offs = [
        acquireAgentSchedulePolling(), startIcsRefresh(), watchOtherSideCal(),
        watchAllDatabases((d, r) => { dbs = d; ready = r; emit() }),
        useCalendarConfig.subscribe(emit), useAgentSchedules.subscribe(emit), useIcsCalendars.subscribe(emit), useOtherSideCal.subscribe(emit),
      ]
      live = true
      emit()
      return scope.own(() => { live = false; for (const off of offs) off() })
    },
    setColor: (raw, color) => {
      const v = vault()
      const p = v ? legendPath(raw) : ''
      if (!v || !p) return false
      if (color === null) { useCalendarConfig.getState().clearColor(v, p); return true }
      if (typeof color !== 'string' || !HEX.test(color)) return false
      useCalendarConfig.getState().setColor(v, p, color.toLowerCase())
      return true
    },
    setHidden: (raw, hidden) => {
      const v = vault()
      const p = v ? legendPath(raw) : ''
      if (!v || !p || typeof hidden !== 'boolean') return false
      if (isHidden(v, useCalendarConfig.getState().byVault, p) !== hidden) useCalendarConfig.getState().toggleHidden(v, p)
      return true
    },
    setDefault: (raw) => {
      const v = vault()
      const db = v ? table(path(raw)) : null
      if (!v || !db || db.readonly || !member(v, db)) return false
      useCalendarConfig.getState().setDefault(v, db.path)
      return true
    },
    setMember: (raw, dateCol, checkboxCol) => {
      const v = vault()
      const db = v ? table(path(raw)) : null
      if (!v || !db || db.readonly) return false
      const date = db.columns.find((c) => c.id === dateCol)
      if (!date || !isDateCol(date)) return false
      if (checkboxCol !== undefined) {
        const check = db.columns.find((c) => c.id === checkboxCol)
        if (!check || !isCheckboxCol(check)) return false
      }
      useCalendarConfig.getState().addMember(v, db.path, date.id, checkboxCol)
      return true
    },
    removeMember: (raw) => {
      const v = vault()
      const p = v ? path(raw) : ''
      if (!v || !p || !memberOf(v, useCalendarConfig.getState().byVault, p)) return false
      useCalendarConfig.getState().removeMember(v, p)
      return true
    },
  }
}
