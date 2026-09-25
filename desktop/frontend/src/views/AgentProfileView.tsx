import { agentDescription, isStockAgent } from '../components/builtinAgentDescriptions'
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { BookOpen, Bot, CalendarClock, Check, ChevronRight, ExternalLink, ArrowUp, ArrowDown, ImageUp, Loader2, MoreHorizontal, Plus, Plug, Search, Settings2, Sparkles, Sprout, Star, Trash2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { activeMainPanel, useWorkspace } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine/types'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { deleteAgentAvatar, deleteAgentDef, fetchAgentAvatar, getAgentHarness, listAgents, listSkills, listTools, putAgentsMeta, renameAgentDef, saveAgentDef, uploadAgentAvatar } from '../services/backendService'
import { openAgentProfile } from './agentProfileNav'
import { AgentMemoryPanel } from '../components/AgentMemoryPanel'
import { AgentMemoryModal } from '../components/AgentMemoryModal'
import { AgentHarnessPanel } from '../components/AgentHarnessPanel'
import { AgentSchedulePanel } from '../components/AgentSchedulePanel'
import type { AgentConfig, NormalAgentDef, SkillInfo, ToolsResponse } from '../types'
import { THINKING_LEVELS } from '../types'
import { ProfileGroup, ProfileModelField, ProfileTextEditor } from './profileControls'
import { TeamProfile } from './TeamProfile'
import { ProjectProfile, useProjectWorkspace } from './ProjectProfile'
import { AgentSkillsPanel, moveAgentSkillsDraft } from './AgentSkillsPanel'
import { CapabilityMenu } from '../components/CapabilityMenu'
import './agentProfileMessages'
import './agentProfile.css'
import { AgentAvatar } from '../components/AgentAvatar'
import { thinkingLabel } from '../components/thinkingLabel'

type Section = 'config' | 'skills' | 'mcp' | 'growth' | 'schedule'
// 成长 = Agent 随时间积累的两层:记忆(它知道什么)+ 进化(HARNESS 工作笔记:它怎么做事)。09-19 从两个一级标签并成一个,
// 腾出的位置给「日程」(它接下来要做什么)。五个标签 = 窄栏里一行放得下的上限。
type Growth = 'memory' | 'evolution'
const SECTIONS: Array<{ id: Section; icon: typeof Bot }> = [
  { id: 'config', icon: Settings2 }, { id: 'skills', icon: Sparkles }, { id: 'mcp', icon: Plug }, { id: 'growth', icon: Sprout }, { id: 'schedule', icon: CalendarClock },
]
const EMPTY_CONFIG: AgentConfig = {}
type StoredProfileDraft = { draft: NormalAgentDef; base: NormalAgentDef; fields: Array<keyof NormalAgentDef> }
const profileDrafts = new Map<string, StoredProfileDraft>()

export { openAgentProfile }

/** Follow the focused MAIN chat. A child conversation or a right-panel tab must not replace the subject. */
export function useMainSessionId(): string | null {
  const active = useApp((s) => s.activeId)
  const params = useWorkspace(useShallow((s) => {
    const panels = s.api?.panels || []
    const main = s.api ? activeMainPanel(s.api) : panels.find((p) => p.id === s.focusedChatLeafId && p.params?.__loc === 'main')
    return { follow: main?.params?.followActive, id: main?.params?.sessionId }
  }))
  return params.follow === false && typeof params.id === 'string' ? params.id : active
}

export function TanguDetailsView({ extendView }: Pick<ViewProps, 'extendView'>) {
  const { t } = useI18n()
  const sessionId = useMainSessionId()
  const s = useApp(useShallow((a) => ({
    session: a.sessions.find((x) => x.id === sessionId), config: sessionId ? a.configBySession[sessionId] : a.newChatCfg,
    agents: a.agentDefs, defaultSlug: a.defaultAgentSlug, engines: a.engines,
  })))
  const config = s.config || s.session?.agent_config || EMPTY_CONFIG
  const slug = config.agentSlug || config.soloAgentSlug || s.defaultSlug
  const agent = s.agents.find((a) => a.slug === slug)
  // 项目会话(用户自己添加的本地目录,侧栏分组口径)→ PROJECT 详情;它的 Agent / 配队从「Agents」页点进去看。
  // 团队实体 / 私聊 / 外部引擎会话都是 projectless,不受影响。按 project_path 取 key:同一项目内切会话,标签与草稿都留着。
  const project = useProjectWorkspace(s.session)
  const renderMember = (member: NormalAgentDef, childId?: string | null) => <AgentProfile agent={member} compact sessionId={childId} extendView={extendView} />
  return <div className="agent-profile-panel" data-tangu-details>
    <div className="agent-profile-panel-title">{t('agentProfile.title')}</div>
    {project && s.session ? <ProjectProfile key={project.path} session={s.session} config={config} workspace={project} renderAgent={renderMember}
        renderTeam={(teamSession, teamConfig) => <TeamProfile key={`${teamSession.id}:${teamConfig.teamSlug || ''}`} session={teamSession} config={teamConfig} renderMember={renderMember} />} />
      : config.groupChat || config.teamSlug ? <TeamProfile key={`${sessionId}:${config.teamSlug || ''}`} session={s.session} config={config} renderMember={renderMember} /> : config.engineId || config.soloEngineId ? <section className="agent-profile-team"><h3>{s.engines.find((e) => e.id === (config.engineId || config.soloEngineId))?.name || config.engineId || config.soloEngineId}</h3><div className="agent-current-session"><strong>{s.session?.title}</strong><span>{s.session?.project_name || config.cwd}</span></div></section> : agent ? <AgentProfile key={agent.slug} agent={agent} compact sessionId={sessionId} extendView={extendView} /> : <p className="agent-profile-muted">{t('agentProfile.noAgent')}</p>}
  </div>
}

export function AgentsSpaceView({ leaf, params, extendView }: ViewProps) {
  const { t } = useI18n()
  const agents = useApp((s) => s.agentDefs)
  const cfg = useApp((s) => s.cfg)
  const creating = params.creating === true
  const setCreating = (value: boolean) => leaf.setParams({ creating: value })
  const [newName, setNewName] = useState('')
  const [newPurpose, setNewPurpose] = useState('')
  const [newInstructions, setNewInstructions] = useState('')
  const [rosterBusy, setRosterBusy] = useState(false)
  const [rosterError, setRosterError] = useState('')
  const slug = typeof params.agentSlug === 'string' ? params.agentSlug : agents[0]?.slug
  const agent = agents.find((a) => a.slug === slug) || agents[0]
  useEffect(() => {
    useApp.getState().refreshAgents()
    const ws = useWorkspace.getState()
    if (!ws.api?.panels.some((panel) => panel.params?.__type === 'agents-roster') && !ws.stash.left.some((panel) => panel.type === 'agents-roster')) {
      ws.openView('agents-roster', {}, 'left')
    }
  }, [])
  // 带 section 打开(提醒点「复盘」→ 进化)是一次性的跳转:leaf.setParams 是合并语义,不清掉的话之后换 Agent 也会一直落在「进化」。
  // 用 sectionAt 当令牌:子组件按令牌导航(不靠重挂),父组件随即把两个键清掉;清掉后令牌归 0,不会再触发。
  const jumpAt = params.section === 'evolution' ? Number(params.sectionAt) || 1 : 0
  useEffect(() => { if (jumpAt) leaf.setParams({ section: undefined, sectionAt: undefined }) }, [jumpAt, leaf])
  const emitAgentsChange = () => { window.dispatchEvent(new Event('forsion:agents-changed')); window.tangu?.requestMainAction?.('agents-changed') }
  const createAgent = async () => {
    const name = newName.trim()
    const instructions = newInstructions.trim()
    if (!name || !instructions || rosterBusy) return
    setRosterBusy(true); setRosterError('')
    try {
      const created = await saveAgentDef(cfg, { name, description: newPurpose.trim(), systemPrompt: instructions })
      useApp.setState((s) => ({ agentDefs: [...s.agentDefs, created] }))
      useApp.getState().refreshAgents()
      emitAgentsChange()
      setCreating(false); setNewName(''); setNewPurpose(''); setNewInstructions('')
      leaf.setParams({ agentSlug: created.slug })
    } catch (error: any) { setRosterError(String(error?.message || error)) } finally { setRosterBusy(false) }
  }
  return <div className="agents-space" data-agents-space>
    <main className="agents-character">{creating ? <form className="agent-create-form" onSubmit={(e) => { e.preventDefault(); void createAgent() }}>
      <header><Bot size={25} /><div><h2>{t('agentProfile.create')}</h2><p>{t('agentProfile.createHint')}</p></div></header>
      <label className="agent-field">{t('agentProfile.name')}<input autoFocus maxLength={120} required value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
      <label className="agent-field">{t('agentProfile.description')}<input maxLength={300} value={newPurpose} onChange={(e) => setNewPurpose(e.target.value)} placeholder={t('agentProfile.descriptionPlaceholder')} /></label>
      <label className="agent-field">{t('agentProfile.prompt')}<textarea rows={6} required value={newInstructions} onChange={(e) => setNewInstructions(e.target.value)} placeholder={t('agentProfile.createInstructionsPlaceholder')} /></label>
      {rosterError && <p className="agent-profile-error" role="alert">{rosterError}</p>}
      <div><button type="button" className="btn" disabled={rosterBusy} onClick={() => setCreating(false)}>{t('agentProfile.cancel')}</button><button type="submit" className="btn primary" disabled={rosterBusy || !newName.trim() || !newInstructions.trim()}>{rosterBusy && <Loader2 size={13} className="spin" />}{t('agentProfile.create')}</button></div>
    </form> : agent ? <AgentProfile key={agent.slug} agent={agent} evolutionJumpAt={jumpAt} extendView={extendView} /> : <p className="agent-profile-muted">{t('agentProfile.noAgent')}</p>}</main>
  </div>
}

export function AgentsRosterView() {
  const { t } = useI18n()
  const agents = useApp((s) => s.agentDefs)
  const avatars = useApp((s) => s.agentAvatars)
  const cfg = useApp((s) => s.cfg)
  const defaultSlug = useApp((s) => s.defaultAgentSlug)
  const selected = useWorkspace(useShallow((s) => {
    const profile = s.api?.panels.find((panel) => panel.params?.__type === 'agent-profile')
    return { slug: profile?.params?.agentSlug, creating: profile?.params?.creating === true }
  }))
  const [query, setQuery] = useState('')
  const [rosterBusy, setRosterBusy] = useState(false)
  const [rosterError, setRosterError] = useState('')
  const [dragSlug, setDragSlug] = useState<string | null>(null)
  const agent = agents.find((a) => a.slug === selected.slug) || agents[0]
  const creating = selected.creating
  const setCreating = () => useWorkspace.getState().openView('agent-profile', { reuseKey: 'primary', creating: true }, 'main')
  const selectAgent = (slug: string) => { setRosterError(''); openAgentProfile(slug) }
  const emitAgentsChange = () => { window.dispatchEvent(new Event('forsion:agents-changed')); window.tangu?.requestMainAction?.('agents-changed') }
  const filtered = useMemo(() => agents.filter((a) => `${a.name} ${agentDescription(a, t)} ${a.slug}`.toLowerCase().includes(query.toLowerCase())), [agents, query, t])
  const rosterNames = useMemo(() => agents.map((a) => a.name || a.slug), [agents])
  const setDefault = async (next: string) => {
    setRosterBusy(true); setRosterError('')
    try {
      const meta = await putAgentsMeta(cfg, { defaultSlug: next })
      useApp.setState({ defaultAgentSlug: meta.defaultSlug })
      emitAgentsChange()
    } catch (error: any) { setRosterError(String(error?.message || error)) } finally { setRosterBusy(false) }
  }
  const reorder = async (from: string, to: string, after = false) => {
    if (from === to || rosterBusy) return
    const order = agents.map((a) => a.slug).filter((s) => s !== from)
    const index = order.indexOf(to)
    if (index < 0) return
    order.splice(index + (after ? 1 : 0), 0, from)
    setRosterBusy(true); setRosterError('')
    try {
      await putAgentsMeta(cfg, { order })
      useApp.setState((s) => ({ agentDefs: order.map((id) => s.agentDefs.find((a) => a.slug === id)).filter((a): a is NormalAgentDef => !!a) }))
      emitAgentsChange()
    } catch (error: any) { setRosterError(String(error?.message || error)) } finally { setRosterBusy(false); setDragSlug(null) }
  }
  const removeAgent = async (target: NormalAgentDef) => {
    if (!window.confirm(t('agentProfile.deleteConfirm', { name: target.name }))) return
    setRosterBusy(true); setRosterError('')
    try {
      const result = await deleteAgentDef(cfg, target.slug)
      if (!result.ok) throw new Error(t('agentProfile.deleteFailed'))
      const remaining = agents.filter((a) => a.slug !== target.slug)
      useApp.setState({ agentDefs: remaining, defaultAgentSlug: defaultSlug === target.slug ? (remaining[0]?.slug || 'xyra') : defaultSlug })
      useApp.getState().refreshAgents()
      emitAgentsChange()
      if (agent?.slug === target.slug) selectAgent(remaining[0]?.slug || '')
    } catch (error: any) { setRosterError(String(error?.message || error)) } finally { setRosterBusy(false) }
  }
  return <aside className="agents-roster">
      {/* 创建入口只留底部那一个(评审 U-25:标题行的 ＋ 与底部链接重复)。 */}
      <div className="agents-roster-heading"><span>{t('agentProfile.roster')} <small>{agents.length}</small></span></div>
      <label className="agents-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agentProfile.search')} aria-label={t('agentProfile.search')} /></label>
      <div className="agents-roster-list">{filtered.map((a) => <div key={a.slug} className={`agents-roster-row${dragSlug === a.slug ? ' dragging' : ''}`} draggable={!rosterBusy && !query}
        onDragStart={(e) => { setDragSlug(a.slug); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.slug) }} onDragEnd={() => setDragSlug(null)}
        onDragOver={(e) => { if (dragSlug && dragSlug !== a.slug) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); if (dragSlug) void reorder(dragSlug, a.slug) }}>
        <button type="button" className={`agents-roster-item${!creating && agent?.slug === a.slug ? ' selected' : ''}`} onClick={() => selectAgent(a.slug)} aria-pressed={!creating && agent?.slug === a.slug}>
          <span className="agent-portrait small"><AgentAvatar name={a.name || a.slug} url={avatars[a.slug]} siblings={rosterNames} fill /></span><span><strong>{a.name}{a.slug === defaultSlug && <Star size={12} aria-label={t('agentProfile.isDefault')} fill="currentColor" />}</strong><small>{agentDescription(a, t) || a.slug}</small></span>
        </button>
        <CapabilityMenu label={t('agentProfile.actionsFor', { name: a.name })} className="agents-roster-more" items={[
          { id: 'up', label: t('agentProfile.moveUp'), icon: <ArrowUp size={14} />, disabled: rosterBusy || agents[0]?.slug === a.slug, onSelect: () => void reorder(a.slug, agents[agents.indexOf(a) - 1]?.slug || a.slug) },
          { id: 'down', label: t('agentProfile.moveDown'), icon: <ArrowDown size={14} />, disabled: rosterBusy || agents.at(-1)?.slug === a.slug, onSelect: () => void reorder(a.slug, agents[agents.indexOf(a) + 1]?.slug || a.slug, true) },
          { id: 'default', label: t('agentProfile.makeDefault'), icon: <Star size={14} />, disabled: rosterBusy || a.slug === defaultSlug, onSelect: () => void setDefault(a.slug) },
          { id: 'delete', label: t('agentProfile.delete'), icon: <Trash2 size={14} />, danger: true, disabled: rosterBusy || a.slug === 'xyra' || a.slug === defaultSlug, onSelect: () => void removeAgent(a) },
        ]}><MoreHorizontal size={15} /></CapabilityMenu>
      </div>)}{!filtered.length && <p className="agent-profile-muted">{t('agentProfile.noResults')}</p>}</div>
      {rosterError && <p className="agent-profile-error" role="alert">{rosterError}</p>}
      <button className="agent-profile-link agents-roster-create" onClick={() => { setCreating(); setRosterError('') }}><Plus size={14} />{t('agentProfile.create')}</button>
    </aside>
}

/** 装备 / 工具清单的一行:勾选框 + 名称(可带芯片)+ 一行描述。描述默认截成一行,点一下展开全文 ——
 *  内置技能与工具的描述动辄两三百字,全摊开的话窄栏一屏只看得到三四项。tinted = 勾上的行带底色(装备清单用;工具清单的语义随允许 / 禁止模式而变,不上色)。 */
function EquipmentRow({ name, description, checked, onChange, chip, tinted }: { name: string; description?: string; checked: boolean; onChange: (checked: boolean) => void; chip?: string; tinted?: boolean }) {
  const [open, setOpen] = useState(false)
  return <div className={`agent-equipment-item${tinted && checked ? ' enabled' : ''}`}>
    <label><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><strong>{chip && <span className="harness-kind recipe">{chip}</span>}{name}</strong></label>
    {description && <button type="button" className="equipment-desc" aria-expanded={open} title={open ? undefined : description} onClick={() => setOpen(!open)}>{description}</button>}
  </div>
}

/** evolutionJumpAt:一次性跳到「成长 › 进化」的令牌(提名提醒点开要落在工作笔记上)。令牌变了才跳;首挂时也按它初始化,免得先闪一下「配置」。 */
function AgentProfile({ agent, compact = false, sessionId, evolutionJumpAt = 0, extendView }: { agent: NormalAgentDef; compact?: boolean; sessionId?: string | null; evolutionJumpAt?: number; extendView?: ViewProps['extendView'] }) {
  const { t } = useI18n()
  const id = useId()
  const draftKey = `${compact ? 'details' : 'space'}:${agent.slug}`
  const storedDraft = profileDrafts.get(draftKey)
  const s = useApp(useShallow((a) => ({ cfg: a.cfg, avatar: a.agentAvatars[agent.slug], models: a.modelsResp?.models,
    config: sessionId ? a.configBySession[sessionId] : undefined, session: a.sessions.find((x) => x.id === sessionId),
    running: sessionId ? !!a.runningBySession[sessionId] : Object.entries(a.runningBySession).some(([id, run]) => !!run && a.configBySession[id]?.agentSlug === agent.slug),
    connected: a.connState === 'ok', usage: sessionId ? a.usageBySession[sessionId] : undefined,
  })))
  const [section, setSection] = useState<Section>(evolutionJumpAt ? 'growth' : 'config')
  const [growth, setGrowth] = useState<Growth>(evolutionJumpAt ? 'evolution' : 'memory')
  const [visitedMemory, setVisitedMemory] = useState(false)
  const [draft, setDraft] = useState(storedDraft?.draft || agent)
  const [slugDraft, setSlugDraft] = useState(agent.slug) // 两处挂载点都 key={agent.slug},改名后随重挂归零
  const [dirty, setDirty] = useState(!!storedDraft)
  const dirtyFields = useRef(new Set<keyof NormalAgentDef>(storedDraft?.fields || []))
  const baseDraft = useRef(storedDraft?.base || agent)
  const [busy, setBusy] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mcp, setMcp] = useState<NonNullable<ToolsResponse['mcp']>>([])
  const [library, setLibrary] = useState(false)
  const [builtins, setBuiltins] = useState<ToolsResponse['builtins']>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const [query, setQuery] = useState('')
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [candidates, setCandidates] = useState(0) // 待复盘候选数,只为「进化」标签角标;面板打开后自己再读完整数据
  const scrollRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!dirty) { setDraft(agent); baseDraft.current = agent }
    else setDraft((current) => {
      const changed = Object.fromEntries([...dirtyFields.current].map((key) => [key, current[key]]))
      const next = { ...agent, ...changed } as NormalAgentDef
      profileDrafts.set(draftKey, { draft: next, base: baseDraft.current, fields: [...dirtyFields.current] })
      return next
    })
  }, [agent, dirty, draftKey])
  useEffect(() => {
    let active = true
    setLoading(true); setLoadError('')
    void Promise.allSettled([listSkills(s.cfg, agent.slug), listTools(s.cfg)]).then(([skillResult, toolResult]) => {
      if (!active) return
      if (skillResult.status === 'fulfilled') setSkills(skillResult.value)
      if (toolResult.status === 'fulfilled') { setMcp(toolResult.value.mcp || []); setBuiltins(toolResult.value.builtins || []) }
      const failures = [skillResult, toolResult].filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
      setLoadError(failures.map((r) => String(r.reason?.message || r.reason)).join(' · ')); setLoading(false)
    })
    return () => { active = false }
  }, [s.cfg, agent.slug, retry])
  // run 起止时重读:Historian 在 run 结束后才提名,角标下一次挂载 / 下个 run 跟上;实时那一下由聊天区的通知负责。云端引擎 404 → 0。
  // 工作笔记面板挂着时(成长 › 进化)不读:面板自己在读同一个接口并经 onCandidates 报数,两边都读 = 每个沿两次同样的请求。
  const harnessOpen = section === 'growth' && growth === 'evolution'
  useEffect(() => {
    if (harnessOpen) return
    let active = true
    getAgentHarness(s.cfg, agent.slug).then((r) => { if (active) setCandidates(r.candidates?.length ?? 0) }).catch(() => { if (active) setCandidates(0) })
    return () => { active = false }
  }, [s.cfg, agent.slug, s.running, retry, harnessOpen])
  const navigate = (next: Section) => {
    setSection(next); setQuery(''); setEnabledOnly(false)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  // 记忆面板有自己的草稿:第一次看到它才挂,之后一直留着(切标签 / 切分段都不卸)。
  useEffect(() => { if (section === 'growth' && growth === 'memory') setVisitedMemory(true) }, [section, growth])
  useEffect(() => { if (evolutionJumpAt) { navigate('growth'); setGrowth('evolution') } }, [evolutionJumpAt]) // eslint-disable-line react-hooks/exhaustive-deps
  const patch = (p: Partial<NormalAgentDef>) => {
    Object.keys(p).forEach((key) => dirtyFields.current.add(key as keyof NormalAgentDef))
    setDraft((d) => {
      const next = { ...d, ...p }
      profileDrafts.set(draftKey, { draft: next, base: baseDraft.current, fields: [...dirtyFields.current] })
      return next
    })
    setDirty(true); setNotice(''); setError('')
  }
  const replaceAvatarUrl = (url: string | null, avatar?: string): void => {
    useApp.setState((a) => {
      const previous = a.agentAvatars[agent.slug]
      if (previous && previous !== url) { try { URL.revokeObjectURL(previous) } catch { /* ignore */ } }
      const agentAvatars = { ...a.agentAvatars }
      if (url) agentAvatars[agent.slug] = url
      else delete agentAvatars[agent.slug]
      return {
        agentAvatars,
        agentDefs: a.agentDefs.map((v) => v.slug === agent.slug ? { ...v, avatar } : v),
      }
    })
    setDraft((d) => ({ ...d, avatar }))
  }
  const pickAvatar = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 1_048_576) { setError(t('agentProfile.avatarTooLarge')); return }
    setAvatarBusy(true); setError(''); setNotice('')
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error(t('agentProfile.avatarReadFailed')))
        reader.readAsDataURL(file)
      })
      const uploaded = await uploadAgentAvatar(s.cfg, agent.slug, dataUrl, file.type)
      replaceAvatarUrl(await fetchAgentAvatar(s.cfg, agent.slug), uploaded.avatar)
      setNotice(t('agentProfile.avatarSaved'))
    } catch (e: any) { setError(String(e.message || e)) } finally { setAvatarBusy(false) }
  }
  const removeAvatar = async (): Promise<void> => {
    if (avatarBusy || !s.avatar) return
    setAvatarBusy(true); setError(''); setNotice('')
    try {
      await deleteAgentAvatar(s.cfg, agent.slug)
      replaceAvatarUrl(null, undefined)
      setNotice(t('agentProfile.avatarRemoved'))
    } catch (e: any) { setError(String(e.message || e)) } finally { setAvatarBusy(false) }
  }
  // 文件夹名 = slug = 主键。改名走引擎的 renameAgent(搬目录 + 改会话 / 消息 / 团队 / 自动化 / 通道里的引用);
  // 这里只把本地 store 里已加载的会话配置一并改掉,免得头像 / 昵称在重拉会话前按「已删 agent」渲染。
  // 详情栏(compact)不开放:那里连「在 Agents 中打开」都要一跳,改主键这种事放在全页。
  const canRename = !compact && !dirty && !!agent.libraryDir && !isStockAgent(agent.slug)
  const rename = async () => {
    const old = agent.slug
    const next = slugDraft.trim()
    if (busy || next === old) return
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(next)) { setError(t('agentProfile.renameInvalid')); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const { agent: renamed, warnings } = await renameAgentDef(s.cfg, old, next)
      const fix = <C extends AgentConfig | null | undefined>(c: C): C => {
        if (!c) return c
        const out = { ...c }
        if (out.agentSlug === old) out.agentSlug = next
        if (out.soloAgentSlug === old) out.soloAgentSlug = next
        if (out.groupAgents?.includes(old)) out.groupAgents = out.groupAgents.map((x) => (x === old ? next : x))
        return out
      }
      useApp.setState((a) => {
        const agentAvatars = { ...a.agentAvatars }
        if (agentAvatars[old]) { agentAvatars[next] = agentAvatars[old]; delete agentAvatars[old] }
        return {
          agentAvatars,
          agentDefs: a.agentDefs.map((v) => (v.slug === old ? renamed : v)),
          defaultAgentSlug: a.defaultAgentSlug === old ? next : a.defaultAgentSlug,
          newChatCfg: fix(a.newChatCfg),
          configBySession: Object.fromEntries(Object.entries(a.configBySession).map(([k, v]) => [k, fix(v)])),
          sessions: a.sessions.map((x) => ({ ...x, agent_config: fix(x.agent_config) })),
          archivedSessions: a.archivedSessions.map((x) => ({ ...x, agent_config: fix(x.agent_config) })),
        }
      })
      for (const surface of ['space', 'details'] as const) {
        const oldKey = `${surface}:${old}`, nextKey = `${surface}:${next}`
        const otherDraft = profileDrafts.get(oldKey)
        if (otherDraft) {
          profileDrafts.set(nextKey, { ...otherDraft, draft: { ...otherDraft.draft, slug: next }, base: { ...otherDraft.base, slug: next } })
          profileDrafts.delete(oldKey)
        }
      }
      moveAgentSkillsDraft(old, next)
      window.dispatchEvent(new Event('forsion:agents-changed'))
      window.tangu?.requestMainAction?.('agents-changed')
      useApp.getState().toast(warnings.length ? t('agentProfile.renameWarnings', { slug: next, detail: warnings.join('; ') }) : t('agentProfile.renamed', { slug: next }), warnings.length > 0)
      openAgentProfile(next) // 视图按 agentSlug 参数选人,不换参数会退回名册第一个
    } catch (e: any) {
      if (!alive.current) return
      const known: Record<string, string> = { builtin: 'agentProfile.folderFixed', exists: 'agentProfile.renameExists', cloud_synced: 'agentProfile.renameCloudSynced', plugin_seeded: 'agentProfile.renamePluginSeeded', busy: 'agentProfile.renameBusy', invalid_slug: 'agentProfile.renameInvalid' }
      setError(known[e?.code] ? t(known[e.code]) : String(e?.message || e))
      setSlugDraft(old)
    } finally { if (alive.current) setBusy(false) }
  }
  const save = async () => {
    if (busy || !draft.name.trim()) return
    setBusy(true); setError('')
    try {
      const latest = (await listAgents(s.cfg)).find((item) => item.slug === agent.slug)
      if (!latest) throw new Error(t('agentProfile.saveConflict'))
      const conflicts = [...dirtyFields.current].filter((key) => JSON.stringify(latest[key]) !== JSON.stringify(baseDraft.current[key]) && JSON.stringify(latest[key]) !== JSON.stringify(draft[key]))
      if (conflicts.length) throw new Error(t('agentProfile.saveConflict'))
      const changes: Record<string, unknown> = {}
      for (const key of dirtyFields.current) changes[key] = draft[key]
      if ('name' in changes) changes.name = draft.name.trim()
      if ('enabledSkillIds' in changes && changes.enabledSkillIds === undefined) changes.enabledSkillIds = null
      if ('enabledMcpServers' in changes && changes.enabledMcpServers === undefined) changes.enabledMcpServers = null
      if ('toolsMode' in changes && changes.toolsMode === undefined) changes.toolsMode = null
      if ('toolsList' in changes && !draft.toolsMode) changes.toolsList = null
      const updated = await saveAgentDef(s.cfg, changes, agent.slug)
      useApp.setState((a) => ({ agentDefs: a.agentDefs.map((v) => v.slug === agent.slug ? updated : v) }))
      window.dispatchEvent(new Event('forsion:agents-changed'))
      window.tangu?.requestMainAction?.('agents-changed')
      profileDrafts.delete(draftKey); dirtyFields.current.clear(); baseDraft.current = updated
      if (alive.current) { setDraft(updated); setDirty(false); setNotice(t('agentProfile.saved')) }
    } catch (e: any) { if (alive.current) setError(String(e.message || e)) } finally { if (alive.current) setBusy(false) }
  }
  const equipment = (kind: 'skills' | 'mcp') => {
    const key = kind === 'skills' ? 'enabledSkillIds' : 'enabledMcpServers'
    const selected = draft[key]
    type Entry = { id: string; name: string; description: string; origin: 'agent' | null; builtin: boolean; shared: boolean }
    const entries: Entry[] = kind === 'skills' ? skills.map((x) => ({ id: x.id, name: x.name, description: x.description, origin: x.origin ?? null, builtin: !!x.builtin, shared: !!x.shared }))
      : mcp.map((x) => ({ id: x.server, name: x.server, description: `${x.status} · ${x.tools.length}`, origin: null, builtin: false, shared: false }))
    for (const item of selected || []) if (!entries.some((e) => e.id === item)) entries.push({ id: item, name: item, description: t('agentProfile.unavailable'), origin: null, builtin: false, shared: false })
    const q = query.trim().toLowerCase()
    const on = (e: Entry): boolean => !selected || selected.includes(e.id)
    const filtered = entries.filter((e) => (!enabledOnly || on(e)) && `${e.name} ${e.description}`.toLowerCase().includes(q))
    // 内置技能占了列表的大头(随包十来个,描述又长):收进一个默认合上的组,自建 / 自己装的排在上面。
    // 搜索或「仅看已启用」时自动展开 —— 过滤后的命中不许藏在合着的组里。只有内置技能的 Agent 也保持合上:一行「内置技能 · 已启用 14 / 14」就是整洁态。
    const own = filtered.filter((e) => !e.builtin)
    const stock = filtered.filter((e) => e.builtin)
    const row = (entry: Entry) => <EquipmentRow key={entry.id} name={entry.name} description={entry.description} checked={on(entry)} tinted
      chip={entry.origin === 'agent' ? t('settings.agents.selfAuthored') : entry.shared ? t('settings.agents.sharedSkill') : undefined}
      onChange={(checked) => { const ids = selected || entries.map((x) => x.id); patch({ [key]: checked ? [...new Set([...ids, entry.id])] : ids.filter((x) => x !== entry.id) }) }} />
    return <>
      <div className="profile-list-toolbar">
        <div className="profile-list-controls">
          <label className="profile-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agentProfile.searchEquipment')} aria-label={t('agentProfile.searchEquipment')} /></label>
          <select aria-label={t('agentProfile.loadoutMode')} title={t('agentProfile.loadoutHint')} disabled={loading || !!loadError} value={selected ? 'selected' : 'all'} onChange={(e) => patch({ [key]: e.target.value === 'all' ? undefined : entries.map((x) => x.id) })}><option value="all">{t('agentProfile.all')}</option><option value="selected">{t('agentProfile.selected')}</option></select>
        </div>
        <div className="profile-list-summary">
          <span>{selected ? t('agentProfile.selectedCount', { count: selected.length, total: entries.length }) : t('agentProfile.allSelectionHint')}</span>
          <span className="profile-list-actions">
            {selected && <button className="profile-text-action" aria-pressed={enabledOnly} onClick={() => setEnabledOnly(!enabledOnly)}>{t('agentProfile.enabledOnly')}</button>}
            <button className="profile-text-action" disabled={loading || !!loadError} onClick={() => patch({ [key]: entries.map((x) => x.id) })}>{t('agentProfile.selectAll')}</button>
            <button className="profile-text-action" disabled={loading || !!loadError} onClick={() => patch({ [key]: [] })}>{t('agentProfile.clearAll')}</button>
          </span>
        </div>
      </div>
      {loading && <p className="agent-profile-muted" role="status"><Loader2 size={14} className="spin" /> {t('agentProfile.loading')}</p>}
      {loadError && <div className="agent-profile-error" role="alert">{loadError}<button onClick={() => setRetry((v) => v + 1)}>{t('agentProfile.retry')}</button></div>}
      {own.length > 0 && <div className="agent-equipment-list">{own.map(row)}</div>}
      {stock.length > 0 && <details className="equipment-group" data-equipment-group="builtin" open={!!q || enabledOnly || undefined}>
        <summary><span>{t('agentProfile.builtinSkills')}</span><small>{t('agentProfile.selectedCount', { count: stock.filter(on).length, total: stock.length })}</small></summary>
        <div className="agent-equipment-list">{stock.map(row)}</div>
      </details>}
      {!loading && !loadError && !filtered.length && <p className="profile-empty">{t(entries.length ? 'agentProfile.noResults' : 'agentProfile.none')}</p>}
      <button className="agent-profile-link" onClick={() => useApp.getState().openSettings(kind === 'skills' ? 'skills' : 'mcp')}>{t(kind === 'skills' ? 'agentProfile.manageSkills' : 'agentProfile.manageMcp')}<ExternalLink size={13} /></button>
    </>
  }
  const runSettings = <>
    <ProfileModelField models={s.models || []} value={draft.model || ''} label={t('agentProfile.model')} onChange={(model) => patch({ model })} />
    <label className="agent-field">{t('agentProfile.thinking')}<select aria-label={t('agentProfile.thinking')} value={draft.thinkingLevel} onChange={(e) => patch({ thinkingLevel: e.target.value as NormalAgentDef['thinkingLevel'] })}><option value="">{t('agentProfile.default')}</option>{THINKING_LEVELS.map((v) => <option key={v} value={v}>{thinkingLabel(v, t)}</option>)}</select></label>
    <label className="agent-field">{t('agentProfile.approval')}<select aria-label={t('agentProfile.approval')} value={draft.approvalMode} onChange={(e) => patch({ approvalMode: e.target.value as NormalAgentDef['approvalMode'] })}>{[['', 'default'], ['readonly', 'readonly'], ['auto-edit', 'autoEdit'], ['full-auto', 'fullAuto'], ['custom', 'custom']].map(([v, k]) => <option key={v} value={v}>{t(`agentProfile.${k}`)}</option>)}</select></label>
  </>
  const agentConfiguration = <>
    <ProfileGroup title={t('agentProfile.instructions')} hint={t('agentProfile.instructionsHint')}>
      <ProfileTextEditor label={t('agentProfile.prompt')} value={draft.systemPrompt} onChange={(systemPrompt) => patch({ systemPrompt })} />
      <ProfileTextEditor label={t('agentProfile.soul')} value={draft.soul || ''} onChange={(soul) => patch({ soul })} />
    </ProfileGroup>
    <details className="profile-disclosure"><summary>{t('agentProfile.permissions')}</summary><div className="agent-config-fields">
      <label className="agent-field">{t('agentProfile.tools')}<select aria-label={t('agentProfile.tools')} value={draft.toolsMode || ''} onChange={(e) => patch({ toolsMode: e.target.value as NormalAgentDef['toolsMode'] || undefined, toolsList: [] })}><option value="">{t('agentProfile.all')}</option><option value="deny">{t('agentProfile.denyTools')}</option><option value="allow">{t('agentProfile.allowTools')}</option></select></label>
      {loadError && <p className="agent-profile-error">{loadError}<button onClick={() => setRetry((v) => v + 1)}>{t('agentProfile.retry')}</button></p>}
      {draft.toolsMode && <div className="agent-equipment-list">{builtins.map((tool) => <EquipmentRow key={tool.name} name={tool.name} description={tool.description} checked={(draft.toolsList || []).includes(tool.name)}
        onChange={(checked) => patch({ toolsList: checked ? [...(draft.toolsList || []), tool.name] : (draft.toolsList || []).filter((n) => n !== tool.name) })} />)}</div>}
      <label className="agent-equipment-item"><input type="checkbox" checked={!!draft.activityAccess} onChange={(e) => patch({ activityAccess: e.target.checked })} />{t('agentProfile.activityAccess')}</label>
    </div></details>
    <details className="profile-disclosure"><summary>{t('agentProfile.advanced')}</summary><div className="agent-config-fields">
      <label className="agent-field">{t('agentProfile.maxIterations')}<input type="number" min="1" max="1000" placeholder={t('agentProfile.default')} value={draft.maxIterations ?? ''} onChange={(e) => patch({ maxIterations: e.target.value ? Math.min(1000, Math.max(1, Math.floor(Number(e.target.value)))) : null })} /></label>
      <label className="agent-equipment-item"><input type="checkbox" checked={!!draft.cloudSync} onChange={(e) => patch({ cloudSync: e.target.checked })} />{t('agentProfile.cloudSync')}</label>
    </div></details>
  </>
  return <div className={`agent-profile${compact ? ' compact' : ''}`} data-agent-profile={agent.slug} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); e.stopPropagation(); if (dirty) void save() } }}>
    <header className="agent-character-hero">
      {/* 头部即「基本信息」:头像点开即换(立即保存),名称 / 简介原地编辑、走下方同一保存栏。 */}
      <div className="agent-portrait-slot">
        <label className="agent-portrait agent-portrait-edit" title={t('agentProfile.avatarHint')} aria-busy={avatarBusy || undefined}>
          <AgentAvatar name={draft.name || agent.name || agent.slug} url={s.avatar} fill />
          <span className="agent-portrait-badge" aria-hidden="true">{avatarBusy ? <Loader2 size={12} className="spin" /> : <ImageUp size={12} />}</span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label={t('agentProfile.avatarChange')} disabled={avatarBusy} onChange={(e) => void pickAvatar(e)} />
        </label>
        {s.avatar && <button type="button" className="agent-portrait-remove" title={t('agentProfile.avatarRemove')} aria-label={t('agentProfile.avatarRemove')} disabled={avatarBusy} onClick={() => void removeAvatar()}><X size={11} /></button>}
      </div>
      <div className="agent-character-identity">
        <input className="agent-character-id" aria-label={t('agentProfile.folder')} title={t(canRename ? 'agentProfile.folderHint' : 'agentProfile.folderFixed')} value={slugDraft} maxLength={64} spellCheck={false} readOnly={!canRename} tabIndex={canRename ? undefined : -1} disabled={busy}
          onChange={(e) => setSlugDraft(e.target.value)} onBlur={() => void rename()}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } else if (e.key === 'Escape') { e.preventDefault(); setSlugDraft(agent.slug) } }} />
        <input className="agent-character-name" aria-label={t('agentProfile.name')} placeholder={t('agentProfile.name')} title={draft.name} value={draft.name} maxLength={120} disabled={busy} onChange={(e) => patch({ name: e.target.value })} />
        <textarea className="agent-character-desc" aria-label={t('agentProfile.description')} placeholder={t('agentProfile.descriptionPlaceholder')} rows={2} value={agentDescription({ slug: agent.slug, description: draft.description }, t)} disabled={busy} onChange={(e) => patch({ description: e.target.value })} />
        <span className={`agent-state${s.running ? ' working' : ''}`}><i />{t(!s.connected ? 'agentProfile.offline' : s.running ? 'agentProfile.working' : 'agentProfile.standby')}</span></div>
      {compact && <button className="profile-expand" title={t('agentProfile.full')} aria-label={t('agentProfile.full')} onClick={() => openAgentProfile(agent.slug)}><ExternalLink size={15} /></button>}
    </header>
    <nav className="agent-section-nav" style={{ '--profile-tab-count': SECTIONS.length, '--profile-tab-index': SECTIONS.findIndex((item) => item.id === section) } as CSSProperties} aria-label={t('agentProfile.currentSection')} role="tablist" onKeyDown={(e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const index = SECTIONS.findIndex((x) => x.id === section)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? SECTIONS.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length
      navigate(SECTIONS[next].id); (e.currentTarget.children[next] as HTMLElement).focus()
    }}>{SECTIONS.map(({ id: tab, icon: Icon }) => {
      // 待复盘候选角标:aria-hidden 不改标签的可访问名(台架与读屏都按「进化」找),数字进 title。
      const badge = tab === 'growth' && candidates > 0 ? t('settings.agents.harnessCandidates', { count: candidates }) : ''
      return <button key={tab} id={`${id}-${tab}`} role="tab" title={badge ? `${t(`agentProfile.${tab}`)} · ${badge}` : t(`agentProfile.${tab}`)} aria-selected={section === tab} aria-controls={`${id}-content`} tabIndex={section === tab ? 0 : -1} onClick={() => navigate(tab)} className={section === tab ? 'selected' : ''}><Icon size={15} /><span>{t(`agentProfile.${tab}`)}</span>{badge && <i className="profile-tab-badge" aria-hidden="true">{candidates}</i>}</button>
    })}</nav>
    <div ref={scrollRef} className="agent-profile-content" id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${section}`} tabIndex={0}>
      <fieldset className="profile-edit-fields" disabled={busy}>
      <div key={section} className="profile-section-enter">
      {section === 'config' && <>
        {s.session && <section className="agent-current-session"><small>{t('agentProfile.session')}</small><strong>{s.session.title}</strong>{(s.session.project_name || s.config?.cwd) && <span>{s.session.project_name || s.config?.cwd}</span>}
          <ProfileModelField models={s.models || []} value={s.session.model_id || ''} label={t('agentProfile.sessionModel')} onChange={(model) => useApp.getState().setSessionModel(model, sessionId, false)} />
          <small>{t('agentProfile.sessionModelHint')}</small>
        </section>}
        <ProfileGroup title={t('agentProfile.quickSettings')} hint={t('agentProfile.defaultsHint')}>{runSettings}</ProfileGroup>
        {agentConfiguration}
        {s.usage && <p className="agent-profile-muted">{t('agentProfile.context')} · {s.usage.ctx.toLocaleString()} tokens</p>}
      </>}
      {section === 'skills' && <AgentSkillsPanel cfg={s.cfg} agentSlug={agent.slug} surface={compact ? 'details' : 'space'} selectedIds={draft.enabledSkillIds} onSelectedIds={(enabledSkillIds) => patch({ enabledSkillIds })} extendView={extendView} />}
      {section === 'mcp' && equipment('mcp')}
      {section === 'growth' && <>
        {/* 两层各一张分段卡:标题 + 一句话说清它是什么。待复盘候选的角标跟着「进化」走。 */}
        <div className="profile-segment" role="group" aria-label={t('agentProfile.growth')}>{(['memory', 'evolution'] as const).map((g) =>
          <button key={g} type="button" aria-pressed={growth === g} onClick={() => { setGrowth(g); scrollRef.current?.scrollTo({ top: 0 }) }}>
            <strong>{g === 'memory' ? <BookOpen size={13} /> : <Sprout size={13} />}{t(`agentProfile.${g}`)}{g === 'evolution' && candidates > 0 && <i className="profile-tab-badge" aria-hidden="true">{candidates}</i>}</strong>
            <small>{t(`agentProfile.${g}Caption`)}</small>
          </button>)}</div>
        {/* /refine 只有 host 且非 plan 模式的会话引擎才注入指令(agentLoop 注入门);其余会话不给按钮,发出去只是一条裸 /refine */}
        {growth === 'evolution' && <AgentHarnessPanel cfg={s.cfg} slug={agent.slug} running={s.running} onCandidates={setCandidates} onRefine={sessionId && s.config?.execMode === 'host' && !s.config?.planMode ? () => useApp.getState().send('/refine', [], undefined, undefined, undefined, sessionId) : undefined} />}
      </>}
      {section === 'schedule' && <AgentSchedulePanel cfg={s.cfg} slug={agent.slug} running={s.running} />}
      </div>
      {/* Memory owns independent drafts. Keep it mounted when switching the parent tabs. */}
      {visitedMemory && <div className="profile-growth-memory" hidden={section !== 'growth' || growth !== 'memory'}>
        <AgentMemoryPanel cfg={s.cfg} slug={agent.slug} shareDefaultMemory={agent.shareDefaultMemory} organized />
        <details className="profile-disclosure"><summary>{t('agentProfile.memoryScope')}</summary><label className="agent-equipment-item"><input type="checkbox" checked={!!draft.shareDefaultMemory} onChange={(e) => patch({ shareDefaultMemory: e.target.checked })} />{t('agentProfile.sharedMemory')}</label><p className="agent-profile-muted">{t('agentProfile.memoryScopeHint')}</p></details>
        <button className="agent-profile-link" onClick={() => setLibrary(true)}>{t('agentProfile.library')}<ExternalLink size={13} /></button>
      </div>}
      </fieldset>
    </div>
    <footer className={`agent-profile-save${dirty ? ' is-dirty' : ''}`}>
      {error && <p className="agent-profile-error" role="alert">{error}</p>}
      {dirty && !draft.name.trim() && <p className="agent-profile-error" role="alert">{t('agentProfile.nameRequired')}</p>}
      {dirty ? <><small>{t('agentProfile.unsaved')} · {t('agentProfile.agentDefaults')}</small><div><button className="btn" disabled={busy} onClick={() => { profileDrafts.delete(draftKey); dirtyFields.current.clear(); baseDraft.current = agent; setDraft(agent); setDirty(false); setError('') }}>{t('agentProfile.cancel')}</button><button className="btn primary" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}{t(busy ? 'agentProfile.saving' : 'agentProfile.save')}</button></div></> : section === 'growth' || section === 'schedule' ? null : notice ? <p className="profile-save-notice" role="status"><Check size={14} />{notice}</p> : section === 'config' ? null /* 配置页组内已有同义的 defaultsHint(U-25) */ : <small>{t('agentProfile.scopeHint')}</small>}
    </footer>
    {library && <AgentMemoryModal cfg={s.cfg} slug={agent.slug} name={agent.name} shareDefaultMemory={agent.shareDefaultMemory} onClose={() => setLibrary(false)} />}
  </div>
}
