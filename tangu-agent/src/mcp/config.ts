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
import { sanitizePart } from './toolBridge.js';

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

/**
 * 设备 MCP 的保留前缀(方案 2026-09-26 §4.6-3):`mcp__dev_<alias>__<tool>` 是引擎注入的设备工具命名空间,
 * mcp.json 里的第三方 server 不得占用。按**桥接后**的形态判、不分大小写:`dev.x` / `DEV x` 经 sanitizePart
 * 都会桥成 `mcp__dev_x__…`(大小写不同也足以让模型与人混淆)。
 */
export const RESERVED_SERVER_PREFIX = 'dev_';
export function isReservedServerName(name: string): boolean {
  return sanitizePart(name).toLowerCase().startsWith(RESERVED_SERVER_PREFIX);
}

const warnedReserved = new Set<string>();
/**
 * 存量配置里占用保留前缀的 server:告警并改名为 `user_<原名>`(撞名再加 `_2`…),不静默丢弃 —— 用户的 server
 * 照常可用,只是不再能冒充设备命名空间。按原名字典序处理 → 改名结果确定。只改内存视图,不回写磁盘;
 * 读改写路径(engines/assets.ts 的 updateSection)会把改名后的键顺带写回。
 */
function renameReservedServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const names = Object.keys(servers);
  const reserved = names.filter(isReservedServerName).sort();
  if (!reserved.length) return servers;
  const out: Record<string, McpServerConfig> = Object.create(null); // 无原型:键名 `__proto__` / `constructor` 不串味
  for (const n of names) if (!isReservedServerName(n)) out[n] = servers[n];
  for (const n of reserved) {
    let target = `user_${n}`;
    for (let i = 2; target in out; i++) target = `user_${n}_${i}`;
    out[target] = servers[n];
    if (!warnedReserved.has(n)) {
      warnedReserved.add(n);
      console.warn(`[mcp] server "${n}" uses the reserved "${RESERVED_SERVER_PREFIX}" prefix (device MCP namespace); loaded as "${target}". Rename it in the MCP settings.`);
    }
  }
  return out;
}

function legacyLoadMcp(file: string): McpConfig {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const servers = parsed?.mcpServers;
    if (servers && typeof servers === 'object') return { mcpServers: renameReservedServers(servers) };
    return { mcpServers: {} };
  } catch {
    return { mcpServers: {} }; // 不存在/坏 JSON → 空配置(坏 JSON 由 desktop 编辑器另行提示)
  }
}

/** 显式传 file → 读该文件(explicit/单测);否则 config.json 的 mcp 段优先,缺失回落 ~/.tangu/mcp.json。 */
export function loadMcpConfig(file?: string): McpConfig {
  if (file) return legacyLoadMcp(file);
  return mcpConfigFrom(getRawSection('mcp'));
}
/** mcp 段原始值 → 配置(段缺失回落 ~/.tangu/mcp.json);给 updateSection('mcp', …) 在锁内用。 */
export function mcpConfigFrom(sec: any): McpConfig {
  if (sec !== undefined) {
    const servers = sec?.mcpServers;
    return { mcpServers: servers && typeof servers === 'object' ? renameReservedServers(servers) : {} };
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
