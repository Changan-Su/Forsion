/**
 * 单列外壳:替换 desktop 的 engine/Shell(Dockview 三栏)为**单列**布局。
 * - 顶栏:左/右抽屉开合 + 标题(含所在 Space 副标题)+ 右上「⋯」溢出菜单。
 * - 主区:全屏渲染当前 active 主 leaf 的视图(getView(type).factory({leaf, params}))。
 * - 底部:Space 切换栏(复用 spaceRegistry)。
 * - 侧栏(loc:left/right):侧滑抽屉,顶栏按钮开合(内容由各 Space 的 build() 预填)。
 * - 「⋯」菜单:把桌面 ribbon 底部功能(明暗/语言/设置/账号/命令…)搬进手机版底部弹出层——
 *   只读引擎 ribbon 注册表(useRibbonStore),动作是 feature 层注册进来的,引擎不 import feature 代码。
 * mobile 构建直接渲染它(MobileRoot);desktop/web 由 Shell 在 UI_MODE==='mobile' 时套「手机框」渲染。
 */
import { Suspense, useEffect, useRef, useState } from 'react'
import { PanelLeft, PanelRight, X, MoreHorizontal, ChevronDown, Plus } from 'lucide-react'
import { useSpaceStore, setActiveSpace, getActiveSpace } from './spaceRegistry'
import { useRibbonStore } from './ribbonRegistry'
import { getView } from './viewRegistry'
import { label } from './types'
import { useWorkspace } from './singleColumnStore'
import { Skeleton, ViewErrorBoundary, skeletonVariantOf } from './Skeleton'
import './singleColumn.css'
// ⚠️ 引擎 chrome 样式。移动端构建把 `Shell.tsx` 换成空壳(mobile/vite.config engineSwap),而
// `import './engine.css'` 原本挂在 Shell 上 —— 外壳一换,`.cmd-overlay/.cmd-panel` 这套命令浮层
// 样式在移动端就整个没了(CommandPalette 与 Amadeus 的 QuickSwitcher/TemplatePicker 三家共用)。
// 缺了它浮层不是不显示,而是**落进普通文档流**:没有 position:fixed / z-index,盖不住单列壳。
// 直接借整份而不是抽 .cmd-* 出来:engine.css 通篇是类选择器(.rb-/.dv-/.wb-/.cmd-),无 :root/html/body
// 全局规则,单列壳的 .mb-* 与之零交集 —— 不匹配的规则是惰性的,抽文件反而要动别的会话正在改的 engine.css。
import './engine.css'

export function LeafHost() {
  // 只订阅基本类型(active 的 id 与 type)。leaf 的标题/参数变化**不**重渲染宿主——否则视图渲染期
  // 调 leaf.setTitle 会触发宿主重渲染→再调 setTitle→无限循环(React #185)。
  const activeId = useWorkspace((s) => s.activeMainId)
  const activeType = useWorkspace((s) => s.mainLeaves.find((r) => r.id === s.activeMainId)?.type)
  if (!activeId || !activeType) return null
  const active = useWorkspace.getState().getActiveLeaf()
  const def = active ? getView(active.type) : null
  if (!active || !def) return null
  // 面板级兜底(与 desktop WorkspaceHost 同款):懒视图挂起 → 骨架屏;失败 → 本视图错误面可重试。
  return (
    <div className="mb-view" key={`${active.id}:${active.type}`}>
      <ViewErrorBoundary>
        <Suspense fallback={<Skeleton variant={skeletonVariantOf(active.type)} />}>
          {def.factory({ leaf: active, params: active.params })}
        </Suspense>
      </ViewErrorBoundary>
    </div>
  )
}

function Drawer({ side, docked }: { side: 'left' | 'right'; docked?: boolean }) {
  const visible = useWorkspace((s) => (side === 'left' ? s.leftVisible : s.rightVisible))
  // 只订阅稳定量:该侧 leaf 的 id 签名(增删触发)+ active id(切换触发)。**不**订阅 title,
  // 否则视图渲染期调 leaf.setTitle → 宿主重渲染 → 再 setTitle 的无限循环(React #185)。
  const leavesSig = useWorkspace((s) => (side === 'left' ? s.leftLeaves : s.rightLeaves).map((r) => r.id).join(','))
  const activeId = useWorkspace((s) => (side === 'left' ? s.leftActiveId : s.rightActiveId))
  void leavesSig; void activeId // 仅用于订阅触发重渲染;真身走 getState() 读
  // 抽屉内反向横滑关闭(左抽屉左滑/右抽屉右滑;scrim 点击关闭保留)。
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null)
  if (!visible) return null
  const leaves = side === 'left' ? useWorkspace.getState().leftLeaves : useWorkspace.getState().rightLeaves
  if (leaves.length === 0) return null
  const active = useWorkspace.getState().getActiveSideLeaf(side)
  const def = active ? getView(active.type) : null
  const close = () => useWorkspace.getState().toggleSidebar(side)
  const inner = (
    <>
      <div className="mb-drawer-bar">
        {/* 该侧多个视图 → 下拉切换(原生 select,真机走系统选择器);单个则显示标题。 */}
        {leaves.length > 1 ? (
          <select
            className="mb-drawer-select"
            value={active?.id ?? ''}
            onChange={(e) => useWorkspace.getState().activateLeaf(e.target.value)}
          >
            {leaves.map((r) => {
              const d = getView(r.type)
              return <option key={r.id} value={r.id}>{d ? label(d.displayName) : r.type}</option>
            })}
          </select>
        ) : (
          <div className="mb-drawer-title">{def ? label(def.displayName) : ''}</div>
        )}
        <button className="mb-icon-btn" onClick={close} aria-label="close"><X size={20} /></button>
      </div>
      <div className="mb-drawer-body">
        {def && active ? (
          <div className="mb-view" key={`${active.id}:${active.type}`}>
            <ViewErrorBoundary>
              <Suspense fallback={<Skeleton variant="list" />}>
                {def.factory({ leaf: active, params: active.params })}
              </Suspense>
            </ViewErrorBoundary>
          </div>
        ) : null}
      </div>
    </>
  )
  // 宽屏(>4:3)并排形态:与 main 同排的常驻列,无 scrim(仅左栏用;见 SingleColumnHost)。
  if (docked) return <aside className="mb-sidecol">{inner}</aside>
  return (
    <div className={`mb-drawer-scrim`} onClick={close}>
      <div
        className={`mb-drawer mb-drawer--${side}`}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => {
          const t0 = e.touches[0]
          swipe.current = t0 && e.touches.length === 1 ? { x: t0.clientX, y: t0.clientY, t: Date.now() } : null
        }}
        onTouchEnd={(e) => {
          const s = swipe.current
          swipe.current = null
          const t0 = e.changedTouches[0]
          if (!s || !t0 || Date.now() - s.t > 600) return
          const dx = t0.clientX - s.x
          const dy = t0.clientY - s.y
          if (Math.abs(dx) < 56 || Math.abs(dx) < 2 * Math.abs(dy)) return
          if ((side === 'left' && dx < 0) || (side === 'right' && dx > 0)) close()
        }}
      >
        {inner}
      </div>
    </div>
  )
}

/** 底部弹出的「⋯」菜单:渲染 ribbon 底部注册项(明暗/语言/设置/账号/命令/反馈…)。 */
function MoreSheet({ onClose }: { onClose: () => void }) {
  const items = useRibbonStore((s) => s.items).filter((i) => i.side === 'bottom')
  return (
    <div className="mb-sheet-scrim" onClick={onClose}>
      <div className="mb-sheet" onClick={(e) => e.stopPropagation()} style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mb-sheet-grip" />
        {items.map((it) => {
          if (it.component) {
            const C = it.component
            return <div key={it.id} className="mb-sheet-card"><C expanded /></div>
          }
          const Icon = it.icon
          return (
            <button key={it.id} className="mb-sheet-row" onClick={() => { it.onClick?.(); onClose() }}>
              {Icon && <Icon size={20} />}
              <span>{it.tooltip ? label(it.tooltip) : it.id}</span>
            </button>
          )
        })}
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
            {Icon && <Icon size={22} />}
            <span className="mb-tab-label">{label(sp.name)}</span>
          </button>
        )
      })}
    </nav>
  )
}

/** 主视图 tab 下拉:顶栏触发钮显示当前 tab 的具体名(leaf.title,如笔记名/会话名)+ ▾;点开列出所有
 *  主 tab(点选 activateLeaf、× 关 closeLeaf)+ 底部「＋ 新建标签页」。按 store 的 mainTabs 渲染
 *  (标题走 leaf.title→viewName 回退,setTitle 已 refreshTabs 保持跟随)。新建走 desktop 同款逻辑:
 *  当前 Space 有 newPage 则调,否则 openView('launcher', newTab)。 */
function MainTabMenu() {
  const tabs = useWorkspace((s) => s.mainTabs)
  const [open, setOpen] = useState(false)
  const active = tabs.find((t) => t.active) ?? tabs[0]
  const zh = document.documentElement.lang.startsWith('zh')
  const newTab = () => {
    const sp = getActiveSpace()
    if (sp?.newPage) sp.newPage()
    else useWorkspace.getState().openView('launcher', {}, 'main', { newTab: true })
    setOpen(false)
  }
  return (
    <div className="mb-tabmenu">
      <button className="mb-tabmenu-trigger" onClick={() => setOpen((v) => !v)} aria-label="tabs">
        <span className="mb-tabmenu-current">{active ? active.title : ''}</span>
        <ChevronDown size={15} className="mb-tabmenu-caret" />
      </button>
      {open && (
        <div className="mb-tabmenu-scrim" onClick={() => setOpen(false)}>
          <div className="mb-tabmenu-pop" onClick={(e) => e.stopPropagation()}>
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`mb-tabmenu-item${t.active ? ' on' : ''}`}
                onClick={() => { useWorkspace.getState().activateLeaf(t.id); setOpen(false) }}
              >
                <span className="mb-tabmenu-item-label">{t.title}</span>
                {t.closable && tabs.length > 1 ? (
                  <span
                    className="mb-tabmenu-x"
                    role="button"
                    aria-label="close tab"
                    onClick={(e) => { e.stopPropagation(); useWorkspace.getState().closeLeaf(t.id) }}
                  >
                    <X size={16} />
                  </span>
                ) : null}
              </div>
            ))}
            <button className="mb-tabmenu-new" onClick={newTab}>
              <Plus size={16} /> {zh ? '新建标签页' : 'New tab'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 顶部横向 Space 切换条(mini 变体用):等价于底部 BottomNav 的数据,搬到顶部;条本身可拖窗、按钮 no-drag。 */
function MiniRibbon() {
  const spaces = useSpaceStore((s) => s.spaces)
  const activeId = useSpaceStore((s) => s.activeSpaceId)
  if (spaces.length === 0) return null
  return (
    <div className="mini-ribbon">
      {spaces.map((sp) => {
        const Icon = sp.icon
        const on = sp.id === activeId || (!spaces.some((x) => x.id === activeId) && sp === spaces[0])
        return (
          <button key={sp.id} className={`mini-rib-btn${on ? ' on' : ''}`} title={label(sp.name)} onClick={() => setActiveSpace(sp.id)}>
            {Icon && <Icon size={18} />}
          </button>
        )
      })}
    </div>
  )
}

/** 长宽比 > 4:3(横屏手机/平板)→ 左栏与 main 并排推开而非悬浮(用户拍板:默认展开,右栏仍抽屉)。
 *  mini 变体不启用;desktop「手机框」预览是 3:4 竖比,天然不触发。 */
function useWideAspect(enabled: boolean): boolean {
  const [wide, setWide] = useState(() => enabled && window.matchMedia('(min-aspect-ratio: 4/3)').matches)
  useEffect(() => {
    if (!enabled) return
    const mq = window.matchMedia('(min-aspect-ratio: 4/3)')
    const on = (): void => setWide(mq.matches)
    on() // 旋转/分屏即时跟随
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [enabled])
  return enabled && wide
}

export const SingleColumnHost: React.FC<{ dark?: boolean; soft?: boolean; buildDefault?: () => void; variant?: 'full' | 'mini' }> = ({ buildDefault, variant = 'full' }) => {
  useEffect(() => {
    const ws = useWorkspace.getState()
    if (buildDefault) ws.setDefaultBuilder(buildDefault)
    if (ws.mainLeaves.length === 0) buildDefault?.() // 首次:构建当前活动 Space
    ws.refreshTabs()
  }, [])

  const [moreOpen, setMoreOpen] = useState(false)
  const activeType = useWorkspace((s) => s.mainLeaves.find((r) => r.id === s.activeMainId)?.type)
  const hasLeft = useWorkspace((s) => s.leftLeaves.length > 0 || s.sidebarDefaults.left.length > 0)
  const hasRight = useWorkspace((s) => s.rightLeaves.length > 0 || s.sidebarDefaults.right.length > 0)
  const title = activeType ? label(getView(activeType)?.displayName ?? activeType) : ''
  // 所在 Space 名作副标题(与标题相同则不重复显示),补足层次信息。
  const spaceName = useSpaceStore((s) => {
    const sp = s.spaces.find((x) => x.id === s.activeSpaceId) ?? s.spaces[0]
    return sp ? label(sp.name) : ''
  })

  const mini = variant === 'mini'
  const wide = useWideAspect(!mini)
  // 进入宽屏布局:左栏默认并排展开(用户拍板);离开宽屏回抽屉形态(visible 状态原样保留)。
  useEffect(() => {
    useWorkspace.getState().setWideMode(wide) // store 据此决定主区导航后是否自动收左抽屉
    if (!wide) return
    const ws = useWorkspace.getState()
    if (!ws.leftVisible && (ws.leftLeaves.length > 0 || ws.sidebarDefaults.left.length > 0)) ws.toggleSidebar('left')
  }, [wide])

  // main view 横滑呼出侧栏(用户拍板:全域滑动;白板/PDF/横向可滚动区内只认屏幕边缘起手防误触)。
  // touch 事件专属 —— 桌面鼠标不触发;不 preventDefault,纵向滚动照常。
  const swipe = useRef<{ x: number; y: number; t: number; ok: boolean } | null>(null)
  const swipeStart = (e: React.TouchEvent): void => {
    const t0 = e.touches[0]
    if (!t0 || e.touches.length > 1) { swipe.current = null; return }
    let exempt = !!(e.target as HTMLElement).closest?.('.amx-draw, .pdfa-container')
    if (!exempt) {
      // 横向可滚动祖先(看板/表格):滑动是它的手势,只让边缘起手抢。向上最多走到 .mb-main。
      for (let el = e.target as HTMLElement | null; el && el !== e.currentTarget; el = el.parentElement) {
        const cs = getComputedStyle(el)
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) { exempt = true; break }
      }
    }
    const EDGE = 24
    const edgeStart = t0.clientX < EDGE || t0.clientX > window.innerWidth - EDGE
    swipe.current = { x: t0.clientX, y: t0.clientY, t: Date.now(), ok: !exempt || edgeStart }
  }
  const swipeEnd = (e: React.TouchEvent): void => {
    const s = swipe.current
    swipe.current = null
    const t0 = e.changedTouches[0]
    if (!s || !s.ok || !t0 || Date.now() - s.t > 600) return
    const dx = t0.clientX - s.x
    const dy = t0.clientY - s.y
    if (Math.abs(dx) < 56 || Math.abs(dx) < 2 * Math.abs(dy)) return
    const ws = useWorkspace.getState()
    if (dx > 0) { if (hasLeft && !ws.leftVisible) ws.toggleSidebar('left') }
    else if (hasRight && !ws.rightVisible) ws.toggleSidebar('right')
  }

  return (
    <div className={`mb-shell${mini ? ' mini-shell' : ''}`} style={{ paddingTop: mini ? 0 : 'env(safe-area-inset-top)' }}>
      {/* mini:顶部横向 Space 切换条(ribbon 在顶部)+ 兼作 frameless 拖窗把手。 */}
      {mini && <MiniRibbon />}
      <header className="mb-topbar">
        {hasLeft ? (
          <button className="mb-icon-btn" onClick={() => useWorkspace.getState().toggleSidebar('left')} aria-label="left panel"><PanelLeft size={20} /></button>
        ) : <span className="mb-icon-btn mb-icon-btn--ghost" />}
        <div className="mb-titlewrap">
          <MainTabMenu />
          {spaceName && spaceName !== title ? <div className="mb-subtitle">{spaceName}</div> : null}
        </div>
        {hasRight ? (
          <button className="mb-icon-btn" onClick={() => useWorkspace.getState().toggleSidebar('right')} aria-label="right panel"><PanelRight size={20} /></button>
        ) : null}
        <button className="mb-icon-btn" onClick={() => setMoreOpen(true)} aria-label="more"><MoreHorizontal size={20} /></button>
      </header>

      {/* 宽屏:左栏并排列在 .mb-body 行内;窄屏:Drawer 是 position:fixed 浮层,DOM 位置无影响。 */}
      <div className="mb-body">
        <Drawer side="left" docked={wide} />
        <main className="mb-main" onTouchStart={mini ? undefined : swipeStart} onTouchEnd={mini ? undefined : swipeEnd}>
          <LeafHost />
        </main>
      </div>

      <Drawer side="right" />
      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}

      {/* mini:Space 切换已上移顶部 ribbon,去掉底部栏(用户方向 B)。 */}
      {!mini && <BottomNav />}
    </div>
  )
}
