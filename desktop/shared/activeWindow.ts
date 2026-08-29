/**
 * 前台窗口采样的共享契约(主进程实现在 electron/activeWindow.ts,渲染层/插件消费同一份形状)。
 * 单独一个文件是为了不让渲染层 import 到 electron/(那边带 node:child_process)。
 */
export interface ActiveWindowSample {
  /** 前台应用名(darwin=LSDisplayName / win32=进程名 / linux=WM_CLASS)。 */
  app: string
  /** macOS bundle id;其他平台缺省。 */
  bundleId?: string
  pid?: number
  /** 窗口标题。⚠️darwin 恒 ''(标题在 macOS 属 Screen Recording 权限);win32/linux(X11)给真值。 */
  title: string
  /** 系统空闲秒数(powerMonitor)。采样式数据里人走了前台 app 不变,消费方**必须**据此丢挂机时段。 */
  idleSeconds: number
  platform: string
}
