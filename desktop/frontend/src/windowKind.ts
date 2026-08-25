/** 卫星窗口种类:主窗(缺省)/ 独立窗(拖出的 dockview,无 ribbon)/ mini 悬浮卡片。
 *  由 main 进程开窗时经 URL query 注入(?window=…&id=…),渲染入口 main.tsx 据此分流到不同根组件。 */
export type WindowKind = 'main' | 'detached' | 'mini'

function params(): URLSearchParams {
  try { return new URLSearchParams(location.search) } catch { return new URLSearchParams() }
}

export function windowKind(): WindowKind {
  const w = params().get('window')
  return w === 'detached' || w === 'mini' ? w : 'main'
}

/** 独立窗的稳定 id(布局持久化键 tangu2_layout_detached_<id> + 主进程注册表用)。 */
export function detachedId(): string {
  return params().get('id') || 'default'
}

/** Mini 首次打开时由主进程写进 query 的目标正式会话。 */
export function miniSessionId(): string | null {
  const id = params().get('sessionId')?.trim()
  return id || null
}
