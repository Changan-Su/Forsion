/**
 * Coding Studio「发布」按钮的去处。发布弹窗已搬进 Forsion Extend(命令 `connect.publish`):找到它就交给它,
 * 带上 { root, projectName, entry, htmlFiles };找不到(随包的 Extend 还是旧版、Extend 停用了)就开宿主自己的
 * ConnectPublishDialog,和以前一样。旧弹窗等随包的 Extend 升上来之后再删。
 *
 * 命令只认首方内置包(locked)且已启用的 forsion-extend 注册的那一条:别的插件注册同名命令不算。
 * Extend 的 run() 在弹窗关掉时才 resolve —— 期间宿主收起预览(<webview> 不认 z-index,会盖住弹窗)。
 */
import { usePluginStore } from '../../amadeus/plugins/pluginStore'
import type { CommandContribution } from '../../amadeus/plugins/types'

export const EXTEND_PLUGIN_ID = 'forsion-extend'
export const EXTEND_PUBLISH_COMMAND = 'connect.publish'

export interface PublishTarget { root: string; projectName: string; entry: string | null; htmlFiles: string[] }

type PluginSlice = Pick<ReturnType<typeof usePluginStore.getState>, 'commands' | 'activeIds' | 'plugins'>

/** Extend 注册的发布命令;没有 → null。 */
export function extendPublishCommand(s: PluginSlice = usePluginStore.getState()): CommandContribution | null {
  if (!s.activeIds.includes(EXTEND_PLUGIN_ID)) return null
  if (!s.plugins.find((p) => p.id === EXTEND_PLUGIN_ID)?.locked) return null
  return s.commands.find((o) => o.pluginId === EXTEND_PLUGIN_ID && o.item.id === EXTEND_PUBLISH_COMMAND)?.item ?? null
}

/** 按钮画不画:有 Extend 的命令,或宿主自己还有 connectPublish 桥(旧路)。插件注册晚于首帧,所以订阅 store。 */
export function useCanPublish(): boolean {
  const viaExtend = usePluginStore((s) => !!extendPublishCommand(s))
  return viaExtend || !!window.tangu?.connectPublish
}

/**
 * 宿主的前置检查(刷编辑器、拒 devUrl、项目外的造物)都过了之后调。返回走了哪条路。
 * Extend 的命令抛错 / reject 时退回宿主的弹窗(宿主那条桥还在的话),不让「发布」点了没反应。
 */
export async function runPublish(target: PublishTarget, io: { openHostDialog(): void; setExtendOpen(open: boolean): void }): Promise<'extend' | 'host' | 'none'> {
  const command = extendPublishCommand()
  if (command) {
    io.setExtendOpen(true)
    try {
      await command.run({ root: target.root, projectName: target.projectName, entry: target.entry, htmlFiles: [...target.htmlFiles] })
      return 'extend'
    } catch (error) {
      console.warn('[coding] Extend 的发布命令失败,退回宿主弹窗:', error)
    } finally {
      io.setExtendOpen(false)
    }
  }
  if (window.tangu?.connectPublish) { io.openHostDialog(); return 'host' }
  return 'none'
}
