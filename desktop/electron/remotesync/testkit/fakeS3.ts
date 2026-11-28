/**
 * 进程内假 S3(node:http,127.0.0.1 随机口,path-style):只认 fsS3 用到的几条请求 ——
 * ListObjectsV2 / GetObject / HeadObject / PutObject / DeleteObject。不验签。
 * conditions: 'honour' = 按 S3 语义执行 If-Match / If-None-Match(412 / 404);'ignore' = 收到也当没看见
 * (模拟默默忽略条件头的 S3 兼容服务)。putEtag: false = PutObject 响应不带 ETag(部分 S3 兼容服务如此)。测试用,不出网。
 */
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface S3Obj { data: Buffer; etag: string; lastModified: number; meta: Record<string, string> }
export interface S3Req { method: string; key: string; headers: http.IncomingHttpHeaders }

export interface FakeS3 {
  endpoint: string
  bucket: string
  objects: Map<string, S3Obj>
  requests: S3Req[]
  conditions: 'honour' | 'ignore'
  /** HEAD 定好回什么之后、响应发出前调用(200 / 404 都调):用来在「复查」与「写」之间插一笔别人的改动。 */
  afterHead?: (key: string) => void
  /** ListObjectsV2 定好回什么之后、响应发出前调用(参数 = prefix)。 */
  afterList?: (prefix: string) => void
  /** PUT 落盘之后、响应发出前调用:在「写」与写后核对之间插一笔别人的改动。 */
  afterPut?: (key: string) => void
  /** PutObject 响应是否带 ETag 头(缺省 true)。 */
  putEtag: boolean
  /** 这些 key 的 HEAD 回 500。 */
  failHead: Set<string>
  /** 别的写入者直接改远端。 */
  externalPut(key: string, data: string | Buffer): void
  externalDelete(key: string): void
  close(): Promise<void>
}

const xmlEsc = (s: string): string => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)

/** aws-chunked 解帧(SDK 对流式体会用;Buffer 体一般不会,保险起见支持)。 */
function decodeAwsChunked(raw: Buffer): Buffer {
  const out: Buffer[] = []
  let i = 0
  for (;;) {
    const eol = raw.indexOf('\r\n', i)
    if (eol < 0) break
    const size = Number.parseInt(raw.subarray(i, eol).toString('latin1').split(';')[0], 16)
    i = eol + 2
    if (!size) break
    out.push(raw.subarray(i, i + size))
    i += size + 2
  }
  return Buffer.concat(out)
}

export async function startFakeS3(opts: { bucket?: string; conditions?: 'honour' | 'ignore'; putEtag?: boolean } = {}): Promise<FakeS3> {
  const bucket = opts.bucket ?? 'bkt'
  const objects = new Map<string, S3Obj>()
  const requests: S3Req[] = []
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const store = (key: string, data: Buffer, meta: Record<string, string> = {}): S3Obj => {
    const o = { data, etag: `"${createHash('md5').update(data).digest('hex')}"`, lastModified: (clock += 1000), meta }
    objects.set(key, o)
    return o
  }

  const fake: FakeS3 = {
    endpoint: '',
    bucket,
    objects,
    requests,
    conditions: opts.conditions ?? 'honour',
    putEtag: opts.putEtag ?? true,
    failHead: new Set(),
    externalPut: (key, data) => { store(key, Buffer.isBuffer(data) ? data : Buffer.from(data)) },
    externalDelete: (key) => { objects.delete(key) },
    close: async () => {},
  }

  const error = (res: http.ServerResponse, status: number, code: string, head = false): void => {
    res.writeHead(status, { 'Content-Type': 'application/xml' })
    res.end(head ? undefined : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message><RequestId>fake</RequestId></Error>`)
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://fake')
      const parts = u.pathname.split('/')
      if (parts[1] !== bucket) return error(res, 404, 'NoSuchBucket')
      const key = decodeURIComponent(parts.slice(2).join('/'))
      const method = req.method ?? 'GET'
      requests.push({ method, key, headers: req.headers })
      const cur = objects.get(key)
      const honour = fake.conditions === 'honour'
      const ifMatch = req.headers['if-match']
      const ifNoneMatch = req.headers['if-none-match']

      if (method === 'GET' && key === '' && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') ?? ''
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
        const contents = keys.map((k) => {
          const o = objects.get(k)!
          return `<Contents><Key>${xmlEsc(k)}</Key><LastModified>${new Date(o.lastModified).toISOString()}</LastModified><ETag>${xmlEsc(o.etag)}</ETag><Size>${o.data.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`
        }).join('')
        fake.afterList?.(prefix)
        res.writeHead(200, { 'Content-Type': 'application/xml' })
        res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xmlEsc(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`)
        return
      }
      if (method === 'HEAD') {
        if (fake.failHead.has(key)) return error(res, 500, 'InternalError', true)
        if (!cur) {
          fake.afterHead?.(key)
          return error(res, 404, 'NotFound', true)
        }
        const headers = {
          ETag: cur.etag,
          'Content-Length': String(cur.data.byteLength),
          'Last-Modified': new Date(cur.lastModified).toUTCString(),
        }
        fake.afterHead?.(key)
        res.writeHead(200, headers)
        res.end()
        return
      }
      if (method === 'GET') {
        if (!cur) return error(res, 404, 'NoSuchKey')
        res.writeHead(200, { ETag: cur.etag, 'Content-Length': String(cur.data.byteLength), 'Last-Modified': new Date(cur.lastModified).toUTCString() })
        res.end(cur.data)
        return
      }
      if (method === 'PUT') {
        let body: Buffer = Buffer.concat(chunks)
        const enc = String(req.headers['content-encoding'] ?? '')
        if (enc.includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) body = decodeAwsChunked(body)
        if (honour) {
          if (ifNoneMatch === '*' && cur) return error(res, 412, 'PreconditionFailed')
          if (ifMatch !== undefined) {
            if (!cur) return error(res, 404, 'NoSuchKey')
            if (cur.etag !== ifMatch) return error(res, 412, 'PreconditionFailed')
          }
        }
        const meta: Record<string, string> = {}
        for (const [h, v] of Object.entries(req.headers)) if (h.startsWith('x-amz-meta-')) meta[h.slice(11)] = String(v)
        const o = store(key, body, meta)
        fake.afterPut?.(key)
        res.writeHead(200, fake.putEtag ? { ETag: o.etag } : {})
        res.end()
        return
      }
      if (method === 'DELETE') {
        if (honour && ifMatch !== undefined) {
          if (!cur) return error(res, 404, 'NoSuchKey')
          if (cur.etag !== ifMatch) return error(res, 412, 'PreconditionFailed')
        }
        objects.delete(key)
        res.writeHead(204)
        res.end()
        return
      }
      error(res, 405, 'MethodNotAllowed')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
  return fake
}
