/**
 * 画布版 Dashboard(View 基座 P3a,2026-08-25 拍板:直接画布、抛弃旧网格版)。
 *
 * 与旧 `amadeus-dashboard` 同一份 `.dashboard.md`、同一套块与 widget(```clock/weather/webview/view
 * 围栏 + markdown 块),**只换几何**:外来键 `dashboard2:` 记每块自由 px 矩形,舞台可平移缩放。
 * 卡片渲染整体复用旧版(ViewCard 假 Leaf / WidgetCard / BlockHost)——「view 嵌卡」的核心机制
 * 旧版已备,本文件的新东西是:画布几何、浏览/交互双态、窄屏降级卡片流、旧格网一键迁移。
 *
 * 交互模型(08-21 pointerdown/preventDefault 之坑的规避:罩层是独立 DOM,不在卡内容里拦事件):
 *  · 浏览态:每卡覆一层罩(拖动/选中/缩放手柄);**双击进交互态**(罩层撤下,事件直达卡内容);
 *  · 交互态:点卡外任意处退出;同时只有一张卡在交互态 —— 与 08-22「双击进编辑+聚焦」拍板同构。
 *  · 触屏坐标一律 ÷ zoom 再进舞台系(08-23 的教训)。
 * 落盘防线与旧版同源:换页不写 / 坏 YAML 冻结 / 布局与块全不相交停手 / 落点对当下布局判。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Clock, CloudSun, Globe, Lock, LayoutGrid, Maximize2, MoreHorizontal, Pin, Plus, Trash2, Type, Unlock } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
// ponytail: 不订阅 viewRegistry —— 能嵌卡的只有宿主 embeddable 白名单里的内置视图,它们在
// installEngine 一次注册完;插件视图恒非 embeddable(宿主不给插件这个字段),不存在「晚注册」窗口。
import { allViews, getView, label, useEdgeNudge, useWorkspace } from '@lcl/engine'
import { PageScopeCtx, setActivePageScope, usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { BlockHost } from '@amadeus/components/BlockHost'
import { askString } from '@amadeus/components/askString'
import { DndContext, useSensors } from '@dnd-kit/core'
import {
  DASH2_DEFAULT_H, DASH2_DEFAULT_W, clampRect2, dashBaseName, layoutIsStale, migrateGridToCanvas,
  parseWidget, readDash2Layout, readDashLayout, reconcileCanvas, sameRect, setDash2InFm,
  webviewUrlAllowed, widgetSource, type DashLayout, type Rect,
} from '@amadeus-shared/dashboard'
import { setDashModeInFm } from '@amadeus-shared/dashboard3'
import { useTheme } from '../stores/themeStore'
import { useApp } from '../stores/appStore'
import { useAmadeusPrefs } from '../amadeusPrefs'
import { Breadcrumb } from '../amadeusViews'
import { importToPage } from '../amadeusImport'
import { WidgetCard, localTimeZone } from '@amadeus/dashboard/widgets'
import { ViewCard } from './dashboardViewCard'
import '@amadeus/blocks'
import './dashCanvas.css'

/** 渲染层也拒的嵌入禁区(安全/全局语义炸弹;添加菜单另按 embeddable 白名单收窄)。 */
const EMBED_DENY = new Set(['chat', 'browser', 'terminal', 'dashboard', 'amadeus-dashboard', 'sidebar-empty', 'home'])
const ZOOM_MIN = 0.25
const ZOOM_MAX = 2
const NARROW_PX = 720

const ADD_MENU = [
  { key: 'text', label: '文本块', icon: Type },
  { key: 'clock', label: '时钟', icon: Clock },
  { key: 'weather', label: '天气', icon: CloudSun },
  { key: 'webview', label: '网页', icon: Globe },
] as const

export function DashboardCanvasView(props: ViewProps) {
  return (
    <PageScopeCtx.Provider value={props.leaf.id}>
      <CanvasInner {...props} />
    </PageScopeCtx.Provider>
  )
}

function CanvasInner({ leaf }: ViewProps) {
  const store = useScopedPageStore()
  const dashPath = typeof leaf.params.dashPath === 'string' ? leaf.params.dashPath : ''
  const locked = leaf.params.locked !== false // 缺席即锁(旧版同款):锁上=不能拖/加/删,双击看内容照旧
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  const manifest = usePageStore((s) => s.manifest)
  const blocks = usePageStore((s) => s.blocks)
  const activePage = usePageStore((s) => s.activePage)
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  const pinned = useAmadeusPrefs((s) => !!dashPath && s.pins.includes(dashPath))

  const [addMenu, setAddMenu] = useState(false)
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number } | null>(null)
  const addMenuFix = useEdgeNudge(addMenu)
  const noteMenuFix = useEdgeNudge(noteMenu ? `${noteMenu.x},${noteMenu.y}` : '')
  const [dragOver, setDragOver] = useState(false)
  useEffect(() => {
    if (!dragOver) return
    const clear = (): void => setDragOver(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear) }
  }, [dragOver])

  useEffect(() => { if (dashPath) leaf.setTitle(dashBaseName(dashPath)) }, [dashPath]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dashPath && dashPath !== store.getState().activePage) void store.getState().loadPage(dashPath)
  }, [dashPath]) // eslint-disable-line react-hooks/exhaustive-deps
  const isActiveLeaf = useWorkspace((s) => s.mainTabs.find((t) => t.id === leaf.id)?.active ?? false)
  useEffect(() => { if (isActiveLeaf) setActivePageScope(leaf.id) }, [isActiveLeaf, leaf.id])
  // scope 生命周期由 DashboardView 路由统一管理。否则 grid/canvas 切换时旧子视图的
  // cleanup 会销毁新子视图正在使用的同一份 scoped store。

  const ids = useMemo(() => {
    if (!manifest) return []
    const out: string[] = []
    for (const row of manifest.root.children) for (const col of row.columns) for (const r of col.children) out.push(r.ref)
    return out
  }, [manifest])

  const read2 = useMemo(() => readDash2Layout(fmExtra), [fmExtra])
  const layout = read2.ok ? read2.layout : {}
  const readLegacy = useMemo(() => readDashLayout(fmExtra), [fmExtra])
  /** 只有旧键有货、新键还空 → 显示一键迁移。 */
  const migratable = read2.ok && !Object.keys(layout).length && readLegacy.ok && Object.keys(readLegacy.layout).length > 0
  const stale = read2.ok && !migratable && layoutIsStale(layout, ids)

  const applyLayout = (next: DashLayout): boolean => {
    const st = store.getState()
    if (st.activePage !== dashPath) return false // 换页/已删 → 绝不写进别人的笔记(旧版 Codex 实证防线)
    const cur = st.manifest?.fmExtra ?? ''
    const text = setDash2InFm(cur, next)
    if (text === null || text === cur) return false
    st.setFmExtra(text)
    return true
  }

  // 自愈:新块排底部、孤儿键清理;迁移待决/坏 YAML/布局对不上 → 一律停手。
  useEffect(() => {
    if (!manifest || activePage !== dashPath || !ids.length) return
    if (!read2.ok || migratable || stale) return
    const next = reconcileCanvas(layout, ids)
    if (next) applyLayout(next)
  }, [ids, layout, manifest, activePage, dashPath, read2.ok, migratable, stale]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 舞台:平移/缩放(不持久化;ponytail: 记住视口等真实需求出现再说) ──
  const hostRef = useRef<HTMLDivElement>(null)
  const [vp, setVp] = useState({ tx: 40, ty: 40, z: 1 })
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW_PX))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const wheelRef = useRef(vp)
  wheelRef.current = vp
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    // 原生监听(passive:false)才能 preventDefault 掉页面级缩放/回弹;React onWheel 是 passive。
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const cur = wheelRef.current
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur.z * Math.exp(-e.deltaY * 0.01)))
        // 缩放锚 = 指针下的舞台点保持不动
        const sx = (px - cur.tx) / cur.z
        const sy = (py - cur.ty) / cur.z
        setVp({ z, tx: px - sx * z, ty: py - sy * z })
      } else {
        setVp({ ...cur, tx: cur.tx - e.deltaX, ty: cur.ty - e.deltaY })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── 选择 / 交互态 ──
  const [selected, setSelected] = useState<string | null>(null)
  const [interactId, setInteractId] = useState<string | null>(null)

  // ── 拖卡/缩放/平移(pointer;屏幕位移 ÷ z 进舞台系) ──
  const [drag, setDrag] = useState<{ id: string; rect: Rect } | null>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  const startCard = (e: React.PointerEvent, id: string, kindOp: 'move' | 'resize'): void => {
    if (locked || narrow) return
    e.preventDefault()
    e.stopPropagation()
    dragCleanup.current?.()
    setSelected(id)
    const base = layout[id]
    if (!base) return
    const z = vp.z
    const x0 = e.clientX
    const y0 = e.clientY
    let last: Rect = base
    const onMove = (ev: PointerEvent): void => {
      const dx = (ev.clientX - x0) / z
      const dy = (ev.clientY - y0) / z
      last = clampRect2(
        kindOp === 'move'
          ? { ...base, x: base.x + dx, y: base.y + dy }
          : { ...base, w: base.w + dx, h: base.h + dy },
      )
      setDrag({ id, rect: last })
    }
    const stop = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      dragCleanup.current = null
      setDrag(null)
      if (!commit) return
      // 落点对**当下**布局判(拖拽期间云同步/外部编辑可能改了别的卡;旧版 Codex 防线)。
      const fresh = readDash2Layout(store.getState().manifest?.fmExtra ?? '')
      if (!fresh.ok) return
      const cur = fresh.layout
      if (!cur[id] || !sameRect(cur[id], base)) return
      applyLayout({ ...cur, [id]: last })
    }
    const onUp = (): void => stop(true)
    const onCancel = (): void => stop(false)
    dragCleanup.current = () => stop(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
  }

  const startPan = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    // 空白处按下:退出交互态、清选择、开始平移。
    setInteractId(null)
    setSelected(null)
    const start = vp
    const x0 = e.clientX
    const y0 = e.clientY
    const onMove = (ev: PointerEvent): void => {
      setVp({ ...start, tx: start.tx + (ev.clientX - x0), ty: start.ty + (ev.clientY - y0) })
    }
    const off = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', off)
      window.removeEventListener('pointercancel', off)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', off)
    window.addEventListener('pointercancel', off)
  }

  /** 视口中心的舞台坐标(新卡出生点)。 */
  const stageCenter = (): { x: number; y: number } => {
    const el = hostRef.current
    const w = el?.clientWidth ?? 800
    const h = el?.clientHeight ?? 600
    return { x: (w / 2 - vp.tx) / vp.z - DASH2_DEFAULT_W / 2, y: (h / 2 - vp.ty) / vp.z - DASH2_DEFAULT_H / 2 }
  }

  const insertCard = (content: string, w = DASH2_DEFAULT_W, h = DASH2_DEFAULT_H): string | null => {
    const st = store.getState()
    if (st.activePage !== dashPath) return null
    const id = st.insertBlockAfter(null, undefined, content)
    if (!id) return null
    const fresh = readDash2Layout(store.getState().manifest?.fmExtra ?? '')
    const c = stageCenter()
    if (fresh.ok) applyLayout({ ...fresh.layout, [id]: clampRect2({ x: c.x, y: c.y, w, h }) })
    return id
  }

  const addCard = (kindKey: (typeof ADD_MENU)[number]['key']): void => {
    setAddMenu(false)
    void (async () => {
      let content = ''
      if (kindKey === 'clock') content = widgetSource('clock', { tz: localTimeZone() })
      else if (kindKey === 'weather') {
        const city = await askString('天气卡片 — 城市', '上海')
        if (!city?.trim()) return
        content = widgetSource('weather', { city: city.trim() })
      } else if (kindKey === 'webview') {
        const url = await askString('网页卡片 — 地址', 'https://')
        if (!url?.trim()) return
        if (!webviewUrlAllowed(url.trim())) {
          useApp.getState().toast('只允许公网 http(s) 地址(拒绝 file/data、localhost 与内网)', true)
          return
        }
        content = widgetSource('webview', { url: url.trim() })
      }
      insertCard(content, kindKey === 'clock' || kindKey === 'weather' ? 260 : DASH2_DEFAULT_W, kindKey === 'clock' || kindKey === 'weather' ? 150 : DASH2_DEFAULT_H)
    })()
  }

  /** 添加「视图卡」清单:embeddable 白名单(宿主语义,插件自声明不足信 → 插件 view 目前恒不在列)。 */
  const viewItems = useMemo(
    () => allViews()
      .filter((v) => v.embeddable && !EMBED_DENY.has(v.type))
      .map((v) => ({ type: v.type, name: label(v.displayName), Icon: v.icon ?? LayoutGrid }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [addMenu], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const removeCard = (id: string): void => {
    if (store.getState().activePage !== dashPath) return
    void store.getState().deleteBlock(id) // 布局键交给自愈清(deleteBlock 有反链二次确认,旧版教训)
  }

  const noSensors = useSensors()

  if (!dashPath) return <div className="amx-draw-state">未指定仪表盘文件。</div>

  const orderedIds = narrow
    ? [...ids].sort((a, b) => (layout[a]?.y ?? 0) - (layout[b]?.y ?? 0) || (layout[a]?.x ?? 0) - (layout[b]?.x ?? 0))
    : ids

  const renderBody = (id: string): ReactNode => {
    const widget = parseWidget(blocks[id]?.content ?? '')
    if (widget?.kind === 'view') {
      const t = widget.opts.type ?? ''
      // ⚠️ 白名单必须在**渲染入口**复查,不能只做添加菜单的过滤:卡片源码是 md 文本,同步/共享/
      // 手写都能塞进任意注册键,那样 embeddable 就只是建议而不是安全边界(Codex 评审)。
      const def = getView(t)
      if (!def || EMBED_DENY.has(t) || !def.embeddable) {
        return <div className="dash-widget"><div className="dash-widget-note">视图「{t}」不支持嵌入卡片</div></div>
      }
      return <ViewCard dashLeafId={leaf.id} dashPath={dashPath} blockId={id} opts={widget.opts} onClose={() => removeCard(id)} />
    }
    if (widget) return <WidgetCard widget={widget} />
    return <BlockHost blockId={id} readOnly={locked || interactId !== id} />
  }

  return (
    <div
      className={`am-app tangu-lovable amx-pane amx-editor dash2${dragOver ? ' amx-dragover' : ''}`}
      data-mode={mode}
      data-flat={flat ? '1' : '0'}
      onDragOver={(e) => {
        if (locked || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false) }}
      onDrop={(e) => {
        setDragOver(false)
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (locked || !files.length) return
        e.preventDefault()
        setActivePageScope(leaf.id)
        void importToPage(files, dashPath)
      }}
    >
      <div className="amx-toolbar">
        <Breadcrumb />
        <button
          className={`amx-mode-btn amx-pin-btn${pinned ? ' amx-pin-on' : ''}`}
          title={pinned ? '取消置顶' : '置顶'}
          onClick={() => useAmadeusPrefs.getState().togglePin(dashPath)}
        >
          <Pin size={14} />
        </button>
        <button className="amx-mode-btn" title="重置视口(100%)" onClick={() => setVp({ tx: 40, ty: 40, z: 1 })}>
          <Maximize2 size={14} />
        </button>
        <button
          className={`amx-mode-btn${locked ? '' : ' amx-pin-on'}`}
          title={locked ? '解锁编辑(可拖动/缩放/改内容)' : '锁定(浏览模式)'}
          onClick={() => leaf.setParams({ ...leaf.params, locked: !locked })}
        >
          {locked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
        {!locked && (
          <div className="dash-add-wrap">
            <button className="amx-mode-btn" title="添加卡片" onClick={(e) => { e.stopPropagation(); setAddMenu((v) => !v) }}>
              <Plus size={14} />
            </button>
            {addMenu && (
              <>
                <div className="dash-menu-scrim" onClick={() => setAddMenu(false)} />
                <div ref={addMenuFix.ref} className="dash-add-menu" style={addMenuFix.style}>
                  {ADD_MENU.map((a) => (
                    <button key={a.key} onClick={() => addCard(a.key)}>
                      <a.icon size={13} /> {a.label}
                    </button>
                  ))}
                  {viewItems.length > 0 && <div className="dash-menu-sep">视图</div>}
                  {viewItems.map((v) => (
                    <button key={v.type} onClick={() => { setAddMenu(false); insertCard(widgetSource('view', { type: v.type }), 420, 340) }} title={v.type}>
                      <v.Icon size={13} /> {v.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <button
          className="amx-mode-btn amx-more-btn"
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            setNoteMenu({ x: Math.max(8, Math.min(r.right - 180, window.innerWidth - 196)), y: r.bottom + 4 })
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>

      {!read2.ok && (
        <div className="dash-banner dash-banner-warn">
          这份笔记的 frontmatter 无法解析({read2.error}),布局已冻结、不会自动改写。请先修好 YAML。
        </div>
      )}
      {migratable && (
        <div className="dash-banner">
          这是旧版(网格)仪表盘。转换为画布版后卡片可自由摆放;原网格布局键保留在文件里作为回滚保险。
          <button onClick={() => { if (readLegacy.ok) applyLayout(migrateGridToCanvas(readLegacy.layout)) }}>转换为画布版</button>
        </div>
      )}
      {stale && (
        <div className="dash-banner">
          布局记录的块 id 与当前块对不上(笔记可能被重编号过),已停止自动重排以免丢失布局。
          <button onClick={() => applyLayout(reconcileCanvas({}, ids) ?? {})}>按当前顺序重排</button>
        </div>
      )}

      <DndContext sensors={noSensors}>
        {narrow ? (
          // 窄屏降级:卡片流(按 y,x 线性化;无拖拽,内容直接可交互)—— 自由画布在窄屏没有第三条路。
          <div className="dash2-list">
            {orderedIds.map((id) => (
              <div key={id} className="dash2-list-card">{renderBody(id)}</div>
            ))}
            {!ids.length && <div className="dash2-empty">空仪表盘 —— 解锁后用 ＋ 添加卡片。</div>}
          </div>
        ) : (
          <div ref={hostRef} className="dash2-host" data-locked={locked || undefined} onPointerDown={startPan}>
            <div className="dash2-stage" style={{ transform: `translate(${vp.tx}px, ${vp.ty}px) scale(${vp.z})` }}>
              {ids.map((id) => {
                const base = layout[id]
                if (!base) return null // 自愈下一帧补位
                const r = drag?.id === id ? drag.rect : base
                const widget = parseWidget(blocks[id]?.content ?? '')
                const interacting = interactId === id
                return (
                  <div
                    key={id}
                    className="dash2-card"
                    data-widget={widget?.kind}
                    data-selected={selected === id || undefined}
                    data-interact={interacting || undefined}
                    data-dragging={drag?.id === id || undefined}
                    style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                    onPointerDown={(e) => e.stopPropagation()} // 卡上按下不触发舞台平移/清选
                  >
                    <div className="dash-card-body dash2-card-body">{renderBody(id)}</div>
                    {!interacting && (
                      // 浏览态罩层:独立 DOM 截获指针(不 preventDefault 卡内容的事件——它根本收不到),
                      // 拖动/选中在罩上,双击进交互态。这就是绕开 08-21 那类坑的结构性做法。
                      <div
                        className="dash2-shield"
                        onPointerDown={(e) => startCard(e, id, 'move')}
                        onDoubleClick={() => { setInteractId(id); setSelected(id) }}
                        title={locked ? '双击进入卡片' : '拖动移动;双击进入卡片'}
                      />
                    )}
                    {!locked && !interacting && (
                      <button
                        className="dash-card-del dash2-del"
                        title="删除这张卡片"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => removeCard(id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                    {!locked && !interacting && (
                      <div className="dash-card-resize dash2-resize" onPointerDown={(e) => startCard(e, id, 'resize')} title="缩放" />
                    )}
                  </div>
                )
              })}
              {!ids.length && <div className="dash2-empty dash2-empty-stage">空仪表盘 —— 解锁后用 ＋ 添加卡片。</div>}
            </div>
            <div className="dash2-zoom">{Math.round(vp.z * 100)}%</div>
          </div>
        )}
      </DndContext>

      {noteMenu && (
        <>
          <div className="dash-menu-scrim" onClick={() => setNoteMenu(null)} />
          <div ref={noteMenuFix.ref} className="dash-add-menu" style={{ position: 'fixed', left: noteMenu.x, top: noteMenu.y, ...noteMenuFix.style }}>
            {/* 与网格版「切换到自由摆位」对称的回程:只写模式键,dashboard2: 原样留作回滚保险。 */}
            <button
              onClick={() => {
                setNoteMenu(null)
                const st = store.getState()
                if (st.activePage !== dashPath) return
                const cur = st.manifest?.fmExtra ?? ''
                const text = setDashModeInFm(cur, 'grid')
                if (text !== null && text !== cur) st.setFmExtra(text)
              }}
            >
              切换到结构化网格
            </button>
            <button
              onClick={() => {
                setNoteMenu(null)
                void (async () => {
                  const name = (await askString('重命名仪表盘', dashBaseName(dashPath)))?.trim().replace(/[\\/]/g, '')
                  if (!name) return
                  const ok = await store.getState().renamePage(`${name}.dashboard`)
                  const next = store.getState().activePage
                  if (ok && next && next !== dashPath) leaf.setParams({ ...leaf.params, dashPath: next })
                })()
              }}
            >
              重命名
            </button>
            <button
              className="dash-danger"
              onClick={() => {
                setNoteMenu(null)
                if (!window.confirm(`删除仪表盘「${dashBaseName(dashPath)}」?`)) return
                void store.getState().deletePage(dashPath).then(() => {
                  const err = store.getState().error
                  if (err) { useApp.getState().toast(`删除失败:${err}`, true); return }
                  useApp.getState().toast('已删除')
                  useWorkspace.getState().closeLeaf(leaf.id) // leaf 攥着已删路径必须关(旧版 Codex 实证)
                })
              }}
            >
              删除
            </button>
          </div>
        </>
      )}
    </div>
  )
}
