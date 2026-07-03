/**
 * 主区特殊视图(从侧栏特殊卡片打开):微信远程 / 后台智能体详情 / 整页记忆 / 工作区详情。
 * 复用真实组件,props 对齐 App.tsx 的 specialView 分支。作主区 singleton leaf,与对话同组 tab。
 */
import { WeChatView } from '../components/WeChatView'
import { AgentsDetailView } from '../components/AgentsDetailView'
import { WorkspaceDetailView } from '../components/WorkspaceDetailView'
import { useApp, type SpecialKind } from '../stores/appStore'
import { useWorkspace, recordNav } from '../engine'
import { CLOUD_WORKSPACE_KEY } from '../types'
import { useShallow } from 'zustand/react/shallow'

/** 特殊视图 kind → 引擎视图注册类型。 */
const VIEW_TYPE: Record<SpecialKind, string> = {
  wechat: 'wechat',
  agents: 'agents-detail',
  workspace: 'workspace-detail',
}

/** 打开一个特殊视图(主区 tab,默认就地替换当前 tab)。workspace 需带 wsKey。 */
export function openSpecial(kind: SpecialKind, wsKey?: string): void {
  const a = useApp.getState()
  if (kind === 'workspace' && wsKey != null) a.setDetailWsKey(wsKey)
  a.setActiveSpecial(kind)
  const leaf = useWorkspace.getState().openView(VIEW_TYPE[kind], {}, 'main')
  // 喂 per-tab 导航历史。restore 作用于本 leaf 自身(navigateLeaf,不再全局 openSpecial —— 那会跳去别的 tab)。
  if (leaf) {
    recordNav(leaf.id, `special:${kind}${wsKey ? `:${wsKey}` : ''}`, () => {
      const a2 = useApp.getState()
      if (kind === 'workspace' && wsKey != null) a2.setDetailWsKey(wsKey)
      a2.setActiveSpecial(kind)
      useWorkspace.getState().navigateLeaf(leaf.id, VIEW_TYPE[kind], {})
    })
  }
}

/** 从特殊视图里打开某会话 → 设为活动 + 焦点回对话 leaf。 */
function focusSession(id: string): void {
  useApp.getState().setActiveId(id)
  useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
}

export function WeChatSpecialView() {
  const s = useApp(useShallow((state) => ({
    sessions: state.sessions,
    archivedSessions: state.archivedSessions,
    activeId: state.activeId,
    cfg: state.cfg,
    modelsResp: state.modelsResp,
    openSettings: state.openSettings,
    refreshSessions: state.refreshSessions,
  })))
  const activeSession = s.sessions.find((x) => x.id === s.activeId) || s.archivedSessions.find((x) => x.id === s.activeId) || null
  const modelId = activeSession?.model_id || s.cfg.modelId || s.modelsResp?.defaultModelId || ''
  return (
    <WeChatView
      cfg={s.cfg}
      activeSession={activeSession}
      modelId={modelId}
      onOpenSettings={() => s.openSettings('wechat')}
      onOpenSession={focusSession}
      onSessionsChanged={() => { void s.refreshSessions(s.cfg).catch(() => {}) }}
    />
  )
}

export function AgentsDetailSpecialView() {
  const s = useApp(useShallow((state) => ({ cfg: state.cfg, sessions: state.sessions, openSettings: state.openSettings })))
  return (
    <AgentsDetailView
      cfg={s.cfg}
      sessions={s.sessions}
      onOpenSession={focusSession}
      onOpenSettings={() => s.openSettings('agents')}
    />
  )
}

export function WorkspaceDetailSpecialView() {
  const s = useApp(useShallow((state) => ({
    detailWsKey: state.detailWsKey,
    sessions: state.sessions,
    archivedSessions: state.archivedSessions,
    workspaces: state.workspaces,
    defaultWorkspace: state.defaultWorkspace,
    setActiveId: state.setActiveId,
    setNewChatWs: state.setNewChatWs,
    setNewChatCfg: state.setNewChatCfg,
    setNewChatModel: state.setNewChatModel,
    renameSession: state.renameSession,
    archiveSession: state.archiveSession,
    deleteSession: state.deleteSession,
  })))
  const key = s.detailWsKey
  const workspace = s.workspaces().find((w) => w.key === key) || s.defaultWorkspace()
  const sessions = [...s.sessions, ...s.archivedSessions].filter((x) => (x.project_path || CLOUD_WORKSPACE_KEY) === key)
  return (
    <WorkspaceDetailView
      workspace={workspace}
      sessions={sessions}
      onOpenSession={focusSession}
      onNewChat={() => {
        const w = s.workspaces().find((x) => x.key === key) || null
        s.setActiveId(null)
        s.setNewChatWs(w)
        s.setNewChatCfg(() => ({}))
        s.setNewChatModel(null)
        useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
      }}
      onRename={(id, title) => void s.renameSession(id, title)}
      onArchive={(id, a) => void s.archiveSession(id, a)}
      onDelete={(id) => void s.deleteSession(id)}
    />
  )
}
