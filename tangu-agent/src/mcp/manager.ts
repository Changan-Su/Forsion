import { isHostSandboxRestricted } from '../sandbox/hostSandboxPolicy.js';
/**
 * MCP 管理器(仅 standalone/TUI 组装;deps().mcp 可选——microserver/worker 不构造,云端零影响):
 *   - 进程启动时连接 ~/.tangu/mcp.json 启用的 server(stdio / Streamable HTTP / SSE),并行、单个最多 30s
 *   - listTools 缓存按 (server, tool) 字典序 → 工具 defs 字节级稳定(prompt 缓存纪律)
 *   - server 发 tools/list_changed → 后台刷新缓存,但**只对新 run 生效**(toolsForRun 每 run 取一次快照)
 *   - 断线自愈(方案 2026-09-26 §3.3 M3):只认 client 的 onclose(stdio 子进程退出 / 显式关闭)——
 *     transport 的 onerror 多是良性事件(SSE GET 流重试、405 等),绝不据此重建连接。断线 / 启动没连上的
 *     server 进后台重试(退避 5s 起翻倍、封顶 5min),连上后进入**下一个** run 的快照,在飞 run 的工具集不动。
 *     有状态 Streamable HTTP server 重启后旧 session 回 404(规范要求客户端重新 initialize):这是调用结果,
 *     不是 onerror —— 就地重连并重发一次(404 说明 server 没处理这条请求)。
 *   - 跨 server 撞名(消毒后同名)按 server 名字典序先到先得,后到者拒绝并告警,不静默覆盖(M4)
 *   - callTool 带超时;dispose 关闭全部连接(stdio 杀子进程)并撤掉重试定时器,process.on('exit') 兜底
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadMcpConfig, enabledServers, inferTransport, type McpServerConfig } from './config.js';
import { bridgeTool, contentToResult, fenceMcpText, type LoadedMcpTool, type McpImage } from './toolBridge.js';

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const RESULT_CAP_CHARS = 50_000;
const RECONNECT_COOLDOWN_MS = 15_000; // 懒重连冷却:死 server 不会每次调用都重连
const RETRY_BASE_MS = 5_000; // 后台重试退避起点,逐次翻倍
const RETRY_MAX_MS = 300_000; // 退避封顶
const DISPOSE_WAIT_MS = 5_000; // dispose 等在飞连接收尾的上限(SDK stdio close 自带 2s 优雅退出 + 2s SIGTERM)
const STABLE_MS = 60_000; // 连上后撑过这么久再断,才把退避清零(连上即崩的 server 不会 5s 一次地无限拉起)

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  status: 'connected' | 'connecting' | 'error' | 'disabled';
  toolCount: number;
  error?: string;
}

/** 时间常量覆写(单测用;生产不传)。 */
export interface McpManagerOptions {
  reconnectCooldownMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  connectTimeoutMs?: number;
}

export interface McpCallResult {
  /** 已圈进不可信围栏的文本(或引擎自己的 `Error: …` 说明)。 */
  text: string;
  isError: boolean;
  /** server 返回的图片(由调用方经 collectImage 回灌)。 */
  images?: McpImage[];
}

interface ServerEntry {
  name: string;
  cfg: McpServerConfig;
  transport: 'stdio' | 'http' | 'sse';
  client: Client | null;
  tools: LoadedMcpTool[];
  status: McpServerStatus['status'];
  error?: string;
  lastReconnectAt?: number; // 最近一次连接尝试时刻(懒重连冷却用;后台重试也记)
  connecting: Promise<void> | null; // 在飞的连接(后台重试与懒重连共用一次)
  pendingClient: Client | null; // 正在 initialize 的 client(dispose 要能关掉它,否则留下 stdio 子进程)
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  connectedAt: number;
  configError: boolean; // 缺 command/url 之类的确定性错误:重试也没用
}

export interface McpManager {
  /** 本 run 的工具快照(已按 server 名过滤;Map 键=桥接名)。run 开始取一次,run 内不变。 */
  toolsForRun(enabledServerNames?: string[]): Map<string, LoadedMcpTool>;
  callTool(bridged: LoadedMcpTool, args: Record<string, any>, signal?: AbortSignal): Promise<McpCallResult>;
  listStatus(): McpServerStatus[];
  /** 连接(启动时调用一次;失败的 server 记错误不阻断其他,转后台重试)。 */
  start(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * 有状态 Streamable HTTP 的 session 失效(会重发,所以只认「分发工具之前就拒掉」的形态):
 *   - 404:规范口径(未知 Mcp-Session-Id 必须回 404);
 *   - 400 只认 SDK 两处分发前拒绝的**原样 JSON-RPC 错误体**(id:null、文案逐字):单 transport server 重启后的
 *     「Bad Request: Server not initialized」(webStandardStreamableHttp.validateSession)与 SDK 示例 server 的
 *     「Bad Request: No valid session ID provided」。正文里只是「含这句话」不算。
 *   其余 400 一律交还调用方 —— 可能是工具已执行后才报的错,重发就是重复副作用。
 */
const PRE_DISPATCH_400 = new Set(['Bad Request: Server not initialized', 'Bad Request: No valid session ID provided']);
export function sessionGone(e: unknown, hadSession: boolean): boolean {
  if (!hadSession || !(e instanceof StreamableHTTPError)) return false;
  if (e.code === 404) return true;
  if (e.code !== 400) return false;
  const i = e.message.indexOf('{'); // SDK:`Streamable HTTP error: Error POSTing to endpoint: <响应正文>`
  if (i < 0) return false;
  try {
    const body = JSON.parse(e.message.slice(i));
    return body?.jsonrpc === '2.0' && body.id === null && body.error?.code === -32000 && PRE_DISPATCH_400.has(body.error?.message);
  } catch {
    return false;
  }
}

export function createMcpManager(configFile?: string, opts: McpManagerOptions = {}): McpManager {
  const servers: ServerEntry[] = [];
  let exitHook = false;
  let disposed = false;
  const reconnectCooldownMs = opts.reconnectCooldownMs ?? RECONNECT_COOLDOWN_MS;
  const retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
  const retryMaxMs = opts.retryMaxMs ?? RETRY_MAX_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const warnedCollisions = new Set<string>();

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
      const used = new Set<string>(); // server 内去重(跨 server 撞名在 toolsForRun 处理)
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

  function clearRetry(entry: ServerEntry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }

  function scheduleRetry(entry: ServerEntry): void {
    if (disposed || entry.configError || entry.retryTimer) return;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(entry.retryAttempt, 20));
    entry.retryAttempt++;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      void connect(entry);
    }, delay);
    entry.retryTimer.unref?.();
  }

  /** client 的 onclose:只认当前那个 client(旧连接 / 连接失败时我们自己关掉的 client 不算)。 */
  function onClientClosed(entry: ServerEntry, client: Client): void {
    if (disposed || entry.client !== client) return;
    entry.client = null;
    entry.status = 'error';
    entry.error = 'connection closed';
    if (Date.now() - entry.connectedAt >= STABLE_MS) entry.retryAttempt = 0;
    console.warn(`[mcp] ${entry.name}: 连接已断开,转后台重连`);
    scheduleRetry(entry);
  }

  function connect(entry: ServerEntry): Promise<void> {
    if (!entry.connecting) entry.connecting = doConnect(entry).finally(() => { entry.connecting = null; });
    return entry.connecting;
  }

  async function doConnect(entry: ServerEntry): Promise<void> {
    if (disposed) return;
    clearRetry(entry);
    const stale = entry.client;
    entry.client = null;
    if (stale) await stale.close().catch(() => {}); // entry.client 已换掉 → 它的 onclose 不会再触发重连
    if (disposed) return;
    entry.status = 'connecting';
    entry.lastReconnectAt = Date.now(); // 懒重连冷却按「最近一次尝试」算,后台尝试也算
    let client: Client | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (isHostSandboxRestricted()) throw new Error('MCP servers are unavailable while the local sandbox is enabled');
      let transport: ReturnType<typeof buildTransport>;
      try {
        transport = buildTransport(entry.name, entry.cfg);
      } catch (e) {
        entry.configError = true;
        throw e;
      }
      const c = new Client({ name: 'tangu-agent', version: '1.0.0' });
      client = c;
      entry.pendingClient = c;
      c.onclose = () => onClientClosed(entry, c);
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`connect 超时(${connectTimeoutMs / 1000}s)`)), connectTimeoutMs);
        timer.unref?.();
      });
      await Promise.race([c.connect(transport), timeout]);
      if (disposed) throw new Error('disposed');
      entry.client = c;
      entry.connectedAt = Date.now();
      // 工具列表变更通知:后台刷新(只影响之后开始的 run——toolsForRun 每 run 取快照)
      c.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (entry.client === c) await refreshTools(entry);
      });
      await refreshTools(entry);
      if (entry.client !== c) return; // 列工具期间就断了:onClientClosed 已记错误并排好重试
      entry.status = 'connected';
      entry.error = undefined;
      console.log(`[mcp] ${entry.name}(${entry.transport}) 已连接,${entry.tools.length} 个工具`);
    } catch (e: any) {
      entry.status = 'error';
      entry.error = e?.message || String(e);
      entry.client = null;
      // 超时 / 失败的 client 要关掉:否则超时后才起来的 stdio 子进程成了孤儿
      if (client) await client.close().catch(() => {});
      if (!disposed) {
        console.warn(`[mcp] ${entry.name} 连接失败:`, entry.error);
        scheduleRetry(entry);
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (client && entry.pendingClient === client) entry.pendingClient = null;
    }
  }

  return {
    async start() {
      const cfg = loadMcpConfig(configFile);
      for (const [name, c] of enabledServers(cfg)) {
        servers.push({
          name, cfg: c, transport: inferTransport(c), client: null, tools: [], status: 'connecting',
          connecting: null, pendingClient: null, retryTimer: null, retryAttempt: 0, connectedAt: 0, configError: false,
        });
      }
      // 失败互不阻断;并行连(没连上的转后台重试,不拖启动)
      await Promise.all(servers.map((s) => connect(s)));
      if (!exitHook && servers.some((s) => s.transport === 'stdio')) {
        exitHook = true;
        process.on('exit', () => {
          for (const s of servers) void s.client?.close().catch(() => {});
        });
      }
    },

    toolsForRun(enabledServerNames?: string[]) {
      // servers 按名字典序(enabledServers)→ 跨 server 撞名先到先得,与连接时序无关。
      // 撞名的前者没进本快照(未连接 / 被 enabledServerNames 滤掉)时后者照常可用 —— 同名只可能指向一个 server。
      const out = new Map<string, LoadedMcpTool>();
      for (const s of servers) {
        if (s.status !== 'connected') continue;
        if (enabledServerNames && !enabledServerNames.includes(s.name)) continue;
        for (const t of s.tools) {
          const prev = out.get(t.name);
          if (!prev) { out.set(t.name, t); continue; }
          const key = `${t.name}\u0000${s.name}\u0000${prev.serverName}`;
          if (!warnedCollisions.has(key)) {
            warnedCollisions.add(key);
            console.warn(`[mcp] 工具名冲突:${s.name}/${t.remoteName} 桥接后与 ${prev.serverName}/${prev.remoteName} 同为 ${t.name},已拒绝后者(按 server 名字典序先到先得)。请给其中一个 server 改名。`);
          }
        }
      }
      return out;
    },

    async callTool(bridged, args, signal) {
      if (isHostSandboxRestricted()) return { text: 'Error: MCP is unavailable while the local sandbox is enabled', isError: true };
      const entry = servers.find((s) => s.name === bridged.serverName);
      if (!entry) return { text: `Error: MCP server "${bridged.serverName}" 未配置`, isError: true };
      // 懒重连:server 断线 / 初次没连上时,调用前按冷却(15s)尝试重连一次(后台重试正在连就搭它的车)——
      // 避免「server 挂了不重连、工具一直 hang 到 timeout」。冷却防对死 server 每调必连。
      if (entry.status !== 'connected' || !entry.client) {
        const now = Date.now();
        if (entry.connecting) await entry.connecting;
        else if (now - (entry.lastReconnectAt || 0) >= reconnectCooldownMs) await connect(entry);
        if (entry.status !== 'connected' || !entry.client) {
          return { text: `Error: MCP server "${bridged.serverName}" 未连接`, isError: true };
        }
      }
      const timeoutMs = entry.cfg.timeoutMs && entry.cfg.timeoutMs > 0 ? entry.cfg.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
      const invoke = (c: Client) => c.callTool(
        { name: bridged.remoteName, arguments: args },
        undefined,
        { timeout: timeoutMs, ...(signal ? { signal } : {}) },
      );
      try {
        const client = entry.client;
        const hadSession = entry.transport === 'http' && !!client.transport?.sessionId;
        let result;
        try {
          result = await invoke(client);
        } catch (e) {
          if (!sessionGone(e, hadSession)) throw e;
          console.warn(`[mcp] ${entry.name}: session 已失效(server 重启?),重新 initialize 后重发一次`);
          // 只重建「撞上 404 的那个」client:并发的另一次调用可能已经换上新 session,别把它关掉再建一遍
          if (entry.client === client) await connect(entry); // doConnect 先关掉旧 client(不会触发 onclose 重连)
          else if (entry.connecting) await entry.connecting;
          if (entry.status !== 'connected' || !entry.client) throw e;
          result = await invoke(entry.client);
        }
        const r = contentToResult(result);
        return { text: fenceMcpText(entry.name, r.text, RESULT_CAP_CHARS), isError: r.isError, images: r.images };
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
      disposed = true;
      for (const s of servers) clearRetry(s);
      // 在飞的 initialize 一并关掉(connect 随之失败),再等它们收尾 —— 返回时不留子进程、不再起新连接
      await Promise.all(servers.flatMap((s) => [s.client, s.pendingClient]).map((c) => c?.close().catch(() => {})));
      // 等收尾有上限:SSE 流开了却迟迟不发 endpoint 时,close 不会让 SDK 的 start() 结束,干等会拖满连接超时。
      // 超时后照样返回 —— 迟到的连接在 doConnect 里见 disposed 自己关掉。
      let cap: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(servers.map((s) => s.connecting?.catch(() => {}))),
        new Promise<void>((resolve) => { cap = setTimeout(resolve, DISPOSE_WAIT_MS); cap.unref?.(); }),
      ]);
      if (cap) clearTimeout(cap);
      servers.length = 0;
    },
  };
}
