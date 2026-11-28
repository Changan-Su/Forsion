/**
 * Google Drive 后端(Forsion 自研:直连公开 REST v3 API;未使用、未参考 remotely-save 的
 * Google Drive 实现 —— 合规边界见 NOTICE.md):
 *  - OAuth:Google「桌面应用」客户端 + PKCE + 回环回调(http://127.0.0.1:<任意端口>/,Google 对
 *    桌面客户端的回环地址不校验端口,所以交系统选口,不像 Dropbox 写死)。Google 已关掉 OOB 手贴码,
 *    回环起不来就直接报错。桌面客户端的 client secret 按 Google 的说法不算机密,换码 / 续期都要带;
 *  - 权限范围 drive.file:只看得到本客户端(OAuth 项目)建的文件 —— 免安全审计;代价是用户在网页版里
 *    手动拖进同步目录的文件同步不到,换一个客户端(自建 ↔ 官方)也看不到旧客户端建的文件(指纹带 client id);
 *  - Drive 按文件 ID 寻址、同名可以并存:walk 一次分页平铺列出全部可见文件,内存里自建「路径 → ID」;
 *    同名文件夹合并(并发首推的两台各建了一个),同名文件按 createdTime→id 排序,第一个占原路径,
 *    其余以 `名 (conflict gdrive <文件 ID>).扩展名` 露出(各自映射到自己的 ID,删掉本地这份 = 删掉远端那份);
 *  - 防并发覆盖:Drive v3 没有条件写(v3 的 File 没有 etag、files.update 不认 If-Match),
 *    只能在发内容 / 回收请求前一刻按 ID 复查(内容版本 + 名字 + 父目录)、建前按「全部同名父目录 + 名字」复查不存在
 *    —— 窗口缩到一个往返,不是原子的;剩余窗口见 README「上限」;下载后对清单 sha256 / md5 校验;
 *  - 写入一律 resumable 会话(先 POST/PATCH 元数据拿上传地址,再一次 PUT 全部内容):multipart 只适合 5MB 以内;
 *    会话在内容传完前不产生文件,所以建会话那一步撞限流可以安全重试;
 *  - 删除 = 移进回收站(trashed:true),30 天内可在 Drive 里找回。
 *  - stat(单 key,TargetFs 用):从 baseDir 逐段现查父目录(每段一次查询 × 同名父目录数),再按名字查一次 ——
 *    不用清单缓存的文件夹 ID:walk 之后目标文件夹 / 中间目录在网页版被改名或移走,文件夹与文件 ID 都不变,
 *    按缓存 ID 会找到(进而写删)挪走的那份。key 上同时有同名文件夹、或 key 本身是冲突派生名时,规则依赖整棵树
 *    (文件夹非空才让位 / 派生名按年龄排),走一次私有的全量列表(不替换共享清单)。结果回写清单里这一个 key。
 *  - opts.cas = TargetFs 语义(targetFs.ts):rm(null) 现查(不只看清单);条件写删在发请求前按 key 当前的路径
 *    现查(同 stat)并比对文件 ID + 内容版本;新建发内容前确认落点文件夹仍在 key 的当前路径上。缺省 = 旧行为。
 * 隔离约定:不 import electron/desktop;凭据由宿主(remotesyncIpc)注入。
 */
import { createHash } from 'node:crypto'
import type { RemoteEntity, RemoteFs } from './types'

export interface GdriveConfig {
  /** OAuth 客户端 ID(Google Cloud Console →「桌面应用」类型)。 */
  clientId: string
  /** 桌面客户端的 secret(Google 明说不算机密;token 端点仍要它)。 */
  clientSecret?: string
  /** 长期授权凭据(access_type=offline + prompt=consent 换得)。 */
  refreshToken: string
  /** 远端根目录(相对「我的云端硬盘」;缺省 Forsion-Vault —— Drive 没有 App Folder 沙箱,空着会把整库撒在根上)。 */
  baseDir?: string
  /** 换掉全局 fetch(宿主可注入走系统代理的实现;缺省调用时再取全局 fetch,便于测试 stub)。 */
  fetch?: typeof fetch
}

/**
 * Forsion 官方 Google OAuth 客户端 —— 填了它,用户点「连接 Google Drive」直接登,不用自建客户端。
 * 「桌面应用」类型的 client secret 按 Google 文档不算机密,随包分发是官方认可的做法;
 * ⚠️ 本仓公开,secret 提交上来可能触发 GitHub 的 secret scanning 告警(属预期,可在仓库设置里标为误报)。
 * 空 = 尚未登记官方客户端,UI 退回「用户自建客户端 + 填 ID / secret」。
 * 登记步骤:console.cloud.google.com → 新建项目 → API 和服务 → 启用 Google Drive API →
 * OAuth 同意屏幕(外部;范围加 .../auth/drive.file;发布状态改「正式版」,测试状态下 refresh token 7 天过期)→
 * 凭据 → 创建 OAuth 客户端 ID → 应用类型「桌面应用」→ 复制客户端 ID 与 secret 填到下面。
 */
export const FORSION_GDRIVE_CLIENT_ID = ''
export const FORSION_GDRIVE_CLIENT_SECRET = ''

export const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const GDRIVE_DEFAULT_BASE = 'Forsion-Vault'

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FILE_FIELDS = 'id,name,mimeType,parents,size,createdTime,modifiedTime,headRevisionId,md5Checksum,sha256Checksum,trashed'

/** baseDir 规范化:去首尾 / 与空段;空 = 缺省 Forsion-Vault。返回段数组。 */
export function gdriveBaseSegs(d?: string): string[] {
  const segs = (d ?? '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter((s) => s !== '' && s !== '.' && s !== '..')
  return segs.length ? segs : [GDRIVE_DEFAULT_BASE]
}

/** q 查询里的字符串字面量:\ 与 ' 要转义。 */
export const qStr = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

// ── OAuth(宿主授权流程用;verifier 由宿主暂存)───────────────────────────────

export function gdriveAuthUrl(clientId: string, challenge: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GDRIVE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // offline + consent:重连时也必发 refresh_token(否则 Google 只在首次授权给)
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${AUTH}?${q.toString()}`
}

interface TokenRsp { access_token?: string; refresh_token?: string; expires_in?: number }

async function tokenCall(f: typeof fetch, body: URLSearchParams, signal?: AbortSignal): Promise<TokenRsp> {
  const rsp = await f(TOKEN, { method: 'POST', body, signal })
  if (!rsp.ok) throw new Error(`gdrive oauth ${rsp.status}: ${(await rsp.text().catch(() => '')).slice(0, 200)}`)
  return (await rsp.json()) as TokenRsp
}

/** 授权码 → refresh token + 账号身份(permissionId 进指纹;email 给 UI 显示)。redirectUri 必须与授权请求逐字一致。 */
export async function gdriveExchangeCode(
  client: { clientId: string; clientSecret?: string },
  code: string,
  verifier: string,
  redirectUri: string,
  fetchImpl?: typeof fetch,
): Promise<{ refreshToken: string; accountId: string; email?: string; name?: string }> {
  const f = fetchImpl ?? fetch
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: code.trim(), code_verifier: verifier, client_id: client.clientId, redirect_uri: redirectUri })
  if (client.clientSecret) body.set('client_secret', client.clientSecret)
  const j = await tokenCall(f, body)
  if (!j.refresh_token) throw new Error('gdrive oauth: no refresh_token in response')
  const about = await f(`${API}/about?fields=user(permissionId,emailAddress,displayName)`, {
    headers: { Authorization: `Bearer ${j.access_token}` },
  }).catch(() => null)
  if (!about?.ok) throw new Error(`gdrive about ${about?.status ?? 'network'}: cannot read account identity`)
  const u = ((await about.json()) as { user?: { permissionId?: string; emailAddress?: string; displayName?: string } }).user ?? {}
  if (!u.permissionId) throw new Error('gdrive about: no permissionId')
  return { refreshToken: j.refresh_token, accountId: u.permissionId, email: u.emailAddress, name: u.displayName }
}

// ── 路径映射(纯函数,单测直接喂数据)──────────────────────────────────────────

export interface WireFile {
  id: string
  name: string
  mimeType?: string
  parents?: string[]
  size?: string
  createdTime?: string
  modifiedTime?: string
  headRevisionId?: string
  md5Checksum?: string
  sha256Checksum?: string
  trashed?: boolean
}

/** 身份 = 文件 ID + 内容版本(只随内容变;元数据改名 / 共享不触发重拉)。walk 与写回必须同一口径。 */
export const identityOf = (f: WireFile): string => `${f.id}@${f.headRevisionId || f.md5Checksum || f.modifiedTime || ''}`
const fileIdOfIdentity = (identity: string): string => identity.slice(0, identity.indexOf('@') < 0 ? identity.length : identity.indexOf('@'))

/** 同名重复文件的派生 key:`a/b (conflict gdrive <完整文件 ID>).md`(用完整 ID:截短会让两份撞成一个 key)。 */
export function dupKey(key: string, id: string): string {
  const slash = key.lastIndexOf('/')
  const dir = slash >= 0 ? key.slice(0, slash + 1) : ''
  const name = key.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const tag = ` (conflict gdrive ${id.replace(/[^A-Za-z0-9_-]/g, '')})`
  return dot > 0 ? `${dir}${name.slice(0, dot)}${tag}${name.slice(dot)}` : `${dir}${name}${tag}`
}

const byAge = (a: WireFile, b: WireFile): number =>
  (Date.parse(a.createdTime ?? '') || 0) - (Date.parse(b.createdTime ?? '') || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export interface DriveTree {
  /** 文件 key → 文件(含派生的冲突 key)。 */
  files: Map<string, WireFile>
  /** 文件夹相对路径('' = baseDir 本身)→ 该路径下全部文件夹 ID,按年龄排序,[0] 是新建子项的落点。 */
  folders: Map<string, string[]>
}

/**
 * 平铺列表 → 路径树。baseIds = baseDir 解析出的文件夹 ID(重名的都算,按年龄排)。
 * 文件夹同名合并;文件同名按年龄定主次(次的走 dupKey);Google 文档类(不可下载)与名字带 / 的跳过。
 * 同一路径既是文件又是文件夹:文件夹里真有文件时文件夹优先、文件走 dupKey(本地盘放不下两个);
 * 文件夹是空的(walk 本来就不列目录)则文件照旧占原路径 —— 否则推上去的文件下一轮被挤成冲突 key,
 * 引擎会把原 key 的「不见了」当成远端删除。
 */
export function buildTree(all: WireFile[], baseIds: string[]): DriveTree {
  const kids = new Map<string, WireFile[]>()
  for (const f of all) {
    if (f.trashed) continue
    for (const p of f.parents ?? []) {
      const arr = kids.get(p)
      if (arr) arr.push(f)
      else kids.set(p, [f])
    }
  }
  const files = new Map<string, WireFile>()
  const folders = new Map<string, string[]>()
  /** 深度优先;返回这棵子树里的文件数。key 超 512 的子树不再下钻(isSafeKey 也会拒;顺带挡住异常的环)。 */
  const visit = (rel: string, ids: string[]): number => {
    folders.set(rel, ids)
    const subFolders = new Map<string, WireFile[]>()
    const subFiles = new Map<string, WireFile[]>()
    const add = (bucket: Map<string, WireFile[]>, c: WireFile): void => {
      const arr = bucket.get(c.name)
      if (!arr) bucket.set(c.name, [c])
      else if (!arr.some((x) => x.id === c.id)) arr.push(c) // 多父文件在合并的同名文件夹里只算一次
    }
    for (const id of ids) {
      for (const c of kids.get(id) ?? []) {
        if (!c.name || c.name.includes('/') || c.name === '.' || c.name === '..') continue
        if (c.mimeType === FOLDER_MIME) add(subFolders, c)
        else if (!c.mimeType?.startsWith('application/vnd.google-apps.')) add(subFiles, c)
      }
    }
    const prefix = rel ? `${rel}/` : ''
    let count = 0
    const nonEmpty = new Set<string>()
    for (const [name, fs] of subFolders) {
      const childRel = `${prefix}${name}`
      if (childRel.length > 512 || folders.has(childRel)) continue
      const n = visit(childRel, fs.sort(byAge).map((f) => f.id))
      if (n > 0) nonEmpty.add(name)
      count += n
    }
    for (const [name, fs] of subFiles) {
      const key = `${prefix}${name}`
      fs.sort(byAge)
      fs.forEach((f, i) => {
        const k = i === 0 && !nonEmpty.has(name) ? key : dupKey(key, f.id)
        // 派生 key 恰好与真实文件同名(或别的撞法):宁可整轮报错,也不让 Map 静默吞掉一个文件 ID(缺失会被当删除)
        if (files.has(k)) throw new Error(`gdrive-key-collision: ${k}`)
        files.set(k, f)
      })
      count += fs.length
    }
    return count
  }
  visit('', baseIds)
  return { files, folders }
}

// ── RemoteFs ─────────────────────────────────────────────────────────────────

const RETRY_MS = [1000, 2000, 4000, 8000]
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')) }, { once: true })
  })

/** 限流:429,或 403 且原因是 rate limit(Drive 的写入配额)。 */
async function isRateLimited(rsp: Response): Promise<boolean> {
  if (rsp.status === 429) return true
  if (rsp.status !== 403) return false
  const t = await rsp.clone().text().catch(() => '')
  return /rateLimitExceeded|userRateLimitExceeded/.test(t)
}

export interface GdriveRemoteOptions {
  /** TargetFs 语义(见 targetFs.ts);缺省 false = 旧行为。 */
  cas?: boolean
}

/** dupKey 派生出来的名字形状(`名 (conflict gdrive <ID>).扩展名`)。 */
const DUP_NAME = / \(conflict gdrive [A-Za-z0-9_-]+\)(\.[^.]*)?$/

export function createGdriveRemote(cfg: GdriveConfig, opts: GdriveRemoteOptions = {}): RemoteFs & Required<Pick<RemoteFs, 'stat'>> {
  const f: typeof fetch = (input, init) => (cfg.fetch ?? fetch)(input, init)
  const baseSegs = gdriveBaseSegs(cfg.baseDir)
  let cached: { token: string; exp: number } | null = null
  let tree: DriveTree | null = null
  /** 正在建 / 已建好的文件夹(相对路径 → ID):并发写同一新目录只建一次。 */
  const folderPending = new Map<string, Promise<string>>()

  const accessToken = async (signal?: AbortSignal): Promise<string> => {
    if (cached && Date.now() < cached.exp - 60_000) return cached.token
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, client_id: cfg.clientId })
    if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret)
    const j = await tokenCall(f, body, signal)
    if (!j.access_token) throw new Error('gdrive token: no access_token')
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 }
    return cached.token
  }

  /** 带鉴权的请求。限流退避重试只给没有副作用、也不依赖前置检查的请求(查询、建上传会话);
   *  写删要在每次重发前重新核对,走 withRetry。 */
  const call = async (url: string, init: RequestInit & { headers?: Record<string, string> } = {}, signal?: AbortSignal, retry = true): Promise<Response> => {
    for (let i = 0; ; i++) {
      const token = await accessToken(signal)
      const rsp = await f(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }, signal })
      if (retry && i < RETRY_MS.length && (await isRateLimited(rsp))) {
        await sleep(RETRY_MS[i], signal)
        continue
      }
      return rsp
    }
  }
  /** 有副作用的请求:每次发之前先跑 precheck(期间远端被改 → precheck 抛 cas-conflict,不会拿旧判断重发)。 */
  const withRetry = async (precheck: () => Promise<void>, send: () => Promise<Response>, signal?: AbortSignal): Promise<Response> => {
    for (let i = 0; ; i++) {
      await precheck()
      const rsp = await send()
      if (i < RETRY_MS.length && (await isRateLimited(rsp))) {
        await sleep(RETRY_MS[i], signal)
        continue
      }
      return rsp
    }
  }

  const fail = async (what: string, rsp: Response): Promise<never> => {
    throw new Error(`gdrive ${what} ${rsp.status}: ${(await rsp.text().catch(() => '')).slice(0, 200)}`)
  }

  /** 分页查询;任何一页失败或 Drive 自报不完整(incompleteSearch)都抛 —— 列不全会被引擎当删除。 */
  const query = async (what: string, q: string, signal?: AbortSignal): Promise<WireFile[]> => {
    const out: WireFile[] = []
    let pageToken = ''
    for (;;) {
      const u = new URLSearchParams({ q, fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`, pageSize: '1000', spaces: 'drive' })
      if (pageToken) u.set('pageToken', pageToken)
      const rsp = await call(`${API}/files?${u}`, {}, signal)
      if (!rsp.ok) await fail(what, rsp)
      const j = (await rsp.json()) as { files?: WireFile[]; nextPageToken?: string; incompleteSearch?: boolean }
      if (j.incompleteSearch) throw new Error(`gdrive ${what}: incomplete result`)
      out.push(...(j.files ?? []))
      if (!j.nextPageToken) return out
      pageToken = j.nextPageToken
    }
  }

  /** 若干个(合并的同名)父目录下名为 name 的子项(未进回收站),按年龄排。 */
  const childrenNamed = async (parents: string[], name: string, signal?: AbortSignal, folderOnly = false): Promise<WireFile[]> => {
    const out: WireFile[] = []
    for (const parent of parents) {
      const q = `${qStr(parent)} in parents and name = ${qStr(name)} and trashed = false${folderOnly ? ` and mimeType = ${qStr(FOLDER_MIME)}` : ''}`
      for (const x of await query('query', q, signal)) if (!out.some((o) => o.id === x.id)) out.push(x)
    }
    return out.sort(byAge)
  }

  /** baseDir 逐段解析(每段重名的都收,按年龄排)。create=false 时某段不存在 → null(= 空远端)。 */
  const resolveBase = async (create: boolean, signal?: AbortSignal): Promise<string[] | null> => {
    let ids = ['root']
    for (const seg of baseSegs) {
      const found = await childrenNamed(ids, seg, signal, true)
      if (found.length) {
        ids = found.map((x) => x.id)
        continue
      }
      if (!create) return null
      ids = [await createFolder(ids[0], seg, signal)]
    }
    return ids
  }

  const createFolder = async (parent: string, name: string, signal?: AbortSignal): Promise<string> => {
    // 建目录被限流拒掉 = 没建成,可以安全重发
    const rsp = await call(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    }, signal)
    if (!rsp.ok) await fail('mkdir', rsp)
    return ((await rsp.json()) as { id: string }).id
  }

  const loadTree = async (signal?: AbortSignal): Promise<DriveTree> => {
    const baseIds = await resolveBase(false, signal)
    folderPending.clear()
    tree = baseIds ? buildTree(await query('list', 'trashed = false', signal), baseIds) : { files: new Map(), folders: new Map() }
    return tree
  }

  const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
  const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

  /** 相对目录 → 全部物理文件夹 ID(合并的同名文件夹都算;[0] 是新建子项的落点),缺的逐段建。
   *  同一路径并发只建一次;建前在所有同名父目录里复查一遍,别和另一台撞出重名。 */
  const ensureFolder = (rel: string, signal?: AbortSignal): Promise<string[]> => {
    const known = tree?.folders.get(rel)
    if (known?.length) return Promise.resolve(known)
    const pending = folderPending.get(rel)
    if (pending) return pending.then((id) => [id])
    const p = (async () => {
      if (rel === '') return (await resolveBase(true, signal))![0]
      const parents = await ensureFolder(dirOf(rel), signal)
      const existing = await childrenNamed(parents, baseOf(rel), signal, true)
      return existing[0]?.id ?? (await createFolder(parents[0], baseOf(rel), signal))
    })()
    folderPending.set(rel, p)
    p.catch(() => folderPending.delete(rel)) // 失败别缓存,下次重来
    return p.then((id) => [id])
  }

  const getMeta = async (id: string, signal?: AbortSignal): Promise<WireFile | null> => {
    const rsp = await call(`${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`, {}, signal)
    if (rsp.status === 404) return null
    if (!rsp.ok) await fail('stat', rsp)
    return (await rsp.json()) as WireFile
  }

  const conflict = (op: string, key: string, why: string): Error => new Error(`cas-conflict gdrive ${op} ${key}: ${why}`)

  /** key 还指着引擎期望的那份文件吗:同一 ID、同一内容版本、名字没改、还在清单时那个父目录里。
   *  (只比内容版本不够:walk 之后在网页版改名 / 移走,版本不变,写删会落到挪走的那份上。)
   *  cas:按 key 此刻的路径现查(从 baseDir 逐段,见 lookupKey)—— 改名 / 移走的是目标文件夹或中间目录时,
   *  文件的名字和父目录 ID 都没变,下面按清单比对拦不住。 */
  const assertCurrent = async (op: string, key: string, expected: string, signal?: AbortSignal): Promise<WireFile> => {
    if (opts.cas) {
      const now = await lookupKey(key, signal)
      if (!now) throw conflict(op, key, 'absent at its current path')
      if (identityOf(now) !== expected) throw conflict(op, key, 'key no longer maps to the expected file version')
      return now
    }
    const w = tree?.files.get(key)
    if (!w || w.id !== fileIdOfIdentity(expected)) throw conflict(op, key, 'key no longer maps to the expected file')
    const meta = await getMeta(w.id, signal)
    if (!meta || meta.trashed || identityOf(meta) !== expected) throw conflict(op, key, 'remote changed since listing')
    if (meta.name !== w.name || !(meta.parents ?? []).some((p) => (w.parents ?? []).includes(p))) throw conflict(op, key, 'remote renamed or moved since listing')
    return meta
  }

  /** key 在远端确实没有活着的同名文件(新建前 / 判定「已删」前)。 */
  const assertAbsent = async (op: string, key: string, signal?: AbortSignal): Promise<void> => {
    const parents = tree?.folders.get(dirOf(key))
    if (!parents?.length) return // 父目录都不在 = 文件不可能在
    const live = (await childrenNamed(parents, baseOf(key), signal)).filter((x) => x.mimeType !== FOLDER_MIME)
    if (live.length) throw conflict(op, key, 'exists remotely')
  }

  const entityOf = (key: string, w: WireFile): RemoteEntity => {
    const ent: RemoteEntity = { key, size: Number(w.size ?? 0), mtimeMs: Date.parse(w.modifiedTime ?? '') || 0, id: identityOf(w) }
    if (w.sha256Checksum && /^[0-9a-f]{64}$/i.test(w.sha256Checksum)) ent.hash = w.sha256Checksum.toLowerCase()
    return ent
  }

  const ensureTree = async (signal?: AbortSignal): Promise<DriveTree> => tree ?? (await loadTree(signal))

  /** 相对目录 → 物理文件夹 ID(合并的同名都算,按年龄排);不存在 → null。只读,不建任何东西。
   *  fresh = 每一段(含 baseDir 本身)都现查,不用清单缓存的文件夹 ID。 */
  const resolveFolderIds = async (rel: string, signal?: AbortSignal, fresh = false): Promise<string[] | null> => {
    const known = fresh ? undefined : tree?.folders.get(rel)
    if (known?.length) return known
    if (rel === '') return resolveBase(false, signal)
    const parents = await resolveFolderIds(dirOf(rel), signal, fresh)
    if (!parents) return null
    const found = await childrenNamed(parents, baseOf(rel), signal, true)
    return found.length ? found.map((x) => x.id) : null
  }

  /** 回写共享清单里这一个 key(清单还没建就不建:写删路径自己会 walk)。 */
  const remember = (key: string, w: WireFile | null): void => {
    if (!tree) return
    if (w) tree.files.set(key, w)
    else tree.files.delete(key)
  }

  /** key 此刻映射到的文件(与 buildTree 同一规则);cas 下父目录从 baseDir 逐段现查。 */
  const lookupKey = async (key: string, signal?: AbortSignal): Promise<WireFile | null> => {
    const parents = await resolveFolderIds(dirOf(key), signal, !!opts.cas)
    if (!parents) {
      remember(key, null)
      return null
    }
    const name = baseOf(key)
    if (!DUP_NAME.test(name)) {
      const named = await childrenNamed(parents, name, signal) // 已按年龄排:[0] = buildTree 里占原路径的那份
      if (!named.some((x) => x.mimeType === FOLDER_MIME)) {
        const w = named.find((x) => !x.mimeType?.startsWith('application/vnd.google-apps.')) ?? null
        remember(key, w)
        return w
      }
    }
    // 有同名文件夹 / 派生名:私有全量列表,别动共享的 tree 与 folderPending(在途写还挂在上面)
    const baseIds = await resolveBase(false, signal)
    const w = baseIds ? buildTree(await query('list', 'trashed = false', signal), baseIds).files.get(key) ?? null : null
    remember(key, w)
    return w
  }

  const statKey = async (key: string, signal?: AbortSignal): Promise<RemoteEntity | null> => {
    const w = await lookupKey(key, signal)
    return w ? entityOf(key, w) : null
  }

  /** resumable 上传:建会话(POST 新建 / PATCH 更新;会话在内容到齐前不产生文件,可安全重试)
   *  → 发内容前最后核对一次前置条件 → 一次 PUT 全部内容(不重试:超时 / 5xx 时可能已落盘)。 */
  const upload = async (
    target: { create: { parent: string; name: string } } | { update: string },
    data: Buffer,
    mtimeMs: number,
    precheck: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<WireFile> => {
    const modifiedTime = new Date(Math.max(0, Math.floor(mtimeMs))).toISOString()
    const meta = 'create' in target ? { name: target.create.name, parents: [target.create.parent], modifiedTime } : { modifiedTime }
    const url = 'create' in target
      ? `${UPLOAD}/files?uploadType=resumable&fields=${FILE_FIELDS}`
      : `${UPLOAD}/files/${encodeURIComponent(target.update)}?uploadType=resumable&fields=${FILE_FIELDS}`
    const init = await call(url, {
      method: 'create' in target ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(data.byteLength) },
      body: JSON.stringify(meta),
    }, signal)
    if (!init.ok) await fail('upload-init', init)
    const session = init.headers.get('location')
    if (!session) throw new Error('gdrive upload-init: no session location')
    await precheck()
    const put = await f(session, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(data), signal })
    if (!put.ok) await fail('upload', put)
    return (await put.json()) as WireFile
  }

  return {
    kind: 'gdrive',
    async walk(signal) {
      // 只读:baseDir 不存在 = 空远端(dry run 也走这里,不许顺手建目录)
      const t = await loadTree(signal)
      return [...t.files].map(([key, w]) => entityOf(key, w))
    },
    async readFile(key, signal) {
      const w = (await ensureTree(signal)).files.get(key)
      if (!w) throw new Error(`gdrive GET 404 ${key}: not in listing`)
      const rsp = await call(`${API}/files/${encodeURIComponent(w.id)}?alt=media`, {}, signal)
      if (!rsp.ok) await fail(`GET ${key}`, rsp)
      const data = Buffer.from(await rsp.arrayBuffer())
      // 截断 / 版本漂移防护:下到的必须正是清单里那一版(否则引擎会把新内容记到旧身份上)
      if (w.size !== undefined && Number(w.size) !== data.byteLength) throw new Error(`gdrive size mismatch: ${key}`)
      const sum = w.sha256Checksum ? createHash('sha256').update(data).digest('hex') === w.sha256Checksum.toLowerCase()
        : w.md5Checksum ? createHash('md5').update(data).digest('hex') === w.md5Checksum.toLowerCase() : true
      if (!sum) throw new Error(`gdrive content mismatch: ${key} changed since listing`)
      return data
    },
    async writeFile(key, data, mtimeMs, signal, expectedId) {
      const t = await ensureTree(signal)
      const known = t.files.get(key)
      let w: WireFile
      if (typeof expectedId === 'string') {
        const cur = await assertCurrent('PUT', key, expectedId, signal)
        // cas 下 cur 来自按当前路径的现查,清单里的 known 可能已过期 / 缺席;旧路径 cur.id === known.id
        w = await upload({ update: opts.cas ? cur.id : known!.id }, data, mtimeMs, async () => { await assertCurrent('PUT', key, expectedId, signal) }, signal)
      } else if (known && expectedId === undefined) {
        w = await upload({ update: known.id }, data, mtimeMs, async () => {}, signal)
      } else {
        if (known) throw conflict('PUT', key, 'already exists remotely')
        const parents = await ensureFolder(dirOf(key), signal)
        // 建前复查(所有同名父目录):walk 之后另一台可能已建了同名文件 —— Drive 不拒重名,不查就并存两份
        const existing = (await childrenNamed(parents, baseOf(key), signal)).filter((x) => x.mimeType !== FOLDER_MIME)
        if (existing.length) {
          if (expectedId === null) throw conflict('PUT', key, 'created remotely since listing')
          w = await upload({ update: existing[0].id }, data, mtimeMs, async () => {}, signal)
        } else {
          w = await upload({ create: { parent: parents[0], name: baseOf(key) } }, data, mtimeMs, async () => {
            if (expectedId !== null) return
            let where = parents
            if (opts.cas) {
              // 落点文件夹必须仍在 key 的当前路径上:walk 之后被改名 / 移走的话,按缓存 ID 会建进挪走的那份
              const fresh = await resolveFolderIds(dirOf(key), signal, true)
              if (!fresh?.includes(parents[0])) throw conflict('PUT', key, 'target folder renamed or moved since listing')
              where = fresh
            }
            const again = (await childrenNamed(where, baseOf(key), signal)).filter((x) => x.mimeType !== FOLDER_MIME)
            if (again.length) throw conflict('PUT', key, 'created remotely since listing')
          }, signal)
        }
      }
      t.files.set(key, w)
      return entityOf(key, w)
    },
    async rm(key, signal, expectedId) {
      if (opts.cas && expectedId === null) {
        if (await statKey(key, signal)) throw conflict('rm', key, 'exists remotely')
        return
      }
      const t = await ensureTree(signal)
      const known = t.files.get(key)
      let id: string
      let precheck: () => Promise<void> = async () => {}
      if (expectedId === null) {
        if (known) throw conflict('rm', key, 'exists remotely')
        return
      } else if (typeof expectedId === 'string' && opts.cas) {
        // cas:按 key 当前的路径现查(见 assertCurrent);路径上已没有活着的文件 = 已不在,幂等
        const now = await lookupKey(key, signal)
        if (!now) return
        if (identityOf(now) !== expectedId) throw conflict('rm', key, 'key no longer maps to the expected file version')
        id = now.id
        precheck = async () => { await assertCurrent('rm', key, expectedId, signal) }
      } else if (typeof expectedId === 'string') {
        const meta = known?.id === fileIdOfIdentity(expectedId) ? await getMeta(known.id, signal) : null
        if (!meta || meta.trashed) {
          // 期望的那份已经不在:只有 key 上也没有别的文件,才算「已删」(幂等);换成了另一份 = 冲突
          if (known && known.id !== fileIdOfIdentity(expectedId)) throw conflict('rm', key, 'key now maps to another file')
          await assertAbsent('rm', key, signal)
          t.files.delete(key)
          return
        }
        id = known!.id
        precheck = async () => { await assertCurrent('rm', key, expectedId, signal) }
      } else {
        if (!known) return
        id = known.id
      }
      const rsp = await withRetry(precheck, () => call(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      }, signal, false), signal)
      if (!rsp.ok && rsp.status !== 404) await fail(`rm ${key}`, rsp)
      t.files.delete(key)
    },
    async stat(key, signal) {
      return statKey(key, signal)
    },
    async check() {
      try {
        const rsp = await call(`${API}/about?fields=user(permissionId)`)
        if (!rsp.ok) return { ok: false, error: `gdrive ${rsp.status}: ${(await rsp.text().catch(() => '')).slice(0, 120)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) }
      }
    },
  }
}
