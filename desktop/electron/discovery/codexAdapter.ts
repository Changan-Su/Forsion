/**
 * Codex 生态扫描:
 * - MCP:~/.codex/config.toml 的 [mcp_servers.<name>] 块(command/args/env/url)
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import TOML from '@iarna/toml'
import type { DiscoveredMcp, DiscoveryResult } from './types'
import { asStringArray, asStringRecord } from './scanUtil'

const ECOSYSTEM = 'codex' as const

export function scanCodex(home = homedir()): DiscoveryResult {
  const root = join(home, '.codex')
  return { mcpServers: scanMcp(join(root, 'config.toml')) }
}

function scanMcp(configFile: string): DiscoveredMcp[] {
  if (!existsSync(configFile)) return []
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>
  } catch {
    return [] // 坏 TOML 不阻断
  }
  const servers = parsed.mcp_servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
  const out: DiscoveredMcp[] = []
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const def = raw as Record<string, unknown>
    const command = typeof def.command === 'string' ? def.command : undefined
    const url = typeof def.url === 'string' ? def.url : undefined
    if (!command && !url) continue
    out.push({
      ecosystem: ECOSYSTEM,
      name,
      config: {
        command,
        args: asStringArray(def.args),
        env: asStringRecord(def.env),
        url,
        transport: command ? 'stdio' : 'http', // codex:command=stdio;url=streamable HTTP
      },
    })
  }
  return out
}
