/** One dedicated Space surface; no desktop layout, tabs, ribbon or mobile chrome. */
import { Suspense, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { Check, ChevronDown, ExternalLink, Plus, Search, X } from 'lucide-react'
import { getActiveSpace, setActiveSpace, setActiveSpaceCold, useSpaceStore } from './spaceRegistry'
import { getView, subscribeViews } from './viewRegistry'
import { label } from './types'
import { useWorkspace } from './singleColumnStore'
import { supportsMiniPanel, showInMainPanel } from './miniPanel'
import { ViewErrorBoundary } from './Skeleton'
import './miniCard.css'
import { useEngineI18n } from './i18nSeam'
import { currentMiniChrome, useMiniChromeSlot } from './miniChrome'
import { emergeDroplet, type Droplet } from './droplet'

interface DirectMiniViewTarget { type: string; params?: Record<string, unknown> }

/** 自绘缩放边:四条边 + 四个角。宿主窗口是透明无边框的,系统不给缩放边(Windows)。 */
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
/** 带上事件发生时的屏幕坐标,避免主进程收到起手消息时光标已到终点。 */
const dragEdge = (e: React.PointerEvent<HTMLDivElement>): void => {
  const el = e.currentTarget, edge = el.dataset.edge!
  const cursor = { x: e.screenX, y: e.screenY }
  if (e.type === 'pointerdown') {
    if (e.button !== 0) return
    el.setPointerCapture(e.pointerId)
    const shell = el.parentElement!
    const radius = parseFloat(getComputedStyle(shell).borderTopLeftRadius) * (shell.getBoundingClientRect().width / shell.offsetWidth)
    window.tangu?.miniResize?.(edge, true, { ...cursor, radius })
  } else if (e.type === 'pointermove') {
    if (el.hasPointerCapture(e.pointerId)) window.tangu?.miniResize?.(edge, false, cursor)
  } else {
    if (e.type === 'pointerup' && el.hasPointerCapture(e.pointerId)) window.tangu?.miniResize?.(edge, false, cursor)
    window.tangu?.miniResize?.(null)
  }
}

export const MiniColumnHost: React.FC<{
  buildDefault: () => void
  direct?: { title?: string; view: DirectMiniViewTarget; mainView: DirectMiniViewTarget } | null
  /** 用户可拖边改卡片大小(只有宿主认这扇窗时才真的动)。 */
  resizable?: boolean
  /** 右胶囊最前的搜索钮(宿主给快速查找;不给就不画)。 */
  onSearch?: () => void
}> = ({ buildDefault, direct, resizable, onSearch }) => {
  const registered = useSpaceStore((s) => s.spaces)
  const activeId = useSpaceStore((s) => s.activeSpaceId)
  const [, refreshViews] = useReducer((n) => n + 1, 0)
  useEffect(() => subscribeViews(refreshViews), [])
  const spaces = registered.filter(supportsMiniPanel)
  const space = spaces.find((s) => s.id === activeId)
  const active = useWorkspace((s) => s.mainLeaves.find((r) => r.id === s.activeMainId))
  const [menu, setMenu] = useState<'space' | 'picker' | null>(null)
  const picker = useMiniChromeSlot()
  // 换了视图(外部 openMini、切 Space)就收起菜单;picker 被撤掉时不留一层没有菜单的遮罩(Codex 评审 P2)
  useEffect(() => setMenu(null), [active?.id, active?.type])
  const openMenu = menu === 'picker' && !picker ? null : menu
  // 液滴(2026-11-05 水滴复用第一批,DESIGN §3):下拉从按下的那颗胶囊按钮里流出来;再点它 / 点遮罩 / Esc = 倒放缩回。
  // 点一行(换 Space、选会话)和换视图照旧直接收:马上有别的事要发生。两颗按钮之间直接切 = 旧的让位、新的流出。
  const popRef = useRef<HTMLElement | null>(null)
  const capRef = useRef<HTMLDivElement | null>(null)
  const drop = useRef<Droplet | null>(null)
  const dropClosing = useRef(false)
  const dismissMenu = (): void => {
    const d = drop.current
    if (!d) { setMenu(null); return }
    if (dropClosing.current) return
    dropClosing.current = true
    void d.retract().then(() => { if (drop.current === d) setMenu(null) })
  }
  const pour = (): void => {
    drop.current?.cancel(); drop.current = null; dropClosing.current = false
    const el = popRef.current
    const src = capRef.current?.querySelector<HTMLElement>(openMenu === 'space' ? '.mini-card-space' : '.mini-card-picker')
    if (openMenu && el && src) drop.current = emergeDroplet(src, el)
  }
  // 再点同一颗 = 收;正倒放着又点它 = 重新流出来(同悬浮目录)
  const toggleMenu = (which: 'space' | 'picker'): void => {
    if (openMenu !== which) setMenu(which)
    else if (dropClosing.current) pour()
    else dismissMenu()
  }
  useLayoutEffect(pour, [openMenu]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { drop.current?.cancel() }, [])
  const dismissRef = useRef(dismissMenu)
  dismissRef.current = dismissMenu
  const { t } = useEngineI18n()
  const Icon = space?.icon
  const directDef = direct ? getView(direct.view.type) : undefined
  const directSeen = useRef(false)
  if (directDef) directSeen.current = true
  useEffect(() => {
    if (direct && directSeen.current && !directDef) window.tangu?.closeSelf?.()
  }, [direct, directDef])
  const name = direct?.title || (directDef ? label(directDef.displayName) : space ? label(space.mini?.name ?? space.name) : 'Mini Panel')

  useEffect(() => {
    const ws = useWorkspace.getState()
    ws.setDefaultBuilder(buildDefault)
    if (direct) return
    if (!space) {
      const fallback = spaces.find((s) => s.id === 'tangu') ?? spaces[0]
      if (fallback) setActiveSpaceCold(fallback.id)
      ws.resetLayout()
    } else if (ws.getActiveLeaf()?.type !== space.mini!.view.type) ws.resetLayout()
    // Registry changes include plugin enable/disable and removal of an adapter view.
  }, [registered, activeId, space, buildDefault, direct])
  useEffect(() => {
    const escape = (e: KeyboardEvent): void => { if (e.key === 'Escape') dismissRef.current() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])

  const leaf = active && (direct ? active.type === direct.view.type : space && active.type === space.mini!.view.type) ? useWorkspace.getState().getActiveLeaf() : null
  const view = leaf ? getView(leaf.type) : null
  const showMain = (): void => {
    if (direct) {
      showInMainPanel({ type: direct.mainView.type, params: { ...direct.mainView.params, ...useWorkspace.getState().getActiveLeaf()?.params } })
      return
    }
    const current = getActiveSpace()
    if (!current?.mini) return
    showInMainPanel({ spaceId: current.id, type: current.mini.mainView.type,
      params: { ...current.mini.mainView.params, ...useWorkspace.getState().getActiveLeaf()?.params } })
  }
  return (
    <div className="mini-card-shell mini-card-floating" data-space={direct ? 'direct' : space?.id} data-resizable={resizable || undefined}>
      {/* 顶栏浮在内容之上、收成两颗胶囊(手机 .mb-cap 同款,10-17 方案 A);胶囊之外的透明条是拖拽区。 */}
      <header className="mini-card-chrome">
        <div className="mini-card-cap" ref={capRef}>
          <button className="mini-card-space" aria-label={t('lcl.mini.switchSpace')} aria-expanded={openMenu === 'space'}
            disabled={!!direct || spaces.length < 2} onClick={() => toggleMenu('space')}>
            {!direct && Icon && <Icon size={15} />}{(direct || !picker) && <span>{name}</span>}{!direct && spaces.length > 1 && <ChevronDown size={12} />}
          </button>
          {picker && <>
            <span className="mini-card-cap-div" />
            <button className="mini-card-picker" aria-label={picker.label} aria-expanded={openMenu === 'picker'}
              onClick={() => toggleMenu('picker')}>
              <span>{picker.items.find((i) => i.id === picker.value)?.label || picker.placeholder}</span><ChevronDown size={12} />
            </button>
          </>}
        </div>
        <div className="mini-card-drag-title" />
        <div className="mini-card-cap">
          {onSearch && <button className="mini-card-action" aria-label={t('lcl.mini.search')} title={t('lcl.mini.search')}
            onClick={onSearch}><Search size={15} /></button>}
          {picker?.create && <button className="mini-card-action" aria-label={picker.create.label} title={picker.create.label}
            disabled={picker.create.disabled} onClick={() => currentMiniChrome()?.create?.onCreate()}><Plus size={15} /></button>}
          <button className="mini-card-action" aria-label={t('lcl.mini.showMain')}
            title={t('lcl.mini.showMain')} disabled={!direct && !space} onClick={showMain}><ExternalLink size={15} /></button>
          <button className="mini-card-action mini-card-close" aria-label={t('lcl.mini.close')}
            onClick={() => window.tangu?.closeSelf?.()}><X size={15} /></button>
        </div>
      </header>
      <main className="mini-card-main">
        {leaf && view ? <div className="mini-panel-view" data-view={leaf.type} key={`${leaf.id}:${leaf.type}`}>
          <ViewErrorBoundary><Suspense fallback={null}>{view.factory({ leaf, params: leaf.params })}</Suspense></ViewErrorBoundary>
        </div> : <div className="mini-panel-empty">{t('lcl.mini.empty')}</div>}
      </main>
      {openMenu && <>
        <button className="mini-card-dismiss" aria-label={t('lcl.mini.closeMenu')} onClick={dismissMenu} />
        {openMenu === 'space' && <section ref={popRef} className="mini-card-popover" aria-label={t('lcl.mini.switchSpace')}>
          <div className="mini-card-popover-list">{spaces.map((item) => {
            const ItemIcon = item.icon
            return <button key={item.id} className={`mini-card-row${item.id === activeId ? ' active' : ''}`}
              onClick={() => { setActiveSpace(item.id); setMenu(null) }}>
              {ItemIcon && <ItemIcon size={15} />}<span className="mini-card-row-label">{label(item.mini!.name ?? item.name)}</span>
            </button>
          })}</div>
        </section>}
        {openMenu === 'picker' && picker && <section ref={popRef} className="mini-card-popover mini-card-popover--picker" aria-label={picker.label}>
          <div className="mini-card-popover-title">{picker.label}</div>
          <div className="mini-card-popover-list">
            {picker.create && <button className="mini-card-row mini-card-row-new" disabled={picker.create.disabled}
              onClick={() => { setMenu(null); currentMiniChrome()?.create?.onCreate() }}><Plus size={15} /><span className="mini-card-row-label">{picker.create.label}</span></button>}
            {picker.items.map((item) => <button key={item.id} className={`mini-card-row${item.id === picker.value ? ' active' : ''}`}
              onClick={() => { setMenu(null); currentMiniChrome()?.onSelect(item.id) }}>
              <span className="mini-card-row-label">{item.label}</span>{item.id === picker.value && <Check size={14} />}
            </button>)}
          </div>
        </section>}
      </>}
      {resizable && EDGES.map((edge) => <div key={edge} className="mini-card-edge" data-edge={edge}
        onPointerDown={dragEdge} onPointerMove={dragEdge} onPointerUp={dragEdge} onLostPointerCapture={dragEdge} />)}
    </div>
  )
}
