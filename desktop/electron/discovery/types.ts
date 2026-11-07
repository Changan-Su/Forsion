/**
 * 跨生态 agent 资产发现:扫描本机 ~/.claude(Claude Code)、~/.codex(Codex)、
 * ~/.hermes(Hermes)的 MCP server 配置,供「从其他 AI 导入」勾选导入。
 * 技能、记忆、偏好 11-03 起归引擎(tangu-agent services/externalImport):这里原来的技能导入同名会先删再拷。
 * 纯 Node 实现(不依赖 electron),便于 tsx 直跑验证。
 */

export type Ecosystem = 'claude-code' | 'codex' | 'hermes'

/** 与 Tangu McpServerConfig(src/mcp/config.ts)同形,导入时基本零转换。 */
export interface DiscoveredMcpConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: 'stdio' | 'http' | 'sse'
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface DiscoveredMcp {
  ecosystem: Ecosystem
  name: string
  config: DiscoveredMcpConfig
}

export interface DiscoveryResult {
  mcpServers: DiscoveredMcp[]
}
