/**
 * 轨道状态条(方案 §5.1 私聊 / §6.3 团队;贴主视图纸卡顶部,层 3,不描边):
 *   私聊(soloAgentSlug / soloEngineId):头像 + 名字 + 「工作区 = Library · 历史会话仅 Agent 可读」+ 「新会话(先总结记忆)」+ 「拉起群聊」(Agent 私聊才有,P5d)
 *   团队模式(项目轨道 groupChat)/ 独立团队(teamSlug):名称 + 「{n} 人 · 会议/协作」+ 成员头像 + 芯片「拉人」「会议⇄协作」+「退出团队模式」(独立团队没有:它就是团队)
 * 非轨道会话不渲染。拉人复用 GroupChatSetup;成员变更后显示一行提示「{names} 加入 · 此前对话已摘要给成员」(引擎 groupSeedHistory 缺省开)。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { UserPlus, LogOut, Repeat, MessageSquarePlus, UsersRound } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { openSession, rotateSolo } from '../../sessionNav'
import { GroupChatSetup } from '../../components/GroupChatSetup'
import { TeamEditor } from '../../components/TeamEditor'
import { EngineIcon } from '../../components/EngineIcon'
import type { AgentConfig } from '../../types'

registerMessages({
  'orbit.bar.solo': { zh: '私聊 · 工作区 = {name} 的 Library · 历史会话仅 Agent 可读', en: 'Direct · workspace = {name}’s Library · past sessions are readable by the agent only' },
  'orbit.bar.soloEngine': { zh: '私聊 · 工作区 = {name} 的 Library', en: 'Direct · workspace = {name}’s Library' },
  'orbit.bar.newSession': { zh: '新会话(先总结记忆)', en: 'New session (summarize memory first)' },
  'orbit.bar.newSessionEngine': { zh: '新会话', en: 'New session' },
  'orbit.bar.raiseTeam': { zh: '拉起群聊', en: 'Start a team' },
  'orbit.bar.teamCreated': { zh: '已建立团队 {name},对话在新标签继续', en: 'Team {name} created — the conversation continues in a new tab' },
  'orbit.bar.teamMode': { zh: '团队模式', en: 'Team mode' },
  'orbit.bar.members': { zh: '{n} 人', en: '{n} members' },
  'orbit.bar.meeting': { zh: '会议', en: 'Meeting' },
  'orbit.bar.collab': { zh: '协作', en: 'Collab' },
  'orbit.bar.addPeople': { zh: '拉人', en: 'Add people' },
  'orbit.bar.exit': { zh: '退出团队模式', en: 'Exit team mode' },
  'orbit.bar.switchToCollab': { zh: '切到协作', en: 'Switch to collab' },
  'orbit.bar.switchToMeeting': { zh: '切到会议', en: 'Switch to meeting' },
  'orbit.bar.joined': { zh: '{names} 加入 · 此前对话已摘要给成员', en: '{names} joined · earlier conversation summarized for members' },
  'orbit.bar.exited': { zh: '已退出团队模式,由 {name} 继续', en: 'Left team mode; {name} continues' },
})

export function OrbitBar({ sessionId, cfg, running }: { sessionId: string; cfg: AgentConfig; running: boolean }): React.ReactElement | null {
  const { t } = useI18n()
  const s = useApp(useShallow((st) => ({
    agentDefs: st.agentDefs, agentAvatars: st.agentAvatars, engines: st.engines, teams: st.teams, defaultAgentSlug: st.defaultAgentSlug,
    modelsResp: st.modelsResp, setSessionGroup: st.setSessionGroup, ensureTeamSession: st.ensureTeamSession, setSeedOnce: st.setSeedOnce, toast: st.toast,
  })))
  const [setupOpen, setSetupOpen] = useState(false)
  const [teamEditor, setTeamEditor] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { setNote(null) }, [sessionId])
  useEffect(() => { if (running) setNote(null) }, [running])

  const nameOf = (slug: string): string => s.agentDefs.find((a) => a.slug === slug)?.name || slug
  const soloAgent = cfg.soloAgentSlug ? s.agentDefs.find((a) => a.slug === cfg.soloAgentSlug) : null
  const soloEngine = cfg.soloEngineId ? s.engines.find((e) => e.id === cfg.soloEngineId) : null
  const team = cfg.teamSlug ? (Array.isArray(s.teams) ? s.teams : []).find((x) => x.slug === cfg.teamSlug) || null : null
  const members = useMemo(() => (Array.isArray(cfg.groupAgents) ? cfg.groupAgents : []), [cfg.groupAgents])
  const inTeamMode = !!cfg.groupChat && members.length >= 2

  if (cfg.soloAgentSlug || cfg.soloEngineId) {
    const kind: 'agent' | 'engine' = cfg.soloAgentSlug ? 'agent' : 'engine'
    const id = (cfg.soloAgentSlug || cfg.soloEngineId)!
    const name = kind === 'agent' ? (soloAgent?.name || id) : (soloEngine?.name || id)
    const url = kind === 'agent' ? s.agentAvatars[id] : undefined
    return (
      <div className="t2o-bar" role="status" data-orbit="solo">
        <span className="t2o-bar-lead">
          {kind === 'engine' ? <EngineIcon engineId={id} size={16} /> : url ? <img src={url} width={18} height={18} alt="" className="t2o-bar-avatar" /> : <span className="t2o-bar-avatar t2o-bar-avatar-text">{[...name][0] || '?'}</span>}
        </span>
        <span className="t2o-bar-title">{name}</span>
        <span className="t2o-bar-sub">{t(kind === 'agent' ? 'orbit.bar.solo' : 'orbit.bar.soloEngine', { name })}</span>
        <span className="t2o-bar-acts">
          {kind === 'agent' && (
            <button type="button" className="t2o-bar-chip" onClick={() => setTeamEditor(true)} title={t('orbit.bar.raiseTeam')}><UsersRound size={12} /> {t('orbit.bar.raiseTeam')}</button>
          )}
          <button type="button" className="t2o-bar-chip" disabled={running} onClick={() => rotateSolo(kind, id)} title={t(kind === 'agent' ? 'orbit.bar.newSession' : 'orbit.bar.newSessionEngine')}>
            <MessageSquarePlus size={12} /> {t(kind === 'agent' ? 'orbit.bar.newSession' : 'orbit.bar.newSessionEngine')}
          </button>
        </span>
        {teamEditor && kind === 'agent' && (
          <TeamEditor
            agents={s.agentDefs}
            team={null}
            initialMembers={[id]}
            onClose={() => setTeamEditor(false)}
            onSaved={(saved) => {
              setTeamEditor(false)
              // 拍板 ⑬:团队首会话的第一次发送带私聊会话 id 作播种源(引擎 compact 后注入),私聊本身不动、不变成团队。
              void s.ensureTeamSession(saved.slug).then((sess) => {
                if (!sess) return
                s.setSeedOnce(sess.id, sessionId)
                s.toast(t('orbit.bar.teamCreated', { name: saved.name }))
                openSession(sess.id, { newTab: true })
              })
            }}
          />
        )}
      </div>
    )
  }

  if (!inTeamMode && !team) return null
  const mode: 'meeting' | 'collab' = cfg.teamMode === 'collab' ? 'collab' : 'meeting'
  const title = team ? team.name : t('orbit.bar.teamMode')
  return (
    <div className="t2o-bar" role="status" data-orbit={team ? 'team' : 'teammode'}>
      <span className="t2o-bar-title">{title}</span>
      <span className="t2o-bar-sub">{t('orbit.bar.members', { n: members.length })} · {t(mode === 'collab' ? 'orbit.bar.collab' : 'orbit.bar.meeting')}</span>
      <span className="t2o-bar-avatars">
        {members.slice(0, 6).map((slug) => {
          const url = s.agentAvatars[slug]
          return url
            ? <img key={slug} src={url} width={18} height={18} alt="" title={nameOf(slug)} className="t2o-bar-avatar" />
            : <span key={slug} className="t2o-bar-avatar t2o-bar-avatar-text" title={nameOf(slug)}>{[...nameOf(slug)][0] || '?'}</span>
        })}
      </span>
      <span className="t2o-bar-acts">
        <button type="button" className="t2o-bar-chip" disabled={running} onClick={() => setSetupOpen(true)}><UserPlus size={12} /> {t('orbit.bar.addPeople')}</button>
        <button type="button" className="t2o-bar-chip" disabled={running} onClick={() => s.setSessionGroup({ teamMode: mode === 'collab' ? 'meeting' : 'collab' }, sessionId)}>
          <Repeat size={12} /> {t(mode === 'collab' ? 'orbit.bar.switchToMeeting' : 'orbit.bar.switchToCollab')}
        </button>
        {!team && (
          <button type="button" className="t2o-bar-chip" disabled={running} onClick={() => {
            // 拍板 ⑪:退出后由进入团队模式前的 Agent 接手(存值 agentSlug,setSessionGroup 不动它);开局即团队 → 全局默认 Agent。
            s.setSessionGroup({ groupChat: false }, sessionId)
            setNote(t('orbit.bar.exited', { name: nameOf(cfg.agentSlug || s.defaultAgentSlug || '') }))
          }}><LogOut size={12} /> {t('orbit.bar.exit')}</button>
        )}
      </span>
      {note && <span className="t2o-bar-note">{note}</span>}
      {setupOpen && (
        <GroupChatSetup
          agents={s.agentDefs}
          models={s.modelsResp?.models}
          initialAgents={members}
          initialTempAgents={cfg.groupTempAgents}
          initialIntensity={cfg.groupIntensity}
          initialRounds={cfg.groupMaxRounds}
          // 独立团队不能退出团队模式:不给「关闭群聊」按钮(active=false 时浮层不渲染它)。
          active={!team}
          onConfirm={(r) => {
            const added = r.groupAgents.filter((x) => !members.includes(x)).map(nameOf)
            s.setSessionGroup({ groupChat: true, ...r }, sessionId)
            setSetupOpen(false)
            if (added.length) setNote(t('orbit.bar.joined', { names: added.join('、') }))
          }}
          onDisable={() => { s.setSessionGroup({ groupChat: false }, sessionId); setSetupOpen(false) }}
          onClose={() => setSetupOpen(false)}
        />
      )}
    </div>
  )
}
