import { windowKind } from './windowKind'
import { useApp } from './stores/appStore'
/** 桌面多窗接线:把引擎的 detach 缝(detachSeam)接到 window.tangu 多窗 IPC;订阅跨窗拖入(accept-view)
 *  与实时落点预览(drag-preview)。非桌面(web/移动)window.tangu.openDetached 缺省 → 整体 no-op。
 *  三种窗口(主/独立/mini)都调:mini 不是 dockview 落点(主进程 windowAtPoint 已排除),订阅空转无害。 */
import { setDetachApi, useWorkspace, setActiveSpace, getView, subscribeViews } from '@lcl/engine'

let previewEl: HTMLDivElement | null = null
/** 目标窗跨窗拖入预览:整窗 accent 边框+淡色底(at=null 清除)。localX/Y 预留精细化,v1 整窗高亮即可。 */
function drawCrossWindowPreview(at: { localX: number; localY: number } | null): void {
  if (!at) { if (previewEl) previewEl.style.display = 'none'; return }
  if (!previewEl) {
    previewEl = document.createElement('div')
    Object.assign(previewEl.style, {
      position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '99998',
      boxSizing: 'border-box', border: '3px solid var(--accent, #4d8794)',
      background: 'color-mix(in srgb, var(--accent, #4d8794) 8%, transparent)',
    } as Partial<CSSStyleDeclaration>)
    document.body.appendChild(previewEl)
  }
  previewEl.style.display = 'block'
}

export function installMultiWindow(): void {
  const t = window.tangu
  if (!t?.openDetached) return // 非桌面 → 无 OS 窗口,跳过
  if (windowKind() === 'main') {
    // Keep the OS process informed even before a Mini window has ever existed.
    let lastSession = ''
    const reportSession = (): void => {
      const state = useApp.getState()
      const sessionId = state.activeId
      const context = { sessionId, runId: sessionId ? state.runningBySession[sessionId] ?? null : null }
      const key = JSON.stringify(context)
      if (key === lastSession) return
      lastSession = key
      t.reportMiniSession?.(context)
    }
    useApp.subscribe(reportSession)
    reportSession()

    // Wait for Dockview before acknowledging, including a main window recreated from Mini.
    let pending: import('../../shared/miniPanel').MainPanelTarget | null = null
    const apply = (): void => {
      const ws = useWorkspace.getState()
      if (!ws.api || !pending || !getView(pending.type)) return
      const target = pending
      pending = null
      if (target.spaceId) setActiveSpace(target.spaceId)
      const leaf = useWorkspace.getState().openView(target.type, target.params ?? {}, 'main')
      if (leaf && target.params) leaf.setParams({ ...leaf.params, ...target.params })
    }
    t.onMainPanelTarget?.((target) => { pending = target; apply() })
    subscribeViews(apply)
    let announced = false
    useWorkspace.subscribe((s) => {
      if (!s.api) return
      if (!announced) { announced = true; t.mainPanelReady?.() }
      apply()
    })
  }
  setDetachApi({
    detach: (views, at) => { void t.openDetached?.(views, at) },
    dragUpdate: (x, y, view) => t.dragUpdate?.(x, y, view),
    drop: async (x, y, view) => (await t.dropView?.(x, y, view))?.routed ?? false,
  })
  // 本窗收到跨窗拖入的视图 → 打开在主区(源窗那侧负责关掉原 panel)。
  t.onAcceptView?.((view) => {
    drawCrossWindowPreview(null)
    useWorkspace.getState().openView(view.type, (view.params ?? {}) as Record<string, unknown>, 'main')
  })
  // 拖拽经过本窗时的实时落点预览(主进程按屏幕坐标命中后发来 local 坐标;null=离开清除)。
  t.onDragPreview?.((at) => drawCrossWindowPreview(at))
}
