/**
 * 假 Dropbox(fetch 桩,不起服务、不出网):oauth2/token、list_folder(含 continue)、get_metadata、upload、
 * delete_v2、download。按 Dropbox 公开文档的语义:path 大小写不敏感;upload mode add / overwrite / update(rev);
 * strict_conflict 关时「内容相同不算冲突」「update 的目标已删则直接新建」(这两条正是 TargetFs 要关掉的)。
 * revMismatch:delete_v2 的 parent_rev 对不上时回哪种 409(文档没写,两种都测)。
 */
export interface DbxFile { path_display: string; data: Buffer; rev: string; client_modified: string }
export interface DbxCall { endpoint: string; arg: Record<string, unknown> | null }

export interface FakeDropbox {
  fetch: typeof fetch
  files: Map<string, DbxFile>
  folders: Set<string>
  calls: DbxCall[]
  revMismatch: 'conflict' | 'not_found'
  failMetadata: boolean
  externalPut(path: string, data: string | Buffer): DbxFile
  externalDelete(path: string): void
}

export function fakeDropbox(): FakeDropbox {
  const files = new Map<string, DbxFile>()
  const folders = new Set<string>()
  const calls: DbxCall[] = []
  let seq = 0
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  const err = (summary: string): Response => json({ error_summary: summary, error: {} }, 409)
  const put = (path: string, data: Buffer, clientModified?: string): DbxFile => {
    const f = {
      path_display: path,
      data,
      rev: `0${(++seq).toString(16).padStart(8, '0')}`,
      client_modified: clientModified ?? new Date((clock += 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }
    files.set(path.toLowerCase(), f)
    return f
  }
  const meta = (f: DbxFile): Record<string, unknown> => ({
    '.tag': 'file',
    name: f.path_display.slice(f.path_display.lastIndexOf('/') + 1),
    path_display: f.path_display,
    path_lower: f.path_display.toLowerCase(),
    size: f.data.byteLength,
    rev: f.rev,
    client_modified: f.client_modified,
    server_modified: f.client_modified,
  })

  const fake: FakeDropbox = {
    files,
    folders,
    calls,
    revMismatch: 'conflict',
    failMetadata: false,
    externalPut: (path, data) => put(path, Buffer.isBuffer(data) ? data : Buffer.from(data)),
    externalDelete: (path) => { files.delete(path.toLowerCase()) },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth2/token')) return json({ access_token: 'AT', expires_in: 14400 })
      const endpoint = new URL(url).pathname
      const headers = (init?.headers ?? {}) as Record<string, string>
      const rawArg = headers['Dropbox-API-Arg'] ?? (typeof init?.body === 'string' ? init.body : 'null')
      const arg = JSON.parse(rawArg) as Record<string, unknown> | null
      calls.push({ endpoint, arg })
      const p = String(arg?.path ?? '')
      const cur = files.get(p.toLowerCase())

      if (endpoint === '/2/files/list_folder') {
        const base = p.toLowerCase()
        const entries = [...files.entries()].filter(([k]) => !base || k.startsWith(`${base}/`)).map(([, f]) => meta(f))
        if (base && !entries.length && !folders.has(base)) return err('path/not_found/..')
        return json({ entries, cursor: 'c', has_more: false })
      }
      if (endpoint === '/2/files/get_metadata') {
        if (fake.failMetadata) return new Response('boom', { status: 500 })
        if (cur) return json(meta(cur))
        const lower = p.toLowerCase()
        if (folders.has(lower) || [...files.keys()].some((k) => k.startsWith(`${lower}/`))) return json({ '.tag': 'folder', path_display: p })
        return err('path/not_found/..')
      }
      if (endpoint === '/2/files/upload') {
        const data = Buffer.from(init!.body as Uint8Array)
        const strict = arg?.strict_conflict === true
        const mode = arg?.mode as string | { '.tag': string; update: string }
        if (mode === 'add' && cur) {
          if (strict || !cur.data.equals(data)) return err('path/conflict/file/..')
          return json(meta(cur))
        }
        if (typeof mode === 'object' && mode['.tag'] === 'update') {
          if (!cur && strict) return err('path/conflict/file/..')
          if (cur && cur.rev !== mode.update) {
            if (strict || !cur.data.equals(data)) return err('path/conflict/file/..')
            return json(meta(cur))
          }
        }
        return json(meta(put(cur?.path_display ?? p, data, String(arg?.client_modified ?? '') || undefined)))
      }
      if (endpoint === '/2/files/delete_v2') {
        if (!cur) return err('path_lookup/not_found/..')
        if (typeof arg?.parent_rev === 'string' && arg.parent_rev !== cur.rev) {
          return fake.revMismatch === 'conflict' ? err('path_write/conflict/file/..') : err('path_lookup/not_found/..')
        }
        files.delete(p.toLowerCase())
        return json({ metadata: meta(cur) })
      }
      if (endpoint === '/2/files/download') {
        if (!cur) return err('path/not_found/..')
        return new Response(new Uint8Array(cur.data), { status: 200, headers: { 'dropbox-api-result': JSON.stringify(meta(cur)) } })
      }
      if (endpoint === '/2/users/get_current_account') return json({ account_id: 'a' })
      return json({ error: `unhandled ${endpoint}` }, 500)
    }) as typeof fetch,
  }
  return fake
}
