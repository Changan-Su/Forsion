/**
 * Hermes 生态扫描:
 * - MCP:~/.hermes/config.yaml 的 `mcp_servers:` 块
 *   (字段 command/args/env/url/transport/headers/timeout;timeout 秒 → timeoutMs)
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'
import type { DiscoveredMcp, DiscoveryResult } from './types'
import { asStringArray, asStringRecord } from './scanUtil'

const ECOSYSTEM = 'hermes' as const

export function scanHermes(home = homedir()): DiscoveryResult {
  const root = join(home, '.hermes')
  return { mcpServers: scanMcp(join(root, 'config.yaml')) }
}

function scanMcp(configFile: string): DiscoveredMcp[] {
  if (!existsSync(configFile)) return []
  let parsed: Record<string, unknown> | null
  try {
    parsed = YAML.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown> | null
  } catch {
    return [] // 坏 YAML 不阻断
  }
  const servers = parsed?.mcp_servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
  const out: DiscoveredMcp[] = []
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const def = raw as Record<string, unknown>
    const command = typeof def.command === 'string' ? def.command : undefined
    const url = typeof def.url === 'string' ? def.url : undefined
    if (!command && !url) continue
    const timeout = typeof def.timeout === 'number' && def.timeout > 0 ? def.timeout : undefined
    out.push({
      ecosystem: ECOSYSTEM,
      name,
      config: {
        command,
        args: asStringArray(def.args),
        env: asStringRecord(def.env),
        url,
        transport:
          def.transport === 'stdio' || def.transport === 'http' || def.transport === 'sse'
            ? def.transport
            : command
              ? 'stdio'
              : 'http',
        headers: asStringRecord(def.headers),
        timeoutMs: timeout ? timeout * 1000 : undefined, // hermes 用秒
      },
    })
  }
  return out
}
