/**
 * Android App 的应用市场数据层(2026-10-02):`window.tangu.market*` 六件,请求 / 返回形状**逐字对齐**桌面主进程
 * (desktop/electron/main.ts 的 market:list / detail / install / installed / uninstall + installProgress 事件),
 * 于是 marketService.ts / MarketModal.tsx / marketPostInstall.ts 不改一行就能在手机上跑。
 *
 * 与桌面的差异(都是「手机上没有」):
 *  · 只装 `amadeus-plugin`(Forsion 插件)—— 技能 / Agent / 引擎插件要本机引擎,主题 / Space 没有对应目录桥;
 *    `marketTypes` 声明给 MarketModal 只列这一类,下载后按包内 manifest 纠偏出来的类型不在其列 → 拒装。
 *  · 安装包上限 MOBILE_MAX_ZIP_BYTES(桌面 200 MB 是给带引擎半身 / node_modules 的捆绑包留的;手机只跑渲染层那一半,
 *    且每个字节都要以 base64 过一遍 Capacitor 桥)+ 解压总量与条目数上限(防 zip 炸弹;三道闸见 zipUnpack.ts:
 *    解析前看条目数、解压前看声明大小、解压时按实际字节流式封顶)。
 *  · 下载地址只认 `https:`(file: / content: / 明文 http 一律不下载);allowLoopbackHttp 只给 debug 包的台架开回环明文。
 *  · manifest `isDesktopOnly: true`、入口文件(manifest.main,缺省 main.js)不在包里 → 拒装,且在**写下第一个字节之前**判。
 *  · 落盘不碰正在用的那一版:新版先完整写进暂存目录,再「旧 → 备份、暂存 → 正式、删备份」;写到一半失败 / 被杀,
 *    旧版原样可用,残留由 pluginHost.recoverPluginDirs 在下次清点 / 安装时收拾。
 *  · 服务端回了 `integrity`(SRI,npm 源会带)→ 校验字节;对不上换下一个候选,全不对 = 拒装。桌面目前不校验。
 *  · 校验规则(白名单 type / kebab slug / 重定根 / 防穿越 / 拒绝对路径 / 双类型纠偏 / 镜像候选)与桌面同一份:desktop/shared/marketPackage.ts。
 *
 * 本模块不 import Capacitor:下载(原生封顶下载 / 浏览器 fetch)与文件读写都经依赖注入,
 * 单测见 mobile/scripts/plugin-host.test.cjs。
 */
import JSZip from 'jszip'
import {
  MARKET_MANIFEST, MARKET_SUBDIR, ZIP_MAGIC, ZipPlanError, detectMarketTypeFromNames, downloadCandidates, hasMagic,
  isSafeSlug, planZipFiles,
} from '../../../desktop/shared/marketPackage'
import { effectivePluginId } from '../../../desktop/shared/products'
import { PLUGINS_DIR, backupDirOf, mainRelOf, pluginDirNames, readManifest, recoverPluginDirs, stagingDirOf, tombstoneExtensions } from './pluginHost'
import { withPluginDirLock, type PluginFs } from './pluginFs'
import { UnpackLimitError, countCentralHeaders, unpackCapped } from './zipUnpack'

/** 手机能装的市场类型。 */
export const MOBILE_MARKET_TYPES: readonly string[] = ['amadeus-plugin']
/** 下载上限 25 MB:一个 Forsion 插件 = main.js + 文档 + 图标,常见 < 1 MB;给带插图 README / 打包依赖的留足余量。 */
export const MOBILE_MAX_ZIP_BYTES = 25 * 1024 * 1024
/** 解压总量上限 64 MB(防 zip 炸弹:压缩比再高,解出来的也必须写得进手机、过得了桥)。 */
export const MOBILE_MAX_UNPACKED_BYTES = 64 * 1024 * 1024
/** 条目数上限(同上;正常插件几个到几十个文件)。 */
export const MOBILE_MAX_ENTRIES = 2000

export interface MarketInstallProgress {
  id: string
  phase: 'resolve' | 'download' | 'install'
  attempt?: number
  attempts?: number
  host?: string
  received?: number
  total?: number | null
}

/** 下一个字节流:返回完整字节;失败抛错,message = 语言中立的原因码(`HTTP 404` / `timeout` / `stalled` / `too large`)。 */
export type MarketDownload = (url: string, opts: { maxBytes: number; onProgress: (received: number, total: number | null) => void }) => Promise<Uint8Array>

export interface MobileMarketDeps {
  fs: PluginFs
  /** Forsion 云端 API 基址(含 /api,无尾斜杠;= window.tangu.getConfig().cloudApiBase)。 */
  cloudApiBase: () => string
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  download: MarketDownload
  /** 「中国大陆镜像」开关(桌面 config.mirror;手机缺省 'default' = 只直连)。 */
  mirror?: () => Promise<string> | string
  /** 代码里注册的内置插件 id(callout 等):同 id 的外置包装进来会与它们打架,拒装。装的那一刻才取(渲染层已就绪)。 */
  reservedIds?: () => Promise<string[]> | string[]
  /** 已经套好当前语言的文案(键见 installMobilePlugins.ts 的 registerMessages)。 */
  t: (key: string, vars?: Record<string, string>) => string
  /** 额外放行「回环主机的明文 http」下载地址(localhost / 127.0.0.1 / 10.0.2.2)。缺省 false = 只认 https。
   *  只有 debug 包开(台架用 adb reverse 从宿主机发安装包;release 的系统网络策略本来也禁明文)。 */
  allowLoopbackHttp?: boolean
  maxZipBytes?: number
  maxUnpackedBytes?: number
  maxEntries?: number
}

export interface MobileMarket {
  marketTypes: readonly string[]
  marketList(type?: string): Promise<{ items: Array<Record<string, unknown>> }>
  marketDetail(id: string): Promise<Record<string, unknown>>
  marketInstall(id: string): Promise<{ ok: boolean; path: string; files: number; type: string; slug: string; id?: string }>
  onMarketInstallProgress(cb: (ev: MarketInstallProgress) => void): () => void
  marketInstalled(): Promise<Record<string, Array<{ slug: string; version: string | null }>>>
  marketUninstall(type: string, slug: string): Promise<{ ok: boolean; path: string; type: string; id?: string }>
}

/** 已翻译文案的错误(MarketModal 原样放进「安装失败:{e}」)。 */
class MarketUserError extends Error {}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2'])

/** 下载地址闸:只认 `https:`;allowLoopbackHttp 时再放行回环主机的 `http:`。带账号口令的地址(`https://u:p@host`)也不认。 */
export function isAllowedDownloadUrl(url: unknown, allowLoopbackHttp = false): url is string {
  if (typeof url !== 'string') return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.username || u.password) return false
  if (u.protocol === 'https:') return true
  return allowLoopbackHttp && u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url.slice(0, 60) }
}

function normVer(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/^v/i, '')
  return s || null
}

/** 服务端 iconUrl 是 `/api/...` 相对路径;桌面拼「云端源 + iconUrl」。手机手里是含 /api 的 cloudApiBase → 先剥回源。 */
function cloudOrigin(apiBase: string): string {
  if (/\/api$/.test(apiBase)) return apiBase.slice(0, -4)
  try { return new URL(apiBase).origin } catch { return apiBase }
}

const SRI_ALGOS: Record<string, string> = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }

/** SRI(`sha512-<base64>`,可多值空格分隔)校验:任一对上即可;一个都不认识的算法 → false(拒装,不退到不校验)。 */
export async function matchesIntegrity(bytes: Uint8Array, integrity: string): Promise<boolean> {
  for (const token of integrity.trim().split(/\s+/)) {
    const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(token)
    if (!m) continue
    const digest = new Uint8Array(await crypto.subtle.digest(SRI_ALGOS[m[1]], bytes as Uint8Array<ArrayBuffer>))
    let bin = ''
    for (const b of digest) bin += String.fromCharCode(b)
    if (btoa(bin) === m[2]) return true
  }
  return false
}

/** 浏览器 / dev 预览的下载:fetch 流式读,连接超时 + 断流超时 + 字节上限(下载主机得给 CORS;真机走原生,不受此限)。 */
export function createFetchDownload(
  fetchFn: (url: string, init: { signal: AbortSignal }) => Promise<Response> = (url, init) => fetch(url, init),
  timeouts = { connectMs: 15_000, stallMs: 20_000 },
): MarketDownload {
  return async (url, { maxBytes, onProgress }) => {
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = (ms: number, reason: string): Promise<never> => new Promise((_, reject) => {
      clearTimeout(timer)
      timer = setTimeout(() => { reject(new Error(reason)); ac.abort() }, ms)
    })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const res = await Promise.race([fetchFn(url, { signal: ac.signal }), deadline(timeouts.connectMs, 'timeout')])
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || null
      if (total && total > maxBytes) throw new Error('too large')
      reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline(timeouts.stallMs, 'stalled')])
        if (done) break
        received += value.byteLength
        if (received > maxBytes) throw new Error('too large')
        chunks.push(value)
        onProgress(received, total)
      }
      const out = new Uint8Array(received)
      let off = 0
      for (const c of chunks) { out.set(c, off); off += c.byteLength }
      return out
    } catch (e) {
      reader?.cancel().catch(() => {})
      ac.abort()
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 原生封顶下载的接缝(Android:MarketDownloadPlugin.kt + CappedDownload.kt;装配在 capacitorPluginFs.ts)。 */
export interface NativeDownloadIo {
  /** 流式下进应用缓存目录:超过 maxBytes 当场中止并删掉半截文件;只认 https、不带应用的任何头 / cookie。
   *  失败时 reject 的 message 就是原因码(`too large` / `HTTP 404` / `timeout` / `stalled` / `insecure url` …)。 */
  download(o: { id: string; url: string; maxBytes: number }): Promise<{ name: string; size: number }>
  /** 订阅进度(total = -1:服务器没给长度);返回取消订阅。 */
  onProgress(cb: (p: { id: string; received: number; total: number }) => void): Promise<() => void>
  /** 读回缓存文件的完整字节。 */
  read(name: string): Promise<Uint8Array>
  /** 删掉缓存文件(读没读成都要调)。 */
  discard(name: string): Promise<void>
}

/** 真机的下载:不经 WebView 的 fetch(GitHub archive / codeload 不给 CORS 头),字节上限由原生层在**传输过程中**强制
 *  (此前是 Filesystem.downloadFile 整个下完再 stat —— 一个不封顶的响应能把手机存储写满)。临时文件必删。 */
export function createNativeDownload(io: NativeDownloadIo): MarketDownload {
  let seq = 0
  return async (url, { maxBytes, onProgress }) => {
    const id = `dl-${Date.now().toString(36)}-${++seq}`
    let unsubscribe: (() => void) | undefined
    let name: string | undefined
    try {
      unsubscribe = await io.onProgress((p) => { if (p.id === id) onProgress(p.received, p.total > 0 ? p.total : null) })
      const done = await io.download({ id, url, maxBytes })
      name = done.name
      if (done.size > maxBytes) throw new Error('too large')
      const bytes = await io.read(done.name)
      if (bytes.length > maxBytes) throw new Error('too large')
      return bytes
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      throw new Error(/timed? ?out/i.test(msg) ? 'timeout' : msg.slice(0, 160))
    } finally {
      try { unsubscribe?.() } catch { /* 订阅已失效 */ }
      if (name) await io.discard(name).catch(() => {})
    }
  }
}

export function createMobileMarket(deps: MobileMarketDeps): MobileMarket {
  const maxZip = deps.maxZipBytes ?? MOBILE_MAX_ZIP_BYTES
  const maxUnpacked = deps.maxUnpackedBytes ?? MOBILE_MAX_UNPACKED_BYTES
  const maxEntries = deps.maxEntries ?? MOBILE_MAX_ENTRIES
  const allowedUrl = (url: unknown): url is string => isAllowedDownloadUrl(url, deps.allowLoopbackHttp === true)
  const listeners = new Set<(ev: MarketInstallProgress) => void>()
  const emit = (ev: MarketInstallProgress): void => {
    for (const cb of listeners) { try { cb(ev) } catch { /* 一个订阅者炸了不连累别人 */ } }
  }
  const base = (): string => {
    const b = deps.cloudApiBase().replace(/\/+$/, '')
    if (!b) throw new Error(deps.t('mobilemarket.noCloud'))
    return b
  }
  const absIcon = <T extends { iconUrl?: unknown }>(apiBase: string, it: T): T => {
    if (typeof it?.iconUrl === 'string' && it.iconUrl.startsWith('/')) (it as { iconUrl: string }).iconUrl = `${cloudOrigin(apiBase)}${it.iconUrl}`
    return it
  }
  const getJson = async (url: string): Promise<unknown> => {
    const r = await deps.fetch(url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }

  /** 解析 + 下载 + 校验:返回第一个合格候选的字节。失败消息 = `host: 原因 · host: 原因`(同桌面 DownloadFailed)。 */
  const fetchPackage = async (
    id: string, info: { downloadUrl: string; source?: string; integrity?: unknown },
  ): Promise<Uint8Array> => {
    const mirror = (await deps.mirror?.()) || 'default'
    const candidates = info.source === 'github' ? downloadCandidates(info.downloadUrl, mirror) : [info.downloadUrl]
    const failed: string[] = []
    let lastSent = 0
    for (const [i, url] of candidates.entries()) {
      const host = hostOf(url)
      emit({ id, phase: 'download', attempt: i + 1, attempts: candidates.length, host, received: 0, total: null })
      try {
        // 每个候选(含镜像改写出来的)都过地址闸,再交给下载实现。
        if (!allowedUrl(url)) throw new Error('insecure url')
        const bytes = await deps.download(url, {
          maxBytes: maxZip,
          onProgress: (received, total) => {
            const now = Date.now()
            if (now - lastSent < 120) return // 字节进度限流(同桌面)
            lastSent = now
            emit({ id, phase: 'download', attempt: i + 1, attempts: candidates.length, host, received, total })
          },
        })
        if (bytes.length > maxZip) throw new Error('too large')
        // 代理站被限流时常回 200 的 HTML:不认魔数就会拿它去解压、把能用的下一个候选错过。
        if (!hasMagic(bytes, ZIP_MAGIC)) throw new Error('not a zip')
        if (typeof info.integrity === 'string' && info.integrity && !(await matchesIntegrity(bytes, info.integrity))) throw new Error('integrity mismatch')
        return bytes
      } catch (e) {
        failed.push(`${host}: ${(e as Error)?.message || String(e)}`)
      }
    }
    throw new Error(failed.join(' · '))
  }

  return {
    marketTypes: MOBILE_MARKET_TYPES,

    async marketList(type) {
      const b = base()
      const q = type ? `?type=${encodeURIComponent(type)}` : ''
      const data = (await getJson(`${b}/market/items${q}`)) as { items?: Array<Record<string, unknown>> }
      for (const it of data?.items || []) absIcon(b, it)
      return { ...data, items: data?.items || [] }
    },

    async marketDetail(id) {
      const b = base()
      return absIcon(b, (await getJson(`${b}/market/items/${encodeURIComponent(id)}`)) as Record<string, unknown>)
    },

    onMarketInstallProgress(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },

    async marketInstall(id) {
      emit({ id, phase: 'resolve' })
      const b = base()
      // 错误消息前缀 `resolve: ` 是 marketService.unwrapIpcError 认的机器码(卡在 Forsion 服务器这一步 → 不附 GitHub 网络指引)。
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 30_000)
      let res: Response
      try {
        res = await deps.fetch(`${b}/market/items/${encodeURIComponent(id)}/install`, { signal: ac.signal })
      } catch (e) {
        throw new Error(`resolve: ${(e as Error)?.name === 'AbortError' ? 'timeout' : (e as Error)?.message || String(e)}`)
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new Error(`resolve: HTTP ${res.status}`)
      const info = (await res.json().catch(() => null)) as { type?: unknown; installSlug?: unknown; downloadUrl?: unknown; source?: string; integrity?: unknown } | null
      if (!info || typeof info.type !== 'string' || !MARKET_SUBDIR[info.type] || !isSafeSlug(info.installSlug)
        || !allowedUrl(info.downloadUrl)) {
        throw new Error('resolve: invalid target')
      }
      const slug = info.installSlug
      // 非插件家族(技能 / Agent / 主题 / Space):不用下载就知道手机装不了。插件家族要下载后按 manifest 纠偏才知道。
      if (info.type !== 'plugin' && info.type !== 'amadeus-plugin') throw new MarketUserError(deps.t('mobilemarket.desktopOnlyType'))

      const bytes = await fetchPackage(id, { downloadUrl: info.downloadUrl, source: info.source, integrity: info.integrity })
      emit({ id, phase: 'install' })

      const tooLarge = (): MarketUserError => new MarketUserError(deps.t('mobilemarket.tooLarge', { mb: String(Math.round(maxUnpacked / 1024 / 1024)) }))
      // 条目数在解析**之前**先数一遍:jszip 解析时为每个条目建对象,条目数本身就能撑爆内存 —— 超限的包不交给它解析。
      if (countCentralHeaders(bytes, maxEntries) > maxEntries) throw new MarketUserError(deps.t('mobilemarket.tooManyFiles', { n: String(maxEntries) }))
      let zip: JSZip
      try {
        zip = await JSZip.loadAsync(bytes)
      } catch {
        throw new MarketUserError(deps.t('mobilemarket.badArchive'))
      }
      const entries = Object.values(zip.files).filter((f) => !f.dir)
      const fileNames = entries.map((f) => f.name)
      if (fileNames.length > maxEntries) throw new MarketUserError(deps.t('mobilemarket.tooManyFiles', { n: String(maxEntries) }))
      const effType = detectMarketTypeFromNames(fileNames, info.type)
      if (!MOBILE_MARKET_TYPES.includes(effType)) throw new MarketUserError(deps.t('mobilemarket.desktopOnlyType'))
      // 计划按包里的**原名**判(planZipFiles 看 jszip 的 unsafeOriginalName):`../x`、`/x` 被 jszip 规整成 `x` 之后
      // 就认不出来了。穿越 / 绝对路径 → 整包拒,与桌面同一个函数、同口径。
      let plan: ReturnType<typeof planZipFiles>
      try {
        plan = planZipFiles(entries, MARKET_MANIFEST[effType] || [])
      } catch (e) {
        if (e instanceof ZipPlanError && e.code === 'traversal') throw new MarketUserError(deps.t('mobilemarket.unsafePath', { path: e.entry || '' }))
        if (e instanceof ZipPlanError) throw new MarketUserError(deps.t('mobilemarket.emptyArchive'))
        throw e
      }
      // 解进内存(容量闸见 zipUnpack.ts:先看声明大小,再按实际字节流式封顶),再判 manifest —— 一切拒收都发生在动磁盘之前。
      let files: Array<{ rel: string; data: Uint8Array }>
      try {
        files = await unpackCapped(zip, plan, maxUnpacked)
      } catch (e) {
        if (e instanceof UnpackLimitError) throw tooLarge()
        throw new MarketUserError(deps.t('mobilemarket.badArchive'))
      }
      const manifestFile = files.find((f) => f.rel === 'manifest.json')
      let manifest: Record<string, unknown> | null = null
      try {
        const parsed: unknown = manifestFile ? JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(manifestFile.data)) : null
        manifest = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
      } catch { /* 下面统一报 manifest 无效 */ }
      if (!manifest || !manifestFile) throw new MarketUserError(deps.t('mobilemarket.badManifest'))
      if (manifest.isDesktopOnly === true) throw new MarketUserError(deps.t('mobilemarket.desktopOnlyPlugin'))
      const pluginId = effectivePluginId(slug, manifest.id)
      if (!pluginId) throw new MarketUserError(deps.t('mobilemarket.badManifest'))
      const reserved = new Set([...(await deps.reservedIds?.() ?? [])])
      if (reserved.has(pluginId) || reserved.has(slug)) throw new MarketUserError(deps.t('mobilemarket.builtin'))
      // 入口文件必须在包里:没有它 listPlugins 会整个跳过这个插件 —— 「装成功了却哪儿都找不到」,还白白顶掉能用的旧版。
      const mainRel = mainRelOf(manifest.main)
      if (!mainRel || !files.some((f) => f.rel === mainRel)) {
        throw new MarketUserError(deps.t('mobilemarket.noMain', { path: typeof manifest.main === 'string' && manifest.main ? manifest.main : 'main.js' }))
      }

      // 落盘(整段持锁,不与清点 / 卸载 / 另一次安装交错)。正在用的那一版在新版**完整写好之前**一个字节都不动:
      //   1. 新版写进暂存目录(manifest 最后写);中途失败 → 删暂存,旧版原样;
      //   2. 切换:旧 → 备份、暂存 → 正式、删备份。Android 的 rename 不覆盖已存在的目标,所以旧版必须先挪开。
      //      改名失败 / 进程被杀 → recoverPluginDirs 把旧版挪回去(这里当场做一次,下次清点 / 安装时还会再做)。
      const dir = `${PLUGINS_DIR}/${slug}`
      const staging = stagingDirOf(slug)
      const backup = backupDirOf(slug)
      await withPluginDirLock(deps.fs, async () => {
        await recoverPluginDirs(deps.fs)
        await deps.fs.removeDir(staging)
        try {
          for (const f of files) if (f !== manifestFile) await deps.fs.writeBytes(`${staging}/${f.rel}`, f.data)
          await deps.fs.writeBytes(`${staging}/manifest.json`, manifestFile.data)
        } catch (e) {
          await deps.fs.removeDir(staging).catch(() => {})
          throw e
        }
        try {
          if (await deps.fs.stat(dir)) await deps.fs.rename(dir, backup)
          await deps.fs.rename(staging, dir)
        } catch (e) {
          await recoverPluginDirs(deps.fs).catch(() => {})
          throw e
        }
        // 新版已就位。备份删不掉不算安装失败:recoverPluginDirs 看到「备份在、正式在、暂存不在」会补删。
        await deps.fs.removeDir(backup).catch(() => {})
      })
      return { ok: true, path: dir, files: files.length, type: effType, slug, id: pluginId }
    },

    // 形状同桌面 market:installed:六类都给键,手机只有 amadeus-plugin 有内容(每个已装目录 + manifest 版本)。
    async marketInstalled() {
      const out: Record<string, Array<{ slug: string; version: string | null }>> = { skill: [], agent: [], plugin: [], space: [], theme: [], 'amadeus-plugin': [] }
      out['amadeus-plugin'] = await withPluginDirLock(deps.fs, async () => {
        await recoverPluginDirs(deps.fs)
        return Promise.all((await pluginDirNames(deps.fs)).map(async (slug) => ({
          slug, version: normVer((await readManifest(deps.fs, `${PLUGINS_DIR}/${slug}`))?.version),
        })))
      })
      return out
    },

    // 同桌面 market:uninstall:只删白名单 type 下的 kebab slug 目录;不存在 = 报错(不静默成功)。
    async marketUninstall(type, slug) {
      if (!MOBILE_MARKET_TYPES.includes(type) || !isSafeSlug(slug)) throw new MarketUserError(deps.t('mobilemarket.invalidTarget'))
      const dir = `${PLUGINS_DIR}/${slug}`
      await withPluginDirLock(deps.fs, async () => {
        await recoverPluginDirs(deps.fs) // 先恢复:否则备份里的旧版会在下次启动时又被挪回来
        const st = await deps.fs.stat(dir)
        if (!st || st.type !== 'directory') throw new MarketUserError(deps.t('mobilemarket.notInstalled'))
        await tombstoneExtensions(deps.fs, dir) // 它声明过的文件后缀留下来(同 pluginHost.uninstallPlugin)
        await deps.fs.removeDir(dir)
      })
      return { ok: true, path: dir, type }
    },
  }
}
