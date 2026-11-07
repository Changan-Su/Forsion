/** The same pinned npm renderer ships on Android. A newer compatible installed copy wins
 *  (coreUpdates.ts puts the npm update there; it is swapped in on the next launch). */
import manifest from '@forsion/calendar/manifest.json'
import code from '@forsion/calendar/main.js?raw'
import calendar from '@forsion/calendar/spaces/calendar/space.json?raw'
import todo from '@forsion/calendar/spaces/todo/space.json?raw'
import readme from '@forsion/calendar/README.md?raw'
import changelog from '@forsion/calendar/CHANGELOG.md?raw'
import { cmpVersion, gatePluginManifest, type ExternalPluginSource } from '../../../desktop/shared/amadeus/ipc'
import type { MobilePluginHost } from './pluginHost'
import { installedPluginFields } from '../../../desktop/shared/amadeus/pluginSource'
import type { CoreBundle, VerifiedCopy } from './coreUpdates'

export const calendarCoreBundle: CoreBundle = { pkg: '@forsion/calendar', manifest }

/** verified = 这次启动 coreUpdates 验过的下载版(`id → 版本`):盘上的副本只有对得上它才顶替随包版。 */
export function withBundledCalendar(host: MobilePluginHost, appVersion: () => string | null, verified: Promise<ReadonlyMap<string, VerifiedCopy>>): MobilePluginHost {
  const bundled = (): ExternalPluginSource => {
    const blocked = gatePluginManifest(manifest, appVersion()) ?? undefined
    return { id: manifest.id, ...installedPluginFields(manifest, manifest.id, manifest.id), code: blocked ? '' : code, readme, changelog, preinstalled: true, blocked }
  }
  const choose = async (list: ExternalPluginSource[]): Promise<ExternalPluginSource> => {
    const ok = (await verified).get(manifest.id)?.version
    const installed = list.find((p) => p.id === manifest.id && !p.blocked && p.version === ok && cmpVersion(p.version, manifest.version) > 0)
    return installed ? { ...installed, preinstalled: true } : bundled()
  }
  return { ...host,
    listPlugins: async () => { const list = await host.listPlugins(); return [...list.filter((p) => p.id !== manifest.id), await choose(list)] },
    listSpaces: async () => {
      const selected = await choose(await host.listPlugins()), recipes = await host.listSpaces()
      if (selected.version !== manifest.version) return recipes
      return [...recipes.filter((r) => r.plugin !== manifest.id),
        { slug: 'calendar', plugin: manifest.id, json: calendar }, { slug: 'todo', plugin: manifest.id, json: todo }]
    },
    uninstallPlugin: (id) => id === manifest.id ? Promise.reject(new Error('Core plugins can be disabled in settings')) : host.uninstallPlugin(id),
  }
}
