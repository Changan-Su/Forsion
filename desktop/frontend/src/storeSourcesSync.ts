/**
 * Store sources declared by plugins (manifest `storeSources`) → main process. Only the main window reports, after its
 * plugins have loaded: a window that never loaded external plugins would otherwise report "none" and hide every source.
 * Main keeps the list on disk (the plugin updater needs it at startup) and tells every window when it changes.
 */
import { externalPluginsLoaded, usePluginStore } from './amadeus/plugins/pluginStore'
import type { DeclaredStoreSource } from '../../shared/storeSources'

let started = false

export function startStoreSourceSync(): void {
  const set = window.tangu?.marketSourcesSetDeclared
  if (started || !set) return
  started = true
  let last = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const push = (): void => {
    // 启动时读插件目录失败:store 里只有内置插件,报上去会把持久化的来源全抹掉。等下次完整读到再报。
    if (!externalPluginsLoaded()) return
    const s = usePluginStore.getState()
    const list: DeclaredStoreSource[] = s.plugins.filter((p) => s.activeIds.includes(p.id)).flatMap((p) => p.storeSources ?? [])
    const key = JSON.stringify(list)
    if (key === last) return
    last = key
    void set(list).catch((e) => { last = ''; console.warn('[store-sources] 同步插件声明的来源失败', e) })
  }
  push()
  usePluginStore.subscribe((s, prev) => {
    if (s.activeIds === prev.activeIds && s.plugins === prev.plugins) return
    clearTimeout(timer)
    timer = setTimeout(push, 300)
  })
}
