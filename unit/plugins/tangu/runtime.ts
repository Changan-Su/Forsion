import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createLocalEngine } from '../../localEngine'
import type { RuntimeContext, LocalRuntime } from '../../runtimeTypes'

export async function createRuntime(context: RuntimeContext): Promise<LocalRuntime> {
  const engine = createLocalEngine({ dataDir: context.dataDir,
    entryFile: resolve(context.packageDir, 'engine/dist/standalone/main.mjs'),
    initialConfig: { workspace: context.workspaceDir, ...context.config.engine as Record<string, unknown> }, log: context.log })
  // Package discovery runs once after all providers have activated, and on every change.
  return { engine, setPackages: (roots) => engine.setPackages(roots), close: () => engine.stop(),
    readProviders: async () => {
      const config = JSON.parse(await readFile(engine.configFile, 'utf8'))
      return (Array.isArray(config.providers) ? config.providers : []).map((p: Record<string, unknown>) => Object.fromEntries(
        ['providerId', 'modelIds', 'imageModelIds', 'ttsModelIds', 'asrModelIds', 'noVisionModelIds'].filter((key) => p[key] !== undefined).map((key) => [key, p[key]])))
    },
  }
}
