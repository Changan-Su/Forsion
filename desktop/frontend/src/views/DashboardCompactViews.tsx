/** Built-in views 的 Dashboard 卡片面。
 *
 * 完整 Todo / Calendar / Inbox / Activity 都是为整页操作设计的；直接缩进卡片会同时保留工具栏、
 * 多层滚动与侧栏密度。这里保留同一数据源和关键动作，只把信息层级收敛成一眼能扫完的摘要。 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, CheckCircle2, Circle, Inbox, Pause, Play } from 'lucide-react'
import type { DashboardCardSize } from '@lcl/engine'
import { useWorkspace } from '@lcl/engine'
import { parseCalDate } from '@amadeus-shared/db/calDate'
import { setAggCell, firstDateCol, type AggRow } from '../amadeus/store/dbAggregateStore'
import { useCalendarMembers } from '../amadeus/store/calendarMembers'
import { useCalendarConfig, colorForDb, isHidden } from '../amadeus/store/calendarConfigStore'
import { usePageStore } from '../amadeus/store/pageStore'
import { startOfDay, toLocalDate } from './calendar/dateUtils'
import { todoDueMeta } from './calendar/todoMeta'
import { useAgentCalDbs } from '../stores/agentScheduleStore'
import { useOtherVaultCalDbs } from '../stores/otherVaultCalStore'
import { useIcsCalDbs } from '../stores/icsCalendarStore'
import { useInbox, senderOf, parseUtc, type InboxMessage } from '../stores/inboxStore'

const limitFor = (size: DashboardCardSize, compact = 4): number =>
  size === 'full' ? compact + 4 : size === 'lg' ? compact + 2 : compact

export function TodoDashboardCard({ size }: { size: DashboardCardSize }) {
  const members = useCalendarMembers()
  const today = useMemo(() => startOfDay(new Date()), [])
  // 摘要卡不认时间窗偏好(todoPrefs 已随待办视图重构下线):列出全部未完成,按到期排序。
  const rows = useMemo(() => {
    const out: Array<{ db: (typeof members)[number]['db']; row: AggRow; checkCol: string; due: ReturnType<typeof todoDueMeta> }> = []
    for (const member of members) {
      if (!member.checkboxCol) continue
      const checkCol = member.checkboxCol
      for (const row of member.db.rows) {
        if (row.cells[checkCol] === true) continue
        const raw = typeof row.cells[member.dateCol] === 'string' ? String(row.cells[member.dateCol]) : ''
        out.push({ db: member.db, row, checkCol, due: todoDueMeta(raw, today) })
      }
    }
    return out.sort((a, b) => a.due.sortTime - b.due.sortTime || a.row.name.localeCompare(b.row.name, 'zh'))
  }, [members, today])
  const undone = rows.length
  const shown = rows.slice(0, limitFor(size, 4))
  return (
    <div className="dash-compact dash-compact-list">
      <div className="dash-compact-kpi"><strong>{undone}</strong><span>项待完成</span></div>
      <div className="dash-compact-rows">
        {shown.map(({ db, row, checkCol, due }) => {
          const checked = row.cells[checkCol] === true
          return (
            <button key={`${db.path}:${row.rowId}`} className="dash-compact-row" onClick={() => void setAggCell(db, row.rowId, checkCol, checked ? undefined : true)}>
              {checked ? <CheckCircle2 size={14} /> : <Circle size={14} />}
              <span className={checked ? 'is-done' : undefined}>{row.name || '未命名'}</span>
              <em className={due.tone}>{due.label}</em>
            </button>
          )
        })}
        {!shown.length && <div className="dash-compact-empty">没有待完成的待办</div>}
      </div>
      {rows.length > shown.length && <div className="dash-compact-more">还有 {rows.length - shown.length} 项</div>}
    </div>
  )
}

interface AgendaItem { key: string; title: string; start: Date; color: string; source: string }

export function CalendarDashboardCard({ size }: { size: DashboardCardSize }) {
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const members = useCalendarMembers()
  const agent = useAgentCalDbs()
  const other = useOtherVaultCalDbs()
  const ics = useIcsCalDbs()
  const byVault = useCalendarConfig((s) => s.byVault)
  const items = useMemo(() => {
    const sources = [
      ...members.map((member) => ({ db: member.db, dateCol: member.dateCol })),
      ...[...agent, ...other, ...ics]
        .map((db) => ({ db, dateCol: firstDateCol(db)?.id ?? '' }))
        .filter((source) => source.dateCol),
    ]
    const now = Date.now()
    const end = now + 31 * 86400_000
    const out: AgendaItem[] = []
    sources.forEach(({ db, dateCol }, index) => {
      if (isHidden(vault, byVault, db.path)) return
      for (const row of db.rows) {
        const raw = typeof row.cells[dateCol] === 'string' ? String(row.cells[dateCol]) : ''
        const parsed = parseCalDate(raw)
        if (!parsed) continue
        const start = toLocalDate(parsed.start)
        const eventEnd = parsed.end ? toLocalDate(parsed.end).getTime() : start.getTime() + 86400_000
        if (eventEnd < now || start.getTime() > end) continue
        out.push({ key: `${db.path}:${row.rowId}`, title: row.name || '未命名', start, source: db.name, color: colorForDb(vault, byVault, db.path, index) })
      }
    })
    return out.sort((a, b) => a.start.getTime() - b.start.getTime())
  }, [members, agent, other, ics, vault, byVault])
  const shown = items.slice(0, limitFor(size, 4))
  return (
    <div className="dash-compact dash-agenda">
      <div className="dash-compact-kpi"><strong>{items.length}</strong><span>个近期日程</span></div>
      <div className="dash-compact-rows">
        {shown.map((item) => (
          <div key={item.key} className="dash-compact-row dash-agenda-row">
            <i style={{ background: item.color }} />
            <span>{item.title}</span>
            <em>{item.start.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</em>
          </div>
        ))}
        {!shown.length && <div className="dash-compact-empty"><CalendarDays size={16} />未来 31 天没有日程</div>}
      </div>
      {items.length > shown.length && <div className="dash-compact-more">还有 {items.length - shown.length} 个日程</div>}
    </div>
  )
}

const inboxTime = (message: InboxMessage): string => {
  const date = parseUtc(message.created_at)
  if (!date) return ''
  return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

export function InboxDashboardCard({ size }: { size: DashboardCardSize }) {
  const { messages, loading, unreadCount, select, refreshList, refreshUnread } = useInbox()
  useEffect(() => { void refreshList(); void refreshUnread() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = messages.slice(0, limitFor(size, 4))
  const open = (message: InboxMessage): void => {
    select(message.id)
    useWorkspace.getState().openView('inbox-reader', {}, 'main')
  }
  return (
    <div className="dash-compact dash-compact-list">
      <div className="dash-compact-kpi"><strong>{unreadCount}</strong><span>封未读</span></div>
      <div className="dash-compact-rows">
        {shown.map((message) => (
          <button key={message.id} className="dash-compact-row" onClick={() => open(message)}>
            <i className={`dash-inbox-dot${message.read_at ? '' : ' is-unread'}`} />
            <span><b>{senderOf(message)}</b>{message.title}</span>
            <em>{inboxTime(message)}</em>
          </button>
        ))}
        {!shown.length && <div className="dash-compact-empty"><Inbox size={16} />{loading ? '正在加载…' : '收件箱是空的'}</div>}
      </div>
    </div>
  )
}

const ACTIVITY_RE = /^(\d{12}) (\S+)(.*)$/

export function ActivityDashboardCard({ size }: { size: DashboardCardSize }) {
  const [lines, setLines] = useState<string[]>([])
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    let alive = true
    const pull = async (): Promise<void> => {
      const text = (await window.tangu?.exportActivity?.(2).catch(() => '')) || ''
      if (alive) setLines(text.split('\n').filter((line) => ACTIVITY_RE.test(line)).slice(-limitFor(size, 6)))
    }
    void pull()
    const timer = window.setInterval(pull, 2000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [paused, size])
  return (
    <div className="dash-compact dash-activity-card">
      <div className="dash-compact-kpi"><strong>{lines.length}</strong><span>条最近活动</span><button type="button" title={paused ? '继续' : '暂停'} onClick={() => setPaused((value) => !value)}>{paused ? <Play size={12} /> : <Pause size={12} />}</button></div>
      <div className="dash-activity-lines">
        {lines.map((line, index) => {
          const match = ACTIVITY_RE.exec(line)
          return match ? <div key={`${match[1]}:${index}`}><time>{match[1].slice(6, 8)}:{match[1].slice(8, 10)}</time><b>{match[2]}</b><span>{match[3]}</span></div> : null
        })}
        {!lines.length && <div className="dash-compact-empty">暂无活动</div>}
      </div>
    </div>
  )
}
