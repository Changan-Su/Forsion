/**
 * fetch 薄封装:在底层集中拦截 401(token 过期/失效)。
 * 在 fetch 层而非调用层拦截,因为很多调用方(轮询、SSE)会把抛出的错误吞掉 —— 拦截器仍能先行触发。
 * 只对 401 触发重登录;403(配额/权限)由调用方按业务处理,不在此拦。
 */
let onUnauthorized: (() => void) | null = null

/** 启动时注册一次(bootstrap)。 */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

/**
 * opts.timeoutMs: **opt-in** 超时(不设=永不超时,SSE/长轮询保持原样)。管到**调用方读完响应体**为止,不止到响应头:
 * 头到了、体卡住(半截 JSON 后连接挂着)时,r.json() 同样按时以 TimeoutError 失败。
 * 与调用方自带的 init.signal 组合:任一 abort(用户取消 或 超时)即取消请求。
 * 不给全体请求兜底超时——流式/长连接会被误杀;只在会「卡死」的探测类调用显式传入(它们都只读一小段 JSON)。
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { timeoutMs?: number },
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
    const res = await fetch(input, signal ? { ...init, signal } : init)
    if (res.status === 401) {
      try { onUnauthorized?.() } catch { /* 拦截器自身不应影响请求返回 */ }
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
    const read = res[method].bind(res) as () => Promise<unknown>
    Object.defineProperty(res, method, {
      value: () => read().catch((e: unknown) => {
        throw deadline.aborted && (deadline.reason as { name?: string } | undefined)?.name === 'TimeoutError' ? deadline.reason : e
      }),
    })
  }
}
