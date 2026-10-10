/** ctx.ui.mountBoard / boardToSvg 的实现:把白板引擎当成一张**透明、没有界面**的层挂进插件的元素。
 *
 *  和白板视图(ExcalidrawCanvas)的差别都在「谁说了算」:
 *  - 界面:`ui={false}`,工具栏 / 菜单 / 属性面板一概不画;工具由调用方定(`activeTool` 是受控的,引擎自己切不走)。
 *  - 视口:调用方给 `{ scrollX, scrollY, zoom }`,这里原样写进引擎;引擎自己想平移 / 缩放(空格拖、双指、快捷键)
 *    一律拉回来,滚轮事件在进引擎之前就截下交给调用方 —— 这一层盖在别人的内容上面,滚动归那份内容。
 *  - 背景:透明。纸张、网格、页带那些都是白板视图的东西,这里没有。
 *  - 界面缩放(body 上的 CSS zoom,用户按 ⌘+ 调的那个):和白板视图同一个办法 —— 引擎拿 getBoundingClientRect 的值当
 *    CSS 像素用,祖先带 zoom 时落点整体偏(110% 下实测偏 10%)。这里在自己的容器上反向抵消,让引擎永远跑在 zoom=1 里,
 *    再把调用方给的缩放乘回去。所以对调用方,视口始终是「el 自己的 CSS 像素」。
 *  笔还是白板那七支(pens.ts),套笔用的是白板笔排的同一个函数。
 */
import { useEffect, useRef } from 'react'
import { mountHostReact } from '@lcl/components'
import { UI_ZOOM_EVENT } from '@lcl/engine'
import { CaptureUpdateAction, Excalidraw, exportToSvg, getCommonBounds, restoreElements } from '../blocks/excalidraw/forkRuntime'
import { PENS, PEN_ORDER, type PenType } from '../blocks/excalidraw/pens'
import { applyPen, widthPatch } from '../blocks/excalidraw/PenRow'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { PluginBoardHandle, PluginBoardOptions, PluginBoardScene, PluginBoardSvg, PluginBoardTool, PluginBoardViewport } from './types'

const TOOLS: readonly PluginBoardTool[] = ['selection', 'freedraw', 'eraser', 'text', 'rectangle', 'ellipse', 'arrow', 'line']
/** 引擎的缩放上下限(forkRuntime 里那份宿主配置的 zoomMin / zoomMax)。超出的值引擎会自己钳,钳完又和调用方给的对不上。 */
const clampZoom = (z: number): number => Math.min(30, Math.max(0.1, z))
const hostTheme = (): 'light' | 'dark' => (document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light')
type AppPatch = Pick<AppState, keyof AppState>
type SceneElements = Parameters<typeof restoreElements>[0]

const live = (elements: readonly unknown[]): readonly unknown[] => elements.filter((e) => !(e as { isDeleted?: boolean }).isDeleted)
/** 元素有没有变:各元素 version 之和(删除也会涨 version)。只换视口 / 选中态不算变。 */
const versionOf = (elements: readonly unknown[]): number => elements.reduce<number>((n, e) => n + ((e as { version?: number }).version ?? 0), elements.length)

interface BoardProps {
  o: PluginBoardOptions
  /** 已经过引擎整理的初始元素(只算一次:它的 version 之和就是「还没人动过」的基准)。 */
  initial: SceneElements
  /** 插件那个元素身上的界面缩放(祖先的 CSS zoom 之积)。 */
  uiz: number
  bind(api: ExcalidrawImperativeAPI | null): void
  onElements(elements: readonly unknown[]): void
  /** 引擎自己动了视口。 */
  onDrift(): void
}

function Board({ o, initial, uiz, bind, onElements, onDrift }: BoardProps) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    // 捕获阶段截下:引擎的滚轮处理挂在它自己的容器上(原生监听),不能让事件走到那里。
    const wheel = (ev: WheelEvent): void => { ev.preventDefault(); ev.stopPropagation(); o.onWheel?.(ev) }
    el.addEventListener('wheel', wheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', wheel, { capture: true })
  }, [o])
  const tool = TOOLS.includes(o.tool as PluginBoardTool) ? o.tool! : 'freedraw'
  return (
    <div ref={box} className="am-plugin-board" style={{ width: `${uiz * 100}%`, height: `${uiz * 100}%`, zoom: uiz === 1 ? undefined : 1 / uiz }}>
      <Excalidraw
        // 不用 onExcalidrawAPI:它在引擎装载初始内容**之前**就来,那时推进去的内容 / 笔会被随后的装载冲掉(Codex 评审)。
        onInitialize={bind}
        ui={false}
        activeTool={{ type: tool }}
        theme={o.theme ?? hostTheme()}
        handleKeyboardGlobally={false}
        autoFocus={false}
        initialData={{
          elements: initial,
          files: (o.scene.files ?? {}) as BinaryFiles,
          appState: { viewBackgroundColor: 'transparent', scrollX: o.viewport.scrollX, scrollY: o.viewport.scrollY, zoom: { value: clampZoom(o.viewport.zoom * uiz) } } as unknown as AppState,
          scrollToContent: false,
        }}
        onScrollChange={(scrollX, scrollY, zoom) => {
          // 引擎自己动了视口(空格拖、双指、快捷键):拉回调用方给的那一个。
          const v = o.viewport
          if (Math.abs(scrollX - v.scrollX) > 1e-6 || Math.abs(scrollY - v.scrollY) > 1e-6 || Math.abs(zoom.value - clampZoom(v.zoom * uiz)) > 1e-9) queueMicrotask(onDrift)
        }}
        onChange={(elements) => onElements(elements)}
      />
    </div>
  )
}

export function mountPluginBoard(el: HTMLElement, initial: PluginBoardOptions): PluginBoardHandle {
  const o: PluginBoardOptions = { ...initial }
  let api: ExcalidrawImperativeAPI | null = null
  let alive = true
  const initialElements = restoreElements(live(o.scene.elements) as SceneElements, null)
  // 上一次「已经知道」的元素版本:引擎装好初始内容、我们自己推进去的内容,都不该当成用户的改动回调出去。
  let seen = versionOf(initialElements)
  // 元素没在渲染(祖先 display:none)时 currentCSSZoom 恒为 1,所以露出来 / 改了界面缩放都要再读一遍(见 syncZoom)。
  const readZoom = (): number => (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  let uiz = readZoom()

  const pushViewport = (): void => {
    api?.updateScene({
      appState: { scrollX: o.viewport.scrollX, scrollY: o.viewport.scrollY, zoom: { value: clampZoom(o.viewport.zoom * uiz) } } as unknown as AppPatch,
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }
  /** 套笔:先套这支笔自己的参数,调用方点名的颜色 / 粗细再盖上去。带填充色的笔(荧光笔、马克笔)填充跟着颜色走。 */
  const pushStyle = (): void => {
    if (!api) return
    const pen = PENS[PEN_ORDER.includes(o.pen as PenType) ? (o.pen as PenType) : 'default']
    applyPen(pen, api)
    const patch = {
      ...(o.strokeColor ? { currentItemStrokeColor: o.strokeColor, ...(pen.backgroundColor && pen.backgroundColor !== 'transparent' ? { currentItemBackgroundColor: o.strokeColor } : null) } : null),
      ...(o.strokeWidth ? widthPatch(o.strokeWidth) : null),
    }
    if (Object.keys(patch).length) api.updateScene({ appState: patch as unknown as AppPatch, captureUpdate: CaptureUpdateAction.NEVER })
  }
  /** 调用方换了一份内容。自己推进去的不回调 onChange(先记下它的版本)。 */
  let sceneStale = false
  const pushScene = (): void => {
    if (!api) { sceneStale = true; return } // 引擎还没装完初始内容:它起来用的是挂载时那份,装完再补推(见 bind)
    sceneStale = false
    const elements = restoreElements(live(o.scene.elements) as SceneElements, null)
    seen = versionOf(elements)
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })
    if (o.scene.files) api.addFiles(Object.values(o.scene.files as BinaryFiles))
  }
  const bind = (next: ExcalidrawImperativeAPI | null): void => {
    if (!alive) return
    api = next
    if (!api) return
    if (sceneStale) pushScene()
    pushStyle()
    pushViewport()
    o.onReady?.()
  }
  const onElements = (elements: readonly unknown[]): void => {
    if (!alive || !api) return
    const v = versionOf(elements)
    if (v === seen) return
    seen = v
    o.onChange?.({ elements: live(elements), files: api.getFiles() })
  }
  const tree = () => <Board o={o} initial={initialElements} uiz={uiz} bind={bind} onElements={onElements} onDrift={() => { if (alive) pushViewport() }} />
  const syncZoom = (): void => {
    const z = readZoom()
    if (!alive || Math.abs(z - uiz) < 1e-6) return
    uiz = z
    mount.render(tree())
    pushViewport()
  }
  window.addEventListener(UI_ZOOM_EVENT, syncZoom) // 改界面缩放不发 resize
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncZoom) // 从隐藏变可见必过一次 resize
  ro?.observe(el)
  // 收尾走同一处(自己 dispose、被同一个 el 上后来的挂载收掉、插件停用):先记下最后的样子,卸掉之后 getScene 还答得出。
  const mount = mountHostReact(el, tree(), () => {
    if (api) o.scene = { elements: api.getSceneElements(), files: api.getFiles() }
    alive = false
    api = null
    window.removeEventListener(UI_ZOOM_EVENT, syncZoom)
    ro?.disconnect()
  })

  return {
    update(patch) {
      if (!alive) return
      Object.assign(o, patch)
      if ('tool' in patch || 'theme' in patch) mount.render(tree())
      if (patch.scene) pushScene()
      if (!api) return // 笔和视口:引擎好了的那一刻按 o 里最新的套(见 bind)
      if ('pen' in patch || 'strokeColor' in patch || 'strokeWidth' in patch) pushStyle()
      if (patch.viewport) pushViewport()
    },
    getScene: () => (api ? { elements: api.getSceneElements(), files: api.getFiles() } : o.scene),
    undo() { api?.history.undo() },
    redo() { api?.history.redo() },
    dispose() { if (alive) mount.dispose() },
  }
}

export async function pluginBoardToSvg(scene: PluginBoardScene, opts?: { theme?: 'light' | 'dark'; padding?: number }): Promise<PluginBoardSvg | null> {
  const elements = restoreElements(live(scene.elements) as SceneElements, null)
  if (!elements.length) return null
  const padding = Math.max(0, opts?.padding ?? 8)
  const [x0, y0, x1, y1] = getCommonBounds(elements)
  const svg = await exportToSvg({
    elements,
    files: (scene.files ?? null) as BinaryFiles | null,
    appState: { exportBackground: false, viewBackgroundColor: 'transparent', exportWithDarkMode: (opts?.theme ?? hostTheme()) === 'dark', exportEmbedScene: false },
    exportPadding: padding,
    // 字体不内联进 SVG:这张图是放回同一个页面里的,引擎的字体已经在页面上;内联一次就是几百 KB。
    skipInliningFonts: true,
  })
  return { svg, x: x0 - padding, y: y0 - padding, width: x1 - x0 + padding * 2, height: y1 - y0 + padding * 2 }
}
