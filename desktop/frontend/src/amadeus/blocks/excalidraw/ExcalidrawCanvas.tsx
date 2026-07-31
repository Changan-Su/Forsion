/** 真画布。这里是**唯一**静态 import @excalidraw/excalidraw 的地方(整包 ~1MB + 它的 CSS),
 *  由 ExcalidrawEmbed 经 React.lazy 隔成独立 chunk —— 不含画板的笔记一个字节都不加载。
 *  语言包是包内动态 import('./locales/*.js'),vite 自会分块,无需自托管(字体才需要,见 ExcalidrawEmbed)。
 *  远端合并(reconcile+restoreElements+updateScene)也必须留在本 chunk 内 —— drawingStore 在启动
 *  bundle 里,绝不能 import 这个包;它只经 registerApplier 拿到一个闭包。 */
import { Excalidraw, MainMenu, serializeAsJSON, restoreElements, newElementWith, CaptureUpdateAction } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { UI_ZOOM_EVENT } from '@lcl/engine'
import type { AppState, ExcalidrawInitialDataState, ExcalidrawImperativeAPI, BinaryFileData } from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { reconcileElements, sameElements, type SceneElement, type SceneLike } from '@amadeus-shared/excalidraw/reconcile'
import {
  clampViewport,
  elementBounds,
  pageRange,
  pageRect,
  paperSize,
  reflowPoint,
  PAPER_IDS,
  DEFAULT_STEP,
  type BoardSettings,
  type Bounds,
} from '@amadeus-shared/excalidraw/board'

/** 紧凑(tray)面板是**显示偏好**不是文档内容 → 全局一份,localStorage;多个白板同时开着要一起变,
 *  所以走 useSyncExternalStore 而不是各自的 useState。 */
const COMPACT_KEY = 'amx.boardCompact'
const compactSubs = new Set<() => void>()
/** 内存态优先:localStorage 写不进去(隐私模式/配额满)时,开关本次会话内仍然生效 —— 只落在 storage 上
 *  的话,通知发出去 React 回读的还是旧值,表现就是「勾了没反应」。 */
let compactMem: boolean | null = null
const getCompact = (): boolean => {
  if (compactMem !== null) return compactMem
  try {
    return localStorage.getItem(COMPACT_KEY) === '1'
  } catch {
    return false
  }
}
const setCompact = (v: boolean): void => {
  compactMem = v
  try {
    localStorage.setItem(COMPACT_KEY, v ? '1' : '0')
  } catch {
    /* 存不下就只活在本次会话 */
  }
  for (const f of compactSubs) f()
}
const subscribeCompact = (f: () => void): (() => void) => {
  compactSubs.add(f)
  return () => compactSubs.delete(f)
}

/** 线距小于这个屏幕像素就不画:再密就是一片糊(excalidraw 自带网格同款下限)。 */
const MIN_VISIBLE_PX = 4
const V_GRAD = 'linear-gradient(90deg, var(--amx-grid-line) 0 1px, transparent 1px)'
const H_GRAD = 'linear-gradient(180deg, var(--amx-grid-line) 0 1px, transparent 1px)'

const clampNum = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)
const mod = (a: number, n: number): number => ((a % n) + n) % n

export default function ExcalidrawCanvas({
  initialData,
  theme,
  langCode,
  settings,
  onSettings,
  onSceneChange,
  registerApplier,
}: {
  initialData: ExcalidrawInitialDataState
  theme: 'light' | 'dark'
  langCode: string
  settings: BoardSettings
  /** 只传**改动的字段**:两次点击间设置还没落盘,传整份会把上一次改回去(见 drawingStore.setSettings)。 */
  onSettings: (patch: Partial<BoardSettings>) => void
  onSceneChange: (sceneJson: string) => void
  /** drawingStore 的远端应用器挂钩:外部变更(watcher/SSE)到达时把远端场景元素级合并进活画布。 */
  registerApplier?: (fn: (remote: SceneLike) => void) => () => void
}): React.JSX.Element {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const gridRefs = useRef<(HTMLDivElement | null)[]>([])
  const matteRef = useRef<HTMLDivElement>(null)
  const addBeforeRef = useRef<HTMLDivElement>(null)
  const addAfterRef = useRef<HTMLDivElement>(null)
  const clamping = useRef(false)
  const [layerHost, setLayerHost] = useState<HTMLElement | null>(null)
  /** 内容包围盒 → 该渲染哪几页。**两头各多留一张空白页**,所以往上/往下都永远还有一张能接着画。 */
  const [bounds, setBounds] = useState<Bounds | null>(null)
  // memo 住:range 是 layout 的依赖,每次渲染换个新对象会让下面那条 effect 白跑一遍
  const range = useMemo(() => (paperSize(settings) ? pageRange(settings, bounds) : { min: 0, max: 0 }), [settings, bounds])
  const pages = useMemo(() => Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i), [range])
  /** 内容 + 第 0 页决定的**页数下限**:删页按钮删到这儿就到底了,再删会把已画的东西甩到页外。 */
  const floor = useMemo(() => pageRange({ ...settings, pageFirst: 0, pageLast: 0 }, bounds), [settings, bounds])
  const compact = useSyncExternalStore(subscribeCompact, getCompact, getCompact)

  useEffect(() => {
    if (!api || !registerApplier) return
    return registerApplier((remote) => {
      const live = api.getSceneElementsIncludingDeleted() as unknown as SceneElement[]
      const merged = reconcileElements(live, remote.elements ?? [])
      if (sameElements(merged, live)) return // 已收敛:零动作,斩断「合并→onChange→写盘→回声」链
      api.updateScene({
        elements: restoreElements(merged as unknown as OrderedExcalidrawElement[], null),
        captureUpdate: CaptureUpdateAction.NEVER, // 远端笔画不进本端 undo 栈
      })
      const files = Object.values(remote.files ?? {})
      if (files.length) api.addFiles(files as BinaryFileData[])
    })
  }, [api, registerApplier])

  // 纸张/网格两层 portal 进 <Excalidraw> 内部(见 amadeus-host.css 的长注释):
  // - 载体用 display:contents,**不能**是个带 z-index 的盒子 —— 那会新建层叠上下文,网格的
  //   mix-blend-mode 就只在容器内部混合,画布看不见,网格立刻退化成一层灰蒙。
  // - 插在最前:z-index 3 压过两张画布(1/2),而 DOM 靠前让位给 wysiwyg(3)与 UI(4)。
  // ⚠️ 必须挂在 [api] 上而不是 []:<Excalidraw> 首帧渲染的是 LoadingMessage(等语言包),
  //    `.excalidraw` 那一刻**还不在 DOM 里** —— mount 时查一次必然落空,两层从此永不出现。
  //    excalidrawAPI 回调是在真 App 挂载后才来的,拿它当「DOM 就绪」的信号。
  useEffect(() => {
    const root = api && hostRef.current?.querySelector('.excalidraw')
    if (!root) return
    const node = document.createElement('div')
    node.style.display = 'contents'
    root.insertBefore(node, root.firstChild)
    setLayerHost(node)
    return () => {
      node.remove()
      setLayerHost(null)
    }
  }, [api])

  const layout = useCallback(
    (st: Pick<AppState, 'scrollX' | 'scrollY' | 'zoom'>) => {
      const matte = matteRef.current
      const grids = gridRefs.current.filter((g): g is HTMLDivElement => !!g)
      if (!matte || !grids.length) return
      const z = st.zoom.value
      const paper = paperSize(settings)
      const vStep = settings.gridV * z
      const hStep = settings.gridH * z

      // 网格铺法:有纸张时每层就是一整页 → 页内从 0 起铺;无限画布时整屏铺、按滚动取模。
      const bg: string[] = []
      const bs: string[] = []
      const bp: string[] = []
      const ox = paper || vStep < MIN_VISIBLE_PX ? 0 : mod(st.scrollX * z, vStep)
      const oy = paper || hStep < MIN_VISIBLE_PX ? 0 : mod(st.scrollY * z, hStep)
      if (vStep >= MIN_VISIBLE_PX) {
        bg.push(V_GRAD)
        bs.push(`${vStep}px 100%`)
        bp.push(`${ox}px 0px`)
      }
      if (hStep >= MIN_VISIBLE_PX) {
        bg.push(H_GRAD)
        bs.push(`100% ${hStep}px`)
        bp.push(`0px ${oy}px`)
      }
      for (const g of grids) {
        g.style.backgroundImage = bg.join(', ')
        g.style.backgroundSize = bs.join(', ')
        g.style.backgroundPosition = bp.join(', ')
        // 淡化网格 = 直接调这层的 opacity(混合前先按 alpha 衰减,正好就是「线变淡」)。
        // 自身 opacity 不影响 mix-blend-mode —— 被禁的是拿**父容器**造层叠上下文。
        g.style.opacity = settings.gridOpacity >= 100 ? '' : String(settings.gridOpacity / 100)
        // 没网格但有纸张时也要留着:那圈 1px box-shadow 就是纸边。
        g.style.display = bg.length || paper ? '' : 'none'
      }

      if (!paper) {
        Object.assign(grids[0].style, { left: '0px', top: '0px', width: '100%', height: '100%' })
        matte.style.display = 'none'
        return
      }
      // 「新建页面」贴在页带两端外侧的余量里(钳制留了 6% 的余量,所以滚得到)
      const put = (el: HTMLDivElement | null, r: { x: number; y: number; w: number; h: number }, after: boolean): void => {
        if (!el) return
        const l = (r.x + st.scrollX) * z
        const t = (r.y + st.scrollY) * z
        const pad = 22
        const ax = settings.flow === 'h' ? (after ? l + r.w * z + pad : l - pad) : l + (r.w * z) / 2
        const ay = settings.flow === 'h' ? t + (r.h * z) / 2 : after ? t + r.h * z + pad : t - pad
        el.style.left = `${ax}px`
        el.style.top = `${ay}px`
      }
      // viewportX = (sceneX + scrollX) * zoom
      const holes: string[] = []
      for (let i = 0; i < grids.length; i++) {
        const r = pageRect(settings, range.min + i)
        if (!r) continue
        const l = (r.x + st.scrollX) * z
        const t = (r.y + st.scrollY) * z
        const w = r.w * z
        const h = r.h * z
        Object.assign(grids[i].style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` })
        holes.push(`M${l.toFixed(1)} ${t.toFixed(1)}H${(l + w).toFixed(1)}V${(t + h).toFixed(1)}H${l.toFixed(1)}Z`)
      }
      const firstR = pageRect(settings, range.min)
      const lastR = pageRect(settings, range.max)
      if (firstR) put(addBeforeRef.current, firstR, false)
      if (lastR) put(addAfterRef.current, lastR, true)
      matte.style.display = ''
      // evenodd 挖洞:洞被裁掉 → 不参与命中测试,事件穿到画布;洞外保留 → 事件被本层吃掉 = 越界不可画。
      // ⚠️ 多页必须用 path() 而不是 polygon():polygon() 只有一条子路径,挖不出第二个洞。
      // ponytail: 拦的是**起手**。从纸内起手再拖出界,指针已被 excalidraw 捕获(它监听 window),
      //   那一笔仍会越过纸边(视觉上被遮罩盖住,数据里越界)。真要一刀切,得按纸张裁剪元素包围盒 ——
      //   那是在改用户内容,没做。
      matte.style.clipPath = `path(evenodd,"M0 0H${matte.offsetWidth}V${matte.offsetHeight}H0Z ${holes.join(' ')}")`
    },
    [settings, range],
  )

  /** 纸张硬边界:算在 board.clampViewport(纯函数,board.test.ts 钉死不动点),这里只负责下发。
   *  返回**钳制后**的视口(没越界就原样返回),调用方拿它去排层。
   *  ⚠️ 必须**同步**下发,不许等下一帧:等一帧 = 越界的那一帧真的画出去了,贴着纸边推的时候
   *     就是一路「推出去→弹回来」的闪烁拖影。同理层也得用钳制后的值排,否则层自己先漂出去。 */
  const clampView = useCallback(
    (view: { scrollX: number; scrollY: number; zoom: AppState['zoom'] }) => {
      if (!api || clamping.current) return view // 正在下发,别自激
      const st = api.getAppState()
      // ⚠️ 按着鼠标时绝不纠偏:excalidraw 是按**当下的** scrollX/zoom 把指针换算成场景坐标的,
      //    半途改视口 = 正在画的那一笔从光标底下滑开(表现就是「光标和实际作用位置偏移」)。
      //    松手后 cursorButton 翻回 up 会再来一次事件,那时补纠。
      if (st.cursorButton === 'down') return view
      const next = clampViewport(settings, { scrollX: view.scrollX, scrollY: view.scrollY, zoom: view.zoom.value, width: st.width, height: st.height }, bounds)
      if (!next) return view
      clamping.current = true
      try {
        api.updateScene({
          appState: { scrollX: next.scrollX, scrollY: next.scrollY, zoom: { value: next.zoom as AppState['zoom']['value'] } },
          captureUpdate: CaptureUpdateAction.NEVER, // 视口纠偏不进 undo 栈
        })
      } finally {
        clamping.current = false
      }
      return { scrollX: next.scrollX, scrollY: next.scrollY, zoom: { value: next.zoom } as AppState['zoom'] }
    },
    [api, settings, bounds],
  )

  /** 页数由内容自己长出来:内容占到哪,两头各留一张空白页(见 board.pageRange)。 */
  const syncRange = useCallback(
    (els: readonly { x: number; y: number; width?: number; height?: number; isDeleted?: boolean }[]) => {
      const b = elementBounds(els)
      setBounds((cur) =>
        cur && b && cur.minX === b.minX && cur.minY === b.minY && cur.maxX === b.maxX && cur.maxY === b.maxY ? cur : b,
      )
    },
    [],
  )

  /** 换排布方向 = **搬用户内容**:每个元素跟着它所在的那一页走,页内偏移不变。
   *  进 undo 栈(IMMEDIATELY),后悔了 ⌘Z 就能回去。首次挂载不跑 —— 只认真正的切换。 */
  const prevFlow = useRef(settings.flow)
  useEffect(() => {
    const from = prevFlow.current
    const to = settings.flow
    prevFlow.current = to
    if (from === to || !api || !settings.paper) return
    const els = api.getSceneElements()
    if (!els.length) return
    api.updateScene({
      elements: els.map((el) => {
        const p = reflowPoint(settings, from, to, el.x, el.y)
        return p.x === el.x && p.y === el.y ? el : newElementWith(el, { x: p.x, y: p.y })
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
  }, [api, settings])

  // 改设置后画布本身没动,onChange/onScrollChange 都不会来 —— 主动重排一次(顺带算一遍页数)。
  useEffect(() => {
    if (!api || !layerHost) return
    syncRange(api.getSceneElements())
    layout(clampView(api.getAppState()))
  }, [api, layerHost, layout, clampView, syncRange])

  // ⚠️ 端级 UI 缩放(uiZoom 的 body `zoom`)会把 excalidraw 的指针换算整个带偏:它拿
  //    getBoundingClientRect() 的值当 CSS 像素用,而 rect 已经被 zoom 缩放过 →
  //    落点误差 = 位置 × (zoom-1)/zoom(实测 zoom=1.1 时 500px 处偏 45px,且离原点越远越大)。
  //    我们自己的层用的是**未缩放的局部 px**,是对的,于是层和内容也就对不上了。
  //    修:在画布容器上反向抵消祖先的 zoom,让 excalidraw 永远跑在 zoom=1 的坐标系里。
  //    代价:白板自带 UI 不跟随 App 的界面缩放 —— 它有自己的画布缩放,可接受。
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const sync = (): void => {
      const z = (el.parentElement as (HTMLElement & { currentCSSZoom?: number }) | null)?.currentCSSZoom ?? 1
      el.style.zoom = Math.abs(z - 1) > 1e-6 ? String(1 / z) : ''
    }
    sync()
    window.addEventListener(UI_ZOOM_EVENT, sync)
    return () => window.removeEventListener(UI_ZOOM_EVENT, sync)
  }, [])

  // 画布尺寸变了(分栏拖动/窗口缩放),纸张的居中与钳制都得重算 —— 这条既不走 onChange 也不走 onScrollChange。
  useEffect(() => {
    const el = hostRef.current
    if (!el || !api || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => layout(clampView(api.getAppState())))
    ro.observe(el)
    return () => ro.disconnect()
  }, [api, layout, clampView])

  return (
    <div className={`amx-boardhost${compact ? ' amx-compact' : ''}`} ref={hostRef}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        theme={theme}
        langCode={langCode}
        // serializeAsJSON 出的正是 .excalidraw 的规范形状({type,version,source,elements,appState,files}),
        // 且自带 appState 裁剪(去掉 collaborators/选中态等瞬时字段)—— 别自己拼,拼不全也裁不干净。
        // 顺带一提:裁剪把 scrollX/zoom 也剪掉了,所以视口纠偏不会额外触发写盘。
        // ⚠️ onChange **只在场景(元素)变化时**来,平移/缩放一律不触发 —— 视口的活儿必须挂
        //    onScrollChange,否则一整趟平移里画布重画几十次而我们的层纹丝不动,内容就从纸和网格
        //    底下滑走(实测:25 次重画 / 0 次层更新)。这里保留一份是给 scrollToContent 之类
        //    「场景变了顺带动视口」的路径兜底,重复调用是幂等的。
        onScrollChange={(scrollX, scrollY, zoom) => layout(clampView({ scrollX, scrollY, zoom }))}
        onChange={(elements, appState, files) => {
          syncRange(elements)
          layout(clampView(appState))
          onSceneChange(serializeAsJSON(elements, appState, files, 'local'))
        }}
      >
        {/* 自带菜单照抄 0.18.1 的 DefaultMainMenu,只去掉 Socials(离线桌面端的官网外链没意义),
            末尾接上本 App 的纸张/网格面板 —— 用户要它跟「画布背景」在同一处。 */}
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.Separator />
          <MainMenu.ItemCustom>
              <BoardPanel settings={settings} onSettings={onSettings} compact={compact} onCompact={setCompact} />
          </MainMenu.ItemCustom>
        </MainMenu>
      </Excalidraw>
      {layerHost &&
        createPortal(
          <>
            <div className="amx-matte" ref={matteRef} onWheel={forwardWheel} />
            {/* 一页一层。⚠️ 绝不能拿个带 z-index 的容器把它们包起来 —— mix-blend-mode 会被隔离。 */}
            {pages.map((idx, i) => (
              <div
                key={idx}
                className="amx-grid"
                data-page={idx}
                ref={(el) => {
                  gridRefs.current[i] = el
                }}
              />
            ))}
            {/* 页带两端的「新建页面」。放在页外那圈余量里 —— 遮罩吃指针事件,所以它必须画在遮罩之后。 */}
            {!!paperSize(settings) && (
              <>
                <div className="amx-pageadd" data-end="before" data-flow={settings.flow} ref={addBeforeRef}>
                  <button onClick={() => onSettings({ pageFirst: settings.pageFirst - 1 })}>＋ 新建页面</button>
                  {settings.pageFirst < floor.min && (
                    <button className="amx-pageadd-del" title="删掉这张空白页" onClick={() => onSettings({ pageFirst: settings.pageFirst + 1 })}>
                      −
                    </button>
                  )}
                </div>
                <div className="amx-pageadd" data-end="after" data-flow={settings.flow} ref={addAfterRef}>
                  <button onClick={() => onSettings({ pageLast: settings.pageLast + 1 })}>＋ 新建页面</button>
                  {settings.pageLast > floor.max && (
                    <button className="amx-pageadd-del" title="删掉这张空白页" onClick={() => onSettings({ pageLast: settings.pageLast - 1 })}>
                      −
                    </button>
                  )}
                </div>
              </>
            )}
          </>,
          layerHost,
        )}
    </div>
  )
}

/** 遮罩要吃掉指针事件才能「越界不可画」,但滚轮缩放不该跟着死 —— 原样转投给交互画布。
 *  ponytail: 只转滚轮。在遮罩上起手的中键/空格平移仍会被吞,而遮罩被视口钳制成薄薄一圈,不值当再接。 */
function forwardWheel(e: React.WheelEvent<HTMLDivElement>): void {
  const canvas = e.currentTarget.closest('.excalidraw')?.querySelector('canvas.excalidraw__canvas.interactive')
  if (!canvas) return
  e.preventDefault()
  canvas.dispatchEvent(
    new WheelEvent('wheel', {
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      clientX: e.clientX,
      clientY: e.clientY,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function BoardPanel({
  settings,
  onSettings,
  compact,
  onCompact,
}: {
  settings: BoardSettings
  onSettings: (patch: Partial<BoardSettings>) => void
  compact: boolean
  onCompact: (v: boolean) => void
}): React.JSX.Element {
  const patch = onSettings
  return (
    <div className="amx-bs">
      <div className="amx-bs-h">纸张</div>
      <div className="amx-bs-row">
        <button className="amx-bs-chip" data-on={!settings.paper || undefined} onClick={() => patch({ paper: null })}>
          无限
        </button>
        {PAPER_IDS.map((p) => (
          <button key={p} className="amx-bs-chip" data-on={settings.paper === p || undefined} onClick={() => patch({ paper: p })}>
            {p}
          </button>
        ))}
      </div>
      {settings.paper && (
        <>
          <div className="amx-bs-row">
            <button className="amx-bs-chip" data-on={!settings.landscape || undefined} onClick={() => patch({ landscape: false })}>
              纵向
            </button>
            <button className="amx-bs-chip" data-on={settings.landscape || undefined} onClick={() => patch({ landscape: true })}>
              横向
            </button>
          </div>
          <div className="amx-bs-h">页面排布</div>
          <div className="amx-bs-row">
            <button className="amx-bs-chip" data-on={settings.flow === 'v' || undefined} onClick={() => patch({ flow: 'v' })}>
              上下
            </button>
            <button className="amx-bs-chip" data-on={settings.flow === 'h' || undefined} onClick={() => patch({ flow: 'h' })}>
              左右
            </button>
          </div>
        </>
      )}
      <div className="amx-bs-h">网格</div>
      <GridRow label="横线" value={settings.gridH} onChange={(v) => patch({ gridH: v })} />
      <GridRow label="竖线" value={settings.gridV} onChange={(v) => patch({ gridV: v })} />
      <OpacityRow
        value={settings.gridOpacity}
        disabled={settings.gridH <= 0 && settings.gridV <= 0}
        onCommit={(v) => patch({ gridOpacity: v })}
      />
      <label className="amx-bs-check">
        <input type="checkbox" checked={compact} onChange={(e) => onCompact(e.target.checked)} />
        <span className="amx-bs-lbl">紧凑面板</span>
        <span className="amx-bs-note">所有白板</span>
      </label>
    </div>
  )
}

/** 网格淡浓。拖动时直接改这几层的 opacity 拿实时预览,**松手才写盘** —— 每动一格写一次文件太蠢。 */
function OpacityRow({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (v: number) => void }): React.JSX.Element {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <label className="amx-bs-check">
      <span className="amx-bs-lbl">淡浓</span>
      <input
        className="amx-bs-range"
        type="range"
        min={10}
        max={100}
        step={5}
        disabled={disabled}
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value)
          setV(n)
          // 只改自己这块画布的层(同时开着别的白板时别串台)
          for (const g of e.currentTarget.closest('.excalidraw')?.querySelectorAll<HTMLElement>('.amx-grid') ?? []) {
            g.style.opacity = n >= 100 ? '' : String(n / 100)
          }
        }}
        onPointerUp={() => onCommit(v)}
        onKeyUp={() => onCommit(v)}
      />
      <span className="amx-bs-note">{v}%</span>
    </label>
  )
}

/** 开关与间距合一(0 = 关)。关掉时把间距留在本地 state 里,再打开还是原来那个值。 */
function GridRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }): React.JSX.Element {
  const [txt, setTxt] = useState(String(value || DEFAULT_STEP))
  useEffect(() => {
    if (value > 0) setTxt(String(value))
  }, [value])
  const commit = (): void => {
    const n = Math.round(Number(txt))
    const v = Number.isFinite(n) && n > 0 ? clampNum(n, 4, 400) : DEFAULT_STEP
    setTxt(String(v))
    if (value > 0 && v !== value) onChange(v)
  }
  return (
    <label className="amx-bs-check">
      <input
        type="checkbox"
        checked={value > 0}
        onChange={(e) => onChange(e.target.checked ? clampNum(Math.round(Number(txt)) || DEFAULT_STEP, 4, 400) : 0)}
      />
      <span className="amx-bs-lbl">{label}</span>
      <input
        className="amx-bs-num"
        type="number"
        min={4}
        max={400}
        disabled={value <= 0}
        value={txt}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      <span className="amx-bs-note">px</span>
    </label>
  )
}
