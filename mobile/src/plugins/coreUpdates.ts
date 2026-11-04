/**
 * Android 核心插件(随 App 打包的日历 / Extend)的 npm 更新通道(2026-11-03,方案页 docs/ToBeImproved/手机核心插件更新方案_2026-11-03)。
 * 规则照桌面 electron/builtinUpdates.ts + builtinPlugins.ts:后台问 npm 有没有更新的版本,有就下载、校验,放进暂存区,
 * **下次打开 App** 才换上 —— 这一次运行里插件不会突然变成另一个版本。
 *
 *   plugins/<id>/                  ← 换上之后的下载版(与市场安装同一个根;.complete 换完才写);宿主只认这次启动验过的那份
 *   plugins/.pending-<id>/         ← 下好、校验过,等下次启动;里面的 .complete 写着版本,写完才有(没有 = 半截,丢掉)
 *   plugins/.staging-core-<id>/    ← 正在写的暂存(点开头,清点看不见;recoverPluginDirs 会顺手清掉残留)
 *   plugins/.core-boot-<id>/version ← 启动标记 `<版本> <次数>`:用下载版启动时记一次、setup 成功后删;连续两次没确认 → 退回随包版
 *   plugins/.core-bad-<id>         ← 被启动标记判坏的版本号:不再下载这一版(更高的版本照常)
 *
 * 写暂存区前的闸(缺一不写):registry 只用官方 + npmmirror(debug 包另可回环,给台架);tarball 地址自己拼;
 * 字节对上 packument 的 sha512 integrity;解 gzip / tar 封顶(条目数、解压总量);条目路径不越界、不重名;
 * 包内 manifest 的 id = 随包那份、version = latest;gatePluginManifest;入口文件在包里;带 verify 的包(Extend)过 verify。
 * 只升不降:比「随包 / 已换上 / 已暂存」里最高的那份新才下;预发布不装。
 *
 * 本模块不 import Capacitor(fs / 下载 / fetch 都注入),单测见 mobile/scripts/plugin-host.test.cjs。
 */
import pako from 'pako'
import { cmpVersion, gatePluginManifest } from '../../../desktop/shared/amadeus/ipc'
import { createCorePluginUpdater, type CorePluginUpdate } from '../../../desktop/shared/corePlugins'
import { GZIP_MAGIC, hasMagic, safeEntryPath } from '../../../desktop/shared/marketPackage'
import { stripTopDir, untar } from '../../../desktop/shared/minitar'
import { RELEASE_VERSION, resolveLatest, type RegistryFetch } from '../../../desktop/shared/npmRegistry'
import { matchesIntegrity, MOBILE_MAX_ENTRIES, MOBILE_MAX_UNPACKED_BYTES, MOBILE_MAX_ZIP_BYTES, type MarketDownload } from './mobileMarket'
import { PLUGINS_DIR, commitStagedDir, mainRelOf, recoverPluginDirs, stagingDirOf } from './pluginHost'
import { readTextOr, utf8Decode, withPluginDirLock, writeText, type PluginFs } from './pluginFs'

/** 一个随 App 打包的核心插件。manifest = 随包那份(版本 / id 的锚)。 */
export interface CoreBundle {
  pkg: string
  manifest: { id: string; version: string }
  /** 额外的闸(Extend:签名 + mobileHostApi)。抛错 = 这份不能用。拿到的是包内全部文件(相对包根)。 */
  verify?: (files: Map<string, Uint8Array>) => Promise<void> | void
}

export const pendingDirOf = (id: string): string => `${PLUGINS_DIR}/.pending-${id}`
const downloadStagingOf = (id: string): string => `${PLUGINS_DIR}/.staging-core-${id}`
// 标记做成目录(PluginFs 只会删目录);点开头,清点看不见。
const bootMarkerOf = (id: string): string => `${PLUGINS_DIR}/.core-boot-${id}`
const bootVersionOf = (id: string): string => `${bootMarkerOf(id)}/version`
const badMarkerOf = (id: string): string => `${PLUGINS_DIR}/.core-bad-${id}`
const COMPLETE = '.complete'

/** 一个插件目录里的全部文件(相对目录;递归)。 */
async function readTree(fs: PluginFs, dir: string, rel = ''): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  for (const e of await fs.list(rel ? `${dir}/${rel}` : dir)) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.type === 'directory') for (const [k, v] of await readTree(fs, dir, p)) out.set(k, v)
    else out.set(p, await fs.readBytes(`${dir}/${p}`))
  }
  return out
}

/** 读一个文件:不存在 → null;在却读不出来(I/O)→ 'unreadable'。读失败 ≠ 没有。 */
async function readOpt(fs: PluginFs, path: string): Promise<Uint8Array | null | 'unreadable'> {
  try { return await fs.readBytes(path) } catch { return (await fs.stat(path).catch(() => 'unknown')) ? 'unreadable' : null }
}

type Copy = { kind: 'missing' | 'unreadable' | 'invalid' } | { kind: 'ok'; version: string; manifest: Record<string, unknown> }

/**
 * 看一份副本(暂存区或已换上的那份):目录不在 → missing;读不出来 → unreadable(不知道,不能据此删,这次也不用它);
 * 内容不对 → invalid;能用 → ok。能用 = `.complete` 写着 manifest 的版本(整份写完 / 换完才写)、id 对、正式版、带 verify 的过 verify。
 */
async function inspect(fs: PluginFs, dir: string, bundle: CoreBundle): Promise<Copy> {
  if (!(await fs.stat(dir))) return { kind: 'missing' }
  const [rawManifest, rawComplete] = [await readOpt(fs, `${dir}/manifest.json`), await readOpt(fs, `${dir}/${COMPLETE}`)]
  if (rawManifest === 'unreadable' || rawComplete === 'unreadable') return { kind: 'unreadable' }
  let m: Record<string, unknown> | null = null
  try { m = rawManifest ? (JSON.parse(utf8Decode(rawManifest)) as Record<string, unknown>) : null } catch { /* invalid */ }
  const version = typeof m?.version === 'string' ? m.version : ''
  if (!m || m.id !== bundle.manifest.id || !RELEASE_VERSION.test(version) || !rawComplete || utf8Decode(rawComplete).trim() !== version) return { kind: 'invalid' }
  if (bundle.verify) {
    let files: Map<string, Uint8Array>
    try { files = await readTree(fs, dir) } catch { return { kind: 'unreadable' } }
    files.delete(COMPLETE)
    try { await bundle.verify(files) } catch { return { kind: 'invalid' } }
  }
  return { kind: 'ok', version, manifest: m }
}

const versionOf = (c: Copy): string | null => (c.kind === 'ok' ? c.version : null)
const newer = (a: string | null | undefined, b: string): boolean => !!a && cmpVersion(a, b) > 0

/** 丢掉一个暂存区:先让 .complete 失效、再删 —— 删到一半被杀,剩下的半截也不会被当成完整版本换上。 */
async function discardPending(fs: PluginFs, id: string): Promise<void> {
  const dir = pendingDirOf(id)
  if (!(await fs.stat(dir))) return
  await writeText(fs, `${dir}/${COMPLETE}`, '')
  await fs.removeDir(dir)
}

/** 启动标记:`<版本> <连续没确认的启动次数>`。 */
const parseBoot = (text: string | undefined): { version: string; strikes: number } => {
  const [version = '', n] = (text ?? '').trim().split(/\s+/)
  return { version, strikes: version ? Number(n) || 1 : 0 }
}
/** 连续这么多次用下载版启动都没确认(崩溃 / setup 失败)才判坏:用户偶尔一打开就关掉,不该把好好的版本作废。 */
const MAX_UNCONFIRMED_BOOTS = 2

/**
 * 启动时、插件第一次清点之前跑一次(installMobilePlugins 让宿主的每个方法先等它):
 * 判启动标记 → 把暂存区换进 plugins/<id> → 清掉追不上随包版 / 坏掉的副本 → 给这次要用的下载版写启动标记。
 * 返回这次启动验过、可以用的下载版 `id → 版本`:宿主(withBundled*)只认这里面的,盘上别的副本一律不用。
 * 逐包吞错:出什么事都只是退回随包版。
 */
export async function prepareCoreUpdates(fs: PluginFs, bundles: readonly CoreBundle[], appVersion: string | null, log: (m: string) => void = console.warn): Promise<Map<string, string>> {
  const using = new Map<string, string>()
  await withPluginDirLock(fs, async () => {
    await recoverPluginDirs(fs).catch(() => {})
    for (const bundle of bundles) {
      const { id, version: bundled } = bundle.manifest
      const active = `${PLUGINS_DIR}/${id}`
      try {
        // 1. 连续几次用下载版启动、插件都没起来(崩了 / setup 抛错):这一版作废,退回随包版,之后不再下载这一版。
        const boot = parseBoot(await readTextOr(fs, bootVersionOf(id)))
        if (boot.strikes >= MAX_UNCONFIRMED_BOOTS) {
          await writeText(fs, badMarkerOf(id), boot.version)
          if (versionOf(await inspect(fs, active, bundle)) === boot.version) await fs.removeDir(active)
          await fs.removeDir(bootMarkerOf(id))
          log(`[core-updates] ${id}@${boot.version} 连续 ${boot.strikes} 次启动没起来,退回随包版 ${bundled}`)
        }
        const bad = (await readTextOr(fs, badMarkerOf(id)))?.trim()
        // 2. 暂存区能用、比随包和已换上的都新、不是判坏的那版 → 换上。顺序:暂存的 .complete 先失效 → 换位 → 换完才给正式目录写 .complete
        //    (换位在非原子分支上是逐个复制,中途被杀留下的半截正式目录没有 .complete,下面第 3 步当坏副本删掉)。其余一律丢掉。
        const pending = await inspect(fs, pendingDirOf(id), bundle)
        if (pending.kind === 'ok') {
          const current = await inspect(fs, active, bundle)
          const v = pending.version
          if (v !== bad && newer(v, bundled) && current.kind !== 'unreadable' && (current.kind !== 'ok' || newer(v, current.version))) {
            await writeText(fs, `${pendingDirOf(id)}/${COMPLETE}`, '')
            await fs.removeDir(stagingDirOf(id))
            await fs.rename(pendingDirOf(id), stagingDirOf(id))
            await commitStagedDir(fs, id)
            await writeText(fs, `${active}/${COMPLETE}`, v)
            log(`[core-updates] ${id} 换上 ${v}`)
          }
        }
        if (pending.kind !== 'missing' && pending.kind !== 'unreadable') await discardPending(fs, id)
        // 3. 已换上的那份:坏了 / 追不上随包版了(App 升级过)→ 删掉;读不出来 → 不删,这次也不用。
        const current = await inspect(fs, active, bundle)
        if (current.kind === 'invalid' || (current.kind === 'ok' && !newer(current.version, bundled))) await fs.removeDir(active)
        // 4. 这次要用下载版(门禁放行的):记一次「没确认的启动」,setup 成功后 confirmCoreBoot 删掉。
        else if (current.kind === 'ok' && !gatePluginManifest(current.manifest, appVersion)) {
          const strikes = boot.version === current.version && boot.strikes < MAX_UNCONFIRMED_BOOTS ? boot.strikes : 0
          await writeText(fs, bootVersionOf(id), `${current.version} ${strikes + 1}`)
          using.set(id, current.version)
        }
        if (!using.has(id) && boot.version) await fs.removeDir(bootMarkerOf(id)) // 这次没用下载版:旧标记不再作数
      } catch (e) {
        log(`[core-updates] ${id} 启动换版失败(用随包版):${(e as Error)?.message || e}`)
      }
    }
  })
  return using
}

/** 插件 setup 成功(或被用户关着 / 这次没挑下载版)→ 删启动标记。只删写着这一版的那个。 */
export async function confirmCoreBoot(fs: PluginFs, id: string, version: string): Promise<void> {
  if (parseBoot(await readTextOr(fs, bootVersionOf(id))).version === version) await fs.removeDir(bootMarkerOf(id))
}

/** 解 gzip,解压总量封顶(防 gzip 炸弹;字节已对上 integrity,这道是防一个被盗的 npm 账号)。 */
export function gunzipCapped(bytes: Uint8Array, max: number): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const inflate = new pako.Inflate()
  inflate.onData = (chunk: Uint8Array) => {
    total += chunk.length
    if (total > max) throw new Error('unpacked package too large')
    chunks.push(chunk)
  }
  inflate.push(bytes, true)
  if (inflate.err) throw new Error(`gzip: ${inflate.msg || inflate.err}`)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

/** npm tarball → 包内文件(相对包根)。路径不安全 / 重名 / 太多 → 抛错。 */
export function unpackTarball(tgz: Uint8Array): Map<string, Uint8Array> {
  if (!hasMagic(tgz, GZIP_MAGIC)) throw new Error('not a gzip')
  const entries = stripTopDir(untar(gunzipCapped(tgz, MOBILE_MAX_UNPACKED_BYTES)))
  if (entries.length > MOBILE_MAX_ENTRIES) throw new Error(`too many entries (${entries.length})`)
  const files = new Map<string, Uint8Array>()
  for (const e of entries) {
    const rel = safeEntryPath(e.path, '')
    if (!rel || rel !== e.path || rel === COMPLETE || files.has(rel)) throw new Error(`unsafe path in package: ${e.path}`)
    files.set(rel, e.data)
  }
  return files
}

export interface CoreUpdatesDeps {
  fs: PluginFs
  bundles: readonly CoreBundle[]
  appVersion: () => string | null
  registries: () => Promise<string[]>
  /** packument(WebView fetch:两个 registry 都给 CORS)。 */
  fetch: RegistryFetch
  /** tarball(真机原生封顶下载)。 */
  download: MarketDownload
  log?: (m: string) => void
  onStatus?: (status: CorePluginUpdate) => void
}

/** 本次运行里判过「宿主不兼容」的版本(连同当时的宿主版本):别每次检查都重下一遍(同桌面)。 */
const incompatible = new Set<string>()

/** 查一遍各核心插件;有更新的下载进暂存区。返回暂存了的 `id@version`。逐包吞错。 */
export async function checkCoreUpdates(o: CoreUpdatesDeps): Promise<string[]> {
  const log = o.log ?? ((m: string) => console.log(m))
  const staged: string[] = []
  const registries = await o.registries()
  for (const bundle of o.bundles) {
    const { id, version: bundled } = bundle.manifest
    let status: CorePluginUpdate = { id, packageName: bundle.pkg, phase: 'checking' }
    const report = (patch: Partial<CorePluginUpdate>): void => { status = { ...status, ...patch }; o.onStatus?.({ ...status }) }
    report({})
    try {
      const { installed, pending } = await withPluginDirLock(o.fs, async () => {
        const active = versionOf(await inspect(o.fs, `${PLUGINS_DIR}/${id}`, bundle))
        return { installed: newer(active, bundled) ? active! : bundled, pending: versionOf(await inspect(o.fs, pendingDirOf(id), bundle)) }
      })
      report({ installedVersion: installed, pendingVersion: pending ?? undefined })
      const have = pending && newer(pending, installed) ? pending : installed
      const latest = await resolveLatest(bundle.pkg, registries, o.fetch)
      if (!latest) throw new Error('no latest dist-tag')
      report({ latestVersion: latest.version })
      if (!RELEASE_VERSION.test(latest.version)) { report({ phase: 'incompatible' }); continue }
      if (!newer(latest.version, have)) { report({ phase: pending && newer(pending, installed) ? 'staged' : 'current' }); continue }
      const bad = (await readTextOr(o.fs, badMarkerOf(id)))?.trim()
      if (bad === latest.version || incompatible.has(`${bundle.pkg}@${latest.version}@${o.appVersion()}`)) { report({ phase: 'incompatible' }); continue }

      report({ phase: 'downloading' })
      const failed: string[] = []
      let files: Map<string, Uint8Array> | null = null
      for (const url of latest.tarballs) {
        try {
          const tgz = await o.download(url, { maxBytes: MOBILE_MAX_ZIP_BYTES, onProgress: () => {} })
          if (!(await matchesIntegrity(tgz, latest.integrity))) throw new Error('integrity mismatch')
          files = unpackTarball(tgz)
          break
        } catch (e) { failed.push(`${new URL(url).host}: ${(e as Error)?.message || e}`) }
      }
      if (!files) throw new Error(failed.join(' · '))
      const raw = files.get('manifest.json')
      const manifest = raw ? (JSON.parse(utf8Decode(raw)) as Record<string, unknown>) : null
      if (manifest?.id !== id || manifest.version !== latest.version) throw new Error(`manifest ${String(manifest?.id)}@${String(manifest?.version)} is not ${id}@${latest.version}`)
      const gate = gatePluginManifest(manifest, o.appVersion())
      if (gate) {
        incompatible.add(`${bundle.pkg}@${latest.version}@${o.appVersion()}`)
        report({ phase: 'incompatible' })
        log(`[core-updates] ${id}@${latest.version} 需要${gate === 'minApp' ? `宿主 ≥ ${String(manifest.minAppVersion)}` : '另一版插件 API'},等 App 升级`)
        continue
      }
      const main = mainRelOf(manifest.main)
      if (!main || !files.has(main)) throw new Error(`entry ${String(manifest.main ?? 'main.js')} missing`)
      await bundle.verify?.(new Map(files))

      // 写暂存:先写进 .staging-core-<id>(manifest 最后写),再换成 .pending-<id>,最后写 .complete —— 没有它的暂存区启动时一律丢掉
      // (改名在浏览器台架 / 原生兜底分支上是逐个复制,不原子)。整段持目录锁,不与市场安装 / 启动换版交错。
      await withPluginDirLock(o.fs, async () => {
        const staging = downloadStagingOf(id)
        const pendingDir = pendingDirOf(id)
        await o.fs.removeDir(staging)
        try {
          for (const [rel, data] of files!) if (rel !== 'manifest.json') await o.fs.writeBytes(`${staging}/${rel}`, data)
          await o.fs.writeBytes(`${staging}/manifest.json`, raw!)
          await discardPending(o.fs, id)
          await o.fs.rename(staging, pendingDir)
          await writeText(o.fs, `${pendingDir}/${COMPLETE}`, latest.version)
        } finally {
          await o.fs.removeDir(staging).catch(() => {})
        }
      })
      staged.push(`${id}@${latest.version}`)
      report({ phase: 'staged', pendingVersion: latest.version })
      log(`[core-updates] ${id} ${have} → ${latest.version} 已下载,下次打开生效`)
    } catch (e) {
      report({ phase: 'error', error: (e as Error)?.message || String(e) })
      log(`[core-updates] ${bundle.pkg} 检查更新失败(忽略,下次再试):${(e as Error)?.message || e}`)
    }
  }
  return staged
}

/** 两次自动检查至少隔这么久(启动后 60 秒查一次;回到前台时到了这个间隔再查)。手动检查不受限。 */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const LAST_CHECK_KEY = 'forsion.mobile.coreUpdates.lastCheck'

/** 状态机(与桌面同一份 createCorePluginUpdater)+ 定时。enabled=false(debug / 浏览器台架)→ 各项显示「开发版」,不查。 */
export function createCoreUpdater(deps: CoreUpdatesDeps & { enabled: boolean }) {
  const listeners = new Set<(s: ReturnType<typeof updater.snapshot>) => void>()
  const updater = createCorePluginUpdater({
    items: deps.bundles.map((b) => ({ id: b.manifest.id, packageName: b.pkg, phase: 'idle' as const })),
    enabled: deps.enabled,
    run: (onStatus) => checkCoreUpdates({ ...deps, onStatus }),
    broadcast: (s) => { for (const cb of listeners) try { cb(s) } catch { /* 订阅方自己的错 */ } },
  })
  const lastCheck = (): number => { try { return Number(localStorage.getItem(LAST_CHECK_KEY)) || 0 } catch { return 0 } }
  const check = (): Promise<void> => {
    try { localStorage.setItem(LAST_CHECK_KEY, String(Date.now())) } catch { /* 记不住就当没查过 */ }
    return updater.check()
  }
  const checkIfDue = (): void => { if (deps.enabled && Date.now() - lastCheck() >= CHECK_INTERVAL_MS) void check() }
  return {
    snapshot: updater.snapshot,
    check,
    subscribe(cb: (s: ReturnType<typeof updater.snapshot>) => void): () => void { listeners.add(cb); return () => { listeners.delete(cb) } },
    /** 启动后 60 秒查一次;之后回到前台、距上次 ≥ 24 小时再查。 */
    schedule(): void {
      if (!deps.enabled) return
      setTimeout(checkIfDue, 60_000)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkIfDue() })
    },
  }
}
