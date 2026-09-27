/**
 * 契约 C2 · 工具子进程剥凭据环境变量(设备能力 MCP 方案 P0 ⑤,§6.2-9 / §6.4-2)。
 *
 * 引擎进程自己要用 TANGU_TOKEN(forsion_token,调云端)、TANGU_LOCAL_TOKEN(本机 HTTP 鉴权)、
 * TANGU_REMOTE_MARK_SECRET(验 unitWeb 的远程盖章);模型驱动的子进程(run_bash / 后台进程 / verifyCommand /
 * rg / 浏览器 / 外部 ACP 引擎)一个都不该拿到 —— 拿到 forsion_token = 能直接调云端批准别的设备上的审批。
 * 只剥「本进程的凭据」,不动 PATH / HOME / 用户自己的工具 key(OPENAI_API_KEY 之类是用户给工具链的,不归引擎管)。
 * ⚠️ 不改 process.env:config.ts 解析时读一次,其余读取方(浏览器 key 等)是懒读的。
 */

/** 引擎 / 宿主自己的凭据变量(大小写不敏感比对:Windows 环境变量名不分大小写)。 */
export const CREDENTIAL_ENV_KEYS = [
  'TANGU_TOKEN', 'TANGU_LOCAL_TOKEN', 'TANGU_REMOTE_MARK_SECRET',
  'TANGU_WORKER_KEY', 'TANGU_FLEET_SECRET', 'TANGU_PROVIDER_API_KEY', 'TANGU_BROWSER_USE_API_KEY',
  'FORSION_TOKEN',
] as const;
const KEYS = new Set<string>(CREDENTIAL_ENV_KEYS.map((k) => k.toUpperCase()));

/** base(缺省 process.env)的拷贝,去掉凭据变量。返回新对象,永不改入参。 */
export function toolSubprocessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!KEYS.has(k.toUpperCase())) out[k] = v;
  return out;
}
