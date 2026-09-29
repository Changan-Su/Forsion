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
import { contentStorageKey } from '@lcl/engine/contentStorageScope'
import { cloudVaultNamesFrom } from '@amadeus-shared/entrySync'
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
  PathGoneEvent,
  SearchHit,
  TagCount,
  TextWriteResult,
  TrashEntry,
  VaultInfo,
} from '@amadeus-shared/ipc'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { resolvePageName, stripForIndex } from '@amadeus-shared/links'
import { sliceEmbedSubpath, splitNoteEmbed } from '@amadeus-shared/noteEmbed'
import { findEmbedBlock } from './shareBridge'
import { propagateNoteRenames, queueStructureOps } from '@amadeus-shared/propagateNoteRenames'
import { toastRenameRewriteFailed } from '@/amadeus/lib/renameLinksToast'
import { createCloudHttp, is404, is409, HttpError } from './cloudHttp'
import { startCloudEvents } from './cloudEvents'
import { unifiedPaths } from '@/amadeus/unified/lifecycle'
import { pushPresence, setRoster } from './cloudPresence'
import { buildAssetUrl, installCloudAssetUrls } from './cloudAssets'
import { translate } from '@/i18n'
import '@/amadeus/lib/bridgeMessages' // amxbridge.* 文案(G2-14)
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
interface TreeDto { pages: string[]; files: Array<{ path: string; size: number }>; folders: string[]; seq: number; maxFileBytes?: number }
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
  request?(path: string, init?: RequestInit): Promise<Response>
  signal?: AbortSignal
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
  // Capture once: callbacks from an older bridge must only update its own account's cache.
  const activeVaultKey = contentStorageKey(ACTIVE_VAULT_KEY)
  const TREE_SNAP_KEY = contentStorageKey('amadeus_tree_snap')
  const LAST_PAGE_KEY = contentStorageKey('amadeus_last_page')
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
    request: cfg.request,
    signal: cfg.signal,
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
      try { want = localStorage.getItem(activeVaultKey) } catch { /* ignore */ }
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
  if (cfg.signal) setRoster([])

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
  /** 本端经 GET/PUT 最后见到的内容指纹(textFingerprint),连同当时的 seq。**只在 seq 与 seqMap 对得上时可信**
   *  (seq 被迁移 / 别的途径推进过就当不知道,由调用方重新拉)。writeTextFile 的比对交换写(base)靠它认出
   *  「seq 是新的、调用方的基线却是旧的」—— 同端两个实例 / 一次 GET 推进了 seq 而编辑器还没回灌,服务端不会 409。 */
  const seqFp = new Map<string, { seq: number; fp: string }>()
  const knownFp = (path: string, seq: number): string | undefined => {
    const e = seqFp.get(path)
    return e && e.seq === seq && seqMap.get(path) === seq ? e.fp : undefined
  }
  /** 本会话从服务端拿到过 seq 的路径。只由**本端**的删除/改名(forgetSeq/migrateSeq)清掉,别处的删除不清。
   *  用途:自动保存撞上 404 时区分「新文件」与「别处删掉了」—— 后者绝不能按 baseSeq 0 重建。
   *  2026-09-05 幽灵旧名空白页的真因:桌面把 A 改名成 B 后,手机端开着 A 的编辑器一保存,
   *  baseSeqFor(A) 404 → 0 → 把 A 重新造出来;桌面删一次它造一次。 */
  const everKnown = new Set<string>()
  /** 别处改名/移走:旧路径 → 新路径(SSE move 明细)。写到旧路径的自动保存改投新路径。 */
  const movedTo = new Map<string, string>()
  /** 已提示过「别处删了/挪了」的路径,免得每次防抖保存都弹一条。 */
  const vanishedToasted = new Set<string>()
  class VanishedError extends Error { constructor(readonly path: string) { super(`vanished elsewhere: ${path}`) } }
  const noteSeq = (path: string, seq: number): void => { seqMap.set(path, seq); everKnown.add(path); movedTo.delete(path) }
  const forgetSeq = (path: string): void => { seqMap.delete(path); pageCache.delete(path); everKnown.delete(path) }
  const migrateSeq = (from: string, to: string, seq?: number): void => {
    const s = seq ?? seqMap.get(from)
    seqMap.delete(from) // everKnown(from) **保留**:旧路径此后 404 = 挪走了,任何打开/回灌都不许当新文件重建
    if (s !== undefined) { seqMap.set(to, s); everKnown.add(to) }
    pageCache.delete(from) // 缓存值内嵌 pagePath,迁移会带错路径 → 两端直接作废
    pageCache.delete(to)
  }
  /** 自动保存的落点:别处挪走了 → 跟到新路径;别处删了 → 抛 VanishedError(调用方提示 + 不写)。 */
  const writeTargetFor = async (path: string): Promise<{ target: string; base: number }> => {
    const target = resolveMoved(path)
    if (target !== path && !vanishedToasted.has(path)) {
      vanishedToasted.add(path)
      notify(translate('amxbridge.renamedElsewhere', { name: target.split('/').pop() }))
    }
    return { target, base: await baseSeqFor(target) }
  }
  const noteVanished = (path: string): void => {
    if (vanishedToasted.has(path)) return
    vanishedToasted.add(path)
    notify(translate('amxbridge.deletedElsewhere'), true)
  }
  /** 别名链跟到底(A→B→C;有环/超长即止)。 */
  const resolveMoved = (path: string): string => {
    let cur = path
    const seen = new Set<string>([path])
    for (let i = 0; i < 16; i++) {
      const next = movedTo.get(cur)
      if (!next || seen.has(next)) break
      seen.add(next)
      cur = next
    }
    return cur
  }
  /** 写队列锁键:旧路径与其别名落点共用一把锁 —— 否则旧编辑器按 A 排队、新编辑器按 B 排队,实际都写 B,
   *  同一 baseSeq 并发 PUT,一方 409 丢改动(Codex 终审 P0)。 */
  const keysFor = (path: string): string[] => {
    const t = resolveMoved(path)
    return t === path ? [path] : [path, t]
  }
  /** 目标被删/复用时清掉所有指向它的别名:旧编辑器此后按自己的路径 404 → vanished,不会写进复用者。 */
  const dropAliasesTo = (target: string): void => {
    for (const k of [...movedTo.keys()]) if (resolveMoved(k) === target) movedTo.delete(k) // 整条上游链(A→B→C 删 C 也清 A)
  }
  /** 落点锁:入队时按当时的别名取锁,任务真正跑时别名可能已变(排队期间收到 A→B)。目标不在手里的锁里
   *  → 再按目标排一次队,否则与 B 的编辑器同 baseSeq 并发 PUT(Codex 终审 P0)。 */
  const underTarget = <T,>(held: string[], target: string, fn: () => Promise<T>): Promise<T> =>
    held.includes(target) ? fn() : enqueue([target], fn)
  /** 别处删掉了、本端还有未保存正文:另存为「X (recovered 日期 时分).md」,此后这个编辑器的保存都落到那份
   *  (别名)。不按原路径重建 —— 那就是用户报的「删了还会出现」;空白正文没什么可保,提示后放弃。 */
  const recoverVanished = async (path: string, text: string, meaningful: boolean): Promise<string | null> => {
    if (!meaningful) { noteVanished(path); return null }
    const d = new Date()
    const two = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}`
    const stem = path.replace(/\.md$/i, '')
    for (let n = 0; n < 5; n++) {
      const rp = `${stem} (recovered ${stamp}${n ? `-${n + 1}` : ''}).md`
      try {
        await putFile(rp, text, 0)
      } catch (e) {
        if (is409(e)) continue // 同名已存在(同一分钟第二次)→ 换后缀
        throw e
      }
      movedTo.set(path, rp)
      invalidateTree()
      if (!vanishedToasted.has(path)) {
        vanishedToasted.add(path)
        notify(translate('amxbridge.deletedElsewhereSaved', { name: rp.split('/').pop() }), true)
      }
      return rp
    }
    // 同一分钟五个候选都撞了:抛错让调用方保留脏状态(返回 null 会被当成保存成功,草稿随卸载丢失)。
    noteVanished(path)
    throw new VanishedError(path)
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
    // 前缀下见过的路径:新路径也算见过,旧路径记别名 —— 否则文件夹改名后旧路径的编辑器一保存就按 404→0 重建。
    for (const k of [...everKnown]) {
      if (!k.startsWith(fromPrefix) || movedTo.has(k)) continue // 已别名到别处的旧路径(docs/A→other/B)不许被前缀迁移改指
      const nk = `${toDir}/${k.slice(fromPrefix.length)}`
      everKnown.add(nk)
      movedTo.set(k, nk)
    }
  }
  const forgetSeqPrefix = (dir: string): void => {
    const prefix = `${dir}/`
    for (const k of [...seqMap.keys()]) if (k === dir || k.startsWith(prefix)) seqMap.delete(k)
    for (const k of [...pageCache.keys()]) if (k === dir || k.startsWith(prefix)) pageCache.delete(k)
    for (const k of [...everKnown]) if (k === dir || k.startsWith(prefix)) { everKnown.delete(k); dropAliasesTo(k) } // 本端删的文件夹:同名可重建
  }
  /** 别处删了整个文件夹:前缀下 seq/缓存作废、指向它们的别名清掉,everKnown 保留(不许按旧路径重建)。 */
  const vanishPrefix = (dir: string): void => {
    const prefix = `${dir}/`
    for (const k of [...seqMap.keys()]) if (k === dir || k.startsWith(prefix)) { seqMap.delete(k); pageCache.delete(k); dropAliasesTo(k) }
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
      (t) => {
        entry.settled = true
        saveTreeSnap(v, t) // 顺手落快照:冷启动 SWR 的数据源
        // 本库二进制单文件上限(属主会员档位):amadeusImport 的上传预检读它,省一趟注定 413 的大上传
        ;(window as unknown as { amadeusCloudMaxFileBytes?: number }).amadeusCloudMaxFileBytes = t.maxFileBytes
      },
      () => { if (treeState === entry) treeState = null }, // 失败不缓存
    )
    return entry.promise
  }
  // ---- 树的 localStorage 快照(冷启动 SWR:先渲染上次的树,真启动后台跑) ----------
  // 单 blob 含 vault id;每次 fetchTree 成功即覆盖。陈旧窗口=到 revalidate 完成的几秒;
  // 期间点开远端已删的笔记会 create-on-open 复活它(与 wikilink 点击建页同语义,接受的天花板)。
  const saveTreeSnap = (v: string, tree: TreeDto): void => {
    try { localStorage.setItem(TREE_SNAP_KEY, JSON.stringify({ v, tree })) } catch { /* 配额/私有模式 */ }
  }
  const readTreeSnap = (): { v: string; tree: TreeDto } | null => {
    try {
      const raw = localStorage.getItem(TREE_SNAP_KEY)
      if (!raw) return null
      const blob = JSON.parse(raw) as { v?: unknown; tree?: { pages?: unknown; files?: unknown; folders?: unknown } }
      if (typeof blob.v !== 'string' || !blob.tree || !Array.isArray(blob.tree.pages) || !Array.isArray(blob.tree.files) || !Array.isArray(blob.tree.folders)) return null
      const want = localStorage.getItem(activeVaultKey)
      if (want && want !== blob.v) return null // 刚切过库:旧库快照不认
      return blob as { v: string; tree: TreeDto }
    } catch { return null }
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
  /** 别处改名 / 挪走(评审 G2-03):交给 pageStore 的 onPathGone —— 退休旧路径的 v4 实例(未落盘的字存成新路径的草稿)、
   *  标签改指新路径。不转的话开着旧路径的编辑器成僵尸:保存经 movedTo 改投新路径,回灌却只认旧路径、永远落空。 */
  const pathGoneCbs = new Set<(e: PathGoneEvent) => void>()
  const firePathGone = (e: PathGoneEvent): void => { for (const cb of [...pathGoneCbs]) { try { cb(e) } catch { /* 同上 */ } } }

  // ---- lastPage(localStorage,按 vault 分键)+ 资源 URL 的活动页基准 ------------
  let lastLoadedPage: string | null = null
  const lastPageKey = (vault = vid()): string => `${LAST_PAGE_KEY}:${vault}`
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
    if (cfg.signal?.aborted) return
    if (assetTimer) { clearTimeout(assetTimer); assetTimer = null }
    try {
      const v = await ensureVault()
      const r = await http.post<{ token: string; ttlSec: number }>(`/amadeus/vaults/${encodeURIComponent(v)}/asset-token`)
      if (cfg.signal?.aborted) return
      assetToken = r.token
      const ttl = Math.max(60, r.ttlSec || 600)
      assetTimer = setTimeout(() => { void refreshAssetToken() }, (ttl / 2) * 1000)
    } catch {
      if (!cfg.signal?.aborted) assetTimer = setTimeout(() => { void refreshAssetToken() }, 30_000) // 失败 30s 重试
    }
  }

  installCloudAssetUrls({
    apiBase: cfg.apiBase,
    vaultId: vid,
    assetToken: () => assetToken,
    activePage: () => lastLoadedPage,
  })

  // 「同步 Vault 分区」识别:桌面开启按条目云同步时会在云端 vault 根写标记文件(见 CLOUD_VAULT_MARKER),
  // web/移动端据此把这些根级文件夹提升为侧边栏分区(与桌面云端侧的注册表分区对齐)。
  // 标记是 .md → 落在 tree 的 pages 里;files 也扫一遍,兼容将来换扩展名。
  ;(window as unknown as { amadeusCloudVaults?: () => Promise<string[]> }).amadeusCloudVaults = async () => {
    const t = await fetchTree()
    return cloudVaultNamesFrom([...t.pages, ...t.files.map((f) => f.path)])
  }

  // ---- SSE ------------------------------------------------------------------
  let stopEvents: (() => void) | null = null
  cfg.signal?.addEventListener('abort', () => {
    if (assetTimer) clearTimeout(assetTimer)
    assetTimer = null
    assetToken = ''
    stopEvents?.()
    stopEvents = null
    if (activeVaultResolver === ensureVault) { activeVaultResolver = null; setRoster([]) }
  }, { once: true })
  function startEvents(v: string): void {
    if (stopEvents || cfg.signal?.aborted) return
    stopEvents = startCloudEvents({
      signal: cfg.signal,
      url: () => `${cfg.apiBase}/amadeus/vaults/${encodeURIComponent(v)}/events?token=${encodeURIComponent(cfg.getToken())}`,
      clientId,
      knownSeq: (p) => seqMap.get(p),
      lastLoadedPage: () => lastLoadedPage,
      // 兜底补课(服务端 reset)连开着的 v4 笔记一起回灌:它们主要经 readTextFile 打开,不保证设 lastLoadedPage
      // (web 原地分支会设,移动端单列导航 / 分屏其余实例不设;评审 G2-01)。
      openPages: unifiedPaths,
      onPageChange: (p) => { pageCache.delete(p); fireExternal(p) },
      onDbChange: (p) => fireDb(p),
      // 别处改名:seq 随路径迁移,旧路径记「已挪走」→ 开着旧路径的编辑器下一次保存跟到新路径,而不是
      // 按旧路径 404→baseSeq 0 把旧名文件重新造出来。别处删除:忘掉 seq 但**留着** everKnown,
      // 使 baseSeqFor 对它抛 VanishedError 而不是当新文件创建。
      // 账先记(seq 迁到新路径)再转给编辑器:新路径上挂起来的实例一读就是对的基线。
      onPageMoved: (from, to, seq, own) => {
        movedTo.set(from, to)
        migrateSeq(from, to, seq ?? undefined)
        if (!own) firePathGone({ from, kind: 'file', to, root: `cloud://${v}` })
      },
      onPageDeleted: (p) => { seqMap.delete(p); pageCache.delete(p); dropAliasesTo(p) },
      onFolderMoved: (from, to, own) => {
        migrateSeqPrefix(from, to)
        if (!own) firePathGone({ from, kind: 'prefix', to, root: `cloud://${v}` })
      },
      onFolderDeleted: (dir) => vanishPrefix(dir),
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
    seqFp.set(path, { seq: f.seq, fp: textFingerprint(f.content) })
    return f
  }

  const putFile = async (path: string, content: string, baseSeq: number, force = false): Promise<PutResultDto> => {
    const r = await http.put<PutResultDto>(fileUrl(), { path, content, baseSeq, ...(force ? { force: true } : {}) })
    noteSeq(path, r.seq)
    seqFp.set(path, { seq: r.seq, fp: textFingerprint(content) })
    pageCache.delete(path) // 单点咽喉:任何文本写(fm 外科写/画板/trash meta…)后缓存失效;savePage 随手回填
    return r
  }

  /** 已知 seq 用之;未知(本会话没 GET 过)先 GET 学习;404 = 创建(baseSeq 0)——
   *  **除非**本会话见过这个路径(everKnown):那是别处删掉/挪走了,抛 VanishedError,绝不重建。 */
  const baseSeqFor = async (path: string): Promise<number> => {
    const known = seqMap.get(path)
    if (known !== undefined) return known
    try {
      const f = await getFile(path)
      return f.seq
    } catch (e) {
      if (!is404(e)) throw e
      if (everKnown.has(path)) throw new VanishedError(path)
      return 0
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

  /** 「打开即创建」只对本会话从未见过的路径成立:见过(everKnown)、现 404 = 别处删掉/挪走了,抛 VanishedError。
   *  否则陈旧标签页/后退/reconcilePage 都会把刚删的页原样造回云端;显式新建走 newPage,不受此限。 */
  const loadOrCreate = async (pagePath: string): Promise<LoadedPage> => {
    try {
      return await fetchAndParse(pagePath)
    } catch (e) {
      if (is404(e)) {
        if (everKnown.has(pagePath)) throw new VanishedError(pagePath)
        return createViaCompiler(pagePath)
      }
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
    // 冷启动 SWR:有上次的树快照就立即上屏(高 RTT 下工作区秒开,「加载半天」的正解),
    // 真启动(vault 解析/强刷树/asset token/SSE)后台原序照跑,fireStructure 把新树推给
    // pageStore.refreshStructure 刷新。天花板:ACTIVE_VAULT_KEY 指向的共享库被吊销时,
    // 后台会回落自有库而快照 root 停留旧库,刷新页面即自愈 —— 不为罕见路径加状态机。
    const snap = readTreeSnap()
    if (snap) {
      // asset token 仍须赶在首屏 <img> 前就位(embedImage 的 URL memo 不随 token 自愈,评审 P1):
      // await 它(内部 ensureVault + POST,永不 reject)。树拉取/SSE 留在后台 —— 快照路径省的是树。
      await refreshAssetToken()
      void (async () => {
        // startEvents 全会话只有这一次机会(restoreVault 被 amadeusBooted 门闩住)→ 失败必须重试,
        // 三次退避仍失败才 toast(评审 P2:此前静默吞错=实时同步整会话失联且用户无感知)。
        for (let attempt = 0; ; attempt++) {
          if (cfg.signal?.aborted) return
          try {
            const v = await ensureVault()
            await fetchTree(true)
            startEvents(v)
            fireStructure()
            return
          } catch {
            if (cfg.signal?.aborted) return
            if (attempt >= 2) { notify(translate('amxbridge.connectFailed'), true); return }
            await new Promise<void>((resolve) => {
              const done = () => { clearTimeout(timer); cfg.signal?.removeEventListener('abort', done); resolve() }
              const timer = setTimeout(done, [3000, 10000][attempt])
              cfg.signal?.addEventListener('abort', done, { once: true })
              if (cfg.signal?.aborted) done()
            })
          }
        }
      })()
      let lp: string | undefined
      try { lp = localStorage.getItem(lastPageKey(snap.v)) || undefined } catch { /* ignore */ }
      const pages = snap.tree.pages.filter(visiblePath)
      return {
        root: `cloud://${snap.v}`,
        pages,
        folders: snap.tree.folders.filter(visiblePath),
        lastPage: lp && pages.includes(lp) ? lp : undefined,
      }
    }
    const v = await ensureVault()
    // asset token 必须赶在首屏 <img> 渲染前就位:fire-and-forget 会让早期图片 URL 缺 ?at=
    // → 401 且 <img> 不自愈。refreshAssetToken 内部全捕获永不 reject,await 无新错误路径。
    const [tree] = await Promise.all([fetchTree(true), refreshAssetToken()])
    startEvents(v)
    const lp = readLastPage()
    // 与 listPages/listFolders 同一把 visiblePath 尺子:首屏这份载荷直接进 pageStore.pages,
    // 不滤的话 .trash/ 里的笔记与库标记会当成真笔记出现在树里(桌面主进程那侧本就滤)。
    const pages = tree.pages.filter(visiblePath)
    return {
      root: `cloud://${v}`,
      pages,
      folders: tree.folders.filter(visiblePath),
      lastPage: lp && pages.includes(lp) ? lp : undefined,
    }
  }

  // ---- 改名 / 移动之后的全库 [[链接]] 重写(评审 G2-04;桌面 = 主进程 vaultHandlers.propagateRenames)----
  // 三端行为此前不一致:桌面改名会重写引用,web 只做纯移动 → 所有引用断链、点进去新建一篇空笔记。
  // 判定照 shared/rewriteNoteRefs;写走下面的 updateExisting(比对交换 + 只更新已存在的文件,与编辑器同一条
  // per-path 队列,盘上刚被编辑器 / 别的设备写过就按现文重算,不盲盖)。自己写的 SSE 被回声抑制吃掉 → 开着这些笔记的编辑器
  // 由这里 fireExternal 叫它们回灌(桌面那边是 notifyAll(externalChange))。没能改写的 → 提示,绝不静默吞。
  // ⚠️ 必须在 rename/move 的队列任务**之外**调用:任务占着新旧路径的 key,里面再 writeTextFile(newPath) = 自锁。
  // ponytail: 全库逐篇 GET(无批量读端点),与桌面「朴素全库读扫」同一量级;嫌慢的正解是服务端 /move 带 rewriteLinks。
  /** 传播专用写口(G2-04 复核 P1):**只更新已存在的文件**的比对交换写。不能借 writeTextFile —— 读完之后那篇被别处
   *  删了 / 挪进 .trash,SSE 的 forgetSeq 清掉状态后它按 baseSeq 0 把原路径重建,或走 recovered 另存,还记成「改写成功」。
   *  这里现取现比:不在了 → 'gone'(路径已变,记入失败清单);内容不是读到的那版 → 交回现文重算;
   *  PUT 恒带取到的 seq(>0,服务端对不存在的路径只会 409 不会创建),409 就回头重取。 */
  const updateExisting = (p: string, text: string, base: string): Promise<TextWriteResult | 'gone'> =>
    enqueue([p], async () => {
      await ensureVault()
      for (let attempt = 0; attempt < 3; attempt++) {
        let f: FileDto
        try {
          f = await getFile(p)
        } catch (e) {
          if (is404(e)) return 'gone' as const
          throw e
        }
        if (textFingerprint(f.content) !== base) return { ok: false as const, current: f.content }
        try {
          await putFile(p, text, f.seq)
          return { ok: true as const }
        } catch (e) {
          if (!is409(e)) throw e // 取完之后别处抢先写了 / 删了:回头重取(删了就是 'gone')
        }
      }
      throw new Error('conflict')
    })
  const propagateRenames = async (pairs: Record<string, string>, pagesBefore: string[]): Promise<void> => {
    const res = await propagateNoteRenames(
      {
        read: async (p) => {
          try {
            return (await getFile(p)).content
          } catch (e) {
            if (is404(e)) return null
            throw e
          }
        },
        write: updateExisting,
      },
      pairs,
      pagesBefore,
    )
    for (const p of res.rewritten) fireExternal(p)
    toastRenameRewriteFailed(res.failed.map((f) => f.path))
  }
  /** 文件夹改名 / 移动 → 树下每一页一对 old→new(引用重写按页粒度进行,同桌面 folderPairs)。 */
  const folderPairs = (pages: string[], oldFolder: string, newFolder: string): Record<string, string> => {
    const pre = `${oldFolder}/`
    const out: Record<string, string> = {}
    for (const p of pages) if (p.startsWith(pre)) out[p] = `${newFolder}/${p.slice(pre.length)}`
    return out
  }

  // ===========================================================================
  // AmadeusApi 实现
  // ===========================================================================
  // 结构操作(改名 / 移动 / 删除 / 回收站)连同其链接重写走库级有序队列(G2-04 复核 P1,见 queueStructureOps):
  // 前一次的重写没跑完,下一次改名就按旧页表扫,留下指向已不存在路径的 [[链接]]。
  return queueStructureOps<AmadeusApi>({
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

    savePage: (pagePath, manifest: PageManifest, contents) => {
      const held = keysFor(pagePath)
      return enqueue(held, async () => {
        await ensureVault()
        const content = compile(manifest, contents)
        const meaningful = Object.values(contents).some((c) => typeof c === 'string' && c.trim().length > 0)
        let target: string
        let base: number
        try {
          ({ target, base } = await writeTargetFor(pagePath))
        } catch (e) {
          // 别处删了:不按原路径重建、不 reconcile(那条会 404→newPage 又造回来);有正文就另存为 recovered 副本
          if (e instanceof VanishedError) { await recoverVanished(pagePath, content, meaningful); return }
          throw e
        }
        await underTarget(held, target, async () => {
        try {
          await putFile(target, content, base)
          cachePage(target, parsePageSource(target, content, nowIso())) // 写后回填,切回零请求
        } catch (e) {
          if (is409(e)) {
            const body = (e as HttpError).body as ConflictBody | null
            if (body?.code === 'CONFLICT' && body.seq === 0) {
              // 基线还在、文件已不在 = 别处删掉/挪走了(SSE 还没到)。采纳 seq 0 就是下一次保存把它重建。
              seqMap.delete(target)
              await recoverVanished(pagePath, content, meaningful)
              return
            }
            // 云端已被别处更新(EXISTS/CONFLICT 同治):采纳服务端 seq,走既有 LWW 通道
            // (onExternalChange → pageStore.reconcileExternal 重载服务端版本)。
            if (body && typeof body.seq === 'number') noteSeq(target, body.seq)
            pageCache.delete(pagePath) // 服务端为准,reconcile 会重拉
            notify(translate('amxbridge.conflictReloaded'), true)
            // 必须晚于 pageStore.save() 的收尾 set(否则本地旧 manifest 会盖回 reconcile 结果)。
            setTimeout(() => fireExternal(pagePath), 0)
            return // savePage 正常 resolve(镜像桌面「保存不抛」体感)
          }
          if (e instanceof HttpError && e.status === 413) {
            notify(translate('amxbridge.tooLarge'), true)
          }
          throw e
        }
        })
      })
    },

    renamePage: (oldPath, newName, manifest: PageManifest, contents) => {
      let pagesBefore: string[] | null = null // 引用重写要的「操作前」页表(G2-04),须在移动前取
      return enqueue(
        // 新旧两个 key 都占位;新名要先算 —— 与任务体内保持同一清洗逻辑。
        [oldPath, sanitizedSiblingPath(oldPath, newName, translate('amxbridge.pageNameEmpty'))],
        async () => {
          await ensureVault()
          const newPath = sanitizedSiblingPath(oldPath, newName, translate('amxbridge.pageNameEmpty'))
          if (newPath === oldPath) {
            return { newPath: oldPath, page: await fetchAndParse(oldPath) }
          }
          const tree = await fetchTree(true)
          pagesBefore = tree.pages.filter(visiblePath) // 点目录(.trash 等)与桌面 listPages 同样不算:否则裸名链接会被解析到回收站那份
          if (allTreePaths(tree).includes(newPath) || tree.folders.includes(newPath)) throw new Error(translate('amxbridge.pageExists'))
          // v3 单文件:先把在途编辑落到旧路径(重命名是显式用户动作 → force,桌面同款「无条件落盘再移动」)。
          const content = compile(manifest, contents)
          await putFile(oldPath, content, await baseSeqFor(oldPath), true)
          let moved: MoveResultDto
          try {
            moved = await http.post<MoveResultDto>(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: oldPath, to: newPath })
          } catch (e) {
            if (is409(e)) throw new Error(translate('amxbridge.pageExists'))
            throw e
          }
          migrateSeq(oldPath, newPath, moved.seq)
          invalidateTree()
          rememberPage(newPath)
          return { newPath, page: null as LoadedPage | null }
        },
      ).then(async (r) => {
        if (r.page) return { newPath: r.newPath, page: r.page }
        // 先重写再取页(桌面同序):自链接的改写也进返回值。队列任务之外调用(见 propagateRenames 注释)。
        if (pagesBefore) await propagateRenames({ [oldPath]: r.newPath }, pagesBefore)
        return { newPath: r.newPath, page: await fetchAndParse(r.newPath) }
      })
    },

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
      throw new Error(translate('amxbridge.imageNameFailed'))
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
      throw new Error(translate('amxbridge.attachmentNameFailed'))
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
    onPathGone: (cb) => { pathGoneCbs.add(cb); return () => { pathGoneCbs.delete(cb) } },

    // ---- 派生索引(服务端计算) ------------------------------------------------
    search: async (query) => {
      await ensureVault()
      // 服务端按 path ILIKE 也算命中 → 点开头路径(.trash/、库标记)会漏进结果;与树同一把 visiblePath 尺子。
      const hits = await http.get<SearchHit[]>(`/amadeus/vaults/${encodeURIComponent(vid())}/search`, { q: query })
      return hits.filter((h) => visiblePath(h.path))
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
    resolveEmbed: async (target, sourcePath) => {
      await ensureVault()
      // 评审 L-15:服务端 /embed 按 page_key 扫同名笔记、不认 sourcePath,也不认 `|别名/宽度`、`^块`、嵌套标题链。
      // 客户端先用树按**源笔记所在处**就近解析出确切那篇(同目录 → .fd 子笔记 → 全库,同 `[[链接]]`;
      // 空笔记名 `![[#标题]]` = 源笔记自己),解析到了就拉原文在本端切:v3 标记块 / 标题小节与服务端同口径
      // (shareBridge.findEmbedBlock 是它的镜像),其余(`^块`、嵌套链、带格式标题)走 shared/noteEmbed。
      // 解析不到才退回服务端(`|` 已剥),保留它对老目标形态的兜底。
      const { note, subpath } = splitNoteEmbed(target)
      // 点目录(.trash / .amadeus)不参与解析,与桌面索引、listPages 同一把尺子 —— 否则删了再建的同名笔记会嵌到回收站那份。
      const pages = (await fetchTree()).pages.filter(visiblePath).sort()
      const owner = note ? resolvePageName(note, pages, sourcePath) : sourcePath && pages.includes(sourcePath) ? sourcePath : null
      if (owner) {
        let raw: string | null = null
        try {
          raw = (await getFile(owner)).content
        } catch (e) {
          if (!is404(e)) throw e
        }
        if (raw != null) {
          if (!subpath) return { owner, content: stripForIndex(raw), type: 'markdown' }
          const content = findEmbedBlock(raw, subpath.trim().replace(/\.block$/i, '').toLowerCase()) ?? sliceEmbedSubpath(stripForIndex(raw), subpath)
          return content == null ? null : { owner, content, type: 'markdown' }
        }
      }
      const wire = subpath ? `${note}#${subpath}` : note
      if (!wire) return null
      const r = await http.get<EmbedResolved | null>(`/amadeus/vaults/${encodeURIComponent(vid())}/embed`, { target: wire })
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

    movePage: (pagePath, destFolder) => {
      let pagesBefore: string[] | null = null // G2-04 引用重写的「操作前」页表(只有笔记才要)
      return enqueue([pagePath], async () => {
        await ensureVault()
        const fileName = pageFileName(pagePath)
        const dstRel = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const newPath = dstRel ? `${dstRel}/${fileName}` : fileName
        if (newPath === pagePath) return pagePath
        if (newPath.endsWith('.md')) pagesBefore = (await fetchTree(true)).pages.filter(visiblePath)
        let moved: MoveResultDto
        try {
          moved = await http.post<MoveResultDto>(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: pagePath, to: newPath })
        } catch (e) {
          if (is409(e)) throw new Error(translate('amxbridge.fileExistsAtTarget'))
          throw e
        }
        migrateSeq(pagePath, newPath, moved.seq)
        invalidateTree()
        if (newPath.endsWith('.md')) rememberPage(newPath)
        return newPath
      }).then(async (newPath) => {
        if (newPath !== pagePath && pagesBefore) await propagateRenames({ [pagePath]: newPath }, pagesBefore)
        return newPath
      })
    },

    createFolder: async (parentFolder, name) => {
      await ensureVault()
      const clean = name.trim().replace(/[\\/]/g, '')
      if (!clean) throw new Error(translate('amxbridge.folderNameEmpty'))
      const parent = parentFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      try {
        const r = await http.post<{ path: string }>(`/amadeus/vaults/${encodeURIComponent(vid())}/folders`, { parent, name: clean })
        invalidateTree()
        return r.path
      } catch (e) {
        if (is409(e)) throw new Error(translate('amxbridge.folderExists'))
        throw e
      }
    },

    renameFolder: async (folderPath, newName) => {
      await ensureVault()
      const clean = newName.trim().replace(/[\\/]/g, '')
      if (!clean) throw new Error(translate('amxbridge.folderNameEmpty'))
      const parent = dirnamePosix(folderPath)
      const newPath = parent ? `${parent}/${clean}` : clean
      if (newPath === folderPath) return folderPath
      const pagesBefore = (await fetchTree(true)).pages.filter(visiblePath) // G2-04 引用重写的「操作前」页表(点目录不算)
      let r: { path: string }
      try {
        r = await http.post<{ path: string }>(`/amadeus/vaults/${encodeURIComponent(vid())}/folders/rename`, { path: folderPath, newName: clean })
      } catch (e) {
        if (is409(e)) throw new Error(translate('amxbridge.folderExists'))
        throw e
      }
      migrateSeqPrefix(folderPath, r.path)
      if (lastLoadedPage && lastLoadedPage.startsWith(`${folderPath}/`)) {
        rememberPage(`${r.path}${lastLoadedPage.slice(folderPath.length)}`)
      }
      invalidateTree()
      await propagateRenames(folderPairs(pagesBefore, folderPath, r.path), pagesBefore)
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
      if (!name) throw new Error(translate('amxbridge.folderPathEmpty'))
      const dst = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const newPath = dst ? `${dst}/${name}` : name
      if (newPath === src) return src
      if (dst === src || dst.startsWith(`${src}/`)) throw new Error(translate('amxbridge.moveIntoSelf'))
      const pagesBefore = (await fetchTree(true)).pages.filter(visiblePath) // G2-04 引用重写的「操作前」页表(点目录不算)
      let r: { path: string }
      try {
        r = await http.post<{ path: string }>(`/amadeus/vaults/${encodeURIComponent(vid())}/folders/move`, { path: src, dest: dst })
      } catch (e) {
        if (is409(e)) throw new Error(translate('amxbridge.folderExistsAtTarget'))
        throw e
      }
      migrateSeqPrefix(src, r.path)
      if (lastLoadedPage && lastLoadedPage.startsWith(`${src}/`)) {
        rememberPage(`${r.path}${lastLoadedPage.slice(src.length)}`)
      }
      invalidateTree()
      await propagateRenames(folderPairs(pagesBefore, src, r.path), pagesBefore)
      return r.path
    },

    // ---- 回收站(五件套;树/搜索经 visiblePath 对 .trash 免疫,同桌面点目录语义) ----
    trashEntry: async (rel) => {
      await ensureVault()
      const norm = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      if (!norm || norm === TRASH_DIR || norm.startsWith(`${TRASH_DIR}/`)) throw new Error(translate('amxbridge.invalidPath'))
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
      if (!rec) throw new Error(translate('amxbridge.trashMissing'))
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
      if (!norm) throw new Error(translate('amxbridge.pathOutsideVault'))
      await postBinary(norm, basenamePosix(norm), bytes, false) // 无 ifAbsent = 原地覆盖
    },
    readVaultBytes: async (vaultRel) => {
      const v = await ensureVault()
      const r = await (cfg.request ?? fetch)(
        `${cfg.apiBase}/amadeus/vaults/${encodeURIComponent(v)}/asset?path=${encodeURIComponent(vaultRel)}`,
        { headers: { Authorization: `Bearer ${cfg.getToken()}` } }, // assetAuth 收 Bearer 主 token,无需等 asset-token
      )
      if (!r.ok) throw new Error(translate('amxbridge.readFailed', { status: r.status }))
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
    openPluginsFolder: async () => { notify(translate('amxbridge.desktopOnly')) },
    scaffoldSamplePlugin: async () => { notify(translate('amxbridge.desktopOnly')) },
    revealInFileManager: async () => { notify(translate('amxbridge.desktopOnly')) },
    // 网页 / 移动端云模式没有文件管理器:入口不渲染(G2-13;上面的提示只兜老调用方)。
    hostCaps: { revealInFileManager: false },

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
        if (e instanceof HttpError && e.status === 400) return { status: 'corrupt', path: resolved, message: translate('amxbridge.notText') }
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

    // ---- 插件自定义文件类型的纯文本读写(desktop ipc.ts readTextFile/writeTextFile 同款) ----
    // 不存在返回 null(桌面语义);写走同一条 enqueue 串行队列,避免与笔记保存互相踩 seq。
    readTextFile: async (p): Promise<string | null> => {
      await ensureVault()
      try {
        return (await getFile(p)).content
      } catch (e) {
        if (is404(e)) return null
        throw e
      }
    },
    writeTextFile: (p, text, opts) => {
      const held = keysFor(p)
      // 比对交换写(Codex g3#1,契约见 ipc.ts writeTextFile):调用方以为盘上是什么的指纹。云端的乐观并发是按 seq 的,
      // 这里把它补成与桌面主进程同形的内容 CAS —— 盘上不是基线就**不写**,回 { ok:false, current } 让 UnifiedPage
      // 已有的拒写路径接管(回灌 / 冲突副本);不带 base 的调用方(插件文件类型等)下面那条老路一字不变。
      const casBase = typeof opts?.base === 'string' ? opts.base : null
      const done = (): void | TextWriteResult => (casBase != null ? { ok: true } : undefined)
      return enqueue(held, async (): Promise<void | TextWriteResult> => {
        await ensureVault()
        if (opts?.create) {
          // 新建意图(素文件出生 / 模板 / 种子笔记):按新文件创建,绕过「本会话见过、现 404 = 别处删了」的
          // 重建禁令 —— 别处删了 untitled.md 后本端再新建一篇同名是合法的。已存在(别处刚建了同名)→ 落回普通写。
          try {
            await putFile(p, text, 0)
            movedTo.delete(p)
            invalidateTree()
            return done()
          } catch (e) {
            if (!is409(e)) throw e
          }
        }
        // v4/unified 笔记的唯一落盘通道也是它:别处挪走 → 跟到新路径;别处删了 → 有正文就另存为 recovered 副本
        // (此后这个编辑器的保存都落到那份),绝不按 baseSeq 0 把旧路径重新造出来。
        const meaningful = text.trim().length > 0
        let target: string
        let base: number
        try {
          ({ target, base } = await writeTargetFor(p))
        } catch (e) {
          if (e instanceof VanishedError) { await recoverVanished(p, text, meaningful); return done() }
          throw e
        }
        if (casBase != null) {
          const cas = casBase
          return underTarget(held, target, async (): Promise<void | TextWriteResult> => {
            /** 拉服务端现文比基线:不符 → 拒写交回现文;符 → 换成它的 seq 接着写。别处删了 → 同下面老路另存 recovered。 */
            const recheck = async (): Promise<TextWriteResult | 'vanished' | number> => {
              let f: FileDto
              try {
                f = await getFile(target) // 顺带对齐 seq / 指纹
              } catch (e2) {
                if (is404(e2)) return 'vanished'
                throw e2
              }
              return textFingerprint(f.content) === cas ? f.seq : { ok: false, current: f.content }
            }
            // 本端最后见到的这版(seq = base)不是调用方的基线,或者不知道是什么 → 写前先拉一次(服务端不会替我们 409:
            // seq 是本端自己推进的)。稳态(上一发就是本实例自己写的)指纹对得上,零额外请求。base 0 = 服务端没有 = 无冲突。
            if (base > 0 && knownFp(target, base) !== cas) {
              const r = await recheck()
              if (r === 'vanished') { await recoverVanished(p, text, meaningful); return done() }
              if (typeof r !== 'number') return r
              base = r
            }
            for (let attempt = 0; ; attempt++) {
              try {
                await putFile(target, text, base)
                return { ok: true }
              } catch (e) {
                // 409 = 预读之后别处抢先写了:内容变了就拒写(绝不强写);内容恰好还是基线(别处写了同样的字)→ 按新 seq 重试。
                if (!is409(e)) throw e
                const r = await recheck()
                if (r === 'vanished') { await recoverVanished(p, text, meaningful); return done() }
                if (typeof r !== 'number') return r
                if (attempt >= 2) throw e // seq 一直在跳、内容却一直是基线:按写失败交给渲染层退避,不空转
                base = r
              }
            }
          })
        }
        await underTarget(held, target, async () => {
        try {
          await putFile(target, text, base)
        } catch (e) {
          // 409 = 预读 seq 后被别人抢先写了。纯文本没有 drawing 那种元素级可合并结构,
          // 所以按桌面语义(本地原子写,后写胜)拉最新 seq 重写一次 —— 不能就这么抛给插件调用方,
          // 那等于用户这次修改静默消失(插件未必展示错误、更未必重试)。
          if (!is409(e)) throw e
          let f: FileDto
          try {
            f = await getFile(target) // 顺带对齐 noteSeq
          } catch (e2) {
            if (is404(e2)) { await recoverVanished(p, text, meaningful); return } // 基线在、文件没了 = 别处删掉
            throw e2
          }
          await putFile(target, text, f.seq, true)
        }
        })
      })
    },

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
    renamePageFile: (oldPath, newBaseName) => {
      let pagesBefore: string[] | null = null // G2-04 引用重写的「操作前」页表,须在移动前取
      return enqueue([oldPath, sanitizedSiblingPath(oldPath, newBaseName, translate('amxbridge.noteNameEmpty'))], async () => {
        await ensureVault()
        const newPath = sanitizedSiblingPath(oldPath, newBaseName, translate('amxbridge.noteNameEmpty'))
        if (newPath === oldPath) return oldPath
        pagesBefore = (await fetchTree(true)).pages.filter(visiblePath)
        let moved: MoveResultDto
        try {
          moved = await http.post<MoveResultDto>(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: oldPath, to: newPath })
        } catch (e) {
          if (is409(e)) throw new Error(translate('amxbridge.noteExists'))
          throw e
        }
        migrateSeq(oldPath, newPath, moved.seq)
        invalidateTree()
        return newPath
      }).then(async (newPath) => {
        // 队列任务之外调用:任务占着 [oldPath, newPath],里面 writeTextFile(newPath) 会自锁(见 propagateRenames)。
        if (newPath !== oldPath && pagesBefore) await propagateRenames({ [oldPath]: newPath }, pagesBefore)
        return newPath
      })
    },

    // ponytail: 云端只做移动(服务端 move 保文件 id);桌面版的 title 同步 + 全库引用重写暂缺,
    // 裸名 ![[库名]] 引用靠服务端 basename 兜底仍可解析,带路径引用会断 —— 要补齐做服务端 renameDb 端点。
    renameDbFile: (oldPath, newBaseName) =>
      enqueue([oldPath], async () => {
        await ensureVault()
        const norm = oldPath.replace(/\\/g, '/')
        let base = newBaseName.trim().replace(/[\\/]/g, '')
        if (base.toLowerCase().endsWith('.db')) base = base.slice(0, -3)
        if (!base) throw new Error(translate('amxbridge.nameEmpty'))
        const dir = dirnamePosix(norm)
        const newPath = dir ? `${dir}/${base}.db` : `${base}.db`
        if (newPath === norm) return { newPath, rewrittenPages: [] }
        let moved: MoveResultDto
        try {
          moved = await http.post<MoveResultDto>(`/amadeus/vaults/${encodeURIComponent(vid())}/move`, { from: norm, to: newPath })
        } catch (e) {
          if (is409(e)) throw new Error(translate('amxbridge.fileExists'))
          throw e
        }
        migrateSeq(norm, newPath, moved.seq)
        invalidateTree()
        return { newPath, rewrittenPages: [] }
      }),
  })
}

/** 同目录改名的路径清洗(镜像 electron ipc.ts:剥路径分隔符、去 .md 后缀、空名报错)。 */
function sanitizedSiblingPath(oldPath: string, newName: string, emptyError: string): string {
  const dir = dirnamePosix(oldPath)
  let base = newName.trim().replace(/[\\/]/g, '')
  if (!base) throw new Error(emptyError)
  if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
  return dir ? `${dir}/${base}.md` : `${base}.md`
}
