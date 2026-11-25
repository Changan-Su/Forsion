import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createLocalEngine } from '../../localEngine'
import type { RuntimeContext, LocalRuntime } from '../../runtimeTypes'

export async function createRuntime(context: RuntimeContext): Promise<LocalRuntime> {
  const engine = createLocalEngine({ dataDir: context.dataDir,
    entryFile: resolve(context.packageDir, 'engine/dist/standalone/main.mjs'),
    initialConfig: { workspace: context.workspaceDir, ...context.config.engine as Record<string, unknown> }, log: context.log,
    multiAccount: context.multiAccount === true,
    ...(context.multiAccount === true && context.cloudUrl ? { cloudUrl: context.cloudUrl } : {}),
    ...(context.multiAccount === true && context.scriptIsolation === 'required' ? { scriptIsolation: 'required' as const } : {}),
    ...(context.multiAccount === true && context.hostControl === true ? { hostControl: true } : {}) })
  // Package discovery runs once after all providers have activated, and on every change.
  // A multi-account engine has no owner configuration to publish.
  if (context.multiAccount) return { engine, setPackages: (roots) => engine.setPackages(roots), close: () => engine.stop() }
  return { engine, setPackages: (roots) => engine.setPackages(roots), close: () => engine.stop(),
    readProviders: async () => {
      const config = JSON.parse(await readFile(engine.configFile, 'utf8'))
      return (Array.isArray(config.providers) ? config.providers : []).map((p: Record<string, unknown>) => Object.fromEntries(
        ['providerId', 'modelIds', 'imageModelIds', 'ttsModelIds', 'asrModelIds', 'noVisionModelIds'].filter((key) => p[key] !== undefined).map((key) => [key, p[key]])))
    },
  }
}
