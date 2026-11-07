/**
 * Claude Code 生态扫描(裁剪移植自 Agents-Manager ClaudeCodeAdapter,只取 MCP):
 * - MCP:~/.claude.json 顶层 mcpServers + ~/.claude/mcp-servers.json + ~/.claude/.mcp.json
 *   (存在哪个读哪个,按名去重,先到先得)
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DiscoveredMcp, DiscoveryResult } from './types'
import { asStringArray, asStringRecord } from './scanUtil'

const ECOSYSTEM = 'claude-code' as const

export function scanClaude(home = homedir()): DiscoveryResult {
  const root = join(home, '.claude')
  return { mcpServers: scanMcp(home, root) }
}

function scanMcp(home: string, root: string): DiscoveredMcp[] {
  // .claude.json 顶层 mcpServers 优先(用户级配置),其余文件补充
  const candidates = [join(home, '.claude.json'), join(root, 'mcp-servers.json'), join(root, '.mcp.json')]
  const out: DiscoveredMcp[] = []
  const seen = new Set<string>()
  for (const path of candidates) {
    if (!existsSync(path)) continue
    let map: Record<string, Record<string, unknown>>
    try {
      const json = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }
      map = json?.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : {}
    } catch {
      continue // 坏 JSON 不阻断
    }
    for (const [name, def] of Object.entries(map)) {
      if (!def || typeof def !== 'object' || seen.has(name)) continue
      seen.add(name)
      out.push({
        ecosystem: ECOSYSTEM,
        name,
        config: {
          command: typeof def.command === 'string' ? def.command : undefined,
          args: asStringArray(def.args),
          env: asStringRecord(def.env),
          url: typeof def.url === 'string' ? def.url : undefined,
          // Claude 的 type ∈ stdio/http/sse,与 Tangu transport 同名;缺省时按 command/url 推断
          transport:
            def.type === 'http' || def.type === 'sse' || def.type === 'stdio'
              ? def.type
              : typeof def.command === 'string'
                ? 'stdio'
                : typeof def.url === 'string'
                  ? 'http'
                  : undefined,
          headers: asStringRecord(def.headers),
        },
      })
    }
  }
  return out
}
