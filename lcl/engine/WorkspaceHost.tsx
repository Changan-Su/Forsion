/**
 * Dockview 引导:把 viewRegistry 的视图编为 Dockview components(每个包一层 ViewHost,
 * 从 panel props 造 Leaf 再调 def.factory)。onReady 恢复上次布局,否则调 buildDefault;
 * 布局变更持久化。主题叠 dockview-theme-light|dark + .dockview-theme-lcl(--dv-* → LCL token)。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
  type IDockviewHeaderActionsProps,
  type DockviewTheme,
} from 'dockview-react'
import { X, Plus, PanelLeft, PanelRight, ArrowLeft, ArrowRight } from 'lucide-react'
import { createPortal } from 'react-dom'
import 'dockview-react/dist/styles/dockview.css'
import type { Leaf, ViewDefinition } from './types'
import { label } from './types'
import { allViews, getView, subscribeViews } from './viewRegistry'
import { useWorkspace, tryRestoreLayout, scheduleWorkspaceSave, activeMainPanel } from './workspaceStore'
import { useNav } from './navStore'
import { getActiveSpace } from './spaceRegistry'
import { computeDropTarget, type DropTarget } from './dropModel'

/** 从 Dockview panel props 造引擎 Leaf。 */
function leafFromProps(props: IDockviewPanelProps): Leaf {
  const raw = (props.params ?? {}) as Record<string, unknown>
  const { __loc, __type, ...userParams } = raw
  return {
    id: props.api.id,
    type: (typeof __type === 'string' && __type) || (props.api as { component?: string }).component || '',
    loc: (__loc === 'left' || __loc === 'right') ? __loc : 'main',
    params: userParams,
    setTitle: (t) => props.api.setTitle(t),
    setParams: (p) => props.api.updateParameters({ ...raw, ...p }),
    close: () => props.api.close(),
  }
}

// 主区「上一次显示的视图类型」(模块级,跨重挂载存活)。Dockview renderer='onlyWhenVisible':
// 收/展侧栏会重挂主区面板 → 若每次挂载都播淡入,就会「整页闪一下」。只在**视图类型真的变了**时播,
// 同类型重挂(布局抖动引起)不播 → 收/展侧栏不闪,真正切视图(对话↔微信↔…)才淡入。
let lastMainViewType: string | undefined

/** 把一个 ViewDefinition 编成 Dockview 组件。 */
function makeComponent(def: ViewDefinition): React.FC<IDockviewPanelProps> {
  return function ViewHost(props) {
    const leaf = leafFromProps(props)
    const loc = ((props.params ?? {}) as { __loc?: string }).__loc ?? 'main'
    const [enter] = useState(() => {
      if (loc !== 'main') return false // 仅主区做切换淡入;侧栏靠自身宽度补间,别再叠淡入
      const changed = lastMainViewType !== def.type
      lastMainViewType = def.type
      return changed
    })
    return <div className={`wb-view${enter ? ' wb-view-enter' : ''}`}>{def.factory({ leaf, params: leaf.params })}</div>
  }
}

/** 主区 frame 宿主:按 params.__type 动态派发到注册视图(包装组件按类型缓存)。
 *  就地切视图 = navigateLeaf 改 __type → key 换 → 内层 remount,复用 makeComponent 的
 *  「类型真变才播淡入」机制(lastMainViewType)。视图注册变化时整个 components map 重建,缓存随之作废。 */
function makeFrameHost(cache: Map<string, React.FC<IDockviewPanelProps>>): React.FC<IDockviewPanelProps> {
  return function FrameHost(props) {
    const type = ((props.params ?? {}) as { __type?: string }).__type || ''
    const def = getView(type)
    if (!def) return null
    let Comp = cache.get(type)
    if (!Comp) { Comp = makeComponent(def); cache.set(type, Comp) }
    return <Comp key={type} {...props} />
  }
}

/** Surface tab = 图标 + 名称;Obsidian 层级,平整无圆角。无内联 × 关闭钮 —— 关闭走右键菜单(更干净)。
 *  侧栏(left/right)tab 仅图标(名入 tooltip,免文字 tab 溢出,贴合 Obsidian);主区 tab 图标 + 名称。 */
const WbTab: React.FC<IDockviewPanelHeaderProps> = ({ api, params }) => {
  const type = ((params as { __type?: string } | undefined)?.__type) || (api as { component?: string }).component || ''
  const def = getView(type)
  const Icon = def?.icon
  const closable = def?.closable !== false
  const loc = (params as { __loc?: string } | undefined)?.__loc
  const iconOnly = loc === 'left' || loc === 'right'
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const tabRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [menu])
  // 原生 dragstart(非 React prop):须先于祖先 .dv-tab 的 Dockview 监听截断,见 onTabDragStart 注释。
  useEffect(() => {
    const el = tabRef.current
    if (!el) return
    const onDragStart = (e: DragEvent): void => onTabDragStart(e, el, api.id)
    el.addEventListener('dragstart', onDragStart)
    return () => el.removeEventListener('dragstart', onDragStart)
  }, [api.id])
  return (
    <div
      ref={tabRef}
      className={`wb-tab${iconOnly ? ' wb-tab--icon' : ''}${loc === 'left' ? ' wb-tab--left' : ''}${type === 'sidebar-empty' || type === 'home' ? ' wb-tab--empty' : ''}`}
      title={api.title}
      draggable
      onContextMenu={closable ? (e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }) } : undefined}
    >
      {Icon && <Icon size={iconOnly ? 15 : 13} className="wb-tab-ic" />}
      {!iconOnly && <span className="wb-tab-name">{api.title}</span>}
      {/* 命名(主区)tab 加浏览器式 × 关闭钮;图标(侧栏)tab 仍走右键关闭。
       *  mousedown 阻断冒泡,避免被 Dockview 当成 tab 激活/拖拽起点。 */}
      {!iconOnly && closable && (
        <button
          className="wb-tab-close"
          title={document.documentElement.lang.startsWith('zh') ? '关闭' : 'Close'}
          draggable={false}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); useWorkspace.getState().closeLeaf(api.id) }}
        >
          <X size={12} />
        </button>
      )}
      {menu && createPortal(
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <button onClick={() => { useWorkspace.getState().closeLeaf(api.id); setMenu(null) }}>
            <X size={13} /> {document.documentElement.lang.startsWith('zh') ? '关闭' : 'Close'}
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

function lclTheme(dark: boolean, soft: boolean): DockviewTheme {
  return {
    name: dark ? 'lcl-dark' : 'lcl-light',
    className: `dockview-theme-${dark ? 'dark' : 'light'} dockview-theme-lcl`,
    colorScheme: dark ? 'dark' : 'light',
    gap: soft ? 8 : 0, // soft 时各组拉开 → 配合卡片化成独立浮卡
    tabAnimation: 'smooth',
    dndOverlayMounting: 'relative',
  }
}

/** 仅主区组渲染(左/右侧栏组返回 null)。 */
function isMainGroup(panels: IDockviewHeaderActionsProps['panels']): boolean {
  return panels.some((p) => { const loc = (p.params as { __loc?: string } | undefined)?.__loc; return !loc || loc === 'main' })
}

/** 主区组标签栏左侧前缀:左栏折叠钮(在左panel右缘)。主区常驻 →
 *  折叠左栏后此钮仍在原处(左panel右缘=主区左缘),可重开。 */
function makePrefixActions(): React.FC<IDockviewHeaderActionsProps> {
  return function PrefixActions({ panels }) {
    // 左栏收起后,主区组成为最左 → 折叠钮要躲开 mac 交通灯(加 --edge,见 engine.css)。
    const leftCollapsed = !useWorkspace((s) => s.leftVisible)
    // per-tab 历史:箭头只作用于「当前活动主 leaf」的栈。订阅 mainTabs(激活变化)与 stacks 重渲。
    useWorkspace((s) => s.mainTabs)
    const stacks = useNav((s) => s.stacks)
    const api = useWorkspace.getState().api
    const amId = api ? activeMainPanel(api)?.id ?? null : null
    const st = amId ? stacks[amId] : undefined
    const canBack = !!st && st.idx > 0
    const canFwd = !!st && st.idx >= 0 && st.idx < st.entries.length - 1
    if (!isMainGroup(panels)) return null
    const zh = document.documentElement.lang.startsWith('zh')
    return (
      <div className={`dv-prefix${leftCollapsed ? ' dv-prefix--edge' : ''}`}>
        {/* 主面板常驻前进/后退(per-tab 历史,只走当前 tab 的栈;由各 feature recordNav(leafId,…) 喂)。 */}
        <button className="dv-nav-btn" disabled={!canBack} title={zh ? '后退 (⌘/Ctrl+⇧+[)' : 'Back'} onClick={() => { if (amId) useNav.getState().back(amId) }}>
          <ArrowLeft size={15} />
        </button>
        <button className="dv-nav-btn" disabled={!canFwd} title={zh ? '前进 (⌘/Ctrl+⇧+])' : 'Forward'} onClick={() => { if (amId) useNav.getState().forward(amId) }}>
          <ArrowRight size={15} />
        </button>
        <button className="dv-edge-toggle" title={zh ? '左侧栏' : 'Toggle left panel'} onClick={() => useWorkspace.getState().toggleSidebar('left')}>
          <PanelLeft size={15} />
        </button>
      </div>
    )
  }
}

/** 主区组标签栏「所有 tab 之后」的 ＋:打开空白启动器(launcher/NewTabView),选视图后空白页变成它。 */
function makeSuffixActions(): React.FC<IDockviewHeaderActionsProps> {
  return function SuffixActions({ panels }) {
    if (!isMainGroup(panels)) return null
    const zh = document.documentElement.lang.startsWith('zh')
    return (
      <button className="dv-new-tab" title={zh ? '新建标签页' : 'New tab'} onClick={() => { const sp = getActiveSpace(); if (sp?.newPage) sp.newPage(); else useWorkspace.getState().openView('launcher', {}, 'main', { newTab: true }) }}>
        <Plus size={15} />
      </button>
    )
  }
}

// ── 受控自定义拖放层(Dockview disableDnd,自管发起/提示/提交)──
// 唯一真源 computeDropTarget(dropModel.ts)同时驱动「提示」(竖线/半屏高亮)与「提交」(dropView 程序化 moveTo):
// 提示显示在哪就落在哪(根治提示≠落点)。固定 3 面板:tab 栏=并标签页;正文半边=面板内分屏(侧栏仅上下,主区四向);违规=null 弹回。
let draggingId: string | null = null
let dropLineEl: HTMLDivElement | null = null
let dropZoneEl: HTMLDivElement | null = null

function indicatorEl(cls: 'wb-drop-line' | 'wb-drop-zone'): HTMLDivElement {
  const el = document.createElement('div')
  el.className = cls
  document.body.appendChild(el)
  return el
}

function hideIndicator(): void {
  if (dropLineEl) dropLineEl.style.display = 'none'
  if (dropZoneEl) dropZoneEl.style.display = 'none'
}

function showTarget(t: DropTarget): void {
  if (t.mode === 'tab') {
    if (dropZoneEl) dropZoneEl.style.display = 'none'
    const el = (dropLineEl ??= indicatorEl('wb-drop-line'))
    el.style.display = 'block'
    el.style.left = `${Math.round(t.lineX) - 1}px`
    el.style.top = `${Math.round(t.top)}px`
    el.style.height = `${Math.round(t.height)}px`
  } else {
    if (dropLineEl) dropLineEl.style.display = 'none'
    const el = (dropZoneEl ??= indicatorEl('wb-drop-zone'))
    el.style.display = 'block'
    el.style.left = `${Math.round(t.rect.left)}px`
    el.style.top = `${Math.round(t.rect.top)}px`
    el.style.width = `${Math.round(t.rect.width)}px`
    el.style.height = `${Math.round(t.rect.height)}px`
  }
}

// 收尾:清 draggingId + data-dv-dragging(app-region 拖窗区复位)+ 撤源 tab 标记 + 撤提示。
function clearDragState(): void {
  draggingId = null
  if (document.documentElement.dataset.dvDragging) delete document.documentElement.dataset.dvDragging
  document.querySelector('.dv-tab.wb-tab-dragging')?.classList.remove('wb-tab-dragging')
  hideIndicator()
}

// WbTab 拖拽发起:记源 panelId + 标记源 tab(供 computeDropTarget/让位排除)+ 打 data-dv-dragging
// (见 engine.css:拖拽期把 tab 栏 -webkit-app-region:drag 抑成 no-drag,否则 macOS 把窗拖区当非客户区吞掉 dragover/drop)。
// 【关键】必须原生监听在 .wb-tab 上并 stopPropagation:Dockview 的 Html5DragSource 在祖先 .dv-tab 上挂了 dragstart,
// disableDnd 时它会 event.preventDefault() 掐掉拖拽(backend.js)。原生冒泡 .wb-tab 先于 .dv-tab → 截断即可放行;
// React 的 onDragStart 委托在 root、晚于 .dv-tab 的原生监听,来不及(故不能用 React prop)。
function onTabDragStart(e: DragEvent, el: HTMLElement, panelId: string): void {
  e.stopPropagation()
  if (!e.dataTransfer) return
  draggingId = panelId
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('application/x-tangu-view', panelId)
  document.documentElement.dataset.dvDragging = '1'
  el.closest('.dv-tab')?.classList.add('wb-tab-dragging')
}

export const WorkspaceHost: React.FC<{
  dark: boolean
  soft: boolean
  buildDefault?: () => void
}> = ({ dark, soft, buildDefault }) => {
  // 视图注册表 → Dockview components map(注册变化时重建,支持运行期注册)。
  const [version, setVersion] = useState(0)
  useEffect(() => subscribeViews(() => setVersion((v) => v + 1)), [])
  const components = useMemo(() => {
    const map: Record<string, React.FC<IDockviewPanelProps>> = {}
    for (const def of allViews()) map[def.type] = makeComponent(def)
    map['__frame'] = makeFrameHost(new Map()) // 主区统一宿主(见 makeFrameHost)
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])
  const prefixActions = useMemo(() => makePrefixActions(), [])
  const suffixActions = useMemo(() => makeSuffixActions(), [])

  // 受控拖放全局监听(捕获阶段,仅当 draggingId 存在 = 是我们发起的视图拖拽,故不干扰聊天框的文件拖入):
  //  dragover → computeDropTarget 算落点 + 画提示 + preventDefault 放行;drop → 同一结果 dropView 程序化落子;dragend → 收尾。
  //  提交走 moveTo(不受 app-region 影响);dragover/drop 命中 tab 栏需 data-dv-dragging 抑制窗拖区(onTabDragStart 已打)。
  //  收尾只认 dragend(HTML5 收尾信号:drop/取消/ESC 都 fire),drop 里也兜底清一次(源节点被 moveTo 移走时 dragend 可能不达 window)。
  useEffect(() => {
    const onDragOver = (e: DragEvent): void => {
      if (!draggingId) return
      const api = useWorkspace.getState().api
      const t = api ? computeDropTarget(api, e.clientX, e.clientY) : null
      if (!t) { hideIndicator(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; return }
      e.preventDefault() // 有效落点才放行 drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      showTarget(t)
    }
    const onDrop = (e: DragEvent): void => {
      const id = draggingId
      if (!id) return
      e.preventDefault()
      const api = useWorkspace.getState().api
      const t = api ? computeDropTarget(api, e.clientX, e.clientY) : null
      if (t) useWorkspace.getState().dropView(id, t)
      clearDragState()
    }
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragend', clearDragState, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragend', clearDragState, true)
      clearDragState()
    }
  }, [])

  // 主面板前进/后退快捷键(⌘/Ctrl+⌥+←/→,捕获阶段先于视图内部键位)。作用于当前活动主 leaf 的栈;
  // ⌘/Ctrl+⇧+[/] 走命令系统(nav-back/nav-forward,可重绑定),两组指向同一动作。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault(); e.stopPropagation()
        const api = useWorkspace.getState().api
        const id = api ? activeMainPanel(api)?.id : null
        if (!id) return
        if (e.key === 'ArrowLeft') useNav.getState().back(id); else useNav.getState().forward(id)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const onReady = (e: DockviewReadyEvent): void => {
    const ws = useWorkspace.getState()
    ws.setApi(e.api)
    if (buildDefault) ws.setDefaultBuilder(buildDefault) // 供「恢复默认布局」复用
    const restored = tryRestoreLayout(e.api)
    if (!restored) {
      try {
        e.api.clear()
      } catch {
        /* ignore */
      }
      buildDefault?.()
    }
    // 布局变更:只同步侧栏可见态 + 存盘。跨组变形已由 dropView 显式写 __loc(不再位置反查 reconcile)。
    const syncLayout = (): void => {
      ws.syncPanelState()
      scheduleWorkspaceSave()
    }
    e.api.onDidLayoutChange(syncLayout)
    // 拖放全走受控自定义层(见上 useEffect + onTabDragStart);此处不再挂 Dockview 原生 onWillDrag*/onDidDrop。
    // refreshTabs:原生 tab 点击 / addPanel 自动激活 都只发 onDidActivePanelChange,不经 activateLeaf ——
    // 不刷则 mainTabs.active 失真(Amadeus 多标签页的 adopt/activate 依赖它)。refreshTabs 无变化时自 no-op。
    e.api.onDidActivePanelChange(({ panel }) => { ws.setFocusedLeaf(panel); ws.refreshTabs() })
    const activeType = ((e.api.activePanel?.params ?? {}) as { __type?: string }).__type
    ws.setFocusedLeaf(activeType === 'chat' ? e.api.activePanel : e.api.panels.find((panel) => ((panel.params ?? {}) as { __type?: string }).__type === 'chat'))
    ws.refreshTabs() // 布局恢复/默认构建后 seed 一次初始 active 态
  }

  return (
    <>
      <DockviewReact
        className={`wb-dockview${soft ? ' wb-soft' : ''}`}
        theme={lclTheme(dark, soft)}
        defaultTabComponent={WbTab}
        prefixHeaderActionsComponent={prefixActions}
        rightHeaderActionsComponent={suffixActions}
        components={components}
        disableDnd /* 关掉 Dockview 原生手势拖放:全部改走受控自定义层(WbTab draggable + 全局 dragover/drop + dropView 程序化 moveTo)。
                    * 程序化移动/分屏不受 disableDnd 影响,故落子照常;提示与落子同源 computeDropTarget → 天生一致。 */
        onReady={onReady}
      />
      {/* 右栏折叠钮:浮在工作区右上角(=右panel最右缘);右栏收起后仍在原处,可重开。 */}
      <button
        className="dv-edge-toggle dv-edge-right"
        title={document.documentElement.lang.startsWith('zh') ? '右侧栏' : 'Toggle right panel'}
        onClick={() => useWorkspace.getState().toggleSidebar('right')}
      >
        <PanelRight size={15} />
      </button>
    </>
  )
}

export { label }
