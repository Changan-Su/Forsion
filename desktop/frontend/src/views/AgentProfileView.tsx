import { agentDescription } from '../components/builtinAgentDescriptions'
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { BookOpen, Bot, Check, ChevronRight, ExternalLink, Loader2, Plug, Search, Settings2, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { activeMainPanel, setActiveSpace, useWorkspace } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine/types'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { listSkills, listTools, saveAgentDef } from '../services/backendService'
import { AgentMemoryPanel } from '../components/AgentMemoryPanel'
import { AgentMemoryModal } from '../components/AgentMemoryModal'
import type { AgentConfig, NormalAgentDef, SkillInfo, ToolsResponse } from '../types'
import { THINKING_LEVELS } from '../types'
import { ProfileGroup, ProfileModelField, ProfileTextEditor } from './profileControls'
import { TeamProfile } from './TeamProfile'
import './agentProfileMessages'
import './agentProfile.css'

type Section = 'overview' | 'skills' | 'mcp' | 'memory' | 'config'
const SECTIONS: Array<{ id: Section; icon: typeof Bot }> = [
  { id: 'overview', icon: Bot }, { id: 'skills', icon: Sparkles }, { id: 'mcp', icon: Plug }, { id: 'memory', icon: BookOpen }, { id: 'config', icon: Settings2 },
]
const EMPTY_CONFIG: AgentConfig = {}

export function openAgentProfile(slug: string): void {
  setActiveSpace('agents')
  useWorkspace.getState().openView('agent-profile', { agentSlug: slug }, 'main')
}

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
  return <div className="agents-space" data-agents-space>
    <aside className="agents-roster">
      <div className="agents-roster-heading"><span>{t('agentProfile.roster')}</span><span>{agents.length}</span></div>
      <label className="agents-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agentProfile.search')} aria-label={t('agentProfile.search')} /></label>
      <div className="agents-roster-list">{filtered.map((a) => <button key={a.slug} className={`agents-roster-item${agent?.slug === a.slug ? ' selected' : ''}`} onClick={() => leaf.setParams({ agentSlug: a.slug })} aria-pressed={agent?.slug === a.slug}>
        <span className="agent-portrait small">{avatars[a.slug] ? <img src={avatars[a.slug]} alt="" /> : <Bot size={23} />}</span><span><strong>{a.name}</strong><small>{agentDescription(a, t) || a.slug}</small></span>
      </button>)}</div>
      <button className="agent-profile-link" onClick={() => useApp.getState().openSettings('agents')}>{t('agentProfile.create')}<ChevronRight size={14} /></button>
    </aside>
    <main className="agents-character">{agent ? <AgentProfile key={agent.slug} agent={agent} /> : <p className="agent-profile-muted">{t('agentProfile.noAgent')}</p>}</main>
  </div>
}

function AgentProfile({ agent, compact = false, sessionId }: { agent: NormalAgentDef; compact?: boolean; sessionId?: string | null }) {
  const { t } = useI18n()
  const id = useId()
  const s = useApp(useShallow((a) => ({ cfg: a.cfg, avatar: a.agentAvatars[agent.slug], models: a.modelsResp?.models,
    config: sessionId ? a.configBySession[sessionId] : undefined, session: a.sessions.find((x) => x.id === sessionId),
    running: sessionId ? !!a.runningBySession[sessionId] : Object.entries(a.runningBySession).some(([id, run]) => !!run && a.configBySession[id]?.agentSlug === agent.slug),
    connected: a.connState === 'ok', usage: sessionId ? a.usageBySession[sessionId] : undefined,
  })))
  const [section, setSection] = useState<Section>('overview')
  const [visitedMemory, setVisitedMemory] = useState(false)
  const [draft, setDraft] = useState(agent)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
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
  const navigate = (next: Section) => {
    setSection(next); setQuery(''); setEnabledOnly(false)
    if (next === 'memory') setVisitedMemory(true)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const patch = (p: Partial<NormalAgentDef>) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); setNotice(''); setError('') }
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
    const entries = kind === 'skills' ? skills.map((x) => ({ id: x.id, name: x.name, description: x.description }))
      : mcp.map((x) => ({ id: x.server, name: x.server, description: `${x.status} · ${x.tools.length}` }))
    for (const item of selected || []) if (!entries.some((e) => e.id === item)) entries.push({ id: item, name: item, description: t('agentProfile.unavailable') })
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
      <div className="agent-equipment-list">{filtered.map((entry) => <label key={entry.id} className={`agent-equipment-item${!selected || selected.includes(entry.id) ? ' enabled' : ''}`}><input type="checkbox" checked={!selected || selected.includes(entry.id)} onChange={(ev) => { const ids = selected || entries.map((x) => x.id); patch({ [key]: ev.target.checked ? [...new Set([...ids, entry.id])] : ids.filter((x) => x !== entry.id) }) }} /><span><strong>{entry.name}</strong><small>{entry.description}</small></span></label>)}</div>
      {!loading && !loadError && !filtered.length && <p className="profile-empty">{t(entries.length ? 'agentProfile.noResults' : 'agentProfile.none')}</p>}
      <button className="agent-profile-link" onClick={() => useApp.getState().openSettings(kind === 'skills' ? 'skills' : 'mcp')}>{t(kind === 'skills' ? 'agentProfile.manageSkills' : 'agentProfile.manageMcp')}<ExternalLink size={13} /></button>
    </>
  }
  const runSettings = <>
    <ProfileModelField models={s.models || []} value={draft.model || ''} label={t('agentProfile.model')} onChange={(model) => patch({ model })} />
    <label className="agent-field">{t('agentProfile.thinking')}<select aria-label={t('agentProfile.thinking')} value={draft.thinkingLevel} onChange={(e) => patch({ thinkingLevel: e.target.value as NormalAgentDef['thinkingLevel'] })}><option value="">{t('agentProfile.default')}</option>{THINKING_LEVELS.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
    <label className="agent-field">{t('agentProfile.approval')}<select aria-label={t('agentProfile.approval')} value={draft.approvalMode} onChange={(e) => patch({ approvalMode: e.target.value as NormalAgentDef['approvalMode'] })}>{[['', 'default'], ['readonly', 'readonly'], ['auto-edit', 'autoEdit'], ['full-auto', 'fullAuto'], ['custom', 'custom']].map(([v, k]) => <option key={v} value={v}>{t(`agentProfile.${k}`)}</option>)}</select></label>
  </>
  return <div className={`agent-profile${compact ? ' compact' : ''}`} data-agent-profile={agent.slug} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); e.stopPropagation(); if (dirty) void save() } }}>
    <header className="agent-character-hero">
      <div className="agent-portrait">{s.avatar ? <img src={s.avatar} alt={agent.name} /> : <Bot size={compact ? 30 : 56} strokeWidth={1.5} />}</div>
      <div className="agent-character-identity"><span className="agent-character-id">{agent.slug}</span><h1>{agent.name}</h1><p>{agentDescription(agent, t)}</p><span className={`agent-state${s.running ? ' working' : ''}`}><i />{t(!s.connected ? 'agentProfile.offline' : s.running ? 'agentProfile.working' : 'agentProfile.standby')}</span></div>
      {compact && <button className="profile-expand" title={t('agentProfile.full')} aria-label={t('agentProfile.full')} onClick={() => openAgentProfile(agent.slug)}><ExternalLink size={15} /></button>}
    </header>
    <nav className="agent-section-nav" style={{ '--profile-tab-count': SECTIONS.length, '--profile-tab-index': SECTIONS.findIndex((item) => item.id === section) } as CSSProperties} aria-label={t('agentProfile.currentSection')} role="tablist" onKeyDown={(e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const index = SECTIONS.findIndex((x) => x.id === section)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? SECTIONS.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length
      navigate(SECTIONS[next].id); (e.currentTarget.children[next] as HTMLElement).focus()
    }}>{SECTIONS.map(({ id: tab, icon: Icon }) => <button key={tab} id={`${id}-${tab}`} role="tab" title={t(`agentProfile.${tab}`)} aria-selected={section === tab} aria-controls={`${id}-content`} tabIndex={section === tab ? 0 : -1} onClick={() => navigate(tab)} className={section === tab ? 'selected' : ''}><Icon size={15} /><span>{t(`agentProfile.${tab}`)}</span></button>)}</nav>
    <div ref={scrollRef} className="agent-profile-content" id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${section}`} tabIndex={0}>
      <fieldset className="profile-edit-fields" disabled={busy}>
      <div key={section} className="profile-section-enter">
      {section === 'overview' && <>
        {s.session && <section className="agent-current-session"><small>{t('agentProfile.session')}</small><strong>{s.session.title}</strong>{(s.session.project_name || s.config?.cwd) && <span>{s.session.project_name || s.config?.cwd}</span>}
          <ProfileModelField models={s.models || []} value={s.session.model_id || ''} label={t('agentProfile.sessionModel')} onChange={(model) => useApp.getState().setSessionModel(model, sessionId, false)} />
          <small>{t('agentProfile.sessionModelHint')}</small>
        </section>}
        <ProfileGroup title={t('agentProfile.quickSettings')} hint={t('agentProfile.defaultsHint')}>{runSettings}</ProfileGroup>
        <h3>{t('agentProfile.equipment')}</h3>
        <div className="agent-equipment-grid">{(['skills', 'mcp', 'memory'] as const).map((tab) => { const Icon = tab === 'skills' ? Sparkles : tab === 'mcp' ? Plug : BookOpen; return <button key={tab} onClick={() => navigate(tab)}><Icon size={22} /><span>{t(`agentProfile.${tab}`)}</span><strong>{tab === 'memory' ? t(draft.shareDefaultMemory ? 'agentProfile.sharedMemory' : 'agentProfile.privateMemory') : tab === 'skills' ? (draft.enabledSkillIds?.length ?? t('agentProfile.all')) : (draft.enabledMcpServers?.length ?? t('agentProfile.all'))}</strong><ChevronRight size={14} /></button> })}</div>
        <button className="agent-profile-link" onClick={() => navigate('config')}>{t('agentProfile.moreConfig')}<ChevronRight size={14} /></button>
        {s.usage && <p className="agent-profile-muted">{t('agentProfile.context')} · {s.usage.ctx.toLocaleString()} tokens</p>}
      </>}
      {section === 'skills' && equipment('skills')}
      {section === 'mcp' && equipment('mcp')}
      {section === 'config' && <>
        <ProfileGroup title={t('agentProfile.identity')}>
          <label className="agent-field">{t('agentProfile.name')}<input value={draft.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} /></label>
          <label className="agent-field">{t('agentProfile.description')}<textarea rows={3} value={draft.description} onChange={(e) => patch({ description: e.target.value })} /></label>
        </ProfileGroup>
        <ProfileGroup title={t('agentProfile.instructions')} hint={t('agentProfile.instructionsHint')}>
          <ProfileTextEditor label={t('agentProfile.prompt')} value={draft.systemPrompt} onChange={(systemPrompt) => patch({ systemPrompt })} />
          <ProfileTextEditor label={t('agentProfile.soul')} value={draft.soul || ''} onChange={(soul) => patch({ soul })} />
        </ProfileGroup>
        <details className="profile-disclosure"><summary>{t('agentProfile.quickSettings')}</summary><div className="agent-config-fields">{runSettings}</div></details>
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
      </>}
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
      {dirty ? <><small>{t('agentProfile.unsaved')} · {t('agentProfile.agentDefaults')}</small><div><button className="btn" disabled={busy} onClick={() => { setDraft(agent); setDirty(false); setError('') }}>{t('agentProfile.cancel')}</button><button className="btn primary" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}{t(busy ? 'agentProfile.saving' : 'agentProfile.save')}</button></div></> : section === 'memory' ? <small>{t('agentProfile.memorySaveHint')}</small> : notice ? <p className="profile-save-notice" role="status"><Check size={14} />{notice}</p> : <small>{t('agentProfile.scopeHint')}</small>}
    </footer>
    {library && <AgentMemoryModal cfg={s.cfg} slug={agent.slug} name={agent.name} shareDefaultMemory={agent.shareDefaultMemory} onClose={() => setLibrary(false)} />}
  </div>
}
