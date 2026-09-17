import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronRight, Loader2, X } from 'lucide-react'
import type { Leaf } from '@lcl/engine/types'
import { listActiveRuns } from '../../services/agentRunService'
import { recordToUi, useApp } from '../../stores/appStore'
import { useChildChat } from '../../stores/childChatStore'
import { getBackgroundSessions, getSessionDetail, listMessages, openTeamMemberSession, type BackgroundSessionInfo } from '../../services/backendService'
import { registerMessages, useI18n } from '../../i18n'
import { ChatView } from '../ChatView'
import { useDeskGrip } from './AgentDesk'
import './childChat.css'

registerMessages({
  'childchat.title': { zh: '子会话', en: 'Child conversation' },
  'childchat.hint': { zh: '消息仅发送给这个子会话，保留与主会话的关联。', en: 'Messages stay in this child conversation, linked to the main conversation.' },
  'childchat.notStarted': { zh: '正在打开成员子会话…', en: 'Opening the member’s conversation…' },
  'childchat.legacy': { zh: '这条旧子任务没有保存独立会话。新任务会保留完整记录。', en: 'This older task has no saved child conversation. New tasks retain their full history.' },
  'childchat.retry': { zh: '重新载入', en: 'Reload' },
})

/** Both persisted background work and live delegate events appear in the same compact list. */
export function SubChatStatus({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const live = useApp((s) => s.subChatsBySession[sessionId])
  const [saved, setSaved] = useState<BackgroundSessionInfo[]>([])
  useEffect(() => {
    let disposed = false
    setSaved([])
    const load = () => void getBackgroundSessions(cfg, sessionId).then((rows) => {
      if (!disposed) setSaved(rows.filter((r) => r.kind !== 'teamwork'))
    }).catch(() => {})
    load()
    const timer = setInterval(load, 4000)
    return () => { disposed = true; clearInterval(timer) }
  }, [cfg, sessionId])
  const rows = saved.map((r) => ({ id: r.sessionId, title: r.title || r.kind, sessionId: r.sessionId, runId: r.runId || undefined, streaming: r.runStatus === 'running' || r.runStatus === 'queued' }))
  for (const l of live || []) {
    if (!rows.some((r) => r.sessionId === l.sessionId || (r.runId && r.runId === l.runId))) rows.push({ id: l.id, title: l.title, sessionId: l.sessionId!, runId: l.runId, streaming: l.streaming })
  }
  if (!rows.length) return null
  return <div className="t2o-team-status" data-subchat-status>
    {rows.map((r) => <button key={r.id} type="button" className="t2o-desk-row" onClick={() => useChildChat.getState().open(sessionId, r)}>
      <Bot size={16} /><span className="t2o-desk-name">{r.title}</span>
      <span className="t2o-desk-activity">{t(r.streaming ? 'teamdesk.status.working' : 'teamdesk.status.done')}</span>
      <ChevronRight size={12} />
    </button>)}
  </div>
}

export function ChildChatPanel({ parentId }: { parentId: string }) {
  const target = useChildChat((s) => s.selected[parentId])
  const member = useApp((s) => target?.slug ? s.teamWorkBySession[parentId]?.[target.slug] : undefined)
  const sessionId = member?.sessionId || target?.sessionId
  const runId = member?.runId || target?.runId
  const delegateRunning = useApp((s) => (s.subChatsBySession[parentId] || []).some((c) => c.sessionId === sessionId && c.streaming) && !!s.runningBySession[parentId])
  const cfg = useApp((s) => s.cfg)
  const fraction = useApp((s) => s.deskBySession[parentId]?.fraction ?? 0.52)
  const root = useRef<HTMLDivElement>(null)
  const grip = useDeskGrip(parentId, root)
  const { t } = useI18n()
  const [ready, setReady] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [persistedBusy, setPersistedBusy] = useState(false)
  useEffect(() => {
    if (!target?.slug || sessionId) return
    let disposed = false
    setError('')
    void openTeamMemberSession(cfg, parentId, target.slug).then((session) => {
      if (!disposed) { useChildChat.getState().open(parentId, { ...target, sessionId: session.id }); void useApp.getState().hydrateTeamWork(parentId) }
    }).catch((e) => { if (!disposed) setError(String(e.message || e)) })
    return () => { disposed = true }
  }, [cfg, parentId, target?.slug, sessionId, retry])
  useEffect(() => {
    setReady(''); setError(''); setPersistedBusy(false)
    if (!sessionId) return
    let disposed = false
    void getSessionDetail(cfg, sessionId).then(async (session) => {
      if (disposed) return
      setPersistedBusy(!!session.delegate_running)
      useChildChat.getState().remember(session)
      // Keep hidden sessions out of the main list; their configuration is still shared with ChatView.
      useApp.setState((s) => ({ configBySession: { ...s.configBySession, [sessionId]: { ...session.agent_config, ...s.configBySession[sessionId] } } }))
      await useApp.getState().loadSessionHistory(sessionId)
      if (!disposed) setReady(sessionId)
    }).catch((e) => { if (!disposed) setError(String(e.message || e)) })
    return () => { disposed = true }
  }, [cfg, sessionId, retry])
  useEffect(() => {
    if (!sessionId || !persistedBusy) return
    let disposed = false
    const timer = setInterval(() => void getSessionDetail(cfg, sessionId).then((s) => {
      if (!disposed && !s.delegate_running) {
        void listMessages(cfg, sessionId).then((records) => {
          if (disposed) return
          useApp.setState((state) => {
            const restored = records.map((r) => recordToUi(r, undefined, (slug) => state.agentDefs.find((a) => a.slug === slug)?.name))
            const ids = new Set(restored.map((m) => m.id))
            return { messagesBySession: { ...state.messagesBySession, [sessionId]: [...restored, ...(state.messagesBySession[sessionId] || []).filter((m) => !ids.has(m.id))].sort((a, b) => a.timestamp - b.timestamp) } }
          })
          setPersistedBusy(false)
        }).catch(() => {})
      }
    }).catch(() => {}), 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [cfg, sessionId, persistedBusy])
  // Team members can activate again while their panel remains open. Subscribe to that new run too.
  useEffect(() => {
    if (!sessionId || !runId || ready !== sessionId) return
    let disposed = false
    void listActiveRuns(cfg, sessionId).then((runs) => {
      if (disposed) return
      const run = runs.find((r) => r.id === runId && (r.status === 'running' || r.status === 'queued'))
      if (!run?.assistant_message_id) return
      const mid = run.assistant_message_id
      useApp.setState((s) => {
        const messages = s.messagesBySession[sessionId] || []
        return messages.some((m) => m.id === mid) ? {} : { messagesBySession: { ...s.messagesBySession, [sessionId]: [...messages, { id: mid, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() }] } }
      })
      useApp.getState().subscribeRun(sessionId, runId, mid)
    }).catch(() => {})
    return () => { disposed = true }
  }, [cfg, sessionId, runId, ready])
  const leaf = useMemo<Leaf>(() => ({
    id: `child-chat:${parentId}:${sessionId}`, type: 'child-chat', loc: 'right', params: {},
    setTitle: () => {}, setParams: () => {}, close: () => useChildChat.getState().close(parentId),
  }), [parentId, sessionId])
  if (!target) return null
  return <div ref={root} className="agent-desk open child-chat-panel" data-team-desk="panel" style={{ '--desk-w': `${fraction * 100}%` } as React.CSSProperties}>
    <div className="agent-desk-grip" onPointerDown={grip} />
    <div className="agent-desk-inner">
      <div className="agent-desk-head"><Bot size={15} /><strong className="agent-desk-title">{target.title}</strong><span className="agent-desk-note">{t('childchat.title')}</span><button className="icon-btn" aria-label={t('teamdesk.collapse')} onClick={leaf.close}><X size={16} /></button></div>
      <div className="child-chat-hint">{t('childchat.hint')}</div>
      {error ? <div className="child-chat-placeholder" role="alert">{error}<button onClick={() => setRetry((v) => v + 1)}>{t('childchat.retry')}</button></div>
        : !sessionId ? <div className="child-chat-placeholder">{t(target.slug ? 'childchat.notStarted' : 'childchat.legacy')}</div>
          : ready !== sessionId ? <div className="child-chat-placeholder"><Loader2 className="spin" size={18} /></div>
            : <ChatView key={sessionId} leaf={leaf} params={{ followActive: false, sessionId, childSurface: true, readOnly: delegateRunning || persistedBusy }} />}
    </div>
  </div>
}
