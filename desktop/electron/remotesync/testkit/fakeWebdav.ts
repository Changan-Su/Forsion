/**
 * 进程内假 WebDAV(node:http,127.0.0.1 随机口):PROPFIND(Depth 0/1,multistatus)/ GET / PUT / DELETE / MKCOL。
 * conditions: 'honour' = 执行 If-Match(强比较)/ If-None-Match: *(412);'ignore' = 收到也当没看见。
 * etags: 'strong' = `"e<n>"`、'weak' = `W/"e<n>"`、'none' = 不给 getetag(客户端身份回退 mtime:size)。
 * putEtag:PUT 响应是否带 ETag 头。时钟每次变更 +1s(getlastmodified 是秒级)。测试用,不出网。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface DavFile { data: Buffer; etag: string; mtime: number }
export interface DavReq { method: string; path: string; headers: http.IncomingHttpHeaders }

export interface FakeWebdav {
  address: string
  files: Map<string, DavFile>
  dirs: Set<string>
  requests: DavReq[]
  conditions: 'honour' | 'ignore'
  etags: 'strong' | 'weak' | 'none'
  putEtag: boolean
  /** Depth 0 PROPFIND 定好回什么之后、响应发出前调用(207 / 404 都调):在「复查」与「写」之间插一笔别人的改动。 */
  afterStat?: (path: string) => void
  /** 这些路径的 PROPFIND 回 500。 */
  failStat: Set<string>
  /** 别的写入者直接改远端(path 是绝对路径,如 /forsion-vault/a.md;父目录自动建)。 */
  externalPut(path: string, data: string | Buffer): void
  externalDelete(path: string): void
  close(): Promise<void>
}

const xmlEsc = (s: string): string => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)
const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/'))
const hrefOf = (p: string, dir: boolean): string => `${p.split('/').map(encodeURIComponent).join('/')}${dir ? '/' : ''}`

export async function startFakeWebdav(
  opts: { conditions?: 'honour' | 'ignore'; etags?: 'strong' | 'weak' | 'none'; putEtag?: boolean } = {},
): Promise<FakeWebdav> {
  const files = new Map<string, DavFile>()
  const dirs = new Set<string>([''])
  const requests: DavReq[] = []
  let clock = Date.parse('2026-11-01T00:00:00Z')
  let seq = 0
  const fake: FakeWebdav = {
    address: '',
    files,
    dirs,
    requests,
    conditions: opts.conditions ?? 'honour',
    etags: opts.etags ?? 'strong',
    putEtag: opts.putEtag ?? true,
    failStat: new Set(),
    externalPut: (p, data) => {
      let acc = ''
      for (const seg of parentOf(p).split('/').filter(Boolean)) dirs.add((acc = `${acc}/${seg}`))
      store(p, Buffer.isBuffer(data) ? data : Buffer.from(data))
    },
    externalDelete: (p) => { files.delete(p) },
    close: async () => {},
  }
  const etagOf = (f: DavFile): string | null => (fake.etags === 'none' ? null : fake.etags === 'weak' ? `W/${f.etag}` : f.etag)
  const store = (p: string, data: Buffer): DavFile => {
    const f = { data, etag: `"e${++seq}"`, mtime: (clock += 1000) }
    files.set(p, f)
    return f
  }

  const entry = (p: string): string => {
    const f = files.get(p)
    if (f) {
      const etag = etagOf(f)
      return `<d:response><d:href>${xmlEsc(hrefOf(p, false))}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${f.data.byteLength}</d:getcontentlength><d:getlastmodified>${new Date(f.mtime).toUTCString()}</d:getlastmodified>${etag ? `<d:getetag>${xmlEsc(etag)}</d:getetag>` : ''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    }
    return `<d:response><d:href>${xmlEsc(hrefOf(p, true))}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>${new Date(clock).toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const method = req.method ?? 'GET'
      const p = decodeURIComponent(new URL(req.url ?? '/', 'http://fake').pathname).replace(/\/+$/, '')
      requests.push({ method, path: p, headers: req.headers })
      const honour = fake.conditions === 'honour'
      const f = files.get(p)
      const send = (status: number, body?: string, headers: Record<string, string> = {}): void => {
        res.writeHead(status, body ? { 'Content-Type': 'application/xml; charset=utf-8', ...headers } : headers)
        res.end(body)
      }
      /** 412 判定(honour 时):If-None-Match: * 要求不存在;If-Match 用强比较(弱 / 无 etag 一律不匹配)。 */
      const preconditionFails = (): boolean => {
        if (!honour) return false
        if (req.headers['if-none-match'] === '*' && f) return true
        const im = req.headers['if-match']
        if (im !== undefined) {
          const cur = f ? etagOf(f) : null
          if (!cur || cur.startsWith('W/') || cur !== im) return true
        }
        return false
      }

      if (method === 'PROPFIND') {
        if (fake.failStat.has(p)) return send(500)
        const depth = String(req.headers.depth ?? '1')
        if (!f && !dirs.has(p)) {
          if (depth === '0') fake.afterStat?.(p)
          return send(404)
        }
        let body = entry(p)
        if (!f && depth !== '0') {
          for (const d of dirs) if (d && parentOf(d) === p) body += entry(d)
          for (const k of files.keys()) if (parentOf(k) === p) body += entry(k)
        }
        if (depth === '0') fake.afterStat?.(p)
        return send(207, `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`)
      }
      if (method === 'GET') {
        if (!f) return send(404)
        res.writeHead(200, { 'Content-Length': String(f.data.byteLength) })
        res.end(f.data)
        return
      }
      if (method === 'PUT') {
        if (!dirs.has(parentOf(p))) return send(409)
        if (preconditionFails()) return send(412)
        const existed = !!f
        const nf = store(p, Buffer.concat(chunks))
        const etag = etagOf(nf)
        return send(existed ? 204 : 201, undefined, fake.putEtag && etag ? { ETag: etag, 'Last-Modified': new Date(nf.mtime).toUTCString() } : {})
      }
      if (method === 'DELETE') {
        if (f) {
          if (preconditionFails()) return send(412)
          files.delete(p)
          return send(204)
        }
        if (dirs.has(p)) {
          for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k)
          for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
          return send(204)
        }
        return send(404)
      }
      if (method === 'MKCOL') {
        if (dirs.has(p) || f) return send(405)
        if (!dirs.has(parentOf(p))) return send(409)
        dirs.add(p)
        return send(201)
      }
      send(405)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
  return fake
}
