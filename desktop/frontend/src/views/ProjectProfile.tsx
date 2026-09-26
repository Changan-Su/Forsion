import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronRight, Copy, ExternalLink, FileText, Folder, FolderGit2, FolderOpen, GitBranch, Loader2, MessageSquarePlus, Plus, RefreshCw, Search, Settings2, Sparkles, Star, TerminalSquare, Users, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { createProjectSkill, getProjectContext, initProjectContext, putProjectDoc, putProjectSettings } from '../services/backendService'
import type { AgentConfig, NormalAgentDef, ProjectContext, ProjectSettings, SessionRecord, TeamDef } from '../types'
import { isTeamImageAvatar, sessionWorkspaceKey, THINKING_LEVELS } from '../types'
import { ProfileModelField, ProfileTextEditor } from './profileControls'
import { AvatarStack } from '../components/AvatarStack'
import { openSpecial } from './SpecialViews'
import { openTerminal } from '../builtins'
import { isProjectWorkspace, type ProjectWorkspace } from '../stores/projectSettings'
import { projectExecutors, shortenPath, type ProjectExecutor } from './projectProfileState'
import { formatRelative } from '../format/time'
import './projectProfileMessages'
import './teamProfile.css'
import './projectProfile.css'
import { AgentAvatar } from '../components/AgentAvatar'
import { thinkingLabel } from '../components/thinkingLabel'

type Tab = 'agents' | 'settings' | 'git'
const TABS: Array<{ id: Tab; icon: typeof Users }> = [{ id: 'agents', icon: Users }, { id: 'settings', icon: Settings2 }, { id: 'git', icon: GitBranch }]

type Props = {
  session: SessionRecord
  config: AgentConfig
  workspace: ProjectWorkspace
  renderAgent: (agent: NormalAgentDef, sessionId?: string | null) => ReactNode
  renderTeam: (session: SessionRecord, config: AgentConfig) => ReactNode
}

/** 当前会话所属的 Project(侧栏分组口径:非系统的本地目录);不是 → null。选择器只吐一个字符串签名,`workspaces()` 每次都造新对象,
 *  直接返回它会让面板随每个 store 更新重渲。 */
export function useProjectWorkspace(session?: SessionRecord | null): ProjectWorkspace | null {
  const signature = useApp((a) => {
    if (!session?.project_path || session.projectless) return ''
    const all = a.workspaces()
    const ws = all.find((w) => w.key === sessionWorkspaceKey(session, all))
    // 家目录不行:引擎的 isForbiddenProjectDir 拒绝它(默认工作区没配置时回落家目录,或旧别名会话就在家目录)→ 照旧 Agent 详情。
    // 判的是**会话自己的**路径:引擎按 sessionId 绑定的就是它。
    return isProjectWorkspace(ws) && session.project_path !== a.homeDir ? JSON.stringify({ key: ws.key, name: ws.name, path: ws.path, system: ws.system, isDefault: ws.isDefault, sessionKeys: ws.sessionKeys }) : ''
  })
  return useMemo(() => (signature ? { ...(JSON.parse(signature) as Omit<ProjectWorkspace, 'kind'>), kind: 'local' as const } : null), [signature])
}

/** PROJECT 详情:骨架与 TEAM 详情同一套(头部即基本信息 / 滑块导航 / 一个滚动体 / 底部保存栏),内容换成项目的三面:
 *  Agents(谁在这里工作过)/ 配置(指令文件 · 项目技能 · 计划 · 本机默认项)/ Git(现场)。数据全部来自引擎的 project-context,
 *  它读到什么就显示什么 —— 这个面板存在的意义就是回答「Tangu 到底看没看见这个项目的约定」。 */
export function ProjectProfile({ session, config, workspace, renderAgent, renderTeam }: Props) {
  const { t, locale } = useI18n()
  const s = useApp(useShallow((a) => ({
    cfg: a.cfg, agents: a.agentDefs, avatars: a.agentAvatars, teams: a.teams, teamAvatars: a.teamAvatars, engines: a.engines, models: a.modelsResp?.models,
    sessions: a.sessions, archived: a.archivedSessions, configBySession: a.configBySession, runningBySession: a.runningBySession,
    defaultSlug: a.defaultAgentSlug, connected: a.connState === 'ok', homeDir: a.homeDir,
  })))
  // 这个会话实际工作的目录 = 引擎按 sessionId 绑定的那个。默认工作区换过位置时,旧会话的目录(别名)≠ 组的当前路径:
  // 显示、读写、设置缓存一律跟会话走;只有「用它开新会话」落在组的当前目录(startWith 用 workspace)。
  const dir = session.project_path || workspace.path
  const [ctx, setCtx] = useState<ProjectContext | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reloadAt, setReloadAt] = useState(0)
  const [tab, setTab] = useState<Tab>('agents')
  const [selected, setSelected] = useState('')
  const [opened, setOpened] = useState<string[]>([])
  const [picker, setPicker] = useState(false)
  const [query, setQuery] = useState('')
  const [nameDraft, setNameDraft] = useState(workspace.name)
  const [docDraft, setDocDraft] = useState('')
  const [docDirty, setDocDirty] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<ProjectSettings>({})
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [skillForm, setSkillForm] = useState<{ slug: string; name: string; description: string; content: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const now = Date.now()

  const executors = useMemo(() => projectExecutors({
    sessions: [...s.sessions, ...s.archived], projectPath: dir, aliases: workspace.sessionKeys, configBySession: s.configBySession,
    runningBySession: s.runningBySession, defaultSlug: s.defaultSlug, currentSessionId: session.id,
  }), [s.sessions, s.archived, s.configBySession, s.runningBySession, s.defaultSlug, dir, workspace.sessionKeys, session.id])
  const running = executors.some((e) => e.running)
  const sessionRunning = !!s.runningBySession[session.id]

  useEffect(() => { setNameDraft(workspace.name) }, [workspace.name])
  useEffect(() => {
    let alive = true
    setLoadError('')
    void getProjectContext(s.cfg, session.id).then((value) => {
      if (!alive) return
      setCtx(value)
      useApp.getState().rememberProjectSettings(dir, value.settings)
    }).catch((e) => { if (alive) setLoadError(e?.status === 404 ? t('projectProfile.localOnly') : String(e?.message || e)) })
    return () => { alive = false }
  }, [s.cfg, session.id, dir, reloadAt]) // eslint-disable-line react-hooks/exhaustive-deps
  // 这个项目里的 run 刚结束(比如「让 Tangu 生成」写完了 AGENTS.md)→ 重拉;编辑中的草稿不动。
  const wasRunning = useRef(running)
  useEffect(() => { if (wasRunning.current && !running) setReloadAt((n) => n + 1); wasRunning.current = running }, [running])
  useEffect(() => { if (!docDirty) setDocDraft(ctx?.doc.content ?? '') }, [ctx?.doc.content, docDirty])
  useEffect(() => { if (!settingsDirty) setSettingsDraft(ctx?.settings ?? {}) }, [ctx?.settings, settingsDirty])

  const dirty = docDirty || settingsDirty
  const relDoc = ctx ? ctx.doc.path.startsWith(`${ctx.cwd}/`) ? ctx.doc.path.slice(ctx.cwd.length + 1) : ctx.doc.path : ''
  const skillsDir = ctx ? `${ctx.workspaceDirName}/skills` : ''
  const clear = () => { setError(''); setNotice('') }
  const open = (key: string) => { setSelected(key); setOpened((keys) => (keys.includes(key) ? keys : [...keys, key])) }
  const reveal = (p: string) => { void window.tangu?.revealHostPath?.(p) }
  const copyPath = () => { void navigator.clipboard?.writeText(dir).then(() => { setNotice(t('projectProfile.copied')) }) }
  const commitName = async () => {
    const name = nameDraft.trim()
    if (workspace.system || !name || name === workspace.name) { setNameDraft(workspace.name); return }
    await useApp.getState().renameWorkspace(workspace, name)
  }
  const patchSettings = (value: Partial<ProjectSettings>) => { setSettingsDraft((d) => ({ ...d, ...value })); setSettingsDirty(true); clear() }
  const execValue = settingsDraft.defaultAgent ? `agent:${settingsDraft.defaultAgent}` : settingsDraft.defaultTeam ? `team:${settingsDraft.defaultTeam}` : ''
  const setExec = (value: string) => {
    const [kind, id] = value.split(':')
    patchSettings({ defaultAgent: kind === 'agent' ? id : undefined, defaultTeam: kind === 'team' ? id : undefined })
  }

  /** 用某个执行者在这个项目里开新会话:落成「新对话草稿」(工作区 + 预选),会话在发送时才建 —— 不留空会话。 */
  const startWith = (target: { kind: 'agent'; slug: string } | { kind: 'team'; team: TeamDef }) => {
    const app = useApp.getState()
    app.setNewChatWs(workspace)
    app.setActiveId(null)
    if (target.kind === 'agent') { app.selectNewChatAgent(target.slug); app.setNewChatCfg((c) => ({ ...c, groupChat: undefined, groupAgents: undefined, teamRoles: undefined, teamDoc: undefined })) }
    else {
      const team = target.team
      app.setNewChatCfg((c) => ({ ...c, agentSlug: undefined, groupChat: true, groupAgents: team.members.map((m) => m.slug), teamRoles: Object.fromEntries(team.members.map((m) => [m.slug, m.role])), teamDoc: team.doc || undefined }))
    }
    setPicker(false); setQuery('')
  }
  /** 行内星标立即落盘。默认项是**一条**记录:配置页里还没保存的草稿一并带上(分开写会互相盖掉 —— 星标写完再点保存,旧草稿会把星标写回去),
   *  写完草稿即与落盘一致,保存栏收起。 */
  const saveDefaultExecutor = async (value: Pick<ProjectSettings, 'defaultAgent' | 'defaultTeam'>) => {
    if (busy) return
    setBusy('default'); clear()
    try {
      const saved = await putProjectSettings(s.cfg, session.id, { ...(settingsDirty ? settingsDraft : ctx?.settings || {}), defaultAgent: undefined, defaultTeam: undefined, ...value })
      setCtx((c) => (c ? { ...c, settings: saved } : c))
      setSettingsDraft(saved ?? {}); setSettingsDirty(false)
      useApp.getState().rememberProjectSettings(dir, saved)
      setNotice(t('projectProfile.saved'))
    } catch (e: any) { setError(String(e?.message || e)) } finally { setBusy('') }
  }
  const init = async () => {
    if (busy) return
    setBusy('init'); clear()
    try {
      const r = await initProjectContext(s.cfg, session.id)
      setCtx(r.context)
      setNotice(t('projectProfile.initialized', { dir: r.context.workspaceDirName }))
    } catch (e: any) { setError(String(e?.message || e)) } finally { setBusy('') }
  }
  const generate = () => {
    if (!ctx || sessionRunning) return
    clear()
    void useApp.getState().send(t('projectProfile.generatePrompt', { file: relDoc }), [], undefined, undefined, undefined, session.id)
    setNotice(t('projectProfile.generateSent'))
  }
  const save = async () => {
    if (busy || !dirty || !ctx) return
    setBusy('save'); clear()
    try {
      if (docDirty) {
        const r = await putProjectDoc(s.cfg, session.id, docDraft, ctx.doc.mtimeMs)
        setCtx((c) => (c ? { ...c, doc: { ...c.doc, path: r.path, exists: true, content: docDraft, mtimeMs: r.mtimeMs, bytes: new TextEncoder().encode(docDraft).length } } : c))
        setDocDirty(false)
      }
      if (settingsDirty) {
        const saved = await putProjectSettings(s.cfg, session.id, settingsDraft)
        setCtx((c) => (c ? { ...c, settings: saved } : c))
        useApp.getState().rememberProjectSettings(dir, saved)
        setSettingsDirty(false)
      }
      setNotice(t('projectProfile.saved'))
    } catch (e: any) { setError(e?.status === 409 ? t('projectProfile.docConflict') : String(e?.message || e)) } finally { setBusy('') }
  }
  const submitSkill = async () => {
    if (!skillForm || busy) return
    setBusy('skill'); clear()
    try {
      await createProjectSkill(s.cfg, session.id, skillForm)
      setSkillForm(null)
      setReloadAt((n) => n + 1)
      setNotice(t('projectProfile.skillCreated'))
    } catch (e: any) { setError(String(e?.message || e)) } finally { setBusy('') }
  }

  const agentOf = (slug: string) => s.agents.find((a) => a.slug === slug)
  const teamOf = (slug: string) => s.teams.find((team) => team.slug === slug)
  const executorLabel = (ex: ProjectExecutor): string => ex.kind === 'agent' ? agentOf(ex.id)?.name || ex.id
    : ex.kind === 'team' ? teamOf(ex.id)?.name || ex.id
    : ex.kind === 'party' ? ex.sessions[0]?.title || t('projectProfile.party')
    : s.engines.find((e) => e.id === ex.id)?.name || ex.id
  const executorPortrait = (ex: ProjectExecutor): ReactNode => {
    if (ex.kind === 'agent') return <AgentAvatar name={agentOf(ex.id)?.name || ex.id} url={s.avatars[ex.id]} fill />
    if (ex.kind === 'engine') return <TerminalSquare size={26} strokeWidth={1.2} />
    const team = ex.kind === 'team' ? teamOf(ex.id) : undefined
    if (team && s.teamAvatars[team.slug] && isTeamImageAvatar(team.avatar)) return <img src={s.teamAvatars[team.slug]} alt="" />
    if (team?.avatar && !isTeamImageAvatar(team.avatar)) return <span aria-hidden="true">{team.avatar}</span>
    const cfg = s.configBySession[ex.sessions[0]?.id] || ex.sessions[0]?.agent_config
    const slugs = team ? team.members.map((m) => m.slug) : cfg?.groupAgents || []
    return slugs.length ? <AvatarStack size={38} items={slugs.map((slug) => ({ slug, name: agentOf(slug)?.name || slug, avatarUrl: s.avatars[slug] }))} /> : <Users size={26} strokeWidth={1.2} />
  }
  const isDefault = (ex: ProjectExecutor) => (ex.kind === 'agent' && ctx?.settings?.defaultAgent === ex.id) || (ex.kind === 'team' && ctx?.settings?.defaultTeam === ex.id)
  const q = query.trim().toLowerCase()
  const listed = new Set(executors.map((ex) => ex.key))
  const agentCandidates = s.agents.filter((a) => a.createdBy !== 'system' && !listed.has(`agent:${a.slug}`) && `${a.name} ${a.description} ${a.slug}`.toLowerCase().includes(q))
  const teamCandidates = s.teams.filter((team) => !listed.has(`team:${team.slug}`) && team.members.length >= 2 && `${team.name} ${team.description} ${team.slug}`.toLowerCase().includes(q))
  const git = ctx?.git
  const changeCount = git?.repo ? git.changesTotal ?? 0 : 0
  const docStatus = !ctx ? null : !ctx.doc.exists ? <span className="project-chip">{t('projectProfile.docMissing')}</span>
    : <>{ctx.doc.truncated ? <span className="project-chip warn">{t('projectProfile.docTruncated')}</span> : <span className="project-chip ok"><Check size={11} />{t('projectProfile.docActive')}</span>}
      {ctx.doc.sources.length > 1 && <span className="project-chip" title={ctx.doc.sources.filter((p) => p !== ctx.doc.path).join('\n')}>{t('projectProfile.docOthers', { count: ctx.doc.sources.length - 1 })}</span>}</>

  const detailFor = (ex: ProjectExecutor): ReactNode => {
    if (ex.kind === 'agent') { const agent = agentOf(ex.id); return agent ? renderAgent(agent, ex.current ? session.id : ex.sessions[0]?.id) : null }
    if (ex.kind === 'team' || ex.kind === 'party') {
      const target = ex.current ? session : ex.sessions[0]
      return target ? renderTeam(target, (ex.current ? config : s.configBySession[target.id]) || target.agent_config || {}) : null
    }
    return null
  }

  return <section className="team-profile project-profile" data-project-profile={dir}>
    <div className="team-profile-main" hidden={!!selected}>
      <header className="team-profile-hero">
        <span className="team-profile-emblem" aria-hidden="true">{git?.repo ? <FolderGit2 size={26} strokeWidth={1.5} /> : <Folder size={26} strokeWidth={1.5} />}</span>
        <div className="team-profile-identity"><h3>{t('projectProfile.kind')}</h3>
          <input className="agent-character-name team-profile-name" aria-label={t('projectProfile.name')} title={workspace.name} value={nameDraft} maxLength={100} disabled={!!busy} readOnly={!!workspace.system}
            onChange={(e) => setNameDraft(e.target.value)} onBlur={() => void commitName()} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setNameDraft(workspace.name); e.currentTarget.blur() } }} />
          <span className={`agent-state${running ? ' working' : ''}`}><i />{t(!s.connected ? 'agentProfile.offline' : running ? 'projectProfile.status.working' : 'projectProfile.status.idle')}
            <span>· {t('projectProfile.sessions', { count: executors.reduce((n, ex) => n + ex.sessions.length, 0) })}</span>
            {git?.repo && <span className="project-branch" title={git.detached ? t('projectProfile.git.detached') : git.branch}><GitBranch size={10} /><span>{git.branch}</span>{changeCount > 0 && <span>*</span>}</span>}
          </span></div>
        <button className="profile-expand" title={t('projectProfile.open')} aria-label={t('projectProfile.open')} onClick={() => openSpecial('workspace', workspace.key)}><ExternalLink size={15} /></button>
      </header>
      <p className="team-profile-location project-profile-path"><button type="button" title={dir} onClick={() => reveal(dir)}>{shortenPath(dir, s.homeDir)}</button></p>
      <nav className="agent-section-nav" style={{ '--profile-tab-count': TABS.length, '--profile-tab-index': TABS.findIndex((item) => item.id === tab) } as CSSProperties} aria-label={t('projectProfile.navigation')} role="tablist" onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
        e.preventDefault()
        const index = TABS.findIndex((x) => x.id === tab)
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
        setTab(TABS[next].id); (e.currentTarget.children[next] as HTMLElement).focus()
      }}>{TABS.map(({ id, icon: Icon }) => <button key={id} role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={14} /><span>{t(`projectProfile.tab.${id}`)}</span></button>)}</nav>
      <fieldset disabled={!!busy} className="team-profile-fields" key={tab}>
        {loadError && <p className="agent-profile-error" role="alert" style={{ paddingTop: 16 }}>{loadError} <button className="profile-text-action" onClick={() => setReloadAt((n) => n + 1)}>{t('projectProfile.retry')}</button></p>}
        {tab === 'agents' && <>
          <div className="team-lineup-toolbar"><p className="team-profile-caption">{t('projectProfile.agentsHint')}</p><button className="team-member-add" onClick={() => setPicker(!picker)} aria-expanded={picker}><Plus size={24} strokeWidth={1.5} /><span>{t('projectProfile.add')}</span></button></div>
          {picker && <div className="team-candidate-picker"><div className="team-candidate-heading"><label className="agents-search"><Search size={13} /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('agentProfile.search')} placeholder={t('agentProfile.search')} /></label><button aria-label={t('projectProfile.closePicker')} onClick={() => setPicker(false)}><X size={14} /></button></div>
            <p className="team-profile-caption">{t('projectProfile.addHint')}</p>
            <div className="team-candidates project-candidates">
              {agentCandidates.map((a) => <button key={a.slug} onClick={() => startWith({ kind: 'agent', slug: a.slug })}><AgentAvatar name={a.name || a.slug} url={s.avatars[a.slug]} size={16} className="agent-avatar-mini" /><span><strong>{a.name}</strong><small>{a.description}</small></span><MessageSquarePlus size={14} /></button>)}
              {teamCandidates.map((team) => <button key={team.slug} onClick={() => startWith({ kind: 'team', team })}><Users size={16} /><span><strong>{team.name}</strong><small>{team.description || team.members.map((m) => agentOf(m.slug)?.name || m.slug).join(' · ')}</small></span><MessageSquarePlus size={14} /></button>)}
              {!agentCandidates.length && !teamCandidates.length && <p className="agent-profile-muted">{t('projectProfile.noCandidates')}</p>}
            </div></div>}
          <div className="team-lineup">{executors.map((ex) => {
            const canOpen = ex.kind !== 'engine' && (ex.kind !== 'agent' || !!agentOf(ex.id))
            const team = ex.kind === 'team' ? teamOf(ex.id) : undefined
            return <article className="team-member project-executor" key={ex.key} data-project-executor={ex.key}>
              <button className="team-member-open" disabled={!canOpen} onClick={() => open(ex.key)} aria-label={`${t('projectProfile.inspect')} ${executorLabel(ex)}`}>
                <span className="team-member-portrait">{executorPortrait(ex)}</span>
                <strong><span>{executorLabel(ex)}</span>{(ex.current || isDefault(ex)) && <span className="project-executor-tags">{ex.current && <em className="project-executor-tag is-text">{t('projectProfile.current')}</em>}{isDefault(ex) && <em className="project-executor-tag" title={t('projectProfile.isDefault')}><Star size={10} /></em>}</span>}</strong>
                <span className={`team-member-status ${ex.running ? 'working' : 'idle'}`}>{t(ex.running ? 'projectProfile.status.working' : ex.kind === 'party' ? 'projectProfile.party' : ex.kind === 'engine' ? 'projectProfile.engine' : 'projectProfile.status.idle')} · {t('projectProfile.sessions', { count: ex.sessions.length })}{ex.lastActive ? ` · ${t('projectProfile.lastActive', { time: formatRelative(ex.lastActive, { now, locale }) })}` : ''}</span>
                {canOpen && <ChevronRight size={14} className="team-member-chevron" />}
              </button>
              {(ex.kind === 'agent' || (ex.kind === 'team' && team)) && <div className="project-inline-actions">
                <button type="button" onClick={() => (ex.kind === 'agent' ? startWith({ kind: 'agent', slug: ex.id }) : team && startWith({ kind: 'team', team }))}><MessageSquarePlus size={13} />{t('projectProfile.startWith')}</button>
                <button type="button" className={isDefault(ex) ? 'is-default' : ''} aria-pressed={isDefault(ex)} disabled={!ctx} onClick={() => void saveDefaultExecutor(isDefault(ex) ? {} : ex.kind === 'agent' ? { defaultAgent: ex.id } : { defaultTeam: ex.id })}><Star size={13} />{t(isDefault(ex) ? 'projectProfile.isDefault' : 'projectProfile.setDefault')}</button>
              </div>}
            </article>
          })}</div>
        </>}
        {tab === 'settings' && ctx && <div className="project-section">
          <section className="project-card" data-project-doc>
            <div className="project-card-head"><div><h3><FileText size={13} style={{ verticalAlign: -2, marginRight: 5 }} />{t('projectProfile.instructions')}</h3><small title={ctx.doc.path}>{relDoc}</small><div className="project-chips">{docStatus}</div></div>
              {ctx.doc.exists && <button type="button" title={t('projectProfile.reveal')} aria-label={t('projectProfile.reveal')} onClick={() => reveal(ctx.doc.path)}><FolderOpen size={14} /></button>}</div>
            {ctx.doc.exists && ctx.doc.tooLarge ? <p className="agent-profile-muted">{t('projectProfile.docTooLarge')}</p>
              : ctx.doc.exists || docDirty ? <ProfileTextEditor label={t('projectProfile.instructions')} rows={12} value={docDraft} maxLength={200000} placeholder={t('projectProfile.docEmpty')} onChange={(value) => { setDocDraft(value); setDocDirty(true); clear() }} hint={t('projectProfile.docHint', { names: 'AGENTS.md / CLAUDE.md' })} />
              : <>
                <p className="agent-profile-muted">{t('projectProfile.docEmpty')}</p>
                <div className="project-card-actions">
                  <button type="button" className="btn ghost sm" onClick={() => void init()}>{busy === 'init' ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}{t('projectProfile.init', { file: relDoc })}</button>
                  <button type="button" className="btn primary sm" disabled={sessionRunning || !s.connected} title={sessionRunning ? t('projectProfile.generateBusy') : undefined} onClick={generate}><Sparkles size={13} />{t('projectProfile.generate')}</button>
                </div>
                <p className="agent-profile-muted">{t('projectProfile.docHint', { names: 'AGENTS.md / CLAUDE.md' })}</p>
              </>}
          </section>
          <section className="project-card" data-project-skills>
            <div className="project-card-head"><div><h3><Sparkles size={13} style={{ verticalAlign: -2, marginRight: 5 }} />{t('projectProfile.skills')}</h3><small>{t('projectProfile.skillsHint', { dir: skillsDir })}</small></div>
              <button type="button" title={t('projectProfile.openSkills')} aria-label={t('projectProfile.openSkills')} onClick={() => void (ctx.skills.length || busy ? Promise.resolve() : initProjectContext(s.cfg, session.id).then((r) => setCtx(r.context))).then(() => reveal(`${ctx.workspaceDir}/skills`))}><FolderOpen size={14} /></button></div>
            {ctx.skills.length ? <div className="project-list">{ctx.skills.map((skill) => <button type="button" key={`${skill.id}:${skill.legacy}`} className="project-row" title={skill.path} onClick={() => reveal(`${skill.path}/SKILL.md`)}><strong>{skill.name}</strong>{skill.legacy && <small className="project-chip warn">{t('projectProfile.legacySkill')}</small>}<span style={{ gridColumn: '1 / -1' }}>{skill.description || skill.id}</span></button>)}</div>
              : <p className="agent-profile-muted">{t('projectProfile.noSkills')}</p>}
            {skillForm ? <form className="project-skill-form" onSubmit={(e) => { e.preventDefault(); void submitSkill() }}>
              <label>{t('projectProfile.skillFolder')}<input required autoFocus pattern="[a-z0-9][a-z0-9-]*" placeholder="my-skill" value={skillForm.slug} onChange={(e) => setSkillForm({ ...skillForm, slug: e.target.value })} /></label>
              <label>{t('agentProfile.name')}<input required value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} /></label>
              <label>{t('agentProfile.description')}<input value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} /></label>
              <label>{t('agentProfile.prompt')}<textarea required rows={6} value={skillForm.content} onChange={(e) => setSkillForm({ ...skillForm, content: e.target.value })} /></label>
              <div><button type="button" className="btn ghost sm" onClick={() => setSkillForm(null)}>{t('agentProfile.cancel')}</button><button type="submit" className="btn primary sm" disabled={!skillForm.slug.trim() || !skillForm.name.trim() || !skillForm.content.trim()}>{busy === 'skill' && <Loader2 size={13} className="spin" />}{t('projectProfile.newSkill')}</button></div>
            </form> : <div className="project-card-actions"><button type="button" className="btn ghost sm" onClick={() => { clear(); setSkillForm({ slug: '', name: '', description: '', content: '' }) }}><Plus size={13} />{t('projectProfile.newSkill')}</button></div>}
          </section>
          {ctx.plans.length > 0 && <section className="project-card" data-project-plans>
            <div className="project-card-head"><div><h3>{t('projectProfile.plans')}</h3><small>{t('projectProfile.plansHint', { dir: `${ctx.workspaceDirName}/plans` })}</small></div></div>
            <div className="project-list">{ctx.plans.map((plan) => <button type="button" key={plan.path} className="project-row" title={plan.path} onClick={() => void window.tangu?.openHostPath?.(plan.path)}><strong>{plan.title || plan.name}</strong><small>{formatRelative(plan.mtimeMs, { now, locale })}</small></button>)}</div>
          </section>}
          <section className="project-card" data-project-defaults>
            <div className="project-card-head"><div><h3>{t('projectProfile.defaults')}</h3><small>{t('projectProfile.defaultsHint')}</small></div></div>
            <label className="project-field">{t('projectProfile.defaultExecutor')}<select value={execValue} onChange={(e) => setExec(e.target.value)}>
              <option value="">{t('projectProfile.defaultNone')}</option>
              <optgroup label={t('projectProfile.agents')}>{s.agents.filter((a) => a.createdBy !== 'system').map((a) => <option key={a.slug} value={`agent:${a.slug}`}>{a.name}</option>)}</optgroup>
              {s.teams.length > 0 && <optgroup label={t('projectProfile.teams')}>{s.teams.map((team) => <option key={team.slug} value={`team:${team.slug}`}>{team.name}</option>)}</optgroup>}
            </select></label>
            <label className="project-field">{t('agentProfile.approval')}<select value={settingsDraft.approvalMode || ''} onChange={(e) => patchSettings({ approvalMode: (e.target.value || undefined) as ProjectSettings['approvalMode'] })}>
              <option value="">{t('projectProfile.inherit')}</option>
              {([['readonly', 'readonly'], ['auto-edit', 'autoEdit'], ['full-auto', 'fullAuto'], ['custom', 'custom']] as const).map(([v, k]) => <option key={v} value={v}>{t(`agentProfile.${k}`)}</option>)}
            </select></label>
            <ProfileModelField models={(s.models || []).filter((m) => (m.modelType || 'llm') === 'llm')} value={settingsDraft.model || ''} label={t('agentProfile.model')} onChange={(model) => patchSettings({ model: model || undefined })} />
            <label className="project-field">{t('agentProfile.thinking')}<select value={settingsDraft.thinkingLevel || ''} onChange={(e) => patchSettings({ thinkingLevel: (e.target.value || undefined) as ProjectSettings['thinkingLevel'] })}>
              <option value="">{t('projectProfile.inherit')}</option>
              {THINKING_LEVELS.map((lv) => <option key={lv} value={lv}>{thinkingLabel(lv, t)}</option>)}
            </select></label>
          </section>
        </div>}
        {tab === 'git' && ctx && git && <div className="project-section">
          <section className="project-card" data-project-git>
            {!git.available ? <p className="agent-profile-muted">{t('projectProfile.git.unavailable')}</p>
              : !git.repo ? <p className="agent-profile-muted">{t('projectProfile.git.none')}</p>
              : <div className="project-git-summary">
                <div><span>{t('projectProfile.git.branch')}</span><strong title={git.branch}>{git.branch}</strong>{git.detached && <span className="project-chip">{t('projectProfile.git.detached')}</span>}</div>
                <div><span>{t('projectProfile.git.upstream')}</span>{git.upstream ? <><strong title={git.upstream}>{git.upstream}</strong><span className="project-chip">{git.ahead || git.behind ? [git.ahead ? t('projectProfile.git.ahead', { count: git.ahead }) : '', git.behind ? t('projectProfile.git.behind', { count: git.behind }) : ''].filter(Boolean).join(' · ') : t('projectProfile.git.inSync')}</span></> : <strong className="agent-profile-muted">{t('projectProfile.git.noUpstream')}</strong>}</div>
                <div><span>{t('projectProfile.git.changes')}</span>{changeCount ? <div className="project-chips">{!!git.staged && <span className="project-chip ok">{t('projectProfile.git.staged', { count: git.staged })}</span>}{!!git.unstaged && <span className="project-chip">{t('projectProfile.git.unstaged', { count: git.unstaged })}</span>}{!!git.untracked && <span className="project-chip">{t('projectProfile.git.untracked', { count: git.untracked })}</span>}</div> : <strong className="agent-profile-muted">{t('projectProfile.git.clean')}</strong>}</div>
                {git.remote && <div><span>{t('projectProfile.git.remote')}</span><strong title={git.remote}>{git.remote}</strong></div>}
                {git.nested && <p className="agent-profile-muted">{t('projectProfile.git.nested')}</p>}
              </div>}
            <div className="project-inline-actions start" data-project-git-actions>
              <button type="button" onClick={() => openTerminal(dir)}><TerminalSquare size={13} />{t('projectProfile.terminal')}</button>
              <button type="button" onClick={() => reveal(dir)}><FolderOpen size={13} />{t('projectProfile.reveal')}</button>
              <button type="button" onClick={copyPath}><Copy size={13} />{t('projectProfile.copyPath')}</button>
              <button type="button" onClick={() => setReloadAt((n) => n + 1)}><RefreshCw size={13} />{t('projectProfile.refresh')}</button>
            </div>
          </section>
          {git.repo && !!git.changes?.length && <section className="project-card" data-project-git-changes>
            <div className="project-card-head"><div><h3>{t('projectProfile.git.changeCount', { count: changeCount })}</h3></div></div>
            <div className="project-list">{git.changes.map((c) => <div key={`${c.code}${c.path}`} className="project-row project-row-static project-git-change" title={c.path}><code className={c.code === '??' ? 'untracked' : c.code[0] !== ' ' ? 'staged' : ''}>{c.code.trim() || '·'}</code><span>{c.path}</span></div>)}
              {changeCount > git.changes.length && <p className="agent-profile-muted">{t('projectProfile.git.more', { count: changeCount - git.changes.length })}</p>}</div>
          </section>}
          {git.repo && !!git.commits?.length && <section className="project-card" data-project-git-commits>
            <div className="project-card-head"><div><h3>{t('projectProfile.git.commits')}</h3></div></div>
            <div className="project-list">{git.commits.map((c) => <div key={c.sha} className="project-row project-row-static project-git-commit" title={c.sha}><strong>{c.subject}</strong><small>{formatRelative(c.at, { now, locale })}</small><code>{c.short}</code></div>)}</div>
          </section>}
        </div>}
        {!ctx && !loadError && <p className="agent-profile-muted" style={{ paddingTop: 16 }}><Loader2 size={14} className="spin" /> {t('projectProfile.loading')}</p>}
      </fieldset>
      <footer className={`agent-profile-save${dirty ? ' is-dirty' : ''}`}>
        {error && <p className="agent-profile-error" role="alert">{error}{error === t('projectProfile.docConflict') && <> <button className="profile-text-action" onClick={() => { setDocDirty(false); setReloadAt((n) => n + 1); clear() }}>{t('projectProfile.retry')}</button></>}</p>}
        {notice && <p className="profile-save-notice" role="status"><Check size={13} />{notice}</p>}
        {dirty ? <><small>{t('projectProfile.saveScope')}</small><div><button className="btn" disabled={!!busy} onClick={() => { setDocDirty(false); setSettingsDirty(false); setDocDraft(ctx?.doc.content ?? ''); setSettingsDraft(ctx?.settings ?? {}); clear() }}>{t('agentProfile.cancel')}</button><button className="btn primary" disabled={!!busy} onClick={() => void save()}>{busy === 'save' && <Loader2 size={13} className="spin" />}{t(busy === 'save' ? 'agentProfile.saving' : 'projectProfile.save')}</button></div></> : null}
      </footer>
    </div>
    {selected && <div className="team-member-heading"><button aria-label={t('projectProfile.back')} onClick={() => setSelected('')}><ArrowLeft size={14} />{t('projectProfile.back')}{dirty && <span className="team-draft-dot" title={t('agentProfile.unsaved')} />}</button><small>{executors.find((ex) => ex.key === selected) ? executorLabel(executors.find((ex) => ex.key === selected)!) : ''}</small></div>}
    {/* 点开过的执行者详情保持挂载:返回项目再点进去,里面没保存的草稿还在(与 TEAM 详情同一手法)。 */}
    {opened.map((key) => {
      const ex = executors.find((item) => item.key === key)
      if (!ex) return null
      return <div className="team-detail-pane" key={key} hidden={selected !== key} data-project-executor-detail={key}>{detailFor(ex)}</div>
    })}
  </section>
}
