/**
 * Muse 工作区：状态 pill(权限档 / 待批数)→ 待批准(ask/agent 档越界动作,批准=引擎按原参数代执行)→
 * 当前思考 → 追踪中(Muse 自己 SCHEDULE.db 的 auto 条目=自触发/Track)→ 盯任务 → TODO 清单
 * (注入已有会话 / 新会话执行)。嵌在「后台智能体」视图(AgentsDetailView)与 Muse Space 右栏使用,外层容器负责 padding/滚动。
 */
import React, { useEffect, useState } from 'react'
import { Sparkles, RefreshCw, Play, Check, XCircle, Crosshair, Trash2, ShieldCheck, ShieldX, MessageSquarePlus, Repeat, FolderOpen } from 'lucide-react'
import { setActiveSpace, useWorkspace } from '@lcl/engine'
import { syncAgentSpace } from '../builtins/agentSpaceSync'
import {
  getMuseStatus, getMuseTodos, patchMuseTodo, injectMuseTodos, listMessages, getMuseTriggers, deleteMuseTrigger,
  listMuseApprovals, decideMuseApproval, getAgentSchedules, deleteAgentScheduleEntry, postMuseFeedback,
} from '../services/backendService'
import { useApp } from '../stores/appStore'
import { openNewChat } from '../sessionNav'
import type { AgentScheduleEntry, MuseStatusInfo, MuseTodo, MuseTriggerInfo, PendingApprovalInfo, SessionRecord, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

export const MuseView: React.FC<{
  cfg: TanguDesktopConfig
  sessions: SessionRecord[]
  onInjected: (sessionId: string) => void
}> = ({ cfg, sessions, onInjected }) => {
  const { t } = useI18n()
  const [status, setStatus] = useState<MuseStatusInfo | null>(null)
  const [todos, setTodos] = useState<MuseTodo[]>([])
  const [triggers, setTriggers] = useState<MuseTriggerInfo[]>([])
  const [approvals, setApprovals] = useState<PendingApprovalInfo[]>([])
  const [tracks, setTracks] = useState<AgentScheduleEntry[]>([])
  const [thinking, setThinking] = useState<string>('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<string>('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<string>('') // 正在裁决的审批 id(approve 会同步执行工具)
  // 本面板只管 Muse 唤醒式规则(无动作链/无执行者;legacy 落盘可能有显式 agentSlug:'muse'=同义);
  // 带动作的自动化在自动化 Space 统一管理
  const museTriggers = triggers.filter((tg) => !tg.actions?.length && (!tg.agentSlug || tg.agentSlug === 'muse'))

  const load = async (): Promise<void> => {
    const st = await getMuseStatus(cfg).catch(() => null)
    setStatus(st)
    void syncAgentSpace(cfg, 'muse', st?.spaceStamp) // 自建 Space 变了 → 只重载 agent-muse 插件(按戳去重)
    const nextTodos = await getMuseTodos(cfg, 'pending').catch(() => [] as MuseTodo[])
    setTodos(nextTodos)
    setSel((p) => new Set([...p].filter((id) => nextTodos.some((x) => x.id === id)))) // 已被处理/消失的 TODO 不留在选择集里
    setTriggers(await getMuseTriggers(cfg).catch(() => []))
    // 旧引擎无此端点 → 404 → 空列表(读端兜底,面板不红)。
    setApprovals(await listMuseApprovals(cfg, 'pending').catch(() => []))
    setTracks(await getAgentSchedules(cfg).then((all) => (all.find((s) => s.slug === 'muse')?.entries || []).filter((e) => e.auto)).catch(() => []))
    if (st?.sessionId) {
      const ms = await listMessages(cfg, st.sessionId, 6).catch(() => [])
      const lastAssistant = [...ms].reverse().find((m) => m.role === 'assistant' || m.role === 'model')
      setThinking(String(lastAssistant?.content || '').slice(0, 4000))
    } else {
      setThinking('')
    }
  }
  // 串行轮询:上一轮(五个请求)全部结束后再等 4s,不与慢请求重叠;cfg 变了重起。
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const loop = async (): Promise<void> => {
      if (!alive) return
      await load()
      if (alive) timer = setTimeout(() => void loop(), 4000)
    }
    void loop()
    return () => { alive = false; if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg])

  const toggle = (id: string): void => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const inject = async (): Promise<void> => {
    if (!target || !sel.size) return
    try {
      await injectMuseTodos(cfg, [...sel], target)
      setMsg(t('special.muse.injected', { n: sel.size }))
      setSel(new Set())
      onInjected(target)
    } catch (e: any) {
      setMsg(t('special.muse.injectFail', { e: e?.message || e }))
    }
  }
  /** 新会话执行(08-20 评审的第②刀):走 appStore.send(…, null) 的隐式建会话路径,沿用当前默认工作区/模型/agent。 */
  const runInNew = async (): Promise<void> => {
    if (!sel.size) return
    const picked = todos.filter((x) => sel.has(x.id))
    if (!picked.length) return
    const message = `${t('special.muse.injectPrefix')}\n\n` + picked.map((x, i) => `${i + 1}. ${x.title}${x.detail ? `\n   ${x.detail}` : ''}`).join('\n\n')
    try {
      openNewChat()
      const ok = await useApp.getState().send(message, [], undefined, undefined, undefined, null)
      if (!ok) return
      for (const x of picked) await patchMuseTodo(cfg, x.id, 'injected').catch(() => {})
      void postMuseFeedback(cfg, `todos run in a new session by user: ${picked.map((x) => `"${x.title}"`).join('; ')}`).catch(() => {})
      setMsg(t('special.muse.injected', { n: picked.length }))
      setSel(new Set())
      const sid = useApp.getState().activeId
      if (sid) onInjected(sid)
    } catch (e: any) {
      setMsg(t('special.muse.injectFail', { e: e?.message || e }))
    }
  }
  // 删除类:请求成功才动列表;失败留在原地并说明(吞掉异常后先删再被轮询复活,用户只看到「闪一下」)。
  const fail = (e: any): void => setMsg(t('special.muse.actionFail', { e: e?.message || e }))
  const setTodoStatus = async (id: string, status: MuseTodo['status']): Promise<void> => {
    try { await patchMuseTodo(cfg, id, status); setTodos((p) => p.filter((x) => x.id !== id)); setSel((p) => { const n = new Set(p); n.delete(id); return n }) } catch (e) { fail(e) }
  }
  const removeTrigger = async (id: string): Promise<void> => {
    try { await deleteMuseTrigger(cfg, id); setTriggers((p) => p.filter((x) => x.id !== id)) } catch (e) { fail(e) }
  }
  const removeTrack = async (id: string): Promise<void> => {
    try { await deleteAgentScheduleEntry(cfg, 'muse', id); setTracks((p) => p.filter((x) => x.id !== id)) } catch (e) { fail(e) }
  }
  const decide = async (a: PendingApprovalInfo, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(a.id)
    try {
      const r = await decideMuseApproval(cfg, a.id, decision)
      // 200 也可能是「批准了但工具执行失败」(status=failed,result=错误文本):不能静默当成功。
      if (r.status === 'failed') setMsg(t('special.muse.execFailed', { e: String(r.result || '').slice(0, 200) }))
      else setMsg('')
      setApprovals((p) => p.filter((x) => x.id !== a.id)) // 无论 approved/failed/rejected,它都不再是 pending
    } catch (e: any) {
      setMsg(t('special.muse.approveFail', { e: e?.message || e }))
    } finally {
      setBusy('')
    }
  }
  const condText = (tg: MuseTriggerInfo): string =>
    tg.cond.type === 'file_chars_gte'
      ? t('special.muse.trigFile', { path: tg.cond.path.split(/[\\/]/).pop() || tg.cond.path, n: tg.cond.n })

      : tg.cond.type === 'event_seen'
        ? t('special.muse.trigEvent', { match: tg.cond.match })
        : tg.cond.type === 'daily_at'
          ? t('special.muse.trigDaily', { time: tg.cond.time })
          : tg.cond.type === 'at'
            ? tg.cond.datetime.replace('T', ' ')
            : tg.cond.type === 'every'
              ? `every ${tg.cond.interval}`
              : '—'
  const modeLabel = (m: MuseStatusInfo['mode']): string =>
    m === 'auto' ? t('settings.special.m.modeAuto') : m === 'agent' ? t('settings.special.m.modeAgent') : t('settings.special.m.modeAsk')

  const running = !!status?.running
  const pendingN = approvals.length || status?.pendingApprovals || 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontWeight: 600, flexWrap: 'wrap' }}>
        <Sparkles size={16} /> {t('special.muse.title')}
        <span style={{ flex: 1 }} />
        {status?.enabled && status.mode && (
          <span className="conn-pill" style={{ fontSize: 12, fontWeight: 400 }} title={t('special.muse.modeLabel')}>{modeLabel(status.mode).split(/[（(]/)[0]}</span>
        )}
        {pendingN > 0 && <span className="conn-pill" style={{ fontSize: 12, fontWeight: 400, color: 'var(--accent-ink)' }}>{t('special.muse.pending', { n: pendingN })}</span>}
        <span className="conn-pill" style={{ fontSize: 12 }}>
          <span className="dot" style={{ background: running ? 'var(--accent-ink)' : 'var(--text-muted)' }} />
          {!status?.enabled ? t('special.muse.disabled') : running ? t('special.muse.running') : t('special.muse.idle')}
        </span>
        <button className="icon-btn" title={t('muse.openLibrary')} onClick={() => useWorkspace.getState().openView('muse-files', {}, 'main', { newTab: true })}><FolderOpen size={13} /></button>
        <button className="icon-btn" onClick={() => void load()}><RefreshCw size={13} /></button>
      </div>

      {/* 待批准:ask/agent 档下 Muse 的越界写入 / 命令。批准 = 引擎按当时的原参数直接执行(写类先留检查点),不再经模型。 */}
      {(approvals.length > 0 || !!status?.pendingApprovals) && (
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ShieldCheck size={13} /> {t('special.muse.approvals')}</label>
          {approvals.length === 0 && <div className="hint">{t('special.muse.approvalsEmpty')}</div>}
          {approvals.map((a) => (
            <div key={a.id} className="file-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
              <span className="file-name" style={{ flex: 1, whiteSpace: 'normal' }}>
                <b style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{a.preview}</b>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                  {a.tool}{a.cwd ? ` · ${a.cwd}` : ''} · {String(a.created_at).replace('T', ' ').slice(5, 16)}
                  {a.note && <div>{t('special.muse.approvalNote', { note: a.note })}</div>}
                </div>
              </span>
              <button className="btn primary sm" disabled={busy === a.id} title={t('special.muse.approve')} onClick={() => void decide(a, 'approve')}>
                <ShieldCheck size={12} /> {t('special.muse.approve')}
              </button>
              <button className="icon-btn" disabled={busy === a.id} title={t('special.muse.reject')} onClick={() => void decide(a, 'reject')}><ShieldX size={13} /></button>
            </div>
          ))}
        </div>
      )}

      {/* 当前思考 */}
      <div className="field">
        <label>{t('special.muse.thinking')}</label>
        <div style={{
          fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto',
          background: 'var(--bg-card)', border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10,
        }}>
          {thinking || <span className="hint">{status?.enabled ? '…' : t('special.muse.disabled')}</span>}
        </div>
      </div>

      {/* 追踪中:Muse 自己 SCHEDULE.db 的 auto 条目(任务卡「交给 Muse 追踪」/ Muse 自己排的后续),到期回灌它的周期;Calendar 同源可见。 */}
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Repeat size={13} /> {t('special.muse.tracks')}</label>
        {tracks.length === 0 && <div className="hint">{t('special.muse.tracksEmpty')}</div>}
        {tracks.map((e) => (
          <div key={e.id} className="file-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <span className="file-name" style={{ flex: 1, whiteSpace: 'normal' }}>
              <b>{e.name}</b>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                {e.date.replace('T', ' ')}{e.repeat ? ` · every ${e.repeat}` : ''}{e.lastRun ? ` · ${t('special.muse.trigFired', { t: new Date(e.lastRun).toLocaleString() })}` : ''}
                {e.description && <div>{e.description}</div>}
              </div>
            </span>
            <button className="icon-btn" title={t('special.muse.trackDelete')} onClick={() => void removeTrack(e.id)}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>

      {/* 盯任务(Muse 唤醒式规则):只列无动作链/无执行者的老式规则;带动作的自动化归自动化 Space 统一管理 */}
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Crosshair size={13} /> {t('special.muse.watches')}
          <span style={{ flex: 1 }} />
          <a
            style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 400, color: 'var(--accent-ink, var(--accent))' }}
            onClick={() => { useApp.getState().closeSettings(); setActiveSpace('automation') }}
          >
            {t('special.muse.watchesAll')}
          </a>
        </label>
        {museTriggers.length === 0 && <div className="hint">{t('special.muse.watchesHint')}</div>}
        {museTriggers.map((tg) => (
          <div key={tg.id} className="file-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <span className="file-name" style={{ flex: 1, whiteSpace: 'normal' }}>
              <b>{tg.desc}</b>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                {condText(tg)}{tg.lastFiredAt ? ` · ${t('special.muse.trigFired', { t: new Date(tg.lastFiredAt).toLocaleString() })}` : ''}
              </div>
            </span>
            <button className="icon-btn" title={t('special.muse.watchDelete')} onClick={() => void removeTrigger(tg.id)}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>

      {/* TODO 清单 */}
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {t('special.muse.todos')}
          <span style={{ flex: 1 }} />
          {todos.length > 0 && (
            <button className="btn ghost sm" onClick={() => setSel(sel.size === todos.length ? new Set() : new Set(todos.map((x) => x.id)))}>
              {t('special.muse.selectAll')}
            </button>
          )}
        </label>
        {todos.length === 0 && <div className="hint">{t('special.muse.todosEmpty')}</div>}
        {todos.map((td) => (
          <div key={td.id} className="file-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={sel.has(td.id)} onChange={() => toggle(td.id)} style={{ marginTop: 3 }} />
            <span className="file-name" style={{ flex: 1, whiteSpace: 'normal' }}>
              <b>{td.title}</b>
              {td.detail && <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>{td.detail}</div>}
            </span>
            <button className="icon-btn" title={t('special.muse.markDone')} onClick={() => void setTodoStatus(td.id, 'done')}><Check size={13} /></button>
            <button className="icon-btn" title={t('special.muse.dismiss')} onClick={() => void setTodoStatus(td.id, 'dismissed')}><XCircle size={13} /></button>
          </div>
        ))}
      </div>

      {/* 注入区:已有会话 / 新会话 */}
      {todos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ maxWidth: 240 }}>
            <option value="">{t('special.muse.pickSession')}</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || s.id.slice(0, 8)}</option>)}
          </select>
          <button className="btn primary sm" disabled={!target || !sel.size} onClick={() => void inject()}>
            <Play size={12} /> {t('special.muse.inject')}
          </button>
          <button className="btn ghost sm" disabled={!sel.size} onClick={() => void runInNew()}>
            <MessageSquarePlus size={12} /> {t('special.muse.runNew')}
          </button>
          {msg && <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{msg}</span>}
        </div>
      )}
    </div>
  )
}
