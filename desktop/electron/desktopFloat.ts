/**
 * 桌面作用域的浮层(LCL 表面规范方案 B 第四期):浮在别的应用之上、Forsion 最小化也在的 OS 小窗。
 * 口径延续 lcl/engine/floatLayer.ts 的 view / space / window 三档 —— 同一套锚点(四角 + 上下居中)和用途(panel / notice),
 * 只是画在一扇不进 Dock / 任务栏的系统窗口里,锚在**当前屏幕**(鼠标所在那块)的工作区上。
 *
 * 两样分开控制,别混成一个开关(Codex 评审):
 *   - focus 'keep' = 不抢焦点:用户正在打字的那个应用保持在前台、保持输入焦点,点浮层上的按钮也不换前台。
 *     macOS:panel 型窗(NSWindowStyleMaskNonactivatingPanel,权限引导窗已经这样用)+ focusable:false + acceptFirstMouse;
 *     Windows:focusable:false(WS_EX_NOACTIVATE)+ showInactive。全屏应用之上不承诺能显示(Windows 上 visibleOnAllWorkspaces 无效)。
 *   - pin = 盖在别的应用的普通窗口上面。**桌面 ≠ 置顶**:Mini 缺省置顶、设置窗缺省不置顶;语音胶囊要在用户正在用的应用上面
 *     看得见,所以它 pin。
 * 只给宿主自己用:插件的 ctx.ui.float 只有 view / space / window 三档,传 'desktop' 会抛错(第三方插件先不给桌面作用域)。
 */
import { BrowserWindow, screen, type Rectangle } from 'electron'

export type DesktopFloatAnchor = 'top-start' | 'top-center' | 'top-end' | 'bottom-start' | 'bottom-center' | 'bottom-end'

export interface DesktopFloatOptions {
  anchor: DesktopFloatAnchor
  role: 'panel' | 'notice'
  focus: 'keep' | 'take'
  pin: boolean
  width: number
  height: number
  /** 离工作区边缘多远(px)。缺省 12,同 floatLayer。 */
  margin?: number
  /** 读屏名 / 窗口标题(不显示)。 */
  title: string
  webPreferences: Electron.WebPreferences
}

/** 纯函数:在一块工作区里按锚点摆一个 size 大小的框。 */
export function desktopFloatBounds(area: Rectangle, size: { width: number; height: number }, anchor: DesktopFloatAnchor, margin = 12): Rectangle {
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  const [v, h] = anchor.split('-') as ['top' | 'bottom', 'start' | 'center' | 'end']
  const x = h === 'start' ? area.x + margin : h === 'end' ? area.x + area.width - width - margin : area.x + Math.round((area.width - width) / 2)
  const y = v === 'top' ? area.y + margin : area.y + area.height - height - margin
  return { x: Math.round(x), y: Math.round(y), width, height }
}

/** 用户此刻在哪块屏幕上:鼠标所在那块(拿不到前台窗口的框时最好的近似)。 */
export function currentWorkArea(): Rectangle {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
}

export function createDesktopFloat(o: DesktopFloatOptions): BrowserWindow {
  const keep = o.focus === 'keep'
  const mac = process.platform === 'darwin'
  const win = new BrowserWindow({
    ...desktopFloatBounds(currentWorkArea(), o, o.anchor, o.margin),
    title: o.title,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false, // 阴影由页面里的卡面画(--card-shadow),透明窗的系统阴影会描出整个矩形
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    ...(mac ? { type: 'panel' as const } : {}),
    ...(keep ? { focusable: false, acceptFirstMouse: true } : {}),
    alwaysOnTop: o.pin,
    webPreferences: o.webPreferences,
  })
  if (o.pin) win.setAlwaysOnTop(true, mac ? 'floating' : 'screen-saver')
  if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setMenu(null)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  return win
}

/** 摆到当前屏幕的锚点上并显示;focus 'keep' 一律 showInactive(绝不 show / focus)。 */
export function presentDesktopFloat(win: BrowserWindow, o: Pick<DesktopFloatOptions, 'anchor' | 'width' | 'height' | 'margin' | 'focus'>): void {
  if (win.isDestroyed()) return
  win.setBounds(desktopFloatBounds(currentWorkArea(), o, o.anchor, o.margin))
  if (o.focus === 'keep') win.showInactive()
  else win.show()
}
