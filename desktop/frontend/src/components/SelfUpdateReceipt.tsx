import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bookmark, ChevronRight, Sprout, Undo2, UserRound, UsersRound } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { forgetProjectMemory, getAgentMemorySnapshot, getHumanPortrait, getProjectContext, mutateAgentMemoryEntry, mutateHumanPortraitEntry, promoteAgentMemoryEntry } from '../services/backendService'
import { harnessChanges, HARNESS_CHANGED_EVENT } from '../services/harnessUpdates'
import { HUMAN_CHANGED_EVENT } from '../services/humanCollaboration'
import { LOCAL_ONLY_CODE } from '../services/localOnly'
import { memoryChanges, type MemoryChange, type MemoryScope } from '../services/selfUpdates'
import { targetForSession } from '../services/engine/targets'
import { targetCaps } from '../services/engine/targetCaps'
import type { ToolEvent } from '../../../../tangu-agent/src/contracts/clientTypes'
import { HarnessUpdateRows } from './HarnessUpdateCard'
import './selfUpdates.css'

registerMessages({
  'selfUpdate.remembered': { zh: '记住了 {n} 件事', en: 'Saved to memory: {n}' },
  'selfUpdate.forgot': { zh: '忘掉了 {n} 件事', en: 'Removed from memory: {n}' },
  'selfUpdate.learned': { zh: '学到 {n} 个做法', en: 'New in evolution record: {n}' },
  'selfUpdate.evolved': { zh: '进化记录更新 {n} 处', en: 'Evolution record changes: {n}' },
  'selfUpdate.mem.agent': { zh: '记忆', en: 'Memory' },
  'selfUpdate.mem.project': { zh: '项目记忆 · {name}', en: 'Project memory · {name}' },
  'selfUpdate.mem.person': { zh: '画像 · 所有 Agent 都看得到', en: 'Portrait · every agent sees this' },
  'selfUpdate.mem.updated': { zh: '改写', en: 'Rewritten' },
  'selfUpdate.mem.forgotten': { zh: '忘掉了一条记忆', en: 'Removed one entry' },
  'selfUpdate.mem.undo': { zh: '撤销', en: 'Undo' },
  'selfUpdate.mem.undoHint': { zh: '从记忆里删掉这一条，之后也不会被自动记回来', en: 'Removes this entry from memory and keeps it from being saved again automatically' },
  'selfUpdate.mem.undoPersonHint': { zh: '从画像里拿掉这一条，之后也不会被自动记回来', en: 'Removes this entry from the portrait and keeps it from being saved again automatically' },
  'selfUpdate.mem.undoMoveHint': { zh: '删掉这一条，把原来那条放回「{name}」', en: 'Removes this entry and puts the earlier one back in {name}' },
  'selfUpdate.mem.undone': { zh: '已撤销', en: 'Undone' },
  'selfUpdate.mem.gone': { zh: '已不在记忆里', en: 'No longer in memory' },
  'selfUpdate.mem.changed': { zh: '后来又改过', en: 'Changed since' },
  'selfUpdate.mem.conflict': { zh: '这条记忆后来又改过，没有撤销。请到记忆里调整。', en: 'This entry changed later, so it was not removed. Adjust it in memory instead.' },
  'selfUpdate.mem.movedFrom': { zh: '原来那条已从「{name}」拿掉', en: 'The earlier entry was removed from {name}' },
  'selfUpdate.mem.ofAgent': { zh: '{agent} 的记忆', en: "{agent}'s memory" },
  'selfUpdate.mem.ofProject': { zh: '项目记忆', en: 'project memory' },
  'selfUpdate.mem.ofPerson': { zh: '画像', en: 'the portrait' },
  'selfUpdate.mem.promote': { zh: '让所有 Agent 都照做', en: 'Ask every agent to follow this' },
  'selfUpdate.mem.promoteHint': { zh: '挪进「我 › 协作说明 › 你希望 Agent 怎么做」，所有 Agent 都照做', en: 'Moves it to Me › Collaboration › How you want Agents to work, so every agent follows it' },
  'selfUpdate.mem.promoted': { zh: '已交给所有 Agent', en: 'Now asked of every agent' },
  'selfUpdate.mem.promoteConflict': { zh: '这条记忆后来又改过，没有交给所有 Agent。请到记忆里调整。', en: 'This entry changed later, so it was not handed to every agent. Adjust it in memory instead.' },
  'selfUpdate.mem.hostOnly': { zh: '在宿主设备上操作', en: 'Manage this on the host computer' },
})

type Entry = { id: string; content: string }
type Store = { version: string | null; entries: Entry[] }
type Stores = Partial<Record<MemoryScope, Entry[]>>
/** 一条「记住了」现在还在不在:条目还在且一字未改才给撤销;读不到那份记忆(云端 / 老引擎 / 远端读不了画像)时不下结论。 */
function memoryState(change: MemoryChange, stores: Stores): 'current' | 'gone' | 'changed' | 'unknown' {
  const entries = stores[change.scope]
  if (!entries || !change.entryId) return 'unknown'
  const entry = entries.find((e) => e.id === change.entryId)
  return !entry ? 'gone' : entry.content === change.content ? 'current' : 'changed'
}
/** 画像与「交给所有 Agent」只在宿主本机:引擎拒远端(403 HUMAN_REMOTE_DENIED)、云端没有 human/(404 HUMAN_LOCAL_ONLY)、
 *  设备页 / hub 拒 deny-remote 路由(403 LOCAL_ONLY)。没带码的 404 是还没有这条路由的老引擎:不下结论。 */
const hostOnlyError = (e: any): boolean => e?.status === 403 || e?.code === 'HUMAN_REMOTE_DENIED' || e?.code === 'HUMAN_LOCAL_ONLY' || e?.code === LOCAL_ONLY_CODE
const changed = () => Object.assign(new Error('changed'), { status: 409 })

function MemoryRows({ changes, sessionId, agentSlug }: { changes: MemoryChange[]; sessionId: string; agentSlug: string }) {
  const { t } = useI18n()
  const engine = targetForSession(sessionId)
  const agentName = useApp((s) => s.agentDefs.find((a) => a.slug === agentSlug)?.name || agentSlug)
  const [stores, setStores] = useState<Stores>({})
  // 点过的行:撤销了 / 交给所有 Agent 了。交出去之后引擎把源条目拿掉了,重读会显示「已不在」,所以先认这里
  const [done, setDone] = useState<Partial<Record<string, 'undone' | 'promoted'>>>({})
  const [busy, setBusy] = useState(''), [errors, setErrors] = useState<Record<string, string>>({})
  // 远端 / 云端一眼可知;本机直连的外部引擎等读画像那一下才知道
  const [refused, setRefused] = useState(false)
  const hostOnly = refused || targetCaps(engine).remoteApprover || engine.via === 'cloud'
  const involves = (scope: MemoryScope) => changes.some((c) => c.scope === scope || c.moved?.from === scope)
  const needAgent = involves('agent'), needProject = involves('project')
  // 画像那一档,以及「交给所有 Agent」要先知道这台能不能做:有 Agent 档的行也读一下画像
  const needPerson = !hostOnly && (needAgent || involves('person'))
  const ids = changes.map((c) => c.callId).join(',')
  const readAgent = useCallback((): Promise<Store> => getAgentMemorySnapshot(engine, agentSlug), [engine.key, engine.base, agentSlug]) // eslint-disable-line react-hooks/exhaustive-deps
  const readProject = useCallback((): Promise<Store | undefined> => getProjectContext(engine, sessionId).then((c) => c.memory), [engine.key, engine.base, sessionId]) // eslint-disable-line react-hooks/exhaustive-deps
  const readPerson = useCallback((): Promise<Store> => getHumanPortrait(engine), [engine.key, engine.base]) // eslint-disable-line react-hooks/exhaustive-deps
  const read = (scope: MemoryScope) => scope === 'agent' ? readAgent() : scope === 'project' ? readProject() : readPerson()
  const reload = useCallback(async () => {
    const [agent, project, person] = await Promise.all([
      needAgent ? readAgent().then((s) => s.entries, () => undefined) : undefined,
      needProject ? readProject().then((m) => m?.entries, () => undefined) : undefined,
      needPerson ? readPerson().then((p) => p.entries, (e) => { if (hostOnlyError(e)) setRefused(true); return undefined }) : undefined,
    ])
    return { agent, project, person } as Stores
  }, [needAgent, needProject, needPerson, readAgent, readProject, readPerson])
  useEffect(() => {
    let alive = true
    void reload().then((s) => { if (alive) setStores(s) })
    return () => { alive = false }
  }, [reload, ids])
  // 点的那一刻重读一遍:条目还在且一字未改才动,版本号用刚读到的(同一轮里记了两条时,回执里第一条的版本号早就过期了)
  const fresh = async (scope: MemoryScope, id: string, content: string): Promise<string> => {
    const s = await read(scope)
    const entry = s?.entries?.find((e) => e.id === id)
    if (!s?.version || !entry || entry.content !== content) throw changed()
    return s.version
  }
  const forgetIn = (scope: MemoryScope, id: string, expectedVersion: string) => scope === 'agent' ? mutateAgentMemoryEntry(engine, agentSlug, { action: 'forget', id, expectedVersion })
    : scope === 'project' ? forgetProjectMemory(engine, sessionId, id, expectedVersion) : mutateHumanPortraitEntry(engine, { action: 'forget', id, expectedVersion })
  const act = async (change: MemoryChange, kind: 'undone' | 'promoted', run: () => Promise<unknown>, conflictKey: string) => {
    if (busy || !change.entryId) return
    setBusy(change.callId); setErrors((e) => ({ ...e, [change.callId]: '' }))
    try {
      await run()
      setDone((d) => ({ ...d, [change.callId]: kind }))
      if (kind === 'promoted' || change.scope === 'person' || change.moved?.from === 'person') window.dispatchEvent(new CustomEvent(HUMAN_CHANGED_EVENT))
    } catch (e: any) {
      if (hostOnlyError(e)) setRefused(true)
      setErrors((x) => ({ ...x, [change.callId]: hostOnlyError(e) ? t('selfUpdate.mem.hostOnly') : e?.status === 409 ? t(conflictKey) : String(e?.message || e) }))
    } finally { setBusy(''); void reload().then(setStores) }
  }
  // 撤销 = 忘掉那一条(与 Agent 自己 forget 同一条路,带墓碑,整理时不会被记回来)。
  // 跨档改写的撤销还要把原句放回原来那一档:先放回去、再删新句 —— 第二步失败时两边都在,不会两头都丢
  const undo = (change: MemoryChange) => act(change, 'undone', async () => {
    const version = await fresh(change.scope, change.entryId!, change.content)
    const m = change.moved
    if (m) {
      const source = await read(m.from)
      if (!source?.version) throw changed()
      if (m.from === 'agent') await mutateAgentMemoryEntry(engine, agentSlug, { action: 'add', fact: m.content, expectedVersion: source.version })
      else if (m.from === 'person') await mutateHumanPortraitEntry(engine, { action: 'add', fact: m.content, expectedVersion: source.version })
      else throw changed() // 项目记忆没有按原句加回的路由:不给这个按钮,走到这里也不删
    }
    if (!m?.targetExisted) await forgetIn(change.scope, change.entryId!, version)
  }, 'selfUpdate.mem.conflict')
  const promote = (change: MemoryChange) => act(change, 'promoted', async () => {
    const version = await fresh('agent', change.entryId!, change.content)
    await promoteAgentMemoryEntry(engine, agentSlug, { id: change.entryId!, expectedVersion: version })
  }, 'selfUpdate.mem.promoteConflict')
  const scopeName = (scope: MemoryScope) => scope === 'agent' ? t('selfUpdate.mem.ofAgent', { agent: agentName }) : scope === 'project' ? t('selfUpdate.mem.ofProject') : t('selfUpdate.mem.ofPerson')
  return <div data-memory-updates>
    {changes.map((change) => {
      const state = done[change.callId] || (change.action === 'forget' ? 'unknown' : memoryState(change, stores))
      const status = state === 'undone' ? t('selfUpdate.mem.undone') : state === 'promoted' ? t('selfUpdate.mem.promoted') : state === 'gone' ? t('selfUpdate.mem.gone') : state === 'changed' ? t('selfUpdate.mem.changed') : change.action === 'update' ? t('selfUpdate.mem.updated') : ''
      const m = change.moved
      const personOp = change.scope === 'person' || m?.from === 'person'
      const undoable = m ? m.from !== 'project' : change.action === 'add'
      const canUndo = undoable && state === 'current' && !(hostOnly && personOp)
      const canPromote = change.scope === 'agent' && state === 'current' && !hostOnly
      // 碰到画像的撤销、交给所有 Agent,只在宿主本机做得了:远端在那个按钮的位置写明去哪做(手机上没有悬停,不能只靠 title)
      const hostHint = hostOnly && ((personOp && undoable && (state === 'current' || state === 'unknown')) || (change.scope === 'agent' && state === 'current'))
      return <article className="self-row" key={change.callId} data-memory-update={change.entryId || change.callId} data-memory-state={state} data-memory-scope={change.scope}>
        {change.scope === 'person' ? <UserRound size={15} className="self-row-ic" /> : <Bookmark size={15} className="self-row-ic" />}
        <div className="self-row-kind">{change.scope === 'project' ? t('selfUpdate.mem.project', { name: change.project || '' }) : change.scope === 'person' ? t('selfUpdate.mem.person') : t('selfUpdate.mem.agent')}{status && <> · {status}</>}</div>
        <div className="self-row-main"><p>{change.action === 'forget' ? t('selfUpdate.mem.forgotten') : change.content}</p>{m && <p>{t('selfUpdate.mem.movedFrom', { name: scopeName(m.from) })}</p>}</div>
        {(canUndo || canPromote || hostHint) && <div className="self-row-ops">
          {hostHint && <button type="button" className="self-act" disabled data-memory-host-only>{change.scope === 'agent' ? <UsersRound size={12} /> : <UserRound size={12} />}{t('selfUpdate.mem.hostOnly')}</button>}
          {canPromote && <button type="button" className="self-act" disabled={!!busy} title={t('selfUpdate.mem.promoteHint')} onClick={() => void promote(change)}><UsersRound size={12} />{t('selfUpdate.mem.promote')}</button>}
          {canUndo && <button type="button" className="self-act" disabled={!!busy} title={m ? t('selfUpdate.mem.undoMoveHint', { name: scopeName(m.from) }) : change.scope === 'person' ? t('selfUpdate.mem.undoPersonHint') : t('selfUpdate.mem.undoHint')} onClick={() => void undo(change)}><Undo2 size={12} />{t('selfUpdate.mem.undo')}</button>}
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
