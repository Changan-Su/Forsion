/** The same pinned npm renderer ships on Android. A newer compatible installed copy wins. */
import manifest from '@forsion/calendar/manifest.json'
import code from '@forsion/calendar/main.js?raw'
import calendar from '@forsion/calendar/spaces/calendar/space.json?raw'
import todo from '@forsion/calendar/spaces/todo/space.json?raw'
import readme from '@forsion/calendar/README.md?raw'
import changelog from '@forsion/calendar/CHANGELOG.md?raw'
import { cmpVersion, gatePluginManifest, type ExternalPluginSource } from '../../../desktop/shared/amadeus/ipc'
import type { MobilePluginHost } from './pluginHost'
import { installedPluginFields } from '../../../desktop/shared/amadeus/pluginSource'

export function withBundledCalendar(host: MobilePluginHost, appVersion: () => string | null): MobilePluginHost {
  const bundled = (): ExternalPluginSource => {
    const blocked = gatePluginManifest(manifest, appVersion()) ?? undefined
    return { id: manifest.id, ...installedPluginFields(manifest, manifest.id, manifest.id), code: blocked ? '' : code, readme, changelog, preinstalled: true, blocked }
  }
  const choose = (list: ExternalPluginSource[]): ExternalPluginSource => {
    const installed = list.find((p) => p.id === manifest.id && !p.blocked && cmpVersion(p.version, manifest.version) > 0)
    return installed ? { ...installed, preinstalled: true } : bundled()
  }
  return { ...host,
    listPlugins: async () => { const list = await host.listPlugins(); return [...list.filter((p) => p.id !== manifest.id), choose(list)] },
    listSpaces: async () => {
      const selected = choose(await host.listPlugins()), recipes = await host.listSpaces()
      if (selected.version !== manifest.version) return recipes
      return [...recipes.filter((r) => r.plugin !== manifest.id),
        { slug: 'calendar', plugin: manifest.id, json: calendar }, { slug: 'todo', plugin: manifest.id, json: todo }]
    },
    uninstallPlugin: (id) => id === manifest.id ? Promise.reject(new Error('Core plugins can be disabled in settings')) : host.uninstallPlugin(id),
  }
}
