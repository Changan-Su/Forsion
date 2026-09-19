/**
 * Agent 的日程:它自己的 SCHEDULE.db(时间承诺 —— 到点自动执行的任务,或只是给自己排的计划)+ 会叫醒它的自动化规则。
 * 数据与 Calendar Space 的 agent:// 只读源、自动化 Space 的「Agent 日程」组是同一份(GET /agent/special/schedule),
 * 这里按 Agent 收拢成一页:下一次什么时候、做什么、上次跑没跑。
 * 日程怎么来:Agent 用 manage_schedule 自己排(「每天 9 点帮我…」),或你把 Muse 的待办交给它执行。桌面没有新建入口,所以空态要把这件事说清楚。
 */
import React, { useEffect, useRef, useState } from 'react'
import { CalendarClock, CalendarDays, ExternalLink, Loader2, Trash2, Zap } from 'lucide-react'
import { setActiveSpace, useSpaceStore } from '@lcl/engine'
import { deleteAgentScheduleEntry, getAgentSchedules, getMuseTriggers } from '../services/backendService'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { condText, fmtTime, isFinishedTrigger } from '../views/automation/lib'
import { nextOccurrence, triggerWakes } from './agentScheduleLib'
import type { AgentScheduleEntry, MuseTriggerInfo, TanguDesktopConfig } from '../types'
import '../views/agentProfile.css'

type Props = { cfg: TanguDesktopConfig; slug: string; /** run 起止时重读:Agent 刚用 manage_schedule 排的条目不用手动刷新。 */ running?: boolean }

/** 换后端 / 账号 / Agent 整体重挂,旧请求画不进新身份。 */
export const AgentSchedulePanel: React.FC<Props> = (props) => <AgentScheduleBody key={JSON.stringify([props.cfg.backendUrl, props.cfg.token, props.slug])} {...props} />

const AgentScheduleBody: React.FC<Props> = ({ cfg, slug, running }) => {
  const { t } = useI18n()
  const spaces = useSpaceStore((s) => s.spaces)
  const [entries, setEntries] = useState<AgentScheduleEntry[] | null>(null)
  const [rules, setRules] = useState<MuseTriggerInfo[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const seq = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = async (): Promise<void> => {
    const mine = ++seq.current
    // 两个接口各自失败各自算:规则读不到不该把日程也抹掉。日程那半的 404 = 云端引擎(本地限定),换成本地化文案。
    const [sched, trig] = await Promise.allSettled([getAgentSchedules(cfg), getMuseTriggers(cfg)])
    if (!alive.current || mine !== seq.current) return
    if (sched.status === 'fulfilled') { setEntries(sched.value.find((s) => s.slug === slug)?.entries || []); setError('') }
    else { setEntries([]); setError((sched.reason as any)?.status === 404 ? t('agentProfile.scheduleLocalOnly') : String((sched.reason as any)?.message || sched.reason)) }
    setRules(trig.status === 'fulfilled' ? trig.value.filter((tr) => triggerWakes(tr, slug) && !isFinishedTrigger(tr)) : [])
  }
  useEffect(() => { void load() }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (entry: AgentScheduleEntry): Promise<void> => {
    if (busy || !window.confirm(t('agentProfile.scheduleDeleteConfirm', { name: entry.name }))) return
    setBusy(true); setError('')
    try { await deleteAgentScheduleEntry(cfg, slug, entry.id); await load() }
    catch (e: any) { if (alive.current) setError(String(e?.message || e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const go = (space: string): void => { useApp.getState().closeSettings(); setActiveSpace(space) }
  const has = (space: string): boolean => spaces.some((s) => s.id === space)

  const now = Date.now()
  const rows = (entries || []).map((entry) => ({ entry, next: nextOccurrence(entry, now) }))
  const upcoming = rows.filter((r) => r.next).sort((a, b) => a.next!.getTime() - b.next!.getTime())
  const past = rows.filter((r) => !r.next) // 一次性已过 / 没写日期的备注
  const soonest = upcoming[0]?.next
  const card = ({ entry, next }: (typeof rows)[number]) => <li key={entry.id} className={`schedule-entry${next ? '' : ' is-past'}`} data-schedule-entry={entry.id}>
    <div className="harness-entry-head">
      <strong>{entry.name}</strong>
      <button type="button" className="harness-undo" disabled={busy} title={t('common.delete')} aria-label={t('common.delete')} onClick={() => void remove(entry)}><Trash2 size={13} /></button>
    </div>
    <div className="schedule-when">
      {/* 到点自动执行 = accent 芯片;只是给自己排的计划 = 灰芯片。重复间隔原样显示引擎的写法(1d / 3h),两种语言都读得懂。 */}
      <span className={`harness-kind${entry.auto ? ' recipe' : ''}`}>{t(entry.auto ? 'agentProfile.scheduleAuto' : 'agentProfile.schedulePlan')}</span>
      <time>{next ? fmtTime(next.getTime()) : entry.date ? entry.date.split('/')[0].replace('T', ' ') : t('agentProfile.scheduleNoDate')}</time>
      {entry.repeat && <span>{t('automation.schedule.every', { ivl: entry.repeat })}</span>}
    </div>
    {(entry.prompt || entry.description) && <p title={entry.prompt || entry.description}>{entry.prompt || entry.description}</p>}
    {entry.lastRun && <small className="harness-meta">{t('agentProfile.scheduleLastRun', { time: fmtTime(entry.lastRun) })}</small>}
  </li>

  return <div className="agent-harness agent-schedule" data-agent-schedule={slug}>
    {error && <p className="agent-profile-error" role="alert">{error}</p>}
    {entries === null ? <p className="agent-profile-muted" role="status"><Loader2 size={14} className="spin" /> {t('agentProfile.scheduleLoading')}</p>
      : !rows.length && !rules.length ? !error && <div className="harness-empty">
        <CalendarClock size={22} strokeWidth={1.6} aria-hidden="true" />
        <p>{t(slug === 'muse' ? 'agentProfile.scheduleEmptyMuse' : 'agentProfile.scheduleEmpty')}</p>
        {has('calendar') && <button type="button" className="btn sm" onClick={() => go('calendar')}><CalendarDays size={12} />{t('agentProfile.scheduleOpenCalendar')}</button>}
      </div> : <>
        <div className="harness-summary">
          <span>{t('agentProfile.scheduleCount', { count: rows.length })}{soonest && <> · {t('automation.nextRun', { time: fmtTime(soonest.getTime()) })}</>}</span>
          {has('calendar') && <button type="button" className="profile-text-action" onClick={() => go('calendar')}><CalendarDays size={12} />{t('agentProfile.scheduleOpenCalendar')}</button>}
        </div>
        {upcoming.length > 0 && <ul className="harness-entries">{upcoming.map(card)}</ul>}
        {past.length > 0 && <details className="profile-disclosure schedule-past"><summary>{t('agentProfile.schedulePast', { count: past.length })}</summary><ul className="harness-entries">{past.map(card)}</ul></details>}
        {rules.length > 0 && <section className="schedule-rules">
          <h3>{t('agentProfile.scheduleRules', { count: rules.length })}</h3>
          <ul className="harness-entries">{rules.map((tr) => <li key={tr.id} className={`schedule-rule${tr.enabled ? '' : ' is-past'}`} data-schedule-rule={tr.id}>
            <Zap size={13} aria-hidden="true" />
            <span><strong>{tr.desc}</strong><small>{condText(t, tr.cond)}{tr.enabled ? tr.nextRunAt ? ` · ${t('automation.nextRun', { time: fmtTime(tr.nextRunAt) })}` : '' : ` · ${t('agentProfile.scheduleRuleOff')}`}</small></span>
          </li>)}</ul>
          {has('automation') && <button type="button" className="agent-profile-link" onClick={() => go('automation')}>{t('agentProfile.scheduleOpenAutomation')}<ExternalLink size={13} /></button>}
        </section>}
      </>}
  </div>
}
