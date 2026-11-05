/**
 * 引擎所在的宿主客户端与系统,随每个云端请求带上(服务端记进用量,后台能看出「哪个 Forsion 客户端、什么系统」)。
 *
 * - `X-Forsion-Client`:宿主在启动引擎时注入的 `TANGU_HOST_CLIENT`(桌面 = `desktop/<App 版本>`)。和登录链路同一个头、同一种形状。
 *   run 自己的 client 标签(请求体里的 `client`,后台 run 是 `muse/<引擎版本>`)照旧单独报,两者不是一回事。
 * - `X-Forsion-Env`:`process.platform` 映射成 macos / windows / linux / android。
 *
 * 只有宿主注入了 `TANGU_HOST_CLIENT` 才报:没有宿主的部署(云端节点、命令行)不知道调用方坐在哪台机器前,
 * 报一个机房的 linux 只会误导。服务端对两个值都再过一遍闭集闸,这里不合法就干脆不发。
 */
const HOST_CLIENT_RE = /^(desktop|web|mobile|cli|tui)\/[A-Za-z0-9._-]{1,32}$/;
const ENV_OF: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macos', win32: 'windows', linux: 'linux', android: 'android' };

export function hostOriginHeaders(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const host = env.TANGU_HOST_CLIENT;
  if (typeof host !== 'string' || !HOST_CLIENT_RE.test(host)) return {};
  const os = ENV_OF[platform];
  return { 'X-Forsion-Client': host, ...(os ? { 'X-Forsion-Env': os } : {}) };
}
