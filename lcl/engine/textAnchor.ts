/**
 * 文字锚点:浮层锚在「一段字」上(LCL 表面规范 · 划线菜单方案 B,2026-11-08;
 * 方案页 docs/ToBeImproved/划线菜单表面规范方案_2026-11-08/)。
 *
 * 划线条、结果卡、笔记格式栏都是「用途 = 工具条」:不抢焦点、锚在一段字上,**归属**是那段字所在的视图(owner),
 * **画在**窗口层(聊天区几层 container-type 圈住 fixed 后代,只能 portal 出去)。以前它们按松手那一刻量的快照摆,
 * 跟不了滚动,只能一滚就收;卡留在原处盖住别的字;视图被 Dockview 摘下时卡还浮在别的视图上。这里把「那段字现在在哪、
 * 看不看得见」变成一个能随时问的对象,摆位交给 menuAnchor 的 useClampedMenu / OverlayAt(`anchor` 选项)。
 *
 * - read():那段字露在屏上的部分(视口 px,已按滚动祖先裁过);null = 现在看不见 —— 滚出了可见区、视图被摘下 /
 *   藏起来 / 尺寸为 0。看不见只藏不收。
 * - lost():那段字没了(起止节点不在 owner 里了,而 owner 还在文档里 —— 消息被重渲染、笔记被改写)→ 调用方该收了。
 *   第一次发现时调 onLost(下一个微任务,不在别人的 layout effect 里 setState)。
 * - subscribe():滚动(捕获)、窗口尺寸、界面缩放、owner 尺寸变化 / 摘下挂回(ResizeObserver)、owner 里的内容变化、
 *   画布挪视口(`selbar:viewport-moved`)时通知,一帧合并一次 —— 和 lineSelection 的选区高亮同一套触发。
 *
 * ⚠️ 锚点记成「起止节点 + 偏移」,不存活的 Range:Dockview 把视图的 DOM 摘下时,活 Range 的端点会塌缩到容器上
 *    (DOM 的 removing steps),挂回来也回不去;节点对象本身还是那一批,所以每次现量时用它们重建一个 Range。
 */
import { makeClipper, type SelectionRect } from './lineSelection'
import { UI_ZOOM_EVENT } from './menuAnchor'
import './textAnchor.css'

export type AnchorRect = SelectionRect

export interface TextAnchor {
  /** 那段字露在屏上的部分(视口 px);null = 现在看不见(藏,不收)。 */
  read(): AnchorRect | null
  /** 那段字没了:调用方该收了。 */
  lost(): boolean
  subscribe(fn: () => void): () => void
  dispose(): void
}

export interface TextAnchorOptions {
  /** 那段字没了(第一次发现时,下一个微任务里调一次)。 */
  onLost?: () => void
}

/** 量一次:矩形(视口 px)+ 按谁的滚动祖先裁;null = 现在量不出来(看不见);'lost' = 那段字没了。 */
export type AnchorMeasure = () => { rect: AnchorRect; clipEl: Element } | null | 'lost'

const elementOf = (n: Node): Element | null => (n.nodeType === 1 ? (n as Element) : n.parentElement)
const nodeLength = (n: Node): number => (n.nodeType === 3 || n.nodeType === 8 ? (n as CharacterData).length : n.childNodes.length)

/** 露出来至少这么高才算看得见(1px 的边角不算;比这还矮的选区按自己的高度算)。 */
const MIN_VISIBLE = 4

/** 通用版:owner 管归属(不在文档里 / 没有盒子 = 看不见),measure 管那段字在哪。 */
export function createTextAnchor(owner: HTMLElement, measure: AnchorMeasure, opts: TextAnchorOptions = {}): TextAnchor {
  const doc = owner.ownerDocument, win = doc.defaultView!
  const subs = new Set<() => void>()
  let frame = 0
  let disposed = false
  let isLost = false
  const notify = (): void => {
    if (disposed || frame) return
    frame = win.requestAnimationFrame(() => { frame = 0; for (const fn of [...subs]) fn() })
  }
  // 监听等第一个订阅者来了才挂、最后一个走了就摘:渲染期 useMemo 里建锚点不会漏监听(StrictMode 双跑丢掉的那份从没挂过)
  let off: Array<() => void> = []
  const attach = (): void => {
    const on = (target: EventTarget, name: string, fn: EventListener, capture = false): void => {
      target.addEventListener(name, fn, capture)
      off.push(() => target.removeEventListener(name, fn, capture))
    }
    on(doc, 'scroll', notify, true)
    on(win, 'resize', notify)
    on(win, UI_ZOOM_EVENT, notify)
    on(owner, 'selbar:viewport-moved', notify, true)
    // 视图被 Dockview 摘下 / 挂回时 ResizeObserver 各报一次(0 尺寸 / 真尺寸):藏 / 回来都靠它
    const ro = new ResizeObserver(notify)
    ro.observe(owner)
    const mo = new MutationObserver(notify)
    mo.observe(owner, { childList: true, characterData: true, subtree: true })
    off.push(() => { ro.disconnect(); mo.disconnect() })
  }
  const detach = (): void => { win.cancelAnimationFrame(frame); frame = 0; for (const f of off) f(); off = [] }
  const markLost = (): void => {
    if (isLost) return
    isLost = true
    if (opts.onLost) queueMicrotask(() => { if (!disposed) opts.onLost!() })
  }
  return {
    read() {
      if (disposed || isLost) return null
      if (!owner.isConnected || !owner.getClientRects().length) return null
      let m: ReturnType<AnchorMeasure>
      try { m = measure() } catch (e) { console.error('[lcl] text anchor measure failed', e); return null }
      if (m === 'lost') { markLost(); return null }
      if (!m) return null
      const { rect, clipEl } = m
      const clip = makeClipper(win)(clipEl)
      const r = { left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top), right: Math.min(rect.right, clip.right), bottom: Math.min(rect.bottom, clip.bottom) }
      const need = Math.min(MIN_VISIBLE, Math.max(0.5, rect.bottom - rect.top))
      if (r.bottom - r.top < need || r.right - r.left < 0.5) return null
      return r
    },
    lost: () => isLost,
    subscribe(fn) {
      if (disposed) return () => {}
      if (!subs.size) attach()
      subs.add(fn)
      return () => { if (subs.delete(fn) && !subs.size) detach() }
    },
    dispose() {
      if (disposed) return
      disposed = true
      detach()
      subs.clear()
    },
  }
}

/** 锚在一段 DOM 选区上(聊天、插件视图里宿主自己看到的选区)。range 只在这里读一次,之后按节点 + 偏移现量。 */
export function rangeAnchor(owner: HTMLElement, range: Range, opts: TextAnchorOptions = {}): TextAnchor {
  const sc = range.startContainer, so = range.startOffset, ec = range.endContainer, eo = range.endOffset
  const doc = owner.ownerDocument
  return createTextAnchor(owner, () => {
    if (!owner.contains(sc) || !owner.contains(ec)) return 'lost'
    const r = doc.createRange()
    try {
      r.setStart(sc, Math.min(so, nodeLength(sc)))
      r.setEnd(ec, Math.min(eo, nodeLength(ec)))
    } catch { return 'lost' }
    const b = r.getBoundingClientRect()
    if (!b.width && !b.height) return null
    return { rect: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, clipEl: elementOf(r.commonAncestorContainer) ?? owner }
  }, opts)
}

/** 锚在调用方现量的矩形上(笔记:ProseMirror 的 coordsAtPos;插件:show() 给的 getRect)。
 *  getRect 返回 null = 现在看不见;抛错按看不见算。clipEl = 按谁的滚动祖先裁,缺省 owner。 */
export function rectAnchor(owner: HTMLElement, getRect: () => AnchorRect | null | undefined, clipEl: Element = owner, opts: TextAnchorOptions = {}): TextAnchor {
  return createTextAnchor(owner, () => {
    const r = getRect()
    if (!r || ![r.left, r.top, r.right, r.bottom].every(Number.isFinite)) return null
    return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, clipEl }
  }, opts)
}
