/**
 * 轨道侧栏(新档位 `orbits`)—— 方案 `docs/ToBeImproved/新工作区与轨道体系_方案_2026-09-16.md` §3。
 *
 * 轨道只有两种:**项目轨道**(可展开会话)与 **Agent 轨道**(私聊 / 持久团队,以自己的 Library 为工作区)。
 * 团队与主动式是**运行模式**,不是第三、第四种轨道。本视图把三种**行形状**混排在 40px 一级行里:
 *   ① 私聊行(Agent 轨道)② 团队行(Agent 轨道,P5c 才落地)③ 项目行(项目轨道,整段复用 SidebarPane)。
 *
 * 三源分别取数、**不给 `WorkspaceDescriptor.kind` 加成员**(§D15:20+ 消费点全无穷举检查,加成员 tsc 零报错
 * 而行为异构漂移)。胶囊(Chat/Work)与本地/云端侧过滤只喂 project 源:Chat 恒 sandbox + 抹 agentSlug,
 * 与 Agent 轨道互斥;云端侧是 host-only,故 Agent 轨道块在这两种情况下整块隐藏(§3.5)。
 *
 * 样式全在 `chat2/orbits.css`(`.t2o-` 前缀,不改 `sidebar2.css` 本体);几何见该文件头注。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { MoreHorizontal, Pencil, Plus, SquarePen, UserPlus, Users, UsersRound, FolderPlus, MessageSquarePlus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { OverlayAt, setActiveSpace, useSpaceStore } from '@lcl/engine'
import { SidebarPane } from './chat2/SidebarPane'
import { EngineIcon } from '../components/EngineIcon'
import { useApp } from '../stores/appStore'
import { openSpecial } from './SpecialViews'
import { openNewChat, openSession, openSolo, openTeam, rotateSolo } from '../sessionNav'
import { AvatarStack } from '../components/AvatarStack'
import { TeamEditor } from '../components/TeamEditor'
import * as api from '../services/backendService'
import { usePageStore } from '../amadeus/store/pageStore'
import { currentPlatform } from '../services/agentRunService'
import { effectiveSessionMode, sessionsInMode, workspacesInMode } from './sessionMode'
import { registerMessages, useI18n } from '../i18n'
import type { SessionRecord, TeamDef } from '../types'
import './chat2/orbits.css'

registerMessages({
  'orbits.plus.tip': { zh: '新建', en: 'New' },
  'orbits.plus.agent': { zh: '新建 Agent', en: 'New agent' },
  'orbits.plus.team': { zh: '新建团队', en: 'New team' },
  'orbits.plus.teamSoon': { zh: '团队功能随后到来', en: 'Teams are coming soon' },
  'orbits.plus.project': { zh: '新建项目', en: 'New project' },
  'orbits.row.menu': { zh: '更多', en: 'More' },
  'orbits.row.newSession': { zh: '新会话', en: 'New session' },
  'orbits.row.newSessionMemory': { zh: '新会话(先总结记忆)', en: 'New session (summarize memory first)' },
  'orbits.row.editTeam': { zh: '编辑团队', en: 'Edit team' },
  'orbits.row.deleteTeam': { zh: '删除团队', en: 'Delete team' },
  'orbits.team.deleted': { zh: '团队已删除(历史会话保留)', en: 'Team deleted (past sessions are kept)' },
  'orbits.row.editAgent': { zh: '编辑 Agent', en: 'Edit agent' },
  'orbits.badge.running': { zh: '运行中', en: 'Running' },
  'orbits.badge.proactive': { zh: '主动式', en: 'Proactive' },
  'orbits.engine.needsSignin': { zh: '待登录', en: 'Needs sign-in' },
  'orbits.muse.unavailable': { zh: 'Muse 空间尚未启用', en: 'The Muse space is not enabled' },
})

/** 与 appStore 的 `groupColor` 同算法(那份是模块私有,不导出 → 这里按值复刻,别改算法:
 *  同一个 slug 在群聊发言人徽章与私聊头像底色上必须是同一个色相)。 */
function slugTint(slug: string): string {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 62% 45%)`
}

/** 首字:按码点取(emoji / 代理对不能用 `[0]`)。 */
function firstChar(text: string): string {
  return ([...text][0] || '?').toUpperCase()
}

interface MenuAt { x: number; y: number }
interface RowMenu extends MenuAt { kind: 'agent' | 'engine' | 'team'; slug: string }

/** 把按钮的矩形换成菜单锚点(贴左下角,留 4px 缝)。 */
function anchorOf(e: React.MouseEvent | React.KeyboardEvent): MenuAt {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: r.left, y: r.bottom + 4 }
}

/** sideFilter(工作区 view 左栏胶囊):与 SessionsView 逐字同义 —— cloud=只看云端、local=只看本地、
 *  undefined=不过滤。Agent 轨道是 host-only,cloud 侧整块不列。 */
export function OrbitsView({ sideFilter }: { sideFilter?: 'local' | 'cloud' } = {}) {
  const { t } = useI18n()
  // ⚠️ 这段 store 映射照抄 SessionsView(同一批 props 要原样喂给 SidebarPane);只多取 Agent 轨道那几项。
  const s = useApp(useShallow((state) => ({
    runningBySession: state.runningBySession,
    sessions: state.sessions,
    archivedSessions: state.archivedSessions,
    activeId: state.activeId,
    unread: state.unread,
    cfg: state.cfg,
    modelsResp: state.modelsResp,
    setActiveId: state.setActiveId,
    setNewChatWs: state.setNewChatWs,
    setNewChatCfg: state.setNewChatCfg,
    setNewChatModel: state.setNewChatModel,
    openSettings: state.openSettings,
    workspaces: state.workspaces,
    createInWorkspace: state.createInWorkspace,
    addLocalWorkspace: state.addLocalWorkspace,
    renameWorkspace: state.renameWorkspace,
    removeWorkspace: state.removeWorkspace,
    renameSession: state.renameSession,
    archiveSession: state.archiveSession,
    deleteSession: state.deleteSession,
    toast: state.toast,
    connect: state.connect,
    activeWorkspaceKey: state.activeWorkspaceKey,
    setActiveWorkspaceKey: state.setActiveWorkspaceKey,
    sessionMode: state.sessionMode,
    setSessionMode: state.setSessionMode,
    // Agent 轨道三源
    agentDefs: state.agentDefs,
    agentAvatars: state.agentAvatars,
    engines: state.engines,
    configBySession: state.configBySession,
    teams: state.teams,
    refreshTeams: state.refreshTeams,
  })))
  // 旧的持久化快照 / 未刷新前可能没有 teams:按空表渲染,不让一个 undefined 把整块侧栏交给 ErrorBoundary。
  const teams = Array.isArray(s.teams) ? s.teams : []
  const [teamEditor, setTeamEditor] = useState<{ team: TeamDef | null } | null>(null)
  useEffect(() => { void s.refreshTeams() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const runningIds = useMemo(() => new Set(Object.keys(s.runningBySession)), [s.runningBySession])
  const activeSession = s.sessions.find((x) => x.id === s.activeId) || s.archivedSessions.find((x) => x.id === s.activeId) || null
  const amadeusRoot = usePageStore((state) => state.vaultRoot)
  const [plusMenu, setPlusMenu] = useState<MenuAt | null>(null)
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null)

  // Chat/Work 胶囊与「模式跟着打开的会话走(只有一个方向)」的 effect 与 SessionsView 逐字一致 ——
  // 换个侧栏档位不该换这条行为,否则同一个会话在两档里高亮不一样。
  const mode = effectiveSessionMode(s.sessionMode, currentPlatform())
  useEffect(() => {
    if (mode === 'chat' && activeSession && !activeSession.projectless) s.setSessionMode('work')
  }, [activeSession?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!plusMenu && !rowMenu) return
    const close = (): void => { setPlusMenu(null); setRowMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [plusMenu, rowMenu])

  // 侧过滤:会话的云/本地归属 = project_path 有无(appStore 同判据);工作区按 kind。
  const inSide = (p: string | null | undefined): boolean => (sideFilter === 'cloud' ? !p : !!p)
  const sideOf = sideFilter ? (x: { project_path?: string | null }) => inSide(x.project_path) : undefined
  /** Agent 轨道的会话(私聊 / 独立团队)不属于任何项目 —— 不剔掉的话 `projectless:true` 会把它们
   *  落进「不在项目中工作」组(§3.5)。未打开过的会话也判得出:refreshSessions 已用列表行自带的
   *  agent_config 预填 configBySession。 */
  const inOrbit = (x: SessionRecord): boolean => {
    const c = s.configBySession[x.id]
    return !!(c?.soloAgentSlug || c?.soloEngineId || c?.teamSlug)
  }
  const sessions = useMemo(() => sessionsInMode(s.sessions, mode, sideOf).filter((x) => !inOrbit(x)), [s.sessions, s.configBySession, sideFilter, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const archivedSessions = useMemo(() => sessionsInMode(s.archivedSessions, mode, sideOf).filter((x) => !inOrbit(x)), [s.archivedSessions, s.configBySession, sideFilter, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const workspaces = useMemo(() => {
    const all = s.workspaces()
    const sideKeep = sideFilter ? (w: (typeof all)[number]) => (sideFilter === 'cloud' ? w.kind === 'cloud' || w.kind === 'rootless' : w.kind !== 'cloud' && w.kind !== 'rootless') : undefined
    return workspacesInMode(all, mode, sideKeep)
  }, [s, sideFilter, amadeusRoot, mode])

  // ── Agent 轨道 ───────────────────────────────────────────────────────────
  // 本地 agent:排除 createdBy:'system'(historian 之类的内建),但 Muse 例外 —— 它有自己的一行。
  // 顺序照 agentDefs 已有的顺序(= agents/.meta.json 的 order),不在这里另排一遍。
  const agents = useMemo(() => s.agentDefs.filter((a) => a.createdBy !== 'system' || a.slug === 'muse'), [s.agentDefs])
  const installedEngines = useMemo(() => s.engines.filter((e) => e.status !== 'not-installed'), [s.engines])
  /** 有活跃 run 的私聊 agent(按运行中的 run 反查,O(running) 不是 O(会话×agent))。 */
  const runningSolo = useMemo(() => {
    const out = new Set<string>()
    for (const id of Object.keys(s.runningBySession)) {
      const slug = s.configBySession[id]?.soloAgentSlug
      if (slug) out.add(slug)
    }
    return out
  }, [s.runningBySession, s.configBySession])
  // 高亮源 = 当前会话的轨道身份,不另造通道(§3.2)。
  const activeCfg = s.activeId ? s.configBySession[s.activeId] : undefined
  const activeSpaceId = useSpaceStore((st) => st.activeSpaceId)
  const hasMuseSpace = useSpaceStore((st) => st.spaces.some((x) => x.id === 'muse'))
  // Chat 档与云端侧都与 Agent 轨道互斥(§3.5):整块隐藏,不是列出来再置灰。
  const showOrbitBlock = mode !== 'chat' && sideFilter !== 'cloud' && (agents.length > 0 || installedEngines.length > 0 || teams.length > 0)

  const openMuse = (): void => {
    // ⚠️ Muse Space 只在 museAvailable() && 内建插件启用时注册;未注册就切等于点了个死按钮,如实告诉用户。
    if (!hasMuseSpace) { s.toast(t('orbits.muse.unavailable'), true); return }
    setActiveSpace('muse')
  }

  /** 项目下「团队模式」的二级会话行:只换前导图标,26.797px 行高与排版一个像素都不动(§3.5)。 */
  const teamIcon = (x: SessionRecord): React.ReactNode =>
    (s.configBySession[x.id]?.groupChat ? <Users className="t2s-lead-icon t2s-dim" /> : null)

  const agentRow = (slug: string, name: string): React.ReactElement => {
    const url = s.agentAvatars[slug]
    const isMuse = slug === 'muse'
    const active = isMuse ? activeSpaceId === 'muse' : activeCfg?.soloAgentSlug === slug
    const tint = slugTint(slug)
    return (
      <button
        key={`agent:${slug}`}
        type="button"
        className={`t2o-row${active ? ' active' : ''}`}
        title={name}
        onClick={() => { isMuse ? openMuse() : openSolo('agent', slug) }}
      >
        <span className="t2o-lead">
          {url
            ? <img className="t2o-avatar" src={url} width={30} height={30} alt="" draggable={false} />
            : (
              <span
                className="t2o-avatar t2o-avatar-text"
                style={{ background: `color-mix(in srgb, ${tint} 18%, transparent)`, color: tint }}
              >{firstChar(name || slug)}</span>
            )}
          {runningSolo.has(slug) && <span className="t2s-dot running" title={t('orbits.badge.running')} />}
          {isMuse && <span className="t2s-dot proactive" title={t('orbits.badge.proactive')} />}
        </span>
        <span className="t2o-name">{name || slug}</span>
        <span
          className="t2o-tail"
          role="button"
          tabIndex={0}
          aria-label={t('orbits.row.menu')}
          title={t('orbits.row.menu')}
          onClick={(e) => { e.stopPropagation(); setPlusMenu(null); setRowMenu({ ...anchorOf(e), kind: 'agent', slug }) }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault(); e.stopPropagation(); setPlusMenu(null); setRowMenu({ ...anchorOf(e), kind: 'agent', slug })
          }}
        ><MoreHorizontal size={14} /></span>
      </button>
    )
  }

  return (
    <div className="t2o">
      {/* ① 新对话 + Chat/Work 胶囊 + 「+」操作菜单(§3.6)。SidebarPane 的 showSpecial 关掉,这行自己画。 */}
      <div className="t2o-head">
        <div className="t2s-special-group">
          <div className="t2s-special-row">
            {/* 尺寸由 `.t2o .t2s-special-ic > svg` 的 --t2s-icon 接管,故不传 size(传了也无效)。 */}
            <button type="button" className="t2s-special" onClick={() => openNewChat()}>
              <span className="t2s-special-ic"><SquarePen /></span>
              <span className="t2s-special-title">{t('sidebar.newChat')}</span>
            </button>
            <div className="t2s-vaultseg t2s-mode" role="tablist" aria-label={t('sidebar.mode.tip')} title={t('sidebar.mode.tip')}>
              <div className="t2s-vaultseg-thumb" data-side={mode} />
              {(['chat', 'work'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  data-mode={m}
                  className={mode === m ? 'on' : undefined}
                  onClick={() => {
                    // 开着 work 会话点 Chat:列表只剩 chat,主区那个 work 会话就没有对应行了 → 顺手开一个新对话。
                    s.setSessionMode(m)
                    if (m === 'chat' && activeSession && !activeSession.projectless) openNewChat()
                  }}
                >{t(m === 'chat' ? 'sidebar.mode.chat' : 'sidebar.mode.work')}</button>
              ))}
            </div>
            <button
              type="button"
              className="t2o-plus"
              aria-label={t('orbits.plus.tip')}
              title={t('orbits.plus.tip')}
              onClick={(e) => { e.stopPropagation(); setRowMenu(null); setPlusMenu(anchorOf(e)) }}
            ><Plus size={14} /></button>
          </div>
        </div>
      </div>

      {/* ② Agent 轨道:私聊行(本地 agent)→ 外部引擎行 →(P5c)团队行。 */}
      {showOrbitBlock && (
        <div className="t2o-agents">
          {agents.map((a) => agentRow(a.slug, a.name))}
          {installedEngines.map((e) => (
            <button
              key={`engine:${e.id}`}
              type="button"
              className={`t2o-row${activeCfg?.soloEngineId === e.id ? ' active' : ''}`}
              title={e.name || e.id}
              onClick={() => openSolo('engine', e.id)}
            >
              <span className="t2o-lead t2o-lead-box"><EngineIcon engineId={e.id} size={16} /></span>
              <span className="t2o-name">{e.name || e.id}</span>
              {e.status === 'needs-signin' && <span className="t2o-badge">{t('orbits.engine.needsSignin')}</span>}
              <span
                className="t2o-tail"
                role="button"
                tabIndex={0}
                aria-label={t('orbits.row.menu')}
                title={t('orbits.row.menu')}
                onClick={(ev) => { ev.stopPropagation(); setPlusMenu(null); setRowMenu({ ...anchorOf(ev), kind: 'engine', slug: e.id }) }}
                onKeyDown={(ev) => {
                  if (ev.key !== 'Enter' && ev.key !== ' ') return
                  ev.preventDefault(); ev.stopPropagation(); setPlusMenu(null); setRowMenu({ ...anchorOf(ev), kind: 'engine', slug: e.id })
                }}
              ><MoreHorizontal size={14} /></span>
            </button>
          ))}
          {/* 团队行(Agent 轨道的持久团队,P5c):组合头像;点击直入该团队最新会话,不内联展开(§3.4);顺序 = teams/.meta.json。 */}
          {teams.map((tm) => (
            <button
              key={`team:${tm.slug}`}
              type="button"
              className={`t2o-row${activeCfg?.teamSlug === tm.slug ? ' active' : ''}`}
              title={tm.name}
              onClick={() => openTeam(tm.slug)}
            >
              <span className="t2o-lead">
                <AvatarStack
                  items={tm.members.map((m) => ({ slug: m.slug, name: s.agentDefs.find((a) => a.slug === m.slug)?.name || m.slug, avatarUrl: s.agentAvatars[m.slug], ...(tm.avatar ? { emoji: tm.avatar } : {}) }))}
                  size={30}
                />
              </span>
              <span className="t2o-name">{tm.name}</span>
              <span
                className="t2o-tail"
                role="button"
                tabIndex={0}
                aria-label={t('orbits.row.menu')}
                title={t('orbits.row.menu')}
                onClick={(ev) => { ev.stopPropagation(); setPlusMenu(null); setRowMenu({ ...anchorOf(ev), kind: 'team', slug: tm.slug }) }}
                onKeyDown={(ev) => {
                  if (ev.key !== 'Enter' && ev.key !== ' ') return
                  ev.preventDefault(); ev.stopPropagation(); setPlusMenu(null); setRowMenu({ ...anchorOf(ev), kind: 'team', slug: tm.slug })
                }}
              ><MoreHorizontal size={14} /></span>
            </button>
          ))}
        </div>
      )}

      {/* ③ 项目轨道:整段复用 SidebarPane(折叠持久化 / 组拖拽 / 多选 / 右键菜单全白拿)。 */}
      <div className="t2o-projects">
        <SidebarPane
          collapsed={false}
          sessions={sessions}
          archivedSessions={archivedSessions}
          // 右键菜单/拖拽/计数仍要拿未经过模式与侧过滤的全集;会话查找统一走全局快速查找(⌘P)。
          allSessions={s.sessions}
          allArchived={s.archivedSessions}
          activeId={s.activeId}
          runningIds={runningIds}
          unreadIds={s.unread}
          cfg={s.cfg}
          modelId={activeSession?.model_id || s.cfg.modelId || s.modelsResp?.defaultModelId || ''}
          activeSession={activeSession}
          onSelect={(id, o) => openSession(id, o)}
          // 「新对话」行由 .t2o-head 自己画(要挂胶囊与「+」菜单),这里关掉免得画两份。
          showSpecial={false}
          onNewChat={() => openNewChat()}
          mode={mode}
          onModeChange={(m) => { s.setSessionMode(m); if (m === 'chat' && activeSession && !activeSession.projectless) openNewChat() }}
          flat={mode === 'chat'}
          rowIcon={teamIcon}
          onOpenWorkspace={(wsKey) => openSpecial('workspace', wsKey)}
          workspaces={workspaces}
          onNewInWorkspace={(ws) => void s.createInWorkspace(ws)}
          onAddWorkspace={() => void s.addLocalWorkspace()}
          onRenameWorkspace={(ws, name) => void s.renameWorkspace(ws, name)}
          onRemoveWorkspace={(ws) => void s.removeWorkspace(ws)}
          onRename={(id, title) => void s.renameSession(id, title)}
          onArchive={(id, a) => void s.archiveSession(id, a)}
          onDelete={(id) => void s.deleteSession(id)}
          onOpenSettings={() => s.openSettings()}
          onToast={s.toast}
          onAuthChange={() => { setTimeout(() => void s.connect(s.cfg), 1500) }}
          activeWorkspaceKey={s.activeWorkspaceKey}
          onEnterWorkspace={(key) => s.setActiveWorkspaceKey(key)}
        />
      </div>

      {plusMenu && (
        <OverlayAt className="ctx-menu" x={plusMenu.x} y={plusMenu.y} onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => { setPlusMenu(null); s.openSettings('agents') }}>
            <UserPlus size={13} /> {t('orbits.plus.agent')}
          </button>
          {/* 独立团队实体落在 P5c;先置灰占住入口,别让用户以为没这回事(§3.6)。 */}
          <button type="button" onClick={() => { setPlusMenu(null); setTeamEditor({ team: null }) }}>
            <UsersRound size={13} /> {t('orbits.plus.team')}
          </button>
          <button type="button" onClick={() => { setPlusMenu(null); void s.addLocalWorkspace() }}>
            <FolderPlus size={13} /> {t('orbits.plus.project')}
          </button>
        </OverlayAt>
      )}

      {rowMenu && (
        <OverlayAt className="ctx-menu" x={rowMenu.x} y={rowMenu.y} onClick={(e) => e.stopPropagation()}>
          {rowMenu.kind === 'agent' && (
            <>
              {/* 「新会话(先总结记忆)」= rotate 端点:归档旧私聊 + 建新,后台采记忆(§5.3)。 */}
              <button type="button" onClick={() => { const slug = rowMenu.slug; setRowMenu(null); rotateSolo('agent', slug) }}>
                <MessageSquarePlus size={13} /> {t('orbits.row.newSessionMemory')}
              </button>
              <button type="button" onClick={() => { setRowMenu(null); s.openSettings('agents') }}>
                <Pencil size={13} /> {t('orbits.row.editAgent')}
              </button>
            </>
          )}
          {rowMenu.kind === 'engine' && (
            <button type="button" onClick={() => { const id = rowMenu.slug; setRowMenu(null); rotateSolo('engine', id) }}>
              <MessageSquarePlus size={13} /> {t('orbits.row.newSession')}
            </button>
          )}
          {rowMenu.kind === 'team' && (
            <>
              <button type="button" onClick={() => { const tm = teams.find((x) => x.slug === rowMenu.slug) || null; setRowMenu(null); setTeamEditor({ team: tm }) }}>
                <Pencil size={13} /> {t('orbits.row.editTeam')}
              </button>
              <button type="button" onClick={() => {
                const slug = rowMenu.slug; setRowMenu(null)
                void api.deleteTeam(s.cfg, slug).then(() => s.refreshTeams()).then(() => s.toast(t('orbits.team.deleted'))).catch((e: any) => s.toast(e?.message || String(e), true))
              }}>
                <UsersRound size={13} /> {t('orbits.row.deleteTeam')}
              </button>
            </>
          )}
        </OverlayAt>
      )}
      {teamEditor && (
        <TeamEditor
          agents={s.agentDefs}
          team={teamEditor.team}
          onClose={() => setTeamEditor(null)}
          onSaved={(saved) => { const isNew = !teamEditor.team; setTeamEditor(null); if (isNew) openTeam(saved.slug) }}
        />
      )}
    </div>
  )
}
