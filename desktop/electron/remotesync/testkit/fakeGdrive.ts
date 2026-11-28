/**
 * 假 Google Drive v3(fetch 桩,不起服务、不出网):只认 fsGdrive 用到的那几条请求 ——
 * token / about / files 列表与按名查询 / 按 ID 取元数据 / PATCH(进回收站)/ alt=media / 建目录 /
 * resumable 上传(建会话 → PUT 内容)。与 fsGdrive.test.ts 的内存 Drive 同一思路,这里改成注入 fetch。
 */
import { createHash } from 'node:crypto'
import type { WireFile } from '../fsGdrive'

export type DriveStored = WireFile & { content?: Buffer }
const FOLDER = 'application/vnd.google-apps.folder'

export interface FakeGdrive {
  fetch: typeof fetch
  files: Map<string, DriveStored>
  log: Array<{ method: string; url: string }>
  /** 按名查询(`… in parents and name = …`)回 500。 */
  failNamedQuery: boolean
  put(f: Partial<DriveStored> & { name: string; parents: string[] }, content?: Buffer): DriveStored
  folder(name: string, parent: string): DriveStored
  /** 别的写入者改内容(换一个内容版本)。 */
  externalWrite(f: DriveStored, data: string | Buffer): void
  live(): DriveStored[]
}

export function fakeGdrive(): FakeGdrive {
  const files = new Map<string, DriveStored>()
  const sessions = new Map<string, { create?: { name: string; parents: string[] }; update?: string; modifiedTime?: string }>()
  const log: Array<{ method: string; url: string }> = []
  let seq = 0
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const now = (): string => new Date((clock += 1000)).toISOString()
  const json = (b: unknown, status = 200, headers?: Record<string, string>): Response =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  const pub = (f: DriveStored): WireFile => {
    const { content: _c, ...rest } = f
    return rest
  }
  const revOf = (b: Buffer) => ({
    size: String(b.byteLength),
    md5Checksum: createHash('md5').update(b).digest('hex'),
    sha256Checksum: createHash('sha256').update(b).digest('hex'),
    headRevisionId: `rev${++seq}`,
  })
  const put = (f: Partial<DriveStored> & { name: string; parents: string[] }, content?: Buffer): DriveStored => {
    const id = f.id ?? `id${String(++seq).padStart(4, '0')}`
    const s: DriveStored = { mimeType: 'text/plain', createdTime: now(), modifiedTime: now(), trashed: false, ...f, id }
    if (content) Object.assign(s, revOf(content), { content })
    files.set(id, s)
    return s
  }
  const unq = (s: string): string => s.replace(/\\(.)/g, '$1')

  const fake: FakeGdrive = {
    files,
    log,
    failNamedQuery: false,
    put,
    folder: (name, parent) => put({ name, parents: [parent], mimeType: FOLDER }),
    externalWrite: (f, data) => {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data)
      Object.assign(f, revOf(b), { content: b, modifiedTime: now() })
    },
    live: () => [...files.values()].filter((f) => !f.trashed),
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      const method = init.method ?? 'GET'
      log.push({ method, url })
      const body = typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body as string) } catch { return init.body } })() : init.body
      const u = new URL(url)
      if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'AT', expires_in: 3600 })
      if (u.pathname === '/drive/v3/about') return json({ user: { permissionId: 'P1' } })
      if (u.hostname === 'upload.session') {
        const s = sessions.get(u.pathname)!
        const data = Buffer.from(init.body as Uint8Array)
        const target = s.update ? files.get(s.update)! : put(s.create!)
        Object.assign(target, s.modifiedTime ? { modifiedTime: s.modifiedTime } : {}, revOf(data), { content: data })
        return json(pub(target))
      }
      if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
        const p = `/s${++seq}`
        sessions.set(p, { create: { name: body.name, parents: body.parents }, modifiedTime: body.modifiedTime })
        return new Response(null, { status: 200, headers: { Location: `https://upload.session${p}` } })
      }
      const upd = u.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/)
      if (upd && method === 'PATCH') {
        const p = `/s${++seq}`
        sessions.set(p, { update: decodeURIComponent(upd[1]), modifiedTime: body.modifiedTime })
        return new Response(null, { status: 200, headers: { Location: `https://upload.session${p}` } })
      }
      if (u.pathname === '/drive/v3/files' && method === 'POST') return json({ id: put({ name: body.name, parents: body.parents, mimeType: body.mimeType }).id })
      if (u.pathname === '/drive/v3/files' && method === 'GET') {
        const q = u.searchParams.get('q') ?? ''
        let list = [...files.values()].filter((f) => !f.trashed)
        const m = q.match(/^'((?:[^'\\]|\\.)*)' in parents and name = '((?:[^'\\]|\\.)*)' and trashed = false( and mimeType = '[^']*')?$/)
        if (m) {
          if (fake.failNamedQuery) return json({ error: 'boom' }, 500)
          list = list.filter((f) => f.parents?.includes(unq(m[1])) && f.name === unq(m[2]) && (!m[3] || f.mimeType === FOLDER))
        } else if (q !== 'trashed = false') return json({ error: `unsupported q ${q}` }, 400)
        return json({ files: list.map(pub) })
      }
      const one = u.pathname.match(/^\/drive\/v3\/files\/(.+)$/)
      if (one) {
        const f = files.get(decodeURIComponent(one[1]))
        if (!f) return json({ error: 'notFound' }, 404)
        if (method === 'PATCH') {
          Object.assign(f, body)
          return json({ id: f.id })
        }
        if (u.searchParams.get('alt') === 'media') return new Response(new Uint8Array(f.content ?? Buffer.alloc(0)))
        return json(pub(f))
      }
      return json({ error: `unhandled ${method} ${url}` }, 500)
    }) as typeof fetch,
  }
  return fake
}
