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

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401) {
    try { onUnauthorized?.() } catch { /* 拦截器自身不应影响请求返回 */ }
  }
  return res
}
