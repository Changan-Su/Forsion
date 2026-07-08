// Tiny persisted config in the app's userData dir — remembers the last vault & page
// so Amadeus reopens where you left off.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { isDevMode } from '../forsionHome'

export interface AmadeusConfig {
  lastVault?: string
  lastPage?: string
}

let cache: AmadeusConfig | null = null

function configFile(): string {
  // dev(未打包)与正式版分用不同配置文件:dev 永不继承正式版历史写入的 lastVault,
  // 两边 Amadeus vault 彻底隔离(dev→~/Forsion-Dev/Amadeus,正式版→~/Forsion/Amadeus)。
  return path.join(app.getPath('userData'), isDevMode() ? 'amadeus-config.dev.json' : 'amadeus-config.json')
}

/** Absolute path of the persisted Amadeus config (lastVault/lastPage). The agent's
 *  amadeus_* tools read `lastVault` from here live, so they follow the desktop's
 *  actual current vault (custom paths + runtime vault switching). */
export function amadeusConfigPath(): string {
  return configFile()
}

export async function readConfig(): Promise<AmadeusConfig> {
  if (cache) return cache
  try {
    cache = JSON.parse(await fs.readFile(configFile(), 'utf8')) as AmadeusConfig
  } catch {
    cache = {}
  }
  return cache
}

export async function writeConfig(patch: Partial<AmadeusConfig>): Promise<void> {
  const next = { ...(await readConfig()), ...patch }
  cache = next
  try {
    await fs.writeFile(configFile(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* best-effort */
  }
}
