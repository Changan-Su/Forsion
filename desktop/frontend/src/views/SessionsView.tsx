/** 左侧栏视图:复用真实 <Sidebar/>,props 由 appStore 映射(对齐 App.tsx 的 sidebarEl)。
 *  特殊视图入口(工作区详情)→ openSpecial 开主区 leaf。 */
import { useEffect, useMemo } from 'react'
import { SidebarPane } from './chat2/SidebarPane'
import { useApp } from '../stores/appStore'
import { openSpecial } from './SpecialViews'
import { openSession, openNewChat } from '../sessionNav'
import { useShallow } from 'zustand/react/shallow'
import { usePageStore } from '../amadeus/store/pageStore'
import { currentPlatform } from '../services/agentRunService'
import { effectiveSessionMode, sessionsInMode, workspacesInMode } from './sessionMode'

/** sideFilter(工作区 view 左栏胶囊):cloud=只看云端(无 project_path 的会话+云端工作区),
 *  local=只看本地;undefined=不过滤(其他挂载点行为不变)。 */
export function SessionsView({ sideFilter }: { sideFilter?: 'local' | 'cloud' } = {}) {
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
  })))
  const runningIds = useMemo(() => new Set(Object.keys(s.runningBySession)), [s.runningBySession])
  const activeSession = s.sessions.find((x) => x.id === s.activeId) || s.archivedSessions.find((x) => x.id === s.activeId) || null
  const amadeusRoot = usePageStore((state) => state.vaultRoot)
  // Chat/Work 模式(新对话行右侧胶囊)。桌面左栏是 WorkspaceView 挂的 sessions 面,另带一层本地/云端侧过滤(sideFilter):
  // Chat 模式不分侧(chat 会话没有侧,全列);Work 模式沿用侧过滤,但无根组/无根会话恒在(用户拍板)。
  const mode = effectiveSessionMode(s.sessionMode, currentPlatform())
  // 模式跟着打开的会话走,**只有一个方向**:在 Chat 里(从全局快速查找 / 收件箱)开了个 work 会话 → 切到 Work,否则侧栏没有
  // 高亮行,像是坏了。反向不跟:chat 会话在 Work 模式的无根组里看得见,Work 里从无根组 + 建 chat 不该把侧栏跳成 Chat。
  // 只在换会话时判(deps 不含 mode):否则开着 work 会话点胶囊 Chat 会被立刻弹回。
  useEffect(() => {
    if (mode === 'chat' && activeSession && !activeSession.projectless) s.setSessionMode('work')
  }, [activeSession?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 侧过滤:会话的云/本地归属 = project_path 有无(appStore 同判据);工作区按 kind。
  const inSide = (p: string | null | undefined): boolean => (sideFilter === 'cloud' ? !p : !!p)
  const sideOf = sideFilter ? (x: { project_path?: string | null }) => inSide(x.project_path) : undefined
  const sessions = useMemo(() => sessionsInMode(s.sessions, mode, sideOf), [s.sessions, sideFilter, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const archivedSessions = useMemo(() => sessionsInMode(s.archivedSessions, mode, sideOf), [s.archivedSessions, sideFilter, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const workspaces = useMemo(() => {
    const all = s.workspaces()
    const sideKeep = sideFilter ? (w: (typeof all)[number]) => (sideFilter === 'cloud' ? w.kind === 'cloud' || w.kind === 'rootless' : w.kind !== 'cloud' && w.kind !== 'rootless') : undefined
    return workspacesInMode(all, mode, sideKeep)
  }, [s, sideFilter, amadeusRoot, mode])

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
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
      showSpecial={true} // 新对话 = createSession HTTP,云 web(无本地后端)同样可用,不 gate backendStatus
      onNewChat={() => openNewChat()}
      mode={mode}
      // 开着 work 会话点 Chat:列表只剩 chat,主区那个 work 会话就没有对应行了 → 顺手开一个新对话(空态,按 chat 建)。
      onModeChange={(m) => { s.setSessionMode(m); if (m === 'chat' && activeSession && !activeSession.projectless) openNewChat() }}
      flat={mode === 'chat'}
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
  )
}
