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
import { parseDrawing, withSceneJson } from '@amadeus-shared/excalidraw/format'
import { mergeScenes, type SceneLike } from '@amadeus-shared/excalidraw/reconcile'
import { parseFmObject, setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'
import type {
  AmadeusApi,
  BacklinkRef,
  DbReadResult,
  DrawingReadResult,
  EmbedResolved,
  LinkMeta,
  PageProps,
  SearchHit,
  TagCount,
  TrashEntry,
  VaultInfo,
} from '@amadeus-shared/ipc'
import { createCloudHttp, is404, is409, HttpError } from './cloudHttp'
import { startCloudEvents } from './cloudEvents'
import { pushPresence, setRoster } from './cloudPresence'
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

// ── 活动 vault(P2 共享:可以打开别人的共享库)───────────────────────────────────
/** localStorage 覆盖键:存 vault id;缺省/失效 → 自己的 default vault。 */
export const ACTIVE_VAULT_KEY = 'amadeus.cloudVaultId'

let activeVaultResolver: (() => Promise<string>) | null = null

/** 活动 vault id(与桥内 ensureVault 同源;cloudCollab 复用,勿自行解析防两套真相)。 */
export function ensureActiveVault(): Promise<string> {
  return activeVaultResolver ? activeVaultResolver() : Promise.resolve('default')
}

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
      // P2:localStorage 可指定活动 vault(含别人共享给我的);不在列表 → 可能是共享库(listVaults 只回自有),
      // 经 shared-with-me 验证后采用;仍无 → 静默回落自己的(被移出共享/失效)。
      let want: string | null = null
      try { want = localStorage.getItem(ACTIVE_VAULT_KEY) } catch { /* ignore */ }
      if (want && !r.vaults.some((x) => x.id === want)) {
        try {
          const shared = await http.get<{ items: Array<{ vaultId: string }> }>('/amadeus/shared-with-me')
          if (shared.items.some((it) => it.vaultId === want)) { vaultId = want; return want }
        } catch { /* 验证失败 → 回落自有 */ }
      }
      const v =
        (want ? r.vaults.find((x) => x.id === want) : undefined) ??
        r.vaults.find((x) => x.id === 'default') ??
        r.vaults[0]
      vaultId = v?.id ?? 'default'
      return vaultId
    })()
    vaultPromise.catch(() => { vaultPromise = null }) // 失败可重试
    return vaultPromise
  }
  activeVaultResolver = ensureVault

  // ---- 页面内容缓存(SWR:切页命中立即渲染,后台比对 seq;写路径/SSE 失效) --------
  // 高 RTT(实测 ~285ms/往返)下切回看过的页零等待。值是 parsePageSource 产物,
  // pageStore.hydrate 复制 blocks、manifest 恒不可变替换,缓存对象不会被渲染层就地篡改。
  const PAGE_CACHE_MAX = 50
  const pageCache = new Map<string, LoadedPage>()
  const cachePage = (path: string, page: LoadedPage): void => {
    pageCache.delete(path) // Map 插入序当 LRU:重插到队尾
    pageCache.set(path, page)
    if (pageCache.size > PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value as string)
  }

  // ---- path → seq(乐观并发基准;只由自己的 GET/PUT 更新) ---------------------
  const seqMap = new Map<string, number>()
  const noteSeq = (path: string, seq: number): void => { seqMap.set(path, seq) }
  const forgetSeq = (path: string): void => { seqMap.delete(path); pageCache.delete(path) }
  const migrateSeq = (from: string, to: string, seq?: number): void => {
    const s = seq ?? seqMap.get(from)
    seqMap.delete(from)
    if (s !== undefined) seqMap.set(to, s)
    pageCache.delete(from) // 缓存值内嵌 pagePath,迁移会带错路径 → 两端直接作废
    pageCache.delete(to)
  }
  const migrateSeqPrefix = (fromDir: string, toDir: string): void => {
    const fromPrefix = `${fromDir}/`
    for (const [k, v] of [...seqMap]) {
      if (k.startsWith(fromPrefix)) {
        seqMap.delete(k)
        seqMap.set(`${toDir}/${k.slice(fromPrefix.length)}`, v)
      }
    }
    for (const k of [...pageCache.keys()]) if (k.startsWith(fromPrefix)) pageCache.delete(k)
  }
  const forgetSeqPrefix = (dir: string): void => {
    const prefix = `${dir}/`
    for (const k of [...seqMap.keys()]) if (k === dir || k.startsWith(prefix)) seqMap.delete(k)
    for (const k of [...pageCache.keys()]) if (k === dir || k.startsWith(prefix)) pageCache.delete(k)
  }

  // ---- 树缓存(60s;SSE onStructureChange 即时 invalidate,写路径各自 invalidate) ----
  // 200ms 时代每次 refreshStructure 都真发 GET;失效通道齐备后放长,断线兜底最多陈旧 60s。
  const TREE_TTL_MS = 60_000
  let treeState: { at: number; promise: Promise<TreeDto>; settled: boolean } | null = null
  const invalidateTree = (): void => { treeState = null }
  async function fetchTree(force = false): Promise<TreeDto> {
    const now = Date.now()
    if (!force && treeState && (!treeState.settled || now - treeState.at < TREE_TTL_MS)) return treeState.promise
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
  /** 点开头路径段(.amadeus/.trash/.forsion-vault…)对树/搜索隐身 —— 镜像桌面主进程扫描
   *  「点目录天然跳过」语义。只滤 list* 出口;原始 tree(fetchTree)不滤,ref 解析/回收站仍可寻址。 */
  const visiblePath = (p: string): boolean => !p.split('/').some((seg) => seg.startsWith('.'))

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

  // 「同步 Vault 分区」识别:桌面开启按条目云同步时会在云端 vault 根写 <名>/.forsion-vault 标记,
  // web 据此把这些根级文件夹提升为侧边栏分区(与桌面云端侧的注册表分区对齐)。
  ;(window as unknown as { amadeusCloudVaults?: () => Promise<string[]> }).amadeusCloudVaults = async () => {
    const t = await fetchTree()
    return t.files
      .map((f) => /^([^/]+)\/\.forsion-vault$/.exec(f.path)?.[1])
      .filter((x): x is string => !!x)
      .sort()
  }

  // ---- SSE ------------------------------------------------------------------
  let stopEvents: (() => void) | null = null
  function startEvents(v: string): void {
    if (stopEvents) return
    stopEvents = startCloudEvents({
      url: () => `${cfg.apiBase}/amadeus/vaults/${encodeURIComponent(v)}/events?token=${encodeURIComponent(cfg.getToken())}`,
      clientId,
      knownSeq: (p) => seqMap.get(p),
      lastLoadedPage: () => lastLoadedPage,
      onPageChange: (p) => { pageCache.delete(p); fireExternal(p) },
      onDbChange: (p) => fireDb(p),
      // 结构事件不带明细 → 页面缓存整体作废(300ms 防抖 + 回声抑制,频率低,代价=切回多一发 GET)
      onStructureChange: () => { invalidateTree(); pageCache.clear(); fireStructure() },
      onPresence: pushPresence,
      onPresenceRoster: setRoster,
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
    pageCache.delete(path) // 单点咽喉:任何文本写(fm 外科写/画板/trash meta…)后缓存失效;savePage 随手回填
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
    const page = parsePageSource(pagePath, f.content, nowIso())
    cachePage(pagePath, page)
    return page
  }

  /** SWR 后台校验:seq 没变零动作;变了刷缓存 + 走既有 LWW 外部变更通道重载。 */
  const revalidatePage = async (pagePath: string): Promise<void> => {
    try {
      const before = seqMap.get(pagePath)
      const f = await getFile(pagePath)
      if (f.seq === before) return
      cachePage(pagePath, parsePageSource(pagePath, f.content, nowIso()))
      fireExternal(pagePath) // pageStore.reconcileExternal → reconcilePage(fetchAndParse 会再对齐缓存)
    } catch { /* 校验失败不打扰;下次真加载自会暴露 */ }
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
    cachePage(pagePath, page)
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
  const postBinary = async (path: string, fileName: string, bytes: Uint8Array, ifAbsent: boolean, onProgress?: (sent: number, total: number) => void): Promise<{ path: string; size: number; seq: number }> => {
    const form = new FormData()
    form.append('file', new Blob([bytes as BlobPart]), fileName)
    form.append('path', path)
    if (ifAbsent) form.append('ifAbsent', '1')
    const r = await http.postForm<{ path: string; size: number; seq: number }>(`/amadeus/vaults/${encodeURIComponent(vid())}/binary`, form, onProgress)
    noteSeq(r.path ?? path, r.seq)
    invalidateTree()
    return r
  }

  // ---- 回收站(.trash/ 约定,镜像桌面 vaultManager 语义:.meta.json 记原位) --------
  // server 无回收站概念:move 进 .trash/ 前缀实现;点前缀经 visiblePath 对树隐身。
  const TRASH_DIR = '.trash'
  const TRASH_META = `${TRASH_DIR}/.meta.json`
  type TrashMetaMap = Record<string, { original: string; deletedAt: number; dir: boolean }>

  const readTrashMeta = async (): Promise<{ meta: TrashMetaMap; seq: number }> => {
    try {
      const f = await getFile(TRASH_META)
      const p = JSON.parse(f.content) as unknown
      return { meta: p && typeof p === 'object' ? (p as TrashMetaMap) : {}, seq: f.seq }
    } catch (e) {
      if (is404(e)) return { meta: {}, seq: 0 }
      throw e
    }
  }
  /** RMW + 409 换新基准重试一次(setPageFrontmatter 同款;meta 只是账本,后写胜)。 */
  const updateTrashMeta = async (mut: (m: TrashMetaMap) => void): Promise<void> => {
    const first = await readTrashMeta()
    mut(first.meta)
    try {
      await putFile(TRASH_META, `${JSON.stringify(first.meta, null, 2)}\n`, first.seq)
    } catch (e) {
      if (!is409(e)) throw e
      const again = await readTrashMeta()
      mut(again.meta)
      await putFile(TRASH_META, `${JSON.stringify(again.meta, null, 2)}\n`, again.seq, true)
    }
  }

  // ---- restoreVault(openVault 同体;web 无目录对话框) ---------------------------
  let assetCounter = 0
  let iconsCache: { seq: number; icons: Record<string, string> } | null = null
  const openCloud = async (): Promise<VaultInfo> => {
    const v = await ensureVault()
    // asset token 必须赶在首屏 <img> 渲染前就位:fire-and-forget 会让早期图片 URL 缺 ?at=
    // → 401 且 <img> 不自愈。refreshAssetToken 内部全捕获永不 reject,await 无新错误路径。
    const [tree] = await Promise.all([fetchTree(true), refreshAssetToken()])
    startEvents(v)
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

    listPages: async () => (await fetchTree()).pages.filter(visiblePath),
    listFiles: async () => (await fetchTree()).files.map((f) => f.path).filter(visiblePath),
    listFolders: async () => (await fetchTree()).folders.filter(visiblePath),

    loadPage: async (pagePath) => {
      await ensureVault()
      const cached = pageCache.get(pagePath)
      if (cached) {
        rememberPage(pagePath)
        void revalidatePage(pagePath) // SWR:先渲染缓存,后台比对;高 RTT 下切回 = 零等待
        return cached
      }
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
          cachePage(pagePath, parsePageSource(pagePath, content, nowIso())) // 写后回填,切回零请求
        } catch (e) {
          if (is409(e)) {
            // 云端已被别处更新(EXISTS/CONFLICT 同治):采纳服务端 seq,走既有 LWW 通道
            // (onExternalChange → pageStore.reconcileExternal 重载服务端版本)。
            const body = (e as HttpError).body as ConflictBody | null
            if (body && typeof body.seq === 'number') noteSeq(pagePath, body.seq)
            pageCache.delete(pagePath) // 服务端为准,reconcile 会重拉
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
    saveAsset: async (pagePath, fileName, bytes, onProgress) => {
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
          await postBinary(vaultRel, unique, bytes, true, onProgress)
          return `.amadeus/${unique}`
        } catch (e) {
          if (is409(e)) continue // 时间戳+计数器撞车近乎不可能;真撞了换名重试
          throw e
        }
      }
      throw new Error('无法为图片分配文件名')
    },

    // 拖入附件:保留原名、撞名 -1/-2(镜像 vaultManager.writeAttachment + uniqueName)。
    saveAttachment: async (pagePath, fileName, bytes, opts, onProgress) => {
      await ensureVault()
      const safeName = (basenamePosix(fileName) || 'file').replace(/[\\/]/g, '')
      const { destDirRel } = attachmentPaths(pagePath, safeName, opts)
      const tree = await fetchTree(true)
      const existing = new Set(
        allTreePaths(tree).filter((p) => dirnamePosix(p) === destDirRel).map((p) => basenamePosix(p).toLowerCase()),
      )
      let base = uniqueNameAmong(existing, safeName)
      // .db/.md 是文本文件:server kindForPath 按扩展名分 kind,binary 通道会被拒 → 走文本 PUT(seq 0 = 仅创建)。
      const isText = /\.(db|md)$/i.test(safeName)
      for (let attempt = 0; attempt < 20; attempt++) {
        const { fileVaultRel, pageRel } = attachmentPaths(pagePath, base, opts)
        const clamped = normalizePosix(fileVaultRel)
        if (clamped === null) throw new Error('Asset escapes vault')
        try {
          if (isText) await putFile(clamped, new TextDecoder().decode(bytes), 0)
          else await postBinary(clamped, base, bytes, true, onProgress)
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

    moveFolder: async (folderPath, destFolder) => {
      await ensureVault()
      const src = folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const name = basenamePosix(src)
      if (!name) throw new Error('文件夹路径不能为空')
      const dst = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const newPath = dst ? `${dst}/${name}` : name
      if (newPath === src) return src
      if (dst === src || dst.startsWith(`${src}/`)) throw new Error('不能移动到自身内部')
      let r: { path: string }
      try {
        r = await http.post<{ path: string }>(`/amadeus/vaults/${encodeURIComponent(vid())}/folders/move`, { path: src, dest: dst })
      } catch (e) {
        if (is409(e)) throw new Error('目标位置已存在同名文件夹')
        throw e
      }
      migrateSeqPrefix(src, r.path)
      if (lastLoadedPage && lastLoadedPage.startsWith(`${src}/`)) {
        rememberPage(`${r.path}${lastLoadedPage.slice(src.length)}`)
      }
      invalidateTree()
      return r.path
    },

    // ---- 回收站(五件套;树/搜索经 visiblePath 对 .trash 免疫,同桌面点目录语义) ----
    trashEntry: async (rel) => {
      await ensureVault()
      const norm = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      if (!norm || norm === TRASH_DIR || norm.startsWith(`${TRASH_DIR}/`)) throw new Error('无效路径')
      const tree = await fetchTree(true)
      const isDir = tree.folders.includes(norm)
      const stamp = Date.now().toString(36)
      if (isDir) {
        // folders/move 只保持 basename(server 无「移动即改名」)→ 撞名先原地改唯一名再移。
        let src = norm
        let base = basenamePosix(norm)
        if (tree.folders.includes(`${TRASH_DIR}/${base}`)) {
          const r = await http.post<{ path: string }>(`/amadeus/vaults/${encodeURIComponent(vid())}/folders/rename`, { path: norm, newName: `${base} (${stamp})` })
          src = r.path
          base = basenamePosix(r.path)
        }
        await http.post(`/amadeus/vaults/${encodeURIComponent(vid())}/folders/move`, { path: src, dest: TRASH_DIR })
        forgetSeqPrefix(norm)
        await updateTrashMeta((m) => { m[base] = { original: norm, deletedAt: Date.now(), dir: true } })
      } else {
        // 文件一步 move(.trash 父目录由服务端物化);扁平名防嵌套路径,撞名带时间戳前缀。
        let name = norm.replace(/\//g, '__')
        if (allTreePaths(tree).includes(`${TRASH_DIR}/${name}`)) name = `${stamp}-${name}`
        await http.post(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: norm, to: `${TRASH_DIR}/${name}` })
        forgetSeq(norm)
        await updateTrashMeta((m) => { m[name] = { original: norm, deletedAt: Date.now(), dir: false } })
      }
      invalidateTree()
    },

    listTrash: async (): Promise<TrashEntry[]> => {
      await ensureVault()
      const { meta } = await readTrashMeta()
      // 与实存对齐(另一端可能已恢复/清空):树里 .trash 下还在的才列。
      const tree = await fetchTree()
      const present = new Set<string>()
      for (const p of [...allTreePaths(tree), ...tree.folders]) {
        if (p.startsWith(`${TRASH_DIR}/`)) present.add(p.slice(TRASH_DIR.length + 1).split('/')[0])
      }
      return Object.entries(meta)
        .filter(([name]) => present.has(name))
        .map(([name, v]) => ({ name, original: v.original, deletedAt: v.deletedAt, dir: v.dir }))
        .sort((a, b) => b.deletedAt - a.deletedAt)
    },

    restoreTrash: async (name) => {
      await ensureVault()
      const { meta } = await readTrashMeta()
      const rec = meta[name]
      if (!rec) throw new Error('回收站条目不存在')
      const tree = await fetchTree(true)
      const taken = (p: string): boolean => allTreePaths(tree).includes(p) || tree.folders.includes(p)
      // 原位被占 → 占位加 " (N)"(桌面同款;文件夹整名加,文件在扩展名前加)。
      let target = rec.original
      for (let n = 2; taken(target); n++) {
        if (rec.dir) target = `${rec.original} (${n})`
        else {
          const ext = extnamePosix(rec.original)
          target = `${rec.original.slice(0, rec.original.length - ext.length)} (${n})${ext}`
        }
      }
      if (rec.dir) {
        // folders/move 保持 basename → 必要时先在 .trash 内改成目标名再移到目标父目录。
        let src = `${TRASH_DIR}/${name}`
        const wantBase = basenamePosix(target)
        if (basenamePosix(src) !== wantBase) {
          const r = await http.post<{ path: string }>(`/amadeus/vaults/${encodeURIComponent(vid())}/folders/rename`, { path: src, newName: wantBase })
          src = r.path
        }
        await http.post(`/amadeus/vaults/${encodeURIComponent(vid())}/folders/move`, { path: src, dest: dirnamePosix(target) })
      } else {
        await http.post(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: `${TRASH_DIR}/${name}`, to: target })
      }
      await updateTrashMeta((m) => { delete m[name] })
      invalidateTree()
      return target
    },

    deleteTrashEntry: async (name) => {
      await ensureVault()
      const { meta } = await readTrashMeta()
      if (meta[name]?.dir) {
        await http.del(`/amadeus/vaults/${encodeURIComponent(vid())}/folders`, { path: `${TRASH_DIR}/${name}` }).catch((e) => { if (!is404(e)) throw e })
      } else {
        await http.del(fileUrl(), { path: `${TRASH_DIR}/${name}` }).catch((e) => { if (!is404(e)) throw e })
      }
      await updateTrashMeta((m) => { delete m[name] })
      invalidateTree()
    },

    emptyTrash: async () => {
      await ensureVault()
      await http.del(`/amadeus/vaults/${encodeURIComponent(vid())}/folders`, { path: TRASH_DIR }).catch((e) => { if (!is404(e)) throw e })
      forgetSeqPrefix(TRASH_DIR)
      invalidateTree()
    },

    // ---- 字节读写(PDF 批注写回 / 阅读器 getDocument({data})) --------------------
    // binary 端点按扩展名分 kind,文本类(.md/.db)会被拒 —— web 消费面只有二进制(PDF),够用。
    saveVaultBytes: async (vaultRel, bytes) => {
      await ensureVault()
      const norm = normalizePosix(vaultRel.replace(/\\/g, '/'))
      if (!norm) throw new Error('路径越出 vault')
      await postBinary(norm, basenamePosix(norm), bytes, false) // 无 ifAbsent = 原地覆盖
    },
    readVaultBytes: async (vaultRel) => {
      const v = await ensureVault()
      const r = await fetch(
        `${cfg.apiBase}/amadeus/vaults/${encodeURIComponent(v)}/asset?path=${encodeURIComponent(vaultRel)}`,
        { headers: { Authorization: `Bearer ${cfg.getToken()}` } }, // assetAuth 收 Bearer 主 token,无需等 asset-token
      )
      if (!r.ok) throw new Error(`读取文件失败(HTTP ${r.status})`)
      return new Uint8Array(await r.arrayBuffer())
    },

    // ---- 书签卡 / 封面图搜索 -----------------------------------------------------
    // 浏览器抓任意网页必撞 CORS → og 元数据走 server 代理;失败一律 null(渲染端降级纯链接卡,桌面同款)。
    fetchLinkMeta: async (url) => {
      try {
        return await http.get<LinkMeta | null>('/amadeus/link-meta', { url })
      } catch {
        return null
      }
    },
    // Openverse 公开 API 自带 CORS,浏览器直连(桌面 linkMeta.ts 的精简版:无进程内缓存,失败即抛)。
    searchImages: async (query) => {
      const q = query.trim()
      if (!q) return []
      const res = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=20`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`openverse HTTP ${res.status}`)
      const j = (await res.json()) as { results?: Array<{ thumbnail?: string; url?: string; creator?: string }> }
      return (j.results ?? [])
        .map((r) => ({ thumb: r.thumbnail ?? '', full: r.url ?? '', author: r.creator }))
        .filter((x) => x.thumb && x.full)
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

    // ---- Excalidraw 画板(.excalidraw.md;解析/序列化是渲染端纯函数,这里只搬文本) ----
    readDrawing: async (pagePath, ref): Promise<DrawingReadResult> => {
      await ensureVault()
      // Obsidian 链接省略 .md:`![[Foo.excalidraw]]` 实指 Foo.excalidraw.md → 原样先试,落空补 .md(桌面同款)。
      const resolved = (await resolveRef(pagePath, ref)) ?? (await resolveRef(pagePath, `${ref}.md`))
      if (!resolved) return { status: 'missing' }
      for (const candidate of resolved.endsWith('.md') ? [resolved] : [resolved, `${resolved}.md`]) {
        try {
          const f = await getFile(candidate)
          return { status: 'ok', path: candidate, source: f.content }
        } catch (e) {
          if (!is404(e)) throw e
        }
      }
      return { status: 'missing' }
    },
    writeDrawing: (drawingPath, source) =>
      enqueue([drawingPath], async () => {
        await ensureVault()
        const base = await baseSeqFor(drawingPath)
        try {
          await putFile(drawingPath, source, base)
        } catch (e) {
          // 真并发(drawingStore 写前已预读,剩毫秒窗):拉服务端最新,元素级合并后按新 seq 重写
          // —— 不同元素无损并集、同元素 version 高者胜;解析不出(坏档)才回落「后写胜」强写。
          if (!is409(e)) throw e
          try {
            const f = await getFile(drawingPath) // noteSeq 顺带对齐
            const mine = parseDrawing(source)
            const theirs = parseDrawing(f.content)
            const mineScene = mine ? (JSON.parse(mine.sceneJson) as SceneLike) : null
            const theirScene = theirs ? (JSON.parse(theirs.sceneJson) as SceneLike) : null
            if (mineScene && theirScene) {
              const next = withSceneJson(f.content, JSON.stringify(mergeScenes(mineScene, theirScene)))
              if (next) {
                await putFile(drawingPath, next, f.seq)
                return
              }
            }
          } catch {
            /* 合并失败 → 强写兜底 */
          }
          const body = (e as HttpError).body as ConflictBody | null
          if (body && typeof body.seq === 'number') noteSeq(drawingPath, body.seq)
          await putFile(drawingPath, source, seqMap.get(drawingPath) ?? 0, true)
        }
      }),

    // ---- 笔记视图(Bases) -------------------------------------------------------
    listPageProps: async (folder): Promise<PageProps[]> => {
      await ensureVault()
      const rows = await http.get<PagePropsDto[]>(`/amadeus/vaults/${encodeURIComponent(vid())}/page-props`, { folder })
      return rows.map((r) => ({ path: r.path, title: r.title, fm: parseFmObject(r.fmExtra || '') }))
    },

    // 页面 emoji 图标表:page-props 的全库形态(all=1)+ 渲染端抠 fm icon 键(桌面=索引供给,这里按需拉)。
    // refreshStructure 每次都调它 → 用 vault seq 做门:库没变(树缓存/SSE 同源)直接回上次结果,
    // 免掉结构事件风暴里的反复全库 payload。
    pageIcons: async () => {
      await ensureVault()
      const t = await fetchTree()
      if (iconsCache && iconsCache.seq === t.seq) return iconsCache.icons
      const rows = await http.get<PagePropsDto[]>(`/amadeus/vaults/${encodeURIComponent(vid())}/page-props`, { folder: '', all: '1' })
      const out: Record<string, string> = {}
      for (const r of rows) {
        const icon = parseFmObject(r.fmExtra || '').icon
        if (typeof icon === 'string' && icon) out[r.path] = icon
      }
      iconsCache = { seq: t.seq, icons: out }
      return out
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

    // ponytail: 云端只做移动(服务端 move 保文件 id);桌面版的 title 同步 + 全库引用重写暂缺,
    // 裸名 ![[库名]] 引用靠服务端 basename 兜底仍可解析,带路径引用会断 —— 要补齐做服务端 renameDb 端点。
    renameDbFile: (oldPath, newBaseName) =>
      enqueue([oldPath], async () => {
        await ensureVault()
        const norm = oldPath.replace(/\\/g, '/')
        let base = newBaseName.trim().replace(/[\\/]/g, '')
        if (base.toLowerCase().endsWith('.db')) base = base.slice(0, -3)
        if (!base) throw new Error('名称不能为空')
        const dir = dirnamePosix(norm)
        const newPath = dir ? `${dir}/${base}.db` : `${base}.db`
        if (newPath === norm) return { newPath, rewrittenPages: [] }
        let moved: MoveResultDto
        try {
          moved = await http.post<MoveResultDto>(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: norm, to: newPath })
        } catch (e) {
          if (is409(e)) throw new Error('目标文件已存在')
          throw e
        }
        migrateSeq(norm, newPath, moved.seq)
        invalidateTree()
        return { newPath, rewrittenPages: [] }
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
