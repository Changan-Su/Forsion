/**
 * 插件的网页表面(`ctx.ui.mountWebSurface`,2026-11-15+):插件把自己起的本机服务的网页界面(DSH 融合插件的工作台)
 * 放进一个 Forsion 管的 <webview>。主进程和渲染层共用这里的判定。
 *
 *  - 分区:`persist:plugin-surface-<插件 id>[-<插件起的名>]`,和内置浏览器(BROWSER_PARTITION)分开 —— 那个分区装着
 *    任意第三方网页和用户的登录;插件页的 cookie(DSH 网页界面的登录 cookie 是 SameSite=Strict,iframe 带不上,所以要顶层页)
 *    也不该混进去。
 *  - 只开本机:地址必须是 127.0.0.1 / localhost / [::1] 上的 http(s)。主进程见到别的地址就当普通 <webview>(钉回浏览器分区)。
 */

export const PLUGIN_SURFACE_PREFIX = 'persist:plugin-surface-'
const PARTITION_RE = /^persist:plugin-surface-[a-z0-9][a-z0-9-]{0,127}$/

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** 本机的 http(s) 地址(不认用户名密码段:`http://127.0.0.1@evil.com` 这种的 host 是 evil.com,URL 解析本来就判对)。 */
export function isLoopbackHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)
  } catch { return false }
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

/** 渲染层给插件起分区名:插件 id 打头,插件自己给的名字只当后缀(洗成小写短横线)。 */
export function pluginSurfacePartitionFor(pluginId: string, name?: string): string {
  const id = slug(pluginId) || 'plugin'
  const extra = name ? slug(String(name).replace(/^persist:/, '')) : ''
  return `${PLUGIN_SURFACE_PREFIX}${id}${extra && extra !== id ? `-${extra}` : ''}`.slice(0, PLUGIN_SURFACE_PREFIX.length + 128)
}

/** 主进程:这次 <webview> 要的分区能不能给(名字对、首个地址是本机)。不能给 → null,照普通 <webview> 钉回浏览器分区。 */
export function acceptPluginSurface(partition: unknown, src: unknown): string | null {
  return typeof partition === 'string' && PARTITION_RE.test(partition) && isLoopbackHttpUrl(src) ? partition : null
}

/** 页面自己发起的跳转:同源(协议 + 主机 + 端口都一样)才放行,别的交给 Forsion 开(内置浏览器或系统浏览器)。
 *  还没载入过页面(首个地址的 302 跳转时 current 是空串)只看目标是不是本机。 */
export function surfaceNavigationAllowed(current: string, next: string): boolean {
  if (!isLoopbackHttpUrl(next)) return false
  if (!isLoopbackHttpUrl(current)) return !current || current === 'about:blank'
  return new URL(current).origin === new URL(next).origin
}

/** 插件网页表面只放行这些权限(复制按钮要写剪贴板);麦克风、摄像头、定位、通知一律不给。 */
export const PLUGIN_SURFACE_PERMISSIONS: readonly string[] = ['clipboard-sanitized-write']
