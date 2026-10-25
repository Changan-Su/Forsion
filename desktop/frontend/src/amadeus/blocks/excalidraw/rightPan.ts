/** 白板空白处右键按住拖 = 平移(10-24 三张画布统一方案 B:与 Tangu 画布 / Amadeus 画布同一套规则)。
 *
 *  规则:**空白处**(没压在任何元素上)右键按下 → 过 RIGHT_SLOP 才算拖,拖 = 平移视口;没拖就松开 = 弹引擎自己的
 *  画布菜单(松开时,不是按下时)。压在元素上右键一字不动,照旧归引擎(先选中再弹元素菜单)。
 *
 *  做法:在 `.amx-boardhost` 上挂**原生捕获期**监听。React 的 onPointerDown / onContextMenu 是从根容器的**冒泡期**
 *  监听派发的,宿主在它们和画布之间,捕获期 stopPropagation = 引擎整笔看不见这一按(不进 gesture 表、不置
 *  cursorButton、不聚焦),于是不存在「引擎以为还按着」的半截状态。平移走公开的 updateScene(scrollX/Y),
 *  与 ExcalidrawCanvas 的 clampView / onScrollChange 同一条路(纸张边界照钳)。没拖松开时向画布补派一个
 *  contextmenu,由引擎的 handleCanvasContextMenu 自己判 element / canvas、自己定位 —— 菜单仍是引擎那份。
 *
 *  ⚠️ 不能用 fork 自带的 settings.panWithRightMouseButton:那一档是**任何地方**右键都平移(压在元素上也是),
 *     并且整个关掉右键菜单、改用 M 键开(见引擎 handleCanvasPointerDown / handleCanvasContextMenu 里的 wC())。
 *  ⚠️ 「空白」是**近似**的(引擎的命中函数不导出,见 hitsElement):判错的代价只在「拖了平不平移、菜单在按下还是
 *     松开时弹」—— 没拖松开补派的那一下 contextmenu 由引擎自己判 element / canvas,选中与菜单内容恒是引擎的答案。
 *  ⚠️ 系统的 contextmenu:macOS / Linux 在按下时就发(拖动期间那一下在宿主捕获期拦掉);Windows 在松开后才补发,
 *     常落在刚弹出的引擎菜单上 —— 窗口捕获期只吞**这一次按压**的那一下(400ms / 8px 内)。 */
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { CaptureUpdateAction, getCommonBounds } from './forkRuntime'

/** 移动超过这么多屏幕像素才算拖(手抖一下照样是「右键点一下」,松开出菜单)。与另两张画布同值。 */
const RIGHT_SLOP = 4
/** 命中容差(屏幕像素):描边附近这么远都算压在元素上(引擎自己的命中阈值、描边宽度都在这里面)。 */
const HIT_PAD = 12

type Box = readonly [number, number, number, number]
type SceneEl = ReturnType<ExcalidrawImperativeAPI['getSceneElements']>[number]

/** 点到线段的距离 ≤ r。 */
function nearSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t)) <= r
}

/** 场景点 (x, y) 压不压在这个元素上 —— 照引擎的口径**近似**:实心(有填充的形状 / 文字 / 图片 / 嵌入)= 盒内;
 *  空心形状与 Frame = 只有描边附近(引擎同样不认空心形状的内部,那里右键出的是画布菜单);线 / 箭头 / 手绘 = 折线附近。
 *  旋转先抵掉(绕元素中心转回去)。近似只影响「拖了平不平移、菜单在按下还是松开时弹」,菜单本身恒由引擎自己判。 */
function hitsElement(el: SceneEl, x: number, y: number, pad: number): boolean {
  // 线 / 箭头 / 手绘的点(相对 el.x / el.y);其余元素没有 points
  const raw: unknown = 'points' in el ? el.points : null
  const pts = Array.isArray(raw) && raw.length ? (raw as ReadonlyArray<readonly [number, number]>) : null
  let cx = el.x + el.width / 2
  let cy = el.y + el.height / 2
  if (pts) {
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    cx = el.x + (Math.min(...xs) + Math.max(...xs)) / 2
    cy = el.y + (Math.min(...ys) + Math.max(...ys)) / 2
  }
  const a = -(el.angle || 0)
  const dx = x - cx
  const dy = y - cy
  const lx = cx + dx * Math.cos(a) - dy * Math.sin(a)
  const ly = cy + dx * Math.sin(a) + dy * Math.cos(a)
  if (pts) {
    if (pts.length === 1) return Math.hypot(lx - el.x - pts[0][0], ly - el.y - pts[0][1]) <= pad
    for (let i = 0; i + 1 < pts.length; i++) {
      if (nearSeg(lx, ly, el.x + pts[i][0], el.y + pts[i][1], el.x + pts[i + 1][0], el.y + pts[i + 1][1], pad)) return true
    }
    return false
  }
  const x0 = Math.min(el.x, el.x + el.width)
  const x1 = Math.max(el.x, el.x + el.width)
  const y0 = Math.min(el.y, el.y + el.height)
  const y1 = Math.max(el.y, el.y + el.height)
  if (lx < x0 - pad || lx > x1 + pad || ly < y0 - pad || ly > y1 + pad) return false
  const solid = el.type === 'text' || el.type === 'image' || el.type === 'embeddable' || el.type === 'iframe'
    || (!!el.backgroundColor && el.backgroundColor !== 'transparent')
  if (solid) return true
  // 空心:只有描边附近算。椭圆 / 菱形的描边不贴着包围盒(对角处缩进去好几十 px),按各自的轮廓量(Codex 评审 10-24)
  const hx = (x1 - x0) / 2
  const hy = (y1 - y0) / 2
  const mx = x0 + hx
  const my = y0 + hy
  if (el.type === 'ellipse' && hx > 0 && hy > 0) {
    // 沿中心射线到轮廓的距离(轮廓附近足够准):|d − d / r|,r = 归一化半径
    const d = Math.hypot(lx - mx, ly - my)
    const r = Math.hypot((lx - mx) / hx, (ly - my) / hy)
    return r === 0 ? Math.min(hx, hy) <= pad : Math.abs(d - d / r) <= pad
  }
  if (el.type === 'diamond') {
    const v: Array<[number, number]> = [[mx, y0], [x1, my], [mx, y1], [x0, my]]
    return v.some((p, i) => nearSeg(lx, ly, p[0], p[1], v[(i + 1) % 4][0], v[(i + 1) % 4][1], pad))
  }
  return !(lx > x0 + pad && lx < x1 - pad && ly > y0 + pad && ly < y1 - pad) // 矩形 / Frame:落在内圈 = 不算
}

export function installBoardRightPan(host: HTMLElement, api: ExcalidrawImperativeAPI): () => void {
  let drag: { id: number; x0: number; y0: number; lx: number; ly: number; live: boolean; ctxSeen: boolean; canvas: HTMLCanvasElement } | null = null
  /** 松开时按下期间还没来过 contextmenu(Windows):记下松开的时刻与位置,补发的那一下在窗口捕获期吞掉。 */
  let trailing: { t: number; x: number; y: number } | null = null
  /** 我们自己补派给引擎的那一下 contextmenu 正在派发:两道拦截都得放行。 */
  let replaying = false

  /** 这一按归不归我们:鼠标右键、落在交互画布上、引擎此刻没有进行中的编辑 / 绘制、且没压在任何元素上。 */
  const blankCanvas = (e: PointerEvent): HTMLCanvasElement | null => {
    if (e.button !== 2 || e.pointerType !== 'mouse') return null
    const t = e.target
    if (!(t instanceof HTMLCanvasElement) || !t.classList.contains('excalidraw__canvas') || !t.classList.contains('interactive')) return null
    const st = api.getAppState()
    // 查看模式归引擎(那里任何键拖都是平移);编辑文字 / 画到一半 / 正在框选 / 缩放旋转 / 裁图中:都不抢
    if (st.viewModeEnabled || st.editingTextElement || st.newElement || st.multiElement || st.selectionElement
      || st.isResizing || st.isRotating || st.croppingElementId) return null
    const z = st.zoom.value
    // 与引擎的 viewportCoordsToSceneCoords 同式(它自己的命中就是这么折的)
    const x = (e.clientX - st.offsetLeft) / z - st.scrollX
    const y = (e.clientY - st.offsetTop) / z - st.scrollY
    const pad = HIT_PAD / z
    const els = api.getSceneElements()
    if (els.some((el) => hitsElement(el, x, y, pad))) return null
    // 选中元素的公共包围盒里右键,引擎也算「元素」(isHittingCommonBoundingBoxOfSelectedElements)
    const sel = els.filter((el) => st.selectedElementIds[el.id])
    if (sel.length) {
      const b = getCommonBounds(sel) as Box
      if (x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad) return null
    }
    return t
  }

  const end = (): void => {
    drag = null
    delete host.dataset.rpan
  }

  const onDown = (e: PointerEvent): void => {
    if (drag) {
      // 右键拖着的时候别的指针 / 别的键一概不接(松开再说),免得引擎在半截状态里起一笔
      if (e.pointerId !== drag.id) e.stopPropagation()
      return
    }
    const canvas = blankCanvas(e)
    if (!canvas) return
    e.stopPropagation()
    const st = api.getAppState()
    // 引擎自己的按下会先关掉开着的菜单;这一下它看不见,替它关
    if (st.contextMenu) api.updateScene({ appState: { contextMenu: null }, captureUpdate: CaptureUpdateAction.NEVER })
    try { host.setPointerCapture(e.pointerId) } catch { /* 合成事件可没有有效 id */ }
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, live: false, ctxSeen: false, canvas }
  }
  const onMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    e.stopPropagation()
    const dx = e.clientX - drag.x0
    const dy = e.clientY - drag.y0
    if (!drag.live) {
      if (Math.hypot(dx, dy) <= RIGHT_SLOP) return
      drag.live = true
      host.dataset.rpan = '' // 握紧抓手(styles.css)
    }
    // 增量式(与引擎自己的 startRightClickPanning 同):按着右键时滚轮缩放 / 纸张钳制改了视口,下一帧从**当下**的视口接着走,
    // 不从按下那一刻的快照重算 —— 那样会把缩放的锚点调整整个盖掉,视口一跳(Codex 评审 10-24)。
    const st = api.getAppState()
    const z = st.zoom.value
    const mx = e.clientX - drag.lx
    const my = e.clientY - drag.ly
    drag.lx = e.clientX
    drag.ly = e.clientY
    api.updateScene({
      appState: { scrollX: st.scrollX + mx / z, scrollY: st.scrollY + my / z },
      captureUpdate: CaptureUpdateAction.NEVER, // 视口不进撤销栈
    })
  }
  const onUp = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    e.stopPropagation()
    const d = drag
    end()
    try { if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId) } catch { /* 同上 */ }
    if (!d.ctxSeen) trailing = { t: performance.now(), x: e.clientX, y: e.clientY }
    if (d.live) return
    // 没拖 = 右键点了一下空白:这时才让引擎开它的画布菜单(它自己判类型、自己定位)
    replaying = true
    try {
      d.canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2 }))
    } finally {
      replaying = false
    }
  }
  const onCancel = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    end()
  }
  /** 窗口失焦(Cmd+Tab)时按钮可能在别处松开、pointerup 永远不来:收尾,别让之后空手移动还在平移。 */
  const onBlur = (): void => {
    if (!drag) return
    const id = drag.id
    end()
    try { if (host.hasPointerCapture(id)) host.releasePointerCapture(id) } catch { /* 同上 */ }
  }
  /** 宿主捕获期:按着(macOS / Linux 按下就发)的那一下 contextmenu 拦掉,并记下已经来过。 */
  const onCtx = (e: MouseEvent): void => {
    if (replaying || !drag) return
    drag.ctxSeen = true
    e.preventDefault()
    e.stopPropagation()
  }
  /** 窗口捕获期:Windows 松开后补发的那一下(只认这次按压的:400ms / 8px 内),别让它把刚开的引擎菜单关掉 / 在拖完后弹出菜单。 */
  const onWinCtx = (e: MouseEvent): void => {
    if (replaying) return
    const tr = trailing
    if (!tr) return
    trailing = null
    if (performance.now() - tr.t > 400 || Math.hypot(e.clientX - tr.x, e.clientY - tr.y) > 8) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  host.addEventListener('pointerdown', onDown, true)
  host.addEventListener('pointermove', onMove, true)
  host.addEventListener('pointerup', onUp, true)
  host.addEventListener('pointercancel', onCancel, true)
  host.addEventListener('lostpointercapture', onCancel, true)
  host.addEventListener('contextmenu', onCtx, true)
  window.addEventListener('contextmenu', onWinCtx, true)
  window.addEventListener('blur', onBlur)
  return () => {
    end()
    host.removeEventListener('pointerdown', onDown, true)
    host.removeEventListener('pointermove', onMove, true)
    host.removeEventListener('pointerup', onUp, true)
    host.removeEventListener('pointercancel', onCancel, true)
    host.removeEventListener('lostpointercapture', onCancel, true)
    host.removeEventListener('contextmenu', onCtx, true)
    window.removeEventListener('contextmenu', onWinCtx, true)
    window.removeEventListener('blur', onBlur)
  }
}
