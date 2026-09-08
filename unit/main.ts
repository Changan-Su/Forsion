import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { startBasicUnit, type UnitConfig } from './host'

const configPath = resolve(process.argv[2] || 'unit.json')
const config: UnitConfig = JSON.parse(await readFile(configPath, 'utf8'))
const root = dirname(configPath)
config.webDist = resolve(root, config.webDist)
config.plugins = config.plugins.map((dir) => resolve(root, dir))
if (process.env.UNIT_PORT) config.port = Number(process.env.UNIT_PORT)
const unit = await startBasicUnit(config)
console.log(`[unit] ${config.name} (${config.instanceId}) http://${config.bindHost ?? '127.0.0.1'}:${unit.port}${config.basePath}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void unit.close().then(() => process.exit(0))
})
