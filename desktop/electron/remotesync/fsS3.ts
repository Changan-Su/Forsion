/**
 * S3 兼容后端(AWS S3 / 阿里 OSS / 腾讯 COS / MinIO / Cloudflare R2)。
 *
 * 改编自 remotely-save `src/fsS3.ts`(Apache-2.0,Copyright remotely-save contributors,
 * 见本目录 LICENSE / NOTICE.md)。主要修改(License 4(b) 声明):
 *  - 去除 Obsidian requestUrl 定制 HTTP handler(Node 无 CORS,直接用 SDK 默认 handler)
 *  - 去除合成目录缓存 / useAccurateMTime 逐对象 HEAD / mkdir:本层引擎文件驱动,目录对象一律跳过
 *  - 接口精简为 RemoteFs(walk/readFile/writeFile/rm/check)
 * 保留:分页列举、multipart 上传、rclone 兼容的 MTime/CTime 元数据(秒)。
 * Forsion 增补(非上游):opts.cas = TargetFs 语义(targetFs.ts)—— 有期望时先 HEAD 复查身份,
 * 再用单次 PutObject / DeleteObject 带 If-None-Match / If-Match(412 / 409 ConditionalRequestConflict → cas-conflict)。
 * 有的 S3 兼容服务默默忽略条件头,所以对外不声明 CAS,真正兜底的是复查(窗口一个往返,非原子)。
 * HEAD 没有响应体,404 分不清「key 不在」和「桶不在」:cas 下 HEAD 404 再用 ListObjectsV2(Prefix = 完整 key)确认。
 * 条件 PUT 不回 ETag(部分 S3 兼容服务)时:拿不到与这次提交绑定的版本,一律 cas-conflict(弱身份分不出同秒同大小的另一份)。
 * 缺省 = 旧行为。
 */
import { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { RemoteEntity, RemoteFs } from './types'

export interface S3Config {
  endpoint: string
  region: string
  accessKeyID: string
  secretAccessKey: string
  bucket: string
  /** 远端目录前缀(自动规整为 `x/` 或空)。 */
  prefix?: string
  forcePathStyle?: boolean
  partsConcurrency?: number
}

/** 规整 prefix:'' | 'a/b/'。 */
export function normPrefix(x: string | undefined): string {
  let y = (x ?? '').trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  if (y === '' || y === '/' || y === '.') return ''
  if (y.startsWith('/')) y = y.slice(1)
  if (!y.endsWith('/')) y = `${y}/`
  return y
}

async function bodyToBuffer(b: unknown): Promise<Buffer> {
  if (b == null) throw new Error('S3 GetObject returned empty body')
  if (b instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of b) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
  if (typeof (b as Blob).arrayBuffer === 'function') {
    return Buffer.from(await (b as Blob).arrayBuffer())
  }
  throw new Error('unsupported S3 body type')
}

/** 与 rclone / remotely-save 兼容的元数据 mtime(秒;旧数据可能是毫秒)。 */
function metaMtimeMs(meta: Record<string, string> | undefined): number {
  const raw = Number.parseFloat(meta?.mtime || meta?.MTime || '0')
  if (!Number.isFinite(raw) || raw === 0) return 0
  return raw >= 1000000000000 ? Math.floor(raw) : Math.floor(raw * 1000)
}

export interface S3RemoteOptions {
  /** TargetFs 语义(见 targetFs.ts);缺省 false = 旧行为(expectedId 忽略、无条件写删)。 */
  cas?: boolean
}

const httpStatus = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
const errName = (e: unknown): string | undefined => (e as { name?: string } | null)?.name
const isNotFound = (e: unknown): boolean => httpStatus(e) === 404 || errName(e) === 'NotFound' || errName(e) === 'NoSuchKey'
const isPrecondition = (e: unknown): boolean =>
  httpStatus(e) === 412 || errName(e) === 'PreconditionFailed' || (httpStatus(e) === 409 && errName(e) === 'ConditionalRequestConflict')
/** walk 拿不到 ETag 时的回退身份 `${mtime}:${size}` 不是 ETag,不能放进 If-Match(只靠复查)。 */
const isEtagId = (id: string): boolean => !/^\d+:\d+$/.test(id)

export function createS3Remote(cfg: S3Config, opts: S3RemoteOptions = {}): RemoteFs & Required<Pick<RemoteFs, 'stat'>> {
  let endpoint = cfg.endpoint.trim()
  if (endpoint !== '' && !/^https?:\/\//.test(endpoint)) endpoint = `https://${endpoint}`
  const prefix = normPrefix(cfg.prefix)
  const client = new S3Client({
    region: cfg.region || 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: cfg.forcePathStyle ?? false,
    credentials: { accessKeyId: cfg.accessKeyID, secretAccessKey: cfg.secretAccessKey },
  })
  const full = (key: string): string => `${prefix}${key}`
  const conflict = (op: string, key: string, why: string): Error => new Error(`cas-conflict s3 ${op} ${key}: ${why}`)
  /** HEAD;id 与 walk 同口径(ETag,拿不到时秒级 LastModified + size)。其余失败抛。
   *  cas 下 404 不直接当不存在(HEAD 无响应体,桶不在也是这个 404):用 ListObjectsV2 按完整 key 前缀确认 ——
   *  列得出来且没有这个 key 才是 null;列出来有(HEAD 之后刚建的)就按列表给身份(与 walk 同口径);列失败照抛。 */
  const statKey = async (key: string, signal?: AbortSignal): Promise<RemoteEntity | null> => {
    try {
      const rsp = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: full(key) }), { abortSignal: signal })
      const mtimeMs = rsp.LastModified ? Math.floor(rsp.LastModified.valueOf() / 1000) * 1000 : 0
      const size = rsp.ContentLength ?? 0
      return { key, size, mtimeMs, id: rsp.ETag ?? `${mtimeMs}:${size}` }
    } catch (e) {
      if (!isNotFound(e)) throw e
      if (!opts.cas) return null // 缺省模式照旧
    }
    // 完整 key 是所有以它为前缀的 key 里字典序最小的,MaxKeys 1 就够
    const list = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: full(key), MaxKeys: 1 }), { abortSignal: signal })
    const obj = (list.Contents ?? []).find((o) => o.Key === full(key))
    if (!obj) return null
    const mtimeMs = obj.LastModified ? Math.floor(obj.LastModified.valueOf() / 1000) * 1000 : 0
    const size = obj.Size ?? 0
    return { key, size, mtimeMs, id: obj.ETag ?? `${mtimeMs}:${size}` }
  }

  return {
    kind: 's3',
    async walk(signal) {
      const out: RemoteEntity[] = []
      const cmd: ListObjectsV2CommandInput = { Bucket: cfg.bucket }
      if (prefix) cmd.Prefix = prefix
      let truncated = true
      while (truncated) {
        const rsp = await client.send(new ListObjectsV2Command(cmd), { abortSignal: signal })
        for (const obj of rsp.Contents ?? []) {
          const raw = obj.Key
          if (!raw || raw.endsWith('/')) continue // 目录对象跳过(文件驱动)
          if (prefix && !raw.startsWith(prefix)) continue
          const key = raw.slice(prefix.length)
          if (!key) continue
          const mtimeMs = obj.LastModified ? Math.floor(obj.LastModified.valueOf() / 1000) * 1000 : 0
          const size = obj.Size ?? 0
          out.push({ key, size, mtimeMs, id: obj.ETag ?? `${mtimeMs}:${size}` })
        }
        truncated = rsp.IsTruncated ?? false
        if (truncated) {
          if (!rsp.NextContinuationToken) throw new Error('S3 list truncated without continuation token')
          cmd.ContinuationToken = rsp.NextContinuationToken
        }
      }
      return out
    },
    async readFile(key, signal) {
      const rsp = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: full(key) }), { abortSignal: signal })
      return bodyToBuffer(rsp.Body)
    },
    async writeFile(key, data, mtimeMs, signal, expectedId) {
      if (opts.cas && expectedId !== undefined) {
        const cur = await statKey(key, signal)
        if (expectedId === null && cur) throw conflict('PUT', key, 'exists')
        if (typeof expectedId === 'string' && (!cur || cur.id !== expectedId)) throw conflict('PUT', key, cur ? 'remote changed' : 'absent')
        // 条件写只能走单次 PutObject(lib-storage 的 multipart 不带条件);单次上限 5GB,远超同步的单文件上限
        const input: PutObjectCommandInput = {
          Bucket: cfg.bucket,
          Key: full(key),
          Body: data,
          Metadata: { MTime: `${mtimeMs / 1000.0}`, CTime: `${mtimeMs / 1000.0}` },
        }
        if (expectedId === null) input.IfNoneMatch = '*'
        else if (isEtagId(expectedId)) input.IfMatch = expectedId
        let etag: string | undefined
        try {
          etag = (await client.send(new PutObjectCommand(input), { abortSignal: signal })).ETag
        } catch (e) {
          if (isPrecondition(e)) throw conflict('PUT', key, 'precondition failed')
          // If-Match 而对象已不在:AWS 回 404 NoSuchKey —— 期望的那份没了,同样是冲突
          if (input.IfMatch && isNotFound(e)) throw conflict('PUT', key, 'absent')
          throw e
        }
        if (etag) {
          const mt = metaMtimeMs({ MTime: `${mtimeMs / 1000.0}` }) || mtimeMs
          return { key, size: data.byteLength, mtimeMs: mt, id: etag }
        }
        // 不回 ETag:拿不到与这次提交绑定的版本。HEAD 的弱身份(秒级 LastModified + size)分不出同秒同大小的另一份,
        // 回读核对也证明不了版本属于这次 PUT —— 直接报冲突、保留原基线,交引擎下一轮重判(写进去的字节就是本机那份,重判会认成一致)。
        throw conflict('PUT', key, 'no commit version')
      }
      const upload = new Upload({
        client,
        queueSize: cfg.partsConcurrency ?? 5,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
        params: {
          Bucket: cfg.bucket,
          Key: full(key),
          Body: data,
          Metadata: { MTime: `${mtimeMs / 1000.0}`, CTime: `${mtimeMs / 1000.0}` },
        },
      })
      // 超时/中止必须真取消 multipart,否则"被判超时的上传"可能在后台完成、盖掉后来的新版本
      const onAbort = (): void => {
        void upload.abort().catch(() => {})
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const done = await upload.done()
        const etag = (done as { ETag?: string }).ETag
        const mt = metaMtimeMs({ MTime: `${mtimeMs / 1000.0}` }) || mtimeMs
        return { key, size: data.byteLength, mtimeMs: mt, id: etag ?? `${mt}:${data.byteLength}` }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
    async rm(key, signal, expectedId) {
      if (opts.cas && expectedId !== undefined) {
        const cur = await statKey(key, signal)
        if (expectedId === null) {
          if (cur) throw conflict('rm', key, 'exists')
          return
        }
        if (!cur) return // 已不在 = 幂等
        if (cur.id !== expectedId) throw conflict('rm', key, 'remote changed')
        try {
          await client.send(
            new DeleteObjectCommand({ Bucket: cfg.bucket, Key: full(key), ...(isEtagId(expectedId) ? { IfMatch: expectedId } : {}) }),
            { abortSignal: signal },
          )
        } catch (e) {
          if (isPrecondition(e)) throw conflict('rm', key, 'precondition failed')
          if (isNotFound(e)) return // 条件删遇到已不在(部分实现回 404)= 幂等
          throw e
        }
        return
      }
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: full(key) }), { abortSignal: signal })
    },
    async stat(key, signal) {
      return statKey(key, signal)
    },
    async check() {
      try {
        const cmd: ListObjectsV2CommandInput = { Bucket: cfg.bucket, MaxKeys: 1 }
        if (prefix) cmd.Prefix = prefix
        await client.send(new ListObjectsV2Command(cmd))
        return { ok: true }
      } catch (e) {
        let msg = String((e as Error)?.message || e)
        if (cfg.endpoint.includes(cfg.bucket)) msg += '(endpoint 里似乎包含了 bucket 名,请去掉后重试)'
        return { ok: false, error: msg }
      }
    },
  }
}
