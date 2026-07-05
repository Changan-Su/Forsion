/** 左侧栏视图:复用真实 <Sidebar/>,props 由 appStore 映射(对齐 App.tsx 的 sidebarEl)。
 *  特殊视图入口(记忆/后台智能体/工作区详情/微信)→ openSpecial 开主区 leaf。 */
import { useMemo } from 'react'
import { SidebarPane } from './chat2/SidebarPane'
import { useApp } from '../stores/appStore'
import { openSpecial } from './SpecialViews'
import { useWorkspace } from '@lcl/engine'
import { useShallow } from 'zustand/react/shallow'

export function SessionsView() {
  const s = useApp(useShallow((state) => ({
    runningBySession: state.runningBySession,
    sessions: state.sessions,
    archivedSessions: state.archivedSessions,
    activeId: state.activeId,
    unread: state.unread,
    cfg: state.cfg,
    modelsResp: state.modelsResp,
    desktopConfig: state.desktopConfig,
    specialEnabled: state.specialEnabled,
    activeSpecial: state.activeSpecial,
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
  })))
  const runningIds = useMemo(() => new Set(Object.keys(s.runningBySession)), [s.runningBySession])
  const activeSession = s.sessions.find((x) => x.id === s.activeId) || s.archivedSessions.find((x) => x.id === s.activeId) || null
  const wechatEnabled = !!window.tangu?.backendStatus && s.desktopConfig?.wechatEnabled !== false

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
    <SidebarPane
      collapsed={false}
      sessions={s.sessions}
      archivedSessions={s.archivedSessions}
      activeId={s.activeId}
      runningIds={runningIds}
      unreadIds={s.unread}
      cfg={s.cfg}
      modelId={activeSession?.model_id || s.cfg.modelId || s.modelsResp?.defaultModelId || ''}
      activeSession={activeSession}
      onSelect={(id) => {
        s.setActiveId(id)
        useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
      }}
      showSpecial={!!window.tangu?.backendStatus}
      historianEnabled={s.specialEnabled.historian}
      museEnabled={s.specialEnabled.muse}
      wechatEnabled={wechatEnabled}
      specialView={s.activeSpecial}
      onOpenSpecial={(v) => openSpecial(v)}
      onNewChat={() => {
        s.setActiveId(null); s.setNewChatWs(null); s.setNewChatCfg(() => ({})); s.setNewChatModel(null)
        useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
      }}
      onOpenAgentsSettings={() => s.openSettings('agents')}
      onOpenWorkspace={(wsKey) => openSpecial('workspace', wsKey)}
      workspaces={s.workspaces()}
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
