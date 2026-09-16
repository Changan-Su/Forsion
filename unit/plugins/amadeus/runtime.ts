import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { isSafePluginExt } from '@amadeus-shared/pluginFiles'
import { createLocalVault } from '../../localVault'
import type { RuntimeContext, LocalRuntime } from '../../runtimeTypes'

export async function createRuntime(context: RuntimeContext): Promise<LocalRuntime> {
  const vault = await createLocalVault({ root: resolve(context.workspaceDir, 'vault'), stateDir: context.dataDir, log: context.log })
  let ready = false
  let finishInitialization!: () => void
  const initialized = new Promise<void>((resolve) => { finishInitialization = resolve })
  let closed = false
  return {
    // The listener can already be accepting requests while Unit assembles its
    // plugins. Do not expose note discovery until file-type declarations exist.
    vault: { ...vault, call: async (...args) => {
      await initialized
      if (closed) throw new Error('Local vault is closed')
      return vault.call(...args)
    } },
    setPackages: async (roots: string[], installedRoots: string[] = roots) => {
      const extensions: string[] = []
      for (const root of new Set(installedRoots)) {
        try {
          const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')) as { fileExtensions?: unknown }
          if (Array.isArray(manifest.fileExtensions)) extensions.push(...manifest.fileExtensions.filter(isSafePluginExt))
        } catch { /* A broken or disabled plugin must not remove existing tombstones. */ }
      }
      await vault.setPluginFileExtensions(extensions)
      if (!ready) { ready = true; finishInitialization() }
    },
    close: async () => {
      closed = true
      finishInitialization()
      await vault.close()
    },
  }
}
