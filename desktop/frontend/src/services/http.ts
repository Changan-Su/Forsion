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
 * opts.timeoutMs: **opt-in** 超时(不设=永不超时,SSE/长轮询保持原样)。
 * 与调用方自带的 init.signal 组合:任一 abort(用户取消 或 超时)即取消请求。
 * 不给全体请求兜底超时——流式/长连接会被误杀;只在会「卡死」的探测类调用显式传入。
 * opts.target(P1-K6 S2):这条请求发往哪台引擎;缺省 = home(老调用点与改造前逐字一致)。
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { timeoutMs?: number; target?: UnauthorizedTarget },
): Promise<Response> {
  let signal = init?.signal ?? undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  if (opts?.timeoutMs && opts.timeoutMs > 0) {
    const ac = new AbortController()
    timer = setTimeout(() => ac.abort(new DOMException('Request timed out', 'TimeoutError')), opts.timeoutMs)
    const caller = init?.signal
    if (caller) {
      if (caller.aborted) ac.abort((caller as AbortSignal).reason)
      else caller.addEventListener('abort', () => ac.abort((caller as AbortSignal).reason), { once: true })
    }
    signal = ac.signal
  }
  try {
    const res = await fetch(input, signal ? { ...init, signal } : init)
    if (res.status === 401) {
      try { onUnauthorized?.(opts?.target ?? 'home') } catch { /* 拦截器自身不应影响请求返回 */ }
    }
    return res
  } finally {
    if (timer) clearTimeout(timer)
  }
}
