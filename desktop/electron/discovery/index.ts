/**
 * 跨生态 MCP 发现入口:三个 adapter 并行扫描,单个失败不阻断(目录不存在 = 空结果)。
 */
import { homedir } from 'node:os'
import type { DiscoveryResult } from './types'
import { scanClaude } from './claudeAdapter'
import { scanCodex } from './codexAdapter'
import { scanHermes } from './hermesAdapter'

export type { DiscoveredMcp, DiscoveredMcpConfig, DiscoveryResult, Ecosystem } from './types'
export { importMcp } from './importer'

export async function scanAll(home = homedir()): Promise<DiscoveryResult> {
  const settled = await Promise.allSettled([
    Promise.resolve().then(() => scanClaude(home)),
    Promise.resolve().then(() => scanCodex(home)),
    Promise.resolve().then(() => scanHermes(home)),
  ])
  const merged: DiscoveryResult = { mcpServers: [] }
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue // 单生态崩了照常返回其余
    merged.mcpServers.push(...r.value.mcpServers)
  }
  return merged
}
