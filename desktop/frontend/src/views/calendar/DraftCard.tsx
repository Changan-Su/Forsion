/** 新建草稿的旁弹卡(10-16 用户:编辑事件回到事件旁的浮卡,右栏只放待办):选日历、看时间、保存 / 取消。
 *  标题仍在格子里直接打 —— 卡片不抢焦点(按钮 mousedown 不夺焦),也不像事件卡那样盖捕获层,点网格别处照常收草稿。
 *  卡片 fixed 贴在草稿块旁;时间格横竖都会滚,滚动 / 窗口变化时跟着草稿块重算,草稿块滚出可视区就先藏起来。 */
import { useLayoutEffect, useState, type RefObject } from 'react'
import { Check } from 'lucide-react'
import { zoomOf, UI_MODE, useNativeChromeClaim } from '@lcl/engine'
import { parseCalDate } from '@amadeus-shared/db/calDate'
import { CalDateFields } from '../../amadeus/blocks/database/propertyTypes.builtins'
import { pasteCalendarEvent, useCalendarClipboard } from './eventClipboard'
import { calendarScope } from './eventActions'
import { cardPos } from './EventCard'
import { draftValue, pickDraftDb } from './draft'
import { eventTimeSummary, addMinutes, toLocalDate } from './dateUtils'
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
  'calside.discard': { zh: '放弃未保存的事件？', en: 'Discard this unsaved event?' },
  'calside.paste': { zh: '在此粘贴事件', en: 'Paste event here' },
  'calside.hint': { zh: '标题在格子里直接打。Enter 保存，Esc 取消；没写标题不会新建。', en: 'Type the title right in the grid. Enter saves, Esc cancels; nothing is created without a title.' },
})

const W = 300
const H = 300

/** rootRef = 日历主区:卡片放不下时翻到草稿块左边,不盖右栏。 */
export function DraftCard({ rootRef, onPasted }: { rootRef: RefObject<HTMLElement | null>; onPasted?: (key: string) => void }) {
  const { t } = useI18n()
  const draft = useCalendarNav((s) => s.draft)
  const clip = useCalendarClipboard((s) => s.clip)
  const mobile = UI_MODE === 'mobile' || !!window.tangu?.mobile
  const api = useCalendarNav((s) => s.draftApi)
  const members = useCalendarMembers()
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const byVault = useCalendarConfig((s) => s.byVault)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const geom = draft ? `${draft.day}|${draft.endDay}|${draft.startMin}|${draft.endMin}` : ''
  const close = (): void => { if (!draft?.title.trim() || window.confirm(t('calside.discard'))) api?.cancel() }
  useNativeChromeClaim(mobile && draft ? { mode: 'page', title: t('calside.newEvent'), back: t('calside.cancel'), onBack: close } : null)
  useLayoutEffect(() => {
    if (!mobile || !draft) return
    const back = (e: Event): void => { e.preventDefault(); if (!(e as CustomEvent).detail?.probe) close() }
    window.addEventListener('forsion:mobile-back', back)
    return () => window.removeEventListener('forsion:mobile-back', back)
  }, [mobile, draft])

  useLayoutEffect(() => {
    if (!geom || mobile) { setPos(null); return }
    const measure = (): void => {
      // 带输入框的那一块(月视图跨天时每天一块,只有第一块有输入框)
      const host = document.querySelector('.amx-cal-draft-input')?.closest<HTMLElement>('.amx-cal-draft')
      const port = host?.closest<HTMLElement>('.amx-cal-tscroll, .amx-cal-mscroll')?.getBoundingClientRect()
      const r = host?.getBoundingClientRect()
      if (!r || !port || r.bottom < port.top || r.top > port.bottom || r.right < port.left || r.left > port.right) { setPos(null); return }
      setPos(cardPos({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, zoom: zoomOf(host!) || 1 }, { w: W, h: H, maxRight: rootRef.current?.getBoundingClientRect().right }))
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure) }
  }, [geom, rootRef])

  if (!draft || (!pos && !mobile)) return null
  const writable = members.filter((m) => !m.db.readonly)
  const chosen = pickDraftDb(members, draft.dbPath, defaultDbPath(vault, byVault))?.db.path
  const summary = eventTimeSummary(draftValue(draft))
  const pick = (dbPath: string): void => {
    const d = useCalendarNav.getState().draft
    if (d) useCalendarNav.getState().setDraft({ ...d, dbPath })
  }
  const keep = (e: { preventDefault(): void }): void => e.preventDefault() // 点卡片不夺走格子里标题框的焦点
  return (
    <section className={`amx-cal-cardwrap amx-cal-draftcard${mobile ? ' amx-cal-drawer' : ''}`} data-kb-rise={mobile ? 'bar' : undefined} style={mobile ? undefined : pos!} role="dialog" aria-modal="false" aria-label={t('calside.newEvent')} onMouseDown={mobile ? undefined : keep} onPointerDown={(e) => e.stopPropagation()}>
      {mobile ? <>
        <button className="amx-cal-drawer-grab" aria-label={t('calside.cancel')} onClick={close}><span /></button>
        <input className="amx-cal-card-title" value={draft.title} placeholder={t('calside.newEvent')} aria-label={t('calside.newEvent')}
          onChange={(e) => useCalendarNav.getState().setDraft({ ...draft, title: e.target.value })} />
        <CalDateFields value={draftValue(draft)} onChange={(raw) => {
          const d = parseCalDate(raw)
          if (!d) return
          const start = toLocalDate(d.start), end = d.end ? toLocalDate(d.end) : addMinutes(start, 30)
          useCalendarNav.getState().setDraft({ ...draft, hasEnd: !!d.end, day: d.start.slice(0, 10), endDay: (d.end ?? d.start).slice(0, 10),
            startMin: d.allDay ? null : start.getHours() * 60 + start.getMinutes(), endMin: d.allDay ? 0 : (end.getTime() - toLocalDate(d.start.slice(0, 10)).getTime()) / 60000 })
        }} />
      </> : <div className="amx-cal-draft-title">{draft.title || <span className="ph">{t('calside.newEvent')}</span>}</div>}
      {summary && (
        <div className="amx-cal-draft-time">
          <span className="amx-cal-card-timehead">{summary.head}{summary.badge && <span className="amx-cal-card-badge">{summary.badge}</span>}</span>
          {summary.date && <span className="amx-cal-card-timesub">{summary.date}</span>}
        </div>
      )}
      <div className="amx-cal-draft-label">{t('calside.calendar')}</div>
      <div className="amx-cal-draft-cals">
        {writable.map((m) => (
          <button key={m.db.path} className={`amx-cal-draft-cal${m.db.path === chosen ? ' on' : ''}`} onMouseDown={keep} onClick={() => pick(m.db.path)}>
            <i style={{ background: colorForDb(vault, byVault, m.db.path, members.indexOf(m)) }} />
            <span>{m.db.name}</span>
            {m.db.path === chosen && <Check size={13} />}
          </button>
        ))}
      </div>
      {!mobile && <p className="amx-cal-draft-hint">{t('calside.hint')}</p>}
      {mobile && clip && <button onClick={() => {
        if (draft.title.trim() && !window.confirm(t('calside.discard'))) return
        const scope = calendarScope()
        void pasteCalendarEvent(chosen ? members.find((m) => m.db.path === chosen)?.db : undefined, addMinutes(toLocalDate(draft.day), draft.startMin ?? 0)).then((result) => {
          if (result && calendarScope() === scope && useCalendarNav.getState().draft === draft) { api?.cancel(); onPasted?.(`${result.db.path}::${result.id}`) }
        })
      }}>{t('calside.paste')}</button>}
      <div className="amx-cal-draft-actions">
        <button className="amx-cal-draft-cancel" onMouseDown={mobile ? undefined : keep} onClick={mobile ? close : () => api?.cancel()}>{t('calside.cancel')}</button>
        <button className="amx-cal-draft-save" disabled={!draft.title.trim()} onMouseDown={keep} onClick={() => api?.commit()}>{t('calside.save')}</button>
      </div>
    </section>
  )
}
