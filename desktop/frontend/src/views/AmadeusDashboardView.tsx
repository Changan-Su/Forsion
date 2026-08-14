/** Dashboard 视图(`.dashboard.md`):把一份**普通 Amadeus 笔记**的块摊在 24 列网格上。
 *
 *  文件格式见 shared/amadeus/dashboard.ts —— 一句话:块还是块,只多一个外来 frontmatter 键
 *  `dashboard:` 记每块的 [x,y,w,h]。所以这里能直接复用 BlockHost:markdown / 图片 / `![[笔记]]` /
 *  `![[表.db]]` / 白板嵌入…… 一张卡片能装什么,笔记里的一个块就能装什么,一行都不用重写。
 *
 *  顶栏与笔记编辑器同款(面包屑/图钉/云同步/共享/⋮),只把「源码切换」换成**编辑锁定**:
 *  锁上 = 浏览模式(不能拖、不能改字;双链可点、时钟照走、天气照刷)。锁态存 leaf.params,随布局持久化。
 *
 *  ⚠️ 拖放冲突策略 = 拒绝(压到别人身上就回弹,不自动挤开)。见 dashboard.ts 顶部注释。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { DndContext, useSensors } from '@dnd-kit/core'
import { Cloud, Clock, CloudSun, Globe, GripHorizontal, LayoutGrid, Lock, MoreHorizontal, Pin, Plus, Share2, Trash2, Type, Unlock } from 'lucide-react'
import type { Leaf, ViewProps } from '@lcl/engine'
import {
  DASH_COLS,
  DASH_GAP_PX,
  DASH_MAX_ROWS,
  DASH_ROW_PX,
  canPlace,
  clampRect,
  dashBaseName,
  findSlot,
  layoutIsStale,
  parseWidget,
  readDashLayout,
  reconcileLayout,
  sameRect,
  setDashInFm,
  snapDelta,
  webviewUrlAllowed,
  widgetSource,
  type DashLayout,
  type Rect,
} from '@amadeus-shared/dashboard'
import { PageScopeCtx, disposePageScope, setActivePageScope, usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { BlockHost } from '@amadeus/components/BlockHost'
import { askString } from '@amadeus/components/askString'
import { useTheme } from '../stores/themeStore'
import { useApp } from '../stores/appStore'
import { allViews, getView, label, subscribeViews, useEdgeNudge, useWorkspace } from '@lcl/engine'
import { useAmadeusPrefs } from '../amadeusPrefs'
import { useEntrySync, ensureEntrySyncSubscribed, isSyncedEntry } from '../stores/entrySyncStore'
import { openCloudSyncDialog } from '../components/CloudSyncDialog'
import { ShareStatus } from '../components/ShareStatus'
import { ShareCard } from '../components/ShareCard'
import { Breadcrumb } from '../amadeusViews'
import { importToPage } from '../amadeusImport'
import { WidgetCard, localTimeZone } from '@amadeus/dashboard/widgets'
import '@amadeus/blocks' // 注册内置块类型;缺此 side-effect 导入则卡片显示「未知块类型」

export function AmadeusDashboardView(props: ViewProps) {
  return (
    <PageScopeCtx.Provider value={props.leaf.id}>
      <DashboardInner {...props} />
    </PageScopeCtx.Provider>
  )
}

/** ＋ 菜单里每种卡片的出生尺寸(格)。 */
const ADD_MENU = [
  { key: 'text', label: '文本块', icon: Type, w: 8, h: 6 },
  { key: 'clock', label: '时钟', icon: Clock, w: 5, h: 4 },
  { key: 'weather', label: '天气', icon: CloudSun, w: 5, h: 4 },
  { key: 'webview', label: '网页', icon: Globe, w: 10, h: 10 },
] as const

/** 视图卡片的出生尺寸(格):视图普遍要一块能读的地方,给得比功能卡片大。 */
const VIEW_CARD_SIZE = { w: 10, h: 12 }
/** 不进「添加视图」清单的注册键。刻意只排三个:
 *  仪表盘自己(套娃)、侧栏空态与主区空态(它们是布局占位,不是内容)。其余一律自动列出 ——
 *  新注册的视图(含插件视图)不用回来改这里。 */
const VIEW_MENU_SKIP = new Set(['amadeus-dashboard', 'sidebar-empty', 'home'])

function DashboardInner({ leaf }: ViewProps) {
  const store = useScopedPageStore()
  const dashPath = typeof leaf.params.dashPath === 'string' ? leaf.params.dashPath : ''
  const locked = leaf.params.locked !== false // 缺席即锁:仪表盘以「看」为主,也防误拖
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  const manifest = usePageStore((s) => s.manifest)
  const blocks = usePageStore((s) => s.blocks)
  const activePage = usePageStore((s) => s.activePage)
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  const pinned = useAmadeusPrefs((s) => !!dashPath && s.pins.includes(dashPath))
  const vaultSide = usePageStore((s) => s.vaultSide)
  const [addMenu, setAddMenu] = useState(false)
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number } | null>(null)
  // 两个 dash-add-menu 都是硬编码宽度、锚在按钮/鼠标上,窄屏会掉出边缘 → 视口兜底(见 menuAnchor)。
  const addMenuFix = useEdgeNudge(addMenu)
  const noteMenuFix = useEdgeNudge(noteMenu ? `${noteMenu.x},${noteMenu.y}` : '')
  const [shareCard, setShareCard] = useState<{ x: number; y: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // 兜底收虚线框:拖拽在别处松手 / Esc 取消 / 拖出窗口时,本容器的 dragleave 未必来得及。
  useEffect(() => {
    if (!dragOver) return
    const clear = (): void => setDragOver(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear) }
  }, [dragOver])

  useEntrySync((s) => s.vaults)
  useEffect(() => { ensureEntrySyncSubscribed() }, [])
  const canEntrySync = !!window.amadeusSync?.entrySyncEnable && vaultSide === 'local'
  const synced = canEntrySync && !!dashPath && isSyncedEntry(store.getState().vaultRoot, dashPath)

  useEffect(() => { if (dashPath) leaf.setTitle(dashBaseName(dashPath)) }, [dashPath]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dashPath && dashPath !== store.getState().activePage) void store.getState().loadPage(dashPath)
  }, [dashPath]) // eslint-disable-line react-hooks/exhaustive-deps
  const isActiveLeaf = useWorkspace((s) => s.mainTabs.find((t) => t.id === leaf.id)?.active ?? false)
  useEffect(() => { if (isActiveLeaf) setActivePageScope(leaf.id) }, [isActiveLeaf, leaf.id])
  useEffect(() => () => disposePageScope(leaf.id), [leaf.id])

  // 块的文档顺序 = 布局自愈的先到先得顺序(手改 md 改出重叠时,靠前的保住原位)。
  const ids = useMemo(() => {
    if (!manifest) return []
    const out: string[] = []
    for (const row of manifest.root.children) for (const col of row.columns) for (const r of col.children) out.push(r.ref)
    return out
  }, [manifest])

  const read = useMemo(() => readDashLayout(fmExtra), [fmExtra])
  const layout = read.ok ? read.layout : {}
  // 布局与块 id 完全对不上(compiler 的 legacy-id 重编号只 remap amadeus_layout,不认外来键)
  // → 停手,让用户自己决定(横幅上有「按当前顺序重排」)。判定与理由见 dashboard.ts:layoutIsStale。
  const staleIds = read.ok && layoutIsStale(layout, ids)

  /** 写布局。返回是否真写了。三道闸:换页了不写、YAML 读不懂不写、写出来没变化不写。 */
  const applyLayout = (next: DashLayout): boolean => {
    const st = store.getState()
    // ⚠️ 删除/换页之后 leaf 仍攥着 dashPath,而 store 已经被 deletePage 导航到下一篇笔记了 ——
    // 不认这一下,添加卡片/拖动就会把 `dashboard:` 写进**别人的笔记**(Codex 评审实证)。
    if (st.activePage !== dashPath) return false
    const cur = st.manifest?.fmExtra ?? ''
    const text = setDashInFm(cur, next)
    // null = frontmatter 不可解析 → 拒改(此前这里会拿默认布局把用户真实布局覆盖掉)。
    // 相等 = 无谓落盘,也顺带堵住「自愈 effect 依赖 fmExtra」的自激循环。
    if (text === null || text === cur) return false
    st.setFmExtra(text)
    return true
  }

  // 自愈:新块自动找位、消失的块清掉、手改 md 改出的重叠重新安置。只在真需要改时写。
  // 读不懂(坏 YAML)或对不上(staleIds)一律停手 —— 宁可画面不好看,不可把用户布局写没了。
  useEffect(() => {
    if (!manifest || activePage !== dashPath || !ids.length) return
    if (!read.ok || staleIds) return
    const next = reconcileLayout(layout, ids)
    if (next) applyLayout(next)
  }, [ids, layout, manifest, activePage, dashPath, read.ok, staleIds]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 拖动 / 缩放:纯几何在 dashboard.ts(snapDelta/clampRect/canPlace),这里只管指针 ----
  const gridRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ id: string; rect: Rect; ok: boolean } | null>(null)
  const steps = (): { x: number; y: number } => {
    const el = gridRef.current
    // ⚠️ clientWidth 含内距,直接拿来除 24 会让每格宽度算小一截,拖得越远偏得越多。用内容宽。
    const cs = el ? getComputedStyle(el) : null
    const inner = el && cs ? el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : 0
    const cell = (inner - (DASH_COLS - 1) * DASH_GAP_PX) / DASH_COLS
    return { x: cell + DASH_GAP_PX, y: DASH_ROW_PX + DASH_GAP_PX }
  }
  // 拖拽期的解绑句柄:pointerup 之外,卸载 / pointercancel(触控被系统接管)/ 窗口失焦都要能收摊,
  // 否则闭包一直攥着已卸载的组件与 scoped store,之后的 move/up 还会拿旧快照去写盘。
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  const startPointer = (e: React.PointerEvent, id: string, kind: 'move' | 'resize'): void => {
    if (locked) return
    e.preventDefault()
    e.stopPropagation()
    dragCleanup.current?.() // 上一次没收干净的先收掉
    const base = layout[id]
    if (!base) return
    const step = steps()
    const x0 = e.clientX
    const y0 = e.clientY
    let last: Rect = base
    const onMove = (ev: PointerEvent): void => {
      const d = snapDelta(ev.clientX - x0, ev.clientY - y0, step.x, step.y)
      last = clampRect(
        kind === 'move'
          ? { ...base, x: base.x + d.dx, y: base.y + d.dy }
          : { ...base, w: base.w + d.dx, h: base.h + d.dy },
      )
      setDrag({ id, rect: last, ok: canPlace(id, last, layout) })
    }
    const stop = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      dragCleanup.current = null
      setDrag(null)
      if (!commit) return
      // ⚠️ 落点必须对着**当下**的布局判,不能用 pointerdown 时捕获的那份:拖的这几百毫秒里
      // 云同步/外部编辑完全可能挪了别的卡片。整表 spread 回去会把那些改动一并回滚(Codex 评审)。
      const fresh = readDashLayout(store.getState().manifest?.fmExtra ?? '')
      if (!fresh.ok) return
      const cur = fresh.layout
      if (!cur[id] || !sameRect(cur[id], base)) return // 自己这块在拖拽期间被外部改过 → 放弃本次落点
      if (canPlace(id, last, cur)) applyLayout({ ...cur, [id]: last })
    }
    const onUp = (): void => stop(true)
    const onCancel = (): void => stop(false)
    dragCleanup.current = () => stop(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
  }

  /** 插一张已排好位的卡片。返回块 id(插不进 → null)。 */
  const insertCard = (content: string, w: number, h: number): string | null => {
    const st = store.getState()
    if (st.activePage !== dashPath) return null // 换页/已删 → 绝不往别人的笔记里插块
    const id = st.insertBlockAfter(null, undefined, content)
    if (!id) return null
    const fresh = readDashLayout(store.getState().manifest?.fmExtra ?? '')
    if (fresh.ok) applyLayout({ ...fresh.layout, [id]: findSlot(fresh.layout, w, h) })
    return id
  }

  const addCard = (kind: (typeof ADD_MENU)[number]['key']): void => {
    setAddMenu(false)
    void (async () => {
      let content = ''
      if (kind === 'clock') content = widgetSource('clock', { tz: localTimeZone() })
      else if (kind === 'weather') {
        const city = await askString('天气卡片 — 城市', '上海')
        if (!city?.trim()) return
        content = widgetSource('weather', { city: city.trim() })
      } else if (kind === 'webview') {
        const url = await askString('网页卡片 — 地址', 'https://')
        if (!url?.trim()) return
        // 与渲染期同一把闸(webviewUrlAllowed):UI 这道只是早点告诉用户,真正兜底在渲染那层
        // —— 手写 md 完全绕得过这里。
        if (!webviewUrlAllowed(url.trim())) {
          useApp.getState().toast('只允许公网 http(s) 地址(拒绝 file/data、localhost 与内网)', true)
          return
        }
        content = widgetSource('webview', { url: url.trim() })
      }
      const spec = ADD_MENU.find((a) => a.key === kind)!
      insertCard(content, spec.w, spec.h)
    })()
  }

  /** ＋ 菜单的「视图」区:直接读视图注册表 —— 谁注册了谁就在这儿,不维护白名单。
   *  菜单开合时重算一次即可(插件运行期注册的视图,下次开菜单就在)。 */
  const viewItems = useMemo(
    () => allViews()
      .filter((v) => !VIEW_MENU_SKIP.has(v.type))
      .map((v) => ({ type: v.type, name: label(v.displayName), Icon: v.icon ?? LayoutGrid }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [addMenu],
  )

  const addViewCard = (type: string): void => {
    setAddMenu(false)
    insertCard(widgetSource('view', { type }), VIEW_CARD_SIZE.w, VIEW_CARD_SIZE.h)
  }

  /** 删卡片 = 删块。**不手动摘布局键** —— deleteBlock 是 async 且带反链二次确认,
   *  用户点「取消」时块还在,先摘了键就会让自愈把它扔去「首个空位」(位置凭空跳走)。
   *  块真没了之后,自愈 effect 自己会清掉孤儿键。 */
  const removeCard = (id: string): void => {
    if (store.getState().activePage !== dashPath) return
    void store.getState().deleteBlock(id)
  }

  // 空 sensor 集:BlockHost 里的 useSortable 需要一个 DndContext,但仪表盘的拖动由本文件接管。
  // ⚠️必须在早退之前调(hook 顺序;check:hooks 会拦)。
  const noSensors = useSensors()

  if (!dashPath) return <div className="amx-draw-state">未指定仪表盘文件。</div>

  const rects: Rect[] = Object.values(layout)
  const rows = Math.min(DASH_MAX_ROWS, Math.max(12, ...rects.map((r) => r.y + r.h)) + 4) // 底部留一屏空地便于拖放

  return (
    <div
      className={`am-app tangu-lovable amx-pane amx-editor amx-dashview${dragOver ? ' amx-dragover' : ''}`}
      data-mode={mode}
      data-flat={flat ? '1' : '0'}
      onDragOver={(e) => {
        if (locked || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
        e.preventDefault()
        setDragOver(true)
      }}
      // 判据是「指针出了本容器」而非「事件打在容器本身」—— 后者从子元素离开时不触发,虚线框会赖着不走。
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false) }}
      onDrop={(e) => {
        setDragOver(false) // 必须在 early return 之前
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (locked || !files.length) return
        e.preventDefault()
        // ⚠️ importToPage 内部走的是**活动面板**那份门面 store(分屏时可能是隔壁那篇)。
        // OS 文件拖放未必先激活本 pane → 先把活动作用域认领过来,占位块才会插进本仪表盘。
        setActivePageScope(leaf.id)
        // 拖进来的文件按 Tangu 附件设置存放并作为新块插入 → 自愈 effect 随即给它找位。
        void importToPage(files, dashPath)
      }}
    >
      <div className="amx-toolbar">
        <Breadcrumb />
        {window.amadeusCollab && <ShareStatus path={dashPath} refreshKey={0} onOpen={(x, y) => setShareCard({ x, y })} />}
        <button
          className={`amx-mode-btn amx-pin-btn${pinned ? ' amx-pin-on' : ''}`}
          title={pinned ? '取消置顶' : '置顶'}
          onClick={() => useAmadeusPrefs.getState().togglePin(dashPath)}
        >
          <Pin size={14} />
        </button>
        {canEntrySync && (
          <button
            className={`amx-mode-btn amx-pin-btn${synced ? ' amx-pin-on' : ''}`}
            title={synced ? '关闭云同步(云端副本保留)' : '开启云同步'}
            onClick={() => {
              if (synced) void window.amadeusSync?.entrySyncDisable?.(dashPath)
              else openCloudSyncDialog(dashPath, 'page')
            }}
          >
            <Cloud size={14} />
          </button>
        )}
        {window.amadeusCollab && (
          <button
            className="amx-mode-btn"
            title="共享 / 发布"
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setShareCard({ x: r.right, y: r.bottom })
            }}
          >
            <Share2 size={14} />
          </button>
        )}
        {/* 笔记编辑器这个位置是「源码/可视」;仪表盘换成编辑锁定(锁上=浏览:不能拖不能改,链接照点)。 */}
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
                  <div className="dash-menu-sep">视图</div>
                  {viewItems.map((v) => (
                    <button key={v.type} onClick={() => addViewCard(v.type)} title={v.type}>
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

      {/* 读不懂 / 对不上 → 明说,并停掉一切自动写入。绝不「猜一个默认布局盖上去」。 */}
      {!read.ok && (
        <div className="dash-banner dash-banner-warn">
          这份笔记的 frontmatter 无法解析（{read.error}），布局已冻结、不会自动改写。请先修好 YAML。
        </div>
      )}
      {read.ok && staleIds && (
        <div className="dash-banner">
          布局记录的块 id 与当前块对不上（笔记可能被重编号过），已停止自动重排以免丢失布局。
          <button onClick={() => applyLayout(reconcileLayout({}, ids) ?? {})}>按当前顺序重排</button>
        </div>
      )}
      {/* 空的 DndContext:不给 sensor,块自带的 ⠿ 手柄就发不出拖拽(CSS 里也把它藏了)。 */}
      <DndContext sensors={noSensors}>
        <div
          ref={gridRef}
          className="dash-grid"
          data-locked={locked || undefined}
          style={{ gridTemplateRows: `repeat(${rows}, ${DASH_ROW_PX}px)`, gap: DASH_GAP_PX }}
        >
          {ids.map((id) => {
            const base = layout[id]
            if (!base) return null // 自愈 effect 下一帧就补上
            const r = drag?.id === id ? drag.rect : base
            const widget = parseWidget(blocks[id]?.content ?? '')
            return (
              <div
                key={id}
                className="dash-card"
                data-widget={widget?.kind}
                data-dragging={drag?.id === id || undefined}
                data-bad={drag?.id === id && !drag.ok ? '' : undefined}
                style={{ gridColumn: `${r.x + 1} / span ${r.w}`, gridRow: `${r.y + 1} / span ${r.h}` }}
              >
                {!locked && (
                  <div className="dash-card-bar" onPointerDown={(e) => startPointer(e, id, 'move')} title="拖动卡片">
                    <GripHorizontal size={13} />
                    <button
                      className="dash-card-del"
                      title="删除这张卡片"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => removeCard(id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
                <div className="dash-card-body">
                  {widget?.kind === 'view'
                    ? <ViewCard dashLeafId={leaf.id} dashPath={dashPath} blockId={id} opts={widget.opts} onClose={() => removeCard(id)} />
                    : widget ? <WidgetCard widget={widget} />
                    : <BlockHost blockId={id} readOnly={locked} />}
                </div>
                {!locked && <div className="dash-card-resize" onPointerDown={(e) => startPointer(e, id, 'resize')} title="缩放" />}
              </div>
            )
          })}
        </div>
      </DndContext>

      {noteMenu && (
        <>
          <div className="dash-menu-scrim" onClick={() => setNoteMenu(null)} />
          <div ref={noteMenuFix.ref} className="dash-add-menu" style={{ position: 'fixed', left: noteMenu.x, top: noteMenu.y, ...noteMenuFix.style }}>
            <button
              onClick={() => {
                setNoteMenu(null)
                void (async () => {
                  const name = (await askString('重命名仪表盘', dashBaseName(dashPath)))?.trim().replace(/[\\/]/g, '')
                  if (!name) return
                  // renamePage 只换 basename;`.dashboard.md` 复合后缀要自己带上,丢了就掉出仪表盘判定。
                  const ok = await store.getState().renamePage(`${name}.dashboard`)
                  // 认领新路径:取 store 落定的 activePage(主进程可能改名去重),别自己拼。
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
                  // ⚠️ 必须把这个 leaf 关掉:deletePage 会把同一份 store 导航到下一篇笔记,
                  // 而 leaf 还攥着 dashPath —— 留着它,后续「添加卡片/重命名」就作用到别人的笔记上;
                  // 重挂时 loadPage(已删路径) 还会走「缺文件即新建」把它复活(Codex 评审实证)。
                  const err = store.getState().error
                  if (err) { useApp.getState().toast(`删除失败:${err}`, true); return }
                  useApp.getState().toast('已删除')
                  useWorkspace.getState().closeLeaf(leaf.id)
                })
              }}
            >
              删除
            </button>
          </div>
        </>
      )}
      {shareCard && <ShareCard path={dashPath} anchor={shareCard} onClose={() => setShareCard(null)} />}
    </div>
  )
}

/** 视图卡片:把**任意已注册视图**(日历 / 待办 / 收件箱 / 活动日志 / 插件视图……)活化在格子里。
 *  卡片源码 = ```view 围栏,`type:` 记注册键,其余键即该视图的 params。
 *
 *  做法是合成一个 Leaf 句柄喂给视图工厂 —— 视图不知道自己在仪表盘里,照常按 leaf.id 建作用域、
 *  按 leaf.params 重建状态。三条刻意的取舍:
 *  · leaf.id 不在 mainTabs 里:视图里那些「我是不是当前活动 tab」的判定一律得 false。这是对的 ——
 *    卡片不是 tab,不该去抢活动作用域(如 setActivePageScope)、也不该被当成导航目标。
 *  · setParams 写回卡片源码 → 随笔记落盘、重启还原;**只落标量**(源码是给人读的纯文本)。
 *  · 不认 singleton:那是「开 tab」的约束;一份仪表盘里放两张日历是合理需求。 */
function ViewCard({ dashLeafId, dashPath, blockId, opts, onClose }: {
  dashLeafId: string
  dashPath: string
  blockId: string
  opts: Record<string, string>
  onClose: () => void
}) {
  const store = useScopedPageStore()
  const type = opts.type ?? ''
  const [, force] = useState(0)
  // 插件视图可能晚于本卡片注册(插件在运行期 registerView)→ 订阅注册表,否则永远停在「不可用」。
  useEffect(() => subscribeViews(() => force((n) => n + 1)), [])
  // onClose 每帧新身份 → 走 ref,免得 leaf 跟着换身份(视图里以 leaf 为依赖的 effect 会空转)。
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // parseWidget 每次都产新对象,同样不能直接当依赖 —— 用序列化值(opts 全是字符串,round-trip 安全)。
  const optsKey = JSON.stringify(opts)
  const params = useMemo(() => {
    const { type: _t, ...rest } = JSON.parse(optsKey) as Record<string, string>
    return rest as Record<string, unknown>
  }, [optsKey])

  const leaf = useMemo<Leaf>(() => ({
    id: `${dashLeafId}::${blockId}`,
    type,
    loc: 'main',
    params,
    setTitle: () => {}, // 卡片没有标题栏可写
    setParams: (p) => {
      const st = store.getState()
      if (st.activePage !== dashPath) return // 换页/已删 → 绝不写进别人的笔记
      const next: Record<string, string> = { type }
      for (const [k, v] of Object.entries(p)) {
        // ponytail: 只落标量。视图想存复杂状态自己找地方(它本来就有自己的 store)。
        if (k !== 'type' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) next[k] = String(v)
      }
      const src = widgetSource('view', next)
      if ((st.blocks[blockId]?.content ?? '').trim() === src) return // 没变就不写(堵住写盘自激)
      st.setBlockContent(blockId, src)
    },
    close: () => closeRef.current(),
  }), [dashLeafId, dashPath, blockId, type, params, store])

  if (!type) return <div className="dash-widget"><div className="dash-widget-note">卡片源码里缺 `type:`(视图注册键)</div></div>
  const def = getView(type)
  if (!def) return <div className="dash-widget"><div className="dash-widget-note">视图「{type}」不可用 —— 可能来自未启用的插件</div></div>
  // 复用引擎的 .wb-view(满高 flex 列 + 自身滚动):视图在卡片里拿到的尺寸语义与在 tab 里一致。
  return <div className="wb-view dash-viewcard">{def.factory({ leaf, params })}</div>
}
