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
import { Cloud, Clock, CloudSun, Globe, GripHorizontal, Lock, MoreHorizontal, Pin, Plus, Share2, Trash2, Type, Unlock } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
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
import { useWorkspace } from '@lcl/engine'
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
  const [shareCard, setShareCard] = useState<{ x: number; y: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)

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
      const st = store.getState()
      if (st.activePage !== dashPath) return // 换页/已删 → 绝不往别人的笔记里插块
      const id = st.insertBlockAfter(null, undefined, content)
      if (!id) return
      const fresh = readDashLayout(store.getState().manifest?.fmExtra ?? '')
      if (!fresh.ok) return
      const spec = ADD_MENU.find((a) => a.key === kind)!
      applyLayout({ ...fresh.layout, [id]: findSlot(fresh.layout, spec.w, spec.h) })
    })()
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
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (locked || !files.length) return
        e.preventDefault()
        setDragOver(false)
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
                <div className="dash-add-menu">
                  {ADD_MENU.map((a) => (
                    <button key={a.key} onClick={() => addCard(a.key)}>
                      <a.icon size={13} /> {a.label}
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
                  {widget ? <WidgetCard widget={widget} /> : <BlockHost blockId={id} readOnly={locked} />}
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
          <div className="dash-add-menu" style={{ position: 'fixed', left: noteMenu.x, top: noteMenu.y }}>
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
