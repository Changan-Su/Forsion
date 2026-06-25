/**
 * MCP 管理器(仅 standalone/TUI 组装;deps().mcp 可选——microserver/worker 不构造,云端零影响):
 *   - 进程启动时连接 ~/.tangu/mcp.json 启用的 server(stdio / Streamable HTTP / SSE)
 *   - listTools 缓存按 (server, tool) 字典序 → 工具 defs 字节级稳定(prompt 缓存纪律)
 *   - server 发 tools/list_changed → 后台刷新缓存,但**只对新 run 生效**(toolsForRun 每 run 取一次快照)
 *   - callTool 带超时;dispose 关闭全部连接(stdio 杀子进程),process.on('exit') 兜底
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadMcpConfig, enabledServers, inferTransport, type McpServerConfig } from './config.js';
import { bridgeTool, contentToText, type LoadedMcpTool } from './toolBridge.js';

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const RESULT_CAP_CHARS = 50_000;
const RECONNECT_COOLDOWN_MS = 15_000; // 懒重连冷却:死 server 不会每次调用都重连

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  status: 'connected' | 'connecting' | 'error' | 'disabled';
  toolCount: number;
  error?: string;
}

interface ServerEntry {
  name: string;
  cfg: McpServerConfig;
  transport: 'stdio' | 'http' | 'sse';
  client: Client | null;
  tools: LoadedMcpTool[];
  status: McpServerStatus['status'];
  error?: string;
  lastReconnectAt?: number; // 上次懒重连尝试时刻(冷却用)
}

export interface McpManager {
  /** 本 run 的工具快照(已按 server 名过滤;Map 键=桥接名)。run 开始取一次,run 内不变。 */
  toolsForRun(enabledServerNames?: string[]): Map<string, LoadedMcpTool>;
  callTool(bridged: LoadedMcpTool, args: Record<string, any>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
  listStatus(): McpServerStatus[];
  /** 连接(启动时调用一次;失败的 server 记错误不阻断其他)。 */
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export function createMcpManager(configFile?: string): McpManager {
  const servers: ServerEntry[] = [];
  let exitHook = false;

  function buildTransport(name: string, cfg: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
    const t = inferTransport(cfg);
    if (t === 'stdio') {
      if (!cfg.command) throw new Error('stdio server 缺 command');
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        // 子进程只继承显式 env + PATH/HOME 基本面(对齐 hermes 的 env 白名单思路)
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ...(cfg.env ?? {}),
        },
        stderr: 'ignore',
      });
    }
    if (!cfg.url) throw new Error(`${t} server 缺 url`);
    const url = new URL(cfg.url);
    const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
    return t === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
  }

  async function refreshTools(entry: ServerEntry): Promise<void> {
    if (!entry.client) return;
    try {
      const r = await entry.client.listTools();
      const used = new Set<string>(); // 名字空间含 server 名,server 内去重即可
      const tools: LoadedMcpTool[] = [];
      // (server, tool) 字典序 → defs 顺序确定性
      const sorted = [...(r.tools ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const t of sorted) {
        const bridged = bridgeTool(entry.name, t as any, used);
        if (bridged) tools.push(bridged);
      }
      entry.tools = tools;
    } catch (e: any) {
      console.warn(`[mcp] ${entry.name}: listTools 失败:`, e?.message || e);
    }
  }

  async function connect(entry: ServerEntry): Promise<void> {
    entry.status = 'connecting';
    try {
      const client = new Client({ name: 'tangu-agent', version: '1.0.0' });
      const transport = buildTransport(entry.name, entry.cfg);
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`connect 超时(${CONNECT_TIMEOUT_MS / 1000}s)`)), CONNECT_TIMEOUT_MS).unref?.(),
      );
      await Promise.race([client.connect(transport), timeout]);
      entry.client = client;
      // 工具列表变更通知:后台刷新(只影响之后开始的 run——toolsForRun 每 run 取快照)
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await refreshTools(entry);
      });
      await refreshTools(entry);
      entry.status = 'connected';
      entry.error = undefined;
      console.log(`[mcp] ${entry.name}(${entry.transport}) 已连接,${entry.tools.length} 个工具`);
    } catch (e: any) {
      entry.status = 'error';
      entry.error = e?.message || String(e);
      entry.client = null;
      console.warn(`[mcp] ${entry.name} 连接失败:`, entry.error);
    }
  }

  return {
    async start() {
      const cfg = loadMcpConfig(configFile);
      for (const [name, c] of enabledServers(cfg)) {
        servers.push({ name, cfg: c, transport: inferTransport(c), client: null, tools: [], status: 'connecting' });
      }
      // 失败互不阻断;并行连
      await Promise.all(servers.map((s) => connect(s)));
      if (!exitHook && servers.some((s) => s.transport === 'stdio')) {
        exitHook = true;
        process.on('exit', () => {
          for (const s of servers) void s.client?.close().catch(() => {});
        });
      }
    },

    toolsForRun(enabledServerNames?: string[]) {
      const out = new Map<string, LoadedMcpTool>();
      for (const s of servers) {
        if (s.status !== 'connected') continue;
        if (enabledServerNames && !enabledServerNames.includes(s.name)) continue;
        for (const t of s.tools) out.set(t.name, t);
      }
      return out;
    },

    async callTool(bridged, args, signal) {
      const entry = servers.find((s) => s.name === bridged.serverName);
      if (!entry) return { text: `Error: MCP server "${bridged.serverName}" 未配置`, isError: true };
      // 懒重连:server 启动后掉线 / 初次没连上时,调用前按冷却(15s)尝试重连一次——
      // 避免「server 挂了不重连、工具一直 hang 到 timeout」。冷却防对死 server 每调必连。
      if (entry.status !== 'connected' || !entry.client) {
        const now = Date.now();
        if (now - (entry.lastReconnectAt || 0) >= RECONNECT_COOLDOWN_MS) {
          entry.lastReconnectAt = now;
          await connect(entry);
        }
        if (entry.status !== 'connected' || !entry.client) {
          return { text: `Error: MCP server "${bridged.serverName}" 未连接`, isError: true };
        }
      }
      const timeoutMs = entry.cfg.timeoutMs && entry.cfg.timeoutMs > 0 ? entry.cfg.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
      try {
        const result = await entry.client.callTool(
          { name: bridged.remoteName, arguments: args },
          undefined,
          { timeout: timeoutMs, ...(signal ? { signal } : {}) },
        );
        const { text, isError } = contentToText(result);
        return { text: text.length > RESULT_CAP_CHARS ? text.slice(0, RESULT_CAP_CHARS) + '\n…[truncated]' : text, isError };
      } catch (e: any) {
        // 凭证防漏:错误信息可能回显 headers/env,粗暴掐掉超长部分
        const msg = String(e?.message || e).slice(0, 500);
        return { text: `Error: MCP 调用失败: ${msg}`, isError: true };
      }
    },

    listStatus() {
      return servers.map((s) => ({
        name: s.name,
        transport: s.transport,
        status: s.status,
        toolCount: s.tools.length,
        error: s.error,
      }));
    },

    async dispose() {
      await Promise.all(servers.map((s) => s.client?.close().catch(() => {})));
      servers.length = 0;
    },
  };
}
