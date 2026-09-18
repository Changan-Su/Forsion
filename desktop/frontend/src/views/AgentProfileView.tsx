import { agentDescription } from '../components/builtinAgentDescriptions'
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { BookOpen, Bot, Check, ChevronRight, ExternalLink, ImageUp, Loader2, Plug, Search, Settings2, Sparkles, Sprout, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { activeMainPanel, useWorkspace } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine/types'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { deleteAgentAvatar, fetchAgentAvatar, getAgentHarness, listSkills, listTools, saveAgentDef, uploadAgentAvatar } from '../services/backendService'
import { openAgentProfile } from './agentProfileNav'
import { AgentMemoryPanel } from '../components/AgentMemoryPanel'
import { AgentMemoryModal } from '../components/AgentMemoryModal'
import { AgentHarnessPanel } from '../components/AgentHarnessPanel'
import type { AgentConfig, NormalAgentDef, SkillInfo, ToolsResponse } from '../types'
import { THINKING_LEVELS } from '../types'
import { ProfileGroup, ProfileModelField, ProfileTextEditor } from './profileControls'
import { TeamProfile } from './TeamProfile'
import './agentProfileMessages'
import './agentProfile.css'

type Section = 'config' | 'skills' | 'mcp' | 'memory' | 'evolution'
// 进化 = HARNESS 工作笔记,与人格(配置)、记忆并列的第三层 —— Agent 唯一能自己改的那层,一级标签直达。
const SECTIONS: Array<{ id: Section; icon: typeof Bot }> = [
  { id: 'config', icon: Settings2 }, { id: 'skills', icon: Sparkles }, { id: 'mcp', icon: Plug }, { id: 'memory', icon: BookOpen }, { id: 'evolution', icon: Sprout },
]
const EMPTY_CONFIG: AgentConfig = {}

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

export function TanguDetailsView() {
  const { t } = useI18n()
  const sessionId = useMainSessionId()
  const s = useApp(useShallow((a) => ({
    session: a.sessions.find((x) => x.id === sessionId), config: sessionId ? a.configBySession[sessionId] : a.newChatCfg,
    agents: a.agentDefs, defaultSlug: a.defaultAgentSlug, engines: a.engines,
  })))
  const config = s.config || s.session?.agent_config || EMPTY_CONFIG
  const slug = config.agentSlug || config.soloAgentSlug || s.defaultSlug
  const agent = s.agents.find((a) => a.slug === slug)
  return <div className="agent-profile-panel" data-tangu-details>
    <div className="agent-profile-panel-title">{t('agentProfile.title')}</div>
    {config.groupChat || config.teamSlug ? <TeamProfile key={`${sessionId}:${config.teamSlug || ''}`} session={s.session} config={config} renderMember={(member, childId) => <AgentProfile agent={member} compact sessionId={childId} />} /> : config.engineId || config.soloEngineId ? <section className="agent-profile-team"><h3>{s.engines.find((e) => e.id === (config.engineId || config.soloEngineId))?.name || config.engineId || config.soloEngineId}</h3><div className="agent-current-session"><strong>{s.session?.title}</strong><span>{s.session?.project_name || config.cwd}</span></div></section> : agent ? <AgentProfile key={agent.slug} agent={agent} compact sessionId={sessionId} /> : <p className="agent-profile-muted">{t('agentProfile.noAgent')}</p>}
  </div>
}

export function AgentsSpaceView({ leaf, params }: ViewProps) {
  const { t } = useI18n()
  const agents = useApp((s) => s.agentDefs)
  const avatars = useApp((s) => s.agentAvatars)
  const [query, setQuery] = useState('')
  const slug = typeof params.agentSlug === 'string' ? params.agentSlug : agents[0]?.slug
  const agent = agents.find((a) => a.slug === slug) || agents[0]
  const filtered = useMemo(() => agents.filter((a) => `${a.name} ${a.description} ${agentDescription(a, t)} ${a.slug}`.toLowerCase().includes(query.toLowerCase())), [agents, query, t])
  useEffect(() => { useApp.getState().refreshAgents() }, [])
  // 带 section 打开(提醒点「复盘」→ 进化)是一次性的跳转:leaf.setParams 是合并语义,不清掉的话之后换 Agent 也会一直落在「进化」。
  // 用 sectionAt 当令牌:子组件按令牌导航(不靠重挂),父组件随即把两个键清掉;清掉后令牌归 0,不会再触发。
  const jumpAt = params.section === 'evolution' ? Number(params.sectionAt) || 1 : 0
  useEffect(() => { if (jumpAt) leaf.setParams({ section: undefined, sectionAt: undefined }) }, [jumpAt, leaf])
  return <div className="agents-space" data-agents-space>
    <aside className="agents-roster">
      <div className="agents-roster-heading"><span>{t('agentProfile.roster')}</span><span>{agents.length}</span></div>
      <label className="agents-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agentProfile.search')} aria-label={t('agentProfile.search')} /></label>
      <div className="agents-roster-list">{filtered.map((a) => <button key={a.slug} className={`agents-roster-item${agent?.slug === a.slug ? ' selected' : ''}`} onClick={() => leaf.setParams({ agentSlug: a.slug })} aria-pressed={agent?.slug === a.slug}>
        <span className="agent-portrait small">{avatars[a.slug] ? <img src={avatars[a.slug]} alt="" /> : <Bot size={23} />}</span><span><strong>{a.name}</strong><small>{agentDescription(a, t) || a.slug}</small></span>
      </button>)}</div>
      <button className="agent-profile-link" onClick={() => useApp.getState().openSettings('agents')}>{t('agentProfile.create')}<ChevronRight size={14} /></button>
    </aside>
    <main className="agents-character">{agent ? <AgentProfile key={agent.slug} agent={agent} jumpTo={jumpAt ? 'evolution' : undefined} jumpAt={jumpAt} /> : <p className="agent-profile-muted">{t('agentProfile.noAgent')}</p>}</main>
  </div>
}

/** jumpTo / jumpAt:一次性跳到某个标签(令牌变了才跳;首挂时也按它初始化,免得先闪一下「配置」)。 */
function AgentProfile({ agent, compact = false, sessionId, jumpTo, jumpAt = 0 }: { agent: NormalAgentDef; compact?: boolean; sessionId?: string | null; jumpTo?: Section; jumpAt?: number }) {
  const { t } = useI18n()
  const id = useId()
  const s = useApp(useShallow((a) => ({ cfg: a.cfg, avatar: a.agentAvatars[agent.slug], models: a.modelsResp?.models,
    config: sessionId ? a.configBySession[sessionId] : undefined, session: a.sessions.find((x) => x.id === sessionId),
    running: sessionId ? !!a.runningBySession[sessionId] : Object.entries(a.runningBySession).some(([id, run]) => !!run && a.configBySession[id]?.agentSlug === agent.slug),
    connected: a.connState === 'ok', usage: sessionId ? a.usageBySession[sessionId] : undefined,
  })))
  const [section, setSection] = useState<Section>(jumpTo ?? 'config')
  const [visitedMemory, setVisitedMemory] = useState(false)
  const [draft, setDraft] = useState(agent)
  const [dirty, setDirty] = useState(false)
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
  useEffect(() => { if (!dirty) setDraft(agent) }, [agent, dirty])
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
  // 「进化」标签开着时不读:面板自己在读同一个接口并经 onCandidates 报数,两边都读 = 每个沿两次同样的请求。
  useEffect(() => {
    if (section === 'evolution') return
    let active = true
    getAgentHarness(s.cfg, agent.slug).then((r) => { if (active) setCandidates(r.candidates?.length ?? 0) }).catch(() => { if (active) setCandidates(0) })
    return () => { active = false }
  }, [s.cfg, agent.slug, s.running, retry, section])
  const navigate = (next: Section) => {
    setSection(next); setQuery(''); setEnabledOnly(false)
    if (next === 'memory') setVisitedMemory(true)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  useEffect(() => { if (jumpTo && jumpAt) navigate(jumpTo) }, [jumpAt]) // eslint-disable-line react-hooks/exhaustive-deps
  const patch = (p: Partial<NormalAgentDef>) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); setNotice(''); setError('') }
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
  const save = async () => {
    if (busy || !draft.name.trim()) return
    setBusy(true); setError('')
    try {
      const updated = await saveAgentDef(s.cfg, { ...draft, name: draft.name.trim(), enabledSkillIds: draft.enabledSkillIds ?? null, enabledMcpServers: draft.enabledMcpServers ?? null, toolsMode: draft.toolsMode ?? null, toolsList: draft.toolsMode ? draft.toolsList || [] : null }, agent.slug)
      useApp.setState((a) => ({ agentDefs: a.agentDefs.map((v) => v.slug === agent.slug ? updated : v) }))
      if (alive.current) { setDraft(updated); setDirty(false); setNotice(t('agentProfile.saved')) }
    } catch (e: any) { if (alive.current) setError(String(e.message || e)) } finally { if (alive.current) setBusy(false) }
  }
  const equipment = (kind: 'skills' | 'mcp') => {
    const key = kind === 'skills' ? 'enabledSkillIds' : 'enabledMcpServers'
    const selected = draft[key]
    const entries = kind === 'skills' ? skills.map((x) => ({ id: x.id, name: x.name, description: x.description, origin: x.origin ?? null }))
      : mcp.map((x) => ({ id: x.server, name: x.server, description: `${x.status} · ${x.tools.length}`, origin: null }))
    for (const item of selected || []) if (!entries.some((e) => e.id === item)) entries.push({ id: item, name: item, description: t('agentProfile.unavailable'), origin: null })
    const filtered = entries.filter((e) => (!enabledOnly || !selected || selected.includes(e.id)) && `${e.name} ${e.description}`.toLowerCase().includes(query.trim().toLowerCase()))
    return <>
      <div className="profile-loadout-mode">
        <label className="agent-field">{t('agentProfile.loadoutMode')}<select aria-label={t(`agentProfile.${kind}`)} disabled={loading || !!loadError} value={selected ? 'selected' : 'all'} onChange={(e) => patch({ [key]: e.target.value === 'all' ? undefined : entries.map((x) => x.id) })}><option value="all">{t('agentProfile.all')}</option><option value="selected">{t('agentProfile.selected')}</option></select></label>
        <small>{t(selected ? 'agentProfile.manualSelectionHint' : 'agentProfile.allSelectionHint')}</small>
      </div>
      <div className="profile-list-toolbar">
        <label className="profile-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agentProfile.searchEquipment')} aria-label={t('agentProfile.searchEquipment')} /></label>
        <div className="profile-list-summary"><span>{t('agentProfile.selectedCount', { count: selected?.length ?? entries.length, total: entries.length })}</span><button className="profile-text-action" aria-pressed={enabledOnly} onClick={() => setEnabledOnly(!enabledOnly)}>{t('agentProfile.enabledOnly')}</button></div>
        <div className="profile-bulk-actions"><button className="profile-text-action" disabled={loading || !!loadError} onClick={() => patch({ [key]: entries.map((x) => x.id) })}>{t('agentProfile.selectAll')}</button><button className="profile-text-action" disabled={loading || !!loadError} onClick={() => patch({ [key]: [] })}>{t('agentProfile.clearAll')}</button></div>
      </div>
      {loading && <p className="agent-profile-muted" role="status"><Loader2 size={14} className="spin" /> {t('agentProfile.loading')}</p>}
      {loadError && <div className="agent-profile-error" role="alert">{loadError}<button onClick={() => setRetry((v) => v + 1)}>{t('agentProfile.retry')}</button></div>}
      <div className="agent-equipment-list">{filtered.map((entry) => <label key={entry.id} className={`agent-equipment-item${!selected || selected.includes(entry.id) ? ' enabled' : ''}`}><input type="checkbox" checked={!selected || selected.includes(entry.id)} onChange={(ev) => { const ids = selected || entries.map((x) => x.id); patch({ [key]: ev.target.checked ? [...new Set([...ids, entry.id])] : ids.filter((x) => x !== entry.id) }) }} /><span><strong>{entry.origin === 'agent' && <span className="harness-kind recipe">{t('settings.agents.selfAuthored')}</span>}{entry.name}</strong><small>{entry.description}</small></span></label>)}</div>
      {!loading && !loadError && !filtered.length && <p className="profile-empty">{t(entries.length ? 'agentProfile.noResults' : 'agentProfile.none')}</p>}
      <button className="agent-profile-link" onClick={() => useApp.getState().openSettings(kind === 'skills' ? 'skills' : 'mcp')}>{t(kind === 'skills' ? 'agentProfile.manageSkills' : 'agentProfile.manageMcp')}<ExternalLink size={13} /></button>
    </>
  }
  const runSettings = <>
    <ProfileModelField models={s.models || []} value={draft.model || ''} label={t('agentProfile.model')} onChange={(model) => patch({ model })} />
    <label className="agent-field">{t('agentProfile.thinking')}<select aria-label={t('agentProfile.thinking')} value={draft.thinkingLevel} onChange={(e) => patch({ thinkingLevel: e.target.value as NormalAgentDef['thinkingLevel'] })}><option value="">{t('agentProfile.default')}</option>{THINKING_LEVELS.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
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
      {draft.toolsMode && <div className="agent-equipment-list">{builtins.map((tool) => <label className="agent-equipment-item" key={tool.name}><input type="checkbox" checked={(draft.toolsList || []).includes(tool.name)} onChange={(e) => patch({ toolsList: e.target.checked ? [...(draft.toolsList || []), tool.name] : (draft.toolsList || []).filter((n) => n !== tool.name) })} /><span><strong>{tool.name}</strong><small>{tool.description}</small></span></label>)}</div>}
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
          {s.avatar ? <img src={s.avatar} alt="" /> : <Bot size={compact ? 30 : 56} strokeWidth={1.5} />}
          <span className="agent-portrait-badge" aria-hidden="true">{avatarBusy ? <Loader2 size={12} className="spin" /> : <ImageUp size={12} />}</span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label={t('agentProfile.avatarChange')} disabled={avatarBusy} onChange={(e) => void pickAvatar(e)} />
        </label>
        {s.avatar && <button type="button" className="agent-portrait-remove" title={t('agentProfile.avatarRemove')} aria-label={t('agentProfile.avatarRemove')} disabled={avatarBusy} onClick={() => void removeAvatar()}><X size={11} /></button>}
      </div>
      <div className="agent-character-identity"><span className="agent-character-id">{agent.slug}</span>
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
      const badge = tab === 'evolution' && candidates > 0 ? t('settings.agents.harnessCandidates', { count: candidates }) : ''
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
      {section === 'skills' && equipment('skills')}
      {section === 'mcp' && equipment('mcp')}
      {/* /refine 只有 host 且非 plan 模式的会话引擎才注入指令(agentLoop 注入门);其余会话不给按钮,发出去只是一条裸 /refine */}
      {section === 'evolution' && <AgentHarnessPanel cfg={s.cfg} slug={agent.slug} running={s.running} onCandidates={setCandidates} onRefine={sessionId && s.config?.execMode === 'host' && !s.config?.planMode ? () => useApp.getState().send('/refine', [], undefined, undefined, undefined, sessionId) : undefined} />}
      </div>
      {/* Memory owns independent drafts. Keep it mounted when switching the parent tabs. */}
      {visitedMemory && <div hidden={section !== 'memory'}>
        <details className="profile-disclosure"><summary>{t('agentProfile.memoryScope')}</summary><label className="agent-equipment-item"><input type="checkbox" checked={!!draft.shareDefaultMemory} onChange={(e) => patch({ shareDefaultMemory: e.target.checked })} />{t('agentProfile.sharedMemory')}</label><p className="agent-profile-muted">{t('agentProfile.memoryScopeHint')}</p></details>
        <AgentMemoryPanel cfg={s.cfg} slug={agent.slug} shareDefaultMemory={agent.shareDefaultMemory} organized />
        <button className="agent-profile-link" onClick={() => setLibrary(true)}>{t('agentProfile.library')}<ExternalLink size={13} /></button>
      </div>}
      </fieldset>
    </div>
    <footer className={`agent-profile-save${dirty ? ' is-dirty' : ''}`}>
      {error && <p className="agent-profile-error" role="alert">{error}</p>}
      {dirty && !draft.name.trim() && <p className="agent-profile-error" role="alert">{t('agentProfile.nameRequired')}</p>}
      {dirty ? <><small>{t('agentProfile.unsaved')} · {t('agentProfile.agentDefaults')}</small><div><button className="btn" disabled={busy} onClick={() => { setDraft(agent); setDirty(false); setError('') }}>{t('agentProfile.cancel')}</button><button className="btn primary" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}{t(busy ? 'agentProfile.saving' : 'agentProfile.save')}</button></div></> : section === 'memory' ? <small>{t('agentProfile.memorySaveHint')}</small> : section === 'evolution' ? <small>{t('settings.agents.harnessHint')}</small> : notice ? <p className="profile-save-notice" role="status"><Check size={14} />{notice}</p> : <small>{t('agentProfile.scopeHint')}</small>}
    </footer>
    {library && <AgentMemoryModal cfg={s.cfg} slug={agent.slug} name={agent.name} shareDefaultMemory={agent.shareDefaultMemory} onClose={() => setLibrary(false)} />}
  </div>
}
