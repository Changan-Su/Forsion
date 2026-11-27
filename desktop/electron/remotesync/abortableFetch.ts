/**
 * 远程同步的出网 fetch 包装(宿主用它包 Electron `net.fetch`,让 Dropbox / Google Drive 走系统代理)。
 *
 * 为什么用 net.fetch:主进程 Node 的全局 fetch(undici)不认系统代理 —— 国内开系统代理(非 TUN)时连不上
 * api.dropboxapi.com / googleapis.com;`net.fetch` 走 Chromium 网络栈,认系统代理 / PAC / SOCKS。
 * Electron 40 实测(2026-11-27,`npm run check:remotesync-netfetch`)它和 Node fetch 不同的地方,这里补齐:
 *  1. 默认带上 defaultSession 里该域名的 cookie —— 一律 credentials:'omit'(同步只用 Bearer 令牌);
 *  2. 可缓存的 GET 会进 Chromium 的 HTTP 缓存(Drive 下载的文件内容会落进 Electron 缓存目录,还可能拿到缓存的旧版)
 *     —— 一律 cache:'no-store';
 *  3. 响应体在包装里读完,并和 signal 赛跑(实测 net.fetch 自己的 abort 在等头 / 读体 / 上传途中都生效,
 *     这层只是兜底:哪天底层不理 abort,调用方也不会被拖住)。上传途中 abort,服务端收不到完整请求体,
 *     超时的上传不会在后台补完。
 * 隔离约定:不 import electron;底层 fetch 由宿主注入。
 */

/** 不许带响应体的状态码(new Response 传了 body 会抛)。 */
const NULL_BODY = new Set([204, 205, 304])

function raceAbort<T>(p: Promise<T>, signal: AbortSignal | null | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return p
  if (signal.aborted) {
    onAbort()
    return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort()
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', abort); resolve(v) },
      (e) => { signal.removeEventListener('abort', abort); reject(e) },
    )
  })
}

export type BaseFetch = (input: string | Request, init?: RequestInit) => Promise<Response>

export function abortableFetch(base: BaseFetch): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input
    const signal = init?.signal
    const rsp = await raceAbort(base(target, { ...init, credentials: 'omit', cache: 'no-store' }), signal, () => {})
    if (NULL_BODY.has(rsp.status) || !rsp.body) return new Response(null, { status: rsp.status, statusText: rsp.statusText, headers: rsp.headers })
    const body = await raceAbort(rsp.arrayBuffer(), signal, () => {
      void rsp.body?.cancel().catch(() => {}) // 尽力而为(流正被 arrayBuffer 锁着时会被拒,无妨)
    })
    return new Response(body, { status: rsp.status, statusText: rsp.statusText, headers: rsp.headers })
  }
  return wrapped as typeof fetch
}
