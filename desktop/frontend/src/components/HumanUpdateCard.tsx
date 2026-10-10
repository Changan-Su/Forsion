import { useEffect, useMemo, useState } from 'react'
import { BookOpen, ChevronRight, Undo2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { showDetails } from '../stores/detailsSubject'
import { getHumanDocument, undoHumanChange, HUMAN_CHANGED_EVENT, type HumanChange, type HumanDocument, type HumanTarget } from '../services/humanCollaboration'
import type { TanguDesktopConfig } from '../types'
import { targetForSession, type EngineTarget } from '../services/engine/targets'
import './humanMessages'
import './humanCollaboration.css'
import './selfUpdates.css'

registerMessages({
  'human.ask.title': { zh: '{name} 想请你配合 {n} 件事', en: 'Requests from {name}: {n}' },
  'human.ask.titleAnon': { zh: '想请你配合 {n} 件事', en: 'Requests for you: {n}' },
  'human.ask.saved': { zh: '已写进协作说明', en: 'Saved to the collaboration handbook' },
  'human.ask.why': { zh: '为什么：{text}', en: 'Why: {text}' },
  'human.ask.ack': { zh: '知道了', en: 'Got it' },
  'human.ask.acked': { zh: '协作请求 {n} 条 · 已知道', en: 'Handbook requests: {n} · acknowledged' },
})

// 「知道了」只是把卡收成一行(请求在卡出现时已经生效,这不是审批)。记在本机,存不下就只在本次有效。
const ACK_KEY = 'forsion.humanAck'
const readAck = (): string[] => { try { const v = JSON.parse(localStorage.getItem(ACK_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] } }
const writeAck = (ids: string[]): void => { try { localStorage.setItem(ACK_KEY, JSON.stringify([...new Set(ids)].slice(-200))) } catch { /* ignore */ } }

/** 协作说明是 Agent 对用户提的请求:用户不看它就白写了,所以它不进回执行,单独一张卡,用 Agent 的口吻,把依据直接摆出来。
 *  One quiet card per assistant response, with all successful changes in that turn. */
export function HumanUpdateCard({ changes, cfg, sessionId, agentName }: { changes: HumanChange[]; cfg: TanguDesktopConfig; sessionId: string; agentName?: string }) {
  const { t } = useI18n()
  const ids = changes.map(c => c.id).join(',')
  const engine = targetForSession(sessionId)
  // ackedIds 记的是「点知道了时卡里有哪几条」:之后同一条回复里又多出一条请求,卡重新展开
  const [ackedIds, setAckedIds] = useState(''), [reopened, setReopened] = useState(false)
  const stored = useMemo(() => { const seen = new Set(readAck()); return changes.every(c => seen.has(c.id)) }, [ids]) // eslint-disable-line react-hooks/exhaustive-deps
  const acked = stored || ackedIds === ids
  useEffect(() => { if (ids) window.dispatchEvent(new CustomEvent(HUMAN_CHANGED_EVENT)) }, [ids])
  if (!changes.length) return null
  if (acked && !reopened) return <button type="button" className="human-acked" data-human-updates data-human-acked onClick={() => setReopened(true)}>
    <BookOpen size={15} />{t('human.ask.acked', { n: changes.length })}<ChevronRight size={12} />
  </button>
  const ack = () => { writeAck([...readAck(), ...changes.map(c => c.id)]); setReopened(false); setAckedIds(ids) }
  return <section className="human-update-card" data-human-updates>
    <div className="human-update-head"><BookOpen size={15} /><strong>{agentName ? t('human.ask.title', { name: agentName, n: changes.length }) : t('human.ask.titleAnon', { n: changes.length })}</strong><span className="human-ask-saved">{t('human.ask.saved')}</span></div>
    {changes.map(change => <HumanUpdate key={JSON.stringify([engine.key, engine.base, cfg.token, change.id])} change={change} engine={engine} cfg={cfg} sessionId={sessionId} />)}
    <div className="human-ask-foot"><button type="button" className="btn sm" onClick={ack}>{t('human.ask.ack')}</button></div>
  </section>
}
function HumanUpdate({ change, engine, cfg, sessionId }: { change: HumanChange; engine: EngineTarget; cfg: TanguDesktopConfig; sessionId: string }) {
  const { t } = useI18n()
  const scope = change.scope
  const name = useApp(s => scope.kind === 'agent' ? s.agentDefs.find(a => a.slug === scope.slug)?.name || scope.slug : scope.cwd.split(/[\\/]/).filter(Boolean).at(-1))
  const projectPath = useApp(s => [...s.sessions, ...s.archivedSessions].find(x => x.id === sessionId)?.project_path)
  const [doc, setDoc] = useState<HumanDocument | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const target: HumanTarget = change.scope.kind === 'agent' ? change.scope : { kind: 'project', sessionId }
  const validScope = (d: HumanDocument) => d.scope.kind === scope.kind && (d.scope.kind === 'agent' && scope.kind === 'agent' ? d.scope.slug === scope.slug : d.scope.kind === 'project' && scope.kind === 'project' && d.scope.cwd === scope.cwd)
  useEffect(() => {
    let alive = true
    const refresh = () => { void getHumanDocument(engine, target).then(d => { if (alive && validScope(d)) setDoc(d) }).catch(() => {}) }
    refresh(); window.addEventListener(HUMAN_CHANGED_EVENT, refresh)
    return () => { alive = false; window.removeEventListener(HUMAN_CHANGED_EVENT, refresh) }
  }, [engine.key, engine.base, cfg.token, change.id, sessionId])
  const undone = !!doc?.history.some(h => h.undoOf === change.id)
  const canUndo = !!doc?.history.some(h => h.id === change.id && h.canUndo)
  const open = (edit = false) => showDetails({ ...(change.scope.kind === 'agent' ? { kind: 'agent' as const, slug: change.scope.slug } : { kind: 'project' as const, path: projectPath || change.scope.cwd }), human: { at: Date.now(), edit, changeId: change.id } })
  const undo = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { const r = await undoHumanChange(engine, target, change); setDoc(r.document) }
    catch (e: any) { setError(e?.status === 409 ? t('human.undoConflict') : String(e?.message || e)) }
    finally { setBusy(false) }
  }
  return <article data-human-update={change.id}>
    <div className="human-scope">{name} · {t(change.scope.kind === 'agent' ? 'human.agent' : 'human.project')} · <span className="human-applied">{t(undone ? 'human.undone' : 'human.applied')}</span></div>
    <p className="human-say">{change.summary}</p>
    {change.evidence && <p className="human-why">{t('human.ask.why', { text: change.evidence })}</p>}
    <div className="human-actions"><button type="button" className="profile-text-action" onClick={() => open()}>{t('human.view')}</button><button type="button" className="profile-text-action" onClick={() => open(true)}>{t('human.revise')}</button>
      {!undone && <button type="button" className="profile-text-action" disabled={busy || !canUndo} title={!canUndo && doc ? t('human.undoConflict') : undefined} onClick={() => void undo()}><Undo2 size={12} />{t('human.undo')}</button>}
    </div>
    {error && <p className="agent-profile-error" role="alert">{error}</p>}
  </article>
}
