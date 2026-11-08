/**
 * 「今日简报」格子里的内置卡(待你看的 / 在跟的 / 今天 / 卜算子状态)与主页上的同名两张小组件。
 * 卡壳(头行、编辑态把手、提议条)在 MuseBriefView;这里只画卡身。数据走 museBriefData 的轮询 hook。
 * 「交给 Agent」= 原来右栏「注入所选到会话 / 新对话里做」挪到卡上的那一下(方案 §5 第 3 条)。
 */
import React, { useState } from 'react'
import { ArrowUpRight, Check, CornerDownRight, MessageSquarePlus, MessagesSquare, X } from 'lucide-react'
import { setActiveSpace } from '@lcl/engine'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useAutomation } from '../../stores/automationStore'
import { ContextMenu, type CtxMenu } from '../../components/RightPanel'
import { panelToast } from '../../components/PanelNotice'
import { displaySessionTitle } from '../../sessionTitle'
import { formatDayTime, formatRelative } from '../../format/time'
import { formatRepeat } from '../../format/repeat'
import { trackWhen } from '../../components/museViewFormat'
import { wakeMuse } from '../../services/backendService'
import { homeTarget } from '../../services/engine/targets'
import type { AgentScheduleEntry, MuseStatusInfo, MuseTodo } from '../../types'
import { handTodosToAgent, setTodoStatus, useMuseJournalToday, useMuseTodosLive, useMuseTracksLive, type JournalSegment } from './museBriefData'

registerMessages({
  'museBrief.card.todos': { zh: '待你看的', en: 'For you' },
  'museBrief.card.tracking': { zh: '在跟的', en: 'Tracking' },
  'museBrief.card.today': { zh: '今天', en: 'Today' },
  'museBrief.card.status': { zh: '卜算子状态', en: 'Muse status' },
  'museBrief.todos.empty': { zh: '还没有待办。它想到值得替你做的事，会先放在这里。', en: 'No to-dos yet. When Muse finds something worth doing for you, it lands here first.' },
  'museBrief.todos.blank': { zh: '它提的待办会出现在这里', en: 'To-dos Muse suggests show up here' },
  'museBrief.todos.count': { zh: '{n} 条', en: '{n} open' },
  'museBrief.todos.done': { zh: '完成', en: 'Done' },
  'museBrief.todos.skip': { zh: '略过', en: 'Skip' },
  'museBrief.todos.hand': { zh: '交给 Agent', en: 'Hand to an agent' },
  'museBrief.todos.handNew': { zh: '新会话', en: 'New session' },
  'museBrief.todos.handed': { zh: '已交给「{name}」', en: 'Handed to "{name}"' },
  'museBrief.todos.failed': { zh: '没办成：{e}', en: "Couldn't do that: {e}" },
  'museBrief.tracking.empty': { zh: '它给自己排的提醒会出现在这里。在聊天里的任务卡上点「交给 Muse 追踪」也会进来。', en: 'Reminders Muse sets for itself show up here, and so do tasks you hand over with "Hand to Muse" on a task card.' },
  'museBrief.today.empty': { zh: '今天还没有手记。', en: 'No journal entry today yet.' },
  'museBrief.today.open': { zh: '打开今天的手记', en: "Open today's journal" },
  'museBrief.status.running': { zh: '正在想', en: 'Thinking' },
  'museBrief.status.idle': { zh: '空闲', en: 'Idle' },
  'museBrief.status.sleeping': { zh: '在睡', en: 'Asleep' },
  'museBrief.status.off': { zh: '已停用', en: 'Off' },
  'museBrief.status.woke': { zh: '{ago}醒过', en: 'woke {ago}' },
  'museBrief.status.never': { zh: '还没醒过', en: 'Not awake yet' },
  'museBrief.status.until': { zh: '睡到 {time}', en: 'Asleep until {time}' },
  'museBrief.status.every': { zh: '每 {n} 分钟醒一次', en: 'Wakes every {n} min' },
  'museBrief.wake': { zh: '现在叫醒它', en: 'Wake it now' },
  'museBrief.waking': { zh: '叫醒了，马上开始', en: 'Waking it now' },
})

const SKIP_SESSIONS_KIND = new Set(['muse', 'historian'])

/** 叫醒成功后「正在叫醒」只撑到下一轮状态轮询接手(那时 wakePending / running 会说真话),不一直挂着。 */
export const wakeSettle = (set: (v: boolean) => void): void => { setTimeout(() => set(false), 10_000) }

/** 「交给 Agent」那颗按钮:点开菜单,新会话 + 最近 6 个会话。 */
function HandButton({ todos, disabled, label }: { todos: MuseTodo[]; disabled?: boolean; label?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const sessions = useApp((s) => s.sessions)
  const [menu, setMenu] = useState<CtxMenu>(null)
  const go = (target: string | 'new', name: string): void => {
    void handTodosToAgent(todos, target)
      .then((ok) => { if (ok) panelToast(t('museBrief.todos.handed', { name })) })
      .catch((e) => panelToast(t('museBrief.todos.failed', { e: e instanceof Error ? e.message : String(e) }), true))
  }
  const recent = sessions.filter((s) => !SKIP_SESSIONS_KIND.has(String((s as { kind?: string }).kind || ''))).slice(0, 6)
  return (
    <>
      <button type="button" className={label ? 'msb-pill ghost' : 'msb-icbtn'} disabled={disabled} title={t('museBrief.todos.hand')} aria-label={t('museBrief.todos.hand')} data-action="hand"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({
            x: r.left, y: r.bottom + 4, anchorTop: r.top,
            items: [
              { label: t('museBrief.todos.handNew'), icon: <MessageSquarePlus size={14} />, run: () => go('new', t('museBrief.todos.handNew')) },
              ...recent.map((s, i) => ({ label: displaySessionTitle(s.title, t), icon: <MessagesSquare size={14} />, separatorBefore: i === 0, run: () => go(s.id, displaySessionTitle(s.title, t)) })),
            ],
          })
        }}>
        {label ? <>{t('museBrief.todos.hand')}</> : <CornerDownRight size={13} />}
      </button>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  )
}

/** 待你看的:勾 = 完成;悬停出「略过」「交给 Agent」;详情缺省一行。 */
export function TodosBody({ disabled, placeholder }: { disabled?: boolean; placeholder?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const { todos, refresh } = useMuseTodosLive()
  const [busy, setBusy] = useState('')
  const act = (id: string, status: 'done' | 'dismissed'): void => {
    setBusy(id)
    void setTodoStatus(id, status).then(refresh, (e) => panelToast(t('museBrief.todos.failed', { e: e instanceof Error ? e.message : String(e) }), true)).finally(() => setBusy(''))
  }
  if (!todos) return <div className="msb-blank" aria-busy="true" />
  if (!todos.length) return <div className="msb-blank">{t(placeholder ? 'museBrief.todos.blank' : 'museBrief.todos.empty')}</div>
  return (
    <>
      <div className="msb-tds">
        {todos.slice(0, 5).map((td) => (
          <div key={td.id} className="msb-td" data-todo-id={td.id}>
            <button type="button" className="msb-box" disabled={disabled || busy === td.id} title={t('museBrief.todos.done')} aria-label={`${t('museBrief.todos.done')}: ${td.title}`} onClick={() => act(td.id, 'done')}><Check size={10} strokeWidth={3} /></button>
            <span className="msb-tdt"><b title={td.title}>{td.title}</b>{td.detail && <i title={td.detail}>{td.detail}</i>}</span>
            {!disabled && (
              <span className="msb-acts">
                <button type="button" className="msb-icbtn" title={t('museBrief.todos.skip')} aria-label={t('museBrief.todos.skip')} onClick={() => act(td.id, 'dismissed')}><X size={13} /></button>
                <HandButton todos={[td]} />
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="msb-foot"><span>{t('museBrief.todos.count', { n: todos.length })}</span>{!disabled && todos.length > 1 && <HandButton todos={todos} label />}</div>
    </>
  )
}

export const openTrack = (e: AgentScheduleEntry): void => {
  useApp.getState().closeSettings()
  setActiveSpace('automation')
  useAutomation.getState().setSel({ kind: 'schedule', slug: 'muse', rowId: e.id })
}

export function TrackingBody(): React.JSX.Element {
  const { t } = useI18n()
  const tracks = useMuseTracksLive()
  if (!tracks) return <div className="msb-blank" aria-busy="true" />
  if (!tracks.length) return <div className="msb-blank">{t('museBrief.tracking.empty')}</div>
  return (
    <div className="msb-evs">
      {tracks.slice(0, 5).map((e, i) => (
        <button type="button" key={e.id} className={`msb-ev${i === 0 ? ' next' : ''}`} onClick={() => openTrack(e)} title={e.description || undefined}>
          <i aria-hidden />
          <span className="msb-n">{e.name}</span>
          <span className="msb-time r">{trackWhen(e.date)}{e.repeat ? ` · ${formatRepeat(t, e.repeat)}` : ''}</span>
        </button>
      ))}
    </div>
  )
}

/** 今天(格子里那张):手记最后两段,点了打开整篇。 */
export function TodayBody({ onOpen }: { onOpen: (path: string) => void }): React.JSX.Element {
  const { t } = useI18n()
  const j = useMuseJournalToday()
  if (!j) return <div className="msb-blank" aria-busy="true" />
  if (!j.segments.length) return <div className="msb-blank">{t('museBrief.today.empty')}</div>
  return (
    <button type="button" className="msb-today" onClick={() => onOpen(j.path)} title={t('museBrief.today.open')}>
      {j.segments.slice(-2).map((s, i) => <SegmentLine key={i} s={s} />)}
    </button>
  )
}
export function SegmentLine({ s }: { s: JournalSegment }): React.JSX.Element {
  return <p className="msb-seg">{s.time && <span className="msb-time">{s.time}</span>}{s.label && <b>{s.label}</b>}{s.text}</p>
}

/** 卜算子状态:一行状态 + 一行下次 / 心跳;空闲时可叫醒(#544 的接口;旧引擎没有就不出)。 */
export function StatusBody({ status }: { status: MuseStatusInfo | null | undefined }): React.JSX.Element {
  const { t } = useI18n()
  const [waking, setWaking] = useState(false)
  if (!status) return <div className="msb-blank" aria-busy={status === undefined || undefined} />
  const big = !status.enabled ? t('museBrief.status.off') : status.running ? t('museBrief.status.running') : status.sleepUntil ? t('museBrief.status.sleeping') : t('museBrief.status.idle')
  const sub = status.lastCycleAt ? t('museBrief.status.woke', { ago: formatRelative(status.lastCycleAt) }) : t('museBrief.status.never')
  const next = status.sleepUntil ? t('museBrief.status.until', { time: formatDayTime(status.sleepUntil) }) : status.heartbeatMinutes ? t('museBrief.status.every', { n: status.heartbeatMinutes }) : ''
  const canWake = status.enabled && !status.running && typeof status.wakePending === 'boolean' && !status.wakePending
  return (
    <>
      <div className="msb-big"><b>{big}</b><span>{sub}</span></div>
      {next && <div className="msb-sub">{next}</div>}
      {(canWake || waking || status.wakePending) && (
        <div className="msb-foot">
          {status.wakePending || waking
            ? <span>{t('museBrief.waking')}</span>
            : <button type="button" className="msb-pill" data-action="muse-wake" onClick={() => { setWaking(true); void wakeMuse(homeTarget()).then(() => wakeSettle(setWaking), () => setWaking(false)) }}><ArrowUpRight size={12} />{t('museBrief.wake')}</button>}
        </div>
      )}
    </>
  )
}
