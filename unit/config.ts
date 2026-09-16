import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { UnitConfig, PluginInstallation } from './host'

export async function readConfig(file: string): Promise<UnitConfig> {
  const path = resolve(file), root = dirname(path)
  const config: UnitConfig = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(config.plugins)) throw new Error('unit.json plugins must be an array')
  config.webDist = resolve(root, config.webDist)
  config.dataDir = resolve(root, config.dataDir || 'data')
  if (config.workspace?.path) config.workspace.path = resolve(root, config.workspace.path)
  if (config.workerFile) config.workerFile = resolve(root, config.workerFile)
  config.plugins = config.plugins.map((p) => typeof p === 'string' ? { path: resolve(root, p) } : { ...p, path: resolve(root, p.path) })
  return config
}
export async function writeConfig(file: string, config: UnitConfig): Promise<void> {
  await mkdir(dirname(resolve(file)), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await rename(temp, file)
}
export const installations = (config: UnitConfig) => config.plugins as PluginInstallation[]
