/** 卫星窗口种类:主窗(缺省)/ 独立窗(拖出的 dockview,无 ribbon)/ mini 悬浮卡片 / floating 面板。
 *  由 main 进程开窗时经 URL query 注入(?window=…&id=…),渲染入口 main.tsx 据此分流到不同根组件。 */
export type WindowKind = 'main' | 'detached' | 'mini' | 'floating'

function params(): URLSearchParams {
  try { return new URLSearchParams(location.search) } catch { return new URLSearchParams() }
}

export function windowKind(): WindowKind {
  const w = params().get('window')
  return w === 'detached' || w === 'mini' || w === 'floating' ? w : 'main'
}

/** 独立窗的稳定 id(布局持久化键 tangu2_layout_detached_<id> + 主进程注册表用)。 */
export function detachedId(): string {
  return params().get('id') || 'default'
}

/** 侧边拼接面板:Mini 形态的窗口,贴在别的 App 窗口旁边(主进程开窗时带 dock=1)。 */
export function isDockWindow(): boolean {
  return params().get('dock') === '1'
}

export function floatingId(): string {
  return params().get('id') || 'default'
}

/** Mini 首次打开时由主进程写进 query 的目标正式会话。 */
export function miniSessionId(): string | null {
  const id = params().get('sessionId')?.trim()
  return id || null
}

/** 设备的 Unit 窗(主进程 createDetachedWindow({ unit }) 开的独立窗,?unit=<设备 id>):只画设备页的框,见 UnitWindowRoot。
 *  id 过同一条白名单(同服务端 UNIT_ID_PATH);不是 / 不合法 = null。 */
export function unitWindowId(): string | null {
  if (windowKind() !== 'detached') return null
  const id = params().get('unit')
  return id && /^[0-9a-zA-Z-]{8,64}$/.test(id) ? id : null
}
