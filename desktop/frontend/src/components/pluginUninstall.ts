/**
 * 插件卸载的执行半(10-28 手动卸载规范):确认框(UninstallDialog.PluginUninstallDialog)收集选择,这里真正去卸。
 * 设置 › 插件(Forsion / 引擎)与商店共用,别在调用点各写一份。两条都进回收站,删完 6 秒内可撤销。
 */
import { amadeus } from '@amadeus/api'
import { dropPluginCloudData, pluginDataSyncOn } from '@amadeus/plugins/pluginDataSync'
import { dropPluginPrefs, pluginPrefs, pluginVaultFolder } from '@amadeus/plugins/pluginStore'
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import { translate } from '../i18n'
import { ipcErrorText } from '../ipcError'
import { reloadPluginsAndAnnounce } from '../amadeusPlugins'
import { loadUserSpaces } from '../userSpaces'
import { rescanPlugins, restoreTrashEntry, uninstallPlugin } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { panelToast } from './PanelNotice'
import { notifyUninstalled } from './UninstallDialog'
import { sendTelemetry } from '../telemetrySend'
import { telemetryPluginRef, type TelemetryPluginRef } from '../telemetryPluginId'

/** 匿名遥测 plugin_lifecycle 的卸载那条:商店页知道商店条目 id 就用它,否则按插件记录换(telemetryPluginId.ts)。
 *  reason = 确认框里用户选的理由(v3,可不选)。 */
const reportUninstall = (ref: TelemetryPluginRef, reason?: string): void => sendTelemetry('plugin_lifecycle', { ...ref, action: 'uninstall', ...(reason ? { reason } : {}) })

/** 不留设置时把内嵌引擎插件的设置(可能有密钥)交给引擎收进回收站,返回条目 id,恢复时连带放回。带 bundle:同 id 的
 *  若不是这个捆绑包里的(用户目录覆盖、首方内置),引擎不动它。引擎不在就收不了,设置留在 config.json。 */
async function trashBundleEngineSettings(p: AmadeusPlugin): Promise<string[]> {
  const trashIds: string[] = []
  for (const id of p.bundle?.enginePlugins ?? []) {
    const r = await uninstallPlugin(homeTarget(), id, { bundle: p.bundle!.dir }).catch(() => null)
    if (r?.trashId) trashIds.push(r.trashId)
  }
  return trashIds
}

/** Forsion 插件:文件 + 设置(可留)+ 库里的工作文件夹(勾了才挪)进回收站(主进程挪,restorer=desktop)。
 *  engine = 引擎连着(内嵌引擎插件要先关、卸完重扫);onGone 在文件已经挪走后调(详情页据此退回列表)。返回 false = 没卸成(已提示)。 */
export async function uninstallForsionPlugin(p: AmadeusPlugin, name: string, opts: { keepSettings: boolean; moveVault: boolean; keepOld?: boolean; reason?: string }, hooks: { engine: boolean; onGone?: () => void; onEngineReload?: () => void; storeItemId?: string }): Promise<boolean> {
  const ids = p.bundle?.enginePlugins ?? []
  const tele = hooks.storeItemId ? { pluginId: hooks.storeItemId, pluginOfficial: true } : telemetryPluginRef(p) // 卸之前算:卸完商店记录就撤了
  // ⚠️这里别写 enabled:false:写进 config.json 的「关」不随目录走,重装后内嵌引擎插件就一直关着。工具靠下面的重扫撤。
  const engineTrash = hooks.engine && !opts.keepSettings ? await trashBundleEngineSettings(p) : []
  // 商店版取代着一份旧普通目录:缺省一起走(主进程自己认是哪个目录),否则卸完它就重新运行;它的偏好跟着「保留设置」走
  const withOld = !!p.supersedes && !opts.keepOld
  const prefs = opts.keepSettings ? {} : { ...pluginPrefs(p.id), ...(withOld && p.supersedes ? pluginPrefs(p.supersedes.id) : {}) }
  const vaultFolder = opts.moveVault ? pluginVaultFolder(p.id, p.name) : null
  let r: { trashId?: string; dirName?: string } | void
  try {
    r = await amadeus.uninstallPlugin?.(p.id, { keepSettings: opts.keepSettings, ...(vaultFolder ? { vaultFolder } : {}), ...(Object.keys(prefs).length ? { prefs } : {}), ...(engineTrash.length ? { engineTrash } : {}), ...(withOld ? { withSuperseded: true } : {}) })
  } catch (e: any) {
    for (const id of engineTrash) await restoreTrashEntry(homeTarget(), id).catch(() => {}) // 没卸成:设置接回去(接不回的留在回收站里)
    // 主进程的开发副本守卫用机器码开头(见 electron/amadeus/ipc.ts 的 uninstallPlugin):用户真会撞上(开发副本可能是别的窗口 /
    // 上一次会话开的),按当前语言说人话;其余原因码交给 ipcErrorText(它已剥掉 invoke 前缀,不认识的码原样透传)。
    const text = ipcErrorText(e)
    panelToast(text.startsWith('dev-shadowed') ? translate('settings.amadeusPlugins.devShadowedUninstall') : text, true)
    return false
  }
  reportUninstall(tele, opts.reason)
  if (!opts.keepSettings && pluginDataSyncOn(p)) void dropPluginCloudData(p.id) // 先于 dropPluginPrefs
  dropPluginPrefs(prefs)
  if (r?.dirName) void window.tangu?.marketForget?.('amadeus-plugin', r.dirName).catch(() => {}) // 商店装的:撤掉安装记录
  hooks.onGone?.()
  await reloadPluginsAndAnnounce() // 设置是独立浮窗:主窗 / 分离窗里跑着的那份实例靠广播拆
  void loadUserSpaces() // 撤下其内嵌 Space
  if (ids.length) {
    // 引擎 10-02 起热插拔:重扫发现目录没了就运行期撤掉内嵌插件(依赖它们的先休眠),不用重启。旧引擎(不给 reloadedIds)
    // 撤不掉工具 / 路由 → 照旧重启并核实;失败要说清「文件已挪走但引擎待重启」而非谎报成功(codex P1-8)。
    const rr = hooks.engine ? await rescanPlugins(homeTarget()).catch(() => null) : null
    if (!rr?.reloadedIds || rr.needsRestart) {
      const st = await window.tangu?.backendRestart?.().catch(() => null)
      hooks.onEngineReload?.()
      if (!st || st.state === 'crashed') {
        panelToast(translate('settings.amadeusPlugins.uninstalledRestartPending', { name }), true)
        return true
      }
    } else hooks.onEngineReload?.()
  }
  notifyUninstalled(translate('settings.amadeusPlugins.uninstalled', { name }), name, r?.trashId ? { id: r.trashId, kind: 'plugin', restorer: 'desktop' } : null)
  return true
}

/** 旧副本自己的工作文件夹(库里)。和商店那份落在同一个文件夹(两份同名,都认旧式的 Plugins/<显示名>)时不算它的:
 *  那是正在跑的商店版的数据,既不能说「没带过来」,更不能跟着旧副本进回收站。 */
export function supersededVaultFolder(store: AmadeusPlugin): string | null {
  const old = store.supersedes
  const mine = old ? pluginVaultFolder(old.id, old.name) : null
  return mine && mine !== pluginVaultFolder(store.id, store.name) ? mine : null
}

/** 清掉被商店安装取代的旧普通目录(设置页「旧的本地安装」一节)。它已停用,商店那份不动:按旧副本的生效 id(= manifest id)卸载,
 *  主进程只会找到普通目录。有回收站的宿主(桌面)进回收站、6 秒内可撤销;没有的(手机)直接删、设置留在本机(调用方先问过)。 */
export async function cleanupSupersededCopy(store: AmadeusPlugin, name: string, opts: { keepSettings: boolean; moveVault: boolean }): Promise<boolean> {
  const old = store.supersedes
  if (!old) return false
  const hasTrash = typeof amadeus.trashRestore === 'function'
  const keepSettings = opts.keepSettings || !hasTrash
  const prefs = keepSettings ? {} : pluginPrefs(old.id)
  const vaultFolder = hasTrash && opts.moveVault ? supersededVaultFolder(store) : null
  let r: { trashId?: string } | void
  try {
    r = await amadeus.uninstallPlugin?.(old.id, { keepSettings, dir: old.dir, ...(vaultFolder ? { vaultFolder } : {}), ...(Object.keys(prefs).length ? { prefs } : {}) })
  } catch (e: any) {
    const text = ipcErrorText(e)
    panelToast(text.startsWith('dev-shadowed') ? translate('settings.amadeusPlugins.devShadowedUninstall') : text, true)
    return false
  }
  dropPluginPrefs(prefs)
  await reloadPluginsAndAnnounce() // 只刷元数据(supersedes 没了):商店那份照跑,不拆不装
  const label = { name, version: old.version }
  if (hasTrash) notifyUninstalled(translate('settings.amadeusPlugins.superseded.done', label), name, r?.trashId ? { id: r.trashId, kind: 'plugin', restorer: 'desktop' } : null)
  else panelToast(translate('settings.amadeusPlugins.superseded.doneMobile', label))
  return true
}

/** 引擎插件:引擎把用户目录里的文件与设置(可留)挪进回收站(?trash=1),主进程撤商店记录;引擎不在时主进程自己挪文件夹,不硬删。 */
export async function uninstallEnginePlugin(id: string, name: string, opts: { keepSettings: boolean; reason?: string }, storeItemId?: string): Promise<boolean> {
  const tele = storeItemId ? { pluginId: storeItemId, pluginOfficial: true } : telemetryPluginRef({ id }, 'plugin')
  try {
    const r = await uninstallPlugin(homeTarget(), id, { trash: true, keepSettings: opts.keepSettings }).catch(() => null)
    await window.tangu?.pluginsUninstall?.(id, r?.dirName)
    reportUninstall(tele, opts.reason)
    // 10-02 起的引擎在 DELETE 里就把工具 / 路由撤干净了(restartRequired:false);旧引擎或后端不在 → 照旧重启,
    // 重启后 discoverPlugins 不再发现它。
    if (r?.restartRequired !== false) await window.tangu?.backendRestart?.()
    notifyUninstalled(translate('settings.plugins.uninstalled', { name }), name, r?.trashId ? { id: r.trashId, kind: 'plugin', restorer: 'engine' } : null)
    return true
  } catch (e: any) {
    panelToast(ipcErrorText(e), true)
    return false
  }
}
