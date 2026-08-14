/**
 * UI 模式:桌面 Dockview 壳(desktop)vs 单列移动壳(mobile)。
 * 模块加载时从 localStorage 读一次并**定格**——同一次页面生命周期内 UI_MODE 恒定;
 * 切换靠 setUiMode(写 localStorage)+ location.reload()(见 command 'switch-ui-mode')。
 *
 * 只被 workspaceStore(选择器)与 Shell 消费,二者在 mobile 构建里都被 vite engineSwap 换掉,
 * 故 mobile 不经这里选壳(MobileRoot 直接渲染 SingleColumnHost)。
 */
const KEY = 'lcl.uiMode'
export type UiMode = 'desktop' | 'mobile'

function read(): UiMode {
  try {
    // URL 参数优先:卫星窗口(mini 卡片)按窗注入模式,**不读也不写 localStorage** —— 同源多窗口共享
    // localStorage,若写 lcl.uiMode 会污染主窗;故用 ?ui= 逐窗定模式(见 windowKind / main 进程开窗)。
    const u = new URLSearchParams(location.search).get('ui')
    if (u === 'mobile' || u === 'desktop') return u
    return localStorage.getItem(KEY) === 'mobile' ? 'mobile' : 'desktop'
  } catch {
    return 'desktop'
  }
}

/** 本次页面生命周期的固定 UI 模式(启动时定格)。 */
export const UI_MODE: UiMode = read()

/** 写入下次生效的模式;调用方随后 location.reload()。
 *  同时清掉 `lcl.uiMode.auto` 归属标记 —— 那个标记是 index.html 里的自动切换脚本用来认领
 *  「这个值是我写的、可以继续自动改写」的。用户经命令面板显式选了,就不能再被设备判定推翻
 *  (否则在窄触屏上手动切回桌面,下一次 resize 就被自动拽回移动壳)。两处同源,见两份 index.html。 */
export function setUiMode(m: UiMode): void {
  try {
    localStorage.setItem(KEY, m)
    localStorage.removeItem(`${KEY}.auto`)
  } catch {
    /* ignore */
  }
}
