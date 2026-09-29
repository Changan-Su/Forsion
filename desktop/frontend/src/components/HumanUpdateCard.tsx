import { useEffect, useState } from 'react'
import { BookOpen, Undo2 } from 'lucide-react'
import { useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { showDetails } from '../stores/detailsSubject'
import { getHumanDocument, undoHumanChange, HUMAN_CHANGED_EVENT, type HumanChange, type HumanDocument, type HumanTarget } from '../services/humanCollaboration'
import type { TanguDesktopConfig } from '../types'
import './humanMessages'
import './humanCollaboration.css'

/** One quiet card per assistant response, with all successful changes in that turn. */
export function HumanUpdateCard({ changes, cfg, sessionId }: { changes: HumanChange[]; cfg: TanguDesktopConfig; sessionId: string }) {
  const { t } = useI18n()
  const ids = changes.map(c => c.id).join(',')
  useEffect(() => { if (ids) window.dispatchEvent(new CustomEvent(HUMAN_CHANGED_EVENT)) }, [ids])
  if (!changes.length) return null
  return <section className="human-update-card" data-human-updates>
    <div className="human-update-head"><BookOpen size={15} /><strong>{t('human.updated')}</strong></div>
    {changes.map(change => <HumanUpdate key={JSON.stringify([cfg.backendUrl, cfg.token, change.id])} change={change} cfg={cfg} sessionId={sessionId} />)}
  </section>
}
function HumanUpdate({ change, cfg, sessionId }: { change: HumanChange; cfg: TanguDesktopConfig; sessionId: string }) {
  const { t } = useI18n()
  const scope = change.scope
  const name = useApp(s => scope.kind === 'agent' ? s.agentDefs.find(a => a.slug === scope.slug)?.name || scope.slug : scope.cwd.split(/[\\/]/).filter(Boolean).at(-1))
  const projectPath = useApp(s => [...s.sessions, ...s.archivedSessions].find(x => x.id === sessionId)?.project_path)
  const [doc, setDoc] = useState<HumanDocument | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const target: HumanTarget = change.scope.kind === 'agent' ? change.scope : { kind: 'project', sessionId }
  const validScope = (d: HumanDocument) => d.scope.kind === scope.kind && (d.scope.kind === 'agent' && scope.kind === 'agent' ? d.scope.slug === scope.slug : d.scope.kind === 'project' && scope.kind === 'project' && d.scope.cwd === scope.cwd)
  useEffect(() => {
    let alive = true
    const refresh = () => { void getHumanDocument(cfg, target).then(d => { if (alive && validScope(d)) setDoc(d) }).catch(() => {}) }
    refresh(); window.addEventListener(HUMAN_CHANGED_EVENT, refresh)
    return () => { alive = false; window.removeEventListener(HUMAN_CHANGED_EVENT, refresh) }
  }, [cfg.backendUrl, cfg.token, change.id, sessionId])
  const undone = !!doc?.history.some(h => h.undoOf === change.id)
  const canUndo = !!doc?.history.some(h => h.id === change.id && h.canUndo)
  const open = (edit = false) => showDetails({ ...(change.scope.kind === 'agent' ? { kind: 'agent' as const, slug: change.scope.slug } : { kind: 'project' as const, path: projectPath || change.scope.cwd }), human: { at: Date.now(), edit, changeId: change.id } })
  const undo = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { const r = await undoHumanChange(cfg, target, change); setDoc(r.document) }
    catch (e: any) { setError(e?.status === 409 ? t('human.undoConflict') : String(e?.message || e)) }
    finally { setBusy(false) }
  }
  return <article data-human-update={change.id}>
    <div className="human-scope">{name} · {t(change.scope.kind === 'agent' ? 'human.agent' : 'human.project')} · <span className="human-applied">{t(undone ? 'human.undone' : 'human.applied')}</span></div>
    <p>{change.summary}</p>
    {change.evidence && <details><summary>{t('human.evidence')}</summary><p>{change.evidence}</p></details>}
    <div className="human-actions"><button type="button" className="profile-text-action" onClick={() => open()}>{t('human.view')}</button><button type="button" className="profile-text-action" onClick={() => open(true)}>{t('human.revise')}</button>
      {!undone && <button type="button" className="profile-text-action" disabled={busy || !canUndo} title={!canUndo && doc ? t('human.undoConflict') : undefined} onClick={() => void undo()}><Undo2 size={12} />{t('human.undo')}</button>}
    </div>
    {error && <p className="agent-profile-error" role="alert">{error}</p>}
  </article>
}
