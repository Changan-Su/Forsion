/**
 * 整窗重载。打包版的页面是 file:,渲染层自己 location.reload() 会被主进程 hardenNav 当成一次 file: 导航拦下,
 * 静默无效(dev 走 http://localhost,拦不到,所以平时看不出来)。有宿主桥就请主进程重载这扇窗;
 * 网页 / 手机 / 没有这座桥的台架页照旧 location.reload()。
 */
import { saveOpenMdEditors } from './views/openMdEditors'

export function reloadWindow(): void {
  const viaHost = typeof window === 'undefined' ? undefined : window.tangu?.reloadWindow
  if (typeof viaHost !== 'function') {
    location.reload()
    return
  }
  const reload = (): void => { viaHost().catch(() => location.reload()) }
  // Open workspace .md tabs save what they still hold first (React cleanup does not run on a reload); the page's
  // pagehide save stays as the backstop, and the cap keeps a stuck write from blocking the reload.
  const saving = saveOpenMdEditors()
  if (!saving) { reload(); return }
  void Promise.race([saving, new Promise<void>((r) => setTimeout(r, SAVE_CAP_MS))]).finally(reload)
}

const SAVE_CAP_MS = 5000
