/**
 * Amadeus 云端桥的 fetch 包装:Bearer 鉴权、变更请求带 X-Amadeus-Client(服务端回声标记 origin.client)、
 * 类型化 HttpError{status,body}(409 冲突体、404 缺失都按数据分支,不靠猜异常字符串)、401 → 登录跳转。
 * 走 window.fetch(webShim 的 401 兜底拦截器同样生效,双保险)。
 */

import { cloudAccountIdentity } from '@/services/cloudAccountCache'
import { translate } from '@/i18n'
import '@/amadeus/lib/bridgeMessages' // amxbridge.* 文案(G2-14)

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`)
    this.name = 'HttpError'
  }
}

export const is404 = (e: unknown): boolean => e instanceof HttpError && e.status === 404
/** 任何 409(含 VAULT_MOVED / ACCOUNT_CHANGED)。⚠️ 桥里判「云端更新了 / 撞名」别用它,用 isConflict409:
 *  写到分走的前缀上的 409 VAULT_MOVED 不是冲突,当冲突处理就是重载丢字或换名另存(智库同步第 3 步 B11)。 */
export const is409 = (e: unknown): boolean => e instanceof HttpError && e.status === 409
const codeOf = (e: unknown): unknown => (e instanceof HttpError ? (e.body as { code?: unknown } | null)?.code : undefined)
/** 写回的 409 VAULT_MOVED(声明了 vault-moves 才会收到;没声明的旧客户端拿 423):`{code, vaultId, prefix:'X/'}`。 */
export const isVaultMoved = (e: unknown): boolean => is409(e) && codeOf(e) === 'VAULT_MOVED'
/** 真正的「云端那边更新了 / 名字被占了」:409 且不是 VAULT_MOVED。 */
export const isConflict409 = (e: unknown): boolean => is409(e) && codeOf(e) !== 'VAULT_MOVED'
/** 库被删进回收站:410 VAULT_DELETED(所有按库的路由)。 */
export const isVaultDeleted = (e: unknown): boolean => e instanceof HttpError && e.status === 410 && codeOf(e) === 'VAULT_DELETED'

export interface CloudHttpCfg {
  /** API 基址,如 https://host/api(无尾斜杠);路径按 `${apiBase}${path}` 拼接。 */
  apiBase: string
  getToken(): string
  /** 本客户端身份(回声抑制锚点);随所有变更请求作 X-Amadeus-Client 发出。 */
  clientId: string
  /** 401 → 登录跳转(webShim.redirectToLogin)。 */
  onUnauthorized(): void
  /** Optional existing host transport/session lifetime (Unit visitor adapters). */
  request?(path: string, init?: RequestInit): Promise<Response>
  signal?: AbortSignal
  /** 能力头 X-Content-Caps(每个请求都带,含 GET):给了就带,不给 = 老行为(服务端当旧客户端)。 */
  caps?: string
}

export interface CloudHttp {
  get<T>(path: string, query?: Record<string, string>): Promise<T>
  post<T>(path: string, json?: unknown): Promise<T>
  /** onProgress 有值时走 XMLHttpRequest(fetch 无上传进度事件),否则照旧 fetch。 */
  postForm<T>(path: string, form: FormData, onProgress?: (sent: number, total: number) => void): Promise<T>
  put<T>(path: string, json: unknown): Promise<T>
  del<T>(path: string, query?: Record<string, string>): Promise<T>
}

// 上传时限按体积放宽(按 ≥256 字节/毫秒 ≈ 250KB/s 估):云同步单文件随会员档位可到 500MB,固定 120s 必被掐断。
const formTimeoutMs = (form: FormData): number => {
  let bytes = 0
  form.forEach((v) => { if (typeof v !== 'string') bytes += v.size })
  return 120_000 + Math.ceil(bytes / 256)
}

export function createCloudHttp(cfg: CloudHttpCfg): CloudHttp {
  const initialToken = cfg.getToken()
  const owner = cloudAccountIdentity(cfg.apiBase, initialToken)
  const assertAccount = (): string => {
    const token = cfg.getToken()
    if (cfg.signal?.aborted || !token || (owner ? cloudAccountIdentity(cfg.apiBase, token) !== owner : token !== initialToken)) {
      throw new HttpError(409, { code: 'ACCOUNT_CHANGED' }, 'Cloud account changed')
    }
    return token
  }
  const request = async <T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, string>; json?: unknown; form?: FormData },
  ): Promise<T> => {
    const qs = opts?.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
    const headers: Record<string, string> = { Authorization: `Bearer ${assertAccount()}` }
    if (cfg.caps) headers['X-Content-Caps'] = cfg.caps
    if (method !== 'GET') headers['X-Amadeus-Client'] = cfg.clientId
    let body: BodyInit | undefined
    if (opts?.form) {
      body = opts.form // multipart:浏览器自带 boundary,不能手写 Content-Type
    } else if (opts?.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.json)
    }
    // 超时闸:无超时的 fetch 一旦挂死,页面 loading 态永不落地(移动端弱网实报「卡很久」根因之一)。
    // 上传(multipart form)至少 120s、按体积再放宽;普通请求 30s。
    const timeoutMs = opts?.form ? formTimeoutMs(opts.form) : 30_000
    const ctrl = new AbortController()
    const cancel = () => ctrl.abort(cfg.signal?.reason)
    cfg.signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await (cfg.request ?? fetch)(`${cfg.apiBase}${path}${qs}`, { method, headers, body, signal: ctrl.signal })
      assertAccount()
      if (res.status === 401) {
        cfg.onUnauthorized()
        throw new HttpError(401, null)
      }
      // Reading the body is part of the request: keep cancellation and timeout alive.
      const text = await res.text()
      assertAccount()
      let parsed: unknown
      try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
      if (!res.ok) throw new HttpError(res.status, parsed)
      return parsed as T
    } catch (e) {
      if (e instanceof HttpError) throw e
      assertAccount()
      throw new HttpError(0, null, ctrl.signal.aborted
        ? translate('amxbridge.timeout', { s: Math.round(timeoutMs / 1000) })
        : translate('amxbridge.network', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      clearTimeout(timer)
      cfg.signal?.removeEventListener('abort', cancel)
    }
  }

  // XHR 版 POST multipart:唯一目的是 upload.onprogress;鉴权/401 跳转/宽容解析/HttpError 与 request 对齐。
  const postFormXhr = <T>(path: string, form: FormData, onProgress: (sent: number, total: number) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const token = assertAccount()
      const cancel = () => xhr.abort()
      const cleanup = () => cfg.signal?.removeEventListener('abort', cancel)
      xhr.open('POST', `${cfg.apiBase}${path}`)
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.setRequestHeader('X-Amadeus-Client', cfg.clientId)
      if (cfg.caps) xhr.setRequestHeader('X-Content-Caps', cfg.caps)
      xhr.upload.onprogress = (ev) => {
        try { assertAccount(); if (ev.lengthComputable) onProgress(ev.loaded, ev.total) }
        catch (error) { xhr.abort(); reject(error) }
      }
      xhr.onload = () => {
        cleanup()
        try { assertAccount() } catch (error) { reject(error); return }
        if (xhr.status === 401) { cfg.onUnauthorized(); reject(new HttpError(401, null)); return }
        let parsed: unknown
        try { parsed = xhr.responseText ? JSON.parse(xhr.responseText) : undefined } catch { parsed = xhr.responseText }
        if (xhr.status < 200 || xhr.status >= 300) { reject(new HttpError(xhr.status, parsed)); return }
        resolve(parsed as T)
      }
      xhr.onerror = () => { cleanup(); reject(new HttpError(0, null, 'network error')) }
      xhr.ontimeout = () => { cleanup(); reject(new HttpError(0, null, 'timeout')) }
      xhr.onabort = () => { cleanup(); reject(new HttpError(409, { code: 'ACCOUNT_CHANGED' }, 'Cloud request cancelled')) }
      xhr.timeout = formTimeoutMs(form)
      cfg.signal?.addEventListener('abort', cancel, { once: true })
      xhr.send(form)
    })

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, json) => request('POST', path, { json: json ?? {} }),
    postForm: (path, form, onProgress) => (onProgress ? postFormXhr(path, form, onProgress) : request('POST', path, { form })),
    put: (path, json) => request('PUT', path, { json }),
    del: (path, query) => request('DELETE', path, { query }),
  }
}
