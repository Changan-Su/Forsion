/**
 * Amadeus 云 vault REST 客户端(Electron 主进程,Node 20 全局 fetch/FormData)。
 * 契约冻结镜像 server/microserver/amadeus/routes.ts;主进程能带 Authorization 头,
 * 不需要 web 端的 query-token 变体。所有写请求带 X-Amadeus-Client(回声抑制)。
 */

export interface CloudVaultInfo {
  id: string
  name: string
  lastChangeSeq: number
}

export interface CloudTreeEntry {
  path: string
  kind: 'page' | 'db' | 'binary'
  seq: number
  hash: string | null
  size: number
}

export interface CloudTree {
  folders: string[]
  entries: CloudTreeEntry[]
  seq: number
  /** 本库二进制单文件上限(属主会员档位);老服务端不下发 = undefined。 */
  maxFileBytes?: number
}

export interface CloudChange {
  seq: number
  type: 'page' | 'db' | 'binary' | 'structure'
  op: 'write' | 'delete' | 'move' | 'mkdir' | 'rename-folder' | 'move-folder' | 'delete-folder'
  path: string
  newPath: string | null
  fileSeq: number | null
  origin: { client: string | null; actor: string }
}

export class CloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
    url: string,
  ) {
    super(`cloud http ${status} on ${url}`)
  }
}

export interface CloudClientConfig {
  baseUrl: string // 形如 https://forsion.net(不带 /api)
  token: string
  clientId: string
}

export type CloudClient = ReturnType<typeof createCloudClient>

/** 大文件传输时限按体积放宽(按 ≥256 字节/毫秒 ≈ 250KB/s 估)。固定 120s 在 Pro 500MB 下必被掐断 → 引擎当断网重排 → 每轮重传整份。 */
export const transferTimeoutMs = (bytes: number): number => 120_000 + Math.ceil(bytes / 256)

export function createCloudClient(cfg: CloudClientConfig) {
  const api = `${cfg.baseUrl.replace(/\/+$/, '')}/api/amadeus`

  const request = async (
    method: string,
    url: string,
    init?: { json?: unknown; form?: FormData; timeoutMs?: number; headers?: Record<string, string> },
  ): Promise<any> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}`, ...init?.headers }
    if (method !== 'GET') headers['X-Amadeus-Client'] = cfg.clientId
    let body: any
    if (init?.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.json)
    } else if (init?.form) {
      body = init.form // fetch 自带 multipart boundary
    }
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000),
    })
    if (!res.ok) {
      let parsed: any = null
      try {
        parsed = await res.json()
      } catch {
        /* 非 JSON 错误体 */
      }
      throw new CloudHttpError(res.status, parsed, url)
    }
    return res.json()
  }

  const q = (params: Record<string, string>): string => new URLSearchParams(params).toString()

  return {
    clientId: cfg.clientId,

    async listVaults(): Promise<CloudVaultInfo[]> {
      const j = await request('GET', `${api}/vaults`)
      return (j.vaults ?? []).map((v: any) => ({
        id: String(v.id),
        name: String(v.name),
        lastChangeSeq: Number(v.lastChangeSeq ?? 0),
      }))
    },

    /** 全量树。依赖 P1 服务端在 tree 响应新增的 entries[](path/kind/seq/hash/size)。 */
    async tree(vaultId: string): Promise<CloudTree> {
      const j = await request('GET', `${api}/vaults/${vaultId}/tree`)
      if (!Array.isArray(j.entries)) {
        throw new Error('server too old: tree has no entries[] (deploy the amadeus microserver update)')
      }
      return {
        folders: j.folders ?? [],
        seq: Number(j.seq ?? 0),
        maxFileBytes: Number.isInteger(j.maxFileBytes) && j.maxFileBytes > 0 ? j.maxFileBytes : undefined,
        entries: j.entries.map((e: any) => ({
          path: String(e.path),
          kind: e.kind,
          seq: Number(e.seq ?? 0),
          hash: e.hash ?? null,
          size: Number(e.size ?? 0),
        })),
      }
    },

    async getFile(vaultId: string, path: string): Promise<{ content: string; seq: number; hash: string | null }> {
      const j = await request('GET', `${api}/vaults/${vaultId}/file?${q({ path })}`)
      return { content: String(j.content ?? ''), seq: Number(j.seq ?? 0), hash: j.hash ?? null }
    },

    /** CAS 写文本。409 → CloudHttpError,body = {code:'EXISTS'|'CONFLICT', seq, content}。 */
    putFile(vaultId: string, path: string, content: string, baseSeq: number, force = false): Promise<{ seq: number; hash: string }> {
      return request('PUT', `${api}/vaults/${vaultId}/file`, {
        json: { path, content, baseSeq, ...(force ? { force: true } : {}) },
      })
    },

    /** 条件删(baseSeq 不符 → 409 {code, seq};旧服务端忽略参数 = 原无条件语义)。
     *  confirmed = 用户点过「确认删除」的那一轮:服务端删除闸(429 MASS_DELETE_BLOCKED)据此放行。 */
    async deleteFile(vaultId: string, path: string, baseSeq?: number, opts?: { confirmed?: boolean }): Promise<void> {
      const params: Record<string, string> = { path }
      if (baseSeq !== undefined) params.baseSeq = String(baseSeq)
      await request('DELETE', `${api}/vaults/${vaultId}/file?${q(params)}`, opts?.confirmed ? { headers: { 'X-Amadeus-Delete-Confirmed': '1' } } : undefined)
    },

    move(vaultId: string, from: string, to: string): Promise<{ seq: number }> {
      return request('POST', `${api}/vaults/${vaultId}/move`, { json: { from, to } })
    },

    renameFolder(vaultId: string, path: string, newName: string): Promise<unknown> {
      return request('POST', `${api}/vaults/${vaultId}/folders/rename`, { json: { path, newName } })
    },

    moveFolder(vaultId: string, path: string, dest: string): Promise<unknown> {
      return request('POST', `${api}/vaults/${vaultId}/folders/move`, { json: { path, dest } })
    },

    async deleteFolder(vaultId: string, path: string): Promise<void> {
      await request('DELETE', `${api}/vaults/${vaultId}/folders?${q({ path })}`)
    },

    /** CAS 写二进制(baseSeq 同文本契约)。409 → CloudHttpError,body = {code, seq, hash}(无字节)。
     *  不带 baseSeq = 旧无条件覆盖(仅限明知无并发的场合)。 */
    putBinary(
      vaultId: string,
      path: string,
      bytes: Buffer,
      opts?: { ifAbsent?: boolean; baseSeq?: number },
    ): Promise<{ path: string; size: number; seq: number }> {
      const form = new FormData()
      form.set('path', path)
      if (opts?.ifAbsent) form.set('ifAbsent', 'true')
      if (opts?.baseSeq !== undefined) form.set('baseSeq', String(opts.baseSeq))
      form.set('file', new Blob([new Uint8Array(bytes)]), path.split('/').pop() || 'file')
      return request('POST', `${api}/vaults/${vaultId}/binary`, { form, timeoutMs: transferTimeoutMs(bytes.length) })
    },

    /** 文本版本快照列表(新→旧)。冲突合并用它按 seq 找 base。 */
    async listVersions(vaultId: string, path: string): Promise<Array<{ id: string; seq: number }>> {
      const j = await request('GET', `${api}/vaults/${vaultId}/file/versions?${q({ path })}`)
      return (j.versions ?? []).map((v: any) => ({ id: String(v.id), seq: Number(v.seq ?? 0) }))
    },

    async getVersion(vaultId: string, versionId: string): Promise<string> {
      const j = await request('GET', `${api}/vaults/${vaultId}/file/versions/${versionId}`)
      return String(j.content ?? '')
    },

    /** 精确路径取资产字节(ref=vault 相对路径,不传 page → 命中 exact 候选)。 */
    async getAsset(vaultId: string, path: string): Promise<Buffer> {
      const ctrl = new AbortController()
      let timer = setTimeout(() => ctrl.abort(), 120_000)
      try {
        const res = await fetch(`${api}/vaults/${vaultId}/asset?${q({ ref: path })}`, {
          headers: { Authorization: `Bearer ${cfg.token}` },
          signal: ctrl.signal,
        })
        if (!res.ok) throw new CloudHttpError(res.status, null, 'asset:' + path)
        // 头到了再按体积重设读体时限(同 putBinary:大文件固定 120s 会被掐断后无限重拉)
        clearTimeout(timer)
        timer = setTimeout(() => ctrl.abort(), transferTimeoutMs(Number(res.headers.get('content-length')) || 0))
        return Buffer.from(await res.arrayBuffer())
      } finally {
        clearTimeout(timer)
      }
    },

    async changes(vaultId: string, since: number): Promise<{ changes: CloudChange[]; seq: number }> {
      const j = await request('GET', `${api}/vaults/${vaultId}/changes?${q({ since: String(since) })}`)
      return { changes: j.changes ?? [], seq: Number(j.seq ?? 0) }
    },
  }
}
