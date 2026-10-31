/** ctx.ui.mountRecord(2026-10-17):宿主的行编辑字段(标题 / 时间 / 属性)挂进插件自己的卡片 —— 与内置日历事件浮卡同一个
 *  RecordFields,写口同 ctx.databases.setCell(setAggCell / setAggName)。外框、关闭、打开 / 删除归插件。
 *  只订这一张表用到的三份 store(文件清单 / 表条目 / 笔记视图文件夹),不拉全库聚合。 */
import { lazy, Suspense, useMemo } from 'react'
import { getAggDb, isDateCol, setAggBody } from '../store/dbAggregateStore'
import { useDbStore } from '../store/dbStore'
import { useNoteViewStore } from '../store/noteViewStore'
import { usePageStore } from '../store/pageStore'
import { RecordFields } from '../../views/calendar/EventCard'
import { HostLocaleProvider, registerMessages, useI18n } from '../../i18n'
import { mountHostReact } from './blockSurface'
import type { PluginRecordOptions } from './types'
import './recordSurface.css'

// 正文编辑器与表格「打开记录」(RowPeek)同一个;懒加载,不给只要字段的调用方拖进编辑器。
const BodyEditor = lazy(() => import('../blocks/markdown/MarkdownBlock').then((m) => ({ default: m.PlainMarkdownEditor })))
registerMessages({
  'pluginrecord.body': { zh: '备注', en: 'Notes' },
  'pluginrecord.bodyHint': { zh: '写点备注…', en: 'Add notes…' },
})

function Record({ opts }: { opts: PluginRecordOptions }) {
  const { t } = useI18n()
  const files = usePageStore((s) => s.files)
  const entries = useDbStore((s) => s.entries)
  const folders = useNoteViewStore((s) => s.folders)
  const db = useMemo(() => getAggDb(opts.path), [opts.path, files, entries, folders]) // eslint-disable-line react-hooks/exhaustive-deps
  const row = db?.rows.find((r) => r.rowId === opts.rowId)
  if (!db || !row) return null // 行被删了 / 换了库:什么都不画
  // 必须是日期类列:关联列之类当时间行编辑会把那一格整个写成日期串(Codex P1)
  const colId = opts.dateCol && db.columns.some((c) => c.id === opts.dateCol && isDateCol(c)) ? opts.dateCol : undefined
  const key = `${db.path}::${row.rowId}`
  // 正文只给可写的经典表:笔记视图的正文是笔记文件本身,只读源 / 投影没有正文可写
  const body = opts.body && !opts.readOnly && !db.isNoteView && !db.readonly && !db.writeCell
  // key:换了行就是一张新卡(时间编辑器的展开状态、正文编辑器的内容不跟到下一行)
  return (
    <div className="amx-cal-cardin plugin-record">
      <RecordFields key={key} db={db} row={row} colId={colId} lock={!!opts.readOnly} hide={opts.hideColumns} />
      {body && (
        <section className="plugin-record-body" aria-label={t('pluginrecord.body')} data-empty={row.body?.trim() ? undefined : ''} data-hint={t('pluginrecord.bodyHint')}>
          <Suspense fallback={null}>
            <BodyEditor key={key} initial={row.body ?? ''} onChange={(value) => setAggBody(db, row.rowId, value)} immediate />
          </Suspense>
        </section>
      )}
    </div>
  )
}

/** 参数在 pluginStore 那一侧校验过(path 是库里的表、rowId 是字符串)。 */
export function mountPluginRecord(el: HTMLElement, initial: PluginRecordOptions): { update(patch: Partial<PluginRecordOptions>): void; dispose(): void } {
  let opts = { ...initial }
  let alive = true
  const tree = () => <HostLocaleProvider><Record opts={opts} /></HostLocaleProvider>
  const mounted = mountHostReact(el, tree(), () => { alive = false })
  return {
    update(patch) { if (alive) { opts = { ...opts, ...patch }; mounted.render(tree()) } },
    dispose: mounted.dispose,
  }
}
