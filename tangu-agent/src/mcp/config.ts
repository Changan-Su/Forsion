/**
 * MCP 配置:~/.tangu/mcp.json。schema 字段兼容 .claude.json / codex / hermes 的 mcp 配置,
 * 便于跨生态导入(desktop discovery 复制时基本零转换):
 *   { "mcpServers": { "<name>": { command?, args?, env?, url?, transport?, headers?, timeoutMs?, enabled? } } }
 * 类型推断(同 Agents-Manager):有 command → stdio;有 url → transport 显式 sse 否则 streamable-http。
 *
 * **加载语义(prompt 缓存纪律)**:MCP server 集在**后端进程启动时**冻结——manager 启动连一次,
 * 配置变更只对重启后的进程/新 run 生效(desktop 改配置走 ensureBackend 重启链)。
 * 绝不在 run 中途增删工具,否则同会话 defs 漂移打爆前缀缓存。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { mcpConfigFile, tanguHome } from '../core/tanguHome.js';
import { getRawSection, saveSection } from '../core/config.js';

export interface McpServerConfig {
  /** stdio:子进程命令(如 npx);与 url 二选一。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http/sse:远端端点。 */
  url?: string;
  transport?: 'stdio' | 'http' | 'sse';
  headers?: Record<string, string>;
  /** 单次工具调用超时(默认 60s)。 */
  timeoutMs?: number;
  /** false=配置保留但不连接(导入的外来配置默认 false,用户显式启用)。缺省 true。 */
  enabled?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export function inferTransport(cfg: McpServerConfig): 'stdio' | 'http' | 'sse' {
  if (cfg.transport === 'sse') return 'sse';
  if (cfg.transport === 'http') return 'http';
  if (cfg.transport === 'stdio') return 'stdio';
  if (cfg.command) return 'stdio';
  return 'http'; // url 默认 Streamable HTTP(SSE 须显式声明)
}

function legacyLoadMcp(file: string): McpConfig {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const servers = parsed?.mcpServers;
    if (servers && typeof servers === 'object') return { mcpServers: servers };
    return { mcpServers: {} };
  } catch {
    return { mcpServers: {} }; // 不存在/坏 JSON → 空配置(坏 JSON 由 desktop 编辑器另行提示)
  }
}

/** 显式传 file → 读该文件(explicit/单测);否则 config.json 的 mcp 段优先,缺失回落 ~/.tangu/mcp.json。 */
export function loadMcpConfig(file?: string): McpConfig {
  if (file) return legacyLoadMcp(file);
  const sec = getRawSection('mcp');
  if (sec !== undefined) {
    const servers = sec?.mcpServers;
    return { mcpServers: servers && typeof servers === 'object' ? servers : {} };
  }
  return legacyLoadMcp(mcpConfigFile());
}

/** 显式传 file → 写该文件(legacy);否则写 config.json 的 mcp 段(唯一真源,chmod 600)。 */
export function saveMcpConfig(cfg: McpConfig, file?: string): void {
  if (file) {
    mkdirSync(tanguHome(), { recursive: true });
    writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    try { chmodSync(file, 0o600); } catch { /* env/headers 可能含密钥 */ }
    return;
  }
  saveSection('mcp', { mcpServers: cfg.mcpServers });
}

/** 启用的 server 名单(连接顺序按名字典序——确定性,保证工具 defs 字节级稳定)。 */
export function enabledServers(cfg: McpConfig): Array<[string, McpServerConfig]> {
  return Object.entries(cfg.mcpServers)
    .filter(([, c]) => c && c.enabled !== false)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
