/**
 * Amadeus Cloud 桥:在浏览器里实现完整 AmadeusApi(window.amadeus),底层 = Forsion server 的
 * /api/amadeus REST + SSE。桌面渲染层(经 '@' 别名复用)零改接管 —— 照 mobile 的
 * mobileAmadeusBridge 先例:同步工厂,先挂 window.amadeus 再动态 import '@/main'。
 *
 * 语义镜像 desktop/electron/amadeus/ipc.ts 的 handler 体(名称清洗/报错文案/ref 解析),
 * 编译器纯函数(parsePageSource/compile/newPage)在浏览器本地跑:
 *   loadPage = GET + parsePageSource;savePage = compile + PUT(乐观并发 baseSeq)。
 *
 * 并发模型:
 * - per-path 串行写队列(promise 链;rename/move 占旧新两个 key)—— 防同径写乱序;
 * - path→seq 表只由自己的 GET/PUT 响应更新(不吃 SSE 的 seq,否则 409 冲突检测失明);
 * - PUT 409 CONFLICT → 更新 seq + 触发该 path 的 onExternalChange(pageStore.reconcileExternal
 *   既有 LWW 通道,服务端版本胜) + toast;savePage 仍正常 resolve(镜像桌面「保存不抛」体感)。
 * - 树缓存(pages/files/folders)~200ms 去重:pageStore.refreshStructure 的
 *   Promise.all([listPages,listFolders,listFiles]) 三连击只打一次 GET /tree。
 */
import {
  compile,
  newPage as compilerNewPage,
  pageFileName,
  parsePageSource,
  type CompilerIO,
  type LoadedPage,
  type PageManifest,
} from '@amadeus-shared/compiler'
import { joinRel } from '@amadeus-shared/assets'
import { dbFileSchema, parseDb, serializeDb, type DbFile } from '@amadeus-shared/db/schema'
import { parseFmObject, setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'
import type {
  AmadeusApi,
  BacklinkRef,
  DbReadResult,
  EmbedResolved,
  PageProps,
  SearchHit,
  TagCount,
  VaultInfo,
} from '@amadeus-shared/ipc'
import { createCloudHttp, is404, is409, HttpError } from './cloudHttp'
import { startCloudEvents } from './cloudEvents'
import { buildAssetUrl, installCloudAssetUrls } from './cloudAssets'
import {
  attachmentPaths,
  basenamePosix,
  dirnamePosix,
  extnamePosix,
  findByBasenameIn,
  normalizePosix,
  safeDecode,
  stripRefWrappers,
  uniqueNameAmong,
} from './cloudPaths'

// ---------------------------------------------------------------------------
// REST DTO(冻结契约)
// ---------------------------------------------------------------------------

interface VaultDto { id: string; name: string; lastChangeSeq: number; sizeBytes: number; createdAt: string }
interface TreeDto { pages: string[]; files: Array<{ path: string; size: number }>; folders: string[]; seq: number }
interface FileDto { path: string; kind: string; content: string; seq: number; hash: string; updatedAt: string }
interface PutResultDto { seq: number; hash: string }
interface MoveResultDto { path: string; seq: number }
interface ConflictBody { code?: 'EXISTS' | 'CONFLICT'; seq?: number; content?: string }
interface PagePropsDto { path: string; title: string; fmExtra: string }

export interface CloudBridgeCfg {
  /** 如 https://host/api(无尾斜杠)。 */
  apiBase: string
  getToken(): string
  onAuthError(): void
}

// ---------------------------------------------------------------------------
// 全局通知钩子(main.tsx 在 '@/stores/appStore' 可用后接到 useApp.toast)
// ---------------------------------------------------------------------------

let notifyFn: (text: string, isError?: boolean) => void = () => { /* 装配前静默 */ }

export function setCloudNotify(fn: (text: string, isError?: boolean) => void): void {
  notifyFn = fn
}

const notify = (text: string, isError = false): void => {
  try { notifyFn(text, isError) } catch { /* toast 失败不影响数据通路 */ }
}

const nowIso = (): string => new Date().toISOString()
const DESKTOP_ONLY = '此操作仅桌面端可用'
const CONFLICT_TOAST = '云端已有更新，已加载最新版本（本次未保存的修改被覆盖）'

/** 同步工厂:内部状态全在闭包;网络在各方法内 ensureVault() 后才发生。 */
export function createCloudAmadeusBridge(cfg: CloudBridgeCfg): AmadeusApi {
  // randomUUID 需要 secure context(https/localhost);http 内网部署兜底随机串,别让工厂抛挂白屏。
  const clientId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const http = createCloudHttp({
    apiBase: cfg.apiBase,
    getToken: cfg.getToken,
    clientId,
    onUnauthorized: cfg.onAuthError,
  })

  // ---- vault 身份 -----------------------------------------------------------
  let vaultId: string | null = null
  let vaultPromise: Promise<string> | null = null
  const vid = (): string => vaultId ?? 'default' // 契约:字面量 'default' 可用

  async function ensureVault(): Promise<string> {
    if (vaultId) return vaultId
    if (vaultPromise) return vaultPromise
    vaultPromise = (async () => {
      const r = await http.get<{ vaults: VaultDto[] }>('/amadeus/vaults') // 服务端自动建 default + 种子 Calendar.db
      const v = r.vaults.find((x) => x.id === 'default') ?? r.vaults[0]
      vaultId = v?.id ?? 'default'
      return vaultId
    })()
    vaultPromise.catch(() => { vaultPromise = null }) // 失败可重试
    return vaultPromise
  }

  // ---- path → seq(乐观并发基准;只由自己的 GET/PUT 更新) ---------------------
  const seqMap = new Map<string, number>()
  const noteSeq = (path: string, seq: number): void => { seqMap.set(path, seq) }
  const forgetSeq = (path: string): void => { seqMap.delete(path) }
  const migrateSeq = (from: string, to: string, seq?: number): void => {
    const s = seq ?? seqMap.get(from)
    seqMap.delete(from)
    if (s !== undefined) seqMap.set(to, s)
  }
  const migrateSeqPrefix = (fromDir: string, toDir: string): void => {
    const fromPrefix = `${fromDir}/`
    for (const [k, v] of [...seqMap]) {
      if (k.startsWith(fromPrefix)) {
        seqMap.delete(k)
        seqMap.set(`${toDir}/${k.slice(fromPrefix.length)}`, v)
      }
    }
  }
  const forgetSeqPrefix = (dir: string): void => {
    const prefix = `${dir}/`
    for (const k of [...seqMap.keys()]) if (k === dir || k.startsWith(prefix)) seqMap.delete(k)
  }

  // ---- 树缓存(~200ms 去重;listPages/listFiles/listFolders 三连击一次 GET) ----
  let treeState: { at: number; promise: Promise<TreeDto>; settled: boolean } | null = null
  const invalidateTree = (): void => { treeState = null }
  async function fetchTree(force = false): Promise<TreeDto> {
    const now = Date.now()
    if (!force && treeState && (!treeState.settled || now - treeState.at < 200)) return treeState.promise
    const v = await ensureVault()
    const entry: { at: number; promise: Promise<TreeDto>; settled: boolean } = {
      at: Date.now(),
      promise: http.get<TreeDto>(`/amadeus/vaults/${encodeURIComponent(v)}/tree`),
      settled: false,
    }
    treeState = entry
    entry.promise.then(
      () => { entry.settled = true },
      () => { if (treeState === entry) treeState = null }, // 失败不缓存
    )
    return entry.promise
  }
  const allTreePaths = (t: TreeDto): string[] => [...t.pages, ...t.files.map((f) => f.path)]

  // ---- per-path 串行写队列(rename/move 占两个 key) ---------------------------
  const queues = new Map<string, Promise<unknown>>()
  function enqueue<T>(keys: string[], task: () => Promise<T>): Promise<T> {
    const prev = Promise.allSettled(keys.map((k) => queues.get(k) ?? Promise.resolve()))
    const run = prev.then(() => task())
    const guard = run.then(() => undefined, () => undefined)
    for (const k of keys) queues.set(k, guard)
    void guard.then(() => {
      for (const k of keys) if (queues.get(k) === guard) queues.delete(k)
    })
    return run
  }

  // ---- 事件回调三组 + 派发 ----------------------------------------------------
  const extCbs = new Set<(p: string) => void>()
  const structCbs = new Set<() => void>()
  const dbCbs = new Set<(p: string) => void>()
  const fireExternal = (p: string): void => { for (const cb of [...extCbs]) { try { cb(p) } catch { /* 单回调失败不断链 */ } } }
  const fireStructure = (): void => { for (const cb of [...structCbs]) { try { cb() } catch { /* 同上 */ } } }
  const fireDb = (p: string): void => { for (const cb of [...dbCbs]) { try { cb(p) } catch { /* 同上 */ } } }

  // ---- lastPage(localStorage,按 vault 分键)+ 资源 URL 的活动页基准 ------------
  let lastLoadedPage: string | null = null
  const lastPageKey = (): string => `amadeus_last_page:${vid()}`
  const rememberPage = (p: string): void => {
    lastLoadedPage = p
    try { localStorage.setItem(lastPageKey(), p) } catch { /* private mode */ }
  }
  const readLastPage = (): string | undefined => {
    try { return localStorage.getItem(lastPageKey()) || undefined } catch { return undefined }
  }

  // ---- asset token(<img> 带不了 Bearer → 短时 ?at= token,ttl/2 自续) ----------
  let assetToken = ''
  let assetTimer: ReturnType<typeof setTimeout> | null = null
  async function refreshAssetToken(): Promise<void> {
    if (assetTimer) { clearTimeout(assetTimer); assetTimer = null }
    try {
      const v = await ensureVault()
      const r = await http.post<{ token: string; ttlSec: number }>(`/amadeus/vaults/${encodeURIComponent(v)}/asset-token`)
      assetToken = r.token
      const ttl = Math.max(60, r.ttlSec || 600)
      assetTimer = setTimeout(() => { void refreshAssetToken() }, (ttl / 2) * 1000)
    } catch {
      assetTimer = setTimeout(() => { void refreshAssetToken() }, 30_000) // 失败 30s 重试
    }
  }

  installCloudAssetUrls({
    apiBase: cfg.apiBase,
    vaultId: vid,
    assetToken: () => assetToken,
    activePage: () => lastLoadedPage,
  })

  // ---- SSE ------------------------------------------------------------------
  let stopEvents: (() => void) | null = null
  function startEvents(v: string): void {
    if (stopEvents) return
    stopEvents = startCloudEvents({
      url: () => `${cfg.apiBase}/amadeus/vaults/${encodeURIComponent(v)}/events?token=${encodeURIComponent(cfg.getToken())}`,
      clientId,
      knownSeq: (p) => seqMap.get(p),
      lastLoadedPage: () => lastLoadedPage,
      onPageChange: (p) => fireExternal(p),
      onDbChange: (p) => fireDb(p),
      onStructureChange: () => { invalidateTree(); fireStructure() },
    })
    window.addEventListener('beforeunload', () => { stopEvents?.() })
  }

  // ---- 文件级 REST 原语 --------------------------------------------------------
  const fileUrl = (): string => `/amadeus/vaults/${encodeURIComponent(vid())}/file`

  const getFile = async (path: string): Promise<FileDto> => {
    const f = await http.get<FileDto>(fileUrl(), { path })
    noteSeq(path, f.seq)
    return f
  }

  const putFile = async (path: string, content: string, baseSeq: number, force = false): Promise<PutResultDto> => {
    const r = await http.put<PutResultDto>(fileUrl(), { path, content, baseSeq, ...(force ? { force: true } : {}) })
    noteSeq(path, r.seq)
    return r
  }

  /** 已知 seq 用之;未知(本会话没 GET 过)先 GET 学习;404 = 创建(baseSeq 0)。 */
  const baseSeqFor = async (path: string): Promise<number> => {
    const known = seqMap.get(path)
    if (known !== undefined) return known
    try {
      const f = await getFile(path)
      return f.seq
    } catch (e) {
      if (is404(e)) return 0
      throw e
    }
  }

  // ---- 页面装载(GET + parsePageSource;404 → 编译器 newPage 语义) --------------
  const fetchAndParse = async (pagePath: string): Promise<LoadedPage> => {
    const f = await getFile(pagePath)
    return parsePageSource(pagePath, f.content, nowIso())
  }

  /** 404 时的新建:编译器 newPage + 一次性 IO(writeFile → PUT baseSeq=0)。
   *  并发撞车(409 EXISTS)→ 改为装载既有文件,绝不覆盖。 */
  const createViaCompiler = async (pagePath: string): Promise<LoadedPage> => {
    const writes: Array<{ name: string; data: string }> = []
    const io: CompilerIO = {
      readFile: async () => { throw new Error('not found') },
      writeFile: async (n, d) => { writes.push({ name: n, data: d }) },
      deleteFile: async () => { /* no-op */ },
      exists: async () => false,
      listDir: async () => [],
    }
    const page = await compilerNewPage(io, pagePath, nowIso())
    for (const w of writes) {
      const target = joinRel(dirnamePosix(pagePath), w.name)
      try {
        await putFile(target, w.data, 0)
      } catch (e) {
        if (is409(e)) return fetchAndParse(target) // 别处刚创建 → 装载现状
        throw e
      }
    }
    invalidateTree() // 新文件出现
    return page
  }

  const loadOrCreate = async (pagePath: string): Promise<LoadedPage> => {
    try {
      return await fetchAndParse(pagePath)
    } catch (e) {
      if (is404(e)) return createViaCompiler(pagePath)
      throw e
    }
  }

  // ---- ref 解析(镜像 vaultManager.resolveAttachment,树缓存替代磁盘走查) --------
  async function resolveRef(pagePath: string, ref: string): Promise<string | null> {
    const r = stripRefWrappers(ref)
    if (!r) return null
    if (r.includes('/')) {
      // 页面目录拼接 + '..' 归一化;越出 vault → null(桌面同款钳制)。
      return normalizePosix(joinRel(dirnamePosix(pagePath), safeDecode(r)))
    }
    // 裸 basename → 全库大小写不敏感搜索(树缓存);未中 → 强刷树重试一次。
    const t1 = await fetchTree()
    const hit = findByBasenameIn(allTreePaths(t1), r)
    if (hit) return hit
    const t2 = await fetchTree(true)
    return findByBasenameIn(allTreePaths(t2), r)
  }

  // ---- binary 上传 -------------------------------------------------------------
  const postBinary = async (path: string, fileName: string, bytes: Uint8Array, ifAbsent: boolean): Promise<{ path: string; size: number; seq: number }> => {
    const form = new FormData()
    form.append('file', new Blob([bytes as BlobPart]), fileName)
    form.append('path', path)
    if (ifAbsent) form.append('ifAbsent', '1')
    const r = await http.postForm<{ path: string; size: number; seq: number }>(`/amadeus/vaults/${encodeURIComponent(vid())}/binary`, form)
    noteSeq(r.path ?? path, r.seq)
    invalidateTree()
    return r
  }

  // ---- restoreVault(openVault 同体;web 无目录对话框) ---------------------------
  let assetCounter = 0
  const openCloud = async (): Promise<VaultInfo> => {
    const v = await ensureVault()
    const tree = await fetchTree(true)
    startEvents(v)
    void refreshAssetToken()
    const lp = readLastPage()
    return {
      root: `cloud://${v}`,
      pages: tree.pages,
      folders: tree.folders,
      lastPage: lp && tree.pages.includes(lp) ? lp : undefined,
    }
  }

  // ===========================================================================
  // AmadeusApi 实现
  // ===========================================================================
  return {
    openVault: () => openCloud(),
    restoreVault: () => openCloud(),

    listPages: async () => (await fetchTree()).pages,
    listFiles: async () => (await fetchTree()).files.map((f) => f.path),
    listFolders: async () => (await fetchTree()).folders,

    loadPage: async (pagePath) => {
      await ensureVault()
      const page = await loadOrCreate(pagePath)
      rememberPage(pagePath)
      return page
    },

    // 只读加载(模板等):不写 lastPage;文件不存在直接报错(只读语义不允许悄悄造文件)。
    readPage: async (pagePath) => {
      await ensureVault()
      try {
        return await fetchAndParse(pagePath)
      } catch (e) {
        if (is404(e)) throw new Error(`note not found: ${pagePath}`)
        throw e
      }
    },

    newPage: async (pagePath) => {
      await ensureVault()
      const page = await enqueue([pagePath], () => createViaCompiler(pagePath))
      rememberPage(pagePath)
      return page
    },

    savePage: (pagePath, manifest: PageManifest, contents) =>
      enqueue([pagePath], async () => {
        await ensureVault()
        const content = compile(manifest, contents)
        const base = await baseSeqFor(pagePath)
        try {
          await putFile(pagePath, content, base)
        } catch (e) {
          if (is409(e)) {
            // 云端已被别处更新(EXISTS/CONFLICT 同治):采纳服务端 seq,走既有 LWW 通道
            // (onExternalChange → pageStore.reconcileExternal 重载服务端版本)。
            const body = (e as HttpError).body as ConflictBody | null
            if (body && typeof body.seq === 'number') noteSeq(pagePath, body.seq)
            notify(CONFLICT_TOAST, true)
            // 必须晚于 pageStore.save() 的收尾 set(否则本地旧 manifest 会盖回 reconcile 结果)。
            setTimeout(() => fireExternal(pagePath), 0)
            return // savePage 正常 resolve(镜像桌面「保存不抛」体感)
          }
          if (e instanceof HttpError && e.status === 413) {
            notify('笔记过大，云端拒绝保存', true)
          }
          throw e
        }
      }),

    renamePage: (oldPath, newName, manifest: PageManifest, contents) =>
      enqueue(
        // 新旧两个 key 都占位;新名要先算 —— 与任务体内保持同一清洗逻辑。
        [oldPath, sanitizedSiblingPath(oldPath, newName, '页面名不能为空')],
        async () => {
          await ensureVault()
          const newPath = sanitizedSiblingPath(oldPath, newName, '页面名不能为空')
          if (newPath === oldPath) {
            return { newPath: oldPath, page: await fetchAndParse(oldPath) }
          }
          const tree = await fetchTree(true)
          if (allTreePaths(tree).includes(newPath) || tree.folders.includes(newPath)) throw new Error('目标页面已存在')
          // v3 单文件:先把在途编辑落到旧路径(重命名是显式用户动作 → force,桌面同款「无条件落盘再移动」)。
          const content = compile(manifest, contents)
          await putFile(oldPath, content, await baseSeqFor(oldPath), true)
          let moved: MoveResultDto
          try {
            moved = await http.post<MoveResultDto>(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: oldPath, to: newPath })
          } catch (e) {
            if (is409(e)) throw new Error('目标页面已存在')
            throw e
          }
          migrateSeq(oldPath, newPath, moved.seq)
          invalidateTree()
          rememberPage(newPath)
          const page = await fetchAndParse(newPath)
          return { newPath, page }
        },
      ),

    // 外部改动 reconcile:v3 单文件,重载即是全部(服务端即真源)。
    reconcilePage: async (pagePath) => {
      await ensureVault()
      return loadOrCreate(pagePath)
    },

    // 粘贴/拖入的图片落页面 .amadeus/ 文件夹(镜像 vaultManager.writeAsset 的命名)。
    saveAsset: async (pagePath, fileName, bytes) => {
      await ensureVault()
      const rawExt = extnamePosix(fileName)
      const ext = (rawExt || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '')
      const stem =
        basenamePosix(fileName).slice(0, basenamePosix(fileName).length - rawExt.length)
          .replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'img'
      for (let attempt = 0; attempt < 5; attempt++) {
        const unique = `${stem}-${Date.now().toString(36)}-${(assetCounter++).toString(36)}${ext || '.png'}`
        const vaultRel = normalizePosix(joinRel(dirnamePosix(pagePath), `.amadeus/${unique}`))
        if (vaultRel === null) throw new Error('Asset escapes vault')
        try {
          await postBinary(vaultRel, unique, bytes, true)
          return `.amadeus/${unique}`
        } catch (e) {
          if (is409(e)) continue // 时间戳+计数器撞车近乎不可能;真撞了换名重试
          throw e
        }
      }
      throw new Error('无法为图片分配文件名')
    },

    // 拖入附件:保留原名、撞名 -1/-2(镜像 vaultManager.writeAttachment + uniqueName)。
    saveAttachment: async (pagePath, fileName, bytes, opts) => {
      await ensureVault()
      const safeName = (basenamePosix(fileName) || 'file').replace(/[\\/]/g, '')
      const { destDirRel } = attachmentPaths(pagePath, safeName, opts)
      const tree = await fetchTree(true)
      const existing = new Set(
        allTreePaths(tree).filter((p) => dirnamePosix(p) === destDirRel).map((p) => basenamePosix(p).toLowerCase()),
      )
      let base = uniqueNameAmong(existing, safeName)
      for (let attempt = 0; attempt < 20; attempt++) {
        const { fileVaultRel, pageRel } = attachmentPaths(pagePath, base, opts)
        const clamped = normalizePosix(fileVaultRel)
        if (clamped === null) throw new Error('Asset escapes vault')
        try {
          await postBinary(clamped, base, bytes, true)
          return { pageRel, base }
        } catch (e) {
          if (is409(e)) {
            existing.add(base.toLowerCase()) // 服务端比树缓存新:占用该名再取下一个
            base = uniqueNameAmong(existing, safeName)
            continue
          }
          throw e
        }
      }
      throw new Error('无法为附件分配文件名')
    },

    // 浏览器没有「系统默认程序」:新标签页打开资源 URL(服务端给对 MIME,PDF/图片/音视频原生呈现)。
    openAttachment: async (pagePath, ref) => {
      await ensureVault()
      window.open(buildAssetUrl(stripRefWrappers(ref), pagePath), '_blank', 'noopener')
    },
    openVaultFile: async (vaultRel) => {
      await ensureVault()
      window.open(buildAssetUrl(vaultRel, null), '_blank', 'noopener')
    },

    // 渲染层已把编辑器克隆挂 #amx-print-root(@media print 只呈现它)→ 浏览器打印对话框可存 PDF。
    exportPdf: async () => {
      window.print()
      return null // null = 桌面语义的「未落盘路径」,调用方不弹「已导出」toast
    },

    onExternalChange: (cb) => { extCbs.add(cb); return () => { extCbs.delete(cb) } },
    onStructureChange: (cb) => { structCbs.add(cb); return () => { structCbs.delete(cb) } },
    onDbExternalChange: (cb) => { dbCbs.add(cb); return () => { dbCbs.delete(cb) } },

    // ---- 派生索引(服务端计算) ------------------------------------------------
    search: async (query) => {
      await ensureVault()
      return http.get<SearchHit[]>(`/amadeus/vaults/${encodeURIComponent(vid())}/search`, { q: query })
    },
    backlinks: async (pagePath) => {
      await ensureVault()
      return http.get<BacklinkRef[]>(`/amadeus/vaults/${encodeURIComponent(vid())}/backlinks`, { path: pagePath })
    },
    reindex: async () => {
      await ensureVault()
      await http.post(`/amadeus/vaults/${encodeURIComponent(vid())}/reindex`)
    },
    listTags: async () => {
      await ensureVault()
      return http.get<TagCount[]>(`/amadeus/vaults/${encodeURIComponent(vid())}/tags`)
    },
    pagesByTag: async (tag) => {
      await ensureVault()
      const r = await http.get<{ paths: string[] }>(`/amadeus/vaults/${encodeURIComponent(vid())}/tags/pages`, { tag })
      return r.paths
    },
    resolveEmbed: async (target) => {
      await ensureVault()
      const r = await http.get<EmbedResolved | null>(`/amadeus/vaults/${encodeURIComponent(vid())}/embed`, { target })
      return r ?? null
    },
    blockBacklinks: async (target) => {
      await ensureVault()
      return http.get<BacklinkRef[]>(`/amadeus/vaults/${encodeURIComponent(vid())}/block-backlinks`, { target })
    },

    // ---- 结构操作(名称清洗/文案镜像 electron ipc.ts) ---------------------------
    deletePage: (pagePath) =>
      enqueue([pagePath], async () => {
        await ensureVault()
        await http.del(fileUrl(), { path: pagePath })
        forgetSeq(pagePath)
        invalidateTree()
      }),

    movePage: (pagePath, destFolder) =>
      enqueue([pagePath], async () => {
        await ensureVault()
        const fileName = pageFileName(pagePath)
        const dstRel = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const newPath = dstRel ? `${dstRel}/${fileName}` : fileName
        if (newPath === pagePath) return pagePath
        let moved: MoveResultDto
        try {
          moved = await http.post<MoveResultDto>(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: pagePath, to: newPath })
        } catch (e) {
          if (is409(e)) throw new Error('目标位置已存在同名文件')
          throw e
        }
        migrateSeq(pagePath, newPath, moved.seq)
        invalidateTree()
        if (newPath.endsWith('.md')) rememberPage(newPath)
        return newPath
      }),

    createFolder: async (parentFolder, name) => {
      await ensureVault()
      const clean = name.trim().replace(/[\\/]/g, '')
      if (!clean) throw new Error('文件夹名不能为空')
      const parent = parentFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      try {
        const r = await http.post<{ path: string }>(`/amadeus/vaults/${encodeURIComponent(vid())}/folders`, { parent, name: clean })
        invalidateTree()
        return r.path
      } catch (e) {
        if (is409(e)) throw new Error('同名文件夹已存在')
        throw e
      }
    },

    renameFolder: async (folderPath, newName) => {
      await ensureVault()
      const clean = newName.trim().replace(/[\\/]/g, '')
      if (!clean) throw new Error('文件夹名不能为空')
      const parent = dirnamePosix(folderPath)
      const newPath = parent ? `${parent}/${clean}` : clean
      if (newPath === folderPath) return folderPath
      let r: { path: string }
      try {
        r = await http.post<{ path: string }>(`/amadeus/vaults/${encodeURIComponent(vid())}/folders/rename`, { path: folderPath, newName: clean })
      } catch (e) {
        if (is409(e)) throw new Error('同名文件夹已存在')
        throw e
      }
      migrateSeqPrefix(folderPath, r.path)
      if (lastLoadedPage && lastLoadedPage.startsWith(`${folderPath}/`)) {
        rememberPage(`${r.path}${lastLoadedPage.slice(folderPath.length)}`)
      }
      invalidateTree()
      return r.path
    },

    deleteFolder: async (folderPath) => {
      await ensureVault()
      await http.del(`/amadeus/vaults/${encodeURIComponent(vid())}/folders`, { path: folderPath })
      forgetSeqPrefix(folderPath)
      invalidateTree()
    },

    // ---- 插件 / OS 集成:web 端 no-op(渲染层 `?.` 兜底 / 明确提示) --------------
    listPlugins: async () => [],
    openPluginsFolder: async () => { notify(DESKTOP_ONLY) },
    scaffoldSamplePlugin: async () => { notify(DESKTOP_ONLY) },
    revealInFileManager: async () => { notify(DESKTOP_ONLY) },

    // ---- Database(.db) ---------------------------------------------------------
    readDatabase: async (pagePath, ref): Promise<DbReadResult> => {
      await ensureVault()
      const resolved = await resolveRef(pagePath, ref)
      if (!resolved) return { status: 'missing' }
      let f: FileDto
      try {
        f = await getFile(resolved)
      } catch (e) {
        if (is404(e)) return { status: 'missing' }
        if (e instanceof HttpError && e.status === 400) return { status: 'corrupt', path: resolved, message: '不是文本文件' }
        throw e
      }
      const r = parseDb(f.content)
      return r.ok
        ? { status: 'ok', path: resolved, data: r.data } // path = 解析后的 vault 相对路径(写回锚点)
        : { status: 'corrupt', path: resolved, message: r.error }
    },

    writeDatabase: (dbPath, data: DbFile) =>
      enqueue([dbPath], async () => {
        await ensureVault()
        const parsed = dbFileSchema.parse(data) // 防御性校验:坏数据拒写(抛给 dbStore 静默重试)
        const content = serializeDb(parsed)
        const base = await baseSeqFor(dbPath)
        try {
          await putFile(dbPath, content, base)
        } catch (e) {
          if (is409(e)) {
            // 云端更新在先:采纳服务端版本(拉新 seq),让 dbStore 经 onDbExternalChange 热重载。
            try { await getFile(dbPath) } catch { /* 拉不到就等 SSE */ }
            setTimeout(() => fireDb(dbPath), 0)
            return
          }
          throw e
        }
      }),

    // ---- 笔记视图(Bases) -------------------------------------------------------
    listPageProps: async (folder): Promise<PageProps[]> => {
      await ensureVault()
      const rows = await http.get<PagePropsDto[]>(`/amadeus/vaults/${encodeURIComponent(vid())}/page-props`, { folder })
      return rows.map((r) => ({ path: r.path, title: r.title, fm: parseFmObject(r.fmExtra || '') }))
    },

    // 外科式 frontmatter 写:客户端 RMW(GET raw → setFmExtraOnSource → PUT);409 换新基准重试一次。
    setPageFrontmatter: (pagePath, patch) =>
      enqueue([pagePath], async () => {
        await ensureVault()
        const attempt = async (): Promise<'ok' | 'conflict'> => {
          let f: FileDto
          try {
            f = await getFile(pagePath)
          } catch (e) {
            if (is404(e)) return 'ok' // 笔记已被删 → 静默跳过(桌面同款)
            throw e
          }
          const next = setFmExtraOnSource(f.content, patch)
          if (next === f.content) return 'ok'
          try {
            await putFile(pagePath, next, f.seq)
            return 'ok'
          } catch (e) {
            if (is409(e)) return 'conflict'
            throw e
          }
        }
        if ((await attempt()) === 'conflict') {
          try { await attempt() } catch { /* 第二次仍失败 → 放弃(设计如此) */ }
        }
      }),

    // 同目录纯重命名(不落 v3、外来 .md 不被收编 —— move 是纯移动,服务端不重写内容)。
    renamePageFile: (oldPath, newBaseName) =>
      enqueue([oldPath, sanitizedSiblingPath(oldPath, newBaseName, '笔记名不能为空')], async () => {
        await ensureVault()
        const newPath = sanitizedSiblingPath(oldPath, newBaseName, '笔记名不能为空')
        if (newPath === oldPath) return oldPath
        let moved: MoveResultDto
        try {
          moved = await http.post<MoveResultDto>(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: oldPath, to: newPath })
        } catch (e) {
          if (is409(e)) throw new Error('目标笔记已存在')
          throw e
        }
        migrateSeq(oldPath, newPath, moved.seq)
        invalidateTree()
        return newPath
      }),
  }
}

/** 同目录改名的路径清洗(镜像 electron ipc.ts:剥路径分隔符、去 .md 后缀、空名报错)。 */
function sanitizedSiblingPath(oldPath: string, newName: string, emptyError: string): string {
  const dir = dirnamePosix(oldPath)
  let base = newName.trim().replace(/[\\/]/g, '')
  if (!base) throw new Error(emptyError)
  if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
  return dir ? `${dir}/${base}.md` : `${base}.md`
}
