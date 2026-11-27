/**
 * 远程同步的出网 fetch 包装(宿主用它包 Electron `net.fetch`,让 Dropbox / Google Drive 走系统代理)。
 *
 * 为什么用 net.fetch:主进程 Node 的全局 fetch(undici)不认系统代理 —— 国内开系统代理(非 TUN)时连不上
 * api.dropboxapi.com / googleapis.com;`net.fetch` 走 Chromium 网络栈,认系统代理 / PAC / SOCKS。
 * Electron 40 实测(2026-11-27,`npm run check:remotesync-netfetch`)它和 Node fetch 不同的地方,这里补齐:
 *  1. 默认带上 defaultSession 里该域名的 cookie —— 一律 credentials:'omit'(同步只用 Bearer 令牌);
 *  2. 可缓存的 GET 会进 Chromium 的 HTTP 缓存(Drive 下载的文件内容会落进 Electron 缓存目录,还可能拿到缓存的旧版)
 *     —— 一律 cache:'no-store';
 *  3. 已经 abort 的 signal 不再发请求(直接 reject,也不留未接住的底层 Promise)。
 * abort 本身交给 net.fetch:实测等响应头 / 读响应体 / 上传途中 abort 都会 reject,上传被掐断后服务端收不到完整请求体
 * (超时的上传不会在后台补完);探针钉着这条,升级 Electron 后先跑探针。响应原样返回,不在这里缓冲正文。
 * 隔离约定:不 import electron;底层 fetch 由宿主注入。
 */

export type BaseFetch = (input: string | Request, init?: RequestInit) => Promise<Response>

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('aborted', 'AbortError')

export function abortableFetch(base: BaseFetch): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input
    // init.signal 覆盖 Request 自带的(同 fetch 语义)
    const signal = init?.signal ?? (typeof target === 'string' ? undefined : target.signal)
    if (signal?.aborted) throw abortReason(signal)
    return base(target, { ...init, credentials: 'omit', cache: 'no-store' })
  }
  return wrapped as typeof fetch
}
