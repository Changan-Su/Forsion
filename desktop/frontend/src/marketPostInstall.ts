/**
 * 市场装完的收尾,市场与插件引导卡「推荐安装」共用 —— 两处各写一份时,引导卡漏掉了捆绑包的引擎重扫(Codex 评审)。
 * 市场 / 设置是独立浮窗:这里的热重载只刷得动本窗,所以每一类都同时通知其余窗口(announce / requestMainAction)。
 */
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { loadUserSpaces } from './userSpaces'
import { announceExtensionsChanged, installAmadeusPlugins, reloadPluginsAndAnnounce } from './amadeusPlugins'

/** restart = 引擎里还跑着旧代码 / 新路由挂不上,重启后端才完整生效;fresh = 新装上的 Forsion 插件(调用方做引导检查)。 */
export async function afterMarketInstall(
  type: string, res: { id?: string } | undefined, wasInstalled: boolean, say: (text: string, error?: boolean) => void,
): Promise<{ restart: boolean; fresh: AmadeusPlugin[] }> {
  const none = { restart: false, fresh: [] as AmadeusPlugin[] }
  if (type === 'plugin') return { restart: await useApp.getState().onPluginInstalled(say, wasInstalled), fresh: [] }
  if (type === 'space') { await loadUserSpaces(); announceExtensionsChanged('space'); return none }
  if (type === 'theme') { await useTheme.getState().reloadThemes(); announceExtensionsChanged('theme'); return none }
  if (type === 'skill' || type === 'agent') { window.tangu?.requestMainAction?.(type === 'skill' ? 'skills-changed' : 'agents-changed'); return none }
  if (type !== 'amadeus-plugin' || !window.amadeus) return none
  installAmadeusPlugins()
  const { before, after, fresh } = await reloadPluginsAndAnnounce({ also: res?.id ? [res.id] : [] })
  const engineOf = (list: AmadeusPlugin[]): string[] => list.find((p) => p.id === res?.id)?.bundle?.enginePlugins ?? []
  const had = engineOf(before), has = engineOf(after)
  // 捆绑包内嵌引擎插件:新的靠重扫即时生效;装之前就有的(升级 / 重装 / 这一版删掉了)旧代码还在引擎里,要重启。
  const restart = had.length || has.length ? await useApp.getState().onPluginInstalled(say, had.length > 0) : false
  await loadUserSpaces()
  return { restart, fresh }
}

/** 只有本机托管的引擎重启得了;外接 / 别的设备的引擎给了按钮也是空按。 */
export const canRestartBackend = (): boolean => !!window.tangu?.backendRestart && useApp.getState().desktopConfig?.mode === 'managed'

/** backend:restart = 先停再拉起;回到 ready 才算成功。 */
export async function restartBackend(): Promise<boolean> {
  const st = await window.tangu?.backendRestart?.().catch(() => null)
  return st?.state === 'ready'
}
