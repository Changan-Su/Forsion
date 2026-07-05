/**
 * 右侧栏视图:复用真实 <RightPanel/>,props 由 appStore 组装(对齐 App.tsx 的 rightPanelProps)。
 * 四个视图 = 同一 RightPanel 的四个 view(workspace/toc/memory/subchats)。无会话出占位。
 * ToC 跟随最近聚焦的 Chat leaf；滚动 DOM 登记在 workspace store。
 */
import { useEffect } from 'react'
import { RightPanel } from '../components/RightPanel'
import { FilesPanel } from './chat2/FilesPanel'
import { useApp } from '../stores/appStore'
import { useWorkspace } from '@lcl/engine'
import { useShallow } from 'zustand/react/shallow'
import { getBackgroundSessions } from '../services/backendService'

type View = 'workspace' | 'toc' | 'memory' | 'subchats'
const EMPTY_PANEL_PARAMS: Record<string, unknown> = {}

function RightView({ view }: { view: View }) {
  const { chatSurface, panelParams } = useWorkspace(useShallow((ws) => {
    const panel = ws.api?.panels.find((p) => p.id === ws.focusedChatLeafId)
    // ToC 需要聊天滚动容器:focusedChatLeafId 未回填时回退到任意已登记的聊天 surface(通常即主聊天),
    // 否则 containerRef.current=null → ChatToc 查不到 heading/用户行 → 目录恒空。
    const surface = (ws.focusedChatLeafId ? ws.chatSurfaces[ws.focusedChatLeafId] : null)
      ?? Object.values(ws.chatSurfaces)[0] ?? null
    return {
      chatSurface: surface,
      panelParams: (panel?.params as Record<string, unknown> | undefined) ?? EMPTY_PANEL_PARAMS,
    }
  }))
  const s = useApp(useShallow((state) => ({
    globalActiveId: state.activeId,
    cfg: state.cfg,
    configBySession: state.configBySession,
    runningBySession: state.runningBySession,
    messagesBySession: state.messagesBySession,
    subChatsBySession: state.subChatsBySession,
    tr: state.tr,
    toast: state.toast,
    setFilePreview: state.setFilePreview,
  })))
  const pinnedId = typeof panelParams.sessionId === 'string' ? panelParams.sessionId : null
  const sessionId = panelParams.followActive === false ? pinnedId : s.globalActiveId
  // Background Session 统一呈现:@讨论 / Historian 辅助讨论等隐藏子会话经 parent_session_id 持久
  // 指回本会话 → 子聊天视图轮询 /background 合并进列表(实时 'subchat' 事件只覆盖主 run 存活期,
  // 主 run 结束后发起的、以及 reload 前的讨论都靠这里)。点开由面板 SSE 实时/回放。
  const mergeBackgroundSubChats = useApp((state) => state.mergeBackgroundSubChats)
  useEffect(() => {
    if (view !== 'subchats' || !sessionId) return
    let stopped = false
    const load = (): void => {
      void getBackgroundSessions(s.cfg, sessionId)
        .then((items) => {
          if (stopped || !items.length) return
          mergeBackgroundSubChats(sessionId, items
            .filter((it) => !!it.runId)
            .map((it) => ({ runId: it.runId!, title: it.title || it.kind, status: it.runStatus || 'unknown' })))
        })
        .catch(() => { /* 后端未升级/离线 → 静默 */ })
    }
    load()
    const timer = setInterval(load, 6000)
    return () => { stopped = true; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sessionId])
  // 只要有活动会话就渲染:focusedChatLeafId 在布局恢复后可能尚未回填(导致整面板空白),
  // 而文件/记忆/子聊天并不依赖它;ToC 的滚动同步在无 chatSurface 时优雅降级(current:null)。
  if (!sessionId) {
    return <div className="panel-note" style={{ padding: '18px 12px' }}>{s.tr('workbench.noSession')}</div>
  }
  return (
    <RightPanel
      view={view}
      cfg={s.cfg}
      sessionId={sessionId}
      sessionConfig={s.configBySession[sessionId] || {}}
      running={!!s.runningBySession[sessionId]}
      messages={s.messagesBySession[sessionId] || []}
      chatScrollRef={{ current: chatSurface }}
      onToast={s.toast}
      onOpenPreview={s.setFilePreview}
      subChats={s.subChatsBySession[sessionId] || []}
    />
  )
}

/** 文件面板:列所有本地工作区文件夹(手风琴 + 逐级展开磁盘目录),与会话侧栏同构;非会话依赖。 */
export function FilesView() {
  const s = useApp(useShallow((state) => ({
    workspaces: state.workspaces,
    setFilePreview: state.setFilePreview,
    activeWorkspaceKey: state.activeWorkspaceKey,
    setActiveWorkspaceKey: state.setActiveWorkspaceKey,
  })))
  return (
    <FilesPanel
      workspaces={s.workspaces()}
      onOpenPreview={s.setFilePreview}
      activeWorkspaceKey={s.activeWorkspaceKey}
      onEnterWorkspace={(key) => s.setActiveWorkspaceKey(key)}
    />
  )
}
export const TocView = () => <RightView view="toc" />
export const MemoryPanelView = () => <RightView view="memory" />
export const SubchatsView = () => <RightView view="subchats" />
