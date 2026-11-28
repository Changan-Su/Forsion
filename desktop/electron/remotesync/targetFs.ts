/**
 * 同步目标(TargetFs):给新同步引擎用的远端句柄 —— 五个 remotesync 后端(folder / S3 / WebDAV / Dropbox / Google Drive)
 * 以「CAS 模式」打开在某个子目录上,附带诚实的能力声明与单 key stat。旧 remotesync 引擎不走这里(它用各后端的缺省模式,
 * 行为不变)。Forsion 自研。隔离约定同目录 README:不 import electron。
 *
 * 语义(每个句柄):
 *  - writeFile(key, data, mtimeMs, signal, expectedId)
 *      expectedId === null      → 只许新建:key 已存在 → 抛 `cas-conflict…`,已有的文件不动;
 *      expectedId 是 string     → 远端当前身份必须仍是它,否则抛 `cas-conflict…` 且不写(远端已不在也算冲突);
 *      expectedId === undefined → 无条件写(同旧行为)。
 *      返回的 id 与之后 walk / stat 对同一份文件给的 id 一致。
 *  - rm(key, signal, expectedId)
 *      string → 只在当前身份等于它时删,不等 → `cas-conflict…`;已不在 → 幂等,不抛;
 *      null   → 期望不存在:不在 = 什么都不做,在 = `cas-conflict…`(绝不删);
 *      undefined → 无条件删。
 *  - stat(key) → 当前 RemoteEntity(id 与该后端 walk 同口径,可直接比较)或 null(不存在);其余失败一律抛,绝不把出错当不存在。
 *  - caps 是对外承诺的原子性:true = 后端原子地执行该条件;false = 在变更前一刻用 stat 复查
 *    (窗口缩到一个往返,不是原子的)。有原子条件可用但不可靠的后端(S3 / WebDAV 的条件头)照样发,
 *    命中仍映射成 `cas-conflict`,但不声明。realMove 恒 false:没有一个后端在这里提供改名。
 *
 * 各后端:
 *  - folder:新建 = 同目录临时文件 + link(原子,EEXIST = 冲突;link 因别的原因失败退回 open(final,'wx'),非原子落内容但不覆盖,
 *    写失败只删自己那个 inode);覆盖 / 删除 = 进程内写锁里复查 mtime:size 身份(外部进程不在锁里);覆盖先把临时文件写完刷盘,
 *    rename 前一刻再复查身份与中止信号,新内容同 mtime 同大小时把 mtime 往后挪(身份必变)。每次变更与 stat 先确认 key 的
 *    真实父目录在根里(父路径上的符号链接不穿过去,拒绝而非当不存在)。
 *  - s3:HEAD 复查(404 再用 ListObjectsV2 确认 —— HEAD 无响应体,桶不在也是 404)+ 单次 PutObject / DeleteObject 带
 *    If-None-Match / If-Match(412 / 409 ConditionalRequestConflict → 冲突);PUT 不回 ETag 时写后 HEAD → GET → HEAD 核对。
 *  - webdav:PROPFIND 复查(只有 HTTP 404 / 207 里资源级 404 算不存在)+ If-None-Match / If-Match(只回送服务器原样的强 etag);
 *    PUT / DELETE 必须 2xx;写后身份优先取 PUT 响应的 ETag,没有就 stat → 下载 → stat 核对。
 *  - dropbox:upload mode add / update(rev) + strict_conflict、delete_v2 parent_rev —— 原子。rm(null) 只查不删;空 rev 直接冲突。
 *  - gdrive:Drive v3 没有条件写:stat 与条件写删的发送前复查都按 key 当前的路径从 baseDir 逐段现查,比对文件 ID + 内容版本
 *    (见 fsGdrive.ts)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createDirRemote } from './fsLocal'
import { createDropboxRemote, normBaseDir } from './fsDropbox'
import { createGdriveRemote, gdriveBaseSegs } from './fsGdrive'
import { createS3Remote, normPrefix, type S3Config } from './fsS3'
import { createWebdavRemote, webdavBaseDir, type WebdavConfig } from './fsWebdav'
import type { RemoteEntity, RemoteFs } from './types'

export type TargetKind = 'folder' | 's3' | 'webdav' | 'dropbox' | 'gdrive'

export interface TargetCaps {
  createExclusive: boolean
  casWrite: boolean
  casDelete: boolean
  realMove: false
}

export type TargetFs = RemoteFs & {
  caps: TargetCaps
  stat(key: string, signal?: AbortSignal): Promise<RemoteEntity | null>
}

export interface TargetSpec {
  kind: TargetKind
  folder?: { path: string }
  s3?: S3Config
  webdav?: WebdavConfig
  /** appKey 由调用方解析好(官方 / 自建)。 */
  dropbox?: { appKey: string; refreshToken: string; baseDir?: string; fetch?: typeof fetch }
  gdrive?: { clientId: string; clientSecret?: string; refreshToken: string; baseDir?: string; fetch?: typeof fetch }
}

/** 对外契约(与其他包已约定,别改):见文件头「各后端」。 */
export const TARGET_CAPS: Readonly<Record<TargetKind, Readonly<TargetCaps>>> = Object.freeze({
  folder: Object.freeze({ createExclusive: true, casWrite: false, casDelete: false, realMove: false as const }),
  s3: Object.freeze({ createExclusive: false, casWrite: false, casDelete: false, realMove: false as const }),
  webdav: Object.freeze({ createExclusive: false, casWrite: false, casDelete: false, realMove: false as const }),
  dropbox: Object.freeze({ createExclusive: true, casWrite: true, casDelete: true, realMove: false as const }),
  gdrive: Object.freeze({ createExclusive: false, casWrite: false, casDelete: false, realMove: false as const }),
})

/** dir → 段数组。'' = 后端配置的根本身。绝对路径(/x、C:)、反斜杠、NUL、'.'、'..'、空段一律拒;
 *  段首尾带空白也拒 —— 各后端的规整函数会再 trim 一遍(如 gdriveBaseSegs),' ' 会被悄悄当成根本身。 */
export function parseTargetDir(dir: string): string[] {
  const bad = (): never => {
    throw new Error('bad-target-dir')
  }
  if (typeof dir !== 'string') return bad()
  if (dir === '') return []
  if (dir.includes('\\') || dir.includes('\0') || dir.startsWith('/') || /^[A-Za-z]:/.test(dir)) return bad()
  const segs = dir.split('/')
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..' || s !== s.trim()) return bad()
  }
  return segs
}

const incomplete = (): never => {
  throw new Error('target-config-incomplete')
}

function build(spec: TargetSpec, segs: string[]): RemoteFs & Required<Pick<RemoteFs, 'stat'>> {
  const sub = segs.join('/')
  switch (spec.kind) {
    case 'folder': {
      const p = spec.folder?.path?.trim()
      if (!p) return incomplete()
      const root = path.join(p, ...segs)
      const r = createDirRemote(root, { cas: true })
      if (!segs.length) return r
      return {
        ...r,
        // 子目录不在 = 抛 target-dir-missing,绝不当空(契约 H-2 第 6 条):U 盘没插、挂载点空着时当空会读成远端全删;
        // 新建绑定由建绑定的一方在第一轮之前把目录建出来。walk 途中别的文件消失照旧抛原错。
        async walk(signal) {
          try {
            return await r.walk(signal)
          } catch (e) {
            const gone = (x: string): Promise<boolean> => fs.stat(x).then(() => false, (err) => (err as NodeJS.ErrnoException).code === 'ENOENT')
            // 配置的根本身不在(U 盘没插)照旧抛原错;根在、子目录不在才是 target-dir-missing
            if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' && !(await gone(p)) && (await gone(root))) {
              throw Object.assign(new Error('target-dir-missing'), { code: 'TARGET_DIR_MISSING' })
            }
            throw e
          }
        },
      }
    }
    case 's3': {
      const s3 = spec.s3
      if (!s3?.endpoint || !s3.bucket || !s3.accessKeyID || !s3.secretAccessKey) return incomplete()
      return createS3Remote({ ...s3, prefix: sub ? `${normPrefix(s3.prefix)}${sub}/` : normPrefix(s3.prefix) }, { cas: true })
    }
    case 'webdav': {
      const wd = spec.webdav
      if (!wd?.address) return incomplete()
      const base = webdavBaseDir(wd.baseDir)
      return createWebdavRemote({ ...wd, baseDir: sub ? `${base}/${sub}` : base }, { cas: true })
    }
    case 'dropbox': {
      const d = spec.dropbox
      if (!d?.appKey || !d.refreshToken) return incomplete()
      const base = normBaseDir(d.baseDir)
      return createDropboxRemote({ appKey: d.appKey, refreshToken: d.refreshToken, baseDir: sub ? `${base}/${sub}` : base, fetch: d.fetch }, { cas: true })
    }
    case 'gdrive': {
      const g = spec.gdrive
      if (!g?.clientId || !g.refreshToken) return incomplete()
      return createGdriveRemote(
        { clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: g.refreshToken, baseDir: [...gdriveBaseSegs(g.baseDir), ...segs].join('/'), fetch: g.fetch },
        { cas: true },
      )
    }
    default:
      return incomplete()
  }
}

/** 打开一个同步目标。dir = 后端配置根下的 posix 子路径('' = 根本身)。配置缺项 → target-config-incomplete;dir 不合法 → bad-target-dir。 */
export function openTargetFs(spec: TargetSpec, dir: string): TargetFs {
  const segs = parseTargetDir(dir)
  const r = build(spec, segs)
  return {
    kind: r.kind,
    caps: TARGET_CAPS[spec.kind],
    walk: r.walk,
    readFile: r.readFile,
    writeFile: r.writeFile,
    rm: r.rm,
    stat: r.stat,
    check: r.check,
  }
}
