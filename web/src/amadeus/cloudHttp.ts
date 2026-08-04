/**
 * Amadeus 云端桥的 fetch 包装:Bearer 鉴权、变更请求带 X-Amadeus-Client(服务端回声标记 origin.client)、
 * 类型化 HttpError{status,body}(409 冲突体、404 缺失都按数据分支,不靠猜异常字符串)、401 → 登录跳转。
 * 走 window.fetch(webShim 的 401 兜底拦截器同样生效,双保险)。
 */

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
export const is409 = (e: unknown): boolean => e instanceof HttpError && e.status === 409

export interface CloudHttpCfg {
  /** API 基址,如 https://host/api(无尾斜杠);路径按 `${apiBase}${path}` 拼接。 */
  apiBase: string
  getToken(): string
  /** 本客户端身份(回声抑制锚点);随所有变更请求作 X-Amadeus-Client 发出。 */
  clientId: string
  /** 401 → 登录跳转(webShim.redirectToLogin)。 */
  onUnauthorized(): void
}

export interface CloudHttp {
  get<T>(path: string, query?: Record<string, string>): Promise<T>
  post<T>(path: string, json?: unknown): Promise<T>
  /** onProgress 有值时走 XMLHttpRequest(fetch 无上传进度事件),否则照旧 fetch。 */
  postForm<T>(path: string, form: FormData, onProgress?: (sent: number, total: number) => void): Promise<T>
  put<T>(path: string, json: unknown): Promise<T>
  del<T>(path: string, query?: Record<string, string>): Promise<T>
}

export function createCloudHttp(cfg: CloudHttpCfg): CloudHttp {
  const request = async <T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, string>; json?: unknown; form?: FormData },
  ): Promise<T> => {
    const qs = opts?.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.getToken()}` }
    if (method !== 'GET') headers['X-Amadeus-Client'] = cfg.clientId
    let body: BodyInit | undefined
    if (opts?.form) {
      body = opts.form // multipart:浏览器自带 boundary,不能手写 Content-Type
    } else if (opts?.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.json)
    }
    // 超时闸:无超时的 fetch 一旦挂死,页面 loading 态永不落地(移动端弱网实报「卡很久」根因之一)。
    // 上传(multipart form)放宽到 120s;普通请求 30s。
    const timeoutMs = opts?.form ? 120_000 : 30_000
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(`${cfg.apiBase}${path}${qs}`, { method, headers, body, signal: ctrl.signal })
    } catch (e) {
      throw new HttpError(0, null, ctrl.signal.aborted
        ? `请求超时(${timeoutMs / 1000}s),请检查网络后重试`
        : `网络错误:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 401) {
      cfg.onUnauthorized()
      throw new HttpError(401, null)
    }
    // 响应体统一宽容解析:非 JSON / 空体 → undefined(DELETE 200 等)。
    const text = await res.text().catch(() => '')
    let parsed: unknown
    try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
    if (!res.ok) throw new HttpError(res.status, parsed)
    return parsed as T
  }

  // XHR 版 POST multipart:唯一目的是 upload.onprogress;鉴权/401 跳转/宽容解析/HttpError 与 request 对齐。
  const postFormXhr = <T>(path: string, form: FormData, onProgress: (sent: number, total: number) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${cfg.apiBase}${path}`)
      xhr.setRequestHeader('Authorization', `Bearer ${cfg.getToken()}`)
      xhr.setRequestHeader('X-Amadeus-Client', cfg.clientId)
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded, ev.total) }
      xhr.onload = () => {
        if (xhr.status === 401) { cfg.onUnauthorized(); reject(new HttpError(401, null)); return }
        let parsed: unknown
        try { parsed = xhr.responseText ? JSON.parse(xhr.responseText) : undefined } catch { parsed = xhr.responseText }
        if (xhr.status < 200 || xhr.status >= 300) { reject(new HttpError(xhr.status, parsed)); return }
        resolve(parsed as T)
      }
      xhr.onerror = () => reject(new HttpError(0, null, 'network error'))
      xhr.ontimeout = () => reject(new HttpError(0, null, 'timeout'))
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
