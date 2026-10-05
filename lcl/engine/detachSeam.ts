/**
 * 「把视图撕出到独立窗口 / 跨窗拖拽」的平台钩子(缝)。
 * 桌面(Electron)注入真身(→ window.tangu 多窗 IPC);web/移动留空(无 OS 窗口 → 拖出/跨窗为 no-op)。
 * 引擎(WorkspaceHost / tab 右键菜单)只调此缝,不 import 任何平台代码 —— 与 i18nSeam 同范式。
 */
export interface ViewRef { type: string; params?: Record<string, unknown> }

export interface DetachApi {
  /** 撕出到新独立窗(右键「移到新窗口」;at=拖出落点屏幕坐标,缺省则主进程自定位)。 */
  detach(views: ViewRef[], at?: { screenX: number; screenY: number }): void
  /** 把整个 Space 开到它自己的窗口里(一个 Space 一扇,已开着就叫到前面);at 同上。没有 OS 窗口的宿主不提供。 */
  openSpace?(spaceId: string, at?: { screenX: number; screenY: number }): void
  /** 跨窗拖拽:拖拽中实时上报屏幕坐标(节流后调;主进程据此给光标下窗口发落点预览)。 */
  dragUpdate?(screenX: number, screenY: number, view: ViewRef): void
  /** 跨窗拖拽:最终落点路由。返回是否已跨窗处理(true → 源窗应关掉该 panel)。 */
  drop?(screenX: number, screenY: number, view: ViewRef): Promise<boolean>
}

let current: DetachApi | null = null
export function setDetachApi(api: DetachApi | null): void { current = api }
export function getDetachApi(): DetachApi | null { return current }
