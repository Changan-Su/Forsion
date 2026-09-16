/**
 * 轨道状态条(方案 §5.1 私聊 / §6.3 团队;贴主视图纸卡顶部,层 3,不描边):
 *   私聊(soloAgentSlug / soloEngineId):头像 + 名字 + 「工作区 = Library · 历史会话仅 Agent 可读」+ 「新会话(先总结记忆)」+ 「拉起群聊」(Agent 私聊才有,P5d)
 *   团队模式(项目轨道 groupChat)/ 独立团队(teamSlug):名称 + 「{n} 人」+ 成员头像 + 芯片「拉人」+「退出团队模式」(独立团队没有:它就是团队)。
 *   09-16 起没有会议 / 协作之分,状态条上也没有模式切换。
 * 非轨道会话不渲染。拉人复用 GroupChatSetup;成员变更后显示一行提示「{names} 加入 · 此前对话已摘要给成员」(引擎 groupSeedHistory 缺省开)。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { UserPlus, LogOut, MessageSquarePlus, UsersRound } from 'lucide-react'
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
  'orbit.bar.addPeople': { zh: '拉人', en: 'Add people' },
  'orbit.bar.exit': { zh: '退出团队模式', en: 'Exit team mode' },
  'orbit.bar.joined': { zh: '{names} 加入 · 此前对话已摘要给成员', en: '{names} joined · earlier conversation summarized for members' },
  'orbit.bar.exited': { zh: '已退出团队模式,由 {name} 继续', en: 'Left team mode; {name} continues' },
  'orbit.bar.working': { zh: '{n} 人工作中', en: '{n} working' },
  'orbit.bar.waiting': { zh: '{name} 等待审批', en: '{name} waiting for approval' },
})

export function OrbitBar({ sessionId, cfg, running }: { sessionId: string; cfg: AgentConfig; running: boolean }): React.ReactElement | null {
  const { t } = useI18n()
  const s = useApp(useShallow((st) => ({
    agentDefs: st.agentDefs, agentAvatars: st.agentAvatars, engines: st.engines, teams: st.teams, defaultAgentSlug: st.defaultAgentSlug,
    modelsResp: st.modelsResp, setSessionGroup: st.setSessionGroup, ensureTeamSession: st.ensureTeamSession, setSeedOnce: st.setSeedOnce, toast: st.toast,
    teamWork: st.teamWorkBySession[sessionId],
  })))
  const [setupOpen, setSetupOpen] = useState(false)
  const [teamEditor, setTeamEditor] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { setNote(null) }, [sessionId])
  useEffect(() => { if (running) setNote(null) }, [running])

  const nameOf = (slug: string): string => s.agentDefs.find((a) => a.slug === slug)?.name || slug
  const soloAgent = cfg.soloAgentSlug ? s.agentDefs.find((a) => a.slug === cfg.soloAgentSlug) : null
  const soloEngine = cfg.soloEngineId ? s.engines.find((e) => e.id === cfg.soloEngineId) : null
  // 身份看锁定事实 teamSlug,不看 TeamDef 有没有加载到(列表未到 / 定义已删时仍是独立团队,不能露「退出团队模式」)。
  const isTeam = !!cfg.teamSlug
  const team = isTeam ? (Array.isArray(s.teams) ? s.teams : []).find((x) => x.slug === cfg.teamSlug) || null : null
  const [rotating, setRotating] = useState(false)
  const members = useMemo(() => (Array.isArray(cfg.groupAgents) ? cfg.groupAgents : []), [cfg.groupAgents])
  const inTeamMode = !!cfg.groupChat && members.length >= 2
  // 并行团队:工作中 / 等审批的成员在头像上高亮(状态条是移动端与折叠卡片时唯一能看到「谁在忙、谁在等你」的地方)。
  const waitingNames = members.filter((slug) => running && s.teamWork?.[slug]?.status === 'waiting').map(nameOf)
  const workingCount = members.filter((slug) => running && s.teamWork?.[slug]?.status === 'working').length

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
          <button type="button" className="t2o-bar-chip" disabled={running || rotating} onClick={() => { setRotating(true); void rotateSolo(kind, id).finally(() => setRotating(false)) }} title={t(kind === 'agent' ? 'orbit.bar.newSession' : 'orbit.bar.newSessionEngine')}>
            <MessageSquarePlus size={12} /> {t(kind === 'agent' ? 'orbit.bar.newSession' : 'orbit.bar.newSessionEngine')}
          </button>
        </span>
        {teamEditor && kind === 'agent' && (
          <TeamEditor
            agents={s.agentDefs.filter((a) => a.createdBy !== 'system' && !!a.libraryDir)}
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

  if (!inTeamMode && !isTeam) return null
  const title = isTeam ? (team?.name || cfg.teamSlug!) : t('orbit.bar.teamMode')
  return (
    <div className="t2o-bar" role="status" data-orbit={isTeam ? 'team' : 'teammode'}>
      <span className="t2o-bar-title">{title}</span>
      <span className="t2o-bar-sub">{t('orbit.bar.members', { n: members.length })}{workingCount ? ` · ${t('orbit.bar.working', { n: workingCount })}` : ''}{waitingNames.length ? ` · ${t('orbit.bar.waiting', { name: waitingNames.join('、') })}` : ''}</span>
      <span className="t2o-bar-avatars">
        {members.slice(0, 6).map((slug) => {
          const url = s.agentAvatars[slug]
          const st = running ? s.teamWork?.[slug]?.status : undefined
          const cls = `t2o-bar-avatar${st === 'working' ? ' is-working' : st === 'waiting' ? ' is-waiting' : ''}`
          return url
            ? <img key={slug} src={url} width={18} height={18} alt="" title={nameOf(slug)} className={cls} data-work={st === 'working' || st === 'waiting' ? st : undefined} />
            : <span key={slug} className={`${cls} t2o-bar-avatar-text`} title={nameOf(slug)} data-work={st === 'working' || st === 'waiting' ? st : undefined}>{[...nameOf(slug)][0] || '?'}</span>
        })}
      </span>
      <span className="t2o-bar-acts">
        <button type="button" className="t2o-bar-chip" disabled={running} onClick={() => setSetupOpen(true)}><UserPlus size={12} /> {t('orbit.bar.addPeople')}</button>
        {!isTeam && (
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
          // 独立团队不能退出团队模式:不给「关闭群聊」按钮(active=false 时浮层不渲染它)。
          active={!isTeam}
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
