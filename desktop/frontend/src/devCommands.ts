/**
 * 开发者选项那三个「⌘K 入口」开关的跨窗同步。
 * 命令注册表是**每个渲染进程各一份**(@lcl/engine 的 workspace store),而设置自 2026-09-20 的
 * Floating Panel 化起住在独立浮窗里 —— 在设置里 addCommand 等于注册到一个没有命令面板的窗口,
 * 主窗要重启才看得到(实证:`npm run e2e:activewindow` 的 T5c)。
 * 所以设置那边拨开关时:本地照旧调一次(设置画在主窗里的形态,如 web / mobile),
 * 再 `requestDevCommandsSync()` 请主窗按真源重算一次。
 */
import { setMobileUiCommand, MOBILE_UI_KEY } from './mobileUiCommand'
import { setActivityViewCommand, ACTIVITY_VIEW_KEY } from './activityViewCommand'
import { setActiveWindowCommand } from './activeWindowCommand'

/** 按真源(localStorage × 主进程 config)重算三个命令的注册态:启动时一次,收到主窗动作时一次。 */
export function syncDevCommands(): void {
  // 开发者选项:移动端 UI 预览命令(开关持久化在 MOBILE_UI_KEY;已在移动模式则强制保留切回入口)。
  try { setMobileUiCommand(localStorage.getItem(MOBILE_UI_KEY) === '1') } catch { /* ignore */ }
  // 开发者选项:活动日志实时视图命令(同款模式)。
  try { setActivityViewCommand(localStorage.getItem(ACTIVITY_VIEW_KEY) === '1') } catch { /* ignore */ }
  // 开发者选项:前台窗口采样调试面板命令。开关真源在主进程配置(不是 localStorage),故异步读一次;
  // window.tangu 缺位(web/mobile 无 host 进程)→ 整个能力不存在,命令自然不注册。
  void window.tangu?.getConfig?.().then((c) => setActiveWindowCommand(c.activeWindowEnabled === true)).catch(() => {})
}

/**
 * 在卫星窗(设置浮窗)里拨了 localStorage 那两个开关:自己这份注册没人看得到,让主窗按真源重算。
 * 只管 localStorage 的两个 —— 前台窗口采样的真源在主进程 config,由 `config:set` 落盘后自己推主窗
 * (那样「拨完立刻关掉设置窗」也不会丢通知)。
 * ponytail: 跨渲染进程的 localStorage 可见性靠 Chromium 自己同步,这里只押「IPC 一来一回比它慢」;
 * 真出现读到旧值,再改成把开关值随动作一起发过去。
 */
export function requestDevCommandsSync(): void {
  window.tangu?.requestMainAction?.('dev-commands')
}
