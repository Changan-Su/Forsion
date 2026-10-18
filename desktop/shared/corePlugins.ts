/** Host-owned classification. Third-party manifests cannot promote themselves to core plugins. */
export const CORE_BUNDLE_IDS: readonly string[] = ['forsion-extend', 'tangu-computer-use']

export function isCorePlugin(plugin: { id: string; builtin?: boolean; preinstalled?: boolean }): boolean {
  return !!(plugin.builtin || plugin.preinstalled) && CORE_BUNDLE_IDS.includes(plugin.id)
}

/** 宿主视图芯(2026-10-18,主页插件化 S1):宿主视图类型 → 能接管它的核心插件与该插件的视图 id。
 *  Space、视图类型、Ribbon 槽位都还是宿主的;只有视图里画什么换成插件的。只认这张表 —— 插件自己声明不算。 */
export const HOST_VIEW_CLAIMS: Readonly<Record<string, { pluginId: string; viewId: string }>> = {
  homepage: { pluginId: 'forsion-home', viewId: 'home' },
}

/** 这个插件能不能接管宿主视图:核心插件(随包播种、在名单里)才行。
 *  ponytail: 进核心名单之前的开发 / 台架档 = 本机 localStorage `forsion.dev.coreTrial` 写着它的 id(逗号分隔)。
 *  只认 id 会让商店里同 id 的插件顶掉主页;发版播种后这一档就用不上了,第 4 步删掉。 */
export function canClaimHostView(plugin: { id: string; builtin?: boolean; preinstalled?: boolean } | undefined): boolean {
  if (!plugin) return false
  if (isCorePlugin(plugin)) return true
  try { return (globalThis.localStorage?.getItem('forsion.dev.coreTrial') ?? '').split(',').map((s) => s.trim()).includes(plugin.id) } catch { return false }
}

/** 宿主视图类型此刻由哪个插件视图接管(没有 = 用内置那份)。返回 store 里原样的那一项,订阅时引用稳定。 */
export function claimedHostView<V extends { pluginId: string; item: { id: string } }>(
  state: { views: readonly V[]; plugins: readonly { id: string; builtin?: boolean; preinstalled?: boolean }[] },
  hostType: string,
): V | undefined {
  const c = HOST_VIEW_CLAIMS[hostType]
  if (!c) return undefined
  return state.views.find((o) => o.pluginId === c.pluginId && o.item.id === c.viewId && canClaimHostView(state.plugins.find((p) => p.id === o.pluginId)))
}

/** 这一项插件视图是不是正接管着某个宿主视图 —— 是的话不再另外注册成 `plugin:<id>:<view>`,免得同一个主页开出两份。 */
export function isClaimingHostView(
  state: Parameters<typeof claimedHostView>[0],
  entry: { pluginId: string; item: { id: string } },
): boolean {
  return Object.keys(HOST_VIEW_CLAIMS).some((t) => claimedHostView(state, t) === entry)
}

export interface CorePluginUpdate {
  id: string
  packageName: string
  phase: 'idle' | 'checking' | 'downloading' | 'current' | 'staged' | 'incompatible' | 'error' | 'development'
  installedVersion?: string
  latestVersion?: string
  pendingVersion?: string
  error?: string
}

export interface CorePluginUpdates {
  checking: boolean
  items: CorePluginUpdate[]
}
