/** 跨库聚合层:枚举全库 .db → 读出各多维表 → 摊平成统一行,供 ToDo/Calendar 视图按属性类型消费。
 *  经典表 + 笔记视图都覆盖(笔记视图行来自 noteViewStore/listPageProps)。数据与表格嵌入共用
 *  dbStore/noteViewStore —— 视图里改一格 = 表格里改一格,live 一致;写回也复用它们的写穿/防抖。
 *  刷新时机(非热路径):视图挂载 / 新增 .db(structureChange)/ vault 切换。.db 无 watcher,
 *  外部改 .db 不自动回灌(与表格嵌入同现状)。 // ponytail: 量大再上增量;先全量够用 */
import { useEffect, useMemo } from 'react'
import { coerceForDisplay, dbId, type CellValue, type DbColumn } from '@amadeus-shared/db/schema'
import { fmValueToCell } from '@amadeus-shared/db/pageFrontmatter'
import { isStamped, newRowCells, resolveBaseType } from '../blocks/database/propertyTypes'
import { dropSelfRefs, type DroppedRef } from '../blocks/database/rowLink'
import '../blocks/database/propertyTypes.builtins' // 确保内置 todo/calendarDate 在场
import { useDbStore } from './dbStore'
import { useNoteViewStore } from './noteViewStore'
import { usePageStore } from './pageStore'
import { ensureAmadeusReady } from '../../amadeusPlugins'
import { amadeus } from '../api'
import { actDebounced, shortVal } from '../../activity/log'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'dbagg.confirmDeleteNote': {
    zh: '删除此事件会一并删除对应的笔记文件,确定?',
    en: 'Deleting this event also deletes its note file. Continue?',
  },
})

const DB_RE = /\.db$/i

export interface AggRow {
  rowId: string
  name: string
  cells: Record<string, CellValue>
}
export interface AggDb {
  path: string
  name: string
  isNoteView: boolean
  folder?: string
  columns: DbColumn[]
  rows: AggRow[]
  /** 只读源(如 agent 日程 `agent://…` 合成库):Calendar 不可拖拽/编辑,图例无默认库星标。 */
  readonly?: boolean
  /** **可编辑投影**的写回接缝(目前只有笔记正文 `@` 标记源 `mdnote://`):这类源在磁盘上没有 .db,
   *  真源是别处的一行 markdown。给了这个函数 = 单元格可写(拖动/改期照常走 setAggCell),
   *  但 `readonly` **仍然为真** —— 删除、复制、当默认库、成为快速添加目标一律照旧关着。 */
  writeCell?(rowId: string, colId: string, value: CellValue | undefined): void
  /** 「打开来源」的去处。合成源在磁盘上没有 .db,openDb(db.path) 是个假路径 —— 由源自己说去哪。 */
  openRow?(rowId: string): void
  /** 所属 Vault 标签(纯展示):跨侧/多 Vault 汇总时图例淡显后缀,标注该日历归属。 */
  vaultLabel?: string
}

/** 任意 cell → 展示文本(供名称列/其它列只读展示)。 */
export const cellText = (v: CellValue | undefined): string => {
  const s = coerceForDisplay(v ?? null, 'text')
  return typeof s === 'string' ? s : String(s ?? '')
}

/** 聚合全库所有多维表(含笔记视图);随底层 store 变化重渲染。不做类型过滤。
 *  .db 路径直接取自 pageStore.files(vault 就绪 / 结构变更即到位)—— 重启后无需手动刷新即自动出现。 */
export function useAllDatabases(): AggDb[] {
  const files = usePageStore((s) => s.files)
  const entries = useDbStore((s) => s.entries)
  const folders = useNoteViewStore((s) => s.folders)
  const paths = useMemo(() => files.filter((f) => DB_RE.test(f)), [files])

  // Calendar/ToDo 视图挂载即确保 vault 已恢复(否则直接进 Calendar Space 时 vault 从未加载 → files 空)。
  useEffect(() => {
    ensureAmadeusReady()
  }, [])

  // 路径就绪即加载各 .db(重启:vault 恢复 → files 到位 → 这里自动触发)。
  useEffect(() => {
    for (const p of paths) void useDbStore.getState().load(p, p)
  }, [paths])

  // 笔记视图库:额外加载其数据来源文件夹。
  useEffect(() => {
    for (const p of paths) {
      const folder = entries[p]?.data?.source?.folder
      if (folder !== undefined) void useNoteViewStore.getState().load(folder)
    }
  }, [paths, entries])

  return useMemo(() => {
    const out: AggDb[] = []
    for (const p of paths) {
      const e = entries[p]
      const db = e?.status === 'ok' ? e.data : null
      if (!db) continue
      const folder = db.source?.folder
      if (folder !== undefined) {
        const props = folders[folder]?.props ?? []
        const rows: AggRow[] = props.map((pr) => ({
          rowId: pr.path,
          name: pr.title,
          cells: Object.fromEntries(
            db.columns.map((c) => [c.id, c.type === 'page' ? pr.title : fmValueToCell(pr.fm[c.id], resolveBaseType(c.type))]),
          ),
        }))
        out.push({ path: p, name: db.name, isNoteView: true, folder, columns: db.columns, rows })
      } else {
        const nameId = db.columns[0]?.id ?? ''
        // 名称空就是空:不回落 r.id(随机编码曾漏进日历/待办显示),消费方自己决定兜底文案或隐藏。
        const rows: AggRow[] = db.rows.map((r) => ({ rowId: r.id, name: cellText(r.cells[nameId]), cells: r.cells }))
        out.push({ path: p, name: db.name, isNoteView: false, columns: db.columns, rows })
      }
    }
    return out
  }, [paths, entries, folders])
}

/** 「含某属性类型列」的子集(旧接口保留;新日历/待办改走成员制)。 */
export function useAggregatedDatabases(type: string): AggDb[] {
  const all = useAllDatabases()
  return useMemo(() => all.filter((db) => db.columns.some((c) => c.type === type)), [all, type])
}

/** 日历锚点日期列 = primitive/自定义 baseType=date,或富类型 calendarDate / created(baseType=text;
 *  created 存 `YYYY-MM-DDTHH:mm` 与 calendarDate 单侧串同款)。 */
export const isDateCol = (c: DbColumn): boolean => resolveBaseType(c.type) === 'date' || c.type === 'calendarDate' || c.type === 'created'
/** 完成/待办勾选列 = baseType=checkbox(含 primitive checkbox 与旧 todo 类型)。 */
export const isCheckboxCol = (c: DbColumn): boolean => resolveBaseType(c.type) === 'checkbox'
/** 缺省日期列:created 只当兜底 —— 它排在真日期列前面时不能抢走日历锚点。 */
export const firstDateCol = (db: AggDb): DbColumn | undefined =>
  db.columns.find((c) => isDateCol(c) && c.type !== 'created') ?? db.columns.find(isDateCol)
export const firstCheckboxCol = (db: AggDb): DbColumn | undefined => db.columns.find(isCheckboxCol)

/** 全库 .db 是否都已「落定」(非 loading)——一次性迁移前用它等齐,防只迁到先加载好的那几个。 */
export function useDatabasesReady(): boolean {
  const files = usePageStore((s) => s.files)
  const entries = useDbStore((s) => s.entries)
  const paths = useMemo(() => files.filter((f) => DB_RE.test(f)), [files])
  return paths.length > 0 && paths.every((p) => { const st = entries[p]?.status; return !!st && st !== 'loading' })
}

/** 写回一格:经典表 → dbStore.mutate;笔记视图 → noteViewStore.setProp。自定义类型按 baseType 落盘。 */
export function setAggCell(db: AggDb, rowId: string, colId: string, value: CellValue | undefined): void {
  const col = db.columns.find((c) => c.id === colId)
  if (isStamped(col?.type ?? '')) return // 盖章列(自动编号/创建时间)建行即定,与 DatabaseEmbed.setCell 同一道闸
  const base = resolveBaseType(col?.type ?? 'text')
  // 活动日志:行属性变更(通用,任何列类型)——row.edit db+p=列名+v=新值+行标题;同格 10s 防抖取末态
  // (日期拖拽实时更新高频调用)。Calendar/Todo List/事件卡全走此收口。待办勾选即 p=待办 v=true。
  if (col) {
    const name = colId === db.columns[0]?.id ? shortVal(value) : db.rows.find((r) => r.rowId === rowId)?.name
    actDebounced('row.edit', { db: db.name, p: col.name, v: shortVal(value), text: name }, `${db.path}|${rowId}|${colId}`)
  }
  if (db.writeCell) { // 可编辑投影:写回真源(那一行 markdown),不碰 useDbStore
    db.writeCell(rowId, colId, value)
    return
  }
  if (db.isNoteView && db.folder !== undefined) {
    useNoteViewStore.getState().setProp(db.folder, rowId, colId, value, base)
    return
  }
  useDbStore.getState().mutate(db.path, (d) => ({
    ...d,
    rows: d.rows.map((r) => {
      if (r.id !== rowId) return r
      const cells = { ...r.cells }
      if (value === undefined) delete cells[colId]
      else cells[colId] = value
      return { ...r, cells }
    }),
  }))
}

/** 新建一个事件行(双击创建):经典表 push 新行;笔记视图新建笔记 + 写日期 frontmatter。
 *  返回新行的 rowId(经典)/ 笔记路径(笔记视图),供旁弹卡片定位。 */
export async function createAggEvent(db: AggDb, calColId: string, value: string, name: string): Promise<string> {
  const nameCol = db.columns[0]
  if (db.isNoteView && db.folder !== undefined) {
    const notePath = await useNoteViewStore.getState().addNote(db.folder)
    const col = db.columns.find((c) => c.id === calColId)
    useNoteViewStore.getState().setProp(db.folder, notePath, calColId, value, resolveBaseType(col?.type ?? 'text'))
    return notePath
  }
  const rowId = dbId()
  const cells: Record<string, CellValue> = { [calColId]: value }
  if (nameCol && nameCol.id !== calColId && name) cells[nameCol.id] = name
  // 盖章(自动编号/创建时间)在回调**内**按 d.rows 算(CAS 重放拿最新行,见 propertyTypes.newRowCells)。
  // 盖章压在**最后**:created 也算日期列(兜底),日历若以它为锚建事件,点击日不得伪造成创建时间
  // (codex 抓的)—— 这种表上新事件落在「现在」,与该列只读语义一致;真日期列不受影响(盖章键与它不重叠)。
  useDbStore.getState().mutate(db.path, (d) => ({ ...d, rows: [...d.rows, { id: rowId, cells: { ...cells, ...newRowCells(d) } }] }))
  return rowId
}

/** 删除一个事件行:经典表删行;笔记视图删对应笔记(二次确认,删的是文件)。
 *  返回本次从同文件自引用列里摘掉的引用清单(笔记视图 / 无人引用 = 空数组),交给 restoreAggRow 撤销时条件回填 ——
 *  否则撤销只回来一行孤儿,别的行指向它的关联已经丢了(Codex 评审抓的)。
 *  ⚠️ 清单在 mutate 回调**内**收集(CAS 冲突重放会再跑一次回调,以最后一次为准),返回的是同一个数组引用。 */
export function deleteAggRow(db: AggDb, rowId: string): DroppedRef[] {
  const removed: DroppedRef[] = []
  if (db.isNoteView && db.folder !== undefined) {
    if (window.confirm(translate('dbagg.confirmDeleteNote'))) void useNoteViewStore.getState().deleteNote(db.folder, rowId)
    return removed
  }
  // 与 DatabaseEmbed.delRow 同一道清理:只摘同文件内的自引用,跨文件悬空刻意不级联(rowLink.dropSelfRefs)
  useDbStore.getState().mutate(db.path, (d) => {
    removed.length = 0 // 重放从头记
    return dropSelfRefs({ ...d, rows: d.rows.filter((r) => r.id !== rowId) }, rowId, [db.path], removed)
  })
  return removed
}

const sameCell = (a: CellValue | undefined, b: CellValue | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Calendar 删除后的轻量撤销：仅经典表可无损恢复原 row；笔记视图仍走文件删除确认，不伪造文件级撤销。
 *  ⚠️ **不盖章**(不调 newRowCells):恢复的是原来那一行(连 rowId 都复用),重新盖章会把原编号/原创建时间
 *  改掉 —— 撤销就不再是撤销了。别在「统一走 newRowCells」的重构里顺手把这里一起改了。
 *  removed = deleteAggRow 返回的自引用清单:逐格**条件**回填 —— 该格现在的值仍等于「摘除后的值」才写回原值,
 *  用户在删与撤销之间改过那一格就不动它(撤销不能吞掉用户的新编辑)。 */
export function restoreAggRow(db: AggDb, row: AggRow, removed: DroppedRef[] = []): void {
  if (db.readonly || db.isNoteView) return
  useDbStore.getState().mutate(db.path, (d) => {
    if (d.rows.some((r) => r.id === row.rowId)) return d
    const byRow = new Map<string, DroppedRef[]>()
    for (const x of removed) byRow.set(x.rowId, [...(byRow.get(x.rowId) ?? []), x])
    const rows = byRow.size ? d.rows.map((r) => {
      const list = byRow.get(r.id)
      if (!list) return r
      let cells: Record<string, CellValue> | null = null
      for (const x of list) {
        if (!sameCell(r.cells[x.colId], x.after)) continue // 此后被改过:保留用户的值
        cells ??= { ...r.cells }
        if (x.before === undefined) delete cells[x.colId]
        else cells[x.colId] = Array.isArray(x.before) ? [...x.before] : x.before
      }
      return cells ? { ...r, cells } : r
    }) : d.rows
    return { ...d, rows: [...rows, { id: row.rowId, cells: { ...row.cells } }] }
  })
}

/** 复制一行(键盘粘贴):经典表克隆全部单元格为新行(同日期/时间的原位副本);
 *  笔记视图新建笔记 + 逐列拷贝属性(page 身份列除外)。返回新 rowId / 笔记路径,失败返回 null。 */
export async function duplicateAggRow(db: AggDb, rowId: string): Promise<string | null> {
  if (db.readonly) return null
  const src = db.rows.find((r) => r.rowId === rowId)
  if (!src) return null
  if (db.isNoteView && db.folder !== undefined) {
    const notePath = await useNoteViewStore.getState().addNote(db.folder)
    for (const c of db.columns) {
      if (c.type === 'page') continue // 身份列 = 笔记标题,由 addNote 定,不覆盖
      const v = src.cells[c.id]
      if (v !== undefined) useNoteViewStore.getState().setProp(db.folder, notePath, c.id, v, resolveBaseType(c.type))
    }
    return notePath
  }
  const newId = dbId()
  // 合并序与新建**相反**:盖章压掉从源行复制来的自动编号/创建时间,否则粘贴一次就重号、创建时间还是老的。
  useDbStore.getState().mutate(db.path, (d) => ({ ...d, rows: [...d.rows, { id: newId, cells: { ...src.cells, ...newRowCells(d) } }] }))
  return newId
}

/** 写回名称:笔记视图(page 身份列)= 重命名笔记;经典表 = 写首列。 */
export function setAggName(db: AggDb, rowId: string, value: string): void {
  const nameCol = db.columns[0]
  if (db.isNoteView && db.folder !== undefined && nameCol?.type === 'page') {
    if (value.trim()) void useNoteViewStore.getState().renameNote(db.folder, rowId, value.trim())
    return
  }
  setAggCell(db, rowId, nameCol?.id ?? '', value || undefined)
}

// 结构变更(新增/删除文件,含 .db)→ 刷新 pageStore.files(paths 反应式跟随;Calendar-only 空间下
// 也生效,不依赖 Amadeus 编辑器视图挂载)。vault 切换 → 清跨库缓存(entries 按 ref 不含 vault,同名 .db 跨库会串;
// files 会随 restore 重新到位)。
if (typeof window !== 'undefined' && window.amadeus) {
  amadeus.onStructureChange?.(() => void usePageStore.getState().refreshStructure())
  usePageStore.subscribe((s, p) => {
    // gen 必须跟着 +1:光清 entries 的话,已经挂着的嵌入/独立 db 视图不会重读(它们的 effect 只依赖路径),
    // 界面永远停在「读取数据库…」。启动时 vaultRoot 从 null 变成真根也走这条,所以这不是切库才有的边角。
    if (s.vaultRoot !== p.vaultRoot) useDbStore.setState((d) => ({ entries: {}, gen: d.gen + 1 }))
  })
}
