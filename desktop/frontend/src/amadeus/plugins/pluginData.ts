/** ctx.databases / ctx.noteTasks 的宿主实现(manifest 声明了对应 capability 才注入,接线在 pluginStore)。
 *  DTO 刻意不复用宿主内部的 AggDb / MdMark:内部结构以后要改,不该牵动插件 API(同 PluginSearchHit 的口径)。
 *  写口与内置日历 / 待办走同一组函数(setAggCell / addAggRow / patchMark …),所以和打开着的界面一致。 */
import { isRealDate, parseCalDate } from '@amadeus-shared/db/calDate'
import type { CellValue } from '@amadeus-shared/db/schema'
import type { MdMark } from '@amadeus-shared/mdMarks'
import { isStamped, resolveBaseType } from '../blocks/database/propertyTypes'
import { addAggRow, deleteAggRow, duplicateAggRow, getAggDb, restoreAggRow, setAggCell, setAggName, watchAllDatabases, type AggDb } from '../store/dbAggregateStore'
import { findMdMark, markKey, patchMark, watchMdMarks } from '../store/mdMarkStore'
import { HUMAN_CAL } from '../store/humanCalendarIo'
import { watchHumanCal } from '../store/calendarMembers'
import { useDbStore } from '../store/dbStore'
import { usePageStore } from '../store/pageStore'
import { normalizeVaultRel } from './pluginAutomation'
import type { PluginContext, PluginDatabase, PluginNoteTask } from './types'

/** 宿主给的生命周期:alive = 插件还在;own = 登记一个退订,插件停用时宿主统一撤。 */
export interface DataScope {
  alive(): boolean
  own(off: () => void): () => void
}

export const toDb = (db: AggDb): PluginDatabase => ({
  path: db.path,
  name: db.name,
  kind: db.isNoteView ? 'notes' : 'table',
  columns: db.columns.map((c) => ({ id: c.id, name: c.name, type: c.type, base: resolveBaseType(c.type) })),
  // 拷贝:宿主 store 里的 cells 是共享引用,插件原地改了会随下一次保存落盘(还绕过盖章列)
  rows: db.rows.map((r) => ({ id: r.rowId, name: r.name, cells: copyCells(r.cells), ...(r.body?.trim() ? { hasBody: true } : {}) })),
})

const toTask = (m: MdMark): PluginNoteTask => ({
  id: markKey(m), path: m.path, title: m.title, heading: m.heading, text: m.text,
  isTask: m.isTask, checked: m.checked, due: m.due, ...(m.remind ? { remind: m.remind } : {}),
})

/** 插件给的值是不是一个合法的单元格值(信任边界:插件代码不一定是 TS)。 */
const copyCells = (cells: Record<string, CellValue>): Record<string, CellValue> =>
  Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))

const isCell = (v: unknown): v is CellValue =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
  || (Array.isArray(v) && v.every((x) => typeof x === 'string'))

/** 新写入的日期从严:形状对、每一头都是真实存在的日子(parseCalDate 是读端,会宽容地丢掉坏的那头)。 */
const isDue = (s: string): boolean => {
  const [a, b, ...rest] = s.split('/')
  const c = parseCalDate(s)
  return !!c && !rest.length && isRealDate(a) && (b === undefined || (c.end === b && isRealDate(b)))
}

const vaultKey = (): string => { const s = usePageStore.getState(); return `${s.vaultSide}:${s.vaultRoot}` }

/** Only calendar-capable consumers may address the exact host-owned personal calendar. */
export const pluginDatabasePath = (path: unknown, includeHumanCalendar = false): string =>
  typeof path !== 'string' ? '' : path === HUMAN_CAL ? (includeHumanCalendar ? HUMAN_CAL : '') : normalizeVaultRel(path)

export function createDatabasesApi(scope: DataScope, includeHumanCalendar = false): NonNullable<PluginContext['databases']> {
  const table = (path: unknown): AggDb | null => getAggDb(pluginDatabasePath(path, includeHumanCalendar))
  const cellsOf = (db: AggDb, raw: unknown): Record<string, CellValue> => {
    const out: Record<string, CellValue> = {}
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (db.columns.some((c) => c.id === k) && isCell(v)) out[k] = Array.isArray(v) ? [...v] : v
    }
    return out
  }
  return {
    subscribe: (cb) => {
      if (!scope.alive() || typeof cb !== 'function') return () => {}
      const humanOff = includeHumanCalendar ? watchHumanCal() : () => {}
      const off = watchAllDatabases((dbs, ready) => {
        if (!scope.alive()) return
        const human = includeHumanCalendar ? getAggDb(HUMAN_CAL) : null
        const status = useDbStore.getState().entries[HUMAN_CAL]?.status
        try { cb({ ready: ready && (!includeHumanCalendar || !!status && status !== 'loading'), databases: (human ? [human, ...dbs] : dbs).map(toDb) }) } catch (e) { console.error('[amadeus] ctx.databases 回调抛错', e) }
      })
      return scope.own(() => { off(); humanOff() })
    },
    setCell: (path, rowId, colId, value, expected) => {
      if (!scope.alive()) return false
      const db = table(path)
      const col = db?.columns.find((c) => c.id === colId)
      if (!db || !col || isStamped(col.type) || !db.rows.some((r) => r.rowId === rowId)) return false
      if (value !== undefined && !isCell(value)) return false
      if (expected !== undefined) {
        if (!expected || typeof expected !== 'object' || !Object.hasOwn(expected, 'value') || expected.value !== undefined && !isCell(expected.value)) return false
        const row = db.rows.find((r) => r.rowId === rowId)!
        if (JSON.stringify(row.cells[colId] ?? null) !== JSON.stringify(expected.value ?? null)) return false
        // Note-view writes don't have the classic table's replayed CAS predicate.
        if (db.isNoteView) return false
      }
      // 笔记视图的标题列 = 笔记名:改它就是给笔记改名(同内置日历的 setAggName),不往 frontmatter 里写
      if (db.isNoteView && col.type === 'page') {
        if (typeof value !== 'string' || !value.trim()) return false
        setAggName(db, String(rowId), value)
        return true
      }
      setAggCell(db, String(rowId), col.id, Array.isArray(value) ? [...value] : value, expected ? { value: Array.isArray(expected.value) ? [...expected.value] : expected.value } : undefined)
      return true
    },
    addRow: async (path, cells, name) => {
      const db = scope.alive() ? table(path) : null
      if (!db) return null
      return addAggRow(db, cellsOf(db, cells), typeof name === 'string' ? name : '', scope.alive).catch(() => null)
    },
    duplicateRow: async (path, rowId) => {
      const db = scope.alive() ? table(path) : null
      return db ? duplicateAggRow(db, String(rowId), scope.alive).catch(() => null) : null
    },
    deleteRow: (path, rowId) => {
      const db = scope.alive() ? table(path) : null
      const row = db?.rows.find((r) => r.rowId === rowId)
      if (!db || !row || db.isNoteView) return null // 笔记视图的行是一篇笔记:走 ctx.app.trash
      const vault = vaultKey()
      const removed = deleteAggRow(db, row.rowId)
      let used = false
      return () => {
        // 只生效一次;换了库就不撤 —— 路径是库相对的,换库后再撤会把行写进另一个库。
        if (used || !scope.alive() || vaultKey() !== vault) return
        used = true
        restoreAggRow(db, row, removed)
      }
    },
  }
}

export function createNoteTasksApi(scope: DataScope): NonNullable<PluginContext['noteTasks']> {
  return {
    subscribe: (cb) => {
      if (!scope.alive() || typeof cb !== 'function') return () => {}
      const off = watchMdMarks((marks, ready) => {
        if (!scope.alive()) return
        try { cb({ ready, tasks: marks.map(toTask) }) } catch (e) { console.error('[amadeus] ctx.noteTasks 回调抛错', e) }
      })
      return scope.own(off)
    },
    update: (id, patch) => {
      if (!scope.alive() || typeof id !== 'string' || !patch || typeof patch !== 'object') return false
      const m = findMdMark(id)
      if (!m) return false
      const p: { checked?: boolean; due?: string } = {}
      if (patch.checked !== undefined) {
        if (typeof patch.checked !== 'boolean' || !m.isTask) return false
        p.checked = patch.checked
      }
      if (patch.due !== undefined) {
        if (typeof patch.due !== 'string' || !isDue(patch.due)) return false
        p.due = patch.due
      }
      if (p.checked === undefined && p.due === undefined) return false
      return patchMark(m, p)
    },
  }
}
