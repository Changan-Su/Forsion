/**
 * 引擎插件自带的 MCP server(manifest `tangu-plugin.json` 的 `mcpServers`,形态同 mcp.json 的 mcpServers)。
 *
 * - 跟着插件走:插件激活 → server 加进 manager;停用 / 卸载 / 激活失败 → 关掉并移出(bootstrap 记进实例台账)。
 *   捆绑包里的引擎插件跟随捆绑包开关(桌面级联),所以「桌面停用插件 → 它的 MCP 进程也停」是现成的。
 * - **只收 stdio**(随包发的静态 server):远端 server 的地址与令牌是运行期数据,不该写进 manifest ——
 *   远端能力照旧走「服务端自己出 MCP 端点、插件只做接入卡」(server-admin 先例)。这是对 09-06「声明式 MCP 刻意没加,
 *   真有静态 stdio MCP 要随包发时再议」的落地,url / headers 一律不收。
 * - 信任级别 = 插件自己的代码:引擎插件本来就在引擎进程里跑任意代码,stdio server 并不扩大权限,不另设确认。
 * - 命名:用声明的名字(工具名 `mcp__<name>__<tool>` 要短,插件 id 可能是 `market-<uuid>`)。和用户 mcp.json 里的
 *   server 撞名时插件这份被拒(用户的先注册);两个插件撞名先激活者得(激活序确定)。
 * - stdio 的工作目录 = 插件目录,`${pluginDir}` 在 command / args / env 里展开成插件目录的绝对路径。
 * - manager 没装配(云端 worker / microserver)时什么都不做。
 */
import type { McpManager } from './manager.js';
import type { McpServerConfig } from './config.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
const MAX_SERVERS = 8;
const MAX_ARGS = 64;
const MAX_KV = 64;

const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function strMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v).slice(0, MAX_KV)) if (/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(k) && typeof val === 'string' && val.length <= 4096) out[k] = val;
  return out;
}

/** manifest 原值 → 合法的 server 表(坏项逐条丢弃并告警,不连坐其余)。 */
export function sanitizePluginMcpServers(raw: unknown, pluginId: string, pluginDir: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const expand = (s: string) => s.split('${pluginDir}').join(pluginDir);
  for (const [name, c] of Object.entries(raw as Record<string, any>).slice(0, MAX_SERVERS)) {
    const bad = (why: string) => console.warn(`[tangu] 插件 ${pluginId} 的 MCP server "${name}" 无效(${why}),跳过`);
    if (!NAME_RE.test(name)) { bad('名字须为字母数字 / _ / -,≤32'); continue; }
    if (!c || typeof c !== 'object') { bad('不是对象'); continue; }
    if (!str(c.command) || (c.transport !== undefined && c.transport !== 'stdio')) { bad('只收 stdio:要有 command,不收 url'); continue; }
    const cfg: McpServerConfig = { command: expand(c.command), transport: 'stdio', cwd: pluginDir };
    if (Array.isArray(c.args)) cfg.args = c.args.slice(0, MAX_ARGS).filter((a: unknown) => typeof a === 'string').map(expand);
    const env = strMap(c.env);
    if (env) cfg.env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expand(v)]));
    if (typeof c.timeoutMs === 'number' && c.timeoutMs > 0) cfg.timeoutMs = Math.min(c.timeoutMs, 600_000);
    if (c.enabled === false) continue; // 声明了但关着 = 不起
    out[name] = cfg;
  }
  return out;
}

let bound: McpManager | null = null;

/** standalone / TUI 在激活插件之前把 manager 交进来(没交 = 宿主不支持 MCP,插件声明一律忽略)。 */
export function bindPluginMcp(mgr: McpManager | null): void {
  bound = mgr;
}

/** 插件激活后调用:有声明就加进 manager,返回撤销函数(进实例台账);没有声明 / 没装配 manager → undefined。 */
export function attachPluginMcp(pluginId: string, pluginName: string, pluginDir: string, raw: unknown): (() => void) | undefined {
  if (raw === undefined) return undefined;
  const servers = sanitizePluginMcpServers(raw, pluginId, pluginDir);
  if (!Object.keys(servers).length) return undefined;
  const mgr = bound;
  if (!mgr) {
    console.warn(`[tangu] 插件 ${pluginId} 声明了 MCP server,但这个宿主没有 MCP(云端 / 未装配),忽略`);
    return undefined;
  }
  mgr.addServers({ id: pluginId, name: pluginName }, servers);
  return () => { void mgr.removeServers(pluginId); };
}
