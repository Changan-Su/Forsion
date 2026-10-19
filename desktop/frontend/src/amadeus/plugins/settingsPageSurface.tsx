/** ctx.ui.mountSettingsPage / mountSettingsItem 的宿主那半(2026-10-17):把整页描述 / 单件交给 components/SettingsPage 画。
 *  所有权与清理走 mountHostReact;`alive` 由 pluginStore 传入(插件上下文吊销后回调不再调)。update = 整份替换,rev 加一
 *  让控件以新描述为准(输入框 / 步进器不给 value 就保留用户输入的,见 SettingsPage 的 useDraft)。 */
import type { ReactElement } from 'react'
import { mountHostReact } from '@lcl/components'
import { HostLocaleProvider } from '../../i18n'
import { SettingsItem, SettingsPage, SettingsPartsLive } from '../../components/SettingsPage'
import type { PluginSettingsItem, PluginSettingsItemHandle, PluginSettingsPageHandle, PluginSettingsPageSchema } from '../../../../shared/settingsPage'

function mountParts<T>(el: HTMLElement, initial: T, render: (value: T) => ReactElement, alive: () => boolean): { update(next: T): void; dispose(): void } {
  let value = initial, rev = 0, live = true
  const isAlive = (): boolean => live && alive()
  const tree = (): ReactElement => (
    <HostLocaleProvider><SettingsPartsLive value={{ alive: isAlive, rev }}>{render(value)}</SettingsPartsLive></HostLocaleProvider>
  )
  const mounted = mountHostReact(el, tree(), () => { live = false })
  return {
    update(next) { if (!live) return; value = next; rev++; mounted.render(tree()) },
    dispose: mounted.dispose,
  }
}

export function mountPluginSettingsPage(el: HTMLElement, schema: PluginSettingsPageSchema, alive: () => boolean = () => true): PluginSettingsPageHandle {
  return mountParts(el, schema, (s) => <SettingsPage schema={s} />, alive)
}

export function mountPluginSettingsItem(el: HTMLElement, item: PluginSettingsItem, alive: () => boolean = () => true): PluginSettingsItemHandle {
  return mountParts(el, item, (it) => <SettingsItem item={it} />, alive)
}
