/**
 * 移动端外壳:替换 desktop 的 engine/Shell(Dockview 三栏)为**单列**布局。
 * - 主区:全屏渲染当前 active 主 leaf 的视图(getView(type).factory({leaf, params}))。
 * - 底部:Space 切换栏(复用 spaceRegistry;用户要求 Space 切换在底部)。
 * - 侧栏(loc:left/right):侧滑抽屉,顶栏按钮开合(内容由各 Space 的 build() 预填)。
 * 复用引擎全部注册表与 views,仅换外壳与 workspaceStore(见 mobileWorkspaceStore + vite resolveId 插件)。
 */
import { useEffect } from 'react'
import { PanelLeft, PanelRight, X } from 'lucide-react'
import { useSpaceStore, setActiveSpace, getView, label } from '@/engine'
import { buildDefaultLayout } from '@/bootstrapEngine'
import { useWorkspace } from './mobileWorkspaceStore'
import './mobile.css'

function LeafHost() {
  // 只订阅基本类型(active 的 id 与 type)。leaf 的标题/参数变化**不**重渲染宿主——否则视图渲染期
  // 调 leaf.setTitle 会触发宿主重渲染→再调 setTitle→无限循环(React #185)。
  const activeId = useWorkspace((s) => s.activeMainId)
  const activeType = useWorkspace((s) => s.mainLeaves.find((r) => r.id === s.activeMainId)?.type)
  if (!activeId || !activeType) return null
  const active = useWorkspace.getState().getActiveLeaf()
  const def = active ? getView(active.type) : null
  if (!active || !def) return null
  return <div className="mb-view" key={`${active.id}:${active.type}`}>{def.factory({ leaf: active, params: active.params })}</div>
}

function Drawer({ side }: { side: 'left' | 'right' }) {
  const visible = useWorkspace((s) => (side === 'left' ? s.leftVisible : s.rightVisible))
  // 只订阅基本类型(当前抽屉视图 type),同 LeafHost 防标题变化触发循环。
  const activeSideType = useWorkspace((s) => {
    const arr = side === 'left' ? s.leftLeaves : s.rightLeaves
    const id = side === 'left' ? s.leftActiveId : s.rightActiveId
    return (arr.find((r) => r.id === id) ?? arr[0])?.type
  })
  if (!visible || !activeSideType) return null
  const leaf = useWorkspace.getState().getActiveSideLeaf(side)
  const def = leaf ? getView(leaf.type) : null
  const close = () => useWorkspace.getState().toggleSidebar(side)
  return (
    <div className={`mb-drawer-scrim`} onClick={close}>
      <div className={`mb-drawer mb-drawer--${side}`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-drawer-bar">
          <button className="mb-icon-btn" onClick={close} aria-label="close"><X size={18} /></button>
        </div>
        <div className="mb-drawer-body">
          {def && leaf ? <div className="mb-view" key={`${leaf.id}:${leaf.type}`}>{def.factory({ leaf, params: leaf.params })}</div> : null}
        </div>
      </div>
    </div>
  )
}

function BottomNav() {
  const spaces = useSpaceStore((s) => s.spaces)
  const activeId = useSpaceStore((s) => s.activeSpaceId)
  if (spaces.length <= 1) return null // 只有一个 Space 无需切换栏
  return (
    <nav className="mb-bottomnav" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {spaces.map((sp) => {
        const Icon = sp.icon
        const on = sp.id === activeId || (!spaces.some((x) => x.id === activeId) && sp === spaces[0])
        return (
          <button key={sp.id} className={`mb-tab${on ? ' on' : ''}`} onClick={() => setActiveSpace(sp.id)}>
            {Icon && <Icon size={20} />}
            <span className="mb-tab-label">{label(sp.name)}</span>
          </button>
        )
      })}
    </nav>
  )
}

export const MobileShell: React.FC<{ dark: boolean }> = () => {
  useEffect(() => {
    const ws = useWorkspace.getState()
    ws.setDefaultBuilder(buildDefaultLayout)
    if (ws.mainLeaves.length === 0) buildDefaultLayout() // 首次:构建当前活动 Space
    ws.refreshTabs()
  }, [])

  const activeType = useWorkspace((s) => s.mainLeaves.find((r) => r.id === s.activeMainId)?.type)
  const hasLeft = useWorkspace((s) => s.leftLeaves.length > 0 || s.sidebarDefaults.left.length > 0)
  const hasRight = useWorkspace((s) => s.rightLeaves.length > 0 || s.sidebarDefaults.right.length > 0)
  const title = activeType ? label(getView(activeType)?.displayName ?? activeType) : ''

  return (
    <div className="mb-shell" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <header className="mb-topbar">
        {hasLeft ? (
          <button className="mb-icon-btn" onClick={() => useWorkspace.getState().toggleSidebar('left')} aria-label="left panel"><PanelLeft size={18} /></button>
        ) : <span className="mb-icon-btn mb-icon-btn--ghost" />}
        <div className="mb-title">{title}</div>
        {hasRight ? (
          <button className="mb-icon-btn" onClick={() => useWorkspace.getState().toggleSidebar('right')} aria-label="right panel"><PanelRight size={18} /></button>
        ) : <span className="mb-icon-btn mb-icon-btn--ghost" />}
      </header>

      <main className="mb-main">
        <LeafHost />
      </main>

      <Drawer side="left" />
      <Drawer side="right" />

      <BottomNav />
    </div>
  )
}
