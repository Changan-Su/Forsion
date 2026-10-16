/** 日历 Space 的右栏(2026-10-16 用户定方案 B):平时是待办;主区选中一个事件 → 换成它的详情;
 *  正在新建(草稿)→ 换成草稿面板(选日历、看时间、保存 / 取消)。Esc、「‹ 待办」、点网格空白都回到待办。
 *  方案页:docs/ToBeImproved/Calendar交互与待办右栏方案_2026-10-16/。 */
import { useEffect, useRef } from 'react'
import { Check, ChevronLeft } from 'lucide-react'
import { TodoListView } from '../TodoListView'
import { EventPanel } from './EventCard'
import { draftValue, pickDraftDb } from './draft'
import { eventTimeSummary } from './dateUtils'
import { useCalendarNav } from '../../amadeus/store/calendarNavStore'
import { useCalendarMembers } from '../../amadeus/store/calendarMembers'
import { useCalendarConfig, colorForDb, defaultDbPath } from '../../amadeus/store/calendarConfigStore'
import { usePageStore } from '../../amadeus/store/pageStore'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'calside.newEvent': { zh: '新事件', en: 'New event' },
  'calside.calendar': { zh: '日历', en: 'Calendar' },
  'calside.save': { zh: '保存', en: 'Save' },
  'calside.cancel': { zh: '取消', en: 'Cancel' },
  'calside.hint': { zh: '标题在格子里直接打。Enter 保存，Esc 取消；没写标题就点到别处 = 不建。', en: 'Type the title right in the grid. Enter saves, Esc cancels; clicking away with no title discards it.' },
  'calside.back': { zh: '待办', en: 'To-dos' },
})

export function CalendarSide() {
  const selection = useCalendarNav((s) => s.selection)
  const draft = useCalendarNav((s) => s.draft)
  const setSideEl = useCalendarNav((s) => s.setSideEl)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setSideEl(ref.current)
    return () => { if (useCalendarNav.getState().sideEl === ref.current) setSideEl(null) }
  }, [setSideEl])
  const back = (): void => useCalendarNav.getState().setSelection(null)
  return (
    <div className="amx-calside2" ref={ref}>
      {draft ? <DraftPanel /> : selection ? <EventPanel ev={selection.target} onBack={back} /> : <TodoListView params={{ side: true }} />}
    </div>
  )
}

function DraftPanel() {
  const { t } = useI18n()
  const draft = useCalendarNav((s) => s.draft)!
  const api = useCalendarNav((s) => s.draftApi)
  const members = useCalendarMembers()
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const byVault = useCalendarConfig((s) => s.byVault)
  const writable = members.filter((m) => !m.db.readonly)
  const chosen = pickDraftDb(members, draft.dbPath, defaultDbPath(vault, byVault))?.db.path
  const summary = eventTimeSummary(draftValue(draft))
  const pick = (dbPath: string): void => {
    const d = useCalendarNav.getState().draft
    if (d) useCalendarNav.getState().setDraft({ ...d, dbPath })
  }
  return (
    <section className="amx-cal-panel amx-cal-draftpanel" aria-label={t('calside.newEvent')}>
      <div className="amx-cal-panel-top">
        <button className="amx-cal-panel-back" onClick={() => api?.cancel()}><ChevronLeft size={14} />{t('calside.back')}</button>
        <kbd className="amx-cal-panel-kbd">Esc</kbd>
      </div>
      <div className="amx-cal-draft-title">{draft.title || <span className="ph">{t('calside.newEvent')}</span>}</div>
      {summary && (
        <div className="amx-cal-draft-time">
          <span className="amx-cal-card-timehead">{summary.head}{summary.badge && <span className="amx-cal-card-badge">{summary.badge}</span>}</span>
          {summary.date && <span className="amx-cal-card-timesub">{summary.date}</span>}
        </div>
      )}
      <div className="amx-cal-draft-label">{t('calside.calendar')}</div>
      <div className="amx-cal-draft-cals">
        {writable.map((m) => (
          <button key={m.db.path} className={`amx-cal-draft-cal${m.db.path === chosen ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m.db.path)}>
            <i style={{ background: colorForDb(vault, byVault, m.db.path, members.indexOf(m)) }} />
            <span>{m.db.name}</span>
            {m.db.path === chosen && <Check size={13} />}
          </button>
        ))}
      </div>
      <p className="amx-cal-draft-hint">{t('calside.hint')}</p>
      <div className="amx-cal-draft-actions">
        <button className="amx-cal-draft-cancel" onMouseDown={(e) => e.preventDefault()} onClick={() => api?.cancel()}>{t('calside.cancel')}</button>
        <button className="amx-cal-draft-save" onMouseDown={(e) => e.preventDefault()} onClick={() => api?.commit()}>{t('calside.save')}</button>
      </div>
    </section>
  )
}
