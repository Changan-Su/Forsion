/** Official renderer bytes are verified at build time; installed names never override this identity.
 *  The one exception is the npm update (coreUpdates.ts): a newer copy whose SIGNATURE matches the same pinned key,
 *  re-verified on this launch, replaces the bundled renderer, rendered from the verified bytes. */
import bundle from 'virtual:forsion-mobile-extend'
import { cmpVersion, gatePluginManifest } from '../../../desktop/shared/amadeus/ipc'
import { installedPluginFields } from '../../../desktop/shared/amadeus/pluginSource'
import { extendFromVerifiedFiles, verifyMobileExtend } from './extendVerify'
import type { CoreBundle, VerifiedCopy } from './coreUpdates'
import type { MobilePluginHost } from './pluginHost'

export const extendCoreBundle: CoreBundle = {
  pkg: '@forsion/extend',
  manifest: { id: bundle.manifest.id, version: String(bundle.manifest.version) },
  verify: (files) => verifyMobileExtend(files),
}

/** verified = downloaded copies coreUpdates verified on this launch, with their verified bytes. A newer one is rendered
 *  from that snapshot (code, docs, Space recipes); whatever sits on disk under the Extend id is never used. */
export function withBundledExtend(host: MobilePluginHost, appVersion: () => string | null, verified: Promise<ReadonlyMap<string, VerifiedCopy>>): MobilePluginHost {
  let chosen: Promise<typeof bundle | ReturnType<typeof extendFromVerifiedFiles>> | undefined
  const source = () => chosen ??= verified.then((v) => {
    const copy = v.get(bundle.manifest.id)
    return copy?.files && cmpVersion(copy.version, String(bundle.manifest.version)) > 0 ? extendFromVerifiedFiles(copy.files) : bundle
  }).catch(() => bundle)
  const id = bundle.manifest.id
  return { ...host,
    listPlugins: async () => {
      const { manifest, code, readme, changelog } = await source()
      const blocked = gatePluginManifest(manifest, appVersion()) ?? undefined
      return [...(await host.listPlugins()).filter((p) => p.id !== id), {
        id, ...installedPluginFields(manifest, id, id),
        code: blocked ? '' : code, readme, changelog, blocked, preinstalled: true, locked: true,
      }]
    },
    listSpaces: async () => {
      const { manifest, recipes } = await source()
      return [...(await host.listSpaces()).filter((p) => p.plugin !== id), ...(gatePluginManifest(manifest, appVersion()) ? [] : recipes)]
    },
    uninstallPlugin: (pid) => pid === id ? Promise.reject(new Error('Core plugins cannot be uninstalled')) : host.uninstallPlugin(pid),
  }
}
