/**
 * 自动化首页的「Muse 建议」(11-22 用户选方案 A,docs/ToBeImproved/自动化任务建议方案_2026-11-22)。
 * 行的画法 = 首页模板行(.auto-starter)+ 两行小字:触发 → 动作;依据 + 来源(来源可点就画成链接)。
 * 点行 = 打开草稿(不建规则、不启用);× = 原地换成理由,选了才收,理由回给 Muse。
 */
import React, { useState } from 'react'
import { ArrowRight, Bell, CalendarClock, Clock, Database, Monitor, MousePointerClick, Sparkles, Workflow, X } from 'lucide-react'
import { setActiveSpace } from '@lcl/engine'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { usePageStore } from '../../amadeus/store/pageStore'
import { openNote } from '../../amadeusNav'
import { hostTargetFor, openWsFile } from '../wsFileNav'
import { ReasonPrompt } from '../../components/FeedbackReasons'
import { useHomeAgentDefs } from '../../stores/homeCatalog'
import { suggestionDraft, useAutomation } from '../../stores/automationStore'
import type { MuseAutomationSuggestion } from '../../types'
import { actionsText, condText } from './lib'
import './messages'

type Cond = MuseAutomationSuggestion['rule']['cond']
const condIcon = (c: Cond): typeof Clock =>
  c.type === 'daily_at' || c.type === 'every' || c.type === 'at' ? Clock
  : c.type === 'calendar.before' ? CalendarClock
  : c.type.startsWith('computer.') ? Monitor
  : c.type === 'db_changed' ? Database
  : c.type === 'manual' ? MousePointerClick
  : c.type === 'event_seen' || c.type === 'file_chars_gte' ? Bell
  : Workflow

/** 来源能不能点开:笔记 / 表要有路径,日历与待办进日历 Space;电脑历史与 Muse 自己的没有可打开的东西。 */
const linkable = (s: MuseAutomationSuggestion): boolean =>
  s.source.kind === 'calendar' || s.source.kind === 'todo' || ((s.source.kind === 'note' || s.source.kind === 'database') && !!s.source.ref)

/** 引擎存的是磁盘上真有的绝对路径;落在笔记库里 → 库内相对路径,库外 → null(按库外文件开)。 */
const vaultRel = (p: string, root: string | null | undefined): string | null => {
  const path = p.replace(/\\/g, '/')
  const r = (root || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!/^(\/|[A-Za-z]:\/)/.test(path)) return path
  return r && path.startsWith(`${r}/`) ? path.slice(r.length + 1) : null
}

function openSource(s: MuseAutomationSuggestion, vaultRoot: string | null | undefined): void {
  const ref = s.source.ref
  if ((s.source.kind === 'note' || s.source.kind === 'database') && ref) {
    const rel = vaultRel(ref, vaultRoot)
    if (rel) void openNote(rel, { newTab: true })
    else openWsFile(hostTargetFor(ref, ref.split(/[/\\]/).pop() || ref), { newTab: true })
    return
  }
  if (s.source.kind === 'calendar' || s.source.kind === 'todo') setActiveSpace('calendar')
}

function SourceRef({ s }: { s: MuseAutomationSuggestion }) {
  const vaultRoot = usePageStore((st) => st.vaultRoot)
  if (!linkable(s)) return <span className="auto-sugg-src">{s.source.label}</span>
  return (
    <a className="auto-sugg-src link" role="link" tabIndex={-1}
      onClick={(e) => { e.stopPropagation(); openSource(s, vaultRoot) }}>{s.source.label}</a>
  )
}

const REASONS = ['irrelevant', 'timing', 'exists', 'less'] as const

function SuggestionRow({ s }: { s: MuseAutomationSuggestion }) {
  const { t } = useI18n()
  const agentDefs = useHomeAgentDefs()
  const st = useAutomation()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const draft = suggestionDraft(s)
  const Icon = condIcon(s.rule.cond)
  const dismiss = async (reason: string | null): Promise<void> => {
    setBusy(true)
    try { await st.dismissSuggestion(s.id, reason || undefined) }
    catch (e: any) { useApp.getState().toast(String(e?.message || e), true); setBusy(false) }
  }
  return (
    <div className="auto-starter auto-sugg" role="button" tabIndex={0} data-suggestion={s.id}
      onClick={() => { if (!asking) st.openSuggestion(s.id) }}
      onKeyDown={(e) => { if (!asking && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); st.openSuggestion(s.id) } }}>
      <Icon size={20} />
      <strong>{s.title}</strong>
      <span className="auto-sugg-flow">{condText(t, s.rule.cond)} → {actionsText(t, agentDefs, draft)}</span>
      <span className="auto-sugg-why">{s.why}<SourceRef s={s} /></span>
      {asking
        ? <div className="auto-sugg-reasons" onClick={(e) => e.stopPropagation()}>
            <ReasonPrompt question={t('automation.sugg.why')} reasons={REASONS.map((id) => ({ id, label: t(`automation.sugg.reason.${id}`) }))}
              skipLabel={t('automation.sugg.reason.skip')} busy={busy} shareable={false}
              onPick={(r) => void dismiss(r)} onCancel={() => setAsking(false)} />
          </div>
        : <span className="auto-sugg-tools">
            <span className="auto-sugg-open">{t('automation.sugg.open')}<ArrowRight size={12} /></span>
            <button type="button" className="icon-btn" title={t('automation.sugg.dismiss')} aria-label={t('automation.sugg.dismiss')}
              onClick={(e) => { e.stopPropagation(); setAsking(true) }}><X size={14} /></button>
          </span>}
    </div>
  )
}

/** 首页那一节的节头 + 行。extra:建议多于格子数时折起来的条数(点了展开)。 */
export function MuseSuggestionSection({ shown, extra, onMore, action }: {
  shown: MuseAutomationSuggestion[]; extra: number; onMore: () => void; action?: React.ReactNode
}) {
  const { t } = useI18n()
  return (
    <section className="auto-sugg-section" aria-label={t('automation.sugg.title')}>
      <div className="auto-home-section">
        <h2><Sparkles size={15} className="auto-sugg-mark" />{t('automation.sugg.title')}</h2>
        {action}
      </div>
      <div className="auto-starters">
        {shown.map((s) => <SuggestionRow key={s.id} s={s} />)}
      </div>
      {extra > 0 && <button type="button" className="auto-sugg-more" onClick={onMore}>{t('automation.sugg.more', { n: extra })}</button>}
    </section>
  )
}

/** 画布标题下的一行:这份草稿来自 Muse 的哪条建议、为什么;保存前不会运行。 */
export function SuggestionNote({ s }: { s: MuseAutomationSuggestion }) {
  const { t } = useI18n()
  return (
    <div className="auto-sugg-note">
      <Sparkles size={14} className="auto-sugg-mark" />
      <span className="auto-sugg-note-text">{t('automation.sugg.noteLead')}{s.why}</span>
      <SourceRef s={s} />
      <span className="auto-sugg-note-hint">{t('automation.sugg.noteHint')}</span>
    </div>
  )
}
