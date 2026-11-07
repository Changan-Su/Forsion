/** Host-owned classification. Third-party manifests cannot promote themselves to core plugins. */
export const CORE_BUNDLE_IDS: readonly string[] = ['forsion-extend', 'tangu-computer-use', 'forsion-calendar']

export function isCorePlugin(plugin: { id: string; builtin?: boolean; preinstalled?: boolean }): boolean {
  return !!(plugin.builtin || plugin.preinstalled) && CORE_BUNDLE_IDS.includes(plugin.id)
}

/** 宿主视图芯(2026-10-18,主页插件化 S1):宿主视图类型 → 能接管它的核心插件与该插件的视图 id。
 *  Space、视图类型、Ribbon 槽位都还是宿主的;只有视图里画什么换成插件的。只认这张表 —— 插件自己声明不算。 */
export const HOST_VIEW_CLAIMS: Readonly<Record<string, { pluginId: string; viewId: string; retainAlias?: boolean }>> = {
  homepage: { pluginId: 'forsion-home', viewId: 'home' },
  // Aliases retain older plugin layouts and the independent Tasks Space.
  calendar: { pluginId: 'forsion-calendar', viewId: 'calendar', retainAlias: true },
  'todo-list': { pluginId: 'forsion-calendar', viewId: 'todo', retainAlias: true },
  'calendar-side': { pluginId: 'forsion-calendar', viewId: 'side', retainAlias: true },
  'calendar-config': { pluginId: 'forsion-calendar', viewId: 'config', retainAlias: true },
  'mini-todo': { pluginId: 'forsion-calendar', viewId: 'todo-mini', retainAlias: true },
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
  return Object.keys(HOST_VIEW_CLAIMS).some((t) => !HOST_VIEW_CLAIMS[t].retainAlias && claimedHostView(state, t) === entry)
}

/** The renderer replaces Calendar's contents, preserving the native Space and saved layout. */
export function replacesNativeSpaceRecipe(state: Parameters<typeof claimedHostView>[0], pluginId: string | undefined, slug: string): boolean {
  return pluginId === 'forsion-calendar' && slug === 'calendar' && !!claimedHostView(state, 'calendar')
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

/** One process-wide run for the tray, settings, startup and timer (desktop main process; the Android app reuses it in mobile/src/plugins/coreUpdates.ts). Failures remain visible per package. */
export function createCorePluginUpdater(options: {
  items: CorePluginUpdate[]
  enabled: boolean
  run: (report: (item: CorePluginUpdate) => void) => Promise<unknown>
  broadcast: (status: CorePluginUpdates) => void
}) {
  let items = options.items.map((item) => ({ ...item, phase: options.enabled ? item.phase : 'development' as const }))
  let running: Promise<void> | undefined
  let checking = false
  let generation = 0 // reset() 加一:之前开跑的那一轮拍下的已装 / 暂存版本,播种之后就过时了
  const snapshot = (): CorePluginUpdates => ({ checking, items: items.map((item) => ({ ...item })) })
  const emit = (): void => options.broadcast(snapshot())
  const check = (): Promise<void> => {
    if (running) return running
    if (!options.enabled) { emit(); return Promise.resolve() }
    checking = true
    items = items.map((item) => ({ ...item, phase: 'checking', error: undefined }))
    emit()
    const gen = generation
    running = Promise.resolve().then(() => options.run((item) => {
      if (gen !== generation) return
      items = items.map((before) => before.id === item.id ? { ...before, ...item } : before)
      emit()
    })).then(() => undefined).catch((error: unknown) => {
      if (gen !== generation) return
      items = items.map((item) => item.phase === 'checking' || item.phase === 'downloading'
        ? { ...item, phase: 'error', error: error instanceof Error ? error.message : String(error) } : item)
    }).finally(() => {
      checking = false
      running = undefined
      emit()
      if (gen !== generation) void check() // 过时的那一轮结束了:按现在磁盘上的状态重查一遍
    })
    return running
  }
  /** 回到「尚未检查」:首次启动预取之后,刚播种的、下次拉起引擎就用上的那份不该再显示「重启并启用更新」;下一次检查重新填。
   *  预取超时后还在跑的那一轮,之后的回报一律不收,它跑完自动再查一遍。 */
  const reset = (): void => {
    generation++
    items = items.map((item) => ({ id: item.id, packageName: item.packageName, phase: options.enabled ? 'idle' : 'development' }))
    emit()
  }
  return { snapshot, check, reset }
}
