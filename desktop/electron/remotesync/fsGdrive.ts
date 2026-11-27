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
 *    其余以 `名 (conflict gdrive <id 前 8 位>).扩展名` 露出(各自映射到自己的 ID,删掉本地这份 = 删掉远端那份);
 *  - 防并发覆盖:Drive v3 没有条件写(v3 的 File 没有 etag、files.update 不认 If-Match),
 *    只能写前按 ID 复查身份(headRevisionId / md5)、建前按「父目录 + 名字」复查不存在 —— 窗口缩到一个往返,
 *    不是原子的;剩余窗口见 README「上限」;
 *  - 写入一律 resumable 会话(先 POST/PATCH 元数据拿上传地址,再一次 PUT 全部内容):multipart 只适合 5MB 以内;
 *    会话在内容传完前不产生文件,所以建会话那一步撞限流可以安全重试;
 *  - 删除 = 移进回收站(trashed:true),30 天内可在 Drive 里找回。
 * 隔离约定:不 import electron/desktop;凭据由宿主(remotesyncIpc)注入。
 */
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

/** 同名重复文件的派生 key:`a/b (conflict gdrive 1a2b3c4d).md`。 */
export function dupKey(key: string, id: string): string {
  const slash = key.lastIndexOf('/')
  const dir = slash >= 0 ? key.slice(0, slash + 1) : ''
  const name = key.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const tag = ` (conflict gdrive ${id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8)})`
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
 * 同一路径既是文件又是文件夹时文件夹优先、文件走 dupKey(本地盘放不下两个)。
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
  const seen = new Set<string>()
  const queue: Array<{ rel: string; ids: string[] }> = [{ rel: '', ids: baseIds }]
  while (queue.length) {
    const { rel, ids } = queue.shift()!
    folders.set(rel, ids)
    const subFolders = new Map<string, WireFile[]>()
    const subFiles = new Map<string, WireFile[]>()
    for (const id of ids) {
      for (const c of kids.get(id) ?? []) {
        if (seen.has(`${id}/${c.id}`) || !c.name || c.name.includes('/') || c.name === '.' || c.name === '..') continue
        seen.add(`${id}/${c.id}`)
        const bucket = c.mimeType === FOLDER_MIME ? subFolders : c.mimeType?.startsWith('application/vnd.google-apps.') ? null : subFiles
        if (!bucket) continue
        const arr = bucket.get(c.name)
        if (arr) { if (!arr.some((x) => x.id === c.id)) arr.push(c) } else bucket.set(c.name, [c])
      }
    }
    const prefix = rel ? `${rel}/` : ''
    for (const [name, fs] of subFolders) {
      const childRel = `${prefix}${name}`
      if (folders.has(childRel)) continue // 环(多父)防护
      queue.push({ rel: childRel, ids: fs.sort(byAge).map((f) => f.id) })
    }
    for (const [name, fs] of subFiles) {
      const key = `${prefix}${name}`
      fs.sort(byAge)
      fs.forEach((f, i) => files.set(i === 0 && !subFolders.has(name) ? key : dupKey(key, f.id), f))
    }
  }
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

export function createGdriveRemote(cfg: GdriveConfig): RemoteFs {
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

  /** 带鉴权的请求;限流退避重试(只在请求被拒、确定没产生副作用时)。 */
  const call = async (url: string, init: RequestInit & { headers?: Record<string, string> } = {}, signal?: AbortSignal): Promise<Response> => {
    for (let i = 0; ; i++) {
      const token = await accessToken(signal)
      const rsp = await f(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }, signal })
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

  /** 列出某父目录下名为 name 的子项(未进回收站)。 */
  const childrenNamed = async (parent: string, name: string, signal?: AbortSignal, folderOnly = false): Promise<WireFile[]> => {
    const q = `${qStr(parent)} in parents and name = ${qStr(name)} and trashed = false${folderOnly ? ` and mimeType = ${qStr(FOLDER_MIME)}` : ''}`
    const out: WireFile[] = []
    let pageToken = ''
    for (;;) {
      const u = new URLSearchParams({ q, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '1000', spaces: 'drive' })
      if (pageToken) u.set('pageToken', pageToken)
      const rsp = await call(`${API}/files?${u}`, {}, signal)
      if (!rsp.ok) await fail('query', rsp)
      const j = (await rsp.json()) as { files?: WireFile[]; nextPageToken?: string }
      out.push(...(j.files ?? []))
      if (!j.nextPageToken) return out.sort(byAge)
      pageToken = j.nextPageToken
    }
  }

  /** baseDir 逐段解析(每段重名的都收,按年龄排)。create=false 时某段不存在 → null(= 空远端)。 */
  const resolveBase = async (create: boolean, signal?: AbortSignal): Promise<string[] | null> => {
    let ids = ['root']
    for (const seg of baseSegs) {
      const found: WireFile[] = []
      for (const id of ids) found.push(...(await childrenNamed(id, seg, signal, true)))
      if (found.length) {
        ids = found.sort(byAge).map((x) => x.id)
        continue
      }
      if (!create) return null
      ids = [await createFolder(ids[0], seg, signal)]
    }
    return ids
  }

  const createFolder = async (parent: string, name: string, signal?: AbortSignal): Promise<string> => {
    const rsp = await call(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    }, signal)
    if (!rsp.ok) await fail('mkdir', rsp)
    return ((await rsp.json()) as { id: string }).id
  }

  const listAll = async (signal?: AbortSignal): Promise<WireFile[]> => {
    const out: WireFile[] = []
    let pageToken = ''
    for (;;) {
      const u = new URLSearchParams({ q: 'trashed = false', fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '1000', spaces: 'drive' })
      if (pageToken) u.set('pageToken', pageToken)
      const rsp = await call(`${API}/files?${u}`, {}, signal)
      if (!rsp.ok) await fail('list', rsp) // 列不全必须 throw(缺失会被引擎当删除)
      const j = (await rsp.json()) as { files?: WireFile[]; nextPageToken?: string }
      out.push(...(j.files ?? []))
      if (!j.nextPageToken) return out
      pageToken = j.nextPageToken
    }
  }

  const loadTree = async (signal?: AbortSignal): Promise<DriveTree> => {
    const baseIds = await resolveBase(false, signal)
    folderPending.clear()
    tree = baseIds ? buildTree(await listAll(signal), baseIds) : { files: new Map(), folders: new Map() }
    return tree
  }

  /** 相对目录 → 文件夹 ID,缺的逐段建(同一路径并发只建一次;建前复查一次,别和另一台撞出重名)。 */
  const ensureFolder = (rel: string, signal?: AbortSignal): Promise<string> => {
    const known = tree?.folders.get(rel)?.[0]
    if (known) return Promise.resolve(known)
    const pending = folderPending.get(rel)
    if (pending) return pending
    const p = (async () => {
      if (rel === '') return (await resolveBase(true, signal))![0]
      const slash = rel.lastIndexOf('/')
      const parent = await ensureFolder(slash >= 0 ? rel.slice(0, slash) : '', signal)
      const name = rel.slice(slash + 1)
      const existing = await childrenNamed(parent, name, signal, true)
      return existing[0]?.id ?? (await createFolder(parent, name, signal))
    })()
    folderPending.set(rel, p)
    p.catch(() => folderPending.delete(rel)) // 失败别缓存,下次重来
    return p
  }

  const getMeta = async (id: string, signal?: AbortSignal): Promise<WireFile | null> => {
    const rsp = await call(`${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`, {}, signal)
    if (rsp.status === 404) return null
    if (!rsp.ok) await fail('stat', rsp)
    return (await rsp.json()) as WireFile
  }

  /** 引擎给的期望身份 vs 远端此刻身份:不符 = 有人在 walk 之后改过 → cas-conflict。 */
  const assertIdentity = async (key: string, expected: string, signal?: AbortSignal): Promise<WireFile> => {
    const meta = await getMeta(fileIdOfIdentity(expected), signal)
    if (!meta || meta.trashed || identityOf(meta) !== expected) throw new Error(`cas-conflict gdrive ${key}: remote changed since listing`)
    return meta
  }

  const entityOf = (key: string, w: WireFile): RemoteEntity => {
    const ent: RemoteEntity = { key, size: Number(w.size ?? 0), mtimeMs: Date.parse(w.modifiedTime ?? '') || 0, id: identityOf(w) }
    if (w.sha256Checksum && /^[0-9a-f]{64}$/i.test(w.sha256Checksum)) ent.hash = w.sha256Checksum.toLowerCase()
    return ent
  }

  const ensureTree = async (signal?: AbortSignal): Promise<DriveTree> => tree ?? (await loadTree(signal))

  /** resumable 上传:建会话(POST 新建 / PATCH 更新)→ 一次 PUT 全部内容。 */
  const upload = async (
    target: { create: { parent: string; name: string } } | { update: string },
    data: Buffer,
    mtimeMs: number,
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
    // 内容 PUT 不重试:超时 / 5xx 时会话可能已落盘,重试会出重复文件
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
      // 截断防护:内容长度对清单 size 校验
      if (w.size !== undefined && Number(w.size) !== data.byteLength) throw new Error(`gdrive size mismatch: ${key}`)
      return data
    },
    async writeFile(key, data, mtimeMs, signal, expectedId) {
      const t = await ensureTree(signal)
      const known = t.files.get(key)
      let w: WireFile
      if (typeof expectedId === 'string') {
        const meta = await assertIdentity(key, expectedId, signal)
        w = await upload({ update: meta.id }, data, mtimeMs, signal)
      } else if (known && expectedId === undefined) {
        w = await upload({ update: known.id }, data, mtimeMs, signal)
      } else {
        if (known) throw new Error(`cas-conflict gdrive PUT ${key}: already exists remotely`)
        const slash = key.lastIndexOf('/')
        const name = key.slice(slash + 1)
        const parent = await ensureFolder(slash >= 0 ? key.slice(0, slash) : '', signal)
        // 建前复查:walk 之后另一台可能已建了同名文件(Drive 不会拒绝重名,这里不查就会并存两份)
        const existing = (await childrenNamed(parent, name, signal)).filter((x) => x.mimeType !== FOLDER_MIME)
        if (existing.length) {
          if (expectedId === null) throw new Error(`cas-conflict gdrive PUT ${key}: created remotely since listing`)
          w = await upload({ update: existing[0].id }, data, mtimeMs, signal)
        } else w = await upload({ create: { parent, name } }, data, mtimeMs, signal)
      }
      t.files.set(key, w)
      return entityOf(key, w)
    },
    async rm(key, signal, expectedId) {
      const t = await ensureTree(signal)
      let id = t.files.get(key)?.id
      if (typeof expectedId === 'string' && expectedId) {
        const meta = await getMeta(fileIdOfIdentity(expectedId), signal)
        if (!meta || meta.trashed) { t.files.delete(key); return } // 已不在 = 幂等
        if (identityOf(meta) !== expectedId) throw new Error(`cas-conflict gdrive rm ${key}: remote changed since listing`)
        id = meta.id
      }
      if (!id) return
      const rsp = await call(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      }, signal)
      if (!rsp.ok && rsp.status !== 404) await fail(`rm ${key}`, rsp)
      t.files.delete(key)
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
