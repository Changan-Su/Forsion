import { useCallback, useEffect, useRef, useState } from 'react'
import { FileCode2, History, Loader2, MoreHorizontal, Pencil, RefreshCw, Undo2 } from 'lucide-react'
import { Markdown } from './Markdown'
import { CapabilityMenu } from './CapabilityMenu'
import { useI18n } from '../i18n'
import { formatRelative, formatDateTime } from '../format/time'
import type { TanguDesktopConfig } from '../types'
import type { EngineTarget } from '../services/engine/targets'
import { getHumanDocument, saveHumanDocument, undoHumanChange, humanTargetKey, humanLegacy, HUMAN_CHANGED_EVENT, type HumanChange, type HumanDocument, type HumanTarget, type HumanJump } from '../services/humanCollaboration'
import './humanMessages'
import './humanCollaboration.css'

type Draft = { content: string; version: string }
const drafts = new Map<string, Draft>()
/** onRewrite:把「重写」那句话发进对话(由挂载处决定发给哪个会话)。null = 这里现在发不了(没有本机会话 / 计划模式),菜单项置灰并写明原因;
 *  不传 = 这一份不归当前会话的 Agent 写(项目页里「同时适用」的那几份),不出这一项。 */
type Props = { engine: EngineTarget; cfg: TanguDesktopConfig; target: HumanTarget; name: string; running?: boolean; jump?: HumanJump; onRewrite?: (() => void) | null }
export function HumanCollaborationPanel(props: Props) {
  const key = JSON.stringify([props.engine.key, props.engine.base, props.cfg.token, humanTargetKey(props.target)])
  return <HumanBody key={key} {...props} draftKey={key} />
}
function HumanBody({ engine, target, name, running, jump, onRewrite, draftKey }: Props & { draftKey: string }) {
  const { t, locale } = useI18n()
  const [doc, setDoc] = useState<HumanDocument | null>(null)
  const [draft, setDraft] = useState<Draft | null>(() => drafts.get(draftKey) || null)
  const draftRef = useRef(draft); draftRef.current = draft
  const [source, setSource] = useState(false), [history, setHistory] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false), [latest, setLatest] = useState<HumanDocument | null>(null)
  const alive = useRef(true), seq = useRef(0), processedJump = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; seq.current++ } }, [])
  const changeDraft = (next: Draft | null) => { draftRef.current = next; setDraft(next); if (next) drafts.set(draftKey, next); else drafts.delete(draftKey) }
  const errorText = (e: any) => e?.code === 'HUMAN_LOCAL_ONLY' ? t('human.localOnly') : e?.code === 'HUMAN_REMOTE_DENIED' ? t('human.remoteDenied') : String(e?.message || e)
  const load = useCallback(async () => {
    const n = ++seq.current
    try { const d = await getHumanDocument(engine, target); if (alive.current && n === seq.current) { setDoc(d); const pending = draftRef.current; if (pending && pending.version !== d.version && pending.content === d.content) changeDraft(null); if (!draftRef.current) setError('') } }
    catch (e) { if (alive.current && n === seq.current) setError(errorText(e)) }
  }, [draftKey, locale]) // identity is encoded by draftKey
  useEffect(() => { void load(); const refresh = () => { void load() }; window.addEventListener(HUMAN_CHANGED_EVENT, refresh); return () => window.removeEventListener(HUMAN_CHANGED_EVENT, refresh) }, [load, running])
  useEffect(() => {
    if (!doc || !jump?.at || processedJump.current === jump.at) return
    processedJump.current = jump.at
    if (jump.edit && !draftRef.current) changeDraft({ content: doc.content || t('human.template'), version: doc.version })
    if (jump.changeId) setHistory(true)
  }, [jump, doc])
  const save = async (version = draft?.version) => {
    if (!draft || !version || busy) return
    const submitted = draft
    setBusy(true); setError(''); setNotice(''); ++seq.current
    try { const r = await saveHumanDocument(engine, target, draft.content, version, t('human.userEdit')); if (drafts.get(draftKey) === submitted) drafts.delete(draftKey); if (alive.current) { setDoc(r.document); changeDraft(null); setConflict(false); setLatest(null); setNotice(t('human.saved')) } }
    catch (e: any) { if (alive.current) { setConflict(e?.status === 409); setError(e?.status === 409 ? t('human.conflict') : errorText(e)) } }
    finally { if (alive.current) setBusy(false) }
  }
  const undo = async (change: HumanChange) => {
    if (busy || draft) return
    setBusy(true); setError(''); ++seq.current
    try { const r = await undoHumanChange(engine, target, change); if (alive.current) { setDoc(r.document); setNotice(t('human.undone')) } }
    catch (e: any) { if (alive.current) setError(e?.status === 409 ? t('human.undoConflict') : errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const rewrite = () => { if (!onRewrite || running || draft) return; setError(''); onRewrite(); setNotice(t('human.rewrite.sent')) }
  const reviewLatest = async () => { try { const d = await getHumanDocument(engine, target); if (alive.current) setLatest(d) } catch (e) { if (alive.current) setError(errorText(e)) } }
  return <section className="human-panel" data-human-scope={target.kind} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's' && draft) { e.preventDefault(); e.stopPropagation(); void save() } }}>
    <header className="human-heading"><div><h3>{t('human.title')}</h3><p>{target.kind === 'agent' ? t('human.agentScope', { name }) : t('human.projectScope')}</p></div><div className="human-actions">
      {!draft && <button type="button" className="profile-text-action" disabled={!doc || busy} onClick={() => doc && changeDraft({ content: doc.content || t('human.template'), version: doc.version })}><Pencil size={13} />{t('human.edit')}</button>}
      <CapabilityMenu className="profile-text-action human-more" label={t('human.more')} disabled={!doc} items={[
        { id: 'source', label: t(source ? 'human.preview' : 'human.source'), icon: <FileCode2 size={14} />, onSelect: () => setSource(!source) },
        { id: 'history', label: t('human.history'), icon: <History size={14} />, onSelect: () => setHistory(!history) },
        ...(onRewrite !== undefined ? [{ id: 'rewrite', label: t('human.rewrite'), icon: <RefreshCw size={14} />, hint: onRewrite ? undefined : t('human.rewrite.unavailable'), disabled: !onRewrite || !!running || !!draft || !doc?.content.trim(), onSelect: rewrite }] : []),
      ]}><MoreHorizontal size={16} /></CapabilityMenu>
    </div></header>
    {error && <p className="agent-profile-error" role="alert">{error} {!doc && <button type="button" className="profile-text-action" onClick={() => void load()}>{t('human.retry')}</button>}</p>}
    {notice && <p className="human-notice" role="status">{notice}</p>}
    {doc && !draft && humanLegacy(doc) && <p className="human-notice" data-human-legacy>{t('human.legacy')} {onRewrite && <button type="button" className="profile-text-action" disabled={!!running} onClick={rewrite}><RefreshCw size={12} />{t('human.rewrite')}</button>}</p>}
    {!doc && !error && <p className="agent-profile-muted" role="status"><Loader2 size={14} className="spin" /> {t('human.loading')}</p>}
    {doc?.updatedAt && <p className="human-date">{t('human.updatedAt', { time: formatRelative(doc.updatedAt, { locale }) })}</p>}
    {draft ? <div className="human-editor"><textarea aria-label={t('human.editLabel')} value={draft.content} maxLength={doc?.maxLength || 12000} rows={15} onChange={e => changeDraft({ ...draft, content: e.target.value })} disabled={busy} />
      <div className="human-actions"><button type="button" className="btn primary sm" disabled={busy || conflict} onClick={() => void save()}>{busy && <Loader2 size={13} className="spin" />}{t('human.save')}</button><button type="button" className="btn sm" disabled={busy} onClick={() => { changeDraft(null); setConflict(false); setLatest(null); setError('') }}>{t('human.cancel')}</button></div>
      {conflict && <button type="button" className="profile-text-action" onClick={() => void reviewLatest()}>{t('human.latest')}</button>}
      {latest && <section className="human-latest"><div className="md-body"><Markdown content={latest.content} allowRun={false} /></div><button type="button" className="btn sm" disabled={busy} onClick={() => void save(latest.version)}>{t('human.merge')}</button></section>}
    </div> : doc && (doc.content ? source ? <pre className="human-source">{doc.content}</pre> : <div className="md-body"><Markdown content={doc.content} allowRun={false} /></div> : <p className="human-empty">{t('human.empty')}</p>)}
    {source && doc && <div className="human-path"><span>{t('human.path')}</span><code>{doc.path}</code></div>}
    {history && doc && <section className="human-history"><h4>{t('human.history')}</h4>{!doc.history.length && <p>{t('human.noHistory')}</p>}
      {doc.history.map(change => <article key={change.id} data-human-change={change.id} className={change.id === jump?.changeId ? 'human-highlight' : undefined}>
        <strong>{change.summary}</strong><time dateTime={change.at}>{formatDateTime(change.at, { locale })}</time>
        {change.evidence && <p>{change.evidence}</p>}
        {change.canUndo && <button type="button" className="profile-text-action" disabled={busy || !!draft} onClick={() => void undo(change)}><Undo2 size={12} />{t('human.undo')}</button>}
      </article>)}
    </section>}
  </section>
}
