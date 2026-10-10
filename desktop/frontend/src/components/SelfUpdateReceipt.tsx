import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bookmark, ChevronRight, Sprout, Undo2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { forgetProjectMemory, getAgentMemorySnapshot, getProjectContext, mutateAgentMemoryEntry } from '../services/backendService'
import { harnessChanges, HARNESS_CHANGED_EVENT } from '../services/harnessUpdates'
import { memoryChanges, type MemoryChange } from '../services/selfUpdates'
import { targetForSession } from '../services/engine/targets'
import type { ToolEvent } from '../types'
import { HarnessUpdateRows } from './HarnessUpdateCard'
import './selfUpdates.css'

registerMessages({
  'selfUpdate.remembered': { zh: '记住了 {n} 件事', en: 'Saved to memory: {n}' },
  'selfUpdate.forgot': { zh: '忘掉了 {n} 件事', en: 'Removed from memory: {n}' },
  'selfUpdate.learned': { zh: '学到 {n} 个做法', en: 'New in evolution record: {n}' },
  'selfUpdate.evolved': { zh: '进化记录更新 {n} 处', en: 'Evolution record changes: {n}' },
  'selfUpdate.mem.agent': { zh: '记忆', en: 'Memory' },
  'selfUpdate.mem.project': { zh: '项目记忆 · {name}', en: 'Project memory · {name}' },
  'selfUpdate.mem.updated': { zh: '改写', en: 'Rewritten' },
  'selfUpdate.mem.forgotten': { zh: '忘掉了一条记忆', en: 'Removed one entry' },
  'selfUpdate.mem.undo': { zh: '撤销', en: 'Undo' },
  'selfUpdate.mem.undoHint': { zh: '从记忆里删掉这一条，之后也不会被自动记回来', en: 'Removes this entry from memory and keeps it from being saved again automatically' },
  'selfUpdate.mem.undone': { zh: '已撤销', en: 'Undone' },
  'selfUpdate.mem.gone': { zh: '已不在记忆里', en: 'No longer in memory' },
  'selfUpdate.mem.changed': { zh: '后来又改过', en: 'Changed since' },
  'selfUpdate.mem.conflict': { zh: '这条记忆后来又改过，没有撤销。请到记忆里调整。', en: 'This entry changed later, so it was not removed. Adjust it in memory instead.' },
})

type Entry = { id: string; content: string }
type Stores = { agent?: Entry[]; project?: Entry[] }
/** 一条「记住了」现在还在不在:条目还在且一字未改才给撤销;读不到那份记忆(云端 / 老引擎)时不下结论。 */
function memoryState(change: MemoryChange, stores: Stores): 'current' | 'gone' | 'changed' | 'unknown' {
  const entries = stores[change.scope]
  if (!entries || !change.entryId) return 'unknown'
  const entry = entries.find((e) => e.id === change.entryId)
  return !entry ? 'gone' : entry.content === change.content ? 'current' : 'changed'
}

function MemoryRows({ changes, sessionId, agentSlug }: { changes: MemoryChange[]; sessionId: string; agentSlug: string }) {
  const { t } = useI18n()
  const engine = targetForSession(sessionId)
  const [stores, setStores] = useState<Stores>({})
  const [undone, setUndone] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(''), [errors, setErrors] = useState<Record<string, string>>({})
  const needAgent = changes.some((c) => c.scope === 'agent'), needProject = changes.some((c) => c.scope === 'project')
  const ids = changes.map((c) => c.callId).join(',')
  const readAgent = useCallback(() => getAgentMemorySnapshot(engine, agentSlug), [engine.key, engine.base, agentSlug]) // eslint-disable-line react-hooks/exhaustive-deps
  const readProject = useCallback(() => getProjectContext(engine, sessionId).then((c) => c.memory), [engine.key, engine.base, sessionId]) // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    const [agent, project] = await Promise.all([
      needAgent ? readAgent().then((s) => s.entries, () => undefined) : undefined,
      needProject ? readProject().then((m) => m?.entries, () => undefined) : undefined,
    ])
    return { agent, project } as Stores
  }, [needAgent, needProject, readAgent, readProject])
  useEffect(() => {
    let alive = true
    void reload().then((s) => { if (alive) setStores(s) })
    return () => { alive = false }
  }, [reload, ids])
  // 撤销 = 忘掉那一条(与 Agent 自己 forget 同一条路,带墓碑,整理时不会被记回来)。点的那一刻重读一遍:
  // 条目还在且一字未改才删,版本号用刚读到的(同一轮里记了两条时,回执里第一条的版本号早就过期了)。
  const undo = async (change: MemoryChange) => {
    if (busy || !change.entryId) return
    setBusy(change.callId); setErrors((e) => ({ ...e, [change.callId]: '' }))
    try {
      const fresh: { version: string | null; entries: Entry[] } | undefined = change.scope === 'agent' ? await readAgent() : await readProject()
      const entry = fresh?.entries.find((e) => e.id === change.entryId)
      if (!fresh?.version || !entry || entry.content !== change.content) throw Object.assign(new Error('changed'), { status: 409 })
      if (change.scope === 'agent') await mutateAgentMemoryEntry(engine, agentSlug, { action: 'forget', id: change.entryId, expectedVersion: fresh.version })
      else await forgetProjectMemory(engine, sessionId, change.entryId, fresh.version)
      setUndone((s) => new Set(s).add(change.callId))
    } catch (e: any) { setErrors((x) => ({ ...x, [change.callId]: e?.status === 409 ? t('selfUpdate.mem.conflict') : String(e?.message || e) })) }
    finally { setBusy(''); void reload().then(setStores) }
  }
  return <div data-memory-updates>
    {changes.map((change) => {
      const wasUndone = undone.has(change.callId)
      const state = wasUndone ? 'undone' : change.action === 'forget' ? 'unknown' : memoryState(change, stores)
      const status = state === 'undone' ? t('selfUpdate.mem.undone') : state === 'gone' ? t('selfUpdate.mem.gone') : state === 'changed' ? t('selfUpdate.mem.changed') : change.action === 'update' ? t('selfUpdate.mem.updated') : ''
      return <article className="self-row" key={change.callId} data-memory-update={change.entryId || change.callId} data-memory-state={state}>
        <Bookmark size={15} className="self-row-ic" />
        <div className="self-row-kind">{change.scope === 'project' ? t('selfUpdate.mem.project', { name: change.project || '' }) : t('selfUpdate.mem.agent')}{status && <> · {status}</>}</div>
        <div className="self-row-main"><p>{change.action === 'forget' ? t('selfUpdate.mem.forgotten') : change.content}</p></div>
        {change.action === 'add' && state === 'current' && <div className="self-row-ops">
          <button type="button" className="self-act" disabled={!!busy} title={t('selfUpdate.mem.undoHint')} onClick={() => void undo(change)}><Undo2 size={12} />{t('selfUpdate.mem.undo')}</button>
        </div>}
        {errors[change.callId] && <p className="self-row-note agent-profile-error" role="alert">{errors[change.callId]}</p>}
      </article>
    })}
  </div>
}

/** 一条回复一行:这一轮 Agent 自己记下了什么(记忆)、学到了什么(进化记录)。点开才是明细和撤销,也才去读记忆 / 编辑史。
 *  数据只认落库的工具回执,重开历史会话照样还原。协作说明不进这一行:那是说给用户听的,单独一张请求卡(HumanUpdateCard)。 */
export function SelfUpdateReceipt({ events, sessionId, agentSlug }: { events?: ToolEvent[]; sessionId: string; agentSlug?: string }) {
  const { t } = useI18n()
  const memory = useMemo(() => memoryChanges(events), [events])
  const harness = useMemo(() => harnessChanges(events), [events])
  const [open, setOpen] = useState(false)
  // 群聊发言带发言人的 slug(主持人的 __host__ 不是 Agent);私聊按会话的 Agent。共用记忆由引擎那头折叠。
  const slug = useApp((s) => (agentSlug && agentSlug !== '__host__' ? agentSlug : s.configBySession[sessionId]?.agentSlug) || s.defaultAgentSlug)
  // 回复还在流式时新回执到了:详情页开着的「进化」面板跟着重读
  const revs = harness.map((c) => c.rev).join(',')
  useEffect(() => { if (revs) window.dispatchEvent(new CustomEvent(HARNESS_CHANGED_EVENT)) }, [revs])
  if (!memory.length && !harness.length) return null
  const forgot = memory.filter((c) => c.action === 'forget').length
  const learned = harness.filter((c) => c.action === 'create' && c.kind !== 'equip').length
  const parts = [
    memory.length - forgot ? t('selfUpdate.remembered', { n: memory.length - forgot }) : '',
    forgot ? t('selfUpdate.forgot', { n: forgot }) : '',
    learned ? t('selfUpdate.learned', { n: learned }) : '',
    harness.length - learned ? t('selfUpdate.evolved', { n: harness.length - learned }) : '',
  ].filter(Boolean)
  return <details className="self-receipt" data-self-receipt onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>
      <Sprout size={15} className="self-receipt-ic" />
      <span><span className="self-receipt-first">{parts[0]}</span>{parts.slice(1).map((p) => <span key={p}> · {p}</span>)}</span>
      <ChevronRight size={12} className="self-receipt-chev" />
    </summary>
    {open && <div className="self-rows">
      {!!memory.length && <MemoryRows changes={memory} sessionId={sessionId} agentSlug={slug} />}
      {!!harness.length && <HarnessUpdateRows changes={harness} sessionId={sessionId} />}
    </div>}
  </details>
}
