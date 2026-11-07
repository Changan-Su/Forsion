/**
 * 整窗重载。打包版的页面是 file:,渲染层自己 location.reload() 会被主进程 hardenNav 当成一次 file: 导航拦下,
 * 静默无效(dev 走 http://localhost,拦不到,所以平时看不出来)。有宿主桥就请主进程重载这扇窗;
 * 网页 / 手机 / 没有这座桥的台架页照旧 location.reload()。
 */
export function reloadWindow(): void {
  const viaHost = typeof window === 'undefined' ? undefined : window.tangu?.reloadWindow
  if (typeof viaHost !== 'function') {
    location.reload()
    return
  }
  viaHost().catch(() => location.reload())
}
