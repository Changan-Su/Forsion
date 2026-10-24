/**
 * fetch 薄封装:在底层集中拦截 401(token 过期/失效)。
 * 在 fetch 层而非调用层拦截,因为很多调用方(轮询、SSE)会把抛出的错误吞掉 —— 拦截器仍能先行触发。
 * 只对 401 触发重登录;403(配额/权限)由调用方按业务处理,不在此拦。
 */
/** 目标键(P1-K6 S2):'home' = 本端引擎;'unit:<id>' = 经 hub 隧道的「我的电脑」。叶子模块,不 import 解析层。 */
type UnauthorizedTarget = 'home' | `unit:${string}`
let onUnauthorized: ((target: UnauthorizedTarget) => void) | null = null

/** 启动时注册一次(bootstrap)。拦截器收到是哪台引擎回的 401(unit 的 401 不得触发本机引擎重启 / 误登出,K6 §3.5)。 */
export function setUnauthorizedHandler(fn: (target: UnauthorizedTarget) => void): void {
  onUnauthorized = fn
}

/**
 * opts.timeoutMs: **opt-in** 超时(不设=永不超时,SSE/长轮询保持原样)。管到**调用方读完响应体**为止,不止到响应头:
 * 头到了、体卡住(半截 JSON 后连接挂着)时,r.json() 同样按时以 TimeoutError 失败。
 * 与调用方自带的 init.signal 组合:任一 abort(用户取消 或 超时)即取消请求。
 * 不给全体请求兜底超时——流式/长连接会被误杀;只在会「卡死」的探测类调用显式传入。
 * opts.target(P1-K6 S2):这条请求发往哪台引擎;缺省 = home(老调用点与改造前逐字一致)。
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { timeoutMs?: number; target?: UnauthorizedTarget; onUploadProgress?: (sent: number, total: number) => void },
): Promise<Response> {
  let signal = init?.signal ?? undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline: AbortSignal | undefined
  if (opts?.timeoutMs && opts.timeoutMs > 0) {
    const ac = new AbortController()
    timer = setTimeout(() => ac.abort(new DOMException('Request timed out', 'TimeoutError')), opts.timeoutMs)
    const caller = init?.signal
    if (caller) {
      if (caller.aborted) ac.abort((caller as AbortSignal).reason)
      else caller.addEventListener('abort', () => ac.abort((caller as AbortSignal).reason), { once: true })
    }
    signal = deadline = ac.signal
  }
  try {
    const req = signal ? { ...init, signal } : init
    // 要上传进度的走 XHR(fetch 报不了请求体进度);回来照样是一个 Response,下面的 401 / 超时与调用方的错误处理不变。
    // 只在 fetch 还是浏览器原生的时候:网页版的账号层把 window.fetch 换成了带守卫的那份(换号作废、401 跳登录、
    // Unit 访客走另一条带凭据的通道),XHR 会绕过它 —— 那边退回 fetch,进度报不了,环转圈。
    // ponytail: 网页版要真进度,得让账号层的 boundRequest 自己支持上传进度回调。
    const res = opts?.onUploadProgress && isNativeFetch() ? await xhrFetch(input, req, opts.onUploadProgress) : await fetch(input, req)
    if (res.status === 401) {
      try { onUnauthorized?.(opts?.target ?? 'home') } catch { /* 拦截器自身不应影响请求返回 */ }
    }
    // ponytail: 成功时故意不清计时器 —— 到点 abort 会让还没读完的响应体报错;已读完的响应再 abort 是空操作
    // (Electron 40 / Chromium 149 实测)。代价是每个带超时的请求留一个计时器到期(最长 timeoutMs)。
    if (deadline) reportBodyTimeouts(res, deadline)
    return res
  } catch (e) {
    if (timer) clearTimeout(timer)
    throw e
  }
}

/**
 * Chromium 里读响应体中途被 abort,报的是通用 AbortError(不带我们给的 TimeoutError 原因,实测)。
 * 超时就按超时报:不然调用方会把它当成「用户取消」静默吞掉,界面上看到的也是「BodyStreamBuffer was aborted」。
 * 调用方自己的 signal 取消时原样抛出。
 * ponytail: 只包这四个读取方法;res.clone() / 直读 res.body 绕过包装(到点照样失败,只是报通用 AbortError)。
 * 现有带超时的调用方都只调 json();哪天要走那两条,再改成包一层 body 流。
 */
function reportBodyTimeouts(res: Response, deadline: AbortSignal): void {
  for (const method of ['json', 'text', 'arrayBuffer', 'blob'] as const) {
    if (typeof res[method] !== 'function') continue // 单测里的 fetch 桩常回一个只带 json 的普通对象
    // 宿主的 fetch 可能回一个已把读取方法锁死的响应(网页版账号层的 guardedResponse 曾是这样):再定义会抛
    // 「Cannot redefine property: json」,整条带超时的请求跟着失败 —— 网页版 2.12.0–2.13.0 的连接探测因此必败、输入框一直禁用。
    // 包不上就不包(代价只是读体超时那一下报通用 AbortError),绝不让一层报错美化把请求本身打挂。
    if (Object.getOwnPropertyDescriptor(res, method)?.configurable === false) continue
    const read = res[method].bind(res) as () => Promise<unknown>
    Object.defineProperty(res, method, {
      configurable: true,
      value: () => read().catch((e: unknown) => {
        throw deadline.aborted && (deadline.reason as { name?: string } | undefined)?.name === 'TimeoutError' ? deadline.reason : e
      }),
    })
  }
}

/** fetch 的 XHR 版,只多一个请求体上传进度。返回真的 Response(状态、头、体原样),调用方当 fetch 用。 */
function xhrFetch(input: RequestInfo | URL, init: RequestInit | undefined, onUploadProgress: (sent: number, total: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(init?.method || 'GET', input instanceof Request ? input.url : String(input))
    new Headers(init?.headers).forEach((v, k) => xhr.setRequestHeader(k, v))
    if (init?.credentials === 'include') xhr.withCredentials = true
    xhr.responseType = 'blob'
    xhr.upload.onprogress = (e) => onUploadProgress(e.loaded, e.lengthComputable ? e.total : 0)
    xhr.onload = () => {
      const headers = new Headers()
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const i = line.indexOf(':')
        if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim())
      }
      const empty = xhr.status === 204 || xhr.status === 205 || xhr.status === 304
      resolve(new Response(empty ? null : xhr.response, { status: xhr.status, statusText: xhr.statusText, headers }))
    }
    xhr.onerror = () => reject(new TypeError('Failed to fetch'))
    const signal = init?.signal
    xhr.onabort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return }
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send((init?.body ?? null) as XMLHttpRequestBodyInit | null)
  })
}

/** window.fetch 没被宿主换掉(运行时才判断:网页版登录后才换)。 */
const isNativeFetch = (): boolean => /\[native code\]/.test(Function.prototype.toString.call(fetch))
