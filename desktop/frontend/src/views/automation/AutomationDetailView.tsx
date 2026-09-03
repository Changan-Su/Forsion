/**
 * 自动化 Space 主区:构建器开 → AutomationBuilder;否则按左栏选中项——
 * 顶部自动化卡(触发/对象/执行者/上次运行/深度配置跳设置)+ 下方最近运行内容:
 *   Muse / agent 规则 → 该会话的只读消息列表(复用 appStore.loadSessionHistory 链,
 *     recordToUi 已归一 role='model' 坑;简版自渲染,不拖 ChatView 的交互耦合);
 *   Historian → special_agent_log 活动流;
 *   Muse 老路规则(无 agentSlug)→ 提示内容在「Muse 巡检」的会话里。
 */
import React, { useEffect, useState } from 'react'
import { CalendarClock, History, Pencil, Play, Settings, Sparkles, Trash2, Zap } from 'lucide-react'
import { useApp } from '../../stores/appStore'
import { useAutomation, sessionForTrigger } from '../../stores/automationStore'
import { deleteAgentScheduleEntry, fireAutomationTrigger, getHistorianActivity, saveAgentScheduleEntry } from '../../services/backendService'
import { useI18n } from '../../i18n'
import { Markdown } from '../../components/Markdown'
import { useDbStore } from '../../amadeus/store/dbStore'
import { actionsText, condText, fmtTime, isFinishedTrigger, watchedColumnIds, whereText } from './lib'
import { AutomationBuilder } from './AutomationBuilder'
import type { AgentScheduleEntry, HistorianActivityItem, MuseTriggerInfo } from '../../types'
import './automation.css'

/** 监听列名单(cell_changed):表已加载就显示列名,否则/列已删显示 (id);多列 = 任一变化即命中。
 *  单独成组件:列名要订阅 dbStore,而 DetailView 主体在 tr 之前有多处早退,hook 不能放那里。 */
const WatchedColumns: React.FC<{ cond: Extract<MuseTriggerInfo['cond'], { type: 'db_changed' }> }> = ({ cond }) => {
  const cols = useDbStore((s) => s.entries[cond.path]?.data?.columns)
  const ids = watchedColumnIds(cond)
  return <>{ids.map((id) => cols?.find((c) => c.id === id)?.name ?? `(${id})`).join(' · ') || '—'}</>
}

/** 试跑按钮:同一执行器立即执行动作链(旧式规则=起一次无人值守 run),结果行内展示。 */
const FireButton: React.FC<{ tr: MuseTriggerInfo }> = ({ tr }) => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const st = useAutomation()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  // Muse 唤醒类(含 legacy 显式 agentSlug:'muse')没有独立动作,引擎会 400——不给按钮
  if (!tr.actions?.length && (!tr.agentSlug || tr.agentSlug === 'muse')) return null
  const fire = async (): Promise<void> => {
    setBusy(true)
    setResult('')
    try {
      const r = await fireAutomationTrigger(cfg, tr.id)
      setResult(r.ok ? t('automation.fire.ok', { status: r.status }) : t('automation.fire.fail', { status: r.status }))
      st.bump()
    } catch (e: any) {
      setResult(t('automation.fire.fail', { status: String(e?.message || e).slice(0, 80) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button className="btn ghost sm" disabled={busy} title={t('automation.fire.hint')} onClick={() => void fire()}>
        <Play size={12} /> {busy ? '…' : t('automation.fire.btn')}
      </button>
      {result && <span className="auto-fire-result">{result}</span>}
    </>
  )
}

/** 某会话的只读消息列表(倒序会话尾部=最近一次运行;流式中的消息会随轮询/事件更新)。 */
const SessionTranscript: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { t } = useI18n()
  const messages = useApp((s) => s.messagesBySession[sessionId])
  useEffect(() => {
    void useApp.getState().loadSessionHistory(sessionId)
  }, [sessionId])
  if (!messages?.length) return <div className="auto-runs-empty">{t('automation.transcript.empty')}</div>
  // 只展示尾部 30 条(常驻会话随命中累积,详情页看最近即可)
  const tail = messages.slice(-30)
  return (
    <div>
      {tail.map((m) => (
        <div key={m.id} className="auto-msg">
          <div className="auto-msg-role">{m.role === 'user' ? t('automation.transcript.trigger') : t('automation.transcript.agent')}</div>
          <div className={`auto-msg-body ${m.role === 'user' ? 'user' : ''}`}>
            {m.role === 'user' ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span> : <Markdown content={m.content || ''} />}
          </div>
          {!!m.toolEvents?.length && (
            <div className="auto-msg-tools">
              {t('automation.transcript.tools', { n: String(m.toolEvents.length) })}: {m.toolEvents.slice(0, 8).map((e) => e.name).join(', ')}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

const HistorianFeed: React.FC = () => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const [items, setItems] = React.useState<HistorianActivityItem[]>([])
  useEffect(() => {
    let alive = true
    const pull = (): void => void getHistorianActivity(cfg, 50).then((a) => alive && setItems(a)).catch(() => {})
    pull()
    const timer = setInterval(pull, 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [cfg])
  if (!items.length) return <div className="auto-runs-empty">{t('automation.transcript.empty')}</div>
  return (
    <div>
      {items.map((it) => (
        <div key={it.id} className="auto-msg">
          <div className="auto-msg-role">{fmtTime(it.created_at)} · {it.action}</div>
          <div className="auto-msg-body">{it.detail}</div>
        </div>
      ))}
    </div>
  )
}

/** 日程条目内联编辑(name/date/repeat/prompt;date 文本含 /end 尾整串原样往返——datetime 控件
 * 会静默改全天/定时语义,拆开编辑又会藏住区间尾,引擎校验兜格式)。date/prompt 必填:清空会让
 * 条目退出自动化列表(列表只收 date&&prompt 条目),纯规划条目去 Calendar 建。 */
const ScheduleEditor: React.FC<{ slug: string; en: AgentScheduleEntry; onDone: () => void }> = ({ slug, en, onDone }) => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const st = useAutomation()
  const [name, setName] = useState(en.name)
  const [date, setDate] = useState(en.date)
  const [repeat, setRepeat] = useState(en.repeat)
  const [prompt, setPrompt] = useState(en.prompt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await saveAgentScheduleEntry(cfg, slug, {
        id: en.id, name: name.trim(), date: date.trim(),
        repeat: repeat.trim(), auto: en.auto, prompt: prompt.trim(),
        description: en.description, todo: en.todo,
      })
      st.bump()
      onDone()
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auto-card">
      <div className="field">
        <label>{t('automation.sched.name')}</label>
        <input type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>{t('automation.sched.date')}</label>
        <input type="text" value={date} placeholder="2026-08-01T09:00" onChange={(e) => setDate(e.target.value)} />
        <div className="auto-hint">{t('automation.sched.dateHint')}</div>
      </div>
      <div className="field">
        <label>{t('automation.sched.repeat')}</label>
        <input type="text" value={repeat} placeholder="24h / 7d" onChange={(e) => setRepeat(e.target.value)} />
        <div className="auto-hint">{t('automation.sched.repeatHint')}</div>
      </div>
      <div className="field">
        <label>{t('automation.builder.prompt')}</label>
        <textarea value={prompt} maxLength={500} onChange={(e) => setPrompt(e.target.value)} />
      </div>
      {error && <div style={{ color: 'var(--warn, #b8860b)', fontSize: 12 }}>{error}</div>}
      <div className="auto-builder-actions" style={{ marginTop: 4 }}>
        <button className="btn ghost sm" onClick={onDone}>{t('common.cancel')}</button>
        <button className="btn sm" disabled={busy || !name.trim() || !date.trim() || !prompt.trim()} onClick={() => void save()}>{busy ? '…' : t('common.save')}</button>
      </div>
    </div>
  )
}

/** 日程条目详情(与规则详情同构:卡片+编辑/删除+触发记录)。key 按条目挂载,切换即重置编辑态。 */
const ScheduleDetail: React.FC<{ slug: string; rowId: string }> = ({ slug, rowId }) => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const st = useAutomation()
  const [editing, setEditing] = useState(false)
  const sched = st.schedules.find((s) => s.slug === slug)
  const en = sched?.entries.find((e) => e.id === rowId)
  if (!sched || !en) return <div className="auto-detail-empty">{t('automation.detail.empty')}</div>
  const sessionId = sessionForTrigger(st.autoSessions, `sched:${slug}:${rowId}`)
  const remove = async (): Promise<void> => {
    try {
      await deleteAgentScheduleEntry(cfg, slug, rowId)
      st.bump()
      st.setSel(null)
    } catch (e: any) {
      useApp.getState().toast(String(e?.message || e), true)
    }
  }
  return (
    <div className="auto-detail">
      {editing ? (
        <ScheduleEditor slug={slug} en={en} onDone={() => setEditing(false)} />
      ) : (
        <div className="auto-card">
          <div className="auto-card-head">
            <CalendarClock size={17} />
            <div className="auto-card-title">{en.name}</div>
            <button className="btn ghost sm" onClick={() => setEditing(true)}><Pencil size={12} /> {t('common.edit')}</button>
            <button className="btn ghost sm" title={t('common.delete')} onClick={() => void remove()}><Trash2 size={12} /></button>
          </div>
          <div className="auto-facts">
            <span className="auto-fact"><b>{t('automation.fact.trigger')}</b>{en.date.replace('/', ' → ').replace(/T/g, ' ')}{en.repeat ? ` · ${t('automation.schedule.every', { ivl: en.repeat })}` : ` · ${t('automation.schedule.once')}`}</span>
            <span className="auto-fact"><b>{t('automation.fact.runner')}</b>{sched.name}</span>
            {en.prompt && <span className="auto-fact"><b>{t('automation.fact.prompt')}</b>{en.prompt.slice(0, 80)}</span>}
            {en.description && <span className="auto-fact"><b>{t('automation.fact.desc')}</b>{en.description.slice(0, 80)}</span>}
            <span className="auto-fact"><b>{t('automation.fact.lastRun')}</b>{fmtTime(en.lastRun || null)}</span>
          </div>
        </div>
      )}
      <div className="auto-transcript-head">{t('automation.detail.latest')}</div>
      {sessionId
        ? <SessionTranscript sessionId={sessionId} />
        : <div className="auto-runs-empty">{t('automation.trigger.neverFired')}</div>}
    </div>
  )
}

export const AutomationDetailView: React.FC = () => {
  const { t } = useI18n()
  const agentDefs = useApp((s) => s.agentDefs)
  const st = useAutomation()

  if (st.builder) {
    const editing = st.builder.editingId ? st.triggers.find((x) => x.id === st.builder!.editingId) : undefined
    return (
      <div className="auto-detail">
        <AutomationBuilder key={st.builder.editingId || 'new'} editing={editing} />
      </div>
    )
  }

  const sel = st.sel
  if (!sel) return <div className="auto-detail-empty">{t('automation.detail.empty')}</div>

  if (sel.kind === 'muse') {
    const muse = st.specialCfg?.muse
    return (
      <div className="auto-detail">
        <div className="auto-card">
          <div className="auto-card-head">
            <Sparkles size={17} />
            <div className="auto-card-title">{t('automation.muse.title')}</div>
            <button className="btn ghost sm" onClick={() => useApp.getState().openSettings('agents')}>
              <Settings size={12} /> {t('automation.deepConfig')}
            </button>
          </div>
          <div className="auto-facts">
            <span className="auto-fact"><b>{t('automation.fact.trigger')}</b>{muse ? t('automation.muse.trigger', { min: String(muse.supervisorPollMinutes) }) : '—'}</span>
            <span className="auto-fact"><b>{t('automation.fact.action')}</b>{t('automation.muse.action')}</span>
            <span className="auto-fact"><b>{t('automation.fact.lastRun')}</b>{fmtTime(st.museStatus?.lastCycleAt)}</span>
          </div>
        </div>
        <div className="auto-transcript-head">{t('automation.detail.latest')}</div>
        {st.museStatus?.sessionId
          ? <SessionTranscript sessionId={st.museStatus.sessionId} />
          : <div className="auto-runs-empty">{t('automation.transcript.empty')}</div>}
      </div>
    )
  }

  if (sel.kind === 'historian') {
    const h = st.specialCfg?.historian
    return (
      <div className="auto-detail">
        <div className="auto-card">
          <div className="auto-card-head">
            <History size={17} />
            <div className="auto-card-title">{t('automation.historian.title')}</div>
            <button className="btn ghost sm" onClick={() => useApp.getState().openSettings('agents')}>
              <Settings size={12} /> {t('automation.deepConfig')}
            </button>
          </div>
          <div className="auto-facts">
            <span className="auto-fact"><b>{t('automation.fact.trigger')}</b>{h ? t('automation.historian.trigger', { n: String(h.everyRounds) }) : '—'}</span>
            <span className="auto-fact"><b>{t('automation.fact.action')}</b>{t('automation.historian.action')}</span>
          </div>
        </div>
        <div className="auto-transcript-head">{t('automation.detail.recent')}</div>
        <HistorianFeed />
      </div>
    )
  }

  if (sel.kind === 'schedule') {
    return <ScheduleDetail key={`${sel.slug}:${sel.rowId}`} slug={sel.slug} rowId={sel.rowId} />
  }

  const tr = st.triggers.find((x) => x.id === sel.triggerId)
  if (!tr) return <div className="auto-detail-empty">{t('automation.detail.empty')}</div>
  const sessionId = sessionForTrigger(st.autoSessions, tr.id)
  const hasOwnAction = !!tr.actions?.length || (!!tr.agentSlug && tr.agentSlug !== 'muse')
  return (
    <div className="auto-detail">
      <div className="auto-card">
        <div className="auto-card-head">
          <Zap size={17} />
          <div className="auto-card-title">{tr.desc}</div>
          <FireButton tr={tr} />
          <button className="btn ghost sm" onClick={() => st.openBuilder(tr.id)}>{t('common.edit')}</button>
        </div>
        <div className="auto-facts">
          {isFinishedTrigger(tr) && <span className="auto-fact"><b>{t('automation.fact.status')}</b>{t('automation.finishedHint')}</span>}
          {/* 引擎自动停用(排空封顶断环 / tool_call 不可用)会写 disabledReason;用户手动启用即清。不显示的话用户只能从日志感知「规则怎么停了」 */}
          {!tr.enabled && tr.disabledReason && <span className="auto-fact auto-fact-warn"><b>{t('automation.fact.status')}</b>{t('automation.fact.disabledReason', { reason: tr.disabledReason })}</span>}
          <span className="auto-fact"><b>{t('automation.fact.trigger')}</b>{condText(t, tr.cond)}</span>
          {tr.cond.type === 'db_changed' && tr.cond.event === 'cell_changed' && (
            <span className="auto-fact"><b>{t('automation.fact.columns')}</b><WatchedColumns cond={tr.cond} /></span>
          )}
          {tr.cond.type === 'db_changed' && !!tr.cond.where?.length && (
            <span className="auto-fact"><b>{t('automation.fact.where')}</b>{whereText(t, tr.cond.where)}</span>
          )}
          <span className="auto-fact"><b>{t('automation.fact.actions')}</b>{actionsText(t, agentDefs, tr)}</span>
          {tr.prompt && <span className="auto-fact"><b>{t('automation.fact.prompt')}</b>{tr.prompt.slice(0, 80)}</span>}
          {/* db_changed 的 0 = 「不冷却」是有意义的配置(链式规则),别藏;其它触发类型 0 只是引擎默认,照旧不显示。 */}
          {(tr.cooldownHours > 0 || tr.cond.type === 'db_changed') && (
            <span className="auto-fact"><b>{t('automation.fact.cooldown')}</b>{tr.cooldownHours > 0 ? `${tr.cooldownHours}h` : t('automation.fact.noCooldown')}</span>
          )}
          <span className="auto-fact"><b>{t('automation.fact.lastRun')}</b>{fmtTime(tr.lastFiredAt)}</span>
          {tr.enabled && tr.nextRunAt && <span className="auto-fact"><b>{t('automation.fact.nextRun')}</b>{fmtTime(tr.nextRunAt)}</span>}
        </div>
      </div>
      <div className="auto-transcript-head">{t('automation.detail.latest')}</div>
      {hasOwnAction
        ? sessionId
          ? <SessionTranscript sessionId={sessionId} />
          : <div className="auto-runs-empty">{t('automation.trigger.neverFired')}</div>
        : (
          <div className="auto-runs-empty">
            {t('automation.trigger.museNote')}{' '}
            <a style={{ cursor: 'pointer', color: 'var(--accent-ink, var(--accent))' }} onClick={() => st.setSel({ kind: 'muse' })}>
              {t('automation.muse.title')}
            </a>
          </div>
        )}
    </div>
  )
}
