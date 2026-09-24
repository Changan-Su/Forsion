/**
 * 自动化 Space 左栏:统一自动化列表——系统自动化(Muse 巡检/Historian)+盯任务规则(muse_watch)。
 * 每项:触发摘要+执行者+启停 dot;点击 → 主区详情/右栏运行记录跟随(automationStore.sel)。
 * 系统项启停走 saveSpecialConfig,规则启停走 saveMuseTrigger upsert(enabled 翻转,其余字段原样)。
 */
import React, { useEffect, useState } from 'react'
import { CalendarClock, CheckCircle2, ChevronDown, ChevronRight, History, Plus, Search, Sparkles, Trash2, Workflow, Zap } from 'lucide-react'
import { useApp } from '../../stores/appStore'
import { useAutomation, type AutomationSel } from '../../stores/automationStore'
import { deleteAgentScheduleEntry, deleteMuseTrigger, saveAgentScheduleEntry, saveMuseTrigger, saveSpecialConfig } from '../../services/backendService'
import { useI18n } from '../../i18n'
import { actionsText, condText, fmtTime, isFinishedTrigger, parseLocalDatetime, triggerToUpsert } from './lib'
import type { AgentScheduleEntry, MuseTriggerInfo } from '../../types'
import './automation.css'
import './messages'

// triggerToUpsert 搬去 lib.ts(纯模块,pluginStore 禁用插件时也要用);这里保留出口,老引用不断。
export { triggerToUpsert }

export const AutomationListView: React.FC = () => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const agentDefs = useApp((s) => s.agentDefs)
  const st = useAutomation()
  const [showFinished, setShowFinished] = useState(false)
  const [search, setSearch] = useState('')
  const matches = (value: string): boolean => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const oops = (e: any): void => useApp.getState().toast(String(e?.message || e), true)

  useEffect(() => {
    void useAutomation.getState().refresh(cfg)
    const timer = setInterval(() => void useAutomation.getState().refresh(cfg), 8000)
    return () => clearInterval(timer)
  }, [cfg, st.refreshNonce])

  const selIs = (sel: AutomationSel): boolean =>
    JSON.stringify(st.sel) === JSON.stringify(sel)

  const toggleSystem = async (which: 'muse' | 'historian', e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    const sc = st.specialCfg
    if (!sc) return
    const next = { ...sc[which], enabled: !sc[which].enabled }
    try {
      await saveSpecialConfig(cfg, { [which]: next } as any)
      st.bump()
    } catch (e) { oops(e) }
  }

  const toggleTrigger = async (tr: MuseTriggerInfo, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    try {
      // actor='user':面板拨开关是显式意图,可以把引擎自动停用的规则开回来(插件的幂等重放则不行)。
      await saveMuseTrigger(cfg, { ...triggerToUpsert(tr), enabled: !tr.enabled, actor: 'user' })
      st.bump()
    } catch (e) { oops(e) }
  }

  const removeTrigger = async (tr: MuseTriggerInfo, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    try {
      await deleteMuseTrigger(cfg, tr.id)
      st.bump()
    } catch (e) { oops(e) }
  }

  // 日程条目启停 = auto 翻转(upsert 全字段原样回传)。列表列「可自动化」条目(有 date+prompt),
  // 关掉 auto 仍留在列表可再开;纯规划条目(无 prompt)只在 Calendar 显示,不进自动化列表。
  const toggleSchedule = async (slug: string, en: AgentScheduleEntry, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    try {
      await saveAgentScheduleEntry(cfg, slug, {
        id: en.id, name: en.name, date: en.date, repeat: en.repeat,
        auto: !en.auto, prompt: en.prompt, description: en.description, todo: en.todo,
      })
      st.bump()
    } catch (e) { oops(e) }
  }

  const removeSchedule = async (slug: string, id: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    try {
      await deleteAgentScheduleEntry(cfg, slug, id)
      st.bump()
    } catch (e) { oops(e) }
  }

  const muse = st.specialCfg?.muse
  const historian = st.specialCfg?.historian

  return (
    <div className="auto-list">
      <div className="auto-list-toolbar"><button className="auto-overview" onClick={() => st.setSel(null)}><Workflow size={15} />{t('automation.ux.overview')}</button>
        <button className="btn sm" onClick={() => st.openBuilder()}><Plus size={13} />{t('automation.new')}</button></div>
      <label className="auto-search"><Search size={14} /><input value={search} placeholder={t('automation.ux.search')} aria-label={t('automation.ux.search')} onChange={(e) => setSearch(e.target.value)} /></label>
      {(() => {
        // 手动类单列一组:它们不是「盯任务」(永不自动触发),混在一起会让人以为按钮也在后台跑。
        const visible = st.triggers.filter((tr) => matches(`${tr.desc} ${condText(t, tr.cond)} ${actionsText(t, agentDefs, tr)}`))
        const manual = visible.filter((tr) => tr.cond?.type === 'manual')
        const active = visible.filter((tr) => tr.cond?.type !== 'manual' && !isFinishedTrigger(tr))
        const finished = visible.filter((tr) => tr.cond?.type !== 'manual' && isFinishedTrigger(tr))
        const row = (tr: MuseTriggerInfo, done: boolean): React.ReactNode => (
          <div
            key={tr.id}
            className={`auto-item ${done ? 'finished' : ''} ${selIs({ kind: 'trigger', triggerId: tr.id }) ? 'active' : ''}`}
            role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st.setSel({ kind: 'trigger', triggerId: tr.id }) } }} onClick={() => st.setSel({ kind: 'trigger', triggerId: tr.id })}
          >
            <span className="auto-ic">{done ? <CheckCircle2 size={15} /> : <Zap size={15} />}</span>
            <div className="auto-item-main">
              <div className="auto-item-title">{tr.desc}</div>
              <div className="auto-item-sub">
                {condText(t, tr.cond)} · {actionsText(t, agentDefs, tr)}
                {!done && tr.enabled && tr.nextRunAt ? ` · ${t('automation.nextRun', { time: fmtTime(tr.nextRunAt) })}` : ''}
              </div>
            </div>
            <button
              className="icon-btn"
              title={t('common.delete')}
              style={{ opacity: 0.6 }}
              onClick={(e) => void removeTrigger(tr, e)}
            >
              <Trash2 size={13} />
            </button>
            {done ? (
              <span className="auto-badge-done">{t('automation.finished')}</span>
            ) : (
              <button className="auto-state-toggle" role="switch" aria-checked={!!tr.enabled} aria-label={t(tr.enabled ? 'automation.ux.pause' : 'automation.ux.enable')} title={tr.enabled ? t('automation.enabled') : t('automation.disabled')} onClick={(e) => void toggleTrigger(tr, e)}><span className={`auto-dot ${tr.enabled ? 'on' : 'off'}`} /><span>{t(tr.enabled ? 'automation.ux.on' : 'automation.ux.off')}</span></button>
            )}
          </div>
        )
        return (
          <>
            {manual.length > 0 && (
              <>
                <div className="auto-grouphead">{t('automation.group.buttons')}</div>
                {manual.map((tr) => row(tr, false))}
              </>
            )}
            <div className="auto-grouphead">{t('automation.ux.myWorkflows')}</div>
            {st.loaded && active.length === 0 && (
              <div style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-faint)', padding: '4px 8px' }}>{t(search.trim() ? 'automation.ux.noMatches' : 'automation.ux.noRules')}</div>
            )}
            {active.map((tr) => row(tr, false))}
            {finished.length > 0 && (
              <>
                <div className="auto-grouphead clickable" onClick={() => setShowFinished((v) => !v)}>
                  {showFinished ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {t('automation.group.finished', { n: String(finished.length) })}
                </div>
                {(showFinished || search.trim()) && finished.map((tr) => row(tr, true))}
              </>
            )}
          </>
        )
      })()}

      {(() => {
        // Agent 日程组:各 agent SCHEDULE.db 里「可自动化」的条目(有 date+prompt;dot=auto 开关)。
        const rows = st.schedules.flatMap((s) =>
          s.entries.filter((e) => e.date && e.prompt && matches(`${e.name} ${s.name}`)).map((e) => ({ slug: s.slug, agentName: s.name, en: e })))
        if (!rows.length) return null
        return (
          <>
            <div className="auto-grouphead">{t('automation.group.schedules')}</div>
            {rows.map(({ slug, agentName, en }) => {
              // once 日程「本锚点」已跑过=不会再触发(lastRun>=start;旧 lastRun+改期未来=引擎会复活,不算完)
              const start = parseLocalDatetime(en.date.split('/')[0]) || null
              const done = !en.repeat && !!start && start.getTime() <= Date.now()
                && !!en.lastRun && Date.parse(en.lastRun) >= start.getTime()
              return (
                <div
                  key={`${slug}:${en.id}`}
                  className={`auto-item ${done ? 'finished' : ''} ${selIs({ kind: 'schedule', slug, rowId: en.id }) ? 'active' : ''}`}
                  role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st.setSel({ kind: 'schedule', slug, rowId: en.id }) } }} onClick={() => st.setSel({ kind: 'schedule', slug, rowId: en.id })}
                >
                  <span className="auto-ic">{done ? <CheckCircle2 size={15} /> : <CalendarClock size={15} />}</span>
                  <div className="auto-item-main">
                    <div className="auto-item-title">{en.name}</div>
                    <div className="auto-item-sub">
                      {en.date.split('/')[0].replace('T', ' ')}
                      {en.repeat ? ` · ${t('automation.schedule.every', { ivl: en.repeat })}` : ''} · {agentName}
                    </div>
                  </div>
                  <button
                    className="icon-btn"
                    title={t('common.delete')}
                    style={{ opacity: 0.6 }}
                    onClick={(e) => void removeSchedule(slug, en.id, e)}
                  >
                    <Trash2 size={13} />
                  </button>
                  {done ? (
                    <span className="auto-badge-done">{t('automation.finished')}</span>
                  ) : (
                    <button className="auto-state-toggle" role="switch" aria-checked={!!en.auto} aria-label={t(en.auto ? 'automation.ux.pause' : 'automation.ux.enable')} title={en.auto ? t('automation.enabled') : t('automation.disabled')} onClick={(e) => void toggleSchedule(slug, en, e)}><span className={`auto-dot ${en.auto ? 'on' : 'off'}`} /><span>{t(en.auto ? 'automation.ux.on' : 'automation.ux.off')}</span></button>
                  )}
                </div>
              )
            })}
          </>
        )
      })()}

      <div className="auto-grouphead">{t('automation.group.system')}</div>
      <div className={`auto-item ${selIs({ kind: 'muse' }) ? 'active' : ''}`} hidden={!matches(t('automation.muse.title'))} role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st.setSel({ kind: 'muse' }) } }} onClick={() => st.setSel({ kind: 'muse' })}>
        <span className="auto-ic"><Sparkles size={15} /></span>
        <div className="auto-item-main">
          <div className="auto-item-title">{t('automation.muse.title')}</div>
          <div className="auto-item-sub">
            {muse ? t('automation.muse.trigger', { min: String(muse.supervisorPollMinutes) }) : '…'}
          </div>
        </div>
        <button className="auto-state-toggle" role="switch" aria-checked={!!muse?.enabled} aria-label={t(muse?.enabled ? 'automation.ux.pause' : 'automation.ux.enable')} title={muse?.enabled ? t('automation.enabled') : t('automation.disabled')} onClick={(e) => void toggleSystem('muse', e)}><span className={`auto-dot ${st.museStatus?.running ? 'running' : muse?.enabled ? 'on' : 'off'}`} /><span>{t(muse?.enabled ? 'automation.ux.on' : 'automation.ux.off')}</span></button>
      </div>
      <div className={`auto-item ${selIs({ kind: 'historian' }) ? 'active' : ''}`} hidden={!matches(t('automation.historian.title'))} role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st.setSel({ kind: 'historian' }) } }} onClick={() => st.setSel({ kind: 'historian' })}>
        <span className="auto-ic"><History size={15} /></span>
        <div className="auto-item-main">
          <div className="auto-item-title">{t('automation.historian.title')}</div>
          <div className="auto-item-sub">
            {historian ? t('automation.historian.trigger', { n: String(historian.everyRounds) }) : '…'}
          </div>
        </div>
        <button className="auto-state-toggle" role="switch" aria-checked={!!historian?.enabled} aria-label={t(historian?.enabled ? 'automation.ux.pause' : 'automation.ux.enable')} title={historian?.enabled ? t('automation.enabled') : t('automation.disabled')} onClick={(e) => void toggleSystem('historian', e)}><span className={`auto-dot ${historian?.enabled ? 'on' : 'off'}`} /><span>{t(historian?.enabled ? 'automation.ux.on' : 'automation.ux.off')}</span></button>
      </div>

    </div>
  )
}
