import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode, type CSSProperties } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, Bot, ChevronRight, ImageUp, Loader2, Plus, Search, Settings2, Smile, Trash2, Users, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { deleteTeamAvatar, getTeam, patchSessionConfig, patchTeam, updateSession, uploadTeamAvatar } from '../services/backendService'
import type { AgentConfig, ModelInfo, NormalAgentDef, SessionRecord, TeamDef, ThinkingLevel } from '../types'
import { isTeamImageAvatar, THINKING_LEVELS } from '../types'
import { ProfileModelField, ProfileTextEditor } from './profileControls'
import { AvatarStack } from '../components/AvatarStack'
import { ModelSelect } from '../components/ModelSelect'
import { moveTeamMember, teamDraft, teamSessionConfig, teamSessionPatch, type MemberTuning, type TeamDraft } from './teamProfileState'
import './teamProfileMessages'
import './teamProfile.css'

type Props = {
  session?: SessionRecord
  config: AgentConfig
  renderMember: (agent: NormalAgentDef, sessionId?: string) => ReactNode
}

/** A TEAM edits its persistent definition; a project's party edits only this conversation. */
export function TeamProfile({ session, config, renderMember }: Props) {
  const { t } = useI18n()
  const s = useApp(useShallow((a) => ({ cfg: a.cfg, agents: a.agentDefs, avatars: a.agentAvatars, models: a.modelsResp?.models,
    teamAvatarUrl: config.teamSlug ? a.teamAvatars[config.teamSlug] : undefined,
    work: session ? a.teamWorkBySession[session.id] : undefined,
    running: session ? !!a.runningBySession[session.id] : false, connected: a.connState === 'ok',
  })))
  const [team, setTeam] = useState<TeamDef>()
  const [loaded, setLoaded] = useState(!config.teamSlug)
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const [tab, setTab] = useState<'lineup' | 'settings'>('lineup')
  const [selected, setSelected] = useState('')
  const [opened, setOpened] = useState<string[]>([])
  const [picker, setPicker] = useState(false)
  const [query, setQuery] = useState('')
  const source = useMemo(() => teamDraft(config, session?.title || '', team), [config, session?.title, team])
  const [draft, setDraft] = useState<TeamDraft>(source)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [emojiEdit, setEmojiEdit] = useState(false)
  useEffect(() => { if (!dirty) setDraft(source) }, [source, dirty])
  useEffect(() => {
    if (!config.teamSlug) return
    let alive = true
    setLoaded(false); setLoadError('')
    void getTeam(s.cfg, config.teamSlug).then((value) => { if (alive) { setTeam(value); setLoaded(true) } })
      .catch((e) => { if (alive) setLoadError(String(e.message || e)) })
    return () => { alive = false }
  }, [s.cfg, config.teamSlug, retry])
  useEffect(() => { if (session) void useApp.getState().hydrateTeamWork(session.id) }, [session?.id])

  const patch = (value: Partial<TeamDraft>) => { setDraft((d) => ({ ...d, ...value })); setDirty(true); setNotice(''); setError('') }
  const agentFor = (slug: string) => draft.tempAgents.find((a) => a.slug === slug) || s.agents.find((a) => a.slug === slug)
  const open = (slug: string) => { setSelected(slug); setOpened((ids) => ids.includes(slug) ? ids : [...ids, slug]) }
  const add = (slug: string) => { patch({ members: [...draft.members, { slug, role: '' }] }); setPicker(false); setQuery('') }
  // 会话级调档:已存成员写 memberConfigs(只影响本会话),临时成员的模型 / Effort 本就住在它自己的定义里 —— 两处只此一个写点。
  const tuneMember = (slug: string, value: { model?: string; thinkingLevel?: ThinkingLevel | '' }) => {
    if (draft.tempAgents.some((a) => a.slug === slug)) { patch({ tempAgents: draft.tempAgents.map((a) => a.slug === slug ? { ...a, ...value } : a) }); return }
    const merged = { ...draft.memberConfigs[slug], ...value }
    patch({ memberConfigs: { ...draft.memberConfigs, [slug]: { model: merged.model || undefined, thinkingLevel: merged.thinkingLevel || undefined } } })
  }
  const addTemp = () => {
    const agent: NormalAgentDef = { slug: `temp-${crypto.randomUUID()}`, name: t('teamProfile.temp'), description: '', model: '', tools: [], thinkingLevel: '', maxIterations: null, approvalMode: '', createdBy: 'user', createdAt: '', systemPrompt: '' }
    patch({ members: [...draft.members, { slug: agent.slug, role: '' }], tempAgents: [...draft.tempAgents, agent] })
    setPicker(false); open(agent.slug)
  }
  // 头像图只有 store.teamAvatars 一份 objectURL(侧栏行与本页共用):改完整表重拉,两处同时换新。
  const syncSavedTeam = async (updated: TeamDef) => {
    setTeam(updated)
    setDraft((current) => ({ ...current, avatar: updated.avatar }))
    await useApp.getState().refreshTeams().catch(() => { /* 头像已落盘;列表刷新失败留给下次 */ })
  }
  const pickTeamAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !config.teamSlug) return
    if (file.size > 1_048_576) { setError(t('agentProfile.avatarTooLarge')); return }
    setAvatarBusy(true); setError(''); setNotice('')
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error(t('agentProfile.avatarReadFailed')))
        reader.readAsDataURL(file)
      })
      const uploaded = await uploadTeamAvatar(s.cfg, config.teamSlug, dataUrl, file.type)
      await syncSavedTeam({ ...(team as TeamDef), avatar: uploaded.avatar })
      setNotice(t('teamProfile.avatarSaved'))
    } catch (e: any) { setError(String(e.message || e)) } finally { setAvatarBusy(false) }
  }
  const removeTeamAvatar = async () => {
    if (!config.teamSlug || avatarBusy || !isTeamImageAvatar(draft.avatar)) return
    setAvatarBusy(true); setError(''); setNotice('')
    try {
      await deleteTeamAvatar(s.cfg, config.teamSlug)
      await syncSavedTeam({ ...(team as TeamDef), avatar: '' })
      setNotice(t('teamProfile.avatarRemoved'))
    } catch (e: any) { setError(String(e.message || e)) } finally { setAvatarBusy(false) }
  }
  const candidates = s.agents.filter((a) => a.createdBy !== 'system' && !draft.members.some((m) => m.slug === a.slug) && `${a.name} ${a.description} ${a.slug}`.toLowerCase().includes(query.toLowerCase()))
  const teamAvatar = s.teamAvatarUrl && isTeamImageAvatar(draft.avatar) ? <img src={s.teamAvatarUrl} alt="" /> : (!isTeamImageAvatar(draft.avatar) && draft.avatar) || (draft.members.length
    ? <AvatarStack size={42} items={draft.members.map((member) => {
        const definition = agentFor(member.slug)
        return { slug: member.slug, name: definition?.name || member.slug, avatarUrl: s.avatars[member.slug] }
      })} />
    : <Users size={26} strokeWidth={1.5} />)
  const missing = draft.members.some((m) => !agentFor(m.slug) || (config.teamSlug && !s.agents.some((a) => a.slug === m.slug)))
  const invalidTemp = draft.tempAgents.some((a) => draft.members.some((m) => m.slug === a.slug) && (!a.name.trim() || !a.systemPrompt.trim()))
  const valid = draft.members.length >= 2 && !missing && !invalidTemp && !!draft.name.trim()
  const save = async () => {
    if (busy || !valid || !loaded) return
    setBusy(true); setError(''); setNotice('')
    let definitionSaved = false
    try {
      let nextDraft = draft
      if (config.teamSlug) {
        const updated = await patchTeam(s.cfg, config.teamSlug, { name: draft.name.trim(), description: draft.description, avatar: draft.avatar, members: draft.members, doc: draft.doc })
        definitionSaved = true
        setTeam(updated)
        useApp.setState((a) => ({ teams: a.teams.some((v) => v.slug === updated.slug) ? a.teams.map((v) => v.slug === updated.slug ? updated : v) : [...a.teams, updated] }))
        nextDraft = { ...draft, name: updated.name, description: updated.description, avatar: updated.avatar, members: updated.members, doc: updated.doc }
      }
      if (session) {
        const current = useApp.getState().configBySession[session.id] || session.agent_config || config
        // 只写团队这几个键(服务端按键合并);老引擎没有 PATCH 就回落整对象 PUT —— 整对象在回落那一刻按本地最新现拼,
        // 等 404 的这一拍里别的 setter(如刚收紧的审批档)可能已经改过本地
        const savedConfig = await patchSessionConfig(s.cfg, session.id, teamSessionPatch(nextDraft), () => teamSessionConfig(useApp.getState().configBySession[session.id] || current, nextDraft))
        // 回来只把团队这几个键并进本地最新配置:响应是保存那一刻的快照,整份盖回去会把保存途中别处改过的键(如刚移除的工作范围)退回旧值
        useApp.setState((a) => ({ configBySession: { ...a.configBySession, [session.id]: teamSessionConfig(a.configBySession[session.id] || savedConfig, nextDraft) }, sessions: a.sessions.map((v) => v.id === session.id ? { ...v, agent_config: savedConfig } : v) }))
        if (!config.teamSlug && nextDraft.name.trim() !== session.title) {
          const updated = await updateSession(s.cfg, session.id, { title: nextDraft.name.trim() })
          useApp.setState((a) => ({ sessions: a.sessions.map((v) => v.id === session.id ? { ...v, title: updated.title } : v) }))
        }
      } else {
        useApp.setState((a) => ({ newChatCfg: teamSessionConfig(a.newChatCfg, nextDraft) }))
      }
      setDraft(nextDraft); setDirty(false); setNotice(t('agentProfile.saved'))
    } catch (e: any) {
      setError(`${definitionSaved ? `${t('teamProfile.partialSave')} ` : ''}${String(e.message || e)}`)
    } finally { setBusy(false) }
  }

  if (!loaded) return <section className="team-profile" data-team-profile><h3>{t('agentProfile.team')}</h3>{loadError ? <><p role="alert" className="agent-profile-error">{loadError}</p><button onClick={() => setRetry((n) => n + 1)}>{t('teamProfile.retry')}</button></> : <p className="agent-profile-muted"><Loader2 size={14} className="spin" /> {t('teamProfile.loading')}</p>}</section>

  return <section className="team-profile" data-team-profile={config.teamSlug || session?.id || 'draft'}>
    <div className="team-profile-main" hidden={!!selected}>
      <header className="team-profile-hero">
        {/* 头部即「基本信息」(与 Agent 头部同一套):头像点开即换图(立即保存),右上角次要动作 = 有图时移除、无图时设 Emoji;
            名称 / 简介原地编辑,Emoji 与它们一起走下方保存栏。项目内的临时配队只有名称(存为会话标题)。 */}
        {config.teamSlug ? <div className="agent-portrait-slot">
          {emojiEdit
            ? <span className="team-profile-emblem"><input className="team-emblem-emoji" autoFocus aria-label={t('teamProfile.avatarEmoji')} value={draft.avatar} maxLength={16} placeholder="🧭" onChange={(e) => patch({ avatar: e.target.value })} onBlur={() => setEmojiEdit(false)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur() }} /></span>
            : <label className="team-profile-emblem agent-portrait-edit" title={t('teamProfile.avatarImageHint')} aria-busy={avatarBusy || undefined}>
              {teamAvatar}
              <span className="agent-portrait-badge" aria-hidden="true">{avatarBusy ? <Loader2 size={10} className="spin" /> : <ImageUp size={10} />}</span>
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label={t('teamProfile.avatarChange')} disabled={avatarBusy} onChange={(event) => void pickTeamAvatar(event)} />
            </label>}
          {isTeamImageAvatar(draft.avatar)
            ? <button type="button" className="agent-portrait-remove" title={t('teamProfile.avatarRemove')} aria-label={t('teamProfile.avatarRemove')} disabled={avatarBusy} onClick={() => void removeTeamAvatar()}><X size={10} /></button>
            : !emojiEdit && <button type="button" className="agent-portrait-remove" title={t('teamProfile.avatarHint')} aria-label={t('teamProfile.avatarEmojiEdit')} disabled={busy} onClick={() => setEmojiEdit(true)}><Smile size={10} /></button>}
        </div> : <span className="team-profile-emblem">{teamAvatar}</span>}
        <div className="team-profile-identity"><h3>{t('agentProfile.team')}</h3>
          <input className="agent-character-name team-profile-name" aria-label={t('teamProfile.name')} placeholder={t('teamProfile.untitled')} title={draft.name} value={draft.name} maxLength={100} disabled={busy} onChange={(e) => patch({ name: e.target.value })} />
          {config.teamSlug && <textarea className="agent-character-desc team-profile-desc" aria-label={t('agentProfile.description')} placeholder={t('agentProfile.descriptionPlaceholder')} rows={1} value={draft.description} maxLength={500} disabled={busy} onChange={(e) => patch({ description: e.target.value })} />}
          <span className={`agent-state${s.running ? ' working' : ''}`}><i />{t(!s.connected ? 'agentProfile.offline' : s.running ? 'agentProfile.working' : 'agentProfile.standby')}<span>· {draft.members.length} {t('teamProfile.members')}</span></span></div>
      </header>
      {(session?.project_name || config.cwd) && <p className="team-profile-location" title={config.cwd}>{session?.project_name || (config.teamSlug ? t('teamProfile.library') : config.cwd?.replace(/\\/g, '/').split('/').filter(Boolean).pop() || config.cwd)}</p>}
      <nav className="agent-section-nav" style={{ '--profile-tab-count': 2, '--profile-tab-index': tab === 'lineup' ? 0 : 1 } as CSSProperties} aria-label={t('teamProfile.navigation')}>
        <button className={tab === 'lineup' ? 'selected' : ''} aria-pressed={tab === 'lineup'} onClick={() => setTab('lineup')}><Users size={14} />{t('teamProfile.lineup')}</button>
        <button className={tab === 'settings' ? 'selected' : ''} aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}><Settings2 size={14} />{t('teamProfile.settings')}</button>
      </nav>
      <fieldset disabled={busy} className="team-profile-fields" key={tab}>
        {tab === 'lineup' ? <>
          <div className="team-lineup-toolbar"><p className="team-profile-caption">{t('teamProfile.lineupHint')}</p><button className="team-member-add" onClick={() => setPicker(!picker)} aria-expanded={picker}><Plus size={24} strokeWidth={1.5} /><span>{t('teamProfile.add')}</span></button></div>
          {picker && <div className="team-candidate-picker"><div className="team-candidate-heading"><label className="agents-search"><Search size={13} /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('agentProfile.search')} placeholder={t('agentProfile.search')} /></label><button aria-label={t('teamProfile.closePicker')} onClick={() => setPicker(false)}><X size={14} /></button></div><div className="team-candidates">{candidates.map((a) => <button key={a.slug} onClick={() => add(a.slug)}><Bot size={16} /><span><strong>{a.name}</strong><small>{a.description}</small></span><Plus size={14} /></button>)}{!candidates.length && <p className="agent-profile-muted">{t('teamProfile.noCandidates')}</p>}</div>{!config.teamSlug && <button className="agent-profile-link" onClick={addTemp}>{t('teamProfile.addTemp')}<Plus size={14} /></button>}</div>}
          <div className="team-lineup">{draft.members.map((m, index) => {
            const agent = agentFor(m.slug), work = s.work?.[m.slug]
            const status = work?.status || 'idle'
            return <article className={`team-member${!agent ? ' unavailable' : ''}`} key={m.slug} data-team-member={m.slug}>
              <button className="team-member-open" disabled={!agent} onClick={() => open(m.slug)} aria-label={`${t('teamProfile.inspect')} ${agent?.name || m.slug}`}>
                <span className="team-member-portrait">{s.avatars[m.slug] ? <img src={s.avatars[m.slug]} alt="" /> : <Bot size={42} strokeWidth={1} />}</span>
                <strong>{agent?.name || m.slug}</strong><span className={`team-member-status ${status}`}>{agent ? t(`teamProfile.status.${status}`) : t('teamProfile.missing')}</span><ChevronRight size={14} className="team-member-chevron" />
              </button>
              {agent && <MemberTuning agent={agent} models={s.models || []} temp={draft.tempAgents.some((a) => a.slug === m.slug)}
                tuning={draft.memberConfigs[m.slug]} onChange={(value) => tuneMember(m.slug, value)} />}
              <label className="team-member-role"><span>{t('teamProfile.role')}</span><textarea rows={2} aria-label={`${agent?.name || m.slug} ${t('teamProfile.role')}`} value={m.role} maxLength={500} placeholder={t('teamProfile.rolePlaceholder')} onChange={(e) => patch({ members: draft.members.map((v) => v.slug === m.slug ? { ...v, role: e.target.value } : v) })} /></label>
              <div className="team-member-actions">
                <button disabled={index === 0} aria-label={t('teamProfile.moveUp')} title={t('teamProfile.moveUp')} onClick={() => patch({ members: moveTeamMember(draft.members, m.slug, -1) })}><ArrowUp size={13} /></button>
                <button disabled={index === draft.members.length - 1} aria-label={t('teamProfile.moveDown')} title={t('teamProfile.moveDown')} onClick={() => patch({ members: moveTeamMember(draft.members, m.slug, 1) })}><ArrowDown size={13} /></button>
                <button aria-label={t('teamProfile.remove')} title={t('teamProfile.remove')} onClick={() => patch({ members: draft.members.filter((v) => v.slug !== m.slug) })}><Trash2 size={13} /></button>
              </div>
            </article>
          })}</div>

          <p className="agent-profile-muted">{t('agentProfile.teamContext')}</p>
        </> : <div className="agent-config-fields team-config-fields"><ProfileTextEditor label={t('teamProfile.doc')} rows={12} value={draft.doc} maxLength={16384} placeholder={t('teamProfile.docPlaceholder')} onChange={(doc) => patch({ doc })} hint={t('teamProfile.docHint')} />
        </div>}
      </fieldset>
      <footer className={`agent-profile-save${dirty ? ' is-dirty' : ''}`}>
      {dirty && !valid && <p className="agent-profile-error" role="alert">{t(missing ? 'teamProfile.missingHint' : invalidTemp ? 'teamProfile.tempRequired' : !draft.name.trim() ? 'teamProfile.nameRequired' : 'teamProfile.minimum')}</p>}
      {error && <p className="agent-profile-error" role="alert">{error}</p>}{notice && <p className="agent-profile-muted" role="status">{notice}</p>}
      {dirty ? <><small>{t(config.teamSlug ? 'teamProfile.savedScope' : 'teamProfile.sessionScope')}</small><div><button className="btn" disabled={busy} onClick={() => { setDraft(source); setDirty(false); setError('') }}>{t('agentProfile.cancel')}</button><button className="btn primary" disabled={busy || !valid} onClick={() => void save()}>{busy && <Loader2 size={13} className="spin" />}{t(busy ? 'agentProfile.saving' : 'teamProfile.save')}</button></div></> : !notice && <small>{t(config.teamSlug ? 'teamProfile.savedScope' : 'teamProfile.sessionScope')}</small>}
      </footer>
    </div>
    {selected && <div className="team-member-heading"><button aria-label={t('teamProfile.back')} onClick={() => setSelected('')}><ArrowLeft size={14} />{t('teamProfile.back')}{dirty && <span className="team-draft-dot" title={t('teamProfile.unsaved')} />}</button><small>{draft.members.find((m) => m.slug === selected)?.role || t('teamProfile.rolePlaceholder')}</small></div>}
    {/* Keep visited profiles mounted so back-to-party navigation retains unsaved member edits. */}
    {opened.map((slug) => {
      const agent = agentFor(slug)
      if (!agent) return null
      const temp = draft.tempAgents.some((a) => a.slug === slug)
      return <div className="team-detail-pane" key={slug} hidden={selected !== slug} data-team-member-detail={slug}>{temp ? <TempMember agent={agent} onChange={(value) => patch({ tempAgents: draft.tempAgents.map((a) => a.slug === slug ? { ...a, ...value } : a) })} onBack={() => setSelected('')} /> : renderMember(agent, s.work?.[slug]?.sessionId)}</div>
    })}
  </section>
}

/** 成员卡上的会话级调档:模型 + Effort 各一个控件,留空 = 沿用该成员自己的设置(saved)或会话模型(临时成员)。
 *  真值来源分两处:已存成员在 draft.memberConfigs(本会话),临时成员就在它的定义里 —— 由 temp 决定读哪边,写点统一在 tuneMember。 */
function MemberTuning({ agent, models, temp, tuning, onChange }: {
  agent: NormalAgentDef
  models: ModelInfo[]
  temp: boolean
  tuning?: MemberTuning
  onChange: (value: { model?: string; thinkingLevel?: ThinkingLevel | '' }) => void
}) {
  const { t } = useI18n()
  const model = (temp ? agent.model : tuning?.model) || ''
  const level = (temp ? agent.thinkingLevel : tuning?.thinkingLevel) || ''
  // 沿用的是谁:已存成员留空 = 用它自己的设置;临时成员的定义就是这里,留空 = 会话模型 / 引擎缺省档。
  const inherited = temp ? { model: '', level: '' } : { model: agent.model || '', level: agent.thinkingLevel || '' }
  // 两格都窄:前缀用短的「默认」,别用整句 —— 模型那格会省略号吃掉名字,Effort 那格(原生 select)直接硬截。
  const follow = (value: string) => value ? `${t('teamProfile.tuneDefault')} · ${value}` : t('teamProfile.tuneModelDefault')
  return <div className="team-member-tuning">
    <span className="team-member-tuning-k" title={t('teamProfile.tuneHint')}>{t('teamProfile.tuneScope')}</span>
    <ModelSelect
      models={models.filter((m) => (m.modelType || 'llm') === 'llm')}
      value={model}
      onChange={(id) => onChange({ model: id })}
      defaultLabel={inherited.model ? follow(models.find((m) => m.id === inherited.model)?.name || inherited.model) : t('teamProfile.tuneModelDefault')}
      ariaLabel={`${agent.name} ${t('teamProfile.tuneModel')}`}
    />
    <select className="team-member-effort" aria-label={`${agent.name} ${t('teamProfile.tuneEffort')}`} value={level} onChange={(e) => onChange({ thinkingLevel: e.target.value as ThinkingLevel | '' })}>
      <option value="">{inherited.level ? `${t('teamProfile.tuneDefault')} · ${t(`input.thinkingShort.${inherited.level}`)}` : t('teamProfile.tuneDefault')}</option>
      {THINKING_LEVELS.map((lv) => <option key={lv} value={lv}>{t(`input.thinkingShort.${lv}`)}</option>)}
    </select>
  </div>
}

/** Temporary members are session definitions; expose only fields the engine accepts for them. */
function TempMember({ agent, onChange, onBack }: { agent: NormalAgentDef; onChange: (patch: Partial<NormalAgentDef>) => void; onBack: () => void }) {
  const { t } = useI18n()
  const models = useApp((s) => s.modelsResp?.models)
  return <div className="team-temp-member"><header className="agent-character-hero"><div className="agent-portrait small"><Bot size={24} /></div><h2>{agent.name}</h2></header><p className="agent-profile-muted">{t('teamProfile.tempScope')}</p><div className="agent-config-fields">
    {(['name', 'description'] as const).map((key) => <label className="agent-field" key={key}>{t(`agentProfile.${key}`)}<input value={agent[key]} maxLength={key === 'name' ? 120 : key === 'description' ? 300 : undefined} onChange={(e) => onChange({ [key]: e.target.value })} /></label>)}
    <ProfileModelField models={models || []} value={agent.model} label={t('agentProfile.model')} onChange={(model) => onChange({ model })} />
    <label className="agent-field">{t('agentProfile.thinking')}<select aria-label={t('agentProfile.thinking')} value={agent.thinkingLevel} onChange={(e) => onChange({ thinkingLevel: e.target.value as NormalAgentDef['thinkingLevel'] })}><option value="">{t('agentProfile.default')}</option>{THINKING_LEVELS.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
    <label className="agent-field">{t('agentProfile.approval')}<select aria-label={t('agentProfile.approval')} value={agent.approvalMode} onChange={(e) => onChange({ approvalMode: e.target.value as NormalAgentDef['approvalMode'] })}>{[['', 'default'], ['readonly', 'readonly'], ['auto-edit', 'autoEdit'], ['full-auto', 'fullAuto'], ['custom', 'custom']].map(([v, k]) => <option key={v} value={v}>{t(`agentProfile.${k}`)}</option>)}</select></label>
    <label className="agent-field">{t('agentProfile.maxIterations')}<input type="number" min={1} max={200} value={agent.maxIterations ?? ''} onChange={(e) => onChange({ maxIterations: e.target.value ? Math.min(200, Math.max(1, Math.floor(Number(e.target.value)))) : null })} /></label>
    <ProfileTextEditor label={t('agentProfile.prompt')} rows={8} value={agent.systemPrompt} maxLength={100000} onChange={(systemPrompt) => onChange({ systemPrompt })} />
    <button onClick={onBack}>{t('teamProfile.backToSave')}</button>
  </div></div>
}
