/**
 * Unit 设备页的 Amadeus 桥:在「B 曝出来的网页」里实现完整 AmadeusApi(window.amadeus),
 * 底层 = unitWeb 的 /vault/* —— RPC 直通 B 主进程的同一套 vault handler(desktop ipc.ts),
 * 语义天然与 B 本机一致(索引/回灌/毁档防线全在 B 侧,一处真源)。与 cloudBridge 的差别:
 * 这里不跑编译器、不管 seq —— desktop handler 返回的就是编译好的页面。
 *
 * 三件事在桥内:
 *   1. RPC:POST vault/rpc {ch,args};字节参数/返回按 {__u8: base64} 包裹(saveAsset 等)。
 *   2. 资源:<img>/<video> 带不了 Authorization → 短时资源令牌 ?at=(照 cloudAssets 先例),
 *      ttl/2 自续;setAssetUrlBuilder 接进渲染层 toAssetUrl。
 *   3. 事件:GET vault/events SSE({ch,payload} 直通 desktop 的回灌通道);断线自管理重连
 *      (1s→30s 退避),重连后补课 = structureChange + 当前笔记 externalChange(照 cloudEvents);
 *      自己的写会被 B 侧 notifyAll 回声回来 → 按「3 秒内自写路径」丢弃(cloud 用 clientId 判,
 *      这里 RPC 无 origin 通道,时间窗版本够用;窗内恰好撞上 B 同径改动会漏一拍,下次事件补上)。
 *
 * 桌面 UX 通道(弹框/shell)不可远程:openVault 回 null,openAttachment/openVaultFile 改开新标签,
 * exportPdf 走浏览器打印(与 cloudBridge 同口径);服务端白名单(unitWeb VAULT_RPC_ALLOW)是真闸,
 * 这里的覆盖只是给出合理的远程语义。
 */
import { IPC } from '@amadeus-shared/ipc'
import type { AmadeusApi } from '@amadeus-shared/ipc'
import { setAssetUrlBuilder } from '@amadeus-shared/assets'

export interface UnitBridgeCfg {
  /** 设备页基址(尾斜杠;局域网根或隧道子路径 —— 相对 base 两用)。 */
  base: string
  getToken(): string
  /** 401(配对被回收):由 unitShim 清掉本地令牌并重进配对流。 */
  onAuthError(): void
}

const ECHO_WINDOW_MS = 3000

export function createUnitAmadeusBridge(cfg: UnitBridgeCfg): AmadeusApi {
  let lastLoadedPage: string | null = null
  let assetToken = ''
  /** 自写路径 → 时刻(SSE 回声丢弃;结构事件永不抑制,照 cloud 口径)。 */
  const selfWrites = new Map<string, number>()
  const noteSelfWrite = (p: unknown): void => {
    if (typeof p === 'string' && p) selfWrites.set(p, Date.now())
  }
  const isEcho = (p: unknown): boolean =>
    typeof p === 'string' && Date.now() - (selfWrites.get(p) ?? 0) < ECHO_WINDOW_MS

  // ---- RPC ------------------------------------------------------------------
  const enc = (a: unknown): unknown => {
    if (!(a instanceof Uint8Array)) return a
    let bin = '' // 分块:整段展开 fromCharCode(...bytes) 在几 MB 附件上直接爆调用栈
    for (let i = 0; i < a.length; i += 0x8000) bin += String.fromCharCode(...a.subarray(i, i + 0x8000))
    return { __u8: btoa(bin) }
  }
  const dec = (r: unknown): unknown => {
    const u8 = (r as { __u8?: unknown } | null)?.__u8
    if (typeof u8 !== 'string') return r
    const bin = atob(u8)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const rpc = async <T>(ch: string, args: unknown[] = []): Promise<T> => {
    const hasBytes = args.some((a) => a instanceof Uint8Array)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), hasBytes ? 120_000 : 30_000)
    let res: Response
    try {
      res = await fetch(new URL('vault/rpc', cfg.base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.getToken()}` },
        body: JSON.stringify({ ch, args: args.map(enc) }),
        signal: ctrl.signal,
      })
    } catch (e) {
      throw new Error(ctrl.signal.aborted ? '设备请求超时,请检查与对方设备的连接' : `设备不可达:${e instanceof Error ? e.message : e}`)
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 401) { cfg.onAuthError(); throw new Error('连接权限已被对方移除') }
    if (res.status === 413) throw new Error('内容过大:server 中转通道上限 10MB,同一局域网内直连不受限')
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; error?: string } | null
    if (!res.ok || !body) throw new Error(`设备端错误(HTTP ${res.status})`)
    if (!body.ok) throw new Error(body.error || '设备端调用失败')
    return dec(body.result) as T
  }

  // ---- 资源令牌 + URL 接缝 -----------------------------------------------------
  const assetUrl = (ref: string, page?: string | null): string => {
    const u = new URL('vault/asset', cfg.base)
    u.searchParams.set('ref', ref)
    const p = page === undefined ? lastLoadedPage : page
    if (p) u.searchParams.set('page', p)
    if (assetToken) u.searchParams.set('at', assetToken)
    return u.href
  }
  let assetTimer: ReturnType<typeof setTimeout> | null = null
  const refreshAssetToken = async (): Promise<void> => {
    try {
      const r = await fetch(new URL('vault/asset-token', cfg.base), {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.getToken()}` },
      })
      const j = (await r.json()) as { token?: string; ttlSec?: number }
      if (!r.ok || !j.token) throw new Error(`HTTP ${r.status}`)
      assetToken = j.token
      startEvents() // 首枚令牌到手才起 SSE(events 同用 ?at=)
      assetTimer = setTimeout(() => { void refreshAssetToken() }, (Math.max(60, j.ttlSec || 600) / 2) * 1000)
    } catch {
      assetTimer = setTimeout(() => { void refreshAssetToken() }, 30_000)
    }
  }
  void refreshAssetToken()
  setAssetUrlBuilder((ref) => assetUrl(ref))

  // ---- 事件(SSE → 四条回灌通道) ---------------------------------------------
  const extCbs = new Set<(p: string) => void>()
  const structCbs = new Set<() => void>()
  const dbCbs = new Set<(p: string) => void>()
  const fileCbs = new Set<(p: string) => void>()
  let es: EventSource | null = null
  let backoff = 1000
  let hadSession = false
  const fire = (set: Set<(p: string) => void>, p: unknown): void => {
    if (typeof p !== 'string' || isEcho(p)) return
    for (const cb of [...set]) cb(p)
  }
  function startEvents(): void {
    if (es) return
    const src = new EventSource(new URL(`vault/events?at=${encodeURIComponent(assetToken)}`, cfg.base))
    es = src
    src.onopen = () => {
      backoff = 1000
      if (hadSession) {
        // 断线补课:结构刷一次 + 当前笔记走既有 LWW reconcile(掉线期间的事件丢了)。
        for (const cb of [...structCbs]) cb()
        if (lastLoadedPage) fire(extCbs, lastLoadedPage)
      }
      hadSession = true
    }
    src.onmessage = (ev) => {
      let d: { ch?: string; payload?: unknown } = {}
      try { d = JSON.parse(ev.data) } catch { return }
      if (d.ch === IPC.externalChange) fire(extCbs, d.payload)
      else if (d.ch === IPC.structureChange) { for (const cb of [...structCbs]) cb() }
      else if (d.ch === IPC.dbChange) fire(dbCbs, d.payload)
      else if (d.ch === IPC.fileChange) fire(fileCbs, d.payload)
    }
    src.onerror = () => {
      // ?at= 过期后 EventSource 自带重试会沿用旧 URL → 自管理重连,拿新令牌重建。
      src.close()
      es = null
      const wait = backoff
      backoff = Math.min(30_000, backoff * 2)
      setTimeout(() => { if (!es) startEvents() }, wait + Math.random() * 500)
    }
  }
  window.addEventListener('beforeunload', () => { es?.close(); if (assetTimer) clearTimeout(assetTimer) })

  const notSupported = (what: string) => (): never => { throw new Error(`${what}:请在对方设备上操作`) }

  return {
    openVault: async () => null, // 换库是 B 自己的事,远程页不弹对方的目录选择框
    restoreVault: () => rpc(IPC.restoreVault),
    listPages: () => rpc(IPC.listPages),
    listFiles: () => rpc(IPC.listFiles),
    loadPage: async (pagePath) => {
      const page = await rpc<Awaited<ReturnType<AmadeusApi['loadPage']>>>(IPC.loadPage, [pagePath])
      lastLoadedPage = pagePath
      return page
    },
    readPage: (pagePath) => rpc(IPC.readPage, [pagePath]),
    newPage: (pagePath) => rpc(IPC.newPage, [pagePath]),
    savePage: async (pagePath, manifest, contents) => {
      await rpc(IPC.savePage, [pagePath, manifest, contents])
      noteSelfWrite(pagePath)
    },
    renamePage: (oldPath, newName, manifest, contents) => rpc(IPC.renamePage, [oldPath, newName, manifest, contents]),
    reconcilePage: async (pagePath, prevManifest, prevContents) => {
      const r = await rpc<Awaited<ReturnType<AmadeusApi['reconcilePage']>>>(IPC.reconcilePage, [pagePath, prevManifest, prevContents])
      noteSelfWrite(pagePath)
      return r
    },
    saveAsset: (pagePath, fileName, bytes) => rpc(IPC.saveAsset, [pagePath, fileName, bytes]),
    saveVaultBytes: async (filePath, bytes) => {
      await rpc(IPC.saveVaultBytes, [filePath, bytes])
      noteSelfWrite(filePath)
    },
    readVaultBytes: (filePath) => rpc(IPC.readVaultBytes, [filePath]),
    saveAttachment: (pagePath, fileName, bytes, opts) => rpc(IPC.saveAttachment, [pagePath, fileName, bytes, opts]),
    openAttachment: async (pagePath, ref) => {
      window.open(assetUrl(ref.replace(/^!?\[\[|\]\]$/g, ''), pagePath), '_blank', 'noopener')
    },
    openVaultFile: async (vaultRel) => {
      const u = new URL('vault/asset', cfg.base)
      u.searchParams.set('path', vaultRel)
      if (assetToken) u.searchParams.set('at', assetToken)
      window.open(u.href, '_blank', 'noopener')
    },
    exportPdf: async () => { window.print(); return null }, // 与 cloudBridge 同口径:@media print 呈现编辑器克隆
    onExternalChange: (cb) => { extCbs.add(cb); return () => { extCbs.delete(cb) } },
    search: (query) => rpc(IPC.search, [query]),
    backlinks: (pagePath) => rpc(IPC.backlinks, [pagePath]),
    exclusiveAssets: (pagePath) => rpc(IPC.exclusiveAssets, [pagePath]),
    reindex: () => rpc(IPC.reindex),
    listTags: () => rpc(IPC.listTags),
    pagesByTag: (tag) => rpc(IPC.pagesByTag, [tag]),
    deletePage: (pagePath) => rpc(IPC.deletePage, [pagePath]),
    movePage: (pagePath, destFolder) => rpc(IPC.movePage, [pagePath, destFolder]),
    resolveEmbed: (target) => rpc(IPC.resolveEmbed, [target]),
    blockBacklinks: (target) => rpc(IPC.blockBacklinks, [target]),
    listFolders: () => rpc(IPC.listFolders),
    createFolder: (parentFolder, name) => rpc(IPC.createFolder, [parentFolder, name]),
    renameFolder: (folderPath, newName) => rpc(IPC.renameFolder, [folderPath, newName]),
    deleteFolder: (folderPath) => rpc(IPC.deleteFolder, [folderPath]),
    moveFolder: (folderPath, destFolder) => rpc(IPC.moveFolder, [folderPath, destFolder]),
    trashEntry: (rel) => rpc(IPC.trashEntry, [rel]),
    listTrash: () => rpc(IPC.listTrash),
    restoreTrash: (name) => rpc(IPC.restoreTrash, [name]),
    deleteTrashEntry: (name) => rpc(IPC.deleteTrashEntry, [name]),
    emptyTrash: () => rpc(IPC.emptyTrash),
    pageIcons: () => rpc(IPC.pageIcons),
    fetchLinkMeta: (url) => rpc(IPC.fetchLinkMeta, [url]),
    searchImages: (q) => rpc(IPC.searchImages, [q]),
    onStructureChange: (cb) => { structCbs.add(cb); return () => { structCbs.delete(cb) } },
    onDbExternalChange: (cb) => { dbCbs.add(cb); return () => { dbCbs.delete(cb) } },
    onFileExternalChange: (cb) => { fileCbs.add(cb); return () => { fileCbs.delete(cb) } },
    readPluginData: (pluginId) => rpc(IPC.pluginDataRead, [pluginId]),
    writePluginData: (pluginId, text) => rpc(IPC.pluginDataWrite, [pluginId, text]),
    listPlugins: async () => [], // 设备页插件清单走 /unit/plugins(pluginStore.resolveExternalSources)
    openPluginsFolder: notSupported('打开插件文件夹'),
    scaffoldSamplePlugin: notSupported('创建示例插件'),
    uninstallPlugin: notSupported('卸载插件'),
    revealInFileManager: notSupported('在文件管理器中显示'),
    readDatabase: (pagePath, ref) => rpc(IPC.dbRead, [pagePath, ref]),
    writeDatabase: async (dbPath, data) => {
      await rpc(IPC.dbWrite, [dbPath, data])
      noteSelfWrite(dbPath)
    },
    writeDatabaseCas: async (dbPath, data, baseVersion) => {
      const r = await rpc<Awaited<ReturnType<NonNullable<AmadeusApi['writeDatabaseCas']>>>>(IPC.dbWriteCas, [dbPath, data, baseVersion])
      noteSelfWrite(dbPath)
      return r
    },
    readDrawing: (pagePath, ref) => rpc(IPC.drawingRead, [pagePath, ref]),
    writeDrawing: async (drawingPath, source) => {
      await rpc(IPC.drawingWrite, [drawingPath, source])
      noteSelfWrite(drawingPath)
    },
    readTextFile: (filePath) => rpc(IPC.readTextFile, [filePath]),
    writeTextFile: async (filePath, text) => {
      await rpc(IPC.writeTextFile, [filePath, text])
      noteSelfWrite(filePath)
    },
    listPageProps: (folder) => rpc(IPC.listPageProps, [folder]),
    setPageFrontmatter: async (pagePath, patch) => {
      const r = await rpc<Awaited<ReturnType<AmadeusApi['setPageFrontmatter']>>>(IPC.setPageFrontmatter, [pagePath, patch])
      noteSelfWrite(pagePath)
      return r
    },
    renamePageFile: (oldPath, newBaseName) => rpc(IPC.renamePageFile, [oldPath, newBaseName]),
    renameDbFile: (oldPath, newBaseName) => rpc(IPC.renameDbFile, [oldPath, newBaseName]),
  }
}
