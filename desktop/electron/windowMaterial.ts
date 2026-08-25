/**
 * 桌面窗口材质桥:渲染层主题只声明「是否需要系统玻璃」,平台细节留在主进程。
 * 纯函数/结构类型刻意不 import electron,方便 Vitest 在 Node 环境验证。
 */

export type WindowMaterial = 'opaque' | 'system-glass'
export type WindowMaterialMode = 'light' | 'dark'

export interface WindowMaterialRequest {
  material: WindowMaterial
  mode: WindowMaterialMode
  /** 当前 skin 解析后的不透明舞台色；供非 macOS / 关闭玻璃时的原生窗口底同步。 */
  backgroundColor?: string
}

export interface MaterialWindow {
  isDestroyed(): boolean
  setBackgroundColor(color: string): void
  setVibrancy(
    type: 'sidebar' | null,
    options?: { animationDuration?: number },
  ): void
}

export function parseWindowMaterialRequest(input: unknown): WindowMaterialRequest | null {
  if (!input || typeof input !== 'object') return null
  const material = (input as Record<string, unknown>).material
  const mode = (input as Record<string, unknown>).mode
  const backgroundColor = (input as Record<string, unknown>).backgroundColor
  if (material !== 'opaque' && material !== 'system-glass') return null
  if (mode !== 'light' && mode !== 'dark') return null
  if (backgroundColor !== undefined && (typeof backgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(backgroundColor))) return null
  return backgroundColor ? { material, mode, backgroundColor: backgroundColor.toLowerCase() } : { material, mode }
}

/**
 * macOS 的 sidebar 是高透、保留背景色映射的 NSVisualEffectView 材质,和 CSS backdrop-filter
 * 仅取样当前页面内容不同。其他平台先保持既有实色窗口,避免伪装成跨窗透明。
 */
export function applyWindowMaterial(
  win: MaterialWindow | null | undefined,
  request: WindowMaterialRequest,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!win || win.isDestroyed()) return
  const solid = request.backgroundColor ?? (request.mode === 'dark' ? '#252327' : '#fbf8f5')
  if (platform !== 'darwin') {
    // 非 macOS 没有同等原生 vibrancy：窗口底跟随当前 skin，不能永远透出 cream 奶油色。
    win.setBackgroundColor(solid)
    return
  }

  if (request.material === 'system-glass') {
    win.setBackgroundColor('#00000000')
    win.setVibrancy('sidebar', { animationDuration: 180 })
    return
  }

  // 先撤原生材质再恢复实色窗口底;主题自身的 body/shell 仍会正常绘制。
  win.setVibrancy(null, { animationDuration: 140 })
  win.setBackgroundColor(solid)
}
