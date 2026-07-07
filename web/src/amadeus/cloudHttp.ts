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
  postForm<T>(path: string, form: FormData): Promise<T>
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
    const res = await fetch(`${cfg.apiBase}${path}${qs}`, { method, headers, body })
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

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, json) => request('POST', path, { json: json ?? {} }),
    postForm: (path, form) => request('POST', path, { form }),
    put: (path, json) => request('PUT', path, { json }),
    del: (path, query) => request('DELETE', path, { query }),
  }
}
