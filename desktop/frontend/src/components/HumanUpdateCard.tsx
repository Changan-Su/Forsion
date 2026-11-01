import { useEffect, useState, useSyncExternalStore } from 'react'
import { ArrowDown, BookOpen, ChevronRight, Undo2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { showDetails } from '../stores/detailsSubject'
import { openHumanProfile } from '../views/agentProfileNav'
import { ackHumanChanges, getHumanDocument, humanAcked, humanAckVersion, humanUndone, markHumanUndone, subscribeHumanAck, undoHumanChange, HUMAN_CHANGED_EVENT, type HumanChange, type HumanDocument, type HumanTarget } from '../services/humanCollaboration'
import { TASK_CARD_TTL_MS } from '../views/chat2/pendingTasks'
import type { TanguDesktopConfig } from '../../../../tangu-agent/src/contracts/clientTypes'
import { targetForSession, type EngineTarget } from '../services/engine/targets'
import { agentName } from '../agentName'
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
  'human.ask.undoneAll': { zh: '协作请求 {n} 条 · 已撤销', en: 'Handbook requests: {n} · undone' },
  'human.ask.undoAll': { zh: '撤销', en: 'Undo' },
  'human.ask.undoAllN': { zh: '全部撤销', en: 'Undo all' },
  'human.ask.inDeck': { zh: '{name}想请你配合 {n} 件事 · 在对话最下面', en: 'Requests from {name}: {n} · at the end of the chat' },
  'human.ask.inDeckAnon': { zh: '想请你配合 {n} 件事 · 在对话最下面', en: 'Requests for you: {n} · at the end of the chat' },
})

/** 处理记录一变就重渲(卡片堆据此把处理过的卡拿走;流里那行跟着变)。 */
export function useHumanAckVersion(): number { return useSyncExternalStore(subscribeHumanAck, humanAckVersion) }

const targetOf = (change: HumanChange, sessionId: string): HumanTarget => change.scope.kind === 'project' ? { kind: 'project', sessionId } : change.scope

/** 协作说明是 Agent 对用户提的请求:用户不看它就白写了,所以它不进回执行,单独一张卡,用 Agent 的口吻,把依据直接摆出来。
 *  One quiet card per assistant response, with all successful changes in that turn.
 *  10-23 起它是交互卡片:有对话末尾卡片堆的视图里(onJump),还没「知道了」/ 撤销的整张进卡片堆(inDeck 那份),
 *  流里原处只留一行指过去;处理过的照旧收成一行(点开看全卡)。过了 7 天没处理的不进卡片堆,原处照旧摆整张。 */
export function HumanUpdateCard({ changes, cfg, sessionId, agentName, inDeck = false, onJump, createdAt }: {
  changes: HumanChange[]; cfg: TanguDesktopConfig; sessionId: string; agentName?: string
  /** 卡片堆里那一份:不收成一行(处理完它自己离开卡片堆)。 */
  inDeck?: boolean
  /** 流里、有卡片堆的视图:滚到对话末尾。 */
  onJump?: () => void
  createdAt?: number
}) {
  const { t } = useI18n()
  useHumanAckVersion()
  const ids = changes.map(c => c.id)
  const engine = targetForSession(sessionId)
  const [reopened, setReopened] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const acked = humanAcked(ids)
  useEffect(() => { if (ids.length) window.dispatchEvent(new CustomEvent(HUMAN_CHANGED_EVENT)) }, [ids.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!changes.length) return null
  const fresh = !createdAt || Date.now() - createdAt <= TASK_CARD_TTL_MS
  if (onJump && !acked && fresh) return <button type="button" className="t2-dim t2-tasktrace t2-tasktrace-jump" data-human-trace="pending" onClick={onJump}>
    <BookOpen size={13} /><span>{agentName ? t('human.ask.inDeck', { name: agentName, n: changes.length }) : t('human.ask.inDeckAnon', { n: changes.length })}</span><ArrowDown size={12} />
  </button>
  if (acked && !reopened && !inDeck) return <button type="button" className="human-acked" data-human-updates data-human-acked onClick={() => setReopened(true)}>
    <BookOpen size={15} />{t(humanUndone(ids) ? 'human.ask.undoneAll' : 'human.ask.acked', { n: changes.length })}<ChevronRight size={12} />
  </button>
  const ack = () => { ackHumanChanges(ids); setReopened(false) }
  // 整张撤回 = 不接受这几条请求:新的在前一条条撤(引擎只让撤每份文档最新那一笔);已撤过的跳过;
  // 撞上「后面还有新改动」就停在那条,卡留着(一条条撤 / 去资料页改,或点知道了)
  // ponytail: 同一份文档在这张卡里改了两笔时只撤得动后一笔(撤完最新的是那条撤销记录);要整组撤得给引擎加按链批量撤销
  const undoAll = async () => {
    if (busy) return
    setBusy(true); setError('')
    let left = 0
    for (const change of [...changes].reverse()) {
      const target = targetOf(change, sessionId)
      try {
        const doc = await getHumanDocument(engine, target)
        if (doc.history.some(h => h.undoOf === change.id)) continue
        await undoHumanChange(engine, target, change)
      } catch (e: any) { left++; setError(e?.status === 409 ? t('human.undoConflict') : String(e?.message || e)); break }
    }
    window.dispatchEvent(new CustomEvent(HUMAN_CHANGED_EVENT))
    if (!left) markHumanUndone(ids)
    setBusy(false)
  }
  return <section className="human-update-card" data-human-updates>
    <div className="human-update-head"><BookOpen size={15} /><strong>{agentName ? t('human.ask.title', { name: agentName, n: changes.length }) : t('human.ask.titleAnon', { n: changes.length })}</strong><span className="human-ask-saved">{t('human.ask.saved')}</span></div>
    {changes.map(change => <HumanUpdate key={JSON.stringify([engine.key, engine.base, cfg.token, change.id])} change={change} engine={engine} cfg={cfg} sessionId={sessionId} />)}
    <div className="human-ask-foot">
      <button type="button" className="btn sm" disabled={busy} onClick={ack} data-human-ack>{t('human.ask.ack')}</button>
      {!humanUndone(ids) && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void undoAll()} data-human-undo-all><Undo2 size={12} />{t(changes.length > 1 ? 'human.ask.undoAllN' : 'human.ask.undoAll')}</button>}
    </div>
    {error && <p className="agent-profile-error" role="alert">{error}</p>}
  </section>
}
function HumanUpdate({ change, engine, cfg, sessionId }: { change: HumanChange; engine: EngineTarget; cfg: TanguDesktopConfig; sessionId: string }) {
  const { t } = useI18n()
  const scope = change.scope
  const name = useApp(s => scope.kind === 'agent' ? agentName(s.agentDefs.find(a => a.slug === scope.slug)) || scope.slug : scope.kind === 'project' ? scope.cwd.split(/[\\/]/).filter(Boolean).at(-1) : '')
  const projectPath = useApp(s => [...s.sessions, ...s.archivedSessions].find(x => x.id === sessionId)?.project_path)
  const [doc, setDoc] = useState<HumanDocument | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const target = targetOf(change, sessionId)
  const validScope = (d: HumanDocument) => d.scope.kind === scope.kind && (d.scope.kind === 'agent' && scope.kind === 'agent' ? d.scope.slug === scope.slug
    : d.scope.kind === 'human' && scope.kind === 'human' ? d.scope.file === scope.file : d.scope.kind === 'project' && scope.kind === 'project' && d.scope.cwd === scope.cwd)
  useEffect(() => {
    let alive = true
    const refresh = () => { void getHumanDocument(engine, target).then(d => { if (alive && validScope(d)) setDoc(d) }).catch(() => {}) }
    refresh(); window.addEventListener(HUMAN_CHANGED_EVENT, refresh)
    return () => { alive = false; window.removeEventListener(HUMAN_CHANGED_EVENT, refresh) }
  }, [engine.key, engine.base, cfg.token, change.id, sessionId])
  const undone = !!doc?.history.some(h => h.undoOf === change.id)
  const canUndo = !!doc?.history.some(h => h.id === change.id && h.canUndo)
  // 共识那份不属于哪个 Agent / 项目:去 Agents Space 的「我」资料页(主区),另外两份照旧开右栏详情
  const open = (edit = false) => {
    const human = { at: Date.now(), edit, changeId: change.id }
    if (change.scope.kind === 'human') openHumanProfile(human)
    else showDetails({ ...(change.scope.kind === 'agent' ? { kind: 'agent' as const, slug: change.scope.slug } : { kind: 'project' as const, path: projectPath || change.scope.cwd }), human })
  }
  const undo = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { const r = await undoHumanChange(engine, target, change); setDoc(r.document) }
    catch (e: any) { setError(e?.status === 409 ? t('human.undoConflict') : String(e?.message || e)) }
    finally { setBusy(false) }
  }
  return <article data-human-update={change.id}>
    <div className="human-scope">{name ? `${name} · ` : ''}{t(change.scope.kind === 'agent' ? 'human.agent' : change.scope.kind === 'human' ? 'human.shared' : 'human.project')} · <span className="human-applied">{t(undone ? 'human.undone' : 'human.applied')}</span></div>
    <p className="human-say">{change.summary}</p>
    {change.evidence && <p className="human-why">{t('human.ask.why', { text: change.evidence })}</p>}
    <div className="human-actions"><button type="button" className="profile-text-action" onClick={() => open()}>{t('human.view')}</button><button type="button" className="profile-text-action" onClick={() => open(true)}>{t('human.revise')}</button>
      {!undone && <button type="button" className="profile-text-action" disabled={busy || !canUndo} title={!canUndo && doc ? t('human.undoConflict') : undefined} onClick={() => void undo()}><Undo2 size={12} />{t('human.undo')}</button>}
    </div>
    {error && <p className="agent-profile-error" role="alert">{error}</p>}
  </article>
}
