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
import { listPlugins, rescanPlugins, restoreTrashEntry, uninstallPlugin } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { panelToast } from './PanelNotice'
import { notifyUninstalled } from './UninstallDialog'

/** 不留设置时把内嵌引擎插件的设置(可能有密钥)交给引擎收进回收站,返回条目 id,恢复时连带放回。只收捆绑包自己管的:
 *  用户目录同 id 覆盖的、首方内置同 id 的不归它(同 syncBundleEngines)。引擎不在就收不了,设置留在 config.json。 */
async function trashBundleEngineSettings(ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  const userOwned = new Set(((await window.tangu?.pluginsUserInstalled?.().catch(() => [])) ?? []).map((x) => x.id))
  const trashIds: string[] = []
  for (const e of await listPlugins(homeTarget())) {
    if (!ids.includes(e.id) || e.source === 'builtin' || userOwned.has(e.id)) continue
    const r = await uninstallPlugin(homeTarget(), e.id).catch(() => null)
    if (r?.trashId) trashIds.push(r.trashId)
  }
  return trashIds
}

/** Forsion 插件:文件 + 设置(可留)+ 库里的工作文件夹(勾了才挪)进回收站(主进程挪,restorer=desktop)。
 *  engine = 引擎连着(内嵌引擎插件要先关、卸完重扫);onGone 在文件已经挪走后调(详情页据此退回列表)。返回 false = 没卸成(已提示)。 */
export async function uninstallForsionPlugin(p: AmadeusPlugin, name: string, opts: { keepSettings: boolean; moveVault: boolean }, hooks: { engine: boolean; onGone?: () => void; onEngineReload?: () => void }): Promise<boolean> {
  const ids = p.bundle?.enginePlugins ?? []
  // ⚠️这里别写 enabled:false:写进 config.json 的「关」不随目录走,重装后内嵌引擎插件就一直关着。工具靠下面的重扫撤。
  const engineTrash = hooks.engine && !opts.keepSettings ? await trashBundleEngineSettings(ids) : []
  const prefs = opts.keepSettings ? {} : pluginPrefs(p.id)
  const vaultFolder = opts.moveVault ? pluginVaultFolder(p.id, p.name) : null
  let r: { trashId?: string; dirName?: string } | void
  try {
    r = await amadeus.uninstallPlugin?.(p.id, { keepSettings: opts.keepSettings, ...(vaultFolder ? { vaultFolder } : {}), ...(Object.keys(prefs).length ? { prefs } : {}), ...(engineTrash.length ? { engineTrash } : {}) })
  } catch (e: any) {
    for (const id of engineTrash) await restoreTrashEntry(homeTarget(), id).catch(() => {}) // 没卸成:设置接回去
    // 主进程的开发副本守卫用机器码开头(见 electron/amadeus/ipc.ts 的 uninstallPlugin):用户真会撞上(开发副本可能是别的窗口 /
    // 上一次会话开的),按当前语言说人话;其余原因码交给 ipcErrorText(它已剥掉 invoke 前缀,不认识的码原样透传)。
    const text = ipcErrorText(e)
    panelToast(text.startsWith('dev-shadowed') ? translate('settings.amadeusPlugins.devShadowedUninstall') : text, true)
    return false
  }
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

/** 引擎插件:引擎把用户目录里的文件与设置(可留)挪进回收站(?trash=1),主进程撤商店记录;引擎不在时主进程自己挪文件夹,不硬删。 */
export async function uninstallEnginePlugin(id: string, name: string, opts: { keepSettings: boolean }): Promise<boolean> {
  try {
    const r = await uninstallPlugin(homeTarget(), id, { trash: true, keepSettings: opts.keepSettings }).catch(() => null)
    await window.tangu?.pluginsUninstall?.(id, r?.dirName)
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
