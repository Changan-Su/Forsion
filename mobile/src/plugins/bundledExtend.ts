/** Official renderer bytes are verified at build time; installed names never override this identity. */
import bundle from 'virtual:forsion-mobile-extend'
import { gatePluginManifest } from '../../../desktop/shared/amadeus/ipc'
import { installedPluginFields } from '../../../desktop/shared/amadeus/pluginSource'
import type { MobilePluginHost } from './pluginHost'

export function withBundledExtend(host: MobilePluginHost, appVersion: () => string | null): MobilePluginHost {
  const { manifest, code, recipes, readme, changelog } = bundle
  return { ...host,
    listPlugins: async () => {
      const blocked = gatePluginManifest(manifest, appVersion()) ?? undefined
      return [...(await host.listPlugins()).filter((p) => p.id !== manifest.id), {
        id: manifest.id, ...installedPluginFields(manifest, manifest.id, manifest.id),
        code: blocked ? '' : code, readme, changelog, blocked, preinstalled: true, locked: true,
      }]
    },
    listSpaces: async () => [...(await host.listSpaces()).filter((p) => p.plugin !== manifest.id),
      ...(gatePluginManifest(manifest, appVersion()) ? [] : recipes)],
    uninstallPlugin: (id) => id === manifest.id ? Promise.reject(new Error('Core plugins cannot be uninstalled')) : host.uninstallPlugin(id),
  }
}
