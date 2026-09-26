/**
 * 轨道侧栏(新档位 `orbits`)—— 方案 `docs/ToBeImproved/新工作区与轨道体系_方案_2026-09-16.md` §3。
 *
 * 轨道只有两种:**项目轨道**(可展开会话)与 **Agent 轨道**(私聊 / 持久团队,以自己的 Library 为工作区)。
 * 团队与主动式是**运行模式**,不是第三、第四种轨道。本视图把三种**行形状**混排在 40px 一级行里:
 *   ① 私聊行(Agent 轨道)② 团队行(Agent 轨道)③ 项目行(项目轨道,整段复用 SidebarPane)。
 * **一个列表、按最近消息时间降序**(09-16 用户拍板:Agent / 团队 / 项目不分块,一起按最新消息排):私聊 / 引擎 / 团队行
 * 作为 `extraRows` 交给 SidebarPane 与项目组按 `at` 合成一个列表(orderBy='activity');从未有过会话的沉底,同时间戳保持名册序。
 *
 * 三源分别取数、**不给 `WorkspaceDescriptor.kind` 加成员**(§D15:20+ 消费点全无穷举检查,加成员 tsc 零报错
 * 而行为异构漂移)。工作区固定 Work,胶囊只筛选 All / Agent / Team / Project;Agent 轨道为 host-only,
 * 云端侧不列 Agent 轨道行(§3.5)。
 *
 * 样式全在 `chat2/orbits.css`(`.t2o-` 前缀,不改 `sidebar2.css` 本体);几何见该文件头注。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Info, MoreHorizontal, Pencil, Pin, PinOff, Plus, SquarePen, Trash2, UserPlus, Users, UsersRound, FolderPlus, MessageSquarePlus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { OverlayAt, setActiveSpace, useSpaceStore } from '@lcl/engine'
import { SidebarPane, sessionActivityAt } from './chat2/SidebarPane'
import { EngineIcon } from '../components/EngineIcon'
import { useApp } from '../stores/appStore'
import { openSpecial } from './SpecialViews'
import { openNewChat, openSession, openSolo, openTeam, rotateSolo } from '../sessionNav'
import { AvatarStack } from '../components/AvatarStack'
import { AgentAvatar } from '../components/AgentAvatar'
import { tipProps, tipT } from '../hoverTip'
import { formatRelative } from '../format/time'
import { TeamEditor } from '../components/TeamEditor'
import { AgentRemoveDialog } from '../components/RemoveDialog'
import { showDetails } from '../stores/detailsSubject'
import * as api from '../services/backendService'
import { usePageStore } from '../amadeus/store/pageStore'
import { sessionsInMode, workspacesInMode } from './sessionMode'
import { registerMessages, useI18n } from '../i18n'
import { isIndependentOrbitConfig, isTeamImageAvatar, sessionWorkspaceKey, type NormalAgentDef, type SessionRecord, type TeamDef } from '../types'
import { isOrbitPinned, readOrbitPins, toggleOrbitPin, touchOrbitPin, writeOrbitPins, type OrbitPinTimes } from './chat2/orbitPins'
import './chat2/orbits.css'

registerMessages({
  'orbits.filter.label': { zh: '筛选工作区', en: 'Filter workspace' },
  'orbits.filter.all': { zh: '全部', en: 'All' },
  'orbits.filter.agent': { zh: 'Agent', en: 'Agents' },
  'orbits.filter.team': { zh: '团队', en: 'Teams' },
  'orbits.filter.project': { zh: '项目', en: 'Projects' },
  'orbits.plus.tip': { zh: '新建 Agent、团队或项目', en: 'New agent, team or project' },
  'orbits.plus.agent': { zh: '新建 Agent', en: 'New agent' },
  'orbits.plus.team': { zh: '新建团队', en: 'New team' },
  'orbits.plus.project': { zh: '新建项目', en: 'New project' },
  'orbits.row.menu': { zh: '更多', en: 'More' },
  'orbits.row.pin': { zh: 'Pin 到顶部', en: 'Pin to top' },
  'orbits.row.unpin': { zh: '取消 Pin', en: 'Unpin' },
  'orbits.row.newSession': { zh: '新会话', en: 'New session' },
  'orbits.row.newSessionMemory': { zh: '新会话(先总结记忆)', en: 'New session (summarize memory first)' },
  'orbits.row.editTeam': { zh: '编辑团队', en: 'Edit team' },
  'orbits.row.deleteTeam': { zh: '删除团队', en: 'Delete team' },
  'orbits.team.deleted': { zh: '团队已删除(历史会话保留,只读)', en: 'Team deleted (past sessions are kept, read-only)' },
  'orbits.team.confirmDelete': { zh: '删除团队「{name}」?会连同它的 TEAM.md 与 Library 一起删除,不可恢复。', en: 'Delete team "{name}"? Its TEAM.md and Library folder are deleted with it and cannot be recovered.' },
  'orbits.row.openMuseSpace': { zh: '打开 Muse Space', en: 'Open the Muse Space' },
  'orbits.gone.agent': { zh: '该 Agent 已删除,只剩历史会话', en: 'This agent was deleted; only its past sessions remain' },
  'orbits.gone.engine': { zh: '该引擎已卸载,只剩历史会话', en: 'This engine is no longer installed; only its past sessions remain' },
  'orbits.gone.team': { zh: '该团队已删除,只剩历史会话', en: 'This team was deleted; only its past sessions remain' },
  'orbits.gone.agentBadge': { zh: '已删除', en: 'Deleted' },
  'orbits.gone.engineBadge': { zh: '已卸载', en: 'Uninstalled' },
  'orbits.gone.teamBadge': { zh: '已删除', en: 'Deleted' },
  'orbits.team.deleteBusy': { zh: '这个团队还有会话在运行,先停掉再删', en: 'This team still has a running session; stop it before deleting' },
  'orbits.row.editAgent': { zh: '编辑 Agent', en: 'Edit agent' },
  'orbits.row.details': { zh: '查看详情', en: 'View details' },
  'orbits.row.deleteAgent': { zh: '删除 Agent', en: 'Delete agent' },
  'orbits.badge.running': { zh: '运行中', en: 'Running' },
  'orbits.badge.proactive': { zh: '主动式', en: 'Proactive' },
  'orbits.engine.needsSignin': { zh: '待登录', en: 'Needs sign-in' },
  'orbits.muse.unavailable': { zh: 'Muse Space 尚未启用', en: 'The Muse Space is not enabled' },
  // 一级行悬停提示的类型词(评审 U-19 轻量版:不改 40px 单行,只在 hoverTip 里补「类型 · 相对时间」)。
  'orbits.tip.team': { zh: '团队', en: 'Team' },
  'orbits.tip.line': { zh: '{kind} · {when}', en: '{kind} · {when}' },
})

interface MenuAt { x: number; y: number }
interface RowMenu extends MenuAt { kind: 'agent' | 'engine' | 'team' | 'gone'; slug: string; entryKey: string }

/** 把按钮的矩形换成菜单锚点(贴左下角,留 4px 缝)。 */
function anchorOf(e: React.MouseEvent | React.KeyboardEvent): MenuAt {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: r.left, y: r.bottom + 4 }
}

/** sideFilter(工作区 view 左栏胶囊):与 SessionsView 逐字同义 —— cloud=只看云端、local=只看本地、
 *  undefined=不过滤。Agent 轨道是 host-only,cloud 侧整块不列。 */
export function OrbitsView({ sideFilter }: { sideFilter?: 'local' | 'cloud' } = {}) {
  const { t, locale } = useI18n()
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
    defaultAgentSlug: state.defaultAgentSlug,
    agentAvatars: state.agentAvatars,
    engines: state.engines,
    configBySession: state.configBySession,
    teams: state.teams,
    teamAvatars: state.teamAvatars,
    refreshTeams: state.refreshTeams,
    refreshSessions: state.refreshSessions,
  })))
  // 旧的持久化快照 / 未刷新前可能没有 teams:按空表渲染,不让一个 undefined 把整块侧栏交给 ErrorBoundary。
  const teams = Array.isArray(s.teams) ? s.teams : []
  const [teamEditor, setTeamEditor] = useState<{ team: TeamDef | null } | null>(null)
  const [agentRemoving, setAgentRemoving] = useState<NormalAgentDef | null>(null)
  const runningIds = useMemo(() => new Set(Object.keys(s.runningBySession)), [s.runningBySession])
  const activeSession = s.sessions.find((x) => x.id === s.activeId) || s.archivedSessions.find((x) => x.id === s.activeId) || null
  const amadeusRoot = usePageStore((state) => state.vaultRoot)
  const [plusMenu, setPlusMenu] = useState<MenuAt | null>(null)
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null)
  const [pinnedEntries, setPinnedEntries] = useState<OrbitPinTimes>(readOrbitPins)

  const updatePins = (change: (prev: Readonly<OrbitPinTimes>) => OrbitPinTimes): void => {
    setPinnedEntries((prev) => {
      const next = change(prev)
      if (next !== prev) writeOrbitPins(next)
      return next
    })
  }
  const togglePinned = (entryKey: string): void => updatePins((prev) => toggleOrbitPin(prev, entryKey))
  const activatePinned = (entryKey: string): void => updatePins((prev) => touchOrbitPin(prev, entryKey))
  /** 非 Project 一级行共用同一份菜单状态；`…` 锚到按钮下方，右键锚到指针位置。 */
  const showRowMenu = (at: MenuAt, kind: RowMenu['kind'], slug: string, entryKey: string): void => {
    setPlusMenu(null)
    setRowMenu({ ...at, kind, slug, entryKey })
  }
  const openRowMenuAtAnchor = (e: React.MouseEvent | React.KeyboardEvent, kind: RowMenu['kind'], slug: string, entryKey: string): void => {
    e.preventDefault(); e.stopPropagation(); showRowMenu(anchorOf(e), kind, slug, entryKey)
  }
  const openRowMenuAtPointer = (e: React.MouseEvent, kind: RowMenu['kind'], slug: string, entryKey: string): void => {
    e.preventDefault(); e.stopPropagation(); showRowMenu({ x: e.clientX, y: e.clientY }, kind, slug, entryKey)
  }

  // This workspace stays in Work; filtering changes the list only, never the active conversation.
  const mode = 'work' as const
  const [filter, setFilter] = useState<'all' | 'agent' | 'team' | 'project'>(() => {
    const saved = localStorage.getItem('forsion_orbits_filter')
    return saved === 'agent' || saved === 'team' || saved === 'project' ? saved : 'all'
  })
  /** Agent 轨道的会话(私聊 / 独立团队)不属于任何项目 —— 不剔掉的话 `projectless:true` 会把它们
   *  落进「不在项目中工作」组(§3.5)。未打开过的会话也判得出:refreshSessions 已用列表行自带的
   *  agent_config 预填 configBySession。它们结构上 projectless 但语义上属于各自的工作轨道。 */
  const inOrbit = (x: SessionRecord): boolean => {
    // 列表行的 agent_config 是冷启动真源;configBySession 尚未预填时也必须判得出,否则会闪进 rootless。
    return isIndependentOrbitConfig(s.configBySession[x.id] || x.agent_config)
  }
  useEffect(() => { if (s.sessionMode !== 'work') s.setSessionMode('work') }, [s.sessionMode, s.setSessionMode])

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
  const sessions = useMemo(() => sessionsInMode(s.sessions, mode, sideOf).filter((x) => !inOrbit(x)), [s.sessions, s.configBySession, sideFilter, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  // 归档区不剔除轨道会话:删掉的团队 / 卸载的引擎留下的历史在这里仍找得到(只读口径)。
  const archivedSessions = useMemo(() => sessionsInMode(s.archivedSessions, mode, sideOf), [s.archivedSessions, sideFilter, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const workspaces = useMemo(() => {
    const all = s.workspaces()
    const sideKeep = sideFilter ? (w: (typeof all)[number]) => (sideFilter === 'cloud' ? w.kind === 'cloud' || w.kind === 'rootless' : w.kind !== 'cloud' && w.kind !== 'rootless') : undefined
    return workspacesInMode(all, mode, sideKeep)
  }, [s, sideFilter, amadeusRoot, mode])

  // ── Agent 轨道 ───────────────────────────────────────────────────────────
  // 本地 agent:排除 createdBy:'system'(historian 之类的内建),但 Muse 例外 —— 它有自己的一行。
  // 顺序照 agentDefs 已有的顺序(= agents/.meta.json 的 order),不在这里另排一遍。
  // host 闸:云端 agent 定义没有 libraryDir ⇒ 不能开私聊(D3 / §9 云端边界;引擎 solo 端点也是 404),不列;Muse 例外(它开的是 Space)。
  const agents = useMemo(() => s.agentDefs.filter((a) => (a.createdBy !== 'system' || a.slug === 'muse') && (a.slug === 'muse' || !!a.libraryDir)), [s.agentDefs])
  const installedEngines = useMemo(() => s.engines.filter((e) => e.status !== 'not-installed'), [s.engines])
  /** 幽灵会话(creview 09-16):活动会话里带轨道身份、但对应实体已不在(agent 删了 / 引擎卸了 / 团队删了但会话未归档)——
   *  它们被 inOrbit 从项目区剔除,若不给一行入口,切走之后就再也回不去。每个身份一行「墓碑」,点击直接打开最新那条会话。 */
  const tombstones = useMemo(() => {
    const have = { agent: new Set(agents.map((a) => a.slug)), engine: new Set(installedEngines.map((e) => e.id)), team: new Set(teams.map((t) => t.slug)) }
    const out = new Map<string, { kind: 'agent' | 'engine' | 'team'; id: string; sessionId: string }>()
    for (const x of s.sessions) {
      const c = s.configBySession[x.id]
      const ident = c?.soloAgentSlug ? ['agent', c.soloAgentSlug] as const : c?.soloEngineId ? ['engine', c.soloEngineId] as const : c?.teamSlug ? ['team', c.teamSlug] as const : null
      if (!ident || have[ident[0]].has(ident[1])) continue
      const key = `${ident[0]}:${ident[1]}`
      if (!out.has(key)) out.set(key, { kind: ident[0], id: ident[1], sessionId: x.id }) // s.sessions 按 updated_at 降序 → 第一条即最新
    }
    return [...out.values()]
  }, [s.sessions, s.configBySession, agents, installedEngines, teams])
  /** 有活跃 run 的私聊 agent(按运行中的 run 反查,O(running) 不是 O(会话×agent))。 */
  const runningSolo = useMemo(() => {
    const out = new Set<string>()
    for (const id of Object.keys(s.runningBySession)) {
      const c = s.configBySession[id]
      if (c?.soloAgentSlug) out.add(c.soloAgentSlug)
      if (c?.soloEngineId) out.add(`engine:${c.soloEngineId}`)
    }
    return out
  }, [s.runningBySession, s.configBySession])
  /** 每个轨道身份的最近活动(= 其活动会话里最大的 updated_at;从未 = 0),供一级行与项目组混排。 */
  const activityByIdent = useMemo(() => {
    const out = new Map<string, number>()
    for (const x of s.sessions) {
      const c = s.configBySession[x.id]
      const key = c?.soloAgentSlug ? `agent:${c.soloAgentSlug}` : c?.soloEngineId ? `engine:${c.soloEngineId}` : c?.teamSlug ? `team:${c.teamSlug}` : null
      if (!key) continue
      out.set(key, Math.max(out.get(key) || 0, sessionActivityAt(x.updated_at)))
    }
    return out
  }, [s.sessions, s.configBySession])
  /** 一级行的悬停提示(U-19):名字一行 +「类型 · 相对时间」一行;从未有过会话只写类型。取代原生 title,免得两层提示叠在一起。
   *  类型词复用既有词条(私聊 = agentSelect.direct、主动式 = orbits.badge.proactive)。 */
  const rowTipLine = (kindKey: string, identKey: string): string => {
    const at = activityByIdent.get(identKey) || 0
    const kind = tipT(kindKey)
    return at ? tipT('orbits.tip.line', { kind, when: formatRelative(at, { locale }) }) : kind
  }
  // 同一行信息也给键盘与读屏(Codex 第一轮 B2-4):聚焦(:focus-visible)时照样弹提示;可访问描述带上「类型 · 相对时间」。
  const rowTip = (name: string, kindKey: string, identKey: string) => ({
    ...tipProps(() => [name, rowTipLine(kindKey, identKey)], { focus: true }),
    'aria-description': rowTipLine(kindKey, identKey),
  })
  const agentNames = useMemo(() => agents.map((a) => a.name || a.slug), [agents])

  // 高亮源 = 当前会话的轨道身份,不另造通道(§3.2)。
  const activeCfg = s.activeId ? s.configBySession[s.activeId] : undefined
  const activeSpaceId = useSpaceStore((st) => st.activeSpaceId)
  const hasMuseSpace = useSpaceStore((st) => st.spaces.some((x) => x.id === 'muse'))
  // Agent workspaces are local-only; the cloud sidebar does not expose them.
  const showOrbitBlock = sideFilter !== 'cloud' && (agents.length > 0 || installedEngines.length > 0 || teams.length > 0 || tombstones.length > 0)

  const openMuse = (): void => {
    // ⚠️ Muse Space 只在 museAvailable() && 内建插件启用时注册;未注册就切等于点了个死按钮,如实告诉用户。
    if (!hasMuseSpace) { s.toast(t('orbits.muse.unavailable'), true); return }
    setActiveSpace('muse')
  }

  /** 项目下「团队模式」的二级会话行:只换前导图标,26.797px 行高与排版一个像素都不动(§3.5)。 */
  const teamIcon = (x: SessionRecord): React.ReactNode =>
    (s.configBySession[x.id]?.groupChat ? <Users className="t2s-lead-icon t2s-dim" /> : null)

  const agentRow = (slug: string, name: string): React.ReactElement => {
    const entryKey = `row:agent:${slug}`
    const url = s.agentAvatars[slug]
    const isMuse = slug === 'muse'
    const active = isMuse ? activeSpaceId === 'muse' : activeCfg?.soloAgentSlug === slug
    return (
      <button
        key={`agent:${slug}`}
        type="button"
        className={`t2o-row${active ? ' active' : ''}`}
        data-pinned={isOrbitPinned(pinnedEntries, entryKey) ? 'true' : undefined}
        {...rowTip(name || slug, isMuse ? 'orbits.badge.proactive' : 'agentSelect.direct', `agent:${slug}`)}
        onClick={() => { activatePinned(entryKey); isMuse ? openMuse() : openSolo('agent', slug) }}
        onContextMenu={(e) => openRowMenuAtPointer(e, 'agent', slug, entryKey)}
      >
        <span className="t2o-lead">
          {/* 首字一律中性底色(09-25 用户拍板,不按 slug 上彩色);同姓撞字靠 initialFor 取不同的字。 */}
          <AgentAvatar name={name || slug} url={url} siblings={agentNames} size={30} className="t2o-avatar" initialClassName="t2o-avatar-text" />
          {runningSolo.has(slug) && <span className="t2s-dot running" title={t('orbits.badge.running')} />}
          {isMuse && <span className="t2s-dot proactive" title={t('orbits.badge.proactive')} />}
        </span>
        <span className="t2o-name">{name || slug}</span>
        {isOrbitPinned(pinnedEntries, entryKey) && <Pin className="t2o-pin-mark" aria-hidden="true" />}
        <span
          className="t2o-tail"
          role="button"
          tabIndex={0}
          aria-label={t('orbits.row.menu')}
          title={t('orbits.row.menu')}
          onClick={(e) => openRowMenuAtAnchor(e, 'agent', slug, entryKey)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            openRowMenuAtAnchor(e, 'agent', slug, entryKey)
          }}
        ><MoreHorizontal size={14} /></span>
      </button>
    )
  }

  // 一级列表的轨道行(私聊 / 引擎 / 团队 / 墓碑):交给 SidebarPane 与项目组按最近活动混排;云端侧整批不列(§3.5)。
  const orbitRows: Array<{ key: string; at: number; node: React.ReactNode }> = []
  if (showOrbitBlock) {
    const at = (key: string): number => activityByIdent.get(key) || 0
    for (const a of agents) orbitRows.push({ key: `agent:${a.slug}`, at: at(`agent:${a.slug}`), node: agentRow(a.slug, a.name) })
    for (const e of installedEngines) {
      const entryKey = `row:engine:${e.id}`
      orbitRows.push({ key: `engine:${e.id}`, at: at(`engine:${e.id}`), node: (
        <button
          key={`engine:${e.id}`}
          type="button"
          className={`t2o-row${activeCfg?.soloEngineId === e.id ? ' active' : ''}`}
          data-pinned={isOrbitPinned(pinnedEntries, entryKey) ? 'true' : undefined}
          {...rowTip(e.name || e.id, 'agentSelect.direct', `engine:${e.id}`)}
          onClick={() => { activatePinned(entryKey); openSolo('engine', e.id) }}
          onContextMenu={(ev) => openRowMenuAtPointer(ev, 'engine', e.id, entryKey)}
        >
          <span className="t2o-lead t2o-lead-box"><EngineIcon engineId={e.id} size={16} />{runningSolo.has(`engine:${e.id}`) && <span className="t2s-dot running" title={t('orbits.badge.running')} />}</span>
          <span className="t2o-name">{e.name || e.id}</span>
          {e.status === 'needs-signin' && <span className="t2o-badge">{t('orbits.engine.needsSignin')}</span>}
          {isOrbitPinned(pinnedEntries, entryKey) && <Pin className="t2o-pin-mark" aria-hidden="true" />}
          <span
            className="t2o-tail"
            role="button"
            tabIndex={0}
            aria-label={t('orbits.row.menu')}
            title={t('orbits.row.menu')}
            onClick={(ev) => openRowMenuAtAnchor(ev, 'engine', e.id, entryKey)}
            onKeyDown={(ev) => {
              if (ev.key !== 'Enter' && ev.key !== ' ') return
              openRowMenuAtAnchor(ev, 'engine', e.id, entryKey)
            }}
          ><MoreHorizontal size={14} /></span>
        </button>
    ) })
    }
    // 团队行(Agent 轨道的持久团队):组合头像;点击直入该团队最新会话,不内联展开(§3.4)。
    for (const tm of teams) {
      const entryKey = `row:team:${tm.slug}`
      orbitRows.push({ key: `team:${tm.slug}`, at: at(`team:${tm.slug}`), node: (
        <button
          key={`team:${tm.slug}`}
          type="button"
          className={`t2o-row${activeCfg?.teamSlug === tm.slug ? ' active' : ''}`}
          data-pinned={isOrbitPinned(pinnedEntries, entryKey) ? 'true' : undefined}
          {...rowTip(tm.name, 'orbits.tip.team', `team:${tm.slug}`)}
          onClick={() => { activatePinned(entryKey); openTeam(tm.slug) }}
          onContextMenu={(ev) => openRowMenuAtPointer(ev, 'team', tm.slug, entryKey)}
        >
          <span className="t2o-lead">
            <AvatarStack
              items={tm.members.map((m) => ({ slug: m.slug, name: s.agentDefs.find((a) => a.slug === m.slug)?.name || m.slug, avatarUrl: s.agentAvatars[m.slug] }))}
              emoji={isTeamImageAvatar(tm.avatar) ? undefined : tm.avatar || undefined}
              imageUrl={s.teamAvatars[tm.slug]}
              size={30}
            />
          </span>
          <span className="t2o-name">{tm.name}</span>
          {isOrbitPinned(pinnedEntries, entryKey) && <Pin className="t2o-pin-mark" aria-hidden="true" />}
          <span
            className="t2o-tail"
            role="button"
            tabIndex={0}
            aria-label={t('orbits.row.menu')}
            title={t('orbits.row.menu')}
            onClick={(ev) => openRowMenuAtAnchor(ev, 'team', tm.slug, entryKey)}
            onKeyDown={(ev) => {
              if (ev.key !== 'Enter' && ev.key !== ' ') return
              openRowMenuAtAnchor(ev, 'team', tm.slug, entryKey)
            }}
          ><MoreHorizontal size={14} /></span>
        </button>
    ) })
    }
    for (const g of tombstones) {
      const rowKey = `gone:${g.kind}:${g.id}`
      const entryKey = `row:${rowKey}`
      orbitRows.push({ key: rowKey, at: at(`${g.kind}:${g.id}`), node: (
        <button
          key={`gone:${g.kind}:${g.id}`}
          type="button"
          className={`t2o-row t2o-row-gone${s.activeId === g.sessionId || (activeCfg && (activeCfg.soloAgentSlug === g.id || activeCfg.soloEngineId === g.id || activeCfg.teamSlug === g.id)) ? ' active' : ''}`}
          data-pinned={isOrbitPinned(pinnedEntries, entryKey) ? 'true' : undefined}
          title={t(g.kind === 'engine' ? 'orbits.gone.engine' : g.kind === 'team' ? 'orbits.gone.team' : 'orbits.gone.agent')}
          onClick={() => { activatePinned(entryKey); openSession(g.sessionId) }}
          onContextMenu={(ev) => openRowMenuAtPointer(ev, 'gone', g.id, entryKey)}
        >
          <span className="t2o-lead"><AgentAvatar name={g.id} className="t2o-avatar" initialClassName="t2o-avatar-text t2o-avatar-gone" /></span>
          <span className="t2o-name">{g.id}</span>
          <span className="t2o-badge">{t(g.kind === 'engine' ? 'orbits.gone.engineBadge' : g.kind === 'team' ? 'orbits.gone.teamBadge' : 'orbits.gone.agentBadge')}</span>
          {isOrbitPinned(pinnedEntries, entryKey) && <Pin className="t2o-pin-mark" aria-hidden="true" />}
          <span
            className="t2o-tail"
            role="button"
            tabIndex={0}
            aria-label={t('orbits.row.menu')}
            title={t('orbits.row.menu')}
            onClick={(ev) => openRowMenuAtAnchor(ev, 'gone', g.id, entryKey)}
            onKeyDown={(ev) => {
              if (ev.key !== 'Enter' && ev.key !== ' ') return
              openRowMenuAtAnchor(ev, 'gone', g.id, entryKey)
            }}
          ><MoreHorizontal size={14} /></span>
        </button>
    ) })
    }
  }

  return (
    <div className="t2o">
      {/* New session and creation menu; the four-way filter occupies its own row below. */}
      <div className="t2o-head">
        <div className="t2s-special-group">
          <div className="t2s-special-row">
            {/* 尺寸由 `.t2o .t2s-special-ic > svg` 的 --t2s-icon 接管,故不传 size(传了也无效)。
                data-act = 台架锚(check:newtab):文案随语言与改版变,台架别按文字找它。 */}
            <button type="button" className="t2s-special" data-act="new-chat" onClick={() => { s.setSessionMode('work'); openNewChat() }}>
              <span className="t2s-special-ic"><SquarePen /></span>
              <span className="t2s-special-title">{t('orbits.row.newSession')}</span>
            </button>
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

      <div className="t2o-filters t2s-vaultseg" role="tablist" aria-label={t('orbits.filter.label')}>
        <div className="t2s-vaultseg-thumb" style={{ transform: `translateX(${['all', 'agent', 'team', 'project'].indexOf(filter) * 100}%)` }} />
        {(['all', 'agent', 'team', 'project'] as const).map((kind) => <button key={kind} role="tab" type="button"
          data-filter={kind} aria-selected={filter === kind} className={filter === kind ? 'on' : undefined}
          onClick={() => { setFilter(kind); localStorage.setItem('forsion_orbits_filter', kind) }}>{t(`orbits.filter.${kind}`)}</button>)}
      </div>

      {/* 项目轨道 + 上面的轨道行:整段复用 SidebarPane(折叠持久化 / 多选 / 右键菜单全白拿;activity 排序下组拖拽禁用)。 */}
      <div className="t2o-projects">
        <SidebarPane
          collapsed={false}
          orderBy="activity"
          pinnedEntries={pinnedEntries}
          onTogglePinned={togglePinned}
          onActivateEntry={activatePinned}
          extraRows={orbitRows.filter((row) => filter === 'all' || (filter === 'team' ? /^(gone:)?team:/.test(row.key) : filter === 'agent' ? /^(gone:)?(agent|engine):/.test(row.key) : false))}
          sessions={filter === 'all' || filter === 'project' ? sessions : []}
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
          rowIcon={teamIcon}
          onOpenWorkspace={(wsKey) => openSpecial('workspace', wsKey)}
          workspaces={filter === 'all' || filter === 'project' ? workspaces : []}
          onNewInWorkspace={(ws) => void s.createInWorkspace(ws)}
          onAddWorkspace={() => void s.addLocalWorkspace()}
          onRenameWorkspace={(ws, name) => void s.renameWorkspace(ws, name)}
          onRemoveWorkspace={(ws, o) => void s.removeWorkspace(ws, o)}
          onShowWorkspaceDetails={(ws) => { if (ws.path) showDetails({ kind: 'project', path: ws.path }) }}
          onRename={(id, title) => void s.renameSession(id, title)}
          onArchive={(id, a) => void s.archiveSession(id, a)}
          onDelete={(id) => void s.deleteSession(id)}
          onOpenSettings={() => s.openSettings()}
          onToast={s.toast}
          onAuthChange={() => { setTimeout(() => void s.connect(s.cfg), 1500) }}
          activeWorkspaceKey={s.activeWorkspaceKey}
          onEnterWorkspace={(key) => s.setActiveWorkspaceKey(key)}
          sessionWorkspaceKeyOf={(session) => inOrbit(session) ? null : sessionWorkspaceKey(session, workspaces)}
        />
      </div>

      {plusMenu && (
        <OverlayAt className="ctx-menu" x={plusMenu.x} y={plusMenu.y} onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => { setPlusMenu(null); s.openSettings('agents') }}>
            <UserPlus size={13} /> {t('orbits.plus.agent')}
          </button>
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
          <button type="button" onClick={() => { const key = rowMenu.entryKey; setRowMenu(null); togglePinned(key) }}>
            {isOrbitPinned(pinnedEntries, rowMenu.entryKey) ? <PinOff size={13} /> : <Pin size={13} />}
            {t(isOrbitPinned(pinnedEntries, rowMenu.entryKey) ? 'orbits.row.unpin' : 'orbits.row.pin')}
          </button>
          {rowMenu.kind === 'agent' && rowMenu.slug === 'muse' && (
            /* Muse 不进聊天(D18):没有私聊 rotate,只有 Space。 */
            <button type="button" onClick={() => { setRowMenu(null); openMuse() }}>
              <SquarePen size={13} /> {t('orbits.row.openMuseSpace')}
            </button>
          )}
          {rowMenu.kind === 'agent' && rowMenu.slug !== 'muse' && (
            <>
              {/* 「新会话(先总结记忆)」= rotate 端点:归档旧私聊 + 建新,后台采记忆(§5.3)。 */}
              <button type="button" onClick={() => { const slug = rowMenu.slug; setRowMenu(null); rotateSolo('agent', slug) }}>
                <MessageSquarePlus size={13} /> {t('orbits.row.newSessionMemory')}
              </button>
              <button type="button" data-act="agent-details" onClick={() => { const slug = rowMenu.slug; setRowMenu(null); showDetails({ kind: 'agent', slug }) }}>
                <Info size={13} /> {t('orbits.row.details')}
              </button>
              <button type="button" onClick={() => { setRowMenu(null); s.openSettings('agents') }}>
                <Pencil size={13} /> {t('orbits.row.editAgent')}
              </button>
              {/* 默认 Agent 引擎拒删(同名册的禁用口径) */}
              {rowMenu.slug !== 'xyra' && rowMenu.slug !== s.defaultAgentSlug && (
                <button type="button" className="danger" data-act="agent-delete" onClick={() => { const def = agents.find((a) => a.slug === rowMenu.slug) || null; setRowMenu(null); setAgentRemoving(def) }}>
                  <Trash2 size={13} /> {t('orbits.row.deleteAgent')}
                </button>
              )}
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
                // 引擎侧 fs.rm 整个 teams/<slug>/(含 Library/ 里的用户内容),不可逆 —— 与 SidebarPane 删工作区同款先确认。
                const tm = teams.find((x) => x.slug === slug)
                if (!window.confirm(t('orbits.team.confirmDelete', { name: tm?.name || slug }))) return
                void api.deleteTeam(s.cfg, slug)
                  .then((r) => { if (!r || r.ok !== true) throw new Error('delete failed') })
                  .then(() => Promise.all([s.refreshTeams(), s.refreshSessions(s.cfg)]))
                  .then(() => {
                    // 当前正开着这个团队的会话 → 它已被归档,换到新对话,别让人继续往已删的 cwd 里发消息
                    if (s.activeId && s.configBySession[s.activeId]?.teamSlug === slug) openNewChat()
                    s.toast(t('orbits.team.deleted'))
                  })
                  .catch((e: any) => s.toast(/409|run_active/.test(String(e?.message || '')) ? t('orbits.team.deleteBusy') : (e?.message || String(e)), true))
              }}>
                <UsersRound size={13} /> {t('orbits.row.deleteTeam')}
              </button>
            </>
          )}
        </OverlayAt>
      )}
      {agentRemoving && (
        // 删掉的正是当前私聊的 Agent → 换到新对话,别让人继续往已删的 Agent 发消息(同删团队)
        <AgentRemoveDialog agent={agentRemoving} onClose={() => setAgentRemoving(null)}
          onDone={() => { if (s.activeId && s.configBySession[s.activeId]?.soloAgentSlug === agentRemoving.slug) openNewChat() }} />
      )}
      {teamEditor && (
        <TeamEditor
          agents={agents.filter((a) => a.slug !== 'muse')}
          team={teamEditor.team}
          onClose={() => setTeamEditor(null)}
          onSaved={(saved) => { const isNew = !teamEditor.team; setTeamEditor(null); if (isNew) openTeam(saved.slug) }}
        />
      )}
    </div>
  )
}
