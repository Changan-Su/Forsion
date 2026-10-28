/**
 * Tangu 引擎的 npm 热更新通道(2026-10-12):在跑的桌面后台问 npm 上的 `@forsion/tangu-agent` 有没有更新的版本,
 * 有就下载、核对,按版本号并排放进 `<家目录>/engine/<版本>/`。**下次拉起引擎**时由安装包里的启动器
 * (tangu-agent/src/boot/launch.ts)换上;终端里的 `tangu` 命令走同一个启动器。
 *
 * 与内置插件包的更新(builtinUpdates.ts)不同的三点:
 *  · 不在原地替换,也没有暂存区:版本目录各放各的,在跑的引擎拿着的文件不会被换掉(Windows 上也换不掉);
 *  · 「合不合格」不在这里判,判定只有引擎那一份实现(dist/boot/overlay.js:签名、依赖清单、建表文件、壳版本),
 *    更新器落盘前、启动器每次拉起前跑的是同一个函数;
 *  · 只把签名表里列出的文件写进磁盘 —— tarball 里多带的东西一个都不落地。
 *
 * registry / tarball 地址 / sha512 的口径与 builtinUpdates.ts 相同,直接复用。
 * 查的不是 latest,而是本安装包线的 dist-tag `desktop-<桌面版本>`(desktop/shared/engineLine.mjs,2026-10-28):
 * latest 上可能是别的线的引擎,号更高、建表文件碰巧一样时 checkOverlay 也会放行,新壳就跑上了旧线的引擎代码。
 * 模块顶层不 import electron(vitest 直测)。
 */
import type { CorePluginUpdate } from '../shared/corePlugins'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { engineLineTag } from '../shared/engineLine.mjs'
import { resolveLatest, safeJoin, type RegistryFetch } from './builtinUpdates'
import { downloadZip, GZIP_MAGIC } from './marketInstall'
import { stripTopDir, untar } from './minitar'

export const ENGINE_UPDATE_ID = 'tangu-engine'
export const ENGINE_PACKAGE = '@forsion/tangu-agent'
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/
const MAX_ENTRIES = 5000
const MAX_UNPACK = 200 * 1024 * 1024

/** 安装包那份引擎的 dist/boot/overlay.js 导出的东西(签名见 tangu-agent/src/boot/overlay.ts)。 */
export interface EngineOverlayApi {
  checkOverlay(dir: string, bundledRoot: string): { ok: true; version: string } | { ok: false; code: string; reason: string }
  selectOverlay(engineRoot: string, bundledRoot: string, opts?: { onReject?: (version: string, code: string, reason: string) => void }): { version: string; dir: string } | null
  readBad(engineRoot: string): Record<string, string>
  markBad(engineRoot: string, version: string, reason: string): void
  cmpVersion(a: string, b: string): number
}

/** 从安装包那份引擎里取挑选 / 核对的实现;没有(引擎 dist 还是没带启动器的旧版)返回 null,调用方就当这条通道不存在。 */
export async function loadEngineOverlayApi(bundledRoot: string): Promise<EngineOverlayApi | null> {
  try {
    const m = (await import(pathToFileURL(path.join(bundledRoot, 'dist', 'boot', 'overlay.js')).href)) as Partial<EngineOverlayApi>
    return typeof m.checkOverlay === 'function' && typeof m.selectOverlay === 'function' ? (m as EngineOverlayApi) : null
  } catch {
    return null
  }
}

export const engineOverlayRoot = (forsionHome: string): string => path.join(forsionHome, 'engine')

async function bundledVersion(bundledRoot: string): Promise<string> {
  return String(JSON.parse(await fs.readFile(path.join(bundledRoot, 'package.json'), 'utf8')).version ?? '')
}

export interface EngineUpdateOpts {
  engineRoot: string
  /** 安装包里的引擎包根(resources/tangu-server)。 */
  bundledRoot: string
  api: EngineOverlayApi
  /** 这份安装包的桌面版本(app.getVersion()),决定查哪条线的 dist-tag。 */
  desktopVersion: string
  registries: string[]
  fetch: RegistryFetch
  /** 正在跑的引擎是哪一版热更新(没在跑热更新的 = null);界面上「当前版本」显示它,而不是磁盘上最新的那份。 */
  runningVersion?: string | null
  log?: (m: string) => void
  onStatus?: (status: CorePluginUpdate) => void
}

/** 本进程里验过「这份安装包用不了」的版本:别每 6 小时重下一遍。跨进程不记,下次启动最多再下一次。 */
const incompatible = new Set<string>()

/** 查一遍;有更新的就下载落位。返回落位了的版本号,没有新落位返回 null。吞错,只进 log 与状态。 */
export async function checkEngineUpdate(o: EngineUpdateOpts): Promise<string | null> {
  const log = o.log ?? ((m: string) => console.log(m))
  let status: CorePluginUpdate = { id: ENGINE_UPDATE_ID, packageName: ENGINE_PACKAGE, phase: 'checking' }
  const report = (patch: Partial<CorePluginUpdate>): void => {
    status = { ...status, ...patch }
    o.onStatus?.({ ...status })
  }
  report({})
  try {
    const bundled = await bundledVersion(o.bundledRoot)
    const ready = o.api.selectOverlay(o.engineRoot, o.bundledRoot)?.version // 下次拉起引擎会用的那份
    const installed = o.runningVersion ?? bundled
    const have = ready ?? bundled
    report({ installedVersion: installed, pendingVersion: ready && ready !== installed ? ready : undefined })
    const settled = (): CorePluginUpdate['phase'] => (ready && ready !== installed ? 'staged' : 'current')
    const tag = engineLineTag(o.desktopVersion)
    const latest = await resolveLatest(ENGINE_PACKAGE, o.registries, o.fetch, tag)
    if (!latest) {
      log(`[engine-updates] npm 上还没有 ${tag}(没给这一版桌面发过热更新)`)
      report({ phase: settled() })
      return null
    }
    report({ latestVersion: latest.version })
    if (!RELEASE_VERSION.test(latest.version)) {
      log(`[engine-updates] latest=${latest.version} 不是正式版,跳过`)
      report({ phase: settled() })
      return null
    }
    if (o.api.cmpVersion(latest.version, have) <= 0) {
      report({ phase: settled() })
      return null
    }
    if (latest.version in o.api.readBad(o.engineRoot) || incompatible.has(latest.version)) {
      report({ phase: 'incompatible' })
      return null
    }

    report({ phase: 'downloading' })
    const tgz = await downloadZip(latest.tarballs, o.fetch, undefined, GZIP_MAGIC)
    if (`sha512-${createHash('sha512').update(tgz).digest('base64')}` !== latest.integrity) throw new Error('integrity mismatch')
    const entries = stripTopDir(untar(gunzipSync(tgz, { maxOutputLength: MAX_UNPACK })))
    if (entries.length > MAX_ENTRIES) throw new Error(`too many entries (${entries.length})`)
    const signature = entries.find((e) => e.path === 'SIGNATURE')
    if (!signature) throw new Error('package has no SIGNATURE')
    const signed = new Set(Object.keys((JSON.parse(signature.data.toString('utf8')) as { files?: Record<string, string> }).files ?? {}))

    const staging = path.join(o.engineRoot, `.staging-${process.pid}`)
    const dest = path.join(o.engineRoot, latest.version)
    await fs.rm(staging, { recursive: true, force: true })
    try {
      for (const e of entries) {
        if (e !== signature && !signed.has(e.path)) continue
        const file = safeJoin(staging, e.path)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, e.data)
      }
      const verdict = o.api.checkOverlay(staging, o.bundledRoot)
      if (verdict.ok && verdict.version !== latest.version) throw new Error(`package is ${verdict.version}, not ${latest.version}`)
      if (!verdict.ok) {
        // 签名 / 包名不对 = 不是我们发的字节,按出错报;其余几种 = 字节没问题,只是这份安装包用不了,等 Forsion 升级。
        if (verdict.code === 'signature' || verdict.code === 'package') throw new Error(`${verdict.code}: ${verdict.reason}`)
        incompatible.add(latest.version)
        report({ phase: 'incompatible' })
        log(`[engine-updates] ${latest.version} 这份安装包用不了(${verdict.code}):${verdict.reason}`)
        return null
      }
      // 同名目录只可能是一份不合格的残留(合格的话上面 have 就已经是它了):挪开再换,不原地递归删。
      const retired = `${staging}.old`
      await fs.rm(retired, { recursive: true, force: true })
      await fs.rename(dest, retired).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
      })
      await fs.rename(staging, dest)
      await fs.rm(retired, { recursive: true, force: true })
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
    report({ phase: 'staged', pendingVersion: latest.version })
    log(`[engine-updates] 引擎 ${have} → ${latest.version} 已下载,下次启动生效`)
    return latest.version
  } catch (e) {
    report({ phase: 'error', error: (e as Error)?.message || String(e) })
    log(`[engine-updates] 检查更新失败(忽略,下次再试):${(e as Error)?.message || e}`)
    return null
  }
}

/**
 * 启动时收拾 engine/ 目录:留版本号最高的两份合格新版,别的版本目录、更新器被杀留下的半成品都删掉;
 * bad.json 里不比自带版本新的记录也清掉(安装包升上去之后它们没用了)。吞错。
 *
 * 留两份而不是一份:终端里可能还开着一个跑上一版的 tangu,它之后才懒加载的模块还得在原地。
 * 一个终端会话跨过两次引擎更新还开着、又恰好这时才懒加载,这种情况不管。
 */
export async function cleanEngineOverlays(engineRoot: string, bundledRoot: string, api: EngineOverlayApi, log: (m: string) => void = () => {}): Promise<void> {
  try {
    const entries = await fs.readdir(engineRoot, { withFileTypes: true }).catch(() => [])
    const bad = api.readBad(engineRoot)
    const keep = new Set<string>()
    for (const name of entries.map((e) => e.name).filter((n) => RELEASE_VERSION.test(n)).sort((a, b) => api.cmpVersion(b, a))) {
      if (keep.size >= 2 || name in bad) continue
      const verdict = api.checkOverlay(path.join(engineRoot, name), bundledRoot)
      if (verdict.ok && verdict.version === name) keep.add(name)
      else log(`[engine-updates] 清掉 ${name}(${verdict.ok ? 'package' : verdict.code}):${verdict.ok ? `holds version ${verdict.version}` : verdict.reason}`)
    }
    for (const e of entries) {
      if (e.name === 'bad.json' || keep.has(e.name)) continue
      await fs.rm(path.join(engineRoot, e.name), { recursive: true, force: true }).catch(() => {})
    }
    const bundled = await bundledVersion(bundledRoot)
    const live = Object.fromEntries(Object.entries(bad).filter(([v]) => RELEASE_VERSION.test(v) && api.cmpVersion(v, bundled) > 0))
    if (Object.keys(live).length !== Object.keys(bad).length) {
      if (Object.keys(live).length) await fs.writeFile(path.join(engineRoot, 'bad.json'), JSON.stringify(live, null, 2) + '\n', 'utf8')
      else await fs.rm(path.join(engineRoot, 'bad.json'), { force: true })
    }
  } catch (e) {
    log(`[engine-updates] 收拾 engine 目录失败(忽略):${(e as Error)?.message || e}`)
  }
}

export interface EngineOverlayHandle {
  api: EngineOverlayApi
  bundledRoot: string
  /** `<家目录>/engine`。 */
  root: string
  /** 交给 BackendManager.setEngineOverlay 的两个动作。 */
  control: { active(): string | null; demote(version: string, reason: string): void }
}

/**
 * 第一次拉起引擎之前调一次:收拾 engine 目录,返回更新器与 BackendManager 要用的句柄。
 * 安装包里的引擎没带启动器(取不到判定实现)= null,这条通道在这份安装包上就不存在,引擎照常跑自带的。
 */
export async function setupEngineOverlay(o: {
  bundledRoot: string
  forsionHome: string
  log?: (m: string) => void
  loadApi?: (bundledRoot: string) => Promise<EngineOverlayApi | null>
}): Promise<EngineOverlayHandle | null> {
  const api = await (o.loadApi ?? loadEngineOverlayApi)(o.bundledRoot)
  if (!api) return null
  const root = engineOverlayRoot(o.forsionHome)
  await cleanEngineOverlays(root, o.bundledRoot, api, o.log)
  return {
    api,
    bundledRoot: o.bundledRoot,
    root,
    control: {
      active: () => api.selectOverlay(root, o.bundledRoot)?.version ?? null,
      demote: (version, reason) => api.markBad(root, version, reason),
    },
  }
}

/** 测试用:清掉进程内的「用不了」记录。 */
export function _resetEngineUpdatesForTest(): void {
  incompatible.clear()
}
