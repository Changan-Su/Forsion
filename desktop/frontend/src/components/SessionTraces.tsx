import { useEffect, useMemo, useRef, useState } from 'react'
import { History, Undo2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { showDetails } from '../stores/detailsSubject'
import { getAgentHarness, getSessionActivity, rollbackHarnessEntry, type HarnessJournalLine } from '../services/backendService'
import { HARNESS_CHANGED_EVENT } from '../services/harnessUpdates'
import { anchorTraces, sessionTraces, type SessionTrace } from '../services/selfUpdates'
import { targetForSession } from '../services/engine/targets'
import type { HistorianActivityItem } from '../types'
import './HarnessUpdateCard' // 复用「本次更新已撤销 / 撤销冲突」等词条
import './selfUpdates.css'

registerMessages({
  'selfTrace.adopted': { zh: '复盘时学到一个做法：', en: 'Learned in review:' },
  'selfTrace.confirm': { zh: '复盘时有 {n} 条做法留给你确认', en: 'Evolution record: {n} left for you to confirm' },
  'selfTrace.projectAdded': { zh: '复盘时记进项目记忆：', en: 'Saved to project memory in review:' },
  'selfTrace.projectConfirm': { zh: '复盘时有 {n} 条项目事实留给你确认', en: 'Project memory: {n} left for you to confirm' },
  'selfTrace.projectCompacted': { zh: '项目记忆写满，压缩了一遍；被合并的原句可以恢复', en: 'Project memory was full and has been compacted; merged sentences can be restored' },
  'selfTrace.view': { zh: '查看', en: 'View' },
  'selfTrace.undo': { zh: '撤销', en: 'Undo' },
})

/** 右栏的 Historian 行每 2.5s 轮询活动流:它一见到新的提名 / 采纳就喊一声,对话里的留痕跟着重读。 */
export const SESSION_TRACES_EVENT = 'forsion:session-traces-changed'

/** 后台复盘在这段对话之后写下的东西 → 按「它发生时最后一条回复」分好组(消息 id → 留痕)。
 *  活动流只在本机引擎上有(云端 / 老引擎读不到 → 没有留痕,不报错)。复盘比回复晚几秒到十几秒,所以 run 一结束先后再读三次。 */
export function useSessionTraces(sessionId: string | null | undefined, messages: Array<{ id: string; role: string; timestamp: number }>, enabled = true): Map<string, SessionTrace[]> {
  const [data, setData] = useState<{ sid: string; activity: HistorianActivityItem[]; journal: HarnessJournalLine[] } | null>(null)
  const slug = useApp((s) => (sessionId ? s.configBySession[sessionId]?.agentSlug || s.defaultAgentSlug : ''))
  const running = useApp((s) => !!(sessionId && s.runningBySession[sessionId]))
  const connected = useApp((s) => s.connState === 'ok')
  const wasRunning = useRef(false)
  useEffect(() => {
    const justEnded = wasRunning.current && !running
    wasRunning.current = running
    if (!sessionId || !enabled || !connected) { setData(null); return }
    let alive = true
    const engine = targetForSession(sessionId)
    let seq = 0
    const load = async (): Promise<void> => {
      const mine = ++seq
      try {
        const activity = await getSessionActivity(engine, sessionId)
        const journal = slug && activity.some((a) => a.action === 'harness_adopted') ? await getAgentHarness(engine, slug).then((r) => r.journal, () => []) : []
        if (alive && mine === seq) setData({ sid: sessionId, activity, journal }) // 先发的慢请求不许盖掉后发的结果
      } catch { /* 没有活动流的后端:不留痕 */ }
    }
    // 打开一段长对话时,每条带回执的消息都会喊一次「进化记录变了」:并成一次读
    let pending: ReturnType<typeof setTimeout> | undefined
    const soon = (): void => { clearTimeout(pending); pending = setTimeout(() => void load(), 300) }
    soon()
    const later = justEnded ? [5000, 15000, 40000].map((ms) => setTimeout(() => void load(), ms)) : []
    window.addEventListener(SESSION_TRACES_EVENT, soon); window.addEventListener(HARNESS_CHANGED_EVENT, soon)
    return () => {
      alive = false; clearTimeout(pending); later.forEach(clearTimeout)
      window.removeEventListener(SESSION_TRACES_EVENT, soon); window.removeEventListener(HARNESS_CHANGED_EVENT, soon)
    }
  }, [sessionId, enabled, connected, slug, running])
  // 流式时消息数组每个 token 都换:按「哪些回复、各自的时刻」记,不跟着重算
  const sig = messages.map((m) => (m.role === 'user' ? '' : `${m.id}:${m.timestamp}`)).join('|')
  return useMemo(
    () => (data && data.sid === sessionId ? anchorTraces(messages, sessionTraces(data.activity, data.journal, data.sid)) : new Map<string, SessionTrace[]>()),
    [data, sessionId, sig], // eslint-disable-line react-hooks/exhaustive-deps
  )
}

/** 钉在一条回复后面的留痕。每行一句:写了什么 + 去哪看;后台采纳的进化记录在本机编辑史里对得上时可以当场撤销。 */
export function SessionTraceLines({ traces, sessionId }: { traces: SessionTrace[]; sessionId: string }) {
  const { t, locale } = useI18n()
  const slug = useApp((s) => s.configBySession[sessionId]?.agentSlug || s.defaultAgentSlug)
  const projectPath = useApp((s) => [...s.sessions, ...s.archivedSessions].find((x) => x.id === sessionId)?.project_path || '')
  const [busy, setBusy] = useState(''), [errors, setErrors] = useState<Record<string, string>>({})
  const undo = async (trace: SessionTrace) => {
    if (busy || !trace.undo) return
    setBusy(trace.id); setErrors((e) => ({ ...e, [trace.id]: '' }))
    try { await rollbackHarnessEntry(targetForSession(sessionId), slug, trace.undo.entryId, trace.undo.rev) }
    catch (e: any) { setErrors((x) => ({ ...x, [trace.id]: e?.status === 409 ? t('harness.undoConflict') : String(e?.message || e) })) }
    finally { setBusy(''); window.dispatchEvent(new CustomEvent(HARNESS_CHANGED_EVENT)) }
  }
  const openAgent = () => showDetails({ kind: 'agent', slug, evolution: Date.now() })
  const openProject = projectPath ? () => showDetails({ kind: 'project', path: projectPath }) : undefined
  const sep = locale === 'zh' ? '；' : '; '
  return <>
    {traces.map((trace) => {
      const n = trace.items.length || 1
      const harness = trace.kind === 'harness_adopted' || trace.kind === 'harness_confirm'
      const open = harness ? openAgent : openProject
      const undone = trace.undo?.state === 'undone'
      return <div className="self-trace" key={trace.id} data-self-trace={trace.kind} data-trace-state={trace.undo?.state}>
        <History size={15} className="self-trace-ic" />
        <span className="self-trace-text">
          {trace.kind === 'harness_adopted' && <>{t('selfTrace.adopted')}<b>{trace.items[0]}</b>{undone && <> · {t('harness.undone')}</>}</>}
          {trace.kind === 'harness_confirm' && t('selfTrace.confirm', { n })}
          {trace.kind === 'project_memory_added' && <>{t('selfTrace.projectAdded')}<b>{trace.items.join(sep)}</b></>}
          {trace.kind === 'project_memory_candidates' && t('selfTrace.projectConfirm', { n })}
          {trace.kind === 'project_memory_compacted' && t('selfTrace.projectCompacted')}
          {errors[trace.id] && <span className="agent-profile-error" role="alert"> {errors[trace.id]}</span>}
        </span>
        <span className="self-trace-ops">
          {open && <button type="button" className="self-act" onClick={open}>{t('selfTrace.view')}</button>}
          {trace.undo?.state === 'current' && <button type="button" className="self-act" disabled={!!busy} onClick={() => void undo(trace)}><Undo2 size={12} />{t('selfTrace.undo')}</button>}
        </span>
      </div>
    })}
  </>
}
